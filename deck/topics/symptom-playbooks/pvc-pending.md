## What "PVC Pending" really means

```
$ kubectl get pvc
NAME       STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS   AGE
my-pvc     Pending                                       fast-ssd        10m
```

The PVC has been created but hasn't been bound to a PV. Until binding, any pod referencing the PVC can't start (gets stuck `Pending` itself, with "unbound PersistentVolumeClaim" event).

PVC Pending = your storage decision tree is incomplete. The cluster is asking for storage and not getting it.

---

## The single decision tree

```
PVC Pending
│
├── 1. Read describe events first — they tell you why
│
├── 2. Does it specify a storageClassName?
│   ├── A named SC → dynamic provisioning expected
│   ├── "" (empty string) → static binding only (no provisioning)
│   └── Unset → DefaultStorageClass admission injects default; if no default, stuck
│
├── 3. Dynamic path: does the SC exist? Has a real provisioner?
│
├── 4. Dynamic path: is the provisioner running and healthy?
│
├── 5. Dynamic path: is volumeBindingMode WaitForFirstConsumer? (Pending until pod scheduled is normal)
│
├── 6. Static path: is there a matching PV (size / accessModes / labels)?
│
└── 7. Cloud-specific: IAM, quota, region constraints
```

---

## Step 1: Read the events

Always first:

```bash
kubectl describe pvc my-pvc | sed -n '/Events:/,$p'
```

Likely event reasons:

| Event reason | Meaning |
|--------------|---------|
| `WaitForFirstConsumer` | Normal — SC is WaitForFirstConsumer mode; Pending until a pod uses it |
| `WaitForPodScheduled` | Pod scheduling in progress; should resolve |
| `Provisioning` | Dynamic provisioning started |
| `ProvisioningFailed` | Provisioner tried, failed; read message |
| `ProvisioningSucceeded` | Volume created; binding imminent |
| `ExternalProvisioning` | Waiting for external provisioner |
| `FailedBinding` / no PVs available | Static binding: no matching PV exists |
| (No events) | No SC, no provisioner, possibly misconfigured |

The event message is precise. Read every word.

---

## Step 2: storageClassName behavior

```bash
kubectl get pvc my-pvc -o jsonpath='{.spec.storageClassName}{"\n"}'
```

Three outcomes:

### A) Named SC (e.g. `fast-ssd`)

Dynamic provisioning expected. Skip to step 3.

### B) Empty string `""`

Static binding only. No dynamic provisioning. PVC will only bind to a pre-existing PV with empty `storageClassName`.

```yaml
# PVC
spec:
  storageClassName: ""

# Compatible PV
spec:
  storageClassName: ""
```

If no such PV: stays Pending forever. Skip to step 6.

### C) Unset (field missing)

The `DefaultStorageClass` admission controller injects the default SC at create time:

```bash
# Verify a default exists
kubectl get sc | grep '(default)'

# fast-ssd (default)   ebs.csi.aws.com   ...
```

If a default exists: behaves like (A) with that SC.
If no default: PVC stays unset and Pending forever.

Note: empty string ≠ unset. Subtle but critical.

---

## Step 3: Does the SC exist? Has a real provisioner?

```bash
SC=$(kubectl get pvc my-pvc -o jsonpath='{.spec.storageClassName}')
kubectl get sc $SC -o yaml
```

Verify:

- StorageClass exists.
- `provisioner` field names a real CSI driver or `kubernetes.io/no-provisioner`.

```yaml
provisioner: kubernetes.io/no-provisioner    # ← no dynamic; static only
provisioner: ebs.csi.aws.com                 # ← dynamic via AWS EBS
provisioner: nfs.csi.k8s.io                  # ← dynamic via NFS CSI
```

If `kubernetes.io/no-provisioner`: dynamic isn't going to happen. You need a pre-existing PV. Go to step 6.

If a real provisioner: that driver should be installed.

```bash
# CSI drivers registered in the cluster
kubectl get csidrivers
# NAME              ATTACHREQUIRED   PODINFOONMOUNT   STORAGECAPACITY
# ebs.csi.aws.com   true             false            false
# nfs.csi.k8s.io    false            false            false
```

If the SC's provisioner isn't in this list: the driver isn't installed. Install it (Helm chart, operator, or static manifests).

