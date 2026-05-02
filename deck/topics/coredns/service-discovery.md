## What records Kubernetes actually publishes

CoreDNS (configured via the `kubernetes` plugin) creates a consistent set of records for every Service and, optionally, every Pod. Knowing the exact forms lets you:

- Predict whether a name will resolve.
- Write clients that use the stable names (StatefulSet pods).
- Debug with `dig` by querying the right record type.

This note walks each record class with examples.

---

## The cluster domain

Everything in-cluster lives under a configurable suffix, set at install time:

```
cluster.local                 ← default; set via --cluster-domain on kubelet and Corefile
```

Kubeadm uses `cluster.local`. Rare custom clusters might use `cluster.dev.example.com` or similar. CKA always assumes `cluster.local`.

The full zone is `cluster.local`, with subzones `svc.cluster.local` (services) and `pod.cluster.local` (pods).

---

## Service A/AAAA records

### Normal (ClusterIP) Services

```
<service-name>.<namespace>.svc.cluster.local   →  A   <ClusterIP>
                                               →  AAAA <IPv6 ClusterIP>  (dual-stack)
```

Examples:

```
web.default.svc.cluster.local         → 10.96.0.50
coredns.kube-system.svc.cluster.local → 10.96.0.10
kubernetes.default.svc.cluster.local  → 10.96.0.1
```

Clients connect to this name; kube-proxy DNATs the ClusterIP to a real pod. One IP per query, regardless of how many pods back the service.

### Short forms (via search path)

In a pod's namespace, these all resolve to the same Service:

```
web                                  ← search-expanded
web.default                          ← search-expanded
web.default.svc                      ← search-expanded (without final cluster.local)
web.default.svc.cluster.local        ← fully qualified
web.default.svc.cluster.local.       ← fully qualified, absolute (dot at end)
```

Across namespaces, you must be explicit past the first segment:

```
# From a pod in namespace 'dev', to reach the 'web' Service in 'prod':
web.prod                             ← works
web.prod.svc                         ← works
web.prod.svc.cluster.local           ← works (FQDN)
web                                  ← WRONG: resolves to web.dev.svc... (own namespace)
```

### Headless Services

`clusterIP: None`. The plugin returns pod IPs instead of a single ClusterIP:

```
mysql.default.svc.cluster.local      → A 10.244.1.5
                                     → A 10.244.2.7
                                     → A 10.244.3.12
```

Clients get all Ready pod IPs in one query. Load balancing is client-side (round-robin typically by the resolver).

### ExternalName Services

Returns a CNAME instead of A:

```
db.default.svc.cluster.local         → CNAME db.prod.example.com.
```

The client then resolves `db.prod.example.com` (via upstream DNS, not CoreDNS). CoreDNS itself does not proxy traffic — it's just telling the client where to look.

---

## Pod A/AAAA records

Less commonly used, but Pods also get DNS records via the `pod.cluster.local` subzone:

```
<pod-ip-with-dashes>.<namespace>.pod.cluster.local   →  A  <pod-ip>
```

Example for pod at `10.244.1.5` in `default`:

```
10-244-1-5.default.pod.cluster.local  → 10.244.1.5
```

### Pod-records mode

Controlled by the `pods` directive in the Corefile:

```
kubernetes cluster.local {
  pods insecure   | verified   | disabled
}
```

- **`insecure`** (default on modern CoreDNS) — returns the A record based on the name alone, regardless of whether the pod actually exists. Fast, memory-light.
- **`verified`** — validates that a pod with matching IP+namespace exists before answering. Slower, more memory, safer.
- **`disabled`** — no pod records at all. Lookups of `pod.cluster.local` return NXDOMAIN.

On a kubeadm cluster, `insecure` is default. Pod records are rarely used in practice — the common use case was legacy cross-pod addressing, now largely replaced by StatefulSets.

---

## StatefulSet per-pod DNS names

