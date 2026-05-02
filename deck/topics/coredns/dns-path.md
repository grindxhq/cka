## The path a DNS query takes, end to end

A pod runs `curl http://web/`. Before a single TCP packet is sent, the name `web` has to turn into an IP. This is the path:

```
 ┌──────────┐
 │   pod    │  issues gethostbyname("web")
 └────┬─────┘
      │ reads /etc/resolv.conf
      │ nameserver: 10.96.0.10   (CoreDNS ClusterIP)
      │ search: default.svc.cluster.local svc.cluster.local cluster.local
      │ options: ndots:5
      │
      │ libc applies ndots rule → "web" has 0 dots (<5)
      │ → try each search suffix in order
      ▼
 query 1: web.default.svc.cluster.local           → UDP/53 to 10.96.0.10
      │
      ▼
 ┌──────────┐
 │ CoreDNS  │  receives query (it's a pod in kube-system)
 │  pods    │
 └────┬─────┘
      │ Corefile routes to kubernetes plugin
      │ plugin looks up "web" in default namespace
      │ finds Service → returns A 10.96.0.50
      │
      ▼
 pod gets 10.96.0.50
      │
      ▼
 pod connects to 10.96.0.50:80
      │
      │ kube-proxy DNATs to pod IP
      │ (see kube-proxy deck)
      ▼
 backend pod receives connection
```

Every pod query goes through this path. It's the default because kubelet configures it, but understanding each component lets you diagnose failures anywhere in the chain.

---

## Step 1: How kubelet sets up `/etc/resolv.conf`

When kubelet starts a pod, it writes `/etc/resolv.conf` based on the pod's `dnsPolicy` and cluster config.

### Default values (dnsPolicy: ClusterFirst)

```
/etc/resolv.conf in the pod:
──────────────────────────────
nameserver 10.96.0.10
search default.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

- **nameserver** — the CoreDNS Service ClusterIP. Kubelet picks it from its config's `clusterDNS`.
- **search** — three suffixes, ordered from most-specific to least. The **pod's own namespace** goes first.
- **options ndots:5** — triggers the search-suffix expansion for names with fewer than 5 dots.

### Where does `10.96.0.10` come from?

Kubelet reads it from its own config:

```yaml
# /var/lib/kubelet/config.yaml
clusterDNS:
  - 10.96.0.10
clusterDomain: cluster.local
```

On kubeadm, this value is set during `kubeadm init` and usually left alone. It must point at a **Service ClusterIP** — typically the one fronting the CoreDNS Deployment. Kubelet does **not** install this on any interface; it's just a DNS server IP that CoreDNS's Service answers on.

```bash
# CoreDNS Service
kubectl -n kube-system get svc kube-dns
# NAME       TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)                     AGE
# kube-dns   ClusterIP   10.96.0.10   <none>        53/UDP,53/TCP,9153/TCP      ...

# The ClusterIP in the pod's resolv.conf must match this.
```

Historical naming quirk: the Service is called `kube-dns` even when the pods underneath are CoreDNS. This is for backward compatibility with kube-dns (the predecessor).

---

## Step 2: The ndots rule — why "web" expands

Libc resolvers (glibc, musl) follow the `ndots` rule:

- If a name has **fewer** than `ndots` dots, it is treated as "relative" and each search suffix is tried in order.
- If a name has **at least** `ndots` dots OR ends in `.`, it is treated as "absolute" and queried as-is.

Default in Kubernetes: `ndots: 5`. That is **very high** compared to most Linux systems (default is 1).

### Consequence: huge search fanout

```
query:              "web"                 → 0 dots, < 5 → expand search:
    try:            "web.default.svc.cluster.local"           → answer
    try (failed):   "web.svc.cluster.local"
    try (failed):   "web.cluster.local"
    try (absolute): "web"
```

Up to four queries for one lookup. But for **internal Service names in the same namespace**, the first expansion wins — fast.

Now consider an **external** name:

```
query:              "example.com"         → 1 dot, still < 5 → expand search:
    try (NXDOMAIN): "example.com.default.svc.cluster.local"
    try (NXDOMAIN): "example.com.svc.cluster.local"
    try (NXDOMAIN): "example.com.cluster.local"
    try (absolute): "example.com"              → answer
