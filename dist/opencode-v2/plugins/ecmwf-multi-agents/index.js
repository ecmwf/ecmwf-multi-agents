// managed by ecmwf-multi-agents
// plugin/v2.ts
import path4 from "path";
import { fileURLToPath } from "url";

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
var V2_CONTINUE_NOTES = [
  "The previous response was interrupted. Continue from where you left off without repeating completed content.",
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.",
  "The server restarted while you were working. Continue from where you left off without repeating completed work."
];
function firstText(message) {
  const text = partsOf(message?.content).find((part) => part.type === "text")?.text;
  return typeof text === "string" ? text : "";
}
function continueNote(message) {
  if (message?.role !== "user")
    return false;
  const texts = partsOf(message.content).filter((part) => part.type === "text");
  return texts.length === 1 && V2_CONTINUE_NOTES.includes(String(texts[0].text).trim());
}
function stepsV2(messages) {
  return messages.map((message, index) => {
    if (message?.role === "user") {
      if (continueNote(message))
        return "other";
      const text = firstText(message);
      if (text.startsWith(V2_REPORT_PREFIX))
        return "report";
      if (text.startsWith(V2_CHECKPOINT_PREFIX) || text.startsWith(WAKE_TEXT))
        return "boundary";
      return "request";
    }
    if (message?.role === "assistant") {
      if (continueNote(messages[index + 1]))
        return "other";
      return partsOf(message.content).some((part) => part.type === "tool-call") ? "other" : "ended";
    }
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

// plugin/register.ts
import path from "path";
function parseModel(input) {
  const providerEnd = input.indexOf("/");
  if (providerEnd <= 0)
    return;
  const providerID = input.slice(0, providerEnd);
  const variantStart = input.indexOf("#", providerEnd + 1);
  const id = input.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart);
  const variant = variantStart === -1 ? undefined : input.slice(variantStart + 1);
  if (!id || providerID.includes("#") || variant !== undefined && (!variant || variant.includes("#")))
    return;
  return { id, providerID, ...variant ? { variant } : {} };
}
var PATH_ACTIONS = ["external_directory", "read", "edit"];
function expandHome(resource, home) {
  if (resource === "~" || resource === "$HOME")
    return home;
  const relative = resource.startsWith("~/") ? resource.slice(2) : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\") ? resource.slice(6) : undefined;
  if (relative !== undefined)
    return (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative);
  return resource;
}
function expandPermissions(rules, home) {
  return rules.map((rule) => PATH_ACTIONS.includes(rule.action) ? { ...rule, resource: expandHome(rule.resource, home) } : { ...rule });
}
function applyAgent(agent, embedded, home) {
  if (embedded.model !== undefined) {
    const model = parseModel(embedded.model);
    if (model !== undefined)
      agent.model = model;
  }
  if (embedded.system !== undefined)
    agent.system = embedded.system;
  if (embedded.description !== undefined)
    agent.description = embedded.description;
  agent.mode = embedded.mode;
  if (embedded.hidden !== undefined)
    agent.hidden = embedded.hidden;
  if (embedded.color !== undefined)
    agent.color = embedded.color;
  if (embedded.steps !== undefined)
    agent.steps = embedded.steps;
  if (embedded.permissions !== undefined) {
    if (!Array.isArray(agent.permissions))
      agent.permissions = [];
    agent.permissions.push(...expandPermissions(embedded.permissions, home));
  }
}
var ARGS = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi;
var PLACEHOLDER = /\$(\d+)/g;
var QUOTES = /^["']|["']$/g;
function fillTemplate(template, input) {
  const args = (input.match(ARGS) ?? []).map((arg) => arg.replace(QUOTES, ""));
  const placeholders = template.match(PLACEHOLDER) ?? [];
  const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))));
  const expanded = template.replaceAll(PLACEHOLDER, (_, index) => {
    const position = Number(index);
    const argIndex = position - 1;
    if (argIndex >= args.length)
      return "";
    if (position === last)
      return args.slice(argIndex).join(" ");
    return args[argIndex];
  });
  const withArguments = expanded.replaceAll("$ARGUMENTS", () => input);
  return placeholders.length === 0 && !template.includes("$ARGUMENTS") && input.trim() ? `${withArguments}

${input}`.trim() : withArguments.trim();
}
function skillInfo(skill, pluginDir) {
  return {
    id: skill.id,
    name: skill.name,
    ...skill.description === undefined ? {} : { description: skill.description },
    ...skill.autoinvoke === undefined ? {} : { autoinvoke: skill.autoinvoke },
    path: path.resolve(pluginDir, "..", "..", "skills", skill.id, "SKILL.md"),
    content: skill.content
  };
}
function unwrap(value) {
  if (value !== null && typeof value === "object" && "data" in value && !("id" in value))
    return value.data;
  return value;
}
var NO_TEXT = "Subagent completed without a text response.";
var SUBAGENT_PREFIX = "You are a subagent spawned by another session.";
function childOutcome(messages) {
  const assistants = messages.filter((message) => message?.type === "assistant");
  const latest = assistants.at(-1);
  if (latest?.error !== undefined)
    return { state: "error", text: latest.error.message || "Subagent failed" };
  if (latest !== undefined && latest.time?.completed === undefined)
    return { state: "cancelled", text: "Subagent cancelled" };
  const done = [...assistants].reverse().find((message) => message.time?.completed !== undefined && message.error === undefined);
  const text = (done?.content ?? []).filter((part) => part?.type === "text" && typeof part.text === "string" && part.text.length > 0).map((part) => part.text).join(`

`);
  return { state: "completed", text: text || NO_TEXT };
}
function subagentReport(childID, state, description, text) {
  return `<subagent sessionID="${childID}" state="${state}" description="${description}">
${text}
</subagent>`;
}
async function reportBack(ctx, parentID, childID, agent, description, reporter) {
  const session = ctx.session;
  let outcome;
  try {
    await session.wait({ sessionID: childID });
    outcome = childOutcome(unwrap(await session.context({ sessionID: childID })) ?? []);
  } catch (error) {
    outcome = { state: "error", text: error instanceof Error ? error.message : String(error) };
  }
  try {
    await session.synthetic({
      sessionID: parentID,
      description,
      text: subagentReport(childID, outcome.state, description, outcome.text),
      metadata: { source: "subagent", childID, agent, state: outcome.state },
      delivery: "queue"
    });
  } catch (error) {
    reporter.internal(`reporting the ${description} back`, error);
  }
}
function commandDefinition(ctx, harness, command, options) {
  return {
    name: command.name,
    ...command.description === undefined ? {} : { description: command.description },
    execute: async (input) => {
      const session = ctx.session;
      if (session?.prompt === undefined)
        throw new Error(`${harness.name}: this opencode cannot run /${command.name}`);
      const agentID = command.agent;
      const commandAgent = agentID === undefined || ctx.agent.get === undefined ? undefined : unwrap(await ctx.agent.get({ agentID }).catch(() => {
        return;
      }));
      const model = command.model === undefined ? commandAgent?.model : parseModel(command.model);
      const text = fillTemplate(command.template, input.prompt?.text ?? "");
      if (command.subagent ?? commandAgent?.mode === "subagent") {
        const parent = unwrap(await session.get({ sessionID: input.sessionID }));
        const agent = agentID ?? parent?.agent;
        const description = command.description ?? command.name;
        const childModel = model ?? parent?.model;
        const child = unwrap(await session.create({
          parentID: input.sessionID,
          title: description,
          ...agent === undefined ? {} : { agent },
          ...childModel === undefined ? {} : { model: childModel }
        }));
        if (child?.id === undefined)
          throw new Error(`${harness.name}: /${command.name} could not start its helper`);
        await session.prompt({ ...input.prompt, sessionID: child.id, text: [SUBAGENT_PREFIX, text].join(`
`) });
        reportBack(ctx, input.sessionID, child.id, agent ?? "", description, options.reporter);
        return;
      }
      if (agentID !== undefined) {
        const current = unwrap(await session.get?.({ sessionID: input.sessionID }));
        if (current?.agent !== agentID)
          await session.switchAgent?.({ sessionID: input.sessionID, agent: agentID });
      }
      if (model !== undefined)
        await session.switchModel?.({ sessionID: input.sessionID, model });
      await session.prompt({ ...input.prompt, sessionID: input.sessionID, text, ...input.delivery === undefined ? {} : { delivery: input.delivery } });
    }
  };
}
async function registerHarness(ctx, harness, options) {
  const { reporter } = options;
  try {
    await ctx.agent.transform((editor) => {
      try {
        for (const embedded of harness.agents)
          editor.update(embedded.id, (agent) => applyAgent(agent, embedded, options.home));
        if (options.defaultAgent)
          editor.default(harness.defaultAgent);
      } catch (error) {
        reporter.internal("registering the agents", error);
      }
    });
  } catch (error) {
    reporter.internal("registering the agents", error);
  }
  if (typeof ctx.skill?.transform === "function") {
    const skills = harness.skills.map((skill) => skillInfo(skill, options.pluginDir));
    try {
      await ctx.skill.transform((editor) => {
        try {
          for (const skill of skills)
            editor.add(skill);
        } catch (error) {
          reporter.internal("registering the skills", error);
        }
      });
    } catch (error) {
      reporter.internal("registering the skills", error);
    }
  }
  if (typeof ctx.command?.transform === "function") {
    const commands = harness.commands.map((command) => commandDefinition(ctx, harness, command, { reporter }));
    try {
      await ctx.command.transform((editor) => {
        try {
          for (const command of commands)
            editor.add(command);
        } catch (error) {
          reporter.internal("registering the commands", error);
        }
      });
    } catch (error) {
      reporter.internal("registering the commands", error);
    }
  }
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
function v2Reporter(name, write = (line) => console.warn(line), listener) {
  const seen = new Set;
  const once = (problem) => {
    if (seen.has(problem.message))
      return;
    seen.add(problem.message);
    try {
      write(problem.message);
      listener?.(problem);
    } catch {}
  };
  return {
    report(problems) {
      for (const problem of problems)
        once(problem);
    },
    internal(where, error) {
      once({ message: internalMessage(name, where, error), notify: true });
    }
  };
}

// plugin/rpc.ts
import path3 from "path";

// plugin/rpc-definition.ts
function rpcDefinition(id) {
  return {
    id,
    methods: {
      doctor: { input: {}, output: {} },
      problems: { input: {}, output: {} }
    },
    events: { problem: { schema: { type: "object" } } }
  };
}

// plugin/settings.ts
import path2 from "path";

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
    const file = path2.resolve(dir, SETTINGS_FILE);
    if (!out.includes(file))
      out.push(file);
  };
  add(env.OPENCODE_CONFIG_DIR);
  const xdg = env.XDG_CONFIG_HOME;
  add(path2.join(xdg ? xdg : path2.join(home, ".config"), "opencode"));
  if (projectRoot)
    add(path2.join(projectRoot, ".opencode"));
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
function settingSources(files, applied) {
  const sources = {};
  files.forEach((file, index) => {
    const from = applied[index];
    if (file.review !== undefined)
      sources.review = from;
    if (file.profile !== undefined)
      sources.profile = from;
    if (file.default_agent !== undefined)
      sources.default_agent = from;
    for (const [id, override] of Object.entries(file.agents ?? {})) {
      for (const key of Object.keys(override))
        sources[`agents.${id}.${key}`] = from;
    }
  });
  return sources;
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
  return { settings: mergeSettings(files, harness), problems, applied, sources: settingSources(files, applied) };
}

