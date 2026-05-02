## What a StorageClass actually is

A `StorageClass` is a **template for creating PVs**. It answers two questions simultaneously:

1. **Who** creates the underlying storage? (the `provisioner` field — a CSI driver name)
2. **How** should it be configured? (the `parameters`, `reclaimPolicy`, `volumeBindingMode`, and others)

When a PVC references a StorageClass, Kubernetes delegates the actual provisioning to that SC's provisioner. No admin has to pre-create PVs; they're minted on demand.

```
 PVC
  │ storageClassName: fast-ssd
  ▼
 StorageClass fast-ssd
  │ provisioner: ebs.csi.aws.com
  │ parameters: { type: gp3, iops: "3000" }
  │ volumeBindingMode: WaitForFirstConsumer
  │ reclaimPolicy: Delete
  ▼
 external-provisioner (sidecar)
  │ calls CreateVolume via CSI gRPC
  ▼
 CSI driver
  │ creates 20 GiB EBS gp3 volume, returns volumeID
  ▼
 PV object (auto-generated)
  │ binds to PVC
  ▼
 Pod mounts it
```

---

## The full spec

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com                    # required
parameters:                                      # optional; driver-specific
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:..."
reclaimPolicy: Delete                            # Delete | Retain
volumeBindingMode: WaitForFirstConsumer          # Immediate | WaitForFirstConsumer
allowVolumeExpansion: true
mountOptions:
  - discard
allowedTopologies:                               # optional topology restriction
  - matchLabelExpressions:
      - key: topology.ebs.csi.aws.com/zone
        values: [us-east-1a, us-east-1b]
```

Field by field.

### `provisioner` (required)

Names the CSI driver (or legacy in-tree plugin) that creates the volume. Only volumes created by this provisioner match this SC. Common values:

| Provisioner                          | Backend                                 |
|--------------------------------------|-----------------------------------------|
| `ebs.csi.aws.com`                    | AWS EBS                                 |
| `disk.csi.azure.com`                 | Azure Disk                              |
| `file.csi.azure.com`                 | Azure Files                             |
| `pd.csi.storage.gke.io`              | GCE Persistent Disk                     |
| `cinder.csi.openstack.org`           | OpenStack Cinder                        |
| `nfs.csi.k8s.io`                     | NFS (external CSI driver)               |
| `rook-ceph.rbd.csi.ceph.com`         | Ceph RBD via Rook                       |
| `rook-ceph.cephfs.csi.ceph.com`      | CephFS via Rook                         |
| `driver.longhorn.io`                 | Longhorn                                |
| `local.csi.k8s.io`                   | Local storage                           |
| `kubernetes.io/no-provisioner`       | No provisioning; used for local PVs + `WaitForFirstConsumer` |

On a kubeadm lab cluster with no external storage, you often don't have any provisioner at all — dynamic provisioning won't work, only static PVs will.

### `parameters` (optional, driver-specific)

Opaque map passed to the provisioner. Every driver has its own keys:

- **EBS**: `type` (gp2/gp3/io1/io2/st1/sc1), `iops`, `throughput`, `encrypted`, `kmsKeyId`.
- **GCE PD**: `type` (pd-standard/pd-ssd/pd-balanced), `replication-type`.
- **Azure Disk**: `skuName` (Standard_LRS/Premium_LRS/StandardSSD_LRS).
- **NFS (external)**: `server`, `share`, `mountPermissions`.

Case matters; keys are driver-specific. Check the driver's docs.

### `reclaimPolicy` (optional, default `Delete`)

What happens to the PV (and the underlying storage) when the PVC is deleted:

- `Delete` — PV deleted, backing volume deleted. Data gone. Default for dynamically provisioned PVs.
- `Retain` — PV stays as `Released`, backing volume preserved. Admin must manually reclaim. Default for statically provisioned PVs.

The legacy `Recycle` policy is deprecated and removed in modern clusters.

Inheritance: a PV created by this SC inherits `reclaimPolicy`. You can edit the PV's policy post-creation if needed.

### `volumeBindingMode` (optional, default `Immediate`)

Controls when provisioning and binding happen:

- **`Immediate`** — as soon as the PVC is created, provision the volume and bind. Problematic in multi-zone clusters: the volume may land in a zone where no node can schedule the pod, creating an unschedulable pod.
- **`WaitForFirstConsumer`** — defer until a pod that uses the PVC is scheduled. The provisioner then creates the volume in the pod's scheduled zone, and the PV binds.

For cloud providers with zone-local storage (EBS, GCE PD, Azure Disk), **always use `WaitForFirstConsumer`**. It prevents the zone-mismatch trap.

For global storage (Azure Files across regions, NFS), `Immediate` is fine because the volume isn't zone-anchored.

### `allowVolumeExpansion` (optional, default `false`)

Enables online resize of the PVC. Details in the resize-and-expansion subtopic.

### `mountOptions` (optional)

List of mount flags passed to the filesystem layer when the volume is attached:

```yaml
mountOptions:
  - discard
  - nfsvers=4.1
  - noatime
