// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Drives a sandboxed `opencode serve` (1.x) over its HTTP API. Routes, from the source at tag
// v1.18.35 (packages/opencode/src/server/routes/instance/httpapi/groups/):
//   POST /session                          create a session            (session.ts)
//   POST /session/:id/prompt_async         send a prompt, returns 204  (session.ts)
//   POST /session/:id/command              run a command; answers when the turn ends (session.ts)
//   POST /session/:id/abort                stop a session              (session.ts)
//   GET  /session/status                   busy and retrying sessions; idle ones are absent
//   GET  /session/:id/children             direct child sessions
//   GET  /session/:id/message              messages with their parts
//   GET  /permission, POST /permission/:id/reply {reply: once|always|reject}   (permission.ts)
//   GET  /question,   POST /question/:id/reply {answers: string[][]}           (question.ts)
//   GET  /event                            server-sent events {type, properties}  (event.ts)
// Every request carries ?directory=<project>, which selects the project instance.

import type { Box } from "./project.ts";
import { SANDBOX_SCRIPT } from "./project.ts";
import { answerQuestions, decidePermission } from "./policy.ts";
import { errorText, sessionAgent } from "./metrics.ts";
import type { AnsweringPolicy, ApiMessage, PermissionRecord, PermissionRequest, QuestionRecord, QuestionRequest, RunStatus, SessionData, Turn } from "./types.ts";

const usedPorts = new Set<number>();

/** A free port below the Linux ephemeral range (32768 and up), where binding may fail. */
export function pickPort(): number {
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    if (usedPorts.has(port)) continue;
    try {
      const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
      void probe.stop(true);
      usedPorts.add(port);
      return port;
    } catch {
      // In use: try another.
    }
  }
  throw new Error("no free port between 20000 and 32000");
}

export interface Server {
  url: string;
  port: number;
  output(): string;
  stop(): Promise<void>;
}

/** Running servers, so an interrupted runner can stop them. */
const liveServers = new Set<{ kill(signal?: number | NodeJS.Signals): void }>();

/** Stops every server still running; for signal handlers. */
export function killServers(): void {
  for (const proc of liveServers) proc.kill("SIGKILL");
  liveServers.clear();
}

/** Starts `opencode serve` inside the sandbox, from the project directory. */
export async function startServer(box: Box, bin: string, env: Record<string, string>, readyMs = 180_000): Promise<Server> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = pickPort();
    try {
      return await startOn(box, bin, env, port, readyMs);
    } catch (error) {
      lastError = error;
      usedPorts.delete(port);
      // Another process may have taken the port after the probe: try a different one.
      if (!/EADDRINUSE|address already in use/i.test(String(error))) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function startOn(box: Box, bin: string, env: Record<string, string>, port: number, readyMs: number): Promise<Server> {
  const proc = Bun.spawn([SANDBOX_SCRIPT, box.dir, bin, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: box.project,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  liveServers.add(proc);
  void proc.exited.then(() => liveServers.delete(proc));
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk);
      if (output.length > 200_000) output = output.slice(-100_000);
    }
  };
  void drain(proc.stdout);
  void drain(proc.stderr);
  const stop = async () => {
    if (proc.exitCode !== null) return;
    proc.kill();
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
    if (!exited) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    usedPorts.delete(port);
  };
  const deadline = Date.now() + readyMs;
  while (Date.now() < deadline) {
    const match = /listening on (http:\/\/\S+)/.exec(output);
    if (match) return { url: match[1]!, port, output: () => output, stop };
    if (proc.exitCode !== null) throw new Error(`opencode serve exited with ${proc.exitCode}:\n${output.slice(-4_000)}`);
    await Bun.sleep(100);
  }
  await stop();
  throw new Error(`opencode serve did not start within ${Math.round(readyMs / 1000)} s:\n${output.slice(-4_000)}`);
}

export class Api {
  constructor(
    readonly url: string,
    readonly directory: string,
  ) {}

  address(route: string): URL {
    const url = new URL(route, this.url);
    url.searchParams.set("directory", this.directory);
    return url;
  }

