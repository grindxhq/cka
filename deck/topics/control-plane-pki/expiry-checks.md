## Why cert expiry matters

Every kubeadm leaf cert has a 1-year default lifetime. Forget to renew, and one day the apiserver starts refusing connections with `x509: certificate has expired`. Nobody can `kubectl get anything`. The cluster is effectively down — even though every pod is still running, because kubelet and controllers can't reach apiserver.

The good news: expiry is predictable. The bad news: it's easy to forget until it's too late.

---

## The canonical check: `kubeadm certs check-expiration`

```bash
sudo kubeadm certs check-expiration
```

Output:

```
[check-expiration] Reading configuration from the cluster...

CERTIFICATE                EXPIRES                  RESIDUAL TIME   CERTIFICATE AUTHORITY   EXTERNALLY MANAGED
admin.conf                 Apr 22, 2027 09:00 UTC   342d            ca                      no
apiserver                  Apr 22, 2027 09:00 UTC   342d            ca                      no
apiserver-etcd-client      Apr 22, 2027 09:00 UTC   342d            etcd-ca                 no
apiserver-kubelet-client   Apr 22, 2027 09:00 UTC   342d            ca                      no
controller-manager.conf    Apr 22, 2027 09:00 UTC   342d            ca                      no
etcd-healthcheck-client    Apr 22, 2027 09:00 UTC   342d            etcd-ca                 no
etcd-peer                  Apr 22, 2027 09:00 UTC   342d            etcd-ca                 no
etcd-server                Apr 22, 2027 09:00 UTC   342d            etcd-ca                 no
front-proxy-client         Apr 22, 2027 09:00 UTC   342d            front-proxy-ca          no
scheduler.conf             Apr 22, 2027 09:00 UTC   342d            ca                      no

CERTIFICATE AUTHORITY   EXPIRES                  RESIDUAL TIME   EXTERNALLY MANAGED
ca                      Apr 20, 2036 09:00 UTC   3650d           no
etcd-ca                 Apr 20, 2036 09:00 UTC   3650d           no
front-proxy-ca          Apr 20, 2036 09:00 UTC   3650d           no
```

Two tables:

- **Leaf certs** — short-lived, need regular renewal.
- **CAs** — long-lived (10 years), manual rotation.

If a row shows `EXTERNALLY MANAGED: yes`, it means kubeadm detected no matching private key on disk — external CA mode. Kubeadm won't try to renew those; you handle them via your external PKI.

### Reading `RESIDUAL TIME`

- **< 0 days**: already expired. Cluster is in trouble or already broken.
- **< 30 days**: renew soon.
- **< 60 days**: schedule a maintenance window.
- **> 90 days**: fine.

Kubelet will emit warnings as certs approach expiry; they go into the kubelet journal.

---

## Manual cert inspection with openssl

When kubeadm isn't available (or you want to check a cert file not under its management):

```bash
# Expiry dates
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -dates
# notBefore=Apr 23 09:00:00 2026 GMT
# notAfter=Apr 22 09:00:00 2027 GMT

# Is it expired?
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -checkend 0 && \
  echo "VALID" || echo "EXPIRED"

# Will it expire within 30 days?
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -checkend 2592000 && \
  echo "VALID FOR >30 DAYS" || echo "EXPIRES SOON"

# Show subject, issuer, SANs, key usage
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -text | head -40
```

`-checkend <seconds>` exits 0 if the cert is valid for at least that many seconds from now.

Useful for scripting:

```bash
for cert in /etc/kubernetes/pki/*.crt /etc/kubernetes/pki/etcd/*.crt; do
  if ! openssl x509 -in "$cert" -noout -checkend 2592000; then
    echo "$cert expires within 30 days"
    openssl x509 -in "$cert" -noout -dates
  fi
done
```

Ad-hoc pre-upgrade check.

---

## Checking kubeconfig embedded certs

`admin.conf` / `kubelet.conf` / `controller-manager.conf` / `scheduler.conf` have client certs **embedded** as base64. Extract + inspect:

```bash
kubectl config view --raw -o jsonpath='{.users[?(@.name=="kubernetes-admin")].user.client-certificate-data}' | \
  base64 -d | openssl x509 -noout -dates
```

Or for a specific file:

```bash
yq '.users[0].user."client-certificate-data"' /etc/kubernetes/admin.conf | \
  tr -d '"' | base64 -d | openssl x509 -noout -subject -dates
```

