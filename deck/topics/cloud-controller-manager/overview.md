## Why CCM exists

The **cloud-controller-manager** is the control plane component that owns cloud-specific reconciliation: nodes, routes, and LoadBalancer Services. Everything that needs to call AWS / GCP / Azure / OpenStack APIs.

It used to live inside kube-controller-manager, but that meant cloud-provider code was compiled into core Kubernetes — making cloud integrations harder to update independently.

In modern Kubernetes (1.27+), all in-tree cloud providers have been moved to **out-of-tree** CCM binaries:

```
 kube-controller-manager  →  generic controllers (Deployment, Job, etc.)
 cloud-controller-manager →  cloud-specific controllers (Node, Route, Service)
                              (separate binary, separately versioned)
```

For on-prem / bare-metal / kind / minikube clusters: there's **no CCM**. Kubernetes works fine without one — you just don't get LoadBalancer integration or auto-routes.

For cloud clusters (EKS, GKE, AKS, etc.): CCM is essential. The cloud provider supplies it.

---

## What CCM does (three controllers)

CCM bundles three controllers, all running in one binary:

### 1. Node controller (cloud-specific portion)

**Different from** the node controller in kube-controller-manager. The kube-controller-manager's node controller handles cluster-side things (taints, evictions). CCM's node controller handles cloud-side things:

- **Initialize new Nodes** — when a node joins, set `spec.providerID`, label with cloud zone/region, fetch addresses from the cloud API.
- **Detect deletion** — if the cloud says the VM is gone (terminated, hardware failure), mark the Node for removal.
- **Sync labels and addresses** — periodically reconcile the Node object with the live cloud state.

Example: an EKS node has `spec.providerID: aws:///us-east-1a/i-0a1b2c3d`. CCM set this from the EC2 metadata.

### 2. Route controller

For clusters where the **pod CIDR** is implemented via cloud routing (not via overlay/encapsulation):

- For each Node, ensure there's a route in the cloud's VPC saying "destination = node's pod CIDR → next hop = node's IP."
- Add routes when nodes join, remove when they leave.

Used by Calico-without-encap, GCP's "alias IP" mode, AWS VPC CNI in some configurations.

### 3. Service controller

Handles `type: LoadBalancer` Services:

- Create/update/delete cloud LBs (NLB, ALB, GCLB, Azure LB, etc.) in response to Service changes.
- Update Service `status.loadBalancer.ingress` with the LB's external IP / hostname.
- Apply cloud-specific annotations (e.g. AWS-specific: `service.beta.kubernetes.io/aws-load-balancer-type: nlb`).

---

## When you need it

You need a CCM if:

- You want `type: LoadBalancer` Services to actually provision cloud LBs (not stay in `<pending>` forever).
- Your CNI uses cloud routing (not overlay).
- You want automatic node lifecycle management (auto-detect when a VM is gone).
- You want zone / region labels on Nodes for topology-aware features (zone-aware StatefulSets, topology-spread).

You don't need a CCM if:

- Bare-metal cluster, no cloud APIs.
- Lab / kind / minikube.
- All your Services are ClusterIP / NodePort / Ingress (no `type: LoadBalancer`).

In a CCM-less cluster, `type: LoadBalancer` Services have `EXTERNAL-IP: <pending>` forever. Use MetalLB / kube-vip if you need external IPs without a cloud provider.

---

## Where CCM runs

In a kubeadm cluster with cloud integration, CCM is a **DaemonSet or Deployment** on the control plane:

```bash
kubectl get pods -n kube-system | grep cloud
# cloud-controller-manager-cp1   1/1   Running   0   30d
```

For HA, multiple replicas — they leader-elect via a Lease (just like kube-controller-manager).

For managed clusters (EKS, GKE, AKS): CCM runs on the cloud-provider-managed control plane, invisible to you.

For self-hosted on-cloud (kubeadm + AWS, etc.): you deploy the CCM yourself, typically as a DaemonSet that runs only on CP nodes.

---

## kubeadm + CCM

In a kubeadm cluster on a cloud provider, CCM is configured during `kubeadm init`:

```yaml
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
controllerManager:
  extraArgs:
  - name: cloud-provider
    value: external             # tells kube-controller-manager to defer cloud bits to CCM
apiServer:
  extraArgs:
  - name: cloud-provider
    value: external
```

Then deploy the CCM separately:

```bash
# AWS example
kubectl apply -f https://raw.githubusercontent.com/kubernetes/cloud-provider-aws/master/examples/existing-cluster/base/aws-cloud-controller-manager-daemonset.yaml
```

If `--cloud-provider=external` isn't set on kube-controller-manager and apiserver, kubeadm tries to run the (deprecated) in-tree provider, which doesn't work after 1.30+.

---

## What CCM doesn't do

