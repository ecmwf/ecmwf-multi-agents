// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { listWords, loadSettings, mergeSettings, settingsPaths, validateSettings } from "./settings.ts";
import { embeddedFixture, fakeEnvironment } from "./testing.ts";

const harness = embeddedFixture();

function problemsOf(value: unknown): string[] {
  const result = validateSettings(value, harness);
  expect(result.settings).toBeUndefined();
  return result.problems;
}

describe("settingsPaths", () => {
  test("site, then the user's global directory, then the project", () => {
    const env = { OPENCODE_CONFIG_DIR: "/site/opencode", XDG_CONFIG_HOME: "/xdg" };
    expect(settingsPaths({ env, home: "/home/u" }, "/repo")).toEqual([
      "/site/opencode/ecmwf-multi-agents.jsonc",
      "/xdg/opencode/ecmwf-multi-agents.jsonc",
      "/repo/.opencode/ecmwf-multi-agents.jsonc",
    ]);
  });

  test("falls back to ~/.config when XDG_CONFIG_HOME is unset or empty, and skips an unset site directory", () => {
    expect(settingsPaths({ env: {}, home: "/home/u" }, "/repo")).toEqual([
      "/home/u/.config/opencode/ecmwf-multi-agents.jsonc",
      "/repo/.opencode/ecmwf-multi-agents.jsonc",
    ]);
    expect(settingsPaths({ env: { XDG_CONFIG_HOME: "", OPENCODE_CONFIG_DIR: "" }, home: "/home/u" }, undefined)).toEqual([
      "/home/u/.config/opencode/ecmwf-multi-agents.jsonc",
    ]);
  });

  test("reads a file once when two locations are the same directory", () => {
    const env = { OPENCODE_CONFIG_DIR: "/home/u/.config/opencode/", XDG_CONFIG_HOME: "/home/u/.config" };
    expect(settingsPaths({ env, home: "/home/u" }, "/home/u/.config")).toEqual([
      "/home/u/.config/opencode/ecmwf-multi-agents.jsonc",
      "/home/u/.config/.opencode/ecmwf-multi-agents.jsonc",
    ]);
  });
});

