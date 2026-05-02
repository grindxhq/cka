## What "API unavailable" looks like

```
$ kubectl get nodes
The connection to the server lb.example.com:6443 was refused — did you specify the right host or port?

$ kubectl get pods
Unable to connect to the server: net/http: TLS handshake timeout

$ kubectl get pods
Error from server (InternalError): an error on the server has prevented the request from succeeding
```

Three different errors, three different layers broken. The fix differs accordingly.

This is the most disruptive failure mode in Kubernetes — kubectl doesn't work, controllers can't reconcile, kubelets can't update node state. Yet existing workloads usually keep running until something forces a reschedule.

---

## The single decision tree

```
"kubectl can't reach the apiserver" / "API errors"
│
├── 1. Is it a CLIENT-SIDE issue? (network, kubeconfig)
│    Diagnose first — fastest to rule out.
│
├── 2. Is it the LB / DNS in front of the apiserver?
│
├── 3. Is the apiserver POD running?
│
├── 4. Is the apiserver CONTAINER healthy (or crash-looping)?
│
├── 5. Is the static pod MANIFEST valid?
│
├── 6. Is etcd healthy?
│
└── 7. Are TLS certs valid?
```

Walk in this order. Each step takes a minute or two with the right command.

---

## Step 1: Client-side diagnostic

Before SSHing anywhere, rule out client issues:

```bash
# What does my kubeconfig point at?
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'
# https://k8s.example.com:6443

# Can I resolve and connect?
nslookup k8s.example.com
nc -zv k8s.example.com 6443

# Is my client cert expired?
kubectl config view --raw -o jsonpath='{.users[0].user.client-certificate-data}' | \
  base64 -d 2>/dev/null | openssl x509 -noout -dates 2>/dev/null

# Who am I supposed to be?
kubectl auth whoami      # works only if apiserver is reachable
```

If `nslookup`/`nc` fail: network or DNS issue between you and the apiserver.

If `nslookup`/`nc` work but kubectl fails: TLS or apiserver problem.

If client cert is expired: renew via `kubeadm certs renew admin.conf` (on a CP node).

Also rule out: wrong context (`kubectl config current-context`), wrong cluster, network interface change.

---

## Step 2: LB / DNS layer

The error gives clues:

| Error | Likely cause |
|-------|--------------|
| "connection refused" | LB / apiserver port closed |
| "no route to host" | Network firewall / routing |
| "lookup ... no such host" | DNS not resolving |
| "TLS handshake timeout" | Connection reaches a server that's not the apiserver, or apiserver is overloaded |
| "x509: certificate is valid for X, not Y" | TLS cert SAN mismatch — DNS resolves to a server with a different cert |
| "x509: certificate has expired" | Apiserver's serving cert expired |

For LB issues:

```bash
# From the LB (or near it), can it reach apiservers?
curl -k https://<cp-node-ip>:6443/healthz
# 200? Apiserver responding to LB. So LB is broken.

# From outside, can you reach the LB?
curl -k https://<lb-dns>:6443/healthz
# Connection refused → LB is down or wrong port.
```

For HA: at least one CP node should be reachable. If all are unreachable: bigger problem (network, all CPs down).

---

## Step 3-4: Inside a CP node

SSH to a control plane node:

```bash
sudo crictl pods --name kube-apiserver

# POD ID    STATE   NAME                            NAMESPACE   ATTEMPT
# abc123    Ready   kube-apiserver-cp1              kube-system  0
```

If state is `Ready`, the sandbox exists. Check the container:

```bash
sudo crictl ps --name kube-apiserver

# CONTAINER  IMAGE                       STATE     NAME            ATTEMPT
# def456     kube-apiserver:v1.30        Running   kube-apiserver  3
```

`Attempts > 0` indicates restarts. Look at logs:

```bash
APISERVER_ID=$(sudo crictl ps --name kube-apiserver --latest -q)
sudo crictl logs --tail=100 $APISERVER_ID
```

If there's no apiserver pod at all (sandbox missing):

```bash
# kubelet's view of static pods
sudo journalctl -u kubelet --since '5 min ago' --no-pager | grep -iE 'static|manifest|apiserver' | tail -30

# Look for parse errors, image pull failures, manifest changes
```

---

## Step 5: Manifest validation

```bash
sudo cat /etc/kubernetes/manifests/kube-apiserver.yaml
```

Check for:

- **Recent edits** — is this a change you remember making?
- **Bad flags** — typos in the `command:` list?
- **Wrong image tag** — does the version exist?
- **Bad volume paths** — referencing files that don't exist?

If a recent edit broke things, revert:

```bash
# If you have a backup
sudo cp /root/kube-apiserver.yaml.bak /etc/kubernetes/manifests/kube-apiserver.yaml

# Or regenerate from kubeadm config
sudo kubeadm init phase control-plane apiserver
```

After fixing, the manifest takes effect when kubelet's reconcile fires (~30 seconds).

To force an immediate restart, **bounce** the manifest:

