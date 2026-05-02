## Run-to-completion semantics

Deployments, DaemonSets, StatefulSets all assume the workload runs forever (`restartPolicy: Always`). Jobs are different: they run **until success**.

A Job creates one or more Pods. Each pod runs its task. When the pod exits 0, that's a successful completion. The Job tracks how many completions it needs and creates more pods as required.

```
 Job needs 3 completions → creates pods → 3 succeed → Job is done.
```

Use cases:

- Database backups (run a script once a night).
- Batch data processing (process N items, exit).
- One-shot setup tasks (initialize, exit).
- Migrations.

For *scheduled* one-shot tasks (every night at 2am), `CronJob` wraps `Job` with a schedule.

---

## A simple Job

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: backup
spec:
  template:
    spec:
      containers:
      - name: backup
        image: backup:1.0
        command: [ "sh", "-c", "pg_dump -h db -U user app > /backup/dump-$(date +%F).sql" ]
        volumeMounts:
        - name: backup
          mountPath: /backup
      restartPolicy: OnFailure        # required: OnFailure or Never
      volumes:
      - name: backup
        persistentVolumeClaim:
          claimName: backups
```

Apply, watch:

```bash
kubectl apply -f job.yaml
kubectl get jobs
# NAME     COMPLETIONS   DURATION   AGE
# backup   0/1           5s         5s
# ...
# backup   1/1           45s        45s   ← done

kubectl logs job/backup
```

Pod is auto-cleaned eventually (governed by `ttlSecondsAfterFinished`).

### restartPolicy

For Pods owned by Jobs, `restartPolicy` must be `OnFailure` or `Never` (apiserver enforces). Why?

- **`Always`** — the Pod would restart even on success. Job would never complete.
- **`OnFailure`** — pod retries within itself until success or backoff exhausted.
- **`Never`** — pod fails permanently on any non-zero exit; Job creates a new pod.

`OnFailure` keeps the same pod and re-runs the container in place (faster restart, same volumes).
`Never` destroys the pod and creates a fresh one (slower, but completely fresh state).

---

## completions and parallelism

Two fields control how many pods a Job creates and how:

```yaml
spec:
  completions: 5        # need 5 successful pods total
  parallelism: 2         # run at most 2 simultaneously
```

Example flow:

```
 t=0   create pods A, B (parallelism=2)
 t=10  A succeeds (1/5 done)  → create pod C
 t=15  B succeeds (2/5 done)  → create pod D
 t=20  C succeeds (3/5 done)  → create pod E
 t=25  D succeeds (4/5 done)
 t=30  E succeeds (5/5 done)  → Job complete
```

Each pod runs the same template. Without coordination, all 5 do the same thing 5 times. For real parallel work, you typically use **work queues** (each pod pops items from a queue) or **indexed jobs** (each pod gets a unique index).

### Three patterns

**Pattern 1: One pod per task (default)**
```yaml
completions: 1
parallelism: 1
```
Single-pod job. Most common.

**Pattern 2: Fixed completions, controlled parallelism**
```yaml
completions: 100
parallelism: 5
```
100 pods total, 5 at a time. Good for batch processing where each pod handles a portion.

**Pattern 3: Work queue**
```yaml
parallelism: 5
# completions omitted
```
Pods run forever (well, parallelism=5 of them) consuming from an external queue. When a pod exits 0, no replacement (no completions target). When all running pods exit 0, Job completes.

App-level coordination required: pods coordinate via Redis, RabbitMQ, etc.

### Indexed completion mode (1.21+)

```yaml
spec:
  completionMode: Indexed       # | NonIndexed (default)
  completions: 5
  parallelism: 2
  template:
    spec:
      containers:
      - name: worker
        image: worker:1.0
        env:
        - name: JOB_COMPLETION_INDEX
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
```

Each pod gets a unique index (0, 1, 2, 3, 4). Pod sees its index via env var or annotation. App uses it to decide which slice of work to do (e.g. "shard %5 == JOB_COMPLETION_INDEX").

Pod names also include the index: `backup-0-abc12`, `backup-1-def45`, etc.

Useful for parallel work where each pod handles a known partition.

---

## Failure handling

```yaml
spec:
  backoffLimit: 6                       # max retries before Job is marked Failed
  activeDeadlineSeconds: 3600           # max wallclock for the whole Job
