## The single most useful auth diagnostic

`kubectl auth can-i` is how you verify whether a user/SA has permission to do something — without actually doing it. It calls the **SubjectAccessReview** API behind the scenes. The apiserver runs the same authorization logic it would for a real request, but in dry-run mode.

Use it for:

- Confirming RBAC bindings work as intended.
- Diagnosing "why is this Forbidden?"
- Auditing what a SA can access before deploying.
- Verifying impersonation permissions.

```bash
kubectl auth can-i list pods -n dev
# yes / no
```

Exit code 0 if allowed, non-zero if denied. Useful in scripts.

---

## Basic forms

### Check what the current user can do

```bash
# Can I list pods in the current namespace?
kubectl auth can-i list pods

# In a specific namespace
kubectl auth can-i list pods -n dev

# Cluster-scoped resource
kubectl auth can-i list nodes
```

### List everything the current user can do

```bash
kubectl auth can-i --list

# Resources                        Non-Resource URLs   Resource Names   Verbs
# selfsubjectreviews.authentication.k8s.io   []      []                 [create]
# selfsubjectaccessreviews.authorization.k8s.io  []  []                 [create]
# selfsubjectrulesreviews.authorization.k8s.io   []  []                 [create]
# *.*                              []                  []                [*]            ← cluster-admin if you see this
```

For `cluster-admin`, you get `*.*  *` — wildcard everything. For limited users, you get a concrete list of what's permitted.

In a specific namespace:

```bash
kubectl auth can-i --list -n dev
```

Returns rules that apply within that namespace specifically.

### Check on behalf of someone else

```bash
# Can Alice list pods?
kubectl auth can-i list pods -n dev --as=alice

# As a group (not a user, just a group)
kubectl auth can-i list pods -n dev --as=alice --as-group=devops

# As a ServiceAccount
kubectl auth can-i list pods -n dev --as=system:serviceaccount:dev:my-sa

# What can the SA do?
kubectl auth can-i --list --as=system:serviceaccount:dev:my-sa -n dev
```

Requires the **caller** to have the `impersonate` verb on `users` (or `groups`, `serviceaccounts`). Without it, you can't `--as`.

---

## Specific verbs and resources

### Subresources

```bash
# Pod logs
kubectl auth can-i get pods/log -n dev

# Exec into pods
kubectl auth can-i create pods/exec -n dev

# Scale a deployment
kubectl auth can-i update deployments/scale -n dev
```

Subresources have their own RBAC; checking the parent isn't enough.

### Specific resource by name

```bash
# Can I delete this specific deployment?
kubectl auth can-i delete deployment/my-app --resource-name=my-app -n dev
```

If the Role uses `resourceNames`, this checks against that filter.

### Non-resource URLs

```bash
# Can I hit the metrics endpoint?
kubectl auth can-i get /metrics
```

For URLs not corresponding to API resources (`/healthz`, `/version`, `/metrics`).

---

## The SubjectAccessReview API

`kubectl auth can-i` posts a `SelfSubjectAccessReview`:

```yaml
apiVersion: authorization.k8s.io/v1
kind: SelfSubjectAccessReview
spec:
  resourceAttributes:
    namespace: dev
    verb: list
    resource: pods
```

Apiserver runs authorization, returns:

```yaml
status:
  allowed: true
  reason: "RBAC: allowed by RoleBinding ..."
```

You rarely write this YAML manually — `kubectl auth can-i` is the wrapper. But knowing the underlying API matters when you're writing operators / admission webhooks that need to perform pre-checks.

For checking another subject (impersonation):

```yaml
apiVersion: authorization.k8s.io/v1
kind: SubjectAccessReview
spec:
  user: alice
  groups: [devops]
  resourceAttributes:
    namespace: dev
    verb: list
    resource: pods
```

Submit:

```bash
kubectl create -f sar.yaml -o yaml
```

---

## SelfSubjectRulesReview — list all my permissions in a namespace

```bash
cat <<'EOF' | kubectl create -f -
apiVersion: authorization.k8s.io/v1
kind: SelfSubjectRulesReview
spec:
  namespace: dev
EOF
```

Returns every resource rule that applies to the current user in `dev`. Comprehensive view; what `kubectl auth can-i --list -n dev` is built on.

---

## Diagnosing 403 Forbidden

Standard kubectl error:

```
Error from server (Forbidden): pods is forbidden: User "alice" cannot list resource "pods" in API group "" in the namespace "dev"
```

This message tells you a lot:

- **User**: `alice`.
- **Action**: `list pods`.
- **API group**: `""` (core).
- **Namespace**: `dev`.

Now check what binding(s) cover (alice, list, pods, "", dev):

```bash
# Is there a Role + RoleBinding for alice in dev that allows pods list?
kubectl get rolebinding -n dev -o json | \
  jq -r '.items[] | select(.subjects[]?.name=="alice") | .metadata.name + " -> " + .roleRef.name'

# What are those Roles' rules?
kubectl get role <role-name> -n dev -o yaml

# Or: kubectl auth can-i list pods -n dev --as=alice
# (returns "no" — the negative confirms RBAC denies it)
```

If `auth can-i` says yes but the actual call fails, something else is going on (admission, network, kubeconfig pointing at wrong cluster).

### Reverse direction: which RoleBindings affect a user?

```bash
# Find every RoleBinding that mentions alice
kubectl get rolebinding,clusterrolebinding -A -o json | \
  jq -r '.items[] | select(.subjects[]?.name=="alice") |
    [.kind, .metadata.namespace // "<cluster>", .metadata.name, .roleRef.kind, .roleRef.name] | @tsv'

# Same for a SA
kubectl get rolebinding,clusterrolebinding -A -o json | \
  jq -r '.items[] | select(.subjects[]? | .kind=="ServiceAccount" and .name=="my-sa" and .namespace=="dev") |
    [.kind, .metadata.namespace // "<cluster>", .metadata.name, .roleRef.kind, .roleRef.name] | @tsv'
```

Now you have the list of bindings. Check each Role/ClusterRole's rules to confirm whether the desired action is allowed.

---

## `kubectl auth whoami`

Modern kubectl (1.28+) has:

```bash
kubectl auth whoami
# ATTRIBUTE   VALUE
# Username    kubernetes-admin
# Groups      [kubeadm:cluster-admins system:authenticated]
```

Tells you exactly what identity your kubeconfig is presenting. Useful when:

- You're not sure which kubeconfig is active.
- You suspect the wrong cert is being used.
- Cross-checking before troubleshooting RBAC.

---

## Impersonation

Authorized users can pretend to be others:

```bash
# Run a command as alice
kubectl get pods --as=alice -n dev

# As a group
kubectl get pods --as=alice --as-group=devops -n dev

# As a SA
kubectl get pods --as=system:serviceaccount:dev:my-sa -n dev

# As alice with extra info
kubectl get pods --as=alice --as-uid=12345 \
  --as-group=group1 --as-group=group2 -n dev
```

The caller must have RBAC permissions:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: impersonator }
rules:
- apiGroups: [""]
  resources: ["users", "groups", "serviceaccounts"]
  verbs: ["impersonate"]
```

Limit which users/groups can be impersonated:

```yaml
rules:
- apiGroups: [""]
  resources: ["users"]
  resourceNames: ["alice", "bob"]
  verbs: ["impersonate"]
- apiGroups: [""]
  resources: ["groups"]
  resourceNames: ["devops"]
  verbs: ["impersonate"]
```

Now the bound subject can only impersonate Alice or Bob (not arbitrary users).

### Why impersonation is useful

- **Testing RBAC**: verify Alice's permissions without logging in as Alice.
- **Auditing**: investigate "what would this SA see?".
- **Privilege management**: an operator runs queries on behalf of users (acts on their behalf with their identity in audit logs).

---

## Bound permissions vs effective permissions

Sometimes a user has bindings but `auth can-i` says no. Why?

- **Conflicting policy** — admission webhook denies.
- **Unauthenticated** — kubeconfig's cert expired, you're effectively `system:anonymous`.
- **Wrong namespace** — RoleBinding is in `prod`, you queried in `dev`.

Always cross-check:

```bash
# Who am I really?
kubectl auth whoami

# What can I do here?
kubectl auth can-i --list -n <ns>

# What rules apply to me?
kubectl create -f - <<EOF
apiVersion: authorization.k8s.io/v1
kind: SelfSubjectRulesReview
spec:
  namespace: <ns>
EOF
```

---

## Useful patterns

### Audit a SA before deploy

```bash
SA=system:serviceaccount:my-system:my-operator

