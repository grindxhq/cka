## Why etcd needs "maintenance"

etcd is an MVCC store: **it never overwrites values, it appends new revisions**. A PUT of `/registry/pods/default/foo` at revision 5000 does not replace the revision-4000 version — it creates a new row. The old row is still there, still queryable (`etcdctl get ... --rev=4000`). That is the whole point of MVCC: watches can resume from any historical revision, reads are snapshot-isolated, transactions are lock-free.

The downside: with no action taken, the on-disk database grows forever.

Three mechanisms keep it in check:

1. **Compaction** — logically drops old revisions from the history. Space becomes reusable but the file does not shrink.
2. **Defragmentation** — rewrites the boltdb file, reclaiming freed space back to the filesystem.
3. **Storage quota** — hard limit that, when hit, flips etcd into read-only mode until you compact + defrag.

Most "etcd is getting slow" or "apiserver writes are failing mysteriously" incidents trace to one of these.

---

## How etcd stores data (physical view)

etcd's backend is **boltdb** (actually bbolt, the etcd fork), a single-file B+tree. Inside:

```
/var/lib/etcd/member/
├── snap/
│   ├── 00000000000000a7-...snap    periodic Raft snapshots (for recovery, not user-visible)
│   └── db                          ← the boltdb file; this is "the database"
└── wal/
    ├── 00000000000000a7-...wal     Raft write-ahead log; grows then rotates
    └── ...
```

Two interesting pieces:

- **`snap/db`** is the actual keyspace. The file size is what `etcd_mvcc_db_total_size_in_bytes` reports. This is what compaction and defrag operate on.
- **`wal/`** is the Raft log — every operation, before it hits the DB. It rotates (keeps a bounded window), so it doesn't grow unboundedly.

Consequences worth internalizing:

- Deleting a Kubernetes object does not free etcd disk space immediately. The tombstone is a new revision; the old revisions still exist until compacted; the file still holds the space until defragged.
- The DB file can be **much larger** than the sum of current key sizes, because historical revisions are still there.

---

## Compaction — logically drop history

Compaction throws away revisions **older than** a given revision number. After compaction, you can no longer query at those revisions:

```bash
etcdctl compact 123456
# compacted revision 123456

etcdctl get /foo --rev=100000
# Error: etcdserver: mvcc: required revision has been compacted
```

Only the **latest** pre-compaction value of each key is kept (so current reads always work). Intermediate revisions between the compaction point and whatever came before are deleted.

What compaction does **not** do:

- It does **not** reduce the file size on disk. The space is freed inside the B+tree but the file stays large.
- It does not delete current live keys. Only historical revisions.

### Manual compaction

```bash
# Find the current revision
rev=$(etcdctl endpoint status --write-out=json | jq -r '.[0].Status.header.revision')
echo "current revision: $rev"

# Compact everything older
etcdctl compact $rev
```

Running this once by hand on an ailing cluster is the fastest way to free MVCC space before defrag.

### Auto-compaction — the thing you actually want on

Set on every etcd member via flags on the static pod manifest:

| Mode                              | Flag                                                  | Meaning                                       |
|-----------------------------------|-------------------------------------------------------|-----------------------------------------------|
| `periodic` (default)              | `--auto-compaction-mode=periodic`                     | keep the last N time window of history        |
| `revision`                        | `--auto-compaction-mode=revision`                     | keep the last N revisions of history          |

Paired with retention:

```
--auto-compaction-retention=8       # periodic: 8 hours of history
--auto-compaction-retention=5000    # revision: keep the last 5000 revisions
```

In a kubeadm-managed cluster, etcd runs without auto-compaction by default **but** kube-apiserver triggers compactions on etcd on its own schedule. See the next section.

### kube-apiserver triggers its own compactions

kube-apiserver has a flag:

```
--etcd-compaction-interval=5m    (default)
```

Every 5 minutes, it calls `Compact()` on etcd with a revision some number of operations old. This is why a stock kubeadm cluster survives without manually configuring etcd auto-compaction — the apiserver is doing the work.

If you set `--etcd-compaction-interval=0`, apiserver stops compacting and you're back to relying on etcd's own `--auto-compaction-*`. On a cluster where you've explicitly disabled this, enable etcd-side compaction.

### Spot-check: is compaction actually running?

