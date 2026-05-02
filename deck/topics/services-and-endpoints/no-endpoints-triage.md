## The single most common Service bug

Service exists. Pods exist. Clients can't reach the Service. You check `kubectl get endpoints` and the list is empty.

This single scenario covers about 40% of Service troubleshooting in the wild. This note is the decision tree for it.

---

## The quick sanity check

Before any deep triage, always:

```bash
kubectl get svc <svc>
kubectl get endpoints <svc>
# OR modern equivalent:
kubectl get endpointslices -l kubernetes.io/service-name=<svc>
```

If Endpoints is empty (`<none>` or no addresses), the Service can't route to anything. This is not a client problem, not a DNS problem, not a kube-proxy problem. It's an endpoint-population problem.

Four things must be true for a pod to land in Endpoints:

1. Pod's **labels match** the Service's selector.
2. Pod is in the **same namespace** as the Service.
3. Pod has been **scheduled** and has a **pod IP** (`.status.podIP`).
4. Pod's **Ready condition is True** (readiness probe passes, containers healthy).

Any one missing → no endpoint. Walk them in order.

---

## Decision tree

```
Endpoints is empty for Service web
│
├── 1. Does the selector match anything?
│      kubectl get svc web -o jsonpath='{.spec.selector}'
│      → {"app":"web","tier":"frontend"}
│
│      kubectl get pods -l app=web,tier=frontend
│      → (empty)
│
│      YES → selector mismatch: pods have different labels
│      NO  → continue
│
├── 2. Are the matching pods in the same namespace as the Service?
│      kubectl get pods -A -l app=web,tier=frontend
│      Check NAMESPACE column
│
│      If pods are in ns-a and Service is in ns-b → wrong namespace
│      Service selectors do not cross namespaces.
│
├── 3. Are the matching pods Running with IPs?
│      kubectl get pods -l app=web -o wide
│      → STATUS must be Running, IP must be present
│
│      If Pending / ContainerCreating / CrashLoop → fix the pod issue first
│
├── 4. Are the matching pods Ready?
│      kubectl get pods -l app=web -o jsonpath=\
│        '{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'
│      → all True or some False?
│
│      If False → readiness probe is failing. Check probe definition and pod logs.
│
└── 5. Does the Service actually have a selector at all?
      kubectl get svc web -o jsonpath='{.spec.selector}'
      → empty / null?
      
      Service has no selector → you must provide Endpoints manually.
      Common for external services (databases, migrations).
```

At the end of this tree, you should have a clear root cause.

---

## Step 1: Selector mismatch

The most common single cause. Check the Service's selector:

```bash
kubectl get svc web -o jsonpath='{.spec.selector}{"\n"}'
# {"app":"web","tier":"frontend"}
```

Now list pods that match:

```bash
kubectl get pods -l app=web,tier=frontend
```

If no pods match, the labels are different from what the Service expects. Compare against what the pods actually have:

```bash
kubectl get pods --show-labels
# web-5fd8c9d8f6-abc12   1/1   Running   app=web,pod-template-hash=...
# web-5fd8c9d8f6-def45   1/1   Running   app=web,pod-template-hash=...
```

Common mismatches:

- **Missing label**: Service wants `tier: frontend` but pods only have `app: web`.
- **Typo**: Service wants `app: web`, pods have `app: Web` (case-sensitive!).
- **Stale selector**: Deployment was renamed, pods have new labels, Service still uses old.
- **Extra selector key**: Service added `version: v2` while rolling out, matches zero pods.

### Fix: align labels

Option A: change the Service selector to match the pods.

```bash
kubectl patch svc web -p '{"spec":{"selector":{"app":"web"}}}'
```

