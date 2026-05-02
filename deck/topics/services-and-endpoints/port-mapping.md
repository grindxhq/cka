## Why ports confuse everyone

There are **four** port fields in play when a client outside the cluster reaches a pod inside, and they're all named in ways that suggest similarity but mean different things:

- `containerPort` (on the pod)
- `targetPort` (on the Service)
- `port` (on the Service)
- `nodePort` (on the Service, only for NodePort/LoadBalancer types)

Add `hostPort` (on the pod) and the ingress's own backend port, and you have six. This note untangles them.

---

## The four Service-relevant ports, in the order traffic flows

```
External client
    ▼
  <node IP>:<nodePort>                  ←  only NodePort / LoadBalancer
    ▼
  Service ClusterIP:<port>              ←  the "service port" — DNS targets this
    ▼
  Pod IP:<targetPort>                    ←  the "pod port" — kube-proxy DNATs here
    ▼
  process inside container listens on <containerPort>   ←  informational only
```

Each arrow is a port translation:

- NodePort → Service Port: kube-proxy DNATs and reduces the nodePort to a service's ClusterIP:port.
- Service Port → Target Port: kube-proxy DNATs from ClusterIP:port to a backend pod IP:targetPort.
- Target Port → Container Port: they **should** match the port the process is actually listening on, but `containerPort` is only informational.

---

## Each field, plainly

### `containerPort` — on the Pod

```yaml
kind: Pod
spec:
  containers:
  - name: web
    image: nginx:latest
    ports:
    - containerPort: 80       # port the container is listening on
      name: http              # named reference
      protocol: TCP
```

**containerPort is informational.** Setting it does **not** open the port — the process inside the container opens it by calling `listen()` on a socket. Not setting it doesn't close anything.

Why set it at all?

- Documentation: makes it explicit what the container exposes.
- Named port references: a Service can point `targetPort: http` instead of `targetPort: 80`, making future port changes less fragile.
- Some cluster policy tooling reads container ports for security / NetworkPolicy generation.

If your container listens on 8080 but `containerPort: 80` is specified, the 8080 traffic works and the 80 traffic fails. Kubernetes does not enforce that they match.

### `port` — on the Service

```yaml
kind: Service
spec:
  ports:
  - port: 80                  # port on the ClusterIP
    targetPort: 8080
```

The **Service port** is the port on the Service's ClusterIP. Clients inside the cluster connect to `<cluster-ip>:80` or `<service-name>:80`.

- Mandatory.
- Any valid TCP/UDP port (no range restriction — you can have ClusterIP on port 22 if you want).
- If multiple `ports` entries, each must have a unique `name`.

### `targetPort` — on the Service

```yaml
spec:
  ports:
  - port: 80
    targetPort: 8080           # port on the backing pods
```

The **target port** is the port on the pod. kube-proxy programs iptables/IPVS rules that rewrite the service port (80) to the target port (8080) when forwarding to a pod IP.

Can be:

- A **number**: `targetPort: 8080`.
- A **name**: `targetPort: http` — refers to a `containerPort.name` on the pod. Resolution happens per-pod, so different pods could have different actual ports for the same named target. Useful for multi-version rollouts.

**If omitted, it defaults to the value of `port`.** This is a common gotcha — if your pod listens on 8080 but you wrote `- port: 80` without `targetPort`, traffic goes to `pod:80`, which usually fails.

### `nodePort` — on the Service (NodePort/LoadBalancer types)

```yaml
spec:
  type: NodePort
  ports:
  - port: 80
    targetPort: 8080
    nodePort: 30080            # port on every node's IP
```

The **node port** is the port opened on every node's external IP. From outside, clients hit `<any-node-ip>:30080` → kube-proxy DNATs to the Service's port → then to a pod's targetPort.

Constraints:

- Must be in `--service-node-port-range` (default 30000-32767).
- If unspecified, Kubernetes picks one from that range automatically.
- Unique across all Services in the cluster (two Services cannot share a nodePort).

### `hostPort` — on the Pod (unrelated to Services, but confusingly similar)

```yaml
kind: Pod
spec:
  containers:
  - name: web
    ports:
    - containerPort: 80
      hostPort: 8080            # port on the pod's node IP
```

