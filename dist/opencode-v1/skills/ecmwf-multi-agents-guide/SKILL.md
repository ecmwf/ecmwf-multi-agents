---
# managed by ecmwf-multi-agents
name: ecmwf-multi-agents-guide
---

# ecmwf-multi-agents guide

Answer the user's questions about the harness from this guide, which speaks to the user. Answer only what was asked, in plain words.

## The idea

You talk to one agent, `lead`. It works out what you need, asks when something is unclear, plans bigger work and hands reading, building and checking to helpers. Helpers work from a written brief, return a short report and never ask you anything. Routine work goes to cheaper models, so sessions cost less and `lead` keeps its memory for your conversation.

## The agents

- `lead`: talks to you, plans, hands out work, checks results, commits when asked.
- `scout`: quick read-only lookups in code, docs and the web.
- `scout-deep`: longer investigations; writes long findings to a notes file.
- `builder`: makes one clearly specified change and runs its checks.
- `builder-deep`: hard changes: subtle logic, numerics, concurrency, several modules.
- `reviewer`: independent APPROVE or REJECT on plans and changes.

`lead` and `builder-deep` use stronger models, scouts and `builder` cheaper ones. Where the profile allows, the reviewer runs on a different family of model, to catch mistakes the others share.

## Commands and typical use

- New repository: start with `/onboard` (`/onboard <focus>` looks closer at one area). `lead` surveys the code and keeps a short summary for later sessions.
- A question or a small change: just ask.
- Bigger work: `/plan <goal>`. `lead` asks questions, investigates, writes a plan (reviewed if the policy says so) and waits. Approve it or ask for changes, then run `/go`, ideally in a fresh session: the plan file holds everything needed. `/go` works task by task, checks each one, and stops if a task is blocked.
- `/progress [plan]`: how far the current plan has got.
- `/review [target]`: independent review at any time, under any policy, of your uncommitted changes (no target), a branch, a pull request (number or URL) or a plan file. It replaces opencode's own `/review`.
- `/guide [question]`: this guide.

A project's own command or agent with the same name, such as its own `/onboard`, takes precedence in that project.

## Review policy

- `auto` (default): reviews plans before you approve them, and changes beyond trivial edits.
- `ask`: `lead` asks you before each review.
- `always`: reviews every plan and every change.
- `never`: reviews only when you ask, for example with `/review`.

After a REJECT the problems are fixed and checked again, at most twice; then `lead` brings what is left to you.

## Settings

Settings live in `~/.config/opencode/ecmwf-multi-agents.jsonc`. A project can override them in `.opencode/ecmwf-multi-agents.jsonc`. Restart opencode after a change.

```jsonc
{
  "review": "auto", // auto, ask, always or never
  "profile": "default", // default, anthropic, copilot or inherit
  "default_agent": true, // start opencode on lead
  "agents": { // per-agent overrides, after the profile
    "reviewer": { "model": "provider/model-name", "variant": "high", "steps": 40 }
  }
}
```

`variant` is the reasoning effort; `steps` caps an agent's turns, which limits cost.

Profiles choose the models:

- `default`: Anthropic for `lead`, scouts and builders; GitHub Copilot for the reviewer. Needs both connected.
- `anthropic`: Anthropic only; the reviewer uses the strongest model.
- `copilot`: GitHub Copilot only.
- `inherit`: every agent uses the model you pick in the session.

## Work files

Plans, investigation notes and the onboarding summary live in `.ecmwf-multi-agents/` at the top of the repository. The folder is listed in `.git/info/exclude`, so it stays out of git.

## Safety

- Agents commit only when you ask.
- Pushing, opening or merging a pull request, rewriting history and discarding changes always ask for your approval. Answer "Allow once": in opencode 1.x, "Allow always" lasts until restart and applies to every agent.
- Helpers cannot commit, push or rewrite history. Scouts cannot change files (`scout-deep` writes only its notes); the reviewer has no edit tool.
- The harness never asks for credentials. Never paste passwords or tokens into the chat.

## Troubleshooting

- Run `./install.sh doctor` in the harness checkout (the folder you cloned). It checks versions, installed files, settings and models. Invalid settings are ignored until fixed; doctor shows why.
- A model is missing: connect its provider with `opencode auth login`, or pick another profile, then restart opencode.
- opencode starts on `build`, not `lead`: the plugin did not load, `default_agent` is false, or your opencode config names another default agent. Switch with `/agents`. Without the plugin the agents still work, with default settings.
- To update, run `git pull` in the checkout and restart opencode.