---

## Step 4: Is the provisioner running?

```bash
# CSI driver controller pods (typically Deployment in the driver's namespace)
kubectl get pods -A -l 'app in (ebs-csi-controller, csi-driver-controller)' | head

# Or by namespace convention
kubectl get pods -n kube-system | grep csi
```

The pod name varies by driver. Look for `*csi*controller*` or driver-specific names.

```bash
# Logs of the external-provisioner sidecar
kubectl logs -n <driver-ns> <controller-pod> -c csi-provisioner --tail=50
```

Common provisioner errors:

### `Failed to provision volume: AccessDenied`

Cloud IAM lacks permissions. Fix the role / IAM policy attached to the driver's SA.

### `VolumeLimitExceeded`

Cloud account hit volume / EBS limit. Check service quotas; raise.

### `InvalidParameterValue`

SC parameter is rejected by the driver. Common: typo'd `type`, wrong `iops`/`throughput` for the type.

```yaml
# AWS EBS gp2 doesn't accept iops; you'd need gp3
parameters:
  type: gp2
  iops: "3000"          # invalid for gp2
```

Fix: align parameters to what the driver / cloud accepts.

### `quota check failed`

Kubernetes ResourceQuota in the namespace blocks the PVC.

```bash
kubectl get resourcequota -n <ns>
kubectl describe resourcequota -n <ns>
```

Adjust quota or reduce the PVC size.

### `provisioning timed out`

Cloud API is slow. Usually transient. Watch:

```bash
kubectl get pvc -w
```

If persistently slow, look at cloud LB / API status.

---

## Step 5: WaitForFirstConsumer mode

Many cloud SCs use `WaitForFirstConsumer`:

```bash
kubectl get sc $SC -o jsonpath='{.volumeBindingMode}'
# WaitForFirstConsumer
```

In this mode, **provisioning is intentionally deferred** until a pod that uses the PVC is scheduled. The PVC stays Pending — that's normal.

To trigger:

```bash
# Are there any pods using this PVC?
kubectl get pods -A -o json | \
  jq -r '.items[] | select(.spec.volumes[]?.persistentVolumeClaim.claimName == "my-pvc") |
    "\(.metadata.namespace)/\(.metadata.name) → node: \(.spec.nodeName // "Pending")"'
```

If no pod uses it: create one. Once scheduled (i.e. `nodeName` set), the provisioner kicks in, PV is created in the right zone, and PVC binds.

If a pod uses it but stays Pending: chain failure — see pod-pending playbook.

---

## Step 6: Static binding path

You're here because:

- `storageClassName: ""` (explicit), OR
- SC's provisioner is `kubernetes.io/no-provisioner`, OR
- No matching SC exists at all.

You need a **manually-created PV** that matches the PVC's requirements.

```bash
# What does the PVC need?
kubectl get pvc my-pvc -o yaml | head -30

# spec:
#   accessModes: [ReadWriteOnce]
#   resources:
#     requests:
#       storage: 10Gi
#   storageClassName: ""

# Available PVs?
kubectl get pv

# Filter to compatible ones
kubectl get pv -o json | jq -r '
  .items[] | select(.status.phase == "Available") |
    select(.spec.capacity.storage as $cap |
      (.spec.accessModes | any(. == "ReadWriteOnce")) and
      ($cap | rtrimstr("Gi") | tonumber >= 10)) |
    "\(.metadata.name)\t\(.spec.capacity.storage)\t\(.spec.accessModes | join(","))\t\(.spec.storageClassName // "")"'
```

If a matching PV exists: it should bind. Verify within 30 seconds.

If no matching PV: create one.

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: my-static-pv
spec:
  capacity: { storage: 10Gi }
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""              # match PVC's empty string
  hostPath: { path: /mnt/data }
