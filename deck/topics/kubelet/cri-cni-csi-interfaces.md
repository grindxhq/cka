## The three interfaces kubelet depends on

The kubelet doesn't know how to run a container. It doesn't know how to set up pod networking. It doesn't know how to attach a block device. It **delegates** all three to separate plugin systems:

```
          ┌────────────────────────────────┐
          │         kubelet                │
          └─────────┬──────────────────────┘
                    │
      ┌─────────────┼─────────────────────┐
      │             │                     │
      ▼             ▼                     ▼
  ┌──────┐    ┌──────────┐           ┌────────┐
  │ CRI  │    │ CNI      │           │ CSI    │
  │ gRPC │    │ binaries │           │ gRPC   │
  └───┬──┘    └────┬─────┘           └────┬───┘
      │            │                       │
      ▼            ▼                       ▼
  containerd    /opt/cni/bin/           CSI node
  / cri-o       plugins                 plugin DaemonSet
  (runs         (invoked per-           (runs on each
   containers)   sandbox by runtime)     node, mounts vols)
```

Each interface has a different shape, a different failure mode, and a different diagnostic path. If a pod is stuck `ContainerCreating`, one of these three is almost always the cause.

---

## CRI — the container runtime interface

### What it is

CRI is a **gRPC API** kubelet uses to talk to the container runtime. It was introduced so kubelet doesn't need to be recompiled for each runtime — docker, containerd, cri-o all implement the same protobuf interface.

Two services inside one gRPC endpoint:

| Service | Methods (selected) | What they do |
|---------|-------------------|--------------|
| **RuntimeService** | `RunPodSandbox`, `StopPodSandbox`, `RemovePodSandbox`, `CreateContainer`, `StartContainer`, `StopContainer`, `RemoveContainer`, `ListContainers`, `ListPodSandbox`, `ContainerStatus`, `ExecSync`, `Attach` | Lifecycle of pods and containers at the runtime layer |
| **ImageService** | `PullImage`, `RemoveImage`, `ListImages`, `ImageStatus`, `ImageFsInfo` | Container image management |

