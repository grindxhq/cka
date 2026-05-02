## Two strategies, one Deployment

```yaml
spec:
  strategy:
    type: RollingUpdate           # default
    # OR
    type: Recreate
```

- **RollingUpdate** — replace pods incrementally. Old and new versions coexist briefly. Zero downtime if app is upgrade-safe.
- **Recreate** — kill all old pods, then create all new pods. Brief total downtime. Used when old + new can't coexist (e.g. exclusive lock on a PVC).

For 99% of stateless web services: RollingUpdate. For stateful workloads with single-writer constraints: Recreate (or, more often, a StatefulSet).

---

## RollingUpdate — the math

```yaml
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%             # how many MORE pods than `replicas` may exist mid-rollout
      maxUnavailable: 25%       # how many FEWER ready pods than `replicas` may exist
```

Both can be percentages or absolute numbers (`maxSurge: 1` or `maxSurge: 25%`).

Defaults: 25% / 25%. For a 4-replica Deployment: maxSurge=1, maxUnavailable=1 (rounded up / down respectively).

### What kubelet/controller actually does

For a 4-replica Deployment going from v1 to v2 with 25%/25%:

- Maximum size during rollout = `replicas + maxSurge` = 4 + 1 = 5.
- Minimum available pods = `replicas - maxUnavailable` = 4 - 1 = 3.

Sequence (one possible order):

```
 t=0   v1: 4    v2: 0    total: 4    available: 4
 t=1   v1: 4    v2: 1    total: 5    surge up by 1
       wait for new v2 pod to become Ready...
 t=2   v1: 4    v2: 1    total: 5    available: 5 (new pod ready)
 t=3   v1: 3    v2: 1    total: 4    scale old down by 1 (now within unavailable budget)
 t=4   v1: 3    v2: 2    total: 5    surge again
       wait for ready...
 t=5   v1: 3    v2: 2    total: 5    available: 5
 t=6   v1: 2    v2: 2    total: 4    scale old down
 ...continues until v1: 0, v2: 4...
 t=N   v1: 0    v2: 4    rollout complete
```

The controller stays within both bounds. New pods come up, old pods go down, in interleaved waves.

### Min/max bounds explained

