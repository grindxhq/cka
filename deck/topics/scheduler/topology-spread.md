## What topology spread is for

Topology spread constraints let you say "spread replicas across zones (or racks, or nodes) so that no topology is more crowded than any other by more than N." It is the expressive way to get balanced placement — more flexible than pod anti-affinity.

If anti-affinity is "never together," spread is "evenly distributed."

## The three fields you must know

```yaml
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: web
```

| Field               | Meaning                                                                       |
|---------------------|-------------------------------------------------------------------------------|
| `maxSkew`           | Max difference between the most-loaded topology and the least-loaded           |
| `topologyKey`       | Node label defining a "group" (zone, hostname, region, custom)                 |
| `whenUnsatisfiable` | `DoNotSchedule` (filter) or `ScheduleAnyway` (score)                           |
| `labelSelector`     | Which pods count — usually the same labels as the controller's template        |

## Reading maxSkew correctly

"Skew" = the difference between **any two** topology domains of matching pods.

Example: two zones, two pods in zone-a, one in zone-b.

- Skew = 2 - 1 = 1.
- If `maxSkew: 1`, adding one more pod to zone-a would make skew = 2, violating the constraint → filter out zone-a.
- So the next pod must go to zone-b.

With three zones (a:2, b:1, c:1) and `maxSkew: 1`:

- Max = 2, Min = 1, Skew = 1 — still within limit.
- The next pod is allowed in b or c (they become 2, skew stays 1) but filtered out of a (would become 3, skew 2).

## DoNotSchedule vs ScheduleAnyway

- `DoNotSchedule` — a filter. If every node violates the constraint, the pod goes Pending.
- `ScheduleAnyway` — a score. The scheduler still prefers balanced placement but will not reject any node.

Pick `DoNotSchedule` when skew is a correctness requirement (HA across zones). Pick `ScheduleAnyway` when you want "balanced if possible."

## topologyKey choices

| topologyKey                        | Effect                                       |
|------------------------------------|----------------------------------------------|
| `kubernetes.io/hostname`            | one bucket per node — spread pod across nodes|
| `topology.kubernetes.io/zone`      | spread pod across zones                       |
| `topology.kubernetes.io/region`    | spread pod across regions (rare in CKA)      |
| custom node labels                  | any grouping you define                       |

Crucially: if nodes do not actually have the label you name, every node falls into the same bucket (or no bucket, depending on the constraint). That usually yields Pending. Always verify:

```bash
kubectl get nodes --show-labels | grep -E "zone|region|hostname"
```

## labelSelector — who counts?

The selector determines **which existing pods** are counted into each topology bucket. It typically mirrors the pod's own labels (so replicas of the same Deployment count each other).

Gotchas:

- If you mis-label, the constraint will count pods from other workloads and misbehave.
- Only pods in the **same namespace** are counted (before the namespace selector field existed). Newer clusters support `matchLabelKeys` and `nodeTaintsPolicy` / `nodeAffinityPolicy` — out of CKA scope but worth knowing the fields exist.

## A complete Deployment example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 6
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels: { app: web }
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels: { app: web }
      containers:
        - name: web
          image: nginx
```

Two constraints stacked:

- Hard requirement: zones balanced to skew ≤ 1.
- Soft preference: nodes balanced to skew ≤ 1 when possible.

## Interaction with other constraints

- **Node selector / affinity** narrows the candidate nodes first; spread only considers those.
- **Taints / tolerations** also filter first.
- **Pod anti-affinity** combined with spread can lead to unschedulable scenarios — anti-affinity says "not same node," spread says "must be balanced across zones." On a 3-node cluster with 2 zones, achieving both may be impossible for 6 replicas.
- **Cluster autoscaler** understands spread and will add nodes to satisfy constraints. Not in exam scope but worth knowing.

## Debugging

```bash
kubectl describe pod <name> | grep -A 20 Events
```

Typical messages:

- `didn't match pod topology spread constraints` → the exact constraint was violated.
- `no matching topology for constraint` → no node has the `topologyKey` label.

Check topology labels:

```bash
kubectl get nodes -L topology.kubernetes.io/zone,topology.kubernetes.io/region
```

## Fast fixes

- Relax `DoNotSchedule` → `ScheduleAnyway` to unblock.
- Increase `maxSkew` to a number the cluster can satisfy.
- Label nodes with the expected topology keys.
- Reduce replicas to a number that can fit the constraints.

## Exam heuristics

- If the prompt says "spread across zones, at most N difference," this is the tool.
- If the prompt says "exactly one per node," use `podAntiAffinity` with `topologyKey: kubernetes.io/hostname` — it is a cleaner expression than spread.
- Use `DoNotSchedule` only when HA correctness demands it; otherwise `ScheduleAnyway` keeps you unstuck.

## Mental traps

- Thinking `maxSkew=0` means "perfect balance." It means every bucket must have exactly the same count, which is usually unachievable and pins pods Pending.
- Forgetting that `labelSelector` decides which pods count, not which pods this constraint applies to.
- Using a `topologyKey` that only some nodes have. The "no matching topology" case produces confusing Pending reasons.
- Mixing spread with tight anti-affinity on small clusters. The feasible set can become empty.
- Assuming spread rebalances after the fact. It does not — existing placements are `IgnoredDuringExecution`.
