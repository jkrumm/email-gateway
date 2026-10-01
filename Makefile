.PHONY: dev
dev: ## Run the dev server (secrets-run + bun --watch — see .env.tpl)
	@bun run dev

.PHONY: check
check: ## format:check + lint (client check-theme) + typecheck (server + client) + test
	@bun run format:check && bun run lint && bun run typecheck && bun test

.PHONY: build
build: ## Build the client SPA into client/dist
	@bun run build

.PHONY: help
help:
	@echo ""
	@echo "  email-gateway"
	@echo ""
	@echo "  make dev     Run the dev server (secrets-run + bun --watch)"
	@echo "  make check   format:check + lint + typecheck + test"
	@echo "  make build   Build the client SPA into client/dist"
	@echo ""
	@echo "  Production runs on the VPS via RollHook (push to master = deploy)."
	@echo "  No local docker-compose target — see AGENTS.md §Production."
	@echo ""

.DEFAULT_GOAL := help
