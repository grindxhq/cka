## Four objects, one model

Kubernetes authorization (when `--authorization-mode=RBAC`) is built from four resource kinds:

```
                          ┌──────────────┐
                          │  ClusterRole  │  rules apply cluster-wide
                          └──────┬────────┘
                                 │
                                 │  bound by
                                 ▼
              ┌──────────────────────────────────────┐
              │      ClusterRoleBinding               │  → grants ClusterRole's rules to subjects everywhere
              └──────────────────────────────────────┘

                          ┌──────────────┐
                          │     Role      │  rules apply within one namespace
                          └──────┬────────┘
                                 │
                                 │  bound by
                                 ▼
              ┌──────────────────────────────────────┐
              │         RoleBinding                   │  → grants Role's rules within one namespace
              └──────────────────────────────────────┘

                A RoleBinding can also bind a ClusterRole, scoped to that namespace.
```

The full set:

| Kind                  | Defines                | Scope of rules           |
|-----------------------|------------------------|--------------------------|
| `Role`                | What's permitted       | One namespace            |
| `ClusterRole`         | What's permitted       | Cluster-wide             |
| `RoleBinding`         | Subject ↔ Role/ClusterRole | One namespace        |
| `ClusterRoleBinding`  | Subject ↔ ClusterRole   | Cluster-wide             |

**Rules are additive only.** RBAC has no "deny" — you only describe what's permitted. The effective permission is the union of every binding that applies to the subject.

---

