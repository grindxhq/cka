## Upgrading a kubeadm cluster

A cluster upgrade means replacing control plane components (apiserver, controller-manager, scheduler, etcd) and node-level components (kubelet, kube-proxy) with a newer version, without downtime and without data loss.

`kubeadm upgrade` automates the control plane half. You still do the kubelet / kubectl upgrades on each node yourself.

High-level order:

```
 1. Upgrade kubeadm binary on a control plane node.
 2. Run kubeadm upgrade plan (preview what would change).
 3. Run kubeadm upgrade apply on the FIRST CP node.
 4. Upgrade kubelet + kubectl on that CP node; drain/uncordon.
 5. For each remaining CP node:
    Install new kubeadm, run kubeadm upgrade node, upgrade kubelet + kubectl, drain/uncordon.
 6. For each worker:
    Install new kubeadm, run kubeadm upgrade node, upgrade kubelet + kubectl, drain/uncordon.
```

The subtle bit: **only one CP node at a time**. Never upgrade two in parallel — you'd lose etcd quorum during the window when one is being restarted.

---

## The kubeadm skew policy

Kubernetes' version skew policy governs which versions can coexist.

| Component pair                 | Allowed skew                                     |
|--------------------------------|--------------------------------------------------|
| kube-apiserver ↔ other apiservers | ±1 minor                                         |
| kubelet ↔ kube-apiserver       | apiserver can be 1-3 minors ahead of kubelet     |
| kube-proxy ↔ kubelet           | must match kubelet's node version                |
| kubectl ↔ kube-apiserver       | ±1 minor                                          |
| controller-manager / scheduler ↔ apiserver | same minor                            |

Upgrade implications:

- You can upgrade apiservers to 1.30 while kubelets are still on 1.28 or 1.29.
- You cannot upgrade a kubelet to 1.31 if your apiserver is 1.29.

**Rule of thumb**: upgrade the control plane first, then nodes. Never skip minor versions (`kubeadm upgrade` enforces this — 1.28 → 1.30 isn't allowed in one step; you'd go 1.28 → 1.29 → 1.30).

---

## `kubeadm upgrade plan`

Preview what an upgrade would do:

```bash
# Install the new kubeadm version on the first CP node:
sudo apt-mark unhold kubeadm
sudo apt-get update
sudo apt-get install -y kubeadm=1.30.0-*

# Plan the upgrade
sudo kubeadm upgrade plan
```

Output looks like:

```
[upgrade] Fetching available versions to upgrade to
[upgrade/versions] Cluster version: v1.29.3
[upgrade/versions] kubeadm version: v1.30.0
[upgrade/versions] Latest stable version: v1.30.3
...

Components that must be upgraded manually after you have upgraded the control plane with 'kubeadm upgrade apply':
COMPONENT   CURRENT   TARGET
kubelet     3 x v1.29.3   v1.30.3

Upgrade to the latest version in the v1.30 series:

COMPONENT                 CURRENT   TARGET
kube-apiserver            v1.29.3   v1.30.3
kube-controller-manager   v1.29.3   v1.30.3
kube-scheduler            v1.29.3   v1.30.3
kube-proxy                v1.29.3   v1.30.3
CoreDNS                   v1.10.1   v1.11.1
etcd                      3.5.10-0  3.5.12-0

You can now apply the upgrade by executing the following command:
    kubeadm upgrade apply v1.30.3
```

Read this carefully. Skew policy violations or incompatible versions would show up here.

---

## `kubeadm upgrade apply` on the first CP node

```bash
sudo kubeadm upgrade apply v1.30.3
```

Runs on the first CP node only. What it does:

```
 1. Verify preflight (healthy cluster, node is CP, quorum, etc.)
 2. Pull new images for this version.
 3. Rewrite /etc/kubernetes/manifests/etcd.yaml with new image tag.
    - kubelet sees the edit, restarts etcd with the new version.
    - Wait for etcd health.
 4. Rewrite /etc/kubernetes/manifests/kube-apiserver.yaml.
    - kubelet restarts apiserver.
 5. Rewrite /etc/kubernetes/manifests/kube-controller-manager.yaml.
 6. Rewrite /etc/kubernetes/manifests/kube-scheduler.yaml.
 7. Update the kubeadm-config ConfigMap (stores cluster's current version).
 8. Update kubelet-config ConfigMap (kubelet KubeletConfiguration snapshot).
 9. Update kube-proxy DaemonSet image.
 10. Update CoreDNS Deployment image.
```

Control plane components on this CP node are now upgraded. The other CP nodes' components are still on the old version — the apiserver cluster has mixed versions briefly, which skew policy allows.

### Upgrade confirmation

```bash
kubectl get nodes
# Shows kubelet version per node, not apiserver version.

kubectl version --short
# Shows CLIENT and SERVER versions.

# Check apiserver image on this CP node
kubectl get pod -n kube-system -l component=kube-apiserver \
  --field-selector spec.nodeName=<this-cp> \
  -o jsonpath='{.items[0].spec.containers[0].image}'
```

