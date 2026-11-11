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

  test("the site file of a central install comes first", () => {
    const env = { OPENCODE_CONFIG_DIR: "/site/opencode", XDG_CONFIG_HOME: "/xdg" };
    expect(settingsPaths({ env, home: "/home/u" }, "/repo", "/central/ecmwf-multi-agents.jsonc")).toEqual([
      "/central/ecmwf-multi-agents.jsonc",
      "/site/opencode/ecmwf-multi-agents.jsonc",
      "/xdg/opencode/ecmwf-multi-agents.jsonc",
      "/repo/.opencode/ecmwf-multi-agents.jsonc",
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

  test("max_helper_slots is a whole number of at least 1", () => {
    for (const max_helper_slots of [1, 4, 8, 100]) {
      expect(validateSettings({ max_helper_slots }, harness)).toEqual({ settings: { max_helper_slots }, problems: [] });
    }
    for (const max_helper_slots of [0, -1, 1.5, "4", null, true, [], {}, Infinity, NaN]) {
      expect(problemsOf({ max_helper_slots })).toHaveLength(1);
      expect(problemsOf({ max_helper_slots })[0]).toContain('"max_helper_slots" must be a whole number of at least 1');
    }
  });

  test("agents is an object keyed by known agents, each an object", () => {
    expect(problemsOf({ agents: [] })).toEqual(['"agents" must be an object that maps agent names to settings, not []']);
    expect(problemsOf({ agents: { build: {} } })).toEqual([
      '"agents" names "build", which is not one of the agents lead, scout, builder, reviewer and tester',
    ]);
    expect(problemsOf({ agents: { "scout-deep": {} } })).toEqual([
      '"agents" names "scout-deep", which is not one of the agents lead, scout, builder, reviewer and tester',
    ]);
    expect(problemsOf({ agents: { scout: "fast" } })).toEqual(['"agents.scout" must be an object with enabled, model, effort, fallback or steps, not "fast"']);
  });

  test("enabled switches a helper on or off; lead is always on", () => {
    expect(validateSettings({ agents: { tester: { enabled: true }, builder: { enabled: false, steps: 9 } } }, harness)).toEqual({
      settings: { agents: { tester: { enabled: true }, builder: { enabled: false, steps: 9 } } },
      problems: [],
    });
    for (const enabled of ["yes", 1, null, []]) {
      expect(problemsOf({ agents: { scout: { enabled } } })).toEqual([`"agents.scout.enabled" must be true or false, not ${JSON.stringify(enabled)}`]);
    }
    for (const enabled of [true, false]) {
      expect(problemsOf({ agents: { lead: { enabled } } })).toEqual(['"agents.lead.enabled" cannot be set: lead is always on']);
    }
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

  test("fallback is a list of provider/model texts or { model, effort } objects, checked into objects", () => {
    const value = { agents: { reviewer: { model: "openai/gpt-6.1-sol", fallback: ["acme/a", { model: "acme/b" }, { model: "acme/c", effort: "high" }] } } };
    expect(validateSettings(value, harness)).toEqual({
      settings: {
        agents: {
          reviewer: { model: "openai/gpt-6.1-sol", fallback: [{ model: "acme/a" }, { model: "acme/b" }, { model: "acme/c", effort: "high" }] },
        },
      },
      problems: [],
    });
  });

  test("an empty fallback list is valid and kept", () => {
    expect(validateSettings({ agents: { scout: { model: "acme/a", fallback: [] } } }, harness)).toEqual({
      settings: { agents: { scout: { model: "acme/a", fallback: [] } } },
      problems: [],
    });
  });

  test("fallback needs a model in the same entry, even when empty", () => {
    for (const fallback of [["acme/b"], []]) {
      expect(problemsOf({ agents: { scout: { fallback } } })).toEqual([
        '"agents.scout.fallback" needs a model in the same entry: the fallbacks are for that model',
      ]);
    }
    expect(problemsOf({ agents: { scout: { effort: "high", fallback: ["acme/b"] } } })).toHaveLength(1);
  });

  test("fallback entries are checked like model and effort", () => {
    const ask = (fallback: unknown) => problemsOf({ agents: { scout: { model: "acme/a", fallback } } });
    expect(ask("acme/b")).toEqual([
      '"agents.scout.fallback" must be a list of models, each provider/model or { "model": "provider/model", "effort": "high" }, not "acme/b"',
    ]);
    expect(ask({ model: "acme/b" })).toHaveLength(1);
    for (const model of ["claude", "acme/b#high", "acme/b c", "", 5]) {
      expect(ask([model])[0]).toBe(
        typeof model === "string"
          ? `"agents.scout.fallback[0]" must look like provider/model, without "#" or spaces, not ${JSON.stringify(model)}`
          : `"agents.scout.fallback[0]" must be provider/model or an object with model and effort, not ${JSON.stringify(model)}`,
      );
    }
    expect(ask([null, ["acme/b"]])).toHaveLength(2);
    expect(ask([{ model: "claude" }])).toEqual(['"agents.scout.fallback[0].model" must look like provider/model, without "#" or spaces, not "claude"']);
    expect(ask([{ effort: "high" }])).toEqual(['"agents.scout.fallback[0]" needs a "model", written as provider/model']);
    expect(ask([{}])).toEqual(['"agents.scout.fallback[0]" needs a "model", written as provider/model']);
    for (const effort of ["", "hi#gh", "very high", 3]) {
      expect(ask([{ model: "acme/b", effort }])).toEqual([
        `"agents.scout.fallback[0].effort" must be a non-empty name such as "high", without "#" or spaces, not ${JSON.stringify(effort)}`,
      ]);
    }
    expect(ask([{ model: "acme/b", steps: 2 }])).toEqual(['"agents.scout.fallback[0]" has the unknown setting "steps"; an entry takes model and effort']);
    expect(ask(["acme/ok", { model: "bad" }])[0]).toContain('"agents.scout.fallback[1].model"');
  });

  test("the old name variant is refused with a pointer to effort", () => {
    expect(problemsOf({ agents: { reviewer: { model: "openai/gpt-6.1-sol", variant: "high" } } })).toEqual([
      '"agents.reviewer" has the unknown key "variant"; it is now called "effort"',
    ]);
    expect(problemsOf({ variant: "high" })).toEqual(['unknown setting "variant"; the settings are $schema, review, profile, default_agent, max_helper_slots and agents']);
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
    expect(problemsOf({ reviews: "auto" })).toEqual(['unknown setting "reviews"; the settings are $schema, review, profile, default_agent, max_helper_slots and agents']);
    expect(problemsOf({ agents: { scout: { temperature: 0.2 } } })).toEqual([
      '"agents.scout" has the unknown setting "temperature"; an agent takes enabled, model, effort, fallback or steps',
    ]);
  });

  test("reports every problem in a file, not only the first", () => {
    expect(problemsOf({ review: "x", profile: "y", agents: { scout: { steps: 0, model: "m" } } })).toHaveLength(4);
  });
});

describe("mergeSettings", () => {
  test("defaults: review auto, the harness's default profile, lead as default agent", () => {
    expect(mergeSettings([], harness)).toEqual({ review: "auto", reviewSet: false, profile: "default", defaultAgent: true, maxHelperSlots: 4, maxHelperSlotsSet: false, agents: {} });
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
      maxHelperSlots: 4,
      maxHelperSlotsSet: false,
      agents: {
        // A model without a fallback list clears the list: [] means "cleared", undefined "not given".
        reviewer: { model: "openai/gpt-x", effort: "low", steps: 12, fallback: [] },
        scout: { steps: 5 },
        builder: { steps: 60 },
      },
    });
  });

  test("a later file's fallback list replaces an earlier one as a whole", () => {
    const merged = mergeSettings(
      [
        { agents: { scout: { model: "acme/a", fallback: [{ model: "acme/b" }, { model: "acme/c", effort: "high" }] } } },
        { agents: { scout: { model: "acme/a", fallback: [{ model: "acme/d" }] } } },
      ],
      harness,
    );
    expect(merged.agents.scout).toEqual({ model: "acme/a", fallback: [{ model: "acme/d" }] });
  });

  test("a model without a fallback list drops the lists of earlier files; [] stays []", () => {
    const earlier = { agents: { scout: { model: "acme/a", fallback: [{ model: "acme/b" }] } } };
    expect(mergeSettings([earlier, { agents: { scout: { model: "acme/z" } } }], harness).agents.scout).toEqual({ model: "acme/z", fallback: [] });
    expect(mergeSettings([earlier, { agents: { scout: { model: "acme/z", fallback: [] } } }], harness).agents.scout).toEqual({
      model: "acme/z",
      fallback: [],
    });
  });

  test("a file with no model keeps the fallback list: effort and steps do not clear it", () => {
    const merged = mergeSettings(
      [{ agents: { scout: { model: "acme/a", fallback: [{ model: "acme/b" }] } } }, { agents: { scout: { effort: "low", steps: 3 } } }, { agents: { builder: { steps: 4 } } }],
      harness,
    );
    expect(merged.agents.scout).toEqual({ model: "acme/a", fallback: [{ model: "acme/b" }], effort: "low", steps: 3 });
  });

  test("the fallback stays undefined for an agent that no file gives a model", () => {
    const merged = mergeSettings([{ agents: { scout: { steps: 5 }, builder: { effort: "low" } } }], harness);
    expect(merged.agents.scout).toEqual({ steps: 5 });
    expect(merged.agents.scout!.fallback).toBeUndefined();
    expect(merged.agents.builder!.fallback).toBeUndefined();
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
      maxHelperSlots: 4,
      maxHelperSlotsSet: false,
      agents: { scout: { steps: 7, effort: "low" }, reviewer: { steps: 9 } },
    });
    expect(loaded.sources).toEqual({
      review: project,
      profile: site,
      "agents.scout.steps": global,
      "agents.scout.effort": site,
      "agents.reviewer.steps": project,
    });
  });

  test("missing files are skipped silently", () => {
    const loaded = loadSettings(harness, fakeEnvironment({}, env), "/repo");
    expect(loaded).toEqual({ settings: mergeSettings([], harness), problems: [], applied: [], sources: {} });
  });

  test("helper slots follow site, global and project precedence, with the winning source", () => {
    const files = { [site]: '{ "max_helper_slots": 8 }', [global]: '{ "max_helper_slots": 6 }', [project]: '{ "max_helper_slots": 1 }' };
    const loaded = loadSettings(harness, fakeEnvironment(files, env), "/repo");
    expect(loaded.settings).toMatchObject({ maxHelperSlots: 1, maxHelperSlotsSet: true });
    expect(loaded.sources.max_helper_slots).toBe(project);
    const globalOnly = loadSettings(harness, fakeEnvironment(files, env), undefined);
    expect(globalOnly.settings.maxHelperSlots).toBe(6);
    expect(globalOnly.sources.max_helper_slots).toBe(global);
    const omitted = loadSettings(harness, fakeEnvironment({ ...files, [project]: '{ "review": "never" }' }, env), "/repo");
    expect(omitted.settings.maxHelperSlots).toBe(6);
  });

  test("enabled merges per helper and per field, and each switch names the file that set it", () => {
    const files = {
      [site]: '{ "agents": { "tester": { "enabled": true, "effort": "low" } } }',
      [global]: '{ "agents": { "builder": { "enabled": false } } }',
      [project]: '{ "agents": { "tester": { "steps": 9 }, "builder": { "enabled": true } } }',
    };
    const loaded = loadSettings(harness, fakeEnvironment(files, env), "/repo");
    expect(loaded.problems).toEqual([]);
    expect(loaded.settings.agents).toEqual({ tester: { enabled: true, effort: "low", steps: 9 }, builder: { enabled: true } });
    expect(loaded.sources).toMatchObject({ "agents.tester.enabled": site, "agents.builder.enabled": project, "agents.tester.steps": project });
    const globalOnly = loadSettings(harness, fakeEnvironment(files, env), undefined);
    expect(globalOnly.settings.agents.builder).toEqual({ enabled: false });
  });

  test("switching lead off ignores the whole file", () => {
    const loaded = loadSettings(harness, fakeEnvironment({ [global]: '{ "review": "never" }', [project]: '{ "review": "always", "agents": { "lead": { "enabled": false } } }' }, env), "/repo");
    expect(loaded.settings.review).toBe("never");
    expect(loaded.applied).toEqual([global]);
    expect(loaded.problems).toEqual([{ message: `ecmwf-multi-agents: ignoring ${project}: "agents.lead.enabled" cannot be set: lead is always on`, notify: true }]);
  });

  test("an invalid helper limit ignores the whole project file and keeps the global limit", () => {
    const loaded = loadSettings(harness, fakeEnvironment({
      [global]: '{ "max_helper_slots": 6, "review": "never" }',
      [project]: '{ "max_helper_slots": 0, "review": "always" }',
    }, env), "/repo");
    expect(loaded.settings).toMatchObject({ maxHelperSlots: 6, review: "never" });
    expect(loaded.sources.max_helper_slots).toBe(global);
    expect(loaded.applied).toEqual([global]);
    expect(loaded.problems).toEqual([{ message: `ecmwf-multi-agents: ignoring ${project}: "max_helper_slots" must be a whole number of at least 1, not 0`, notify: true }]);
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
