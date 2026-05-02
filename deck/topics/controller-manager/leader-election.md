## Why kube-controller-manager needs leader election

Running three `kube-controller-manager` processes in an HA control plane is desirable (survives a CP failure) but also dangerous: the Deployment controller doubled up would create twice as many Pods, the Node controller doubled up would evict at twice the rate, etc.

The answer isn't "write atomic logic everywhere" — the Lister pattern already means controllers operate on eventually-consistent caches. The answer is: **only one instance is active at a time, others stand by.** That's leader election.

Same goes for the scheduler. Same goes for operators that write to shared state.

The mechanism is simple on the surface (a Lease object) but has enough edges to be worth a deep look.

---

## The big picture

```
 kube-controller-manager    kube-controller-manager    kube-controller-manager
 on CP1 (standby)           on CP2 (leader)            on CP3 (standby)
     │                            │                          │
     │                            │  renews Lease object     │
     │                            ▼
     │                  ┌─────────────────────────────┐
     └─────watch──────► │  Lease: kube-controller-    │ ◄──── watch ─────┘
                        │           manager            │
                        │  spec.holderIdentity: cp2_xx │
                        │  spec.renewTime:  ...         │
                        │  spec.leaseDurationSeconds: 15│
                        └─────────────────────────────┘
```

All three processes run. Only one holds the Lease and actually starts controllers. The others sit idle, polling the Lease. If the leader stops renewing, one of the followers claims the Lease and starts its controllers.

---

## The three timing parameters

Every leader election client has three durations. They are related in a specific way:

```
LeaseDuration  >  RenewDeadline  >  RetryPeriod
   (15s)         (10s)              (2s)
```

Physical meanings:

| Parameter       | Default | Meaning                                                                            |
|-----------------|---------|------------------------------------------------------------------------------------|
| `LeaseDuration` | 15 s    | How long a Lease is valid from last renewal. Standbys wait this long after the last renewal they observed before attempting takeover. |
| `RenewDeadline` | 10 s    | How long the leader keeps trying to renew before giving up and stepping down.       |
| `RetryPeriod`   | 2 s     | How often the leader attempts a renewal (and how often followers poll the Lease).   |

Why the ordering matters:

- If `RenewDeadline >= LeaseDuration`, the leader might still think it's leader after the lease has expired on everyone else's clock.
- If `RetryPeriod >= RenewDeadline`, the leader has only one chance to renew before giving up — very fragile against a single packet loss.

The defaults give the leader ~5 attempts at renewal during the `RenewDeadline` window, and allow followers to safely assume takeover 5 seconds after the leader's deadline expired. Safe even with moderate clock skew.

### Timing walkthrough

Imagine lease starts at t=0, leader renews every 2 s:

```
t=0     leader acquires Lease, renewTime=0
t=2     leader renews OK; renewTime=2
t=4     leader renews OK; renewTime=4
t=6     leader renews OK; renewTime=6
t=8     leader renews OK; renewTime=8
t=10    network blip — renewal fails
t=12    retry fails
t=14    retry fails
t=18    RenewDeadline (10 s from t=8) expired → leader gives up, calls OnStoppedLeading()
t=15    Standby observed renewTime=8 + LeaseDuration=15 → Lease is "expired" → candidate time
t=15+   standby attempts acquire
t=17    standby succeeds, becomes leader
```

Window of dual leadership: from t=15 (standby thinks lease is expired) to t=18 (old leader gave up). In this window both could be acting as leader. This is the "best-effort" window leader election does not eliminate.

---

## Why leader election is **not** a distributed lock

This is a load-bearing concept in the docs:

> This implementation does not guarantee that only one client is acting as a leader (a.k.a. fencing).

Three reasons:

1. **Clocks drift**: a leader might think its lease is still valid while standbys think it expired. Both act until one notices and stops.
2. **Renewal failure doesn't stop execution**: the old leader only notices it failed to renew when `RenewDeadline` elapses. Work it's doing in that window is not halted.
3. **Long reconciliation**: even after `OnStoppedLeading`, the old leader may have an in-flight API call that completes.

Consequence: **every controller's reconcile loop must be idempotent and tolerate brief dual-leader windows**. The Deployment controller creating a pod twice is fine — the second create gets rejected (`already exists`) or collapses at the ReplicaSet level. Running a single-purpose operation (like "send this email once") through leader election alone is a bug.

