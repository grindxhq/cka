## Why the queue is its own thing

The scheduler is a single-consumer pipeline — one pod scheduled at a time. What goes into that pipeline is governed by a three-tier queue that most people picture as a flat FIFO. It isn't. It is three queues, with a small state machine that moves pods between them and cluster events that re-queue pods from dormancy back to active consideration.

Understanding this explains:

- Why a Pending pod sometimes schedules itself minutes later even though you changed nothing.
- Why the scheduler "re-tries" slow — there is backoff math deciding when.
- Why deleting a pod on a different node can unstick an unrelated Pending pod.

---

## The three queues

```
                  ┌────────────────────────────────────────┐
  new pod     ─►  │        activeQ (priority-sorted)       │  ←── backoffQ flush
                  │        scheduler pulls from here       │  ←── unschedulableQ flush
                  └────────────────────────────────────────┘
                                    │
                                    ▼  (attempt)
                              scheduling cycle
                              ┌─────┴─────┐
                      success               failure
                         │                     │
                         ▼                     ▼
                      binds          ┌────────────────────┐
                                     │      backoffQ      │  ── time-sorted
                                     │  (wait N seconds   │
                                     │   before retry)    │
                                     └────────────────────┘
                                          │
                                          │  backoff expires
                                          ▼
                                   (back to activeQ)
                                          │
                                          │  if repeatedly unschedulable
                                          ▼
                                  ┌────────────────────┐
                                  │  unschedulablePods │
                                  │  (holding pen;      │
                                  │   wait for events)  │
                                  └────────────────────┘
                                          │
                                          │  cluster event or 5 min timeout
                                          ▼
                                   (back to activeQ or backoffQ)
```

Each queue has a distinct purpose:

| Queue              | Holds                                     | Exit trigger                                |
|--------------------|-------------------------------------------|--------------------------------------------|
| `activeQ`          | pods eligible for the **next** scheduling attempt | scheduler picks one to schedule             |
| `backoffQ`         | recently-failed pods in cooldown          | backoff duration expires                    |
| `unschedulablePods`| pods that couldn't fit; waiting for cluster to change | relevant cluster event, OR 5-minute leftover flush |

---

## activeQ — priority-ordered, not FIFO

The scheduler doesn't pop activeQ in arrival order. It uses a **priority heap** sorted by:

1. Pod priority (higher first).
2. Pod's queuing timestamp (older first) within the same priority.

Effect: a high-priority pod queued after a batch of low-priority ones jumps to the front. This is what makes `preemptionPolicy: Never` useful — high priority alone promotes queue position even without evicting anyone.

You can change this sort by implementing a custom `QueueSort` plugin, but only one is allowed at a time, and the default is almost always right.

---

## backoffQ — exponential cooldown

When a scheduling attempt fails (Filter rejected every node, preemption failed, Bind failed), the pod doesn't immediately retry. It enters `backoffQ` for a cooldown period:

```
attempt 1 fails → wait 1 s
attempt 2 fails → wait 2 s
attempt 3 fails → wait 4 s
...
capped at 10 s max (default)
```

Tunable via scheduler flags:

```
--pod-initial-backoff-seconds=1
--pod-max-backoff-seconds=10
```

The backoff resets if the pod successfully schedules or is updated (spec change). Backoff is per-pod, not per-attempt-of-all-pods.

Why this matters: the scheduler **is not re-trying immediately**. If you see a pod that "keeps failing," each failure adds cooldown. 10 failures isn't 10 consecutive attempts — it's 10 attempts spread over ~30+ seconds.

### When a pod is in backoffQ

It is invisible to the "what's next to schedule?" logic. It will **not** be considered until backoff expires. This is intentional — it prevents a broken pod from starving others by repeatedly demanding filter passes.

---

## unschedulablePods — the "waiting for the world to change" bucket

After a small number of failed attempts, a pod moves to `unschedulablePods`. This is a map (not a heap) holding pods that:

- Failed their last scheduling attempt.
- Backoff has expired, but nothing changed that would affect them.
- Scheduler "gave up" trying until it has reason to retry.

The pod just sits there. It does not consume scheduling cycles. The scheduler does not re-attempt it. This is efficient — there's no point filtering against a cluster that hasn't changed since the last failure.

But that creates a problem: how does it ever come back? Two mechanisms.

---

## Moving pods out of unschedulablePods: events

