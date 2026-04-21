# grindx cka

The most realistic CKA (Certified Kubernetes Administrator) exam simulator. Practice on real Kubernetes clusters with an environment that mirrors the actual PSI Bridge exam interface.

<video src="https://github.com/user-attachments/assets/7f240726-1b79-4f5d-820c-18b4836f6c32" width="100%" autoplay loop muted playsinline></video>

## Why this exists

CKA prep tools either give you multiple-choice questions (useless for a performance-based exam) or require you to manually set up clusters. grindx cka gives you the full experience: real clusters, a terminal, a timer, and scored validation — all in a desktop app.

## Features

- **Real Kubernetes clusters** — Kind clusters spun up automatically, no cloud costs
- **Bastion/jump host architecture** — Start on a jump host and SSH into nodes, exactly like the real exam
- **Multi-cluster exams** — Switch contexts between clusters just like the CKA
- **86 hands-on tasks** across 5 sessions covering all CKA domains
- **Automated validation** — Your work is scored against real cluster state
- **Post-exam review** — Category breakdown, per-question drill-down with solutions
- **Past attempts dashboard** — Track your progress over time
- **CKA-realistic UI** — Split pane with questions, terminal, and timer
- **Exam & Practice modes** — Timed exam mode or relaxed practice with hints

## CKA Domain Coverage

| Domain | Weight | Sessions |
|--------|--------|----------|
| Cluster Architecture, Installation & Configuration | 25% | Session 5 |
| Workloads & Scheduling | 15% | Sessions 1, 2 |
| Services & Networking | 20% | Sessions 1, 2, 4 |
| Storage | 10% | Sessions 2, 4 |
| Troubleshooting | 30% | Sessions 3, 4 |

## Getting Started

### Prerequisites

You need these installed before running grindx cka:

| Dependency | Why | Install |
|------------|-----|---------|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Runs Kubernetes clusters locally | [docs.docker.com](https://docs.docker.com/get-docker/) |
| [kind](https://kind.sigs.k8s.io/) | Creates local Kubernetes clusters in Docker | `brew install kind` or `go install sigs.k8s.io/kind@latest` |
| [kubectl](https://kubernetes.io/docs/tasks/tools/) | Kubernetes CLI (used inside the exam) | `brew install kubectl` |

> **Note:** Docker must be running before you start the app.

### Option 1: Download a release (recommended)

Download the latest release for your platform from the [Releases](https://github.com/grindxhq/cka/releases) page:

- **macOS** — `grindx-cka-macos-universal.dmg`
- **Linux** — `grindx-cka-linux-amd64.tar.gz`
- **Windows** — `grindx-cka-windows-amd64.zip`

On macOS, after dragging to Applications, run this once to bypass Gatekeeper:

```bash
xattr -cr /Applications/grindx\ cka.app
```

> **Windows note:** Cluster creation is slower on Windows due to Docker Desktop running through WSL2. Be patient on first launch — it's pulling images.

### Option 2: Build from source

Additional build dependencies: [Go 1.22+](https://go.dev/dl/), [Node.js 18+](https://nodejs.org/), and the [Wails CLI](https://wails.io/).

```bash
# Install Wails CLI
go install github.com/wailsapp/wails/v2/cmd/wails@latest

# Clone and build
git clone https://github.com/grindxhq/cka.git
cd cka
cd frontend && npm install && cd ..
wails build
```

The built app will be in `build/bin/`.

For development with hot-reload:

```bash
wails dev
```

## How It Works

1. **Select a session** — Choose from 5 exam sessions of increasing difficulty
2. **Clusters spin up** — Kind creates real Kubernetes clusters in Docker
3. **Solve tasks** — Use the integrated terminal to complete each task
4. **Validate** — Click validate to check your work against the actual cluster state
5. **Review** — See your score, category breakdown, and detailed solutions

## Architecture

```
┌─────────────────────────────────────────────┐
│  Desktop App (Wails v2)                     │
│  ┌──────────────┐  ┌────────────────────┐   │
│  │ React UI     │  │ Go Backend         │   │
│  │ - Questions  │  │ - Exam Service     │   │
│  │ - Terminal   │  │ - Cluster Manager  │   │
│  │ - Timer      │  │ - Validator        │   │
│  │ - Review     │  │ - History          │   │
│  └──────────────┘  └────────────────────┘   │
└─────────────────────────────────────────────┘
         │                      │
         │ WebSocket            │ docker exec
         ▼                      ▼
┌─────────────────┐   ┌─────────────────────┐
│ Bastion (Jump   │──▶│ Kind Clusters       │
│ Host Container) │SSH│ - Control Planes    │
│ [student@exam]  │   │ - Worker Nodes      │
└─────────────────┘   └─────────────────────┘
```

## Project Structure

```
.
├── app.go                 # Wails app lifecycle
├── main.go                # Entry point
├── internal/
│   ├── cluster/           # Kind cluster management + bastion setup
│   ├── service/           # Exam, questions, history, validation
│   ├── question/          # Question parsing and types
│   ├── terminal/          # WebSocket terminal handler
│   └── validator/         # Task validation engine
├── frontend/              # React + TypeScript UI
│   ├── src/components/    # UI components
│   ├── src/hooks/         # Zustand store + theme
│   └── src/api/           # Wails bindings
├── cmd/test-runner/       # Automated e2e test runner
└── questions/exams/       # Question bank (YAML)
    ├── session-1/         # Fundamentals (18 tasks)
    ├── session-2/         # Intermediate (17 tasks)
    ├── session-3/         # Advanced (16 tasks)
    ├── session-4/         # Expert (19 tasks)
    └── session-5/         # Cluster Architecture (16 tasks)
```

## Contributing

Contributions welcome — whether it's new questions, bug fixes, or features.

1. Fork the repo
2. Create your branch: `git checkout -b feature/awesome`
3. Make your changes
4. Run the e2e tests: `make test-e2e SESSION=session-1`
5. Commit and push
6. Open a PR

### Running Tests

The test runner validates every solution against real Kind clusters:

```bash
# Test a single session (creates clusters, runs solutions, validates, cleans up)
make test-e2e SESSION=session-1

# Test a specific question against a running cluster
make test-question SESSION=session-1 QUESTION=s1-01-namespace-resource-quotas

# Test all sessions
make test-all

# Dry run (shows what would execute, no cluster needed)
make test-dry-run SESSION=session-1
```

## License

[Apache License 2.0](LICENSE)

---

Built by [grindxhq](https://grindx.org)
