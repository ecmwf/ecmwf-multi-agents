<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

<p align="center">
  <img src="docs/assets/logo.png" alt="ecmwf-multi-agents: lead and its three helpers" width="240">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@ecmwf.int/multi-agents"><img src="https://img.shields.io/npm/v/@ecmwf.int/multi-agents.svg" alt="npm Badge"></a>
  <a href="https://github.com/ecmwf/codex/raw/refs/heads/main/ESEE"><img src="https://github.com/ecmwf/codex/raw/refs/heads/main/ESEE/foundation_badge.svg" alt="Foundation Badge"></a>
  <a href="https://github.com/ecmwf/codex/raw/refs/heads/main/Project%20Maturity"><img src="https://github.com/ecmwf/codex/raw/refs/heads/main/Project%20Maturity/emerging_badge.svg" alt="Maturity Badge"></a>
</p>

> [!IMPORTANT]
> This software is **Emerging** and subject to ECMWF's guidelines on [Software Maturity](https://github.com/ecmwf/codex/raw/refs/heads/main/Project%20Maturity).

A multi-agent harness for [opencode](https://opencode.ai), made for ECMWF scientists, analysts
and developers.

You talk to one agent, `lead`. It works out what you need, asks questions when your request is
unclear, and hands the reading, building and checking to three helpers, and to five optional
ones where a project switches them on. Each helper runs on a model and effort suited to its
job.

> [!NOTE]
> New in 0.11.0: the `inspector`, an optional helper that reviews your code for security
> weaknesses and advises, and `/harden`, which turns the findings you pick into reviewed fixes,
> one commit each. Also: `opencode plugin add` as the quickest install, and a notice when a newer
> version is available. See [`CHANGELOG.md`](CHANGELOG.md).

<p align="center">
  <img src="docs/assets/how-it-works.svg" width="920" alt="A conversation with lead: you ask for a --json option; lead asks one question, sends a scout, runs two builders in the background, answers your other question meanwhile, has the change reviewed and reports back.">
</p>

You talk to `lead`; it plans, hands work to helpers, keeps answering you while they work, and
has changes reviewed.

## The agents

| Agent | What it does | Default model and effort |
|---|---|---|
| `lead` | Talks to you, plans, hands out work, checks results, commits when asked | Claude Opus 5.5, xhigh |
| `scout` | Read-only lookups and investigations in code, docs and the web | Claude Sonnet 5.5, medium |
| `builder` | Makes one clearly specified change, from a small edit to a hard fix, and runs its checks | Claude Sonnet 5.5, high |
| `reviewer` | Independent review of plans and changes, answers APPROVE or REJECT | GPT 6.1 Sol via GH Copilot, medium |

Effort is how hard a model thinks before it answers: more effort is slower and costs more.
You can change each agent's effort, and its model, in the settings file. The reviewer uses a
different model family on purpose: it is more likely to catch mistakes the other agents share.

Only `lead` talks to you. Helpers never ask you questions and never hand work on.

### Optional helpers

Five more helpers are off until a settings file switches them on, for you or for one project:

| Agent | What it does | Default model and effort |
|---|---|---|
| `researcher` | Deep investigation of a hard question: compares options, may run experiments in a scratch folder, writes a report | Claude Opus 5.5, xhigh |
| `tester` | Tries to break code with edge cases and new tests, never fixes product code, drafts issues that `lead` files only when you approve | GPT 6.1 Sol via GH Copilot, high |
| `designer` | Interface specs, interaction flows and prototypes you open in a browser; a builder implements the agreed design | Claude Opus 5.5, high |
| `data-scientist` | Answers questions about datasets with scripts it runs, without reading the data into its context | Claude Sonnet 5.5, high |
| `inspector` | Reviews code for security weaknesses and advises, each finding with its pros and cons, for you to decide; never changes the code. Used only when you ask, or with `/harden` | GPT 6.2 Astra via GH Copilot, xhigh |

```jsonc
// .opencode/ecmwf-multi-agents.jsonc in a project
{
  "agents": {
    "tester": { "enabled": true },
    "data-scientist": { "enabled": true }
  }
}
```

You ask `lead` in plain words, as before; it hands the work to the helper that fits. `scout`,
`builder` and the reviewer can be switched off the same way (`"enabled": false`): `lead` then
does that work itself, and with the reviewer off nothing is reviewed and `/review` says so. The
optional helpers come with the plugin, which every install brings; `doctor` shows which
helpers are on.

## Commands

| Command | What it does |
|---|---|
| `/onboard [focus]` | Surveys the repository and keeps a short summary for later sessions |
| `/plan <goal>` | Asks you questions, investigates, writes a plan and waits for your approval |
| `/execute [plan]` | Carries out an approved plan: briefs a helper for each task, runs ready tasks in the background, checks every result, and stops when it needs you |
| `/review [target]` | Independent review of your uncommitted changes, a branch, a commit, a pull request or a plan |
| `/progress [plan]` | Shows progress on the current plan |
| `/harden [target]` | Hardens security, with the `inspector` on: it finds weaknesses, you pick the fixes, builder makes each and the reviewer checks it, one commit per fix on your branch, never pushed |
| `/guide [question]` | Explains how the harness works, in plain words |

`/review` replaces opencode's own review command with one that uses the independent reviewer.
A command defined in a project's `.opencode/commands/` takes precedence over these, except
`/review` and `/progress`, which the plugin answers in your session (see
[Switch it on per project](#switch-it-on-per-project) for this and the other exception).

Plans, notes and summaries live in `.ecmwf-multi-agents/` inside your project. That folder is
kept out of git through `.git/info/exclude`, where the plugin adds it when a session starts, so
nothing extra appears in your commits.

## Helpers in the background

`lead` usually waits for a helper. When it has other work meanwhile, or you may want to keep
talking, it hands off in the background and the helper's report arrives later in your
conversation. If `lead` is waiting on a helper and you want it back, press Ctrl+B to move the
hand-off to the background. If a helper is doing something you do not want, tell `lead` to
redirect it ("stay in `src/`") or to stop it: a redirected helper keeps everything it has read
and done instead of starting over. `lead` steers it with `helpers_steer`; you cannot type in a
helper's session yourself.

## Requirements

- opencode 2, tested on 2.2.6 (another 2.x version works with a warning). With opencode 1,
  upgrade first with `opencode upgrade --major`.
- Access to the models in your chosen profile. The default profile needs Anthropic and GitHub
  Copilot, connected with `opencode auth login`.

## Install

The quickest way is opencode's own plugin command:

```sh
opencode plugin add @ecmwf.int/multi-agents
```

Restart opencode. The harness is then on in every project: `lead` is the default agent, with
its helpers, commands and skills. To change models, effort or the review policy, create the
settings file described under [Settings](#settings).

Or install it with npm, which needs Node.js and a POSIX shell. The installer links the agents,
commands, skills and plugin into `~/.config/opencode/` and writes a settings file for you:

```sh
npm install -g @ecmwf.int/multi-agents
ecmwf-multi-agents
```

Use one of the two, not both: with both, opencode keeps the installed files and ignores the
plugin, and `doctor` warns about it. `ecmwf-multi-agents --project /path/to/repo` installs into
one project only.

Check your setup with `npx @ecmwf.int/multi-agents doctor`, or a project with
`npx @ecmwf.int/multi-agents doctor --project /path/to/repo`. Remove the harness with
`opencode plugin remove @ecmwf.int/multi-agents`, or with `ecmwf-multi-agents uninstall` after
the npm install.

On a shared machine such as an HPC login node, an administrator can install it once for
everyone; see "Shared machines" in [`docs/install.md`](docs/install.md), which also covers every
option and troubleshooting. To install from a checkout of this repository, see
[Contributing](#contributing).

## Update

opencode does not install updates by itself. When a newer version is available, the harness
tells you in a notice at each start, and `doctor` says so too. Then:

| How you installed it | To update |
|---|---|
| `opencode plugin add` | `opencode plugin update` |
| `npm install -g` and `ecmwf-multi-agents` | Run both commands again |
| A project's `plugins` line with a version, such as `@ecmwf.int/multi-agents@0.11.0` | Change the version in the line |
| A project's `plugins` line without a version, or with `@latest` | `opencode plugin update`, run from that project |

Restart opencode afterwards. `doctor` shows the version in use.

## Switch it on per project

A project can bring the harness without installing any file: one line in its `opencode.json`
names the npm package, and opencode fetches it.

```json
{
  "plugins": ["@ecmwf.int/multi-agents@0.11.0"]
}
```

The plugin then brings the agents, commands and skills, and makes `lead` the default agent, in
that project only. Your own agent files, commands, skills and `default_agent` still win, with
two exceptions. The plugin replaces `/review` and `/progress` after opencode has loaded the
command files, so they answer in your session; a command file of your own with either name is
not used. And the settings decide which helpers are on, the model, effort and step limit of
every harness agent, and `lead`'s review line, helper limit and helper list: an agent file of
yours with one of those names can change its other fields, but change these in the settings
file. The settings files work as below.

If the harness is also installed in `~/.config/opencode/`, that copy wins and opencode ignores
the project's line ("Duplicate plugin ID"): use one or the other. `doctor --project
/path/to/repo` checks a project switched on this way and warns about this case.

## Settings

`~/.config/opencode/ecmwf-multi-agents.jsonc` holds your settings. A project can override them
in `.opencode/ecmwf-multi-agents.jsonc`.

```jsonc
{
  // When the reviewer runs: auto, ask, always or never.
  "review": "auto",
  // Which models the agents use: default, anthropic, copilot or inherit.
  "profile": "default",
  // Helpers lead may run at once: an integer of at least 1, default 4.
  "max_helper_slots": 4,
  // How lead writes for you: plain (short sentences, steps as numbered commands) or off.
  "writing_guidance": "plain",
  // Optional per-agent overrides, applied after the profile: enabled (helpers only), model,
  // effort, fallback and steps.
  "agents": {
    "builder": { "effort": "xhigh" },
    "reviewer": { "model": "openai/gpt-6.1-sol", "effort": "high", "fallback": ["anthropic/claude-opus-5-5"] },
    "tester": { "enabled": true }
  }
}
```

`enabled` switches a helper on or off; a project's file can switch on a helper your own file
leaves off, or the other way round. `lead` is always on.

Effort values are `low`, `medium`, `high`, `xhigh` and `max` (some models also offer `none`).
The defaults are `lead` xhigh, `builder` high, `scout` and `reviewer` medium. An effort needs a
model to apply to, so with the `inherit` profile give the agent a `model` as well. `steps`
caps how many turns an agent may take, which limits its cost.

`fallback` lists other models, in order, for when an agent's `model` is not set up in opencode:
each is `"provider/model"` or `{ "model": "provider/model", "effort": "high" }`. The plugin uses
the first one opencode lists as available, at startup and whenever providers change, and shows
a notice when it does. It does not switch on rate limits or outages during a run.

| Review policy | Effect |
|---|---|
| `auto` | Reviews plans before you approve them, and changes beyond trivial ones |
| `ask` | `lead` asks you before each review |
| `always` | Reviews every plan and every change |
| `never` | Reviews only when you ask, for example with `/review` |

| Profile | Models |
|---|---|
| `default` | Anthropic for `lead`, `scout` and `builder`; GitHub Copilot GPT for the reviewer, the tester and the inspector, or Claude Opus where GitHub Copilot is not set up |
| `anthropic` | Anthropic models only |
| `copilot` | GitHub Copilot models only |
| `inherit` | Every agent uses the model you pick in the session |

`max_helper_slots` is how many helpers `lead` may run at once, including during `/execute`
and `/onboard`: the plugin refuses a hand-off beyond it until a helper has finished. More
slots can run more builders, databases, dev servers and builds on the same machine, so raise
it with care. `doctor` shows the setting and the helper limit in the loaded lead's
instructions.

Settings are applied by a small plugin that ships with the harness, when opencode starts:
restart opencode after a change. A settings file with a mistake is ignored, and opencode shows
why in a warning. If the plugin cannot load, installed agents still work with the default
settings.

## Safety

- Agents commit only when you ask. Pushing, opening a pull request, merging and filing an
  issue always ask for your approval first. Answer such prompts with "Allow once".
- Helpers cannot commit, push or rewrite git history. The researcher, designer, data
  scientist and inspector write only their own folders in `.ecmwf-multi-agents/`; the tester
  changes only tests, and `lead` checks what each of them changed.
- The harness never asks for, prints or stores credentials.

## Contributing

To install from a checkout of this repository, build it, run the tests and the evals, or
release, see [`CONTRIBUTING.md`](CONTRIBUTING.md). The design is in [`DESIGN.md`](DESIGN.md),
and the rules for people and agents working on this repository are in
[`AGENTS.md`](AGENTS.md). Open work, proposals and questions are
[GitHub issues](https://github.com/ecmwf/ecmwf-multi-agents/issues).

## Licence

Apache-2.0. See `LICENSE`.