StatefulSets are the **exception** where pod-level DNS matters. With a headless Service backing a StatefulSet:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: mysql
spec:
  clusterIP: None
  selector:
    app: mysql
  ports:
  - port: 3306
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
spec:
  serviceName: mysql              ← must match the headless Service
  replicas: 3
  selector:
    matchLabels:
      app: mysql
  template:
    metadata:
      labels:
        app: mysql
    spec:
      # ... containers
      hostname: mysql
      subdomain: mysql             ← typically managed by StatefulSet
```

Each pod in the StatefulSet gets:

```
<pod-name>.<service-name>.<namespace>.svc.cluster.local  →  A <pod-ip>
```

Concretely for `replicas: 3`:

```
mysql-0.mysql.default.svc.cluster.local → 10.244.1.5
mysql-1.mysql.default.svc.cluster.local → 10.244.2.7
mysql-2.mysql.default.svc.cluster.local → 10.244.3.12
```

These names are **stable** — if a pod is rescheduled to another node, the name stays the same (only the IP changes), and the DNS record updates automatically.

This is what makes StatefulSets usable for:

- Clustered databases (each replica addresses its peers by stable name).
- Consensus systems (etcd, ZooKeeper — each member knows its neighbors by name).
- Sharded caches.

### Why it needs a headless service

A regular (ClusterIP) Service would front the pods anonymously — you couldn't address an individual pod. Only headless services create per-pod DNS.

### subdomain field

The `spec.subdomain` on a pod sets the middle segment of its DNS name. For StatefulSet pods, it's implicit (matches `serviceName`). For standalone pods, you can set it manually — but you also need a matching headless Service with that name.

---

## SRV records — for named ports

Named ports get `_name._protocol.service.namespace.svc.cluster.local`:

```
_http._tcp.web.default.svc.cluster.local    → SRV <priority> <weight> <port> <target>
```

For Services, target is the Service FQDN:

```
_http._tcp.web.default.svc.cluster.local    → 0 100 80 web.default.svc.cluster.local.
```

For headless Services, targets are per-pod:

```
_http._tcp.mysql.default.svc.cluster.local  →
  0 100 3306 mysql-0.mysql.default.svc.cluster.local.
  0 100 3306 mysql-1.mysql.default.svc.cluster.local.
  0 100 3306 mysql-2.mysql.default.svc.cluster.local.
```

Applications that speak SRV (e.g. HashiCorp Consul consumers, some gRPC discovery) can auto-discover endpoints and ports this way.

### Testing SRV

```bash
kubectl run netshoot --rm -it --image=nicolaka/netshoot --restart=Never -- \
  dig SRV _http._tcp.web.default.svc.cluster.local
```

---

## PTR (reverse lookup) records

CoreDNS answers reverse queries for cluster IPs:

```
$ dig @10.96.0.10 -x 10.96.0.50
;; ANSWER SECTION:
50.0.96.10.in-addr.arpa. 30 IN PTR web.default.svc.cluster.local.
```

Mechanism: the `kubernetes` plugin registers for `in-addr.arpa.` and `ip6.arpa.` zones. It answers based on the Service CIDR.

Pod reverse lookups also work if pod records are enabled:

```
$ dig @10.96.0.10 -x 10.244.1.5
;; ANSWER SECTION:
5.1.244.10.in-addr.arpa. 30 IN PTR 10-244-1-5.default.pod.cluster.local.
```

Useful for log parsers that map IPs back to names.

---

## Cross-namespace access

Services are namespace-scoped but discoverable across namespaces. Clients in namespace A can reach a Service `web` in namespace B via `web.B.svc.cluster.local`:

```
# From pod in namespace dev:
curl http://web.prod.svc.cluster.local/

# Or short:
curl http://web.prod/
```

No Service configuration needed — the DNS plugin answers based on the global state. Only a NetworkPolicy could actually prevent the connection (see network-policies deck).

### The one namespace-less path: ExternalName across namespaces

ExternalName Services can act as in-cluster aliases:

```yaml
# In namespace 'dev', an alias pointing at 'prod' namespace
apiVersion: v1
kind: Service
metadata:
  name: prod-web
  namespace: dev
spec:
  type: ExternalName
  externalName: web.prod.svc.cluster.local
