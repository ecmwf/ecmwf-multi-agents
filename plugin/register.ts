// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Registers the harness itself: the agents, skills and commands the generated files define, and
// lead as the default agent, so a project's `plugins` line or the npm package brings the whole
// harness without any file (docs/research/opencode-v2.md, section 12).
//
// Everything here mirrors what opencode's own loaders do with the generated files, so the result
// is the same whichever way the harness arrives: agent files (core/src/config/plugin/agent.ts:
// the model reference, `~` and `$HOME` in path rules), command files
// (core/src/config/plugin/command.ts: `$ARGUMENTS` and `$1`, the switch to the command's agent,
// a child session for a subagent command) and skill files (core/src/config/plugin/skill-file.ts).
// The registrations happen during setup, before opencode's loaders for files and config, which
// activate after user plugins: a user's or project's agent file therefore merges over these
// agents field by field, and a command or skill file replaces the one registered here.

import path from "node:path";
import type { Reporter } from "./report.ts";
import type {
  EmbeddedAgent,
  EmbeddedCommand,
  EmbeddedHarness,
  EmbeddedSkill,
  PermissionRule,
  V2AgentInfo,
  V2CommandDefinition,
  V2CommandInvocation,
  V2Context,
  V2ModelRef,
  V2SessionInfo,
  V2SessionMessage,
  V2SkillInfo,
} from "./types.ts";

/** A model reference as opencode parses one (Model.Ref.parse in @opencode/schema). */
export function parseModel(input: string): V2ModelRef | undefined {
  const providerEnd = input.indexOf("/");
  if (providerEnd <= 0) return undefined;
  const providerID = input.slice(0, providerEnd);
  const variantStart = input.indexOf("#", providerEnd + 1);
  const id = input.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart);
  const variant = variantStart === -1 ? undefined : input.slice(variantStart + 1);
  if (!id || providerID.includes("#") || (variant !== undefined && (!variant || variant.includes("#")))) return undefined;
  return { id, providerID, ...(variant ? { variant } : {}) };
}

/** Actions whose resources are file paths, where opencode expands `~` and `$HOME`. */
const PATH_ACTIONS = ["external_directory", "read", "edit"];

export function expandHome(resource: string, home: string): string {
  if (resource === "~" || resource === "$HOME") return home;
  const relative = resource.startsWith("~/")
    ? resource.slice(2)
    : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\")
      ? resource.slice(6)
      : undefined;
  if (relative !== undefined) return (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative);
  return resource;
}

export function expandPermissions(rules: readonly PermissionRule[], home: string): PermissionRule[] {
  return rules.map((rule) => (PATH_ACTIONS.includes(rule.action) ? { ...rule, resource: expandHome(rule.resource, home) } : { ...rule }));
}

/** Set an agent's fields from its embedded file, as opencode's loader sets them from the file. */
export function applyAgent(agent: V2AgentInfo, embedded: EmbeddedAgent, home: string): void {
  if (embedded.model !== undefined) {
    const model = parseModel(embedded.model);
    if (model !== undefined) agent.model = model;
  }
  if (embedded.system !== undefined) agent.system = embedded.system;
  if (embedded.description !== undefined) agent.description = embedded.description;
  agent.mode = embedded.mode;
  if (embedded.hidden !== undefined) agent.hidden = embedded.hidden;
  if (embedded.color !== undefined) agent.color = embedded.color;
  if (embedded.steps !== undefined) agent.steps = embedded.steps;
  if (embedded.permissions !== undefined) {
    if (!Array.isArray(agent.permissions)) agent.permissions = [];
    agent.permissions.push(...expandPermissions(embedded.permissions, home));
  }
}

