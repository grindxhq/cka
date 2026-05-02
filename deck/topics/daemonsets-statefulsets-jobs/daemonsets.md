## What a DaemonSet does

A DaemonSet runs **one pod per matching node**. Every Node that matches the DS's node selector / affinity / tolerations gets exactly one pod. New nodes added → DS controller schedules a pod there. Nodes deleted → pod goes away.

The "matching" is critical: a DS can target every node, only worker nodes, only nodes with a specific label, only nodes the pod can tolerate the taints of. By default, control plane nodes are tainted and DS pods don't tolerate them — so DSes typically run only on workers unless you add the toleration.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: log-shipper
  namespace: kube-system
spec:
  selector:
    matchLabels: { app: log-shipper }
  template:
    metadata: { labels: { app: log-shipper } }
    spec:
      tolerations:
      - operator: Exists                  # tolerate ALL taints (run on every node)
      hostNetwork: true                    # use the node's network namespace
      containers:
      - name: agent
        image: log-shipper:1.0
        volumeMounts:
        - name: hostlogs
          mountPath: /var/log
          readOnly: true
      volumes:
      - name: hostlogs
        hostPath: { path: /var/log }
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
```

Use cases:

- **Log shippers** — fluentd, vector, fluent-bit on every node, reading `/var/log`.
- **Node monitoring** — node-exporter, datadog-agent, cAdvisor.
- **Storage drivers** — CSI node plugins (each node needs the driver).
- **CNI plugins** — Calico, Cilium, Flannel agents (one per node).
- **kube-proxy** itself is a DaemonSet on most clusters.

---

## What's in a DaemonSet spec

```yaml
spec:
  selector:                           # IMMUTABLE; identifies which Pods belong to me
    matchLabels: { app: log }
  template: { ... }                   # standard PodSpec
  updateStrategy:
    type: RollingUpdate              # | OnDelete
    rollingUpdate:
      maxUnavailable: 1               # how many pods can be down during update
      maxSurge: 0                     # how many extra pods (default 0; 0% disables surge)
  minReadySeconds: 0
  revisionHistoryLimit: 10
```

Differences from Deployment:

- **No `replicas`** — count is determined by matching node count.
- **`maxSurge` defaults to 0** — only one DS pod per node by design (extra would conflict on hostPort, hostPath, hostNetwork).
- **No `Recreate` strategy** — only `RollingUpdate` and `OnDelete`.

---

## Node selection

A DaemonSet pod is scheduled on a node iff:

1. The pod's `nodeSelector` matches the node (if set).
2. The pod's `nodeAffinity` is satisfied (if set).
3. The pod's `tolerations` cover all of the node's `NoSchedule`/`NoExecute` taints.

Notably:

- **No `nodeSelector` / `nodeAffinity`** = candidate for every node.
- **Default tolerations**: DaemonSet controller automatically adds tolerations for several built-in taints so pods don't get evicted on common node-pressure events:
  - `node.kubernetes.io/not-ready`
  - `node.kubernetes.io/unreachable`
  - `node.kubernetes.io/disk-pressure`
  - `node.kubernetes.io/memory-pressure`
  - `node.kubernetes.io/pid-pressure`
  - `node.kubernetes.io/unschedulable`
  - `node.kubernetes.io/network-unavailable`

So a DS pod survives node-pressure better than a regular pod. It does **not** automatically tolerate the control-plane taint:

```
node-role.kubernetes.io/control-plane:NoSchedule
```

If you want a DS on control plane nodes (e.g. CNI agents), add that toleration explicitly.

---

## Restricting to specific nodes

Use a `nodeSelector` on the pod template:

```yaml
spec:
  template:
    spec:
      nodeSelector:
        disktype: ssd
```

Now only nodes labeled `disktype: ssd` get a DS pod. Other nodes don't.

For richer selection, `nodeAffinity`:

```yaml
spec:
  template:
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: kubernetes.io/os
                operator: In
                values: [linux]
              - key: node-role.kubernetes.io/worker
                operator: Exists
