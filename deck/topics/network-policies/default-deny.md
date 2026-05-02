## The zero-trust starting point

A fresh Kubernetes namespace has **no** network restrictions. Any pod can send traffic anywhere. Any pod can receive from anywhere. For lab work this is convenient; for anything production-adjacent it's a security gap.

The zero-trust pattern: block all traffic by default, then explicitly allow what's needed. Achieved with two or three foundational policies per namespace.

```
 Step 1: default-deny-all  (deny every pod, both directions)
 Step 2: allow-dns          (otherwise DNS breaks)
 Step 3: app-specific allows (build up your real allow-list)
```

This note walks each.

---

## Step 1: deny everything

Two approaches: one policy covering both directions, or two separate policies.

### Single combined policy

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: ns-a
spec:
  podSelector: {}                    # select every pod in the namespace
  policyTypes:
    - Ingress
    - Egress
  # no ingress or egress rules at all → deny
```

`podSelector: {}` matches everything. `policyTypes` declares isolation for both directions. No `ingress` or `egress` blocks means no allow rules, and since the pod is now isolated, nothing is permitted.

### Separate policies (clearer for partial deny)

```yaml
# ingress deny
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: ns-a
spec:
  podSelector: {}
  policyTypes: [Ingress]
```

```yaml
# egress deny
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
  namespace: ns-a
spec:
  podSelector: {}
  policyTypes: [Egress]
```

Equivalent effect. Two policies are handy if you later want to keep one direction isolated while permitting the other (e.g. deny ingress globally, allow egress for everything).

---

## What "deny everything" actually does

Applied in isolation, pods can't:

- Talk to each other (even in the same namespace).
- Talk to the apiserver (API calls fail).
- Resolve DNS names (CoreDNS unreachable).
- Reach external URLs.
- Receive any incoming traffic.

Things that **still work**:

- Kubelet health probes (they originate on the node, and node-local traffic is always permitted).
- Kubelet can still run the pod, restart it, log it.
- `kubectl exec` (which goes through kubelet, not through the pod network).

So a pod with only `default-deny` has working probes and exec but otherwise looks dead to the cluster.

---

## Step 2: allow DNS

Anything that does a name lookup needs CoreDNS. Add an egress allow for DNS:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: ns-a
spec:
  podSelector: {}                    # all pods in this namespace
  policyTypes: [Egress]
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
```

Two things worth noting:

- `kubernetes.io/metadata.name` is an **automatic label** on every namespace, set to the namespace's own name. Always present, always correct.
- Include both UDP and TCP 53. DNS is UDP by default but large responses retry via TCP; EDNS0 pushes limits.

Without this, `curl example.com` from a policy-isolated pod hangs forever on DNS. Tests time out and look random until you realize DNS was blocked.

### Tightening DNS

If you want only specific pods to resolve DNS, replace `podSelector: {}` with a more specific selector or namespace-selector pair. But in most production clusters, "all pods can resolve DNS" is the default because app failures from DNS blocks are annoying to diagnose.

---

## Step 3: workload-specific allows

Now add policies that explicitly permit required traffic. Typical web-app 3-tier example:

```yaml
# Tier labels: tier: frontend, tier: api, tier: db

---
# frontend → api
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: frontend-to-api
  namespace: ns-a
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
    ports:
    - { protocol: TCP, port: 8080 }

---
# api → db
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-to-db
  namespace: ns-a
spec:
  podSelector:
    matchLabels:
      tier: db
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector:
        matchLabels:
          tier: api
    ports:
    - { protocol: TCP, port: 5432 }
```

And the matching egress policies:

```yaml
# frontend's egress
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: frontend-egress
  namespace: ns-a
spec:
  podSelector:
    matchLabels:
      tier: frontend
  policyTypes: [Egress]
  egress:
  # DNS — redundant if allow-dns covers all pods, but explicit is clearer
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - { protocol: UDP, port: 53 }
  # to API tier
  - to:
    - podSelector:
        matchLabels:
          tier: api
    ports:
    - { protocol: TCP, port: 8080 }

---
# api's egress
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-egress
  namespace: ns-a
spec:
  podSelector:
    matchLabels:
      tier: api
  policyTypes: [Egress]
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - { protocol: UDP, port: 53 }
  - to:
    - podSelector:
        matchLabels:
          tier: db
    ports:
    - { protocol: TCP, port: 5432 }
```

---

## The trade: DB doesn't need egress

Notice we did **not** write egress rules for `tier: db`. It never initiates outbound connections — clients connect to it. With `default-deny-egress` in force, the DB pod **cannot connect out**, which is fine and arguably desirable (limits exfil).

But it also means the DB can't resolve DNS or reach external services. If you ever need the DB to pull from a backup store or send metrics out, you need to add egress rules. Most of the time, "DB has no egress" is a feature.

