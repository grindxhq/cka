## The request pipeline in one picture

Every request that hits `kube-apiserver` walks this pipeline in order. If any stage rejects, the request dies there.

```
 client (kubectl / controller / webhook / pod)
                    │  HTTPS
                    ▼
 ┌──────────────────────────────────────────────────┐
 │  TLS termination + HTTP parse                    │
 └──────────────────────────────────────────────────┘
                    │
                    ▼
 ┌──────────────────────────────────────────────────┐
 │  Authentication  — who are you?                  │
 │    (plugins run in order, first success wins)    │
 │    Output: user, groups, UID, extra              │
 │    Fallback: system:anonymous / system:unauth    │
 └──────────────────────────────────────────────────┘
                    │
                    ▼
 ┌──────────────────────────────────────────────────┐
 │  Authorization  — may you do it?                 │
 │    (modes evaluated in order, first decisive win)│
 │    Output: Allow / Deny / NoOpinion              │
 └──────────────────────────────────────────────────┘
                    │
                    ▼  (only for write verbs: create/update/patch/delete)
 ┌──────────────────────────────────────────────────┐
 │  Mutating admission                              │
 │    built-ins + MutatingWebhookConfiguration      │
 │    can modify the object                          │
 └──────────────────────────────────────────────────┘
                    │
                    ▼
 ┌──────────────────────────────────────────────────┐
 │  Schema validation + defaulting                  │
 └──────────────────────────────────────────────────┘
                    │
                    ▼
 ┌──────────────────────────────────────────────────┐
 │  Validating admission                            │
 │    built-ins + ValidatingWebhookConfiguration    │
 │    + ValidatingAdmissionPolicy (CEL)             │
 │    can only reject                                │
 └──────────────────────────────────────────────────┘
                    │
                    ▼
 ┌──────────────────────────────────────────────────┐
 │  Persist to etcd                                 │
 └──────────────────────────────────────────────────┘
```

Two things are worth internalizing up front:

- **Read verbs skip admission**. `get`, `list`, `watch` never go through the mutating/validating stages. Admission only sees mutations and deletes.
- **Authentication does not care about permissions**. It only assigns an identity. Authorization is where "may you" is decided. Losing track of this distinction is the #1 source of confusion when debugging 403s.

---

## Part 1 — Authentication

### What it produces

A successful authenticator emits a user record with four fields:

| Field     | Example                                         | Used by                  |
|-----------|-------------------------------------------------|--------------------------|
| username  | `alice@example.com`, `system:node:worker-1`     | RBAC subject             |
| groups    | `[developers, system:authenticated]`            | RBAC subject, Node authz |
| uid       | stable unique ID (optional)                     | Audit logging            |
| extra     | map&lt;string,[]string&gt; (e.g. OIDC claims)   | Webhook authorizers, audit |

Every request is attributed to **someone**. If no authenticator succeeds and anonymous auth is enabled, the request gets username `system:anonymous` and group `system:unauthenticated`. With `--anonymous-auth=false`, it gets a 401.

### The authenticator chain

Multiple authenticators can be enabled at once. The apiserver tries them in a fixed order and **the first one that succeeds wins** — later authenticators never see the request.

Order (simplified):

1. X.509 client certificates
2. Bearer tokens (static token file, bootstrap tokens, service account tokens, OIDC, webhook token auth)
3. Authenticating proxy headers (`X-Remote-User`, `X-Remote-Group`)
4. Anonymous fallback

### Strategy 1 — X.509 client certificates

The default for every human and component in a kubeadm cluster. The apiserver validates the client's cert against a configured CA and extracts:

- **username** = certificate `Subject.CommonName` (CN)
- **groups**  = certificate `Subject.Organization` (O) — can repeat

Flag:

```
--client-ca-file=/etc/kubernetes/pki/ca.crt
```

A cert with `CN=alice,O=system:masters` authenticates as user `alice` in group `system:masters` — which is why `system:masters` is lethal (it is bound to `cluster-admin` by default).

Check a cert's identity:

```bash
openssl x509 -in client.crt -noout -subject
# subject=CN = kubernetes-admin, O = kubeadm:cluster-admins
```

Two gotchas:

- You cannot **revoke** a client cert. Only way is to rotate the CA. Design for short cert lifetimes.
- Cert expiry surfaces as `Unauthorized`, **not** a TLS error, if only the validity dates are wrong.

### Strategy 2 — Service account tokens (JWT)

Every pod gets a projected ServiceAccount token at `/var/run/secrets/kubernetes.io/serviceaccount/token`. The token is a signed JWT.

- **Signer**: apiserver, using `/etc/kubernetes/pki/sa.key`.
- **Verifier**: apiserver, using `sa.pub`.
- **Claims**: `iss`, `aud`, `exp`, `kubernetes.io.serviceaccount` (with SA name, namespace, UID, pod UID).

Resulting identity:

```
username = system:serviceaccount:<namespace>:<name>
groups   = [system:serviceaccounts, system:serviceaccounts:<namespace>, system:authenticated]
```

Two token flavours live side by side:

| Legacy (≤ 1.23 default)                    | Modern (TokenRequest API)                          |
|--------------------------------------------|----------------------------------------------------|
| Stored in a Secret, never expires          | Projected into the pod, short-lived (~1h)           |
| Rotating = deleting the Secret             | Auto-rotated by kubelet at 80% of lifetime          |
| Leak = permanent breach                    | Leak = bounded to TTL + audience                    |
| Not bound to a pod                         | Bound to a specific pod (invalidated on pod delete) |

Create a Secret-backed token manually when you really need a long-lived one:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: my-sa-token
  namespace: default
  annotations:
    kubernetes.io/service-account.name: my-sa
type: kubernetes.io/service-account-token
```

The token controller populates `.data.token`, `.data.ca.crt`, `.data.namespace` after creation.

Generate a short-lived one on demand:

```bash
kubectl create token my-sa --duration=1h --audience=my-app
```

### Strategy 3 — OIDC

Plug in an external identity provider. The apiserver validates the presented JWT against the IdP's JWKS:

```
--oidc-issuer-url=https://auth.example.com
--oidc-client-id=kubernetes
--oidc-username-claim=email
--oidc-groups-claim=groups
--oidc-ca-file=/etc/kubernetes/pki/oidc-ca.crt
--oidc-username-prefix=oidc:
```

Result: `username = oidc:alice@example.com`, `groups = [engineering]` (from the token's `groups` claim).

### Strategy 4 — Bootstrap tokens

Used during `kubeadm join` so a node can talk to the apiserver before it has a client cert. Tokens look like `abcdef.0123456789abcdef` and live as Secrets in `kube-system`.

```
--enable-bootstrap-token-auth=true
```

Identity: `system:bootstrap:<token-id>` in group `system:bootstrappers:kubeadm:default-node-token`. That group is bound to the bootstrap-approver ClusterRole so the incoming node can submit a CSR, the controller-manager signs it, and the node switches to its real client cert.

### Strategy 5 — Authenticating proxy

For aggregated API servers or external SSO in front of kube-apiserver. The proxy presents its own client cert signed by `requestheader-client-ca-file` and sets `X-Remote-User` / `X-Remote-Group` headers:

```
--requestheader-client-ca-file=/etc/kubernetes/pki/front-proxy-ca.crt
--requestheader-allowed-names=front-proxy-client
--requestheader-username-headers=X-Remote-User
--requestheader-group-headers=X-Remote-Group
--requestheader-extra-headers-prefix=X-Remote-Extra-
```

This is how the metrics server and extension API servers authenticate callers — they receive the identity the apiserver already validated, via these headers.

### Strategy 6 — Webhook token auth

The apiserver forwards the bearer token to an external service via a `TokenReview`:

```
--authentication-token-webhook-config-file=/etc/kubernetes/auth-webhook.yaml
--authentication-token-webhook-cache-ttl=2m
```

Rare in CKA but worth recognising.

### The reserved `system:*` groups

| Group                                              | Who is in it                                           |
|----------------------------------------------------|--------------------------------------------------------|
| `system:authenticated`                             | any successfully authenticated identity                 |
| `system:unauthenticated`                           | anonymous requests                                     |
| `system:masters`                                   | `O=system:masters` in a client cert → bound to cluster-admin |
| `system:nodes`                                     | kubelets with `CN=system:node:<name>, O=system:nodes`   |
| `system:serviceaccounts`                           | every ServiceAccount in the cluster                     |
| `system:serviceaccounts:<ns>`                      | every SA in that namespace                              |
| `system:bootstrappers`                             | kubelets bootstrapping via bootstrap tokens            |

`system:masters` is the "root" of the cluster. Never bind it to RBAC subjects you don't fully trust — it bypasses most admission checks by virtue of being `cluster-admin`.

### Impersonation

Any identity authorised for the `impersonate` verb can pretend to be someone else:

```bash
kubectl auth can-i list pods --as=bob --as-group=developers -n prod
kubectl get pods --as=system:serviceaccount:ci:deployer
```

Under the hood, kubectl sets these headers:

```
Impersonate-User:  bob
Impersonate-Group: developers
Impersonate-UID:   <optional>
Impersonate-Extra-<key>: value
```

RBAC to allow impersonation:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: impersonator }
rules:
- apiGroups: [""]
  resources: ["users", "groups", "serviceaccounts"]
  verbs: ["impersonate"]
```

