## What kubelet actually is

kubelet is the **node-level agent** that turns Pod specs into running containers. Every worker and control plane node runs exactly one kubelet. Its responsibilities:

- Watch for pods assigned to this node (by `.spec.nodeName`).
- Pull images, create sandboxes, start containers via the CRI.
- Publish Pod status back to the API.
- Run **static pods** from a local manifest directory.
- Register the Node object and heartbeat Ready status.
- Execute probes, eviction, and lifecycle hooks.
- Report resource usage via cAdvisor built into kubelet.

If kubelet is broken, the node stops being useful — no new pods start, no existing pods get their status updated, no heartbeat makes it to the API server.

## Where kubelet sits in the system

```
        kube-apiserver
             ▲
             │  (watch pods, post node status, post events)
             │
      ┌────────────┐
      │  kubelet   │
      └────────────┘
       │    │    │
   CRI │    │    │ CNI (network plugin)
       │    │    │
       ▼    │    ▼
 container  │   pod networking
 runtime    │
 (containerd│
  / cri-o)  │
            ▼
       CSI (storage drivers)
```

kubelet coordinates three things:

- **Container runtime** via CRI (Container Runtime Interface) — usually `containerd` on modern clusters.
- **Networking** via CNI plugins (Calico, Cilium, Flannel, etc.).
- **Storage** via CSI (Container Storage Interface) drivers.

## The pod lifecycle from kubelet's angle

1. **Pod assigned** — apiserver sends an update with `.spec.nodeName == <this-node>`.
2. **Sandbox** — kubelet asks the runtime to create a pod sandbox (a "pause" container + network namespace).
3. **CNI** — kubelet invokes the CNI plugin to give the sandbox a pod IP.
4. **Volumes** — kubelet mounts each volume (host path, projected token, CSI volume).
5. **Containers** — kubelet pulls images, creates and starts init containers in order, then regular containers.
6. **Probes** — startup → readiness → liveness run on the running containers.
7. **Status** — kubelet keeps patching `status.conditions`, `status.containerStatuses`, and the pod phase.
8. **Termination** — on delete, kubelet sends SIGTERM, waits `terminationGracePeriodSeconds`, then SIGKILL.

Every step can fail, producing a distinct symptom (ImagePullBackOff, ContainerCreating, CrashLoopBackOff, Error, etc.). Knowing which step owns which symptom is the fastest way to diagnose.

## What kubelet does **not** do

- Decide which node a pod goes to (scheduler does that).
- Create pod **objects** (users / controllers do that via the API).
- Restart a node or cluster.
- Enforce RBAC (apiserver does that before kubelet sees anything).
- Handle Services directly (kube-proxy does that at the node level).

## Things kubelet reads

- **Pod specs** from the apiserver, filtered by `.spec.nodeName`.
- **Static pod manifests** from `staticPodPath` (default `/etc/kubernetes/manifests/`).
- **Kubelet config** (`/var/lib/kubelet/config.yaml` on kubeadm).
- **Kubeconfig** for talking to the API (`/etc/kubernetes/kubelet.conf`).
- **CNI config** from `/etc/cni/net.d/`.

## Things kubelet writes

- **Node object** updates (condition status, allocatable, addresses, labels via `--node-labels`).
- **Lease** objects in `kube-node-lease` (heartbeat).
- **Pod status** updates for every pod on this node.
- **Events** (`FailedMount`, `Killing`, `Pulling`, etc.).
- **Mirror pods** for static pods.

## Where kubelet runs

Usually as a **systemd service**, not as a container. On kubeadm:

```bash
systemctl status kubelet
journalctl -u kubelet
```

Configuration cascade (each overrides the one above):

1. `/var/lib/kubelet/config.yaml` — the canonical kubelet config (most settings here).
2. `/etc/systemd/system/kubelet.service.d/10-kubeadm.conf` — systemd drop-in with flags and `--config`.
3. `/etc/default/kubelet` (or `/etc/sysconfig/kubelet`) — distro-level env file.

Changing config:

```bash
sudo vi /var/lib/kubelet/config.yaml
sudo systemctl restart kubelet
```

## Quick signals when something is wrong

```bash
# Is kubelet alive?
systemctl status kubelet
systemctl is-active kubelet

# What is it saying?
journalctl -u kubelet --no-pager | tail -n 100

# Does it think it has work?
crictl ps -a           # CRI-level state (images, containers, sandboxes)

# Does it report to apiserver?
kubectl get nodes
kubectl describe node <node>
```

If `kubectl get nodes` shows the node as `NotReady` but `crictl ps` looks sane, kubelet itself may be running but failing to publish status — usually a kubeconfig, cert, or clock issue.

## Kubelet's authentication to apiserver

kubelet uses:

- **Client cert** for its own identity: `/etc/kubernetes/pki/kubelet-client-current.pem` (or similar).
- **Kubeconfig**: `/etc/kubernetes/kubelet.conf`.
- Rotation: kubelet can request new certs from the apiserver via the CSR API (`--rotate-certificates`). Kubeadm sets this up.

If kubelet's cert expires:

```bash
kubeadm certs check-expiration
# if expired for kubelet-client:
sudo kubeadm certs renew ...          # renews cluster certs that kubeadm owns
# then restart kubelet
sudo systemctl restart kubelet
```

On cert rotation-enabled clusters, kubelet renews its own client cert automatically via CSR. That's a CKS-adjacent topic; for CKA, knowing where the cert lives is usually enough.

## Mental model shortcuts

- kubelet is a **single-node controller**. It reconciles the local world against what apiserver says.
- Every pod ever runs because a kubelet ran it. Every pod ever fails because a kubelet (or its runtime / CNI / CSI) had a problem.
- If kubelet is **running but failing**, read its journal. Kubelet is very verbose about failures.
- If kubelet is **not running**, the node is useless. Fix kubelet first; everything else follows.

## Exam heuristics

- "Node is NotReady" is almost always a kubelet, runtime, or CNI problem. Use journalctl first.
- If you are asked to change kubelet behavior (logging verbosity, pod CIDR, cluster DNS), edit `/var/lib/kubelet/config.yaml` and restart the service.
- If you are asked to join a new node, `kubeadm join` configures and starts kubelet for you. If the join is failing, read the kubeadm and kubelet journals — they are adjacent.

## Mental traps

- Assuming `kubectl describe pod` is the full picture of a pod failure. kubelet's journal often tells you the actual cause (image pull error with more detail, volume mount failure root cause).
- Confusing kubelet errors with apiserver errors. An `Unauthorized` in kubelet's journal is a cert/kubeconfig issue; in apiserver's log, it is an incoming request issue.
- Thinking the Node object is the source of truth. The node's **real** state lives in kubelet + the runtime. The Node object is an API reflection.
- Treating kubelet as stateless. It caches quite a lot in `/var/lib/kubelet/` — pod sandboxes, volume mounts, config caches. A `rm -rf /var/lib/kubelet/` on a live node loses all of that.
