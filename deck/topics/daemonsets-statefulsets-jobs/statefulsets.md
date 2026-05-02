## What StatefulSets give you

A Deployment treats its Pods as interchangeable. Pod IDs are random; if one dies, a new one with a new name and new IP replaces it. That's fine for stateless web servers but useless for databases, where pod-1 has data that pod-2 doesn't and clients need to address specific instances.

A **StatefulSet** gives Pods:

1. **Stable network identity** — predictable per-replica DNS names like `mysql-0`, `mysql-1`.
2. **Stable storage** — each replica gets its own PVC that survives pod restarts and follows the pod across nodes.
3. **Ordered lifecycle** — pods created and deleted one at a time, in numerical order.

These come at a cost (less flexible, slower rollouts), so use StatefulSet only when you actually need the guarantees. A stateless web app should be a Deployment.

---

## A canonical StatefulSet

```yaml
---
# Headless service is required for stable DNS
apiVersion: v1
kind: Service
metadata:
  name: mysql                          # SAME name as serviceName below
spec:
  clusterIP: None                       # headless
  selector:
    app: mysql
  ports:
  - port: 3306

---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
spec:
  serviceName: mysql                    # MUST match the headless Service name
  replicas: 3
  selector:
    matchLabels: { app: mysql }
  template:
    metadata:
      labels: { app: mysql }
    spec:
      containers:
      - name: mysql
        image: mysql:8.0
        env:
        - name: MYSQL_ROOT_PASSWORD
          value: secret
        ports:
        - containerPort: 3306
        volumeMounts:
        - name: data
          mountPath: /var/lib/mysql
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ ReadWriteOnce ]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 50Gi
```

Two things distinguish this from a Deployment:

- `volumeClaimTemplates` — for each replica, the controller creates a PVC named `<vct-name>-<sts-name>-<replica-index>` (e.g. `data-mysql-0`).
- `serviceName` — a headless Service that gives each pod a DNS name.

---

## Stable network identity

Each pod gets a name and a DNS record:

```
Pod name:              mysql-0, mysql-1, mysql-2

Pod DNS:               mysql-0.mysql.default.svc.cluster.local
                       mysql-1.mysql.default.svc.cluster.local
                       mysql-2.mysql.default.svc.cluster.local

Service DNS (headless): mysql.default.svc.cluster.local
                        → returns A records for mysql-0, mysql-1, mysql-2 IPs
```

These names are **stable** — `mysql-0` always resolves to the current `mysql-0` pod, even if it gets rescheduled to a different node.

This is what enables clustered databases:

- `mysql-1` connects to `mysql-0` to start replication.
- `mysql-2` joins `mysql-0` and `mysql-1`.
- Each replica knows its peers by name.

---

## Stable per-pod storage

`volumeClaimTemplates` is the magic. For each replica, the controller creates a PVC:

```
mysql-0 → PVC `data-mysql-0`
mysql-1 → PVC `data-mysql-1`
mysql-2 → PVC `data-mysql-2`
```

Each PVC binds to a separate PV. Each pod mounts only its own PVC. Pod-1's data is independent of pod-0's data.

When a pod is rescheduled (node failure, kubectl delete pod), the SAME PVC follows. Data survives. Identity preserved.

When you delete the StatefulSet:

```bash
kubectl delete sts mysql
```

The Pods are deleted, but **the PVCs remain**. Data is preserved. Recreate the StatefulSet with the same name and the new pods reattach to the existing PVCs.

To truly delete data, also delete PVCs:

```bash
kubectl delete pvc -l app=mysql
```

---

## Ordered creation and deletion

Pods come up one at a time, in order:

```
mysql-0 → wait for Ready → mysql-1 → wait for Ready → mysql-2 → ...
```

This is the default `podManagementPolicy: OrderedReady`. Each pod's Ready state gates the next.

For deletes / scale-down, the order reverses (highest index first):

```
mysql-2 (terminate, wait for Terminating to complete) → mysql-1 → mysql-0
```

