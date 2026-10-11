<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Agent instructions

ecmwf-multi-agents is a multi-agent harness for opencode: one `lead` agent that decides, and
helpers that read, build or check. `CLAUDE.md` is a symlink to this file.

- Plan and progress: `PLAN.md`. Deferred or unapproved work: `TODO.md`.
- Design contract: `docs/architecture.md`. Decisions: `docs/adr/`. Research: `docs/research/`.

## Layout

- `src/` is the only place to edit harness content: `manifest.jsonc` (agents, permissions,
  commands, skills, budgets), `agents/` (prompt bodies), `fragments/`, `commands/`, `skills/`,
  `profiles/`.
- `tools/` holds the TypeScript (Bun) generator. `bun run build` writes `dist/opencode-v1/` and
  `dist/opencode-v2/`.
- `dist/` is generated and committed. Never edit it by hand.
- `plugin/` is the optional runtime plugin. `install.sh` is the POSIX sh installer. `evals/`
  holds scenario evals.

## Rules

- `bun run check` must pass before every commit. Fix causes; never suppress lints, skip tests
  or weaken assertions to get green.
- Prompts stay within the budgets in `src/manifest.jsonc`, use plain language, and work on any
  capable model. Do not use weather terms (analysis, model, observation, ensemble, suite) as
  role or command names.
- Only `lead` talks to the user. Helpers never ask questions and never delegate.
- Agent permission rules override the user's own policy, so add `deny` rules freely and
  `allow` or `ask` rules only with a stated reason (see `docs/architecture.md`). Push, PR and
  merge always need the user's approval.
- Tests never touch the real `~/.config/opencode`, `~/.local/share/opencode` or the user's
  sessions: use temporary `XDG_*` directories.
- Phase numbers and other process history stay in `PLAN.md`; code, prompts, docs and commit
  messages name what a thing is or does.
- Docs use plain prose without em dashes; diagrams use mermaid.
- Commits: Conventional Commits, no AI attribution or co-author trailers. Never push without
  approval.
- Never print, log, commit or ask for credentials.
- New files carry SPDX headers. Markdown that becomes a prompt (agents, fragments, commands,
  skills, `dist/`) is licensed through `REUSE.toml` instead, so the header never reaches a
  model.
