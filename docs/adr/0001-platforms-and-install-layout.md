<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# 0001. Platforms, file formats and install layout

Status: accepted, amended by ADR 0004 (opencode 2 only: supported versions, the two
outputs, the 1.x plugin items, and central install on opencode 2). Date: 2026-10-11.

## Context

The harness must run on opencode 1.x, the stable line most ECMWF users have, and on
opencode 2, which changes the agent file format, the permission format and the plugin API.
The evidence behind every decision here is in `docs/research/opencode-v1.md`,
`docs/research/opencode-v2.md` and `docs/research/command-clashes.md`.

## Decisions

### Supported versions

- opencode 1.x from 1.18.35 is the main target, tested on 1.18.35 and 1.19.0.
- opencode 2 is pinned to 2.0.28 since 0.5.2, after the integration tests passed on it. It
  was pinned to 2.0.16, the version weave's v2 adapter is built against; 2.0.16 still works
  and gets the installer's warning for an untested version. The pin moves only after the
  integration tests pass on a newer version.

### Two outputs that never share a directory

The generator writes `dist/opencode-v1/` and `dist/opencode-v2/`. opencode 1.x reads v2 agent
files without an error but ignores their permission rules, so helpers would run without
their restrictions, and it refuses to start when an `opencode.json` holds v2 `permissions`.
opencode 2 reads v1 files correctly. So:

| opencode on the machine | Files installed |
|---|---|
| 1.x only | v1 |
| 1.x and 2 | v1 (opencode 2 reads them) |
| 2 only | v2 |

### Layout

Each platform directory mirrors an opencode config directory and is installed by copying or
linking its files into one:

```text
agents/<id>.md                         agents
commands/<id>.md                       slash commands
skills/<id>/SKILL.md                   skills
plugins/ecmwf-multi-agents.js          the plugin (same file for both platforms)
ecmwf-multi-agents/schema.json         JSON Schema of the settings file
ecmwf-multi-agents/profiles/<id>.json  model profiles, for the installer and doctor
ecmwf-multi-agents/files.txt           every file above, sorted, one per line
```

The settings file `ecmwf-multi-agents.jsonc` sits in the root of the config directory. It
belongs to the user: it is never part of `dist/` and never overwritten.

### Plugin

One bundled ES module serves both platforms:
`export default { id: "ecmwf-multi-agents", server, setup }`. opencode 1.x calls `server` and
uses the returned hooks; opencode 2 calls `setup`. The module has no runtime dependencies (type
imports only) and carries the profiles, embedded when `tools/bundle-plugin.ts` bundles
`plugin/` during the build.

What it does:

1. Reads settings from these files, later ones overriding earlier ones, with `agents`
   entries merged per agent:
   1. `$OPENCODE_CONFIG_DIR/ecmwf-multi-agents.jsonc`, when the variable is set (site
      defaults for a central install);
   2. `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/ecmwf-multi-agents.jsonc`;
   3. `<project root>/.opencode/ecmwf-multi-agents.jsonc`.

   An invalid file is reported (log, and a toast where the platform offers one) and ignored.
2. Applies the chosen profile, then per-agent overrides: sets model and effort (opencode's
   variant), or removes them so the agent uses the session model; sets `steps`.
3. Rewrites the line `Review policy: <value>` in the `lead` prompt.
4. Makes `lead` the default agent when the settings allow it (`default_agent`, default true)
   and no config file already names a default agent.
5. On opencode 1.x, applies each helper's own shell rules again in `tool.execute.before`,
   so a helper's denied commands (git and `gh` writes among them) stay denied. An "Allow
   always" answer there lasts until restart and overrides every agent's `deny` rules.
6. On opencode 1.x, drops the earlier conversation from the model requests of a helper that
   answers in the user's own session (`/review`, `/progress`), through
   `experimental.chat.messages.transform`, so it works from its command alone. Compaction
   passes through the same hook and is never trimmed.
