## The problem this solves

A fresh node has nothing. No client cert, no kubeconfig, not even the cluster's CA certificate. Yet it needs to:

1. Authenticate to the apiserver (but it has no credentials).
2. Receive the cluster CA cert (but it needs to verify where it got it from).
3. Get a real client cert via CSR (for long-term use).

The solution is a **two-step bootstrap**: a short-lived token that authenticates the node just long enough to complete a TLS-authenticated join, plus a **discovery** mechanism that verifies the apiserver's CA.

---

## Bootstrap token format

A bootstrap token is a single string:

```
<6 chars>.<16 chars>
```

Example: `abcdef.0123456789abcdef`. Valid characters: `a-z0-9`.

Stored as a Secret in `kube-system`:

```bash
kubectl get secrets -n kube-system | grep bootstrap

# bootstrap-token-abcdef      bootstrap.kubernetes.io/token   6      1h

kubectl get secret bootstrap-token-abcdef -n kube-system -o yaml
# data:
#   token-id: <base64 "abcdef">
#   token-secret: <base64 "0123456789abcdef">
#   expiration: <base64 timestamp>
#   usage-bootstrap-authentication: <base64 "true">
#   usage-bootstrap-signing: <base64 "true">
#   auth-extra-groups: <base64 "system:bootstrappers:kubeadm:default-node-token">
# type: bootstrap.kubernetes.io/token
```

Secret name pattern: `bootstrap-token-<token-id>`. `<token-id>` is the first 6 chars of the token; `<token-secret>` is the 16 chars after the dot.

---

## Creating a token

```bash
# Generate a random token with 24-hour default TTL
kubeadm token create

# Or give it a specific TTL and print the full join command
kubeadm token create --ttl=2h --print-join-command
# kubeadm join k8s.example.com:6443 --token abcdef.0123456789abcdef \
#   --discovery-token-ca-cert-hash sha256:1a2b3c...

# Generate a random token suitable for bootstrap
kubeadm token generate
# prints a random 6.16 string for you to use elsewhere

# List existing tokens
kubeadm token list

# TOKEN                     TTL        EXPIRES                     USAGES                   DESCRIPTION
# abcdef.0123456789abcdef   23h45m     2026-04-25T15:00:00Z        authentication,signing   <none>
```

You can also create a non-expiring token:

```bash
kubeadm token create --ttl=0
```

Not recommended — a leaked token with no expiry is a persistent cluster credential. Always set a TTL.

### Deleting a token

```bash
kubeadm token delete abcdef
# (you can pass just the token-id, not the full string)
```

---

## What the token authenticates as

A request bearing a bootstrap token authenticates as:

```
Username: system:bootstrap:<token-id>
Groups:   system:bootstrappers:kubeadm:default-node-token
          system:bootstrappers
          system:authenticated
```

The `system:bootstrappers:kubeadm:default-node-token` group is bound (via pre-installed ClusterRoleBindings in the `kube-system` namespace) to permissions that let a bootstrapping node:

- Get kube-public `cluster-info` ConfigMap (for discovery).
- Create CSRs (CertificateSigningRequests) for itself.
- Request kubelet client certs.

That's it. A token holder can't deploy pods, read secrets, or do anything beyond joining. Limited blast radius even if leaked.

---

## Discovery — how the node verifies the apiserver

When you run `kubeadm join`, the node has no CA cert yet. It needs to contact the apiserver and trust what it says. Two mechanisms.

### Token-based discovery (default)

```bash
kubeadm join k8s.example.com:6443 \
  --token abcdef.0123456789abcdef \
  --discovery-token-ca-cert-hash sha256:1a2b3c...
```

Two hashes matter here:

1. **Token** (`abcdef.0123456789abcdef`) — authenticates the join request.
2. **CA cert hash** (`sha256:1a2b3c...`) — what the node uses to verify the apiserver's CA.

Flow:

