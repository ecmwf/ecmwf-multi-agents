// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The plugin's RPC, reachable at POST /api/rpc/ecmwf-multi-agents/<method> with the body
// {"input":{}} (server/src/handlers/rpc.ts, protocol/src/groups/rpc.ts). That route waits for
// plugin activation, so `install.sh doctor` asks it through `opencode api --standalone` and gets
// the state of a project as opencode sees it:
//
//   doctor    the harness version, the default agent, whether lead is loaded and from where,
//             lead's "Review policy:" line, the effective settings and the file each comes from,
//             the problems found, and the state of every plugin
//   problems  the problems found since the plugin loaded
//   problem   an event published for each new problem; the TUI entry shows it (tui.ts)

import path from "node:path";
import { rpcDefinition, type ProblemView } from "./rpc-definition.ts";
import { settingsPaths, type LoadedSettings } from "./settings.ts";
import { unwrap } from "./register.ts";
import type { EmbeddedHarness, Environment, Problem, V2AgentInfo, V2Context, V2PluginState, V2RpcRegistration } from "./types.ts";

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
 * Agent files that define `id` in the folders opencode reads them from: the config folder named
 * by OPENCODE_CONFIG_DIR, the user's global one, and `.opencode` from the directory up to the
 * project root.
 */
export function agentFiles(id: string, environment: Environment, directory: string | undefined, projectRoot: string | undefined): string[] {
  const folders = settingsPaths(environment, undefined).map((file) => path.dirname(file));
  if (directory !== undefined) {
    const stop = projectRoot ?? directory;
    for (let dir = path.resolve(directory); ; dir = path.dirname(dir)) {
      folders.push(path.join(dir, ".opencode"));
      if (dir === path.resolve(stop) || dir === path.dirname(dir)) break;
    }
  }
  const found: string[] = [];
  for (const folder of [...new Set(folders)]) {
    for (const sub of ["agent", "agents", "mode", "modes"]) {
      const file = path.join(folder, sub, `${id}.md`);
      try {
        if (environment.readFile(file) !== undefined) found.push(file);
      } catch {
        // Unreadable: opencode cannot load it either.
      }
    }
  }
  return found;
}

export interface DoctorInput {
  harness: EmbeddedHarness;
  ctx: V2Context;
  loaded: Pick<LoadedSettings, "settings" | "applied" | "sources">;
  problems: ProblemLog;
  environment: Environment;
  directory: string | undefined;
  projectRoot: string | undefined;
}

function modelText(agent: V2AgentInfo | undefined): string | null {
  const model = agent?.model;
  if (model === undefined) return null;
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

export async function doctorReport(input: DoctorInput): Promise<Record<string, unknown>> {
  const { harness, ctx, loaded } = input;
  const agents = (await Promise.resolve(ctx.agent.list?.()).then((value) => unwrap<V2AgentInfo[]>(value), () => undefined)) ?? [];
  const lead = agents.find((agent) => agent.id === harness.defaultAgent);
  const files = agentFiles(harness.defaultAgent, input.environment, input.directory, input.projectRoot);
  const plugins = (await Promise.resolve(ctx.plugin?.list?.()).then((value) => unwrap<V2PluginState[]>(value), () => undefined)) ?? [];
  const { settings } = loaded;
  return {
    name: harness.name,
    version: harness.version,
    defaultAgent: agents[0]?.id ?? null,
    leadLoaded: lead !== undefined,
    leadSource: lead === undefined ? null : files.length > 0 ? "files" : "plugin",
    leadFiles: files,
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
