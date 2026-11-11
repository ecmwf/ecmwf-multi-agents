// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// JSON Schema (draft 2020-12) for the settings file ecmwf-multi-agents.jsonc, described in
// docs/architecture.md, "Settings". It is generated from the resolved harness, so profile and
// agent names and the default models and efforts stay current, and it shares the model and
// effort patterns with the plugin's own settings check (plugin/settings.ts), so an editor and
// the plugin accept the same files.

import { DEFAULT_MAX_HELPER_SLOTS, EFFORT_PATTERN, MODEL_PATTERN, SETTINGS_FILE } from "../plugin/settings.ts";
import { REVIEW_POLICIES } from "../plugin/types.ts";
import { DEFAULT_REVIEW_POLICY } from "./resolve.ts";
import type { ResolvedAgent, ResolvedHarness } from "./types.ts";
import { listWords, own } from "./util.ts";

export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = { [key: string]: JsonValue };

const REVIEW_HELP: Readonly<Record<(typeof REVIEW_POLICIES)[number], string>> = {
  auto: "plans are reviewed before you approve them, and changes beyond a trivial edit are reviewed",
  ask: "lead asks you each time",
  always: "every plan and every change is reviewed",
  never: "nothing is reviewed unless you ask with /review",
};

/**
 * Plain-language help for an agent's effort setting: common values, the default from the default
 * profile, and the profiles under which it does nothing because they give the agent no model.
 */
function effortHelp(agent: ResolvedAgent, harness: ResolvedHarness): string {
  const sentences = [
    `Reasoning effort for the model of ${agent.id}.`,
    "Common values: low, medium, high, xhigh and max; some models also take none.",
  ];
  const profile = harness.profiles.find((candidate) => candidate.id === harness.defaultProfile);
  const choice = profile === undefined ? undefined : own(profile.agents, agent.id);
  if (choice?.effort !== undefined) sentences.push(`Default: ${choice.effort}, from the ${harness.defaultProfile} profile.`);
  else if (choice?.model !== undefined) sentences.push(`The ${harness.defaultProfile} profile sets none, so the model's own default applies.`);
  const modelless = harness.profiles
    .filter((candidate) => own(candidate.agents, agent.id)?.model === undefined)
    .map((candidate) => candidate.id);
  const applies = `It applies only when ${agent.id} has a model, from the profile or from this entry`;
  if (modelless.length === 0) sentences.push(`${applies}.`);
  else {
    const profiles = `${listWords(modelless)} profile${modelless.length === 1 ? "" : "s"}`;
    sentences.push(`${applies}, so it has no effect under the ${profiles} unless this entry also names a model.`);
  }
  sentences.push('No "#" and no spaces. Leave it out to use the profile\'s choice.');
  return sentences.join(" ");
}

/** The switch of a helper; the default agent is always on and has none. */
function enabledSchema(agent: ResolvedAgent, harness: ResolvedHarness): JsonSchema {
  const optional = agent.optional === true;
  const lead = harness.defaultAgent;
  // The agent /review runs on: nothing else gives an independent verdict.
  const reviewer = harness.commands.find((command) => command.id === "review")?.agent;
  const meaning = optional
    ? `${agent.id} is an optional helper, on only where a settings file switches it on.`
    : agent.id === reviewer
      ? `When it is off, nothing is reviewed: ${lead} says no independent review is available.`
      : `When it is off, ${lead} does its work itself.`;
  return {
    title: "On or off",
    description: `Switch ${agent.id} on or off, for you or for one project. Default: ${!optional}${optional ? ":" : "."} ${meaning}`,
    type: "boolean",
    default: !optional,
  };
}

/**
 * The ordered list of fallback models; each entry is `provider/model` or { model, effort }. Keep
 * it in step with validateFallback (plugin/settings.ts).
 */
function fallbackSchema(agent: ResolvedAgent): JsonSchema {
  const model: JsonSchema = {
    title: "Model",
    description: 'Written as provider/model. No "#" and no spaces.',
    type: "string",
    pattern: MODEL_PATTERN.source,
  };
  return {
    title: "Fallback models",
    description:
      `Models ${agent.id} tries, in order, when its own model is not usable. Each entry is provider/model, ` +
      'or an object with "model" and an optional "effort". Needs a model in this same entry. ' +
      "Setting a model without a fallback list drops the profile's list; an empty list means no fallbacks. " +
      "A list here replaces any list from the profile or from an earlier settings file.",
    type: "array",
    items: {
      title: "Fallback model",
      description: "A model, or a model with its reasoning effort.",
      oneOf: [
        model,
        {
          title: "Model with effort",
          description: "A fallback model and the reasoning effort to use on it.",
          type: "object",
          additionalProperties: false,
          required: ["model"],
          properties: {
            model,
            effort: {
              title: "Reasoning effort",
              description: 'Reasoning effort for this model, such as "high". No "#" and no spaces. Leave it out for the model\'s own default.',
              type: "string",
              minLength: 1,
              pattern: EFFORT_PATTERN.source,
            },
          },
        },
      ],
    },
  };
}

