## The CRI sits between kubelet and the runtime

```
   kubelet                              container runtime
     │                                     (containerd / cri-o)
     │ gRPC over unix socket                  │
     │ /var/run/containerd/containerd.sock    │
     ├────────────────────────────────────────┤
     │                                         │
     │ RuntimeService.RunPodSandbox            │
     ├──────────────────────────────────────►  │  creates pause container,
     │                                         │  network namespace
     │                                         │
     │ ImageService.PullImage                  │
     ├──────────────────────────────────────►  │  pulls image
     │                                         │
     │ RuntimeService.CreateContainer          │
     ├──────────────────────────────────────►  │  creates app container in sandbox
     │                                         │
     │ RuntimeService.StartContainer           │
     ├──────────────────────────────────────►  │  starts the app process
```

The Container Runtime Interface (CRI) is a **gRPC API** that lets kubelet stay generic — it doesn't care whether the runtime is containerd, cri-o, or anything else, as long as it implements CRI.

This is also what enables `crictl` to talk directly to the runtime, bypassing kubelet entirely.

---

## Two services, one socket

CRI defines two gRPC services on a single Unix socket:

### RuntimeService

Pod and container lifecycle:

- `RunPodSandbox(config) → sandbox_id`
- `StopPodSandbox(sandbox_id)`
- `RemovePodSandbox(sandbox_id)`
- `ListPodSandbox(filter) → [sandboxes]`
- `PodSandboxStatus(sandbox_id) → status`
- `CreateContainer(sandbox_id, config) → container_id`
- `StartContainer(container_id)`
- `StopContainer(container_id, timeout)`
- `RemoveContainer(container_id)`
- `ListContainers(filter) → [containers]`
- `ContainerStatus(container_id) → status`
- `ExecSync(container_id, cmd) → stdout, stderr, exit_code`
- `Exec(container_id, cmd) → streaming session`
- `Attach(container_id) → streaming session`
- `PortForward(sandbox_id, ports) → streaming session`

### ImageService

Image management:

- `PullImage(image, auth) → image_ref`
- `RemoveImage(image_ref)`
- `ListImages(filter) → [images]`
- `ImageStatus(image_ref) → details`
- `ImageFsInfo() → filesystem usage`

---

## Pod sandbox — the "pause" container

A **sandbox** (also called the infrastructure container or pause container) holds the pod's:

- **Network namespace** (so all containers in the pod share the network).
- **IPC namespace**.
- **Mount namespace** (sometimes shared, sometimes not).
- **Cgroup root** (if configured).

When kubelet says "create a pod," the runtime first runs `RunPodSandbox`, which:

1. Creates the network namespace.
2. Invokes the CNI plugin to set up networking and assign a pod IP.
3. Starts the pause container (typically `registry.k8s.io/pause:3.9`).
4. Returns a sandbox ID.

The pause container does literally nothing — its sole purpose is to hold the namespaces alive. Once it exists, kubelet adds application containers via `CreateContainer`, which join the sandbox's namespaces.

If the sandbox dies (oddly), all containers in the pod die with it.

---

## How kubelet finds the runtime

Kubelet config:

```yaml
# /var/lib/kubelet/config.yaml or via flag
containerRuntimeEndpoint: unix:///run/containerd/containerd.sock
imageServiceEndpoint:     unix:///run/containerd/containerd.sock
```

Defaults to containerd's standard socket. For cri-o:

```yaml
containerRuntimeEndpoint: unix:///var/run/crio/crio.sock
```

Kubeadm sets this correctly during init based on what runtime is detected.

---

## Runtime engine choices

### containerd

The most common runtime today. Was originally Docker's runtime; now CNCF graduated as a standalone project. Implements CRI directly (no shim needed since the dockershim removal in 1.24).

Config: `/etc/containerd/config.toml`. Critical setting for kubeadm:

```toml
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
  SystemdCgroup = true       # match kubelet's cgroupDriver
```

CLI: `ctr` (low-level), `nerdctl` (Docker-compatible UX), `crictl` (CRI-level).

### cri-o

Lighter-weight; designed specifically for Kubernetes (no general-purpose container management). Used by Red Hat OpenShift.

Config: `/etc/crio/crio.conf`. Cgroup driver:

```ini
[crio.runtime]
cgroup_manager = "systemd"
```

CLI: `crictl` for CRI-level. Less common standalone tooling.

### Docker (deprecated as a runtime)

Pre-1.24, kubelet supported Docker via a "dockershim." Removed in 1.24 — you can still run Docker on the node for development, but it's not what kubelet talks to. Production clusters use containerd or cri-o.

If you have a cluster from <1.24 that's been upgraded, it's now using containerd directly.

### Other runtimes

- **gVisor** — sandboxed runtime (security-focused).
- **Kata Containers** — VM-isolated containers.
- **Firecracker** — lightweight VMs.

These usually run via runtimeClass — kubelet selects them per-pod based on `spec.runtimeClassName`. Out of CKA scope but worth knowing.

---

## OCI runtime spec (one layer down)

Below CRI, there's the OCI (Open Container Initiative) runtime spec. The CRI runtime (containerd, cri-o) generates an OCI bundle (a directory with `config.json` + `rootfs/`) and invokes an **OCI runtime** to actually start the container.

The default OCI runtime is **runc** (a small Go binary). Other runtimes:

- **runsc** — gVisor's runtime.
- **kata-runtime** — Kata's runtime.
- **crun** — a C-based runc alternative.

Layer view:

```
   kubelet
      │ CRI (gRPC)
      ▼
   containerd / cri-o            (CRI implementation)
      │ OCI runtime exec
      ▼
   runc                          (OCI runtime)
      │ syscall (clone, execve, ...)
      ▼
   container process              (your app)
```

For diagnostics, you usually only interact with kubelet (via kubectl) and the CRI runtime (via crictl). runc is mostly invisible.

---

## CRI versioning

`v1` CRI is the stable version (since 1.26). Older clusters used `v1alpha2` or `v1beta1`. Modern kubeadm clusters use `v1`.

Mismatched versions: if you upgrade Kubernetes faster than the runtime supports, kubelet may fail to register:

```
kubelet: failed to find a working CRI runtime: rpc error
```

Fix: upgrade containerd/cri-o to a compatible version.

---

## How `crictl` connects

`crictl` reads its config from `/etc/crictl.yaml`:

```yaml
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
timeout: 30
debug: false
```

Or via env:

```bash
export CONTAINER_RUNTIME_ENDPOINT=unix:///run/containerd/containerd.sock
export IMAGE_SERVICE_ENDPOINT=unix:///run/containerd/containerd.sock
```

Or per-command:

```bash
sudo crictl --runtime-endpoint=unix:///run/containerd/containerd.sock ps
```

If `/etc/crictl.yaml` exists (kubeadm creates it), no flag needed. Just `sudo crictl ps`.

---

## What you can do without kubelet

Even if kubelet is broken / down, the runtime is still running containers (as long as the runtime daemon itself is up). `crictl` lets you:

- List running containers (`crictl ps`).
- View their logs (`crictl logs`).
- Inspect their config (`crictl inspect`).
- Start/stop/remove containers (`crictl start/stop/rm`).
- Pull/list/remove images (`crictl pull/images/rmi`).

This is your lifeline when the apiserver is unreachable. Detailed in the next two subtopics.

---

## CRI failure modes

### Runtime not running

```bash
sudo systemctl status containerd
# inactive (dead)
```

Kubelet can't talk to CRI. Pods don't start. Fix:

```bash
sudo systemctl restart containerd
sudo systemctl restart kubelet
```

### Socket missing

```bash
ls /run/containerd/containerd.sock
# No such file or directory
```

containerd might not be configured to expose this socket, or runs in a different location. Check `/etc/containerd/config.toml`'s `[grpc]` section.

### Cgroup driver mismatch

```
kubelet: cgroup driver is "cgroupfs", containerd uses "systemd" — mismatch
```

Pod creation succeeds but cgroup limits are inconsistent. Eviction misbehaves.

Fix: align both to `systemd`:

```yaml
# kubelet
cgroupDriver: systemd

# containerd
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
  SystemdCgroup = true
```

Restart both.

### Image pull failures at the runtime level

`crictl pull <image>` fails. Causes:

- No internet from the node.
- Wrong credentials (registry auth at the node level vs imagePullSecrets).
- Registry's TLS cert is broken / self-signed without `--insecure-registry`.

```bash
sudo crictl pull alpine:latest          # standalone test
```

If this fails, all pods using that image will fail to pull.

---

## Inspecting the runtime via metrics

Many runtimes expose Prometheus metrics:

- containerd: `--metrics-address` config in `[metrics]` section, default off in stock kubeadm.
- cri-o: `--metrics-port` flag.

Example metric:

```
container_cpu_usage_seconds_total
container_memory_usage_bytes
```

These are runtime-level, distinct from cAdvisor's metrics (which kubelet exposes). Both useful.

---

## kubelet's container-related decisions

kubelet, via CRI, makes these decisions per pod:

- When to pull an image (per `imagePullPolicy`).
- When to create the sandbox (when `spec.nodeName == this node`).
- When to start a container (after init containers, etc.).
- When to restart a container (on exit, per `restartPolicy`).
- When to garbage-collect old containers / images (per kubelet GC config).

The runtime is reactive — it does what kubelet asks. Decisions are kubelet's; execution is the runtime's.

---

## Why CRI matters for the operator

You don't usually interact with CRI directly. But knowing it exists helps when:

- Pods are stuck `ContainerCreating` — could be sandbox / image / runtime issue.
- Apiserver is down — `crictl` is your only debugging tool.
- Cluster upgrade compatibility — runtime version must keep up with kubelet.
- Performance investigation — runtime config (cgroup driver, runtime engine) affects pod behavior.

---

## Exam heuristics

- For "the apiserver is broken, debug from the node," reach for `crictl`.
- Containerd's socket: `/run/containerd/containerd.sock`. cri-o: `/var/run/crio/crio.sock`.
- `crictl ps` for containers; `crictl pods` for sandboxes.
- For "image won't pull," try `sudo crictl pull <image>` to test runtime-level.
- For "cgroup mismatch errors," align kubelet and runtime to systemd.

## Mental traps

- Confusing `crictl` with Docker. Different APIs, similar UX, but `crictl ps` doesn't show what's outside Kubernetes (e.g. system containers running directly via `ctr`).
- Thinking kubelet creates containers itself. It delegates to CRI; the runtime daemon does the work.
- Forgetting that the pause container is part of every pod. It's the foundation; deleting it kills the pod.
- Restarting `containerd` while pods are running. Containers survive (they're processes), but new container operations fail until containerd is back. Brief outage.
- Trying to use Docker CLI on a kubeadm node. Even if Docker is installed, kubelet doesn't talk to it; pods are managed by containerd.
- Using `ctr` (containerd's native CLI) on Kubernetes nodes. It targets the wrong namespace; CRI operates in the `k8s.io` namespace. Use `crictl` instead.
