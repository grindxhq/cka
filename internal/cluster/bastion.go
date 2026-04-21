package cluster

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/grindxhq/cka/internal/question"
)

// setupBastion creates a lightweight bastion container on the Kind Docker
// network, installs kubectl, configures SSH access to all cluster nodes,
// and copies the merged kubeconfig. This gives users a CKA-realistic
// experience: they start on a jump host and `ssh <node>` into cluster nodes.
func (m *Manager) setupBastion(configs []question.ClusterConfig, progressFn func(string, string)) error {
	bastionStart := time.Now()

	// Step 1: Determine the Kind Docker network name.
	// Kind clusters use a network named "kind" by default.
	kindNetwork := "kind"

	// Step 2: Stop and remove any existing bastion container.
	exec.Command("docker", "rm", "-f", bastionContainerName).Run()

	// Step 3: Create the bastion container.
	if progressFn != nil {
		progressFn("", "Creating bastion container...")
	}

	createCmd := exec.Command("docker", "run", "-d",
		"--name", bastionContainerName,
		"--network", kindNetwork,
		"--restart", "unless-stopped",
		bastionImage,
		"sleep", "infinity",
	)
	if out, err := createCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("create bastion container: %s: %w", string(out), err)
	}

	// Step 4: Install required tools in the bastion.
	if progressFn != nil {
		progressFn("", "Installing tools in bastion...")
	}

	installScript := `
set -e
apt-get update -qq
apt-get install -y -qq openssh-client curl ca-certificates bash-completion >/dev/null 2>&1

# Install kubectl
KUBE_VERSION=$(curl -sL https://dl.k8s.io/release/stable.txt)
curl -sLO "https://dl.k8s.io/release/${KUBE_VERSION}/bin/linux/$(dpkg --print-architecture)/kubectl"
chmod +x kubectl && mv kubectl /usr/local/bin/

# Enable kubectl completion
kubectl completion bash > /etc/bash_completion.d/kubectl 2>/dev/null || true

mkdir -p /root/.ssh /root/.kube
chmod 700 /root/.ssh
`
	if err := dockerExec(bastionContainerName, installScript); err != nil {
		return fmt.Errorf("install bastion tools: %w", err)
	}

	// Step 5: Generate SSH key pair in the bastion.
	if progressFn != nil {
		progressFn("", "Configuring SSH access to nodes...")
	}

	keygenScript := `ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -q`
	if err := dockerExec(bastionContainerName, keygenScript); err != nil {
		return fmt.Errorf("bastion ssh-keygen: %w", err)
	}

	// Read the public key from the bastion.
	pubKeyOut, err := exec.Command("docker", "exec", bastionContainerName,
		"cat", "/root/.ssh/id_ed25519.pub").Output()
	if err != nil {
		return fmt.Errorf("read bastion pub key: %w", err)
	}
	pubKey := strings.TrimSpace(string(pubKeyOut))

	// Step 6: Install SSH server on each Kind node in parallel.
	allNodes := m.getAllNodeContainers(configs)

	if progressFn != nil {
		progressFn("", fmt.Sprintf("Setting up SSH on %d nodes (parallel)...", len(allNodes)))
	}

	type nodeResult struct {
		node      string
		configLine string
		err       error
	}
	nodeResults := make(chan nodeResult, len(allNodes))

	for _, node := range allNodes {
		go func(node string) {
			sshSetupScript := fmt.Sprintf(`
set -e
apt-get update -qq
apt-get install -y -qq openssh-server >/dev/null 2>&1
mkdir -p /root/.ssh /run/sshd
chmod 700 /root/.ssh
echo '%s' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

# Configure sshd: allow root login, use a non-standard port to avoid conflicts
cat > /etc/ssh/sshd_config.d/cka.conf << 'SSHCONF'
PermitRootLogin yes
PasswordAuthentication no
Port 22
SSHCONF

# Start sshd
/usr/sbin/sshd 2>/dev/null || true
`, pubKey)

			if err := dockerExec(node, sshSetupScript); err != nil {
				nodeResults <- nodeResult{node: node, err: err}
				return
			}

			// Get the node's Docker network IP for SSH config.
			ipOut, err := exec.Command("docker", "inspect", "-f",
				"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", node).Output()
			if err != nil {
				nodeResults <- nodeResult{node: node, err: fmt.Errorf("get IP: %w", err)}
				return
			}
			nodeIP := strings.TrimSpace(string(ipOut))
			if nodeIP == "" {
				nodeResults <- nodeResult{node: node, err: fmt.Errorf("empty IP")}
				return
			}

			configLine := fmt.Sprintf(
				"Host %s\n  HostName %s\n  User root\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n",
				node, nodeIP,
			)
			nodeResults <- nodeResult{node: node, configLine: configLine}
		}(node)
	}

	var sshConfigLines []string
	for i := 0; i < len(allNodes); i++ {
		r := <-nodeResults
		if r.err != nil {
			log.Printf("warning: SSH setup on %s failed: %v", r.node, r.err)
			continue
		}
		sshConfigLines = append(sshConfigLines, r.configLine)
		if progressFn != nil {
			progressFn("", fmt.Sprintf("SSH ready on %s (%d/%d)", r.node, i+1, len(allNodes)))
		}
	}

	// Step 7: Write SSH config into the bastion.
	if len(sshConfigLines) > 0 {
		sshConfig := strings.Join(sshConfigLines, "\n")
		writeCmd := exec.Command("docker", "exec", "-i", bastionContainerName,
			"bash", "-c", "cat > /root/.ssh/config && chmod 600 /root/.ssh/config")
		writeCmd.Stdin = strings.NewReader(sshConfig)
		if out, err := writeCmd.CombinedOutput(); err != nil {
			log.Printf("warning: write SSH config: %s: %v", string(out), err)
		}
	}

	// Step 8: Copy merged kubeconfig into bastion (rewritten with Docker IPs).
	if progressFn != nil {
		progressFn("", "Setting up kubeconfig in bastion...")
	}
	if err := m.prepareBastionKubeconfig(); err != nil {
		return fmt.Errorf("bastion kubeconfig: %w", err)
	}

	// Step 9: Write bastion .bashrc with CKA-style prompt and aliases.
	bastionBashrc := `
export KUBECONFIG=/root/.kube/config
alias k=kubectl
alias kgp='kubectl get pods'
alias kgs='kubectl get svc'
alias kgd='kubectl get deploy'
alias kgn='kubectl get nodes'
alias kns='kubectl config set-context --current --namespace'
source <(kubectl completion bash 2>/dev/null)
complete -o default -F __start_kubectl k 2>/dev/null
export PS1='\[\e[1;36m\][student@cka-exam]\[\e[0m\] \[\e[0;33m\]$(kubectl config current-context 2>/dev/null || echo "no-ctx")\[\e[0m\]:\[\e[1;34m\]\W\[\e[0m\]\$ '
echo -e '\033[1;36m=== CKA Mock Exam Terminal ===\033[0m'
echo ''
echo 'Aliases: k=kubectl, kgp, kgs, kgd, kgn, kns=set-namespace'
echo 'Tip: Use "ssh <node-name>" to access cluster nodes for node-level tasks'
echo '     Copy the context command from each question to switch clusters'
echo ''
echo -e 'Available nodes:'
cat /root/.ssh/config 2>/dev/null | grep '^Host ' | sed 's/Host /  - /' || true
echo ''
`
	bashrcCmd := exec.Command("docker", "exec", "-i", bastionContainerName,
		"bash", "-c", "cat > /root/.bashrc")
	bashrcCmd.Stdin = strings.NewReader(bastionBashrc)
	if out, err := bashrcCmd.CombinedOutput(); err != nil {
		log.Printf("warning: write bastion bashrc: %s: %v", string(out), err)
	}

	// Step 10: Verify SSH connectivity.
	if progressFn != nil {
		progressFn("", "Verifying SSH connectivity...")
	}
	time.Sleep(1 * time.Second) // give sshd a moment to start
	for _, node := range allNodes {
		verifyCmd := exec.Command("docker", "exec", bastionContainerName,
			"ssh", "-o", "ConnectTimeout=3", node, "hostname")
		if out, err := verifyCmd.CombinedOutput(); err != nil {
			log.Printf("warning: SSH to %s failed: %s: %v", node, string(out), err)
		} else {
			log.Printf("SSH verified: bastion → %s (%s)", node, strings.TrimSpace(string(out)))
		}
	}

	m.mu.Lock()
	m.bastionReady = true
	m.mu.Unlock()

	log.Printf("Bastion container ready with SSH access to %d nodes in %s", len(allNodes), time.Since(bastionStart).Round(time.Second))
	return nil
}

