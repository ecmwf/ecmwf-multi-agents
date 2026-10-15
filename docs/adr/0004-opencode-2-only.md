<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# 0004. opencode 2 only

Status: accepted. Date: 2026-10-15. Supersedes ADR 0003; amends ADR 0001 and ADR 0002.

## Context

The harness runs on opencode 1.x and opencode 2 from two generated outputs, with a plugin
that serves both APIs. Most of its runtime work exists only on 1.x: the per-project plugin
line (ADR 0003), inline `/review` and `/progress` with their isolation, the settings
problems on screen, the read-only central install and the eval runner. On 2 the same
features were either missing or deferred.

Upstream has moved (`docs/research/opencode-v2.md`, section 11). opencode 2 ships as
`@opencode/cli` with the binary `opencode`, 1.19.0 offers `opencode upgrade --major`, and the
migration guide lists three breaking changes only. opencode 2 reads a 1.x config; 1.x
rejects 2.x `permissions` and ignores `plugins`. Keeping both lines means every new feature is
built and tested twice, and the shared files must stay in the 1.x format.

The research in sections 12 to 15 of the same note shows that every 1.x feature has a way on
opencode 2, several of them simpler than on 1.x.

The harness is young and its users are few, so it has no deprecation release and no
migration notice: the release that lands this change says "opencode 2 only".

## Decisions

### opencode 2 only

- The harness supports opencode 2 only. `dist/opencode-v1/`, the v1 emitter, the v1 plugin
  modules and the installer's platform detection go.
