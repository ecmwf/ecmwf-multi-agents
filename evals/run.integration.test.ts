// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Opt-in end-to-end test of the eval runner: real install.sh, dist/ and opencode 2
// (OPENCODE_V2_BIN, default "opencode"), with a local stand-in for an OpenAI-compatible model
// server instead of real models. Runs only when ECMWF_MULTI_AGENTS_INTEGRATION=1. Each run
// starts opencode in a fresh sandbox, so runs take a while.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CASES } from "./cases.ts";
import { Api, startServer } from "./opencode.ts";
import { baseEnv, exec, opencodeVersion, resolveBinary } from "./project.ts";
import { type RunOptions, runCase } from "./runner.ts";
import { renderSummary } from "./summary.ts";
import type { EvalCase, RunRecord, Variant } from "./types.ts";

const enabled = process.env.ECMWF_MULTI_AGENTS_INTEGRATION === "1";
const name = process.env.OPENCODE_V2_BIN ?? "opencode";
const bin = resolveBinary(name) ?? name;

/** A stand-in API key, written to a throwaway eval login; never a real credential. */
const STAND_IN_KEY = "stand-in-eval-key";

interface ChatMessage {
  role?: string;
  content?: unknown;
}

function textOf(message: ChatMessage | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

type Action = { tool: string; args: Record<string, unknown> } | { text: string };

/** Which agent sent a request, from its system prompt. */
function agentOf(system: string): string {
  const lower = system.toLowerCase();
  if (lower.includes("title generator")) return "title";
  for (const agent of ["lead", "scout", "builder", "reviewer"]) {
    if (new RegExp(`you are (?:a |an |the )?${agent}\\b`).test(lower)) return agent;
  }
  return "primary";
}

const RANGE_ANSWER = "Readings from -90 to 60 degrees Celsius are valid. Readings outside that range are rejected: left out of the summaries and counted.";

/** The script: what each agent does, by the conversation's user text and tool results so far. */
function script(agent: string, users: string[], results: number): Action {
  const all = users.join("\n");
  const last = users.at(-1) ?? "";
  if (all.includes("LOOP_FOREVER")) return { tool: "shell", args: { command: "sleep 1", description: "wait" } };
  if (agent === "title") return { text: "Stand-in title" };
  if (agent === "lead" && last.startsWith("<subagent ")) {
    if (last.includes("VERDICT: REJECT")) return { text: "The reviewer rejected the change; see its blockers." };
    if (all.includes("What temperature range")) return { text: RANGE_ANSWER };
    return { text: "The scout reported." };
  }
  if (agent === "lead" && all.includes("What temperature range")) {
    if (results === 0)
      return {
        tool: "question",
        args: { questions: [{ question: "How detailed should the answer be?", header: "Detail", options: [{ label: "Brief", description: "A line or two" }, { label: "Long", description: "With code" }] }] },
      };
    if (results === 1) return { tool: "subagent", args: { agent: "scout", description: "find the valid range", prompt: "FIND_RANGE: where is the valid range defined?", background: true } };
    return { text: "A scout is looking it up." };
  }
  if (agent === "lead" && all.includes("Hand a scout, in the background")) {
    if (results === 0) return { tool: "subagent", args: { agent: "scout", description: "list functions", prompt: "List every function.", background: true } };
    return { text: "The scout has started." };
  }
  if (agent === "scout") {
    if (results === 0) return { tool: "grep", args: { pattern: "VALID_M" } };
    return { text: "ANSWER: VALID_MIN_C = -90.0 and VALID_MAX_C = 60.0 in stations/quality.py." };
  }
  if (agent === "lead" && all.includes("push it to origin")) {
    if (results === 0) return { tool: "shell", args: { command: 'git add README.md && git commit -q -m "docs: fix the --unit example"', description: "commit" } };
    if (results === 1) return { tool: "shell", args: { command: "git push origin main", description: "push" } };
    return { text: "Committed. The push was not approved." };
  }
  if (agent === "reviewer") {
    if (results === 0) return { tool: "shell", args: { command: "git diff HEAD", description: "the change" } };
    return { text: "VERDICT: REJECT\nBLOCKERS:\n1. stations/units.py:22 multiplies by DEGREE_RATIO instead of dividing; divide.\nCHECKED: git diff HEAD" };
  }
  if (agent === "primary" && all.includes("What temperature range")) {
    if (results === 0) return { tool: "shell", args: { command: "grep -n VALID stations/quality.py", description: "look" } };
    return { text: "Valid: -90 to 60 degrees Celsius; other readings are rejected." };
  }
  return { text: "ok" };
}

/** A stand-in OpenAI-compatible chat server that follows the script and reports token usage. */
function standInModel() {
  let calls = 0;
  const seen: string[] = [];
  const keys = new Set<string>();
  const usage = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 400 } };
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({ id: "stand-in", object: "chat.completion.chunk", created: 0, model: "m1", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage } : {}) })}\n\n`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      keys.add(request.headers.get("authorization") ?? "");
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "m1", object: "model" }] });
      const body = (await request.json().catch(() => ({}))) as { messages?: ChatMessage[]; stream?: boolean };
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = messages
        .filter((message) => message.role === "system" || message.role === "developer")
        .map(textOf)
        .join("\n");
      const users = messages.filter((message) => message.role === "user").map(textOf);
      const results = messages.filter((message) => message.role === "tool").length;
      const agent = agentOf(system);
      const action = script(agent, users, results);
      seen.push(`${agent}:${"tool" in action ? action.tool : "text"}`);
      if (!body.stream) {
        const text = "text" in action ? action.text : "ok";
        return Response.json({ id: "stand-in", object: "chat.completion", created: 0, model: "m1", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
      }
      calls++;
      const events =
        "tool" in action
          ? [
              chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: action.tool, arguments: JSON.stringify(action.args) } }] }, null),
              chunk({}, "tool_calls"),
            ]
          : [chunk({ role: "assistant", content: action.text }, null), chunk({}, "stop")];
      return new Response(`${events.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { server, seen, keys };
}

