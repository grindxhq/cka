## Two APIs, same job

Kubernetes has two APIs for exposing HTTP(S) services externally:

- **Ingress** — old, stable, ubiquitous, frozen at v1. Every cluster has it.
- **Gateway API** — newer, more expressive, being promoted as the successor. CKA scope increasingly includes basic knowledge.

Both solve the same core problem: **route external HTTP traffic to internal Services based on hostname and path**. The differences are in expressiveness and how roles are separated.

Most existing production clusters use Ingress. New designs and multi-tenant platforms are moving to Gateway API. Both are worth understanding.

---

## Why an L7 layer exists

Service types cover L4: route IP:port traffic to pods. Good for one protocol, one port. But most clusters have many HTTP services, and provisioning a LoadBalancer per service is expensive (cloud LB per service = money + IPs).

The L7 layer consolidates:

- One LB IP fronts many services.
- Routing by hostname or path multiplexes them.
- TLS termination happens once at the edge.
- Future cross-cutting features (auth, rate limit, header rewrite) can be centralized.

The L7 proxy is almost always a **pod** in the cluster (nginx, Envoy, HAProxy) configured by a controller reading Ingress/Gateway objects. The proxy itself is exposed via a Service of type LoadBalancer.

```
 External client
     ▼
 Cloud LB (or bare-metal LB)      ← one IP
     ▼
 Ingress controller pods          ← L7 proxy (nginx, Envoy)
     ▼
 Service (ClusterIP)              ← chosen by path / host routing
     ▼
 Backend pods
```

---

## Ingress: the classic API

### The resource

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: default
spec:
  ingressClassName: nginx             # which controller handles this?
  rules:
  - host: shop.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: shop-frontend
            port:
              number: 80
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: shop-api
            port:
              number: 8080
  - host: admin.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: admin-web
            port:
              number: 80
  tls:
  - hosts:
    - shop.example.com
    - admin.example.com
    secretName: ingress-tls
  defaultBackend:
    service:
      name: fallback
      port: { number: 80 }
```

What's in it:

- **`ingressClassName`** — names an IngressClass → which controller implements this. Absent → uses the default class. No controller → the Ingress is inert.
- **`rules[]`** — host-based routing. Each rule has a `host` (wildcard `*.example.com` allowed) and `http.paths[]`.
- **`paths[]`** — path-based routing within a host. `pathType` controls how paths match (see below).
- **`backend.service.name/port`** — where to send matching requests.
- **`tls[]`** — list of host-to-Secret mappings for TLS termination. The Secret must be type `kubernetes.io/tls` with `tls.crt` and `tls.key` keys.
- **`defaultBackend`** — fallback for requests not matching any rule.

### pathType matching

```yaml
paths:
- path: /foo
  pathType: Prefix            # /foo, /foo/, /foo/bar all match
- path: /exact-bar
  pathType: Exact             # only /exact-bar matches; /exact-bar/ does not
- path: /legacy
  pathType: ImplementationSpecific  # controller-defined (regex, etc.)
```

- **Prefix** — most common. Matches anything starting with the path.
- **Exact** — must match the full path, case-sensitive.
- **ImplementationSpecific** — passes the raw path to the controller, which interprets per its own rules. ingress-nginx treats it as regex if you add annotations; Traefik has its own DSL.

### Default backend

```yaml
defaultBackend:
  service:
    name: 404-page
    port: { number: 80 }
```

Used when no rule matches. Often points at a "404" landing page. Optional.

### TLS Secrets

```bash
# Create a TLS Secret (shorthand)
kubectl create secret tls ingress-tls \
  --cert=path/to/fullchain.pem \
  --key=path/to/privkey.pem

# Reference it in Ingress.spec.tls[].secretName
```

The controller terminates TLS at the edge; backend services receive plain HTTP.

### Annotations — the escape hatch

Ingress's frozen spec lacks many features (header manipulation, weighted routing, auth). Controllers use **annotations** on the Ingress to extend:

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
```

Every controller has its own annotation namespace. Portability is poor — migrating from nginx to Traefik means rewriting annotations. This is a major reason Gateway API exists.

### Multiple Ingress objects for one host

Multiple Ingresses can have rules for the same host — they merge. Useful for "one Ingress per team" in a multi-tenant cluster.

