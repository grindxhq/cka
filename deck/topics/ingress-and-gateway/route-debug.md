## From `curl example.com` to `Hello, World`

When a user types an URL and gets a 503 or a timeout, the fault could be in any of 7 layers. Effective debugging walks them in order.

```
 External client
      │
      │ ① DNS resolve example.com
      ▼
 [ Cloud LB (public IP) ]
      │
      │ ② TCP to LB's :80 / :443
      ▼
 [ Controller pod (nginx/envoy/etc) ]
      │
      │ ③ TLS terminate (HTTPS only)
      │ ④ L7 routing based on Ingress/HTTPRoute rules
      │ ⑤ Resolve backend Service → Endpoints
      ▼
 [ Backend pod ]
      │
      │ ⑥ Receive HTTP request
      │ ⑦ App responds
      ▼
 [ Controller pod → LB → Client ]
```

Seven stages, each a possible failure.

---

## Step 0: Symptom triage

Three broad symptoms, each points to a different layer:

| Symptom                                                     | Likely layer                       |
|-------------------------------------------------------------|------------------------------------|
| DNS does not resolve the hostname                           | ① DNS                              |
| Connection refused / timeout to LB                          | ② LB or nodes (TCP layer)          |
| TLS error (bad cert, expired, name mismatch)                | ③ TLS / Ingress cert               |
| HTTP 404 from the controller                                | ④ routing rule not matching         |
| HTTP 503 from the controller                                | ⑤ no backend Endpoints             |
| HTTP 502 from the controller                                | ⑥ backend unreachable or slow       |
| HTTP 5xx from the backend                                   | ⑦ app error                         |

First: match the user's error to one of these. Then drill into the matching layer.

---

## Step 1: DNS

```bash
# From your workstation:
dig shop.example.com +short
# Expected: an IP address
```

If DNS fails:

- Check that the DNS A / CNAME record points at the controller's external IP.
- Get the controller's IP:
  ```bash
  kubectl get svc ingress-nginx-controller -n ingress-nginx \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
  ```
- If LB IP is `<pending>`, the cloud controller hasn't provisioned an LB (or MetalLB isn't running on bare metal).
- Compare the DNS-resolved IP with the LB IP.

If DNS resolves to the wrong IP, fix your DNS (registrar, internal DNS zone).

### On a cluster with no public DNS

For testing without configuring DNS:

```bash
curl --resolve shop.example.com:80:<controller-ip> http://shop.example.com/
```

`--resolve` maps the hostname to an IP for this one request. Avoids waiting for DNS propagation during testing.

---

## Step 2: Can you reach the LB?

```bash
# TCP connectivity
nc -zv <controller-ip> 80
nc -zv <controller-ip> 443
```

If "connection refused" / timeout:

- The cloud firewall may block inbound. Check security groups / network rules.
- Bare metal: node's firewall (`iptables -L`, `ufw status`, `firewalld`) may drop 80/443.
- MetalLB issue: IP isn't being advertised. Check MetalLB speaker pod logs.

If `nc` succeeds, move on.

---

## Step 3: TLS issues

### Symptoms

- `curl: (60) SSL certificate problem: certificate has expired`
- `curl: (60) SSL: no alternative certificate subject name matches`
- Browser: `NET::ERR_CERT_AUTHORITY_INVALID`

### Checks

```bash
# Inspect what certificate the LB is serving
openssl s_client -connect shop.example.com:443 -servername shop.example.com < /dev/null 2>/dev/null | \
  openssl x509 -noout -subject -issuer -dates -ext subjectAltName

# The Ingress's referenced Secret
kubectl get ingress shop -o yaml | grep -A 3 tls
# tls:
# - hosts: [shop.example.com]
#   secretName: shop-tls

kubectl get secret shop-tls -o yaml
# Verify tls.crt and tls.key are present and base64-decoded certs match
```

Common TLS failures:

- **Wrong Secret referenced** — typo in `secretName`, Secret in a different namespace.
- **Secret has wrong type** — must be `kubernetes.io/tls`, not `Opaque`.
- **Certificate hostname mismatch** — `shop.example.com` requested but cert is for `old.example.com`.
- **Expired certificate** — let's-encrypt renewal failed; cert-manager logs reveal.
- **Controller using default self-signed cert** — Ingress references a Secret that doesn't exist; controller falls back to default.

