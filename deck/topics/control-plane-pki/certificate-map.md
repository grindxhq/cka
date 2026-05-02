## The trust graph

A kubeadm cluster has **three independent CAs**. Understanding which CA signs what — and which chain a given TLS error is talking about — is the core skill for debugging cert issues.

```
                   ┌────────────── Kubernetes CA ──────────────┐
                   │   /etc/kubernetes/pki/ca.crt + ca.key      │
                   └──────────────────────┬───────────────────┘
                                          │  signs
      ┌───────────────────────────────────┼──────────────────────────────────┐
      │                                   │                                  │
 apiserver.crt              apiserver-kubelet-client.crt        kubelet client certs
 (apiserver serving)        (apiserver → kubelet for logs/exec) (via CSR → signed here)
                                          │                                  │
                                          │                             Per-node:
                                          │                             /var/lib/kubelet/pki/...
                                          │
                                   kubeconfig embedded certs
                                   (admin.conf, controller-manager.conf, ...)


                   ┌────────────── etcd CA ──────────────┐
                   │   /etc/kubernetes/pki/etcd/ca.crt    │
                   └──────────────┬───────────────────────┘
                                  │  signs
           ┌──────────────────────┼────────────────────────────┐
           │                      │                            │
  etcd/server.crt         etcd/peer.crt          apiserver-etcd-client.crt
  (etcd TLS to clients)    (etcd ↔ etcd peer)    (apiserver → etcd)
                                                  etcd/healthcheck-client.crt


                   ┌────────── Front-Proxy CA ──────────┐
                   │   /etc/kubernetes/pki/              │
                   │   front-proxy-ca.crt                 │
                   └──────────┬──────────────────────────┘
                              │  signs
                   front-proxy-client.crt
                   (apiserver → extension apiservers)


                   ServiceAccount token signing
                   /etc/kubernetes/pki/sa.{key,pub}
                   (keypair, not a cert)
```

Three CAs means three separate trust chains. A cert issued by one CA does not authenticate against another.

---

## Every file in `/etc/kubernetes/pki/`

Reading top to bottom for the common kubeadm install:

```
/etc/kubernetes/pki/
├── ca.crt / ca.key                                    Kubernetes CA
├── apiserver.crt / apiserver.key                       apiserver serving
├── apiserver-kubelet-client.crt / .key                 apiserver → kubelet client
├── apiserver-etcd-client.crt / .key                    apiserver → etcd client (signed by etcd CA)
├── front-proxy-ca.crt / .key                           Front-proxy CA
├── front-proxy-client.crt / .key                       apiserver → extension API servers
├── sa.key / sa.pub                                     SA token signing keypair
└── etcd/
    ├── ca.crt / ca.key                                 etcd CA
    ├── server.crt / .key                               etcd TLS (ports 2379, 2380)
    ├── peer.crt / .key                                 etcd peer-to-peer
    └── healthcheck-client.crt / .key                   etcd liveness probe
```

Ten cert files plus six keys plus the sa keypair plus three CA certs and keys. 13+ certificates, managed by kubeadm.

---

## Kubernetes CA (`ca.crt`, `ca.key`)

Self-signed root. Signs:

- `apiserver.crt` — apiserver's serving cert.
- `apiserver-kubelet-client.crt` — apiserver uses this when it connects to kubelet on :10250.
- All kubeadm-generated kubeconfigs' embedded client certs.
- Kubelets' own client certs (after CSR flow).

### Inspecting the Kubernetes CA

```bash
openssl x509 -in /etc/kubernetes/pki/ca.crt -noout -subject -issuer -dates
# subject=CN = kubernetes
# issuer=CN = kubernetes                    # self-signed
# notBefore=Apr 23 09:00:00 2026 GMT
# notAfter=Apr 20 09:00:00 2036 GMT          # ~10-year lifetime
```

Kubeadm's CA has a 10-year lifetime by default. No automatic rotation. You're expected to either re-init the cluster every 10 years, rotate the CA (disruptive — every client needs to re-trust), or use an external CA from the start.

### Kubeadm's CA is NOT the cluster root of all trust

