## What "NotReady" actually means

The `Ready` condition on a Node is **kubelet's own** declaration: "I can run pods right now." When kubelet's internal checks fail, it reports `Ready=False`. When kubelet goes silent for longer than the node controller tolerates, the node controller flips `Ready=Unknown` — a different failure mode but the same `NotReady` label in `kubectl get nodes`.

Understanding which of the two is happening is the first branch in triage.

## Ready=False vs Ready=Unknown

```bash
kubectl get node <n> -o jsonpath='{range .status.conditions[*]}{.type}={.status} reason={.reason}{"\n"}{end}'
```

- `Ready=False, reason=KubeletNotReady` → kubelet is alive and actively reporting a problem.
- `Ready=Unknown, reason=NodeStatusUnknown` → kubelet has stopped heartbeating; node controller flipped it.

The first is a kubelet-internal failure (runtime, disk, network plugin). The second is kubelet not reachable at all (kubelet down, network, cert). Completely different fixes.

## The triage decision tree

```
kubectl get nodes  shows NotReady
│
├── Conditions: Ready=Unknown, reason=NodeStatusUnknown
│     → kubelet heartbeat stopped
│         - SSH to the node
│         - systemctl status kubelet
│         - journalctl -u kubelet | tail -n 100
│         - check clock skew (ntp)
│         - check /etc/kubernetes/kubelet.conf (apiserver URL, cert)
│
├── Conditions: Ready=False, reason=KubeletNotReady
│     → kubelet is alive but something downstream is broken
│         - read the message field of the Ready condition for the exact reason
│         - usually points to container runtime or network
│
├── Conditions: DiskPressure=True
│     → node filesystem near limits
│         - df -h / /var/lib/containerd /var/lib/kubelet
│         - kubelet will evict pods under pressure
│
├── Conditions: MemoryPressure=True
│     → free -m; heavy pod consumer; check eviction events
│
├── Conditions: PIDPressure=True
│     → too many processes / threads on the node
│
└── Conditions: NetworkUnavailable=True
      → CNI plugin not configured or broken
        - /etc/cni/net.d/ non-empty?
        - CNI pod (calico/flannel/etc.) running?
```

Most CKA NotReady scenarios land in one of:

1. kubelet service not running → start it.
2. Container runtime not running → start it, then kubelet.
3. CNI not installed → install it or fix its pod.
4. Certs expired → renew.
5. Disk full → clean up.

## Starting from the API side

Before SSHing, get as much as you can from the API:

```bash
kubectl describe node <node> | sed -n '/Conditions:/,/Addresses:/p'
kubectl describe node <node> | sed -n '/Events:/,/Allocatable:/p'
kubectl get events --sort-by=.lastTimestamp | grep <node>
kubectl get pods -A -o wide --field-selector spec.nodeName=<node>
```

The `Conditions` block names the failing component; the `Events` block often pinpoints the reason (e.g. `Failed to start cni network`, `runtime error: container init: ...`).

## On-node checks (in order)

```bash
# 1. Is kubelet running?
systemctl is-active kubelet
systemctl status kubelet

# 2. What is it saying?
sudo journalctl -u kubelet --no-pager | tail -n 100

# 3. Is the container runtime alive?
systemctl is-active containerd           # or cri-o, docker
sudo crictl info | jq '.status.runtimeReady, .status.networkReady'

# 4. CNI config present?
ls /etc/cni/net.d/

# 5. Disk?
df -h /
df -h /var/lib/containerd
df -h /var/lib/kubelet

# 6. Time skew?
timedatectl status
```

If `runtimeReady=false`, fix the container runtime before anything else. If `networkReady=false`, fix CNI. kubelet depends on both.

## Common patterns and fixes

### kubelet service is dead

```bash
sudo systemctl status kubelet
sudo journalctl -u kubelet --no-pager | tail -n 50

# Typical fixes
sudo systemctl daemon-reload
sudo systemctl restart kubelet
```

If the journal shows `failed to parse /var/lib/kubelet/config.yaml`, you have an invalid config — fix the YAML or revert.

