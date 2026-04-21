package cluster

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/grindxhq/cka/internal/question"
)

const nodeReadyTimeout = 120 // seconds to wait for nodes to become Ready

const bastionContainerName = "cka-bastion"
const bastionImage = "debian:bookworm-slim"

// Manager handles Kind cluster lifecycle for one or more clusters.
type Manager struct {
	mu            sync.RWMutex
	clusters      map[string]*ClusterInfo // name → info
	mergedConfig  string                  // merged kubeconfig path
	homeDir       string
	bastionReady  bool
}

// ClusterInfo tracks state for a single Kind cluster.
type ClusterInfo struct {
	Name         string
	ControlPlane int
	Workers      int
	Kubeconfig   string // individual kubeconfig path
}

// NewManager creates a new cluster manager.
func NewManager() *Manager {
	ensurePATH() // Expand PATH for macOS GUI apps (Dock/Finder launch)
	home, _ := os.UserHomeDir()
	return &Manager{
		clusters: make(map[string]*ClusterInfo),
		homeDir:  home,
	}
}

// Kubeconfig returns the path to the merged kubeconfig (used by validator and terminal).
func (m *Manager) Kubeconfig() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.mergedConfig != "" {
		return m.mergedConfig
	}
	// Fallback to legacy single-cluster path
	return filepath.Join(m.homeDir, ".kube", "cka-mock-config")
}

// ContainerName returns the container name where the terminal shell runs.
// If the bastion is ready, returns the bastion. Otherwise falls back to
// the primary control-plane container.
func (m *Manager) ContainerName() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.bastionReady {
		return bastionContainerName
	}
	for _, ci := range m.clusters {
		return ci.Name + "-control-plane"
	}
	return "cka-mock-control-plane"
}

// ContainerNames returns all control-plane container names.
func (m *Manager) ContainerNames() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var names []string
	for _, ci := range m.clusters {
		names = append(names, ci.Name+"-control-plane")
	}
	if len(names) == 0 {
		names = append(names, "cka-mock-control-plane")
	}
	return names
}

// PrepareContainer installs useful tools and aliases inside all
// Kind node containers. Each node gets a node-style prompt so when
// users SSH into them, they see which node they're on.
func (m *Manager) PrepareContainer() error {
	m.mu.RLock()
	containers := m.ContainerNames()
	m.mu.RUnlock()

	// All Kind node containers get a CKA-style node prompt.
	// Users SSH into these from the bastion.
	nodeBashrc := `
export KUBECONFIG=/etc/kubernetes/admin.conf
alias k=kubectl
alias kgp='kubectl get pods'
alias kgs='kubectl get svc'
alias kgn='kubectl get nodes'
source <(kubectl completion bash 2>/dev/null)
complete -o default -F __start_kubectl k 2>/dev/null
NODE_NAME=$(hostname)
export PS1='\[\e[1;35m\][root@'"$NODE_NAME"']\[\e[0m\] \[\e[1;34m\]\W\[\e[0m\]# '
`

	var lastErr error
	for _, container := range containers {
		cmd := exec.Command("docker", "exec", container,
			"bash", "-c", "cat > /root/.bashrc << 'BASHRC'\n"+nodeBashrc+"BASHRC\n")
		if out, err := cmd.CombinedOutput(); err != nil {
			lastErr = fmt.Errorf("write bashrc to %s: %s: %w", container, string(out), err)
		}
	}
	return lastErr
}

// ClusterState describes the health of a Kind cluster.
type ClusterState int

const (
	ClusterNotFound  ClusterState = iota // No cluster exists
	ClusterHealthy                       // Cluster exists and all nodes are Ready
	ClusterUnhealthy                     // Cluster exists but nodes are NotReady / unreachable
)

