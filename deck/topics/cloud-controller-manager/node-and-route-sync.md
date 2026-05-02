## Two controllers on cloud nodes

CCM owns two of the things that happen to a Node at the cloud layer:

1. **Node initialization + lifecycle** — providerID, addresses, labels, decommission detection.
2. **Route sync** — programming the cloud's VPC routing table for pod CIDRs (when the CNI uses native cloud routing).

Both are invisible until they don't work. This subtopic covers what they do and how to diagnose problems.

---

## Node initialization (the cloud-flavored side)

When a new Node joins (kubelet registers via `kubeadm join`):

```
1. Kubelet creates a Node object via apiserver.
2. Initial Node has minimal info: name, kubelet version, bare addresses.
3. Initially tainted: node.cloudprovider.kubernetes.io/uninitialized:NoSchedule
4. CCM's node controller sees the new Node, calls cloud APIs:
   - Fetch instance ID, zone, region.
   - Set spec.providerID = aws:///us-east-1a/i-0a1b2c3d (or equivalent).
   - Set node.kubernetes.io/instance-type label.
   - Set topology.kubernetes.io/zone, topology.kubernetes.io/region.
   - Set status.addresses with instance addresses (private + public IPs).
5. CCM removes the uninitialized taint.
6. Node is now schedulable.
```

Without CCM, step 4-6 don't happen. The node:

- Doesn't get `providerID`.
- Doesn't get zone/region labels.
- Stays tainted with `uninitialized:NoSchedule` — pods can't be scheduled here.

That's why `--cloud-provider=external` on kubelet (in cloud setups) is critical. Kubelet adds the uninit taint; CCM removes it. No CCM = no removal = no scheduling.

For bare-metal clusters with no CCM, kubelet doesn't add the uninit taint (no cloud provider configured), so nodes are schedulable from the start.

---

## providerID

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.providerID}{"\n"}{end}'

# worker-1   aws:///us-east-1a/i-0a1b2c3d4e5f6g7h8
# worker-2   aws:///us-east-1b/i-1b2c3d4e5f6g7h8i9
# worker-3   aws:///us-east-1c/i-2c3d4e5f6g7h8i9j0
```

The format is cloud-specific:

| Cloud | Format |
|-------|--------|
| AWS | `aws:///<zone>/<instance-id>` |
| GCP | `gce://<project>/<zone>/<instance-name>` |
| Azure | `azure:///subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Compute/virtualMachines/<name>` |
| OpenStack | `openstack:///<server-uuid>` |
| vSphere | `vsphere://<vm-uuid>` |
| Linode | `linode://<instance-id>` |

`providerID` is **immutable** once set. Used by:

- **Service controller** — when programming a cloud LB, it uses providerID to identify nodes for backend registration.
- **Node controller** — for periodic sync (lookup VM status by ID, detect deletion).
- **Cluster autoscaler** — uses it to map between Node objects and underlying cloud instances.

---

## Topology labels

Standard labels CCM sets:

```bash
kubectl get nodes -L topology.kubernetes.io/zone,topology.kubernetes.io/region

# NAME       STATUS   ROLES   AGE   VERSION   ZONE        REGION
# worker-1   Ready    <none>  30d   v1.30.0   us-east-1a  us-east-1
# worker-2   Ready    <none>  30d   v1.30.0   us-east-1b  us-east-1
# worker-3   Ready    <none>  30d   v1.30.0   us-east-1c  us-east-1
```

These power:

- **Zone-aware Service routing** (`spec.trafficDistribution: PreferClose`).
- **Pod topology spread constraints**.
- **StatefulSet zone-aware volume binding**.

Older labels (`failure-domain.beta.kubernetes.io/zone`, `failure-domain.beta.kubernetes.io/region`) still set for backward compatibility but treat as legacy.

Plus instance type:

```bash
kubectl get nodes -L node.kubernetes.io/instance-type
# NAME       INSTANCE-TYPE
# worker-1   m5.large
# worker-2   m5.large
# worker-3   m5.xlarge
```

Useful for cost-aware scheduling, taints based on instance type, etc.

---

## Decommission detection

Periodically, CCM queries the cloud:

- "Is this VM still running?"

If the cloud says no (VM terminated, hardware failure, manual deletion):

