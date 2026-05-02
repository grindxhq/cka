## Two failure classes at the runtime level

When pods fail to start, two failure points can be invisible to kubectl:

1. **Image pull failures** — the runtime can't fetch the image.
2. **Sandbox creation failures** — the pause container or its CNI setup fails.

Both surface to kubectl as `ContainerCreating` or `ImagePullBackOff` with limited detail. Drilling into `crictl` and runtime logs reveals the root cause.

---

## Image pull failures

### Symptoms in kubectl

```bash
kubectl describe pod my-pod | grep -A 5 Events

# Warning  Failed   Failed to pull image "registry.io/foo:bar":
#                   rpc error: code = NotFound desc = ...manifest unknown
# Warning  Failed   Error: ErrImagePull
# Normal   BackOff  Back-off pulling image
```

The pull is happening at the **runtime** level. Kubelet calls `ImageService.PullImage` via CRI; the runtime pulls from the registry; failure surfaces back.

### Symptoms at the runtime level

```bash
# Watch what containerd is doing
sudo journalctl -u containerd --since '5 minutes ago' --no-pager | grep -i pull

# Recent image pull events
sudo crictl ps -a --name <pod-prefix> -o json | jq '.containers[].image'

# Direct pull test
sudo crictl pull <image>
# Tries to pull immediately. If fails, error message is usually informative.
```

`crictl pull` is the cleanest test — bypasses kubelet, isolates the registry / runtime / network issue.

### Common pull failures

#### Image does not exist

```
rpc error: code = NotFound desc = failed to pull and unpack image:
unexpected status from HEAD request: ... 404 Not Found
```

Wrong tag, wrong repository, or the image was deleted from the registry.

```bash
# Verify the image manifest exists
crane manifest <image>
# Or with curl
curl -I https://<registry>/v2/<repo>/manifests/<tag>
```

#### Authentication required

```
unauthorized: authentication required
```

Private registry. Need credentials.

For Kubernetes pods: `imagePullSecrets` on the pod or its SA (see pods-and-lifecycle → imagepullbackoff deck).

For node-level credentials (kubelet credential providers): configured per-node, often via a binary that fetches credentials from cloud IAM.

To test directly:

```bash
# Manually authenticate containerd's pull
sudo crictl pull --auth username:password <image>
```

#### TLS verification fails

```
x509: certificate signed by unknown authority
```

Registry is using a CA that the node doesn't trust. Add the CA to:

- containerd's CA bundle: `/etc/containerd/certs.d/<registry>/ca.crt`.
- Or the system CA bundle: `/usr/local/share/ca-certificates/...` + `update-ca-certificates`.

Then restart containerd.

For self-signed registries you don't want to trust globally, configure containerd:

```toml
# /etc/containerd/config.toml or /etc/containerd/certs.d/<registry>/hosts.toml
[host."https://<registry>"]
  capabilities = ["pull", "resolve"]
  skip_verify = true                # only for testing!
```

#### Network unreachable

```
dial tcp: lookup <registry>: no such host
```

DNS issue. Check from the node:

```bash
nslookup <registry>
ping <registry>
curl -v https://<registry>/v2/
```

If the registry is internal and the node can't reach it: firewall, routing, VPN.

#### Disk full

```
failed to copy: write /var/lib/containerd/...: no space left on device
```

Image filesystem is full. Free space:

```bash
df -h /var/lib/containerd
sudo crictl rmi --prune          # remove unused images
```

Or kubelet's image GC may have failed; check kubelet's `imageGCHighThresholdPercent` config.

#### Wrong architecture

```
no matching manifest for linux/arm64 in the manifest list
```

Multi-arch image doesn't have a build for the node's CPU architecture. Build a multi-arch image (`docker buildx build --platform linux/amd64,linux/arm64`) or use the right arch.

```bash
# Check node arch
uname -m
# x86_64 (amd64) or aarch64 (arm64)
```

---

## imagePullSecrets at the kubelet level

Kubelet collects `imagePullSecrets` from:

1. The pod's own `spec.imagePullSecrets`.
2. The pod's ServiceAccount's `imagePullSecrets`.

It then passes the credentials to CRI's `PullImage(image, auth)`. The runtime uses these for the pull.

If you configure auth at the **node level** (instead of using imagePullSecrets), it's via a kubelet credential provider:

```yaml
# /var/lib/kubelet/credential-provider-config.yaml
apiVersion: kubelet.config.k8s.io/v1
kind: CredentialProviderConfig
providers:
- name: ecr-credential-provider
  matchImages:
  - "*.dkr.ecr.*.amazonaws.com"
  defaultCacheDuration: "12h"
  apiVersion: credentialprovider.kubelet.k8s.io/v1
```

Kubelet runs the binary `ecr-credential-provider` to fetch credentials from cloud IAM. Common on EKS/GKE/AKS.

If the credential provider is misconfigured: pods fail to pull from those registries; kubelet logs show the provider error.

---

## Image GC

Kubelet runs a periodic image GC:

```yaml
# kubelet config
imageGCHighThresholdPercent: 85       # start GC when imagefs > 85% full
imageGCLowThresholdPercent: 80        # GC until back to 80%
imageMinimumGCAge: 2m                 # don't GC images younger than 2m
```

GC removes images that aren't currently referenced by any container (running or stopped, with retention).

If GC is broken (kubelet error, disk full beyond what GC can handle): manual cleanup:

```bash
sudo crictl rmi --prune
```

Removes all images not referenced by running containers.

---

## Sandbox creation failures

The other major class of "ContainerCreating forever" issue: sandbox creation fails.

### What sandbox creation involves

For each pod, kubelet calls `RunPodSandbox`:

1. Runtime creates a network namespace.
2. Runtime invokes the **CNI plugin** (e.g. Calico, Cilium) via the binary in `/opt/cni/bin/`.
3. CNI plugin assigns a pod IP, sets up veth pairs, programs iptables / eBPF.
4. Runtime starts the pause container in that namespace.
5. Sandbox is ready; sandbox ID returned.

Each step can fail.

### Symptoms

```bash
kubectl describe pod my-pod | grep -A 5 Events

# Warning  FailedCreatePodSandBox  Failed to create pod sandbox:
#                                   rpc error: code = Unknown desc =
#                                   failed to setup network for sandbox ...:
#                                   plugin type="calico" failed (add):
#                                   error getting ClusterInformation: ...
```

### Common causes

#### CNI plugin not installed

```
failed to find plugin "calico" in path [/opt/cni/bin]
```

The CNI binary is missing on this node. Either:

- Calico (or Cilium, Flannel, etc.) DaemonSet hasn't deployed to this node yet.
- The DS pod failed to copy its plugin binary.

Fix:

```bash
ls /opt/cni/bin/         # should include calico, cilium-cni, flannel, etc.

# Check the CNI DaemonSet
kubectl get pods -n kube-system -l k8s-app=calico-node -o wide
# Look for the pod on this node; if missing or NotReady, that's the issue.
```

Recover by ensuring the CNI DaemonSet runs successfully on every node.

#### CNI configuration missing

```
plugin type="calico" failed: stat /etc/cni/net.d/...: no such file
```

CNI config (`/etc/cni/net.d/*.conflist`) wasn't installed.

```bash
ls /etc/cni/net.d/
# Should have at least one .conflist or .conf file.
```

Same fix: ensure CNI agent successfully wrote config + binary.

#### IP exhaustion

```
plugin type="calico" failed: error getting next IP from IPAM:
no IPs available in IP pool
```

Pod CIDR is exhausted. Either:

- Pod CIDR is too small; expand.
- Stale IP allocations not garbage-collected.

For Calico:

```bash
sudo calicoctl ipam show --show-blocks
sudo calicoctl ipam release ...     # release stale allocations
```

For Flannel: typically auto-recovers when stale pods are cleaned up.

#### Network namespace creation fails

Rare; usually a kernel issue. Errors look like:

```
mount: operation not permitted
```

Check kernel modules: `modprobe br_netfilter`, `modprobe overlay`. Required kernel features must be enabled.

#### CNI agent unhealthy

```
plugin type="calico" failed: plugin status: not running
```

The CNI agent on this node is crashing.

```bash
kubectl logs -n kube-system <calico-node-pod>
# Look for the actual error.
```

