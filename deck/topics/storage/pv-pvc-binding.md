## Binding — who picks who

A PVC is a request. A PV is an offer. The binder is the matchmaker. This subtopic is how that matching works, where it goes wrong, and the exact fields that decide the outcome.

```
  PersistentVolume                      PersistentVolumeClaim
  (cluster-scoped)                      (namespace-scoped)

  capacity: 50Gi                        resources.requests.storage: 20Gi
  accessModes: [RWO]                    accessModes: [RWO]
  storageClassName: fast                storageClassName: fast
  selector (labels): unset              selector: (optional)
  claimRef: unset (or specific)         volumeName: unset (or specific)
        │                                        │
        └──────────── bound ─────────────────────┘
                         │
                         │ when bound:
                         ▼
        PV.spec.claimRef  = {ns: default, name: app-data}
        PVC.spec.volumeName = pv-xyz
        PVC.status.phase = Bound
        PV.status.phase  = Bound
```

---

## The matching algorithm

When a PVC is created (or becomes eligible):

```
for each PV in cluster:
  if PV is already Bound         → skip
  if PV.storageClassName != PVC.storageClassName  → skip
  if PV.capacity < PVC.resources.requests.storage  → skip
  if PVC.accessModes not a subset of PV.accessModes → skip
  if PVC.selector does not match PV.labels          → skip
  if PVC.volumeName is set and != PV.name           → skip
  if PV has claimRef to a different PVC              → skip
  → candidate found, bind
```

If **no matching PV exists**, the binder checks whether the PVC's `storageClassName` refers to a StorageClass with a **provisioner**:

```
if StorageClass with matching name exists and has a provisioner:
  invoke provisioner to create a new PV
  (→ external-provisioner sidecar calls CreateVolume via CSI)
  new PV appears, binds to PVC
else:
  PVC stays Pending
```

### Selection uses "best fit"

When multiple PVs would match, the binder prefers the **smallest** qualifying PV, to minimize waste. A PVC requesting 10 GiB picks a 10 GiB PV over a 100 GiB one if both match.

### Size matching is one-way

A PVC requesting 10 GiB can bind to a 20 GiB PV (bigger is fine, you get more than you asked). It cannot bind to a 5 GiB PV.

### Access modes are a subset relationship

PVC access modes must be a **subset** of PV access modes. A PV declaring `[RWO, ROX]` (i.e. "I can be either") can satisfy a PVC requesting `[RWO]` or `[ROX]`. A PV declaring `[RWO]` only can't satisfy a PVC requesting `[ROX]`.

In practice most PVs declare one mode (the one the backend actually supports) and PVCs match it.

---

## Static provisioning walkthrough

Admin has pre-created PVs. Users create PVCs that match.

```yaml
---
# PV (usually created once, left to accumulate)
apiVersion: v1
kind: PersistentVolume
metadata:
  name: shared-data-pv
  labels:
    type: nfs
spec:
  capacity:
    storage: 100Gi
  accessModes:
    - ReadWriteMany
  persistentVolumeReclaimPolicy: Retain
  storageClassName: manual     # ← arbitrary name, NOT a real SC
  nfs:
    server: 10.0.0.42
    path: /exports/shared
```

```yaml
---
# PVC (user's request)
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared
  namespace: apps
spec:
  accessModes: [ ReadWriteMany ]
  storageClassName: manual      # must match PV
  resources:
    requests:
      storage: 50Gi
  selector:                      # optional — narrow down
    matchLabels:
      type: nfs
```

Binder matches — PVC binds to `shared-data-pv`.

Key detail: `storageClassName: manual` is just a label; there may or may not be an actual StorageClass object named `manual`. If there isn't, **no dynamic provisioning** happens — the PVC can only bind to an existing PV. That's the point for static setups.

### The empty-string case

```yaml
spec:
  storageClassName: ""         # note the explicit empty string
```

Explicitly empty means "no StorageClass; bind only to PVs that also have empty string." Prevents dynamic provisioning from the default SC. Used when you really want to statically bind to a specific PV.

### The unset case

```yaml
spec:
  # storageClassName not set
```

Missing field means "use the default StorageClass." The mutating admission controller `DefaultStorageClass` fills it in.

Empty-string ≠ unset. One of the subtle traps.

---

## Dynamic provisioning walkthrough

User creates a PVC with a SC that has a provisioner. The system creates the PV.

```yaml
---
# StorageClass (installed by cluster ops / CSI driver)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer

---
# PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
  namespace: default
spec:
  storageClassName: fast-ssd
  accessModes: [ ReadWriteOnce ]
  resources:
    requests:
      storage: 20Gi
```

