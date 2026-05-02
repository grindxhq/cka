## Why GC deserves its own subtopic

"Delete this Deployment and its Pods go with it" feels like it is built into `kubectl delete`. It isn't — it is the **garbage collector controller** inside kube-controller-manager walking an owner-reference graph in etcd and deleting what's no longer rooted. The same machinery explains:

- Why deleting a ReplicaSet kills its Pods but deleting its Pods doesn't kill the ReplicaSet.
- Why objects get stuck in `Terminating` for hours.
- Why you can `--cascade=orphan` a Deployment to keep its Pods alive but unowned.
- Why a bad admission webhook can cause CRDs to be undeletable.

Understanding the pieces makes all of this straightforward.

---

## The three pieces of the GC system

1. **`metadata.ownerReferences`** — the forward pointers from a dependent to its owner(s).
2. **`metadata.finalizers`** — strings that block full deletion until something removes them.
3. The **garbage collector controller** — the GC loop in kube-controller-manager that observes orphans and cleans them up.

Each piece is simple. The interactions are where nuance lives.

---

## 1. ownerReferences — the dependency graph

Every Kubernetes object can have zero or more owner references pointing at other objects. Example from a Pod created by a ReplicaSet:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web-5fd8c9d8f6-abc12
  namespace: default
  ownerReferences:
  - apiVersion: apps/v1
    kind: ReplicaSet
    name: web-5fd8c9d8f6
    uid: a1b2c3d4-...
    controller: true
    blockOwnerDeletion: true
```

Four fields worth knowing:

- `uid`: matched against the referenced owner's `.metadata.uid`. If the owner is deleted and recreated with the same name, the uid changes — old dependents no longer point at the new owner (they are orphans).
- `controller: true`: at most one owner reference per object has this; it marks "the primary controller managing this object." The ReplicaSet controller uses this to know "this Pod is **mine**" vs "this Pod has a reference to me but somebody else is managing it."
- `blockOwnerDeletion: true`: used in **foreground** cascade deletion to block the owner from being removed until this dependent is gone.
- `apiVersion`, `kind`, `name`: humans can read these, but the `uid` is the load-bearing field.

### Cross-namespace rules

Owner references **must** follow two rules:

- A **namespaced** dependent can only reference owners in the **same namespace** (for namespaced owners) or cluster-scoped owners.
- A **cluster-scoped** dependent can only reference **cluster-scoped** owners.

If a dependent has an ownerReference that violates these rules (e.g. a namespaced owner in a different namespace), the reference is treated as invalid — the dependent is considered to have no owner for GC purposes. An event `OwnerRefInvalidNamespace` fires on the dependent.

```bash
kubectl get events -A --field-selector=reason=OwnerRefInvalidNamespace
```

### Multiple owners

An object can have multiple ownerReferences. GC considers it "orphaned" only when **all** of its owners are gone. One still-alive owner is enough to keep it.

---

## 2. Cascade propagation policies

When you delete an object with dependents, you choose how to propagate:

| Policy           | Behaviour                                                                         |
|------------------|-----------------------------------------------------------------------------------|
| **Background**   | Delete owner immediately; GC cleans up dependents asynchronously. This is the default. |
| **Foreground**   | Owner stays in `Terminating` phase until every dependent with `blockOwnerDeletion: true` is gone, then deletes itself. |
| **Orphan**       | Delete owner immediately; GC removes the ownerReference from dependents but leaves them running. |

### Background (default)

```bash
kubectl delete deployment web
kubectl delete deployment web --cascade=background    # explicit
```

Sequence:

```
 t=0    DELETE deployment web           → owner gone
 t=0+   GC sees dependent ReplicaSet has no owner
 t=0+   GC deletes ReplicaSet            → gone
 t=0+   GC sees dependent Pods have no owner
 t=0+   GC deletes Pods                  → gone
```

You see the Deployment vanish immediately. Pods get cleaned up within seconds.

### Foreground

```bash
kubectl delete deployment web --cascade=foreground
```

Sequence:

```
 t=0    PATCH deployment: add finalizer foregroundDeletion + deletionTimestamp
 t=0    Deployment appears in Terminating state
 t=0+   GC identifies dependents with blockOwnerDeletion=true
 t=0+   GC deletes those dependents (foreground on them, too)
 ...    waits until all blocking dependents are gone
 t=N    GC removes foregroundDeletion finalizer
 t=N    Deployment gets deleted
```

The owner is visible in the API throughout — you can watch the shutdown progress. Useful when you need to guarantee dependents are gone before something depending on their absence (e.g. releasing a port, finishing a drain).

### Orphan

```bash
kubectl delete deployment web --cascade=orphan
```

Sequence:

```
 t=0    DELETE deployment web            → owner gone
 t=0+   GC sees dependents still exist; clears their ownerReferences
 t=0+   ReplicaSet and Pods continue running, ownerless
