## Why HA needs a subtopic of its own

A single-apiserver cluster is fine until it isn't — and when the CP host reboots or the kubelet goes sideways on that one node, the entire cluster becomes read-only. HA fixes this by running multiple apiservers behind a load balancer and having controllers, scheduler, and etcd coordinate via leader election.

The shape looks simple but the details — which component needs quorum, what the LB health-checks, which identities must be shared — are where clusters break. This note covers the full shape.

---

## The two topologies

Kubeadm supports two:

### Stacked etcd (default)

Every control plane node runs its own etcd member co-located with its apiserver:

```
  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
  │  CP1         │    │  CP2         │    │  CP3         │
  │  apiserver   │◄───┤  apiserver   │    │  apiserver   │
  │  scheduler   │    │  scheduler   │    │  scheduler   │
  │  controller- │    │  controller- │    │  controller- │
  │   manager    │    │   manager    │    │   manager    │
  │  kubelet     │    │  kubelet     │    │  kubelet     │
  │  etcd (local)│◄──►│  etcd (local)│◄──►│  etcd (local)│
  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘
         │                   │                   │
         └──────────┬────────┴───────────────────┘
                    │
             ┌──────┴──────┐
             │ Load Balancer│ ← clients connect here
             └─────────────┘
```

Pros: fewer machines (3), simpler to manage.
Con: losing one node costs you one apiserver **and** one etcd member simultaneously.

### External etcd

etcd runs on separate machines:

```
  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
  │  CP1         │    │  CP2         │    │  CP3         │
  │  apiserver   │    │  apiserver   │    │  apiserver   │
  │  scheduler   │    │  scheduler   │    │  scheduler   │
  │  controller- │    │  controller- │    │  controller- │
  │   manager    │    │   manager    │    │   manager    │
  │  kubelet     │    │  kubelet     │    │  kubelet     │
  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘
         │                   │                   │
  ┌──────┴──────┐    ┌──────┴──────┐    ┌──────┴──────┐
  │  etcd-1     │    │  etcd-2     │    │  etcd-3     │
  │  (dedicated)│◄──►│  (dedicated)│◄──►│  (dedicated)│
  └─────────────┘    └─────────────┘    └─────────────┘
                      [Load Balancer]
```

Pros: etcd can be sized/upgraded/backed-up independently; CP failures don't impact etcd quorum.
Con: 6 machines minimum; extra operational surface.

CKA nearly always assumes **stacked**. Recognise external exists and that the `kube-apiserver` manifest's `--etcd-servers` flag then points at the external etcd IPs, not `127.0.0.1`.

---

## Why node counts are always odd

Raft needs a strict majority (quorum) to elect a leader or commit a write. Majority of N = `floor(N/2)+1`.

| etcd members | Quorum | Can survive losing |
|-------------:|-------:|-------------------:|
| 1            | 1      | 0                  |
| 3            | 2      | 1                  |
| 5            | 3      | 2                  |
| 7            | 4      | 3                  |

A 4-member cluster tolerates 1 failure — the same as 3 — but costs more and has more things that can break. Stick to **3 or 5**.

A control plane with 2 apiservers is technically OK (apiservers are stateless), but the 2 etcd members underneath would lose quorum on any failure. So in stacked topology the CP count is tied to the etcd count.

---

## Load balancer — what it does and doesn't do

The LB sits in front of the apiservers and distributes **inbound** TLS connections:

- **Protocol**: TCP (layer 4). HTTPS terminates at the apiserver; the LB does not decrypt.
- **Port**: 6443.
- **Balancing mode**: round-robin or least-conn. Apiservers are stateless, so any request can go to any node.
- **Health check**: TCP probe on 6443 **or** HTTPS GET `/healthz` / `/readyz`. TCP-only is fine for CKA; HTTP checks let you see readiness for a node that's mid-upgrade.

The LB's DNS name / IP is the **control-plane endpoint**. Clients, kubelets, controllers — everyone — connects there, not to any individual CP node.

Common shapes:

- **Cloud**: AWS NLB, GCP TCP LB, Azure LB.
- **On-prem**: HAProxy pair + keepalived for a VRRP virtual IP.
- **kube-vip / MetalLB**: software VIP that runs on the control plane nodes themselves.

Minimal HAProxy config:

```haproxy
frontend apiserver
    bind *:6443
    mode tcp
    default_backend apiserver_backend

backend apiserver_backend
    mode tcp
    balance roundrobin
    option tcp-check
    server cp1 10.0.0.11:6443 check
    server cp2 10.0.0.12:6443 check
    server cp3 10.0.0.13:6443 check
```

Keepalived pairs two HAProxy boxes with a shared VRRP VIP so the LB itself has no single point of failure.

### The `--control-plane-endpoint` flag

This is the address kubeadm puts into every kubeconfig and every cert SAN. If you run `kubeadm init` without it and later add a second CP, you're in for pain: the first-node cert was issued for that node's IP only; everyone else's kubeconfig points at a single node. You can fix it, but it's a schema-wide rewrite.

Rule: **set `--control-plane-endpoint` on the very first `kubeadm init`**, to the DNS name of the LB.

```bash
sudo kubeadm init \
  --control-plane-endpoint "k8s.internal:6443" \
  --upload-certs \
  --pod-network-cidr=10.244.0.0/16
```

If you forgot and need to add an endpoint after the fact:

```bash
kubectl -n kube-system edit configmap kubeadm-config
# under ClusterConfiguration:
#   controlPlaneEndpoint: "k8s.internal:6443"
#   apiServer:
#     certSANs: [k8s.internal, 10.0.0.100]
sudo kubeadm certs renew apiserver
# bounce the apiserver static pod, then update all kubeconfigs to point at the LB
```

---

## Joining additional control plane nodes

Kubeadm's `init` prints a join command. Save it.

```bash
sudo kubeadm join k8s.internal:6443 \
  --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash> \
  --control-plane \
  --certificate-key <key>
```

`--control-plane` tells kubeadm to install apiserver/scheduler/controller-manager on this node, not just join as a worker.

`--certificate-key` decrypts control plane certs that were uploaded to a Secret during the first `init --upload-certs`. Without it, you'd have to scp the CA keys manually from CP1.

### What gets copied to the new CP

From first CP → new CP:

```
/etc/kubernetes/pki/ca.{crt,key}
/etc/kubernetes/pki/front-proxy-ca.{crt,key}
/etc/kubernetes/pki/etcd/ca.{crt,key}
/etc/kubernetes/pki/sa.{key,pub}
/etc/kubernetes/admin.conf   (sometimes)
```

The `sa.key`/`sa.pub` pair is critical: without the same keypair on all CPs, a ServiceAccount token signed on CP1 won't verify on CP2.

### Lost the join command?

Regenerate:

```bash
# From an existing CP:
sudo kubeadm token create --print-join-command
# join <lb>:6443 --token <new> --discovery-token-ca-cert-hash sha256:<hash>

# For the --certificate-key portion:
sudo kubeadm init phase upload-certs --upload-certs
# -> prints a fresh certificate-key valid for 2 hours
```

---

## Stateless apiservers, tied-to-local etcd

In stacked topology, each apiserver is configured to talk **only to its local etcd**:

```yaml
# /etc/kubernetes/manifests/kube-apiserver.yaml
spec:
  containers:
  - command:
    - kube-apiserver
    - --etcd-servers=https://127.0.0.1:2379
```

Why not list all three etcds? Because:

- Local etcd is fastest (no network hop).
- If the local etcd is healthy, it is already in sync with its peers via Raft.
- If local etcd is unhealthy, you probably have bigger problems on that node; failing fast is preferable.

But this means that when the local etcd on CP2 is down, CP2's apiserver will also fail health checks — and the LB should stop sending traffic there. This is why you want the LB health-check to be `/readyz`, not a blind TCP check: `/readyz` returns failure when the backing etcd is unreachable.

In external-etcd topology, `--etcd-servers` lists all etcd endpoints, and the apiserver round-robins.

---

## Leader election — scheduler and controller-manager

