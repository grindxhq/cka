## What "Pending" really means

```
$ kubectl get pods
NAME       READY   STATUS    RESTARTS   AGE
my-pod     0/1     Pending   0          5m
```

**Pending** is overloaded. It can mean:

1. **Not yet scheduled** — `spec.nodeName` is empty, scheduler hasn't picked a node.
2. **Scheduled but not yet started** — `spec.nodeName` is set; kubelet is pulling images / mounting volumes.
3. **Deliberately gated** — `spec.schedulingGates` blocks it from even entering the scheduling queue.

The first triage decision: which of these three is it?

---

## Branch on `spec.nodeName`

```bash
kubectl get pod my-pod -o jsonpath='{.spec.nodeName}{"\n"}'
```

| Value | Meaning |
|-------|---------|
| Empty / `""` | Not yet scheduled. Scheduler problem (or deliberate gate). |
| Set to a node name | Already scheduled. Kubelet is starting it. Different debug path. |

Also check `status.conditions`:

```bash
kubectl get pod my-pod -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
```

`PodScheduled=False` → not scheduled.
`PodScheduled=True, Initialized=False` → scheduled but init not done.
`PodScheduled=True, Initialized=True, Ready=False` → past init, but not Ready (running but failing readiness).

---

## Path A: Not yet scheduled

`spec.nodeName` is empty. Scheduler hasn't picked a node. Why?

### Step 1: Check pod events

```bash
kubectl describe pod my-pod | sed -n '/Events:/,$p'
```

The scheduler writes a `FailedScheduling` event with a precise reason:

```
Type     Reason             Age   From               Message
----     ------             ----  ----               -------
Warning  FailedScheduling   5m    default-scheduler  0/5 nodes are available:
                                                      2 Insufficient cpu,
                                                      1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: },
                                                      2 node(s) didn't match Pod's node affinity.
```

This single line tells you:

- 0 nodes were feasible.
- Why each node was rejected (broken down by count).
- Pull-quote the exact reason from the message.

### Step 2: Map reason to fix

| Event reason / message | Cause | Fix |
|------------------------|-------|-----|
| `Insufficient cpu` / `Insufficient memory` | Resource requests don't fit | Lower requests, scale cluster, evict big pods |
| `node(s) had untolerated taint` | Pod doesn't tolerate node's taint | Add toleration OR remove taint |
| `node(s) didn't match Pod's node affinity` | nodeSelector / nodeAffinity excludes nodes | Loosen selector, add labels to nodes |
| `node(s) didn't match Pod's anti-affinity` | Existing pods elsewhere block this one | Relax anti-affinity or remove sibling pods |
| `node(s) had volume node affinity conflict` | Volume in zone A, scheduler tried zone B | StorageClass `WaitForFirstConsumer` or fix node labels |
| `node(s) didn't have free ports` | hostPort already used | Different port / different scheduling |
| `1 node(s) were unschedulable` | Node cordoned (`spec.unschedulable: true`) | `kubectl uncordon` |
| `pod has unbound immediate PersistentVolumeClaims` | PVC not bound | Fix PVC (see pvc-pending playbook) |
| `node(s) didn't satisfy pod topology spread constraints` | Topology spread can't be honored | Relax `whenUnsatisfiable: ScheduleAnyway` or add nodes |

The event message is precise — read every clause.

### Step 3: No events at all

If `describe pod` shows no Events block (or no FailedScheduling):

- Pod hasn't reached the scheduler queue yet (just created).
- Pod has scheduling gates.
- Scheduler isn't running.

Check:

```bash
# Scheduling gates?
kubectl get pod my-pod -o jsonpath='{.spec.schedulingGates}{"\n"}'
# null  → not gated
# [{"name":"awaiting-config"}] → gated; need to remove the gate

# Scheduler running?
kubectl get pods -n kube-system -l component=kube-scheduler
# Should show 1 (or N for HA) Running

# Scheduler logs
kubectl logs -n kube-system <kube-scheduler-pod> --tail=50
```

If scheduling gates: remove via patch:

```bash
kubectl patch pod my-pod --type=json \
  -p='[{"op":"remove","path":"/spec/schedulingGates/0"}]'
```

If scheduler is broken: see the scheduler / control-plane debug paths.

If scheduler is healthy and pod has been Pending >30 seconds with no events: did anything happen to put the pod in the queue at all? Check the `spec.schedulerName`:

```bash
kubectl get pod my-pod -o jsonpath='{.spec.schedulerName}'
# default-scheduler  ← normal
# my-custom-scheduler  ← needs that scheduler running
# typo-scheduler      ← orphaned: no scheduler with this name; pod stuck forever
```

A typo'd `schedulerName` orphans the pod silently. Recreate with correct value.

---

## Path B: Scheduled but ContainerCreating

`spec.nodeName` is set; pod is on a node. Kubelet is doing setup work.

```bash
kubectl get pod my-pod
# my-pod  0/1  ContainerCreating  0  3m
```

