<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# 0002. Background helpers, steering and cancel

Status: accepted. Date: 2026-10-12.

## Context

Every hand-off blocks `lead` today: it calls the delegation tool and waits, sees nothing of
the helper's work, and can stop nothing. The user who sees a helper go wrong can only wait
for it to finish. Both platforms now offer what is needed: a background mode on the
delegation tool, a completion that wakes the parent, a way to send a message to a running
child that reaches its model at the next step boundary, a cancel, and a way for the user to
move a blocking hand-off to the background. The evidence is in
`docs/research/background-helpers.md`; the plan is Phase 7 in `PLAN.md`.

Two platform facts shape the decisions. On opencode 1.x the agent and model of a run come
from the latest user message, so a message to a running helper that names no agent switches
the rest of its run, and the 1.x TUI sends `lead` when the user types into a helper's
session. And on 1.x a cancelled background job tells the parent nothing, while a completed
one wakes it.

## Decisions

### Build on the platforms' own mechanisms

The harness uses the delegation tool's background mode, the platform's completion wake and
its session API. The plugin adds no job registry, poller, queue or wake of its own: the
problem of waking the parent safely belongs inside the session loop, where opencode solves
it. What the plugin adds is small and keeps no job registry: three tools, two in-memory records
of what the hooks and events showed (tool calls per session, and on opencode 2 the sessions the
event stream announced), and one message rewrite.

### Three tools for `lead`

| Tool | Does | 1.x | 2.0.16 |
|---|---|---|---|
| `helpers_status` | Lists the helpers of this session: agent, title, state, steps taken, elapsed time, last tool call. At most twelve lines | `session.children` and `session.status`; steps and last call from the plugin's tool hook | The sessions the event stream announced (`session.created`, `session.execution.*`); steps and last call from the tool hook. The plugin context offers no session list and no messages |
| `helpers_steer(id, text)` | Sends an amendment to a running helper, keeping its context. A finished helper is continued through the delegation tool's continuation parameter instead | `session.prompt_async` naming the helper's agent; opencode fills in that agent's model and effort | `session.prompt` with `delivery: "steer"` |
| `helpers_cancel(id or all)` | Stops a helper and says so in its result | `session.abort` | `interrupt` |

A target must be a helper child of the caller's session; anything else is refused. The tools
are registered as direct tools (on 2.0.16 with `codemode: false`), allowed to `lead` only:
every helper's agent file denies them (`<tool> * deny`, which removes the tool from the
helper's requests on both platforms), and the plugin's `execute.before` guard refuses, on
its own and independently of those rules, every call to the tools that does not come from
`lead`: a helper's call, whatever was approved, as the shell guard does, and any other
agent's call, since the platform's default rules would let such an agent reach a plugin
tool. Tool ids clash with nothing on the three versions.

`lead` reaches a running helper only through `helpers_steer`. It never passes `task_id` or
`sessionID` to the delegation tool: on 1.x that would chain the text after the run instead of
redirecting it, and on both it would bypass the guard and the agent pinning.

### A steer amends the brief

The brief stays the contract (architecture principle 3). A steer is an amendment: the helper
follows the latest message, keeps the earlier LIMITS unless the steer lifts them, and its
report still answers every DONE WHEN item and says what the steer changed and what was
already done before it, in the section its report format has for it: ASSUMPTIONS for the
builder, ANSWER for a scout, CHECKED for the reviewer. A steer is never an approval for a pending permission
request and never changes a helper's permissions.

### When `lead` steers, cancels or uses the background

- Steer when the helper's reading so far is still useful and the correction is small. Cancel
  and brief again when the direction was wrong from the start.
- `lead` steers reactively: when the user asks, or when `helpers_status`, run because the user
  asked or because `lead` is about to steer, shows a helper off its brief. `lead` never polls;
  each status call and each steer is a turn of the most expensive agent.
- Background is for hand-offs `lead` does not need the result of before its next step, when it
  has other work meanwhile or the user may want to keep talking. Each completion wakes `lead`
  once, so three background scouts cost up to three `lead` turns where three parallel
  foreground scouts cost one; `/onboard` stays foreground.
- On 1.x the step limit counts the whole run, so a steer near the limit ends with "stop and
  report".

### The 1.x pinning

On 1.x the plugin's `chat.message` hook rewrites the `agent`, `model` and `variant` of a
message that lands in a helper's child session to that helper's own, so a user who opens a
running helper's session and types steers it instead of moving the rest of its run to `lead`.
The hook never touches the user's own session: `/review` and `/progress` run there on purpose,
and the next message there belongs to `lead`. On 2.0.16 the session owns its agent and no
pinning is needed.

### Cancel and wake gaps on 1.x

`helpers_cancel` reports the cancel in its own result, because the platform does not wake
the parent for a cancelled job; a helper the user cancelled shows in `helpers_status`. A
completion that lands while a helper answers inline in the user's session (`/review` on 1.x)
is read by that helper and reaches `lead` on its next turn, not as a wake; the `lead` prompt
says so.

### The 1.x flag

Background mode on 1.x needs `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` in the
environment of the opencode process; a plugin cannot set it. The installer prints the line to
add to the shell profile or module file, `doctor` checks it, and `docs/install.md` explains it.
Without the flag the parameter is absent from the tool and a call with it fails, so the `lead`
prompt reads correctly either way and `lead` falls back to foreground hand-offs.

### Budgets

The new rules do not fit the present budgets (`lead` is at 1,792 of 1,800 tokens). The
budgets are raised with the prompt changes, by the measured size of the additions.

## Consequences

- `src/manifest.jsonc`: a `tool` rule per tool id on every helper. The generator writes the
  rule as the platform's permission key for that id (`tools/load.ts` validates the id,
  `tools/emit-v1.ts` and `tools/emit-v2.ts` write it); a unit test holds the manifest's ids
  equal to the plugin's.
- `plugin/`: the tools, the guard rule, the 1.x pinning, and unit tests; the opt-in suite
  `plugin/background.integration.test.ts` pins the platform mechanics and grows the tool
  scenarios.
- `src/agents/*.md`: the rules above, in plain words, within raised budgets.
- `install.sh`, `docs/install.md`, `/guide`, `README.md`: the flag, the user's path (open the
  helper's session and type, the promote keybind, "ask `lead` to redirect or stop it").
- `docs/architecture.md`: principle 3 amended, the tools in the permission table, the routing
  rules, the wake as a report form.
- Evals measure what a wake and a steer cost against cancel-and-restart before the release.
