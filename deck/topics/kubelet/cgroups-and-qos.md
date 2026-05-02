## Why this matters

A pod's CPU limit doesn't exist in Kubernetes. It exists as a number written into `cpu.max` in a Linux cgroup file, created by the kubelet, enforced by the kernel. Every `limit`, `request`, QoS class, and eviction decision eventually turns into cgroup manipulation.

Understanding cgroups is what lets you answer:

- Why does my pod "OOMKill" with exit code 137?
- Why does my container get throttled even when the node looks idle?
- What does the "Guaranteed" QoS class actually buy me?
- Why did my kubelet upgrade fail with "cgroup driver mismatch"?

---

## cgroup v1 vs cgroup v2

Linux control groups come in two versions. Modern Kubernetes clusters run on **cgroup v2** by default on recent distros; older clusters are still on v1. They look different on disk and have different semantics.

### v1: multiple hierarchies, one per controller

Each resource type (cpu, memory, pids, io, ...) has its own tree:

```
/sys/fs/cgroup/cpu/kubepods.slice/...       — CPU controller hierarchy
/sys/fs/cgroup/memory/kubepods.slice/...    — memory controller hierarchy
/sys/fs/cgroup/pids/kubepods.slice/...      — PID controller hierarchy
...and 10+ other controllers
```

A process is in one cgroup per controller. Separate trees mean you can't easily delegate a full "budget" to a subtree atomically.

### v2: unified hierarchy

One tree governs everything:

```
/sys/fs/cgroup/kubepods.slice/              — all controllers unified
├── kubepods-guaranteed.slice/
├── kubepods-burstable.slice/
└── kubepods-besteffort.slice/
```

Per-cgroup files:

- `cpu.max` — CPU bandwidth limit
- `cpu.weight` — CPU shares (relative weight)
- `memory.max` — hard memory limit
- `memory.high` — soft cap; kernel throttles before OOMKill
- `memory.min` — guaranteed minimum
- `memory.current` — live usage
- `pids.max` — process/thread cap
- `io.max` / `io.weight` — block I/O controls
- `cgroup.procs` — the PIDs inside this cgroup

### Key differences worth memorising

| Feature                | v1                                              | v2                                        |
|------------------------|-------------------------------------------------|-------------------------------------------|
| Hierarchy              | one per controller                              | single unified                            |
| Memory limit           | `memory.limit_in_bytes`                         | `memory.max` + `memory.high` (soft)       |
| Pressure signals       | none                                            | PSI (`memory.pressure`, `cpu.pressure`, `io.pressure`) |
| Delegation safety      | leaky                                           | clean; processes can manage subtrees      |
| Systemd integration    | imperfect                                       | native, reliable                          |
| MemoryQoS              | not available                                   | available (Kubernetes feature gate)       |
| Kernel minimum         | any                                             | Linux 5.8 recommended                     |

### Checking version on a node

```bash
# The "type" of the root cgroup filesystem tells you:
stat -fc %T /sys/fs/cgroup/
# cgroup2fs  → v2 (unified)
# tmpfs      → v1 (legacy, with separate controller mounts underneath)
```

Or:

```bash
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2 ...             → v2
# cgroup on /sys/fs/cgroup/cpu type cgroup ...           → v1
```

### Kubernetes and v1 deprecation

Kubernetes 1.35+ will no longer start on v1 by default. The `failCgroupV1: false` escape hatch exists for the transition but won't last long. If you're on an old distro (CentOS 7, Ubuntu 18.04), you need to upgrade the host before upgrading Kubernetes.

---

## The cgroup driver — systemd vs cgroupfs

Two drivers manage cgroups:

- **cgroupfs** — kubelet (and the runtime) write directly to `/sys/fs/cgroup` files.
- **systemd** — kubelet (and the runtime) ask systemd to create `.slice` / `.scope` units; systemd writes to cgroups.

On systemd-based distros (basically every Linux today), **systemd is PID 1** and itself manages cgroups under `/sys/fs/cgroup`. If two processes (kubelet using cgroupfs, systemd doing its own thing) both manage the same hierarchy, they fight. Processes get reparented unexpectedly, limits go missing, memory accounting drifts.

### The critical invariant

**kubelet and the container runtime must use the same cgroup driver.** Mismatch means:

