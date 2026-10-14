// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Emitter for opencode 2, tested on 2.0.28 (written against 2.0.16, whose agent and model
// schemas 2.0.28 keeps). Paths are relative to dist/opencode-v2/ and mirror a v2 config
// directory (the global ~/.config/opencode/ or a project's .opencode/):
//
//   agents/<id>.md        native agent: frontmatter, then the prompt as the system prompt
//   commands/<id>.md      command: frontmatter, then the template
//   skills/<id>/SKILL.md  skill: name and description, plus metadata when hidden
//
// opencode 2.0.16 silently drops an agent file whose frontmatter fails validation, and reads a
// file with any unknown frontmatter key as a legacy v1 agent. So this emitter writes only
// native keys and checks every value against the 2.0.16 rules before writing. Evidence for
// each choice is in docs/research/opencode-v2.md.

import { withFrontmatter, type YamlValue } from "./frontmatter.ts";
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
export const V2_VERSION = "2.0.28";

/**
 * Neutral action to opencode 2 permission action (the same names at 2.0.16 and 2.0.28). `null`
 * means opencode 2 has no such action, so rules for it are left out and recorded as a
 * frontmatter comment.
 */
export const V2_ACTIONS: Readonly<Record<MappedAction, string | null>> = {
  read: "read",
  edit: "edit", // also covers the write and patch tools
  glob: "glob",
  grep: "grep",
  // No list tool: the read tool lists directories. Mapping list rules onto read would change
  // which files can be read, so they are dropped instead.
  list: null,
  shell: "shell",
  delegate: "subagent",
  skill: "skill",
  question: "question",
  webfetch: "webfetch",
  websearch: "websearch",
  todo: null, // no todo tool
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

export interface V2Permissions {
  /** Ordered v2 rules, ready for the `permissions` frontmatter list. */
  rules: { action: string; resource: string; effect: string }[];
  /** Neutral rules with no 2.0.16 action, in their original order. */
  dropped: Rule[];
}

/** Map neutral rules to v2 rules, keeping their order (the last matching rule wins in v2). */
export function v2Permissions(rules: readonly Rule[]): V2Permissions {
  const out: V2Permissions = { rules: [], dropped: [] };
  for (const rule of rules) {
    // A tool rule is keyed by the tool id, with the pattern "*" (the tool takes no resource).
    if (rule.action === "tool") {
      out.rules.push({ action: rule.resource, resource: "*", effect: rule.effect });
      continue;
    }
    const action = V2_ACTIONS[rule.action];
    if (action === null) out.dropped.push(rule);
    else out.rules.push({ action, resource: rule.resource, effect: rule.effect });
  }
  return out;
}

function droppedComment(rule: Rule): string {
  return `# no ${rule.action} action in opencode ${V2_VERSION}, rule left out: ${rule.action} ${JSON.stringify(rule.resource)} ${rule.effect}`;
}

export function v2AgentFile(agent: ResolvedAgent, marker: string): OutputFile {
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
  if (permissions.rules.length > 0) data.permissions = permissions.rules;
  const comments = [marker, ...permissions.dropped.map(droppedComment)];
  return { path: `agents/${agent.id}.md`, content: withFrontmatter(data, agent.prompt, comments) };
}

export function v2CommandFile(command: ResolvedCommand, marker: string, modes: ReadonlyMap<string, AgentMode>): OutputFile {
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
  // whatever `subtask` says; the parent agent then gets a turn to relay the result.
  if (command.subtask || modes.get(command.agent) === "subagent") data.subagent = true;
  return { path: `commands/${command.id}.md`, content: withFrontmatter(data, command.template, [marker]) };
}

export function v2SkillFile(skill: ResolvedSkill, marker: string): OutputFile {
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
  return { path: `skills/${skill.id}/SKILL.md`, content: withFrontmatter(data, skill.body, [marker]) };
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
