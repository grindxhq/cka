## What "healthy" means for etcd

Three independent signals, all worth checking:

1. **Endpoint health** — each member responds and is caught up.
2. **Member list** — the cluster agrees on who is in the group.
3. **Leader present** — one member is the leader, others are followers.

If any of these is wrong, writes will fail or stall.

## The four flags you always pass

Every `etcdctl` command on a kubeadm-style control plane needs the same TLS material:

```bash
export ETCDCTL_API=3
etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  <subcommand>
```

For speed, alias it:

```bash
alias e='ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key'
```

## Core health commands

```bash
# Is the endpoint serving requests?
e endpoint health

# Per-endpoint DB size, leader, raft term/index
e endpoint status --write-out=table

# Who is in the cluster, who is the leader?
e member list --write-out=table

# Read a tiny key to confirm a full write-path works
e put /healthcheck ok && e get /healthcheck
```

The `--write-out=table` format is worth remembering — `status` dumps leader ID, DB size, raft index, all inline.

## Reading the output fast

`endpoint status` row, annotated:

| Column       | What it means                                        |
|--------------|------------------------------------------------------|
| ENDPOINT     | Which member you queried                             |
| ID           | Member ID (hex)                                       |
| VERSION      | etcd server version                                   |
| DB SIZE      | On-disk bloat; grows without compaction              |
| IS LEADER    | `true` on exactly one member                         |
| RAFT TERM    | Bumps on each election                               |
| RAFT INDEX   | Monotonic log index; should be close across members  |

Red flags:

- Two leaders → you are talking to a split cluster; check network between peers.
- `IS LEADER` false for **all** endpoints → cluster has no leader, writes will fail.
- Raft indexes diverge widely → one member is far behind, likely unhealthy.
- DB size near `--quota-backend-bytes` (default 2 GiB) → etcd will go read-only.

## Quorum in practice

| Members | Quorum | Can lose |
|--------:|-------:|---------:|
| 1       | 1      | 0        |
| 3       | 2      | 1        |
| 5       | 3      | 2        |
| 7       | 4      | 3        |

Losing quorum = **no leader election possible** = API writes fail. You recover either by bringing members back, or (last resort) starting a new cluster from a snapshot with `--force-new-cluster`.

## Fastest triage path

1. On a control plane node, try the alias:
   ```bash
   e endpoint health
   ```
2. If TLS/cert errors → check certs and paths (see `tls-and-endpoints`).
3. If connection refused → is the etcd container running?
   ```bash
   crictl ps -a | grep etcd
   crictl logs <etcd-id> | tail -n 80
   ```
4. If the container is up but the endpoint hangs → likely raft-level issue; check peer connectivity on `:2380` between control plane nodes.
5. Still confused → read the etcd static pod manifest for flag drift:
   ```bash
   sudo cat /etc/kubernetes/manifests/etcd.yaml
   ```

## Common failure patterns

- **Wrong endpoint**: `127.0.0.1:2379` only works on a node running etcd. On a worker node, you need the control plane IP.
- **Expired certs**: surfaces as `tls: failed to verify certificate`. Fix via `kubeadm certs renew etcd-server` (and friends) then restart the etcd static pod.
- **Disk full on `/var/lib/etcd`**: etcd refuses writes. Check `df -h` on the node.
- **DB size quota exceeded**: etcd logs `mvcc: database space exceeded`. Compact + defrag to recover:
  ```bash
  e compact $(e endpoint status --write-out=json | jq -r '.[0].Status.header.revision')
  e defrag
  ```
- **Clock skew**: large skew between etcd peers can cause election churn. Make sure NTP is working.

## Exam heuristics

- The exam does not want you to diagnose a multi-node Raft failure from scratch. It wants you to run `endpoint health` and `member list` fluently, and know where certs and data dirs live.
- If they say "check etcd health," they usually want the `endpoint health` + `member list` table output.
- If they say "backup etcd," they want `snapshot save`. If they say "restore," they want `snapshot restore` + static pod data-dir swap. Those are drilled in the next subtopic.

## Mental traps

- Thinking `127.0.0.1:2379` will always work. It only works on a node that **runs** etcd.
- Running `etcdctl` without `ETCDCTL_API=3`. The v2 API still exists and gives confusing errors like `grpc: received message larger than max`.
- Assuming `kubectl get componentstatuses` is authoritative. On newer clusters it is deprecated and often shows `Unknown`. Go straight to `etcdctl`.
- Mistaking a healthy single-member cluster for HA. Size 1 has zero fault tolerance.