- etcd CA is separate.
- Front-proxy CA is separate.
- Kubelet's own serving cert is signed by the Kubernetes CA only if `serverTLSBootstrap: true` and CSRs are approved.

---

## apiserver serving cert

```bash
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout \
  -subject -issuer -dates -ext subjectAltName

# Subject:           CN = kube-apiserver
# Issuer:             CN = kubernetes
# notAfter:           Apr 22 09:00:00 2027 GMT             # ~1-year lifetime
# Subject Alt Name:   DNS:kubernetes, DNS:kubernetes.default,
#                      DNS:kubernetes.default.svc,
#                      DNS:kubernetes.default.svc.cluster.local,
#                      DNS:cp-1.example.com,
#                      IP Address:10.96.0.1, IP Address:10.0.0.5
```

Key observations:

- Subject is `kube-apiserver`; Issuer is the Kubernetes CA.
- 1-year lifetime by default.
- SAN list includes:
  - Internal service name variations (`kubernetes`, `kubernetes.default`, etc.).
  - ClusterIP of the `kubernetes` Service (first IP in service CIDR, e.g. 10.96.0.1).
  - Node's hostname.
  - Node's primary IP.
  - Whatever you added via `--apiserver-cert-extra-sans` at init or `apiServer.certSANs` in ClusterConfiguration.

Clients connect to apiserver by one of these names. If you connect by a name NOT in the SAN, TLS fails:

```
x509: certificate is valid for kubernetes, kubernetes.default, ...,
10.96.0.1, 10.0.0.5, not lb.internal.example.com
```

Fix: add the missing name to SANs and regenerate the cert. See renewal-and-recovery subtopic.

---

## apiserver-kubelet-client

```bash
openssl x509 -in /etc/kubernetes/pki/apiserver-kubelet-client.crt -noout \
  -subject -issuer -dates

# Subject:  CN=kube-apiserver-kubelet-client, O=system:masters
# Issuer:   CN=kubernetes
```

This is the cert apiserver presents when connecting to kubelet on :10250 (for `kubectl logs`, `exec`, port-forward, and the /metrics endpoint). CN is the username, O is the group.

`system:masters` (group) is bound to `cluster-admin` ClusterRole by default, so apiserver's identity toward kubelet is effectively root. Kubelet's authorizer gives it full access.

---

## apiserver-etcd-client

```bash
openssl x509 -in /etc/kubernetes/pki/apiserver-etcd-client.crt -noout \
  -subject -issuer

# Subject:  CN = kube-apiserver-etcd-client, O = system:masters
# Issuer:   CN = etcd-ca                    ← signed by etcd CA, NOT kubernetes CA
```

The cert file lives in the main pki dir, but it's signed by the etcd CA. This is the identity apiserver uses when it opens a gRPC connection to etcd on :2379.

When etcd validates this cert, it uses `/etc/kubernetes/pki/etcd/ca.crt` as the trust anchor.

---

## Front-proxy CA and client

```bash
openssl x509 -in /etc/kubernetes/pki/front-proxy-ca.crt -noout -subject -issuer
# Subject:  CN = front-proxy-ca
# Issuer:   CN = front-proxy-ca                    # self-signed
```

Used by the apiserver aggregation layer. When the apiserver proxies a request to an extension API server (e.g. metrics-server, custom APIs), it presents `front-proxy-client.crt` to prove it's the real apiserver. The extension API server validates against `front-proxy-ca.crt`.

This is invisible for most users. But if the metrics-server fails with "unable to verify user" errors, check this chain.

---

## etcd certs

### `etcd/ca.crt` — the etcd CA

Self-signed, separate root from the Kubernetes CA.

### `etcd/server.crt` — etcd's TLS serving cert

```bash
openssl x509 -in /etc/kubernetes/pki/etcd/server.crt -noout -subject -issuer -ext subjectAltName

# Subject:  CN = <hostname>
# Issuer:   CN = etcd-ca
# SAN:      DNS:localhost, DNS:<hostname>, IP Address:127.0.0.1,
#            IP Address:<node-ip>, IP Address:0:0:0:0:0:0:0:1
```

etcd serves client connections on 2379. Clients (apiserver, etcdctl) validate this cert.

