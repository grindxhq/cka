## Storage controllers at a glance

A few distinct controllers cooperate to make volumes work:

| Controller                  | Responsibility                                                   |
|-----------------------------|------------------------------------------------------------------|
| PV binder                   | Match PVCs to PVs (static) or trigger dynamic provisioning        |
| PV protection               | Block deletion of in-use PVs and PVCs                             |
| Attach-detach controller    | Attach volumes to nodes, detach when pods leave                   |
| StorageClass-aware provisioner (external) | Create PVs on demand using a CSI driver              |
| Expand controller           | Resize PVCs (and underlying volumes) when supported               |

All except the external CSI provisioner live inside `kube-controller-manager`. The external provisioner runs as its own pod (usually a StatefulSet) per CSI driver.

## The binding flow (one picture)

```
 User creates PVC
         │
         │  if PVC has storageClassName → dynamic path
         │  else                        → static path
         ▼
 ┌────────────────────────────┐
 │   PV BINDER CONTROLLER     │
 └────────────────────────────┘
         │
         │  static: find a PV whose size/access/selector matches
         │  dynamic: create a new PV via the CSI provisioner
         ▼
 PVC status: Bound (references PV)
 PV  status: Bound (references PVC)
         │
         ▼
 Pod with volumes.persistentVolumeClaim schedules
         │
         ▼
 ┌────────────────────────────┐
 │ ATTACH/DETACH CONTROLLER   │  attaches the underlying volume to the node
 └────────────────────────────┘
         │
         ▼
 kubelet mounts the volume into the container
```

Every arrow is a separate controller. When something is stuck, figure out which arrow didn't complete.

## Static vs dynamic provisioning

**Static**: an admin creates PV objects in advance; users create PVCs that the binder matches against them.

- PVC: size, access modes, optional selector, `storageClassName: ""` (empty string explicitly).
- Binder matches by capacity, access modes, storageClassName, and labels.
- First-fit; the "best-fit" heuristic is minimal.

**Dynamic**: the user's PVC names a StorageClass; the binder asks the provisioner to create a PV on demand.

- PVC: size, access modes, `storageClassName: fast`.
- Binder looks up StorageClass → provisioner (e.g. `kubernetes.io/aws-ebs` or a CSI driver like `ebs.csi.aws.com`).
- Provisioner creates the cloud volume and emits a PV. Binder binds.

## Access modes (commonly mis-remembered)

| Mode | Short | Meaning                                                                 |
|------|-------|-------------------------------------------------------------------------|
| ReadWriteOnce | RWO | one **node** can mount read-write (multiple pods on the same node OK)   |
| ReadOnlyMany  | ROX | many nodes mount read-only                                               |
| ReadWriteMany | RWX | many nodes mount read-write (requires shared filesystem: NFS, CephFS)    |
| ReadWriteOncePod | RWOP | one pod total can mount (Kubernetes 1.22+)                            |

Most cloud block storage (EBS, GCE PD, Azure Disk) is RWO only. RWX needs a file-based backend.

## Reclaim policies

On a PV object:

- **Retain** — deleting the PVC leaves the PV in `Released` state with data intact. Admin must manually clean up and recycle or delete.
- **Delete** (default for dynamic) — deleting the PVC deletes the PV and the underlying storage.
- **Recycle** (deprecated) — wipes the volume and puts the PV back to `Available`. Don't use.

For "survive a PVC delete" scenarios, use Retain.

## StorageClass basics

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

Fields to know:

- `volumeBindingMode`:
  - `Immediate` (default): provisioner creates the PV as soon as the PVC is created. Scheduling happens later and may fail if the PV's topology doesn't match any feasible node.
  - `WaitForFirstConsumer`: provisioner waits until a pod is scheduled, then provisions a PV in that pod's zone. Safer for multi-zone clusters.
- `allowVolumeExpansion`: required for `kubectl edit pvc` to succeed on size changes.
- `reclaimPolicy`: default on dynamic PVs.
- `parameters`: driver-specific (type, iops, encryption, etc.).

## PVC lifecycle states

