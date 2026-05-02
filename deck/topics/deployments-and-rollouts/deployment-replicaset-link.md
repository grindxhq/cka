## The chain

```
 Deployment
     │ owns
     ▼
 ReplicaSet (per pod-template revision)
     │ owns
     ▼
 Pod, Pod, Pod, ... (replicas count of them)
```

A Deployment doesn't directly manage Pods. It manages **ReplicaSets**, which manage Pods. Each unique pod template produces a unique ReplicaSet. As you roll updates, old ReplicaSets stick around (scaled to 0 by default) so you can roll back.

This indirection is what makes rolling updates and rollbacks possible. Knowing the chain explains everything else.

---

## What's in a Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels: { app: web }
spec:
  replicas: 3                          # how many Pods total
  selector:
    matchLabels:                        # IMMUTABLE; identifies which RS+Pods belong to me
      app: web
  template:                              # the Pod template
    metadata:
      labels: { app: web }              # MUST match selector
    spec:
      containers:
      - name: web
        image: nginx:1.25
  strategy:
    type: RollingUpdate                 # | Recreate
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 25%
  revisionHistoryLimit: 10              # how many old RS to keep
  progressDeadlineSeconds: 600          # max time for a rollout to make progress
  minReadySeconds: 0                    # how long a Pod must be Ready before counted as available
  paused: false
```

Three sections drive everything:

- **`selector`** — which Pods does this Deployment "own"? Immutable after creation.
- **`replicas`** — how many Pods should exist?
- **`template`** — what should each Pod look like?

The Deployment controller's job: maintain `replicas` Pods that match `selector` and look like `template`.

---

## How the chain forms

When you `kubectl apply -f deployment.yaml`:

```
 1. apiserver creates Deployment object.
 2. Deployment controller (in kube-controller-manager) sees a new Deployment.
 3. It computes a hash of pod template.
 4. It creates a ReplicaSet with name `<deploy-name>-<hash>` (e.g. web-5fd8c9d8f6).
    - RS spec.selector copies Deployment selector + adds `pod-template-hash: <hash>`.
    - RS spec.replicas matches Deployment.
    - RS pod template = Deployment pod template + `pod-template-hash` label injected.
 5. ReplicaSet controller sees the new RS, creates Pods to match replicas.
    - Each Pod gets the `pod-template-hash` label.
    - Pod ownerReferences point to the RS.
```

After steady state:

```bash
kubectl get deploy,rs,pods -l app=web

# Deployment
NAME    READY   UP-TO-DATE   AVAILABLE   AGE
web     3/3     3            3           1m

# ReplicaSet (note the hash suffix in the name)
NAME              DESIRED   CURRENT   READY   AGE
web-5fd8c9d8f6    3         3         3       1m

# Pods (each with pod-template-hash label)
NAME                    READY   STATUS    AGE
web-5fd8c9d8f6-abc12    1/1     Running   1m
web-5fd8c9d8f6-def45    1/1     Running   1m
web-5fd8c9d8f6-ghi78    1/1     Running   1m
```

The hash in the names is `pod-template-hash`, derived from the pod template content. Same template = same hash = same RS.

---

## When the template changes

Edit the Deployment's pod template (e.g. change image to `nginx:1.26`). What happens:

```
 1. Apiserver accepts the Deployment update.
 2. Deployment controller computes new template hash.
 3. New RS created (different hash → different name).
 4. Deployment controller scales:
    - New RS up by 1 (per maxSurge).
    - Old RS down by 1 once new pods are Ready (per maxUnavailable).
    - Repeats until new RS = desired replicas, old RS = 0.
 5. Old RS is NOT deleted. It sits at replicas=0, kept for rollback (up to revisionHistoryLimit).
```

After:

```bash
kubectl get rs -l app=web
# NAME              DESIRED   CURRENT   READY   AGE
# web-5fd8c9d8f6    0         0         0       10m   ← old, scaled down
# web-7c9f4d8a3b    3         3         3       2m    ← new
```

Rollback is just scaling the old RS back up and the new RS down. The history of pod templates is preserved as the chain of (scaled-to-zero) ReplicaSets.

---

## What changes constitute a rollout?

Any change to `spec.template` triggers a new RS:

- Image change.
- Env var change.
- Resource request/limit change.
- Adding a container.
- Annotations on the pod template.
- Volume changes.

Changes that do **NOT** trigger a rollout (handled by Deployment, not RS):

- `spec.replicas` — scaled in place; same RS.
- `spec.strategy` — affects future rollouts, no immediate RS change.
- `spec.minReadySeconds`, `revisionHistoryLimit`, `paused`, `progressDeadlineSeconds` — Deployment-level metadata.

So scaling is cheap (no Pod churn). Template edits are expensive (full rollout).

---

## ownerReferences and adoption

ReplicaSets and Pods carry `ownerReferences` linking them to their parent:

```yaml
# ReplicaSet
metadata:
  name: web-5fd8c9d8f6
  ownerReferences:
  - apiVersion: apps/v1
    kind: Deployment
    name: web
    uid: <Deployment's UID>
    controller: true
    blockOwnerDeletion: true
