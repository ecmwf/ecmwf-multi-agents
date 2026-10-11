// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// summary.md: one section per case with its runs and checks, totals per variant, and the
// harness compared with the baseline.

import type { RunRecord, Variant } from "./types.ts";

export interface SummaryInfo {
  started: Date;
  finished: Date;
  profile: string;
  opencodeVersion: string;
  maxCost: number;
  /** Runs not started, and why. */
  skipped: string[];
  skippedReason?: string;
}

export function formatCost(value: number): string {
  if (value === 0) return "$0";
  return value < 0.995 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function formatTokens(value: number): string {
  return Math.round(value).toLocaleString("en-GB");
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** "lead $0.10, scout $0.020": agents by cost, highest first. */
export function costPerAgent(record: RunRecord): string {
  const entries = Object.entries(record.metrics.agents)
    .filter(([, metrics]) => metrics.cost > 0 || metrics.requests > 0)
    .sort((a, b) => b[1].cost - a[1].cost);
  return entries.length === 0 ? "none" : entries.map(([agent, metrics]) => `${agent} ${formatCost(metrics.cost)}`).join(", ");
}

/** "scout 2, builder 1", or "none". */
export function childSessions(record: RunRecord): string {
  const entries = Object.entries(record.metrics.childSessions).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length === 0 ? "none" : entries.map(([agent, count]) => `${agent} ${count}`).join(", ");
}

function counted(record: RunRecord): { passed: number; total: number } {
  const checks = record.checks.filter((check) => !check.recordOnly);
  return { passed: checks.filter((check) => check.pass).length, total: checks.length };
}

function runLabel(record: RunRecord): string {
  return `${record.variant} #${record.repeat}`;
}

function caseSection(id: string, records: RunRecord[]): string[] {
  const lines = [`## ${id}: ${records[0]!.title}`, ""];
  lines.push("| Run | Result | Checks | Cost | Cost per agent | Child sessions | Peak context (main agent) | Requests | Duration |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const record of records) {
    const { passed, total } = counted(record);
    const result = record.pass ? "pass" : record.status === "completed" ? "FAIL" : `FAIL (${record.status})`;
    lines.push(
      `| ${runLabel(record)} | ${result} | ${passed}/${total} | ${formatCost(record.metrics.cost)} | ${cell(costPerAgent(record))} | ${cell(childSessions(record))} | ${record.metrics.mainAgent} ${formatTokens(record.metrics.mainPeakContext)} | ${record.metrics.requests} | ${formatDuration(record.durationMs)} |`,
    );
  }
  const checkIds: Array<{ id: string; title: string }> = [];
  for (const record of records) {
    for (const check of record.checks) if (!checkIds.some((item) => item.id === check.id)) checkIds.push({ id: check.id, title: check.title });
  }
  if (checkIds.length > 0) {
    lines.push("", `| Check | ${records.map(runLabel).join(" | ")} |`, `|---|${records.map(() => "---|").join("")}`);
    for (const { id: checkId, title } of checkIds) {
      const cells = records.map((record) => {
        const check = record.checks.find((item) => item.id === checkId);
        if (!check) return "n/a";
        const word = check.pass ? "pass" : "FAIL";
        return check.recordOnly ? `(${word.toLowerCase()})` : word;
      });
      lines.push(`| ${cell(title)} | ${cells.join(" | ")} |`);
    }
  }
  const failures = records.flatMap((record) =>
    record.checks.filter((check) => !check.pass).map((check) => `- ${runLabel(record)}, ${check.title}${check.recordOnly ? " (recorded only)" : ""}: ${check.detail}`),
  );
  const errors = records.filter((record) => record.error).map((record) => `- ${runLabel(record)}: ${record.status}: ${record.error}`);
  if (failures.length + errors.length > 0) lines.push("", ...[...errors, ...failures].map((line) => line.replace(/\s*\n\s*/g, " ")));
  lines.push("");
  return lines;
}

interface VariantTotals {
  runs: number;
  passed: number;
  cost: number;
  meanCost: number;
  meanDuration: number;
  meanPeak: number;
}

function totals(records: RunRecord[]): VariantTotals {
  return {
    runs: records.length,
    passed: records.filter((record) => record.pass).length,
    cost: records.reduce((sum, record) => sum + record.metrics.cost, 0),
    meanCost: mean(records.map((record) => record.metrics.cost)),
    meanDuration: mean(records.map((record) => record.durationMs)),
    meanPeak: mean(records.map((record) => record.metrics.mainPeakContext)),
  };
}

function ratio(a: number, b: number): string {
  return b === 0 ? "n/a" : `${(a / b).toFixed(2)}x`;
}

export function renderSummary(records: RunRecord[], info: SummaryInfo): string {
  const lines: string[] = ["<!-- Generated by evals/run.ts. -->", "", "# Eval summary", ""];
  const all = totals(records);
  lines.push(
    `- Started ${info.started.toISOString()}, finished ${info.finished.toISOString()} (${formatDuration(info.finished.getTime() - info.started.getTime())}).`,
    `- opencode ${info.opencodeVersion}, profile \`${info.profile}\`.`,
    `- ${all.runs} run(s), ${all.passed} passed. Total cost ${formatCost(all.cost)} (limit ${formatCost(info.maxCost)}).`,
  );
  if (info.skipped.length > 0) lines.push(`- Not started because ${info.skippedReason ?? "the total cost reached the limit"}: ${info.skipped.join(", ")}.`);
  lines.push(
    "",
    "A run passes when it finished and every counted check passed. Checks in brackets are recorded only and do not decide the result. Cost is what opencode reports for each model request. Peak context is the largest input of one request by the agent that holds the conversation (lead, or build for the baseline), cached tokens included.",
    "",
  );

  const caseIds = [...new Set(records.map((record) => record.case))];
  for (const id of caseIds) {
    const runs = records.filter((record) => record.case === id).sort((a, b) => a.variant.localeCompare(b.variant) * -1 || a.repeat - b.repeat);
    lines.push(...caseSection(id, runs));
  }

  lines.push("## Totals", "", "| Variant | Runs | Passed | Total cost | Mean cost | Mean duration | Mean peak context |", "|---|---|---|---|---|---|---|");
  for (const variant of ["harness", "baseline"] as Variant[]) {
    const group = records.filter((record) => record.variant === variant);
    if (group.length === 0) continue;
    const t = totals(group);
    lines.push(`| ${variant} | ${t.runs} | ${t.passed} | ${formatCost(t.cost)} | ${formatCost(t.meanCost)} | ${formatDuration(t.meanDuration)} | ${formatTokens(t.meanPeak)} |`);
  }
  lines.push("");

  const compared = caseIds.filter((id) => records.some((record) => record.case === id && record.variant === "harness") && records.some((record) => record.case === id && record.variant === "baseline"));
  if (compared.length > 0) {
    lines.push(
      "## Harness versus baseline",
      "",
      "Means per run. A cost ratio below 1 means the harness was cheaper.",
      "",
      "| Case | Passed, harness | Passed, baseline | Mean cost, harness | Mean cost, baseline | Cost ratio | Mean duration, harness | Mean duration, baseline | Peak context, harness | Peak context, baseline |",
      "|---|---|---|---|---|---|---|---|---|---|",
    );
    const harnessAll: RunRecord[] = [];
    const baselineAll: RunRecord[] = [];
    for (const id of compared) {
      const h = records.filter((record) => record.case === id && record.variant === "harness");
      const b = records.filter((record) => record.case === id && record.variant === "baseline");
      harnessAll.push(...h);
      baselineAll.push(...b);
      const th = totals(h);
      const tb = totals(b);
      lines.push(
        `| ${id} | ${th.passed}/${th.runs} | ${tb.passed}/${tb.runs} | ${formatCost(th.meanCost)} | ${formatCost(tb.meanCost)} | ${ratio(th.meanCost, tb.meanCost)} | ${formatDuration(th.meanDuration)} | ${formatDuration(tb.meanDuration)} | ${formatTokens(th.meanPeak)} | ${formatTokens(tb.meanPeak)} |`,
      );
    }
    const th = totals(harnessAll);
    const tb = totals(baselineAll);
    lines.push(
      `| all compared | ${th.passed}/${th.runs} | ${tb.passed}/${tb.runs} | ${formatCost(th.meanCost)} | ${formatCost(tb.meanCost)} | ${ratio(th.meanCost, tb.meanCost)} | ${formatDuration(th.meanDuration)} | ${formatDuration(tb.meanDuration)} | ${formatTokens(th.meanPeak)} | ${formatTokens(tb.meanPeak)} |`,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
