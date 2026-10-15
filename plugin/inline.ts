// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// `/review` and `/progress` answered in the user's own session.
//
// The generated command files run a helper's command in a child session (`subagent: true`), and
// lead then takes a turn to relay the report. Answering in the user's session instead costs a
// quarter less, but a native command that does so switches the session to the helper for good and
// shows it the whole conversation (core/src/config/plugin/command.ts:124-134 at v2.0.29). So the
// plugin registers its own `review` and `progress` again after each activation, behind the file
// commands and its own first registration (register.ts, which runs them in a child session), and
// a later `add` of the same name replaces an earlier one (core/src/command.ts:61). Without the
// plugin the command files run them in a child session.
//
// A run: wait until the session is idle (`session.wait` follows runs that start meanwhile), note
// the owner's agent and model, switch the session to the helper (and to the helper's own model,
// since a session runs on its own model, runner/model.ts:75-90), send the command's text, wait
// for the helper to finish, then switch back. `execute` returns at once and the run goes on in the
// background, because opencode answers the command's HTTP call only when `execute` returns.
//
// The `context` session hook keeps the helper to its brief: it drops everything before the brief,
// and leaves out the reports of background helpers (`<subagent ...>`) that arrive meanwhile, so
// the helper does not act on them. It leaves out the user's own messages after the brief too: the
// TUI sends a message typed during a run with delivery `steer`, so it joins the helper's turn
// (tui/src/component/prompt/index.tsx:1092 at v2.0.29), but it is meant for lead. They stay in
// the session, and lead sees them on its next turn; when any were held, one queued message wakes
// lead once the run has ended, to answer the user first.
//
// Between the helper's end and the switch back (about 16 ms) a report or a message can start a run
// that is still the helper's. Such a stray request is treated the same way, the owner is restored
// at once and lead is woken.

import { INLINE_USER_AND_REPORTS_WAKE_TEXT, INLINE_USER_WAKE_TEXT, INLINE_WAKE_TEXT, V2_REPORT_PREFIX, firstText, stepsV2 } from "./answer-first.ts";
import { remember } from "./helpers.ts";
import { fillTemplate, parseModel, unwrap } from "./register.ts";
import type { Reporter } from "./report.ts";
import type { SessionTracker } from "./tools-v2.ts";
import type {
  EmbeddedHarness,
  EmbeddedCommand,
  V2CommandDefinition,
  V2CommandInvocation,
  V2Context,
  V2ContextEvent,
  V2ModelMessage,
  V2ModelRef,
} from "./types.ts";

/** A harness command whose agent is a helper: the command a helper answers inline. */
export type InlineCommand = EmbeddedCommand & { agent: string };

/** The harness's commands that a helper answers: review and progress. */
export function inlineCommands(harness: EmbeddedHarness, helpers: ReadonlySet<string>): InlineCommand[] {
  return harness.commands.filter((command): command is InlineCommand => command.agent !== undefined && helpers.has(command.agent));
}

/** The metadata key that marks a helper's brief; its value is the command's name. */
export const INLINE_MARK = "ecmwf-multi-agents.inline";
/** What a helper reads when the only news in its request was a report or a message held back from it. */
export const HELD_NOTE = "A message for lead arrived and was held back for it. Your answer above stands: reply only with the word done.";

const isReport = (message: V2ModelMessage | undefined): boolean => message?.role === "user" && firstText(message).startsWith(V2_REPORT_PREFIX);

const USER_WAKES = [INLINE_USER_WAKE_TEXT, INLINE_USER_AND_REPORTS_WAKE_TEXT];

/**
 * A message the user wrote: a request to lead in answer-first's terms, which opencode built from
 * a user message, the only kind that carries metadata (core/src/session/runner/to-llm-message.ts
 * at v2.0.29). Notes opencode or a plugin adds (synthetic messages) carry none: a continue note,
 * a note that work moved to the background, a helper's own shell result.
 */
export function isUserMessage(message: V2ModelMessage | undefined): boolean {
  if (message?.role !== "user" || message.metadata === null || typeof message.metadata !== "object") return false;
  if (USER_WAKES.some((wake) => firstText(message).startsWith(wake))) return false;
  return stepsV2([message])[0] === "request";
}