```

Four queries, three of which are wasted. This is **the classic Kubernetes DNS-latency trap** — apps making frequent external lookups get slow because every query does this NXDOMAIN cascade first.

### Mitigations

- **Use FQDNs with trailing dot**: `example.com.` (note the trailing dot). Skips search expansion entirely.
- **Set `dnsConfig.options`** on the pod to lower `ndots`:
  ```yaml
  spec:
    dnsConfig:
      options:
      - name: ndots
        value: "2"
  ```
- **Enable `autopath`** in CoreDNS (explained in the configmap-and-reload subtopic) — avoids server-side expansion.

For CKA purposes, know that `ndots: 5` is the cause behind "why does my DNS seem slow for external names?"

---

## Step 3: CoreDNS receives the query

A UDP packet arrives at `10.96.0.10:53`. kube-proxy's rules DNAT it to one of the CoreDNS pods (usually 2 replicas behind the `kube-dns` Service).

CoreDNS is a **plugin-chain server**. The Corefile (ConfigMap) declares which plugins are active for each zone:

```
.:53 {
    errors
    health
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    prometheus :9153
    forward . /etc/resolv.conf
    cache 30
    loop
    reload
    loadbalance
}
```

For a query `web.default.svc.cluster.local`:

1. The name matches the `cluster.local` zone.
2. The **kubernetes** plugin parses it into `(service, namespace) = (web, default)`.
3. It looks up the Service in CoreDNS's in-memory cache (populated by watching the Kubernetes API).
4. Returns the Service's ClusterIP as an A record.

For a query `example.com.`:

1. No zone matches specifically → falls through plugin chain.
2. The **forward** plugin sends the query to upstream DNS (e.g. `/etc/resolv.conf` of the CoreDNS pod, which on a kubeadm node is the node's DNS, which is the cloud's DNS or a public resolver).
3. Response comes back; CoreDNS caches and returns to the client.

---

## Step 4: CoreDNS's own DNS resolution (upstream)

CoreDNS is a pod. When it needs to resolve external names, it makes queries like any other process:

```bash
kubectl exec -n kube-system <coredns-pod> -- cat /etc/resolv.conf
# On modern kubeadm:
# nameserver 10.96.0.10
# search kube-system.svc.cluster.local svc.cluster.local cluster.local
# options ndots:5
```

Wait — **the CoreDNS pod's resolv.conf says CoreDNS is its own nameserver!** This would create a loop.

CoreDNS detects the loop via the `loop` plugin: on startup it does a test query and refuses to start if it sees itself in the path. The real trick is:

- CoreDNS's **forward** plugin is configured with `/etc/resolv.conf` — but it reads the **host's** resolv.conf, not the pod's, because it was compiled that way OR because kubelet configured the pod with `dnsPolicy: Default` (inherit from node).
- On kubeadm, the CoreDNS Deployment uses `dnsPolicy: Default`, so the pod's `/etc/resolv.conf` mirrors the host's, bypassing CoreDNS itself.

The net result: CoreDNS forwards external queries to the node's upstream DNS (e.g. `8.8.8.8`, or your VPC's resolver). No loop.

---

## Step 5: Response comes back to the pod

The answer (`A 10.96.0.50`) travels back:

```
CoreDNS pod → UDP reply → client pod's network namespace → libc returns IP to app
```

The pod then connects to `10.96.0.50:80`. kube-proxy takes over from here (see kube-proxy deck).

---

## The dnsPolicy field

The Pod spec's `dnsPolicy` controls how kubelet writes `/etc/resolv.conf`:

| Policy                    | Effect                                                                 |
|---------------------------|------------------------------------------------------------------------|
| `ClusterFirst` (default)  | Use cluster DNS; fall back to upstream for external                    |
| `ClusterFirstWithHostNet` | For pods with `hostNetwork: true`; forces cluster DNS (otherwise would inherit node DNS) |
| `Default`                 | Inherit DNS from the node (no cluster DNS)                             |
| `None`                    | Ignore defaults; use only `dnsConfig` field                            |

### Custom dnsConfig

With `dnsPolicy: None`, you can specify DNS entirely:

```yaml
spec:
  dnsPolicy: None
  dnsConfig:
    nameservers:
    - 1.1.1.1
    - 8.8.8.8
    searches:
    - example.com
    options:
    - name: ndots
      value: "2"
    - name: timeout
      value: "2"
