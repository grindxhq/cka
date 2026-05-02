## Why this topic carries its own subtopic

On a kubeadm cluster, half the "API server is broken" incidents are actually certificate or kubeconfig failures. Certs expire silently, SANs don't match, kubeconfigs point at the wrong endpoint. The moment you can picture the full PKI graph in your head, these failures become a 90-second fix.

This note walks the full certificate map, the four kubeconfigs kubeadm creates, how the CSR signing loop works, and how to renew / recover without rebuilding the cluster.

---

## The three independent trust domains

Kubeadm maintains **three root CAs**, not one. This is load-bearing: an etcd cert issued by the main CA will not authenticate, and vice versa.

```
/etc/kubernetes/pki/
├── ca.crt           ── Kubernetes CA  ──┐  signs every "cluster" cert
├── ca.key                                 │
├── front-proxy-ca.crt  ─ Front-proxy CA ─┤  signs only the aggregation-layer proxy client cert
├── front-proxy-ca.key                     │
└── etcd/
    ├── ca.crt       ── etcd CA       ────┘  signs every etcd server / peer / client cert
    └── ca.key
```

Three roots means three distinct chains. Trust is not transitive across them.

---

## The full certificate map

Every file, where it lives, who signs it, what it is used for, and what must be in its SAN/CN.

### Kubernetes-CA signed

| File                                                          | Signed by | CN (subject)                              | Purpose                                    |
|---------------------------------------------------------------|-----------|-------------------------------------------|--------------------------------------------|
| `/etc/kubernetes/pki/apiserver.crt`                           | ca        | `kube-apiserver`                          | apiserver TLS serving cert                 |
| `/etc/kubernetes/pki/apiserver-kubelet-client.crt`            | ca        | `CN=kube-apiserver-kubelet-client, O=system:masters` | apiserver → kubelet (for `kubectl logs/exec`) |
| `/etc/kubernetes/pki/apiserver-etcd-client.crt`               | etcd-ca   | `CN=kube-apiserver-etcd-client, O=system:masters` | apiserver → etcd client auth               |
| `/etc/kubernetes/pki/front-proxy-client.crt`                  | front-proxy-ca | `CN=front-proxy-client`              | aggregation-layer / extension API servers  |
| `/etc/kubernetes/pki/sa.key` + `sa.pub`                       | (keypair) | —                                         | signs / verifies ServiceAccount JWTs        |

### etcd-CA signed

| File                                                 | CN                                  | Purpose                                |
|------------------------------------------------------|-------------------------------------|----------------------------------------|
| `/etc/kubernetes/pki/etcd/server.crt`                | `kube-etcd`                         | etcd server TLS (on `:2379` and `:2380`)|
| `/etc/kubernetes/pki/etcd/peer.crt`                  | `kube-etcd-peer`                    | etcd ↔ etcd peer TLS                    |
| `/etc/kubernetes/pki/etcd/healthcheck-client.crt`    | `kube-etcd-healthcheck-client`      | liveness probe client                   |

The `apiserver-etcd-client` cert is also etcd-CA signed (see above table) — that is why the apiserver can talk to etcd even though they have separate CAs.

### Kubelet certs (per node, outside `/etc/kubernetes/pki/`)

| File                                                   | Notes                                                     |
|--------------------------------------------------------|-----------------------------------------------------------|
| `/var/lib/kubelet/pki/kubelet-client-current.pem`      | Client cert the kubelet presents to apiserver. Symlink — rotates. |
| `/var/lib/kubelet/pki/kubelet.crt` / `.key`            | Server cert the kubelet serves on `:10250` (for apiserver → kubelet calls). |

Kubelet client certs have CN `system:node:<nodename>`, O `system:nodes` — **that is how the Node authorizer identifies them**. If you regenerate a kubelet cert with a wrong CN, the apiserver authenticates it but the Node authorizer refuses everything.

### The service-account keypair is special

`sa.key` / `sa.pub` is **not a certificate**, it is a bare asymmetric keypair used to sign and verify the JWTs the apiserver hands out as ServiceAccount tokens. There is no "expiry" on the key itself. But if the keypair is lost or changes, every existing ServiceAccount token becomes invalid.

In HA, this keypair **must be identical** on every control plane node. Copy it when you bring a new CP online.

---

## The apiserver serving cert's SAN list

This is the file most likely to bite you. `apiserver.crt` must include **every name and IP that any client could legitimately reach**, otherwise TLS fails with `x509: certificate is valid for ... not ...`.

Default kubeadm SANs:

