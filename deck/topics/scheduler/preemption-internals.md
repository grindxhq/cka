## Why preemption needs its own subtopic

The high-level story — "higher-priority pods evict lower-priority ones" — hides the whole set of decisions that actually determine what gets killed, when, and whether your high-priority pod even lands after the eviction. Miss one of those, and you get scenarios like:

- A `cluster-admin` creates a high-priority pod; half the cluster gets evicted; the new pod *still* stays Pending because it violates a different filter.
- A PDB was supposed to protect a critical workload; preemption killed it anyway.
- Two high-priority pods preempt each other in a loop.

This note walks the algorithm end-to-end and names every edge the algorithm can trip over.

---

## Priority is a number, nothing more

`PriorityClass` is a cluster-scoped object whose `value` field is a 32-bit integer. A pod's `priorityClassName` gets resolved at admission time:

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high
value: 1000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority     # default; or: Never
description: "For latency-critical workloads"
```

What happens when a pod is created:

1. Admission plugin `Priority` looks up the named PriorityClass.
2. Copies `value` into `pod.spec.priority` (the integer) and sometimes into `pod.spec.preemptionPolicy`.
3. Both fields are **immutable** after creation.
4. A pod with no `priorityClassName` uses 0 — unless a `PriorityClass` has `globalDefault: true`, in which case that default applies to **new** pods.

Reserved values above 1,000,000,000 are for the two system classes:

| Name                          | Value           | Who uses it                                    |
|-------------------------------|-----------------|------------------------------------------------|
| `system-cluster-critical`     | ≈ 2,000,000,000 | addons that must run but can tolerate delay    |
| `system-node-critical`        | ≈ 2,000,001,000 | kubelet, static pods, node-essential daemons    |

These are attached to control plane pods so nothing user-created can preempt them. Don't bind either to normal workloads.

### `preemptionPolicy: Never`

Two options exist:

- **`PreemptLowerPriority`** (default) — pod can preempt anything with a lower priority.
- **`Never`** — pod **jumps the queue** (higher priority sorts earlier) but **cannot** evict anyone. It just waits for natural capacity.

"Non-preempting high priority" is useful for long-running jobs (ML training) that should start before low-priority workloads but shouldn't disrupt anything running. The pod still *gets* preempted by anyone with `PreemptLowerPriority` at higher priority than itself.

---

## The preemption algorithm — what the scheduler actually does

Preemption is triggered by the `DefaultPreemption` plugin at the **PostFilter** stage, which runs only when Filter returned zero feasible nodes:

```
Filter returned 0 nodes
    │
    ▼
PostFilter = DefaultPreemption
    │
    ├── (1) Is preemption even possible?
    │       - is pod's preemptionPolicy PreemptLowerPriority?
    │       - no Filter returned UnschedulableAndUnresolvable
    │       - if no → pod stays Pending, no preemption
    │
    ├── (2) For each node, compute a victim set
    │       - hypothetically evict lower-priority pods until pod fits (or give up)
    │       - victim set size is the disruption cost for that node
    │
    ├── (3) Pick the cheapest node
    │       - fewest total victims (primary)
    │       - highest sum-of-priorities among victims (i.e. kill higher-priority-among-victims-first is avoided — we want to kill the lowest)
    │       - node with latest start time (to avoid churning fresh nodes)
    │       - best-effort PDB respect
    │
    ├── (4) Delete the chosen victims via apiserver DELETE with grace period
    │
    ├── (5) Set pod.status.nominatedNodeName = <chosen node>
    │
    └── (6) Pod goes back to the scheduling queue
                - next scheduling attempt preferentially tries the nominated node
                - but still must pass all Filters again
```

Two subtle invariants:

- Preemption **does not schedule the pod**. It just clears space. The pod must re-enter the queue and be filtered/scored/bound like any other.
- Step 4's DELETE is a graceful termination: victims see SIGTERM, run `preStop`, then SIGKILL after `terminationGracePeriodSeconds`. This can take up to 30 s (default) per victim.

### Example: a 3-node, 8 CPU each cluster

```
          CPU used by pods (priority in parens)
