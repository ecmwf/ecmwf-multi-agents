// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Types shared by the plugin and its bundler (tools/bundle-plugin.ts). The plugin has no runtime
// dependencies, so the few platform types it relies on are declared here as structural subsets
// of the published plugin APIs instead of being imported: @opencode/plugin 2.0.16
// (dist/promise/plugin.d.ts, dist/promise/agent.d.ts) and @opencode/schema 2.0.16 (Agent.Info,
// Model.Ref, Location.Info).

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
  /** File content, or undefined when the file does not exist. Other failures throw. */
  readFile: (file: string) => string | undefined;
}

/** One JSON Schema property of a tool argument. */
export interface ArgSchema {
  type: "string";
  description: string;
}

/** What opencode passes to a tool: the calling session and agent. */
export interface ToolContext {
  sessionID: string;
  agent: string;
  abort?: AbortSignal;
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

/** An event as the 2.0.16 subscription yields it: an envelope with the payload under `data`. */
export interface V2Event {
  type?: string;
  data?: unknown;
  sessionID?: string;
  parentID?: string;
  agent?: string;
  title?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface V2SessionInfo {
  id: string;
  parentID?: string;
  agent?: string;
  title?: string;
  time?: { created?: number; updated?: number };
}

/** A tool as `editor.add` takes it (@opencode/plugin 2.0.16, promise/tool.ts:30). */
export interface V2ToolInfo {
  name: string;
  description: string;
  input: { type: "object"; properties: Record<string, ArgSchema>; required?: string[]; additionalProperties?: boolean };
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<{ content: string }>;
  options?: { codemode?: boolean };
}

export interface V2ToolEditor {
  add(tool: V2ToolInfo): void;
  remove(id: string): void;
}

export interface V2ToolCall {
  tool: string;
  sessionID: string;
  agent: string;
  input?: unknown;
}

/** A message as a model request carries it (@opencode/ai Message: a role and content parts). */
export interface V2ModelMessage {
  role?: string;
  content?: ReadonlyArray<{ type?: string; text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** The `context` session hook's event: the request being built for an agent (plugin/src/promise/session.ts:25-36). */
export interface V2ContextEvent {
  sessionID?: string;
  agent?: string;
  messages?: V2ModelMessage[];
  [key: string]: unknown;
}

export interface V2Context {
  location?: { directory?: string; project?: { directory?: string } };
  agent: { transform: (callback: (editor: V2AgentEditor) => void) => Promise<V2Registration> };
  event?: { subscribe?: (options?: { signal?: AbortSignal }) => AsyncIterable<V2Event> };
  tool?: {
    transform?: (callback: (editor: V2ToolEditor) => void) => Promise<V2Registration>;
    hook?: (name: "execute.before", callback: (call: V2ToolCall) => Promise<void> | void) => Promise<V2Registration>;
  };
  session?: {
    get?: (input: { sessionID: string }) => Promise<V2SessionInfo | undefined>;
    prompt?: (input: { sessionID: string; text: string; delivery?: "steer" | "queue" }) => Promise<unknown>;
    interrupt?: (input: { sessionID: string }) => Promise<unknown>;
    /** A message opencode writes as its own; `queue` delivers it once the running turn has ended. */
    synthetic?: (input: { sessionID: string; text: string; description?: string; delivery?: "steer" | "queue" }) => Promise<unknown>;
    hook?: (name: "context", callback: (event: V2ContextEvent) => Promise<void> | void) => Promise<V2Registration>;
  };
}

export type V2Cleanup = () => Promise<void>;