/** How a held message is counted: by message id, so a message seen in several requests counts once. */
export function messageKey(message: V2ModelMessage): string {
  return typeof message.id === "string" && message.id !== "" ? message.id : `text:${firstText(message)}`;
}

/** The position of the helper's brief: the last user message with the mark, or with exactly this text. */
export function briefIndex(messages: readonly V2ModelMessage[], brief: string | undefined): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.metadata?.[INLINE_MARK] === "string") return index;
    if (brief !== undefined && firstText(message) === brief) return index;
  }
  return -1;
}

/** The keys of the messages left out of a helper's request, for lead. */
export interface HeldMessages {
  reports: string[];
  /** The user's own messages after the brief. */
  user: string[];
}

/**
 * Keep a helper's request to its brief: drop the messages before it and leave out the reports
 * and, after the brief, the user's own messages. When those were the only thing after the
 * helper's own last answer, a short note asks it to end, so the request does not end with an
 * assistant message. Changes `messages` in place, because opencode sends that array, and returns
 * the keys of the messages left out. Without a brief the user's messages stay: nothing tells
 * which came after it.
 */
export function isolateHelperRequest(messages: V2ModelMessage[], brief: string | undefined): HeldMessages {
  const start = briefIndex(messages, brief);
  if (start > 0) messages.splice(0, start);
  const kinds = messages.map((message, index) => (isReport(message) ? "reports" : start >= 0 && index > 0 && isUserMessage(message) ? "user" : undefined));
  let tail = messages.length;
  while (tail > 0 && kinds[tail - 1] !== undefined) tail--;
  const answeredBefore = tail < messages.length && messages[tail - 1]?.role === "assistant";
  const held: HeldMessages = { reports: [], user: [] };
  for (let index = messages.length - 1; index >= 0; index--) {
    const kind = kinds[index];
    if (kind === undefined) continue;
    held[kind].unshift(messageKey(messages[index]!));
    messages.splice(index, 1);
  }
  if (answeredBefore) messages.push({ role: "user", content: [{ type: "text", text: HELD_NOTE }] });
  return held;
}

/** One command run in a session, from the switch to the helper until the switch back. */
export interface InlineRun {
  command: string;
  helper: string;
  owner: string;
  ownerModel?: V2ModelRef;
  /** True once the session was switched to the helper's own model. */
  switchedModel: boolean;
  brief: string;
  /** The reports held back from the helper. */
  held: Set<string>;
  /** The user's messages held back from the helper. */
  heldUser: Set<string>;
}

/** What the plugin knows about inline runs, by session. */
export class InlineRuns {
  private readonly active = new Map<string, InlineRun>();
  /** Sessions that had a run: their owner and the last brief, for a stray request after it. */
  private readonly past = new Map<string, InlineRun>();
  /** Messages a wake was queued for, by session. */
  private readonly woken = new Map<string, Set<string>>();

  start(session: string, run: InlineRun): void {
    this.active.set(session, run);
  }

  get(session: string | undefined): InlineRun | undefined {
    return session === undefined ? undefined : this.active.get(session);
  }

  /** End the session's run; it stays known for stray requests. */
  finish(session: string): InlineRun | undefined {
    const run = this.active.get(session);
    this.active.delete(session);
    if (run !== undefined) remember(this.past, session, run);
    return run;
  }

  last(session: string | undefined): InlineRun | undefined {
    return session === undefined ? undefined : this.past.get(session);
  }

  /** The messages no wake was queued for yet, marked as woken now. */
  claim(session: string, keys: Iterable<string>): string[] {
    const woken = this.woken.get(session) ?? new Set<string>();
    const fresh = [...new Set(keys)].filter((key) => !woken.has(key));
    for (const key of fresh) woken.add(key);
    remember(this.woken, session, woken);
    return fresh;
  }
}

/**
 * What a helper's request in a session is to the plugin:
 * - inline: the helper answers a command run in this session.
 * - stray: a run of the helper's that no command started, in a session that had an inline run.
 * - leave: anything else, such as a helper in its own child session.
 */
export type HelperRequest = "inline" | "stray" | "leave";