Timeline:

1. PVC created → Pending.
2. `external-provisioner` sees PVC, matches SC `fast-ssd` (it owns `ebs.csi.aws.com`).
3. For **WaitForFirstConsumer** SC, provisioning waits until a pod using this PVC is scheduled. PVC stays Pending.
4. Pod scheduled to node in zone `us-east-1a`.
5. Provisioner calls `CreateVolume` via CSI, zone-anchored to `us-east-1a` (from the node's topology).
6. EBS volume created → PV object auto-generated.
7. PV binds to PVC. Both go Bound.
8. Attach-detach controller creates a `VolumeAttachment`.
9. Attach sidecar calls `ControllerPublishVolume` → EBS attached to node.
10. kubelet calls node-level CSI RPCs, mounts into pod.

For **Immediate** bindingMode, step 3-6 happens at step 1; the pod waits for the PVC to bind first.

### Who creates the PV?

In dynamic provisioning, **you do not write the PV YAML yourself**. The provisioner creates it. The PV will have:

- `spec.persistentVolumeReclaimPolicy` copied from the SC.
- `spec.accessModes` from the PVC's request.
- `spec.capacity` from the PVC's request (or possibly rounded up by the driver).
- `spec.csi.driver` set to the CSI driver name.
- `spec.csi.volumeHandle` — the driver's internal ID for the volume.
- `metadata.annotations` — driver-specific metadata (e.g. `pv.kubernetes.io/provisioned-by`).

You can `kubectl get pv` to see the generated PV and its details.

---

## The Bound state — what it means

Once bound, both objects have mutual references:

```yaml
# PV (simplified)
spec:
  claimRef:
    apiVersion: v1
    kind: PersistentVolumeClaim
    namespace: default
    name: app-data
    uid: 5a7c-... (the PVC's UID at binding time)
```

```yaml
# PVC
spec:
  volumeName: pvc-abc123
```

The UID in `claimRef` matters: if the PVC is deleted and recreated with the same name, the new PVC has a different UID and doesn't match this PV's `claimRef`. The PV stays `Released`.

### "Stuck bound" — when reclaim is needed

After PVC deletion with `Retain` policy:

- PVC is gone.
- PV transitions to `Released`.
- PV's `claimRef` still has the old UID.
- No new PVC can bind to this PV automatically (uid mismatch).

To reuse the PV: clear the `claimRef`:

```bash
kubectl patch pv <pv-name> --type=merge -p '{"spec":{"claimRef":null}}'
# PV transitions: Released → Available
```

Now a fresh PVC can bind.

---

## Pre-binding — PVC targets a specific PV

You can name the PV explicitly in the PVC:

```yaml
spec:
  volumeName: shared-data-pv
  storageClassName: manual
  ...
```

This locks the PVC to that specific PV. Other PVCs in the match set are ignored for this PVC. Useful when:

- You have multiple identical PVs and want deterministic binding.
- You want a PVC to "adopt" a specific Retained PV.

Caveat: the PV's `claimRef` must also point at this PVC (or be empty) for binding to proceed.

Reverse path — PV pre-bound to a PVC:

```yaml
# PV
spec:
  claimRef:
    namespace: default
    name: my-app-data
```

The binder will only bind this PV to a PVC named `my-app-data` in `default`. Prevents a foreign PVC from grabbing it.

---

## PVC lifecycle states

| Phase        | What it means                                                          |
|--------------|------------------------------------------------------------------------|
| `Pending`    | Waiting for binding (no matching PV or provisioner not yet acted)     |
| `Bound`      | Linked to a PV (`.spec.volumeName` set)                                |
| `Lost`       | Bound PV was deleted; data is gone                                    |

Bound is the normal steady state. Lost is rare but happens if:

- A PV was force-deleted outside of normal flow.
- A Retain-policy PV was cleaned up by admin and the PVC wasn't.

---

## PV lifecycle states

| Phase        | What it means                                             |
|--------------|-----------------------------------------------------------|
| `Available`  | Free, no PVC bound                                         |
| `Bound`      | Claimed by a PVC                                           |
| `Released`   | PVC deleted; PV awaiting reclaim action                    |
| `Failed`     | Automatic reclaim failed                                  |

Transitions:

```
  Available  →  Bound      (PVC claims)
  Bound      →  Released   (PVC deleted, reclaim=Retain)
  Bound      →  (gone)     (PVC deleted, reclaim=Delete)
  Released   →  Available  (admin clears claimRef or reclaim completes)
  Any        →  Failed     (automatic reclaim failed; manual fix required)
```

---

## Finalizers — why deletion isn't instant

Both objects carry protection finalizers:

```yaml
# PVC
metadata:
  finalizers:
  - kubernetes.io/pvc-protection

# PV
metadata:
  finalizers:
  - kubernetes.io/pv-protection
```

The controllers that add these:

- **pvc-protection** is added to a PVC as long as any Pod uses it. Delete the PVC → it enters Terminating → only when all pods referencing it are gone does the finalizer release.
- **pv-protection** is added to a PV as long as it's bound. Delete the PV → it enters Terminating → only when PVC is gone and reclaim runs does the finalizer release.

This prevents accidental data loss. If you `kubectl delete pvc` while a pod is still running with the volume mounted, the PVC stays Terminating until the pod exits.

### Force-removing a finalizer

Sometimes (rarely) things hang. The nuclear option:

```bash
kubectl patch pvc <name> -p '{"metadata":{"finalizers":null}}' --type=merge
```

Dangerous — skips the protections. Use only when you've confirmed nothing references the PVC anymore.

---

## Inspecting what happened

```bash
# All PVCs, seeing binding status
kubectl get pvc -A
# NAMESPACE  NAME        STATUS   VOLUME         CAPACITY  ACCESS MODES  STORAGECLASS
# default    app-data    Bound    pvc-abc123     20Gi       RWO            fast-ssd

# Full PVC detail (including events)
kubectl describe pvc app-data

# The PV it bound to
kubectl describe pv pvc-abc123

# All PVs
kubectl get pv
# NAME        CAPACITY  ACCESS MODES  RECLAIM POLICY  STATUS      CLAIM            STORAGECLASS
# pvc-abc123  20Gi       RWO           Delete          Bound       default/app-data fast-ssd

# VolumeAttachment (for CSI attach state)
kubectl get volumeattachment

# Events (very useful for debugging binding issues)
kubectl get events -A --field-selector reason=ProvisioningSucceeded
kubectl get events -A --field-selector reason=ProvisioningFailed
```

---

## Common binding failures

| Symptom                                                      | Likely cause                                               |
|--------------------------------------------------------------|------------------------------------------------------------|
| PVC stays Pending indefinitely                                | No matching SC; SC has no provisioner; provisioner down    |
| PVC Pending with `storageclass.kubernetes.io/is-default-class`| No default SC configured, PVC has no storageClassName     |
| PVC Pending, events say "provisioning failed"                 | CSI driver error; check external-provisioner logs         |
| PVC Bound to wrong PV                                         | Too-broad selectors let a different PV match               |
| PV stuck Released                                             | `claimRef` still set; clear to release                     |
| PVC stuck Terminating                                         | Pod still references it; delete the pod first             |
| PV stuck Terminating                                          | PVC not yet fully deleted                                  |
| `volume attachment failed`                                    | CSI node plugin issue on the target node                   |
| `MountVolume.SetUp failed`                                    | NodePublishVolume failed; check CSI node plugin            |

Systematic triage for PVC Pending is its own subtopic ("PVC Pending Triage").

---

## Exam heuristics

- For exam scenarios "create a PV and PVC and make them bind," use `hostPath` for the PV and match `storageClassName` (often `manual` or `""`). Keep size and accessModes identical.
- When asked "bind this PVC to this specific PV," set `pvc.spec.volumeName: <pv-name>`.
- `storageClassName: ""` (explicit) prevents default SC injection. `storageClassName` unset uses the default SC.
- `kubectl get pvc,pv` in one command shows both sides quickly.
- If a PV is stuck `Released` and you want to reuse it, patch out `spec.claimRef`.

## Mental traps

- Confusing empty-string `storageClassName` with missing. Empty means "no SC"; missing means "default SC."
- Expecting a PVC to bind across namespaces. PVCs are namespace-scoped; they bind to PVs (cluster-scoped), but the PV's `claimRef` (once bound) includes the PVC's namespace.
- Assuming a 20 GiB PV can satisfy a 10 GiB PVC and "give back" the 10 GiB. It doesn't — the full 20 GiB is allocated to the binding.
- Thinking bound PVs can be re-used for other PVCs. Binding is exclusive until release.
- Patching a Retained PV's claimRef while it's still bound (the binding breaks). Only do this for Released PVs.
- Deleting a PVC expecting the PV to free up immediately. Reclaim runs async; the PV goes Released, and for `Retain`, stays there until admin action.
- Treating `pvc-protection` finalizer removal as routine. It's a safety mechanism; removing it forcibly can orphan the PV or lose data.
