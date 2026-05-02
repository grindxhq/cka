## Inspection patterns that save exam minutes

The CKA exam is time-pressured. Knowing the right inspection commands cold is what separates passing from running out of time. This subtopic is the cheat sheet.

---

## The basics

```bash
# All resources in a namespace
kubectl get all -n <ns>

# All resources cluster-wide (some kinds only)
kubectl get all -A
# `all` doesn't include every resource — Secrets, ConfigMaps, NetworkPolicies aren't "all."
# But Pods/Deployments/Services/etc are.

# Specific kind
kubectl get pods -A
kubectl get pods -A -o wide                        # adds IP, NODE, etc.

# Plus labels
kubectl get pods -A --show-labels
```

---

## Cross-namespace queries

```bash
# Add `-A` (or `--all-namespaces`) for cluster-wide
kubectl get pods -A

# Filter by label across all namespaces
kubectl get pods -A -l app=web

# Filter by namespace
kubectl get pods -A --field-selector metadata.namespace=dev   # equivalent to -n dev
```

---

## `--field-selector` (server-side filtering)

For better performance vs client-side jsonpath:

```bash
# Pods on a specific node
kubectl get pods -A --field-selector spec.nodeName=worker-1

# Failed pods
kubectl get pods -A --field-selector status.phase=Failed

# Multiple field selectors (AND)
kubectl get pods -A --field-selector spec.nodeName=worker-1,status.phase=Running

# Negation
kubectl get pods -A --field-selector status.phase!=Running

# Events for a specific resource
kubectl get events --field-selector involvedObject.name=my-pod

# Events of type Warning
kubectl get events --field-selector type=Warning -A
```

Allowed fields are limited — only specific ones per resource type. For more complex filters, fall back to client-side `-o jsonpath` or `jq`.

---

## `--show-labels`

```bash
kubectl get pods --show-labels
# Adds a LABELS column showing all labels — useful when figuring out why a Service / Deployment isn't matching.

kubectl get pods --show-labels=true | head
```

For a single resource:

```bash
kubectl get pod my-pod -o jsonpath='{.metadata.labels}{"\n"}'
# {"app":"web","version":"v1"}

kubectl get pod my-pod --show-labels
# Single-pod label list at end of output.
```

---

## `-o wide`

More columns:

```bash
kubectl get pods -o wide
# Adds: IP, NODE, NOMINATED NODE, READINESS GATES

kubectl get nodes -o wide
# Adds: INTERNAL-IP, EXTERNAL-IP, OS-IMAGE, KERNEL-VERSION, CONTAINER-RUNTIME

kubectl get svc -o wide
# Adds: SELECTOR
```

`-o wide` doesn't combine with custom-columns / jsonpath / yaml. For those, you craft your own columns.

---

## Sorting

```bash
# Pods by start time
kubectl get pods --sort-by=.status.startTime

# Pods by restart count (most-recent at the bottom)
kubectl get pods --sort-by=.status.containerStatuses[0].restartCount

# Events by lastTimestamp (newest at bottom — default for events)
kubectl get events --sort-by=.lastTimestamp

# Reverse: pipe through tac
kubectl get pods --sort-by=.status.startTime | tac
```

---

## Watching changes

```bash
# Stream Pod changes
kubectl get pods -w

# Watch a specific resource
kubectl get deploy web -w

# Skip the initial list (watch only changes)
kubectl get pods -w --watch-only

# Watch events live
kubectl get events -w --sort-by=.lastTimestamp
```

For "wait until X is true," use `kubectl wait`:

```bash
# Wait for pod to be Ready
kubectl wait --for=condition=Ready pod/my-pod --timeout=60s

# Wait for Deployment to finish rollout
kubectl rollout status deploy/web --timeout=5m

# Wait for namespace to be deleted
kubectl wait --for=delete ns/old-namespace --timeout=2m
```

`wait` exits 0 on success, non-zero on timeout — great for scripts.

---

## `kubectl describe` — the verbose detail

```bash
kubectl describe pod my-pod
```

