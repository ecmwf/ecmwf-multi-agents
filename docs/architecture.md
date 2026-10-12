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
   brief is all it knows. A later message from `lead` or the user amends the brief, and the
   helper's report still answers it: every DONE WHEN item, plus what the amendment changed.
4. Few agents, each with one job. How hard an agent thinks is a setting, its model and effort,
   not a separate agent. A failed task gets one more try with the gap stated, then goes to the
   user.
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
| `scout` | subagent | Read-only lookups and investigations in code, docs and the web, from "where is X" to "why does X happen"; long findings go to a notes file | 30 |
| `builder` | subagent | One clearly specified change, from a small edit to a hard fix, then its checks; never commits | 60 |
| `reviewer` | subagent | Independent APPROVE or REJECT on a plan or a change | 30 |

Steps cap the number of model turns a helper may take. They act as a cost limit. Each agent
also gets a model and an effort from the active profile (see Profiles), and users can change
`model`, `effort` and `steps` per agent in the settings file.

### Permissions

Rules are ordered and the last matching rule wins. opencode places agent rules after the
user's own rules, so an agent rule overrides the user's policy in both directions. The harness
therefore adds mostly `deny` rules, and only these deliberate `allow` and `ask` rules: `lead`
may ask questions and delegate to the three helpers; `lead` asks before publishing or
destructive git commands; `scout` may run a short list of read-only inspection commands and
write its notes folder; the reviewer may read pull requests. One consequence: a user who
denies `git push` globally gets an approval prompt in `lead` instead.

| Capability | lead | scout | builder | reviewer |
|---|---|---|---|---|
| Read, search | user policy | user policy | user policy | user policy |
| Edit files | user policy | only `.ecmwf-multi-agents/notes/` | user policy | deny |
| Shell | user policy, with approval for push, PR, merge and history rewrites | read-only commands only | user policy, git and `gh` writes denied | user policy, git and `gh` writes denied |
| Web fetch and search | user policy | user policy | user policy | user policy |
| Delegate | the three helpers only | deny | deny | deny |
| Ask the user | allow | deny | deny | deny |
| Harness skills (`ecmwf-multi-agents-*`) | user policy | deny | deny | deny |
| Todo list (opencode 1.x) | user policy | deny | platform default (denied) | deny |
| Code Mode (opencode 2) | user policy | deny | user policy | deny |
| Helper tools (`helpers_status`, `helpers_steer`, `helpers_cancel`) | user policy | deny | deny | deny |

The helper tools come from the plugin (see Background helpers). A `tool` rule in the manifest
names one tool id; the emitters write it as that id's own permission key, which on both
platforms removes a denied tool from the agent's requests. The plugin also refuses, at
execution time and independently of those rules, every call to these tools that does not
come from `lead`: a helper's call, whatever was approved, as the shell guard does, and any
other agent's call, because the platform's default rules would let such an agent reach a
plugin tool. Without the plugin the tools do not exist and the rules are inert.

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

Read-only commands for `scout`: `git log`, `git show`, `git diff`, `git blame`, `git status`,
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

- `scout`: any read-only question, from a precise lookup (where is X, what calls Y) to an
  investigation of unfamiliar code or several sources (why does X happen).
- `builder`: any change whose files and checks are known, from a small edit to a hard fix.
- `reviewer`: a verdict on a plan or a change, as the review policy says.

Escalation on a failed or partial task: `builder` again with the gap stated exactly, then the
user. The retry's CONTEXT says what the earlier attempt changed and why it fell short; the
builder may build on or replace that attempt. When the second attempt fails too, `lead` stops
and takes the task to the user with what was tried. The user may raise the builder's effort
in the settings file, or ask `lead` to take the task over. A scout that cannot answer is
briefed again with what it missed and a wider scope; if that fails too, `lead` asks the user.
A check that already failed before the change is not a failed task: `lead` tells the user
instead of retrying. Scouts cannot run code; when an answer needs code run, `lead` runs it or
briefs a builder to run it without changing anything.

