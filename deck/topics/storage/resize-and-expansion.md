## The promise and the gotchas

Kubernetes supports expanding a PVC after creation. "Change the number, a while later your volume is larger." In practice there are many moving parts: the StorageClass has to allow it, the CSI driver has to support it, the filesystem has to support live resize (or require a pod restart), and the order of operations matters.

This note walks the full flow and every place it can stall.

---

## The short version

```
 PVC requests 10Gi  →  pod mounts, uses it.
 User edits PVC.resources.requests.storage = 50Gi.
 external-resizer sidecar sees the change.
 external-resizer calls ControllerExpandVolume on CSI driver → backend volume grows.
 PV.spec.capacity updates to 50Gi.
 (if online resize)  kubelet calls NodeExpandVolume → filesystem resizes live.
 (if offline resize) Condition FileSystemResizePending stays true until pod restarts.
 PVC.status.capacity updates to 50Gi.
```

Two axes of what can vary:

- **Online vs offline** filesystem resize: live or requires pod restart.
- **Controller-side vs node-side** work: bigger volume, bigger filesystem, different components.

---

## Prerequisite: `allowVolumeExpansion: true`

The StorageClass must opt in:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: expandable
provisioner: ebs.csi.aws.com
allowVolumeExpansion: true        # ← required
```

Without this, the API **rejects** PVC edits that increase size. Error:

```
The PersistentVolumeClaim "my-pvc" is invalid: spec.resources.requests:
  Forbidden: field is immutable after creation
```

You can edit an existing SC to add the flag, but **existing PVCs' behavior only changes for future resize requests**. Already-provisioned PVCs won't magically become resizable unless their SC now has the flag.

Check current state:

```bash
kubectl get sc <name> -o jsonpath='{.allowVolumeExpansion}'
```

### CSI driver capability

Even with `allowVolumeExpansion: true`, the underlying CSI driver has to advertise expansion support:

```bash
kubectl get csidriver <driver> -o yaml | grep volumeLifecycleModes -A 5
# and check the driver's own CSIDriver object for EXPAND_VOLUME capability
```

Most modern cloud drivers (AWS EBS, GCE PD, Azure Disk) support expansion. Some older / niche drivers don't.

---

## Triggering a resize

Edit the PVC:

```bash
kubectl edit pvc my-pvc
# change spec.resources.requests.storage from 10Gi to 50Gi
```

Or patch:

```bash
kubectl patch pvc my-pvc -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'
```

The API accepts the change (assuming SC allows it). This initiates the resize — no need to restart or reapply anything.

**You cannot shrink.** A request to reduce size is rejected:

```
The PersistentVolumeClaim "my-pvc" is invalid: spec.resources.requests.storage:
  Forbidden: field can not be less than previous value
```

Kubernetes has no "shrink" path. Shrinking requires dump-and-restore manual work.

---

## What happens inside the cluster

### Step 1 — Request recorded

Edit lands in etcd. PVC now has:

```yaml
spec:
  resources:
    requests:
      storage: 50Gi         # new requested size
status:
  capacity:
    storage: 10Gi           # current actual size
  conditions:
  - type: Resizing
    status: "True"
```

### Step 2 — Controller expansion

The `external-resizer` CSI sidecar (runs alongside the driver's controller plugin) watches PVCs with size changes:

```
external-resizer sees PVC size=50Gi, status capacity=10Gi
→ calls ControllerExpandVolume(volumeID, 50Gi) on the CSI driver
→ driver grows the backend volume (EBS modify-volume, GCE disks resize, etc.)
→ driver returns (newSize, needsNodeResize: true|false)
```

The `needsNodeResize` flag decides the next step. If the backend resize includes the filesystem, `false` — we're done. If only the block device grew but the FS hasn't, `true` — we need a node-side resize.

EBS returns `true` for filesystem resize. NFS returns `false` — there's no block device.

### Step 3 — PV capacity updates

`external-resizer` patches the PV:

```yaml
spec:
  capacity:
    storage: 50Gi
