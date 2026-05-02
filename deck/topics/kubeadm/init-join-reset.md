## Three verbs, one cluster

`kubeadm` is the canonical cluster bootstrapper. It does three things:

- **`kubeadm init`** — turn a clean node into the first control plane node.
- **`kubeadm join`** — add a node (control plane or worker) to an existing cluster.
- **`kubeadm reset`** — undo init/join on this node, returning it to clean state.

The CKA exam assumes kubeadm clusters. Knowing what each verb does, and — more importantly — what it writes to disk, is table stakes.

---

## `kubeadm init` — bootstrapping from scratch

```bash
sudo kubeadm init \
  --control-plane-endpoint "k8s.example.com:6443" \
  --apiserver-advertise-address 10.0.0.1 \
  --pod-network-cidr 10.244.0.0/16 \
  --service-cidr 10.96.0.0/12 \
  --upload-certs
```

What happens, in order:

```
 1. Preflight checks
    - Kernel version, cgroup driver matches runtime's
    - Required ports available (6443, 2379, 2380, 10250, 10259, 10257)
    - Swap disabled (or swap-accounting configured)
    - /var/lib/etcd not already populated
    - kubelet service exists

 2. Pull images for control plane
    - kube-apiserver, kube-controller-manager, kube-scheduler
    - etcd, coredns, pause

 3. Generate PKI
    - /etc/kubernetes/pki/ca.crt + ca.key
    - /etc/kubernetes/pki/apiserver.crt + apiserver.key
    - /etc/kubernetes/pki/apiserver-kubelet-client.{crt,key}
    - /etc/kubernetes/pki/front-proxy-ca.{crt,key} + front-proxy-client.{crt,key}
    - /etc/kubernetes/pki/sa.{key,pub}  ← ServiceAccount token signing key
    - /etc/kubernetes/pki/etcd/ca.{crt,key}
    - /etc/kubernetes/pki/etcd/server.{crt,key}
    - /etc/kubernetes/pki/etcd/peer.{crt,key}
    - /etc/kubernetes/pki/etcd/healthcheck-client.{crt,key}
    - /etc/kubernetes/pki/apiserver-etcd-client.{crt,key}

 4. Generate kubeconfigs
    - /etc/kubernetes/admin.conf
    - /etc/kubernetes/super-admin.conf
    - /etc/kubernetes/controller-manager.conf
    - /etc/kubernetes/scheduler.conf
    - /etc/kubernetes/kubelet.conf

 5. Write static pod manifests
    - /etc/kubernetes/manifests/kube-apiserver.yaml
    - /etc/kubernetes/manifests/kube-controller-manager.yaml
    - /etc/kubernetes/manifests/kube-scheduler.yaml
    - /etc/kubernetes/manifests/etcd.yaml

 6. Start kubelet (via systemd), which picks up the static pods

 7. Wait for apiserver to respond on port 6443

 8. Mark this node as a control plane (node-role.kubernetes.io/control-plane)

 9. Install cluster addons
    - kube-proxy DaemonSet
    - CoreDNS Deployment

 10. (If --upload-certs) upload PKI to a Secret so other CP nodes can download it

 11. Print the join command (token + discovery hash)
```

Output includes something like:

```
Your Kubernetes control-plane has initialized successfully!

To start using your cluster, you need to run:
  mkdir -p $HOME/.kube
  sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
  sudo chown $(id -u):$(id -g) $HOME/.kube/config

Then you can join any number of worker nodes by running:
kubeadm join k8s.example.com:6443 \
  --token abcdef.0123456789abcdef \
  --discovery-token-ca-cert-hash sha256:1a2b3c...
```

Save that join command. You'll need it (or regenerate it later; more on that in the bootstrap-tokens subtopic).

### Key flags

