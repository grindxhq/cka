## Two scopes, one apiserver

Every Kubernetes resource is either **namespaced** (lives in one namespace) or **cluster-scoped** (lives at the cluster level, no namespace). RBAC works differently for each.

```
                          ┌────────── apiserver ──────────┐
                          │                                │
                          │   Cluster-scoped resources:    │
                          │   - Nodes                      │
                          │   - PersistentVolumes          │
                          │   - StorageClasses             │
                          │   - ClusterRoles               │
                          │   - Namespaces                  │
                          │   - CustomResourceDefinitions  │
                          │                                │
                          ├──────────── ns: dev ───────────┤
                          │ Pods, Services, Deployments    │
                          │ ConfigMaps, Secrets, PVCs       │
                          │ Roles, RoleBindings            │
                          ├──────────── ns: prod ──────────┤
                          │ ... same kinds ...             │
                          └────────────────────────────────┘
```

A Pod in `dev` is a different object from a Pod in `prod`, even with the same name. RBAC has to identify which scope a rule applies to.

---

## How to tell what's namespaced

```bash
kubectl api-resources

# NAME              SHORTNAMES   APIVERSION   NAMESPACED   KIND
# pods              po           v1           true         Pod
# services          svc          v1           true         Service
# nodes             no           v1           false        Node          ← cluster-scoped
# persistentvolumes pv           v1           false        PersistentVolume   ← cluster-scoped
# configmaps        cm           v1           true         ConfigMap
# rolebindings                   rbac.../v1   true         RoleBinding
# clusterrolebindings           rbac.../v1   false        ClusterRoleBinding   ← cluster-scoped
# namespaces        ns           v1           false        Namespace     ← cluster-scoped
# storageclasses    sc           storage.../v1 false        StorageClass  ← cluster-scoped
# customresourcedefinitions crd apiextensions.../v1 false  CustomResourceDefinition   ← cluster-scoped
```

`NAMESPACED: true` = namespaced. `false` = cluster-scoped.

Filter to just one type:

```bash
kubectl api-resources --namespaced=false        # all cluster-scoped
kubectl api-resources --namespaced=true         # all namespaced
```

Also handy: `kubectl api-resources -o wide --verbs=delete` shows only resources that support deletion (rare to filter this way, but useful).

---

## RBAC scope rules

Four combinations:

| Subject's binding type | Role/ClusterRole bound | Effect                                         |
|------------------------|-----------------------|------------------------------------------------|
| RoleBinding (in ns X)  | Role (in ns X)        | Permissions in ns X only                        |
| RoleBinding (in ns X)  | ClusterRole           | Permissions in ns X only (rules limited to namespaced resources) |
| ClusterRoleBinding     | Role                  | Not allowed — apiserver rejects                |
| ClusterRoleBinding     | ClusterRole           | Permissions cluster-wide                        |

**RoleBinding can reference a ClusterRole**, but the binding's scope (the namespace) limits the effect. Use this pattern to grant a pre-installed ClusterRole's permissions within one namespace:

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
  kind: ClusterRole               # pre-installed `edit` ClusterRole
  name: edit
  apiGroup: rbac.authorization.k8s.io
```

Alice gets `edit` permissions, but only in `dev`. The same ClusterRoleBinding would give her `edit` everywhere.

This is the typical pattern for granting builtin ClusterRoles per-namespace.

---

## Cluster-scoped resources need ClusterRoles

A user who needs to access Nodes, PersistentVolumes, etc. requires:

- A **ClusterRole** with the rules.
- A **ClusterRoleBinding** to grant the role.

Trying to grant cluster-scoped access via RoleBinding silently fails — the rule applies but the resource is "outside" the binding's scope.

Example that doesn't work:

```yaml
# Wrong: RoleBinding can't grant access to Nodes
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: node-admin }
rules:
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding              # ← namespaced binding!
metadata:
  namespace: dev
  name: alice-node-admin
subjects:
- kind: User
  name: alice
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: node-admin
```

Alice still can't `kubectl get nodes`. Nodes are cluster-scoped; a RoleBinding can only grant namespaced access.

Correct:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: alice-node-admin }
subjects:
- kind: User
  name: alice
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: node-admin
```

---

## RoleBinding to a ClusterRole — the rule subset

When a RoleBinding references a ClusterRole, the rules apply but **only for namespaced resources within the RoleBinding's namespace**.

If the ClusterRole has rules for cluster-scoped resources (e.g. Nodes), those rules are ignored when accessed via a RoleBinding.

Example: the pre-installed `view` ClusterRole has rules covering both namespaced and some cluster-scoped resources (e.g. `nodes`). Bind it via RoleBinding in `dev`:

- Alice can `view` namespaced resources (Pods, Services, etc.) **in `dev`**.
- Alice **cannot** `view` Nodes (cluster-scoped → RoleBinding can't grant).

To get Node access, ClusterRoleBinding to `view`. Or write a separate `node-viewer` ClusterRole + ClusterRoleBinding.

---

## Built-in ClusterRoles and their scope

| ClusterRole       | Permissions                                                                                          |
|-------------------|------------------------------------------------------------------------------------------------------|
| `cluster-admin`   | Everything everywhere. Bound via ClusterRoleBinding to `system:masters` group by default.           |
| `admin`           | Full access to most resources within a namespace, including managing RBAC. Excludes cluster-scoped.  |
| `edit`            | Read/write on workload resources. No RBAC, no Secrets read (you can edit Secrets but not see existing ones). |
| `view`            | Read-only on most resources. **Excludes Secrets**, **excludes RBAC objects**.                        |

When you bind these via:

- **ClusterRoleBinding** — full effect, cluster-wide.
- **RoleBinding** in ns X — namespaced subset, in X only.

So `RoleBinding` to `admin` in `dev` gives admin powers in `dev`. Same `admin` via ClusterRoleBinding gives namespace-admin everywhere.

---

## Common mistake: scope mix-ups

### Granting Node access via RoleBinding

```bash
kubectl auth can-i get nodes --as=alice
# no
```

You probably bound a Node-granting ClusterRole via RoleBinding instead of ClusterRoleBinding.

```bash
# Check
kubectl get rolebinding,clusterrolebinding -A -o json | \
  jq -r '.items[] | select(.subjects[]?.name=="alice") | [.kind, .metadata.namespace // "<cluster>"] | @tsv'
```

If the binding kind is `RoleBinding`, switch to `ClusterRoleBinding`.

### Trying to scope a Role to multiple namespaces

A Role exists in **one** namespace. To grant the same permissions in three namespaces, you need either:

1. Three separate Roles (clunky, hard to keep in sync).
2. One ClusterRole + three RoleBindings (better):

```yaml
# ClusterRole defines the rules once
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: pod-reader }
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
---
# Three RoleBindings, one per namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { namespace: dev, name: alice-pod-reader }
subjects: [ { kind: User, name: alice, apiGroup: rbac.authorization.k8s.io } ]
roleRef: { kind: ClusterRole, name: pod-reader, apiGroup: rbac.authorization.k8s.io }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { namespace: staging, name: alice-pod-reader }
# ... same subjects + roleRef
---
# (and one for prod)
```

Update the ClusterRole once → all three namespaces get the change.

---

## Listing resources by scope

```bash
# All namespaced resources Alice can list (across the cluster — but only in namespaces she has bindings)
for ns in $(kubectl get ns -o name | sed 's|namespace/||'); do
  if kubectl auth can-i list pods --as=alice -n $ns >/dev/null 2>&1; then
    echo "$ns: yes"
  fi
done

# All cluster-scoped resources
kubectl api-resources --namespaced=false
```

Cluster-scoped resources don't have a namespace concept. `kubectl get nodes` works only with cluster-level access.

---

## The Namespace resource itself is cluster-scoped

```bash
kubectl get namespace dev
# Pods, ConfigMaps in `dev` are namespaced. The Namespace OBJECT is cluster-scoped.
```

To grant "alice can create namespaces":

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: namespace-admin }
rules:
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get", "list", "watch", "create", "delete"]
```

ClusterRoleBinding (not RoleBinding) for this to take effect.

---

## RBAC objects themselves: scope rules

| Resource             | Scope          | RBAC verbs apply where                         |
|----------------------|----------------|------------------------------------------------|
| `Role`               | namespaced     | Per-namespace                                  |
| `RoleBinding`        | namespaced     | Per-namespace                                  |
| `ClusterRole`        | cluster-scoped | Cluster-wide                                   |
| `ClusterRoleBinding` | cluster-scoped | Cluster-wide                                   |

So to let a user **manage RBAC in their own namespace**:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: dev
  name: rbac-admin
rules:
- apiGroups: ["rbac.authorization.k8s.io"]
  resources: ["roles", "rolebindings"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
```

Alice can manage Roles and RoleBindings in `dev`. She still can't touch ClusterRoles.

