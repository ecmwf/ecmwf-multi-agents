// managed by ecmwf-multi-agents
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
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function applyToV1Config(config, harness, settings, plans) {
  const problems = [];
  const changes = [];
  const agents = isRecord(config.agent) ? config.agent : undefined;
  for (const plan of plans) {
    const agent = agents?.[plan.id];
    if (!isRecord(agent))
      continue;
    changes.push(() => {
      if (plan.model === undefined) {
        delete agent.model;
        delete agent.variant;
      } else {
        agent.model = plan.model;
        if (plan.effort === undefined)
          delete agent.variant;
        else
          agent.variant = plan.effort;
      }
      if (plan.steps !== undefined)
        agent.steps = plan.steps;
    });
  }
  const lead = agents?.[harness.defaultAgent];
  if (isRecord(lead)) {
    if (typeof lead.prompt === "string") {
      const result = rewriteReviewLine(lead.prompt, settings.review, harness.defaultAgent);
      if (result.problem !== undefined)
        problems.push(reviewProblem(harness, settings, result.problem));
      else
        changes.push(() => lead.prompt = result.prompt);
    } else {
      problems.push(reviewProblem(harness, settings, `${harness.defaultAgent} has no prompt, so the review policy was not applied`));
    }
  }
  if (settings.defaultAgent && !config.default_agent && isRecord(lead) && lead.disable !== true && lead.mode !== "subagent" && lead.hidden !== true) {
    changes.push(() => config.default_agent = harness.defaultAgent);
  }
  for (const change of changes)
    change();
  return problems;
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
    platform: process.platform,
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

// plugin/guard.ts
function wildcardMatch(input, pattern, platform = process.platform) {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (escaped.endsWith(" .*"))
    escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, platform === "win32" ? "si" : "s").test(normalized);
}
function evaluateRules(rules, command, platform) {
  for (let i = rules.length - 1;i >= 0; i--) {
    const rule = rules[i];
    if (wildcardMatch(command, rule.resource, platform))
      return rule.effect;
  }
  return;
}
var KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "time", "esac"]);
var DIRECTORY_COMMANDS = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"]);
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
var WRAPPERS = new Set(["env", "command", "builtin", "exec", "nohup", "sudo"]);
function commandForms(part) {
  const forms = [part];
  const add = (text) => {
    if (text !== "" && !forms.includes(text))
      forms.push(text);
  };
  let text = withoutAssignments(part);
  add(text);
  while (WRAPPERS.has(firstWord(text)))
    text = withoutAssignments(text.slice(firstWord(text).length).trimStart());
  add(text);
  const words = text.split(/\s+/);
  if (words[0] === "git") {
    let i = 1;
    while (i < words.length && words[i].startsWith("-"))
      i += words[i] === "-C" || words[i] === "-c" ? 2 : 1;
    add(["git", ...words.slice(i)].join(" "));
  }
  return forms;
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
function firstWord(text) {
  return /^\S*/.exec(text)?.[0] ?? "";
}
function checkShellCommand(harness, agentId, command, platform) {
  const agent = harness.agents.find((item) => item.id === agentId);
  if (agent === undefined || agent.mode !== "subagent" || agent.shell.length === 0)
    return;
  for (const part of commandParts(command)) {
    const forms = commandForms(part);
    if (DIRECTORY_COMMANDS.has(firstWord(forms.at(-1) ?? part)))
      continue;
    const denied = forms.find((form) => evaluateRules(agent.shell, form, platform) === "deny");
    if (denied !== undefined)
      return { part, message: blockMessage(harness, agent.id, part, denied) };
  }
  return;
}
function blockMessage(harness, agent, part, denied) {
  const shown = JSON.stringify(part.length > 120 ? `${part.slice(0, 117)}...` : part);
  const owner = /^(git|gh)(\s|$)/.test(denied) ? `helpers may not run ${shown}; ${harness.defaultAgent} handles git and GitHub` : `${agent} may not run ${shown}; its permission rules deny it`;
  return `${harness.name}: ${owner}. Do not try another way: say in your report what is needed.`;
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
function splitModel(model) {
  if (model === undefined)
    return;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1)
    return;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}
function pinMessage(message, helper, plan) {
  let changed = false;
  if (message.agent !== helper) {
    message.agent = helper;
    changed = true;
  }
  const model = splitModel(plan?.model);
  if (model !== undefined) {
    const current = message.model ?? {};
    if (current.providerID !== model.providerID || current.modelID !== model.modelID || current.variant !== plan?.effort) {
      message.model = { ...current, providerID: model.providerID, modelID: model.modelID, variant: plan?.effort };
      if (plan?.effort === undefined)
        delete message.model.variant;
      changed = true;
    }
  }
  return changed;
}

// plugin/inline.ts
var COMPLETION_PREFIX = "<task ";
var INLINE_WAIT_LIMIT_MS = 30 * 60000;
var PENDING_MS = 60000;
function textParts(parts) {
  if (!Array.isArray(parts))
    return [];
  return parts.filter((part) => part !== null && typeof part === "object" && part.type === "text");
}
function isSyntheticMessage(parts) {
  const texts = textParts(parts);
  return texts.length > 0 && texts.every((part) => part.synthetic === true);
}
function isCompletion(parts) {
  const first = textParts(parts)[0]?.text;
  return isSyntheticMessage(parts) && typeof first === "string" && first.startsWith(COMPLETION_PREFIX);
}
function inlineAction(facts, helpers) {
  if (facts.agent === undefined || !helpers.has(facts.agent) || facts.busy === undefined)
    return "leave";
  if (facts.busy && facts.running !== undefined && helpers.has(facts.running))
    return "wait";
  if (facts.completion)
    return "owner";
  return facts.busy ? "subtask" : "inline";
}
function toSubtask(parts, spec) {
  const first = textParts(parts)[0];
  if (first === undefined || typeof first.text !== "string" || first.text.trim() === "")
    return false;
  const subtask = {
    ...first.id !== undefined ? { id: first.id } : {},
    ...first.sessionID !== undefined ? { sessionID: first.sessionID } : {},
    ...first.messageID !== undefined ? { messageID: first.messageID } : {},
    type: "subtask",
    prompt: first.text,
    description: spec.description,
    agent: spec.agent,
    ...spec.model !== undefined ? { model: { providerID: spec.model.providerID, modelID: spec.model.modelID } } : {},
    ...spec.command !== undefined ? { command: spec.command } : {}
  };
  parts.splice(0, parts.length, subtask);
  return true;
}
function giveTo(message, owner, plan) {
  const model = owner.model;
  if (typeof model?.providerID === "string" && typeof model.modelID === "string") {
    message.agent = owner.agent;
    message.model = { providerID: model.providerID, modelID: model.modelID, ...typeof model.variant === "string" ? { variant: model.variant } : {} };
    return;
  }
  pinMessage(message, owner.agent, plan);
}

class Owners {
  owners = new Map;
  note(session, agent, model) {
    if (typeof session !== "string" || session === "" || typeof agent !== "string" || agent === "")
      return;
    const ref = model !== null && typeof model === "object" ? model : undefined;
    remember(this.owners, session, { agent, ...ref !== undefined ? { model: { ...ref } } : {} });
  }
  get(session) {
    return this.owners.get(session);
  }
}

class PendingCommands {
  now;
  pending = new Map;
  constructor(now = Date.now) {
    this.now = now;
  }
  note(session, command) {
    if (typeof session !== "string" || session === "" || typeof command !== "string" || command === "")
      return;
    remember(this.pending, session, { command, at: this.now() }, 1000);
  }
  take(session) {
    const entry = this.pending.get(session);
    this.pending.delete(session);
    return entry !== undefined && this.now() - entry.at <= PENDING_MS ? entry.command : undefined;
  }
}
async function waitForIdle(busy, options) {
  const deadline = options.now() + options.limitMs;
  let unreadable = 0;
  let pause = 200;
  for (;; ) {
    const state = await busy();
    if (state === false)
      return false;
    unreadable = state === undefined ? unreadable + 1 : 0;
    if (unreadable >= 3 || options.now() >= deadline)
      return state;
    await options.sleep(pause);
    pause = Math.min(pause * 2, 1000);
  }
}
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// plugin/isolate.ts
function isolateHelperRequest(messages, helpers) {
  let request = -1;
  for (let index = messages.length - 1;index >= 0; index--) {
    const message = messages[index];
    if (message?.info?.role === "user" && !isSyntheticMessage(message.parts)) {
      request = index;
      break;
    }
  }
  if (request <= 0)
    return 0;
  const agent = messages[request].info.agent;
  if (agent === undefined || !helpers.has(agent))
    return 0;
  const shared = messages.slice(0, request).some((message) => message?.info?.agent !== agent);
  if (!shared)
    return 0;
  messages.splice(0, request);
  return request;
}
var COMPACTION_WINDOW_MS = 60000;

class Compactions {
  now;
  started = new Map;
  constructor(now = Date.now) {
    this.now = now;
  }
  mark(session) {
    if (typeof session !== "string" || session === "")
      return;
    this.started.set(session, this.now());
    for (const [id, at] of this.started)
      if (this.now() - at > COMPACTION_WINDOW_MS)
        this.started.delete(id);
  }
  take(session) {
    if (typeof session !== "string")
      return false;
    const at = this.started.get(session);
    if (at === undefined)
      return false;
    this.started.delete(session);
    return this.now() - at <= COMPACTION_WINDOW_MS;
  }
}

// plugin/report.ts
var TOAST_DELAY_MS = 2000;
var TOAST_DURATION_MS = 15000;
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
function v1Reporter(name, client, schedule = defer) {
  const seen = new Set;
  const toasts = [];
  const log = (level, message) => {
    try {
      client?.app?.log?.({ body: { service: name, level, message } })?.catch?.(() => {
        return;
      });
    } catch {}
  };
  const toast = (message) => {
    toasts.push(message);
    if (toasts.length > 1)
      return;
    schedule(() => {
      const text = toasts.splice(0).join(`
`);
      try {
        client?.tui?.showToast?.({ body: { title: name, message: text, variant: "warning", duration: TOAST_DURATION_MS } })?.catch?.(() => {
          return;
        });
      } catch {}
    }, TOAST_DELAY_MS);
  };
  return {
    report(problems) {
      for (const problem of problems) {
        if (seen.has(problem.message))
          continue;
        seen.add(problem.message);
        log("warn", problem.message);
        if (problem.notify)
          toast(problem.message);
      }
    },
    internal(where, error) {
      const message = internalMessage(name, where, error);
      if (seen.has(message))
        return;
      seen.add(message);
      log("error", message);
    }
  };
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
function defer(run, ms) {
  const timer = setTimeout(run, ms);
  timer.unref?.();
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

// plugin/tools-v1.ts
function sessionApi(client) {
  const api = client?.session;
  if (api?.children === undefined || api.status === undefined || api.promptAsync === undefined || api.abort === undefined || api.get === undefined) {
    throw new Error("this opencode does not offer the session API the helper tools need");
  }
  return api;
}
async function busySessions(api) {
  const status = (await api.status())?.data ?? {};
  return new Set(Object.entries(status).filter(([, value]) => value?.type === "busy").map(([id]) => id));
}
function v1Tools(deps) {
  const { harness, activity, helpers } = deps;
  const agentOf = (id, info) => deps.agentOf(id) ?? (typeof info?.agent === "string" ? info.agent : "helper");
  const targetOf = async (api, id) => {
    const info = (await api.get({ path: { id } }).catch(() => {
      return;
    }))?.data;
    if (info === null || info === undefined)
      return;
    return { parentID: info.parentID, agent: agentOf(id, info) };
  };
  const children = async (api, context) => {
    const list = (await api.children({ path: { id: context.sessionID } }))?.data ?? [];
    return list.filter((item) => typeof item?.id === "string");
  };
  const status = {
    description: TOOL_SPECS.status.description,
    args: TOOL_SPECS.status.args,
    async execute(_args, context) {
      const api = sessionApi(deps.client);
      const [list, busy] = await Promise.all([children(api, context), busySessions(api)]);
      const ours = list.filter((item) => helpers.has(agentOf(item.id, item)));
      const views = ours.map((item) => {
        const record = activity.get(item.id);
        return {
          id: item.id,
          agent: agentOf(item.id, item),
          title: typeof item.title === "string" ? item.title : "",
          state: busy.has(item.id) ? "running" : record?.ended ?? "idle",
          steps: record?.steps ?? 0,
          startedAt: item.time?.created,
          updatedAt: record?.at ?? item.time?.updated,
          ...record?.lastTool === undefined ? {} : { lastTool: record.lastTool }
        };
      });
      return formatStatus(views);
    }
  };
  const steer = {
    description: TOOL_SPECS.steer.description,
    args: TOOL_SPECS.steer.args,
    async execute(args, context) {
      const id = requiredText(args, "id");
      const message = requiredText(args, "text");
      const api = sessionApi(deps.client);
      const target = await targetOf(api, id);
      const problem = targetProblem(target, id, context.sessionID, helpers);
      if (problem !== undefined)
        return problem;
      const agent = target.agent;
      if (!(await busySessions(api)).has(id))
        return notRunningResult(agent, id, `task_id: ${JSON.stringify(id)}`);
      await api.promptAsync({ path: { id }, body: { agent, parts: [{ type: "text", text: steerText(message, harness.defaultAgent) }] } });
      return steeredResult(agent, id);
    }
  };
  const cancel = {
    description: TOOL_SPECS.cancel.description,
    args: TOOL_SPECS.cancel.args,
    async execute(args, context) {
      const id = requiredText(args, "id");
      const api = sessionApi(deps.client);
      const busy = await busySessions(api);
      const targets = [];
      if (id === "all") {
        for (const item of await children(api, context)) {
          const agent = agentOf(item.id, item);
          if (busy.has(item.id) && helpers.has(agent))
            targets.push({ id: item.id, agent });
        }
      } else {
        const target = await targetOf(api, id);
        const problem = targetProblem(target, id, context.sessionID, helpers);
        if (problem !== undefined)
          return problem;
        if (!busy.has(id))
          return `${target.agent} ${id} is not running.`;
        targets.push({ id, agent: target.agent });
      }
      for (const target of targets) {
        await api.abort({ path: { id: target.id } });
        activity.end(target.id, "stopped");
      }
      return cancelledResult(targets);
    }
  };
  return { [HELPER_TOOLS.status]: status, [HELPER_TOOLS.steer]: steer, [HELPER_TOOLS.cancel]: cancel };
}

// plugin/v1.ts
var SHELL_TOOL = "bash";
var TOOL_LESS_AGENTS = new Set(["title", "summary", "compaction"]);
var LOOKUP_TIMEOUT_MS = 2000;
async function inTime(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
function v1ProjectRoot(input) {
  const worktree = input?.worktree;
  if (typeof worktree === "string" && worktree !== "" && worktree !== "/")
    return worktree;
  return typeof input?.directory === "string" && input.directory !== "" ? input.directory : undefined;
}

class SessionAgents {
  agents = new Map;
  children = new Map;
  set(session, agent) {
    if (typeof session !== "string" || typeof agent !== "string" || agent === "")
      return;
    remember(this.agents, session, agent);
    for (const child of this.children.keys())
      if (!this.agents.has(child))
        this.children.delete(child);
  }
  get(session) {
    return this.agents.get(session);
  }
  setChild(session, child) {
    if (!this.children.has(session))
      this.children.set(session, child);
  }
  isChild(session) {
    return this.children.get(session);
  }
}
function createServer(harness, options = {}) {
  return async function server(input) {
    const reporter = v1Reporter(harness.name, input?.client, options.schedule);
    let settings = mergeSettings([], harness);
    let plans = [];
    let platform = process.platform;
    try {
      const environment = (options.environment ?? processEnvironment)();
      platform = environment.platform;
      const loaded = loadSettings(harness, environment, v1ProjectRoot(input));
      settings = loaded.settings;
      reporter.report(loaded.problems);
    } catch (error) {
      reporter.internal("reading the settings", error);
    }
    try {
      const planned = planAgents(harness, settings);
      plans = planned.plans;
      reporter.report(planned.problems);
    } catch (error) {
      reporter.internal("planning the agents", error);
    }
    const sessions = new SessionAgents;
    const helpers = helperIds(harness);
    const compactions = new Compactions;
    const activity = new Activity;
    const fetchSession = async (session) => {
      const get = input?.client?.session?.get;
      if (typeof get !== "function")
        return;
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS);
        timer.unref?.();
      });
      try {
        const result = await Promise.race([get.call(input.client?.session, { path: { id: session } }), timeout]);
        const data = result?.data;
        if (data === null || data === undefined)
          return;
        if (typeof data.agent === "string" && sessions.get(session) === undefined)
          sessions.set(session, data.agent);
        sessions.setChild(session, typeof data.parentID === "string" && data.parentID !== "");
        return data;
      } finally {
        clearTimeout(timer);
      }
    };
    const lookup = async (session) => {
      const data = await fetchSession(session);
      return typeof data?.agent === "string" ? data.agent : undefined;
    };
    const ownerOfChild = async (session) => {
      const messages = input?.client?.session?.messages;
      if (typeof messages !== "function")
        return;
      const list = (await messages.call(input.client?.session, { path: { id: session } }))?.data ?? [];
      const first = list.find((item) => item?.info?.role === "user")?.info?.agent;
      return typeof first === "string" && helpers.has(first) ? first : undefined;
    };
    const tool = v1Tools({ harness, client: input?.client, agentOf: (session) => sessions.get(session), activity, helpers });
    const owners = new Owners;
    const now = options.now ?? Date.now;
    const pending = new PendingCommands(now);
    const waiting = { limitMs: options.inlineWaitLimitMs ?? INLINE_WAIT_LIMIT_MS, sleep: options.sleep ?? sleep, now };
    const busyState = async (session) => {
      const status = input?.client?.session?.status;
      if (typeof status !== "function")
        return;
      const data = (await inTime(status.call(input.client?.session), LOOKUP_TIMEOUT_MS).catch(() => {
        return;
      }))?.data;
      if (data === null || data === undefined)
        return;
      const type = data[session]?.type;
      return type !== undefined && type !== "idle";
    };
    const shareSession = async (session, target, parts, command) => {
      const completion = isCompletion(parts);
      const facts = async (busy) => ({
        agent: target.agent,
        completion,
        busy,
        running: sessions.get(session) ?? await lookup(session).catch(() => {
          return;
        })
      });
      let action = inlineAction(await facts(await busyState(session)), helpers);
      if (action === "wait") {
        if (await waitForIdle(() => busyState(session), waiting) !== false)
          return;
        if (target.time !== undefined)
          target.time.created = now();
        action = inlineAction(await facts(false), helpers);
      }
      if (action !== "owner" && action !== "subtask")
        return;
      const owner = owners.get(session) ?? { agent: harness.defaultAgent };
      const plan = plans.find((item) => item.id === owner.agent);
      if (action === "subtask") {
        const helper = target.agent;
        const known = harness.commands.find((item) => item.id === command && item.agent === helper);
        const model = typeof target.model?.providerID === "string" && typeof target.model.modelID === "string" ? { providerID: target.model.providerID, modelID: target.model.modelID } : undefined;
        const spec = { agent: helper, description: known?.description ?? "", ...command !== undefined ? { command } : {}, ...model !== undefined ? { model } : {} };
        if (!Array.isArray(parts) || !toSubtask(parts, spec))
          return;
      }
      giveTo(target, owner, plan);
    };
    return {
      async config(config) {
        try {
          if (typeof config !== "object" || config === null)
            return;
          reporter.report(applyToV1Config(config, harness, settings, plans));
        } catch (error) {
          reporter.internal("the config hook", error);
        }
      },
      tool,
      async event(input) {
        try {
          const event = input?.event;
          if (event?.type === "session.created") {
            const info = event.properties?.info;
            if (typeof info?.id === "string")
              sessions.setChild(info.id, typeof info.parentID === "string" && info.parentID !== "");
          } else if (event?.type === "session.error") {
            activity.end(event.properties?.sessionID, "failed");
          }
        } catch (error) {
          reporter.internal("the event hook", error);
        }
      },
      async "command.execute.before"(command) {
        try {
          pending.note(command?.sessionID, command?.command);
        } catch (error) {
          reporter.internal("the command hook", error);
        }
      },
      async "chat.message"(message, output) {
        try {
          const session = message?.sessionID;
          const target = output?.message;
          if (typeof session === "string" && target !== undefined && target !== null) {
            const command = isSyntheticMessage(output?.parts) ? undefined : pending.take(session);
            let helper = sessions.get(session);
            if (sessions.isChild(session) === undefined) {
              try {
                await fetchSession(session);
                if (sessions.isChild(session) === true && (helper === undefined || !helpers.has(helper))) {
                  const owner = await ownerOfChild(session);
                  if (owner !== undefined) {
                    sessions.set(session, owner);
                    helper = owner;
                  }
                }
              } catch (error) {
                reporter.internal("looking up a session", error);
              }
            }
            if (helper !== undefined && helpers.has(helper) && sessions.isChild(session) === true) {
              pinMessage(target, helper, plans.find((plan) => plan.id === helper));
            }
            if (sessions.isChild(session) === false) {
              await shareSession(session, target, output?.parts, command);
              const agent = target.agent;
              if (typeof agent === "string" && !helpers.has(agent) && !TOOL_LESS_AGENTS.has(agent))
                owners.note(session, agent, target.model);
            }
          }
          activity.resume(session);
          sessions.set(session, output?.message?.agent ?? message?.agent);
        } catch (error) {
          reporter.internal("the chat.message hook", error);
        }
      },
      async "chat.params"(request) {
        try {
          const agent = request?.agent;
          if (TOOL_LESS_AGENTS.has(agent))
            return;
          sessions.set(request?.sessionID, agent);
          if (typeof agent === "string" && !helpers.has(agent))
            owners.note(request?.sessionID, agent, request?.message?.model);
        } catch (error) {
          reporter.internal("the chat.params hook", error);
        }
      },
      async "tool.execute.before"(call, output) {
        let message;
        if (HELPER_TOOL_IDS.includes(call?.tool)) {
          try {
            const agent = sessions.get(call.sessionID) ?? await lookup(call.sessionID);
            message = toolCallBlock(harness, agent, call.tool);
          } catch (error) {
            reporter.internal("verifying the caller of a helper tool", error);
            message = toolCallBlock(harness, undefined, call.tool);
          }
        } else if (call?.tool === SHELL_TOOL) {
          try {
            const command = output?.args?.command;
            if (typeof command === "string") {
              const agent = sessions.get(call.sessionID) ?? await lookup(call.sessionID);
              message = checkShellCommand(harness, agent, command, platform)?.message;
            }
          } catch (error) {
            reporter.internal("the shell guard", error);
            return;
          }
        }
        try {
          if (message === undefined)
            activity.observe(call?.sessionID, call?.tool, output?.args);
        } catch (error) {
          reporter.internal("recording a tool call", error);
        }
        if (message !== undefined)
          throw new Error(message);
      },
      async "experimental.session.compacting"(compaction) {
        try {
          compactions.mark(compaction?.sessionID);
        } catch (error) {
          reporter.internal("the compaction hook", error);
        }
      },
      async "experimental.chat.messages.transform"(_input, output) {
        try {
          const messages = output?.messages;
          if (!Array.isArray(messages) || messages.length === 0)
            return;
          if (compactions.take(messages[0]?.info?.sessionID))
            return;
          isolateHelperRequest(messages, helpers);
        } catch (error) {
          reporter.internal("the message transform hook", error);
        }
      }
    };
  };
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
function sessionApi2(ctx) {
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
    const info = await sessionApi2(deps.ctx).get({ sessionID: id }).catch(() => {
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
      await sessionApi2(deps.ctx).prompt({ sessionID: id, text: steerText(message, harness.defaultAgent), delivery: "steer" });
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
        await sessionApi2(deps.ctx).interrupt({ sessionID: target.id });
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
    server: createServer(harness, options),
    setup: createSetup(harness, options)
  };
}

// plugin/index.ts
var plugin_default = createPlugin({ name: "ecmwf-multi-agents", version: "0.3.0", defaultAgent: "lead", defaultProfile: "default", profiles: [{ id: "anthropic", description: "Anthropic models only. The reviewer uses the strongest model, since a different family is not available.", agents: { lead: { model: "anthropic/claude-opus-5-5", effort: "xhigh" }, scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" }, builder: { model: "anthropic/claude-sonnet-5-5", effort: "high" }, reviewer: { model: "anthropic/claude-opus-5-5", effort: "high" } } }, { id: "copilot", description: "GitHub Copilot models only, with the same split as the default profile.", agents: { lead: { model: "github-copilot/claude-opus-5.5", effort: "xhigh" }, scout: { model: "github-copilot/claude-sonnet-5.5", effort: "medium" }, builder: { model: "github-copilot/claude-sonnet-5.5", effort: "high" }, reviewer: { model: "github-copilot/gpt-6.1-sol", effort: "medium" } } }, { id: "default", description: "Anthropic for lead, scout and builder; GitHub Copilot GPT for the reviewer, so reviews come from a different model family.", agents: { lead: { model: "anthropic/claude-opus-5-5", effort: "xhigh" }, scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" }, builder: { model: "anthropic/claude-sonnet-5-5", effort: "high" }, reviewer: { model: "github-copilot/gpt-6.1-sol", effort: "medium" } } }, { id: "inherit", description: "Every agent uses the model selected in the session. Helpers still differ by step limit.", agents: {} }], agents: [{ id: "lead", mode: "primary", shell: [{ resource: "git push *", effect: "ask" }, { resource: "git -C * push *", effect: "ask" }, { resource: "git commit --amend *", effect: "ask" }, { resource: "git reset --hard *", effect: "ask" }, { resource: "git clean *", effect: "ask" }, { resource: "git rebase *", effect: "ask" }, { resource: "git branch -D *", effect: "ask" }, { resource: "git restore *", effect: "ask" }, { resource: "git checkout -- *", effect: "ask" }, { resource: "git stash drop *", effect: "ask" }, { resource: "git stash clear *", effect: "ask" }, { resource: "gh pr create *", effect: "ask" }, { resource: "gh pr merge *", effect: "ask" }, { resource: "gh pr close *", effect: "ask" }, { resource: "gh release *", effect: "ask" }, { resource: "gh repo delete *", effect: "ask" }] }, { id: "scout", mode: "subagent", shell: [{ resource: "*", effect: "deny" }, { resource: "git log *", effect: "allow" }, { resource: "git show *", effect: "allow" }, { resource: "git diff *", effect: "allow" }, { resource: "git blame *", effect: "allow" }, { resource: "git status *", effect: "allow" }, { resource: "git grep *", effect: "allow" }, { resource: "git ls-files *", effect: "allow" }, { resource: "git rev-parse *", effect: "allow" }, { resource: "ls *", effect: "allow" }, { resource: "wc *", effect: "allow" }, { resource: "file *", effect: "allow" }, { resource: "tree *", effect: "allow" }] }, { id: "builder", mode: "subagent", shell: [{ resource: "git add *", effect: "deny" }, { resource: "git commit *", effect: "deny" }, { resource: "git push *", effect: "deny" }, { resource: "git pull *", effect: "deny" }, { resource: "git fetch *", effect: "deny" }, { resource: "git reset *", effect: "deny" }, { resource: "git rebase *", effect: "deny" }, { resource: "git merge *", effect: "deny" }, { resource: "git cherry-pick *", effect: "deny" }, { resource: "git revert *", effect: "deny" }, { resource: "git am *", effect: "deny" }, { resource: "git checkout *", effect: "deny" }, { resource: "git switch *", effect: "deny" }, { resource: "git restore *", effect: "deny" }, { resource: "git stash *", effect: "deny" }, { resource: "git clean *", effect: "deny" }, { resource: "git rm *", effect: "deny" }, { resource: "git mv *", effect: "deny" }, { resource: "git tag *", effect: "deny" }, { resource: "git branch *", effect: "deny" }, { resource: "git remote *", effect: "deny" }, { resource: "git worktree *", effect: "deny" }, { resource: "git update-ref *", effect: "deny" }, { resource: "git config *", effect: "deny" }, { resource: "git -C *", effect: "deny" }, { resource: "gh *", effect: "deny" }] }, { id: "reviewer", mode: "subagent", shell: [{ resource: "git add *", effect: "deny" }, { resource: "git commit *", effect: "deny" }, { resource: "git push *", effect: "deny" }, { resource: "git pull *", effect: "deny" }, { resource: "git fetch *", effect: "deny" }, { resource: "git reset *", effect: "deny" }, { resource: "git rebase *", effect: "deny" }, { resource: "git merge *", effect: "deny" }, { resource: "git cherry-pick *", effect: "deny" }, { resource: "git revert *", effect: "deny" }, { resource: "git am *", effect: "deny" }, { resource: "git checkout *", effect: "deny" }, { resource: "git switch *", effect: "deny" }, { resource: "git restore *", effect: "deny" }, { resource: "git stash *", effect: "deny" }, { resource: "git clean *", effect: "deny" }, { resource: "git rm *", effect: "deny" }, { resource: "git mv *", effect: "deny" }, { resource: "git tag *", effect: "deny" }, { resource: "git branch *", effect: "deny" }, { resource: "git remote *", effect: "deny" }, { resource: "git worktree *", effect: "deny" }, { resource: "git update-ref *", effect: "deny" }, { resource: "git config *", effect: "deny" }, { resource: "git -C *", effect: "deny" }, { resource: "gh *", effect: "deny" }, { resource: "gh pr view *", effect: "allow" }, { resource: "gh pr diff *", effect: "allow" }, { resource: "gh pr checks *", effect: "allow" }] }], commands: [{ id: "onboard", agent: "lead", description: "Survey this repository and keep a short summary for later sessions" }, { id: "plan", agent: "lead", description: "Plan a piece of work with you, then wait for your approval" }, { id: "go", agent: "lead", description: "Carry out an approved plan task by task" }, { id: "review", agent: "reviewer", description: "Independent review of your uncommitted changes, a branch, a commit, a pull request or a plan" }, { id: "progress", agent: "scout", description: "Show progress on the current plan" }, { id: "guide", agent: "lead", description: "How this harness works, in plain words" }] });
export {
  plugin_default as default
};
