## Three controllers, one theme

These three controllers maintain the **identity and scope primitives** of a cluster:

- **Namespace controller** — creates/deletes namespaces, enforces finalization.
- **ServiceAccount controller** — ensures every namespace has a `default` ServiceAccount.
- **Token controllers** (legacy + TokenRequest) — provide mounted credentials pods use to call the API.

They are unglamorous but cause a surprising amount of exam-relevant failures.

## Namespace controller

Owns two behaviors:

1. **Default ServiceAccount creation** — when a Namespace is created, the namespace controller (and SA controller) ensure a `default` ServiceAccount exists in it.
2. **Termination** — when a Namespace is deleted, the controller walks **every API resource type** in that namespace and deletes it, respecting finalizers.

### Namespace finalizers

A Namespace has `spec.finalizers: ["kubernetes"]` by default. While any finalizer is present, the Namespace stays in `Terminating` phase. The controller removes the finalizer only after all contained objects are gone.

Common cause of "stuck Terminating" namespaces:

- A resource with its own finalizer that can't complete (e.g. a CR whose controller is gone).
- A CRD whose definition was removed before the CRs — object cannot be deleted because its type does not exist.
- A PV bound to a PVC in the namespace, with `Retain` policy, and the controller hangs on cleanup.

Diagnose:

```bash
kubectl get ns <ns> -o yaml | sed -n '/spec:/,/status:/p'
kubectl api-resources --verbs=list --namespaced -o name | \
  xargs -n1 -I {} kubectl get {} -n <ns> --ignore-not-found
```

The second command lists every namespaced resource still in the namespace. Delete leftover items with stuck finalizers by **removing their finalizer** (patch):

```bash
kubectl patch <type> <name> -n <ns> --type=merge -p '{"metadata":{"finalizers":null}}'
```

Do not clear the Namespace's own finalizer blindly — that orphans its resources. Fix the underlying finalizer first.

### Force-terminate (last resort)

```bash
kubectl get ns <ns> -o json | \
  jq 'del(.spec.finalizers)' | \
  kubectl replace --raw "/api/v1/namespaces/<ns>/finalize" -f -
```

This bypasses the safety net. Use only when you're sure the contents are gone.

## ServiceAccount controller

Responsibilities:

1. Ensure every Namespace has a `default` ServiceAccount.
2. Historically, auto-generate a `*-token-*` Secret for each ServiceAccount and add it to `.secrets` and `.imagePullSecrets`.

The token Secret auto-creation is **disabled by default** on modern clusters (Kubernetes 1.24+). Token Secrets are only created on explicit request.

### Creating a bound token Secret (when you want one)

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

The token controller populates `.data.token`, `.data.ca.crt`, `.data.namespace` after creation. Useful for long-lived kubeconfigs for external clients.

## TokenRequest API (the modern way)

Pods don't use static Secret tokens on modern clusters. Instead, kubelet mounts a **projected ServiceAccount token** using the `TokenRequest` API:

```yaml
volumes:
  - name: token
    projected:
      sources:
        - serviceAccountToken:
            path: token
            expirationSeconds: 3600
            audience: api
```

Benefits:

- Short-lived (default one hour), rotated automatically by kubelet.
- Audience-bound (valid for only the named audience).
- Tied to the pod's lifetime (invalidated when pod dies).

This is what you find mounted at `/var/run/secrets/kubernetes.io/serviceaccount/token` inside every pod by default.

Inspect a live token:

```bash
kubectl exec <pod> -- cat /var/run/secrets/kubernetes.io/serviceaccount/token | \
  cut -d. -f2 | base64 -d 2>/dev/null | jq
```

You'll see fields like `iss`, `aud`, `exp`, `kubernetes.io.serviceaccount` — JWT claims the apiserver validates.

## Creating & using ServiceAccounts (fast recap)

```bash
# Create
kubectl create sa my-sa

# Bind a role
kubectl create rolebinding my-binding \
  --role=my-role \
  --serviceaccount=default:my-sa

# Run a pod as that SA
kubectl run app --image=nginx --serviceaccount=my-sa
# or in YAML:
# spec:
#   serviceAccountName: my-sa
```

Every pod has a ServiceAccount. If you don't set one, it is `default` in the pod's namespace. The `default` SA typically has no permissions; giving it broad access is a common CKS anti-pattern (and shows up on CKA as "why does this pod have cluster-admin?").

## Disabling the auto-mount

If a pod does not need to call the API, you can opt out:

```yaml
spec:
  automountServiceAccountToken: false
```

(Or set it on the ServiceAccount itself, which cascades.)

Result: no token projected volume mounted. Good hygiene for things like nginx ingress pods that just serve traffic.

## Debugging identity problems

Symptoms and fast checks:

- **"Forbidden" from inside a pod** — wrong SA or missing RBAC.
  ```bash
  kubectl auth can-i get pods --as=system:serviceaccount:<ns>:<sa>
  ```
- **Token expired** — look at JWT `exp` vs current time.
- **Pod uses the wrong SA** — check `spec.serviceAccountName`. Missing means `default`.
- **TokenRequest fails in-pod** — usually a time-skew or apiserver cert issue.

## Fast fixes

- **Create a missing SA**: `kubectl create sa <name> -n <ns>`.
- **Grant a permission**: Role + RoleBinding (namespaced) or ClusterRole + ClusterRoleBinding (cluster).
- **Fix "Forbidden" on an existing pod**: bind its SA to a sufficient role; pod doesn't need restart — subsequent API calls use the new permissions.

## Exam heuristics

- For RBAC questions, always use `kubectl auth can-i ... --as=<user-or-sa>`. It is the fastest verification.
- Know the verbose `system:serviceaccount:<ns>:<sa>` format — RoleBindings reference subjects with this exact shape.
- If the exam wants long-lived tokens (unusual but appears), create a Secret with the `service-account-token` type and the `.name` annotation.

## Mental traps

- Thinking every pod has an API token automatically and that that token is long-lived. Modern tokens are short-lived and pod-scoped.
- Removing a Namespace's finalizer to unstick it without checking what's inside. You orphan the contents.
- Forgetting namespaces are **cluster-scoped** but contain namespaced resources. Deleting a namespace cascades.
- Assuming the `default` ServiceAccount has no permissions. It usually doesn't, but some clusters bind `edit` to it in dev. Always verify.
- Mixing `ServiceAccount` (workload identity) with `User` (human identity). Both are RBAC subjects but come from different identity sources.
