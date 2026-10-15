#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The npm package's command: runs install.sh from the package folder with the same arguments.
// npm installs this file as a symlink in its bin folder, and install.sh finds the harness files
// next to the path it is run by, so it is run by its real path. Its messages name the command the
// user ran instead of install.sh.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const command = process.env.npm_command === "exec" ? "npx @ecmwf.int/multi-agents" : "ecmwf-multi-agents";
const result = spawnSync("sh", [join(root, "install.sh"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, ECMWF_MULTI_AGENTS_COMMAND: command },
});

if (result.error) {
  console.error(`ecmwf-multi-agents: cannot run install.sh: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