```

---

## Update strategies

### RollingUpdate (default)

```yaml
updateStrategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 1
    maxSurge: 0           # default — one pod per node, no overlap
```

When the template changes:

- DS controller deletes 1 (per `maxUnavailable`) old pod at a time, then creates the new one in its place.
- Waits for new pod to be Ready before moving on.
- Continues until every node has the new pod.

Total time = (number of nodes) * (per-pod replacement time).

`maxSurge: 1` (since 1.21+) allows briefly running both old and new on the same node — useful for "no downtime" upgrades of network agents. Not safe if the pod uses hostPort or hostPath that conflicts.

### OnDelete

```yaml
updateStrategy:
  type: OnDelete
```

DS controller does NOT auto-update pods on template change. You must manually delete each old pod; the DS recreates it with the new template.

```bash
# After updating the DS template, restart pods one by one:
kubectl delete pod log-shipper-abc123
# DS recreates it from the new template
kubectl get pods -l app=log-shipper -o wide   # observe new image
```

Use `OnDelete` when you want manual control over the rollout pace (one node at a time, with checks between).

---

## Surge for DaemonSets (1.21+)

The `maxSurge` field allows the DS controller to start a new-version pod **before** removing the old one on the same node:

```yaml
updateStrategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 0       # never go below current pods
    maxSurge: 1              # one extra pod per node briefly
```

Allows "blue/green per node" — new pod ready on the node before old one is killed. Good for network agents where the gap means no traffic flowing.

Caveats:

- Old and new pods must coexist on the same node. Can't both bind the same hostPort. Can't both write the same hostPath in conflicting ways.
- Briefly doubles resource usage on each node.

---

## DaemonSet pod naming

Pod names are auto-generated:

```
<daemonset-name>-<random>
```

Not stable across recreations. If you need stable names per node, look at StatefulSets (different problem domain).

The pod's `spec.nodeName` is set when the DS controller creates it — the controller picks the target node and sets `nodeName` directly, bypassing the scheduler. (More recent versions go through the scheduler for filtering/topology, but the binding decision is the DS controller's.)

---

## DaemonSet pod-readiness vs node-readiness

DS pods can take a while to become Ready (image pull, init containers). During that time:

- The pod is not in the Service's Endpoints (if any Service selects it).
- Node is still considered Ready (the DS pod isn't a kubelet liveness signal).

Conversely, kubelet pressure conditions (`MemoryPressure=True`) automatically taint the node with `NoExecute`. By default, regular pods get evicted; DS pods (which tolerate those taints) stay. This means DS pods continue logging / metric-collecting even when the node is in trouble.

---

## DS update with HostPort or HostPath conflicts

If two DS pods can't coexist on the same node (e.g. they both want to bind hostPort 9090), `maxSurge: 1` won't work — the new pod can't start while old one holds the port.

In that case:

- Use `maxSurge: 0` (default).
- Accept the brief "no DS pod on this node" window during update.
- Or, design the workload to handle a few seconds of agent downtime.

---

## Inspecting a DS

```bash
# Status
kubectl get ds <name> -A
# NAMESPACE     NAME           DESIRED   CURRENT   READY   UP-TO-DATE   AVAILABLE   NODE SELECTOR
# kube-system   kube-proxy     5         5         5       5            5           kubernetes.io/os=linux

# Per-node distribution
kubectl get pods -l <selector> -o wide
# NAME                READY   STATUS    NODE          AGE
# log-shipper-abc12   1/1     Running   worker-1      1d
# log-shipper-def45   1/1     Running   worker-2      1d
# log-shipper-ghi78   1/1     Running   worker-3      1d

# Why is a node missing a pod?
kubectl describe node <node> | grep -A 3 Taints
# Look for taints the DS doesn't tolerate