Use this for debugging: "does `bob` have permission to do X?" is a much faster question than "let me log in as bob."

### Inspecting your own identity

```bash
kubectl auth whoami
# ATTRIBUTE   VALUE
# Name        kubernetes-admin
# Groups      [kubeadm:cluster-admins system:authenticated]

# Or via API
kubectl get --raw /api/v1/namespaces/default/serviceaccounts \
  -v=8 2>&1 | grep -i 'authorization:' | head -1

# Programmatically
kubectl create -f - <<'EOF'
apiVersion: authentication.k8s.io/v1
kind: SelfSubjectReview
EOF
```

If `kubectl auth whoami` says you are `system:anonymous`, your kubeconfig is not presenting a valid credential — not an RBAC issue.

---

## Part 2 — Authorization

### What it decides

Given `(user, groups, verb, resource, subresource, namespace, name, apiGroup)`, authorization returns one of:

- **Allow** — request proceeds.
- **Deny** — request is rejected immediately; remaining modes are **not** consulted.
- **NoOpinion** — pass to the next mode; if everyone abstains, the request is denied.

Every attribute is extracted from the HTTP request:

- verb: HTTP method mapped (`GET` → `get` for a single item or `list` for a collection, `POST` → `create`, `PUT` → `update`, `PATCH` → `patch`, `DELETE` → `delete`/`deletecollection`).
- resource: from the URL path (`/api/v1/namespaces/default/pods/foo` → pods in default, name=foo).
- subresource: `status`, `scale`, `log`, `exec`, `portforward`.
- non-resource path: `/healthz`, `/metrics`, `/api` etc.

Subresources have their own verbs — `pods/log get` is separate from `pods get`. A user can be authorised to read pod logs without being able to read pods themselves (and vice versa).

### Modes

Configured with an ordered list:

```
--authorization-mode=Node,RBAC
```

On kubeadm, that is the default. Five modes exist:

| Mode          | What it does                                                                 |
|---------------|------------------------------------------------------------------------------|
| `Node`        | Authorises kubelets for their own node's resources (pods, configmaps, secrets, PVs referenced by those pods). |
| `RBAC`        | Roles, ClusterRoles, RoleBindings, ClusterRoleBindings.                      |
| `ABAC`        | Static policy file. Deprecated for day-to-day use.                            |
| `Webhook`     | Ask an external service for each request via `SubjectAccessReview`.          |
| `AlwaysAllow` | Approves everything. Use only for diagnosis, never in a real cluster.         |
| `AlwaysDeny`  | Rejects everything. Useful only in tests.                                     |

