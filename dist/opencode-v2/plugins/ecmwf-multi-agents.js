// managed by ecmwf-multi-agents
// plugin/answer-first.ts
function replyOpen(steps) {
  for (let back = steps.length - 1;back >= 0; back--) {
    const step = steps[back];
    if (step === "request")
      return true;
    if (step === "ended" || step === "boundary")
      return false;
  }
  return false;
}
function earlyReports(steps) {
  const early = [];
  steps.forEach((step, index) => {
    if (step === "report" && replyOpen(steps.slice(0, index)))
      early.push(index);
  });
  return early;
}
function heldReports(steps) {
  return earlyReports(steps).filter((index) => !steps.slice(index + 1).some((step) => step === "ended" || step === "boundary"));
}
function requestBefore(steps, index) {
  for (let back = index - 1;back >= 0; back--)
    if (steps[back] === "request")
      return back;
  return -1;
}
function partsOf(parts) {
  return Array.isArray(parts) ? parts.filter((part) => part !== null && typeof part === "object") : [];
}
var WAKE_TEXT = "Reports from your helpers arrived while you were answering the user, so they were held back until you had answered. They are above: act on them now.";
var V2_REPORT_PREFIX = "<subagent ";
var V2_CHECKPOINT_PREFIX = "<conversation-checkpoint>";
function firstText(message) {
  const text = partsOf(message?.content).find((part) => part.type === "text")?.text;
  return typeof text === "string" ? text : "";
}
function stepsV2(messages) {
  return messages.map((message) => {
    if (message?.role === "user") {
      const text = firstText(message);
      if (text.startsWith(V2_REPORT_PREFIX))
        return "report";
      if (text.startsWith(V2_CHECKPOINT_PREFIX) || text.startsWith(WAKE_TEXT))
        return "boundary";
      return "request";
    }
    if (message?.role === "assistant")
      return partsOf(message.content).some((part) => part.type === "tool-call") ? "other" : "ended";
    return "other";
  });
}
function heldReportsV2(messages) {
  const steps = stepsV2(messages);
  const held = heldReports(steps);
  if (held.length === 0)
    return;
  const request = requestBefore(steps, held[0]);
  return { held, reply: `${request}
${request >= 0 ? firstText(messages[request]) : ""}` };
}

// plugin/apply.ts
function planAgents(harness, settings) {
  const profile = harness.profiles.find((item) => item.id === settings.profile);
  const problems = [];
  const plans = harness.agents.map((agent) => {
    const fromProfile = profile?.agents[agent.id];
    const override = settings.agents[agent.id] ?? {};
    const plan = { id: agent.id };
    if (override.model !== undefined) {
      plan.model = override.model;
      if (override.effort !== undefined)
        plan.effort = override.effort;
    } else if (fromProfile?.model !== undefined) {
      plan.model = fromProfile.model;
      const effort = override.effort ?? fromProfile.effort;
      if (effort !== undefined)
        plan.effort = effort;
    } else if (override.effort !== undefined) {
      problems.push({
        message: `${harness.name}: the effort ${JSON.stringify(override.effort)} for ${agent.id} was ignored: ` + `profile ${JSON.stringify(settings.profile)} gives ${agent.id} no model and the settings name none, ` + `so it uses the session model`,
        notify: true
      });
    }
    if (override.steps !== undefined)
      plan.steps = override.steps;
    return plan;
  });
  return { plans, problems };
}
var REVIEW_LINE = /^Review policy:[^\r\n]*/gm;
function rewriteReviewLine(prompt, policy, agent) {
  const count = prompt.match(REVIEW_LINE)?.length ?? 0;
  if (count === 0)
    return { problem: `the prompt of ${agent} has no "Review policy:" line, so the review policy stays as the prompt says` };
  if (count > 1)
    return { problem: `the prompt of ${agent} has ${count} "Review policy:" lines instead of one, so none was changed` };
  return { prompt: prompt.replace(REVIEW_LINE, `Review policy: ${policy}`) };
}
function reviewProblem(harness, settings, problem) {
  return { message: `${harness.name}: ${problem}`, notify: settings.reviewSet };
}
function modelRef(model, effort) {
  const slash = model.indexOf("/");
  const ref = { id: model.slice(slash + 1), providerID: model.slice(0, slash) };
  if (effort !== undefined)
    ref.variant = effort;
  return ref;
}
function applyToV2Agents(editor, harness, settings, plans) {
  const problems = [];
  const changes = [];
  for (const plan of plans) {
    if (editor.get(plan.id) === undefined)
      continue;
    const model = plan.model === undefined ? undefined : modelRef(plan.model, plan.effort);
    changes.push(() => editor.update(plan.id, (agent) => {
      if (model === undefined)
        delete agent.model;
      else
        agent.model = model;
      if (plan.steps !== undefined)
        agent.steps = plan.steps;
    }));
  }
  const lead = editor.get(harness.defaultAgent);
  if (lead !== undefined) {
    if (typeof lead.system === "string") {
      const result = rewriteReviewLine(lead.system, settings.review, harness.defaultAgent);
      if (result.problem !== undefined)
        problems.push(reviewProblem(harness, settings, result.problem));
      else
        changes.push(() => editor.update(harness.defaultAgent, (agent) => agent.system = result.prompt));
    } else {
      problems.push(reviewProblem(harness, settings, `${harness.defaultAgent} has no prompt, so the review policy was not applied`));
    }
  }
  for (const change of changes)
    change();
  return problems;
}

