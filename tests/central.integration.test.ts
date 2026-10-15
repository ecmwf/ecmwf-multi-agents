// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Opt-in check, with a real opencode 2, of the central install for shared machines: install.sh
// --central writes a read-only folder from the real dist/, and a sandboxed private server
// (`serve --stdio`) with OPENCODE_CONFIG naming the folder's opencode.json has the whole harness
// in a project that has nothing of its own. Runs only when ECMWF_MULTI_AGENTS_INTEGRATION=1.
// Binary: OPENCODE_V2_BIN (default "opencode2"). No model is called.
//
// The user's global config allows every shell command and edit; a stand-in model on 127.0.0.1
// answers in one project, so `/review` and a helper's shell call really run.
//
// What is pinned here, besides the harness's own behaviour, is opencode's undocumented
// OPENCODE_CONFIG: one extra config file above the user's global folder and below the project,
// with {file:} relative to it, absolute skills and a plugin folder with options.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { V2_VERSION } from "../tools/emit-v2.ts";

const REPO = path.resolve(import.meta.dir, "..");
const SANDBOX = path.join(REPO, "tools", "sandbox.sh");
const INSTALL = path.join(REPO, "install.sh");
const NAME = "ecmwf-multi-agents";
const AGENTS = ["builder", "lead", "reviewer", "scout"];
const COMMANDS = ["execute", "guide", "onboard", "plan", "progress", "review"];
const enabled = process.env.ECMWF_MULTI_AGENTS_INTEGRATION === "1";
const v2Bin = process.env.OPENCODE_V2_BIN ?? "opencode2";
const v2Available = (() => {
  if (!enabled || !existsSync(path.join(REPO, "dist", "opencode-v2", "central", "opencode.json"))) return false;
  try {
    return Bun.spawnSync([v2Bin, "--version"]).exitCode === 0;
  } catch {
    return false;
  }
})();

/** The user's global rules: every shell command and edit allowed, one shell command denied. */
const GLOBAL_PERMISSIONS = [
  { action: "shell", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "allow" },
  { action: "shell", resource: "touch user-denied*", effect: "deny" },
];

/**
 * A stand-in model: the reviewer approves, lead says it is done, and an agent asked `TOUCH <name>`
 * runs `touch <name>` in the shell once; every request is recorded.
 */
function standIn() {
  const seen: Array<{ agent: string; users: string[] }> = [];
  const textOf = (message: unknown): string => {
    const content = (message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  };
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "stand-in",
      object: "chat.completion.chunk",
      created: 0,
      model: "m1",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
    })}\n\n`;
  const stream = (body: string) => new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "m1", object: "model" }] });
      const body = (await request.json().catch(() => ({}))) as { messages?: unknown[]; stream?: boolean };
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const role = (message: unknown) => (message as { role?: string } | undefined)?.role;
      const system = messages.filter((message) => role(message) === "system" || role(message) === "developer").map(textOf).join("\n");
      const agent = system.includes("You are the reviewer") ? "reviewer" : system.includes("You are lead") ? "lead" : "other";
      const text = agent === "reviewer" ? "VERDICT: APPROVE\nCHECKED: the stand-in" : "lead done";
      const users = messages.filter((message) => role(message) === "user").map(textOf);
      seen.push({ agent, users });
      const touch = /TOUCH (\S+)/.exec(users.at(-1) ?? "");
      if (touch && !messages.some((message) => role(message) === "tool")) {
        const call = { name: "shell", arguments: JSON.stringify({ command: `touch ${touch[1]}`, description: "touch" }) };
        return stream(`${chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_touch", type: "function", function: call }] }, null)}${chunk({}, "tool_calls")}`);
      }
      return stream(`${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}`);
    },
  });
  return Object.assign(server, { seen });
}

interface ConfigAgent {
  description: string;
  mode: string;
  model?: string;
  steps?: number;
  color?: string;
  hidden: boolean;
  permissions: unknown[];
  system: string;
}

