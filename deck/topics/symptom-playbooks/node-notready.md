## What "NotReady" really means

```
$ kubectl get nodes
NAME       STATUS     ROLES   AGE     VERSION
worker-1   Ready      <none>  30d     v1.30.3
worker-2   NotReady   <none>  30d     v1.30.3   ← problem
worker-3   Ready      <none>  30d     v1.30.3
```

Two distinct ways a node ends up NotReady:

- **`Ready=False`** — kubelet is alive and reporting "I'm not healthy" with a specific reason.
- **`Ready=Unknown`** — kubelet hasn't heartbeated within the deadline; node controller marks it Unknown.

These look identical in `kubectl get nodes`, but they have completely different causes and fixes.

---

## Distinguishing the two

```bash
kubectl get node worker-2 -o jsonpath='{range .status.conditions[*]}{.type}={.status} reason={.reason}{"\n"}{end}'

# Ready=False reason=KubeletNotReady          ← kubelet is alive, declaring unhealthy
# Ready=Unknown reason=NodeStatusUnknown       ← kubelet has gone silent
```

| Condition value | Meaning | Where to look |
|----------------|---------|---------------|
| `Ready=False, reason=KubeletNotReady` | Kubelet is running, knows something is wrong | `journalctl -u kubelet` on the node |
| `Ready=Unknown, reason=NodeStatusUnknown` | Kubelet hasn't heartbeated for >40s | Is the node alive? Is kubelet running? |
| `Ready=False, reason=KubeletReady` | Doesn't usually happen | Edge case |
| `Ready=True` (despite NotReady display) | Other condition is failing | Check NetworkUnavailable / DiskPressure |

Also check secondary conditions:

```bash
kubectl describe node worker-2 | grep -A 15 Conditions
```

You'll see:

```
Conditions:
  Type                 Status  Reason                       Message
  ----                 ------  ------                       -------
  MemoryPressure       False   KubeletHasSufficientMemory   ...
  DiskPressure         False   KubeletHasNoDiskPressure     ...
  PIDPressure          False   KubeletHasSufficientPID      ...
  Ready                False   KubeletNotReady              container runtime is down
```

Reading these tells you exactly what kubelet thinks is wrong.

---

## Decision tree

```
Node is NotReady
│
├── Ready=Unknown (kubelet silent)
│   ├── Can you SSH? Is kubelet alive?
│   │   ├── No SSH → host issue (powered off, network, kernel panic)
│   │   └── SSH OK → next
│   │
│   ├── systemctl status kubelet
│   │   ├── inactive → start kubelet
│   │   └── failed → look at journal for crash reason
│   │
│   └── kubelet running but not heartbeating?
│       ├── Apiserver unreachable → fix network/DNS to apiserver
│       ├── Cert expired → renew kubelet client cert
│       └── Lease cannot update → check RBAC / clock skew
│
└── Ready=False (kubelet actively reports problem)
    │
    ├── Conditions show DiskPressure / MemoryPressure / PIDPressure?
    │   → kubelet is evicting per resource pressure; resolve the pressure
    │
    ├── Conditions show NetworkUnavailable?
    │   → CNI plugin not initialized; install/fix CNI
    │
    └── Other reason → look at kubelet journal for the specifics
```

---

## Step 1: Quick read on the API side

```bash
# All conditions, with reasons and messages
kubectl describe node worker-2 | sed -n '/Conditions:/,/Addresses:/p'

# Recent events on the node
kubectl get events --field-selector involvedObject.kind=Node,involvedObject.name=worker-2 --sort-by=.lastTimestamp

# Heartbeat — when did kubelet last update the Lease?
kubectl get lease -n kube-node-lease worker-2 -o jsonpath='{.spec.renewTime}'
# 2026-04-23T15:30:00.000000Z   ← compare to now()
```

Recent renewTime → kubelet was alive recently. Old renewTime → kubelet has been silent for a while.

---

## Step 2: SSH to the node

If at all possible, SSH in. Most diagnostics are node-local.

```bash
ssh worker-2
```

If SSH fails:

- VM is powered off (cloud console / console will show).
- Network broke.
- Kernel panic (less common in cloud, more on bare metal).

For unreachable nodes, you may need to:

- Restart from cloud console.
- Replace the VM and let workloads reschedule.

---

## Step 3: Is kubelet alive?

```bash
sudo systemctl status kubelet
```

Outcomes:

### Active (running)

Kubelet is running. Check its journal for what it's complaining about:

```bash
sudo journalctl -u kubelet --since '10 min ago' --no-pager | tail -100
```

Common issues to grep for:

- `runtime is down` → containerd / cri-o issue.
- `network plugin is not ready` → CNI issue.
- `Failed to update node status` → can't reach apiserver.
- `Unable to authenticate the request due to an error: x509` → cert issue.
- `Node is now ready` → healthy.

### Inactive (dead) / failed

Kubelet stopped. Restart:

```bash
sudo systemctl start kubelet
sudo systemctl status kubelet
```

If it crashes immediately, journal shows why:

```bash
sudo journalctl -u kubelet --no-pager | tail -50
```

