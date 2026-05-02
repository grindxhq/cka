## What etcd actually is

etcd is a **strongly consistent, distributed key-value store** that holds the entire desired and observed state of the cluster. Every Kubernetes object — Pods, Secrets, ConfigMaps, RBAC, CRDs — is just a key under `/registry/...` inside etcd.

The API server is the **only** component that talks to etcd. Everyone else talks to the API server. That single-writer shape is important: it means etcd outages manifest as API server outages, not as "scheduler can't find a pod."

## How it fits into the control plane

```
kubectl / controllers / kubelet
          │
          ▼
   kube-apiserver   ──────────────►  etcd   (gRPC + mTLS, :2379)
   (stateless,                       (stateful, Raft,
    horizontally scalable)            odd member count)
```

Key properties that drop out of this shape:

- If etcd is **unhealthy**, the API server returns 500s or hangs on writes.
- If etcd **loses quorum**, the API server becomes read-only (or fully unavailable, depending on timing).
- etcd is the **only stateful thing** in a kubeadm control plane. Every other control plane component is a process that can be restarted freely.

## Raft in one paragraph

etcd uses Raft: one leader, the rest are followers. Writes go to the leader, get replicated, and are committed once a **majority (quorum)** acknowledges. "Majority of N" = `floor(N/2) + 1`. That is why member counts should be odd: 3 survives 1 loss, 5 survives 2. A 4-member cluster tolerates 1 failure, same as a 3-member cluster, but costs more.

## What breaks when etcd breaks

| Symptom                                | Likely etcd cause                               |
|----------------------------------------|-------------------------------------------------|
| `kubectl` write hangs or 500s          | etcd unhealthy or leaderless                    |
| API server `CrashLoopBackOff`          | etcd unreachable (flag/cert/network)            |
| API reads work, writes fail            | Quorum lost but a single member still responds  |
| `kubectl get` returns stale data       | Restored etcd from old snapshot                 |
| Control plane up, workloads "forgot"   | Snapshot restored without cleanup (see pitfalls)|

## kubeadm topology

On kubeadm clusters etcd is usually **stacked** — one etcd static pod per control plane node, co-located with the API server.

- Static pod manifest: `/etc/kubernetes/manifests/etcd.yaml`
- Data dir (host path): `/var/lib/etcd`
- Certs: `/etc/kubernetes/pki/etcd/`
- Client port: `2379` (API server → etcd)
- Peer port: `2380` (etcd ↔ etcd)

External etcd (separate nodes) exists too; the flags and certs work the same, only the manifest location differs.

## Mental model shortcuts

- "etcd is down" ≈ "the cluster has amnesia". The containers still run (kubelet keeps them), but nothing coordinates them.
- **Never** `rm -rf /var/lib/etcd`. That is erasing the cluster.
- A **snapshot** is a point-in-time dump of the whole keyspace — small (usually <100 MB), fast to take, and the only thing you need to reconstruct state.
- A restore is **not** a merge. It replaces the entire keyspace.

## What to memorize before the exam

- `/etc/kubernetes/manifests/etcd.yaml` — static pod path.
- `/var/lib/etcd` — default data dir.
- `/etc/kubernetes/pki/etcd/{ca.crt,server.crt,server.key}` — certs.
- `ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 --cacert=... --cert=... --key=...`
- Snapshot save/restore syntax (drilled in the restore subtopic).

If a scenario says "back up etcd" or "restore from snapshot," you should be able to produce the command from memory without looking it up.
