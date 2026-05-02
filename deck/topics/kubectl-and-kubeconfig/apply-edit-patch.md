## Five ways to change a resource

kubectl exposes several mutation commands, each with different semantics:

| Command            | Semantics                                                         | Best for                                       |
|--------------------|--------------------------------------------------------------------|------------------------------------------------|
| `apply`            | Declarative. Diffs against last-applied; preserves managed fields | GitOps, CI/CD, anything reproducible            |
| `create`           | Imperative create. Errors if object exists.                        | One-off creation                                |
| `replace`          | Imperative full replacement. Errors if not exists (unless `--force`)| Full overwrite                                  |
| `edit`             | Interactive: opens YAML in $EDITOR, applies the diff               | Quick manual tweaks                             |
| `patch`            | Imperative partial update via patch document                       | Programmatic / scripted small changes           |
| `set <subcommand>` | Imperative shorthand for common patches                            | Common changes (image, env, resources)          |

Picking the right tool matters for both correctness and speed.

---

## `apply` — the declarative path

```bash
kubectl apply -f deployment.yaml
```

Behavior:

- If the object doesn't exist → creates it.
- If it exists → does a **three-way merge** between:
  1. Your YAML (the desired state).
  2. The live state in the cluster.
  3. The "last applied" annotation (what you applied previously).

This three-way merge is what lets `apply` add new fields without clobbering things others added (e.g. controller-injected fields, manual overrides).

```bash
# Initial apply
kubectl apply -f deploy.yaml
# Sets metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] = your YAML.

# Cluster-side: someone else (or a controller) adds a label.

# Re-apply with new image
kubectl apply -f deploy.yaml         # only the changed image is sent; existing label preserved.
```

### Apply with multiple files / directories

```bash
kubectl apply -f deploy.yaml -f service.yaml
kubectl apply -f kustomize/                   # all .yaml in that dir
kubectl apply -k kustomize/                   # kustomize-aware (with kustomization.yaml)
kubectl apply -f https://example.com/manifest.yaml
```

### Server-Side Apply (SSA)

Modern alternative (1.22+ stable):

```bash
kubectl apply -f deploy.yaml --server-side
```

The merge happens on the server. Fields are tracked by a "field manager" (your kubectl session, or a controller). Multiple managers can co-own different fields.

Benefits:

- Cleaner conflict detection (errors instead of silent overwrites).
- Better suited to controller scenarios (one controller manages `replicas`, another manages `template.image`).
- No `last-applied-configuration` annotation needed.

```bash
# Force-take over fields managed by someone else
kubectl apply -f deploy.yaml --server-side --force-conflicts
```

For exam: client-side apply (default) is what you'll use most. Recognize SSA when you see it.

---

## `create` — strict create

```bash
kubectl create -f pod.yaml
```

If the pod already exists: error. Different from `apply` which would update.

Use cases:

- Generating one-off resources via imperative shortcuts:
  ```bash
  kubectl create deploy web --image=nginx --replicas=3
  kubectl create configmap app-config --from-literal=DB_HOST=db.local
  kubectl create secret generic app-secret --from-literal=API_KEY=xxx
  kubectl create role pod-reader --verb=get,list --resource=pods
  ```
- The `--dry-run=client -o yaml` pattern to generate starter manifests.

For YAML files, `apply` is usually what you want (idempotent). Use `create` when you need the "don't overwrite" guarantee.

---

## `replace` — full overwrite

```bash
kubectl replace -f pod.yaml
```

Replaces the entire object's spec with what's in the file. Errors if the object doesn't exist.

```bash
# Replace only if it doesn't exist OR delete + recreate atomically
kubectl replace --force -f pod.yaml
```

`--force` deletes the existing object and creates a new one with the new YAML. Useful when:

- The change is to an immutable field (e.g. selector, certain Job fields).
- You want a fresh object without the old state.

Risks:

- Cascade deletion: the old object's children (Pods of a Deployment) get deleted too.
- Brief downtime.

`replace --force` is the heavy hammer. Use only when needed.

---

