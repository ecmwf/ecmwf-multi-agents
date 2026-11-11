// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// What the settings mean for each agent, and how that lands in opencode 2.0.16 agent info
// (`model` as {id, providerID, variant}, `steps`, `system`). The settings and profiles call the
// reasoning effort `effort`; opencode calls it the model variant, so the effort is written as
// `variant`. Every function works out all changes before making any, so an unexpected shape
// changes nothing.

import { enabledHelpers, helpersOf, rewriteHelperList } from "./helper-list.ts";
import type { EmbeddedHarness, FallbackEntry, Problem, ReviewPolicy, Settings, V2AgentEditor, V2ModelRef } from "./types.ts";

/** The model, reasoning effort and step limit one agent ends up with. */
export interface AgentPlan {
  id: string;
  /** undefined: no model of its own, so the agent uses the session model (and no effort). */
  model?: string;
  /** Written to opencode as the model variant. */
  effort?: string;
  /** Models to try, in order, when `model` is not usable (see ModelChoices); only with a model. */
  fallback?: FallbackEntry[];
  /** undefined: keep the agent's own step limit. */
  steps?: number;
}

/**
 * The chosen profile, then the per-agent overrides. Model, effort and fallbacks go together: an
 * override model replaces the profile's model, effort and fallbacks (its own fallbacks, if
 * any, take their place); an override effort alone applies to the profile's model, and is
 * reported and ignored when there is no model at all. An override `fallback`, even an empty
 * one, replaces the profile's list; none given leaves the profile's.
 */
export function planAgents(harness: EmbeddedHarness, settings: Settings): { plans: AgentPlan[]; problems: Problem[] } {
  const profile = harness.profiles.find((item) => item.id === settings.profile);
  const problems: Problem[] = [];
  const plans = harness.agents.map((agent): AgentPlan => {
    const fromProfile = profile?.agents[agent.id];
    const override = settings.agents[agent.id] ?? {};
    const plan: AgentPlan = { id: agent.id };
    if (override.model !== undefined) {
      plan.model = override.model;
      if (override.effort !== undefined) plan.effort = override.effort;
      if (override.fallback !== undefined && override.fallback.length > 0) plan.fallback = override.fallback;
    } else if (fromProfile?.model !== undefined) {
      plan.model = fromProfile.model;
      const effort = override.effort ?? fromProfile.effort;
      if (effort !== undefined) plan.effort = effort;
      const fallback = override.fallback ?? fromProfile.fallback;
      if (fallback !== undefined && fallback.length > 0) plan.fallback = fallback;
    } else if (override.effort !== undefined) {
      problems.push({
        message:
          `${harness.name}: the effort ${JSON.stringify(override.effort)} for ${agent.id} was ignored: ` +
          `profile ${JSON.stringify(settings.profile)} gives ${agent.id} no model and the settings name none, ` +
          `so it uses the session model`,
        notify: true,
      });
    }
    if (override.steps !== undefined) plan.steps = override.steps;
    return plan;
  });
  return { plans, problems };
}

const REVIEW_LINE = /^Review policy:[^\r\n]*/gm;
// Also recognizes the word "three" in an older installed or user-supplied lead prompt.
const HELPER_SLOTS_LINE = /^Run at most \S+ helpers? at once\./gm;

/** The one concurrency instruction in the loaded prompt, or null when it is missing or ambiguous. */
export function helperSlotsLine(prompt: string): string | null {
  const matches = prompt.match(HELPER_SLOTS_LINE) ?? [];
  return matches.length === 1 ? matches[0]! : null;
}

/** Replace just the helper limit, preserving the file-ownership and parallel-start rules after it. */
export function rewriteHelperSlotsLine(
  prompt: string,
  slots: number,
  agent: string,
): { prompt: string; problem?: undefined } | { prompt?: undefined; problem: string } {
  const count = prompt.match(HELPER_SLOTS_LINE)?.length ?? 0;
  if (count !== 1) {
    return { problem: `the prompt of ${agent} has ${count === 0 ? "no" : count} "Run at most ... helpers at once." instruction${count > 1 ? "s" : ""}; max_helper_slots was not applied` };
  }
  return { prompt: prompt.replace(HELPER_SLOTS_LINE, `Run at most ${slots} ${slots === 1 ? "helper" : "helpers"} at once.`) };
}

/**
 * Replace the one `Review policy: <value>` line, and the meaning on the line after it when that
 * is one of the harness's meanings (a line of the user's own stays); report instead when there
 * is not exactly one policy line.
 */
export function rewriteReviewLine(
  prompt: string,
  policy: ReviewPolicy,
  agent: string,
  meanings?: Readonly<Record<ReviewPolicy, string>>,
): { prompt: string; problem?: undefined } | { prompt?: undefined; problem: string } {
  const count = prompt.match(REVIEW_LINE)?.length ?? 0;
  if (count === 0) return { problem: `the prompt of ${agent} has no "Review policy:" line, so the review policy stays as the prompt says` };
  if (count > 1) return { problem: `the prompt of ${agent} has ${count} "Review policy:" lines instead of one, so none was changed` };
  const lines = prompt.split("\n");
  const at = lines.findIndex((line) => line.startsWith("Review policy:"));
  const ending = (line: string) => (line.endsWith("\r") ? "\r" : "");
  lines[at] = `Review policy: ${policy}${ending(lines[at]!)}`;
  const next = lines[at + 1];
  if (meanings !== undefined && next !== undefined && Object.values(meanings).includes(next.replace(/\r$/, ""))) {
    lines[at + 1] = `${meanings[policy]}${ending(next)}`;
  }
  return { prompt: lines.join("\n") };
}

