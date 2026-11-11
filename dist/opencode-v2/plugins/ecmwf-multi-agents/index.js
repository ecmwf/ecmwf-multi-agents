// managed by ecmwf-multi-agents
// plugin/v2.ts
import path6 from "path";
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
var INLINE_WAKE_TEXT = "Reports from your helpers arrived while a helper answered a command here, so they were held back until it had finished. They are above: act on them now.";
var INLINE_USER_WAKE_TEXT = "The user wrote to you while a helper answered a command here, so the message was held back from the helper until it had finished; nothing after it answers it. It is above, after the command: answer it now.";
var INLINE_USER_AND_REPORTS_WAKE_TEXT = "The user wrote to you, and reports from your helpers arrived, while a helper answered a command here, so they were held back from the helper until it had finished; nothing after the user's message answers it. They are above, after the command: answer the user first, then act on the reports.";
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
function continuedAfter(messages, index) {
  for (let next = index + 1;next < messages.length; next += 1) {
    const message = messages[next];
    if (continueNote(message))
      return true;
    if (message?.role === "user" && firstText(message).startsWith(V2_REPORT_PREFIX))
      continue;
    return false;
  }
  return false;
}
function stepsV2(messages) {
  return messages.map((message, index) => {
    if (message?.role === "user") {
      if (continueNote(message))
        return "other";
      const text = firstText(message);
      if (text.startsWith(V2_REPORT_PREFIX))
        return "report";
      if (text.startsWith(V2_CHECKPOINT_PREFIX) || text.startsWith(WAKE_TEXT) || text.startsWith(INLINE_WAKE_TEXT))
        return "boundary";
      return "request";
    }
    if (message?.role === "assistant") {
      if (continuedAfter(messages, index))
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

// plugin/helper-list.ts
function helpersOf(harness) {
  return harness.agents.filter((agent) => agent.id !== harness.defaultAgent && agent.mode === "subagent");
}
function enabledHelpers(harness, settings) {
  const on = new Set;
  for (const helper of helpersOf(harness)) {
    if (settings.agents[helper.id]?.enabled ?? helper.optional !== true)
      on.add(helper.id);
  }
  return on;
}
var line = (id, text) => `- ${id}: ${text}`;
var bare = (text) => text.endsWith("\r") ? text.slice(0, -1) : text;
function rewriteHelperList(prompt, helpers, on, helperOff, agent) {
  const added = new Set(helpers.filter((helper) => helper.optional === true && helper.routing !== undefined).map((helper) => line(helper.id, helper.routing)));
  if (helperOff !== undefined)
    added.add(`- ${helperOff}`);
  const defaults = helpers.filter((helper) => helper.optional !== true);
  const lines = prompt.split(`
`);
  const isDefault = (text) => defaults.some((helper) => bare(text).startsWith(`- ${helper.id}: `));
  for (const helper of defaults.filter((item) => on.has(item.id))) {
    const count = lines.filter((text) => bare(text).startsWith(`- ${helper.id}: `)).length;
    if (count !== 1) {
      const shown = count === 0 ? "no line" : `${count} lines`;
      return { problem: `the prompt of ${agent} has ${shown} "- ${helper.id}: ..."; its helper list was left as it is, so it may name helpers that are off and miss ones that are on` };
    }
  }
  let anchor = -1;
  lines.forEach((text, index) => {
    if (isDefault(text) || added.has(bare(text)))
      anchor = index;
  });
  if (anchor === -1) {
    return defaults.length === 0 ? { prompt } : { problem: `the prompt of ${agent} has no helper list; it was left as it is, so it may name helpers that are off and miss ones that are on` };
  }
  const ending = lines[anchor].endsWith("\r") ? "\r" : "";
  const insert = helpers.filter((helper) => helper.optional === true && helper.routing !== undefined && on.has(helper.id)).map((helper) => line(helper.id, helper.routing) + ending);
  if (helperOff !== undefined && defaults.some((helper) => !on.has(helper.id)))
    insert.push(`- ${helperOff}${ending}`);
  const off = defaults.filter((helper) => !on.has(helper.id)).map((helper) => `- ${helper.id}: `);
  const out = [];
  lines.forEach((text, index) => {
    if (!added.has(bare(text)) && !off.some((start) => bare(text).startsWith(start)))
      out.push(text);
    if (index === anchor)
      out.push(...insert);
  });
  return { prompt: out.join(`
`) };
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
      if (override.fallback !== undefined && override.fallback.length > 0)
        plan.fallback = override.fallback;
    } else if (fromProfile?.model !== undefined) {
      plan.model = fromProfile.model;
      const effort = override.effort ?? fromProfile.effort;
      if (effort !== undefined)
        plan.effort = effort;
      const fallback = override.fallback ?? fromProfile.fallback;
      if (fallback !== undefined && fallback.length > 0)
        plan.fallback = fallback;
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
var HELPER_SLOTS_LINE = /^Run at most \S+ helpers? at once\./gm;
function helperSlotsLine(prompt) {
  const matches = prompt.match(HELPER_SLOTS_LINE) ?? [];
  return matches.length === 1 ? matches[0] : null;
}
function rewriteHelperSlotsLine(prompt, slots, agent) {
  const count = prompt.match(HELPER_SLOTS_LINE)?.length ?? 0;
  if (count !== 1) {
    return { problem: `the prompt of ${agent} has ${count === 0 ? "no" : count} "Run at most ... helpers at once." instruction${count > 1 ? "s" : ""}; max_helper_slots was not applied` };
  }
  return { prompt: prompt.replace(HELPER_SLOTS_LINE, `Run at most ${slots} ${slots === 1 ? "helper" : "helpers"} at once.`) };
}
function rewriteReviewLine(prompt, policy, agent, meanings) {
  const count = prompt.match(REVIEW_LINE)?.length ?? 0;
  if (count === 0)
    return { problem: `the prompt of ${agent} has no "Review policy:" line, so the review policy stays as the prompt says` };
  if (count > 1)
    return { problem: `the prompt of ${agent} has ${count} "Review policy:" lines instead of one, so none was changed` };
  const lines = prompt.split(`
`);
  const at = lines.findIndex((line) => line.startsWith("Review policy:"));
  const ending = (line) => line.endsWith("\r") ? "\r" : "";
  lines[at] = `Review policy: ${policy}${ending(lines[at])}`;
  const next = lines[at + 1];
  if (meanings !== undefined && next !== undefined && Object.values(meanings).includes(next.replace(/\r$/, ""))) {
    lines[at + 1] = `${meanings[policy]}${ending(next)}`;
  }
  return { prompt: lines.join(`
`) };
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
function reviewerId(harness) {
  return harness.commands.find((command) => command.name === "review")?.agent ?? "reviewer";
}
function effectiveReview(harness, settings, on = enabledHelpers(harness, settings)) {
  const reviewer = reviewerId(harness);
  return helpersOf(harness).some((helper) => helper.id === reviewer) && !on.has(reviewer) ? "never" : settings.review;
}
function helpersSwitched(harness, on) {
  return helpersOf(harness).some((helper) => on.has(helper.id) === (helper.optional === true));
}
function applyToV2Agents(editor, harness, settings, plans) {
  const problems = [];
  const changes = [];
  const helpers = helpersOf(harness);
  const on = enabledHelpers(harness, settings);
  const off = new Set(helpers.filter((helper) => !on.has(helper.id)).map((helper) => helper.id));
  for (const helper of helpers) {
    if (helper.optional === true || !off.has(helper.id) || editor.get(helper.id) === undefined)
      continue;
    if (typeof editor.remove === "function")
      changes.push(() => editor.remove(helper.id));
    else
      problems.push({ message: `${harness.name}: this opencode cannot remove agents, so ${helper.id} stays although it is switched off`, notify: true });
  }
  for (const plan of plans) {
    if (off.has(plan.id) || editor.get(plan.id) === undefined)
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
  const review = effectiveReview(harness, settings, on);
  if (review !== settings.review && settings.reviewSet) {
    problems.push({ message: `${harness.name}: the review policy "${settings.review}" needs the reviewer, which is switched off, so nothing is reviewed`, notify: true });
  }
  const lead = editor.get(harness.defaultAgent);
  if (lead !== undefined) {
    const allows = helpers.filter((helper) => helper.optional === true && on.has(helper.id));
    if (allows.length > 0) {
      changes.push(() => editor.update(harness.defaultAgent, (agent) => {
        if (!Array.isArray(agent.permissions))
          agent.permissions = [];
        const rules = agent.permissions;
        for (const helper of allows) {
          const last = [...rules].reverse().find((rule) => rule.action === "subagent" && rule.resource === helper.id);
          if (last?.effect !== "allow")
            rules.push({ action: "subagent", resource: helper.id, effect: "allow" });
        }
      }));
    }
    if (typeof lead.system === "string") {
      const result = rewriteReviewLine(lead.system, review, harness.defaultAgent, harness.reviewPolicies);
      if (result.problem !== undefined)
        problems.push(reviewProblem(harness, settings, result.problem));
      const slots = rewriteHelperSlotsLine(result.prompt ?? lead.system, settings.maxHelperSlots, harness.defaultAgent);
      if (slots.problem !== undefined)
        problems.push({ message: `${harness.name}: ${slots.problem}`, notify: settings.maxHelperSlotsSet });
      let prompt = slots.prompt ?? result.prompt;
      if (helpersSwitched(harness, on)) {
        const list = rewriteHelperList(prompt ?? lead.system, helpers, on, harness.helperOff, harness.defaultAgent);
        if (list.problem !== undefined)
          problems.push({ message: `${harness.name}: ${list.problem}`, notify: true });
        else
          prompt = list.prompt;
      }
      if (prompt !== undefined) {
        const system = prompt;
        changes.push(() => editor.update(harness.defaultAgent, (agent) => agent.system = system));
      }
    } else {
      problems.push(reviewProblem(harness, settings, `${harness.defaultAgent} has no prompt, so the review policy was not applied`));
      problems.push({ message: `${harness.name}: ${harness.defaultAgent} has no prompt, so max_helper_slots was not applied`, notify: settings.maxHelperSlotsSet });
    }
  }
  for (const change of changes)
    change();
  return problems;
}

// plugin/environment.ts
import { appendFileSync, mkdirSync, readFileSync, statSync } from "fs";
import os from "os";
import path from "path";
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
    },
    isDirectory(file) {
      return statSync(file, { throwIfNoEntry: false })?.isDirectory() ?? false;
    },
    appendFile(file, text) {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, text);
    }
  };
}

// plugin/git-exclude.ts
import path2 from "path";
function gitExcludeFile(directory, environment) {
  let dir = path2.resolve(directory);
  for (;; ) {
    const dotGit = path2.join(dir, ".git");
    if (environment.isDirectory(dotGit))
      return path2.join(commonDir(dotGit, environment), "info", "exclude");
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(environment.readFile(dotGit) ?? "")?.[1];
    if (gitdir !== undefined) {
      const resolved = path2.resolve(dir, gitdir);
      return path2.join(commonDir(resolved, environment), "info", "exclude");
    }
    const parent = path2.dirname(dir);
    if (parent === dir)
      return;
    dir = parent;
  }
}
function commonDir(gitDir, environment) {
  const common = environment.readFile(path2.join(gitDir, "commondir"))?.trim();
  return common === undefined || common === "" ? gitDir : path2.resolve(gitDir, common);
}
function workDirListed(text, workDir) {
  const name = workDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^/?${name}/?[ \\t]*\\r?$`, "m").test(text);
}
function excludeWorkDir(directory, workDir, environment) {
  let file;
  try {
    file = gitExcludeFile(directory, environment);
    if (file === undefined)
      return { state: "outside" };
    const text = environment.readFile(file) ?? "";
    if (workDirListed(text, workDir))
      return { state: "listed", file };
    environment.appendFile(file, `${text === "" || text.endsWith(`
`) ? "" : `
`}${workDir}/
`);
    return { state: "added", file };
  } catch (error) {
    return { state: "failed", file: file ?? directory, error: error instanceof Error ? error.message : String(error) };
  }
}

// plugin/register.ts
import path3 from "path";
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
    return (path3.posix.isAbsolute(home) ? path3.posix : path3.win32).join(home, relative);
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
    path: path3.resolve(pluginDir, "..", "..", "skills", skill.id, "SKILL.md"),
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
  const on = options.helpers ?? enabledHelpers(harness, { agents: {} });
  const helpers = new Set(helpersOf(harness).map((helper) => helper.id));
  const agents = harness.agents.filter((agent) => !helpers.has(agent.id) || on.has(agent.id));
  try {
    await ctx.agent.transform((editor) => {
      try {
        for (const embedded of agents)
          editor.update(embedded.id, (agent) => applyAgent(agent, embedded, options.home));
        if (options.defaultAgent)
          editor.default(harness.defaultAgent);
        options.ruleOrder?.addProbe(editor);
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

// plugin/fallback.ts
function parts(model) {
  const slash = model.indexOf("/");
  if (slash < 0)
    return;
  const hash = model.indexOf("#", slash);
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1, hash < 0 ? undefined : hash) };
}
function unusableReason(model, available) {
  const ref = parts(model);
  if (ref === undefined)
    return "it is not written as provider/model";
  if (!available.providers.includes(ref.providerID))
    return `provider ${ref.providerID} is not available`;
  if (available.models !== undefined && !available.models.some((item) => item.providerID === ref.providerID && item.id === ref.id)) {
    return `model ${ref.id} is not available for provider ${ref.providerID}`;
  }
  return;
}
function chooseModel(primary, fallback, available) {
  if (available === "unknown")
    return { choice: primary, index: 0, notes: [] };
  const candidates = [primary, ...fallback];
  const notes = [];
  for (const [index, candidate] of candidates.entries()) {
    const reason = unusableReason(candidate.model, available);
    if (reason === undefined)
      return { choice: candidate, index, notes };
    notes.push(`${candidate.model} skipped: ${reason}`);
  }
  const tried = candidates.length === 1 ? "its model" : `its model and ${candidates.length - 1} fallback${candidates.length === 2 ? "" : "s"}`;
  return {
    choice: primary,
    index: 0,
    notes,
    problem: { message: `none of ${tried} is usable, so ${primary.model} stays: ${notes.join("; ")}`, notify: true }
  };
}
var READ_TIMEOUT_MS = 5000;
async function entriesOf(read, timeoutMs) {
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
      timer.unref?.();
    });
    const value = unwrap(await Promise.race([Promise.resolve().then(read), timeout]));
    return Array.isArray(value) ? value : undefined;
  } catch {
    return;
  } finally {
    clearTimeout(timer);
  }
}
function text(entry, key) {
  const value = entry !== null && typeof entry === "object" ? entry[key] : undefined;
  return typeof value === "string" && value !== "" ? value : undefined;
}
async function readAvailability(source, timeoutMs = READ_TIMEOUT_MS) {
  const providers = await entriesOf(() => source.provider?.list?.(), timeoutMs);
  if (providers === undefined)
    return "unknown";
  const ids = providers.flatMap((entry) => {
    const id = text(entry, "id");
    return id === undefined || text(entry, "activation") === "disabled" ? [] : [id];
  });
  const models = await entriesOf(() => source.model?.list?.(), timeoutMs);
  if (models === undefined)
    return { providers: ids };
  return {
    providers: ids,
    models: models.flatMap((entry) => {
      const id = text(entry, "id");
      const providerID = text(entry, "providerID");
      return id === undefined || providerID === undefined ? [] : [{ id, providerID }];
    })
  };
}

class ModelChoices {
  name;
  base;
  active;
  chosen = new Map;
  results = new Map;
  told = new Map;
  constructor(name, base, active = () => true) {
    this.name = name;
    this.base = base;
    this.active = active;
  }
  plans() {
    return this.base.map((plan) => {
      const result = this.results.get(plan.id);
      if (result === undefined || plan.model === undefined)
        return plan;
      const { effort: _own, ...rest } = plan;
      return { ...rest, model: result.model, ...result.effort === undefined ? {} : { effort: result.effort } };
    });
  }
  update(availability) {
    const update = { changed: false, problems: [] };
    for (const plan of this.base) {
      if (plan.model === undefined || plan.fallback === undefined || plan.fallback.length === 0)
        continue;
      const primary = { model: plan.model, ...plan.effort === undefined ? {} : { effort: plan.effort } };
      const result = chooseModel(primary, plan.fallback, availability);
      const signature = `${result.choice.model}
${result.choice.effort ?? ""}`;
      const before = this.chosen.get(plan.id) ?? `${primary.model}
${primary.effort ?? ""}`;
      this.chosen.set(plan.id, signature);
      this.results.set(plan.id, result.choice);
      if (signature !== before)
        update.changed = true;
      if (!this.active(plan.id))
        continue;
      if (signature !== before && result.index > 0) {
        update.problems.push({ message: `${this.name}: ${plan.id} runs on ${result.choice.model}, its fallback number ${result.index}: ${result.notes.join("; ")}`, notify: true });
      }
      const problem = result.problem === undefined ? undefined : `${this.name}: ${plan.id}: ${result.problem.message}`;
      if (problem === undefined)
        this.told.delete(plan.id);
      else if (this.told.get(plan.id) !== problem) {
        this.told.set(plan.id, problem);
        update.problems.push({ message: problem, notify: true });
      }
    }
    return update;
  }
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

// plugin/inline.ts
function inlineCommands(harness, helpers) {
  return harness.commands.filter((command) => command.agent !== undefined && helpers.has(command.agent));
}
var INLINE_MARK = "ecmwf-multi-agents.inline";
var HELD_NOTE = "A message for lead arrived and was held back for it. Your answer above stands: reply only with the word done.";
var isReport = (message) => message?.role === "user" && firstText(message).startsWith(V2_REPORT_PREFIX);
var USER_WAKES = [INLINE_USER_WAKE_TEXT, INLINE_USER_AND_REPORTS_WAKE_TEXT];
function isUserMessage(message) {
  if (message?.role !== "user" || message.metadata === null || typeof message.metadata !== "object")
    return false;
  if (USER_WAKES.some((wake) => firstText(message).startsWith(wake)))
    return false;
  return stepsV2([message])[0] === "request";
}
function messageKey(message) {
  return typeof message.id === "string" && message.id !== "" ? message.id : `text:${firstText(message)}`;
}
function briefIndex(messages, brief) {
  for (let index = messages.length - 1;index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user")
      continue;
    if (typeof message.metadata?.[INLINE_MARK] === "string")
      return index;
    if (brief !== undefined && firstText(message) === brief)
      return index;
  }
  return -1;
}
function isolateHelperRequest(messages, brief, known) {
  const start = briefIndex(messages, brief);
  let marker = -1;
  if (known !== undefined) {
    for (let index = messages.length - 1;index >= 0 && marker < 0; index--) {
      const id = messages[index]?.id;
      if (typeof id === "string" && known.has(id))
        marker = index;
    }
  }
  const isNew = (index) => start >= 0 && index > start || known !== undefined && index > marker;
  const kinds = messages.map((message, index) => {
    if (index === start)
      return;
    if (isReport(message))
      return isNew(index) || start < 0 && known === undefined ? "reports" : undefined;
    return isNew(index) && isUserMessage(message) ? "user" : undefined;
  });
  const cut = start >= 0 ? start : known !== undefined ? marker + 1 : 0;
  const leftOut = (index) => index < cut || kinds[index] !== undefined;
  const held = { reports: [], user: [] };
  for (let index = messages.length - 1;index >= 0; index--) {
    const kind = kinds[index];
    if (kind !== undefined)
      held[kind].unshift(messageKey(messages[index]));
  }
  const endsLeftOut = messages.length > 0 && leftOut(messages.length - 1);
  for (let index = messages.length - 1;index >= 0; index--)
    if (leftOut(index))
      messages.splice(index, 1);
  const last = messages.at(-1);
  const beforeBrief = start < 0 && known !== undefined && held.reports.length + held.user.length > 0;
  if (beforeBrief || endsLeftOut && (last === undefined || last.role === "assistant"))
    messages.push({ role: "user", content: [{ type: "text", text: HELD_NOTE }] });
  return held;
}
var BEFORE_BRIEF_FOR_TESTS = Symbol.for("ecmwf-multi-agents.testing.beforeBrief");

class InlineRuns {
  active = new Map;
  past = new Map;
  woken = new Map;
  start(session, run) {
    this.active.set(session, run);
  }
  get(session) {
    return session === undefined ? undefined : this.active.get(session);
  }
  finish(session) {
    const run = this.active.get(session);
    this.active.delete(session);
    if (run !== undefined)
      remember(this.past, session, run);
    return run;
  }
  last(session) {
    return session === undefined ? undefined : this.past.get(session);
  }
  claim(session, keys) {
    const woken = this.woken.get(session) ?? new Set;
    const fresh = [...new Set(keys)].filter((key) => !woken.has(key));
    for (const key of fresh)
      woken.add(key);
    remember(this.woken, session, woken);
    return fresh;
  }
}
function classifyHelperRequest(agent, run, hadRun, root, helpers) {
  if (agent === undefined || !helpers.has(agent) || !root)
    return "leave";
  if (run !== undefined)
    return run.helper === agent ? "inline" : "leave";
  return hadRun ? "stray" : "leave";
}
function isModel(value) {
  const model = value;
  return typeof model?.id === "string" && typeof model.providerID === "string";
}
var sameModel = (a, b) => a?.id === b?.id && a?.providerID === b?.providerID && a?.variant === b?.variant;
function reviewerOffText(harness) {
  const reviewer = reviewerId(harness);
  return `The ${reviewer} is switched off here, so /review cannot run and nothing is reviewed. ` + `To switch it on, set "agents": { "${reviewer}": { "enabled": true } } in .opencode/${harness.name}.jsonc for this project, ` + `or in ${harness.name}.jsonc in your opencode config folder for every project, then restart opencode.`;
}

class Inline {
  deps;
  runs = new InlineRuns;
  chains = new Map;
  roots = new Map;
  constructor(deps) {
    this.deps = deps;
  }
  available() {
    const session = this.deps.ctx.session;
    return [session?.get, session?.prompt, session?.switchAgent, session?.wait].every((call) => typeof call === "function");
  }
  commands() {
    const inline = this.available();
    return inlineCommands(this.deps.harness, this.deps.helpers).flatMap((command) => {
      if (this.deps.enabled !== undefined && !this.deps.enabled.has(command.agent))
        return [this.withoutHelper(command)];
      if (!inline)
        return [];
      return [
        {
          name: command.name,
          ...command.description === undefined ? {} : { description: command.description },
          execute: async (invocation) => {
            const sessionID = invocation?.sessionID;
            if (typeof sessionID !== "string")
              return;
            const previous = this.chains.get(sessionID) ?? Promise.resolve();
            const next = previous.then(() => this.run(command, invocation)).catch((error) => this.deps.reporter.internal(`the /${command.name} command`, error));
            remember(this.chains, sessionID, next);
          }
        }
      ];
    });
  }
  withoutHelper(command) {
    const { harness, ctx, reporter } = this.deps;
    if (command.agent !== reviewerId(harness)) {
      return commandDefinition(ctx, harness, { ...command, agent: harness.defaultAgent, subagent: false }, { reporter });
    }
    return {
      name: command.name,
      ...command.description === undefined ? {} : { description: command.description },
      execute: async () => {
        throw new Error(reviewerOffText(harness));
      }
    };
  }
  async modelOf(agent) {
    try {
      const info = unwrap(await this.deps.ctx.agent.get?.({ agentID: agent }));
      if (isModel(info?.model))
        return info.model;
    } catch {}
    return this.deps.plannedModel(agent);
  }
  async defaultModel() {
    try {
      const model = unwrap(await this.deps.ctx.model?.default?.());
      return isModel(model) ? { id: model.id, providerID: model.providerID } : undefined;
    } catch {
      return;
    }
  }
  async idle(sessionID) {
    const session = this.deps.ctx.session;
    for (let round = 0;round < 10; round++) {
      await session.wait({ sessionID });
      if (this.deps.tracker.get(sessionID)?.state !== "running")
        return;
    }
  }
  async run(command, invocation) {
    const session = this.deps.ctx.session;
    const sessionID = invocation.sessionID;
    await this.idle(sessionID);
    const info = unwrap(await session.get({ sessionID }));
    const before = this.runs.last(sessionID);
    const onHelper = typeof info?.agent === "string" && this.deps.helpers.has(info.agent);
    const owner = !onHelper && typeof info?.agent === "string" ? info.agent : before?.owner ?? this.deps.harness.defaultAgent;
    const ownerModel = onHelper ? before?.ownerModel : isModel(info?.model) ? info.model : undefined;
    const helperModel = (command.model === undefined ? undefined : parseModel(command.model)) ?? await this.modelOf(command.agent);
    const brief = fillTemplate(command.template, typeof invocation.prompt?.text === "string" ? invocation.prompt.text : "");
    const known = await this.knownMessages(sessionID);
    const run = { command: command.name, helper: command.agent, owner, ownerModel, switchedModel: false, brief, held: new Set, heldUser: new Set, ...known ? { known } : {} };
    this.runs.start(sessionID, run);
    try {
      await session.switchAgent({ sessionID, agent: command.agent });
      if (helperModel !== undefined && !sameModel(helperModel, ownerModel) && typeof session.switchModel === "function") {
        run.switchedModel = true;
        await session.switchModel({ sessionID, model: helperModel });
      }
      const pause = globalThis[BEFORE_BRIEF_FOR_TESTS];
      if (typeof pause === "function")
        await pause({ sessionID, brief });
      await session.prompt({ ...invocation.prompt, sessionID, text: brief, metadata: { [INLINE_MARK]: command.name }, delivery: "steer" });
      await session.wait({ sessionID });
    } finally {
      this.runs.finish(sessionID);
      await this.restore(sessionID, run);
      await this.wake(sessionID, { reports: [...run.held], user: [...run.heldUser] });
    }
  }
  async knownMessages(sessionID) {
    try {
      const messages = unwrap(await this.deps.ctx.session?.context?.({ sessionID }));
      if (!Array.isArray(messages))
        return;
      return new Set(messages.flatMap((message) => typeof message?.id === "string" ? [message.id] : []));
    } catch {
      return;
    }
  }
  async restore(sessionID, run) {
    const session = this.deps.ctx.session;
    try {
      await session.switchAgent({ sessionID, agent: run.owner });
      if (run.switchedModel) {
        const model = run.ownerModel ?? await this.defaultModel() ?? await this.modelOf(run.owner);
        if (model !== undefined)
          await session.switchModel({ sessionID, model });
        else
          this.deps.reporter.internal("switching back", new Error(`no model to give ${run.owner} back in session ${sessionID}`));
      }
    } catch (error) {
      this.deps.reporter.internal("switching back after a command", error);
    }
  }
  async wake(sessionID, held) {
    const reports = this.runs.claim(sessionID, held.reports).length > 0;
    const user = this.runs.claim(sessionID, held.user).length > 0;
    if (!reports && !user)
      return;
    const text = !user ? INLINE_WAKE_TEXT : reports ? INLINE_USER_AND_REPORTS_WAKE_TEXT : INLINE_USER_WAKE_TEXT;
    const description = user ? "Message held while a helper answered" : "Reports held while a helper answered";
    try {
      await this.deps.ctx.session?.synthetic?.({ sessionID, text, description, delivery: "queue" });
    } catch (error) {
      this.deps.reporter.internal("waking lead after a command", error);
    }
  }
  async isRoot(sessionID) {
    const tracked = this.deps.tracker.get(sessionID);
    if (tracked?.parentID !== undefined)
      return false;
    const known = this.roots.get(sessionID);
    if (known !== undefined)
      return known;
    const info = unwrap(await this.deps.ctx.session?.get?.({ sessionID }));
    if (info === undefined)
      return false;
    const root = typeof info.parentID !== "string";
    remember(this.roots, sessionID, root);
    return root;
  }
  async context(event) {
    const sessionID = event.sessionID;
    const agent = event.agent;
    if (typeof sessionID !== "string" || typeof agent !== "string" || !this.deps.helpers.has(agent) || !Array.isArray(event.messages))
      return false;
    const run = this.runs.get(sessionID);
    const before = this.runs.last(sessionID);
    if (run === undefined && before === undefined)
      return false;
    const kind = classifyHelperRequest(agent, run, before !== undefined, await this.isRoot(sessionID), this.deps.helpers);
    if (kind === "leave")
      return false;
    if (kind === "inline") {
      const held = isolateHelperRequest(event.messages, run.brief, run.known);
      for (const key of held.reports)
        run.held.add(key);
      for (const key of held.user)
        run.heldUser.add(key);
      return true;
    }
    const held = isolateHelperRequest(event.messages, (run ?? before).brief);
    const owner = run ?? before;
    this.restore(sessionID, owner).then(() => this.wake(sessionID, held));
    return true;
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
import path4 from "path";

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

// plugin/rule-order.ts
function sameRule(a, b) {
  return a.action === b.action && a.resource === b.resource && a.effect === b.effect;
}
function findRun(rules, part) {
  if (part.length === 0)
    return -1;
  for (let start = 0;start + part.length <= rules.length; start++) {
    if (part.every((rule, index) => sameRule(rules[start + index], rule)))
      return start;
  }
  return -1;
}
function ownRulesLast(rules, own, everyAgent) {
  const start = findRun(rules, own);
  if (start === -1)
    return [...rules];
  const end = start + own.length;
  let shared = 0;
  while (shared < everyAgent.length && end + shared < rules.length && sameRule(rules[end + shared], everyAgent[shared]))
    shared++;
  if (shared === 0)
    return [...rules];
  return [...rules.slice(0, start), ...rules.slice(end, end + shared), ...rules.slice(start, end), ...rules.slice(end + shared)];
}

class RuleOrder {
  harness;
  home;
  active = false;
  probe;
  constructor(harness, home) {
    this.harness = harness;
    this.home = home;
    this.probe = `${harness.name}-rule-probe`;
  }
  start() {
    this.active = true;
  }
  addProbe(editor) {
    if (!this.active || typeof editor.remove !== "function")
      return;
    editor.update(this.probe, (agent) => {
      agent.mode = "subagent";
      agent.hidden = true;
      agent.permissions = [];
    });
  }
  apply(editor) {
    const probe = editor.get(this.probe);
    if (probe === undefined)
      return;
    const everyAgent = [...probe.permissions ?? []];
    editor.remove?.(this.probe);
    if (everyAgent.length === 0)
      return;
    for (const embedded of this.harness.agents) {
      if (embedded.permissions === undefined || embedded.permissions.length === 0)
        continue;
      const own = expandPermissions(embedded.permissions, this.home);
      if (editor.get(embedded.id) === undefined)
        continue;
      editor.update(embedded.id, (agent) => {
        if (Array.isArray(agent.permissions))
          agent.permissions = ownRulesLast(agent.permissions, own, everyAgent);
      });
    }
  }
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
function globalConfigFolder(environment) {
  const { env, home } = environment;
  if (env.OPENCODE_CONFIG_DIR)
    return path4.resolve(env.OPENCODE_CONFIG_DIR);
  return path4.join(env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : path4.join(home, ".config"), "opencode");
}
function projectFolders(directory, projectRoot) {
  if (directory === undefined)
    return [];
  const folders = [];
  const stop = path4.resolve(projectRoot ?? directory);
  for (let dir = path4.resolve(directory);; dir = path4.dirname(dir)) {
    folders.push(dir);
    if (dir === stop || dir === path4.dirname(dir))
      break;
  }
  return folders;
}
function readable(environment, file) {
  try {
    return environment.readFile(file);
  } catch {
    return;
  }
}
function agentFiles(id, environment, directory, projectRoot) {
  const folders = [globalConfigFolder(environment), ...projectFolders(directory, projectRoot).map((dir) => path4.join(dir, ".opencode"))];
  const found = [];
  for (const folder of [...new Set(folders)]) {
    for (const sub of ["agent", "agents", "mode", "modes"]) {
      const file = path4.join(folder, sub, `${id}.md`);
      if (readable(environment, file) !== undefined)
        found.push(file);
    }
  }
  return found;
}
var CONFIG_NAMES = ["opencode.json", "opencode.jsonc"];
function definesAgent(text, id) {
  try {
    const value = parseJsonc(text);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return false;
    return ["agents", "agent"].some((key) => {
      const entries = value[key];
      return entries !== null && typeof entries === "object" && !Array.isArray(entries) && entries[id] !== undefined;
    });
  } catch {
    return false;
  }
}
function agentConfigFiles(id, environment, directory, projectRoot) {
  const { env } = environment;
  const files = CONFIG_NAMES.map((name) => path4.join(globalConfigFolder(environment), name));
  if (env.OPENCODE_CONFIG)
    files.push(path4.resolve(env.OPENCODE_CONFIG));
  for (const dir of projectFolders(directory, projectRoot)) {
    for (const folder of [dir, path4.join(dir, ".opencode")])
      files.push(...CONFIG_NAMES.map((name) => path4.join(folder, name)));
  }
  const found = [...new Set(files)].filter((file) => {
    const text = readable(environment, file);
    return text !== undefined && definesAgent(text, id);
  });
  if (env.OPENCODE_CONFIG_CONTENT && definesAgent(env.OPENCODE_CONFIG_CONTENT, id))
    found.push("OPENCODE_CONFIG_CONTENT");
  return found;
}
function workDirExcluded(harness, environment, directory) {
  if (directory === undefined)
    return null;
  try {
    const file = gitExcludeFile(directory, environment);
    return file === undefined ? null : workDirListed(readable(environment, file) ?? "", harness.workDir);
  } catch {
    return null;
  }
}
function sameModel2(a, b) {
  return a?.providerID === b?.providerID && a?.id === b?.id;
}
function leadChanges(lead, harness, settings, home, plans) {
  const embedded = harness.agents.find((agent) => agent.id === harness.defaultAgent);
  if (embedded === undefined)
    return [];
  const expected = { id: embedded.id, mode: "primary", hidden: false, permissions: [] };
  applyAgent(expected, embedded, home);
  if (typeof expected.system === "string") {
    const on = enabledHelpers(harness, settings);
    expected.system = rewriteReviewLine(expected.system, effectiveReview(harness, settings, on), embedded.id, harness.reviewPolicies).prompt ?? expected.system;
    expected.system = rewriteHelperSlotsLine(expected.system, settings.maxHelperSlots, embedded.id).prompt ?? expected.system;
    if (helpersSwitched(harness, on))
      expected.system = rewriteHelperList(expected.system, helpersOf(harness), on, harness.helperOff, embedded.id).prompt ?? expected.system;
  }
  const plan = (plans ?? planAgents(harness, settings).plans).find((item) => item.id === embedded.id);
  const model = plan?.model === undefined ? undefined : modelRef(plan.model, plan.effort);
  if (plan?.steps !== undefined)
    expected.steps = plan.steps;
  const changed = [];
  if (lead.system !== expected.system)
    changed.push("system");
  if (lead.description !== expected.description)
    changed.push("description");
  if ((lead.mode ?? "primary") !== expected.mode)
    changed.push("mode");
  if ((lead.hidden ?? false) !== expected.hidden)
    changed.push("hidden");
  if (lead.color !== expected.color)
    changed.push("color");
  const own = expected.permissions ?? [];
  if (own.length > 0 && findRun(Array.isArray(lead.permissions) ? lead.permissions : [], own) === -1)
    changed.push("permissions");
  if (!sameModel2(lead.model, model))
    changed.push("model");
  else if (lead.model?.variant !== model?.variant)
    changed.push("effort");
  if (lead.steps !== expected.steps)
    changed.push("steps");
  return changed;
}
function modelText(agent) {
  const model = agent?.model;
  if (model === undefined)
    return null;
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}
async function doctorReport(input) {
  const { harness, ctx, loaded } = input;
  await input.ready?.().catch(() => {
    return;
  });
  const agents = await Promise.resolve(ctx.agent.list?.()).then((value) => unwrap(value), () => {
    return;
  }) ?? [];
  const lead = agents.find((agent) => agent.id === harness.defaultAgent);
  const plugins = await Promise.resolve(ctx.plugin?.list?.()).then((value) => unwrap(value), () => {
    return;
  }) ?? [];
  const { settings } = loaded;
  const changed = lead === undefined ? [] : leadChanges(lead, harness, settings, input.environment.home, input.plans?.());
  const helpers = helpersOf(harness);
  const on = enabledHelpers(harness, settings);
  const loadedIds = new Set(agents.map((agent) => agent.id));
  return {
    name: harness.name,
    version: harness.version,
    defaultAgent: agents[0]?.id ?? null,
    leadLoaded: lead !== undefined,
    leadDefinition: lead === undefined ? null : changed.length > 0 ? "changed" : "harness",
    leadChanged: changed,
    leadCandidateFiles: agentFiles(harness.defaultAgent, input.environment, input.directory, input.projectRoot),
    leadConfigFiles: agentConfigFiles(harness.defaultAgent, input.environment, input.directory, input.projectRoot),
    reviewLine: (typeof lead?.system === "string" ? lead.system.split(`
`).find((line) => line.startsWith("Review policy:")) : undefined) ?? null,
    helperSlotsLine: typeof lead?.system === "string" ? helperSlotsLine(lead.system) : null,
    leadModel: modelText(lead),
    settings: {
      review: settings.review,
      profile: settings.profile,
      default_agent: settings.defaultAgent,
      max_helper_slots: settings.maxHelperSlots,
      agents: settings.agents
    },
    settingsFiles: loaded.applied,
    settingsSources: loaded.sources,
    helpersOn: helpers.filter((helper) => on.has(helper.id)).map((helper) => helper.id),
    helpersOff: helpers.filter((helper) => !on.has(helper.id)).map((helper) => helper.id),
    helperSwitches: helpers.flatMap((helper) => {
      const from = loaded.sources[`agents.${helper.id}.enabled`];
      return from === undefined ? [] : [`${helper.id} ${on.has(helper.id) ? "on" : "off"} in ${from}`];
    }),
    helpersMissing: helpers.filter((helper) => on.has(helper.id) && !loadedIds.has(helper.id)).map((helper) => helper.id),
    helpersStray: helpers.filter((helper) => helper.optional !== true && !on.has(helper.id) && loadedIds.has(helper.id)).map((helper) => helper.id),
    workDirExcluded: workDirExcluded(harness, input.environment, input.directory ?? input.projectRoot),
    problems: input.problems.list(),
    plugins: (Array.isArray(plugins) ? plugins : []).filter((plugin) => !plugin.id?.startsWith("opencode.") || plugin.state?.status !== "active").map((plugin) => ({
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

// plugin/settings.ts
import path5 from "path";

// plugin/types.ts
var REVIEW_POLICIES = ["auto", "ask", "always", "never"];

// plugin/settings.ts
var SETTINGS_FILE = "ecmwf-multi-agents.jsonc";
var DEFAULT_MAX_HELPER_SLOTS = 4;
var MODEL_PATTERN = /^[^/#\s]+\/[^#\s]+$/;
var EFFORT_PATTERN = /^[^#\s]+$/;
var TOP_KEYS = ["$schema", "review", "profile", "default_agent", "max_helper_slots", "agents"];
var AGENT_KEYS = ["enabled", "model", "effort", "fallback", "steps"];
var FALLBACK_KEYS = ["model", "effort"];
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
function settingsPaths(environment, projectRoot, site) {
  const { env, home } = environment;
  const out = [];
  const addFile = (file) => {
    if (!out.includes(file))
      out.push(file);
  };
  const add = (dir) => {
    if (dir)
      addFile(path5.resolve(dir, SETTINGS_FILE));
  };
  if (site)
    addFile(path5.resolve(site));
  add(env.OPENCODE_CONFIG_DIR);
  const xdg = env.XDG_CONFIG_HOME;
  add(path5.join(xdg ? xdg : path5.join(home, ".config"), "opencode"));
  if (projectRoot)
    add(path5.join(projectRoot, ".opencode"));
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
          agents[id] = validateAgent(id, entry, problems, id === harness.defaultAgent);
        }
        settings.agents = agents;
        break;
      }
      case "max_helper_slots":
        if (typeof item === "number" && Number.isInteger(item) && item >= 1)
          settings.max_helper_slots = item;
        else
          problems.push(`"max_helper_slots" must be a whole number of at least 1, not ${shown(item)}`);
        break;
      default:
        problems.push(`unknown setting ${shown(key)}; the settings are ${listWords(TOP_KEYS, "and")}`);
    }
  }
  return problems.length > 0 ? { problems } : { settings, problems };
}
function validateAgent(id, entry, problems, isDefaultAgent) {
  const out = {};
  for (const key of Object.keys(entry)) {
    const item = entry[key];
    const name = `"agents.${id}.${key}"`;
    switch (key) {
      case "enabled":
        if (isDefaultAgent)
          problems.push(`${name} cannot be set: ${id} is always on`);
        else if (typeof item === "boolean")
          out.enabled = item;
        else
          problems.push(`${name} must be true or false, not ${shown(item)}`);
        break;
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
      case "fallback":
        if (!has(entry, "model"))
          problems.push(`${name} needs a model in the same entry: the fallbacks are for that model`);
        out.fallback = validateFallback(`agents.${id}.fallback`, item, problems);
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
function validateFallback(path, item, problems) {
  const out = [];
  if (!Array.isArray(item)) {
    problems.push(`"${path}" must be a list of models, each provider/model or { "model": "provider/model", "effort": "high" }, not ${shown(item)}`);
    return out;
  }
  item.forEach((candidate, index) => {
    const at = `${path}[${index}]`;
    if (typeof candidate === "string") {
      if (MODEL_PATTERN.test(candidate))
        out.push({ model: candidate });
      else
        problems.push(`"${at}" must look like provider/model, without "#" or spaces, not ${shown(candidate)}`);
      return;
    }
    if (!isObject(candidate)) {
      problems.push(`"${at}" must be provider/model or an object with ${listWords(FALLBACK_KEYS, "and")}, not ${shown(candidate)}`);
      return;
    }
    const entry = {};
    for (const key of Object.keys(candidate)) {
      const value = candidate[key];
      if (key === "model") {
        if (typeof value === "string" && MODEL_PATTERN.test(value))
          entry.model = value;
        else
          problems.push(`"${at}.model" must look like provider/model, without "#" or spaces, not ${shown(value)}`);
      } else if (key === "effort") {
        if (typeof value === "string" && EFFORT_PATTERN.test(value))
          entry.effort = value;
        else
          problems.push(`"${at}.effort" must be a non-empty name such as "high", without "#" or spaces, not ${shown(value)}`);
      } else {
        problems.push(`"${at}" has the unknown setting ${shown(key)}; an entry takes ${listWords(FALLBACK_KEYS, "and")}`);
      }
    }
    if (!has(candidate, "model"))
      problems.push(`"${at}" needs a "model", written as provider/model`);
    else if (entry.model !== undefined)
      out.push(entry);
  });
  return out;
}
function mergeSettings(files, harness) {
  const settings = {
    review: "auto",
    reviewSet: false,
    profile: harness.defaultProfile,
    defaultAgent: true,
    maxHelperSlots: DEFAULT_MAX_HELPER_SLOTS,
    maxHelperSlotsSet: false,
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
    if (file.max_helper_slots !== undefined) {
      settings.maxHelperSlots = file.max_helper_slots;
      settings.maxHelperSlotsSet = true;
    }
    for (const [id, override] of Object.entries(file.agents ?? {})) {
      const cleared = override.model !== undefined && override.fallback === undefined ? { fallback: [] } : {};
      settings.agents[id] = { ...settings.agents[id], ...override, ...cleared };
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
    if (file.max_helper_slots !== undefined)
      sources.max_helper_slots = from;
    for (const [id, override] of Object.entries(file.agents ?? {})) {
      for (const key of Object.keys(override))
        sources[`agents.${id}.${key}`] = from;
    }
  });
  return sources;
}
function loadSettings(harness, environment, projectRoot, site) {
  const files = [];
  const problems = [];
  const applied = [];
  for (const file of settingsPaths(environment, projectRoot, site)) {
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

// plugin/step-limit.ts
var STEP_LIMIT_NOTICE = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`;
function stepLimitAsUser(messages) {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !Array.isArray(last.content) || last.content.length !== 1)
    return false;
  const part = last.content[0];
  if (part?.type !== "text" || part.text !== STEP_LIMIT_NOTICE)
    return false;
  messages[messages.length - 1] = { role: "user", content: [{ type: "text", text: STEP_LIMIT_NOTICE }] };
  return true;
}

// plugin/tools-v2.ts
function eventFields(envelope) {
  if (typeof envelope?.type !== "string")
    return;
  const data = envelope.data;
  return { ...envelope, ...data !== null && typeof data === "object" ? data : {}, type: envelope.type };
}

class SessionTracker {
  sessions = new Map;
  observe(envelope, now = Date.now()) {
    const event = eventFields(envelope);
    if (event === undefined)
      return;
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
  return path6.dirname(fileURLToPath(import.meta.url));
}
function v2ProjectRoot(ctx) {
  const project = ctx?.location?.project?.directory;
  if (typeof project === "string" && project !== "")
    return project;
  const directory = ctx?.location?.directory;
  return typeof directory === "string" && directory !== "" ? directory : undefined;
}
function siteSettings(ctx) {
  const site = ctx?.options?.site;
  return typeof site === "string" && site !== "" ? site : undefined;
}

class LateTransform {
  transform;
  callback;
  reporter;
  what;
  current;
  queue = Promise.resolve();
  stopped = false;
  requested = false;
  constructor(transform, callback, reporter, what) {
    this.transform = transform;
    this.callback = callback;
    this.reporter = reporter;
    this.what = what;
  }
  ensure() {
    return this.current === undefined ? this.register() : this.queue;
  }
  register() {
    this.requested = true;
    this.queue = this.queue.then(async () => {
      if (this.stopped)
        return;
      try {
        const next = await this.transform(this.callback);
        const previous = this.current;
        this.current = next;
        if (previous !== undefined)
          await previous.dispose();
      } catch (error) {
        if (!this.stopped)
          this.reporter.internal(`registering the ${this.what} transform`, error);
      }
    });
    return this.queue;
  }
  stop() {
    this.stopped = true;
  }
}
function keepWorkDirOutOfGit(ctx, harness, environment, reporter) {
  const reported = new Set;
  return (envelope) => {
    const event = eventFields(envelope);
    if (event?.type !== "session.created" || environment === undefined)
      return;
    if (typeof event.parentID === "string" && event.parentID !== "")
      return;
    const location = event.location;
    const directory = typeof location?.directory === "string" ? location.directory : ctx.location?.directory;
    if (typeof directory !== "string" || directory === "")
      return;
    const result = excludeWorkDir(directory, harness.workDir, environment);
    if (result.state !== "failed" || reported.has(`${result.file}
${result.error}`))
      return;
    reported.add(`${result.file}
${result.error}`);
    reporter.report([{ message: `${harness.name}: could not add ${harness.workDir}/ to ${result.file}, so git may list the harness's work files: ${result.error}`, notify: true }]);
  };
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
        loaded = loadSettings(harness, environment, v2ProjectRoot(ctx), siteSettings(ctx));
      } catch (error) {
        reporter.internal("reading the settings", error);
      }
      const settings = loaded.settings;
      const ruleOrder = new RuleOrder(harness, environment?.home ?? "");
      const planned = planAgents(harness, settings);
      const subagents = helperIds(harness);
      const switchedOn = enabledHelpers(harness, settings);
      const choices = new ModelChoices(harness.name, planned.plans, (id) => !subagents.has(id) || switchedOn.has(id));
      let late;
      let availabilityRead = false;
      let reading = Promise.resolve();
      const readProviders = () => {
        availabilityRead = true;
        reading = reading.then(async () => {
          try {
            const update = choices.update(await readAvailability(ctx));
            reporter.report(update.problems);
            if (update.changed && late?.requested === true)
              late.register();
          } catch (error) {
            reporter.internal("reading the providers", error);
          }
        });
        return reading;
      };
      await registerHarness(ctx, harness, {
        home: environment?.home ?? "",
        ruleOrder,
        pluginDir: options.pluginDir ?? moduleDir(),
        defaultAgent: settings.defaultAgent,
        reporter,
        helpers: enabledHelpers(harness, settings)
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
            projectRoot: v2ProjectRoot(ctx),
            ready: async () => {
              if (late === undefined)
                return;
              ruleOrder.start();
              if (!availabilityRead)
                readProviders();
              await reading;
              await late.ensure();
            },
            plans: () => choices.plans()
          });
        } catch (error) {
          reporter.internal("registering the RPC", error);
        }
      }
      reporter.report(loaded.problems);
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
      const inline = new Inline({
        harness,
        ctx,
        tracker,
        helpers,
        enabled: enabledHelpers(harness, settings),
        reporter,
        plannedModel: (agent) => {
          const plan = choices.plans().find((item) => item.id === agent);
          return plan?.model === undefined ? undefined : modelRef(plan.model, plan.effort);
        }
      });
      if (typeof ctx.session?.hook === "function") {
        const agentIds = new Set(harness.agents.map((agent) => agent.id));
        const woken = new Set;
        await ctx.session.hook("context", async (event) => {
          try {
            if (typeof event?.agent === "string" && agentIds.has(event.agent) && Array.isArray(event.messages))
              stepLimitAsUser(event.messages);
            if (await inline.context(event))
              return;
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
      late = new LateTransform((callback) => ctx.agent.transform(callback), (editor) => {
        try {
          ruleOrder.apply(editor);
        } catch (error) {
          reporter.internal("ordering the agents' rules", error);
        }
        try {
          reporter.report(applyToV2Agents(editor, harness, settings, choices.plans()));
        } catch (error) {
          reporter.internal("the agent transform", error);
        }
      }, reporter, "agent");
      const commandTransform = ctx.command?.transform;
      const lateCommands = typeof commandTransform === "function" && inline.commands().length > 0 ? new LateTransform((callback) => commandTransform.call(ctx.command, callback), (editor) => {
        try {
          for (const command of inline.commands())
            editor.add(command);
        } catch (error) {
          reporter.internal("the command transform", error);
        }
      }, reporter, "command") : undefined;
      const agentTransform = late;
      const onActivation = () => {
        ruleOrder.start();
        (async () => {
          if (!availabilityRead)
            readProviders();
          await reading;
          agentTransform.register();
          lateCommands?.register();
        })();
      };
      const keepOut = keepWorkDirOutOfGit(ctx, harness, environment, reporter);
      const onEvent = (event) => {
        tracker.observe(event);
        keepOut(event);
        if (event?.type === "provider.updated" || event?.type === "model.updated")
          readProviders();
      };
      const stopWatching = watchEvents(ctx, onActivation, onEvent, reporter, options.fallbackMs ?? FALLBACK_MS);
      return async () => {
        stopWatching();
        agentTransform.stop();
        lateCommands?.stop();
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
var plugin_default = createPlugin({ name: "ecmwf-multi-agents", version: "0.9.1", defaultAgent: "lead", defaultProfile: "default", workDir: ".ecmwf-multi-agents", profiles: [{ id: "anthropic", description: "Anthropic models only. The reviewer and the tester use the strongest model, since a different family is not available.", agents: { lead: { model: "anthropic/claude-opus-5-5", effort: "xhigh" }, scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" }, builder: { model: "anthropic/claude-sonnet-5-5", effort: "high" }, reviewer: { model: "anthropic/claude-opus-5-5", effort: "high" }, researcher: { model: "anthropic/claude-opus-5-5", effort: "xhigh" }, tester: { model: "anthropic/claude-opus-5-5", effort: "high" }, designer: { model: "anthropic/claude-opus-5-5", effort: "high" }, "data-scientist": { model: "anthropic/claude-sonnet-5-5", effort: "high" } } }, { id: "copilot", description: "GitHub Copilot models only, with the same split as the default profile.", agents: { lead: { model: "github-copilot/claude-opus-5.5", effort: "xhigh" }, scout: { model: "github-copilot/claude-sonnet-5.5", effort: "medium" }, builder: { model: "github-copilot/claude-sonnet-5.5", effort: "high" }, reviewer: { model: "github-copilot/gpt-6.1-sol", effort: "medium" }, researcher: { model: "github-copilot/claude-opus-5.5", effort: "xhigh" }, tester: { model: "github-copilot/gpt-6.1-sol", effort: "high" }, designer: { model: "github-copilot/claude-opus-5.5", effort: "high" }, "data-scientist": { model: "github-copilot/claude-sonnet-5.5", effort: "high" } } }, { id: "default", description: "Anthropic for lead, scout and builder; GitHub Copilot GPT for the reviewer and the tester, so they check work with a different model family.", agents: { lead: { model: "anthropic/claude-opus-5-5", effort: "xhigh" }, scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" }, builder: { model: "anthropic/claude-sonnet-5-5", effort: "high" }, reviewer: { model: "github-copilot/gpt-6.1-sol", effort: "medium" }, researcher: { model: "anthropic/claude-opus-5-5", effort: "xhigh" }, tester: { model: "github-copilot/gpt-6.1-sol", effort: "high" }, designer: { model: "anthropic/claude-opus-5-5", effort: "high" }, "data-scientist": { model: "anthropic/claude-sonnet-5-5", effort: "high" } } }, { id: "inherit", description: "Every agent uses the model selected in the session. Helpers still differ by step limit.", agents: {} }], agents: [{ id: "lead", mode: "primary", description: "Talks to you, plans, hands work to helpers and checks the results. Start here.", model: "anthropic/claude-opus-5-5#xhigh", color: "#0b5394", permissions: [{ action: "question", resource: "*", effect: "allow" }, { action: "subagent", resource: "*", effect: "deny" }, { action: "subagent", resource: "scout", effect: "allow" }, { action: "subagent", resource: "builder", effect: "allow" }, { action: "subagent", resource: "reviewer", effect: "allow" }, { action: "shell", resource: "git push *", effect: "ask" }, { action: "shell", resource: "git -C * push *", effect: "ask" }, { action: "shell", resource: "git commit --amend *", effect: "ask" }, { action: "shell", resource: "git reset --hard *", effect: "ask" }, { action: "shell", resource: "git clean *", effect: "ask" }, { action: "shell", resource: "git rebase *", effect: "ask" }, { action: "shell", resource: "git branch -D *", effect: "ask" }, { action: "shell", resource: "git restore *", effect: "ask" }, { action: "shell", resource: "git checkout -- *", effect: "ask" }, { action: "shell", resource: "git stash drop *", effect: "ask" }, { action: "shell", resource: "git stash clear *", effect: "ask" }, { action: "shell", resource: "gh pr create *", effect: "ask" }, { action: "shell", resource: "gh pr merge *", effect: "ask" }, { action: "shell", resource: "gh pr close *", effect: "ask" }, { action: "shell", resource: "gh release *", effect: "ask" }, { action: "shell", resource: "gh repo delete *", effect: "ask" }, { action: "shell", resource: "gh issue create *", effect: "ask" }], system: `You are lead, the coordinating agent of ecmwf-multi-agents in opencode. You are the only agent that talks to the user. You size each request, plan with the user, brief helpers, check their work and report.

Users are research scientists, analysts and software developers. Many are experts in their science but not in software process, git or AI tools. Use plain words and short answers. Explain any term a non-specialist may not know the first time you use it. When you finish, say what you did, what you found and what comes next.

## Review

Review policy: auto
The reviewer checks each plan before the user approves it, and each change beyond a trivial edit.

Review a change after it passes your own checks. Tell the reviewer the goal, the criteria, the checks and where the work is: for a plan, its path; for a change, the changed files, plus the plan's path if it came from one. On REJECT, get the blockers fixed (by a builder for a change, by you for a plan), then send the work back to the reviewer with its earlier blockers. After two such rounds, take the open blockers to the user. The user can run \`/review\` under any policy. Reports from \`/review\` and \`/progress\` arrive as a reply to the command's text here, or as a \`<subagent>\` message. If you explain one, be brief and do not re-run its checks; act on it only when the user asks.

## Size every request first

- Answer: the conversation, the onboarding summary, general knowledge or a quick look at one or two files gives the answer. Reply directly.
- Trivial edit: a few lines in a file you have already read, with no design choice. Make it, then run the relevant check. Hand anything larger to a builder.
- Delegate: it needs reading beyond a couple of files, or a contained change. Brief one helper, or several in parallel.
- Plan-sized: several steps, a design choice, or more than a few files. Plan first (see Plans).

Keep your own context small. Send broad reading to scouts, and do not re-read what a helper has summarised unless you must edit it.

## Helpers

- scout: lookups and investigations, such as where X is, what calls Y, what a page says, or why X happens; read its notes file only when you need the detail.
- builder: one well-specified change, from a small edit to a hard fix, with the files and checks known.
- reviewer: independent APPROVE or REJECT on a plan or a change.

When a helper fails, stops at its step limit or leaves its task partly done, continue its session with the gap stated exactly: it keeps what it has read. Do not do its work yourself. If a builder fails again, take it to the user with what was tried and the options: a higher builder effort in the settings, or you taking the task over. When a scout cannot answer, brief a scout again with what it missed and a wider scope; if that fails too, ask the user. Scouts cannot run code: run it yourself or brief a builder to run it and change nothing.

Run at most 4 helpers at once. Run scouts in parallel when their questions are independent, and builders only when their files do not overlap. Start parallel helpers in the same turn.

## Background helpers

Hand off in the background only when you have other work meanwhile, as when a plan has more ready tasks, or the user may want to keep talking; otherwise the foreground, which is cheaper: each completion costs you a turn. A completion arrives as a \`<subagent>\` message; read it as the helper's report. Answer the user before you act on any completion, even one that arrives while you look up the answer.

Use \`helpers_status\`, \`helpers_steer\` and \`helpers_cancel\` only when the user asks or a helper is off its brief, never to wait or poll.

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

Ask the user through the question tool, never in your reply, when the answer changes what you will do: scope, approach or risk. Offer options with your recommendation first, and give each option's consequences in a few words: its pros and cons. Otherwise make a reasonable assumption and state it. Look up facts instead of asking for them.

## Work files

Work files live in \`.ecmwf-multi-agents/\` at the top of the repository (\`git rev-parse --show-toplevel\`; outside git, the current directory): \`plans/\`, \`context/onboard.md\` and \`notes/\`.

- Search tools skip these files, so read them, and point helpers to them, by exact path.
- If \`.ecmwf-multi-agents/context/onboard.md\` exists, read it before your first task in a session. In a repository, if the hash on its \`Commit:\` line differs from \`git rev-parse HEAD\`, treat it as possibly out of date and suggest \`/onboard\` once.

## Git and safety

- Commit only when the user asks, staging only this work's files by name. Follow the project's commit rules; otherwise use Conventional Commits. Never add AI attribution or co-author trailers.
- Push, open or merge pull requests, rewrite history or discard uncommitted changes only when the user asked for it in this conversation. opencode will still ask the user to approve; suggest "Allow once". Run each such command on its own, never chained with others, so a refusal stops only that step.
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
\`\`\`` }, { id: "reviewer", mode: "subagent", description: "Independent review of a plan or a change. Answers APPROVE or REJECT with at most three blockers.", model: "github-copilot/gpt-6.1-sol#medium", steps: 30, permissions: [{ action: "edit", resource: "*", effect: "deny" }, { action: "shell", resource: "git add *", effect: "deny" }, { action: "shell", resource: "git commit *", effect: "deny" }, { action: "shell", resource: "git push *", effect: "deny" }, { action: "shell", resource: "git pull *", effect: "deny" }, { action: "shell", resource: "git fetch *", effect: "deny" }, { action: "shell", resource: "git reset *", effect: "deny" }, { action: "shell", resource: "git rebase *", effect: "deny" }, { action: "shell", resource: "git merge *", effect: "deny" }, { action: "shell", resource: "git cherry-pick *", effect: "deny" }, { action: "shell", resource: "git revert *", effect: "deny" }, { action: "shell", resource: "git am *", effect: "deny" }, { action: "shell", resource: "git checkout *", effect: "deny" }, { action: "shell", resource: "git switch *", effect: "deny" }, { action: "shell", resource: "git restore *", effect: "deny" }, { action: "shell", resource: "git stash *", effect: "deny" }, { action: "shell", resource: "git clean *", effect: "deny" }, { action: "shell", resource: "git rm *", effect: "deny" }, { action: "shell", resource: "git mv *", effect: "deny" }, { action: "shell", resource: "git tag *", effect: "deny" }, { action: "shell", resource: "git branch *", effect: "deny" }, { action: "shell", resource: "git remote *", effect: "deny" }, { action: "shell", resource: "git worktree *", effect: "deny" }, { action: "shell", resource: "git update-ref *", effect: "deny" }, { action: "shell", resource: "git config *", effect: "deny" }, { action: "shell", resource: "git -C *", effect: "deny" }, { action: "shell", resource: "gh *", effect: "deny" }, { action: "shell", resource: "gh pr view *", effect: "allow" }, { action: "shell", resource: "gh pr diff *", effect: "allow" }, { action: "shell", resource: "gh pr checks *", effect: "allow" }, { action: "subagent", resource: "*", effect: "deny" }, { action: "question", resource: "*", effect: "deny" }, { action: "execute", resource: "*", effect: "deny" }, { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" }, { action: "helpers_status", resource: "*", effect: "deny" }, { action: "helpers_steer", resource: "*", effect: "deny" }, { action: "helpers_cancel", resource: "*", effect: "deny" }], system: "You are the reviewer: you give an independent verdict on a change or a plan that someone else made, and catch what they missed. The request (a brief from the `lead` agent, or the `/review` command) is all you know about the conversation. You cannot ask questions or delegate.\n\n## Rules\n\n- Never change files, not even through the shell. The shell may run checks such as tests and linters (formatters in check mode only); install nothing.\n- Git and `gh` writes are denied; you may read pull requests with `gh pr view`, `gh pr diff` and `gh pr checks`. If a call is denied, do not work around it.\n- Read the actual diff and files, not summaries. Treat claims in the request as things to verify.\n- Search before reading whole files, and make independent tool calls in parallel.\n- Work files live in `.ecmwf-multi-agents/` at the repository top. Search tools skip that folder: read its files by exact path or list them with `ls`.\n- Never print or copy secrets or credentials; mention only that they exist.\n- A later message from `lead` or the user amends the request: follow it and say under CHECKED what it changed.\n- When told the step limit is reached, stop and report at once with what you have.\n\n## What to check\n\n- If the request lists earlier blockers, check each one first.\n- A change: correctness, the acceptance criteria (DONE WHEN) or the goal, tests, security, and the project's conventions (its AGENTS.md and the surrounding code). Run the request's CHECKS, and other cheap checks when they settle a doubt.\n- A plan: does it reach its goal? Are tasks right-sized, each with checkable criteria? Do tasks meant to run in parallel share no files and not depend on each other? Are the risks covered?\n\n## Verdict\n\n- REJECT only for real problems: wrong behaviour, unmet criteria, broken checks, security issues, or a plan that does not reach its goal. Style preferences go to NOTES.\n- Give at most three blockers, the most serious first.\n- Never approve blindly. If you could not see the change or plan itself, REJECT and say what is missing. Otherwise list under CHECKED what you could not check.\n\nReply with exactly these sections:\n\n```text\nVERDICT: APPROVE or REJECT.\nBLOCKERS: on REJECT only, at most three: `path:line`, the problem, the direction of a fix.\nNOTES: at most three non-blocking suggestions.\nCHECKED: what was examined and which commands ran.\n```" }, { id: "researcher", mode: "subagent", description: "Deep investigation of a hard question: compares options, may run experiments in a scratch folder, and writes a report.", model: "anthropic/claude-opus-5-5#xhigh", steps: 80, permissions: [{ action: "edit", resource: "*", effect: "deny" }, { action: "edit", resource: ".ecmwf-multi-agents/notes/*", effect: "allow" }, { action: "edit", resource: "*/.ecmwf-multi-agents/notes/*", effect: "allow" }, { action: "edit", resource: ".ecmwf-multi-agents/scratch/*", effect: "allow" }, { action: "edit", resource: "*/.ecmwf-multi-agents/scratch/*", effect: "allow" }, { action: "shell", resource: "git add *", effect: "deny" }, { action: "shell", resource: "git commit *", effect: "deny" }, { action: "shell", resource: "git push *", effect: "deny" }, { action: "shell", resource: "git pull *", effect: "deny" }, { action: "shell", resource: "git fetch *", effect: "deny" }, { action: "shell", resource: "git reset *", effect: "deny" }, { action: "shell", resource: "git rebase *", effect: "deny" }, { action: "shell", resource: "git merge *", effect: "deny" }, { action: "shell", resource: "git cherry-pick *", effect: "deny" }, { action: "shell", resource: "git revert *", effect: "deny" }, { action: "shell", resource: "git am *", effect: "deny" }, { action: "shell", resource: "git checkout *", effect: "deny" }, { action: "shell", resource: "git switch *", effect: "deny" }, { action: "shell", resource: "git restore *", effect: "deny" }, { action: "shell", resource: "git stash *", effect: "deny" }, { action: "shell", resource: "git clean *", effect: "deny" }, { action: "shell", resource: "git rm *", effect: "deny" }, { action: "shell", resource: "git mv *", effect: "deny" }, { action: "shell", resource: "git tag *", effect: "deny" }, { action: "shell", resource: "git branch *", effect: "deny" }, { action: "shell", resource: "git remote *", effect: "deny" }, { action: "shell", resource: "git worktree *", effect: "deny" }, { action: "shell", resource: "git update-ref *", effect: "deny" }, { action: "shell", resource: "git config *", effect: "deny" }, { action: "shell", resource: "git -C *", effect: "deny" }, { action: "shell", resource: "gh *", effect: "deny" }, { action: "subagent", resource: "*", effect: "deny" }, { action: "question", resource: "*", effect: "deny" }, { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" }, { action: "helpers_status", resource: "*", effect: "deny" }, { action: "helpers_steer", resource: "*", effect: "deny" }, { action: "helpers_cancel", resource: "*", effect: "deny" }], system: "You are the researcher: you investigate a hard question in depth, compare the options and, where it settles a doubt, run a small experiment. The `lead` agent sends you a brief with some of GOAL, CONTEXT, FILES, DONE WHEN, CHECKS and LIMITS; it is all you know about the conversation. You cannot ask questions or delegate.\n\n## Rules\n\n- Never change project files. Write only your report, `.ecmwf-multi-agents/notes/<slug>.md`, and experiments in `.ecmwf-multi-agents/scratch/<slug>/`, both at the repository top (`git rev-parse --show-toplevel`). Use the slug the brief gives, or a short hyphenated one.\n- Match the depth to the brief: a small experiment stays small. Stop once the question is settled; under NOT CHECKED, say what more would add.\n- Experiment only in your scratch folder, on copies. Install nothing into the project or the system; for a missing package use a throwaway environment, such as `uv run --with <package>`. Nothing costly: no large downloads, job submissions or long runs; if the question needs one, say what it would take.\n- Git and `gh` writes are denied. If a call is denied, do not work around it.\n- Follow LIMITS and the project's AGENTS.md.\n- Search tools skip `.ecmwf-multi-agents/`: read its files by exact path or list them with `ls`.\n- Never print or copy secrets or credentials; mention only that they exist.\n- A later message from `lead` or the user amends your brief: follow it, keep the earlier LIMITS unless it lifts them, and say in ANSWER what it changed.\n- When told the step limit is reached, stop and report at once.\n\n## Method\n\n1. Restate the question and list what would settle it: facts to find, options to compare, a test to run. Start the report file with these and the commit (`git rev-parse HEAD`); add each finding as it comes, so a cut-off still leaves them.\n2. Gather evidence from the code (follow call chains, and history with `git log -S`), documentation, papers and the web, preferring primary sources. Make independent tool calls in parallel.\n3. Compare the options on what the goal needs, such as correctness, numerical behaviour, cost and risk.\n4. When reasoning cannot settle a point, run the smallest experiment that can, from a script in your scratch folder that can be run again.\n5. Back each fact with evidence and label each inference. Look for evidence against your conclusion, not only for it.\n6. Finish the report file with the answer, then reply briefly.\n\n## Report\n\nReply with exactly these sections. Cite only what you have read or run.\n\n```text\nANSWER: the answer or recommendation, at most five lines.\nFINDINGS: the facts behind it, each with its evidence: `path:line`, URL or experiment.\nOPTIONS: the options compared and their trade-offs, when the brief asks for a choice.\nEXPERIMENTS: each command run, in which folder, and its result.\nCONFIDENCE: high, medium or low, and what would change the answer.\nNOTES: path to the report file, if one was written.\nNOT CHECKED: what was out of reach or skipped.\n```", optional: true, routing: "a hard question that needs depth: comparing options, finding out why, or an experiment that settles it, run in its scratch folder. It costs more than a scout, so not for lookups. It changes no project file (check `git status`); its full findings are in its notes file." }, { id: "tester", mode: "subagent", description: "Tries to break a change or a piece of code with edge cases and new tests; never fixes product code; drafts issues.", model: "github-copilot/gpt-6.1-sol#high", steps: 60, permissions: [{ action: "shell", resource: "git add *", effect: "deny" }, { action: "shell", resource: "git commit *", effect: "deny" }, { action: "shell", resource: "git push *", effect: "deny" }, { action: "shell", resource: "git pull *", effect: "deny" }, { action: "shell", resource: "git fetch *", effect: "deny" }, { action: "shell", resource: "git reset *", effect: "deny" }, { action: "shell", resource: "git rebase *", effect: "deny" }, { action: "shell", resource: "git merge *", effect: "deny" }, { action: "shell", resource: "git cherry-pick *", effect: "deny" }, { action: "shell", resource: "git revert *", effect: "deny" }, { action: "shell", resource: "git am *", effect: "deny" }, { action: "shell", resource: "git checkout *", effect: "deny" }, { action: "shell", resource: "git switch *", effect: "deny" }, { action: "shell", resource: "git restore *", effect: "deny" }, { action: "shell", resource: "git stash *", effect: "deny" }, { action: "shell", resource: "git clean *", effect: "deny" }, { action: "shell", resource: "git rm *", effect: "deny" }, { action: "shell", resource: "git mv *", effect: "deny" }, { action: "shell", resource: "git tag *", effect: "deny" }, { action: "shell", resource: "git branch *", effect: "deny" }, { action: "shell", resource: "git remote *", effect: "deny" }, { action: "shell", resource: "git worktree *", effect: "deny" }, { action: "shell", resource: "git update-ref *", effect: "deny" }, { action: "shell", resource: "git config *", effect: "deny" }, { action: "shell", resource: "git -C *", effect: "deny" }, { action: "shell", resource: "gh *", effect: "deny" }, { action: "subagent", resource: "*", effect: "deny" }, { action: "question", resource: "*", effect: "deny" }, { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" }, { action: "helpers_status", resource: "*", effect: "deny" }, { action: "helpers_steer", resource: "*", effect: "deny" }, { action: "helpers_cancel", resource: "*", effect: "deny" }], system: "You are the tester: you try to break code, as a careless user, a hostile input or an unlucky day would, and report what breaks. The `lead` agent sends you a brief with some of GOAL, CONTEXT, FILES, DONE WHEN, CHECKS and LIMITS; it is all you know about the conversation. You cannot ask questions or delegate.\n\n## Rules\n\n- Never fix product code, not even a one-line bug: report it. You may add or change test files, in the project's test folders and style, and write throwaway probes in `.ecmwf-multi-agents/scratch/<slug>/` at the repository top. `lead` checks which files you changed.\n- For each real problem write an issue draft, `.ecmwf-multi-agents/issues/<slug>.md`; never file it. `lead` shows it to the user, who decides.\n- Git and `gh` writes are denied. If a call is denied, do not work around it.\n- Never aim probes at real services, shared data or production systems: use local copies and fakes. Install nothing into the project; a throwaway environment, such as `uv run --with <package>`, is fine.\n- Never weaken, skip or delete an existing test.\n- Follow LIMITS, the project's AGENTS.md and its test conventions.\n- Search tools skip `.ecmwf-multi-agents/`: read its files by exact path or list them with `ls`.\n- Never print or copy secrets or credentials; mention only that they exist.\n- A later message from `lead` or the user amends your brief: follow it, keep the earlier LIMITS unless it lifts them, and say under FINDINGS what it changed.\n- When told the step limit is reached, stop and report at once with what you have.\n\n## Method\n\n1. Read the code under test and its tests. Write down what it promises: inputs, outputs, errors, invariants.\n2. Run the existing tests first, so you know what already fails.\n3. Attack each promise: empty, huge and malformed input; boundaries; missing files and permissions; units, precision, NaN and infinity; dates and time zones; repeated and concurrent calls; error paths and cleanup.\n4. Show each problem with the smallest failing test. Use property-based or fuzz testing where the project already has the tools.\n5. Confirm each failure twice. A failure caused only by your environment is not a finding.\n6. Keep the tests that guard real behaviour, passing or failing; delete probes that only explored.\n\nA draft holds a title, what happens and what should, the smallest steps to reproduce, the commit (`git rev-parse HEAD`) and environment, the severity (high: wrong results or lost data; medium: a crash or wrong error; low: the rest) and the test that shows it.\n\n## Report\n\nReply with exactly these sections. Report only checks you ran, with their real result.\n\n```text\nSTATUS: DONE, PARTIAL or BLOCKED.\nFINDINGS: one per problem: severity, what breaks, how to reproduce, issue draft path.\nTESTS: one line per test file added or changed, and what it covers.\nCHECKS: one line per command: pass or fail, with the key failure line.\nNOT TESTED: what was not tried.\n```", optional: true, routing: "tries to break a change or a piece of code with edge cases and new tests, and fixes nothing. Check that it changed only test files; its failing tests show real bugs, so keep them. Show its issue drafts in `.ecmwf-multi-agents/issues/` to the user; file one with `gh issue create` only when the user approves." }, { id: "designer", mode: "subagent", description: "Designs user interfaces and interactions: a spec, a standalone prototype and screenshots. Never changes the project's code.", model: "anthropic/claude-opus-5-5#high", steps: 60, permissions: [{ action: "edit", resource: "*", effect: "deny" }, { action: "edit", resource: ".ecmwf-multi-agents/design/*", effect: "allow" }, { action: "edit", resource: "*/.ecmwf-multi-agents/design/*", effect: "allow" }, { action: "shell", resource: "git add *", effect: "deny" }, { action: "shell", resource: "git commit *", effect: "deny" }, { action: "shell", resource: "git push *", effect: "deny" }, { action: "shell", resource: "git pull *", effect: "deny" }, { action: "shell", resource: "git fetch *", effect: "deny" }, { action: "shell", resource: "git reset *", effect: "deny" }, { action: "shell", resource: "git rebase *", effect: "deny" }, { action: "shell", resource: "git merge *", effect: "deny" }, { action: "shell", resource: "git cherry-pick *", effect: "deny" }, { action: "shell", resource: "git revert *", effect: "deny" }, { action: "shell", resource: "git am *", effect: "deny" }, { action: "shell", resource: "git checkout *", effect: "deny" }, { action: "shell", resource: "git switch *", effect: "deny" }, { action: "shell", resource: "git restore *", effect: "deny" }, { action: "shell", resource: "git stash *", effect: "deny" }, { action: "shell", resource: "git clean *", effect: "deny" }, { action: "shell", resource: "git rm *", effect: "deny" }, { action: "shell", resource: "git mv *", effect: "deny" }, { action: "shell", resource: "git tag *", effect: "deny" }, { action: "shell", resource: "git branch *", effect: "deny" }, { action: "shell", resource: "git remote *", effect: "deny" }, { action: "shell", resource: "git worktree *", effect: "deny" }, { action: "shell", resource: "git update-ref *", effect: "deny" }, { action: "shell", resource: "git config *", effect: "deny" }, { action: "shell", resource: "git -C *", effect: "deny" }, { action: "shell", resource: "gh *", effect: "deny" }, { action: "subagent", resource: "*", effect: "deny" }, { action: "question", resource: "*", effect: "deny" }, { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" }, { action: "helpers_status", resource: "*", effect: "deny" }, { action: "helpers_steer", resource: "*", effect: "deny" }, { action: "helpers_cancel", resource: "*", effect: "deny" }], system: "You are the designer: you design user interfaces and interactions, as a written spec and a prototype people can try. A builder implements the agreed design later; you never change the project's code. The `lead` agent sends you a brief with some of GOAL, CONTEXT, FILES, DONE WHEN, CHECKS and LIMITS; it is all you know about the conversation. You cannot ask questions or delegate.\n\n## Rules\n\n- Write only in `.ecmwf-multi-agents/design/<slug>/` at the repository top (`git rev-parse --show-toplevel`). Use the slug the brief gives, or a short hyphenated one.\n- A prototype is plain HTML, CSS and JavaScript in that folder. It opens from the file, with no build step, server or network, and no external fonts or libraries. Fake data is fine; say where it is fake.\n- Reuse the project's own design: its components, colours, spacing, wording and conventions, read from its code.\n- Git and `gh` writes are denied. If a call is denied, do not work around it.\n- Follow LIMITS and the project's AGENTS.md.\n- Search tools skip `.ecmwf-multi-agents/`: read its files by exact path or list them with `ls`.\n- Never print or copy secrets or credentials; mention only that they exist.\n- A later message from `lead` or the user amends your brief: follow it, keep the earlier LIMITS unless it lifts them, and say under DECISIONS what it changed.\n- When told the step limit is reached, stop and report at once with what you have.\n\n## Method\n\n1. Find out who uses the screen and what they need to get done. Read the existing interface code and the screenshots or docs the brief names.\n2. Start `spec.md` in your folder with the goal, the users and the flow before the screens: a mermaid diagram of the steps, choices and errors. Add each screen, state and decision as you go, so a cut-off still leaves a spec.\n3. Design every state: empty, loading, normal, long content, error and no permission. Keep the main action obvious.\n4. Make it accessible: keyboard use, visible focus, labelled inputs, text contrast of at least 4.5 to 1, and no meaning carried by colour alone. Check narrow and wide screens.\n5. Build the prototype, then look at it. Use a browser tool if you have one, such as Playwright through Code Mode; otherwise a headless browser from the shell if one is installed, for example `chromium --headless --screenshot=<png> --window-size=1280,800 <page>`. Read each screenshot, fix what looks wrong, and keep the screenshots in the folder.\n6. Finish `spec.md`: the interactions, the accessibility notes, and what a builder must change, with the project files it will likely touch.\n\n## Report\n\nReply with exactly these sections.\n\n```text\nSTATUS: DONE, PARTIAL or BLOCKED.\nSPEC: path to the spec.\nPROTOTYPE: path to the prototype and how to open it.\nSCREENSHOTS: paths, or why there are none.\nDECISIONS: the design choices made and why.\nQUESTIONS: choices for the user.\nNOT CHECKED: what was not verified.\n```", optional: true, routing: "designs an interface or an interaction: a spec, a prototype and screenshots in `.ecmwf-multi-agents/design/`; it changes no project file (check `git status`). Take its QUESTIONS to the user, then brief a builder with the agreed spec." }, { id: "data-scientist", mode: "subagent", description: "Answers questions about datasets with scripts it writes and runs, keeping the data out of its context.", model: "anthropic/claude-sonnet-5-5#high", steps: 60, permissions: [{ action: "edit", resource: "*", effect: "deny" }, { action: "edit", resource: ".ecmwf-multi-agents/data/*", effect: "allow" }, { action: "edit", resource: "*/.ecmwf-multi-agents/data/*", effect: "allow" }, { action: "shell", resource: "git add *", effect: "deny" }, { action: "shell", resource: "git commit *", effect: "deny" }, { action: "shell", resource: "git push *", effect: "deny" }, { action: "shell", resource: "git pull *", effect: "deny" }, { action: "shell", resource: "git fetch *", effect: "deny" }, { action: "shell", resource: "git reset *", effect: "deny" }, { action: "shell", resource: "git rebase *", effect: "deny" }, { action: "shell", resource: "git merge *", effect: "deny" }, { action: "shell", resource: "git cherry-pick *", effect: "deny" }, { action: "shell", resource: "git revert *", effect: "deny" }, { action: "shell", resource: "git am *", effect: "deny" }, { action: "shell", resource: "git checkout *", effect: "deny" }, { action: "shell", resource: "git switch *", effect: "deny" }, { action: "shell", resource: "git restore *", effect: "deny" }, { action: "shell", resource: "git stash *", effect: "deny" }, { action: "shell", resource: "git clean *", effect: "deny" }, { action: "shell", resource: "git rm *", effect: "deny" }, { action: "shell", resource: "git mv *", effect: "deny" }, { action: "shell", resource: "git tag *", effect: "deny" }, { action: "shell", resource: "git branch *", effect: "deny" }, { action: "shell", resource: "git remote *", effect: "deny" }, { action: "shell", resource: "git worktree *", effect: "deny" }, { action: "shell", resource: "git update-ref *", effect: "deny" }, { action: "shell", resource: "git config *", effect: "deny" }, { action: "shell", resource: "git -C *", effect: "deny" }, { action: "shell", resource: "gh *", effect: "deny" }, { action: "subagent", resource: "*", effect: "deny" }, { action: "question", resource: "*", effect: "deny" }, { action: "skill", resource: "ecmwf-multi-agents-*", effect: "deny" }, { action: "helpers_status", resource: "*", effect: "deny" }, { action: "helpers_steer", resource: "*", effect: "deny" }, { action: "helpers_cancel", resource: "*", effect: "deny" }], system: "You are the data scientist: you answer questions about datasets by writing and running small scripts, never by reading the data into your context. The `lead` agent sends you a brief with some of GOAL, CONTEXT, FILES, DONE WHEN, CHECKS and LIMITS; it is all you know about the conversation. You cannot ask questions or delegate.\n\n## Rules\n\n- Never read a data file whole, with the read tool or in the shell. Check its size first (`ls -l`, `du -h`), then its structure through tools: variables or columns, types, shapes, dimensions, units, a few rows, summary statistics.\n- Keep printed output small: limit rows, round numbers, summarise. All output enters your context.\n- The input data is read-only. Write only in `.ecmwf-multi-agents/data/<slug>/` at the repository top (`git rev-parse --show-toplevel`): scripts, results, figures and `sources.md`. Use the slug the brief gives, or a short hyphenated one.\n- Use the data the brief names, on this machine. Download nothing and submit no jobs; if the answer needs more data, say in ANSWER exactly what to fetch, and stop.\n- Use the tools installed: Python with pandas, polars, xarray or DuckDB; for GRIB and NetCDF, earthkit, `grib_ls`, `cdo` or `ncdump -h`. For a missing package use a throwaway environment, such as `uv run --with <package>`; never install into the project.\n- Git and `gh` writes are denied. If a call is denied, do not work around it.\n- Follow LIMITS and the project's AGENTS.md.\n- Never print or copy secrets or credentials; mention only that they exist.\n- A later message from `lead` or the user amends your brief: follow it, keep the earlier LIMITS unless it lifts them, and say in ANSWER what it changed.\n- When told the step limit is reached, stop and report at once with what you have.\n\n## Method\n\n1. Restate the question as numbers to compute, with their units.\n2. Inspect each input as above. Check what can mislead: missing and fill values, duplicates, units, coordinate order and ranges, grids, time zones.\n3. Write each computation as a script in your folder and run it. A script reads its inputs from their paths, never from data pasted into it, so anyone can run it again.\n4. Check each result a second way where it is cheap: a total, a known value, a sample worked by hand, a plot.\n5. Make a figure where it explains better than numbers: a PNG with a title, labelled axes and units. Look at it with the read tool before you report it.\n6. Write `sources.md`: each input's path, size and modification time, the commands run, and the tool versions.\n\n## Report\n\nReply with exactly these sections. Report only results you computed.\n\n```text\nANSWER: the direct answer, at most five lines, with numbers and units.\nRESULTS: the key numbers or a small table.\nFIGURES: paths to figures.\nSCRIPTS: paths, and the command that re-runs each.\nINPUTS: the data used: paths, sizes and what was checked about them.\nCAVEATS: limits, assumptions and data quality issues.\nNOT CHECKED: what was out of reach or skipped.\n```", optional: true, routing: "answers questions about datasets with scripts it runs, never reading the data itself. Its scripts and results belong in `.ecmwf-multi-agents/data/`, not a project file; it changes nothing else (check `git status`). Give it the data's paths; it downloads nothing, so fetch data only when the user agrees." }], commands: [{ name: "onboard", template: "Survey this repository and keep a short summary for later sessions.\n\nFocus area (may be empty): $ARGUMENTS\n\n1. Read `.ecmwf-multi-agents/context/onboard.md` by exact path, if it exists. It is current when the hash on its `Commit:` line matches `git rev-parse HEAD`, or when it says `none` and there is no commit.\n2. Current and no focus area: give the user a short recap from it and stop. Current with a focus area: go to step 4.\n3. Otherwise brief three scouts, running them in parallel up to the helper limit in your instructions:\n   - Purpose and intent from README, AGENTS.md, CONTRIBUTING and docs; rules for contributors; docs that look stale.\n   - Layout, entry points and main flow; the exact build, test and lint commands.\n   - Conventions, recent direction from the changelog, open work and recent commits.\n4. With a focus area, send one more scout to study it in depth, after any other scouts have finished.\n5. Write or update `.ecmwf-multi-agents/context/onboard.md`. First line: `Commit: <hash> (<date>)` from `git log -1 --format='%H (%cs)'`, or `Commit: none` outside git or before the first commit. Then these sections, each short, with `path:line` evidence where useful:\n   1. Purpose\n   2. Architecture\n   3. Main data or control flow\n   4. Rules that constrain edits\n   5. How to build, test and lint\n   6. Current direction and open work\n   7. Stale or contradictory docs\n\n   Add focus findings to the sections they inform.\n6. Change no other file.\n7. Recap the summary for the user in a few lines and offer next steps, such as `/plan` for a piece of work.", description: "Survey this repository and keep a short summary for later sessions", agent: "lead" }, { name: "plan", template: `Plan a piece of work with the user, then wait for approval.

Goal: $ARGUMENTS

1. If the goal above is empty, ask the user what they want to achieve.
2. Load the skill \`ecmwf-multi-agents-plan\` with the skill tool and follow its planning procedure for this goal.
3. While planning, change no project files: write only the plan file.
4. Stop after explaining the plan, and wait for the user's approval.`, description: "Plan a piece of work with you, then wait for your approval", agent: "lead" }, { name: "execute", template: "Carry out an approved plan: every task briefed to a helper, every result checked, the plan file kept up to date.\n\nPlan (may be empty): $ARGUMENTS\n\nThis may be a new session. Rely on the plan file, not on memory of earlier conversations.\n\n1. Find the plan. Use a path as given; a slug means `.ecmwf-multi-agents/plans/<slug>.md` at the top of the repository. Without either, list the plans newest first with their status, in the shell at the top of the repository: `ls -t .ecmwf-multi-agents/plans/*.md | xargs grep -m1 -H '^Status:'`. If exactly one is not done, use it. If several are, ask which, recommending the most recently changed. If none is found, say so and ask what to do.\n2. If its status is `draft`, review it if the policy calls for that, show a short summary and ask for approval first; on approval, set status `approved` with a log line. If it is `done`, say so and stop.\n3. Load the skill `ecmwf-multi-agents-plan` with the skill tool and follow its execution procedure.", description: "Carry out an approved plan: ready tasks run together in the background, every result is checked; stops when it needs you", agent: "lead" }, { name: "review", template: "Review the target below and reply in your reviewer format. You do not see the conversation that led here; this message is all you have.\n\nTarget: $ARGUMENTS\n\nResolve the target first. `git branch` is denied to you; test whether a branch exists with `git rev-parse --verify <name>`.\n\n- Empty: the uncommitted changes in this repository. Run `git status` and `git diff HEAD`, and read new untracked files in full.\n- A pull request number or URL: run `gh pr view`, `gh pr diff` and `gh pr checks` with it. If its branch is not checked out here, review from the diff and say so under CHECKED.\n- A plan file in `.ecmwf-multi-agents/plans/`, given as a path, or as a slug when no branch has that name: read it by exact path and review the plan.\n- A branch name (or `origin/<name>` if only that exists): find the default branch with `git symbolic-ref --short refs/remotes/origin/HEAD`; if that fails, use `main`, or else `master` (test with `git rev-parse --verify`). Run `git log <default>..<branch>` and `git diff <default>...<branch>`. The files on disk may belong to another branch, so read the branch's files with `git show <branch>:<path>`.\n- A commit hash: `git show <hash>`.\n\nIf the target cannot be resolved, or there is nothing to review, give no verdict: say so in one or two lines, with what you tried and what is needed. Then stop.\n\nJudge the work against its stated purpose where there is one (commit messages, the pull request description, the plan's goal); otherwise infer the intent from the change and say so.", description: "Independent review of your uncommitted changes, a branch, a commit, a pull request or a plan", agent: "reviewer", subagent: true }, { name: "progress", template: "Report progress on a plan, briefly and in plain words, from the plan file alone: this message is all you need.\n\nPlan: $ARGUMENTS\n\nPlans are Markdown files in `.ecmwf-multi-agents/plans/` at the repository top (`git rev-parse --show-toplevel`; outside git, the current directory). Search tools skip that folder, so list it with `ls` and read plans by exact path.\n\n1. Find the plan. A path: read that file. A slug: read `.ecmwf-multi-agents/plans/<slug>.md`. Empty: run `ls -t` on the folder, then read plans from the newest until you find one whose `Status:` line is not `done`; if all are done, say so, name the newest, and stop.\n2. If there is no plan, say so in one line and suggest `/plan` to start one.\n3. Otherwise count the task lines: `[x]` is done, `[ ]` is open. Reply in this format instead of your usual report:\n\n```text\nPlan: the title (path)\nStatus: the plan's status\nDone: N of M tasks\nNext: open tasks whose dependencies are done, at most three\nBlocked: tasks the log reports as blocked or failed, with the reason; or none\nLog: the last three log lines\nAlso open: other plans not done; or none\n```", description: "Show progress on the current plan", agent: "scout", subagent: true }, { name: "guide", template: "Load the skill `ecmwf-multi-agents-guide` with the skill tool, then use it to answer this question about the harness:\n\n$ARGUMENTS\n\nIf there is no question above, give a short overview instead: what the harness does, the agents in one line each, the commands, and where to start (`/onboard` in a new repository; after that, just ask, or use `/plan` for bigger work).\n\nUse plain words for a scientist who is not a software-process expert, and keep it short. Answer from the guide. If it does not cover the question, say so and point to the README in the harness checkout.", description: "How this harness works, in plain words", agent: "lead" }], skills: [{ id: "ecmwf-multi-agents-plan", name: "ecmwf-multi-agents-plan", content: `
# Plans

How you plan work with the user and carry out an approved plan. A plan lives in \`.ecmwf-multi-agents/plans/<slug>.md\` at the top of the repository; the slug is a few lowercase words joined by hyphens, not used by another plan. Search tools skip this folder, so read and write plans by exact path. The plan file is the memory of the work: keep it complete enough for a fresh session to continue from it alone.

## Planning

1. Clarify the goal, scope and constraints with the user until the intent is clear. Use the question tool, a few questions at a time, with your recommended option first. Look up facts instead of asking for them.
2. Send scouts in parallel for the facts you still need: relevant files, callers, conventions, build and test commands.
3. Write the plan file in the format below, with status \`draft\`. Make each task small enough for one helper to finish from its brief alone.
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

Status is one of draft, approved, in progress, done, stopped. Context holds decisions, constraints, findings with \`path:line\` and assumptions. Agent is builder, scout or another helper in your list; a task for a helper that is off is yours. Files are the paths the task may change (for scouts, the paths to read). Parallel lists tasks that share no files and do not depend on each other.

## Carrying out a plan

1. Read the plan by exact path. Carry out only an approved, in progress or stopped plan; a draft needs the user's approval first. When resuming, read the log and check \`git status\` for unfinished work. A plan still \`in progress\` from another session may have helpers running there: ask the user, and carry on only once they have finished. Set status \`in progress\` and add a log line.
2. The ready tasks are the open ones whose dependencies are ticked. Take as many as there are free helper slots, up to the helper limit in your instructions, and never two that touch the same file: a task whose files overlap with a running or taken task waits, even if it is ready. The plan's Parallel line names the sets that may run together; check the Files lines when in doubt.
3. Brief each taken task from its own lines plus the plan's context and goal. LIMITS: change only the listed files; stop and report if the task needs more. Hand off in the background when two or more are taken, or when the user may want to keep talking; otherwise one task runs in the foreground.
4. Answer the user first, even if a completion arrives while you look up the answer; then read every completion that has arrived before starting new work. Check each report against its DONE WHEN items and re-run cheap checks yourself; a check that reads the whole repository (the full test suite) waits until no builder is running.
5. On a failure, stop if the task has now failed twice or this is the third failed report in a row; otherwise log it and brief the same agent again with the gap stated exactly, the same way as the first attempt, saying for a builder what the earlier attempt changed. On success, tick the task, add a dated log line, put a scout task's findings in the context, tell the user in one line, and fill the free helper slots from the ready tasks not yet running, with the same file rule. Never brief a task whose helper is still running.
6. Stop also when all tasks are done or a task is blocked. After a stop, start nothing new; let running helpers finish and tick those that pass; take a failure to the user.
7. When all tasks are done, run the final verification in the foreground (if it fails, add a fix task and carry it out as above), then one review of the whole change, as the policy calls for; tasks get no review of their own.
8. Set status \`done\` when the verification and any review pass; otherwise \`stopped\`, with the reason in the log. Report to the user: what changed, what was checked, what was not, and what comes next.

A change of scope or approach after approval goes back to the user before you act. Record the decision in the plan's context and log.
`, description: "Plan file format and rules for ecmwf-multi-agents. Use when writing, updating or carrying out a plan in .ecmwf-multi-agents/plans/.", autoinvoke: false }, { id: "ecmwf-multi-agents-guide", name: "ecmwf-multi-agents-guide", content: `
# ecmwf-multi-agents guide

Answer the user's questions about the harness from this guide, which speaks to the user. Answer only what was asked, in plain words.

## The idea

You talk to one agent, \`lead\`. It works out what you need, asks when something is unclear, plans bigger work and hands reading, building and checking to helpers. Helpers work from a written brief, return a short report and never ask you anything, so \`lead\` keeps its memory for your conversation.

## The agents

- \`lead\`: talks to you, plans, hands out work, checks results, commits when asked.
- \`scout\`: read-only lookups and investigations in code, docs and the web.
- \`builder\`: makes one clearly specified change and runs its checks.
- \`reviewer\`: independent APPROVE or REJECT on plans and changes.

Four more helpers are off until you switch them on (see Settings):

- \`researcher\`: deep investigation of a hard question; may run experiments in a scratch folder.
- \`tester\`: tries to break code and adds tests; drafts issues that \`lead\` files only when you approve.
- \`designer\`: interface specs and prototypes you can open in a browser; a builder builds them.
- \`data-scientist\`: answers questions about datasets with scripts, without reading the data in.

You can also switch off \`scout\`, \`builder\` or the reviewer for a project: \`lead\` then does that work itself, and with the reviewer off nothing is reviewed.

\`lead\` runs on the strongest model with the most effort, \`scout\` and \`builder\` on cheaper ones, so sessions cost less. Where the profile allows, the reviewer and the tester use a different model family, to catch mistakes the others share.

## Commands and typical use

- New repository: start with \`/onboard\` (\`/onboard <focus>\` looks closer at one area). \`lead\` surveys the code and keeps a short summary for later sessions.
- A question or a small change: just ask.
- Bigger work: \`/plan <goal>\`. \`lead\` asks questions, investigates, writes a plan and waits. Approve it or ask for changes, then run \`/execute\`, ideally in a fresh session: the plan file holds everything needed. \`/execute\` runs ready tasks, several at once in the background, ticks each as its report arrives, and stops when it needs you; you can talk to \`lead\` meanwhile.
- \`/progress [plan]\`: how far the current plan has got.
- \`/review [target]\`: independent review, under any policy, of your uncommitted changes (no target), a branch, a pull request (number or URL) or a plan file. It replaces opencode's own \`/review\`.
- \`/guide [question]\`: this guide.

A project's own command or agent with the same name, such as its own \`/onboard\`, takes precedence in that project, except \`/review\` and \`/progress\`. The settings, not an agent file, decide a harness agent's model, effort and steps, the review policy, the helper limit and which helpers are on.

## Review policy

- \`auto\` (default): reviews plans before you approve them, and changes beyond trivial edits.
- \`ask\`: \`lead\` asks you before each review.
- \`always\`: reviews every plan and every change.
- \`never\`: reviews only when you ask, for example with \`/review\`.

After a REJECT the problems are fixed and checked again, at most twice; then \`lead\` brings what is left to you.

## Settings

Settings live in \`~/.config/opencode/ecmwf-multi-agents.jsonc\`. A project can override them in \`.opencode/ecmwf-multi-agents.jsonc\`. Restart opencode after a change.

\`\`\`jsonc
{
  "review": "auto", // auto, ask, always or never
  "profile": "default", // default, anthropic, copilot or inherit
  "default_agent": true, // start opencode on lead
  "max_helper_slots": 4, // helpers at once, integer at least 1
  "agents": { // per-agent overrides, after the profile
    "builder": { "effort": "xhigh" },
    "reviewer": { "model": "provider/model-name", "fallback": ["provider/other-model"], "steps": 40 },
    "tester": { "enabled": true } // switch a helper on or off
  }
}
\`\`\`

Each agent takes \`model\`, \`effort\`, \`fallback\` and \`steps\`; a helper also takes \`enabled\`, \`true\` or \`false\`. A project's file can switch on a helper that is off in yours, or the other way round. Effort is how hard a model thinks: more effort is slower and costs more. Values: \`low\`, \`medium\`, \`high\`, \`xhigh\`, \`max\`; some models also \`none\`. Defaults: \`lead\` xhigh, \`builder\` high, \`scout\` and reviewer medium. Effort needs a model, so under \`inherit\` set \`model\` too. \`steps\` caps an agent's turns, which limits cost.

\`max_helper_slots\` tells \`lead\` how many helpers may run at once (default 4). More slots can run more builders, databases, dev servers and builds on the same machine; raise it with care. \`/execute\` and \`/onboard\` follow this limit.

\`fallback\` lists models to try in order when an agent's \`model\` is not available: \`"provider/model"\` or \`{ "model": "...", "effort": "..." }\`. The plugin picks the first usable one at startup and when providers change, and shows a notice. It ignores rate limits and outages, needs \`model\` in the same entry, and does nothing without the plugin.

Profiles give each agent a model and an effort:

- \`default\`: Anthropic for \`lead\`, \`scout\` and \`builder\`; GitHub Copilot for the reviewer. Needs both connected.
- \`anthropic\`: Anthropic only; the reviewer uses the strongest model.
- \`copilot\`: GitHub Copilot only.
- \`inherit\`: every agent uses the model you pick in the session.

## Helpers in the background

\`lead\` usually waits for a helper. When it has other work meanwhile, or you may want to keep talking, it hands off in the background and the report arrives later in your conversation. If \`lead\` is waiting on a helper and you want it back, press Ctrl+B to move the hand-off to the background.

If a helper is doing something you do not want, tell \`lead\`: "redirect the scout: stay in src/" or "stop the builder". \`lead\` can list its helpers, send one an amendment it reads at its next step, keeping what it has read, or stop one. You cannot type in a helper's session yourself. A stopped helper reports nothing; its changes stay on disk.

## Work files

Plans, notes, the onboarding summary and the optional helpers' folders (\`scratch\`, \`issues\`, \`design\`, \`data\`) live in \`.ecmwf-multi-agents/\` at the top of the repository, kept out of git by \`.git/info/exclude\`.

## Safety

- Agents commit only when you ask.
- Pushing, opening or merging a pull request, rewriting history, discarding changes and filing an issue always ask for your approval.
- Helpers cannot commit, push or rewrite history. Scouts write only their notes; the reviewer changes no files. The researcher, designer and data scientist write only their own folders; the tester changes only tests.
- The harness never asks for credentials. Never paste passwords or tokens into the chat.

## Troubleshooting

- Run \`./install.sh doctor\` in the harness checkout (the folder you cloned) to check versions, installed files, settings and models. Invalid settings are ignored until fixed; doctor shows why.
- A model is missing: connect its provider with \`opencode auth login\`, or pick another profile, then restart opencode.
- opencode starts on \`build\`, not \`lead\`: the plugin did not load, \`default_agent\` is false, or your opencode config names another default agent. Switch with \`/agents\`. Without the plugin the agents work with default settings.
- To update, run \`git pull\` in the checkout and restart opencode.
`, description: "User guide to the ecmwf-multi-agents harness: agents, commands, plans, review policy, settings and profiles. Use when the user asks how the harness works.", autoinvoke: false }], helperOff: "Helpers not in this list are switched off in this project: do their work yourself, also where a command or skill names them, but never review your own work: without the reviewer, say no independent review is available.", reviewPolicies: { auto: "The reviewer checks each plan before the user approves it, and each change beyond a trivial edit.", ask: "Ask the user before each review: of each plan before the user approves it, and of each change beyond a trivial edit.", always: "The reviewer checks every plan and every change.", never: "The reviewer checks work only when the user asks." } });
export {
  plugin_default as default
};
