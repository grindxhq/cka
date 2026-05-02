## What CrashLoopBackOff actually is

`CrashLoopBackOff` is **not a state**. It's a **reason**: kubelet sets it when a container has died and is being held in waiting until the next restart attempt. The pod's `Status` shows it because `state.waiting.reason` of the container is `CrashLoopBackOff`.

The literal sequence:

```
 Container starts → exits → kubelet sees the exit → schedules a restart with backoff
                                                  → state.waiting.reason = "CrashLoopBackOff"
                                                  → restart fires
                                                  → if the new container also dies fast, backoff doubles
                                                  → repeat until it stays up for 10 minutes (then backoff resets)
```

Backoff schedule (default):

- 1st restart: immediate.
- 2nd: ~10 seconds.
- 3rd: ~20 seconds.
- 4th: ~40 seconds.
- ...doubles each time, capped at 5 minutes between attempts.

If the container manages to run for more than 10 minutes, the backoff timer resets to immediate.

So CrashLoopBackOff = "I'm waiting before the next restart of a container that keeps dying." The fix is to figure out **why** the container keeps dying.

---

## Decision tree

```
Pod's container in CrashLoopBackOff
│
├── kubectl describe pod → check Last State of the container
│      ├── Reason: OOMKilled       → memory limit exceeded
│      ├── Reason: Error (exit non-zero) → app exited with error code
│      ├── Reason: Completed (exit 0)    → app exited successfully but restartPolicy=Always
│      ├── Reason: ContainerCannotRun    → kernel-level failure (binary missing, exec format)
│      └── Reason: <something else>      → look at message field
│
├── kubectl logs <pod> -c <container> --previous → see the dying app's last words
│      ├── Application error / panic       → app bug; fix code
│      ├── Config-related error             → bad env var, missing config file
│      ├── DB / dependency unreachable     → fix dependency or readiness probe
│      └── (empty)                          → check container exit code; might be no logs
│
├── Liveness probe killing it?
│      → kubectl describe pod → events for "Liveness probe failed"
│
└── If pod was running fine and suddenly crashing
       → Look for recent ConfigMap/Secret update (cron pattern of failures?)
       → Look at recent image change (kubectl describe pod | grep image)
```

---

## Reading container exit codes

The exit code tells you why a process ended:

| Exit code | Meaning                                                               |
|-----------|-----------------------------------------------------------------------|
| 0         | Normal exit. With restartPolicy: Always, kubelet restarts anyway.    |
| 1         | General error (most apps default to this on failure)                  |
| 2         | Misuse of shell builtin / command syntax error                        |
| 125       | Container runtime error                                               |
| 126       | Container command found but not executable                            |
| 127       | Container command not found                                           |
| **128 + N** | Process terminated by signal N (e.g. 137 = 128 + 9 = SIGKILL)        |
| **137**   | OOMKilled (kernel SIGKILL on memory limit)                            |
| **143**   | SIGTERM (graceful termination)                                        |
| 139       | SIGSEGV (segfault)                                                    |
| 124       | Timeout (used by some tools when run with `timeout`)                  |

The most common ones in Kubernetes:

- **137** — OOMKilled. Container exceeded `resources.limits.memory`. Fix: raise limit, or reduce app's memory usage.
- **143** — SIGTERM. Normal pod deletion or restart. Not a problem unless it's part of a churn pattern.
- **1** — App-defined error. Read the logs.
- **0** — App exited cleanly but kubelet restarts (`restartPolicy: Always`). The app shouldn't be exiting; something is making it terminate.

---

## Step-by-step investigation

### 1. Identify the container

```bash
kubectl get pods <pod>
# Look at READY column. 0/1 means container not running. RESTARTS > 0 = restarting.

kubectl describe pod <pod> | grep -A 5 'State:\|Last State:\|Reason:\|Exit Code:'
```

The `Last State` shows the most recent exit details:

```
Last State:     Terminated
  Reason:       OOMKilled
  Exit Code:    137
  Started:      Mon, 23 Apr 2026 10:45:00 +0000
  Finished:     Mon, 23 Apr 2026 10:45:30 +0000
```

That's the smoking gun: the previous instance was OOMKilled, ran for 30 seconds.

### 2. Read the previous instance's logs

```bash
kubectl logs <pod> -c <container> --previous
# OR (current logs if it's between restarts)
kubectl logs <pod> -c <container>
```

The logs from the failed instance often contain the actual error. App-level errors (config issues, database unreachable, panic) show up here.

If `--previous` returns nothing useful, the app may have died too fast to log anything. Check exit code instead.

### 3. Check kubelet events

```bash
kubectl describe pod <pod> | sed -n '/Events:/,$p'
```

Common events around CrashLoop:

- `Started` — container started.
- `Killing: Container failed liveness probe, will be restarted` — probe-driven kill.
- `BackOff: Back-off restarting failed container` — kubelet's backoff log.
- `Pulled / Pulling` — image pull events (relevant if it's an image issue, not crash).

### 4. Pattern-match the cause

| Pattern in logs / events                                  | Likely cause                                |
|-----------------------------------------------------------|---------------------------------------------|
| `OOMKilled` (exit 137)                                    | Memory limit too low                        |
| `Error: connect ECONNREFUSED 127.0.0.1:5432`              | App can't reach DB                          |
| `Error: getaddrinfo ENOTFOUND db`                         | DNS failure                                 |
| `panic: runtime error: invalid memory address`            | Application code bug                        |
| `Error: ENOENT, no such file or directory '/etc/config'`  | ConfigMap not mounted / wrong path          |
| `exec: "/app/run": stat /app/run: no such file or directory` | Wrong command path; image didn't include the binary |
| `standard_init_linux.go:228: exec user process caused: exec format error` | Wrong CPU architecture (built for amd64, running on arm64) |
| `Liveness probe failed` events                            | Liveness too aggressive or app endpoint broken |
| App immediate exit, no logs                               | Bad command/args, missing env var, image entrypoint changed |

---

## OOMKilled — the memory case

Symptoms:

```
Last State:     Terminated
  Reason:       OOMKilled
  Exit Code:    137
```

Container's memory usage exceeded `resources.limits.memory`. Kernel OOM killer sent SIGKILL.

Diagnosis:

```bash
# Current memory usage (if metrics-server installed)
kubectl top pod <pod>

# Container's limit
kubectl get pod <pod> -o jsonpath='{.spec.containers[0].resources.limits.memory}'
```

Fixes:

- **Raise the memory limit** if the app's actual need is higher than the limit.
- **Profile the app** for memory leaks. Take heap dumps; compare working sets.
- **Set container-aware heap flags** for Java (`-XX:+UseContainerSupport`, `-XX:MaxRAMPercentage=75`), Go (`GOMEMLIMIT`), Node.js (`--max-old-space-size`). Without these, the runtime sees the host's RAM and doesn't honor the cgroup.

Subtle: an OOMKilled pod doesn't always reach the limit cleanly. Memory mapped files, page cache, kernel slab — these all count. The `working_set` in cgroups (what the kernel uses for OOM decisions) excludes inactive cache, but it's still subtler than "process RSS."

---

## Probe-driven kills

Symptoms:

```
Events:
  Warning  Unhealthy  35s (x6)  kubelet  Liveness probe failed: HTTP probe failed with statuscode: 503
  Normal   Killing    35s       kubelet  Container app failed liveness probe, will be restarted
```

Liveness probe failed `failureThreshold` times in a row. Kubelet sent the container SIGTERM, then SIGKILL after grace period. Restart per restartPolicy.

Diagnosis:

- Check probe definition: is it too aggressive? Too tight a timeout?
- Check probe target: does the app actually serve `/healthz` on the configured port?
- Check current app behavior: does `kubectl exec curl localhost:<port>/<path>` work?

Fixes (covered in the probes subtopic):

- Loosen `failureThreshold`, `periodSeconds`, `initialDelaySeconds`.
- Add a startup probe to give slow-starting apps room.
- Move dependency checks out of liveness (use readiness instead).
- Fix the probe handler to match the app's actual endpoints.

---

## Config-related crashes

A surprising number of CrashLoops trace to:

- ConfigMap key changed but pod restart didn't pick up new value (envFrom is read once at start).
- Required env var unset.
- Config file mounted from ConfigMap has wrong content.
- Secret rotated; old credentials don't work.

Diagnosis:

```bash
# What env vars does the container have?
kubectl exec <pod> -c <container> -- env | sort

# What's mounted at the config path?
kubectl exec <pod> -c <container> -- ls /etc/config

# Read a specific config file
kubectl exec <pod> -c <container> -- cat /etc/config/app.yaml
```

If the config looks wrong, fix the ConfigMap/Secret and redeploy. Note: ConfigMap/Secret updates **do** propagate into mounted volumes (eventual, ~tens of seconds), but env vars are static — pod must restart to pick up new env values.

---

## "App exits cleanly but restarts" (exit 0)

```
Last State:     Terminated
  Reason:       Completed
  Exit Code:    0
```

App ran, exited 0. With `restartPolicy: Always` (default for Deployment-managed pods), kubelet restarts even successful exits.

Causes:

- App is one-shot (e.g. a script that runs and exits) but pod is set up as a long-running service. Use a Job, not a Deployment.
- App's main process is missing — entrypoint is a script that backgrounds the real work and returns. The container "succeeds" instantly because PID 1 exited.

Fix: make sure the container's PID 1 is the long-running process. For shell wrappers, use `exec` to replace the shell with the actual binary:

```bash
#!/bin/sh
# WRONG
/app/run

# RIGHT
exec /app/run
```

---

## "Container creates but immediately dies" (no logs)

Pod transitions Pending → Running → Error → CrashLoopBackOff in seconds. `kubectl logs --previous` shows nothing.

Possible causes:

- **Bad command path**: `command: [ "/app/run" ]` but the binary is at `/usr/local/bin/run`. Container exits 127.
- **Wrong architecture**: image built for amd64, node is arm64. Exit code: typically 1 with "exec format error" in events.
- **Missing dependency**: dynamically linked binary, missing shared library. Exit 127.
- **Permissions**: securityContext requires non-root, image runs as root, no fallback.

Diagnose by overriding the entrypoint with a sleep:

```bash
kubectl debug -it <pod> --image=<same-image> --target=<container> -- sh
# OR run a fresh pod with the image and a shell
kubectl run debug --rm -it --image=<image> --restart=Never -- sh
# Inspect what's there
ls /app/
file /app/run
ldd /app/run
```

This gets you into a similar environment to debug.

---

## "Pod was fine, then started crashing" — what changed?

If a stable pod suddenly enters CrashLoop, something changed:

```bash
# Recent events on the pod and its parent
kubectl get events --field-selector involvedObject.name=<pod>
kubectl describe deployment <deploy> | grep -A 10 Events

# Recent updates to the deployment
kubectl rollout history deployment <deploy>

# Any recent ConfigMap/Secret changes referenced by the pod?
kubectl get cm,secret -A --sort-by=.metadata.creationTimestamp | tail
```

Common "what changed" culprits:

- Deployment image rolled to a buggy version. Roll back: `kubectl rollout undo deployment <name>`.
- ConfigMap updated with a typo. Fix and reapply.
- Secret rotated; new value broke the app. Verify the new value works manually.
- Cluster upgraded; some API behavior changed.
- New NetworkPolicy blocks the app's outbound DNS.

---

## Speeding up debugging

### Throw a sleep into the entrypoint

If the app crashes too fast to investigate, override the command to sleep:

```yaml
command: [ "sleep", "infinity" ]
```

Pod stays Running forever. `kubectl exec` in, look around, run the real command interactively to see what fails.

### Use `kubectl debug`

```bash
kubectl debug -it <pod> --image=nicolaka/netshoot --target=<container>
```

Adds an ephemeral container sharing namespaces with the target. You can poke at the pod's state without modifying it.

### Increase log verbosity

If the app's logs are sparse, set higher verbosity via env var (`LOG_LEVEL=debug`, `RUST_LOG=trace`, etc.) and redeploy.

---

## When CrashLoopBackOff is **not** the actual problem

Sometimes the pod's events show CrashLoopBackOff but the real problem is elsewhere:

- **Init container failed** → pod stays Pending; main container never starts. Look at init container statuses.
- **Image pull failure** → pod stuck at ImagePullBackOff (different reason). Container hasn't started yet.
- **Sandbox creation failed** → CNI / runtime issue. Look at runtime logs.
- **Volume mount failed** → CSI issue. Pod stuck at ContainerCreating.

`kubectl describe pod` distinguishes these — read the Events section, not just the high-level status.

---

## Common CrashLoop patterns and their fixes

| Pattern                                              | Fix                                                  |
|------------------------------------------------------|------------------------------------------------------|
| Exit 137, every restart                              | OOMKilled — raise memory limit or fix leak           |
| Exit 1 with "config not found"                       | Fix ConfigMap mount path                             |
| Exit 1 with "DB connection refused"                  | Wait for DB; use init container or readiness probe   |
| Exit 0 with "Completed"                              | Process is one-shot; use Job not Deployment, or `exec` in entrypoint |
| Liveness probe failures                              | Loosen probe thresholds; verify probe path/port       |
| "exec format error"                                  | Wrong arch image — pull/build for the right arch     |
| "no such file or directory" on entrypoint            | Wrong `command` path; check image's actual binary    |
| Crashes only on certain nodes                        | Node-specific issue (taint, hardware, kernel)        |
| All replicas crash simultaneously after Deployment update | Bad image or config — `kubectl rollout undo`     |

---

## Useful commands cheatsheet

```bash
# Status overview
kubectl get pods <pod>
kubectl describe pod <pod>

# Why is the container in this state?
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].state}'
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].lastState}'

# Logs
kubectl logs <pod> -c <container>
kubectl logs <pod> -c <container> --previous

# Restart count
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].restartCount}'

# Memory usage at last sample
kubectl top pod <pod> --containers

# Events specific to this pod
kubectl get events --field-selector involvedObject.name=<pod> --sort-by=.lastTimestamp

# Get into a similar environment to debug
kubectl run debug --rm -it --image=<image> --restart=Never -- sh

# Inspect from outside
kubectl exec -it <pod> -c <container> -- /bin/sh
```

---

## Exam heuristics

- For a CrashLoop, `describe pod` first → look at Last State Reason and Exit Code → that's your starting point.
- `kubectl logs <pod> --previous` is essential — current container may not have logs yet.
- Exit code 137 = OOMKilled. Exit code 143 = SIGTERM. Memorize.
- Override `command` to `["sleep", "infinity"]` to pause a crashing pod for inspection.
- For exam scenarios "fix this CrashLoop," common causes are bad ConfigMap reference, missing env var, wrong image tag, too-tight liveness probe.

## Mental traps

- Treating CrashLoopBackOff as if it's a state. It's the *waiting* between restarts; the *cause* is in the previous container's exit.
- Looking at current logs only (the new instance) when the previous instance had the actual error — use `--previous`.
- Misreading "Reason: Completed" as good. With restartPolicy: Always, exiting 0 still triggers restart.
- Blaming Kubernetes for app-level crashes. Most CrashLoops are app bugs; Kubernetes is just being honest about restart attempts.
- Force-deleting CrashLoopBackOff pods. The Deployment recreates them with the same problem. Fix the underlying issue.
- Setting `restartPolicy: Never` to stop the loop. The pod becomes Failed and stops, but you've masked the issue. Real fix: make it run.
- Ignoring high `restartCount`. A pod with 100+ restarts is "running" only by accident; one of those 100 was probably interesting.