```

### backoffLimit

The Job creates new pods (or restarts the same pod, per restartPolicy) on failure, up to `backoffLimit` times. After that, the Job is marked Failed.

Default: 6.

When a pod fails:

```
 Failure 1 → wait ~10s → retry
 Failure 2 → wait ~20s → retry
 Failure 3 → wait ~40s → retry
 ...exponential backoff up to ~6 minutes
 Failure 7 → Job Failed
```

If you want a Job to give up faster, set lower `backoffLimit`. If you want infinite retries, you can set very high — but probably you should debug rather than retry forever.

### activeDeadlineSeconds

Hard wallclock limit. Once the Job has been running this long, all pods are terminated and the Job is marked Failed (regardless of completions).

Useful for "this should finish in 30 minutes; if it's still running, something is wrong":

```yaml
spec:
  activeDeadlineSeconds: 1800     # 30 minutes
```

This timer runs from Job start, including any time pods were waiting / restarting. Independent of `backoffLimit`.

### Pod failure policy (1.26+)

More fine-grained: react to specific exit codes.

```yaml
spec:
  podFailurePolicy:
    rules:
    - action: FailJob              # mark Job as Failed immediately
      onExitCodes:
        operator: In
        values: [42]                # if exit code is 42, give up
    - action: Ignore               # don't count this against backoffLimit
      onPodConditions:
      - type: DisruptionTarget     # pod was evicted; not its fault
        status: "True"
```

Useful when an app distinguishes "fail and retry" (transient) from "fail and stop" (permanent error).

---

## ttlSecondsAfterFinished

Auto-clean Jobs (and their Pods) after success/failure:

```yaml
spec:
  ttlSecondsAfterFinished: 3600      # delete the Job + Pods 1 hour after completion
```

Without this, completed Jobs accumulate forever. Logs are gone (pod deleted), but the Job object lingers in etcd.

A `ttlSecondsAfterFinished: 0` deletes immediately (you lose the chance to inspect post-completion).

Recommended: 1-7 days for production Jobs, 0-1h for high-volume CronJob-spawned Jobs.

---

## A complete batch Job

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: process-orders
spec:
  parallelism: 5
  completions: 100
  completionMode: Indexed
  backoffLimit: 3
  activeDeadlineSeconds: 7200
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels: { app: order-processor }
    spec:
      restartPolicy: Never           # bad pod = new pod, not retry-in-place
      containers:
      - name: worker
        image: order-processor:1.0
        env:
        - name: SHARD
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
        - name: TOTAL_SHARDS
          value: "100"
        resources:
          requests: { cpu: 500m, memory: 512Mi }
          limits:   { cpu: 1000m, memory: 1Gi }
```

Reads: process 100 shards of orders, 5 workers in parallel, each pod handles its own SHARD via the completion index.

---

## CronJob — Job on a schedule

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-backup
spec:
  schedule: "0 2 * * *"              # every day at 2am UTC (cron format)
  timeZone: "Europe/London"          # 1.27+; otherwise UTC
  startingDeadlineSeconds: 300       # if missed by > 5 min, skip this run
  concurrencyPolicy: Forbid          # | Allow | Replace
  successfulJobsHistoryLimit: 3      # keep last 3 successful Jobs
  failedJobsHistoryLimit: 1          # keep last 1 failed Job
  suspend: false                      # set true to pause scheduling
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: backup
            image: backup:1.0
            command: [ "/backup.sh" ]