```bash
# Via metrics (kube-apiserver scrapes this)
curl -sk --cacert $CA --cert $CERT --key $KEY https://127.0.0.1:2379/metrics | \
  grep -E 'etcd_server_compacted|etcd_mvcc_db_total_size_in_use_in_bytes'

# etcd_debugging_mvcc_db_compaction_total{} rises every compaction
# etcd_mvcc_db_total_size_in_use_in_bytes is the post-compaction "actually-used" size

# In logs
journalctl -u etcd | grep -i compact
# "finished scheduled compaction" ... "compact-revision":12345,"took":"X ms"
```

---

## Defragmentation — physically reclaim space

Compaction frees space inside the boltdb file but leaves it fragmented — lots of "holes" among the live pages. `defrag` rewrites the file sequentially:

```bash
etcdctl defrag --cluster       # runs against every member
etcdctl --endpoints=https://127.0.0.1:2379 defrag  # just this member
```

What it does:

- Creates a new compact boltdb file.
- Copies only live data into it.
- Atomically replaces the old file.
- Shrinks the on-disk footprint back to "size of actually-used pages."

### Defrag is blocking

During defrag, the member cannot serve reads or writes — it is rewriting its own storage. For Kubernetes this means:

- If you defrag the **leader**, apiserver writes pause for the defrag duration.
- If you defrag a **follower**, clients hitting that specific endpoint pause; others continue.

Practical rule: **defrag one member at a time, and do the leader last**. So:

```bash
# Identify leader
etcdctl endpoint status --cluster -w table
# leader is the row with IS LEADER = true

# Defrag each follower individually
etcdctl --endpoints=https://<follower-ip>:2379 defrag

# Finally the leader
etcdctl --endpoints=https://<leader-ip>:2379 defrag
```

Duration scales with DB size — seconds for small DBs, tens of seconds to a few minutes for large ones. During that window apiserver requests to the affected member will queue or fail over to another member (if the kubeconfig/LB has multiple endpoints).

### When to defrag

- After a big deletion event (e.g. removed thousands of Pods / Secrets / ConfigMaps).
- After hitting a NOSPACE alarm (see below).
- When `etcd_mvcc_db_total_size_in_bytes` drifts significantly above `etcd_mvcc_db_total_size_in_use_in_bytes` — the gap is fragmentation.
- Not on a schedule for typical workloads; the cost is nonzero.

---

## Storage quota and the NOSPACE alarm

etcd has a hard cap on DB size. Default is 2 GiB, tunable:

```
--quota-backend-bytes=8589934592      # 8 GiB
```

When the DB exceeds this limit, etcd raises the **NOSPACE** alarm and flips to read-only semantics:

- Puts and DeleteRange fail with `etcdserver: mvcc: database space exceeded`.
- Reads still work.
- The cluster is essentially stuck — workloads can't create/update/delete any Kubernetes object.

This is a cluster-down event that looks exactly like an apiserver outage from the outside. `kubectl apply` hangs or errors, controllers stop reconciling. Diagnosing from symptoms alone:

```bash
# Is an alarm set?
etcdctl alarm list
# memberID:abc alarm:NOSPACE

# Current DB size
etcdctl endpoint status --cluster -w table
# Look at DB SIZE column
```

### The NOSPACE recovery procedure

```bash
# 1. Get the current revision
rev=$(etcdctl endpoint status --write-out=json | jq -r '.[0].Status.header.revision')

# 2. Compact historical revisions
etcdctl compact $rev

# 3. Defragment each member
etcdctl defrag --cluster

# 4. Disarm the alarm (etcd does NOT auto-clear it even after space is freed)
etcdctl alarm disarm

# 5. Verify
etcdctl alarm list           # should be empty
etcdctl endpoint status -w table
```

Step 4 is the one people miss. Even after compact+defrag, the alarm stays set and writes stay blocked until you explicitly disarm. This is intentional — etcd wants you to acknowledge that you've fixed the root cause.

### Prevention

- **Raise `--quota-backend-bytes`** if your workload legitimately needs more history. 8 GiB is a common production value.
- **Ensure compaction is running**: check `etcd_debugging_mvcc_db_compaction_total` is increasing.
- **Monitor DB size**: alert at 75% of quota.
- **Watch for runaway writes**: a misbehaving controller writing to the same key every second fills the DB with revisions even with compaction — because within the compaction retention window, all those revisions are kept. Find and stop the writer.

---

## Quick inspection cheatsheet

```bash
# Current size vs quota
etcdctl endpoint status --cluster -w table

# Actual used vs fragmentation gap (via metrics)
curl -sk --cacert $CA --cert $CERT --key $KEY https://127.0.0.1:2379/metrics | \
  grep -E '^etcd_mvcc_db_total_size'

# Any alarms?
etcdctl alarm list

# When was last compaction?
journalctl -u etcd | grep -i 'compact' | tail -5

# Rough "health of the store"
etcdctl endpoint health --cluster
```

