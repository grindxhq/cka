## Five service types, one object

All five service types are `kind: Service`. They differ only in `spec.type` and a handful of related fields. Under the hood they layer:

```
ExternalName   ← DNS only, no proxying
ClusterIP      ← base: virtual IP + Endpoints + kube-proxy rules
  NodePort     ← ClusterIP + opens a port on every node
    LoadBalancer ← NodePort + cloud LB in front
Headless       ← special case of ClusterIP: no virtual IP, DNS returns pod IPs
```

You don't get to skip layers. A LoadBalancer is also a NodePort is also a ClusterIP. Knowing this makes debugging straight: if the LB is broken, try the NodePort; if the NodePort is broken, try the ClusterIP; if the ClusterIP is broken, the problem is below the Service layer entirely.

---

## ClusterIP — the default

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  # type: ClusterIP     — implicit default
  selector:
    app: web
  ports:
    - name: http
      port: 80          # Service's virtual port
      targetPort: 8080  # port on each backing pod
      protocol: TCP
```

What happens:

1. Apiserver allocates a ClusterIP from the `--service-cluster-ip-range` block. That IP is now reserved in etcd.
2. Endpoint(Slice) controller watches pods with `app: web` and writes their IPs + port 8080 into EndpointSlices.
3. kube-proxy on every node installs iptables/IPVS rules: "traffic to `<cluster-ip>:80` → DNAT to one of the endpoint IPs at port 8080."

From inside the cluster, anything can reach the service by ClusterIP or by DNS (`web.default.svc.cluster.local`). From outside the cluster, there is no path — ClusterIP is not routable externally.

### Assigning a specific ClusterIP

```yaml
spec:
  clusterIP: 10.96.0.50
```

Rarely needed. The only legitimate uses are pinning well-known services (CoreDNS at 10.96.0.10, kubernetes at 10.96.0.1 — both set by the cluster itself). Don't pin unless you have a real reason.

### Dual-stack

On dual-stack clusters, a Service can have two ClusterIPs — one IPv4, one IPv6:

```yaml
spec:
  ipFamilies: [IPv4, IPv6]
  ipFamilyPolicy: PreferDualStack   # or RequireDualStack, SingleStack
  clusterIPs:
  - 10.96.1.50
  - fd00::1:50
```

Each IP family gets its own EndpointSlices (`addressType: IPv4` or `IPv6`).

---

## NodePort — expose on every node

```yaml
spec:
  type: NodePort
  selector:
    app: web
  ports:
    - name: http
      port: 80           # ClusterIP port (still exists)
      targetPort: 8080   # pod port
      nodePort: 30080    # optional; auto-allocated from 30000-32767 if omitted
      protocol: TCP
```

Three IPs are now in play:

- **ClusterIP** (e.g. `10.96.0.50:80`) — in-cluster virtual IP, unchanged from ClusterIP service.
- **NodePort** (e.g. `<any-node-ip>:30080`) — external port, opened on every node.
- **Pod IP** (e.g. `10.244.1.5:8080`) — the actual backend.

External clients hit any node's IP on port 30080 → kube-proxy DNATs to a pod. The node that receives the external packet might or might not host a backing pod; kube-proxy will still route correctly (just with an extra hop and SNAT, see below).

### externalTrafficPolicy

```yaml
spec:
  externalTrafficPolicy: Cluster   # default — route to any pod, SNATed
  # or
  externalTrafficPolicy: Local     # route only to pods on same node, preserve client IP
```

- **Cluster** — external traffic can go to any pod; kube-proxy SNATs (source IP becomes the node's IP). Client IP is lost. Works on any node.
- **Local** — only forward to pods on the same node; drop if none. Client IP is preserved. But nodes without a backing pod return connection refused — external LBs must health-check per-node to avoid them.

`Local` is the answer when you need client IP (e.g. for access logs or allow-lists). `Cluster` is the default and fine for most.

### Nuances with NodePort

- The port range (default 30000–32767) is configured on the apiserver via `--service-node-port-range`. Port collisions across services are prevented.
- The port is opened on **every** node, even nodes that don't host any matching pod. This uniformity is the feature.
- On some managed platforms, NodePort is blocked by default from the internet; only the load balancer is accessible. Don't rely on NodePort as a production external interface unless the network allows it.
- Hostports (on pods) are different from NodePorts — don't confuse them.

---

## LoadBalancer — cloud-provisioned external

```yaml
spec:
  type: LoadBalancer
  selector:
    app: web
  ports:
    - name: http
      port: 80
      targetPort: 8080
