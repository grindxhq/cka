## The CRI command-line tool

`crictl` is the Kubernetes-aware CLI for any CRI-compliant runtime. Same commands work whether the runtime is containerd or cri-o. It talks directly to the CRI gRPC socket.

Configuration: `/etc/crictl.yaml` (or env vars). Kubeadm sets this up.

```yaml
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
timeout: 30
```

Run with `sudo` — the socket is root-owned.

---

## Listing containers

```bash
sudo crictl ps                              # running containers
sudo crictl ps -a                            # all (including stopped)
sudo crictl ps --name <name-prefix>         # filter by name
sudo crictl ps --label app=web              # filter by label
sudo crictl ps -q                            # IDs only

# Output:
# CONTAINER       IMAGE                    CREATED       STATE     NAME              ATTEMPT   POD ID
# 7c9f4d8a3b      registry.k8s.io/pause    5 days ago    Running   POD               0         abc123
# 5fd8c9d8f6      nginx@sha256:...         5 days ago    Running   nginx             0         abc123
```

`POD` is the sandbox; other rows are app containers. Same `POD ID` (`abc123`) means same pod.

---

## Listing pods (sandboxes)

```bash
sudo crictl pods                            # running pods
sudo crictl pods -a                          # all (incl. stopped sandboxes)
sudo crictl pods --name <prefix>            # filter
sudo crictl pods --namespace dev             # filter by namespace
sudo crictl pods -o json                     # JSON output

# Output:
# POD ID          CREATED       STATE     NAME                  NAMESPACE   ATTEMPT
# abc123          5 days ago    Ready     web-5fd8c9d8f6-abc12  default      0
```

