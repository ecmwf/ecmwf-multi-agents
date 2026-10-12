// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Opt-in check of the platform mechanics that background helpers, steering and cancel build on
// (docs/research/background-helpers.md). Runs only when ECMWF_MULTI_AGENTS_INTEGRATION=1.
// Binaries: OPENCODE_V1_BINS (space-separated, default "opencode") and OPENCODE_V2_BIN (default
// "opencode2"). No hosted model is contacted: every agent runs on a scripted stand-in that
// speaks the OpenAI chat-completions protocol on 127.0.0.1 and records each request.
//
// The script: lead delegates a slow job to the builder (a few `sleep` steps) in the background
// or the foreground; the builder stops early when a later user message tells it to. Each
// scenario tags its prompts so the request log can be read per session.
//
// What is pinned here, per platform: a background hand-off returns at once and the completion
// wakes lead; a message sent to a running child reaches its model at the next step boundary;
// what a cancel and a promotion do; and, on 1.x, that a message without the child's agent
// switches the rest of the run to the message's agent (the hazard the plugin's pinning fixes).
// Then, with the bundled plugin installed: lead's helpers_status, helpers_steer and
// helpers_cancel work against a running builder, a builder's call to them is refused, and on
// 1.x a message that names lead in a builder's session still runs as the builder.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundlePlugin } from "../tools/bundle-plugin.ts";
import { emitV1 } from "../tools/emit-v1.ts";
import { V2_VERSION, emitV2 } from "../tools/emit-v2.ts";
import type { OutputFile, ResolvedHarness } from "../tools/types.ts";
import { HELPER_TOOLS, STATUS_LINES } from "./helpers.ts";
import { resolvedFixture } from "./testing.ts";

const enabled = process.env.ECMWF_MULTI_AGENTS_INTEGRATION === "1";
const v1Bins = (process.env.OPENCODE_V1_BINS ?? "opencode").split(/\s+/).filter((bin) => bin !== "");
const v2Bin = process.env.OPENCODE_V2_BIN ?? "opencode2";
/** True when the 2.0.16 binary runs; its suite is skipped otherwise, as the other suites do. */
const v2Available = (() => {
  if (!enabled) return false;
  try {
    return Bun.spawnSync([v2Bin, "--version"]).exitCode === 0;
  } catch {
    return false;
  }
})();
const root = path.resolve(import.meta.dir, "..");
const sandboxScript = path.join(root, "tools", "sandbox.sh");

/** Tool steps the builder takes before it finishes on its own, and the length of each. */
const STEPS = 5;
const STEP_SECONDS = 1.5;
const RUN_MS = STEPS * STEP_SECONDS * 1000;

const ISOLATION = {
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
};

// ---------------------------------------------------------------------------------------------
// Stand-in model

/** One streamed request as the stand-in saw it. */
interface Seen {
  /** lead, builder, or other (opencode's own agents, or a child whose run switched agent). */
  agent: "lead" | "builder" | "other";
  /** The text of every user message, in order. */
  users: string[];
  /** Tool results in the request: how many steps the agent had taken. */
  results: number;
  at: number;
  /** What the stand-in answered: `tool:<name>` or the text. */
  reply: string;
}

interface Script {
  /** The delegation tool and its argument names on this platform. */
  delegate: (prompt: string, background: boolean, continueId?: string) => { name: string; args: Record<string, unknown> };
  shell: string;
}

const textOf = (message: unknown): string => {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
};

/**
 * The stand-in. lead: `BG <tag>` delegates `SLOW <tag>` to the builder in the background,
 * `FG <tag>` in the foreground, `CONTINUE <id> <tag>` sends `MORE <tag>` to a running child;
 * anything else ends the turn. builder: `sleep` steps until it has taken STEPS, or until a
 * later user message says STOP (then it reports how many steps it had taken) or MORE.
 */