```bash
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sleep 10
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
```

kubelet stops the apiserver container (manifest gone) then restarts it (manifest back). Brief downtime per CP node — do one at a time in HA.

---

## Step 6: etcd health

If apiserver logs show etcd connection issues:

```
W0423 ... etcdserver: connection refused
E0423 ... etcd: client cert authorization failed
F0423 ... etcd cluster is not available
```

Then etcd is the root cause. Investigate:

```bash
# Is etcd running?
sudo crictl pods --name etcd
sudo crictl ps --name etcd

# Logs
ETCD_ID=$(sudo crictl ps --name etcd --latest -q)
sudo crictl logs --tail=50 $ETCD_ID

# Direct health check
ETCDCTL_API=3 sudo etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint health
```

Common etcd issues:

- **Disk full** — `df -h /var/lib/etcd`. Reclaim space, defrag.
- **NOSPACE alarm** — `etcdctl alarm list`. Compact + defrag + disarm.
- **Quorum lost (HA)** — bring back enough peers or use `--force-new-cluster` (last resort).
- **Cert expired** — etcd certs expire too. Check with `kubeadm certs check-expiration`.

Detail in the etcd deck.

---

## Step 7: TLS certs

```bash
sudo kubeadm certs check-expiration

# CERTIFICATE          EXPIRES                  RESIDUAL TIME
# apiserver            <date>                   < 30 days?
```

If apiserver cert expired or near-expired:

```bash
sudo kubeadm certs renew apiserver
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sleep 10
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
```