```

Driver-specific. Common for NFS clients (timeout tuning, version pinning) and block devices (discard for SSD TRIM support).

### `allowedTopologies` (optional)

Restricts PV creation to specific zones or other topology keys:

```yaml
allowedTopologies:
- matchLabelExpressions:
  - key: topology.kubernetes.io/zone
    values: [us-east-1a, us-east-1b]
```

Useful when you have separate SCs for "zone-restricted" vs "any zone" storage. Works together with `WaitForFirstConsumer` — the scheduler picks a pod's node considering allowedTopologies.

---

## `volumeBindingMode` deep-dive

This field is subtle but critical for multi-zone clusters.

### Problem: `Immediate` in a multi-zone cluster

```
 3 nodes:
   node-1 in zone us-east-1a
   node-2 in zone us-east-1b
   node-3 in zone us-east-1c

 PVC created → SC has Immediate binding → provisioner creates EBS in us-east-1a.
 PV bound. PVC waits for pod.
 Pod gets scheduled... but EBS volumes only attach to nodes in the same zone.
 Scheduler picks node-1 (only candidate). Works.

 But what if node-1 is cordoned? Or its zone is under maintenance?
 → Pod stays Pending forever. Volume is in us-east-1a; no schedulable node there.
 → Have to delete the PVC, re-create, hope for a better zone choice.
```

### Solution: `WaitForFirstConsumer`

```
 PVC created → SC has WaitForFirstConsumer → PVC stays Pending.
 Pod created referencing this PVC → scheduler sees an unbound PVC.
 Scheduler picks a node based on pod constraints.
 Scheduler signals "pod would go to node-2 in us-east-1b."
 Provisioner sees this, creates EBS in us-east-1b.
 PV binds to PVC. Pod lands on node-2. Volume attaches. All good.
```

The scheduler and the provisioner cooperate. The scheduler may pick nodes in different zones considering the pod's own affinity, resources, etc. — the volume follows.

Every modern cloud-provider SC should use `WaitForFirstConsumer`. The only case for `Immediate` is global-access storage (object storage, cross-zone NFS).

---

## The default StorageClass

One (and only one) StorageClass can be marked default:

```yaml
metadata:
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
```

A PVC without an explicit `storageClassName` field (note: missing, not empty-string) gets the default SC injected by admission at creation time.

```bash
# Find the default
kubectl get storageclass
# NAME            PROVISIONER           ...  AGE
# fast-ssd (default)  ebs.csi.aws.com   ...  30d
# slow-hdd        ebs.csi.aws.com       ...  30d

# Or explicitly:
kubectl get sc -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}'
```

### Multiple default classes — undefined behavior

If two SCs have `is-default-class: "true"`, the one created most recently is used. This is mostly chance and easy to break silently. Keep exactly one default.

### Changing the default

```bash
# Remove default from current one
kubectl patch storageclass <old-default> -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'

# Make new one default
kubectl patch storageclass <new-default> -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

### What if there's no default?

PVCs with unset `storageClassName` stay Pending forever on clusters with no default SC and no matching PV. Symptoms: `kubectl describe pvc` shows "no persistent volumes available for this claim and no storage class is set."

Fix: set a default SC, or always specify `storageClassName` in PVCs.

---

## Custom StorageClass examples

### AWS EBS gp3 with encryption

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-gp3-encrypted
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

### NFS via external-nfs CSI

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-shared
provisioner: nfs.csi.k8s.io
parameters:
  server: 10.0.0.42
  share: /exports/k8s
mountOptions:
  - nfsvers=4.1
  - hard
reclaimPolicy: Retain
volumeBindingMode: Immediate
```

### Azure Disk Premium

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: azure-premium
provisioner: disk.csi.azure.com
parameters:
  skuName: Premium_LRS
  cachingMode: ReadOnly
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

### Local storage (no dynamic provisioning)

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-storage
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
```

