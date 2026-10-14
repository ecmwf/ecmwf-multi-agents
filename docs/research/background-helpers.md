<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Background helpers, steering and cancel

This note answers the questions that background helpers, steering a running helper and
cancelling one depend on, for opencode 1.18.35, 1.19.0 and 2.0.16. Each section gives the
answer first and the evidence after it. The last section lists what the design takes from
each finding; the decisions themselves are in `docs/adr/0002-background-helpers-and-steering.md`.

## Method

Source: the `anomalyco/opencode` repository at tags `v1.18.35`, `v1.19.0` and `v2.0.16`.
Paths written `v1src:` are relative to `packages/` at `v1.18.35`; every cited 1.x file is
identical at `v1.19.0`. Paths written `v2src:` are relative to `packages/` at `v2.0.16`.

Runtime: `plugin/background.integration.test.ts` drives each binary through `tools/sandbox.sh`
and `opencode serve` on 127.0.0.1 with a scripted stand-in model (the OpenAI chat-completions
protocol, bundled `@ai-sdk/openai-compatible` on 1.x; the same spelling of the provider config
is normalized by 2.0.16). No hosted model was contacted. The stand-in records every request
and answers by script: `lead` delegates a slow job to the builder, the builder runs `sleep`
steps (five steps of 1.5 s in the suite, six of 2 s in the first runs quoted below) until it
finishes or a later user message tells it to stop. The suite passes on all three binaries
(twelve tests per 1.x binary and nine for 2.0.16 without the plugin, then the plugin's tools in
the same file; about two minutes per binary). The checks in sections 8 to 11 ran as one-off
scripts of the same shape; their results are quoted.

## Answers in one line

| # | Question | Answer |
|---|---|---|
| 1 | Can a hand-off return before the helper finishes? | Yes on both platforms: `task(background: true)` on 1.x behind an experimental flag, `subagent(background: true)` on 2.0.16 |
| 2 | How does `lead` learn that a background helper finished? | A synthetic user message with the helper's final text is written into `lead`'s session and starts a `lead` turn |
| 3 | Can a running helper be redirected without restarting it? | Yes: a message sent to the child session reaches its model at the next step boundary, about one tool call later; the run ends where the helper decides, nothing runs twice |
| 4 | What does the delegation tool's continuation parameter do on a running child? | 1.x `task_id`: chained after the run. 2.0.16 `sessionID`: steers the running child |
| 5 | What does a cancel do? | 1.x `session.abort`: the helper stops, `lead` is not told. 2.0.16 `interrupt`: the helper stops and `lead` wakes with `state="cancelled"` |
| 6 | Can the user unblock `lead` from a foreground hand-off? | Yes: a TUI keybind promotes the running hand-off to the background; `lead`'s blocked call returns and `lead` is woken later |
| 7 | What goes wrong when a message to a running child names no agent? | 1.x: the rest of the run switches to the message's agent and model; the 1.x TUI does this when the user types into a helper's session. 2.0.16: nothing, the session owns its agent |
| 8 | Can the plugin add tools, and only for `lead`? | Yes on both. 1.x: the `tool` hook; 2.0.16: `ctx.tool.transform`, registered with `codemode: false` to be a direct tool. A `<tool> * deny` rule removes the tool from an agent on both |
| 9 | What happens when a wake lands while a helper answers inline in the user's session (1.x `/review`)? | The wake is written as the session's current agent, the helper; the helper's run continues and reads it; `lead` gets no turn and sees the text on its next turn |
| 10 | Do `helpers_*` tool ids clash with anything? | No, on any of the three versions |
| 11 | How does the plugin see a session's children on 2.0.16? | Not through the plugin context, which has no session list; through the event stream, whose `session.created` and `session.execution.*` events carry what a status line needs |
| 12 | Does `lead` answer the user when a report arrives while it looks up the answer? | Not on its own: on both platforms the report joins the running turn as the newest message, and a real model acted on it instead, also with a rule in the prompt and with a note after the report. The plugin holds the report back until `lead` has answered: on 1.x in `chat.message` until the session is idle; on opencode 2 out of `lead`'s requests, with a queued message that wakes `lead` after the turn |

## 1. Background hand-offs