| PVC Phase | Meaning                                       |
|-----------|-----------------------------------------------|
| Pending   | No matching PV found / dynamic provision not done yet |
| Bound     | Linked to a PV (`.spec.volumeName` set)       |
| Lost      | The bound PV was deleted out from under it    |

PVs:

| PV Phase   | Meaning                                       |
|------------|-----------------------------------------------|
| Available  | Not claimed yet                                |
| Bound      | Claimed                                        |
| Released   | Claim deleted, reclaim policy Retain — waiting cleanup |
| Failed     | Automatic reclamation failed                  |

## Attach / detach dance

Once the PVC is bound and a pod is scheduled, the attach-detach controller in `kube-controller-manager`:

1. Attaches the volume to the target node (creates a `VolumeAttachment` object, CSI driver handles the work).
2. Signals kubelet that the volume is attached.
3. kubelet formats (if needed) and mounts.

When the pod ends:

1. kubelet unmounts.
2. Attach-detach detaches from the node.
3. Volume is free to attach elsewhere.

If you see a pod stuck in `ContainerCreating` with "volume attachment timed out":

- Check the `VolumeAttachment` objects: `kubectl get volumeattachment`.
- Check the CSI driver pod logs.
- Confirm the target node is healthy (a NotReady node cannot attach).
- Multi-attach error usually means a RWO volume is still attached to a previous node that didn't clean up.

## Debugging PVC Pending

```bash
kubectl get pvc <name>
kubectl describe pvc <name>     # binder events live here
kubectl get pv
kubectl get storageclass
kubectl describe pv <pv>        # if matched
```

Decision tree:

```
PVC Pending
│
├── storageClassName empty / explicit ""
│     → static binding: no matching PV found
│         • create a PV that matches size + accessModes + SC
│         • or set PVC's storageClassName to a valid SC
│
├── storageClassName set, provisioner missing or broken
│     → kubectl get storageclass <sc>
│     → provisioner pod logs (CSI driver) in kube-system or csi-* ns
│
├── WaitForFirstConsumer mode
│     → PVC is intentionally Pending until a pod is scheduled using it
│     → schedule the pod; watch again
│
├── selector/labels don't match any PV
│     → remove selector or add matching labels on a PV
│
└── capacity too large
      → no PV big enough; shrink the request or create a bigger PV
```

## Volume expansion

Prerequisites:

- StorageClass has `allowVolumeExpansion: true`.
- Driver supports expansion (most CSI drivers do).

Steps:

```bash
kubectl edit pvc <name>
# update .spec.resources.requests.storage to a larger size
```

The expand controller resizes the volume on the backend. Then kubelet performs a filesystem resize when the pod is next scheduled. You do **not** usually need to restart the pod for online-capable backends, but offline-only drivers require a pod restart.

You cannot shrink PVCs. At all.

## Fast commands

```bash
# Look at the pairing
kubectl get pvc,pv

# What nodes have what attachments
kubectl get volumeattachment

# Drill into a specific pvc
kubectl describe pvc <n>

# Check that the CSI driver is healthy
kubectl get pods -A -l app=ebs-csi-controller          # names vary
```

## Exam heuristics

- "PVC is Pending" → nearly always a StorageClass or PV-match problem. Events tell you which.
- To create a static PV, remember to set `accessModes`, `capacity`, `persistentVolumeReclaimPolicy`, and either `hostPath` or a CSI source.
- "Resize a volume" means editing the PVC and waiting for the expand controller. Confirm `allowVolumeExpansion`.
- For "retain on delete" tasks, patch the PV's `persistentVolumeReclaimPolicy` to `Retain` before the PVC is deleted.

## Mental traps

- Forgetting `storageClassName: ""` (explicit empty) is different from unset. Default StorageClass may be picked if unset.
- Creating a PV with a `storageClassName` but a PVC with a different one. They will never bind.
- Over-requesting capacity on PVCs. The binder picks the first PV that is **at least** as large — size mismatches waste capacity, not break binding.
- Assuming PVC size changes scale the bound PV automatically. Expansion is opt-in via the StorageClass.
- Expecting RWO volumes to work across two pods on different nodes. They won't; multi-attach fails.
- Deleting a PV while its PVC still references it. It stays `Terminating` (PV protection). Delete the PVC first.
