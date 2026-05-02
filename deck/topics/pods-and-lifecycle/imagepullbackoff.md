## ImagePullBackOff vs ErrImagePull vs CrashLoopBackOff

These three states all show up in `kubectl get pods` and confuse beginners. They mean very different things:

- **ImagePullBackOff** — kubelet failed to pull the image and is in cooldown before retry.
- **ErrImagePull** — the most recent pull attempt failed (intermediate state, often immediately precedes ImagePullBackOff).
- **CrashLoopBackOff** — image pulled fine, container started, then crashed.

ImagePullBackOff is **before the container even runs**. CrashLoop is **the container ran and died**. Different fixes.

---

## How image pulls actually work

When a Pod starts on a node:

```
1. kubelet sees the Pod assigned, reads spec.containers[].image
2. kubelet checks node's local image cache:
   - Image present + imagePullPolicy: IfNotPresent → skip pull
   - Image absent + any policy → must pull
   - imagePullPolicy: Always → must pull
3. kubelet calls CRI ImageService.PullImage(image, auth credentials)
4. Container runtime (containerd/cri-o) authenticates with registry
5. Runtime downloads layers, validates checksums
6. Image now in node's cache
7. kubelet proceeds to CreateContainer
```

Auth comes from:

- **imagePullSecrets** declared on the pod or its ServiceAccount (most common).
- **Kubelet credential provider plugin** (cloud-native: AWS ECR, GCP GCR, Azure ACR — kubelet can fetch fresh credentials from cloud APIs).
- **Anonymous** for public images.

---

## Image pull policies

```yaml
spec:
  containers:
  - name: app
    image: myapp:1.0
    imagePullPolicy: IfNotPresent     # | Always | Never
```

| Policy | Behavior | Default for |
|--------|----------|-------------|
| `IfNotPresent` | Pull only if not in node's image cache | Tagged images (`myapp:1.0`) |
| `Always` | Pull every time the container starts | `:latest` tag, or no tag |
| `Never` | Never pull; fail if not in cache | (never default) |

The `:latest` defaulting to Always is a special rule. It means:

- Slower start (network roundtrip every time).
- Vulnerable to registry outages.
- Surprising behavior when "latest" silently changes.

**Always pin an explicit tag** (or even better, an immutable digest like `myapp@sha256:abc...`).

---

## Common ImagePullBackOff causes

### 1. Wrong image name or tag (typo)

```yaml
image: nginx:1.25
```

If `1.25` doesn't exist, registry returns 404. kubelet logs:

```
Failed to pull image "nginx:1.25": rpc error: code = NotFound desc = ... manifest unknown
```

Fix: use a real tag.

```bash
# Verify the tag exists
docker manifest inspect nginx:1.25       # OR `crane manifest`
```

### 2. Private registry, no credentials

```yaml
image: private.io/myapp:1.0
```

Registry requires auth. No `imagePullSecret` referenced. kubelet logs:

```
Failed to pull image: rpc error: ... unauthorized: authentication required
```

Fix: create an imagePullSecret and reference it.

```bash
# Create a docker-registry secret
kubectl create secret docker-registry myreg \
  --docker-server=private.io \
  --docker-username=<user> \
  --docker-password=<password> \
  --docker-email=<email>

# Reference in the Pod
spec:
  imagePullSecrets:
  - name: myreg
  containers:
  - image: private.io/myapp:1.0
```

Or attach to the ServiceAccount so all pods using it inherit:

```bash
kubectl patch serviceaccount default -p '{"imagePullSecrets":[{"name":"myreg"}]}'
```

### 3. Wrong credentials

Right secret name but wrong credentials inside it:

```
Failed to pull image: rpc error: ... unauthorized: incorrect username or password
```

Fix: regenerate the secret with correct creds.

### 4. Registry unreachable (DNS / network)

```
Failed to pull image: rpc error: ... lookup my-registry.io: no such host
```

Or:

```
Failed to pull image: rpc error: ... dial tcp: i/o timeout
```

Fix: check DNS resolution from the node, check firewall rules to the registry, check that the node has internet egress (or VPC peering for internal registries).

```bash
# From the node:
nslookup my-registry.io
curl -v https://my-registry.io/v2/
```

### 5. Wrong architecture

```yaml
image: myapp:1.0       # built for amd64; node is arm64
```

Manifest exists but no matching arch. Modern registries return:

```
Failed to pull image: rpc error: ... no matching manifest for linux/arm64 in the manifest list entries
```

Fix: build a multi-arch image (`docker buildx build --platform linux/amd64,linux/arm64 ...`) or pull the right arch's image.

### 6. Image too large / network slow

```
Failed to pull image: ... context deadline exceeded
```

Pull took too long. kubelet's pull timeout is large but not infinite. Slow networks + huge images (multi-GB) can trip it.

Fix: smaller images (alpine bases, multi-stage builds), faster network, or pre-pull on nodes.

