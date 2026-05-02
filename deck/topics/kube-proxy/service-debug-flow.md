## The full Service-not-working debug tree

You have a Service. A client can't reach it. The layers below the Service (pods, CNI, DNS) might also be at fault — but you've isolated it to Service-level. This is the systematic tree.

```
Service unreachable
│
├── 1. Does it resolve? (DNS)
│       kubectl exec <client-pod> -- nslookup <svc>
│
├── 2. Does it have Endpoints?
│       kubectl get endpoints <svc>
│
├── 3. Does a direct TCP connection to the ClusterIP work from inside?
│       kubectl run bb --rm -it --image=busybox:1.36 --restart=Never -- sh
│       # wget -qO- <clusterip>:<port>
│
├── 4. Are kube-proxy rules correct on the target node?
│       iptables-save | grep KUBE-SVC-<hash>
│       # or ipvsadm -Ln
│
├── 5. Does traffic reach the pod and does the pod respond?
│       kubectl exec <backend-pod> -- ss -tlnp
│       tcpdump on the pod's netns
│
└── 6. Any NetworkPolicy blocking?
        kubectl get netpol -A
        (see network-policies deck)
```

Each step narrows the failure domain. This note focuses on steps 3-5 — the kube-proxy layer.

---

## Step 3: Can a pod inside the cluster reach the ClusterIP?

Start by launching an ad-hoc debug pod on the cluster:

```bash
kubectl run debug --rm -it --image=nicolaka/netshoot --restart=Never -- bash
# inside:
curl -sv http://<service-name>.<namespace>.svc.cluster.local:<port>/
curl -sv http://<cluster-ip>:<port>/
```

`nicolaka/netshoot` is a debugging image with curl, dig, nslookup, tcpdump, iperf, and more. If it's unavailable, `busybox:1.36` has `nslookup` and `wget`; `registry.k8s.io/pause` does not.

Outcomes:

- **DNS works, ClusterIP TCP works** → the Service is fine internally. Problem is external to the cluster (NodePort, LB, firewall).
- **DNS works, ClusterIP TCP fails** → kube-proxy rules broken or pods not reachable.
- **DNS fails** → CoreDNS issue, not kube-proxy.

You can eliminate DNS from the equation by calling by IP directly. If ClusterIP works but DNS doesn't, `coredns` is the next deck to consult.

---

## Step 4: Inspecting kube-proxy rules (iptables mode)

Find the service's hash:

```bash
# Get the service IP first
SVC_IP=$(kubectl get svc web -o jsonpath='{.spec.clusterIP}')
SVC_PORT=$(kubectl get svc web -o jsonpath='{.spec.ports[0].port}')
echo "$SVC_IP:$SVC_PORT"
# 10.96.0.50:80
```

On any node (ssh in or use kubectl debug node):

```bash
sudo iptables-save -t nat | grep -E "KUBE-SERVICES|KUBE-SVC|KUBE-SEP" | head -30

# Find the entry for this specific service
sudo iptables-save -t nat | grep "10.96.0.50/32"
# -A KUBE-SERVICES -d 10.96.0.50/32 -p tcp --dport 80 -j KUBE-SVC-X7MZ6YQ5L2RDLPFA
```

Take the target chain name and inspect it:

```bash
sudo iptables-save -t nat | grep KUBE-SVC-X7MZ6YQ5L2RDLPFA
# -A KUBE-SVC-X7M -m statistic --mode random --probability 0.333 -j KUBE-SEP-A1
# -A KUBE-SVC-X7M -m statistic --mode random --probability 0.500 -j KUBE-SEP-B2
# -A KUBE-SVC-X7M -j KUBE-SEP-C3
```

And each endpoint:

```bash
sudo iptables-save -t nat | grep KUBE-SEP-A1
# -A KUBE-SEP-A1 -p tcp -j DNAT --to-destination 10.244.1.5:8080
```

Checklist:

- Is there a KUBE-SVC chain for this service at all? If not, kube-proxy hasn't programmed the service. Check kube-proxy logs.
- Are the KUBE-SEP entries correct? Each should DNAT to a real pod IP + port.
- Do the DNATs match what EndpointSlices say?

### If there's no KUBE-SVC chain

Possibilities:

- kube-proxy on this node hasn't synced yet (should happen in seconds).
- kube-proxy is stuck in a reconcile loop — check logs:
  ```bash
  kubectl logs -n kube-system <kube-proxy-pod> --tail=100
  ```
- The Service was just created and kube-proxy hasn't picked it up yet. Wait 30s and re-check.

### If KUBE-SVC exists but has no KUBE-SEP entries

