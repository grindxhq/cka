## The workload chain

Every workload type delegates to a smaller controller underneath. Understanding the chain makes debugging a pod-level symptom much faster because you know where to climb.

```
Deployment ─► ReplicaSet ─► Pod
StatefulSet ─► Pod
DaemonSet ─► Pod
Job ─► Pod
CronJob ─► Job ─► Pod
```

Each arrow is a separate controller inside `kube-controller-manager`. The `Deployment` controller owns the ReplicaSet; the `ReplicaSet` controller owns the Pods. The upper layer never touches Pods directly.

## Deployment → ReplicaSet

A Deployment is a rollout policy plus a pod template plus a replica count. The Deployment controller:

- Creates a ReplicaSet per pod template revision.
- Scales the new and old ReplicaSets up/down according to the rollout strategy.
- Tracks revision history in the Deployment's `.status`.
- Exposes "paused" state for manual control.

The ReplicaSet controller takes the simple job: "maintain N pods matching my selector." It creates pods and adopts any existing pods whose labels match (and whose `ownerRefs` point to it).

Both controllers share etcd-backed state with no direct RPCs between them. They just observe each other's output.

## Rollout mechanics (RollingUpdate, default)

Two knobs:

- `maxUnavailable` (default 25%) — how far below desired the ready count may fall during rollout.
- `maxSurge` (default 25%) — how far above desired the total pod count may rise.

Sequence for a 10-replica Deployment rolling to a new template:

1. Scale new RS to `1` (surge), keep old RS at `10`. Total `11`.
2. Wait for the new pod to become Ready.
3. Scale old RS to `9` (unavailable=1). Total `10`.
4. Repeat until old RS is at 0 and new RS is at 10.

A rollout can **stall** if new pods never become Ready — `maxUnavailable` is the absolute cap on old pods going away.

## Recreate strategy

`strategy: Recreate` kills all old pods before creating new ones. Useful for workloads that cannot run side-by-side with themselves (e.g. PVC RWO with no volume detach overlap). Expects downtime.

## Rollout commands

```bash
# Pause / resume
kubectl rollout pause deploy/<name>
kubectl rollout resume deploy/<name>

# Status (blocks until done or fails)
kubectl rollout status deploy/<name>

# History, diff, rollback
kubectl rollout history deploy/<name>
kubectl rollout history deploy/<name> --revision=3
kubectl rollout undo deploy/<name>
kubectl rollout undo deploy/<name> --to-revision=2

# Force a rollout without changing the template
kubectl rollout restart deploy/<name>
```

`rollout restart` adds a pod template annotation with a timestamp, which creates a new ReplicaSet and triggers a normal rollout. It is safer than deleting pods by hand because it respects `maxUnavailable`.

## ReplicaSet pitfalls

The ReplicaSet selector is **immutable**. If you edit a ReplicaSet's `.spec.selector`, you get an error. That is why you can't "retarget" a ReplicaSet at different pods — you replace it.

If you mutate a Deployment's `.spec.selector` (the one that maps to the ReplicaSet), the Deployment controller creates a new ReplicaSet and the old pods may be orphaned. In CKA, "the Deployment is not healing my pods" sometimes traces back to a selector mismatch between the Deployment and its ReplicaSets.

## StatefulSet specifics

StatefulSets exist to give pods **stable identity** (pod name, hostname, PVCs).

- Pods are named `<sts>-0`, `<sts>-1`, ... and created **in order**.
- `volumeClaimTemplates` mint one PVC per replica with matching name.
- Scale down deletes the highest-indexed pod first.
- `podManagementPolicy: OrderedReady` (default) blocks on Ready; `Parallel` does not.
- Updating the template triggers a rolling update from the highest index down.

If a StatefulSet pod is stuck Pending, check:

- PVC bound? Stateful pods block on their own PVC.
- Previous-indexed pod Ready? OrderedReady waits for it.

## DaemonSet specifics