Common failures:

- Cgroup driver mismatch (`failed to load cgroup root: ...`)
- Bad config in `/var/lib/kubelet/config.yaml` (parse error)
- Missing CRI socket (containerd not running)

---

## Step 4: Container runtime check

Even if kubelet starts, it depends on the container runtime:

```bash
sudo systemctl status containerd        # or crio
sudo crictl info | jq '.status.runtimeReady, .status.networkReady'
```

If containerd is down:

```bash
sudo systemctl start containerd
sudo systemctl status containerd

# Logs if it crashes
sudo journalctl -u containerd --since '5 min ago' | tail
```

Restart order: containerd first, then kubelet. Kubelet won't be Ready until containerd is up.

---

## Step 5: CNI check

```bash
ls /etc/cni/net.d/
# Expect at least one .conflist or .conf file

ls /opt/cni/bin/
# Expect plugin binaries: bridge, host-local, calico, cilium, etc.

# Is the CNI agent pod on this node running?
kubectl get pods -n kube-system -l k8s-app=calico-node -o wide --field-selector spec.nodeName=worker-2
# (or cilium-agent, kube-flannel, antrea-agent — depends on your CNI)
```

If `/etc/cni/net.d/` is empty: CNI agent never wrote its config (probably crashing).

If the CNI pod is missing on this node: it never got scheduled (likely DS tolerations or node selector issue).

If CNI pod exists but is CrashLoopBackOff:

```bash
kubectl logs -n kube-system <cni-pod>
# What's the agent complaining about?
```

Common: API connectivity, IAM/credentials issue (cloud CNI), kernel feature missing.

Fix CNI → kubelet eventually marks node Ready (within ~30s).

---

## Step 6: Disk / memory / PID pressure

If `kubectl describe node` shows `DiskPressure=True`, `MemoryPressure=True`, or `PIDPressure=True`:

```bash
df -h /
df -h /var/lib/containerd
df -h /var/lib/kubelet
free -m
ps aux | wc -l
```

Cleanup:

```bash
# Image cache (often the biggest)
sudo crictl rmi --prune

# Old container logs
sudo journalctl --vacuum-time=2d

# Find space hogs
du -sh /var/lib/* 2>/dev/null | sort -h | tail
```

Once you've freed enough space (over the eviction threshold + minimum reclaim), kubelet recovers and node returns to Ready.

For memory pressure:

- Check if there are runaway pods (oversized memory).
- `kubectl top pods -A --sort-by=memory` (needs metrics-server) or per-node `top`.
- Evict / scale-down problematic workloads.

For PID pressure:

- Excessive thread/process count. Container running thousands of threads usually.
- `ps -eLf | wc -l` (LWPs / threads).

---

## Step 7: Cert / auth issues

If the journal shows:

```
x509: certificate has expired or is not yet valid
```

Kubelet's client cert (used to authenticate to apiserver) has expired.

If `rotateCertificates: true` in kubelet config, it should auto-rotate via CSR. Auto-rotation broken implies:

- CSR auto-approval CRBs deleted (rare, but happens after cluster repairs).
- Kubelet can't reach apiserver to submit CSR (chicken-and-egg).

Manual fix: regenerate kubelet's kubeconfig + cert by `kubeadm join`-ing the node fresh, or:

```bash
# Check current state
ls -la /var/lib/kubelet/pki/

# Approve any pending CSRs
kubectl get csr | grep Pending
kubectl certificate approve <csr-name>
```

For "rotation just stopped working":

```bash
# CRBs that enable rotation
kubectl get clusterrolebinding | grep certificate
# Should see:
#   kubeadm:node-autoapprove-certificate-rotation
#   system:certificates.k8s.io:certificatesigningrequests:nodeclient
```

If missing, recreate via `kubeadm init phase bootstrap-token`.

---

## Step 8: Clock skew

A surprisingly common cause of cert / lease issues:

```bash
timedatectl status
date
```

If the node's time is wildly off (more than a few seconds different from apiserver's), TLS validation can fail (cert "not yet valid" / "expired"), and lease updates may be rejected.

Fix:

```bash
sudo systemctl restart systemd-timesyncd
# Or chrony: sudo systemctl restart chronyd

# Force resync
sudo timedatectl set-ntp true
```

For larger clusters, monitor clock skew across nodes; alert when >1 second.

---

## Step 9: kubelet config / kubelet.conf

If kubelet starts but immediately can't connect:

```bash
# Is the kubeconfig valid?
sudo cat /etc/kubernetes/kubelet.conf | head -20
# Look for:
#   server: https://lb.example.com:6443       — reachable?
#   client-certificate path or data           — present?

# Test connectivity from this node to apiserver
nc -zv lb.example.com 6443
```

If apiserver is unreachable from this node (network issue, firewall, broken VPN):

- Kubelet can't post status, eventually marked NotReady.
- All workloads on this node are isolated.

Fix the network. After connectivity returns, kubelet eventually re-syncs and node goes Ready.

---

## Step 10: Static pods on CP nodes

If the NotReady node is a control plane node:

- Kubelet might be down because the apiserver is also down — but those are independent, so kubelet should still report what it can.
- A broken static pod (apiserver itself) doesn't make kubelet NotReady directly.
- But if kubelet can't reach the apiserver locally (because apiserver is down), it can't post status.

For CP nodes: fix the apiserver first (see api-unavailable subtopic), then kubelet's status flows back.

---

## Step 11: When the node was healthy, then suddenly NotReady

Something changed. Investigate recent events:

```bash
# Recent kubelet activity
sudo journalctl -u kubelet --since '30 min ago' | tail -200

# Recent system events
sudo dmesg --since '30 min ago' | tail

# Recent OS-level things
sudo journalctl --since '30 min ago' --priority=err
```

Common patterns:

- Kernel OOM killer killed kubelet process (look for `Out of memory: Killed process`).
- Disk filled up faster than expected (large logs, runaway pods).
- Network interface flapped (cloud sometimes detaches/reattaches).
- A recent OS update changed something (e.g. cgroup driver, kernel modules).

---

## Diagnostic commands cheatsheet

```bash
# API side (from your kubectl):
kubectl get nodes
kubectl describe node worker-2
kubectl get events --field-selector involvedObject.name=worker-2
kubectl get lease -n kube-node-lease worker-2

# On the node:
sudo systemctl status kubelet
sudo journalctl -u kubelet --since '10 min ago' | tail -100
sudo systemctl status containerd
sudo crictl info | jq '.status'
ls /etc/cni/net.d/
ls /opt/cni/bin/
df -h
free -m
timedatectl status
sudo journalctl --since '30 min ago' --priority=err
```

---

## Recovery playbooks

### Playbook 1: kubelet stopped

```bash
ssh worker-2
sudo systemctl start kubelet
sudo systemctl status kubelet
sudo journalctl -u kubelet --since '5 min ago' | tail -30

# Most likely fixes:
# - Wait for it to come up (usually < 30s after start)
# - Fix /var/lib/kubelet/config.yaml syntax errors
# - Fix /etc/systemd/system/kubelet.service.d/10-kubeadm.conf
```

### Playbook 2: Disk pressure

```bash
ssh worker-2
sudo crictl rmi --prune
sudo journalctl --vacuum-time=1d
df -h /

# After freeing space, wait for kubelet to clear DiskPressure condition (~30s).
```

### Playbook 3: Container runtime died

```bash
ssh worker-2
sudo systemctl status containerd

# If failed:
sudo journalctl -u containerd | tail -20
sudo systemctl restart containerd
sudo systemctl restart kubelet
```

### Playbook 4: CNI not ready

```bash
# On the node:
ls /etc/cni/net.d/        # empty?
ls /opt/cni/bin/           # missing plugins?

# From kubectl: is the CNI DS pod healthy?
kubectl get pods -n kube-system -l k8s-app=calico-node \
  --field-selector spec.nodeName=worker-2

# Inspect the CNI pod's logs for the actual error.
kubectl logs -n kube-system <cni-pod>
```

If CNI DS isn't on this node at all: check tolerations / node selectors on the DS spec.

### Playbook 5: Node is permanently dead

VM gone, hardware failure, can't recover the node:

```bash
# Drain (force, since the node's NotReady)
kubectl drain worker-2 --ignore-daemonsets --delete-emptydir-data --force

# Delete the Node object
kubectl delete node worker-2

# Workloads reschedule elsewhere
```

For HA workloads (Deployment-managed pods), no service interruption.

---

## Mass NotReady (multiple nodes simultaneously)

If many nodes go NotReady at once: something cluster-wide changed.

Possibilities:

- **Apiserver outage** — kubelets can't update status; eventually marked Unknown.
- **CNI outage** — networking broken cluster-wide.
- **Cluster CA rotated** without updating kubelets.
- **Network partition** — control plane unreachable from workers.

Investigate the **control plane** first. If apiserver is healthy and reachable from workers, drill into the workers' specific issues (likely CNI or cert).

---

## Exam heuristics

- Always run `kubectl describe node <name>` first — Conditions section names the problem.
- For "kubelet not running," `sudo systemctl status kubelet`.
- For "container runtime down," `sudo systemctl status containerd`.
- For "CNI broken," check `/etc/cni/net.d/` and the CNI DS pod.
- After fixing, give kubelet ~30 seconds to flip back to Ready.

## Mental traps

- Looking at `Ready=False` and not reading the reason. The reason names the cause.
- Restarting kubelet without checking that containerd is actually up first.
- Trying to `kubectl drain` a node that's already NotReady to "fix" it. Drain doesn't help; investigate why kubelet's broken.
- Force-deleting `/var/lib/kubelet/` to reset things. You'll lose all per-pod state and have to rejoin.
- Treating Ready=Unknown as "kubelet is unhealthy." It means "kubelet is silent" — could be totally healthy but unable to reach apiserver.
- Editing kubelet config and forgetting to `systemctl daemon-reload` (only needed if the systemd unit changed) and `systemctl restart kubelet`.
- Believing `kubectl uncordon` will make a NotReady node Ready. Cordon affects scheduling; readiness is a separate signal.