---

## Upgrade kubelet + kubectl on the first CP node

```bash
# Drain this CP node (so pods go elsewhere)
kubectl drain <cp-1> --ignore-daemonsets --delete-emptydir-data

# Upgrade kubelet + kubectl packages
sudo apt-mark unhold kubelet kubectl
sudo apt-get install -y kubelet=1.30.3-* kubectl=1.30.3-*
sudo apt-mark hold kubelet kubectl

# Reload systemd and restart kubelet
sudo systemctl daemon-reload
sudo systemctl restart kubelet

# Uncordon
kubectl uncordon <cp-1>
```

Verify:

```bash
kubectl get nodes
# cp-1 should now show v1.30.3
```

---

## Subsequent CP nodes

On each remaining CP node:

```bash
# Install new kubeadm
sudo apt-mark unhold kubeadm
sudo apt-get install -y kubeadm=1.30.3-*
sudo apt-mark hold kubeadm

# Upgrade control plane on this node
sudo kubeadm upgrade node

# Drain
kubectl drain <cp-N> --ignore-daemonsets --delete-emptydir-data

# Upgrade kubelet + kubectl
sudo apt-mark unhold kubelet kubectl
sudo apt-get install -y kubelet=1.30.3-* kubectl=1.30.3-*
sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload
sudo systemctl restart kubelet

# Uncordon
kubectl uncordon <cp-N>
```

Note: **`kubeadm upgrade node`** on subsequent CP nodes, NOT `upgrade apply`. The `apply` only runs on the first CP (it did the cluster-wide work); `node` on subsequent CPs updates only that node's static pod manifests.

One CP at a time. Verify each is healthy before starting the next:

```bash
kubectl get nodes
kubectl get pods -n kube-system
```

---

## Worker node upgrades

```bash
# On each worker:

# 1. Install new kubeadm
sudo apt-mark unhold kubeadm
sudo apt-get install -y kubeadm=1.30.3-*
sudo apt-mark hold kubeadm

# 2. Upgrade node-level components (mostly kubelet config)
sudo kubeadm upgrade node

# 3. Drain
kubectl drain <worker> --ignore-daemonsets --delete-emptydir-data

# 4. Upgrade kubelet + kubectl
sudo apt-mark unhold kubelet kubectl
sudo apt-get install -y kubelet=1.30.3-* kubectl=1.30.3-*
sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload
sudo systemctl restart kubelet

# 5. Uncordon
kubectl uncordon <worker>
```

Workers can be upgraded in parallel if you have enough capacity. Respect PodDisruptionBudgets.

---

## What `kubeadm upgrade node` does on a CP node

On CP nodes (other than the first), `upgrade node`:

1. Re-downloads cluster state from the ConfigMaps (kubeadm-config).
2. Re-generates certs if needed (for SAN changes or near-expiry ones).
3. Rewrites this node's static pod manifests with new image tags.
4. kubelet restarts the control plane pods with new versions.

It does **not** rerun any cluster-wide steps (those were done by `upgrade apply`).

On worker nodes, `upgrade node`:

1. Downloads the latest `kubelet-config` ConfigMap.
2. Writes it to `/var/lib/kubelet/config.yaml`.

No static pods on workers. The next step (kubelet package upgrade + restart) actually updates kubelet.

---

## etcd upgrade

`kubeadm upgrade` upgrades etcd in-place (for stacked etcd):

```
 etcd.yaml edited → kubelet restarts etcd pod → etcd starts with new version.
```

Each CP node's etcd is upgraded individually as part of that CP's upgrade. At any given moment, at least 2 of 3 etcd members are at the same version, so quorum is maintained.

etcd is designed to tolerate minor version skew within members for rolling upgrade.

**Never** try to upgrade etcd manually. `kubeadm` handles it. If you have an out-of-band etcd issue, snapshot + restore rather than hand-upgrade.

---

## CoreDNS and kube-proxy

These are in-cluster workloads, not static pods. `kubeadm upgrade apply` updates their Deployment and DaemonSet images:

```bash
kubectl get deploy -n kube-system coredns -o jsonpath='{.spec.template.spec.containers[0].image}'
# registry.k8s.io/coredns/coredns:v1.11.1

kubectl get ds -n kube-system kube-proxy -o jsonpath='{.spec.template.spec.containers[0].image}'
# registry.k8s.io/kube-proxy:v1.30.3
```

Their pods are rolled per the Deployment/DaemonSet strategy — continuing cluster operation.

---

## Dry-run and diff

Check what `kubeadm upgrade apply` would change:

```bash
sudo kubeadm upgrade apply v1.30.3 --dry-run
```

Shows the static pod manifest diffs, ConfigMap changes, etc. without writing anything.

Useful for reviewing an upgrade before committing.

---

## Common upgrade failures

### Version too old → too new (skip minor)