Use case: clustered databases need pod-0 alive when pod-1 starts (for replication setup). And when scaling down, you want to terminate the newest replica first to preserve the oldest data.

### Parallel pod management (faster, less careful)

```yaml
spec:
  podManagementPolicy: Parallel
```

All pods created/deleted simultaneously. No ordering guarantees. Useful for stateful workloads that don't need ordering (e.g. sharded caches where each replica is independent).

Stable identity (names, PVCs, DNS) still works. Only the timing changes.

---

## Update strategies

### RollingUpdate (default)

```yaml
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0          # update pods with index >= partition
```

When the template changes:

- Pods updated **one at a time, in reverse order** (highest index first).
- mysql-2 → terminated → recreated with new template → wait for Ready.
- mysql-1 → same.
- mysql-0 → same.

Each step waits for the previous pod to be Ready. So a failing new pod blocks the entire rollout.

### Partition (canary for StatefulSet)

`partition: N` means: only update pods with index ≥ N. Lower-index pods stay on the old template.

```yaml
spec:
  replicas: 5
  updateStrategy:
    rollingUpdate:
      partition: 3       # only mysql-3 and mysql-4 update; mysql-0,1,2 stay old
```

Apply a new template → only mysql-3 and mysql-4 get the new version. Verify they work.

Then lower the partition:

```yaml
partition: 0   # now all pods update
```

Pods 2, 1, 0 update in reverse order.

This is the StatefulSet equivalent of canary releases — controlled progressive rollout.

### OnDelete

```yaml
spec:
  updateStrategy:
    type: OnDelete
```

Manual control. After updating the template, you must delete pods (highest index first) to apply.

---

## Headless Service requirement

`serviceName: mysql` references a Service. That Service **must** be:

- **Headless** (`clusterIP: None`).
- **In the same namespace** as the StatefulSet.
- **Have a selector** that matches the StatefulSet's pod labels.

The Service's role isn't load-balancing — it's for the DNS records that give each pod a stable hostname.

```bash
# Verify the Service is headless
kubectl get svc mysql
# NAME    TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)    AGE
# mysql   ClusterIP   None         <none>        3306/TCP   1d
```

`CLUSTER-IP: None` confirms headless.

If the Service doesn't exist or isn't headless, the StatefulSet still creates pods, but per-pod DNS doesn't resolve. Most stateful workloads break in confusing ways.

### Pair StatefulSet with a regular Service for clients

The headless Service is for pod-to-pod naming. For external clients to load-balance across all replicas, add a normal ClusterIP Service:

```yaml
apiVersion: v1
kind: Service
metadata: { name: mysql-read }
spec:
  selector: { app: mysql }
  ports: [ { port: 3306, targetPort: 3306 } ]
```

`mysql-read` is a regular Service with a ClusterIP. Clients hit `mysql-read.default.svc.cluster.local:3306` and get any replica. The headless `mysql` Service still exists for naming.

Common pattern: headless for primary write (specific pod, e.g. `mysql-0.mysql`), regular ClusterIP for reads (any replica).

---

## Scaling a StatefulSet

```bash
kubectl scale sts mysql --replicas=5

# Pods 3 and 4 created (in order, after 2 is Ready):
# mysql-3 (with PVC data-mysql-3)
# mysql-4 (with PVC data-mysql-4)
```

Scale down:

```bash
kubectl scale sts mysql --replicas=2

# Pods 4 and 3 terminated (highest index first):
# mysql-4 deleted (PVC data-mysql-4 stays)
# mysql-3 deleted (PVC data-mysql-3 stays)
# mysql-0, mysql-1, mysql-2 unaffected
```

Scaling back up after scaling down: pods 2, 3 (or 3, 4) are recreated and **reattach to existing PVCs**. Data is preserved across scale events.

Caveat: scale down doesn't delete PVCs. Storage charges keep accruing. Manual cleanup needed if the data isn't needed:

```bash
kubectl delete pvc data-mysql-3 data-mysql-4
```

---

## What `volumeClaimTemplates` actually does