---

## IngressClass

A cluster can have multiple Ingress controllers, each exposed via its own IngressClass.

```yaml
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: nginx
  annotations:
    ingressclass.kubernetes.io/is-default-class: "true"   # this class is the default
spec:
  controller: k8s.io/ingress-nginx
  parameters:                                              # optional CRD with class-wide config
    apiGroup: elbv2.k8s.aws
    kind: IngressClassParams
    name: aws-ingress
```

An Ingress references a class by name:

```yaml
spec:
  ingressClassName: nginx
```

Missing → uses the default class (if one is annotated). Pattern: one default for easy labs, multiple classes for production clusters running nginx + AWS ALB side-by-side.

---

## Gateway API: the modern replacement

### Why it exists

Ingress's limitations bite at scale:

- **Annotations for everything** — non-portable.
- **No standard for multi-protocol** (TCP, UDP, gRPC as first-class).
- **Role confusion** — the same Ingress object mixes "infrastructure decisions" (which LB, what TLS) and "app routing" (which pod gets which path).
- **No native weighted routing** for blue/green.

Gateway API splits roles and resources:

| Role                  | Resource       | Owner              |
|-----------------------|----------------|--------------------|
| Infrastructure        | GatewayClass   | Platform team     |
| Cluster ops           | Gateway        | Cluster operator  |
| App development       | HTTPRoute (etc.) | App team        |

### GatewayClass

Like IngressClass but broader:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: nginx
spec:
  controllerName: gateway.nginx.org/nginx-gateway-controller
  # optional parametersRef for class-level config
```

A controller watches GatewayClasses matching its `controllerName` and acts on Gateways bound to them.

### Gateway

The actual listener configuration — an instance of a GatewayClass:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: main-gateway
  namespace: gateway-system
spec:
  gatewayClassName: nginx
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    allowedRoutes:
      namespaces:
        from: Same
  - name: https
    protocol: HTTPS
    port: 443
    tls:
      mode: Terminate
      certificateRefs:
      - name: tls-cert
        kind: Secret
    hostname: "*.example.com"
    allowedRoutes:
      namespaces:
        from: All                      # or Selector: matchLabels: ...
```

Listeners define:

- Port and protocol.
- TLS (terminate, passthrough, or none).
- Hostname filter (wildcard allowed).
- Which namespaces are allowed to attach routes (`Same`, `All`, or a label selector).

A Gateway is owned by the cluster operator. App teams in permitted namespaces can attach HTTPRoutes.

### HTTPRoute

The app-facing resource that declares "traffic matching X goes to service Y":

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shop
  namespace: default
spec:
  parentRefs:
  - name: main-gateway
    namespace: gateway-system
  hostnames:
  - shop.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: shop-frontend
      port: 80
      weight: 90
    - name: shop-canary                 # native weighted routing
      port: 80
      weight: 10
  - matches:
    - path:
        type: PathPrefix
        value: /api
    - method: POST                       # native method matching
    filters:
    - type: RequestHeaderModifier
      requestHeaderModifier:
        set:
        - name: X-Tenant
          value: shop
    backendRefs:
    - name: shop-api
      port: 8080