---

## Allow-all patterns (sometimes useful)

Occasionally you want to explicitly allow all traffic for a namespace, either to override a cluster-wide deny, or to document intent:

### Allow all ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-all-ingress
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
  - {}                              # empty rule = allow all
```

### Allow all egress

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-all-egress
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
  - {}                              # empty rule = allow all
```

The empty `{}` means "no selector and no port restriction" — everything is allowed. Rare to need these, but they exist for completeness.

---

## Common default-deny mistakes

### 1. Forgetting DNS

Symptoms: `nslookup` times out, `curl <name>` hangs. Always allow DNS.

### 2. Deny-all-ingress on kube-system

Applying a broad default-deny policy to `kube-system` can break CoreDNS, metrics-server, etc. **Don't apply cluster-wide policies to kube-system.** Limit deny policies to app namespaces.

### 3. Selecting a namespace by `namespace` field instead of label

Writing `namespaceSelector` without realizing you need the label match:

```yaml
# WRONG — no such 'name:' label exists automatically
namespaceSelector:
  matchLabels:
    name: kube-system

# RIGHT — the automatic label
namespaceSelector:
  matchLabels:
    kubernetes.io/metadata.name: kube-system
```

Since Kubernetes 1.22, the automatic label `kubernetes.io/metadata.name` is always present. Older clusters and docs may say "label your namespace with `name: <ns>`"; on modern clusters, use the automatic label.

### 4. Assuming inbound policy auto-allows reply

Reply traffic is allowed automatically. But if you forget that, you might write an ingress policy AND an egress policy for the reply direction of a TCP connection — unnecessary, but harmless. The common failure is forgetting **new** outbound connections' egress.

### 5. Not closing the edge

A default-deny in ns-a blocks traffic within ns-a. But if a pod in ns-b can freely reach ns-a, pod-in-a needs an ingress policy to block that. Default-deny-ingress does that.

---

## Rollout strategy for default-deny

Applying default-deny to a busy namespace is a significant change. Phase it:

1. **Inventory** what connections pods actually make. Tools:
   - `kubectl logs coredns` with log plugin — see every DNS query.
   - `tcpdump` on some pods for a day.
   - Cilium Hubble or Calico flow logs for richer visibility.

2. **Write specific allow policies** for those connections.

3. **Apply the allow policies first**, observe for an hour.

4. **Then apply default-deny**. If something breaks, check which pod is denied and whether it needs a new allow rule.

5. **Iterate.** It's normal to discover 1–2 missed paths after deny goes live.

Rushing default-deny is how you cause outages. Most teams have a "broken apps by default-deny" war story.

---

## Complete bootstrap template

For a new namespace `ns-a`:

```yaml
---
# Deny all ingress AND egress
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: ns-a
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress

---
# Allow DNS for every pod
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: ns-a
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }
```

After this, the namespace is fully locked down except DNS. Add workload-specific allow policies from here.

---

## Tenant isolation — one step beyond

For multi-tenant clusters, you want **every namespace** to default-deny and explicitly permit only its own traffic. A cluster-wide "deny cross-namespace" policy doesn't exist (policies are namespace-scoped), but you can achieve the same thing by:

- Making default-deny standard in every tenant namespace.
- Only using `namespaceSelector` + specific labels for cross-namespace access, never wildcards.

Policy-engine tools (Calico's `GlobalNetworkPolicy`, Cilium's `CiliumClusterwideNetworkPolicy`) offer cluster-scoped policies for true cluster-wide rules, but that's CNI-specific, not standard NetworkPolicy.

---

## Exam heuristics

- Exam scenarios often ask to "isolate this namespace" or "isolate this pod from all ingress." The default-deny pattern is the answer.
- Always include the DNS allow when asked for egress policies. Exam may not spell it out, but it's usually expected.
- Use `kubernetes.io/metadata.name` to select a namespace by name. Memorize this label.
- `podSelector: {}` = all pods in the namespace. `policyTypes: [Ingress]` + no `ingress:` block = full deny.
- Don't apply policies to `kube-system` unless the exam explicitly asks — you can break everything.

## Mental traps

- Omitting `policyTypes` when you want deny-all-egress. The default inference doesn't do what you expect.
- Using `namespaceSelector: {}` thinking it means "same namespace." It means "every namespace." To match "only my namespace," use `podSelector` (not namespaceSelector at all).
- Forgetting that reply traffic is auto-allowed, and writing unnecessary ingress rules for response packets. Clutters the policy.
- Applying default-deny cluster-wide with no plan. Fine-grained allow policies come first; deny wraps them.
- Relying on old docs that say `name:` label instead of `kubernetes.io/metadata.name`.
- Assuming `default-deny-all` blocks localhost. It doesn't — pod-local loopback (127.0.0.1) is always open.
