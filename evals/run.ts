// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Scenario eval runner. Runs each case on the harness (lead and its helpers, installed with
// install.sh) and on plain opencode 2 with its build agent on lead's model, in fresh sandboxes,
// and writes one JSON record per run and summary.md. Calls real models with the eval login
// (make eval-login): see evals/README.md.
//
// Usage: bun evals/run.ts [--case ID]... [--repeat N] [--variant harness|baseline|both]
//          [--profile NAME] [--jobs N] [--max-cost USD] [--timeout MIN] [--opencode BIN]
//          [--out DIR] [--list]

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CASES } from "./cases.ts";
import { checkEvalLogin } from "./login.ts";
import { killServers, UNAVAILABLE } from "./opencode.ts";
import { loadProfile, loginPlugins, opencodeVersion, type Profile, REPO, removeLiveBoxes, resolveBinary } from "./project.ts";
import { runCase } from "./runner.ts";
import { renderSummary } from "./summary.ts";
import type { EvalCase, RunRecord, Variant } from "./types.ts";

export interface Options {
  cases: string[];
  repeat: number;
  variant: Variant | "both";
  profile: string;
  jobs: number;
  maxCost: number;
  timeoutMin: number;
  opencode: string;
  out: string | undefined;
  list: boolean;
  help: boolean;
}

export const USAGE = `Usage: bun evals/run.ts [options]

Options:
  --case ID        Run this case; repeat the option for several (default: all cases).
  --repeat N       Runs per case and variant (default 1).
  --variant V      harness, baseline or both (default both).
  --profile NAME   Harness profile; the baseline uses its lead model (default "default").
  --jobs N         Runs at the same time (default 2).
  --max-cost USD   Start no new run once the total cost reaches this (default 40).
  --timeout MIN    Time limit for each turn, in minutes (default 20).
  --opencode BIN   opencode 2 binary (default "opencode").
  --out DIR        Output folder (default evals/runs/<UTC timestamp>/).
  --list           List the cases and exit.
  -h, --help       Show this help.

The runs call real models and use your provider quota, through the eval login
made with \`make eval-login\`.`;

