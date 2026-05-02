## The cluster network model in one paragraph

Kubernetes mandates a very specific networking model, and then delegates the implementation to CNI plugins. The three rules are:

1. **Every pod gets a routable IP.** No NAT between pods.
2. **Pods on all nodes can communicate with each other** using that IP, without NAT.
3. **Node-local agents (kubelet, kube-proxy) can reach any pod on their node.**

Everything else — services, ingresses, network policies — is built on top of this flat, routable pod network. If the flat pod network is broken (CNI misconfigured, overlay packets not arriving), nothing above it works.

---

## The four kinds of communication

```
 ┌──────────────────────────────────────────────────────────┐
 │                     The cluster                           │
 │                                                            │
 │    ┌─────┐       ┌─────┐       ┌─────┐       ┌─────┐      │
 │    │ Pod │   ──► │ Pod │   ──► │ Pod │   ──► │ Pod │      │
 │    └─────┘       └─────┘       └─────┘       └─────┘      │
 │       │                                                    │
 │       │ ①  pod → pod                                       │
 │       │                                                    │
 │       │ ②  pod → service → pod                             │
 │       │                                                    │
 │       ▼                                                    │
 │     [Service ClusterIP]                                    │
 │                                                            │
 └──────────────────────────────────────────────────────────┘
                        ▲
                        │ ③  external → service (NodePort / LB / Ingress)
                        │
                  ┌─────────────┐
                  │ external    │
                  │ client      │
                  └─────────────┘
```

Four distinct kinds of traffic:

1. **Pod → pod** — same namespace / different namespace / same node / different node. Built entirely by the CNI. Services are not involved.
2. **Pod → service** — pod talks to a Service name (via DNS) or ClusterIP; kube-proxy rewrites to a real pod IP. Load balancing happens here.
3. **External → service** — NodePort, LoadBalancer, or Ingress terminate external traffic and hand it off to a Service.
4. **Pod → external** — pod talks to an internet address. Just source-NATed to the node's IP on egress.

"Networking is broken" almost always means one of these four paths is broken. The fastest triage question is: **which of the four is failing?**

---

## Where services fit

Pod IPs are ephemeral. A pod created today at `10.244.1.5` might be `10.244.3.17` tomorrow. Clients that hard-code pod IPs break on every pod restart.

A **Service** solves two problems at once:

- **Stable virtual IP** — the ClusterIP never changes even as the backing pods churn.
- **Load balancing** — the virtual IP is backed by N real pod IPs; kube-proxy spreads traffic across them.

The decoupling is: clients talk to a Service (by DNS name or ClusterIP). The Service's **selector** matches a set of pods. As those pods come and go, the list of real IPs behind the Service updates automatically. Clients never learn pod IPs directly.

Effectively, a Service is a **virtual load balancer embedded in the cluster network**, maintained by:

- The **endpoint(slice) controller** in kube-controller-manager: watches pods, updates EndpointSlice objects.
- **kube-proxy** on each node: reads EndpointSlices and programs iptables/IPVS rules so traffic to the ClusterIP is DNATed to a real pod IP.

---

## The two IP ranges in a cluster

Two non-overlapping CIDR blocks are configured at cluster creation:

| Range              | What lives in it                                      | Configured on                              |
|--------------------|-------------------------------------------------------|--------------------------------------------|
| **Pod CIDR**       | Every pod's IP (`status.podIP`)                        | CNI + `--cluster-cidr` on controller-manager |
| **Service CIDR**   | Every Service's ClusterIP                              | `--service-cluster-ip-range` on apiserver   |

Typical kubeadm defaults:

```
pod CIDR:     10.244.0.0/16      → pods get IPs like 10.244.1.5
service CIDR: 10.96.0.0/12       → services get IPs like 10.96.0.1, 10.96.0.10, ...
```

The first IP of the Service CIDR is always assigned to the "kubernetes" Service in the `default` namespace — the one that fronts the apiserver itself:

```bash
kubectl get svc kubernetes -n default
# NAME         TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)   AGE
# kubernetes   ClusterIP   10.96.0.1    <none>        443/TCP   ...
```

The second IP is typically for CoreDNS (`10.96.0.10`). The rest are allocated dynamically.

**Never change either CIDR on a running cluster.** Reconfiguring the Service CIDR in particular breaks every existing Service; their ClusterIPs suddenly don't match. You rebuild or migrate, you don't "edit."

---

## Pod-to-pod networking — CNI territory

Pod-to-pod traffic is implemented by the CNI plugin on each node. Three broad models:

### Overlay

Pod packets get wrapped in another IP header (VXLAN, IP-in-IP, WireGuard) and sent between nodes. The node's kernel decapsulates on arrival.

- **Flannel** (VXLAN mode) — classic overlay.
- **Calico** (IPIP mode) — Calico's fallback when routing isn't feasible.
- **Weave**, **Cilium** (with VXLAN) — also overlay.

Pros: works anywhere (no infrastructure cooperation needed).
Cons: per-packet overhead from encapsulation (small, but present).

### Routed / BGP

No encapsulation. Each node advertises its pod CIDR via BGP to the network; packets flow as plain IP, routed by the underlying network.

- **Calico** (BGP mode) — the common choice on-prem with ToR routers.
- **Cilium** (native routing) — BGP or plain routing mode.