| Flag | Purpose |
|------|---------|
| `--control-plane-endpoint` | DNS name / IP for HA setups. Embedded in certs and kubeconfigs. MUST be set for HA. |
| `--apiserver-advertise-address` | The IP apiserver advertises. Defaults to node's primary IP. |
| `--pod-network-cidr` | Pod CIDR. Must not overlap with node IPs. Many CNIs default to 10.244.0.0/16 (Flannel) or 192.168.0.0/16 (Calico). |
| `--service-cidr` | Service ClusterIP range. Default 10.96.0.0/12. |
| `--upload-certs` | Store CA keys as a short-lived Secret so other CP nodes can join with `--certificate-key`. |
| `--cri-socket` | Container runtime socket. Auto-detected usually, but explicit is safer. |
| `--kubernetes-version` | Pin a specific version. Default is latest stable. |
| `--config` | Use a ClusterConfiguration YAML instead of CLI flags. Preferred for real clusters. |

### `kubeadm init` with a config file

For production, use a config instead of flags:

```yaml
# /tmp/kubeadm-config.yaml
apiVersion: kubeadm.k8s.io/v1beta4
kind: InitConfiguration
bootstrapTokens:
- token: abcdef.0123456789abcdef
  ttl: 24h0m0s
localAPIEndpoint:
  advertiseAddress: 10.0.0.1
  bindPort: 6443
nodeRegistration:
  criSocket: unix:///var/run/containerd/containerd.sock
---
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
kubernetesVersion: v1.29.0
controlPlaneEndpoint: k8s.example.com:6443
networking:
  podSubnet: 10.244.0.0/16
  serviceSubnet: 10.96.0.0/12
apiServer:
  extraArgs:
    authorization-mode: Node,RBAC
  certSANs:
  - k8s.example.com
  - 10.0.0.1
  - 10.0.0.2
etcd:
  local:
    dataDir: /var/lib/etcd
```

Then:

```bash
sudo kubeadm init --config /tmp/kubeadm-config.yaml --upload-certs
```

More fields: `controllerManager.extraArgs`, `scheduler.extraArgs`, custom image repository, etc. See the control-plane-customization subtopic.

---

## `kubeadm join` — adding nodes

Two variants: worker join and control-plane join.

### Worker join

```bash
sudo kubeadm join k8s.example.com:6443 \
  --token abcdef.0123456789abcdef \
  --discovery-token-ca-cert-hash sha256:1a2b3c...
```

What happens:

```
 1. Preflight checks (same as init).

 2. Discover cluster's CA public key
    - Contact control-plane-endpoint
    - Verify returned CA matches --discovery-token-ca-cert-hash
    - Writes /etc/kubernetes/pki/ca.crt

 3. Authenticate to apiserver using bootstrap token
    - User: system:bootstrap:<token-id>
    - Group: system:bootstrappers:kubeadm:default-node-token
    - Authorized via pre-installed RBAC to create CSRs

 4. Kubelet creates a CSR
    - CN=system:node:<nodename>, O=system:nodes

 5. CSR auto-approved
    - By kube-controller-manager's CSR approver
    - Signed with cluster CA

 6. Kubelet receives its client cert
    - Written to /var/lib/kubelet/pki/kubelet-client-current.pem (symlink)
    - Kubelet's kubeconfig /etc/kubernetes/kubelet.conf references this cert

 7. Kubelet starts
    - Connects to apiserver with its new cert
    - Registers as a Node

 8. kube-proxy DaemonSet picks up this node and schedules a pod there
```

Nothing on the control plane is modified; the new Node appears via registration. That's it.

### Control-plane join

Requires the extra `--control-plane` flag and the certificate key (from `--upload-certs`):

```bash
# On the first CP node, to regenerate the certificate key:
sudo kubeadm init phase upload-certs --upload-certs
# prints a new certificate-key

# On the new CP node:
sudo kubeadm join k8s.example.com:6443 \
  --token abcdef.0123456789abcdef \
  --discovery-token-ca-cert-hash sha256:1a2b3c... \
  --control-plane \
  --certificate-key ...
```

Extra steps beyond worker join:

```
 4b. Download control-plane certs from uploaded Secret (encrypted with --certificate-key)
     - ca.crt+key, front-proxy-ca.crt+key, etcd/ca.crt+key, sa.key+pub
     - Decrypt with the certificate-key

 5b. Generate this node's own certs locally
     - apiserver.crt, apiserver-kubelet-client.crt, etc.
     - All signed with downloaded CA keys

 6b. Write control-plane kubeconfigs
     - controller-manager.conf, scheduler.conf

 7b. Generate static pod manifests for apiserver / CM / scheduler / etcd
     - etcd joins existing cluster as a new member (member add via controller)

 8b. Mark this node as control plane
```

