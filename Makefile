.PHONY: dev build clean install-wails

# Development: Wails dev mode (hot-reload frontend + Go rebuild)
dev:
	wails dev

# Build production binary (single file, all platforms)
build:
	wails build

# Build for specific platforms
build-darwin:
	wails build -platform darwin/universal

build-linux:
	wails build -platform linux/amd64

# Install Wails CLI (run once)
install-wails:
	go install github.com/wailsapp/wails/v2/cmd/wails@latest

# Frontend only (for debugging)
frontend-install:
	cd frontend && npm install

frontend-dev:
	cd frontend && npm run dev

# Clean build artifacts
clean:
	rm -rf build/bin/
	rm -rf frontend/dist/
	rm -rf frontend/node_modules

# ──────────────────────────────────────────────
# Test runner: validate solutions against running clusters
# Prerequisites: Kind clusters must be running for the target session
test-session:
	@if [ -z "$(SESSION)" ]; then echo "Usage: make test-session SESSION=session-1"; exit 1; fi
	go run cmd/test-runner/main.go --session $(SESSION)

test-question:
	@if [ -z "$(SESSION)" ] || [ -z "$(QUESTION)" ]; then echo "Usage: make test-question SESSION=session-1 QUESTION=s1-01-namespace-resource-quotas"; exit 1; fi
	go run cmd/test-runner/main.go --session $(SESSION) --question $(QUESTION)

test-all:
	go run cmd/test-runner/main.go --session all

# Full e2e: delete clusters → create → test → delete (clean slate)
test-e2e:
	@if [ -z "$(SESSION)" ]; then echo "Usage: make test-e2e SESSION=session-1"; exit 1; fi
	go run cmd/test-runner/main.go --session $(SESSION) --e2e

# E2e but keep clusters after tests (for debugging failures)
test-e2e-keep:
	@if [ -z "$(SESSION)" ]; then echo "Usage: make test-e2e-keep SESSION=session-1"; exit 1; fi
	go run cmd/test-runner/main.go --session $(SESSION) --e2e --keep

test-dry-run:
	@if [ -z "$(SESSION)" ]; then echo "Usage: make test-dry-run SESSION=session-1"; exit 1; fi
	go run cmd/test-runner/main.go --session $(SESSION) --dry-run