### What the metrics mean

| Metric                                          | Meaning                                                 |
|-------------------------------------------------|---------------------------------------------------------|
| `etcd_mvcc_db_total_size_in_bytes`              | Current size of the boltdb file on disk                  |
| `etcd_mvcc_db_total_size_in_use_in_bytes`       | Space actually containing live data (after compaction)   |
| `etcd_debugging_mvcc_db_compaction_total`       | Cumulative count of compactions executed                 |
| `etcd_mvcc_db_total_size_in_use_in_bytes / etcd_mvcc_db_total_size_in_bytes` | "Efficiency" — drops as fragmentation grows |
| `etcd_server_leader_changes_seen_total`         | Leader changes — unrelated but useful cluster-health signal |

---

## Runbook: "etcd DB is growing and I don't know why"

1. **Check compaction is actually running:**
   ```bash
   etcdctl --write-out=json endpoint status | jq '.[0].Status'
   # look at DB size history via Prometheus, or:
   journalctl -u etcd | grep -i 'finished scheduled compaction' | tail
   ```
   If no compactions in the log, apiserver isn't triggering them. Check `--etcd-compaction-interval` on kube-apiserver (non-zero).

2. **Check for a chatty writer:**
   ```bash
   # Rank keys by revision churn — rough proxy:
   etcdctl get / --prefix --keys-only | \
     wc -l                                # live key count
   etcdctl --write-out=json get / --prefix --keys-only | jq '.header.revision'
   # Revision per live key: high ratio = many writes per key
   ```
   A common culprit: a controller updating `status` on the same object every reconcile loop.

3. **Check for large values:**
   ```bash
   # Some keys accumulate large values (huge Secrets, generated manifests)
   etcdctl get / --prefix --keys-only | head -50
   # Then inspect size of specific keys:
   etcdctl get /registry/configmaps/default/my-cm | wc -c
   ```

4. **Trigger a compact + defrag:**
   ```bash
   rev=$(etcdctl endpoint status -w json | jq -r '.[0].Status.header.revision')
   etcdctl compact $rev
   etcdctl defrag --cluster
   ```

5. **Raise quota if needed** and set alerts so you don't land in read-only mode again.

---

## Interaction with apiserver's watch cache

kube-apiserver aggressively caches etcd data in memory to avoid hitting etcd on every request. When it performs `list` with `resourceVersion=0`, it serves from its local cache. For `watch` (used by every informer), it opens an etcd watch and streams changes.

Why this matters for compaction:

- A slow or disconnected informer that tries to resume a watch from a revision older than the compaction point gets `etcdserver: mvcc: required revision has been compacted`. This aborts the watch. The controller then does a **list** to reset — a burst of load.
- In very busy or slow-disk clusters, aggressive compaction can trigger these "watch has been compacted" events repeatedly, causing controllers to retry-storm.
- Default retention is usually generous enough (5 min of history for kube-apiserver's trigger) that this is rare. But if you set `--auto-compaction-retention` too low, you'll see it.

Rule of thumb: **never set compaction retention below 5 minutes in a Kubernetes cluster**. Give slow informers time to resume.

---

## Exam heuristics

- Remember the trio: **compact → defrag → disarm**. Every NOSPACE recovery follows that order.
- If asked to "reduce etcd DB size," the answer is always: compact, then defrag.
- `etcdctl alarm list` before any other remediation — it tells you immediately whether you are fighting a NOSPACE lock.
- `--quota-backend-bytes` and `--auto-compaction-*` live in the etcd static pod manifest. Knowing that path matters.

## Mental traps

- Thinking "delete the old keys and DB shrinks." It doesn't. Deletion is an MVCC append; compaction removes revisions; defrag reclaims space. Three separate operations.
- Running defrag during peak traffic. It blocks the member. Do it in maintenance windows, one member at a time.
- Defragging all three members in parallel. Cluster goes read-only for the duration. Never.
- Forgetting `alarm disarm`. Compact and defrag do not clear the alarm. You will stare at a still-broken cluster.
- Raising `--quota-backend-bytes` as a fix rather than as prevention. If you are hitting the quota, there is usually a leak (a runaway controller) to find first.
- Believing etcd is "self-tuning." Defaults are reasonable but it is very much an operator's database; production clusters monitor it actively.
