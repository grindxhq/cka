## What a kubeconfig actually is

A **kubeconfig** is a YAML file that packages three things a client needs to talk to an apiserver:

1. **Cluster** — the apiserver's URL + how to trust it (CA cert).
2. **User** — the client's identity (cert, token, exec plugin, etc.).
3. **Context** — the binding: "this cluster, this user, this default namespace."

A single kubeconfig file can contain many of each, letting you switch between clusters/identities with one command.

```yaml
apiVersion: v1
kind: Config

clusters:
- name: cluster-a
  cluster:
    server: https://k8s.example.com:6443
    certificate-authority-data: <base64 CA cert>
- name: cluster-b
  cluster:
    server: https://lab.example.com:6443
    insecure-skip-tls-verify: true          # don't do this in production

users:
- name: alice
  user:
    client-certificate-data: <base64 cert>
    client-key-data: <base64 key>
- name: prod-admin
  user:
    token: <bearer token>
- name: eks-auth
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: [ "eks", "get-token", "--cluster-name", "my-cluster" ]

contexts:
- name: alice@cluster-a
  context:
    cluster: cluster-a
    user: alice
    namespace: default
- name: admin@cluster-b
  context:
    cluster: cluster-b
    user: prod-admin
    namespace: kube-system

current-context: alice@cluster-a
```

kubectl reads this, picks the `current-context`, resolves to a (cluster, user) pair, and connects.

---

## Where kubectl looks for kubeconfigs

In order (first-wins):

1. **`--kubeconfig=<file>`** flag.
2. **`$KUBECONFIG`** env var (colon-separated list of paths; they merge).
3. **`~/.kube/config`** (default path).

`$KUBECONFIG` is useful for having multiple files that logically compose:

```bash
export KUBECONFIG=~/.kube/config:~/.kube/dev.kubeconfig:~/.kube/prod.kubeconfig
kubectl config get-contexts
# CURRENT   NAME                CLUSTER         AUTHINFO          NAMESPACE
# *         alice@dev-cluster   dev-cluster     alice             default
#           alice@prod-cluster  prod-cluster    alice             default
#           admin@local         local           admin             kube-system
```

All three files' clusters/users/contexts are visible.

---

## The kubeadm-generated kubeconfigs

Kubeadm creates five kubeconfigs at init:

| File                      | User                                            | Group                         | Purpose                         |
|---------------------------|-------------------------------------------------|-------------------------------|---------------------------------|
| `admin.conf`              | `kubernetes-admin`                              | `kubeadm:cluster-admins`       | Human operator's main kubeconfig |
| `super-admin.conf`        | `kubernetes-super-admin`                        | `system:masters`               | Break-glass (bypasses RBAC)     |
| `kubelet.conf`            | `system:node:<nodename>`                        | `system:nodes`                 | kubelet → apiserver             |
| `controller-manager.conf` | `system:kube-controller-manager`                | —                              | kube-controller-manager         |
| `scheduler.conf`          | `system:kube-scheduler`                         | —                              | kube-scheduler                  |

Each file has an embedded client cert with the subject matching the user. The apiserver accepts these certs (Kubernetes CA signed them), extracts user/group, and applies RBAC.

### `admin.conf` vs `super-admin.conf`

Both look like admin kubeconfigs. The difference:

- **`admin.conf`** — subject `CN=kubernetes-admin, O=kubeadm:cluster-admins`. Group is bound to the `cluster-admin` ClusterRole via a standard ClusterRoleBinding. RBAC applies (visible in audit logs, can be revoked by removing the binding).
- **`super-admin.conf`** — subject `CN=kubernetes-super-admin, O=system:masters`. Group `system:masters` short-circuits RBAC in the apiserver code itself. Literally cannot be restricted.

Use `admin.conf` as the everyday operator kubeconfig. Reserve `super-admin.conf` for "the cluster is broken and I need to bypass everything."

Older kubeadm versions didn't separate these; `admin.conf` had `system:masters`. Security posture improved in 1.29+.

---

## Copying admin.conf for personal use

Standard post-init ritual:

```bash
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

Now `kubectl` works for your user. The client cert inside is valid for 1 year; renew via `kubeadm certs renew admin.conf`.

---

## Kubeconfig anatomy — the fields

### `clusters[]`

```yaml
clusters:
- name: cluster-a
  cluster:
    server: https://k8s.example.com:6443            # apiserver URL
    certificate-authority: /path/to/ca.crt           # OR:
    certificate-authority-data: <base64 of ca.crt>   # embedded
    insecure-skip-tls-verify: false                  # skip TLS validation (never true in prod)
    tls-server-name: alt-name                         # override SNI (rarely needed)
    proxy-url: https://proxy.example.com:8080        # route through HTTPS proxy (1.24+)
```

### `users[]`

Many authentication types:

```yaml
users:
# Client certificate
- name: alice
  user:
    client-certificate: /path/to/cert
    client-key: /path/to/key
    # OR embedded:
    client-certificate-data: <base64>
    client-key-data: <base64>

# Bearer token
- name: bob
  user:
    token: eyJhbGciOi...

