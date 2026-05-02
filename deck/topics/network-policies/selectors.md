## Why selectors are worth their own subtopic

NetworkPolicy selectors look simple — `podSelector` and `namespaceSelector`. In practice, their combination semantics cause more misconfigured policies than any other single thing. The difference between "AND" and "OR" hides in indentation.

A policy that intends to allow "frontend pods in the prod namespace" but instead allows "any frontend OR any pod in prod" is a real, common mistake. This note untangles the rules.

---

## The four selector types

A `from` or `to` entry in a rule can contain one or more of:

| Selector              | Targets                                       |
|-----------------------|-----------------------------------------------|
| `podSelector`         | Pods with matching labels                     |
| `namespaceSelector`   | Namespaces with matching labels              |
| `ipBlock`             | IP CIDR (for external or pod-network IPs)    |
| nothing (empty entry) | All sources / all destinations                |

You combine them with indentation rules that determine AND vs OR semantics. Get these wrong and your policy is too permissive or too strict.

---

## podSelector — "pods with these labels, in my namespace"

The default scope of `podSelector` is **the namespace this policy lives in**:

```yaml
# Policy in ns-a
ingress:
- from:
  - podSelector:
      matchLabels:
        tier: frontend
```

Means: allow from pods labeled `tier: frontend` in **ns-a** (same namespace as the policy). Pods in other namespaces with the same label are NOT permitted by this rule.

### Empty pod selector = all pods in the namespace

```yaml
- from:
  - podSelector: {}
```

Every pod in the policy's namespace. Use case: "allow any pod in my namespace to reach this."

---

## namespaceSelector — "all pods in matching namespaces"

```yaml
- from:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: prod
```

Means: allow from **every pod** in namespaces labeled with `kubernetes.io/metadata.name: prod` (i.e., the namespace named `prod`).

- Matches all pods; doesn't filter by pod label.
- A pod in the target namespace, any labels, is allowed.

### Empty namespace selector = all namespaces

```yaml
- from:
  - namespaceSelector: {}
```

**Every pod in every namespace** — essentially "all pods in the cluster." A big allow-list. Only use this when you really mean it.

---

## The AND-vs-OR trap

This is the bit that burns people. When both `podSelector` and `namespaceSelector` appear, placement matters:

### Same-entry AND

```yaml
- from:
  - podSelector:
      matchLabels:
        tier: frontend
    namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: prod
```

This is **one** entry with two selectors. The meaning is AND:

> Pods with `tier: frontend` in namespaces labeled `kubernetes.io/metadata.name=prod`.

Indentation: both selectors are children of the same list item (same dash).

### Separate-entry OR

```yaml
- from:
  - podSelector:
      matchLabels:
        tier: frontend
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: prod
```

This is **two** entries, each with one selector. The meaning is OR:

> Pods with `tier: frontend` (in this namespace) OR any pod in namespaces labeled prod.

Indentation: two list items, two dashes.

### The YAML that differs by one dash

```yaml
# AND: prod's frontend pods only
from:
- podSelector: { matchLabels: { tier: frontend } }
  namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: prod } }

# OR: frontend pods anywhere OR everyone in prod
from:
- podSelector: { matchLabels: { tier: frontend } }
- namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: prod } }
```

The only visual difference is one extra `-`. The security impact is substantial.

**Rule of thumb**: if you want "pods X in namespace Y," put both selectors **under the same dash**.

---

## ipBlock — for external IPs and specific CIDRs

```yaml
- to:
  - ipBlock:
      cidr: 10.0.0.0/24
      except:
      - 10.0.0.1
      - 10.0.0.50
```

- `cidr` — the allow range.
- `except` (optional) — IPs or smaller CIDRs within `cidr` to exclude.

Used for:

- Allowing egress to external services by IP range.
- Blocking the AWS metadata service (`169.254.169.254`).
- Excluding a specific cluster IP range from a wildcard.

### Important quirks

