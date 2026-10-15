// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Opt-in check, with a real opencode 2, that a project's `plugins` line brings the whole harness.
// Runs only when ECMWF_MULTI_AGENTS_INTEGRATION=1. Binary: OPENCODE_V2_BIN (default "opencode2").
//
// One sandboxed `opencode serve` (tools/sandbox.sh) serves these projects: one whose config names
// a checkout-like folder in `plugins` (package.json, the root entries and dist/opencode-v2, all
// generated from src/), one with the generated files copied into its .opencode/ and no plugin,
// one with both, one with neither, and two with a stand-in model that speaks the OpenAI
// chat-completions protocol on 127.0.0.1: one with the line, one with the files. No hosted model
// is contacted. The user's global config holds broad `permissions` (every shell command and edit
// allowed) and one narrower deny.
//
// What is pinned here: the agents, commands and skills the plugin registers are the ones opencode
// loads from the generated files, permission rules in the same order; the agents' own rules win
// over the user's global ones, and the user's deny still applies where the agents set no rule,
// whichever way the harness arrives; a project without the line has none of it; the RPC answers;
// the plugin folder loads with its TUI entry; and `/review`, which the plugin registers again
// after activation, is answered by the reviewer in the user's own session (inline.ts), with no
// child session, and a report that arrives later wakes lead.
//
// A fifth project names the npm package itself, packed from this repository with `npm pack`, as
// `@ecmwf.int/multi-agents@file:<tarball>`: opencode installs it through its own npm path into
// the sandbox's cache, as it would a published version. That test needs npm and skips without it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { embedHarness, pluginFiles } from "../tools/bundle-plugin.ts";
import { V2_VERSION, emitV2 } from "../tools/emit-v2.ts";
import { load } from "../tools/load.ts";
import { resolveHarness } from "../tools/resolve.ts";
import type { OutputFile } from "../tools/types.ts";
import type { EmbeddedHarness, PermissionRule } from "./types.ts";

const enabled = process.env.ECMWF_MULTI_AGENTS_INTEGRATION === "1";
const v2Bin = process.env.OPENCODE_V2_BIN ?? "opencode2";
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
const NAME = "ecmwf-multi-agents";
const AGENTS = ["lead", "scout", "builder", "reviewer"];
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name: string; version: string };
const npmAvailable = Bun.which("npm") !== null;
if (v2Available && !npmAvailable) console.warn("skipping the packed npm package test: npm was not found (it comes with Node.js)");

const ISOLATION = {
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
};
/** Flags an enclosing opencode session may export. */
const EXPERIMENTAL_FLAGS = ["OPENCODE_EXPERIMENTAL", "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"];