// HealthCheck returns the detailed cluster state for the first/default cluster.
func (m *Manager) HealthCheck() (ClusterState, []string, error) {
	m.mu.RLock()
	name := ""
	kc := ""
	for _, ci := range m.clusters {
		name = ci.Name
		kc = ci.Kubeconfig
		break
	}
	m.mu.RUnlock()

	if name == "" {
		name = "cka-mock"
		kc = filepath.Join(m.homeDir, ".kube", "cka-mock-config")
	}
	return m.healthCheckCluster(name, kc)
}

// HealthCheckNamed checks a specific cluster by name.
func (m *Manager) HealthCheckNamed(name string) (ClusterState, []string, error) {
	m.mu.RLock()
	ci, ok := m.clusters[name]
	m.mu.RUnlock()

	kc := ""
	if ok {
		kc = ci.Kubeconfig
	} else {
		kc = filepath.Join(m.homeDir, ".kube", name+"-config")
	}
	return m.healthCheckCluster(name, kc)
}

func (m *Manager) healthCheckCluster(name, kubeconfig string) (ClusterState, []string, error) {
	// Step 1: Does the Kind cluster exist at all?
	out, err := exec.Command("kind", "get", "clusters").CombinedOutput()
	if err != nil {
		return ClusterNotFound, nil, fmt.Errorf("kind get clusters: %w", err)
	}
	found := false
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.TrimSpace(line) == name {
			found = true
			break
		}
	}
	if !found {
		return ClusterNotFound, nil, nil
	}

	// Step 2: Can we reach the API server and are nodes Ready?
	nodeOut, err := exec.Command("kubectl", "--kubeconfig", kubeconfig,
		"get", "nodes",
		"--request-timeout=5s",
		"-o", "custom-columns=NAME:.metadata.name,STATUS:.status.conditions[-1].type,READY:.status.conditions[-1].status",
		"--no-headers",
	).CombinedOutput()

	if err != nil {
		return ClusterUnhealthy, nil, nil
	}

	var nodeNames []string
	allReady := true
	for _, line := range strings.Split(strings.TrimSpace(string(nodeOut)), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		nodeNames = append(nodeNames, fields[0])
		if fields[2] != "True" {
			allReady = false
		}
	}

	if len(nodeNames) == 0 || !allReady {
		return ClusterUnhealthy, nodeNames, nil
	}

	return ClusterHealthy, nodeNames, nil
}

// Status checks if any cluster is running and healthy.
func (m *Manager) Status() (running bool, nodes []string, err error) {
	state, nodes, err := m.HealthCheck()
	return state == ClusterHealthy, nodes, err
}