Answer. On 1.x the `task` tool takes `background: true` only when
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (or `OPENCODE_EXPERIMENTAL=true`) is set in
the environment of the opencode process. Without it the parameter is left out of the tool's
schema, and a call that still sends it fails with "Background subagents require
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"; no child session is created. A plugin
cannot set the flag: it is read into the runtime flags before plugins load. With the flag, the
call returns at once with `<task id="<child>" state="running">` and a text that tells the
model not to poll; `lead`'s turn ends while the child runs. On 2.0.16 the `subagent` tool
takes `background: true` without a flag and returns `<subagent sessionID=... state="running">`.

Evidence, source: `v1src: opencode/src/tool/task.ts:98` (the gate), `:316` (the early
return), `opencode/src/effect/runtime-flags.ts:43` (`enabledByExperimental`);
`v2src: core/src/tool/plugin/subagent.ts:44-47` (the parameter), `:19` (`backgroundResult`),
`:230` (`subagents.background`).

Evidence, runtime (1.18.35, six steps of 2 s): the task part completed at 1.4 s with
`state="running"`; `lead`'s next request answered "lead done" at 1.4 s; the builder's first
request came at 1.5 s and its run ended about 12 s later. Without the flag the task part ended in
`status: "error"` naming the flag and `GET /session/:id/children` was empty. The same on
1.19.0 and, for the flagged case, on 2.0.16.

## 2. The completion wake

Answer. When a background child finishes, opencode writes a user message into the parent
session with `synthetic: true` and the text
`<task id state="completed"><summary>Background task completed: <description></summary><task_result>...</task_result></task>`
(2.0.16: `<subagent sessionID state="completed" description=...>...</subagent>`), and runs the
parent's loop, so `lead` takes a turn with the helper's final text as its latest user message.
The message carries the agent of the parent session as recorded on the session, which is
`lead` in the normal case (section 9 covers the other case). On 1.x only a completed or failed
job injects; a cancelled one does not (section 5).

Evidence, source: `v1src: opencode/src/tool/task.ts:227-256` (`inject`: `agent:
currentParent.agent ?? ctx.agent`, `synthetic: true`), `:256-264` (`notify`: `completed` and
`error` only); `v2src: core/src/session/subagent-completion.ts:41` (the text), `:35`
("Subagent cancelled").

