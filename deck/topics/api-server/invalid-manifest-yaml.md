## Scenario Shape

Example scenario:

**API Server Crash: Invalid Apiserver Manifest YAML**

This usually means someone edited the static pod manifest and introduced bad YAML or broken container config. Because kubelet consumes that file directly, a bad edit can take the API server down immediately.

## Why this is tricky for first-timers

Beginners often try:

- repeated `kubectl get` commands
- checking the wrong namespace
- assuming etcd is the first problem

But the stronger path is node-local debugging.

## What to do first

1. SSH onto the control plane node
2. Inspect the manifest:

```bash
sudo cat /etc/kubernetes/manifests/kube-apiserver.yaml
```

3. Check runtime state:

```bash
crictl ps -a | grep kube-apiserver
```

4. If a container exists, inspect logs:

```bash
crictl logs <container-id>
```

5. If no clean container exists, inspect kubelet logs:

```bash
journalctl -u kubelet --no-pager | tail -n 100
```

## What errors commonly show up

- bad indentation
- missing `-` in arrays
- malformed `volumeMounts`
- broken `command` or `args`
- quoting mistakes around flags

## Recovery pattern

1. Fix the YAML in `/etc/kubernetes/manifests/kube-apiserver.yaml`
2. Save the file
3. Let kubelet reconcile automatically
4. Watch for the API server container to come back
5. Re-run a simple `kubectl get nodes`

You usually do **not** need to restart kubelet manually unless the environment specifically requires it.

## Minimal validation checklist

- manifest is syntactically valid YAML
- kube-apiserver container appears in `crictl ps`
- API is reachable again
- `kubectl get nodes` succeeds

## Pitfalls

- fixing the wrong file
- forgetting `sudo`
- using `kubectl logs` when the API is unavailable
- assuming static pods behave like Deployments

## Key understanding

This is not just "a YAML problem". It is a **control-plane availability problem caused by a local static pod manifest**. Once that clicks, your tool choice improves immediately.
