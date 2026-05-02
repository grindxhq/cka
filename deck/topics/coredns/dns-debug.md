## DNS failure is the new "it's always DNS"

DNS failures in Kubernetes have an unusually high hit rate — small misconfigs cascade into "the cluster is broken." This note is the systematic debug flow.

The key diagnostic question: **where on the path did the query fail?**

```
pod  →  resolv.conf  →  CoreDNS Service (via kube-proxy)  →  CoreDNS pod  →  plugin chain  →  answer
```

Each arrow can fail. We walk each in order.

---

## Step 0: Define the symptom

Three very different failures feel similar:

- **Timeout** — query never answered. Usually a networking/firewall problem, or CoreDNS unreachable.
- **NXDOMAIN** — CoreDNS answered "no such name." Usually a naming/namespace problem.
- **SERVFAIL** — CoreDNS answered but failed to resolve. Usually an upstream issue or internal plugin error.

`dig`/`nslookup` shows which:

```bash
kubectl run netshoot --rm -it --image=nicolaka/netshoot --restart=Never -- bash

# inside pod:
dig web.default.svc.cluster.local +short
# (empty + non-zero exit → timeout or NXDOMAIN)

dig web.default.svc.cluster.local
# status: NXDOMAIN     ← name doesn't exist
# status: SERVFAIL     ← server error
# status: NOERROR      ← success
# connection timed out ← timeout
```

---

## Step 1: Is resolv.conf correct?

```bash
kubectl run netshoot --rm -it --image=nicolaka/netshoot --restart=Never -- cat /etc/resolv.conf
```

Expect:

```
nameserver 10.96.0.10
search default.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

Red flags:

- **Wrong nameserver IP**: kubelet's `clusterDNS` setting disagrees with the actual CoreDNS Service IP.
- **Wrong cluster domain in search**: kubelet's `clusterDomain` setting disagrees with Corefile's `kubernetes` line.
- **No search entries**: pod may be using `dnsPolicy: Default` or `dnsConfig: None` inappropriately.

Fix kubelet config if wrong:

```bash
sudo vi /var/lib/kubelet/config.yaml
# clusterDNS: [10.96.0.10]
# clusterDomain: cluster.local
sudo systemctl restart kubelet

# Recreate affected pods (they read resolv.conf on start)
kubectl delete pod <pod>
```

---

## Step 2: Can the pod reach the DNS Service?

```bash
# Inside the debug pod:
nc -zvu 10.96.0.10 53         # UDP
nc -zv 10.96.0.10 53          # TCP
```

Both should connect. If either fails:

- kube-proxy rules for the `kube-dns` Service are missing (see kube-proxy deck).
- NetworkPolicy is blocking pod → kube-system egress on port 53 (see network-policies deck).
- The CoreDNS Service itself has no Endpoints (no CoreDNS pods running).

Check Service & Endpoints:

```bash
kubectl -n kube-system get svc kube-dns
kubectl -n kube-system get endpoints kube-dns
# ENDPOINTS   10.244.0.5:53,10.244.0.7:53 ...
```

Empty Endpoints → no CoreDNS pods are Ready. Check next step.

---

## Step 3: Are CoreDNS pods Ready?

```bash
kubectl -n kube-system get pods -l k8s-app=kube-dns -o wide
# NAME                       READY   STATUS    RESTARTS   AGE   IP            NODE
# coredns-xxx                1/1     Running   0          5d    10.244.0.5    node1
# coredns-yyy                1/1     Running   0          5d    10.244.0.7    node2
```

If READY shows `0/1`:

```bash
kubectl -n kube-system describe pod coredns-xxx
# events may reveal: probe failures, image pull, scheduling issues
kubectl -n kube-system logs coredns-xxx
# CoreDNS's own logs
```

### Common CrashLoopBackOff causes

- **Invalid Corefile syntax** — CoreDNS rejects bad config, exits, restarts, exits, loops. `kubectl logs` shows the parse error.
  ```
  [FATAL] plugin/kubernetes: cluster.local is not a valid zone name
  ```
- **Loop plugin detected** — the `loop` plugin did a self-test query that came back to itself. Common when CoreDNS's upstream (forward plugin's `/etc/resolv.conf`) resolves to itself.
  ```
  [FATAL] plugin/loop: Loop (127.0.0.1:58086 -> :53) detected for zone "."
  ```
  Fix: change `forward .` to an explicit upstream (e.g. `8.8.8.8`).
- **Permission denied on port 53** — CoreDNS can't bind to privileged port without CAP_NET_BIND_SERVICE. Check the SecurityContext.
- **OOMKilled** — memory limit too low for a large cluster. Raise `resources.limits.memory`.

---

## Step 4: Can CoreDNS resolve this query at all?

Query CoreDNS directly, bypassing the client resolver:

```bash
kubectl run netshoot --rm -it --image=nicolaka/netshoot --restart=Never -- bash

