## The core diagnostic question

NetworkPolicy debugging is hard because failure is silent — blocked traffic looks like a timeout, indistinguishable from "the service is down." The key question to answer:

**Is the traffic blocked by policy, or blocked by something else?**

Then:

**Which policy / which direction?**

This note is the systematic flow.

---

## Step 0: Confirm it's actually a NetworkPolicy issue

Before blaming policy, rule out other layers:

```bash
# 1. Does DNS resolve?
kubectl run tmp --rm -it --image=busybox:1.28 --restart=Never -n <ns> -- nslookup <target-svc>

# 2. Does the service have Endpoints?
kubectl get endpoints <target-svc> -n <ns>

# 3. Can a pod that SHOULDN'T be blocked reach the target?
kubectl run tmp --rm -it --image=busybox --restart=Never -n <other-ns> -- wget -qO- <target-svc>

# 4. Is the CNI responding to policies? (Does Flannel alone + no policy plugin mean policies are ignored?)
kubectl get pods -n kube-system | grep -E 'calico|cilium|flannel|antrea|weave'
```

If DNS fails across the board, suspect CoreDNS (see coredns deck). If Endpoints are empty, suspect Service/readiness (see services-and-endpoints deck). If pods in *unaffected* namespaces also can't reach, the issue is Service / DNS / CNI — not policy.

### Verify your CNI enforces NetworkPolicy

```bash
# Apply a test policy
cat <<'EOF' | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: test-deny
  namespace: default
spec:
  podSelector: {}
  policyTypes: [Ingress]
EOF

# Try to reach any pod in default from another namespace
kubectl run tmp --rm -it --image=busybox:1.28 --restart=Never -n kube-system -- \
  wget -qO- --timeout=5 <any-service-in-default>.default

# Expected: timeout (if CNI enforces)
# If the request succeeds, the CNI is not enforcing NetworkPolicy

kubectl delete netpol test-deny -n default
```

If the CNI doesn't enforce, your policies are silently ignored. Fix by installing a policy-capable CNI.

---

## Step 1: List policies affecting the target

```bash
# All policies in the target namespace
kubectl get netpol -n <ns>

# Detailed view of each
for p in $(kubectl get netpol -n <ns> -o name); do
  echo "== $p =="
  kubectl describe $p -n <ns>
done
```

For each policy, check:

- Its `podSelector` — does it match your target pod's labels?
- Its `policyTypes` — does it include the direction your client is coming from?
- Its `ingress` / `egress` rules — do any permit the traffic you're expecting?

The target pod's labels:

```bash
kubectl get pod <target-pod> -n <ns> --show-labels
```

### Is my pod selected?

A pod is selected by a policy iff its labels satisfy the policy's `podSelector`. Verify by running the same selector against pods:

```bash
# Extract the policy's selector
kubectl get netpol <pol> -n <ns> -o jsonpath='{.spec.podSelector}'
# {"matchLabels":{"tier":"api"}}

# Find pods that match
kubectl get pods -n <ns> -l tier=api
```

If your pod is in the list, it's selected. Once selected for a `policyType`, it's isolated — anything not explicitly allowed is blocked.

---

## Step 2: Check both directions

A connection from A to B requires **A's egress** to allow AND **B's ingress** to allow. Missing either breaks it.

Compile the list:

```
"Traffic A:x → B:y" is allowed iff:
  For every policy selecting A with Egress: at least one rule matches (B, y)
  For every policy selecting B with Ingress: at least one rule matches (A, x)
```

If A is not isolated for Egress (no policy selects it with Egress): egress is unrestricted. Likewise for B.

### Walk through

Example: a pod `client` in `ns-a` tries to reach `api` in `ns-b` on 8080.

```bash
# client's labels
kubectl get pod client -n ns-a --show-labels

# Policies in ns-a that select client for Egress
kubectl get netpol -n ns-a -o json | jq '.items[] |
  select(.spec.policyTypes[]? == "Egress") |
  { name: .metadata.name, selector: .spec.podSelector, egress: .spec.egress }'

# api's labels
kubectl get pod <api-pod> -n ns-b --show-labels

# Policies in ns-b that select api for Ingress
kubectl get netpol -n ns-b -o json | jq '.items[] |
  select(.spec.policyTypes[]? == "Ingress") |
  { name: .metadata.name, selector: .spec.podSelector, ingress: .spec.ingress }'
```

Now check whether:

- Any `egress` rule allows dst matching api's labels + namespace + port 8080.
- Any `ingress` rule on api allows src matching client's labels + namespace + port 8080.

