## Why output formatting matters

Default `kubectl get pods` output is human-friendly columnar text. Useful for reading, terrible for scripts. To extract specific fields cleanly, use one of:

- **`-o yaml`** / **`-o json`** — full object representation.
- **`-o name`** — just the resource names.
- **`-o jsonpath`** — pull specific fields with a query.
- **`-o jsonpath-as-json`** — query result as JSON.
- **`-o custom-columns`** — table format with chosen columns.
- **`-o custom-columns-file`** — same but from a file.
- **`-o go-template`** — Go template syntax.

For exam speed: master `-o jsonpath`, `-o custom-columns`, `-o name`. They cover 90% of script-y / inspection needs.

---

## `-o jsonpath` — pulling specific fields

JSONPath is a query language for navigating a JSON document. kubectl uses a subset of it:

```bash
# Single field
kubectl get pod my-pod -o jsonpath='{.metadata.name}'
# my-pod

# Field with newline (so it's terminal-friendly)
kubectl get pod my-pod -o jsonpath='{.metadata.name}{"\n"}'
# my-pod

# Field from a list (every item)
kubectl get pods -o jsonpath='{.items[*].metadata.name}'
# my-pod another-pod third-pod

# With newlines per item
kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'
# my-pod
# another-pod
# third-pod

# Multiple fields per line, tab-separated
kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\n"}{end}'
# my-pod    Running
# another-pod   Pending
```

Key constructs:

- `{...}` — wraps the JSONPath expression.
- `{"\n"}` / `{"\t"}` — literal characters.
- `{range ...}{...}{end}` — iterate over a collection.
- `{.field}` — field access.
- `{.array[*]}` — all items.
- `{.array[0]}` — first item.
- `{.array[-1]}` — last item.

### Filters

```bash
# Pods that are Running
kubectl get pods -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\n"}{end}'

# Pods owned by a specific RS
kubectl get pods -o jsonpath='{range .items[?(@.metadata.ownerReferences[0].name=="my-rs")]}{.metadata.name}{"\n"}{end}'

# Pods on a specific node
kubectl get pods -o jsonpath='{range .items[?(@.spec.nodeName=="worker-1")]}{.metadata.name}{"\n"}{end}'
```

`[?(condition)]` is the filter syntax. `@` refers to the current item.

Note: kubectl's JSONPath is a **subset** of the full JSONPath spec. Some advanced features (regex, complex expressions) may not work. When in doubt, fall back to `-o json | jq`.

### Common patterns

```bash
# All pod IPs
kubectl get pods -o jsonpath='{range .items[*]}{.status.podIP}{"\n"}{end}'

# Service ClusterIP
kubectl get svc <name> -o jsonpath='{.spec.clusterIP}'

# Container images for a pod
kubectl get pod <name> -o jsonpath='{.spec.containers[*].image}'

# Container names + images
kubectl get pod <name> -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.image}{"\n"}{end}'

# Node IPs
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}'

# Image of a Deployment's first container
kubectl get deploy <name> -o jsonpath='{.spec.template.spec.containers[0].image}'

# Env vars on a pod
kubectl get pod <name> -o jsonpath='{range .spec.containers[*].env[*]}{.name}={.value}{"\n"}{end}'
```

---

## `-o jsonpath-as-json`

When you want the result as actual JSON (e.g. piping to `jq`):

```bash
kubectl get pods -o jsonpath-as-json='{.items[*].metadata.name}'
# [
#     "my-pod",
#     "another-pod"
# ]
```

Useful when you need a structured result for further processing. Otherwise `jsonpath` flattens to whitespace-separated text.

---

## `-o custom-columns`

A more readable, table-style output with chosen columns:

```bash
kubectl get pods -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,IP:.status.podIP,NODE:.spec.nodeName'

# NAME              STATUS    IP            NODE
# my-pod            Running   10.244.1.5    worker-1
# another-pod       Pending   <none>        <none>
# third-pod         Running   10.244.2.7    worker-2
```

Each column is `HEADER:.path.to.field`. Multiple columns separated by commas (no spaces around commas — kubectl is strict).

For very long custom-columns, use a file:

```yaml
# columns.txt
NAME           .metadata.name
NAMESPACE      .metadata.namespace
NODE           .spec.nodeName
PHASE          .status.phase
START_TIME     .status.startTime
RESTARTS       .status.containerStatuses[0].restartCount
```

Then:

```bash
kubectl get pods -A -o custom-columns-file=columns.txt
```

The file is whitespace-separated (any column-name + path on one line).

### Common custom-column patterns

```bash
# Pods with their resource requests
kubectl get pods -o custom-columns='NAME:.metadata.name,CPU_REQ:.spec.containers[0].resources.requests.cpu,MEM_REQ:.spec.containers[0].resources.requests.memory'

# Services with their endpoints (well, ports)
kubectl get svc -o custom-columns='NAME:.metadata.name,TYPE:.spec.type,CLUSTER-IP:.spec.clusterIP,PORT:.spec.ports[*].port'

# Nodes with version + OS
kubectl get nodes -o custom-columns='NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion,OS:.status.nodeInfo.osImage,KERNEL:.status.nodeInfo.kernelVersion'

# Containers across all pods (one per line)
kubectl get pods -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.name}@{$.metadata.name}{"\t"}{.image}{"\n"}{end}{end}'
```

