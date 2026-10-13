// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Opt-in check that the bundled plugin works in real opencode binaries. Runs only when
// ECMWF_MULTI_AGENTS_INTEGRATION=1. Binaries: OPENCODE_V1_BINS (space-separated, default
// "opencode") and OPENCODE_V2_BIN (default "opencode2"). Sandboxes go under the system temporary
// directory (set TMPDIR to move them).
//
// Each binary gets a fresh sandbox (tools/sandbox.sh): the emitter output and the bundled plugin
// in the sandbox config directory, settings files written per scenario, and a git project.
// opencode 1.x is read back with `opencode debug agent` and `debug config`; opencode 2.0.16 with
// `opencode serve` and its HTTP API, as in tools/emit-v2.integration.test.ts. The first 1.x start
// with a plugin installs @opencode-ai/plugin into the config directory (network, about 20 s).
//
// The 1.x shell guard runs end to end against a local stand-in for an OpenAI-compatible model
// server: lead pushes and the user answers "Allow always", then a builder tries the same push.
// No hosted model is contacted: the only provider enabled is the stand-in on 127.0.0.1.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundlePlugin } from "../tools/bundle-plugin.ts";
import { emitV1 } from "../tools/emit-v1.ts";
import { V2_VERSION, emitV2 } from "../tools/emit-v2.ts";
import type { OutputFile, ResolvedHarness } from "../tools/types.ts";
import { resolvedFixture } from "./testing.ts";

const enabled = process.env.ECMWF_MULTI_AGENTS_INTEGRATION === "1";
const v1Bins = (process.env.OPENCODE_V1_BINS ?? "opencode").split(/\s+/).filter((bin) => bin !== "");
const v2Bin = process.env.OPENCODE_V2_BIN ?? "opencode2";
const root = path.resolve(import.meta.dir, "..");
const sandboxScript = path.join(root, "tools", "sandbox.sh");
const SETTINGS = "ecmwf-multi-agents.jsonc";
const PLUGIN = path.join("plugins", "ecmwf-multi-agents.js");
const PARKED = "ecmwf-multi-agents.js.off";

const ISOLATION = {
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
};

const VALID =
  '// test settings\n{ "profile": "anthropic", "review": "always", "agents": { "scout": { "steps": 9 }, "builder": { "effort": "xhigh" } }, }\n';
const INVALID = '{ "profile": "anthropic", "review": "sometimes" }\n';

interface Sandbox {
  dir: string;
  project: string;
  config: string;
}

function makeSandbox(files: OutputFile[], plugin: string): Sandbox {
  // opencode reports canonical paths, so resolve symbolic links in the temporary directory.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "plugin-")));
  const project = path.join(dir, "project");
  mkdirSync(path.join(project, ".opencode"), { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: project });
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
  const config = path.join(dir, "home", ".config", "opencode");
  writeAll(config, files);
  writeAll(config, [{ path: PLUGIN, content: plugin }]);
  return { dir, project, config };
}