node-1:   ▓▓▓▓▓▓░░   p=100 x4 CPU,  p=100 x2 CPU           running 6 CPU
node-2:   ▓▓▓▓▓▓▓░   p=500 x2 CPU,  p=100 x5 CPU           running 7 CPU
node-3:   ▓▓▓▓▓▓▓▓   p=10  x2 CPU,  p=10  x2 CPU, p=10 x4  running 8 CPU

New pod: 4 CPU, p=1000
```

PostFilter is called. The scheduler considers each node:

- **node-1**: needs 4 CPU more. Evict p=100 pods first. Evicting either the 4-CPU or both the 2-CPU pods works. Minimum victim set: 1 pod (the 4-CPU one). Cost: 1 pod.
- **node-2**: needs 3 CPU. Evict p=100 (5 CPU). Cost: 1 pod.
- **node-3**: needs 4 CPU. Evict lowest priority first (p=10 across three pods). Minimum set: 2 pods. Cost: 2 pods.

Preferred: node-1 and node-2 are tied (1 pod each). Tiebreaker falls to total priority of victims evicted; node-2's p=100 = node-1's p=100, so further tiebreakers kick in (node with later creation time preferred). Eventually one is chosen.

### Cross-node preemption

If no single node has enough lower-priority victims to fit the pod, the scheduler considers evicting across multiple nodes. This is expensive and rarely the best plan — the scheduler prefers single-node eviction by a wide margin. You'd see it only when:

- Pod requires more resources than any single node can free.
- Topology constraints (pod anti-affinity) spread the feasible nodes.

---

## PodDisruptionBudget respect — "best-effort"

PDBs restrict voluntary evictions (drain, cluster autoscaler, eviction API). Preemption is **involuntary** from the PDB's perspective. The scheduler *tries* to respect PDBs:

1. Preemption sorts candidate victims to prefer those whose eviction doesn't violate any PDB.
2. If the pod cannot fit without violating a PDB, the scheduler **still proceeds** — PDB violation is not a blocker.

This asymmetry is deliberate: a cluster-admin who sets high priority on a pod is signaling "this matters more than your PDB." If you want PDBs to be binding even against preemption, you can't rely on PDBs alone; you must prevent the preemption upfront (e.g. don't grant high priority to the caller; use `ResourceQuota` scoped to PriorityClass).

To see PDB status:

```bash
kubectl get pdb -A
# NAMESPACE    NAME      MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
# prod         web-pdb   2               N/A               1                     5d

kubectl describe pdb -n prod web-pdb
```

When preemption violates a PDB, you'll see a warning event on the PDB's pods:

```
Warning  PreemptionByKubeScheduler  pod/web-3
  Preempted in order to accommodate a higher priority pod. PDB violated.
```

---

## `nominatedNodeName` — the transient state

During the preemption window, the pod has:

```yaml
status:
  phase: Pending
  nominatedNodeName: node-1
```

What this field does:

- **Visible reservation**: tells other scheduling cycles "resources on node-1 are logically reserved for this pod."
- **Preference on retry**: next scheduling attempt tries this node first.
- **Informational**: users and controllers can inspect it.

What it does NOT do:

- Does not actually reserve resources — the apiserver doesn't know.
- Does not guarantee the pod lands on node-1. If filters changed (e.g. a zone label was removed), the pod goes to another node or back Pending.
- Does not survive forever — if no progress, the scheduler eventually clears it and re-tries preemption from scratch.

### Watching it in action

```bash
kubectl get pod my-pod -o jsonpath='{.status.nominatedNodeName}'
# node-1