// SetupClusters creates all clusters defined in the exam config.
// Clusters that need creation are spun up in parallel for speed.
// progressFn is called with (clusterName, message) for UI updates.
func (m *Manager) SetupClusters(configs []question.ClusterConfig, progressFn func(string, string)) error {
	m.mu.Lock()
	m.clusters = make(map[string]*ClusterInfo)
	m.mu.Unlock()

	if progressFn != nil {
		progressFn("", fmt.Sprintf("Checking %d cluster(s)...", len(configs)))
	}

	// Phase 1: Check health of all clusters and classify them.
	type clusterWork struct {
		cfg   question.ClusterConfig
		ci    *ClusterInfo
		state ClusterState
	}
	work := make([]clusterWork, len(configs))

	for i, cfg := range configs {
		cp := cfg.ControlPlane
		if cp == 0 {
			cp = 1
		}
		kc := filepath.Join(m.homeDir, ".kube", cfg.Name+"-config")
		ci := &ClusterInfo{
			Name:         cfg.Name,
			ControlPlane: cp,
			Workers:      cfg.Workers,
			Kubeconfig:   kc,
		}
		state, _, _ := m.healthCheckCluster(cfg.Name, kc)
		work[i] = clusterWork{cfg: cfg, ci: ci, state: state}
	}

	// Phase 2: Reset healthy clusters in parallel.
	var healthyWork []clusterWork
	for _, w := range work {
		if w.state == ClusterHealthy {
			healthyWork = append(healthyWork, w)
		}
	}
	if len(healthyWork) > 0 {
		var wg sync.WaitGroup
		for _, w := range healthyWork {
			wg.Add(1)
			go func(w clusterWork) {
				defer wg.Done()
				if progressFn != nil {
					progressFn(w.ci.Name, fmt.Sprintf("Cluster %q healthy — resetting...", w.ci.Name))
				}
				if err := m.resetCluster(w.ci.Name, w.ci.Kubeconfig); err != nil {
					log.Printf("warning: reset %s had issues: %v", w.ci.Name, err)
				}
				m.mu.Lock()
				m.clusters[w.ci.Name] = w.ci
				m.mu.Unlock()
			}(w)
		}
		wg.Wait()
	}

	// Phase 3: Delete unhealthy clusters (best-effort, parallel).
	for _, w := range work {
		if w.state == ClusterUnhealthy {
			if progressFn != nil {
				progressFn(w.ci.Name, fmt.Sprintf("Deleting unhealthy cluster %q...", w.ci.Name))
			}
			m.deleteCluster(w.ci.Name)
		}
	}

	// Phase 4: Create all clusters that need creation — in parallel.
	var needsCreate []clusterWork
	for _, w := range work {
		if w.state == ClusterNotFound || w.state == ClusterUnhealthy {
			needsCreate = append(needsCreate, w)
		}
	}

	if len(needsCreate) > 0 {
		if progressFn != nil {
			progressFn("", fmt.Sprintf("Creating %d cluster(s) in parallel...", len(needsCreate)))
		}

		type result struct {
			name string
			ci   *ClusterInfo
			err  error
		}
		results := make(chan result, len(needsCreate))

		for _, w := range needsCreate {
			go func(w clusterWork) {
				if progressFn != nil {
					progressFn(w.ci.Name, fmt.Sprintf("Creating cluster %q (%d CP + %d workers)...",
						w.ci.Name, w.ci.ControlPlane, w.ci.Workers))
				}
				err := m.createCluster(w.ci.Name, w.ci.ControlPlane, w.ci.Workers, w.ci.Kubeconfig, progressFn)
				results <- result{name: w.ci.Name, ci: w.ci, err: err}
			}(w)
		}

		// Collect results
		var errs []string
		for i := 0; i < len(needsCreate); i++ {
			r := <-results
			if r.err != nil {
				errs = append(errs, fmt.Sprintf("%s: %v", r.name, r.err))
			} else {
				m.mu.Lock()
				m.clusters[r.name] = r.ci
				m.mu.Unlock()
				if progressFn != nil {
					progressFn(r.name, fmt.Sprintf("Cluster %q ready", r.name))
				}
			}
		}

		if len(errs) > 0 {
			return fmt.Errorf("failed to create cluster(s): %s", strings.Join(errs, "; "))
		}
	}

	// Phase 5: Merge all kubeconfigs into a single file (for host-side use).
	if err := m.mergeKubeconfigs(); err != nil {
		return fmt.Errorf("merge kubeconfigs: %w", err)
	}

	// Phase 6: Set up bastion container with SSH access to all nodes.
	// The bastion provides a CKA-realistic experience — users start on a
	// jump host and SSH into cluster nodes for node-level tasks.
	if progressFn != nil {
		progressFn("", "Setting up bastion environment...")
	}
	if err := m.setupBastion(configs, progressFn); err != nil {
		log.Printf("warning: bastion setup failed, falling back to direct container: %v", err)
		// Fallback: prepare in-container kubeconfig for direct access
		if err := m.prepareContainerKubeconfig(); err != nil {
			log.Printf("warning: in-container kubeconfig: %v", err)
		}
	}

	if progressFn != nil {
		progressFn("", fmt.Sprintf("All %d cluster(s) ready", len(configs)))
	}
	return nil
}

