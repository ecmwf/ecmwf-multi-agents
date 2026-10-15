<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# 0003. Switching the harness on per project with a plugin line

Status: Superseded by ADR 0004. Date: 2026-10-13.

## Context

`install.sh` puts the harness in an opencode config folder: globally, which switches it on in
every project, or into one project's `.opencode/`, which copies or links nineteen files there
and needs a re-run in each project whenever a release adds or removes a file. Users asked for
what opencode offers for plugins: keep one checkout, switch the harness on in chosen projects
with a line in their config, and have every such project follow when the checkout moves to a
new version.

Verified with a probe plugin, then with the real bundle, on opencode 1.18.35 and 1.19.0 (source
lines are 1.18.35, the same in 1.19.0):

- A plugin entry that is a path is resolved against the config file that names it, after
  `{env:VAR}` substitution across the whole config text (`opencode/src/config/plugin.ts:40-61`,
  `config/variable.ts:34-38`). A path to a folder is loaded through the `exports["./server"]`
  entry of its `package.json` (`plugin/shared.ts:150-161`). Plugins named by path skip the
  `engines.opencode` check (`plugin/loader.ts:123-131`).
- The plugin's `config` hook receives the live config before other services read it
  (`plugin/index.ts:244-253`). Agents and commands added there resolve like ones from files;
  an added `review` command replaces the built-in one in the command list; a folder added to
  `skills.paths` is scanned by skill discovery (`skill/index.ts:210-220`); `default_agent` set
  there holds.
- opencode writes nothing into a plugin folder named this way, and a project without the line
  sees none of it.
- opencode 2.0.16 shows only its own agents and commands for a project with the line, without
  an error.

## Decisions

- The repository's `package.json` names the bundled plugin as `exports["./server"]`, so a
  checkout of the repository is itself a plugin folder.
- The plugin registers the harness when it is not installed, that is when `lead` is not
  defined: every agent and command not yet defined, as the same entries opencode makes of the
  generated files (`name`, the frontmatter, and the body as `prompt` or `template`), and the
  `skills` folder next to its own folder. The bundle carries these entries; a test checks they
  equal what opencode reads from the generated files, and an integration test checks that the
  agents resolve as installed ones do. Settings apply afterwards, as to installed files.
- A definition that already exists is kept, as it would be over installed files, and reported:
  as a message on screen for an agent, in the log for a command.
- The documented line is `"plugin": ["{env:HOME}/.local/share/ecmwf-multi-agents"]`, which
  works for everyone who keeps the checkout in that place. `./install.sh --help` prints it with
  the path of the checkout it runs from. `./install.sh doctor --project DIR` recognises a
  project switched on this way, resolves the line as opencode does, and checks the checkout.
- One version per checkout. A project that must stay on a version names a checkout of that tag,
  for example a git worktree.
- opencode 1.x only. On opencode 2, `install.sh` stays the way.

## Consequences

- Updating the checkout updates every project with the line at its next opencode start,
  whatever files the new version adds or removes; running sessions keep the version they
  started with until restarted.
- The bundle carries the prompts and templates: 106 KB instead of 76 KB in 0.3.0.
- A project with both the line and an install loads the plugin twice and uses the installed
  files; the plugin's hooks are idempotent, and `doctor` warns.
- The npm package planned in `PLAN.md` can use the same plugin unchanged, with
  `"plugin": ["<package>@<version>"]` pinning a version per project.
