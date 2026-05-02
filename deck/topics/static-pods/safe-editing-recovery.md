## The blast radius

Editing a static pod manifest for a core control plane component is the single highest-blast-radius operation in a cluster. A one-character mistake in `kube-apiserver.yaml` takes the whole API offline within seconds. A similar mistake in `etcd.yaml` takes cluster state with it.

That is why the habit worth drilling is: **backup, edit, watch, verify**.

## The safe editing loop

```
1. Backup the file (with a .bak extension that kubelet ignores)
2. Edit the file
3. Watch kubelet and the container
4. Verify the API or the affected component
5. If broken, restore backup
```

### Step 1 — Backup

```bash
sudo cp /etc/kubernetes/manifests/kube-apiserver.yaml \
        /root/kube-apiserver.yaml.bak
```

Use `.bak`, `.orig`, or any extension that is not `.yaml` / `.json`. Kubelet only watches the recognized extensions, so the backup won't trigger a duplicate pod. Keep backups outside `/etc/kubernetes/manifests/` when possible to remove all doubt.

### Step 2 — Edit in place

```bash
sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml
```

Small edits only. If you need a large change, consider editing the backup and moving it into place atomically:

```bash
sudo cp /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/apiserver.new.yaml
sudo vi /tmp/apiserver.new.yaml
# when happy:
sudo mv /tmp/apiserver.new.yaml /etc/kubernetes/manifests/kube-apiserver.yaml
```

This avoids leaving the file in a partially-written state during save.

### Step 3 — Watch

```bash
# Kubelet reconcile
journalctl -u kubelet -f

# Real container state
watch -n 1 'crictl ps | head'

# Mirror pod (if API still works)
kubectl get pods -n kube-system -l component=kube-apiserver -w
```

You want to see the pod restart, come up, and stop cycling. If it stays in `Exited` / `CrashLoopBackOff`, the manifest is broken or the new flag is invalid.

### Step 4 — Verify

Depends on the component:

- **kube-apiserver** — `kubectl get nodes` and `kubectl get --raw '/healthz'`.
- **etcd** — `etcdctl endpoint health` (see etcd deck).
- **kube-scheduler** — create a throwaway pod and verify it schedules: `kubectl run t --image=pause --restart=Never; kubectl get pod t -o wide`.
- **kube-controller-manager** — create a Deployment and watch it scale.

### Step 5 — Restore if broken

If the new manifest doesn't work:

```bash
sudo cp /root/kube-apiserver.yaml.bak \
        /etc/kubernetes/manifests/kube-apiserver.yaml
```

The kubelet sees the change and recycles the pod back to the known-good config.

## Bounce a static pod without editing it

Sometimes you just want the pod to restart (e.g. to pick up a rotated cert). The clean pattern:

```bash
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sleep 5
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
```

kubelet stops the pod while the file is absent, then recreates it. Typically back up in 10–30 seconds.

For less drastic bouncing (keeping the pod alive but forcing kubelet re-evaluation), you can also touch the file:

```bash
sudo touch /etc/kubernetes/manifests/kube-apiserver.yaml
```

This updates mtime and often causes kubelet to re-read. Not as reliable as `mv`, but non-disruptive when no actual spec change is needed.

## Common edit scenarios

### Add a flag to the apiserver

Manifests put apiserver args in `spec.containers[0].command` (list of strings). Add a new line inside the list:

```yaml
command:
  - kube-apiserver
  - --advertise-address=10.0.0.5
  - --allow-privileged=true
  - --audit-log-maxage=30           # ← new flag
```

Indentation matters; each flag is a list element. Do not combine flags on one line.

### Change a data dir (etcd restore)

Edit `volumes` hostPath:

```yaml
volumes:
  - name: etcd-data
    hostPath:
      path: /var/lib/etcd-restore    # changed from /var/lib/etcd
      type: DirectoryOrCreate
```

`volumeMounts` stays the same inside the container.

### Add a host mount for apiserver (rare)

