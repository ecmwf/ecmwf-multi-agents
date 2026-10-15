// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Drives a sandboxed `opencode serve` (opencode 2) over its HTTP API. Routes, from the source
// at tag v2.0.29 (packages/protocol/src/groups/):
//   GET  /api/info, /api/location, /api/plugin, /api/agent, /api/command   readiness
//   GET  /api/provider, /api/model                     what the sandbox can use
//   POST /api/session {agent, location}                create a session            (session.ts)
//   POST /api/session/:id/prompt {text}                send a prompt; returns at once
//   POST /api/session/:id/command {name, text}         run a command; 204 at once
//   POST /api/session/:id/agent {agent}                switch the session's agent
//   POST /api/session/:id/interrupt                    stop a session
//   GET  /api/session/active                           busy sessions; idle ones are absent
//   GET  /api/session/:id/inbox                        inputs queued for a session
//   GET  /api/session?parentID=, /api/session/:id      child sessions, one session's totals
//   GET  /api/session/:id/message                      messages, paged      (message.ts)
//   GET  /api/permission/request, POST /api/session/:sid/permission/:id/reply {decision}
//   GET  /api/form, POST /api/session/:sid/form/:id/reply {answer}             (form.ts)
//   GET  /api/event                                    server-sent events {type, data}
// Every request carries the server password (basic auth, user "opencode"); every reply wraps
// its result in {data}. Routes that depend on the project take ?location[directory]=<project>.

import { randomBytes } from "node:crypto";
import type { Box } from "./project.ts";
import { SANDBOX_SCRIPT } from "./project.ts";
import { adaptMessages, isAborted, type V2Error, type V2Message } from "./messages.ts";
import { errorText } from "./metrics.ts";
import { answerQuestions, decidePermission, formAnswer, formQuestions } from "./policy.ts";
import type { AnsweringPolicy, FormRequest, PermissionRecord, PermissionRequest, QuestionRecord, RunStatus, SessionData, Turn } from "./types.ts";

export interface Server {
  url: string;
  password: string;
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

/**
 * Starts `opencode serve --stdio` inside the sandbox, from the project directory, with a fresh
 * password. The server prints {"url": ...} on its first line and stops when its input closes.
 */
export async function startServer(box: Box, bin: string, env: Record<string, string>, readyMs = 180_000): Promise<Server> {
  const password = randomBytes(24).toString("hex");
  const proc = Bun.spawn([SANDBOX_SCRIPT, box.dir, bin, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: box.project,
    env: { ...env, OPENCODE_PASSWORD: password },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  liveServers.add(proc);
  void proc.exited.then(() => liveServers.delete(proc));
  let output = "";
  let url: string | undefined;
  const append = (text: string) => {
    output += text;
    if (output.length > 200_000) output = output.slice(-100_000);
  };
  const drain = async (stream: ReadableStream<Uint8Array>, first: boolean) => {
    const decoder = new TextDecoder();
    let line = "";
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      if (first && url === undefined) {
        line += text;
        const end = line.indexOf("\n");
        if (end === -1) continue;
        try {
          const ready = JSON.parse(line.slice(0, end)) as { url?: unknown };
          if (typeof ready.url === "string") url = ready.url;
        } catch {
          append(line.slice(0, end + 1));
        }
        append(line.slice(end + 1));
        line = "";
        first = false;
        continue;
      }
      append(text);
    }
  };
  void drain(proc.stdout, true);
  void drain(proc.stderr, false);
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const waitExit = (ms: number) => Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
    try {
      await proc.stdin.end();
    } catch {
      // Already closed.
    }
    if (await waitExit(10_000)) return;
    proc.kill("SIGTERM");
    if (await waitExit(5_000)) return;
    proc.kill("SIGKILL");
    await proc.exited;
  };
  const deadline = Date.now() + readyMs;
  while (Date.now() < deadline) {
    if (url !== undefined) return { url, password, output: () => output, stop };
    if (proc.exitCode !== null) throw new Error(`opencode serve exited with ${proc.exitCode}:\n${output.slice(-4_000)}`);
    await Bun.sleep(50);
  }
  await stop();
  throw new Error(`opencode serve did not start within ${Math.round(readyMs / 1000)} s:\n${output.slice(-4_000)}`);
}

export class Api {
  readonly authorization: string;
  constructor(
    readonly url: string,
    password: string,
    readonly directory: string,
  ) {
    this.authorization = `Basic ${btoa(`opencode:${password}`)}`;
  }