// prepareBastionKubeconfig creates a kubeconfig with Docker network IPs
// and copies it into the bastion container.
func (m *Manager) prepareBastionKubeconfig() error {
	m.mu.RLock()
	mergedPath := m.mergedConfig
	clusters := make(map[string]*ClusterInfo)
	for k, v := range m.clusters {
		clusters[k] = v
	}
	m.mu.RUnlock()

	if mergedPath == "" {
		return fmt.Errorf("no merged kubeconfig available")
	}

	data, err := os.ReadFile(mergedPath)
	if err != nil {
		return fmt.Errorf("read merged kubeconfig: %w", err)
	}
	content := string(data)

	// Rewrite server URLs from localhost to Docker network IPs.
	for _, ci := range clusters {
		containerName := ci.Name + "-control-plane"
		ipOut, err := exec.Command("docker", "inspect", "-f",
			"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", containerName).Output()
		if err != nil {
			continue
		}
		dockerIP := strings.TrimSpace(string(ipOut))
		if dockerIP == "" {
			continue
		}

		// Find the host-side server URL from the individual kubeconfig.
		kcData, err := os.ReadFile(ci.Kubeconfig)
		if err != nil {
			continue
		}
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

	// Write to temp file and docker cp into bastion.
	tmpFile := mergedPath + "-bastion"
	if err := os.WriteFile(tmpFile, []byte(content), 0600); err != nil {
		return fmt.Errorf("write bastion kubeconfig: %w", err)
	}

	exec.Command("docker", "exec", bastionContainerName, "mkdir", "-p", "/root/.kube").Run()
	cpCmd := exec.Command("docker", "cp", tmpFile, bastionContainerName+":/root/.kube/config")
	if out, err := cpCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("docker cp kubeconfig to bastion: %s: %w", string(out), err)
	}

	return nil
}

