## "I created a Service, traffic doesn't reach the pods"

This shows up in many shapes:

- `curl <service>.<ns>` from a pod hangs.
- External traffic to a NodePort returns connection refused.
- LoadBalancer's external IP works for some apps but not yours.
- Endpoints exist but real connections fail.

The path from client to pod has 6+ steps; any one can break. Walk them in order.

---

## The full traffic path

```
 Client (pod or external)
   │
   │ ① DNS: resolve service name → ClusterIP
   ▼
 ClusterIP:port
   │
   │ ② Service exists? (kubectl get svc)
   │ ③ Has Endpoints? (kubectl get endpoints)
   │
   ▼ (kube-proxy DNATs)
 PodIP:targetPort
   │
   │ ④ kube-proxy programmed correctly? (iptables-save / ipvsadm)
   │ ⑤ NetworkPolicy not blocking?
   │ ⑥ CNI delivered the packet?
   ▼
 Container listens on the port
   │
   │ ⑦ Process bound to 0.0.0.0:port (not 127.0.0.1)?
   │ ⑧ Handles the request?
```

Each step has a quick check. Stop at the first failure.

---

## Step 1: DNS resolution

Test from inside a pod (same namespace as the Service):

```bash
kubectl run test --rm -it --image=busybox:1.28 --restart=Never -- nslookup my-service

# Server:    10.96.0.10
# Address 1: 10.96.0.10 kube-dns.kube-system.svc.cluster.local
#
# Name:      my-service
# Address 1: 10.96.0.50 my-service.default.svc.cluster.local
```

Outcomes:

| Outcome | Cause |
|---------|-------|
| Resolves to ClusterIP | DNS works. Move to step 2. |
| `Can't find my-service: NXDOMAIN` | Service doesn't exist OR wrong namespace |
| Timeout | CoreDNS unreachable or down |
| Resolves to old IP | DNS cache stale |

If DNS doesn't resolve: skip to dns-broken playbook. The Service-routing investigation can't proceed without DNS.

For a quick "bypass DNS, use IP directly":

```bash
SERVICE_IP=$(kubectl get svc my-service -o jsonpath='{.spec.clusterIP}')
kubectl run test --rm -it --image=busybox:1.28 --restart=Never -- \
  wget -qO- http://${SERVICE_IP}/
```

If IP-direct works but DNS doesn't: DNS issue, not service-routing.

---

## Step 2: Does the Service exist? Right type / port?

```bash
kubectl get svc my-service

# NAME          TYPE        CLUSTER-IP    EXTERNAL-IP   PORT(S)    AGE
# my-service    ClusterIP   10.96.0.50    <none>        80/TCP     5m
```

Verify:

- **TYPE** matches expectation (ClusterIP / NodePort / LoadBalancer).
- **CLUSTER-IP** is set (not "None" unless you wanted headless).
- **PORT(S)** shows the right port + protocol (`80/TCP`).

For NodePort:

```bash
kubectl get svc my-service -o jsonpath='{.spec.ports[*].nodePort}'
# Should show a port like 30080
```

For LoadBalancer:

```bash
kubectl get svc my-service -o jsonpath='{.status.loadBalancer.ingress}'
# IP or hostname. If <pending> forever, see cloud-controller-manager deck.
```

---

## Step 3: Endpoints — the heart of "no traffic"

This is the **single most common cause** of "service not routing":

```bash
kubectl get endpoints my-service

# NAME          ENDPOINTS                            AGE
# my-service    10.244.1.5:8080,10.244.2.7:8080      5m

# Or modern:
kubectl get endpointslices -l kubernetes.io/service-name=my-service
```

Two scenarios:

**Endpoints empty (`<none>`)** → no backend pods. Service has nothing to route to.

**Endpoints populated** → at least one backend exists; problem is downstream.

If empty:

```bash
# What does the Service select?
kubectl get svc my-service -o jsonpath='{.spec.selector}'
# {"app":"web","tier":"frontend"}

# What pods match?
kubectl get pods -l app=web,tier=frontend
# Are there any? Are they Ready?

# Pod readiness
kubectl get pods -l app=web,tier=frontend \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'
```

Common reasons for empty Endpoints:

1. **Selector mismatch**: pod labels don't match Service selector. Verify both.
2. **Wrong namespace**: Service is in `dev`, pods are in `prod`. Service selectors don't cross namespaces.
3. **Pods not Ready**: readiness probe failing. Check `kubectl describe pod`.
4. **Pods Pending**: see pod-pending playbook.
5. **Service has no selector**: manually-managed Endpoints; verify they exist.

Detail in services-and-endpoints → no-endpoints-triage deck.

---

## Step 4: kube-proxy programmed correctly?

If Endpoints has entries but traffic still doesn't reach:

Test connectivity from inside a pod:

```bash
kubectl run test --rm -it --image=nicolaka/netshoot --restart=Never -- bash

# inside the pod:
nc -zv my-service 80                     # TCP test to the service
curl -m 5 http://my-service/             # full HTTP attempt
```

Outcomes:

