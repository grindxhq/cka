## Why this is its own subtopic

"A Service selects pods via labels" is the cartoon version. The real mechanism involves **two controllers, one or more EndpointSlices per Service, four readiness-related conditions per endpoint, and readiness probes gating the whole thing**. Understanding each link explains why your Service might have no Endpoints even though 10 matching pods exist and are Running.

---

## The selector → EndpointSlice pipeline

```
Pod                                 Service
 labels:                              selector:
   app: web              ────────►      app: web
   tier: frontend                       tier: frontend
                                          │
                                          │ endpointslice-controller watches
                                          ▼
                            EndpointSlice (discovery.k8s.io/v1)
                            ─ labels: kubernetes.io/service-name: web
                            ─ addressType: IPv4
                            ─ endpoints:
                                - addresses: [10.244.1.5]
                                  conditions:
                                    ready: true
                                    serving: true
                                    terminating: false
                                  nodeName: worker-1
                                  zone: us-west-1a
                            ─ ports:
                                - name: http
                                  port: 8080
```

Three invariants:

1. A pod appears in a Service's EndpointSlices iff **all selector labels match**. Selectors are AND, not OR.
2. A pod is only included once it has an **IP** (pod is scheduled, sandbox created, CNI has assigned an IP).
3. A pod's **Ready** condition (from readiness probes) determines whether it counts for traffic routing, separately from whether it appears in the slice at all.

---

## Two controllers, one concept

### endpoint-controller (legacy)

The old controller maintains the `Endpoints` object — a single flat API object per Service with all endpoints inline:

```yaml
apiVersion: v1
kind: Endpoints
metadata:
  name: web            # same name as Service
subsets:
- addresses:
  - ip: 10.244.1.5
    targetRef: {kind: Pod, name: web-abc}
  ports:
  - name: http
    port: 8080
    protocol: TCP
```

This is what `kubectl get endpoints` shows. For small services, the flat Endpoints object is fine. For 10,000-pod services, it was a performance nightmare — every pod change rewrote the whole 2 MiB object, and every kube-proxy on every node re-fetched it.

### endpointslice-controller (modern)

Introduced in 1.17, GA'd in 1.21. It writes `EndpointSlice` objects (`discovery.k8s.io/v1`):

- One Service has **one or more** EndpointSlices.
- Default max 100 endpoints per slice (`--max-endpoints-per-slice`, up to 1000).
- Dual-stack Services: separate slices for IPv4 and IPv6 (`addressType` field).
- Each slice has the label `kubernetes.io/service-name: <service-name>` to link it back.
- An ownerReference to the Service.

For kube-proxy and controllers that need the endpoint list, updates only touch the affected slices — not the whole 2 MiB object.

### Both still run

On modern clusters, **both** controllers run. The endpoint-controller produces `Endpoints` (for backwards compatibility with older tooling), the endpointslice-controller produces `EndpointSlice` (for modern consumers). kube-proxy reads EndpointSlices.

### Finding the slices

```bash
# By service-name label
kubectl get endpointslices -l kubernetes.io/service-name=web

# All slices, narrowed by namespace
kubectl get endpointslices -n default

# Full contents
kubectl get endpointslice web-abc -o yaml
```

---

## The four conditions on an endpoint

Each endpoint inside a slice has a `conditions` block:

```yaml
endpoints:
- addresses: [10.244.1.5]
  conditions:
    ready:        true    # shortcut for "serving AND !terminating"
    serving:      true    # pod's Ready condition is True
    terminating:  false   # pod has deletionTimestamp set
```

Mapping pod state → endpoint conditions:

| Pod state                                          | serving | terminating | ready |
|----------------------------------------------------|---------|-------------|-------|
| Running, readiness probe passing                   | true    | false       | true  |
| Running, readiness probe failing                   | false   | false       | false |
| Running, readiness OK, pod being deleted (grace)   | true    | true        | false |
| Pending / ContainerCreating                        | not in slice at all |      |       |

Key point: **`ready` is the one kube-proxy traditionally uses** to decide whether to route traffic. If `ready: false`, traffic doesn't go to that endpoint — regardless of whether the IP is reachable.

### Why `serving` + `terminating` exist

Historically, as soon as a pod started terminating, it was **removed from Endpoints** and traffic stopped flowing to it — even though the pod was still running (in its grace period) and still accepting connections. This caused dropped requests during rolling updates.

The `serving` and `terminating` conditions let consumers make smarter decisions:

- `serving: true, terminating: true` — pod is shutting down but still handling in-flight connections. Route **existing** connections here, don't send **new** ones.
- `serving: true, terminating: false` — normal case; route freely.
- `serving: false` — don't route; not ready.

kube-proxy with modern settings respects both. Traffic is drained gracefully during pod termination.

---

## Readiness probes gate endpoint membership

A pod in Running state but with a failing readinessProbe looks like this:

```yaml
status:
  conditions:
  - type: Ready
    status: "False"
    reason: ContainersNotReady
    message: "containers with unready status: [web]"
```

The endpointslice-controller sees `Ready=False` → the pod's endpoint gets `serving: false` → kube-proxy excludes it from load balancing.

This is the mechanism: **if readiness probe is failing, the pod is invisible to the Service**. Not deleted, not migrated — just quietly removed from the rotation until the probe passes.

### Why readiness probes matter

