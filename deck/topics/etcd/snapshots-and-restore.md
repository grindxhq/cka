## Why this matters

Snapshot save/restore is the **single most commonly tested etcd skill** on CKA. It is also the most commonly fumbled under time pressure because:

- The flags are long and easy to mistype.
- The restore writes to a **new data dir**, which you then have to wire back into the static pod manifest.
- One mistake can take the whole control plane offline.

The goal: be able to do this from muscle memory in under three minutes.

## Prerequisites (always)

Run these on the control plane node that hosts etcd.

```bash
export ETCDCTL_API=3
CACERT=/etc/kubernetes/pki/etcd/ca.crt
CERT=/etc/kubernetes/pki/etcd/server.crt
KEY=/etc/kubernetes/pki/etcd/server.key
EP=https://127.0.0.1:2379
```

## Save a snapshot

```bash
etcdctl --endpoints=$EP --cacert=$CACERT --cert=$CERT --key=$KEY \
  snapshot save /opt/backup/etcd-$(date +%F-%H%M).db
```

Verify it:

```bash
etcdctl --write-out=table snapshot status /opt/backup/etcd-*.db
```

You should see a `hash`, `revision`, `total keys`, `total size`. If this fails, your snapshot is unusable — do not trust it.

**Pitfalls when saving:**

- Forgetting `ETCDCTL_API=3`. `snapshot` is v3-only; v2 errors are confusing.
- Writing to a path that does not exist. Pre-create the directory.
- Saving to a path inside a mounted volume that the etcd container cannot see. `etcdctl` runs on the **host**, not inside the container, so host paths are fine.

## Restore a snapshot (the procedure)

Restore is five steps. Skip any one and the API will not come back cleanly.

### Step 1 — Stop the API server and etcd static pods

Move the manifests out so kubelet stops running them:

```bash
mkdir -p /tmp/manifests-backup
sudo mv /etc/kubernetes/manifests/etcd.yaml         /tmp/manifests-backup/
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/manifests-backup/
```

Wait a few seconds and confirm the containers are gone:

```bash
crictl ps | grep -E 'etcd|apiserver'
```

Stopping the API server first avoids writes during the restore.

### Step 2 — Restore the snapshot to a new data dir

**Never** restore into `/var/lib/etcd`. Restore into a fresh directory, then point the manifest at it.

```bash
ETCDCTL_API=3 etcdctl snapshot restore /opt/backup/etcd-snapshot.db \
  --data-dir=/var/lib/etcd-restore
```

What that does: writes a fresh `member/` tree with a **new cluster ID and member ID** derived from the restore. That is why the old data dir is not reused — etcd refuses to start if the IDs conflict.

### Step 3 — Update the etcd static pod to use the new data dir

Edit the backup copy of the manifest (not a live one — the live ones are still moved out):

```bash
sudo vi /tmp/manifests-backup/etcd.yaml
```

Change the `hostPath` for the etcd data volume:

```yaml
volumes:
  - name: etcd-data
    hostPath:
      path: /var/lib/etcd-restore   # was /var/lib/etcd
      type: DirectoryOrCreate
```

The `volumeMount` inside the container usually stays at `/var/lib/etcd`; only the **host path** changes.

### Step 4 — Put the manifests back

```bash
sudo mv /tmp/manifests-backup/etcd.yaml         /etc/kubernetes/manifests/
sudo mv /tmp/manifests-backup/kube-apiserver.yaml /etc/kubernetes/manifests/
```

kubelet picks the manifests up within ~20 s. Watch the containers come back:

```bash
watch crictl ps
```

### Step 5 — Verify

```bash
etcdctl --endpoints=$EP --cacert=$CACERT --cert=$CERT --key=$KEY endpoint health
kubectl get nodes
kubectl get pods -A
```

If `kubectl get` works, the restore is done.

## Fast reference card

```bash
# Save
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /opt/backup/etcd.db

# Restore
ETCDCTL_API=3 etcdctl snapshot restore /opt/backup/etcd.db \
  --data-dir=/var/lib/etcd-restore

# Verify
ETCDCTL_API=3 etcdctl --write-out=table snapshot status /opt/backup/etcd.db
```

Note the restore command does **not** need TLS flags — it operates on a file, not a running cluster.

## Common failure patterns

- **Restored into the old data dir** — etcd fails with `mismatched cluster ID`. Recovery: delete the new `member/` subdir or restore again with a truly new path.
- **Forgot to edit the manifest** — kubelet starts etcd against the old, possibly wiped data dir. Symptoms range from "runs fine with old data" to "crashloops."
- **Permissions wrong on new data dir** — etcd container runs as a specific UID; if the dir is not readable it will crashloop. Let `DirectoryOrCreate` create it so kubelet picks up correct ownership, or `chown` to match the old dir.
- **Did not move the apiserver manifest out first** — API still accepts writes during the restore window, which can be lost when etcd is replaced.
- **External etcd cluster** — the same recipe runs on every etcd node, but with `--initial-cluster`, `--initial-cluster-token`, and peer URLs matching the topology. On CKA this rarely appears; stacked etcd is the default.

## Exam heuristics

- Read the question carefully for the **snapshot path** and the **target data dir**. Questions often specify both.
- If the question only asks you to **save** a snapshot, stop after `snapshot save` + `snapshot status` verification. Do not restore.
- If you are asked to restore onto a new node, the procedure is identical but you usually also edit `--initial-advertise-peer-urls` in the manifest. On stacked single-node kubeadm, that is not required.
- If time is tight, use a scratch file with the full command pre-written so you only substitute the path.

## Mental traps

- Treating restore like a database `rollback`. It is not — it wipes and replaces.
- Expecting restored Secrets, ConfigMaps, Deployments to "merge" with the current live state. They replace it. Anything created after the snapshot is **gone**.
- Restoring into `/var/lib/etcd` because the manifest already points there. Always fresh path.
- Forgetting to set `ETCDCTL_API=3`. Restore will fail with a cryptic error.