  /** A JSON request. timeoutMs false waits as long as the server takes (the command route). */
  async call<T>(method: string, route: string, body?: unknown, options: { timeoutMs?: number | false; signal?: AbortSignal } = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const signal = options.signal ?? (timeoutMs === false ? undefined : AbortSignal.timeout(timeoutMs));
    const response = await fetch(this.address(route), {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      // Bun's idle timeout (5 minutes by default) would cut a long command short.
      timeout: false,
    } as RequestInit);
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

export interface ServerEvent {
  type: string;
  properties: Record<string, unknown>;
}

/** Subscribes to GET /event until closed; calls onEvent for each event. */
export function subscribe(api: Api, onEvent: (event: ServerEvent) => void): { close(): void } {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(api.address("/event"), { signal: controller.signal, timeout: false } as RequestInit);
      if (!response.body) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          try {
            const event = JSON.parse(data) as ServerEvent;
            if (event && typeof event.type === "string") onEvent({ type: event.type, properties: event.properties ?? {} });
          } catch {
            // Not JSON: ignore.
          }
        }
      }
    } catch {
      // Closed or the server stopped.
    }
  })();
  return { close: () => controller.abort() };
}

/** Start of the error for providers or models the sandboxed server cannot use. */
export const UNAVAILABLE = "the sandbox cannot use";

/** Providers the server cannot use and models they do not offer (GET /config/providers). */
export async function unavailable(api: Api, providers: string[], models: string[]): Promise<string[]> {
  const result = await api.call<{ providers?: Array<{ id: string; models?: Record<string, unknown> }> }>("GET", "/config/providers");
  const usable = result.providers ?? [];
  const problems = providers.filter((id) => !usable.some((item) => item.id === id)).map((id) => `provider ${id}`);
  for (const model of models) {
    const slash = model.indexOf("/");
    const provider = usable.find((item) => item.id === model.slice(0, slash));
    if (provider?.models && !(model.slice(slash + 1) in provider.models)) problems.push(`model ${model}`);
  }
  return problems;
}

/** Root session and all its descendants, breadth first. */
export async function sessionTree(api: Api, root: string): Promise<string[]> {
  const seen = [root];
  for (let index = 0; index < seen.length; index++) {
    const children = await api.call<Array<{ id: string }>>("GET", `/session/${seen[index]}/children`).catch(() => []);
    for (const child of children) if (!seen.includes(child.id)) seen.push(child.id);
  }
  return seen;
}

/** Every session of the tree with its messages. */
export async function fetchSessions(api: Api, roots: string[]): Promise<SessionData[]> {
  const sessions: SessionData[] = [];
  for (const root of roots) {
    for (const id of await sessionTree(api, root)) {
      const info = await api.call<{ id: string; parentID?: string; title?: string }>("GET", `/session/${id}`).catch(() => ({ id }) as { id: string; parentID?: string; title?: string });
      const messages = await api.call<ApiMessage[]>("GET", `/session/${id}/message`).catch(() => []);
      sessions.push({ id, ...(info.parentID ? { parentID: info.parentID } : {}), ...(info.title ? { title: info.title } : {}), messages });
    }
  }
  return sessions;
}

export interface TurnContext {
  api: Api;
  sessionID: string;
  turn: Turn;
  /** Agent for the turn: lead for the harness, build for the baseline. */
  agent: string;
  /** Session model (provider/model) for commands, as the TUI sends it. */
  model?: string;
  policy: AnsweringPolicy;
  deadline: number;
  permissions: PermissionRecord[];
  questions: QuestionRecord[];
  /** Finish when the root session alone is idle, leaving background helpers running. */
  waitFor?: "tree" | "root";
  /** session.error events seen, per session. */
  errors: Map<string, string[]>;
  log?: (line: string) => void;
  /** Poll interval in milliseconds. */
  pollMs?: number;
}

export interface TurnResult {
  status: RunStatus;
  error?: string;
}

/**
 * Sends one turn and waits until the root session and all its descendants are idle (or the root
 * alone, with `waitFor: "root"`), answering permission requests and questions from the tree by
 * the policy on the way. On the deadline it aborts the sessions and reports a timeout.
 */
