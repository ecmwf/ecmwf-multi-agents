// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { aggregate } from "./metrics.ts";
import { childSessions, costPerAgent, formatCost, formatDuration, renderSummary } from "./summary.ts";
import type { RunRecord, Variant } from "./types.ts";

function record(variant: Variant, repeat: number, cost: number, pass: boolean, durationMs: number): RunRecord {
  const metrics = aggregate([], [], variant === "harness" ? "lead" : "build");
  metrics.cost = cost;
  metrics.requests = 3;
  metrics.mainPeakContext = variant === "harness" ? 12_000 : 30_000;
  if (variant === "harness") {
    metrics.agents.lead = { ...emptyAgent(), cost: cost * 0.75, requests: 2 };
    metrics.agents.scout = { ...emptyAgent(), cost: cost * 0.25, requests: 1 };
    metrics.childSessions = { scout: 1 };
  } else {
    metrics.agents.build = { ...emptyAgent(), cost, requests: 3 };
  }
  return {
    case: "answer",
    title: "Factual question",
    variant,
    repeat,
    profile: "default",
    review: "auto",
    opencode: { bin: "opencode", version: "1.18.35" },
    started: "2026-10-11T10:00:00.000Z",
    durationMs,
    status: "completed",
    pass,
    turns: [],
    rootSessions: ["s"],
    metrics,
    permissions: [],
    questions: [],
    changedFiles: [],
    diff: "",
    checks: [
      { id: "facts", title: "the answer gives the facts", pass, detail: pass ? "mentions all 3" : "missing 60", recordOnly: false },
      { id: "push", title: "push | refused", pass: false, detail: "no push was attempted", recordOnly: true },
    ],
    transcript: [],
  };
}

function emptyAgent() {
  return aggregate([{ id: "x", messages: [] }], [], "x").agents.unknown!;
}

describe("summary", () => {
  const records = [record("harness", 1, 0.2, true, 65_000), record("baseline", 1, 0.4, false, 30_000)];
  const text = renderSummary(records, {
    started: new Date("2026-10-11T10:00:00Z"),
    finished: new Date("2026-10-11T10:02:00Z"),
    profile: "default",
    opencodeVersion: "1.18.35",
    maxCost: 40,
    skipped: ["onboard.harness.1"],
  });

  test("header with totals and skipped runs", () => {
    expect(text).toContain("- 2 run(s), 1 passed. Total cost $0.600 (limit $40.00).");
    expect(text).toContain("- Not started because the total cost reached the limit: onboard.harness.1.");
  });

  test("a table per case with results, costs, child sessions and peak context", () => {
    expect(text).toContain("## answer: Factual question");
    expect(text).toContain("| harness #1 | pass | 1/1 | $0.200 | lead $0.150, scout $0.050 | scout 1 | lead 12,000 | 3 | 1m 05s |");
    expect(text).toContain("| baseline #1 | FAIL | 0/1 | $0.400 | build $0.400 | none | build 30,000 | 3 | 30s |");
  });

  test("checks per run, recorded-only ones in brackets, failures listed", () => {
    expect(text).toContain("| the answer gives the facts | pass | FAIL |");
    expect(text).toContain("| push \\| refused | (fail) | (fail) |");
    expect(text).toContain("- baseline #1, the answer gives the facts: missing 60");
  });

  test("totals per variant and the comparison", () => {
    expect(text).toContain("| harness | 1 | 1 | $0.200 | $0.200 | 1m 05s | 12,000 |");
    expect(text).toContain("| answer | 1/1 | 0/1 | $0.200 | $0.400 | 0.50x | 1m 05s | 30s | 12,000 | 30,000 |");
    expect(text).toContain("| all compared |");
  });

  test("a run that failed before any check shows its error", () => {
    const broken = { ...record("harness", 2, 0, false, 16_000), status: "error" as const, error: "the sandbox cannot use provider x", checks: [] };
    const out = renderSummary([broken], { started: new Date(0), finished: new Date(1000), profile: "default", opencodeVersion: "1.18.35", maxCost: 1, skipped: [] });
    expect(out).toContain("| harness #2 | FAIL (error) | 0/0 |");
    expect(out).toContain("- harness #2: error: the sandbox cannot use provider x");
  });

  test("no comparison without both variants", () => {
    const only = renderSummary([records[0]!], { started: new Date(0), finished: new Date(1000), profile: "default", opencodeVersion: "1.18.35", maxCost: 1, skipped: [] });
    expect(only).not.toContain("Harness versus baseline");
  });

  test("formatting helpers", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.0123)).toBe("$0.012");
    expect(formatCost(12.345)).toBe("$12.35");
    expect(formatDuration(59_400)).toBe("59s");
    expect(formatDuration(3_725_000)).toBe("62m 05s");
    expect(costPerAgent(records[1]!)).toBe("build $0.400");
    expect(childSessions(records[1]!)).toBe("none");
  });
});
