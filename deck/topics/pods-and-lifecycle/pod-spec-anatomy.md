## What a Pod actually is

A Pod is the smallest schedulable unit. It is **a group of one or more containers that share network and (optionally) storage namespaces**, with a single shared lifecycle.

Two pods on the same node are isolated from each other; two containers in the same pod share the pod's IP and `localhost`. That is the entire conceptual difference.

```
┌─────────────────────── Pod ──────────────────────────┐
│                                                       │
│   Network namespace:  pod IP, /etc/hosts, /etc/resolv.conf │
│                                                       │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│   │container │  │container │  │container │            │
│   │   A      │  │   B      │  │   C      │            │
│   │ pid 1    │  │ pid 1    │  │ pid 1    │            │
│   └──────────┘  └──────────┘  └──────────┘            │
│        │             │             │                   │
│        └─────────────┴─────────────┘                   │
│                      │                                 │
│              shared volumes                             │
│              shared loopback (127.0.0.1)                │
│              shared cgroup parent                       │
│                                                         │
└──────────────────────────────────────────────────────┘
```

Each container is its own PID namespace by default (no cross-container `kill`), but they share the network. Containers reach each other on `localhost:<port>`.

---

## The full spec, sectioned

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web
  namespace: default
  labels:
    app: web
  annotations:
    description: "main web pod"
spec:
  # ── scheduling ──
  nodeSelector:
    disktype: ssd
  affinity: { ... }
  tolerations: [ ... ]
  topologySpreadConstraints: [ ... ]
  priorityClassName: high

  # ── identity ──
  serviceAccountName: web
  automountServiceAccountToken: true
  securityContext:                     # pod-level
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 2000
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault

  # ── network ──
  hostNetwork: false
  hostPID: false
  hostIPC: false
  dnsPolicy: ClusterFirst
  dnsConfig: { ... }
  hostAliases: [ ... ]
  subdomain: web                       # for headless service per-pod DNS
  hostname: web-0

  # ── lifecycle ──
  restartPolicy: Always                # Always | OnFailure | Never
  terminationGracePeriodSeconds: 30
  activeDeadlineSeconds: 3600          # max wallclock; for Job-like pods

  # ── containers ──
  initContainers: [ ... ]
  containers:
    - name: app
      image: myapp:1.0
      imagePullPolicy: IfNotPresent
      ports:
        - containerPort: 8080
          name: http
          protocol: TCP
      env:
        - name: ENV
          value: prod
        - name: DB_URL
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: db_url
        - name: SECRET_KEY
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: api_key
      envFrom:
        - configMapRef: { name: app-config }
        - secretRef: { name: app-secrets }
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 512Mi
      command: [ "/bin/sh", "-c" ]      # overrides image's ENTRYPOINT
      args: [ "exec /app -port 8080" ]   # overrides image's CMD
      livenessProbe: { ... }
      readinessProbe: { ... }
      startupProbe: { ... }
      lifecycle:
        postStart: { exec: { command: [ ... ] } }
        preStop:   { exec: { command: [ ... ] } }
      securityContext:                  # container-level (overrides pod-level)
        allowPrivilegeEscalation: false
        runAsNonRoot: true
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ "ALL" ]
          add:  [ "NET_BIND_SERVICE" ]
      volumeMounts:
        - name: data
          mountPath: /var/lib/app
        - name: config
          mountPath: /etc/app
          readOnly: true
      resizePolicy:                     # in-place resize (1.27+ alpha/beta)
        - resourceName: cpu
          restartPolicy: NotRequired

  ephemeralContainers: [ ... ]          # injected via kubectl debug

  # ── storage ──
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: app-data
    - name: config
      configMap:
        name: app-config
    - name: scratch
      emptyDir: {}
    - name: token
      projected:
        sources:
          - serviceAccountToken:
              path: token
              expirationSeconds: 3600
              audience: api

  # ── advanced ──
  preemptionPolicy: PreemptLowerPriority
  schedulerName: default-scheduler
  schedulingGates: [ ]
```

That's the full surface. Most pods use a small subset. Each block deserves a quick walk.

---

## Containers — the heart

A container has these required fields:

- `name` — DNS-label, unique within the pod.
- `image` — fully-qualified image reference (`registry/repo:tag` or `@sha256:...`).

Plus optional fields you'll touch often.

### `command` and `args`

These map to the container image's `ENTRYPOINT` and `CMD`:

| Pod field | Image field | If set... |
|-----------|-------------|-----------|
| `command` | `ENTRYPOINT` | overrides ENTRYPOINT |
| `args`    | `CMD`        | overrides CMD       |

Three patterns:

```yaml
# Use image defaults entirely
containers:
- name: nginx
  image: nginx:latest