- CCM **deletes the Node object** (or marks it with `node.kubernetes.io/unreachable:NoExecute` — varies by cloud).
- All pods on that node get scheduled elsewhere by their controllers.

This is the cloud-aware version of "the node is gone forever." Without CCM, the Node object would linger as `NotReady` until manually removed.

---

## node-monitor periodic sync

By default, CCM checks nodes every 5 minutes (`--node-monitor-period`). If you have a fast-churning node pool (autoscaler), this matters: a terminated VM may stick around as a Node object for ~5 minutes before CCM cleans up.

Pods on the gone node are evicted faster (via taint-based eviction triggered by kubelet's missing heartbeat — that's kube-controller-manager's job, not CCM's).

---

## Route controller

For CNIs that don't use overlay encapsulation (Calico in BGP mode, Cilium in native routing, GCP's "alias IP" mode, AWS VPC CNI in some configs), pod-to-pod traffic across nodes relies on **cloud-VPC-level routing**:

```
 Pod on Node-A (10.244.1.5) → wants to send to Pod on Node-B (10.244.2.7)
                                          │
                                          │ packet leaves Node-A
                                          ▼
                                   VPC routing table
                                   "10.244.2.0/24 → Node-B's IP"
                                          │
                                          ▼
                                   Packet reaches Node-B
                                          │
                                   Node-B's CNI delivers to the pod
```

Without those routes, pod-to-pod traffic across nodes doesn't work. The Route Controller in CCM:

- Watches Nodes.
- For each Node, ensures a route exists in the VPC: "node's pod CIDR → node's IP."
- Adds/removes routes as nodes join/leave.

### Per-cloud examples

**AWS**: Route table entries pointing at instance IDs (or ENIs).

**GCP**: Routes resource (`gcloud compute routes list`).

**Azure**: User-defined routes in the VNet's route table.

If routes don't get programmed, pods on different nodes can't talk. From inside a pod:

```bash
kubectl exec -it -n test src-pod -- ping <pod-on-other-node>
# 100% packet loss → routing issue
```

Confirm in the cloud console: are routes for each node's pod CIDR present?

### When the route controller isn't needed

If your CNI uses encapsulation (Flannel VXLAN, Calico IPIP/VXLAN, Cilium with VXLAN), pod traffic is wrapped and goes between nodes as regular VPC traffic to node IPs. No special routes needed.

In that case, you can disable CCM's route controller:

```bash
cloud-controller-manager --controllers=*,-route
```

Most managed clusters either disable it or never enable it depending on the CNI's design.

---

## Address sync

Beyond the initial setup, CCM periodically refreshes Node addresses if they change:

- AWS instance gets a new public IP (rare in production).
- VM is reassigned to a different subnet (also rare).

The Node's `status.addresses` array is updated:

```bash
kubectl get node worker-1 -o jsonpath='{.status.addresses}'
# [
#   {"type":"InternalIP","address":"10.0.1.5"},
#   {"type":"ExternalIP","address":"54.x.y.z"},
#   {"type":"Hostname","address":"worker-1.internal"}
# ]
```

`InternalIP` is what most cluster-internal traffic uses. `ExternalIP` shows up when the cloud has assigned one.

---

## Common issues

### Node stuck with `cloudprovider.kubernetes.io/uninitialized` taint

CCM didn't initialize the node. Causes:

- CCM not running.
- CCM lacks cloud-API permissions (IAM error in CCM logs).
- CCM running but talking to the wrong cloud (cred mismatch).
- Cloud API throttling.

Fix: check CCM pod logs.

```bash
kubectl logs -n kube-system -l k8s-app=cloud-controller-manager | tail -50
```

### Node has no zone label

CCM ran but couldn't fetch zone from the cloud API. Often: misconfigured IAM policy missing `ec2:DescribeInstances` or equivalent.

### Node lingers as NotReady after VM is gone

CCM either isn't running, isn't checking, or doesn't have permissions to list instances.

```bash
# Manually clean up
kubectl delete node <name>
# Pods reschedule elsewhere.
```

### Pod-to-pod across nodes fails

Routes might not be programmed. Check CCM's route-controller logs:

```bash
kubectl logs -n kube-system -l k8s-app=cloud-controller-manager | grep -i route
```

For AWS: confirm in EC2 console → VPC → Route Tables that there's a route per node pod CIDR. If missing, CCM isn't programming them — possibly RBAC / IAM issue.

### CCM constantly re-initializes

```
Failed to set ProviderID for node "..." after multiple attempts
```

CCM can find the cloud instance for some nodes but not others. Could be:

- Node's hostname doesn't match what cloud returns.
- VM tag/metadata is missing the expected fields.
- IAM permissions missing for some operations.

Look at the specific node's CCM log.

---

## Manually setting providerID

Rarely needed, but if CCM can't auto-set:

```bash
kubectl patch node worker-1 -p '{"spec":{"providerID":"aws:///us-east-1a/i-0a1b2c3d"}}'
```

Use only when CCM can't do it (legacy cluster being migrated). Side-effect: CCM may try to "reconcile" and reject if the providerID doesn't match what it computed.

---

## Inspecting and debugging route programming

```bash
# CCM's route-related logs
kubectl logs -n kube-system <ccm-pod> | grep -i 'route\|cidr'

# Common log lines:
#   "Created route for node ..."
#   "Failed to create route ..."

# AWS: verify routes
aws ec2 describe-route-tables --filters Name=vpc-id,Values=<vpc-id>

# GCP: verify routes
gcloud compute routes list --filter='name~kubernetes-route-'
```

If routes are missing for some nodes:

- Check those nodes' providerID — set?
- Check if their pod CIDR is correctly assigned in the Node spec:
  ```bash
  kubectl get node worker-1 -o jsonpath='{.spec.podCIDR}'
  # 10.244.1.0/24
  ```
- Pod CIDR comes from kube-controller-manager's `--allocate-node-cidrs=true`. If false, no pod CIDRs assigned, no routes to program.

---

## Disabling specific controllers

CCM can run with a subset of controllers:

```bash
cloud-controller-manager \
  --controllers=*,-route \           # everything except route controller
  --controllers=cloud-node           # just the cloud-node controller
```

Useful for clusters where some integrations aren't wanted. E.g. if you use VXLAN-based CNI, no route controller needed.

The list of available controllers:

- `cloud-node` — node initialization
- `cloud-node-lifecycle` — decommission detection
- `service` — LoadBalancer Services
- `route` — VPC routes

---

## Cloud-specific quirks

### AWS

- IAM permissions: `ec2:DescribeInstances`, `ec2:DescribeRegions`, `elasticloadbalancing:*` (for Service controller), `ec2:CreateRoute`/`DeleteRoute` (for Route controller).
- ELB / NLB / ALB depending on annotations.

### GCP

- IAM roles: Compute Network Admin (for routes), Kubernetes Engine User (for general).
- Workload Identity strongly recommended for credential management.

### Azure

- Managed identity + role assignments: Network Contributor, Virtual Machine Contributor.

Each has its own gotchas. Read the cloud's CCM documentation when you set up.

---

## Exam heuristics

- For "node not getting scheduled, has uninitialized taint," CCM likely isn't running or has cred issues.
- `kubectl get nodes -o jsonpath='{.items[*].spec.providerID}'` to verify CCM did its job.
- For "pods can't reach across nodes" on a non-overlay CNI, check VPC routes in the cloud console.
- `kubectl logs -n kube-system -l k8s-app=cloud-controller-manager` is the diagnostic source.

## Mental traps

- Confusing CCM's node controller with kube-controller-manager's. The kube-controller-manager handles cluster-level evictions and statuses; CCM handles cloud-side identity and discovery.
- Expecting a kubeadm bare-metal cluster to have CCM. It doesn't (no cloud).
- Setting providerID manually on a CCM-managed cluster. CCM will overwrite if it doesn't match its computed value.
- Misunderstanding `--cloud-provider=external` on kubelet. It triggers the uninit taint; without CCM running, nodes are stuck unscheduled.
- Forgetting that route controller is unnecessary if your CNI does encapsulation.
- Running CCM with insufficient IAM. Silent failures, only visible in logs.
- Treating `topology.kubernetes.io/zone` as set-by-kubelet. It's set by CCM (or by the user manually). Without CCM, missing.
