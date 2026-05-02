## Why contexts exist

A context is a **named binding of cluster + user + namespace**. Switch contexts → kubectl talks to a different cluster, as a different identity, in a different default namespace, all in one move.

```yaml
apiVersion: v1
kind: Config

clusters:
- name: dev-cluster
  cluster:
    server: https://dev.example.com:6443
    certificate-authority-data: <base64>
- name: prod-cluster
  cluster:
    server: https://prod.example.com:6443
    certificate-authority-data: <base64>

users:
- name: alice-dev
  user:
    client-certificate-data: <base64>
    client-key-data: <base64>
- name: alice-prod
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: ["eks", "get-token", "--cluster-name", "prod"]

contexts:
- name: dev
  context:
    cluster: dev-cluster
    user: alice-dev
    namespace: default
- name: prod-app
  context:
    cluster: prod-cluster
    user: alice-prod
    namespace: app

current-context: dev
```

Switching contexts:

```bash
kubectl config use-context prod-app
```

All subsequent kubectl commands use `prod-cluster`, identity `alice-prod`, default namespace `app`.

---

## Where kubectl looks for config

In order, first non-empty wins:

1. `--kubeconfig=<file>` flag.
2. `KUBECONFIG` env var (colon-separated list — files are merged).
3. `~/.kube/config` (default).

Merging: KUBECONFIG=file1:file2:file3 means "use all three." Clusters from each appear together; same for users and contexts. Names must be unique across files (collisions are resolved by file order — first wins).

```bash
export KUBECONFIG=~/.kube/config:~/.kube/dev.kubeconfig:~/.kube/prod.kubeconfig
kubectl config get-contexts

# CURRENT   NAME       CLUSTER          AUTHINFO     NAMESPACE
# *         dev        dev-cluster      alice-dev    default
#           prod-app   prod-cluster     alice-prod   app
#           legacy     old-cluster      legacy-user  kube-system
```

Useful for working with multiple clusters from one shell.

---

## Inspecting your kubeconfig

```bash
# All contexts
kubectl config get-contexts

# Current context name
kubectl config current-context

# View merged config (resolved across all KUBECONFIG files)
kubectl config view

# View raw (no redaction of cert/key data)
kubectl config view --raw

# Just the active context's bits (useful for scripts)
kubectl config view --minify

# A specific field
kubectl config view -o jsonpath='{.current-context}'
kubectl config view --minify -o jsonpath='{.contexts[0].context.namespace}'
```

`view` redacts sensitive data by default (showing `DATA+OMITTED`). `--raw` shows everything (treat output as a secret).

---

## Switching contexts

```bash
# Switch
kubectl config use-context prod-app

# Verify
kubectl config current-context
```

To set the namespace for the current context (without switching contexts):

```bash
kubectl config set-context --current --namespace=kube-system

# Now `kubectl get pods` defaults to kube-system in this context.
```

This persists in the kubeconfig — every kubectl call uses the new namespace until you change it.

---

## Building a context from scratch

Three commands:

```bash
# 1. Define the cluster
kubectl config set-cluster my-cluster \
  --server=https://k8s.example.com:6443 \
  --certificate-authority=/etc/kubernetes/pki/ca.crt \
  --embed-certs=true

# 2. Define the user
kubectl config set-credentials alice \
  --client-certificate=alice.crt \
  --client-key=alice.key \
  --embed-certs=true

# 3. Define the context
kubectl config set-context alice@my-cluster \
  --cluster=my-cluster \
  --user=alice \
  --namespace=dev

# 4. Activate
kubectl config use-context alice@my-cluster
```

`--embed-certs=true` inlines the cert files as base64 in the kubeconfig. Useful for portable kubeconfigs (no external file dependencies).

To target a specific kubeconfig file:

```bash
kubectl --kubeconfig=alice.kubeconfig config set-cluster ...
```

---

## Token-based credentials

For SAs or external auth:

```bash
# Bearer token
kubectl config set-credentials my-sa --token=<jwt-token>

# Token file (re-read per request — useful if the token rotates)
kubectl config set-credentials my-sa --token-file=/tmp/token

# Username + password (legacy basic auth; avoid)
kubectl config set-credentials user --username=foo --password=bar
```