func (m *Manager) createCluster(name string, controlPlane, workers int, kubeconfig string, progressFn func(string, string)) error {
	config := m.generateKindConfig(controlPlane, workers)

	tmpFile, err := os.CreateTemp("", "kind-config-*.yaml")
	if err != nil {
		return fmt.Errorf("create temp config: %w", err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.WriteString(config); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	tmpFile.Close()

	if progressFn != nil {
		progressFn(name, fmt.Sprintf("Creating cluster %q (pulling images, starting containers)...", name))
	}

	start := time.Now()
	cmd := exec.Command("kind", "create", "cluster",
		"--name", name,
		"--config", tmpFile.Name(),
	)
	out, err := cmd.CombinedOutput()
	elapsed := time.Since(start).Round(time.Second)
	if err != nil {
		log.Printf("kind create %s failed after %s: %s", name, elapsed, string(out))
		return fmt.Errorf("kind create cluster: %w", err)
	}
	log.Printf("kind create %s completed in %s", name, elapsed)

	if progressFn != nil {
		progressFn(name, fmt.Sprintf("Cluster %q created in %s, exporting kubeconfig...", name, elapsed))
	}

	if err := m.exportKubeconfig(name, kubeconfig); err != nil {
		return err
	}

	// Wait for nodes to become ready
	if progressFn != nil {
		progressFn(name, fmt.Sprintf("Waiting for cluster %q nodes to be ready...", name))
	}
	return m.waitForReady(name, kubeconfig)
}

func (m *Manager) generateKindConfig(controlPlane, workers int) string {
	var sb strings.Builder
	sb.WriteString("kind: Cluster\napiVersion: kind.x-k8s.io/v1alpha4\nnodes:\n")

	for i := 0; i < controlPlane; i++ {
		sb.WriteString("  - role: control-plane\n")
		if i == 0 {
			// First control plane gets port mappings
			sb.WriteString("    extraPortMappings:\n")
			sb.WriteString("    - containerPort: 30000\n      hostPort: 0\n      protocol: TCP\n")
		}
	}
	for i := 0; i < workers; i++ {
		sb.WriteString("  - role: worker\n")
	}
	return sb.String()
}

func (m *Manager) exportKubeconfig(name, kubeconfig string) error {
	out, err := exec.Command("kind", "get", "kubeconfig", "--name", name).Output()
	if err != nil {
		return fmt.Errorf("kind get kubeconfig: %w", err)
	}
	dir := filepath.Dir(kubeconfig)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("mkdir kubeconfig dir: %w", err)
	}
	if err := os.WriteFile(kubeconfig, out, 0600); err != nil {
		return fmt.Errorf("write kubeconfig: %w", err)
	}
	return nil
}

func (m *Manager) waitForReady(name, kubeconfig string) error {
	start := time.Now()
	deadline := start.Add(time.Duration(nodeReadyTimeout) * time.Second)
	for time.Now().Before(deadline) {
		state, nodes, _ := m.healthCheckCluster(name, kubeconfig)
		if state == ClusterHealthy {
			log.Printf("Cluster %q nodes ready in %s", name, time.Since(start).Round(time.Second))
			return nil
		}
		elapsed := time.Since(start).Round(time.Second)
		log.Printf("Waiting for cluster %q nodes (%d found, not all ready yet, %s elapsed)...", name, len(nodes), elapsed)
		time.Sleep(3 * time.Second)
	}
	return fmt.Errorf("cluster %q nodes did not become Ready within %ds", name, nodeReadyTimeout)
}

func (m *Manager) deleteCluster(name string) error {
	cmd := exec.Command("kind", "delete", "cluster", "--name", name)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func (m *Manager) resetCluster(name, kubeconfig string) error {
	kc := kubeconfig

	// 1. Delete all non-system namespaces
	out, err := exec.Command("kubectl", "--kubeconfig", kc,
		"get", "namespaces",
		"-o", "jsonpath={.items[*].metadata.name}",
	).Output()
	if err != nil {
		return fmt.Errorf("list namespaces: %w", err)
	}
	systemNS := map[string]bool{
		"default": true, "kube-system": true,
		"kube-public": true, "kube-node-lease": true,
		"local-path-storage": true,
	}
	for _, ns := range strings.Fields(string(out)) {
		if systemNS[ns] {
			continue
		}
		exec.Command("kubectl", "--kubeconfig", kc, "delete", "namespace", ns, "--wait=false").Run()
	}

	// 2. Bulk-delete all user resources in default namespace
	exec.Command("kubectl", "--kubeconfig", kc,
		"delete", "all", "--all", "-n", "default",
	).Run()

	// 3. Delete remaining non-"all" resources in default namespace
	for _, resource := range []string{
		"configmaps", "secrets", "persistentvolumeclaims",
		"ingresses", "networkpolicies", "roles", "rolebindings",
	} {
		exec.Command("kubectl", "--kubeconfig", kc,
			"delete", resource, "--all", "-n", "default",
		).Run()
	}

	// 4. Clean up cluster-scoped user resources
	for _, resource := range []string{"clusterroles", "clusterrolebindings"} {
		out, _ := exec.Command("kubectl", "--kubeconfig", kc,
			"get", resource,
			"-o", "jsonpath={.items[?(@.metadata.annotations.kubectl\\.kubernetes\\.io/last-applied-configuration)].metadata.name}",
		).Output()
		for _, rName := range strings.Fields(string(out)) {
			exec.Command("kubectl", "--kubeconfig", kc,
				"delete", resource, rName,
			).Run()
		}
	}

	// 5. Clean up PersistentVolumes
	exec.Command("kubectl", "--kubeconfig", kc,
		"delete", "persistentvolumes", "--all",
	).Run()

	// 6. Remove taints and labels from nodes (batched per node)
	nodesOut, _ := exec.Command("kubectl", "--kubeconfig", kc,
		"get", "nodes", "-o", "jsonpath={.items[*].metadata.name}",
	).Output()
	for _, node := range strings.Fields(string(nodesOut)) {
		exec.Command("kubectl", "--kubeconfig", kc,
			"taint", "node", node, "dedicated-", "--ignore-not-found",
		).Run()
		// Remove all custom labels in one command
		labelArgs := []string{"--kubeconfig", kc, "label", "node", node}
		for _, label := range []string{"disktype", "gpu", "env", "tier", "team", "color", "size", "workload", "zone"} {
			labelArgs = append(labelArgs, label+"-")
		}
		exec.Command("kubectl", labelArgs...).Run()
	}

	// 7. Clean up in-container artifacts from previous exam attempts.
	// Validations check files inside Kind nodes (etcd backups, health checks, etc.)
	// that persist across exam restarts. Without this, restarting an exam
	// would give credit for questions solved in the previous attempt.
	containers, _ := exec.Command("docker", "ps",
		"--filter", "name="+name,
		"--format", "{{.Names}}",
	).Output()
	for _, container := range strings.Fields(string(containers)) {
		exec.Command("docker", "exec", container, "sh", "-c",
			"rm -rf /backup/* /var/lib/etcd-restored /tmp/etcd-*.txt /tmp/apiserver-info.txt /tmp/cert-expiry.txt /tmp/kubelet-dns.txt /tmp/kubelet-domain.txt /tmp/cluster-config.yaml /etc/kubernetes/audit-policy.yaml",
		).Run()
	}

	return nil
}

// mergeKubeconfigs combines all cluster kubeconfigs into one file.
func (m *Manager) mergeKubeconfigs() error {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if len(m.clusters) == 0 {
		return nil
	}

	// If only one cluster, use its kubeconfig directly
	if len(m.clusters) == 1 {
		for _, ci := range m.clusters {
			m.mergedConfig = ci.Kubeconfig
			return nil
		}
	}

	// Merge multiple kubeconfigs using KUBECONFIG env var
	var paths []string
	for _, ci := range m.clusters {
		paths = append(paths, ci.Kubeconfig)
	}

	mergedPath := filepath.Join(m.homeDir, ".kube", "cka-mock-merged-config")
	cmd := exec.Command("kubectl", "config", "view", "--merge", "--flatten")
	cmd.Env = append(os.Environ(), "KUBECONFIG="+strings.Join(paths, ":"))
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("merge kubeconfigs: %w", err)
	}

	if err := os.WriteFile(mergedPath, out, 0600); err != nil {
		return fmt.Errorf("write merged kubeconfig: %w", err)
	}

	m.mergedConfig = mergedPath
	return nil
}

// prepareContainerKubeconfig creates a kubeconfig that works from inside
// a Docker container by rewriting the server URLs from 127.0.0.1:<host-port>
// to <docker-network-ip>:6443. It then copies this kubeconfig into the
// primary control-plane container so kubectl can reach all clusters.
func (m *Manager) prepareContainerKubeconfig() error {
	m.mu.RLock()
	clusters := make(map[string]*ClusterInfo)
	var primaryContainer string
	for k, v := range m.clusters {
		clusters[k] = v
		if primaryContainer == "" {
			primaryContainer = v.Name + "-control-plane"
		}
	}
	mergedPath := m.mergedConfig
	m.mu.RUnlock()

	if mergedPath == "" || primaryContainer == "" {
		return nil
	}

	// Read the merged kubeconfig (host version).
	data, err := os.ReadFile(mergedPath)
	if err != nil {
		return fmt.Errorf("read merged kubeconfig: %w", err)
	}
	content := string(data)

	// For each cluster, get the Docker network IP of its control-plane
	// and replace the host-side server URL with the in-network URL.
	for _, ci := range clusters {
		containerName := ci.Name + "-control-plane"

		// Get Docker network IP.
		ipCmd := exec.Command("docker", "inspect", "-f",
			"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", containerName)
		ipOut, err := ipCmd.Output()
		if err != nil {
			log.Printf("warning: cannot get IP for %s: %v", containerName, err)
			continue
		}
		dockerIP := strings.TrimSpace(string(ipOut))
		if dockerIP == "" {
			log.Printf("warning: empty Docker IP for %s", containerName)
			continue
		}

		// Read the individual kubeconfig to find the host-side server URL.
		// It will be something like https://127.0.0.1:43567
		kcData, err := os.ReadFile(ci.Kubeconfig)
		if err != nil {
			log.Printf("warning: cannot read kubeconfig for %s: %v", ci.Name, err)
			continue
		}

		// Extract the server line: "    server: https://127.0.0.1:XXXXX"
		for _, line := range strings.Split(string(kcData), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "server:") {
				hostURL := strings.TrimSpace(strings.TrimPrefix(trimmed, "server:"))
				containerURL := fmt.Sprintf("https://%s:6443", dockerIP)
				content = strings.Replace(content, hostURL, containerURL, 1)
				break
			}
		}
	}

	// Write the rewritten kubeconfig to a temp file.
	tmpFile := mergedPath + "-container"
	if err := os.WriteFile(tmpFile, []byte(content), 0600); err != nil {
		return fmt.Errorf("write container kubeconfig: %w", err)
	}

	// Copy into the primary container.
	mkdirCmd := exec.Command("docker", "exec", primaryContainer, "mkdir", "-p", "/root/.kube")
	mkdirCmd.CombinedOutput() // ignore error if dir exists

	cpCmd := exec.Command("docker", "cp", tmpFile, primaryContainer+":/root/.kube/config")
	if out, err := cpCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("docker cp kubeconfig: %s: %w", string(out), err)
	}

	log.Printf("In-container kubeconfig installed in %s with %d cluster(s)", primaryContainer, len(clusters))
	return nil
}

