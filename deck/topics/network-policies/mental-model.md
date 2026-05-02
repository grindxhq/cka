## What NetworkPolicy is

NetworkPolicy is the **declarative firewall** for pod traffic. You describe "who can talk to whom on which ports" as Kubernetes objects; the CNI installs kernel-level rules (iptables, eBPF, nftables) that enforce it.

Key properties — all of which surprise people:

1. **Kubernetes itself does not enforce NetworkPolicy.** The API accepts and stores the object; a CNI plugin that implements the NetworkPolicy spec has to do the actual enforcement.
2. **Policies are additive.** Multiple policies selecting the same pod combine via union — "allowed if ANY policy permits it."
3. **Pods are non-isolated by default.** Zero policies = traffic flows freely.
4. **Once a pod is selected by a policy of a given direction, the pod is isolated in that direction.** Anything not explicitly allowed is denied.
5. **Policies are namespace-scoped.** A policy in `ns-a` can only select pods in `ns-a`. To restrict across namespaces, you use `namespaceSelector`.
6. **Reply traffic is always allowed.** You write policy in one direction; responses go back automatically.
7. **NetworkPolicy is L3/L4 only.** No paths, no headers, no TLS SNI. For L7 rules, need a service mesh or Cilium's CiliumNetworkPolicy.

That's the whole mental model. Everything else is decorations.

---

## Who enforces? (The CNI question)

When you `kubectl apply -f policy.yaml`:

- Apiserver accepts the object.
- apiserver stores it in etcd.
- **CNI-specific agents** watch the NetworkPolicy API (via informers) and program each node's packet-filtering layer.

Without a CNI that implements NetworkPolicy, the resource has no effect — traffic flows as if the policy didn't exist. This is **silent**; no error, no warning.

Common CNIs:

| CNI         | NetworkPolicy support       |
|-------------|-----------------------------|
| Calico      | ✅ Full, iptables / eBPF    |
| Cilium      | ✅ Full, eBPF-native        |
| Antrea      | ✅ Full, OVS                 |
| Weave       | ✅ Full (older, slower)      |
| kube-router | ✅ Full                      |
| Flannel     | ❌ **No** (often paired with Calico policies) |
| kubenet     | ❌ No                        |

Check what's installed:

```bash
ls /etc/cni/net.d/
kubectl get pods -n kube-system | grep -E 'calico|cilium|flannel|weave|antrea'
```

If you see Flannel alone, you need to add Calico (or similar) to get policy enforcement. The combination `flannel + calico-policy-only` is a common production setup.

---

## The three dimensions of a policy

Every policy specifies three things:

### 1. Which pods does it apply to?

```yaml
spec:
  podSelector:
    matchLabels:
      tier: api
```

Pods with label `tier: api` in the **same namespace** as this policy. An empty `podSelector: {}` selects every pod in the namespace.

### 2. Which directions does it govern?

```yaml
spec:
  policyTypes:
    - Ingress
    - Egress
```

Policies can regulate incoming traffic, outgoing traffic, or both. If omitted, Kubernetes infers from which rule blocks exist:

- If only `ingress:` is specified → `policyTypes: [Ingress]`.
- If `egress:` is specified → `policyTypes: [Ingress, Egress]` (yes, both — gotcha; always make it explicit).

Best practice: always set `policyTypes` explicitly.

### 3. What's allowed?

```yaml
spec:
  ingress:
  - from:
    - podSelector:
        matchLabels:
          tier: frontend
    ports:
    - protocol: TCP
      port: 8080
```

One or more allow rules. Each rule has `from`/`to` + optional `ports`. No "deny" rules exist — you describe only what's permitted.

---

## The isolation trigger

This is the most load-bearing concept:

**A pod is "isolated" for a direction as soon as ANY NetworkPolicy selects it with that direction in `policyTypes`.**

Before any policy: all traffic allowed (no restrictions).

After one policy that selects the pod for Ingress: only traffic matching the policy's `ingress` rules is permitted; everything else is denied.

Add a second policy that also selects the pod for Ingress: allowed traffic = Policy1's rules ∪ Policy2's rules.

### Default-allow until policy

```
 No policy
     │
     ▼
 Pod accepts any traffic (non-isolated for ingress)
 Pod sends any traffic (non-isolated for egress)


 Apply: NetworkPolicy with podSelector matching this pod, policyTypes: [Ingress]
     │
     ▼
 Pod is now ISOLATED for Ingress
 Only traffic matching the policy's ingress rules is accepted
 Egress is still fully open (not isolated)


 Apply: second NetworkPolicy on same pod, policyTypes: [Egress]
     │
     ▼
 Pod is now ISOLATED for Egress too
 Only egress matching the second policy is allowed
```

The isolation flip happens per-pod per-direction. Each direction is tracked separately.

---

## How multiple policies combine

Three layers of combination:

```
 Cluster-level: all policies that select the pod
                       │
                       ▼  UNION — allowed if ANY policy permits
 Policy-level: one policy's ingress (or egress) rules
                       │
                       ▼  UNION — allowed if ANY rule permits
 Rule-level: one rule's (from|to) clauses + ports
                       │
                       ▼  INTERSECT — source must match AND port must match
```

Concrete:

```yaml
# Policy A
ingress:
- from:
  - podSelector: { matchLabels: { tier: frontend } }
  ports:
  - { port: 8080 }

# Policy B (same target pod)
ingress:
- from:
  - podSelector: { matchLabels: { tier: admin } }
  ports:
  - { port: 22 }
```

Allowed ingress:

- `tier: frontend` pods on port 8080 (from Policy A)
- `tier: admin` pods on port 22 (from Policy B)

Everything else: denied. Allow-lists compose by union.

### Within one rule: source AND port

```yaml
ingress:
- from:
  - podSelector: { matchLabels: { tier: frontend } }
  - podSelector: { matchLabels: { tier: admin } }
  ports:
  - { port: 8080 }
  - { port: 22 }
```

Allowed: `(frontend OR admin) AND (8080 OR 22)`.

- frontend on 8080: ✅
- frontend on 22: ✅
- admin on 8080: ✅
- admin on 22: ✅
- anyone else: ❌

The `from` list is OR-ed. The `ports` list is OR-ed. Then the two are intersected.

---

## Ingress vs egress — both sides must allow

For pod A to send traffic to pod B:

- **A's egress** must allow destination B on the target port (if A is isolated for egress).
- **B's ingress** must allow source A on that port (if B is isolated for ingress).

If either side denies, the connection fails. So a policy "on B" that looks correct might still fail because "A can't egress to B."

This is the bidirectional nature of NetworkPolicy. When debugging, **always check both sides**.

---

## What policies don't do

- **No L7 rules.** You can't say "allow HTTP GET but not POST." For that, use Cilium or a service mesh.
- **No allow-then-deny.** Only allow rules exist. You structure using selectors + "everything else is implicit-deny."
- **No cross-cluster policies.** Policies apply within one cluster.
- **No enforcement on hostNetwork pods.** Pods with `hostNetwork: true` are on the node network, bypassing CNI's policy plane.
- **No effect on traffic to/from the node.** Node-local traffic (e.g. kubelet probing a pod) is always allowed.
- **No ordering / priority.** All policies are peer-to-peer; union semantics apply.
- **Not a pod firewall.** A pod process can still open localhost sockets or be attacked via shared volumes; this is network-layer only.

---

## The DNS trap

The #1 reason NetworkPolicy breaks workloads that "should work": **you block DNS without realizing it.**

If you add an egress policy, the pod is now isolated for egress. Its DNS lookups (UDP/TCP 53 to CoreDNS) need to be explicitly allowed:

```yaml
egress:
- to:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: kube-system    # modern label
  ports:
  - protocol: UDP
    port: 53
  - protocol: TCP
    port: 53
```

Forget this, and the pod can't resolve any hostname — including the service it's supposed to reach. Symptoms: `curl` timeouts, `nslookup` hangs, applications look broken despite the policy looking right.

**Rule of thumb: every egress policy includes DNS.** Add it as the first rule every time.

---

## Policy ordering (there isn't any)

Some firewalls have ordering and precedence. NetworkPolicy has neither. All matching policies are OR'd together; there's no "first deny wins" or "last allow wins."

This has an implication: you can't write "allow A, then deny B" — the moment you allow A, traffic flows. If B overlaps, B is also allowed.

Structure policies around **selection** (who's isolated) and **positive allow-listing** (what's permitted). Leave everything else deny-by-default.

---

## The zero-trust pattern

Three policies per namespace to start:

1. `deny-all-ingress` — all pods isolated for Ingress.
2. `deny-all-egress` — all pods isolated for Egress.
3. `allow-dns` — allow UDP/TCP 53 to kube-system.

Then, per workload, add specific allow policies for what that workload actually needs.

This is the **default-deny** model. Detail in the next subtopic.

---

## Checking if policies are active

```bash
# List all policies in a namespace
kubectl get networkpolicies -n <ns>
# or
kubectl get netpol -n <ns>

# Details
kubectl describe netpol <name> -n <ns>

# Policies selecting a specific pod (not a built-in view; use labels)
POD_LABELS=$(kubectl get pod <name> -o jsonpath='{.metadata.labels}')
# Then manually check each netpol's podSelector against those labels
```

Modern versions of some tools have richer views:

- `kubectl kube-policy-audit` (Calico) — shows what's enforced for each pod.
- `calicoctl` — introspects Calico's policy store.
- Cilium's `cilium-cli` and `cilium monitor` — show eBPF-level decisions.

---

## Exam heuristics

- If asked to "isolate this pod from all ingress," write a NetworkPolicy selecting it with `policyTypes: [Ingress]` and `ingress: []`.
- If asked to "allow A to reach B on port 80," write a policy on **B** (ingress from A) or on **A** (egress to B). Either side alone works if only that side has policies; both sides need it if both have existing policies.
- Always remember to allow DNS when writing egress policies. Count on it in exam scenarios.
- Know the CNI in play — if it's Flannel alone, NetworkPolicy does nothing.
- `kubernetes.io/metadata.name` is a built-in label on every namespace (value = namespace name). Use this to reference namespaces by name.

## Mental traps

- Believing Kubernetes enforces policies. The CNI does; without support, policies are silently ignored.
- Thinking policies are default-deny. They're default-**allow** until a policy selects a pod.
- Expecting allow rules to be ordered. They aren't — union semantics.
- Forgetting DNS in egress policies. Cluster breaks silently.
- Writing policies that overlap incompatibly ("this policy only allows frontend; this other only allows admin") expecting intersection. It's union — both are allowed.
- Applying a NetworkPolicy and assuming it works. Traffic may still flow because CNI doesn't implement policy. Test both directions (use `kubectl exec ... curl` from a pod that should be blocked).
- Using `namespaceSelector: {}` without realizing it selects **every** namespace. Usually want a specific label.
- Expecting NetworkPolicy to restrict `hostNetwork` pods. It doesn't.
