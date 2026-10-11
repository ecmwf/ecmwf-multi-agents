// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { EFFORT_PATTERN, MODEL_PATTERN, validateSettings } from "../plugin/settings.ts";
import { embedHarness } from "./bundle-plugin.ts";
import { type JsonSchema, type JsonValue, SCHEMA_DIALECT, settingsSchema } from "./schema.ts";
import type { ResolvedHarness } from "./types.ts";

const harness: ResolvedHarness = {
  name: "test-harness",
  version: "1.0.0",
  defaultAgent: "lead",
  defaultProfile: "default",
  workDir: ".work",
  marker: "# managed by test",
  agents: [
    {
      id: "lead",
      mode: "primary",
      description: "Leads.",
      prompt: "You are lead.\n\nReview policy: auto",
      permissions: [],
      model: "acme/big",
      variant: "high",
    },
    { id: "scout", mode: "subagent", description: "Looks.", prompt: "You are scout.", steps: 15, permissions: [] },
  ],
  commands: [],
  skills: [],
  profiles: [
    { id: "default", description: "Acme models.", agents: { lead: { model: "acme/big", effort: "high" } } },
    { id: "inherit", description: "The session model everywhere.", agents: {} },
  ],
};

const schema = settingsSchema(harness);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sub(schema: JsonSchema, ...keys: string[]): JsonSchema {
  let current: unknown = schema;
  for (const key of keys) {
    if (!isObject(current) || !Object.hasOwn(current, key)) throw new Error(`schema has no ${keys.join(".")}`);
    current = current[key];
  }
  if (!isObject(current)) throw new Error(`${keys.join(".")} is not a schema`);
  return current as JsonSchema;
}

