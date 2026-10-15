// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Telling the user about problems. opencode 2.0.16 gives promise plugins no logger and no
// toasts (toasts exist only for TUI plugins), so problems go to the server's standard error,
// which `opencode serve` prints and the TUI passes on only with OPENCODE_PRINT_LOGS=1. Each
// message is reported once, and reporting never throws.

import type { Problem } from "./types.ts";

export interface Reporter {
  report(problems: readonly Problem[]): void;
  /** An unexpected error inside the plugin; opencode's configuration was left as it was. */
  internal(where: string, error: unknown): void;
}

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