- Both work → traffic reaches a pod. The "issue" is elsewhere (maybe app-level).
- nc fails → service-routing layer is the issue.

To confirm kube-proxy:

```bash
# On a node (the test pod's host)
NODE=$(kubectl get pod test -o jsonpath='{.spec.nodeName}')
ssh $NODE

# iptables mode
sudo iptables-save -t nat | grep <cluster-ip>
# Should show KUBE-SERVICES rule pointing at KUBE-SVC-...
# Then KUBE-SVC-... should fan out to KUBE-SEP-... endpoints

# IPVS mode
sudo ipvsadm -Ln | grep <cluster-ip>
# Should show real servers with weight 1 each
```

If no rule for the ClusterIP exists: kube-proxy on this node didn't program it. Check kube-proxy:

```bash
kubectl get pods -n kube-system -l k8s-app=kube-proxy -o wide --field-selector spec.nodeName=$NODE
kubectl logs -n kube-system <kube-proxy-pod-on-this-node>
```

Common kube-proxy issues:

- **Pod CrashLoopBackOff** — config error.
- **Pod Ready but rules missing** — watch on Services / EndpointSlices broken.
- **Node has wrong kube-proxy mode** (e.g. IPVS without kernel modules).

---

## Step 5: NetworkPolicy

Even if everything else is correct, a NetworkPolicy can block:

```bash
kubectl get networkpolicies -A
```

Specifically check for policies in:

- The Service's namespace (limiting ingress to its pods).
- The client pod's namespace (limiting egress).

If a policy is suspicious, temporarily exempt your test pod or relax the policy. See network-policies → debug-flow deck.

---

## Step 6: CNI / pod-to-pod connectivity

Sanity check: pod-to-pod direct works?

```bash
# From the test pod, try a backend pod's IP directly
kubectl get endpoints my-service -o jsonpath='{.subsets[0].addresses[0].ip}'
# 10.244.1.5

kubectl run test --rm -it --image=netshoot --restart=Never -- nc -zv 10.244.1.5 8080
```

If even pod-to-pod direct fails:

- CNI is broken (rare on a working cluster).
- Pod IP wasn't assigned correctly.
- Across nodes: route programming missing.

If direct pod IP works but ClusterIP doesn't: kube-proxy is the culprit. Back to step 4.

---

## Step 7: Pod actually listening?

```bash
# Inside the backend pod:
kubectl exec -it my-pod -- ss -tlnp
# LISTEN 0 128 0.0.0.0:8080  ← good (binds to all interfaces)
# LISTEN 0 128 127.0.0.1:8080  ← BAD (binds to loopback only — kube-proxy can't reach)
```

