## Why this subtopic matters

You never talk to etcd directly from an application. Kubernetes does. But understanding how the store is shaped — how revisions work, what watches actually see, what leases enforce — turns a lot of apparent magic ("why does the informer always know what changed?", "why do node heartbeats scale to 5000 nodes?") into plain mechanics. And when etcd is the root cause of a Kubernetes problem, the error messages reference this vocabulary directly.

---

## The keyspace — flat but structured

etcd exposes a **flat binary keyspace**. Keys are byte strings, sorted lexically. There is no nesting, no directories — just convention.

Kubernetes uses a path-like convention under `/registry/`:

```
/registry/namespaces/default
/registry/pods/default/foo
/registry/pods/kube-system/kube-apiserver-cp1
/registry/services/specs/default/kubernetes
/registry/configmaps/kube-system/coredns
/registry/secrets/default/my-secret
/registry/events/default/foo.17a1b3c4d5e6f
/registry/leases/kube-system/kube-scheduler
/registry/apiregistration.k8s.io/apiservices/v1beta1.custom.example.com
/registry/customresourcedefinitions/myresources.example.com
```

The first segment after `/registry/` is the resource, then namespace (if namespaced), then name. The values are **gob/protobuf-encoded Go objects** — Pod specs, Service specs, etc.

You can peek at raw etcd content (usually as a debugging exercise):

```bash
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry --prefix --keys-only | head -20

# Value is binary-encoded; decode with auger (github.com/jpbetz/auger) or jq:
etcdctl get /registry/pods/default/foo --print-value-only | auger decode | yq .
```

Prefix scans are cheap — B+tree range scans. `kubectl get pods -n default` turns into an etcd range request on `/registry/pods/default/`.

### Why this keyspace shape matters in practice

- **Backing up a single namespace** is easy: `etcdctl get /registry --prefix=/registry/*/namespace-name/` — though in reality you'd use `kubectl get -n ns -o yaml` which goes through apiserver and handles encoding.
- **Large keys hurt**: A `ConfigMap` with 1 MiB of data is a 1 MiB value in etcd. A few thousand of them is notable DB size. Secrets are capped at 1 MiB for this reason.
- **Events flood etcd**: Every warning/info event is a write. Kubernetes TTLs them (1 hour default) and kube-apiserver periodically compacts, but in flaky clusters events dominate etcd traffic.

---

## Revisions — the cluster-wide monotonic clock

Every write — PUT, DELETE, transaction — increments a single global counter: the **revision**. It is cluster-wide (all members see the same revision number at the same point in time), monotonic (never goes backwards on a functioning cluster), and **int64**.

Every key has three version-related fields:

| Field             | What it means                                                           |
|-------------------|-------------------------------------------------------------------------|
| `create_revision` | The revision at which this key was created (in its current generation)  |
| `mod_revision`    | The revision of the last modification to this key                        |
| `version`         | The count of modifications since creation (resets to 0 on deletion)     |

Example:

```
t=0   PUT /foo=A      → revision=100, create=100, mod=100, version=1
t=1   PUT /foo=B      → revision=101, create=100, mod=101, version=2
t=2   DELETE /foo     → revision=102  (tombstone; /foo is gone)
t=3   PUT /foo=C      → revision=103, create=103, mod=103, version=1   (new generation)
```

The "generation" concept matters: a deleted-then-recreated key has a new `create_revision`. Version resets to 1.

Why revisions matter to Kubernetes:

- **`resourceVersion`** in every Kubernetes object's `metadata` is the etcd `mod_revision` of that key. This is how optimistic concurrency works: you send `resourceVersion: 12345` on update; apiserver passes this as a Txn guard to etcd; if someone else already changed the object (new revision), the Txn fails and you get a `Conflict` error.
- **Watches start from a revision**: an informer resuming from revision 12345 asks etcd "stream me every change from 12345 onwards." If that revision has been compacted, the watch fails, and the controller resyncs.

### Reading at an old revision

Until compaction reaches that revision, you can read old state:

```bash
etcdctl get /registry/pods/default/foo --rev=12345
```

This is how the MVCC part of MVCC-store manifests. It's also why etcd doesn't "shrink" on its own — the old values are still addressable.

---

## Watches — event-driven change streams

A watch is a **long-lived gRPC stream** from client to etcd that says: "tell me every change to this key range, starting at revision N." The stream delivers events:

```
Event { type: PUT,    kv: {key: /foo, value: B, mod_rev: 101, ...}, prev_kv: {...} }
Event { type: DELETE, kv: {key: /foo, mod_rev: 102}, prev_kv: {...} }
Event { type: PUT,    kv: {key: /foo, value: C, mod_rev: 103, ...} }
```

Key properties:

- **Ordered**: events for a given key arrive in revision order, always.
- **At-least-once**: the client may need to handle the same event twice on reconnect — idempotency required.
- **Range-scoped**: `--prefix=/registry/pods/` watches every pod change.
- **Historical resume**: `--rev=12345` starts from an arbitrary point; limited by compaction.

### The "compacted" error

If you try to resume a watch from a revision that has been compacted away, etcd responds:

```
{"compact_revision": 12345, "error": "mvcc: required revision has been compacted"}
```

The client must then list the current state fresh and start a new watch from the latest revision. Kubernetes informers do this automatically — you'll see log lines like `watch channel closed; starting resync`.

### Kubernetes informers rely on watches for everything

The "informer" pattern every controller uses is literally:

1. `list` the initial state (from apiserver, served from cache or etcd).
2. Open a `watch` from the `resourceVersion` of the list.
3. Apply each event to an in-memory cache.
4. Notify registered event handlers (Add, Update, Delete).
5. On disconnect, list again + watch again.

Every Deployment controller, Service controller, scheduler, kubelet — all informer-based. Scale: a big cluster might have thousands of simultaneous watches. etcd handles this as ~a few Raft-aware gRPC streams; apiserver aggregates them (one etcd watch per resource type, fanned out to many clients).

### Watching from `etcdctl`

```bash
etcdctl watch --prefix /registry/pods/
# (streams forever)
# PUT
# /registry/pods/default/foo
# <binary value>
# DELETE
# /registry/pods/default/foo
```

Useful for debugging:

```bash
etcdctl watch --prefix /registry/events/default/ | head -20
```

Shows you what events are being written, one per line.

---

## Leases — self-expiring key ownership

A **lease** is a TTL contract. You create a lease with a duration, then attach keys to it. If the lease is not kept alive, it expires, and **all attached keys are automatically deleted**.

Mechanics:

```bash
# Grant a 30-second lease
etcdctl lease grant 30
# lease <lease-id> granted with TTL(30s)

# Attach a key
etcdctl put --lease=<lease-id> /my/key some-value

# Keep alive (bidi stream; refreshes TTL)
etcdctl lease keep-alive <lease-id>

# Revoke (delete immediately)
etcdctl lease revoke <lease-id>

# List
etcdctl lease list
```

Leases are the substrate for **mutual exclusion** and **liveness detection**:

- If the leaseholder is alive, it renews; keys live.
- If the leaseholder dies, renewals stop; lease expires; keys vanish; followers notice the delete events.

### Kubernetes uses etcd leases indirectly

Important distinction:

- **etcd Lease** — native etcd feature above.
- **Kubernetes Lease** — a Kubernetes API object (`coordination.k8s.io/v1` Lease) stored in etcd like any other object, used by Kubernetes controllers for leader election and node heartbeats.

Kubernetes Leases are **not** etcd leases. They're regular Kubernetes objects with a `spec.holderIdentity`, `spec.leaseDurationSeconds`, `spec.renewTime`, and `spec.acquireTime`. Controllers update `renewTime` periodically; observers check whether it's stale.

Why the distinction matters: if etcd itself goes read-only (NOSPACE, quorum loss), Kubernetes Leases stop renewing and cluster coordination degrades. But the mechanism is Kubernetes-level, not etcd-level.

### Where you encounter Kubernetes Leases

```bash
kubectl get leases -A
# NAMESPACE         NAME                                       HOLDER                      AGE
# kube-system       kube-scheduler                             cp1_5a7b9c...               12d
# kube-system       kube-controller-manager                    cp2_f3e1a2...               12d
# kube-system       apiserver-*                                each apiserver's identity   12d
# kube-node-lease   cp1, cp2, cp3, worker-1, worker-2, ...     (one per node)              12d
```

Two big uses in Kubernetes:

#### 1. Leader election (scheduler, controller-manager)

Each candidate tries to acquire/renew the Lease with its identity. The "leader" is the `spec.holderIdentity`. On a failed renewal, another candidate can claim it.

```bash
kubectl get lease -n kube-system kube-scheduler -o yaml | yq '.spec'
# holderIdentity: cp1_5a7b9c34-...
# leaseDurationSeconds: 15
# renewTime: "2026-04-23T14:25:30.123Z"
# acquireTime: "2026-04-20T10:15:00.000Z"
```

Failover time = `leaseDurationSeconds + retryPeriod` ≈ 15-20 s.

#### 2. Node heartbeats (kube-node-lease namespace)

Each kubelet renews its own Lease every 10 s (`NodeLeaseRenewInterval`). The node controller (in kube-controller-manager) watches these. If a node's Lease hasn't been renewed in `node-monitor-grace-period` (default 40 s), the node is flipped to `NotReady`.

Before the Lease-based mechanism, every kubelet had to `PATCH` its entire `Node` object every 10 s — a ~10 KiB write, cluster-wide. With Leases, it's a tiny 100-byte Lease update. That's why 5000-node clusters became practical.