If admin.conf cert expired (your kubeconfig won't auth):

```bash
sudo kubeadm certs renew admin.conf
sudo cp /etc/kubernetes/admin.conf $HOME/.kube/config
```

For SAN issues (cert valid for X, request for Y):

- Add the missing SAN to `kubeadm-config` ConfigMap's `apiServer.certSANs`.
- Regenerate the apiserver cert: `kubeadm init phase certs apiserver`.
- Bounce the apiserver manifest.

---

## Time budget for triage

In an exam, target ~5 minutes from "API is broken" to identified cause:

| Time | Step | Action |
|------|------|--------|
| 0:00 | Initial | Read the error message — keyword tells you a lot |
| 0:30 | Client | `kubectl config current-context`, `kubectl auth whoami`, `nslookup`, `nc -zv` |
| 1:30 | Inside | SSH to CP node, `sudo crictl pods --name kube-apiserver` |
| 2:30 | Apiserver pod | `crictl ps`, `crictl logs` for the apiserver |
| 3:30 | Manifest | `sudo cat /etc/kubernetes/manifests/kube-apiserver.yaml` |
| 4:30 | etcd | If apiserver logs say so, drill into etcd |
| 5:00 | Certs | `sudo kubeadm certs check-expiration` |

Faster with practice. Don't waste time guessing — the error and the logs name the problem.

---

## Common scenarios and fixes

### "Connection refused on port 6443"

Apiserver isn't listening. Investigate:

```bash
sudo ss -tlnp | grep :6443
# Empty? Apiserver isn't running.

sudo crictl ps --name kube-apiserver
# Shows status. CrashLoopBackOff means it tried but failed.
```

Recent changes? Check journals + manifests.

### "TLS handshake timeout"

Something is on port 6443 but it's not negotiating TLS quickly:

- Apiserver overloaded (many requests in flight).
- Wrong process bound to 6443 (port conflict).
- Apiserver mid-startup (give it 30 seconds after restart).

```bash
# What's bound to 6443?
sudo ss -tlnp | grep :6443
# Should be /usr/local/bin/kube-apiserver
```

### "x509: certificate has expired"

The apiserver served a cert with a past `notAfter`. Renewal needed.

### "Unable to verify the server's certificate"

Your kubeconfig has a CA cert that doesn't match the apiserver's actual CA. The cluster's CA was rotated, or you're talking to a different cluster.

```bash
# Compare
kubectl config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | \
  base64 -d > /tmp/client-ca.pem

# On the CP node:
sudo cat /etc/kubernetes/pki/ca.crt > /tmp/cluster-ca.pem
diff /tmp/client-ca.pem /tmp/cluster-ca.pem
```

If different: copy fresh kubeconfig from `/etc/kubernetes/admin.conf`.

### "etcd cluster is not available"

Apiserver can't reach etcd. Either etcd is down or networking between apiserver and etcd is broken.

```bash
# On the CP node where apiserver runs:
ETCDCTL_API=3 sudo etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key endpoint health

# If unhealthy: see etcd deck for snapshot/restore.
```

For HA stacked etcd: each apiserver talks to its local etcd. If THIS node's etcd is broken, this apiserver fails — but other apiservers (and their etcds) are fine. The LB would route to a healthy one.

### "kubectl works but only sometimes"

Intermittent. Causes:

- HA with one bad CP node — LB sometimes routes to the broken one.
- Apiserver restarting frequently (CrashLoopBackOff with brief Ready windows).
- Network flapping.
- Clock skew (TLS valid here, expired there per skewed clocks).

```bash
# Find which apiserver answered
kubectl get --raw /version -v=8 2>&1 | grep 'GET https'

# Check each CP node's apiserver health individually
for cp in cp1 cp2 cp3; do
  echo "=== $cp ==="
  ssh $cp 'curl -k --max-time 5 https://127.0.0.1:6443/healthz'
done
```

The bad one will fail. Mitigate immediately by removing it from LB; investigate later.

---

## Recovery playbooks

### Playbook 1: "I just edited the apiserver manifest and now nothing works"

```bash
# 1. Read the current manifest
sudo cat /etc/kubernetes/manifests/kube-apiserver.yaml

# 2. Read apiserver logs
sudo crictl logs $(sudo crictl ps -a --name kube-apiserver --latest -q) | tail -30

# 3. The error is usually obvious (unknown flag, bad volume, etc.)

# 4. Fix the manifest in-place (or restore backup)
sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml

# 5. Wait for kubelet to recreate the pod (~30s)
watch sudo crictl ps --name kube-apiserver

# 6. Verify
kubectl get nodes
```

### Playbook 2: "Apiserver cert expired"

```bash
# 1. Confirm
sudo kubeadm certs check-expiration | grep apiserver

# 2. Renew
sudo kubeadm certs renew apiserver

# 3. Bounce
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sleep 10
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/

# 4. Verify
kubectl get --raw /healthz
```

For HA: on each CP node, in turn.

### Playbook 3: "etcd is the issue, single-node setup"

```bash
# 1. Stop apiserver (move manifest out)
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/

# 2. Diagnose etcd
sudo crictl logs $(sudo crictl ps -a --name etcd --latest -q) | tail -30

# 3. Disk full?
df -h /var/lib/etcd

# 4. Quota / NOSPACE? Compact + defrag + disarm (see etcd deck)

# 5. Corrupted? Restore from snapshot (see etcd → snapshots-and-restore deck)

# 6. Bring apiserver back
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
```

### Playbook 4: "All CPs are dead, single CP cluster"

You're rebuilding. Hopefully you have:

- An etcd snapshot.
- The cluster's PKI files (or a backup).

```bash
# 1. On a fresh node, kubeadm init from scratch (gives a new cluster).
# 2. Restore etcd from the snapshot:
sudo etcdutl snapshot restore /backup/etcd.db --data-dir=/var/lib/etcd

# 3. Modify the new cluster's etcd manifest to use this data-dir.

# 4. Distribute the old PKI to recreate trust.

# This is rebuild work; out of scope for simple recovery.
```

For HA, lose one CP and the cluster keeps running. Lose two of three → quorum loss → restoration via etcd procedures.

---

## What to log for postmortem

After recovery, capture:

- The exact error users saw.
- Apiserver logs (`crictl logs --tail=500 ... > apiserver-logs.txt`).
- etcd logs.
- kubeadm certs check-expiration output.
- Timestamps of any recent control plane changes.
- Disk usage on `/var/lib/etcd` and `/`.

This separates "fixed it but no idea what happened" from "we know what to prevent next time."

---

## Common root causes

In rough order of frequency in real clusters:

1. **Cert expiration** — apiserver's serving cert hit notAfter.
2. **Disk full on /var/lib/etcd** — etcd refuses writes.
3. **Bad manifest edit** — someone changed `kube-apiserver.yaml` and broke a flag.
4. **etcd corruption** — usually after kernel panic or hard power off.
5. **kubelet on the CP node down** — static pods don't run if kubelet is dead.
6. **HA quorum loss** — unrelated outages took out 2 of 3 etcd members.
7. **DNS / LB issue between client and apiserver** — apiserver fine, network broken.
8. **TLS SAN mismatch** — added new endpoint but didn't update certs.

---

## Exam heuristics

- For "kubectl doesn't work" exam scenarios, the answer is almost always within 5 minutes of `crictl logs` on the apiserver container.
- Memorize the bounce pattern: move manifest out, sleep, move back. Universal control-plane restart.
- `sudo kubeadm certs check-expiration` is the first cert diagnostic.
- For etcd issues, the recovery is in etcd → snapshots-and-restore deck.
- If all else fails, `kubeadm init` to rebuild — only if you have a snapshot to restore.

## Mental traps

- Trying to fix things via kubectl when kubectl is the broken thing. Use crictl + journalctl.
- Restarting kubelet when the issue is the manifest. Restart in the right order.
- Editing the live container's image instead of the manifest. The manifest is the source of truth.
- Force-restarting all 3 CPs at once in HA. Lose quorum.
- Force-deleting `/var/lib/etcd` to "reset" things. Wipes the cluster.
- Treating "TLS handshake timeout" as a network issue exclusively. Sometimes apiserver is overloaded.
- Using `kubectl --insecure-skip-tls-verify` to "get past" cert errors. Hides the real problem; never in production.