The single socket at `unix:///run/containerd/containerd.sock` (or cri-o's equivalent) serves both.

### Configuration

Kubelet reads `containerRuntimeEndpoint` from its config file (or the flag):

```yaml
# /var/lib/kubelet/config.yaml
containerRuntimeEndpoint: unix:///run/containerd/containerd.sock
imageServiceEndpoint:     unix:///run/containerd/containerd.sock
```

Defaults to containerd's socket on modern clusters. For cri-o it would be `unix:///var/run/crio/crio.sock`.

### The pod sandbox — the "pause" container

Every pod starts with a **sandbox**: a minimal "pause" container whose only job is to own:

- The pod's network namespace (all application containers share it).
- The pod's IPC / UTS / mount namespaces (by default).
- The pod's cgroup root.

When the sandbox exists, application containers join its namespaces. When the sandbox dies, the pod is effectively gone.

The sandbox creation flow:

```
kubelet → CRI RuntimeService.RunPodSandbox(sandboxConfig) → runtime:
  1. create new network namespace
  2. invoke CNI ADD for the namespace (→ pod IP)
  3. start the pause container attached to that namespace
  4. return sandbox ID + IP to kubelet
```

If CNI fails here, sandbox creation fails. Pod stuck `ContainerCreating` with events like `FailedCreatePodSandBox`.

### Full pod lifecycle at CRI level

```
kubelet receives Pod assigned to this node
    │
    ▼
RunPodSandbox   — creates pause container + network namespace
    │
    ▼
(for each init container in order)
  PullImage (if needed) → CreateContainer → StartContainer → wait for exit
    │
    ▼
(for each main container)
  PullImage (if needed) → CreateContainer → StartContainer
    │
    ▼
    ... pod runs ...
    │
    ▼
(on delete)
StopContainer (each) → RemoveContainer (each) → StopPodSandbox → RemovePodSandbox
```

### `crictl` — the debugging lifeline when kubectl is broken

`crictl` talks directly to the CRI socket. Essential when the apiserver is down, kubelet is broken, or you're debugging node-level pod lifecycle.

```bash
# Point crictl at the right socket (usually auto-detected)
export CONTAINER_RUNTIME_ENDPOINT=unix:///run/containerd/containerd.sock

# List all pod sandboxes (running + stopped)
sudo crictl pods

# List containers (across all pods)
sudo crictl ps -a

# Container logs (when kubectl logs can't reach the apiserver)
sudo crictl logs <container-id>
sudo crictl logs -f <container-id>           # follow
sudo crictl logs --tail 100 <container-id>

# Inspect a container in detail
sudo crictl inspect <container-id>

# Run a one-shot command inside a container
sudo crictl exec -it <container-id> /bin/sh

# Image management
sudo crictl images
sudo crictl pull <image>
sudo crictl rmi <image>

# Prune unused images (useful when disk-pressure is the issue)
sudo crictl rmi --prune
```

Mental rule: **when the apiserver / kubelet is flaky, crictl is truthful**. It reads directly from the runtime without going through any Kubernetes layer.

### Common CRI failures

| Symptom                                              | Root cause                                                 | Where to look                                              |
|------------------------------------------------------|------------------------------------------------------------|-------------------------------------------------------------|
| `FailedCreatePodSandBox` — "failed to setup network" | CNI error during sandbox creation                          | /var/log/kubelet, /etc/cni/net.d, CNI pod logs              |
| `CreateContainerError`                               | Runtime can't construct the OCI spec (bad mount, etc.)     | `crictl inspect <container-id>`, kubelet journal            |
| `RunContainerError`                                  | Container starts but exits non-zero                        | `crictl logs <container-id>`                                |
| Kubelet journal: `connection refused` on CRI socket  | Runtime isn't running                                      | `systemctl status containerd` / `systemctl start containerd`|
| Images never pull                                    | Bad registry credentials, private registry, DNS            | `crictl pull <image>` for direct test                       |

When kubelet and runtime disagree on what containers exist, kubelet reconciles by calling ListContainers and ListPodSandbox. Inconsistency between kubelet's view and `crictl` output is a red flag — restart kubelet, or investigate the runtime.

---

## CNI — the container network interface

### What it is

CNI is **not a gRPC API**. It is a specification for invoking plugin **binaries** with environment variables and reading JSON on stdin/stdout.

When a sandbox is created, the container runtime (not kubelet) invokes CNI:

```
runtime forks a CNI plugin binary
  with environment vars: CNI_COMMAND=ADD, CNI_NETNS=/proc/xxx/ns/net,
                         CNI_CONTAINERID=..., CNI_IFNAME=eth0
  and JSON config on stdin (from /etc/cni/net.d/...)

plugin does its work: creates veth, assigns IP, writes iptables rules

plugin writes JSON result on stdout:
  { "cniVersion": "1.0.0", "interfaces": [...], "ips": [...], ... }
```

### File layout

Two filesystem locations matter:

```
/opt/cni/bin/              plugin binaries
├── bridge
├── calico
├── calico-ipam
├── cilium-cni
├── flannel
├── host-local
├── loopback
├── portmap
├── bandwidth
└── ...

/etc/cni/net.d/            plugin configurations, sorted alphabetically
├── 10-calico.conflist
└── 99-loopback.conf
```

The first file in `/etc/cni/net.d/` (by name sort) is the **default network** for every pod. Kubelet checks this directory for readiness. If it is empty, kubelet sets the node condition `NetworkPluginNotReady=true` and refuses to start pods.

The config file is usually a `.conflist` — a chain of plugins invoked in order:

```json
{
  "cniVersion": "1.0.0",
  "name": "k8s-pod-network",
  "plugins": [
    { "type": "calico", "ipam": {"type": "host-local", "subnet": "usePodCidr"}, ... },
    { "type": "portmap", "capabilities": {"portMappings": true} },
    { "type": "bandwidth", "capabilities": {"bandwidth": true} }
  ]
}
```

Each plugin in the list gets invoked in sequence; later plugins receive the previous plugin's result as additional input.

### The commands: ADD, DEL, CHECK

- **ADD** — called on sandbox creation. Plugin allocates IP, sets up interfaces, returns result.
- **DEL** — called on sandbox removal. Plugin tears down, releases IP.
- **CHECK** — called periodically to verify the network is still correct (rarely used in practice).

Failures at ADD propagate as `FailedCreatePodSandBox`. Failures at DEL are typically logged but not blocking — the sandbox is going away anyway.

### Typical CNI plugin deployments

On Kubernetes, the CNI plugin runs as a **DaemonSet** with:

1. An init container that drops the plugin binary into `/opt/cni/bin/` and the config into `/etc/cni/net.d/` (these directories are hostPath mounts).
2. A long-running agent that maintains cluster-wide networking state (BGP sessions for Calico, VXLAN for Flannel, eBPF programs for Cilium).

When you `kubectl apply -f calico.yaml`, you get a DaemonSet that, once scheduled on every node, renders these files into place. Until that happens, the node is `NetworkPluginNotReady`.

### Pod IP assignment walk-through

```
1. kubelet: Pod assigned to this node; spec has PodIP=nil
2. kubelet → CRI RunPodSandbox
3. runtime creates network namespace
4. runtime → CNI ADD plugin=<from conflist>:
     plugin calls IPAM (host-local / calico-ipam / etc.) to allocate IP
     plugin creates veth pair: one end in pod netns, other on host
     plugin sets routes, iptables rules
     plugin returns IP 10.244.1.5
5. runtime stores IP in sandbox metadata
6. runtime returns sandbox ID to kubelet
7. kubelet PATCHes pod.status.podIP = 10.244.1.5
```

### What breaks CNI

| Symptom                                     | Cause                                                          |
|---------------------------------------------|----------------------------------------------------------------|
| Node NotReady with `NetworkPluginNotReady`  | `/etc/cni/net.d/` empty, or no CNI DaemonSet pod on this node  |
| Pods stuck `ContainerCreating` with `failed to set up sandbox: plugin type="xyz" not found` | Binary missing from `/opt/cni/bin/` |
| Pod gets IP, but can't reach other pods     | IPAM allocated wrong CIDR, or overlay/routing not converged   |
| Intermittent CreatePodSandBox failures      | CNI plugin or its agent is flapping                            |
| Pod creation is very slow                   | IPAM is contended (multiple pods starting on one node); or the plugin makes slow API calls |

Diagnostics:

```bash
# Config directory
sudo ls /etc/cni/net.d/
sudo cat /etc/cni/net.d/*.conflist

# Plugin binaries
sudo ls /opt/cni/bin/

# CNI agent DaemonSet
kubectl get pods -n kube-system -l k8s-app=calico-node -o wide     # Calico
kubectl get pods -n kube-system -l app.kubernetes.io/name=cilium   # Cilium

# CNI pod logs on a broken node
kubectl logs -n kube-system <cni-pod>

# Pod IP after creation
kubectl get pod <pod> -o jsonpath='{.status.podIP}'
```

### The responsibility boundary

- **kubelet**: decides when a pod needs networking, requests a sandbox.
- **runtime** (containerd / cri-o): invokes CNI plugins.
- **CNI plugins**: do the actual work, write rules to the host.

This means kubelet logs are rarely the best place to diagnose CNI — they show "sandbox creation failed," not why. The runtime log (`journalctl -u containerd`) shows the CNI invocation error. The CNI pod log shows the plugin's perspective.

---

## CSI — the container storage interface

### What it is

CSI is a **gRPC API**, like CRI, but for storage. It defines how kubelet mounts volumes and how the control plane attaches/detaches block devices to/from nodes.

The split:

- **Controller plugin** (runs as a Deployment in a CSI driver namespace): implements cluster-scope operations — provision, delete, attach, detach, expand, snapshot.
- **Node plugin** (runs as a DaemonSet): implements node-scope operations — stage (mount to node path), publish (bind-mount into pod), unpublish, unstage.

Kubelet only talks to the **node plugin**, via a Unix socket.

### Registration via the plugin watcher

Kubelet runs a `pluginsWatcher` goroutine that watches a directory:

```
/var/lib/kubelet/plugins_registry/
└── <driver-name>/
    └── csi.sock           ← CSI node plugin's gRPC socket
```

When a CSI driver's DaemonSet pod starts, it mounts this hostPath and creates its socket there. The watcher sees the new file, opens a gRPC connection, calls `GetPluginInfo()` and `NodeGetInfo()`, and records the driver. Now kubelet knows "volumes of type foo.csi.io get routed to this driver at this socket."

The `CSIDriver` Kubernetes object is metadata about the driver (does it support attach? does it need VolumeAttachment? is mode block or filesystem?) — but the actual connection is the socket.

### The two-step mount: stage + publish

For every pod using a CSI volume, two RPCs happen:

1. **NodeStageVolume** — run **once per volume, per node**. Creates a staging mount at:
   ```
   /var/lib/kubelet/plugins/kubernetes.io/csi/<driver>/<volume>/globalmount
   ```
   Formats the filesystem if needed (e.g. mkfs on a fresh EBS volume), performs the "big" mount.

2. **NodePublishVolume** — run **once per pod using the volume**. Bind-mounts the staging dir into:
   ```
   /var/lib/kubelet/pods/<pod-uid>/volumes/kubernetes.io~csi/<claim-name>/mount
   ```
   This bind-mount becomes the container's `volumeMounts.mountPath`.

Why two steps? Because multiple pods on the same node may use the same RWX volume — you stage it once, publish it many times. And staging is expensive (format + mount).

### Attach vs mount — different components

A frequent source of confusion:

| Operation                        | Scope                       | Who performs it                                                 |
|----------------------------------|-----------------------------|-----------------------------------------------------------------|
| **Attach** (block device → node) | cluster-wide                | the attach-detach controller in kube-controller-manager          |
| **Stage** (mount at node)         | node-local                  | kubelet + CSI **node** plugin                                   |
| **Publish** (bind-mount into pod) | node-local                  | kubelet + CSI **node** plugin                                   |
| **Detach**                       | cluster-wide                | the attach-detach controller in kube-controller-manager          |

Attach is implemented via `VolumeAttachment` objects. The attach-detach controller creates one; the `external-attacher` sidecar (running alongside the CSI controller plugin) watches them and calls `ControllerPublishVolume` on the driver. kubelet waits until the `VolumeAttachment.status.attached=true` before calling NodeStageVolume.

### The external sidecars

CSI drivers need to talk to the Kubernetes API — but the CSI spec is cloud-agnostic, not Kubernetes-specific. Kubernetes solves this by running **sidecars** next to the driver's controller plugin:

| Sidecar               | Watches                  | Calls on the driver                       |
|-----------------------|--------------------------|-------------------------------------------|
| `external-provisioner`| PVC objects              | `CreateVolume` / `DeleteVolume`           |
| `external-attacher`   | VolumeAttachment objects | `ControllerPublishVolume` / `Controller*Unpublish*`|
| `external-resizer`    | PVC spec size changes    | `ControllerExpandVolume`                  |
| `external-snapshotter`| VolumeSnapshot objects   | `CreateSnapshot` / `DeleteSnapshot`       |

Those sidecars are why a CSI driver deployment has 5 containers in one Pod — the driver + four translators between Kubernetes and CSI semantics.

### Common CSI failures

| Symptom                                      | Root cause                                                      |
|----------------------------------------------|-----------------------------------------------------------------|
| PVC Pending indefinitely                     | external-provisioner not running / wrong StorageClass / driver not registered |
| Pod stuck `ContainerCreating` with `attach failed` | VolumeAttachment not progressing; external-attacher logs   |
| Pod stuck `ContainerCreating` with `MountVolume.SetUp failed` | NodeStageVolume or NodePublishVolume failed; check CSI node plugin logs |
| "volume already attached to another node" (multi-attach) | RWO volume trying to attach to a second node before first releases; previous pod's node hung |
| Volume resize stuck                          | external-resizer not running, or driver doesn't support resize  |

Diagnostic path:

```bash
# Is the driver registered on this node?
ls /var/lib/kubelet/plugins_registry/

# Is the CSI node plugin pod running?
kubectl get pods -n <driver-namespace> -l app=<driver-name> -o wide --field-selector spec.nodeName=<node>

# VolumeAttachment state
kubectl get volumeattachment

# Node plugin logs
kubectl logs -n <driver-namespace> <driver-pod> -c <driver-container>

# kubelet's view
journalctl -u kubelet | grep -i csi | tail -n 40
```

---

## The three together — a complete pod startup walk

Creating a pod with a PVC:

```
1. apiserver: Pod created, bound to node-1
2. kubelet on node-1 sees the Pod assigned to it

   --- storage setup ---
3. kubelet reads pod spec, finds volumes[].persistentVolumeClaim
4. kubelet waits for VolumeAttachment to be attached (if needed)
5. kubelet calls NodeStageVolume via CSI node socket
6. kubelet calls NodePublishVolume via CSI node socket
      → pod's volume is now bind-mounted into /var/lib/kubelet/pods/.../volumes/...

   --- runtime + network ---
7. kubelet calls CRI RunPodSandbox
8. runtime creates network namespace
9. runtime invokes CNI ADD
      → CNI plugin allocates IP 10.244.1.5, wires veth
10. runtime returns sandbox ID + IP to kubelet
11. kubelet PATCHes pod.status.podIP=10.244.1.5

   --- containers ---
12. kubelet calls CRI PullImage (if image not cached)
13. kubelet calls CRI CreateContainer with OCI spec (mounts from step 6, namespace from step 7)
14. kubelet calls CRI StartContainer
15. kubelet runs readiness/liveness probes
16. kubelet PATCHes pod.status.conditions[]
```

Any step 5–14 failure shows as `ContainerCreating`. Any step 15 failure shows as `Running` but not `Ready`. Knowing which step failed → knowing which of CRI/CNI/CSI to debug.

---

## Diagnostic matrix

| Symptom                                         | Component        | First check                                                           |
|-------------------------------------------------|------------------|-----------------------------------------------------------------------|
| Pod never starts, sandbox creation fails        | CNI              | `/etc/cni/net.d/` populated? CNI DaemonSet pod on this node running?  |
| Pod stuck mid-creation, "failed to start container" | CRI           | `crictl ps -a`, `crictl inspect`, kubelet journal                     |
| Pod stuck with "MountVolume" or "attach failed" | CSI              | VolumeAttachment state, CSI driver pods                               |
| Node NotReady                                   | CRI or CNI       | runtime service status; CNI config presence                           |
| Image won't pull                                | CRI (ImageService)| `crictl pull <image>` for direct test                                 |
| ConfigMap/Secret volume missing                 | kubelet internal  | journal "SetUp failed", RBAC on kubelet for Secret/ConfigMap reads    |

---

## Exam heuristics

- If the scenario says "pods stuck ContainerCreating," your first questions are: is the CNI config present? Is the CSI volume attached? Only then do you dig into the runtime.
- `crictl` is the debugging tool you reach for when kubectl is flaky. Memorize `crictl ps -a`, `crictl logs`, `crictl pods`.
- If the node is NotReady and journal says NetworkPluginNotReady, the fix is installing or repairing the CNI DaemonSet.
- A CSI driver's own `csi.sock` must live under `/var/lib/kubelet/plugins_registry/<driver>/` — if it doesn't, kubelet never sees the driver.
- PVC Pending vs Pod ContainerCreating: PVC stage is pre-scheduling (PVC must bind); Pod ContainerCreating with volume errors is post-scheduling (kubelet can't mount).

## Mental traps

- Confusing CRI socket and CSI socket. Different endpoints, different protocols.
- Blaming kubelet for CNI failures. Kubelet hands off sandbox-creation to the runtime; the runtime invokes CNI. Look at the runtime's log for CNI errors.
- Expecting Docker CLI to work on a kubeadm node. It doesn't by default — the runtime is containerd, not docker. `docker ps` returns nothing.
- Treating "pod has IP" as "pod is ready." The IP is assigned at sandbox creation; the pod can still fail probes.
- Thinking CSI node plugin and controller plugin are the same process. They're almost always separate Pods — one DaemonSet (per-node), one Deployment (cluster).
- Forgetting that `attach` is a cluster-wide operation. If attach is stuck, look at kube-controller-manager, not kubelet.
- Missing the `external-provisioner` step when a PVC is stuck Pending. That sidecar must be running for dynamic provisioning to work.
