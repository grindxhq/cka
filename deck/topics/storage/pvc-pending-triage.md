## The single most common storage scenario

A PVC you just created is `Pending` and stays that way. Pod can't start. Everything is waiting on one object. This is the decision tree to find the root cause.

The fundamental question: **Is this PVC waiting for a PV to match, or for one to be provisioned? And why isn't either happening?**

---

## Step 0: Confirm the symptom

```bash
kubectl get pvc <name>
# NAME        STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS   AGE
# app-data    Pending                                       fast-ssd        5m
```

If STATUS is Pending and VOLUME is empty, no binding has occurred. This is the triage we're doing.

If STATUS is Bound but the pod still can't start, skip to the end — that's a mount / attach issue, not a bind issue.

---

## Step 1: Read the events

Always first. `kubectl describe pvc` is the fastest diagnostic:

```bash
kubectl describe pvc app-data
```

Look at the `Events:` section at the bottom. Common reasons:

| Event reason                                  | Meaning                                                         |
|-----------------------------------------------|-----------------------------------------------------------------|
| `WaitForFirstConsumer`                        | Normal: SC is WaitForFirstConsumer; waiting for a pod            |
| `WaitForPodScheduled`                         | Pod is being scheduled; should resolve soon                     |
| `Provisioning`                                | Dynamic provisioning started                                    |
| `ProvisioningFailed`                          | Provisioner tried and failed — read the message                  |
| `ExternalProvisioning`                        | Waiting for external provisioner to act                          |
| `FailedBinding` / `no persistent volumes available` | Static binding: no matching PV exists                    |
| (no events at all)                            | No SC, no provisioner, or PVC is misconfigured silently         |

Each points you to a different part of the tree.

---

## Step 2: Does the PVC have a StorageClass?

```bash
kubectl get pvc app-data -o jsonpath='{.spec.storageClassName}{"\n"}'
# fast-ssd          ← named SC
# (empty)           ← implicit default injection?
# ""                ← explicitly empty; no SC
```

Three cases:

### Case A: PVC has a StorageClass (e.g. `fast-ssd`)

Dynamic provisioning path. Go to step 3.

### Case B: PVC has empty string `""`

Static binding only. Kubernetes will NOT invoke any provisioner. The PVC needs a matching PV with matching (empty) SC name. Go to step 4.

### Case C: PVC has no `storageClassName` field at all

Admission controller should have injected the default SC. Check if one exists:

```bash
kubectl get sc
# Look for '(default)' next to one of them
```

If none is marked default → PVC stays Pending because there's no SC to provision from. Fix by setting a default SC, or explicitly setting `storageClassName` on the PVC.

If a default exists but wasn't injected → `RetroactiveDefaultStorageClass` feature gate might not be active (relevant for PVCs created before the default existed; applies retroactively on 1.28+).

---

## Step 3: Dynamic provisioning path

### 3a: Does the SC exist?

```bash
kubectl get sc fast-ssd
```

If Not Found: typo in PVC, or SC never created. Create the SC or fix the PVC.

### 3b: Does the SC have a valid provisioner?

```bash
kubectl get sc fast-ssd -o yaml | grep provisioner
# provisioner: ebs.csi.aws.com
```

Cases:

- **`kubernetes.io/no-provisioner`** — this SC does no dynamic provisioning. PVC will only bind to a pre-created PV with matching `storageClassName`. Proceed as in case B above.
- **A CSI driver name** — proceed to 3c.
- **A deprecated in-tree plugin name** (e.g. `kubernetes.io/aws-ebs`) — works if CSI migration is active, fails otherwise. Migrate to CSI driver.

### 3c: Is the CSI driver installed?

```bash
kubectl get csidrivers
# NAME                  ATTACHREQUIRED   PODINFOONMOUNT   STORAGECAPACITY   ...
# ebs.csi.aws.com       true             false            false             ...
```

If the driver name from the SC isn't listed, the CSI driver isn't installed. Install it (Helm chart, operator, or manifest) and retry.

### 3d: Is the external-provisioner running?

```bash
# Find the driver's controller pod
kubectl get pods -A | grep -E 'csi.*controller|ebs-csi-controller|azuredisk-csi-controller|gcp-compute-persistent-disk-csi-driver'

# Check the external-provisioner sidecar
kubectl logs -n <ns> <controller-pod> -c csi-provisioner --tail=100
```

