// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { applyToV2Agents, helperSlotsLine, planAgents, rewriteHelperSlotsLine, rewriteReviewLine } from "./apply.ts";
import { mergeSettings } from "./settings.ts";
import { HELPER_OFF, LEAD_PROMPT, REVIEW_MEANINGS, TESTER_ROUTING, embeddedFixture, resolvedFixture } from "./testing.ts";
import { REVIEW_POLICIES } from "./types.ts";
import type { Settings, SettingsFile, V2AgentEditor, V2AgentInfo } from "./types.ts";

const harness = embeddedFixture();

function settingsOf(...files: SettingsFile[]): Settings {
  return mergeSettings(files, harness);
}

/**
 * A fake opencode 2 agent editor holding a built-in and the agents a default install loads: every
 * agent but the optional ones, which only the plugin registers, when they are on.
 */
function v2Editor(): V2AgentEditor & { agents: Map<string, V2AgentInfo>; selected?: string } {
  const agents = new Map<string, V2AgentInfo>();
  agents.set("build", { id: "build", mode: "primary", hidden: false, model: { id: "m", providerID: "p" } });
  for (const item of resolvedFixture().agents.filter((agent) => agent.optional !== true)) {
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
    remove(id: string) {
      agents.delete(id);
    },
  };
  return editor;
}