# inside:
dig @10.96.0.10 kubernetes.default.svc.cluster.local
# This SHOULD return 10.96.0.1
```

If this works, DNS is fine in the cluster. The problem is pod-specific (its resolv.conf, its search path, its client).

If this fails:

- CoreDNS is unreachable → steps 2-3.
- CoreDNS doesn't know about this service → CoreDNS hasn't synced from apiserver yet, or the Service genuinely doesn't exist.

### Check CoreDNS's sync

```bash
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=50
# On startup you should see:
#   "reloading"
#   "ready"
```

`ready` on `:8181` is the signal that CoreDNS has loaded the Service/Endpoint cache. If it never reaches ready, something about the Kubernetes API connection is broken — check RBAC (ClusterRole `system:coredns`), the CoreDNS ServiceAccount, and apiserver reachability from CoreDNS pods.

---

## Step 5: NXDOMAIN — the name really doesn't resolve

`status: NXDOMAIN` means "this name doesn't exist." Reasons:

1. **Wrong namespace** — querying `web.default` from a pod in `dev` and expecting it to hit `web` in `dev`. It queries `web.default` (explicitly the `default` namespace), not `web.dev`.
2. **Typo** — `my-svc` vs `my-service`.
3. **Service deleted** — or recreated under a different name.
4. **Wrong cluster domain** — your app uses `cluster.local` but the cluster's domain is something else. Check Corefile.

Verify the Service exists:

```bash
kubectl get svc <name> -A
```

Check from inside the pod using the fully-qualified form:

```bash
dig +short web.default.svc.cluster.local
```

If FQDN works but short form doesn't, the pod's search path is the issue — check Step 1's resolv.conf.

---

## Step 6: SERVFAIL — upstream is broken

`status: SERVFAIL` from CoreDNS usually means the forward plugin couldn't resolve the query:

```bash
# From a CoreDNS pod:
kubectl -n kube-system exec -it <coredns-pod> -- sh
# inside CoreDNS pod:
cat /etc/resolv.conf           # the node's DNS
# nameserver 1.2.3.4
# ...

nslookup example.com 1.2.3.4
# If this fails, upstream DNS is broken
```

Common causes:

- Upstream DNS (node's `/etc/resolv.conf`) is wrong or unreachable.
- `forward . /etc/resolv.conf` detects the node's DNS as itself → loop (see `loop` plugin failure).
- Network policy on CoreDNS pods blocks egress to upstream.

### Fix

Point `forward` at an explicit, known-good upstream:

```
forward . 8.8.8.8 1.1.1.1
```

Apply via `kubectl edit cm coredns -n kube-system`, then `kubectl rollout restart deploy coredns -n kube-system`.

---

## Step 7: Intermittent timeouts

DNS works 90% of the time and fails 10%. Nasty. Usual causes:

### UDP conntrack issues

DNS uses UDP by default. Very busy nodes can fill `nf_conntrack` tables; new entries (including DNS replies) get dropped.

Symptoms:

- `dmesg | grep conntrack` shows "table full, dropping packet."
- Timeouts correlate with node load.

Fixes:

- Increase `net.netfilter.nf_conntrack_max` via sysctl.
- Install NodeLocal DNSCache (DaemonSet at `169.254.20.10` that uses TCP to CoreDNS, reducing conntrack pressure).

### UDP packet loss

Symptoms: intermittent timeouts, CoreDNS metrics show increased retries, `dig @10.96.0.10 ... +tcp` works reliably but UDP doesn't.

Fixes:

- Switch to TCP: `dnsConfig.options` with `use-vc` (not exactly this — apps must use `+tcp`).
- NodeLocal DNSCache (fixes via local TCP).

### MTU mismatches

If CNI encapsulation adds bytes (VXLAN 50 bytes, IPIP 20, WireGuard 80), DNS responses can exceed the path MTU. Fragmented UDP packets get dropped by some routers.

Symptoms: responses > 512 bytes fail; small responses work.

Fixes:

- Lower CNI's pod MTU to account for overhead.
- Force DNS over TCP for large responses (DNS protocol spec).

---

## The Docker-era loop — still occasionally seen

A common historical issue: the node's `/etc/resolv.conf` points at `127.0.0.53` (systemd-resolved) or `127.0.0.1`. When CoreDNS's `forward . /etc/resolv.conf` loads that, it tries to forward to 127.0.0.53 from inside the pod, which isn't systemd-resolved but is an unused address, or worse, is kube-proxy's iptables magic. Loop.

Modern CoreDNS detects this with the `loop` plugin and refuses to start. Fix by editing the Corefile:

```
forward . 8.8.8.8 1.1.1.1
```

Or (better) ensure the node's DNS resolver resolv.conf points at a real, external resolver.

---

## Debugging tools cheat sheet

```bash
# Baseline: resolve "kubernetes" in default — should always work
kubectl run bb --rm -it --image=busybox:1.28 --restart=Never -- nslookup kubernetes