The service has no endpoints. Go back to `kubectl get endpoints <svc>` and the no-endpoints-triage subtopic.

---

## Step 4 (IPVS mode): `ipvsadm`

In IPVS mode, the rules are in a different place:

```bash
sudo ipvsadm -Ln
# IP Virtual Server version 1.2.1 (size=4096)
# Prot LocalAddress:Port Scheduler Flags
#   -> RemoteAddress:Port           Forward Weight ActiveConn InActConn
# TCP  10.96.0.50:80 rr
#   -> 10.244.1.5:8080              Masq    1      0          0
#   -> 10.244.2.7:8080              Masq    1      0          0
#   -> 10.244.3.12:8080             Masq    1      0          0
```

Checklist:

- Is there a virtual service for this ClusterIP:port? If not, same diagnosis as missing KUBE-SVC.
- Are all endpoints listed as real servers? If some are missing, EndpointSlice drift or kube-proxy hasn't synced.
- `Active-Conn` / `InActConn` should generally be non-zero if traffic is flowing. All zero = nothing has connected.
- Weight should usually be 1 uniformly (Kubernetes doesn't use weighted mode).

### Stats

```bash
sudo ipvsadm -Ln --stats
# shows packets and bytes in/out per real server
```

Useful for seeing if one endpoint is getting all the traffic (indicates scheduler weirdness).

---

## Step 5: Does the pod respond?

Even if kube-proxy rules are correct, the backend pod might not answer. Verify the pod is actually listening:

```bash
# Find the endpoint IPs
kubectl get endpoints web
# NAME   ENDPOINTS                                AGE
# web    10.244.1.5:8080,10.244.2.7:8080          10d

# Try each directly
kubectl run debug --rm -it --image=nicolaka/netshoot --restart=Never -- bash
# inside:
curl -v http://10.244.1.5:8080/
```

If the direct pod IP works but the ClusterIP doesn't, the kube-proxy layer is broken. If direct pod IP also fails, the pod or CNI is broken.

### Is the pod really listening?

```bash
kubectl exec <backend-pod> -- ss -tlnp
# LISTEN 0 128 0.0.0.0:8080 0.0.0.0:* users:(("app",pid=1,fd=3))
```

Must show a listen on the port Endpoints points at. A common mismatch: pod listens on 127.0.0.1:8080, not 0.0.0.0:8080. Traffic from outside the pod hits a closed port.

Fix: make the app bind to `0.0.0.0`.

---

## Step 5 extras: tcpdump the pod's network namespace

When rules look right and pod listens right but traffic still fails, watch packets:

```bash
# From a node, find the pod's container PID
CONTAINER_ID=$(crictl ps | grep <pod-name> | awk '{print $1}')
PID=$(crictl inspect -o go-template --template='{{.info.pid}}' $CONTAINER_ID)

# tcpdump inside the pod's netns
sudo nsenter -t $PID -n tcpdump -nni any port 8080
```

You'll see whether packets reach the pod at all, and if so, whether the pod answers. Common patterns:

- **No packets arriving** → kube-proxy rules not routing here, or CNI dropping. Check node forwarding rules.
- **Packets arrive but no response** → the pod got the packet but the app ignored it (wrong port, firewall inside container).
- **SYN but no SYN-ACK** → pod received but doesn't accept. App issue.
- **SYN-ACK seen but client never gets it** → return path broken (unusual).

### Alternative: tcpdump on the node's interface

```bash
# On the node
sudo tcpdump -nni any host 10.244.1.5 and port 8080
```

Shows all traffic to that pod from the node's perspective.

---

## Conntrack — checking NAT state

When DNAT happens, the kernel keeps a connection-tracking entry:

```bash
sudo conntrack -L | grep 10.96.0.50
# tcp 6 300 ESTABLISHED src=10.244.5.22 dst=10.96.0.50 sport=54321 dport=80
#                         src=10.244.1.5 dst=10.244.5.22 sport=8080 dport=54321 ...
```

The first line is "original direction" (client perspective); the second is "reply direction" (what the server sees after DNAT). If you see the entry, the DNAT happened successfully.

Useful commands:

```bash
# Stats
sudo conntrack -S

# Watch in real time
sudo conntrack -E

# Flush (destructive — kills active connections)
sudo conntrack -F
```

Conntrack bugs are rare but can happen under very high connection rates (tables fill up). `nf_conntrack: table full, dropping packet` in dmesg is the warning sign.

---

## externalTrafficPolicy: Local troubleshooting

If the Service uses `externalTrafficPolicy: Local`:

- Only nodes with a local Ready pod accept external traffic for this service.
- Cloud LBs health-check each node's `healthCheckNodePort`.

Debug:

```bash
# Which nodes have a Ready backing pod?
kubectl get pods -l <service-selector> -o wide

# Health check port
kubectl get svc web -o jsonpath='{.spec.healthCheckNodePort}'
# 31234

# Hit the health check manually (from outside the cluster)
curl http://<node-ip>:31234/healthz
# 200 if node has ≥1 Ready local pod; 503 otherwise
```

If the LB is sending traffic to nodes without local pods → 503 → traffic fails. The LB's target group membership might be stale; check cloud console.

---

## NodePort-specific debugging

```bash
# List all NodePort services
kubectl get svc -A --field-selector spec.type=NodePort

# A specific service's NodePort
kubectl get svc web -o jsonpath='{.spec.ports[0].nodePort}'
# 30080

# Test from outside the cluster
curl http://<node-ip>:30080/

# On the node, is the port listened on?
sudo ss -tlnp | grep 30080
# Actually, NodePort doesn't create a listener — it's all iptables DNAT.
# If you see no listener, that's normal.

# Is the firewall allowing 30080?
sudo iptables-save | grep 30080
```

A classic failure: external firewall (security group, cloud firewall) blocks the NodePort range 30000-32767. Traffic never reaches the node. Check the firewall first.

---

## kube-proxy health and log

When all else looks fine, kube-proxy itself may be stuck:

```bash
# Is the DaemonSet fully ready?
kubectl get ds kube-proxy -n kube-system

# Pods on each node
kubectl get pods -n kube-system -l k8s-app=kube-proxy -o wide

# Logs from one
kubectl logs -n kube-system <kube-proxy-pod> --tail=100

# Restart if stuck
kubectl delete pod -n kube-system <kube-proxy-pod>
# or full rollout
kubectl rollout restart ds kube-proxy -n kube-system
```

Common stuck-kube-proxy signs in logs:

- `Syncing iptables rules` printed repeatedly with no success.
- Watch errors on Services or EndpointSlices (usually an apiserver connectivity issue).
- "Unable to open IPVS socket" / missing kernel modules (IPVS mode only).

---

## Consolidated debug playbook

```bash
# 1. Does the Service exist and have Endpoints?
kubectl get svc <svc>
kubectl get endpoints <svc>

# 2. Inside a cluster pod, can we reach the ClusterIP?
kubectl run bb --rm -it --image=busybox --restart=Never -- \
  wget -qO- <clusterip>:<port>

# 3. Inside a cluster pod, can we reach the pod IP directly?
kubectl get endpoints <svc>
kubectl run bb --rm -it --image=busybox --restart=Never -- \
  wget -qO- <endpoint-ip>:<port>

# 4. On the target node, are kube-proxy rules installed?
sudo iptables-save | grep <clusterip>       # iptables mode
sudo ipvsadm -Ln | grep <clusterip>          # IPVS mode

# 5. On the target pod's netns, does it actually listen?
kubectl exec <backend-pod> -- ss -tlnp

# 6. Any NetworkPolicy in play?
kubectl get netpol -A

# 7. kube-proxy logs
kubectl logs -n kube-system <kube-proxy-pod-on-target-node> --tail=50
```

Work through these in order. The first one that returns unexpected output is your root cause.

---

## Exam heuristics

- When a Service is broken in an exam, **always check Endpoints first**. 60% of the time, that's the answer.
- If Endpoints is correct but traffic still fails, `iptables-save | grep KUBE-SVC-<hash>` reveals kube-proxy programming.
- For NodePort issues, remember the outer firewall — not every exam env opens 30000-32767 automatically.
- Use `busybox`/`nicolaka/netshoot` for temporary debug pods. They're fast to spin up.

## Mental traps

- Pinging a ClusterIP and concluding it's broken. Pings don't have iptables rules — TCP/UDP works.
- Debugging on the wrong node. Services work per-node; kube-proxy on node-1 programmed the rules, kube-proxy on node-2 programmed them separately. If the client is pinned to node-2, check there.
- Forgetting conntrack. NAT'd connections live there; if conntrack is full, new connections fail silently.
- Assuming all Service traffic goes through kube-proxy. NodePort/LoadBalancer external traffic does; pod-to-pod traffic via direct IP doesn't.
- Confusing iptables rules from kube-proxy with those from NetworkPolicy (Calico/Cilium install their own). Look at chain names — kube-proxy's start with KUBE-.
- Editing iptables rules by hand to "fix" a service. kube-proxy will overwrite them on its next sync. Fix the underlying Service/Endpoints instead.
