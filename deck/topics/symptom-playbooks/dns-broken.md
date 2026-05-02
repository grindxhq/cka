## What "DNS broken" looks like

```
$ kubectl exec test -- nslookup kubernetes
;; connection timed out; no servers could be reached

$ kubectl exec test -- curl http://my-service
curl: (6) Could not resolve host: my-service
```

DNS failures cascade — apps that "can't reach the database" are usually really "can't resolve the database name." Always rule out DNS first when network issues appear.

Three flavors of DNS failure (very different fixes):

| Symptom | Likely cause |
|---------|--------------|
| **Timeout** — query never returns | CoreDNS unreachable or unresponsive |
| **NXDOMAIN** — "no such name" | Name doesn't exist (typo, wrong namespace) |
| **SERVFAIL** — server-side error | CoreDNS upstream broken / config error |
| **Slow but eventually works** | ndots:5 expansion, conntrack pressure |

`dig` makes the distinction clear:

```bash
dig my-service
# status: NOERROR  → success
# status: NXDOMAIN  → name doesn't exist
# status: SERVFAIL  → resolver error
# (no response, eventually times out)  → unreachable
```

---

## The DNS path in a pod

```
 App calls gethostbyname("my-service")
   │
   │ ① reads /etc/resolv.conf
   │   nameserver 10.96.0.10  (CoreDNS service ClusterIP)
   │   search default.svc.cluster.local svc.cluster.local cluster.local
   │   options ndots:5
   │
   │ ② libc applies search rules
   │   "my-service" has 0 dots, < 5 → expand search
   │   try: my-service.default.svc.cluster.local
   │
   │ ③ UDP query to 10.96.0.10:53
   │
   ▼
 kube-proxy DNATs to a CoreDNS pod
   │
   │ ④ CoreDNS plugin chain
   │   - kubernetes plugin matches `cluster.local`
   │   - looks up service in apiserver cache
   │   - returns A record with ClusterIP
   │
   ▼
 App gets 10.96.0.50, connects.
```

Each step can fail. Walk them in order.

---

## Step 1: Does the pod have correct resolv.conf?

```bash
kubectl exec my-pod -- cat /etc/resolv.conf

# nameserver 10.96.0.10
# search default.svc.cluster.local svc.cluster.local cluster.local
# options ndots:5
```

Verify:

- **nameserver** matches CoreDNS Service ClusterIP (`kube-dns` Service in `kube-system`).
- **search** is reasonable — namespaces/svc/cluster.local.
- **ndots:5** is the kubeadm default.

Mismatches:

| Issue | Fix |
|-------|-----|
| nameserver doesn't match `kube-dns` Service IP | Wrong kubelet config; check `clusterDNS` in kubelet config |
| Empty resolv.conf | kubelet failed to write it; restart kubelet |
| Custom dnsConfig overriding | Pod uses `dnsPolicy: None` or custom dnsConfig — review pod spec |

Get the actual CoreDNS Service IP:

```bash
kubectl get svc kube-dns -n kube-system -o jsonpath='{.spec.clusterIP}'
# 10.96.0.10
```

Should match what's in pod's resolv.conf.

For pods with `hostNetwork: true`: they inherit node DNS by default. Set `dnsPolicy: ClusterFirstWithHostNet` to use cluster DNS.

---

## Step 2: Is CoreDNS reachable from the pod?

```bash
kubectl run test --rm -it --image=busybox:1.28 --restart=Never -- sh
# inside:
nc -zvu 10.96.0.10 53        # UDP
nc -zv 10.96.0.10 53          # TCP
```

If both fail: kube-proxy's rules for the kube-dns Service are broken (or the Service has no Endpoints).

Check:

```bash
kubectl get svc kube-dns -n kube-system
kubectl get endpoints kube-dns -n kube-system

# NAME       ENDPOINTS                            AGE
# kube-dns   10.244.0.5:53,10.244.0.7:53          30d
```

If Endpoints empty: no CoreDNS pods are Ready.

```bash
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl logs -n kube-system <coredns-pod>
```

---

## Step 3: Are CoreDNS pods Ready?

```bash
kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide

# NAME                       READY   STATUS    AGE   IP           NODE
# coredns-aaa                1/1     Running   5d    10.244.0.5   node1
# coredns-bbb                1/1     Running   5d    10.244.0.7   node2
```

If a pod is `0/1` or CrashLoopBackOff:

```bash
kubectl describe pod <coredns-pod> -n kube-system
kubectl logs -n kube-system <coredns-pod> --tail=50
```

Common CoreDNS issues:

### CoreDNS CrashLoopBackOff

```
[FATAL] plugin/loop: Loop detected for zone "."
```