# Token file (re-read per request)
- name: carol
  user:
    tokenFile: /path/to/token

# Basic auth (deprecated, avoid)
- name: dave
  user:
    username: dave
    password: secret

# Exec plugin (most common for cloud-managed clusters)
- name: eks-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: [ "eks", "get-token", "--cluster-name", "my-cluster" ]
      env:
      - name: AWS_PROFILE
        value: prod
```

Exec plugins are how `aws`, `gcloud`, `az`, `oidc-login`, and similar tools provide short-lived credentials. kubectl runs the command, gets a token in structured JSON output, uses it for the request.

### `contexts[]`

```yaml
contexts:
- name: alice@cluster-a
  context:
    cluster: cluster-a           # name from clusters[]
    user: alice                  # name from users[]
    namespace: default           # default namespace for this context
```

Contexts are the **glue**. A context name is arbitrary; convention is `user@cluster` or `env-purpose`.

### `current-context`

```yaml
current-context: alice@cluster-a
```

kubectl's default when no `--context` flag is provided.

---

## Managing contexts with kubectl

```bash
# List
kubectl config get-contexts

# Switch
kubectl config use-context alice@prod

# Show current
kubectl config current-context

# Show entire kubeconfig (resolved, merged)
kubectl config view

# Show raw (for current-context determination)
kubectl config view --raw

# Show a specific field
kubectl config view -o jsonpath='{.current-context}'

# Set default namespace for current context
kubectl config set-context --current --namespace=kube-system

# Change server URL for a cluster
kubectl config set-cluster cluster-a --server=https://new.example.com:6443

# Delete a context
kubectl config delete-context old-context

# Delete a user
kubectl config delete-user old-user

# Delete a cluster
kubectl config delete-cluster old-cluster
```

---

## Building a kubeconfig from scratch

For a new user:

```bash
# 1. Generate a client cert signed by the cluster CA
#    First, create a CSR + key:
openssl genrsa -out alice.key 2048
openssl req -new -key alice.key -out alice.csr \
  -subj "/CN=alice/O=devops-team"

#    Sign with the cluster CA (on a CP node):
sudo openssl x509 -req -in alice.csr \
  -CA /etc/kubernetes/pki/ca.crt \
  -CAkey /etc/kubernetes/pki/ca.key \
  -CAcreateserial \
  -out alice.crt -days 365

# 2. Build a kubeconfig:
kubectl config --kubeconfig=alice.kubeconfig set-cluster my-cluster \
  --server=https://k8s.example.com:6443 \
  --certificate-authority=/etc/kubernetes/pki/ca.crt \
  --embed-certs=true

kubectl config --kubeconfig=alice.kubeconfig set-credentials alice \
  --client-certificate=alice.crt \
  --client-key=alice.key \
  --embed-certs=true

kubectl config --kubeconfig=alice.kubeconfig set-context alice@my-cluster \
  --cluster=my-cluster \
  --user=alice \
  --namespace=default

kubectl config --kubeconfig=alice.kubeconfig use-context alice@my-cluster

# 3. Test
KUBECONFIG=alice.kubeconfig kubectl auth whoami
# Name: alice
# Groups: [devops-team system:authenticated]
```

Alice now authenticates as `alice` in group `devops-team`. Bind RBAC to her / her group as needed.

### Alternative: use the CSR API

Instead of signing locally:

```bash
# Create a CSR in the cluster
cat <<EOF | kubectl apply -f -
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: alice-csr
spec:
  request: $(cat alice.csr | base64 -w0)
  signerName: kubernetes.io/kube-apiserver-client
  expirationSeconds: 31536000                         # 1 year
  usages:
  - client auth
EOF

# Approve the CSR (as admin)
kubectl certificate approve alice-csr

# Fetch the signed cert
kubectl get csr alice-csr -o jsonpath='{.status.certificate}' | base64 -d > alice.crt

# Now build the kubeconfig as above.
```

The controller-manager signs the CSR using the same ca.key, producing an equivalent cert. Cleaner than local signing; avoids needing SSH to a CP node.

---

## Exec plugin pattern

For cloud-managed clusters, the kubeconfig typically uses an exec plugin:

```yaml
users:
- name: eks-cluster
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args:
      - "eks"
      - "get-token"
      - "--cluster-name"
      - "my-cluster"
      - "--region"
      - "us-east-1"
      env:
      - name: AWS_PROFILE
        value: default
      provideClusterInfo: false
      interactiveMode: IfAvailable
```

When kubectl needs to authenticate, it runs `aws eks get-token ...`, which returns JSON with a short-lived token. kubectl uses that token for the API call.

Benefits:

- No long-lived credentials in the kubeconfig.
- Tokens auto-refresh per call.
- Cluster access tied to cloud IAM rather than static certs.

Same pattern for:

- **GKE**: `gke-gcloud-auth-plugin`.
- **AKS**: `kubelogin` or `az aks get-credentials`.
- **OIDC**: `oidc-login` via kubelogin plugin.
- **HashiCorp Vault**: `vault-kube-plugin` for JWT/OIDC login.

---

## Merging kubeconfigs

Combine multiple files:

```bash
KUBECONFIG=file1:file2:file3 kubectl config view --flatten > merged-kubeconfig
```

`--flatten` inlines cert data from referenced files into the output. The result is a single self-contained kubeconfig.

Useful when onboarding a teammate to multiple clusters — send them one merged file.

---

## Working with namespaces in contexts

Changing default namespace:

```bash
kubectl config set-context --current --namespace=dev

