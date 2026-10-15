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
  type Problem,
  type ReviewPolicy,
  type Settings,
  type SettingsFile,
} from "./types.ts";

export const SETTINGS_FILE = "ecmwf-multi-agents.jsonc";

/** `provider/model`, split at the first "/", with no "#" (opencode 2 reads "#" as a variant) and no spaces. */
export const MODEL_PATTERN = /^[^/#\s]+\/[^#\s]+$/;
/** A non-empty effort name, such as "high", without "#" or spaces. opencode calls it the model variant. */
export const EFFORT_PATTERN = /^[^#\s]+$/;

const TOP_KEYS = ["$schema", "review", "profile", "default_agent", "agents"];
const AGENT_KEYS = ["model", "effort", "steps"];
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
          agents[id] = validateAgent(id, entry, problems);
        }
        settings.agents = agents;
        break;
      }
      default:
        problems.push(`unknown setting ${shown(key)}; the settings are ${listWords(TOP_KEYS, "and")}`);
    }
  }
  return problems.length > 0 ? { problems } : { settings, problems };
}

function validateAgent(id: string, entry: Record<string, unknown>, problems: string[]): AgentOverride {
  const out: AgentOverride = {};
  for (const key of Object.keys(entry)) {
    const item = entry[key];
    const name = `"agents.${id}.${key}"`;
    switch (key) {
      case "model":
        if (typeof item === "string" && MODEL_PATTERN.test(item)) out.model = item;
        else problems.push(`${name} must look like provider/model, without "#" or spaces, not ${shown(item)}`);
        break;
      case "effort":
        if (typeof item === "string" && EFFORT_PATTERN.test(item)) out.effort = item;
        else problems.push(`${name} must be a non-empty name such as "high", without "#" or spaces, not ${shown(item)}`);
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

/** Combine valid files in order: later values win; `agents` merge per agent and per field. */
export function mergeSettings(files: readonly SettingsFile[], harness: EmbeddedHarness): Settings {
  const settings: Settings = {
    review: "auto",
    reviewSet: false,
    profile: harness.defaultProfile,
    defaultAgent: true,
    agents: {},
  };
  for (const file of files) {
    if (file.review !== undefined) {
      settings.review = file.review;
      settings.reviewSet = true;
    }
    if (file.profile !== undefined) settings.profile = file.profile;
    if (file.default_agent !== undefined) settings.defaultAgent = file.default_agent;
    for (const [id, override] of Object.entries(file.agents ?? {})) {
      settings.agents[id] = { ...settings.agents[id], ...override };
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