- The pinned version moves deliberately, after the integration suites pass on the new
  version: 2.0.28 now, 2.0.29 when the pin task lands (the answer-first rule must first let
  2.0.29's output-limit note through).

### Every feature carried

| Feature | On opencode 2 |
|---|---|
| Per-project line, npm package | `"plugins": ["@ecmwf.int/multi-agents@X.Y.Z"]` or a checkout path in a project's config; the plugin registers agents, skills, commands and the default agent. User and project files still win, except over `/review` and `/progress` and over the harness agents' model, effort, step limit and review line, which the settings decide |
| Inline `/review` and `/progress` | Owned by the plugin: switch the session to the helper, prompt, wait, switch back, wake `lead` if reports were held; the `context` hook hides the earlier conversation from the helper. The file commands stay `subagent: true`, the fallback without the plugin |
| Settings problems on screen | A plugin RPC (`problems`, and an event), shown as a toast by a TUI entry; the plugin becomes a folder (`index.js`, `tui.js`) |
| `doctor` live checks | `opencode api --standalone POST /api/rpc/ecmwf-multi-agents/doctor`, which waits for plugins where the agent list does not |
| Central install | The module file sets `OPENCODE_CONFIG` to a generated read-only `opencode.json`; the installer offers `opencode service set env`; `doctor` warns about the shared service port on login nodes |
| Eval runner | `serve --stdio --port 0`, Basic auth with `OPENCODE_PASSWORD`, the `/api/...` routes, a message adapter so the checks barely change, and an eval-only login |

### Per-project activation through `plugins`

This supersedes ADR 0003, which used the 1.x `config` hook and the `plugin` key.

- A project switches the harness on with one entry in its `plugins` array: the npm package
  with a pinned version, or the path of a checkout. A pinned version never changes under the
  project; a new version is a deliberate edit of the line.
- The plugin registers what the generated files define: agents with `agent.transform` and
  `update`, skills with `skill.transform` and `add`, commands with `command.transform` and
  `add`, and `lead` as the default agent with `editor.default`. opencode's file and config
  loaders run after user plugins, so a user's or project's own agent file, command, skill or
  `default_agent` still wins, as over installed files, with two exceptions: the plugin
  registers `/review` and `/progress` again after the command files, and the settings decide
  the model, effort and step limit of the harness agents and `lead`'s review line.
- Commands registered by a plugin are code, with no template: each harness command is an
  `execute` that sends its generated template to the session as the command's agent would
  receive it.
- A test compares the agents the plugin registers with the agents opencode loads from the
  generated files.
- A global install with the same plugin id masks a project's line ("Duplicate plugin ID");
  `doctor` warns about it.

### Central install through `OPENCODE_CONFIG`

This amends ADR 0001, which used `OPENCODE_CONFIG_DIR` on 1.x and deferred central install
on opencode 2.

- `install.sh --central DIR` writes a generated `opencode.json` into DIR with the agents and
  commands inline through `{file:}`, absolute `skills` paths and the plugin folder in
  `plugins`, and DIR is made read-only. The module file (Lmod or Tcl) sets `OPENCODE_CONFIG`
  to that file. The file sits above the user's global config and below project config, so
  the user's own config and projects keep working.
- `OPENCODE_CONFIG_DIR` is not used: it hides the user's own config and opencode writes
  `service.json` into it. `/etc/opencode` is not used: it applies to every user with no
  opt-in and its precedence changed between 2.0.28 and 2.0.29.
- The per-user service reads `OPENCODE_CONFIG` only when it starts, so the installer offers
  `opencode service set env OPENCODE_CONFIG <file>`, which keeps the variable in the user's
  `service.json`.
- Every user's service listens on the same port, so on shared login nodes `doctor` warns
  and names `opencode service set port` and `opencode service set disabled true`.
- `OPENCODE_CONFIG` is read by the code but not documented upstream; the integration tests
  hold its behaviour and fail when it changes.

### Inline commands owned by the plugin

This amends ADR 0001 (plugin items 6 and 7) and ADR 0002 (the inline helpers' wake on 1.x).

- `/review` and `/progress` run in the user's session through commands the plugin owns. The
  command switches the session to the helper (and its model), prompts it, waits for the end
  of its run and switches back to the agent the session had; a background report that
  arrived meanwhile is held and then delivered to `lead` as a queued synthetic message.
- The `context` session hook gives the helper only its own request, as the 1.x
  messages transform did; compaction is not trimmed.
- Without the plugin, the generated command files with `subagent: true` run the helper as a
  background child: no isolation needed, at the price of a report instead of an answer in
  place.

### Doctor and problems through an RPC and a toast

- Promise plugins have no log or toast API. The plugin registers an RPC with `doctor` and
  `problems` methods and publishes an event when problems change. `install.sh doctor` calls
  the RPC through `opencode api --standalone`, whose route waits for plugin activation.
- A TUI entry shows problems as a toast. The plugin therefore ships as a folder with
  `index.js` (server) and `tui.js`, which is also the shape the `plugins` line and the npm
  package load.

### Evals on opencode 2

- The runner starts `opencode serve --stdio --port 0` per run, with a random
  `OPENCODE_PASSWORD`, and drives it through the `/api/...` routes: prompts, commands,
  permission replies, form replies, waits and the event stream. A message adapter turns 2.x
  messages and tool parts (`shell`, `subagent`) into the shape the checks read, so the checks
  barely change.
- Login: an eval-only database made once with `make eval-login`. Each run pipes it with
  `opencode auth export` into `opencode auth import --server <url>` of the run's server. The
  credentials pass from one opencode process to another; the runner never reads, stores or
  prints a credential. `AGENTS.md` gains the rule.

### Dropped as not needed on opencode 2

- The shell guard after "Allow always": a configured `deny` is decided before saved
  approvals.
- Child pinning: the user cannot type into a child session, and a session owns its agent.
- The background flag: the delegation tool always offers background mode.
- The `todo` and `list` rules: opencode 2 has no such tools.

## Consequences

- One generated output, one plugin API and one set of integration suites. Code that served
  only 1.x is deleted, not kept behind a switch.
- Users on 1.x must upgrade (`opencode upgrade --major`) to take a new release.
- The central install depends on `OPENCODE_CONFIG`, which upstream does not document, and
  inline commands depend on the timing of a session's agent switch. The integration suites
  cover both, and each pin move re-runs them.
- Releases up to 0.5.x stay the ones for opencode 1.x (1.18.35 and later).
- Plugin registration means the npm package alone brings the whole harness, and a project's
  line pins its version.
- The architecture, install guide, guide skill and README describe opencode 2 only.