```

```yaml
# Pod
metadata:
  name: web-5fd8c9d8f6-abc12
  ownerReferences:
  - apiVersion: apps/v1
    kind: ReplicaSet
    name: web-5fd8c9d8f6
    uid: <RS's UID>
    controller: true
    blockOwnerDeletion: true
```

The `controller: true` field marks the **primary** owner — the one whose reconcile loop manages this object. The garbage collector follows the chain to cascade-delete (see controller-manager → garbage-collection deck).

### Adoption

If a Pod exists with the right labels but no ownerReference, the ReplicaSet controller will **adopt** it — set the ownerReference to itself. This is how scaling out picks up Pods that someone manually created with matching labels (rare, but supported).

Conversely, if a Pod has wrong labels (doesn't match RS selector), the RS won't manage it — even if you put the right ownerReference on it manually. The RS's "current" count won't include it.

---

## Replica accounting

Inside the Deployment status:

```yaml
status:
  observedGeneration: 5
  replicas: 3
  updatedReplicas: 3
  readyReplicas: 3
  availableReplicas: 3
  conditions:
  - type: Progressing
    status: "True"
    reason: NewReplicaSetAvailable
  - type: Available
    status: "True"
    reason: MinimumReplicasAvailable
```

Counters explained:

- **`replicas`** — total pods owned by this Deployment (across all RSes that point to it).
- **`updatedReplicas`** — pods using the **current** template (i.e. in the latest RS).
- **`readyReplicas`** — pods passing readiness probes.
- **`availableReplicas`** — pods that have been Ready for at least `minReadySeconds`.

During a rollout:

```yaml
replicas: 4               # 3 desired + 1 surge
updatedReplicas: 1        # only 1 of new RS so far
readyReplicas: 4          # all 4 (old + new) are ready
availableReplicas: 4
```

After rollout completes:

```yaml
replicas: 3
updatedReplicas: 3        # all on new template
readyReplicas: 3
availableReplicas: 3
```

`kubectl rollout status deploy/web` watches these and reports when the rollout is done.

---

## What the Deployment controller actually does

A continuous reconcile loop:

```
On Deployment change or every resync:
  1. Find all RSes owned by this Deployment.
  2. Identify which RS matches the current template (the "new" RS); create it if missing.
  3. Compute target sizes: new RS should have `replicas`; old RSes should have 0.
  4. Apply rolling/Recreate strategy:
     - RollingUpdate: scale new up and old down within maxSurge/maxUnavailable bounds.
     - Recreate: scale all old RSes to 0, then new RS to replicas.
  5. Update Deployment status with progress.
  6. If progress stalls beyond progressDeadlineSeconds: condition Progressing=False.
```

The Deployment controller doesn't create Pods; the ReplicaSet controller does. Deployment just tells RSes what size to be.

---

## ReplicaSet on its own (without a Deployment)

You can create a ReplicaSet directly:

```yaml
apiVersion: apps/v1
kind: ReplicaSet
metadata: { name: web }
spec:
  replicas: 3
  selector:
    matchLabels: { app: web }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
      - { name: web, image: nginx:1.25 }
```

Works — RS will keep 3 Pods. No rolling update support; if you change the template, existing Pods are not updated (you'd have to delete them manually for the RS to recreate).

In practice, almost no one writes ReplicaSets directly. Use Deployments and let them manage the RSes.

The exception: when the rollout abstraction doesn't fit (e.g. you want only some replicas updated for canary testing). Even then, more advanced tools (Argo Rollouts, Flagger) build on top of the same RS primitive.

---

## Inspecting the chain

```bash
# Deployment overview
kubectl get deploy <name>

# ReplicaSets owned by this Deployment
kubectl get rs -l <selector-from-deployment>

# Or by ownerReference (more robust):
kubectl get rs -o json | jq -r --arg deploy <name> \
  '.items[] | select(.metadata.ownerReferences[]?.name==$deploy) | .metadata.name'

