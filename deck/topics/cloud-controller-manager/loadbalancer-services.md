## What `type: LoadBalancer` actually does

Without CCM:

```yaml
apiVersion: v1
kind: Service
metadata: { name: web }
spec:
  type: LoadBalancer
  selector: { app: web }
  ports:
  - { port: 80, targetPort: 8080 }
```

```bash
kubectl get svc web
# NAME   TYPE           CLUSTER-IP    EXTERNAL-IP   PORT(S)
# web    LoadBalancer   10.96.0.50    <pending>     80:30080/TCP
```

`EXTERNAL-IP: <pending>` forever. The Service has a NodePort assigned (30080), but no cloud load balancer.

With CCM (in a cloud cluster):

```bash
kubectl get svc web
# NAME   TYPE           CLUSTER-IP    EXTERNAL-IP    PORT(S)
# web    LoadBalancer   10.96.0.50    1.2.3.4        80:30080/TCP
```

The Service controller in CCM saw the new Service, created an LB in the cloud, registered nodes as backends, updated the Service's status with the LB's IP/hostname.

---

## The Service controller's flow

When `type: LoadBalancer` is created or updated:

```
 1. Service controller observes the Service.
 2. Adds finalizer service.kubernetes.io/load-balancer-cleanup
    (so accidental Service deletion doesn't leave orphaned cloud LBs).
 3. Computes target nodes:
    - Cluster mode (default): all nodes (with optional filtering via labels).
    - Local mode (externalTrafficPolicy: Local): only nodes with a Ready local pod.
 4. Calls cloud API:
    - Create LB if it doesn't exist.
    - Configure listeners (port mapping).
    - Configure target group / backend pool with node IPs.
    - Configure health check.
 5. Updates Service status:
    .status.loadBalancer.ingress = [{ip: 1.2.3.4}] or [{hostname: foo.elb.amazonaws.com}]
```

When the Service is deleted:

```
 1. apiserver marks Service for deletion (deletionTimestamp).
 2. Service controller sees the deletion, calls cloud API to delete the LB.
 3. Once cloud LB is gone, finalizer is removed.
 4. Service object is fully deleted.
```

The finalizer ensures the LB is cleaned up even if Kubernetes-side state is gone.

---

## Watching the lifecycle

```bash
# Create the Service
kubectl apply -f service.yaml

# Watch for the EXTERNAL-IP to appear
kubectl get svc web -w

# Logs
kubectl logs -n kube-system -l k8s-app=cloud-controller-manager | grep web
# "Creating load balancer for service ..."
# "Successfully created load balancer ..."
```

In a healthy cluster: 30 seconds to a few minutes for the LB to provision.

If it stays `<pending>`:

```bash
# Service has events?
kubectl describe svc web | tail -20

# CCM logs show the issue
kubectl logs -n kube-system <ccm-pod>
```

Common: cloud API denied (IAM), quota exceeded (too many LBs), service annotations malformed.

---

## externalTrafficPolicy

```yaml
spec:
  type: LoadBalancer
  externalTrafficPolicy: Cluster        # | Local
```

| Policy   | Behavior                                                                                  |
|----------|-------------------------------------------------------------------------------------------|
| `Cluster` (default) | LB → any node → any pod. SNAT happens on the node-to-pod hop. Source IP lost. |
| `Local`  | LB → only nodes with a local pod. No SNAT. Source IP preserved.                           |

For Local:

- LB health-checks each node on the Service's `spec.healthCheckNodePort`. CCM provisions this; the apiserver allocates one from the NodePort range.
- Nodes without a local Ready pod return 503 to the LB; LB routes to other nodes.

