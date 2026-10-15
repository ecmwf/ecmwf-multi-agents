// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// What the settings mean for each agent, and how that lands in opencode 2.0.16 agent info
// (`model` as {id, providerID, variant}, `steps`, `system`). The settings and profiles call the
// reasoning effort `effort`; opencode calls it the model variant, so the effort is written as
// `variant`. Every function works out all changes before making any, so an unexpected shape
// changes nothing.

import type { EmbeddedHarness, Problem, ReviewPolicy, Settings, V2AgentEditor, V2ModelRef } from "./types.ts";

/** The model, reasoning effort and step limit one agent ends up with. */
export interface AgentPlan {
  id: string;
  /** undefined: no model of its own, so the agent uses the session model (and no effort). */
  model?: string;
  /** Written to opencode as the model variant. */
  effort?: string;
  /** undefined: keep the agent's own step limit. */
  steps?: number;
}

/**
 * The chosen profile, then the per-agent overrides. Model and effort go together: an override
 * model replaces the profile's model and effort; an override effort alone applies to the
 * profile's model, and is reported and ignored when there is no model at all.
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
    } else if (fromProfile?.model !== undefined) {
      plan.model = fromProfile.model;
      const effort = override.effort ?? fromProfile.effort;
      if (effort !== undefined) plan.effort = effort;
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

/** Replace the one `Review policy: <value>` line; report instead when there is not exactly one. */
export function rewriteReviewLine(
  prompt: string,
  policy: ReviewPolicy,
  agent: string,
): { prompt: string; problem?: undefined } | { prompt?: undefined; problem: string } {
  const count = prompt.match(REVIEW_LINE)?.length ?? 0;
  if (count === 0) return { problem: `the prompt of ${agent} has no "Review policy:" line, so the review policy stays as the prompt says` };
  if (count > 1) return { problem: `the prompt of ${agent} has ${count} "Review policy:" lines instead of one, so none was changed` };
  return { prompt: prompt.replace(REVIEW_LINE, `Review policy: ${policy}`) };
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

/**
 * Apply plans and the review policy through an opencode 2.0.16 agent editor. The effort goes to
 * `model.variant`. Only agents that already exist are touched: `update` would create a missing
 * one. Returns problems to report.
 */
export function applyToV2Agents(editor: V2AgentEditor, harness: EmbeddedHarness, settings: Settings, plans: readonly AgentPlan[]): Problem[] {
  const problems: Problem[] = [];
  const changes: Array<() => void> = [];

  for (const plan of plans) {
    if (editor.get(plan.id) === undefined) continue;
    const model = plan.model === undefined ? undefined : modelRef(plan.model, plan.effort);
    changes.push(() =>
      editor.update(plan.id, (agent) => {
        if (model === undefined) delete agent.model;
        else agent.model = model;
        if (plan.steps !== undefined) agent.steps = plan.steps;
      }),
    );
  }

  const lead = editor.get(harness.defaultAgent);
  if (lead !== undefined) {
    if (typeof lead.system === "string") {
      const result = rewriteReviewLine(lead.system, settings.review, harness.defaultAgent);
      if (result.problem !== undefined) problems.push(reviewProblem(harness, settings, result.problem));
      else changes.push(() => editor.update(harness.defaultAgent, (agent) => (agent.system = result.prompt)));
    } else {
      problems.push(reviewProblem(harness, settings, `${harness.defaultAgent} has no prompt, so the review policy was not applied`));
    }
  }

  for (const change of changes) change();
  return problems;
}
