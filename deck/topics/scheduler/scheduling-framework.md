## Why this matters

"The scheduler filters and scores" is the tourist version. The actual scheduler is a **plugin-driven pipeline** with ~15 extension points, where every behavior you can name — node affinity, taints, topology spread, volume binding, preemption — is a plugin hanging off one or more of those points. Knowing the pipeline shape changes three things:

- You can read scheduler log output and know which stage rejected.
- You can write a `KubeSchedulerConfiguration` to disable a plugin (e.g. turn off `PodTopologySpread` for a specific profile).
- You can run a custom scheduler alongside the default and understand what the pod's `schedulerName` actually routes to.

This is where "master of Kubernetes scheduling" lives.

---

## The two cycles

Every pod scheduling attempt has two phases:

```
┌──────────────────────────── SCHEDULING CYCLE ─────────────────────────────┐
│  serial per pod — one pod at a time                                       │
│                                                                            │
│  PreEnqueue → QueueSort (once) → PreFilter → Filter (per node) →          │
│  PostFilter (only if all Filter failed) → PreScore → Score (per node) →    │
│  NormalizeScore → Reserve → Permit                                         │
└───────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────── BINDING CYCLE ────────────────────────────────┐
│  can run concurrently with scheduling cycles for other pods               │
│                                                                            │
│  PreBind → Bind → PostBind                                                 │
└───────────────────────────────────────────────────────────────────────────┘
```

Key invariants:

- The **scheduling cycle is strictly serial**. The scheduler processes one pod at a time. This is why a slow Filter plugin hurts cluster-wide throughput.
- The **binding cycle can run in parallel** with other pods' scheduling cycles. The API write to set `spec.nodeName` can wait on things like PV provisioning without blocking the next pod's scheduling.
- **Reserve → Unreserve** bookend: if anything after Reserve fails, every Reserve plugin gets its `Unreserve` called in reverse order, to undo state.

---

## The extension points, in order

Reading left to right is the life of one pod.