Parallelism: at most three helpers at once. Scouts in parallel whenever their questions are
independent. Builders in parallel only when their file sets do not overlap.

## Background helpers

A hand-off normally blocks `lead` until the helper reports. Both platforms can also run a
helper in the background: the delegation tool returns at once, `lead` goes on, and when the
helper finishes the platform writes its final text into `lead`'s session as a user message
(`<task ...>` on opencode 1.x, `<subagent ...>` on opencode 2) and gives `lead` a turn. On
opencode 1.x this needs `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` in the environment
before opencode starts; the installer and `doctor` cover it, and without it `lead` hands off
in the foreground as before. The user can also move a blocking hand-off to the background
with the TUI's `session.background` keybind. Evidence and limits:
`docs/research/background-helpers.md`; decisions: `docs/adr/0002-background-helpers-and-steering.md`.

`lead` uses the background when it does not need the result before its next step and has
other work meanwhile, or when the user may want to keep talking. Each completion wakes `lead`
once, so three background scouts can cost three `lead` turns where three parallel foreground
scouts cost one; `/onboard` stays in the foreground. A wake is read like any report: `lead`
checks the DONE WHEN items and does not re-run the helper's checks twice.

Three tools from the plugin let `lead` see, redirect and stop its helpers; helpers never
have them:

| Tool | Does |
|---|---|
| `helpers_status` | The helpers of this session: agent, title, state, steps taken, elapsed time, last tool call. At most twelve lines |
| `helpers_steer(id, text)` | Sends an amendment to a running helper. The text reaches it at its next step; its context and prompt cache stay. A finished helper is continued through the delegation tool's continuation parameter instead |
| `helpers_cancel(id or all)` | Stops a helper and says so in the result (opencode 1.x does not wake `lead` for a cancel) |

A steer amends the brief (principle 3): the helper follows the latest message, keeps the
earlier LIMITS unless the steer lifts them, and reports what changed in the section its
report has for it (ASSUMPTIONS for the builder, ANSWER for a scout, CHECKED for the reviewer). A
steer is never an approval and never changes permissions. `lead` steers when the helper's
reading so far is still useful and the correction is small; it cancels and briefs again when
the direction was wrong. It steers reactively, when the user asks or when a status check it
ran for a reason shows a helper off its brief; it never polls, because each status call and
each steer is a turn of the most expensive agent. `lead` reaches a running helper only through
`helpers_steer`, never through `task_id` or `sessionID` on the delegation tool. On opencode
1.x a helper's step limit counts the whole run, steers included.

The user may also open a helper's session and type into it. On opencode 1.x a message sent
to a running session carries an agent and a model, and the TUI sends the user's primary agent,
`lead`; the plugin therefore pins every message that lands in a helper's child session to that
helper's own agent, model and effort. It never touches the user's own session, where `/review`
and `/progress` answer inline on 1.x. A completion that lands there while a helper is
answering reaches `lead` on its next turn, not as a wake.

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

Scout:

```text
ANSWER: the direct answer, at most five lines.
EVIDENCE: up to eight items, each `path:line` or URL, with what it shows.
NOTES: path to a notes file, if one was written.
NOT CHECKED: what was out of reach or skipped.
```

When findings do not fit this format, the scout writes them to
`.ecmwf-multi-agents/notes/<slug>.md`, starting with the question and the commit it looked at,
keeps ANSWER short and gives the path under NOTES.

Builder:

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

