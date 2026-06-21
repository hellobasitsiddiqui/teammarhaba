# TeamMarhaba — dev command runner (TM-69).
# One entry point for the polyglot mono-repo so nobody has to learn five toolchains.
# Every target is a THIN wrapper over the per-surface tooling (Docker Compose, the Maven
# wrapper, etc.) — no logic is duplicated here.
#
# Prerequisites (from a clean clone):
#   - Docker + Docker Compose v2   (for up/down/build/run-the-stack)
#   - JDK 21                        (only for the host-side backend targets: test/lint/fmt/run)
#                                    the backend uses the bundled Maven wrapper (./mvnw) — no system Maven
#   - cp .env.example .env          (set DB_PASSWORD for local dev; see README)
#
# Run `make` or `make help` to list targets.

# Use bash with strict flags for recipe lines.
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

BACKEND := backend
COMPOSE := docker compose
MVNW := ./mvnw -B

.DEFAULT_GOAL := help

## --- Stack (Docker Compose) ---

.PHONY: up
up: ## Build + start the full stack (postgres, backend, web) in the background
	$(COMPOSE) up --build -d
	@echo ""
	@echo "Stack up:"
	@echo "  backend  -> http://127.0.0.1:8080/health"
	@echo "  web      -> http://127.0.0.1:8081"
	@echo "  postgres -> 127.0.0.1:5432"
	@echo "Use 'make logs' to tail, 'make down' to stop."

.PHONY: down
down: ## Stop the stack (keeps the database volume)
	$(COMPOSE) down

.PHONY: down-v
down-v: ## Stop the stack AND wipe the database volume
	$(COMPOSE) down -v

.PHONY: logs
logs: ## Tail logs from the running stack
	$(COMPOSE) logs -f

.PHONY: ps
ps: ## Show stack container status
	$(COMPOSE) ps

## --- Build ---

.PHONY: build
build: ## Build all surfaces: backend jar + container images
	cd $(BACKEND) && $(MVNW) -DskipTests package
	$(COMPOSE) build

## --- Backend (host-side, via the Maven wrapper) ---

.PHONY: test
test: ## Run the backend test suite + checks (./mvnw verify — needs Docker for Testcontainers)
	cd $(BACKEND) && $(MVNW) verify

.PHONY: run
run: ## Run the backend app locally on the host (Spring Boot, port 8080)
	cd $(BACKEND) && $(MVNW) spring-boot:run

.PHONY: lint
lint: ## Check formatting/style (Spotless) — the same check CI runs
	cd $(BACKEND) && $(MVNW) spotless:check

.PHONY: fmt
fmt: ## Auto-apply formatting (Spotless)
	cd $(BACKEND) && $(MVNW) spotless:apply

## --- Meta ---

.PHONY: help
help: ## List all targets
	@echo "TeamMarhaba — make targets:"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'