function standIn(script: Script) {
  const seen: Seen[] = [];
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "stand-in",
      object: "chat.completion.chunk",
      created: 0,
      model: "m1",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
    })}\n\n`;
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "m1", object: "model" }] });
      const body = (await request.json().catch(() => ({}))) as { messages?: unknown[]; stream?: boolean };
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const role = (message: unknown) => (message as { role?: string } | undefined)?.role;
      const system = messages.filter((message) => role(message) === "system" || role(message) === "developer").map(textOf).join("\n");
      const users = messages.filter((message) => role(message) === "user").map(textOf);
      const last = users.at(-1) ?? "";
      const results = messages.filter((message) => role(message) === "tool").length;
      const agent: Seen["agent"] = system.includes("You are lead") ? "lead" : system.includes("You are builder") ? "builder" : "other";
      let tool: { name: string; args: Record<string, unknown> } | undefined;
      let text = "ok";
      if (agent === "lead") {
        const bg = /^BG (\S+)/.exec(last);
        const fg = /^FG (\S+)/.exec(last);
        const more = /^CONTINUE (\S+) (\S+)/.exec(last);
        const continued = messages.some((message) => role(message) === "tool" && textOf(message).includes("Background task updated"));
        const status = /^STATUS (\S+)/.exec(last);
        const steer = /^STEER (\S+) (\S+)/.exec(last);
        const cancel = /^CANCEL (\S+) (\S+)/.exec(last);
        if (bg && results === 0) tool = script.delegate(`SLOW ${bg[1]}`, true);
        else if (fg && results === 0) tool = script.delegate(`SLOW ${fg[1]}`, false);
        else if (more && !continued) tool = script.delegate(`MORE ${more[2]}`, true, more[1]);
        else if (status && !messages.some((message) => role(message) === "tool" && /helpers? in this session/.test(textOf(message))))
          tool = { name: HELPER_TOOLS.status, args: {} };
        else if (steer && !messages.some((message) => role(message) === "tool" && /Sent to|not running|not a helper/.test(textOf(message))))
          tool = { name: HELPER_TOOLS.steer, args: { id: steer[1], text: "STOP and report what you did" } };
        else if (cancel && !messages.some((message) => role(message) === "tool" && /Stopped|not running|not a helper/.test(textOf(message))))
          tool = { name: HELPER_TOOLS.cancel, args: { id: cancel[1] } };
        else text = "lead done";
      } else if (agent === "builder") {
        // A steer arrives as "lead amends your brief:\nSTOP ..."; on 2.0.16 the first message starts
        // with the platform's own "You are a subagent spawned by another session." line.
        const forbidden = users[0]?.includes("SLOW forbidden-") && results === 0;
        if (users.some((user) => /(^|\n)STOP/.test(user))) text = `builder stopped after ${results} steps`;
        else if (users.some((user) => /(^|\n)MORE/.test(user))) text = `builder continued after ${results} steps`;
        else if (forbidden) tool = { name: HELPER_TOOLS.status, args: {} };
        else if (results < STEPS) tool = { name: script.shell, args: { command: `sleep ${STEP_SECONDS}`, description: "slow step" } };
        else text = "builder finished";
      }
      calls++;
      seen.push({ agent, users, results, at: Date.now(), reply: tool ? `tool:${tool.name}` : text });
      if (!body.stream) {
        return Response.json({
          id: "stand-in",
          object: "chat.completion",
          created: 0,
          model: "m1",
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      const events = tool
        ? [
            chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }, null),
            chunk({}, "tool_calls"),
          ]
        : [chunk({ role: "assistant", content: text }, null), chunk({}, "stop")];
      return new Response(`${events.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  /** The builder's requests for one scenario tag. */
  const builder = (tag: string) => seen.filter((item) => item.agent === "builder" && item.users[0]?.endsWith(tag));
  /** lead's requests whose first user message carries the tag. */
  const lead = (tag: string) => seen.filter((item) => item.agent === "lead" && item.users[0]?.endsWith(tag));
  /** Every request whose first user message carries the tag, whatever agent answered. */
  const all = (tag: string) => seen.filter((item) => item.users[0]?.endsWith(tag));
  return Object.assign(server, { seen, builder, lead, all });
}

// ---------------------------------------------------------------------------------------------
// Sandboxes and servers

interface Sandbox {
  dir: string;
  project: string;
  config: string;
}