Tokens for SAs:

```bash
TOKEN=$(kubectl create token my-sa -n dev --duration=24h)
kubectl config set-credentials my-sa --token=$TOKEN
```

Now kubectl uses the SA token. Useful for testing what a SA can do without leaving your shell.

---

## Exec plugin auth

For cloud-managed clusters:

```yaml
users:
- name: eks-prod
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args:
      - eks
      - get-token
      - --cluster-name
      - prod
      - --region
      - us-east-1
      env:
      - name: AWS_PROFILE
        value: prod
      provideClusterInfo: false
      interactiveMode: IfAvailable
```

kubectl runs `aws eks get-token ...` whenever it needs a token. Output is parsed as `ExecCredential` JSON.

For OIDC-style auth: `oidc-login` plugin (via kubelogin), or `kubectl plugin oidc-login` if installed.

---

## Working across many contexts

For ops engineers managing many clusters:

### `kubectx` / `kubens`

External tools (Krew plugins or standalone):

```bash
# Switch context
kubectx prod
kubectx -                # previous context

# Switch namespace within context
kubens kube-system
kubens -                 # previous namespace
```

Faster than `kubectl config use-context`. Highly recommended for daily use.

### Per-shell context

```bash
# Open a shell with a specific context
KUBECONFIG=~/.kube/prod.kubeconfig zsh
```

The new shell has its own KUBECONFIG. Kubectl in this shell talks only to prod. Other shells unaffected.

### Per-command context

```bash
# Without switching
kubectl --context=prod get pods -n app

# Or use a specific kubeconfig
kubectl --kubeconfig=/tmp/prod.kubeconfig get pods
```

Useful in scripts. No state pollution.

### Visual indicator

Show the current context in your shell prompt. Tools:

- [kube-ps1](https://github.com/jonmosco/kube-ps1) — Bash/Zsh prompt segment.
- [starship](https://starship.rs) — has a built-in Kubernetes module.

```
$ kubectl get pods                    [⎈ |prod-app:app]   ← prompt shows context:namespace
```

Saves accidents. Knowing you're in `prod-app` before running `kubectl delete deploy` is valuable.

---

## Setting default namespace per context

```bash
kubectl config set-context --current --namespace=app
```

Now `kubectl get pods` shows pods in `app` for this context. Switch context, default namespace changes too (each context has its own default).

For one-off runs in a different namespace:

```bash
kubectl get pods -n other-namespace
```

`-n` overrides for that single command.

---

## Removing entries

```bash
kubectl config delete-context dev-old
kubectl config delete-cluster dev-old-cluster
kubectl config delete-user dev-old-user
```

Cleans up unused entries. Useful when retiring a cluster — remove from kubeconfig.

---

## Common kubeconfig mistakes

### Wrong cluster after switching

You meant `kubectl config use-context dev` but typed `kubectl config use-context prod`. Now you're operating in production.

Mitigations:

- Display current context in shell prompt.
- Use distinct kubeconfigs per environment + KUBECONFIG env var when entering a shell for that env.
- For destructive operations, always `kubectl config current-context` first to confirm.

### Cluster's CA changed but kubeconfig wasn't updated

```
Unable to connect to the server: x509: certificate signed by unknown authority
```

Cluster CA was rotated; kubeconfig has old CA cert.

```bash
# Extract and compare
kubectl config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | \
  base64 -d > /tmp/client-ca.pem
diff /tmp/client-ca.pem /etc/kubernetes/pki/ca.crt   # should be empty
```

Re-sync via `kubectl config set-cluster` with the new CA file, or copy a fresh kubeconfig.

### Forgot to set namespace

You set up a context but didn't specify a namespace. kubectl defaults to `default`.

```bash
kubectl config get-contexts | awk '/^\*/ {print $5}'   # current namespace, "" if unset
```

If empty: `kubectl config set-context --current --namespace=<ns>`.

### KUBECONFIG paths with spaces

```bash
export KUBECONFIG="$HOME/.kube/config:$HOME/Documents/k8s configs/prod.yaml"   # space in path
```

Some shells handle this; others split on the space inside the path. Quote consistently and avoid spaces in paths.

### Confusing kubeconfig with cluster

Kubeconfig is a **client file**. The cluster doesn't know about your kubeconfig. Edits to the kubeconfig only affect what kubectl/clients do; they don't change apiserver state.

---

## Useful one-liners

```bash
# Show current cluster URL
kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.server}'

# Show current user
kubectl config view --minify --raw -o jsonpath='{.users[0].name}'

# Switch to default namespace fast
kubectl config set-context --current --namespace=default

# Quick context summary
kubectl config get-contexts
# CURRENT   NAME    CLUSTER       AUTHINFO       NAMESPACE
# *         dev     dev-cluster   alice-dev      default
#           prod    prod-cluster  alice-prod     app

# What identity am I right now?
kubectl auth whoami
```

---

## Sharing kubeconfigs

For onboarding a new operator:

```bash
# Combine multiple kubeconfigs into one self-contained file
KUBECONFIG=~/.kube/dev.kubeconfig:~/.kube/prod.kubeconfig \
  kubectl config view --flatten > onboarding.kubeconfig

# Send onboarding.kubeconfig to the new operator (over a secure channel — it's a credential file).
```

`--flatten` inlines the certs/keys/data referenced by file paths, producing a portable single file.

---

## Generating a SA-based kubeconfig

For programmatic / CI access, generate a kubeconfig backed by a SA token:

```bash
# Pre-req: SA exists with appropriate RBAC
SA=ci-deployer
NS=ci

# Get a long-lived token (Secret of type service-account-token)
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: ${SA}-token
  namespace: ${NS}
  annotations:
    kubernetes.io/service-account.name: ${SA}
type: kubernetes.io/service-account-token
EOF

# Wait a moment for the token to be populated
sleep 3

TOKEN=$(kubectl get secret ${SA}-token -n ${NS} -o jsonpath='{.data.token}' | base64 -d)
CA_DATA=$(kubectl get secret ${SA}-token -n ${NS} -o jsonpath='{.data.ca\.crt}')
SERVER=$(kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.server}')

# Build the kubeconfig
cat > ${SA}.kubeconfig <<EOF
apiVersion: v1
kind: Config
clusters:
- name: cluster
  cluster:
    server: ${SERVER}
    certificate-authority-data: ${CA_DATA}
users:
- name: ${SA}
  user:
    token: ${TOKEN}
contexts:
- name: ${SA}@cluster
  context:
    cluster: cluster
    user: ${SA}
    namespace: ${NS}
current-context: ${SA}@cluster
EOF

# Test
KUBECONFIG=${SA}.kubeconfig kubectl auth whoami
# Username: system:serviceaccount:ci:ci-deployer
```

Better practice: use TokenRequest for short-lived tokens, but for CI systems running for long periods, a Secret-backed token may be acceptable.

---

## Exam heuristics

- For "switch to context X," `kubectl config use-context X`.
- For "set default namespace to Y," `kubectl config set-context --current --namespace=Y`.
- `kubectl config get-contexts` shows you all contexts at a glance.
- Use `--context` flag on individual commands to avoid switching kubeconfig state.
- `KUBECONFIG=file1:file2 kubectl ...` to merge multiple files temporarily.

## Mental traps

- Editing the kubeconfig YAML by hand and breaking the structure. Use `kubectl config` subcommands.
- Forgetting that kubeconfig is local. Edits don't propagate to the cluster.
- Two contexts pointing at the same cluster with different default namespaces — easy to accidentally switch.
- Sharing a kubeconfig with embedded admin client cert. It's `cluster-admin`. Treat as secret.
- Using `kubectl config use-context` mid-script and forgetting to restore. Other shells running concurrently get confused.
- Skipping `kubectl auth whoami` when something feels wrong. It's a 1-second sanity check.
- KUBECONFIG colon-separated lists with absolute paths fine, but per-shell variations cause "where did my context go?" confusion across terminals.