export async function driveTurn(ctx: TurnContext): Promise<TurnResult> {
  const { api, sessionID: root } = ctx;
  const pollMs = ctx.pollMs ?? 1_000;
  const agents = new Map<string, string>();
  const answered = new Set<string>();
  const agentOf = async (id: string) => {
    if (!agents.has(id)) {
      const messages = await api.call<ApiMessage[]>("GET", `/session/${id}/message`).catch(() => []);
      const agent = sessionAgent({ messages });
      if (agent !== "unknown") agents.set(id, agent);
      return agent;
    }
    return agents.get(id)!;
  };

  const sentAt = Date.now();
  let commandDone = true;
  let commandError: string | undefined;
  if (ctx.turn.kind === "prompt") {
    await api.call("POST", `/session/${root}/prompt_async`, { agent: ctx.agent, parts: [{ type: "text", text: ctx.turn.text }] });
  } else {
    commandDone = false;
    const payload: Record<string, unknown> = { command: ctx.turn.command, arguments: ctx.turn.arguments ?? "", agent: ctx.agent };
    if (ctx.model) payload.model = ctx.model;
    api
      .call("POST", `/session/${root}/command`, payload, { timeoutMs: false, signal: AbortSignal.timeout(Math.max(1_000, ctx.deadline - Date.now() + 60_000)) })
      .then(() => {
        commandDone = true;
      })
      .catch((error: unknown) => {
        commandDone = true;
        commandError = error instanceof Error ? error.message : String(error);
      });
  }

  let sawBusy = false;
  let idleStreak = 0;
  while (true) {
    if (Date.now() > ctx.deadline) {
      await abortTree(api, root);
      return { status: "timeout", error: "the turn did not finish within the time limit" };
    }
    const tree = await sessionTree(api, root);
    const inTree = new Set(tree);

    let pending = 0;
    const permissions = await api.call<PermissionRequest[]>("GET", "/permission").catch(() => []);
    for (const request of permissions) {
      if (!inTree.has(request.sessionID) || answered.has(request.id)) continue;
      pending++;
      const decision = decidePermission(ctx.policy, request);
      const agent = await agentOf(request.sessionID);
      await api.call("POST", `/permission/${request.id}/reply`, { reply: decision.reply }).catch((error: unknown) => ctx.log?.(`permission reply failed: ${String(error)}`));
      answered.add(request.id);
      ctx.permissions.push({
        id: request.id,
        sessionID: request.sessionID,
        agent,
        permission: request.permission,
        patterns: request.patterns,
        reply: decision.reply,
        reason: decision.reason,
        at: Date.now(),
      });
      ctx.log?.(`permission ${request.permission} [${request.patterns.join(", ")}] from ${agent}: ${decision.reply} (${decision.reason})`);
    }
    const questions = await api.call<QuestionRequest[]>("GET", "/question").catch(() => []);
    for (const request of questions) {
      if (!inTree.has(request.sessionID) || answered.has(request.id)) continue;
      pending++;
      const answers = answerQuestions(ctx.policy, request);
      const agent = await agentOf(request.sessionID);
      await api.call("POST", `/question/${request.id}/reply`, { answers }).catch((error: unknown) => ctx.log?.(`question reply failed: ${String(error)}`));
      answered.add(request.id);
      ctx.questions.push({
        id: request.id,
        sessionID: request.sessionID,
        agent,
        questions: request.questions.map((question) => ({ question: question.question, options: question.options.map((option) => option.label) })),
        answers,
        at: Date.now(),
      });
      ctx.log?.(`question from ${agent}: answered ${JSON.stringify(answers)}`);
    }

    const status = await api.call<Record<string, { type: string }>>("GET", "/session/status").catch(() => ({}) as Record<string, { type: string }>);
    const watched = ctx.waitFor === "root" ? [root] : tree;
    const busy = watched.some((id) => status[id] !== undefined && status[id]!.type !== "idle");
    if (busy) sawBusy = true;

    if (commandError !== undefined) return { status: "error", error: commandError };
    if (!busy && pending === 0 && commandDone) {
      const messages = await api.call<ApiMessage[]>("GET", `/session/${root}/message`).catch(() => []);
      const last = messages.at(-1);
      const answeredTurn =
        last !== undefined && last.info.role === "assistant" && (last.info.time?.created ?? 0) >= sentAt - 2_000 && last.info.time?.completed !== undefined;
      const failed = ctx.errors.get(root)?.length ?? 0;
      if (answeredTurn || failed > 0 || (sawBusy && last?.info.role === "assistant")) idleStreak++;
      else idleStreak = 0;
      if (idleStreak >= 2) {
        // A turn that ended on a provider or tool-loop error is reported as an error.
        const error = answeredTurn ? errorText(last!.info.error) : (ctx.errors.get(root)?.at(-1) ?? "");
        return error ? { status: "error", error } : { status: "completed" };
      }
      if (!sawBusy && !answeredTurn && Date.now() - sentAt > 120_000) return { status: "error", error: "the turn did not start" };
    } else {
      idleStreak = 0;
    }
    await Bun.sleep(pollMs);
  }
}

/** Aborts the root session and every descendant that is still busy, then waits briefly. */
export async function abortTree(api: Api, root: string): Promise<void> {
  const tree = await sessionTree(api, root).catch(() => [root]);
  for (const id of tree) await api.call("POST", `/session/${id}/abort`, {}).catch(() => undefined);
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const status = await api.call<Record<string, { type: string }>>("GET", "/session/status").catch(() => ({}) as Record<string, { type: string }>);
    if (!tree.some((id) => status[id] !== undefined && status[id]!.type !== "idle")) return;
    await Bun.sleep(500);
  }
}