function positiveNumber(flag: string, value: string | undefined, integer: boolean): number {
  const parsed = Number(value);
  if (value === undefined || value.trim() === "" || !Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${flag} needs a positive ${integer ? "whole number" : "number"}, not ${JSON.stringify(value ?? "")}`);
  }
  return parsed;
}

/** Parses the command line; throws an Error with a message for the user on bad input. */
export function parseArgs(argv: string[]): Options {
  const options: Options = {
    cases: [],
    repeat: 1,
    variant: "both",
    profile: "default",
    jobs: 2,
    maxCost: 40,
    timeoutMin: 20,
    opencode: "opencode",
    out: undefined,
    list: false,
    help: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    let flag = args.shift()!;
    let value: string | undefined;
    const eq = flag.indexOf("=");
    if (flag.startsWith("--") && eq > 0) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    const take = (): string => {
      const next = value ?? args.shift();
      if (next === undefined || (value === undefined && next.startsWith("--"))) throw new Error(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case "--case":
        options.cases.push(take());
        break;
      case "--repeat":
        options.repeat = positiveNumber(flag, take(), true);
        break;
      case "--variant": {
        const variant = take();
        if (variant !== "harness" && variant !== "baseline" && variant !== "both") throw new Error(`--variant must be harness, baseline or both, not ${variant}`);
        options.variant = variant;
        break;
      }
      case "--profile":
        options.profile = take();
        break;
      case "--jobs":
        options.jobs = positiveNumber(flag, take(), true);
        break;
      case "--max-cost":
        options.maxCost = positiveNumber(flag, take(), false);
        break;
      case "--timeout":
        options.timeoutMin = positiveNumber(flag, take(), false);
        break;
      case "--opencode":
        options.opencode = take();
        break;
      case "--out":
        options.out = take();
        break;
      case "--list":
        options.list = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  return options;
}

/** One line per case: id, whether it has a baseline run, and its title. */
export function listCases(cases: readonly EvalCase[]): string {
  const width = Math.max(...cases.map((item) => item.id.length));
  return cases.map((item) => `${item.id.padEnd(width)}  ${item.baseline ? "harness+baseline" : "harness only    "}  ${item.title}`).join("\n");
}

export interface PlannedRun {
  case: EvalCase;
  variant: Variant;
  repeat: number;
}

/** The runs to do, in order: per case, per repeat, harness before baseline. */
export function planRuns(cases: readonly EvalCase[], options: Pick<Options, "cases" | "repeat" | "variant">): PlannedRun[] {
  const unknown = options.cases.filter((id) => !cases.some((item) => item.id === id));
  if (unknown.length > 0) throw new Error(`unknown case: ${unknown.join(", ")} (see --list)`);
  const chosen = options.cases.length === 0 ? cases : cases.filter((item) => options.cases.includes(item.id));
  const runs: PlannedRun[] = [];
  for (const item of chosen) {
    for (let repeat = 1; repeat <= options.repeat; repeat++) {
      if (options.variant !== "baseline") runs.push({ case: item, variant: "harness", repeat });
      if (options.variant !== "harness" && item.baseline) runs.push({ case: item, variant: "baseline", repeat });
    }
  }
  return runs;
}

/** UTC timestamp usable as a folder name, such as 2026-10-11T18-40-05Z. */
export function timestamp(date = new Date()): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

async function main(argv: string[]): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.list) {
    console.log(listCases(CASES));
    return 0;
  }
  let runs: PlannedRun[];
  try {
    runs = planRuns(CASES, options);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
  if (runs.length === 0) {
    console.error("Error: nothing to run (a baseline-only selection of cases without a baseline?)");
    return 2;
  }

  const login = checkEvalLogin();
  if (!login.ok) {
    console.error(`Error: ${login.message}`);
    return 1;
  }
  let profile: Profile;
  try {
    profile = loadProfile(options.profile);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    return 1;
  }
  // A path, because each sandbox links it in as its `opencode`.
  const opencode = resolveBinary(options.opencode);
  if (!opencode) {
    console.error(`Error: ${options.opencode} not found; name an opencode 2 binary with --opencode.`);
    return 1;
  }
  const version = opencodeVersion(opencode);
  if (!/^2\./.test(version)) {
    console.error(`Error: ${options.opencode} reports version "${version}"; the evals need opencode 2.`);
    return 1;
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.error(`\nInterrupted: stopping opencode and removing the sandboxes.`);
      killServers();
      removeLiveBoxes();
      process.exit(130);
    });
  }

  const out = path.resolve(options.out ?? path.join(REPO, "evals", "runs", timestamp()));
  mkdirSync(out, { recursive: true });
  const started = new Date();
  console.log(`${runs.length} run(s), ${options.jobs} at a time, profile ${profile.name}, opencode ${version}; output in ${out}`);

  const records: RunRecord[] = [];
  const skipped: PlannedRun[] = [];
  const plugins = loginPlugins();
  let total = 0;
  let next = 0;
  let blocked: string | undefined;
  const worker = async () => {
    while (next < runs.length) {
      const planned = runs[next++]!;
      if (total >= options.maxCost || blocked !== undefined) {
        skipped.push(planned);
        continue;
      }
      const label = `${planned.case.id}.${planned.variant}.${planned.repeat}`;
      console.log(`start ${label}`);
      const record = await runCase(planned.case, {
        variant: planned.variant,
        repeat: planned.repeat,
        profile,
        opencode,
        opencodeVersion: version,
        timeoutMs: options.timeoutMin * 60_000,
        auth: { kind: "login", db: login.path },
        plugins,
        log: (line) => console.log(`  [${label}] ${line}`),
      });
      // Every later run would fail the same way.
      if (record.error?.startsWith(UNAVAILABLE)) blocked = record.error;
      // opencode's session totals also count title requests, which no message shows.
      total += Math.max(record.metrics.cost, record.metrics.sessionCost);
      records.push(record);
      writeFileSync(path.join(out, `${label}.json`), `${JSON.stringify(record, null, 2)}\n`);
      const passed = record.checks.filter((check) => check.pass && !check.recordOnly).length;
      const counted = record.checks.filter((check) => !check.recordOnly).length;
      console.log(
        `done  ${label}: ${record.pass ? "PASS" : "FAIL"} (${passed}/${counted} checks, ${record.status}), ${formatCost(record.metrics.cost)}, ${Math.round(record.durationMs / 1000)} s; total ${formatCost(total)}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.jobs, runs.length) }, worker));

  const summary = renderSummary(records, {
    started,
    finished: new Date(),
    profile: profile.name,
    opencodeVersion: version,
    maxCost: options.maxCost,
    skipped: skipped.map((item) => `${item.case.id}.${item.variant}.${item.repeat}`),
    skippedReason: blocked !== undefined ? "the sandbox cannot use the profile's models" : "the total cost reached the limit",
  });
  writeFileSync(path.join(out, "summary.md"), summary);
  console.log(`\nTotal cost ${formatCost(total)}. Summary: ${path.join(out, "summary.md")}`);
  if (blocked !== undefined) console.error(`\nStopped: ${blocked}`);
  else if (skipped.length > 0) console.log(`${skipped.length} run(s) not started: the total cost reached --max-cost ${formatCost(options.maxCost)}.`);
  return records.every((record) => record.pass) && skipped.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