interface V2Agent {
  id: string;
  system?: string;
  description?: string;
  mode?: string;
  steps?: number;
  color?: string;
  hidden?: boolean;
  permissions?: unknown[];
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
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

/** Every entry under a folder with its size and modification time. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const stat = lstatSync(full);
      out.push(`${path.relative(root, full)} ${stat.mode.toString(8)} ${stat.size} ${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

function gitProject(dir: string): string {
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  return dir;
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe.skipIf(!v2Available)(`a central install in opencode ${V2_VERSION}`, () => {
  let box = "";
  let central = "";
  let config = "";
  let user = "";
  let env: Record<string, string> = {};
  let before: string[] = [];
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let url = "";
  let auth = "";
  let output = "";
  let fromConfig: { agents: Record<string, ConfigAgent>; commands: Record<string, { description: string }> };
  const projects = { plain: "", own: "", run: "" };
  let model: ReturnType<typeof standIn>;

  /** A command in the user's sandbox, with PATH offering the binary under test as opencode. */
  const asUser = (argv: string[], cwd: string, extra: string[] = []) => {
    const result = Bun.spawnSync([SANDBOX, user, "env", ...extra, ...argv], { cwd, env, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
  };

  const call = async <T = unknown>(method: string, route: string, project: string, body?: unknown): Promise<{ status: number; data: T }> => {
    const target = new URL(route, url);
    target.searchParams.set("location[directory]", project);
    const response = await fetch(target, {
      method,
      headers: { "content-type": "application/json", authorization: auth },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    const data = parsed !== null && typeof parsed === "object" && "data" in parsed ? (parsed as { data: T }).data : (parsed as T);
    return { status: response.status, data };
  };
  const get = async <T>(route: string, project: string): Promise<T> => {
    const { status, data } = await call<T>("GET", route, project);
    if (status !== 200) throw new Error(`GET ${route}: HTTP ${status}`);
    return data;
  };
  /** The doctor report, which the RPC gives once the plugin is active and the settings applied. */
  const doctor = (project: string) =>
    within(90_000, `the plugin's RPC in ${path.basename(project)}`, async () => {
      const answer = await call<{ output?: Record<string, unknown> }>("POST", `/api/rpc/${NAME}/doctor`, project, { input: {} });
      return answer.status === 200 ? answer.data.output : undefined;
    });
  const agents = (project: string) => get<V2Agent[]>("/api/agent", project);

  beforeAll(async () => {
    const version = Bun.spawnSync([v2Bin, "--version"]);
    if (!version.stdout.toString().includes(V2_VERSION)) throw new Error(`${v2Bin} is not opencode ${V2_VERSION}: ${version.stdout.toString().trim()}`);
    box = realpathSync(mkdtempSync(path.join(tmpdir(), "central-it-")));
    const bin = path.join(box, "bin");
    mkdirSync(bin);
    symlinkSync(realpathSync(Bun.which(v2Bin) ?? v2Bin), path.join(bin, "opencode"));
    env = { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, LC_ALL: "C" };

    // The administrator, in a sandbox of their own.
    central = path.join(box, "shared", NAME);
    config = path.join(central, "opencode.json");
    const admin = Bun.spawnSync([SANDBOX, path.join(box, "admin"), "sh", INSTALL, "--central", central, "--review", "never"], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
    if (admin.exitCode !== 0) throw new Error(`install.sh --central failed:\n${admin.stdout}${admin.stderr}`);
    // Site settings beyond what the installer writes, then read-only again.
    Bun.spawnSync(["chmod", "u+w", central, path.join(central, `${NAME}.jsonc`)]);
    writeFileSync(path.join(central, `${NAME}.jsonc`), '{ "review": "never", "profile": "inherit", "agents": { "scout": { "steps": 3 }, "reviewer": { "steps": 4 } } }\n');
    Bun.spawnSync(["chmod", "-R", "a-w", central]);
    before = snapshot(central);
    fromConfig = JSON.parse(readFileSync(config, "utf8"));

    // A user with settings of their own, and two projects: one with nothing, one with its own
    // settings and its own scout.
    user = path.join(box, "user");
    write(path.join(user, "home", ".config", "opencode", `${NAME}.jsonc`), '{ "agents": { "scout": { "steps": 7 } } }\n');
    write(path.join(user, "home", ".config", "opencode", "opencode.json"), `${JSON.stringify({ permissions: GLOBAL_PERMISSIONS }, null, 2)}\n`);
    projects.plain = gitProject(path.join(box, "plain"));
    projects.own = gitProject(path.join(box, "own"));
    write(path.join(projects.own, ".opencode", `${NAME}.jsonc`), '{ "review": "always" }\n');
    write(path.join(projects.own, ".opencode", "agents", "scout.md"), "---\nsteps: 9\n---\n\nThe project's scout.\n");
    // A project on the stand-in model; the site's profile inherit leaves every agent on it.
    model = standIn();
    const provider = {
      name: "Stand-in",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "placeholder" },
      models: { m1: { name: "Stand-in", tool_call: true, temperature: true, limit: { context: 100000, output: 4096 } } },
    };
    projects.run = gitProject(path.join(box, "run"));
    write(path.join(projects.run, "opencode.json"), `${JSON.stringify({ model: "mock/m1", provider: { mock: provider } }, null, 2)}\n`);

    const password = randomBytes(16).toString("hex");
    auth = `Basic ${btoa(`opencode:${password}`)}`;
    proc = Bun.spawn([SANDBOX, user, "env", `OPENCODE_CONFIG=${config}`, v2Bin, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: projects.plain,
      env: { ...env, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
    };
    void drain(proc.stdout as ReadableStream<Uint8Array>);
    void drain(proc.stderr as ReadableStream<Uint8Array>);
    url = await within(120_000, "the server address", async () => {
      if (proc!.exitCode !== null) throw new Error(`opencode serve exited with ${proc!.exitCode}\n${output}`);
      const line = output.split("\n")[0];
      if (line === undefined || !output.includes("\n")) return undefined;
      return (JSON.parse(line) as { url?: string }).url;
    });
  }, 300_000);

  afterAll(async () => {
    if (proc) {
      (proc.stdin as { end(): void }).end();
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
      if (!exited) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }
    await model?.stop(true);
    if (box) {
      Bun.spawnSync(["chmod", "-R", "u+w", box]);
      rmSync(box, { recursive: true, force: true });
    }
  });

  test("the agents come from the central config, with the harness's prompts, rules and settings", async () => {
    const report = await doctor(projects.plain);
    expect(report).toMatchObject({ defaultAgent: "lead", leadLoaded: true, leadDefinition: "harness", reviewLine: "Review policy: never" });
    expect(report.settingsFiles).toEqual([path.join(central, `${NAME}.jsonc`), path.join(user, "home", ".config", "opencode", `${NAME}.jsonc`)]);
    const list = await agents(projects.plain);
    expect(list[0]?.id).toBe("lead");
    for (const id of AGENTS) {
      const got = list.find((agent) => agent.id === id);
      const want = fromConfig.agents[id]!;
      const prompt = readFileSync(path.join(central, "prompts", `${id}.md`), "utf8").trim();
      expect(got?.system).toBe(id === "lead" ? prompt.replace(/^Review policy: .*$/m, "Review policy: never") : prompt);
      expect({ description: got?.description, mode: got?.mode, color: got?.color, hidden: got?.hidden }).toEqual({
        description: want.description,
        mode: want.mode,
        color: want.color,
        hidden: false,
      });
      // The agent's own rules come after the user's global ones, so they win over them.
      const rules = got?.permissions ?? [];
      const runs = rules.flatMap((_, index) => (JSON.stringify(rules.slice(index, index + want.permissions.length)) === JSON.stringify(want.permissions) ? [index] : []));
      const global = rules.findIndex((_, index) => JSON.stringify(rules.slice(index, index + GLOBAL_PERMISSIONS.length)) === JSON.stringify(GLOBAL_PERMISSIONS));
      expect(global).toBeGreaterThanOrEqual(0);
      if (want.permissions.length > 0) {
        expect(runs.length).toBeGreaterThanOrEqual(1);
        expect(runs.at(-1)!).toBeGreaterThan(global);
        expect(rules.slice(runs.at(-1)! + want.permissions.length).some((rule) => GLOBAL_PERMISSIONS.some((item) => JSON.stringify(item) === JSON.stringify(rule)))).toBe(false);
      }
    }
    // Site, then the user's own settings; profile inherit leaves every agent on the session model.
    expect(list.find((agent) => agent.id === "scout")?.steps).toBe(7);
    expect(list.find((agent) => agent.id === "reviewer")?.steps).toBe(4);
    expect(list.find((agent) => agent.id === "builder")?.steps).toBe(fromConfig.agents.builder!.steps);
    expect((list.find((agent) => agent.id === "lead") as { model?: unknown }).model).toBeUndefined();
  }, 180_000);

  test("the commands and skills come from the central folder, and the plugin is active once", async () => {
    await doctor(projects.plain);
    const commands = await get<Array<{ name: string; description?: string }>>("/api/command", projects.plain);
    const ours = commands.filter((command) => COMMANDS.includes(command.name)).sort((a, b) => a.name.localeCompare(b.name));
    expect(ours.map((command) => [command.name, command.description])).toEqual(COMMANDS.map((name) => [name, fromConfig.commands[name]!.description]));
    const skills = (await get<Array<{ id: string; path?: string }>>("/api/skill", projects.plain)).filter((skill) => skill.id.startsWith(NAME));
    expect(skills.map((skill) => skill.id).sort()).toEqual([`${NAME}-guide`, `${NAME}-plan`]);
    for (const skill of skills) expect(skill.path).toBe(path.join(central, "skills", skill.id, "SKILL.md"));
    const plugins = await get<Array<{ id?: string; state?: { status?: string } }>>("/api/plugin", projects.plain);
    expect(plugins.filter((plugin) => plugin.id === NAME).map((plugin) => plugin.state?.status)).toEqual(["active"]);
  }, 180_000);

  const touch = async (project: string, agent: string, name: string) => {
    const session = (await call<{ id: string }>("POST", "/api/session", project, { agent, location: { directory: project } })).data;
    const sent = await call("POST", `/api/session/${session.id}/prompt`, project, { text: `TOUCH ${name}` });
    expect(sent.status).toBeLessThan(300);
    type Content = { type: string; name?: string; state?: { status?: string } };
    const result = await within(60_000, `${agent}'s shell call`, async () =>
      (await get<Array<{ content?: Content[] }>>(`/api/session/${session.id}/message`, project))
        .flatMap((message) => message.content ?? [])
        .find((item) => item.type === "tool" && item.name === "shell" && (item.state?.status === "completed" || item.state?.status === "error")),
    );
    return { status: result.state?.status, exists: existsSync(path.join(project, name)) };
  };

  test("the agents' own rules win over the user's global allow-all: scout cannot run touch", async () => {
    await doctor(projects.run);
    // scout's own rules deny every shell command but a few read-only ones; the user allows all.
    expect(await touch(projects.run, "scout", "scout-central")).toEqual({ status: "error", exists: false });
    // builder sets no rule for `touch`: the user's rules decide, the allow and the narrower deny.
    expect(await touch(projects.run, "builder", "builder-central")).toEqual({ status: "completed", exists: true });
    expect(await touch(projects.run, "builder", "user-denied-central")).toEqual({ status: "error", exists: false });
  }, 300_000);

  test("/review is answered by the reviewer in the user's own session, although the central config defines it", async () => {
    await doctor(projects.run);
    // The plugin registers its commands again after every activation.
    await Bun.sleep(4_000);
    const session = (await call<{ id: string }>("POST", "/api/session", projects.run, { agent: "lead", location: { directory: projects.run } })).data;
    const sent = await call("POST", `/api/session/${session.id}/command`, projects.run, { name: "review", text: "main" });
    expect(sent.status).toBeLessThan(300);
    const review = await within(30_000, "the review", async () => model.seen.find((item) => item.agent === "reviewer"));
    // Only the brief, without the line a child session's request starts with.
    expect(review.users).toHaveLength(1);
    expect(review.users[0]).toStartWith("Review the target below");
    expect(review.users[0]).toContain("Target: main");
    await within(30_000, "the session to go back to lead", async () =>
      (await get<{ agent?: string }>(`/api/session/${session.id}`, projects.run)).agent === "lead" ? true : undefined,
    );
    const sessions = await get<Array<{ id: string; parentID?: string }>>("/api/session", projects.run);
    expect(sessions.filter((item) => item.parentID === session.id)).toEqual([]);
    type Content = { type: string; text?: string };
    const texts = (await get<Array<{ type?: string; content?: Content[] }>>(`/api/session/${session.id}/message`, projects.run))
      .flatMap((message) => message.content ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "");
    expect(texts.some((text) => text.includes("VERDICT: APPROVE"))).toBe(true);
  }, 180_000);

  test("a project's own settings and agent files win over the central install", async () => {
    const report = await doctor(projects.own);
    expect(report.reviewLine).toBe("Review policy: always");
    const scout = (await agents(projects.own)).find((agent) => agent.id === "scout");
    expect(scout?.steps).toBe(7);
    expect(scout?.system).toBe("The project's scout.");
  }, 180_000);

  test("central-enable and central-disable keep OPENCODE_CONFIG in the user's service settings; doctor checks it all", () => {
    const enable = asUser(["sh", INSTALL, "central-enable", central], projects.plain);
    expect(enable.code).toBe(0);
    expect(asUser(["opencode", "service", "get", "env", "OPENCODE_CONFIG"], projects.plain).out.trim()).toBe(config);
    const checked = asUser(["sh", INSTALL, "doctor"], projects.plain, [`OPENCODE_CONFIG=${config}`]);
    expect(checked.out).toContain(`OK    central install in ${central}`);
    expect(checked.out).toContain("OK    OPENCODE_CONFIG in this shell names it");
    expect(checked.out).toContain(`OK    your opencode service starts with OPENCODE_CONFIG=${config}`);
    expect(checked.out).toContain("OK    lead is the harness's, from the central install, with the plugin");
    expect(checked.out).toContain("OK    lead's Review policy: never");
    expect(checked.out).toContain("OK    lead is the default agent");
    expect(asUser(["sh", INSTALL, "central-disable"], projects.plain).code).toBe(0);
    expect(asUser(["opencode", "service", "get", "env", "OPENCODE_CONFIG"], projects.plain).out.trim()).toBe("");
  }, 180_000);

  test("nothing was written into the central folder", () => {
    expect(snapshot(central)).toEqual(before);
  });
});
