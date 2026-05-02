## The object is inert without a controller

The #1 cause of "my Ingress isn't working" in fresh clusters:

> `kubectl apply -f ingress.yaml` succeeds, but external traffic never reaches anything.

Because the Ingress object is a **declaration**, not an implementation. No Kubernetes-provided component routes HTTP traffic based on Ingress rules. You must install an **Ingress controller** — a third-party deployment that:

1. Watches Ingress (and IngressClass) objects.
2. Configures a real L7 proxy (nginx, Envoy, HAProxy, Traefik) to match those rules.
3. Exposes itself via a Service that external clients reach (LoadBalancer or NodePort).

Without this, an Ingress is like a DNS CNAME pointing to nowhere.

Same story for Gateway API — no controller, no routing.

---

## The two layers involved

```
 External client
      │
      ▼
 [ Cloud LB (or node IP) ]           ← the thing DNS points at
      │
      ▼
 [ Ingress controller pod: nginx ]    ← has the actual L7 proxy
      │    reads Ingress / HTTPRoute objects
      │    rewrites nginx.conf
      │    reloads nginx
      ▼
 Backend Service (ClusterIP)         ← the Ingress `backend.service.name`
      │
      ▼
 Backend pods
```

Two things happen in parallel:

1. **Provisioning layer**: the controller deploys itself (as pods), and its Service requests a LoadBalancer, which the cloud controller provisions. Result: stable external IP.
2. **Routing layer**: the controller watches Ingress objects and reconfigures its proxy on every change.

---

## Installing an Ingress controller — the pattern

Every controller has a Helm chart or a deploy YAML. A typical install creates:

- A **Namespace** (`ingress-nginx`).
- A **Deployment** or **DaemonSet** of the controller pods.
- A **Service** of type LoadBalancer (or NodePort on bare metal) that routes external traffic to the controller.
- A **ServiceAccount** + **ClusterRole** + **ClusterRoleBinding** so the controller can watch Ingresses cluster-wide.
- An **IngressClass** named after the controller.
- ConfigMaps / Secrets for the controller's own config.

Example for ingress-nginx:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.x.x/deploy/static/provider/cloud/deploy.yaml

# Wait for pods
kubectl get pods -n ingress-nginx -w

# External IP
kubectl get svc ingress-nginx-controller -n ingress-nginx
# NAME                       TYPE           CLUSTER-IP      EXTERNAL-IP    PORT(S)
# ingress-nginx-controller   LoadBalancer   10.96.224.100   1.2.3.4        80:30080/TCP,443:30443/TCP

# The IngressClass it installed
kubectl get ingressclass
# NAME    CONTROLLER                      AGE
# nginx   k8s.io/ingress-nginx            2m
```

Now `Ingress.spec.ingressClassName: nginx` binds your Ingress to this controller.

---

## How the controller actually works

Take ingress-nginx as the example. Its control loop:

1. **Watch** Ingress, Service, Endpoints, Node, ConfigMap (and Gateway API objects if enabled).
2. **Cache** the current state via informers.
3. **Render** an nginx configuration file from the templated state.
4. **Diff** against the current nginx.conf on disk.
5. **Reload** nginx (graceful: new config, drain old, kill old process) if the config changed.
6. **Push** metrics about request count, latency, upstream availability.

The NGINX process inside the pod is the data plane. The Go controller sidecar writes its config. Reload cadence is usually seconds on pod churn, near-instant on Ingress changes.

### Example generated nginx block

An Ingress like:

```yaml
rules:
- host: shop.example.com
  http:
    paths:
    - path: /
      pathType: Prefix
      backend:
        service: { name: shop, port: { number: 80 } }
```

Renders roughly:

```nginx
upstream shop-default-80 {
    zone shop-default-80 256k;
    server 10.244.1.5:80;
    server 10.244.2.7:80;
    server 10.244.3.12:80;
}