```

Layered on top of NodePort: the cloud controller manager observes the Service and provisions a cloud load balancer (AWS NLB, GCP Network LB, Azure LB) that forwards traffic to the cluster nodes at the NodePort.

Flow:

```
internet → cloud LB (public IP, say 1.2.3.4:80)
          → DNAT to <node-ip>:30080 on a cluster node
          → kube-proxy DNAT to pod IP:8080
```

The LB's external IP appears in `status.loadBalancer.ingress`:

```bash
kubectl get svc web -o jsonpath='{.status.loadBalancer.ingress}'
# [{"ip":"1.2.3.4"}]
```

If you don't have a cloud controller (bare metal, kubeadm lab), the `EXTERNAL-IP` stays `<pending>` forever. That's your signal.

### LoadBalancer on bare metal

**MetalLB** and **kube-vip** implement LoadBalancer on bare metal by advertising the service IP via BGP or ARP. You install the controller, give it a pool of IPs, and from then on `type: LoadBalancer` works like it does in the cloud.

### externalTrafficPolicy: Local + LoadBalancer

Same semantics as NodePort. The cloud LB is expected to health-check each node on the NodePort; it excludes nodes without a backing pod so the "connection refused" case never arrives. All major cloud LB integrations handle this correctly.

### Annotations — cloud-specific flags

Cloud controllers read annotations to customize LB behavior:

```yaml
metadata:
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"                    # AWS NLB
    networking.gke.io/load-balancer-type: "Internal"                             # GKE internal LB
    service.beta.kubernetes.io/azure-load-balancer-internal: "true"              # Azure internal
    service.beta.kubernetes.io/aws-load-balancer-scheme: "internal"              # AWS internal
```

These are not portable across clouds. Memorize only the ones for your platform.

---

## ExternalName — DNS CNAME, nothing else

```yaml
apiVersion: v1
kind: Service
metadata:
  name: db
spec:
  type: ExternalName
  externalName: db.prod.example.com
```

What happens:

- **No** ClusterIP is allocated.
- **No** selector, **no** Endpoints.
- **No** kube-proxy rules.
- Pods querying `db.default.svc.cluster.local` get a DNS **CNAME** response pointing to `db.prod.example.com`.
- Pods then resolve that CNAME, connect to the external address, normal internet traffic.

Use cases:

- A cluster-native alias for an external database.
- Cross-namespace aliases (`db` in namespace `A` pointing to `db.B.svc.cluster.local`).
- Legacy migrations — start with `ExternalName`, flip to regular Service when you cut over.

Does **not** work for:

- TCP/HTTP clients that don't follow CNAMEs.
- Cross-cluster service discovery if the target DNS isn't resolvable from inside the cluster.

---

## Headless — no virtual IP, DNS returns pod IPs

```yaml
apiVersion: v1
kind: Service
metadata:
  name: mysql
spec:
  clusterIP: None          # explicitly: no virtual IP
  selector:
    app: mysql
  ports:
    - port: 3306
      targetPort: 3306