```bash
kubectl get lease -n kube-node-lease worker-1 -o yaml
```

If you see Leases in `kube-node-lease` with old `renewTime`, kubelet is broken on that node even if the `Node` object status looks fresh (status updates are less frequent than Lease renewals).

---

## Transactions — atomic if/then/else

etcd Txns are the primitive Kubernetes uses for optimistic concurrency:

```
Txn {
  compare:
    mod_revision(/foo) == 101
  success:
    put(/foo = new-value)
  failure:
    (no-op)
}
```

If the condition holds, the `success` branch runs and a new revision commits. If not, the `failure` branch runs and the caller learns the comparison failed.

This is the exact mechanism behind `resourceVersion` in Kubernetes:

```
kubectl apply -f pod.yaml   (with embedded resourceVersion: 101)
  apiserver validates, constructs update
  apiserver calls etcd.Txn(compare mod_revision==101, success=put, failure=noop)
    if success → etcd writes, returns new rev=102; apiserver returns 200 OK
    if failure → Someone beat us; apiserver returns 409 Conflict
```

You see this manifest as `the object has been modified; please apply your changes to the latest version and try again` in `kubectl`. It's not a bug — it's a correct concurrency guard.

---

## Putting it together: a Pod creation walk

```
kubectl apply -f pod.yaml
    ↓
apiserver
    ├── validates (schema, admission)
    ├── generates Pod UID, resourceVersion is unset (new object)
    ├── etcd.Txn(compare creation(/registry/pods/default/foo) == 0, put value, failure=noop)
    │    compare holds → put succeeds → returns revision=12345
    ├── mod_revision becomes 12345
    └── returns to kubectl with Pod.metadata.resourceVersion=12345

    meanwhile, every informer watching /registry/pods/default/ sees a PUT event at revision 12345
        ├── scheduler's pod informer triggers its scheduling loop
        ├── various status reporters update their local caches
        └── kubelet on the chosen node sees the pod when the scheduler does the bind (another Txn)
```

Every "instantly" in Kubernetes is actually a watch-driven cache update on the order of milliseconds. Understanding this lets you predict latency and debug "why isn't the controller reacting?"

---

## What this means for debugging

- **Stale state** (informer reports old data): something broke the watch stream. Check apiserver → etcd connectivity; check for `mvcc: required revision has been compacted`.
- **Resource conflict** on every update: something is updating the same object faster than you are. `kubectl get <obj> -o yaml | grep resourceVersion` — look at what's bumping it (events, controllers).
- **Node reports NotReady but kubelet looks fine**: check `kubectl get lease -n kube-node-lease <node>` — maybe the Lease updates are being rejected (RBAC, certs) while the legacy NodeStatus path still works intermittently.
- **Leader election oscillating**: check Lease renew cadence vs network latency between CPs.

### Useful etcd-level commands

```bash
# Count of keys under a prefix
etcdctl get /registry --prefix --keys-only | wc -l

# Size of a resource type in the store
etcdctl get /registry/pods --prefix | wc -c

# Biggest Kubernetes objects
for ns in $(kubectl get ns --no-headers | awk '{print $1}'); do
  kubectl get cm,secret -n $ns -o json 2>/dev/null | \
    jq -r '.items[] | [.metadata.namespace, .kind, .metadata.name, (.data | tostring | length)] | @tsv'
done | sort -k4 -n | tail -20

# Current revision
etcdctl endpoint status -w json | jq '.[0].Status.header.revision'
```

---

## Exam heuristics

- You will not be asked to write an etcd watch. You may be asked about `resourceVersion`, `Lease` objects, or why a controller reconciles. Map each to the etcd primitive behind it.
- If a scenario mentions "node NotReady detection", the answer involves the kubelet's Lease in `kube-node-lease`.
- If a scenario mentions "leader election for scheduler/controller-manager", the answer is a Lease in `kube-system`.
- If you see `resource version too old / mvcc compacted` in any controller's logs, the controller's informer fell behind and will resync on its own; rarely a bug you need to fix.

## Mental traps

- Confusing etcd Leases with Kubernetes Leases. They are different mechanisms at different layers. Kubernetes Leases are API objects stored as normal keys; they have nothing to do with etcd's lease attachment primitive.
- Thinking `resourceVersion` is a timestamp. It isn't — it's a revision number. You cannot compare revisions across resources in any meaningful way.
- Believing revisions are per-key. They are per-cluster. Every write bumps the global counter once.
- Attempting to reuse revisions across a restore. A restored cluster has a new cluster ID and effectively a new revision counter — do not try to line up "revision 12345 in old cluster = same in new cluster."
- Writing a controller that ignores 409 Conflict. You must re-read the object, re-apply your intent, and retry. This is not a bug; it is the contract.
- Treating watches as push notifications guaranteed to be exactly-once. They are at-least-once, and your handler must be idempotent.
