// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The evals' own opencode login, kept apart from the owner's opencode data.
//
// `make eval-login` (bun evals/login.ts) runs `opencode auth login` in a throwaway sandbox with
// OPENCODE_DB naming an eval-only database, so the login lands there and nowhere else. Each run
// then copies it into its sandboxed server: `opencode auth export` reads the eval database and
// its output goes straight into `opencode auth import --server <sandbox>` through a shell pipe.
// The runner starts that pipe but never reads, stores or prints what passes through it.
//
// Usage: bun evals/login.ts [--opencode BIN] [PROVIDER]

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { baseEnv, type Box, loginPlugins, opencodeVersion, resolveBinary, SANDBOX_SCRIPT } from "./project.ts";

/** The variable that names another eval login database. */
export const LOGIN_DB_VARIABLE = "ECMWF_MULTI_AGENTS_EVAL_LOGIN_DB";

/** The eval login database: $ECMWF_MULTI_AGENTS_EVAL_LOGIN_DB, else in the XDG data folder. */
export function evalLoginDb(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const named = env[LOGIN_DB_VARIABLE];
  if (named) return path.resolve(named);
  const data = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(data, "ecmwf-multi-agents", "eval-login.db");
}

/** The eval login database when it exists, else a message that says how to make it. */
export function checkEvalLogin(env: Record<string, string | undefined> = process.env, home = homedir()): { ok: true; path: string } | { ok: false; message: string } {
  const db = evalLoginDb(env, home);
  if (existsSync(db)) return { ok: true, path: db };
  return {
    ok: false,
    message: `no eval login: ${db} does not exist. Run \`make eval-login\` to log in for the evals (it never touches your own opencode login)${env[LOGIN_DB_VARIABLE] ? `, or point ${LOGIN_DB_VARIABLE} at an existing eval login` : ""}.`,
  };
}

// The pipe. The database and the server password arrive as variables and are moved into shell
// variables, so neither child sees the other's. Import's messages are dropped, because a
// malformed input could be echoed in them; export's messages carry no credential.
const PIPE = [
  'db=$EVAL_LOGIN_DB; password=$EVAL_SERVER_PASSWORD; unset EVAL_LOGIN_DB EVAL_SERVER_PASSWORD',
  'OPENCODE_DB=$db "$0" auth export --standalone | OPENCODE_PASSWORD=$password "$0" auth import --server "$1" 2>/dev/null',
  'echo "exit ${PIPESTATUS[0]} ${PIPESTATUS[1]}" >&2',
].join("\n");

let queue: Promise<unknown> = Promise.resolve();

/**
 * Copies the eval login into a running sandboxed server: `opencode auth export` from the eval
 * database, piped into `opencode auth import --server`. Runs one at a time, so two runs never
 * open the database together.
 */
export function importLogin(box: Box, bin: string, db: string, server: { url: string; password: string }, env: Record<string, string>): Promise<void> {
  const run = async () => {
    const scratch = path.join(box.dir, "login");
    mkdirSync(scratch, { recursive: true });
    const proc = Bun.spawn([SANDBOX_SCRIPT, scratch, "bash", "-c", PIPE, bin, server.url], {
      cwd: scratch,
      env: { ...env, EVAL_LOGIN_DB: db, EVAL_SERVER_PASSWORD: server.password },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout: 180_000,
    });
    const messages = await new Response(proc.stderr).text();
    await proc.exited;
    const status = /^exit (\d+) (\d+)$/m.exec(messages);
    const shown = messages.replace(/^exit \d+ \d+$/m, "").trim().slice(-2_000);
    if (!status) throw new Error(`copying the eval login into the sandbox did not finish (exit ${proc.exitCode ?? proc.signalCode})${shown ? `: ${shown}` : ""}`);
    if (status[1] !== "0") throw new Error(`opencode auth export from the eval login failed (exit ${status[1]})${shown ? `: ${shown}` : ""}. Run \`make eval-login\` again?`);
    if (status[2] !== "0") throw new Error(`opencode auth import into the sandbox failed (exit ${status[2]})`);
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** Environment for the interactive login: the owner's, without opencode's own variables. */
function loginEnv(db: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("OPENCODE")) env[name] = value;
  }
  return { ...env, ...baseEnv(), OPENCODE_DB: db };
}

async function main(argv: string[]): Promise<number> {
  let bin = "opencode";
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--opencode") bin = argv[++index] ?? "";
    else if (arg.startsWith("--opencode=")) bin = arg.slice("--opencode=".length);
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: bun evals/login.ts [--opencode BIN] [PROVIDER]\n\nLogs in for the evals, into an eval-only database; your own opencode login is never used or changed.");
      return 0;
    } else rest.push(arg);
  }
  const resolved = resolveBinary(bin);
  if (!resolved) {
    console.error(`Error: ${bin} not found; name an opencode 2 binary with --opencode (make eval-login OPENCODE_V2_BIN=...).`);
    return 1;
  }
  const version = opencodeVersion(resolved);
  if (!/^2\./.test(version)) {
    console.error(`Error: ${bin} reports version "${version}"; the evals need opencode 2.`);
    return 1;
  }
  const db = evalLoginDb();
  const existed = existsSync(db);
  mkdirSync(path.dirname(db), { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(path.join(tmpdir(), "ecmwf-eval-login-"));
  try {
    const plugins = loginPlugins();
    if (plugins.length > 0) {
      const config = path.join(scratch, "home", ".config", "opencode");
      mkdirSync(config, { recursive: true });
      writeFileSync(path.join(config, "opencode.json"), `${JSON.stringify({ plugins }, null, 2)}\n`);
    }
    console.log(`Logging in for the evals with opencode ${version}; the login is stored in ${db}.`);
    const env = loginEnv(db);
    const login = Bun.spawn([SANDBOX_SCRIPT, scratch, resolved, "auth", "login", "--standalone", ...rest], { cwd: scratch, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await login.exited;
    if (code !== 0) {
      // A failed first login leaves an empty database behind; without it, runs ask for a login.
      if (!existed) for (const file of [db, `${db}-wal`, `${db}-shm`]) rmSync(file, { force: true });
      return code;
    }
    console.log("\nThe eval login now holds:");
    const list = Bun.spawn([SANDBOX_SCRIPT, scratch, resolved, "auth", "list", "--standalone"], { cwd: scratch, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    return await list.exited;
  } finally {
    Bun.spawnSync(["chmod", "-R", "u+w", scratch]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