```

Apply, wait. PV transitions to Bound; PVC follows.

### PV pre-bound to a different PVC

Sometimes a PV has `claimRef` set to a deleted PVC. New PVCs can't claim it (ref doesn't match):

```bash
kubectl get pv <pv> -o yaml | grep -A 3 claimRef
# claimRef:
#   namespace: default
#   name: old-pvc
#   uid: deleted-uid
```

Clear the claimRef:

```bash
kubectl patch pv <pv> --type=merge -p '{"spec":{"claimRef":null}}'
```

PV transitions to Available. Now your PVC can bind.

---

## Step 7: Cloud-specific gotchas

### AWS EBS

```
Failed to provision volume: error creating EBS volume: VolumeLimitExceeded
```

Hit account / region EBS volume limit. Either delete unused volumes or request a limit increase.

```
Failed to provision volume: ... InvalidParameterValue: type=gp2 doesn't support iops
```

SC parameter mismatch. EBS types: gp2, gp3, io1, io2, st1, sc1. Each has different supported parameters.

### GCP PD

```
Failed to provision volume: googleapi: Error 403: Required '...' permission
```

Service account / Workload Identity lacks required role. Add `Compute Storage Admin` or equivalent.

### Azure Disk

```
Failed to provision volume: Code="DiskSizeAboveAvailableQuota"
```

Subscription or resource group quota exceeded.

### NFS

```
Failed to provision volume: failed to mount NFS share
```

NFS server unreachable from the CSI driver pod. Check connectivity, share permissions.

---

## Mode mismatches

PVC requests an access mode the backend can't support:

```yaml
# PVC
spec:
  accessModes: [ReadWriteMany]    # RWX
  storageClassName: fast-ebs        # EBS is RWO only
```

Provisioner refuses:

```
Failed to provision volume: rpc error: ... access mode not supported
```

Fix:

- Use a backend that supports RWX (NFS, EFS, Azure Files).
- Or change to `ReadWriteOnce`.

Backend support:

| Backend | RWO | ROX | RWX | RWOP |
|---------|:---:|:---:|:---:|:----:|
| EBS / GCE PD / Azure Disk | ✅ | ❌ | ❌ | ✅ |
| NFS / EFS / Azure Files | ✅ | ✅ | ✅ | ✅ |
| CephFS | ✅ | ✅ | ✅ | ✅ |
| Local volume | ✅ | ❌ | ❌ | ✅ |

---

## Capacity mismatch

PVC requests 100 GiB; biggest available PV is 50 GiB. PVC won't bind.

```bash
kubectl describe pvc my-pvc | grep Events
# Warning  FailedBinding  ... no persistent volumes available for this claim and no storage class is set
```

Fix: lower request, find / create a bigger PV, enable dynamic provisioning.

A PV bigger than the PVC's request is fine to bind (PVC gets all of the PV's capacity).

---

## Selector mismatch (if PVC uses one)

```yaml
# PVC
spec:
  storageClassName: ""
  selector:
    matchLabels:
      type: ssd
  resources:
    requests:
      storage: 10Gi
```

PV must have `labels: { type: ssd }`. Without it, no match.

```bash
kubectl get pv --show-labels | grep ssd
```

Either label the PV or remove the selector from the PVC.

---

## Quick diagnostic recipe

```bash
# 1. Events
kubectl describe pvc my-pvc | sed -n '/Events:/,$p'

# 2. Configuration check
kubectl get pvc my-pvc -o yaml | head -30

# 3. SC + provisioner
SC=$(kubectl get pvc my-pvc -o jsonpath='{.spec.storageClassName}')
kubectl get sc $SC -o jsonpath='{.provisioner} {.volumeBindingMode}{"\n"}'

# 4. CSI drivers in the cluster
kubectl get csidrivers

# 5. Provisioner pod health
kubectl get pods -A | grep -E 'csi|controller'

# 6. Recent provisioner logs
kubectl logs -n <driver-ns> <controller-pod> -c csi-provisioner --tail=30

# 7. Available PVs (for static binding)
kubectl get pv -o wide

# 8. Pod using this PVC (relevant for WaitForFirstConsumer)
kubectl get pods -A -o json | \
  jq -r '.items[] | select(.spec.volumes[]?.persistentVolumeClaim.claimName == "my-pvc") | .metadata.namespace + "/" + .metadata.name'
```

---

## Specific recipes

### Recipe: WaitForFirstConsumer Pending forever

```bash
# Verify SC's binding mode
kubectl get sc <name> -o jsonpath='{.volumeBindingMode}'
# WaitForFirstConsumer

# Create a pod that uses the PVC (or scale a deployment that does)
kubectl apply -f pod-using-pvc.yaml

