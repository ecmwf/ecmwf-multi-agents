<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Architecture

This is the design contract for ecmwf-multi-agents. Prompts, generator, plugin and installer
must agree with it. Where a platform detail is still being checked, the text says so; the
answers land in `docs/research/` and `docs/adr/`.

## Principles

1. One agent decides. `lead` holds the conversation, the plan and every decision. Helpers are
   leaves: they never ask the user anything and never hand work on.
2. Delegate to save money and context. A helper is worth calling when its work would cost
   `lead` more context or a more expensive model than the hand-off costs.
3. Every hand-off is an explicit brief. A helper starts with no memory of the conversation; the
   brief is all it knows.
4. Cheapest suitable agent first; escalate on failure.
5. Reads run in parallel freely. Writes run in parallel only on disjoint files.
6. Memory lives in files. Plans, notes and summaries survive compaction and new sessions.
   Long findings go to a file; only a path and a short summary come back.
7. Nothing approves its own work. `lead` re-runs cheap checks itself before reporting success,
   and an independent reviewer checks non-trivial work.
8. Small prompts. Procedures that are only needed sometimes live in commands and skills, which
   cost nothing until used.
9. Plain language. Users include scientists and analysts who are not software-process experts.

## Roles

| Agent | Mode | Job | Steps |
|---|---|---|---|
| `lead` | primary, default | Talk to the user, size the work, plan, brief helpers, verify, commit when asked | no limit |
| `scout` | subagent | Quick read-only lookup: where is X, what calls Y, what does this doc say | 15 |
| `scout-deep` | subagent | Investigation across many files or sources, root causes, unfamiliar code | 40 |
| `builder` | subagent | One clearly specified change to a few files, then its checks | 40 |
| `builder-deep` | subagent | Subtle logic, numerics, concurrency, changes across modules, or a task `builder` failed | 80 |
| `reviewer` | subagent | Independent APPROVE or REJECT on a plan or a change | 30 |

Steps cap the number of model turns a helper may take. They act as a cost limit.

### Permissions

Rules are ordered and the last matching rule wins. opencode places agent rules after the
user's own rules, so an agent rule overrides the user's policy in both directions. The harness
therefore adds mostly `deny` rules, and only these deliberate `allow` and `ask` rules: `lead`
may ask questions and delegate to the five helpers; `lead` asks before publishing or
destructive git commands; scouts may run a short list of read-only inspection commands;
`scout-deep` may write its notes folder; the reviewer may read pull requests. One consequence:
a user who denies `git push` globally gets an approval prompt in `lead` instead.

| Capability | lead | scout | scout-deep | builder, builder-deep | reviewer |
|---|---|---|---|---|---|
| Read, search | user policy | user policy | user policy | user policy | user policy |
| Edit files | user policy | deny | only `.ecmwf-multi-agents/notes/` | user policy | deny |
| Shell | user policy, with approval for push, PR, merge and history rewrites | read-only commands only | read-only commands only | user policy, git and `gh` writes denied | user policy, git and `gh` writes denied |
| Web fetch and search | user policy | user policy | user policy | user policy | user policy |
| Delegate | the five helpers only | deny | deny | deny | deny |
| Ask the user | allow | deny | deny | deny | deny |
| Todo list (opencode 1.x) | user policy | deny | deny | platform default (denied) | deny |
| Code Mode (opencode 2) | user policy | deny | deny | user policy | deny |

opencode 1.x denies the todo list to every subagent by default, and opencode 2 has none.
Code Mode is the opencode 2 `execute` tool through which MCP tools and a few others are
reached; denying it saves about 2,200 tokens per request for helpers that never need them.

"Approval" means the rule is `ask`, so opencode prompts the user. `lead` asks before
`git push` (also through `git -C`), amending commits, `git reset --hard`, `git clean`,
`git rebase`, `git restore`, deleting branches, dropping stashes, and creating, merging or
closing pull requests. Helpers are denied every git subcommand that can change history, the
index, branches, remotes or the working tree, in all its forms: `git branch` is denied even
for listing, so helpers use `git rev-parse` and `git show` instead, and `git -C` is denied
whole. They are also denied all `gh` commands except reading pull requests (reviewer only).

