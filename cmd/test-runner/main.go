// test-runner validates that every question's solution actually passes its validation checks.
//
// Usage:
//
//	go run cmd/test-runner/main.go --session session-1
//	go run cmd/test-runner/main.go --session session-1 --question s1-01-namespace-resource-quotas
//	go run cmd/test-runner/main.go --session all
//	go run cmd/test-runner/main.go --session session-1 --e2e  (full lifecycle: delete → create → test → delete)
//
// By default, clusters must already be running. Use --e2e for full lifecycle management.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// ── Types (minimal, matching question YAML) ──

type Exam struct {
	ID       string          `yaml:"id"`
	Name     string          `yaml:"name"`
	Clusters []ClusterConfig `yaml:"clusters"`
}

type ClusterConfig struct {
	Name         string `yaml:"name"`
	Workers      int    `yaml:"workers"`
	ControlPlane int    `yaml:"controlPlane"`
}

type Question struct {
	ID         string           `yaml:"id"`
	Title      string           `yaml:"title"`
	Category   string           `yaml:"category"`
	Difficulty string           `yaml:"difficulty"`
	Weight     int              `yaml:"weight"`
	Context    string           `yaml:"context"`
	Setup      []string         `yaml:"setup,omitempty"`
	Validation []ValidationRule `yaml:"validation"`
	Solution   string           `yaml:"solution,omitempty"`
}

type ValidationRule struct {
	Description string `yaml:"description"`
	Command     string `yaml:"command"`
	Expect      string `yaml:"expect"`
	Match       string `yaml:"match"`
}

// ── Result tracking ──

type QuestionResult struct {
	ID         string
	Title      string
	Passed     bool
	SetupErr   string
	SolutionErr string
	Checks     []CheckResult
}

type CheckResult struct {
	Description string
	Passed      bool
	Expected    string
	Actual      string
}

// ── Colors ──

const (
	colorReset  = "\033[0m"
	colorRed    = "\033[31m"
	colorGreen  = "\033[32m"
	colorYellow = "\033[33m"
	colorCyan   = "\033[36m"
	colorBold   = "\033[1m"
	colorDim    = "\033[2m"
)

