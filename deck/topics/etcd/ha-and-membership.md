## Why membership is its own thing

Running a single etcd is a boot-strapping convenience. Running three or five members is what makes etcd an actual distributed store. And the operations that change the member list — adding a CP node, replacing a failed one, migrating to new IPs — are where most etcd outages happen in the wild. This note walks the full lifecycle.

The core mental model, recapped:

- etcd uses **Raft**: one leader, rest followers, writes need a **majority (quorum)** to commit.
- Membership is part of the Raft log. Every add/remove is itself a committed entry that every member must apply.
- The "cluster ID" is a hash of the initial member set at bootstrap. It protects you from accidentally merging two unrelated clusters.

```
Quorum = floor(N/2) + 1

N=1  quorum 1   tolerate 0      single-node, no fault tolerance
N=3  quorum 2   tolerate 1      HA sweet spot for kubeadm
N=5  quorum 3   tolerate 2      large clusters / zone spread
N=7  quorum 4   tolerate 3      rare; more surface area for problems
```

Even member counts (2, 4, 6) give you **no additional tolerance** over the next lower odd number but **double the failure surface**. Never run 2 or 4.

---

## Two bootstrap modes: `new` vs `existing`

A fresh etcd process on disk has no idea whether it should start a new cluster or join one. `--initial-cluster-state` tells it:

```
--initial-cluster-state=new          bootstrapping a brand-new cluster
--initial-cluster-state=existing     joining an already-running cluster
```

With `new`, the member forms a cluster with exactly the peers listed in `--initial-cluster`. All members must use `new` together, once.

With `existing`, the member assumes a cluster is already running. It contacts one of the listed peers, fetches the current cluster membership, and joins.

Kubeadm's first CP node starts etcd with `new`; every subsequent CP joins with `existing`. You rarely set these flags by hand on a kubeadm cluster — the manifest is generated correctly — but understanding the semantics is what lets you read the manifest after a failed join.

---

## Adding a member — the two-step dance

Membership changes are never "turn on a new node and it joins." They are a two-step protocol:

1. **Tell the cluster** a new member is coming:
   ```bash
   etcdctl --endpoints=$EP --cacert=$CA --cert=$CERT --key=$KEY \
     member add cp3 --peer-urls=https://10.0.0.13:2380
   ```
   The cluster commits a ConfChange entry in Raft. From this point, **quorum includes the new member**, even though it is not running yet.

2. **Start the new member** with the env vars etcdctl printed:
   ```bash
   export ETCD_NAME="cp3"
   export ETCD_INITIAL_CLUSTER="cp1=https://10.0.0.11:2380,cp2=https://10.0.0.12:2380,cp3=https://10.0.0.13:2380"
   export ETCD_INITIAL_CLUSTER_STATE=existing
   etcd --listen-client-urls=https://10.0.0.13:2379 \
        --advertise-client-urls=https://10.0.0.13:2379 \
        --listen-peer-urls=https://10.0.0.13:2380 \
        --initial-advertise-peer-urls=https://10.0.0.13:2380
   ```

The two steps must not be reordered. If you start the new member first, it will refuse because the cluster doesn't know about it yet. If you add it to the cluster but never start it, **quorum now requires it** to commit further writes — if another member fails before you start the new one, the cluster goes read-only.

### The dangerous window

Between step 1 and step 2, quorum temporarily requires the new member. Practical rule: **be ready to start the new member immediately after the `member add`**. Never walk away in between.

### In a kubeadm cluster

`kubeadm join --control-plane` handles this for you: it calls `member add` on the existing etcd via the apiserver's etcd client, writes the new etcd static pod manifest to `/etc/kubernetes/manifests/etcd.yaml` with the right flags, and kubelet starts it. The new member catches up, Raft commits the pending ConfChange, and you now have a 3- (or 5-) member cluster.

When that "just works": nothing to do.

When it doesn't: the join fails mid-way and you're left with a ghost member in `member list` but no running process. Clean up:

```bash
# find the phantom
etcdctl member list
# 12abc... started  cp3  https://10.0.0.13:2380

# remove it
etcdctl member remove 12abc...
```

Then retry the join.

---

## Learner members (v3.4+)

Adding a full voting member has two risks:

- It counts toward quorum the moment it is added.
- If it is misconfigured, a write that required its vote hangs indefinitely until you notice.

The **learner** is a non-voting member that syncs from the leader but does not participate in quorum until explicitly promoted:

```bash
etcdctl member add cp3 --peer-urls=https://10.0.0.13:2380 --learner
# start the new member the same way

# watch it catch up
etcdctl member list
# ...  cp3  ...  isLearner=true

# promote when ready
etcdctl member promote <cp3-id>
```

Learner promotion refuses if the learner's Raft log is behind the leader — enforcing the invariant that a new voter is never a stale voter.

Only **one learner at a time** is allowed in a cluster. Good enough for adding one node; not a replacement for parallel provisioning.

