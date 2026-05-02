## When kubectl can't help

Apiserver is down. `kubectl` returns:

```
Unable to connect to the server: dial tcp ...: connect: connection refused
```

You need to fix the apiserver, but you can't observe it through Kubernetes-native tools. Time for `crictl` + journalctl + manifest editing — node-local tools that don't need a working cluster.

This subtopic walks the canonical "control plane is broken on this node" workflow.

---

## The mental model

```
 Apiserver static pod manifest
   /etc/kubernetes/manifests/kube-apiserver.yaml
        │
        │ kubelet watches the directory
        ▼
   kubelet asks containerd to run the manifest's spec
        │
        │ via CRI
        ▼
   containerd creates a sandbox + apiserver container
        │
        │ visible to:
        ▼
   `crictl ps`, `crictl pods`, `crictl logs`, `journalctl -u kubelet`, `journalctl -u containerd`
```

When kubectl is broken, this stack is your only window. Each layer logs / exposes state.

---

## The diagnostic order

1. **Static pod manifests** — are they syntactically valid? Have they changed recently?
2. **kubelet** — is it running? What does its journal say?
3. **containerd** — is it running? What does its journal say?
4. **crictl pods / ps** — is the apiserver sandbox + container alive?
5. **crictl logs** — what is the apiserver itself logging?
6. **etcd** — is it healthy? (without etcd, apiserver can't start.)

Walk in this order, find the layer that's broken, fix it.

---

## Step 1: Inspect the static pod manifest

```bash
sudo cat /etc/kubernetes/manifests/kube-apiserver.yaml
```

Verify:

- YAML is valid (no random truncations, no half-edits).
- Image tag is correct (e.g. you didn't accidentally bump to a non-existent version).
- Flags are sensible (no typos in `--audit-log-path` etc.).
- Volumes and mounts make sense.

If you suspect a recent edit broke it, compare with backup:

```bash
sudo diff /etc/kubernetes/manifests/kube-apiserver.yaml /root/kube-apiserver.yaml.bak
```

You did keep a backup before editing, right? If not, regenerate from kubeadm:

```bash
sudo kubeadm init phase control-plane apiserver
# Re-renders the manifest from kubeadm-config ConfigMap.
```

---

## Step 2: Check kubelet

```bash
sudo systemctl status kubelet

# active (running)? Good.
# inactive? Start it:
sudo systemctl start kubelet

# Then check its journal:
sudo journalctl -u kubelet --since '5 minutes ago' --no-pager | tail -80
```

Common error patterns:

- **Cgroup driver mismatch** — fix as in cri-mental-model deck.
- **Failed to load static pod manifest** — your manifest YAML is broken; fix it.
- **Failed to dial container runtime** — containerd isn't running.
- **CSR rejection** — kubelet's client cert is broken.

If kubelet is running but errors continually, it'll print useful diagnostics. Read them.

---

## Step 3: Check containerd (or cri-o)

```bash
sudo systemctl status containerd

# active? Move on.
# inactive?
sudo systemctl start containerd

# Then journal:
sudo journalctl -u containerd --since '5 minutes ago' --no-pager | tail
```

Common containerd issues:

- **Disk full** — `df -h /var/lib/containerd`.
- **Corrupted state** — rare; can be fixed by stopping containerd, wiping `/var/lib/containerd` (loses container state), restarting. Drastic.
- **Bad config** — `/etc/containerd/config.toml` was edited.

If containerd is broken, kubelet can't do anything. Get containerd healthy first.

---

## Step 4: Inspect with crictl

```bash
sudo crictl info | jq '.status.runtimeReady, .status.networkReady'
# true, true → containerd is healthy
# false, ... → see message field for cause

# What pods does the runtime see?
sudo crictl pods

# Specifically the apiserver
sudo crictl pods --name kube-apiserver
```

If you see no apiserver pod:

- Static pod manifest is missing or invalid (kubelet didn't try to start it).
- Kubelet didn't connect to containerd in time.

If you see one but it's `Not Ready`:

- Sandbox creation failed (CNI?).
- Apiserver image not pulled yet (network).
- Lots of restart attempts? CrashLoopBackOff at the runtime level.

Drill in:

```bash
sudo crictl ps -a --name kube-apiserver
# Even stopped ones — see attempt count.
```

`Attempts > 5` and rapidly increasing = CrashLoop. Read the apiserver's logs.

---

## Step 5: Apiserver's logs

```bash
APISERVER_CONTAINER=$(sudo crictl ps -a --name kube-apiserver --latest -q)
sudo crictl logs --tail=100 $APISERVER_CONTAINER
```

Common apiserver crash logs:

```
I0423 ... etcdserver: rejected client connection due to ...
I0423 ... unable to load --client-ca-file ...
I0423 ... apiserver shutting down: error loading server certificate ...
```

Map the error to a fix:

| Log pattern                                          | Fix                                                |
|------------------------------------------------------|----------------------------------------------------|
| `etcdserver: connection refused`                     | etcd is down; check `crictl ps --name etcd`        |
| `failed to load --client-ca-file`                    | CA file missing or path wrong; check pki dir      |
| `error loading server certificate`                   | Apiserver cert missing / corrupted; renew         |
| `Cert expired`                                        | Renew via `kubeadm certs renew apiserver`          |
| `bind: address already in use`                       | Another process on port 6443 (rare); kill it     |
| `unknown flag`                                        | Bad flag in the manifest; remove or fix           |
| `OOMKilled` (from container exit)                    | Apiserver hit memory limit; raise it              |

Fix the underlying cause, then bounce the manifest:

```bash
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sleep 5
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/

# Watch it come back
sudo crictl ps --name kube-apiserver
```

---

## Step 6: etcd specifically

If apiserver logs say "etcd connection refused," etcd is the root cause:

```bash
sudo crictl pods --name etcd
sudo crictl ps --name etcd

# Get the etcd container's logs
ETCD_CONTAINER=$(sudo crictl ps --name etcd --latest -q)
sudo crictl logs --tail=100 $ETCD_CONTAINER
```

Common etcd issues:

- **Disk space** — etcd refuses to write when over `--quota-backend-bytes`. See etcd → compaction-and-defrag deck.
- **Corruption** — fsck on the data directory. Worst case, restore from snapshot.
- **Cert issues** — etcd has its own certs; check etcd CA.
- **Peer connectivity (HA)** — peers can't reach each other.

For HA: a single etcd member down doesn't bring the cluster down. Two of three down does.

For single-node (kubeadm without HA): etcd down = apiserver down = cluster down.

### Healthcheck etcd directly

If etcd is running but maybe stuck:

```bash
ETCDCTL_API=3 sudo etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint health

# 127.0.0.1:2379 is healthy: ...

# Or list members (HA):
ETCDCTL_API=3 sudo etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  member list
```

If etcd reports unhealthy, the etcd subtopic deck has detailed recovery procedures.

---

## When the manifest is at fault

Most "control plane down" incidents trace to a recent manifest edit gone wrong. Specific patterns:

### Bad flag added

```yaml
spec:
  containers:
  - name: kube-apiserver
    command:
    - kube-apiserver
    - --advertise-address=10.0.0.5
    - --audit-log-path=/log/audit.log
    - --bogus-flag                     # ← oops
```

`crictl logs` shows: `unknown flag --bogus-flag`. Container exits immediately. Repeat.

Fix: `sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml`, remove the bad flag. Save. Wait ~30 seconds. Apiserver comes back.

### Bad volume mount

```yaml
volumes:
- name: bad
  hostPath:
    path: /nonexistent
    type: Directory                    # type checks for existence; fails if missing
```

Pod can't even create. `crictl ps -a` shows the container in `CONTAINER_FAILED` state quickly. `crictl inspect` shows mount errors.

Fix: change the volume or use `DirectoryOrCreate` to auto-create.

### Image tag typo

```yaml
image: registry.k8s.io/kube-apiserver:v1.300       # typo, should be v1.30.0
```

`crictl logs` doesn't have anything (container never started). `crictl ps -a` shows `IMAGE_PULL_ERROR`.

`sudo journalctl -u kubelet | grep image` reveals: `Failed to pull image: manifest unknown`.

Fix: correct the tag.

### Volume mount path conflict

```yaml
volumeMounts:
- name: vol1
  mountPath: /etc/kubernetes
- name: vol2
  mountPath: /etc/kubernetes/pki         # nested with vol1
```

Sometimes works, sometimes doesn't (depends on order of mount). Apiserver might log "permission denied" on cert files.

Fix: avoid nested mounts. Mount the parent OR specific files, not both.

---

## Recovery playbook

When apiserver is gone and you have ssh:

```bash
# 1. Verify state
sudo crictl pods --name kube-apiserver
sudo crictl ps --name kube-apiserver -a

# 2. Read recent apiserver logs
APISERVER=$(sudo crictl ps --name kube-apiserver --latest -q)
sudo crictl logs --tail=100 $APISERVER

# 3. Check kubelet's view
sudo journalctl -u kubelet --since '10 minutes ago' --no-pager | tail -30 | grep -E 'apiserver|static'

# 4. Inspect the manifest
sudo cat /etc/kubernetes/manifests/kube-apiserver.yaml | head -50

# 5. Check certs
sudo kubeadm certs check-expiration

# 6. Check etcd
ETCDCTL_API=3 sudo etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key endpoint health

# 7. Apply the fix (whatever step 2-6 revealed)

# 8. Bounce the manifest
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sleep 5
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/

# 9. Watch
sudo crictl ps --name kube-apiserver --watch=false
sleep 30
sudo crictl ps --name kube-apiserver

# 10. Test from another node or your laptop
kubectl get nodes
```

---

## Recovery from etcd issues

If etcd is the root cause, options:

### A) etcd just stopped (one-off crash)

```bash
# Bounce etcd's manifest
sudo mv /etc/kubernetes/manifests/etcd.yaml /tmp/
sleep 5
sudo mv /tmp/etcd.yaml /etc/kubernetes/manifests/

# Wait for it to come back
sudo crictl ps --name etcd
```

### B) etcd CrashLoopBackOff (config error)

Read etcd logs: `sudo crictl logs <etcd-container-id>`.

Common: bad data directory permissions, expired etcd peer certs, peer can't reach others.

### C) etcd data corrupted / lost

Restore from snapshot:

```bash
# Detail in etcd → snapshots-and-restore deck
sudo etcdctl snapshot restore /backup/etcd.db --data-dir=/var/lib/etcd-restore
# Then update etcd.yaml's hostPath to point at /var/lib/etcd-restore.
# Move the manifest back, wait for restoration to complete.
```

### D) Lost quorum (HA)

Bring back enough members for quorum. If permanently lost, recover from snapshot on a single node, then re-add members. Detail in etcd deck.

---

## Inspecting other control plane components

Same pattern applies to controller-manager and scheduler:

```bash
sudo crictl pods --name kube-controller-manager
sudo crictl pods --name kube-scheduler

# Logs
sudo crictl logs $(sudo crictl ps --name kube-controller-manager --latest -q)
sudo crictl logs $(sudo crictl ps --name kube-scheduler --latest -q)

# Manifest paths
ls /etc/kubernetes/manifests/
# kube-apiserver.yaml
# kube-controller-manager.yaml
# kube-scheduler.yaml
# etcd.yaml
```

When apiserver is up but controller-manager is broken:

- **`kubectl get pods` works**, but new Deployments don't roll out, deleted pods aren't replaced.
- Controller-manager log shows the issue (often: leader-election failure, missing kubeconfig field, expired client cert).

Same recovery pattern: edit manifest, bounce, observe.

---

## Restoring kubeconfigs

If `admin.conf` is gone or corrupted:

```bash
# Re-generate
sudo kubeadm init phase kubeconfig admin

# This re-creates /etc/kubernetes/admin.conf from the cluster CA.

# Update your personal kubeconfig
sudo cp /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

Same approach for `kubelet.conf`, `controller-manager.conf`, `scheduler.conf`:

```bash
sudo kubeadm init phase kubeconfig kubelet
sudo kubeadm init phase kubeconfig controller-manager
sudo kubeadm init phase kubeconfig scheduler
```

After regenerating these, restart the affected component (move-out / move-in the manifest, or `systemctl restart kubelet`).

---

## Putting it together — the playbook in plain language

> "kubectl doesn't work."

1. SSH to a CP node.
2. `sudo crictl pods --name kube-apiserver` → does it exist? In what state?
3. If state is bad: `sudo crictl logs` of the most recent apiserver container → what's the error?
4. Map error to fix:
   - manifest issue → edit `/etc/kubernetes/manifests/kube-apiserver.yaml`
   - etcd issue → recover etcd
   - cert issue → `kubeadm certs renew`
   - etc.
5. Bounce the manifest to apply the fix.
6. Verify with `kubectl get nodes` from your normal kubeconfig.

The whole loop is local to the CP node. Doesn't need apiserver to be up.

---

## Exam heuristics

- For "kubectl doesn't work" exam scenarios, the answer almost always involves SSH + crictl + manifest edit.
- `sudo crictl ps --name <component>` to find the relevant container.
- `sudo crictl logs <id>` for the actual error.
- Bounce the manifest by moving it out of `/etc/kubernetes/manifests/` and back.
- Have a backup copy of any manifest before editing — `cp <file> <file>.bak`.

## Mental traps

- Trying to fix things via kubectl when apiserver itself is the broken thing. Use crictl / journalctl / cat.
- Editing a static pod manifest and not realizing kubelet auto-restarts the pod within seconds. Save your edits before kubelet picks them up half-done.
- Restarting kubelet to "fix things" when the issue is actually containerd or etcd. Restart in the right order: containerd → kubelet.
- Forgetting to check etcd. Apiserver depends on etcd; if etcd is broken, everything else is symptoms.
- Reading kubelet logs when the actual error is in apiserver's container logs. Drill into crictl logs for the specific component.
- Force-restarting containers via `crictl stop` while the kubelet is also reconciling — race conditions. Bounce the manifest instead.