### 7. Disk full on node

```
Failed to pull image: ... no space left on device
```

Node's image filesystem is full. Image GC didn't catch up.

Fix: clean up unused images (`crictl rmi --prune`), expand the disk, or reduce image churn.

### 8. Docker Hub rate limits

Public Docker Hub limits anonymous pulls (100/6h per IP) and authenticated pulls (200/6h for free).

```
Failed to pull image: ... toomanyrequests: You have reached your pull rate limit
```

Fix: authenticate to Docker Hub (works around the lower anon limit), or mirror the image to a private registry.

### 9. Image manifest deleted from registry

```
Failed to pull image: ... manifest unknown
```

The tag/digest is gone. Fix: use a version that still exists.

### 10. ImagePullPolicy: Never on missing image

```yaml
imagePullPolicy: Never
```

Image isn't in the node's cache. kubelet won't try to pull. Pod stays in `ErrImageNeverPull`.

Fix: change policy, OR pre-pull the image to every node manually.

---

## Reading the error

`kubectl describe pod <pod>` tells you which case you're in:

```
Containers:
  app:
    State:          Waiting
    Reason:         ImagePullBackOff
Events:
  Type    Reason   Age  From     Message
  ----    ------   ---  ----     -------
  Normal  Pulling  10s  kubelet  Pulling image "private.io/myapp:1.0"
  Warning Failed   9s   kubelet  Failed to pull image: rpc error: ... unauthorized: authentication required
  Warning Failed   9s   kubelet  Error: ErrImagePull
  Normal  BackOff  8s   kubelet  Back-off pulling image "private.io/myapp:1.0"
```

The **Failed** events have the actual error message — that's what you read first.

---

## imagePullSecrets in detail

A docker-registry secret stores registry credentials. Pod uses it via `spec.imagePullSecrets`.

### Create a Secret

```bash
kubectl create secret docker-registry <name> \
  --docker-server=<host> \
  --docker-username=<user> \
  --docker-password=<password> \
  --docker-email=<email>           # email is mostly cosmetic now
```

The Secret is `type: kubernetes.io/dockerconfigjson` and the data is a base64-encoded `~/.docker/config.json`-equivalent.

```yaml
# What you get
apiVersion: v1
kind: Secret
type: kubernetes.io/dockerconfigjson
metadata:
  name: myreg
data:
  .dockerconfigjson: <base64-of-config-json>
```

### Reference from a Pod

```yaml
spec:
  imagePullSecrets:
  - name: myreg
  containers:
  - image: private.io/myapp:1.0
```

Multiple secrets allowed; kubelet tries each in order until one works.

### Reference from a ServiceAccount

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: default
imagePullSecrets:
- name: myreg
```

Now every pod that uses this ServiceAccount automatically inherits the imagePullSecret. Convenient for cluster-wide private registry access.

```bash
kubectl patch serviceaccount default -p '{"imagePullSecrets":[{"name":"myreg"}]}'
```

### Multi-registry credentials

For multiple registries, you can either:

- One Secret per registry, list all in `imagePullSecrets`.
- One Secret with multiple registry entries inside the dockerconfigjson.

The latter requires hand-crafting the JSON or using `kubectl create secret docker-registry` multiple times then merging — most teams just use multiple secrets.

---

## Cloud kubelet credential providers

For AWS ECR, GCP GCR/AR, Azure ACR — credentials rotate frequently (12-hour TTL on ECR tokens). Storing them as static Secrets means rotation pain.

Modern kubelets support **credential provider plugins**: external binaries kubelet runs to fetch fresh credentials at pull time.

```yaml
# /var/lib/kubelet/credential-provider-config.yaml
apiVersion: kubelet.config.k8s.io/v1
kind: CredentialProviderConfig
providers:
- name: ecr-credential-provider
  matchImages:
  - "*.dkr.ecr.*.amazonaws.com"
  - "*.dkr.ecr.us-east-1.amazonaws.com"
  defaultCacheDuration: "12h"
  apiVersion: credentialprovider.kubelet.k8s.io/v1
```

The plugin binary lives at `/etc/eks/image-credential-provider/ecr-credential-provider` (EKS) or similar. It uses the node's IAM role (or instance profile) to mint a fresh token, returns it to kubelet.

Pods don't need imagePullSecrets at all — kubelet handles it transparently. This is how EKS / GKE / AKS make ECR/GCR/ACR pulls "just work."

For CKA, recognize this exists; you usually won't configure it directly.

---

## ErrImagePull vs ImagePullBackOff

These are sequential states:

```
 First pull attempt fails       → state: Waiting, reason: ErrImagePull
 kubelet schedules retry         → state: Waiting, reason: ImagePullBackOff
 Backoff expires                  → retry pull
 Fails again                       → ErrImagePull → ImagePullBackOff
 ... loop with exponential backoff (capped at 5 minutes)