```

The backing storage is now bigger, but the pod still sees 10Gi because the filesystem on disk hasn't grown.

### Step 4 — Filesystem resize (node-side, if needed)

If `needsNodeResize: true`, the PVC is marked with `FileSystemResizePending: True`:

```yaml
status:
  conditions:
  - type: FileSystemResizePending
    status: "True"
```

kubelet on the pod's node sees this, calls `NodeExpandVolume` on the CSI node plugin → the driver grows the filesystem (ext4 resize2fs, xfs_growfs, etc.).

For **online-expansion-capable** filesystems (ext4, xfs on most drivers), this happens **while the pod runs**. No restart. Status clears; `status.capacity: 50Gi`; done.

For **offline-only** filesystems, it waits until the pod is **restarted** (pod deletion, or Deployment rollout). On next start, NodeExpandVolume runs during mount; filesystem grows.

### Step 5 — Done

PVC status eventually shows:

```yaml
status:
  capacity:
    storage: 50Gi
  # conditions cleared
```

If a pod is using it, the app may need to be told that its filesystem is bigger (database tools might need `ALTER TABLESPACE`, but the filesystem itself is resized).

---

## Online vs offline expansion

Modern cloud block drivers (EBS, GCE PD, Azure Disk) support online expansion for ext4 and xfs filesystems on recent kernels. Pod runs, filesystem grows, no interruption.

Older drivers or unusual filesystems require offline expansion:

- Pod must stop.
- On restart, kubelet performs NodeExpandVolume as part of mount.
- Pod starts seeing the larger filesystem.

Check your driver's documentation. Most modern setups are online.

### Forcing the offline path

If you have an offline driver (or the online resize failed):

```bash
# Scale to 0 and back
kubectl scale statefulset my-sts --replicas=0
kubectl scale statefulset my-sts --replicas=3

# Or: delete the specific pod (StatefulSet will recreate)
kubectl delete pod my-sts-0
```

Pod restart triggers NodeExpandVolume during mount.

---

## Inspecting expansion state

```bash
# PVC status including conditions
kubectl describe pvc my-pvc

# Key fields to read:
#   Capacity:  50Gi                    ← eventually matches request
#   Conditions:
#     Type                      Status
#     Resizing                  True   ← expansion in progress
#     FileSystemResizePending   True   ← waiting for filesystem resize

# The PV should also show updated capacity
kubectl get pv <pv-name> -o jsonpath='{.spec.capacity.storage}'

# Events — useful for errors
kubectl describe pvc my-pvc | grep -A 20 Events
```

---

## Common failure modes

### `allowVolumeExpansion: false`

Edit request is rejected by admission:

```
forbidden: field is immutable after creation
```

Fix: edit the SC, add `allowVolumeExpansion: true`. Then retry the resize.

### `external-resizer` not running

If the CSI driver's controller deployment doesn't have the `external-resizer` sidecar, nothing picks up the PVC edit. PVC stays in the resizing condition forever.

```bash
# Which CSI drivers advertise expansion?
kubectl get csidrivers -o json | jq '.items[] | {name: .metadata.name, expand: .spec.volumeLifecycleModes}'