Unlike apiservers, the scheduler and controller-manager **must** have exactly one active instance cluster-wide at any time. Otherwise two schedulers would bind the same pod to different nodes.

They coordinate via Lease objects:

```bash
kubectl get lease -n kube-system

# NAME                                   HOLDER                                 AGE
# kube-scheduler                         cp2_e6c3f2                            10d
# kube-controller-manager                cp1_3b81aa                            10d
```

Mechanism:

- On startup, each instance attempts to create/update the Lease with `holderIdentity=<its own id>` and `acquireTime=<now>`.
- The current holder renews the Lease every `renew-deadline` seconds (default 10 s).
- Followers watch the Lease. If no renewal within `lease-duration` (default 15 s), another instance can claim it.
- Failover takes at most `lease-duration + retry-period` in the worst case — roughly 15–20 seconds.

Relevant flags (same on scheduler and controller-manager):

```
--leader-elect=true
--leader-elect-lease-duration=15s
--leader-elect-renew-deadline=10s
--leader-elect-retry-period=2s
```

Rarely tuned. If the control plane is flapping, relaxing these slightly reduces churn.

### Apiserver doesn't need leader election

Apiservers are stateless and write to etcd, which handles consistency. Multiple apiservers serve simultaneously — that's the whole point of HA.

There is a `kube-apiserver` lease per apiserver in `kube-system` (`apiserver-<nodename>` form), but it's used for identity / coordination with aggregated APIs, not for picking a single leader.

---

## A typical request's path in HA

```
kubectl get pods
    │
    ▼  TLS → lb.example.com:6443
 [ Load Balancer ]
    │  TCP round-robin
    ▼
 CP1 apiserver  (healthy)
    │
    ▼  --etcd-servers=https://127.0.0.1:2379
 Local etcd member  (part of a 3-member Raft group)
    │  Raft replication
    ▼
 peer CP2 etcd, peer CP3 etcd
```

When CP1's local etcd is the Raft **leader**, writes commit in one round-trip. When it's a **follower**, the write is forwarded to the leader and waits for majority commit — slightly slower but invisible to the client.

Fail a CP node → LB health check drops it → clients re-route to CP2 or CP3 → no visible outage.

Fail two CP nodes in a 3-node cluster → etcd loses quorum → remaining apiserver goes read-only (or fully unavailable) → this is why 3 is the minimum for real HA.

---

## Rolling upgrade order

Upgrading an HA cluster is order-sensitive. The kubeadm-recommended sequence is:

1. **CP1**:
   ```bash
   kubectl drain cp1 --ignore-daemonsets --delete-emptydir-data
   sudo apt install kubeadm=<new>
   sudo kubeadm upgrade plan
   sudo kubeadm upgrade apply v<new>          # does etcd + apiserver + cm + scheduler on this node
   sudo apt install kubelet=<new> kubectl=<new>
   sudo systemctl daemon-reload && sudo systemctl restart kubelet
   kubectl uncordon cp1
   ```
2. **CP2, CP3**:
   ```bash
   kubectl drain cpN --ignore-daemonsets --delete-emptydir-data
   sudo kubeadm upgrade node                   # notice: `node` not `apply`
   sudo apt install kubelet=<new> kubectl=<new>
   sudo systemctl daemon-reload && sudo systemctl restart kubelet
   kubectl uncordon cpN
   ```
3. **Workers**:
   ```bash
   kubectl drain wN --ignore-daemonsets --delete-emptydir-data
   sudo kubeadm upgrade node
   sudo apt install kubelet=<new> kubectl=<new>
   sudo systemctl daemon-reload && sudo systemctl restart kubelet
   kubectl uncordon wN
   ```

Ordering rules:

- **Within CPs**: always upgrade **one at a time**. Never in parallel — you risk simultaneous etcd member restarts.
- **CPs before workers**: apiservers must support everything the kubelets will report.
- **etcd first (inside each CP)**: `kubeadm upgrade apply` handles this automatically — etcd is upgraded before the apiserver on that node.

