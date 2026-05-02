## What rollback actually means

"Rollback" in Kubernetes Deployments isn't a special operation. It's just **another rollout** — back to a previous template. The mechanism is the same as a forward update, but the target template is one you previously used.

This works because old ReplicaSets are kept (scaled to 0) up to `revisionHistoryLimit`. Each one is a snapshot of a past template. Rolling back = scaling an old RS back up and the current RS down.

```
 Now:        web-v1-RS=0    web-v2-RS=3
 Rollback →  web-v1-RS=3    web-v2-RS=0
```

Same RollingUpdate strategy applies during rollback. New (== old) pods come up, current (newest) pods go down.

---

## kubectl rollout history

Shows past revisions:

```bash
kubectl rollout history deploy/web

# REVISION  CHANGE-CAUSE
# 1         <none>
# 2         kubectl set image deploy/web web=nginx:1.25 --record=true
# 3         kubectl set image deploy/web web=nginx:1.26 --record=true
# 4         kubectl set image deploy/web web=nginx:1.27 --record=true
```

Revisions are numbered monotonically; gaps possible if `revisionHistoryLimit` discarded older ones.

CHANGE-CAUSE comes from the deprecated `--record` flag (or you can set the annotation directly):

```bash
kubectl annotate deploy/web kubernetes.io/change-cause="Upgrade nginx to 1.27"
# Then your next rollout shows that annotation in history.
```

`--record` is deprecated but still works on most clusters. The annotation pattern is the modern way.

### Inspect a specific revision

```bash
kubectl rollout history deploy/web --revision=3

# Pod Template:
#   Labels:       ...
#   Containers:
#    web:
#     Image:      nginx:1.26
#     ...
```

Shows what the pod template was at that revision. Useful for "what was deployed when?" investigations.

---

## kubectl rollout undo

```bash
# Roll back to the immediately previous revision
kubectl rollout undo deploy/web

# Roll back to a specific revision
kubectl rollout undo deploy/web --to-revision=2
```

Behind the scenes:

1. Controller looks up the target revision's pod template.
2. Updates the Deployment's `spec.template` to match.
3. The change triggers a new rollout (with a new RS hash → new RS, since the bumped revision number is now part of metadata).
4. RollingUpdate strategy applies (just like a forward update).

Watch the rollback:

```bash
kubectl rollout status deploy/web
```

After completion:

```bash
kubectl rollout history deploy/web

# REVISION  CHANGE-CAUSE
# 1         <none>
# 2         kubectl set image ... nginx:1.25
# 4         kubectl set image ... nginx:1.27       ← previously revision 4
# 5         <none>                                  ← the rollback became revision 5
```

Note: rolling back creates a new revision (5), even if it's a return to revision 3's template. The history shows 3 might be promoted to 5 in some forms; in others it's separate. Either way, the chain reflects "at this point, you went back to that template."

### What if rollback doesn't help?

`undo` rolls back. If the previous revision was also broken, undo to a specific older revision:

```bash
kubectl rollout undo deploy/web --to-revision=2
```

If that doesn't work either, you've lost the good version (or it was never deployed). At that point you re-deploy the known-good template manually.

---

## When rollback isn't possible

### History exhausted

`revisionHistoryLimit: 2` keeps only 2 old revisions. If the rollout you want to undo to is older than that, the RS is gone:

```bash
kubectl rollout undo deploy/web --to-revision=1
# error: unable to find specified revision 1 in history
```

Fix: set a higher `revisionHistoryLimit` going forward; for past damage, you'll need the YAML from version control.

### Database / state migrations

Rolling back the **pod template** doesn't roll back data. If your v2 ran a migration that's incompatible with v1, rollback gets you back to v1 code but data is on v2 schema → app may not work.

Fix patterns:

- **Backward-compatible migrations** — v1 and v2 can both read v2 schema. Allows rollback at any time.
- **Two-step migrations** — first deploy adds new column (v1.5 reads both schemas); second deploy starts using new column (v2). Rollback to v1.5 is safe.
- **Snapshot before migration** — etcd / DB snapshot before risky changes. Rollback = restore + re-deploy old version.

This is a system-design problem, not a Kubernetes problem.

### External side effects

If the deployment caused side effects outside the cluster (created cloud resources, sent emails, posted webhooks), rolling back the pod doesn't undo those. Plan for compensating actions if you might roll back.

---

## revisionHistoryLimit in practice

```yaml
spec:
  revisionHistoryLimit: 10        # default
```

Recommended values:

- `0` — no history; rollback impossible. Cleanest etcd, but you've lost the safety net.
- `1` — minimal; can undo once. Good for high-churn dev environments.
- `10` — default. Balanced; usually enough for any realistic rollback distance.
- `50+` — paranoid; clutters etcd; rarely useful.

Inspect:

```bash
kubectl get deploy web -o jsonpath='{.spec.revisionHistoryLimit}'
```

---

## change-cause annotation

The "what changed" annotation:

```yaml
spec:
  template:
    metadata:
      annotations:
        kubernetes.io/change-cause: "Patch CVE-2024-XXXX in nginx"
```

Shows up in `kubectl rollout history`. Helps with audit trails.

The deprecated `kubectl --record` flag inserted this automatically:

```bash
kubectl set image deploy/web web=nginx:1.27 --record
# Equivalent to:
kubectl set image deploy/web web=nginx:1.27
kubectl annotate deploy/web kubernetes.io/change-cause="kubectl set image deploy/web web=nginx:1.27"
```