For true fencing, you need something stronger: atomic compare-and-swap on the target resource with a version/token. Kubernetes' own `resourceVersion` on objects gives you this: if two leaders try to update the same object, one wins with the new resourceVersion and the other gets `Conflict`. So Kubernetes-internal reconciliation is inherently fenced at the object level, not at the process level.

---

## The Lease object

Modern Kubernetes uses `coordination.k8s.io/v1/Lease` for leader election:

```yaml
apiVersion: coordination.k8s.io/v1
kind: Lease
metadata:
  name: kube-controller-manager
  namespace: kube-system
spec:
  holderIdentity: "cp2_3a4b5c6d-..."
  leaseDurationSeconds: 15
  acquireTime: "2026-04-23T09:00:00.000000Z"
  renewTime:   "2026-04-23T10:42:18.120000Z"
  leaseTransitions: 7
```

What each field is for:

- `holderIdentity`: a cluster-unique string (hostname or pod name + UUID suffix) identifying the current leader.
- `leaseDurationSeconds`: echoes the `LeaseDuration` config of the holder. Standbys reading this know how long to wait.
- `renewTime`: the last time the holder renewed. Standbys compare `now() - renewTime` to `leaseDurationSeconds`.
- `acquireTime`: when the current holder took the Lease.
- `leaseTransitions`: how many times the Lease has changed hands since creation. A useful "cluster health" signal — rising fast means flapping.

Previous Kubernetes versions used Endpoints or ConfigMaps with annotations. Lease is the modern, preferred lock resource because:

- **Atomic**: a single `renewTime` field update is a small patch; no multi-field race.
- **Lightweight**: a Lease is ~300 bytes. A ConfigMap with history annotations was kilobytes.
- **Purpose-built**: designed for this use, so fields are self-documenting.

---

## Inspecting leader state

```bash
# Who is the current leader?
kubectl -n kube-system get lease kube-controller-manager \
  -o jsonpath='{.spec.holderIdentity}{"\n"}'

# When was the last renewal?
kubectl -n kube-system get lease kube-controller-manager \
  -o jsonpath='{.spec.renewTime}{"\n"}'

# Full state
kubectl -n kube-system get lease kube-controller-manager -o yaml

# All scheduler / controller-manager / apiserver leases
kubectl -n kube-system get leases

# How often has leadership transferred?
kubectl -n kube-system get lease kube-controller-manager \
  -o jsonpath='{.spec.leaseTransitions}{"\n"}'
```

A healthy cluster shows stable `holderIdentity` across many minutes, `renewTime` updating every ~2 s, `leaseTransitions` increasing only during known events (upgrades, CP restarts).

### Metrics

```
leader_election_master_status{name="kube-controller-manager"}  # 1 if this instance is leader, else 0
leader_election_slowpath_total                                  # count of times the slow-path renewal was used
```

If you sum `leader_election_master_status` across replicas and get != 1 for more than a few seconds, someone is misbehaving.

---

## Graceful vs ungraceful leadership loss

### Graceful loss (SIGTERM during upgrade)

When the leader's context is cancelled (SIGTERM on upgrade, eviction):

1. The main loop exits.
2. `OnStoppedLeading` callback fires.
3. Worker goroutines stop; reconcile loops drain.
4. If `ReleaseOnCancel: true`, the process proactively empties the Lease so a standby can claim it immediately (no need to wait for `LeaseDuration`).

Result: near-zero-downtime failover on orderly shutdown.

### Ungraceful loss (network partition, kill -9)

The leader is unreachable but hasn't told anyone:

1. Renewal requests fail, but the old process doesn't notice instantly — it keeps trying for `RenewDeadline`.
2. Standbys observe the expired `renewTime` after `LeaseDuration`.
3. The first standby to notice attempts acquire.
4. Worst-case downtime: `LeaseDuration + ack` ≈ 15-20 s.

During this window, controllers don't reconcile. Pods created during the window are not scheduled until the scheduler comes back. Not usually a big deal, but a scale-from-zero workload might take an extra 15 s.

---

## Clock skew hazards

Leases are a **time-based protocol**. Every participant:

- The leader logs its renewal using its local clock.
- Standbys compare `now() - renewTime` against `LeaseDuration` to decide if the lease is stale.

If two nodes have different clocks, "now" is different. Two failure modes:

### Standby thinks lease is expired when it isn't

Standby's clock is ahead of leader's. Standby sees `renewTime=10:00:00` and believes "now is 10:00:20" when the leader thinks it's only 10:00:10. Standby attempts takeover. If standby wins the CAS on the Lease (same as old leader writing renewTime=10:00:12 simultaneously), the leader might lose even though it was in-range.