kubectl auth can-i --list --as=$SA
# Review carefully — anything beyond what's needed is over-privileged.

kubectl auth can-i create deployments --as=$SA -n target-namespace
kubectl auth can-i delete pods --as=$SA -n target-namespace
```

### Verify a new RoleBinding worked

```bash
# Apply the binding
kubectl apply -f rolebinding.yaml

# Confirm
kubectl auth can-i get pods --as=alice -n dev
# yes
```

### Check across namespaces in bulk

```bash
for ns in $(kubectl get ns -o name | sed 's|namespace/||'); do
  echo "=== $ns ==="
  kubectl auth can-i list secrets --as=alice -n $ns
done
```

Quick audit of where Alice has Secret-read access.

### Compare before/after RBAC change

```bash
# Snapshot before
kubectl auth can-i --list --as=alice -n dev > before.txt

# Apply changes
kubectl apply -f new-roles.yaml

# Snapshot after
kubectl auth can-i --list --as=alice -n dev > after.txt

# Diff
diff before.txt after.txt
```

Useful for change reviews.

---

## SubjectAccessReview from inside a pod

For applications that need to make authorization decisions:

```go
// Pseudocode
sar := &authzv1.SubjectAccessReview{
  Spec: authzv1.SubjectAccessReviewSpec{
    User: "alice",
    ResourceAttributes: &authzv1.ResourceAttributes{
      Namespace: "dev",
      Verb: "list",
      Resource: "pods",
    },
  },
}
result := apiserver.PostSAR(sar)
if !result.Status.Allowed { ... }
```

The pod's SA needs `create subjectaccessreviews.authorization.k8s.io`. Pre-installed `system:auth-delegator` ClusterRole grants this — bind it to your operator's SA when the operator needs to delegate auth checks.

---

## Common 403 causes

| Symptom                                                       | Likely cause                                                |
|---------------------------------------------------------------|-------------------------------------------------------------|
| `User "X" cannot list resource "pods"`                         | No Role/ClusterRole granting `list pods` to user X          |
| `User "X" cannot get resource "pods/log"`                      | Have `pods get`, missing `pods/log get`                     |
| `User "X" cannot list resource "pods" in namespace "dev"`      | RoleBinding is in different namespace                        |
| `User "X" cannot impersonate ...`                              | Missing impersonate verb in caller's RBAC                    |
| `forbidden: User "X" attempting to grant ... not currently held` | Privilege escalation block — needs `bind`/`escalate`      |
| `Forbidden: namespaces "Y" is forbidden`                       | Trying to operate in a namespace you can't see              |

The error message names exactly what's missing. Read it.

---

## Audit logs and authorization

If audit logging is enabled, every authz decision is logged:

```json
{
  "kind": "Event",
  "verb": "list",
  "user": { "username": "alice", "groups": ["devops"] },
  "objectRef": { "resource": "pods", "namespace": "dev" },
  "responseStatus": { "code": 403 },
  "annotations": {
    "authorization.k8s.io/decision": "forbid",
    "authorization.k8s.io/reason": ""
  }
}
```

The `authorization.k8s.io/reason` field tells you which Role/Binding allowed or denied. Useful when you need to know "exactly why was this allowed?" — search audit logs for the request and inspect the annotation.

---

## Exam heuristics

- For "verify Alice can do X," `kubectl auth can-i X --as=alice -n <ns>`.
- For "what can SA my-sa do," `kubectl auth can-i --list --as=system:serviceaccount:<ns>:<sa>`.
- 403 errors include the user, verb, resource, namespace — read carefully.
- Always cross-check `kubectl auth whoami` if you're confused about your own identity.

## Mental traps

- Querying `auth can-i` without `-n` and forgetting it defaults to your current context's namespace.
- Confusing `--as=alice` (impersonate user) with `--as=system:serviceaccount:default:alice` (impersonate SA). Different identity formats.
- Expecting `--list` to show ALL permissions globally. It only shows the namespace context (and cluster-scoped permissions).
- Using `--as` without the `impersonate` verb. You'll get a different 403.
- Forgetting subresources. `pods get` doesn't include `pods/log get`.
- Reading `Forbidden` as "RBAC issue" when it could be admission control. The message usually distinguishes — RBAC says "cannot ... resource"; admission says "denied by admission".