# Controller pod — does it have the resizer sidecar?
kubectl get pods -n <driver-ns> <controller-pod> -o jsonpath='{.spec.containers[*].name}'
# Look for `csi-resizer` among the container names
```

### Driver returns error

Common backend errors:

- AWS EBS: can't resize within 6-hour window of last modification (`VolumeModificationRateExceeded`).
- Quota exceeded in the cloud account.
- Volume type doesn't support resize (rare for gp2/gp3; some old types).

```bash
kubectl logs -n <driver-ns> <controller-pod> -c csi-resizer --tail=100
```

### `FileSystemResizePending` stays true forever

Driver reported `needsNodeResize: true` but kubelet on the pod's node isn't running the NodeExpandVolume. Causes:

- Pod is on a node where the CSI node plugin is crashing.
- Offline-only driver; need pod restart.
- Filesystem type not supported for online resize by this driver version.

```bash
# CSI node plugin on the affected node
kubectl get pods -n <driver-ns> -l app=<node-plugin> -o wide --field-selector spec.nodeName=<node>
kubectl logs -n <driver-ns> <node-plugin-pod>
```

### Shrink attempt

Silent trap — Kubernetes refuses to shrink. The PVC edit is rejected immediately. No partial state.

To actually shrink: create a new smaller PVC, copy data, switch the app. Manual work.

---

## Special cases

### NFS / SMB backends

For shared filesystem backends:

- There is no per-volume "size" on the backend (it's a share of total capacity).
- Expansion is usually a no-op from the driver's perspective — "the share already has capacity."
- Some drivers simulate by updating the PV's `spec.capacity` and calling it done.
- Filesystem resize isn't needed (there's no per-PVC filesystem).

In practice, for NFS you often use `reclaimPolicy: Retain` with a large-enough share and don't resize at all.

### Generic ephemeral volumes

Ephemeral PVCs (pod-owned PVCs) can also be resized per the underlying SC's rules. Same mechanics.

### Offline expansion and StatefulSets

StatefulSets replace pods one at a time, so rolling expansion of many PVCs works:

```bash
# Edit all PVCs
for i in 0 1 2; do
  kubectl patch pvc data-my-sts-$i -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'
done

# Online expansion: filesystem grows live on each pod, no restarts needed.
# Offline: restart pods one at a time:
kubectl delete pod my-sts-0
# wait for it to come back before next
kubectl delete pod my-sts-1
# etc.
```

For large StatefulSets, this is how you grow every PVC without downtime.

---

## Volume snapshots — adjacent but separate

CSI also supports snapshots (crash-consistent, point-in-time copies):

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: backup-1
spec:
  volumeSnapshotClassName: ebs-snapshot
  source:
    persistentVolumeClaimName: my-pvc
```

You can restore from a snapshot into a new PVC:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: restored
spec:
  storageClassName: fast-ssd
  dataSource:
    name: backup-1
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  resources:
    requests:
      storage: 50Gi
```

Not strictly in-scope for CKA's core, but worth recognizing. Snapshots are the way to do "backup before resize" or clone volumes for testing.

---

## Cloning

Similar to snapshots, but a direct volume-to-volume clone:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cloned
spec:
  storageClassName: fast-ssd
  dataSource:
    name: my-pvc
    kind: PersistentVolumeClaim
  resources:
    requests:
      storage: 50Gi
```

The CSI driver clones the source PVC's volume into a new one. Faster than snapshot+restore for some drivers; supported if the CSI driver advertises CLONE_VOLUME.

---

## Exam heuristics

- Resize questions almost always require `allowVolumeExpansion: true` on the SC.
- `kubectl edit pvc` to change size; wait and re-check.
- `kubectl describe pvc` shows Resizing and FileSystemResizePending conditions.
- If resize appears stuck, check: (1) SC allows expansion, (2) CSI driver controller has external-resizer sidecar, (3) for node-side resize, the CSI node plugin is Running on the pod's node.
- Shrinking PVCs is not a thing in Kubernetes. If asked to reduce size, copy to a new smaller PVC.

## Mental traps

- Applying `allowVolumeExpansion: true` after the PVC was created and expecting existing resize requests to work. The flag controls **future** resize API requests.
- Forgetting that some filesystems / drivers require **offline** resize — a pod restart. Can lead to "looks stuck" misdiagnosis.
- Attempting to shrink. Not supported. Re-create.
- Resizing an NFS-backed PVC and expecting the share itself to grow. The share is pre-sized by the NFS server; resize is often a no-op.
- Resizing the PV directly. You change the PVC; the system updates the PV. Editing the PV's capacity field manually can corrupt state.
- Counting seconds. Backend resize (EBS, etc.) can take minutes. Watch `kubectl describe pvc` patiently.
- Running multi-tenant untrusted clusters without SC controls. Any user can resize up; there's no per-namespace cap on PVC size (though ResourceQuota can limit total storage).