// getAllNodeContainers returns all Docker container names for all cluster nodes.
func (m *Manager) getAllNodeContainers(configs []question.ClusterConfig) []string {
	var nodes []string
	for _, cfg := range configs {
		cp := cfg.ControlPlane
		if cp == 0 {
			cp = 1
		}
		// Control plane nodes
		if cp == 1 {
			nodes = append(nodes, cfg.Name+"-control-plane")
		} else {
			for i := 1; i <= cp; i++ {
				nodes = append(nodes, fmt.Sprintf("%s-control-plane%d", cfg.Name, i))
			}
		}
		// Worker nodes
		for i := 1; i <= cfg.Workers; i++ {
			nodes = append(nodes, fmt.Sprintf("%s-worker%s", cfg.Name, workerSuffix(i, cfg.Workers)))
		}
	}
	return nodes
}

// workerSuffix returns "" for single-worker clusters, or "N" for multi-worker.
func workerSuffix(index, total int) string {
	if total == 1 {
		return ""
	}
	return fmt.Sprintf("%d", index)
}

// dockerExec runs a bash script inside a container.
func dockerExec(container, script string) error {
	cmd := exec.Command("docker", "exec", "-i", container, "bash", "-c", script)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s: %w\noutput: %s", container, err, string(out))
	}
	return nil
}
