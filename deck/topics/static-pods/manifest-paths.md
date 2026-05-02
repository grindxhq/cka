## The canonical path

On a kubeadm cluster, kubelet watches:

```
/etc/kubernetes/manifests/
```

Any YAML (or JSON) file dropped in there becomes a static pod. Any file removed stops the pod. kubelet re-reads the directory periodically (every ~20 seconds) and also reacts to filesystem events.

## How kubelet knows which path to watch

The path comes from **kubelet config**, not a flag in modern kubeadm clusters.

### Locate the config file

kubelet is launched with a line like:

```
ExecStart=/usr/bin/kubelet --config=/var/lib/kubelet/config.yaml ...
```

Inside `config.yaml`:

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
staticPodPath: /etc/kubernetes/manifests
```

Change the path there → restart kubelet → new path takes effect.

### Legacy flag

Some older setups use the CLI flag:

```
--pod-manifest-path=/etc/kubernetes/manifests
```

Config and flag are equivalent; kubelet reads whichever is present. Config is preferred today.

### URL-based manifests (rare)

kubelet can also fetch manifests from an HTTP(S) URL via `--manifest-url`. Almost never seen on CKA. If a scenario references it, it looks the same in practice but the source is a URL, not a directory.

## Reload cadence

Two signals cause kubelet to re-evaluate the directory:

1. **File system watch** — inotify-style change detection. Create / modify / delete typically triggers within 1–2 seconds.
2. **Periodic resync** — every 20 s by default. This catches edge cases where the watch missed an event (rare on local filesystems, common on NFS).

In practice: save the file, wait 10–20 seconds, check `crictl ps` or the mirror pod's status.

There is no manual "reload" command. If you want to force a reconcile, touch the file:

```bash
sudo touch /etc/kubernetes/manifests/kube-apiserver.yaml
```

## Editing a manifest safely

Golden rule: keep a backup of every manifest before you change it.

```bash
sudo cp /etc/kubernetes/manifests/kube-apiserver.yaml /root/kube-apiserver.yaml.bak
```

**Do not edit with a YAML-aware tool that rewrites the file** (some editors strip BOMs, rewrap flow-style arrays, reorder keys). Use `vi`, `nano`, or another editor that preserves bytes. Kubelet is strict; any whitespace mistake can kill the pod.

The edit is effective as soon as you save. You cannot "stage" changes — there is no transaction.

## Removing a manifest temporarily

A very common recovery trick. To stop a static pod without breaking things irreversibly:

```bash
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
```

kubelet sees the file gone, kills the pod. Put it back when ready:

```bash
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
```

Using this pattern to restart the API server without fully rebooting kubelet is standard practice.

## What kubelet ignores

- Files not named `*.yaml` or `*.json` — silently skipped.
- Files that don't parse as a Pod spec — logged and skipped; kubelet continues.
- Subdirectories — kubelet does not recurse. All manifests must be flat in the watched dir.
- Files with the same pod name+namespace — only the first is kept; duplicates are rejected.

## Creating your own static pod

For a worker node, you can drop a file in the local manifest dir and it will run. Useful for things like node-local monitoring daemons that must run even if the API is down.

```yaml
# /etc/kubernetes/manifests/myagent.yaml
apiVersion: v1
kind: Pod
metadata:
  name: myagent
  namespace: kube-system
spec:
  containers:
    - name: myagent
      image: busybox
      command: ["sleep", "3600"]
```

Note:

- The `metadata.name` you see is the pod name. Kubelet appends the node name when creating the mirror pod (e.g. `myagent-nodeA`).
- The namespace must be set explicitly; `default` is unusual for system workloads.
- No `ownerReferences`; the kubelet stamps them.

## Manifest path checks

```bash
# Where does kubelet think static pods live?
grep -E 'staticPodPath|pod-manifest-path' /var/lib/kubelet/config.yaml \
  /etc/systemd/system/kubelet.service.d/*.conf 2>/dev/null

# Is the directory populated?
sudo ls -l /etc/kubernetes/manifests/

# Kubelet sees the files?
journalctl -u kubelet | grep -i 'static pod' | tail -n 20
```

## Common pitfalls

- **Wrong file path**: putting the manifest into `/etc/kubernetes/` (one level up) does nothing. It must be inside `/manifests/`.
- **Symlinks**: kubelet follows them, but if the target moves, you have a broken pod. Avoid symlinks here.
- **Invalid YAML**: kubelet logs a parse error and does nothing. Tail the journal to catch it.
- **Port collisions**: two static pods that bind the same host port on the node fight; one will keep crash-looping.
- **hostPath volumes**: allowed, but the path must exist on the node or be set to `DirectoryOrCreate`.
- **NFS-mounted manifest dir**: kubelet still works, but filesystem events are unreliable; rely on the 20 s resync.

## When a manifest change "doesn't stick"

If you edit a file and the pod doesn't change within 30 s:

1. Confirm the file was saved (`sudo cat` shows your edit).
2. Confirm the file is still in the right directory.
3. Check `journalctl -u kubelet | tail` for parse errors.
4. Check that the pod spec actually changed — some fields (e.g. readinessProbe result) don't trigger restart.
5. Check file permissions — the file must be readable by the kubelet user (usually root, so this rarely matters).

If all of that is fine and nothing changed, kubelet may be wedged. `systemctl status kubelet` will tell you.

## Fast commands cheat sheet

```bash
# Peek at the config
sudo cat /var/lib/kubelet/config.yaml | grep -i static

# List manifests
sudo ls /etc/kubernetes/manifests/

# Edit in place
sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml

# Temporary stop (move out)
sudo mv /etc/kubernetes/manifests/kube-scheduler.yaml /tmp/

# Watch reconcile
watch -n 1 'crictl ps | head'
```

## Exam heuristics

- Questions that say "change an apiserver flag" mean editing `/etc/kubernetes/manifests/kube-apiserver.yaml`. No kubectl.
- If the exam gives you a broken control plane and expects full recovery, the issue is almost always a file in `/etc/kubernetes/manifests/`.
- For kubelet config changes (e.g. "set cluster DNS"), edit `/var/lib/kubelet/config.yaml` and `systemctl restart kubelet`.

## Mental traps

- Trying to change the static pod path via `kubectl edit configmap kubelet-config`. That changes future nodes' config but not the running kubelet — you still need a restart.
- Expecting the API to reflect your file edits immediately. There is always a small reconcile delay.
- Overwriting the manifest with editor-specific metadata (e.g. `vim -` pipelines) and corrupting it.
- Copying a static pod YAML back into the directory with `.yaml.bak` extension. Kubelet only watches `.yaml` and `.json`. That prevents double-creation but also means "backups" in the dir are invisible — a feature, but worth noting.