Both must be true. If either fails, you've found the block.

---

## Step 3: The DNS sanity check

The single most common NetworkPolicy mistake is blocking DNS. Test DNS from the affected pod:

```bash
kubectl exec -it <client-pod> -n <ns> -- nslookup kubernetes 10.96.0.10
```

If this fails, DNS is blocked. Check egress policies affecting this pod for allowance of UDP 53 to `kube-system`.

The canonical fix:

```yaml
egress:
- to:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: kube-system
  ports:
  - { protocol: UDP, port: 53 }
  - { protocol: TCP, port: 53 }
```

Add this to the policy (or to a separate allow-dns policy) and re-test.

---

## Step 4: Test with direct IP

DNS failures mask as "policy blocks." Bypass DNS to isolate:

```bash
# Find the target pod's IP
kubectl get pod <target-pod> -n <ns> -o jsonpath='{.status.podIP}'
# 10.244.2.7

# Try to connect to the IP directly
kubectl exec -it <client-pod> -n <ns> -- wget -qO- --timeout=5 http://10.244.2.7:8080/
```

Outcomes:

- **Direct IP works, service name doesn't** → DNS is blocked or service's Endpoints are empty. Not a policy-between-these-pods issue.
- **Direct IP fails too** → NetworkPolicy (or CNI) is blocking between these pods. Proceed.

---

## Step 5: Check from other pods

Does the problem reproduce from other pods? If only one pod fails but others succeed, the difference is that pod's labels or policies selecting it.

```bash
# From a pod with different labels in the same namespace
kubectl run tmp --rm -it --image=nicolaka/netshoot --restart=Never -n <ns> -- bash
# inside:
curl http://<target-service>/
```

If the temporary pod succeeds, the original client's labels match some egress-restricting policy. Compare label sets.

---

## Step 6: CNI-specific debugging

Each CNI exposes different debugging tools.

### Calico

```bash
# Calico enforcement status for this pod
calicoctl get workloadendpoint -A | grep <pod-name>

# View policies as Calico sees them
calicoctl get networkpolicy -A

# Flow logs (if enabled)
kubectl logs -n kube-system -l k8s-app=calico-node --tail=100 | grep <pod-ip>
```

### Cilium

```bash
# Cilium pods
kubectl get pods -n kube-system -l k8s-app=cilium

# Get the cilium pod on the target's node
CILIUM_POD=$(kubectl get pods -n kube-system -l k8s-app=cilium \
  --field-selector spec.nodeName=<target-node> -o jsonpath='{.items[0].metadata.name}')

# Who is enforcing what on this pod?
kubectl exec -n kube-system $CILIUM_POD -- cilium endpoint list | grep <target-pod-ip>

# Live flow monitoring
kubectl exec -n kube-system $CILIUM_POD -- cilium monitor --type drop

# Policy trace
kubectl exec -n kube-system $CILIUM_POD -- cilium policy trace \
  --src-pod ns-a/client \
  --dst-pod ns-b/api \
  --dport 8080
```

Cilium has by far the richest observability — `cilium monitor --type drop` tells you exactly which packets are dropped and why.

### Antrea / Weave / kube-router

Each has its own tooling; generally similar pattern: look at agent logs on the target's node, see what policy is being applied.

---

## Step 7: tcpdump the pod

Ultimately, what packets reach / leave the pod?

```bash
# Find the pod's container PID
NODE=$(kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.nodeName}')
ssh $NODE
sudo crictl pods --name <pod-name-prefix>       # get sandbox ID
POD_PID=$(sudo crictl inspectp <sandbox-id> --output go-template --template='{{.info.pid}}')

# Enter the pod's network namespace for tcpdump
sudo nsenter -t $POD_PID -n tcpdump -nni any port 8080
```

Expected patterns:

- **No packets arriving**: sending side's egress is blocked, or the packet is being dropped before reaching this pod.
- **Packets arriving, no response**: packets reach pod but nothing is answering (or replies are being blocked by *egress* policy on this pod — reply direction is auto-allowed for established connections, but new connections' replies are a different matter).
- **SYN-ACK seen**: connection is being established. If client reports failure, something later is wrong.
- **SYN but no SYN-ACK**: pod got packet, chose not to respond. App issue, probably not policy.

---

## Common failure patterns

### "I applied the policy but nothing changed"

- The CNI doesn't enforce NetworkPolicy (Flannel alone). Install Calico-for-policy.
- The pod the policy targets doesn't match — selector typo.
- The pod is `hostNetwork: true` — bypasses CNI.

### "I applied default-deny and everything broke"

- DNS is blocked. Add DNS egress allow.
- System pods in the namespace (if any) were also caught. Move them to a dedicated namespace or use `podSelector` more specifically.

### "Direction is correct but still blocked"

- Only one direction has an allow. Check both sides — egress from sender AND ingress to receiver.
- Policies within the namespace combine via union, but so does the isolation flag. One policy with `policyTypes: [Ingress]` is enough to isolate the pod for ingress, regardless of other policies' rules.

### "Specific port works, others don't"

- The policy allows only those ports. `ports:` is a whitelist, not a default-allow.

### "Seems intermittent"

- Pod has multiple replicas; some have labels matching a policy, others don't. Label drift during rolling update.
- CNI is flapping (reload loop).

### "It worked yesterday"

- A new policy was added. `kubectl get netpol -A -o yaml | grep -B 2 creationTimestamp` to find recent ones.
- A pod's labels changed (Deployment rollout).

---

## Handy diagnostic commands

```bash
# All policies cluster-wide
kubectl get netpol -A

# Policies selecting a specific pod
kubectl get netpol -A -o yaml | grep -B 5 <pod-label-value>

# Network Policy coverage summary
kubectl get pods -A -o json | jq -r '
  .items[] | [.metadata.namespace, .metadata.name, (.metadata.labels | tostring)] | @tsv'

# Namespace labels
kubectl get ns --show-labels

# CoreDNS reachable from pod
kubectl exec -it <pod> -- nslookup kubernetes.default.svc.cluster.local 10.96.0.10

# Direct TCP test
kubectl exec -it <pod> -- nc -zv <target-pod-ip> <port>
```

### Testing what a specific policy would allow

This is the trick question on the exam: "given these policies, will A reach B?" Walk through:

1. Is B isolated for ingress? (Any policy in B's namespace with podSelector matching B and policyTypes including Ingress?)
   - No → allowed.
   - Yes → continue.
2. Do any ingress rules on B's isolating policies match (A's labels, A's namespace, target port)?
   - At least one match → proceed.
   - No match → blocked.
3. Is A isolated for egress? (Same logic.)
   - No → allowed.
   - Yes → continue.
4. Do any egress rules on A's isolating policies match (B's labels, B's namespace, target port)?
   - At least one match → allowed.
   - No match → blocked.

Both checkpoints must pass.

---

## Building a policy-safe test environment

When developing policies, it helps to have:

1. A "source" pod with known labels in the expected source namespace.
2. A "target" pod with known labels in the expected target namespace.
3. Scripts to test A→B, B→A, and random external pods.

```bash
# Quick source pod
kubectl run src --image=nicolaka/netshoot --labels='app=src,tier=test' -n ns-a -- sleep 3600

# Quick target pod
kubectl run dst --image=nginx --labels='app=dst,tier=web' -n ns-b
kubectl expose pod dst --port=80 -n ns-b

# Test
kubectl exec -it src -n ns-a -- curl --max-time 5 http://dst.ns-b:80/

# Iterate on policies
kubectl apply -f policy.yaml
kubectl exec -it src -n ns-a -- curl --max-time 5 http://dst.ns-b:80/
```

---

## Exam heuristics

- When an exam scenario says "traffic is blocked," always first check if a NetworkPolicy could be responsible with `kubectl get netpol -A`.
- If DNS breaks after an egress policy, you forgot DNS. Add UDP/TCP 53 to `kube-system`.
- For "pod A should reach pod B but can't," check both directions — egress on A, ingress on B.
- `kubectl describe pod` + `kubectl describe netpol` are your first stops before any CNI-specific tool.
- CNI-specific tools (cilium, calico) give much richer signal when available.

## Mental traps

- Believing `kubectl apply` of a policy means it's enforced. The CNI has to support it.
- Debugging with a pod that's unexpectedly in a different namespace than you thought. Always `kubectl get pods -o wide` to confirm pod/node/namespace.
- Forgetting that reply traffic is automatic but new connections' replies go through egress policy. Typically not an issue for established TCP, can bite UDP.
- Assuming the policy you wrote matches what you intended. Always inspect `kubectl describe netpol` and test empirically.
- Not checking for hostNetwork pods. They bypass NetworkPolicy entirely.
- Tcpdumping the wrong netns. Pods have their own namespace; host-level tcpdump shows the host's view.
- Testing with a pod that has extra labels not present in production. Reproduce with exact labels.