function makeSandbox(prefix: string, files: OutputFile[]): Sandbox {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  const project = path.join(dir, "project");
  mkdirSync(project, { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: project });
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
  const config = path.join(dir, "home", ".config", "opencode");
  for (const file of files) {
    const target = path.join(config, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  return { dir, project, config };
}

/** The fixture with every model removed, so all agents run on the stand-in's session model. */
function modelLessFixture(): ResolvedHarness {
  const harness = resolvedFixture();
  for (const agent of harness.agents) {
    delete agent.model;
    delete agent.variant;
  }
  return harness;
}

async function within<T>(ms: number, what: string, attempt: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    const value = await attempt().catch((error: unknown) => {
      last = error;
      return undefined;
    });
    if (value !== undefined) return value;
    await Bun.sleep(150);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

interface Server {
  url: string;
  stop: () => Promise<void>;
}

/** Flags an enclosing opencode session may export; each server here sets them on purpose or not at all. */
const EXPERIMENTAL_FLAGS = ["OPENCODE_EXPERIMENTAL", "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"];

async function startServer(box: Sandbox, bin: string, env: Record<string, string>): Promise<Server> {
  const inherited = { ...process.env };
  for (const flag of EXPERIMENTAL_FLAGS) delete inherited[flag];
  const proc = Bun.spawn([sandboxScript, box.dir, bin, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: box.project,
    env: { ...inherited, ...ISOLATION, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout = "";
  let stderr = "";
  const drain = async (stream: ReadableStream<Uint8Array>, sink: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) sink(decoder.decode(chunk));
  };
  void drain(proc.stdout, (text) => (stdout += text));
  void drain(proc.stderr, (text) => (stderr += text));
  const stop = async () => {
    proc.kill();
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
    if (!exited) proc.kill("SIGKILL");
  };
  try {
    const url = await within(120_000, "the server address", async () => {
      if (proc.exitCode !== null) throw new Error(`opencode serve exited with ${proc.exitCode}\n${stderr}`);
      return /listening on (http:\/\/\S+)/.exec(stdout)?.[1];
    });
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

let tags = 0;
const nextTag = () => `t${++tags}`;

// ---------------------------------------------------------------------------------------------
// opencode 1.x

interface V1Part {
  type: string;
  tool?: string;
  synthetic?: boolean;
  text?: string;
  state?: { status: string; input?: Record<string, unknown>; output?: string; error?: string };
}
interface V1Message {
  info: { role: string; agent?: string };
  parts: V1Part[];
}

const v1Script: Script = {
  delegate: (prompt, background, continueId) => ({
    name: "task",
    args: { description: "slow job", prompt, subagent_type: "builder", background, ...(continueId ? { task_id: continueId } : {}) },
  }),
  shell: "bash",
};

for (const bin of v1Bins) {
  describe.skipIf(!enabled)(`background helpers in opencode 1.x (${bin})`, () => {
    let box: Sandbox;
    let model: ReturnType<typeof standIn>;
    let server: Server;
    let api: <T = unknown>(method: string, route: string, body?: unknown) => Promise<T>;

    const connect = (url: string) => async <T = unknown>(method: string, route: string, body?: unknown): Promise<T> => {
      const target = new URL(route, url);
      target.searchParams.set("directory", box.project);
      const response = await fetch(target, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    };
    const messages = (session: string) => api<V1Message[]>("GET", `/session/${session}/message`);
    const taskParts = async (session: string) => (await messages(session)).flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.tool === "task");
    const child = (session: string) => within(20_000, "the child session", async () => (await api<Array<{ id: string }>>("GET", `/session/${session}/children`))[0]);
    /** lead's request that carries the completion of the child, and the text of that message. */
    const wake = (tag: string) =>
      within(RUN_MS + 20_000, "lead to be woken", async () => {
        const request = model.lead(tag).find((item) => item.users.some((user) => user.includes("<task ")));
        return request ? request.users.find((user) => user.includes("<task "))! : undefined;
      });
    const start = async (text: string) => {
      const session = await api<{ id: string }>("POST", "/session", {});
      await api("POST", `/session/${session.id}/prompt_async`, { agent: "lead", parts: [{ type: "text", text }] });
      return session.id;
    };
    const builderHasSteps = (tag: string, steps: number) => within(20_000, `${steps} builder steps`, async () => (model.builder(tag).some((item) => item.results >= steps) ? true : undefined));

    beforeAll(async () => {
      model = standIn(v1Script);
      box = makeSandbox("background-v1-", emitV1(modelLessFixture()));
      const provider = {
        npm: "@ai-sdk/openai-compatible",
        name: "Stand-in",
        options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "placeholder" },
        models: { m1: { name: "Stand-in", tool_call: true, temperature: true, limit: { context: 100000, output: 4096 } } },
      };
      writeFileSync(
        path.join(box.config, "opencode.json"),
        JSON.stringify({ provider: { mock: provider }, enabled_providers: ["mock"], model: "mock/m1", small_model: "mock/m1" }, null, 2),
      );
      server = await startServer(box, bin, { OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true" });
      api = connect(server.url);
    }, 180_000);

    afterAll(async () => {
      await server?.stop();
      await model?.stop(true);
      if (box) rmSync(box.dir, { recursive: true, force: true });
    });

    test("a background hand-off returns at once, lead ends its turn, and the completion wakes lead as a synthetic message of its own agent", async () => {
      const tag = nextTag();
      const session = await start(`BG ${tag}`);
      const launched = await within(20_000, "the task call to return", async () => (await taskParts(session)).find((part) => part.state?.status === "completed"));
      expect(launched.state?.output).toContain('state="running"');
      const leadDone = await within(20_000, "lead's turn to end", async () => model.lead(tag).find((item) => item.reply === "lead done"));
      const builderFirst = await within(20_000, "the builder's first request", async () => model.builder(tag)[0]);
      expect(leadDone.at).toBeLessThan(builderFirst.at + RUN_MS);
      const text = await wake(tag);
      expect(text).toContain('state="completed"');
      expect(text).toContain("builder finished");
      const last = (await messages(session)).filter((message) => message.info.role === "user").at(-1)!;
      expect(last.info.agent).toBe("lead");
      expect(last.parts[0]?.synthetic).toBe(true);
    }, 120_000);

    test("a message sent to the running child with its agent named reaches the model at the next step and ends the run there", async () => {
      const tag = nextTag();
      const session = await start(`BG ${tag}`);
      const target = await child(session);
      await builderHasSteps(tag, 2);
      const sentAt = Date.now();
      await api("POST", `/session/${target.id}/prompt_async`, { agent: "builder", parts: [{ type: "text", text: "STOP and report" }] });
      const stopped = await within(RUN_MS + 10_000, "the builder to stop", async () => model.builder(tag).find((item) => item.reply.startsWith("builder stopped")));
      expect(stopped.results).toBeLessThan(STEPS);
      expect(stopped.at - sentAt).toBeLessThan(STEP_SECONDS * 2 * 1000);
      expect(await wake(tag)).toContain("builder stopped");
      expect(model.builder(tag).some((item) => item.reply === "builder finished")).toBe(false);
      expect((await api<{ agent?: string }>("GET", `/session/${target.id}`)).agent).toBe("builder");
    }, 120_000);

    test("a message sent to the running child without an agent switches the rest of its run to opencode's default agent (the hazard the plugin pins)", async () => {
      const tag = nextTag();
      const session = await start(`BG ${tag}`);
      const target = await child(session);
      await builderHasSteps(tag, 1);
      await api("POST", `/session/${target.id}/prompt_async`, { parts: [{ type: "text", text: "STOP and report" }] });
      const answered = await within(RUN_MS + 10_000, "the steered request", async () => model.all(tag).find((item) => item.users.some((user) => user.startsWith("STOP"))));
      expect(answered.agent).toBe("other");
      expect((await api<{ agent?: string }>("GET", `/session/${target.id}`)).agent).not.toBe("builder");
    }, 120_000);

    test("the delegation tool with task_id on a running child is chained after its run, not delivered during it", async () => {
      const tag = nextTag();
      const session = await start(`BG ${tag}`);
      const target = await child(session);
      await builderHasSteps(tag, 1);
      await api("POST", `/session/${session}/prompt_async`, { agent: "lead", parts: [{ type: "text", text: `CONTINUE ${target.id} ${tag}` }] });
      const continued = await within(RUN_MS + 20_000, "the continuation to reach the builder", async () => model.builder(tag).find((item) => item.reply.startsWith("builder continued")));
      const finished = model.builder(tag).find((item) => item.reply === "builder finished");
      expect(finished).toBeDefined();
      expect(finished!.at).toBeLessThan(continued.at);
      expect(continued.results).toBe(STEPS);
      const updated = (await taskParts(session)).find((part) => part.state?.input?.task_id === target.id);
      expect(updated?.state?.output).toContain("Background task updated");
    }, 120_000);

    test("aborting the child stops it and does not wake lead", async () => {
      const tag = nextTag();
      const session = await start(`BG ${tag}`);
      const target = await child(session);
      await builderHasSteps(tag, 1);
      await api("POST", `/session/${target.id}/abort`);
      const before = model.builder(tag).length;
      await Bun.sleep(RUN_MS + 2_000);
      expect(model.builder(tag).length).toBeLessThanOrEqual(before + 1);
      expect(model.lead(tag).some((item) => item.users.some((user) => user.includes("<task ")))).toBe(false);
      const status = await api<Record<string, { type: string }>>("GET", "/session/status");
      expect(status[target.id]?.type ?? "idle").toBe("idle");
    }, 120_000);

    test("promoting a foreground hand-off returns lead's blocked call with state running; lead continues and is woken later", async () => {
      const tag = nextTag();
      const session = await start(`FG ${tag}`);
      await builderHasSteps(tag, 1);
      expect(await api<boolean>("POST", `/experimental/session/${session}/background`)).toBe(true);
      const returned = await within(20_000, "the task call to return", async () => (await taskParts(session)).find((part) => part.state?.status === "completed"));
      expect(returned.state?.output).toContain('state="running"');
      const leadDone = await within(20_000, "lead's turn to end", async () => model.lead(tag).find((item) => item.reply === "lead done"));
      const builderLast = model.builder(tag).at(-1)!;
      expect(builderLast.results).toBeLessThan(STEPS);
      expect(leadDone.at).toBeLessThan(model.builder(tag)[0]!.at + RUN_MS);
      expect(await wake(tag)).toContain("builder finished");
    }, 120_000);

    describe("without OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS", () => {
      let plain: Server;
      let plainApi: typeof api;

      beforeAll(async () => {
        plain = await startServer(box, bin, {});
        plainApi = connect(plain.url);
      }, 180_000);

      afterAll(async () => {
        await plain?.stop();
      });

      test("a background hand-off is refused with an error naming the flag, so lead must fall back to the foreground", async () => {
        const tag = nextTag();
        const session = await plainApi<{ id: string }>("POST", "/session", {});
        await plainApi("POST", `/session/${session.id}/prompt_async`, { agent: "lead", parts: [{ type: "text", text: `BG ${tag}` }] });
        const part = await within(20_000, "the task call to fail", async () =>
          (await plainApi<V1Message[]>("GET", `/session/${session.id}/message`)).flatMap((message) => message.parts).find((item) => item.type === "tool" && item.tool === "task" && item.state?.status === "error"),
        );
        expect(part.state?.error).toContain("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS");
        expect(await plainApi<unknown[]>("GET", `/session/${session.id}/children`)).toHaveLength(0);
      }, 120_000);
    });

    describe("with the plugin", () => {
      let withPlugin: Server;
      let pluginApi: typeof api;
      const toolPart = (session: string, name: string) =>
        within(30_000, `the ${name} call to return`, async () =>
          (await pluginApi<V1Message[]>("GET", `/session/${session}/message`)).flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === name && (part.state?.status === "completed" || part.state?.status === "error")),
        );
      const startWith = async (text: string) => {
        const created = await pluginApi<{ id: string }>("POST", "/session", {});
        await pluginApi("POST", `/session/${created.id}/prompt_async`, { agent: "lead", parts: [{ type: "text", text }] });
        return created.id;
      };
      const tell = (session: string, text: string) => pluginApi("POST", `/session/${session}/prompt_async`, { agent: "lead", parts: [{ type: "text", text }] });
      const childOf = (session: string) => within(20_000, "the child session", async () => (await pluginApi<Array<{ id: string }>>("GET", `/session/${session}/children`))[0]);
      const stepsOf = (tag: string, steps: number) => within(20_000, `${steps} builder steps`, async () => (model.builder(tag).some((item) => item.results >= steps) ? true : undefined));

      beforeAll(async () => {
        await server.stop();
        const plugin = await bundlePlugin(root, modelLessFixture());
        mkdirSync(path.join(box.config, "plugins"), { recursive: true });
        writeFileSync(path.join(box.config, "plugins", "ecmwf-multi-agents.js"), plugin);
        writeFileSync(path.join(box.config, "ecmwf-multi-agents.jsonc"), '{ "profile": "inherit" }\n');
        withPlugin = await startServer(box, bin, { OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true" });
        pluginApi = connect(withPlugin.url);
      }, 300_000);

      afterAll(async () => {
        await withPlugin?.stop();
      });

      test("helpers_status lists the running builder with its steps and last tool call", async () => {
        const tag = nextTag();
        const session = await startWith(`BG ${tag}`);
        const target = await childOf(session);
        await stepsOf(tag, 2);
        await tell(session, `STATUS ${tag}`);
        const part = await toolPart(session, HELPER_TOOLS.status);
        expect(part.state?.status).toBe("completed");
        const output = part.state?.output ?? "";
        expect(output).toContain("One helper in this session");
        expect(output).toContain(`${target.id}, builder, running`);
        expect(output).toMatch(/\d+ steps?, \d+s/);
        expect(output).toContain("last: bash: sleep");
        expect(output.split("\n").length).toBeLessThanOrEqual(STATUS_LINES);
      }, 120_000);

      test("helpers_steer reaches the running builder as the builder; it stops there and lead is woken", async () => {
        const tag = nextTag();
        const session = await startWith(`BG ${tag}`);
        const target = await childOf(session);
        await stepsOf(tag, 2);
        await tell(session, `STEER ${target.id} ${tag}`);
        const part = await toolPart(session, HELPER_TOOLS.steer);
        expect(part.state?.output).toContain(`Sent to builder ${target.id}`);
        const stopped = await within(RUN_MS + 10_000, "the builder to stop", async () => model.builder(tag).find((item) => item.reply.startsWith("builder stopped")));
        expect(stopped.results).toBeLessThan(STEPS);
        expect(stopped.users.at(-1)).toBe("lead amends your brief:\nSTOP and report what you did");
        expect(model.all(tag).some((item) => item.agent === "other")).toBe(false);
        expect(await wake(tag)).toContain("builder stopped");
      }, 120_000);

      test("helpers_cancel stops the builder and helpers_status then shows it stopped; lead is not woken", async () => {
        const tag = nextTag();
        const session = await startWith(`BG ${tag}`);
        const target = await childOf(session);
        await stepsOf(tag, 1);
        await tell(session, `CANCEL ${target.id} ${tag}`);
        const part = await toolPart(session, HELPER_TOOLS.cancel);
        expect(part.state?.output).toContain(`Stopped builder ${target.id}`);
        await Bun.sleep(RUN_MS + 2_000);
        expect(model.builder(tag).some((item) => item.reply === "builder finished")).toBe(false);
        expect(model.lead(tag).some((item) => item.users.some((user) => user.includes("<task ")))).toBe(false);
        await tell(session, `STATUS ${tag}`);
        const status = await toolPart(session, HELPER_TOOLS.status);
        expect(status.state?.output).toContain(`${target.id}, builder, stopped`);
      }, 120_000);

      test("a builder's call to helpers_status is refused: the rule hides the tool, and the guard would refuse it anyway", async () => {
        const tag = `forbidden-${nextTag()}`;
        const session = await startWith(`BG ${tag}`);
        const target = await childOf(session);
        // The deny rule removes the tool from the builder's request, so the call lands on
        // opencode's `invalid` tool; the guard's own refusal would read "helpers may not use".
        const part = await within(30_000, "the builder's refused call", async () =>
          (await pluginApi<V1Message[]>("GET", `/session/${target.id}/message`))
            .flatMap((message) => message.parts)
            .find((part) => part.type === "tool" && (part.tool === "invalid" || part.state?.status === "error")),
        );
        expect(`${part.state?.output ?? ""} ${part.state?.error ?? ""}`).toMatch(/unavailable|helpers may not use helpers_status/);
        expect(model.builder(tag)[0]!.users[0]).toContain("SLOW forbidden-");
        await stepsOf(tag, 1);
        await tell(session, `STATUS ${tag}`);
        expect((await toolPart(session, HELPER_TOOLS.status)).state?.output).toContain("builder");
      }, 120_000);

      test("a message that names lead in the builder's session runs as the builder (pinned)", async () => {
        const tag = nextTag();
        const session = await startWith(`BG ${tag}`);
        const target = await childOf(session);
        await stepsOf(tag, 1);
        await pluginApi("POST", `/session/${target.id}/prompt_async`, { agent: "lead", parts: [{ type: "text", text: "STOP and report" }] });
        const answered = await within(RUN_MS + 10_000, "the steered request", async () => model.all(tag).find((item) => item.users.some((user) => user.startsWith("STOP"))));
        expect(answered.agent).toBe("builder");
        expect(answered.reply).toMatch(/^builder stopped/);
        expect(model.all(tag).some((item) => item.agent !== "builder" && item.users.some((user) => user.startsWith("STOP")))).toBe(false);
        expect(await wake(tag)).toContain("builder stopped");
        // The server's record now names lead (it is updated before the hook), but the tools
        // still know the session as the builder's.
        expect((await pluginApi<{ agent?: string }>("GET", `/session/${target.id}`)).agent).toBe("lead");
        await tell(session, `STATUS ${tag}`);
        expect((await toolPart(session, HELPER_TOOLS.status)).state?.output).toContain(`${target.id}, builder, done`);
      }, 120_000);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// opencode 2.0.16

interface V2Session {
  id: string;
  parentID?: string;
  agent?: string;
}

const v2Script: Script = {
  delegate: (prompt, background, continueId) => ({
    name: "subagent",
    args: { description: "slow job", prompt, agent: "builder", background, ...(continueId ? { sessionID: continueId } : {}) },
  }),
  shell: "shell",
};

describe.skipIf(!v2Available)(`background helpers in opencode ${V2_VERSION}`, () => {
  let box: Sandbox;
  let model: ReturnType<typeof standIn>;
  let server: Server;
  let auth = "";
  const api = async <T = unknown>(method: string, route: string, body?: unknown): Promise<T> => {
    const target = new URL(route, server.url);
    target.searchParams.set("location[directory]", box.project);
    const response = await fetch(target, {
      method,
      headers: { "content-type": "application/json", authorization: auth },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    return (parsed !== null && typeof parsed === "object" && "data" in parsed ? (parsed as { data: T }).data : (parsed as T));
  };
  const child = (session: string) =>
    within(20_000, "the child session", async () => (await api<V2Session[]>("GET", "/api/session")).find((item) => item.parentID === session));
  const wake = (tag: string) =>
    within(RUN_MS + 20_000, "lead to be woken", async () => {
      const request = model.lead(tag).find((item) => item.users.some((user) => user.includes("<subagent ")));
      return request ? request.users.find((user) => user.includes("<subagent "))! : undefined;
    });
  const start = async (text: string) => {
    const session = await api<{ id: string }>("POST", "/api/session", { agent: "lead" });
    await api("POST", `/api/session/${session.id}/prompt`, { text });
    return session.id;
  };
  const builderHasSteps = (tag: string, steps: number) => within(20_000, `${steps} builder steps`, async () => (model.builder(tag).some((item) => item.results >= steps) ? true : undefined));

  beforeAll(async () => {
    const version = Bun.spawnSync([v2Bin, "--version"]);
    if (!version.stdout.toString().includes(V2_VERSION)) throw new Error(`${v2Bin} is not opencode ${V2_VERSION}: ${version.stdout.toString().trim() || version.stderr.toString().trim()}`);
    model = standIn(v2Script);
    box = makeSandbox("background-v2-", emitV2(modelLessFixture()));
    // 2.0.16 reads the 1.x spelling of a provider and normalizes it (package, settings, capabilities).
    const provider = {
      name: "Stand-in",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "placeholder" },
      models: { m1: { name: "Stand-in", tool_call: true, temperature: true, limit: { context: 100000, output: 4096 } } },
    };
    writeFileSync(path.join(box.config, "opencode.json"), JSON.stringify({ model: "mock/m1", provider: { mock: provider } }, null, 2));
    const password = randomBytes(16).toString("hex");
    auth = `Basic ${btoa(`opencode:${password}`)}`;
    server = await startServer(box, v2Bin, { OPENCODE_PASSWORD: password });
    await within(60_000, "the generated agents", async () => {
      const agents = await api<Array<{ id: string }>>("GET", "/api/agent");
      return agents.some((agent) => agent.id === "lead") ? agents : undefined;
    });
  }, 180_000);

  afterAll(async () => {
    await server?.stop();
    await model?.stop(true);
    if (box) rmSync(box.dir, { recursive: true, force: true });
  });

  test("a background hand-off returns at once and the completion wakes lead", async () => {
    const tag = nextTag();
    await start(`BG ${tag}`);
    const leadDone = await within(20_000, "lead's turn to end", async () => model.lead(tag).find((item) => item.reply === "lead done"));
    const builderFirst = await within(20_000, "the builder's first request", async () => model.builder(tag)[0]);
    expect(leadDone.at).toBeLessThan(builderFirst.at + RUN_MS);
    const text = await wake(tag);
    expect(text).toContain('state="completed"');
    expect(text).toContain("builder finished");
  }, 120_000);

  test("a prompt with delivery steer reaches the running child at the next step and keeps its agent", async () => {
    const tag = nextTag();
    const session = await start(`BG ${tag}`);
    const target = await child(session);
    await builderHasSteps(tag, 2);
    const sentAt = Date.now();
    await api("POST", `/api/session/${target.id}/prompt`, { text: "STOP and report", delivery: "steer" });
    const stopped = await within(RUN_MS + 10_000, "the builder to stop", async () => model.builder(tag).find((item) => item.reply.startsWith("builder stopped")));
    expect(stopped.results).toBeLessThan(STEPS);
    expect(stopped.at - sentAt).toBeLessThan(STEP_SECONDS * 2 * 1000);
    expect(model.builder(tag).some((item) => item.reply === "builder finished")).toBe(false);
    expect((await api<V2Session>("GET", `/api/session/${target.id}`)).agent).toBe("builder");
    expect(await wake(tag)).toContain("builder stopped");
  }, 120_000);

  test("a prompt with delivery queue waits for the run to end", async () => {
    const tag = nextTag();
    const session = await start(`BG ${tag}`);
    const target = await child(session);
    await builderHasSteps(tag, 1);
    await api("POST", `/api/session/${target.id}/prompt`, { text: `MORE ${tag}`, delivery: "queue" });
    const continued = await within(RUN_MS + 20_000, "the queued message to reach the builder", async () => model.builder(tag).find((item) => item.reply.startsWith("builder continued")));
    const finished = model.builder(tag).find((item) => item.reply === "builder finished");
    expect(finished).toBeDefined();
    expect(finished!.at).toBeLessThan(continued.at);
    expect(continued.results).toBe(STEPS);
  }, 120_000);

  test("interrupting the child stops it and wakes lead with state cancelled", async () => {
    const tag = nextTag();
    const session = await start(`BG ${tag}`);
    const target = await child(session);
    await builderHasSteps(tag, 1);
    await api("POST", `/api/session/${target.id}/interrupt`);
    const text = await wake(tag);
    expect(text).toContain('state="cancelled"');
    expect(model.builder(tag).some((item) => item.reply === "builder finished")).toBe(false);
  }, 120_000);

  test("promoting a foreground hand-off lets lead continue; lead is woken when the child finishes", async () => {
    const tag = nextTag();
    const session = await start(`FG ${tag}`);
    await builderHasSteps(tag, 1);
    await api("POST", `/api/session/${session}/background`);
    const leadDone = await within(20_000, "lead's turn to end", async () => model.lead(tag).find((item) => item.results >= 1 && !item.reply.startsWith("tool:")));
    expect(leadDone.at).toBeLessThan(model.builder(tag)[0]!.at + RUN_MS);
    expect(await wake(tag)).toContain("builder finished");
  }, 120_000);

  describe("with the plugin", () => {
    interface V2Content {
      type: string;
      name?: string;
      state?: { status?: string; content?: unknown; error?: { message?: string } };
    }
    interface V2Message {
      type: string;
      content?: V2Content[];
    }
    const toolCall = (session: string, name: string) =>
      within(30_000, `the ${name} call to return`, async () =>
        (await api<V2Message[]>("GET", `/api/session/${session}/message`))
          .flatMap((message) => message.content ?? [])
          .find((item) => item.type === "tool" && item.name === name && (item.state?.status === "completed" || item.state?.status === "error")),
      );
    /** A 2.0.16 tool result: `state.content`, a list of text parts. */
    const outputText = (item: V2Content): string => {
      const content = item.state?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
      return "";
    };
    const tell = (session: string, text: string) => api("POST", `/api/session/${session}/prompt`, { text });
    const stepsOf = (tag: string, steps: number) => within(20_000, `${steps} builder steps`, async () => (model.builder(tag).some((item) => item.results >= steps) ? true : undefined));

    beforeAll(async () => {
      await server.stop();
      const plugin = await bundlePlugin(root, modelLessFixture());
      mkdirSync(path.join(box.config, "plugins"), { recursive: true });
      writeFileSync(path.join(box.config, "plugins", "ecmwf-multi-agents.js"), plugin);
      writeFileSync(path.join(box.config, "ecmwf-multi-agents.jsonc"), '{ "profile": "inherit" }\n');
      const password = randomBytes(16).toString("hex");
      auth = `Basic ${btoa(`opencode:${password}`)}`;
      server = await startServer(box, v2Bin, { OPENCODE_PASSWORD: password });
      await within(60_000, "the plugin to be active", async () => {
        const plugins = await api<Array<{ id?: string; state?: { status?: string } }>>("GET", "/api/plugin");
        return plugins.some((plugin) => plugin.id === "ecmwf-multi-agents" && plugin.state?.status === "active") ? true : undefined;
      });
      await Bun.sleep(1_000);
    }, 300_000);

    test("helpers_status lists the running builder with its steps and last tool call", async () => {
      const tag = nextTag();
      const session = await start(`BG ${tag}`);
      const target = await child(session);
      await stepsOf(tag, 2);
      await tell(session, `STATUS ${tag}`);
      const call = await toolCall(session, HELPER_TOOLS.status);
      expect(call.state?.status).toBe("completed");
      const output = outputText(call);
      expect(output).toContain("One helper in this session");
      expect(output).toContain(`${target!.id}, builder, running`);
      expect(output).toContain("last: shell: sleep");
      expect(output.split("\n").length).toBeLessThanOrEqual(STATUS_LINES);
    }, 120_000);

    test("helpers_steer reaches the running builder; it stops there and lead is woken", async () => {
      const tag = nextTag();
      const session = await start(`BG ${tag}`);
      const target = await child(session);
      await stepsOf(tag, 2);
      await tell(session, `STEER ${target!.id} ${tag}`);
      const call = await toolCall(session, HELPER_TOOLS.steer);
      expect(outputText(call)).toContain(`Sent to builder ${target!.id}`);
      const stopped = await within(RUN_MS + 10_000, "the builder to stop", async () => model.builder(tag).find((item) => item.reply.startsWith("builder stopped")));
      expect(stopped.results).toBeLessThan(STEPS);
      expect(stopped.users.at(-1)).toBe("lead amends your brief:\nSTOP and report what you did");
      expect(await wake(tag)).toContain("builder stopped");
    }, 120_000);

    test("helpers_cancel stops the builder; lead is woken with state cancelled and helpers_status shows it stopped", async () => {
      const tag = nextTag();
      const session = await start(`BG ${tag}`);
      const target = await child(session);
      await stepsOf(tag, 1);
      await tell(session, `CANCEL ${target!.id} ${tag}`);
      const call = await toolCall(session, HELPER_TOOLS.cancel);
      expect(outputText(call)).toContain(`Stopped builder ${target!.id}`);
      expect(await wake(tag)).toContain('state="cancelled"');
      expect(model.builder(tag).some((item) => item.reply === "builder finished")).toBe(false);
      await tell(session, `STATUS ${tag}`);
      expect(outputText(await toolCall(session, HELPER_TOOLS.status))).toContain(`${target!.id}, builder, stopped`);
    }, 120_000);

    test("a builder's call to helpers_status is refused: the rule hides the tool, and the guard would refuse it anyway", async () => {
      const tag = `forbidden-${nextTag()}`;
      const session = await start(`BG ${tag}`);
      const target = await child(session);
      const call = await within(30_000, "the builder's refused call", async () =>
        (await api<V2Message[]>("GET", `/api/session/${target!.id}/message`)).flatMap((message) => message.content ?? []).find((item) => item.type === "tool" && item.state?.status === "error"),
      );
      expect(call.state?.error?.message ?? JSON.stringify(call.state)).toMatch(/No tool named "helpers_status"|helpers may not use helpers_status/);
      expect(await wake(tag)).toContain("builder finished");
    }, 120_000);
  });
});