Common: API auth issues (calico can't talk to apiserver), config issues, kernel incompatibilities.

---

## Inspecting sandbox state with crictl

```bash
# Existing sandboxes
sudo crictl pods

# Specific sandbox details
sudo crictl inspectp <pod-id> | jq '.info.runtimeSpec.linux.namespaces'
# Lists the namespaces (network, IPC, mount).

# What's the pod IP?
sudo crictl inspectp <pod-id> | jq '.info.network.podIP'
# null → CNI didn't assign an IP

# All sandboxes including failed ones
sudo crictl pods -a
```

If a sandbox is in `NotReady` state, the issue is between sandbox start and CNI completing. `crictl inspectp` shows where it's stuck.

---

## Pod stuck "ContainerCreating" — full triage

```
NAME      READY   STATUS              RESTARTS   AGE
my-pod    0/1     ContainerCreating   0          5m
```

5 minutes is too long. Where's it stuck?

```bash
# 1. Pod events — what does kubelet say?
kubectl describe pod my-pod | sed -n '/Events:/,$p'

# 2. Sandbox state on the target node
NODE=$(kubectl get pod my-pod -o jsonpath='{.spec.nodeName}')
ssh $NODE 'sudo crictl pods --name my-pod'

# 3. Has the sandbox been created?
# YES → check container creation:
ssh $NODE 'sudo crictl ps -a --pod <pod-id>'
# Containers in CREATED / EXITED state? Check logs.

# NO  → sandbox creation failed:
# Check CNI:
ssh $NODE 'ls /etc/cni/net.d/'
ssh $NODE 'ls /opt/cni/bin/'
ssh $NODE 'kubectl logs -n kube-system <cni-pod-on-this-node>'

# 4. Image pulled?
ssh $NODE 'sudo crictl images | grep <image>'
# Missing? Try manual pull:
ssh $NODE 'sudo crictl pull <image>'

# 5. Volume mount issues?
ssh $NODE 'sudo journalctl -u kubelet --since "5 min ago" | grep my-pod'
# Look for "MountVolume" errors.

# 6. Resource constraints?
ssh $NODE 'kubectl describe node $NODE | grep -A 5 Allocated'
# Node out of CPU/memory/PIDs?
```

Walk through these. The answer usually shows up at one specific step.

---

## ImageInspect — does the image exist locally?

```bash
sudo crictl inspecti <image-id>
# Or by tag
sudo crictl inspecti registry.k8s.io/pause:3.9
```

Returns the image's full metadata: layers, config, labels, etc. If the image isn't present, the inspect fails.

Useful for verifying that an image was pulled successfully without trying to start a container.

---

## Sandbox debug from inside

If a sandbox is created but containers in it fail:

```bash
# Get the pause container's PID
SANDBOX_ID=$(sudo crictl pods --name my-pod -q)
PAUSE_PID=$(sudo crictl inspectp $SANDBOX_ID | jq '.info.pid')

# Enter its network namespace
sudo nsenter -t $PAUSE_PID -n bash

# inside:
ip addr                              # see the pod's interfaces
ip route                              # routing table
nslookup kubernetes.default           # DNS works?
```

This gives you a shell with the pod's network. Useful for debugging "the network is broken from this pod's perspective."

---

## kubelet's image-related logs

```bash
sudo journalctl -u kubelet --since '10 minutes ago' --no-pager | grep -iE 'image|pull'
```

Common lines:

```
"Pulling image" image="..."
"Successfully pulled image" image="..." duration="..."
"Failed to pull image" image="..." error="..."
"Container image garbage collection succeeded" ...
"GarbageCollect: Removing image" image="..."
```

Image GC events here too.

---

## Restart-loop at sandbox level

Sometimes a pod's sandbox keeps recreating because:

- Pod has `restartPolicy: Always` and the main container exits with non-zero.
- kubelet kills the pod (probe failure) and recreates → new sandbox.
- CNI is flaking, briefly succeeds then fails.

Distinguishing these:

```bash
# For a specific pod, all historical sandboxes:
sudo crictl pods -a --name <pod-prefix>

# Many sandbox IDs for the same pod = sandbox is being recreated repeatedly.
# Look at journalctl -u kubelet for 'PodSandbox' events.
```

If sandboxes are churning, the pod itself isn't the issue — the runtime / CNI is. Investigate the CNI agent.

---

## Specific exam-relevant patterns

### "ImagePullBackOff" with private registry

Add `imagePullSecrets`. Verify with `crictl pull --auth ...`. Walked in pods-and-lifecycle deck.

### "FailedCreatePodSandBox: cni"

Check `/etc/cni/net.d/` exists, plugin binary in `/opt/cni/bin/`, CNI DaemonSet is healthy.

### "ContainerCreating forever, no events after first minute"

Usually an attached volume (PVC) issue. Check `kubectl get volumeattachment` and the CSI node plugin pod on the target node.

---

## Cleanup commands

```bash
# Remove all unused images
sudo crictl rmi --prune

# Remove a specific image
sudo crictl rmi <image-id-or-tag>

# Remove a stopped container
sudo crictl rm <container-id>

# Remove a stopped sandbox (also removes its containers)
sudo crictl rmp <sandbox-id>
```

For cleaning a node post-incident:

```bash
# Stop all pods on the node (drains)
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data

# After drain, all should be in completed/exited state. Prune:
sudo crictl rmi --prune

# Re-uncordon
kubectl uncordon <node>
```

---

## Exam heuristics

- For "image won't pull," try `sudo crictl pull <image>` to test directly.
- For "ContainerCreating," `kubectl describe pod` events first; if "FailedCreatePodSandBox" → CNI; if image-related → registry / network / auth.
- `sudo crictl pods --name <prefix>` and `sudo crictl ps -a --name <prefix>` for runtime-level state.
- `sudo crictl rmi --prune` to free image filesystem.
- For multi-CNI environments, know which one is in play (`ls /opt/cni/bin/`).

## Mental traps

- Blaming kubelet for image pull failures — kubelet just calls CRI; the actual pull is in containerd. Logs are in containerd's journal too.
- Assuming the pod IP comes from kubelet — it comes from the CNI plugin during sandbox creation. CNI failures = no IP.
- Trying to manually mount a CSI volume to "speed things up." Don't; kubelet's mount logic handles it.
- Forgetting that `crictl rmi` only removes from the local cache. Other nodes still have the image (if they pulled it).
- Pulling images via Docker on a kubeadm node and being surprised they aren't visible to kubelet. Different runtimes, different namespaces.
- Setting up imagePullSecrets but forgetting to attach them to the pod or its SA. Kubelet won't see them.
- Running `crictl pods` and only seeing `default` namespace ones. Add `-a` for all states.
