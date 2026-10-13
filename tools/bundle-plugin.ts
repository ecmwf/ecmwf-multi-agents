// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Bundles plugin/ into one ES module for both platforms. The build writes the result to
// plugins/ecmwf-multi-agents.js in dist/opencode-v1/ and dist/opencode-v2/. The harness data the
// plugin needs (profiles, agents and their shell rules, commands, and the opencode 1.x agent and
// command entries it registers when the files are not installed) is embedded at bundle time through
// Bun.build `define`, so the module imports nothing but runtime built-ins and works without the
// generator or any package next to it. The output starts with the marker line the installer
// looks for and is the same for the same input: no timestamps, no absolute paths.

import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import type { EmbeddedHarness, EmbeddedProfile } from "../plugin/types.ts";
import { v1AgentEntry, v1CommandEntry } from "./emit-v1.ts";
import type { ResolvedHarness } from "./types.ts";

/** The global constant plugin/index.ts reads; replaced with the harness data at bundle time. */
export const HARNESS_CONSTANT = "__ECMWF_MULTI_AGENTS_HARNESS__";

function fail(message: string): never {
  throw new Error(`bundle-plugin: ${message}`);
}

/** The marker as a JavaScript comment: "# managed by x" becomes "// managed by x". */
export function pluginMarker(harness: Pick<ResolvedHarness, "marker">): string {
  const match = /^#\s*(\S.*)$/.exec(harness.marker);
  if (match === null || /[\r\n]/.test(harness.marker)) fail(`marker ${JSON.stringify(harness.marker)} is not a single "# ..." comment line`);
  return `// ${match[1]!.trimEnd()}`;
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
  const modes = new Map(harness.agents.map((agent) => [agent.id, agent.mode] as const));

  return {
    name: harness.name,
    version: harness.version,
    defaultAgent: harness.defaultAgent,
    defaultProfile: harness.defaultProfile,
    profiles,
    agents: harness.agents.map((agent) => ({
      id: agent.id,
      mode: agent.mode,
      shell: agent.permissions
        .filter((rule) => rule.action === "shell")
        .map((rule) => ({ resource: rule.resource, effect: rule.effect })),
    })),
    commands: harness.commands.map((command) => ({ id: command.id, agent: command.agent, description: command.description })),
    v1: {
      agents: Object.fromEntries(harness.agents.map((agent) => [agent.id, v1AgentEntry(agent)])),
      commands: Object.fromEntries(harness.commands.map((command) => [command.id, v1CommandEntry(command, modes)])),
      skills: harness.skills.map((skill) => skill.id),
    },
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

/** Bundle plugin/index.ts with the harness embedded. Returns the module source. */
export async function bundlePlugin(root: string, harness: ResolvedHarness): Promise<string> {
  const marker = pluginMarker(harness);
  const data = embedHarness(harness);
  const absoluteRoot = path.resolve(root);

  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [path.join(absoluteRoot, "plugin", "index.ts")],
      root: absoluteRoot,
      target: "bun",
      format: "esm",
      minify: false,
      sourcemap: "none",
      define: { [HARNESS_CONSTANT]: JSON.stringify(data) },
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

  if (body.includes(HARNESS_CONSTANT)) fail(`${HARNESS_CONSTANT} was not replaced`);
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