describe("validateSettings", () => {
  test("accepts every documented setting", () => {
    const value = {
      $schema: "./ecmwf-multi-agents/schema.json",
      review: "ask",
      profile: "copilot",
      default_agent: false,
      agents: {
        reviewer: { model: "openai/gpt-6.1-sol", effort: "high", steps: 40 },
        scout: { steps: 9 },
        builder: { effort: "low" },
        lead: {},
      },
    };
    expect(validateSettings(value, harness)).toEqual({
      settings: {
        review: "ask",
        profile: "copilot",
        default_agent: false,
        agents: {
          reviewer: { model: "openai/gpt-6.1-sol", effort: "high", steps: 40 },
          scout: { steps: 9 },
          builder: { effort: "low" },
          lead: {},
        },
      },
      problems: [],
    });
    expect(validateSettings({}, harness)).toEqual({ settings: {}, problems: [] });
  });

  test("the file must hold an object", () => {
    for (const value of [[], "auto", 3, null, true]) {
      expect(problemsOf(value)).toEqual(['the file must hold one object in braces, such as { "review": "auto" }']);
    }
  });

  test("$schema must be text", () => {
    expect(problemsOf({ $schema: 1 })).toEqual(['"$schema" must be text, not 1']);
  });

  test("review is auto, ask, always or never", () => {
    for (const review of ["auto", "ask", "always", "never"] as const) expect(validateSettings({ review }, harness).settings).toEqual({ review });
    expect(problemsOf({ review: "sometimes" })).toEqual(['"review" must be auto, ask, always or never, not "sometimes"']);
    expect(problemsOf({ review: "Auto" })).toHaveLength(1);
    expect(problemsOf({ review: true })).toHaveLength(1);
  });

  test("profile is one of the embedded profiles", () => {
    expect(validateSettings({ profile: "inherit" }, harness).settings).toEqual({ profile: "inherit" });
    expect(problemsOf({ profile: "fast" })).toEqual(['"profile" must be anthropic, copilot, default or inherit, not "fast"']);
    expect(problemsOf({ profile: null })).toHaveLength(1);
  });

  test("default_agent is true or false", () => {
    expect(validateSettings({ default_agent: true }, harness).settings).toEqual({ default_agent: true });
    expect(problemsOf({ default_agent: "yes" })).toEqual(['"default_agent" must be true or false, not "yes"']);
    expect(problemsOf({ default_agent: 1 })).toHaveLength(1);
  });

  test("agents is an object keyed by known agents, each an object", () => {
    expect(problemsOf({ agents: [] })).toEqual(['"agents" must be an object that maps agent names to settings, not []']);
    expect(problemsOf({ agents: { build: {} } })).toEqual([
      '"agents" names "build", which is not one of the agents lead, scout, builder and reviewer',
    ]);
    expect(problemsOf({ agents: { "scout-deep": {} } })).toEqual([
      '"agents" names "scout-deep", which is not one of the agents lead, scout, builder and reviewer',
    ]);
    expect(problemsOf({ agents: { scout: "fast" } })).toEqual(['"agents.scout" must be an object with model, effort or steps, not "fast"']);
  });

  test("model is provider/model without '#' or spaces", () => {
    for (const model of ["anthropic/claude-opus-5-5", "github-copilot/claude-opus-5.5", "openrouter/anthropic/claude-x"]) {
      expect(validateSettings({ agents: { lead: { model } } }, harness).problems).toEqual([]);
    }
    for (const model of ["claude-opus-5-5", "/claude", "anthropic/", "anthropic/claude#high", "a#b/c", "anthropic/claude opus", "", 5]) {
      expect(problemsOf({ agents: { lead: { model } } })).toEqual([
        `"agents.lead.model" must look like provider/model, without "#" or spaces, not ${JSON.stringify(model)}`,
      ]);
    }
  });

  test("effort is a non-empty name without '#' or spaces", () => {
    for (const effort of ["none", "low", "medium", "high", "xhigh", "max", "thinking-32k"]) {
      expect(validateSettings({ agents: { lead: { effort } } }, harness).problems).toEqual([]);
    }
    for (const effort of ["", "hi#gh", "very high", 3]) {
      expect(problemsOf({ agents: { lead: { effort } } })).toEqual([
        `"agents.lead.effort" must be a non-empty name such as "high", without "#" or spaces, not ${JSON.stringify(effort)}`,
      ]);
    }
  });

  test("the old name variant is refused with a pointer to effort", () => {
    expect(problemsOf({ agents: { reviewer: { model: "openai/gpt-6.1-sol", variant: "high" } } })).toEqual([
      '"agents.reviewer" has the unknown key "variant"; it is now called "effort"',
    ]);
    expect(problemsOf({ variant: "high" })).toEqual(['unknown setting "variant"; the settings are $schema, review, profile, default_agent and agents']);
  });

  test("steps is a whole number of at least 1", () => {
    expect(validateSettings({ agents: { scout: { steps: 1 } } }, harness).problems).toEqual([]);
    for (const steps of [0, -3, 2.5, "9", null]) {
      expect(problemsOf({ agents: { scout: { steps } } })).toEqual([
        `"agents.scout.steps" must be a whole number of at least 1, not ${JSON.stringify(steps)}`,
      ]);
    }
  });

  test("no other keys, at the top or in an agent", () => {
    expect(problemsOf({ reviews: "auto" })).toEqual(['unknown setting "reviews"; the settings are $schema, review, profile, default_agent and agents']);
    expect(problemsOf({ agents: { scout: { temperature: 0.2 } } })).toEqual([
      '"agents.scout" has the unknown setting "temperature"; an agent takes model, effort or steps',
    ]);
  });

  test("reports every problem in a file, not only the first", () => {
    expect(problemsOf({ review: "x", profile: "y", agents: { scout: { steps: 0, model: "m" } } })).toHaveLength(4);
  });
});