```

Or, with `dnsPolicy: ClusterFirst`, you can **add to** the defaults:

```yaml
spec:
  dnsPolicy: ClusterFirst
  dnsConfig:
    nameservers:
    - 1.1.1.1              # added after cluster DNS
    options:
    - name: ndots
      value: "2"           # override ndots to 2
```

### hostNetwork pods

Pods with `hostNetwork: true` share the node's network namespace. Their `/etc/resolv.conf` comes from the node by default (`dnsPolicy: Default` implicit). If they need cluster DNS, set `dnsPolicy: ClusterFirstWithHostNet`.

---

## Host aliases — lightweight /etc/hosts entries

For static overrides without DNS:

```yaml
spec:
  hostAliases:
  - ip: 10.0.0.42
    hostnames:
    - db.internal
    - api.internal
```

Kubelet appends these to `/etc/hosts`. Libc looks up `/etc/hosts` before DNS (per `nsswitch.conf`), so these names resolve without touching CoreDNS.

Useful for:

- Testing without DNS.
- Hard-coding external addresses for pods in a locked-down namespace.
- Legacy shortcuts.

---

## The full lookup timing

For a cold query of a local service name:

```
Pod calls gethostbyname("web")
  libc expansion + send: ~1 ms
  UDP to CoreDNS Service IP: ~0.5 ms
  kube-proxy DNAT: ~0.1 ms
  CoreDNS query handling: ~0.1 ms
  UDP response: ~0.5 ms
  libc completion: ~0.5 ms
Total: < 3 ms on a healthy cluster
```

For a cold external query:

```
Pod queries "example.com" (3 expansions through cluster.local first)
  3x NXDOMAIN roundtrips: ~3 * 3 ms = 9 ms
  Final absolute query to external resolver: ~10-30 ms (WAN)
Total: ~15-40 ms
```

If you see orders of magnitude worse, something is wrong (CoreDNS overloaded, network issues, resolv.conf misconfigured).

---

## What can go wrong at each step

| Step                                    | Failure mode                                                  |
|-----------------------------------------|---------------------------------------------------------------|
| Pod's /etc/resolv.conf                  | Wrong nameserver IP (kubelet misconfigured)                    |
| UDP to CoreDNS Service                  | iptables rules missing (kube-proxy issue)                     |
| CoreDNS pod reachable                   | No CoreDNS pods Ready (crash, OOM, scheduling issue)          |
| Query parsing in kubernetes plugin      | Misconfigured `cluster.local` in Corefile                      |
| Service lookup                          | Service doesn't exist, or CoreDNS hasn't synced               |
| Response sent back                      | UDP packet lost, MTU issue, conntrack full                    |
| External forwarding                     | forward plugin's upstream unreachable                          |

Each of these has its own symptoms — covered in the dns-debug subtopic.

---

## Exam heuristics

- On any pod, `cat /etc/resolv.conf` is the first thing to check. If the nameserver is wrong, DNS is broken for this pod.
- `nslookup kubernetes.default` from inside any pod is the canonical "is cluster DNS alive" test (the "kubernetes" Service always exists in `default`).
- If external DNS is slow but internal DNS is fast, suspect the ndots:5 trap.
- CoreDNS runs in `kube-system` as a Deployment; its Service is named `kube-dns` (legacy name).
- ClusterDNS IP is typically the second IP in the service CIDR (`x.y.z.10` for `x.y.z.0/12`).

## Mental traps

- Confusing the **Service** `kube-dns` with the **software** CoreDNS. Older clusters actually ran kube-dns software; modern ones run CoreDNS but kept the Service name.
- Expecting pods to get the cluster DNS when `hostNetwork: true`. They inherit the host's DNS unless you set `ClusterFirstWithHostNet`.
- Thinking `ndots: 5` is aggressive for no reason. It's deliberate — it makes short names in the same namespace resolve fastest (first search suffix wins).
- Blaming apps for "slow DNS" when it's actually the ndots expansion for external names. Fix by using FQDN with trailing dot.
- Forgetting `hostAliases` exists. Quick-fix for static overrides.
- Modifying `/etc/resolv.conf` inside a container expecting it to persist. Kubelet rewrites it at pod creation; runtime edits are lost on container restart.