function writeAll(base: string, files: readonly OutputFile[]): void {
  for (const file of files) {
    const target = path.join(base, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

function gitProject(dir: string, config?: unknown): string {
  mkdirSync(dir, { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
  if (config !== undefined) writeFileSync(path.join(dir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`);
  return dir;
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

/** The user's global rules: every shell command and edit allowed, one shell command denied. */
const GLOBAL_PERMISSIONS = [
  { action: "shell", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "allow" },
  { action: "shell", resource: "touch user-denied*", effect: "deny" },
];

/** The npm package of this repository, packed as `npm pack` would publish it; returns the tarball. */
function npmPack(destination: string): string {
  mkdirSync(destination, { recursive: true });
  const result = Bun.spawnSync(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, npm_config_update_notifier: "false", npm_config_cache: path.join(destination, ".npm") },
  });
  if (result.exitCode !== 0) throw new Error(`npm pack failed: ${result.stderr.toString().trim()}`);
  const filename = (JSON.parse(result.stdout.toString()) as Array<{ filename?: string }>)[0]?.filename;
  if (!filename) throw new Error(`npm pack did not name its tarball: ${result.stdout.toString().slice(0, 200)}`);
  return path.join(destination, filename);
}

/** The folders, below dir, that hold an installed copy of the named package. */
function installed(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(path.join("node_modules", name, "package.json")))
    .map((entry) => path.dirname(path.join(dir, entry)));
}

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
      const agent = system.includes("You are the reviewer") ? "reviewer" : system.includes("You are lead") ? "lead" : "other";
      const text = agent === "reviewer" ? "VERDICT: APPROVE\nCHECKED: the stand-in" : "lead done";
      const users = messages.filter((message) => role(message) === "user").map(textOf);
      seen.push({ agent, users });
      const touch = /TOUCH (\S+)/.exec(users.at(-1) ?? "");
      if (touch && body.stream && !messages.some((message) => role(message) === "tool")) {
        const call = { name: "shell", arguments: JSON.stringify({ command: `touch ${touch[1]}`, description: "touch" }) };
        return new Response(
          `${chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_touch", type: "function", function: call }] }, null)}${chunk({}, "tool_calls")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
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
      return new Response(`${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return Object.assign(server, { seen });
}

interface V2Agent {
  id: string;
  system?: string;
  description?: string;
  mode?: string;
  model?: unknown;
  steps?: number;
  color?: string;
  hidden?: boolean;
  permissions?: unknown[];
}

describe.skipIf(!v2Available)(`a project's plugins line in opencode ${V2_VERSION}`, () => {
  let box = "";
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let url = "";
  let auth = "";
  let stderr = "";
  let model: ReturnType<typeof standIn>;
  let embedded: EmbeddedHarness;
  const projects = { line: "", files: "", both: "", none: "", run: "", runFiles: "", packed: "" };

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
  const active = (project: string, ms = 60_000) =>
    within(ms, `the plugin to be active in ${path.basename(project)}`, async () => {
      const plugins = await get<Array<{ id?: string; state?: { status?: string }; features?: { tui?: boolean } }>>("/api/plugin", project);
      return plugins.find((plugin) => plugin.id === NAME && plugin.state?.status === "active");
    });
  const agents = (project: string) => get<V2Agent[]>("/api/agent", project);
  /** The agents once lead is among them: a project the service has not seen lists a partial set at first. */
  const withLead = (project: string) =>
    within(60_000, `the agents of ${path.basename(project)}`, async () => {
      const list = await agents(project);
      return list.some((agent) => agent.id === "lead") ? list : undefined;
    });
  /** Ask an agent, in a new session, to run `touch <name>`: how the call ended and whether the file exists. */
  const touch = async (project: string, agent: string, name: string) => {
    const session = (await call<{ id: string }>("POST", "/api/session", project, { agent, location: { directory: project } })).data;
    const sent = await call("POST", `/api/session/${session.id}/prompt`, project, { text: `TOUCH ${name}` });
    expect(sent.status).toBeLessThan(300);
    type Content = { type: string; name?: string; state?: { status?: string } };
    const result = await within(60_000, `${agent}'s shell call in ${path.basename(project)}`, async () =>
      (await get<Array<{ content?: Content[] }>>(`/api/session/${session.id}/message`, project))
        .flatMap((message) => message.content ?? [])
        .find((item) => item.type === "tool" && item.name === "shell" && (item.state?.status === "completed" || item.state?.status === "error")),
    );
    return { status: result.state?.status, exists: existsSync(path.join(project, name)) };
  };
  const pick = (agent: V2Agent | undefined) =>
    agent && {
      system: agent.system,
      description: agent.description,
      mode: agent.mode,
      model: agent.model,
      steps: agent.steps,
      color: agent.color,
      hidden: agent.hidden,
      permissions: agent.permissions,
    };

  beforeAll(async () => {
    const version = Bun.spawnSync([v2Bin, "--version"]);
    if (!version.stdout.toString().includes(V2_VERSION)) throw new Error(`${v2Bin} is not opencode ${V2_VERSION}: ${version.stdout.toString().trim()}`);
    box = realpathSync(mkdtempSync(path.join(tmpdir(), "register-")));
    const harness = resolveHarness(await load(root));
    const generated = emitV2(harness);
    embedded = embedHarness(harness);

    // A checkout where the documented line expects one.
    const checkout = path.join(box, "home", ".local", "share", NAME);
    writeAll(path.join(checkout, "dist", "opencode-v2"), [...generated, ...(await pluginFiles(root, harness))]);
    for (const file of ["package.json", "server.js", "tui.js"]) copyFileSync(path.join(root, file), path.join(checkout, file));
    const line = `{env:HOME}/.local/share/${NAME}`;

    model = standIn();
    const provider = {
      name: "Stand-in",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "placeholder" },
      models: { m1: { name: "Stand-in", tool_call: true, temperature: true, limit: { context: 100000, output: 4096 } } },
    };
    projects.line = gitProject(path.join(box, "line"), { plugins: [line] });
    projects.files = gitProject(path.join(box, "files"));
    writeAll(path.join(projects.files, ".opencode"), generated);
    projects.both = gitProject(path.join(box, "both"), { plugins: [line] });
    writeAll(path.join(projects.both, ".opencode"), generated.map((file) => (file.path === "agents/scout.md" ? { ...file, content: file.content.replace(/^steps: \d+$/m, "steps: 7") } : file)));
    projects.none = gitProject(path.join(box, "none"));
    projects.run = gitProject(path.join(box, "run"), { plugins: [line], model: "mock/m1", provider: { mock: provider } });
    // Every agent on the stand-in's session model.
    writeAll(path.join(projects.run, ".opencode"), [{ path: `${NAME}.jsonc`, content: '{ "profile": "inherit" }\n' }]);
    projects.runFiles = gitProject(path.join(box, "run-files"), { model: "mock/m1", provider: { mock: provider } });
    writeAll(
      path.join(projects.runFiles, ".opencode"),
      generated.map((file) => (file.path.startsWith("agents/") ? { ...file, content: file.content.replace(/^model: .*$/m, 'model: "mock/m1"') } : file)),
    );
    const globalConfig = path.join(box, "home", ".config", "opencode");
    mkdirSync(globalConfig, { recursive: true });
    writeFileSync(path.join(globalConfig, "opencode.json"), `${JSON.stringify({ permissions: GLOBAL_PERMISSIONS }, null, 2)}\n`);
    if (npmAvailable) projects.packed = gitProject(path.join(box, "packed"), { plugins: [`${pkg.name}@file:${npmPack(path.join(box, "pack"))}`] });

    const password = randomBytes(16).toString("hex");
    auth = `Basic ${btoa(`opencode:${password}`)}`;
    const inherited = { ...process.env };
    for (const flag of EXPERIMENTAL_FLAGS) delete inherited[flag];
    delete inherited.OPENCODE_DISABLE_PROJECT_CONFIG;
    proc = Bun.spawn([sandboxScript, box, v2Bin, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: projects.none,
      env: { ...inherited, ...ISOLATION, OPENCODE_PASSWORD: password },
      stdout: "pipe",
      stderr: "pipe",
    });
    let stdout = "";
    const drain = async (stream: ReadableStream<Uint8Array>, sink: (text: string) => void) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) sink(decoder.decode(chunk));
    };
    void drain(proc.stdout as ReadableStream<Uint8Array>, (text) => (stdout += text));
    void drain(proc.stderr as ReadableStream<Uint8Array>, (text) => (stderr += text));
    url = await within(120_000, "the server address", async () => {
      if (proc!.exitCode !== null) throw new Error(`opencode serve exited with ${proc!.exitCode}\n${stderr}`);
      return /listening on (http:\/\/\S+)/.exec(stdout)?.[1];
    });
  }, 300_000);

  afterAll(async () => {
    if (proc) {
      proc.kill();
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
      if (!exited) proc.kill("SIGKILL");
    }
    await model?.stop(true);
    if (box) rmSync(box, { recursive: true, force: true });
  });

  test("the plugin folder loads with its TUI entry, and lead becomes the default agent", async () => {
    const plugin = await active(projects.line);
    expect(plugin.features?.tui).toBe(true);
    // The late settings transform registers after activation (or after its fallback delay).
    await Bun.sleep(4_000);
    expect((await agents(projects.line))[0]?.id).toBe("lead");
  }, 120_000);

  test("the agents, commands and skills it registers are those opencode loads from the generated files", async () => {
    await active(projects.line);
    const fromFiles = await withLead(projects.files);
    const fromPlugin = await agents(projects.line);
    for (const id of AGENTS) {
      const want = pick(fromFiles.find((agent) => agent.id === id))!;
      expect(want.system).toBeString();
      // The agent's own rules come after the user's global ones, as from the file. Rules opencode
      // adds to every agent after the config (a `browser` deny) come before them instead of after:
      // nothing in the agent's own rules matches them.
      const own = embedded.agents.find((agent) => agent.id === id)!.permissions!;
      const rules = want.permissions!;
      const start = rules.findIndex((_, index) => JSON.stringify(rules.slice(index, index + own.length)) === JSON.stringify(own));
      expect(JSON.stringify(rules.slice(start - GLOBAL_PERMISSIONS.length, start))).toBe(JSON.stringify(GLOBAL_PERMISSIONS));
      const later = rules.slice(start + own.length);
      expect(later.length).toBeLessThan(own.length);
      for (const rule of later) expect(own.some((item) => item.action === (rule as PermissionRule).action)).toBe(false);
      expect(pick(fromPlugin.find((agent) => agent.id === id))).toEqual({ ...want, permissions: [...rules.slice(0, start), ...later, ...own] });
    }

    const commands = async (project: string) => (await get<Array<{ name: string; description?: string }>>("/api/command", project)).filter((command) => !command.name.includes(":"));
    const ours = (list: Array<{ name: string; description?: string }>) => list.filter((command) => ["plan", "execute", "review", "progress", "onboard", "guide"].includes(command.name)).sort((a, b) => a.name.localeCompare(b.name));
    const pluginCommands = ours(await commands(projects.line));
    expect(pluginCommands.map((command) => command.name)).toEqual(["execute", "guide", "onboard", "plan", "progress", "review"]);
    expect(pluginCommands.map((command) => [command.name, command.description])).toEqual(ours(await commands(projects.files)).map((command) => [command.name, command.description]));

    type Skill = { id: string; name?: string; description?: string; autoinvoke?: boolean; content?: string; path?: string };
    const skills = async (project: string) =>
      (await get<Skill[]>("/api/skill", project)).filter((skill) => skill.id.startsWith(NAME)).sort((a, b) => a.id.localeCompare(b.id));
    const fileSkills = await skills(projects.files);
    const pluginSkills = await skills(projects.line);
    expect(fileSkills.map((skill) => skill.id)).toEqual([`${NAME}-guide`, `${NAME}-plan`]);
    const strip = ({ path: _path, ...rest }: Skill) => rest;
    expect(pluginSkills.map(strip)).toEqual(fileSkills.map(strip));
    for (const skill of pluginSkills) expect(skill.path).toBe(path.join(box, "home", ".local", "share", NAME, "dist", "opencode-v2", "skills", skill.id, "SKILL.md"));
  }, 120_000);

  test("with the files installed as well, the files win and the rest is the same", async () => {
    await active(projects.both);
    await Bun.sleep(4_000);
    const fromFiles = await withLead(projects.files);
    const both = await withLead(projects.both);
    expect(both[0]?.id).toBe("lead");
    expect(both.find((agent) => agent.id === "scout")?.steps).toBe(7);
    for (const id of ["lead", "builder", "reviewer"]) {
      const want = pick(fromFiles.find((agent) => agent.id === id))!;
      const got = pick(both.find((agent) => agent.id === id))!;
      // The plugin's rules come before the file's, so the list ends as it does from the file alone:
      // the file's own rules and whatever opencode adds after them.
      const own = embedded.agents.find((agent) => agent.id === id)!.permissions!;
      const rules = want.permissions!;
      const start = rules.findIndex((_, index) => JSON.stringify(rules.slice(index, index + own.length)) === JSON.stringify(own));
      expect(start).toBeGreaterThan(0);
      expect(got.permissions!.slice(-(rules.length - start))).toEqual(rules.slice(start));
      expect(got.permissions!.length).toBeGreaterThan(rules.length);
      expect({ ...got, permissions: undefined }).toEqual({ ...want, permissions: undefined });
    }
  }, 120_000);

  test("the agents' own rules win over the user's global permissions, whichever way the harness arrives", async () => {
    await active(projects.run);
    await Bun.sleep(4_000);
    await withLead(projects.runFiles);
    for (const [project, where] of [
      [projects.run, "line"],
      [projects.runFiles, "files"],
    ] as const) {
      // scout's own rules deny every shell command but a few read-only ones; the user allows all.
      expect(await touch(project, "scout", `scout-${where}`)).toEqual({ status: "error", exists: false });
      // builder sets no rule for `touch`: the user's rules decide, the allow and the narrower deny.
      expect(await touch(project, "builder", `builder-${where}`)).toEqual({ status: "completed", exists: true });
      expect(await touch(project, "builder", `user-denied-${where}`)).toEqual({ status: "error", exists: false });
    }
  }, 300_000);

  test("a project without the line in the same service has none of it", async () => {
    await active(projects.line);
    // A project the service has not seen yet can list a partial set of agents for a moment.
    const list = await within(30_000, "the agents of the project without the line", async () => {
      const found = await agents(projects.none);
      return found.some((agent) => agent.id === "build") ? found : undefined;
    });
    expect(list.map((agent) => agent.id)).not.toContain("lead");
    expect(list[0]?.id).toBe("build");
    // opencode has a /review of its own; the harness's commands are not there.
    const commands = await get<Array<{ name: string; description?: string }>>("/api/command", projects.none);
    expect(commands.map((command) => command.name)).not.toContain("plan");
    expect(commands.find((command) => command.name === "review")?.description).not.toContain("Independent review");
    const plugins = await get<Array<{ id?: string }>>("/api/plugin", projects.none);
    expect(plugins.map((plugin) => plugin.id)).not.toContain(NAME);
  }, 120_000);

  test("the RPC answers doctor and problems, and is unavailable where the plugin is not active", async () => {
    await active(projects.line);
    const doctor = await call<{ output?: Record<string, unknown> }>("POST", `/api/rpc/${NAME}/doctor`, projects.line, { input: {} });
    expect(doctor.status).toBe(200);
    expect(doctor.data.output).toMatchObject({ name: NAME, defaultAgent: "lead", leadLoaded: true, leadSource: "plugin", reviewLine: "Review policy: auto", problems: [] });
    const problems = await call<{ output?: unknown }>("POST", `/api/rpc/${NAME}/problems`, projects.line, { input: {} });
    expect(problems.data.output).toEqual({ problems: [] });
    const none = await call<{ type?: string }>("POST", `/api/rpc/${NAME}/doctor`, projects.none, { input: {} });
    expect(none.status).not.toBe(200);
    expect(none.data.type).toBe("rpc.unavailable");
  }, 120_000);

  test.skipIf(!npmAvailable)("the packed npm package, named in plugins, installs into the cache and brings the whole harness", async () => {
    // The package installs in the background the first time a request names the project.
    const plugin = await active(projects.packed, 240_000);
    expect(plugin.features?.tui).toBe(true);

    const cache = path.join(box, "home", ".cache", "opencode", "npm");
    const copies = installed(cache, pkg.name);
    expect(copies).toHaveLength(1);
    const copy = realpathSync(copies[0]!);
    expect(copy.startsWith(`${realpathSync(cache)}${path.sep}`)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(copy, "package.json"), "utf8")).version).toBe(pkg.version);
    expect(installed(root, pkg.name)).toEqual([]);
    expect(existsSync(path.join(projects.packed, "node_modules"))).toBe(false);

    await Bun.sleep(4_000);
    const fromFiles = await withLead(projects.files);
    const fromPackage = await agents(projects.packed);
    expect(fromPackage[0]?.id).toBe("lead");
    for (const id of AGENTS) {
      const want = pick(fromFiles.find((agent) => agent.id === id));
      expect(want?.system).toBeString();
      expect(pick(fromPackage.find((agent) => agent.id === id))).toEqual(want);
    }

    const commands = (await get<Array<{ name: string; description?: string }>>("/api/command", projects.packed)).filter((command) => !command.name.includes(":"));
    for (const name of ["plan", "execute", "progress", "onboard", "guide"]) expect(commands.map((command) => command.name)).toContain(name);
    expect(commands.find((command) => command.name === "review")?.description).toContain("Independent review");

    type Skill = { id: string; path?: string };
    const skills = (await get<Skill[]>("/api/skill", projects.packed)).filter((skill) => skill.id.startsWith(NAME)).sort((a, b) => a.id.localeCompare(b.id));
    expect(skills.map((skill) => skill.id)).toEqual([`${NAME}-guide`, `${NAME}-plan`]);
    for (const skill of skills) expect(skill.path).toBe(path.join(copy, "dist", "opencode-v2", "skills", skill.id, "SKILL.md"));

    const doctor = await call<{ output?: Record<string, unknown> }>("POST", `/api/rpc/${NAME}/doctor`, projects.packed, { input: {} });
    expect(doctor.status).toBe(200);
    expect(doctor.data.output).toMatchObject({ name: NAME, version: pkg.version, defaultAgent: "lead", leadLoaded: true, leadSource: "plugin", problems: [] });
  }, 300_000);

  test("/review, registered by the plugin, is answered by the reviewer in the user's session, and a later report wakes lead", async () => {
    await active(projects.run);
    await Bun.sleep(4_000);
    const session = (await call<{ id: string }>("POST", "/api/session", projects.run, { agent: "lead", location: { directory: projects.run } })).data;
    const sent = await call("POST", `/api/session/${session.id}/command`, projects.run, { name: "review", text: "main" });
    expect(sent.status).toBeLessThan(300);
    const review = await within(30_000, "the review", async () => model.seen.find((item) => item.agent === "reviewer"));
    // The reviewer sees only its brief: the command's text, without the subagent line of a child session.
    expect(review.users).toHaveLength(1);
    expect(review.users[0]).toStartWith("Review the target below");
    expect(review.users[0]).toContain("Target: main");
    await within(30_000, "the session to go back to lead", async () =>
      (await get<{ agent?: string }>(`/api/session/${session.id}`, projects.run)).agent === "lead" ? true : undefined,
    );
    const sessions = await get<Array<{ id: string; parentID?: string }>>("/api/session", projects.run);
    expect(sessions.filter((item) => item.parentID === session.id)).toEqual([]);
    const report = `<subagent sessionID="ses_fake" state="completed" description="fake">fake report</subagent>`;
    await call("POST", `/api/session/${session.id}/synthetic`, projects.run, { text: report });
    const woken = await within(60_000, "lead to be woken by the report", async () => model.seen.find((item) => item.agent === "lead" && item.users.at(-1) === report));
    expect(woken.users.some((user) => user.startsWith("Review the target below"))).toBe(true);
  }, 180_000);
});
