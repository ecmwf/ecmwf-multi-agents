// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { applyToV2Agents, planAgents, rewriteReviewLine } from "./apply.ts";
import { mergeSettings } from "./settings.ts";
import { LEAD_PROMPT, embeddedFixture, resolvedFixture } from "./testing.ts";
import type { Settings, SettingsFile, V2AgentEditor, V2AgentInfo } from "./types.ts";

const harness = embeddedFixture();

function settingsOf(...files: SettingsFile[]): Settings {
  return mergeSettings(files, harness);
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
  test("the default profile gives each agent its model and effort; steps stay unless overridden", () => {
    const { plans, problems } = planAgents(harness, settingsOf());
    expect(problems).toEqual([]);
    expect(plans).toEqual([
      { id: "lead", model: "anthropic/claude-opus-5-5", effort: "xhigh" },
      { id: "scout", model: "anthropic/claude-sonnet-5-5", effort: "medium" },
      { id: "builder", model: "anthropic/claude-sonnet-5-5", effort: "high" },
      { id: "reviewer", model: "github-copilot/gpt-6.1-sol", effort: "medium" },
    ]);
  });

  test("inherit leaves every agent without a model", () => {
    const { plans } = planAgents(harness, settingsOf({ profile: "inherit" }));
    expect(plans.every((plan) => plan.model === undefined && plan.effort === undefined)).toBe(true);
  });

  test("an override model replaces the profile's model and effort together", () => {
    const { plans } = planAgents(harness, settingsOf({ agents: { reviewer: { model: "openai/gpt-x" }, scout: { model: "openai/gpt-y", effort: "low" } } }));
    expect(plans.find((plan) => plan.id === "reviewer")).toEqual({ id: "reviewer", model: "openai/gpt-x" });
    expect(plans.find((plan) => plan.id === "scout")).toEqual({ id: "scout", model: "openai/gpt-y", effort: "low" });
  });

  test("an override effort alone applies to the profile's model", () => {
    const { plans } = planAgents(harness, settingsOf({ agents: { builder: { effort: "xhigh" }, reviewer: { effort: "high" } } }));
    expect(plans.find((plan) => plan.id === "builder")).toEqual({ id: "builder", model: "anthropic/claude-sonnet-5-5", effort: "xhigh" });
    expect(plans.find((plan) => plan.id === "reviewer")).toEqual({ id: "reviewer", model: "github-copilot/gpt-6.1-sol", effort: "high" });
  });

  test("an override effort without any model is reported and ignored", () => {
    const { plans, problems } = planAgents(harness, settingsOf({ profile: "inherit", agents: { scout: { effort: "high", steps: 9 } } }));
    expect(plans.find((plan) => plan.id === "scout")).toEqual({ id: "scout", steps: 9 });
    expect(problems).toEqual([
      {
        message:
          'ecmwf-multi-agents: the effort "high" for scout was ignored: profile "inherit" gives scout no model and the settings name none, so it uses the session model',
        notify: true,
      },
    ]);
  });

  test("inherit with an override model sets just that agent", () => {
    const { plans } = planAgents(harness, settingsOf({ profile: "inherit", agents: { reviewer: { model: "openai/gpt-x", effort: "high", steps: 40 } } }));
    expect(plans.find((plan) => plan.id === "reviewer")).toEqual({ id: "reviewer", model: "openai/gpt-x", effort: "high", steps: 40 });
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

  test("an effort override is written as model.variant", () => {
    const editor = v2Editor();
    const settings = settingsOf({ agents: { builder: { effort: "xhigh" } } });
    applyToV2Agents(editor, harness, settings, planAgents(harness, settings).plans);
    expect(editor.get("builder")!.model).toEqual({ id: "claude-sonnet-5-5", providerID: "anthropic", variant: "xhigh" });
  });

  test("inherit deletes the model", () => {
    const editor = v2Editor();
    const settings = settingsOf({ profile: "inherit" });
    applyToV2Agents(editor, harness, settings, planAgents(harness, settings).plans);
    for (const id of ["lead", "scout", "builder", "reviewer"]) expect("model" in editor.get(id)!).toBe(false);
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