Read-only commands for scouts: `git log`, `git show`, `git diff`, `git blame`, `git status`,
`git grep`, `git ls-files`, `git rev-parse`, `ls`, `wc`, `file`, `tree`.

Permissions are a guard rail, not a sandbox. Shell patterns match command text, so wrappers
can bypass them. The prompts state the same rules. Two platform caveats:

- In opencode 1.x, "Allow always" on a prompt lasts for the whole opencode process and applies
  to every agent, overriding other agents' `deny` rules. Approving `git push` always for `lead`
  would let a builder push too. The plugin adds a guard (`tool.execute.before`) that applies
  each helper's own shell rules again, whatever was approved. It finds a session's agent from
  the `chat.message` and `chat.params` hooks, or asks the server for unseen sessions. Like
  opencode, it matches command text: `sh -c`, `xargs` and scripts get past it.
- Step limits are soft in opencode 1.x: after the limit the agent is told to stop, but tools
  stay available. The prompts ask helpers to stop and report when told.

## Routing

`lead` sizes every request before acting:

| Size | Signal | Action |
|---|---|---|
| Answer | Answerable from the conversation, the onboarding summary, general knowledge or a quick look at one or two files | Answer directly |
| Trivial edit | A few lines in a file `lead` has already read; no design choice | Edit, then run the relevant check |
| Delegated | Needs reading beyond a couple of files, or a contained change | Brief one helper, or several in parallel |
| Plan-sized | Several steps, a design choice, or more than a few files | Plan first (see below), then carry it out |

Choosing a helper:

- `scout`: about ten tool calls or fewer; a precise question.
- `scout-deep`: unfamiliar code, several sources to combine, "why does X happen".
- `builder`: a well-specified change; files and checks known.
- `builder-deep`: subtle logic, numerics, concurrency, cross-module change, or `builder` failed.

Escalation on a failed or partial task: `builder` again with the gap stated exactly, then
`builder-deep`, then ask the user. Each retry's CONTEXT says what the earlier attempt changed
and why it fell short; the next builder may build on or replace that attempt. A check that
already failed before the change is not a failed task: `lead` tells the user instead of
escalating. Scouts cannot run code; when an answer needs code run, `lead` runs it or briefs a
builder to run it without changing anything.

Parallelism: at most three helpers at once. Scouts in parallel whenever their questions are
independent. Builders in parallel only when their file sets do not overlap.

## Hand-off brief

`lead` sends every helper a brief with these sections. Empty sections are left out.

```text
GOAL: the outcome in one sentence.
CONTEXT: what the helper needs from the conversation: decisions, constraints, findings.
FILES: paths to read first. For builders: the paths they may change.
DONE WHEN: numbered, checkable acceptance criteria.
CHECKS: exact commands to run.
LIMITS: what not to touch; when to stop and report instead.
```

## Reports

Helpers reply in a fixed format so `lead` can act without re-reading their work.

Scouts:

```text
ANSWER: the direct answer, at most five lines.
EVIDENCE: up to eight items, each `path:line` or URL, with what it shows.
NOTES: path to a notes file, if one was written (scout-deep only).
NOT CHECKED: what was out of reach or skipped.
```

Builders:

```text
STATUS: DONE, PARTIAL or BLOCKED.
CHANGED: one line per file: path and what changed.
CHECKS: one line per command: pass or fail, with the key failure line.
CRITERIA: each DONE WHEN item: met or not met.
ASSUMPTIONS: choices the brief left open.
NOT VERIFIED: what was not tested.
```

Reviewer:

```text
VERDICT: APPROVE or REJECT.
BLOCKERS: on REJECT only, at most three: `path:line`, the problem, the direction of a fix.
NOTES: at most three non-blocking suggestions.
CHECKED: what was examined and which commands ran.
```