```

Features that were annotations-only in Ingress:

- `weight` — traffic splitting (canary, blue/green).
- `matches` can include `headers`, `queryParams`, `method` in addition to path.
- `filters` — native header manipulation, request mirroring, URL rewrite.
- `parentRefs` in different namespaces — cross-namespace attachment (controlled by the Gateway's `allowedRoutes`).

### Other route kinds

For non-HTTP:

- **TCPRoute** — raw TCP (databases, custom protocols).
- **TLSRoute** — TLS passthrough (terminate at backend, route by SNI).
- **GRPCRoute** — first-class gRPC with method matching.
- **UDPRoute** — datagrams (DNS, NTP).

Not every controller supports every route kind. Check your CNI's / gateway controller's support matrix.

---

## Ingress vs Gateway API — the trade

| Aspect                          | Ingress                           | Gateway API                          |
|---------------------------------|-----------------------------------|--------------------------------------|
| Stability                       | Stable, frozen                    | Stable (v1 HTTPRoute since 2023)    |
| Ubiquity                        | Every cluster                     | Opt-in, controllers vary              |
| Multi-protocol                  | HTTP only                          | HTTP/gRPC/TCP/TLS/UDP                 |
| Routing by headers/method       | Via annotations                    | Native                                |
| Weighted routing                | Via annotations                    | Native                                |
| Cross-namespace routing         | No                                 | Yes (with controls)                   |
| Role separation                 | Single object                      | GatewayClass/Gateway/Route            |
| Portability across controllers  | Poor (annotations)                 | Good (standard)                       |
| Existing ecosystem              | Everything supports it             | Growing                               |

### When to use what

- **Legacy apps / existing clusters** — stay on Ingress until migration is worth the cost.
- **New platforms, multi-tenant** — Gateway API. Role separation matches real org boundaries.
- **Complex routing (canary, gRPC, weighted)** — Gateway API. Annotations for this in Ingress are painful.
- **Cloud-native LBs (AWS ALB controller, GCP LB)** — most have Gateway API support; use the cloud-provider-idiomatic choice.

---

## Where TLS fits

### Ingress TLS

```yaml
spec:
  tls:
  - hosts: [ shop.example.com ]
    secretName: ingress-tls
```

The controller terminates TLS at the edge. Backend services receive plain HTTP unless you also configure backend TLS (controller-specific annotations, e.g., `nginx.ingress.kubernetes.io/backend-protocol: HTTPS`).

### Gateway API TLS

Listener-scoped:

```yaml
listeners:
- name: https
  protocol: HTTPS
  port: 443
  tls:
    mode: Terminate           # controller decrypts
    certificateRefs:
    - kind: Secret
      name: tls-cert
```

Or:

```yaml
  tls:
    mode: Passthrough          # TLS passes through to backend
```

Passthrough uses TLSRoute for SNI-based routing.

### Automated cert management

Manually creating TLS secrets isn't sustainable. Use **cert-manager**:

```yaml
metadata:
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
  - hosts: [ shop.example.com ]
    secretName: shop-tls
  rules: ...
```

cert-manager sees the annotation, provisions a Let's Encrypt certificate via ACME, writes the Secret. Rotation is automatic.

---

## Minimum viable Ingress setup

On a fresh cluster:

1. Install an Ingress controller:
   ```bash
   kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/cloud/deploy.yaml
   ```
2. Wait for the controller's LoadBalancer Service to get an external IP:
   ```bash
   kubectl get svc ingress-nginx-controller -n ingress-nginx --watch
   ```
3. Point DNS at that IP.
4. Create an Ingress object with matching `ingressClassName: nginx`.

On bare metal, replace step 2 with MetalLB or NodePort.

For Gateway API:

1. Install the Gateway API CRDs:
   ```bash
   kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.x.x/standard-install.yaml
   ```
2. Install a Gateway controller (nginx-gateway, Envoy Gateway, etc.).
3. Create GatewayClass (usually by the controller install), Gateway (by you), HTTPRoute (by apps).

---

## Exam heuristics

- Ingress is what CKA scenarios have historically used. Know the spec cold.
- `ingressClassName` is the key field linking Ingress to a controller; forget it and the Ingress sits inert.
- `pathType: Prefix` is almost always what you want. Exact is rare.
- For TLS, create a Secret of type `kubernetes.io/tls` with `tls.crt` and `tls.key`; reference it in `spec.tls[].secretName`.
- Remember Ingress's defaultBackend — useful for "serve a static 404" scenarios.
- Gateway API knowledge is increasingly expected. Know the three-resource model (GatewayClass, Gateway, HTTPRoute).

## Mental traps

- Applying an Ingress without installing a controller — the object exists, nothing routes.
- Forgetting `ingressClassName` and relying on the default. Multiple classes can exist; wrong defaults cause hard-to-find issues.
- Using `pathType: Exact` expecting partial match.
- Pointing DNS at a node IP while expecting LoadBalancer semantics (including node failover). Point DNS at the LB IP.
- Treating Gateway API listeners as app-level config. They're infrastructure — app teams interact via HTTPRoutes.
- Believing cross-namespace routing "just works" in Gateway API. You must set `allowedRoutes.namespaces.from` on the Gateway.
- Expecting annotations from one Ingress controller to work on another. They rarely do.