```
 1. Node connects to apiserver at k8s.example.com:6443 over TLS.
 2. Apiserver presents its cert (signed by cluster CA).
 3. Node doesn't yet have the CA, so it can't verify — accepts the cert provisionally.
 4. Node requests `kube-public/cluster-info` ConfigMap:
      - This ConfigMap contains the cluster's CA cert (public part).
 5. Node computes SHA256 of the CA cert's Subject Public Key Info.
 6. Compares to --discovery-token-ca-cert-hash.
      - Match → trust established.
      - Mismatch → abort join.
 7. With CA now trusted, node re-verifies the apiserver's cert chain.
 8. Proceeds to CSR submission (with bootstrap token auth).
```

The CA hash is a **trust anchor**. It comes from out-of-band (the admin who ran `kubeadm init` writes it down). As long as the admin got the hash right, the join is secure against MITM attacks between the node and apiserver.

### Generating the hash

```bash
# From any CP node
openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt | \
  openssl rsa -pubin -outform DER 2>/dev/null | \
  openssl dgst -sha256 -hex | sed 's/^.* //'
```

Or, more conveniently:

```bash
kubeadm token create --print-join-command
# auto-includes the discovery-token-ca-cert-hash
```

### Alternate: `--discovery-file`

```bash
kubeadm join --discovery-file /path/to/kubeconfig
```

Provide a kubeconfig file directly (with the CA embedded and a valid token). The node uses it for discovery and auth. Useful for scripted joins in automation pipelines.

### Alternate: `--discovery-token-unsafe-skip-ca-verification`

```bash
kubeadm join k8s.example.com:6443 --token abcdef.0123456789abcdef \
  --discovery-token-unsafe-skip-ca-verification
```

Skips CA verification. Insecure — vulnerable to MITM between node and apiserver. Only for lab environments where you trust the network. Never in production.

---

## The CSR flow after bootstrap

Once discovery is done, the node's kubelet submits a CSR to the apiserver:

```
CSR content:
  CN: system:node:<nodename>
  O:  system:nodes
  signerName: kubernetes.io/kube-apiserver-client-kubelet
```

Observe:

```bash
# Watch CSRs as a node joins
kubectl get csr -A --watch

# NAME        AGE   SIGNERNAME                                    REQUESTOR                    REQUESTEDDURATION   CONDITION
# csr-abc     0s    kubernetes.io/kube-apiserver-client-kubelet   system:bootstrap:abcdef      <none>              Pending
# csr-abc     2s    kubernetes.io/kube-apiserver-client-kubelet   system:bootstrap:abcdef      <none>              Approved,Issued
```

Approval is automatic for the `kubernetes.io/kube-apiserver-client-kubelet` signer (via pre-installed ClusterRoleBindings `system:certificates.k8s.io:certificatesigningrequests:nodeclient`).

Kube-controller-manager then **signs** the approved CSR:

```
 Uses /etc/kubernetes/pki/ca.key to sign.
 Writes the signed cert back to CSR.status.certificate.
```

Kubelet fetches the approved CSR, extracts its new cert, stores it at `/var/lib/kubelet/pki/kubelet-client-current.pem`, and updates `/etc/kubernetes/kubelet.conf` to reference the symlink.

From here on, kubelet uses its real cert; the bootstrap token is unused.

---

## Auto-approval ClusterRoleBindings

Pre-installed CRBs that make the bootstrap flow work:

```bash
kubectl get clusterrolebinding | grep -i 'bootstrap\|node-bootstrap'
```

Key ones:

- `kubeadm:kubelet-bootstrap` — allows `system:bootstrappers` to create CSRs.
- `system:certificates.k8s.io:certificatesigningrequests:nodeclient` — auto-approves kubelet client CSRs from `system:node:*` users (renewal).
- `system:certificates.k8s.io:certificatesigningrequests:selfnodeclient` — auto-approves bootstrap-initiated kubelet CSRs.

Without these, you'd have to manually `kubectl certificate approve <csr>` for every joining node.

---

## Kubelet serving certs (separate flow)

