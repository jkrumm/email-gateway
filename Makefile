.PHONY: dev
dev: ## Run the dev server (secrets-run + bun --watch — see .env.tpl)
	@bun run dev

.PHONY: check
check: ## format:check + lint (client check-theme) + typecheck (server + client) + test
	@bun run format:check && bun run lint && bun run typecheck && bun test

.PHONY: build
build: ## Build the client SPA into client/dist
	@bun run build

.PHONY: deploy
deploy: ## Ships the merged default branch — CI deploys on push (RollHook); this confirms that
	@echo "deployed by CI on push"

.PHONY: verify
verify: ## Probe production /health; exit 0 = live and healthy (HEALTH_URL=… probes the public URL)
	@if [ -n "$(HEALTH_URL)" ]; then \
	  curl -fsS "$(HEALTH_URL)" | grep -q '"ok":true' \
	    && echo "email-gateway: healthy ($(HEALTH_URL))" \
	    || { echo "email-gateway: UNHEALTHY ($(HEALTH_URL))"; exit 1; }; \
	else \
	  ssh vps 'docker exec $$(docker ps -q --filter "label=com.docker.compose.service=email-gateway" | head -n1) curl -fsS http://localhost:3010/health' | grep -q '"ok":true' \
	    && echo "email-gateway: healthy (container /health)" \
	    || { echo "email-gateway: UNHEALTHY — ssh vps + container /health probe failed"; exit 1; }; \
	fi

.PHONY: logs
logs: ## Bounded tail of the production container logs (last 200 lines, then exits)
	@ssh vps 'docker logs --tail 200 $$(docker ps -q --filter "label=com.docker.compose.service=email-gateway" | head -n1)'

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "; printf "\n  email-gateway\n\n"} /^[a-zA-Z_-]+:.*?## / { printf "  make %-8s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo ""
	@echo "  Production runs on the VPS via RollHook (push to master = deploy)."
	@echo "  See AGENTS.md §Deploy and §Verify & Monitor."
	@echo ""

.DEFAULT_GOAL := help
