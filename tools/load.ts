// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Reads src/manifest.jsonc, src/profiles/*.jsonc, the Markdown files the manifest names and the
// VERSION file at the repository root, and validates them strictly. Unknown keys, wrong types,
// broken references and Markdown that would leak frontmatter or comments into a prompt are
// errors. Every problem names its file and key path, and all problems are reported together.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type Node, type ParseError, parseTree, printParseErrorCode } from "jsonc-parser";
import { EFFORT_PATTERN, MODEL_PATTERN } from "../plugin/settings.ts";
import { ACTIONS, PLATFORM_TOOL_IDS, TOOL_ID, type Action, type AgentMode, type Effect, type Profile, type ProfileAgent } from "./types.ts";
import {
  compareBytes,
  errorCode,
  formatKeyPath,
  GeneratorError,
  type KeyPath,
  listWords,
  unsafePathReason,
} from "./util.ts";

export const MANIFEST_FILE = "src/manifest.jsonc";
export const PROFILES_DIR = "src/profiles";
/** One line with the harness version, relative to the repository root. */
export const VERSION_FILE = "VERSION";

export const MODES = ["primary", "subagent"] as const;
export const EFFECTS = ["allow", "ask", "deny"] as const;

export const AGENT_ID = /^[a-z][a-z0-9-]*$/;
/** Budget, rule set and command names take the same form as agent ids. */
export const NAME = /^[a-z][a-z0-9-]*$/;
export const SKILL_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_ID_MAX = 64;
export const PROFILE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** A lowercase provider id, "/", then the model id. Profile models must also match MODEL_PATTERN. */
export const PROFILE_MODEL = /^[a-z0-9][a-z0-9._-]*\/.+$/;
/** The harness version: three whole numbers separated by dots, such as 1.2.3, with no "v". */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export interface RuleSetItem {
  action: Action;
  resource: string;
}

export interface RuleEntry {
  action: Action;
  resource: string;
  effect: Effect;
}

/** Expands to one rule per item of the named rule set, each with this effect. */
export interface UseEntry {
  use: string;
  effect: Effect;
}

export type PermissionEntry = RuleEntry | UseEntry;

export interface SourceAgent {
  id: string;
  mode: AgentMode;
  description: string;
  /** Prompt files, relative to src/, joined in this order. */
  prompt: string[];
  /** Name of the budget the prompt is checked against. */
  budget: string;
  steps?: number;
  color?: string;
  permissions: PermissionEntry[];
}

export interface SourceCommand {
  id: string;
  description: string;
  agent: string;
  /** Template file, relative to src/. */
  template: string;
  subtask: boolean;
}

export interface SourceSkill {
  id: string;
  description: string;
  /** Body file, relative to src/. */
  body: string;
  hidden: boolean;
}

export interface Manifest {
  name: string;
  defaultAgent: string;
  defaultProfile: string;
  workDir: string;
  marker: string;
  budgets: ReadonlyMap<string, number>;
  ruleSets: ReadonlyMap<string, readonly RuleSetItem[]>;
  /** In manifest order, as are commands and skills. */
  agents: SourceAgent[];
  commands: SourceCommand[];
  skills: SourceSkill[];
}

export interface Source {
  /** Repository root: the directory that holds src/ and dist/. */
  root: string;
  /** From the VERSION file. */
  version: string;
  manifest: Manifest;
  /** In byte order of their ids. */
  profiles: Profile[];
  /** Raw text of every Markdown file the manifest names, keyed by its path relative to src/. */
  markdown: ReadonlyMap<string, string>;
}