# Query specific name through cluster DNS
kubectl run bb --rm -it --image=busybox:1.28 --restart=Never -- nslookup web.default.svc.cluster.local

# Bypass resolver, query CoreDNS directly
kubectl run bb --rm -it --image=busybox:1.28 --restart=Never -- nslookup web.default.svc.cluster.local 10.96.0.10

# Using nicolaka/netshoot for richer tools
kubectl run netshoot --rm -it --image=nicolaka/netshoot --restart=Never -- bash
# inside: dig +trace, dig +tcp, tcpdump, etc.

# CoreDNS logs
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=100 -f

# CoreDNS pods healthy?
kubectl -n kube-system get pods -l k8s-app=kube-dns

# CoreDNS Service has endpoints?
kubectl -n kube-system get endpoints kube-dns

# Corefile
kubectl -n kube-system get cm coredns -o yaml
```

---

## Enabling CoreDNS query logging (temporarily)

By default CoreDNS logs errors and startup. To see every query:

```bash
kubectl edit cm coredns -n kube-system
```

Add the `log` plugin:

```
.:53 {
    log                     # ← add at top of chain
    errors
    ...
}
```

Roll out:

```bash
kubectl rollout restart deploy coredns -n kube-system
```

Now:

```bash
kubectl logs -n kube-system -l k8s-app=kube-dns -f
# [INFO] 10.244.1.5:34567 - 12345 "A IN web.default.svc.cluster.local. udp 42 false 512" NOERROR - 30 ...
```

Remember to remove it when done — logging every query is expensive on busy clusters.

---

## Practical DNS debug playbook

```bash
# 1. Verify CoreDNS is healthy
kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system get endpoints kube-dns

# 2. Test from a debug pod
kubectl run bb --rm -it --image=busybox:1.28 --restart=Never -- sh
# inside:
cat /etc/resolv.conf
nslookup kubernetes              # baseline
nslookup web.default.svc.cluster.local
nslookup web.default.svc.cluster.local 10.96.0.10   # bypass search

# 3. If failure, check CoreDNS logs
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=100

# 4. Check Corefile
kubectl -n kube-system get cm coredns -o yaml

# 5. If forwarding seems broken, explicitly set upstream
kubectl edit cm coredns -n kube-system  # forward . 8.8.8.8
kubectl rollout restart deploy coredns -n kube-system
```

---

## Exam heuristics

- "DNS is not working" → always start with `nslookup kubernetes` from a debug pod. If this works, DNS is fine — something namespace/name-specific is wrong.
- Temporarily adding `log` to the Corefile is a quick way to see exactly what CoreDNS receives.
- `busybox:1.28` has a working `nslookup`; some newer busybox images removed it. Stick with `1.28` for exam scenarios.
- If you change the Corefile in the exam, remember to roll out the deployment to apply.
- If pods can't reach DNS but the Service IP looks right, suspect kube-proxy or NetworkPolicy before suspecting CoreDNS.

## Mental traps

- Assuming "no answer" = NXDOMAIN. It could be a timeout (completely different fix).
- Editing resolv.conf inside a container expecting it to persist. Pod restart overwrites.
- Checking only one CoreDNS pod. Check all replicas; one may be broken.
- Forgetting the `loop` plugin's startup self-test. If CoreDNS won't start, `logs` probably shows the loop error.
- Using busybox latest which may lack nslookup. Use 1.28.
- Running CoreDNS at scale with 2 replicas and no NodeLocal DNSCache. Eventually DNS becomes the bottleneck.
- Overlooking kernel-level causes (conntrack table full, MTU mismatches). Always check `dmesg` on the affected node.