- `ipBlock` applies to raw IPs. It doesn't care whether the IP is a Service ClusterIP, a pod IP, or an external IP.
- **Pod IPs** — since pod IPs are from the pod CIDR (say `10.244.0.0/16`), an `ipBlock` with that CIDR is one way to match all pods. Selecting via `podSelector` is usually clearer.
- **Service ClusterIPs** are in the service CIDR (`10.96.0.0/12`). But traffic to a Service ClusterIP is DNATed by kube-proxy **before** it reaches the destination pod's netfilter. Policy enforcement sees the pod IP, not the Service IP. So `ipBlock` matching the Service CIDR usually doesn't do what people expect.
- `ipBlock` can't be combined with `podSelector` or `namespaceSelector` in the same entry — must be its own entry.

### The metadata-service block pattern

On AWS, pods should not reach the node metadata service (`169.254.169.254`) except when specifically authorized — it leaks credentials.

```yaml
- to:
  - ipBlock:
      cidr: 0.0.0.0/0
      except:
      - 169.254.169.254/32
  ports:
  - protocol: TCP
    port: 443
```

Now pods can reach any external HTTPS except the metadata service.

---

## Combining selectors in a single rule

A rule has:

```yaml
- from:             # or `to:`
  - <entry 1>
  - <entry 2>
  - <entry 3>
  ports:
  - <port 1>
  - <port 2>
```

Entries in `from`/`to` are OR. Ports in `ports` are OR. Then the two are AND:

```
allowed(src, port) = (src ∈ entries) AND (port ∈ ports)
```

So:

```yaml
- from:
  - podSelector: { matchLabels: { tier: frontend } }
  - podSelector: { matchLabels: { tier: admin } }
  ports:
  - { port: 8080 }
  - { port: 9090 }
```

Allowed:

- frontend pods on 8080 ✅
- frontend pods on 9090 ✅
- admin pods on 8080 ✅
- admin pods on 9090 ✅
- frontend or admin on port 80 ❌
- backend pods on 8080 ❌

---

## Multiple rules — OR across rules

```yaml
ingress:
- from:
  - podSelector: { matchLabels: { tier: frontend } }
  ports:
  - { port: 8080 }
- from:
  - podSelector: { matchLabels: { tier: admin } }
  ports:
  - { port: 22 }
```

Rule 1 allows frontend on 8080.
Rule 2 allows admin on 22.

Allowed = (frontend on 8080) OR (admin on 22). No cross-product — admin on 8080 is denied.

Use multiple rules when the **(from, ports)** pairing varies per source.

---

## matchExpressions — richer selectors

Beyond `matchLabels`, you can use `matchExpressions`:

```yaml
podSelector:
  matchExpressions:
  - key: tier
    operator: In
    values: [frontend, admin]
  - key: canary
    operator: NotIn
    values: ["true"]
  - key: phase
    operator: Exists
```

Operators:

- `In` — label value is in the list.
- `NotIn` — label value is not in the list.
- `Exists` — label key is present (any value).
- `DoesNotExist` — label key is absent.

Multiple expressions within a `matchExpressions` block are AND-ed. Useful for "tier is frontend or admin, but not canary":

```yaml
matchExpressions:
- { key: tier, operator: In, values: [frontend, admin] }
- { key: canary, operator: DoesNotExist }
```

---

## The "same namespace" idiom

A common need: "allow all pods in the same namespace as the target pod." Two ways:

### Empty pod selector (just in my namespace)

```yaml
- from:
  - podSelector: {}
```

`podSelector: {}` scopes to the policy's namespace (which is the same as the target pod's). Allows every pod in this namespace.

### Explicit namespace selector (identity)

```yaml
- from:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: <my-ns-name>
```

More verbose, but explicit. Useful when the policy is generated by tooling that fills in the name.

---

## Cross-namespace: "allow from prod's frontend pods"

Common scenario: tier `api` in namespace `app` wants to allow ingress from tier `frontend` in namespace `prod`.

Policy in `app` namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-prod-frontend
  namespace: app