kubectl describe ds <name>
# Events show scheduling decisions
```

---

## Updating with rollout commands

The same `kubectl rollout` commands work on DaemonSets:

```bash
# Force restart all DS pods
kubectl rollout restart ds/<name>

# Status
kubectl rollout status ds/<name>

# History
kubectl rollout history ds/<name>

# Rollback
kubectl rollout undo ds/<name>
```

Internally, the DS controller manages "controller revisions" (`controllerrevisions.apps/v1` resource) for history. Less explicit than Deployment's ReplicaSets but conceptually similar.

---

## DS-specific failure modes

### DS pods all fail to start

If image is wrong / probes are too strict, ALL nodes get failing pods. Cluster-wide visibility issue.

Recovery: roll back, fix, re-apply.

### Some nodes don't get a DS pod

Likely:

- Node has a taint the DS doesn't tolerate.
- Node selector / affinity excludes the node.
- Node is `Unschedulable` (cordoned).

`kubectl describe node <node>` reveals.

### DS pods CrashLoopBackOff on subset of nodes

Node-specific issue:

- Different OS / arch.
- Specific node has missing `/var/log` directory (hostPath issue).
- Specific node has port already in use (hostPort).

Investigate the node-specific differences. Often a fleet-uniformity issue.

### DS update stuck

Look at the new pod's status. Probably failing to become Ready. Same diagnosis as Deployment rollout stalls.

---

## Common patterns

### Logs and metrics agent

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluent-bit
  namespace: logging
spec:
  selector: { matchLabels: { app: fluent-bit } }
  template:
    metadata: { labels: { app: fluent-bit } }
    spec:
      tolerations:
      - operator: Exists
      containers:
      - name: fluent-bit
        image: cr.fluentbit.io/fluent/fluent-bit:latest
        volumeMounts:
        - name: varlog
          mountPath: /var/log
          readOnly: true
        - name: dockerlogs
          mountPath: /var/lib/docker/containers
          readOnly: true
      volumes:
      - name: varlog
        hostPath: { path: /var/log }
      - name: dockerlogs
        hostPath: { path: /var/lib/docker/containers }
```

Reads container logs from the node's filesystem, ships to a logging backend.

### CSI node plugin

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ebs-csi-node
spec:
  selector: { matchLabels: { app: ebs-csi-node } }
  template:
    metadata: { labels: { app: ebs-csi-node } }
    spec:
      hostNetwork: true
      tolerations:
      - operator: Exists
      containers:
      - name: ebs-plugin
        image: amazon/aws-ebs-csi-driver:latest
        # ... volume mounts for /var/lib/kubelet/plugins, etc.
      - name: node-driver-registrar
        image: registry.k8s.io/sig-storage/csi-node-driver-registrar:latest
```

Each node needs the storage driver. DS guarantees one per node.

---

## Exam heuristics

- For "run a pod on every node," use a DaemonSet.
- For "run a pod on every control plane node," add the control-plane toleration.
- DS pods automatically tolerate node-pressure taints — they survive bad nodes longer than regular pods.
- `kubectl rollout restart ds/<name>` is the standard "redeploy" command.
- DS update strategy is RollingUpdate (default) or OnDelete (manual control).

## Mental traps

- Setting `replicas` on a DaemonSet. Not a thing. The count is determined by matching nodes.
- Forgetting the control-plane toleration when you actually want to run on all nodes including CP.
- Using DS for "run N pods cluster-wide" — that's a Deployment with replicas. DS is "one per node."
- Setting `maxSurge: 1` for a DS with hostPort conflicts. Won't work; new pod can't start.
- Expecting DS pod names to be stable per-node. They're random suffixes; node identity is in `spec.nodeName`.
- Forgetting that the DS controller bypasses scheduler for binding (in some versions). Pods may appear before the scheduler "would have" placed them.
- Treating `OnDelete` as "no updates ever." It's "manual updates only" — you must delete pods to apply template changes.