The reviewer rejects only for real problems: wrong behaviour, missing acceptance criteria,
broken checks, security issues, or a plan that does not reach its goal. Style preferences are
notes, not blockers. A report may leave out NOTES when there is nothing to note, and a request
may ask for another format (as `/progress` does). When `/review` finds nothing to review, or
cannot resolve its target, the reviewer says so in a line or two instead of giving a verdict.

Commands that run a helper in a child session (`/review`, `/progress`) return its report to
the current session, and opencode 1.x then asks `lead` to continue. `lead` explains the result
and waits; it acts on a REJECT or a plan's state only when the user asks.

## Planning and execution

`/plan` and plan-sized requests:

1. `lead` asks the user about goals, scope and constraints until the intent is clear.
2. Scouts gather facts in parallel.
3. `lead` writes the plan file (format in the plan skill).
4. The reviewer checks the plan, depending on the review policy.
5. `lead` explains the plan in plain words and stops for approval.

`/go` carries out an approved plan:

1. Read the plan file; start with the first open task whose dependencies are done.
2. Brief the task's agent with the task's files, criteria and checks.
3. Check the report against the criteria; re-run cheap checks.
4. Tick the task and add a line to the plan's log.
5. Repeat until all tasks are done, a task is blocked, or three reports in a row fail.
6. Run the plan's final verification, then one review of the whole change if the policy
   calls for it. Tasks get no review of their own.

`/go` works in a fresh session because the plan file carries everything needed.

## Review policy

| Policy | Plans | Changes |
|---|---|---|
| `auto` | Reviewed before the user approves | Reviewed when beyond a trivial edit |
| `ask` | `lead` asks before each review `auto` would do | `lead` asks before each review `auto` would do |
| `always` | Reviewed | Every change reviewed |
| `never` | Not reviewed | Not reviewed |

On REJECT, the builder fixes the blockers and the reviewer checks again, at most two rounds.
After that, `lead` takes the open blockers to the user. `/review` works under every policy.

The active policy appears in the `lead` prompt as one line, `Review policy: <value>`. The
generator writes `auto`; the plugin rewrites the line from the settings file.

## Work files

All harness files in a project live under `.ecmwf-multi-agents/` at the top of the repository
(`git rev-parse --show-toplevel`), or in the current directory outside git:

| Path | Content |
|---|---|
| `plans/<slug>.md` | Plans with task checklists and a log |
| `context/onboard.md` | Onboarding summary, stamped with the commit it describes |
| `notes/<slug>.md` | Long findings from `scout-deep` |

Before writing the first file, `lead` makes sure `.ecmwf-multi-agents/` is listed in the file
that `git rev-parse --git-path info/exclude` names. The folder then never shows up in
`git status` or commits. Because search tools skip ignored files, prompts refer to work files
by exact path.

## Onboarding summary

`/onboard` sends three scouts in parallel (docs and intent; layout and the build, test and
lint commands; conventions and current direction) and, with a focus argument, one
`scout-deep` on that area. `lead` writes `context/onboard.md`:

1. Purpose
2. Architecture
3. Main data or control flow
4. Rules that constrain edits
5. How to build, test and lint
6. Current direction and open work
7. Stale or contradictory docs

The summary starts with `Commit: <hash> (<date>)`, or `Commit: none` outside git or before
the first commit. While the hash matches `HEAD` (or both have none), later sessions reuse it
instead of surveying again. A focus argument on a current summary sends only the
`scout-deep`, after any scouts, to keep within three helpers at once, and its findings are
added to the existing sections.

## Settings

`ecmwf-multi-agents.jsonc`, read at startup from up to three places, each overriding the one
before, with `agents` entries merged per agent and per field:

1. `$OPENCODE_CONFIG_DIR/ecmwf-multi-agents.jsonc`, when the variable is set (site defaults of a
   central install);
