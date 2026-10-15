<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# ecmwf-multi-agents

A multi-agent harness for [opencode](https://opencode.ai), made for ECMWF scientists, analysts
and developers.

You talk to one agent, `lead`. It works out what you need, asks questions when your request is
unclear, and hands the reading, building and checking to three helpers. Each helper runs on a
model and effort suited to its job, so routine work goes to cheaper models and `lead` keeps a
small context for the conversation with you.

> Status: early releases (0.x). See `CHANGELOG.md` for what changed and `PLAN.md` for what
> comes next.

## The agents

| Agent | What it does | Default model and effort |
|---|---|---|
| `lead` | Talks to you, plans, hands out work, checks results, commits when asked | Claude Opus 5.5, xhigh |
| `scout` | Read-only lookups and investigations in code, docs and the web | Claude Sonnet 5.5, medium |
| `builder` | Makes one clearly specified change, from a small edit to a hard fix, and runs its checks | Claude Sonnet 5.5, high |
| `reviewer` | Independent review of plans and changes, answers APPROVE or REJECT | GPT 6.1 Sol through GitHub Copilot, medium |

Effort is how hard a model thinks before it answers: more effort is slower and costs more.
You can change each agent's effort, and its model, in the settings file. The reviewer uses a
different model family on purpose: it is more likely to catch mistakes the other agents share.

```mermaid
flowchart LR
  U((You)) <--> L[lead]
  L -->|look up| S[scout]
  L -->|change| B[builder]
  L -->|check| R[reviewer]
  S -.->|findings| L
  B -.->|report| L
  R -.->|verdict| L
```

Only `lead` talks to you. Helpers never ask you questions and never hand work on.

## Commands

| Command | What it does |
|---|---|
| `/onboard [focus]` | Surveys the repository and keeps a short summary for later sessions |
| `/plan <goal>` | Asks you questions, investigates, writes a plan and waits for your approval |
| `/execute [plan]` | Carries out an approved plan: briefs a helper for each task, runs ready tasks in the background, checks every result, and stops when it needs you |
| `/review [target]` | Independent review of your uncommitted changes, a branch, a commit, a pull request or a plan |
| `/progress [plan]` | Shows progress on the current plan |
| `/guide [question]` | Explains how the harness works, in plain words |

`/review` replaces opencode's own review command with one that uses the independent reviewer.
A command defined in a project's `.opencode/commands/` takes precedence over these, except
`/review` and `/progress`, which the plugin answers in your session (see
[Switch it on per project](#switch-it-on-per-project) for this and the other exception).

Plans, notes and summaries live in `.ecmwf-multi-agents/` inside your project. That folder is
kept out of git through `.git/info/exclude`, so nothing extra appears in your commits.

## Helpers in the background

`lead` usually waits for a helper. When it has other work meanwhile, or you may want to keep
talking, it hands off in the background and the helper's report arrives later in your
conversation. If `lead` is waiting on a helper and you want it back, press Ctrl+B to move the
hand-off to the background. If a helper is doing something you do not want, tell `lead` to
redirect it ("stay in `src/`") or to stop it: a redirected helper keeps everything it has read
and done instead of starting over. `lead` steers it with `helpers_steer`; you cannot type in a helper's
session yourself.

## Requirements

- opencode 2, tested on 2.0.29 (another 2.x version works with a warning). With opencode 1,
  upgrade first with `opencode upgrade --major`.
- Access to the models in your chosen profile. The default profile needs Anthropic and GitHub
  Copilot, connected with `opencode auth login`.
- A POSIX shell for the installer.

## Install

Clone this repository anywhere, then run the installer:

```sh
git clone https://github.com/ecmwf/ecmwf-multi-agents.git ~/.local/share/ecmwf-multi-agents
cd ~/.local/share/ecmwf-multi-agents
./install.sh
```

To stay on a release, check out its tag (for example `git checkout 0.1.0`) before running the
installer. Versions are `MAJOR.MINOR.MICRO` without a `v`.

The installer finds your opencode version, links the agents, commands, skills and plugin into
`~/.config/opencode/`, and writes a settings file. Restart opencode afterwards. To update, run
`git pull` and `./install.sh` again, then restart opencode. It never overwrites files it did
not create.

Or install it with npm, which needs Node.js:

```sh
npm install -g @ecmwf.int/multi-agents
ecmwf-multi-agents
```

`ecmwf-multi-agents` runs the same installer from the package folder, with the same commands
and options: where this README says `./install.sh`, type `ecmwf-multi-agents`. To update, run
both commands again, then restart opencode.

For one project only, `./install.sh --project /path/to/repo` copies the files into that
project's `.opencode/` folder.

On a shared machine such as an HPC login node, an administrator can install it once for
everyone with `./install.sh --central DIR`; each user loads a module that sets
`OPENCODE_CONFIG=DIR/opencode.json` and runs `./install.sh central-enable DIR` once. See
"Shared machines" in `docs/install.md`.

Check an installation with `./install.sh doctor`, and a project with
`./install.sh doctor --project /path/to/repo`. Remove an installation with
`./install.sh uninstall`. `docs/install.md` covers every option, updating and troubleshooting.

## Switch it on per project

A project can bring the harness without installing any file: one line in its `opencode.json`
names the npm package with a pinned version, and opencode fetches it.

```json
{
  "plugins": ["@ecmwf.int/multi-agents@0.6.0"]
}
```

Or name a checkout of this repository instead (`{env:HOME}` is your home folder; `~` does not
work here):

```json
{
  "plugins": ["{env:HOME}/.local/share/ecmwf-multi-agents"]
}
```

The plugin then brings the agents, commands and skills, and makes `lead` the default agent, in
that project only. Your own agent files, commands, skills and `default_agent` still win, with
two exceptions. The plugin replaces `/review` and `/progress` after opencode has loaded the
command files, so they answer in your session; a command file of your own with either name is
not used. And the settings decide the model, effort and step limit of `lead`, `scout`, `builder`
and `reviewer`, and `lead`'s review line: an agent file of yours with one of those names can
change its other fields, but change these in the settings file. The settings files work as
below. To update, change the version in the line (or `git pull` the
checkout) and restart opencode; an entry without a version is updated only by
`opencode plugin update`.

If the harness is also installed in `~/.config/opencode/`, that copy wins and opencode ignores
the project's line ("Duplicate plugin ID"): use one or the other. `./install.sh doctor
--project /path/to/repo` checks a project switched on this way and warns about this case.

## Settings

`~/.config/opencode/ecmwf-multi-agents.jsonc` holds your settings. A project can override them
in `.opencode/ecmwf-multi-agents.jsonc`.

```jsonc
{
  // When the reviewer runs: auto, ask, always or never.
  "review": "auto",
  // Which models the agents use: default, anthropic, copilot or inherit.
  "profile": "default",
  // Optional per-agent overrides, applied after the profile: model, effort and steps.
  "agents": {
    "builder": { "effort": "xhigh" },
    "reviewer": { "model": "openai/gpt-6.1-sol", "effort": "high" }
  }
}
```

Effort values are `low`, `medium`, `high`, `xhigh` and `max` (some models also offer `none`).
The defaults are `lead` xhigh, `builder` high, `scout` and `reviewer` medium. An effort needs a
model to apply to, so with the `inherit` profile give the agent a `model` as well. `steps`
caps how many turns an agent may take, which limits its cost.

| Review policy | Effect |
|---|---|
| `auto` | Reviews plans before you approve them, and changes beyond trivial ones |
| `ask` | `lead` asks you before each review |
| `always` | Reviews every plan and every change |
| `never` | Reviews only when you ask, for example with `/review` |

| Profile | Models |
|---|---|
| `default` | Anthropic for `lead`, `scout` and `builder`; GitHub Copilot GPT for the reviewer |
| `anthropic` | Anthropic models only |
| `copilot` | GitHub Copilot models only |
| `inherit` | Every agent uses the model you pick in the session |

Settings are applied by a small plugin that ships with the harness, when opencode starts:
restart opencode after a change. A settings file with a mistake is ignored, and opencode shows
why in a warning. If the plugin cannot load, installed agents still work with the default
settings.

## Safety

- Agents commit only when you ask. Pushing, opening a pull request and merging always ask for
  your approval first. Answer such prompts with "Allow once".
- Helpers cannot commit, push or rewrite git history.
- The harness never asks for, prints or stores credentials.

## Development

See `AGENTS.md` for the rules and `PLAN.md` for progress. With [Bun](https://bun.sh), `reuse`
and `shellcheck` installed:

```sh
make setup      # install the development dependencies
make build      # regenerate dist/ from src/
make check      # the gate before every commit: versions, dist/, lint, unit tests
make help       # every target
```

`make integration` runs the suites against a real opencode 2 without calling a model.
`make evals` runs scenario evals with real models and uses your provider quota; see
`evals/README.md`. `make release X.Y.Z` releases a version in one step (`DRY_RUN=1` previews)
and needs npm, to check the package's files first (`make pack-check`); the tag it pushes
publishes the npm package through GitHub Actions. GitHub Actions also runs `make check` and
`make pack-check` on every push and pull request.

## Licence

Apache-2.0. See `LICENSE`.
