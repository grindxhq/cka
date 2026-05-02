## The renewal path

Kubeadm provides `kubeadm certs renew` for component-level cert renewal:

```bash
# Renew all kubeadm-managed certs
sudo kubeadm certs renew all

# Or one at a time
sudo kubeadm certs renew apiserver
sudo kubeadm certs renew apiserver-kubelet-client
sudo kubeadm certs renew apiserver-etcd-client
sudo kubeadm certs renew front-proxy-client
sudo kubeadm certs renew etcd-server
sudo kubeadm certs renew etcd-peer
sudo kubeadm certs renew etcd-healthcheck-client

# Renew embedded kubeconfig certs
sudo kubeadm certs renew admin.conf
sudo kubeadm certs renew controller-manager.conf
sudo kubeadm certs renew scheduler.conf
sudo kubeadm certs renew super-admin.conf
```

`renew all` regenerates everything on this node in one go. Each cert gets a fresh 1-year lifetime, signed by the same CA (which remains unchanged at 10 years).

---

## What renewal does NOT do automatically

Two critical post-renewal steps:

### 1. Restart control plane pods

kubeadm writes the new certs to disk but **does not** restart the running control plane static pods. They're still using the old (old files still open) certs until the pods restart.

Force a restart by "bouncing" each manifest:

```bash
# Standard bounce pattern
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sudo mv /etc/kubernetes/manifests/kube-controller-manager.yaml /tmp/
sudo mv /etc/kubernetes/manifests/kube-scheduler.yaml /tmp/
sudo mv /etc/kubernetes/manifests/etcd.yaml /tmp/

sleep 15          # kubelet stops the static pods

sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
sudo mv /tmp/kube-controller-manager.yaml /etc/kubernetes/manifests/
sudo mv /tmp/kube-scheduler.yaml /etc/kubernetes/manifests/
sudo mv /tmp/etcd.yaml /etc/kubernetes/manifests/

# kubelet detects the manifests returning, starts fresh pods with the new certs
```

During the 15-second gap, apiserver is down. Brief outage — plan for it. In HA, do one CP at a time.

### 2. Update any kubeconfigs stored outside `/etc/kubernetes/`

`kubeadm certs renew admin.conf` updates `/etc/kubernetes/admin.conf`. But if you previously copied it to `$HOME/.kube/config`, that copy still has the old (soon-to-be-expired) cert.

After renewal:

```bash
sudo cp /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

Or use `$KUBECONFIG=/etc/kubernetes/admin.conf` directly.

---

## Annual renewal — the routine

The typical yearly maintenance:

```bash
# On each CP node, one at a time:

# 1. Check current state
sudo kubeadm certs check-expiration

# 2. Renew all
sudo kubeadm certs renew all