```

`ErrImagePull` is the immediate "tried, failed" state. `ImagePullBackOff` is "in cooldown before next try."

In practice you'll see `ImagePullBackOff` 95% of the time because kubelet cycles between them quickly.

---

## "ErrImageNeverPull" — different beast

```yaml
imagePullPolicy: Never
```

Image isn't on the node and `Never` says don't pull. State:

```
State:    Waiting
Reason:   ErrImageNeverPull
Message:  Container image "myapp:1.0" is not present with pull policy of Never
```

Fix: change policy to `IfNotPresent` or `Always`, OR ensure the image is pre-pulled on every node.

Pre-pull manually:

```bash
# On each node
crictl pull myapp:1.0
```

For local development clusters (kind, minikube), `kind load docker-image myapp:1.0` loads from the local docker daemon into the kind nodes' image cache.

---

## Speedup: pre-pulled images

For huge images (ML models, custom OS bases), pull-on-pod-start is slow. Two patterns to avoid:

### DaemonSet that pulls

A DaemonSet of pods running `imagePullPolicy: Always` ensures every node pulls the image:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: image-pre-puller
spec:
  selector: { matchLabels: { app: pre-puller } }
  template:
    metadata: { labels: { app: pre-puller } }
    spec:
      initContainers:
      - name: prepull
        image: huge-model:v1
        command: [ "true" ]
        imagePullPolicy: Always
      containers:
      - name: pause
        image: registry.k8s.io/pause:3.9
```

Init container pulls the big image; main container is just `pause`. Once running, the image is cached on every node.

### Image registry mirror

A node-local registry mirror (e.g. a Squid proxy or a registry running on each node). Saves bandwidth and speeds repeated pulls. Operational complexity, but worth it at scale.

---

## Diagnostic commands

```bash
# What state is the container in?
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].state}'

# Pull events on this pod
kubectl describe pod <pod> | grep -A 1 'Pulling\|Pulled\|Failed'

# All ImagePullBackOff pods cluster-wide
kubectl get pods -A -o json | jq -r '
  .items[] | select(.status.containerStatuses[]?.state.waiting.reason
                    | IN("ImagePullBackOff","ErrImagePull","ErrImageNeverPull")) |
  "\(.metadata.namespace)/\(.metadata.name): \(.spec.containers[].image)"'

# Test pull manually from a node
crictl pull myapp:1.0

# Check existing images on a node
crictl images | grep myapp

# Check image pull secrets a pod is using
kubectl get pod <pod> -o jsonpath='{.spec.imagePullSecrets}'

# Check what credentials a Secret contains
kubectl get secret myreg -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d | jq
```

---

## Patterns and fixes

| Symptom                                                  | Fix                                                       |
|----------------------------------------------------------|-----------------------------------------------------------|
| `manifest unknown`                                        | Wrong image tag — check name/tag spelling                 |
| `unauthorized: authentication required`                   | Add `imagePullSecrets` with valid credentials             |
| `unauthorized: incorrect username or password`            | Regenerate secret with correct credentials                |
| `dial tcp: i/o timeout`                                   | Network: check node-to-registry connectivity              |
| `lookup ...: no such host`                                | DNS: registry hostname doesn't resolve                    |
| `no matching manifest for linux/arm64`                    | Build multi-arch image, or use correct arch               |
| `no space left on device`                                 | Free disk on node (`crictl rmi --prune`)                   |
| `toomanyrequests: pull rate limit`                        | Auth to Docker Hub, or use private mirror                 |
| `Container image ... is not present with pull policy of Never` | Change pull policy or pre-pull manually               |

---

## Exam heuristics

- Pull failures show in `kubectl describe pod` Events — read them, don't guess.
- For private registry exam scenarios, `kubectl create secret docker-registry` and reference via `imagePullSecrets`.
- Always pin explicit tags. `:latest` is the source of half the production weirdness.
- For "pod stuck pulling" exams, check (a) image name/tag exists, (b) credentials present, (c) network reachable.

## Mental traps

- Confusing ImagePullBackOff (image issue) with CrashLoopBackOff (app issue). Different reasons, different fixes.
- Adding imagePullSecret to a pod that doesn't use that registry. Doesn't help; check actual image's registry.
- Putting credentials in env vars instead of using docker-registry secret. Wrong field; kubelet looks for `kubernetes.io/dockerconfigjson` Secrets.
- Setting `imagePullPolicy: Never` to "save bandwidth" without pre-pulling images. Pods stuck `ErrImageNeverPull` forever.
- Using `:latest` and being surprised when nodes have different versions cached.
- Forgetting that `kubectl create secret docker-registry` creates the right type. Don't try to handcraft the dockerconfigjson Secret unless you know the format.
- Patching every pod with `imagePullSecrets` instead of patching the ServiceAccount once. Tedious and error-prone.