- kubelet creates `/sys/fs/cgroup/kubepods.slice/burstable.slice/pod-<uid>.slice/`.
- Runtime creates `/sys/fs/cgroup/kubepods/burstable/pod-<uid>/` (no `.slice` suffix, cgroupfs style).
- Limits applied by one are invisible to the other. Containers run with no cgroup enforcement. Eventually the node wedges.

On kubeadm clusters (and anything systemd-based), use **systemd** for both.

### Configuring

**kubelet** (`/var/lib/kubelet/config.yaml`):

```yaml
cgroupDriver: systemd
```

**containerd** (`/etc/containerd/config.toml`):

```toml
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
  SystemdCgroup = true
```

**cri-o** (`/etc/crio/crio.conf.d/`):

```ini
[crio.runtime]
cgroup_manager = "systemd"
```

After editing either: `systemctl daemon-reload && systemctl restart containerd && systemctl restart kubelet`.

### Diagnosing driver mismatch

```bash
# kubelet's driver
grep -E 'cgroupDriver|cgroup-driver' /var/lib/kubelet/config.yaml

# containerd's driver
containerd config dump | grep -i SystemdCgroup
# SystemdCgroup = true  → systemd
# SystemdCgroup = false → cgroupfs

# Observed driver in logs
journalctl -u kubelet | grep -i 'cgroup' | tail
# "CGroupDriver: \"systemd\""
```

Symptom of mismatch: pods run but their cgroup paths don't show limits, or kubelet refuses to start with:

```
failed to initialize top level QOS containers: root container [kubepods] doesn't exist
```

---

## The pod cgroup hierarchy

Kubelet creates a tree of cgroups on every node:

```
/sys/fs/cgroup/
└── kubepods.slice/                                         ← node allocatable budget
    ├── kubepods-guaranteed.slice/                           ← QoS: Guaranteed
    │   └── kubepods-guaranteed-pod<uid>.slice/              ← one pod
    │       ├── cri-containerd-<container-id>.scope           ← one container
    │       └── cri-containerd-<container-id>.scope
    ├── kubepods-burstable.slice/                            ← QoS: Burstable
    │   └── kubepods-burstable-pod<uid>.slice/
    │       └── cri-containerd-<container-id>.scope
    └── kubepods-besteffort.slice/                           ← QoS: BestEffort
        └── kubepods-besteffort-pod<uid>.slice/
            └── cri-containerd-<container-id>.scope
```

Each level applies limits:

- `kubepods.slice` — equals the node's **Allocatable** (Capacity minus system-reserved minus kube-reserved minus eviction-threshold reserve).
- QoS slices — no explicit numeric limits, but Guaranteed gets highest memory OOM priority, BestEffort gets lowest.
- Pod slices — sum of container requests/limits.
- Container scopes — per-container values from the Pod spec.

### Finding a pod's cgroup

```bash
# Get the pod UID
POD_UID=$(kubectl get pod foo -o jsonpath='{.metadata.uid}')

# Find the cgroup dir
ls /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${POD_UID//-/_}.slice/

# Pod UID has dashes; systemd converts to underscores in slice names
```

For kubepods-guaranteed / kubepods-besteffort, substitute accordingly.

---

## How requests and limits become cgroup values

### CPU

Kubernetes uses two cgroup concepts for CPU:

- **CPU weight (shares)** from `requests.cpu` — relative weight when multiple cgroups compete.
- **CPU bandwidth (quota)** from `limits.cpu` — hard cap via CFS quota.

Mapping:

| Pod spec                  | v1                                                       | v2                                                           |
|---------------------------|----------------------------------------------------------|--------------------------------------------------------------|
| `requests.cpu: 500m`      | `cpu.shares = 512` (512 = 1 core's worth of shares × 0.5)  | `cpu.weight = 20` (scaled from 500m)                          |
| `limits.cpu: 500m`        | `cpu.cfs_quota_us=50000` + `cpu.cfs_period_us=100000`    | `cpu.max = "50000 100000"` (50ms quota per 100ms period)      |

No `limits.cpu` means no quota — the container can burst to the node's full CPU if idle.

CPU throttling: if the container exhausts its quota mid-period, the kernel stops scheduling it until the next period starts. Visible in metrics (`container_cpu_cfs_throttled_seconds_total`) and as sluggishness under load even when the node has idle CPU.

### Memory

Memory limits map directly:

| Pod spec                  | v1                              | v2                              |
|---------------------------|---------------------------------|---------------------------------|
| `requests.memory: 256Mi`  | (used for scheduling; no cgroup file) | (used for scheduling; `memory.min` if MemoryQoS on) |
| `limits.memory: 512Mi`    | `memory.limit_in_bytes = 536870912` | `memory.max = 536870912`        |

Memory pressure on a container's cgroup triggers the **OOM killer**. The kernel's OOM score:

- Guaranteed pods get the lowest score (most protected).
- Burstable pods get a middle score.
- BestEffort pods get the highest score (most likely victims).

When a container is OOMKilled, it exits with code **137** (128 + 9 = SIGKILL). kubelet sees the container died and restarts it per `restartPolicy`.

### Without limits

A pod with only requests (Burstable) and no limits can use all available memory on the node. If it does, and the node runs out, **kubelet eviction** kicks in (see pod-startup-and-eviction subtopic). For CPU, it can burst freely.

### Inspecting live limits

```bash
POD_UID=$(kubectl get pod foo -o jsonpath='{.metadata.uid}' | tr '-' '_')
CGROUP_DIR=/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${POD_UID}.slice

# v2:
cat $CGROUP_DIR/memory.max
cat $CGROUP_DIR/cpu.max
cat $CGROUP_DIR/memory.current        # live usage
cat $CGROUP_DIR/cpu.pressure          # PSI: some/full pressure metrics

# v1: (these live in per-controller trees)
cat /sys/fs/cgroup/memory/kubepods.slice/.../memory.limit_in_bytes
cat /sys/fs/cgroup/cpu/kubepods.slice/.../cpu.cfs_quota_us
```

---

## QoS classes and their cgroup consequences

Kubernetes assigns each pod a QoS class at admission. You cannot set it directly — it is derived from requests/limits:

| QoS class     | Condition                                               | cgroup placement            |
|---------------|---------------------------------------------------------|-----------------------------|
| **Guaranteed**| Every container has requests == limits for **both** CPU and memory | `kubepods.slice/kubepods-guaranteed.slice/` |
| **Burstable** | At least one container has requests/limits, and not Guaranteed | `kubepods.slice/kubepods-burstable.slice/` |
| **BestEffort**| No requests or limits set on any container             | `kubepods.slice/kubepods-besteffort.slice/` |

The QoS class drives:

- **OOM score**: Guaranteed < Burstable < BestEffort. Under memory pressure, BestEffort dies first.
- **Eviction order**: `kubelet` evicts BestEffort first, then Burstable exceeding requests, then Guaranteed last.
- **CPU placement**: Guaranteed pods with integer CPU limits can be pinned to exclusive CPUs by the CPU Manager (if enabled).

QoS is therefore a **cgroup-placement + priority-hint** system. It is **separate from scheduler priority** (which governs scheduling decisions, not runtime eviction).

### Why Guaranteed is "better"

A Guaranteed pod's container doesn't coexist with Burstable and BestEffort in its QoS slice — it's in its own, with lighter OOM killer pressure. A BestEffort pod on the same node fights for memory and gets killed first under pressure.

---

## Node Allocatable and kube-reserved / system-reserved

The root `kubepods.slice` doesn't get the full node. Kubelet carves out:

```
Node Capacity
  ├── system-reserved    (OS daemons: sshd, udev, journald)
  ├── kube-reserved      (kubelet, container runtime, CNI agent)
  ├── eviction-threshold (buffer before eviction fires)
  └── allocatable        (what Pods can use → kubepods.slice)
```

Configurable in `/var/lib/kubelet/config.yaml`:

```yaml
systemReserved:
  cpu: 500m
  memory: 512Mi
  ephemeral-storage: 1Gi
kubeReserved:
  cpu: 500m
  memory: 512Mi
evictionHard:
  memory.available: "500Mi"
  nodefs.available: "10%"
  imagefs.available: "15%"
systemReservedCgroup: /system.slice
kubeReservedCgroup: /kubelet.slice
enforceNodeAllocatable: [pods, system-reserved, kube-reserved]
```

`enforceNodeAllocatable: [pods]` means kubelet creates the `kubepods.slice` with an explicit total limit equal to Allocatable. Pods can't collectively exceed that — they hit OOM or eviction first. This is why the node has headroom for critical daemons even when pods are slamming memory.

---

## Common failure modes

### OOMKilled loop

```bash
kubectl describe pod foo
# Last State:
#   Terminated
#   Reason:   OOMKilled
#   Exit Code: 137
```

Root cause: container memory usage exceeded `limits.memory`. Fixes:

- Raise the limit if the app's legitimate need is higher.
- Profile the app (heap dumps, metrics) to find the leak.
- For Java/Go: set container-aware heap flags so runtime sees the cgroup limit (`-XX:+UseContainerSupport`, `GOMEMLIMIT`).

### CPU throttling despite idle node

```bash
# Look at the metric
kubectl exec -it foo -- cat /sys/fs/cgroup/cpu.stat
# nr_throttled ...
# throttled_time ...
```

If `throttled_time` is large, the container is hitting its `limits.cpu` even though the node has idle CPU. The container can't use what the node has; it can only use what its quota allows.

Fixes:

- Raise `limits.cpu`, or remove it entirely if you want burst-capable behaviour.
- Note: removing `limits.cpu` changes QoS from Guaranteed/Burstable boundary — verify the class you want.

### cgroup driver mismatch

Symptom: kubelet refuses to start. Journal shows:

```
failed to initialize top level QOS containers: root container [kubepods] doesn't exist
```

Fix: align kubelet's `cgroupDriver` and the runtime's `SystemdCgroup` / `cgroup_manager`. Both `systemd` on modern distros.

### MemoryQoS surprises

With `memoryQoS: true` (feature gate), `memory.min` is set on Guaranteed pods to guarantee a reserved slice, and `memory.high` is set on Burstable/BestEffort to throttle before OOM. Apps that assumed they'd get OOMKilled suddenly instead see throttled allocations, which may look like "random slowness."

### Node freezes with high memory load

If enforceNodeAllocatable excludes pods (misconfiguration), pods can collectively exceed Allocatable and starve kubelet itself. Kubelet stops heartbeating; node NotReady. Fix: ensure `enforceNodeAllocatable: [pods]` is set.

---

## Diagnostic cheatsheet

```bash
# cgroup version
stat -fc %T /sys/fs/cgroup/

# kubelet's view
kubectl describe node <node> | grep -A 3 'Capacity\|Allocatable'

# Live usage of a pod
POD_UID=$(kubectl get pod foo -o jsonpath='{.metadata.uid}' | tr '-' '_')
SLICE=/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${POD_UID}.slice
cat $SLICE/memory.current
cat $SLICE/cpu.stat

# Find runaway cgroup
find /sys/fs/cgroup/kubepods.slice/ -name memory.current \
  -exec sh -c 'printf "%-80s %s\n" "$1" "$(cat $1)"' _ {} \; | sort -k2 -n | tail

# System-wide pressure (v2)
cat /proc/pressure/memory
cat /proc/pressure/cpu
cat /proc/pressure/io
```

---

## Exam heuristics

- OOMKilled + exit 137 = container exceeded memory limit. Raise limit or fix app.
- CPU throttled even when node is idle = `limits.cpu` is the bottleneck, not capacity.
- Guaranteed pods are the hardest to evict; use when reliability matters.
- If you see kubelet failing on `root container [kubepods] doesn't exist`, suspect a cgroup driver mismatch first.
- `kubectl top pod` uses metrics-server, which reads the kubelet's stats summary, which reads from cgroup files. If `top` shows 0, suspect cgroup driver alignment.

## Mental traps

- Thinking CPU requests "reserve" CPU. They don't — they set relative weight only. Under no contention, any pod uses any idle CPU.
- Believing requests == limits is always better. Guaranteed QoS is stricter but also means no room to burst. Not always desired.
- Confusing QoS class with scheduling priority. Different systems. QoS → cgroup placement, OOM killing, eviction. Priority → scheduling queue order, preemption.
- Editing `/sys/fs/cgroup/` files by hand on a live node. Kubelet will overwrite them on the next sync; worse, mismatched state can crash the runtime.
- Running Java without container-aware heap flags. The JVM sees the host's RAM, not the cgroup's, and OOMKills itself.
- Running kubelet on cgroup v1 with expectations of v2 features (PSI, MemoryQoS). Check the cgroup version.
