## The storage model in one picture

Kubernetes storage has two very different layers:

- **Ephemeral volumes** — live and die with the pod. Fast, simple, no cluster state.
- **Persistent volumes** — live independently of any pod. Needed for anything stateful (databases, caches, file stores).

Persistent storage is the interesting one, and it's built from three API objects plus one protocol:

```
            Pod
             │ references
             ▼
      ┌──────────────────┐
      │ PersistentVolume │  ←── PersistentVolume
      │      Claim       │      (PV)
      └──────────────────┘       ↑
             │  binds to          │
             ▼                    │ provisioned by
      ┌──────────────────┐        │
      │     PV           │        │
      └──────────────────┘        │
             │ uses                │
             ▼                    │
      ┌──────────────────┐        │
      │  StorageClass    │────────┘
      │     (SC)         │   ── provisioner (CSI driver)
      └──────────────────┘
             │
             │ CSI gRPC
             ▼
      [ CSI driver pod(s) ]
             │
             ▼
      cloud storage / NFS / Ceph / local disk
```

Three objects plus one protocol:

- **PVC** — the app's request: "I need 10 GiB of storage, accessible from one pod."
- **PV** — the actual chunk of storage, either statically pre-created or dynamically provisioned.
- **StorageClass** — a template for PVs ("EBS gp3, 125 IOPS"). The PVC names a SC; the SC names a CSI driver; the driver creates the real volume.
- **CSI** — the container storage interface; a gRPC API between kubelet and the driver.

---

## Ephemeral volumes — the quick tour

Not every workload needs persistent storage. Many just need scratch space or a way to mount a Secret/ConfigMap into the container. Four main ephemeral kinds:

### `emptyDir`

```yaml
volumes:
- name: cache
  emptyDir:
    sizeLimit: 1Gi               # optional
    medium: Memory                 # optional: tmpfs
```

A fresh empty directory, created when the pod is scheduled, **deleted when the pod terminates**. Lives on the node's disk by default, or in RAM if `medium: Memory`.

Use cases:

- Scratch space between containers in the same pod (sidecar patterns).
- Cache that can be rebuilt on restart.
- Temporary work directory.

### `configMap` and `secret`

```yaml
volumes:
- name: config
  configMap:
    name: my-config
- name: creds
  secret:
    secretName: db-credentials
```

Read-only projections of ConfigMap / Secret data as files. Contents update if the ConfigMap/Secret changes (eventual consistency — tens of seconds).

### `downwardAPI`

Exposes pod metadata (labels, annotations, resource limits, pod name) as files. Rarely used in exam scope but worth recognizing.

### `projected`

Combines multiple sources (configmap, secret, downwardAPI, serviceAccountToken) into one volume with controlled paths. This is what kubelet uses to inject the SA token at `/var/run/secrets/kubernetes.io/serviceaccount/`.

### Generic ephemeral volumes (newer)

A pod can request a fresh PVC inline that lives only as long as the pod:

```yaml
volumes:
- name: scratch
  ephemeral:
    volumeClaimTemplate:
      metadata:
        labels: { type: scratch }
      spec:
        accessModes: [ ReadWriteOnce ]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 1Gi
```

Creates a PVC whose name is `<pod-name>-<volume-name>`. When the pod is deleted, the PVC is also deleted (owned by the pod). Useful for fresh scratch storage larger than `emptyDir` can reasonably hold.

---

## Persistent volumes — where the data lives

For anything long-lived, you need a PV. The lifecycle:

```
 1. Admin or app author declares a StorageClass (SC).
 2. App author creates a PVC that references the SC.
 3. Controller sees the PVC, invokes the SC's provisioner.
 4. Provisioner creates actual cloud storage + a PV object.
 5. PVC binds to the PV (bi-directional reference).
 6. Pod's volume references the PVC by name.
 7. kubelet + CSI node plugin mount the volume into the container.
```

The PV outlives pods that use it. You can delete all the pods; the data remains. What eventually removes the PV depends on the **reclaim policy** (Retain/Delete), covered in its own subtopic.

### Why PVCs and PVs are separate