const ARGS = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi;
const PLACEHOLDER = /\$(\d+)/g;
const QUOTES = /^["']|["']$/g;

/** A command's template with the user's arguments filled in, as opencode fills a file command's. */
export function fillTemplate(template: string, input: string): string {
  const args = (input.match(ARGS) ?? []).map((arg) => arg.replace(QUOTES, ""));
  const placeholders = template.match(PLACEHOLDER) ?? [];
  const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))));
  const expanded = template.replaceAll(PLACEHOLDER, (_, index: string) => {
    const position = Number(index);
    const argIndex = position - 1;
    if (argIndex >= args.length) return "";
    if (position === last) return args.slice(argIndex).join(" ");
    return args[argIndex]!;
  });
  const withArguments = expanded.replaceAll("$ARGUMENTS", () => input);
  return placeholders.length === 0 && !template.includes("$ARGUMENTS") && input.trim() ? `${withArguments}\n\n${input}`.trim() : withArguments.trim();
}

/** The skill as opencode reads its file, at the path of the generated file next to the plugin folder. */
export function skillInfo(skill: EmbeddedSkill, pluginDir: string): V2SkillInfo {
  return {
    id: skill.id,
    name: skill.name,
    ...(skill.description === undefined ? {} : { description: skill.description }),
    ...(skill.autoinvoke === undefined ? {} : { autoinvoke: skill.autoinvoke }),
    path: path.resolve(pluginDir, "..", "..", "skills", skill.id, "SKILL.md"),
    content: skill.content,
  };
}

/** The value of a promise API call: some return the payload, some wrap it in `data`. */
export function unwrap<T>(value: unknown): T | undefined {
  if (value !== null && typeof value === "object" && "data" in value && !("id" in value)) return (value as { data: T }).data;
  return value as T | undefined;
}

/** What opencode's own subagent report says when the helper wrote nothing. */
export const NO_TEXT = "Subagent completed without a text response.";
/** The first line opencode puts before a subagent command's request. */
export const SUBAGENT_PREFIX = "You are a subagent spawned by another session.";

export type ChildState = "completed" | "error" | "cancelled";

