// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// One eval run: a fresh sandbox and project, the harness or the baseline configuration, a
// sandboxed opencode 2 server with the eval login copied in, the case's turns answered by
// policy, then metrics and checks.

import path from "node:path";
import { runChecks } from "./checks.ts";
import { aggregate, finalText, transcript } from "./metrics.ts";
import { checkEvalLogin, importLogin, LOGIN_DB_VARIABLE } from "./login.ts";
import { Api, createSession, driveTurn, Executions, fetchSession, fetchSessions, startServer, subscribe, UNAVAILABLE, unavailable, waitReady } from "./opencode.ts";
import { policyFor } from "./policy.ts";
import {
  applySetup,
  baseEnv,
  type Box,
  changedBetween,
  createBox,
  exec,
  HIDDEN,
  installHarness,
  linkOpencode,
  listProjectFiles,
  opencodeConfig,
  type Profile,
  profileProviders,
  projectDiff,
  readProjectFile,
  REPO,
  removeBox,
  sandboxParentProblem,
  sandboxPath,
  snapshot,
  writeConfig,
} from "./project.ts";
import type { CheckContext, EvalCase, Metrics, PermissionRecord, QuestionRecord, RunRecord, RunStatus, SessionData, TurnRecord, Variant } from "./types.ts";

export interface RunOptions {
  variant: Variant;
  repeat: number;
  profile: Profile;
  /** Path of an opencode 2 binary. */
  opencode: string;
  opencodeVersion: string;
  /** Time limit for each turn. */
  timeoutMs: number;
  /** The sandbox login: the eval login database (login.ts), or none (stand-in models). */
  auth: { kind: "login"; db: string } | { kind: "none" };
  /** opencode.json keys set over the generated ones (stand-in providers in tests). */
  config?: Record<string, unknown>;
  /** Extra environment for opencode. */
  env?: Record<string, string>;
  /** Extra opencode plugins (see loginPlugins in project.ts). */
  plugins?: string[];
  /** How long to wait for the profile's providers after the login is copied in. */
  providersMs?: number;
  repo?: string;
  hidden?: string;
  fixture?: string;
  /** Keep the sandbox afterwards (tests and debugging). */
  keep?: boolean;
  pollMs?: number;
  log?: (line: string) => void;
}

export const MAIN_AGENT: Record<Variant, string> = { harness: "lead", baseline: "build" };