Evidence, runtime: `lead`'s request at 7.8 s had the user messages `["BG_DELEGATE", "<task
id=... state=\"completed\">..."]`, and `GET /session/:id/message` showed the last user message
with `info.agent: "lead"` and `parts[0].synthetic: true`. The plugin's isolation hook
(`plugin/isolate.ts`) trims only when the latest user message belongs to a helper, so a wake
leaves it unchanged.

## 3. Redirecting a running helper

Answer. A message sent to the child session while it runs reaches the child's model at the
next step boundary: after the tool call in flight returns and before the next model request.
With 2 s tool steps the steer text was in the model request 1.9 to 2.0 s after sending, after
3 of 6 steps, on all three versions. The run then continues from the new message: the helper's
system prompt, brief and every earlier tool result stay in the request (and in the provider's
prompt cache), and the run ends when the helper answers; the steps it would have taken are not
taken, nothing runs twice. The transport differs:

- 1.x: `POST /session/:id/prompt_async` (or `prompt`) on the child. The loop re-reads the
  session's messages at every step and takes the latest user message as the one to answer, and
  a prompt to a session whose runner is busy joins that run instead of starting another. The
  message must name the child's agent (section 7).
- 2.0.16: `POST /api/session/:id/prompt` with `delivery: "steer"` (the default) lands at the
  next step boundary; `delivery: "queue"` waits for the run to end.

Evidence, source: `v1src: opencode/src/session/prompt.ts:1092` (messages re-read each step),
`:1170` (agent from the latest user message), `:1141` (model from it);
`opencode/src/effect/runner.ts:115-122` (`ensureRunning` joins a running run);
`v2src: core/src/session/inbox.ts:43-48` (steer and queue), `core/src/session/session.ts:156`
(`delivery: input.delivery ?? "steer"`).

Evidence, runtime (1.18.35, steer sent at 5.7 s with `agent: "builder"`): builder requests at
1.4, 3.5, 5.6 s with one, two and three results; at 7.7 s the request held the steer as a
second user message and three results, and the builder answered; no later builder request.
2.0.16 with `delivery: "steer"`: the same shape, 2.0 s after sending, after 3 of 6 steps,
session agent still `builder`. With `delivery: "queue"` the note reached the builder in the
request after "builder finished" (18.8 s and 18.9 s).

## 4. The continuation parameter

Answer. On 1.x, `task(task_id: <running child>)` does not redirect: the job registry chains
the new prompt after the running job finishes, and the tool returns "Background task updated"
at once. It is "when you are done, also do this". On 2.0.16, `subagent(sessionID: <running
child>)` goes through the same prompt path as section 3 and steers the child.

Evidence, source: `v1src: opencode/src/tool/task.ts:267` (`background.extend`),
`core/src/background-job.ts:256-290` (`extend`: `Deferred.await(result.previous)` then the new
run); `v2src: core/src/tool/plugin/subagent.ts:212` and the comment above it ("the default
wake starts an idle child or steers a running one").

Evidence, runtime (1.18.35): `lead` sent the continuation at 16.7 s while the builder had two
results; the builder answered "finished" at 24.7 s and received the continuation text in a
request at 24.8 s with six results; the task part for the continuation read "Background task
updated".

## 5. Cancel

Answer. 1.x: `POST /session/:id/abort` on the child stops it (its status goes to idle); the
parent gets no message, because only completed and failed jobs inject. 2.0.16: `POST
/api/session/:id/interrupt` stops the child and the parent wakes with
`<subagent ... state="cancelled">`. On both, aborting the parent cancels its background
children.

Evidence, source: `v1src: opencode/src/tool/task.ts:256-264`,
`opencode/src/session/run-state.ts:78` (`cancelBackgroundJobs` on parent cancel);
`v2src: core/src/session/subagent-completion.ts:35,41`,
`core/src/tool/plugin/subagent.ts:236,250`.

Evidence, runtime: after the abort on 1.18.35 the builder made at most one more request and
`GET /session/status` no longer listed the child; `lead` made no request with a `<task` message
within 14 s. On 2.0.16 `lead`'s next request held `state="cancelled"`.

## 6. Promotion by the user

Answer. A foreground hand-off blocks `lead` inside the tool call. On 1.x the TUI keybind
`session.background` calls `POST /experimental/session/:id/background`, which promotes the
session's running foreground task jobs; `lead`'s blocked call then returns with
`state="running"`, `lead` ends its turn, and the completion wakes it as in section 2. 2.0.16
has `POST /api/session/:id/background` with the same effect.

Evidence, source: `v1src: opencode/src/server/routes/instance/httpapi/groups/experimental.ts:100`
(the route), `handlers/experimental.ts:159-171` (promote running task jobs of the session),
`opencode/src/cli/cmd/run/runtime.ts:357` (the call behind the keybind in the `run` command's
runtime; `cli/cmd/run/footer.view.tsx:529-535` binds `session.background`), `opencode/src/tool/task.ts:289-296`
(`onPromote`, `waitForPromotion`); `v2src: core/src/tool/plugin/subagent.ts:241`
(`"backgrounded"`).

Evidence, runtime (1.18.35): the promote call returned `true`; the task part completed with
`state="running"`; `lead` answered "lead done" while the builder had one result; the wake with
"builder finished" followed. 2.0.16: `lead` received "User requested that active blocking
work ..." and ended its turn, then the wake.

## 7. A message without the child's agent (1.x)

Answer. On 1.x the agent and the model of a run come from the latest user message, not from
the session. A message sent to a running child without `agent` is created with the default
agent (`build`) and its model; from the next step the child runs as that agent, with its
system prompt and permissions, and the session record changes too. The 1.x TUI sends the
composer's current agent with every message, and when the user opens a helper's session the
composer keeps its primary agent, `lead`, because it adopts a session's agent only when that
agent is primary. So a user who types into a running helper's session on 1.x moves the rest
of its run to `lead`'s prompt, permissions and model. On 2.0.16 the session owns its agent and
a steer does not change it.

The `chat.message` plugin hook receives the message object before it is saved and the loop
reads the saved message, so a plugin can rewrite `agent`, `model` and `variant` of a message
that lands in a helper's child session to that helper's own.

Evidence, source: `v1src: opencode/src/session/prompt.ts:1170` (agent), `:1141` (model),
`:1000` (the `chat.message` trigger with the message object), `:1046` (the same object
saved); `tui/src/component/prompt/index.tsx:322-326` (adopt only a primary agent), `:1087`
(`agent: agent.name` on every prompt).

Evidence, runtime (1.18.35): after a `prompt_async` without `agent`, the request that carried
the steer had neither `lead`'s nor the builder's system prompt, and `GET /session/:id` on the
child reported `agent: "build"`. 2.0.16 after a steer: `agent: "builder"`.

## 8. Plugin tools and who may call them

Answer. Both platforms let the plugin add tools, and both remove a tool from an agent whose
last matching rule is `<tool id> * deny`, so a manifest rule per helper is enough to hide the
tools from helpers; the plugin's own guard adds a second check at call time.

- 1.x: the hooks object's `tool` map (`{ id: { description, args, execute } }`) registers
  direct tools named by their keys. `execute` gets a context with `agent`, `sessionID`,
  `directory` and `worktree`. An agent file accepts `permission: { helpers_status: deny }` as a
  key it does not know, and the request sent for that agent leaves the tool out; a call the
  model still makes lands on the `invalid` tool ("Model tried to call unavailable ...").
- 2.0.16: `ctx.tool.transform((editor) => editor.add({ name, description, input, execute,
  options }))`. A tool is a direct function in the model request only with `options.codemode:
  false`; otherwise it is reachable only through the Code Mode `execute` tool, which the
  harness denies to scouts and the reviewer. `execute(input, context)` sees `context.agent`.
  A result is `{ content }`; `{ output }` without an output schema fails with "Tool result
  declared output without an output schema". `ctx.tool.hook("execute.before", ...)` may throw
  to reject a call. With `- action: helpers_status, resource: "*", effect: deny` in the
  builder's file, the builder's request listed neither the direct tool nor the Code Mode entry,
  and a forced call failed with "No tool named ... is currently available".

Evidence, source: `v1src: opencode/src/tool/registry.ts:125` (`fromPlugin`), `:201` (the
`tool` map), `opencode/src/permission/index.ts:204-214` (`disabled`: the last rule for the
tool id with pattern `*` and action `deny`), `opencode/src/session/llm/request.ts:210-216`
(`resolveTools`); `v2src: plugin/src/promise/tool.ts:30` (`add`), `:39` (`execute.before`),
`core/src/tool.ts:231` (`whollyDisabled(tool.options?.permission ?? name, rules)`), `:234`
(direct only when `codemode === false`), `:238` (Code Mode only while `execute` is allowed).

Evidence, runtime: a probe plugin registered `helpers_direct` (direct) and `helpers_codemode`
(default) on 2.0.16; `lead`'s request listed `helpers_direct` among the functions and
`helpers_codemode` only in the Code Mode section; `lead`'s call returned "direct-ok
agent=lead". On 1.18.35 and 1.19.0 the probe's `tool` map gave `lead` `helpers_direct`, the
call returned "direct-ok agent=lead", and the builder with the deny key had no such tool.

## 9. A wake during an inline helper (1.x)

Answer. `/review` and `/progress` run their helper in the user's own session on 1.x. When a
background child completes while the reviewer is answering there, the wake is written with
the session's current agent, which is the reviewer, not `lead`. The reviewer's run goes on,
reads the completion as its latest user message and answers; `lead` takes no turn for it and
sees the `<task>` text in the conversation on its next turn. The run does not switch agent.
On 2.0.16 `/review` runs in a child session, so the case does not arise.

Evidence, source: `v1src: opencode/src/tool/task.ts:235` (`currentParent.agent`), with
`opencode/src/session/prompt.ts:672-689` (the session record keeps the agent of the latest
user message, cited in `docs/research/opencode-v1.md`).

Evidence, runtime (1.18.35): `lead` started a background builder (five steps of 2 s); at 3.9 s
the user ran `/review` inline, and the reviewer took 2 s steps; the builder finished at 12.9 s;
the reviewer's request at 14.3 s held the `<task ... state="completed">` message as its latest
user message and answered "VERDICT: APPROVE". The session's messages read `user reviewer
"<task id=..."`, and no `lead` request followed.

Follow-up, found after the branch was merged: the same happens when the completion arrives
after the inline review has finished, because the session record still names the reviewer;
the reviewer answers the completion and `lead` is not woken. And an inline command sent while
`lead` works takes over `lead`'s run, because the loop runs the agent of its newest message
(`opencode/src/session/prompt.ts:1096,1170`). The plugin now holds such a message until the
helper's report is in, gives a completion to the session's owner, and runs a command sent
during another agent's work in a child session (`plugin/inline.ts`, `docs/architecture.md`).

## 10. Tool ids

Answer. Neither platform has a tool whose id starts with `helpers`. The direct tools `lead`
sees are `bash, edit, glob, grep, question, read, skill, task, todowrite, webfetch, write` on
1.18.35 and 1.19.0, and `edit, execute, glob, grep, question, read, shell, skill, subagent,
webfetch, websearch, write` on 2.0.16, whose Code Mode section adds `list_mcp_resources`,
`read_mcp_resource`, `session_move` and `session_rename`. `helpers_status`, `helpers_steer` and
`helpers_cancel` are free on all three.

Evidence, runtime: the function names in `lead`'s first model request, and on 2.0.16 the
identifiers in the Code Mode section of its system prompt, read from the stand-in.

## 11. The 2.0.16 event stream

Answer. The plugin context's session domain is a `Pick` of the client API with `create`,
`get`, `prompt`, `interrupt`, `wait`, `context` and a few more, but no `list`, so a plugin
cannot ask for a session's children; `context` returns a session's active messages
(`v2src: protocol/src/groups/session.ts:567`). The event subscription
(`ctx.event.subscribe`) yields envelopes `{ id, created, type, location, data }` with the
payload under `data`. The events a status line needs: `session.created` with `sessionID`,
`parentID`, `agent` and `title`; `session.execution.started`, `.succeeded`, `.failed` and
`.interrupted` (with `reason`); `session.renamed` with `title`; `session.agent.selected` with
`agent`. `session.tool.called` carries the call id but not the tool name, so steps and the
last call come from the `execute.before` tool hook, which has `tool`, `sessionID` and `agent`.

Evidence, source: `v2src: plugin/src/promise/session.ts:153-169` (`SessionDomain`),
`schema/src/session-event.ts:51-70` (`Created`), `:104-113` (`Renamed`), `:72-82`
(`AgentSelected`), `:242-262` (`Execution`), `:471-523` (`Tool.Called`),
`plugin/src/promise/tool.ts:39-46` (`execute.before`).

Evidence, runtime (2.0.16): a probe plugin wrote the first events of a session to standard
error: `{"id":"evt_...","type":"session.created",...,"data":{"sessionID":"ses_...",
"projectID":"global",...}}` and `{"type":"session.execution.started","data":{"sessionID":...}}`;
a `helpers_status` built from `event.sessionID` saw nothing until it read `event.data`.

## 12. A report that arrives mid-reply

Answer. On both platforms a background helper's report that arrives while `lead`'s turn runs
joins that turn at its next step. opencode 1.x writes it with an ordinary `prompt()`, which
joins the running loop; the loop reloads the messages at every step and answers the newest
user message, written by opencode or not. opencode 2 writes it with `delivery: "steer"`, which
the runner promotes at the next step boundary; only `queue` waits for the turn to end, and
completions never use it. The report is then the newest message the model sees. The turn ends
at the first step without tool calls, whatever that step answered, and the report is not
delivered again.

With a real model, `lead` acted on the report and never answered the user's question whenever
a report arrived while it looked the answer up: 7 times in 7, with and without a rule in the
`lead` prompt and the plan skill that says to answer first, and also with a note after the
report, in what the model sees, saying the same. When no report arrived during the lookup,
`lead` answered.

So the plugin holds the report back until `lead` has answered. On 1.x a report waits in the
`chat.message` hook, which runs before opencode saves it, as the plugin already does while a
helper answers inline. It waits until the session is idle: opencode publishes `session.idle`
with every idle status, so the wait ends at once. The report is then dated at delivery, is
listed after `lead`'s answer, since messages are ordered by creation time, and starts a turn
of its own. opencode 2 has no hook that can delay or reorder a message, but the `context`
session hook receives the messages of each model request and opencode sends what the hook
leaves, as opencode's own Plan plugin uses it. The plugin leaves the report out while the reply
runs and queues a synthetic message with `delivery: "queue"`, which opencode writes once the
turn has ended and which wakes the session; in that turn the report is in view again.

Evidence, source: `v1src: opencode/src/tool/task.ts:227-253` (the completion is a `prompt()`
with a synthetic text part), `v1src: opencode/src/session/prompt.ts:1092` (messages reloaded
at each step), `v1src: opencode/src/session/message-v2.ts:595-617` (the newest user message),
`prompt.ts:1106-1130` (when the loop ends), `prompt.ts:999-1047` (`chat.message` before the
message is saved), `session/status.ts:39-47` (`session.idle`), `session/message-v2.ts:452`
(ordered by creation time); `v2src: core/src/session/subagent-completion.ts:36-43`,
`core/src/session/session.ts:274-311` (`synthetic`: `delivery` defaults to `steer`, and the
session is woken unless `resume` is false), `core/src/session/runner/llm.ts:82-85` and
`:165-177` (promotion at the step boundary), `core/src/session/inbox.ts:43-48` (`queue`),
`core/src/session/runner/to-llm-message.ts:284-285` (a synthetic message reaches the model as
its text), `core/src/session/model-request.ts:378-385` (the `context` hook),
`core/src/plugin/plan.ts:58` (the Plan plugin's use of it). The same code is at `v2.0.28`.

Evidence, runtime: `evals/results/go-background.md`, the runs of `execute-chat` with a
question that needs a lookup (opencode 1.18.35): with the rules and with the note, the question
was dropped whenever a report arrived during the lookup; with the hold, all three runs passed,
with T1's report arriving during the lookup in each. `plugin/background.integration.test.ts`
with the stand-in: on 1.18.35 and 1.19.0 `lead`'s answering request holds no report, and the
report starts a turn of its own 0.2 to 0.5 s after the answer, released by `session.idle`; on
2.0.16, and on 2.0.28 with the suite's version check set to it, the answering request holds no
report, and one queued wake follows the turn with the report in view.

## What the design takes from this

- Build on the native background mode: no job registry, poller or queue in the plugin. The
  wake already arrives as a user message `lead` can read as a report (sections 1, 2).
- `helpers_steer` sends to a running child: 1.x `prompt_async` naming the child's agent, from
  which opencode resolves its model and effort; 2.0.16 `prompt` with `delivery: "steer"`. A
  finished helper is continued through the delegation tool's continuation parameter, which
  both platforms handle well, so the plugin leaves it to that tool (sections 3, 4, 7, 11).
- `helpers_cancel` reports the cancel in its own result on 1.x, because the platform does not;
  `helpers_status` shows a child that the user cancelled (section 5).
- The 1.x plugin pins messages that land in a helper's child session to that helper's agent,
  model and variant in `chat.message`, so the user can type into a running helper safely. It
  never touches the user's own session (sections 7, 9).
- Tools are registered as direct tools (`codemode: false` on 2.0.16), denied to every helper by
  a manifest `tool` rule that the generator writes as the platform's permission key for the
  id, and checked again in the plugin's `execute.before` guard (section 8).
- On 2.0.16 the plugin mirrors the sessions the event stream announces; steps and the last
  call come from the tool hook on both platforms (section 11).
- The 1.x flag goes into the installer's output and `doctor`; the `lead` prompt must read
  correctly without it, because the parameter then does not exist and a call with it fails
  (section 1).
- A completion that lands during an inline `/review` on 1.x is part of the reviewer's run: the
  isolation hook skips user messages opencode wrote itself (`synthetic: true`) when it looks
  for the request, so the reviewer keeps its brief and steps; `lead` reads the completion on
  its next turn, not as a wake (section 9).
- A report that arrives while `lead` replies to the user is held back until `lead` has
  answered: on 1.x it waits in `chat.message` until the session is idle; on opencode 2 it is
  left out of `lead`'s requests, and a queued message wakes `lead` after the turn (section 12).