You could imagine a simpler model: "Pod declares 10 GiB of fast SSD; cluster provides." Kubernetes deliberately keeps them separate because:

- **Two audiences** — app developers write PVCs (their needs); cluster operators write PVs / SCs (available storage).
- **Policy boundary** — PVCs can be limited per namespace via ResourceQuota on storage; PVs are cluster-scoped.
- **Unbundled lifecycle** — a pod is ephemeral; its data request (PVC) can outlive many pods; the physical storage (PV) can outlive many PVCs (if Retain).
- **Validation** — a cluster operator can reject weird storage requests by not defining a SC that supports them.

The tradeoff: more objects to manage. Dynamic provisioning (SC + automatic PV creation) smoothes this out.

---

## The CSI layer

CSI (Container Storage Interface) is how kubelet and the control plane talk to storage drivers. It's a **gRPC API** standardized across Kubernetes, Mesos, Nomad, etc.

A CSI driver is two deployments:

- **Controller plugin** (Deployment or StatefulSet, usually ~3 replicas): handles cluster-scope operations.
  - `CreateVolume` / `DeleteVolume` (provisioning)
  - `ControllerPublishVolume` / `ControllerUnpublishVolume` (attach/detach block device to node)
  - `ControllerExpandVolume` (resize)
  - `CreateSnapshot` / `DeleteSnapshot`