export function classifyHelperRequest(agent: string | undefined, run: InlineRun | undefined, hadRun: boolean, root: boolean, helpers: ReadonlySet<string>): HelperRequest {
  if (agent === undefined || !helpers.has(agent) || !root) return "leave";
  if (run !== undefined) return run.helper === agent ? "inline" : "leave";
  return hadRun ? "stray" : "leave";
}

function isModel(value: unknown): value is V2ModelRef {
  const model = value as V2ModelRef | undefined;
  return typeof model?.id === "string" && typeof model.providerID === "string";
}

const sameModel = (a: V2ModelRef | undefined, b: V2ModelRef | undefined) => a?.id === b?.id && a?.providerID === b?.providerID && a?.variant === b?.variant;

export interface InlineDeps {
  harness: EmbeddedHarness;
  ctx: V2Context;
  tracker: SessionTracker;
  helpers: ReadonlySet<string>;
  reporter: Reporter;
  /** The model the settings and profile give an agent, if any. */
  plannedModel: (agent: string) => V2ModelRef | undefined;
}

/** Inline runs of the helpers' commands: the commands to register and the context hook's part. */
export class Inline {
  readonly runs = new InlineRuns();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly roots = new Map<string, boolean>();

  constructor(private readonly deps: InlineDeps) {}

  /** True when every session call a run needs is there. */
  available(): boolean {
    const session = this.deps.ctx.session;
    return [session?.get, session?.prompt, session?.switchAgent, session?.wait].every((call) => typeof call === "function");
  }

  commands(): V2CommandDefinition[] {
    return inlineCommands(this.deps.harness, this.deps.helpers).map((command) => ({
      name: command.name,
      ...(command.description === undefined ? {} : { description: command.description }),
      execute: async (invocation) => {
        // Returning first lets opencode answer the command's HTTP call; runs in a session go one by one.
        const sessionID = invocation?.sessionID;
        if (typeof sessionID !== "string") return;
        const previous = this.chains.get(sessionID) ?? Promise.resolve();
        const next = previous.then(() => this.run(command, invocation)).catch((error: unknown) => this.deps.reporter.internal(`the /${command.name} command`, error));
        remember(this.chains, sessionID, next);
      },
    }));
  }

  private async modelOf(agent: string): Promise<V2ModelRef | undefined> {
    try {
      const info = unwrap<{ model?: unknown }>(await this.deps.ctx.agent.get?.({ agentID: agent }));
      if (isModel(info?.model)) return info.model;
    } catch {
      // The settings and profile below are what the plugin applied to the agent anyway.
    }
    return this.deps.plannedModel(agent);
  }

  /** The model a session without one of its own runs on; switching back to it is the nearest to no model. */
  private async defaultModel(): Promise<V2ModelRef | undefined> {
    try {
      const model = unwrap<{ id?: unknown; providerID?: unknown }>(await this.deps.ctx.model?.default?.());
      return isModel(model) ? { id: model.id, providerID: model.providerID } : undefined;
    } catch {
      return undefined;
    }
  }

  private async idle(sessionID: string): Promise<void> {
    const session = this.deps.ctx.session!;
    // `wait` returns at once when the session is idle; a run that starts just after it returns
    // shows in the tracker, and is waited for too.
    for (let round = 0; round < 10; round++) {
      await session.wait!({ sessionID });
      if (this.deps.tracker.get(sessionID)?.state !== "running") return;
    }
  }

