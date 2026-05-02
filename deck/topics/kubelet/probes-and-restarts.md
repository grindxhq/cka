## The three probes

| Probe       | What kubelet does with a failure                      | What it is for                           |
|-------------|-------------------------------------------------------|------------------------------------------|
| startupProbe| Delay other probes; if the probe never succeeds, kill the container | Protect slow-starting apps from liveness killing them early |
| readinessProbe | Remove the pod from Service endpoints              | Gate traffic until the app is truly ready |
| livenessProbe | Kill the container (kubelet restarts per restartPolicy) | Recover from stuck / deadlocked processes |

Key invariant: readiness and liveness do **different** things on failure. Readiness affects whether the pod receives traffic. Liveness affects whether the container keeps running.

## Probe handlers

Each probe uses one of:

```yaml
httpGet:
  path: /healthz
  port: 8080

tcpSocket:
  port: 5432

exec:
  command: ["/bin/sh", "-c", "pg_isready"]

grpc:                  # K8s 1.24+
  port: 9000
  service: grpc.health.v1.Health
```

HTTP: 2xx or 3xx is success. TCP: connection established is success. exec: exit code 0 is success. grpc: the service's health RPC returns `SERVING`.

## Probe tuning fields

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 8080 }
  initialDelaySeconds: 10
  periodSeconds: 10
  timeoutSeconds: 2
  successThreshold: 1       # must be 1 for liveness / startup
  failureThreshold: 3       # kill after 3 consecutive failures
```

Defaults:

- `initialDelaySeconds: 0` — probe starts immediately.
- `periodSeconds: 10` — every 10 s.
- `timeoutSeconds: 1` — each probe must respond within 1 s.
- `failureThreshold: 3` — three consecutive failures = failure.
- `successThreshold: 1` — one success restores Ready (for readiness); must be 1 for liveness/startup.

## startupProbe vs initialDelaySeconds

If an app takes 2 minutes to start and periodSeconds is 10, you could set `initialDelaySeconds: 120`. That works but is rigid — if startup finishes faster, you still wait.

startupProbe replaces that with a variable window: liveness/readiness are *disabled* until startup succeeds or hits `failureThreshold * periodSeconds`. More robust.

```yaml
startupProbe:
  httpGet: { path: /healthz, port: 8080 }
  failureThreshold: 30
  periodSeconds: 10