# Override CMD only (use image's ENTRYPOINT, pass new args)
- name: app
  image: app:1.0
  args: [ "--port=8080", "--config=/etc/app" ]

# Override both
- name: shell
  image: app:1.0
  command: [ "/bin/sh", "-c" ]
  args: [ "exec /usr/local/bin/app --debug" ]
```

The most common bug: writing `command:` when you meant `args:`. Suddenly the entrypoint is overridden, the entrypoint script (with its env-var processing) doesn't run, things break in subtle ways.

### `env` and `envFrom`

Three sources for environment variables:

```yaml
env:
- name: STATIC
  value: "literal-value"

- name: FROM_CONFIGMAP
  valueFrom:
    configMapKeyRef:
      name: app-config
      key: db_host

- name: FROM_SECRET
  valueFrom:
    secretKeyRef:
      name: app-secrets
      key: db_password

- name: FROM_FIELD
  valueFrom:
    fieldRef:
      fieldPath: status.podIP
```

`envFrom` injects every key from a ConfigMap/Secret as env vars (mass injection, no name-by-name listing). Useful for lots of config; risky for secrets (inject only what you need).

### `resources`

```yaml
resources:
  requests:
    cpu: 100m       # 0.1 CPU
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

Requests drive scheduling (the scheduler checks "does this fit?"). Limits drive runtime enforcement (CFS for CPU, kill-on-exceed for memory). See the kubelet deck's cgroups-and-qos for the full story.

CPU requests = limits + memory requests = limits = **Guaranteed** QoS.

### `imagePullPolicy`

| Value          | Behavior                                                       |
|----------------|----------------------------------------------------------------|
| `IfNotPresent` | Pull only if not in node's image cache. Default for tagged images. |
| `Always`       | Pull every time the container starts. Default for `:latest`.   |
| `Never`        | Never pull. Fail if not in cache.                               |

The `:latest` → `Always` defaulting is specifically called out — using `:latest` makes pod start slower and more dependent on registry availability. **Pin tags.**

### `volumeMounts`

```yaml
volumeMounts:
- name: data                          # references spec.volumes[].name
  mountPath: /var/lib/app
  subPath: postgres                   # optional: mount only a subdirectory
  readOnly: false
```

`subPath` is the way to mount a single file from a ConfigMap or share one PVC across many pods that each need a different subdir.

### `securityContext` (container-level)

```yaml
securityContext:
  allowPrivilegeEscalation: false       # block setuid binaries
  privileged: false                      # full root access on host
  runAsUser: 1000
  runAsGroup: 1000
  runAsNonRoot: true                     # fail-start if image runs as UID 0
  readOnlyRootFilesystem: true           # / is read-only; need volume for writes
  capabilities:
    drop: [ "ALL" ]
    add:  [ "NET_BIND_SERVICE" ]
  seccompProfile:
    type: RuntimeDefault
```

Container-level securityContext overrides pod-level for that container. Best practice baseline for any new pod:

- `runAsNonRoot: true`
- `allowPrivilegeEscalation: false`
- `readOnlyRootFilesystem: true` (mount tmpfs for any writable paths)
- `capabilities: drop: [ALL]`
- A non-default seccomp profile

These are the "restricted" Pod Security Standard. Admission policy can require them.

### `lifecycle` hooks

```yaml
lifecycle:
  postStart:
    exec:
      command: [ "/bin/sh", "-c", "register-with-discovery" ]
  preStop:
    exec:
      command: [ "/bin/sh", "-c", "drain && sleep 10" ]
```

- `postStart` — fires after the container starts, before kubelet declares it Started. Failures kill the container.
- `preStop` — fires when the pod is being terminated (delete, eviction, drain). Runs *before* SIGTERM. The grace period (`terminationGracePeriodSeconds`) covers preStop + the actual termination.

Common preStop pattern: deregister from a load balancer, sleep a bit so connections drain, then let SIGTERM hit the app.

---

## Init containers

Run before main containers, sequentially, must each succeed:

```yaml
initContainers:
- name: wait-for-db
  image: busybox:1.28
  command: [ "sh", "-c", "until nc -z db 5432; do sleep 2; done" ]
- name: schema-migrate
  image: app:1.0
  command: [ "/app", "migrate" ]
containers:
- name: app
  image: app:1.0
```

Properties:

- Run one at a time, in declared order.
- Must each exit 0 before the next runs.
- Pod stays Pending until all init containers complete.
- Don't support `livenessProbe` / `readinessProbe` / `startupProbe` (regular init containers).
- Resources: kubelet considers each init container's request individually (max), then main containers' summed requests, takes the larger — used for scheduling.

If an init container fails:

- `restartPolicy: Always` or `OnFailure` → kubelet restarts it (with backoff).
- `restartPolicy: Never` → pod fails permanently.

Init containers detailed in the next subtopic.

---

## Volumes

Declared at pod level, mounted into containers:

```yaml
volumes:
- name: data                            # referenced by volumeMounts.name
  persistentVolumeClaim:
    claimName: my-pvc

- name: config
  configMap:
    name: app-config

- name: secrets
  secret:
    secretName: app-secrets
    defaultMode: 0400                   # read-only for owner

- name: scratch
  emptyDir:
    sizeLimit: 100Mi
    medium: Memory                       # tmpfs

- name: hostpath
  hostPath:
    path: /var/log
    type: DirectoryOrCreate

- name: token
  projected:
    sources:
    - serviceAccountToken:
        path: token
        expirationSeconds: 3600
        audience: api
```

The actual mount happens at the container level via `volumeMounts`. A pod can declare 5 volumes; container A mounts 2 of them, container B mounts 3.

Detail in the storage deck.

---

## Lifecycle phases

A pod transitions through:

```
Pending → Running → Succeeded | Failed
                ↘
                  Unknown      (rare: kubelet unreachable)
```

- `Pending` — pod accepted but not all containers running. Includes scheduling, image pulls, sandbox creation.
- `Running` — bound to a node, all containers created, at least one is running or restarting.
- `Succeeded` — all containers exited 0 and won't restart.
- `Failed` — at least one container exited non-zero with no further restarts.
- `Unknown` — communication with kubelet lost.

Most pods you care about are `Running`. The interesting bit is the **conditions** within Running:

```bash
kubectl get pod <name> -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
# Initialized=True
# Ready=True            ← gates Endpoint membership
# ContainersReady=True
# PodScheduled=True
```

`Ready=True` is the gate that puts the pod in a Service's Endpoints. If readiness probe fails, `Ready=False` and the pod is excluded from traffic but still Running.

---

## Termination flow

When a pod is deleted (`kubectl delete pod`, eviction, scale-down):

```
1. apiserver sets metadata.deletionTimestamp
2. apiserver returns to caller (delete API call returns)
3. kubelet sees the deletion timestamp:
   a. runs preStop hooks on each container
   b. sends SIGTERM to PID 1 of each container
   c. waits up to terminationGracePeriodSeconds (default 30s)
   d. sends SIGKILL if any container still alive
4. kubelet unmounts volumes
5. kubelet calls CRI to remove the sandbox
6. apiserver removes the pod object from etcd
```

Key point: the deletion API call returns immediately. Actual pod termination takes seconds to a minute. If you `kubectl get pods` right after delete, you see the pod in Terminating state for the grace period.

`--grace-period=0 --force` skips the grace period entirely. Use only for stuck pods.

---

## ServiceAccount + token mounting

Every pod has a ServiceAccount (defaults to `default` in its namespace). Kubelet mounts a projected SA token into:

```
/var/run/secrets/kubernetes.io/serviceaccount/token
/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
/var/run/secrets/kubernetes.io/serviceaccount/namespace
```

This token authenticates the pod to the apiserver. To opt out:

```yaml
spec:
  automountServiceAccountToken: false
```

For pods that don't call the API, this is good security hygiene.

---

## Pod identity in the cluster

| Field             | Set by                       | Example                           |
|-------------------|------------------------------|-----------------------------------|
| `metadata.name`   | user (or generated by RC)    | `web-5fd8c9d8f6-abc12`             |
| `metadata.namespace` | user                       | `default`                          |
| `spec.nodeName`   | scheduler                    | `worker-3`                         |
| `status.podIP`    | CNI (after sandbox creation) | `10.244.2.7`                       |
| `metadata.uid`    | apiserver                    | `5a7c-...`                         |

The pod IP changes if the pod is rescheduled. The name is stable until deletion. The UID is unique forever (recreating with the same name gives a new UID).

For DNS, see the coredns deck — pods get records under `.pod.cluster.local`, and StatefulSet pods get per-pod records via headless services.

---

## Ephemeral containers — debug-time only

```bash
kubectl debug -it <pod> --image=nicolaka/netshoot --target=<container>
```