function agentSchema(agent: ResolvedAgent, harness: ResolvedHarness): JsonSchema {
  const profile = harness.profiles.find((candidate) => candidate.id === harness.defaultProfile);
  const example = profile === undefined ? undefined : own(profile.agents, agent.id)?.model;
  const steps = agent.steps === undefined ? "no limit" : String(agent.steps);
  return {
    title: agent.id,
    description: `${agent.description} Settings here override the profile for ${agent.id}.`,
    type: "object",
    additionalProperties: false,
    // The plugin refuses fallback models without a model in the same entry.
    dependentRequired: { fallback: ["model"] },
    properties: {
      ...(agent.id === harness.defaultAgent ? {} : { enabled: enabledSchema(agent, harness) }),
      model: {
        title: "Model",
        description:
          `Model for ${agent.id}, written as provider/model` +
          `${example === undefined ? "" : `, for example ${example}`}. No "#" and no spaces. ` +
          "Leave it out to use the profile's choice.",
        type: "string",
        pattern: MODEL_PATTERN.source,
      },
      effort: {
        title: "Reasoning effort",
        description: effortHelp(agent, harness),
        type: "string",
        minLength: 1,
        pattern: EFFORT_PATTERN.source,
      },
      fallback: fallbackSchema(agent),
      steps: {
        title: "Step limit",
        description: `Most model turns ${agent.id} may take before it stops and reports. A whole number of at least 1. Default: ${steps}.`,
        type: "integer",
        minimum: 1,
      },
    },
  };
}

/** The settings schema, ready for `JSON.stringify(schema, null, 2)`. */
export function settingsSchema(harness: ResolvedHarness): JsonSchema {
  const lead = harness.defaultAgent;
  const profiles = harness.profiles.map((profile) => profile.id);
  const profileHelp = harness.profiles.map((profile) => `${profile.id}: ${profile.description}`).join(" ");
  const reviewHelp = REVIEW_POLICIES.map((policy) => `${policy}: ${REVIEW_HELP[policy]}.`).join(" ");
  const agents: { [key: string]: JsonValue } = {};
  for (const agent of harness.agents) agents[agent.id] = agentSchema(agent, harness);

  return {
    $schema: SCHEMA_DIALECT,
    title: `${harness.name} settings`,
    description:
      `Settings for the ${harness.name} agents in opencode, in ${SETTINGS_FILE}. The file is read from ` +
      "the opencode config directory and then from a project's .opencode/ directory: project values " +
      "override global ones, and agents entries merge per agent. Leave a setting out to keep its default.",
    type: "object",
    additionalProperties: false,
    properties: {
      $schema: {
        title: "Schema",
        description: "Path or URL of this schema, so editors can check the file and suggest values.",
        type: "string",
      },
      review: {
        title: "Review policy",
        description: `When the reviewer checks plans and changes. Default: ${DEFAULT_REVIEW_POLICY}. ${reviewHelp}`,
        type: "string",
        enum: [...REVIEW_POLICIES],
        default: DEFAULT_REVIEW_POLICY,
      },
      profile: {
        title: "Model profile",
        description: `Which models the agents use. Default: ${harness.defaultProfile}. ${profileHelp}`,
        type: "string",
        enum: profiles,
        default: harness.defaultProfile,
      },
      default_agent: {
        title: `Start in ${lead}`,
        description:
          `Make ${lead} the agent opencode starts with. Default: true. Set false to keep opencode's own ` +
          `default agent; you can still switch to ${lead} with Tab.`,
        type: "boolean",
        default: true,
      },
      max_helper_slots: {
        title: "Helper slots",
        description: `The most helpers ${lead} may run at once. Default: ${DEFAULT_MAX_HELPER_SLOTS}. Whole number of at least 1. More slots can run more builds, dev servers and databases on the same machine.`,
        type: "integer",
        minimum: 1,
        default: DEFAULT_MAX_HELPER_SLOTS,
      },
      agents: {
        title: "Per-agent settings",
        description: "Helpers switched on or off, and model, reasoning effort and step limit for single agents, applied after the profile.",
        type: "object",
        additionalProperties: false,
        properties: agents,
      },
    },
  };
}