To stop privilege escalation: this Role lets Alice create *any* Role with *any* rule. To create rules that exceed her own permissions, she needs `escalate` (which she doesn't get unless explicitly granted). So she can write Roles, but can't grant herself capabilities she doesn't already have.

---

## Cross-namespace patterns

### A ClusterRole used by many RoleBindings

The cleanest way to share rules:

```
ClusterRole: read-only-pods
  ↑                    ↑                ↑
  RoleBinding/dev      RoleBinding/staging   RoleBinding/prod
  (alice)              (alice)               (devops group)
```

One ClusterRole, three RoleBindings. Update rules once, applies everywhere.

### Aggregated ClusterRoles

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring
  labels:
    rbac.example.com/aggregate-to-monitoring: "true"
aggregationRule:
  clusterRoleSelectors:
  - matchLabels:
      rbac.example.com/aggregate-to-monitoring: "true"
rules: []
```

Other ClusterRoles labeled `rbac.example.com/aggregate-to-monitoring: "true"` get their rules folded in. Applied via RoleBinding to a specific namespace, the user gets the union of all rules.

---

## Inspecting what a ClusterRole grants

```bash
kubectl describe clusterrole admin

# Verifies what the pre-installed `admin` ClusterRole actually permits.
# Note this is namespace-admin (no cluster-scoped), but you can grant it cluster-wide via ClusterRoleBinding (not common).
```

For programmatic introspection:

```bash
# JSON dump
kubectl get clusterrole admin -o yaml

# Resources covered
kubectl get clusterrole admin -o json | jq '.rules[] | {apiGroups, resources, verbs}' | head -30
```

---

## Practical examples

### Lab researcher — full access to one namespace, view-only elsewhere

```yaml
# Full access in `lab`
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  namespace: lab
  name: researcher-admin
subjects:
- kind: User
  name: researcher
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: admin
  apiGroup: rbac.authorization.k8s.io

---
# View-only across all namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: researcher-cluster-view
subjects:
- kind: User
  name: researcher
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: view
  apiGroup: rbac.authorization.k8s.io
```

The two bindings union: full admin in `lab`, view everywhere (including `lab`, but the namespaced admin binding effectively dominates).

### Operator with cluster-scoped resources

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: my-operator }
rules:
- apiGroups: ["example.com"]
  resources: ["myresources"]               # cluster-scoped CR
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["nodes"]                      # cluster-scoped
  verbs: ["get", "list", "watch"]
- apiGroups: ["storage.k8s.io"]
  resources: ["storageclasses"]              # cluster-scoped
  verbs: ["get", "list", "watch"]
- apiGroups: [""]                            # namespaced
  resources: ["pods", "configmaps"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch"]
```

Mix of cluster-scoped and namespaced rules. Bind via ClusterRoleBinding (for the cluster-scoped portion) — the namespaced rules then apply across all namespaces.

---

## Common pitfalls

### Forgetting that the same ClusterRole behaves differently when bound differently

`view` via ClusterRoleBinding = view everything. Same `view` via RoleBinding in `dev` = view things in `dev`. Same Role, different scope.

### Using a Role when a ClusterRole is needed (cluster-scoped resource)

```yaml
kind: Role
metadata: { namespace: dev, name: node-reader }
rules:
- apiGroups: [""]
  resources: ["nodes"]            # cluster-scoped resource in a namespaced Role
  verbs: ["get", "list"]
```

The Role is created without error, but its rules are dead — they target a cluster-scoped resource from a namespace-scoped binding. No effect.

### Creating ClusterRoleBinding to a Role (not ClusterRole)

```yaml
kind: ClusterRoleBinding
roleRef:
  kind: Role            # ← invalid: ClusterRoleBinding requires ClusterRole
  name: pod-reader
```

Apiserver rejects: `roleRef.kind: Forbidden: this RBAC object can only reference a ClusterRole`.

### Granting cluster-scoped access in a multi-tenant cluster

A user with cluster-scoped read-all-namespaces (e.g. `view` via ClusterRoleBinding) can see Secrets in every namespace — even ones they shouldn't. Be deliberate about cluster-wide bindings in multi-tenant clusters.

---

## Diagnostic commands

```bash
# What's namespaced vs not?
kubectl api-resources --namespaced=true
kubectl api-resources --namespaced=false

# All bindings affecting a specific user, by scope:
kubectl get rolebinding,clusterrolebinding -A -o json | \
  jq -r '.items[] | select(.subjects[]?.name=="alice") |
    "\(.kind) in \(.metadata.namespace // "cluster") referencing \(.roleRef.kind)/\(.roleRef.name)"'

# Effective permissions for alice in dev
kubectl auth can-i --list --as=alice -n dev

# Effective permissions for alice cluster-wide
kubectl auth can-i --list --as=alice
```

---

## Exam heuristics

- For "alice can manage X in namespace dev," use Role + RoleBinding (or ClusterRole + RoleBinding for shared rules).
- For "alice can list Nodes," ClusterRole + ClusterRoleBinding (Nodes are cluster-scoped).
- For "give alice access to namespace X but not Y," scope the RoleBinding to X.
- The pre-installed `admin` / `edit` / `view` ClusterRoles are reusable — don't write your own from scratch unless you need something specific.
- `kubectl auth can-i --list --as=alice -n dev` quickly verifies your setup.

## Mental traps

- Granting cluster-scoped access via RoleBinding. Doesn't work; use ClusterRoleBinding.
- Writing rules for cluster-scoped resources in a namespaced Role. They're ignored.
- ClusterRoleBinding to a (namespaced) Role. Apiserver rejects.
- Confusing namespaced RBAC with namespace isolation. RBAC governs **API access**, not network or admission. A user with namespaced RBAC can still see other namespaces if they have list access — namespaces are a list-resource themselves.
- Putting RBAC rules for `namespaces` in a Role (it's cluster-scoped — needs ClusterRole).
- Forgetting that `system:masters` group bypasses RBAC entirely.
- Granting `view` cluster-wide and being surprised users can read Secrets in all namespaces — `view` excludes Secrets by design, but other broad ClusterRoles like `admin` don't.
