// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The plugin's RPC as both ends declare it: the server plugin registers it (rpc.ts) and the TUI
// entry calls it (tui.ts). Inputs and outputs are plain JSON, so the schemas accept any value.

import type { V2RpcDefinition } from "./types.ts";

export function rpcDefinition(id: string): V2RpcDefinition {
  return {
    id,
    methods: {
      doctor: { input: {}, output: {} },
      problems: { input: {}, output: {} },
    },
    events: { problem: { schema: { type: "object" } } },
  };
}

/** A problem as the RPC returns it. `notify`: worth a toast, because something the user wrote has no effect. */
export interface ProblemView {
  problem: string;
  notify: boolean;
}

/** What `doctor` answers; `install.sh doctor` reads it without a JSON tool, so keep it flat. */
export interface DoctorView {
  name: string;
  version: string;
  /** The first agent opencode lists, which is its default agent. */
  defaultAgent: string | null;
  leadLoaded: boolean;
  /**
   * "harness" when the lead opencode loaded is the harness's own, as the settings make it;
   * "changed" when a field differs (named in `leadChanged`); null when lead is not loaded.
   */
  leadDefinition: "harness" | "changed" | null;
  /** The fields that differ: system, description, mode, hidden, color, permissions, model, effort, steps. */
  leadChanged: string[];
  /** lead.md files where opencode reads agent files: they may explain a change, they do not prove one. */
  leadCandidateFiles: string[];
  /** opencode configs with an `agents.lead` (or `agent.lead`) entry, which may also explain a change. */
  leadConfigFiles: string[];
  reviewLine: string | null;
  leadModel: string | null;
  settings: { review: string; profile: string; default_agent: boolean; agents: Record<string, unknown> };
  settingsFiles: string[];
  settingsSources: Record<string, string>;
  problems: ProblemView[];
  plugins: Array<{ id: string | null; status: string | null; error?: string }>;
}