const TOP_KEYS = [
  "name",
  "defaultAgent",
  "defaultProfile",
  "workDir",
  "marker",
  "budgets",
  "ruleSets",
  "agents",
  "commands",
  "skills",
];
const TOP_REQUIRED = ["name", "defaultAgent", "defaultProfile", "workDir", "marker", "budgets", "agents"];
const AGENT_KEYS = ["mode", "description", "prompt", "budget", "steps", "color", "permissions"];
const AGENT_REQUIRED = ["mode", "description", "prompt", "budget"];
const RULE_KEYS = ["action", "resource", "effect"];
const USE_KEYS = ["use", "effect"];
const RULE_SET_ITEM_KEYS = ["action", "resource"];
const COMMAND_KEYS = ["description", "agent", "template", "subtask"];
const COMMAND_REQUIRED = ["description", "agent", "template"];
const SKILL_KEYS = ["description", "body", "hidden"];
const SKILL_REQUIRED = ["description", "body"];
const PROFILE_KEYS = ["description", "agents"];
const PROFILE_AGENT_KEYS = ["model", "effort"];

// ---------------------------------------------------------------------------------------------
// JSONC

const PARSE_MESSAGES: Readonly<Record<string, string>> = {
  InvalidSymbol: "unexpected symbol",
  InvalidNumberFormat: "invalid number",
  PropertyNameExpected: "expected a property name in double quotes",
  ValueExpected: "expected a value",
  ColonExpected: "expected a colon",
  CommaExpected: "expected a comma",
  CloseBraceExpected: "expected a closing brace",
  CloseBracketExpected: "expected a closing bracket",
  EndOfFileExpected: "expected the end of the file",
  InvalidCommentToken: "invalid comment",
  UnexpectedEndOfComment: "comment is not closed",
  UnexpectedEndOfString: "string is not closed",
  UnexpectedEndOfNumber: "number is not complete",
  InvalidUnicode: "invalid unicode escape",
  InvalidEscapeCharacter: "invalid escape character",
  InvalidCharacter: "invalid character",
};

/** Line and column, both counted from 1, of an offset in `text`. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  const end = Math.min(Math.max(offset, 0), text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      start = i + 1;
    }
  }
  return { line, column: end - start + 1 };
}

// Key order of parsed objects as written. JavaScript lists integer-like keys first whatever
// their insertion order, so manifest order comes from here.
const KEY_ORDER = new WeakMap<object, readonly string[]>();

function keysOf(value: Record<string, unknown>): readonly string[] {
  return KEY_ORDER.get(value) ?? Object.keys(value);
}

function entries(value: Record<string, unknown>): [string, unknown][] {
  return keysOf(value).map((key) => [key, value[key]]);
}

function nodeValue(node: Node, text: string, file: string, at: KeyPath, problems: string[]): unknown {
  if (node.type === "array") {
    return (node.children ?? []).map((child, index) => nodeValue(child, text, file, [...at, index], problems));
  }
  if (node.type !== "object") return node.value as unknown;
  const out: Record<string, unknown> = {};
  const order: string[] = [];
  for (const property of node.children ?? []) {
    const [keyNode, valueNode] = property.children ?? [];
    if (keyNode === undefined || valueNode === undefined) continue;
    const key = String(keyNode.value);
    if (Object.hasOwn(out, key)) {
      const { line, column } = lineColumn(text, keyNode.offset);
      problems.push(`${file}:${line}:${column}: ${formatKeyPath([...at, key])}: duplicate key`);
      continue;
    }
    // defineProperty keeps a key such as "__proto__" as plain data.
    Object.defineProperty(out, key, {
      value: nodeValue(valueNode, text, file, [...at, key], problems),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    order.push(key);
  }
  KEY_ORDER.set(out, order);
  return out;
}

/** Parse JSONC into `problems`; undefined when the text has syntax errors. */
function parseInto(text: string, file: string, problems: string[]): unknown {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false });
  if (errors.length > 0 || tree === undefined) {
    for (const error of errors) {
      const { line, column } = lineColumn(text, error.offset);
      const name = printParseErrorCode(error.error);
      problems.push(`${file}:${line}:${column}: ${PARSE_MESSAGES[name] ?? name}`);
    }
    if (errors.length === 0) problems.push(`${file}: holds no value`);
    return undefined;
  }
  return nodeValue(tree, text, file, [], problems);
}

/**
 * Parse JSONC text: comments and trailing commas are allowed. Throws a GeneratorError listing
 * every syntax error with its line and column, and every duplicate key.
 */