Common errors in the log:

- `Failed to provision volume: rpc error: code = Unavailable` — driver unhealthy.
- `Failed to provision volume: AccessDenied / Forbidden` — CSI driver lacks cloud IAM permissions.
- `VolumeBindingMode is WaitForFirstConsumer, waiting for pod scheduling` — normal; waiting for a pod.
- `InvalidParameterValue` — driver rejected SC parameters.

Fix the root cause (IAM, network, config), the provisioner retries automatically.

### 3e: Is there a pod using this PVC?

For `volumeBindingMode: WaitForFirstConsumer`, provisioning waits until a pod is scheduled. If no pod references the PVC yet, it stays Pending — that's by design, not an error.

```bash
# Any pod using this PVC?
kubectl get pods -o json | jq -r '.items[] | select(.spec.volumes[]?.persistentVolumeClaim.claimName=="app-data") | .metadata.name'
```

If none, create a pod that uses it. Provisioning kicks in when the scheduler picks a node for that pod.

### 3f: Cloud-specific failures

Every cloud has its own errors:

- **AWS**: `UnauthorizedOperation` (IAM), `VolumeLimitExceeded` (account-wide EBS limit), `InvalidParameterValue` (zone doesn't support requested type).
- **GCP**: `Permission denied` (service account), quota exceeded.
- **Azure**: `QuotaExceeded`, incorrect resource group.

The provisioner log message is usually the cloud's error verbatim. Fix in the cloud console.

---

## Step 4: Static binding path

You're here because `storageClassName: ""` (explicit) or the SC has no provisioner.

### 4a: Is there a matching PV?

```bash
kubectl get pv
# Look for:
#   - Status: Available
#   - Capacity >= PVC's requested storage
#   - Access modes include PVC's requested modes
#   - Same storageClassName (including empty-string case)
```

Filter:

```bash
kubectl get pv -o json | jq -r '
  .items[] | select(.status.phase=="Available") |
    {name: .metadata.name, size: .spec.capacity.storage,
     modes: .spec.accessModes, sc: .spec.storageClassName}'
```

No matching PV → you must create one. Example static hostPath PV:

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: static-pv
spec:
  capacity: { storage: 10Gi }
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: manual
  hostPath: { path: /mnt/data }
```

Make sure `storageClassName`, size, and access modes align with the PVC.

### 4b: Does the PVC's selector filter out all PVs?

```bash
kubectl get pvc app-data -o yaml | grep -A 5 selector
# spec:
#   selector:
#     matchLabels:
#       type: ssd
```

If a `selector` is set, the PV must have matching `labels`. No labels on the PV → no match.

Either add labels to the PV:

```bash
kubectl label pv <pv-name> type=ssd
```

Or remove the selector from the PVC (edit is blocked; delete and recreate).

### 4c: Is the PV already bound or reserved?

```bash
kubectl get pv <pv> -o yaml | grep -A 3 claimRef
```

If `claimRef` points at a different PVC (say, a deleted one with a different UID), this PV is reserved and won't bind to your PVC.

Clear it:

```bash
kubectl patch pv <pv> --type=merge -p '{"spec":{"claimRef":null}}'
```

PV goes `Available`, your PVC's next binding loop picks it up.

### 4d: Does PV target this PVC specifically?

If the PV's `claimRef` names a specific PVC (e.g. `namespace: default, name: app-data`), only that exact PVC can bind. Good for reserved-binding scenarios; bad if you wanted another PVC to take it.

---

## Step 5: Common patterns

### Empty cluster, no SC, no PV

PVC Pending forever. You need either:

- Install a CSI driver + create an SC (for dynamic).
- Create matching static PVs.

### Cloud cluster, SC exists, provisioner log silent

Check whether the SC has `volumeBindingMode: WaitForFirstConsumer`. If yes, PVC **will stay Pending** until a pod uses it. Create the pod.

### SC exists, provisioner log shows errors

Read the error. Usually cloud IAM, quota, or a bad SC parameter. Fix in cloud.

### Pre-existing PVC was working, suddenly Pending

Only possible if PVC was deleted and recreated. Existing PVCs don't revert from Bound to Pending. If you're seeing this, the cluster was rebuilt (different PV, different binding), or the PV it was bound to was deleted (status goes `Lost`, not Pending).

### Pod stuck in ContainerCreating after PVC Bound

PVC is Bound; PV is attached (or trying to attach). Not a PVC Pending issue — it's a mount issue:

```bash
kubectl describe pod <pod> | grep -A 20 Events
# FailedMount, FailedAttach, volume attach timed out, etc.
```

See the kubelet deck's CRI/CNI/CSI subtopic for mount debugging.

---

## Quick triage recipe

```bash
# 1. Symptom confirmation
kubectl get pvc <name>

# 2. Full detail + events
kubectl describe pvc <name>

# 3. SC check
SC=$(kubectl get pvc <name> -o jsonpath='{.spec.storageClassName}')
echo "PVC's storageClassName: $SC"
kubectl get sc "$SC" 2>/dev/null || echo "SC does not exist"

# 4. For dynamic: provisioner check
kubectl get sc "$SC" -o jsonpath='{.provisioner}'
kubectl get pods -A | grep csi | grep -i controller

# 5. For dynamic: any pod using this PVC?
kubectl get pods -o json | jq -r --arg name "$(kubectl get pvc <name> -o jsonpath='{.metadata.name}')" \
  --arg ns "$(kubectl get pvc <name> -o jsonpath='{.metadata.namespace}')" \
  '.items[] | select(.spec.volumes[]?.persistentVolumeClaim.claimName==$name and .metadata.namespace==$ns) | .metadata.name'

# 6. For static: find candidate PVs
kubectl get pv
```

Walk through 1 → 6 and note where reality differs from expectation.

---

## Decision tree summary

```
PVC Pending
│
├── describe: "waiting for first consumer"
│     → normal for WaitForFirstConsumer; create a pod that uses this PVC
│
├── describe: "ExternalProvisioning" / "Provisioning"
│     → dynamic path in progress; check CSI controller logs
│
├── describe: "ProvisioningFailed"
│     → CSI error in event message; fix cloud cause
│
├── describe: "no persistent volumes available"
│     → static path; need to create a matching PV
│
├── describe: empty events
│     ├── SC is empty string ""
│     │     → static path; create matching PV
│     ├── SC is unset and no default exists
│     │     → create/mark a default SC
│     ├── SC is unset and default exists
│     │     → admission didn't inject (retroactive SC feature?); specify explicitly
│     └── SC name is nonexistent
│           → create the SC or fix PVC
│
└── SC has provisioner but nothing is happening
      → external-provisioner sidecar not running or failing; check its logs
```

---

## Preventing the "PVC Pending" cycle

For clusters you design:

- Install at least one CSI driver before deploying workloads.
- Annotate one SC as the default.
- Use `volumeBindingMode: WaitForFirstConsumer` for cloud block drivers.
- Use `allowVolumeExpansion: true` on any SC you expect to grow.
- Write workload YAMLs with explicit `storageClassName` — don't rely on defaults.

For clusters you inherit:

```bash
# Quick cluster health
kubectl get sc
kubectl get csidrivers
kubectl get pvc -A --field-selector=status.phase=Pending
```

Any Pending PVC in the last output is probably one of the cases above.

---

## Exam heuristics

- First thing to run on a Pending PVC: `kubectl describe pvc <name>`. Events tell you everything.
- `kubectl get sc` to confirm SCs. Know which one is default.
- For exam "create a PV and PVC that bind" scenarios: `storageClassName: manual` on both, matching size + access modes.
- For exam "make dynamic provisioning work" scenarios: verify SC has a provisioner, and for WaitForFirstConsumer, create a pod.
- `kubectl get pv,pvc` is the one command that shows both sides at once.

## Mental traps

- Expecting Pending to resolve itself with time. It usually won't — some condition is unmet.
- Missing the WaitForFirstConsumer case and concluding "provisioning is broken." Normal for that binding mode; create a pod.
- Using implicit default SC and then being surprised when there isn't one. Always specify explicitly.
- Seeing "no persistent volumes available" and assuming dynamic provisioning will kick in. It won't if SC has no provisioner.
- Creating PVs manually with `claimRef` pointing at a PVC that doesn't exist yet. Works for pre-binding but messy if the name later changes.
- Trying to resize a Pending PVC. Expansion applies to Bound PVCs. Make it Bind first.
- Thinking static PVs with empty `storageClassName` will match PVCs with a named `storageClassName`. They won't — SC names must match exactly.
