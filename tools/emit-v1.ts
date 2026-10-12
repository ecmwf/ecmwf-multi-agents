// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Emitter for opencode 1.x (tested on 1.18.35 and 1.19.0). Paths are relative to
// dist/opencode-v1/ and mirror a v1 config directory (the global ~/.config/opencode/, a
// project's .opencode/, or OPENCODE_CONFIG_DIR):
//
//   agents/<id>.md        agent: frontmatter, then the prompt, which replaces opencode's own
//   commands/<id>.md      command: frontmatter, then the template
//   skills/<id>/SKILL.md  skill: name and description; a hidden skill has no description
//
// One invalid value in any agent file makes opencode 1.x reject the whole configuration and
// refuse to start, and unknown frontmatter keys are passed to the model provider as options.
// So this emitter writes only known keys and checks every value before writing. Evidence for
// each choice is in docs/research/opencode-v1.md.

import { withFrontmatter, type YamlValue } from "./frontmatter.ts";
import type {
  AgentMode,
  Effect,
  Emitter,
  MappedAction,
  OutputFile,
  ResolvedAgent,
  ResolvedCommand,
  ResolvedHarness,
  ResolvedSkill,
  Rule,
} from "./types.ts";

/** The opencode versions this output is written and tested for. */
export const V1_VERSIONS = ["1.18.35", "1.19.0"] as const;

/**
 * Neutral action to opencode 1.x permission key. `null` means opencode 1.x has no such
 * feature, so rules for it have nothing to control and are left out.
 */
export const V1_ACTIONS: Readonly<Record<MappedAction, string | null>> = {
  read: "read",
  edit: "edit", // also covers the write and apply_patch tools
  glob: "glob",
  grep: "grep",
  list: "list",
  shell: "bash",
  delegate: "task",
  skill: "skill",
  question: "question",
  webfetch: "webfetch",
  websearch: "websearch",
  todo: "todowrite",
  external_directory: "external_directory",
  execute: null, // Code Mode exists only in opencode 2
};
// A `tool` rule is keyed by the tool id in its resource, as a flat key (one effect for the tool).

/**
 * Permission keys that take only one action for every resource. An object here is a schema
 * error that stops opencode 1.x from starting, so their rules collapse to the last effect.
 */
export const V1_FLAT_KEYS: ReadonlySet<string> = new Set(["todowrite", "question", "webfetch", "websearch", "doom_loop"]);

/** Theme color names opencode 1.x accepts besides #RRGGBB. */
export const V1_THEME_COLORS: ReadonlySet<string> = new Set([
  "primary",
  "secondary",
  "accent",
  "success",
  "warning",
  "error",
  "info",
]);

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
// opencode splits a model reference at the first "/" into provider and model.
const PROVIDER_MODEL = /^[^/\s]+\/\S+$/;
// One path segment: a "/" in an id would create a nested file and a nested name such as "a/b".
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// JavaScript objects list array-index keys first, whatever their insertion order, so a pattern
// like this cannot keep its place in an ordered permission map.
const ARRAY_INDEX = /^(0|[1-9][0-9]{0,9})$/;

function fail(message: string): never {
  throw new Error(`emit-v1: ${message}`);
}

function checkId(kind: string, id: string): void {
  if (!ID.test(id)) fail(`${kind} id ${JSON.stringify(id)} is not a single file-name segment`);
}

/** Normalise line endings to LF. */
function lf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** The color to write, or undefined when it is unset or a value opencode 1.x would reject. */
export function v1Color(color?: string): string | undefined {
  if (color === undefined) return undefined;
  return HEX_COLOR.test(color) || V1_THEME_COLORS.has(color) ? color : undefined;
}

/**
 * Map neutral rules to an opencode 1.x permission map. Keys appear in the order of their first
 * rule and patterns keep their relative order, so the last matching rule still wins. A repeated
 * pattern moves to its latest position: the earlier copy could never be the last match.
 */