export function parseJsonc(text: string, file: string): unknown {
  const problems: string[] = [];
  const value = parseInto(text, file, problems);
  if (problems.length > 0) throw new GeneratorError(`${file} is not valid JSONC:`, problems);
  return value;
}

// ---------------------------------------------------------------------------------------------
// Validation helpers

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "an empty list" : "a list";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return value.trim() === "" ? "an empty string" : JSON.stringify(value);
  if (typeof value === "number") return `the number ${value}`;
  if (typeof value === "boolean") return String(value);
  return typeof value;
}

function known(names: readonly string[]): string {
  return names.length === 0 ? "none" : listWords(names, "and");
}

class Checker {
  constructor(
    readonly file: string,
    readonly problems: string[],
  ) {}

  fail(at: KeyPath, message: string): void {
    this.problems.push(`${this.file}: ${formatKeyPath(at)}: ${message}`);
  }

  /** Reports unknown keys and missing required keys. */
  keys(value: Record<string, unknown>, at: KeyPath, allowed: readonly string[], required: readonly string[]): void {
    for (const key of keysOf(value)) {
      if (!allowed.includes(key)) this.fail([...at, key], `unknown key; allowed keys are ${listWords(allowed, "and")}`);
    }
    for (const key of required) {
      if (!Object.hasOwn(value, key)) this.fail([...at, key], "required key is missing");
    }
  }

  object(value: unknown, at: KeyPath): Record<string, unknown> | undefined {
    if (isObject(value)) return value;
    this.fail(at, `must be an object, not ${kind(value)}`);
    return undefined;
  }

  // The value checks below return undefined without a problem when the value is absent;
  // `keys` reports missing required keys.

  text(value: unknown, at: KeyPath): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string" && value.trim() !== "") return value;
    this.fail(at, `must be a non-empty string, not ${kind(value)}`);
    return undefined;
  }

  choice<T extends string>(value: unknown, at: KeyPath, choices: readonly T[]): T | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string" && (choices as readonly string[]).includes(value)) return value as T;
    this.fail(at, `must be ${listWords(choices.map((choice) => JSON.stringify(choice)))}, not ${kind(value)}`);
    return undefined;
  }

  boolean(value: unknown, at: KeyPath): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "boolean") return value;
    this.fail(at, `must be true or false, not ${kind(value)}`);
    return undefined;
  }

  positiveInteger(value: unknown, at: KeyPath): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
    this.fail(at, `must be a whole number of at least 1, not ${kind(value)}`);
    return undefined;
  }

  /** A path to a Markdown file, relative to src/. */
  markdownPath(value: unknown, at: KeyPath): string | undefined {
    const file = this.text(value, at);
    if (file === undefined) return undefined;
    const reason = unsafePathReason(file);
    if (reason !== undefined) {
      this.fail(at, `path ${JSON.stringify(file)} ${reason}; paths are relative to src/`);
      return undefined;
    }
    if (!file.endsWith(".md")) {
      this.fail(at, `path ${JSON.stringify(file)} must name a Markdown file ending in .md`);
      return undefined;
    }
    return file;
  }
}

interface MarkdownRef {
  /** Relative to src/. */
  file: string;
  /** Where the manifest names the file. */
  at: KeyPath;
  template: boolean;
}

// ---------------------------------------------------------------------------------------------
// Manifest

function readBudgets(value: unknown, c: Checker): Map<string, number> {
  const out = new Map<string, number>();
  if (value === undefined) return out;
  const map = c.object(value, ["budgets"]);
  if (map === undefined) return out;
  for (const [name, limit] of entries(map)) {
    const at = ["budgets", name];
    if (!NAME.test(name)) c.fail(at, `budget name must match ${NAME.source}`);
    // An invalid limit still declares the name, so agents that use it get no second problem.
    out.set(name, c.positiveInteger(limit, at) ?? 0);
  }
  return out;
}

