## What kube-proxy really is

A **DaemonSet of one pod per node**, watching the API and programming the kernel. Nothing in the data path — kube-proxy never sees a real packet. It just writes rules.

```
apiserver / etcd
  │
  │ watches: Services, EndpointSlices, Nodes
  ▼
┌──────────────────────────┐
│      kube-proxy           │  (one pod per node, in kube-system)
│                            │
│   control loop:            │
│   reconcile kernel rules   │
└──────────────┬────────────┘
               │ iptables / ipvsadm / nftables calls
               ▼
┌──────────────────────────┐
│  Linux kernel             │
│  netfilter / IPVS         │  ← actual packet handling happens here
└──────────────────────────┘
```

When a client sends a packet to a Service's ClusterIP:

1. The packet hits the node's kernel.
2. netfilter (or IPVS) matches an installed rule.
3. The rule **DNATs** the destination to one of the Service's endpoint pod IPs.
4. The packet gets forwarded to that pod (via CNI routing).

kube-proxy itself is not on the datapath. If kube-proxy crashes, the **existing** rules keep routing traffic — but rules don't update. New Services become unreachable; Endpoint changes don't propagate; old endpoints may receive traffic after pods are gone.

---

## The control loop

```
loop:
  events := watch(Services, EndpointSlices)
  if events received within (minSyncPeriod):
    batch them
  state := build full desired rule set from cache
  diff := compare desired vs current kernel rules
  apply diff (iptables-restore / ipvsadm / nftables)
```

Key parameters:

- `--config-sync-period` (default 15 min) — forced full resync even without events. Belt-and-braces.
- `iptables.minSyncPeriod` (default 1 s) — don't reapply more often than this. Batches rapid churn.
- `iptables.syncPeriod` (default 30 s, legacy) — historical full-sync trigger; mostly superseded.

These matter when many services change at once (mass pod restarts, rolling updates of large Deployments): kube-proxy batches changes to avoid thrashing the kernel.

---

## What rules look like (iptables mode)

The hierarchy on a node with one Service fronting three pods:

```
PREROUTING / OUTPUT
    │
    ▼
KUBE-SERVICES         ← entry chain; one rule per ClusterIP
    │
    ▼ (matches ClusterIP:port)
KUBE-SVC-<hash-of-svc>    ← per-service chain
    │
    ▼ (random selection among endpoints)
KUBE-SEP-<hash-of-endpoint>   ← per-endpoint chain
    │
    ▼ (DNAT rule)
pod IP : target port
```

The rules you'd see with `iptables-save | grep KUBE-`:

```
# entry point
-A KUBE-SERVICES -d 10.96.0.50/32 -p tcp -m tcp --dport 80 -j KUBE-SVC-X7M

# per-service: random probability cascade
-A KUBE-SVC-X7M -m statistic --mode random --probability 0.33333 -j KUBE-SEP-A1
-A KUBE-SVC-X7M -m statistic --mode random --probability 0.50000 -j KUBE-SEP-B2
-A KUBE-SVC-X7M -j KUBE-SEP-C3

# per-endpoint: DNAT to pod IP
-A KUBE-SEP-A1 -p tcp -j DNAT --to-destination 10.244.1.5:8080
-A KUBE-SEP-B2 -p tcp -j DNAT --to-destination 10.244.2.7:8080
-A KUBE-SEP-C3 -p tcp -j DNAT --to-destination 10.244.3.12:8080
```

Note the cascade: first rule matches with probability 1/3, next matches with probability 1/2 of remaining, last always matches. Over many packets, each endpoint gets ~1/3 of traffic. Pseudo-random, not strictly round-robin.

### Why three chains?

- **KUBE-SERVICES** is one entry; every incoming packet with dst in the Service CIDR hits it. Scales O(1) to find the right service.
- **KUBE-SVC-xxx** has one rule per endpoint; scales O(N) with endpoint count. Short for most services.
- **KUBE-SEP-xxx** is one rule per endpoint; the DNAT itself.

For a cluster with 1000 Services × 10 endpoints, you end up with ~10,000 KUBE-SEP chains plus the SVC chains. iptables becomes slow to reprogram at that scale — which is why IPVS exists.

---

## What kube-proxy does **not** do

- **Does not route pod-to-pod traffic.** That's the CNI's job.
- **Does not handle L7** (HTTP paths, headers). That's Ingress / Gateway.
- **Does not implement NetworkPolicy.** That's the CNI (Calico, Cilium, Antrea implement their own netfilter rules for policy).
- **Does not assign Pod IPs.** CNI does.
- **Does not maintain DNS.** CoreDNS does.

Knowing what kube-proxy **doesn't** do saves time when debugging — don't blame kube-proxy for DNS failures or inter-pod connectivity issues.

---

## The NodePort path

NodePort adds rules for accepting packets on the node's IPs:

```
INPUT / PREROUTING
    │
    ▼
KUBE-NODEPORTS                       ← jump target from KUBE-SERVICES
    │
    ▼ (matches nodePort)
KUBE-EXT-<hash-of-svc>                ← per-service "external" chain
    │
    ▼ (usually SNATs for Cluster policy, doesn't for Local)
KUBE-SVC-<hash-of-svc>                ← same service chain as ClusterIP
```