### cert-manager issues

```bash
# Check the Certificate object (cert-manager CRD)
kubectl describe certificate shop-tls

# Status conditions show renewal progress or errors
kubectl get certificaterequests
kubectl describe certificaterequest <name>
```

---

## Step 4: The 404 case — routing rule not matching

Got to the controller but it returned 404. The request doesn't match any Ingress/HTTPRoute rule.

```bash
# What's the controller actually seeing?
curl -i -H "Host: shop.example.com" http://<controller-ip>/
# HTTP/1.1 404 Not Found
# Server: nginx
```

Diagnose:

```bash
# All Ingresses in the cluster
kubectl get ingress -A

# Specific Ingress rules
kubectl describe ingress shop

# Check Host header matches an Ingress host rule
# Check path matches (with pathType semantics)
```

### Common causes

- **Hostname mismatch**: Ingress says `shop.example.com`, request has `Host: www.shop.example.com`. Add rule or use wildcard host.
- **pathType: Exact vs Prefix**: `pathType: Exact` requires exact match including trailing slash. `/` vs `/` matters.
- **Ingress in wrong namespace**: controller watches cluster-wide, but backend Service must be in the **same namespace** as the Ingress. Cross-namespace refs aren't standard in Ingress.
- **Wrong IngressClass**: Ingress references a class the installed controller doesn't own. Either Ingress has no class and no default exists, or it points at a class with no controller.

### Inspecting nginx's rendered config

```bash
kubectl exec -n ingress-nginx <controller-pod> -- nginx -T 2>/dev/null | grep -A 10 'server_name shop.example.com'
```

Shows exactly what nginx matches on. Useful when routing is mysterious.

---

## Step 5: The 503 case — no backend Endpoints

Got to the controller, rule matched, but the controller can't reach any backend pods.

```bash
# Typical message:
# HTTP/1.1 503 Service Temporarily Unavailable
```

Check the backend Service:

```bash
INGRESS_BACKEND_SVC=$(kubectl get ingress shop -o jsonpath='{.spec.rules[0].http.paths[0].backend.service.name}')
kubectl get endpoints $INGRESS_BACKEND_SVC
# NAME   ENDPOINTS                                AGE
# shop   <none>                                    10m          ← bad
# shop   10.244.1.5:80,10.244.2.7:80              10m          ← good
```

If Endpoints empty:

- Selector mismatch (see services-and-endpoints → no-endpoints-triage).
- Readiness probe failing on all pods.
- Namespace mismatch.
- The backend Service was renamed but the Ingress still references the old name.

### Service port vs targetPort

```bash
# Ingress references port 80 on the Service
# Service has port 80 → targetPort 8080
# Backend pods must listen on 8080

kubectl get svc $INGRESS_BACKEND_SVC -o jsonpath='{.spec.ports[*]}'
```

Cross-check the named or numeric port matches what the pod listens on.

---

## Step 6: The 502 case — backend unreachable or slow

The controller reached a backend pod but got no valid response.

```
HTTP/1.1 502 Bad Gateway
```

Diagnose:

```bash
# Controller logs
kubectl logs -n ingress-nginx -l app.kubernetes.io/component=controller --tail=100 | grep 502

# Common lines:
#   upstream timed out (110: Connection timed out)
#   no live upstreams while connecting to upstream
#   connect() failed (111: Connection refused)
```

Causes:

- **Pod doesn't listen on the expected port** — pod binds 127.0.0.1:8080 instead of 0.0.0.0:8080.
- **Pod is slow** — controller timeout exceeded. Increase `proxy-read-timeout` annotation.
- **NetworkPolicy blocking** — controller's pod IP not in the allowed ingress list of the backend.
- **Backend pod died between endpoint update cycles** — controller's cache is stale.

### Verify directly

```bash
# From a test pod, bypass the controller
kubectl run tmp --rm -it --image=nicolaka/netshoot --restart=Never -- bash
# inside:
curl http://<backend-pod-ip>:8080/
curl http://<backend-service-name>.<ns>.svc.cluster.local/
```

If direct access works, controller → backend is the issue. Controller logs show why.

---

## Step 7: The 5xx from the application

Hit the controller, routed correctly, connected to the backend, backend returned 500. App bug, not Kubernetes.