function readRuleSets(value: unknown, c: Checker): Map<string, RuleSetItem[]> {
  const out = new Map<string, RuleSetItem[]>();
  if (value === undefined) return out;
  const map = c.object(value, ["ruleSets"]);
  if (map === undefined) return out;
  for (const [name, list] of entries(map)) {
    const at: KeyPath = ["ruleSets", name];
    const items: RuleSetItem[] = [];
    out.set(name, items);
    if (!NAME.test(name)) c.fail(at, `rule set name must match ${NAME.source}`);
    if (!Array.isArray(list) || list.length === 0) {
      c.fail(at, `must be a non-empty list of {"action", "resource"} items, not ${kind(list)}`);
      continue;
    }
    list.forEach((item: unknown, index) => {
      const itemAt = [...at, index];
      const entry = c.object(item, itemAt);
      if (entry === undefined) return;
      c.keys(entry, itemAt, RULE_SET_ITEM_KEYS, RULE_SET_ITEM_KEYS);
      const action = c.choice(entry.action, [...itemAt, "action"], ACTIONS);
      const resource = readResource(entry.resource, c, [...itemAt, "resource"], action);
      if (action !== undefined && resource !== undefined) items.push({ action, resource });
    });
  }
  return out;
}

function readPermissions(
  value: unknown,
  c: Checker,
  at: KeyPath,
  ruleSets: ReadonlyMap<string, readonly RuleSetItem[]>,
): PermissionEntry[] {
  const out: PermissionEntry[] = [];
  if (value === undefined) return out;
  if (!Array.isArray(value)) {
    c.fail(at, `must be a list, not ${kind(value)}`);
    return out;
  }
  value.forEach((item: unknown, index) => {
    const entryAt = [...at, index];
    const entry = c.object(item, entryAt);
    if (entry === undefined) return;
    const effect = c.choice(entry.effect, [...entryAt, "effect"], EFFECTS);
    if (Object.hasOwn(entry, "use")) {
      c.keys(entry, entryAt, USE_KEYS, USE_KEYS);
      const use = c.text(entry.use, [...entryAt, "use"]);
      if (use !== undefined && !ruleSets.has(use)) {
        c.fail([...entryAt, "use"], `names no rule set; rule sets: ${known([...ruleSets.keys()])}`);
      } else if (use !== undefined && effect !== undefined) {
        out.push({ use, effect });
      }
      return;
    }
    c.keys(entry, entryAt, RULE_KEYS, RULE_KEYS);
    const action = c.choice(entry.action, [...entryAt, "action"], ACTIONS);
    const resource = readResource(entry.resource, c, [...entryAt, "resource"], action);
    if (action !== undefined && resource !== undefined && effect !== undefined) out.push({ action, resource, effect });
  });
  return out;
}

/**
 * A rule's resource. For the `tool` action it is the exact id of a tool the plugin adds, so it
 * must look like one and must not be a tool opencode has itself.
 */
function readResource(value: unknown, c: Checker, at: KeyPath, action: Action | undefined): string | undefined {
  const resource = c.text(value, at);
  if (resource === undefined || action !== "tool") return resource;
  if (!TOOL_ID.test(resource)) {
    c.fail(at, `a tool rule names one tool id, lowercase words joined by underscores, not ${JSON.stringify(resource)}`);
    return undefined;
  }
  if (PLATFORM_TOOL_IDS.has(resource)) {
    c.fail(at, `${JSON.stringify(resource)} is a tool of opencode itself; use its own action instead of a tool rule`);
    return undefined;
  }
  return resource;
}

function readPromptList(value: unknown, c: Checker, at: KeyPath, refs: MarkdownRef[]): string[] {
  const out: string[] = [];
  if (value === undefined) return out;
  if (!Array.isArray(value) || value.length === 0) {
    c.fail(at, `must be a non-empty list of Markdown paths relative to src/, not ${kind(value)}`);
    return out;
  }
  value.forEach((item: unknown, index) => {
    const file = c.markdownPath(item, [...at, index]);
    if (file === undefined) return;
    if (out.includes(file)) c.fail([...at, index], `lists ${file} twice`);
    out.push(file);
    refs.push({ file, at: [...at, index], template: false });
  });
  return out;
}