---

## `-o name`

Just the resource names, prefixed with kind:

```bash
kubectl get pods -o name
# pod/my-pod
# pod/another-pod

kubectl get all -o name
# pod/...
# service/...
# deployment.apps/...
```

Useful for piping into other commands:

```bash
# Delete all pods in a namespace
kubectl get pods -o name | xargs kubectl delete -n dev

# Get details of every pod
kubectl get pods -o name | xargs -I {} kubectl describe {} -n dev
```

---

## `-o yaml` / `-o json`

Full object representation:

```bash
kubectl get pod my-pod -o yaml      # YAML
kubectl get pod my-pod -o json      # JSON
```

Useful for:

- Inspecting all fields (server-injected ones too).
- Backing up before edits.
- Piping to `jq` (JSON) or `yq` (YAML).

```bash
# Just the spec
kubectl get pod my-pod -o yaml | yq '.spec'

# Container resources
kubectl get pod my-pod -o json | jq '.spec.containers[].resources'
```

---

## Field selectors (server-side filtering)

JSONPath filters are **client-side** (kubectl gets the full list, then filters). For large lists, prefer **field selectors** which filter on the server:

```bash
# Pods on a specific node — server-side filter
kubectl get pods -A --field-selector spec.nodeName=worker-1

# Failed pods cluster-wide
kubectl get pods -A --field-selector status.phase=Failed

# Pods NOT on a node
kubectl get pods -A --field-selector spec.nodeName!=worker-1
```

Field selectors use only specific fields (a small allowlist per resource type). Common ones:

- `metadata.name`
- `metadata.namespace`
- `spec.nodeName`
- `status.phase`
- `type` (for events)
- `involvedObject.name` (for events)

For arbitrary filters, use label selectors or client-side JSONPath.

---

## Label selectors

For resources with labels:

```bash
# Pods with a specific label
kubectl get pods -l app=web

# Multiple labels (AND)
kubectl get pods -l app=web,tier=frontend

# Negation
kubectl get pods -l app!=web

# Set membership
kubectl get pods -l 'tier in (frontend,backend)'
kubectl get pods -l 'tier notin (test)'

# Existence
kubectl get pods -l app                  # has any 'app' label
kubectl get pods -l '!app'                # missing 'app' label
```

Combine with output formats:

```bash
kubectl get pods -l app=web -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'
```

---

## `--show-labels`

Quick inspection of all labels:

```bash
kubectl get pods --show-labels

# NAME              READY   STATUS    AGE   LABELS
# my-pod            1/1     Running   5m    app=web,pod-template-hash=abc123,tier=frontend
```

Useful for "why isn't my Service finding pods?" — see what labels they actually have.

---

## `-o wide`

More columns (for human reading):

```bash
kubectl get pods -o wide

# NAME    READY   STATUS    AGE   IP            NODE        NOMINATED NODE   READINESS GATES
# my-pod  1/1     Running   5m    10.244.1.5    worker-1    <none>           <none>
```

Adds IP, node, etc. Doesn't work with `-o name` / jsonpath / custom-columns (they have their own format).

---

## `--sort-by`

Sort by a JSONPath:

```bash
# Pods sorted by start time (oldest first)
kubectl get pods --sort-by=.status.startTime

# Sorted by restart count (most-restarted last; reverse for top problem pods)
kubectl get pods --sort-by=.status.containerStatuses[0].restartCount

# Events (most recent last is the default; reverse with awk if needed)
kubectl get events --sort-by=.lastTimestamp
```

---

## `--watch` / `-w`

Stream changes:

```bash
kubectl get pods -w
# Like a live tail. Each change to a pod prints a new line.

# Start watch from now (skip initial list)
kubectl get pods -w --watch-only

# Watch a specific pod
kubectl get pod my-pod -w
```

Useful for "wait for this pod to become Ready":

```bash
kubectl wait --for=condition=Ready pod/my-pod --timeout=60s
# Success/failure based on whether it transitions to Ready in 60s.
```

`kubectl wait` is more programmatic than `kubectl get -w`. Use it in scripts.

---

## `kubectl explain`

Schema documentation right in the CLI:

```bash
# Top-level resources
kubectl explain pod

# Specific path
kubectl explain pod.spec
kubectl explain pod.spec.containers
kubectl explain pod.spec.containers.resources
kubectl explain pod.spec.containers.resources.requests

# Recursive (the whole tree)
kubectl explain pod.spec --recursive

# Specific apiVersion
kubectl explain deployment.spec --api-version=apps/v1
```

Output is the OpenAPI schema, including descriptions. Faster than searching the docs while writing YAML.

```bash
kubectl explain pod.spec.containers.lifecycle.preStop
# KIND:     Pod
# VERSION:  v1
#
# RESOURCE: preStop <Object>
#
# DESCRIPTION:
#   PreStop is called immediately before a container is terminated...
```

