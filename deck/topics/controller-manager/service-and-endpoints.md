## The three-object dance

A Service selects pods. The endpoints/slice controller watches pods matching the selector, and writes the matching pod IPs into:

- **Endpoints** — the classic flat list (one object per Service).
- **EndpointSlice** — the modern sharded version (multiple slices per Service).

Both are written by controllers running inside `kube-controller-manager`. kube-proxy (or the CNI's replacement) then uses these to program node-level load balancing.

```
 Pod (labels:  app=web, ready=true)
         │
         │ selector match
         ▼
 Service (selector: app=web)   ◄─── kube-apiserver writes
         │
         │ endpoints / slice controller observes and emits
         ▼
 Endpoints / EndpointSlice (addresses: 10.244.1.5, 10.244.2.7)
         │
         ▼
 kube-proxy programs iptables/ipvs on each node
```

A pod appears in Endpoints only if **all** of these hold:

- Labels match the Service `selector`.
- Pod is in the same namespace as the Service.
- Pod has an IP (`.status.podIP` is set).
- Pod is **Ready** (all readiness probes pass), unless the Service has `publishNotReadyAddresses: true`.

If any one fails, the pod is not in Endpoints.

## Services without selectors

A Service can be defined without a selector — in that case you create Endpoints (or an EndpointSlice) manually, pointing at arbitrary IPs. Common for linking a Service to an external database or another cluster.

Shape:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: external-db
spec:
  ports:
    - port: 5432
---
apiVersion: v1
kind: Endpoints
metadata:
  name: external-db   # same name as the service
subsets:
  - addresses:
      - ip: 10.0.0.50
    ports:
      - port: 5432
```

The endpoints controller does not touch a selector-less Service. You own the Endpoints.

## Why Endpoints might be empty

In order of frequency on CKA:

1. **Selector mismatch** — pod labels don't match Service selector.
2. **Namespace mismatch** — Service in `ns-a`, pods in `ns-b`.
3. **Readiness probe failing** — pod is Running but not Ready; excluded.
4. **No pods at all** — Deployment/RS has replicas but pods are Pending / CrashLoop.
5. **Pod selector includes a label the deployment strips** — e.g. rolling update template doesn't carry the label.

Fastest diagnostics:

```bash
# What the service wants
kubectl get svc <svc> -o jsonpath='{.spec.selector}'

# What pods match those labels
kubectl get pods -l <selector-from-svc> -o wide

# Are those pods Ready?
kubectl get pods -l <selector-from-svc> -o wide

# What endpoints actually exist
kubectl get endpoints <svc>
kubectl get endpointslice -l kubernetes.io/service-name=<svc>
```

Once you see a discrepancy between "matching pods" and "endpoints," you know the problem is label/namespace/readiness.

## EndpointSlice basics

EndpointSlices replaced flat Endpoints for scalability. One Service can have many slices, each holding up to 100 endpoints by default. Each slice has a label `kubernetes.io/service-name=<svc>`, which is how you find them.

Why it matters:

- Modern kube-proxy prefers EndpointSlices (`EndpointSliceProxying` feature).
- On very new clusters, the classic Endpoints object may be synthesized only for backwards compatibility.
- Dual-stack services produce multiple slices (IPv4 + IPv6).

In CKA you rarely interact with slices directly — Endpoints suffices for reasoning — but you should know the namespace label:

```bash
kubectl get endpointslice -A -l kubernetes.io/service-name=<svc>
```

## Port mapping — a source of endless confusion

A Service has `port` and `targetPort`. A Pod has `containerPort`.

| Field            | On object    | Meaning                                             |
|------------------|--------------|------------------------------------------------------|
| `spec.ports.port`      | Service | Port the Service listens on (ClusterIP)              |
| `spec.ports.targetPort`| Service | Port on the **pod** to forward to                    |
| `spec.containers.ports[].containerPort` | Pod | Port the container exposes (informational)      |

Key facts:

- `targetPort` can be a **number** (`8080`) or a **name** (`http`) that matches a `containerPort.name` on the pod.
- `containerPort` does **not** open the port; it documents it. The process inside the container must actually listen.
- If `targetPort` and `containerPort` disagree numerically but there is no matching name, traffic still flows if something is listening on `targetPort`. `containerPort` is not enforced.

Typical error: a pod listens on 8080, Service has `targetPort: 80`. Endpoints look correct (pod IP:80 is in the list), but connections fail because nothing listens on :80.

Verify inside the pod:

```bash
kubectl exec -it <pod> -- ss -tlnp
kubectl exec -it <pod> -- netstat -tlnp
```

## Headless Services

`clusterIP: None` creates a **headless Service**. No ClusterIP, no kube-proxy rules. DNS queries return the pod IPs directly (one A record per endpoint). StatefulSets use this to give each pod a DNS name like `web-0.web.default.svc.cluster.local`.

If a headless Service has no endpoints, DNS simply returns nothing. Applications that expected a single A record may fail confusingly.

## ClusterIP range and Service IP assignment

The controller-manager owns the Service cluster IP allocator, using the range in the apiserver's `--service-cluster-ip-range` flag (e.g. `10.96.0.0/12`).

If that range is exhausted, creating a new ClusterIP Service fails. Also, changing the range mid-cluster breaks existing services — it is a static parameter.

## NodePort / LoadBalancer interactions

- `NodePort` adds a port allocation from `--service-node-port-range` (default 30000–32767) and programs iptables/ipvs on every node.
- `LoadBalancer` (cloud) sets up an external LB via the cloud-controller-manager. Without cloud integration, the `EXTERNAL-IP` stays `<pending>`.

These do not change how Endpoints work; the traffic path from node to pod is identical to ClusterIP.

## Debugging commands

```bash
# Full service picture
kubectl get svc <s> -o yaml
kubectl get endpoints <s>
kubectl describe svc <s>

# Is the service IP being hit?
kubectl run bb --rm -it --image=busybox -- sh
# inside pod:
wget -qO- <svc>.<ns>:<port>
nslookup <svc>.<ns>

# Trace from node
# (on a node)
iptables-save | grep <svc-clusterip>
ipvsadm -Ln | grep <svc-clusterip>
```

## Exam heuristics

- When "the service doesn't work," always run `kubectl get endpoints <svc>` early. Empty endpoints = selector/readiness. Populated endpoints = DNS or port or network policy.
- When creating a Service for a Deployment, copy the exact label from the pod template to the Service `selector`. Do not invent one.
- Named `targetPort` is safer than numeric when container ports change over time.

## Mental traps

- Thinking a Service "talks to" a Deployment. Services only see pods via label selectors; they don't know about Deployments.
- Forgetting that readiness probes gate endpoint inclusion. A Running but NotReady pod is invisible to the Service.
- Assuming endpoint changes propagate instantly. On large clusters, there is a short lag between pod Ready → endpoint update → kube-proxy reprogram.
- Writing a Service with a selector and manually creating Endpoints. The endpoints controller will overwrite your Endpoints on the next reconcile. If you want manual Endpoints, omit the selector.
- Confusing `port` with `nodePort`. `port` is the ClusterIP port; `nodePort` is the per-node external port.
