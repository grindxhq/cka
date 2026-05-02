## The most important pattern in Kubernetes

Every controller-manager controller, every custom operator, every sidecar that calls the API — they all share one architecture. It is worth understanding in detail because:

- It explains why the cluster scales to thousands of nodes on a single apiserver.
- It explains what "eventually consistent" actually means in practice.
- It explains why a controller sometimes "acts stale" and self-corrects a few seconds later.
- It tells you where to look when a controller is "not reconciling."

This is the **informer + cache + work queue** pattern.

---

## The shape of a Kubernetes controller

```
              ┌───────────────────────────────────────────┐
              │                 kube-apiserver             │
              │                 (etcd underneath)          │
              └─────────────┬─────────────────────────────┘
                            │  LIST + WATCH (one HTTP stream)
                            ▼
              ┌───────────────────────────────────────────┐
              │  Reflector                                 │
              │  (does the actual LIST/WATCH)              │
              └─────────────┬─────────────────────────────┘
                            │ append every event
                            ▼
              ┌───────────────────────────────────────────┐
              │  DeltaFIFO (queue of buffered deltas)      │
              │  (deduplicates rapid changes)              │
              └─────────────┬─────────────────────────────┘
                            │ pop, update cache
                            ▼
              ┌───────────────────────────────────────────┐
              │  Indexer / Store                           │
              │  (thread-safe in-memory cache of all objs) │
              └─────────────┬─────────────────────────────┘
                            │ also fan out events
                            ▼
              ┌───────────────────────────────────────────┐
              │  EventHandlers                             │
              │  OnAdd / OnUpdate / OnDelete (key → queue) │
              └─────────────┬─────────────────────────────┘
                            │ enqueue just "default/foo"
                            ▼
              ┌───────────────────────────────────────────┐
              │  Work Queue (rate-limited)                 │
              └─────────────┬─────────────────────────────┘
                            │ worker goroutine pops key
                            ▼
              ┌───────────────────────────────────────────┐
              │  Reconcile(key)                            │
              │  - reads fresh state from Lister (cache)   │
              │  - diffs vs desired                         │
              │  - issues API calls to close the gap       │
              └───────────────────────────────────────────┘
```

Every part of this has a specific job. Let's walk it.

---

## 1. The Reflector — LIST, then WATCH, forever

The Reflector is a long-running goroutine that:

1. **LIST** — pulls every current object of its target type (e.g. every Pod) from apiserver.
2. Stores each one in the Store, records the `resourceVersion` returned.
3. **WATCH** — opens a streaming HTTP connection starting from that `resourceVersion`. Every change streams in as `ADDED / MODIFIED / DELETED` events.
4. Appends each event to the DeltaFIFO.
5. If the watch drops (network hiccup, apiserver restart, "resource version too old"): LIST again, re-WATCH, continue.

A single controller watches N resource types → N Reflectors → N watch streams.

### Full resync period

The Reflector periodically (`resyncPeriod`, typically 30s-10min) issues a synthetic "Sync" delta for every object currently in the cache. It is not a re-list from apiserver; it is a local notification saying "consider every object stale now." The event handlers fire again → keys re-enqueue → Reconcile runs. This is how controllers "eventually re-check everything" even if no real change occurred.

### The "too old resource version" scenario

If the controller's watch falls so far behind that etcd has compacted the revision it's resuming from, apiserver returns `Expired` / `ResourceVersionTooOld`. The Reflector reacts by re-LIST-ing from scratch. You'll see it in logs:

```
reflector.go:XX: too old resource version: 12345; falling back to list
```

This is not a bug — it is the recovery mechanism. Informers are designed to handle it.

---

## 2. DeltaFIFO — buffered, deduplicated changes

DeltaFIFO holds **Deltas** (add/update/delete records) keyed by object. If the same key is updated twice in quick succession, both deltas are kept in a list (so the controller can see the history). Deletes are always preserved.

Why a dedicated queue? Because:

- The Reflector is one goroutine, the event processor is another; a buffer decouples them.
- Rapid edits shouldn't lose information the controller might need.
- `Replace` operations (relist) emit a single batch; the queue handles the batch boundary.

You almost never interact with DeltaFIFO directly. Frameworks hide it.

---

## 3. The Indexer / Store — the in-memory cache

Every object the Reflector has seen lives in the **Indexer**:

- Keyed by `namespace/name` (primary).
- Optionally by custom index functions (e.g. `byOwner: pod.ownerReferences[].uid`).
- Thread-safe via sync.RWMutex.
- Updated by the controller as it pops from DeltaFIFO.

The cache is **an observable view of etcd state**, delayed by at most the watch round-trip (millisecond scale). This is what every controller reads from when reconciling — never the apiserver directly.

Why not hit the apiserver directly? Scale. A 5,000-node cluster has thousands of active informers; if each call to `getPod(name)` went to apiserver, the apiserver would melt. Reading from local cache is an in-memory map lookup.

### The Lister