A background helper's report arrives wrapped by the platform (`<task id="..."
state="completed">` with the report inside on opencode 1.x, `<subagent ...>` on opencode 2;
`state="error"` or `state="cancelled"` when it did not finish). `lead` reads the inside as the
helper's report.

The reviewer rejects only for real problems: wrong behaviour, missing acceptance criteria,
broken checks, security issues, or a plan that does not reach its goal. Style preferences are
notes, not blockers. A report may leave out NOTES when there is nothing to note, and a request
may ask for another format (as `/progress` does). When `/review` finds nothing to review, or
cannot resolve its target, the reviewer says so in a line or two instead of giving a verdict.

`/review` and `/progress` are the two commands the user sends straight to a helper. How they run
differs by platform:

- On opencode 1.x the helper answers in the user's own session, as the command's agent
  (`subtask: false`). Its report appears in the conversation, and `lead` takes no turn after
  it. The user stays with `lead`: the TUI offers only primary agents and keeps its selection,
  so the next message goes to `lead`, which sees the report in the conversation. The plugin
  drops the earlier conversation from the helper's model requests
  (`experimental.chat.messages.transform`), so the helper works from the command alone, as in a
  child session: the reviewer stays independent of `lead`'s reasoning, and a long session does
  not make a review costly. The stored conversation is unchanged, compaction is never trimmed,
  and without the plugin the helper sees the whole conversation.
- On opencode 2.0.16 a command for a helper runs in a child session. Running it in the user's
  session would first switch the whole session to the helper, so the user's next message would
  go to the helper. When the child finishes, opencode wakes `lead` with the report; `lead`
  relays it briefly, without re-running its checks.

Either way, `lead` acts on a REJECT or on a plan's state only when the user asks.

## Planning and execution

`/plan` and plan-sized requests:

1. `lead` asks the user about goals, scope and constraints until the intent is clear.
2. Scouts gather facts in parallel.
3. `lead` writes the plan file (format in the plan skill).
4. The reviewer checks the plan, depending on the review policy.
5. `lead` explains the plan in plain words and stops for approval.

`/go` carries out an approved plan:

1. Read the plan file; start with the first open task whose dependencies are done.
2. Brief the task's agent (`builder` or `scout`) with the task's files, criteria and checks.
3. Check the report against the criteria; re-run cheap checks.
4. On success, tick the task and add a line to the plan's log. On failure, log it and brief
   the same agent again with the gap stated exactly.
5. Repeat until all tasks are done, a task is blocked or fails twice, or three reports in a
   row fail.
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
| `notes/<slug>.md` | Long findings from `scout` |

Before writing the first file, `lead` makes sure `.ecmwf-multi-agents/` is listed in the file
that `git rev-parse --git-path info/exclude` names. The folder then never shows up in
`git status` or commits. Because search tools skip ignored files, prompts refer to work files
by exact path.

## Onboarding summary

`/onboard` sends three scouts in parallel (docs and intent; layout and the build, test and
lint commands; conventions and current direction). With a focus argument, one more scout
studies that area in depth after the others have finished, to keep within three helpers at
once. `lead` writes `context/onboard.md`:

1. Purpose
2. Architecture
3. Main data or control flow
4. Rules that constrain edits
5. How to build, test and lint
6. Current direction and open work
7. Stale or contradictory docs

The summary starts with `Commit: <hash> (<date>)`, or `Commit: none` outside git or before
the first commit. While the hash matches `HEAD` (or both have none), later sessions reuse it
instead of surveying again. A focus argument on a current summary sends only the focus scout,
and its findings are added to the existing sections.

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
    "builder": { "effort": "xhigh" },
    "reviewer": { "model": "openai/gpt-6.1-sol", "effort": "high", "steps": 40 }
  }
}
```

An `agents` entry may set `model` (`provider/model`), `effort` and `steps`. An override
`model` replaces the profile's model and effort together, so the agent runs at the effort the
entry names, or at the model's own default when it names none. An override `effort` alone
applies to the profile's model. `steps` replaces the agent's step limit.

