## Two places to change control plane behavior

You can customize a kubeadm cluster's control plane either:

1. **Declaratively**, via `ClusterConfiguration` in a YAML passed to `kubeadm init` (or stored in the `kubeadm-config` ConfigMap).
2. **Imperatively**, by editing `/etc/kubernetes/manifests/*.yaml` directly on each CP node.

Option 1 is durable (survives upgrades); option 2 is immediate (kubelet picks up within seconds). Both are valid; prefer the declarative path for anything permanent.

---

## The ClusterConfiguration object

Example with many customizations:

```yaml
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
kubernetesVersion: v1.30.0
controlPlaneEndpoint: k8s.example.com:6443
imageRepository: registry.k8s.io             # or custom mirror
certificatesDir: /etc/kubernetes/pki

networking:
  podSubnet: 10.244.0.0/16
  serviceSubnet: 10.96.0.0/12
  dnsDomain: cluster.local

apiServer:
  certSANs:
  - k8s.example.com
  - lb.internal.example.com
  - 10.0.0.100
  extraArgs:
  - name: audit-log-path
    value: /var/log/audit.log
  - name: audit-log-maxage
    value: "30"
  - name: authorization-mode
    value: Node,RBAC
  - name: enable-admission-plugins
    value: NodeRestriction,PodSecurity,ResourceQuota
  extraVolumes:
  - name: audit-log
    hostPath: /var/log
    mountPath: /var/log
    pathType: DirectoryOrCreate

controllerManager:
  extraArgs:
  - name: bind-address
    value: 0.0.0.0
  - name: terminated-pod-gc-threshold
    value: "500"

scheduler:
  extraArgs:
  - name: bind-address
    value: 0.0.0.0

etcd:
  local:
    dataDir: /var/lib/etcd
    extraArgs:
      quota-backend-bytes: "8589934592"       # 8 GiB quota
```

Apply at init time:

```bash
sudo kubeadm init --config kubeadm-config.yaml --upload-certs
```

Or edit the live ConfigMap after init:

```bash
kubectl edit cm -n kube-system kubeadm-config
```

---

## `extraArgs` — adding flags to components

Before kubeadm 1.30, `extraArgs` was a map. After 1.30, it's a list of name/value pairs (to support repeated keys like admission plugins).

Old form (pre-1.30):

```yaml
apiServer:
  extraArgs:
    audit-log-path: /var/log/audit.log
    audit-log-maxage: "30"
```

New form (1.30+):

```yaml
apiServer:
  extraArgs:
  - name: audit-log-path
    value: /var/log/audit.log
  - name: audit-log-maxage
    value: "30"
```

Same effect: these flags are added to the apiserver's `command:` in the static pod manifest.

### When flag changes take effect

Editing `kubeadm-config` ConfigMap **does not automatically rerender static pod manifests**. You need to trigger a regeneration:

```bash
sudo kubeadm init phase control-plane apiserver         # regenerate apiserver manifest
sudo kubeadm init phase control-plane controller-manager
sudo kubeadm init phase control-plane scheduler
```

This rewrites the static pod manifests. kubelet picks up the changes and restarts the pods.

On CP nodes other than the first, `kubeadm upgrade node` does this regeneration as part of a normal upgrade flow. For a flag change without a full upgrade, run the relevant init phase on each CP node.

---

## `extraVolumes` — mounting extra paths

Controllers often need to see files from the host (audit logs, admission webhook configs, etc.). `extraVolumes` adds hostPath mounts to the static pod:

```yaml
apiServer:
  extraArgs:
  - name: audit-log-path
    value: /var/log/audit.log
  - name: audit-policy-file
    value: /etc/kubernetes/audit-policy.yaml
  extraVolumes:
  - name: audit-policy
    hostPath: /etc/kubernetes/audit-policy.yaml
    mountPath: /etc/kubernetes/audit-policy.yaml
    pathType: File
    readOnly: true
  - name: audit-log
    hostPath: /var/log
    mountPath: /var/log
    pathType: DirectoryOrCreate
```

After regeneration, the apiserver pod can read the policy file and write to the audit log directory on the host.

---

## Editing static pod manifests directly

For quick changes or cases the ClusterConfiguration doesn't expose cleanly:

```bash
sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml
```

Add a flag:

```yaml
spec:
  containers:
  - name: kube-apiserver
    command:
    - kube-apiserver
    - --advertise-address=10.0.0.1
    - --allow-privileged=true
    - --authorization-mode=Node,RBAC
    - --audit-log-path=/var/log/audit.log           # ← new flag
    - --audit-log-maxage=30                          # ← new flag
    ...
```

Save. Kubelet sees the change within ~30 seconds and restarts apiserver with the new flags.

**Caveats**:

- This change is **local to this CP node**. If you have HA, repeat on every CP.
- Not durable across `kubeadm upgrade` — it re-renders manifests from kubeadm-config. Always also update `kubeadm-config` if you want permanence.
- Typos in `command:` make apiserver CrashLoopBackOff. Have a backup of the manifest.

