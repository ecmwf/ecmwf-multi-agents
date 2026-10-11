<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/) as `MAJOR.MINOR.MICRO` without a `v` prefix.

## [Unreleased]

### Changed

- `/review` and `/progress` cost about a quarter of what they did on opencode 1.x. The reviewer
  or scout now answers in your own session, so its report appears there directly and `lead`
  no longer spends a turn relaying it; the plugin keeps the earlier conversation out of the
  helper's requests, so reviews stay independent and cheap in long sessions. On opencode 2
  they still run in a separate session, and `lead` relays the report briefly.
- Releasing is one command: `make release X.Y.Z` runs the checks, sets the version, updates
  the changelog and `dist/`, commits, pushes, tags and publishes, and continues where it
  stopped when run again. `make version` now only prints the version.

### Fixed

- `lead` runs each command that needs your approval (push, pull requests, merges, history
  rewrites) on its own. It used to chain a commit and a push in one command, so refusing the
  push also lost the commit.

### Added

- `evals/results/` keeps eval summaries for comparison; the first one is the 0.1.0 baseline.
- Eval cases `review-warm` and `progress-warm` run the commands after a first question, as in
  normal use.

## [0.1.0] - 2026-10-11

The first release: a multi-agent harness for opencode with one agent you talk to and three
helpers it hands work to.

### Added

- Four agents. `lead` talks to you, plans, hands out work, checks results and commits when
  asked. `scout` does read-only lookups and investigations, `builder` makes one specified
  change and runs its checks, and `reviewer` gives an independent APPROVE or REJECT. Helpers
  work from a written brief, report in a fixed format, never ask you questions and never hand
  work on.
- Default models and efforts: `lead` Claude Opus 5.5 at xhigh, `scout` Claude Sonnet 5.5 at
  medium, `builder` Claude Sonnet 5.5 at high, `reviewer` GPT 6.1 Sol through GitHub Copilot at
  medium. Profiles `default`, `anthropic`, `copilot` and `inherit`.
- Commands: `/onboard` surveys a repository and keeps a summary for later sessions, `/plan`
  plans work with you and waits for approval, `/go` carries out an approved plan (also in a
  fresh session), `/review` reviews uncommitted changes, a branch, a commit, a pull request or
  a plan (it replaces opencode's own `/review`), `/progress` shows plan progress, and `/guide`
  explains the harness.
- A settings file, `ecmwf-multi-agents.jsonc`, globally and per project: the review policy
  (`auto`, `ask`, `always`, `never`), the profile, whether `lead` is the default agent, and
  per-agent `model`, `effort` and `steps`. A small plugin applies it when opencode starts.
- Safety rules: helpers cannot commit, push or rewrite history; pushing, pull requests and
  merges always need your approval. On opencode 1.x the plugin keeps the helpers' limits even
  after an "Allow always" answer.
- `install.sh`: install for yourself (links), for one project (copies), or once on a shared
  machine for opencode 1.x (a read-only copy loaded with `OPENCODE_CONFIG_DIR`); `doctor`
  checks an installation and `uninstall` removes it. It never overwrites files it did not
  create.
- Support for opencode 1.x from 1.18.35 (tested on 1.18.35 and 1.19.0) and for opencode 2.0.16.
- Scenario evals (`make evals`) that compare the harness with plain opencode on a sample
  repository, using real models.

[Unreleased]: https://github.com/ecmwf/ecmwf-multi-agents/compare/0.1.0...HEAD
[0.1.0]: https://github.com/ecmwf/ecmwf-multi-agents/releases/tag/0.1.0