## `edit` — interactive

```bash
kubectl edit deploy web
```

Opens the resource's YAML in `$EDITOR` (or `vi` if unset). Saving the file applies a diff to the live object.

Behind the scenes: `kubectl edit` does a `kubectl get -o yaml`, lets you edit, then runs the equivalent of `kubectl apply` with the result.

Useful for:

- Quick interactive tweaks during debugging.
- Exploring the schema while changing one field.

Avoid for:

- Production changes (no audit trail beyond the apiserver's events).
- Bulk operations.

If you save without changes, kubectl detects no diff and exits silently.

If your edit introduces an invalid YAML or schema violation, kubectl shows the error and offers to re-edit.

---

## `patch` — programmatic partial update

```bash
# Strategic merge patch (default — kubectl-aware merging)
kubectl patch deploy web -p '{"spec":{"replicas":5}}'

# JSON patch (RFC 6902)
kubectl patch deploy web --type=json -p='[{"op":"replace","path":"/spec/replicas","value":5}]'

# Merge patch (RFC 7396)
kubectl patch deploy web --type=merge -p '{"spec":{"replicas":5}}'
```

Three patch types — different use cases:

### Strategic merge patch (default)

Kubernetes-aware merging. For lists, uses keys defined in the schema (`name` for containers, `mountPath` for volumeMounts).

```bash
# Add an env var to a container (keyed by `name`)
kubectl patch deploy web -p '
spec:
  template:
    spec:
      containers:
      - name: web
        env:
        - name: NEW_VAR
          value: hello
'
```

The patch finds the container with `name: web` and merges `env` into its existing list. `name: web` matched → strategic merge.

### JSON patch (`--type=json`)

RFC 6902. Operations like `add`, `replace`, `remove`, `move`. Path uses JSON Pointer syntax:

```bash
# Replace the first container's image
kubectl patch deploy web --type=json -p='[
  {"op": "replace", "path": "/spec/template/spec/containers/0/image", "value": "nginx:1.27"}
]'

# Remove a label
kubectl patch pod my-pod --type=json -p='[
  {"op": "remove", "path": "/metadata/labels/old-key"}
]'

# Add to a list
kubectl patch deploy web --type=json -p='[
  {"op": "add", "path": "/spec/template/spec/containers/0/env/-", "value": {"name": "X", "value": "y"}}
]'
```

`/-` at the end of a path means "append to list."

JSON patch is **the most precise** — exact paths, exact operations. Use when strategic merge isn't expressing what you want.

### Merge patch (`--type=merge`)

RFC 7396. Like strategic merge but without the keyed-list intelligence. For lists: replace entirely (no merging by key).

```bash
kubectl patch pod my-pod --type=merge -p '{"metadata":{"labels":{"new":"value"}}}'
# Adds the label.

kubectl patch pod my-pod --type=merge -p '{"spec":{"containers":[{"name":"app","image":"nginx:1.27"}]}}'
# Replaces the entire containers list with this single entry — probably not what you want.
```

Avoid `--type=merge` for lists; prefer strategic merge.

### Common patches

```bash
# Scale (also: kubectl scale deploy/web --replicas=5)
kubectl patch deploy web -p '{"spec":{"replicas":5}}'

# Add a label
kubectl patch pod my-pod -p '{"metadata":{"labels":{"version":"v2"}}}'

# Remove a finalizer (force-delete a stuck object)
kubectl patch pod my-pod --type=json -p='[{"op":"remove","path":"/metadata/finalizers"}]'
# Or:
kubectl patch pod my-pod -p '{"metadata":{"finalizers":[]}}' --type=merge

# Update an image
kubectl patch deploy web -p '{"spec":{"template":{"spec":{"containers":[{"name":"web","image":"nginx:1.27"}]}}}}'
# Faster: kubectl set image deploy/web web=nginx:1.27
```

---

## `kubectl set` — common patches as commands

Convenience wrappers for frequent patches:

```bash
# Image
kubectl set image deploy/web web=nginx:1.27

# Resources
kubectl set resources deploy/web --requests=cpu=100m,memory=128Mi --limits=cpu=500m,memory=512Mi

# Env vars
kubectl set env deploy/web FOO=bar BAZ=qux
kubectl set env deploy/web FOO-                         # remove
kubectl set env deploy/web --from=secret/db-creds      # set from a Secret

# ServiceAccount
kubectl set serviceaccount deploy/web my-sa

# Subject of a (Cluster)RoleBinding
kubectl set subject clusterrolebinding view --user=alice
```

These all do strategic-merge patches. Faster than writing the patch JSON.

---

## Choosing between them

```
 Need to create something?
 │
 ├── From file → kubectl apply -f
 │
 └── Imperative → kubectl create / kubectl run

 Need to update an existing thing?
 │
 ├── Have the desired YAML → kubectl apply -f          (idempotent, GitOps-friendly)
 ├── Quick interactive tweak → kubectl edit
 ├── Common change (image / replicas / env) → kubectl set / scale
 ├── Programmatic / scripted → kubectl patch
 └── Total replacement / immutable field → kubectl replace --force

 Need to delete something?
 │
 └── kubectl delete <kind> <name>
```

For CKA: `apply`, `set image`, `scale`, `edit`, `patch` cover most exam tasks.

---

## Server-Side vs Client-Side details

Modern kubectl negotiates server-side apply by default for some flows. Differences:

| Aspect             | Client-side                                  | Server-side                                   |
|--------------------|----------------------------------------------|-----------------------------------------------|
| Where merge happens | Client computes diff, sends patch            | Server computes merge, applies                |
| `last-applied-configuration` annotation | Required                  | Not used                                      |
| Conflict handling  | Last writer wins, silent                     | Conflict error if two managers touched same field |
| Field ownership     | Implicit (client tracks via annotation)      | Explicit (server stores per-field manager)    |

For everyday kubectl, client-side is fine. For controllers and complex multi-tool environments, server-side is more correct.

---

## Resource managers and field ownership (SSA)

With server-side apply, every field has a "manager" — the entity that owns it.

```bash
kubectl get deploy web -o yaml | yq '.metadata.managedFields'
# - manager: kubectl-client-side-apply
#   operation: Apply
#   fieldsType: FieldsV1
#   fieldsV1:
#     ...
# - manager: kube-controller-manager
#   operation: Update
#   ...
```

If two managers try to own the same field, you get a conflict (with SSA). Resolve via:

- `--force-conflicts` to take ownership.
- Coordinating between operators / pipelines.

Mostly relevant for advanced multi-controller scenarios. Day-to-day, not something you think about.

---

## Common mistakes

### Apply-loop on a bad YAML

You apply, get an error, fix YAML, apply again. The first apply may have created a partial resource (e.g. CRD without the controller running yet). Reapply works.

But if the error was a schema violation, the resource never got created. Apply again.

### Editing managed-by-controller fields

A Deployment controller manages `status`. Editing it does nothing — controller overwrites on next reconcile.

Edit `spec`, not `status`. (kubectl edit defaults to YAML representation; you can edit anything but only spec changes persist meaningfully.)

### Patch with --type=merge on lists

```bash
kubectl patch pod my-pod --type=merge -p '{"metadata":{"finalizers":["new-finalizer"]}}'
# REPLACES the finalizers list with just ["new-finalizer"], removing whatever was there.
```

For surgical list edits, use `--type=json` with explicit `add`/`remove` ops.

### Forgetting `--type=json` quoting

```bash
kubectl patch deploy web --type=json -p='[{"op":"replace","path":"/spec/replicas","value":5}]'
# Single quotes around the JSON; double inside.
```

Mismatched quotes → shell expansion errors → confusing error messages.

### `kubectl edit` saves nothing

You edited but kubectl says "no changes." Usually because:

- Your edits matched the existing values.
- You edited a field controller managed (it normalized back).

Confirm by running `kubectl get -o yaml` again to see the live state.

### `replace` errors when object doesn't exist

```
Error from server (NotFound): error when replacing "x.yaml": pods "x" not found
```

`replace` requires the object to exist. Use `apply` for create-or-update semantics.

---

## Bulk operations

```bash
# Apply everything in a directory
kubectl apply -f manifests/

# Delete everything in the same directory
kubectl delete -f manifests/

# Recursive
kubectl apply -f manifests/ -R

# Multiple files
kubectl apply -f a.yaml -f b.yaml -f c.yaml

# Pipe from stdin
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: test
data:
  key: value
EOF
```

For complex multi-file deployments, `kustomize` adds layering / patching:

```bash
kubectl apply -k overlays/production/
```

---

## Diff before apply

```bash
kubectl diff -f deployment.yaml
```

Shows what would change if you applied. Useful for code review of YAML changes:

```bash
git diff main -- deployment.yaml | head      # what changed in the file
kubectl diff -f deployment.yaml               # what would change in the cluster
```

---

## Audit trail

Apiserver logs every API call. With audit logging enabled (see api-server → authn-authz-admission deck), every `apply` / `patch` / `delete` is recorded.

For your own log:

- Use `kubectl --record` (deprecated but still works) to add change-cause annotations.
- Or `kubectl annotate <kind> <name> kubernetes.io/change-cause="reason"` after the fact.

For long-term tracking, GitOps (Argo CD, Flux) gives you full history via Git.

---

## Imperative shortcuts cheat sheet

```bash
# Create
kubectl create deploy web --image=nginx --replicas=3
kubectl create svc clusterip my-svc --tcp=80:8080
kubectl create cm config --from-literal=key=value --from-file=path/to/file
kubectl create secret generic creds --from-literal=password=xxx
kubectl create secret tls tls-secret --cert=cert.pem --key=key.pem
kubectl create secret docker-registry reg --docker-server=... --docker-username=... ...
kubectl create job test --image=busybox --command -- sleep 30
kubectl create cronjob backup --schedule="0 2 * * *" --image=backup:1.0
kubectl create role pod-reader --verb=get,list --resource=pods
kubectl create rolebinding alice-pods --role=pod-reader --user=alice
kubectl create sa my-sa

# Run a one-off pod
kubectl run my-pod --image=nginx
kubectl run my-pod --image=nginx --rm -it -- sh
kubectl run my-pod --image=nginx --restart=Never                # bare pod, no controller

# Modify
kubectl set image deploy/web web=nginx:1.27
kubectl set resources deploy/web --requests=cpu=100m
kubectl set env deploy/web FOO=bar
kubectl scale deploy/web --replicas=5
kubectl autoscale deploy/web --min=2 --max=10 --cpu-percent=80

# Annotate / label
kubectl label pod my-pod tier=frontend
kubectl annotate deploy/web kubernetes.io/change-cause="upgrade nginx"

# Delete
kubectl delete pod my-pod
kubectl delete pod my-pod --grace-period=0 --force        # force, skip grace
kubectl delete pods --all -n dev                            # all in namespace
```

Combine with `--dry-run=client -o yaml` to generate YAML for any of these.

---

## Exam heuristics

- For "create a Deployment with image X," use `kubectl create deploy ... --image=`.
- For "update the image," `kubectl set image`.
- For "scale a Deployment," `kubectl scale`.
- For "fix this YAML, apply it," `kubectl apply -f`.
- For "modify a live resource quickly," `kubectl edit`.
- For "force a Deployment's pods to restart," `kubectl rollout restart`.

## Mental traps

- Using `replace` when you wanted `apply`. Replace requires existing object; apply doesn't.
- Patching a list with `--type=merge` and replacing it instead of adding to it. Use `--type=json` for surgical list ops.
- Editing a resource and forgetting that immutable fields can't change. Use `replace --force`.
- Trusting `kubectl create` for idempotent operations. It errors on existing objects.
- Forgetting `kubectl set` shortcuts; writing patches by hand is slower.
- Confusing `kubectl edit` exit (no changes) with actual no-op (the field was edited but normalized back).
- Mixing `--server-side` and traditional apply randomly. Pick one approach per workflow for sanity.