func main() {
	session := flag.String("session", "", "Session to test (e.g., session-1, session-3, or 'all')")
	questionFilter := flag.String("question", "", "Test only this question ID (optional)")
	questionsDir := flag.String("dir", "questions/exams", "Path to questions/exams directory")
	kubeconfig := flag.String("kubeconfig", "", "Kubeconfig path (default: auto-detect)")
	dryRun := flag.Bool("dry-run", false, "Parse and show what would be tested without executing")
	e2e := flag.Bool("e2e", false, "Full lifecycle: delete clusters → create → test → delete")
	keepClusters := flag.Bool("keep", false, "With --e2e, keep clusters after tests (skip final delete)")
	timeout := flag.Int("timeout", 30, "Timeout per command in seconds")
	flag.Parse()

	if *session == "" {
		fmt.Fprintf(os.Stderr, "Usage: go run cmd/test-runner/main.go --session <session-name|all>\n")
		os.Exit(1)
	}

	// Auto-detect kubeconfig
	kc := *kubeconfig
	if kc == "" {
		kc = os.Getenv("KUBECONFIG")
		if kc == "" {
			home, _ := os.UserHomeDir()
			kc = filepath.Join(home, ".kube", "config")
		}
	}

	cmdTimeout := time.Duration(*timeout) * time.Second

	// Determine sessions to test
	var sessions []string
	if *session == "all" {
		entries, err := os.ReadDir(*questionsDir)
		if err != nil {
			fatal("Cannot read %s: %v", *questionsDir, err)
		}
		for _, e := range entries {
			if e.IsDir() {
				sessions = append(sessions, e.Name())
			}
		}
	} else {
		sessions = []string{*session}
	}

	var allResults []QuestionResult
	totalPassed, totalFailed, totalSkipped := 0, 0, 0

	for _, sess := range sessions {
		sessDir := filepath.Join(*questionsDir, sess)
		exam, questions, err := loadSession(sessDir)
		if err != nil {
			fatal("Load session %s: %v", sess, err)
		}

		fmt.Printf("\n%s%s══════════════════════════════════════════════════%s\n", colorBold, colorCyan, colorReset)
		fmt.Printf("%s%s  %s — %s%s\n", colorBold, colorCyan, exam.ID, exam.Name, colorReset)
		fmt.Printf("%s%s  %d questions | %d clusters%s\n", colorDim, colorCyan, len(questions), len(exam.Clusters), colorReset)
		fmt.Printf("%s%s══════════════════════════════════════════════════%s\n\n", colorBold, colorCyan, colorReset)

		// E2E: delete existing clusters and create fresh ones
		if *e2e && !*dryRun {
			for _, c := range exam.Clusters {
				fmt.Printf("  %s🗑  Deleting cluster %s (if exists)...%s\n", colorYellow, c.Name, colorReset)
				deleteCluster(c.Name)
			}
			for _, c := range exam.Clusters {
				fmt.Printf("  %s🔨 Creating cluster %s...%s\n", colorCyan, c.Name, colorReset)
				if err := createCluster(c); err != nil {
					fatal("Failed to create cluster %s: %v", c.Name, err)
				}
				fmt.Printf("  %s✓  Cluster %s ready%s\n", colorGreen, c.Name, colorReset)
			}
			// Merge kubeconfigs
			kc = mergeKubeconfigs(exam.Clusters)
			fmt.Printf("  %s✓  Kubeconfig merged: %s%s\n\n", colorGreen, kc, colorReset)

			// Wait for nodes to be ready
			fmt.Printf("  %s⏳ Waiting for nodes to be ready...%s\n", colorDim, colorReset)
			for _, c := range exam.Clusters {
				waitForCluster(c.Name, kc)
			}
			fmt.Println()
		}

		for _, q := range questions {
			if *questionFilter != "" && q.ID != *questionFilter {
				continue
			}

			result := QuestionResult{ID: q.ID, Title: q.Title}
			fmt.Printf("%s▸ [%s] %s%s\n", colorBold, q.ID, q.Title, colorReset)
			fmt.Printf("  %sCategory: %s | Difficulty: %s | Weight: %d%s\n",
				colorDim, q.Category, q.Difficulty, q.Weight, colorReset)

			if *dryRun {
				fmt.Printf("  %s[DRY RUN] Would run %d setup commands, solution, %d validations%s\n\n",
					colorYellow, len(q.Setup), len(q.Validation), colorReset)
				totalSkipped++
				continue
			}

			// Step 0: Switch kubectl context for this question
			if q.Context != "" {
				ctxCmd := fmt.Sprintf("kubectl config use-context %s", q.Context)
				if err := runCmd(ctxCmd, kc, cmdTimeout); err != nil {
					fmt.Printf("  %s⚠ Context switch warning: %v%s\n", colorYellow, err, colorReset)
				}
			}

			// Step 1: Run setup commands
			if len(q.Setup) > 0 {
				fmt.Printf("  %s⏳ Running setup (%d commands)...%s\n", colorDim, len(q.Setup), colorReset)
				for _, cmd := range q.Setup {
					cmd = strings.TrimSpace(cmd)
					if cmd == "" || cmd == "sleep 1" || cmd == "sleep 2" {
						continue
					}
					if err := runCmd(cmd, kc, cmdTimeout); err != nil {
						result.SetupErr = fmt.Sprintf("setup failed: %v", err)
						fmt.Printf("  %s✗ Setup failed: %v%s\n", colorRed, err, colorReset)
						break
					}
				}
			}

			if result.SetupErr != "" {
				result.Passed = false
				totalFailed++
				allResults = append(allResults, result)
				fmt.Println()
				continue
			}

			// Step 2: Run solution
			fmt.Printf("  %s⏳ Running solution...%s\n", colorDim, colorReset)
			solCmds := parseSolution(q.Solution, q.Context)
			for _, sc := range solCmds {
				if err := runCmd(sc, kc, cmdTimeout); err != nil {
					// Non-fatal: some solution lines are informational (echo, cat, etc.)
					fmt.Printf("  %s⚠ Solution warning: %s → %v%s\n", colorYellow, truncate(sc, 60), err, colorReset)
				}
			}

			// Small delay for resources to settle
			time.Sleep(2 * time.Second)

			// Step 3: Run validations
			fmt.Printf("  %s⏳ Validating...%s\n", colorDim, colorReset)
			allChecksPassed := true
			for _, v := range q.Validation {
				actual, err := runCmdOutput(v.Command, kc, cmdTimeout)
				if err != nil {
					actual = "error: " + err.Error()
				}
				actual = strings.TrimSpace(actual)
				passed := matchOutput(actual, v.Expect, v.Match)

				check := CheckResult{
					Description: v.Description,
					Passed:      passed,
					Expected:    v.Expect,
					Actual:      actual,
				}
				result.Checks = append(result.Checks, check)

				if passed {
					fmt.Printf("  %s✓ %s%s\n", colorGreen, v.Description, colorReset)
				} else {
					fmt.Printf("  %s✗ %s%s\n", colorRed, v.Description, colorReset)
					fmt.Printf("    %sexpected: %q%s\n", colorDim, v.Expect, colorReset)
					fmt.Printf("    %s  actual: %q%s\n", colorDim, actual, colorReset)
					allChecksPassed = false
				}
			}

			result.Passed = allChecksPassed
			if allChecksPassed {
				fmt.Printf("  %s%s✓ PASSED%s\n\n", colorBold, colorGreen, colorReset)
				totalPassed++
			} else {
				fmt.Printf("  %s%s✗ FAILED%s\n\n", colorBold, colorRed, colorReset)
				totalFailed++
			}
			allResults = append(allResults, result)
		}

		// E2E: delete clusters after testing (unless --keep)
		if *e2e && !*dryRun && !*keepClusters {
			fmt.Printf("\n  %s🗑  Cleaning up clusters...%s\n", colorYellow, colorReset)
			for _, c := range exam.Clusters {
				deleteCluster(c.Name)
				fmt.Printf("  %s✓  Deleted %s%s\n", colorGreen, c.Name, colorReset)
			}
		}
	}

	// ── Summary ──
	fmt.Printf("\n%s%s══════════════════════════════════════════════════%s\n", colorBold, colorCyan, colorReset)
	fmt.Printf("%s%s  SUMMARY%s\n", colorBold, colorCyan, colorReset)
	fmt.Printf("%s%s══════════════════════════════════════════════════%s\n", colorBold, colorCyan, colorReset)
	fmt.Printf("  %s%sPassed: %d%s\n", colorBold, colorGreen, totalPassed, colorReset)
	fmt.Printf("  %s%sFailed: %d%s\n", colorBold, colorRed, totalFailed, colorReset)
	if totalSkipped > 0 {
		fmt.Printf("  %s%sSkipped: %d%s\n", colorBold, colorYellow, totalSkipped, colorReset)
	}
	fmt.Printf("  Total: %d\n", totalPassed+totalFailed+totalSkipped)
	fmt.Println()

	if totalFailed > 0 {
		fmt.Printf("%s%sFailed questions:%s\n", colorBold, colorRed, colorReset)
		for _, r := range allResults {
			if !r.Passed {
				fmt.Printf("  • %s — %s\n", r.ID, r.Title)
				if r.SetupErr != "" {
					fmt.Printf("    %s%s%s\n", colorDim, r.SetupErr, colorReset)
				}
				for _, c := range r.Checks {
					if !c.Passed {
						fmt.Printf("    ✗ %s (expected %q, got %q)\n", c.Description, c.Expected, c.Actual)
					}
				}
			}
		}
		fmt.Println()
		os.Exit(1)
	}
}