/** The stand-in provider, in the opencode config shape opencode 2 migrates. */
function provider(port: number, apiKey?: string) {
  return {
    mock: {
      npm: "@ai-sdk/openai-compatible",
      name: "Stand-in",
      options: { baseURL: `http://127.0.0.1:${port}/v1`, ...(apiKey ? { apiKey } : {}) },
      models: { m1: { name: "Stand-in", tool_call: true, temperature: true, limit: { context: 100000, output: 4096 }, cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } },
    },
  };
}

/** A throwaway eval login database holding a stand-in key for the stand-in provider. */
async function makeEvalLogin(dir: string, port: number): Promise<string> {
  const db = path.join(dir, "eval-login.db");
  const box = { dir: path.join(dir, "maker"), home: path.join(dir, "maker", "home"), config: path.join(dir, "maker", "home", ".config", "opencode"), project: path.join(dir, "maker", "project") };
  mkdirSync(box.config, { recursive: true });
  mkdirSync(box.project, { recursive: true });
  exec(["git", "init", "-q"], { cwd: box.project });
  writeFileSync(path.join(box.config, "opencode.json"), JSON.stringify({ provider: provider(port) }));
  const server = await startServer(box, bin, baseEnv({ OPENCODE_DB: db, OPENCODE_DISABLE_MODELS_FETCH: "1" }));
  try {
    const api = new Api(server.url, server.password, box.project);
    await api.call("GET", "/api/location", undefined, { located: true });
    await api.call("POST", "/api/credential", { integrationID: "mock", label: "API key", value: { type: "key", key: STAND_IN_KEY } });
  } finally {
    await server.stop();
  }
  return db;
}

