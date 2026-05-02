## Why selectors are a quiet pitfall

`spec.selector` on a Deployment is **immutable** after creation. Get it slightly wrong and you have a Deployment that thinks it manages X pods but actually manages Y pods, with no way to fix the mismatch except recreating the Deployment.

Compounding this: `spec.template.metadata.labels` (the labels Pods get) is a separate field, and the two must agree. Drift between them creates orphan Pods or "unable to update" errors.

This subtopic walks every shape of the problem.

---

## The fundamental rule

```
 spec.selector ⊆ spec.template.metadata.labels
```

The pod template's labels must be a **superset** of the selector. The selector is what the Deployment uses to claim ownership of Pods; the template's labels are what new Pods get. If they don't agree, the new Pods don't match the selector, and the Deployment doesn't see them as its own.

```yaml
spec:
  selector:
    matchLabels:
      app: web                # Deployment looks for pods with `app: web`
  template:
    metadata:
      labels:
        app: web              # ← must include `app: web`, may include more
        tier: frontend
```

Extra labels in the template are fine (they're just additional metadata on the Pod). Missing labels in the template (i.e. selector says X, template doesn't have X) is the bug.

---

## What apiserver enforces

When you create a Deployment, apiserver validates:

```
For each (key, value) in spec.selector.matchLabels:
  spec.template.metadata.labels[key] must equal value
```

If not, you get:

```
The Deployment "web" is invalid: spec.template.metadata.labels: Invalid value: ...
selector does not match template `labels`
```

Catch this at creation time. Once created, `spec.selector` is locked.

---

## What "immutable selector" means

```yaml
# This Deployment was created with selector {app: web}.
# Try to change it:
spec:
  selector:
    matchLabels:
      app: web-v2          # ← change attempt
```

Apply:

```
The Deployment "web" is invalid: spec.selector: Invalid value: ...
selector is immutable
```

You cannot edit `spec.selector` after creation. Period. To "change" the selector:

1. Delete the Deployment (which cascades to RSes and Pods, by default).
2. Recreate with the new selector.

`kubectl replace --force -f deploy.yaml` does this in one command — but it's a brutal operation (downtime, all pods recreated).

---

## Why is it immutable?

Because changing the selector mid-life would either:

- **Orphan existing pods** — they no longer match, controller can't see them.
- **Adopt foreign pods** — pods from another Deployment with similar labels get adopted.

Both lead to confusing behavior and data loss potential. Locking the selector prevents the foot-gun.