- **Node plugin** (DaemonSet, one per node): handles node-scope operations.
  - `NodeStageVolume` (mount to staging dir on this node)
  - `NodePublishVolume` (bind-mount into pod's mount namespace)
  - `NodeUnstageVolume` / `NodeUnpublishVolume`
  - `NodeExpandVolume` (filesystem resize)

The controller plugin runs alongside **external sidecars** that translate Kubernetes concepts into CSI calls:

| Sidecar                | What it does                                                          |
|------------------------|-----------------------------------------------------------------------|
| `external-provisioner` | Watches PVCs; calls `CreateVolume`; creates the PV object              |
| `external-attacher`    | Watches VolumeAttachment objects; calls `ControllerPublishVolume`     |
| `external-resizer`     | Watches PVC resize requests; calls `ControllerExpandVolume`           |
| `external-snapshotter` | Watches VolumeSnapshot CRs; calls `CreateSnapshot`                    |
| `node-driver-registrar`| Runs alongside the node plugin; registers the driver with kubelet     |

You typically `helm install` a CSI driver chart; it deploys all of this with the right RBAC. You rarely assemble it by hand.

### Finding a CSI driver on a cluster

```bash
# Registered CSI drivers
kubectl get csidrivers

# Node-plugin registration (kubelet's plugin socket directory)
ls /var/lib/kubelet/plugins_registry/
```

Common drivers:

- `ebs.csi.aws.com` — AWS EBS
- `disk.csi.azure.com` — Azure disk
- `pd.csi.storage.gke.io` — GCE Persistent Disk
- `cinder.csi.openstack.org` — OpenStack Cinder
- `nfs.csi.k8s.io` — NFS CSI driver
- `rook-ceph.rbd.csi.ceph.com` — Ceph via Rook
- `csi.tigera.io`, `driver.longhorn.io`, and many others

---

## In-tree drivers — historical note

Before CSI, Kubernetes had hundreds of "in-tree" volume plugins (awsElasticBlockStore, gcePersistentDisk, cinder, vsphereVolume, azureDisk, azureFile, ...). These are now deprecated:

- Most have been "migrated": you still write `hostPath: ...` or `awsElasticBlockStore: ...` in PV YAML, but the in-tree plugin translates to the CSI driver behind the scenes.
- Some have been removed outright in recent versions.
- New drivers are CSI-only.

For CKA: recognize in-tree-looking YAML (e.g. `hostPath`, `nfs`) but know that modern clusters drive everything through CSI.

---

## The volume types you'll see in YAML

Even though CSI is the backend, PV YAML supports many source types:

```yaml
spec:
  # Cloud block:
  awsElasticBlockStore: { volumeID: vol-xxx, fsType: ext4 }
  gcePersistentDisk: { pdName: my-disk, fsType: ext4 }
  azureDisk: { diskName: xxx, kind: Managed }

  # Network file:
  nfs: { server: 10.0.0.5, path: /exports }
  cephfs: { monitors: [ ... ] }

  # Local:
  hostPath: { path: /mnt/data, type: DirectoryOrCreate }
  local: { path: /mnt/ssd }

  # CSI (explicit):
  csi:
    driver: ebs.csi.aws.com
    volumeHandle: vol-xxx
```

For CKA, the two you'll write by hand are usually `hostPath` (for labs) and the CSI forms for exam-provided drivers.

### `hostPath` vs `local`

Both live on a specific node's disk, but with different semantics:

| Aspect             | `hostPath`                                     | `local`                              |
|--------------------|------------------------------------------------|--------------------------------------|
| Node binding       | None — can be on any node                       | Required via `nodeAffinity`          |
| Scheduler awareness | None — pod may go to wrong node                | Scheduler respects affinity           |
| Production use     | Not recommended                                 | Used for local-SSD workloads          |
| Typical use        | Single-node kubeadm labs, CI                    | High-perf disks, sharded databases    |

A `local` PV with nodeAffinity is how StatefulSets can use local NVMe on specific hosts while still being schedulable.

---

## Putting it together — a full PV/PVC/Pod flow

```yaml
---
# 1. StorageClass (usually installed with the CSI driver, shown here for clarity)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer

---
# 2. PVC — the app's request
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
      storage: 10Gi

---
# 3. Pod — consumes the PVC
apiVersion: v1
kind: Pod
metadata:
  name: app
spec:
  containers:
  - name: app
    image: postgres:16
    volumeMounts:
    - name: data
      mountPath: /var/lib/postgresql/data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: app-data
```

Timeline:

1. `kubectl apply` — PVC created, Pending (SC is WaitForFirstConsumer).
2. Pod created, scheduler waits for PVC to bind... except WaitForFirstConsumer says the reverse — scheduler picks a node first, **then** PVC can be provisioned in that node's zone.
3. Scheduler picks node `worker-2` in `us-east-1a`.
4. CSI provisioner sees PVC + pod-node info → creates EBS volume in us-east-1a, creates PV object, PV binds to PVC.
5. Attach-detach controller calls `ControllerPublishVolume` → EBS attached to worker-2.
6. kubelet on worker-2 calls `NodeStageVolume` → mount at staging path, filesystem formatted if needed.
7. kubelet calls `NodePublishVolume` → bind-mount into the pod's mount namespace at `/var/lib/postgresql/data`.
8. Container starts, postgres sees the volume.

Any step can fail. The next few subtopics walk each in detail.

---

## Exam heuristics

- For most exam scenarios, you create a PVC with a named StorageClass and expect dynamic provisioning to "just work."
- For "create a PV and PVC and make them bind," you typically use `hostPath` + `storageClassName: manual` (empty or non-default) to avoid dynamic provisioning pulling in a cloud driver.
- The default StorageClass (annotated `storageclass.kubernetes.io/is-default-class: "true"`) is used if a PVC has no `storageClassName`. Memorize this annotation.
- `kubectl get pvc` shows bound/pending status fast.
- `kubectl get pv` shows cluster-wide volumes; useful for seeing "orphaned" PVs.

## Mental traps

- Confusing ephemeral volumes with persistent. `emptyDir` is not a PVC-based volume.
- Thinking a PVC's `storageClassName: ""` means "use default." Empty string means "no StorageClass at all, bind only to pre-created static PVs." Missing field means "use default." Two very different behaviors.
- Believing the PV contains the data. The PV is an API object pointing at real storage (cloud volume, NFS mount). Deleting a PV with `Retain` leaves the real storage intact; with `Delete`, it deletes the backing storage.
- Assuming CSI is optional. On modern clusters it's mandatory — every volume type eventually traverses CSI.
- Treating `hostPath` like a feature. It's a lab tool; production uses CSI or `local`.
- Thinking `emptyDir` persists across restarts. It's deleted with the pod, though container restarts within the same pod preserve it.