This is how cloud LBs preserve client IP without sacrificing distribution. But it requires more careful pod scheduling (some nodes have pods, some don't, all are visible to the LB).

---

## The healthCheckNodePort field

For `externalTrafficPolicy: Local`:

```yaml
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local
  healthCheckNodePort: 32000             # auto-allocated if not specified
```

```bash
# Verify
kubectl get svc web -o jsonpath='{.spec.healthCheckNodePort}'
# 32000

# What does it serve?
curl http://<any-node-ip>:32000/healthz
# 200 if this node has a local Ready pod; 503 otherwise.
```

The cloud LB hits this endpoint per node. Excludes nodes returning 503.

For `externalTrafficPolicy: Cluster`, `healthCheckNodePort` is unused (LB just round-robins to all nodes).

---

## Cloud-specific annotations

Each cloud's Service controller reads annotations to customize the LB:

### AWS (EKS, kops, etc.)

```yaml
metadata:
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"            # NLB instead of classic ELB
    service.beta.kubernetes.io/aws-load-balancer-scheme: "internal"      # internal-only
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
    service.beta.kubernetes.io/aws-load-balancer-target-type: "ip"        # vs "instance"
    service.beta.kubernetes.io/aws-load-balancer-ssl-cert: "arn:aws:acm:...:certificate/..."
    service.beta.kubernetes.io/aws-load-balancer-ssl-ports: "443"
    service.beta.kubernetes.io/aws-load-balancer-backend-protocol: "tcp"
```

### GCP

```yaml
metadata:
  annotations:
    cloud.google.com/load-balancer-type: "Internal"                       # internal LB
    networking.gke.io/load-balancer-type: "Internal"
    cloud.google.com/network-tier: "Premium"                              # vs Standard
```

### Azure

```yaml
metadata:
  annotations:
    service.beta.kubernetes.io/azure-load-balancer-internal: "true"
    service.beta.kubernetes.io/azure-load-balancer-resource-group: "my-rg"
```

These annotations are **not portable** between clouds. Migrating from AWS to GCP means rewriting them. This is one of the reasons Gateway API exists — annotations were the only way to express advanced features.

---

## The finalizer

```bash
kubectl get svc web -o jsonpath='{.metadata.finalizers}'
# ["service.kubernetes.io/load-balancer-cleanup"]
```

This finalizer prevents the Service from being deleted until the cloud LB is also deleted. Without it, you could `kubectl delete svc web`, the Service object would vanish, but the cloud LB would persist (and bill you).

If a Service is stuck `Terminating`:

- The CCM is failing to clean up the cloud LB.
- Possibly: cloud API auth issue, LB stuck in a weird state, manual deletion of the LB out-of-band.

Check CCM logs. As a last resort:

```bash
# Manually remove the finalizer (dangerous — leaves orphan LB if CCM hasn't cleaned up)
kubectl patch svc web -p '{"metadata":{"finalizers":[]}}' --type=merge
```

---

## Single-LB-per-Service pattern

By default, each `type: LoadBalancer` Service gets its own cloud LB. Cloud LBs cost money — typically per LB per hour, regardless of traffic.

In production, this gets expensive fast. Mitigation:

- Use **Ingress** instead of multiple LB Services. One LB → Ingress controller → many Services.
- Cloud-native Ingress controllers (AWS Load Balancer Controller, GCP Ingress) provision LBs for Ingress resources.

Save `type: LoadBalancer` for non-HTTP traffic or genuinely single-service exposes.

### Ingress and the LB

When you install an Ingress controller (e.g. nginx-ingress), it deploys:

- Controller pods.
- A Service of `type: LoadBalancer` for the controller itself.

Now there's **one** LB at the cloud level, fronting the controller. Many Ingress objects route to many Services through that one LB.

---

## Static / pre-allocated external IP

Cloud LBs typically get dynamic IPs. To pin a specific IP (allocated in the cloud first):

### AWS

```yaml
metadata:
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-eip-allocations: "eipalloc-0a1b2c"
```

### GCP

```yaml
spec:
  type: LoadBalancer
  loadBalancerIP: "1.2.3.4"             # this IP must be reserved in GCP first
```

For most clouds, the older `spec.loadBalancerIP` field is being deprecated in favor of cloud-specific annotations.

---

## LB IP allocation in `<pending>` debugging

If the EXTERNAL-IP stays `<pending>` for >5 minutes:

```bash
# 1. CCM running?
kubectl get pods -n kube-system | grep cloud-controller

# 2. CCM logs
kubectl logs -n kube-system <ccm-pod> | tail -50 | grep -E 'service|loadbalancer|<service-name>'

# 3. Common errors:
#    - "AccessDenied": IAM lacks elasticloadbalancing:* (AWS)
#    - "ResourceQuotaExceeded": cloud account at LB limit
#    - "InvalidParameterValue": annotation conflict

# 4. Service events
kubectl describe svc web | tail -10

# 5. Manually create an LB via cloud CLI to test cred
aws elbv2 describe-load-balancers --region us-east-1
# If this fails with same auth error, IAM is the problem.
```

---

## When to delete the LB before deleting the Service

Sometimes you want to keep the cloud LB around (preserve its IP) while temporarily deleting the Service. Procedure:

1. Update Service to `type: ClusterIP` first (CCM will delete the LB; status changes).
2. Or: change the LB allocation to be reserved beforehand, then re-applied when the Service is recreated.

The default lifecycle treats Service ↔ LB as 1:1. To break that, use cloud-native ingress / external IP management.

---

## Common LB issues

### EXTERNAL-IP stays `<pending>`

CCM not running, IAM denied, quota exceeded, annotation typo. Logs reveal.

### LB created but traffic not routing

LB exists at the cloud but pods can't be reached:

- Backend group / target group has no nodes registered.
- Health check failing — wrong port, wrong path.
- Security group / firewall blocking traffic from LB to nodes.

Per-cloud diagnostics:

```bash
# AWS
aws elbv2 describe-target-health --target-group-arn <arn>

# GCP
gcloud compute backend-services get-health <service-name>
```

### LB has wrong scheme (public vs internal)

Annotation mismatch. `service.beta.kubernetes.io/aws-load-balancer-internal=true` flips between public and internal. Editing the Service updates the annotation, CCM recreates / reconfigures the LB.

### Slow LB updates

Most clouds' LB APIs aren't instant. Adding/removing a node from a target group takes seconds to minutes. During scale-up, traffic to a new node may be routed before pods are Ready (mitigated by readiness probes + health checks).

---

## Service status field

```bash
kubectl get svc web -o jsonpath='{.status.loadBalancer}'
# {"ingress":[{"ip":"1.2.3.4"}]}

# Or hostname-based (e.g. AWS ELB v1)
# {"ingress":[{"hostname":"foo.elb.us-east-1.amazonaws.com"}]}
```

Use this in scripts:

```bash
LB_IP=$(kubectl get svc web -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
LB_HOST=$(kubectl get svc web -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
```

DNS for the Service: point at the LB IP/hostname.

---

## Cleaning up orphaned LBs

If a Service is force-deleted (finalizer removed), the cloud LB is orphaned:

```bash
# AWS: list LBs created by Kubernetes (named with cluster-id prefix usually)
aws elbv2 describe-load-balancers --query 'LoadBalancers[?starts_with(LoadBalancerName, `a-`)].{Name:LoadBalancerName,DNS:DNSName}'

# Identify orphans (those without a corresponding Service)
# Manually delete:
aws elbv2 delete-load-balancer --load-balancer-arn <arn>
```

Each cloud has its own cleanup tool. Watch your cloud bill for unexpected LB charges — could indicate orphans.

---

## Dual-stack and LBs

If the cluster is dual-stack:

```yaml
spec:
  type: LoadBalancer
  ipFamilies: [IPv4, IPv6]
  ipFamilyPolicy: PreferDualStack
```

CCM may provision an LB with both IPv4 and IPv6 frontends. Per-cloud support varies.

---

## Bare-metal alternatives — MetalLB

For bare-metal clusters, MetalLB simulates `type: LoadBalancer`:

- Watches Services of `type: LoadBalancer`.
- Picks an IP from a configured pool.
- Advertises the IP via BGP (BGP mode) or ARP/ND (Layer 2 mode).
- Sets `status.loadBalancer.ingress` so kubectl shows the IP.

Acts like a CCM for the LB part only. Doesn't do node sync or routes — those aren't relevant on bare metal.

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: default-pool
  namespace: metallb-system
spec:
  addresses:
  - 192.168.10.100-192.168.10.150
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: default
  namespace: metallb-system
```

After installing MetalLB + applying these CRDs, `type: LoadBalancer` Services work on bare metal.

---

## Exam heuristics

- For `EXTERNAL-IP: <pending>` on a non-cloud cluster, install MetalLB or use NodePort.
- For "create a LoadBalancer Service in the cloud" exam, check the CCM is running.
- Cloud annotations are not portable; match them to the cloud the cluster runs on.
- `externalTrafficPolicy: Local` preserves client IP at the cost of even distribution.

## Mental traps

- Expecting bare-metal clusters to populate `EXTERNAL-IP`. They won't.
- Editing annotations and being surprised LB recreation takes time. Cloud APIs are slow.
- Confusing `loadBalancerIP` (deprecated in many clouds) with cloud-specific annotations.
- Assuming each `type: LoadBalancer` is "free" — they cost real money per hour. Use Ingress for HTTP.
- Force-removing the LB finalizer. Orphan LB, bills you forever.
- Using `externalTrafficPolicy: Local` without health-checking awareness — when no pod is local on a given node, that node returns 503 and traffic skips it. Cloud LB must be configured to honor health checks.
- Mixing AWS and GCP annotations on the same Service. Each is ignored by the other cloud's CCM; the LB doesn't get the customization.