# Pods owned by a specific RS
kubectl get pods -l <rs-pod-template-hash>

# Full chain via labels
kubectl get pods --show-labels | grep pod-template-hash

# Hierarchy view (need a tool like 'kubectl tree' from krew)
kubectl tree deployment <name>
```

`kubectl tree` (krew plugin) is excellent for visualizing ownership chains, but standard `kubectl` works fine too.

---

## Common Deployment ↔ RS issues

### Multiple RSes with replicas > 0

A clean Deployment has one RS at `replicas`, others at 0. If you see two RSes with non-zero replicas:

- Rollout is in progress.
- Rollout stalled (new RS can't scale up because new pods don't become Ready).
- Manual intervention scaled an old RS up.

Diagnose:

```bash
kubectl rollout status deploy/<name>
kubectl describe deploy <name>
```

### RS has 0 replicas but old pods still exist

ReplicaSet won't delete pods unless they fail to match its selector. If old pods linger:

- Their pod-template-hash label may have been edited.
- A different RS may still own them.

Check ownerReferences. Usually safest fix: delete the orphan pods manually.

### Deployment shows ready=0 but pods are running

Pods exist but not in the latest RS, so `updatedReplicas` is low. Or pods aren't passing readiness probes (so `readyReplicas` is low even if running).

Look at:

```bash
kubectl get pods -o wide --show-labels   # which RS hash do they have?
kubectl describe pod <pod>                 # readiness probe status
```

### Deployment update doesn't trigger a rollout

If you `kubectl apply` and nothing happens:

- The change is to a Deployment-level field (replicas, strategy) — no RS change needed.
- The change in `template` is one Kubernetes considers semantically equivalent (e.g. you ran kubectl apply with the same spec) — same hash, no new RS.

Force a rollout without changing template content:

```bash
kubectl rollout restart deploy/<name>
# Adds an annotation `kubectl.kubernetes.io/restartedAt: <timestamp>` to the pod template
# → new template hash → new RS → rolling update
```

---

## revisionHistoryLimit

```yaml
spec:
  revisionHistoryLimit: 10        # default
```

How many old RSes (with replicas=0) the Deployment keeps. Garbage collector deletes RSes beyond this count.

For rollback, you can only undo to a revision that's still in history. Setting too low (say 1 or 2) limits how far back you can roll. Setting too high (50+) clutters etcd with stale RSes.

Default 10 is fine for most.

---

## Resource considerations

Each ReplicaSet:

- 1 etcd object.
- A controller watch fan-out.

Each scaled-down RS uses negligible resources but occupies an object slot. With `revisionHistoryLimit: 10` and many Deployments, you can accumulate hundreds of stale RSes. Usually harmless, but worth pruning if you see thousands.

---

## Pod ownership and surprises

Because Pods are owned by RSes, not Deployments directly:

- `kubectl delete pod <pod>` triggers the **RS** to recreate it (not the Deployment).
- `kubectl delete rs <rs>` cascades to its Pods, but the **Deployment** sees the RS gone and creates a new one with the same template hash.
- `kubectl delete deploy <deploy>` cascades to RSes and then Pods (default propagation: background).

For "delete this Deployment but keep its Pods running":

```bash
kubectl delete deploy <name> --cascade=orphan
# Pods continue running, ownerReferences cleared. No controller manages them anymore.
```

---

## Exam heuristics

- The Deployment → RS → Pod chain is the most common workload pattern. Know it cold.
- `kubectl rollout` is the go-to for Deployment lifecycle (status, history, undo, restart, pause, resume).
- `kubectl get rs` shows you the chain in action; useful for understanding rollouts.
- `kubectl rollout restart deploy/<name>` is the cleanest way to "force restart all pods" — it's a normal rollout, not a brutal delete.
- `kubectl scale deploy/<name> --replicas=N` doesn't touch the template; just resizes the current RS.

## Mental traps

- Treating Deployment and ReplicaSet as interchangeable. They're layered.
- Editing a ReplicaSet directly when you should edit the parent Deployment. The Deployment controller will overwrite your changes on next reconcile.
- Expecting `kubectl delete pod` to fully remove a pod managed by a Deployment. The RS recreates it.
- Setting `revisionHistoryLimit: 1` to "save space" and then being unable to roll back beyond one revision.
- Manually creating Pods with labels that match a Deployment selector — the RS will adopt them, and they may have wrong containers or resources.
- Forgetting that scale changes don't roll out. Scale freely; template changes are the expensive ones.
- Confusing the `pod-template-hash` label with something user-supplied. It's auto-generated; don't put it in your selectors.
