# SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
# SPDX-License-Identifier: Apache-2.0
#
# Single entry point for developing this repository. `make help` lists every target.
# Everything except `evals` is deterministic: no model is called, and only `setup` and the
# first opencode start in `integration` use the network.

.DEFAULT_GOAL := help
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

BUN        ?= bun
REUSE      ?= reuse
SHELLCHECK ?= shellcheck

INTEGRATION_TESTS := tools/emit-v1.integration.test.ts tools/emit-v2.integration.test.ts \
	plugin/plugin.integration.test.ts plugin/background.integration.test.ts \
	tests/install.integration.test.ts evals/run.integration.test.ts

# `make release X.Y.Z` (positional) or `make release VERSION=X.Y.Z`. A VERSION inherited from
# the environment is ignored so a stray shell variable can never start a release.
ifeq ($(origin VERSION),environment)
VERSION :=
endif
ifneq ($(filter $(firstword $(MAKECMDGOALS)),release version),)
ifneq ($(word 2,$(MAKECMDGOALS)),)
VERSION := $(word 2,$(MAKECMDGOALS))
$(eval $(VERSION):;@:)
endif
endif

.PHONY: help setup build dist-check lint test check all integration evals version version-check \
        release clean

help: ## Show this help
	@if [ -t 1 ]; then c='\033[36m'; r='\033[0m'; else c=''; r=''; fi; \
	grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk -v c="$$c" -v r="$$r" 'BEGIN {FS = ":.*?## "}; {printf "  %s%-14s%s %s\n", c, $$1, r, $$2}'

setup: ## Install the development dependencies with Bun
	$(BUN) install --frozen-lockfile

# ── Gate ─────────────────────────────────────────────────────────────────────

check: version-check dist-check lint test ## The gate before every commit: versions, dist/, lint, unit tests

all: build check ## Regenerate dist/, then run the gate

build: ## Regenerate dist/ from src/ and bundle the plugin
	$(BUN) tools/build.ts

dist-check: ## Fail if dist/ is out of date; also validates the manifest and prompt budgets
	$(BUN) tools/build.ts --check

lint: ## Typecheck, REUSE licence information, shellcheck
	$(BUN) x tsc --noEmit -p .
	$(REUSE) lint
	$(SHELLCHECK) -s sh $$( { git ls-files --cached --others --exclude-standard '*.sh'; echo install.sh; } | sort -u)

test: ## Unit tests (the integration suites skip themselves)
	$(BUN) test

# ── Beyond the gate ──────────────────────────────────────────────────────────

integration: ## Suites against real opencode binaries, no models: OPENCODE_V1_BINS="a b" OPENCODE_V2_BIN=c
	ECMWF_MULTI_AGENTS_INTEGRATION=1 \
	$(if $(OPENCODE_V1_BINS),OPENCODE_V1_BINS="$(OPENCODE_V1_BINS)") \
	$(if $(OPENCODE_V1_BIN),,$(if $(OPENCODE_V1_BINS),OPENCODE_V1_BIN="$(firstword $(OPENCODE_V1_BINS))")) \
	$(if $(OPENCODE_V2_BIN),OPENCODE_V2_BIN="$(OPENCODE_V2_BIN)") \
		$(BUN) test --timeout 600000 $(INTEGRATION_TESTS)

evals: ## Scenario evals with REAL models (uses your provider quota): CASES="a b" REPEAT=1 VARIANT=both
	$(BUN) evals/run.ts $(foreach c,$(CASES),--case $(c)) --repeat $(or $(REPEAT),1) \
		--variant $(or $(VARIANT),both) $(if $(PROFILE),--profile $(PROFILE)) \
		$(if $(JOBS),--jobs $(JOBS)) $(if $(MAX_COST),--max-cost $(MAX_COST))

# ── Versioning and releases ──────────────────────────────────────────────────

version: ## Print the version (set one with make release X.Y.Z)
ifeq ($(VERSION),)
	@$(BUN) tools/version.ts
else
	@echo "error: setting a version is part of releasing it: make release $(VERSION)" >&2; exit 2
endif

version-check: ## Verify VERSION, package.json and CHANGELOG.md agree
	$(BUN) tools/version.ts --check

release: ## Release in one step: gate, set version, changelog, dist/, commit, push, tag, publish. make release X.Y.Z [DRY_RUN=1]
ifeq ($(VERSION),)
	@echo "error: name the version: make release X.Y.Z (DRY_RUN=1 previews)" >&2; exit 2
else
	@[[ "$(VERSION)" =~ ^[0-9]+\.[0-9]+\.[0-9]+$$ ]] || { \
		echo "error: version must be MAJOR.MINOR.MICRO without a 'v' prefix, got '$(VERSION)'" >&2; \
		exit 2; }
	$(BUN) tools/release.ts $(VERSION) $(if $(DRY_RUN),--dry-run)
endif

# ── Cleanup ──────────────────────────────────────────────────────────────────

clean: ## Remove eval transcripts and scratch output (never sources or dist/)
	rm -rf evals/runs