---

## Combining tools

For complex queries, kubectl + jq is the workhorse:

```bash
# Pods with > 5 restarts
kubectl get pods -o json | \
  jq -r '.items[] | select(.status.containerStatuses[]?.restartCount > 5) | .metadata.name'

# Containers using >=1 GiB memory limit
kubectl get pods -A -o json | \
  jq -r '.items[] |
    select(.spec.containers[].resources.limits.memory // "0" |
      (sub("Mi"; "")|tonumber) > 1024) |
    "\(.metadata.namespace)/\(.metadata.name)"'

# Top 10 events sorted by count
kubectl get events -A -o json | \
  jq -r '.items | group_by(.message)[] | "\(length)\t\(.[0].message)"' | sort -nr | head
```

For YAML manipulation, `yq`:

```bash
# Extract one container's spec
kubectl get pod my-pod -o yaml | yq '.spec.containers[] | select(.name == "main")'

# Update a value in-place (then re-apply)
kubectl get deploy web -o yaml | yq '.spec.template.spec.containers[0].image = "nginx:1.27"' | kubectl apply -f -
```

---

## Aliases for speed

The `~/.bashrc` / `~/.zshrc` setup most exam-takers use:

```bash
alias k=kubectl
alias kgp='kubectl get pods'
alias kgs='kubectl get services'
alias kgd='kubectl get deployments'
alias kdp='kubectl describe pod'
alias kn='kubectl config set-context --current --namespace'

# kubectl autocompletion (varies by shell)
source <(kubectl completion bash)
complete -F __start_kubectl k
```

Practice these. In a 2-hour exam, every saved keystroke counts.

---

## `--dry-run` for kubectl create

Generate YAML without creating:

```bash
# Generate YAML for a Pod
kubectl run my-pod --image=nginx --dry-run=client -o yaml > pod.yaml

# Edit pod.yaml as needed, then apply
kubectl apply -f pod.yaml

# Same for Deployments
kubectl create deploy web --image=nginx --replicas=3 --dry-run=client -o yaml > deploy.yaml

# Service
kubectl create service clusterip my-svc --tcp=80:8080 --dry-run=client -o yaml > svc.yaml

# RBAC
kubectl create role pod-reader --verb=get,list,watch --resource=pods --dry-run=client -o yaml
```

Way faster than writing YAML from memory. Tweak the output, apply.

`--dry-run=server` actually goes to the apiserver and runs admission, then returns what would have been created. Useful for catching admission webhook errors without committing.

---

## Real diagnostic patterns

### Pods over their requests

```bash
kubectl top pod -A --containers --sort-by=memory | head -20
```

(needs metrics-server)

### Find pods on a specific node

```bash
kubectl get pods -A -o wide --field-selector spec.nodeName=worker-3
```

### Find pods using a specific image

```bash
kubectl get pods -A -o json | \
  jq -r '.items[] | select(.spec.containers[].image | contains("nginx")) | "\(.metadata.namespace)/\(.metadata.name)"'
```

### Find Services missing endpoints

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

### Watch RC changes during a Deployment rollout

```bash
kubectl get rs -l app=web -w
```

---

## Output troubleshooting

### "error: error executing jsonpath ..."

Syntax issue. Common ones:

- Missing `{...}` braces.
- Field name typo.
- Trying to access `.foo` when the field is `.foo.bar`.

Test against the JSON directly:

```bash
kubectl get pod my-pod -o json | jq '.metadata.name'
# Verify the path works in jq, then translate to JSONPath.
```

### Empty output

The path is valid but the field is null/missing. e.g. `status.podIP` is empty for Pending pods.

Filter to only items that have the field:

```bash
kubectl get pods -o jsonpath='{range .items[?(@.status.podIP)]}{.metadata.name}{"\t"}{.status.podIP}{"\n"}{end}'
```

### custom-columns shows nothing

Misnamed path or wrong resource. Test with `-o json` first to confirm the field exists.

---

## Exam heuristics

- For "which pod is on which node," `kubectl get pods -o wide`.
- For "fetch the image of a pod's container," jsonpath.
- `kubectl explain` is your YAML schema reference; use it instead of memorizing.
- `--dry-run=client -o yaml` generates starter YAML — edit, then apply.
- For complex filtering, `jq` is faster than wrestling with JSONPath.

## Mental traps

- Forgetting newlines in jsonpath. Output is space-separated by default.
- Using JSONPath where a field selector would be faster + simpler.
- Strict syntax for custom-columns (no spaces around commas).
- Trying to use full JSONPath features (regex, etc.) — kubectl's subset doesn't support them.
- Editing YAML output and forgetting it includes server-side fields (`status`, `metadata.uid`) that you shouldn't re-apply. Use `--export` (deprecated) or strip them manually.
- Using `kubectl get -w` in scripts that need exit codes. Use `kubectl wait` instead.
- Running `--dry-run=client` and assuming admission would have allowed it. Use `--dry-run=server` for that.
