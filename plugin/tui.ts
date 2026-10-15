// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The TUI entry (tui.js in the plugin folder). Promise plugins on the server have no way to show
// anything, so the TUI asks the server plugin's RPC for the problems found so far, listens for
// new ones, and shows each that is worth it as a warning toast (@opencode/plugin tui/context.ts:
// `client.rpc`, `ui.toast`). Only the RPC definition is shared with the server plugin, so this
// entry stays small.

import { rpcDefinition, type ProblemView } from "./rpc-definition.ts";

/** The part of the TUI plugin context this entry uses. */
export interface TuiContext {
  location?: { directory?: string } | undefined;
  client: {
    rpc: (definition: ReturnType<typeof rpcDefinition>) => {
      problems: (input: unknown, options?: { location?: { directory?: string } }) => Promise<unknown>;
      events: { on: (name: string, handler: (event: { data?: unknown }) => void) => () => void };
    };
  };
  ui: { toast: { show: (options: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number }) => void } };
}

const DURATION_MS = 10_000;

function isProblem(value: unknown): value is ProblemView {
  return value !== null && typeof value === "object" && typeof (value as ProblemView).problem === "string";
}

export function createTui(name: string) {
  return {
    id: name,
    setup(ctx: TuiContext) {
      const shown = new Set<string>();
      const show = (problem: unknown) => {
        if (!isProblem(problem) || !problem.notify || shown.has(problem.problem)) return;
        shown.add(problem.problem);
        try {
          ctx.ui.toast.show({ title: name, message: problem.problem, variant: "warning", duration: DURATION_MS });
        } catch {
          // A toast is best effort.
        }
      };
      let off = () => {};
      try {
        const rpc = ctx.client.rpc(rpcDefinition(name));
        off = rpc.events.on("problem", (event) => show(event?.data));
        const directory = ctx.location?.directory;
        void rpc
          .problems({}, directory === undefined ? undefined : { location: { directory } })
          .then((output) => {
            const list = (output as { problems?: unknown } | undefined)?.problems;
            if (Array.isArray(list)) for (const problem of list) show(problem);
          })
          // No RPC: the server plugin is not active here, and the TUI has nothing to show.
          .catch(() => undefined);
      } catch {
        // An older client without RPC.
      }
      return () => off();
    },
  };
}
