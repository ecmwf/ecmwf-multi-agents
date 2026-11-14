// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { compareRuns, measure, proseOf, sentences } from "./readability.ts";
import type { RunRecord } from "./types.ts";

describe("prose", () => {
  test("leaves out code blocks, inline code, tables and list markers, and keeps the words", () => {
    const text = "Run this:\n\n```sh\nmake check\n```\n\n- Use `bun test` here.\n1. Then stop.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    expect(proseOf(text)).toBe("Run this:\nUse here.\nThen stop.");
  });

  test("splits sentences at full stops, question and exclamation marks, and line ends", () => {
    expect(sentences("One two. Three four five? Six!\nSeven eight")).toEqual(["One two.", "Three four five?", "Six!", "Seven eight"]);
    // Not at a decimal point or a file name.
    expect(sentences("It is 2.5 times faster in plugin/v2.ts today.")).toHaveLength(1);
  });
});

describe("measure", () => {
  test("words per sentence, long sentences, passive sentences and em dashes", () => {
    const long = Array.from({ length: 31 }, () => "word").join(" ");
    const result = measure(`The file was changed by the builder. I ran the tests. ${long}. A note \u2014 here.`);
    expect(result.sentences).toBe(4);
    expect(result.words).toBe(7 + 4 + 31 + 3);
    expect(result.long).toBe(1);
    expect(result.passive).toBe(1);
    expect(result.emDashes).toBe(1);
    expect(result.lengths).toEqual([7, 4, 31, 3]);
  });

  test("an empty answer measures nothing", () => {
    expect(measure("")).toEqual({ sentences: 0, words: 0, long: 0, passive: 0, emDashes: 0, lengths: [] });
  });
});

function record(id: string, pass: boolean, answer: string, output: number, cost: number): RunRecord {
  return {
    case: id,
    pass,
    turns: [{ turn: { kind: "prompt", text: "q" }, skipped: false, agent: "lead", answer }],
    metrics: { cost, agents: { lead: { tokens: { output } } } },
  } as unknown as RunRecord;
}

test("compareRuns: pass rates, lead's output tokens, cost and the measures of lead's answers, per arm", () => {
  const on = [record("answer", true, "Short one. Short two.", 100, 0.1), record("answer", false, "Short.", 50, 0.1)];
  const off = [record("answer", true, "This sentence is rather longer than the others are.", 120, 0.2)];
  const table = compareRuns({ on, off });
  expect(table).toContain("| Measure | on | off |");
  expect(table).toContain("| Runs passed | 1 of 2 (50%) | 1 of 1 (100%) |");
  expect(table).toContain("| lead output tokens per run | 75 | 120 |");
  expect(table).toContain("| Words per sentence, mean | 1.7 | 9.0 |");
  expect(table).toContain("| Cost | $0.200 | $0.200 |");
});