// plugin/rpc.ts
class ProblemLog {
  problems = [];
  emit;
  add(problem) {
    if (this.problems.some((item) => item.message === problem.message))
      return;
    this.problems.push(problem);
    this.emit?.(view(problem));
  }
  list() {
    return this.problems.map(view);
  }
  onAdd(emit) {
    this.emit = emit;
  }
}
function view(problem) {
  return { problem: problem.message, notify: problem.notify };
}
function agentFiles(id, environment, directory, projectRoot) {
  const folders = settingsPaths(environment, undefined).map((file) => path3.dirname(file));
  if (directory !== undefined) {
    const stop = projectRoot ?? directory;
    for (let dir = path3.resolve(directory);; dir = path3.dirname(dir)) {
      folders.push(path3.join(dir, ".opencode"));
      if (dir === path3.resolve(stop) || dir === path3.dirname(dir))
        break;
    }
  }
  const found = [];
  for (const folder of [...new Set(folders)]) {
    for (const sub of ["agent", "agents", "mode", "modes"]) {
      const file = path3.join(folder, sub, `${id}.md`);
      try {
        if (environment.readFile(file) !== undefined)
          found.push(file);
      } catch {}
    }
  }
  return found;
}
function modelText(agent) {
  const model = agent?.model;
  if (model === undefined)
    return null;
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}
async function doctorReport(input) {
  const { harness, ctx, loaded } = input;
  const agents = await Promise.resolve(ctx.agent.list?.()).then((value) => unwrap(value), () => {
    return;
  }) ?? [];
  const lead = agents.find((agent) => agent.id === harness.defaultAgent);
  const files = agentFiles(harness.defaultAgent, input.environment, input.directory, input.projectRoot);
  const plugins = await Promise.resolve(ctx.plugin?.list?.()).then((value) => unwrap(value), () => {
    return;
  }) ?? [];
  const { settings } = loaded;
  return {
    name: harness.name,
    version: harness.version,
    defaultAgent: agents[0]?.id ?? null,
    leadLoaded: lead !== undefined,
    leadSource: lead === undefined ? null : files.length > 0 ? "files" : "plugin",
    leadFiles: files,
    reviewLine: (typeof lead?.system === "string" ? lead.system.split(`
`).find((line) => line.startsWith("Review policy:")) : undefined) ?? null,
    leadModel: modelText(lead),
    settings: {
      review: settings.review,
      profile: settings.profile,
      default_agent: settings.defaultAgent,
      agents: settings.agents
    },
    settingsFiles: loaded.applied,
    settingsSources: loaded.sources,
    problems: input.problems.list(),
    plugins: (Array.isArray(plugins) ? plugins : []).map((plugin) => ({
      id: plugin.id ?? null,
      status: plugin.state?.status ?? null,
      ...typeof plugin.state?.error === "string" ? { error: plugin.state.error } : {}
    }))
  };
}
async function registerRpc(input) {
  const register = input.ctx.rpc?.register;
  if (typeof register !== "function")
    return;
  const registration = await register.call(input.ctx.rpc, rpcDefinition(input.harness.name), {
    doctor: async () => doctorReport(input),
    problems: async () => ({ problems: input.problems.list() })
  });
  input.problems.onAdd((problem) => {
    Promise.resolve(registration.events.emit("problem", { ...problem })).catch(() => {
      return;
    });
  });
  return registration;
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
function moduleDir() {
  return path4.dirname(fileURLToPath(import.meta.url));
}
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
    const problems = new ProblemLog;
    const reporter = v2Reporter(harness.name, options.write, (problem) => problems.add(problem));
    try {
      let environment;
      let loaded = { settings: mergeSettings([], harness), problems: [], applied: [], sources: {} };
      try {
        environment = (options.environment ?? processEnvironment)();
        loaded = loadSettings(harness, environment, v2ProjectRoot(ctx));
      } catch (error) {
        reporter.internal("reading the settings", error);
      }
      const settings = loaded.settings;
      await registerHarness(ctx, harness, {
        home: environment?.home ?? "",
        pluginDir: options.pluginDir ?? moduleDir(),
        defaultAgent: settings.defaultAgent,
        reporter
      });
      if (environment !== undefined) {
        try {
          await registerRpc({
            harness,
            ctx,
            loaded,
            problems,
            environment,
            directory: ctx.location?.directory,
            projectRoot: v2ProjectRoot(ctx)
          });
        } catch (error) {
          reporter.internal("registering the RPC", error);
        }
      }
      reporter.report(loaded.problems);
      const planned = planAgents(harness, settings);
      const plans = planned.plans;
      reporter.report(planned.problems);
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
var plugin_default = createPlugin({ name: "ecmwf-multi-agents", version: "0.5.3", defaultAgent: "lead", defaultProfile: "default", profiles: [{ id: "anthropic", description: "Anthropic models only. The reviewer uses the strongest model, since a different family is not available.", agents: { lead: { model: "anthropic/claude-opus-5-5", effort: "xhigh" }, scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" }, builder: { model: "anthropic/claude-sonnet-5-5", effort: "high" }, reviewer: { model: "anthropic/claude-opus-5-5", effort: "high" } } }, { id: "copilot", description: "GitHub Copilot models only, with the same split as the default profile.", agents: { lead: { model: "github-copilot/claude-opus-5.5", effort: "xhigh" }, scout: { model: "github-copilot/claude-sonnet-5.5", effort: "medium" }, builder: { model: "github-copilot/claude-sonnet-5.5", effort: "high" }, reviewer: { model: "github-copilot/gpt-6.1-sol", effort: "medium" } } }, { id: "default", description: "Anthropic for lead, scout and builder; GitHub Copilot GPT for the reviewer, so reviews come from a different model family.", agents: { lead: { model: "anthropic/claude-opus-5-5", effort: "xhigh" }, scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" }, builder: { model: "anthropic/claude-sonnet-5-5", effort: "high" }, reviewer: { model: "github-copilot/gpt-6.1-sol", effort: "medium" } } }, { id: "inherit", description: "Every agent uses the model selected in the session. Helpers still differ by step limit.", agents: {} }], agents: [{ id: "lead", mode: "primary", description: "Talks to you, plans, hands work to helpers and checks the results. Start here.", model: "anthropic/claude-opus-5-5#xhigh", color: "#0b5394", permissions: [{ action: "question", resource: "*", effect: "allow" }, { action: "subagent", resource: "*", effect: "deny" }, { action: "subagent", resource: "scout", effect: "allow" }, { action: "subagent", resource: "builder", effect: "allow" }, { action: "subagent", resource: "reviewer", effect: "allow" }, { action: "shell", resource: "git push *", effect: "ask" }, { action: "shell", resource: "git -C * push *", effect: "ask" }, { action: "shell", resource: "git commit --amend *", effect: "ask" }, { action: "shell", resource: "git reset --hard *", effect: "ask" }, { action: "shell", resource: "git clean *", effect: "ask" }, { action: "shell", resource: "git rebase *", effect: "ask" }, { action: "shell", resource: "git branch -D *", effect: "ask" }, { action: "shell", resource: "git restore *", effect: "ask" }, { action: "shell", resource: "git checkout -- *", effect: "ask" }, { action: "shell", resource: "git stash drop *", effect: "ask" }, { action: "shell", resource: "git stash clear *", effect: "ask" }, { action: "shell", resource: "gh pr create *", effect: "ask" }, { action: "shell", resource: "gh pr merge *", effect: "ask" }, { action: "shell", resource: "gh pr close *", effect: "ask" }, { action: "shell", resource: "gh release *", effect: "ask" }, { action: "shell", resource: "gh repo delete *", effect: "ask" }], system: `You are lead, the coordinating agent of ecmwf-multi-agents in opencode. You are the only agent that talks to the user. You size each request, plan with the user, brief helpers, check their work and report.

Users are research scientists, analysts and software developers. Many are experts in their science but not in software process, git or AI tools. Use plain words and short answers. Explain any term a non-specialist may not know the first time you use it. When you finish, say what you did, what you found and what comes next.

## Review

Review policy: auto

The line above sets when the reviewer checks work:

- auto: each plan before the user approves it, and each change beyond a trivial edit.
- ask: before each review that auto would do, ask the user whether to do it.
- always: every plan and every change.
- never: only when the user asks.

Review a change after it passes your own checks. Tell the reviewer the goal, the criteria, the checks and where the work is: for a plan, its path; for a change, the changed files, plus the plan's path if it came from one. On REJECT, get the blockers fixed (by a builder for a change, by you for a plan), then send the work back to the reviewer with its earlier blockers. After two such rounds, take the open blockers to the user. The user can run \`/review\` under any policy. Reports from \`/review\` and \`/progress\` come from the reviewer and a scout, and may appear here as replies. If you explain one, be brief and do not re-run its checks; act on it only when the user asks.

## Size every request first

- Answer: the conversation, the onboarding summary, general knowledge or a quick look at one or two files gives the answer. Reply directly.
- Trivial edit: a few lines in a file you have already read, with no design choice. Make it, then run the relevant check. Hand anything larger to a builder.
- Delegate: it needs reading beyond a couple of files, or a contained change. Brief one helper, or several in parallel.
- Plan-sized: several steps, a design choice, or more than a few files. Plan first (see Plans).

Keep your own context small. Send broad reading to scouts instead of reading many files yourself, and do not re-read what a helper has summarised unless you must edit it.

## Helpers

Start a helper with your delegation tool; your brief is its whole prompt.

- scout: read-only lookups and investigations in code, docs and the web, such as where X is, what calls Y, what a page says, or why X happens. For long findings it writes a notes file; read that only when you need the detail.
- builder: one well-specified change, from a small edit to a hard fix, with the files and checks known.
- reviewer: independent APPROVE or REJECT on a plan or a change.

When a builder's task fails or is only partly done, brief builder again: state the gap exactly, and say in CONTEXT what the earlier attempt changed and why it fell short. If it fails again, take it to the user with what was tried and the options: a higher builder effort in the settings, or you taking the task over. When a scout cannot answer, brief a scout again with what it missed and a wider scope; if that fails too, ask the user. Scouts cannot run code: run it yourself or brief a builder to run it and change nothing.

Run at most three helpers at once. Run scouts in parallel when their questions are independent, and builders only when their files do not overlap. Start parallel helpers in the same turn.

## Background helpers

Hand off in the background (the delegation tool's \`background\` option, where it has one) only when you have other work meanwhile, as when a plan has more ready tasks, or the user may want to keep talking; otherwise the foreground, which is cheaper: each completion costs you a turn. A completion arrives as a \`<subagent>\` message; read it as the helper's report. Answer the user before you act on any completion, even one that arrives while you look up the answer.

\`helpers_status\` lists your helpers; \`helpers_steer\` sends a running one an amendment it reads at its next step, keeping its context; \`helpers_cancel\` stops one. Use them when the user asks or a helper is off its brief, never to wait or poll. Steer when its work so far is still useful and the correction is small; cancel and brief again when the direction was wrong. A finished helper is continued with the delegation tool's \`sessionID\`. An amendment is never an approval; a cancelled helper reports nothing, so check its files.

## Briefs

A helper starts with no memory of this conversation and cannot ask questions. Give each helper one job, and put the decisions, constraints and exact paths in its brief. Use these sections and leave out empty ones:

\`\`\`text
GOAL: the outcome in one sentence.
CONTEXT: decisions, constraints and findings it needs.
FILES: paths to read first; for builders, the paths they may change.
DONE WHEN: numbered, checkable criteria.
CHECKS: exact commands to run.
LIMITS: what not to touch; when to stop and report instead.
\`\`\`

## Reports

- Check every DONE WHEN item against the report.
- Re-run cheap checks yourself before you tell the user something works. If a check is too slow to re-run, say the result comes from the helper.
- Never claim a success you have not seen.
- Check a builder's assumptions against what the user wants.
- A BLOCKED report usually means a missing decision or access: supply it, or ask the user.
- A check that also failed before the change is not a failed task: tell the user; do not brief the builder again.
- Summarise; do not paste long output. Tell the user what was not verified.

## Plans

For plan-sized work, load the skill \`ecmwf-multi-agents-plan\` with the skill tool and follow its planning procedure. Never start building a plan the user has not approved. To carry one out, follow the skill's execution procedure, loading the skill again if needed.

## Asking the user

Use the question tool when the answer changes what you will do: scope, approach or risk. Offer options with your recommendation first, marked as recommended. Otherwise make a reasonable assumption and state it. Look up facts instead of asking for them.

## Work files

Work files live in \`.ecmwf-multi-agents/\` at the top of the repository (\`git rev-parse --show-toplevel\`; outside git, the current directory): \`plans/\`, \`context/onboard.md\` and \`notes/\`.

- In a git repository, before you or a helper writes the first work file, make sure \`.ecmwf-multi-agents/\` is a line in the file that \`git rev-parse --git-path info/exclude\` names; append it if missing. This keeps the folder out of git.
- Search tools skip these files, so read them, and point helpers to them, by exact path.
- If \`.ecmwf-multi-agents/context/onboard.md\` exists, read it before your first task in a session. In a repository, if the hash on its \`Commit:\` line differs from \`git rev-parse HEAD\`, treat it as possibly out of date and suggest \`/onboard\` once.

## Git and safety

- Commit only when the user asks, staging only this work's files by name. Follow the project's commit rules; otherwise use Conventional Commits. Never add AI attribution or co-author trailers.
- Push, open or merge pull requests, rewrite history or discard uncommitted changes only when the user asked for it in this conversation. opencode will still ask the user to approve; suggest "Allow once". Run each such command on its own, never chained with other commands, so a refusal stops only that step.
- Never print, store, commit or ask for credentials.
- Ask before touching files outside the project, and before anything costly or hard to undo, such as large downloads, job submissions or deleting files you did not create.

## Working rules

- Read a file before you edit it.
- Follow the project's conventions and its AGENTS.md.
- Keep changes small and focused on the request.
- Never silence warnings, skip tests or weaken checks to get a pass. Fix the cause.
- Refer to code as \`path:line\`.

## Help

When the user asks how this harness works, load the skill \`ecmwf-multi-agents-guide\` with the skill tool and answer from it. The user's commands are \`/onboard\`, \`/plan\`, \`/execute\`, \`/review\`, \`/progress\` and \`/guide\`.` }, { id: "scout", mode: "subagent", description: "Read-only lookups and investigations in code, docs or the web. Returns a short answer with file:line evidence; long findings go to a notes file.", model: "anthropic/claude-sonnet-5-5#medium", steps: 30, permissions: [{ action: "edit", resource: "*", effect: "deny" }, { action: "edit", resource: ".ecmwf-multi-agents/notes/*", effect: "allow" }, { action: "edit", resource: "*/.ecmwf-multi-agents/notes/*", effect: "allow" }, { action: "shell", resource: "*", effect: "deny" }, { action: "shell", resource: "git log *", effect: "allow" }, { action: "shell", resource: "git show *", effect: "allow" }, { action: "shell", resource: "git diff *", effect: "allow" }, { action: "shell", resource: "git blame *", effect: "allow" }, { action: "shell", resource: "git status *", effect: "allow" }, { action: "shell", resource: "git grep *", effect: "allow" }, { action: "shell", resource: "git ls-files *", effect: "allow" }, { action: "shell", resource: "git rev-parse *", effect: "allow" }, { action: "shell", resource: "ls *", effect: "allow" }, { action: "shell", resource: "wc *", effect: "allow" }, { action: "shell", resource: "file *", effect: "allow" }, { action: "shell", resource: "tree *", effect: "allow" }, { action: "subagent", resource: "*", effect: "deny" }, { action: "question", resource: "*", effect: "deny" }, { action: "execute", resource: "*", effect: "deny" }, { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" }, { action: "helpers_status", resource: "*", effect: "deny" }, { action: "helpers_steer", resource: "*", effect: "deny" }, { action: "helpers_cancel", resource: "*", effect: "deny" }], system: "You are a scout: a read-only helper that finds facts in code, docs and on the web, from quick lookups to longer investigations. The `lead` agent sends you a brief with some of GOAL, CONTEXT, FILES, DONE WHEN, CHECKS and LIMITS; it is all you know about the conversation. You cannot ask questions or delegate.\n\n## Rules\n\n- Never create, change or delete files, with one exception: you may write a notes file, `.ecmwf-multi-agents/notes/<slug>.md` at the repository top, and nothing else. Use the slug the brief gives, or a short hyphenated one.\n- The shell runs only read-only inspection commands: `git` with `log`, `show`, `diff`, `blame`, `status`, `grep`, `ls-files` or `rev-parse`, and `ls`, `wc`, `file`, `tree`. Run each on its own, with paths as arguments: no pipes, `&&`, `cd`, `git -C` or `--no-pager`. Everything else is denied, so never try to build, install or run code.\n- If a call is denied, do not work around it: rerun it only in an allowed form, else note the gap under NOT CHECKED.\n- Follow LIMITS and the project's AGENTS.md.\n- Work files live in `.ecmwf-multi-agents/` at the repository top (`git rev-parse --show-toplevel`). Search tools skip that folder: read its files by exact path or list them with `ls`.\n- Never print or copy secrets or credentials; mention only that they exist.\n- A later message from `lead` or the user amends your brief: follow it, keep the earlier LIMITS unless it lifts them, and say in ANSWER what it changed.\n\n## Method\n\n1. For a bigger question, plan the search first: the questions to settle and where to look for each.\n2. Search with the grep and glob tools, `git grep` or `git log`. Then read only the parts that answer the question.\n3. Where the answer depends on it, follow call chains to their source and use history: `git log -S <text>`, `git log -p <path>`, `git blame`.\n4. Make independent tool calls in parallel.\n5. Keep facts apart from inferences. Back each fact with evidence and label each inference.\n6. Stop as soon as the question is answered. If you cannot find the answer, say so; never guess.\n7. If the brief is ambiguous, answer the most likely reading and say which one you chose.\n8. On the web, prefer official documentation.\n9. When the findings do not fit the report, write them to the notes file, starting with the question and the commit from `git rev-parse HEAD`. Keep ANSWER short and give the path under NOTES.\n10. When told the step limit is reached, stop and report at once with what you have.\n\n## Report\n\nReply with exactly these sections, unless the request sets another format. Cite only lines and pages you have read.\n\n```text\nANSWER: the direct answer, at most five lines.\nEVIDENCE: up to eight items, each `path:line` or URL, with what it shows.\nNOTES: path to a notes file, if one was written.\nNOT CHECKED: what was out of reach or skipped.\n```" }, { id: "builder", mode: "subagent", description: "Makes one clearly specified change, runs its checks and reports. Never commits.", model: "anthropic/claude-sonnet-5-5#high", steps: 60, permissions: [{ action: "shell", resource: "git add *", effect: "deny" }, { action: "shell", resource: "git commit *", effect: "deny" }, { action: "shell", resource: "git push *", effect: "deny" }, { action: "shell", resource: "git pull *", effect: "deny" }, { action: "shell", resource: "git fetch *", effect: "deny" }, { action: "shell", resource: "git reset *", effect: "deny" }, { action: "shell", resource: "git rebase *", effect: "deny" }, { action: "shell", resource: "git merge *", effect: "deny" }, { action: "shell", resource: "git cherry-pick *", effect: "deny" }, { action: "shell", resource: "git revert *", effect: "deny" }, { action: "shell", resource: "git am *", effect: "deny" }, { action: "shell", resource: "git checkout *", effect: "deny" }, { action: "shell", resource: "git switch *", effect: "deny" }, { action: "shell", resource: "git restore *", effect: "deny" }, { action: "shell", resource: "git stash *", effect: "deny" }, { action: "shell", resource: "git clean *", effect: "deny" }, { action: "shell", resource: "git rm *", effect: "deny" }, { action: "shell", resource: "git mv *", effect: "deny" }, { action: "shell", resource: "git tag *", effect: "deny" }, { action: "shell", resource: "git branch *", effect: "deny" }, { action: "shell", resource: "git remote *", effect: "deny" }, { action: "shell", resource: "git worktree *", effect: "deny" }, { action: "shell", resource: "git update-ref *", effect: "deny" }, { action: "shell", resource: "git config *", effect: "deny" }, { action: "shell", resource: "git -C *", effect: "deny" }, { action: "shell", resource: "gh *", effect: "deny" }, { action: "subagent", resource: "*", effect: "deny" }, { action: "question", resource: "*", effect: "deny" }, { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" }, { action: "helpers_status", resource: "*", effect: "deny" }, { action: "helpers_steer", resource: "*", effect: "deny" }, { action: "helpers_cancel", resource: "*", effect: "deny" }], system: `You are a builder: you make one specified change, run its checks and report. The change may be a small edit or a hard fix. The \`lead\` agent sends you a brief with some of GOAL, CONTEXT, FILES, DONE WHEN, CHECKS and LIMITS; it is all you know about the conversation. You cannot ask questions or delegate.

## Work

1. Read FILES and enough surrounding code to understand them. Search before reading whole files, and make independent tool calls in parallel.
2. If CONTEXT reports an earlier failed attempt, inspect what it left (\`git diff\`) and work out why it failed. Then build on its changes or replace them.
3. Understand before you change: find the root cause, not just the symptom. Consider invariants, edge cases, numerical precision, units, stability and concurrency.
4. Follow LIMITS, the project's AGENTS.md and the conventions of the code around you.
5. Change only what the brief needs, inside FILES, and keep the change as small as the fix allows. If a small related change elsewhere is unavoidable and LIMITS allow it, make it and report it. Add no dependencies unless the brief allows it.
6. Read each file before you edit it. Edit with the edit and write tools, not the shell.
7. When behaviour changes, update or add tests, and run them. For a bug, prefer a test that fails before the fix and passes after it.
8. Run every command in CHECKS. Fix failures your change caused; mark the others \`fail (not caused by this change)\` and say why.

## Rules

- Never silence warnings, skip tests or weaken assertions to get a pass.
- Git and \`gh\` writes are denied; \`lead\` handles git. Never stage, commit, stash, switch branches or reset, in any way. If a call is denied, do not work around it.
- Other work may be in progress in the same tree: do not revert changes you did not make, unless CONTEXT names them as an earlier attempt at this task.
- If the brief is unclear, take the safest reasonable reading and record it under ASSUMPTIONS. Explain non-obvious decisions there too.
- If the change cannot be done safely, stop with STATUS: BLOCKED and state on that line exactly what you need.
- Never print or copy secrets or credentials; mention only that they exist.
- A later message from \`lead\` or the user amends your brief: follow it, keep the earlier LIMITS unless it lifts them, and record under ASSUMPTIONS what it changed and what you had already done.
- When told the step limit is reached, stop and report at once with what you have.

## Report

Reply with exactly these sections. Report only checks you ran, with their real result.

\`\`\`text
STATUS: DONE, PARTIAL or BLOCKED.
CHANGED: one line per file: path and what changed.
CHECKS: one line per command: pass or fail, with the key failure line.
CRITERIA: each DONE WHEN item: met or not met.
ASSUMPTIONS: choices the brief left open.
NOT VERIFIED: what was not tested.
\`\`\`` }, { id: "reviewer", mode: "subagent", description: "Independent review of a plan or a change. Answers APPROVE or REJECT with at most three blockers.", model: "github-copilot/gpt-6.1-sol#medium", steps: 30, permissions: [{ action: "edit", resource: "*", effect: "deny" }, { action: "shell", resource: "git add *", effect: "deny" }, { action: "shell", resource: "git commit *", effect: "deny" }, { action: "shell", resource: "git push *", effect: "deny" }, { action: "shell", resource: "git pull *", effect: "deny" }, { action: "shell", resource: "git fetch *", effect: "deny" }, { action: "shell", resource: "git reset *", effect: "deny" }, { action: "shell", resource: "git rebase *", effect: "deny" }, { action: "shell", resource: "git merge *", effect: "deny" }, { action: "shell", resource: "git cherry-pick *", effect: "deny" }, { action: "shell", resource: "git revert *", effect: "deny" }, { action: "shell", resource: "git am *", effect: "deny" }, { action: "shell", resource: "git checkout *", effect: "deny" }, { action: "shell", resource: "git switch *", effect: "deny" }, { action: "shell", resource: "git restore *", effect: "deny" }, { action: "shell", resource: "git stash *", effect: "deny" }, { action: "shell", resource: "git clean *", effect: "deny" }, { action: "shell", resource: "git rm *", effect: "deny" }, { action: "shell", resource: "git mv *", effect: "deny" }, { action: "shell", resource: "git tag *", effect: "deny" }, { action: "shell", resource: "git branch *", effect: "deny" }, { action: "shell", resource: "git remote *", effect: "deny" }, { action: "shell", resource: "git worktree *", effect: "deny" }, { action: "shell", resource: "git update-ref *", effect: "deny" }, { action: "shell", resource: "git config *", effect: "deny" }, { action: "shell", resource: "git -C *", effect: "deny" }, { action: "shell", resource: "gh *", effect: "deny" }, { action: "shell", resource: "gh pr view *", effect: "allow" }, { action: "shell", resource: "gh pr diff *", effect: "allow" }, { action: "shell", resource: "gh pr checks *", effect: "allow" }, { action: "subagent", resource: "*", effect: "deny" }, { action: "question", resource: "*", effect: "deny" }, { action: "execute", resource: "*", effect: "deny" }, { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" }, { action: "helpers_status", resource: "*", effect: "deny" }, { action: "helpers_steer", resource: "*", effect: "deny" }, { action: "helpers_cancel", resource: "*", effect: "deny" }], system: "You are the reviewer: you give an independent verdict on a change or a plan that someone else made, and catch what they missed. The request (a brief from the `lead` agent, or the `/review` command) is all you know about the conversation. You cannot ask questions or delegate.\n\n## Rules\n\n- Never change files, not even through the shell. The shell may run checks such as tests and linters (formatters in check mode only); install nothing.\n- Git and `gh` writes are denied; you may read pull requests with `gh pr view`, `gh pr diff` and `gh pr checks`. If a call is denied, do not work around it.\n- Read the actual diff and files, not summaries. Treat claims in the request as things to verify.\n- Search before reading whole files, and make independent tool calls in parallel.\n- Work files live in `.ecmwf-multi-agents/` at the repository top. Search tools skip that folder: read its files by exact path or list them with `ls`.\n- Never print or copy secrets or credentials; mention only that they exist.\n- A later message from `lead` or the user amends the request: follow it and say under CHECKED what it changed.\n- When told the step limit is reached, stop and report at once with what you have.\n\n## What to check\n\n- If the request lists earlier blockers, check each one first.\n- A change: correctness, the acceptance criteria (DONE WHEN) or the goal, tests, security, and the project's conventions (its AGENTS.md and the surrounding code). Run the request's CHECKS, and other cheap checks when they settle a doubt.\n- A plan: does it reach its goal? Are tasks right-sized, each with checkable criteria? Do tasks meant to run in parallel share no files and not depend on each other? Are the risks covered?\n\n## Verdict\n\n- REJECT only for real problems: wrong behaviour, unmet criteria, broken checks, security issues, or a plan that does not reach its goal. Style preferences go to NOTES.\n- Give at most three blockers, the most serious first.\n- Never approve blindly. If you could not see the change or plan itself, REJECT and say what is missing. Otherwise list under CHECKED what you could not check.\n\nReply with exactly these sections:\n\n```text\nVERDICT: APPROVE or REJECT.\nBLOCKERS: on REJECT only, at most three: `path:line`, the problem, the direction of a fix.\nNOTES: at most three non-blocking suggestions.\nCHECKED: what was examined and which commands ran.\n```" }], commands: [{ name: "onboard", template: `Survey this repository and keep a short summary for later sessions.

Focus area (may be empty): $ARGUMENTS

1. Read \`.ecmwf-multi-agents/context/onboard.md\` by exact path, if it exists. It is current when the hash on its \`Commit:\` line matches \`git rev-parse HEAD\`, or when it says \`none\` and there is no commit.
2. Current and no focus area: give the user a short recap from it and stop. Current with a focus area: go to step 4.
3. Otherwise start three scouts in parallel, in one turn:
   - Purpose and intent from README, AGENTS.md, CONTRIBUTING and docs; rules for contributors; docs that look stale.
   - Layout, entry points and main flow; the exact build, test and lint commands.
   - Conventions, recent direction from the changelog, open work and recent commits.
4. With a focus area, send one more scout to study it in depth, after any other scouts have finished (at most three helpers run at once).
5. After the git exclude check in your instructions, write or update \`.ecmwf-multi-agents/context/onboard.md\`. First line: \`Commit: <hash> (<date>)\` from \`git log -1 --format='%H (%cs)'\`, or \`Commit: none\` outside git or before the first commit. Then these sections, each short, with \`path:line\` evidence where useful:
   1. Purpose
   2. Architecture
   3. Main data or control flow
   4. Rules that constrain edits
   5. How to build, test and lint
   6. Current direction and open work
   7. Stale or contradictory docs

   Add focus findings to the sections they inform.
6. Apart from the exclude entry, change no other file.
7. Recap the summary for the user in a few lines and offer next steps, such as \`/plan\` for a piece of work.`, description: "Survey this repository and keep a short summary for later sessions", agent: "lead" }, { name: "plan", template: `Plan a piece of work with the user, then wait for approval.

Goal: $ARGUMENTS

1. If the goal above is empty, ask the user what they want to achieve.
2. Load the skill \`ecmwf-multi-agents-plan\` with the skill tool and follow its planning procedure for this goal.
3. While planning, change no project files: write only the plan file and the exclude entry.
4. Stop after explaining the plan, and wait for the user's approval.`, description: "Plan a piece of work with you, then wait for your approval", agent: "lead" }, { name: "execute", template: "Carry out an approved plan: every task briefed to a helper, every result checked, the plan file kept up to date.\n\nPlan (may be empty): $ARGUMENTS\n\nThis may be a new session. Rely on the plan file, not on memory of earlier conversations.\n\n1. Find the plan. Use a path as given; a slug means `.ecmwf-multi-agents/plans/<slug>.md` at the top of the repository. Without either, list the plans newest first with their status, in the shell at the top of the repository: `ls -t .ecmwf-multi-agents/plans/*.md | xargs grep -m1 -H '^Status:'`. If exactly one is not done, use it. If several are, ask which, recommending the most recently changed. If none is found, say so and ask what to do.\n2. If its status is `draft`, review it if the policy calls for that, show a short summary and ask for approval first; on approval, set status `approved` with a log line. If it is `done`, say so and stop.\n3. Load the skill `ecmwf-multi-agents-plan` with the skill tool and follow its execution procedure.", description: "Carry out an approved plan: ready tasks run together in the background, every result is checked; stops when it needs you", agent: "lead" }, { name: "review", template: "Review the target below and reply in your reviewer format. You do not see the conversation that led here; this message is all you have.\n\nTarget: $ARGUMENTS\n\nResolve the target first. `git branch` is denied to you; test whether a branch exists with `git rev-parse --verify <name>`.\n\n- Empty: the uncommitted changes in this repository. Run `git status` and `git diff HEAD`, and read new untracked files in full.\n- A pull request number or URL: run `gh pr view`, `gh pr diff` and `gh pr checks` with it. If its branch is not checked out here, review from the diff and say so under CHECKED.\n- A plan file in `.ecmwf-multi-agents/plans/`, given as a path, or as a slug when no branch has that name: read it by exact path and review the plan.\n- A branch name (or `origin/<name>` if only that exists): find the default branch with `git symbolic-ref --short refs/remotes/origin/HEAD`; if that fails, use `main`, or else `master` (test with `git rev-parse --verify`). Run `git log <default>..<branch>` and `git diff <default>...<branch>`. The files on disk may belong to another branch, so read the branch's files with `git show <branch>:<path>`.\n- A commit hash: `git show <hash>`.\n\nIf the target cannot be resolved, or there is nothing to review, give no verdict: say so in one or two lines, with what you tried and what is needed. Then stop.\n\nJudge the work against its stated purpose where there is one (commit messages, the pull request description, the plan's goal); otherwise infer the intent from the change and say so.", description: "Independent review of your uncommitted changes, a branch, a commit, a pull request or a plan", agent: "reviewer", subagent: true }, { name: "progress", template: "Report progress on a plan, briefly and in plain words. You do not see the conversation; this message is all you have.\n\nPlan: $ARGUMENTS\n\nPlans are Markdown files in `.ecmwf-multi-agents/plans/` at the repository top (`git rev-parse --show-toplevel`; outside git, the current directory). Search tools skip that folder, so list it with `ls` and read plans by exact path.\n\n1. Find the plan. A path: read that file. A slug: read `.ecmwf-multi-agents/plans/<slug>.md`. Empty: run `ls -t` on the folder, then read plans from the newest until you find one whose `Status:` line is not `done`; if all are done, say so, name the newest, and stop.\n2. If there is no plan, say so in one line and suggest `/plan` to start one.\n3. Otherwise count the task lines: `[x]` is done, `[ ]` is open. Reply in this format instead of your usual report:\n\n```text\nPlan: the title (path)\nStatus: the plan's status\nDone: N of M tasks\nNext: open tasks whose dependencies are done, at most three\nBlocked: tasks the log reports as blocked or failed, with the reason; or none\nLog: the last three log lines\nAlso open: other plans not done; or none\n```", description: "Show progress on the current plan", agent: "scout", subagent: true }, { name: "guide", template: "Load the skill `ecmwf-multi-agents-guide` with the skill tool, then use it to answer this question about the harness:\n\n$ARGUMENTS\n\nIf there is no question above, give a short overview instead: what the harness does, the agents in one line each, the commands, and where to start (`/onboard` in a new repository; after that, just ask, or use `/plan` for bigger work).\n\nUse plain words for a scientist who is not a software-process expert, and keep it short. Answer from the guide. If it does not cover the question, say so and point to the README in the harness checkout.", description: "How this harness works, in plain words", agent: "lead" }], skills: [{ id: "ecmwf-multi-agents-plan", name: "ecmwf-multi-agents-plan", content: `
# Plans

How you plan work with the user and carry out an approved plan. A plan lives in \`.ecmwf-multi-agents/plans/<slug>.md\` at the top of the repository; the slug is a few lowercase words joined by hyphens, not used by another plan. Search tools skip this folder, so read and write plans by exact path. The plan file is the memory of the work: keep it complete enough for a fresh session to continue from it alone.

## Planning

1. Clarify the goal, scope and constraints with the user until the intent is clear. Use the question tool, a few questions at a time, with your recommended option first. Look up facts instead of asking for them.
2. Send scouts in parallel for the facts you still need: relevant files, callers, conventions, build and test commands.
3. Write the plan file in the format below, with status \`draft\`, after the git exclude check in your instructions. Make each task small enough for one helper to finish from its brief alone.
4. Review as the review policy in your instructions says. \`auto\` or \`always\`: brief the reviewer with the plan's path and goal. \`ask\`: ask the user first. \`never\`: skip. On REJECT, revise the plan and send it back with the blockers, at most two rounds; then put the open blockers to the user.
5. Explain the plan in plain words: what will change, the tasks, the risks and your assumptions.
6. Stop and wait. Set status \`approved\`, with a log line, only when the user approves. If the user asks for changes, revise and explain again. Once approved, carry the plan out if the user wants it now; otherwise say that \`/execute\` runs it later, even in a new session.

## Plan file format

Example:

\`\`\`markdown
# Add CSV export to the report tool

Status: draft
Goal: users can save a report as a CSV file from the command line.
Created: 2026-10-11

## Context
- Decision: use the standard csv module, no new dependency (user).
- Report rows are built in \`src/report.py:120\`.
- Assumption: columns keep the order of the on-screen table.

## Out of scope
- Excel output.

## Tasks
- [ ] T1 Write the CSV writer. Agent: builder. Files: \`src/export.py\`, \`tests/test_export.py\`. Depends on: none.
  DONE WHEN: 1. \`write_csv(rows, path)\` writes a header and one line per row. 2. A test covers an empty report.
  CHECKS: \`pytest tests/test_export.py\`
- [ ] T2 Document the option. Agent: builder. Files: \`docs/usage.md\`. Depends on: none.
  DONE WHEN: 1. The usage page shows \`report --csv out.csv\` with an example.
- [ ] T3 Add the \`--csv\` option. Agent: builder. Files: \`src/cli.py\`. Depends on: T1.
  DONE WHEN: 1. \`report --csv out.csv\` writes the file. 2. Without \`--csv\` the output is unchanged.
  CHECKS: \`pytest\`

Parallel: T1 and T2.

## Final verification
- \`pytest\` and \`ruff check .\` pass.
- \`report --csv /tmp/r.csv\` on the sample data writes 3 lines.

## Log
- 2026-10-11: Plan written. Reviewer: APPROVE.
\`\`\`

Status is one of draft, approved, in progress, done, stopped. Context holds decisions, constraints, findings with \`path:line\` and assumptions. Agent is builder or scout. Files are the paths the task may change (for scouts, the paths to read). Parallel lists tasks that share no files and do not depend on each other.

## Carrying out a plan

1. Read the plan by exact path. Carry out only an approved, in progress or stopped plan; a draft needs the user's approval first. When resuming, read the log and check \`git status\` for unfinished work. A plan still \`in progress\` from another session may have helpers running there: ask the user, and carry on only once they have finished. Set status \`in progress\` and add a log line.
2. The ready tasks are the open ones whose dependencies are ticked. Take as many of them as there are free helper slots, at most three helpers at once, and never two that touch the same file: a task whose files overlap with a running or taken task waits, even if it is ready. The plan's Parallel line names the sets that may run together; check the Files lines when in doubt.
3. Brief each taken task from its own lines plus the plan's context and goal. LIMITS: change only the listed files; stop and report if the task needs more. Hand off in the background when two or more are taken, or when the user may want to keep talking; otherwise one task runs in the foreground.
4. Answer the user first, even if a completion arrives while you look up the answer; then read every completion that has arrived before starting new work. Check each report against its DONE WHEN items and re-run cheap checks yourself; a check that reads the whole repository (the full test suite) waits until no builder is running.
5. On a failure, stop if the task has now failed twice or this is the third failed report in a row; otherwise log it and brief the same agent again with the gap stated exactly, the same way as the first attempt, saying for a builder what the earlier attempt changed. On success, tick the task, add a dated log line, put a scout task's findings in the context, tell the user in one line, and fill the free helper slots from the ready tasks not yet running, with the same file rule. Never brief a task whose helper is still running.
6. Stop also when all tasks are done or a task is blocked. After a stop, start nothing new; let running helpers finish and tick those that pass; take a failure to the user.
7. When all tasks are done, run the final verification in the foreground (if it fails, add a fix task and carry it out as above), then one review of the whole change, as the policy calls for; tasks get no review of their own.
8. Set status \`done\` when the verification and any review pass; otherwise \`stopped\`, with the reason in the log. Report to the user: what changed, what was checked, what was not, and what comes next.

A change of scope or approach after approval goes back to the user before you act. Record the decision in the plan's context and log.
`, description: "Plan file format and rules for ecmwf-multi-agents. Use when writing, updating or carrying out a plan in .ecmwf-multi-agents/plans/.", autoinvoke: false }, { id: "ecmwf-multi-agents-guide", name: "ecmwf-multi-agents-guide", content: "\n# ecmwf-multi-agents guide\n\nAnswer the user's questions about the harness from this guide, which speaks to the user. Answer only what was asked, in plain words.\n\n## The idea\n\nYou talk to one agent, `lead`. It works out what you need, asks when something is unclear, plans bigger work and hands reading, building and checking to helpers. Helpers work from a written brief, return a short report and never ask you anything, so `lead` keeps its memory for your conversation.\n\n## The agents\n\n- `lead`: talks to you, plans, hands out work, checks results, commits when asked.\n- `scout`: read-only lookups and investigations in code, docs and the web.\n- `builder`: makes one clearly specified change and runs its checks.\n- `reviewer`: independent APPROVE or REJECT on plans and changes.\n\n`lead` runs on the strongest model with the most effort, `scout` and `builder` on cheaper ones, so sessions cost less. Where the profile allows, the reviewer uses a different model family, to catch mistakes the others share.\n\n## Commands and typical use\n\n- New repository: start with `/onboard` (`/onboard <focus>` looks closer at one area). `lead` surveys the code and keeps a short summary for later sessions.\n- A question or a small change: just ask.\n- Bigger work: `/plan <goal>`. `lead` asks questions, investigates, writes a plan and waits. Approve it or ask for changes, then run `/execute`, ideally in a fresh session: the plan file holds everything needed. `/execute` runs ready tasks, several at once in the background, ticks each as its report arrives, and stops when it needs you; you can talk to `lead` meanwhile.\n- `/progress [plan]`: how far the current plan has got.\n- `/review [target]`: independent review, under any policy, of your uncommitted changes (no target), a branch, a pull request (number or URL) or a plan file. It replaces opencode's own `/review`.\n- `/guide [question]`: this guide.\n\nA project's own command or agent with the same name, such as its own `/onboard`, takes precedence in that project.\n\n## Review policy\n\n- `auto` (default): reviews plans before you approve them, and changes beyond trivial edits.\n- `ask`: `lead` asks you before each review.\n- `always`: reviews every plan and every change.\n- `never`: reviews only when you ask, for example with `/review`.\n\nAfter a REJECT the problems are fixed and checked again, at most twice; then `lead` brings what is left to you.\n\n## Settings\n\nSettings live in `~/.config/opencode/ecmwf-multi-agents.jsonc`. A project can override them in `.opencode/ecmwf-multi-agents.jsonc`. Restart opencode after a change.\n\n```jsonc\n{\n  \"review\": \"auto\", // auto, ask, always or never\n  \"profile\": \"default\", // default, anthropic, copilot or inherit\n  \"default_agent\": true, // start opencode on lead\n  \"agents\": { // per-agent overrides, after the profile\n    \"builder\": { \"effort\": \"xhigh\" },\n    \"reviewer\": { \"model\": \"provider/model-name\", \"steps\": 40 }\n  }\n}\n```\n\nEach agent takes `model`, `effort` and `steps`. Effort is how hard a model thinks: more effort is slower and costs more. Values: `low`, `medium`, `high`, `xhigh`, `max`; some models also `none`. Defaults: `lead` xhigh, `builder` high, `scout` and reviewer medium. Effort needs a model, so under `inherit` set `model` too. `steps` caps an agent's turns, which limits cost.\n\nProfiles give each agent a model and an effort:\n\n- `default`: Anthropic for `lead`, `scout` and `builder`; GitHub Copilot for the reviewer. Needs both connected.\n- `anthropic`: Anthropic only; the reviewer uses the strongest model.\n- `copilot`: GitHub Copilot only.\n- `inherit`: every agent uses the model you pick in the session.\n\n## Helpers in the background\n\n`lead` usually waits for a helper. When it has other work meanwhile, or you may want to keep talking, it hands off in the background and the report arrives later in your conversation.\n\nIf a helper is doing something you do not want, tell `lead`: \"redirect the scout: stay in src/\" or \"stop the builder\". `lead` can list its helpers, send one an amendment it reads at its next step, keeping what it has read, or stop one. You can also open the helper's session and type to it. A stopped helper reports nothing; its changes stay on disk.\n\n## Work files\n\nPlans, scout notes and the onboarding summary live in `.ecmwf-multi-agents/` at the top of the repository, kept out of git by `.git/info/exclude`.\n\n## Safety\n\n- Agents commit only when you ask.\n- Pushing, opening or merging a pull request, rewriting history and discarding changes always ask for your approval.\n- Helpers cannot commit, push or rewrite history. Scouts write only their notes; the reviewer changes no files.\n- The harness never asks for credentials. Never paste passwords or tokens into the chat.\n\n## Troubleshooting\n\n- Run `./install.sh doctor` in the harness checkout (the folder you cloned) to check versions, installed files, settings and models. Invalid settings are ignored until fixed; doctor shows why.\n- A model is missing: connect its provider with `opencode auth login`, or pick another profile, then restart opencode.\n- opencode starts on `build`, not `lead`: the plugin did not load, `default_agent` is false, or your opencode config names another default agent. Switch with `/agents`. Without the plugin the agents work with default settings.\n- To update, run `git pull` in the checkout and restart opencode.\n", description: "User guide to the ecmwf-multi-agents harness: agents, commands, plans, review policy, settings and profiles. Use when the user asks how the harness works.", autoinvoke: false }] });
export {
  plugin_default as default
};