describe("mergeSettings", () => {
  test("defaults: review auto, the harness's default profile, lead as default agent", () => {
    expect(mergeSettings([], harness)).toEqual({ review: "auto", reviewSet: false, profile: "default", defaultAgent: true, agents: {} });
  });

  test("later files win; agents merge per agent and per field", () => {
    const merged = mergeSettings(
      [
        { review: "never", profile: "copilot", agents: { reviewer: { model: "openai/gpt-x", effort: "high" }, scout: { steps: 5 } } },
        { review: "always", default_agent: false, agents: { reviewer: { effort: "low" } } },
        { profile: "anthropic", agents: { reviewer: { steps: 12 }, builder: { steps: 60 } } },
      ],
      harness,
    );
    expect(merged).toEqual({
      review: "always",
      reviewSet: true,
      profile: "anthropic",
      defaultAgent: false,
      agents: {
        reviewer: { model: "openai/gpt-x", effort: "low", steps: 12 },
        scout: { steps: 5 },
        builder: { steps: 60 },
      },
    });
  });
});

describe("loadSettings", () => {
  const env = { OPENCODE_CONFIG_DIR: "/site", XDG_CONFIG_HOME: "/xdg" };
  const site = "/site/ecmwf-multi-agents.jsonc";
  const global = "/xdg/opencode/ecmwf-multi-agents.jsonc";
  const project = "/repo/.opencode/ecmwf-multi-agents.jsonc";

  test("applies site, global and project files in that order", () => {
    const files = {
      [site]: '{ "review": "never", "profile": "copilot", "agents": { "scout": { "steps": 3, "effort": "low" } } }',
      [global]: '// mine\n{ "review": "ask", "agents": { "scout": { "steps": 7 } }, }',
      [project]: '{ "review": "always", "agents": { "reviewer": { "steps": 9 } } }',
    };
    const loaded = loadSettings(harness, fakeEnvironment(files, env), "/repo");
    expect(loaded.problems).toEqual([]);
    expect(loaded.applied).toEqual([site, global, project]);
    expect(loaded.settings).toEqual({
      review: "always",
      reviewSet: true,
      profile: "copilot",
      defaultAgent: true,
      agents: { scout: { steps: 7, effort: "low" }, reviewer: { steps: 9 } },
    });
  });

  test("missing files are skipped silently", () => {
    const loaded = loadSettings(harness, fakeEnvironment({}, env), "/repo");
    expect(loaded).toEqual({ settings: mergeSettings([], harness), problems: [], applied: [] });
  });

  test("an invalid file is ignored entirely and reported with its path; the others still apply", () => {
    const files = {
      [global]: '{ "profile": "anthropic", "review": "never" }',
      [project]: '{ "review": "always", "agents": { "scout": { "steps": 0 } } }',
    };
    const loaded = loadSettings(harness, fakeEnvironment(files, env), "/repo");
    expect(loaded.applied).toEqual([global]);
    expect(loaded.settings.review).toBe("never");
    expect(loaded.settings.profile).toBe("anthropic");
    expect(loaded.settings.agents).toEqual({});
    expect(loaded.problems).toEqual([
      {
        message: `ecmwf-multi-agents: ignoring ${project}: "agents.scout.steps" must be a whole number of at least 1, not 0`,
        notify: true,
      },
    ]);
  });

  test("a syntax error is reported with its line and column", () => {
    const loaded = loadSettings(harness, fakeEnvironment({ [global]: '{\n  "review": "always"\n  "profile": "x"\n}' }, env), "/repo");
    expect(loaded.settings.review).toBe("auto");
    expect(loaded.problems[0]?.message).toBe(
      `ecmwf-multi-agents: ignoring ${global}: line 3, column 3: expected "," or "}" after a value, found "\\""`,
    );
  });

  test("a file that cannot be read is reported and ignored", () => {
    const environment = fakeEnvironment({}, env);
    environment.readFile = (file) => {
      if (file === global) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return undefined;
    };
    const loaded = loadSettings(harness, environment, "/repo");
    expect(loaded.problems).toEqual([{ message: `ecmwf-multi-agents: ignoring ${global}: it could not be read (EACCES)`, notify: true }]);
  });
});

test("listWords joins with commas and a last word", () => {
  expect(listWords(["a"])).toBe("a");
  expect(listWords(["a", "b"])).toBe("a or b");
  expect(listWords(["a", "b", "c"], "and")).toBe("a, b and c");
});