// DeleteAllClusters removes all managed clusters and the bastion.
func (m *Manager) DeleteAllClusters() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Remove bastion
	exec.Command("docker", "rm", "-f", bastionContainerName).Run()
	m.bastionReady = false

	var lastErr error
	for name := range m.clusters {
		if err := m.deleteCluster(name); err != nil {
			lastErr = err
		}
	}
	m.clusters = make(map[string]*ClusterInfo)
	return lastErr
}

// --- Legacy single-cluster API (backward compat) ---

// Create creates a single default cluster (legacy API).
func (m *Manager) Create() error {
	return m.SetupClusters([]question.ClusterConfig{
		{Name: "cka-mock", ControlPlane: 1, Workers: 2},
	}, nil)
}

// Reset resets the first cluster (legacy API).
func (m *Manager) Reset() error {
	m.mu.RLock()
	for name, ci := range m.clusters {
		m.mu.RUnlock()
		return m.resetCluster(name, ci.Kubeconfig)
	}
	m.mu.RUnlock()
	return m.resetCluster("cka-mock", filepath.Join(m.homeDir, ".kube", "cka-mock-config"))
}

// Recreate deletes and recreates the first cluster (legacy API).
func (m *Manager) Recreate() error {
	m.mu.RLock()
	for name := range m.clusters {
		m.mu.RUnlock()
		m.deleteCluster(name)
		return m.Create()
	}
	m.mu.RUnlock()
	m.deleteCluster("cka-mock")
	return m.Create()
}