```yaml
volumeMounts:
  - mountPath: /etc/extra
    name: extra
    readOnly: true
volumes:
  - name: extra
    hostPath:
      path: /etc/extra
      type: DirectoryOrCreate
```

Make sure the `hostPath` exists or uses `DirectoryOrCreate`, and that `mountPath` is unique.

## Recovery from a broken manifest

### Symptom: apiserver is down

```bash
ssh <control-plane-node>
sudo ls /etc/kubernetes/manifests/
sudo cat /etc/kubernetes/manifests/kube-apiserver.yaml
sudo cp /root/kube-apiserver.yaml.bak \
        /etc/kubernetes/manifests/kube-apiserver.yaml
```

Wait ~30 s. Confirm with:

```bash
sudo crictl ps | grep apiserver
sudo crictl logs <container-id> | tail -n 100
# from your client
kubectl get nodes
```

### Symptom: no backup exists

Two options, in order of preference:

1. **Re-synthesize** the manifest from `kubeadm`:
   ```bash
   # Only a last resort; depends on kubeadm version
   sudo kubeadm init phase control-plane apiserver --dry-run
   ```
   Compare its output against your broken file to find the diff.

2. **Read the kubelet journal** for the specific parse or container error, and fix only that:
   ```bash
   sudo journalctl -u kubelet --no-pager | grep -i 'kube-apiserver' | tail -n 40
   ```
   Common findings: misplaced `-`, missing colon, tab-vs-space.

3. **Reset and re-init** the control plane on this node (`kubeadm reset` + `kubeadm init`) — destructive; last resort.

### Symptom: static pod file exists but no container

Likely causes:

- kubelet is not running — `systemctl status kubelet`.
- Container runtime is not running — `systemctl status containerd` (or crio, docker).
- Manifest failed to parse — `journalctl -u kubelet | grep -i 'pod-manifest\|static'`.
- Path mismatch — confirm the file is under the path in `/var/lib/kubelet/config.yaml`.

## Pitfalls to avoid

- **Editing via `kubectl edit` pod** — wasted; mirror gets overwritten.
- **Leaving a .yaml backup in the manifest dir** — kubelet will try to run it as a second static pod and often port-collide. Use `.bak`.
- **Saving with an editor that inserts a BOM or CRLF** — YAML parse fails silently. Use plain `vi`/`nano`.
- **Adding a duplicate flag** — kubelet runs, container crashes with "flag already set."
- **Changing `hostNetwork`, `priorityClassName`, or scheduler hints for apiserver** — unless the exam asks for it, leave them alone.

## Fast commands cheat sheet

```bash
# Backup pattern
sudo cp /etc/kubernetes/manifests/kube-apiserver.yaml /root/

# Restore pattern
sudo cp /root/kube-apiserver.yaml /etc/kubernetes/manifests/

# Bounce pattern
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/ && \
  sleep 5 && \
  sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/

# Diagnose
sudo journalctl -u kubelet --no-pager | tail -n 80
sudo crictl ps -a | grep apiserver
sudo crictl logs <id> | tail -n 50
```

## Exam heuristics

- Before editing any static pod manifest, always `cp ... .bak` first. The ten seconds you save by skipping this are never worth it.
- Practice the **bounce** pattern until it is a reflex — it is the fastest way to restart a static pod, and it works even when `kubectl` is broken.
- If multiple components are broken at once, fix **etcd first**, then **apiserver**, then the others. The order matters because apiserver depends on etcd.
- If the exam supplies a manifest to paste in, always re-read the indentation before saving.

## Mental traps

- Believing "I just changed a flag, kubelet will restart it cleanly." If the flag is invalid, the container crashes and kubelet retries forever. You have to back out the change.
- Relying on `kubectl rollout status` or similar tools. Static pods don't have controllers.
- Thinking the `config.hash` annotation changes affect anything. It's derived from the file; you don't edit it.
- Forgetting that static pods bypass admission. A spec that a Deployment would reject (privileged, hostPath root mount, etc.) runs freely here. Handle with care.