The generator writes a JSON Schema for this file; the plugin validates with the same patterns.
A file with unknown keys or invalid values is ignored as a whole and reported: on opencode 1.x
in the log and as a toast in the TUI; on opencode 2.0.16, whose plugin API offers neither, on
standard error only. `install.sh doctor` checks the review and profile values. There is no
setting that returns a single agent to the session model; the `inherit` profile does that for
all agents.

## Profiles

A profile gives every agent a model and an effort, except `inherit`, which gives none, so
every agent uses the model chosen in the session. Effort is how hard the model thinks before
it answers: `low`, `medium`, `high`, `xhigh` or `max`, and on some models `none`. More effort
is slower and costs more. opencode calls it the model's variant, and the generator and the
plugin write it under that name.

| Profile | `lead` | `scout` | `builder` | `reviewer` |
|---|---|---|---|---|
| `default` | Claude Opus 5.5, xhigh | Claude Sonnet 5.5, medium | Claude Sonnet 5.5, high | GPT 6.1 Sol through GitHub Copilot, medium |
| `anthropic` | Claude Opus 5.5, xhigh | Claude Sonnet 5.5, medium | Claude Sonnet 5.5, high | Claude Opus 5.5, high |
| `copilot` | Claude Opus 5.5, xhigh | Claude Sonnet 5.5, medium | Claude Sonnet 5.5, high | GPT 6.1 Sol, medium |
| `inherit` | session model | session model | session model | session model |

`lead` runs on the strongest model with the most effort, `scout` and `builder` on cheaper
ones. The reviewer runs on a different model family, to catch mistakes the others share,
except in `anthropic`, which has no other family and gives it the strongest model instead.
`copilot` reaches every model through GitHub Copilot.

Per-agent overrides from the settings file apply after the profile. An effort applies only
while the agent has a model, from the profile or from the same settings entry, so under
`inherit` an effort alone has no effect; the plugin reports it and leaves it out.

The generator bakes the `default` profile into the agent files, so a fresh install works
without the plugin. The plugin applies the chosen profile and the per-agent overrides at
startup: in opencode 1.x through the `config` hook, which sees the Markdown agents; in
opencode 2 through an agent transform registered after the plugin is active, because
transforms registered during setup run before agent files load. The plugin registers that
transform again on every `plugin.updated` event (with a timer as a fallback for a missed first
event), so it stays last after reloads.

The plugin also makes `lead` the default agent unless `default_agent` is false in the settings.
Without the plugin, opencode starts on its own `build` agent and the user switches with Tab.

## Source and output

```text
VERSION                   the harness version
src/manifest.jsonc        agents, permissions, commands, skills, budgets
src/agents/*.md           agent prompt bodies
src/commands/*.md         command templates
src/skills/<id>/SKILL.md  skill bodies
src/profiles/*.jsonc      model profiles
tools/                    generator (TypeScript on Bun)
dist/opencode-v1/         output for opencode 1.x
dist/opencode-v2/         output for opencode 2.0.16
plugin/                   runtime plugin sources
```

The harness version comes from the root `VERSION` file: one line, `x.y.z`, without a `v`. The
generator reads it from there.

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
| `lead` prompt | 2,050 tokens |
| Helper prompt | 750 tokens |
| Command template | 500 tokens |
| Skill | 1,450 tokens |

A budget is a ceiling, not a target. It is raised only to the measured size of a change,
rounded up to the next 50, and the manifest records why; the evals then show what the
change costs per request.

Every generated agent, command and skill file carries the comment
`# managed by ecmwf-multi-agents` in its frontmatter, and the bundled plugin starts with
`// managed by ecmwf-multi-agents`. The installer only overwrites or removes files with this
marker, links into a harness checkout, and files under `ecmwf-multi-agents/`.

Output paths use only letters, digits, `.`, `_`, `-` and `/`, so the POSIX installer can read
`files.txt` line by line; `files.txt` is sorted in byte order (as `LC_ALL=C sort`). The plugin
bundle depends on the Bun version that builds it, which `package.json` pins.
