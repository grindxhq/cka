## What the node controller does

The node controller is the control plane's health monitor for Nodes. It runs inside `kube-controller-manager` and does three jobs:

1. **Health**: watches kubelet heartbeats and flips a node to `NotReady` when they stop.
2. **Taint**: applies `node.kubernetes.io/not-ready` or `node.kubernetes.io/unreachable` so the scheduler avoids the node.
3. **Evict**: after a grace period, uses `NoExecute` to kick off pods that do not tolerate the node-level taint.

Kubelet publishes its own `Ready` status — the node controller just consumes those heartbeats. Don't confuse "the thing that declares Ready" (kubelet) with "the thing that reacts to it" (node controller).

## The heartbeat path

Modern clusters use two signals:

- **NodeStatus updates** — kubelet patches its own `Node.status` on change.
- **Lease objects** — kubelet renews `coordination.k8s.io/v1/Lease` in namespace `kube-node-lease` every 10 seconds.

Why two? Lease renewals are cheap; NodeStatus patches are expensive because they churn the large Node object. The lease is the primary heartbeat at scale.

If lease renewals stop:

1. After `node-monitor-grace-period` (default **40 s**) → node flips to `NotReady`.
2. After that, taint `node.kubernetes.io/unreachable` or `not-ready` is applied with `NoExecute`.
3. Pods on the node that do **not** tolerate those taints are evicted after `tolerationSeconds` (default **300 s** = 5 min).

That is why a failed node's pods appear to "hang" for ~5 minutes before being rescheduled. It is not a bug. It is the tolerationSeconds.

## Timings worth memorizing

| Parameter                        | Default | What happens at this threshold                  |
|----------------------------------|---------|------------------------------------------------|
| Lease renew interval             | 10 s    | kubelet writes a fresh lease                    |
| Node status update interval      | 10 s    | kubelet updates `Node.status` if changed        |
| `node-monitor-grace-period`      | 40 s    | Node transitions Ready → NotReady               |
| `tolerationSeconds` for not-ready| 300 s   | Pods without the toleration are evicted         |
| `tolerationSeconds` for unreachable | 300 s| Same, for unreachable                           |

## Ready vs NotReady vs Unknown

- `Ready: True` — kubelet is healthy.
- `Ready: False` — kubelet reported a problem (disk pressure, container runtime error).
- `Ready: Unknown` — kubelet has gone silent; the node controller cannot tell. Same eviction behavior.

Inspect:

```bash
kubectl get nodes
kubectl describe node <node> | sed -n '/Conditions:/,/Addresses:/p'
kubectl get node <node> -o jsonpath='{range .status.conditions[*]}{.type}={.status} ({.reason}){"\n"}{end}'
```

## What evicts a pod when the node goes down

Two things can evict pods:

- **Taint-based eviction** (the one above) — applies to all pods lacking the toleration.
- **Pod eviction controller** (for older semantics) — now mostly replaced by taint-based eviction.

Pods that have these tolerations (DaemonSets, control plane pods) **do not** get evicted:

```yaml
tolerations:
  - key: node.kubernetes.io/not-ready
    operator: Exists
    effect: NoExecute
  - key: node.kubernetes.io/unreachable
    operator: Exists
    effect: NoExecute
```

That is how DaemonSet pods survive a brief node hiccup — they tolerate the taints.

## Node deletion behavior

If you `kubectl delete node <n>`:

- The Node object is removed immediately.
- Pods that were bound to it become orphaned (the scheduler will not re-bind an existing pod).
- Typically a parent controller recreates them.

This is a useful recovery when a node is permanently gone and its pods are stuck not-ready. Deleting the node forces the parent controllers to recreate pods elsewhere.

## Diagnosing a flapping node

Signs: node oscillates between Ready and NotReady every minute or two.

Causes (ordered by likelihood):

1. **Overloaded kubelet** — system pods consuming CPU/mem on the node.
2. **Container runtime issues** — `containerd` or `cri-o` flaking.
3. **Network flakes** between node and apiserver.
4. **Clock skew** breaking lease renewal.
5. **Disk pressure** hitting eviction thresholds.

On-node checks:

```bash
journalctl -u kubelet --no-pager | tail -200
crictl info | jq '.status.runtimeReady'
df -h /
free -m
```

## Diagnosing an unexpected NotReady node

Decision tree on the apiserver side:

```
node NotReady
│
├── Conditions show DiskPressure=True, MemoryPressure=True, or PIDPressure=True
│       → kubelet eviction threshold hit; check usage on node
│
├── Conditions show NetworkUnavailable=True
│       → CNI problem; check CNI pods
│
├── Conditions all fine but Ready=False with reason "KubeletNotReady"
│       → check kubelet logs for container runtime / PLEG errors
│
├── Conditions Ready=Unknown
│       → kubelet is unreachable; SSH to the node and check kubelet/lease
│
└── Node vanished
       → node was deleted or not registered; check kubelet journal
```

## Fast commands

```bash
# Node health at a glance
kubectl get nodes -o wide

# Condition reasons for all nodes
kubectl get nodes -o json | jq -r '
  .items[] | .metadata.name as $n |
  .status.conditions[] |
  select(.type=="Ready") |
  [$n, .status, .reason, .message] | @tsv'

# Who is on which node
kubectl get pods -A -o wide --field-selector spec.nodeName=<node>

# Lease status
kubectl get lease -n kube-node-lease
```

## Fast fixes

- **Kubelet died** — restart it: `sudo systemctl restart kubelet`.
- **Disk pressure** — clean up images: `crictl rmi --prune`, remove old logs.
- **Runtime stuck** — restart it: `sudo systemctl restart containerd` then kubelet.
- **Temporary unreachability** — verify apiserver URL in `/etc/kubernetes/kubelet.conf` and firewall rules to `:6443`.
- **Permanently dead node** — delete it: `kubectl delete node <n>` so workloads reschedule.

## Exam heuristics

- "Node is NotReady, restore it" usually means fixing kubelet or the container runtime on that node, not scheduler work.
- If multiple nodes flip simultaneously, suspect the apiserver or etcd, not the nodes.
- Do not forget the 5-minute pod eviction window. If the exam expects pods to move, give it time (or delete the node to accelerate).

## Mental traps

- Thinking NotReady means the kubelet declared itself broken. The `Unknown` state (no heartbeat) looks identical from the outside.
- Assuming pod eviction is instant. It takes grace period + tolerationSeconds by default.
- Believing `kubectl drain` is how you simulate node failure. `drain` cordons and evicts gracefully — fails very differently from a crashed node.
- Forgetting that DaemonSet pods do not evict, so a DS pod on a NotReady node still shows Running for ages. Check with `kubectl get pods -o wide`.