function readAgents(
  value: unknown,
  c: Checker,
  budgets: ReadonlyMap<string, number>,
  ruleSets: ReadonlyMap<string, readonly RuleSetItem[]>,
  refs: MarkdownRef[],
): SourceAgent[] {
  if (value === undefined) return [];
  const map = c.object(value, ["agents"]);
  if (map === undefined) return [];
  if (keysOf(map).length === 0) c.fail(["agents"], "must define at least one agent");

  const out: SourceAgent[] = [];
  for (const [id, item] of entries(map)) {
    const at: KeyPath = ["agents", id];
    if (!AGENT_ID.test(id)) c.fail(at, `agent id must match ${AGENT_ID.source}`);
    const entry = c.object(item, at);
    if (entry === undefined) continue;
    c.keys(entry, at, AGENT_KEYS, AGENT_REQUIRED);
    const mode = c.choice(entry.mode, [...at, "mode"], MODES);
    const description = c.text(entry.description, [...at, "description"]) ?? "";
    const prompt = readPromptList(entry.prompt, c, [...at, "prompt"], refs);
    const budget = c.text(entry.budget, [...at, "budget"]);
    if (budget !== undefined && !budgets.has(budget)) {
      c.fail([...at, "budget"], `names no budget; budgets: ${known([...budgets.keys()])}`);
    }
    const steps = c.positiveInteger(entry.steps, [...at, "steps"]);
    const color = c.text(entry.color, [...at, "color"]);
    const permissions = readPermissions(entry.permissions, c, [...at, "permissions"], ruleSets);

    // A missing or invalid mode or budget has been reported, so load() fails and these stand-ins
    // are never used. The agent is still listed, so references to it raise no second problem,
    // and "primary" keeps the default agent check quiet about a mode that is already reported.
    const agent: SourceAgent = { id, mode: mode ?? "primary", description, prompt, budget: budget ?? "", permissions };
    if (steps !== undefined) agent.steps = steps;
    if (color !== undefined) agent.color = color;
    out.push(agent);
  }
  return out;
}

function readCommands(value: unknown, c: Checker, agentIds: ReadonlySet<string>, refs: MarkdownRef[]): SourceCommand[] {
  if (value === undefined) return [];
  const map = c.object(value, ["commands"]);
  if (map === undefined) return [];
  const out: SourceCommand[] = [];
  for (const [id, item] of entries(map)) {
    const at: KeyPath = ["commands", id];
    if (!NAME.test(id)) c.fail(at, `command id must match ${NAME.source}`);
    const entry = c.object(item, at);
    if (entry === undefined) continue;
    c.keys(entry, at, COMMAND_KEYS, COMMAND_REQUIRED);
    const description = c.text(entry.description, [...at, "description"]) ?? "";
    const agent = c.text(entry.agent, [...at, "agent"]) ?? "";
    if (agent !== "" && !agentIds.has(agent)) c.fail([...at, "agent"], `names no agent; agents: ${known([...agentIds])}`);
    const template = c.markdownPath(entry.template, [...at, "template"]) ?? "";
    if (template !== "") refs.push({ file: template, at: [...at, "template"], template: true });
    const subtask = c.boolean(entry.subtask, [...at, "subtask"]) ?? false;
    out.push({ id, description, agent, template, subtask });
  }
  return out;
}

function readSkills(value: unknown, c: Checker, refs: MarkdownRef[]): SourceSkill[] {
  if (value === undefined) return [];
  const map = c.object(value, ["skills"]);
  if (map === undefined) return [];
  const out: SourceSkill[] = [];
  for (const [id, item] of entries(map)) {
    const at: KeyPath = ["skills", id];
    if (!SKILL_ID.test(id)) c.fail(at, `skill id must match ${SKILL_ID.source}`);
    if (id.length > SKILL_ID_MAX) c.fail(at, `skill id has ${id.length} characters; at most ${SKILL_ID_MAX} are allowed`);
    const entry = c.object(item, at);
    if (entry === undefined) continue;
    c.keys(entry, at, SKILL_KEYS, SKILL_REQUIRED);
    const description = c.text(entry.description, [...at, "description"]) ?? "";
    const body = c.markdownPath(entry.body, [...at, "body"]) ?? "";
    if (body !== "") refs.push({ file: body, at: [...at, "body"], template: false });
    const hidden = c.boolean(entry.hidden, [...at, "hidden"]) ?? false;
    out.push({ id, description, body, hidden });
  }
  return out;
}