---

## Common customizations

### Enabling admission plugins

```yaml
apiServer:
  extraArgs:
  - name: enable-admission-plugins
    value: NodeRestriction,PodSecurity,ResourceQuota,LimitRanger,DefaultStorageClass
  - name: disable-admission-plugins
    value: AlwaysAdmit
```

Regenerate apiserver manifest for this to take effect.

### Audit logging

```yaml
apiServer:
  extraArgs:
  - name: audit-log-path
    value: /var/log/audit.log
  - name: audit-log-maxage
    value: "30"
  - name: audit-log-maxbackup
    value: "10"
  - name: audit-log-maxsize
    value: "100"
  - name: audit-policy-file
    value: /etc/kubernetes/audit-policy.yaml
  extraVolumes:
  - name: audit-policy
    hostPath: /etc/kubernetes/audit-policy.yaml
    mountPath: /etc/kubernetes/audit-policy.yaml
    pathType: File
    readOnly: true
  - name: audit-log
    hostPath: /var/log
    mountPath: /var/log
    pathType: DirectoryOrCreate
```

Policy file (example):

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
- level: Metadata
```

Apply policy to every CP node (same path, same content).

### Encryption at rest

Secrets stored in etcd can be encrypted:

```yaml
apiServer:
  extraArgs:
  - name: encryption-provider-config
    value: /etc/kubernetes/encryption-config.yaml
  extraVolumes:
  - name: encryption-config
    hostPath: /etc/kubernetes/encryption-config.yaml
    mountPath: /etc/kubernetes/encryption-config.yaml
    pathType: File
    readOnly: true
```

```yaml
# /etc/kubernetes/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  providers:
  - aescbc:
      keys:
      - name: key1
        secret: <base64-32-byte-key>
  - identity: {}
```

Every CP node needs the same encryption config file. Rotation involves adding a new key as first in the list, re-writing all secrets, then removing the old key.

### Feature gates

```yaml
apiServer:
  extraArgs:
  - name: feature-gates
    value: "FeatureA=true,FeatureB=false"
controllerManager:
  extraArgs:
  - name: feature-gates
    value: "FeatureA=true"
scheduler:
  extraArgs:
  - name: feature-gates
    value: "FeatureA=true"
```

Feature gates enable alpha/beta features. Useful for trying out features before they're GA.

---

## KubeletConfiguration — node-level tuning

Separately from ClusterConfiguration, kubelet has its own config. For cluster-wide kubelet settings at init:

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
maxPods: 250                           # default 110
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"
clusterDNS:
- 10.96.0.10
authentication:
  webhook:
    enabled: true
authorization:
  mode: Webhook
rotateCertificates: true
serverTLSBootstrap: true
```

Include in the same `--config` YAML used for `kubeadm init`. All joining nodes download this via the `kubelet-config` ConfigMap and write it to their local `/var/lib/kubelet/config.yaml`.

For per-node overrides (after join), edit `/var/lib/kubelet/config.yaml` on that node and `systemctl restart kubelet`.

---

## Changing the kubelet config cluster-wide after init

If you realize you want to change kubelet config (say, add a taint tolerance for an internal feature), two approaches:

### Via kubelet-config ConfigMap

```bash
kubectl edit cm -n kube-system kubelet-config
# update the embedded KubeletConfiguration
```

This changes what newly-joining nodes download. **Existing nodes are unaffected** — they already have their own `config.yaml` on disk.

To apply the new config to all existing nodes:

```bash
for node in $(kubectl get nodes -o name | sed 's|node/||'); do
  # For each node:
  ssh $node sudo kubeadm upgrade node phase kubelet-config
  ssh $node sudo systemctl restart kubelet
done
```

`kubeadm upgrade node phase kubelet-config` downloads the current ConfigMap and writes it to `/var/lib/kubelet/config.yaml`. A restart makes kubelet read the new config.

### Per-node direct edit

Sometimes you want a per-node override (e.g. one node has a larger memory eviction threshold). Edit `/var/lib/kubelet/config.yaml` directly and restart kubelet. Won't be overwritten until the next `kubeadm upgrade node`.

---

## Changing the certSANs after init

Adding a new DNS name or IP for the apiserver requires:

1. Edit the kubeadm-config ConfigMap, add to `apiServer.certSANs`.
2. Delete the existing apiserver cert.
3. Regenerate.
4. Restart apiserver.

```bash
# Edit config:
kubectl edit cm -n kube-system kubeadm-config
# Add under apiServer.certSANs: - new.example.com

# On each CP node:
sudo rm /etc/kubernetes/pki/apiserver.crt /etc/kubernetes/pki/apiserver.key
sudo kubeadm init phase certs apiserver

# Restart apiserver by touching the manifest
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sleep 10
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
```

Do this on each CP node. Clients using the new SAN now validate correctly.

---

## Custom image repository

