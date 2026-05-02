## kubelet's role with static pods

kubelet is the **only** component that handles static pods. Nothing else in the cluster is involved in their creation. The flow is:

1. kubelet reads the config value `staticPodPath` (default `/etc/kubernetes/manifests`).
2. It watches that directory for new / changed / removed files.
3. For each valid manifest, it runs a pod directly via the container runtime.
4. It publishes a **mirror pod** to the API so the pod shows up in `kubectl get`.

The source of truth is the file on disk. The API is a reflection.

## Directory watch mechanics

kubelet combines two signals:

- **inotify / fsnotify** for real-time change detection.
- A **~20 s resync** that rereads the directory from scratch, to catch missed events (NFS, odd filesystems, editor save-and-rename patterns).

In practice, edits propagate in 1–5 seconds on a local filesystem; rely on the resync as a safety net.

## What counts as a manifest

- `*.yaml` or `*.json` files only.
- Files must parse as a Pod spec (`apiVersion: v1`, `kind: Pod`).
- Subdirectories are not scanned. All manifests sit flat in the watched dir.
- Duplicate pod names (same name + namespace) in the directory — kubelet keeps the first, logs a warning about the rest.
- Non-pod kinds (Deployment, Service) — ignored with a parse/kind error in the journal.

## Mirror pod creation

As soon as kubelet runs the static pod, it synthesizes the mirror pod using the **same** spec, plus these kubelet-owned annotations:

```yaml
annotations:
  kubernetes.io/config.source: file
  kubernetes.io/config.hash: <sha of the manifest file contents>
  kubernetes.io/config.mirror: <same sha>
  kubernetes.io/config.seen: <timestamp kubelet first saw it>
```

The name becomes `<pod.metadata.name>-<node-name>`. The namespace is whatever the manifest says (usually `kube-system` for kubeadm control plane, `default` if unset).

If the apiserver is down, kubelet cannot create the mirror — but the real pod still runs. Mirror creation is "best effort" observability, not a precondition.

## Reconciliation: what if you change the file?

kubelet recomputes the config hash. If it differs from the last hash for this static pod, kubelet:

1. Stops the old container(s) gracefully (respecting `terminationGracePeriodSeconds`).
2. Starts new container(s) with the new spec.
3. Updates the mirror pod annotations with the new hash.

Effectively, an edit = a restart. There is no "in-place" update for static pods.

## What if the file is deleted?

kubelet stops the pod and removes the mirror pod. The node-local state cleans up. The actual container is killed and its image may remain cached.

This is the standard way to **pause** a static pod (move the file out, bring it back later).

## Scheduling and placement

Static pods always run on the node whose kubelet read the file. There is **no scheduler involvement**. Consequences:

- `spec.nodeName` is effectively fixed at runtime to the local node.
- `affinity`, `tolerations`, `topologySpreadConstraints` in the manifest are **ignored** for placement — kubelet runs the pod on its own node regardless.
- The mirror pod shows `spec.nodeName` set to the local node, but that's a reflection, not an input.

That said, tolerations and requests are still honored in other ways:

- **Resource requests / limits** are applied to the container (CFS quota, memory limits).
- **Tolerations** allow the *mirror* pod to stay bound to the node if the node is tainted — without them, the node controller's taint-based eviction could delete the mirror pod. kubelet would recreate it immediately, but events would churn.

That last point is why kubeadm's control plane manifests include `tolerations` for all the node-lifecycle taints.

## kubelet config knobs

Inside `/var/lib/kubelet/config.yaml`:

```yaml
staticPodPath: /etc/kubernetes/manifests
```

On older setups, the flag was `--pod-manifest-path=/etc/kubernetes/manifests`. Either works; kubelet picks whichever is set.

URL-based static pods (rare) use `--manifest-url=https://...` — same lifecycle, different source.

## Debugging static pod oddities

**Manifest present, no container running:**

```bash
sudo journalctl -u kubelet --no-pager | grep -i 'static\|manifest' | tail -n 20
sudo crictl ps -a
```

Typical causes:

- YAML parse error → kubelet logs `failed to parse manifest`.
- Image pull failure → `ErrImagePull` in `crictl ps -a`.
- CNI not installed → pod stuck in sandbox creation; see CNI-related errors in journal.
- Port collision with another static pod → one pod keeps restarting.

**Container running, no mirror pod:**

- apiserver unreachable → kubelet can't post mirror. Real pod is fine.
- Check `kubectl get events -n <ns>` — may show mirror creation errors.

**Mirror pod present, real container missing:**

- Rare; usually means kubelet started but the container runtime is down.
- Check `systemctl status containerd` (or cri-o).

**Changes don't propagate:**

- File wasn't saved under the watched path.
- Filesystem event missed — wait for 20 s resync or `sudo touch <file>`.
- File has wrong extension (e.g. `.yml` vs `.yaml`). kubelet accepts `.yaml` and `.json`.

## Multi-node considerations

On kubeadm HA, each control plane node has its own `/etc/kubernetes/manifests/`. Each node runs its own apiserver, etcd, scheduler, controller-manager static pods. They are independent files and can drift. If you update one node's manifest and not others, you have inconsistent control planes.

For a coordinated change, edit the manifest on each node, one at a time, waiting for health to come back between them.

## Key commands

```bash
# See what kubelet thinks the static pod path is
grep staticPodPath /var/lib/kubelet/config.yaml

# Snapshot of local manifests
sudo ls -l /etc/kubernetes/manifests/

# Journal focused on static pods
sudo journalctl -u kubelet --no-pager | grep -iE 'static|manifest|mirror'

# Real container state
sudo crictl ps -a

# Mirror pod view (only works if apiserver is alive)
kubectl get pods -A --field-selector spec.nodeName=<node> -o wide | \
  grep -E 'kube-|etcd'
```

## Exam heuristics

- When the exam says "make a static pod," write the YAML and drop it into `/etc/kubernetes/manifests/` on the target node. No `kubectl apply`.
- When the exam says "restart the control plane," bounce the relevant manifest files. No `systemctl restart kubelet` unless kubelet itself is broken.
- Deleting a mirror pod never stops the real pod. Don't try.

## Mental traps

- Expecting static pods to participate in Deployment-style rollouts. They don't. Each edit is a full pod replacement.
- Assuming the mirror pod's `spec.nodeName` is what got it placed there. That field is reflected *after* kubelet decided.
- Copying a static pod manifest to another node thinking it will "spread." Only the local kubelet runs it.
- Writing a static pod Deployment. A static pod is a Pod object, nothing else. A Deployment dropped into the manifest dir is ignored.