CoreDNS detects DNS loop — its upstream resolves to itself.

Fix: edit Corefile, set explicit upstream:

```bash
kubectl edit cm coredns -n kube-system
```

Change:

```
forward . /etc/resolv.conf
```

To:

```
forward . 8.8.8.8 1.1.1.1
```

```bash
kubectl rollout restart deployment coredns -n kube-system
```

### Bad Corefile syntax

```
[FATAL] plugin/kubernetes: cluster.local is not a valid zone name
```

Corefile syntax error. Revert recent changes or fix syntax.

### Image pull failure

CoreDNS image typo / unreachable registry. Check pod events.

### OOM

CoreDNS sized too small for cluster's DNS load. Raise memory limit.

---

## Step 4: Query CoreDNS directly

Bypass the resolver search expansion:

```bash
kubectl run test --rm -it --image=nicolaka/netshoot --restart=Never -- bash

# inside:
dig @10.96.0.10 kubernetes.default.svc.cluster.local
```

`kubernetes.default` always exists — it's the Service that fronts apiserver. It's the canonical "is DNS working at all" query.

If this works: DNS is functional; your specific name doesn't exist or has issues.

If this fails: CoreDNS itself is broken.

---

## Step 5: NXDOMAIN — the name doesn't exist

If `dig` returns NXDOMAIN:

```bash
dig my-service
# status: NXDOMAIN
```

The name CoreDNS searched for doesn't match any Service. Causes:

1. **Wrong namespace** — `my-service` resolves in pod's own namespace; if Service is in another, use FQDN: `my-service.<ns>.svc.cluster.local`.
2. **Typo** — `my-service` vs `my-svc`.
3. **Service deleted** — verify with `kubectl get svc -A`.
4. **Wrong cluster domain** — pod is configured with `cluster.local` but cluster's actual domain differs.

Verify the Service:

```bash
kubectl get svc -A | grep my-service
```

If the Service exists in another namespace, query with the FQDN:

```bash
dig my-service.prod.svc.cluster.local
# Now: NOERROR with the right IP
```

Cluster domain check:

```bash
# What's CoreDNS configured for?
kubectl get cm coredns -n kube-system -o yaml | grep 'kubernetes '
# kubernetes cluster.local in-addr.arpa ip6.arpa { ... }

# What's kubelet configured for?
ssh <node> 'grep clusterDomain /var/lib/kubelet/config.yaml'
# clusterDomain: cluster.local
```

These must match.

---

## Step 6: SERVFAIL — upstream issues

```bash
dig example.com
# status: SERVFAIL
```

CoreDNS tried to forward to upstream, upstream failed.

```bash
# CoreDNS pod's view of upstream
kubectl exec -n kube-system <coredns-pod> -- cat /etc/resolv.conf
# nameserver <upstream-1>
# nameserver <upstream-2>

# Test from within CoreDNS
kubectl exec -n kube-system <coredns-pod> -- nslookup example.com <upstream-1>
```

If upstream is unreachable: fix the network, or change CoreDNS's `forward` directive to use a different upstream (e.g. 8.8.8.8 / 1.1.1.1).

---

## Step 7: Intermittent timeouts

DNS works but timeouts happen 5% of the time. Pain.

Common causes:

### UDP conntrack issues

DNS uses UDP. Busy nodes fill the kernel's conntrack table; new entries (including DNS replies) get dropped.

```bash
# On the node
dmesg | grep conntrack
# nf_conntrack: table full, dropping packet → confirmed

# Stats
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max
```

Fix:

- Raise `nf_conntrack_max`.
- Install **NodeLocal DNSCache** (DaemonSet) — a per-node DNS proxy that uses TCP to CoreDNS, removing UDP from the conntrack equation.

### Race on UDP source ports

Multiple DNS queries from one pod can use the same source port; reply mismatches drop packets.

Fix: same — NodeLocal DNSCache is the durable solution.

### CoreDNS overloaded

```bash
# Metrics
curl http://<coredns-pod-ip>:9153/metrics | grep coredns_dns_request_count_total
# Compared to last week — load spike?
```

Scale CoreDNS:

```bash
kubectl scale deploy coredns -n kube-system --replicas=4
```

Rule of thumb: 1 replica per ~1000 pods or per 30 QPS.

---

## Step 8: ndots:5 trap (slow external DNS)

Pod with `options ndots:5` (default) doing many external lookups:

```bash
dig example.com
# Tries:
# example.com.default.svc.cluster.local → NXDOMAIN
# example.com.svc.cluster.local         → NXDOMAIN
# example.com.cluster.local             → NXDOMAIN
# example.com                           → success
# 4 queries for 1 lookup
```

