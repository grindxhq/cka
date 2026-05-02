## The blunt truth about restore

A restore is not a rollback. It is a **replacement** of the cluster's memory with a snapshot of the past. Every object that existed then is back. Every object created since is gone. Every object modified since reverts.

This is obvious in hindsight, but catches people out in the moment because "restore" sounds like "merge the snapshot in."

## What disappears / returns

| State change since the snapshot | Post-restore result                              |
|---------------------------------|--------------------------------------------------|
| New Namespace created           | Gone. Anything inside it is gone.                |
| Deployment scaled up            | Back to old replica count.                       |
| Secret rotated                  | Old value returns. New value is lost.            |
| Node joined the cluster         | Node object is gone. kubelet still runs locally. |
| Pod manually deleted            | Pod object exists again if it existed in snapshot.|
| CRD installed                   | CRD gone → custom resources may fail to decode.  |
| RBAC modified                   | Reverts to snapshot state.                       |
| PVC created, PV bound           | Binding state reverts; PV may be "orphaned."     |

## What does **not** revert

etcd only holds the cluster control plane state. Data outside etcd is untouched:

- **Pods running on nodes** keep running — kubelet does not restart them just because etcd was restored. They simply may no longer have an object in etcd, which makes them "orphaned" until kubelet next reconciles.
- **Container images** on nodes.
- **PV data on disk / cloud volumes** — only the PV/PVC metadata reverts.
- **Log files on nodes.**
- **Host filesystem state** (e.g. files written by workloads).

## Orphaned workloads

After a restore, kubelet still knows about pods that etcd no longer lists (or lists differently). Two situations to watch for:

1. **Pod existed in snapshot, still running on node**: converges cleanly; kubelet re-registers via the API server.
2. **Pod created after snapshot**: etcd does not know it. kubelet either keeps it running (as an untracked pod) or eventually garbage-collects depending on version. You may see it linger until you `crictl rm` or restart the kubelet on that node.

If a scenario "expects" deleted pods to stay deleted after restore, check whether kubelet still has a sandbox for them.

## Cluster-id and member-id change

Every restore produces a **new cluster ID** and, for each member, a new member ID. That has two consequences:

- If you have **multiple etcd members** on different control plane nodes, restoring on one and leaving the others running creates a split. Fix: restore identically on all members, or bring up a single member first and have the rest re-join.
- Certificates tied to a specific cluster ID (rare) need to be regenerated. Kubeadm's certs are not, so this rarely bites you on CKA.

## Post-restore checklist

1. **Sanity read:**
   ```bash
   kubectl get nodes
   kubectl get pods -A
   kubectl get ns
   ```
2. **Check for unexpected CrashLoopBackOff / NotReady** — these often come from certs/secrets that reverted.
3. **Check PV/PVC bindings** — any PVC created after the snapshot no longer exists; the underlying PV may be `Released` or `Available`.
4. **Verify workload identity / tokens** — ServiceAccount tokens pinned after the snapshot are gone. Pods using them may need restart.
5. **Check admission / webhook configurations** — a reverted webhook can silently block new writes.
6. **Re-apply anything created since the snapshot** if it is still needed (Namespaces, Deployments, Secrets, ConfigMaps).

## HA-specific hazards

On a 3-node stacked etcd cluster:

- Restoring on **one** member while the other two are live → the restored member has the "right" data but a different cluster ID; the other two vote it out.
- The safest pattern is: stop etcd on all three, restore on one into a fresh data dir, start it with `--force-new-cluster` (kubeadm manifest tweak), then wipe and re-join the other two members.
- For CKA, you usually work with a **single stacked etcd** per node, so this rarely appears.

## Common failure modes after a restore

| Symptom after restore                      | Likely cause                                         |
|--------------------------------------------|------------------------------------------------------|
| `kubectl get pods` lists old pods as Running but they are actually gone | kubelet garbage collection still catching up; wait or restart kubelet |
| Webhook admission rejects every write      | Webhook config reverted; CA bundle or service selector now stale       |
| All nodes `NotReady` briefly               | Node lease objects reverted; self-heals once kubelet re-heartbeats      |
| Pods in old namespaces show `Pending`      | PVC binding reverted; PV is no longer claimed                          |
| `kubectl` works but `exec`/`logs` fail     | API server hit a stale endpoint; restart apiserver static pod          |

## Exam heuristics

- The exam usually frames it as: "back up etcd and restore to a known state." Treat it as a **mechanical procedure**: stop, restore, rewire, start, verify.
- If the question says "restore this snapshot into the cluster," do not worry about preserving changes made since; they are expected to be lost.
- If they hand you **two snapshots** and ask to restore the second, make sure you restore from the right file — the filename usually encodes the time.

## Mental traps

- Believing workloads will "come back exactly as they were." Pods will get rescheduled, but IPs, node placements, and attached volumes may differ.
- Restoring on a live multi-member cluster without stopping peers. Causes split-brain and is very hard to reason about in an exam setting.
- Assuming Secrets survive if they existed before the snapshot. They do — but if any controller rotated them since, the old value is back, and any downstream system that rotated with them (external DB, vault) is now inconsistent. On CKA this mostly appears as "new ServiceAccount tokens do not match running pods' mounted tokens."
- Treating restore as reversible. Once you have wiped the live keyspace, rolling forward requires another snapshot.