function reviewProblem(harness: EmbeddedHarness, settings: Settings, problem: string): Problem {
  // Worth a toast only when the user chose a policy that now has no effect.
  return { message: `${harness.name}: ${problem}`, notify: settings.reviewSet };
}

export function modelRef(model: string, effort: string | undefined): V2ModelRef {
  // Split at the first "/", as opencode does (Model.Ref.parse in @opencode/schema 2.0.16).
  const slash = model.indexOf("/");
  const ref: V2ModelRef = { id: model.slice(slash + 1), providerID: model.slice(0, slash) };
  if (effort !== undefined) ref.variant = effort;
  return ref;
}

/** The agent `/review` runs on: the reviewer, without which nothing is reviewed. */
export function reviewerId(harness: EmbeddedHarness): string {
  return harness.commands.find((command) => command.name === "review")?.agent ?? "reviewer";
}

/** The review policy in force: `never` while the reviewer is switched off. */
export function effectiveReview(harness: EmbeddedHarness, settings: Settings, on: ReadonlySet<string> = enabledHelpers(harness, settings)): ReviewPolicy {
  const reviewer = reviewerId(harness);
  return helpersOf(harness).some((helper) => helper.id === reviewer) && !on.has(reviewer) ? "never" : settings.review;
}

/** True when the settings switch a helper away from its default: an optional one on, or another off. */
export function helpersSwitched(harness: EmbeddedHarness, on: ReadonlySet<string>): boolean {
  return helpersOf(harness).some((helper) => on.has(helper.id) === (helper.optional === true));
}

/**
 * Apply plans, the review policy, the helper limit and the helpers switched on and off through
 * an opencode 2 agent editor. The effort goes to `model.variant`. Only agents that already exist
 * are touched: `update` would create a missing one. A default helper that is off is removed,
 * whatever brought it; an optional one that is off was never registered, and an agent of the
 * user's with its name is left alone. Returns problems to report.
 */
export function applyToV2Agents(editor: V2AgentEditor, harness: EmbeddedHarness, settings: Settings, plans: readonly AgentPlan[]): Problem[] {
  const problems: Problem[] = [];
  const changes: Array<() => void> = [];
  const helpers = helpersOf(harness);
  const on = enabledHelpers(harness, settings);
  const off = new Set(helpers.filter((helper) => !on.has(helper.id)).map((helper) => helper.id));

  for (const helper of helpers) {
    if (helper.optional === true || !off.has(helper.id) || editor.get(helper.id) === undefined) continue;
    if (typeof editor.remove === "function") changes.push(() => editor.remove!(helper.id));
    else problems.push({ message: `${harness.name}: this opencode cannot remove agents, so ${helper.id} stays although it is switched off`, notify: true });
  }

  for (const plan of plans) {
    if (off.has(plan.id) || editor.get(plan.id) === undefined) continue;
    const model = plan.model === undefined ? undefined : modelRef(plan.model, plan.effort);
    changes.push(() =>
      editor.update(plan.id, (agent) => {
        if (model === undefined) delete agent.model;
        else agent.model = model;
        if (plan.steps !== undefined) agent.steps = plan.steps;
      }),
    );
  }

  const review = effectiveReview(harness, settings, on);
  if (review !== settings.review && settings.reviewSet) {
    problems.push({ message: `${harness.name}: the review policy "${settings.review}" needs the reviewer, which is switched off, so nothing is reviewed`, notify: true });
  }

  const lead = editor.get(harness.defaultAgent);
  if (lead !== undefined) {
    // lead's own rules allow only the default helpers, so an agent of the user's with an optional
    // helper's name stays out of reach; an optional helper that is on is allowed after them. A
    // rebuild starts from scratch, but two registrations may overlap in one: add the rule once.
    const allows = helpers.filter((helper) => helper.optional === true && on.has(helper.id));
    if (allows.length > 0) {
      changes.push(() =>
        editor.update(harness.defaultAgent, (agent) => {
          if (!Array.isArray(agent.permissions)) agent.permissions = [];
          const rules = agent.permissions;
          for (const helper of allows) {
            const last = [...rules].reverse().find((rule) => rule.action === "subagent" && rule.resource === helper.id);
            if (last?.effect !== "allow") rules.push({ action: "subagent", resource: helper.id, effect: "allow" });
          }
        }),
      );
    }
    if (typeof lead.system === "string") {
      const result = rewriteReviewLine(lead.system, review, harness.defaultAgent, harness.reviewPolicies);
      if (result.problem !== undefined) problems.push(reviewProblem(harness, settings, result.problem));
      const slots = rewriteHelperSlotsLine(result.prompt ?? lead.system, settings.maxHelperSlots, harness.defaultAgent);
      if (slots.problem !== undefined) problems.push({ message: `${harness.name}: ${slots.problem}`, notify: settings.maxHelperSlotsSet });
      let prompt = slots.prompt ?? result.prompt;
      if (helpersSwitched(harness, on)) {
        const list = rewriteHelperList(prompt ?? lead.system, helpers, on, harness.helperOff, harness.defaultAgent);
        if (list.problem !== undefined) problems.push({ message: `${harness.name}: ${list.problem}`, notify: true });
        else prompt = list.prompt;
      }
      if (prompt !== undefined) {
        const system = prompt;
        changes.push(() => editor.update(harness.defaultAgent, (agent) => (agent.system = system)));
      }
    } else {
      problems.push(reviewProblem(harness, settings, `${harness.defaultAgent} has no prompt, so the review policy was not applied`));
      problems.push({ message: `${harness.name}: ${harness.defaultAgent} has no prompt, so max_helper_slots was not applied`, notify: settings.maxHelperSlotsSet });
    }
  }

  for (const change of changes) change();
  return problems;
}