| Point            | Purpose                                                                 | Plugin can return                              |
|------------------|--------------------------------------------------------------------------|------------------------------------------------|
| **PreEnqueue**   | Pre-check before the pod enters the active queue at all.                | Success / Unschedulable (pod holds in queue)   |
| **QueueSort**    | Comparator for the active queue. Exactly one plugin allowed.             | Less(a, b) bool                                |
| **PreFilter**    | Do expensive setup once (e.g. compute the pod's resource demand).        | Success / Error / Unschedulable                |
| **Filter**       | Evaluated per node, concurrently. Reject nodes that cannot run this pod. | Success / Unschedulable / UnschedulableAndUnresolvable |
| **PostFilter**   | Runs **only** if Filter left 0 feasible nodes. Used for preemption.     | Success (with nominated node) / Unschedulable  |
| **PreScore**     | Prepare shared state for Score (e.g. affinity topology map).            | Success / Error                                |
| **Score**        | Per node, assign a score (plugin-native range).                         | int64                                          |
| **NormalizeScore** | Transform all scores into 0..100 range.                                | success                                        |
| **Reserve**      | Reserve in-memory state (e.g. pending volume claims).                   | success/Error                                  |
| **Permit**       | Final gate. Can **Approve**, **Deny**, or **Wait**.                      | Approve / Deny / Wait(timeout)                 |
| **PreBind**      | Do binding-time prep (e.g. PV provision).                               | success/Error                                  |
| **Bind**         | Actually PATCH `spec.nodeName`. Exactly one Bind plugin runs.            | success/Error                                  |
| **PostBind**     | Informational. Can't fail the binding.                                  | —                                               |

### Unschedulable vs UnschedulableAndUnresolvable

Two different Filter rejections:

- **Unschedulable** — "this specific node is unsuitable." Scheduler may try PostFilter (preemption). The pod stays alive in the queue.
- **UnschedulableAndUnresolvable** — "no amount of evicting lower-priority pods will fix this." Preemption is skipped entirely. Saves time when the cause is structural (wrong node labels, wrong taint key, PVC can't bind).

### Reserve → Unreserve is a 2-phase commit

`Reserve` is where plugins stake a claim on cluster state that hasn't been written yet:

- `VolumeBinding` reserves: "this PVC is earmarked for this PV on this node."
- A custom batch plugin might reserve: "this gang of pods is provisionally together."

If any later stage fails — Permit denies, PreBind errors, Bind errors — each Reserve plugin's `Unreserve` is called to roll back. This is why your plugin's `Unreserve` must be idempotent and must not fail.

---

## The default plugin registry

On a vanilla kubeadm scheduler, these plugins come pre-loaded:

| Plugin               | Extension points                                          | What it does                                              |
|----------------------|-----------------------------------------------------------|-----------------------------------------------------------|
| `NodeName`           | Filter                                                    | Respect `spec.nodeName` if set                             |
| `NodeUnschedulable`  | Filter                                                    | Skip nodes with `spec.unschedulable=true` (cordoned)      |
| `NodeResourcesFit`   | PreFilter, Filter, Score, NormalizeScore                  | Requests vs Allocatable, LeastAllocated / MostAllocated scoring |
| `NodeAffinity`       | Filter, Score                                             | `nodeSelector` + `nodeAffinity` required + preferred      |
| `InterPodAffinity`   | PreFilter, Filter, Score                                  | `podAffinity` / `podAntiAffinity`                         |
| `TaintToleration`    | Filter, Score                                             | Taints block, `preferNoSchedule` as soft score            |
| `VolumeBinding`      | PreFilter, Filter, Reserve, PreBind, Score                | PV/PVC binding, WaitForFirstConsumer, topology            |
| `VolumeRestrictions` | Filter                                                    | Enforce `ReadWriteOncePod` and multi-attach rules          |
| `VolumeZone`         | PreFilter, Filter                                         | Enforce PV zone affinity                                   |
| `NodePorts`          | PreFilter, Filter                                         | HostPort conflicts                                         |
| `PodTopologySpread`  | PreFilter, Filter, Score                                  | Topology spread constraints                                |
| `ImageLocality`      | Score                                                     | Prefer nodes that already have the image cached            |
| `DefaultBinder`      | Bind                                                      | The only Bind plugin on by default; PATCHes `nodeName`    |
| `DefaultPreemption`  | PostFilter                                                | The built-in preemption algorithm                          |
| `SchedulingGates`    | PreEnqueue                                                | Respect `spec.schedulingGates` — pod waits in queue until gates cleared |

Ordering matters inside each stage. The default ordering is documented and usually fine. You almost never reorder unless you are building a custom scheduler.

---

## `KubeSchedulerConfiguration` — how to actually configure

The scheduler reads a `KubeSchedulerConfiguration` object at startup:

```
--config=/etc/kubernetes/kube-scheduler/config.yaml
```

A minimal one:

```yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
clientConnection:
  kubeconfig: /etc/kubernetes/scheduler.conf
leaderElection:
  leaderElect: true
profiles:
- schedulerName: default-scheduler
```

That runs everything at defaults.

### Turning a plugin off

```yaml
profiles:
- schedulerName: default-scheduler
  plugins:
    filter:
      disabled:
      - name: PodTopologySpread
    score:
      disabled:
      - name: PodTopologySpread
```

### Adjusting plugin arguments

```yaml
profiles:
- schedulerName: default-scheduler
  pluginConfig:
  - name: NodeResourcesFit
    args:
      scoringStrategy:
        type: MostAllocated          # or LeastAllocated / RequestedToCapacityRatio
        resources:
        - name: cpu
          weight: 1
        - name: memory
          weight: 1
  - name: PodTopologySpread
    args:
      defaultingType: List
      defaultConstraints:
      - maxSkew: 3
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: ScheduleAnyway
```

`MostAllocated` is the "bin-pack" default favoured on cost-optimized clusters (nodes fill up, scale down). `LeastAllocated` is the historical default favouring spread.

### MultiPoint shorthand

If you want to enable a plugin at every extension point it supports:

```yaml
profiles:
- schedulerName: default-scheduler
  plugins:
    multiPoint:
      enabled:
      - name: VolumeBinding
```

Equivalent to listing `VolumeBinding` under PreFilter, Filter, Reserve, PreBind, and Score manually.

### Multiple profiles = multiple schedulers in one binary

The single `kube-scheduler` process can serve several named schedulers, chosen by each pod's `spec.schedulerName`:

```yaml
profiles:
- schedulerName: default-scheduler
  # default config

- schedulerName: batch-scheduler
  plugins:
    score:
      disabled:
      - name: ImageLocality
  pluginConfig:
  - name: NodeResourcesFit
    args:
      scoringStrategy:
        type: MostAllocated

- schedulerName: low-priority-scheduler
  plugins:
    score:
      disabled:
      - name: InterPodAffinity
```

Pods opt-in via:

```yaml
spec:
  schedulerName: batch-scheduler
```

A pod with an unrecognized `schedulerName` stays Pending **forever** (no scheduler owns it). That's a classic misconfiguration — typo in `schedulerName`, pod never lands.

---

## Running an entirely separate scheduler

For cases where you want to ship your own scheduler binary alongside the default:

1. Build a scheduler that registers your custom plugins (or use a framework like [kube-scheduler-simulator](https://sigs.k8s.io/kube-scheduler-simulator) or [kube-scheduler-plugins](https://sigs.k8s.io/scheduler-plugins)).
2. Deploy it as a Deployment in `kube-system` with its own ServiceAccount and RBAC.
3. Configure it with `schedulerName: my-custom-scheduler`.
4. Pods set `spec.schedulerName: my-custom-scheduler` to use it.

The default scheduler ignores these pods because the `schedulerName` doesn't match. Responsibility partitioned by name, not by lock.

### Leader election and multi-scheduler

If you run multiple replicas of a scheduler for HA, **only one is active per `schedulerName`** (leader election via Lease in `kube-system`). Two *different* `schedulerName` schedulers are concurrent and independent.

```bash
kubectl get lease -n kube-system | grep scheduler
# kube-scheduler              cp1_xxx        10d
# my-custom-scheduler         runner-2_xxx   1d
```

---

## Reading scheduler logs

The scheduler logs its decisions at various verbosity levels:

```bash
# Enable detailed logging temporarily via the manifest
# --v=4    show plugin-level decisions
# --v=10   very verbose (debug only, floods log)

kubectl logs -n kube-system kube-scheduler-cp1 -v=4 | head -30
```

Typical useful lines:

```
"Attempting to schedule pod" pod="default/foo"
"Unable to schedule pod; no fit; waiting" pod="default/foo" err="..."
"Failed to run Filter plugin" plugin="NodeResourcesFit" pod="default/foo" node="n1" status="Insufficient cpu"
"Considering preemption" pod="default/foo"
"Preemption: found candidate nodes" count=2
"Successfully bound pod to node" pod="default/foo" node="n2"
```

Events on the pod are usually more digestible:

```bash
kubectl describe pod foo | tail -20
# Events:
#   Warning  FailedScheduling  5s (x2 over 10s)  default-scheduler  0/5 nodes are available:
#     2 Insufficient cpu, 1 node(s) had untolerated taint {...}, 2 node(s) didn't match Pod's node affinity.
```

That one event line tells you the plugin-level breakdown: how many nodes each filter rejected.

---

## Failure modes caused by framework misconfiguration

| Symptom                                                                 | Likely framework cause                                                       |
|-------------------------------------------------------------------------|------------------------------------------------------------------------------|
| Pod Pending, events empty                                                | `spec.schedulerName` names a non-existent scheduler. Check `kubectl get pods -o custom-columns=NAME:.metadata.name,SCHED:.spec.schedulerName` |
| Pod Pending with `0/N nodes available` citing a plugin you thought was off | That plugin is still enabled in the active profile. Check `KubeSchedulerConfiguration` loaded path. |
| Bin-packing expected but cluster spreads pods                            | `NodeResourcesFit.scoringStrategy.type` is `LeastAllocated`, not `MostAllocated`. |
| Scheduler log shows pod, binds, but `kubectl get pod` still Pending       | Bind plugin succeeded but pod status not updated — apiserver or informer stale. Rare; check apiserver health. |
| Pod Pending and events say `nominated, node didn't fit after preemption` | PostFilter ran preemption, picked a node, but then Filter rejected it on retry. See preemption subtopic. |

---

## Exam heuristics

- The exam rarely asks you to write a `KubeSchedulerConfiguration`. It does sometimes ask you to **deploy a second scheduler** and run a pod against it. Know the `schedulerName` pattern.
- If a pod is stuck Pending and events are empty, **first check** `spec.schedulerName`. Typos here silently orphan pods.
- Know the default plugins by name — you'll see them referenced in `FailedScheduling` events.
- `--v=4` on the scheduler is usually enough detail to see plugin-level decisions without drowning.

## Mental traps

- Thinking the scheduler handles pods in parallel. The scheduling cycle is serial. The binding cycle is parallel.
- Expecting PostFilter to run when Filter returned 0 nodes but one of them was `UnschedulableAndUnresolvable`. Preemption bails for structural rejections.
- Assuming you can disable `DefaultBinder`. You can, but you'd need a replacement Bind plugin. Without any Bind, pods never get `spec.nodeName` set.
- Treating plugin order as fixed. Inside each stage, the scheduler runs plugins in the configured order. Reordering changes outcomes for plugins that short-circuit.
- Running two schedulers with the same `schedulerName` across different processes expecting both to schedule. Only the Lease holder is active.
- Believing `schedulerName` is validated. It's a free-form string — a typo like `defualt-scheduler` silently pins the pod to a scheduler that doesn't exist.