If the pod is listening on `127.0.0.1` only (or a specific IP that's not the pod IP), kube-proxy's DNAT delivers a packet to the pod IP, but the pod's process isn't bound to that IP and refuses.

Fix: have the app bind to `0.0.0.0` or `::`. Common in apps that use `localhost` defaults.

---

## Step 8: Application-level

If you've reached the pod and the connection is being refused:

```bash
kubectl exec -it my-pod -- curl -v http://localhost:8080/
# Test from inside the pod against itself.
```

If localhost works but Service IP doesn't: bind issue (step 7) or firewall inside the container (rare).

If even localhost fails: app isn't running / crashed / listening on a different port.

---

## NodePort-specific issues

External traffic to `<node-ip>:<nodePort>` doesn't reach pods.

```bash
# From outside the cluster
curl -v http://<node-ip>:<nodePort>/
```

Possible issues:

### Firewall blocks the NodePort

Cloud security group / iptables / firewalld may block the port.

```bash
# On the node
sudo ss -tlnp | grep <nodePort>
# Note: NodePort doesn't create a listener — it's all iptables DNAT. So this returns nothing. That's normal.

# Test if any iptables / firewall blocks
sudo iptables-save | grep <nodePort>
# Should show kube-proxy's KUBE-NODEPORTS rules.
```

For cloud providers: check security groups on the VM.

### `externalTrafficPolicy: Local` + no local pod on this node

```yaml
spec:
  type: NodePort
  externalTrafficPolicy: Local
```

NodePort traffic to a node without a local backing pod is dropped. Health-check NodePort returns 503 to inform external LBs.

If you're hitting a node directly without a local pod, you'll get connection refused. Try a different node, or use `externalTrafficPolicy: Cluster` (default).

### NodePort range incorrect

Default range: 30000-32767. Trying to use port 80? You'd need `--service-node-port-range=80-32767` on apiserver. Easier: change the Service.

---

## LoadBalancer-specific issues

```bash
kubectl get svc my-service
# my-service  LoadBalancer  10.96.0.50  <pending>  80:30080/TCP
```

`<pending>` forever:

- No CCM running (bare metal, on-prem). Use MetalLB.
- IAM/credential issue for cloud LB provisioning.
- LB quota exceeded.

See cloud-controller-manager → loadbalancer-services deck.

If LB has external IP but traffic doesn't reach:

- Cloud LB is provisioned but its target group is wrong.
- LB health check failing on backends.

Cloud-specific diagnostics. Check the cloud console.

---

## Headless service (clusterIP: None)

```yaml
spec:
  clusterIP: None
```

Headless services have no ClusterIP. DNS returns pod IPs directly:

```bash
nslookup my-service
# Address: 10.244.1.5
# Address: 10.244.2.7
# Address: 10.244.3.12
```

Connection goes directly to a pod IP. If only some addresses work: those specific pods are unhealthy. If none work: same as regular Service troubleshooting (Endpoints → kube-proxy doesn't apply since there's no ClusterIP, but pod-readiness still matters).

---

## ExternalName service

```yaml
spec:
  type: ExternalName
  externalName: db.prod.example.com
```

DNS returns a CNAME, not an A. Client must resolve the target itself:

```bash
nslookup my-service
# my-service.default.svc.cluster.local canonical name = db.prod.example.com.
```

If client can't resolve `db.prod.example.com`: not Kubernetes' fault (upstream DNS issue). If client can't reach it once resolved: network / external service issue.

---

## End-to-end debug recipe

When a Service is broken:

```bash
# 1. Service exists, right type and port
kubectl get svc my-service -o yaml | head -30

# 2. DNS works
kubectl run test --rm -it --image=busybox:1.28 --restart=Never -- \
  nslookup my-service

# 3. Endpoints populated (the most common fail)
kubectl get endpoints my-service
kubectl get endpointslices -l kubernetes.io/service-name=my-service

# 4. Pods match selector and are Ready
kubectl get pods -l <selector>

# 5. From a test pod, can we reach the ClusterIP directly?
SERVICE_IP=$(kubectl get svc my-service -o jsonpath='{.spec.clusterIP}')
kubectl run test --rm -it --image=netshoot --restart=Never -- \
  curl -v --max-time 5 http://${SERVICE_IP}/

# 6. From a test pod, can we reach a backend pod IP directly?
POD_IP=$(kubectl get endpoints my-service -o jsonpath='{.subsets[0].addresses[0].ip}')
kubectl run test --rm -it --image=netshoot --restart=Never -- \
  curl -v --max-time 5 http://${POD_IP}:<port>/

# 7. Is the pod listening on the right interface?
kubectl exec my-backend-pod -- ss -tlnp

# 8. Any NetworkPolicy blocking?
kubectl get netpol -A | grep -i <relevant-namespace>

# 9. kube-proxy installed rules?
NODE=$(kubectl get pod test -o jsonpath='{.spec.nodeName}')
ssh $NODE 'sudo iptables-save | grep <service-ip>'
```

---

## Common "Service not routing" patterns

### Selector typo

```yaml
# Service
selector:
  app: webv2          # typo

# Pods
labels:
  app: web            # actual label
```

Endpoints empty. Fix selector.

### Pod readiness probe failing

Pod is Running, but readiness probe fails → not in Endpoints → no traffic.

```bash
kubectl describe pod <pod> | grep -A 5 Readiness
# Look for failures in Events
```

### Wrong port / targetPort

```yaml
spec:
  ports:
  - port: 80
    targetPort: 8080      # ← service forwards to this on the pod
```

But pod listens on 80 (not 8080). Mismatch → connection refused.

```bash
# Verify pod's listening port
kubectl exec <pod> -- ss -tlnp
```

### Multiple ports, wrong port name

```yaml
ports:
- name: http
  port: 80
  targetPort: 80
- name: metrics
  port: 9090
  targetPort: 9090
```

Client hits port 9090 expecting HTTP, gets connection refused (it's metrics). Use the right port for the right protocol.

### NetworkPolicy denies

```yaml
# Some NetworkPolicy in the namespace
spec:
  podSelector:
    matchLabels:
      app: backend
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: frontend
    # only frontend can reach backend
```

If your client isn't `app: frontend`, you're blocked. Either label the client correctly or extend the policy.

### CNI lost the route

Across nodes, a packet for pod `10.244.2.7` arrives at the wrong node. CNI's routing table is broken.

Rare. Symptoms: same-node traffic works, cross-node fails. Investigate the CNI agent.

---

## Exam heuristics

- For "service not working" exam questions, **always check Endpoints first**. 60% of the time it's empty.
- For "endpoints empty," the cause is selector mismatch or pod readiness failing.
- DNS confusion is also common — test by IP first, then by name.
- For NodePort scenarios, remember the firewall / security group on the cloud side.

## Mental traps

- Thinking "Service not working" is one issue. It's a stack of layers.
- Skipping the Endpoints check. They tell you immediately whether routing is the issue at all.
- Testing from a pod in a different namespace and being surprised. Use a test pod in the right namespace, or use FQDN.
- Confusing port (Service's virtual port) with targetPort (pod's port) with containerPort (pod spec, informational).
- Forgetting that headless Services have no ClusterIP. Don't try to curl <nothing>.
- Trusting `kubectl get svc` output's ClusterIP without verifying Endpoints. The IP exists; doesn't mean traffic flows.
- Believing `externalTrafficPolicy: Local` is always best. It preserves client IP but only routes to nodes with local pods — not all nodes.