// Delete tears down the first cluster (legacy API).
func (m *Manager) Delete() error {
	return m.DeleteAllClusters()
}

// WaitForReady waits for the first cluster to be ready (legacy API).
func (m *Manager) WaitForReady() error {
	m.mu.RLock()
	for name, ci := range m.clusters {
		m.mu.RUnlock()
		return m.waitForReady(name, ci.Kubeconfig)
	}
	m.mu.RUnlock()
	return m.waitForReady("cka-mock", filepath.Join(m.homeDir, ".kube", "cka-mock-config"))
}

// Prerequisites checks that docker and kind are available.
type Prerequisites struct {
	Docker     bool   `json:"docker"`
	DockerErr  string `json:"dockerErr,omitempty"`
	Kind       bool   `json:"kind"`
	KindErr    string `json:"kindErr,omitempty"`
	Kubectl    bool   `json:"kubectl"`
	KubectlErr string `json:"kubectlErr,omitempty"`
}

// ensurePATH adds common binary locations that macOS GUI apps don't inherit.
// When launched from Dock/Finder, PATH is typically just /usr/bin:/bin:/usr/sbin:/sbin,
// missing Homebrew, Go, and other user-installed tool directories.
func ensurePATH() {
	extraPaths := []string{
		"/usr/local/bin",
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		os.Getenv("HOME") + "/go/bin",
		os.Getenv("HOME") + "/.local/bin",
	}
	current := os.Getenv("PATH")
	for _, p := range extraPaths {
		if !strings.Contains(current, p) {
			current = p + ":" + current
		}
	}
	os.Setenv("PATH", current)
}

// CheckPrerequisites verifies docker, kind, and kubectl are installed.
func CheckPrerequisites() Prerequisites {
	ensurePATH()
	p := Prerequisites{}

	if _, err := exec.LookPath("docker"); err != nil {
		p.DockerErr = "docker not found in PATH"
	} else if err := exec.Command("docker", "info").Run(); err != nil {
		p.DockerErr = "docker daemon not running"
	} else {
		p.Docker = true
	}

	if _, err := exec.LookPath("kind"); err != nil {
		p.KindErr = "kind not found in PATH"
	} else {
		p.Kind = true
	}

	if _, err := exec.LookPath("kubectl"); err != nil {
		p.KubectlErr = "kubectl not found in PATH"
	} else {
		p.Kubectl = true
	}

	return p
}
