## Workload identity, in one sentence

A **ServiceAccount** is a Kubernetes-native identity that pods use to authenticate to the apiserver. Its credential is a **JWT** signed by the apiserver, mounted into the pod automatically.

```
 Pod                                   Apiserver
   │                                       │
   │ HTTPS request                          │
   │ Header: Authorization: Bearer <jwt>    │
   ├──────────────────────────────────────►│
   │                                        │
   │                                        ├── Verify JWT signature using sa.pub
   │                                        ├── Extract user: system:serviceaccount:<ns>:<sa>
   │                                        ├── Extract groups: system:serviceaccounts:<ns>, system:serviceaccounts
   │                                        └── Authorize via RBAC
   │                                        │
   ◄────────────────────────────────────────┤
   │ Response                                │
```

Every pod has a SA — even if you didn't specify one. The pod's `serviceAccountName` defaults to `default`. Tokens are mounted under `/var/run/secrets/kubernetes.io/serviceaccount/`.

---

## What's in the SA token mount

```bash
ls /var/run/secrets/kubernetes.io/serviceaccount/
# ca.crt       — the cluster CA, for verifying apiserver
# namespace    — the namespace this SA belongs to
# token        — the JWT itself
```

In a pod:

```bash
cat /var/run/secrets/kubernetes.io/serviceaccount/token
# eyJhbGciOiJSUzI1NiIsImtpZCI6Inh4eCJ9.eyJhdWQiOlsia3ViZXJuZX...

# Decode (don't use in production — exposes token):
cat /var/run/secrets/kubernetes.io/serviceaccount/token | \
  cut -d. -f2 | base64 -d 2>/dev/null | jq
```

Decoded JWT body looks like:

```json
{
  "aud": ["https://kubernetes.default.svc.cluster.local"],
  "exp": 1735689600,
  "iat": 1735603200,
  "iss": "https://kubernetes.default.svc.cluster.local",
  "kubernetes.io": {
    "namespace": "default",
    "node": {
      "name": "worker-1",
      "uid": "abc-123"
    },
    "pod": {
      "name": "my-pod",
      "uid": "def-456"
    },
    "serviceaccount": {
      "name": "my-sa",
      "uid": "ghi-789"
    }
  },
  "nbf": 1735603200,
  "sub": "system:serviceaccount:default:my-sa"
}
```

Note: `aud`, `exp` (1-hour TTL by default), bound to the specific pod and node. This is the **TokenRequest** API output (modern path) — short-lived, audience-scoped, pod-bound.

---

## Creating a ServiceAccount

```bash
kubectl create serviceaccount my-sa -n dev
# OR
kubectl create sa my-sa -n dev      # short form
```

YAML form:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-sa
  namespace: dev
```

That's the whole spec. The SA itself is just an identity; you bind it to permissions via RBAC.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: my-sa-pod-reader
  namespace: dev
subjects:
- kind: ServiceAccount
  name: my-sa
  namespace: dev
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: pod-reader
```

---

## Pod uses a SA

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-pod
spec:
  serviceAccountName: my-sa
  containers:
  - name: app
    image: app:1.0
