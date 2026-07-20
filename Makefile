SHELL := /bin/bash
.DEFAULT_GOAL := help

ifneq (,$(wildcard .env))
  include .env
  export
endif

TSX := npx tsx

.PHONY: start start-dry status events inbox help

start: ## Start the polling daemon
	$(TSX) src/index.ts start

start-dry: ## Start in dry-run mode (no messages sent)
	$(TSX) src/index.ts start --dry-run

status: ## Show watched PRs and their states
	$(TSX) src/index.ts status

events: ## Show event log
	$(TSX) src/index.ts events

inbox: ## Show pending review assignments
	$(TSX) src/index.ts inbox

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'