```

The CronJob controller watches the clock and creates a Job from `jobTemplate` at each scheduled time. The Job then runs its pods like any other Job.

### concurrencyPolicy

What if a previous Job is still running when the next schedule fires?

| Policy    | Behaviour |
|-----------|-----------|
| `Allow` (default) | New Job created; old one continues. May overlap. |
| `Forbid`          | Skip this run. Wait for old Job to finish, then resume scheduling. |
| `Replace`         | Cancel old Job, start new one. |

Choose based on workload:

- Idempotent, fast, can overlap → `Allow`.
- Long-running, can't overlap (e.g. write to same file) → `Forbid` or `Replace`.

### startingDeadlineSeconds

If the CronJob controller is down or stuck, it might miss scheduled runs. When it catches up:

```yaml
startingDeadlineSeconds: 300      # only run if within 5 minutes of scheduled time
```

A run scheduled for 02:00 that the controller didn't see until 02:10 → skip (>5 min late).

If unset, the controller may try to catch up on missed runs, potentially launching multiple Jobs in rapid succession. Always set this.

### Job history

`successfulJobsHistoryLimit` and `failedJobsHistoryLimit` cap how many old Jobs are kept for inspection. Defaults are 3 and 1.

```bash
# See all Jobs created by a CronJob
kubectl get jobs -l <cronjob-name>

# Inspect logs from a specific run
kubectl logs job/<job-name>
```

Beyond the limit, Job and its Pods are auto-deleted.

---

## CronJob schedule format

Standard cron syntax:

```
 ┌───────────── minute (0 - 59)
 │ ┌───────────── hour (0 - 23)
 │ │ ┌───────────── day of month (1 - 31)
 │ │ │ ┌───────────── month (1 - 12)
 │ │ │ │ ┌───────────── day of week (0 - 6, 0 = Sunday)
 * * * * *
```

Examples:

```
"*/5 * * * *"     every 5 minutes
"0 0 * * *"        daily at midnight
"0 2 * * 0"        Sundays at 2am
"30 9 1 * *"       9:30am on the 1st of every month
"@hourly"          shorthand for "0 * * * *"
"@daily"           shorthand for "0 0 * * *"
```

Time zone defaults to the controller's local time (usually UTC). Set `spec.timeZone` (1.27+) for explicit zone.

---

## CronJob in practice

```bash
# Create
kubectl apply -f cronjob.yaml

# List
kubectl get cronjob

# NAME              SCHEDULE      SUSPEND   ACTIVE   LAST SCHEDULE   AGE
# nightly-backup    0 2 * * *     False     0        12h ago         5d

# Manually trigger a one-off run
kubectl create job --from=cronjob/nightly-backup manual-backup-$(date +%s)

# Suspend (skip future runs without deleting)
kubectl patch cronjob nightly-backup -p '{"spec":{"suspend":true}}'

# Resume
kubectl patch cronjob nightly-backup -p '{"spec":{"suspend":false}}'
```

`kubectl create job --from=cronjob/...` is a great pattern for testing — you get a one-off Job from the same template without waiting for the cron schedule.

---

## Common Job / CronJob failure modes

### Pod restartPolicy: Always

```
The Job "backup" is invalid: spec.template.spec.restartPolicy:
  Required value: valid values: "OnFailure", "Never"
```

Apiserver rejects. Set `restartPolicy: OnFailure` or `Never`.

### Job stuck because pod won't succeed

If the pod's command always exits non-zero, kubelet retries (per restartPolicy), then Job creates new pods up to `backoffLimit`.

Diagnose with `kubectl logs job/<name>` or `kubectl logs <pod>`.

If exit codes are deterministic and the pod can't recover, lower `backoffLimit` to fail fast.

### Job appears stuck (no progress)

Pods crashlooping on the same error. Logs reveal. Often a config or input data issue.

```bash
kubectl describe job <name>
kubectl logs <pod-from-job> --previous
```

### CronJob doesn't run at the expected time

- `timeZone` not set → controller uses UTC. 2am in your zone might be 2am UTC (12-hour offset).
- `startingDeadlineSeconds` is short and the controller was busy.
- `suspend: true` was set.
- Time on the kube-controller-manager node is wrong.

Check:

```bash
kubectl describe cronjob <name>
# Status section shows last schedule time

# The controller's time
kubectl exec -n kube-system <kube-controller-manager-pod> -- date
```

### CronJob creates many Jobs in rapid succession after downtime

Controller missed several runs while down. With `startingDeadlineSeconds` unset, it tries to catch up.

Mitigation: always set `startingDeadlineSeconds` to a reasonable bound.

### History limit eats logs you needed

```bash
kubectl logs job/<name>
# Error: jobs.batch "..." not found
```

Old Jobs (and their pod logs) deleted by `successfulJobsHistoryLimit` / `failedJobsHistoryLimit`. Increase the limits if you need longer history; ship logs to a centralized system for permanent retention.

---

## Inspecting Jobs

```bash
# Job status overview
kubectl get jobs

