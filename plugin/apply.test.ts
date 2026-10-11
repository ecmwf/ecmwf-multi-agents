// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { applyToV1Config, applyToV2Agents, planAgents, rewriteReviewLine } from "./apply.ts";
import { mergeSettings } from "./settings.ts";
import { LEAD_PROMPT, embeddedFixture, resolvedFixture } from "./testing.ts";
import type { Settings, SettingsFile, V1Config, V2AgentEditor, V2AgentInfo } from "./types.ts";

const harness = embeddedFixture();

function settingsOf(...files: SettingsFile[]): Settings {
  return mergeSettings(files, harness);
}

/** The config opencode 1.x hands to the `config` hook for the emitted agent files. */
function v1Config(): V1Config {
  const agent: NonNullable<V1Config["agent"]> = {
    build: { model: "other/model", steps: 3 },
  };
  for (const item of resolvedFixture().agents) {
    agent[item.id] = {
      name: item.id,
      description: item.description,
      mode: item.mode,
      ...(item.model !== undefined ? { model: item.model } : {}),
      ...(item.variant !== undefined ? { variant: item.variant } : {}),
      ...(item.steps !== undefined ? { steps: item.steps } : {}),
      permission: {},
      prompt: item.prompt,
    };
  }
  return { agent };
}

/** A fake opencode 2.0.16 agent editor holding the emitted agents and two built-ins. */
function v2Editor(): V2AgentEditor & { agents: Map<string, V2AgentInfo>; selected?: string } {
  const agents = new Map<string, V2AgentInfo>();
  agents.set("build", { id: "build", mode: "primary", hidden: false, model: { id: "m", providerID: "p" } });
  for (const item of resolvedFixture().agents) {
    const [providerID, ...rest] = (item.model ?? "").split("/");
    agents.set(item.id, {
      id: item.id,
      mode: item.mode,
      hidden: false,
      system: item.prompt,
      ...(item.steps !== undefined ? { steps: item.steps } : {}),
      ...(item.model !== undefined ? { model: { id: rest.join("/"), providerID: providerID!, ...(item.variant ? { variant: item.variant } : {}) } } : {}),
    });
  }
  const editor = {
    agents,
    selected: undefined as string | undefined,
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    default(id: string | undefined) {
      editor.selected = id;
    },
    update(id: string, update: (agent: V2AgentInfo) => void) {
      const agent = agents.get(id) ?? { id, mode: "primary", hidden: false };
      agents.set(id, agent);
      update(agent);
    },
  };
  return editor;
}

describe("planAgents", () => {
  test("the default profile gives each agent its model and variant; steps stay unless overridden", () => {
    const { plans, problems } = planAgents(harness, settingsOf());
    expect(problems).toEqual([]);
    expect(plans).toEqual([
      { id: "lead", model: "anthropic/claude-opus-5-5", variant: "xhigh" },
      { id: "scout", model: "anthropic/claude-sonnet-5-5", variant: "medium" },
      { id: "scout-deep", model: "anthropic/claude-sonnet-5-5", variant: "high" },
      { id: "builder", model: "anthropic/claude-sonnet-5-5", variant: "high" },
      { id: "builder-deep", model: "anthropic/claude-opus-5-5", variant: "high" },
      { id: "reviewer", model: "github-copilot/gpt-6.1-sol", variant: "medium" },
    ]);
  });

  test("inherit leaves every agent without a model", () => {
    const { plans } = planAgents(harness, settingsOf({ profile: "inherit" }));
    expect(plans.every((plan) => plan.model === undefined && plan.variant === undefined)).toBe(true);
  });

  test("an override model replaces the profile's model and variant together", () => {
    const { plans } = planAgents(harness, settingsOf({ agents: { reviewer: { model: "openai/gpt-x" }, scout: { model: "openai/gpt-y", variant: "low" } } }));
    expect(plans.find((plan) => plan.id === "reviewer")).toEqual({ id: "reviewer", model: "openai/gpt-x" });
    expect(plans.find((plan) => plan.id === "scout")).toEqual({ id: "scout", model: "openai/gpt-y", variant: "low" });
  });

  test("an override variant alone applies to the profile's model", () => {
    const { plans } = planAgents(harness, settingsOf({ agents: { reviewer: { variant: "high" } } }));
    expect(plans.find((plan) => plan.id === "reviewer")).toEqual({ id: "reviewer", model: "github-copilot/gpt-6.1-sol", variant: "high" });
  });

  test("an override variant without any model is reported and ignored", () => {
    const { plans, problems } = planAgents(harness, settingsOf({ profile: "inherit", agents: { scout: { variant: "high", steps: 9 } } }));
    expect(plans.find((plan) => plan.id === "scout")).toEqual({ id: "scout", steps: 9 });
    expect(problems).toEqual([
      {
        message:
          'ecmwf-multi-agents: the variant "high" for scout was ignored: profile "inherit" gives scout no model and the settings name none, so it uses the session model',
        notify: true,
      },
    ]);
  });

  test("inherit with an override model sets just that agent", () => {
    const { plans } = planAgents(harness, settingsOf({ profile: "inherit", agents: { reviewer: { model: "openai/gpt-x", variant: "high", steps: 40 } } }));
    expect(plans.find((plan) => plan.id === "reviewer")).toEqual({ id: "reviewer", model: "openai/gpt-x", variant: "high", steps: 40 });
    expect(plans.find((plan) => plan.id === "lead")).toEqual({ id: "lead" });
  });
});