Evaluation is strictly ordered and short-circuits on the **first decisive answer**:

```
for mode in authorization-mode:
    d = mode.authorize(req)
    if d == Allow: return Allow
    if d == Deny:  return Deny
    # NoOpinion: try next
return Deny   # default
```

Consequence: putting `Webhook` before `RBAC` means a webhook that answers `Deny` overrides every RBAC rule. Order carefully.

### Node authorizer — why it exists

The Node authorizer is a special-case RBAC replacement for the kubelet. A kubelet identifies as `system:node:<nodename>` in group `system:nodes`. Without the Node authorizer, you'd have to write a RoleBinding for every node — and worse, a kubelet would be able to read every Secret in the cluster if you gave it broad permission.

The Node authorizer allows the kubelet to:

- Read/update only **its own** `Node` object.
- List pods scheduled on its node (`fieldSelector=spec.nodeName=<self>`).
- Read ConfigMaps and Secrets referenced by pods on its node.
- Read PVs attached to pods on its node.

Anything else → NoOpinion → falls through to RBAC (which won't authorise it either → deny).

In kubeadm this is always on; you just need `--authorization-mode=Node,RBAC`.

### RBAC — the core

Four resource kinds:

| Kind                | Scope      | Binds what                                    |
|---------------------|------------|-----------------------------------------------|
| `Role`              | Namespace  | rules = verbs × resources in that namespace   |
| `ClusterRole`       | Cluster    | rules (usable by RoleBinding or ClusterRoleBinding) |
| `RoleBinding`       | Namespace  | subjects → Role (or ClusterRole, scoped to ns)|
| `ClusterRoleBinding`| Cluster    | subjects → ClusterRole (cluster-wide)         |

Rules are additive — never subtractive. Permission is the **union** of all matching rules. There is no "deny" in RBAC.

Minimal Role:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { namespace: dev, name: pod-reader }
rules:
- apiGroups: [""]              # core group
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["pods/log"]      # subresource = separate rule
  verbs: ["get"]
```

Bind a ServiceAccount to it:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { namespace: dev, name: app-pod-reader }
subjects:
- kind: ServiceAccount
  name: app
  namespace: dev
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: pod-reader
```

Common idioms:

- `resourceNames: ["foo"]` — restrict to a specific object (no wildcards).
- `verbs: ["*"]` — all verbs. Dangerous.
- A ClusterRole used inside a RoleBinding — only the rules relevant to that namespace apply.
- Subjects can be `User`, `Group`, `ServiceAccount`. Users and Groups are strings (no API object to manage).

### Checking permissions — `kubectl auth can-i`

Any authorization question can be answered without mutating state:

```bash
# My permissions
kubectl auth can-i create deployments -n prod
kubectl auth can-i --list -n prod                         # everything I can do here

# Someone else's permissions
kubectl auth can-i list secrets --as=alice -n dev
kubectl auth can-i '*' '*' --as=system:serviceaccount:ci:deployer

# Subresource
kubectl auth can-i get pods/log -n dev
kubectl auth can-i create pods/exec
```

Under the hood this is a POST to `authorization.k8s.io/v1/subjectaccessreviews` (or `selfsubjectaccessreviews`). No side effects.

`kubectl auth can-i --list` for the current user is the fastest way to audit what a token can actually do.

### Non-resource URLs

`/metrics`, `/healthz`, `/version`, `/api` are **non-resource URLs**. RBAC rules for them use `nonResourceURLs`:

```yaml
- nonResourceURLs: ["/metrics"]
  verbs: ["get"]
```

The Prometheus scrape path is usually granted this way.

### Inspecting existing bindings

```bash
# Everything a ServiceAccount can do
kubectl auth can-i --list --as=system:serviceaccount:kube-system:coredns

# Every binding that references a given subject
kubectl get clusterrolebinding,rolebinding -A -o json | \
  jq -r '.items[] | select(.subjects[]?.name=="default" and .subjects[]?.kind=="ServiceAccount") | [.kind, .metadata.namespace // "<cluster>", .metadata.name, .roleRef.name] | @tsv'
```

### Common RBAC failure modes

| Symptom                                                    | Cause                                                           |
|------------------------------------------------------------|-----------------------------------------------------------------|
| `Error from server (Forbidden): pods is forbidden: User "X" cannot list resource "pods" ...` | Missing Role/RoleBinding for `pods` `list` in that namespace. |
| Works in `default` namespace, fails in `prod`              | RoleBinding only exists in `default`; ClusterRoleBinding or per-namespace RoleBinding needed. |
| Can `list` pods but not `watch` them                       | Each verb is explicit; `watch` must be in the `verbs` list.     |
| Can `get` a pod but not `get` its logs                     | `pods/log` is a separate resource.                               |
| ServiceAccount inside a pod has more permission than expected | Check bindings referencing `system:serviceaccounts` or `system:serviceaccounts:<ns>` — these grant to *all* SAs in a scope. |
| RBAC edits appear to do nothing                            | RBAC changes are live; you may be hitting the short kubectl cache. Retry in a new shell. |

---

## Part 3 — Admission

### Position in the pipeline

Admission runs **only for writes** (`create`, `update`, `delete`, and certain patch operations). Reads bypass it. The pipeline is:

```
Mutating admission  →  schema validation  →  Validating admission
```

Built-in controllers are compiled into the apiserver. Webhook-based ones are declared as cluster objects (`MutatingWebhookConfiguration`, `ValidatingWebhookConfiguration`) and invoked dynamically.

### Enabling and disabling

```
--enable-admission-plugins=NamespaceLifecycle,LimitRanger,ServiceAccount,...
--disable-admission-plugins=PodSecurityPolicy
```

On a kubeadm cluster you get a sane default set. Check what is actually enabled:

```bash
kubectl get pod -n kube-system kube-apiserver-<node> -o yaml | \
  grep -E 'enable-admission-plugins|disable-admission-plugins'
```

### The default plugin set (recent Kubernetes)

| Plugin                            | Type     | What it does                                             |
|-----------------------------------|----------|----------------------------------------------------------|
| `NamespaceLifecycle`              | val      | Blocks writes into terminating/missing namespaces.       |
| `LimitRanger`                     | mut+val  | Injects defaults / enforces ranges from LimitRange objects. |
| `ServiceAccount`                  | mut      | Injects the SA token volume, sets `serviceAccountName` default, copies imagePullSecrets. |
| `DefaultStorageClass`             | mut      | Stamps the default SC on PVCs without one.                |
| `DefaultTolerationSeconds`        | mut      | Adds the 300 s tolerations for `not-ready` / `unreachable`. |
| `DefaultIngressClass`             | mut      | Stamps the default IngressClass on Ingress objects.       |
| `Priority`                        | mut+val  | Resolves priorityClassName → priority value.              |
| `ResourceQuota`                   | val      | Enforces namespace quotas.                                |
| `PodSecurity`                     | val      | Enforces Pod Security Standards labels (`restricted`/`baseline`/`privileged`). |
| `TaintNodesByCondition`           | mut      | Adds `not-ready` taint to nodes reporting problems.       |
| `StorageObjectInUseProtection`    | mut      | Adds finalizers to PV/PVC so they don't vanish mid-use.  |
| `PersistentVolumeClaimResize`     | val      | Validates PVC expansion against StorageClass `allowVolumeExpansion`. |
| `CertificateApproval`/`Signing`/`SubjectRestriction` | val | Enforce what a user can ask for in a CSR.                |
| `RuntimeClass`                    | val      | Validates `runtimeClassName` references.                  |
| `MutatingAdmissionWebhook`        | mut      | Invokes MutatingWebhookConfigurations.                    |
| `ValidatingAdmissionWebhook`      | val      | Invokes ValidatingWebhookConfigurations.                  |
| `ValidatingAdmissionPolicy`       | val      | Evaluates CEL-based `ValidatingAdmissionPolicy` + bindings. |

Each one has quietly-important side effects. If a user asks "why does my pod have a `tolerations` block I didn't write?", the answer is usually `DefaultTolerationSeconds`. "Why does my pod have a token mount?" — `ServiceAccount` admission. These are not decorations; removing them breaks real behaviour.

### Webhook admission — the config object

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata: { name: policy.example.com }
webhooks:
- name: pods.policy.example.com
  clientConfig:
    service:
      name: policy-webhook
      namespace: policy-system
      path: /validate
    caBundle: <base64 CA>
  rules:
  - apiGroups: [""]
    apiVersions: ["v1"]
    resources: ["pods"]
    operations: ["CREATE", "UPDATE"]
    scope: Namespaced
  namespaceSelector:
    matchExpressions:
    - key: kubernetes.io/metadata.name
      operator: NotIn
      values: [kube-system, kube-public]
  failurePolicy: Fail          # or Ignore
  timeoutSeconds: 5
  sideEffects: None
  admissionReviewVersions: ["v1"]
```

Fields that actually matter in production and on the exam:

| Field                 | Default   | Consequence of getting it wrong                               |
|-----------------------|-----------|----------------------------------------------------------------|
| `failurePolicy`       | `Fail`    | `Fail` + webhook unreachable = entire cluster stops accepting writes for matching resources. |
| `timeoutSeconds`      | 10        | Slow webhook slows every write. Lower this aggressively (3–5 s).|
| `sideEffects`         | required  | Must declare; `None` means safe to re-invoke (CEL policies, pure validation). |
| `namespaceSelector`   | match all | Always exempt `kube-system` to keep the control plane out of your webhook's failure blast radius. |
| `objectSelector`      | match all | Opt-in mode: only objects with a label are evaluated. Safer default. |
| `reinvocationPolicy`  | `Never`   | If another mutating webhook changes the object, should this one run again? `IfNeeded` for defaulters that need consistency. |

### The single most common webhook outage

Webhook admission is the source of the classic "cluster stuck writing nothing" failure:

1. Someone installs a validating webhook with `failurePolicy: Fail` and matches `*` resources.
2. The webhook pod crashes / DNS flakes / cert expires.
3. Apiserver gets `Internal error: context deadline exceeded calling webhook`.
4. Every write — including system components — fails.

Recovery order:

```bash
# Find the webhooks
kubectl get validatingwebhookconfigurations
kubectl get mutatingwebhookconfigurations

# Remove the offender (you may need to use a kubeconfig that bypasses webhooks
# — certain system identities like admin on the control plane node can)
kubectl delete validatingwebhookconfiguration <name>
```

If every kubectl is failing, edit the apiserver static pod manifest to temporarily add:

```
--disable-admission-plugins=MutatingAdmissionWebhook,ValidatingAdmissionWebhook
```

Then fix the webhook configuration, then re-enable.

Prevention:

- `namespaceSelector` to exclude `kube-system`.
- `failurePolicy: Ignore` for non-critical policy.
- Short `timeoutSeconds` (3–5).
- Pin webhook pods with `priorityClassName: system-cluster-critical` so they schedule before workloads.

### ValidatingAdmissionPolicy (no webhook required)

Modern clusters ship `ValidatingAdmissionPolicy`, which lets you write validation rules in CEL directly, with no external service:

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata: { name: no-privileged }
spec:
  matchConstraints:
    resourceRules:
    - apiGroups: [""]
      apiVersions: ["v1"]
      resources: ["pods"]
      operations: ["CREATE", "UPDATE"]
  validations:
  - expression: "!object.spec.containers.exists(c, has(c.securityContext) && c.securityContext.privileged == true)"
    message: "Privileged containers are not allowed."
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata: { name: no-privileged-binding }
spec:
  policyName: no-privileged
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchExpressions:
      - key: kubernetes.io/metadata.name
        operator: NotIn
        values: [kube-system]
```

No network calls, no webhook pod — the apiserver evaluates CEL in-process. CKA doesn't demand you author these from scratch, but recognise them when you see them.

### Debugging admission rejections

Error text tells you which stage rejected:

```
Error from server (Forbidden): pods "x" is forbidden: ...              ← authorization
Error from server: admission webhook "xyz.example.com" denied the request: ... ← webhook admission
Error from server: error when creating "pod.yaml": pods "x" already exists ← no admission, conflict
```

Useful commands:

```bash
# See what happened
kubectl apply -f broken-pod.yaml --dry-run=server     # run through admission without persisting
kubectl get events -A --sort-by=.lastTimestamp | tail

# Is a webhook the culprit?
kubectl get validatingwebhookconfigurations -o wide
kubectl get mutatingwebhookconfigurations -o wide

# Can the apiserver reach the webhook?
kubectl -n <webhook-ns> get endpoints <webhook-service>
kubectl -n <webhook-ns> logs <webhook-pod> --tail=100

# Raw apiserver view
kubectl logs -n kube-system kube-apiserver-<node> | grep -iE 'webhook|admission'
```

`--dry-run=server` is the single highest-value debugging tool here: it runs the full pipeline (including webhooks) without writing to etcd, so you can see the exact error message without committing changes.

---

## Putting it together — a failure-mode decision tree

```
Request fails with error message
│
├── "Unauthorized" (HTTP 401)
│     → Authentication failed — kubeconfig, cert, or token is invalid/expired
│     → Check: kubectl auth whoami
│     → Check: openssl x509 -in <cert> -noout -dates
│
├── "Forbidden" (HTTP 403)
│     → Authorization denied (RBAC / Node authorizer / Webhook)
│     → Check: kubectl auth can-i <verb> <resource> --as=<user>
│     → Check: kubectl auth can-i --list --as=<user>
│
├── "admission webhook ... denied"
│     → A webhook said no; message includes the webhook name
│     → Check: kubectl get validatingwebhookconfigurations <name>
│     → Check: kubectl logs <webhook-pod>
│
├── "admission plugin 'X' failed"
│     → A built-in rejected (e.g. PodSecurity, ResourceQuota)
│     → Check: kubectl describe <object>  — events include the specific rule violated
│     → Check: kubectl get resourcequotas -n <ns>
│
├── "context deadline exceeded calling webhook"
│     → Webhook endpoint unreachable / slow / cert mismatch
│     → Check: webhook pod running, service endpoints populated, caBundle valid
│
└── "namespace ... is being terminated" / "namespace ... not found"
      → NamespaceLifecycle admission; the namespace is gone or mid-delete
```

---

## Exam heuristics

- For any 403, open with `kubectl auth can-i ... --as=<user>`. It answers in one call.
- For RBAC tasks: prefer `kubectl create role ... --verb=... --resource=...` and `kubectl create rolebinding ...`. Faster and less error-prone than hand-writing YAML.
- Bind to a **ServiceAccount**, not the default user, when a pod is the subject. The subject line is `kind: ServiceAccount, name: <sa>, namespace: <ns>`.
- If a pod doesn't seem to pick up new permissions, remember RBAC is evaluated per-request — there is no "restart pod to refresh RBAC." But if the pod caches the response of a previous denial, you may need to restart the pod.
- Exam webhooks almost never appear. If they do, they are usually the *cause* of a failure — read the error text; it names the webhook.

## Mental traps

- Assuming 401 and 403 are the same problem. 401 = identity, 403 = permission. Completely different fixes.
- Forgetting that `view`/`edit`/`admin`/`cluster-admin` are pre-defined ClusterRoles, not magic. `kubectl get clusterrole view -o yaml` shows you their actual rules.
- Thinking admission is "validation." It is also mutation. A Pod with `tolerations: [not-ready...]` that you didn't write came from admission.
- Confusing `system:masters` with `kubernetes-admin`. `system:masters` is the **group** that the default admin kubeconfig's certificate belongs to; removing it from the cert (or from the pre-created ClusterRoleBinding) locks you out.
- Editing a ValidatingWebhookConfiguration expecting an immediate effect — apiserver caches are invalidated within seconds, but not instantly. Re-submit the write to check.