The `--certificate-key` is short-lived (2 hours by default). Re-run `init phase upload-certs --upload-certs` to get a fresh one when needed.

---

## `kubeadm reset` — undo

```bash
sudo kubeadm reset --force
```

What it undoes:

```
 1. Stop kubelet service
 2. Remove static pod manifests in /etc/kubernetes/manifests/
 3. Remove kubeconfigs in /etc/kubernetes/ (admin.conf, kubelet.conf, etc.)
 4. Remove /etc/kubernetes/pki/ (all certs and keys)
 5. For CP nodes with stacked etcd: remove member from etcd cluster first,
    then wipe /var/lib/etcd
 6. Clean /var/lib/kubelet/ (pods, plugins, etc.)
 7. Restore original kubelet systemd unit
 8. Remove /etc/cni/net.d/ optionally (not by default)
```

What it does NOT undo automatically:

- **iptables / IPVS rules** — kubelet and kube-proxy programmed rules during operation. Reset prints a reminder:
  ```
  The reset process does not reset or clean up iptables rules or IPVS tables.
  If you wish to reset iptables, you must do so manually by using the "iptables" command.
  ```
  Clean up manually:
  ```bash
  sudo iptables -F && sudo iptables -X && sudo iptables -t nat -F && sudo iptables -t nat -X
  sudo iptables -t mangle -F && sudo iptables -t mangle -X
  sudo ipvsadm -C                   # if IPVS mode
  ```

- **CNI config** — `/etc/cni/net.d/` stays unless you add `--cni-confg-dir-to-cleanup /etc/cni/net.d` (or remove manually). If you re-init on the same node, old CNI config may conflict.

- **CNI plugin binaries** in `/opt/cni/bin/` — stay. Usually fine.

- **Container runtime state** — containers and images are runtime-managed:
  ```bash
  sudo crictl ps -a
  sudo crictl rm $(sudo crictl ps -aq)
  sudo crictl rmi --prune
  ```

After reset, the node looks clean to kubeadm but has leftover rules/state you'll want to clean manually before re-initing.

---

## Common init/join failures

### `preflight check failed: port-6443 is in use`

Something's already listening on 6443. Either a previous init wasn't cleaned, or another service (apache, nginx, etc.) has the port.

```bash
sudo ss -tlnp | grep :6443
sudo systemctl status kubelet      # is a kubelet running with apiserver?
sudo kubeadm reset --force         # if you want to start fresh
```

### `CRI endpoint is not configured properly`

Kubeadm can't find the CRI socket. Either the runtime isn't installed, or the socket path is non-standard.

```bash
# Is containerd running?
sudo systemctl status containerd

# Correct socket?
ls /var/run/containerd/containerd.sock

# Provide explicitly:
kubeadm init --cri-socket unix:///var/run/containerd/containerd.sock
```

### `couldn't validate the identity of the API Server`

Join flow; the `--discovery-token-ca-cert-hash` doesn't match the CA presented by the apiserver.

- Typo in the hash — regenerate join command from a CP node.
- Cluster CA rotated without updating the discovery hash.
- DNS resolving `--control-plane-endpoint` to a different cluster's endpoint.

```bash
# Regenerate join command with fresh hash
kubeadm token create --print-join-command
```

### `error execution phase kubelet-start: timed out waiting for kubelet`

Join flow. Kubelet didn't come up within the timeout.

- Check kubelet logs: `sudo journalctl -u kubelet | tail -100`
- Common causes: cgroup driver mismatch, swap not disabled, CNI not present.

### Swap not disabled

```
[ERROR Swap]: running with swap on is not supported. Please disable swap
```

Fix:

```bash
sudo swapoff -a
# Persistent: edit /etc/fstab, comment out swap line
```

Or allow swap (from 1.28+, kubelet supports it with config):

```yaml
# /var/lib/kubelet/config.yaml
memorySwap:
  swapBehavior: LimitedSwap
```

But simpler to disable swap for exam scenarios.

### Cgroup driver mismatch

```
cgroup driver ("cgroupfs") different from docker cgroup driver ("systemd")
```