describe("rewriteReviewLine", () => {
  test("changes the value of the one line", () => {
    expect(rewriteReviewLine(LEAD_PROMPT, "always", "lead").prompt).toBe(LEAD_PROMPT.replace("Review policy: auto", "Review policy: always"));
    expect(rewriteReviewLine("a\nReview policy: never\nb", "auto", "lead").prompt).toBe("a\nReview policy: auto\nb");
  });

  test("keeps a prompt that already says the setting", () => {
    expect(rewriteReviewLine(LEAD_PROMPT, "auto", "lead").prompt).toBe(LEAD_PROMPT);
  });

  test("keeps a CRLF line ending", () => {
    expect(rewriteReviewLine("a\r\nReview policy: auto\r\nb", "never", "lead").prompt).toBe("a\r\nReview policy: never\r\nb");
  });

  test("reports a missing line and changes nothing", () => {
    expect(rewriteReviewLine("You are lead.\nThe review policy: auto", "always", "lead")).toEqual({
      problem: 'the prompt of lead has no "Review policy:" line, so the review policy stays as the prompt says',
    });
  });

  test("reports several lines and changes nothing", () => {
    expect(rewriteReviewLine("Review policy: auto\nReview policy: ask", "never", "lead").problem).toBe(
      'the prompt of lead has 2 "Review policy:" lines instead of one, so none was changed',
    );
  });
});