function workDirReason(dir: string): string | undefined {
  if (dir.startsWith("/")) return "must be relative to the project root";
  if (/[\s\\]/.test(dir)) return "must not contain spaces or backslashes";
  if (dir.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return 'must be a normalised relative path without "." or ".." segments';
  }
  return undefined;
}

function readManifest(value: unknown, c: Checker, refs: MarkdownRef[]): Manifest | undefined {
  const top = c.object(value, []);
  if (top === undefined) return undefined;
  c.keys(top, [], TOP_KEYS, TOP_REQUIRED);

  const name = c.text(top.name, ["name"]) ?? "";
  const workDir = c.text(top.workDir, ["workDir"]) ?? "";
  const workDirProblem = workDir === "" ? undefined : workDirReason(workDir);
  if (workDirProblem !== undefined) c.fail(["workDir"], workDirProblem);
  const marker = c.text(top.marker, ["marker"]) ?? "";
  if (marker !== "" && !marker.startsWith("#")) c.fail(["marker"], 'must start with "#", because it is written as a YAML comment');
  if (/[\r\n]/.test(marker)) c.fail(["marker"], "must be a single line");

  const budgets = readBudgets(top.budgets, c);
  const ruleSets = readRuleSets(top.ruleSets, c);
  const agents = readAgents(top.agents, c, budgets, ruleSets, refs);
  const agentIds = new Set(agents.map((agent) => agent.id));
  const commands = readCommands(top.commands, c, agentIds, refs);
  const skills = readSkills(top.skills, c, refs);
  if (isObject(top.budgets)) {
    if (commands.length > 0 && !budgets.has("command")) {
      c.fail(["budgets", "command"], "required key is missing; every command template is checked against it");
    }
    if (skills.length > 0 && !budgets.has("skill")) {
      c.fail(["budgets", "skill"], "required key is missing; every skill body is checked against it");
    }
  }

  const defaultAgent = c.text(top.defaultAgent, ["defaultAgent"]) ?? "";
  if (defaultAgent !== "" && isObject(top.agents)) {
    const agent = agents.find((candidate) => candidate.id === defaultAgent);
    if (agent === undefined) c.fail(["defaultAgent"], `names no agent; agents: ${known([...agentIds])}`);
    else if (agent.mode !== "primary") {
      c.fail(["defaultAgent"], `agent ${defaultAgent} is a ${agent.mode}; the default agent must be primary`);
    }
  }
  // Checked against the profile files by load().
  const defaultProfile = c.text(top.defaultProfile, ["defaultProfile"]) ?? "";

  return { name, defaultAgent, defaultProfile, workDir, marker, budgets, ruleSets, agents, commands, skills };
}

// ---------------------------------------------------------------------------------------------
// Version

/**
 * The version in the text of the VERSION file, or why it is not one. The file holds exactly one
 * line, such as "1.2.3", with or without a final line break.
 */
export function parseVersion(text: string): { version: string } | { problem: string } {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body.trim() === "") return { problem: "is empty; it must hold one line with the version, such as 1.2.3" };
  const lines = body.split("\n");
  if (lines.length > 1) return { problem: `has ${lines.length} lines; it must hold exactly one, the version, such as 1.2.3` };
  if (VERSION_PATTERN.test(body)) return { version: body };
  if (/^[vV]/.test(body) && VERSION_PATTERN.test(body.slice(1))) {
    return { problem: `${JSON.stringify(body)} starts with "${body[0]}"; write the version without it, as ${body.slice(1)}` };
  }
  return { problem: `${JSON.stringify(body)} is not a version such as 1.2.3: three whole numbers separated by dots, and nothing else` };
}

