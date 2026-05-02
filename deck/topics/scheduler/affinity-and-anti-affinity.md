## The three flavors

- **nodeAffinity** — attract pods to nodes with matching labels.
- **podAffinity** — attract pods to nodes where a matching pod already runs.
- **podAntiAffinity** — repel pods from nodes where a matching pod already runs.

All three come in two strengths:

- `requiredDuringSchedulingIgnoredDuringExecution` — a filter. If no node satisfies it, the pod goes Pending.
- `preferredDuringSchedulingIgnoredDuringExecution` — a score bump. Never causes Pending on its own.

The awkward suffix `IgnoredDuringExecution` is the honest warning: once placed, the pod is not moved even if the constraint stops being satisfied later.

## nodeSelector vs nodeAffinity

`nodeSelector` is the old, simple version — a flat map of equality rules:

```yaml
spec:
  nodeSelector:
    disktype: ssd
    zone: us-east-1a
```

`nodeAffinity` is the expressive version: multiple clauses, `In/NotIn/Exists/Gt/Lt` operators, `preferred` weights.

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: disktype
                operator: In
                values: ["ssd"]
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 50
          preference:
            matchExpressions:
              - key: zone
                operator: In
                values: ["us-east-1a"]
```

Semantics worth memorizing:

- `nodeSelectorTerms` is **OR** between terms.
- `matchExpressions` inside a term is **AND**.
- `nodeSelector` AND `nodeAffinity.required` — both must match.

That "OR between terms" rule catches people — multiple `nodeSelectorTerms` entries widen the match set, they don't narrow it.

## Operators

| Operator | Meaning                                       | Needs values? |
|----------|-----------------------------------------------|---------------|
| In       | label value is in the list                     | yes           |
| NotIn    | label value is not in the list                 | yes           |
| Exists   | key exists (any value)                         | no            |
| DoesNotExist | key does not exist                         | no            |
| Gt       | numeric greater-than (node affinity only)      | yes (one)     |
| Lt       | numeric less-than (node affinity only)         | yes (one)     |

`Gt` / `Lt` do not exist for pod affinity.

## podAffinity / podAntiAffinity

```yaml
spec:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: web
          topologyKey: kubernetes.io/hostname
```

This says: do not schedule me onto a node where another pod with `app=web` is already running.

Essential fields:

- **`labelSelector`** — which pods are we talking about?
- **`namespaces`** / **`namespaceSelector`** — which namespaces to search (default: pod's own namespace).
- **`topologyKey`** — which node label defines a "zone" for the rule.

`topologyKey` is the most commonly misunderstood field. Examples:

| topologyKey                        | Meaning                                    |
|------------------------------------|--------------------------------------------|
| `kubernetes.io/hostname`            | "same node" — one pod per node             |
| `topology.kubernetes.io/zone`      | "same zone" — spread across zones          |
| `topology.kubernetes.io/region`    | "same region"                              |
| custom label you apply to nodes    | any grouping you define                     |

If nodes don't have the label `topologyKey` names, the rule simply cannot be satisfied and pods go Pending.

## Required vs Preferred — when to use which

- `required` = hard constraint. Use when "wrong place" means the workload is broken (e.g. GPU-only pod on CPU-only node).
- `preferred` = soft preference. Use when "wrong place" is just suboptimal (e.g. prefer co-locating cache with consumer, but OK to split).

Two common patterns:

- **Pod anti-affinity required, hostname topology** — "one replica per node." Classic HA pattern.
- **Pod anti-affinity preferred, zone topology** — "spread across zones if possible, but still schedule if not."

## Debugging affinity-caused Pending

```bash
kubectl describe pod <name> | sed -n '/Events:/,$p'
```

Look for:

- `didn't match Pod's node affinity/selector` → node labels don't match.
- `didn't satisfy existing pods anti-affinity rules` → another pod blocks this one.
- `didn't match Pod's topologyKey value` → no node has the required topology label.

Inspect the relevant labels:

```bash
# Node labels
kubectl get nodes --show-labels

# Pods that match the affinity selector
kubectl get pods -A -l <selector> -o wide

# The rules themselves
kubectl get pod <name> -o yaml | grep -A 40 affinity
```

If the rule is too tight, relax it to `preferred` or change the `topologyKey`.

## Interaction with taints / tolerations

Affinity filters nodes by label match. Taints filter nodes by toleration match. **Both** must pass. An affinity-matching node with an untolerated taint still gets rejected. Read the event message carefully — it lists each reason separately.

## Interaction with topology spread

Pod anti-affinity hostname = "max 1 per node." Topology spread `maxSkew=1` achieves similar shapes but is more flexible — it enforces a *delta* between zones, not an absolute count. If both are used together, both must be satisfied; the result can be surprisingly tight.

## Fast recipes

**Spread a Deployment across nodes (max one per node):**

```yaml
spec:
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: web
              topologyKey: kubernetes.io/hostname
```

**Only on SSD nodes:**

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: disktype
                operator: In
                values: ["ssd"]
```

**Co-locate with cache pods:**

```yaml
spec:
  affinity:
    podAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                app: cache
            topologyKey: kubernetes.io/hostname
```

## Exam heuristics

- The exam often phrases it as "schedule this pod onto nodes with label X". Use `nodeSelector` when possible — less YAML, less wrong.
- When asked to "ensure replicas are spread," pick between `podAntiAffinity required` (strict one-per-node) and `topologySpreadConstraints` (softer, maxSkew-based). If the prompt says "at most one per node," use anti-affinity.
- Check the namespace field on pod affinity. Rules default to the pod's own namespace — not usually what you want across a whole cluster.

## Mental traps

- Writing `nodeSelectorTerms` as a list and assuming it's AND — it is **OR**.
- Setting a `topologyKey` that no node has labeled. Looks like a bug; is a silent mismatch.
- Expecting affinity to move existing pods. It never does.
- Using `preferred` and expecting Pending when the preference fails. It never does.
- Mixing pod-affinity with namespace boundaries: by default it only looks in **this** pod's namespace, not cluster-wide.
- Forgetting that heavy pod-affinity rules are expensive at scale — the scheduler has to search labels across all pods. In CKA scope this is never the issue, but keep in mind for real clusters.