# gives the app up to 5 minutes to come up,
# after which liveness takes over with its own schedule
```

## restartPolicy

Pod-level setting, applied by kubelet:

- `Always` (default) — restart any container that exits, regardless of exit code. Required for Deployments / ReplicaSets / DaemonSets / StatefulSets.
- `OnFailure` — restart only on non-zero exit. Used by Jobs.
- `Never` — do not restart; pod ends when containers end. Used for one-shot tasks.

Liveness failures, OOM kills, and runtime errors all go through `restartPolicy`. `Never` pods don't come back from liveness failures — they just die.

## CrashLoopBackOff

Not a real status — it's a **restart reason**. When kubelet restarts a container that keeps dying, it backs off exponentially:

- 10 s, then 20 s, 40 s, 80 s, ... capped at 300 s (5 min).
- The container status is `Waiting` with reason `CrashLoopBackOff`.

The timer resets if the container runs successfully for >10 minutes.

Diagnosing CrashLoopBackOff:

```bash
kubectl describe pod <name>                    # shows LastState termination reason + exit code
kubectl logs <name> --previous                 # previous container's logs — usually the error
kubectl get events --sort-by=.lastTimestamp -n <ns>
```

Common causes:

- Application config error (missing env var, bad DB URL).
- Liveness probe failing while app is still starting (fix: tune initialDelay or add startupProbe).
- OOMKilled (memory limit too low, or a memory leak).
- Missing file / mounted secret not yet ready.
- Entry command failing fast (bad image, typo in `command`).

## Termination: the grace period

When a pod is deleted or its owner updates it, kubelet:

1. Marks the pod `Terminating` (deletion timestamp set).
2. Sends **SIGTERM** to the PID 1 of each container.
3. Waits `terminationGracePeriodSeconds` (default 30).
4. Sends **SIGKILL** to any container still running.

If a container has a `preStop` hook, kubelet runs it *before* SIGTERM (inline with the grace period budget). This is useful for draining connections, deregistering from a load balancer, etc.

Shortening grace period (`--grace-period=0 --force` on `kubectl delete`) skips this entirely. Useful for stuck pods, but avoid in normal flow.

## Readiness gate for rollouts

Because readiness probes drive Endpoints inclusion, a misconfigured readiness probe can:

- Make a pod never join the Service (endpoints stays empty).
- Stall a Deployment rollout (new pods never Ready → maxUnavailable hits).

Watch for this when a rollout "hangs":

```bash
kubectl get pods -l <app> -o wide          # are they Ready?
kubectl describe pod <one> | grep -A 5 Readiness
```

## Probe gotchas

- **HTTP probes use the pod's own IP**, not a Service. No DNS, no load balancer. Bind the health endpoint to `0.0.0.0`, not a specific interface.
- **HTTP probes don't send a `Host` header by default** — some apps care. Use `httpHeaders:` to set one.
- **exec probes run inside the container** — the command must exist in the container image. `curl` is often absent in minimal images.
- **tcpSocket probes only check TCP handshake** — the process could be accepting connections but broken. HTTP or exec is more honest.
- **Probes have CPU cost** — at scale, frequent probes eat resources. Don't set `periodSeconds: 1` in production.
- **readinessProbe on `Job`-style pods** doesn't make sense. Jobs exit when done; readiness is for long-running services.

## Debugging patterns

### Pod is Running but not Ready

```bash
kubectl describe pod <n> | grep -A 5 Readiness
kubectl logs <n>
```

Usually: readiness probe failing (wrong path/port), or the app really is not ready.

### Pod gets killed mysteriously every minute

Probably liveness failing. Check:

```bash
kubectl describe pod <n> | grep -A 5 Liveness
kubectl get events --field-selector involvedObject.name=<pod>
```

Often: `initialDelaySeconds` too low for the app's startup.

### Container repeatedly OOMKilled

```bash
kubectl describe pod <n>
# Look for:
# Last State:    Terminated
# Reason:        OOMKilled
# Exit Code:     137
```

Fix: raise memory limit, reduce memory usage, or switch to a Guaranteed QoS class so it's evicted last rather than killed.

## Fast commands

```bash
# Probe definitions on a pod
kubectl get pod <n> -o jsonpath='
{range .spec.containers[*]}
  container: {.name}
  liveness:  {.livenessProbe}
  readiness: {.readinessProbe}
  startup:   {.startupProbe}
{end}'

# Restart counts (helpful CrashLoop indicator)
kubectl get pods -o wide

# Previous container logs
kubectl logs <n> --previous
kubectl logs <n> -c <container> --previous
```

## Exam heuristics

- "Configure a liveness probe that restarts the container if /healthz returns non-2xx" → `httpGet` with `path: /healthz`, `port: <n>`, reasonable thresholds.
- "Readiness probe that gates traffic" → the same, just under `readinessProbe`.
- "App takes long to start" → add a `startupProbe` with a generous `failureThreshold`.
- "Container is CrashLoopBackOff, investigate" → `kubectl logs --previous` and `kubectl describe pod`.

## Mental traps

- Using liveness when readiness is what you want. Liveness kills; readiness just hides.
- Setting liveness thresholds so tight that slow startups cause a kill loop.
- Assuming exit code 0 means healthy. A crash on startup can exit 0 if misconfigured; check logs.
- Forgetting that readinessProbe removes the pod from endpoints but **does not stop traffic already established**. Existing TCP connections continue.
- Confusing `restartCount` with "crashes." Any exit that triggers a restart counts, including graceful exits of `restartPolicy: Always` pods.