Mitigation: clock sync. Run NTP. Monitor clock skew between CPs:

```bash
for cp in cp1 cp2 cp3; do
  echo "=== $cp ==="
  ssh $cp date
done
```

Skew of > 1 second across CPs in a production cluster is a problem worth fixing.

### Leader thinks lease is valid when it isn't

Leader's clock is behind. Leader thinks "now is 10:00:05, plenty of time," while standbys have already taken over. Net effect: brief split-leader.

The leader's own `OnStoppedLeading` is triggered only after `RenewDeadline` of consecutive renewal failures — so even a clock-skewed leader gives up eventually.

### Tuning for known skew

If you know your environment has skew of up to ~2 s, tune:

```
LeaseDuration: 30s    # was 15s
RenewDeadline: 20s    # was 10s
RetryPeriod: 4s       # was 2s
```

Maintains the timing hierarchy but provides more slack. Takeover latency goes up to ~30 s worst case.

Trade-off: looser timings tolerate more clock skew but extend downtime on ungraceful loss. Default values assume NTP is working.

---

## Relevant flags on controller-manager and scheduler

```
--leader-elect=true                      # on by default
--leader-elect-lease-duration=15s
--leader-elect-renew-deadline=10s
--leader-elect-retry-period=2s
--leader-elect-resource-lock=leases      # default; historical: endpoints, configmaps
--leader-elect-resource-name=kube-controller-manager
--leader-elect-resource-namespace=kube-system
```

On kubeadm clusters you typically never change these — the defaults are sane. Tune only if you've actually observed issues (unstable transitions, clock skew, long-running reconciles).

---

## Multi-leader scenarios (where they appear)

### Different `--leader-elect-resource-name` per scheduler

The scheduler uses its own Lease (`kube-scheduler` by default). If you run a custom scheduler, give it a distinct `--leader-elect-resource-name` so its HA instances coordinate with each other but not with kube-scheduler.

### Operators with their own leader election

Many operators use client-go leader election under the hood. They create a Lease in their own namespace (typically named after the operator). An operator deployment of 3 replicas has one active at any time.

```bash
kubectl get leases -A | grep operator
```

### apiserver doesn't do leader election this way

The apiserver is stateless — all replicas serve traffic simultaneously. The apiserver Leases in `kube-system` (`apiserver-<node>`) are used for coordination with aggregated APIs, not for leader election.

---

## Failure modes to recognize

| Symptom                                                          | Likely cause                                                           |
|------------------------------------------------------------------|------------------------------------------------------------------------|
| `leaseTransitions` rising every minute                            | Clock skew between CPs, or one CP is overloaded                        |
| Lease `renewTime` stuck; pods stuck reconciling                  | Leader is running but wedged; kill the pod to force election           |
| Multiple leases for same name in different namespaces            | Misconfiguration of `--leader-elect-resource-namespace`                 |
| Two pods both say "leading" in logs for overlapping window        | Normal if brief; concerning if extended → clock skew or split-network   |
| Controller "not reconciling" during upgrade window                | Brief gap while leader fails over; usually self-heals in 10-20 s        |
| Lease has `holderIdentity` of a pod that was deleted 10 minutes ago | Lease never got cleaned up; a fresh candidate should be acquiring      |

---

## Exam heuristics

- For kubeadm HA clusters, leader election "just works." You are unlikely to configure it.
- If asked "how does Kubernetes ensure only one controller-manager is active in HA?" — Lease-based leader election, coordination.k8s.io/v1 Lease in kube-system.
- `kubectl get lease -n kube-system` shows you which CP is active for scheduler / controller-manager.
- If a component says it's leading in logs but isn't reconciling, check that its Lease is actually being renewed — a wedged leader holds a stale lease.

## Mental traps

- Thinking leader election is a strict mutex. It isn't — dual-leader windows exist; design for idempotency.
- Tuning `LeaseDuration` too low "for fast failover." You'll flap.
- Expecting `ReleaseOnCancel` to work on kill -9. Only graceful cancellation triggers the release.
- Assuming both standbys poll the Lease; only the active leader renews. Standbys watch via an informer.
- Believing clock skew is rare. VM hosts drift easily. Always run NTP / chrony, monitor skew, alert on anomalies.
- Confusing the kube-apiserver's own Lease objects with leader election. The apiserver is stateless multi-leader by design.
- Expecting every operator to use the same Lease name. Each has its own.