```
DNS:
  kubernetes
  kubernetes.default
  kubernetes.default.svc
  kubernetes.default.svc.cluster.local
  <control-plane hostname>

IP:
  <control-plane node IP>
  <apiserver-advertise-address>
  <first IP of --service-cluster-ip-range>     # the "kubernetes" Service ClusterIP
  127.0.0.1      (sometimes)
```

You can extend this at init time:

```bash
kubeadm init \
  --control-plane-endpoint lb.example.com:6443 \
  --apiserver-cert-extra-sans lb.example.com,10.0.0.10,api.internal
```

After the cluster is up, extra SANs go into the `ClusterConfiguration`:

```bash
kubectl -n kube-system edit configmap kubeadm-config
# under apiServer.certSANs, add entries, then regenerate:
sudo kubeadm certs renew apiserver
```

Verify what an existing cert actually covers:

```bash
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout \
  -subject -issuer -dates -ext subjectAltName
```

If the cert is missing a SAN for the LB DNS name or IP, clients using that address get TLS errors even though kubelet and local `kubectl` work fine — classic symptom of an LB added after the fact.

---

## The four kubeconfigs kubeadm generates

Every control plane component gets its own kubeconfig with an embedded client cert. They live in `/etc/kubernetes/`.

| File                                         | User                                            | Group                    | Used by                     |
|----------------------------------------------|-------------------------------------------------|--------------------------|-----------------------------|
| `admin.conf`                                 | `kubernetes-admin` (CN)                         | `kubeadm:cluster-admins` (O) — bound to `cluster-admin` | the human operator |
| `super-admin.conf`                           | `kubernetes-super-admin` (CN)                   | `system:masters` (O) — bypasses RBAC | break-glass admin, new in recent kubeadm |
| `kubelet.conf`                               | `system:node:<nodename>` (CN)                   | `system:nodes` (O)       | the local kubelet            |
| `controller-manager.conf`                    | `system:kube-controller-manager` (CN)           | —                        | kube-controller-manager pod  |
| `scheduler.conf`                             | `system:kube-scheduler` (CN)                    | —                        | kube-scheduler pod           |

Kubeconfig anatomy:

```yaml
apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: <base64 ca.crt>
    server: https://lb.example.com:6443
  name: kubernetes
users:
- name: kubernetes-admin
  user:
    client-certificate-data: <base64 admin client cert>
    client-key-data:         <base64 admin client key>
contexts:
- context:
    cluster: kubernetes
    user: kubernetes-admin
    namespace: default
  name: kubernetes-admin@kubernetes
current-context: kubernetes-admin@kubernetes
```

Three things worth knowing:

- **`certificate-authority-data` is the CA**, not a client cert. Clients use it to verify the apiserver's serving cert.
- **`client-certificate-data` + `client-key-data`** is the identity you present.
- **`server:`** must match one of the apiserver cert's SANs, or TLS fails.

If you ever need to rebuild a kubeconfig from parts:

```bash
kubectl config --kubeconfig=/tmp/new.conf set-cluster cka \
  --server=https://lb.example.com:6443 \
  --certificate-authority=/etc/kubernetes/pki/ca.crt --embed-certs

kubectl config --kubeconfig=/tmp/new.conf set-credentials alice \
  --client-certificate=alice.crt --client-key=alice.key --embed-certs

kubectl config --kubeconfig=/tmp/new.conf set-context alice@cka \
  --cluster=cka --user=alice --namespace=default

kubectl config --kubeconfig=/tmp/new.conf use-context alice@cka
```

---

## The kubelet CSR bootstrap — how a new node gets a cert

Every worker node goes through this dance on `kubeadm join`:

```
1.  kubeadm join presents a bootstrap token
      → apiserver authenticates it as system:bootstrap:<token-id>
      → group system:bootstrappers:kubeadm:default-node-token (bound to CSR-creator ClusterRole)

2.  kubelet creates a CertificateSigningRequest
      CN=system:node:<nodename>, O=system:nodes
      signerName=kubernetes.io/kube-apiserver-client-kubelet

3.  CSR is auto-approved
      → ClusterRole system:certificates.k8s.io:certificatesigningrequests:nodeclient
      → automatic approval via controller in kube-controller-manager

4.  kube-controller-manager signs the CSR
      → uses --cluster-signing-cert-file=/etc/kubernetes/pki/ca.crt
      → uses --cluster-signing-key-file=/etc/kubernetes/pki/ca.key
      → writes the signed cert into CSR.status.certificate

5.  kubelet fetches its cert, stores as /var/lib/kubelet/pki/kubelet-client-current.pem

6.  kubelet switches from bootstrap token to its shiny new client cert
```

