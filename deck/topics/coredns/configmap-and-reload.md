## What CoreDNS is, architecturally

CoreDNS is a **DNS server implemented as a plugin chain**. Each plugin handles a specific concern (health checks, cache, Kubernetes lookups, forwarding). The chain is declared in the **Corefile**, which on Kubernetes lives in a ConfigMap mounted into the CoreDNS pods.

```
incoming query
     │
     ▼
 ┌─────────┐
 │ errors  │  → log errors
 ├─────────┤
 │ health  │  → respond to /health on :8080
 ├─────────┤
 │ ready   │  → respond to /ready on :8181
 ├─────────┤
 │ kubernetes │ → match cluster.local, look up svc/pod records
 ├─────────┤
 │ prometheus │ → expose /metrics on :9153
 ├─────────┤
 │ forward │  → forward upstream if no plugin answered
 ├─────────┤
 │ cache   │  → cache responses
 ├─────────┤
 │ loop    │  → detect DNS loops on startup
 ├─────────┤
 │ reload  │  → watch Corefile for changes
 ├─────────┤
 │ loadbalance │ → shuffle answers (per-query)
 └─────────┘
     │
     ▼
   response
```

Each plugin can: handle the query and return, pass to the next plugin via "fallthrough", or inspect+modify. The order in the Corefile matters — plugins execute in the order listed.

---

## The default kubeadm Corefile

```bash
kubectl get cm coredns -n kube-system -o yaml
```

Typical content:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health {
           lameduck 5s
        }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
           pods insecure
           fallthrough in-addr.arpa ip6.arpa
           ttl 30
        }
        prometheus :9153
        forward . /etc/resolv.conf {
           max_concurrent 1000
        }
        cache 30
        loop
        reload
        loadbalance
    }
```

Walk-through:

- **`.:53`** — listen on UDP/TCP port 53 for all zones (the `.` catch-all).
- **`errors`** — log plugin errors to stdout.
- **`health { lameduck 5s }`** — responds "OK" on `:8080/health`. During shutdown, lies "NOT OK" for 5s so Kubernetes stops routing traffic before the pod dies. Prevents dropped DNS queries during rolling updates.
- **`ready`** — responds on `:8181/ready` once CoreDNS has fully initialized (informers synced). Used as a readiness probe.
- **`kubernetes cluster.local in-addr.arpa ip6.arpa { ... }`** — the heart of the config. Registers the cluster zone + reverse zones. Settings:
  - `pods insecure` — return Pod A records without verification (see service-discovery deck).
  - `fallthrough in-addr.arpa ip6.arpa` — if no match for reverse queries, pass to the next plugin (often forward).
  - `ttl 30` — cache answers for 30s (client-side).
- **`prometheus :9153`** — exposes CoreDNS internal metrics for scraping.
- **`forward . /etc/resolv.conf`** — forward anything the plugins above didn't handle to the upstream servers in `/etc/resolv.conf` (the CoreDNS pod's own, i.e. the node's DNS).
- **`cache 30`** — cache responses for 30 seconds. Different from the `ttl` above — this is CoreDNS's own cache for responses it forwards.
- **`loop`** — detect DNS loops (upstream resolver that ultimately points back at CoreDNS). Fails to start if detected.
- **`reload`** — watch the Corefile for changes; auto-reload.
- **`loadbalance`** — shuffle multi-record answers (e.g. headless service with 3 IPs) so clients don't all hit the first IP.

---

## The CoreDNS Deployment

```bash
kubectl -n kube-system get deploy coredns
# NAME      READY   UP-TO-DATE   AVAILABLE   AGE
# coredns   2/2     2            2           ...
```

Two replicas by default. Each pod mounts the ConfigMap:

```yaml
# In the Deployment spec:
volumes:
- name: config-volume
  configMap:
    name: coredns
    items:
    - key: Corefile
      path: Corefile
volumeMounts:
- name: config-volume
  mountPath: /etc/coredns
```

The Corefile is at `/etc/coredns/Corefile` inside the container.

A LoadBalancer (well, ClusterIP) Service fronts them:

```bash
kubectl -n kube-system get svc kube-dns
# NAME       TYPE        CLUSTER-IP   PORT(S)                   AGE
# kube-dns   ClusterIP   10.96.0.10   53/UDP,53/TCP,9153/TCP    ...
```

The Service's ClusterIP is what's in every pod's `/etc/resolv.conf`.

### Resilience

The CoreDNS Deployment has:

- `replicas: 2` (sometimes more on bigger clusters).
- `priorityClassName: system-cluster-critical` — prevents preemption.
- Tolerations for `CriticalAddonsOnly` and `node-role.kubernetes.io/control-plane`.
- Anti-affinity so the replicas don't co-locate on one node.

Losing both replicas takes DNS down for the cluster — no new connections can be made. It's a critical add-on; treat it carefully.

---

## Hot-reloading the Corefile

The `reload` plugin watches the ConfigMap-backed Corefile for changes and re-reads on modification.

### Edit flow

```bash
# Edit the ConfigMap
kubectl edit cm coredns -n kube-system

# Save. kubelet propagates the new ConfigMap to the mounted volume (~60s for ConfigMap updates).
# The reload plugin detects the change (check interval ~2 minutes).
# CoreDNS loads the new config without dropping active connections.

# Or, force immediate propagation by restarting the pods:
kubectl rollout restart deploy coredns -n kube-system
```

ConfigMap-mount updates have latency — kubelet refreshes the mounted file every ~60s. So a Corefile change can take 1-3 minutes to take effect naturally. Restart the Deployment if you need it faster.

### Validating new config

Before applying, syntax-check your Corefile by running CoreDNS locally:

```bash
# Extract current config
kubectl get cm coredns -n kube-system -o jsonpath='{.data.Corefile}' > /tmp/Corefile