server {
    listen 80;
    server_name shop.example.com;

    location / {
        proxy_pass http://shop-default-80;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

The upstream IPs come from the Service's **Endpoints** — the controller watches EndpointSlices, not just the Service, for accurate lists.

Important: the Ingress controller **bypasses kube-proxy for backends**. It sends directly to pod IPs, not to the Service ClusterIP. This saves a DNAT and avoids the kube-proxy overhead, but it also means kube-proxy's session affinity and some iptables tricks don't apply here — the controller does its own load balancing.

---

## Exposing the controller

The controller itself needs to be reachable from outside the cluster. Three common setups:

### Cloud LoadBalancer

```yaml
# The controller's own Service:
apiVersion: v1
kind: Service
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
spec:
  type: LoadBalancer
  selector:
    app.kubernetes.io/name: ingress-nginx
  ports:
  - name: http
    port: 80
    targetPort: http
  - name: https
    port: 443
    targetPort: https
```

The cloud controller provisions an LB → external IP → traffic routes to controller pods.

### NodePort (bare metal, minimal)

```yaml
spec:
  type: NodePort
  ports:
  - { name: http, port: 80, nodePort: 30080 }
  - { name: https, port: 443, nodePort: 30443 }
```

External clients hit `<any-node-ip>:30080`. DNS for apps points at the node IPs (round-robin A records) or an external LB that fronts the nodes.

### hostNetwork or host-local binding

```yaml
# Controller pods use the host's network namespace:
spec:
  hostNetwork: true
  containers:
  - name: controller
    ports:
    - containerPort: 80
      hostPort: 80
    - containerPort: 443
      hostPort: 443
```

Every node that runs a controller pod opens 80/443 on its own IP. Common for on-prem or single-node clusters. Limits: each port is exclusive, so only one controller per node.

### MetalLB for bare metal LB

MetalLB installs as a controller that watches Services of `type: LoadBalancer` and assigns external IPs from a pool (via BGP or ARP). With MetalLB installed, the cloud pattern works on bare metal.

---

## The Service ↔ Ingress handshake

Ingress refers to Services; controllers reach pods via Endpoints:

```
Ingress                  Service                Endpoints            Pod
───────                  ───────                ───────              ────
spec.backend.service     name: shop             10.244.1.5:80        pod A
                         ports: [ {port: 80,    10.244.2.7:80        pod B
                                   targetPort:  10.244.3.12:80       pod C
                                   8080}]
```

The controller:

1. Reads the Ingress → resolves the backend Service by name.
2. Looks up the Service's Endpoints (via EndpointSlice).
3. Programs its proxy to forward to those pod IPs.

If the Service has **no Endpoints**, the Ingress still exists but can't route. The controller typically returns 503 Service Temporarily Unavailable.

This is why a broken Ingress often traces to a broken Service — check Endpoints first.

---

## Gateway controller install

Gateway API controllers install similarly: a CRD bundle for the API itself, then a controller deployment.

```bash
# Install Gateway API CRDs (standard channel)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.x.x/standard-install.yaml

# Install a controller — example: NGINX Gateway Fabric
kubectl apply -f https://github.com/nginxinc/nginx-gateway-fabric/releases/download/vX.Y.Z/deploy.yaml

# The controller creates a GatewayClass
kubectl get gatewayclass
# NAME    CONTROLLER                               ACCEPTED   AGE
# nginx   gateway.nginx.org/nginx-gateway-controller   True    1m
```

Now create a Gateway referencing that class, then HTTPRoutes attached to the Gateway.

Other common controllers:

- **Envoy Gateway** — Envoy-based, officially CNCF-backed.
- **Contour** — Envoy-based, supports both Ingress and Gateway API.
- **Traefik** — supports both.
- **Cilium** — Cilium-specific Gateway API implementation on top of its eBPF data plane.
- **Istio** — service mesh with Gateway API support.

---

## Multi-controller clusters

A cluster can run multiple Ingress controllers simultaneously, each serving a different class:

```bash
kubectl get ingressclass
# NAME       CONTROLLER                      AGE
# nginx      k8s.io/ingress-nginx            30d
# traefik    traefik.io/ingress-controller   30d
# alb        ingress.k8s.aws/alb             30d
```

An Ingress with `ingressClassName: nginx` is handled by nginx; `ingressClassName: alb` goes to the AWS Load Balancer Controller. You can mix: public-facing nginx for HTTP, AWS ALB for traffic that needs VPC-specific features.

Same pattern for GatewayClass — multiple classes, each tied to a controller.

### The default class

If one IngressClass is annotated:

```yaml
metadata:
  annotations:
    ingressclass.kubernetes.io/is-default-class: "true"
```

Ingresses without `ingressClassName` use that class. Avoids boilerplate but can be confusing if someone installs a new "default" class that hijacks existing Ingresses.

---

## The controller's own dependencies

Controllers are Kubernetes workloads. They depend on:

- **The apiserver** to watch Ingress/Gateway/Service objects.
- **DNS** to resolve their own internal references.
- **Network reachability** from pods to the apiserver (via the kubernetes Service, via kube-proxy).

An Ingress controller on a CNI-broken node is itself unreachable. Cascades are possible: CNI breaks → Ingress controller's probes fail → controller removes pods from its own Service's Endpoints → external LB marks nodes unhealthy → external traffic drops.

---

## Inspecting controller state

### Ingress-nginx

```bash
# Controller pods
kubectl get pods -n ingress-nginx

# Logs
kubectl logs -n ingress-nginx -l app.kubernetes.io/component=controller --tail=100

# Exec into the controller (nginx-specific)
kubectl exec -it -n ingress-nginx <controller-pod> -- nginx -T      # dump rendered config
kubectl exec -it -n ingress-nginx <controller-pod> -- nginx -t      # test config
```

### Traefik

```bash
kubectl logs -n traefik deploy/traefik
# Traefik has a dashboard/API (if enabled):
kubectl port-forward -n traefik svc/traefik-dashboard 9000:9000
# Browse http://localhost:9000/dashboard/
```

### Gateway controllers

Each has its own diagnostics. Look at:

- The Gateway's `.status.listeners[].conditions` for "Programmed=True."
- The HTTPRoute's `.status.parents[].conditions` for "Accepted=True" and "ResolvedRefs=True."

---

## Controller failure modes

### Controller pod CrashLoopBackOff

Usually config parsing or missing secrets. `kubectl logs` tells the story.

### Controller pod Running but no routing

- Controller can't reach apiserver (RBAC issue, network).
- No IngressClass or GatewayClass defined.
- Ingresses don't reference the right class.

### Controller reloads constantly

Every Ingress / Endpoint change triggers a reload. On busy clusters this kills performance. Mitigations:

- Enable Lua-based dynamic configuration (ingress-nginx can update upstreams without reloading nginx).
- Batch updates via the controller's sync period.

### One controller pod serves traffic, others don't

LB round-robin may pick any controller pod. If one is unhealthy, requests fail intermittently. Ensure the controller's readiness probe is working and the LB's health check matches.

---

## Production considerations

- **Run 2+ replicas** of the controller. Single-replica is a SPOF.
- **Use anti-affinity** so replicas are on different nodes.
- **Monitor request latency and error rate** — Prometheus metrics ship from most controllers.
- **Version-pin the controller**. Controller API can change between versions; don't run `latest`.
- **Test failover** by killing a controller pod during load.

For Gateway API, you often want a platform team to own GatewayClass and Gateway, with tenants creating HTTPRoutes only. Set `allowedRoutes.namespaces.from: Selector` with label filters so tenants only attach to permitted Gateways.

---

## Exam heuristics

- Always check `kubectl get ingressclass` before creating an Ingress — confirm a controller is installed.
- If an Ingress exists but requests fail, check:
  1. Controller pods Running?
  2. IngressClass matches?
  3. Backend Service has Endpoints?
- The controller's own Service tells you the external IP — `kubectl get svc -n <controller-ns>`.
- For bare-metal exams, remember MetalLB or NodePort for exposing the controller.

## Mental traps

- Applying an Ingress on a cluster with no controller, then wondering why nothing routes. Check `kubectl get ingressclass`.
- Forgetting the Ingress controller is itself a workload. If kubelet / CNI is broken, the controller is broken.
- Assuming the controller talks to backends via ClusterIP. It doesn't — it talks directly to pod IPs from Endpoints.
- Installing two controllers with the same default-class annotation. They fight over which Ingresses they handle.
- Expecting annotations from one controller to work on another. They rarely do.
- Running a Gateway controller but not creating a Gateway. HTTPRoutes need a parent Gateway.
- Using `hostNetwork: true` for an Ingress controller on every node without ensuring port 80/443 are free. Collides with anything else listening on those ports.
