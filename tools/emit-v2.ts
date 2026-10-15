// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Emitter for opencode 2, tested on 2.0.29 (written against 2.0.16, whose agent and model
// schemas 2.0.29 keeps). Paths are relative to dist/opencode-v2/ and mirror a v2 config
// directory (the global ~/.config/opencode/ or a project's .opencode/):
//
//   agents/<id>.md        native agent: frontmatter, then the prompt as the system prompt
//   commands/<id>.md      command: frontmatter, then the template
//   skills/<id>/SKILL.md  skill: name and description, plus metadata when hidden
//
// and, apart from that layout, the central install's template (v2CentralFiles):
//
//   central/opencode.json             agents and commands inline, for OPENCODE_CONFIG
//   central/prompts/<id>.md           an agent's prompt, without frontmatter
//   central/prompts/commands/<id>.md  a command's template, without frontmatter
//
// opencode 2.0.16 silently drops an agent file whose frontmatter fails validation, and reads a
// file with any unknown frontmatter key as a legacy v1 agent. So this emitter writes only
// native keys and checks every value against the 2.0.16 rules before writing. Evidence for
// each choice is in docs/research/opencode-v2.md.

import { withFrontmatter, type YamlValue } from "./frontmatter.ts";
import { compareBytes } from "./util.ts";
import type {
  AgentMode,
  Emitter,
  MappedAction,
  OutputFile,
  ResolvedAgent,
  ResolvedCommand,
  ResolvedHarness,
  ResolvedSkill,
  Rule,
} from "./types.ts";

/** The opencode version this output is written and tested for. */
export const V2_VERSION = "2.0.29";

/** Neutral action to opencode 2 permission action (the same names at 2.0.16 and 2.0.29). */
export const V2_ACTIONS: Readonly<Record<MappedAction, string>> = {
  read: "read",
  edit: "edit", // also covers the write and patch tools
  glob: "glob",
  grep: "grep",
  shell: "shell",
  delegate: "subagent",
  skill: "skill",
  question: "question",
  webfetch: "webfetch",
  websearch: "websearch",
  external_directory: "external_directory",
  execute: "execute", // Code Mode: MCP tools, MCP resources, file-diff and opencode's own tools
};

