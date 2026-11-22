// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The TUI entry (tui.js in the plugin folder). Promise plugins on the server have no way to show
// anything, so the TUI asks the server plugin's RPC for the problems found so far, listens for
// new ones, and shows each that is worth it as a warning toast (@opencode/plugin tui/context.ts:
// `client.rpc`, `ui.toast`). Notices, such as a newer harness being available, come the same way
// on their own method and event and show as information. Only the RPC definition is shared with
// the server plugin, so this entry stays small.

import { rpcDefinition, type NoticeView, type ProblemView } from "./rpc-definition.ts";

/** The part of the TUI plugin context this entry uses. */
export interface TuiContext {
  location?: { directory?: string } | undefined;
  client: {
    rpc: (definition: ReturnType<typeof rpcDefinition>) => {
      problems: (input: unknown, options?: { location?: { directory?: string } }) => Promise<unknown>;
      notices: (input: unknown, options?: { location?: { directory?: string } }) => Promise<unknown>;
      events: { on: (name: string, handler: (event: { data?: unknown }) => void) => () => void };
    };
  };
  ui: { toast: { show: (options: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number }) => void } };
}

const DURATION_MS = 10_000;

function isProblem(value: unknown): value is ProblemView {
  return value !== null && typeof value === "object" && typeof (value as ProblemView).problem === "string";
}

function isNotice(value: unknown): value is NoticeView {
  return value !== null && typeof value === "object" && typeof (value as NoticeView).notice === "string" && typeof (value as NoticeView).id === "number";
}

export function createTui(name: string) {
  return {
    id: name,
    setup(ctx: TuiContext) {
      const toast = (message: string, variant: "info" | "warning") => {
        try {
          ctx.ui.toast.show({ title: name, message, variant, duration: DURATION_MS });
        } catch {
          // A toast is best effort.
        }
      };
      const shown = new Set<string>();
      const show = (problem: unknown) => {
        if (!isProblem(problem) || !problem.notify || shown.has(problem.problem)) return;
        shown.add(problem.problem);
        toast(problem.problem, "warning");
      };
      const noticed = new Set<number>();
      const notify = (notice: unknown) => {
        if (!isNotice(notice) || noticed.has(notice.id)) return;
        noticed.add(notice.id);
        toast(notice.notice, "info");
      };
      const offs: Array<() => void> = [];
      try {
        const rpc = ctx.client.rpc(rpcDefinition(name));
        offs.push(rpc.events.on("problem", (event) => show(event?.data)));
        offs.push(rpc.events.on("notice", (event) => notify(event?.data)));
        const directory = ctx.location?.directory;
        const options = directory === undefined ? undefined : { location: { directory } };
        void rpc
          .problems({}, options)
          .then((output) => {
            const list = (output as { problems?: unknown } | undefined)?.problems;
            if (Array.isArray(list)) for (const problem of list) show(problem);
          })
          // No RPC: the server plugin is not active here, and the TUI has nothing to show.
          .catch(() => undefined);
        void rpc
          .notices({}, options)
          .then((output) => {
            const list = (output as { notices?: unknown } | undefined)?.notices;
            if (Array.isArray(list)) for (const notice of list) notify(notice);
          })
          .catch(() => undefined);
      } catch {
        // An older client without RPC.
      }
      return () => {
        for (const off of offs) off();
      };
    },
  };
}