# Watch
kubectl get pvc my-pvc -w
# Pending → Bound (after pod is scheduled)
```

### Recipe: No StorageClass at all

Cluster has no SCs:

```bash
kubectl get sc
# No resources found
```

Either install a CSI driver (with its SC), or create a static PV + matching PVC with `storageClassName: ""`.

For a kubeadm lab cluster:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-storage
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
```

(Then create static PVs that reference this SC.)

### Recipe: Dynamic provisioning failing with IAM error

```
Failed to provision volume: ... AccessDenied
```

Cloud IAM. Fix:

- AWS: ensure CSI driver SA has the policy `AmazonEBSCSIDriverPolicy` (or equivalent).
- GCP: ensure Workload Identity binds to a Google SA with `roles/compute.storageAdmin`.
- Azure: managed identity with `Disk Contributor` role.

After fixing IAM, the provisioner retries automatically (no need to delete/recreate the PVC).

### Recipe: Static PV with pre-bound claimRef

PV is `Released` from an earlier PVC. New PVC can't bind:

```bash
kubectl get pv <pv> -o jsonpath='{.spec.claimRef}'
# {"namespace":"old","name":"old-pvc","uid":"deleted-uid"}

# Clear it
kubectl patch pv <pv> --type=merge -p '{"spec":{"claimRef":null}}'

# PV → Available, your new PVC can bind
```

### Recipe: Multiple PVs match, want a specific one

Use `volumeName` on the PVC:

```yaml
spec:
  storageClassName: ""
  volumeName: my-specific-pv     # bind only to this PV
  ...
```

This locks the PVC to that one PV. Useful when you have many similar PVs.

---

## When PVC binds but pod still Pending

PVC is bound but pod referencing it stays Pending. Different problem:

```bash
kubectl describe pod my-pod
# Events:
# Warning  FailedScheduling  pod has unbound immediate PersistentVolumeClaims
```

Or:

```bash
# Events:
# Warning  FailedAttachVolume  AttachVolume.Attach failed for volume "..."
```

Different debug paths:

- **"unbound PVC"** despite Bound status — caching / race; usually self-resolves.
- **"FailedAttachVolume"** — CSI driver can't attach the volume to the chosen node. Check the attacher pod (sidecar) logs.
- **Volume node affinity conflict** — see pod-pending playbook (PV is in zone A, scheduler picked zone B).

Different layer; refer to pod-pending or container-runtime → image-and-sandbox-failures.

---

## Time budget

| Time | Step |
|------|------|
| 0:00 | `kubectl describe pvc <pvc>` — read events |
| 0:30 | Identify path (dynamic vs static, named vs default vs empty SC) |
| 1:30 | If dynamic: provisioner pod logs |
| 2:30 | If static: list PVs, identify match or create one |
| 3:30 | Apply fix, watch PVC transition to Bound |

For exam-pace: 2-3 minutes for routine PVC issues.

---

## Exam heuristics

- Always run `kubectl describe pvc <pvc>` first.
- For lab clusters with no CSI driver, use `hostPath` static PVs with `storageClassName: ""`.
- For "create a PVC and have it bind to this PV," match: storageClassName, accessModes, capacity (PV ≥ PVC).
- `WaitForFirstConsumer` is by design — create a pod to trigger.
- For exam scenarios needing dynamic provisioning, verify the SC's provisioner exists in `csidrivers`.

## Mental traps

- Confusing `storageClassName: ""` with unset. Empty = static-only; unset = use default SC (or stuck if no default).
- Expecting Pending to resolve itself. Provisioner kicks in immediately or never.
- Over-allocating — requesting 100 GiB when 10 is enough; smaller PVs may be available.
- Adding a `selector` to PVCs casually. Now you need labels on PVs to match. Most use cases don't need it.
- Editing the PVC's `spec.resources.requests.storage` to "fix" Pending. PVC spec for storage is mostly immutable post-creation; expansion requires `allowVolumeExpansion` on the SC.
- Deleting and recreating the PVC repeatedly. Doesn't help; fix the underlying issue (SC, provisioner, PV).
- Setting `accessModes: [ReadWriteMany]` for cloud block storage. Won't provision; backend doesn't support RWX.
- Forgetting to clear stale `claimRef` on Retained PVs you want to reuse.
