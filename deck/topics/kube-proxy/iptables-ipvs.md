## Three modes, one job

kube-proxy has three Linux modes (plus `kernelspace` on Windows). They do the same thing — DNAT Service IPs to pod IPs — but via different kernel mechanisms with very different scaling characteristics.

```
mode=iptables     (default)   — netfilter rules via iptables-legacy or iptables-nft
mode=ipvs                      — IPVS kernel module (ip_vs), hash-table lookup
mode=nftables                  — native nftables, same model as iptables but modern
```

Choose based on scale and kernel. Defaults are fine for most clusters.

---

## Mode comparison at a glance

|                            | iptables                        | ipvs                               | nftables                         |
|----------------------------|---------------------------------|------------------------------------|----------------------------------|
| Default?                   | Yes                             | No, requires config                | No, requires kernel 5.13+        |
| Scaling with # of Services | O(N) rule chain traversal       | O(1) hash lookup                   | Between iptables and IPVS        |
| Kernel deps                | `xt_*` modules, netfilter       | `ip_vs*` modules                   | `nf_tables`                      |
| Scheduling algorithms      | random only (pseudo-even)       | rr / lc / sh / dh / lblc / wlc / nq / sed | random only                |
| Session affinity           | via `recent` module             | native IPVS persistence             | via `meta` match                 |
| Visible state              | `iptables-save`                 | `ipvsadm -Ln`                      | `nft list ruleset`               |
| Rule update cost           | High at scale (full rewrite)    | Low (adjust hash)                  | Lower than iptables              |
| Sweet spot                 | < 1000 services                  | > 1000 services                    | future default                   |

---

## iptables mode — the default

### Rule structure

Each Service gets a chain of rules. The in-kernel traversal is:

```
packet with dst 10.96.0.50:80 on node
    │
    ▼
nat table, PREROUTING chain
    │
    ▼
KUBE-SERVICES chain (standard entry for all kube-proxy rules)
    │
    ▼  match: d=10.96.0.50, dport=80
KUBE-SVC-<hash>
    │
    ▼  statistic --mode random probability 0.33  →  KUBE-SEP-<ep1>
    │  statistic --mode random probability 0.50  →  KUBE-SEP-<ep2>
    │  (fallthrough)                              →  KUBE-SEP-<ep3>
    ▼
KUBE-SEP-<epX>
    │
    ▼  DNAT to 10.244.2.7:8080
```

### Pseudo-round-robin via probability cascade

iptables doesn't have a native round-robin selector. kube-proxy uses **cumulative probabilities**:

- Endpoint 1: matches with probability 1/N
- Endpoint 2: matches with probability 1/(N-1) of remaining
- ...
- Endpoint N: always matches (last-rule fallthrough)

Over many packets the distribution evens out. Any single packet is "random": two packets from the same client may go to two different endpoints unless sessionAffinity is on.

### Scale concerns

Each endpoint costs one rule in KUBE-SVC-xxx and one chain KUBE-SEP-xxx. For 1000 Services × 10 endpoints:

- ~10,000 KUBE-SEP chains.
- ~10,000 rules in various KUBE-SVC chains.
- Total ~30,000 rules plus overhead.

Each kube-proxy sync serializes the entire ruleset and hands it to `iptables-restore`. At this scale:

- Each sync takes hundreds of ms to seconds.
- CPU on the node spikes during sync.
- Kernel briefly has higher per-packet cost while rules are being applied.

iptables fundamentally scales linearly with Service-endpoint product. Fine up to a few thousand services; painful beyond.

### iptables-legacy vs iptables-nft