### Container runtime dead

```bash
sudo systemctl status containerd
sudo journalctl -u containerd --no-pager | tail -n 50
sudo systemctl restart containerd
sudo systemctl restart kubelet
```

kubelet won't be Ready until the runtime is Ready.

### CNI missing

Symptoms: `NetworkPluginNotReady`, `cni config uninitialized`, pods stuck `ContainerCreating` with network errors.

On kubeadm, the usual CNIs (Calico, Flannel, Cilium, Weave) are installed as DaemonSets. Check:

```bash
kubectl get pods -n kube-system -l k8s-app=calico-node      # or similar
```

If missing, apply the CNI manifest:

```bash
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.27.0/manifests/calico.yaml
```

(Exact URL / version depends on the exam environment — usually provided in the task description.)

### Kubelet certs expired

Journal shows `x509: certificate has expired or is not yet valid`.

```bash
sudo kubeadm certs check-expiration
sudo kubeadm certs renew all                # on the control plane node
```

For kubelet client cert specifically (on a worker), there is no simple `kubeadm renew` path for the worker kubelet. Options:

- If rotation is enabled (`serverTLSBootstrap: true` + `rotateCertificates: true` in kubelet config), kubelet requests a new cert via CSR. Approve pending CSRs:
  ```bash
  kubectl get csr
  kubectl certificate approve <csr-name>
  ```
- If not enabled, regenerate via `kubeadm join --token ...` with a fresh token.

### Disk pressure

```bash
df -h /
df -h /var/lib/containerd
df -h /var/lib/kubelet
```

Reclaim space:

```bash
sudo crictl rmi --prune              # remove unused images
sudo journalctl --vacuum-time=2d     # trim logs
```

Eviction thresholds (defaults) are in kubelet config (`evictionHard`). If you're near them, clean up or raise them temporarily.

### Time skew

```bash
timedatectl status
sudo systemctl restart systemd-timesyncd    # or chronyd, ntpd
```

Large skew breaks TLS (certs look "not yet valid" or "expired") and etcd Raft.

## Cordon / drain vs NotReady

- `kubectl cordon <n>` sets `.spec.unschedulable=true`. Node stays Ready, but scheduler avoids it. Status shows `Ready,SchedulingDisabled`.
- `kubectl drain <n>` cordons + evicts non-DS pods.
- `NotReady` is different: it's a health signal, not a cordon. The `unschedulable` flag is independent.

A node can be `Ready,SchedulingDisabled` (healthy but cordoned) or `NotReady` (actually broken) or both.

## Fast fixes summary

| Symptom                                 | First fix                                    |
|-----------------------------------------|----------------------------------------------|
| `Ready=Unknown`                         | Restart kubelet on the node                  |
| `KubeletNotReady` + runtime not ready   | Restart containerd, then kubelet             |
| `NetworkPluginNotReady`                 | Install or fix CNI DaemonSet                 |
| `DiskPressure=True`                     | Clean up images / logs                       |
| Cert errors in journal                  | Renew certs, restart kubelet                 |
| Clock skew in journal                   | Fix NTP                                       |
| `SchedulingDisabled` only                | `kubectl uncordon <node>`                    |

## Exam heuristics

- Always start with `kubectl describe node <n>` — the condition messages are precise.
- If you can't SSH, you can still `kubectl debug node/<n>` (creates a debugging pod with host access), but on CKA you usually have SSH.
- The runtime → kubelet → apiserver chain is one-way causality. Restart in that order: runtime first, kubelet second.

## Mental traps

- Thinking Ready=Unknown is "the same as" Ready=False. Different root cause class.
- Restarting kubelet when the container runtime is the actual problem. kubelet will keep failing.
- Forgetting that a cordoned node is still Ready. "SchedulingDisabled" is not a failure state.
- Expecting `kubectl delete pod` to "reset" a node. It deletes pods, not kubelet state.
- Blaming apiserver certs for kubelet-side cert errors. kubelet has its own `/etc/kubernetes/kubelet.conf` cert chain.
