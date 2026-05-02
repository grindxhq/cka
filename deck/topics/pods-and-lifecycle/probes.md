## Three probes, three different jobs

Kubernetes has three probe types. They look similar in YAML; they do completely different things to your pod.

| Probe          | What kubelet does on failure                              | What it gates                                  |
|----------------|-----------------------------------------------------------|-----------------------------------------------|
| `startupProbe` | Once it succeeds, hand off to live/ready probes. While running, those don't run. If it never succeeds, kill the container. | Slow-startup containers (Java, large data load) |
| `readinessProbe` | Mark the container Not Ready → pod removed from Service Endpoints | Whether traffic is sent to this pod            |
| `livenessProbe` | Kill the container (kubelet restarts per restartPolicy)   | Whether the container is still healthy         |

All three use the same handler types (HTTP, TCP, exec, gRPC) and the same threshold/timing fields. The behaviour on failure is the difference.

---

## The handlers

### HTTP GET

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
    scheme: HTTP                # or HTTPS
    httpHeaders:
    - name: X-Custom-Header
      value: probe
```

kubelet does an HTTP GET. Success = 200-399 status code. Anything else (4xx, 5xx, connection refused, timeout) = failure.

The probe hits the **pod's IP** directly, not a Service. The path must be served by the container itself. The port can be a number (`8080`) or a name (`http`) referring to a `containerPort.name`.

Default `Host` header is the pod IP. Some apps care; override with `httpHeaders`.

### TCP Socket

```yaml
livenessProbe:
  tcpSocket:
    port: 5432
```

kubelet attempts a TCP connection. Success = handshake completes. Failure = connection refused, reset, or timeout.

Useful for non-HTTP services (databases, caches). Doesn't verify the service is *responding* meaningfully — just that something accepted the connection. A frozen process that holds an open listening socket will pass a TCP probe.

### Exec

```yaml
livenessProbe:
  exec:
    command: [ "/bin/sh", "-c", "pg_isready -U postgres" ]
```

kubelet runs the command **inside the container**. Success = exit code 0. Failure = non-zero or timeout.

Most flexible — you can write any check. Most expensive — forks a process every probe interval. Use sparingly for high-frequency probes.

The command must exist in the container image. `curl` and `wget` aren't always there in minimal images; pre-install or use a different handler.

### gRPC

```yaml
livenessProbe:
  grpc:
    port: 9000
    service: grpc.health.v1.Health    # optional; specific gRPC service
```

kubelet sends a gRPC health check (`grpc.health.v1.Health/Check`). Success = `SERVING`. Failure = anything else, or unreachable.

The container must implement the standard gRPC health protocol. For non-standard gRPC, fall back to exec with `grpcurl` or similar.

---

## The timing fields

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 8080 }
  initialDelaySeconds: 0       # wait before first probe
  periodSeconds: 10            # how often to probe
  timeoutSeconds: 1            # per-probe timeout
  failureThreshold: 3          # consecutive failures = failure
  successThreshold: 1          # consecutive successes = success (1 for liveness/startup)
```

Defaults:

| Field | Default |
|-------|---------|
| initialDelaySeconds | 0 |
| periodSeconds | 10 |
| timeoutSeconds | 1 |
| failureThreshold | 3 |
| successThreshold | 1 |

Calculation:

- **Time before kubelet declares container failed** (after start) = `initialDelaySeconds + periodSeconds * (failureThreshold - 1) + timeoutSeconds * failureThreshold`
- For defaults: 0 + 10*2 + 1*3 = ~23 seconds before action.

For `successThreshold`:

- Liveness / startup: must be 1 (only "is it healthy now" matters).
- Readiness: can be > 1 (require N consecutive successes before re-Ready).

---

## startupProbe — for slow-starting apps

```yaml
spec:
  containers:
  - name: java-app
    image: java-app:1.0
    startupProbe:
      httpGet: { path: /actuator/health, port: 8080 }
      failureThreshold: 30
      periodSeconds: 10
    livenessProbe:
      httpGet: { path: /actuator/health, port: 8080 }
      periodSeconds: 5
    readinessProbe:
      httpGet: { path: /actuator/ready, port: 8080 }
      periodSeconds: 5
```

How it works:

- While startup is running, **liveness and readiness do NOT run**.
- Startup probe gets `failureThreshold * periodSeconds` to succeed once. Above example: 30 * 10s = 5 minutes.
- Once it succeeds, kubelet "hands off" to liveness/readiness for the rest of the container's life.
- If startup fails (exhausts attempts), kubelet kills the container per restart policy.

Use case: apps that need 1-5 minutes to load (Java warming up the JIT, Postgres replaying WAL, ML model loading weights). Without startup probe, an aggressive liveness probe would kill the container before it ever became ready.

Alternative: `initialDelaySeconds: 300` on liveness. But that's rigid; startupProbe is variable (succeeds as soon as the app's ready, however long that takes).

---

## readinessProbe — for traffic gating

```yaml
readinessProbe:
  httpGet: { path: /ready, port: 8080 }
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 3
  successThreshold: 2          # require 2 consecutive passes before Ready
```

Behaviour:

- Pod's `Ready` condition reflects readiness probe state for every container with one.
- `Ready=True` → pod is included in Service Endpoints (kube-proxy routes traffic here).
- `Ready=False` → pod removed from Endpoints. Traffic stops. Existing connections continue (TCP doesn't reset).

This is the **traffic shedding mechanism**:

- App overloaded? Flip readiness to false; kube-proxy stops sending new requests.
- App about to deploy a fix? Flip readiness false, deploy, flip back true.
- App handling shutdown? Sometimes flip readiness false in preStop, sleep a bit, then exit — gives in-flight traffic time to finish on this pod while new traffic goes elsewhere.

### What `/ready` should check

- App is initialized.
- Required dependencies are reachable (DB connection pool warm, cache populated).
- App can serve traffic right now (queue not full, not in graceful-shutdown mode).

### What `/ready` should NOT check

- Things that don't affect this pod's ability to serve. A failing downstream that the app handles gracefully (returns 503 cleanly) doesn't need to fail readiness.

---

## livenessProbe — for self-healing

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 8080 }
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 3
```

Behaviour:

- On failure (failureThreshold consecutive), kubelet kills the container.
- Container restarts per `restartPolicy` (Always for Deployments → restart).
- Pod stays in same node, same volumes, same IP. Just the container restarts.

The intent: **recover from stuck-process states**. Deadlock, infinite loop, memory leak that's about to OOM but hasn't yet. Liveness gives you a kill switch.

### What `/healthz` should check

- Process can do basic work (return a small JSON, not call DB).
- Not stuck (timer-based check that something updates a watchdog).

### What `/healthz` should NOT check

- Downstream dependencies. If your DB is down, your app is degraded but not dead. Killing the app doesn't bring the DB back; it just causes restart loops.
- Anything you'd want to alert on rather than kill on.

A good liveness check: "can the app respond to a trivial request?" A bad one: "is everything fine?"

### The dangerous over-eager liveness probe

```yaml
# BAD: kills container on any HTTP error
livenessProbe:
  httpGet:
    path: /
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 1
  failureThreshold: 1
```

Aggressive timing + main app endpoint = kill loop. Any 5xx from a transient issue → kill → restart → "fix" is slow → another 5xx → kill again.

Symptoms: pod has `restartCount: 47` and rising. `kubectl describe` events show repeated `Liveness probe failed`.

Better:

```yaml
livenessProbe:
  httpGet:
    path: /healthz             # dedicated health endpoint
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 3
```

Generous initial delay, longer period, multiple failures required before action.

---

## How the three interact

```
Container starts
    │
    ▼
startupProbe runs (if defined)
    │
    │ Liveness/Readiness do NOT run during this time
    │
    ▼
startupProbe succeeds OR exhausts attempts
    │
    ├── Exhausted: container killed, restart per policy
    │
    ▼
Liveness + Readiness probes start running
    │
    ├── Liveness fails: container killed, restart
    ├── Readiness fails: pod marked NotReady, removed from Service Endpoints
    │
    ▼
Repeat until container is killed for some other reason
```

A container without a startup probe goes straight to liveness/readiness from start (with `initialDelaySeconds` on each probe controlling the warm-up).

A container with no probes at all is "always ready, always alive." Pod is Ready as soon as it starts, never auto-restarts (kubelet only restarts on container exit).

---

## Probe + restartPolicy interaction

| restartPolicy | Liveness fails... | Container exits... |
|---------------|--------------------|---------------------|
| Always        | restart             | restart              |
| OnFailure     | restart (treated as failure exit) | restart on non-zero exit |
| Never         | container stays Failed; pod becomes Failed | pod ends |

For Deployments / ReplicaSets / DaemonSets / StatefulSets: pod-level restartPolicy must be Always (enforced by admission). Liveness failures = restarts.

For Jobs: usually restartPolicy: Never or OnFailure. Liveness might not be useful; the Job's own retry semantics handle recovery.

---

## Real examples

### Postgres

```yaml
- name: postgres
  image: postgres:16
  startupProbe:
    exec:
      command: [ "pg_isready", "-U", "postgres", "-h", "localhost" ]
    failureThreshold: 30
    periodSeconds: 5
  livenessProbe:
    exec:
      command: [ "pg_isready", "-U", "postgres", "-h", "localhost" ]
    periodSeconds: 30
  readinessProbe:
    exec:
      command: [ "pg_isready", "-U", "postgres", "-h", "localhost" ]
    periodSeconds: 5
```

Slow startup (30 * 5s = 2.5 minutes) for replaying WAL on cold start. Once ready, less aggressive probing.

### Java Spring Boot

```yaml
startupProbe:
  httpGet: { path: /actuator/health/readiness, port: 8080 }
  failureThreshold: 60
  periodSeconds: 10
livenessProbe:
  httpGet: { path: /actuator/health/liveness, port: 8080 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /actuator/health/readiness, port: 8080 }
  periodSeconds: 10
```

Spring Boot has separate `liveness` and `readiness` health groups (since 2.3) — `liveness` checks "process is alive"; `readiness` checks "ready to serve."

### Redis

```yaml
livenessProbe:
  exec: { command: [ "redis-cli", "ping" ] }
  periodSeconds: 10