7. On opencode 1.x, keeps such a helper from taking a turn that is not its own, in
   `chat.message`: a helper command sent while another agent works runs in a child session
   instead, a background helper's completion goes to the session's owner (normally `lead`)
   instead of the helper the session last ran, and either waits while a helper answers inline.
   Details: `docs/architecture.md` (Reports) and `plugin/inline.ts`.

On opencode 2, agent transforms registered during `setup` run before the agent files load,
so the plugin registers its transform after activation.

Without the plugin the agents still work: default profile, review policy `auto`, and
opencode's own default agent.

### Installer

`install.sh` is POSIX sh.

- Target: the global config directory `${XDG_CONFIG_HOME:-$HOME/.config}/opencode` by default,
  `DIR/.opencode` with `--project DIR`, or DIR itself with `--central DIR`.
- Platform: detected from `opencode --version` and `opencode2 --version`, following the table
  above; `--platform v1|v2` overrides. A v2 version other than the pinned one gets a warning.
- Global installs link each file, so `git pull` updates them. Project installs copy, because
  projects may commit `.opencode/` and share it; `--link` and `--copy` override.
- It never overwrites or removes a file that is neither a link into this clone nor a file
  carrying the marker comment; such files are reported as conflicts.
- It creates the settings file when it is missing and never changes an existing one. A
  global install always writes one (with `--profile` and `--review`, or the defaults). A
  project or central settings file overrides the user's own, so it is written only when
  `--profile` or `--review` is given, and holds only those keys.
- `doctor` checks versions, installed files against `files.txt`, the settings file, that the
  active profile's models exist, and the default agent. `uninstall` removes linked and marked
  files listed in `files.txt` and keeps the settings file unless `--purge` is given.
- Central install on opencode 1.x: `install.sh --central DIR` copies the v1 files into DIR
  (optionally with a site settings file), the administrator makes DIR read-only, and users
  set `OPENCODE_CONFIG_DIR=DIR`. That directory is applied after global and project config,
  so its agents win over project definitions. Verified read-only on 1.18.35 and 1.19.0: the
  agents load, the plugin runs and applies the site settings, and opencode writes nothing
  into DIR. (Writable config directories get a `.gitignore`, `package.json` and
  `node_modules/` from opencode, which is why DIR is a copy and not the checkout.)
- Central install on opencode 2 is deferred: `OPENCODE_CONFIG_DIR` replaces the user's own
  config directory there and 2.0.16 writes into it. The route is a generated `opencode.json`
  set through `OPENCODE_CONFIG` for opencode 2 processes only.

### Names

- Commands: `onboard`, `plan`, `execute` (named `go` up to and including 0.4.0), `review`, `progress`, `guide`. `review` deliberately
  replaces opencode's built-in review command. `progress` replaces the planned `status`,
  which clashes with the TUI's own `/status`.
- A project's own command or agent with the same name takes precedence in that project, as
  opencode intends. Known cases: `onboard` in three of the user's projects, and a `scout` agent
  in one. Kept, because a project's own definition is the more specific one.
- Agents keep their names; none of the tested versions has a built-in `scout`.

### Permissions and prompts

- Agent rules follow the user's rules and the last match wins, so agent `allow` and `ask` rules
  override the user's policy. The harness keeps them few and states each reason in
  `docs/architecture.md`.
- `X *` also matches a bare `X`. Edit paths match relative to the repository root on 1.x and
  to the session directory on 2, so path rules come in pairs (`p` and `*/p`).
- opencode 1.x accepts only one effect for `question`, `todowrite`, `webfetch` and
  `websearch`. opencode 2 has no todo tool; `execute` (Code Mode) exists only on 2.
- An agent prompt replaces opencode's own system prompt on both platforms, so prompts carry
  the working rules they need. Hidden skills are loaded by exact id. Command templates never
  use `` !`command` `` blocks or `@name` mentions.
- Step limits are soft on 1.x; prompts tell helpers to stop and report when told to.

## Consequences

- Each new opencode version needs the integration tests (`ECMWF_MULTI_AGENTS_INTEGRATION=1`)
  before it is listed as supported.
- Users with both versions get the v1 files and lose nothing on opencode 2.
- The plugin is optional and fails safe: settings it cannot read leave the defaults in place.