- Let a slow-starting pod (database, JVM app) catch up before taking traffic.
- Let an overloaded pod shed traffic by flipping readiness to false (self-throttle).
- Let a pod drain gracefully on SIGTERM by flipping readiness to false before exiting.

A Deployment rolling update without readiness probes is a traffic-drop event; with them, new pods only receive traffic once they confirm they can serve it.

### publishNotReadyAddresses — escape hatch

```yaml
spec:
  publishNotReadyAddresses: true
```

Forces the controller to include not-ready addresses in Endpoints anyway. Useful for StatefulSet peer discovery (pods need to talk to each other before they've passed readiness) but rarely in normal services.

---

## One service, multiple slices — when and why

A Service ends up with multiple EndpointSlices when:

1. **More than 100 endpoints** — slices grow up to the max; additional pods land in new slices.
2. **Dual-stack** — IPv4 and IPv6 go in separate slices (`addressType`).
3. **Heterogeneous ports** — if pods expose the same port name on different numbers, they get split across slices.

```bash
kubectl get endpointslices -l kubernetes.io/service-name=web
# NAME           ADDRESSTYPE   PORTS     ENDPOINTS         AGE
# web-abc        IPv4          8080      10.244.1.5,...    1d
# web-def        IPv4          8080      10.244.5.42,...   1d
# web-v6-abc     IPv6          8080      fd00:...          1d
```

Each slice is independently updated. kube-proxy consumes them all.

---

## Topology hints (for multi-zone clusters)

On clusters with nodes in multiple zones, EndpointSlices can carry topology information so kube-proxy prefers same-zone endpoints:

```yaml
endpoints:
- addresses: [10.244.1.5]
  zone: us-west-1a
  hints:
    forZones:
    - name: us-west-1a        # this endpoint should receive traffic from us-west-1a
```

Enabled with `spec.trafficDistribution: PreferClose` on the Service (or via the topology-aware routing feature). Reduces cross-zone traffic cost at the price of imperfect load balancing.

Related but different: `externalTrafficPolicy: Local` is the older, node-local variant.

---

## Manually-managed endpoints

Services without selectors don't get EndpointSlices from the controller. You create them yourself:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: external-db
spec:
  ports:
  - port: 5432
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: external-db-1
  labels:
    kubernetes.io/service-name: external-db     # ← links to the Service
addressType: IPv4
ports:
- name: ""                                       # empty name matches the Service's single port
  port: 5432
  protocol: TCP
endpoints:
- addresses:
  - 10.0.0.50
  conditions:
    ready: true
```

Or the legacy Endpoints form:

```yaml
apiVersion: v1
kind: Endpoints
metadata:
  name: external-db
subsets:
- addresses:
  - ip: 10.0.0.50
  ports:
  - port: 5432
```

Either works. The EndpointSlice form is forward-compatible.

### Caution

If a Service **has** a selector, and you manually create an Endpoints object, the endpoint-controller will overwrite it on the next reconcile. Only omit the selector if you truly want to own endpoints manually.

---

## Debugging endpoint membership

### Quick checks

```bash
# Classic Endpoints view
kubectl get endpoints web

# Modern EndpointSlices
kubectl get endpointslices -l kubernetes.io/service-name=web

# Detailed view of one slice
kubectl get endpointslice <slice-name> -o yaml

# What does the Service want?
kubectl get svc web -o jsonpath='{.spec.selector}'

# Which pods match?
kubectl get pods -l <selector> -o wide

# Which pods are Ready?
kubectl get pods -l <selector> -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'
```

### The "matches but not in slice" case

If a pod has the right labels but isn't in the slice:

1. Is the pod Running? (`Pending` doesn't count, no IP yet.)
2. Is `.status.podIP` set?
3. Is the pod's Ready condition True? (Readiness probe?)
4. Is the pod in the same **namespace** as the Service? (Services don't cross namespaces.)
5. Are you looking at the right service? (`kubernetes.io/service-name` label check.)

This is the bread and butter of the next subtopic ("No Endpoints Triage"), but most debugs land on readiness probe misconfiguration — wrong port, wrong path, aggressive timing.

---

## Exam heuristics

- `kubectl get endpoints <svc>` is still the fastest diagnostic. Modern exam environments also show EndpointSlices.
- When a pod is Running but not in Endpoints, 90% of the time it's readiness probe.
- For dual-stack, look at both `addressType: IPv4` and `addressType: IPv6` slices.
- For a StatefulSet's headless service, expect to see a slice with **one endpoint per pod** — all included regardless of readiness if `publishNotReadyAddresses: true` (common on stateful peer discovery).
- If asked to "list all endpoints for service X," remember to use `kubectl get endpointslices -l kubernetes.io/service-name=X`, not just `kubectl get endpoints X` (the latter may be truncated at 1000 endpoints in very large services).

## Mental traps

- Assuming a Running pod is automatically in the Service's Endpoints. It has to be Ready too.
- Thinking the `Endpoints` object is deprecated. It's not — it's still maintained for compat. But `EndpointSlice` is canonical going forward.
- Forgetting that readiness probes gate membership. Your app may be running but not "ready" by the probe's definition.
- Believing a Service can select across namespaces. It can't — Service and pods must be in the same namespace.
- Thinking `publishNotReadyAddresses: true` is a normal thing. It's a specific tool for peer-discovery; don't enable it casually.
- Ignoring the `terminating: true` endpoints during deploys. They're there to let in-flight traffic drain; kube-proxy handles it.