Typical setup steps:

1. Pull container images.
2. Mount volumes (PVCs / Secrets / ConfigMaps / projected).
3. Create the sandbox (CNI assigns IP).
4. Start init containers.
5. Start main containers.

`describe pod` shows where it stuck:

```bash
kubectl describe pod my-pod | sed -n '/Events:/,$p'
```

| Event reason | Stuck at step | Subtopic |
|--------------|---------------|----------|
| `FailedCreatePodSandBox` | CNI / sandbox | container-runtime → image-and-sandbox-failures |
| `FailedMount` | Volume / CSI | container-runtime → image-and-sandbox-failures + storage |
| `Failed` (image) | Image pull | pods-and-lifecycle → imagepullbackoff |
| `Created` then `BackOff` | Container start failed | pods-and-lifecycle → crashloopbackoff |
| `Started` then nothing more | Probes failing | pods-and-lifecycle → probes |

### Image pull stuck

```
Failed to pull image: rpc error: ... unauthorized
```

```bash
# What's the image?
kubectl get pod my-pod -o jsonpath='{.spec.containers[0].image}'

# Are there imagePullSecrets?
kubectl get pod my-pod -o jsonpath='{.spec.imagePullSecrets}'
kubectl get sa default -n <ns> -o jsonpath='{.imagePullSecrets}'

# Test the pull directly on the node
ssh <node>
sudo crictl pull <image>
```

Fix: add `imagePullSecrets` (see pods-and-lifecycle deck), fix the typo'd image, etc.

### Volume mount stuck

```
MountVolume.SetUp failed for volume "data": ...
```

Diagnose:

```bash
# Is the PVC bound?
kubectl get pvc

# If bound, is the volume attached to the right node?
kubectl get volumeattachment

# CSI node plugin pod on the target node running?
NODE=$(kubectl get pod my-pod -o jsonpath='{.spec.nodeName}')
kubectl get pods -A -o wide --field-selector spec.nodeName=$NODE | grep -i csi
```

For PVC issues, see pvc-pending playbook.

### Sandbox creation failed

```
FailedCreatePodSandBox: Failed to create pod sandbox: rpc error: code = Unknown desc =
plugin type="calico" failed (add): ...
```

CNI is the culprit:

```bash
ssh <node>
ls /etc/cni/net.d/             # empty? CNI not deployed.
ls /opt/cni/bin/                # plugins missing?

# CNI agent pod on this node
kubectl get pods -n kube-system -l k8s-app=calico-node \
  --field-selector spec.nodeName=$NODE
```

Investigate the CNI agent's logs.

---

## Path C: Special cases

### Pod waiting on init container

```bash
kubectl describe pod my-pod
# Init Containers:
#   wait-for-db:
#     State:    Waiting
#     Reason:   PodInitializing
#     Last State: Terminated
#       Exit Code: 1

kubectl logs my-pod -c wait-for-db
```

Init container failing means main containers can't start. Read its logs.

### Pod waiting on a sidecar

If you use the modern sidecar pattern (init containers with `restartPolicy: Always`):

```bash
kubectl get pod my-pod -o jsonpath='{.status.initContainerStatuses[*].name}'
```

A sidecar that's not Ready holds main container start. Same debugging as a main container.

### Pod-level admission rejection

If admission control rejected the pod's create, you might not see a Pod object at all (it never got persisted). But for in-place updates:

```bash
# kubectl apply might error like
admission webhook "..." denied the request: ...
```

This isn't really a "Pending" — it's a refusal-to-create. Different problem; check admission controllers / webhooks.

---

## Specific recipes

### Recipe: "Insufficient cpu" / "Insufficient memory"

Three approaches:

```bash
# 1. See what each node has
kubectl describe nodes | grep -A 5 "Allocated resources"

# 2. Lower the pod's requests
kubectl edit deploy <name>
# → spec.template.spec.containers[0].resources.requests.cpu: 100m  (was 1)

# 3. Add nodes (or scale a node group / autoscaler)
```

For exam scenarios, lowering requests is usually the answer.

### Recipe: "had untolerated taint"

Find the offending taint, decide whether to add toleration or remove the taint:

```bash
# Which nodes are tainted with what?
kubectl get nodes -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints'

# Add a toleration to the pod (or its parent Deployment)
kubectl edit deploy <name>
# spec:
#   template:
#     spec:
#       tolerations:
#       - key: node-role.kubernetes.io/control-plane
#         operator: Exists
#         effect: NoSchedule

# Or remove the taint from a specific node
kubectl taint node worker-2 node.kubernetes.io/disk-pressure-
```

For exam: if the question says "this pod must run on the control plane node," add the toleration.

### Recipe: "didn't match Pod's node affinity"

```bash
# Pod's required affinity
kubectl get pod my-pod -o jsonpath='{.spec.affinity.nodeAffinity}'

# Node labels
kubectl get nodes --show-labels
```

Either:

- Make the affinity less strict (change `requiredDuringSchedulingIgnoredDuringExecution` to `preferred`).
- Add the required label to a node:
  ```bash
  kubectl label node worker-1 disktype=ssd
  ```

### Recipe: PVC pending

If pod can't schedule because of "unbound PVC," fix the PVC first. See pvc-pending playbook.

### Recipe: Volume node affinity conflict

```
node(s) had volume node affinity conflict
```

Pod's PVC is bound to a PV in zone A; scheduler is trying to place pod in zone B.

Cause: StorageClass uses `Immediate` binding mode (provisioned in the wrong zone before pod scheduled).

Fix:

- Delete the PVC; recreate with a SC using `WaitForFirstConsumer`.
- Or schedule the pod to zone A (add nodeSelector matching that zone).

### Recipe: hostPort conflict

```
node(s) didn't have free ports
```

Pod uses `hostPort: 80`; another pod on each node is already bound to `:80`.

Fix: don't use hostPort, use a Service with `nodePort` instead.

---

## Long-running Pending pods

After the obvious causes, what about pods Pending for hours?

```bash
# Sort by age
kubectl get pods -A --field-selector=status.phase=Pending \
  -o jsonpath='{range .items[*]}{.metadata.creationTimestamp}{"\t"}{.metadata.namespace}/{.metadata.name}{"\n"}{end}' | sort
```

Common patterns:

- **Stuck in queue**: backoff exhausted, but no event refreshes the cache. `kubectl annotate` to force re-queue:
  ```bash
  kubectl annotate pod my-pod retry-trigger=$(date +%s) --overwrite
  ```
- **Cluster-wide capacity issue**: lots of pods Pending; cluster is full.
- **Quota exceeded**: `kubectl get resourcequota -n <ns>` shows usage; check if Pending pods are blocked by it.
- **PriorityClass effect**: a higher-priority pod is "nominating" this node, blocking lower-priority pods from there.

---

## Diagnostic cheatsheet

```bash
# All Pending pods cluster-wide
kubectl get pods -A --field-selector=status.phase=Pending

# Why Pending? (decision tree starting point)
kubectl describe pod <pod> | sed -n '/Events:/,$p'

# Has it been scheduled?
kubectl get pod <pod> -o jsonpath='{.spec.nodeName}{"\n"}'

# Node capacity
kubectl describe nodes | grep -A 5 "Allocated resources" | head -30

# Taint inspection
kubectl get nodes -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints'

# Recent FailedScheduling events
kubectl get events -A --field-selector reason=FailedScheduling --sort-by=.lastTimestamp | tail

# Scheduling gates
kubectl get pods -A -o json | \
  jq -r '.items[] | select(.spec.schedulingGates // [] | length > 0) |
    "\(.metadata.namespace)/\(.metadata.name): \(.spec.schedulingGates)"'

# Force re-queue
kubectl annotate pod my-pod retry=$(date +%s) --overwrite
```

---

## When the scheduler itself is broken

Rare but happens:

```bash
kubectl get pods -n kube-system -l component=kube-scheduler
# Should show Running. If CrashLoopBackOff or 0 ready:
kubectl logs -n kube-system <kube-scheduler-pod>
```

If scheduler is broken:

- New pods stay Pending forever.
- Existing pods continue running (kubelet is independent).

Fix: the scheduler is a static pod on each CP node. Inspect `/etc/kubernetes/manifests/kube-scheduler.yaml`. Check kubelet's view via `crictl ps --name kube-scheduler`. See control-plane debug paths.

---

## Time budget

For exam pacing on a Pending-pod question:

| Time | Step |
|------|------|
| 0:00 | `kubectl describe pod <pod>` — read the events |
| 0:30 | Identify the reason (Insufficient X / taint / affinity / PVC / etc.) |
| 1:00 | Apply the targeted fix |
| 2:00 | Verify pod is now Running (or proceeds to next state) |

Reading the events first is the fastest path. They contain the precise cause.

---

## Exam heuristics

- Always read `kubectl describe pod`'s Events section first. Scheduler is precise.
- For "untolerated taint," add a toleration matching the taint's exact key/value/effect.
- For "Insufficient X," lower requests if possible (exam usually expects this).
- For "didn't match node affinity," either label nodes or relax the affinity.
- For "ContainerCreating forever," debug differently — that's kubelet-level, not scheduler.

## Mental traps

- Treating Pending as a single problem. It's three different states.
- Editing a Deployment's pod template and not waiting for the rollout. New pod fixes the issue; old pods are unaffected.
- Adding tolerations to fix scheduling without checking whether the taint was deliberate.
- Lowering resource requests below what the app actually needs. Pod schedules but then OOMs / starves.
- Using broad nodeSelector that matches no nodes — pod stays Pending forever silently.
- Ignoring scheduling gates. If `spec.schedulingGates` has entries, no scheduling will happen.
- Forgetting that hostPort conflicts are per-node — adding more replicas just multiplies the failures.