Skipping versions: kubeadm supports **one minor at a time** (1.29 → 1.30, not 1.29 → 1.31). Always check `kubeadm upgrade plan` first.

---

## Failure modes and diagnostics

| Symptom                                                                    | Likely cause                                                   | First check                                                           |
|----------------------------------------------------------------------------|----------------------------------------------------------------|-----------------------------------------------------------------------|
| kubectl hangs intermittently                                               | LB round-robin hitting a degraded CP with unhealthy etcd       | `curl -k https://<each-cp>:6443/readyz` on each CP                    |
| Some pods get `x509: certificate is valid for A, not lb.example.com`        | apiserver cert missing LB SAN                                  | `openssl x509 -in apiserver.crt -noout -ext subjectAltName`           |
| New CP node joins but its scheduler/controller-manager never become leader  | Clock skew, or lease duration misconfigured                    | `kubectl get lease -n kube-system`, check `renewTime`                 |
| `kubeadm join --control-plane` fails `couldn't validate the identity`       | expired `--certificate-key` (2h TTL)                           | on CP1: `kubeadm init phase upload-certs --upload-certs`              |
| Every apiserver returns 503 briefly after a CP reboots                      | apiserver starts before its local etcd is Ready                | tolerable; apiserver retries. If chronic, check etcd quorum.          |
| After losing 2 CPs in a 3-node cluster, cluster is read-only                | etcd lost quorum                                                | bring at least one CP back; do NOT use `--force-new-cluster` unless you understand the implications |
| New CP node's pods fail SA token validation                                 | `sa.key`/`sa.pub` not copied from CP1                          | copy `/etc/kubernetes/pki/sa.{key,pub}`, restart apiserver on new CP  |
| LB health check passes but real requests fail                               | LB checks 6443 TCP only; apiserver is running but /readyz fails | switch LB to HTTP probe on `/readyz`                                  |

### Health-check cheat sheet

```bash
# On each CP, ask the apiserver if it is ready
curl -k https://127.0.0.1:6443/healthz         # liveness
curl -k https://127.0.0.1:6443/readyz          # readiness (etcd + admission chain)
curl -k https://127.0.0.1:6443/livez?verbose   # every subsystem, one per line

# Ask which apiserver the LB sent me to
kubectl get --raw /readyz?verbose
kubectl -v=6 get nodes 2>&1 | grep 'GET https'   # shows the server URL in use
```

### Recovering from "lost one CP forever"

A CP can be declared dead and removed cleanly:

```bash
# From a surviving CP:
sudo kubeadm reset phase remove-etcd-member          # run ON the dead node if accessible
# OR, if dead node is unreachable, remove from etcd manually:
ETCDCTL_API=3 etcdctl member remove <id>             # <id> from `etcdctl member list`
kubectl delete node cp-dead
```

Then bring up a replacement with `kubeadm join --control-plane`.

---

## Exam heuristics

- You will not usually be asked to **build** an HA cluster on CKA. You will be asked to diagnose one.
- If `kubectl` works from one CP but not another, think LB or certs — not RBAC.
- If apiservers on one node keep restarting, check its local etcd first; it's the most common root cause in stacked mode.
- When asked to check which node is scheduler leader: `kubectl get lease -n kube-system kube-scheduler -o jsonpath='{.spec.holderIdentity}'`.

## Mental traps

- Thinking 2 CPs = HA. It isn't — the etcd pair has no quorum tolerance.
- Assuming `--control-plane-endpoint` can be added after the fact easily. You can, but you must also update every kubeconfig, regenerate certs with new SANs, and restart components. Avoid.
- Believing the LB "balances" anything useful beyond TCP. It just picks one of N apiservers per connection.
- Treating `kube-apiserver` leases like scheduler leases. They're not — no single leader. Don't try to "elect" the apiserver.
- Expecting ServiceAccount tokens to work identically across CPs without copying `sa.key`/`sa.pub`. They won't — SA tokens signed on one node fail to verify on another.
- Upgrading all CPs in parallel. You will lose quorum mid-way and the cluster will briefly go read-only. Always one at a time.