kubectl get events --field-selector involvedObject.name=my-pod,reason=Preempted
```

---

## The failure modes of preemption

### 1. "Preempted but still Pending"

Classic confusing scenario: pod triggers preemption, victims get killed, and yet the pod stays Pending.

Causes:

- **Another higher-priority pod beat you to it**. While your victims were terminating, a different pod with even higher priority grabbed the freed space. Yours is back in the queue.
- **Filter state changed**: a label on the target node was removed; a taint was added; a PVC got rebound; now Filter rejects it.
- **nominatedNodeName no longer fits**: the node was drained, cordoned, or ran out of some resource in the intervening time.

Diagnostic:

```bash
kubectl describe pod my-pod | sed -n '/Events:/,$p'
# look for: "pod didn't fit on nodes even after preemption"
```

Fix: relax the pod's constraints, or manually free appropriate space.

### 2. Preemption loop

Two high-priority pods with similar demands can preempt each other repeatedly:

```
t=0  Pod A preempts B, takes node-1
t=5  B is gone; but B had autoscale controller; scaled a new Pod B
t=6  Pod B preempts A (same priority, but A's start time is older → preferred victim)
t=11 A is gone; A has Deployment; scaled new Pod A
...
```

The scheduler's tiebreakers (victim start time) prevent this to some extent, but priority ties are bad. Fix: make priorities actually different.

### 3. PDB broken by preemption

A PDB you thought would protect critical workloads gets violated during a preemption burst.

Prevention:

- Do not grant high priority classes that can preempt your critical tier. Use `ResourceQuota` with `scopeSelector: priorityClass` to cap how many pods of a given priority can exist in a namespace.
- Move truly critical workloads into the `system-cluster-critical` or `system-node-critical` range where users can't preempt them.

### 4. Priority inversion with resource quota

With `ResourceQuota` scoped to a PriorityClass, a user can exhaust a low-priority quota and then be unable to create high-priority pods because the quota count includes effective priority usage across the namespace. Check quota shape before blaming preemption.

### 5. System-critical eviction by misconfiguration

An admin creates a priority class with `value=2000100000` and accidentally binds it to user workloads. Those pods can now preempt control plane daemons.

Prevention: admission controllers (ValidatingAdmissionPolicy) that reject user-created PriorityClasses with value > some threshold.

---

## Interaction with other mechanisms

### Preemption vs kubelet eviction

| Trigger                               | Component | Basis                              |
|---------------------------------------|-----------|------------------------------------|
| Scheduling can't find room            | scheduler | pod priority                       |
| Node under memory / disk pressure     | kubelet   | QoS class (BestEffort first), then resource usage |

Two completely different eviction systems. A high-priority `BestEffort` pod (unusual combo) can still be evicted by kubelet when the node is under memory pressure, despite its priority. Priority governs scheduling; QoS governs runtime eviction.

### Preemption vs node cordon

Cordoning a node (`kubectl cordon`) sets `spec.unschedulable=true`. The Filter plugin `NodeUnschedulable` rejects it for new pods. Preemption considers cordoned nodes? **No** — `NodeUnschedulable` usually returns `UnschedulableAndUnresolvable`, which skips preemption for that node.

So draining a node never triggers a wave of preemptions as a side effect.

### Preemption vs scheduling gates

`spec.schedulingGates` (on the pod) blocks entry to the active queue via the `SchedulingGates` plugin at PreEnqueue. A gated pod can't even be considered for scheduling, let alone preempting anyone. Gates must be cleared first.

---

## Exam heuristics

- If a pod is Pending and the events say `pod didn't fit on nodes even after preemption`, you're in scenario 1 above. Look at what changed between preemption and retry.
- If asked to create a high-priority workload, always specify `preemptionPolicy: Never` unless you explicitly want evictions. Surprise evictions are an anti-pattern in production.
- Use `kubectl get events -A --sort-by=.lastTimestamp | grep -i preempt` to see cluster-wide preemption activity.
- `kubectl get pods -A -o json | jq '.items[] | select(.status.nominatedNodeName) | {pod: .metadata.name, ns: .metadata.namespace, nomNode: .status.nominatedNodeName}'` shows who's mid-preemption right now.

## Mental traps

- Thinking preemption **schedules** the pod. It only clears space; the pod is still a normal scheduling candidate afterward.
- Assuming PDBs block preemption. They're best-effort; preemption can violate them.
- Confusing priority (scheduler concept) with QoS (kubelet concept). Different mechanisms, different outcomes.
- Believing `nominatedNodeName` is a reservation. It's a hint; resources can be taken by higher priority in the window.
- Using high priority to "protect" a workload. High priority protects from preemption by lower, not from anything else.
- Forgetting that preemption takes real time (up to `terminationGracePeriodSeconds` per victim). A big preemption wave has latency.
- Running untrusted workloads without `ResourceQuota` scoped to PriorityClass. One bad actor can evict every production pod by spamming high-priority requests.
