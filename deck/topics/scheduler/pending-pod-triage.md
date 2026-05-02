## Pending has exactly three meanings

When a pod is in `Pending`, it means one of:

1. **Not yet assigned a node** — scheduler has not picked one (or cannot).
2. **Assigned, not yet started** — kubelet is pulling the image or creating the sandbox.
3. **Admission or controller never wrote it fully** — rare; shape looks Pending but `spec.nodeName` is empty and events are empty.

Your first decision in triage is figuring out which of these it is. That single branch determines whether you look at the scheduler or the kubelet.

## Branch at the start

```bash
kubectl get pod <name> -o wide
```

Check `NODE`:

- **`<none>`** → scheduler has not bound it. This subtopic applies.
- A node name → **kubelet problem**, not scheduler. Jump to `kubelet` deck or `pods-and-lifecycle`.

Also check the status:

```bash
kubectl get pod <name> -o jsonpath='{.status.conditions}'
```

If `PodScheduled=False`, scheduler rejected it. If `PodScheduled=True` and container conditions are Pending, it is past the scheduler.

## The events-first workflow

```bash
kubectl describe pod <name> | sed -n '/Events:/,$p'
```

Scheduler writes a `FailedScheduling` event with a precise string like:

```
0/5 nodes are available: 2 Insufficient cpu, 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 2 node(s) didn't match Pod's node affinity.
```

Read that string carefully. It tells you exactly how many nodes failed each filter. The debugging plan falls out of it.

## Pending decision tree

```
Pending + NODE = <none>
│
├── Events say "Insufficient <resource>"
│     → go to Requests/Capacity section below
│
├── Events say "untolerated taint"
│     → taints & tolerations
│
├── Events say "didn't match node affinity / selector"
│     → affinity/selector labels
│
├── Events say "didn't match pod affinity / anti-affinity"
│     → co-location rules; check other pods' labels / namespace
│
├── Events say "node(s) were unschedulable"
│     → node has `spec.unschedulable=true` (cordoned)
│
├── Events say "volume node affinity conflict" or "PVC not bound"
│     → storage/topology issue; see storage deck
│
├── Events empty after 30s+
│     → scheduler itself may be down or pod never entered queue
│
└── Events say something about topology spread
      → maxSkew cannot be satisfied; see topology-spread
```

## Insufficient resource

Commands:

```bash
# What does this pod request?
kubectl get pod <name> -o jsonpath='{range .spec.containers[*]}{.name}:{.resources.requests}{"\n"}{end}'

# What does each node have capacity for?
kubectl describe nodes | grep -A 5 "Allocatable"

# Allocated so far per node
kubectl describe nodes | grep -A 5 "Allocated resources"
```

Fast fixes:

- Lower the pod's requests if they are unrealistic.
- Scale the cluster (add a node).
- Evict / remove pods with oversized requests.
- Check for pods with `requests` much larger than actual usage; they are reserving capacity they do not need.

## Untolerated taint

```bash
kubectl describe node <node> | grep -A 3 Taints
kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints
```

Fast fixes (pick by scenario):

- Add a toleration to the pod spec.
- Remove a misplaced taint: `kubectl taint node <node> <key>-` (note the trailing dash).
- Un-cordon a node: `kubectl uncordon <node>`.

The `control-plane` taint is deliberate on control plane nodes; do not remove it unless asked.

## Node affinity / selector mismatch

```bash
kubectl get pod <name> -o jsonpath='{.spec.nodeSelector}'
kubectl get pod <name> -o yaml | grep -A 40 affinity
kubectl get nodes --show-labels
```

Fast fixes:

- Add the required label to a node: `kubectl label node <n> zone=a`.
- Fix the selector / affinity on the pod spec.
- Note that `required` affinity is a filter; `preferred` never causes Pending on its own.

## Pod affinity / anti-affinity mismatch

This is subtler. You need to understand:

- Is there another pod it wants to co-locate with? Does **that** pod exist?
- What `topologyKey` is in play (`kubernetes.io/hostname`, `topology.kubernetes.io/zone`, etc.)?
- Anti-affinity can mean "I cannot schedule because there is already one of me on every matching topology."

```bash
kubectl get pods -A -l <same-labels-the-pod-wants> -o wide
kubectl get nodes --show-labels | grep topology.kubernetes.io/zone
```

Fast fix: relax `required` to `preferred`, widen the topologyKey, or remove the sibling pod that is blocking placement.

## Cordoned / unschedulable

```bash
kubectl get nodes
# NAME          STATUS                     ROLES           ...
# node-1        Ready,SchedulingDisabled   <none>          ...
```

`SchedulingDisabled` = `kubectl cordon` was run. If every remaining node is insufficient, un-cordon one:

```bash
kubectl uncordon <node>
```

## Events are empty

If the pod has been Pending for 30+ seconds and there are no scheduler events at all:

1. Confirm the scheduler is running:
   ```bash
   kubectl get pods -n kube-system -l component=kube-scheduler
   ```
2. If it is missing or crashlooping on a kubeadm cluster, inspect `/etc/kubernetes/manifests/kube-scheduler.yaml` and `crictl logs`.
3. If the scheduler is fine, check whether admission rejected the pod at creation (`kubectl get events --sort-by=.lastTimestamp -A | tail`).
4. If the pod is owned by a controller (Deployment, StatefulSet, DaemonSet), confirm the controller actually created it — the ReplicaSet may be stuck on quota.

## Pending vs ContainerCreating

Commonly confused:

- **Pending, NODE `<none>`** — scheduler issue.
- **Pending, NODE set, STATUS `ContainerCreating`** — kubelet issue. Look at:
  - image pulls (`ImagePullBackOff`)
  - volume mounts (PVC pending, CSI attach)
  - network sandbox (CNI errors)

```bash
kubectl describe pod <name> | sed -n '/Events:/,$p'
crictl ps -a | grep <pod-name>          # on the target node
journalctl -u kubelet | tail -n 100      # on the target node
```

## Exam heuristics

- Always start with `kubectl describe pod` → Events. The scheduler tells you exactly why.
- If the task says "make the pod schedulable," you are allowed to change the pod **or** the nodes. Pick whichever is cheapest.
- If you add tolerations, match the key, effect, and (if applicable) value exactly.
- For taint scenarios, `kubectl taint` both adds and removes; trailing `-` is a remove.
- Affinity YAML is long and error-prone. If you are editing under time pressure, copy from the official docs and adapt.

## Mental traps

- Assuming Pending means "not enough capacity." Taints and affinity are just as common.
- Confusing `requests` with live usage. The scheduler has no idea about real CPU load.
- Forgetting that control plane nodes have a taint. DaemonSets often fail to schedule there until you add the right toleration.
- Forgetting that `required` rules filter and `preferred` rules only score. A pod with only `preferred` rules will never go Pending because of those rules alone.
- Thinking a Pending pod will "unstick" automatically. It re-queues on cluster events, but if nothing changes, nothing changes.