Apps making thousands of external DNS calls feel slow. Each call adds 4 round-trips.

Fix per pod:

```yaml
spec:
  dnsPolicy: ClusterFirst
  dnsConfig:
    options:
    - name: ndots
      value: "2"            # only expand if < 2 dots
```

Or use FQDN with trailing dot in the app:

```python
socket.getaddrinfo("example.com.", ...)   # trailing dot = absolute
```

Or: enable `autopath` in CoreDNS (avoids server-side expansion).

---

## Step 9: Pod-specific DNS

A single pod has DNS issues; others are fine.

Possible:

- **Custom dnsConfig** on this pod overrides defaults.
- **dnsPolicy: None** with broken config.
- **dnsPolicy: Default** (inherits from node) but the node's DNS is wrong.
- **hostNetwork: true** without `dnsPolicy: ClusterFirstWithHostNet` — uses node's DNS.

```bash
kubectl get pod my-pod -o jsonpath='{.spec.dnsPolicy}'
kubectl get pod my-pod -o jsonpath='{.spec.dnsConfig}'
kubectl get pod my-pod -o jsonpath='{.spec.hostNetwork}'
```

---

## Step 10: NetworkPolicy blocking DNS

If you applied an egress NetworkPolicy, you may have blocked DNS:

```yaml
spec:
  podSelector: { matchLabels: { app: web } }
  policyTypes: [Egress]
  egress:
  - to:
    - podSelector: { matchLabels: { app: db } }
    ports:
    - port: 5432
  # No DNS allowance!
```

Pod can no longer reach CoreDNS. All name resolution times out. Apps look broken.

Fix: always allow DNS in egress policies:

```yaml
egress:
- to:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: kube-system
  ports:
  - { protocol: UDP, port: 53 }
  - { protocol: TCP, port: 53 }
- # ...rest of egress rules
```

---

## Quick diagnostic recipe

```bash
# 1. Is DNS working at all?
kubectl run test --rm -it --image=busybox:1.28 --restart=Never -- nslookup kubernetes

# 2. Pod's resolver config
kubectl run test --rm -it --image=busybox:1.28 --restart=Never -- cat /etc/resolv.conf

# 3. Direct query to CoreDNS
DNS_IP=$(kubectl get svc kube-dns -n kube-system -o jsonpath='{.spec.clusterIP}')
kubectl run test --rm -it --image=nicolaka/netshoot --restart=Never -- \
  dig @$DNS_IP kubernetes.default.svc.cluster.local

# 4. CoreDNS pods healthy?
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50

# 5. CoreDNS Endpoints exist?
kubectl get endpoints kube-dns -n kube-system

# 6. CoreDNS Corefile
kubectl get cm coredns -n kube-system -o yaml | grep -A 30 'Corefile:'

# 7. Cluster-wide events related to DNS
kubectl get events -A | grep -i dns
```

---

## Specific recipes

### Recipe: "DNS is timing out from one pod"

```bash
# Resolver config first
kubectl exec my-pod -- cat /etc/resolv.conf

# Network policy?
kubectl get netpol -A | grep <my-pod's-namespace>

# Direct UDP test
kubectl exec my-pod -- nc -zvu 10.96.0.10 53

# If unreachable: NetworkPolicy or kube-proxy issue.
# If reachable: query directly with dig and see status.
```

### Recipe: "Specific name doesn't resolve"

```bash
# Confirm the Service exists
kubectl get svc -A | grep <name>

# If exists in different namespace, FQDN:
kubectl exec test -- dig <name>.<other-ns>.svc.cluster.local

# If exists in same namespace, the search expansion should find it
kubectl exec test -- dig <name>
```

### Recipe: "Slow external DNS"

```bash
# Verify ndots is the issue
kubectl exec test -- dig example.com.       # absolute (trailing dot)
# Compare to:
kubectl exec test -- dig example.com        # subject to ndots expansion

# If absolute is fast and relative is slow, ndots is the trap.
# Fix: per-pod dnsConfig.options.ndots=2
```

### Recipe: "All cluster DNS broken"

```bash
# Check CoreDNS pods
kubectl get pods -n kube-system -l k8s-app=kube-dns
# 0 ready or all CrashLoop?

# Read logs
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=20

# Common: loop, OOM, image pull
# Most fixable: edit ConfigMap to remove the broken Corefile change
kubectl edit cm coredns -n kube-system
kubectl rollout restart deployment coredns -n kube-system
```

### Recipe: "DNS works for cluster names, fails for external"