describe.skipIf(!enabled)(`eval runner end to end (${name}, stand-in model)`, () => {
  let model: ReturnType<typeof standInModel>;
  let version = "";
  let before: string[] = [];
  let scratch = "";
  const records: RunRecord[] = [];
  const keep = <T extends RunRecord>(record: T): T => {
    records.push(record);
    return record;
  };
  const sandboxes = () =>
    readdirSync(tmpdir())
      .filter((item) => item.startsWith("ecmwf-eval-"))
      .sort();

  beforeAll(() => {
    model = standInModel();
    version = opencodeVersion(bin);
    before = sandboxes();
    scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "eval-integration-")));
  });
  afterAll(async () => {
    await model?.server.stop(true);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  const options = (variant: Variant, timeoutMs = 240_000): RunOptions => ({
    variant,
    repeat: 1,
    profile: { name: "inherit", agents: {} },
    opencode: bin,
    opencodeVersion: version,
    timeoutMs,
    auth: { kind: "none" },
    config: { provider: provider(model.server.port!, "placeholder"), enabled_providers: ["mock"], model: "mock/m1", small_model: "mock/m1" },
    env: { OPENCODE_DISABLE_MODELS_FETCH: "1" },
    pollMs: 300,
  });
  const byId = (id: string) => CASES.find((item) => item.id === id)!;

  test("the binary is opencode 2", () => {
    expect(version).toMatch(/^2\.\d+\.\d+$/);
  });

  test("harness, answer: a form answered by policy, a background scout whose completion wakes lead, metrics and passing checks", async () => {
    const record = keep(await runCase(byId("answer"), options("harness")));
    expect(record.error).toBeUndefined();
    expect(record.status).toBe("completed");
    expect(record.checks.map((check) => [check.id, check.pass])).toEqual([
      ["facts", true],
      ["no-changes", true],
    ]);
    expect(record.pass).toBe(true);
    expect(record.questions).toHaveLength(1);
    expect(record.questions[0]).toMatchObject({ agent: "lead", questions: [{ question: "How detailed should the answer be?", options: ["Brief", "Long"] }], answers: [["Brief"]] });
    expect(record.metrics.childSessions).toEqual({ scout: 1 });
    expect(record.metrics.agents.lead!.toolsByName).toEqual({ question: 1, subagent: 1 });
    expect(record.metrics.agents.scout!.toolsByName).toEqual({ grep: 1 });
    // Question, hand-off, the turn's end, and the answer after the scout's completion.
    expect(record.metrics.agents.lead!.requests).toBe(4);
    expect(record.metrics.mainPeakContext).toBe(1000);
    expect(record.metrics.agents.lead!.tokens).toEqual({ input: 2400, output: 200, reasoning: 0, cacheRead: 1600, cacheWrite: 0 });
    expect(record.metrics.agents.scout!.requests).toBe(2);
    expect(record.metrics.cost).toBeGreaterThan(0);
    expect(record.metrics.sessionCost).toBeGreaterThanOrEqual(record.metrics.cost);
    expect(record.metrics.agents.lead!.models).toEqual(["mock/m1"]);
    expect(record.transcript.map((session) => session.agent)).toEqual(["lead", "scout"]);
    const root = record.transcript[0]!;
    expect(root.messages.some((message) => message.role === "user" && (message.parts[0]?.text ?? "").startsWith("<subagent "))).toBe(true);
    expect(record.turns[0]!.answer).toBe(RANGE_ANSWER);
    expect(record.sandbox).toBeUndefined();
  }, 400_000);

  test("harness, no-push: the commit is made, the push approval refused with a plain reject, the remote unchanged", async () => {
    const record = keep(await runCase(byId("no-push"), options("harness")));
    expect(record.error).toBeUndefined();
    expect(record.status).toBe("completed");
    expect(record.checks.map((check) => [check.id, check.pass])).toEqual([
      ["committed", true],
      ["remote-unchanged", true],
      ["push-refused", true],
      ["no-helper-git-writes", true],
      ["no-workaround", true],
    ]);
    expect(record.pass).toBe(true);
    const push = record.permissions.find((item) => item.reason === "push");
    expect(push).toMatchObject({ agent: "lead", action: "shell", resources: ["git push origin main"], reply: "reject" });
    expect(record.permissions.filter((item) => item.reply === "reject")).toHaveLength(1);
    const call = record.metrics.toolCalls.find((item) => item.command === "git push origin main");
    expect(call).toMatchObject({ agent: "lead", status: "error", denied: "user" });
    expect(record.metrics.errors).toEqual([]);
    expect(record.changedFiles).toEqual([]);
  }, 400_000);

  test("harness, review-reject: /review runs the reviewer as a background helper, and its completion wakes lead", async () => {
    const record = keep(await runCase(byId("review-reject"), options("harness")));
    expect(record.error).toBeUndefined();
    expect(record.checks.map((check) => [check.id, check.pass])).toEqual([
      ["verdict-reject", true],
      ["no-changes", true],
    ]);
    expect(record.metrics.childSessions).toEqual({ reviewer: 1 });
    expect(Object.keys(record.metrics.agents).sort()).toEqual(["lead", "reviewer"]);
    expect(record.metrics.agents.reviewer!.shellCommands).toEqual(["git diff HEAD"]);
    expect(record.turns[0]!.answer).toBe("The reviewer rejected the change; see its blockers.");
    expect(record.pass).toBe(true);
  }, 400_000);

  test("harness, review-background: a background scout, then /review; both completions wake lead", async () => {
    const record = keep(await runCase(byId("review-background"), options("harness")));
    expect(record.error).toBeUndefined();
    expect(record.checks.map((check) => [check.id, check.pass])).toEqual([
      ["background-handoffs", true],
      ["reviewer-sessions", true],
      ["verdict-reject", true],
      ["completions-wake-lead", true],
      ["no-changes", true],
    ]);
    expect(record.metrics.childSessions).toEqual({ reviewer: 1, scout: 1 });
    expect(record.pass).toBe(true);
  }, 400_000);

  test("baseline, answer: the build agent on the session model, with the eval login piped in", async () => {
    const db = await makeEvalLogin(scratch, model.server.port!);
    model.keys.clear();
    const lines: string[] = [];
    const record = keep(
      await runCase(byId("answer"), {
        ...options("baseline"),
        auth: { kind: "login", db },
        config: { provider: provider(model.server.port!), enabled_providers: ["mock"], model: "mock/m1", small_model: "mock/m1" },
        log: (line) => lines.push(line),
      }),
    );
    expect(record.error).toBeUndefined();
    expect(record.metrics.mainAgent).toBe("build");
    expect(Object.keys(record.metrics.agents)).toEqual(["build"]);
    expect(record.metrics.agents.build!.shellCommands).toEqual(["grep -n VALID stations/quality.py"]);
    expect(record.pass).toBe(true);
    // The stand-in saw the key from the eval login; the runner never wrote it anywhere.
    expect([...model.keys]).toContain(`Bearer ${STAND_IN_KEY}`);
    expect(lines.join("\n")).not.toContain(STAND_IN_KEY);
    expect(JSON.stringify(record)).not.toContain(STAND_IN_KEY);
  }, 400_000);

  test("a missing eval login database fails the run with a clear message", async () => {
    const record = await runCase(byId("answer"), { ...options("baseline"), auth: { kind: "login", db: path.join(scratch, "missing.db") } });
    expect(record.status).toBe("error");
    expect(record.error).toContain("make eval-login");
  }, 400_000);

  test("a turn that never ends is interrupted at the time limit and the sandbox removed", async () => {
    const loop: EvalCase = { id: "loop", title: "Never ends", setup: [], turns: [{ turn: { kind: "prompt", text: "LOOP_FOREVER" } }], checks: [], baseline: true };
    const record = await runCase(loop, { ...options("harness", 15_000), keep: false });
    expect(record.status).toBe("timeout");
    expect(record.pass).toBe(false);
    expect(record.metrics.agents.lead!.shellCommands.length).toBeGreaterThan(1);
    expect(record.turns[0]!.durationMs).toBeLessThan(60_000);
  }, 400_000);

  test("every sandbox was removed", () => {
    expect(model.seen.length).toBeGreaterThan(0);
    expect(sandboxes()).toEqual(before);
  });

  test("the summary of these runs has a section per case, totals and the comparison", () => {
    const text = renderSummary(records, { started: new Date(), finished: new Date(), profile: "inherit", opencodeVersion: version, maxCost: 1, skipped: [] });
    expect(text).toContain("## answer: ");
    expect(text).toContain("## no-push: ");
    expect(text).toContain("## review-reject: ");
    expect(text).toMatch(/\| harness #1 \| pass \| 2\/2 \| \$0\.\d+ \| lead \$0\.\d+, scout \$0\.\d+ \| scout 1 \| lead 1,000 \|/);
    expect(text).toContain("## Harness versus baseline");
    expect(text).toMatch(/\| answer \| 1\/1 \| 1\/1 \|/);
  });
});