```yaml
volumeClaimTemplates:
- metadata:
    name: data
  spec:
    accessModes: [ ReadWriteOnce ]
    storageClassName: fast-ssd
    resources:
      requests:
        storage: 50Gi
```

For each replica `i`, the controller creates a PVC named `<vct-name>-<sts-name>-<i>`:

- mysql-0 → `data-mysql-0`
- mysql-1 → `data-mysql-1`

Spec is identical for each (same SC, same size, same access modes). The PVCs trigger dynamic provisioning (or static binding) just like any other PVC.

The pod's `volumeMounts` references the volume by template name (`data`), and kubelet automatically binds it to the right PVC for this pod's index.

You can have multiple `volumeClaimTemplates` per StatefulSet (e.g. one for data, one for logs). Each template generates one PVC per replica.

### PVCs survive pod termination

Deleting `mysql-0` (the pod) doesn't delete `data-mysql-0` (the PVC). When the controller recreates `mysql-0`, it reattaches to the existing PVC.

This is the storage-stability guarantee — pod's data survives restart and rescheduling.

### PVCs survive StatefulSet deletion (by default)

Deleting the StatefulSet by default leaves the PVCs alone. Recreate the SS with the same name → pods reattach to existing PVCs.

Configure auto-deletion via `persistentVolumeClaimRetentionPolicy`:

```yaml
spec:
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Retain         # | Delete — what to do when SS is deleted
    whenScaled: Retain           # | Delete — what to do when scaled down
```

`whenScaled: Delete` would make PVCs disappear when you scale down. Convenient but data-destroying. Default Retain is safer.

---

## podManagementPolicy

```yaml
spec:
  podManagementPolicy: OrderedReady       # default — sequential
  # OR
  podManagementPolicy: Parallel           # all at once
```

`OrderedReady`: pod-0 must be Ready before pod-1 starts. pod-1 before pod-2. Etc.

`Parallel`: all pods created simultaneously. PVCs still per-pod, identity still stable. Just no ordering.

For databases that need replication setup ordering: OrderedReady. For sharded caches where each replica is independent: Parallel.

---

## Inspecting a StatefulSet

```bash
# Status
kubectl get sts mysql

# NAME    READY   AGE
# mysql   3/3     1d

# Pods (note ordered names)
kubectl get pods -l app=mysql

# NAME      READY   STATUS    AGE
# mysql-0   1/1     Running   1d
# mysql-1   1/1     Running   1d
# mysql-2   1/1     Running   1d

# PVCs (one per replica)
kubectl get pvc -l app=mysql

# NAME            STATUS   VOLUME    CAPACITY   ACCESS MODES   STORAGECLASS   AGE
# data-mysql-0    Bound    pvc-xxx   50Gi       RWO            fast-ssd       1d
# data-mysql-1    Bound    pvc-yyy   50Gi       RWO            fast-ssd       1d
# data-mysql-2    Bound    pvc-zzz   50Gi       RWO            fast-ssd       1d

# DNS check from inside cluster
kubectl run -it --rm test --image=busybox:1.28 -- nslookup mysql-0.mysql.default.svc.cluster.local
```

---

## Common StatefulSet failure modes

### Pod stuck Pending — PVC issue

`mysql-0` can't start because `data-mysql-0` is Pending (no matching PV, dynamic provisioning failed). Same triage as any PVC Pending issue (see storage deck).

### mysql-1 won't start because mysql-0 is broken

`OrderedReady` blocks pod-1 until pod-0 is Ready. If pod-0 has CrashLoopBackOff:

- pod-1 stays Pending.
- pod-2 stays Pending.
- Etc.

Fix pod-0 first (or remove the dependency by switching to `Parallel`).

### Scale down doesn't reduce storage cost

PVCs survive. Until you manually delete them (or set `whenScaled: Delete`), the underlying volumes are still provisioned and billed.

### Pod gets rescheduled to a different node, can't mount RWO PVC