A **Lister** is a read-only façade over the Indexer tailored to a specific resource type:

```go
// typed helper
pods, err := podLister.Pods("default").List(labels.Everything())
pod, err := podLister.Pods("default").Get("foo")
```

No network I/O; pure cache reads. A controller's hot path uses only Listers.

### Custom indexes

You can ask the informer to maintain secondary indexes so lookups like "give me all Pods owned by this ReplicaSet" are O(1) instead of O(N):

```go
podInformer.Informer().AddIndexers(cache.Indexers{
    "byOwner": func(obj interface{}) ([]string, error) {
        pod := obj.(*corev1.Pod)
        refs := []string{}
        for _, r := range pod.OwnerReferences {
            refs = append(refs, string(r.UID))
        }
        return refs, nil
    },
})

// later:
objs, err := podInformer.Informer().GetIndexer().ByIndex("byOwner", rsUID)
```

Built-in indexes include `NamespaceIndex`. The endpoints controller, for example, uses custom indexes heavily.

---

## 4. SharedInformer — one watch, many listeners

If twelve controllers all wanted to watch Pods, running twelve Reflectors would be twelve LIST+WATCH streams against apiserver. The **SharedInformer** solves this: one Reflector per resource type per process, with multiple event handlers subscribed.

```go
factory := informers.NewSharedInformerFactory(clientset, 10*time.Minute)
podInformer := factory.Core().V1().Pods()
// Start exactly one Reflector for Pods:
factory.Start(stopCh)

// Add multiple handlers — all get the same events:
podInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
    AddFunc:    deploymentController.onPodAdd,
    UpdateFunc: deploymentController.onPodUpdate,
    DeleteFunc: deploymentController.onPodDelete,
})
podInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
    AddFunc: jobController.onPodAdd,
    // ...
})
```

One watch, fanned out. Scale-proof for a single process.

The `SharedInformerFactory` builds one SharedInformer per resource type. Inside kube-controller-manager, hundreds of controllers share this factory, giving the entire process maybe ~30 open watches instead of thousands.

### HasSynced gate

Controllers must not start reconciling until the cache is populated, otherwise they'll mistake "I have no record of this object" for "this object was deleted" and do damage:

```go
if !cache.WaitForCacheSync(stopCh, podInformer.Informer().HasSynced) {
    return fmt.Errorf("cache failed to sync")
}
// safe to start workers now
```

This is why controllers print `caches synced` early in their logs — it's the gate before any work.

---

## 5. Event handlers — enqueue keys, don't do work

When a delta lands in the cache, registered event handlers fire. The correct thing to do is **not** reconcile here — it's to enqueue:

```go
onAdd := func(obj interface{}) {
    key, err := cache.MetaNamespaceKeyFunc(obj)
    if err != nil {
        return
    }
    queue.Add(key)       // "default/foo"
}
```

Why not reconcile inside the handler?

- Event handlers run on the informer's goroutine — slow work blocks all subsequent events.
- You can't easily rate-limit work inside handlers.
- If two rapid updates land, you want the handler to collapse them into one reconcile, not do two.

The work queue handles all of that.

---

## 6. Work queue — de-duplicating, rate-limited, fault-tolerant

The work queue (`workqueue.RateLimitingInterface`) has three superpowers:

1. **Dedup**: adding the same key twice before it's processed → one enqueue. Rapid sequences of events collapse into a single reconcile.
2. **Rate limiting**: on failure, `queue.AddRateLimited(key)` re-enqueues with exponential backoff. Broken objects don't hammer the queue.
3. **In-flight tracking**: while a worker is processing key X, a fresh enqueue of X is buffered; on completion the buffered version is processed next (guaranteeing at-least-once).

A typical worker loop:

```go
func (c *Controller) runWorker() {
    for c.processNextWorkItem() { }
}

func (c *Controller) processNextWorkItem() bool {
    key, quit := c.queue.Get()
    if quit { return false }
    defer c.queue.Done(key)

    if err := c.reconcile(key.(string)); err != nil {
        c.queue.AddRateLimited(key)        // retry with backoff
        return true
    }
    c.queue.Forget(key)                     // reset backoff
    return true
}
```

Workers run concurrently; key-level serialization is guaranteed because `workqueue` ensures at most one worker processes a given key at a time.

---

## 7. Reconcile — the idempotent business logic

`Reconcile` is the only place in a controller that does real work. It:

- Reads the current state from the Lister (cache) — fast, no network.
- Compares to desired state (from the object's spec).
- Issues apiserver calls to close the gap.

Must be **idempotent**: running it twice on the same object must be safe. Because the queue is at-least-once, and because periodic resync re-enqueues every object, a non-idempotent reconcile will eventually misbehave.

Good reconcile:

```go
func (c *Controller) reconcile(key string) error {
    ns, name, _ := cache.SplitMetaNamespaceKey(key)
    rs, err := c.rsLister.ReplicaSets(ns).Get(name)
    if apierrors.IsNotFound(err) {
        return nil    // deleted; nothing to do
    }
    if err != nil {
        return err    // transient; will retry
    }

    // Compute current vs desired
    pods, _ := c.podLister.Pods(ns).List(selector)
    if len(pods) < rs.Spec.Replicas {
        return c.createPod(rs)
    }
    if len(pods) > rs.Spec.Replicas {
        return c.deletePod(pods[0])
    }
    return nil
}
```

Note: if the Lister returns nothing, it could mean "object was deleted" **or** "cache is not synced yet." The `WaitForCacheSync` gate above prevents that ambiguity.

---

## How kube-controller-manager uses all of this

`kube-controller-manager` instantiates one `SharedInformerFactory` and one work queue per embedded controller (Deployment, ReplicaSet, Job, Namespace, ServiceAccount, PV, ...). The factory is shared: all controllers that need Pods share the same Pod informer.

On startup:

1. Load kubeconfig, connect to apiserver.
2. Acquire leader election lease (see leader-election subtopic).
3. Create the SharedInformerFactory.
4. Instantiate each controller, wire up its handlers.
5. Call `factory.Start(stopCh)` — Reflectors begin LIST+WATCH.
6. Call `cache.WaitForCacheSync` — wait until every informer has completed its initial LIST.
7. Launch each controller's worker goroutines.

On shutdown (leader loss, SIGTERM):

1. Close stopCh.
2. Workers finish current item, stop reading from queue.
3. Reflectors disconnect from apiserver.
4. Process exits.

If the leader lease is lost, a standby instance picks it up and goes through the same startup sequence. **There is no state handoff**; the caches rebuild from LIST on the new leader. A transient latency spike in reconciliation is normal for a few seconds during failover.

---

## Debugging controllers through this lens

### Controller "not reconciling"

- Is the informer synced? `kubectl logs kube-controller-manager | grep -i 'cache synced'`.
- Is the work queue stuck? kube-controller-manager exposes queue metrics at `/metrics`:
  ```
  workqueue_depth{name="deployment"}
  workqueue_adds_total{name="deployment"}
  workqueue_retries_total{name="deployment"}
  ```
- Is the leader this pod? `kubectl get lease -n kube-system kube-controller-manager -o jsonpath='{.spec.holderIdentity}'`.

### Stale reads

A controller just listed Pods and still doesn't see the Pod you created 100 ms ago. Possible because the informer hasn't received the watch event yet. Options:

- Wait and retry (reconcile will fire again on the cache update anyway).
- In exceptional cases, do a direct apiserver `Get` (bypassing cache) — but this defeats the purpose of informers.

### "Too old resource version"

Informers self-heal by relisting. If you see this continuously and no recovery, apiserver-to-etcd connectivity may be flapping. Check etcd health.

### Runaway queue

`workqueue_depth` keeps growing → workers can't keep up. Either your reconcile is too slow, or a failure mode is enqueueing continuously. Look at `retries_total` for patterns.

---

## Key metrics exposed by kube-controller-manager

```
# Work queue
workqueue_depth{name="deployment"}
workqueue_adds_total{name="..."}
workqueue_longest_running_processor_seconds{name="..."}
workqueue_retries_total{name="..."}
workqueue_unfinished_work_seconds{name="..."}

# Informer / reflector
reflector_items_total{name="*Pod"}         # number of objects currently in cache
reflector_list_duration_seconds_bucket
reflector_watches_total{...}
rest_client_requests_total{code="..."}      # apiserver calls

# Leader election
leader_election_master_status{name="kube-controller-manager"}   # 1 if this instance is leader
leader_election_slowpath_total

# General
rest_client_request_duration_seconds_bucket
```

Scrape these with Prometheus — a healthy controller-manager has queue depth near 0, retries near 0, and steady list/watch counts.

---

## Exam heuristics

- You will not be asked to write an informer on the CKA. You may be asked about why a controller is slow to react, what "caches synced" means, or why kubectl shows a state that differs from a controller's behaviour. Map the question to this pipeline.
- If asked "how does the Deployment controller know a Pod died?" — via a Pod informer's DeleteFunc → key enqueued → reconcile runs → Deployment notices fewer Ready Pods.
- If asked about scale: controllers are cheap because of SharedInformer; the bottleneck is apiserver->etcd write throughput, not watches.

## Mental traps

- Thinking controllers poll. They don't — they watch.
- Assuming cache == truth. The cache is **authoritative within the scope of observed events**, but not atomic with apiserver: a write you just performed might not be in your cache yet.
- Forgetting WaitForCacheSync. A controller that starts reconciling before its cache has initialized will over-create or over-delete.
- Treating the work queue as FIFO. It is priority-dedup with rate limiting; the order of processing is not strictly insertion order.
- Believing `resyncPeriod` means "re-query apiserver." It doesn't — it re-fires handlers against the existing cache. Real re-LIST only happens on "too old resource version."
- Trying to bypass the cache with direct Gets. Works once but breaks at scale. Use informers correctly.