```

Orphan Pods keep running but aren't managed by any controller. They won't self-heal, won't roll with new versions, won't scale. Use when you want to decouple a workload from its controller (rare).

Behind the scenes, `orphan` works via a `orphan` finalizer on the owner, which tells GC "clear references, don't recursively delete."

---

## 3. Finalizers — blockers on deletion

A finalizer is just a **string in `metadata.finalizers`**. Its presence prevents the object from being fully deleted:

```yaml
metadata:
  name: my-pvc
  finalizers:
  - kubernetes.io/pvc-protection
  deletionTimestamp: "2026-04-23T10:00:00Z"
```

When you `DELETE` an object that has finalizers:

1. API server sets `metadata.deletionTimestamp`.
2. Object is now in `Terminating` phase (visible to API, but marked for death).
3. API server **does not** actually remove the object from etcd yet.
4. Something (usually a controller) is expected to:
   - Do its cleanup work.
   - PATCH the object to remove the finalizer string.
5. Once all finalizers are gone and `deletionTimestamp` is set, the object is truly deleted.

### Built-in finalizers you'll encounter

| Finalizer                          | Who adds it               | Purpose                                                     |
|------------------------------------|---------------------------|-------------------------------------------------------------|
| `kubernetes.io/pvc-protection`     | PVC protection controller | Prevents deletion while a Pod is using the PVC              |
| `kubernetes.io/pv-protection`      | PV protection controller  | Prevents deletion of a PV bound to a PVC                    |
| `foregroundDeletion`               | GC controller             | Internal, used to implement foreground cascade              |
| `orphan`                           | GC controller             | Internal, used to implement orphan cascade                  |
| `kubernetes`                       | apiserver                 | Initial finalizer on every Namespace, removed when empty    |

CRDs and operators often add their own finalizers to do cleanup. A CertManager Issuer might add `acme.cert-manager.io/http-solver-finalizer` to clean up challenge resources before letting the Issuer go.

### The `Terminating` state

Anything with `deletionTimestamp` + at least one finalizer is `Terminating`. It is visible, queryable, but cannot be re-used. This is why namespace deletions that get stuck block re-creation of that namespace name indefinitely.

### Stuck Terminating — the recovery flowchart

```
Object stuck in Terminating
│
├── Why? What are its finalizers?
│     kubectl get <kind> <name> -o jsonpath='{.metadata.finalizers}'
│
├── Is there a controller responsible for this finalizer?
│     Usually the controller name appears in the finalizer string.
│     kubectl get pods -n <ns> -l <controller-labels>
│
├── Is that controller running / has RBAC / has logs?
│     Fix the controller.
│
└── If no controller is coming back (CRD was deleted; operator gone):
        Force-remove the finalizer manually:
        kubectl patch <kind> <name> --type=json \
          -p='[{"op":"remove","path":"/metadata/finalizers/0"}]'
```

The `kubectl patch` is the nuclear option. It skips whatever cleanup the finalizer was meant to do, so external resources may leak. Use only when you know what you're removing.

---

## 4. The garbage collector controller — what it does

Inside kube-controller-manager, a goroutine called the **garbage collector** runs these loops:

### The dependency graph builder

- Watches every resource type in the cluster.
- Builds and maintains an in-memory graph: nodes are objects (identified by uid), edges are ownerReferences.
- Updates the graph on every add/update/delete.

### The orphan detector

- Periodically scans the graph for orphans: objects whose owners are gone.
- Enqueues them for deletion.

### The cascade handler

- On receiving a delete event for an owner, walks its dependents.
- For foreground cascades: marks dependents with `blockOwnerDeletion: true` for deletion, keeps the owner in Terminating until they're gone.
- For background: deletes dependents asynchronously.
- For orphan: removes ownerReferences from dependents and moves on.

### The finalizer manager (for its own finalizers)

- Adds `foregroundDeletion` when foreground cascade starts.
- Adds `orphan` when orphan cascade starts.
- Removes them when the respective post-conditions are met.

The GC is "best effort" in one specific sense: it only knows about resource types it can list. If a CRD is not registered with the apiserver (or the discovery API fails), the GC cannot see CRs of that kind. This can lead to owner references that point to nonexistent-but-not-yet-collected objects.

---

## 5. Putting it together — a Deployment delete walk

```
$ kubectl delete deployment web
```

With default background cascade:

```
1. API server accepts DELETE of Deployment web
   - finds no finalizers; deletes the Deployment object immediately.
   - returns to client.

2. GC informer sees Deployment web was deleted.
   - walks its dependency graph:
        ReplicaSet web-5fd8c9d8f6 depends on Deployment web.
   - the dependent is now an orphan.
   - GC enqueues DELETE ReplicaSet web-5fd8c9d8f6.

3. API server accepts DELETE of ReplicaSet web-5fd8c9d8f6.
   - GC then cascades to its dependents: Pods web-5fd8c9d8f6-*.
   - Enqueues DELETE for each Pod.

