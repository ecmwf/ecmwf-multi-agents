// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// `bun run check`: the gates every commit must pass, in order, stopping at the first failure:
// dist/ up to date, typecheck, tests, licence information (reuse) and shell scripts
// (shellcheck). Integration tests skip themselves unless ECMWF_MULTI_AGENTS_INTEGRATION=1.

import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const bun = process.execPath;

/** Shell scripts to check: tracked ones, new ones git does not ignore, and install.sh. */
function shellScripts(): string[] {
  let files: string[] = [];
  try {
    const listed = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.sh"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (listed.exitCode === 0) files = listed.stdout.toString().split("\0").filter((file) => file !== "");
  } catch {
    // No git: only install.sh is checked.
  }
  files.push("install.sh");
  return [...new Set(files)].filter((file) => existsSync(path.join(root, file))).sort();
}

interface Step {
  title: string;
  /** The command as a person would type it. */
  shown: string;
  /** What runs; undefined skips the step. */
  argv: string[] | undefined;
  skipped?: string;
}

async function run(step: Step, argv: string[]): Promise<number> {
  console.log(`\n== ${step.title}: ${step.shown}`);
  try {
    const child = Bun.spawn(argv, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await child.exited;
  } catch (error) {
    console.error(`cannot run ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`);
    return 127;
  }
}

async function main(): Promise<number> {
  const scripts = shellScripts();
  const steps: Step[] = [
    { title: "dist/ up to date", shown: "bun tools/build.ts --check", argv: [bun, "tools/build.ts", "--check"] },
    { title: "typecheck", shown: "bunx tsc --noEmit -p .", argv: [bun, "x", "tsc", "--noEmit", "-p", "."] },
    { title: "tests", shown: "bun test", argv: [bun, "test"] },
    { title: "licences", shown: "reuse lint", argv: ["reuse", "lint"] },
    {
      title: "shell scripts",
      shown: `shellcheck -s sh ${scripts.join(" ")}`,
      argv: scripts.length > 0 ? ["shellcheck", "-s", "sh", ...scripts] : undefined,
      skipped: "no shell scripts to check",
    },
  ];
  for (const step of steps) {
    if (step.argv === undefined) {
      console.log(`\n== ${step.title}: skipped, ${step.skipped}`);
      continue;
    }
    const code = await run(step, step.argv);
    if (code !== 0) {
      console.error(`\ncheck failed: ${step.title} (exit code ${code})`);
      return code;
    }
  }
  console.log("\nall checks passed");
  return 0;
}

if (import.meta.main) process.exit(await main());
