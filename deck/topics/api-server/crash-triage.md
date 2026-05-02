## Fastest Triage Order

When the API server is suspected to be down, use this order:

1. Confirm the cluster API is actually unhealthy
2. Move to the control plane node
3. Inspect the static pod manifest
4. Check container runtime state with `crictl`
5. Read kubelet logs if the container is not even getting created cleanly

## Step 1: Verify the symptom

Typical signs:

```bash
kubectl get nodes
kubectl get pods -A
```

If these fail with connection or timeout errors, stop assuming this is an RBAC or namespace problem.

## Step 2: Inspect the static pod manifest

The kubelet watches:

```bash
/etc/kubernetes/manifests/kube-apiserver.yaml
```

Check for:

- invalid YAML indentation
- broken flags
- wrong file mounts
- malformed command arrays
- accidental deletions

## Step 3: Use `crictl`, not `kubectl`

If the API server itself is broken, `kubectl` cannot reliably tell you what happened.

Use:

```bash
crictl ps -a | grep kube-apiserver
crictl logs <container-id>
```

This is usually the first command family that gives you the real error.

## Step 4: Fall back to kubelet logs

If the container never starts correctly, kubelet often tells you why:

```bash
journalctl -u kubelet --no-pager | tail -n 100
```

Good for:

- YAML parsing failures
- manifest load issues
- mount path problems
- image launch failures

## Practical heuristics

- If the manifest changed recently, suspect that first
- If the container is restarting, inspect `crictl logs`
- If no container is created, inspect kubelet logs and manifest syntax
- If one control plane component is down and others complain about API connectivity, the API server is still the likely root cause

## Common commands to memorize

```bash
sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml
crictl ps -a
crictl logs <container-id>
journalctl -u kubelet --no-pager
```

## Exam mindset

Do not over-debug. The goal is usually to restore service fast:

- identify the broken field
- fix the manifest
- wait for kubelet to reconcile the static pod
- verify the API comes back
