## Where kubelet's files live

```
/etc/kubernetes/
├── kubelet.conf                        # kubeconfig kubelet uses to talk to apiserver
├── pki/
│   ├── ca.crt                          # cluster CA
│   └── kubelet-client-current.pem      # kubelet's own client cert (rotated)
└── manifests/                          # static pod directory
/var/lib/kubelet/
├── config.yaml                         # the real kubelet config
├── pki/                                # serving certs (if enabled)
├── pods/                               # per-pod state
└── plugins/                            # CSI / device plugins live here
/etc/systemd/system/kubelet.service.d/
└── 10-kubeadm.conf                     # systemd drop-in with --config and env
```

The three moving parts to keep straight:

1. **`kubelet.conf`** — the kubeconfig. How kubelet authenticates to apiserver.
2. **`config.yaml`** — the kubelet's behavior config. Everything from DNS to eviction thresholds.
3. **`kubelet.service` drop-in** — the systemd unit and env file.

## Reading `config.yaml`

Canonical example:

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
authentication:
  anonymous:
    enabled: false
  webhook:
    enabled: true
  x509:
    clientCAFile: /etc/kubernetes/pki/ca.crt
authorization:
  mode: Webhook
cgroupDriver: systemd
clusterDNS:
  - 10.96.0.10
clusterDomain: cluster.local
containerLogMaxSize: 10Mi
containerLogMaxFiles: 5
evictionHard:
  imagefs.available: 15%
  memory.available: 100Mi
  nodefs.available: 10%
  nodefs.inodesFree: 5%
rotateCertificates: true
serverTLSBootstrap: true
staticPodPath: /etc/kubernetes/manifests
```

Fields you are most likely to edit on CKA:

- `clusterDNS` — IP of the cluster DNS Service (normally `10.96.0.10`).
- `clusterDomain` — DNS suffix (normally `cluster.local`).
- `staticPodPath` — where to watch for static pod manifests.
- `evictionHard` / `evictionSoft` — disk / memory thresholds.
- `containerLogMaxSize` / `containerLogMaxFiles` — log rotation for container stdout.
- `cgroupDriver` — must match the container runtime (`systemd` on modern clusters).

Apply changes:

```bash
sudo vi /var/lib/kubelet/config.yaml
sudo systemctl daemon-reload        # only needed if systemd unit changed
sudo systemctl restart kubelet
```

If the YAML is invalid, kubelet will fail to start and log the parse error. Always check:

```bash
sudo journalctl -u kubelet --no-pager | tail -n 40
```

## The systemd drop-in

`/etc/systemd/system/kubelet.service.d/10-kubeadm.conf` typically has:

```
[Service]
Environment="KUBELET_KUBECONFIG_ARGS=--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf"
Environment="KUBELET_CONFIG_ARGS=--config=/var/lib/kubelet/config.yaml"
Environment="KUBELET_KUBEADM_ARGS=--container-runtime-endpoint=unix:///var/run/containerd/containerd.sock --pod-infra-container-image=registry.k8s.io/pause:3.9"
EnvironmentFile=-/etc/default/kubelet
ExecStart=
ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
```

If you need a flag that `config.yaml` doesn't expose, add it to `/etc/default/kubelet` (or `/etc/sysconfig/kubelet`):

```
KUBELET_EXTRA_ARGS=--node-labels=role=worker,topology.kubernetes.io/zone=us-east-1a
```

Then `daemon-reload` + restart. Most of the time, prefer editing `config.yaml`.

## Reading kubelet logs

kubelet logs go to the systemd journal:

```bash
sudo journalctl -u kubelet --no-pager | tail -n 100
sudo journalctl -u kubelet -f                     # follow live
sudo journalctl -u kubelet --since "10 minutes ago"
sudo journalctl -u kubelet -p err --no-pager      # errors only
sudo journalctl -u kubelet --since today --grep="static pod"
```

Useful greps when diagnosing:

```bash
# Static pod / manifest parsing
sudo journalctl -u kubelet | grep -iE 'static|manifest|mirror'

# Image pulls
sudo journalctl -u kubelet | grep -iE 'image|pulling|pulled|pull.*fail'