2. `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/ecmwf-multi-agents.jsonc` (the user's own);
3. `<project root>/.opencode/ecmwf-multi-agents.jsonc` (the project's).

Changes take effect when opencode restarts.

```jsonc
{
  "review": "auto",           // auto | ask | always | never
  "profile": "default",       // a profile name from src/profiles/
  "default_agent": true,      // make lead the default agent
  "agents": {                 // per-agent overrides, applied after the profile
    "reviewer": { "model": "openai/gpt-6.1-sol", "variant": "high", "steps": 40 }
  }
}
```

The generator writes a JSON Schema for this file; the plugin validates with the same patterns.
A file with unknown keys or invalid values is ignored as a whole and reported: on opencode 1.x
in the log and as a toast in the TUI; on opencode 2.0.16, whose plugin API offers neither, on
standard error only. `install.sh doctor` checks the review and profile values. There is no
setting that returns a single agent to the session model; the `inherit` profile does that for
all agents.

## Profiles

A profile maps each agent to a model and an optional variant (reasoning effort). Agents left
out of a profile use the session model. The generator bakes the `default` profile into the
agent files, so a fresh install works without the plugin. The plugin applies the chosen
profile and the per-agent overrides at startup: in opencode 1.x through the `config` hook,
which sees the Markdown agents; in opencode 2 through an agent transform registered after the
plugin is active, because transforms registered during setup run before agent files load. The
plugin registers that transform again on every `plugin.updated` event (with a timer as a
fallback for a missed first event), so it stays last after reloads.

The plugin also makes `lead` the default agent unless `default_agent` is false in the settings.
Without the plugin, opencode starts on its own `build` agent and the user switches with Tab.

## Source and output

```text
src/manifest.jsonc        agents, permissions, commands, skills, budgets
src/agents/*.md           prompt bodies; deep tiers add an addendum to the base prompt
src/commands/*.md         command templates
src/skills/<id>/SKILL.md  skill bodies
src/profiles/*.jsonc      model profiles
tools/                    generator (TypeScript on Bun)
dist/opencode-v1/         output for opencode 1.x
dist/opencode-v2/         output for opencode 2.0.16
plugin/                   runtime plugin sources
```

Source Markdown carries no frontmatter: the generator writes frontmatter from the manifest in
each platform's format. Prompts are platform neutral; they never name tools by their
platform-specific identifiers beyond what both platforms share.

An agent's prompt replaces opencode's own system prompt on both platforms. opencode still adds
the model name, an environment block, `AGENTS.md` files and the skill list. Prompts must
therefore carry the working rules they need (read before editing, follow project conventions,
verify, report honestly) instead of relying on opencode's defaults.

Command templates never use `` !`command` `` blocks, which run before any permission check,
and never use `@name` mentions. Hidden skills are loaded by exact id: opencode 1.x hides a
skill that has no description, opencode 2 one with `metadata.opencode/autoinvoke: false`.

Each platform's files go in its own directory. opencode 1.x reads opencode 2 agent files
without an error but ignores their permission rules, so the two formats must never share a
config directory. opencode 2 reads 1.x files correctly, so on a machine with both versions the
installer writes only the 1.x files.

Prompt budgets, checked by the generator at about four characters per token:

| Kind | Budget |
|---|---|
| `lead` prompt | 1,800 tokens |
| Helper prompt (base plus addendum) | 700 tokens |
| Command template | 500 tokens |
| Skill | 1,200 tokens |

Every generated agent, command and skill file carries the comment
`# managed by ecmwf-multi-agents` in its frontmatter, and the bundled plugin starts with
`// managed by ecmwf-multi-agents`. The installer only overwrites or removes files with this
marker, links into a harness checkout, and files under `ecmwf-multi-agents/`.

Output paths use only letters, digits, `.`, `_`, `-` and `/`, so the POSIX installer can read
`files.txt` line by line; `files.txt` is sorted in byte order (as `LC_ALL=C sort`). The plugin
bundle depends on the Bun version that builds it, which `package.json` pins.