One pod per eligible node, managed by the DaemonSet controller.

- "Eligible" = passes node selector, affinity, taints.
- By default, DaemonSet pods have tolerations for `not-ready`, `unreachable`, `memory-pressure`, `disk-pressure`, `pid-pressure`.
- They do **not** tolerate `node-role.kubernetes.io/control-plane` unless you add it.

Updates:

- `RollingUpdate` with `maxUnavailable` controls how many nodes update simultaneously.
- `OnDelete` means no automatic update — you must delete the old pod manually.

## Job specifics

A Job runs Pods to completion.

- `.spec.completions` — total successful completions needed.
- `.spec.parallelism` — max concurrent pods.
- `.spec.backoffLimit` — how many failures before the Job itself fails (default 6).
- `.spec.activeDeadlineSeconds` — max wall-clock time.
- `.spec.ttlSecondsAfterFinished` — when the Job (and its Pods) auto-delete after completion.

Running indexed Jobs (`completionMode: Indexed`) gives each pod a distinct index (like a map-reduce fan-out).

## CronJob specifics

A CronJob is a scheduler of Jobs.

- `.spec.schedule` — cron expression.
- `.spec.concurrencyPolicy` — `Allow` (default), `Forbid` (skip if one runs), `Replace` (kill prior).
- `.spec.startingDeadlineSeconds` — if a scheduled run is missed by more than this, skip it.
- `.spec.successfulJobsHistoryLimit` / `.failedJobsHistoryLimit` — how many old Jobs to keep.

The CronJob controller creates a Job at each schedule tick (within a window). The Job controller then runs it. A stuck CronJob usually means:

- It missed too many schedules and `startingDeadlineSeconds` is short.
- Previous Jobs are not cleaning up (history limits exceeded).
- Time zone confusion — CronJob `timeZone` defaults to the controller's zone; specifying `spec.timeZone` in newer clusters controls it explicitly.

## Debugging patterns

**Deployment not rolling:**

```bash
kubectl rollout status deploy/<d>
kubectl describe deploy <d>
kubectl get rs -l app=<label>
kubectl describe rs <new-rs>
kubectl describe pod <new-pod>
```

Trace down the chain until you find the first level with a meaningful error.

**Pods missing despite ReplicaSet:**

- Check RS events: `kubectl describe rs <rs>`.
- Likely causes: quota exceeded, admission webhook blocking pod creation, scheduler has no capacity, PVC not bound.

**Old pods not dying during rollout:**

- `maxUnavailable` too restrictive, or new pods not becoming Ready.
- Readiness probe failing? `kubectl describe pod <new>` and look at probe events.

**Job stuck Running forever:**

- Pod succeeded but Job not updating? Check controller-manager logs.
- Pod failed but Job keeps retrying? Check `backoffLimit` and `activeDeadlineSeconds`.

## Exam heuristics

- Use `rollout` subcommands rather than editing YAML directly. They handle history and rollbacks cleanly.
- For "update this Deployment's image," prefer `kubectl set image deploy/<d> c=newimage:tag` — fast and minimal.
- For "pause a Deployment, make multiple edits, then resume," that is exactly what `rollout pause`/`resume` are designed for.
- Jobs/CronJobs in CKA mostly appear as "run this command once" or "schedule this." Remember `kubectl create job --from=cronjob/<name> <adhoc>` for manual triggers.

## Mental traps

- Thinking a `kubectl apply` "replaces" a Deployment. It updates the pod template; the old ReplicaSet lingers for history.
- Forgetting that a failing rollout is its own blocking state — new rollouts wait behind it. `rollout undo` or fixing the template is required.
- Believing `replicas: 0` deletes the Deployment. It just scales to zero.
- Confusing `restartPolicy` on a Pod with the parent controller's behavior. Deployments / ReplicaSets require `Always`; Jobs require `OnFailure` or `Never`.
- Assuming a CronJob will "catch up" on missed runs. It normally will not beyond the starting deadline.