Note: `crictl pods` shows **sandboxes** (the pause container's holding cells), not the application containers. To see what's inside, use `crictl ps`.

---

## Inspecting a container

```bash
sudo crictl inspect <container-id>           # full JSON
sudo crictl inspect <container-id> | jq '.status.image'
sudo crictl inspect -o table <container-id>  # tabular output (1.27+)
```

Useful fields:

- `.info.config.command` — the actual command that ran.
- `.info.config.envs` — env vars.
- `.info.runtimeSpec.process.args` — OCI-spec args.
- `.status.exitCode` — last exit code.
- `.status.startedAt` / `.status.finishedAt` — timing.
- `.info.pid` — host PID of the container's main process.

The `.info.pid` is what `nsenter` needs to enter the container's namespace (without exec).

---

## Inspecting a pod (sandbox)

```bash
sudo crictl inspectp <pod-id>

# Useful fields:
# .info.runtimeSpec.linux.namespaces — namespaces the pod uses
# .info.config.linux.cgroup_parent  — cgroup hierarchy
# .info.network.podIP                — pod IP from CNI
```

Confirms the pod's network namespace, cgroup, etc. Helpful when debugging "the pod thinks it's in NS X but the cluster says NS Y."

---

## Logs

```bash
sudo crictl logs <container-id>                  # full logs
sudo crictl logs --tail=100 <container-id>       # last 100 lines
sudo crictl logs -f <container-id>                # follow (like tail -f)
sudo crictl logs --since 5m <container-id>       # last 5 minutes

# By pod + container name (longer form, but doesn't require remembering the ID)
sudo crictl logs $(sudo crictl ps -q --pod <pod-id> --name <container-name>)
```

Output is the container's stdout+stderr. For `kubectl logs --previous` equivalent: there's no flag; `crictl logs` shows current. To see previous instance's logs:

```bash
# All containers (running and stopped) for a pod
sudo crictl ps -a --pod <pod-id>

# Logs for the stopped one
sudo crictl logs <stopped-container-id>
```

Stopped containers' logs persist until they're garbage-collected (kubelet GC policy).

---

## Exec — run a command in a container

```bash
# One-shot
sudo crictl exec <container-id> ls /etc

# Interactive shell
sudo crictl exec -it <container-id> /bin/sh

# With sync semantics (blocks until command returns)
sudo crictl exec --sync <container-id> -- echo hello
```

Like `kubectl exec`, but goes directly through CRI. Useful when kubelet/apiserver is broken.

---

## Image management

```bash
# List images
sudo crictl images
sudo crictl images -q                            # IDs only
sudo crictl images -o yaml                        # full output

# Pull an image
sudo crictl pull alpine:latest
sudo crictl pull --auth user:password registry.example.com/private/image:tag

# Remove an image
sudo crictl rmi <image-ref-or-id>

# Prune unused images (not referenced by any container)
sudo crictl rmi --prune

# Inspect image
sudo crictl inspecti <image-id>

# Image filesystem usage
sudo crictl info | jq '.status.runtimeReady, .status.networkReady'   # runtime overall health
sudo crictl info -o json | jq '.containerd'        # containerd-specific info
```

Useful for:

- Pre-pulling large images to avoid first-pod startup delay.
- Cleaning up after an `imagepullpolicy: Always` deployment created many image versions.
- Diagnosing "is this image actually on this node?"

---

## Runtime info

```bash
sudo crictl info
# Returns runtime status, namespaces, capabilities

sudo crictl version
# Server: containerd 1.7.11
# Client: 1.7.11
```

`crictl info`'s output is a JSON dump of runtime configuration. Look at:

- `runtimeReady` / `networkReady` — top-level health.
- Plugin info — what's loaded.
- Cgroup driver — should match kubelet's.

---

## Manually starting / stopping containers (rare)

```bash
sudo crictl stop <container-id>
sudo crictl rm <container-id>

# For pods (sandboxes)
sudo crictl stopp <pod-id>
sudo crictl rmp <pod-id>
```

Note the **double-p** for pods (`stopp`, `rmp`). The single `p` versions don't exist.

In normal Kubernetes operation, you don't manually start containers via `crictl`. Kubelet recreates them per its policy. Stopping a kubelet-managed container = kubelet starts a new one.

Direct `crictl` create/start is for unusual debugging cases (cluster diagnosis when kubelet is broken).

---

## Common patterns

### Find the container running a specific image

```bash
sudo crictl ps -a -o json | \
  jq -r '.containers[] | select(.image.image | contains("nginx")) | .id + " " + .metadata.name'
```

### List containers in CrashLoopBackOff (high restart count)

```bash
sudo crictl ps -a -o json | \
  jq -r '.containers[] | select(.metadata.attempt > 5) |
    "\(.id) \(.metadata.name) attempts=\(.metadata.attempt)"'
```

`metadata.attempt` is the restart count for that container in its current pod sandbox.

### Find the largest images (disk space culprits)

```bash
sudo crictl images -o json | \
  jq -r '.images[] | "\(.size // 0) \(.repoTags[0])"' | sort -nr | head
```

### Tail logs for every running container

```bash
sudo crictl ps -q | xargs -I {} sudo crictl logs --tail=10 {} 2>&1 | head -100
```

### Find pods where a specific container died

```bash
sudo crictl ps -a -o json | \
  jq -r '.containers[] | select(.state == "CONTAINER_EXITED") |
    "\(.metadata.name) exit=\(.exitCode // "?") created=\(.createdAt)"'
```

---

## Equivalent commands cheat sheet

| kubectl                   | crictl (when kubectl unavailable)               |
|---------------------------|-------------------------------------------------|
| `kubectl get pods`         | `crictl pods`                                   |
| `kubectl get pods -A`      | `crictl pods -a`                                |
| `kubectl logs <pod>`        | `crictl logs <container-id>`                    |
| `kubectl exec -it <pod>`   | `crictl exec -it <container-id> /bin/sh`        |
| `kubectl describe pod`     | `crictl inspect <container-id>`                 |
| `kubectl get pod -o yaml`  | `crictl inspectp <pod-id>` for sandbox          |
| (no equivalent)            | `crictl rmi --prune` (clean unused images)      |

`crictl` works node-locally; `kubectl` works cluster-wide. Different scopes; don't expect 1:1 equivalence.

---

## When to reach for `crictl`

- **kubectl is unavailable** (apiserver down, kubeconfig broken, network broken).
- **Kubelet is broken** (kubectl can't see this node's pods).
- **Diagnosing image pulls** (testing `crictl pull` independently of pod creation).
- **Disk pressure cleanup** (`crictl rmi --prune`).
- **Verifying a pod's containerd state** vs apiserver's view (rarely they disagree).
- **Inspecting cgroup / namespace details** that kubectl doesn't expose.

For day-to-day operation, kubectl is sufficient. `crictl` is the emergency toolkit.

---

## Limitations

- **No `kubectl`-style label selectors.** Filtering is by `--name`, `--label`, `--namespace`.
- **No port-forward** in older versions; modern versions support `crictl port-forward <pod-id> <ports>`.
- **No `top`** — runtime metrics are via metrics-server (which routes through kubelet, which routes through CRI's stats API).
- **No batch operations** like `kubectl delete -f file.yaml`. crictl is per-resource imperative.

---

## A debug session example

Apiserver is broken. SSH to a CP node:

```bash
# What's running?
sudo crictl pods

# POD ID          STATE   NAME                                         NAMESPACE   ATTEMPT
# 7c9f4d8a3b      Ready   kube-apiserver-cp1                          kube-system  0
# 5fd8c9d8f6      Ready   kube-controller-manager-cp1                 kube-system  0
# abc123          Ready   etcd-cp1                                    kube-system  0

# Get the apiserver container in that sandbox
sudo crictl ps --pod 7c9f4d8a3b

# CONTAINER       IMAGE                                STATE     NAME             ATTEMPT
# def456          registry.k8s.io/kube-apiserver:1.30  Running   kube-apiserver   3

# attempt=3 means it restarted 3 times — was it crashlooping?

# Get its logs
sudo crictl logs def456

# Last 100 lines
sudo crictl logs --tail=100 def456

# Look for the actual error. Common: invalid flag, expired cert, etcd unreachable.
```

If the apiserver is running but kubectl can't reach it: probably a TLS / cert issue. Inspect the cert:

```bash
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -dates
```

If apiserver isn't running:

```bash
# Check kubelet's view
sudo journalctl -u kubelet | tail -50

# Check the static pod manifest
sudo cat /etc/kubernetes/manifests/kube-apiserver.yaml
```

`crictl` + journalctl + cat manifest = full debugging without kubectl.

---

## Restarting a stuck control plane container

If apiserver is wedged (running but unresponsive):

```bash
# Find the container
APISERVER_ID=$(sudo crictl ps --name kube-apiserver -q)

# Stop it — kubelet will recreate from the static pod manifest
sudo crictl stop $APISERVER_ID

# Wait
sleep 5

# Verify a new container started (different ID, attempt count incremented)
sudo crictl ps --name kube-apiserver
```

This is the equivalent of "restart the apiserver" without going through kubectl.

For a more complete restart, move the manifest:

```bash
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
# kubelet sees no manifest, kills the pod completely
sleep 10
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
# kubelet sees the manifest again, starts a fresh pod
```

---

## Filtering by labels — the kubelet-injected ones

Kubelet sets labels on each sandbox / container:

```bash
sudo crictl pods --label io.kubernetes.pod.name=<pod-name>
sudo crictl pods --label io.kubernetes.pod.namespace=<ns>
sudo crictl ps --label io.kubernetes.container.name=<container>
```

`io.kubernetes.*` labels are how kubelet annotates everything. Useful for finding specific things:

```bash
# All control-plane sandboxes
sudo crictl pods --label io.kubernetes.pod.namespace=kube-system

# Just the apiserver
sudo crictl pods --label io.kubernetes.pod.namespace=kube-system \
                 --label io.kubernetes.pod.name=kube-apiserver-$(hostname)
```

---

## Exam heuristics

- For "kubectl isn't working, debug locally on the node," `sudo crictl ps -a` and `sudo crictl logs <id>`.
- For "image is broken on this node," `sudo crictl rmi <image>` to remove + retry.
- `crictl logs --previous` doesn't exist — find the previous container's ID via `crictl ps -a` and use `crictl logs <id>`.
- For "what's in this pod's sandbox," `crictl pods -q --name <prefix>` then `crictl ps --pod <sandbox-id>`.
- `crictl info` confirms runtime is healthy.

## Mental traps

- Forgetting `sudo`. Socket is root-only.
- Confusing `crictl ps` (containers) with `crictl pods` (sandboxes). Different objects.
- Trying `crictl exec` on a stopped container. Error — only running containers.
- Manually stopping kubelet-managed containers and being surprised they come back. Kubelet's reconcile loop will recreate them.
- Using `ctr` (containerd's native CLI) when you wanted `crictl` (CRI-aware). `ctr` works in containerd's `default` namespace, not the `k8s.io` namespace where kubelet's containers live.
- Looking for `crictl get` — there's no such verb. Use `ps`, `pods`, `images`.
- Trusting that pruning images is safe always. `crictl rmi --prune` removes anything not currently in use; if a pod is briefly down it might prune images you'd want kept.