The client cert flow (kubelet → apiserver) is auto-approved. The **serving cert** (apiserver → kubelet for `kubectl logs`, `exec`) is **not**.

If you enable:

```yaml
# /var/lib/kubelet/config.yaml
serverTLSBootstrap: true
```

Kubelet generates a serving cert CSR:

```
signerName: kubernetes.io/kubelet-serving
CN: system:node:<nodename>
O: system:nodes
SAN: <node-ip>, <node-hostname>
```

These are **not** auto-approved by default. They pile up as Pending:

```bash
kubectl get csr

# NAME       SIGNERNAME                      CONDITION
# csr-xyz    kubernetes.io/kubelet-serving   Pending
# csr-abc    kubernetes.io/kubelet-serving   Pending
```

Approve manually:

```bash
kubectl certificate approve <csr-name>
# Or approve all Pending:
kubectl get csr -o name | xargs kubectl certificate approve
```

Why not auto-approved? The apiserver can't automatically verify that the requested SAN (node IP) actually belongs to the node. An auto-approver would be a TOFU (trust on first use) decision.

Options for production:

- Manual approval (operator pain).
- Deploy a CSR approver controller (like [kubelet-csr-approver](https://github.com/postfinance/kubelet-csr-approver)) that checks node metadata.
- Disable serving TLS bootstrap and use a self-signed cert (less secure; warnings in logs).

---

## Pre-create bootstrap tokens with kubeadm config

At init time, you can pre-define tokens in the ClusterConfiguration:

```yaml
apiVersion: kubeadm.k8s.io/v1beta4
kind: InitConfiguration
bootstrapTokens:
- token: "abcdef.0123456789abcdef"
  description: "initial cluster bootstrap"
  ttl: "24h"
  usages:
  - signing
  - authentication
  groups:
  - system:bootstrappers:kubeadm:default-node-token
```

Or later, declaratively:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: bootstrap-token-abcdef
  namespace: kube-system
type: bootstrap.kubernetes.io/token
data:
  token-id: <base64 "abcdef">
  token-secret: <base64 "0123456789abcdef">
  expiration: <base64 "2026-12-31T23:59:59Z">
  usage-bootstrap-authentication: <base64 "true">
  usage-bootstrap-signing: <base64 "true">
  auth-extra-groups: <base64 "system:bootstrappers:kubeadm:default-node-token">
```

Apply, and now the token is in use.

---

## Token security implications

A valid bootstrap token lets anyone who has it:

- Join a node to the cluster (as a bootstrapping subject).
- Get the cluster CA cert.
- Submit a CSR for a `system:node:<name>` identity.

Since CSRs get auto-approved, a malicious actor could:

1. Get cluster CA.
2. Get a kubelet-grade client cert.
3. Authenticate as `system:node:<arbitrary-name>`.
4. Exploit the Node authorizer / rbac to read secrets, pod specs, etc. for that "node."

Mitigations:

- **Short TTLs** (hours, not days). Rotate tokens often.
- **Delete after use** — `kubeadm token delete <token-id>` after joining is complete.
- **Audit who uses tokens** — apiserver audit logs show which tokens authenticated what.
- **Don't commit tokens to version control** — treat them like passwords.

---

## The discovery ConfigMap

`cluster-info` in the `kube-public` namespace:

```bash
kubectl get cm cluster-info -n kube-public -o yaml

# apiVersion: v1
# kind: ConfigMap
# metadata:
#   name: cluster-info
#   namespace: kube-public
# data:
#   kubeconfig: |
#     apiVersion: v1
#     clusters:
#     - cluster:
#         certificate-authority-data: <base64 ca.crt>
#         server: https://k8s.example.com:6443
#       name: kubernetes
# ...
```

This ConfigMap is **readable without authentication** (via RBAC binding to `system:anonymous`). That's intentional — a node with just a token needs to fetch it before it has any credentials.

The CA cert inside is what the node hashes and compares to `--discovery-token-ca-cert-hash`.

### Signature check (legacy / optional)

In older setups, `cluster-info` was also signed. The Secret `bootstrap-token-xxx` carried a `token-signing-key` usage, and the ConfigMap had a signature annotation verified by the node. Modern clusters rely on the CA hash comparison; signature-based is deprecated but you may see annotations lingering.

---

## Expiration and renewal

Bootstrap tokens expire per their TTL. When they do:

- Any pending `kubeadm join` with that token fails.
- Existing nodes are unaffected (they already have their real certs).

To prevent "join fails because token expired":

- Create fresh tokens right before joining.
- `kubeadm token create --print-join-command` is idiomatic.

For kubelet client cert renewal (separate from bootstrap):

- Kubelet auto-rotates via CSR when `rotateCertificates: true` (kubeadm default).
- At ~80% of cert lifetime, kubelet requests a renewal. Auto-approved.

You rarely interact with this unless rotation is broken.

---

## Diagnostic commands

```bash
# List bootstrap tokens
kubeadm token list

# Delete a specific token
kubeadm token delete <token-id>

# Generate a fresh join command
kubeadm token create --print-join-command

# Regenerate CA hash manually
openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt | \
  openssl rsa -pubin -outform DER 2>/dev/null | \
  openssl dgst -sha256 -hex | sed 's/^.* //'

# Watch CSRs during joins
kubectl get csr --watch

# Approve pending CSRs manually
kubectl get csr -o name | xargs kubectl certificate approve

# cluster-info ConfigMap
kubectl get cm cluster-info -n kube-public -o yaml

# Audit which tokens were used (requires audit logging enabled)
# Look for user: system:bootstrap:*
```

---

## Common join-time failures

### `couldn't validate the identity of the API Server`

CA hash mismatch:

- Typo in `--discovery-token-ca-cert-hash`.
- Wrong cluster's endpoint.
- Node talking to a different cluster (DNS issue).

Regenerate the hash from a CP node.

### `couldn't find a match for current token`

Token expired or deleted. Create a new one.

### CSR stays Pending forever

Auto-approval CRBs missing or broken.

```bash
# Check auto-approval CRBs exist:
kubectl get clusterrolebinding | grep certificate

# Should see:
# kubeadm:node-autoapprove-bootstrap
# kubeadm:node-autoapprove-certificate-rotation
```

If missing (restored cluster from a broken backup, etc.), reapply via `kubeadm init phase bootstrap-token`.

### `error: failed to dial apiserver`

Network issue. Can the node reach `k8s.example.com:6443`?

```bash
# From the joining node
nc -zv k8s.example.com 6443
curl -k https://k8s.example.com:6443/healthz
```

Firewall, DNS, routing — troubleshoot like any network issue.

### Serving cert CSRs pile up

Kubelet is requesting serving certs (`serverTLSBootstrap: true`) but nothing auto-approves them.

```bash
kubectl get csr | grep kubelet-serving | grep Pending
```

Approve manually, or deploy an approver controller.

---

## Exam heuristics

- For "how do I join another node," `kubeadm token create --print-join-command` — it gives the complete command.
- Use short TTLs (`--ttl=1h`) in security-sensitive scenarios.
- For scripted join, generate the token, run `kubeadm join` on the new node, delete the token afterward.
- If CSRs are pending post-join, `kubectl certificate approve <csr>` manually.
- `cluster-info` is readable anonymously — that's by design for discovery.

## Mental traps

- Using `--discovery-token-unsafe-skip-ca-verification` in anything but a lab. Allows MITM.
- Reusing an old token. Revoke after single use.
- Forgetting that bootstrap tokens expire. Expired tokens give cryptic "couldn't find match" errors.
- Expecting kubelet-serving CSRs to auto-approve. They don't by default.
- Storing the bootstrap token in version control, docs, chat — it's a credential.
- Thinking `system:bootstrappers` group has cluster-wide access. It doesn't — only the specific CSR-creation permissions needed for join.
- Regenerating the CA but not telling pending joining nodes about the new hash. Their old `--discovery-token-ca-cert-hash` won't match anymore.