- **`maxUnavailable: 0`** means no fewer than `replicas` pods may be unavailable. The new pod must be Ready before the old one terminates. Strictly zero-downtime, but slower (must surge to replace; can't take any pod down first).
- **`maxSurge: 0`** means no more than `replicas` pods may exist. Must terminate old before starting new. Means downtime per pod during the gap. Useful when capacity is constrained.
- **Both 0** is invalid (can't progress).

Common patterns:

```yaml
# Conservative zero-downtime
maxSurge: 1
maxUnavailable: 0

# Fast (default)
maxSurge: 25%
maxUnavailable: 25%

# Maximum throughput (replace all simultaneously, brief outage)
maxSurge: 100%
maxUnavailable: 100%
```

### `minReadySeconds` — a settling delay

```yaml
spec:
  minReadySeconds: 30
```

A new pod is "available" only after it's been Ready for `minReadySeconds`. This gives a grace window to catch flaky pods that pass readiness once but fail seconds later.

Useful for:

- Apps that finish initialization shortly after readiness.
- Catching crash-after-ready pods early before all replicas are replaced with broken ones.

Adds total rollout time = (pods replaced) * (max(setup_time, minReadySeconds)).

---

## Recreate — the simple case

```yaml
spec:
  strategy:
    type: Recreate
```

Sequence:

```
 t=0   v1: 4    v2: 0
 t=1   v1: 0    v2: 0    (all v1 terminated)
 t=2   v1: 0    v2: 4    (all v2 created, starting up)
       wait for v2 pods to become Ready...
 t=N   v1: 0    v2: 4    (all v2 ready, rollout complete)
```

Downtime from t=1 to t=N. Used when old and new versions cannot run together — typically:

- A pod claims an RWO PVC; new pod can't attach until old one releases.
- Single-writer process where two concurrent versions would corrupt state.
- Database migration where old code can't read new schema (or vice versa).

For most stateless web services, Recreate is overly disruptive. Use RollingUpdate.

---

## progressDeadlineSeconds — the watchdog

```yaml
spec:
  progressDeadlineSeconds: 600       # 10 minutes default
```

If the Deployment hasn't made progress (new ready pods) for `progressDeadlineSeconds`, the controller flags it:

```yaml
status:
  conditions:
  - type: Progressing
    status: "False"
    reason: ProgressDeadlineExceeded
    message: ReplicaSet "web-7c9f4d8a3b" has timed out progressing
```

Doesn't stop the rollout — just signals failure. The controller keeps trying. CI/CD systems should watch for this condition and decide to roll back or alert.

Default 600s is reasonable. Lower for fast-feedback environments; higher for slow-starting workloads.

---

## Watching a rollout

```bash
kubectl rollout status deploy/web

# Output (success):
# Waiting for deployment "web" rollout to finish: 1 of 4 updated replicas are available...
# Waiting for deployment "web" rollout to finish: 2 of 4 updated replicas are available...
# Waiting for deployment "web" rollout to finish: 3 of 4 updated replicas are available...
# deployment "web" successfully rolled out

# Failure (after progressDeadlineSeconds):
# error: deployment "web" exceeded its progress deadline
```

Returns 0 on success, non-zero on failure. CI scripts use this to gate deploys.

`kubectl rollout status` blocks until done. Add `--timeout=5m` to bound the wait.

---

## Pause and resume

```bash
kubectl rollout pause deploy/web
```

The Deployment controller stops scaling for this Deployment. Useful for:

- Multi-step changes you want applied atomically. Pause; edit several fields; resume — only one rollout fires at the end, not one per edit.
- Emergency: pausing a stuck rollout to prevent further damage.

```bash
# After your edits:
kubectl rollout resume deploy/web
```

While paused, status shows:

```yaml
status:
  conditions:
  - type: Progressing
    reason: DeploymentPaused
```

Pausing while pods are mid-rollout freezes the current state — some pods may be on v1, some on v2. Be aware.

---

## Forcing a rollout without changing the spec

```bash
kubectl rollout restart deploy/web
```

This adds an annotation `kubectl.kubernetes.io/restartedAt: <timestamp>` to the pod template:

```yaml
spec:
  template:
    metadata:
      annotations:
        kubectl.kubernetes.io/restartedAt: "2026-04-23T10:00:00Z"
```

The annotation is part of the template, so it changes the template hash → new RS → rolling update. All pods get replaced, picking up changes from ConfigMaps/Secrets that were updated since last rollout.

Use this to:

- Pick up a Secret/ConfigMap update without changing the Deployment otherwise.
- Recycle pods after a node-level fix.
- Replace pods with stale state.

---

## Deployment status conditions

```yaml
status:
  conditions:
  - type: Progressing
    status: "True"
    reason: NewReplicaSetAvailable
  - type: Available
    status: "True"
    reason: MinimumReplicasAvailable
```

Three conditions you'll see:

| Condition       | Meaning                                                              |
|-----------------|----------------------------------------------------------------------|
| `Progressing`   | Rollout is happening / completed successfully / stalled              |
| `Available`     | Has at least `minimumReplicas = replicas - maxUnavailable` ready pods|
| `ReplicaFailure` | At least one ReplicaSet creation failed (quota, admission, etc.)    |

`Progressing=False, reason=ProgressDeadlineExceeded` is the "rollout failed" signal CI tools watch for.

---

## Common rollout failure modes

### New pods don't become Ready

`maxUnavailable` is the floor — controller can't terminate old pods past that bound. New pods must become Ready before old ones can leave. If new pods never become Ready (broken image, failing probe), rollout stalls indefinitely.

Symptoms:

```bash
kubectl rollout status deploy/web
# Waiting for deployment "web" rollout to finish: 0 of 4 updated replicas are available...
# (hangs)

kubectl get pods -l app=web
# web-old-aa  1/1  Running
# web-old-bb  1/1  Running
# web-old-cc  1/1  Running
# web-old-dd  1/1  Running
# web-new-ee  0/1  CrashLoopBackOff   ← new pod failing
```

Fix: investigate why the new pod won't start (logs, events). Then either fix and re-rollout, or roll back.

### Image not pullable

```
Failed to pull image "myapp:typo": ... manifest unknown
```

New pod is `ImagePullBackOff`, never starts. Rollout hangs.

Fix: roll back, fix the image tag, re-roll out.

### Quota exceeded

```yaml
conditions:
- type: ReplicaFailure
  status: "True"
  reason: FailedCreate
  message: pods "web-7c9f4d8a3b-xxx" is forbidden: exceeded quota: ...
```

Cluster admission rejected pod creation. Rollout stalls.

Fix: increase quota or reduce request size.

### maxSurge=0 deadlocks with PVC

If your strategy is `maxSurge: 0` and pod uses an RWO PVC, the new pod can't start because the PVC is still attached to the old pod, and the old pod can't terminate because the new one isn't ready.

Fix: switch to `Recreate` strategy (or use `maxSurge: 1` so the controller can over-create briefly).

### Probe too aggressive

New pods start, become Ready briefly, then liveness probe kills them. Restart loop. Rollout never advances.

Fix: tune probes (see probes deck).

---

## Strategy choice cheatsheet

| Workload | Strategy | maxSurge | maxUnavailable | Notes |
|----------|----------|---------:|---------------:|-------|
| Stateless web | RollingUpdate | 25% | 25% | Default, fine for most |
| Latency-critical | RollingUpdate | 25% | 0 | Strict zero-downtime |
| Cost-constrained (no over-provisioning) | RollingUpdate | 0 | 25% | Slower, no surge resources |
| Single-writer / RWO PVC | Recreate | (n/a) | (n/a) | Brief downtime per rollout |
| Canary by hand | Two Deployments | manual | manual | Use service mesh / Argo Rollouts for richer canaries |
| StatefulSet | (different controller) | n/a | n/a | StatefulSet has its own update strategy |

---

## Pod readiness gates

Beyond probes, pods can have **readiness gates**:

```yaml
spec:
  readinessGates:
  - conditionType: "example.com/feature-1"
```

A custom condition that some external controller updates. Pod is Ready only when its readiness probe AND every readiness gate passes.

Use case: tying pod readiness to external signals (LB health check, mesh sidecar warmup). For Deployments, this means rollout waits not just on the pod's own probe but also on the external condition.

Rare in CKA scope, but worth recognizing.

---

## Service mesh / advanced rollout tools

Native Deployment rolling updates are simple but limited:

- No header-based traffic splitting.
- No automated rollback on metric thresholds.
- No analysis runs between phases.

For richer rollouts:

- **Argo Rollouts** — replaces Deployment with Rollout CRD. Canary, blue/green, traffic shaping via Istio/NGINX/etc.
- **Flagger** — automated canary analysis using Prometheus metrics.
- **Service mesh** (Istio, Linkerd) — traffic split between two Deployment versions via VirtualService weights.

Out of CKA scope but worth knowing they exist for production-grade rollouts.

---

## Useful commands

```bash
# Rolling update via image change
kubectl set image deploy/web web=nginx:1.26

# Edit the full Deployment
kubectl edit deploy/web

# Apply updated YAML
kubectl apply -f web.yaml

# Watch the rollout
kubectl rollout status deploy/web

# Force a fresh rollout (pods restart)
kubectl rollout restart deploy/web

# Pause / resume
kubectl rollout pause deploy/web
kubectl rollout resume deploy/web

# Scale (no rollout)
kubectl scale deploy/web --replicas=5

# History
kubectl rollout history deploy/web
kubectl rollout history deploy/web --revision=3

# Rollback (next subtopic)
kubectl rollout undo deploy/web
```

---

## Exam heuristics

- For "perform a rolling update," use `kubectl set image deploy/<name> <container>=<new-image>`.
- For "force restart of pods" without changing image, use `kubectl rollout restart`.
- `kubectl rollout status` blocks until done — useful to verify completion in scripts.
- Default strategy is RollingUpdate with 25%/25%. Memorize the default.
- For "watch the rollout," `kubectl get pods -l app=<x> -w`.

## Mental traps

- Setting `maxSurge: 0` on RWO-PVC workloads. Deadlock.
- Setting `maxUnavailable: 0` and being surprised by slow rollouts. The strict zero-downtime guarantee costs throughput.
- Confusing `kubectl rollout restart` with `kubectl delete pod`. Restart goes through the rollout machinery (controlled, ordered); delete is brutal (RS recreates immediately, no rolling control).
- Treating `progressDeadlineSeconds` as a kill timer. It's a signal; the rollout keeps trying.
- Editing the ReplicaSet directly mid-rollout. The Deployment controller will overwrite. Edit the Deployment.
- Counting on `minReadySeconds` to catch slow regressions. It catches "ready then crash within N seconds"; it doesn't catch "becomes broken 5 minutes later."
- Pausing a Deployment for hours and forgetting. Stale paused state can confuse later operators.
