<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Plan and progress

This file tracks how ecmwf-multi-agents gets built. It is the only place where phase numbers
appear: code, prompts, docs and commit messages describe what things are, not when they were
done.

Legend: `[ ]` to do, `[~]` in progress, `[x]` done, `[!]` blocked. Tasks marked **(par)** can run
in parallel with their siblings.

Who does what: a task that starts with a first name (`Tiago:` or `Samet:`) belongs to that
person, and nobody else picks it up. A task without a name is free. To take one, claim it in
this file first and push the claim, as `AGENTS.md` (Working together) describes.

## Goal

A multi-agent harness for opencode that ECMWF scientists, analysts and developers can install in
minutes. One agent, `lead`, talks to the user, makes every decision and hands work to helpers
that read, build or check. Each helper runs on the cheapest model that suits its job, so a
session costs less and `lead`'s context stays small. Roles are generic; ECMWF-specific job
support waits in `TODO.md` until approved.

## Decisions

| Topic | Decision |
|---|---|
| Name | `ecmwf-multi-agents` |
| Agents | Four: `lead` (primary, default), `scout`, `builder`, `reviewer`. No separate deep tiers: each agent has a default effort, which users change per agent in the settings file |
| Default models | `lead`: `anthropic/claude-opus-5-5` xhigh. `builder`: `anthropic/claude-sonnet-5-5` high. `scout`: `anthropic/claude-sonnet-5-5` medium. `reviewer`: `github-copilot/gpt-6.1-sol` medium |
| Versions | `MAJOR.MINOR.MICRO` without a `v`, single source in `VERSION`, tag equals version; one step: `make release X.Y.Z` |
| Profiles | `default` (above), `anthropic` (Anthropic API only), `copilot` (GitHub Copilot only), `inherit` (session model everywhere). ECMWF's internal endpoint deferred, see `TODO.md` |
| Planning | `lead` interviews the user, sends scouts, writes the plan, has it reviewed, waits for approval |
| Review policy | `auto` (default), `ask`, `always`, `never`, set in the settings file |
| Git | Agents commit only when asked. Push, PR and merge always prompt |
| Built-in agents | Kept and reachable by the user. `lead` cannot delegate to them |
| Work files | `.ecmwf-multi-agents/{plans,context,notes}/`, excluded through `.git/info/exclude` |
| Settings | `ecmwf-multi-agents.jsonc`, global in `~/.config/opencode/`, per project in `.opencode/`; applied by the optional plugin |
| opencode v1 | Main, stable target: 1.18.35 and later 1.x. Tested on 1.18.35 and 1.19.0 |
| opencode v2 | Pinned to 2.0.16, the version weave's v2 adapter uses. Moves only after a deliberate re-test |
| Tooling | TypeScript on Bun for the generator and plugin; POSIX sh installer; generated `dist/` is committed |
| Distribution | git clone + `install.sh`; central install through environment variables; npm plugin |
| Evals | Scenario suite against real models; results feed 0.2.0 (0.1.0 released before the first eval run, at the owner's choice) |

## Dependencies between phases

```mermaid
flowchart LR
  F[0a Foundations] --> K[0b Compatibility checks]
  F --> S[1 Source content]
  F --> G[2 Generator]
  K --> A[0c Platform and layout ADR]
  A --> P[3 Plugin]
  A --> I[4 Installer]
  S --> D[dist/ output]
  G --> D
  D --> P
  D --> I
  D --> E[5 Evals]
  P --> E
  I --> E
  E --> R[6 Release]
```

Source content and generator code are written in parallel against the contracts in
`docs/architecture.md` and `tools/types.ts`; they meet when `make build` produces `dist/`.

## Parallel waves

| Wave | Runs in parallel | Joins on | State |
|---|---|---|---|
| 1 | Command clash check; v1 check + v1 emitter; v2 check + v2 emitter | Three research notes, ADR 0001 | done |
| 2 | Generator core; `lead` prompt + `onboard`, `plan`, `go` + plan skill; helper prompts + `review`, `progress`, `guide` + guide skill; plugin + bundler; installer + install guide | Build and gate green | done |
| 3 | Independent prompt review; install and load tests on 1.18.35, 1.19.0 and 2.0.16; fixes | Installs and loads in isolated v1 and v2 configs | done |
| 4 | Four agents with per-agent effort (generator and plugin; prompts and docs); Makefile and version tool; eval harness | Release 0.1.0 | done |
| 5 | Eval runs, baseline, prompt fixes from the results | Release 0.2.0 | in progress |
| 6 | npm package, CI, v2 central install, docs polish | | |

Ownership rule for parallel work: every task owns a disjoint set of files; shared contracts
(`docs/architecture.md`, `docs/adr/`, `src/manifest.jsonc`, `tools/types.ts`, this plan) change
only between waves. Between the two developers, a change to a shared contract goes in its own
small commit, pushed promptly.

## Phase 0: foundations and compatibility

0a. Foundations

- [x] Repository scaffold: git, licence, REUSE, `.gitignore`
- [x] `PLAN.md`, `AGENTS.md`, `README.md`, `TODO.md`
- [x] `docs/architecture.md`: roles, routing, hand-off contract, work files, settings
- [x] Generator contract: `src/manifest.jsonc`, `src/profiles/`, `tools/types.ts`, `package.json`

0b. Compatibility checks (wave 1)

- [x] **(par)** Command name clashes with opencode built-ins (v1 1.18.35 and 1.19.0, v2 2.0.16),
  weave, and commands already in the user's config, into `docs/research/command-clashes.md`
- [x] **(par)** v1 mechanics, into `docs/research/opencode-v1.md`: agents from a config dir, JSON
  vs Markdown precedence, `permission.task` filtering, question deny, `steps`, `variant`,
  replacing the built-in `scout`, skill permissions, plugin `config` hook, plugin auto-discovery
- [x] **(par)** v2 mechanics at 2.0.16, into `docs/research/opencode-v2.md`: agent file format,
  `model#variant`, permissions list, commands, skills, plugin agent registration, whether v1
  and v2 can share `~/.config/opencode`, central install mechanism

0c. Decision record

- [x] `docs/adr/0001-platforms-and-install-layout.md` from the three checks; contracts updated
  (`execute` action, notes path pair, `progress` command, permission semantics)

Exit: every check question has an answer backed by a command run or a source reference.

## Phase 1: source content

- [x] **(par)** `lead` prompt; commands `onboard`, `plan`, `go`; skill `ecmwf-multi-agents-plan`
  (planning and execution procedure, plan file format)
- [x] **(par)** Helper prompts: `scout`, `builder`, `reviewer`; commands `review`, `progress`,
  `guide`; skill `ecmwf-multi-agents-guide` (user guide)
- [x] Four agents: the deep tiers merged into `scout` (investigations, notes file) and
  `builder` (hard fixes); per-agent effort in profiles and settings
- [x] Command names final: `onboard`, `plan`, `go`, `review` (replaces the built-in), `progress`
  (instead of `status`, a TUI built-in), `guide`
- [x] Profiles: `default`, `anthropic`, `copilot`, `inherit`
- [x] Independent review of all prompts against `docs/architecture.md`, by scenario walk-through;
  nine blockers and six improvements applied, contract updated to match

Exit: every prompt within its budget; review verdict APPROVE. Budgets are nearly full:
`lead` 1,792 of 1,800, plan skill 1,186 of 1,200, guide skill 1,198 of 1,200.

## Phase 2: generator

- [x] Core: JSONC loader, manifest validation, prompt budgets, settings schema output,
  `dist/` writer with support files (`schema.json`, `profiles/`, `files.txt`), `--check` mode
- [x] **(par)** v1 emitter: agents, commands, skills in v1 format (unit and integration tests)
- [x] **(par)** v2 emitter: agents, commands, skills in v2 format (unit and integration tests)
- [x] The gate, now `make check`: versions, `dist/` up to date (with manifest validation and
  budgets), typecheck, `reuse lint`, `shellcheck`, unit tests
- [x] Makefile (`help`, `setup`, `build`, `check`, `lint`, `test`, `integration`, `evals`,
  `version`, `release`, `clean`) and `tools/version.ts`; `VERSION` is the single source

Exit: `dist/` loads in v1 (`opencode debug agent`) and v2 in isolated configs.

## Phase 3: plugin

- [x] Core: read settings (site, global, project), resolve profile and per-agent models,
  rewrite the review policy line in `lead`, set the default agent
- [x] **(par)** v1 entry: `config` hook; guard re-applying helper shell rules in
  `tool.execute.before` (verified end to end with a stand-in model server)
- [x] **(par)** v2 entry: agent transform re-registered on `plugin.updated`
- [x] Bundler `tools/bundle-plugin.ts`: one ES module for both platforms, profiles embedded
- [x] Tests, including "the harness works without the plugin"

## Phase 4: installer

- [x] `install.sh`: global (links) and `--project DIR` (copies), `--central DIR`, `--profile`,
  `--review`, `--platform`, `--dry-run`, `doctor`, `uninstall`; detects the opencode version
- [x] Central install on opencode 1.x (read-only copy plus `OPENCODE_CONFIG_DIR`), verified
  read-only on 1.18.35 and 1.19.0; `docs/install.md`
- [x] Tests in sandboxes for 1.18.35, 1.19.0 and 2.0.16; `shellcheck` (containers move to CI)

Integration suites (opt-in, `ECMWF_MULTI_AGENTS_INTEGRATION=1`): 49 tests pass on 1.18.35,
1.19.0 and 2.0.16 across emitters, plugin and installer.

## Phase 5: evals

- [x] **(par)** Fixture repository (`evals/fixtures/stations`, standard-library Python)
- [x] **(par)** Twelve cases: answer, trivial edit, bug fix, feature, investigate, inventory,
  review reject and approve, no push, `/onboard`, plan and go, `/progress`
- [x] **(par)** Runner: sandboxed `opencode serve`, permission and question answering, per-agent
  cost, tokens and child sessions, `lead` peak context, checks, summary
- [x] First real-model run of the full suite on 0.1.0, default profile, opencode 1.18.35
  (Anthropic login through `ECMWF_MULTI_AGENTS_EVAL_PLUGINS`): 19 runs, $4.10, 15 minutes.
  Summary in `evals/results/0.1.0.md`
- [x] Fix from the results: `lead` chained commit and push in one command, so refusing the push
  lost the commit (`no-push` failed); fixed, and passes three out of three
- [x] Tiago: `/review` and `/progress` without the extra `lead` turn (see the first finding
  below); measure cold and warm sessions before and after
- [x] Tiago: One release command: fold `make version X.Y.Z` into `make release X.Y.Z` (set the
  version, roll the changelog, rebuild, check, commit, push, tag, publish), resumable and
  with `DRY_RUN=1`
- [ ] A larger eval fixture, or cases that need broad reading, to test whether delegation saves
  cost at scale (see the second finding below)
- [ ] Baseline for the `copilot` and `anthropic` profiles; repeats (`--repeat 3`) for variance
- [ ] Set targets once variance is known
- [ ] Release 0.2.0

Baseline on 0.1.0 (one run each):

| | Harness | Baseline (`build`, same model as `lead`) |
|---|---|---|
| Passed | 11 of 12 | 7 of 7 |
| Mean cost, the seven shared cases | $0.161 | $0.160 |
| Peak context, `feature` | 25,750 | 32,005 |

Findings to act on for 0.2.0:

- Done: `/review` and `/progress` ran their helper in a child session, and opencode 1.x then
  gave `lead` a turn to report the result, costing three to four times the helper's own work.
  On opencode 1.x the helper now answers in the user's session (`subtask: false`); the TUI
  keeps `lead` selected because it lists only primary agents, and the plugin keeps the earlier
  conversation out of the helper's requests. On opencode 2 a helper command still needs a child
  session, because running it inline switches the whole session to the helper. Cost of the
  command turn, mean of two runs each, opencode 1.18.35, default profile:

  | Case | Before | After | Helper's first request, tokens |
  |---|---|---|---|
  | `review-reject` (cold session) | $0.104 | $0.025 | 3,595 before and after |
  | `review-warm` (after one question) | $0.050 | $0.021 | 3,595 before and after |
  | `progress` (cold) | $0.096 | $0.029 | 7,490 before and after |
  | `progress-warm` | $0.046 | $0.029 | 7,490 before and after |

  All 16 runs passed. Equal first requests confirm the helper works from its command alone.
- The sample repository is small: `lead` answered, investigated and fixed bugs itself, without
  helpers, and still matched the baseline's cost. Delegation only showed in `feature`,
  `onboard` and `plan-go`. Add a larger fixture, or cases that need broad reading, to test
  whether delegation saves cost at scale.
- The baseline pushed to the remote without asking in `no-push`, which shows what the
  approval rules protect against.

## Phase 6: release

- [ ] npm package (plugin that also carries agents, commands and skills)
- [ ] Central install on opencode 2 (generated `opencode.json` through `OPENCODE_CONFIG`)
- [ ] CI: `make check` plus the integration suites in containers per opencode version
- [ ] README quickstart for scientists; `/guide` content final
- [x] Version 0.1.0

## Open questions

- npm scope for the plugin package (the repository is github.com/ecmwf/ecmwf-multi-agents).
- Prompt budgets (`lead` 1,800 tokens, helpers 700, commands 500, skills 1,200) are nearly
  full; raise them or trim prompts, informed by eval results.
- `/onboard` is shadowed in projects that define their own `onboard` command (some local
  projects do). Kept as requested; renaming to `survey` would avoid it.

## Log

- 2026-10-11: Design agreed through interview. Scaffold, plan and contracts written.
- 2026-10-11: Compatibility checks done for 1.18.35, 1.19.0 and 2.0.16; both emitters written
  and tested against the real binaries. ADR 0001 records platforms and install layout.
  `status` renamed `progress`; `execute` (Code Mode) action added and denied to read-only
  helpers. The generator core and helper prompt tasks produced no output and were restarted.
- 2026-10-11: Generator core, all prompts, plugin and installer done. Independent prompt review
  applied. Gate green (297 tests); 49 integration tests green on all three opencode
  versions. Central install verified read-only on opencode 1.x. Next: evals.
- 2026-10-11: Repository published at github.com/ecmwf/ecmwf-multi-agents. Simplified to four
  agents with per-agent effort. Makefile and version tooling added; 0.1.0 released. Eval
  harness built and run on 0.1.0 with real models: 18 of 19 runs passed for $4.10; the
  failure led to the commit-and-push fix.
- 2026-10-11: Rules for two developers added (`AGENTS.md`, Working together). `/review` and
  `/progress` answer in the user's session on opencode 1.x: the command turn costs 24 to 30%
  of what it did in a new session, 42 to 63% after a first question. Releasing is one
  command, `make release X.Y.Z`.