export function v1Permission(rules: readonly Rule[], owner = "rules"): { [key: string]: YamlValue } {
  const grouped = new Map<string, Map<string, Effect>>();
  for (const rule of rules) {
    if (rule.action === "tool") {
      grouped.delete(rule.resource);
      grouped.set(rule.resource, new Map([["*", rule.effect]]));
      continue;
    }
    const key = V1_ACTIONS[rule.action];
    if (key === undefined) fail(`${owner}: unknown action ${JSON.stringify(rule.action)}`);
    if (key === null) continue;
    if (V1_FLAT_KEYS.has(key) && rule.resource !== "*") {
      fail(`${owner}: ${rule.action} takes one action for every resource in opencode 1.x; got resource ${JSON.stringify(rule.resource)}`);
    }
    if (ARRAY_INDEX.test(rule.resource)) {
      fail(`${owner}: pattern ${JSON.stringify(rule.resource)} for ${rule.action} cannot keep its order in an opencode 1.x permission map`);
    }
    let patterns = grouped.get(key);
    if (patterns === undefined) {
      patterns = new Map();
      grouped.set(key, patterns);
    }
    patterns.delete(rule.resource);
    patterns.set(rule.resource, rule.effect);
  }
  const out: { [key: string]: YamlValue } = {};
  for (const [key, patterns] of grouped) {
    if (V1_FLAT_KEYS.has(key) || isToolKey(key, rules)) {
      out[key] = [...patterns.values()].at(-1)!;
      continue;
    }
    const map: { [pattern: string]: YamlValue } = {};
    for (const [pattern, effect] of patterns) map[pattern] = effect;
    out[key] = map;
  }
  return out;
}

/** True when the key comes from a `tool` rule, which opencode 1.x keeps as a flat key. */
function isToolKey(key: string, rules: readonly Rule[]): boolean {
  return rules.some((rule) => rule.action === "tool" && rule.resource === key);
}

export function v1AgentFile(agent: ResolvedAgent, marker: string): OutputFile {
  checkId("agent", agent.id);
  const owner = `agent ${agent.id}`;
  // An empty body leaves the agent without a prompt, and opencode 1.x then sends its own.
  if (agent.prompt.trim() === "") fail(`${owner}: empty prompt`);
  const data: { [key: string]: YamlValue } = {
    description: lf(agent.description),
    mode: agent.mode,
  };
  if (agent.model !== undefined) {
    if (!PROVIDER_MODEL.test(agent.model)) fail(`${owner}: model ${JSON.stringify(agent.model)} is not provider/model`);
    data.model = agent.model;
  }
  if (agent.variant !== undefined) {
    // opencode 1.x applies an agent's variant only while the agent runs on its own model.
    if (agent.model === undefined) fail(`${owner}: variant ${JSON.stringify(agent.variant)} needs a model`);
    if (agent.variant.trim() === "" || /\s/.test(agent.variant)) fail(`${owner}: variant ${JSON.stringify(agent.variant)} is not a single word`);
    data.variant = agent.variant;
  }
  if (agent.steps !== undefined) {
    if (!Number.isInteger(agent.steps) || agent.steps < 1) fail(`${owner}: steps must be a positive integer`);
    data.steps = agent.steps;
  }
  const color = v1Color(agent.color);
  if (color !== undefined) data.color = color;
  const permission = v1Permission(agent.permissions, owner);
  if (Object.keys(permission).length > 0) data.permission = permission;
  return { path: `agents/${agent.id}.md`, content: withFrontmatter(data, lf(agent.prompt), [marker]) };
}

export function v1CommandFile(
  command: ResolvedCommand,
  marker: string,
  modes: ReadonlyMap<string, AgentMode>,
): OutputFile {
  checkId("command", command.id);
  const data: { [key: string]: YamlValue } = {
    description: lf(command.description),
    agent: command.agent,
  };
  // opencode 1.x runs a command as a subtask when `subtask` is true, and also when it is left
  // out and the command's agent is a subagent. `subtask: false` keeps such a command in the
  // current session, which is what a neutral `subtask: false` means.
  if (command.subtask) data.subtask = true;
  else if (modes.get(command.agent) === "subagent") data.subtask = false;
  return { path: `commands/${command.id}.md`, content: withFrontmatter(data, lf(command.template), [marker]) };
}

export function v1SkillFile(skill: ResolvedSkill, marker: string): OutputFile {
  checkId("skill", skill.id);
  // opencode 1.x keys skills by the frontmatter name. Skills without a description stay out
  // of the model's skill list but still load by exact name through the skill tool.
  const data: { [key: string]: YamlValue } = { name: skill.id };
  if (!skill.hidden) data.description = lf(skill.description);
  return { path: `skills/${skill.id}/SKILL.md`, content: withFrontmatter(data, lf(skill.body), [marker]) };
}

export const emitV1: Emitter = (harness: ResolvedHarness): OutputFile[] => {
  if (/[\r\n]/.test(harness.marker)) fail("marker must be a single line");
  const modes = new Map(harness.agents.map((agent) => [agent.id, agent.mode] as const));
  const files = [
    ...harness.agents.map((agent) => v1AgentFile(agent, harness.marker)),
    ...harness.commands.map((command) => v1CommandFile(command, harness.marker, modes)),
    ...harness.skills.map((skill) => v1SkillFile(skill, harness.marker)),
  ];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) fail(`two outputs for ${file.path}`);
    seen.add(file.path);
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};