For air-gapped environments or corporate mirrors:

```yaml
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
imageRepository: "my-registry.example.com/kubernetes"
```

kubeadm pulls images from `my-registry.example.com/kubernetes/kube-apiserver:v1.30.0` instead of `registry.k8s.io/kube-apiserver:v1.30.0`. You're responsible for mirroring all required images to your registry first.

`kubeadm config images list` shows you what images are needed for a given version.

---

## Modifying the `kubeadm-config` ConfigMap

Any changes to cluster-wide kubeadm config go here:

```bash
kubectl edit cm -n kube-system kubeadm-config
```

Content is a YAML blob containing `ClusterConfiguration`, `ClusterStatus` (older kubeadm), and some metadata. Edit the ClusterConfiguration.

After editing:

- `kubeadm upgrade apply <same-version>` re-renders manifests with new config (but you have to run on every CP).
- Or: `kubeadm init phase control-plane <component>` to re-render just one component's manifest.

Why edit the ConfigMap instead of the live manifests? Because `kubeadm upgrade` reads the ConfigMap as its source of truth — without updating it, an upgrade will re-render with the old config and wipe your manual manifest edits.

---

## Customizing kube-proxy

kube-proxy runs as a DaemonSet. Its ConfigMap holds the `KubeProxyConfiguration`:

```bash
kubectl edit cm -n kube-system kube-proxy
```

```yaml
data:
  config.conf: |
    apiVersion: kubeproxy.config.k8s.io/v1alpha1
    kind: KubeProxyConfiguration
    mode: iptables                   # or ipvs, nftables
    clusterCIDR: 10.244.0.0/16
    iptables:
      minSyncPeriod: 1s
```

After edits, restart the DaemonSet:

```bash
kubectl rollout restart ds -n kube-system kube-proxy
```

Switching modes (`iptables` → `ipvs`) requires kernel module support; see kube-proxy deck.

---

## Customizing CoreDNS

CoreDNS's Corefile is in a ConfigMap:

```bash
kubectl edit cm -n kube-system coredns
```

```yaml
data:
  Corefile: |
    .:53 {
        errors
        health { lameduck 5s }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
           pods insecure
           fallthrough in-addr.arpa ip6.arpa
           ttl 30
        }
        prometheus :9153
        forward . 8.8.8.8 1.1.1.1 {        # explicit upstream
           max_concurrent 1000
        }
        cache 30
        loop
        reload
        loadbalance
    }
```

Changes propagate to CoreDNS pods via the `reload` plugin (watches Corefile for changes; reloads). Can take ~2 minutes for ConfigMap-mount updates to reach the pods; roll the Deployment to apply immediately:

```bash
kubectl rollout restart deploy -n kube-system coredns
```

---

## Recapping the customization mental model

```
 ClusterConfiguration (in kubeadm-config CM)
    ↓ (regenerated at kubeadm init / upgrade time)
 Static pod manifests in /etc/kubernetes/manifests/
    ↓ (watched by kubelet)
 Control plane pods run with new flags

 KubeletConfiguration (in kubelet-config CM)
    ↓ (downloaded via kubeadm join / upgrade node)
 /var/lib/kubelet/config.yaml
    ↓ (read on kubelet start)
 kubelet behavior

 KubeProxyConfiguration (in kube-proxy CM)
    ↓ (read by kube-proxy pods on start)
 iptables / IPVS rules on each node

 Corefile (in coredns CM)
    ↓ (hot-reloaded by CoreDNS)
 DNS plugin behavior
```

Edit the ConfigMap, apply, restart (or trigger a rollout) to propagate.

---

## Exam heuristics

- For "add a flag to apiserver," either edit `/etc/kubernetes/manifests/kube-apiserver.yaml` (quick) or `kubeadm-config` ConfigMap + re-run init phase (durable).
- For "change kubelet config," edit `/var/lib/kubelet/config.yaml` + `systemctl restart kubelet`.
- For "add a SAN to apiserver cert," edit `kubeadm-config`, delete old cert, `kubeadm init phase certs apiserver`, restart apiserver.
- `kubeadm upgrade apply` re-renders manifests from `kubeadm-config` — custom manifest edits are lost if not reflected in the ConfigMap.

## Mental traps

- Editing static pod manifests and forgetting to also update `kubeadm-config`. Next upgrade overwrites.
- Editing `kubelet-config` ConfigMap expecting existing nodes to update. They don't — it's a template for new joins.
- Adding a flag and typing it wrong. Apiserver CrashLoopBackOff. Have a backup.
- Using pre-1.30 `extraArgs` syntax on newer clusters (or vice versa). The format changed; check your kubeadm version.
- Changing feature gates on apiserver but not controller-manager / scheduler. Must match.
- Adding certSAN without regenerating the cert. The SAN in the ConfigMap is metadata; the cert is what TLS uses.
- Restarting kubelet via `kubeadm reset` instead of `systemctl restart kubelet`. Reset destroys the node.
