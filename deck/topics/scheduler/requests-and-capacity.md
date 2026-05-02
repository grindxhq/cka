## The one-sentence rule

The scheduler adds up **requests** for all pods already bound to a node, subtracts that from the node's **allocatable**, and only places a new pod if the remainder covers the new pod's requests. Live usage is never in the equation.

Once you internalize that, most "insufficient CPU/memory" scenarios become straightforward arithmetic.

## Requests vs limits (scheduling perspective)

| Field    | Used by scheduler?                              | Used by kubelet / cgroup?                    |
|----------|-------------------------------------------------|-----------------------------------------------|
| requests | Yes — this is the capacity reserved on the node | Sets `cpu.shares`, minimum guarantee          |
| limits   | No                                              | Enforces `cpu.cfs_quota`, triggers OOMKills   |

The scheduler only reads **requests**. Setting a high `limit` does not reduce node fit. Setting a high `request` does.

A pod with no `requests` effectively costs zero to the scheduler; it will fit anywhere, but it also has the lowest QoS class (`BestEffort`) and is first to be evicted under pressure.

## Capacity vs Allocatable

```bash
kubectl describe node <node>
```

Shows both:

```
Capacity:
  cpu:                8
  memory:             32860200Ki
Allocatable:
  cpu:                7800m
  memory:             30708200Ki
```

- **Capacity** = total physical resources the node has.
- **Allocatable** = capacity minus what the kubelet and system daemons reserve for themselves (`kube-reserved`, `system-reserved`, eviction thresholds).

The scheduler uses **Allocatable**, not Capacity. A node with `cpu: 8` Capacity can usually schedule only ~7.8 CPU worth of pod requests.

## Allocated resources (what the scheduler "sees used")

At the bottom of `kubectl describe node`:

```
Allocated resources:
  (Total limits may be over 100 percent, i.e., overcommitted.)
  Resource           Requests      Limits
  --------           --------      ------
  cpu                6800m (87%)   9200m (117%)
  memory             18Gi (60%)    24Gi (80%)
```

That is the sum of **requests** (and limits) for pods already bound to the node. The percentages are relative to allocatable. If `requests` is near 100%, new pods of that resource type will be filtered out.

Note:

- Requests can never exceed 100% (the scheduler would not have placed the latest pod).
- Limits can exceed 100% — kubelet allows overcommit.

## Why a node with low actual CPU load still rejects a pod

Very common confusion on CKA: you see `top`/`kubectl top node` showing 20% CPU, yet a new pod won't fit. That's because:

- `kubectl top node` reads real usage from metrics-server.
- The scheduler reads the sum of `requests`, which may be 95% even if usage is 20%.

Fix: lower requests on the oversized pods, or right-size them.

## Extended / custom resources

Requests can ask for more than CPU/memory:

- `ephemeral-storage` — node's `Allocatable` `ephemeral-storage`.
- `nvidia.com/gpu`, `hugepages-2Mi`, other extended resources advertised by a device plugin.

If a pod requests `nvidia.com/gpu: 1` and no node advertises the resource, the pod stays Pending with `Insufficient nvidia.com/gpu`. Check:

```bash
kubectl describe node <n> | grep -A 20 "Capacity:"
```

The resource must appear in both Capacity and Allocatable.

## QoS classes (side effect of how requests/limits are set)

| Class        | Pattern                                           | Priority for eviction          |
|--------------|---------------------------------------------------|--------------------------------|
| Guaranteed   | requests == limits for **every** container, for both CPU and memory | evicted last          |
| Burstable    | requests < limits for at least one container       | evicted after BestEffort       |
| BestEffort   | no requests or limits set                         | evicted first under pressure   |

QoS does not affect scheduling. It affects kubelet eviction order under memory/disk pressure. Knowing the classes still matters on the exam because eviction scenarios come up.

## Diagnosing "Insufficient cpu/memory"

```bash
# Per-node allocatable vs allocated, one-liner
kubectl describe nodes | \
  grep -E "Name:|Allocatable:|cpu:|memory:|Allocated resources:|Requests" | \
  grep -v "Limits"

# The pod's ask
kubectl get pod <name> -o jsonpath='{range .spec.containers[*]}{.name} reqs: {.resources.requests}{"\n"}{end}'

# Biggest pods by request (sorted)
kubectl get pods -A -o json | jq -r '
  .items[] | [
    .metadata.namespace,
    .metadata.name,
    (.spec.containers[0].resources.requests.cpu // "-"),
    (.spec.containers[0].resources.requests.memory // "-")
  ] | @tsv' | sort -k3 -h
```

If every node shows Allocated ≥ 90% for the resource the pod wants, the cluster really is full. Scale out or shrink requests.

## Fast fixes

- **Lower requests** on the Pending pod:
  ```bash
  kubectl set resources deploy/<d> --requests=cpu=100m,memory=128Mi
  ```
  (Works for Deployments/StatefulSets/DaemonSets; editing a bare Pod requires delete + recreate.)
- **Evict oversized pods** to free space (check what's on the node first; don't delete something critical).
- **Uncordon** an idle node you forgot was cordoned.
- **Add a node** (outside exam scope usually, but note it).

## Exam heuristics

- "Pod is Pending with Insufficient cpu/memory" almost always wants you to **change requests** or **free a node**. Read the prompt to decide which.
- For DaemonSet-style "run on every node" with a resource shortfall, you usually need to tune node-reserved or evict existing high-request pods.
- If the question fixes `requests`/`limits` values, respect them — do not lower requests quietly to make the pod fit.

## Mental traps

- Treating `kubectl top` output as scheduling-relevant. It is not.
- Assuming `limits` reserve capacity. They do not.
- Forgetting hidden requests on control plane components. On small clusters, system pods can eat much of `Allocatable`.
- Setting `requests` to zero to "force scheduling." That works but downgrades the pod to BestEffort, which gets evicted first under pressure — might pass the scheduling test and fail at runtime.
- Confusing `cpu: 1` with `cpu: 1m`. `1` = one full core; `1m` = one-thousandth. One-character typo, 1000× difference.
