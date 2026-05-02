## Why pods can have many containers

A Pod is one or more containers that share network and (optional) storage namespaces. The "many" gives you three useful patterns:

- **Init containers** — preparation work. Run sequentially, must succeed before main containers start.
- **Sidecar containers** — long-lived helpers (log shippers, proxies, exporters). Run alongside main containers for the pod's lifetime.
- **Multi-container apps** — co-designed peers (rare but valid).

These are different beasts with different lifecycles. Knowing which one to reach for is half the design.

---

## Init containers (the classic kind)

```yaml
apiVersion: v1
kind: Pod
spec:
  initContainers:
  - name: wait-for-db
    image: busybox:1.28
    command: [ "sh", "-c", "until nc -z db 5432; do echo waiting for db; sleep 2; done" ]
  - name: schema-migrate
    image: app:1.0
    command: [ "/app", "migrate" ]
  containers:
  - name: app
    image: app:1.0
```

Behaviour:

- Run **sequentially** in the order declared.
- Each must exit 0 before the next starts.
- All must complete before any main container starts.
- Pod stays `Pending` (specifically `Initialized=False`) while init containers run.
- Failure: kubelet restarts per the pod's `restartPolicy` (Always/OnFailure → restart with backoff; Never → pod fails).

Use cases:

- Wait for a dependency (DB, configMap, external service).
- Run schema migrations before the app starts.
- Generate config files from environment.
- Clone a Git repo into a shared volume the main container reads.
- Set up file permissions on a shared volume.

### Limitations

Regular init containers do **not** support:

- `livenessProbe` / `readinessProbe` / `startupProbe`.
- `lifecycle.postStart` / `lifecycle.preStop` (in some versions; treat as unavailable).
- Service membership (they're never in Endpoints — they don't run long enough).

If you need probes on a "before main starts" workload, consider whether you really need an init container or whether your main container should self-check on startup.

### Resource accounting

Kubelet computes the "effective request" for scheduling as the **larger** of:

- Sum of all main container requests.
- Maximum single init container request.

Because init containers run one at a time, the largest one is the peak demand during init. Once init is done, main containers run together and their sum is the steady demand.

So a pod with one big init container (say, building an asset bundle) gets scheduled as if it needed that much, even though after init it shrinks back to a smaller working set. Keep init containers lean.

---

## Native sidecar containers (1.29 beta, 1.33 stable)

The new pattern: an init container with `restartPolicy: Always` runs **concurrently** with main containers and lives for the pod's lifetime.

```yaml
apiVersion: v1
kind: Pod
spec:
  initContainers:
  - name: log-forwarder            # this is a SIDECAR, not a classic init
    image: fluent-bit:latest
    restartPolicy: Always           # ← the magic field
    volumeMounts:
    - name: logs
      mountPath: /var/log/app
      readOnly: true
  containers:
  - name: app
    image: app:1.0
    volumeMounts:
    - name: logs
      mountPath: /var/log/app
  volumes:
  - name: logs
    emptyDir: {}
```

Lifecycle:

```
 1. Sidecar starts (the init slot but with restartPolicy: Always).
 2. Once sidecar is Ready (its readiness probe), main containers start.
 3. Main containers run; sidecar runs concurrently.
 4. On pod termination: main containers terminate first, sidecars terminate after (reverse order).
 5. If sidecar crashes mid-run, kubelet restarts it (per restartPolicy).
```

Why this is better than "just declare another container":

- **Ordered startup**: sidecars are ready before main containers; no race.
- **Ordered shutdown**: sidecars die *after* main containers, so logs/exports can finish.
- **Probe support**: sidecars get `livenessProbe`/`readinessProbe`/`startupProbe`.
- **Pod readiness**: a sidecar's readiness gates main container start, so the pod isn't briefly Ready without its sidecar.

### When to use a sidecar