Adds an **ephemeral container** to a running pod, sharing its namespaces. You can poke at the pod from inside without restarting it. The ephemeral container can't change resources, can't have probes, and doesn't survive pod restart. Pure debug tool.

The pod object grows an `ephemeralContainers` list reflecting any debug containers. They're not editable directly via `kubectl edit pod`; use `kubectl debug` to add.

---

## Pod scheduling fields recap

(Detailed in the scheduler deck.)

```yaml
spec:
  nodeSelector: { disktype: ssd }              # simple required match
  affinity:
    nodeAffinity: { ... }                       # required + preferred node match
    podAffinity: { ... }                        # co-locate with matching pods
    podAntiAffinity: { ... }                    # avoid matching pods
  tolerations: [ ... ]                          # tolerate node taints
  topologySpreadConstraints: [ ... ]            # balanced placement
  priorityClassName: high                       # scheduling priority
  preemptionPolicy: PreemptLowerPriority
  schedulerName: default-scheduler              # which scheduler claims this pod
  schedulingGates:                              # block from active queue
  - name: external-coordination
```

---

## Pod creation rate limit

A subtle one: kubelet's `--max-pods` defaults to 110. Trying to schedule more on one node fails with `OutOfPods`. Different from cluster-wide quotas; this is a per-node kubelet check.

For very dense clusters: raise `maxPods` in kubelet config + ensure the CIDR has enough pod IPs.

---

## Inspecting a pod thoroughly

```bash
# Status overview
kubectl get pod <name> -o wide

# Full state including events
kubectl describe pod <name>

# YAML — useful to see merged defaults, status conditions, ownerReferences
kubectl get pod <name> -o yaml

# Just the container statuses
kubectl get pod <name> -o jsonpath='{range .status.containerStatuses[*]}{.name}: ready={.ready}, restarts={.restartCount}, state={.state}{"\n"}{end}'

# Logs (current)
kubectl logs <name> -c <container>

# Logs (previous instance, if container restarted)
kubectl logs <name> -c <container> --previous

# Live attach (existing TTY)
kubectl attach -it <name>

# Exec a fresh process inside
kubectl exec -it <name> -- /bin/sh
```

---

## Common spec mistakes

### Image with no tag

```yaml
image: nginx        # implicit :latest, with imagePullPolicy: Always
```

`:latest` slows startup (always pulls), surprises you when the registry's `latest` changes. Always pin a tag or digest.

### Forgetting requests

```yaml
resources:
  limits:
    memory: 512Mi
# no requests → BestEffort QoS → first to be evicted
```

Always set requests, even if equal to limits.

### Mounting secrets as env vars (and exposing them in app crash dumps)

```yaml
env:
- name: PASSWORD
  valueFrom:
    secretKeyRef: { name: db, key: password }
```

Env vars appear in `ps`, in core dumps, in many app logs. Prefer mounting secrets as files via volumes when possible.

### Using `command` when you meant `args`

```yaml
command: [ "myarg" ]    # wipes the image's entrypoint, runs `myarg` as PID 1
```

Almost always you want `args:` to extend the image's ENTRYPOINT.

### `terminationGracePeriodSeconds: 0` "to make delete fast"

You'll get SIGKILL with no grace. App can't drain. State writes interrupted. Don't.

---

## Exam heuristics

- The exam often asks "create a pod" with several fields (env from configmap, mount a secret, set a probe, run as non-root). Practice writing pod specs from memory.
- `kubectl run <name> --image=<image> --dry-run=client -o yaml > pod.yaml` is the fastest way to get a starter spec.
- `kubectl explain pod.spec` and `kubectl explain pod.spec.containers` are your YAML schema lookup. Use them.
- `--restart=Never` on `kubectl run` makes a Pod (not a Deployment).

## Mental traps

- Confusing `command` with `args`. Different fields, big difference.
- Missing `resources.requests` and being surprised when the pod is BestEffort QoS and gets evicted first.
- Setting `imagePullPolicy: Never` and being surprised when an absent image fails forever.
- Forgetting that init containers don't support probes. Add probes only to main containers (regular init) or to sidecars (init with `restartPolicy: Always`).
- Using `:latest` and seeing different behavior on different nodes (different cached versions).
- Treating Pods as the unit of orchestration. They're the unit of scheduling; controllers (Deployment, ReplicaSet, StatefulSet, etc.) manage Pod lifecycles.
- Editing a Pod and being surprised most fields are immutable. Pod spec is mostly read-only after creation; recreate via the parent controller.