// ── Solution parser ──
// Converts human-readable solution text into executable commands.
// Handles: ssh <node> blocks, heredocs (<<EOF...EOF), line continuations (\),
// kubectl commands, and comment stripping.

func parseSolution(solution, kubeContext string) []string {
	if solution == "" {
		return nil
	}

	lines := strings.Split(solution, "\n")
	var commands []string
	var currentNode string
	var nodeCommands []string

	i := 0
	for i < len(lines) {
		line := strings.TrimSpace(lines[i])

		// Skip empty lines and comments
		if line == "" || strings.HasPrefix(line, "#") {
			i++
			continue
		}

		// Skip informational commands
		if line == "exit" {
			if currentNode != "" && len(nodeCommands) > 0 {
				commands = append(commands, buildDockerExec(currentNode, nodeCommands))
				nodeCommands = nil
			}
			currentNode = ""
			i++
			continue
		}

		// Detect SSH into a node
		if strings.HasPrefix(line, "ssh ") {
			if currentNode != "" && len(nodeCommands) > 0 {
				commands = append(commands, buildDockerExec(currentNode, nodeCommands))
				nodeCommands = nil
			}
			currentNode = strings.TrimSpace(strings.TrimPrefix(line, "ssh "))
			i++
			continue
		}

		// Check for heredoc: line contains <<EOF, <<'EOF', <<"EOF", <<MARKER, etc.
		heredocDelim := detectHeredoc(line)
		if heredocDelim != "" {
			// Collect all lines until the closing delimiter.
			// Detect indentation of heredoc body and strip it so the content
			// is written without YAML-inherited leading spaces.
			fullCmd := line // already trimmed
			i++
			var bodyLines []string
			for i < len(lines) {
				rawLine := strings.TrimSpace(lines[i])
				bodyLines = append(bodyLines, lines[i])
				if rawLine == heredocDelim {
					break
				}
				i++
			}
			i++

			// Determine minimum indentation of body lines (excluding delimiter)
			minIndent := -1
			for _, bl := range bodyLines[:max(0, len(bodyLines)-1)] {
				if strings.TrimSpace(bl) == "" {
					continue
				}
				indent := len(bl) - len(strings.TrimLeft(bl, " \t"))
				if minIndent < 0 || indent < minIndent {
					minIndent = indent
				}
			}
			if minIndent < 0 {
				minIndent = 0
			}

			// Rebuild heredoc with stripped indentation
			for _, bl := range bodyLines {
				stripped := bl
				if len(stripped) > minIndent {
					stripped = stripped[minIndent:]
				}
				fullCmd += "\n" + stripped
			}

			if currentNode != "" {
				nodeCommands = append(nodeCommands, fullCmd)
			} else {
				commands = append(commands, fullCmd)
			}
			continue
		}

		// Check for line continuation (\)
		fullLine := line
		for strings.HasSuffix(fullLine, "\\") && i+1 < len(lines) {
			i++
			fullLine = fullLine[:len(fullLine)-1] + " " + strings.TrimSpace(lines[i])
		}

		if currentNode != "" {
			nodeCommands = append(nodeCommands, fullLine)
		} else {
			commands = append(commands, fullLine)
		}
		i++
	}

	// Flush remaining node commands
	if currentNode != "" && len(nodeCommands) > 0 {
		commands = append(commands, buildDockerExec(currentNode, nodeCommands))
	}

	return commands
}