- **Doesn't manage Pod scheduling** — that's the scheduler.
- **Doesn't manage Deployments / ReplicaSets / Jobs** — that's kube-controller-manager.
- **Doesn't run network policies** — that's the CNI.
- **Doesn't handle storage attachment** — that's the CSI driver + attach-detach controller (which is in kube-controller-manager, not CCM).

The `--cloud-provider=external` flag on kube-controller-manager **disables** the cloud-specific parts of its node-controller and replaces them with CCM's. Storage attach/detach migration is a separate story (CSI migration), partially in flight per-cloud.

---

## Deployment example (out-of-tree AWS CCM)

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: aws-cloud-controller-manager
  namespace: kube-system
spec:
  selector:
    matchLabels: { k8s-app: aws-cloud-controller-manager }
  template:
    metadata:
      labels: { k8s-app: aws-cloud-controller-manager }
    spec:
      serviceAccountName: cloud-controller-manager
      hostNetwork: true                   # need access to node IP for LB updates
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        effect: NoSchedule
      containers:
      - name: aws-cloud-controller-manager
        image: registry.k8s.io/provider-aws/cloud-controller-manager:v1.30
        args:
        - --v=2
        - --cloud-provider=aws
        - --leader-elect=true
        - --use-service-account-credentials
```

The CCM's SA needs cloud-API credentials — typically via IAM Roles for Service Accounts (IRSA) on AWS, Workload Identity on GCP, etc. Or via instance profile / metadata service.

---

## Per-cloud CCMs

| Cloud | CCM source |
|-------|------------|
| AWS | https://github.com/kubernetes/cloud-provider-aws |
| GCP | https://github.com/kubernetes/cloud-provider-gcp |
| Azure | https://github.com/kubernetes-sigs/cloud-provider-azure |
| OpenStack | https://github.com/kubernetes/cloud-provider-openstack |
| vSphere | https://github.com/kubernetes/cloud-provider-vsphere |
| DigitalOcean | https://github.com/digitalocean/digitalocean-cloud-controller-manager |
| Linode | https://github.com/linode/linode-cloud-controller-manager |

Each has its own deployment manifest, RBAC, and IAM requirements. Follow the project's README.

For managed clusters, the cloud handles all of this.

---

## Identity and credentials

CCM needs cloud API access:

- **AWS**: typically an IAM role attached to control plane nodes (instance profile) OR an IAM Role for Service Accounts (IRSA) attached to the CCM's SA.
- **GCP**: Workload Identity binding the SA to a Google service account with appropriate roles.
- **Azure**: Managed identity (system-assigned or user-assigned) on the CP VMs OR Workload Identity.

Without cloud credentials: CCM can't create LBs, can't sync nodes. It logs auth errors and the cluster looks broken (LBs pending forever).

---

## Inspecting CCM

```bash
# Pod
kubectl get pods -n kube-system -l k8s-app=cloud-controller-manager
kubectl logs -n kube-system <ccm-pod> --tail=100

# Useful logs:
# - "Initializing node ..." — node controller picking up new nodes
# - "Adding finalizer to service ..." — service controller starting LB provisioning
# - "Successfully created load balancer for service ..." — LB created
# - "Failed to ..." — credential or API issues

# Leader status
kubectl get lease -n kube-system | grep cloud
# cloud-controller-manager   ccm-cp1_xxx     30d
```

If CCM is missing or unhealthy:

- New nodes don't get providerID labels.
- LoadBalancer Services stay `<pending>`.
- Decommissioned VMs leave behind dead Node objects.

All recoverable by fixing CCM and waiting for reconciliation.

---

## In-tree provider deprecation

For years, Kubernetes had cloud-specific code compiled into kube-controller-manager (`--cloud-provider=aws|gce|azure|...`). This was deprecated and progressively removed:

- 1.27: in-tree AWS, GCP, Azure removed (use external CCM).
- 1.30: most in-tree providers gone; use external CCMs.

If you see old kubelet / kube-controller-manager flags like `--cloud-provider=aws` (without `=external`): old cluster, plan migration. Modern clusters all use external CCMs.

---

## Exam heuristics

- For exam scenarios on managed clouds (rare), CCM is an implicit dependency for `type: LoadBalancer`.
- On bare-metal exam labs, `EXTERNAL-IP: <pending>` is normal — there's no CCM.
- For "create a service that gets an external IP," either the cluster has a CCM (via cloud) or MetalLB.
- `kubectl get pods -n kube-system | grep cloud` confirms CCM presence.

## Mental traps

- Thinking CCM is mandatory. It's optional; bare-metal clusters work fine without.
- Confusing CCM's node controller with kube-controller-manager's node controller. Two different controllers, similar names.
- Expecting `type: LoadBalancer` to work on minikube without `minikube tunnel` or MetalLB.
- Forgetting that CCM needs cloud credentials to function. Auth failures = silent LB failures.
- Treating the in-tree cloud providers as still functional. They're not in modern releases.
- Running both an in-tree provider (`--cloud-provider=aws`) AND an external CCM. They fight.