Fix: align kubelet and runtime (both should use `systemd` on modern distros):

```yaml
# /var/lib/kubelet/config.yaml
cgroupDriver: systemd

# /etc/containerd/config.toml
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
  SystemdCgroup = true
```

Restart both: `sudo systemctl restart containerd && sudo systemctl restart kubelet`.

---

## Regenerating the join command

Bootstrap tokens expire (default 24h). After that, new nodes can't join with the original token. Create a new one:

```bash
# On an existing CP node:
sudo kubeadm token create --print-join-command
# Output:
# kubeadm join k8s.example.com:6443 --token <new> --discovery-token-ca-cert-hash sha256:<hash>
```

For CP join (fresh certificate-key):

```bash
sudo kubeadm init phase upload-certs --upload-certs
# prints a new certificate-key valid for 2 hours
```

Combine:

```bash
sudo kubeadm token create --print-join-command
sudo kubeadm init phase upload-certs --upload-certs
# Then assemble the final join command with --control-plane --certificate-key <key>
```

---

## `kubeadm init phase` — fine-grained control

`init` runs many phases in sequence. You can run individual phases:

```bash
# Just generate certs (without starting anything)
sudo kubeadm init phase certs all

# Just write kubeconfigs
sudo kubeadm init phase kubeconfig all

# Just write static pod manifests
sudo kubeadm init phase control-plane all

# Upload-certs independently (regenerates cert key)
sudo kubeadm init phase upload-certs --upload-certs
```

Useful for:

- External CA mode (provide your own certs, skip cert generation).
- Recovering from partial init failure (re-run from a phase that failed).
- Scripted cluster builds where you want granular control.

List all phases:

```bash
kubeadm init phase --help
```

---

## External CA mode

Kubeadm can skip cert generation and let you provide everything:

1. Provide `ca.crt` (no ca.key), `front-proxy-ca.crt`, `etcd/ca.crt` — just the public parts.
2. Provide every leaf cert signed externally:
   - `apiserver.crt`, `apiserver-kubelet-client.crt`, `apiserver-etcd-client.crt`, `front-proxy-client.crt`.
   - `etcd/server.crt`, `etcd/peer.crt`, `etcd/healthcheck-client.crt`.

Kubeadm detects missing CA private keys and runs in external CA mode. `kubeadm certs renew` won't work (no signing key locally).

Use case: high-security environments where the CA key never leaves an offline signing box.

---

## What gets lost on a wipe-node-without-reset

If a cluster node disappears without kubeadm reset (disk failure, VM recycled):

- **Worker**: the Node object lingers in apiserver as `NotReady`. Delete it: `kubectl delete node <n>`. Workloads reschedule elsewhere.
- **CP node**: etcd still thinks this member exists. `etcdctl member remove <id>` to clean up, then `kubectl delete node <n>`.

Then build a new node and join (with a fresh token + join command).

---

## Exam heuristics

- For "bootstrap a cluster," `kubeadm init` with pod-network-cidr set.
- For "add a worker," `kubeadm join` with the saved/regenerated token.
- For "add a control plane node," `kubeadm join --control-plane --certificate-key`.
- `kubeadm reset --force` cleans a node. Follow with iptables flush and runtime cleanup for a truly fresh node.
- `kubeadm token create --print-join-command` regenerates the join command.
- `kubeadm init phase upload-certs --upload-certs` regenerates the certificate-key.

## Mental traps

- Forgetting `--control-plane-endpoint` on first init. Adding HA later requires re-certing all kubeconfigs and pods.
- Running `kubeadm reset` without cleaning iptables / CNI config. Next init inherits old state.
- Using the wrong kubeconfig after init. `/etc/kubernetes/admin.conf` is the right one; other files have different identities.
- Joining a node with a wrong/old token. Generate a new one; don't use stale tokens.
- Skipping preflight checks with `--ignore-preflight-errors=all` without understanding the risk.
- Expecting `kubeadm reset` to remove the node from the cluster's API view. It doesn't — use `kubectl delete node <n>` from a surviving CP.
- Forgetting that `--upload-certs`'s certificate-key is short-lived (2 hours). Plan CP joins accordingly.