// Validation rules copied from opencode 2.0.16 (schema/src/config/agent.ts and
// schema/src/config/model.ts). A value that breaks them makes 2.0.16 drop the whole agent.
const COLOR = /^#[0-9a-fA-F]{6}$/;
const PROVIDER_MODEL = /^[^/#]+\/[^#]+$/;
const VARIANT = /^[^#]+$/;
// One path segment: a "/" in an id would create a nested directory and a nested agent id.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message: string): never {
  throw new Error(`emit-v2: ${message}`);
}

function checkId(kind: string, id: string): void {
  if (!ID.test(id)) fail(`${kind} id ${JSON.stringify(id)} is not a single file-name segment`);
}

/** `provider/model` or `provider/model#variant`, the v2 model reference; undefined for the session model. */
export function v2Model(owner: string, model?: string, variant?: string): string | undefined {
  if (model === undefined) {
    if (variant !== undefined) fail(`${owner}: variant ${JSON.stringify(variant)} needs a model in opencode 2`);
    return undefined;
  }
  if (!PROVIDER_MODEL.test(model)) fail(`${owner}: model ${JSON.stringify(model)} is not provider/model without "#"`);
  if (variant === undefined) return model;
  if (!VARIANT.test(variant)) fail(`${owner}: variant ${JSON.stringify(variant)} must not contain "#"`);
  return `${model}#${variant}`;
}

/** A rule as the `permissions` frontmatter list takes it. */
export type V2Rule = { action: string; resource: string; effect: string };

/** Map neutral rules to v2 rules, keeping their order (the last matching rule wins in v2). */
export function v2Permissions(rules: readonly Rule[]): V2Rule[] {
  return rules.map((rule) =>
    // A tool rule is keyed by the tool id, with the pattern "*" (the tool takes no resource).
    rule.action === "tool"
      ? { action: rule.resource, resource: "*", effect: rule.effect }
      : { action: V2_ACTIONS[rule.action], resource: rule.resource, effect: rule.effect },
  );
}

/** The frontmatter of an agent file; the plugin embeds the same data (tools/bundle-plugin.ts). */
export function v2AgentFrontmatter(agent: ResolvedAgent): { [key: string]: YamlValue } {
  checkId("agent", agent.id);
  const owner = `agent ${agent.id}`;
  // An empty body leaves the agent without a system prompt, and 2.0.16 then uses its own.
  if (agent.prompt.trim() === "") fail(`${owner}: empty prompt`);
  const data: { [key: string]: YamlValue } = {
    description: agent.description,
    mode: agent.mode,
  };
  const model = v2Model(owner, agent.model, agent.variant);
  if (model !== undefined) data.model = model;
  if (agent.steps !== undefined) {
    if (!Number.isInteger(agent.steps) || agent.steps < 1) fail(`${owner}: steps must be a positive integer`);
    data.steps = agent.steps;
  }
  if (agent.color !== undefined) {
    if (!COLOR.test(agent.color)) fail(`${owner}: color ${JSON.stringify(agent.color)} is not #RRGGBB`);
    data.color = agent.color;
  }
  const permissions = v2Permissions(agent.permissions);
  if (permissions.length > 0) data.permissions = permissions;
  return data;
}

export function v2AgentFile(agent: ResolvedAgent, marker: string): OutputFile {
  return { path: `agents/${agent.id}.md`, content: withFrontmatter(v2AgentFrontmatter(agent), agent.prompt, [marker]) };
}

/** The frontmatter of a command file. */
export function v2CommandFrontmatter(command: ResolvedCommand, modes: ReadonlyMap<string, AgentMode>): { [key: string]: YamlValue } {
  checkId("command", command.id);
  const data: { [key: string]: YamlValue } = {
    description: command.description,
    agent: command.agent,
  };
  // 2.0.16 runs a command in a background child session when `subagent` is true, and also when
  // it is left out and the command's agent is a subagent. `subagent: false` runs it in the
  // current session, but first switches that session to the command's agent for good
  // (core/src/config/plugin/command.ts:124-131), so the user's next message would go to the
  // helper instead of lead. A helper's command therefore always runs in a child session here,
  // whatever `subtask` says; the parent agent then gets a turn to relay the result. The plugin
  // replaces these commands with its own, which answer in the user's session (plugin/inline.ts).
  if (command.subtask || modes.get(command.agent) === "subagent") data.subagent = true;
  return data;
}

export function v2CommandFile(command: ResolvedCommand, marker: string, modes: ReadonlyMap<string, AgentMode>): OutputFile {
  return { path: `commands/${command.id}.md`, content: withFrontmatter(v2CommandFrontmatter(command, modes), command.template, [marker]) };
}

/** The frontmatter of a skill file. */
export function v2SkillFrontmatter(skill: ResolvedSkill): { [key: string]: YamlValue } {
  checkId("skill", skill.id);
  // The directory name is the skill id in 2.0.16; `name` is only a display label.
  const data: { [key: string]: YamlValue } = {
    name: skill.id,
    description: skill.description,
  };
  // Left out of the model's skill list but still loadable by id. 2.0.16 reads booleans and the
  // strings "true" and "false" here; the string keeps metadata a string map, as the Agent Skills
  // format asks.
  if (skill.hidden) data.metadata = { "opencode/autoinvoke": "false" };
  return data;
}

export function v2SkillFile(skill: ResolvedSkill, marker: string): OutputFile {
  return { path: `skills/${skill.id}/SKILL.md`, content: withFrontmatter(v2SkillFrontmatter(skill), skill.body, [marker]) };
}

/** The folder of the central install's template; the installer does not install it as it is. */
export const CENTRAL_DIR = "central";
/** Stands for the central folder's absolute path in the template; the installer fills it in. */
export const CENTRAL_PLACEHOLDER = "@ECMWF_MULTI_AGENTS_DIR@";

/**
 * The central install's template (docs/research/opencode-v2.md, section 13): an `opencode.json`
 * that `OPENCODE_CONFIG` names, with every agent and command inline and their text in prompt
 * files through `{file:}`, which opencode reads relative to the config file and trims. Agents
 * from config files merge field by field, so each agent sets every field the harness defines,
 * and `hidden`, over a user's own agent of the same name. The default agent is left to the
 * plugin, so a user's own `default_agent` and the `default_agent` setting keep working.
 */
export function v2CentralFiles(harness: ResolvedHarness): OutputFile[] {
  const modes = new Map(harness.agents.map((agent) => [agent.id, agent.mode] as const));
  const prompts: OutputFile[] = [];
  const agents: { [id: string]: { [key: string]: YamlValue } } = {};
  for (const agent of [...harness.agents].sort((a, b) => compareBytes(a.id, b.id))) {
    const data = v2AgentFrontmatter(agent);
    agents[agent.id] = {
      ...data,
      permissions: data.permissions ?? [],
      hidden: false,
      system: `{file:./prompts/${agent.id}.md}`,
    };
    prompts.push({ path: `${CENTRAL_DIR}/prompts/${agent.id}.md`, content: agent.prompt.trim() });
  }
  const commands: { [id: string]: { [key: string]: YamlValue } } = {};
  for (const command of [...harness.commands].sort((a, b) => compareBytes(a.id, b.id))) {
    commands[command.id] = { ...v2CommandFrontmatter(command, modes), template: `{file:./prompts/commands/${command.id}.md}` };
    prompts.push({ path: `${CENTRAL_DIR}/prompts/commands/${command.id}.md`, content: command.template.trim() });
  }
  const config = {
    agents,
    commands,
    skills: [`${CENTRAL_PLACEHOLDER}/skills`],
    plugins: [{ package: `${CENTRAL_PLACEHOLDER}/plugins/${harness.name}`, options: { site: `${CENTRAL_PLACEHOLDER}/${harness.name}.jsonc` } }],
  };
  return [{ path: `${CENTRAL_DIR}/opencode.json`, content: JSON.stringify(config, null, 2) }, ...prompts].sort((a, b) => compareBytes(a.path, b.path));
}

export const emitV2: Emitter = (harness: ResolvedHarness): OutputFile[] => {
  const modes = new Map(harness.agents.map((agent) => [agent.id, agent.mode] as const));
  const files = [
    ...harness.agents.map((agent) => v2AgentFile(agent, harness.marker)),
    ...harness.commands.map((command) => v2CommandFile(command, harness.marker, modes)),
    ...harness.skills.map((skill) => v2SkillFile(skill, harness.marker)),
  ];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) fail(`two outputs for ${file.path}`);
    seen.add(file.path);
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};