# Now every kubectl (without -n) acts in dev.
```

For many-context setups, tools like `kubectx` / `kubens` provide faster switching:

```bash
kubectx prod               # switch to prod context
kubens kube-system          # set namespace to kube-system
kubectx -                   # switch back to previous
```

Not standard kubectl, but commonly installed.

---

## `--as`, `--as-group` — impersonation

If your credentials allow impersonation (via RBAC), test other identities without switching kubeconfigs:

```bash
kubectl auth can-i list pods --as=alice
kubectl get pods --as=alice --as-group=devops-team -n dev

# Service account impersonation
kubectl auth can-i get secrets --as=system:serviceaccount:default:my-sa
```

Requires the `impersonate` verb on the relevant resources. See api-server → authn-authz-admission deck.

---

## Common kubeconfig mistakes

### `certificate-authority-data` pointing at the wrong CA

```
Unable to connect to the server: x509: certificate signed by unknown authority
```

Fix: ensure `certificate-authority-data` in the kubeconfig matches `/etc/kubernetes/pki/ca.crt` on the CP node.

```bash
# Extract from kubeconfig
kubectl config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | \
  base64 -d > /tmp/kubeconfig-ca.crt

diff /tmp/kubeconfig-ca.crt /etc/kubernetes/pki/ca.crt
# Should be empty if matching.
```

### Expired client cert

```
Unable to connect to the server: error: You must be logged in to the server (Unauthorized)
```

Client cert expired. Check:

```bash
kubectl config view --raw -o jsonpath='{.users[0].user.client-certificate-data}' | \
  base64 -d | openssl x509 -noout -dates
```

Renew via `kubeadm certs renew admin.conf` (for admin.conf) or re-issue the cert.

### `server:` URL points at the wrong IP

```
Unable to connect to the server: dial tcp <old-ip>:6443: i/o timeout
```

CP IP changed but kubeconfig wasn't updated. Fix `server:` field, or use `kubectl config set-cluster <name> --server=<new>`.

### `insecure-skip-tls-verify: true` in production

Works but dangerous — no MITM protection. Always fix the CA properly for real clusters.

### Multiple contexts, wrong one active

```bash
kubectl get pods
# Working against prod when you thought you were in dev!
```

Always verify:

```bash
kubectl config current-context
```

Or include the cluster name in your shell prompt via something like [starship](https://starship.rs) or [kube-ps1](https://github.com/jonmosco/kube-ps1).

---

## Kubeconfig security

Credentials in kubeconfigs include:

- Client certs + private keys.
- Bearer tokens.
- Exec plugin configs (which may reference credentials).

Treat kubeconfigs as secrets:

- File permissions: 600 for personal kubeconfigs.
- Don't commit to public repos.
- Don't paste into chat/email.
- Prefer exec plugins with short-lived creds over static tokens.
- Rotate client certs annually (matches default 1-year lifetime).

---

## Diagnostic commands

```bash
# Who am I?
kubectl auth whoami
# ATTRIBUTE   VALUE
# Name        kubernetes-admin
# Groups      [kubeadm:cluster-admins system:authenticated]

# What context is active?
kubectl config current-context

# What cluster is that context pointing at?
kubectl config view --minify

# Extract and inspect the client cert
kubectl config view --raw -o jsonpath='{.users[?(@.name=="alice")].user.client-certificate-data}' | \
  base64 -d | openssl x509 -noout -text

# Verify connectivity + auth in one shot
kubectl get --raw /api              # should return API versions if auth works
kubectl get --raw /healthz          # apiserver health; works even without cert auth if CA matches
```

---

## Exam heuristics

- The default kubeconfig is `~/.kube/config`. Exam labs usually set up `/etc/kubernetes/admin.conf` to be copied here.
- `kubectl config` subcommands are your go-to for context / cluster / user management.
- Building a kubeconfig from scratch: `set-cluster`, `set-credentials`, `set-context`, `use-context`.
- For a user cert, CSR signing via the CertificateSigningRequest API is cleaner than local openssl signing.
- `kubectl auth whoami` verifies the authenticated identity.

## Mental traps

- Editing `~/.kube/config` directly is fine for quick fixes but risky — `kubectl config` commands are safer.
- Copying `admin.conf` to non-trusted hosts. It's `cluster-admin`.
- Using `super-admin.conf` when `admin.conf` would suffice. Save super-admin for emergencies.
- Leaving `insecure-skip-tls-verify: true` in production kubeconfigs.
- Pointing `certificate-authority-data` at the wrong CA (e.g. etcd CA for the Kubernetes cluster).
- Forgetting that client certs in kubeconfigs expire annually — renew before they do.
- Mixing client-certificate / client-key files with client-certificate-data / client-key-data. Use one or the other.