readinessProbe:
  exec: { command: [ "redis-cli", "ping" ] }
  periodSeconds: 5
```

Redis-cli ping — exits 0 if server replies PONG.

### nginx

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 80 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /, port: 80 }
  periodSeconds: 5
```

nginx serves `/` always (it's a web server); use `/healthz` if you have a config-based health endpoint.

---

## Probe failure events

```bash
kubectl describe pod <pod>
# ...
# Events:
#   Warning  Unhealthy  35s (x6 over 2m)  kubelet  Liveness probe failed: HTTP probe failed with statuscode: 503
#   Normal   Killing    35s               kubelet  Container app failed liveness probe, will be restarted
```

Events are on the **pod**, not the container. Filter:

```bash
kubectl get events --field-selector involvedObject.name=<pod>,reason=Unhealthy
```

For long-term monitoring, aggregate Prometheus metrics:

```
kube_pod_container_status_restarts_total            # restart count, ever-increasing
kube_pod_status_ready{condition="true"}              # 1 if Ready, 0 otherwise
```

A pod's restart count rising rapidly = liveness probe killing it. Investigate.

---

## Probe-related debug commands

```bash
# Probe definitions on a pod
kubectl get pod <pod> -o jsonpath='
{range .spec.containers[*]}
{.name}:
  liveness:  {.livenessProbe}
  readiness: {.readinessProbe}
  startup:   {.startupProbe}
{"\n"}{end}'

# Container restart counts
kubectl get pods -o custom-columns='NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,RESTARTS:.status.containerStatuses[0].restartCount'

# Why was the previous instance killed?
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].lastState}'
# {"terminated":{"exitCode":143,"reason":"Error","startedAt":"...","finishedAt":"..."}}

# Logs from the previous instance (the one that died)
kubectl logs <pod> -c <container> --previous
```

---

## Common mistakes

### Liveness too aggressive on slow-starting apps

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 8080 }
  initialDelaySeconds: 5
```

App takes 60 seconds to start. Liveness fires after 5s + 30s (3 failures @ 10s) = ~35s. Container killed during startup. Restart loop.

Fix: add startup probe, OR raise `initialDelaySeconds` to >> startup time, OR make `/healthz` lightweight enough to respond during startup.

### Liveness checking dependencies

```yaml
livenessProbe:
  httpGet: { path: /api/db-test, port: 8080 }
```

`/api/db-test` queries the database. DB is briefly down → probe fails → kubelet kills app → app restart-loops while DB is recovering.

Fix: liveness should check **only the app process itself**. Dependency health is a different concern.

### Readiness with dependencies (correctly!)

This is OK and often correct:

```yaml
readinessProbe:
  httpGet: { path: /ready, port: 8080 }
```

Where `/ready` checks DB connectivity. If DB is down, app is unable to serve, drop from Endpoints. When DB recovers, app is Ready again.

Readiness controls traffic; failing it doesn't kill the pod, just removes traffic.

### Probes hitting the wrong port

```yaml
ports:
- containerPort: 8080
  name: http
livenessProbe:
  httpGet:
    path: /
    port: 80                      # WRONG: app listens on 8080
```

Probe always fails. Container looks dead. Restart loop.

Fix: match the probe port to the actual listening port.

### exec probes that fork heavy processes

```yaml
livenessProbe:
  exec:
    command: [ "curl", "-f", "http://localhost:8080/healthz" ]
  periodSeconds: 5
```

Fork a curl every 5 seconds in every pod = noticeable CPU on busy nodes. Prefer httpGet for HTTP endpoints — it's done by kubelet, no fork.

### successThreshold > 1 for liveness/startup

```yaml
livenessProbe:
  ...
  successThreshold: 2     # INVALID for liveness
```

Kubernetes rejects this. Liveness/startup `successThreshold` must be 1.

---

## Exam heuristics

- For "the app must wait for X before being ready," readinessProbe is the right answer.
- For "container should be killed and restarted if stuck," livenessProbe.
- For "app takes minutes to start," startupProbe.
- Always know which port the app listens on; probe ports must match.
- Use `httpGet` when possible; `exec` when not (e.g. database client checks).
- For exam-time speed, `kubectl explain pod.spec.containers.livenessProbe` shows the schema.

## Mental traps

- Confusing what each probe does. Liveness kills, readiness gates traffic, startup gates the others.
- Putting the same `/health` endpoint on liveness AND readiness AND startup. Sometimes correct, sometimes not — readiness might want to check more (dependencies), liveness less.
- Forgetting that probes hit `0.0.0.0:<port>` from kubelet's perspective. Apps binding only to `127.0.0.1` fail probes.
- Setting probe timing without measuring actual app startup. Watch the pod come up and time it before configuring.
- Adding probes to init containers (regular ones don't support them). Use lifecycle of the container itself.
- Heavy exec probes that themselves contribute to load. Cheaper httpGet probes are usually preferable.
- Letting liveness probe failures cascade into a restart loop you can't break. Always prefer too-lax over too-strict for liveness; bad pods at least keep running while you debug.
