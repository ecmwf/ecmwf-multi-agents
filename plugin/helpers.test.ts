// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  Activity,
  HELPER_TOOL_IDS,
  HELPER_TOOLS,
  STATUS_LINES,
  TOOL_SPECS,
  cancelledResult,
  elapsed,
  formatStatus,
  notRunningResult,
  pinMessage,
  splitModel,
  steerText,
  summarizeCall,
  targetProblem,
  toolCallBlock,
  commandHead,
  helperIds,
  remember,
  requiredText,
  type HelperView,
  type PinnableMessage,
} from "./helpers.ts";
import { embeddedFixture } from "./testing.ts";
import { SessionTracker } from "./tools-v2.ts";
import { load } from "../tools/load.ts";
import { resolveHarness } from "../tools/resolve.ts";
import path from "node:path";

const harness = embeddedFixture();
const helpers = new Set(["scout", "builder", "reviewer"]);

describe("tool specs", () => {
  test("three tools with string arguments, named helpers_*", () => {
    expect(Object.values(HELPER_TOOLS)).toEqual(["helpers_status", "helpers_steer", "helpers_cancel"]);
    expect(TOOL_SPECS.status.args).toEqual({});
    expect(Object.keys(TOOL_SPECS.steer.args)).toEqual(["id", "text"]);
    expect(Object.keys(TOOL_SPECS.cancel.args)).toEqual(["id"]);
    for (const spec of Object.values(TOOL_SPECS)) {
      expect(spec.description.length).toBeLessThan(600);
      for (const arg of Object.values(spec.args)) expect(arg.type).toBe("string");
    }
  });

  test("the descriptions carry the rules lead must follow", () => {
    expect(TOOL_SPECS.status.description).toContain("Never use it to wait");
    expect(TOOL_SPECS.steer.description).toContain("continuation parameter");
    expect(TOOL_SPECS.steer.description).toContain("never an approval");
    expect(TOOL_SPECS.cancel.description).toContain('"all"');
  });
});

describe("activity", () => {
  test("counts tool calls per session and keeps the last call summarised", () => {
    const activity = new Activity();
    activity.observe("s1", "bash", { command: "git  log   --oneline" }, 1000);
    activity.observe("s1", "read", { filePath: "/repo/a.py" }, 2000);
    activity.observe("s2", "read", { filePath: `/repo/${"x".repeat(100)}` }, 3000);
    expect(activity.get("s1")).toEqual({ steps: 2, lastTool: "read: /repo/a.py", at: 2000 });
    expect(activity.get("s2")?.lastTool).toBe(`read: /repo/${"x".repeat(51)}...`);
    expect(activity.get("s3")).toBeUndefined();
  });

  test("ignores calls without a session or tool, and records how a run ended", () => {
    const activity = new Activity();
    activity.observe(undefined, "bash", {});
    activity.observe("", "bash", {});
    activity.observe("s", 42, {});
    expect(activity.get("s")).toBeUndefined();
    activity.end("s", "stopped", 5);
    expect(activity.get("s")).toEqual({ steps: 0, at: 5, ended: "stopped" });
    activity.observe("s", "bash", {}, 6);
    expect(activity.get("s")?.ended).toBeUndefined();
  });

  test("summaries fall back to the plain tool name", () => {
    expect(summarizeCall("question", { questions: [] })).toBe("question");
    expect(summarizeCall("bash", null)).toBe("bash");
    expect(summarizeCall("bash", { command: "  " })).toBe("bash");
  });
});

describe("status report", () => {
  const view = (id: string, extra: Partial<HelperView> = {}): HelperView => ({
    id,
    agent: "scout",
    title: `job ${id}`,
    state: "running",
    steps: 3,
    startedAt: 1_000,
    updatedAt: 60_000,
    lastTool: "grep: foo",
    ...extra,
  });

  test("says when there are none", () => {
    expect(formatStatus([], 0)).toBe("No helpers in this session.");
  });

  test("one line per helper: id, agent, state, steps, elapsed, title and last call", () => {
    const text = formatStatus([view("ses_1")], 91_000);
    expect(text).toBe("One helper in this session, newest first:\nses_1, scout, running, 3 steps, 1m 30s: job ses_1; last: grep: foo");
  });

  test("a title is written on one line, however it was given", () => {
    const text = formatStatus([view("ses_1", { title: "first line\nsecond\n\tthird", lastTool: undefined })], 91_000);
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toEndWith(": first line second third");
  });

  test("a finished helper's elapsed time stops at its last activity; empty title and last call are left out", () => {
    const text = formatStatus([view("ses_1", { state: "done", title: " ", steps: 1, lastTool: undefined })], 500_000);
    expect(text).toBe("One helper in this session, newest first:\nses_1, scout, done, 1 step, 59s");
  });

  test("newest first, never more than the line limit", () => {
    const many = Array.from({ length: 20 }, (_, index) => view(`ses_${index}`, { startedAt: index * 1000 }));
    const lines = formatStatus(many, 100_000).split("\n");
    expect(lines).toHaveLength(STATUS_LINES);
    expect(lines[0]).toBe("20 helpers in this session, newest first:");
    expect(lines[1]).toStartWith("ses_19,");
    expect(lines.at(-1)).toBe("and 10 more");
  });

  test("elapsed times read naturally", () => {
    expect(elapsed(0)).toBe("0s");
    expect(elapsed(59_400)).toBe("59s");
    expect(elapsed(61_000)).toBe("1m 1s");
    expect(elapsed(3_600_000 * 2 + 60_000 * 5)).toBe("2h 5m");
    expect(elapsed(-5)).toBe("0s");
  });
});