describe("applyToV1Config", () => {
  test("default settings keep the baked values, set the review line and make lead the default agent", () => {
    const config = v1Config();
    const before = structuredClone(config);
    const problems = applyToV1Config(config, harness, settingsOf(), planAgents(harness, settingsOf()).plans);
    expect(problems).toEqual([]);
    expect(config.default_agent).toBe("lead");
    delete config.default_agent;
    expect(config).toEqual(before);
  });

  test("a profile and overrides set model, variant, steps and the review line on our agents only", () => {
    const config = v1Config();
    const settings = settingsOf({ profile: "anthropic", review: "always", agents: { scout: { steps: 9 }, builder: { model: "openai/gpt-x" } } });
    applyToV1Config(config, harness, settings, planAgents(harness, settings).plans);
    const agent = config.agent!;
    expect(agent.reviewer).toMatchObject({ model: "anthropic/claude-opus-5-5", variant: "high", steps: 30 });
    expect(agent.scout).toMatchObject({ model: "anthropic/claude-sonnet-5-5", variant: "medium", steps: 9 });
    expect(agent.builder!.model).toBe("openai/gpt-x");
    expect("variant" in agent.builder!).toBe(false);
    expect(agent.lead!.prompt).toContain("\nReview policy: always\n");
    expect(agent.build).toEqual({ model: "other/model", steps: 3 });
  });

  test("inherit removes model and variant so agents use the session model", () => {
    const config = v1Config();
    const settings = settingsOf({ profile: "inherit" });
    applyToV1Config(config, harness, settings, planAgents(harness, settings).plans);
    for (const id of ["lead", "scout", "reviewer"]) {
      expect("model" in config.agent![id]!).toBe(false);
      expect("variant" in config.agent![id]!).toBe(false);
    }
    expect(config.agent!.scout!.steps).toBe(15);
  });

  test("agents missing from the config are left alone", () => {
    const config: V1Config = { agent: { lead: { mode: "primary", prompt: LEAD_PROMPT } } };
    applyToV1Config(config, harness, settingsOf({ agents: { scout: { steps: 2 } } }), planAgents(harness, settingsOf()).plans);
    expect(Object.keys(config.agent!)).toEqual(["lead"]);
  });

  test("a missing review line is reported; a toast only when the user set a policy", () => {
    const config = v1Config();
    config.agent!.lead!.prompt = "My own lead prompt.";
    expect(applyToV1Config(config, harness, settingsOf(), [])).toEqual([
      {
        message: 'ecmwf-multi-agents: the prompt of lead has no "Review policy:" line, so the review policy stays as the prompt says',
        notify: false,
      },
    ]);
    expect(config.agent!.lead!.prompt).toBe("My own lead prompt.");
    expect(applyToV1Config(config, harness, settingsOf({ review: "never" }), [])[0]?.notify).toBe(true);
  });

  test("default agent: kept when a config names one, skipped when settings say no", () => {
    const named = v1Config();
    named.default_agent = "plan";
    applyToV1Config(named, harness, settingsOf(), []);
    expect(named.default_agent).toBe("plan");

    const declined = v1Config();
    applyToV1Config(declined, harness, settingsOf({ default_agent: false }), []);
    expect(declined.default_agent).toBeUndefined();
  });

  test("default agent: never set to a lead that opencode would reject", () => {
    for (const lead of [undefined, { disable: true }, { mode: "subagent" }, { hidden: true }]) {
      const config = v1Config();
      if (lead === undefined) delete config.agent!.lead;
      else Object.assign(config.agent!.lead!, lead);
      applyToV1Config(config, harness, settingsOf(), []);
      expect(config.default_agent).toBeUndefined();
    }
    const noAgents: V1Config = {};
    expect(applyToV1Config(noAgents, harness, settingsOf(), [])).toEqual([]);
    expect(noAgents).toEqual({});
  });
});

describe("applyToV2Agents", () => {
  test("default settings keep the baked values", () => {
    const editor = v2Editor();
    const before = structuredClone([...editor.agents.values()]);
    expect(applyToV2Agents(editor, harness, settingsOf(), planAgents(harness, settingsOf()).plans)).toEqual([]);
    expect([...editor.agents.values()]).toEqual(before);
  });

  test("a profile and overrides set model {id, providerID, variant}, steps and system", () => {
    const editor = v2Editor();
    const settings = settingsOf({ profile: "anthropic", review: "always", agents: { scout: { steps: 9 }, builder: { model: "openrouter/anthropic/claude-x" } } });
    applyToV2Agents(editor, harness, settings, planAgents(harness, settings).plans);
    expect(editor.get("reviewer")).toMatchObject({ model: { id: "claude-opus-5-5", providerID: "anthropic", variant: "high" }, steps: 30 });
    expect(editor.get("scout")).toMatchObject({ model: { id: "claude-sonnet-5-5", providerID: "anthropic", variant: "medium" }, steps: 9 });
    expect(editor.get("builder")!.model).toEqual({ id: "anthropic/claude-x", providerID: "openrouter" });
    expect(editor.get("lead")!.system).toContain("\nReview policy: always\n");
    expect(editor.get("build")!.model).toEqual({ id: "m", providerID: "p" });
  });

  test("inherit deletes the model", () => {
    const editor = v2Editor();
    const settings = settingsOf({ profile: "inherit" });
    applyToV2Agents(editor, harness, settings, planAgents(harness, settings).plans);
    for (const id of ["lead", "scout", "scout-deep", "builder", "builder-deep", "reviewer"]) expect("model" in editor.get(id)!).toBe(false);
  });

  test("never creates an agent that is not there", () => {
    const editor = v2Editor();
    editor.agents.delete("scout");
    applyToV2Agents(editor, harness, settingsOf({ agents: { scout: { steps: 4 } } }), planAgents(harness, settingsOf({ agents: { scout: { steps: 4 } } })).plans);
    expect(editor.agents.has("scout")).toBe(false);
  });

  test("a missing review line is reported and the system prompt kept", () => {
    const editor = v2Editor();
    editor.get("lead")!.system = "Custom.";
    const problems = applyToV2Agents(editor, harness, settingsOf({ review: "ask" }), []);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.notify).toBe(true);
    expect(editor.get("lead")!.system).toBe("Custom.");
  });
});