# Edit it as needed, then:
docker run --rm -v /tmp/Corefile:/Corefile coredns/coredns:latest -validate -conf /Corefile
# OK
```

If you apply a bad Corefile, CoreDNS pods will CrashLoopBackOff. The old pods may keep serving (via `reload` rejecting bad config and keeping the previous) — but this isn't guaranteed. Always validate.

---

## Common Corefile modifications

### Stub zones for internal DNS servers

An enterprise cluster that needs to resolve `company.internal`:

```
.:53 {
    errors
    health { lameduck 5s }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
        ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf { max_concurrent 1000 }
    cache 30
    loop
    reload
    loadbalance
}

company.internal:53 {
    errors
    cache 30
    forward . 10.0.0.53 10.0.0.54        ← company's DNS servers
}
```

Now any query for `*.company.internal` goes to `10.0.0.53`/`54`.

### Rewriting zone

Sometimes you need to rewrite queries (`old.name` → `new.name`):

```
.:53 {
    rewrite name old-service.default.svc.cluster.local new-service.default.svc.cluster.local
    kubernetes cluster.local { ... }
    ...
}
```

Useful during migrations.

### Autopath — avoiding ndots fanout

For very busy external-name workloads, the `autopath` plugin reduces the ndots:5 cascade:

```
kubernetes cluster.local in-addr.arpa ip6.arpa {
    pods verified
}
autopath @kubernetes
```

The plugin looks at the client's search path and returns "not in cluster" quickly, avoiding the four-query cascade. Requires `pods verified` (so CoreDNS knows which pod is asking). More memory usage; on very large clusters, a clear win for external-heavy workloads.

### Disabling pod records

For security or minimization:

```
kubernetes cluster.local in-addr.arpa ip6.arpa {
    pods disabled
    ...
}
```

Pods can no longer resolve `<ip>.<ns>.pod.cluster.local`. Rarely needed, but an option.

### Caching controls

```
cache 300 {
    success 9984 300
    denial 9984 15        ← NXDOMAIN cached for only 15s (default is 600)
}
```

Lower NXDOMAIN TTL helps when names are frequently created (e.g. short-lived StatefulSet pods); higher TTL reduces CoreDNS load.

---

## Per-pod DNS config override (not Corefile)

Individual pods can override DNS without touching CoreDNS:

```yaml
spec:
  dnsPolicy: ClusterFirst
  dnsConfig:
    options:
    - name: ndots
      value: "2"
    searches:
    - internal.example.com
```

Fine for small overrides. For cluster-wide policy, use the Corefile.

---

## Scaling CoreDNS

For busy clusters, 2 replicas isn't enough:

```bash
kubectl scale deploy coredns -n kube-system --replicas=4
```

Guidelines:

- Roughly 1 replica per ~1000 pods or per ~30 QPS sustained.
- Monitor `coredns_dns_request_count_total` in Prometheus; if hitting CPU limits, scale.
- NodeLocal DNSCache (a DaemonSet that caches per-node) offloads CoreDNS for repeat queries.

### NodeLocal DNSCache — the production-grade option

A DaemonSet pod on every node (`node-local-dns` or `nodelocaldns`) caches DNS responses locally. Pods are configured via kubelet flags to use `169.254.20.10` (the node-local listener) first. Benefits:

- Reduces CoreDNS load by 50-90% (most queries hit local cache).
- Eliminates UDP conntrack issues on busy nodes (local stub is TCP-friendly).
- Graceful fallback to CoreDNS on cache miss.

Out of CKA scope for core knowledge, but recognize it in production clusters.

---

## Configuring kubelet's clusterDNS

The CoreDNS Service IP in pod's `/etc/resolv.conf` comes from kubelet's config. To change:

```yaml
# /var/lib/kubelet/config.yaml
clusterDNS:
  - 10.96.0.10
clusterDomain: cluster.local
```

On kubeadm, this is set at init time. To change post-init:

```bash
# On each node:
sudo vi /var/lib/kubelet/config.yaml
# Update clusterDNS and/or clusterDomain

sudo systemctl restart kubelet
# Then reschedule pods to pick up the new values (they re-read resolv.conf on pod restart)
```

If kubelet's `clusterDomain` (e.g. `cluster.local`) and CoreDNS's configured zone (same string) disagree, lookups fail silently — queries hit the wrong zone and fall through to upstream.

---

## Exam heuristics

- The ConfigMap is `coredns` in `kube-system`; `kubectl edit cm coredns -n kube-system`.
- For Corefile changes, always `rollout restart deploy coredns -n kube-system` to apply immediately.
- `coredns` is the Deployment name; `kube-dns` is the Service name (legacy). Don't confuse.
- If asked to "add upstream DNS for a custom domain," add a zone block with `forward`.
- If asked to "change the cluster domain," you must update both kubelet's `clusterDomain` AND the Corefile's `kubernetes` line.

## Mental traps

- Editing the Corefile as if it were live — it's a ConfigMap; kubelet's refresh lag means edits take up to 60s to propagate.
- Forgetting that the `reload` plugin only hot-reloads; syntax errors still CrashLoopBackOff the pod on restart.
- Running only 1 CoreDNS replica in production. Single point of failure for cluster DNS.
- Expecting CoreDNS to proxy traffic. It answers DNS; the actual connections are between pods/services.
- Changing `cluster.local` to something else on a running cluster. Fragile — every existing pod has the old value in resolv.conf until it restarts.
- Thinking `forward . /etc/resolv.conf` points back at CoreDNS. In the CoreDNS **pod**, /etc/resolv.conf has the **host's** DNS (via dnsPolicy: Default).
- Enabling `autopath` without `pods verified`. Won't work; autopath needs pod-level identification.