async function readVersion(root: string, problems: string[]): Promise<string> {
  const read = await readSource(path.join(root, VERSION_FILE));
  if ("error" in read) {
    problems.push(`${VERSION_FILE}: ${read.error}; it must hold the harness version, such as 1.2.3`);
    return "";
  }
  const parsed = parseVersion(read.text);
  if ("problem" in parsed) {
    problems.push(`${VERSION_FILE}: ${parsed.problem}`);
    return "";
  }
  return parsed.version;
}

// ---------------------------------------------------------------------------------------------
// Profiles

function readProfileModel(value: unknown, c: Checker, at: KeyPath): string | undefined {
  const model = c.text(value, at);
  if (model === undefined) return undefined;
  if (model.includes("#")) {
    c.fail(at, `${JSON.stringify(model)} must not contain "#"; set the effort separately`);
    return undefined;
  }
  if (!PROFILE_MODEL.test(model) || !MODEL_PATTERN.test(model)) {
    c.fail(at, `${JSON.stringify(model)} must look like provider/model, with a lowercase provider id and no spaces`);
    return undefined;
  }
  return model;
}

function readProfileEffort(value: unknown, c: Checker, at: KeyPath): string | undefined {
  const effort = c.text(value, at);
  if (effort === undefined) return undefined;
  // Written as opencode's model variant, which follows the model after "#"; variants are single words.
  if (!EFFORT_PATTERN.test(effort)) {
    c.fail(at, `${JSON.stringify(effort)} must be one word without "#", such as high`);
    return undefined;
  }
  return effort;
}

function readProfile(
  id: string,
  value: unknown,
  c: Checker,
  agentIds: ReadonlySet<string> | undefined,
): Profile | undefined {
  const top = c.object(value, []);
  if (top === undefined) return undefined;
  c.keys(top, [], PROFILE_KEYS, PROFILE_KEYS);
  const description = c.text(top.description, ["description"]) ?? "";
  const agents: Record<string, ProfileAgent> = {};
  const map = top.agents === undefined ? undefined : c.object(top.agents, ["agents"]);
  for (const [agentId, item] of map === undefined ? [] : entries(map)) {
    const at: KeyPath = ["agents", agentId];
    const knownAgent = agentIds?.has(agentId) ?? false;
    if (agentIds !== undefined && !knownAgent) c.fail(at, `names no agent of the manifest; agents: ${known([...agentIds])}`);
    const entry = c.object(item, at);
    if (entry === undefined) continue;
    c.keys(entry, at, PROFILE_AGENT_KEYS, []);
    const model = readProfileModel(entry.model, c, [...at, "model"]);
    const effort = readProfileEffort(entry.effort, c, [...at, "effort"]);
    if (entry.effort !== undefined && entry.model === undefined) {
      c.fail([...at, "effort"], "an effort needs a model in the same entry");
    }
    const agent: ProfileAgent = {};
    if (model !== undefined) agent.model = model;
    if (effort !== undefined) agent.effort = effort;
    // Only manifest agent ids are stored, so a key such as "__proto__" never reaches the record.
    if (knownAgent) agents[agentId] = agent;
  }
  return { id, description, agents };
}

async function loadProfiles(
  root: string,
  agentIds: ReadonlySet<string> | undefined,
  problems: string[],
): Promise<{ profiles: Profile[]; ids: string[] }> {
  let names: string[];
  try {
    names = (await readdir(path.join(root, PROFILES_DIR))).filter((name) => name.endsWith(".jsonc")).sort(compareBytes);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { profiles: [], ids: [] };
    throw error;
  }
  const profiles: Profile[] = [];
  const ids: string[] = [];
  for (const name of names) {
    const file = `${PROFILES_DIR}/${name}`;
    const id = name.slice(0, -".jsonc".length);
    if (!PROFILE_ID.test(id)) {
      problems.push(`${file}: (file name): profile id ${JSON.stringify(id)} must match ${PROFILE_ID.source}`);
      continue;
    }
    ids.push(id);
    const read = await readSource(path.join(root, file));
    if ("error" in read) {
      problems.push(`${file}: ${read.error}`);
      continue;
    }
    const value = parseInto(read.text, file, problems);
    if (value === undefined) continue;
    const profile = readProfile(id, value, new Checker(file, problems), agentIds);
    if (profile !== undefined) profiles.push(profile);
  }
  return { profiles, ids };
}