# 3. Restart control plane pods (bounce manifests)
sudo mv /etc/kubernetes/manifests/*.yaml /tmp/
sleep 15
sudo mv /tmp/*.yaml /etc/kubernetes/manifests/

# 4. Verify health
kubectl get pods -n kube-system | grep -E 'apiserver|controller|scheduler|etcd'
kubectl version --short

# 5. Verify new expiry
sudo kubeadm certs check-expiration

# 6. Update admin kubeconfig
sudo cp /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

Do one CP node at a time in an HA cluster. Wait for the node's control plane to fully come back before moving to the next.

### Automatic renewal via upgrade

`kubeadm upgrade apply` also renews certs as a side effect. If you upgrade the cluster annually (or more often), you're implicitly renewing certs.

This is the path many teams use: never renew certs explicitly, just upgrade once a year.

---

## Renewing on node-join

When `kubeadm join --control-plane` runs on a new CP, it doesn't copy existing CP certs — it generates new ones signed by the shared CA. That new node starts with fresh 1-year certs.

You end up with CP nodes at different renewal cycles. That's fine; they all validate the same way against the shared CA.

---

## Renewing kubelet certs

`kubeadm certs renew` does NOT touch kubelet certs (`/var/lib/kubelet/pki/`). Kubelet is expected to auto-rotate via CSR if `rotateCertificates: true` in its config (default on kubeadm).

Verify kubelet's setting:

```bash
grep rotateCertificates /var/lib/kubelet/config.yaml
# rotateCertificates: true
```

When a kubelet cert nears expiry (~80% of lifetime), kubelet submits a CSR to the apiserver. Auto-approved by the controller-manager's CSR controller. Signed. Kubelet swaps to the new cert.

Watch for pending CSRs:

```bash
kubectl get csr | grep kubelet
```

If kubelet rotation is broken (missing RBAC, approver controller disabled), CSRs stay Pending and kubelets eventually die. Manual fix: approve them.

---

## Renewing kubelet serving cert

If `serverTLSBootstrap: true` in kubelet config, kubelet also requests a **serving** cert. These CSRs are NOT auto-approved by default (see kubeadm → bootstrap-and-tokens deck).

If you enabled this and forgot to approve serving CSRs, kubelets present expired/missing serving certs → apiserver can't verify them → `kubectl logs / exec` fails.

Regular maintenance:

```bash
# List pending serving CSRs
kubectl get csr | grep kubelet-serving | grep Pending

# Approve all
kubectl get csr -o name | xargs kubectl certificate approve

# Or deploy a CSR approver controller that does this automatically
```

---

## Adding a new apiserver SAN

Most common post-install cert change: a new DNS name or IP needs to be on the apiserver cert.

```bash
# Step 1: Update the kubeadm-config ConfigMap
kubectl edit cm -n kube-system kubeadm-config
# Under apiServer.certSANs, add: - new.example.com

# Step 2: On EACH CP node, regenerate apiserver cert
sudo rm /etc/kubernetes/pki/apiserver.crt /etc/kubernetes/pki/apiserver.key
sudo kubeadm init phase certs apiserver

# Step 3: Restart apiserver on that CP
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sleep 10
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/

# Step 4: Verify the cert now has the new SAN
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -ext subjectAltName
```

Now clients can reach apiserver at `new.example.com` without TLS errors.

---

## External CA mode renewal

For clusters running with an external CA:

```
sudo kubeadm certs check-expiration
# EXTERNALLY MANAGED column is `yes`
```

Kubeadm won't renew these. You renew externally:

1. Use your external PKI to re-sign each cert (CSRs from `/etc/kubernetes/pki/*.csr` if kubeadm generated them, or regenerate CSRs).
2. Copy the new signed certs to `/etc/kubernetes/pki/`.
3. Restart the control plane pods.

Exact procedure depends on your PKI. Document it before you need it.

---

## Recovery from expired apiserver cert

The cluster is "down." kubectl fails:

```
Unable to connect to the server: x509: certificate has expired or is not yet valid
```

You can't `kubectl` anything. But:

- The apiserver static pod is still running (kubelet keeps it).
- You have SSH to the CP node.
- `kubeadm` works locally (it doesn't go through apiserver for renewal).

```bash
# 1. Verify the expiry
sudo kubeadm certs check-expiration

# 2. Renew
sudo kubeadm certs renew all

# 3. Restart the apiserver (also controllers/scheduler/etcd if needed)
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sleep 15
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/

# 4. Verify
sudo crictl ps | grep apiserver
# Should show a fresh container, recently started

# Wait ~1 minute for it to stabilize, then:
kubectl get nodes
# Should work now
```

For HA: do this on each CP in turn. One at a time so the cluster stays up.

### If you can't ssh

You're in trouble. Options:

- Console access to the VM (cloud console, IPMI, etc.).
- If cert is expired but NOT by much (days), maybe set the system clock backwards temporarily (ugly, won't cover you for long).
- Rebuild: stand up a new cluster, restore etcd snapshot, migrate workloads.

---

## Recovery from an expired CA

If the CA itself expires, everything it signed is invalid. Catastrophic.

Can't easily rotate the CA in place — every client has the old CA cert embedded in kubeconfigs. Rotation options:

### Option 1: Rebuild the cluster

Cleanest path.

1. Take etcd snapshot.
2. `kubeadm reset` everything.
3. `kubeadm init` fresh (gets new CA).
4. Restore etcd data.
5. Re-join all nodes (new CA = new join tokens, new kubeconfigs).
6. Distribute new admin.conf to all users.

Downtime for the full rebuild, but well-defined.

### Option 2: CA rotation (advanced, risky)

Kubeadm 1.28+ has partial support:

1. Generate a new CA alongside the old one.
2. Stage both CAs as trusted by apiserver (`--client-ca-file` points to a bundle).
3. Reissue all leaf certs with the new CA.
4. Wait for clients to refresh kubeconfigs.
5. Remove the old CA from the bundle.

Requires careful coordination across many clients. Not typical CKA content; production-grade migration.

### Option 3: Use an external CA from the start

If you plan ahead, use external CA mode. The external PKI handles CA rotation; kubeadm just consumes signed certs.

---

## When renewal breaks

### `kubeadm certs renew` exits with error

Usually kubeadm can't find the CA key (external CA mode), or the existing cert file is corrupted.

```bash
ls -la /etc/kubernetes/pki/
# Look for unexpectedly-missing files or zero-length files
```

Regenerate from scratch: `sudo kubeadm init phase certs all` (regenerates everything signed by existing CAs).

### Apiserver doesn't pick up the new cert

You renewed but the manifest wasn't touched, so kubelet didn't restart the pod.

Solution: bounce the manifest as shown above.

### New cert, old kubeconfig still expired

Only the cert on disk was renewed. Kubeconfigs (like `admin.conf`) have embedded certs that need separate renewal:

```bash
sudo kubeadm certs renew admin.conf
sudo cp /etc/kubernetes/admin.conf $HOME/.kube/config
```

Or `sudo kubeadm certs renew all` covers both disk certs and kubeconfigs.

---

## Rotation strategy best practices

### Annual maintenance window

Schedule a yearly cert-rotation maintenance:

- Pre-event: check expiration, note which certs need renewal.
- Event: renew on each CP, bounce manifests one at a time, verify, repeat.
- Post-event: update admin kubeconfigs, distribute to users if needed.
- Confirm: `kubeadm certs check-expiration` now shows fresh dates.

### Combine with upgrade

If you upgrade the cluster annually, the upgrade itself renews certs. No separate renewal needed.

### Document exceptions

Any cert you manage manually (external CA, custom certs for extension API servers, webhook TLS) should have its own rotation schedule in runbooks.

---

## Observability for expiry

Add to your dashboards:

- **Time until apiserver cert expires** — alert at 60 days, page at 7 days.
- **Any Pending CSRs older than X hours** — catches kubelet rotation failures.
- **`kubeadm certs check-expiration` as a daily job output** — mail to ops, review.

The goal: never be surprised by an expired cert.

---

## Common scenarios recap

| Scenario                                     | Recipe                                                       |
|----------------------------------------------|--------------------------------------------------------------|
| Annual renewal                               | `kubeadm certs renew all` → bounce manifests on each CP       |
| Apiserver cert expired (cluster down)        | Same, then verify kubectl works                              |
| Need new apiserver SAN                       | Update kubeadm-config → regen apiserver cert → restart apiserver |
| Kubelet cert expiry (rotation broken)        | Approve pending CSRs; if none, check `rotateCertificates` config |
| CA expired                                   | Rebuild cluster (simpler) or complex CA rotation             |
| External CA, leaf cert expired               | Re-issue via external PKI, copy to `/etc/kubernetes/pki/`, restart |

---

## Exam heuristics

- `kubeadm certs renew all` is the workhorse. Remember to restart control plane pods after.
- `kubeadm certs check-expiration` before AND after renewal to confirm.
- For exam "apiserver cert expired" scenarios, renewing + restarting the static pod is usually enough.
- `kubectl config view --raw -o jsonpath='{.users[0].user.client-certificate-data}' | base64 -d | openssl x509 -noout -dates` extracts dates from kubeconfig-embedded certs.

## Mental traps

- Running `kubeadm certs renew` and not restarting pods. Old certs stay active in memory until restart.
- Forgetting to update your personal `~/.kube/config` after renewal. `kubectl` keeps using the expired cert.
- Renewing certs on one CP node and expecting the others to auto-sync. Each node renews independently.
- Assuming `kubeadm certs renew` handles kubelet certs. It doesn't — kubelet rotates separately.
- Skipping the manifest bounce and relying on kubelet to detect cert file changes. It doesn't; bounce the manifest.
- Not doing a backup before a renewal. If something goes wrong you want to revert quickly.
- Expecting renewal to fix a CA expiration. It can't — the CA itself is the trust root; re-signing leaves with an expired CA produces expired certs.