```

Now `prod-web.dev.svc.cluster.local` is a CNAME to `web.prod.svc.cluster.local`. Applications in `dev` treat it as a local service. Useful for migrations.

---

## dnsConfig and the custom search path

A pod can add its own `dnsConfig` on top of the default:

```yaml
spec:
  dnsPolicy: ClusterFirst           # or None for total override
  dnsConfig:
    searches:
    - internal.example.com
    - infra.example.com
    options:
    - name: ndots
      value: "2"
    nameservers:
    - 10.0.0.53
```

With `dnsPolicy: ClusterFirst`, these are **appended** to kubelet's defaults. With `dnsPolicy: None`, they **replace** them entirely.

Common use: apps that expect certain corporate search domains, or that don't like ndots:5.

---

## External/hybrid DNS (customizing CoreDNS)

Adding a stub zone for external DNS (e.g. office DNS for `internal.example.com`):

```
.:53 {
    kubernetes cluster.local in-addr.arpa ip6.arpa { ... }
    # default chain ...
}

internal.example.com:53 {
    forward . 10.0.0.53            ← office DNS server
    cache 30
}
```

This goes in the Corefile (see `configmap-and-reload`). Pods can now resolve `foo.internal.example.com` via the office DNS.

Alternatives:

- Use `hostAliases` on each pod (static).
- Configure per-pod `dnsConfig` with a custom nameserver (explicit).
- Run a DNS server as a Service and forward from CoreDNS.

---

## A complete lookup map

For a Service `web` in `default` namespace with 3 backing pods on ports `http` (8080) and `metrics` (9090):

```
Record type                                                         Resolves to
─────────────────────────────────────────────────────────────────  ─────────────────────────────────
A     web.default.svc.cluster.local                                10.96.0.50
AAAA  web.default.svc.cluster.local                                fd00::50 (dual-stack)
SRV   _http._tcp.web.default.svc.cluster.local                     0 100 8080 web.default.svc.cluster.local.
SRV   _metrics._tcp.web.default.svc.cluster.local                  0 100 9090 web.default.svc.cluster.local.
PTR   50.0.96.10.in-addr.arpa                                      web.default.svc.cluster.local.

# If headless:
A     web.default.svc.cluster.local                                10.244.1.5, 10.244.2.7, 10.244.3.12
SRV   _http._tcp.web.default.svc.cluster.local                     0 100 8080 web-0.web.default.svc.cluster.local.
                                                                   0 100 8080 web-1.web.default.svc.cluster.local.
```

Plus per-pod records (StatefulSet only):

```
A     web-0.web.default.svc.cluster.local                          10.244.1.5
A     web-1.web.default.svc.cluster.local                          10.244.2.7
```

---

## Exam heuristics

- `kubectl run bb --rm -it --image=busybox:1.28 --restart=Never -- nslookup <svc>` is the canonical DNS test.
- For cross-namespace: use `svc.namespace` form, not just `svc`.
- If the exam says "StatefulSet needs stable DNS," always pair with a headless Service whose name matches `serviceName`.
- SRV records matter for gRPC and some HA databases — know the format.
- The Service named `kubernetes` in `default` always exists and resolves to the apiserver's Service IP. Good baseline check.

## Mental traps

- Forgetting the `.svc.` segment in FQDNs. It's not optional — `web.default.cluster.local` does not resolve.
- Expecting non-StatefulSet pods to get per-pod DNS names. They only get generic pod records (10-244-1-5.default.pod.cluster.local), not `<name>.<svc>.<ns>.svc.cluster.local`.
- Assuming pod records are on by default in all CoreDNS versions. They are, with `pods insecure`, but old configs may have `pods disabled`.
- Trying to resolve a Service from a pod in a different cluster. DNS is cluster-scoped.
- Querying `web.default` and expecting to get an A record for the Service. `default` is namespace; you need `.svc.cluster.local` for the full qualification. Short forms work only via search expansion in pods.
- Using `ExternalName` thinking it provides load balancing. It doesn't — it's DNS CNAME only.
