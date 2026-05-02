## What kube-scheduler actually does

The scheduler has exactly one job: for each unscheduled pod (`spec.nodeName == ""`), pick a node and bind the pod to it. That is it.

It does **not**:

- create pods (controllers do)
- start containers (kubelet does)
- migrate running pods (no component does — reschedule = new pod)
- care about live CPU/memory usage (it looks at **requests**, not usage)

Everything else you think the scheduler does is actually a controller or kubelet behavior.

## The pipeline in one picture

```
   [ unscheduled Pod ]
            │
            ▼
  ┌──────────────────┐
  │ Scheduling queue │   priority ordered
  └──────────────────┘
            │
            ▼
  ┌──────────────────┐
  │     FILTER       │   eliminate nodes that cannot run this pod
  │   (Predicates)   │
  └──────────────────┘
            │
            ▼
  ┌──────────────────┐
  │     SCORE        │   rank the remaining nodes
  │   (Priorities)   │
  └──────────────────┘
            │
            ▼
  ┌──────────────────┐
  │     BIND         │   PATCH pod.spec.nodeName = winner
  └──────────────────┘
```

If the filter phase leaves **zero** nodes, the pod stays Pending with a `FailedScheduling` event. If it leaves more than zero, scoring picks the best one and the pod is bound. Binding is a single API write; everything after that is kubelet's problem.

## What filter considers

Any of these can eliminate a node:

- Insufficient **requested** CPU / memory / ephemeral-storage / GPU / extended resources
- Pod's `nodeSelector` or `nodeName` does not match
- Pod's **node affinity** `required` rules do not match
- Node has a **taint** the pod does not tolerate
- Pod's **pod affinity / anti-affinity** `required` rules are violated
- **Topology spread** `DoNotSchedule` constraints would be violated
- PVC has a volume already attached to another node (for RWO volumes)
- `volume node affinity` (from the PV) does not match

The ordering varies by scheduler plugin, but the effect is the same: if any filter rejects the node, it is out.

## What score considers

Only remaining nodes get scored. Scoring adds up factors like:

- **LeastAllocated** or **MostAllocated** on CPU/mem (default favors spreading)
- **BalancedAllocation** (prefer nodes where CPU and memory pressure are balanced)
- **InterPodAffinity** preferred rules
- **TaintToleration** preferred weights
- **ImageLocality** (prefer nodes that already have the image)
- **NodeAffinity** preferred weights
- Topology spread "preferred" (`ScheduleAnyway`)

Score is a single 0–100 number per plugin, weighted and summed. The top scorer wins; ties are broken randomly.

## The scheduling queue

New / updated pods enter the **active** queue. Pods that failed to schedule go into a **backoff** queue and eventually an **unschedulable** queue. Events on cluster state (a node joins, a pod is deleted, a taint is removed) can re-queue pods from "unschedulable" back to "active." That is why pods sometimes suddenly schedule without you doing anything.

Implication for debugging: if a pod is Pending and you fix the cause, you may need to wait a few seconds for the scheduler to re-evaluate. If it takes too long, deleting and re-creating the pod is a legit reset.

## What the scheduler does **not** guarantee

- It does not guarantee the pod will **stay** on that node. A node can go NotReady, a pod can be evicted, a node can be drained. The scheduler just picks; eviction and rescheduling produce a new pod.
- It does not guarantee **balanced** cluster usage over time. It makes the best decision with current state only.
- It does not reschedule pods when the cluster changes. A pod running on a 90% full node stays there even if an empty node appears later.
- It does not look at **actual usage**. A node with high real CPU load but low requests is still a good candidate.

## Where the scheduler runs

On kubeadm clusters, it is a static pod:

```
/etc/kubernetes/manifests/kube-scheduler.yaml
```

Leader elects across control plane replicas. Losing the scheduler means **new pods stay Pending** but everything already running is fine. You often see this during a botched control plane upgrade.

## Key logs and signals

```bash
# Static pod logs
crictl ps -a | grep kube-scheduler
crictl logs <id>

# Event for a specific pod
kubectl describe pod <name> | grep -A 20 Events

# Cluster-wide pending
kubectl get pods -A --field-selector=status.phase=Pending
```

## Mental model shortcuts

- **Filter first, then score.** Pending = filter eliminated every node.
- The scheduler reads **requests**, not usage. Real memory pressure is an eviction problem, not a scheduling problem.
- A pod without a node is the scheduler's problem. A pod with a node that is not starting is kubelet's problem. This boundary is where most confusion lives.
- Affinity / taints / topology spread are all additional filters. They narrow the feasible set.
- If a node was feasible yesterday and is not today, something on the node changed: taint added, capacity changed, node labels removed.

## Exam heuristics

- When a pod is Pending, **read the events first**. The scheduler writes a precise reason.
- If events are silent, the problem is before the scheduler — the pod may not be in the queue (e.g. admission rejected it, or the controller that creates it is broken).
- Don't trust `kubectl get nodes` alone — check taints and labels with `kubectl describe node <name>`.
- If you edit a pod spec to change scheduling constraints, remember: `spec.nodeName` cannot be cleared on an existing pod. You usually need to delete and recreate (or use a parent controller).
