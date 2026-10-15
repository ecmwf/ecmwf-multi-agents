// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Opt-in check of the platform mechanics that background helpers, steering and cancel build on
// (docs/research/background-helpers.md). Runs only when ECMWF_MULTI_AGENTS_INTEGRATION=1.
// Binary: OPENCODE_V2_BIN (default "opencode2"). No hosted model is contacted: every agent runs
// on a scripted stand-in that speaks the OpenAI chat-completions protocol on 127.0.0.1 and
// records each request.
//
// The script: lead delegates a slow job to the builder (a few `sleep` steps) in the background
// or the foreground; the builder stops early when a later user message tells it to. Each
// scenario tags its prompts so the request log can be read per session.
//
// What is pinned here: a background hand-off returns at once and the completion wakes lead; a
// message sent to a running child reaches its model at the next step boundary; what a cancel and
// a promotion do. Then, with the bundled plugin installed: lead's helpers_status, helpers_steer
// and helpers_cancel work against a running builder, a builder's call to them is refused, and a
// builder's report that arrives while lead is still answering the user is held back until lead
// has answered (answer-first.ts), and one that arrives later wakes lead at once.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pluginFiles } from "../tools/bundle-plugin.ts";
import { V2_VERSION, emitV2 } from "../tools/emit-v2.ts";
import type { OutputFile, ResolvedHarness } from "../tools/types.ts";
import { INLINE_USER_AND_REPORTS_WAKE_TEXT, INLINE_USER_WAKE_TEXT, INLINE_WAKE_TEXT, WAKE_TEXT } from "./answer-first.ts";
import { HELPER_TOOLS, STATUS_LINES } from "./helpers.ts";
import { BEFORE_BRIEF_FOR_TESTS, HELD_NOTE } from "./inline.ts";
import { resolvedFixture } from "./testing.ts";

const enabled = process.env.ECMWF_MULTI_AGENTS_INTEGRATION === "1";
const v2Bin = process.env.OPENCODE_V2_BIN ?? "opencode2";
/** True when the opencode 2 binary runs; its suite is skipped otherwise, as the other suites do. */
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
/** Steps of a slow review (`SLOW_REVIEW` in its request): long enough for a builder to finish meanwhile. */
const REVIEW_STEPS = 8;
/** The slow lookup lead takes before it answers `ASK`: it outlasts the builder's last step and its report. */
const LOOKUP_SECONDS = 3 * STEP_SECONDS;

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
  /** lead, builder, reviewer, or other (opencode's own agents, or a child whose run switched agent). */
  agent: "lead" | "builder" | "reviewer" | "scout" | "other";
  /** The text of every user message, in order. */
  users: string[];
  /** Tool results in the request: how many steps the agent had taken. */
  results: number;
  at: number;
  /** What the stand-in answered: `tool:<name>` or the text. */
  reply: string;
  /** The model the request named. */
  model: string;
}