Pros: no overhead, debuggable with standard IP tools.
Cons: needs network cooperation (routers that speak BGP, no source/destination MAC rewriting).

### eBPF / kernel-level

The CNI programs eBPF programs in the kernel that implement packet handling, bypassing large parts of netfilter.

- **Cilium** — the canonical example.
- **Calico** (eBPF data plane) — optional mode.

Pros: fastest, rich observability (flow logs, tracing).
Cons: kernel version requirements, more complexity.

You don't need to know the internals for CKA, but you do need to recognize that **pod-to-pod traffic is the CNI's job, not the Service's**. When pods can't reach each other at all, the problem is below the Service layer.

---

## Pod-to-service networking — kube-proxy territory

When a pod sends a packet to a Service ClusterIP (e.g. `10.96.0.42:80`), what happens depends on kube-proxy mode:

```
pod issues: curl 10.96.0.42:80
  ↓
  packet enters the node's network stack
  ↓
  iptables (or IPVS, or nftables) rules installed by kube-proxy match:
    "dst == 10.96.0.42:80" → DNAT to one of [10.244.1.5:8080, 10.244.2.7:8080, ...]
  ↓
  packet is now addressed to a real pod IP
  ↓
  CNI routes it to that pod (on same or another node)
  ↓
  pod receives it on :8080
```

Key implication: a Service's ClusterIP **never actually exists on any node's interface**. `ip addr` on any node will not show `10.96.0.42`. It's purely a DNAT target — a "virtual" IP that exists only in iptables/IPVS rules. Pings to a ClusterIP fail (ICMP isn't handled by those rules); TCP/UDP connections succeed because the rules rewrite them.

This is why troubleshooting flows like "check if port is open on the ClusterIP" make no sense at the IP level — you have to trace through the iptables or IPVS rules to see where traffic would go.

---

## Discoverability — DNS

Service discovery within the cluster uses DNS. The CoreDNS pods resolve names of the form:

```
<service-name>.<namespace>.svc.cluster.local      → ClusterIP
<pod-name>.<service-name>.<namespace>.svc.cluster.local  → pod IP (headless service)
```

Every pod's `/etc/resolv.conf` (configured by kubelet) points at the CoreDNS Service IP. A pod querying `my-svc.default.svc.cluster.local` gets an A record with the Service's ClusterIP, then connects to that.

Short forms work too (via `search` in resolv.conf):

```
my-svc                      ← resolves to my-svc in the pod's own namespace
my-svc.default              ← explicit namespace
my-svc.default.svc          ← explicit cluster.local elided
my-svc.default.svc.cluster.local    ← fully-qualified
```

DNS failures look like app-level failures ("cannot reach service"). Always verify DNS works before blaming the Service itself.

---

## External → service

Three ways external traffic reaches cluster workloads:

- **NodePort** — opens a port on every node's primary IP. External client hits `<node-ip>:<nodeport>`; kube-proxy DNATs to the Service.
- **LoadBalancer** — a cloud load balancer (NLB, GCLB, Azure LB) gets provisioned by the cloud controller. Its external IP DNATs to NodePort-style endpoints.
- **Ingress** / **Gateway API** — an L7 proxy (nginx, Contour, Traefik, Envoy) runs as pods, terminates HTTP/HTTPS, and forwards to Services.

Each has its own subtopic and tradeoffs. The common thread: external traffic always eventually hits a Service on the inside, which demultiplexes to pods.

---

## What this stack tells us about troubleshooting

When something is wrong, localize to a layer:

```
External client can't reach service?
 ├── Is LoadBalancer / Ingress working? (check cloud LB, check Ingress controller pods)
 ├── Does NodePort respond? → kube-proxy + Service layer
 └── Does ClusterIP work from inside the cluster? → the layers beneath are fine; it's external-only.

Pod can't reach service?
 ├── Does DNS resolve? (kubectl exec + nslookup)
 ├── Does the Service have Endpoints? (kubectl get endpoints ...)
 ├── Does curl on ClusterIP work? (kube-proxy rules OK?)
 └── Does curl on pod IP directly work? (CNI working?)

Pod can't reach pod?
 └── CNI is broken or network policy is blocking; not a Service issue.
```

Each step isolates a layer. Master this and "the network is broken" becomes "layer N is broken," which is much more tractable.

---

## Exam heuristics

- When asked "why can't the client reach the service?", always trace: DNS → Endpoints → kube-proxy → CNI. Find the first layer that fails.
- `kubectl get endpoints <svc>` (or `kubectl get endpointslices -l kubernetes.io/service-name=<svc>`) is the first diagnostic.
- ClusterIP is **virtual** — no interface has it. Don't ping it; use TCP/UDP.
- Every pod's DNS resolver is the CoreDNS Service ClusterIP (usually 10.96.0.10). Know this; it explains why DNS failures cascade.

## Mental traps

- Thinking a Service "contains" its pods. It selects them via labels; pods are independent and don't know about the Service.
- Believing a ClusterIP is assigned to some node. It isn't assigned to anything; it's a rule target.
- Conflating Service networking with CNI networking. Services are DNAT on top of a flat pod network; they don't route packets themselves.
- Assuming pings to a ClusterIP should work. They don't.
- Pinning services to specific IPs (`clusterIP: 10.96.1.42`). Fragile and almost never needed. Let allocation happen.