Every scheduler plugin can declare which **cluster events** might make its previously-rejected pods schedulable. These are called `ClusterEventWithHint` or `EventsToRegister`. Examples:

| Plugin                | Events that might unstick its rejected pods                        |
|-----------------------|-------------------------------------------------------------------|
| `NodeResourcesFit`    | `Pod/Delete` (capacity freed), `Node/Add`, `Node/Update`         |
| `NodeAffinity`        | `Node/Update` (labels changed), `Node/Add`                       |
| `TaintToleration`     | `Node/Update` (taint removed)                                     |
| `InterPodAffinity`    | `Pod/Add`, `Pod/Update`, `Pod/Delete`                             |
| `VolumeBinding`       | `PersistentVolume/Add`, `StorageClass/Add`, `CSIDriver/Add`      |
| `PodTopologySpread`   | `Pod/Delete`, `Node/Update`                                       |

When a cluster event fires:

1. Scheduler receives an informer update (Node added, Pod deleted, etc.).
2. For each pod in unschedulablePods, it checks: "does any plugin that previously rejected this pod care about this event?"
3. If yes → move the pod to activeQ (or backoffQ if its backoff hasn't cleared).
4. If no → leave in unschedulablePods.

This is what makes the scheduler feel "magical" — a pod stuck 10 minutes ago suddenly schedules when someone deletes an unrelated pod somewhere else.

### The `moveAllToActiveOrBackoffQueue` shortcut

In practice, the scheduler implementation is conservative: some events (like new node added) move **all** unschedulable pods to activeQ, letting them re-filter. The granular "only pods this event affects" path is refined as plugins get their hints right.

### The 5-minute safety net

Even without any cluster event, pods in unschedulablePods eventually get retried via `flushUnschedulablePodsLeftover`, which runs every 30 seconds and promotes any pod that has been sitting unschedulable for longer than `podMaxInUnschedulablePodsDuration` (default **5 minutes**).

So in the worst case: a Pending pod that nothing helped along is retried every 5 minutes.

### Why this explains real-world behaviour

Scenario: you create a pod that doesn't fit, events say "0/5 nodes available." You fix the problem (delete a capacity-hogging pod on node-3) and expect the Pending pod to schedule instantly.

What happens:

- The "Pod deleted" event reaches the scheduler's informer.
- Scheduler checks: "does any plugin that rejected my Pending pod care about Pod/Delete?" Yes — `NodeResourcesFit` does.
- Pending pod moves to activeQ.
- Scheduler picks it up, runs Filter, sees node-3 has room, binds.

Total latency: milliseconds to ~1 second.

If instead you restart the kubelet on node-3 — kubelet restart doesn't emit Pod-delete events, and the node status update may not trigger the resource plugin's hint — the pod may linger. This is why "nothing I did seems to unstick it, then 5 minutes later it schedules" happens: the leftover flush kicked in.

---

## PreEnqueue and scheduling gates

A pod can be held **before** entering activeQ by PreEnqueue plugins. The canonical one is `SchedulingGates`:

```yaml
apiVersion: v1
kind: Pod
spec:
  schedulingGates:
  - name: "awaiting-config"
  - name: "awaiting-quota"
```

The scheduler's `SchedulingGates` plugin at PreEnqueue returns Unschedulable for any pod with non-empty `schedulingGates`. The pod is kept **in unschedulablePods from the start** — never even reaching activeQ.

Releasing a gate requires a strategic patch that removes (not empties) the entry:

```bash
kubectl patch pod my-pod --type=json -p='[{"op": "remove", "path": "/spec/schedulingGates/0"}]'
```

Once all gates are cleared, the pod gets moved to activeQ and scheduled normally. This is a mechanism for things like CI coordination, where an external controller holds the pod until prerequisites are ready.

### How it differs from Pending + Unschedulable

- A pod with schedulingGates is Pending but **never considered for scheduling**. No Filter attempts.
- A regular Pending pod (no gates) is Pending because scheduling attempts failed.

`kubectl describe pod <gated-pod>` shows `SchedulingGated` in the status conditions, not the usual `PodScheduled=False` with filter messages.

---

## Performance implications

### Scheduler throughput

Because scheduling is serial, scheduler throughput is `1 / average-scheduling-time-per-pod`. Slow plugins hurt cluster-wide scheduling rate.

Typical throughput on a busy cluster: ~100-500 pods/sec with default plugins. Custom Filter plugins that hit external APIs can drop this by 10×. In production, aim for sub-10 ms per pod in the scheduling cycle.

### Queue observability

The scheduler exposes metrics (Prometheus endpoint on `:10259/metrics`):

```
scheduler_pending_pods{queue="active"}              # count in activeQ
scheduler_pending_pods{queue="backoff"}             # count in backoffQ
scheduler_pending_pods{queue="unschedulable"}       # count in unschedulablePods
scheduler_pending_pods{queue="gated"}               # count gated at PreEnqueue

scheduler_queue_incoming_pods_total                  # counter of pods added to each queue
scheduler_scheduling_attempt_duration_seconds_bucket # histogram of end-to-end time per pod
scheduler_pod_scheduling_sli_duration_seconds_bucket # SLI-compatible latency (since pod created)
```

If `unschedulable` is >> `active`, the cluster is mostly full and many pods are waiting on events.

If `scheduling_attempt_duration` is climbing, one of the plugins is slow.

### Scheduling queue in a pod-flood scenario

Creating 1,000 pods at once:

1. All 1,000 enter activeQ sorted by priority.
2. Scheduler pulls them one at a time. Say each takes 5 ms → 5 seconds total.
3. As pods schedule, their placement updates the node state, which affects subsequent pods' Filter outcomes.
4. Pods that couldn't fit go to backoffQ; cluster events from the ongoing scheduling trigger re-enqueues.

Pattern: scheduler fills the cluster efficiently, then stops when nodes are full, with remaining pods in unschedulablePods waiting for scale-out or pod termination.

---

## Debugging a stuck Pending pod

1. Is it scheduling-gated?
   ```bash
   kubectl get pod my-pod -o jsonpath='{.spec.schedulingGates}'
   # [{"name":"awaiting-config"}]  → gated
   # (empty) → not gated
   ```
2. What does the scheduler's last event say?
   ```bash
   kubectl describe pod my-pod | sed -n '/Events:/,$p'
   # "Warning  FailedScheduling  ..."
   ```
3. Is it in activeQ, backoffQ, or unschedulablePods? You can't see directly from `kubectl`, but from scheduler logs:
   ```bash
   kubectl logs -n kube-system kube-scheduler-cp1 | grep my-pod | tail -10
   ```
4. Do events suggest a plugin rejection? The `FailedScheduling` message breaks down the reason counts:
   ```
   "0/5 nodes are available: 2 Insufficient cpu, 1 node(s) had untolerated taint ..."
   ```
5. What event would unstick this pod? From the above, `Insufficient cpu` is unlocked by `Pod/Delete`; `untolerated taint` is unlocked by `Node/Update` (taint removed).
6. Force a re-queue by touching the pod:
   ```bash
   kubectl annotate pod my-pod retry-trigger=$(date +%s) --overwrite
   ```
   Any update on the pod moves it back to activeQ immediately, bypassing the wait.

---

## Exam heuristics

- If a pod is Pending, first check `schedulingGates`. Gated pods look identical to "unschedulable" at a glance.
- If scheduling events are empty, the pod may have never entered activeQ — check `schedulerName` (may be typo pointing to a nonexistent scheduler) and gates.
- "I fixed the problem but the pod is still Pending" — either the cluster event that would unstick it hasn't fired, or the pod is in backoff. Annotate the pod to force re-enqueue.
- `kubectl get events --field-selector reason=FailedScheduling -A` shows cluster-wide scheduling failures — useful for cluster health.

## Mental traps

- Thinking the scheduler retries every few seconds. It doesn't — it retries on backoff expiry **or** on cluster events affecting the pod's rejection reasons.
- Believing the activeQ is FIFO. It's priority-sorted; a high-priority pod jumps to front.
- Assuming scheduling gates can be emptied by `patch ... spec.schedulingGates=[]`. You need to remove entries, not set an empty list — strategic merge patch has quirks here. JSON patch is safer.
- Creating 10,000 pods and expecting instant scheduling. You get ~100-500 /s throughput with defaults.
- Confusing "Unschedulable" (returned by Filter) with `unschedulablePods` (the queue). Same word, different scopes.
- Treating `scheduler_pending_pods{queue="unschedulable"}` being high as an alarm. On a full cluster it's normal — the pods are just waiting for capacity.