/** The editor after the plugin registered an optional helper that is on. */
function withTester(editor: ReturnType<typeof v2Editor>): ReturnType<typeof v2Editor> {
  editor.update("tester", (agent) => Object.assign(agent, { mode: "subagent", system: "You are tester.", steps: 60, model: { id: "gpt-6.1-sol", providerID: "github-copilot", variant: "high" } }));
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
      { id: "tester", model: "github-copilot/gpt-6.1-sol", effort: "high" },
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

  describe("fallback models", () => {
    const withFallback = structuredClone(harness);
    const profile = withFallback.profiles.find((item) => item.id === "default")!;
    profile.agents.scout!.fallback = [{ model: "openai/gpt-a", effort: "low" }, { model: "openai/gpt-b" }];
    const plan = (settings: Settings, id = "scout") => planAgents(withFallback, settings).plans.find((item) => item.id === id)!;

    test("the profile's list goes with the profile's model", () => {
      expect(plan(mergeSettings([], withFallback))).toEqual({
        id: "scout",
        model: "anthropic/claude-sonnet-5-5",
        effort: "medium",
        fallback: [{ model: "openai/gpt-a", effort: "low" }, { model: "openai/gpt-b" }],
      });
      // An agent whose profile gives no list has none, and no empty list is carried.
      expect("fallback" in plan(mergeSettings([], withFallback), "builder")).toBe(false);
    });

    test("an effort override alone keeps the profile's list", () => {
      expect(plan(mergeSettings([{ agents: { scout: { effort: "high" } } }], withFallback))).toMatchObject({ effort: "high", fallback: [{ model: "openai/gpt-a", effort: "low" }, { model: "openai/gpt-b" }] });
    });

    test("a settings model without a list drops the profile's list", () => {
      const result = plan(mergeSettings([{ agents: { scout: { model: "openai/gpt-x" } } }], withFallback));
      expect(result).toEqual({ id: "scout", model: "openai/gpt-x" });
    });

    test("a settings model with its own list uses it, and a later file's list replaces an earlier one", () => {
      const settings = mergeSettings(
        [
          { agents: { scout: { model: "openai/gpt-x", fallback: [{ model: "a/1" }] } } },
          { agents: { scout: { model: "openai/gpt-x", fallback: [{ model: "b/2", effort: "max" }] } } },
        ],
        withFallback,
      );
      expect(plan(settings)).toEqual({ id: "scout", model: "openai/gpt-x", fallback: [{ model: "b/2", effort: "max" }] });
    });

    test("an empty list in the settings clears the profile's list", () => {
      const settings = mergeSettings([{ agents: { scout: { model: "anthropic/claude-sonnet-5-5", fallback: [] } } }], withFallback);
      expect("fallback" in plan(settings)).toBe(false);
    });
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

  test("with the policies' meanings, the line after it says what the policy in force means", () => {
    const always = rewriteReviewLine(LEAD_PROMPT, "always", "lead", REVIEW_MEANINGS).prompt!;
    expect(always).toBe(LEAD_PROMPT.replace(`Review policy: auto\n${REVIEW_MEANINGS.auto}\n`, `Review policy: always\n${REVIEW_MEANINGS.always}\n`));
    // From any policy to any other and back, the text does not drift.
    for (const policy of REVIEW_POLICIES) {
      const once = rewriteReviewLine(always, policy, "lead", REVIEW_MEANINGS).prompt!;
      expect(once).toContain(`Review policy: ${policy}\n${REVIEW_MEANINGS[policy]}\n`);
      expect(rewriteReviewLine(once, "auto", "lead", REVIEW_MEANINGS).prompt).toBe(LEAD_PROMPT);
    }
    expect(rewriteReviewLine(`a\r\nReview policy: auto\r\n${REVIEW_MEANINGS.auto}\r\nb`, "never", "lead", REVIEW_MEANINGS).prompt).toBe(
      `a\r\nReview policy: never\r\n${REVIEW_MEANINGS.never}\r\nb`,
    );
    // A next line that is none of the harness's meanings is the user's own: kept.
    expect(rewriteReviewLine("Review policy: auto\nMy own words.", "never", "lead", REVIEW_MEANINGS).prompt).toBe("Review policy: never\nMy own words.");
    expect(rewriteReviewLine("Review policy: auto", "never", "lead", REVIEW_MEANINGS).prompt).toBe("Review policy: never");
  });
});

describe("rewriteHelperSlotsLine", () => {
  test("overrides old and current limits, preserving surrounding instructions and line endings", () => {
    for (const limit of ["three helpers", "4 helpers", "1 helper"]) {
      const prompt = `Before\r\nRun at most ${limit} at once. Keep builders on disjoint files.\r\nAfter`;
      const changed = rewriteHelperSlotsLine(prompt, 8, "lead").prompt!;
      expect(changed).toBe("Before\r\nRun at most 8 helpers at once. Keep builders on disjoint files.\r\nAfter");
      expect(rewriteHelperSlotsLine(changed, 8, "lead").prompt).toBe(changed);
      expect(helperSlotsLine(changed)).toBe("Run at most 8 helpers at once.");
      expect(rewriteHelperSlotsLine(changed, 1, "lead").prompt).toContain("Run at most 1 helper at once.");
    }
  });

  test("missing and duplicate instructions cannot be rewritten or reported as effective", () => {
    for (const prompt of ["Custom lead.", "Run at most 4 helpers at once.\nRun at most 2 helpers at once."]) {
      expect(rewriteHelperSlotsLine(prompt, 6, "lead").problem).toContain("max_helper_slots was not applied");
      expect(helperSlotsLine(prompt)).toBeNull();
    }
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
    const settings = settingsOf({ profile: "anthropic", review: "always", max_helper_slots: 8, agents: { scout: { steps: 9 }, builder: { model: "openrouter/anthropic/claude-x" } } });
    applyToV2Agents(editor, harness, settings, planAgents(harness, settings).plans);
    expect(editor.get("reviewer")).toMatchObject({ model: { id: "claude-opus-5-5", providerID: "anthropic", variant: "high" }, steps: 30 });
    expect(editor.get("scout")).toMatchObject({ model: { id: "claude-sonnet-5-5", providerID: "anthropic", variant: "medium" }, steps: 9 });
    expect(editor.get("builder")!.model).toEqual({ id: "anthropic/claude-x", providerID: "openrouter" });
    expect(editor.get("lead")!.system).toContain("\nReview policy: always\n");
    expect(editor.get("lead")!.system).toContain("Run at most 8 helpers at once. Run builders only on disjoint files.");
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
    expect(problems).toHaveLength(2);
    expect(problems[0]!.notify).toBe(true);
    expect(problems[1]!.notify).toBe(false);
    expect(editor.get("lead")!.system).toBe("Custom.");
  });

  test("an explicit helper limit that cannot apply is reported without undoing the review policy", () => {
    const editor = v2Editor();
    editor.get("lead")!.system = "Custom.\nReview policy: auto";
    const problems = applyToV2Agents(editor, harness, settingsOf({ review: "never", max_helper_slots: 2 }), []);
    expect(problems).toEqual([{ message: 'ecmwf-multi-agents: the prompt of lead has no "Run at most ... helpers at once." instruction; max_helper_slots was not applied', notify: true }]);
    expect(editor.get("lead")!.system).toBe("Custom.\nReview policy: never");
  });
});

describe("applyToV2Agents with helpers switched on and off", () => {
  function apply(editor: ReturnType<typeof v2Editor>, ...files: SettingsFile[]) {
    const settings = settingsOf(...files);
    return applyToV2Agents(editor, harness, settings, planAgents(harness, settings).plans);
  }

  test("a default helper switched off is removed, and lead's list says so", () => {
    const editor = v2Editor();
    expect(apply(editor, { agents: { builder: { enabled: false, steps: 9 } } })).toEqual([]);
    expect(editor.agents.has("builder")).toBe(false);
    expect(editor.get("lead")!.system).toBe(LEAD_PROMPT.replace("- builder: makes one change.\n- reviewer: checks work.\n", `- reviewer: checks work.\n- ${HELPER_OFF}\n`));
  });

  test("lead may hand work to an optional helper only while it is on: one allow rule, after its own", () => {
    const own = [
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "scout", effect: "allow" },
    ];
    const editor = withTester(v2Editor());
    editor.get("lead")!.permissions = structuredClone(own);
    apply(editor, { agents: { tester: { enabled: true } } });
    // A second run in the same rebuild, as when two registrations overlap, adds nothing.
    apply(editor, { agents: { tester: { enabled: true } } });
    expect(editor.get("lead")!.permissions).toEqual([...own, { action: "subagent", resource: "tester", effect: "allow" }]);

    // Off, as by default: a user's own agent with its name stays out of lead's reach.
    const off = v2Editor();
    off.get("lead")!.permissions = structuredClone(own);
    apply(off);
    expect(off.get("lead")!.permissions).toEqual(own);
  });

  test("an optional helper switched on gets its line in lead's list and its profile model", () => {
    const editor = withTester(v2Editor());
    expect(apply(editor, { profile: "anthropic", agents: { tester: { enabled: true } } })).toEqual([]);
    expect(editor.get("lead")!.system).toContain(`- reviewer: checks work.\n- tester: ${TESTER_ROUTING}\n\nRun at most`);
    expect(editor.get("tester")!.model).toEqual({ id: "claude-opus-5-5", providerID: "anthropic", variant: "high" });
  });

  test("a user's own agent with an optional helper's name is left alone while the harness's is off", () => {
    const editor = v2Editor();
    editor.update("tester", (agent) => Object.assign(agent, { mode: "subagent", system: "My tester.", model: { id: "mine", providerID: "me" } }));
    expect(apply(editor, { profile: "anthropic" })).toEqual([]);
    expect(editor.get("tester")).toMatchObject({ system: "My tester.", model: { id: "mine", providerID: "me" } });
    expect(editor.get("lead")!.system).toBe(LEAD_PROMPT);
  });

  test("with the reviewer off nothing is reviewed; a policy a file chose is reported", () => {
    const quiet = v2Editor();
    expect(apply(quiet, { agents: { reviewer: { enabled: false } } })).toEqual([]);
    expect(quiet.get("lead")!.system).toContain(`\nReview policy: never\n${REVIEW_MEANINGS.never}\n`);
    expect(quiet.agents.has("reviewer")).toBe(false);

    const editor = v2Editor();
    expect(apply(editor, { review: "always" }, { agents: { reviewer: { enabled: false } } })).toEqual([
      { message: 'ecmwf-multi-agents: the review policy "always" needs the reviewer, which is switched off, so nothing is reviewed', notify: true },
    ]);
    expect(editor.get("lead")!.system).toContain("\nReview policy: never\n");
    expect(apply(v2Editor(), { review: "never", agents: { reviewer: { enabled: false } } })).toEqual([]);
  });

  test("a lead without the helper list is reported when helpers are switched, and the helpers still change", () => {
    const editor = withTester(v2Editor());
    editor.get("lead")!.system = "Custom.\nReview policy: auto\nRun at most 4 helpers at once.";
    expect(apply(editor, { agents: { builder: { enabled: false }, tester: { enabled: true } } })).toEqual([
      {
        message:
          'ecmwf-multi-agents: the prompt of lead has no line "- scout: ..."; its helper list was left as it is, so it may name helpers that are off and miss ones that are on',
        notify: true,
      },
    ]);
    expect(editor.agents.has("builder")).toBe(false);
    expect(editor.get("lead")!.system).toBe("Custom.\nReview policy: auto\nRun at most 4 helpers at once.");
    // With nothing switched, a custom lead's list is nobody's business.
    const plain = v2Editor();
    plain.get("lead")!.system = "Custom.\nReview policy: auto\nRun at most 4 helpers at once.";
    expect(apply(plain)).toEqual([]);
  });

  test("an opencode that cannot remove agents reports the helper that stays", () => {
    const editor = v2Editor();
    delete (editor as Partial<V2AgentEditor>).remove;
    expect(apply(editor, { agents: { scout: { enabled: false } } })).toEqual([
      { message: "ecmwf-multi-agents: this opencode cannot remove agents, so scout stays although it is switched off", notify: true },
    ]);
    expect(editor.agents.has("scout")).toBe(true);
  });
});