`kubeadm certs check-expiration` already covers these, but it's good to know how to extract manually.

---

## Checking kubelet's own cert

Kubelet's client cert lives separately:

```bash
openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem -noout -dates -subject
```

Kubelet auto-rotates its own cert via CSR when `rotateCertificates: true` in kubelet config (kubeadm default). So kubelet-specific cert expiry is usually not a manual concern — unless CSR auto-approval is broken.

For the kubelet **serving** cert (separate file if `serverTLSBootstrap: true`):

```bash
openssl x509 -in /var/lib/kubelet/pki/kubelet.crt -noout -dates
```

If serving certs pile up as pending CSRs (see kubeadm → bootstrap-and-tokens deck), kubelet can't renew, and eventually its serving cert expires → apiserver can't reach kubelet → `kubectl logs / exec / proxy` all break.

---

## Checking etcd certs

etcd has its own set of certs signed by the etcd CA. `kubeadm certs check-expiration` includes them. Manually:

```bash
for cert in /etc/kubernetes/pki/etcd/*.crt; do
  echo "=== $cert ==="
  openssl x509 -in $cert -noout -subject -dates
done
```

etcd peer cert expiry can cause split-brain (members can't reach each other). Server cert expiry blocks apiserver → etcd connections.

---

## What happens when a cert expires

### apiserver.crt expires

- Kubelet can't connect to apiserver (TLS fails).
- kubectl fails.
- Controllers can't reconcile.
- Workloads already running stay running (until some pod event needs controller action).
- Cluster is effectively read-only and degrading.

You fix by renewing the cert and restarting apiserver. Clients eventually reconnect. New pods can be scheduled again.

### admin.conf client cert expires

- kubectl fails with `Unauthorized` (401).
- Can still use `super-admin.conf` or any other valid kubeconfig.

Renew with `kubeadm certs renew admin.conf`.

### kubelet client cert expires (and rotation is broken)

- Kubelet can't authenticate to apiserver.
- Node goes NotReady.
- Pods on that node still run but kubelet's view of them drifts.

Fix: approve pending CSR, or manually regenerate kubelet's cert (via kubeadm join or cert-manager).

### etcd/server.crt expires

- apiserver can't connect to etcd. All writes fail. Reads from apiserver's cache work briefly then error.
- Full cluster outage for control plane.

Fix: renew etcd cert, restart etcd pod (move manifest out and back).

### CA cert expires

- Everything signed by that CA is now invalid (since its issuer is expired).
- Full cluster outage, no quick fix.

This is why CAs are 10 years. You should never hit this — plan to rebuild the cluster before the CA expires.

---

## Monitoring cert expiry

### Prometheus + alertmanager

Scrape `kube-apiserver_certificate_expiration_seconds`:

```promql
# Alert when apiserver cert < 30 days
(apiserver_client_certificate_expiration_seconds_count - time()) / 86400 < 30
```

Not all distributions expose this metric; check yours. Alternatively, write an exporter that reads `kubeadm certs check-expiration` output.

### Cronjob-based check

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cert-expiry-check
  namespace: kube-system
spec:
  schedule: "0 0 * * *"                    # daily
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          tolerations:
          - key: node-role.kubernetes.io/control-plane
            operator: Exists
            effect: NoSchedule
          hostPID: true
          hostNetwork: true
          containers:
          - name: check
            image: ubuntu:22.04
            command:
            - /bin/bash
            - -c
            - |
              apt-get update && apt-get install -y openssl curl
              for cert in /etc/kubernetes/pki/*.crt; do
                if ! openssl x509 -in "$cert" -noout -checkend 2592000; then
                  curl -X POST -d "cert expiring: $cert" https://alerts.example.com/hook
                fi
              done
            volumeMounts:
            - name: pki
              mountPath: /etc/kubernetes/pki
              readOnly: true
          volumes:
          - name: pki
            hostPath: { path: /etc/kubernetes/pki }
```

Rudimentary but effective. Run daily, alert on upcoming expirations.

### `cert-manager`

For applications beyond Kubernetes itself: [cert-manager](https://cert-manager.io/) is a CRD-based certificate manager that handles Let's Encrypt, internal CAs, and automatic rotation. Doesn't manage kubeadm's control plane PKI, but essential for app certs (Ingress TLS, webhook configs, etc.).

---

## Live connection test

The most direct check: can clients actually connect?

```bash
# Can we reach the apiserver?
kubectl get --raw /healthz

# What cert is the apiserver serving?
openssl s_client -connect localhost:6443 -servername kubernetes < /dev/null 2>/dev/null | \
  openssl x509 -noout -subject -dates -ext subjectAltName

# Is our client cert accepted?
kubectl auth whoami
# If this fails with "Unauthorized", your client cert is the problem.
```

Running these after a fresh cert renewal is the quickest sanity check.

---

## Time skew is another "expiry" cause

A cert that shows `notAfter=2027-01-01` is only "valid" if the system clock believes we're before 2027-01-01. A node with a wildly-wrong clock may see valid certs as expired.

```bash
# Check node time
timedatectl status
# Local time: Thu 2026-04-24 09:00:00 UTC
# Time zone: UTC (UTC, +0000)
# System clock synchronized: yes
# NTP service: active
```

If multiple CP nodes have different times, etcd Raft can flap and TLS intermittently fails. Ensure NTP is active on every node.

---

## Detecting cert usage problems vs just expiry

A cert can be valid by dates but not match its intended use. Example: apiserver cert needs `Extended Key Usage: TLS Web Server Authentication`. A cert missing this:

```bash
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -ext extendedKeyUsage
# X509v3 Extended Key Usage:
#     TLS Web Server Authentication
```

If not present (or wrong), TLS handshakes may reject with "certificate is not valid for server auth" — a different error from "expired."

Kubeadm-generated certs always have the right usage. External CA mode is where these mistakes creep in.

---

## Quick exam snippets

### How many days until apiserver expires?

```bash
sudo kubeadm certs check-expiration | grep ^apiserver
```

### Every cert in order of expiry (soonest first)

```bash
for cert in /etc/kubernetes/pki/*.crt /etc/kubernetes/pki/etcd/*.crt; do
  expiry=$(openssl x509 -in "$cert" -noout -enddate | cut -d'=' -f2)
  echo "$(date -d "$expiry" +%s) $cert $expiry"
done | sort -n | head
```

### Which cert is the apiserver actually serving right now?

```bash
openssl s_client -connect localhost:6443 -servername kubernetes < /dev/null 2>/dev/null | \
  openssl x509 -noout -subject -issuer -dates
```

### Does the CA in my kubeconfig still match the cluster's?

```bash
kubectl config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | \
  base64 -d > /tmp/client-ca.pem

diff /tmp/client-ca.pem /etc/kubernetes/pki/ca.crt
```

Empty diff = match. Any difference = CA rotated on the cluster but your kubeconfig wasn't updated.

---

## Failure modes tied to expiry

| Symptom                                                         | Likely cause                                           |
|-----------------------------------------------------------------|--------------------------------------------------------|
| kubectl fails with `Unauthorized`                                | Client cert in kubeconfig expired                      |
| kubectl fails with `x509: certificate has expired`              | Server (apiserver) cert expired                        |
| Nodes flip NotReady simultaneously                               | kubelet client certs expired (rotation broken)         |
| apiserver logs show `x509: certificate expired` on every request | apiserver serving cert expired                         |
| etcd pod CrashLoopBackOff with TLS errors                        | etcd server / peer cert expired                        |
| Metrics-server broken, aggregated API errors                      | front-proxy-client cert expired                        |
| `kubectl apply` hangs forever                                     | Admission webhook cert expired (app-level certs)       |
| Random intermittent failures across nodes                         | Clock skew making certs appear expired / not-yet-valid |

---

## Exam heuristics

- `sudo kubeadm certs check-expiration` is the one command to run on any "cert / expiry" exam question.
- `openssl x509 -noout -dates` for a specific file.
- A cert shown as `EXTERNALLY MANAGED: yes` is not renewable via `kubeadm certs renew`.
- For client cert expiry in kubeconfigs: `kubeadm certs renew admin.conf` (or the other .conf files).

## Mental traps

- Assuming `kubeadm certs check-expiration` covers kubelet certs. It doesn't — kubelet auto-rotates separately.
- Missing clock skew as the root cause. Always check `timedatectl` / `date`.
- Ignoring kubelet serving certs — they're ephemeral but expire independently.
- Blaming apiserver when the client cert is expired. Read the error message carefully: server-side vs client-side TLS errors look different.
- Trusting "EXTERNALLY MANAGED: no" means everything is fine. Kubeadm might be happy but a cert that doesn't match the live kubeconfig is still a broken link.
- Thinking CA expiry is a far-off problem. 10 years goes by fast; plan for CA rotation before year 9.
