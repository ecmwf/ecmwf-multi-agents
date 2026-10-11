// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import os from "node:os";
import type { Environment } from "./types.ts";

/** The real process: its variables, home directory and file system. */
export function processEnvironment(): Environment {
  return {
    env: { ...process.env },
    home: os.homedir(),
    platform: process.platform,
    readFile(file) {
      try {
        return readFileSync(file, "utf8");
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") return undefined;
        throw error;
      }
    },
  };
}
