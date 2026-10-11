// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { CASES } from "./cases.ts";
import { listCases, parseArgs, planRuns, timestamp } from "./run.ts";

describe("command line", () => {
  test("defaults", () => {
    expect(parseArgs([])).toEqual({
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
    });
  });

  test("every flag, in both spellings", () => {
    const options = parseArgs([
      "--case",
      "answer",
      "--case=no-push",
      "--repeat",
      "3",
      "--variant=harness",
      "--profile",
      "anthropic",
      "--jobs",
      "4",
      "--max-cost",
      "2.5",
      "--timeout=7.5",
      "--opencode",
      "/opt/opencode",
      "--out",
      "/tmp/out",
      "--list",
    ]);
    expect(options).toMatchObject({
      cases: ["answer", "no-push"],
      repeat: 3,
      variant: "harness",
      profile: "anthropic",
      jobs: 4,
      maxCost: 2.5,
      timeoutMin: 7.5,
      opencode: "/opt/opencode",
      out: "/tmp/out",
      list: true,
    });
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  test.each([
    [["--repeat", "0"], "--repeat needs a positive whole number"],
    [["--jobs", "1.5"], "--jobs needs a positive whole number"],
    [["--max-cost", "-1"], "--max-cost needs a positive number"],
    [["--variant", "all"], "--variant must be harness, baseline or both"],
    [["--case"], "--case needs a value"],
    [["--case", "--list"], "--case needs a value"],
    [["--frobnicate"], "unknown option: --frobnicate"],
  ])("rejects %p", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe("planning runs", () => {
  test("per case and repeat, harness first, baseline only where the case has one", () => {
    const runs = planRuns(CASES, { cases: ["answer", "onboard"], repeat: 2, variant: "both" });
    expect(runs.map((run) => `${run.case.id}.${run.variant}.${run.repeat}`)).toEqual([
      "answer.harness.1",
      "answer.baseline.1",
      "answer.harness.2",
      "answer.baseline.2",
      "onboard.harness.1",
      "onboard.harness.2",
    ]);
    expect(planRuns(CASES, { cases: ["onboard"], repeat: 1, variant: "baseline" })).toEqual([]);
    expect(planRuns(CASES, { cases: [], repeat: 1, variant: "harness" })).toHaveLength(CASES.length);
  });

  test("unknown cases are named", () => {
    expect(() => planRuns(CASES, { cases: ["answer", "nope"], repeat: 1, variant: "both" })).toThrow("unknown case: nope");
  });

  test("the list has one line per case", () => {
    const lines = listCases(CASES).split("\n");
    expect(lines).toHaveLength(CASES.length);
    expect(lines[0]).toMatch(/^answer +harness\+baseline +Factual question/);
    expect(lines.find((line) => line.startsWith("onboard"))).toContain("harness only");
  });

  test("timestamps are UTC and usable as folder names", () => {
    expect(timestamp(new Date("2026-10-11T18:40:05.123Z"))).toBe("2026-10-11T18-40-05Z");
  });
});

describe("the case registry", () => {
  test("about twelve cases with unique ids, turns and checks", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(CASES.map((item) => item.id)).size).toBe(CASES.length);
    for (const item of CASES) {
      expect(item.turns.length).toBeGreaterThan(0);
      expect(item.checks.length).toBeGreaterThan(0);
      expect(new Set(item.checks.map((check) => check.id)).size).toBe(item.checks.length);
    }
  });

  test("cases that use harness commands have no baseline run", () => {
    for (const item of CASES) {
      if (item.turns.some((step) => step.turn.kind === "command")) expect(item.baseline).toBe(false);
    }
  });
});
