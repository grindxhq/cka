## What a mirror pod is

A **mirror pod** is a read-only reflection of a static pod, inside the API server. Its purpose is purely observability: so `kubectl get pods` can show you that the API server (and its siblings) are actually running.

Two objects, one workload:

- The **real pod** — defined by the file on disk, managed by kubelet directly.
- The **mirror pod** — a Pod object in etcd, created by kubelet on behalf of the file.

The container state, logs, and resource usage you see in `kubectl describe` all come from the real pod via kubelet. The mirror is the visible tip.

## How to tell a mirror pod apart

Annotations:

```bash
kubectl get pod kube-apiserver-cp1 -n kube-system -o yaml | grep -A 3 annotations
```

You'll see:

```yaml
annotations:
  kubernetes.io/config.hash: <sha>
  kubernetes.io/config.mirror: <same-sha>
  kubernetes.io/config.seen: <timestamp>
  kubernetes.io/config.source: file
```

`config.source: file` is the giveaway. Regular pods have `config.source: api`.

Other tells:

- Name suffix is the node name (`-cp1`, `-node-a`).
- `ownerReferences` is empty or references the Node (not a ReplicaSet / DS).
- `nodeName` is set to the node where the manifest lives.

## Why `kubectl delete` doesn't do what you'd expect

Because the real pod is file-backed, not API-backed. When you delete the mirror:

1. The API deletes the Pod object.
2. kubelet notices the mirror is gone but the file on disk still says the pod should exist.
3. kubelet re-creates the mirror within seconds.

The real pod never stopped running. The "delete" was a no-op against the actual workload.

If you **want** to stop the pod, you must act on the file:

```bash
sudo mv /etc/kubernetes/manifests/<pod>.yaml /tmp/
```

Kubelet sees the file gone → kills the real pod → removes the mirror.

## `kubectl edit` on mirror pods

Similarly, `kubectl edit` appears to succeed but the change is wiped. kubelet reconciles the mirror against the on-disk spec and overwrites your edits.

To change a static pod, edit the file on disk.

## `kubectl logs` and `kubectl exec` still work

These operations are proxied through kubelet to the real container. The mirror is just an addressing mechanism — kubelet understands "this mirror corresponds to the container with CRI ID X."

```bash
kubectl logs kube-apiserver-cp1 -n kube-system
kubectl exec -it kube-apiserver-cp1 -n kube-system -- /bin/sh
```

Works identically to a regular pod.

## Ownership model

Mirror pods have no `ownerReferences` chain to a controller. Their lifecycle is tied to:

- The file on disk.
- The kubelet on the node.

If the node is deleted (kubelet stops publishing heartbeats, then the node is force-removed), the mirror pods eventually get garbage-collected. But the real pods keep running until kubelet itself stops.

Garbage collection rules for orphans apply only when the file is gone. As long as the file exists, kubelet will keep recreating the mirror.

## Mirror pod invariants

- One mirror per static pod, per node.
- Mirror pod namespace matches the static pod's `metadata.namespace`.
- Mirror pod name is `<static-pod-name>-<node-name>`.
- Mirror pod image, resources, mounts, probes are 1:1 with the file.
- Mirror pod `spec` is essentially read-only; kubelet owns it.

## Two static pods that would collide

If two files in the manifest directory have the same `metadata.name` + `metadata.namespace`, kubelet only accepts the first. The second's mirror pod never appears, and you'll see a warning in the kubelet journal. Not a common CKA scenario, but a good test of understanding.

## Debugging using the mirror

The mirror is still useful for diagnosis:

```bash
kubectl describe pod kube-apiserver-cp1 -n kube-system
# Events:
#   Pulled, Created, Started (all kubelet)
#   BackOff if crashing
```

If the mirror pod is missing entirely:

- Either kubelet is not running.
- Or the API server is not available to store the mirror. The real pod may still be alive (this is common during an apiserver outage).

## When the real pod disappears but mirror stays briefly

If kubelet crashes (but is restarted), the static pods stay up under the container runtime; the mirror pod may briefly become stale until kubelet reconciles. You can see this as `kubectl describe` showing a container uptime that disagrees with the mirror pod's creation time. Not a bug — just the observability lag.

## Fast commands

```bash
# List all mirror pods on this node
kubectl get pods -A --field-selector spec.nodeName=<node> -o json | \
  jq -r '.items[] | select(.metadata.annotations["kubernetes.io/config.source"]=="file") | .metadata.namespace+"/"+.metadata.name'

# Or across all nodes: any pod with config.source=file
kubectl get pods -A -o json | \
  jq -r '.items[] | select(.metadata.annotations["kubernetes.io/config.source"]=="file") | .metadata.namespace+"/"+.metadata.name'
```

## Exam heuristics

- Don't try to delete control plane pods via kubectl — it wastes time. Go straight to the file.
- Use the mirror pod's `describe` output to read events and status; use `kubectl logs` for the actual container logs.
- If `kubectl get pods` shows `kube-apiserver-*` missing, the real pod may still be alive on the node (file exists, API was briefly down). Check `crictl ps` on the node.

## Mental traps

- Believing the mirror pod is a real pod you can manage. It is not; it is telemetry.
- Editing the mirror to "try a change." The on-disk manifest is the source of truth.
- Expecting `kubectl rollout restart` or similar tools to work. They apply only to controllers, which static pods don't have.
- Deleting a mirror pod to "bounce" the static pod. Use `mv` on the file instead.