Option B: add labels to the pods (usually via the Deployment's pod template):

```bash
kubectl patch deploy web -p '{"spec":{"template":{"metadata":{"labels":{"tier":"frontend"}}}}}'
```

Option B triggers a rollout. Option A is instant but make sure the selector is still specific enough — if you drop to `app: web` and multiple Deployments share that label, the Service now fronts all of them.

### Subtle: selectors are AND, not OR

```yaml
spec:
  selector:
    app: web
    tier: frontend
```

This means "app IS web AND tier IS frontend." A pod must have **both** labels. If you want "app IS web OR tier IS frontend," you can't — Services don't support OR in selectors. You'd need two Services.

---

## Step 2: Namespace mismatch

Services and pods must be in the same namespace. A common mistake:

```bash
# Service in 'default'
kubectl create svc clusterip web --tcp=80:8080

# Pods in 'production'
kubectl -n production run web --image=nginx --labels=app=web
```

From inside the cluster, `web.default.svc.cluster.local` resolves to the Service's ClusterIP, but the Service has zero Endpoints because no pods in `default` match.

Check:

```bash
kubectl get pods -A -l app=web
```

If the pods are in a different namespace, fix by recreating the Service in the correct namespace (or moving the pods — but recreating the Service is usually easier).

### Cross-namespace "access"

For truly cross-namespace communication, use the fully-qualified name. No Service magic involved:

```
<service>.<namespace>.svc.cluster.local
```

From a pod in `dev`, accessing `web.production.svc.cluster.local:80` goes to the Service in `production` namespace directly. But that requires the Service in `production` to have matching pods in `production` — each Service is still locally-scoped.

---

## Step 3: Pods are not Running or have no IP

A pod that matches labels but isn't in Endpoints may be:

- **Pending** (scheduling failed; see scheduler deck).
- **ContainerCreating** (kubelet setting up; sandbox or CNI issue).
- **Error** / **CrashLoopBackOff** (container failed).

```bash
kubectl get pods -l app=web -o wide
# Look at STATUS and IP columns

kubectl describe pod <pod> | tail -20
# Events reveal why it's stuck
```

Fix the underlying issue (ImagePullBackOff, resource shortage, readiness probe failing causing restarts) and the pod will automatically appear in Endpoints once Running + Ready.

### A pod without `.status.podIP` can't be in Endpoints

Even if the pod is Running, it needs an IP. No IP = not in slice. If a pod is Running but `.status.podIP` is empty (rare), the CNI is broken on that node.

---

## Step 4: Readiness probe failing

The most common "everything looks right but Endpoints is empty" case. The pod is Running, has the right labels, has an IP — but its readiness probe fails.

```bash
kubectl get pods -l app=web \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'
# web-abc   True
# web-def   False
```

If `Ready: False` for any pod, that pod is excluded from Endpoints. (EndpointSlice shows it with `ready: false, serving: false`.)

Investigate:

```bash
kubectl describe pod <pod> | grep -A 5 'Readiness\|Liveness'
# Readiness probe failed: HTTP probe failed with statuscode: 503

kubectl logs <pod>
# application logs
```

Common readiness probe failures:

- **Wrong port** — probe hits 8080 but app listens on 80.
- **Wrong path** — probe uses `/health`, app exposes `/healthz`.
- **Too aggressive timing** — `timeoutSeconds: 1` on a slow-starting app.
- **Probe requires auth** — `curl /metrics` with auth, probe can't authenticate.
- **App really is broken** — genuine bug, probe is doing its job.

Fix the probe definition (via the Deployment's pod template) and let the rollout propagate.

### publishNotReadyAddresses: an escape hatch

For StatefulSet peer discovery where pods need to reach each other before they've passed readiness:

```yaml
spec:
  publishNotReadyAddresses: true
```

Forces the endpoints controller to include not-ready pods. Use only when you know peer discovery is required during the not-ready window. Don't enable on general-purpose Services.

---

## Step 5: Service without a selector

```bash
kubectl get svc web -o yaml | grep -A 3 selector
# (nothing)
```

If the Service has no selector, the endpoints controller does **not** maintain its endpoints. You provide them.

```yaml
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: web-1
  labels:
    kubernetes.io/service-name: web    # link to the Service
addressType: IPv4
ports:
- port: 8080
  protocol: TCP
endpoints:
- addresses:
  - 10.0.0.50
  conditions:
    ready: true
```

Or the legacy form:

```yaml
apiVersion: v1
kind: Endpoints
metadata:
  name: web                             # same name as the Service
subsets:
- addresses:
  - ip: 10.0.0.50
  ports:
  - port: 8080
    protocol: TCP
```

Without either, Endpoints stays empty and the Service is useless.

### Why would you do this deliberately?

- Aliasing an external database inside the cluster (workloads point to `db.default`, which maps to an external IP).
- Cross-namespace or cross-cluster aliases where ExternalName's CNAME behavior doesn't work (clients can't follow CNAMEs).
- Migrating workloads — start with manual endpoints pointing at an external service, flip to pods once migrated.

---

## Edge cases worth knowing

### Pod labels match but includes a forbidden label like `pod-template-hash`

Deployments auto-add `pod-template-hash` to pod labels. If your Service selector includes this hash, it only matches pods of one rollout generation. Don't put `pod-template-hash` in Service selectors.

### Multi-port pods + partial match

A pod exposes port `http` but not `metrics`. If the Service declares both `http` and `metrics` via named targetPort, the pod appears in Endpoints **only for ports it supports**. The EndpointSlice drops it from the `metrics` port's slice but includes it in `http`'s.

### EndpointSlice per port name

When multiple pods expose the same port name on different numbers (v1: `http` on 8080, v2: `http` on 8090), they land in different EndpointSlices. Both appear in `kubectl get endpoints` but each slice has distinct `ports[]`.

### Terminating pods

A pod being deleted (graceful termination) goes into `terminating: true, serving: true` state. kube-proxy still sends traffic to existing connections; new connections go elsewhere. If the whole Deployment scales down simultaneously, all endpoints are terminating → new connections may find no available endpoints briefly.

---

## Diagnostic one-liners

```bash
# Service's selector
kubectl get svc <svc> -o jsonpath='{.spec.selector}{"\n"}'

# Matching pods + status
SELECTOR=$(kubectl get svc <svc> -o jsonpath='{range .spec.selector}{"="}{@}{end}' | tr '=' ',' | sed 's/^,//')
kubectl get pods -l $SELECTOR -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,IP:.status.podIP,READY:.status.conditions[?(@.type=="Ready")].status'

# Endpoints (legacy)
kubectl get endpoints <svc>

# EndpointSlices (modern)
kubectl get endpointslices -l kubernetes.io/service-name=<svc> -o yaml

# Probe definitions on the matching pods
kubectl get pods -l $SELECTOR -o jsonpath='{range .items[*]}{.metadata.name}: readiness={.spec.containers[0].readinessProbe}{"\n"}{end}'
```

---

## Exam heuristics

- The exam's "Service is not working" questions are usually selector mismatch or readiness probe issue. Start there.
- Always check Endpoints **first**. If empty, nothing else matters.
- Services don't cross namespaces for selection. Remember this when the exam sets up multi-namespace scenarios.
- "Create a Service for this Deployment" — use `kubectl expose`. It copies labels and avoids selector typos.
- For "Service without selector" questions, remember the Endpoints (or EndpointSlice) object must have the same name as the Service.

## Mental traps

- Assuming Endpoints will self-heal after a while. It won't — controllers react on change, not a retry loop.
- Forgetting that readiness probes gate Endpoints. Running ≠ Ready.
- Patching the Service selector to match broader than intended — suddenly multiple apps' pods become its backends.
- Confusing EndpointSlices with Endpoints. They're parallel: `kubectl get endpoints` still works on modern clusters.
- Using case-mismatched labels (`App: web` vs `app: web`). Labels are case-sensitive.
- Expecting ExternalName Services to have Endpoints. They don't — ExternalName is DNS-only.