`--record` works on most clusters but emits a deprecation warning. For new automation, set the annotation directly.

---

## Why a rollback might not "feel like" a rollback

Rolling back creates a new revision (e.g. v5 = "back to v3's template"). So in `kubectl rollout history`, the rolled-back revision is the most recent — not v3.

This means:

- `kubectl rollout undo` next will undo back to v4 (the bad one), **not** v3 again.
- Status conditions show Progressing as the rollback rolls.
- The Deployment's `metadata.generation` increments.

Behavior is consistent — every change is a forward step, even if it visits an old template.

---

## Combining with CI/CD

Typical pipeline:

```
1. Build new image with tag v123.
2. kubectl set image deploy/web web=myapp:v123
3. kubectl rollout status deploy/web --timeout=10m
4. If exit code non-zero: kubectl rollout undo deploy/web
5. Notify (Slack, email) of success or failure.
```

This gives automated rollback on rollout failure (image fails to pull, pods don't reach ready, etc.). Doesn't catch "rolled out fine, but app is buggy" — for that you need integration tests post-deploy and another rollback trigger.

For more sophisticated patterns:

- **Argo Rollouts** — automated canary with metric-based rollback.
- **Flagger** — Istio-based progressive delivery.
- **Spinnaker** — full pipeline with automated rollback gates.

---

## Multi-step "undo to known good"

Sometimes you want to skip the immediate previous revision because it was also bad. Walk back manually:

```bash
# See what you have
kubectl rollout history deploy/web

# Inspect a specific revision's template
kubectl rollout history deploy/web --revision=3

# Roll to it
kubectl rollout undo deploy/web --to-revision=3
```

You can also just edit the Deployment back to the YAML you want — apply works the same as undo in terms of triggering a rollout.

---

## Recovering from "all revisions are bad"

Worst case: every revision in history is broken. You need to deploy a new template that's good. Sources:

- Git history of the Deployment YAML.
- A backup / snapshot.
- Re-build from known-good source.

In all cases: prepare new YAML → `kubectl apply` → watch the rollout. The old revisions don't matter; you're moving forward.

---

## Rollback during an in-progress rollout

If a rollout is mid-progress (some new pods, some old pods) and you `kubectl rollout undo`:

- Controller sees the new desired template = old template.
- Old pods stay (they already match the desired template).
- Partial new pods are scaled down (they don't match).
- Rollout completes "instantly" because most of the cluster is already at the target.

Conceptually: undo just changes the target. The reconciler does the right thing.

---

## When you should not roll back

Some scenarios where rollback isn't the right tool:

- **Forward-fix is faster** — typo in env var? Just fix and re-apply v3 → v4 (with the fix). Don't roll back to v2.
- **Migration ran and you can't undo it** — see "Database migrations" above.
- **The "old" version had its own bug** that's worse than the new one. Pick wisely.

A rollback should leave the cluster in a known-good state. If that doesn't apply, take a different action.

---

## Inspecting rollout state

```bash
# Current rollout status
kubectl rollout status deploy/web

# History
kubectl rollout history deploy/web

# Specific revision details
kubectl rollout history deploy/web --revision=3

# Current template (what would the next rollback skip?)
kubectl get deploy web -o jsonpath='{.spec.template}'

# Ready replicas
kubectl get deploy web -o jsonpath='{.status.readyReplicas}'

# Conditions
kubectl get deploy web -o jsonpath='{.status.conditions}'

# Pods by RS hash (visualize active vs scaled-down RSes)
kubectl get rs -l app=web
```

---

## Common mistakes

### Lowering revisionHistoryLimit too aggressively

Setting it to 1 to "save space" means one rollback only. The next rollback target is gone.

### Forgetting change-cause

Without change-cause annotations, `rollout history` is useless for understanding **what** each revision changed. Plain "kubectl set image" history is opaque.

### Treating rollback as a magic "undo button"

Rollback only undoes pod template changes. Database changes, external API calls, persistent state — none of those revert with a rollout undo.

### Rolling back without testing

A rollback is a deploy. It can fail (the old image might not start because of newer cluster constraints, the old version might have a different bug). Watch the rollout status.

### Confusing revision numbers

Every change increments the revision. A rollback adds a new revision (it's a fresh template change, even if to a known-good template). Don't expect "undo" to return you to revision 3 — you'll be at revision 5 holding revision 3's template.

---

## Exam heuristics

- For "rollback this Deployment," `kubectl rollout undo deploy/<name>`.
- For "rollback to a specific previous revision," add `--to-revision=<N>`.
- `kubectl rollout history` shows revisions; `--revision=<N>` shows that revision's template.
- `revisionHistoryLimit` controls how far back you can go.
- Use `kubectl annotate deploy ... kubernetes.io/change-cause=...` to record what each rollout changed.

## Mental traps

- Expecting rollback to revert state outside the pod template (PVCs, ConfigMaps, external resources). It only reverts the pod template.
- Setting `revisionHistoryLimit: 0` and being unable to undo anything.
- Rolling back during an in-progress rollout and getting confused. The controller resolves it correctly; you just see fewer pods churning.
- Treating `rollout history` as a complete change log. It only shows pod template snapshots; ConfigMap/Secret edits don't appear here.
- Rolling back when forward-fix would be cleaner. Production rollbacks introduce their own risk; sometimes a quick patch is safer.
- Trusting `--record`. It's deprecated; use `kubectl annotate` to set change-cause explicitly.