4. API server deletes the Pods.
   - Pods have `kubernetes.io/pvc-protection` finalizers only if they reference a PVC.
   - Kubelet notices the deletionTimestamp and terminates the containers.
   - Kubelet then updates the Pod status to remove itself.
   - Actually, Pod API deletion is more subtle: the API already deleted, kubelet just cleans up the sandbox.
```

With `--cascade=foreground`:

```
1. API server PATCHes Deployment web: +finalizer foregroundDeletion, +deletionTimestamp.
   Deployment now Terminating.
2. GC marks ReplicaSet for deletion (foreground cascade propagates).
3. Chain continues down: Pods deleted first, then ReplicaSet, then Deployment.
4. At each level, the owner stays Terminating until its blocked dependents are gone.
```

---

## 6. Common failure modes

### Namespace stuck Terminating

Symptom: `kubectl delete ns dev` returns, `kubectl get ns dev` shows `Terminating` forever.

Why: the Namespace controller uses its own finalizer (`kubernetes`) that is only removed when every resource in the namespace is gone. If any resource has its own stuck finalizer, the namespace can't finish deleting.

Diagnose:

```bash
kubectl api-resources --verbs=list --namespaced -o name | \
  xargs -I {} kubectl get {} -n dev --ignore-not-found
```

Expected: empty. If anything shows up (CRs, for instance), that's what's blocking. Address those first.

Last-resort: force-finalize the namespace itself (dangerous, orphans any contents):

```bash
kubectl get ns dev -o json | jq 'del(.spec.finalizers)' | \
  kubectl replace --raw "/api/v1/namespaces/dev/finalize" -f -
```

Only use this when you've verified the contents are actually gone.

### PVC stuck Terminating because Pod still uses it

`kubernetes.io/pvc-protection` finalizer stays on until all Pods referencing the PVC are deleted. If a Pod is also stuck (e.g. DaemonSet that can't drain), the PVC waits.

Fix: delete the Pod first, then the PVC will finish.

### CRD deleted before its CRs

Delete a CRD and all CRs of that kind become "ghosts" — the apiserver refuses to serve them because the schema is gone. You can't kubectl-delete them. The GC can't see them either.

Fix: re-apply the CRD (this reinstates the API group), delete all CRs, then delete the CRD.

### Orphan Pods after Deployment deleted

If you ran `kubectl delete deploy web --cascade=orphan` and regret it, reconnecting Pods to a new Deployment is hard — Deployment selectors would match but ownerReferences are absent. Usually easier to delete the orphan Pods and re-create.

### Webhook rejects the finalizer removal

A validating webhook that blocks PATCH of certain objects can prevent finalizer removal → stuck Terminating. Fix the webhook first.

---

## Diagnostic commands

```bash
# What owns this pod?
kubectl get pod foo -o jsonpath='{.metadata.ownerReferences}'

# Everything owned by a ReplicaSet (via uid match — requires jq)
RS_UID=$(kubectl get rs web -o jsonpath='{.metadata.uid}')
kubectl get pods -o json | \
  jq -r --arg uid "$RS_UID" \
    '.items[] | select(.metadata.ownerReferences[]? | .uid == $uid) | .metadata.name'

# Find stuck Terminating objects cluster-wide
kubectl get all -A -o json | \
  jq -r '.items[] | select(.metadata.deletionTimestamp) |
         [.metadata.namespace, .kind, .metadata.name,
          (.metadata.finalizers | join(","))] | @tsv'

# Objects with finalizers (not necessarily terminating)
kubectl get <kind> <name> -o jsonpath='{.metadata.finalizers}'

# Force-remove a finalizer
kubectl patch <kind> <name> --type=json \
  -p='[{"op":"remove","path":"/metadata/finalizers/0"}]'
```

---

## Exam heuristics

- `--cascade=orphan` is a real flag; know it's the way to drop an owner without killing dependents.
- If a Namespace is stuck Terminating, first find what's left inside. Don't reach for the force-finalize until you're sure.
- `kubectl delete --force --grace-period=0` is orthogonal to cascade — it only affects the grace period for kubelet to tear down containers. It does not bypass finalizers.
- If asked "how does a Deployment clean up Pods when you delete it?" → ownerReferences + GC controller. Not direct code.

## Mental traps

- Believing `kubectl delete` always means "it's gone immediately." With finalizers, it's pending.
- Assuming PDBs block cascade deletion. They don't — PDBs block evictions via the eviction subresource, not direct DELETE.
- Blaming a webhook for stuck deletes without checking `.metadata.finalizers` first.
- Manually removing finalizers on protected resources (PVC-protection, PV-protection) and then wondering why your data disappeared. Those finalizers exist to stop exactly that.
- Forgetting `--cascade=foreground` vs `--cascade=background` semantics. Default is background; foreground is synchronous.
- Thinking `controller: true` matters to GC. It doesn't — it's used by the owning controller to adopt orphans; GC only cares whether **any** owner is alive.
- Trusting that uid-match protects you. If you delete an object and recreate it with the same name, the uid changes, and existing ownerReferences silently stop matching. You'll get orphans.