`hostPort` opens a port on the node the pod is running on — not on every node. No kube-proxy involvement. If you scale the Deployment to 2 replicas on the same node, the second pod fails to schedule due to port conflict.

Generally avoid `hostPort`. It's a step back toward "I own the node." Use a NodePort or LoadBalancer service instead.

---

## The classic bug: targetPort ≠ what the pod actually listens on

```yaml
kind: Pod
spec:
  containers:
  - name: web
    image: nginx:latest
    ports:
    - containerPort: 80        # nginx listens on 80 — correct
---
kind: Service
spec:
  selector:
    app: web
  ports:
  - port: 80
    targetPort: 8080            # ← WRONG, pod actually listens on 80
```

Symptoms:

- Service's Endpoints show the pod IP at `:8080`.
- `curl <cluster-ip>:80` → connection refused.
- `kubectl exec <pod> -- ss -tln` shows the pod listening on `:80`, not `:8080`.

Fix: make `targetPort` match the real listening port, or use a named port.

---

## Named ports — the safer pattern

Naming a port on the pod and referring to it by name in the Service decouples the abstract "http" port from the concrete number:

```yaml
kind: Pod
spec:
  containers:
  - name: web
    image: myapp:v1
    ports:
    - containerPort: 8080
      name: http                 # name the port "http"
---
kind: Service
spec:
  selector:
    app: web
  ports:
  - port: 80
    targetPort: http             # resolves per-pod to the "http" named port
```

Benefits:

- Deploy v2 of the app that listens on `8443` instead: change `containerPort: 8443`, keep `name: http`. The Service doesn't need to be touched.
- Multi-port scenarios (e.g. pods with `http` and `metrics`) are self-documenting.
- Mixing pods with different port numbers but same named port works.

Downside: a little more verbose up front. Worth it in anything non-trivial.

---

## Multi-port Services

A single Service can expose multiple ports — useful for apps that serve on multiple protocols:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: app
spec:
  selector:
    app: app
  ports:
  - name: http
    port: 80
    targetPort: 8080
    protocol: TCP
  - name: metrics
    port: 9090
    targetPort: 9090
    protocol: TCP
  - name: grpc
    port: 50051
    targetPort: 50051
    protocol: TCP
```

Rules:

- When multiple ports are declared, **each must have a `name`** — Kubernetes uses names to disambiguate.
- DNS SRV records (for the cluster DNS suffix) use these names: `_http._tcp.app.default.svc.cluster.local`.
- Multi-port Services generate multi-port EndpointSlices — each slice has one `ports[]` array with all ports.

Use cases:

- Sidecar exposing metrics on a different port than the main app.
- gRPC service + HTTP health endpoints.
- TLS on 443, plaintext on 80 — but see "switching protocols" caveat below.

### Multi-port caveats

- A pod that doesn't actually listen on all the declared ports will still appear in Endpoints. Unused port = connection refused for that port.
- Each port is load-balanced independently. Session affinity per port, not per Service.
- Named ports that don't exist on a backing pod → that pod is **excluded** from the endpoint for that port only (rare case). The pod is still in Endpoints for ports it supports.

---

## Protocol selection

```yaml
spec:
  ports:
  - port: 53
    targetPort: 53
    protocol: UDP               # or TCP, SCTP
```

- **TCP** — default. Every kube-proxy mode supports it.
- **UDP** — works on iptables + IPVS; some older modes had quirks.
- **SCTP** — feature-gated in older clusters; generally supported in modern ones.

Mixed protocols (e.g. port 53 on both TCP and UDP, as CoreDNS needs) are fine but require two separate `ports[]` entries with different names.

---

## The full traffic walk, annotated

A request from external client to pod:

```
$ curl http://1.2.3.4:30080/       (LB IP, nodePort 30080)