Used for local PVs: no provisioning happens, but `WaitForFirstConsumer` ensures scheduling respects the PV's node affinity.

---

## Volume snapshot classes (related)

Snapshots have their own "class" object:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-snapshot
driver: ebs.csi.aws.com
deletionPolicy: Delete
parameters:
  tagSpecification_1: "Name=volume-snapshot"
```

Then VolumeSnapshot objects use this class. Out of CKA scope for core curriculum, but worth recognizing the pattern — it mirrors StorageClass/PVC exactly.

---

## The provisioner-PVC handshake

Under the hood:

1. PVC with `storageClassName: fast-ssd` created.
2. `external-provisioner` sidecar (next to the CSI driver's controller plugin) watches PVCs.
3. It sees this PVC, looks up `fast-ssd`, confirms its driver name matches the one it's wrapping.
4. It calls `CreateVolume` on the CSI driver with:
   - Name (typically `pvc-<uid>`)
   - Size (from PVC's `resources.requests.storage`)
   - Parameters (from SC)
   - Zone/topology hints (from scheduled pod's node, if `WaitForFirstConsumer`)
5. Driver returns `volumeID` (e.g. `vol-0a1b2c3d`).
6. Sidecar creates a PV object with `spec.csi.driver` + `spec.csi.volumeHandle`.
7. PV binds to PVC (k8s controllers do this automatically).

If any step fails, PVC stays Pending. Events on the PVC record the error.

### Finding the provisioner pod

```bash
# All CSI drivers
kubectl get csidrivers

# The controller plugin Pod (usually has -controller- in its name)
kubectl get pods -A | grep -E 'csi.*(controller|provisioner)'

# Its logs
kubectl logs -n <driver-ns> <csi-controller-pod> -c csi-provisioner --tail=100
```

`external-provisioner` logs errors directly — "failed to provision volume" with the driver's error underneath.

---

## When dynamic provisioning won't work

Ways a cluster has no dynamic provisioning:

- **No SC** — PVCs without a class can only match pre-created PVs.
- **SC has `provisioner: kubernetes.io/no-provisioner`** — no dynamic provisioning by design (local PVs).
- **SC references a CSI driver that isn't installed** — PVC stays Pending with no events.
- **SC references a cloud driver, but cluster is on-prem** — same issue.

On a kubeadm lab cluster you often have no CSI driver installed. Create static PVs instead.

### Creating a static PV for exam scenarios

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: task-pv-volume
spec:
  capacity:
    storage: 10Mi
  accessModes: [ ReadWriteOnce ]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: manual
  hostPath:
    path: /mnt/data
```

Create PVC with matching `storageClassName: manual`, same or smaller capacity, same access mode. Bind happens.

---

## Retroactive default SC (newer clusters)

Historically, if you created a PVC before the default SC existed, the PVC kept its unset `storageClassName` and stayed Pending. Newer Kubernetes has **retroactive default**: adding a default SC later updates existing unset PVCs. The feature gate is `RetroactiveDefaultStorageClass` (beta in 1.26, stable in 1.28+).

Not critical for CKA, but don't be surprised if a "fix" to a stuck PVC is "install a default SC" even on PVCs created earlier.

---

## Exam heuristics

- `kubectl get storageclass` is the first thing to check when a PVC is stuck Pending.
- For exams without a cloud CSI driver, use `kubernetes.io/no-provisioner` + local/hostPath PVs.
- `WaitForFirstConsumer` is the right answer for zone-aware storage. Don't use `Immediate` unless you have a reason.
- `allowVolumeExpansion: true` is the prerequisite for any expansion question.
- The `is-default-class` annotation is the key piece — memorize the annotation key.

## Mental traps

- Expecting `parameters` to be portable across drivers. They aren't — `type: gp3` for EBS, `type: pd-ssd` for GCE PD, `skuName: Premium_LRS` for Azure.
- Setting `volumeBindingMode: Immediate` on multi-zone cloud clusters. Breaks scheduling when volumes land in the wrong zone.
- Annotating two SCs as default. Undefined winner.
- Trying to create a `StorageClass` with an unset `provisioner`. Required field; won't apply.
- Changing `parameters` on an existing SC and expecting existing PVs to update. They don't — PVs are immutable once created. Only newly provisioned PVs use the new parameters.
- Using `reclaimPolicy: Retain` on a dynamic SC without a plan. You'll accumulate Released PVs and orphaned cloud volumes.
- Assuming `mountOptions` work on every filesystem. Some options are filesystem-specific; driver may silently ignore unknowns.