# Probes
sudo journalctl -u kubelet | grep -i 'probe'

# Eviction
sudo journalctl -u kubelet | grep -iE 'evict|pressure'

# Cert / auth
sudo journalctl -u kubelet | grep -iE 'cert|x509|unauth'
```

Log verbosity is `-v=2` by default. To increase temporarily, add `--v=4` to `KUBELET_EXTRA_ARGS` and restart kubelet.

## Container logs

Container stdout/stderr is written by the runtime to `/var/log/pods/<ns>_<pod>_<uid>/<container>/<N>.log`. kubelet reads them for `kubectl logs`.

Finding logs directly on the node:

```bash
ls /var/log/pods/
# then
sudo tail -n 100 /var/log/pods/kube-system_kube-apiserver-*_*/kube-apiserver/0.log
```

Useful when `kubectl` is down.

`crictl` provides a nicer interface:

```bash
sudo crictl logs <container-id>
sudo crictl logs --tail 100 -f <container-id>
```

## Node metrics

kubelet embeds cAdvisor. Raw stats are available at:

```
https://<node-ip>:10250/metrics/cadvisor      (auth required)
```

Summary API:

```
https://<node-ip>:10250/stats/summary
```

metrics-server pulls from `/stats/summary`. If `kubectl top nodes` doesn't work, either metrics-server is missing or kubelet's stats endpoint is unreachable.

## Common config tasks

### Change cluster DNS

```yaml
# /var/lib/kubelet/config.yaml
clusterDNS: [10.96.0.10]
```

Restart kubelet. Existing pods keep the old DNS until they are recreated.

### Add node labels

Prefer via kubectl (no restart):

```bash
kubectl label node <n> disktype=ssd
```

Or at kubelet startup via `--node-labels` in `KUBELET_EXTRA_ARGS`. Note: only **namespaced** labels (`*.k8s.io`, `*.kubernetes.io`) restricted by NodeRestriction admission plugin require care.

### Change eviction thresholds

```yaml
evictionHard:
  memory.available: 200Mi
  nodefs.available: 5%
```

Lower thresholds = more tolerance for pressure before eviction kicks in. Production: keep defaults unless you really know what you're doing.

### Change static pod path

```yaml
staticPodPath: /etc/kubernetes/manifests
```

Changing this requires moving existing manifests to the new path at the same time. Otherwise kubelet stops the old static pods (and the control plane on that node).

## Quick cheat sheet

```bash
# Is kubelet alive?
systemctl is-active kubelet

# What is kubelet using for config?
grep config.yaml /etc/systemd/system/kubelet.service.d/*.conf

# What does config say?
grep -vE '^(\s*#|\s*$)' /var/lib/kubelet/config.yaml

# What is the journal showing?
sudo journalctl -u kubelet --no-pager -n 100

# Validate a new config before restart
sudo kubelet --config=/var/lib/kubelet/config.yaml --help &>/dev/null && echo "parses"
```

(The last trick is imperfect but catches gross errors by having kubelet parse the file for --help generation.)

## Exam heuristics

- When asked to change kubelet behavior, edit `/var/lib/kubelet/config.yaml`. Not the systemd unit.
- When asked to change how kubelet talks to apiserver (server URL, etc.), edit `/etc/kubernetes/kubelet.conf`. That's a kubeconfig.
- Always `systemctl restart kubelet` after config edits.
- After editing, **check the journal**. Kubelet will either start cleanly or scream at you in the first 5 seconds.

## Mental traps

- Believing `/etc/default/kubelet` is the "main" config. It's only for environment variables passed to the systemd unit.
- Editing the kubelet `ConfigMap` in kube-system (`kubelet-config-1.28` or similar) and expecting the running kubelet to pick it up. That ConfigMap is **source** for `kubeadm upgrade`; nothing auto-applies it to the running node.
- Forgetting to `daemon-reload` after editing a unit drop-in. systemd will show the old flags.
- Killing kubelet to "reset" it. Always prefer `systemctl restart` — clean shutdown, clean start.
- Confusing kubelet's own TLS serving cert (`--tls-cert-file`) with its client cert. Two different chains, two different purposes.