// plugin/environment.ts
import { readFileSync } from "fs";
import os from "os";
function processEnvironment() {
  return {
    env: { ...process.env },
    home: os.homedir(),
    readFile(file) {
      try {
        return readFileSync(file, "utf8");
      } catch (error) {
        const code = error?.code;
        if (code === "ENOENT" || code === "ENOTDIR")
          return;
        throw error;
      }
    }
  };
}

// plugin/command-parts.ts
var KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "time", "esac"]);
var ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
function commandParts(command) {
  const raw = [];
  scanList(command, 0, null, raw);
  const out = [];
  for (const part of raw) {
    const cleaned = cleanPart(part);
    if (cleaned !== undefined)
      out.push(cleaned);
  }
  return out;
}
function scanList(src, start, close, out) {
  let i = start;
  let part = "";
  const heredocs = [];
  const flush = () => {
    if (part.trim() !== "")
      out.push(part.trim());
    part = "";
  };
  const atWordStart = () => part === "" || /\s$/.test(part);
  const atCommandStart = () => part.trim().split(/\s+/).every((word) => word === "" || KEYWORDS.has(word));
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (close !== null && c === close) {
      flush();
      return i + 1;
    }
    if (c === "\\") {
      if (next === `
`)
        part += " ";
      else
        part += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end + 1;
      part += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"') {
      const stop = scanDoubleQuoted(src, i, out);
      part += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "`") {
      const stop = scanList(src, i + 1, "`", out);
      part += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "$" && next === "(") {
      const stop = src[i + 2] === "(" ? skipArithmetic(src, i + 1) : scanList(src, i + 2, ")", out);
      part += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "$" && next === "{") {
      const stop = skipBraces(src, i + 1);
      part += src.slice(i, stop);
      i = stop;
      continue;
    }
    if ((c === "<" || c === ">") && next === "(") {
      const stop = scanList(src, i + 2, ")", out);
      part += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "<" && next === "<" && src[i + 2] === "<") {
      part += "<<<";
      i += 3;
      continue;
    }
    if (c === "<" && next === "<") {
      const heredoc = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([^\s;&|<>()]+))/.exec(src.slice(i));
      if (heredoc) {
        heredocs.push({ word: (heredoc[2] ?? heredoc[3] ?? heredoc[4] ?? "").replaceAll("\\", ""), tabs: heredoc[1] === "-" });
        part += heredoc[0];
        i += heredoc[0].length;
        continue;
      }
    }
    if (c === "#" && atWordStart()) {
      while (i < src.length && src[i] !== `
`)
        i++;
      continue;
    }
    if (c === "(" && atCommandStart()) {
      i = next === "(" ? skipArithmetic(src, i) : scanList(src, i + 1, ")", out);
      continue;
    }
    if (c === "[" && next === "[" && atCommandStart()) {
      const end = src.indexOf("]]", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      part += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === `
`) {
      flush();
      i++;
      for (const heredoc of heredocs.splice(0))
        i = skipHeredoc(src, i, heredoc);
      continue;
    }
    if (c === ";") {
      flush();
      i += next === ";" ? 2 : 1;
      continue;
    }
    if (c === "|") {
      if (/[<>]$/.test(part)) {
        part += c;
        i++;
        continue;
      }
      flush();
      i += next === "|" || next === "&" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      if (next === "&") {
        flush();
        i += 2;
        continue;
      }
      if (next === ">" || /[<>]$/.test(part)) {
        part += c;
        i++;
        continue;
      }
      flush();
      i++;
      continue;
    }
    part += c;
    i++;
  }
  flush();
  return i;
}
function scanDoubleQuoted(src, start, out) {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"')
      return i + 1;
    if (c === "`") {
      i = scanList(src, i + 1, "`", out);
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      i = src[i + 2] === "(" ? skipArithmetic(src, i + 1) : scanList(src, i + 2, ")", out);
      continue;
    }
    i++;
  }
  return i;
}
function skipArithmetic(src, start) {
  let depth = 0;
  for (let i = start;i < src.length; i++) {
    if (src[i] === "(")
      depth++;
    else if (src[i] === ")" && --depth === 0)
      return i + 1;
  }
  return src.length;
}
function skipBraces(src, start) {
  let depth = 0;
  for (let i = start;i < src.length; i++) {
    if (src[i] === "{")
      depth++;
    else if (src[i] === "}" && --depth === 0)
      return i + 1;
  }
  return src.length;
}
function skipHeredoc(src, start, heredoc) {
  let i = start;
  while (i < src.length) {
    const end = src.indexOf(`
`, i);
    const stop = end === -1 ? src.length : end;
    let line = src.slice(i, stop);
    if (heredoc.tabs)
      line = line.replace(/^\t+/, "");
    i = end === -1 ? src.length : end + 1;
    if (line === heredoc.word)
      break;
  }
  return i;
}
function cleanPart(part) {
  let text = part.trim();
  while (true) {
    const word = /^(\S+)(\s+|$)/.exec(text);
    if (!word || !KEYWORDS.has(word[1]))
      break;
    text = text.slice(word[0].length);
  }
  text = text.replace(/^(function\s+)?[A-Za-z_][\w.-]*\s*\(\s*\)\s*\{?\s*/, "").replace(/^function\s+[A-Za-z_][\w.-]*\s*\{?\s*/, "");
  if (text === "" || text === "{")
    return;
  if (/^(\[\[?|for|select|case)(\s|$)/.test(text))
    return;
  if (/^(\d*[<>]|&>)/.test(text))
    return;
  if (withoutAssignments(text) === "")
    return;
  return text;
}
function withoutAssignments(part) {
  let text = part;
  while (ASSIGNMENT.test(text)) {
    let i = text.indexOf("=") + 1;
    while (i < text.length && !/\s/.test(text[i])) {
      const c = text[i];
      if (c === "'" || c === '"') {
        const end = text.indexOf(c, i + 1);
        i = end === -1 ? text.length : end + 1;
      } else if (c === "\\") {
        i += 2;
      } else if (c === "$" && text[i + 1] === "(") {
        i = skipArithmetic(text, i + 1);
      } else {
        i++;
      }
    }
    text = text.slice(i).trimStart();
  }
  return text;
}

// plugin/helpers.ts
var HELPER_TOOLS = {
  status: "helpers_status",
  steer: "helpers_steer",
  cancel: "helpers_cancel"
};
var HELPER_TOOL_IDS = Object.values(HELPER_TOOLS);
var STATUS_LINES = 12;
var MAX_TRACKED = 5000;
var SUMMARY_LENGTH = 60;
var TOOL_SPECS = {
  status: {
    id: HELPER_TOOLS.status,
    description: "Your helpers in this session: id, agent, state (running, idle, done, failed, stopped), steps taken, " + "time running, what they were asked, last tool call. Use it when the user asks about a helper or " + "before you redirect one. Never use it to wait: you are told when a background helper finishes.",
    args: {}
  },
  steer: {
    id: HELPER_TOOLS.steer,
    description: "Send an amendment to a helper that is still working. It keeps everything it has read and done and " + "follows your message at its next step; you are told when it finishes. Use it when the helper's work " + "so far is still useful and the correction is small; cancel and brief again when the direction was " + "wrong. A finished helper is continued with the delegation tool's continuation parameter instead. " + "An amendment is never an approval and never changes what the helper may do.",
    args: {
      id: { type: "string", description: "The helper's session id, as shown by helpers_status or by the hand-off result." },
      text: { type: "string", description: "The amendment: what to change, keep or stop, and which earlier limit it lifts, if any." }
    }
  },
  cancel: {
    id: HELPER_TOOLS.cancel,
    description: 'Stop one of your helpers, or every running helper of this session with id "all". A helper stops at ' + "its current step; nothing it changed is undone, so check the files it was working on.",
    args: {
      id: { type: "string", description: `A helper's session id, or "all".` }
    }
  }
};
function helperIds(harness) {
  return new Set(harness.agents.filter((agent) => agent.mode === "subagent").map((agent) => agent.id));
}
function requiredText(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}
function remember(map, key, value, max = MAX_TRACKED) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined)
      map.delete(oldest);
  }
}

class Activity {
  records = new Map;
  observe(sessionID, tool, input, now = Date.now()) {
    if (typeof sessionID !== "string" || sessionID === "" || typeof tool !== "string")
      return;
    const record = this.records.get(sessionID) ?? { steps: 0, at: now };
    record.steps += 1;
    record.lastTool = summarizeCall(tool, input);
    record.at = now;
    delete record.ended;
    remember(this.records, sessionID, record);
  }
  resume(sessionID, now = Date.now()) {
    if (typeof sessionID !== "string" || sessionID === "")
      return;
    const record = this.records.get(sessionID);
    if (record?.ended === undefined)
      return;
    delete record.ended;
    record.at = now;
    remember(this.records, sessionID, record);
  }
  end(sessionID, ended, now = Date.now()) {
    if (typeof sessionID !== "string" || sessionID === "")
      return;
    const record = this.records.get(sessionID) ?? { steps: 0, at: now };
    record.ended = ended;
    record.at = now;
    remember(this.records, sessionID, record);
  }
  get(sessionID) {
    return this.records.get(sessionID);
  }
}
var SUBCOMMAND_PROGRAMS = new Set(["git", "gh", "make", "npm", "bun", "pip", "pip3", "cargo", "docker", "kubectl", "conda", "uv", "poetry"]);
var PLAIN_WORD = /^[A-Za-z0-9._+-]+$/;
function commandHead(command) {
  const first = commandParts(command)[0];
  if (first === undefined)
    return "";
  const words = withoutAssignments(first).split(/\s+/).filter((word) => word !== "");
  const program = words[0];
  if (program === undefined || !PLAIN_WORD.test(program))
    return "";
  const plain = (word) => word !== undefined && PLAIN_WORD.test(word) ? word : undefined;
  if (program === "python3" || program === "python") {
    const module = plain(words[2]);
    return words[1] === "-m" && module !== undefined ? `${program} -m ${module}` : program;
  }
  const subcommand = plain(words[1]);
  return SUBCOMMAND_PROGRAMS.has(program) && subcommand !== undefined && !subcommand.startsWith("-") ? `${program} ${subcommand}` : program;
}
function urlHead(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" || parsed.host === "")
      return "";
    return parsed.origin;
  } catch {
    return "";
  }
}
function summarizeCall(tool, input) {
  const args = input !== null && typeof input === "object" ? input : {};
  const text = (key) => typeof args[key] === "string" && args[key].trim() !== "" ? args[key] : undefined;
  const command = text("command");
  const url = text("url");
  const named = text("subagent_type") ?? text("agent");
  const detail = command !== undefined ? commandHead(command) : url !== undefined ? urlHead(url) : named !== undefined && PLAIN_WORD.test(named) ? named : undefined;
  if (detail === undefined || detail === "")
    return tool;
  const flat = detail.replace(/\s+/g, " ").trim();
  return `${tool}: ${flat.length > SUMMARY_LENGTH ? `${flat.slice(0, SUMMARY_LENGTH - 3)}...` : flat}`;
}
function formatStatus(helpers, now = Date.now()) {
  if (helpers.length === 0)
    return "No helpers in this session.";
  const sorted = [...helpers].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const room = STATUS_LINES - 1;
  const shown = sorted.length > room ? sorted.slice(0, room - 1) : sorted;
  const lines = [`${helpers.length === 1 ? "One helper" : `${helpers.length} helpers`} in this session, newest first:`];
  for (const helper of shown) {
    const end = helper.state === "running" ? now : helper.updatedAt ?? now;
    const parts = [
      helper.id,
      helper.agent,
      helper.state,
      `${helper.steps} ${helper.steps === 1 ? "step" : "steps"}`,
      helper.startedAt === undefined ? undefined : elapsed(end - helper.startedAt)
    ].filter((part) => part !== undefined);
    const title = helper.title.replace(/\s+/g, " ").trim();
    const tail = [title === "" ? undefined : title, helper.lastTool === undefined ? undefined : `last: ${helper.lastTool}`].filter((part) => part !== undefined).join("; ");
    lines.push(`${parts.join(", ")}${tail === "" ? "" : `: ${tail}`}`);
  }
  if (shown.length < sorted.length)
    lines.push(`and ${sorted.length - shown.length} more`);
  return lines.join(`
`);
}
function elapsed(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60)
    return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function targetProblem(target, id, callerSession, helpers) {
  if (target === undefined)
    return `No session ${JSON.stringify(id)}. Run ${HELPER_TOOLS.status} for the ids of your helpers.`;
  if (target.parentID !== callerSession)
    return `${id} is not a helper of this session.`;
  if (target.agent !== undefined && !helpers.has(target.agent))
    return `${id} is not a harness helper (its agent is ${target.agent}).`;
  return;
}
function steerText(text, from) {
  return `${from} amends your brief:
${text.trim()}`;
}
function steeredResult(agent, id) {
  return `Sent to ${agent} ${id}. It reads the message at its next step and keeps what it has done so far; you are told when it finishes.`;
}
function notRunningResult(agent, id, continuation) {
  return `${agent} ${id} is not running, so there is nothing to redirect. To continue it with its context, use the delegation tool with ${continuation}; it answers like a new hand-off.`;
}
function unknownStateResult(agent, id, continuation) {
  return `${agent} ${id} started before this plugin could watch it, so its state is unknown and it cannot be redirected here. If it has finished, continue it with the delegation tool with ${continuation}; otherwise wait for its report.`;
}
function cancelledResult(cancelled) {
  if (cancelled.length === 0)
    return "No running helper to stop.";
  const list = cancelled.map((item) => `${item.agent} ${item.id}`).join(", ");
  return `Stopped ${list}. ${cancelled.length === 1 ? "It" : "They"} will not report; check ${HELPER_TOOLS.status} or the files ${cancelled.length === 1 ? "it" : "they"} touched before building on ${cancelled.length === 1 ? "its" : "their"} work.`;
}
function toolCallBlock(harness, agentId, tool) {
  if (!HELPER_TOOL_IDS.includes(tool))
    return;
  if (agentId === harness.defaultAgent)
    return;
  const agent = harness.agents.find((item) => item.id === agentId);
  const who = agent?.mode === "subagent" ? "helpers" : agentId ?? "an unknown agent";
  return `${harness.name}: ${who} may not use ${tool}; only ${harness.defaultAgent} sees, redirects or stops helpers. Do not try another way: say in your report what is needed.`;
}

