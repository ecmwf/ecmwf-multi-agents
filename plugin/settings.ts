// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Settings files: where they are, what they may contain and how they combine. The rules match
// the JSON Schema the generator writes for `ecmwf-multi-agents.jsonc` (docs/architecture.md,
// "Settings"). A file that breaks any rule is ignored as a whole, so a typo never half-applies.

import path from "node:path";
import { JsoncError, parseJsonc } from "./jsonc.ts";
import {
  REVIEW_POLICIES,
  type AgentOverride,
  type EmbeddedHarness,
  type Environment,
  type FallbackEntry,
  type Problem,
  type ReviewPolicy,
  type Settings,
  type SettingsFile,
} from "./types.ts";

export const SETTINGS_FILE = "ecmwf-multi-agents.jsonc";
export const DEFAULT_MAX_HELPER_SLOTS = 4;

/** `provider/model`, split at the first "/", with no "#" (opencode 2 reads "#" as a variant) and no spaces. */
export const MODEL_PATTERN = /^[^/#\s]+\/[^#\s]+$/;
/** A non-empty effort name, such as "high", without "#" or spaces. opencode calls it the model variant. */
export const EFFORT_PATTERN = /^[^#\s]+$/;

const TOP_KEYS = ["$schema", "review", "profile", "default_agent", "max_helper_slots", "agents"];
const AGENT_KEYS = ["enabled", "model", "effort", "fallback", "steps"];
const FALLBACK_KEYS = ["model", "effort"];
/** Agent keys that were renamed, to the name they have now. */
const RENAMED_AGENT_KEYS: Readonly<Record<string, string>> = { variant: "effort" };

/** "a, b or c" */
export function listWords(words: readonly string[], last = "or"): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${last} ${words.at(-1)}`;
}

function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * The settings files in the order they apply, later ones overriding earlier ones: the site file
 * a central install names in the plugin's `site` option, `$OPENCODE_CONFIG_DIR`, the user's
 * global opencode directory, then the project's `.opencode/`. A path that appears twice is read
 * once, in its first position.
 */
export function settingsPaths(environment: Pick<Environment, "env" | "home">, projectRoot: string | undefined, site?: string): string[] {
  const { env, home } = environment;
  const out: string[] = [];
  const addFile = (file: string) => {
    if (!out.includes(file)) out.push(file);
  };
  const add = (dir: string | undefined) => {
    if (dir) addFile(path.resolve(dir, SETTINGS_FILE));
  };
  if (site) addFile(path.resolve(site));
  add(env.OPENCODE_CONFIG_DIR);
  const xdg = env.XDG_CONFIG_HOME;
  add(path.join(xdg ? xdg : path.join(home, ".config"), "opencode"));
  if (projectRoot) add(path.join(projectRoot, ".opencode"));
  return out;
}

/** Check one parsed settings file. Returns the problems, all of them, in plain words. */
export function validateSettings(value: unknown, harness: EmbeddedHarness): { settings?: SettingsFile; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(value)) {
    return { problems: ['the file must hold one object in braces, such as { "review": "auto" }'] };
  }
  const profiles = harness.profiles.map((profile) => profile.id);
  const agentIds = harness.agents.map((agent) => agent.id);
  const settings: SettingsFile = {};

  for (const key of Object.keys(value)) {
    const item = value[key];
    switch (key) {
      case "$schema":
        if (typeof item !== "string") problems.push(`"$schema" must be text, not ${shown(item)}`);
        break;
      case "review":
        if (typeof item === "string" && (REVIEW_POLICIES as readonly string[]).includes(item)) settings.review = item as ReviewPolicy;
        else problems.push(`"review" must be ${listWords(REVIEW_POLICIES)}, not ${shown(item)}`);
        break;
      case "profile":
        if (typeof item === "string" && profiles.includes(item)) settings.profile = item;
        else problems.push(`"profile" must be ${listWords(profiles)}, not ${shown(item)}`);
        break;
      case "default_agent":
        if (typeof item === "boolean") settings.default_agent = item;
        else problems.push(`"default_agent" must be true or false, not ${shown(item)}`);
        break;
      case "agents": {
        if (!isObject(item)) {
          problems.push(`"agents" must be an object that maps agent names to settings, not ${shown(item)}`);
          break;
        }
        const agents: Record<string, AgentOverride> = {};
        for (const id of Object.keys(item)) {
          if (!agentIds.includes(id)) {
            problems.push(`"agents" names ${shown(id)}, which is not one of the agents ${listWords(agentIds, "and")}`);
            continue;
          }
          const entry = item[id];
          if (!isObject(entry)) {
            problems.push(`"agents.${id}" must be an object with ${listWords(AGENT_KEYS)}, not ${shown(entry)}`);
            continue;
          }
          agents[id] = validateAgent(id, entry, problems, id === harness.defaultAgent);
        }
        settings.agents = agents;
        break;
      }
      case "max_helper_slots":
        if (typeof item === "number" && Number.isInteger(item) && item >= 1) settings.max_helper_slots = item;
        else problems.push(`"max_helper_slots" must be a whole number of at least 1, not ${shown(item)}`);
        break;
      default:
        problems.push(`unknown setting ${shown(key)}; the settings are ${listWords(TOP_KEYS, "and")}`);
    }
  }
  return problems.length > 0 ? { problems } : { settings, problems };
}

function validateAgent(id: string, entry: Record<string, unknown>, problems: string[], isDefaultAgent: boolean): AgentOverride {
  const out: AgentOverride = {};
  for (const key of Object.keys(entry)) {
    const item = entry[key];
    const name = `"agents.${id}.${key}"`;
    switch (key) {
      case "enabled":
        if (isDefaultAgent) problems.push(`${name} cannot be set: ${id} is always on`);
        else if (typeof item === "boolean") out.enabled = item;
        else problems.push(`${name} must be true or false, not ${shown(item)}`);
        break;
      case "model":
        if (typeof item === "string" && MODEL_PATTERN.test(item)) out.model = item;
        else problems.push(`${name} must look like provider/model, without "#" or spaces, not ${shown(item)}`);
        break;
      case "effort":
        if (typeof item === "string" && EFFORT_PATTERN.test(item)) out.effort = item;
        else problems.push(`${name} must be a non-empty name such as "high", without "#" or spaces, not ${shown(item)}`);
        break;
      case "fallback":
        if (!has(entry, "model")) problems.push(`${name} needs a model in the same entry: the fallbacks are for that model`);
        out.fallback = validateFallback(`agents.${id}.fallback`, item, problems);
        break;
      case "steps":
        if (typeof item === "number" && Number.isInteger(item) && item >= 1) out.steps = item;
        else problems.push(`${name} must be a whole number of at least 1, not ${shown(item)}`);
        break;
      default: {
        const renamed = has(RENAMED_AGENT_KEYS, key) ? RENAMED_AGENT_KEYS[key] : undefined;
        problems.push(
          renamed === undefined
            ? `"agents.${id}" has the unknown setting ${shown(key)}; an agent takes ${listWords(AGENT_KEYS)}`
            : `"agents.${id}" has the unknown key ${shown(key)}; it is now called ${shown(renamed)}`,
        );
      }
    }
  }
  return out;
}

/**
 * The fallback list of one agent: an array of `provider/model` texts or { model, effort } objects,
 * returned as objects. Entries that break a rule are reported and left out.
 */
function validateFallback(path: string, item: unknown, problems: string[]): FallbackEntry[] {
  const out: FallbackEntry[] = [];
  if (!Array.isArray(item)) {
    problems.push(`"${path}" must be a list of models, each provider/model or { "model": "provider/model", "effort": "high" }, not ${shown(item)}`);
    return out;
  }
  item.forEach((candidate: unknown, index) => {
    const at = `${path}[${index}]`;
    if (typeof candidate === "string") {
      if (MODEL_PATTERN.test(candidate)) out.push({ model: candidate });
      else problems.push(`"${at}" must look like provider/model, without "#" or spaces, not ${shown(candidate)}`);
      return;
    }
    if (!isObject(candidate)) {
      problems.push(`"${at}" must be provider/model or an object with ${listWords(FALLBACK_KEYS, "and")}, not ${shown(candidate)}`);
      return;
    }
    // A problem makes the whole file invalid, so a bad entry's value never reaches `out`.
    const entry: Partial<FallbackEntry> = {};
    for (const key of Object.keys(candidate)) {
      const value = candidate[key];
      if (key === "model") {
        if (typeof value === "string" && MODEL_PATTERN.test(value)) entry.model = value;
        else problems.push(`"${at}.model" must look like provider/model, without "#" or spaces, not ${shown(value)}`);
      } else if (key === "effort") {
        if (typeof value === "string" && EFFORT_PATTERN.test(value)) entry.effort = value;
        else problems.push(`"${at}.effort" must be a non-empty name such as "high", without "#" or spaces, not ${shown(value)}`);
      } else {
        problems.push(`"${at}" has the unknown setting ${shown(key)}; an entry takes ${listWords(FALLBACK_KEYS, "and")}`);
      }
    }
    if (!has(candidate, "model")) problems.push(`"${at}" needs a "model", written as provider/model`);
    else if (entry.model !== undefined) out.push(entry as FallbackEntry);
  });
  return out;
}

/** Combine valid files in order: later values win; `agents` merge per agent and per field. */
export function mergeSettings(files: readonly SettingsFile[], harness: EmbeddedHarness): Settings {
  const settings: Settings = {
    review: "auto",
    reviewSet: false,
    profile: harness.defaultProfile,
    defaultAgent: true,
    maxHelperSlots: DEFAULT_MAX_HELPER_SLOTS,
    maxHelperSlotsSet: false,
    agents: {},
  };
  for (const file of files) {
    if (file.review !== undefined) {
      settings.review = file.review;
      settings.reviewSet = true;
    }
    if (file.profile !== undefined) settings.profile = file.profile;
    if (file.default_agent !== undefined) settings.defaultAgent = file.default_agent;
    if (file.max_helper_slots !== undefined) {
      settings.maxHelperSlots = file.max_helper_slots;
      settings.maxHelperSlotsSet = true;
    }
    for (const [id, override] of Object.entries(file.agents ?? {})) {
      // `fallback` is undefined until a file says something: the profile's list then applies. A
      // file that sets `model` without `fallback` chose a new model, so the old list (from the
      // profile or from an earlier file) no longer fits it: record that as [], which a later
      // step reads as "cleared", not as "not given". A later file's `fallback` replaces the whole
      // list; a file that sets only `effort` or `steps` leaves it alone.
      const cleared = override.model !== undefined && override.fallback === undefined ? { fallback: [] } : {};
      settings.agents[id] = { ...settings.agents[id], ...override, ...cleared };
    }
  }
  return settings;
}

export interface LoadedSettings {
  settings: Settings;
  problems: Problem[];
  /** Files that were read and applied, in order. */
  applied: string[];
  /** The file each setting comes from, by name ("review", "agents.scout.steps"); unset ones use the default. */
  sources: Record<string, string>;
}

/** The file that set each setting: the last applied file that names it. */
export function settingSources(files: readonly SettingsFile[], applied: readonly string[]): Record<string, string> {
  const sources: Record<string, string> = {};
  files.forEach((file, index) => {
    const from = applied[index]!;
    if (file.review !== undefined) sources.review = from;
    if (file.profile !== undefined) sources.profile = from;
    if (file.default_agent !== undefined) sources.default_agent = from;
    if (file.max_helper_slots !== undefined) sources.max_helper_slots = from;
    for (const [id, override] of Object.entries(file.agents ?? {})) {
      for (const key of Object.keys(override)) sources[`agents.${id}.${key}`] = from;
    }
  });
  return sources;
}

/** Read, check and merge every settings file. Missing files are skipped without a word. */
export function loadSettings(harness: EmbeddedHarness, environment: Environment, projectRoot: string | undefined, site?: string): LoadedSettings {
  const files: SettingsFile[] = [];
  const problems: Problem[] = [];
  const applied: string[] = [];
  for (const file of settingsPaths(environment, projectRoot, site)) {
    let text: string | undefined;
    try {
      text = environment.readFile(file);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const reason = typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
      problems.push({ message: `${harness.name}: ignoring ${file}: it could not be read (${reason})`, notify: true });
      continue;
    }
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = parseJsonc(text);
    } catch (error) {
      const reason = error instanceof JsoncError ? error.message : String(error);
      problems.push({ message: `${harness.name}: ignoring ${file}: ${reason}`, notify: true });
      continue;
    }
    const checked = validateSettings(parsed, harness);
    if (checked.settings === undefined) {
      problems.push({ message: `${harness.name}: ignoring ${file}: ${checked.problems.join("; ")}`, notify: true });
      continue;
    }
    files.push(checked.settings);
    applied.push(file);
  }
  return { settings: mergeSettings(files, harness), problems, applied, sources: settingSources(files, applied) };
}
