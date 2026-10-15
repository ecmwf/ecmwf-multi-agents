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
  steerText,
  summarizeCall,
  targetProblem,
  toolCallBlock,
  commandHead,
  helperIds,
  urlHead,
  remember,
  requiredText,
  type HelperView,
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
    activity.observe("s2", "bash", { command: `${"x".repeat(100)} arg` }, 3000);
    expect(activity.get("s1")).toEqual({ steps: 2, lastTool: "read", at: 2000 });
    expect(activity.get("s2")?.lastTool).toBe(`bash: ${"x".repeat(57)}...`);
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
    // A new run (a new message) clears an earlier ending even before any tool call.
    activity.end("s", "failed", 7);
    activity.resume("s", 8);
    expect(activity.get("s")).toEqual({ steps: 1, lastTool: "bash", at: 8 });
    activity.resume("never-seen");
    expect(activity.get("never-seen")).toBeUndefined();
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
    expect(toolCallBlock(harness, "lead", "bash")).toBeUndefined();
    // Every other caller is refused too: the tools are lead's, and the platform's default rules
    // would otherwise let any agent reach a plugin tool.
    expect(toolCallBlock(harness, "build", "helpers_steer")).toBe("ecmwf-multi-agents: build may not use helpers_steer; only lead sees, redirects or stops helpers. Do not try another way: say in your report what is needed.");
    expect(toolCallBlock(harness, undefined, "helpers_steer")).toContain("an unknown agent may not use helpers_steer");
    expect(toolCallBlock(harness, "build", "bash")).toBeUndefined();
  });

  test("the refusal does not depend on the manifest's rules: a helper added without any is refused too", () => {
    const extended = embeddedFixture();
    extended.agents.push({ id: "tester", mode: "subagent" });
    for (const tool of Object.values(HELPER_TOOLS)) expect(toolCallBlock(extended, "tester", tool)).toContain("helpers may not use");
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
    // Quoted or expanded text never reaches the head: the shell-aware splitter handles it.
    expect(commandHead("TOKEN='alpha beta' python3 -m unittest")).toBe("python3 -m unittest");
    expect(commandHead("PASS=\"a b\" git push")).toBe("git push");
    expect(commandHead("\"s3cret\" && ls")).toBe("");
    expect(commandHead("git $SUB x")).toBe("git");
    expect(commandHead("python3 -m \"my mod\"")).toBe("python3");
    expect(commandHead("cd /tmp && curl -u a:b host")).toBe("cd");
    // A program given by path shows nothing: its segments are arbitrary text.
    expect(commandHead("/tmp/prod-token-abc/run --all")).toBe("");
    expect(commandHead("./configure --prefix=/x")).toBe("");
    expect(commandHead("git /tmp/token/sub")).toBe("git");
    expect(summarizeCall("bash", { command: "curl -H 'Authorization: Bearer abc' https://x" })).toBe("bash: curl");
    expect(summarizeCall("webfetch", { url: "https://user:pw@host/reset/t0k3n?token=abc#frag" })).toBe("webfetch: https://host");
    // Anything but a web URL with a host shows nothing: no scheme to strip secrets from safely.
    expect(urlHead("user:s3cret@host")).toBe("");
    expect(urlHead("ftp://user:pw@host/file")).toBe("");
    expect(urlHead("not a url")).toBe("");
    expect(urlHead("http://host:8080/a/b")).toBe("http://host:8080");
    expect(summarizeCall("webfetch", { url: "mailto:someone@x?subject=s3cret" })).toBe("webfetch");
    // Paths are arbitrary text too and are not shown.
    expect(summarizeCall("grep", { pattern: "password = ", path: "/repo/src" })).toBe("grep");
    expect(summarizeCall("read", { filePath: "/repo/config/prod-token-abc.json" })).toBe("read");
    expect(summarizeCall("websearch", { query: "secret stuff" })).toBe("websearch");
    // Free text the model wrote is never shown; a hand-off shows the agent it named.
    expect(summarizeCall("task", { description: "job with a password: hunter2", prompt: "the brief", subagent_type: "scout" })).toBe("task: scout");
    expect(summarizeCall("subagent", { description: "d", prompt: "p", agent: "builder" })).toBe("subagent: builder");
    expect(summarizeCall("task", { description: "slow job", prompt: "the brief" })).toBe("task");
  });
});