interface Script {
  /** The delegation tool and its argument names on this platform. */
  delegate: (prompt: string, background: boolean) => { name: string; args: Record<string, unknown> };
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
 * `FG <tag>` in the foreground;
 * `ASK <tag>` is answered once, after one slow lookup step, whatever report arrives meanwhile;
 * a wake to answer the user after a command, with `QUESTION <tag>` above it, answers the question;
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
      const body = (await request.json().catch(() => ({}))) as { messages?: unknown[]; stream?: boolean; model?: string };
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const role = (message: unknown) => (message as { role?: string } | undefined)?.role;
      const system = messages.filter((message) => role(message) === "system" || role(message) === "developer").map(textOf).join("\n");
      const users = messages.filter((message) => role(message) === "user").map(textOf);
      const last = users.at(-1) ?? "";
      const results = messages.filter((message) => role(message) === "tool").length;
      const agent: Seen["agent"] = system.includes("You are lead")
        ? "lead"
        : system.includes("You are builder")
          ? "builder"
          : system.includes("You are reviewer")
            ? "reviewer"
            : system.includes("You are scout")
              ? "scout"
              : "other";
      let tool: { name: string; args: Record<string, unknown> } | undefined;
      let text = "ok";
      if (agent === "lead") {
        const bg = /^BG (\S+)/.exec(last);
        const fg = /^FG (\S+)/.exec(last);
        const status = /^STATUS (\S+)/.exec(last);
        const steer = /^STEER (\S+) (\S+)/.exec(last);
        const cancel = /^CANCEL (\S+) (\S+)/.exec(last);
        // The user's latest message, reports aside: a report can arrive while lead answers it.
        const question = messages.filter((message) => role(message) === "user" && !/^<subagent /.test(textOf(message))).at(-1);
        const ask = /^ASK \S+/.test(textOf(question));
        const since = messages.slice(messages.indexOf(question) + 1);
        const looked = since.some((message) => role(message) === "tool");
        const answered = since.some((message) => role(message) === "assistant" && textOf(message).includes("lead answered"));
        if (bg && results === 0) tool = script.delegate(`SLOW ${bg[1]}`, true);
        else if (fg && results === 0) tool = script.delegate(`SLOW ${fg[1]}`, false);
        else if (status && !messages.some((message) => role(message) === "tool" && /helpers? in this session/.test(textOf(message))))
          tool = { name: HELPER_TOOLS.status, args: {} };
        else if (steer && !messages.some((message) => role(message) === "tool" && /Sent to|not running|not a helper/.test(textOf(message))))
          tool = { name: HELPER_TOOLS.steer, args: { id: steer[1], text: "STOP and report what you did" } };
        else if (cancel && !messages.some((message) => role(message) === "tool" && /Stopped|not running|not a helper/.test(textOf(message))))
          tool = { name: HELPER_TOOLS.cancel, args: { id: cancel[1] } };
        else if (ask && !looked) tool = { name: script.shell, args: { command: `sleep ${LOOKUP_SECONDS}`, description: "slow lookup" } };
        else if (ask && !answered) text = "lead answered";
        else if (last === INLINE_USER_WAKE_TEXT && users.some((user) => user.startsWith("QUESTION "))) text = "lead answered the question";
        else text = "lead done";
      } else if (agent === "builder") {
        // A steer arrives as "lead amends your brief:\nSTOP ..."; on opencode 2 the first message starts
        // with the platform's own "You are a subagent spawned by another session." line.
        const forbidden = users[0]?.includes("SLOW forbidden-") && results === 0;
        if (users.some((user) => /(^|\n)STOP/.test(user))) text = `builder stopped after ${results} steps`;
        else if (users.some((user) => /(^|\n)MORE/.test(user))) text = `builder continued after ${results} steps`;
        else if (forbidden) tool = { name: HELPER_TOOLS.status, args: {} };
        else if (results < STEPS) tool = { name: script.shell, args: { command: `sleep ${STEP_SECONDS}`, description: "slow step" } };
        else text = "builder finished";
      } else if (agent === "reviewer") {
        // A review answers at once, or after REVIEW_STEPS `sleep` steps when its request says SLOW_REVIEW;
        // the plugin's note to end a turn is answered as it asks.
        if (last === HELD_NOTE) text = "done";
        else if (users.some((user) => user.includes("SLOW_REVIEW")) && results < REVIEW_STEPS)
          tool = { name: script.shell, args: { command: `sleep ${STEP_SECONDS}`, description: "slow review step" } };
        else text = "VERDICT: APPROVE";
      } else if (agent === "scout") {
        text = "Plan: none";
      }
      calls++;
      seen.push({ agent, users, results, at: Date.now(), reply: tool ? `tool:${tool.name}` : text, model: String(body.model ?? "") });
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

/**
 * A plugin for these tests alone: it pauses an inline run whose brief says `PAUSE_BRIEF <tag>`
 * between the switch to the helper and the brief, until the file `resume-<tag>` appears in `dir`.
 */
function pausePlugin(dir: string): string {
  return `import { existsSync } from "node:fs";
import path from "node:path";
export default {
  id: "inline-pause",
  setup: async () => {
    globalThis[Symbol.for(${JSON.stringify(BEFORE_BRIEF_FOR_TESTS.description)})] = async ({ brief }) => {
      const tag = /PAUSE_BRIEF (\\S+)/.exec(brief)?.[1];
      if (tag === undefined) return;
      const deadline = Date.now() + 60000;
      while (!existsSync(path.join(${JSON.stringify(dir)}, "resume-" + tag)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    };
  },
};
`;
}

let tags = 0;
const nextTag = () => `t${++tags}`;

// ---------------------------------------------------------------------------------------------
// opencode 2 (V2_VERSION)

interface V2Session {
  id: string;
  parentID?: string;
  agent?: string;
}

const v2Script: Script = {
  delegate: (prompt, background) => ({ name: "subagent", args: { description: "slow job", prompt, agent: "builder", background } }),
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
  const command = (session: string, name: string, text: string) => api("POST", `/api/session/${session}/command`, { name, text });
  const builderHasSteps = (tag: string, steps: number) => within(20_000, `${steps} builder steps`, async () => (model.builder(tag).some((item) => item.results >= steps) ? true : undefined));

  beforeAll(async () => {
    const version = Bun.spawnSync([v2Bin, "--version"]);
    if (!version.stdout.toString().includes(V2_VERSION)) throw new Error(`${v2Bin} is not opencode ${V2_VERSION}: ${version.stdout.toString().trim() || version.stderr.toString().trim()}`);
    model = standIn(v2Script);
    box = makeSandbox("background-v2-", emitV2(modelLessFixture()));
    // opencode 2 reads the older spelling of a provider and normalizes it (package, settings, capabilities).
    const provider = {
      name: "Stand-in",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "placeholder" },
      models: {
        m1: { name: "Stand-in", tool_call: true, temperature: true, limit: { context: 100000, output: 4096 } },
        m2: { name: "Stand-in for the reviewer", tool_call: true, temperature: true, limit: { context: 100000, output: 4096 } },
      },
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

  // Without the plugin, a helper's command file runs in a child session and lead relays the report.
  test("without the plugin, /review runs in a child session and its report reaches lead", async () => {
    const tag = nextTag();
    const session = await start(`HELLO ${tag}`);
    await within(20_000, "lead's turn to end", async () => model.lead(tag).find((item) => item.reply === "lead done"));
    await command(session, "review", tag);
    const target = await child(session);
    expect(target.agent).toBe("reviewer");
    const review = await within(20_000, "the review", async () => model.seen.find((item) => item.agent === "reviewer" && item.users[0]?.endsWith(`Review ${tag}`)));
    expect(review.users).toHaveLength(1);
    expect(review.users[0]).toStartWith("You are a subagent spawned by another session.");
    expect(await wake(tag)).toContain("VERDICT: APPROVE");
    expect((await api<V2Session>("GET", `/api/session/${session}`)).agent).toBe("lead");
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
    /** An opencode 2 tool result: `state.content`, a list of text parts. */
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
      for (const file of await pluginFiles(root, modelLessFixture())) {
        mkdirSync(path.dirname(path.join(box.config, file.path)), { recursive: true });
        writeFileSync(path.join(box.config, file.path), file.content);
      }
      writeFileSync(path.join(box.config, "plugins", "inline-pause.js"), pausePlugin(box.dir));
      writeFileSync(path.join(box.config, "ecmwf-multi-agents.jsonc"), '{ "profile": "inherit", "agents": { "reviewer": { "model": "mock/m2" } } }\n');
      const password = randomBytes(16).toString("hex");
      auth = `Basic ${btoa(`opencode:${password}`)}`;
      server = await startServer(box, v2Bin, { OPENCODE_PASSWORD: password });
      await within(60_000, "the plugins to be active", async () => {
        const plugins = await api<Array<{ id?: string; state?: { status?: string } }>>("GET", "/api/plugin");
        const active = (id: string) => plugins.some((plugin) => plugin.id === id && plugin.state?.status === "active");
        return active("ecmwf-multi-agents") && active("inline-pause") ? true : undefined;
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

    // A report that arrives while lead is still answering the user is left out of lead's
    // requests until lead has answered, and a queued wake then starts a turn that shows it; one
    // that arrives after lead's reply ended wakes lead at once.
    test("a report that arrives while lead looks up an answer is held until lead has answered", async () => {
      const tag = nextTag();
      const session = await start(`BG ${tag}`);
      await within(20_000, "lead's turn to end", async () => model.lead(tag).find((item) => item.reply === "lead done"));
      // Asked when the builder has one step left, lead is still looking up the answer when the report arrives.
      await stepsOf(tag, STEPS - 1);
      await tell(session, `ASK ${tag}`);
      const answer = await within(LOOKUP_SECONDS * 1000 + 20_000, "lead's answer", async () => model.lead(tag).find((item) => item.reply === "lead answered"));
      expect(model.builder(tag).find((item) => item.reply === "builder finished")?.at).toBeLessThan(answer.at);
      expect(answer.users.join("\n")).not.toContain("<subagent ");
      const woken = await within(20_000, "the wake", async () => model.lead(tag).find((item) => item.at > answer.at && item.users.some((user) => user.includes("<subagent "))));
      expect(woken.users.at(-1)).toBe(WAKE_TEXT);
      expect(woken.users.at(-2)).toStartWith("<subagent ");
      expect(woken.users.at(-2)).toContain("builder finished");
    }, 120_000);

    test("a report that wakes lead after its reply ended is delivered at once", async () => {
      const tag = nextTag();
      const session = await start(`BG ${tag}`);
      await within(20_000, "lead's turn to end", async () => model.lead(tag).find((item) => item.reply === "lead done"));
      await tell(session, `HELLO ${tag}`);
      const answer = await within(20_000, "lead's answer", async () => model.lead(tag).find((item) => item.users.at(-1) === `HELLO ${tag}`));
      expect(answer.reply).toBe("lead done");
      const woken = await within(RUN_MS + 20_000, "lead to be woken", async () => model.lead(tag).find((item) => item.users.some((user) => user.includes("<subagent "))));
      expect(model.builder(tag).find((item) => item.reply === "builder finished")?.at).toBeGreaterThan(answer.at);
      expect(woken.users.at(-1)).toStartWith("<subagent ");
      expect(woken.users.at(-1)).toContain("builder finished");
      expect(woken.users.at(-2)).toBe(`HELLO ${tag}`);
      expect(model.all(tag).flatMap((item) => item.users).filter((user) => user.includes(WAKE_TEXT))).toEqual([]);
    }, 120_000);

    // `/review` and `/progress` answered in the user's own session (inline.ts): the helper sees
    // only its brief, the session goes back to lead, and reports and messages from the user that
    // arrive meanwhile are held back from the helper and wake lead after it.
    const agentOf = async (session: string) => (await api<V2Session>("GET", `/api/session/${session}`)).agent;
    const children = async (session: string) => (await api<V2Session[]>("GET", "/api/session")).filter((item) => item.parentID === session);
    const reviews = (tag: string) => model.seen.filter((item) => item.agent === "reviewer" && item.users[0]?.includes(`Review `) && item.users[0]?.endsWith(tag));
    const backToLead = (session: string) => within(20_000, "the session to go back to lead", async () => ((await agentOf(session)) === "lead" ? true : undefined));
    const fakeReport = (tag: string) => `<subagent sessionID="ses_fake" state="completed" description="fake">fake report ${tag}</subagent>`;

    test("/review in an idle session: the reviewer answers there from its brief alone, on its own model; lead gets the session back", async () => {
      const tag = nextTag();
      const session = await start(`HELLO ${tag}`);
      await within(20_000, "lead's turn to end", async () => model.lead(tag).find((item) => item.reply === "lead done"));
      const sentAt = Date.now();
      await command(session, "review", tag);
      expect(Date.now() - sentAt).toBeLessThan(5_000);
      const review = await within(20_000, "the review", async () => reviews(tag).find((item) => item.reply === "VERDICT: APPROVE"));
      expect(review.users).toEqual([`Review ${tag}`]);
      expect(review.model).toBe("m2");
      await backToLead(session);
      expect(await children(session)).toEqual([]);
      // A report that arrives later wakes lead, on lead's model, with the verdict in its conversation.
      await api("POST", `/api/session/${session}/synthetic`, { text: fakeReport(tag) });
      const woken = await within(20_000, "lead to be woken", async () => model.lead(tag).find((item) => item.users.at(-1)?.includes(`fake report ${tag}`)));
      expect(woken.model).toBe("m1");
      expect(woken.users).toContain(`Review ${tag}`);
      expect(model.all(tag).filter((item) => item.agent === "reviewer")).toHaveLength(1);
    }, 120_000);

    test("/progress answers in the session as the scout, from its brief alone", async () => {
      const tag = nextTag();
      const session = await start(`HELLO ${tag}`);
      await within(20_000, "lead's turn to end", async () => model.lead(tag).find((item) => item.reply === "lead done"));
      await command(session, "progress", tag);
      const progress = await within(20_000, "the progress report", async () => model.seen.find((item) => item.agent === "scout" && item.users[0] === `Progress of ${tag}`));
      expect(progress.users).toHaveLength(1);
      expect(progress.model).toBe("m1");
      await backToLead(session);
      expect(await children(session)).toEqual([]);
    }, 120_000);

    test("/review while lead is answering: the command returns at once, lead answers first, then the review runs", async () => {
      const tag = nextTag();
      const session = await start(`ASK ${tag}`);
      await within(20_000, "lead's lookup", async () => model.lead(tag).find((item) => item.reply.startsWith("tool:")));
      const sentAt = Date.now();
      await command(session, "review", tag);
      expect(Date.now() - sentAt).toBeLessThan(LOOKUP_SECONDS * 1000);
      const review = await within(LOOKUP_SECONDS * 1000 + 20_000, "the review", async () => reviews(tag).find((item) => item.reply === "VERDICT: APPROVE"));
      const answer = model.lead(tag).find((item) => item.reply === "lead answered");
      expect(answer).toBeDefined();
      expect(answer!.at).toBeLessThan(review.at);
      expect(review.users).toEqual([`Review ${tag}`]);
      await backToLead(session);
    }, 120_000);

    test("a report that arrives during a review is held back from the reviewer and wakes lead after it", async () => {
      const tag = nextTag();
      const session = await start(`BG ${tag}`);
      await within(20_000, "lead's turn to end", async () => model.lead(tag).find((item) => item.reply === "lead done"));
      await stepsOf(tag, 1);
      await command(session, "review", `SLOW_REVIEW ${tag}`);
      const finished = await within(RUN_MS + 20_000, "the builder to finish", async () => model.builder(tag).find((item) => item.reply === "builder finished"));
      const verdict = await within(REVIEW_STEPS * STEP_SECONDS * 1000 + 20_000, "the verdict", async () => reviews(tag).find((item) => item.reply === "VERDICT: APPROVE"));
      expect(finished.at).toBeLessThan(verdict.at);
      for (const item of reviews(tag)) {
        expect(item.users[0]).toBe(`Review SLOW_REVIEW ${tag}`);
        expect(item.users.join("\n")).not.toContain("<subagent ");
      }
      expect(verdict.results).toBe(REVIEW_STEPS);
      const woken = await within(20_000, "lead to be woken", async () => model.lead(tag).find((item) => item.at > verdict.at && item.users.at(-1) === INLINE_WAKE_TEXT));
      expect(woken.users.some((user) => user.startsWith("<subagent ") && user.includes("builder finished"))).toBe(true);
      await backToLead(session);
      await Bun.sleep(1_000);
      const wakes = model.all(tag).filter((item) => item.users.at(-1) === INLINE_WAKE_TEXT || item.users.at(-1) === WAKE_TEXT);
      expect(wakes.filter((item) => item.agent === "lead")).toHaveLength(1);
    }, 120_000);

    test("a message the user sends during a review is held back from the reviewer; lead answers it after the review", async () => {
      const tag = nextTag();
      const session = await start(`HELLO ${tag}`);
      await within(20_000, "lead's turn to end", async () => model.lead(tag).find((item) => item.reply === "lead done"));
      await command(session, "review", `SLOW_REVIEW ${tag}`);
      await within(20_000, "the review's second step", async () => reviews(tag).find((item) => item.results >= 1));
      // What the TUI sends when the user types during a run.
      await api("POST", `/api/session/${session}/prompt`, { text: `QUESTION ${tag}`, delivery: "steer" });
      const verdict = await within(REVIEW_STEPS * STEP_SECONDS * 1000 + 20_000, "the verdict", async () => reviews(tag).find((item) => item.reply === "VERDICT: APPROVE"));
      for (const item of reviews(tag)) expect(item.users).toEqual([`Review SLOW_REVIEW ${tag}`]);
      expect(verdict.results).toBe(REVIEW_STEPS);
      const answer = await within(20_000, "lead's answer", async () => model.lead(tag).find((item) => item.reply === "lead answered the question"));
      expect(answer.at).toBeGreaterThan(verdict.at);
      expect(answer.model).toBe("m1");
      expect(answer.users.at(-1)).toBe(INLINE_USER_WAKE_TEXT);
      expect(answer.users).toContain(`QUESTION ${tag}`);
      await backToLead(session);
      await Bun.sleep(1_000);
      const wakes = model.all(tag).filter((item) => [INLINE_WAKE_TEXT, INLINE_USER_WAKE_TEXT, INLINE_USER_AND_REPORTS_WAKE_TEXT, WAKE_TEXT].includes(item.users.at(-1) ?? ""));
      expect(wakes.map((item) => item.agent)).toEqual(["lead"]);
      expect(model.all(tag).filter((item) => item.agent === "reviewer" && item.users.some((user) => user.includes("QUESTION")))).toEqual([]);
    }, 120_000);

    test("a message sent between the switch to the reviewer and its brief: the reviewer only replies done, the review runs, lead answers after it", async () => {
      const tag = nextTag();
      const session = await start(`HELLO ${tag}`);
      await within(20_000, "lead's turn to end", async () => model.lead(tag).find((item) => item.reply === "lead done"));
      await command(session, "review", `PAUSE_BRIEF ${tag}`);
      // The run pauses after the switch, so the session is idle and the reviewer's.
      await within(20_000, "the switch to the reviewer", async () => ((await agentOf(session)) === "reviewer" ? true : undefined));
      const sentAt = Date.now();
      await api("POST", `/api/session/${session}/prompt`, { text: `QUESTION ${tag}`, delivery: "steer" });
      const turn = await within(20_000, "the reviewer's turn", async () => model.seen.find((item) => item.agent === "reviewer" && item.at >= sentAt));
      await Bun.sleep(1_000);
      writeFileSync(path.join(box.dir, `resume-${tag}`), "");
      // Only what opencode adds (a note that the tools changed) and the plugin's note to end the turn.
      expect(turn.users.at(-1)).toBe(HELD_NOTE);
      expect(turn.users.join("\n")).not.toContain(tag);
      expect(turn.reply).toBe("done");
      const verdict = await within(20_000, "the verdict", async () => reviews(tag).find((item) => item.reply === "VERDICT: APPROVE"));
      expect(verdict.users).toEqual([`Review PAUSE_BRIEF ${tag}`]);
      expect(verdict.model).toBe("m2");
      const before = model.seen.filter((item) => item.agent === "reviewer" && item.at >= sentAt && item.at < verdict.at);
      expect(before.map((item) => item.reply)).toEqual(["done"]);
      const answer = await within(20_000, "lead's answer", async () => model.lead(tag).find((item) => item.reply === "lead answered the question"));
      expect(answer.at).toBeGreaterThan(verdict.at);
      expect(answer.model).toBe("m1");
      expect(answer.users.at(-1)).toBe(INLINE_USER_WAKE_TEXT);
      expect(answer.users).toContain(`QUESTION ${tag}`);
      await backToLead(session);
      await Bun.sleep(1_000);
      const wakes = model.seen.filter((item) => item.at >= sentAt && [INLINE_WAKE_TEXT, INLINE_USER_WAKE_TEXT, INLINE_USER_AND_REPORTS_WAKE_TEXT, WAKE_TEXT].includes(item.users.at(-1) ?? ""));
      expect(wakes.map((item) => item.agent)).toEqual(["lead"]);
      expect(model.seen.filter((item) => item.agent === "reviewer" && item.users.some((user) => user.includes("QUESTION")))).toEqual([]);
    }, 120_000);

    test("a stray run of the helper after a review: the report is held back from it, lead gets the session back and is woken", async () => {
      const tag = nextTag();
      const session = await start(`HELLO ${tag}`);
      await within(20_000, "lead's turn to end", async () => model.lead(tag).find((item) => item.reply === "lead done"));
      await command(session, "review", tag);
      await within(20_000, "the review", async () => reviews(tag).find((item) => item.reply === "VERDICT: APPROVE"));
      await backToLead(session);
      // The state of the short window before the switch back: the session is still the reviewer's.
      await api("POST", `/api/session/${session}/agent`, { agent: "reviewer" });
      await api("POST", `/api/session/${session}/synthetic`, { text: fakeReport(tag) });
      const stray = await within(20_000, "the stray request", async () => reviews(tag).find((item) => item.users.length > 1));
      expect(stray.users[0]).toBe(`Review ${tag}`);
      expect(stray.users.join("\n")).not.toContain("<subagent ");
      expect(stray.users.at(-1)).toBe(HELD_NOTE);
      const woken = await within(20_000, "lead to be woken", async () => model.lead(tag).find((item) => item.users.at(-1) === INLINE_WAKE_TEXT));
      expect(woken.users.some((user) => user.includes(`fake report ${tag}`))).toBe(true);
      await backToLead(session);
    }, 120_000);
  });
});