spec:
  podSelector:
    matchLabels:
      tier: api
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector:
        matchLabels:
          tier: frontend
      namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: prod
    ports:
    - { protocol: TCP, port: 8080 }
```

Note the two selectors under one dash → AND. Allows pods matching both conditions.

Misreading this as OR would allow frontend pods **anywhere** and any pod in prod — much bigger blast radius.

---

## Rule of thumb for writing selectors

- **"Allow pods X from any namespace"** → one entry, just `podSelector` (but note: by default podSelector is same-namespace-only; for cross-namespace you must add a namespaceSelector — even `namespaceSelector: {}` to mean "all namespaces").
- **"Allow any pod from namespace Y"** → one entry, just `namespaceSelector`.
- **"Allow pods X from namespace Y"** → one entry with both `podSelector` **and** `namespaceSelector` under the same dash.
- **"Allow pods X OR any pod from namespace Y"** → two entries (two dashes).
- **"Allow from CIDR Z"** → one entry with just `ipBlock`.

Write it down, double-check indentation, apply, test.

---

## Testing selectors with labels

To verify a policy targets the right pods:

```bash
# Which pods match the policy's own podSelector?
kubectl get pods -n <policy-ns> -l <selector>

# Which namespaces match a namespaceSelector?
kubectl get ns -l <selector>

# Combine: which pods in which namespaces?
kubectl get pods -A -l <selector>
```

The policy YAML uses the same selector syntax as kubectl's `-l` flag, so pasting the `matchLabels` into `-l` (comma-separated) gives you exactly the set the policy would match.

---

## Common mistakes with selectors

### Empty podSelector when you meant all namespaces

```yaml
# Possibly wrong: this allows only same-namespace "any pod"
- from:
  - podSelector: {}

# Usually what you want: any pod, any namespace
- from:
  - namespaceSelector: {}
```

### namespaceSelector with label name= (old style)

```yaml
# Only works if you manually labeled the namespace `name: <ns>`
- from:
  - namespaceSelector:
      matchLabels:
        name: kube-system

# Modern (1.22+) — always works
- from:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: kube-system
```

### AND vs OR mismatch

```yaml
# You intended: pods in prod with tier=frontend
# You wrote: any frontend, or any pod in prod
- from:
  - podSelector: { matchLabels: { tier: frontend } }
  - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: prod } }
```

### ipBlock with Service ClusterIP expecting to match the Service

Traffic to a Service is DNATed before policy check. `ipBlock` with `10.96.0.50/32` almost never matches — by the time policy runs, the IP has changed to the pod's.

### namespaceSelector in same entry as podSelector but under different dashes

Two dashes = two entries = OR. Common copy-paste error.

---

## Exam heuristics

- When asked to allow from "pods X in namespace Y," remember: **both selectors under the same dash**.
- Use `kubernetes.io/metadata.name` for selecting a namespace by name. Don't rely on manually-added labels.
- `namespaceSelector: {}` = all namespaces. `podSelector: {}` = all pods in this namespace. Different scopes.
- For external CIDRs, use `ipBlock`. You can add `except` for carve-outs.
- Prefer multiple simple policies over one complex policy — easier to reason about.

## Mental traps

- AND vs OR from indentation. The classic NetworkPolicy bug.
- Expecting `podSelector` alone to match pods across namespaces. It doesn't — pod selectors are scoped to the same namespace as the policy. Add `namespaceSelector` to go cross-namespace.
- `namespaceSelector: {}` is not "any one namespace" — it's every namespace in the cluster. Extremely permissive.
- ipBlock on Service IPs. DNAT happens first; you'll be matching pod IPs.
- Forgetting that `ipBlock` and pod/namespace selectors can't combine in one entry. They must be separate entries (→ OR).
- Using `matchLabels` when the label value has special characters; sometimes `matchExpressions` is safer.
- Empty `from: []` (note the square brackets) → no sources allowed. Different from `from:` (not specified → inheritance from policyTypes).
