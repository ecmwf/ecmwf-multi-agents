<!--
SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
SPDX-License-Identifier: Apache-2.0
-->

# Installing ecmwf-multi-agents

## Requirements

- opencode 1.18.35 or a later 1.x version, or opencode 2.0.16.
- A POSIX shell and standard tools (`sed`, `grep`, `cmp`, `readlink`). `jq` makes `doctor`
  more thorough when it is installed.
- Access to the models of the profile you choose. The default profile needs Anthropic and
  GitHub Copilot, connected with `opencode auth login`. The `inherit` profile works with any
  model.

The checkout already contains the generated files in `dist/`, so installing needs neither Bun
nor a build.

## Install for yourself

```sh
git clone <repository-url> ~/.local/share/ecmwf-multi-agents
cd ~/.local/share/ecmwf-multi-agents
./install.sh
```

This links the agents, commands, skills and plugin into `~/.config/opencode/` (or
`$XDG_CONFIG_HOME/opencode/`), records what it installed in
`~/.config/opencode/ecmwf-multi-agents/installed.txt`, and creates your settings file
`~/.config/opencode/ecmwf-multi-agents.jsonc` if you do not have one. Restart opencode
afterwards.

Choose models and the review policy at install time, or later by editing the settings file:

```sh
./install.sh --profile anthropic --review always
```

The settings file can also change one agent's model, effort or step limit. Effort is how
hard a model thinks before it answers: `low`, `medium`, `high`, `xhigh` or `max`; more effort
is slower and costs more. For example, to let the builder think harder:

```jsonc
{
  "agents": { "builder": { "effort": "xhigh" } }
}
```

Effort applies only to an agent that has a model, so under the `inherit` profile it needs a
`model` in the same entry. Restart opencode after changing settings. `/guide` in opencode lists
the defaults, and [the architecture](architecture.md#settings) has the full reference.

The installer never overwrites a file it did not create. If one of your own files is in the
way, for example your own `commands/plan.md`, it is left alone and reported, the rest is
installed, and the installer exits with an error so you notice.

## Install for one project

```sh
./install.sh --project ~/code/my-repo
```

The files are copied into `~/code/my-repo/.opencode/`, so they keep working for everyone who
clones the project if you commit them. If you do not want to commit them, add `.opencode/` (or
the individual files) to the project's `.gitignore`.

A project settings file overrides your own settings, so the installer writes
`.opencode/ecmwf-multi-agents.jsonc` only when you pass `--profile` or `--review`, and then
with only those values.

## Options

| Option | Effect |
|---|---|
| `--project DIR` | Install into `DIR/.opencode` (files copied) |
| `--central DIR` | Prepare `DIR` as a shared install for opencode 1.x (files copied) |
| `--profile NAME` | Models: `default`, `anthropic`, `copilot` or `inherit` |
| `--review WHEN` | When the reviewer checks work: `auto`, `ask`, `always` or `never` |
| `--platform v1\|v2` | Force the opencode 1.x or 2 file format (normally detected) |
| `--link`, `--copy` | Link files to the checkout, or copy them |
| `--dry-run` | Show what would happen without changing anything |
| `--purge` | With `uninstall`: also remove the settings file |

## Updating

```sh
cd ~/.local/share/ecmwf-multi-agents
git pull
./install.sh
```

Linked files (the default for your own install) change as soon as you `git pull`; restart
opencode to load them. Run `./install.sh` again when files were added or removed, which
`doctor` reports, and always for copied installs (projects and central installs). Re-running
is safe: unchanged files stay as they are.

## Checking an installation

```sh
./install.sh doctor
./install.sh doctor --project ~/code/my-repo
```

Each line starts with OK, WARN or FAIL:

- the opencode versions found, and whether the installed files suit them;
- every installed file present and still from the harness (a broken link usually means the
  checkout was moved: run `./install.sh` again);
- whether the checkout has files that are not installed yet, or the other way round;
- your settings files: the review value and the profile name;
- whether the models of your profile are available (a WARN with the provider to connect);
- on opencode 1.x, whether opencode loads the `lead` agent, whether your review setting
  reached it (if not, the plugin is not active), and which agent opencode starts on.

`doctor` exits with an error only on FAIL lines.

## Removing

```sh
./install.sh uninstall
./install.sh uninstall --project ~/code/my-repo
```

This removes the files the installer put there and keeps your settings file; add `--purge` to
remove it too. Files you created yourself are never removed.

## Machines with both opencode versions

opencode 1.x reads opencode 2 agent files without an error but ignores their permission
rules, which would let the helpers run without their restrictions. opencode 2 reads the 1.x
files correctly. So when opencode 1.x is installed at all, the installer uses the 1.x files,
and both versions work with them. On a machine with only opencode 2 it uses the opencode 2
files. `--platform` overrides the choice, with a warning when that is unsafe.

## Shared machines (central install)

An administrator can install the harness once for everyone using opencode 1.x:

```sh
git clone <repository-url> /opt/ecmwf-multi-agents-src
cd /opt/ecmwf-multi-agents-src
./install.sh --central /opt/ecmwf-multi-agents
chmod -R a-w /opt/ecmwf-multi-agents
```

Each user then sets one environment variable, typically from a module file:

```lua
-- Lmod: ecmwf-multi-agents.lua
whatis("Multi-agent harness for opencode")
setenv("OPENCODE_CONFIG_DIR", "/opt/ecmwf-multi-agents")
```

```tcl
#%Module1.0
## Tcl: ecmwf-multi-agents
module-whatis "Multi-agent harness for opencode"
setenv OPENCODE_CONFIG_DIR /opt/ecmwf-multi-agents
```

The read-only folder works: tested with opencode 1.18.35 and 1.19.0, the agents load, the
plugin runs, and opencode writes nothing there. The folder is a copy and not the checkout,
because opencode writes a `.gitignore`, a `package.json` and `node_modules/` into writable
config folders.

Site defaults go in `/opt/ecmwf-multi-agents/ecmwf-multi-agents.jsonc`; pass `--profile` or
`--review` with `--central` to create it. Users still choose their own settings in
`~/.config/opencode/ecmwf-multi-agents.jsonc`, which overrides the site file, and a project's
settings file overrides both. Agents in the central folder take precedence over agents a
project defines with the same name.

To update, `git pull` in the source checkout, make the folder writable, run the same
`./install.sh --central` command, and make it read-only again. Check it with
`./install.sh doctor --central /opt/ecmwf-multi-agents`.

A central install for opencode 2 is not supported yet: on 2.0.16, `OPENCODE_CONFIG_DIR`
replaces the user's own config folder instead of adding to it, and opencode writes into it.

## Troubleshooting

- **opencode starts on `build`, not `lead`.** Your opencode config (or another plugin)
  names a different `default_agent`, or the plugin is not installed. Press Tab or type
  `/agents` to switch, or set `"default_agent": "lead"` in your `opencode.json`.
- **A model is not available.** Connect its provider with `opencode auth login`, or choose
  another profile in your settings file, then restart opencode.
- **Settings seem ignored.** Restart opencode; settings are read at startup. An invalid
  settings file is ignored as a whole: run `./install.sh doctor` to see why.
- **Files were left alone.** They are not from the harness. Rename or move them and run
  `./install.sh` again.