describe("targets and texts", () => {
  test("a target must exist, be a child of the caller's session and run a helper", () => {
    expect(targetProblem(undefined, "ses_x", "ses_root", helpers)).toBe('No session "ses_x". Run helpers_status for the ids of your helpers.');
    expect(targetProblem({ parentID: "ses_other", agent: "scout" }, "ses_x", "ses_root", helpers)).toBe("ses_x is not a helper of this session.");
    expect(targetProblem({ parentID: "ses_root", agent: "build" }, "ses_x", "ses_root", helpers)).toBe("ses_x is not a harness helper (its agent is build).");
    expect(targetProblem({ parentID: "ses_root", agent: "scout" }, "ses_x", "ses_root", helpers)).toBeUndefined();
    expect(targetProblem({ parentID: "ses_root" }, "ses_x", "ses_root", helpers)).toBeUndefined();
  });

  test("the steer names its sender; the results tell lead what happens next", () => {
    expect(steerText("  stop reading tests  ", "lead")).toBe("lead amends your brief:\nstop reading tests");
    expect(notRunningResult("scout", "ses_1", 'task_id: "ses_1"')).toContain('use the delegation tool with task_id: "ses_1"');
    expect(cancelledResult([])).toBe("No running helper to stop.");
    expect(cancelledResult([{ agent: "scout", id: "ses_1" }])).toStartWith("Stopped scout ses_1. It will not report");
    expect(cancelledResult([{ agent: "scout", id: "ses_1" }, { agent: "builder", id: "ses_2" }])).toContain("Stopped scout ses_1, builder ses_2. They will not report");
  });
});

describe("guard", () => {
  test("helpers are refused the three tools; lead and outsiders are left to the platform", () => {
    for (const helper of helpers) {
      for (const tool of Object.values(HELPER_TOOLS)) {
        expect(toolCallBlock(harness, helper, tool)).toBe(`ecmwf-multi-agents: helpers may not use ${tool}; only lead sees, redirects or stops helpers. Do not try another way: say in your report what is needed.`);
      }
      expect(toolCallBlock(harness, helper, "bash")).toBeUndefined();
    }
    expect(toolCallBlock(harness, "lead", "helpers_steer")).toBeUndefined();
    expect(toolCallBlock(harness, "build", "helpers_steer")).toBeUndefined();
    expect(toolCallBlock(harness, undefined, "helpers_steer")).toBeUndefined();
  });

  test("a helper without a deny rule for a tool is not refused by the guard", () => {
    const extended = embeddedFixture();
    extended.agents.push({ id: "tester", mode: "subagent", shell: [], tools: [{ resource: "helpers_cancel", effect: "deny" }] });
    expect(toolCallBlock(extended, "tester", "helpers_cancel")).toBeDefined();
    expect(toolCallBlock(extended, "tester", "helpers_status")).toBeUndefined();
  });
});

describe("pinning", () => {
  test("splits provider/model at the first slash", () => {
    expect(splitModel("anthropic/claude-sonnet-5-5")).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5-5" });
    expect(splitModel("openrouter/anthropic/claude")).toEqual({ providerID: "openrouter", modelID: "anthropic/claude" });
    expect(splitModel("nomodel")).toBeUndefined();
    expect(splitModel("/x")).toBeUndefined();
    expect(splitModel(undefined)).toBeUndefined();
  });

  test("sets the helper's agent, and its model and effort when it has a model of its own", () => {
    const message = { agent: "lead", model: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "xhigh" } };
    expect(pinMessage(message, "scout", { model: "anthropic/claude-sonnet-5-5", effort: "medium" })).toBe(true);
    expect(message).toEqual({ agent: "scout", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "medium" } });
    expect(pinMessage(message, "scout", { model: "anthropic/claude-sonnet-5-5", effort: "medium" })).toBe(false);
  });

  test("keeps the message's model under inherit, and drops the effort when the helper has none", () => {
    const inherit = { agent: "lead", model: { providerID: "mock", modelID: "m1", variant: "high" } };
    expect(pinMessage(inherit, "builder", undefined)).toBe(true);
    expect(inherit).toEqual({ agent: "builder", model: { providerID: "mock", modelID: "m1", variant: "high" } });
    const noEffort: PinnableMessage = { agent: "lead", model: { providerID: "mock", modelID: "m1", variant: "high" } };
    pinMessage(noEffort, "builder", { model: "acme/big" });
    expect(noEffort.model).toEqual({ providerID: "acme", modelID: "big" });
  });
});

