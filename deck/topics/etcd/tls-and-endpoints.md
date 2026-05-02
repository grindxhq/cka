## Why TLS matters here

etcd **always** runs over mTLS on kubeadm clusters. Every client connection presents a cert signed by the etcd CA, and the server presents a cert the client verifies against that same CA. If any one of those pieces is wrong, `etcdctl` refuses to talk, and the error messages are not always friendly.

Understanding the cert map makes diagnosing those errors a two-minute job instead of a twenty-minute one.

## The file layout (memorize this)

```
/etc/kubernetes/pki/
├── etcd/
│   ├── ca.crt              # etcd CA (separate from the main k8s CA)
│   ├── ca.key
│   ├── server.crt          # served by etcd on :2379 + :2380
│   ├── server.key
│   ├── peer.crt            # used between etcd members on :2380
│   ├── peer.key
│   ├── healthcheck-client.crt
│   └── healthcheck-client.key
├── apiserver-etcd-client.crt   # kube-apiserver → etcd client cert
└── apiserver-etcd-client.key
```

Two CAs exist in a kubeadm cluster: the main Kubernetes CA (`/etc/kubernetes/pki/ca.crt`) and the **etcd CA** (`/etc/kubernetes/pki/etcd/ca.crt`). They are not interchangeable. Using the wrong CA is the #1 cause of `tls: failed to verify certificate` when people start debugging etcd.

## What each port is for

| Port  | Who uses it              | Cert presented / expected             |
|-------|--------------------------|----------------------------------------|
| 2379  | clients (apiserver, etcdctl) → etcd | server cert, signed by etcd CA |
| 2380  | etcd members → each other | peer cert, signed by etcd CA          |

You rarely talk to `:2380` yourself. If you hit it by accident, you will get handshake errors.

## The etcdctl flag map

```bash
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt      \
  --cert=/etc/kubernetes/pki/etcd/server.crt    \
  --key=/etc/kubernetes/pki/etcd/server.key     \
  <cmd>
```

On a single-node kubeadm control plane you can also use `apiserver-etcd-client.{crt,key}` for the client auth — both work, both are signed by the etcd CA.

## How to read common errors

| Error (paraphrased)                                  | Cause                                                | Fix                                                                 |
|------------------------------------------------------|------------------------------------------------------|---------------------------------------------------------------------|
| `tls: failed to verify certificate`                  | Wrong `--cacert` (often used main k8s CA)            | Use `/etc/kubernetes/pki/etcd/ca.crt`                               |
| `context deadline exceeded`                          | etcd not listening, or wrong endpoint                | Check `crictl ps`, check port `ss -tlnp \| grep 2379`               |
| `rpc error: code = Unavailable`                      | TLS accepted, but etcd is not serving (e.g. no quorum)| Check member list, check logs                                        |
| `bad certificate`                                    | Using peer cert as client, or vice versa             | Use `server.crt` (or `apiserver-etcd-client.crt`) as client         |
| `connection refused`                                 | etcd container not running                           | `crictl ps -a \| grep etcd`, then `crictl logs`                      |
| `remote error: tls: certificate expired`             | Certs rotated past expiry                            | `kubeadm certs check-expiration`; `kubeadm certs renew ...`         |
| `etcdserver: mvcc: database space exceeded`          | DB quota hit                                         | `compact` + `defrag`; see health-and-members                         |

## Inspecting certs on the node

Quick expiry check across the whole control plane:

```bash
sudo kubeadm certs check-expiration
```

Individual cert (handy when a single path is suspected):

```bash
openssl x509 -in /etc/kubernetes/pki/etcd/server.crt -noout \
  -subject -issuer -dates -ext subjectAltName
```

What to look for:

- `Issuer` matches `/etc/kubernetes/pki/etcd/ca.crt` subject (both say "etcd-ca").
- `Not After` is in the future.
- `Subject Alternative Name` contains `127.0.0.1`, the node IP, and any advertised hostname. If SANs are missing, clients connecting by IP will fail.

## Discovering the real endpoint

If `127.0.0.1:2379` is refused, you may be on a worker node, or etcd may be bound to the node IP only.

```bash
# From inside the manifest
grep -E 'listen-client-urls|advertise-client-urls' /etc/kubernetes/manifests/etcd.yaml

# Or from the running process
ss -tlnp | grep 2379
```

The advertised URL is what you pass to `--endpoints`. On stacked kubeadm this is usually `https://<node-ip>:2379` for peers and `https://127.0.0.1:2379` for local clients.

## Renewing etcd certs

If certs are expired on a kubeadm cluster:

```bash
sudo kubeadm certs renew etcd-server
sudo kubeadm certs renew etcd-peer
sudo kubeadm certs renew etcd-healthcheck-client
sudo kubeadm certs renew apiserver-etcd-client
```

Then restart the etcd and apiserver static pods by moving manifests out and back:

```bash
sudo mv /etc/kubernetes/manifests/{etcd,kube-apiserver}.yaml /tmp/
sleep 10
sudo mv /tmp/{etcd,kube-apiserver}.yaml /etc/kubernetes/manifests/
```

kubelet reloads the manifests and picks up the new certs. Verify with `kubeadm certs check-expiration`.

## Exam heuristics

- If the prompt says "use etcdctl" and does not give you the flags, assume kubeadm layout and type the four flags from memory.
- Alias the flags early to save typing. Re-typing them on each invocation eats exam time.
- If `127.0.0.1:2379` fails and nothing else is broken, check whether you are on the **control plane** node, not a worker.

## Mental traps

- Mixing the two CAs: `/etc/kubernetes/pki/ca.crt` is **not** the etcd CA.
- Passing `--cert` without `--key` (or vice versa): mTLS needs both.
- Forgetting `ETCDCTL_API=3`. v2 API errors disguise themselves as TLS errors.
- Assuming `kubectl` can diagnose etcd. If etcd is down, kubectl will hang or return 500s. Go straight to node-local tools.