```

Without this field, the pod uses the namespace's `default` SA.

When the pod starts, kubelet:

1. Looks up the SA in this namespace.
2. Calls the **TokenRequest API** to mint a JWT (1-hour TTL by default, bound to the pod and audiences `[https://kubernetes.default.svc.cluster.local]`).
3. Mounts a **projected** volume with the token, ca.crt, and namespace files.
4. Container starts; app reads the token from disk and uses it for API calls.

Kubelet refreshes the token before expiry so it's always valid.

---

## The `default` ServiceAccount

Every namespace has a `default` SA, auto-created by the SA controller:

```bash
kubectl get sa -n dev
# NAME      SECRETS   AGE
# default   0         5m
# my-sa     0         3m
```

`SECRETS: 0` is the modern (1.24+) state — no static token Secret. Kubelet uses TokenRequest instead.

By default, `default` has zero RBAC bindings. Pods using it can't talk to apiserver beyond the basics (e.g. `kubectl auth can-i list pods --as=system:serviceaccount:default:default` returns "no").

If your pod doesn't need API access, this is correct behavior. Don't bind RBAC to `default` unless you actually want every pod in the namespace to inherit those permissions.

---

## Disabling automount

A pod that doesn't need to talk to the API can opt out of token mounting:

```yaml
apiVersion: v1
kind: Pod
spec:
  serviceAccountName: my-sa
  automountServiceAccountToken: false
  containers: [ ... ]
```

Or set on the SA itself (cascades to all pods using it):

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: no-api-access
automountServiceAccountToken: false
```

Pod-level field overrides SA-level. Best practice: disable mounting for workloads that don't need API access. Reduces attack surface.

---

## Legacy long-lived tokens (Secrets)

Pre-1.24 default: each SA had an auto-created `kubernetes.io/service-account-token` Secret with a never-expiring JWT.

```bash
kubectl get secrets -n dev
# my-sa-token-abc12   kubernetes.io/service-account-token   3      5d
```

These tokens never expired. If leaked, attacker has permanent SA-level access. Modern clusters disable auto-creation.

To deliberately create a long-lived token (when you really need one — external clients, CI/CD systems):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: my-sa-token
  namespace: dev
  annotations:
    kubernetes.io/service-account.name: my-sa
type: kubernetes.io/service-account-token
```

The token controller populates `data.token`, `data.ca.crt`, `data.namespace` after creation:

```bash
kubectl get secret my-sa-token -n dev -o jsonpath='{.data.token}' | base64 -d
# eyJhbGciOi...
```

Long-lived. Treat as a high-value secret. Rotate frequently.

---

## TokenRequest API — short-lived tokens

The modern way to get an SA token:

```bash
kubectl create token my-sa --duration=1h --audience=my-app -n dev

# eyJhbGciOi...
```

This calls the TokenRequest API, mints a 1-hour JWT bound to the audience `my-app`. The token is signed by the apiserver's `sa.key` and is verifiable by anyone with `sa.pub`.

Use cases:

- Generating tokens for external systems (e.g. CI/CD running outside the cluster).
- Cluster-bound auth flows (Vault Kubernetes auth method).
- Audience-scoped tokens for service mesh authorization.

The duration is bounded by the apiserver's `--service-account-max-token-expiration` (default 1 year). Beyond that, requests are clamped down.

---

## Image pull secrets

A SA can carry image-pull credentials:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-sa
  namespace: dev
imagePullSecrets:
- name: dockerhub-creds          # references a docker-registry Secret
- name: ghcr-creds
```

Now any pod using `my-sa` (and not specifying its own `imagePullSecrets`) inherits these.

This is the typical pattern: create a docker-registry Secret in the namespace, attach it to the relevant SA. Pods don't need to spell out the secret per pod.

```bash
kubectl create secret docker-registry dockerhub-creds \
  --docker-server=docker.io \
  --docker-username=alice \
  --docker-password=<password> \
  --docker-email=alice@example.com \
  -n dev

kubectl patch serviceaccount my-sa -n dev \
  -p '{"imagePullSecrets":[{"name":"dockerhub-creds"}]}'
```

For convenience, attach to the `default` SA so every pod in the namespace inherits.

---

## Cross-namespace SA access

A SA's identity is namespaced (`system:serviceaccount:<ns>:<name>`). To bind a SA to a Role in a different namespace, the binding goes in the **target** namespace and the subject specifies the SA's home namespace:

```yaml
# Target namespace `prod`
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: dev-sa-can-read-prod
  namespace: prod
subjects:
- kind: ServiceAccount
  name: my-sa
  namespace: dev               # SA's home namespace
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

Now a pod in `dev` using `my-sa` can read pods in `prod`.

For cluster-wide access, ClusterRoleBinding:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: my-sa-cluster-view
subjects:
- kind: ServiceAccount
  name: my-sa
  namespace: dev
roleRef:
  kind: ClusterRole
  name: view
  apiGroup: rbac.authorization.k8s.io
```

---

## How the apiserver verifies SA tokens

When a request arrives with a Bearer token:

1. Apiserver checks if the token is a JWT.
2. If yes, parses it as a JWT.
3. Verifies signature using `sa.pub`.
4. Validates `iss` (issuer must match `--service-account-issuer`).
5. Validates `aud` (audience must match what kubelet/token-request specified).
6. Validates `exp` (must not be expired).
7. If TokenRequest-bound: verifies the bound pod still exists.
8. Extracts `sub: system:serviceaccount:<ns>:<sa>`.
9. Constructs user info: username + groups (`system:serviceaccounts`, `system:serviceaccounts:<ns>`).
10. Hands off to authorization.

If any step fails: `Unauthorized`.

The bound-token feature (validating that the pod still exists) is what makes modern projected tokens **revoked-on-pod-delete** — kill the pod, the token immediately becomes invalid for new requests, even though it hasn't reached its `exp`.

---

## Listing SAs and their bindings

```bash
# All SAs in a namespace
kubectl get sa -n dev

# What does this SA have access to?
kubectl auth can-i --list --as=system:serviceaccount:dev:my-sa

# All bindings referring to this SA
kubectl get rolebinding,clusterrolebinding -A -o json | \
  jq -r --arg sa my-sa --arg ns dev '
    .items[] | select(.subjects[]? | .kind=="ServiceAccount" and .name==$sa and .namespace==$ns) |
    [.kind, .metadata.namespace // "<cluster>", .metadata.name, .roleRef.kind, .roleRef.name] | @tsv'
```

The `auth can-i --list` is the most direct way to see what a SA can actually do.

---

## Common SA mistakes

### Granting permissions to `default` SA

```yaml
subjects:
- kind: ServiceAccount
  name: default
  namespace: dev
```

Now every pod in `dev` (without specifying SA) inherits the binding. Hard to track. Always create dedicated SAs and bind to those.

### Forgetting `imagePullSecrets`

Pods can't pull images:

```
Failed to pull image: unauthorized
```

Add the docker-registry Secret + reference it on the SA (or the pod).

### Hardcoding tokens

```yaml
env:
- name: API_TOKEN
  value: eyJhbGciOi...
```

Don't. Use `valueFrom: secretKeyRef:` for tokens that need to live somewhere, or rely on the projected SA token mount.

### Trusting tokens from outside the cluster

If you receive a "Kubernetes SA token" from elsewhere, validating it requires the issuing cluster's `sa.pub`. Don't assume tokens are from your cluster — verify the issuer.

For inter-cluster trust, use OIDC-style federation, not raw SA tokens.

---

## ServiceAccount in HA clusters

Every CP node must have the **same** `sa.key` and `sa.pub`. Tokens minted on CP-1 are validated on CP-2, CP-3, etc. — they need the matching public key.

If you're adding a CP node manually (not via `kubeadm join --upload-certs`), you must copy `sa.key` and `sa.pub` from an existing CP node. Otherwise the new node's apiserver mints tokens with a different key, and validation breaks intermittently (depending on which apiserver handles each request).

`kubeadm join --control-plane --certificate-key` handles this correctly.

---

## Real example: an operator pod

```yaml
---
# 1. ServiceAccount
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-operator
  namespace: my-operator-system

---
# 2. ClusterRole defining permissions
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: my-operator
rules:
- apiGroups: ["example.com"]
  resources: ["myresources", "myresources/status"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["pods", "configmaps", "events"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["coordination.k8s.io"]
  resources: ["leases"]              # for leader election
  verbs: ["get", "create", "update", "patch"]

---
# 3. Bind the ClusterRole to the SA
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: my-operator
subjects:
- kind: ServiceAccount
  name: my-operator
  namespace: my-operator-system
roleRef:
  kind: ClusterRole
  name: my-operator
  apiGroup: rbac.authorization.k8s.io

---
# 4. Deployment using the SA
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-operator
  namespace: my-operator-system
spec:
  replicas: 2                          # leader-elect with Lease
  selector: { matchLabels: { app: my-operator } }
  template:
    metadata: { labels: { app: my-operator } }
    spec:
      serviceAccountName: my-operator
      containers:
      - name: operator
        image: my-operator:1.0
```

This is the template for any controller / operator: SA → ClusterRole → ClusterRoleBinding → Deployment with `serviceAccountName`.

---

## Exam heuristics

- For "create a SA and give it pod-reader access," it's three objects: SA, Role, RoleBinding.
- `kubectl create sa <name>` then `kubectl create rolebinding ... --serviceaccount=<ns>:<name>`.
- Use `kubectl auth can-i ... --as=system:serviceaccount:<ns>:<name>` to verify.
- For pulling images from a private registry, attach the docker-registry Secret to the SA's `imagePullSecrets`.
- Disable automount (`automountServiceAccountToken: false`) for workloads that don't need API access.

## Mental traps

- Granting permissions to `default` SA. All pods in the namespace inherit silently.
- Storing SA tokens as files on disk outside the pod. Use the mounted projected volume.
- Forgetting that SA tokens are namespace-scoped — `system:serviceaccount:<ns>:<name>`.
- Confusing `service-account-token` Secrets with TokenRequest tokens. The first is legacy long-lived; the second is short-lived projected.
- Trusting that auto-mounted tokens don't expire. They auto-rotate but a stale on-disk copy from before kubelet's last refresh might be old (unlikely but possible).
- Manually creating Secrets to "issue" SA tokens. Prefer TokenRequest.
- Forgetting to copy `sa.key`/`sa.pub` to a new CP node. Random verification failures.
