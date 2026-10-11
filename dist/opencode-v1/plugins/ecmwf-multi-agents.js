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

// plugin/isolate.ts
function isolateHelperRequest(messages, helpers) {
  let request = -1;
  for (let index = messages.length - 1;index >= 0; index--) {
    if (messages[index]?.info?.role === "user") {
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

// plugin/v1.ts
var SHELL_TOOL = "bash";
var TOOL_LESS_AGENTS = new Set(["title", "summary", "compaction"]);
var LOOKUP_TIMEOUT_MS = 2000;
var MAX_SESSIONS = 5000;
function v1ProjectRoot(input) {
  const worktree = input?.worktree;
  if (typeof worktree === "string" && worktree !== "" && worktree !== "/")
    return worktree;
  return typeof input?.directory === "string" && input.directory !== "" ? input.directory : undefined;
}

class SessionAgents {
  agents = new Map;
  set(session, agent) {
    if (typeof session !== "string" || typeof agent !== "string" || agent === "")
      return;
    this.agents.delete(session);
    this.agents.set(session, agent);
    if (this.agents.size > MAX_SESSIONS) {
      const oldest = this.agents.keys().next().value;
      if (oldest !== undefined)
        this.agents.delete(oldest);
    }
  }
  get(session) {
    return this.agents.get(session);
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
    const helpers = new Set(harness.agents.filter((agent) => agent.mode === "subagent").map((agent) => agent.id));
    const compactions = new Compactions;
    const lookup = async (session) => {
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
        const agent = result?.data?.agent;
        if (typeof agent === "string")
          sessions.set(session, agent);
        return typeof agent === "string" ? agent : undefined;
      } finally {
        clearTimeout(timer);
      }
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
      async "chat.message"(message, output) {
        try {
          sessions.set(message?.sessionID, output?.message?.agent ?? message?.agent);
        } catch (error) {
          reporter.internal("the chat.message hook", error);
        }
      },
      async "chat.params"(request) {
        try {
          if (!TOOL_LESS_AGENTS.has(request?.agent))
            sessions.set(request?.sessionID, request?.agent);
        } catch (error) {
          reporter.internal("the chat.params hook", error);
        }
      },
      async "tool.execute.before"(call, output) {
        let block;
        try {
          if (call?.tool !== SHELL_TOOL)
            return;
          const command = output?.args?.command;
          if (typeof command !== "string")
            return;
          const agent = sessions.get(call.sessionID) ?? await lookup(call.sessionID);
          block = checkShellCommand(harness, agent, command, platform);
        } catch (error) {
          reporter.internal("the shell guard", error);
          return;
        }
        if (block !== undefined)
          throw new Error(block.message);
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
function watchActivations(ctx, onActivation, reporter, fallbackMs) {
  const controller = new AbortController;
  let seen = false;
  const subscribe = ctx.event?.subscribe;
  if (typeof subscribe === "function") {
    (async () => {
      for await (const event of subscribe.call(ctx.event, { signal: controller.signal })) {
        if (controller.signal.aborted)
          return;
        if (event?.type !== "plugin.updated")
          continue;
        seen = true;
        onActivation();
      }
    })().catch((error) => {
      if (!controller.signal.aborted)
        reporter.internal("watching plugin activations", error);
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
      const late = new LateTransform(ctx, (editor) => {
        try {
          reporter.report(applyToV2Agents(editor, harness, settings, plans));
        } catch (error) {
          reporter.internal("the agent transform", error);
        }
      }, reporter);
      const stopWatching = watchActivations(ctx, () => void late.register(), reporter, options.fallbackMs ?? FALLBACK_MS);
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
var plugin_default = createPlugin({ name: "ecmwf-multi-agents", version: "0.2.0", defaultAgent: "lead", defaultProfile: "default", profiles: [{ id: "anthropic", description: "Anthropic models only. The reviewer uses the strongest model, since a different family is not available.", agents: { lead: { model: "anthropic/claude-opus-5-5", effort: "xhigh" }, scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" }, builder: { model: "anthropic/claude-sonnet-5-5", effort: "high" }, reviewer: { model: "anthropic/claude-opus-5-5", effort: "high" } } }, { id: "copilot", description: "GitHub Copilot models only, with the same split as the default profile.", agents: { lead: { model: "github-copilot/claude-opus-5.5", effort: "xhigh" }, scout: { model: "github-copilot/claude-sonnet-5.5", effort: "medium" }, builder: { model: "github-copilot/claude-sonnet-5.5", effort: "high" }, reviewer: { model: "github-copilot/gpt-6.1-sol", effort: "medium" } } }, { id: "default", description: "Anthropic for lead, scout and builder; GitHub Copilot GPT for the reviewer, so reviews come from a different model family.", agents: { lead: { model: "anthropic/claude-opus-5-5", effort: "xhigh" }, scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" }, builder: { model: "anthropic/claude-sonnet-5-5", effort: "high" }, reviewer: { model: "github-copilot/gpt-6.1-sol", effort: "medium" } } }, { id: "inherit", description: "Every agent uses the model selected in the session. Helpers still differ by step limit.", agents: {} }], agents: [{ id: "lead", mode: "primary", shell: [{ resource: "git push *", effect: "ask" }, { resource: "git -C * push *", effect: "ask" }, { resource: "git commit --amend *", effect: "ask" }, { resource: "git reset --hard *", effect: "ask" }, { resource: "git clean *", effect: "ask" }, { resource: "git rebase *", effect: "ask" }, { resource: "git branch -D *", effect: "ask" }, { resource: "git restore *", effect: "ask" }, { resource: "git checkout -- *", effect: "ask" }, { resource: "git stash drop *", effect: "ask" }, { resource: "git stash clear *", effect: "ask" }, { resource: "gh pr create *", effect: "ask" }, { resource: "gh pr merge *", effect: "ask" }, { resource: "gh pr close *", effect: "ask" }, { resource: "gh release *", effect: "ask" }, { resource: "gh repo delete *", effect: "ask" }] }, { id: "scout", mode: "subagent", shell: [{ resource: "*", effect: "deny" }, { resource: "git log *", effect: "allow" }, { resource: "git show *", effect: "allow" }, { resource: "git diff *", effect: "allow" }, { resource: "git blame *", effect: "allow" }, { resource: "git status *", effect: "allow" }, { resource: "git grep *", effect: "allow" }, { resource: "git ls-files *", effect: "allow" }, { resource: "git rev-parse *", effect: "allow" }, { resource: "ls *", effect: "allow" }, { resource: "wc *", effect: "allow" }, { resource: "file *", effect: "allow" }, { resource: "tree *", effect: "allow" }] }, { id: "builder", mode: "subagent", shell: [{ resource: "git add *", effect: "deny" }, { resource: "git commit *", effect: "deny" }, { resource: "git push *", effect: "deny" }, { resource: "git pull *", effect: "deny" }, { resource: "git fetch *", effect: "deny" }, { resource: "git reset *", effect: "deny" }, { resource: "git rebase *", effect: "deny" }, { resource: "git merge *", effect: "deny" }, { resource: "git cherry-pick *", effect: "deny" }, { resource: "git revert *", effect: "deny" }, { resource: "git am *", effect: "deny" }, { resource: "git checkout *", effect: "deny" }, { resource: "git switch *", effect: "deny" }, { resource: "git restore *", effect: "deny" }, { resource: "git stash *", effect: "deny" }, { resource: "git clean *", effect: "deny" }, { resource: "git rm *", effect: "deny" }, { resource: "git mv *", effect: "deny" }, { resource: "git tag *", effect: "deny" }, { resource: "git branch *", effect: "deny" }, { resource: "git remote *", effect: "deny" }, { resource: "git worktree *", effect: "deny" }, { resource: "git update-ref *", effect: "deny" }, { resource: "git config *", effect: "deny" }, { resource: "git -C *", effect: "deny" }, { resource: "gh *", effect: "deny" }] }, { id: "reviewer", mode: "subagent", shell: [{ resource: "git add *", effect: "deny" }, { resource: "git commit *", effect: "deny" }, { resource: "git push *", effect: "deny" }, { resource: "git pull *", effect: "deny" }, { resource: "git fetch *", effect: "deny" }, { resource: "git reset *", effect: "deny" }, { resource: "git rebase *", effect: "deny" }, { resource: "git merge *", effect: "deny" }, { resource: "git cherry-pick *", effect: "deny" }, { resource: "git revert *", effect: "deny" }, { resource: "git am *", effect: "deny" }, { resource: "git checkout *", effect: "deny" }, { resource: "git switch *", effect: "deny" }, { resource: "git restore *", effect: "deny" }, { resource: "git stash *", effect: "deny" }, { resource: "git clean *", effect: "deny" }, { resource: "git rm *", effect: "deny" }, { resource: "git mv *", effect: "deny" }, { resource: "git tag *", effect: "deny" }, { resource: "git branch *", effect: "deny" }, { resource: "git remote *", effect: "deny" }, { resource: "git worktree *", effect: "deny" }, { resource: "git update-ref *", effect: "deny" }, { resource: "git config *", effect: "deny" }, { resource: "git -C *", effect: "deny" }, { resource: "gh *", effect: "deny" }, { resource: "gh pr view *", effect: "allow" }, { resource: "gh pr diff *", effect: "allow" }, { resource: "gh pr checks *", effect: "allow" }] }] });
export {
  plugin_default as default
};