```

Headless services are a special mode of ClusterIP:

- **No ClusterIP** assigned; `CLUSTER-IP` field shows `None`.
- **No kube-proxy rules** — kube-proxy ignores headless services.
- **DNS A records point directly at pod IPs** — one A record per ready pod.

Example resolution with three pods:

```
$ nslookup mysql.default.svc.cluster.local
mysql.default.svc.cluster.local has address 10.244.1.5
mysql.default.svc.cluster.local has address 10.244.2.7
mysql.default.svc.cluster.local has address 10.244.3.12
```

Clients receive all three; the client chooses which to connect to (often round-robin via the resolver, or app-level sharding).

### Headless + StatefulSet

StatefulSets require a headless service because they need **stable per-pod DNS names**:

```yaml
# StatefulSet with serviceName: mysql and 3 replicas:
mysql-0.mysql.default.svc.cluster.local → mysql-0's IP
mysql-1.mysql.default.svc.cluster.local → mysql-1's IP
mysql-2.mysql.default.svc.cluster.local → mysql-2's IP
```

Only headless services emit these per-pod DNS names. A regular (ClusterIP) service fronts pods anonymously; a headless one lets you address them by name.

### Headless without selector

Same as ClusterIP without selector — you manage Endpoints manually. DNS returns whatever IPs you wrote there.

---

## Choosing between types

| Use case                                           | Type                                      |
|----------------------------------------------------|-------------------------------------------|
| In-cluster microservice                            | ClusterIP (default)                       |
| Testing external access on kubeadm/vagrant         | NodePort                                   |
| Production external access in the cloud            | LoadBalancer (or Ingress + LB)             |
| StatefulSet requiring stable per-pod DNS            | Headless (`clusterIP: None`)               |
| Alias for external service                          | ExternalName                               |
| Many HTTP services on one IP                        | ClusterIP + Ingress (not LoadBalancer each)|
| Bare metal with external access                     | MetalLB + LoadBalancer, or NodePort + external LB |

LoadBalancer per service is expensive (cloud LB per service = per-service cost). For HTTP traffic, one Ingress fronting many Services is the norm.

---

## Relevant fields on Service

Beyond `type` and `ports`:

| Field                           | Purpose                                                   |
|---------------------------------|-----------------------------------------------------------|
| `selector`                      | Label selector for backing pods                            |
| `clusterIP` / `clusterIPs`      | Specific IP(s) to pin; usually auto-allocated              |
| `externalName`                  | Target for ExternalName                                    |
| `externalIPs`                   | Additional IPs to accept traffic on (bare metal trick)     |
| `loadBalancerIP` (deprecated)   | Request specific LB IP                                     |
| `loadBalancerClass`             | Route to a specific LB provider when multiple exist         |
| `loadBalancerSourceRanges`      | CIDRs allowed to reach the LB                              |
| `sessionAffinity`               | `None` (default) or `ClientIP`                             |
| `sessionAffinityConfig.clientIPConfig.timeoutSeconds` | Affinity TTL (default 10800)             |
| `internalTrafficPolicy`         | `Cluster` (default) / `Local` — in-cluster traffic routing |
| `externalTrafficPolicy`         | `Cluster` (default) / `Local` — external traffic routing   |
| `publishNotReadyAddresses`      | Include not-ready pods in Endpoints (for headless + peer discovery) |
| `allocateLoadBalancerNodePorts` | For LB services, whether to allocate NodePorts (default true) |

Knowing these exist is half of understanding what a given Service does.

---

## Exam heuristics

- The default `type: ClusterIP` is implicit. Don't over-specify.
- For exam scenarios "make this reachable from outside without a cloud LB" → NodePort.
- For "make this reachable from outside in production" → LoadBalancer (cloud) or Ingress (HTTP).
- For StatefulSets in the exam, always write a headless Service with the same name as `serviceName`.
- NodePort range is 30000-32767 by default — know this when the exam asks for a specific port.
- `externalTrafficPolicy: Local` is the answer when the scenario says "preserve client IP."

## Mental traps

- Confusing LoadBalancer's `EXTERNAL-IP: <pending>` as a bug. On bare metal without MetalLB, it stays pending forever — that's expected, not a problem.
- Using `type: LoadBalancer` per service in an HTTP cluster. One Ingress fronting many Services is cheaper and more flexible.
- Assuming `clusterIP: None` means the Service is broken. Headless services are intentional.
- Confusing `hostPort` (on a pod) with `nodePort` (on a service). HostPort opens a port on the pod's node only, no load balancing.
- Setting `externalIPs` thinking it's managed automatically. It isn't — you're responsible for routing those IPs to the nodes.
- Forgetting that `ExternalName` doesn't do any proxying. Clients must be able to resolve and reach the target directly.