- **Log shipper** (fluent-bit, Vector, Promtail) reading shared log directory.
- **Service mesh proxy** (Envoy, Linkerd) intercepting network traffic.
- **Metrics exporter** (translate app's stats into Prometheus).
- **Secret refresh** (Vault agent fetching tokens, writing to shared volume).
- **Cache warmer** (continuously prefetch into a shared cache volume).

The pattern: shared state via a volume or shared network, helper container that's small and focused.

### Pre-1.29 sidecar pattern (still works)

Before native sidecars, people put the helper in `containers:` (alongside the main app). Worked, but with rough edges:

- No startup ordering — both started in parallel; race conditions during init.
- No graceful shutdown ordering — both killed simultaneously.
- Tools like Istio's sidecar injection used pre-stop hacks.

If you target older clusters, the old pattern is still functional. New designs should use native sidecars.

---

## Multi-container apps — peer containers in the same pod

Less common, but valid: two equal-status containers cooperating tightly:

```yaml
spec:
  containers:
  - name: app
    image: web:1.0
    ports: [ { containerPort: 8080 } ]
  - name: file-puller
    image: rsync:latest
    command: [ "rsync", "--server", ... ]
    volumeMounts:
    - name: web-content
      mountPath: /var/www
  volumes:
  - name: web-content
    emptyDir: {}
```

Anti-patterns to avoid:

- Putting two unrelated apps in one pod "to save resources." Pod is the unit of failure; if one container crashes the pod, both go down.
- Cross-container coordination via signals. They share network namespace but not PID; no `kill` between them by default.

---

## The three classic multi-container patterns

Names from the literature:

### 1. Sidecar

A helper that adds capability the main container lacks. Examples:

- nginx + log-shipper.
- App + Envoy proxy.
- App + secret-fetcher.

The main container's image stays small; the helper is composed at deploy time.

### 2. Ambassador

A helper that proxies the main container's network calls to external services:

```
  main container → localhost:6379 → Ambassador (Redis sentinel client)
                                      → real Redis cluster
```

Main container thinks it's talking to a local single Redis; ambassador handles failover, sharding, etc.

### 3. Adapter

A helper that transforms the main container's output:

```
  main container writes legacy /var/log/app.log
                                 ↓
  Adapter container reads it, exposes Prometheus metrics on :9100
```

Main container is unchanged; adapter translates to the cluster's monitoring conventions.

These are conceptual labels, not Kubernetes API features. All three implement via "additional container in the pod" — sidecar (init+restartPolicy:Always) or peer (`containers:`).

---

## Networking and shared namespaces

All containers in a pod share:

- **Network namespace**: same pod IP, same `/etc/hosts`, same `/etc/resolv.conf`. Containers reach each other via `localhost:port`.
- **IPC namespace** (by default): can share SysV IPC.
- **UTS namespace**: same hostname.
- **Volumes**: any volume declared on the pod can be mounted by any container.

They do NOT share by default:

- **PID namespace**: each container's PID 1 is independent. To share, set `spec.shareProcessNamespace: true`.
- **Mount namespace**: each container has its own filesystem view (mounts only what it declared in `volumeMounts`).
- **User namespace**: typically separate.

### shareProcessNamespace

```yaml
spec:
  shareProcessNamespace: true
```

Now `ps aux` in container A shows processes from container B. Useful for:

- Debug containers that want to trace the main app's processes.
- Kubectl debug (which sometimes uses this).
- Pods where one container needs to signal another.

Caveat: container A can `kill` container B's processes. Security implication.

---

## Sharing data via volumes

The classic pattern for inter-container data:

```yaml
spec:
  volumes:
  - name: shared
    emptyDir: {}

  containers:
  - name: producer
    image: writer:1.0
    volumeMounts:
    - { name: shared, mountPath: /data }

  - name: consumer
    image: reader:1.0
    volumeMounts:
    - { name: shared, mountPath: /data, readOnly: true }
```

`emptyDir` lives for the pod's lifetime, accessible by all containers that mount it. Files writer creates appear to reader.

For larger / persistent data, use a PVC the same way.

---

## Pod-readiness gating

A pod is `Ready=True` when every container with a readiness probe reports passing **and** every sidecar (init+restartPolicy:Always) is Ready.

This means:

- A failing sidecar can keep the pod NotReady, removing it from Service Endpoints.
- A failing main container does the same.
- An init container failing keeps the pod Pending (never reaches Ready).

For Service routing, only Ready pods get traffic.

---

## Restart policy and multi-container pods

`spec.restartPolicy` is **pod-level**:

| Value | When a container exits...                                |
|-------|----------------------------------------------------------|
| `Always` (default) | Restart it. Required for Deployments/ReplicaSets/DaemonSets/StatefulSets. |
| `OnFailure`        | Restart only if exit code != 0. Used for Jobs.            |
| `Never`            | Don't restart. Pod ends when all containers exit.         |

For a multi-container pod with `restartPolicy: Always`, individual container restarts don't restart the pod — only the affected container restarts. Pod stays in its same network namespace, same volumes, same node.

`restartPolicy` for **classic init containers** mirrors the pod policy. **Sidecars** (init with `restartPolicy: Always`) restart per their own field, independently.

---

## Termination order with sidecars

When the pod is terminated:

```
 1. Pod gets deletion timestamp.
 2. kubelet terminates main containers first:
    - preStop hooks (if any)
    - SIGTERM
    - wait up to terminationGracePeriodSeconds
    - SIGKILL
 3. After main containers exit, kubelet terminates sidecars (in reverse declaration order):
    - preStop, SIGTERM, wait, SIGKILL
 4. Volume teardown, sandbox removal.
```

The sidecar gets a chance to flush logs, send remaining metrics, or close connections **after** the main container is gone.

If a sidecar is stuck (preStop hangs, ignores SIGTERM), it can extend the termination window. Hence the importance of well-behaved sidecars.

---

## Common patterns by example

### Log shipper sidecar

```yaml
apiVersion: v1
kind: Pod
spec:
  initContainers:
  - name: fluent-bit
    image: cr.fluentbit.io/fluent/fluent-bit:latest
    restartPolicy: Always
    volumeMounts:
    - name: app-logs
      mountPath: /var/log/app
      readOnly: true
    - name: fluent-bit-config
      mountPath: /fluent-bit/etc
  containers:
  - name: app
    image: app:1.0
    volumeMounts:
    - name: app-logs
      mountPath: /var/log/app
  volumes:
  - name: app-logs
    emptyDir: {}
  - name: fluent-bit-config
    configMap:
      name: fluent-bit
```

App writes to `/var/log/app/app.log`; fluent-bit tails it and ships to ES/Loki/CloudWatch.

### Init container for migrations

```yaml
spec:
  initContainers:
  - name: db-migrate
    image: app:1.0
    command: [ "/app", "migrate" ]
    env:
    - name: DB_URL
      valueFrom:
        secretKeyRef: { name: db, key: url }
  containers:
  - name: app
    image: app:1.0
```

Migrations run once per pod start. Pod stays Pending until migrations complete. Good for: schema upgrades, idempotent setup, cache warming.

### Wait-for-dependency

```yaml
initContainers:
- name: wait-for-redis
  image: busybox:1.28
  command:
  - sh
  - -c
  - until nc -z redis.default.svc.cluster.local 6379; do echo waiting; sleep 2; done
```

Pod waits until the dependency is reachable. Better than the app's own retry logic for cleaner state.

### Service mesh proxy (Envoy)

```yaml
spec:
  initContainers:
  - name: envoy
    image: envoyproxy/envoy:v1.30
    restartPolicy: Always
    ports:
    - containerPort: 15001
    volumeMounts:
    - name: envoy-config
      mountPath: /etc/envoy
  containers:
  - name: app
    image: app:1.0
    # App talks to localhost:15001; envoy routes to mesh
```

Istio, Linkerd, etc. inject this pattern automatically (mutating webhook).

---

## Debugging multi-container pods

```bash
# Logs from a specific container
kubectl logs <pod> -c <container>

# Logs from previous restart of a container
kubectl logs <pod> -c <container> --previous

# Stream all containers' logs (must use a label selector, not pod name)
kubectl logs -l app=web --all-containers --tail=100 -f

# Exec into a specific container
kubectl exec -it <pod> -c <container> -- /bin/sh

# Status of each container
kubectl get pod <pod> -o jsonpath='{range .status.containerStatuses[*]}{.name}: ready={.ready}, restarts={.restartCount}, state={.state}{"\n"}{end}'

# Init container statuses
kubectl get pod <pod> -o jsonpath='{range .status.initContainerStatuses[*]}{.name}: state={.state}{"\n"}{end}'

# Events
kubectl describe pod <pod> | sed -n '/Events:/,$p'
```

The `-c <container>` flag is essential when you have multiple containers. Without it, `kubectl logs` errors with "Error: a container name must be specified."

---

## Common multi-container mistakes

### Putting unrelated apps in one pod

If app A and app B don't share state and don't depend on each other, they shouldn't share a pod. Use separate Deployments. Pods are units of failure — one container crashing tarnishes the whole pod's restart count.

### Using a peer container when a sidecar is correct

If the helper needs to be Ready before the main app, and outlive shutdown to flush state, use a **sidecar** (init + restartPolicy: Always). Putting it in `containers:` causes startup races and shutdown data loss.

### Using a sidecar when an init container is correct

A migration job is one-shot — it runs, exits, and the app starts. That's an **init container**, not a sidecar. Sidecars run forever and consume resources continuously.

### Sharing too much (or too little)

`shareProcessNamespace: true` for a debug-mode pod is great. For production it's a security gap (containers can `kill` each other). Default off.

### Forgetting `-c` in `kubectl logs`

For multi-container pods, you must specify `-c`. Spend a few seconds confused, then add the flag.

---

## Exam heuristics

- Init containers for "wait for X" and "do this once before app" — easy and common exam pattern.
- For modern sidecars (log shipper etc.), use `restartPolicy: Always` on an init container — but check the cluster's Kubernetes version. Older clusters need the legacy peer-container pattern.
- `kubectl logs <pod> -c <container>` — drill in with `-c` when there are multiple containers.
- For "pod must wait for service X to exist," use an init container with `nslookup` or `nc -z` in a loop.

## Mental traps

- Confusing `initContainers` (sequential, must succeed) with `containers` (parallel, one's failure is just that container's problem).
- Expecting init containers to support probes. They don't (regular ones).
- Putting `restartPolicy: Always` on a regular `containers:` entry — that's not a thing; `restartPolicy` is a pod-level setting (or, for sidecars only, a per-container override on init containers).
- Using `shareProcessNamespace: true` casually. Security implications.
- Designing a sidecar that's bigger than the main app. Sidecars should be lightweight.
- Forgetting that sidecar termination is **after** main container termination. If the sidecar processes the main app's data on shutdown, this matters.
- Using ephemeralContainers for production functionality. They're for `kubectl debug`; not a pattern for stable workloads.
