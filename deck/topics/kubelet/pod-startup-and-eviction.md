## The kubelet as node resource manager

Once a pod is assigned to a node, kubelet owns its entire lifecycle. That involves much more than just "tell the runtime to start it." Kubelet has to:

- **Admit** the pod: verify it can actually run here (resources, node conditions, OS).
- **Stage** the pod: fetch images, mount volumes, prepare the sandbox.
- **Run** the pod: start containers, evaluate probes, restart on failure.
- **Monitor** the pod's health and the node's: PLEG, cAdvisor, eviction signals.
- **Protect** the node: image garbage collection, disk/memory eviction, pressure conditions.

Failure in any of these surfaces as `Pending`, `ContainerCreating`, `CrashLoopBackOff`, `Evicted`, or the node flipping `NotReady`. This note walks the machinery.

---

## Pod admission — what kubelet checks before starting anything

When a pod lands on the node (via watch), kubelet runs **admit handlers** before it even asks the runtime to do anything:

1. **Predicates** — does the pod's resource request fit in Allocatable?
2. **AppArmor / seccomp profile** — is the requested profile available?
3. **Runtime class** — does the runtime support the requested class?
4. **Eviction-pressure checks** — if the node has `MemoryPressure=True`, a BestEffort pod is rejected.
5. **Topology manager** — can the CPU/memory topology be honored (if TopologyManager is on)?

An admit failure does not kill the pod — it just doesn't start here. The pod stays pending until kubelet re-admits or until it's deleted. You'll see it in events:

```
kubectl get events --field-selector reason=OutOfcpu,reason=NodeAffinity
```

Where the scheduler differs: the scheduler admits against **projected** state (sum of requests on node), kubelet admits against **live** state. A race between two pods scheduled at the same moment can fail at kubelet admission even though the scheduler approved.

---

## The pod startup sequence (kubelet-side)

Once admitted:

```
1. Allocate cgroup for pod (QoS → slice → pod.slice)
2. For each volume:
     - if PVC+CSI: wait for VolumeAttachment, then stage + publish
     - if configMap/secret: render files into /var/lib/kubelet/pods/<uid>/volumes/...
     - if emptyDir: allocate tmpfs or disk dir
     - if hostPath: verify path exists (DirectoryOrCreate creates it)
3. Create sandbox (CRI RunPodSandbox → pause container + CNI ADD → IP)
4. Pod acquires IP; patch pod.status.podIP
5. For each init container (in order):
     - PullImage if not cached
     - CreateContainer + StartContainer + wait for Exit
6. For each main container (in parallel):
     - PullImage if not cached
     - CreateContainer + StartContainer
     - Start liveness/readiness probes
7. Update pod.status: Ready conditions, container statuses
```

A pod in `ContainerCreating` is stuck at one of steps 2–5. `kubectl describe pod` usually tells you which.

---

## Image management and ImagePullBackOff

### How kubelet pulls images

Kubelet calls CRI `ImageService.PullImage` for every container. The runtime:

- Authenticates (using `imagePullSecrets` or the node's credential provider).
- Pulls the manifest, then the layers.
- Records the image in the local store.

If the pull fails, kubelet marks the container `ErrImagePull` and retries with exponential backoff (`ImagePullBackOff` in the interim).

### Pull policies

| `imagePullPolicy`     | Behavior                                                    |
|-----------------------|-------------------------------------------------------------|
| `Always`              | Pull every time the container starts. Default for `:latest`. |
| `IfNotPresent`        | Only pull if not in local cache. Default for other tags.    |
| `Never`               | Never pull; fail if not in cache.                           |

`latest` tag → `Always`. Pin your tags; don't use `latest` in production.

### Private registries

Two ways to authenticate:

- **imagePullSecrets** on the pod (or its ServiceAccount).
- **Kubelet credential provider** — external binary called by kubelet to get fresh creds (used for ECR, GCR, ACR without static secrets). Configured via `--image-credential-provider-config` / `--image-credential-provider-bin-dir`.

Common failure:

```
Failed to pull image "private.io/app": rpc error: code = Unknown
  desc = failed to pull: failed to resolve reference ...
  unauthorized: authentication required
```

Means the imagePullSecret is missing, wrong namespace, or not attached to the pod's SA.

### Image garbage collection

Images accumulate on disk and eventually fill the node. Kubelet has a built-in GC:

- Runs periodically.
- When `imagefs` free space drops below `imageGCHighThresholdPercent` (default 85%), kubelet starts removing images.
- Removes images until free space reaches `imageGCLowThresholdPercent` (default 80%).
- Removes in order: oldest unused first (last-used timestamp).

Config:

```yaml
# /var/lib/kubelet/config.yaml
imageGCHighThresholdPercent: 85
imageGCLowThresholdPercent:  80
imageMinimumGCAge: 2m
```

An image in use by a running container is never removed. An image of a stopped container can be collected.

Force manual GC:

```bash
sudo crictl rmi --prune
```

---

## PLEG — the hidden heartbeat

**PLEG = Pod Lifecycle Event Generator**. A kubelet-internal component that polls the runtime (`ListContainers`, `ListPodSandbox`) to detect changes kubelet wasn't explicitly told about (out-of-band stops, OOM kills, crashes).

PLEG runs on a ticker (default every 1s). It compares the runtime's current state with kubelet's last-known state and emits events (ContainerStarted, ContainerDied, etc.) that drive status updates.

### The PLEG is not healthy warning

```
PLEG is not healthy: pleg was last seen active 3m20s ago; threshold is 3m0s
```

This is kubelet saying: "the runtime has not responded to my PLEG polls for more than 3 minutes." Consequences:

- Kubelet marks the node `NotReady`.
- Node controller starts its 40s → 5m eviction timer.
- Running pods eventually get evicted and rescheduled.

Common causes:

- **Runtime is overloaded**: too many containers on the node slow down `ListContainers` RPC. Reduce pod density.
- **Runtime is stuck**: containerd hanging on a specific container's metadata. Restart the runtime.
- **Disk I/O pressure**: the runtime's database (containerd's boltdb at `/var/lib/containerd`) is slow.
- **Many zombie / stopped containers**: `crictl ps -a | wc -l` — if thousands, GC them.

Recovery usually involves:

```bash
sudo systemctl restart containerd
sudo systemctl restart kubelet
```

And investigating why the runtime was slow.

---

## Node-pressure eviction — the kubelet's self-defence

When a node is running out of memory, disk, or PIDs, kubelet **evicts** pods preemptively, before the kernel's OOM killer steps in or the node becomes unresponsive.

Eviction is different from:

- **Scheduler preemption** (kills pods to make room for a higher-priority pod).
- **API-initiated eviction** (`kubectl drain`; uses the eviction subresource; respects PDBs).
- **OOM kill** (kernel-level; hits one container, not a whole pod).

Node-pressure eviction:

- **Respects** `priorityClassName` tiers (evicts lower priority first) — ish, see below.
- **Does not respect** PodDisruptionBudgets (preservation of quorum takes a back seat to saving the node).
- **Does not respect** `terminationGracePeriodSeconds` on hard evictions (uses 0s).
- **Does respect** `terminationGracePeriodSeconds` on soft evictions (up to `evictionMaxPodGracePeriod`).

### Signals monitored

| Signal                    | What it means                                          |
|---------------------------|--------------------------------------------------------|
| `memory.available`        | Node free memory (Capacity - workingSet)               |
| `nodefs.available`        | Filesystem where kubelet's `/var/lib/kubelet` lives   |
| `nodefs.inodesFree`       | Inode free count on nodefs                             |
| `imagefs.available`       | Filesystem where container images are stored (if separate) |
| `imagefs.inodesFree`      | Inodes on imagefs                                      |
| `pid.available`           | `kernel.pid_max - current-pids`                        |
| `containerfs.*`           | (If separate) container writable layer disk             |

Kubelet polls these via cAdvisor every 10 seconds (default `housekeeping-interval`).

### Hard vs soft thresholds

**Hard** — breach = immediate eviction with 0s grace:

```yaml
evictionHard:
  memory.available: "100Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"
  pid.available: "10%"
```

**Soft** — breach must persist for `evictionSoftGracePeriod` before eviction (which then uses `evictionMaxPodGracePeriod`):

```yaml
evictionSoft:
  memory.available: "500Mi"
  nodefs.available: "15%"
evictionSoftGracePeriod:
  memory.available: "1m30s"
  nodefs.available: "1m30s"
evictionMaxPodGracePeriod: 30
```

Kubeadm defaults to the hard values above. Soft is optional and usually used in production clusters that want a "warning window."

### Minimum reclaim

`evictionMinimumReclaim` says "when I evict, free at least this much":

```yaml
evictionMinimumReclaim:
  memory.available: "0Mi"
  nodefs.available: "500Mi"
  imagefs.available: "2Gi"
```

Prevents kubelet from oscillating (evict 1 pod → signal recovers → next tick it's bad again → evict another).

### The pod ranking algorithm

When kubelet decides to evict for a signal (say memory.available), it ranks candidate pods:

1. **Exclude** pods with `priorityClassName: system-node-critical` or pods that are static (can't evict what kubelet is running).
2. **Sort by priority** ascending — lower priority first.
3. **Within same priority, sort by** (usage - requests) descending. A BestEffort pod with no request but high usage is right at the top of the kill list.
4. For filesystem evictions: sort by total disk usage descending.

The first pod in the ranking is evicted. If the signal still exceeds threshold, kubelet evicts the next one, subject to `evictionMinimumReclaim`.

### Before evicting pods: reclaim node resources

Kubelet tries cheap recovery first:

- **imagefs pressure** → runs image GC (may free GiBs without touching pods).
- **memory pressure** → runs container GC (removes dead containers whose state is still held).
- **nodefs pressure** → deletes dead container logs in `/var/log/pods/`.

Only after that doesn't clear the signal does it evict user pods.

### Eviction events

```bash
kubectl get events --field-selector reason=Evicted
kubectl get pods -A --field-selector status.phase=Failed | grep -i Evicted
kubectl describe pod <evicted>
# Status:       Failed
# Reason:       Evicted
# Message:      The node had condition: [DiskPressure].
```

An evicted pod's status is `Failed`. Its controller (Deployment, DaemonSet) sees this and creates a replacement.

---

## Pressure conditions and their scheduler side-effects

When kubelet is above a soft threshold, it flips a node condition:

```bash
kubectl describe node <node> | grep Conditions -A 20
```

| Condition             | Cause                                  | Side effect                                                 |
|-----------------------|----------------------------------------|-------------------------------------------------------------|
| `MemoryPressure`      | `memory.available` below threshold     | Scheduler refuses to place new BestEffort pods here          |
| `DiskPressure`        | `nodefs.available` or `imagefs.available` below threshold | Scheduler refuses new pods here                    |
| `PIDPressure`         | `pid.available` below threshold        | Scheduler refuses new pods here                              |
| `NetworkUnavailable`  | CNI not ready (rare after startup)     | Scheduler refuses new pods here                              |

A "taint-based-eviction" mechanism also applies these as taints (`node.kubernetes.io/memory-pressure:NoSchedule`), which is how the scheduler picks them up.

The condition clears automatically when the signal recovers below threshold for `evictionPressureTransitionPeriod` (default 5m). Without that dampening, the condition would flap every few seconds as kubelet evicted one pod → signal recovered → pressure gone → another pod creates memory → pressure returns.

---

## Debugging checklist for node-level pod problems

### "Pod stuck ContainerCreating"

```bash
kubectl describe pod <pod>
# read events

# Walk the sequence:
# 1. Volumes attached?
kubectl get volumeattachment

# 2. Sandbox created?
crictl pods | grep <pod-name>

# 3. CNI ok?
cat /etc/cni/net.d/*
kubectl logs -n kube-system <cni-pod>

# 4. Image pulled?
crictl images | grep <image>

# 5. Container running?
crictl ps -a | grep <pod-name>
```

### "Pod CrashLoopBackOff"

```bash
# Current logs
kubectl logs <pod>

# Previous container's logs (the one that crashed)
kubectl logs <pod> --previous

# Runtime-level logs (if kubectl logs is empty)
crictl ps -a | grep <pod>
crictl logs <container-id>

# Reason from events
kubectl describe pod <pod> | tail -20
# Last State:   Terminated
# Reason:       <OOMKilled / Error / ContainerCannotRun>
# Exit Code:    <137 / 1 / other>
```

### "Pod evicted repeatedly"

```bash
# What signal triggered it?
kubectl describe pod <evicted> | grep Message

# Node pressure state
kubectl describe node <node> | grep Conditions -A 10

# Kubelet metrics endpoint (on the node)
curl -sk https://localhost:10250/metrics/cadvisor | grep -E 'container_memory_usage_bytes|container_fs_usage_bytes' | head
```

### "Node NotReady, pods not being evicted"

This one catches people. Kubelet being broken (PLEG unhealthy, unable to reach apiserver) does not mean the pods on it are automatically evicted. The node controller sees the kubelet is silent, marks the node NotReady, and then the **taint-based-eviction** starts a 5-minute timer (matching `tolerationSeconds` for the `not-ready`/`unreachable` taints). Only after that timer do pods get recreated elsewhere.

To speed it up, you can delete the Node object (`kubectl delete node <n>`) — this immediately orphans its pods, and their controllers recreate them elsewhere. Use only when you know the node is permanently gone.

---

## Kubelet's view: useful endpoints

Kubelet exposes an HTTP API on port 10250 (TLS) and 10255 (read-only, often disabled). Useful paths (requires client cert auth):

```
/healthz                              is kubelet alive
/pods                                  current pod list kubelet knows about
/metrics                               Prometheus metrics for kubelet itself
/metrics/cadvisor                      container-level metrics (memory, CPU, disk)
/stats/summary                         node + pod + container summary (what metrics-server reads)
/logs/                                 node log files (if authorized)
/run/<ns>/<pod>/<container>            invoke a command (same as kubectl exec)
```

For debugging without kubectl:

```bash
# From another CP or authorized node
curl -sk --cert client.crt --key client.key https://<node-ip>:10250/healthz
curl -sk --cert client.crt --key client.key https://<node-ip>:10250/stats/summary | jq
```

---

## Exam heuristics

- Pod Pending at the scheduler layer vs ContainerCreating at the kubelet layer — different fixes. `kubectl describe pod` events tell you which.
- Exit code 137 ≠ 1. Code 137 = OOMKilled by kernel. Code 1 = app decided to exit with error.
- Eviction is kubelet-triggered, not scheduler-triggered. PDBs don't protect from eviction.
- `crictl ps -a` is your lifeline when kubectl isn't working. Know the top handful of commands.
- Image GC is automatic, but you can force it with `crictl rmi --prune`. Useful to recover from disk pressure without touching pods.
- `PLEG is not healthy` is always worth investigating — it means the runtime is unhealthy.

## Mental traps

- Blaming the scheduler for "ContainerCreating." That state is kubelet-level.
- Expecting PDBs to block eviction. Node-pressure eviction ignores them.
- Trying to use `kubectl cordon` to stop eviction. Cordon stops scheduling; it does not stop kubelet from evicting pods already on the node.
- Assuming `Evicted` pods will restart automatically. The pod object is Failed; only if a parent controller manages it does a replacement come.
- Thinking `OutOfMemory` at the node and `OOMKilled` at the container are the same. Node-level pressure triggers eviction (whole pod); container limit breach triggers OOM killer (one container).
- Setting hard eviction thresholds too aggressively. Evictions cause churn; tune to actual headroom.
- Believing kubelet's pod view matches apiserver's perfectly. PLEG polls have lag; sometimes kubelet "thinks" a pod is in a different state until reconcile.
- Forgetting that `imagefs` can be separate from `nodefs`. On nodes where `/var/lib/containerd` is on a different volume than `/var/lib/kubelet`, the two signals are independent.
