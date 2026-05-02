## What a controller actually is

A controller is a **reconciliation loop**:

1. **Observe**: read the current state of a type of object from the API.
2. **Diff**: compare it against the declared (desired) spec.
3. **Act**: make API calls to close the gap.
4. Repeat.

That is the entire pattern. Every controller in Kubernetes — node controller, deployment controller, endpoints controller, garbage collector — is a variation on that loop.

What makes it powerful: controllers are **level-triggered**, not edge-triggered. They do not react to "events" in the streaming sense; they keep asking "is the world how I want it?" If they crash and restart, they pick up exactly where they left off because desired state is stored in etcd.

## What `kube-controller-manager` is

A single binary that hosts **many** controllers together in one process:

- Node controller
- ReplicaSet controller
- Deployment controller
- Endpoint / EndpointSlice controllers
- Service account controller
- Token controller
- PV binder / PV protection / attach-detach
- Garbage collector
- Namespace controller
- TTL controller (for finished Jobs)
- Resource quota controller
- Horizontal pod autoscaler
- Job / CronJob controllers
- StatefulSet / DaemonSet controllers

Flags like `--controllers=*` or `--controllers=-persistentvolume-binder` can enable/disable individual ones. On kubeadm clusters you almost never touch this.

## How reconciliation looks from the outside

A classic walk-through of a single `kubectl apply -f deployment.yaml`:

```
user → apiserver: write Deployment (desired state lands in etcd)
                ↓
Deployment controller notices a new Deployment
                ↓
creates / updates a ReplicaSet (scaled to replicas count)
                ↓
ReplicaSet controller notices replicas < desired
                ↓
creates Pod objects
                ↓
Scheduler notices Pods with no nodeName
                ↓
binds Pods to nodes
                ↓
kubelet notices Pods assigned to its node
                ↓
pulls image, creates sandbox, starts containers
                ↓
kubelet updates Pod status back to apiserver
```

Every arrow is a separate controller (or kubelet) reacting to an etcd-backed change. No one orchestrates them in order — they all just watch and reconcile.

## Leader election

Only one `kube-controller-manager` can actively run the controllers at a time. When you run HA control planes (3 copies), they hold a lease in a ConfigMap or Lease object. One holds the lease and does the work; the others stand by. If the leader dies, another takes over within the lease duration.

See the current leader:

```bash
kubectl -n kube-system get lease kube-controller-manager -o yaml
```

Consequences:

- Losing the leader briefly stalls controllers. Pods don't reschedule, Deployments don't roll, endpoints don't update.
- A misconfigured HA deployment (e.g. clock skew) can cause rapid leader handoffs; you see flapping behavior.

## What happens if kube-controller-manager is down

- Running workloads keep running (kubelet is still alive).
- Already-created Deployments/ReplicaSets stay at their current state.
- But: new Deployments don't roll. Dead pods don't get replaced. Failed nodes don't taint. Services still resolve, but Endpoints don't update when pods change. Namespaces stuck in `Terminating` don't progress. PVCs don't bind.

In kubeadm clusters it is a static pod:

```
/etc/kubernetes/manifests/kube-controller-manager.yaml
```

Inspect:

```bash
kubectl get pods -n kube-system -l component=kube-controller-manager
crictl ps | grep controller-manager
crictl logs <id>
```

## Debugging from "nothing is happening"

If a resource "just sits there," trace through **which controller owns it**:

| Resource stuck                         | Look at controller       |
|---------------------------------------|--------------------------|
| Deployment with wrong replica count    | Deployment → ReplicaSet  |
| Pod not created despite ReplicaSet     | ReplicaSet controller    |
| Pod created but not bound              | Scheduler (different pod)|
| Bound pod not running                  | Kubelet (different pod)  |
| Service with empty Endpoints           | Endpoints / slice controller|
| PVC Pending                            | PV binder                |
| Namespace stuck in Terminating         | Namespace controller     |
| Dead Job not cleaned up                | TTL controller           |
| Node stays Ready despite down kubelet  | Node controller          |

Logs surface the actual failure:

```bash
kubectl logs -n kube-system -l component=kube-controller-manager --tail=200
```

In a kubeadm cluster this is often the first log to check when things "freeze."

## What controllers do and don't own

- Controllers own **objects in etcd**. They create, update, and delete API objects.
- They do **not** start or stop containers. That is kubelet, reading pod specs.
- They do **not** assign pods to nodes. That is the scheduler.
- They do **not** move pods between nodes. Rescheduling happens by deleting one pod and creating another.

This helps when debugging: if a pod's IP keeps flipping, that is DNS/endpoint work. If a pod keeps getting re-created, that is a controller. If a pod is stuck Pending, that is the scheduler. If it is stuck ContainerCreating, that is kubelet.

## Exam heuristics

- "Deployment not healing" → check controller-manager logs and the ReplicaSet / Pod owner chain.
- If multiple reconciliation-type symptoms appear at once (pods not replacing, endpoints stale, namespaces stuck), the controller-manager is likely down.
- Leader election stalls look like "intermittent reconciliation." Check lease objects.

## Mental traps

- Thinking of controllers as "event handlers." They are not — they reconcile on a periodic resync, not just on change.
- Believing a running controller-manager with a healthy lease means all controllers are fine. Individual controllers can log errors and silently stop reconciling (the logs are the truth).
- Expecting `kubectl rollout restart` to force-refresh controllers. It does not — it restarts pods via the workload controller, and the pod template changes trigger a new rollout.
- Assuming kubelet problems look like controller problems. They are usually distinguishable by whether the pod object has `.spec.nodeName` and by the specific `status` conditions.
