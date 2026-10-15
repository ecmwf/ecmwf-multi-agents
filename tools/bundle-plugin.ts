// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Bundles plugin/ into the plugin folder plugins/ecmwf-multi-agents/ of dist/opencode-v2/: the
// server entry index.js and the TUI entry tui.js, each one ES module. The harness data the server
// entry needs (profiles, and the agents, commands and skills as the generated files define them)
// is embedded at bundle time through Bun.build `define`, so the modules import nothing but
// runtime built-ins and work without the generator or any package next to them. Each output
// starts with the marker line the installer looks for and is the same for the same input: no
// timestamps, no absolute paths.

import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import type { EmbeddedAgent, EmbeddedCommand, EmbeddedHarness, EmbeddedProfile, EmbeddedSkill, PermissionRule } from "../plugin/types.ts";
import { v2AgentFile, v2AgentFrontmatter, v2CommandFile, v2CommandFrontmatter, v2SkillFile, v2SkillFrontmatter } from "./emit-v2.ts";
import type { YamlValue } from "./frontmatter.ts";
import type { ResolvedHarness } from "./types.ts";
import { normalizeContent } from "./util.ts";

/** The global constant plugin/index.ts reads; replaced with the harness data at bundle time. */
export const HARNESS_CONSTANT = "__ECMWF_MULTI_AGENTS_HARNESS__";
/** The global constant plugin/tui-index.ts reads; replaced with the harness name. */
export const NAME_CONSTANT = "__ECMWF_MULTI_AGENTS_NAME__";

function fail(message: string): never {
  throw new Error(`bundle-plugin: ${message}`);
}

/** The marker as a JavaScript comment: "# managed by x" becomes "// managed by x". */
export function pluginMarker(harness: Pick<ResolvedHarness, "marker">): string {
  const match = /^#\s*(\S.*)$/.exec(harness.marker);
  if (match === null || /[\r\n]/.test(harness.marker)) fail(`marker ${JSON.stringify(harness.marker)} is not a single "# ..." comment line`);
  return `// ${match[1]!.trimEnd()}`;
}

/**
 * The text after a file's frontmatter, as opencode reads it (gray-matter: everything after the
 * closing "---", less one line break).
 */
export function matterContent(text: string): string {
  if (!text.startsWith("---")) return text;
  const rest = text.slice(3);
  const close = rest.indexOf("\n---");
  if (close === -1) return "";
  let content = rest.slice(close + 4);
  if (content.startsWith("\r")) content = content.slice(1);
  if (content.startsWith("\n")) content = content.slice(1);
  return content;
}

type Frontmatter = { [key: string]: YamlValue };

/** Take the known keys out of frontmatter; any other key means the plugin needs updating. */
function take(owner: string, data: Frontmatter, keys: readonly string[]): Frontmatter {
  const unknown = Object.keys(data).filter((key) => !keys.includes(key));
  if (unknown.length > 0) fail(`${owner}: frontmatter key ${unknown.join(", ")} is not embedded in the plugin`);
  return data;
}

function text(owner: string, value: YamlValue | undefined): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  fail(`${owner}: expected text, got ${JSON.stringify(value)}`);
}

function rules(owner: string, value: YamlValue | undefined): PermissionRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`${owner}: permissions must be a list`);
  return value.map((rule) => {
    if (typeof rule !== "object" || Array.isArray(rule)) fail(`${owner}: a permission rule must be a map`);
    const { action, resource, effect } = rule;
    if (typeof action !== "string" || typeof resource !== "string" || typeof effect !== "string") fail(`${owner}: bad permission rule ${JSON.stringify(rule)}`);
    return { action, resource, effect };
  });
}

