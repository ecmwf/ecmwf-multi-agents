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
] as const;
export type Action = (typeof ACTIONS)[number];

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