You can watch this happen:

```bash
kubectl get csr -A --watch
# NAME       AGE    SIGNERNAME                                    REQUESTOR                   REQUESTEDDURATION   CONDITION
# csr-abc    0s     kubernetes.io/kube-apiserver-client-kubelet   system:bootstrap:abcdef     <none>              Pending
# csr-abc    1s     kubernetes.io/kube-apiserver-client-kubelet   system:bootstrap:abcdef     <none>              Approved,Issued
```

Manual approval if auto-approve is disabled:

```bash
kubectl certificate approve <csr-name>
kubectl certificate deny <csr-name>
```

The same flow is used for **serving cert rotation** (`--rotate-server-certificates=true` on kubelet), which needs manual approval by default because the signer (`kubernetes.io/kubelet-serving`) has no auto-approver.

---

## Renewal — what `kubeadm certs` does

Everything under `/etc/kubernetes/pki/` (not including kubelet's `/var/lib/kubelet/pki/`) is managed by kubeadm. It gives you two commands:

```bash
sudo kubeadm certs check-expiration
#   CERTIFICATE                EXPIRES                  RESIDUAL TIME   CERTIFICATE AUTHORITY   EXTERNALLY MANAGED
#   admin.conf                 Nov 17, 2025 01:03 UTC   332d            ca                      no
#   apiserver                  Nov 17, 2025 01:03 UTC   332d            ca                      no
#   apiserver-etcd-client      Nov 17, 2025 01:03 UTC   332d            etcd-ca                 no
#   ...

sudo kubeadm certs renew all          # everything under /etc/kubernetes/pki/
sudo kubeadm certs renew apiserver    # single cert
```

Important details:

- `renew` **does not restart the control plane pods**. After renewal, bounce the static pods so they pick up new certs:
  ```bash
  sudo mv /etc/kubernetes/manifests/{kube-apiserver,kube-controller-manager,kube-scheduler,etcd}.yaml /tmp/
  sleep 10
  sudo mv /tmp/{kube-apiserver,kube-controller-manager,kube-scheduler,etcd}.yaml /etc/kubernetes/manifests/
  ```
- Kubelet certs are **separate** — `kubeadm certs renew` does not touch them. Enable `rotateCertificates: true` in `/var/lib/kubelet/config.yaml` and the kubelet will self-rotate via CSR.
- The `admin.conf` and `kubelet.conf` files have their client certs **embedded**. `kubeadm certs renew` rewrites the embedded data. After renewal, `kubectl --kubeconfig=admin.conf` uses the fresh cert automatically.

### What "externally managed" means

If the `EXTERNALLY MANAGED` column says `yes`, kubeadm will refuse to renew — it detected no private key for the relevant CA on disk, which means you're running in external-CA mode. You renew those certs through whatever system issued them in the first place.

---

## External CA mode

If you do not trust a self-signed CA to live on a control plane node, kubeadm can skip CA generation and consume signed certs you provide. The convention:

- Provide `ca.crt`, `etcd/ca.crt`, `front-proxy-ca.crt` but **not** their `.key`.
- Provide every signed leaf cert.
- `kubeadm init` then sees no CA keys and runs in external mode.

Consequence: `kubeadm certs renew` cannot sign anything. All renewals go through your external PKI.

---

## Failure modes and how to read them

| Error (from kubectl or component logs)                                                                 | Root cause                                                                             | Fix                                                                                                            |
|--------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|
| `x509: certificate has expired or is not yet valid`                                                    | clock skew OR expired cert                                                             | `timedatectl` on all nodes; `kubeadm certs check-expiration` → renew & restart static pods                     |
| `x509: certificate is valid for A, B, not C`                                                           | client is using a server name not in the cert's SANs                                    | add SAN via `certSANs` + regenerate `apiserver.crt`, or change the client to use a SAN-listed name             |
| `Unable to connect to the server: x509: certificate signed by unknown authority`                       | client presenting the wrong CA in its kubeconfig                                       | fix `certificate-authority-data` in kubeconfig, or `KUBECONFIG`/`--server` points elsewhere                     |
| `Unauthorized` on every kubectl even as admin                                                          | admin.conf's client cert expired, or the CA rotated out from under it                  | `kubeadm certs renew admin.conf` then reload                                                                   |
| kube-apiserver crashlooping with `failed to load client CA file`                                       | path wrong / file missing / wrong format                                               | `sudo ls -l /etc/kubernetes/pki/ca.crt`, fix the path in the apiserver manifest                                 |
| kubelet logs `failed to rotate client certificate`                                                     | CSR was not approved, OR controller-manager can't sign                                 | `kubectl get csr` — approve; check `--cluster-signing-*` on controller-manager                                  |
| ServiceAccount tokens on a new CP node fail to authenticate                                            | `sa.key`/`sa.pub` not copied from first CP node                                        | copy from `cp-1:/etc/kubernetes/pki/sa.*` to this node                                                         |
| etcd logs `tls: bad certificate`                                                                       | using wrong CA to verify etcd server, or wrong client cert                              | client must trust `/etc/kubernetes/pki/etcd/ca.crt`; client cert must be etcd-CA signed                         |
| kubectl logs apiserver: `failed to verify kubelet serving cert`                                        | kubelet serving cert not CSR-signed, apiserver has `--kubelet-certificate-authority`    | enable kubelet server cert rotation + approve pending CSR, or remove the strict flag (lowers security)          |
| after regenerating CA, all workloads disconnect                                                        | every cert signed by the old CA is worthless; SA tokens too (different key possibly)    | `kubeadm init phase certs all --apiserver-advertise-address=... --force` regenerates; you also need to rejoin nodes |

### Quick diagnostic one-liners

```bash
# Is the cert expired / about to expire?
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -dates

# Does it have the right SANs?
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -ext subjectAltName

# Was it signed by the CA we think?
openssl verify -CAfile /etc/kubernetes/pki/ca.crt /etc/kubernetes/pki/apiserver.crt

# What does my kubeconfig think it's connecting to?
kubectl config view --minify --raw | grep -E 'server:|certificate-authority'

# Who does the apiserver think I am?
kubectl auth whoami
```

---

## Recovery playbook: "the apiserver is rejecting my kubeconfig"

1. Is the cert inside the kubeconfig expired?
   ```bash
   kubectl config view --raw -o jsonpath='{.users[0].user.client-certificate-data}' | \
     base64 -d | openssl x509 -noout -dates
   ```
2. Is the server URL reachable and matched by the apiserver cert?
   ```bash
   openssl s_client -connect lb.example.com:6443 -servername lb.example.com < /dev/null 2>/dev/null | \
     openssl x509 -noout -subject -ext subjectAltName
   ```
3. Does the CA in the kubeconfig match the apiserver's chain?
   ```bash
   kubectl config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | \
     base64 -d > /tmp/client-ca.pem
   diff /tmp/client-ca.pem /etc/kubernetes/pki/ca.crt
   ```
4. If admin.conf is the one failing: renew on a control plane node.
   ```bash
   sudo kubeadm certs renew admin.conf
   sudo cp /etc/kubernetes/admin.conf ~/.kube/config
   ```
5. If every cert is expired (cluster was off for >1 year), renew all then bounce static pods:
   ```bash
   sudo kubeadm certs renew all
   sudo mv /etc/kubernetes/manifests/*.yaml /tmp/
   sleep 10
   sudo mv /tmp/*.yaml /etc/kubernetes/manifests/
   ```

---

## Exam heuristics

- `kubeadm certs check-expiration` is the fastest diagnostic for "something cert-related broke." Run it before anything else.
- If asked to add a new SAN, edit `kubeadm-config` ConfigMap under `apiServer.certSANs`, then `kubeadm certs renew apiserver`, then restart the apiserver static pod.
- If asked to generate a kubeconfig for a new user, sign a cert against `/etc/kubernetes/pki/ca.{crt,key}` (or use a CSR + `kubectl certificate approve`), bundle with `kubectl config set-credentials --embed-certs`.
- If asked to rotate kubelet certs, make sure `rotateCertificates: true` is in `/var/lib/kubelet/config.yaml`, and approve any CSRs that appear.

## Mental traps

- Thinking "the CA" is one thing. Kubeadm has three — Kubernetes, etcd, front-proxy — and mixing them up causes confusing TLS errors.
- Assuming renewing the cert fixes everything. You must also **bounce** the control plane pods so they pick up the new cert from disk.
- Forgetting that kubeconfigs have the client cert **embedded**. Re-signing `admin.conf`'s underlying cert on disk does nothing; kubeadm rewrites the whole kubeconfig.
- Treating `system:masters` as a role. It is a group written into the **certificate subject**, baked at signing time. You can't add/remove it via kubectl; you re-sign.
- Expecting cluster-wide RBAC to save you from an invalid cert. RBAC only runs after authentication succeeds. A broken cert never gets that far.
- Confusing kubelet client cert (`/var/lib/kubelet/pki/kubelet-client-current.pem`) with kubelet serving cert (`kubelet.crt`). Two separate rotations, two separate signers.