/** The agents, commands and skills as the generated files define them. */
export function embedFiles(harness: ResolvedHarness): Pick<EmbeddedHarness, "agents" | "commands" | "skills"> {
  const modes = new Map(harness.agents.map((agent) => [agent.id, agent.mode] as const));
  const body = (content: string) => matterContent(normalizeContent(content));
  const agents = harness.agents.map((agent): EmbeddedAgent => {
    const owner = `agent ${agent.id}`;
    const data = take(owner, v2AgentFrontmatter(agent), ["description", "mode", "model", "steps", "color", "hidden", "permissions"]);
    const out: EmbeddedAgent = { id: agent.id, mode: agent.mode };
    const description = text(owner, data.description);
    if (description !== undefined) out.description = description;
    const model = text(owner, data.model);
    if (model !== undefined) out.model = model;
    if (typeof data.steps === "number") out.steps = data.steps;
    const color = text(owner, data.color);
    if (color !== undefined) out.color = color;
    if (typeof data.hidden === "boolean") out.hidden = data.hidden;
    const permissions = rules(owner, data.permissions);
    if (permissions !== undefined) out.permissions = permissions;
    // opencode trims an agent file's body into the system prompt.
    out.system = body(v2AgentFile(agent, harness.marker).content).trim();
    return out;
  });
  const commands = harness.commands.map((command): EmbeddedCommand => {
    const owner = `command ${command.id}`;
    const data = take(owner, v2CommandFrontmatter(command, modes), ["description", "agent", "model", "subagent"]);
    const template = body(v2CommandFile(command, harness.marker, modes).content).trim();
    // opencode runs a "!`command`" in a file command's template through the shell; the plugin does not.
    if (template.includes("!`")) fail(`${owner}: the template runs a shell command, which the plugin cannot do`);
    const out: EmbeddedCommand = { name: command.id, template };
    const description = text(owner, data.description);
    if (description !== undefined) out.description = description;
    const agent = text(owner, data.agent);
    if (agent !== undefined) out.agent = agent;
    const model = text(owner, data.model);
    if (model !== undefined) out.model = model;
    if (typeof data.subagent === "boolean") out.subagent = data.subagent;
    return out;
  });
  const skills = harness.skills.map((skill): EmbeddedSkill => {
    const owner = `skill ${skill.id}`;
    const data = take(owner, v2SkillFrontmatter(skill), ["name", "description", "metadata"]);
    const out: EmbeddedSkill = { id: skill.id, name: text(owner, data.name) ?? skill.id, content: body(v2SkillFile(skill, harness.marker).content) };
    const description = text(owner, data.description);
    if (description !== undefined) out.description = description;
    const metadata = data.metadata;
    if (metadata !== undefined) {
      if (typeof metadata !== "object" || Array.isArray(metadata)) fail(`${owner}: metadata must be a map`);
      const autoinvoke = metadata["opencode/autoinvoke"];
      if (autoinvoke === "false" || autoinvoke === false) out.autoinvoke = false;
      else if (autoinvoke === "true" || autoinvoke === true) out.autoinvoke = true;
    }
    return out;
  });
  return { agents, commands, skills };
}

/** The part of the harness the plugin needs, checked so the plugin can rely on it. */
export function embedHarness(harness: ResolvedHarness): EmbeddedHarness {
  const ids = harness.agents.map((agent) => agent.id);
  if (new Set(ids).size !== ids.length) fail("agent ids are not unique");
  const profileIds = harness.profiles.map((profile) => profile.id);
  if (new Set(profileIds).size !== profileIds.length) fail("profile ids are not unique");
  if (!profileIds.includes(harness.defaultProfile)) fail(`default profile ${JSON.stringify(harness.defaultProfile)} is not a profile`);
  const lead = harness.agents.find((agent) => agent.id === harness.defaultAgent);
  if (lead === undefined || lead.mode !== "primary") fail(`default agent ${JSON.stringify(harness.defaultAgent)} is not a primary agent`);

  const profiles = harness.profiles.map((profile): EmbeddedProfile => {
    const unknown = Object.keys(profile.agents).filter((id) => !ids.includes(id));
    if (unknown.length > 0) fail(`profile ${profile.id} names unknown agents: ${unknown.join(", ")}`);
    const agents: EmbeddedProfile["agents"] = {};
    // Harness agent order, so the output does not depend on the order of keys in a profile file.
    for (const id of ids) {
      const entry = profile.agents[id];
      if (entry === undefined) continue;
      if (entry.effort !== undefined && entry.model === undefined) fail(`profile ${profile.id}: ${id} has an effort but no model`);
      agents[id] = {
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
      };
    }
    return { id: profile.id, description: profile.description, agents };
  });

  for (const command of harness.commands) {
    if (!ids.includes(command.agent)) fail(`command ${command.id} names unknown agent ${JSON.stringify(command.agent)}`);
  }

  return {
    name: harness.name,
    version: harness.version,
    defaultAgent: harness.defaultAgent,
    defaultProfile: harness.defaultProfile,
    profiles,
    ...embedFiles(harness),
  };
}

