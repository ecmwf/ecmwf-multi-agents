// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The plugin's RPC, reachable at POST /api/rpc/ecmwf-multi-agents/<method> with the body
// {"input":{}} (server/src/handlers/rpc.ts, protocol/src/groups/rpc.ts). That route waits for
// plugin activation, so `install.sh doctor` asks it through `opencode api --standalone` and gets
// the state of a project as opencode sees it:
//
//   doctor    the harness version, the default agent, whether lead is loaded and whether it is
//             the harness's own (opencode does not say where an agent came from, so the lead it
//             loaded is compared with the harness's, and the agent files and configs that could
//             change it are listed), lead's "Review policy:" line, the effective settings and the
//             file each comes from, the problems found, and the state of every plugin
//   problems  the problems found since the plugin loaded
//   problem   an event published for each new problem; the TUI entry shows it (tui.ts)

import path from "node:path";
import { modelRef, planAgents, rewriteReviewLine } from "./apply.ts";
import { parseJsonc } from "./jsonc.ts";
import { rpcDefinition, type DoctorView, type ProblemView } from "./rpc-definition.ts";
import { findRun } from "./rule-order.ts";
import type { LoadedSettings } from "./settings.ts";
import { applyAgent, unwrap } from "./register.ts";
import type { EmbeddedHarness, Environment, Problem, Settings, V2AgentInfo, V2Context, V2ModelRef, V2PluginState, V2RpcRegistration } from "./types.ts";

/** Problems seen since the plugin loaded, in order, each once. */
export class ProblemLog {
  private readonly problems: Problem[] = [];
  private emit: ((problem: ProblemView) => void) | undefined;

  add(problem: Problem): void {
    if (this.problems.some((item) => item.message === problem.message)) return;
    this.problems.push(problem);
    this.emit?.(view(problem));
  }

  list(): ProblemView[] {
    return this.problems.map(view);
  }

  /** Publish each problem added from now on. */
  onAdd(emit: (problem: ProblemView) => void): void {
    this.emit = emit;
  }
}

function view(problem: Problem): ProblemView {
  return { problem: problem.message, notify: problem.notify };
}

/**
 * The global config folder opencode reads agent files from: the one OPENCODE_CONFIG_DIR names,
 * which replaces the user's own, or else the user's (`$XDG_CONFIG_HOME/opencode`, by default
 * `~/.config/opencode`); util/src/global.ts:79 at v2.0.29. Our settings file is looked for in
 * both (settingsPaths); agent files are not.
 */
export function globalConfigFolder(environment: Pick<Environment, "env" | "home">): string {
  const { env, home } = environment;
  if (env.OPENCODE_CONFIG_DIR) return path.resolve(env.OPENCODE_CONFIG_DIR);
  return path.join(env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : path.join(home, ".config"), "opencode");
}

/** The folders from `directory` up to the project root, nearest first. */
function projectFolders(directory: string | undefined, projectRoot: string | undefined): string[] {
  if (directory === undefined) return [];
  const folders: string[] = [];
  const stop = path.resolve(projectRoot ?? directory);
  for (let dir = path.resolve(directory); ; dir = path.dirname(dir)) {
    folders.push(dir);
    if (dir === stop || dir === path.dirname(dir)) break;
  }
  return folders;
}

function readable(environment: Environment, file: string): string | undefined {
  try {
    return environment.readFile(file);
  } catch {
    // Unreadable: opencode cannot load it either.
    return undefined;
  }
}

/**
 * Agent files that define `id` in the folders opencode reads them from: the global config folder
 * opencode uses, and `.opencode` from the directory up to the project root.
 */
export function agentFiles(id: string, environment: Environment, directory: string | undefined, projectRoot: string | undefined): string[] {
  const folders = [globalConfigFolder(environment), ...projectFolders(directory, projectRoot).map((dir) => path.join(dir, ".opencode"))];
  const found: string[] = [];
  for (const folder of [...new Set(folders)]) {
    for (const sub of ["agent", "agents", "mode", "modes"]) {
      const file = path.join(folder, sub, `${id}.md`);
      if (readable(environment, file) !== undefined) found.push(file);
    }
  }
  return found;
}

const CONFIG_NAMES = ["opencode.json", "opencode.jsonc"];

