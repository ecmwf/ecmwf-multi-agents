// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Opt-in check, with a real opencode 2, of the central install for shared machines: install.sh
// --central writes a read-only folder from the real dist/, and a sandboxed private server
// (`serve --stdio`) with OPENCODE_CONFIG naming the folder's opencode.json has the whole harness
// in a project that has nothing of its own. Runs only when ECMWF_MULTI_AGENTS_INTEGRATION=1.
// Binary: OPENCODE_V2_BIN (default "opencode2"). No model is called.
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
  const projects = { plain: "", own: "" };

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
    projects.plain = gitProject(path.join(box, "plain"));
    projects.own = gitProject(path.join(box, "own"));
    write(path.join(projects.own, ".opencode", `${NAME}.jsonc`), '{ "review": "always" }\n');
    write(path.join(projects.own, ".opencode", "agents", "scout.md"), "---\nsteps: 9\n---\n\nThe project's scout.\n");

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
    if (box) {
      Bun.spawnSync(["chmod", "-R", "u+w", box]);
      rmSync(box, { recursive: true, force: true });
    }
  });

  test("the agents come from the central config, with the harness's prompts, rules and settings", async () => {
    const report = await doctor(projects.plain);
    expect(report).toMatchObject({ defaultAgent: "lead", leadLoaded: true, leadSource: "plugin", reviewLine: "Review policy: never" });
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
      // The config's rules, in order, after the plugin's copy of them; opencode adds its own after.
      const rules = got?.permissions ?? [];
      const runs = rules.flatMap((_, index) => (JSON.stringify(rules.slice(index, index + want.permissions.length)) === JSON.stringify(want.permissions) ? [index] : []));
      expect(runs.length).toBeGreaterThanOrEqual(1);
      expect(rules.length - (runs.at(-1)! + want.permissions.length)).toBeLessThan(5);
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
    expect(checked.out).toContain("OK    lead is loaded from the central install, with the plugin");
    expect(checked.out).toContain("OK    lead's Review policy: never");
    expect(checked.out).toContain("OK    lead is the default agent");
    expect(asUser(["sh", INSTALL, "central-disable"], projects.plain).code).toBe(0);
    expect(asUser(["opencode", "service", "get", "env", "OPENCODE_CONFIG"], projects.plain).out.trim()).toBe("");
  }, 180_000);

  test("nothing was written into the central folder", () => {
    expect(snapshot(central)).toEqual(before);
  });
});
