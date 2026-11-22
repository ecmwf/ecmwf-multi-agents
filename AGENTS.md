<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Agent instructions

ecmwf-multi-agents is a multi-agent harness for opencode: one `lead` agent that decides, and
helpers that read, build or check. `CLAUDE.md` is a symlink to this file.

- Design: `DESIGN.md`, the entry point, which links the contract (`docs/architecture.md`), the
  decisions (`docs/adr/`) and the research (`docs/research/`). Do not repeat them here.
- Open work, proposals and questions: GitHub issues. Releases: `CHANGELOG.md`.
- Building, testing, installing from source and releasing: `CONTRIBUTING.md`. `make help` lists
  every development target.

## Layout

- `src/` is the only place to edit harness content: `manifest.jsonc` (agents, permissions,
  commands, skills, budgets), `agents/` (prompt bodies), `commands/`, `skills/`, `profiles/`.
- `tools/` holds the TypeScript (Bun) generator and the version tool. `make build` writes
  `dist/opencode-v2/`.
- `dist/` is generated and committed. Never edit it by hand.
- `plugin/` is the optional runtime plugin. `install.sh` is the POSIX sh installer. `evals/`
  holds scenario evals that call real models.

## Rules

- `make check` must pass before every commit. Fix causes; never suppress lints, skip tests or
  weaken assertions to get green. After changing `src/`, `tools/` or `plugin/`, run
  `make build` and commit the regenerated `dist/` with the change. CI
  (`.github/workflows/ci.yml`) runs `make check` and `make pack-check` on every push and pull
  request.
- Prompts stay within the budgets in `src/manifest.jsonc`, use plain language, and work on any
  capable model. Do not use weather terms (analysis, model, observation, ensemble, suite) as
  role or command names.
- Only `lead` talks to the user. Helpers never ask questions and never delegate.
- Agent permission rules override the user's own policy, so add `deny` rules freely and
  `allow` or `ask` rules only with a stated reason (see `docs/architecture.md`). Push, PR and
  merge always need the user's approval.
- Tests never touch the real `~/.config/opencode`, `~/.local/share/opencode` or the user's
  sessions: use temporary `XDG_*` directories. Evals never touch the user's own opencode data
  either: they use an eval-only login made with `make eval-login`, which opencode itself pipes
  into each sandbox; the runner never reads, stores or prints a credential.
- Process history lives in git, `CHANGELOG.md` and `evals/results/`; code, prompts, docs and
  commit messages name what a thing is or does.
- Docs use plain prose without em dashes; diagrams use mermaid.
- Commits: Conventional Commits, no AI attribution or co-author trailers. Never push without
  approval.
- Never print, log, commit or ask for credentials.
- New files carry SPDX headers. Markdown that becomes a prompt (agents, commands, skills,
  `dist/`) is licensed through `REUSE.toml` instead, so the header never reaches a model.

## Working together

Tiago Quintino and Samet Demir develop this repository together, each with their own agents.
GitHub issues record who does what: an issue's assignee owns it.

- You work for the person who started your session; `git config user.name` names them. If
  unsure, ask.
- Before starting work, read its issue again (`gh issue view <n>`). An issue assigned to the
  other person is theirs: never pick it up, even if it looks stalled; tell your user instead. An
  unassigned `task` may be taken; a `proposal` needs both maintainers' agreement on the issue
  before any work.
- Claim the issue before you change anything else: `gh issue edit <n> --add-assignee @me`. A
  claim is the one GitHub write that needs no further approval, because the other person must
  see it. If someone else is assigned first, drop it and tell your user.
- New work found along the way: propose it to your user as a new issue, and open it when they
  agree, unassigned unless they say it is theirs.
- `main` takes changes only through pull requests. Work on a branch, and say in the pull request
  which issue it closes (`Closes #<n>`). Opening, merging and pushing still need your user's
  approval. Never force-push `main`.

## Releasing

- Versions are `MAJOR.MINOR.MICRO` without a `v`; the tag is exactly the version. The
  `VERSION` file is the single source; `package.json` and the generated plugin carry copies.
- Record user-visible changes under `## [Unreleased]` in `CHANGELOG.md` as you make them.
- Release only when your user asks, in two steps, because `main` takes only pull requests:
  on a branch `release/X.Y.Z` that holds `main`, `make release X.Y.Z` checks the files npm would
  publish (`make pack-check`, which needs npm), runs the gate, sets the version, moves the
  `[Unreleased]` entries under it, rebuilds `dist/`, runs the gate again, commits
  `chore: release X.Y.Z` and pushes the branch for a pull request. Once that is merged, the same
  command on `main` tags the release commit and publishes the GitHub release. Asking for the
  release is the approval for its pushes; the pull request's merge still needs your user.
  `DRY_RUN=1` previews; after a failure, fix the cause and run the same command again, and it
  continues where it stopped.
- Pushing the tag also publishes `@ecmwf.int/multi-agents` to npm:
  `.github/workflows/release.yml` checks the tag against `VERSION`, runs the gate and
  `make pack-check`, skips a version npm already has, and runs `npm publish` through npm
  trusted publishing, with no token. After `make release`, follow that run
  (`gh run list --workflow release.yml`, then `gh run watch <id> --exit-status`) and confirm
  with `npm view @ecmwf.int/multi-agents version`. npm's trusted publisher names `release.yml`,
  so keep that file name.