```bash
# App logs
kubectl logs <backend-pod>

# App's own health endpoint
kubectl port-forward <backend-pod> 8080:8080
# In another terminal:
curl http://localhost:8080/health
```

Not a networking problem — it's in the app.

---

## Gateway API debugging — similar, different objects

The same layer model, but the status surfaces are different:

```bash
# Gateway status
kubectl describe gateway main-gateway -n gateway-system

# Look for:
#   Conditions:
#   - Type: Accepted     Status: True
#   - Type: Programmed   Status: True
#   Listeners:
#   - Name: http
#     Conditions:
#     - Type: Accepted   Status: True
#     - Type: Programmed Status: True
```

If `Programmed: False`, the controller knows about the Gateway but couldn't realize it (e.g., TLS cert not found).

```bash
# HTTPRoute status
kubectl describe httproute shop -n default

# Look for:
#   Status:
#     Parents:
#     - Parent Ref:
#         Name: main-gateway
#         Namespace: gateway-system
#       Controller Name: gateway.nginx.org/nginx-gateway-controller
#       Conditions:
#       - Type: Accepted       Status: True
#       - Type: ResolvedRefs   Status: True
```

If `ResolvedRefs: False`, a backend Service or TLS Secret couldn't be resolved. Message will say which.

---

## Integrated debug playbook

```bash
# 0. What's the user actually seeing?
curl -i -H "Host: shop.example.com" http://<controller-ip>/
# Note the status code

# 1. DNS
dig shop.example.com +short

# 2. Controller is accepting traffic
nc -zv <controller-ip> 80
nc -zv <controller-ip> 443

# 3. Ingress exists and has correct class
kubectl get ingress shop
kubectl get ingressclass

# 4. Controller picked it up
kubectl logs -n ingress-nginx deploy/ingress-nginx-controller --tail=100 | grep shop

# 5. Backend service has Endpoints
BE=$(kubectl get ingress shop -o jsonpath='{.spec.rules[0].http.paths[0].backend.service.name}')
kubectl get svc $BE
kubectl get endpoints $BE

# 6. Can a test pod reach the service by name?
kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- http://$BE/

# 7. Can a test pod reach a specific backend pod?
kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- http://<pod-ip>:<port>/

# 8. App logs for 5xx
kubectl logs -l <backend-labels>
```

One of these will fail. That failure is your root cause.

---

## Useful controller-specific tools

### ingress-nginx

```bash
# Rendered nginx config
kubectl exec -n ingress-nginx <ctrl> -- cat /etc/nginx/nginx.conf
kubectl exec -n ingress-nginx <ctrl> -- nginx -T

# Reload history (the controller logs each reload)
kubectl logs -n ingress-nginx <ctrl> | grep -i reload
```

### Traefik

```bash
# Dashboard (if enabled)
kubectl port-forward -n traefik svc/traefik-dashboard 9000:9000
# Visit http://localhost:9000/dashboard/
```

### Gateway API controllers

- Envoy-based: `cilium hubble observe --server <hubble>` (for Cilium Gateway)
- NGINX Gateway Fabric: logs + Gateway/HTTPRoute status conditions

---

## Exam heuristics

- Always look at the status code in the response first. 404/503/502 each point to different layers.
- `kubectl describe ingress` shows events — the controller posts them when it observes / reconciles.
- `kubectl describe gateway` / `kubectl describe httproute` show status conditions for Gateway API.
- `curl --resolve` is your friend for testing without waiting on DNS.
- If the Ingress looks correct but nothing reaches the pod, always check Service Endpoints.

## Mental traps

- Assuming "DNS works" means "everything works." DNS just points at an IP; LB / controller / routes / backends can still be broken.
- Testing with `curl http://<ip>/` when the Ingress requires a Host header. You'll get 404 from the default backend. Use `curl -H "Host: shop.example.com"`.
- Looking at the controller's pod logs when the real issue is the cloud LB or the external firewall.
- Forgetting that `pathType: Exact` matches `/` as `/` only, not `/index.html`.
- Mixing up backend Service's port and pod's containerPort. Port mismatches are the silent killers.
- Debugging TLS without `openssl s_client`. `curl -k` hides cert problems.
- Applying changes to the Ingress object and not waiting for the controller to reconcile. Changes take seconds, not milliseconds.
- Trusting a green `kubectl get ingress` — it means "the object exists," not "the routing works."
