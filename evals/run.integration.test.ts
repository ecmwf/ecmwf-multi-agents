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
import { baseEnv, exec, opencodeVersion, resolveBinary, skillsDenied } from "./project.ts";
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
  for (const agent of ["lead", "scout", "builder", "reviewer", "researcher", "tester", "designer", "data scientist", "inspector"]) {
    if (new RegExp(`you are (?:a |an |the )?${agent}\\b`).test(lower)) return agent.replace(" ", "-");
  }
  return "primary";
}

const RANGE_ANSWER = "Readings from -90 to 60 degrees Celsius are valid. Readings outside that range are rejected: left out of the summaries and counted.";

/** The script: what each agent does, by the conversation's user text and tool results so far. */
function script(agent: string, users: string[], results: number, tools: { texts: string[]; sinceUser: number } = { texts: [], sinceUser: 0 }): Action {
  const all = users.join("\n");
  const last = users.at(-1) ?? "";
  // designer-limit: the designer reaches its step limit with its spec started, and lead continues it.
  if (agent === "designer" && last.includes("CRITICAL - MAXIMUM STEPS REACHED")) {
    return { text: "STATUS: PARTIAL\nSPEC: .ecmwf-multi-agents/design/compare/spec.md\nPROTOTYPE: not built yet\nNOT CHECKED: the prototype" };
  }
  if (agent === "designer" && all.includes("FINISH_DESIGN")) {
    if (tools.sinceUser === 0) return { tool: "write", args: { path: ".ecmwf-multi-agents/design/compare/index.html", content: "<!doctype html><title>Compare</title>\n" } };
    return { text: "STATUS: DONE\nSPEC: .ecmwf-multi-agents/design/compare/spec.md\nPROTOTYPE: .ecmwf-multi-agents/design/compare/index.html" };
  }
  if (agent === "designer" && all.includes("DESIGN_COMPARE")) {
    if (results === 0) return { tool: "write", args: { path: ".ecmwf-multi-agents/design/compare/spec.md", content: "# Compare two stations\n\nGoal, users and flow.\n" } };
    return { tool: "glob", args: { pattern: "*" } };
  }
  if (agent === "lead" && all.includes("compares two stations")) {
    const report = tools.texts.at(-1) ?? "";
    if (results === 0) return { tool: "subagent", args: { agent: "designer", description: "design the comparison page", prompt: "DESIGN_COMPARE: design the station comparison page." } };
    const session = /sessionID="([^"]+)"/.exec(report)?.[1];
    if (results === 1 && report.includes("STATUS: PARTIAL") && session !== undefined) {
      return { tool: "subagent", args: { agent: "designer", sessionID: session, description: "finish the design", prompt: "FINISH_DESIGN: finish the prototype and report." } };
    }
    return { text: "The designer finished the spec and the prototype." };
  }
  // designer-limit-twice: the designer reaches its limit twice, and lead puts the plugin's offer to the user.
  if (agent === "designer" && all.includes("DESIGN_WEEKS")) {
    if (results === 0) return { tool: "write", args: { path: ".ecmwf-multi-agents/design/weeks/spec.md", content: "# Weekly summaries\n\nGoal, users and flow.\n" } };
    return { tool: "glob", args: { pattern: "*" } };
  }
  if (agent === "lead" && all.includes("weekly summaries")) {
    if (last.startsWith("Note from the ecmwf-multi-agents plugin")) {
      const raised = /"steps": (\d+)/.exec(last)?.[1] ?? "?";
      return {
        tool: "question",
        args: { questions: [{ question: `The designer reached its step limit twice. Raise it to ${raised} steps for this project?`, header: "Designer steps", options: [{ label: `Raise to ${raised} (Recommended)`, description: "It can finish; costs more" }, { label: "Keep 6", description: "Cheaper; it may stop again" }] }] },
      };
    }
    const report = tools.texts.at(-1) ?? "";
    if (results === 0) return { tool: "subagent", args: { agent: "designer", description: "design the weekly page", prompt: "DESIGN_WEEKS: design the weekly summaries page." } };
    const session = /sessionID="([^"]+)"/.exec(report)?.[1];
    if (results === 1 && report.includes("STATUS: PARTIAL") && session !== undefined) {
      return { tool: "subagent", args: { agent: "designer", sessionID: session, description: "carry on with the design", prompt: "KEEP_GOING: carry on with the design and report." } };
    }
    if (results === 3 && report.includes("Raise to")) {
      return { tool: "write", args: { path: ".opencode/ecmwf-multi-agents.jsonc", content: '{ "agents": { "designer": { "enabled": true, "steps": 9 } } }\n' } };
    }
    return { text: "The designer's spec is started; its step limit is now 9 from the next start." };
  }
  // harden: the inspector reports, the user picks the first finding, builder fixes, reviewer approves, lead commits, the inspector rechecks.
  if (agent === "inspector") {
    if (last.includes("RECHECK")) return { text: "STATUS: DONE\nRECHECK: S1 CLOSED: pack runs tar without a shell." };
    // The skill first, as the brief of /harden asks; with the skills denied the call fails and the review goes on.
    if (results === 0) return { tool: "skill", args: { id: "ecmwf-multi-agents-security-code" } };
    if (results === 1) return { tool: "write", args: { path: ".ecmwf-multi-agents/security/archive.md", content: "# Findings\n\nS1 shell injection; S2 pickle.\n" } };
    return {
      text:
        "STATUS: DONE\nREPORT: .ecmwf-multi-agents/security/archive.md\n" +
        "FINDINGS: S1 [PY1], high, high; WHERE: stations/archive.py:9; WEAKNESS: shell injection through the folder name; ADVICE: pass a list, no shell; PROS: no injection; CONS: none; ALTERNATIVES: none.\n" +
        "S2 [PY2], medium, high; WHERE: stations/archive.py:15; WEAKNESS: pickle runs code from the cache file; ADVICE: JSON; PROS: no code from data; CONS: old caches unreadable; ALTERNATIVES: none.\n" +
        "S3 [PY5], high, medium; WHERE: stations/fetch.py:11; WEAKNESS: extractall without a filter writes outside dest; ADVICE: filter=data; PROS: no path traversal; CONS: none; ALTERNATIVES: none.\n" +
        "S4 [PY7], medium, medium; WHERE: stations/fetch.py:22; WEAKNESS: a mktemp name can be taken first; ADVICE: mkstemp; PROS: no race; CONS: none; ALTERNATIVES: none.\n" +
        "S5 [C6], low, medium; WHERE: tools/keyring.c:6; WEAKNESS: memset before free may be removed; ADVICE: explicit_bzero; PROS: the key is really cleared; CONS: none; ALTERNATIVES: none.\n" +
        "CHECKS: none\nNOT CHECKED: unpack_checked and pack_list are safe as written.",
    };
  }
  if (agent === "builder" && all.includes("FIX_SHELL")) {
    if (results === 0) {
      const fixed = 'import pickle\nimport subprocess\n\n\ndef pack(folder):\n    """Write <folder>.tar.gz next to the folder."""\n    subprocess.run(["tar", "czf", f"{folder}.tar.gz", folder], check=True)\n\n\ndef load_cache(path):\n    """Read a summary cached by an earlier run."""\n    with open(path, "rb") as handle:\n        return pickle.load(handle)\n';
      return { tool: "write", args: { path: "stations/archive.py", content: fixed } };
    }
    return { text: "STATUS: DONE\nCHANGED: stations/archive.py\nCHECKS: none run" };
  }
  if (agent === "reviewer" && all.includes("REVIEW_FIX")) {
    if (results === 0) return { tool: "shell", args: { command: "git diff", description: "the change" } };
    return { text: "VERDICT: APPROVE\nCHECKED: git diff" };
  }
  if (agent === "lead" && all.includes("Harden the security of")) {
    const inspected = /sessionID="([^"]+)"/.exec(tools.texts[0] ?? "")?.[1];
    if (results === 0) return { tool: "subagent", args: { agent: "inspector", description: "inspect the module", prompt: "INSPECT: review stations/archive.py for security weaknesses." } };
    if (results === 1) {
      const options = [
        { label: "S1 shell injection in pack (Recommended)", description: "Pro: no injection. Con: none." },
        { label: "S2 pickle in load_cache", description: "Pro: no code from data. Con: old caches unreadable." },
      ];
      return { tool: "question", args: { questions: [{ question: "Which findings should be fixed?", header: "Findings", multiple: true, options }] } };
    }
    if (results === 2) return { tool: "subagent", args: { agent: "builder", description: "fix the shell injection", prompt: "FIX_SHELL: run tar without a shell in stations/archive.py." } };
    if (results === 3) return { tool: "subagent", args: { agent: "reviewer", description: "check the fix", prompt: "REVIEW_FIX: check that pack no longer uses a shell." } };
    if (results === 4) return { tool: "shell", args: { command: 'git add stations/archive.py && git commit -q -m "fix(security): pack runs tar without a shell"', description: "commit the fix" } };
    if (results === 5 && inspected !== undefined) return { tool: "subagent", args: { agent: "inspector", sessionID: inspected, description: "recheck", prompt: "RECHECK S1 against the last commit." } };
    return { text: "S1 fixed and committed; the inspector says CLOSED. S2 not picked." };
  }
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
  if (agent === "lead" && all.includes("Try hard to break")) {
    if (results === 0) return { tool: "subagent", args: { agent: "tester", description: "break the conversions", prompt: "BREAK: try to break the conversions in stations/units.py; fix nothing." } };
    return { text: "The tester found that fahrenheit_to_celsius multiplies instead of dividing; its issue draft is ready." };
  }
  if (agent === "tester") {
    if (results === 0) return { tool: "write", args: { path: ".ecmwf-multi-agents/issues/fahrenheit-to-celsius.md", content: "# fahrenheit_to_celsius multiplies by 1.8 instead of dividing\n" } };
    if (results === 1) {
      const test = "import unittest\n\nfrom stations.units import celsius_to_fahrenheit, fahrenheit_to_celsius\n\n\nclass RoundTrip(unittest.TestCase):\n    def test_round_trip(self):\n        self.assertAlmostEqual(fahrenheit_to_celsius(celsius_to_fahrenheit(20.0)), 20.0)\n";
      return { tool: "write", args: { path: "tests/test_units_break.py", content: test } };
    }
    return { text: "STATUS: DONE\nFINDINGS: high: fahrenheit_to_celsius multiplies by DEGREE_RATIO instead of dividing; draft .ecmwf-multi-agents/issues/fahrenheit-to-celsius.md\nTESTS: tests/test_units_break.py: a round trip\nCHECKS: none run\nNOT TESTED: the other units" };
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
      // Like a model without assistant prefill (Claude Opus 5.5): a request must end with a user message.
      if (messages.at(-1)?.role === "assistant") {
        return Response.json({ error: { type: "invalid_request_error", message: "This model does not support assistant message prefill." } }, { status: 400 });
      }
      const lastUser = messages.map((message) => message.role).lastIndexOf("user");
      const texts = messages.filter((message) => message.role === "tool").map(textOf);
      const sinceUser = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
      const action = script(agent, users, results, { texts, sinceUser });
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

  test("harness, review-reject: /review is answered by the reviewer in the user's session, with no child session", async () => {
    const record = keep(await runCase(byId("review-reject"), options("harness")));
    expect(record.error).toBeUndefined();
    expect(record.checks.map((check) => [check.id, check.pass])).toEqual([
      ["verdict-reject", true],
      ["no-changes", true],
    ]);
    expect(record.metrics.childSessions).toEqual({});
    expect(Object.keys(record.metrics.agents).sort()).toEqual(["reviewer"]);
    expect(record.metrics.agents.reviewer!.shellCommands).toEqual(["git diff HEAD"]);
    expect(record.turns[0]!.answer).toStartWith("VERDICT: REJECT");
    expect(record.pass).toBe(true);
  }, 400_000);

  test("harness, review-background: a background scout, then /review in the session; the scout's completion wakes lead", async () => {
    const record = keep(await runCase(byId("review-background"), options("harness")));
    expect(record.error).toBeUndefined();
    expect(record.checks.map((check) => [check.id, check.pass])).toEqual([
      ["background-handoffs", true],
      ["reviewer-inline", true],
      ["verdict-reject", true],
      ["completions-wake-lead", true],
      ["no-changes", true],
    ]);
    expect(record.metrics.childSessions).toEqual({ scout: 1 });
    expect(record.pass).toBe(true);
  }, 400_000);

  test("harness, tester-break: the project's settings switch tester on; lead hands it the work, and it writes only a test and an issue draft", async () => {
    const record = keep(await runCase(byId("tester-break"), options("harness")));
    expect(record.error).toBeUndefined();
    expect(record.checks.map((check) => [check.id, check.pass])).toEqual([
      ["tester-sessions", true],
      ["tester-report", true],
      ["issue-draft", true],
      ["tests-only", true],
    ]);
    expect(record.metrics.childSessions).toEqual({ tester: 1 });
    expect(record.metrics.agents.tester!.toolsByName).toEqual({ write: 2 });
    expect(record.changedFiles.sort()).toEqual([".ecmwf-multi-agents/issues/fahrenheit-to-celsius.md", "tests/test_units_break.py"]);
    expect(record.pass).toBe(true);
  }, 400_000);

  test("harness, designer-limit: the designer reports at its step limit with its spec started, and lead continues its session", async () => {
    const record = keep(await runCase(byId("designer-limit"), options("harness")));
    expect(record.error).toBeUndefined();
    expect(record.checks.map((check) => [check.id, check.pass])).toEqual([
      ["designer-sessions", true],
      ["designer-no-errors", true],
      ["designer-continued", true],
      ["spec", true],
      ["lead-not-written", true],
      ["no-changes", true],
    ]);
    expect(record.metrics.childSessions).toEqual({ designer: 1 });
    expect(record.changedFiles.sort()).toEqual([".ecmwf-multi-agents/design/compare/index.html", ".ecmwf-multi-agents/design/compare/spec.md"]);
    expect(record.pass).toBe(true);
  }, 400_000);

  test("harness, designer-limit-twice: the designer reaches its limit twice, lead asks with the plugin's offer, and the project file gets the higher limit", async () => {
    const record = keep(await runCase(byId("designer-limit-twice"), options("harness")));
    expect(record.error).toBeUndefined();
    expect(record.checks.map((check) => [check.id, check.pass])).toEqual([
      ["designer-no-errors", true],
      ["designer-continued", true],
      ["steps-offer", true],
      ["designer-steps-raised", true],
      ["no-changes", true],
    ]);
    expect(record.questions).toHaveLength(1);
    expect(record.questions[0]).toMatchObject({ agent: "lead", answers: [["Raise to 9 (Recommended)"]] });
    expect(record.changedFiles.sort()).toEqual([".ecmwf-multi-agents/design/weeks/spec.md", ".opencode/ecmwf-multi-agents.jsonc"]);
    expect(record.pass).toBe(true);
  }, 400_000);

  test("harness, harden: the inspector reports, the first finding is picked, builder fixes, reviewer approves, one fix(security) commit, the inspector rechecks", async () => {
    const record = keep(await runCase(byId("harden"), options("harness")));
    expect(record.error).toBeUndefined();
    expect(record.checks.map((check) => [check.id, check.pass])).toEqual([
      ["helpers-ran", true],
      ["findings-question", true],
      ["security-commit", true],
      ["weakness-removed", true],
      ["tests-pass", true],
      ["only-archive", true],
      ["never-pushed", true],
    ]);
    expect(record.metrics.childSessions).toEqual({ inspector: 1, builder: 1, reviewer: 1 });
    expect(record.questions[0]).toMatchObject({ agent: "lead", answers: [["S1 shell injection in pack (Recommended)"]] });
    expect(record.pass).toBe(true);
  }, 400_000);

  test("harness, harden-code with the security skills allowed and denied: the inspector loads the code skill only where it may, and the run goes on either way", async () => {
    const allowed = keep(await runCase(byId("harden-code"), options("harness")));
    expect(allowed.error).toBeUndefined();
    expect(allowed.checks.map((check) => [check.id, check.pass])).toEqual([
      ["found-tar", true],
      ["found-mktemp", true],
      ["found-memset", true],
      ["decoys-not-reported", true],
      ["inspector-loaded-security-code", true],
      ["cites-ids", true],
      ["tests-pass", true],
      ["never-pushed", true],
    ]);
    const base = options("harness");
    const denied = keep(await runCase(byId("harden-code"), { ...base, skills: "off", config: { ...base.config, ...skillsDenied() } }));
    expect(denied.error).toBeUndefined();
    expect(denied.skills).toBe("off");
    expect(denied.checks.find((check) => check.id === "inspector-loaded-security-code")!.pass).toBe(false);
    // Recorded only: the denied skill does not decide the result.
    expect(denied.pass).toBe(true);
  }, 600_000);

  test("harness, harden-off: with the inspector off, /harden refuses with the plugin's message and no model turn", async () => {
    const record = keep(await runCase(byId("harden-off"), options("harness")));
    expect(record.error).toBeUndefined();
    expect(record.turns[0]!.refusal).toContain("The inspector is switched off here, so /harden cannot run.");
    expect(record.metrics.requests).toBe(0);
    expect(record.pass).toBe(true);
  }, 400_000);

  test("harness, review-off: with the reviewer switched off, /review refuses with the plugin's message and no model turn", async () => {
    const record = keep(await runCase(byId("review-off"), options("harness")));
    expect(record.error).toBeUndefined();
    expect(record.status).toBe("completed");
    expect(record.checks.map((check) => [check.id, check.pass])).toEqual([
      ["reviewer-off", true],
      ["reviewer-never-ran", true],
      ["lead-never-ran", true],
      ["no-changes", true],
    ]);
    expect(record.turns[0]!.refusal).toContain("is switched off here, so /review cannot run");
    expect(record.metrics.requests).toBe(0);
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