function writeAll(base: string, files: OutputFile[]): void {
  for (const file of files) {
    const target = path.join(base, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

/** Global and project settings files; undefined removes one. */
function writeSettings(box: Sandbox, global: string | undefined, project?: string): void {
  for (const [file, content] of [
    [path.join(box.config, SETTINGS), global],
    [path.join(box.project, ".opencode", SETTINGS), project],
  ] as const) {
    if (content === undefined) rmSync(file, { force: true });
    else writeFileSync(file, content);
  }
}

function setPlugin(box: Sandbox, on: boolean): void {
  const active = path.join(box.config, PLUGIN);
  const parked = path.join(box.config, PARKED);
  if (on && existsSync(parked)) renameSync(parked, active);
  if (!on && existsSync(active)) renameSync(active, parked);
}

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  void probe.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
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
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

/** A sandboxed `opencode serve`, its address and its output. */
interface Server {
  url: string;
  stderr: () => string;
  stop: () => Promise<void>;
}

/** The environment for a sandboxed opencode; `projectConfig` lets it read the project's own config. */
function isolated(env: Record<string, string>, projectConfig = false): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env, ...ISOLATION, ...env };
  if (projectConfig) delete out.OPENCODE_DISABLE_PROJECT_CONFIG;
  return out;
}

async function startServer(box: Sandbox, bin: string, args: string[], env: Record<string, string>, pattern: RegExp, projectConfig = false): Promise<Server> {
  const proc = Bun.spawn([sandboxScript, box.dir, bin, "serve", "--hostname", "127.0.0.1", ...args], {
    cwd: box.project,
    env: isolated(env, projectConfig),
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
      return pattern.exec(stdout)?.[1];
    });
    return { url, stderr: () => stderr, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

const v1Harness = resolvedFixture();

// ---------------------------------------------------------------------------------------------
// opencode 1.x

interface V1Agent {
  name: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  steps?: number;
  prompt?: string;
}

interface V1Part {
  type: string;
  tool?: string;
  text?: string;
  state?: { status: string; input?: { command?: string }; output?: string; error?: string };
}

/** Text of a chat-completions message, whether its content is a string or a list of parts. */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

/** What the stand-in model received in one streamed request. */
interface StandInRequest {
  system: string;
  /** The text of every user message in the request, in order. */
  users: string[];
}

/**
 * A stand-in OpenAI-compatible chat server with a fixed script. lead pushes when told
 * PUSH_AS_LEAD and hands RUN_PUSH to the builder when told DELEGATE_PUSH; the builder runs one
 * harmless command, then `git push origin main`, then answers. The reviewer answers with a
 * verdict. Every streamed request is recorded in `requests`.
 */
function standInModel() {
  const requests: StandInRequest[] = [];
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
      const system = messages.filter((message) => role(message) === "system").map(textOf).join("\n");
      const user = textOf([...messages].reverse().find((message) => role(message) === "user"));
      const results = messages.filter((message) => role(message) === "tool").length;
      let tool: { name: string; args: Record<string, string> } | undefined;
      let text = "ok";
      if (system.includes("You are lead")) {
        if (user.includes("PUSH_AS_LEAD") && results === 0) tool = { name: "bash", args: { command: "git push origin main", description: "push" } };
        else if (user.includes("DELEGATE_PUSH") && results === 0)
          tool = { name: "task", args: { description: "push the work", prompt: "RUN_PUSH", subagent_type: "builder" } };
        else text = "lead done";
      } else if (system.includes("You are builder.")) {
        if (results === 0) tool = { name: "bash", args: { command: "echo builder-ok", description: "harmless" } };
        else if (results === 1) tool = { name: "bash", args: { command: "git push origin main", description: "push" } };
        else text = "builder done";
      } else if (system.includes("You are reviewer.")) {
        text = "VERDICT: APPROVE";
      }
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
      calls++;
      requests.push({ system, users: messages.filter((message) => role(message) === "user").map(textOf) });
      const events = tool
        ? [
            chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }, null),
            chunk({}, "tool_calls"),
          ]
        : [chunk({ role: "assistant", content: text }, null), chunk({}, "stop")];
      return new Response(`${events.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return Object.assign(server, { requests });
}

for (const bin of v1Bins) {
  describe.skipIf(!enabled)(`plugin in opencode 1.x (${bin})`, () => {
    let box: Sandbox;
    let version = "";

    const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      const proc = Bun.spawn([sandboxScript, box.dir, bin, ...args], {
        cwd: box.project,
        env: { ...process.env, ...ISOLATION },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill("SIGKILL"), 180_000);
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timer);
      return { code, stdout, stderr };
    };
    const json = async <T>(args: string[]): Promise<T> => {
      const result = await run(args);
      if (result.code !== 0) throw new Error(`${bin} ${args.join(" ")} exited ${result.code}\n${result.stderr}${result.stdout}`);
      return JSON.parse(result.stdout) as T;
    };
    const agent = (id: string) => json<V1Agent>(["debug", "agent", id]);
    const defaultAgent = async () => (await json<{ default_agent?: string }>(["debug", "config"])).default_agent;
    const reviewLine = (agent: V1Agent) => agent.prompt?.split("\n").find((line) => line.startsWith("Review policy:"));

    beforeAll(async () => {
      box = makeSandbox(emitV1(v1Harness), await bundlePlugin(root, v1Harness));
      version = (await run(["--version"])).stdout.trim();
    }, 60_000);

    afterAll(() => {
      if (box) rmSync(box.dir, { recursive: true, force: true });
    });

    test("the binary is opencode 1.x", () => {
      expect(version).toMatch(/^1\.\d+\.\d+$/);
    });

    test("settings apply: profile, a step override, an effort override, the review policy and lead as default agent", async () => {
      writeSettings(box, VALID);
      const reviewer = await agent("reviewer");
      expect(reviewer.model).toEqual({ providerID: "anthropic", modelID: "claude-opus-5-5" });
      expect(reviewer.variant).toBe("high");
      expect(reviewer.steps).toBe(30);
      const scout = await agent("scout");
      expect(scout.steps).toBe(9);
      expect(scout.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5-5" });
      expect(scout.variant).toBe("medium");
      const builder = await agent("builder");
      expect(builder.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5-5" });
      expect(builder.variant).toBe("xhigh");
      expect(builder.steps).toBe(60);
      expect(reviewLine(await agent("lead"))).toBe("Review policy: always");
      expect(await defaultAgent()).toBe("lead");
    }, 300_000);

    test("the project file overrides the global one; an invalid project file is ignored", async () => {
      writeSettings(box, '{ "profile": "anthropic", "review": "never" }', '{ "agents": { "reviewer": { "model": "github-copilot/gpt-6.1-sol" } } }');
      expect((await agent("reviewer")).model).toEqual({ providerID: "github-copilot", modelID: "gpt-6.1-sol" });
      expect((await agent("reviewer")).variant).toBeUndefined();
      writeSettings(box, '{ "profile": "anthropic", "review": "never" }', '{ "review": "always", "agents": { "scout": { "steps": 0 } } }');
      expect((await agent("reviewer")).model?.providerID).toBe("anthropic");
      expect(reviewLine(await agent("lead"))).toBe("Review policy: never");
      expect((await agent("scout")).steps).toBe(30);
    }, 120_000);

    test("an invalid settings file leaves the defaults", async () => {
      writeSettings(box, INVALID);
      const reviewer = await agent("reviewer");
      expect(reviewer.model).toEqual({ providerID: "github-copilot", modelID: "gpt-6.1-sol" });
      expect(reviewer.variant).toBe("medium");
      expect((await agent("scout")).steps).toBe(30);
      expect(reviewLine(await agent("lead"))).toBe("Review policy: auto");
      expect(await defaultAgent()).toBe("lead");
    }, 120_000);

    test("a settings file that still says variant is ignored", async () => {
      writeSettings(box, '{ "profile": "anthropic", "agents": { "builder": { "variant": "xhigh" } } }');
      const builder = await agent("builder");
      expect(builder.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5-5" });
      expect(builder.variant).toBe("high");
      expect((await agent("reviewer")).model?.providerID).toBe("github-copilot");
    }, 120_000);

    test("default_agent false leaves opencode's default", async () => {
      writeSettings(box, '{ "default_agent": false }');
      expect(await defaultAgent()).toBeUndefined();
    }, 120_000);

    test("without the plugin the baked defaults apply", async () => {
      writeSettings(box, VALID);
      setPlugin(box, false);
      try {
        const reviewer = await agent("reviewer");
        expect(reviewer.model).toEqual({ providerID: "github-copilot", modelID: "gpt-6.1-sol" });
        expect(reviewer.variant).toBe("medium");
        expect((await agent("builder")).variant).toBe("high");
        expect((await agent("scout")).steps).toBe(30);
        expect(reviewLine(await agent("lead"))).toBe("Review policy: auto");
        expect(await defaultAgent()).toBeUndefined();
      } finally {
        setPlugin(box, true);
      }
    }, 120_000);

    describe("shell guard after 'Allow always'", () => {
      let model: ReturnType<typeof standInModel> | undefined;

      beforeAll(() => {
        model = standInModel();
        // Agents without models, so every agent runs on the stand-in's session model.
        const harness: ResolvedHarness = resolvedFixture();
        for (const item of harness.agents) {
          delete item.model;
          delete item.variant;
        }
        writeAll(box.config, emitV1(harness));
        writeSettings(box, '{ "profile": "inherit" }');
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
      });

      afterAll(async () => {
        await model?.stop(true);
      });

      /** lead pushes and the user allows it always; then lead hands the same push to the builder. */
      const scenario = async () => {
        const server = await startServer(box, bin, ["--port", String(freePort())], {}, /listening on (http:\/\/\S+)/);
        try {
          const api = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
            const url = new URL(route, server.url);
            url.searchParams.set("directory", box.project);
            const response = await fetch(url, {
              method,
              headers: { "content-type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
              signal: AbortSignal.timeout(120_000),
            });
            if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}`);
            const text = await response.text();
            return (text ? JSON.parse(text) : undefined) as T;
          };
          const bashParts = async (session: string) =>
            (await api<Array<{ parts: V1Part[] }>>("GET", `/session/${session}/message`))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool" && part.tool === "bash");

          const first = await api<{ id: string }>("POST", "/session", {});
          await api("POST", `/session/${first.id}/prompt_async`, { agent: "lead", parts: [{ type: "text", text: "PUSH_AS_LEAD" }] });
          const request = await within(60_000, "lead's permission request", async () => {
            const pending = await api<Array<{ id: string; permission: string; always: string[] }>>("GET", "/permission");
            return pending[0];
          });
          expect(request.permission).toBe("bash");
          expect(request.always).toContain("git push *");
          await api("POST", `/permission/${request.id}/reply`, { reply: "always" });
          const leadPush = await within(60_000, "lead's push to finish", async () => {
            const part = (await bashParts(first.id)).find((item) => item.state?.status === "completed" || item.state?.status === "error");
            return part;
          });

          const second = await api<{ id: string }>("POST", "/session", {});
          await api("POST", `/session/${second.id}/message`, { agent: "lead", parts: [{ type: "text", text: "DELEGATE_PUSH" }] });
          const children = await api<Array<{ id: string }>>("GET", `/session/${second.id}/children`);
          expect(children).toHaveLength(1);
          const builder = await bashParts(children[0]!.id);
          return { leadPush, builder };
        } finally {
          await server.stop();
        }
      };

      test("with the plugin, the builder's push is blocked; its other command and lead's push run", async () => {
        setPlugin(box, true);
        const { leadPush, builder } = await scenario();
        expect(leadPush.state?.status).toBe("completed");
        expect(builder.map((part) => part.state?.input?.command)).toEqual(["echo builder-ok", "git push origin main"]);
        expect(builder[0]!.state?.status).toBe("completed");
        expect(builder[0]!.state?.output).toContain("builder-ok");
        expect(builder[1]!.state?.status).toBe("error");
        expect(builder[1]!.state?.error).toContain('ecmwf-multi-agents: helpers may not run "git push origin main"; lead handles git and GitHub');
      }, 300_000);

      test("without the plugin, the approval lets the builder push despite its deny rule", async () => {
        setPlugin(box, false);
        try {
          const { builder } = await scenario();
          const push = builder.find((part) => part.state?.input?.command === "git push origin main");
          expect(push?.state?.status).toBe("completed");
          expect(push?.state?.error).toBeUndefined();
        } finally {
          setPlugin(box, true);
        }
      }, 300_000);

      /**
       * lead answers a first message, the user runs the reviewer's command in the same session,
       * then writes to lead again. Returns what each agent's requests contained.
       */
      const reviewScenario = async () => {
        const server = await startServer(box, bin, ["--port", String(freePort())], {}, /listening on (http:\/\/\S+)/);
        try {
          const api = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
            const url = new URL(route, server.url);
            url.searchParams.set("directory", box.project);
            const response = await fetch(url, {
              method,
              headers: { "content-type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
              signal: AbortSignal.timeout(120_000),
            });
            if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}`);
            const text = await response.text();
            return (text ? JSON.parse(text) : undefined) as T;
          };
          const session = await api<{ id: string }>("POST", "/session", {});
          await api("POST", `/session/${session.id}/message`, { agent: "lead", parts: [{ type: "text", text: "WARM_UP question" }] });
          const start = model!.requests.length;
          await api("POST", `/session/${session.id}/command`, { command: "review", arguments: "REVIEW_TARGET", agent: "lead" });
          const during = model!.requests.slice(start);
          await api("POST", `/session/${session.id}/message`, { agent: "lead", parts: [{ type: "text", text: "AFTER_REVIEW" }] });
          const after = model!.requests.slice(start + during.length);
          const children = await api<Array<{ id: string }>>("GET", `/session/${session.id}/children`);
          const messages = await api<Array<{ info: { role: string; agent?: string }; parts: V1Part[] }>>("GET", `/session/${session.id}/message`);
          return { during, after, children, messages };
        } finally {
          await server.stop();
        }
      };
      const isLead = (request: StandInRequest) => request.system.includes("You are lead");
      const isReviewer = (request: StandInRequest) => request.system.includes("You are reviewer.");

      test("a helper command answers in the user's session, from its request alone, and lead takes no extra turn", async () => {
        setPlugin(box, true);
        const { during, after, children, messages } = await reviewScenario();
        expect(children).toEqual([]);
        expect(during.length).toBeGreaterThan(0);
        expect(during.every(isReviewer)).toBe(true);
        for (const request of during) expect(request.users.join("\n")).not.toContain("WARM_UP");
        expect(during[0]!.users.join("\n")).toContain("Review REVIEW_TARGET");
        const report = [...messages].reverse().find((message) => message.info.role === "assistant" && message.info.agent === "reviewer");
        expect(report?.parts.find((part) => part.type === "text")?.text).toBe("VERDICT: APPROVE");
        // lead's next turn sees the whole conversation, the report included.
        expect(after.length).toBeGreaterThan(0);
        expect(after.every(isLead)).toBe(true);
        const leadSees = after[0]!.users.join("\n");
        expect(leadSees).toContain("WARM_UP");
        expect(leadSees).toContain("AFTER_REVIEW");
      }, 300_000);

      test("without the plugin, the helper's requests carry the whole conversation", async () => {
        setPlugin(box, false);
        try {
          const { during, children } = await reviewScenario();
          expect(children).toEqual([]);
          expect(during.every(isReviewer)).toBe(true);
          expect(during[0]!.users.join("\n")).toContain("WARM_UP");
        } finally {
          setPlugin(box, true);
        }
      }, 300_000);
    });
  });
}

// The harness switched on for one project with one line in its opencode.json, and nothing
// installed: a "checkout" in the sandbox home holds the repository's real package.json, the
// bundled plugin and the skills, as `git clone` gives them. The global config holds only the
// stand-in provider.
for (const bin of v1Bins) {
  describe.skipIf(!enabled)(`plugin switched on by a project's plugin line, opencode 1.x (${bin})`, () => {
    let box: Sandbox;
    let checkout = "";
    let model: ReturnType<typeof standInModel> | undefined;
    const LINE = '{ "plugin": ["{env:HOME}/.local/share/ecmwf-multi-agents"] }\n';

    const run = (args: string[], cwd = box.project) => {
      const result = Bun.spawnSync([sandboxScript, box.dir, bin, ...args], { cwd, env: isolated({}, true), stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(`${bin} ${args.join(" ")} exited ${result.exitCode}\n${result.stderr.toString()}`);
      return JSON.parse(result.stdout.toString()) as unknown;
    };
    const files = (dir: string) => [...new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true })].sort();

    beforeAll(async () => {
      model = standInModel();
      // Agents without models, so every agent runs on the stand-in's session model.
      const harness: ResolvedHarness = resolvedFixture();
      for (const item of harness.agents) {
        delete item.model;
        delete item.variant;
      }
      const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "plugin-line-")));
      const project = path.join(dir, "project");
      mkdirSync(project, { recursive: true });
      Bun.spawnSync(["git", "init", "-q"], { cwd: project });
      const config = path.join(dir, "home", ".config", "opencode");
      const provider = {
        npm: "@ai-sdk/openai-compatible",
        name: "Stand-in",
        options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "placeholder" },
        models: { m1: { name: "Stand-in", tool_call: true, temperature: true, limit: { context: 100000, output: 4096 } } },
      };
      writeAll(config, [
        { path: "opencode.json", content: JSON.stringify({ provider: { mock: provider }, enabled_providers: ["mock"], model: "mock/m1", small_model: "mock/m1" }, null, 2) },
        { path: SETTINGS, content: '{ "profile": "inherit" }\n' },
      ]);
      checkout = path.join(dir, "home", ".local", "share", "ecmwf-multi-agents");
      writeAll(checkout, [
        { path: "package.json", content: await Bun.file(path.join(root, "package.json")).text() },
        { path: "dist/opencode-v1/plugins/ecmwf-multi-agents.js", content: await bundlePlugin(root, harness) },
        ...emitV1(harness)
          .filter((file) => file.path.startsWith("skills/"))
          .map((file) => ({ path: `dist/opencode-v1/${file.path}`, content: file.content })),
      ]);
      writeFileSync(path.join(project, "opencode.json"), LINE);
      box = { dir, project, config };
    }, 120_000);

    afterAll(async () => {
      await model?.stop(true);
      if (box) rmSync(box.dir, { recursive: true, force: true });
    });

    test("the line brings the agents, commands and skills from the checkout, and lead is the default agent", () => {
      const before = files(checkout);
      const lead = run(["debug", "agent", "lead"]) as V1Agent;
      expect(lead.prompt).toContain("Review policy: auto");
      expect((run(["debug", "agent", "builder"]) as V1Agent).steps).toBe(60);
      const config = run(["debug", "config"]) as { default_agent?: string; command?: Record<string, { description?: string }>; skills?: { paths?: string[] } };
      expect(config.default_agent).toBe("lead");
      expect(Object.keys(config.command ?? {}).sort()).toEqual(["plan", "review"]);
      expect(config.command!.review!.description).toBe("Independent review of your changes");
      expect(config.skills?.paths).toEqual([path.join(checkout, "dist", "opencode-v1", "skills")]);
      const skills = run(["debug", "skill"]) as Array<{ name: string; location: string }>;
      expect(skills.find((skill) => skill.name === "ecmwf-multi-agents-plan")?.location).toBe(path.join(checkout, "dist", "opencode-v1", "skills", "ecmwf-multi-agents-plan", "SKILL.md"));
      // opencode wrote nothing into the checkout, and nothing into the project but sessions' data elsewhere.
      expect(files(checkout)).toEqual(before);
      expect(files(box.project).filter((file) => !file.startsWith(".git/") && file !== ".git")).toEqual(["opencode.json"]);
    }, 300_000);

    test("a project without the line gets none of it", () => {
      const other = path.join(box.dir, "other");
      mkdirSync(other, { recursive: true });
      Bun.spawnSync(["git", "init", "-q"], { cwd: other });
      const config = run(["debug", "config"], other) as { default_agent?: string; command?: Record<string, unknown> };
      expect(config.default_agent).toBeUndefined();
      expect(config.command?.review).toBeUndefined();
    }, 300_000);

    test("/review runs as the registered reviewer, and the shell guard stops a builder's push after 'Allow always'", async () => {
      const server = await startServer(box, bin, ["--port", String(freePort())], {}, /listening on (http:\/\/\S+)/, true);
      try {
        const api = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
          const url = new URL(route, server.url);
          url.searchParams.set("directory", box.project);
          const response = await fetch(url, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
          });
          if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}`);
          const text = await response.text();
          return (text ? JSON.parse(text) : undefined) as T;
        };
        const commands = await api<Array<{ name: string; description?: string }>>("GET", "/command");
        expect(commands.filter((command) => command.name === "review")).toEqual([expect.objectContaining({ description: "Independent review of your changes" })]);

        const reviewed = await api<{ id: string }>("POST", "/session", {});
        await api("POST", `/session/${reviewed.id}/command`, { command: "review", arguments: "LINE_TARGET", agent: "lead" });
        const stored = await api<Array<{ info: { role: string; agent?: string }; parts: V1Part[] }>>("GET", `/session/${reviewed.id}/message`);
        const verdict = stored.find((message) => message.info.role === "assistant" && message.info.agent === "reviewer");
        expect(verdict?.parts.find((part) => part.type === "text")?.text).toBe("VERDICT: APPROVE");

        const bashParts = async (session: string) =>
          (await api<Array<{ parts: V1Part[] }>>("GET", `/session/${session}/message`)).flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.tool === "bash");
        const first = await api<{ id: string }>("POST", "/session", {});
        await api("POST", `/session/${first.id}/prompt_async`, { agent: "lead", parts: [{ type: "text", text: "PUSH_AS_LEAD" }] });
        const request = await within(60_000, "lead's permission request", async () => (await api<Array<{ id: string; permission: string }>>("GET", "/permission"))[0]);
        await api("POST", `/permission/${request.id}/reply`, { reply: "always" });
        await within(60_000, "lead's push to finish", async () => (await bashParts(first.id)).find((part) => part.state?.status === "completed" || part.state?.status === "error"));
        const second = await api<{ id: string }>("POST", "/session", {});
        await api("POST", `/session/${second.id}/message`, { agent: "lead", parts: [{ type: "text", text: "DELEGATE_PUSH" }] });
        const children = await api<Array<{ id: string }>>("GET", `/session/${second.id}/children`);
        const builder = await bashParts(children[0]!.id);
        expect(builder.map((part) => part.state?.input?.command)).toEqual(["echo builder-ok", "git push origin main"]);
        expect(builder[1]!.state?.status).toBe("error");
        expect(builder[1]!.state?.error).toContain('ecmwf-multi-agents: helpers may not run "git push origin main"');
      } finally {
        await server.stop();
      }
    }, 300_000);
  });
}

// ---------------------------------------------------------------------------------------------
// opencode 2.0.16

interface V2Agent {
  id: string;
  description?: string;
  system?: string;
  steps?: number;
  model?: { id: string; providerID: string; variant?: string };
}

describe.skipIf(!enabled)(`plugin in opencode ${V2_VERSION}`, () => {
  let box: Sandbox;
  let server: (Server & { get: <T>(route: string) => Promise<T> }) | undefined;

  const start = async () => {
    const password = randomBytes(16).toString("hex");
    const auth = `Basic ${btoa(`opencode:${password}`)}`;
    const started = await startServer(box, v2Bin, ["--port", "0"], { OPENCODE_PASSWORD: password }, /server listening on (http:\/\/\S+)/);
    const get = async <T>(route: string): Promise<T> => {
      const url = new URL(route, started.url);
      url.searchParams.set("location[directory]", box.project);
      const response = await fetch(url, { headers: { authorization: auth }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`GET ${route}: HTTP ${response.status}`);
      return ((await response.json()) as { data: T }).data;
    };
    server = { ...started, get };
    return server;
  };
  const stop = async () => {
    await server?.stop();
    server = undefined;
  };
  const agents = () => server!.get<V2Agent[]>("/api/agent");
  const find = (list: V2Agent[], id: string) => list.find((item) => item.id === id);
  const reviewLine = (agent: V2Agent | undefined) => agent?.system?.split("\n").find((line) => line.startsWith("Review policy:"));
  /** Wait until the agent list satisfies a condition. */
  const until = (what: string, check: (list: V2Agent[]) => boolean, ms = 30_000) =>
    within(ms, what, async () => {
      const list = await agents();
      return check(list) ? list : undefined;
    });
  const ours = (list: V2Agent[]) =>
    find(list, "reviewer")?.model?.providerID === "anthropic" &&
    find(list, "scout")?.steps === 9 &&
    find(list, "builder")?.model?.variant === "xhigh" &&
    reviewLine(find(list, "lead")) === "Review policy: always";
  /** Lets the plugin's transform settle after the agents first appear (its fallback is 3 s). */
  const settle = () => Bun.sleep(4_000);

  beforeAll(async () => {
    const harness = resolvedFixture();
    box = makeSandbox(emitV2(harness), await bundlePlugin(root, harness));
    const version = Bun.spawnSync([sandboxScript, box.dir, v2Bin, "--version"], { cwd: box.project });
    expect(version.stdout.toString()).toContain(V2_VERSION);
  }, 60_000);

  afterAll(async () => {
    await stop();
    if (box) rmSync(box.dir, { recursive: true, force: true });
  });

  test("settings apply after the agent files load, and lead becomes the default agent", async () => {
    writeSettings(box, VALID);
    await start();
    const list = await until("the settings to apply", ours);
    expect(find(list, "reviewer")!.model).toEqual({ id: "claude-opus-5-5", providerID: "anthropic", variant: "high" });
    expect(find(list, "scout")!.model).toEqual({ id: "claude-sonnet-5-5", providerID: "anthropic", variant: "medium" });
    expect(find(list, "builder")!.model).toEqual({ id: "claude-sonnet-5-5", providerID: "anthropic", variant: "xhigh" });
    expect(find(list, "builder")!.steps).toBe(60);
    expect(find(list, "reviewer")!.steps).toBe(30);
    expect(list[0]!.id).toBe("lead");
    const plugins = await server!.get<Array<{ id?: string; state: { status: string } }>>("/api/plugin");
    expect(plugins.find((plugin) => plugin.id === "ecmwf-multi-agents")?.state.status).toBe("active");
  }, 180_000);

  test("the settings survive an agent file edit, a config change and plugin reloads", async () => {
    const scout = path.join(box.config, "agents", "scout.md");
    writeFileSync(scout, (await Bun.file(scout).text()).replace(/^description: .*$/m, 'description: "Edited scout"'));
    await until("the edited scout", (list) => find(list, "scout")?.description === "Edited scout" && ours(list));

    writeFileSync(path.join(box.config, "opencode.json"), '{ "default_agent": "build" }\n');
    await until("build as the configured default", (list) => list[0]?.id === "build" && ours(list));
    rmSync(path.join(box.config, "opencode.json"));
    await until("lead as default again", (list) => list[0]?.id === "lead" && ours(list));

    // A plugin after ours reloads opencode's agent loader behind our transform; one before ours
    // reloads this plugin too. Either way the settings must win again once activation ends.
    for (const name of ["zz-probe", "aa-probe"]) {
      writeFileSync(path.join(box.config, "plugins", `${name}.js`), `export default { id: "${name}", setup() {} };\n`);
      await within(30_000, `${name} to activate`, async () => {
        const plugins = await server!.get<Array<{ id?: string; state: { status: string } }>>("/api/plugin");
        return plugins.some((plugin) => plugin.id === name && plugin.state.status === "active") ? true : undefined;
      });
      await Bun.sleep(1_500);
      expect(ours(await agents())).toBe(true);
    }
    for (const name of ["zz-probe", "aa-probe"]) rmSync(path.join(box.config, "plugins", `${name}.js`));
    await Bun.sleep(1_500);
    expect(ours(await agents())).toBe(true);
    await stop();
  }, 180_000);

  test("an invalid project file is ignored and reported on standard error; the global file applies", async () => {
    writeSettings(box, '{ "profile": "anthropic", "review": "never" }', '{ "review": "always", "agents": { "scout": { "steps": 0 } } }');
    await start();
    const list = await until("the global settings", (items) => find(items, "reviewer")?.model?.providerID === "anthropic");
    expect(reviewLine(find(list, "lead"))).toBe("Review policy: never");
    expect(find(list, "scout")!.steps).toBe(30);
    expect(server!.stderr()).toContain(
      `ecmwf-multi-agents: ignoring ${path.join(box.project, ".opencode", SETTINGS)}: "agents.scout.steps" must be a whole number of at least 1, not 0`,
    );
    await stop();
  }, 180_000);

  test("an invalid settings file leaves the defaults", async () => {
    writeSettings(box, INVALID);
    await start();
    await until("lead as default agent", (list) => list[0]?.id === "lead");
    await settle();
    const list = await agents();
    expect(find(list, "reviewer")!.model).toEqual({ id: "gpt-6.1-sol", providerID: "github-copilot", variant: "medium" });
    expect(find(list, "scout")!.steps).toBe(30);
    expect(reviewLine(find(list, "lead"))).toBe("Review policy: auto");
    expect(server!.stderr()).toContain(`ecmwf-multi-agents: ignoring ${path.join(box.config, SETTINGS)}: "review" must be`);
    await stop();
  }, 180_000);

  test("without the plugin the agent files apply as written and build stays the default", async () => {
    writeSettings(box, VALID);
    setPlugin(box, false);
    try {
      await start();
      await until("the generated agents", (list) => find(list, "lead") !== undefined);
      await settle();
      const list = await agents();
      expect(list[0]!.id).toBe("build");
      expect(find(list, "reviewer")!.model).toEqual({ id: "gpt-6.1-sol", providerID: "github-copilot", variant: "medium" });
      expect(find(list, "builder")!.model).toEqual({ id: "claude-sonnet-5-5", providerID: "anthropic", variant: "high" });
      expect(find(list, "scout")!.steps).toBe(30);
      expect(reviewLine(find(list, "lead"))).toBe("Review policy: auto");
    } finally {
      await stop();
      setPlugin(box, true);
    }
  }, 180_000);
});
