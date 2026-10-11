// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Telling the user about problems. opencode 1.x gives plugins a client with a logger
// (`app.log`, written to opencode's log file) and TUI toasts (`tui.showToast`). opencode 2.0.16
// gives promise plugins neither: toasts exist only for TUI plugins, so problems go to the server's
// standard error, which `opencode serve` prints and the TUI passes on only with
// OPENCODE_PRINT_LOGS=1. Each message is reported once, and reporting never throws.

import type { Problem, V1Client } from "./types.ts";

export interface Reporter {
  report(problems: readonly Problem[]): void;
  /** An unexpected error inside the plugin; opencode's configuration was left as it was. */
  internal(where: string, error: unknown): void;
}

/** How long a toast waits, so a TUI that is still starting has subscribed to events. */
export const TOAST_DELAY_MS = 2000;
const TOAST_DURATION_MS = 15000;

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

function internalMessage(name: string, where: string, error: unknown): string {
  return `${name}: internal error in ${where}, settings left unchanged: ${describe(error)}`;
}

export function v1Reporter(name: string, client: V1Client | undefined, schedule: (run: () => void, ms: number) => void = defer): Reporter {
  const seen = new Set<string>();
  const toasts: string[] = [];
  const log = (level: "warn" | "error", message: string) => {
    try {
      void client?.app
        ?.log?.({ body: { service: name, level, message } })
        ?.catch?.(() => undefined);
    } catch {
      // Logging is best effort.
    }
  };
  const toast = (message: string) => {
    toasts.push(message);
    if (toasts.length > 1) return;
    schedule(() => {
      const text = toasts.splice(0).join("\n");
      try {
        void client?.tui
          ?.showToast?.({ body: { title: name, message: text, variant: "warning", duration: TOAST_DURATION_MS } })
          ?.catch?.(() => undefined);
      } catch {
        // Toasts are best effort.
      }
    }, TOAST_DELAY_MS);
  };
  return {
    report(problems) {
      for (const problem of problems) {
        if (seen.has(problem.message)) continue;
        seen.add(problem.message);
        log("warn", problem.message);
        if (problem.notify) toast(problem.message);
      }
    },
    internal(where, error) {
      const message = internalMessage(name, where, error);
      if (seen.has(message)) return;
      seen.add(message);
      log("error", message);
    },
  };
}

export function v2Reporter(name: string, write: (line: string) => void = (line) => console.warn(line)): Reporter {
  const seen = new Set<string>();
  const once = (message: string) => {
    if (seen.has(message)) return;
    seen.add(message);
    try {
      write(message);
    } catch {
      // Reporting is best effort.
    }
  };
  return {
    report(problems) {
      for (const problem of problems) once(problem.message);
    },
    internal(where, error) {
      once(internalMessage(name, where, error));
    },
  };
}

function defer(run: () => void, ms: number): void {
  const timer = setTimeout(run, ms);
  // Never keep a short opencode command such as `opencode debug config` alive for a toast.
  (timer as { unref?: () => void }).unref?.();
}
