<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/) as `MAJOR.MINOR.MICRO` without a `v` prefix.

## [Unreleased]

### Added

- Helpers can run in the background. When `lead` has other work meanwhile, or you may want
  to keep talking, it hands off in the background and the helper's report arrives later in
  your conversation. On opencode 1.x this needs `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`
  in your environment before opencode starts; the installer prints the line and
  `./install.sh doctor` checks it. Without it `lead` waits for every helper, as before.
- `lead` can see, redirect and stop its helpers: three plugin tools, `helpers_status`,
  `helpers_steer` and `helpers_cancel`. A redirected helper keeps everything it has read and
  done and follows the amendment at its next step instead of starting over. Tell
  `lead` "redirect the scout: stay in src/" or "stop the builder". Helpers cannot use these
  tools, whatever was approved.
- On opencode 1.x, typing into a running helper's own session now steers that helper. Before,
  the message switched the rest of its run to `lead`'s prompt, permissions and model.
- Eval cases `background-scouts`, `steer` and `cancel`, and `review-background` (`/review`
  while a background scout works).

### Changed

- Prompt budgets are ceilings raised only to a measured change: `lead` 2,050 tokens, helpers
  750, skills 1,450, for the background rules and the guide to them.

### Fixed

- On opencode 1.x, `/review` or `/progress` sent while `lead` is working (for example
  `/progress` during a long `/go`) no longer takes over `lead`'s turn. It runs separately, and
  `lead` then carries on with the report in view. Sent while `lead` is idle, it still answers
  directly in your conversation.
- On opencode 1.x, a background helper that finishes after `/review` or `/progress` now wakes
  `lead` instead of the reviewer or scout; one that finishes during a review waits for the
  verdict first.

## [0.2.0] - 2026-10-11

### Changed

- `/review` and `/progress` cost less on opencode 1.x: a quarter to a third of what they did
  in a new session, and about half after some conversation. The reviewer or scout now answers
  in your own session, so its report appears there directly and `lead` no longer spends a turn
  relaying it; the plugin keeps the earlier conversation out of the helper's requests, so
  reviews stay independent and cheap in long sessions. On opencode 2 they still run in a
  separate session, and `lead` relays the report briefly.
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

[Unreleased]: https://github.com/ecmwf/ecmwf-multi-agents/compare/0.2.0...HEAD
[0.2.0]: https://github.com/ecmwf/ecmwf-multi-agents/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/ecmwf/ecmwf-multi-agents/releases/tag/0.1.0
