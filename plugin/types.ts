// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Types shared by the plugin and its bundler (tools/bundle-plugin.ts). The plugin has no runtime
// dependencies, so the few platform types it relies on are declared here as structural subsets
// of the published plugin APIs instead of being imported:
//
//   opencode 1.x: @opencode-ai/plugin (packages/plugin/src/index.ts at v1.18.35; identical at
//                 v1.19.0), hooks `config`, `chat.message`, `chat.params`, `tool.execute.before`,
//                 `experimental.session.compacting`, `experimental.chat.messages.transform`.
//   opencode 2:   @opencode/plugin 2.0.16 (dist/promise/plugin.d.ts, dist/promise/agent.d.ts) and
//                 @opencode/schema 2.0.16 (Agent.Info, Model.Ref, Location.Info).

/** Data the bundler embeds into the plugin (see tools/bundle-plugin.ts). */
export interface EmbeddedHarness {
  name: string;
  version: string;
  /** The agent that holds the conversation, owns the review line and becomes the default agent. */
  defaultAgent: string;
  defaultProfile: string;
  profiles: EmbeddedProfile[];
  agents: EmbeddedAgent[];
}

export interface EmbeddedProfile {
  id: string;
  description: string;
  /** Model and reasoning effort per agent; the effort goes to opencode as the model variant. */
  agents: Record<string, { model?: string; effort?: string }>;
}

export interface EmbeddedAgent {
  id: string;
  mode: "primary" | "subagent";
  /** The agent's resolved neutral rules for the `shell` action, in order (last match wins). */
  shell: EmbeddedRule[];
}

export interface EmbeddedRule {
  resource: string;
  effect: "allow" | "ask" | "deny";
}

export const REVIEW_POLICIES = ["auto", "ask", "always", "never"] as const;
export type ReviewPolicy = (typeof REVIEW_POLICIES)[number];

/** Per-agent settings, as written in a settings file. */
export interface AgentOverride {
  model?: string;
  /** Reasoning effort, applied as opencode's model variant. */
  effort?: string;
  steps?: number;
}

/** One valid settings file. */
export interface SettingsFile {
  review?: ReviewPolicy;
  profile?: string;
  default_agent?: boolean;
  agents?: Record<string, AgentOverride>;
}

/** Settings after merging every valid file and filling in the defaults. */
export interface Settings {
  review: ReviewPolicy;
  /** True when a settings file chose the review policy. */
  reviewSet: boolean;
  profile: string;
  defaultAgent: boolean;
  agents: Record<string, AgentOverride>;
}

/** Something worth telling the user, in plain words. */
export interface Problem {
  message: string;
  /** Also show it in the TUI where the platform can: the user wrote something that has no effect. */
  notify: boolean;
}

/** What the plugin reads from the process; replaced in tests. */
export interface Environment {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  platform: string;
  /** File content, or undefined when the file does not exist. Other failures throw. */
  readFile: (file: string) => string | undefined;
}

// opencode 1.x (structural subset of @opencode-ai/plugin and @opencode-ai/sdk).

export interface V1AgentConfig {
  model?: string;
  variant?: string;
  steps?: number;
  prompt?: string;
  mode?: string;
  hidden?: boolean;
  disable?: boolean;
  [key: string]: unknown;
}

export interface V1Config {
  agent?: Record<string, V1AgentConfig | undefined>;
  default_agent?: string;
  [key: string]: unknown;
}

export interface V1Client {
  app?: {
    log?: (options: {
      body: { service: string; level: "debug" | "info" | "warn" | "error"; message: string };
    }) => Promise<unknown>;
  };
  tui?: {
    showToast?: (options: {
      body: { title?: string; message: string; variant: "info" | "success" | "warning" | "error"; duration?: number };
    }) => Promise<unknown>;
  };
  session?: {
    get?: (options: { path: { id: string } }) => Promise<{ data?: { agent?: string } | null } | undefined>;
  };
}

export interface V1PluginInput {
  client?: V1Client;
  directory?: string;
  worktree?: string;
}

export interface V1Hooks {
  config: (config: V1Config) => Promise<void>;
  "chat.message": (input: { sessionID: string; agent?: string }, output: { message?: { agent?: string } }) => Promise<void>;
  "chat.params": (input: { sessionID: string; agent: string }, output: unknown) => Promise<void>;
  "tool.execute.before": (input: { tool: string; sessionID: string; callID?: string }, output: { args?: unknown }) => Promise<void>;
  "experimental.session.compacting": (input: { sessionID: string }, output: unknown) => Promise<void>;
  "experimental.chat.messages.transform": (
    input: unknown,
    output: { messages?: Array<{ info: { role?: string; agent?: string; sessionID?: string }; parts: unknown[] }> },
  ) => Promise<void>;
}

// opencode 2.0.16 (structural subset of @opencode/plugin and @opencode/schema).

export interface V2ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface V2AgentInfo {
  id: string;
  model?: V2ModelRef;
  system?: string;
  mode?: string;
  hidden?: boolean;
  steps?: number;
  [key: string]: unknown;
}

export interface V2AgentEditor {
  list(): V2AgentInfo[];
  get(id: string): V2AgentInfo | undefined;
  default(id: string | undefined): void;
  update(id: string, update: (agent: V2AgentInfo) => void): void;
}

export interface V2Registration {
  dispose: () => Promise<void>;
}

export interface V2Context {
  location?: { directory?: string; project?: { directory?: string } };
  agent: { transform: (callback: (editor: V2AgentEditor) => void) => Promise<V2Registration> };
  event?: { subscribe?: (options?: { signal?: AbortSignal }) => AsyncIterable<{ type?: string }> };
}

export type V2Cleanup = () => Promise<void>;