The result: external traffic hits the node's IP:nodePort, gets DNATed to a pod, and the source IP is optionally SNATed (externalTrafficPolicy determines this). From the pod's perspective, it sees traffic from either the original client (Local) or the node (Cluster).

---

## Health check on NodePort

When `externalTrafficPolicy: Local` is set, kube-proxy also opens a small HTTP endpoint for cloud LBs to health-check:

```
<node-ip>:<healthCheckNodePort>/healthz
```

Returns 200 if this node has at least one local Ready pod; 503 otherwise. Cloud LBs (AWS NLB, GCP LB) configure target group health checks against this endpoint, so they automatically exclude nodes without local pods. Without this, `externalTrafficPolicy: Local` would cause connections to nodes-without-pods to fail.

The port is auto-allocated from the NodePort range, visible via `kubectl get svc -o jsonpath='{.spec.healthCheckNodePort}'`.

---

## Load-balancer IP on the node (bare metal quirk)

On bare-metal clusters using MetalLB, kube-vip, or similar, the LoadBalancer's external IP is actually **advertised** by one node (BGP) or held as a VIP (ARP) on one node. Traffic to the external IP arrives at that node, which then behaves like a NodePort: kube-proxy's rules DNAT to a pod.

In the cloud, the cloud LB itself does the external-IP part; kube-proxy sees only NodePort traffic. Either way, the kube-proxy half looks the same from the inside.

---

## The session affinity implementation

```yaml
spec:
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIPConfig:
      timeoutSeconds: 10800
```

kube-proxy implements this differently per mode:

- **iptables**: uses the `recent` module to remember recent source IPs and pin subsequent connections from the same IP to the same endpoint.
- **IPVS**: uses IPVS's built-in persistence (`-p` flag on `ipvsadm` virtual server).

Both use the client IP only — not port — so multiple connections from the same client go to the same backend. Useful for sticky sessions (web apps that keep session in pod memory). Ineffective when many clients share one source IP (a NAT'd office).

---

## Where kube-proxy lives on a kubeadm cluster

- **DaemonSet** in `kube-system`:
  ```bash
  kubectl get ds kube-proxy -n kube-system
  ```
- **ConfigMap** with its config:
  ```bash
  kubectl get cm kube-proxy -n kube-system -o yaml
  ```
- **RBAC** via a dedicated ServiceAccount `kube-proxy` with ClusterRole `system:node-proxier`.

Key configuration in that ConfigMap:

```yaml
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
mode: iptables                       # iptables | ipvs | nftables
clusterCIDR: 10.244.0.0/16           # pod network
iptables:
  masqueradeAll: false               # SNAT everything (not recommended)
  masqueradeBit: 14
  minSyncPeriod: 1s
ipvs:
  scheduler: rr                      # rr | lc | sh | dh | ...
  syncPeriod: 30s
  strictARP: false
```

Switching modes requires editing this ConfigMap + restarting the kube-proxy DaemonSet pods.

---

## When kube-proxy fails

### Symptom: Services don't route at all

- kube-proxy pod on this node is crashing or not running.
- `kubectl logs -n kube-system <kube-proxy-pod>` shows the issue (usually a permissions problem, bad config, or missing kernel module for IPVS).

### Symptom: Services work for some but not all nodes

- Only some nodes have kube-proxy running. Check the DaemonSet's ready replicas:
  ```bash
  kubectl get ds kube-proxy -n kube-system
  ```
- A node's kube-proxy was not restarted after a config change and has stale rules.

### Symptom: Services work but new Endpoints never get traffic

- kube-proxy's watch on EndpointSlices is broken. Check logs for watch errors.
- A pod never appeared in EndpointSlices (see no-endpoints-triage).

### Symptom: Sessions reshuffle on every connection despite ClientIP affinity

- Affinity timeout expired between connections.
- Client is behind a load balancer that changes source IP.
- IPVS mode didn't propagate the session table on a kube-proxy restart (rare).

---

## Exam heuristics

- When "the Service isn't working," always check that kube-proxy is running on the relevant node(s). A crashed pod can be the answer.
- `iptables-save | grep KUBE-SVC-` lists all installed Service rules. Useful when an exam says "why isn't this reaching the pod?"
- On IPVS clusters, `ipvsadm -Ln` is the equivalent. Memorize both.
- kube-proxy's config is in ConfigMap `kube-proxy` in `kube-system`. Edit it + restart DaemonSet to change modes.
- If the kube-proxy ConfigMap references `mode: ipvs` but the kernel doesn't have the IPVS module loaded, kube-proxy crashes. Install `ipvsadm` and `modprobe ip_vs` on nodes before switching.

## Mental traps

- Treating kube-proxy as a data-path proxy. It isn't — rules are — which means restarting kube-proxy doesn't (usually) interrupt existing connections.
- Blaming kube-proxy for DNS failures. DNS is CoreDNS's problem; kube-proxy only routes to the CoreDNS Service ClusterIP.
- Believing all traffic goes through kube-proxy. Pod-to-pod traffic bypasses the Service layer entirely.
- Expecting `ping <ClusterIP>` to work. kube-proxy's rules handle TCP/UDP; ICMP has no corresponding rule.
- Forgetting that kube-proxy's health on a node depends on reaching the apiserver. If apiserver is unreachable, kube-proxy can't refresh rules.
- Thinking restarting kube-proxy fixes Endpoint issues. It only re-syncs kernel rules from its cache; if the cache is populated correctly, nothing changes.