# Detailed status
kubectl describe job <name>

# Output of completed Job
kubectl logs job/<name>

# Pods owned by a Job
kubectl get pods -l job-name=<name>

# Conditions on a Job
kubectl get job <name> -o jsonpath='{.status.conditions}'
# - Complete: True (success)
# - Failed:   True (give-up)
```

For CronJobs:

```bash
# All Jobs created by a CronJob
kubectl get jobs -l <selector-from-cronjob>

# Most recent Job
kubectl get jobs --sort-by=.metadata.creationTimestamp | tail -3
```

---

## When to use Jobs vs alternatives

| Need | Tool |
|------|------|
| One-shot setup task | Job |
| Recurring task on schedule | CronJob |
| Always-running worker | Deployment (or StatefulSet for stateful) |
| One pod per node | DaemonSet |
| One-shot init before main app starts | Init container in a Pod |

**Don't use Job for "long-running batch worker"** — that's a Deployment with parallelism. Job is for "do work and exit."

---

## Common patterns

### Database migration before app deploy

```yaml
# In your deploy pipeline:
# 1. Apply migration Job
# 2. Wait for completion: kubectl wait --for=condition=complete job/migration --timeout=10m
# 3. Apply Deployment

apiVersion: batch/v1
kind: Job
metadata: { name: db-migrate }
spec:
  ttlSecondsAfterFinished: 600     # auto-clean after 10 min
  backoffLimit: 0                    # no retries for migrations (idempotency varies)
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: migrate
        image: app:1.0
        command: [ "/app", "migrate" ]
```

### Indexed parallel batch

```yaml
spec:
  parallelism: 10
  completions: 100
  completionMode: Indexed
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: worker
        image: shard-processor:1.0
        env:
        - name: SHARD
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
```

100 shards, 10 in parallel. Each pod handles `SHARD = its-index`.

### Backup CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: backup }
spec:
  schedule: "0 3 * * *"              # 3am UTC daily
  startingDeadlineSeconds: 600
  concurrencyPolicy: Forbid          # don't overlap
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      activeDeadlineSeconds: 14400   # max 4 hours
      ttlSecondsAfterFinished: 604800  # 7 days
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: backup
            image: backup:1.0
            command: [ "/backup.sh", "/data" ]
            volumeMounts:
            - name: data
              mountPath: /data
              readOnly: true
            - name: archive
              mountPath: /backup
          volumes:
          - name: data
            persistentVolumeClaim: { claimName: app-data }
          - name: archive
            persistentVolumeClaim: { claimName: backups }
```

Runs nightly. Won't overlap. Keeps a week of history.

---

## Exam heuristics

- For "run this command once," use a Job with `parallelism: 1, completions: 1`.
- For "run this every night," use a CronJob.
- `restartPolicy` for Jobs is `OnFailure` or `Never`. Apiserver rejects `Always`.
- `kubectl create job --from=cronjob/<name> <new-job-name>` triggers a manual run from a CronJob template.
- `kubectl wait --for=condition=complete job/<name>` waits for a Job to finish (timeout-bounded).
- `ttlSecondsAfterFinished` is your friend — auto-clean completed Jobs.

## Mental traps

- Setting `restartPolicy: Always` on a Job pod template. Apiserver rejects.
- Using Jobs for long-running workers. Use Deployment instead.
- CronJobs without `startingDeadlineSeconds` — risk of catch-up storms.
- Forgetting `ttlSecondsAfterFinished` and accumulating thousands of completed Job objects.
- Setting too-aggressive `activeDeadlineSeconds` on a Job that legitimately takes longer.
- Confusing `concurrencyPolicy: Allow` (default — overlapping runs) vs `Forbid` (skip if previous still running). Allow can multiply load unexpectedly.
- Treating a CronJob's most recent Job as definitive. There may be older successful Jobs (or failed ones); check `kubectl get jobs -l <cronjob-name>`.
- Expecting `kubectl delete cronjob` to also delete its still-running Jobs. By default, it cascades — but pods of in-flight Jobs may take time to terminate.
