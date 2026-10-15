// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Contract between the generator core (load, validate, resolve, write) and the emitter. The
// core turns src/manifest.jsonc into a ResolvedHarness; the emitter turns a ResolvedHarness into
// files for opencode 2. Emitters are pure functions.

export type Effect = "allow" | "ask" | "deny";

/** Neutral permission actions. The emitter maps them to opencode's names. */
export const ACTIONS = [
  "read",
  "edit",
  "glob",
  "grep",
  "shell",
  "delegate",
  "skill",
  "question",
  "webfetch",
  "websearch",
  "external_directory",
  // Code Mode (tools reachable only through the `execute` tool, such as MCP tools).
  "execute",
  // A tool the harness plugin adds, named by its id in the resource (exact, no pattern).
  // opencode keys such a rule by the tool id with the pattern "*": a deny removes the tool from
  // the agent's requests (docs/research/background-helpers.md, section 8).
  "tool",
] as const;
export type Action = (typeof ACTIONS)[number];
/** The actions the emitter maps to an opencode permission key; `tool` carries its key in the resource. */
export type MappedAction = Exclude<Action, "tool">;

/** A plugin tool id: lowercase words joined by underscores, as opencode names tools. */
export const TOOL_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
/**
 * Permission keys opencode uses for its own tools, so a `tool` rule may not name one: those are
 * reached through the neutral actions above. Sources: the direct tools of opencode 2.0.16
 * (docs/research/background-helpers.md, section 10), the write and patch tools that `edit`
 * covers, and the Code Mode names. Reserving a name that is not a tool costs nothing, so the
 * list errs on the side of more.
 */
export const PLATFORM_TOOL_IDS: ReadonlySet<string> = new Set([
  "shell",
  "read",
  "edit",
  "write",
  "patch",
  "glob",
  "grep",
  "subagent",
  "skill",
  "question",
  "webfetch",
  "websearch",
  "external_directory",
  "execute",
  "list_mcp_resources",
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