// ---------------------------------------------------------------------------------------------
// Markdown

/** Why a source Markdown file cannot be used, or undefined when it can. */
export function markdownProblem(text: string): string | undefined {
  // trimStart also removes a byte order mark.
  const start = text.trimStart();
  if (start === "") return "is empty";
  if (start.startsWith("---")) {
    return 'starts with "---": source Markdown carries no frontmatter; the generator writes it from the manifest';
  }
  if (start.startsWith("<!--")) {
    return 'starts with "<!--": the comment would reach the model; prompt files get their licence from REUSE.toml';
  }
  return undefined;
}

/** Why a command template cannot be used, or undefined when it can. */
export function templateProblem(text: string): string | undefined {
  if (text.includes("!`")) {
    return 'has a "!`command`" block, which opencode runs before any permission check; templates must not run commands';
  }
  return undefined;
}

async function readSource(file: string): Promise<{ text: string } | { error: string }> {
  try {
    return { text: await readFile(file, "utf8") };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { error: "does not exist" };
    if (code === "EISDIR") return { error: "is a directory, not a file" };
    return { error: `cannot be read (${code ?? String(error)})` };
  }
}

async function readMarkdown(root: string, refs: readonly MarkdownRef[], problems: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const missing = new Set<string>();
  const templates = new Set<string>();
  for (const ref of refs) {
    const shown = `src/${ref.file}`;
    const named = `named at ${formatKeyPath(ref.at)} in ${MANIFEST_FILE}`;
    if (missing.has(ref.file)) continue;
    let text = out.get(ref.file);
    if (text === undefined) {
      const read = await readSource(path.join(root, "src", ref.file));
      if ("error" in read) {
        problems.push(`${MANIFEST_FILE}: ${formatKeyPath(ref.at)}: ${shown} ${read.error}`);
        missing.add(ref.file);
        continue;
      }
      text = read.text;
      out.set(ref.file, text);
      const reason = markdownProblem(text);
      if (reason !== undefined) problems.push(`${shown}: ${reason} (${named})`);
    }
    if (ref.template && !templates.has(ref.file)) {
      templates.add(ref.file);
      const reason = templateProblem(text);
      if (reason !== undefined) problems.push(`${shown}: ${reason} (${named})`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

/**
 * Load and validate the harness source: `root`/src and `root`/VERSION. Throws a GeneratorError
 * that lists every problem when anything is wrong.
 */
export async function load(root: string): Promise<Source> {
  const problems: string[] = [];
  const refs: MarkdownRef[] = [];
  let manifest: Manifest | undefined;
  const read = await readSource(path.join(root, MANIFEST_FILE));
  if ("error" in read) {
    problems.push(`${MANIFEST_FILE}: ${read.error}`);
  } else {
    const value = parseInto(read.text, MANIFEST_FILE, problems);
    if (value !== undefined) manifest = readManifest(value, new Checker(MANIFEST_FILE, problems), refs);
  }

  const version = await readVersion(root, problems);
  const agentIds = manifest === undefined ? undefined : new Set(manifest.agents.map((agent) => agent.id));
  const { profiles, ids } = await loadProfiles(root, agentIds, problems);
  if (manifest !== undefined && manifest.defaultProfile !== "" && !ids.includes(manifest.defaultProfile)) {
    problems.push(`${MANIFEST_FILE}: defaultProfile: names no profile; profiles in ${PROFILES_DIR}/: ${known(ids)}`);
  }
  const markdown = await readMarkdown(root, refs, problems);

  if (problems.length > 0 || manifest === undefined) {
    throw new GeneratorError(`the harness source has ${problems.length} problem${problems.length === 1 ? "" : "s"}:`, problems);
  }
  return { root, version, manifest, profiles, markdown };
}
