// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// JSON Schema (draft 2020-12) for the settings file ecmwf-multi-agents.jsonc, described in
// docs/architecture.md, "Settings". It is generated from the resolved harness, so profile and
// agent names stay current, and it shares the model and variant patterns with the plugin's own
// settings check (plugin/settings.ts), so an editor and the plugin accept the same files.

import { MODEL_PATTERN, SETTINGS_FILE, VARIANT_PATTERN } from "../plugin/settings.ts";
import { REVIEW_POLICIES } from "../plugin/types.ts";
import { DEFAULT_REVIEW_POLICY } from "./resolve.ts";
import type { ResolvedAgent, ResolvedHarness } from "./types.ts";
import { own } from "./util.ts";

export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = { [key: string]: JsonValue };

const REVIEW_HELP: Readonly<Record<(typeof REVIEW_POLICIES)[number], string>> = {
  auto: "plans are reviewed before you approve them, and changes beyond a trivial edit are reviewed",
  ask: "lead asks you each time",
  always: "every plan and every change is reviewed",
  never: "nothing is reviewed unless you ask with /review",
};

function agentSchema(agent: ResolvedAgent, harness: ResolvedHarness): JsonSchema {
  const profile = harness.profiles.find((candidate) => candidate.id === harness.defaultProfile);
  const example = profile === undefined ? undefined : own(profile.agents, agent.id)?.model;
  const steps = agent.steps === undefined ? "no limit" : String(agent.steps);
  return {
    title: agent.id,
    description: `${agent.description} Settings here override the profile for ${agent.id}.`,
    type: "object",
    additionalProperties: false,
    properties: {
      model: {
        title: "Model",
        description:
          `Model for ${agent.id}, written as provider/model` +
          `${example === undefined ? "" : `, for example ${example}`}. No "#" and no spaces. ` +
          "Leave it out to use the profile's choice.",
        type: "string",
        pattern: MODEL_PATTERN.source,
      },
      variant: {
        title: "Variant",
        description: 'Model variant, usually the reasoning effort, such as "high". No "#". Leave it out to use the profile\'s choice.',
        type: "string",
        minLength: 1,
        pattern: VARIANT_PATTERN.source,
      },
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
      agents: {
        title: "Per-agent settings",
        description: "Model, variant and step limit for single agents, applied after the profile.",
        type: "object",
        additionalProperties: false,
        properties: agents,
      },
    },
  };
}