Shows everything about the pod plus events and probe statuses. Read events first when debugging — they tell the story:

```
Events:
  Type     Reason          Age   Message
  ----     ------          ----  -------
  Normal   Scheduled       5m    Successfully assigned dev/my-pod to worker-1
  Normal   Pulling         5m    Pulling image "myapp:1.0"
  Warning  Failed          4m    Error: ImagePullBackOff
  Warning  FailedMount     4m    MountVolume.SetUp failed for volume "config"
```

For other resources:

```bash
kubectl describe deploy web
kubectl describe svc my-svc
kubectl describe node worker-1
kubectl describe pvc my-pvc
```

---

## `kubectl explain`

In-CLI schema reference:

```bash
kubectl explain pod                            # top-level
kubectl explain pod.spec                       # specific path
kubectl explain pod.spec.containers
kubectl explain pod.spec.containers.resources
kubectl explain pod.spec.containers.lifecycle.preStop

# Recursive (the whole tree)
kubectl explain pod.spec --recursive

# Specific apiVersion
kubectl explain deployment --api-version=apps/v1
```

Faster than searching the web. Use frequently when writing YAML.

---

## `kubectl api-resources`

Discover what's available:

```bash
# All resources
kubectl api-resources

# Just namespaced resources
kubectl api-resources --namespaced=true

# Just cluster-scoped
kubectl api-resources --namespaced=false

# Specific verbs
kubectl api-resources --verbs=list,delete

# Filter by API group
kubectl api-resources --api-group=apps

# Show short names too
kubectl api-resources -o wide
```

Useful when you can't remember "what's the apiVersion for an Ingress?" — `kubectl api-resources | grep ingress`.

---

## Multi-resource views

```bash
# Get all resources of multiple kinds
kubectl get pod,svc,deploy

# Or:
kubectl get pods,services,deployments

# Or short:
kubectl get po,svc,deploy
```

For viewing ownership chains:

```bash
# Krew plugin: kubectl tree
kubectl tree deployment web

# deployment.apps/web
# └── replicaset.apps/web-5fd8c9d8f6
#     ├── pod/web-5fd8c9d8f6-abc12
#     ├── pod/web-5fd8c9d8f6-def45
#     └── pod/web-5fd8c9d8f6-ghi78
```

Not built-in, but very handy for understanding ownership graphs.

---

## Common diagnostic patterns

### What's wrong with my pod?

```bash
kubectl get pod my-pod
kubectl describe pod my-pod | tail -20            # see Events
kubectl logs my-pod -c <container>
kubectl logs my-pod -c <container> --previous     # crashed previous instance
```

### Why isn't my Service routing?

```bash
kubectl get svc <name>
kubectl get endpoints <name>                       # empty? selector mismatch
kubectl get pods -l <selector-from-svc>            # do matching pods exist?
kubectl describe svc <name> | grep Endpoints
```

### Which node has high load?

```bash
kubectl top nodes
kubectl top pods -A
kubectl top pods -A --sort-by=cpu
kubectl top pods -A --sort-by=memory
```

(needs metrics-server)

### What's running on a specific node?

```bash
kubectl get pods -A -o wide --field-selector spec.nodeName=worker-1
```

### What's using which PVC?

```bash
# Pods using a PVC
kubectl get pods -A -o json | \
  jq -r '.items[] | select(.spec.volumes[]?.persistentVolumeClaim.claimName=="my-pvc") |
    "\(.metadata.namespace)/\(.metadata.name)"'
```

### Which Service has no Endpoints?

```bash
for svc in $(kubectl get svc -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'); do
  ns=${svc%/*}
  name=${svc#*/}
  count=$(kubectl get endpoints $name -n $ns -o json 2>/dev/null | jq '.subsets[0].addresses // [] | length')
  if [ "$count" = "0" ] || [ "$count" = "" ]; then
    echo "$svc — empty"
  fi
done
```

### Recent events cluster-wide

```bash
kubectl get events -A --sort-by=.lastTimestamp | tail -30
```