SAN must include `127.0.0.1` and `localhost` for local `etcdctl` to work; and the node's external IP for multi-node etcd.

### `etcd/peer.crt` — etcd ↔ etcd

Similar, but used between etcd members on :2380. Separate from server.crt because peer auth has different semantics (each peer presents this to verify the other).

### `etcd/healthcheck-client.crt`

A client cert used by the kubelet's TCP health probe against etcd. Minimal permissions — just enough to make health check requests.

---

## Service account keypair (`sa.key` + `sa.pub`)

Not a certificate. A raw RSA keypair:

```bash
openssl rsa -in /etc/kubernetes/pki/sa.key -text -noout | head -5
# Private-Key: (2048 bit, 2 primes)
```

Used by apiserver to:

- **Sign** ServiceAccount JWTs (with `sa.key`) when it issues tokens.
- **Verify** incoming JWTs (with `sa.pub`) to authenticate requests.

Every ServiceAccount token is signed by this keypair.

### Critical for HA

Every CP node MUST have identical `sa.key` and `sa.pub`. A token signed on CP-1 must be verifiable on CP-2 (same public key). Kubeadm copies these during `kubeadm join --control-plane`.

If CPs have different keypairs: tokens minted on CP-1 work when requests hit CP-1 but fail when they hit CP-2. Random auth failures. Diagnosed by comparing `sa.pub` across nodes.

---

## Extracting info from a cert in practice

Useful one-liners:

```bash
# Subject and issuer
openssl x509 -in <cert> -noout -subject -issuer

# Lifetime
openssl x509 -in <cert> -noout -dates

# SANs
openssl x509 -in <cert> -noout -ext subjectAltName

# Everything
openssl x509 -in <cert> -noout -text | less

# Verify cert chain
openssl verify -CAfile /etc/kubernetes/pki/ca.crt /etc/kubernetes/pki/apiserver.crt
# /etc/kubernetes/pki/apiserver.crt: OK
```

Failure:

```bash
openssl verify -CAfile /etc/kubernetes/pki/ca.crt /etc/kubernetes/pki/etcd/server.crt
# error 20 at 0 depth lookup: unable to get local issuer certificate
```

Expected — etcd/server.crt is signed by etcd CA, not Kubernetes CA. Using the wrong CA to verify is the #1 TLS error in kubeadm diagnosis.

---

## Default lifetimes

| Cert                                         | Default lifetime        | Rotated by                        |
|----------------------------------------------|-------------------------|-----------------------------------|
| `ca.crt` (Kubernetes CA)                      | 10 years                | Manual / cluster rebuild         |
| `apiserver.crt`                               | 1 year                  | `kubeadm certs renew`            |
| `apiserver-kubelet-client.crt`                | 1 year                  | `kubeadm certs renew`            |
| `apiserver-etcd-client.crt`                   | 1 year                  | `kubeadm certs renew`            |
| `front-proxy-ca.crt`                          | 10 years                | Manual                            |
| `front-proxy-client.crt`                      | 1 year                  | `kubeadm certs renew`            |
| `etcd/ca.crt`                                 | 10 years                | Manual                            |
| `etcd/server.crt`                             | 1 year                  | `kubeadm certs renew`            |
| `etcd/peer.crt`                               | 1 year                  | `kubeadm certs renew`            |
| `etcd/healthcheck-client.crt`                 | 1 year                  | `kubeadm certs renew`            |
| `sa.key` / `sa.pub`                            | No expiry               | Manual                            |
| Embedded kubeconfig client certs              | 1 year                  | `kubeadm certs renew`            |
| Kubelet client cert (CSR-generated)           | 1 year (auto-rotated)   | kubelet's own CSR rotation        |
| Kubelet serving cert (CSR-generated)          | 1 year (auto-rotated)   | kubelet's own CSR rotation        |

Kubernetes and etcd CAs are 10 years. Leaf certs default to 1 year. Kubelet certs auto-rotate; component certs need manual `kubeadm certs renew`.

---

## Which CA verifies which chain

Cheatsheet for debugging:

| Client | Talks to | Presents cert signed by | Verifies server against |
|--------|----------|-------------------------|-------------------------|
| kubectl | apiserver | (optional) client cert signed by Kubernetes CA | Kubernetes CA (from kubeconfig's `certificate-authority-data`) |
| apiserver | kubelet | apiserver-kubelet-client.crt (Kubernetes CA) | kubelet serving cert (usually CSR-signed by Kubernetes CA) |
| kubelet | apiserver | CSR-generated cert (Kubernetes CA) | apiserver.crt (Kubernetes CA) |
| apiserver | etcd | apiserver-etcd-client.crt (etcd CA) | etcd/server.crt (etcd CA) |
| etcd | etcd (peer) | etcd/peer.crt (etcd CA) | etcd/peer.crt (etcd CA) |
| apiserver | extension API server | front-proxy-client.crt (front-proxy CA) | extension API's serving cert (caller's choice) |
| controller-manager | apiserver | client cert in controller-manager.conf (Kubernetes CA) | apiserver.crt (Kubernetes CA) |
| scheduler | apiserver | client cert in scheduler.conf (Kubernetes CA) | apiserver.crt (Kubernetes CA) |

Matching the correct CA to the correct chain is 80% of TLS debugging.

---

## Common cert-chain errors

### `x509: certificate signed by unknown authority`

- Client's trusted CA list doesn't include the CA that signed the server's cert.
- For kubectl → apiserver: kubeconfig's `certificate-authority-data` is wrong.
- For etcdctl → etcd: `--cacert` is pointed at the Kubernetes CA instead of etcd CA.

Fix: use the right CA.

### `x509: certificate is valid for X, Y, Z, not Q`

SAN mismatch. Client is connecting by name/IP Q, but cert doesn't list it.

Fix: regenerate cert with Q in the SAN list (for apiserver: add to `apiServer.certSANs` in kubeadm-config + `kubeadm init phase certs apiserver`).

### `x509: certificate has expired or is not yet valid`

Either the cert is literally expired, or there's a massive clock skew between client and server.

Fix: check dates (`openssl x509 -noout -dates`), check NTP, renew cert if expired.

### `tls: bad certificate` on the server side

The client presented a cert that the server can't verify (wrong CA) or doesn't recognize.

Fix: check what CA the server trusts (`--client-ca-file` on apiserver, etcd's `--trusted-ca-file`).

---

## Inspecting the live cert chain

For any HTTPS endpoint:

```bash
openssl s_client -connect <host>:<port> -showcerts < /dev/null 2>/dev/null | \
  sed -ne '/-BEGIN CERT/,/-END CERT/p'
```

Shows the cert chain the server presents. For apiserver:

```bash
openssl s_client -connect localhost:6443 -showcerts -servername kubernetes < /dev/null
```

Or use curl with verbose:

```bash
curl -vI --cacert /etc/kubernetes/pki/ca.crt https://localhost:6443/healthz
```

curl failure with a cert error shows exactly which leaf cert couldn't be verified.

---

## Exam heuristics

- Know the three CAs: Kubernetes, etcd, front-proxy. Each has its own trust chain.
- `/etc/kubernetes/pki/ca.crt` is the Kubernetes CA; `/etc/kubernetes/pki/etcd/ca.crt` is the etcd CA. **Don't confuse them.**
- For etcdctl commands, `--cacert` must be etcd CA; `--cert` / `--key` should be an etcd-CA-signed cert.
- `openssl x509 -in <cert> -noout -text` shows everything about a cert.
- To add a SAN: edit kubeadm-config → re-run `kubeadm init phase certs apiserver` → restart apiserver.

## Mental traps

- Using the Kubernetes CA to verify etcd traffic. Different CA, different chain.
- Expecting `sa.key` to be a certificate. It's not; it's a plain RSA keypair.
- Assuming the CA has a short lifetime. Default 10 years.
- Forgetting to propagate `sa.key` / `sa.pub` when adding a CP. Tokens fail verification on the new node.
- Not including `127.0.0.1` and `localhost` in etcd server SANs. Local etcdctl fails.
- Copy-pasting cert lifetimes from docs without actually checking (defaults can be changed at init time).
- Thinking kubeadm auto-rotates CAs. It doesn't. 10-year CAs are permanent unless you rebuild.
