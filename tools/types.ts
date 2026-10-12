// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Contract between the generator core (load, validate, resolve, write) and the platform
// emitters. The core turns src/manifest.jsonc into a ResolvedHarness; each emitter turns a
// ResolvedHarness into files for one opencode platform. Emitters are pure functions.

export type Effect = "allow" | "ask" | "deny";

/** Platform-neutral permission actions. Emitters map them to platform names. */
export const ACTIONS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "shell",
  "delegate",
  "skill",
  "question",
  "webfetch",
  "websearch",
  "todo",
  "external_directory",
  // Code Mode in opencode 2 (tools reachable only through the `execute` tool, such as MCP
  // tools). opencode 1.x has no Code Mode, so its emitter drops these rules.
  "execute",
  // A tool the harness plugin adds, named by its id in the resource (exact, no pattern). Both
  // platforms key such a rule by the tool id with the pattern "*": a deny removes the tool from
  // the agent's requests (docs/research/background-helpers.md, section 8).
  "tool",
] as const;
export type Action = (typeof ACTIONS)[number];
/** The actions the emitters map to a platform permission key; `tool` carries its key in the resource. */
export type MappedAction = Exclude<Action, "tool">;

/** A plugin tool id: lowercase words joined by underscores, as both platforms name tools. */
export const TOOL_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
/**
 * Permission keys the platforms use for their own tools (opencode 1.x and 2.0.16 together), so
 * a `tool` rule may not name one: those are reached through the neutral actions above. Sources:
 * the direct tools of each platform (docs/research/background-helpers.md, section 10), the
 * tool ids opencode 1.x registers besides them (opencode/src/tool/registry.ts at v1.18.35:
 * `invalid`, `todoread`, `lsp`, `apply_patch`, `patch`, the MCP resource tools) and the
 * permission keys it maps them to (opencode/src/permission/index.ts:204-214, `doom_loop` in
 * emit-v1.ts), and the Code Mode names of 2.0.16. Reserving a name that is not a tool costs
 * nothing, so the list errs on the side of more.
 */
export const PLATFORM_TOOL_IDS: ReadonlySet<string> = new Set([
  "bash",
  "shell",
  "read",
  "edit",
  "write",
  "patch",
  "apply_patch",
  "glob",
  "grep",
  "list",
  "task",
  "subagent",
  "skill",
  "question",
  "webfetch",
  "websearch",
  "todowrite",
  "todoread",
  "external_directory",
  "execute",
  "invalid",
  "doom_loop",
  "lsp",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "opencode_list_mcp_resources",
  "opencode_read_mcp_resource",
  "session_move",
  "session_rename",
]);

export interface Rule {
  action: Action;
  /** Pattern for the resource: a path, a command, an agent id, a skill id, or "*". */
  resource: string;
  effect: Effect;
}

export type AgentMode = "primary" | "subagent";

export interface ResolvedAgent {
  id: string;
  mode: AgentMode;
  description: string;
  /** Final prompt body: the agent's prompt files in order, joined by a blank line. */
  prompt: string;
  /** Maximum model turns; undefined means no limit. */
  steps?: number;
  color?: string;
  /** Expanded, ordered rules (rule sets resolved). */
  permissions: Rule[];
  /** From the default profile; undefined means the session model. */
  model?: string;
  /** opencode's model variant: the profile's effort for this agent. Only set with a model. */
  variant?: string;
}

export interface ResolvedCommand {
  id: string;
  description: string;
  agent: string;
  /** Run in a child session and return the result to the current one. */
  subtask: boolean;
  template: string;
}

export interface ResolvedSkill {
  id: string;
  description: string;
  body: string;
  /** Loaded by exact id only; not advertised in the model's skill list where supported. */
  hidden: boolean;
}

export interface ProfileAgent {
  model?: string;
  /** Reasoning effort, written to opencode as the model variant. Only set with a model. */
  effort?: string;
}

export interface Profile {
  id: string;
  description: string;
  agents: Record<string, ProfileAgent>;
}

export interface ResolvedHarness {
  name: string;
  version: string;
  defaultAgent: string;
  defaultProfile: string;
  workDir: string;
  /** YAML comment line written into generated frontmatter, e.g. "# managed by ...". */
  marker: string;
  agents: ResolvedAgent[];
  commands: ResolvedCommand[];
  skills: ResolvedSkill[];
  profiles: Profile[];
}

/** A generated file, with its path relative to the platform's dist directory. */
export interface OutputFile {
  path: string;
  content: string;
}

export type Emitter = (harness: ResolvedHarness) => OutputFile[];
