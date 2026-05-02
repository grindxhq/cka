## Everything kubeadm writes to disk

A fresh `kubeadm init` creates ~30 files. Knowing where each lives and what it does turns "the cluster is broken" into "that specific file is wrong."

```
/etc/kubernetes/
├── admin.conf                     kubeconfig for humans
├── super-admin.conf               kubeconfig with system:masters (breakglass)
├── kubelet.conf                   kubeconfig kubelet uses
├── controller-manager.conf        kubeconfig for kube-controller-manager
├── scheduler.conf                 kubeconfig for kube-scheduler
│
├── manifests/                     static pods kubelet watches
│   ├── etcd.yaml
│   ├── kube-apiserver.yaml
│   ├── kube-controller-manager.yaml
│   └── kube-scheduler.yaml
│
└── pki/                           all certificates
    ├── ca.crt + ca.key            cluster root CA
    ├── apiserver.crt + apiserver.key              apiserver serving cert
    ├── apiserver-kubelet-client.{crt,key}         apiserver → kubelet
    ├── apiserver-etcd-client.{crt,key}            apiserver → etcd
    ├── front-proxy-ca.{crt,key}                    extension apiserver CA
    ├── front-proxy-client.{crt,key}                apiserver → extension API servers
    ├── sa.key + sa.pub             ServiceAccount JWT signing keypair (not a cert)
    └── etcd/
        ├── ca.{crt,key}                            etcd CA
        ├── server.{crt,key}                        etcd server TLS
        ├── peer.{crt,key}                          etcd peer-to-peer TLS
        └── healthcheck-client.{crt,key}            etcd liveness probe

/var/lib/kubelet/
├── config.yaml                    kubelet's own config
├── kubeadm-flags.env              systemd drop-in for kubelet flags
└── pki/
    └── kubelet-client-current.pem  kubelet client cert (symlink, auto-rotated)
    └── kubelet.crt (kubelet.key)   kubelet serving cert (if rotation enabled)

/var/lib/etcd/                     etcd data directory (on stacked CP nodes)

/etc/systemd/system/kubelet.service.d/
└── 10-kubeadm.conf                systemd unit drop-in

/etc/default/kubelet               (or /etc/sysconfig/kubelet on RHEL)
                                   KUBELET_EXTRA_ARGS env var source
```

Now walk each section.

---

## `/etc/kubernetes/pki/` — the certificate tree

Three independent CAs:

```
cluster CA              ca.crt / ca.key
front-proxy CA          front-proxy-ca.crt / front-proxy-ca.key
etcd CA                 etcd/ca.crt / etcd/ca.key
```

These are fully separate trust chains. A cert issued by the etcd CA does not validate against the cluster CA.

### Cluster CA (`ca.crt` / `ca.key`)

Signs most certs:

- `apiserver.crt` — served by kube-apiserver on :6443 (HTTPS cert).
- `apiserver-kubelet-client.crt` — apiserver presents this when it calls kubelet (for `kubectl logs`, `exec`, metrics).
- All kubeadm-generated client certs embedded in kubeconfigs.
- `kubelet-client-current.pem` (from CSR flow) — kubelet's own client cert.

Details:

```bash
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -subject -issuer -dates -ext subjectAltName

# Subject: CN=kube-apiserver
# Issuer: CN=kubernetes
# SubjectAltName: DNS:kubernetes, DNS:kubernetes.default, DNS:kubernetes.default.svc,
#                 DNS:kubernetes.default.svc.cluster.local, DNS:<node-hostname>,
#                 IP Address:10.96.0.1, IP Address:<node-ip>
```

The SAN list is critical — clients that connect by a name not in the SAN fail TLS. That's why `--control-plane-endpoint` matters at init time; kubeadm injects it into the SAN.

### etcd CA (`etcd/ca.crt` / `etcd/ca.key`)

Signs etcd's own certs:

- `etcd/server.crt` — etcd serves client (apiserver) and peer traffic.
- `etcd/peer.crt` — used between etcd members on port :2380.
- `etcd/healthcheck-client.crt` — for the liveness probe.
- `apiserver-etcd-client.crt` — apiserver connects to etcd with this (but it's stored in the main pki dir, not in pki/etcd/).

### Front-proxy CA (`front-proxy-ca.crt` / `front-proxy-ca.key`)

For the aggregation layer. When an extension apiserver (metrics-server, custom APIs) receives a request from the main apiserver, it uses the front-proxy CA to verify that the caller is the legitimate Kubernetes apiserver acting on behalf of a user. `front-proxy-client.crt` is what the apiserver presents.

### Service account keypair (`sa.key` / `sa.pub`)

Not a cert. An asymmetric keypair used by the apiserver to sign and verify ServiceAccount JWTs.

- `sa.key` — apiserver signs tokens.
- `sa.pub` — apiserver verifies tokens.

**Must be identical on every control plane node.** A token signed by CP1 using CP1's sa.key cannot be verified by CP2 unless CP2 has the same sa.pub. During HA join, the key pair is copied to each new CP node.

---

## kubeconfigs — `/etc/kubernetes/*.conf`

Five files, each with an embedded client cert:

### `admin.conf`

The human operator's kubeconfig. Subject:

```
Subject: CN=kubernetes-admin, O=kubeadm:cluster-admins
Issuer: CN=kubernetes
```

Group `kubeadm:cluster-admins` is bound to the `cluster-admin` ClusterRole by default. This is the "god mode" kubeconfig.

Typical usage: copy to `~/.kube/config` for the operator.

### `super-admin.conf` (newer kubeadm)

Subject uses `system:masters` group, which bypasses RBAC entirely (the apiserver short-circuits authorization for system:masters). Break-glass access if RBAC gets misconfigured.

Not a regular-use file. Keep safe; don't distribute.

### `kubelet.conf`

```
Subject: CN=system:node:<nodename>, O=system:nodes
```

This is the identity kubelet uses to authenticate to the apiserver. The `system:nodes` group is what the Node authorizer keys off of (see api-server → authn-authz-admission deck).

On new joins, the initial `kubelet.conf` has a short-lived cert; kubelet then requests a longer-lived one via CSR and swaps to that.

### `controller-manager.conf`

```
Subject: CN=system:kube-controller-manager
```

Identity used by kube-controller-manager. Bound to `system:kube-controller-manager` ClusterRole.

### `scheduler.conf`

```
Subject: CN=system:kube-scheduler
```

Identity used by kube-scheduler. Bound to `system:kube-scheduler` ClusterRole.

---

## `/etc/kubernetes/manifests/` — static pods

Four YAML files. kubelet watches this directory and runs whatever pod manifests it finds there directly, without going through the apiserver.

```
etcd.yaml                       etcd (stacked)
kube-apiserver.yaml             apiserver
kube-controller-manager.yaml    controller-manager
kube-scheduler.yaml             scheduler
```

Key properties of these static pods:

- Not managed by any controller.
- Kubelet recreates them if deleted.
- Editing the YAML causes kubelet to restart the pod with the new spec.
- Moving a YAML file out of this dir stops the pod.

This is how you tune control plane components: `sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml`, edit the `command:` line, save. Kubelet picks it up within ~30 seconds.

See static-pods deck for detailed mechanics.

---

## `/var/lib/kubelet/` — kubelet's working dir

### `config.yaml`

Kubelet's own configuration. Format: `KubeletConfiguration` API object.

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
authentication:
  anonymous: { enabled: false }
  webhook: { enabled: true }
  x509: { clientCAFile: /etc/kubernetes/pki/ca.crt }
authorization: { mode: Webhook }
cgroupDriver: systemd
clusterDomain: cluster.local
clusterDNS:
- 10.96.0.10
staticPodPath: /etc/kubernetes/manifests
rotateCertificates: true
serverTLSBootstrap: true
evictionHard:
  imagefs.available: 0%
  memory.available: 100Mi
  nodefs.available: 10%
```

Edit this file + `systemctl restart kubelet` to change kubelet behavior.

### `pki/kubelet-client-current.pem`

A symlink to the current kubelet client cert. Auto-rotated by kubelet via CSR when the cert nears expiry.

```bash
ls -la /var/lib/kubelet/pki/
# kubelet-client-current.pem -> kubelet-client-<timestamp>.pem
# kubelet-client-<timestamp>.pem
```

The previous cert is kept briefly then deleted.

Kubelet's own `kubeconfig` (`/etc/kubernetes/kubelet.conf`) references this symlink path, so rotation is transparent.

### `pods/`

Per-pod working directories:

```
/var/lib/kubelet/pods/<pod-uid>/
├── containers/
├── volumes/           mounted volumes, per-type
│   ├── kubernetes.io~secret/
│   ├── kubernetes.io~configmap/
│   ├── kubernetes.io~projected/
│   └── kubernetes.io~csi/
├── plugins/
└── etc-hosts
```

`ls /var/lib/kubelet/pods/` on a node shows every pod's working state. Useful for CSI debugging.

### `plugins_registry/`

CSI driver sockets for kubelet's plugin-watcher:

```
/var/lib/kubelet/plugins_registry/
└── ebs.csi.aws.com/
    └── csi.sock
```

See kubelet → cri-cni-csi-interfaces deck.

---

## `/etc/systemd/system/kubelet.service.d/10-kubeadm.conf`

The systemd drop-in that tells kubelet where its config lives:

```ini
[Service]
Environment="KUBELET_KUBECONFIG_ARGS=--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf"
Environment="KUBELET_CONFIG_ARGS=--config=/var/lib/kubelet/config.yaml"
Environment="KUBELET_KUBEADM_ARGS=--container-runtime-endpoint=unix:///var/run/containerd/containerd.sock --pod-infra-container-image=registry.k8s.io/pause:3.9"
EnvironmentFile=-/etc/default/kubelet

ExecStart=
ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
```

Changing kubelet CLI flags usually means editing `/etc/default/kubelet` (the `KUBELET_EXTRA_ARGS` env var source) rather than this file. After changes:

```bash
sudo systemctl daemon-reload
sudo systemctl restart kubelet
```

---

## etcd data (`/var/lib/etcd/`)

On stacked etcd (default), the etcd static pod mounts `/var/lib/etcd` as its data directory.

```
/var/lib/etcd/
└── member/
    ├── snap/
    │   ├── db                          boltdb file — the actual keyspace
    │   └── *.snap                      periodic Raft snapshots
    └── wal/
        └── *.wal                       Raft write-ahead log
```

**Do not manually edit anything in here.** Wiping this directory (or losing the disk) destroys the cluster's state, recoverable only from an etcd snapshot.

See etcd deck for snapshot / restore procedures.

---

## Recap — what kubeadm writes

| Path                                                     | Purpose                                                       |
|----------------------------------------------------------|---------------------------------------------------------------|
| `/etc/kubernetes/pki/`                                    | Cluster CA, apiserver certs, client certs, sa keypair         |
| `/etc/kubernetes/pki/etcd/`                               | etcd CA and server/peer/healthcheck certs                     |
| `/etc/kubernetes/*.conf`                                  | kubeconfigs for admin, kubelet, CM, scheduler                  |
| `/etc/kubernetes/manifests/*.yaml`                        | Control plane static pod manifests                            |
| `/var/lib/kubelet/config.yaml`                            | Kubelet's KubeletConfiguration                                 |
| `/var/lib/kubelet/pki/`                                   | Kubelet's own rotated client cert                              |
| `/var/lib/etcd/`                                          | etcd data (on CP nodes with stacked etcd)                      |
| `/etc/systemd/system/kubelet.service.d/10-kubeadm.conf`   | systemd drop-in pointing at config files                        |
| `/etc/default/kubelet`                                    | env var source for KUBELET_EXTRA_ARGS                          |

Know these paths; they're where exam scenarios will have you operate.

---

## The ConfigMaps kubeadm maintains in-cluster

Beyond the files on disk, kubeadm stores config in ConfigMaps:

```bash
kubectl get cm -n kube-system | grep kube

# kube-proxy                                # kube-proxy DS config
# coredns                                    # CoreDNS Corefile
# kubelet-config                             # ← the current kubelet config snapshot
# kubeadm-config                             # ← the ClusterConfiguration from init
```

### `kubeadm-config` ConfigMap

Contains the ClusterConfiguration that was used at init. Cluster-wide source of truth for: Kubernetes version, control plane endpoint, pod/service CIDRs, extraArgs, etc.

Upgrade uses this to know "what were the settings?" and applies them to new CP nodes during `kubeadm join --control-plane`.

View:

```bash
kubectl get cm -n kube-system kubeadm-config -o yaml
```

Edit when changing cluster-wide settings (e.g. adding certSANs):

```bash
kubectl edit cm -n kube-system kubeadm-config
# Then run `kubeadm certs renew apiserver` if certs need re-issue
```

### `kubelet-config` ConfigMap

A per-version snapshot of the kubelet config. Created by kubeadm init/upgrade. On `kubeadm join`, nodes download this ConfigMap and write it to `/var/lib/kubelet/config.yaml`.

Editing this does NOT change running kubelets — they read from the local file. It only affects newly-joining nodes.

---

## Resetting awareness

When `kubeadm reset` runs, it removes almost everything in this list:

```
✓ /etc/kubernetes/pki/
✓ /etc/kubernetes/*.conf
✓ /etc/kubernetes/manifests/
✓ /var/lib/etcd/
✓ /var/lib/kubelet/ (most of it)
✓ Stops kubelet; uninstalls the systemd unit's drop-in files

✗ /etc/cni/net.d/ (kept by default)
✗ /opt/cni/bin/ (kept)
✗ iptables rules (kept)
✗ Container runtime containers/images (kept)
✗ kube-proxy ipvs tables (kept)
```

See the init-join-reset subtopic for cleanup steps.

---

## External CA mode — what's different

If you set up the cluster with external CA:

- `/etc/kubernetes/pki/ca.crt` present; `ca.key` absent.
- Same for `front-proxy-ca` and `etcd/ca`.
- `kubeadm certs renew` won't work (no signing key).

You manage certificate rotation externally and push fresh certs onto each CP node. Then restart the control plane pods to pick them up.

---

## Exam heuristics

- The paths in this note are what exam questions use. Memorize `/etc/kubernetes/pki/`, `/etc/kubernetes/manifests/`, `/var/lib/kubelet/config.yaml`.
- `admin.conf` is what you `cp ~/.kube/config`. kubelet uses its own `kubelet.conf`.
- Static pod manifests in `/etc/kubernetes/manifests/` are the way to edit control plane flags.
- Kubelet configuration changes: edit `/var/lib/kubelet/config.yaml` + `systemctl restart kubelet`.
- `kubeadm-config` ConfigMap holds the cluster's init-time config; edit it + re-run relevant phases.

## Mental traps

- Confusing `admin.conf` with `kubelet.conf`. Different identities, different uses.
- Editing files in `/etc/kubernetes/manifests/` while debugging and forgetting kubelet will restart the pod.
- Wiping `/var/lib/etcd` on a lab node thinking it's "cache." It's the cluster's entire state.
- Running `kubeadm certs renew` expecting it to touch `/var/lib/kubelet/pki/`. It doesn't — kubelet certs rotate via CSR, separately.
- Editing the `kubelet-config` ConfigMap expecting existing kubelets to update. They won't; it only affects new joins.
- Losing `/etc/kubernetes/pki/ca.crt` — you've lost the cluster's trust anchor. Rebuild.
- Running `kubeadm reset` without the firewall/CNI/runtime cleanup and then wondering why re-init has stale state.
