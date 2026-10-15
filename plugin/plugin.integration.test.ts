// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Opt-in check that the bundled plugin works in real opencode binaries. Runs only when
// ECMWF_MULTI_AGENTS_INTEGRATION=1. Binary: OPENCODE_V2_BIN (default "opencode2"). Sandboxes go
// under the system temporary directory (set TMPDIR to move them).
//
// The binary gets a fresh sandbox (tools/sandbox.sh): the emitter output and the bundled plugin
// in the sandbox config directory, settings files written per scenario, and a git project.
// opencode is read back with `opencode serve` and its HTTP API, as in
// tools/emit-v2.integration.test.ts. No model is contacted.
//
// The binary must also still hold the notes opencode adds to continue a cut-off reply, word for
// word, since answer-first.ts recognizes them by their text.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PLUGIN_DIR, pluginFiles } from "../tools/bundle-plugin.ts";
import { V2_VERSION, emitV2 } from "../tools/emit-v2.ts";
import type { OutputFile } from "../tools/types.ts";
import { V2_CONTINUE_NOTES } from "./answer-first.ts";
import { resolvedFixture } from "./testing.ts";

const enabled = process.env.ECMWF_MULTI_AGENTS_INTEGRATION === "1";
const v2Bin = process.env.OPENCODE_V2_BIN ?? "opencode2";
const root = path.resolve(import.meta.dir, "..");
const sandboxScript = path.join(root, "tools", "sandbox.sh");
const SETTINGS = "ecmwf-multi-agents.jsonc";
const PLUGIN = PLUGIN_DIR;
const PARKED = "ecmwf-multi-agents.off";

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

function makeSandbox(files: OutputFile[], plugin: OutputFile[]): Sandbox {
  // opencode reports canonical paths, so resolve symbolic links in the temporary directory.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "plugin-")));
  const project = path.join(dir, "project");
  mkdirSync(path.join(project, ".opencode"), { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: project });
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
  const config = path.join(dir, "home", ".config", "opencode");
  writeAll(config, files);
  writeAll(config, plugin);
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

/** The texts among `texts` that a file holds, read in chunks: the opencode executable is large. */
function textsIn(file: string, texts: readonly string[]): string[] {
  const wanted = texts.map((text) => ({ text, bytes: Buffer.from(text) }));
  const overlap = Math.max(...wanted.map((item) => item.bytes.length)) - 1;
  const found = new Set<string>();
  const fd = openSync(file, "r");
  try {
    const chunk = Buffer.alloc(8 << 20);
    let carry = Buffer.alloc(0);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const window = Buffer.concat([carry, chunk.subarray(0, read)]);
      for (const item of wanted) if (window.includes(item.bytes)) found.add(item.text);
      if (found.size === wanted.length) break;
      carry = Buffer.from(window.subarray(Math.max(0, window.length - overlap)));
    }
  } finally {
    closeSync(fd);
  }
  return texts.filter((text) => found.has(text));
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

// ---------------------------------------------------------------------------------------------
// opencode 2 (V2_VERSION)

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
    box = makeSandbox(emitV2(harness), await pluginFiles(root, harness));
    const version = Bun.spawnSync([sandboxScript, box.dir, v2Bin, "--version"], { cwd: box.project });
    expect(version.stdout.toString()).toContain(V2_VERSION);
  }, 60_000);

  afterAll(async () => {
    await stop();
    if (box) rmSync(box.dir, { recursive: true, force: true });
  });

  test("the executable still holds, word for word, the notes opencode adds to continue a cut-off reply", () => {
    // OPENCODE_V2_BIN may be a name on the PATH or a link, as node_modules/.bin/opencode is.
    const executable = realpathSync(Bun.which(v2Bin) ?? v2Bin);
    expect(statSync(executable).size).toBeGreaterThan(10 << 20);
    expect(textsIn(executable, V2_CONTINUE_NOTES)).toEqual([...V2_CONTINUE_NOTES]);
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