  async run(command: InlineCommand, invocation: V2CommandInvocation): Promise<void> {
    const session = this.deps.ctx.session!;
    const sessionID = invocation.sessionID;
    await this.idle(sessionID);
    const info = unwrap<{ agent?: string; model?: unknown }>(await session.get!({ sessionID }));
    const before = this.runs.last(sessionID);
    // A session left on a helper (a switch back that failed) belongs to the owner noted before.
    const onHelper = typeof info?.agent === "string" && this.deps.helpers.has(info.agent);
    const owner = !onHelper && typeof info?.agent === "string" ? info.agent : (before?.owner ?? this.deps.harness.defaultAgent);
    const ownerModel = onHelper ? before?.ownerModel : isModel(info?.model) ? info.model : undefined;
    const helperModel = (command.model === undefined ? undefined : parseModel(command.model)) ?? (await this.modelOf(command.agent));
    const brief = fillTemplate(command.template, typeof invocation.prompt?.text === "string" ? invocation.prompt.text : "");
    const run: InlineRun = { command: command.name, helper: command.agent, owner, ownerModel, switchedModel: false, brief, held: new Set(), heldUser: new Set() };
    this.runs.start(sessionID, run);
    try {
      await session.switchAgent!({ sessionID, agent: command.agent });
      if (helperModel !== undefined && !sameModel(helperModel, ownerModel) && typeof session.switchModel === "function") {
        run.switchedModel = true;
        await session.switchModel({ sessionID, model: helperModel });
      }
      await session.prompt!({ ...invocation.prompt, sessionID, text: brief, metadata: { [INLINE_MARK]: command.name }, delivery: "steer" });
      await session.wait!({ sessionID });
    } finally {
      this.runs.finish(sessionID);
      await this.restore(sessionID, run);
      await this.wake(sessionID, { reports: [...run.held], user: [...run.heldUser] });
    }
  }

  private async restore(sessionID: string, run: InlineRun): Promise<void> {
    const session = this.deps.ctx.session!;
    try {
      await session.switchAgent!({ sessionID, agent: run.owner });
      if (run.switchedModel) {
        const model = run.ownerModel ?? (await this.defaultModel()) ?? (await this.modelOf(run.owner));
        if (model !== undefined) await session.switchModel!({ sessionID, model });
        else this.deps.reporter.internal("switching back", new Error(`no model to give ${run.owner} back in session ${sessionID}`));
      }
    } catch (error) {
      this.deps.reporter.internal("switching back after a command", error);
    }
  }

  /** One wake for what was held: to answer the user first when the user wrote, else to act on the reports. */
  private async wake(sessionID: string, held: HeldMessages): Promise<void> {
    const reports = this.runs.claim(sessionID, held.reports).length > 0;
    const user = this.runs.claim(sessionID, held.user).length > 0;
    if (!reports && !user) return;
    const text = !user ? INLINE_WAKE_TEXT : reports ? INLINE_USER_AND_REPORTS_WAKE_TEXT : INLINE_USER_WAKE_TEXT;
    const description = user ? "Message held while a helper answered" : "Reports held while a helper answered";
    try {
      await this.deps.ctx.session?.synthetic?.({ sessionID, text, description, delivery: "queue" });
    } catch (error) {
      this.deps.reporter.internal("waking lead after a command", error);
    }
  }

  private async isRoot(sessionID: string): Promise<boolean> {
    const tracked = this.deps.tracker.get(sessionID);
    if (tracked?.parentID !== undefined) return false;
    const known = this.roots.get(sessionID);
    if (known !== undefined) return known;
    const info = unwrap<{ parentID?: unknown }>(await this.deps.ctx.session?.get?.({ sessionID }));
    if (info === undefined) return false;
    const root = typeof info.parentID !== "string";
    remember(this.roots, sessionID, root);
    return root;
  }

  /**
   * The context hook's part for a helper's request. Returns true when it handled the request:
   * the request is then the helper's alone, and answer-first does not apply.
   */
  async context(event: V2ContextEvent): Promise<boolean> {
    const sessionID = event.sessionID;
    const agent = event.agent;
    if (typeof sessionID !== "string" || typeof agent !== "string" || !this.deps.helpers.has(agent) || !Array.isArray(event.messages)) return false;
    const run = this.runs.get(sessionID);
    const before = this.runs.last(sessionID);
    if (run === undefined && before === undefined) return false;
    const kind = classifyHelperRequest(agent, run, before !== undefined, await this.isRoot(sessionID), this.deps.helpers);
    if (kind === "leave") return false;
    if (kind === "inline") {
      const held = isolateHelperRequest(event.messages, run!.brief);
      for (const key of held.reports) run!.held.add(key);
      for (const key of held.user) run!.heldUser.add(key);
      return true;
    }
    const held = isolateHelperRequest(event.messages, (run ?? before)!.brief);
    const owner = (run ?? before)!;
    // Not awaited: the request goes on as the helper's, and the switch applies from the next one.
    void this.restore(sessionID, owner).then(() => this.wake(sessionID, held));
    return true;
  }
}