```
[ERROR] "v1.32.0" cannot be upgraded from "v1.29.3":
        couldn't skip minor version
```

Fix: go through intermediate versions. 1.29 → 1.30 → 1.31 → 1.32.

### apt can't find the version

```
E: Version '1.30.3-00' for 'kubeadm' was not found
```

- Debian/Ubuntu repo changed. Current repos are `pkgs.k8s.io/core:/stable:/v1.30/deb/` per minor version.
- Install packages from the right repo for your target minor.

```bash
# For 1.30:
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.30/deb/Release.key | \
  sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.30/deb/ /' | \
  sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update
```

### Static pod doesn't restart after manifest edit

Kubelet checksum-reconciles. If it's not picking up changes, restart kubelet:

```bash
sudo systemctl restart kubelet
```

### apiserver down after upgrade

`kubectl` stops working. Check the apiserver container on the CP node:

```bash
sudo crictl ps -a | grep apiserver
sudo crictl logs <container-id>
```

Common cause: a kubeadm upgrade that edited the manifest in a way that references a flag no longer supported. Roll back by editing the manifest to remove the bad flag, or restore from backup.

### Drain blocked by PDB or DaemonSet

```
error when evicting pod "foo": Cannot evict pod as it would violate the pod's disruption budget.
```

Use `--disable-eviction` to skip PDB (for urgent cases), or wait, or `kubectl delete pod` directly (bypasses eviction).

### Node shows old version after kubelet upgrade

```
kubectl get nodes
# cp-1   Ready   control-plane   365d   v1.29.3     ← still old?
```

Either kubelet wasn't restarted, or kubelet couldn't connect to apiserver to re-register. Check:

```bash
sudo systemctl status kubelet
sudo journalctl -u kubelet | tail
```

---

## Pre-upgrade backup

Before any production upgrade:

1. **etcd snapshot** (see etcd deck for procedure).
2. **Copy `/etc/kubernetes/pki/` + kubeconfigs** off-node.
3. **Note current versions** (`kubectl get nodes`, control plane images).
4. **Document any custom extraArgs** (in case you need to re-apply them).

If upgrade fails catastrophically, you restore etcd + re-init nodes.

---

## Manual control plane patch (non-upgrade use case)

Sometimes you want to change apiserver flags without a full kubeadm upgrade. Edit the manifest directly:

```bash
sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml
# Add/edit a flag in spec.containers[0].command

# kubelet detects the change and restarts apiserver.
```

For persistent changes that survive `kubeadm upgrade`, also edit `kubeadm-config` ConfigMap's ClusterConfiguration so future upgrades re-inject the same flags:

```bash
kubectl edit cm -n kube-system kubeadm-config
# Under apiServer.extraArgs: add your flags
```

---

## Partial / rollback scenarios

If an upgrade fails mid-way (say, CP-1 upgraded but CP-2 failed):

1. Keep CP-1 on the new version. Don't downgrade an upgraded node.
2. Fix whatever caused CP-2 to fail.
3. Retry `kubeadm upgrade node` on CP-2.

If the failure is "this new version has a bug and the cluster is unstable":

- Each static pod's manifest has the old image tag in etcd history; you can't trivially "roll back" a kubeadm upgrade.
- Options:
  - Edit the static pod manifest on the upgraded node to downgrade its image tag. Careful — configs may have changed between versions.
  - Restore from etcd snapshot + reset + re-init with the old kubeadm.
- Better: validate upgrades in staging first.

---

## Parallel CP upgrades (never)

```
# DON'T: two CPs upgrading simultaneously
# Risk: both apiservers restart, both etcd members restart, quorum lost.
```

Sequential only. Upgrade CP-1, verify, upgrade CP-2, verify, upgrade CP-3.

Parallel for workers is fine (if PDBs allow).

---

## Exam heuristics

- For upgrade questions, know the command sequence: `kubeadm upgrade plan`, `kubeadm upgrade apply` (first CP), `kubeadm upgrade node` (everyone else).
- Drain before upgrading kubelet. Uncordon after.
- Never upgrade two CP nodes at once.
- Packages to upgrade in order: kubeadm → run upgrade → kubelet + kubectl → restart kubelet.
- `kubeadm upgrade plan` previews without doing anything. Always run it first.

## Mental traps

- Skipping minor versions (1.28 → 1.30). Not allowed.
- Upgrading kubelet before running `kubeadm upgrade apply`/`node`. The component ordering matters.
- Forgetting to drain before upgrading kubelet. Brief pod disruption otherwise.
- Running `kubeadm upgrade apply` on multiple CP nodes. Only the FIRST uses `apply`; the rest use `node`.
- Upgrading the apiserver after the kubelet without checking skew. Version skew policy has limits.
- Not testing the upgrade in staging. Production is the wrong place to discover a CRD incompatibility.
- Manually editing static pod manifests to "upgrade" components. Use kubeadm; it handles the interactions.
- Not backing up etcd before an upgrade. Essential safety net.