function hasType(type: JsonValue | undefined, value: unknown): boolean {
  switch (type) {
    case undefined:
      return true;
    case "object":
      return isObject(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      throw new Error(`the test validator does not know type ${JSON.stringify(type)}`);
  }
}

const KNOWN = new Set(["$schema", "title", "description", "type", "enum", "default", "pattern", "minLength", "minimum", "properties", "additionalProperties"]);

/** A small validator for the keywords the settings schema uses; returns the failing paths. */
function validate(schema: JsonSchema, value: unknown, at = "$"): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN.has(keyword)) throw new Error(`the test validator does not know keyword ${keyword}`);
  }
  if (!hasType(schema.type, value)) return [`${at}: type`];
  const errors: string[] = [];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as JsonValue)) errors.push(`${at}: enum`);
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) errors.push(`${at}: minLength`);
    // JSON Schema patterns are ECMA-262 regular expressions in unicode mode.
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${at}: pattern`);
  }
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at}: minimum`);
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
    for (const [key, item] of Object.entries(value)) {
      const child = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (child !== undefined) errors.push(...validate(child, item, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: additionalProperties`);
    }
  }
  return errors;
}

const GOOD: unknown[] = [
  {},
  { $schema: "./ecmwf-multi-agents/schema.json" },
  { review: "never", profile: "inherit", default_agent: false },
  { review: "ask" },
  { agents: { scout: { model: "openai/gpt-6.1-sol", effort: "high", steps: 20 } } },
  // An override may change only the effort, keeping the profile's model.
  { agents: { lead: { effort: "low" } } },
  { agents: { lead: { effort: "none" } } },
  { agents: { scout: { model: "My-Proxy/qwen:27b" } } },
  { agents: {} },
];

const BAD: [unknown, string][] = [
  [{ reviews: "auto" }, "$.reviews: additionalProperties"],
  [{ review: "sometimes" }, "$.review: enum"],
  [{ review: 1 }, "$.review: type"],
  [{ profile: "fast" }, "$.profile: enum"],
  [{ default_agent: "yes" }, "$.default_agent: type"],
  [{ agents: [] }, "$.agents: type"],
  [{ agents: { boss: {} } }, "$.agents.boss: additionalProperties"],
  [{ agents: { scout: "fast" } }, "$.agents.scout: type"],
  [{ agents: { scout: { temperature: 0.2 } } }, "$.agents.scout.temperature: additionalProperties"],
  [{ agents: { scout: { model: "gpt" } } }, "$.agents.scout.model: pattern"],
  [{ agents: { scout: { model: "acme/big#high" } } }, "$.agents.scout.model: pattern"],
  [{ agents: { scout: { model: "acme/big model" } } }, "$.agents.scout.model: pattern"],
  [{ agents: { scout: { effort: "" } } }, "$.agents.scout.effort: minLength"],
  [{ agents: { scout: { effort: "hi#gh" } } }, "$.agents.scout.effort: pattern"],
  [{ agents: { scout: { effort: "very high" } } }, "$.agents.scout.effort: pattern"],
  [{ agents: { scout: { effort: 2 } } }, "$.agents.scout.effort: type"],
  // The old name of effort.
  [{ agents: { lead: { model: "acme/big", variant: "high" } } }, "$.agents.lead.variant: additionalProperties"],
  [{ agents: { scout: { steps: 0 } } }, "$.agents.scout.steps: minimum"],
  [{ agents: { scout: { steps: 1.5 } } }, "$.agents.scout.steps: type"],
  [[], "$: type"],
  ["auto", "$: type"],
];

describe("settings schema", () => {
  test("accepts good settings", () => {
    for (const value of GOOD) expect(validate(schema, value)).toEqual([]);
  });

  test("rejects bad settings at the right path", () => {
    for (const [value, error] of BAD) expect(validate(schema, value)).toContain(error);
  });

  test("agrees with the plugin's own settings check", () => {
    const embedded = embedHarness(harness);
    for (const value of [...GOOD, ...BAD.map(([value]) => value)]) {
      const schemaAccepts = validate(schema, value).length === 0;
      const pluginAccepts = validateSettings(value, embedded).problems.length === 0;
      expect({ value, accepted: schemaAccepts }).toEqual({ value, accepted: pluginAccepts });
    }
  });

  test("uses the plugin's model and effort patterns", () => {
    const model = sub(schema, "properties", "agents", "properties", "scout", "properties", "model");
    const effort = sub(schema, "properties", "agents", "properties", "lead", "properties", "effort");
    expect(model.pattern).toBe(MODEL_PATTERN.source);
    expect(effort.pattern).toBe(EFFORT_PATTERN.source);
  });

  test("is draft 2020-12 and closed at every level", () => {
    expect(schema.$schema).toBe(SCHEMA_DIALECT);
    expect(SCHEMA_DIALECT).toBe("https://json-schema.org/draft/2020-12/schema");
    const objects: string[] = [];
    const walk = (node: JsonSchema, at: string) => {
      if (node.type === "object") {
        objects.push(at);
        expect({ at, additionalProperties: node.additionalProperties }).toEqual({ at, additionalProperties: false });
      }
      if (isObject(node.properties)) {
        for (const [key, child] of Object.entries(node.properties)) walk(child as JsonSchema, `${at}.${key}`);
      }
    };
    walk(schema, "$");
    expect(objects).toEqual(["$", "$.agents", "$.agents.lead", "$.agents.scout"]);
  });

  test("lists the settings, policies, profiles and agents", () => {
    expect(Object.keys(sub(schema, "properties"))).toEqual(["$schema", "review", "profile", "default_agent", "agents"]);
    expect(sub(schema, "properties", "$schema").type).toBe("string");
    expect(sub(schema, "properties", "review").enum).toEqual(["auto", "ask", "always", "never"]);
    expect(sub(schema, "properties", "profile").enum).toEqual(["default", "inherit"]);
    expect(sub(schema, "properties", "default_agent").type).toBe("boolean");
    expect(Object.keys(sub(schema, "properties", "agents", "properties"))).toEqual(["lead", "scout"]);
    expect(Object.keys(sub(schema, "properties", "agents", "properties", "scout", "properties"))).toEqual([
      "model",
      "effort",
      "steps",
    ]);
    expect(sub(schema, "properties", "agents", "properties", "scout", "properties", "steps")).toMatchObject({
      type: "integer",
      minimum: 1,
    });
  });

  test("states the defaults and helps in an editor", () => {
    const properties = sub(schema, "properties");
    expect(sub(properties, "review").default).toBe("auto");
    expect(sub(properties, "profile").default).toBe("default");
    expect(sub(properties, "default_agent").default).toBe(true);
    expect(String(sub(properties, "review").description)).toContain("Default: auto.");
    expect(String(sub(properties, "profile").description)).toContain("Default: default.");
    expect(String(sub(properties, "profile").description)).toContain("inherit: The session model everywhere.");
    expect(String(sub(properties, "default_agent").description)).toContain("Default: true.");
    const scout = sub(properties, "agents", "properties", "scout");
    expect(String(sub(scout, "properties", "steps").description)).toContain("Default: 15.");
    expect(String(sub(properties, "agents", "properties", "lead", "properties", "model").description)).toContain(
      "for example acme/big",
    );
    const effort = (agent: string) => String(sub(properties, "agents", "properties", agent, "properties", "effort").description);
    expect(effort("lead")).toBe(
      "Reasoning effort for the model of lead. Common values: low, medium, high, xhigh and max; some models also take none. " +
        "Default: high, from the default profile. It applies only when lead has a model, from the profile or from this entry, " +
        'so it has no effect under the inherit profile unless this entry also names a model. No "#" and no spaces. ' +
        "Leave it out to use the profile's choice.",
    );
    expect(effort("scout")).not.toContain("Default:");
    expect(effort("scout")).toContain("so it has no effect under the default or inherit profiles unless this entry also names a model.");
    const described = (node: JsonSchema, at: string) => {
      expect({ at, title: typeof node.title, description: typeof node.description }).toEqual({
        at,
        title: "string",
        description: "string",
      });
      if (isObject(node.properties)) {
        for (const [key, child] of Object.entries(node.properties)) described(child as JsonSchema, `${at}.${key}`);
      }
    };
    described(schema, "$");
  });

  test("is plain JSON and the same for the same input", () => {
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    expect(JSON.stringify(settingsSchema(harness))).toBe(JSON.stringify(schema));
  });
});