function definesAgent(text: string, id: string): boolean {
  try {
    const value = parseJsonc(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    return ["agents", "agent"].some((key) => {
      const entries = value[key];
      return entries !== null && typeof entries === "object" && !Array.isArray(entries) && entries[id] !== undefined;
    });
  } catch {
    // opencode reports a config it cannot read.
    return false;
  }
}

/**
 * opencode configs with an entry for agent `id` (`agents.<id>`, or `agent.<id>` as opencode 1
 * wrote it): `opencode.json` and `opencode.jsonc` in the global config folder opencode uses, the
 * file OPENCODE_CONFIG names, and those in each folder and its `.opencode` from the directory up
 * to the project root; `OPENCODE_CONFIG_CONTENT` when the variable defines one.
 */
export function agentConfigFiles(id: string, environment: Environment, directory: string | undefined, projectRoot: string | undefined): string[] {
  const { env } = environment;
  const files = CONFIG_NAMES.map((name) => path.join(globalConfigFolder(environment), name));
  if (env.OPENCODE_CONFIG) files.push(path.resolve(env.OPENCODE_CONFIG));
  for (const dir of projectFolders(directory, projectRoot)) {
    for (const folder of [dir, path.join(dir, ".opencode")]) files.push(...CONFIG_NAMES.map((name) => path.join(folder, name)));
  }
  const found = [...new Set(files)].filter((file) => {
    const text = readable(environment, file);
    return text !== undefined && definesAgent(text, id);
  });
  if (env.OPENCODE_CONFIG_CONTENT && definesAgent(env.OPENCODE_CONFIG_CONTENT, id)) found.push("OPENCODE_CONFIG_CONTENT");
  return found;
}

function sameModel(a: V2ModelRef | undefined, b: V2ModelRef | undefined): boolean {
  return a?.providerID === b?.providerID && a?.id === b?.id;
}

/**
 * The fields in which the lead opencode loaded differs from the harness's own lead as the plugin
 * registers it and the settings then make it: the review line, model, effort and step limit the
 * settings choose. Rules after or before the harness's own are expected, from the user's config;
 * the harness's own must all be there, in order.
 */
export function leadChanges(lead: V2AgentInfo, harness: EmbeddedHarness, settings: Settings, home: string): string[] {
  const embedded = harness.agents.find((agent) => agent.id === harness.defaultAgent);
  if (embedded === undefined) return [];
  // An agent opencode creates starts as primary and not hidden (Agent.Info.default).
  const expected: V2AgentInfo = { id: embedded.id, mode: "primary", hidden: false, permissions: [] };
  applyAgent(expected, embedded, home);
  if (typeof expected.system === "string") expected.system = rewriteReviewLine(expected.system, settings.review, embedded.id).prompt ?? expected.system;
  const plan = planAgents(harness, settings).plans.find((item) => item.id === embedded.id);
  const model = plan?.model === undefined ? undefined : modelRef(plan.model, plan.effort);
  if (plan?.steps !== undefined) expected.steps = plan.steps;

  const changed: string[] = [];
  if (lead.system !== expected.system) changed.push("system");
  if (lead.description !== expected.description) changed.push("description");
  if ((lead.mode ?? "primary") !== expected.mode) changed.push("mode");
  if ((lead.hidden ?? false) !== expected.hidden) changed.push("hidden");
  if (lead.color !== expected.color) changed.push("color");
  const own = expected.permissions ?? [];
  if (own.length > 0 && findRun(Array.isArray(lead.permissions) ? lead.permissions : [], own) === -1) changed.push("permissions");
  if (!sameModel(lead.model, model)) changed.push("model");
  else if (lead.model?.variant !== model?.variant) changed.push("effort");
  if (lead.steps !== expected.steps) changed.push("steps");
  return changed;
}

export interface DoctorInput {
  harness: EmbeddedHarness;
  ctx: V2Context;
  loaded: Pick<LoadedSettings, "settings" | "applied" | "sources">;
  problems: ProblemLog;
  environment: Environment;
  directory: string | undefined;
  projectRoot: string | undefined;
  /** Resolves once the agents show the settings; awaited before the agents are read. */
  ready?: () => Promise<void>;
}

function modelText(agent: V2AgentInfo | undefined): string | null {
  const model = agent?.model;
  if (model === undefined) return null;
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

export async function doctorReport(input: DoctorInput): Promise<DoctorView> {
  const { harness, ctx, loaded } = input;
  await input.ready?.().catch(() => undefined);
  const agents = (await Promise.resolve(ctx.agent.list?.()).then((value) => unwrap<V2AgentInfo[]>(value), () => undefined)) ?? [];
  const lead = agents.find((agent) => agent.id === harness.defaultAgent);
  const plugins = (await Promise.resolve(ctx.plugin?.list?.()).then((value) => unwrap<V2PluginState[]>(value), () => undefined)) ?? [];
  const { settings } = loaded;
  const changed = lead === undefined ? [] : leadChanges(lead, harness, settings, input.environment.home);
  return {
    name: harness.name,
    version: harness.version,
    defaultAgent: agents[0]?.id ?? null,
    leadLoaded: lead !== undefined,
    leadDefinition: lead === undefined ? null : changed.length > 0 ? "changed" : "harness",
    leadChanged: changed,
    leadCandidateFiles: agentFiles(harness.defaultAgent, input.environment, input.directory, input.projectRoot),
    leadConfigFiles: agentConfigFiles(harness.defaultAgent, input.environment, input.directory, input.projectRoot),
    reviewLine: (typeof lead?.system === "string" ? lead.system.split("\n").find((line) => line.startsWith("Review policy:")) : undefined) ?? null,
    leadModel: modelText(lead),
    settings: {
      review: settings.review,
      profile: settings.profile,
      default_agent: settings.defaultAgent,
      agents: settings.agents,
    },
    settingsFiles: loaded.applied,
    settingsSources: loaded.sources,
    problems: input.problems.list(),
    // opencode's own plugins only when they failed.
    plugins: (Array.isArray(plugins) ? plugins : [])
      .filter((plugin) => !plugin.id?.startsWith("opencode.") || plugin.state?.status !== "active")
      .map((plugin) => ({
        id: plugin.id ?? null,
        status: plugin.state?.status ?? null,
        ...(typeof plugin.state?.error === "string" ? { error: plugin.state.error } : {}),
      })),
  };
}

/** Register the RPC; returns the registration, or undefined where this opencode has no RPC. */
export async function registerRpc(input: DoctorInput): Promise<V2RpcRegistration | undefined> {
  const register = input.ctx.rpc?.register;
  if (typeof register !== "function") return undefined;
  const registration = await register.call(input.ctx.rpc, rpcDefinition(input.harness.name), {
    doctor: async () => doctorReport(input),
    problems: async () => ({ problems: input.problems.list() }),
  });
  input.problems.onAdd((problem) => {
    void Promise.resolve(registration.events.emit("problem", { ...problem })).catch(() => undefined);
  });
  return registration;
}