---

## `--dry-run` for safe testing

```bash
# Generate YAML without actually creating
kubectl run test-pod --image=nginx --dry-run=client -o yaml > pod.yaml

# Run admission checks without persisting (good for catching webhook errors)
kubectl apply -f pod.yaml --dry-run=server

# Both at once: generate, then submit to admission only
kubectl create deploy web --image=nginx --dry-run=client -o yaml | \
  kubectl apply -f - --dry-run=server
```

`--dry-run=client` is fast (kubectl-only). `--dry-run=server` actually goes through admission (catches webhook violations, RBAC issues).

---

## Generating YAML scaffolding fast

```bash
# Pod
kubectl run my-pod --image=nginx --dry-run=client -o yaml

# Pod with command override
kubectl run my-pod --image=busybox --dry-run=client -o yaml -- sleep 3600

# Deployment
kubectl create deploy web --image=nginx --replicas=3 --dry-run=client -o yaml

# Service (ClusterIP)
kubectl create svc clusterip my-svc --tcp=80:8080 --dry-run=client -o yaml

# Service (NodePort)
kubectl create svc nodeport my-svc --tcp=80:8080 --dry-run=client -o yaml

# ConfigMap from literals
kubectl create cm config --from-literal=key1=val1 --dry-run=client -o yaml

# Secret from literals
kubectl create secret generic creds --from-literal=password=xxx --dry-run=client -o yaml

# Role
kubectl create role pod-reader --verb=get,list,watch --resource=pods --dry-run=client -o yaml

# RoleBinding
kubectl create rolebinding alice-pods --role=pod-reader --user=alice --dry-run=client -o yaml

# Job
kubectl create job test --image=busybox --dry-run=client -o yaml -- sleep 30

# CronJob
kubectl create cronjob backup --image=busybox --schedule="0 2 * * *" --dry-run=client -o yaml -- echo backup
```

Pipe to a file, edit, apply. Faster than memorizing schemas:

```bash
kubectl run my-pod --image=nginx --dry-run=client -o yaml > pod.yaml
vim pod.yaml                                    # tweak
kubectl apply -f pod.yaml
```

---

## kubectl logs essentials

```bash
# Latest logs
kubectl logs <pod>

# Specific container
kubectl logs <pod> -c <container>

# Previous instance (after restart)
kubectl logs <pod> -c <container> --previous

# Follow (like tail -f)
kubectl logs <pod> -f

# Last N lines
kubectl logs <pod> --tail=100

# Since
kubectl logs <pod> --since=10m
kubectl logs <pod> --since-time=2024-01-01T00:00:00Z

# Multi-pod (label selector)
kubectl logs -l app=web --tail=100
kubectl logs -l app=web --all-containers --tail=100

# All pods, all containers
kubectl logs -l app=web --all-containers --prefix --tail=20
# Adds [pod/container] prefix per line.
```

For truly large multi-pod log analysis, ship to a logging backend (ELK, Loki, CloudWatch) and query there.

---

## kubectl exec and debug

```bash
# Open a shell in a pod
kubectl exec -it <pod> -- /bin/sh

# Specific container
kubectl exec -it <pod> -c <container> -- /bin/bash

# Run a one-off command
kubectl exec <pod> -- cat /etc/hosts

# Pipe data in
echo "hello" | kubectl exec -i <pod> -- cat > /tmp/file

# Copy files
kubectl cp <pod>:/path/to/file ./local-file
kubectl cp ./local-file <pod>:/path/to/file
```

For debugging without modifying the pod, `kubectl debug`:

```bash
# Add an ephemeral container with a richer image
kubectl debug -it <pod> --image=nicolaka/netshoot --target=<container>

# Debug a node (creates a pod with hostpath access)
kubectl debug node/<node> --image=ubuntu --hostNetwork
```

`netshoot` has dig, curl, tcpdump, nslookup, and more. Useful for in-pod network debugging without baking these tools into your app images.

---

## Resource cleanup patterns