function emptyMetrics(mainAgent: string): Metrics {
  return {
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    requests: 0,
    mainAgent,
    mainPeakContext: 0,
    agents: {},
    childSessions: {},
    toolCalls: [],
    errors: [],
    sessionCost: 0,
    sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export async function runCase(item: EvalCase, options: RunOptions): Promise<RunRecord & { sandbox?: string }> {
  const started = new Date();
  const mainAgent = MAIN_AGENT[options.variant];
  const review = item.review ?? "auto";
  const policy = policyFor(item.answering);
  const log = options.log ?? (() => undefined);
  const record: RunRecord & { sandbox?: string } = {
    case: item.id,
    title: item.title,
    variant: options.variant,
    repeat: options.repeat,
    profile: options.profile.name,
    review,
    opencode: { bin: options.opencode, version: options.opencodeVersion },
    started: started.toISOString(),
    durationMs: 0,
    status: "completed",
    pass: false,
    turns: [],
    rootSessions: [],
    metrics: emptyMetrics(mainAgent),
    permissions: [],
    questions: [],
    changedFiles: [],
    diff: "",
    checks: [],
    transcript: [],
  };
  const permissions: PermissionRecord[] = [];
  const questions: QuestionRecord[] = [];
  let box: Box | undefined;
  try {
    box = createBox(options.fixture);
    const unsafe = sandboxParentProblem(path.dirname(box.dir));
    if (unsafe !== undefined) throw new Error(unsafe);
    const project = box.project;
    const head = applySetup(box, item.setup);
    const before = snapshot(project);

    // The run's binary, linked into the sandbox as `opencode` and first on PATH, so install.sh
    // and every command the agents run find this one.
    const opencode = linkOpencode(box, options.opencode);
    if (options.variant === "harness") installHarness(box, options.profile.name, review, options.repo ?? REPO);
    const config = opencodeConfig(options.variant, options.profile, options.config, options.plugins);
    writeConfig(box, config);

    const env = baseEnv({ PATH: sandboxPath(box), OPENCODE_DISABLE_LSP_DOWNLOAD: "1", ...item.env, ...options.env });
    let sessions: SessionData[] = [];
    let failure: unknown;
    log("starting opencode");
    const server = await startServer(box, opencode, env);
    const executions = new Executions();
    const api = new Api(server.url, server.password, project);
    const events = subscribe(api, (event) => executions.record(event));
    try {
      await waitReady(api, { harness: options.variant === "harness", ...(options.profile.agents.lead?.model ? { leadModel: options.profile.agents.lead.model } : {}) });
      if (options.auth.kind === "login") {
        const login = checkEvalLogin({ [LOGIN_DB_VARIABLE]: options.auth.db });
        if (!login.ok) throw new Error(login.message);
        log("copying the eval login into the sandbox");
        await importLogin(box, opencode, options.auth.db, server, baseEnv({ PATH: sandboxPath(box) }));
      }
      // Fail fast, with a clear message, when the sandbox cannot reach the profile's models.
      const providers = profileProviders(options.profile);
      const models = (options.variant === "harness" ? Object.values(options.profile.agents) : [options.profile.agents.lead ?? {}]).flatMap((agent) => (agent.model ? [agent.model] : []));
      let problems: string[] = [];
      const until = Date.now() + (options.providersMs ?? 30_000);
      do {
        problems = await unavailable(api, providers, models);
        if (problems.length === 0) break;
        await Bun.sleep(500);
      } while (Date.now() < until);
      if (problems.length > 0) {
        throw new Error(
          `${UNAVAILABLE} ${problems.join(", ")}. Check that the eval login has it (make eval-login); if that login needs an opencode plugin, name it in ECMWF_MULTI_AGENTS_EVAL_PLUGINS (see evals/README.md).`,
        );
      }
      let current: string | undefined;
      let stopped = false;
      const answers: string[] = [];
      for (const step of item.turns) {
        const turnRecord: TurnRecord = { turn: step.turn, ...(step.note ? { note: step.note } : {}), skipped: true };
        record.turns.push(turnRecord);
        if (stopped) continue;
        if (step.when && !step.when({ project, answers, readFile: (rel) => readProjectFile(project, rel), listFiles: (rel) => listProjectFiles(project, rel) })) continue;
        if (step.newSession || current === undefined) {
          current = await createSession(api, mainAgent);
          record.rootSessions.push(current);
        }
        turnRecord.skipped = false;
        turnRecord.sessionID = current;
        turnRecord.agent = mainAgent;
        const label = step.turn.kind === "prompt" ? "prompt" : `/${step.turn.command}`;
        log(`turn ${record.turns.length}: ${label}`);
        const turnStart = Date.now();
        const result = await driveTurn({
          api,
          sessionID: current,
          turn: step.turn,
          agent: mainAgent,
          policy,
          deadline: turnStart + options.timeoutMs,
          permissions,
          questions,
          executions,
          log,
          ...(options.pollMs ? { pollMs: options.pollMs } : {}),
          ...(step.waitFor ? { waitFor: step.waitFor } : {}),
        });
        turnRecord.durationMs = Date.now() - turnStart;
        turnRecord.status = result.status;
        if (result.error) turnRecord.error = result.error;
        turnRecord.answer = finalText(await fetchSession(api, current));
        answers.push(turnRecord.answer);
        log(`turn ${record.turns.length}: ${result.status} after ${Math.round(turnRecord.durationMs / 1000)} s`);
        if (result.status !== "completed") {
          record.status = result.status;
          record.error = result.error;
          stopped = true;
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      // Fetched even after a failure, so the cost of a broken run is still counted.
      sessions = await fetchSessions(api, record.rootSessions).catch(() => []);
      events.close();
      await server.stop();
    }

    record.permissions = permissions;
    record.questions = questions;
    record.metrics = aggregate(sessions, record.rootSessions, mainAgent, permissions, questions);
    record.transcript = transcript(sessions);
    record.changedFiles = changedBetween(before, snapshot(project));
    if (failure !== undefined) throw failure;

    const answers = record.turns.filter((turn) => !turn.skipped).map((turn) => turn.answer ?? "");
    const ctx: CheckContext = {
      variant: options.variant,
      project,
      setup: { head, ...(box.remote ? { remote: box.remote } : {}) },
      answer: answers.at(-1) ?? "",
      answers,
      reports: sessions.map((session) => ({ agent: record.transcript.find((item) => item.id === session.id)?.agent ?? "unknown", sessionID: session.id, text: finalText(session) })),
      sessions,
      rootSessions: record.rootSessions,
      changedFiles: record.changedFiles,
      metrics: record.metrics,
      permissions,
      questions,
      readFile: (rel) => readProjectFile(project, rel),
      listFiles: (rel) => listProjectFiles(project, rel),
      exec: (argv, execOptions) => exec(argv, { cwd: execOptions?.cwd ?? project, ...(execOptions?.env ? { env: execOptions.env } : {}) }),
      hiddenTests: (caseId) => path.join(options.hidden ?? HIDDEN, caseId),
    };
    record.checks = runChecks(item.checks, ctx);
    record.diff = projectDiff(project, head);
    record.pass = record.status === "completed" && record.checks.every((check) => check.pass || check.recordOnly);
  } catch (error) {
    record.status = "error" satisfies RunStatus;
    record.error = error instanceof Error ? error.message : String(error);
    record.pass = false;
    log(`error: ${record.error}`);
  } finally {
    record.durationMs = Date.now() - started.getTime();
    if (box) {
      if (options.keep) record.sandbox = box.dir;
      else removeBox(box);
    }
  }
  return record;
}
