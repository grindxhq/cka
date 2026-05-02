## What a static pod actually is

A **static pod** is a pod that kubelet runs directly from a manifest file on the node's filesystem — **without** going through the API server.

```
/etc/kubernetes/manifests/<something>.yaml
                │
                │  kubelet watches this directory
                ▼
         kubelet creates pod
                │
                ▼
    container running on node
```

That is the whole mechanism. No Deployment, no ReplicaSet, no scheduler, no etcd write *in the creation path*. The node itself is authoritative for the pod's existence.

## Why they exist

Because the control plane bootstraps itself somehow. You cannot run `kube-apiserver` as a regular pod — the regular pod path requires a running API server. Chicken, egg.

Static pods break that circularity: kubelet starts, reads the manifest directory, launches the API server (and etcd, scheduler, controller-manager) from local files. Once they are up, the cluster "comes online."

Kubeadm clusters therefore run their control plane as static pods on control plane nodes.

## Static pod vs regular pod

| Aspect                    | Static pod                              | Regular pod                              |
|---------------------------|-----------------------------------------|------------------------------------------|
| Source of truth           | manifest file on disk                   | API server (etcd)                        |
| Who creates it            | kubelet, reading the file               | a controller (RS, DS, Job) or user       |
| Scheduler involvement     | none — bound to this node by definition | scheduler picks a node                   |
| Delete via kubectl        | **no** — recreates immediately          | yes                                      |
| Visible in `kubectl get`  | yes, as a **mirror pod**                | yes, as itself                           |
| Node bound                | fixed to the local node                 | any feasible node                        |
| Owner reference           | none in manifest; mirror pod shows kubelet as "controller" | controller (RS, DS, Job) or empty |

## What "mirror pod" means

Even though a static pod is defined on disk, kubelet also creates a **mirror pod** in the API server so you can see it with `kubectl get pods -n kube-system`. The mirror pod is read-only from the API's perspective:

- You can `kubectl describe` it.
- You cannot effectively `kubectl delete` it — kubelet re-creates the mirror from the file within seconds.
- You cannot `kubectl edit` it to change the actual running config — the edit goes to the mirror, which is immediately overwritten.

To change a static pod, you change the **file on disk**. That is the only path.

## How you identify a mirror pod

```bash
kubectl get pod <name> -n kube-system -o jsonpath='{.metadata.annotations.kubernetes\.io/config\.source}'
# → "file" for static pods, "api" for regular pods
```

Other tells:

- Name suffix includes the node name (e.g. `kube-apiserver-cp1`).
- `ownerReferences` is empty or points to a Node, not a controller.
- Annotation `kubernetes.io/config.mirror` is present.

## The default path

```
/etc/kubernetes/manifests/
```

Contents on a kubeadm control plane:

```
kube-apiserver.yaml
kube-controller-manager.yaml
kube-scheduler.yaml
etcd.yaml
```

Each is a standard Pod spec. Kubelet creates one pod per file. Deleting a file stops the pod.

## What "breaking a static pod" feels like

If you make an invalid edit to `kube-apiserver.yaml`:

- Within a few seconds, kubelet attempts to recreate the pod.
- If the YAML is invalid, kubelet logs a parse error and does nothing.
- If YAML parses but the container crashes, `crictl` shows it restarting.
- The API becomes unavailable immediately — other control plane components lose contact.

This is a node-local failure with cluster-wide consequences. Recovery happens entirely on the node.

## Consequences worth internalizing

- Static pods are the **only pods** that keep running when the API server is down.
- kubelet does **not** need the API to launch a static pod.
- A broken static pod manifest for **etcd** or **kube-apiserver** takes the control plane offline instantly.
- A broken static pod manifest for **kube-scheduler** or **kube-controller-manager** keeps the API alive but breaks new-work reconciliation.

## Tools that matter

```bash
# Read the files
sudo ls -l /etc/kubernetes/manifests/
sudo cat /etc/kubernetes/manifests/kube-apiserver.yaml

# Watch kubelet reconcile
journalctl -u kubelet -f

# See actual containers (bypass API)
crictl ps -a
crictl logs <container-id>

# See the mirror pod (if API is alive)
kubectl get pods -n kube-system -o wide
```

## Mental model shortcuts

- If you can only change one file to recover the control plane, it is one of these four manifests.
- `kubectl delete pod` on a mirror pod is not a real operation. It deletes the mirror; kubelet recreates it.
- The static pod lives at the filesystem layer. Its mirror lives at the API layer. Keep them separate in your head.
- "Restart the apiserver" on kubeadm = move its manifest out, wait a few seconds, move it back. The kubelet-driven reconcile does the rest.

## Exam heuristics

- Any question about "the control plane on node X is broken" is 80% of the time a static pod problem.
- If `kubectl` is broken, `crictl` and `journalctl -u kubelet` are your lifelines.
- If you edit a manifest and nothing changes, check your file path (must be under `/etc/kubernetes/manifests/`) and that you actually saved the file.

## Mental traps

- Trying to `kubectl edit` the apiserver pod to change a flag. The edit is discarded.
- Creating a static pod by applying a YAML with `kubectl` — that is a regular pod, not static.
- Treating the mirror pod's lifecycle as authoritative. It is purely reflection.
- Forgetting that static pods **bypass admission webhooks**. They are not validated by anything except kubelet's parser.