const BUILTINS = new Set(builtinModules);

/** Module specifiers the bundle loads at run time. */
export function runtimeImports(code: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bimport\s*(?:[\w*${}\s,]+\s*from\s*)?["']([^"']+)["']/g,
    /\bexport\s*[\w*${}\s,]*\s*from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) found.add(match[1]!);
  return [...found].sort();
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || specifier === "bun" || specifier.startsWith("bun:") || BUILTINS.has(specifier);
}

/** The plugin folder under a config folder; opencode loads its `index.js` and the TUI its `tui.js`. */
export const PLUGIN_DIR = "plugins/ecmwf-multi-agents";

/** Bundle one entry of plugin/ into a module that starts with the marker line. */
async function bundleEntry(root: string, harness: ResolvedHarness, entry: string, define: Record<string, string>): Promise<string> {
  const marker = pluginMarker(harness);
  const absoluteRoot = path.resolve(root);

  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [path.join(absoluteRoot, "plugin", entry)],
      root: absoluteRoot,
      target: "bun",
      format: "esm",
      minify: false,
      sourcemap: "none",
      define,
    });
  } catch (error) {
    const logs = (error as { errors?: unknown[] } | null)?.errors;
    fail(`Bun.build failed: ${Array.isArray(logs) ? logs.map(String).join("\n") : String(error)}`);
  }
  if (!result.success) fail(`Bun.build failed: ${result.logs.map(String).join("\n")}`);
  const outputs = result.outputs.filter((output) => output.kind === "entry-point");
  if (outputs.length !== 1) fail(`expected one bundled module, got ${outputs.length}`);

  let body = (await outputs[0]!.text()).replace(/\r\n?/g, "\n");
  // Bun marks its output with a "// @bun" pragma line; the marker line has to come first instead.
  body = body.replace(/^\/\/ @bun\b[^\n]*\n/, "");
  body = `${marker}\n${body.trim()}\n`;

  for (const name of Object.keys(define)) if (body.includes(name)) fail(`${name} was not replaced`);
  const foreign = runtimeImports(body).filter((specifier) => !isBuiltin(specifier));
  if (foreign.length > 0) fail(`the bundle imports ${foreign.join(", ")}; only runtime built-ins are allowed`);
  for (const [label, dir] of [
    ["repository", absoluteRoot],
    ["home", os.homedir()],
  ] as const) {
    if (dir.length > 1 && body.includes(dir)) fail(`the bundle contains the ${label} path ${dir}`);
  }
  return body;
}

/** The server entry: plugin/index.ts with the harness embedded. Returns the module source. */
export async function bundlePlugin(root: string, harness: ResolvedHarness): Promise<string> {
  return bundleEntry(root, harness, "index.ts", { [HARNESS_CONSTANT]: JSON.stringify(embedHarness(harness)) });
}

/** The TUI entry: plugin/tui-index.ts with the harness name. Returns the module source. */
export async function bundleTui(root: string, harness: ResolvedHarness): Promise<string> {
  return bundleEntry(root, harness, "tui-index.ts", { [NAME_CONSTANT]: JSON.stringify(harness.name) });
}

/** The plugin folder's files, with paths relative to a config folder. */
export async function pluginFiles(root: string, harness: ResolvedHarness): Promise<Array<{ path: string; content: string }>> {
  return [
    { path: `${PLUGIN_DIR}/index.js`, content: await bundlePlugin(root, harness) },
    { path: `${PLUGIN_DIR}/tui.js`, content: await bundleTui(root, harness) },
  ];
}