In kubeadm the learner path isn't wired up yet — kubeadm adds full voting members. Know it exists for real production clusters.

---

## Removing a member

```bash
etcdctl member list
# 7f6a...  started  cp2  https://10.0.0.12:2380
# 9a3c...  started  cp3  https://10.0.0.13:2380
# b2e1...  started  cp1  https://10.0.0.11:2380

etcdctl member remove 7f6a...
# Member 7f6a... removed from cluster
```

That committed ConfChange tells every surviving member to recompute quorum **without** the removed ID. The removed process, if still running, exits with `etcd: this member has been permanently removed from the cluster. Exiting.`

### The unsafe case

You cannot remove a member from a **2-member** cluster. Majority of 2 is 2 — both must be alive to commit the ConfChange. Removing one while both are running works; removing one while the other is down does not, because no quorum.

Rule: if you are running a 2-member cluster, you are one failure away from an unrecoverable state. Get back to 3 immediately.

### Replacing a permanently dead member

Common scenario: cp2's disk dies, the host is gone for good. The cluster is down to 2 live members (cp1, cp3) — still has quorum (2 of 3), so it works, but has zero fault tolerance.

Procedure:

```bash
# 1. Remove the dead member
etcdctl member remove <cp2-id>       # cluster now size 2

# 2. Provision a new host with a different name (cp2-new)
# 3. kubeadm join the new host as a control plane
#    kubeadm's etcd phase will `member add` and start the new etcd
```

The new member will not magically have the old data — it fetches the current snapshot from the leader during the initial sync. This can take minutes if the DB is large.

---

## Updating a member's URL

When a host's IP changes (VM re-provision, DNS migration), you update its peer URL:

```bash
etcdctl member list
# a1b2...  started  cp2  https://10.0.0.12:2380

etcdctl member update a1b2... --peer-urls=https://10.0.1.12:2380
```

Then restart the affected etcd process with the new `--listen-peer-urls` and `--initial-advertise-peer-urls`. The other members already know the new URL from the committed ConfChange.

`advertise-client-urls` (the 2379 one) is self-published — just restart with the new flag; no `member update` needed.

---

## Quorum loss: the nightmare and the escape hatch

Lose more members than you can tolerate (e.g. 2 of 3) and the cluster stops committing writes. Reads may work transiently against a surviving member, but any write — including renewing leader's lease — fails. Eventually the surviving member steps down and becomes fully unresponsive for writes.

You have three recovery options, each with costs:

### Option A: Bring the lost members back

If the data on their disks is intact, simply restart them. They re-join, catch up from the leader, quorum is restored. **Do this first if at all possible.**

### Option B: Rebuild from snapshot

If the data is gone and you have a recent snapshot (you do — `etcdctl snapshot save` is your nightly cron job), restore it on fresh disks:

```bash
etcdutl snapshot restore backup.db \
  --name cp1 \
  --data-dir /var/lib/etcd-restore-cp1 \
  --initial-cluster cp1=https://10.0.0.11:2380,cp2=https://10.0.0.12:2380,cp3=https://10.0.0.13:2380 \
  --initial-cluster-token etcd-cluster-restored \
  --initial-advertise-peer-urls https://10.0.0.11:2380
```

Repeat for each member with its own `--name` and `--initial-advertise-peer-urls`. Point the etcd manifests at the new data dirs. Start all three at once. They will form a new cluster with the same data as the snapshot but a **new cluster ID and new member IDs** — `--initial-cluster-token` enforces this to prevent accidental merging with any zombie old members.

This is the "restore side-effects" story from the other subtopic: any changes since the snapshot are lost.

### Option C: `--force-new-cluster` (escape hatch, dangerous)

If quorum is lost and the surviving member's data is still intact, you can promote it to be the sole member of a new 1-member cluster:

```yaml
# /etc/kubernetes/manifests/etcd.yaml  (on the surviving CP)
spec:
  containers:
  - command:
    - etcd
    - --force-new-cluster
    - ...other flags
```

On start with this flag, etcd:

- Discards all other member records from the Raft log.
- Resets to a single-member cluster (just itself).
- Keeps all data keys.
- Generates a new cluster ID.

After it is running as a healthy 1-member cluster, remove `--force-new-cluster` from the manifest (important — leaving it in will force-new-cluster on every restart), then add the other members back with the two-step `member add` dance above.

**When NOT to use**:

- Any other member is still alive. The flag **panics** if previous members are still running, because it would create split-brain.
- You have a snapshot and can do a clean restore. Option B is cleaner.

This flag is a legitimate tool but it is the etcd equivalent of `git push --force`. Treat it accordingly.

---

## Kubeadm HA operations in practice

Three CP nodes, stacked etcd. You want to:

### Add a fourth CP (not recommended, but possible)

```bash
# From an existing CP:
sudo kubeadm token create --print-join-command
# Also need certificate-key:
sudo kubeadm init phase upload-certs --upload-certs

# On the new node:
sudo kubeadm join <lb>:6443 \
  --token <...> \
  --discovery-token-ca-cert-hash sha256:<...> \
  --control-plane \
  --certificate-key <...>
```

