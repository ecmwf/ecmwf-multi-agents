<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Agent instructions

ecmwf-multi-agents is a multi-agent harness for opencode: one `lead` agent that decides, and
three helpers (`scout`, `builder`, `reviewer`) that read, build or check. `CLAUDE.md` is a
symlink to this file.

- Plan and progress: `PLAN.md`. Deferred or unapproved work: `TODO.md`. Releases:
  `CHANGELOG.md`.
- Design contract: `docs/architecture.md`. Decisions: `docs/adr/`. Research: `docs/research/`.
- `make help` lists every development target.

## Layout

- `src/` is the only place to edit harness content: `manifest.jsonc` (agents, permissions,
  commands, skills, budgets), `agents/` (prompt bodies), `commands/`, `skills/`, `profiles/`.
- `tools/` holds the TypeScript (Bun) generator and the version tool. `make build` writes
  `dist/opencode-v1/` and `dist/opencode-v2/`.
- `dist/` is generated and committed. Never edit it by hand.
- `plugin/` is the optional runtime plugin. `install.sh` is the POSIX sh installer. `evals/`
  holds scenario evals that call real models.

## Rules

- `make check` must pass before every commit. Fix causes; never suppress lints, skip tests or
  weaken assertions to get green. After changing `src/`, `tools/` or `plugin/`, run
  `make build` and commit the regenerated `dist/` with the change.
- Prompts stay within the budgets in `src/manifest.jsonc`, use plain language, and work on any
  capable model. Do not use weather terms (analysis, model, observation, ensemble, suite) as
  role or command names.
- Only `lead` talks to the user. Helpers never ask questions and never delegate.
- Agent permission rules override the user's own policy, so add `deny` rules freely and
  `allow` or `ask` rules only with a stated reason (see `docs/architecture.md`). Push, PR and
  merge always need the user's approval.
- Tests never touch the real `~/.config/opencode`, `~/.local/share/opencode` or the user's
  sessions: use temporary `XDG_*` directories. Evals link the user's opencode login file into
  their sandbox and never read, copy or print it.
- Phase numbers and other process history stay in `PLAN.md`; code, prompts, docs and commit
  messages name what a thing is or does.
- Docs use plain prose without em dashes; diagrams use mermaid.
- Commits: Conventional Commits, no AI attribution or co-author trailers. Never push without
  approval.
- Never print, log, commit or ask for credentials.
- New files carry SPDX headers. Markdown that becomes a prompt (agents, commands, skills,
  `dist/`) is licensed through `REUSE.toml` instead, so the header never reaches a model.

## Working together

Tiago Quintino and Samet Demir develop this repository together, each with their own agents.
`PLAN.md` records who does what.

- You work for the person who started your session; `git config user.name` names them. If
  unsure, ask.
- Before starting a task from `PLAN.md`, run `git pull --rebase` and read the task again. A task
  that names the other person (`- [ ] Samet: ...`) is theirs: never pick it up, even if it looks
  stalled; tell your user instead. A task that names your user, or no one, may be taken.
- Claim the task before you change anything else: mark it `[~]`, put your user's first name in
  front (`- [~] Tiago: ...`), commit only `PLAN.md` as `chore(plan): <name> takes <task>`, and
  push at once. A claim is the one push that needs no further approval, because the other
  person must see it. If the push is rejected, pull again; if someone else claimed the task
  first, drop your claim and tell your user.
- New work found along the way goes into `PLAN.md` as a new task, without a name unless your
  user says it is theirs.
- Mark the task `[x]` in the commit that completes it. Pull before every push and never
  force-push `main`.

## Releasing

- Versions are `MAJOR.MINOR.MICRO` without a `v`; the tag is exactly the version. The
  `VERSION` file is the single source; `package.json` and the generated plugin carry copies.
- Record user-visible changes under `## [Unreleased]` in `CHANGELOG.md` as you make them.
- To release: `make version X.Y.Z` (sets the version, moves the `[Unreleased]` entries under
  it, rebuilds `dist/`), `make check`, commit as `chore: release X.Y.Z`, push with the user's
  approval, then `make release` (tags and publishes the GitHub release; `DRY_RUN=1` previews).