## A Role — the basic unit

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: dev
  name: pod-reader
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
```

Read it as: "in namespace `dev`, the rule allows `get`, `list`, `watch` on `pods` in the core API group (`""`)."

A Role has only `rules`. Each rule has:

| Field | Meaning |
|-------|---------|
| `apiGroups` | The API group(s). `""` for the core group (Pods, Services, ConfigMaps), `apps` for Deployments / DaemonSets, `batch` for Jobs, etc. |
| `resources` | Resource types: `pods`, `deployments`, etc. Subresources via slash: `pods/log`, `pods/exec`. |
| `verbs` | Actions: `get`, `list`, `watch`, `create`, `update`, `patch`, `delete`, `deletecollection`. Or `*` for any. |
| `resourceNames` | (optional) Restrict to specific named objects: `["my-pod"]`. |
| `nonResourceURLs` | (optional, ClusterRole only) URL paths like `/healthz`. |

### A more elaborate rule

```yaml
rules:
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets"]
  verbs: ["get", "list", "watch", "update", "patch"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get"]
- apiGroups: [""]
  resources: ["secrets"]
  resourceNames: ["app-config"]      # only this specific secret
  verbs: ["get"]
```

Three rules unioned: read+modify Deployments and StatefulSets, read pod logs, read one specific Secret. Anything not listed is denied (per default-deny).

---

## ClusterRole

Same shape as Role, but cluster-scoped:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: secret-reader
rules:
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "watch"]
```

ClusterRole rules can target:

- **Cluster-scoped resources** (Nodes, PersistentVolumes, ClusterRoles).
- **Namespaced resources across all namespaces** (when bound via ClusterRoleBinding).
- **Namespaced resources within one namespace** (when bound via RoleBinding — see below).
- **Non-resource URLs** (`/api`, `/metrics`, `/healthz`).

### Pre-installed ClusterRoles

Every cluster ships with these (and others):

```bash
kubectl get clusterroles | head

# NAME                                                                   AGE
# admin                                                                   30d
# cluster-admin                                                           30d
# edit                                                                    30d
# view                                                                    30d
# system:basic-user                                                       30d
# system:controller:attachdetach-controller                                30d
# system:kube-controller-manager                                           30d
# system:kube-scheduler                                                    30d
# system:node                                                              30d
# system:node-bootstrapper                                                 30d
```

The user-facing ones:

- **`view`** — read-only on most resources (no Secrets).
- **`edit`** — read/write on most workload resources (no RBAC, no Secrets).
- **`admin`** — full namespace admin (no cluster-scoped resources, can manage RBAC within the namespace).
- **`cluster-admin`** — full god-mode.

Bind these to your users / groups instead of writing your own.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  namespace: dev
  name: alice-edit
subjects:
- kind: User
  name: alice
  apiGroup: rbac.authorization.k8s.io
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole         # bind a ClusterRole...
  name: edit                # ...within this namespace via RoleBinding
```

`alice` gets `edit`-level access — but only in `dev`.

---

## RoleBinding

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  namespace: dev
  name: pod-reader-binding
subjects:
- kind: User
  name: alice
  apiGroup: rbac.authorization.k8s.io
- kind: Group
  name: devops
  apiGroup: rbac.authorization.k8s.io
- kind: ServiceAccount
  name: my-sa
  namespace: dev
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role               # or ClusterRole
  name: pod-reader
```

`subjects` is a list. Each entry is `User`, `Group`, or `ServiceAccount`.

`roleRef` is a single value pointing at one Role or ClusterRole.

**Important rule**: `roleRef` is **immutable** after creation. To change which Role you're binding to, delete and recreate the RoleBinding.

### Subject types

```yaml
# User (humans, identified by client cert CN or OIDC)
- kind: User
  name: alice@example.com
  apiGroup: rbac.authorization.k8s.io

# Group (multiple users)
- kind: Group
  name: system:authenticated
  apiGroup: rbac.authorization.k8s.io

# ServiceAccount (workload identity)
- kind: ServiceAccount
  name: my-sa
  namespace: dev               # required for SA; not for User/Group
```

Notice `apiGroup: rbac.authorization.k8s.io` for User / Group, but **no apiGroup** for ServiceAccount (because SA is in the core API group `""`).

### The default-namespace ServiceAccount

Every namespace has a `default` ServiceAccount. Pods that don't specify `serviceAccountName` use it. Default has zero RBAC bindings — pods can't talk to the API.

If you bind something to the default SA:

```yaml
subjects:
- kind: ServiceAccount
  name: default
  namespace: dev
```

every pod in `dev` (without `serviceAccountName` set) gets that permission. Be careful — affects everything in the namespace.

---

## ClusterRoleBinding

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cluster-admins
subjects:
- kind: Group
  name: kubeadm:cluster-admins
  apiGroup: rbac.authorization.k8s.io
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
```

Cluster-scoped binding. Subjects get the ClusterRole's permissions across the entire cluster.

This particular binding is what makes `admin.conf` (whose cert has `O=kubeadm:cluster-admins`) full cluster-admin.

---

## Verbs in detail

| Verb         | HTTP                       | Purpose                                                    |
|--------------|----------------------------|------------------------------------------------------------|
| `get`        | GET (single)               | Read one named object                                      |
| `list`       | GET (collection)           | Read all of a kind                                         |
| `watch`      | GET (with `watch=true`)    | Streaming change notifications                            |
| `create`     | POST                       | Create new                                                 |
| `update`     | PUT                        | Replace existing                                           |
| `patch`      | PATCH                      | Partial update                                             |
| `delete`     | DELETE (single)            | Delete one                                                 |
| `deletecollection` | DELETE (collection)   | Delete many in one call                                    |
| `*`          | any                        | Wildcard — all verbs (use sparingly)                       |

For some resources, additional verbs:

- `bind` — needed to create a RoleBinding/ClusterRoleBinding referencing a (Cluster)Role. Prevents privilege escalation via binding broader rules.
- `escalate` — needed to create a Role/ClusterRole with rules you don't currently have. Same purpose.
- `impersonate` — needed to use `--as` to pretend to be another user.

These are special — RBAC bootstrapping deliberately requires them to prevent users from granting themselves more access.

### Example: privilege escalation prevention

Alice has `edit` in `dev`. She tries to grant herself cluster-admin via:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  namespace: dev
  name: alice-becomes-admin
subjects:
- kind: User
  name: alice
roleRef:
  kind: ClusterRole
  name: cluster-admin
```

If Alice could create this, she'd be admin. But `bind` verb on `clusterroles/cluster-admin` is denied for `edit`. Apiserver rejects with:

```
Error from server (Forbidden): error when creating "x.yaml":
roleref.rbac.authorization.k8s.io/cluster-admin is forbidden:
user "alice" (groups=...) is attempting to grant RBAC permissions not currently held
```

---

## Resources and apiGroups

The combination of `apiGroups` + `resources` identifies the type. Examples:

```yaml
# Pods, Services, ConfigMaps, Secrets — core
- apiGroups: [""]
  resources: ["pods", "services"]

# Deployments, ReplicaSets, StatefulSets — apps
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets"]

# Jobs, CronJobs — batch
- apiGroups: ["batch"]
  resources: ["jobs", "cronjobs"]

# RBAC objects themselves
- apiGroups: ["rbac.authorization.k8s.io"]
  resources: ["roles", "rolebindings"]

# CRDs
- apiGroups: ["apiextensions.k8s.io"]
  resources: ["customresourcedefinitions"]

# Custom resources (defined by a CRD)
- apiGroups: ["example.com"]
  resources: ["myresources"]
```

To find what's in which group:

```bash
kubectl api-resources

# NAME           SHORTNAMES   APIVERSION       NAMESPACED   KIND
# pods           po           v1               true         Pod
# services       svc          v1               true         Service
# deployments    deploy       apps/v1          true         Deployment
# nodes          no           v1               false        Node
# ...
```

Use `apiVersion`'s prefix as the apiGroup. `apps/v1` → `apiGroups: ["apps"]`.

---

## Wildcards

```yaml
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["*"]
```

Effectively `cluster-admin`. Use only when you genuinely mean "everything." Most exam answers should NOT use wildcards if the task is "give Alice read access to pods" — be specific.

`*` works for `apiGroups`, `resources`, `verbs`. Doesn't work for `resourceNames`.

---

## Subresources

Some operations target a sub-path of a resource:

| Subresource | Verb         | Example                                          |
|-------------|--------------|--------------------------------------------------|
| `pods/log`  | get          | `kubectl logs <pod>`                             |
| `pods/exec` | create       | `kubectl exec <pod>`                             |
| `pods/portforward` | create | `kubectl port-forward`                           |
| `pods/attach` | create     | `kubectl attach`                                 |
| `pods/eviction` | create   | Eviction API (graceful eviction during drain)    |
| `deployments/scale` | update | `kubectl scale deploy/x --replicas=N`            |
| `deployments/status` | update | Controller updating status                       |

Subresources are separate from their parent for RBAC purposes:

```yaml
# Read pods AND their logs
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log"]
  verbs: ["get", "list"]

# Read pods, but NOT their logs
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list"]
# (separate `pods/log` rule omitted → denied)
```

A common mistake: granting `pods get` and being surprised that `kubectl logs` fails. Add `pods/log get` separately.

---

## Aggregated ClusterRoles

A ClusterRole can be an **aggregation** of other ClusterRoles selected by labels:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring
  labels:
    rbac.example.com/aggregate-to-monitoring: "true"
rules: []                              # no rules itself
aggregationRule:
  clusterRoleSelectors:
  - matchLabels:
      rbac.example.com/aggregate-to-monitoring: "true"
```

When you create another ClusterRole with the matching label:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: read-pods-and-services
  labels:
    rbac.example.com/aggregate-to-monitoring: "true"
rules:
- apiGroups: [""]
  resources: ["pods", "services"]
  verbs: ["get", "list", "watch"]
```

The `monitoring` ClusterRole's effective rules grow to include `read-pods-and-services`'s rules. Magic — letting third parties extend your RBAC without you editing your roles.

`admin`, `edit`, `view` are aggregated; many operators add their own rules into them by labeling their CRD-related ClusterRoles.

---

## Imperative shortcuts (kubectl)

Faster than writing YAML for simple cases:

```bash
# Create a Role
kubectl create role pod-reader \
  --verb=get,list,watch \
  --resource=pods \
  -n dev

# Create a ClusterRole
kubectl create clusterrole secret-reader \
  --verb=get,list,watch \
  --resource=secrets

# Create a RoleBinding
kubectl create rolebinding alice-pods \
  --role=pod-reader \
  --user=alice \
  -n dev

# Create a ClusterRoleBinding
kubectl create clusterrolebinding cluster-admins \
  --clusterrole=cluster-admin \
  --group=kubeadm:cluster-admins

# Bind a ClusterRole to a user in a namespace (RoleBinding pointing at ClusterRole)
kubectl create rolebinding alice-edit \
  --clusterrole=edit \
  --user=alice \
  -n dev

# Bind to a ServiceAccount
kubectl create rolebinding sa-pods \
  --role=pod-reader \
  --serviceaccount=dev:my-sa \
  -n dev
```

`--dry-run=client -o yaml` adds the always-useful "show me the YAML it would create."

---

## Inspecting RBAC

```bash
# List all Roles in a namespace
kubectl get roles -n dev

# List all ClusterRoles
kubectl get clusterroles

# Detail of a specific Role
kubectl describe role pod-reader -n dev
# Or get the raw YAML
kubectl get role pod-reader -n dev -o yaml

# Find what a ClusterRole grants
kubectl describe clusterrole edit

# Find bindings referring to a user
kubectl get rolebinding,clusterrolebinding -A -o json | \
  jq -r '.items[] | select(.subjects[]?.name=="alice") | .metadata.namespace + "/" + .metadata.name'

# Find bindings to a SA
kubectl get rolebinding,clusterrolebinding -A -o json | \
  jq -r '.items[] | select(.subjects[]? | .kind=="ServiceAccount" and .name=="my-sa") |
    [.kind, .metadata.namespace // "-", .metadata.name, .roleRef.name] | @tsv'

# What can the current user do?
kubectl auth can-i --list

# What can a specific user do?
kubectl auth can-i --list --as=alice
```

---

## Common patterns

### Read-only pod access for a SA

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  namespace: dev
  name: pod-watcher
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: dev
  name: pod-watcher-role
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  namespace: dev
  name: pod-watcher-rb
subjects:
- kind: ServiceAccount
  name: pod-watcher
  namespace: dev
roleRef:
  kind: Role
  name: pod-watcher-role
  apiGroup: rbac.authorization.k8s.io
```

### Cluster-wide read-only

Use the pre-installed `view` ClusterRole:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: alice-cluster-view
subjects:
- kind: User
  name: alice
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: view
  apiGroup: rbac.authorization.k8s.io
```

`view` is read-only across most resources but excludes Secrets — by design.

### Operator pattern

A controller running as a SA needs to manage CRs:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: my-operator
rules:
- apiGroups: ["example.com"]
  resources: ["myresources", "myresources/status"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["pods", "configmaps", "secrets", "services"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch"]
```

Then a ClusterRoleBinding to the SA the operator runs as.

---

## Common mistakes

### `roleRef` typo

```yaml
roleRef:
  kind: Role
  name: pod-readers          # actual Role is named "pod-reader"
```

The binding silently grants nothing (binding to nonexistent Role). Apiserver doesn't error — RoleBindings can reference future Roles.

Diagnose with `kubectl describe rolebinding <name>` — you'll see the roleRef but no effect.

### Missing apiGroup in subject

```yaml
subjects:
- kind: User
  name: alice
  # missing apiGroup
```

Validation rejects on creation. Always include `apiGroup: rbac.authorization.k8s.io` for User and Group subjects.

### Forgetting subresource verbs

```yaml
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list"]
```

User gets a 403 on `kubectl logs <pod>`. Add `pods/log` separately.

### Cluster-scoped vs namespaced confusion

A RoleBinding cannot grant access to cluster-scoped resources (Nodes, PersistentVolumes). Use ClusterRoleBinding:

```yaml
# WRONG: namespaced binding for cluster-scoped resource
kind: RoleBinding              # namespaced
metadata:
  namespace: dev
roleRef:
  kind: ClusterRole
  name: node-reader            # ClusterRole granting access to Nodes
                                # User can't read Nodes — RoleBinding can't grant cluster-scoped access
```

For Nodes (cluster-scoped), use ClusterRoleBinding.

### Editing roleRef

```bash
kubectl edit rolebinding alice
# change roleRef.name
# Save → ERROR: roleRef is immutable
```

Delete and recreate the binding. `roleRef` cannot be changed.

---

## Exam heuristics

- For "give Alice read access to Pods in `dev`," create a Role + RoleBinding.
- For "give a SA cluster-wide access," create a ClusterRoleBinding.
- Use `kubectl create role/rolebinding` shortcuts; faster than YAML.
- Always include subresources if the task involves logs, exec, scale, etc.
- `kubectl auth can-i --list --as=<user>` confirms whether your binding worked.

## Mental traps

- Adding multiple permissions to one rule when separate rules would be clearer.
- Forgetting that RBAC is additive — there's no deny.
- Using `*` wildcards casually. Tight RBAC is best practice.
- Confusing Role with ClusterRole when the resource is cluster-scoped (Node → must be ClusterRole/CRB).
- Setting subjects' `apiGroup` wrong (or missing).
- Editing `roleRef` and being surprised it's immutable. Delete + recreate.
- Forgetting to grant `bind` / `escalate` when needed for users to manage RBAC themselves.
- Granting access to `secrets` casually. Defaults often have `view` excluding Secrets for a reason.
