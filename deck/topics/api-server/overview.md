## What kube-apiserver actually is

The **API server** is the front door of the control plane. Almost every Kubernetes tool you use talks to it:

- `kubectl`
- controllers
- schedulers
- kubelets
- admission plugins

If the API server is unhealthy, the cluster often feels "dead" even when nodes and containers still exist underneath.

## What you usually notice first

- `kubectl get ...` hangs, times out, or returns connection errors
- control plane components start reporting connection failures
- kubelet still runs on the node, but the cluster appears unresponsive
- `/etc/kubernetes/manifests/kube-apiserver.yaml` changes can immediately affect the running static pod

## Why this matters in practice

In troubleshooting scenarios, the visible symptom is often **not** "API server crashed" directly. You infer it from:

- inability to query cluster state
- a broken static pod manifest
- failed mirror pod recreation
- container restart loops on the control plane node

## Static pod relationship

On kubeadm-style clusters, the API server usually runs as a **static pod**. That means:

- its manifest lives on disk
- kubelet watches that manifest path
- editing the file changes the running workload
- invalid YAML or invalid container config can stop the API server cold

The key path to remember:

```bash
/etc/kubernetes/manifests/kube-apiserver.yaml
```

## First-time learner heuristic

If you are new and a scenario says "API server is down", think:

1. This is probably a control plane node issue
2. Static pod manifests are a prime suspect
3. `kubectl` may not help much because the API itself is unavailable
4. Node-local tools become more important than cluster API tools

## Tools that matter here

- `crictl ps -a`
- `crictl logs <container-id>`
- `sudo cat /etc/kubernetes/manifests/kube-apiserver.yaml`
- `journalctl -u kubelet`

That shift matters: when the API is down, **stop expecting the API to help you diagnose itself**.
