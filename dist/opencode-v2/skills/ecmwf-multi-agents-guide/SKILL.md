---
# managed by ecmwf-multi-agents
name: ecmwf-multi-agents-guide
description: "User guide to the ecmwf-multi-agents harness: agents, commands, plans, review policy, settings and profiles. Use when the user asks how the harness works."
metadata:
  opencode/autoinvoke: "false"
---

# ecmwf-multi-agents guide

Answer the user's questions about the harness from this guide, which speaks to the user. Answer only what was asked, in plain words.

## The idea

You talk to one agent, `lead`. It works out what you need, asks when something is unclear, plans bigger work and hands reading, building and checking to helpers. Helpers work from a written brief, return a short report and never ask you anything, so `lead` keeps its memory for your conversation.

## The agents

- `lead`: talks to you, plans, hands out work, checks results, commits when asked.
- `scout`: read-only lookups and investigations in code, docs and the web.
- `builder`: makes one clearly specified change and runs its checks.
- `reviewer`: independent APPROVE or REJECT on plans and changes.

`lead` runs on the strongest model with the most effort, `scout` and `builder` on cheaper ones, so sessions cost less. Where the profile allows, the reviewer uses a different model family, to catch mistakes the others share.

## Commands and typical use

- New repository: start with `/onboard` (`/onboard <focus>` looks closer at one area). `lead` surveys the code and keeps a short summary for later sessions.
- A question or a small change: just ask.
- Bigger work: `/plan <goal>`. `lead` asks questions, investigates, writes a plan and waits. Approve it or ask for changes, then run `/execute`, ideally in a fresh session: the plan file holds everything needed. `/execute` runs ready tasks, several at once in the background, ticks each as its report arrives, and stops when it needs you; you can talk to `lead` meanwhile.
- `/progress [plan]`: how far the current plan has got.
- `/review [target]`: independent review, under any policy, of your uncommitted changes (no target), a branch, a pull request (number or URL) or a plan file. It replaces opencode's own `/review`.
- `/guide [question]`: this guide.

A project's own command or agent with the same name, such as its own `/onboard`, takes precedence in that project, except `/review` and `/progress`. The settings, not an agent file, decide a harness agent's model, effort and steps, and the review policy.

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
    "builder": { "effort": "xhigh" },
    "reviewer": { "model": "provider/model-name", "steps": 40 }
  }
}
```

Each agent takes `model`, `effort` and `steps`. Effort is how hard a model thinks: more effort is slower and costs more. Values: `low`, `medium`, `high`, `xhigh`, `max`; some models also `none`. Defaults: `lead` xhigh, `builder` high, `scout` and reviewer medium. Effort needs a model, so under `inherit` set `model` too. `steps` caps an agent's turns, which limits cost.

Profiles give each agent a model and an effort:

- `default`: Anthropic for `lead`, `scout` and `builder`; GitHub Copilot for the reviewer. Needs both connected.
- `anthropic`: Anthropic only; the reviewer uses the strongest model.
- `copilot`: GitHub Copilot only.
- `inherit`: every agent uses the model you pick in the session.

## Helpers in the background

`lead` usually waits for a helper. When it has other work meanwhile, or you may want to keep talking, it hands off in the background and the report arrives later in your conversation.

If a helper is doing something you do not want, tell `lead`: "redirect the scout: stay in src/" or "stop the builder". `lead` can list its helpers, send one an amendment it reads at its next step, keeping what it has read, or stop one. You cannot type in a helper's session yourself. A stopped helper reports nothing; its changes stay on disk.

## Work files

Plans, scout notes and the onboarding summary live in `.ecmwf-multi-agents/` at the top of the repository, kept out of git by `.git/info/exclude`.

## Safety

- Agents commit only when you ask.
- Pushing, opening or merging a pull request, rewriting history and discarding changes always ask for your approval.
- Helpers cannot commit, push or rewrite history. Scouts write only their notes; the reviewer changes no files.
- The harness never asks for credentials. Never paste passwords or tokens into the chat.

## Troubleshooting

- Run `./install.sh doctor` in the harness checkout (the folder you cloned) to check versions, installed files, settings and models. Invalid settings are ignored until fixed; doctor shows why.
- A model is missing: connect its provider with `opencode auth login`, or pick another profile, then restart opencode.
- opencode starts on `build`, not `lead`: the plugin did not load, `default_agent` is false, or your opencode config names another default agent. Switch with `/agents`. Without the plugin the agents work with default settings.
- To update, run `git pull` in the checkout and restart opencode.