(StatefulSet and Job have similar immutability rules. ReplicaSet's selector is also immutable.)

---

## The pod-template-hash trick

How does Kubernetes manage rollouts when the selector is fixed? By adding a **pod-template-hash** label.

When the Deployment controller creates a ReplicaSet:

- The RS's selector is `{your-selector} + {pod-template-hash: <hash>}`.
- The RS's pod template adds `pod-template-hash: <hash>` to labels.
- Pods get the hash label.

So:

```yaml
# Deployment selector
selector:
  matchLabels:
    app: web

# ReplicaSet 1 (from old template)
selector:
  matchLabels:
    app: web
    pod-template-hash: 5fd8c9d8f6     # ← controller-injected

# ReplicaSet 2 (from new template)
selector:
  matchLabels:
    app: web
    pod-template-hash: 7c9f4d8a3b
```

Pods from RS-1 have hash 5fd8c9d8f6; Pods from RS-2 have hash 7c9f4d8a3b. Both have `app: web`, so the Deployment sees all of them. Each RS only sees its own (different hash).

This is how rollouts work: each template revision = unique hash = isolated RS, all under one Deployment.

**Implication:** never put `pod-template-hash` in your manual selectors. It's controller-managed.

---

## The selector-too-broad problem

```yaml
selector:
  matchLabels:
    app: web
```

If two Deployments use the same selector, they fight. Both controllers think they own the same pods.

```yaml
# Deployment A
selector: { matchLabels: { app: web } }
template: { labels: { app: web, version: v1 } }
replicas: 3

# Deployment B (deployed later)
selector: { matchLabels: { app: web } }
template: { labels: { app: web, version: v2 } }
replicas: 3
```

Both have `app: web`. Each controller thinks it should have 3 replicas. They both create 3, totalling 6 — but each thinks it has too many (sees the other's pods) and starts deleting.

In practice: Deployment names are different so RSes have different `pod-template-hash` labels, which keeps things partitioned. But if you somehow fixed selectors that overlap on the unique part, you're in for trouble.

**Best practice**: include a unique-per-Deployment label like `app.kubernetes.io/name` in the selector.

```yaml
selector:
  matchLabels:
    app.kubernetes.io/name: web-frontend
    app.kubernetes.io/component: api
```

---

## The selector-too-narrow problem

A selector that's too specific can fail to match its own template:

```yaml
selector:
  matchLabels:
    app: web
    pod-template-hash: never-match     # ← no Pod ever has this hash
template:
  labels:
    app: web                            # template missing `pod-template-hash: never-match`
```

apiserver rejects: selector requires `pod-template-hash` but template doesn't include it.

More commonly, this happens when someone adds a label to the selector but forgets to add it to the template:

```yaml
selector:
  matchLabels:
    app: web
    tier: frontend                      # ← added by mistake
template:
  labels:
    app: web                            # ← didn't add tier
```

Apply fails. Fix template to match.

---

## The label-drift-in-template problem

After Deployment is created, you add a label to the template:

```yaml
# Original
selector: { matchLabels: { app: web } }
template: { labels: { app: web } }

# Updated
selector: { matchLabels: { app: web } }
template: { labels: { app: web, version: v2 } }   # added version
```

This works! Selector still matches because `app: web` is in template. Template just has more.

The new RS's auto-generated selector becomes `{app: web, pod-template-hash: <hash>, version: v2}` — also fine. The Deployment selector is still `{app: web}`, which matches both old and new RS pods.

Adding labels to the template is safe. Removing labels that the selector needs is not — and apiserver blocks it.

---

## The orphan pods problem

If you somehow get pods that don't match the Deployment's selector (rare but possible — manual edit, label removal):

- Deployment doesn't count them.
- ReplicaSet doesn't manage them.
- They're orphans.

Recovery:

- Delete the orphan pods (the RS will create new ones to match the desired count).
- Or, if you can edit them, restore the labels.

```bash
# Find pods missing expected labels
kubectl get pods -l '!app' -A             # pods without app label
kubectl get pods -l '!pod-template-hash' -A  # pods without controller-injected hash
```

A pod without `pod-template-hash` was likely created outside a Deployment (bare pod, or via some manual tool). Treat it on its own — Deployment isn't going to manage it.

---

## When `kubectl replace --force` is the answer

Sometimes you really need to change the selector. The standard procedure:

```bash
# Save current state
kubectl get deploy web -o yaml > web.yaml

# Edit web.yaml to fix the selector and template

# Force replace (deletes and recreates)
kubectl replace --force -f web.yaml
```

`--force` deletes the existing Deployment first, then creates the new one. Cascades to RSes and Pods (default). All pods recreated.

For zero-downtime, use a different name:

```bash
# Create new Deployment with correct selector
kubectl apply -f web-v2.yaml          # web-v2, with new selector

# Wait for it to be ready
kubectl rollout status deploy/web-v2

# Switch traffic (Service update)
kubectl patch svc web -p '{"spec":{"selector":{"app":"web-v2"}}}'

# Delete old Deployment
kubectl delete deploy web
```

This swaps in the new Deployment without downtime.

---

## Selector mismatch failure modes

| Symptom                                                    | Cause                                                  |
|------------------------------------------------------------|--------------------------------------------------------|
| `selector does not match template labels`                  | Template missing labels the selector requires          |
| `selector is immutable`                                     | Trying to edit `spec.selector` after creation          |
| Two Deployments fighting over Pods                         | Overlapping selectors with no per-Deployment label    |
| Deployment status shows `desired: 3, current: 0`           | No Pods match the selector — possibly all orphaned     |
| Edited the Deployment but no rollout fires                 | Edited template labels in a way that didn't change the hash (annotation-only edits sometimes) |
| `kubectl edit deploy` errors on save                       | Tried to edit immutable field                          |

---

## ReplicaSet selectors are also immutable

Same rules apply to RSes (and StatefulSets, DaemonSets). Once created, `spec.selector` is locked.

For Deployments, this is invisible because the controller manages the RSes. You only deal with Deployment selectors in YAML.

---

## Best-practice selector pattern

The Kubernetes-recommended labels:

```yaml
metadata:
  labels:
    app.kubernetes.io/name: web
    app.kubernetes.io/instance: web-prod
    app.kubernetes.io/version: "1.27.0"
    app.kubernetes.io/component: frontend
    app.kubernetes.io/part-of: shop
    app.kubernetes.io/managed-by: helm
```

Selector pattern (use enough labels to be unique, but not so many that you over-constrain):

```yaml
selector:
  matchLabels:
    app.kubernetes.io/name: web
    app.kubernetes.io/instance: web-prod
    app.kubernetes.io/component: frontend
```

Three labels are usually enough to disambiguate. Don't add `version` to selectors (it changes per release; selector can't change).

Pair with the template:

```yaml
template:
  metadata:
    labels:
      app.kubernetes.io/name: web
      app.kubernetes.io/instance: web-prod
      app.kubernetes.io/component: frontend
      app.kubernetes.io/version: "1.27.0"     # in template, not selector
      app.kubernetes.io/part-of: shop
```

Helm and Kustomize both have helpers for these labels. Use them.

---

## What if I really need to update labels?

Two flavors of "label change":

### A) Adding labels to existing pods

Labels can be added to live pods directly:

```bash
kubectl label pod <pod> <key>=<value>
```

But Pods managed by a Deployment are recreated frequently. Direct labels don't persist across rollout. Edit the Deployment template; labels propagate via rollout.

### B) Renaming the selector key

Can't — selector is immutable. Workaround:

1. Create a parallel Deployment with the new selector.
2. Migrate (Service swap) to the new Deployment.
3. Delete the old.

Plan this for cluster-wide migrations (e.g. moving from `app: x` to `app.kubernetes.io/name: x`).

### C) Adding a new key to the selector

Can't — selector is immutable.

### D) Removing a key from the selector

Same — immutable.

---

## Selectors for Services vs Selectors for Deployments

Important distinction:

- **Service selector** — matches Pods to include in the Service's Endpoints. **Mutable**. Can change anytime.
- **Deployment selector** — identifies which Pods/RSes belong to this Deployment. **Immutable**.

You can change a Service's selector to point at a different Deployment's Pods (canary, blue/green). You can't change a Deployment's selector to point at different Pods.

This asymmetry is what makes Service-based traffic shifting work — you switch the Service, not the Deployment.

---

## Diagnostic commands

```bash
# Deployment's selector
kubectl get deploy <name> -o jsonpath='{.spec.selector.matchLabels}'

# Template's labels
kubectl get deploy <name> -o jsonpath='{.spec.template.metadata.labels}'

# Pods that match the selector (what the Deployment sees)
SELECTOR=$(kubectl get deploy <name> -o jsonpath='{range .spec.selector.matchLabels}{"="}{@}{end}' | tr '=' ',' | sed 's/^,//')
kubectl get pods -l "$SELECTOR"

# All pods with the same labels (incl orphans)
kubectl get pods --show-labels | grep <some-label>

# Find pods labeled with a specific value
kubectl get pods -l app=web

# Find pods missing a label
kubectl get pods -l '!pod-template-hash'
```

---

## Exam heuristics

- Always include the same labels in `selector` and `template.metadata.labels`. Triple-check before applying.
- Never put `pod-template-hash` in your manual selectors. It's reserved.
- For "change the selector" exam scenarios, the answer is usually `kubectl replace --force` or the create-new-then-swap pattern.
- Use `kubectl explain deploy.spec.selector` to recall the schema if needed.
- Kubernetes-recommended labels (`app.kubernetes.io/name`, etc.) make selectors more meaningful and harder to collide.

## Mental traps

- Editing `spec.selector` and being surprised it's rejected. It's immutable.
- Removing a label from the template that the selector requires. Apply fails.
- Adding a label to the selector after creation. Same — immutable.
- Two Deployments with overlapping selectors. Pods get fought over.
- Manually labeling Pods with `pod-template-hash` to "fix" something. The controller will overwrite or get confused.
- Believing label changes propagate to existing Pods. They propagate via the next rollout, not directly.
- Confusing Service selectors (mutable, runtime-flexible) with Deployment selectors (immutable, design-time only).
