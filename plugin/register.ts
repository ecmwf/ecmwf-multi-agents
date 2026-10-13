// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// On opencode 1.x the harness can be switched on for one project with one line in that project's
// config, `"plugin": ["{env:HOME}/.local/share/ecmwf-multi-agents"]`, without installing any
// files. Line numbers below are opencode 1.18.35, identical in 1.19.0:
//
// - A plugin path is resolved against the config file that names it, after `{env:VAR}`
//   substitution (opencode/src/config/plugin.ts:40-61, config/variable.ts:34-38). A path to a
//   directory is loaded through the `exports["./server"]` entry of its package.json
//   (plugin/shared.ts:150-161), which in a checkout of this repository names the bundled plugin.
// - The plugin's `config` hook receives the live config before any other service reads it
//   (plugin/index.ts:244-253): agents and commands added there are used like ones read from files,
//   and a folder added to `skills.paths` is scanned by skill discovery (skill/index.ts:210-220).
//
// So the plugin brings the harness itself when it is not installed, that is when `lead` is not
// defined: every agent and command that is not defined yet, as the same entries opencode makes of
// the generated files (tools/emit-v1.ts), and the skills folder next to the plugin's own folder.
// Anything already defined is kept, as it would be over installed files: a project's own `scout`
// agent or `/onboard` command wins. Settings are applied afterwards, to these entries as to files.

import path from "node:path";
import type { EmbeddedHarness, Problem, V1Config } from "./types.ts";

export interface RegisterOptions {
  /** The skills folder shipped next to the folder the plugin was loaded from; undefined if unknown. */
  skillsDir: string | undefined;
  /** A file's text, or undefined when it cannot be read. */
  readFile: (file: string) => string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The record under `key`, created when missing; undefined when something else is there. */
function recordAt(config: V1Config, key: string): Record<string, unknown> | undefined {
  if (config[key] === undefined) config[key] = {};
  const value = config[key];
  return isRecord(value) ? value : undefined;
}

/**
 * Register the harness in an opencode 1.x config when it is not installed. Changes `config` in
 * place and returns what to report; returns nothing when `lead` is defined (files installed).
 */
export function registerV1(config: V1Config, harness: EmbeddedHarness, options: RegisterOptions): Problem[] {
  if (isRecord(config.agent) && config.agent[harness.defaultAgent] !== undefined) return [];
  const problems: Problem[] = [];
  const say = (message: string, notify: boolean) => problems.push({ message: `${harness.name}: ${message}`, notify });

  const agents = recordAt(config, "agent");
  const commands = recordAt(config, "command");
  const skills = recordAt(config, "skills");
  if (agents === undefined || commands === undefined || skills === undefined) {
    say("the opencode config has an unexpected shape, so the harness was not switched on", true);
    return problems;
  }

  for (const [id, entry] of Object.entries(harness.v1.agents)) {
    if (agents[id] !== undefined) {
      say(`the agent ${id} is defined elsewhere (this project or your opencode config), so that definition is used, not the harness's`, true);
      continue;
    }
    agents[id] = structuredClone(entry);
  }
  for (const [id, entry] of Object.entries(harness.v1.commands)) {
    if (commands[id] !== undefined) {
      say(`the command /${id} is defined elsewhere (this project or your opencode config), so that one runs, not the harness's`, false);
      continue;
    }
    commands[id] = structuredClone(entry);
  }

  const dir = options.skillsDir;
  const missing = dir === undefined ? harness.v1.skills : harness.v1.skills.filter((id) => options.readFile(path.join(dir, id, "SKILL.md")) === undefined);
  if (dir === undefined || missing.length > 0) {
    say(`the skills folder next to the plugin is incomplete (${missing.join(", ")} not found${dir === undefined ? "" : ` in ${dir}`}), so lead cannot load them; check the checkout`, true);
    return problems;
  }
  const paths = Array.isArray(skills.paths) ? skills.paths : [];
  if (!paths.includes(dir)) skills.paths = [...paths, dir];
  return problems;
}

/** The skills folder next to the folder a bundle file is in: `<dist>/plugins/x.js` gives `<dist>/skills`. */
export function skillsDirOf(bundleFile: string | undefined): string | undefined {
  if (bundleFile === undefined || bundleFile === "") return undefined;
  return path.join(path.dirname(path.dirname(bundleFile)), "skills");
}