/** How a child's run ended and what it said, from its messages (core/src/session/subagent-job.ts). */
export function childOutcome(messages: readonly V2SessionMessage[]): { state: ChildState; text: string } {
  const assistants = messages.filter((message) => message?.type === "assistant");
  const latest = assistants.at(-1);
  if (latest?.error !== undefined) return { state: "error", text: latest.error.message || "Subagent failed" };
  if (latest !== undefined && latest.time?.completed === undefined) return { state: "cancelled", text: "Subagent cancelled" };
  const done = [...assistants].reverse().find((message) => message.time?.completed !== undefined && message.error === undefined);
  const text = (done?.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string" && part.text.length > 0)
    .map((part) => part.text as string)
    .join("\n\n");
  return { state: "completed", text: text || NO_TEXT };
}

/** The report opencode gives the parent when a subagent finishes (core/src/session/subagent-completion.ts). */
export function subagentReport(childID: string, state: ChildState, description: string, text: string): string {
  return `<subagent sessionID="${childID}" state="${state}" description="${description}">\n${text}\n</subagent>`;
}

export interface CommandOptions {
  /** Called with errors from the background part of a subagent command. */
  reporter: Reporter;
}

/** Wait for a child to finish, then tell the parent the way opencode tells it about a subagent. */
async function reportBack(ctx: V2Context, parentID: string, childID: string, agent: string, description: string, reporter: Reporter): Promise<void> {
  const session = ctx.session!;
  let outcome: { state: ChildState; text: string };
  try {
    await session.wait!({ sessionID: childID });
    outcome = childOutcome(unwrap<V2SessionMessage[]>(await session.context!({ sessionID: childID })) ?? []);
  } catch (error) {
    outcome = { state: "error", text: error instanceof Error ? error.message : String(error) };
  }
  try {
    await session.synthetic!({
      sessionID: parentID,
      description,
      text: subagentReport(childID, outcome.state, description, outcome.text),
      metadata: { source: "subagent", childID, agent, state: outcome.state },
      delivery: "queue",
    });
  } catch (error) {
    reporter.internal(`reporting the ${description} back`, error);
  }
}

/** One harness command as code: what opencode does for the same command file. */
export function commandDefinition(ctx: V2Context, harness: EmbeddedHarness, command: EmbeddedCommand, options: CommandOptions): V2CommandDefinition {
  return {
    name: command.name,
    ...(command.description === undefined ? {} : { description: command.description }),
    execute: async (input: V2CommandInvocation) => {
      const session = ctx.session;
      if (session?.prompt === undefined) throw new Error(`${harness.name}: this opencode cannot run /${command.name}`);
      const agentID = command.agent;
      const commandAgent = agentID === undefined || ctx.agent.get === undefined ? undefined : unwrap<V2AgentInfo>(await ctx.agent.get({ agentID }).catch(() => undefined));
      const model = command.model === undefined ? commandAgent?.model : parseModel(command.model);
      const text = fillTemplate(command.template, input.prompt?.text ?? "");
      if (command.subagent ?? commandAgent?.mode === "subagent") {
        const parent = unwrap<V2SessionInfo>(await session.get!({ sessionID: input.sessionID }));
        const agent = agentID ?? parent?.agent;
        const description = command.description ?? command.name;
        const childModel = model ?? parent?.model;
        const child = unwrap<V2SessionInfo>(
          await session.create!({
            parentID: input.sessionID,
            title: description,
            ...(agent === undefined ? {} : { agent }),
            ...(childModel === undefined ? {} : { model: childModel }),
          }),
        );
        if (child?.id === undefined) throw new Error(`${harness.name}: /${command.name} could not start its helper`);
        await session.prompt({ ...input.prompt, sessionID: child.id, text: [SUBAGENT_PREFIX, text].join("\n") });
        void reportBack(ctx, input.sessionID, child.id, agent ?? "", description, options.reporter);
        return;
      }
      if (agentID !== undefined) {
        const current = unwrap<V2SessionInfo>(await session.get?.({ sessionID: input.sessionID }));
        if (current?.agent !== agentID) await session.switchAgent?.({ sessionID: input.sessionID, agent: agentID });
      }
      if (model !== undefined) await session.switchModel?.({ sessionID: input.sessionID, model });
      await session.prompt({ ...input.prompt, sessionID: input.sessionID, text, ...(input.delivery === undefined ? {} : { delivery: input.delivery }) });
    },
  };
}

export interface RegisterOptions {
  home: string;
  /** The folder the plugin's entry file is in. */
  pluginDir: string;
  /** Make lead the default agent. */
  defaultAgent: boolean;
  reporter: Reporter;
}

/** Register agents, the default agent, skills and commands. Each part fails on its own. */
export async function registerHarness(ctx: V2Context, harness: EmbeddedHarness, options: RegisterOptions): Promise<void> {
  const { reporter } = options;
  try {
    await ctx.agent.transform((editor) => {
      // Runs on every rebuild; opencode disables a plugin whose transform throws.
      try {
        for (const embedded of harness.agents) editor.update(embedded.id, (agent) => applyAgent(agent, embedded, options.home));
        if (options.defaultAgent) editor.default(harness.defaultAgent);
      } catch (error) {
        reporter.internal("registering the agents", error);
      }
    });
  } catch (error) {
    reporter.internal("registering the agents", error);
  }
  if (typeof ctx.skill?.transform === "function") {
    const skills = harness.skills.map((skill) => skillInfo(skill, options.pluginDir));
    try {
      await ctx.skill.transform((editor) => {
        try {
          for (const skill of skills) editor.add(skill);
        } catch (error) {
          reporter.internal("registering the skills", error);
        }
      });
    } catch (error) {
      reporter.internal("registering the skills", error);
    }
  }
  if (typeof ctx.command?.transform === "function") {
    const commands = harness.commands.map((command) => commandDefinition(ctx, harness, command, { reporter }));
    try {
      await ctx.command.transform((editor) => {
        try {
          for (const command of commands) editor.add(command);
        } catch (error) {
          reporter.internal("registering the commands", error);
        }
      });
    } catch (error) {
      reporter.internal("registering the commands", error);
    }
  }
}