```bash
# Delete a resource by name
kubectl delete pod my-pod

# Delete by label
kubectl delete pods -l app=web

# Delete from a YAML file (matches what was created)
kubectl delete -f deploy.yaml

# Delete every pod in a namespace
kubectl delete pods --all -n dev

# Delete a namespace (cascades to all contents)
kubectl delete ns dev

# Force delete a stuck pod (skip grace period)
kubectl delete pod my-pod --grace-period=0 --force
```

`--force` only matters for pods stuck Terminating; doesn't help with finalizers (those need explicit removal).

---

## Quick wins for the exam

```bash
# Aliases (set up at exam start)
alias k=kubectl
source <(kubectl completion bash)
complete -F __start_kubectl k

# Force a generated YAML to the clipboard or file
kubectl run my-pod --image=nginx --dry-run=client -o yaml | tee pod.yaml

# Combine: generate + edit + apply in one go
kubectl run my-pod --image=nginx --dry-run=client -o yaml | vim - | kubectl apply -f -

# Quick "describe last events"
kubectl get events -A --sort-by=.lastTimestamp | tail -20

# What pods are not Ready?
kubectl get pods -A --field-selector status.phase!=Running
kubectl get pods -A | awk '{print $1, $2, $3}' | grep -v 'Running\|Completed' | head

# All pending pods
kubectl get pods -A --field-selector status.phase=Pending

# All pods on a specific node
kubectl get pods -A -o wide --field-selector spec.nodeName=<node>

# Top-level resource summary
kubectl get all -A
```

---

## kubectl plugins

The Krew plugin manager extends kubectl:

```bash
# Install krew (one-time setup)
( set -x; cd "$(mktemp -d)" &&
  curl -fsSLO "https://github.com/kubernetes-sigs/krew/releases/latest/download/krew-linux_amd64.tar.gz" &&
  tar zxvf krew-linux_amd64.tar.gz &&
  ./krew-linux_amd64 install krew )

# Useful plugins
kubectl krew install ctx               # kubectx-like context switching
kubectl krew install ns                 # kubens-like namespace switching
kubectl krew install tree               # show resource ownership tree
kubectl krew install neat               # clean up YAML output
kubectl krew install whoami             # show identity (alternative to auth whoami)
```

CKA exam doesn't allow Krew (no internet during exam), so don't rely on these in exam practice. For real-world ops they're great.

---

## When `kubectl` itself fails

If `kubectl` returns errors before reaching the cluster:

```bash
# Connection refused / timeout
kubectl version --short
# Server: Unable to connect to the server: dial tcp: lookup ...: no such host

# Check current cluster URL
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'

# Check DNS
nslookup <apiserver-host>

# Check direct connectivity
nc -zv <host> <port>

# Verify cert
kubectl version           # makes a minimal call
```

For "the cluster is gone" scenarios, see static-pods, kubelet, and api-server decks.

---

## Exam heuristics

- **Set up `alias k=kubectl` immediately** at exam start. Saves keystrokes.
- For "create resource X," try `kubectl create X --dry-run=client -o yaml > x.yaml` to generate scaffolding.
- For "fix this resource," `kubectl edit` is fastest.
- `kubectl get all -A` for "what's running here?" overview.
- `kubectl describe <resource> <name>` for "what happened to this?"
- `kubectl get events --sort-by=.lastTimestamp -A | tail` for "recent activity."

## Mental traps

- Forgetting `-A` and only seeing the current namespace's resources.
- Using `kubectl describe` for everything when `kubectl get -o yaml` would give cleaner output for scripts.
- Trusting `--show-labels` to be the same as `metadata.labels` — it does flatten differently.
- Using `kubectl edit` in scripts. It's interactive; use `kubectl patch` instead.
- Dry-run-client when you needed dry-run-server (admission webhooks won't fire on client-side).
- Running `kubectl logs -f` and forgetting to Ctrl-C. Stale connection drains exam time.
- Filtering with field-selector against fields that aren't supported (only specific allowed paths). Falling back to jsonpath for unsupported fields.
