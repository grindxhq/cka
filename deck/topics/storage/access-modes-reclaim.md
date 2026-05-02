## Two fields, two worlds

`accessModes` and `persistentVolumeReclaimPolicy` are simple fields. Together they decide:

- **Who** can mount the volume and how many (access modes).
- **What happens** when the PVC is deleted (reclaim).

Both are easy to misconfigure in ways that only surface later (when a second pod can't mount, or when valuable data gets auto-deleted). This note covers every flavor.

---

## Access modes — the abstraction

| Mode                  | Short | Meaning                                                    |
|-----------------------|-------|------------------------------------------------------------|
| `ReadWriteOnce`       | RWO   | Mounted read-write by **one node** (multiple pods on that node are OK) |
| `ReadOnlyMany`        | ROX   | Mounted read-only by **many nodes**                         |
| `ReadWriteMany`       | RWX   | Mounted read-write by **many nodes**                        |
| `ReadWriteOncePod`    | RWOP  | Mounted read-write by **exactly one pod** (1.22+)           |

The scope words matter: "one node" means one Linux host. Multiple pods on the same node can share an RWO volume — it's not a per-pod lock.

### What the backend actually supports

Kubernetes API accepts any combination; the real limit is the backend storage. Rough guide:

| Backend                        | RWO | ROX | RWX | RWOP |
|--------------------------------|:---:|:---:|:---:|:----:|
| AWS EBS                        |  ✅  |  ❌  |  ❌  |  ✅   |
| GCE Persistent Disk            |  ✅  |  ❌  |  ❌  |  ✅   |
| Azure Disk                     |  ✅  |  ❌  |  ❌  |  ✅   |
| Azure Files                    |  ✅  |  ✅  |  ✅  |  ✅   |
| NFS                            |  ✅  |  ✅  |  ✅  |  ✅   |
| CephFS                         |  ✅  |  ✅  |  ✅  |  ✅   |
| Ceph RBD                       |  ✅  |  ✅  |  ❌  |  ✅   |
| Local / hostPath               |  ✅  |  ❌  |  ❌  |  ✅   |
| AWS EFS                        |  ✅  |  ✅  |  ✅  |  ✅   |

Block storage (EBS, GCE PD, Azure Disk, RBD, local) is single-node by design — the block device attaches to one node at a time. Network filesystems (NFS, EFS, Azure Files, CephFS) are multi-node native.

Ask: "is your backend a single-writer block device or a shared filesystem?" That answers what access modes make sense.

---

## ReadWriteOnce in depth

RWO means the volume is attached to **one node**. Multiple pods on that node can mount it simultaneously (share a filesystem), but across nodes, only one.

### The multi-pod-on-one-node case

Two pods on the same node can share an RWO PVC. Common pattern: a sidecar and a main container in one pod (trivially sharing). Less common but supported: two pods on the same node if scheduled that way.

### The rolling-update trap

When a StatefulSet or Deployment rolls an RWO-backed pod, the new pod can't start until the old pod (and its attached volume) has released. If the scheduler tries to place the new pod on a different node:

```
 t=0  Old pod on node-1, EBS attached to node-1.
 t=1  kubectl rollout: new pod scheduled to node-2.
 t=2  Old pod terminating but volume still attached to node-1.
 t=3  New pod tries to mount; EBS can't detach from node-1 yet → "multi-attach error"
 t=4  Old pod terminates, volume detaches from node-1.
 t=5  Attach-detach controller attaches to node-2.
 t=6  New pod mounts, starts.
```

Rolling update takes longer than you'd think because of the attach/detach. StatefulSets handle this gracefully. Deployments with `strategy: Recreate` are safer for RWO volumes than the default `RollingUpdate`.

### RWOP — tighter than RWO

`ReadWriteOncePod` (added in 1.22) tightens RWO to "exactly one pod" — not one node. Two pods on the same node cannot both mount it.

Use case: preventing accidental concurrent access during weird scheduling cases (pod stuck terminating while new pod starts on same node).

Requirements: CSI driver must advertise support. Most block drivers do.

---

## ReadWriteMany — the shared case

RWX is for "many pods on many nodes can write at once." Fundamentally requires a shared filesystem — you can't have two EBS attachments to different nodes writing to the same block device safely.

Typical RWX backends:

- **NFS** — easy, widely available, has NFS semantics.
- **AWS EFS** — managed NFS on AWS.
- **Azure Files** — managed SMB/NFS on Azure.
- **CephFS / GlusterFS** — distributed filesystems.
- **JuiceFS, Longhorn RWX** — newer managed options.

### Coordination is your problem

Kubernetes gives you "many nodes, one filesystem." It doesn't prevent two writers from corrupting each other's data. Applications using RWX must:

- Use file-level locking (flock) if they coordinate.
- Use different directories per writer.
- Be explicitly multi-writer-safe (as some databases are).

A naïve app writing to a shared file concurrently will corrupt data regardless of RWX being "allowed."

### RWX performance

Network filesystems are not like local disks. Expect:

- Higher latency per operation.
- Lower IOPS than local SSD.
- Failure modes based on the NFS/SMB protocol (stale file handles, timeouts).

For databases, prefer RWO block storage with one writer. Save RWX for workloads that genuinely need shared state (build caches, static content).

---

## ReadOnlyMany — uncommon but exists

ROX is "many nodes, read-only." Uses:

- Pre-loaded datasets mounted into many pods.
- Shared static assets.
- Test fixtures.

Most backends that support ROX also support RWX; the distinction is less useful than you'd think. Often a single PV declares `[RWO, ROX]`, letting different pods mount it in different modes.

In practice, for read-only sharing, many teams use ConfigMaps (for small data) or an init container that downloads to an emptyDir (for per-pod copies). ROX is rarely the right answer.

---

## Declaring access modes

On the PV:

```yaml
spec:
  accessModes:
    - ReadWriteOnce
    - ReadOnlyMany     # PV says "I can do either"
```

On the PVC:

```yaml
spec:
  accessModes:
    - ReadWriteOnce    # PVC says "I want RWO"
```

Binding succeeds if the PVC's modes are a **subset** of the PV's modes. The **intersection** is what the PV is actually used for at this binding (enforced by the driver).

Most PVs declare one mode (the one they actually support). Some backends declare multiple.

### What if PVC asks for a mode the PV doesn't support?

Binding fails. PVC stays Pending with an event:

```
Normal  FailedBinding   persistentvolume-controller  no persistent volumes available for this claim
```

If dynamic provisioning, the provisioner refuses because it can't produce a PV with the requested modes. Event on the PVC logs this.

---

## Reclaim policies — what happens on delete

Three policies, only two still usable:

| Policy    | When PVC is deleted                                     | Default when        |
|-----------|---------------------------------------------------------|---------------------|
| `Delete`  | PV deleted, backing storage deleted. Data gone.         | dynamic provisioning |
| `Retain`  | PV → Released, backing storage preserved. Manual cleanup| static provisioning  |
| `Recycle` | (deprecated, removed)                                   | never use            |

The reclaim policy lives on the **PV**, not the PVC:

```yaml
apiVersion: v1
kind: PersistentVolume
spec:
  persistentVolumeReclaimPolicy: Retain
```

For dynamically provisioned PVs, the policy is inherited from the SC's `reclaimPolicy` field. You can edit the PV's policy after creation.

---

## Retain — data safety first

```yaml
persistentVolumeReclaimPolicy: Retain
```

When PVC is deleted:

```
 PVC (deleted) → gone
 PV → status: Released
 PV.spec.claimRef still contains the old PVC's UID
 Backing storage: fully intact
```

The PV sits in `Released` until an admin:

1. Manually backs up / copies the data elsewhere.
2. Clears `spec.claimRef` to return the PV to `Available`:
   ```bash
   kubectl patch pv <pv-name> --type=merge -p '{"spec":{"claimRef":null}}'
   ```
3. Or deletes the PV (which, with Retain, does not delete the backing storage).

This is the safe choice for any data that matters. Used for:

- Statefully-bound data that outlives its consumers.
- Shared datasets.
- Anything where "oops I deleted the PVC" should not mean data loss.

### The orphan problem

With Retain, deleted PVCs leave Released PVs and orphaned cloud volumes. Over months, you accumulate unused volumes costing real money. Establish a cleanup process: list Released PVs, verify they're truly abandoned, delete them (and the backing storage).

```bash
kubectl get pv --field-selector=status.phase=Released
```

---

## Delete — clean up automatically

```yaml
persistentVolumeReclaimPolicy: Delete
```

When PVC is deleted:

```
 PVC (deleted) → gone
 PV → Reclaim process starts:
   - external-provisioner sidecar calls DeleteVolume on the CSI driver.
   - Driver deletes the cloud volume.
   - PV object deleted.
```

Efficient and automatic. Default for dynamically provisioned PVs.

### The risk

Someone runs `kubectl delete pvc my-important-data`. The PV's Delete policy kicks in. The EBS volume is deleted. The data is gone. No recovery unless you had snapshots.

Mitigations:

- Use `Retain` for production data.
- Use snapshots (VolumeSnapshot) for versioned backups.
- Use RBAC to restrict `delete pvc` in production namespaces.
- Respect the `pvc-protection` finalizer — it blocks delete while pods use the PVC, which is one level of safety.

---

## Changing a PV's reclaim policy

You can edit the policy on an existing PV:

```bash
kubectl patch pv <pv-name> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

Useful when you inherit a cluster where Delete was the default and you want to flip a specific PV to Retain before deleting the PVC.

Note: you can also edit the SC's default for future PVs, but existing PVs are not affected.

---

## Inheritance rules

Where does a PV's reclaim policy come from?

- **Dynamic provisioning**: inherits from `StorageClass.reclaimPolicy`. Default is Delete if not specified on SC.
- **Static PV (you wrote the YAML)**: whatever you put in `spec.persistentVolumeReclaimPolicy`. Default is Retain if not specified.

So a static PV with no explicit policy defaults to Retain (safer default for hand-written YAML). A dynamically provisioned PV from a stock SC defaults to Delete (safer default for ephemeral cloud volumes).

---

## The Released state — what it really means

A PV in `Released` state:

- Is **not** bindable by new PVCs (the `claimRef` with old UID prevents it).
- Is **not** automatically cleaned up (that's what Delete would do; Retain explicitly avoids it).
- Can be manually returned to Available by clearing `claimRef`.

From `Available` it can bind again (to a new PVC of matching requirements), or be deleted (which with Retain just removes the PV object but preserves the backing storage).

Mental model: `Released` = "waiting for admin to decide."

---

## The Failed state

Rare. Happens when automatic reclaim couldn't complete — typically on Delete policies where the CSI driver refused to delete (permissions, already-deleted, network error).

Recovery:

1. Investigate the error: `kubectl describe pv <pv-name>`, provisioner logs.
2. If the underlying volume is actually already gone (driver error, race): clear finalizers on the PV to remove it.
3. Otherwise: fix the underlying issue (IAM credentials, network), the controller will retry.

---

## Patterns

### The safe production default

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: production
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
reclaimPolicy: Retain            # preserve data on PVC delete
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

Establish a backup + cleanup process alongside.

### The ephemeral throwaway

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: scratch
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
reclaimPolicy: Delete           # auto-delete
volumeBindingMode: WaitForFirstConsumer
```

For caches, CI pipelines, anything where the data doesn't matter after the PVC is gone.

### The shared production

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: shared-nfs
provisioner: nfs.csi.k8s.io
parameters:
  server: 10.0.0.42
  share: /exports/k8s
reclaimPolicy: Retain
# NFS supports RWX naturally; allow any mode
```

---

## Common failure modes

| Symptom                                      | Cause                                                 |
|----------------------------------------------|-------------------------------------------------------|
| "multi-attach error: volume is already used" | RWO volume trying to attach to a second node while first node still has it |
| PVC Pending, PV declares ROX only             | PVC wants RWO; PV can't be exclusive-write            |
| PV stuck `Released` after PVC delete          | `Retain` policy; admin must clear `claimRef`          |
| Data disappears after PVC delete              | `Delete` policy, no backup                            |
| PV refuses to delete                          | `pv-protection` finalizer; PVC still exists           |
| PVC delete blocks                             | `pvc-protection` finalizer; pod still mounts it       |
| Pod stuck in `ContainerCreating` after rolling update | RWO attach-detach dance from old node to new node |

---

## Exam heuristics

- Exam scenarios with RWO + StatefulSet are normal; pay attention to scheduling (which node gets the attached volume).
- For "shared across multiple pods" scenarios, use RWX (and usually NFS or similar).
- For data-preservation exam questions, switch the PV's reclaim policy to Retain before deleting the PVC.
- `kubectl patch pv <name> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'` is a common exam step.
- Remember: `kubectl delete pvc` cascades to PV only if reclaim policy is Delete.

## Mental traps

- Thinking RWO = "one pod." It's one node. Multi-pod on same node works.
- Expecting RWX to prevent data corruption. It doesn't — apps still need locking.
- Setting `persistentVolumeReclaimPolicy: Delete` on PVs holding important data. One bad delete = data loss.
- Forgetting to clear `claimRef` when reusing a Retained PV. It stays Released forever.
- Believing `Delete` is safe because the `pvc-protection` finalizer blocks delete while pods run. The finalizer only blocks **PVC** delete while mounted; it doesn't prevent someone from deleting after pods are gone.
- Setting RWX on a block-storage-backed PV. Backend refuses; PV stays Pending or pods fail to mount.
- Deleting a PV with `Retain` and expecting the backing volume to also disappear. It doesn't — Retain means the PV object goes but the real storage remains. You have an orphaned cloud volume.
- Confusing pod's `volumeMounts.readOnly: true` with the PV's access modes. `volumeMounts.readOnly` is per-container mount semantics; access modes are how the volume was attached.