// detectHeredoc checks if a line contains a heredoc start (<<DELIM) and returns
// the delimiter string, or "" if not a heredoc.
func detectHeredoc(line string) string {
	// Match patterns: <<EOF, <<'EOF', <<"EOF", <<-EOF, <<YAML, <<POLICY, etc.
	re := regexp.MustCompile(`<<-?\s*'?\"?([A-Za-z_][A-Za-z0-9_]*)'?\"?`)
	m := re.FindStringSubmatch(line)
	if len(m) >= 2 {
		return m[1]
	}
	return ""
}

// dockerExecScript is a sentinel prefix used to identify commands that need
// special handling (piping a script into docker exec via stdin).
const dockerExecPrefix = "@@DOCKER_EXEC@@"

// buildDockerExec returns a tagged command that runCmd will handle specially,
// piping the script via stdin to preserve heredocs and newlines.
func buildDockerExec(node string, cmds []string) string {
	script := strings.Join(cmds, "\n")
	return dockerExecPrefix + node + "@@" + script
}

// ── Command execution ──

func runCmd(command, kubeconfig string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	// Handle docker exec with piped stdin (for heredocs/multiline scripts)
	if strings.HasPrefix(command, dockerExecPrefix) {
		parts := strings.SplitN(strings.TrimPrefix(command, dockerExecPrefix), "@@", 2)
		if len(parts) == 2 {
			node, script := parts[0], parts[1]
			cmd := exec.CommandContext(ctx, "docker", "exec", "-i", node, "bash")
			cmd.Stdin = strings.NewReader(script)
			if kubeconfig != "" {
				cmd.Env = append(cmd.Environ(), "KUBECONFIG="+kubeconfig)
			}
			out, err := cmd.CombinedOutput()
			if err != nil {
				return fmt.Errorf("%v (output: %s)", err, strings.TrimSpace(string(out)))
			}
			return nil
		}
	}

	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	if kubeconfig != "" {
		cmd.Env = append(cmd.Environ(), "KUBECONFIG="+kubeconfig)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v (output: %s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func runCmdOutput(command, kubeconfig string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	if kubeconfig != "" {
		cmd.Env = append(cmd.Environ(), "KUBECONFIG="+kubeconfig)
	}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func matchOutput(actual, expected, matchType string) bool {
	switch matchType {
	case "contains":
		return strings.Contains(actual, expected)
	case "regex":
		matched, err := regexp.MatchString(expected, actual)
		return err == nil && matched
	case "not-contains":
		return !strings.Contains(actual, expected)
	default: // "exact"
		return actual == expected
	}
}

// ── Loader ──

func loadSession(dir string) (*Exam, []Question, error) {
	// Load exam.yaml
	examData, err := os.ReadFile(filepath.Join(dir, "exam.yaml"))
	if err != nil {
		return nil, nil, fmt.Errorf("read exam.yaml: %w", err)
	}
	var exam Exam
	if err := yaml.Unmarshal(examData, &exam); err != nil {
		return nil, nil, fmt.Errorf("parse exam.yaml: %w", err)
	}

	// Load question YAMLs
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil, err
	}

	var questions []Question
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") || e.Name() == "exam.yaml" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, nil, fmt.Errorf("read %s: %w", e.Name(), err)
		}
		var q Question
		if err := yaml.Unmarshal(data, &q); err != nil {
			return nil, nil, fmt.Errorf("parse %s: %w", e.Name(), err)
		}
		questions = append(questions, q)
	}

	return &exam, questions, nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, colorRed+"Error: "+format+colorReset+"\n", args...)
	os.Exit(1)
}