```bash
# Test internal
kubectl exec test -- dig kubernetes.default.svc.cluster.local
# Status: NOERROR

# Test external
kubectl exec test -- dig example.com
# Status: SERVFAIL

# CoreDNS upstream is broken.
kubectl exec -n kube-system <coredns-pod> -- cat /etc/resolv.conf
# This is the "/etc/resolv.conf" CoreDNS reads (the node's)

# Test directly:
kubectl exec -n kube-system <coredns-pod> -- nslookup example.com <upstream-ip>

# Fix Corefile to use a working upstream:
kubectl edit cm coredns -n kube-system
# forward . /etc/resolv.conf  →  forward . 8.8.8.8 1.1.1.1
kubectl rollout restart deployment coredns -n kube-system
```

---

## Temporary CoreDNS query logging (for debug)

To see every query:

```bash
kubectl edit cm coredns -n kube-system
```

Add `log` plugin:

```
.:53 {
    log               # ← add this
    errors
    ...
}
```

```bash
kubectl rollout restart deployment coredns -n kube-system
kubectl logs -n kube-system <coredns-pod> -f
# [INFO] 10.244.5.22:34567 - "A IN my-svc.default.svc.cluster.local" NOERROR ...
```

Useful for "are queries even reaching CoreDNS?" Remove the `log` plugin once done — it's expensive on busy clusters.

---

## NodeLocal DNSCache

For production-grade DNS reliability:

```yaml
# Each node runs a local DNS proxy at 169.254.20.10
# Pods are configured (via kubelet) to use this for DNS
# Cache hits don't touch CoreDNS at all
```

Install via the kube-dns NodeLocal DNS Cache addon. Benefits:

- Eliminates UDP conntrack issues.
- Reduces CoreDNS load 50-90%.
- Faster queries (cache hits are local).

Adds operational complexity — another DaemonSet, additional RBAC. Worth it for >100-node clusters.

---

## Common DNS misconfigs

### Wrong cluster domain

CoreDNS configured with `cluster.local`; kubelet configured with `cluster.dev`. Pods get search domain `*.cluster.dev`, queries go to CoreDNS expecting `*.cluster.local`. NXDOMAIN.

Fix: align both. Either:

```bash
# Edit kubelet config on each node
sudo vi /var/lib/kubelet/config.yaml
# clusterDomain: cluster.local
sudo systemctl restart kubelet

# OR edit Corefile
kubectl edit cm coredns -n kube-system
# kubernetes cluster.dev ...
```

### Forgot DNS in egress policy

See step 10 above. Always allow UDP/TCP 53 to kube-system in egress policies.

### Pod with custom dnsConfig

Pod has `dnsPolicy: None` and custom `dnsConfig` pointing at the wrong nameserver. Resolves nothing internal.

Fix: switch to `dnsPolicy: ClusterFirst` (default).

---

## Time budget

| Time | Step |
|------|------|
| 0:00 | `kubectl exec test -- nslookup kubernetes` (baseline) |
| 0:30 | If failed: check resolv.conf, kube-dns Service, Endpoints |
| 1:30 | If endpoints exist: kubectl logs CoreDNS pods |
| 2:30 | If CoreDNS healthy: `dig` from a debug pod with full diagnostic |
| 3:30 | Fix the identified layer |

For "I can't reach this specific service":

| Time | Step |
|------|------|
| 0:00 | `dig my-service` — NOERROR / NXDOMAIN / SERVFAIL? |
| 0:30 | If NXDOMAIN: namespace? typo? Service exists? |
| 1:00 | If NOERROR: go to service-not-routing playbook |
| 1:30 | If timeout: cluster DNS itself is broken (start over with kubernetes.default test) |

---

## Exam heuristics

- For "DNS not working" questions, start with `nslookup kubernetes.default.svc.cluster.local` from a debug pod. Baseline test.
- `busybox:1.28`'s nslookup works; `busybox:latest` may not. Pin the version.
- For "specific name doesn't resolve," try the FQDN to rule out search-path issues.
- Always allow DNS in egress NetworkPolicies — UDP/TCP 53 to kube-system.

## Mental traps

- Treating timeouts and NXDOMAIN as the same problem. Different fixes.
- Editing the Corefile and forgetting to restart the Deployment. Reload plugin handles most changes, but bad Corefile = pod CrashLoop = needs explicit rollout.
- Adding NetworkPolicy without including DNS allow. Cluster appears broken.
- Believing `ndots:5` is "wrong." It's deliberate; fast for in-cluster names. Slow for external. Tune per pod if needed.
- Editing `/etc/resolv.conf` inside a container. Lost on restart; kubelet rewrites.
- Running 1 CoreDNS replica in production. Single point of failure.
- Trusting "CoreDNS is responding" without checking which pods are responding. One bad replica still in Endpoints causes intermittent issues.