describe("the 2.0.16 session tracker", () => {
  const event = (type: string, data: Record<string, unknown>) => ({ id: "evt", type, data });

  test("follows children of a session through created and execution events, reading the envelope's data", () => {
    const tracker = new SessionTracker();
    tracker.observe(event("session.created", { sessionID: "root", agent: "lead" }), 1);
    tracker.observe(event("session.created", { sessionID: "c1", parentID: "root", agent: "scout", title: "find X" }), 2);
    tracker.observe(event("session.execution.started", { sessionID: "c1" }), 3);
    tracker.observe(event("session.created", { sessionID: "c2", parentID: "root", agent: "builder" }), 4);
    tracker.observe(event("session.execution.started", { sessionID: "c2" }), 5);
    tracker.observe(event("session.execution.interrupted", { sessionID: "c2", reason: "user" }), 6);
    tracker.observe(event("session.renamed", { sessionID: "c2", title: "renamed" }), 7);
    expect(tracker.children("root").map((child) => [child.id, child.agent, child.state, child.title, child.updatedAt])).toEqual([
      ["c1", "scout", "running", "find X", 3],
      ["c2", "builder", "stopped", "renamed", 7],
    ]);
    tracker.observe(event("session.execution.succeeded", { sessionID: "c1" }), 8);
    tracker.observe(event("session.execution.failed", { sessionID: "c1", error: {} }), 9);
    expect(tracker.get("c1")?.state).toBe("failed");
    expect(tracker.children("c1")).toEqual([]);
  });

  test("state updates refresh recency and respect the cap", () => {
    const tracker = new SessionTracker();
    for (let i = 0; i < 5; i++) tracker.observe(event("session.created", { sessionID: `s${i}`, parentID: "root" }), i);
    for (let i = 0; i < 5; i++) tracker.observe(event("session.execution.started", { sessionID: `s${i}` }), 10 + i);
    tracker.observe(event("session.execution.started", { sessionID: "late-unknown" }), 20);
    expect(tracker.get("late-unknown")?.state).toBe("running");
    expect(tracker.children("root")).toHaveLength(5);
  });

  test("ignores events without a type or session, and flat payloads still work", () => {
    const tracker = new SessionTracker();
    tracker.observe(undefined);
    tracker.observe({ type: "session.created" });
    tracker.observe({ type: "plugin.updated", data: {} });
    tracker.observe({ type: "session.created", sessionID: "flat", parentID: "root" });
    expect(tracker.children("root").map((child) => child.id)).toEqual(["flat"]);
  });
});

describe("shared pieces", () => {
  test("the helper ids are the harness's subagents", () => {
    expect([...helperIds(harness)]).toEqual(["scout", "builder", "reviewer"]);
  });

  test("the manifest denies exactly the plugin's tool ids to every helper (one source of truth, guarded here)", async () => {
    const resolved = resolveHarness(await load(path.resolve(import.meta.dir, "..")));
    for (const agent of resolved.agents) {
      const denied = agent.permissions.filter((rule) => rule.action === "tool" && rule.effect === "deny").map((rule) => rule.resource);
      if (agent.mode === "subagent") expect(denied).toEqual([...HELPER_TOOL_IDS]);
      else expect(agent.permissions.some((rule) => rule.action === "tool")).toBe(false);
    }
  });

  test("a required text argument must be a non-empty string", () => {
    expect(requiredText({ id: "  x " }, "id")).toBe("x");
    expect(() => requiredText({ id: "  " }, "id")).toThrow("id must be a non-empty string");
    expect(() => requiredText({}, "id")).toThrow("id must be a non-empty string");
  });

  test("remember keeps insertion order and evicts the oldest entry past the cap", () => {
    const map = new Map<string, number>();
    remember(map, "a", 1, 2);
    remember(map, "b", 2, 2);
    remember(map, "a", 3, 2);
    remember(map, "c", 4, 2);
    expect([...map]).toEqual([
      ["a", 3],
      ["c", 4],
    ]);
  });

  test("call summaries never carry arguments that could hold a secret: a command's head, a URL without its query, a path", () => {
    expect(commandHead("curl -u user:s3cret https://host")).toBe("curl");
    expect(commandHead("git  log --oneline -5")).toBe("git log");
    expect(commandHead("TOKEN=abc python3 -m unittest -v")).toBe("python3 -m unittest");
    expect(commandHead("make --dry-run check")).toBe("make");
    expect(commandHead("   ")).toBe("");
    expect(summarizeCall("bash", { command: "curl -H 'Authorization: Bearer abc' https://x" })).toBe("bash: curl");
    expect(summarizeCall("webfetch", { url: "https://user:pw@host/path?token=abc#frag" })).toBe("webfetch: https://host/path");
    expect(summarizeCall("grep", { pattern: "password = ", path: "/repo/src" })).toBe("grep: /repo/src");
    expect(summarizeCall("websearch", { query: "secret stuff" })).toBe("websearch");
    expect(summarizeCall("task", { description: "slow job", prompt: "the brief" })).toBe("task: slow job");
  });
});