// ── Cluster lifecycle (for --e2e mode) ──

// deleteCluster removes a Kind cluster by name (silently ignores if not found).
func deleteCluster(name string) {
	exec.Command("kind", "delete", "cluster", "--name", name).Run()
}

// createCluster creates a Kind cluster with the specified configuration.
func createCluster(cfg ClusterConfig) error {
	// Build kind config YAML
	var nodes []string

	cp := cfg.ControlPlane
	if cp == 0 {
		cp = 1
	}
	for i := 0; i < cp; i++ {
		nodes = append(nodes, "  - role: control-plane")
	}
	for i := 0; i < cfg.Workers; i++ {
		nodes = append(nodes, "  - role: worker")
	}

	kindConfig := fmt.Sprintf(`kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
%s
`, strings.Join(nodes, "\n"))

	// Write config to temp file
	tmpFile, err := os.CreateTemp("", "kind-config-*.yaml")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.WriteString(kindConfig); err != nil {
		return fmt.Errorf("write kind config: %w", err)
	}
	tmpFile.Close()

	// Create cluster
	cmd := exec.Command("kind", "create", "cluster",
		"--name", cfg.Name,
		"--config", tmpFile.Name(),
		"--wait", "120s",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v\n%s", err, string(out))
	}
	return nil
}

// mergeKubeconfigs merges kubeconfigs for all clusters into a single temp file.
func mergeKubeconfigs(clusters []ClusterConfig) string {
	home, _ := os.UserHomeDir()
	defaultKC := filepath.Join(home, ".kube", "config")

	// Kind automatically adds contexts to the default kubeconfig,
	// so after creating all clusters, the default config has everything.
	// We just need to return the path.
	return defaultKC
}

// waitForCluster waits until all nodes in a cluster are Ready.
func waitForCluster(name, kubeconfig string) {
	ctx := fmt.Sprintf("kind-%s", name)
	// Switch context and wait for nodes
	for attempt := 0; attempt < 30; attempt++ {
		cmd := exec.Command("kubectl", "--context", ctx, "--kubeconfig", kubeconfig,
			"get", "nodes", "-o", "jsonpath={.items[*].status.conditions[-1:].type}")
		cmd.Env = append(cmd.Environ(), "KUBECONFIG="+kubeconfig)
		out, err := cmd.Output()
		if err == nil && strings.Count(string(out), "Ready") > 0 && !strings.Contains(string(out), "NotReady") {
			return
		}
		time.Sleep(3 * time.Second)
	}
	fmt.Printf("  %s⚠ Warning: cluster %s may not be fully ready%s\n", colorYellow, name, colorReset)
}