1. Packet arrives at cloud LB at 1.2.3.4:80
2. LB DNATs to <node-ip>:30080 (or more accurately, cloud LB keeps packets per node's NodePort)
3. On the node, iptables (installed by kube-proxy):
     PREROUTING: dst <node-ip>:30080 → jump to KUBE-NODEPORTS
     KUBE-NODEPORTS: dst *:30080 → jump to KUBE-SVC-web
     KUBE-SVC-web: randomly pick one of:
       KUBE-SEP-pod1 → DNAT to 10.244.1.5:8080
       KUBE-SEP-pod2 → DNAT to 10.244.2.7:8080
4. Packet is now addressed to 10.244.1.5:8080
5. Node's network stack routes via CNI to the pod
6. Pod receives on 8080, process handles
```

Two SNATs may also happen:

- **kube-proxy Cluster mode** SNATs the source IP on NodePort traffic (client IP lost).
- **LB** may add its own X-Forwarded-For header in HTTP mode, preserving client IP at L7.

`externalTrafficPolicy: Local` disables SNAT and preserves the client IP, at the cost of requiring each node to have a local backing pod.

---

## Port allocation bookkeeping

### Service CIDR

ClusterIPs are allocated from `--service-cluster-ip-range`. You cannot pick a port out of it — only the IP. The port is whatever you wrote in `spec.ports[].port`.

### NodePort range

```
--service-node-port-range=30000-32767     (apiserver flag)
```

Kubernetes keeps an internal bitmap of allocated nodePorts. Create a Service with an explicit `nodePort: 30080`; if 30080 is taken, you get an error. Let Kubernetes auto-allocate to avoid collisions.

### hostPort

Handled per-node by kubelet; no cluster-level bookkeeping. Collision = pod doesn't schedule.

---

## Debugging port issues

### Does the pod actually listen?

```bash
kubectl exec -it <pod> -- ss -tlnp
# LISTEN 0  128  0.0.0.0:8080  0.0.0.0:*  ...

# Or with netstat if ss is unavailable:
kubectl exec -it <pod> -- netstat -tlnp
```

If nothing on the expected port, the app isn't bound. `containerPort` being "right" is meaningless.

### Does the Service have right targetPort?

```bash
kubectl get svc web -o jsonpath='{range .spec.ports[*]}{.name}={.port}->{.targetPort}{"\n"}{end}'
# http=80->8080
```

Cross-check against what the pod listens on.

### Do Endpoints reflect the right port?

```bash
kubectl get endpoints web
# NAME   ENDPOINTS                     AGE
# web    10.244.1.5:8080,10.244.2.7:8080  10d

# Modern:
kubectl get endpointslices -l kubernetes.io/service-name=web -o yaml | grep port:
```

If Endpoints show `:8080` but the pod listens on `:80`, that's where the bug is.

### Can you reach the pod directly (bypassing Service)?

```bash
kubectl run debug --rm -it --image=busybox --restart=Never -- sh
# inside debug pod:
wget -qO- 10.244.1.5:8080          # direct pod IP
```

If direct works and Service doesn't, port mismatch or kube-proxy issue. If direct also fails, pod or CNI issue.

### Can you reach the Service from inside?

```bash
kubectl run debug --rm -it --image=busybox --restart=Never -- sh
wget -qO- web.default.svc.cluster.local:80
wget -qO- 10.96.0.50:80            # ClusterIP
```

### Can you reach the NodePort externally?

```bash
curl http://<any-node-ip>:30080
```

If NodePort fails but ClusterIP works from inside: firewall, external-traffic-policy=Local + no local pods, or kube-proxy on that node is broken.

---

## Exam heuristics

- When you write a Service for an exam, **always double-check targetPort matches containerPort**. Easiest typo in the whole spec.
- Use named ports in exam-style YAML for clarity (unless the question specifies a number).
- For headless Services + StatefulSets, still put `port` and `targetPort` — DNS records only work if at least port is defined.
- `kubectl expose` is faster than writing YAML: `kubectl expose deploy web --port=80 --target-port=8080 --type=NodePort`.
- Multi-port Services must have port names. Scribbled YAML without names fails apply.

## Mental traps

- Believing `containerPort` opens the port. It doesn't.
- Omitting `targetPort` expecting it to equal `containerPort` — it defaults to `port`, not `containerPort`.
- Using the same `nodePort` for two Services — second creation fails.
- Assuming `hostPort` = `nodePort`. Different concepts. `hostPort` is node-local and doesn't scale.
- Using a named `targetPort` when the pod doesn't have `ports[].name` — the name won't resolve, endpoints excluded for that port.
- Thinking port 80 on a ClusterIP is somehow different from port 80 on a NodePort service. It's the same field; the only addition for NodePort is a second port on the node.
