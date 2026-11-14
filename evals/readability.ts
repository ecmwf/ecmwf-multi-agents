// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Plain measures of how lead writes, to compare runs with the writing guidance on and off
// (ADR 0006): words per sentence, sentences over 30 words, passive sentences and em dashes in
// lead's final answers, beside pass rates, lead's output tokens and cost. Rough by design: they
// show a direction, and a person reads the answers too.
//
// Usage: bun evals/readability.ts NAME=DIR [NAME=DIR]...   (each DIR an evals/runs/ folder)

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { formatCost } from "./summary.ts";
import type { RunRecord } from "./types.ts";

export interface Measures {
  sentences: number;
  words: number;
  /** Sentences of more than 30 words. */
  long: number;
  /** Sentences with a form of "be" before a past participle. */
  passive: number;
  emDashes: number;
  /** Words in each sentence. */
  lengths: number[];
}

/** The prose of a Markdown answer: no code blocks, inline code, tables or list markers. */
export function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("|"))
    .map((line) =>
      line
        .replace(/`[^`]*`/g, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
        .replace(/^#+\s+/, "")
        .replace(/\s{2,}/g, " ")
        .trim(),
    )
    .filter((line) => line !== "")
    .join("\n");
}

/** Sentences: split at ".", "?" or "!" followed by a space, and at line ends. */
export function sentences(prose: string): string[] {
  return prose
    .split("\n")
    .flatMap((line) => line.split(/(?<=[.?!])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => /[A-Za-z0-9]/.test(sentence));
}

const PASSIVE = /\b(?:is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?\w+(?:ed|en|wn|ung|ept|elt|ought|aught|ade|id|one|ot|un)\b/i;

const wordsOf = (sentence: string) => sentence.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length;

export function measure(text: string): Measures {
  const list = sentences(proseOf(text));
  const lengths = list.map(wordsOf);
  return {
    sentences: list.length,
    words: lengths.reduce((sum, length) => sum + length, 0),
    long: lengths.filter((length) => length > 30).length,
    passive: list.filter((sentence) => PASSIVE.test(sentence)).length,
    emDashes: (text.match(/\u2014/g) ?? []).length,
    lengths,
  };
}

/** lead's final answers in a run. */
function answers(record: RunRecord): string[] {
  return record.turns.flatMap((turn) => (turn.agent === "lead" && typeof turn.answer === "string" ? [turn.answer] : []));
}

function percentile(values: number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)]!;
}

const percent = (part: number, whole: number) => (whole === 0 ? "n/a" : `${Math.round((100 * part) / whole)}%`);

/** A Markdown table with one column per arm. */
export function compareRuns(arms: Record<string, RunRecord[]>): string {
  const names = Object.keys(arms);
  const rows: Array<[string, (records: RunRecord[]) => string]> = [];
  const all = (records: RunRecord[]) => {
    const measures = records.flatMap(answers).map(measure);
    const lengths = measures.flatMap((item) => item.lengths);
    const total = (key: "sentences" | "long" | "passive" | "emDashes") => measures.reduce((sum, item) => sum + item[key], 0);
    return { lengths, sentences: total("sentences"), long: total("long"), passive: total("passive"), emDashes: total("emDashes") };
  };
  rows.push(["Runs passed", (records) => `${records.filter((item) => item.pass).length} of ${records.length} (${percent(records.filter((item) => item.pass).length, records.length)})`]);
  rows.push(["lead output tokens per run", (records) => (records.length === 0 ? "n/a" : String(Math.round(records.reduce((sum, item) => sum + (item.metrics.agents.lead?.tokens.output ?? 0), 0) / records.length)))]);
  rows.push(["Cost", (records) => formatCost(records.reduce((sum, item) => sum + item.metrics.cost, 0))]);
  rows.push(["Sentences in lead's answers", (records) => String(all(records).sentences)]);
  rows.push(["Words per sentence, mean", (records) => {
    const { lengths } = all(records);
    return lengths.length === 0 ? "n/a" : (lengths.reduce((sum, length) => sum + length, 0) / lengths.length).toFixed(1);
  }]);
  rows.push(["Words per sentence, 90th percentile", (records) => String(percentile(all(records).lengths, 0.9))]);
  rows.push(["Sentences over 30 words", (records) => percent(all(records).long, all(records).sentences)]);
  rows.push(["Passive sentences", (records) => percent(all(records).passive, all(records).sentences)]);
  rows.push(["Em dashes", (records) => String(all(records).emDashes)]);
  return [`| Measure | ${names.join(" | ")} |`, `|---|${names.map(() => "---|").join("")}`, ...rows.map(([label, value]) => `| ${label} | ${names.map((name) => value(arms[name]!)).join(" | ")} |`)].join("\n");
}

/** The run records in an evals/runs/ folder. */
export function readRuns(dir: string): RunRecord[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as RunRecord);
}

if (import.meta.main) {
  const arms = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [name, ...dirs] = arg.split("=");
      return [name!, dirs.join("=").split(",").flatMap(readRuns)];
    }),
  );
  if (Object.keys(arms).length === 0) {
    console.error("Usage: bun evals/readability.ts NAME=DIR[,DIR] [NAME=DIR[,DIR]]...");
    process.exit(2);
  }
  console.log(compareRuns(arms));
}