  /** The route's URL; with `located`, for the project (?location[directory]=). */
  address(route: string, located = false): URL {
    const url = new URL(route, this.url);
    if (located) url.searchParams.set("location[directory]", this.directory);
    return url;
  }

  /** A JSON request; the reply's body, or undefined for 204. */
  async call<T>(method: string, route: string, body?: unknown, options: { timeoutMs?: number; located?: boolean } = {}): Promise<T> {
    const response = await fetch(this.address(route, options.located), {
      method,
      headers: { authorization: this.authorization, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** The `data` of a JSON reply. */
  async data<T>(method: string, route: string, body?: unknown, options: { timeoutMs?: number; located?: boolean } = {}): Promise<T> {
    return (await this.call<{ data: T }>(method, route, body, options)).data;
  }
}

export interface ServerEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Subscribes to GET /api/event until closed; calls onEvent for each event. */
export function subscribe(api: Api, onEvent: (event: ServerEvent) => void): { close(): void } {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(api.address("/api/event"), { headers: { authorization: api.authorization }, signal: controller.signal, timeout: false } as RequestInit);
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
            const event = JSON.parse(data) as { type?: unknown; data?: unknown };
            if (event && typeof event.type === "string") onEvent({ type: event.type, data: (event.data ?? {}) as Record<string, unknown> });
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

export interface ExecutionEnd {
  outcome: "succeeded" | "failed" | "interrupted";
  at: number;
  error?: string;
}

/** How each session's executions ended, from session.execution.* events. */
export class Executions {
  readonly ends = new Map<string, ExecutionEnd[]>();

  record(event: ServerEvent): void {
    const outcome = /^session\.execution\.(succeeded|failed|interrupted)$/.exec(event.type)?.[1] as ExecutionEnd["outcome"] | undefined;
    const sessionID = event.data.sessionID;
    if (!outcome || typeof sessionID !== "string") return;
    const error = event.data.error as V2Error | undefined;
    const end: ExecutionEnd = { outcome, at: Date.now(), ...(outcome === "failed" && error && !isAborted(error) ? { error: errorText(error) || "session error" } : {}) };
    const list = this.ends.get(sessionID) ?? [];
    list.push(end);
    this.ends.set(sessionID, list);
  }

  since(sessionID: string, time: number): ExecutionEnd[] {
    return (this.ends.get(sessionID) ?? []).filter((end) => end.at >= time);
  }
}

/** Start of the error for providers or models the sandboxed server cannot use. */
export const UNAVAILABLE = "the sandbox cannot use";

/** Providers the server cannot use and models they do not offer (GET /api/provider, /api/model). */
export async function unavailable(api: Api, providers: string[], models: string[]): Promise<string[]> {
  const usable = await api.data<Array<{ id: string }>>("GET", "/api/provider", undefined, { located: true });
  const offered = await api.data<Array<{ id: string; providerID: string }>>("GET", "/api/model", undefined, { located: true });
  const problems = providers.filter((id) => !usable.some((item) => item.id === id)).map((id) => `provider ${id}`);
  for (const model of models) {
    const slash = model.indexOf("/");
    const provider = model.slice(0, slash);
    if (!usable.some((item) => item.id === provider)) continue;
    if (!offered.some((item) => item.providerID === provider && item.id === model.slice(slash + 1))) problems.push(`model ${model}`);
  }
  return problems;
}

interface AgentInfo {
  id: string;
  model?: { id?: string; providerID?: string };
}

/**
 * Waits until the server serves the project with everything loaded: the harness plugin active
 * and lead's model as the profile sets it (none for a profile that inherits), or, without the
 * harness, the build agent.
 */
export async function waitReady(api: Api, expect: { harness: boolean; leadModel?: string }, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      await api.call("GET", "/api/info", undefined, { timeoutMs: 5_000 });
      await api.call("GET", "/api/location", undefined, { located: true });
      const agents = await api.data<AgentInfo[]>("GET", "/api/agent", undefined, { located: true });
      if (!expect.harness) {
        if (agents.some((agent) => agent.id === "build")) return;
        last = "the build agent is not loaded";
      } else {
        const plugins = await api.data<Array<{ id: string; state?: { status?: string; error?: unknown } }>>("GET", "/api/plugin", undefined, { located: true });
        const ours = plugins.find((plugin) => plugin.id === "ecmwf-multi-agents");
        if (ours?.state?.status === "failed") throw new Error(`the harness plugin failed to load: ${JSON.stringify(ours.state.error ?? "").slice(0, 500)}`);
        const lead = agents.find((agent) => agent.id === "lead");
        const model = lead?.model?.providerID && lead.model.id ? `${lead.model.providerID}/${lead.model.id}` : undefined;
        if (ours?.state?.status === "active" && lead && model === expect.leadModel) return;
        last = !ours ? "the harness plugin is not loaded" : ours.state?.status !== "active" ? `the harness plugin is ${ours.state?.status ?? "loading"}` : !lead ? "lead is not loaded" : `lead's model is ${model ?? "unset"}`;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("the harness plugin failed")) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(200);
  }
  throw new Error(`opencode did not get ready within ${Math.round(timeoutMs / 1000)} s: ${last}`);
}

/** Direct child sessions. */
async function children(api: Api, id: string): Promise<string[]> {
  const list = await api.data<Array<{ id: string }>>("GET", `/api/session?parentID=${encodeURIComponent(id)}&limit=200`).catch(() => []);
  return list.map((item) => item.id);
}

/** Root session and all its descendants, breadth first. */
export async function sessionTree(api: Api, root: string): Promise<string[]> {
  const seen = [root];
  for (let index = 0; index < seen.length; index++) {
    for (const child of await children(api, seen[index]!)) if (!seen.includes(child)) seen.push(child);
  }
  return seen;
}

const PAGE = 200;

/** Every message of a session, oldest first. */
export async function listMessages(api: Api, id: string): Promise<V2Message[]> {
  const messages: V2Message[] = [];
  let route = `/api/session/${id}/message?order=asc&limit=${PAGE}`;
  for (let page = 0; page < 1_000; page++) {
    const result = await api.call<{ data: V2Message[]; cursor?: { next?: string } }>("GET", route);
    messages.push(...result.data);
    if (result.data.length < PAGE || !result.cursor?.next) break;
    route = `/api/session/${id}/message?cursor=${encodeURIComponent(result.cursor.next)}&limit=${PAGE}`;
  }
  return messages;
}

/** The newest messages of a session, newest first. */
async function newestMessages(api: Api, id: string, limit = 5): Promise<V2Message[]> {
  return api.data<V2Message[]>("GET", `/api/session/${id}/message?order=desc&limit=${limit}`).catch(() => []);
}

interface SessionInfo {
  id: string;
  parentID?: string;
  title?: string;
  agent?: string;
  cost?: number;
  tokens?: SessionData["tokens"];
}

/** One session with its messages in the shape the metrics read, and opencode's totals. */
export async function fetchSession(api: Api, id: string): Promise<SessionData> {
  const info = await api.data<SessionInfo>("GET", `/api/session/${id}`).catch(() => ({ id }) as SessionInfo);
  const messages = adaptMessages(id, await listMessages(api, id).catch(() => []), info.agent);
  return {
    id,
    ...(info.parentID ? { parentID: info.parentID } : {}),
    ...(info.title ? { title: info.title } : {}),
    ...(info.agent ? { agent: info.agent } : {}),
    ...(typeof info.cost === "number" ? { cost: info.cost } : {}),
    ...(info.tokens ? { tokens: info.tokens } : {}),
    messages,
  };
}

/** Every session of the trees, roots first. */
export async function fetchSessions(api: Api, roots: string[]): Promise<SessionData[]> {
  const sessions: SessionData[] = [];
  for (const root of roots) {
    for (const id of await sessionTree(api, root)) sessions.push(await fetchSession(api, id));
  }
  return sessions;
}

/** Creates a root session for the project with the given agent. */
export async function createSession(api: Api, agent: string): Promise<string> {
  return (await api.data<{ id: string }>("POST", "/api/session", { agent, location: { directory: api.directory } })).id;
}

export interface TurnContext {
  api: Api;
  sessionID: string;
  turn: Turn;
  /** Agent for the turn: lead for the harness, build for the baseline. */
  agent: string;
  policy: AnsweringPolicy;
  deadline: number;
  permissions: PermissionRecord[];
  questions: QuestionRecord[];
  /** Finish when the root session alone is idle, leaving background helpers running. */
  waitFor?: "tree" | "root";
  executions: Executions;
  log?: (line: string) => void;
  /** Poll interval in milliseconds. */
  pollMs?: number;
}

export interface TurnResult {
  status: RunStatus;
  error?: string;
}

/**
 * Sends one turn and waits until it is over: the root session's newest message is an idle
 * marker newer than the turn (or the turn was stopped by a refused permission), nothing in the
 * session tree is busy (only the root with `waitFor: "root"`) and nothing waits for an answer,
 * twice in a row, because a background completion briefly makes the root busy again. Permission
 * requests and forms are answered by the policy on the way. On the deadline it interrupts the
 * sessions and reports a timeout.
 */
export async function driveTurn(ctx: TurnContext): Promise<TurnResult> {
  const { api, sessionID: root } = ctx;
  const pollMs = ctx.pollMs ?? 1_000;
  const agents = new Map<string, string>();
  const answered = new Set<string>();
  const agentOf = async (id: string) => {
    if (!agents.has(id)) {
      const info = await api.data<{ agent?: string }>("GET", `/api/session/${id}`).catch(() => ({}) as { agent?: string });
      if (info.agent) agents.set(id, info.agent);
    }
    return agents.get(id) ?? "unknown";
  };

  if ((await agentOf(root)) !== ctx.agent) {
    await api.call("POST", `/api/session/${root}/agent`, { agent: ctx.agent });
    agents.set(root, ctx.agent);
  }
  // Messages newer than this one belong to the turn; ids sort by time.
  let marker = (await newestMessages(api, root, 1))[0]?.id ?? "";
  const sentAt = Date.now();
  if (ctx.turn.kind === "prompt") {
    const sent = await api.data<{ id?: string }>("POST", `/api/session/${root}/prompt`, { text: ctx.turn.text });
    if (sent?.id && sent.id > marker) marker = sent.id;
  } else {
    await api.call("POST", `/api/session/${root}/command`, { name: ctx.turn.command, text: ctx.turn.arguments ?? "" });
  }

  let sawBusy = false;
  let idleStreak = 0;
  while (true) {
    if (Date.now() > ctx.deadline) {
      await interruptTree(api, root);
      return { status: "timeout", error: "the turn did not finish within the time limit" };
    }
    const tree = await sessionTree(api, root);
    const watched = new Set(ctx.waitFor === "root" ? [root] : tree);

    // Every request of the sandbox is answered, so a helper of an earlier session never waits;
    // only those of the watched sessions keep the turn open.
    let pending = 0;
    const permissions = await api.data<PermissionRequest[]>("GET", "/api/permission/request", undefined, { located: true }).catch(() => []);
    for (const request of permissions) {
      if (answered.has(request.id)) continue;
      if (watched.has(request.sessionID)) pending++;
      const decision = decidePermission(ctx.policy, request);
      const agent = await agentOf(request.sessionID);
      await api
        .call("POST", `/api/session/${request.sessionID}/permission/${request.id}/reply`, { decision: decision.reply })
        .catch((error: unknown) => ctx.log?.(`permission reply failed: ${String(error)}`));
      answered.add(request.id);
      ctx.permissions.push({
        id: request.id,
        sessionID: request.sessionID,
        agent,
        action: request.action,
        resources: request.resources,
        reply: decision.reply,
        reason: decision.reason,
        at: Date.now(),
      });
      ctx.log?.(`permission ${request.action} [${request.resources.join(", ")}] from ${agent}: ${decision.reply} (${decision.reason})`);
    }
    const forms = await api.data<FormRequest[]>("GET", "/api/form", undefined, { located: true }).catch(() => []);
    for (const form of forms) {
      if (answered.has(form.id)) continue;
      if (watched.has(form.sessionID)) pending++;
      const questions = formQuestions(form);
      const answers = answerQuestions(ctx.policy, questions);
      const agent = await agentOf(form.sessionID);
      await api
        .call("POST", `/api/session/${form.sessionID}/form/${form.id}/reply`, { answer: formAnswer(form, answers) })
        .catch((error: unknown) => ctx.log?.(`form reply failed: ${String(error)}`));
      answered.add(form.id);
      ctx.questions.push({
        id: form.id,
        sessionID: form.sessionID,
        agent,
        questions: questions.questions.map((question) => ({ question: question.question, options: question.options.map((option) => option.label) })),
        answers,
        at: Date.now(),
      });
      ctx.log?.(`question from ${agent}: answered ${JSON.stringify(answers)}`);
    }

    const active = await api.data<Record<string, unknown>>("GET", "/api/session/active").catch(() => ({}) as Record<string, unknown>);
    // A completion queued for the root wakes it next, so the root counts as busy until then.
    const queued = await api.data<unknown[]>("GET", `/api/session/${root}/inbox`).catch(() => []);
    const busy = queued.length > 0 || [...watched].some((id) => id in active);
    if (busy) sawBusy = true;

    if (!busy && pending === 0) {
      const newest = (await newestMessages(api, root, 1))[0];
      const fresh = newest !== undefined && newest.id > marker;
      const idle = fresh && newest.type === "idle" ? newest : undefined;
      // A plain refusal stops the turn without an idle marker: its last step ends as aborted.
      const stopped = fresh && newest.type === "assistant" && isAborted(newest.error);
      if (idle || stopped) idleStreak++;
      else idleStreak = 0;
      if (idleStreak >= 2) {
        const failures = ctx.executions.since(root, sentAt).filter((end) => end.error !== undefined);
        if (idle?.outcome === "failed") return { status: "error", error: (idle.error && !isAborted(idle.error) ? errorText(idle.error) : "") || failures.at(-1)?.error || "the turn failed" };
        if (failures.length > 0) return { status: "error", error: failures.at(-1)!.error! };
        return { status: "completed" };
      }
      if (!sawBusy && !fresh && Date.now() - sentAt > 120_000) return { status: "error", error: "the turn did not start" };
    } else {
      idleStreak = 0;
    }
    await Bun.sleep(pollMs);
  }
}

/** Interrupts the root session and every descendant that is still busy, then waits briefly. */
export async function interruptTree(api: Api, root: string): Promise<void> {
  const tree = await sessionTree(api, root).catch(() => [root]);
  for (const id of tree) await api.call("POST", `/api/session/${id}/interrupt`, {}).catch(() => undefined);
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const active = await api.data<Record<string, unknown>>("GET", "/api/session/active").catch(() => ({}) as Record<string, unknown>);
    if (!tree.some((id) => id in active)) return;
    await Bun.sleep(500);
  }
}