Common with EBS-style block storage: the PVC was attached to the old node, attach-detach controller has to detach + attach to new node. Takes ~30-60 seconds. Pod stuck `ContainerCreating` during this window.

For faster failover: ensure the cloud's CSI driver supports fast detach. Or use distributed storage (NFS, Ceph) where attach is more flexible.

### DNS doesn't resolve mysql-0.mysql

- Headless Service doesn't exist or isn't named `mysql`.
- StatefulSet's `serviceName` doesn't match.
- CoreDNS broken (see coredns deck).

```bash
# Verify
kubectl get svc mysql -o jsonpath='{.spec.clusterIP}'
# Should be `None`
```

### Update stuck

The new pod (highest index) won't become Ready. Rollout halts because the next pod can't start until this one is Ready.

Diagnose the failing pod (logs, probes, image). Fix it; rollout resumes.

---

## When to use StatefulSet (and when not)

Use StatefulSet for:

- Databases (MySQL, PostgreSQL, MongoDB).
- Distributed systems (Kafka, Cassandra, ZooKeeper, Elasticsearch).
- Sharded caches where each replica needs unique persistent state.
- Anything where pods need stable identity (DNS) or stable storage.

Don't use StatefulSet for:

- Stateless web services. Deployment is simpler.
- Pods that don't need persistent data. emptyDir on a Deployment works fine.
- Single-replica apps that don't need stability beyond a Deployment offers.

The cost of StatefulSet:

- Slower rollouts (one at a time).
- More complex debugging.
- Storage that survives pod deletion (good and bad).
- Less flexibility in scheduling (RWO PVCs limit which nodes work).

If you don't need the guarantees, the simpler Deployment is the right tool.

---

## Common patterns

### Database master + replicas

```yaml
spec:
  replicas: 3
  serviceName: mysql
  template:
    spec:
      containers:
      - name: mysql
        image: mysql:8
        env:
        - name: MYSQL_REPLICATION_MODE
          value: master         # init container or entrypoint logic determines based on $HOSTNAME
        - name: POD_INDEX
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        # ... mysql-0 becomes master; mysql-1, mysql-2 connect to mysql-0.mysql for replication setup
```

Each pod inspects its own name (`mysql-0`, `mysql-1`, ...) and decides its role.

### Stable storage for a single-instance app

```yaml
spec:
  replicas: 1
  serviceName: app
  template: { ... }
  volumeClaimTemplates:
  - metadata: { name: data }
    spec: { accessModes: [RWO], resources: { requests: { storage: 100Gi } } }
```

Even with one replica, StatefulSet ensures the same PVC follows the pod across restarts. A Deployment with a manually-created PVC also works, but StatefulSet handles the PVC-to-pod binding automatically.

---

## Exam heuristics

- For "create a StatefulSet for a database," remember: headless Service first, then StatefulSet with matching `serviceName`, then `volumeClaimTemplates`.
- Pod names follow `<sts-name>-<index>` starting at 0.
- DNS for individual pods: `<pod-name>.<service-name>.<namespace>.svc.cluster.local`.
- Scale down doesn't delete PVCs by default.
- `kubectl delete sts <name> --cascade=orphan` removes the SS without affecting pods (rarely useful, but exists).

## Mental traps

- Forgetting the headless Service. Pod DNS doesn't resolve, but the SS still creates pods — confusing.
- Setting `clusterIP` to a value (not `None`) on the StatefulSet's Service. Then it's a regular Service, no per-pod DNS.
- Expecting `kubectl scale --replicas=0` to delete PVCs. It scales pods to 0; PVCs remain.
- Using `Parallel` podManagementPolicy on a workload that needs ordering (e.g. classic Postgres replication). Replicas come up before primary is ready.
- Confusing StatefulSet's `partition` rollout field with anti-affinity partition. They're unrelated.
- Treating `mysql-0` as special. It's just the first pod; the workload code defines what role each pod has.
- Modifying `volumeClaimTemplates` after creation. That field is essentially immutable for existing PVCs — changes only affect new replicas added later.