// plugin/report.ts
function describe(error) {
  if (error instanceof Error)
    return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}
function internalMessage(name, where, error) {
  return `${name}: internal error in ${where}, settings left unchanged: ${describe(error)}`;
}
function v2Reporter(name, write = (line) => console.warn(line)) {
  const seen = new Set;
  const once = (message) => {
    if (seen.has(message))
      return;
    seen.add(message);
    try {
      write(message);
    } catch {}
  };
  return {
    report(problems) {
      for (const problem of problems)
        once(problem.message);
    },
    internal(where, error) {
      once(internalMessage(name, where, error));
    }
  };
}

// plugin/settings.ts
import path from "path";

// plugin/jsonc.ts
class JsoncError extends Error {
  reason;
  line;
  column;
  constructor(reason, line, column) {
    super(`line ${line}, column ${column}: ${reason}`);
    this.reason = reason;
    this.line = line;
    this.column = column;
    this.name = "JsoncError";
  }
}
var NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
var ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: `
`, r: "\r", t: "\t" };
function parseJsonc(text) {
  let i = text.charCodeAt(0) === 65279 ? 1 : 0;
  const fail = (reason, at = i) => {
    let line = 1;
    let start = 0;
    for (let k = 0;k < at && k < text.length; k++) {
      if (text[k] === `
`) {
        line++;
        start = k + 1;
      }
    }
    throw new JsoncError(reason, line, at - start + 1);
  };
  const describe = (at) => at >= text.length ? "the end of the file" : JSON.stringify(text[at]);
  const skip = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t" || c === `
` || c === "\r") {
        i++;
      } else if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== `
`)
          i++;
      } else if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end === -1)
          fail("a /* comment is never closed");
        i = end + 2;
      } else {
        return;
      }
    }
  };
  const string = () => {
    const start = i;
    i++;
    let out = "";
    while (true) {
      if (i >= text.length)
        fail("text in double quotes is never closed", start);
      const c = text[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        const next = text[i + 1];
        if (next === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex))
            fail("\\u must be followed by four hexadecimal digits");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const escaped = next === undefined ? undefined : ESCAPES[next];
        if (escaped === undefined)
          fail(`${JSON.stringify(`\\${next ?? ""}`)} is not a valid escape in text`);
        out += escaped;
        i += 2;
        continue;
      }
      if (c < " ")
        fail("a line break or control character inside text in double quotes");
      out += c;
      i++;
    }
  };
  const value = () => {
    skip();
    const c = text[i];
    if (c === "{")
      return object();
    if (c === "[")
      return array();
    if (c === '"')
      return string();
    if (c === "-" || c !== undefined && c >= "0" && c <= "9") {
      NUMBER.lastIndex = i;
      const match = NUMBER.exec(text);
      if (match === null)
        return fail("not a valid number");
      i += match[0].length;
      return Number(match[0]);
    }
    for (const [word, result] of [
      ["true", true],
      ["false", false],
      ["null", null]
    ]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return result;
      }
    }
    if (c === "'")
      return fail("text must be in double quotes");
    return fail(`expected a value, found ${describe(i)}`);
  };
  const object = () => {
    const out = Object.create(null);
    i++;
    skip();
    if (text[i] === "}") {
      i++;
      return out;
    }
    while (true) {
      skip();
      if (text[i] !== '"')
        fail(`expected a key in double quotes, found ${describe(i)}`);
      const key = string();
      skip();
      if (text[i] !== ":")
        fail(`expected ":" after the key ${JSON.stringify(key)}, found ${describe(i)}`);
      i++;
      out[key] = value();
      skip();
      if (text[i] === ",") {
        i++;
        skip();
        if (text[i] === "}") {
          i++;
          return out;
        }
        continue;
      }
      if (text[i] === "}") {
        i++;
        return out;
      }
      fail(`expected "," or "}" after a value, found ${describe(i)}`);
    }
  };
  const array = () => {
    const out = [];
    i++;
    skip();
    if (text[i] === "]") {
      i++;
      return out;
    }
    while (true) {
      out.push(value());
      skip();
      if (text[i] === ",") {
        i++;
        skip();
        if (text[i] === "]") {
          i++;
          return out;
        }
        continue;
      }
      if (text[i] === "]") {
        i++;
        return out;
      }
      fail(`expected "," or "]" after a value, found ${describe(i)}`);
    }
  };
  skip();
  if (i >= text.length)
    fail("the file is empty; write {} for no settings");
  const result = value();
  skip();
  if (i < text.length)
    fail(`unexpected ${describe(i)} after the end of the settings`);
  return result;
}

// plugin/types.ts
var REVIEW_POLICIES = ["auto", "ask", "always", "never"];

// plugin/settings.ts
var SETTINGS_FILE = "ecmwf-multi-agents.jsonc";
var MODEL_PATTERN = /^[^/#\s]+\/[^#\s]+$/;
var EFFORT_PATTERN = /^[^#\s]+$/;
var TOP_KEYS = ["$schema", "review", "profile", "default_agent", "agents"];
var AGENT_KEYS = ["model", "effort", "steps"];
var RENAMED_AGENT_KEYS = { variant: "effort" };
function listWords(words, last = "or") {
  if (words.length <= 1)
    return words.join("");
  return `${words.slice(0, -1).join(", ")} ${last} ${words.at(-1)}`;
}
function shown(value) {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function has(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function settingsPaths(environment, projectRoot) {
  const { env, home } = environment;
  const out = [];
  const add = (dir) => {
    if (!dir)
      return;
    const file = path.resolve(dir, SETTINGS_FILE);
    if (!out.includes(file))
      out.push(file);
  };
  add(env.OPENCODE_CONFIG_DIR);
  const xdg = env.XDG_CONFIG_HOME;
  add(path.join(xdg ? xdg : path.join(home, ".config"), "opencode"));
  if (projectRoot)
    add(path.join(projectRoot, ".opencode"));
  return out;
}
function validateSettings(value, harness) {
  const problems = [];
  if (!isObject(value)) {
    return { problems: ['the file must hold one object in braces, such as { "review": "auto" }'] };
  }
  const profiles = harness.profiles.map((profile) => profile.id);
  const agentIds = harness.agents.map((agent) => agent.id);
  const settings = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    switch (key) {
      case "$schema":
        if (typeof item !== "string")
          problems.push(`"$schema" must be text, not ${shown(item)}`);
        break;
      case "review":
        if (typeof item === "string" && REVIEW_POLICIES.includes(item))
          settings.review = item;
        else
          problems.push(`"review" must be ${listWords(REVIEW_POLICIES)}, not ${shown(item)}`);
        break;
      case "profile":
        if (typeof item === "string" && profiles.includes(item))
          settings.profile = item;
        else
          problems.push(`"profile" must be ${listWords(profiles)}, not ${shown(item)}`);
        break;
      case "default_agent":
        if (typeof item === "boolean")
          settings.default_agent = item;
        else
          problems.push(`"default_agent" must be true or false, not ${shown(item)}`);
        break;
      case "agents": {
        if (!isObject(item)) {
          problems.push(`"agents" must be an object that maps agent names to settings, not ${shown(item)}`);
          break;
        }
        const agents = {};
        for (const id of Object.keys(item)) {
          if (!agentIds.includes(id)) {
            problems.push(`"agents" names ${shown(id)}, which is not one of the agents ${listWords(agentIds, "and")}`);
            continue;
          }
          const entry = item[id];
          if (!isObject(entry)) {
            problems.push(`"agents.${id}" must be an object with ${listWords(AGENT_KEYS)}, not ${shown(entry)}`);
            continue;
          }
          agents[id] = validateAgent(id, entry, problems);
        }
        settings.agents = agents;
        break;
      }
      default:
        problems.push(`unknown setting ${shown(key)}; the settings are ${listWords(TOP_KEYS, "and")}`);
    }
  }
  return problems.length > 0 ? { problems } : { settings, problems };
}
function validateAgent(id, entry, problems) {
  const out = {};
  for (const key of Object.keys(entry)) {
    const item = entry[key];
    const name = `"agents.${id}.${key}"`;
    switch (key) {
      case "model":
        if (typeof item === "string" && MODEL_PATTERN.test(item))
          out.model = item;
        else
          problems.push(`${name} must look like provider/model, without "#" or spaces, not ${shown(item)}`);
        break;
      case "effort":
        if (typeof item === "string" && EFFORT_PATTERN.test(item))
          out.effort = item;
        else
          problems.push(`${name} must be a non-empty name such as "high", without "#" or spaces, not ${shown(item)}`);
        break;
      case "steps":
        if (typeof item === "number" && Number.isInteger(item) && item >= 1)
          out.steps = item;
        else
          problems.push(`${name} must be a whole number of at least 1, not ${shown(item)}`);
        break;
      default: {
        const renamed = has(RENAMED_AGENT_KEYS, key) ? RENAMED_AGENT_KEYS[key] : undefined;
        problems.push(renamed === undefined ? `"agents.${id}" has the unknown setting ${shown(key)}; an agent takes ${listWords(AGENT_KEYS)}` : `"agents.${id}" has the unknown key ${shown(key)}; it is now called ${shown(renamed)}`);
      }
    }
  }
  return out;
}
function mergeSettings(files, harness) {
  const settings = {
    review: "auto",
    reviewSet: false,
    profile: harness.defaultProfile,
    defaultAgent: true,
    agents: {}
  };
  for (const file of files) {
    if (file.review !== undefined) {
      settings.review = file.review;
      settings.reviewSet = true;
    }
    if (file.profile !== undefined)
      settings.profile = file.profile;
    if (file.default_agent !== undefined)
      settings.defaultAgent = file.default_agent;
    for (const [id, override] of Object.entries(file.agents ?? {})) {
      settings.agents[id] = { ...settings.agents[id], ...override };
    }
  }
  return settings;
}
function loadSettings(harness, environment, projectRoot) {
  const files = [];
  const problems = [];
  const applied = [];
  for (const file of settingsPaths(environment, projectRoot)) {
    let text;
    try {
      text = environment.readFile(file);
    } catch (error) {
      const code = error?.code;
      const reason = typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
      problems.push({ message: `${harness.name}: ignoring ${file}: it could not be read (${reason})`, notify: true });
      continue;
    }
    if (text === undefined)
      continue;
    let parsed;
    try {
      parsed = parseJsonc(text);
    } catch (error) {
      const reason = error instanceof JsoncError ? error.message : String(error);
      problems.push({ message: `${harness.name}: ignoring ${file}: ${reason}`, notify: true });
      continue;
    }
    const checked = validateSettings(parsed, harness);
    if (checked.settings === undefined) {
      problems.push({ message: `${harness.name}: ignoring ${file}: ${checked.problems.join("; ")}`, notify: true });
      continue;
    }
    files.push(checked.settings);
    applied.push(file);
  }
  return { settings: mergeSettings(files, harness), problems, applied };
}

// plugin/tools-v2.ts
class SessionTracker {
  sessions = new Map;
  observe(envelope, now = Date.now()) {
    if (typeof envelope?.type !== "string")
      return;
    const data = envelope.data;
    const event = { ...envelope, ...data !== null && typeof data === "object" ? data : {}, type: envelope.type };
    const id = event.sessionID;
    if (typeof id !== "string" || id === "")
      return;
    switch (event.type) {
      case "session.created": {
        const created = {
          id,
          state: "unknown",
          startedAt: now,
          updatedAt: now,
          ...typeof event.parentID === "string" ? { parentID: event.parentID } : {},
          ...typeof event.agent === "string" ? { agent: event.agent } : {},
          ...typeof event.title === "string" ? { title: event.title } : {}
        };
        remember(this.sessions, id, created);
        return;
      }
      case "session.execution.started":
        return this.update(id, "running", now);
      case "session.execution.succeeded":
        return this.update(id, "done", now);
      case "session.execution.failed":
        return this.update(id, "failed", now);
      case "session.execution.interrupted":
        return this.update(id, "stopped", now);
      case "session.renamed":
        if (typeof event.title === "string")
          this.update(id, undefined, now, event.title);
        return;
      case "session.agent.selected":
        if (typeof event.agent === "string") {
          const session = this.sessions.get(id);
          if (session !== undefined)
            session.agent = event.agent;
        }
        return;
      default:
        return;
    }
  }
  update(id, state, now, title) {
    const session = this.sessions.get(id) ?? { id, state: "unknown", startedAt: now, updatedAt: now };
    if (state !== undefined)
      session.state = state;
    if (title !== undefined)
      session.title = title;
    session.updatedAt = now;
    remember(this.sessions, id, session);
  }
  get(id) {
    return this.sessions.get(id);
  }
  complete(id, facts) {
    const session = this.sessions.get(id);
    if (session === undefined)
      return;
    if (session.parentID === undefined && facts.parentID !== undefined)
      session.parentID = facts.parentID;
    if (session.agent === undefined && facts.agent !== undefined)
      session.agent = facts.agent;
  }
  children(parent) {
    return [...this.sessions.values()].filter((session) => session.parentID === parent);
  }
}
function sessionApi(ctx) {
  const api = ctx.session;
  if (api?.get === undefined || api.prompt === undefined || api.interrupt === undefined) {
    throw new Error("this opencode does not offer the session API the helper tools need");
  }
  return api;
}
function v2Tools(deps) {
  const { harness, tracker, activity, helpers } = deps;
  const stateOf = (session) => {
    const record = activity.get(session.id);
    return session.state === "running" && record?.ended !== undefined && record.at >= session.updatedAt ? record.ended : session.state;
  };
  const targetOf = async (id) => {
    const tracked = tracker.get(id);
    if (tracked !== undefined && tracked.parentID !== undefined && tracked.agent !== undefined) {
      return { parentID: tracked.parentID, agent: tracked.agent, state: stateOf(tracked) };
    }
    const info = await sessionApi(deps.ctx).get({ sessionID: id }).catch(() => {
      return;
    });
    if (info === undefined || info === null)
      return tracked === undefined ? undefined : { parentID: tracked.parentID, agent: tracked.agent ?? "helper", state: stateOf(tracked) };
    const parentID = tracked?.parentID ?? info.parentID;
    const agent = tracked?.agent ?? (typeof info.agent === "string" ? info.agent : "helper");
    if (tracked !== undefined) {
      tracker.complete(id, { parentID, agent });
      return { parentID, agent, state: stateOf(tracked) };
    }
    return { parentID, agent, state: "unknown" };
  };
  const view = (session) => {
    const record = activity.get(session.id);
    return {
      id: session.id,
      agent: session.agent ?? "helper",
      title: session.title ?? "",
      state: stateOf(session),
      steps: record?.steps ?? 0,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      ...record?.lastTool === undefined ? {} : { lastTool: record.lastTool }
    };
  };
  const define = (spec, run) => ({
    name: spec.id,
    description: spec.description,
    input: { type: "object", properties: spec.args, required: Object.keys(spec.args), additionalProperties: false },
    execute: async (input, context) => ({ content: await run(input ?? {}, context) }),
    options: { codemode: false }
  });
  return [
    define(TOOL_SPECS.status, async (_args, context) => formatStatus(tracker.children(context.sessionID).filter((child) => child.agent === undefined || helpers.has(child.agent)).map(view))),
    define(TOOL_SPECS.steer, async (args, context) => {
      const id = requiredText(args, "id");
      const message = requiredText(args, "text");
      const target = await targetOf(id);
      const problem = targetProblem(target, id, context.sessionID, helpers);
      if (problem !== undefined)
        return problem;
      const { agent, state } = target;
      const continuation = `sessionID: ${JSON.stringify(id)}`;
      if (state === "unknown")
        return unknownStateResult(agent, id, continuation);
      if (state !== "running")
        return notRunningResult(agent, id, continuation);
      await sessionApi(deps.ctx).prompt({ sessionID: id, text: steerText(message, harness.defaultAgent), delivery: "steer" });
      return steeredResult(agent, id);
    }),
    define(TOOL_SPECS.cancel, async (args, context) => {
      const id = requiredText(args, "id");
      const targets = [];
      if (id === "all") {
        for (const child of tracker.children(context.sessionID)) {
          const agent = child.agent ?? "helper";
          if (stateOf(child) === "running" && helpers.has(agent))
            targets.push({ id: child.id, agent });
        }
      } else {
        const target = await targetOf(id);
        const problem = targetProblem(target, id, context.sessionID, helpers);
        if (problem !== undefined)
          return problem;
        if (target.state !== "running")
          return `${target.agent} ${id} is not running.`;
        targets.push({ id, agent: target.agent });
      }
      for (const target of targets) {
        await sessionApi(deps.ctx).interrupt({ sessionID: target.id });
        activity.end(target.id, "stopped");
      }
      return cancelledResult(targets);
    })
  ];
}

// plugin/v2.ts
var FALLBACK_MS = 3000;
function v2ProjectRoot(ctx) {
  const project = ctx?.location?.project?.directory;
  if (typeof project === "string" && project !== "")
    return project;
  const directory = ctx?.location?.directory;
  return typeof directory === "string" && directory !== "" ? directory : undefined;
}

class LateTransform {
  ctx;
  callback;
  reporter;
  current;
  queue = Promise.resolve();
  stopped = false;
  constructor(ctx, callback, reporter) {
    this.ctx = ctx;
    this.callback = callback;
    this.reporter = reporter;
  }
  register() {
    this.queue = this.queue.then(async () => {
      if (this.stopped)
        return;
      try {
        const next = await this.ctx.agent.transform(this.callback);
        const previous = this.current;
        this.current = next;
        if (previous !== undefined)
          await previous.dispose();
      } catch (error) {
        if (!this.stopped)
          this.reporter.internal("registering the agent transform", error);
      }
    });
    return this.queue;
  }
  stop() {
    this.stopped = true;
  }
}
function watchEvents(ctx, onActivation, onEvent, reporter, fallbackMs) {
  const controller = new AbortController;
  let seen = false;
  const subscribe = ctx.event?.subscribe;
  if (typeof subscribe === "function") {
    (async () => {
      for await (const event of subscribe.call(ctx.event, { signal: controller.signal })) {
        if (controller.signal.aborted)
          return;
        if (event?.type === "plugin.updated") {
          seen = true;
          onActivation();
          continue;
        }
        try {
          onEvent(event);
        } catch (error) {
          reporter.internal("reading an event", error);
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted)
        reporter.internal("watching events", error);
    });
  }
  const timer = setTimeout(() => {
    if (!seen && !controller.signal.aborted)
      onActivation();
  }, fallbackMs);
  timer.unref?.();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
function createSetup(harness, options = {}) {
  return async function setup(ctx) {
    const reporter = v2Reporter(harness.name, options.write);
    try {
      let settings = mergeSettings([], harness);
      try {
        const environment = (options.environment ?? processEnvironment)();
        const loaded = loadSettings(harness, environment, v2ProjectRoot(ctx));
        settings = loaded.settings;
        reporter.report(loaded.problems);
      } catch (error) {
        reporter.internal("reading the settings", error);
      }
      const planned = planAgents(harness, settings);
      const plans = planned.plans;
      reporter.report(planned.problems);
      if (settings.defaultAgent) {
        await ctx.agent.transform((editor) => {
          try {
            editor.default(harness.defaultAgent);
          } catch (error) {
            reporter.internal("the default agent transform", error);
          }
        });
      }
      const helpers = helperIds(harness);
      const tracker = new SessionTracker;
      const activity = new Activity;
      if (typeof ctx.tool?.transform === "function") {
        const tools = v2Tools({ harness, ctx, tracker, activity, helpers });
        await ctx.tool.transform((editor) => {
          try {
            for (const tool of tools)
              editor.add(tool);
          } catch (error) {
            reporter.internal("the tool transform", error);
          }
        });
      }
      if (typeof ctx.tool?.hook === "function") {
        await ctx.tool.hook("execute.before", (call) => {
          let message;
          try {
            message = toolCallBlock(harness, call?.agent, call?.tool);
            if (message === undefined)
              activity.observe(call?.sessionID, call?.tool, call?.input);
          } catch (error) {
            reporter.internal("the tool guard", error);
            return;
          }
          if (message !== undefined)
            throw new Error(message);
        });
      }
      if (typeof ctx.session?.hook === "function") {
        const woken = new Set;
        await ctx.session.hook("context", async (event) => {
          try {
            if (event?.agent !== harness.defaultAgent || !Array.isArray(event.messages))
              return;
            const found = heldReportsV2(event.messages);
            if (found === undefined)
              return;
            const sessionID = event.sessionID;
            const key = `${sessionID}
${found.reply}`;
            if (!woken.has(key)) {
              if (typeof sessionID !== "string" || typeof ctx.session?.synthetic !== "function")
                return;
              await ctx.session.synthetic({ sessionID, text: WAKE_TEXT, description: "Reports held until lead answered", delivery: "queue" });
              woken.add(key);
            }
            for (const index of [...found.held].reverse())
              event.messages.splice(index, 1);
          } catch (error) {
            reporter.internal("the context hook", error);
          }
        });
      }
      const late = new LateTransform(ctx, (editor) => {
        try {
          reporter.report(applyToV2Agents(editor, harness, settings, plans));
        } catch (error) {
          reporter.internal("the agent transform", error);
        }
      }, reporter);
      const stopWatching = watchEvents(ctx, () => void late.register(), (event) => tracker.observe(event), reporter, options.fallbackMs ?? FALLBACK_MS);
      return async () => {
        stopWatching();
        late.stop();
      };
    } catch (error) {
      reporter.internal("setup", error);
      return;
    }
  };
}

// plugin/plugin.ts
function createPlugin(harness, options = {}) {
  return {
    id: harness.name,
    setup: createSetup(harness, options)
  };
}

// plugin/index.ts
var plugin_default = createPlugin({ name: "ecmwf-multi-agents", version: "0.5.2", defaultAgent: "lead", defaultProfile: "default", profiles: [{ id: "anthropic", description: "Anthropic models only. The reviewer uses the strongest model, since a different family is not available.", agents: { lead: { model: "anthropic/claude-opus-5-5", effort: "xhigh" }, scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" }, builder: { model: "anthropic/claude-sonnet-5-5", effort: "high" }, reviewer: { model: "anthropic/claude-opus-5-5", effort: "high" } } }, { id: "copilot", description: "GitHub Copilot models only, with the same split as the default profile.", agents: { lead: { model: "github-copilot/claude-opus-5.5", effort: "xhigh" }, scout: { model: "github-copilot/claude-sonnet-5.5", effort: "medium" }, builder: { model: "github-copilot/claude-sonnet-5.5", effort: "high" }, reviewer: { model: "github-copilot/gpt-6.1-sol", effort: "medium" } } }, { id: "default", description: "Anthropic for lead, scout and builder; GitHub Copilot GPT for the reviewer, so reviews come from a different model family.", agents: { lead: { model: "anthropic/claude-opus-5-5", effort: "xhigh" }, scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" }, builder: { model: "anthropic/claude-sonnet-5-5", effort: "high" }, reviewer: { model: "github-copilot/gpt-6.1-sol", effort: "medium" } } }, { id: "inherit", description: "Every agent uses the model selected in the session. Helpers still differ by step limit.", agents: {} }], agents: [{ id: "lead", mode: "primary" }, { id: "scout", mode: "subagent" }, { id: "builder", mode: "subagent" }, { id: "reviewer", mode: "subagent" }] });
export {
  plugin_default as default
};
