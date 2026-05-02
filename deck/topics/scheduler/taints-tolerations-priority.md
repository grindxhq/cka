## Taints and tolerations in one line

A **taint** on a node says "keep pods away unless they explicitly accept." A **toleration** on a pod says "I accept this taint." A pod schedules onto a tainted node only if it tolerates every matching taint.

They are the inverse of affinity: affinity is about what a pod wants; taints are about what a node refuses.

## Taint shape

```
key=value:effect
```

Three effects:

| Effect              | Scheduling                        | Running pods on the node                |
|---------------------|-----------------------------------|-----------------------------------------|
| `NoSchedule`        | new pods filtered out             | existing pods stay                      |
| `PreferNoSchedule`  | soft — scheduler avoids           | existing pods stay                      |
| `NoExecute`         | new pods filtered out             | existing pods **evicted** (if no toleration) |

`NoExecute` is the dangerous one: applying it to a node evicts every pod that does not tolerate it. Use with intent.

## Add / remove taints

```bash
# Add
kubectl taint nodes <node> dedicated=gpu:NoSchedule

# Remove (note the trailing dash)
kubectl taint nodes <node> dedicated-                   # all with key `dedicated`
kubectl taint nodes <node> dedicated=gpu:NoSchedule-    # specific taint

# Inspect
kubectl describe node <node> | grep -A 3 Taints
kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints
```

## Toleration shape

```yaml
spec:
  tolerations:
    - key: "dedicated"
      operator: "Equal"
      value: "gpu"
      effect: "NoSchedule"
```

Rules:

- `operator: Equal` + `value` — exact match.
- `operator: Exists` — match any value for this key. `value` must be empty.
- Empty `key` + `operator: Exists` — **tolerate everything**. Use with care.
- Empty `effect` — tolerate all effects for the matching key. Use with care.
- `tolerationSeconds` (only relevant for `NoExecute`) — stay on the node for N seconds even though the taint applies, then evict.

## Common built-in taints

| Taint key                                         | Applied by          | Meaning                                  |
|---------------------------------------------------|---------------------|------------------------------------------|
| `node-role.kubernetes.io/control-plane`           | kubeadm             | Control plane nodes, no workloads        |
| `node-role.kubernetes.io/master` (older)          | kubeadm (legacy)    | Same                                     |
| `node.kubernetes.io/not-ready`                    | node controller     | Node is not Ready                        |
| `node.kubernetes.io/unreachable`                  | node controller     | API cannot reach the kubelet             |
| `node.kubernetes.io/memory-pressure`              | kubelet             | Node low on memory                       |
| `node.kubernetes.io/disk-pressure`                | kubelet             | Node low on disk                         |
| `node.kubernetes.io/pid-pressure`                 | kubelet             | Node low on PIDs                         |
| `node.kubernetes.io/network-unavailable`          | cloud-controller    | Node networking not ready                |
| `node.kubernetes.io/unschedulable`                | `kubectl cordon`    | Node cordoned                            |

The last five carry `NoExecute` with a default `tolerationSeconds: 300` for most pods. That is why pods take ~5 minutes to leave a failed node, not instantly.

## When to use taints vs labels+affinity

- **Taint** when the *default* should be "keep off." (Dedicated nodes: GPU, edge, PCI-compliant.)
- **Label + affinity** when the *default* should be "OK to place" and you want to steer specific pods.

They compose fine: a GPU node can have both `gpu=true:NoSchedule` and `hardware=gpu` label. GPU pods get a toleration AND a nodeSelector.

## Running a DaemonSet on control plane nodes

A common exam twist: your DaemonSet pods don't appear on control plane nodes. Because those nodes are tainted, the DS needs:

```yaml
spec:
  template:
    spec:
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
```

Or tolerate any taint (common for monitoring agents):

```yaml
tolerations:
  - operator: Exists
```

## PriorityClass — the other scheduling knob

Every pod has a **priority** (an integer). Default is 0. Higher priority pods:

- Move ahead in the scheduling queue.
- Can **preempt** lower-priority pods when the cluster is full.

Create a PriorityClass:

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high
value: 1000000
globalDefault: false
description: "For critical workloads"
```

Use it on a pod:

```yaml
spec:
  priorityClassName: high
```

Built-in classes on every cluster:

- `system-cluster-critical` (~2,000,000,000)
- `system-node-critical` (~2,000,001,000)

Control plane pods use these so they cannot be preempted.

## Preemption — what actually happens

When a high-priority pod is Pending, the scheduler looks at each node and asks: "if I killed some lower-priority pods here, could this pod fit?" If yes, the lowest-value set of victims is chosen, they are deleted with a grace period, and the high-priority pod schedules in.

Consequences:

- Preemption is **disruptive**. It terminates running pods.
- A pod with `preemptionPolicy: Never` can still jump the queue but will not evict anyone.
- PDBs are **respected only on a best-effort basis** during preemption.
- Cross-node preemption exists but is constrained — the scheduler prefers the cheapest single-node victim set.

## Debugging taint/toleration Pending

```bash
kubectl describe pod <name> | grep -A 20 Events
kubectl describe node <node> | grep -A 3 Taints
kubectl get pod <name> -o yaml | grep -A 20 tolerations
```

If you see "had untolerated taint", the string names the exact key, value, and effect.

## Fast fixes

- **Pod can't schedule on a tainted node** — add a matching toleration to the pod.
- **Node shouldn't be tainted** — `kubectl taint node <n> <key>-`.
- **Node stuck with `unschedulable` taint** — `kubectl uncordon <n>`.
- **Pod evicted due to NoExecute** — add toleration (plus `tolerationSeconds` if temporary).
- **Low-priority pods keep getting preempted** — assign a higher PriorityClass or reduce the priority of the aggressor pods.

## Exam heuristics

- Adding a toleration is usually cheaper than removing a taint — the taint is often there for a reason.
- For DaemonSets on every node, the go-to toleration is `operator: Exists` with no key.
- The `control-plane` taint is about workloads; you rarely need to remove it. If you must run a workload on a control plane node (single-node kubeadm labs), add the toleration.
- PriorityClass questions are rare but learnable: create the class, reference it by name, observe preemption.

## Mental traps

- Tolerating a taint does not **attract** the pod; it only **permits** it. Use affinity to attract.
- Tolerations default to match-any-effect if `effect` is empty. That is usually more permissive than intended.
- `NoExecute` with `tolerationSeconds: 0` still evicts — the value is a maximum, not "stay forever."
- Confusing taint **effect** (filter strength) with toleration **operator** (match rule). They are different fields.
- Preemption is not cordon-safe. A cordoned node can still be a preemption target if it is not also tainted.