On modern distros, the `iptables` command is often a wrapper over `nft` (the nftables API), not the original iptables. kube-proxy in "iptables mode" works with either, but it does care which backend is active — mismatched backends between kube-proxy and the CNI (or the CNI's network policy engine) cause silent rule conflicts.

Check:

```bash
iptables --version
# iptables v1.8.x (nf_tables) ← nft backend
# iptables v1.8.x (legacy)    ← legacy backend
```

kube-proxy auto-detects. CNIs like Calico and Cilium have their own guidance. Keep them aligned.

---

## IPVS mode — the scale answer

### What IPVS is

IPVS (IP Virtual Server) is a Linux kernel subsystem for L4 load balancing. It precedes Kubernetes by decades — it was built for LVS ("Linux Virtual Server") clusters. It uses a hash table of virtual servers to real servers, so lookup is O(1) regardless of size.

### Rule structure

Instead of netfilter rules, kube-proxy programs IPVS tables:

```
# Virtual Service: 10.96.0.50:80 → real servers
TCP  10.96.0.50:80 rr
  -> 10.244.1.5:8080              Masq    1      0          0
  -> 10.244.2.7:8080              Masq    1      0          0
  -> 10.244.3.12:8080             Masq    1      0          0
```

- `TCP 10.96.0.50:80 rr` — Service ClusterIP + port, scheduler `rr` (round-robin).
- Three real servers with weight 1 each.
- `Masq` mode — NAT-based forwarding.
- Columns after are (weight, active-conns, inactive-conns).

### Scheduling algorithms

Set via kube-proxy config:

```yaml
ipvs:
  scheduler: rr        # round-robin (default)
```

Supported values:

| Value | Name                    | Behavior                                                     |
|-------|-------------------------|--------------------------------------------------------------|
| `rr`  | Round Robin             | Each new connection goes to next endpoint. Default.          |
| `lc`  | Least-Connection        | Sends to endpoint with fewest active connections.             |
| `sh`  | Source Hash             | Hash of source IP picks endpoint; affinity-like.              |
| `dh`  | Destination Hash        | Hash of destination IP; unusual in Kubernetes context.        |
| `lblc`| Locality-Based Least-Connection | Prefers local endpoints when usage is even.         |
| `sed` | Shortest Expected Delay | Weighted-LC with expected response time estimation.           |
| `nq`  | Never Queue             | Pick an idle endpoint immediately; don't queue.               |
| `wlc` | Weighted LC             | LC with endpoint weights.                                     |
| `wrr` | Weighted RR             | Round-robin with endpoint weights.                            |

Most clusters use `rr`. `lc` is a reasonable choice for varying-duration connections. `sh` is a way to get session affinity at load-balancer level.

### IPVS requires a few extra pieces

1. **Kernel modules**: `ip_vs`, `ip_vs_rr`, `ip_vs_wrr`, `ip_vs_sh`, `nf_conntrack`. Must be loadable:
   ```bash
   modprobe ip_vs
   modprobe ip_vs_rr
   modprobe ip_vs_wrr
   modprobe ip_vs_sh
   modprobe nf_conntrack
   ```
   Put in `/etc/modules-load.d/kube-proxy.conf` for persistence.

2. **`ipvsadm` tool**: `apt install ipvsadm` / `yum install ipvsadm`. Not strictly required for kube-proxy's operation, but essential for debugging.

3. **`strictARP` on kube-proxy**: if using MetalLB in L2 (ARP) mode, you need:
   ```yaml
   ipvs:
     strictARP: true
   ```
   so the ARP broadcasts don't conflict with MetalLB's.

### What you see with IPVS

```bash
# All virtual services and their real servers
sudo ipvsadm -Ln

# Stats
sudo ipvsadm -Ln --stats

# Active connections
sudo ipvsadm -Lnc

# Clear everything (destructive; kube-proxy will reprogram)
sudo ipvsadm -C
```

### IPVS still uses iptables for some things

Even in IPVS mode, kube-proxy installs a few iptables rules — for NodePort entry, for SNAT (masquerade) on egress from a Service endpoint, for marking packets. You'll see a lightweight KUBE-MARK-MASQ / KUBE-POSTROUTING. This is normal; the **per-service fanout** is in IPVS, not iptables.

---

## nftables mode — the future

### Why it exists

iptables is old. Its rule model doesn't compose well, syntax is awkward, performance scales poorly. nftables is the designated replacement in the Linux kernel.

kube-proxy's nftables mode implements the same KUBE-SERVICES → KUBE-SVC → KUBE-SEP model, but using native nftables rules. The performance profile is closer to IPVS than to iptables, without requiring a separate kernel subsystem.

### Requirements

- Kubernetes 1.29+ (beta) / 1.31+ (stable-ish).
- Kernel 5.13+ (5.8 minimum; 5.13 for full feature set).
- nftables userspace tool (`nft`) on nodes, for kube-proxy to call.

### Visible state

```bash
nft list table ip kube-proxy
nft list table ip6 kube-proxy        # dual-stack
```

Rule structure mirrors iptables conceptually (per-service, per-endpoint chains, DNAT). The syntax is different but the mental model carries over.

### When to use

If you're setting up a new cluster today and your kernel + Kubernetes version support it, nftables mode is the forward-compatible choice. Otherwise, iptables or IPVS based on scale.

---

## How to switch modes

Edit the kube-proxy ConfigMap:

```bash
kubectl edit cm kube-proxy -n kube-system
```

Change the `mode:` line:

```yaml
data:
  config.conf: |
    apiVersion: kubeproxy.config.k8s.io/v1alpha1
    kind: KubeProxyConfiguration
    mode: ipvs                         # ← was iptables
    ipvs:
      scheduler: rr
```

Then restart the DaemonSet:

```bash
kubectl rollout restart daemonset kube-proxy -n kube-system
```

Watch pods restart, verify new mode:

```bash
kubectl logs -n kube-system <kube-proxy-pod> | head
# "Using iptables proxy" vs "Using ipvs Proxier"
```

Don't flip modes casually. Changing mid-traffic means all Service rules are torn down and reinstalled in the new mode. Brief connection drops (~seconds per node) are expected during the transition.

---

## Which mode when?

### Stick with iptables if:

- < 1000 Services × endpoints.
- Kubernetes < 1.29 or kernel < 5.13.
- No specific performance complaints.

### Move to IPVS if:

- \> 1000 Services or you're hitting sync latency issues.
- Need LC / SH scheduling.
- Happy to install extra kernel modules.

### Try nftables if:

- Modern kernel and Kubernetes.
- Starting fresh and want future-proofing.
- Avoiding iptables' growing tech debt.

On a typical kubeadm lab cluster, **iptables** is perfectly adequate. You'll rarely need to change it for CKA practice.

---

## Exam heuristics

- The exam doesn't usually ask you to switch modes, but may ask what mode is in use. `kubectl -n kube-system get cm kube-proxy -o yaml | grep mode:` answers it.
- `iptables-save | grep KUBE-SVC` works in iptables mode; `ipvsadm -Ln` in IPVS. Know both.
- Unreachable service + node has kube-proxy running + endpoints exist → inspect actual rules with the right tool for the mode.
- When scenario has IPVS mode + MetalLB, expect `strictARP: true` to be relevant.

## Mental traps

- Thinking IPVS fully replaces iptables. It doesn't — kube-proxy still writes some iptables rules for SNAT and NodePort entry in IPVS mode.
- Expecting "random" selection to be perfectly even per client. It's per-packet (or per-connection) random; evens out over many connections.
- Switching to IPVS without loading kernel modules. kube-proxy crashes with a confusing kernel error.
- Benchmarking iptables vs IPVS at tiny scale (10 services) and concluding IPVS is slower. Overhead of the IPVS lookup is only worth it at scale.
- Leaving `strictARP: false` with MetalLB L2. ARP probes go sideways, services flap.
- Expecting nftables and iptables to coexist peacefully. Mixing the two backends on one node is a support mess; pick one.