Kubeadm's etcd phase calls `member add`, writes the etcd manifest, kubelet starts it. Now you have 4 etcd members — quorum is 3, tolerate 1 failure (same as 3 but more complexity). This is why you go 3 → 5, not 3 → 4.

### Remove a CP cleanly (host is decommissioned)

```bash
# On the node being removed:
sudo kubeadm reset --cleanup-tmp-dir

# reset will try to remove the etcd member automatically.
# If reset is skipped (node already gone), do it manually from a surviving CP:
etcdctl member list
etcdctl member remove <id-of-dead-node>
kubectl delete node <dead-node-name>
```

### Catastrophic: CP1 is gone and had the only sa.key

Scenario: single control plane went under, data and PKI lost. Worst case for a single-CP cluster, just painful for HA.

- Restore etcd from snapshot (Option B above).
- You still need the original `/etc/kubernetes/pki/ca.*`, `sa.*`, `front-proxy-ca.*`. If a surviving CP has them, copy.
- If no CP survived, every ServiceAccount token ever issued is dead, every cert must be regenerated, workers must re-join. At that point you're rebuilding the cluster.

This is the argument for: **always copy PKI to at least one offline backup**.

---

## Diagnostic commands cheatsheet

```bash
# Who is in the cluster
etcdctl member list -w table
etcdctl endpoint status --cluster -w table

# Who is the leader right now
etcdctl endpoint status --cluster -w json | jq '.[] | select(.Status.leader == .Status.header.member_id)'

# Is everyone caught up
etcdctl endpoint status --cluster -w table | awk '{print $5, $6, $7}'   # compare raft indexes

# Is a specific member alive
etcdctl --endpoints=https://10.0.0.12:2379 endpoint health

# Watch Raft activity
journalctl -u etcd  # systemd
# or for static pod:
crictl logs <etcd-container-id> -f
```

### Reading raft indices

Healthy cluster: all members have the same `RAFT TERM` and `RAFT INDEX` (within a few).

Split-brain indicator: two different leaders visible. Means peer connectivity between them is broken — check the port-2380 reachability.

Member stuck far behind: `RAFT INDEX` thousands behind others. Usually means disk-IO bound or a paused process. `etcdctl defrag` can help if the DB is fragmented.

---

## Failure matrix

| Symptom                                                    | Likely cause                                                     | Fix                                                           |
|------------------------------------------------------------|------------------------------------------------------------------|----------------------------------------------------------------|
| `member add` prints env vars but new member never joins    | Firewall blocking port 2380 between peers                         | Open TCP 2380 between all CP IPs                               |
| New member logs `request sent was ignored (cluster ID mismatch)` | `--initial-cluster-token` changed, or restoring into a live cluster | Make sure new member's token matches existing cluster, or wipe data dir and try again |
| `rejected by existing cluster` on new member               | Same name as an existing member, or a ghost member entry         | `member list`, remove ghosts, ensure unique name               |
| `etcd: this member has been permanently removed`           | Ran `member remove` on this member's ID                          | Expected. Delete its data dir before rejoining.                |
| `tocommit is out of range`                                 | Data dir is from a different cluster than peers                   | Wipe `/var/lib/etcd` on the affected member, let it re-sync   |
| `publish error: etcdserver: request timed out`             | Cluster lost quorum                                              | Recover members; Option A/B/C above                           |
| Cluster accepts reads, hangs on writes                     | Lost quorum but still has enough for linearizable reads from leader | Same as above                                                  |

---

## Exam heuristics

- CKA very rarely asks you to add/remove etcd members by hand. It does ask you to recognise an HA control plane and know where etcd flags live.
- If given a broken HA cluster, check `etcdctl member list` **before** blaming apiserver. A missing or unhealthy member explains most write outages.
- If the scenario is "restore etcd," follow the snapshot-and-restore subtopic; membership is handled by the restore's `--initial-cluster`.
- Leader election on etcd is automatic and invisible; you never need to "elect" a leader manually. If asked who is the leader, `etcdctl endpoint status -w table` tells you.

## Mental traps

- Adding a full member to a cluster that is just recovering from a failure — doubles the surface area for things going wrong. Get the cluster healthy first.
- Forgetting that `member add` commits immediately; quorum recomputes before the new member is running. Don't sip coffee between steps.
- Believing `--force-new-cluster` is a recovery tool you should reach for early. It is the last resort; snapshot restore is cleaner.
- Running 2 etcd members because "it's cheaper than 3." No quorum tolerance. Worse than 1.
- Treating the old data directory of a removed member as reusable. It isn't — the Raft log is part of a cluster that ejected it. Wipe before rejoining.
- Assuming etcd members can have mismatched versions across restarts. They can for a short time (for upgrades), but drifting more than one minor version is unsupported.
