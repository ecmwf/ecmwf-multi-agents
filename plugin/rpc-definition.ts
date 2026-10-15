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
