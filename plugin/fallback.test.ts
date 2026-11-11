// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { AgentPlan } from "./apply.ts";
import { ModelChoices, chooseModel, readAvailability, type Availability } from "./fallback.ts";

const listed: Availability = { providers: ["anthropic", "openai", "ollama"] };

describe("chooseModel", () => {
  test("keeps the primary when it is usable", () => {
    const result = chooseModel({ model: "anthropic/opus", effort: "high" }, [{ model: "openai/gpt" }], listed);
    expect(result).toEqual({ choice: { model: "anthropic/opus", effort: "high" }, index: 0, notes: [] });
  });

  test("an unknown snapshot gives the primary and no notes", () => {
    const result = chooseModel({ model: "x/y" }, [{ model: "anthropic/opus" }], "unknown");
    expect(result).toEqual({ choice: { model: "x/y" }, index: 0, notes: [] });
  });

  test("uses the first usable fallback with its own effort and notes the skipped ones", () => {
    const result = chooseModel(
      { model: "gone/gpt", effort: "high" },
      [{ model: "missing/m", effort: "low" }, { model: "anthropic/sonnet", effort: "medium" }, { model: "anthropic/haiku" }],
      listed,
    );
    expect(result.choice).toEqual({ model: "anthropic/sonnet", effort: "medium" });
    expect(result.index).toBe(2);
    expect(result.notes).toEqual(["gone/gpt skipped: provider gone is not available", "missing/m skipped: provider missing is not available"]);
    expect(result.problem).toBeUndefined();
  });

  test("a fallback without effort has none, whatever the primary had", () => {
    const result = chooseModel({ model: "gone/gpt", effort: "high" }, [{ model: "anthropic/haiku" }], listed);
    expect(result.choice).toEqual({ model: "anthropic/haiku" });
    expect(result.choice.effort).toBeUndefined();
  });

  test("an empty fallback list gives the primary when usable", () => {
    expect(chooseModel({ model: "anthropic/opus" }, [], listed).index).toBe(0);
  });

  test("an empty fallback list and an unusable primary give the primary and a problem", () => {
    const result = chooseModel({ model: "gone/gpt", effort: "high" }, [], listed);
    expect(result.choice).toEqual({ model: "gone/gpt", effort: "high" });
    expect(result.index).toBe(0);
    expect(result.problem?.notify).toBe(true);
    expect(result.problem?.message).toContain("gone/gpt");
  });

  test("none usable: the primary stays with its effort, a problem lists every skip", () => {
    const result = chooseModel({ model: "gone/gpt", effort: "high" }, [{ model: "nope/m", effort: "low" }], listed);
    expect(result.choice).toEqual({ model: "gone/gpt", effort: "high" });
    expect(result.index).toBe(0);
    expect(result.notes).toHaveLength(2);
    expect(result.problem?.message).toContain("gone/gpt skipped: provider gone is not available");
    expect(result.problem?.message).toContain("nope/m skipped: provider nope is not available");
  });

  test("an entry without a slash is not usable", () => {
    const result = chooseModel({ model: "bare" }, [{ model: "anthropic/opus" }], listed);
    expect(result.choice.model).toBe("anthropic/opus");
    expect(result.notes).toEqual(["bare skipped: it is not written as provider/model"]);
  });

  describe("with a model list", () => {
    const withModels: Availability = {
      providers: ["anthropic", "openai"],
      models: [
        { id: "sonnet", providerID: "anthropic" },
        { id: "gpt", providerID: "openai" },
        { id: "sonnet", providerID: "other" },
      ],
    };

    test("a model missing from the list (unknown or disabled) is skipped", () => {
      const result = chooseModel({ model: "anthropic/opus" }, [{ model: "anthropic/sonnet" }], withModels);
      expect(result.choice.model).toBe("anthropic/sonnet");
      expect(result.notes).toEqual(["anthropic/opus skipped: model opus is not available for provider anthropic"]);
    });

    test("models match on provider and id, not on the id alone", () => {
      // "sonnet" is listed for anthropic and other, but not for openai.
      expect(chooseModel({ model: "openai/sonnet" }, [], withModels).problem).toBeDefined();
    });

    test("a variant is ignored when matching, and kept in the choice", () => {
      const result = chooseModel({ model: "anthropic/sonnet#max", effort: "max" }, [], withModels);
      expect(result.choice).toEqual({ model: "anthropic/sonnet#max", effort: "max" });
      expect(result.problem).toBeUndefined();
    });

    test("a model id may itself contain slashes", () => {
      const available: Availability = { providers: ["router"], models: [{ id: "vendor/model", providerID: "router" }] };
      expect(chooseModel({ model: "router/vendor/model" }, [], available).problem).toBeUndefined();
    });

    test("the provider must be listed even when the model is", () => {
      const available: Availability = { providers: ["anthropic"], models: [{ id: "gpt", providerID: "openai" }] };
      expect(chooseModel({ model: "openai/gpt" }, [], available).problem).toBeDefined();
    });
  });

  test("without a model list the choice rests on the provider alone", () => {
    expect(chooseModel({ model: "anthropic/anything" }, [], listed).choice.model).toBe("anthropic/anything");
  });
});

describe("readAvailability", () => {
  test("reads provider and model ids, with or without the data wrapper, and skips a disabled provider", async () => {
    const result = await readAvailability({
      provider: { list: async () => ({ location: {}, data: [{ id: "a", activation: "auto", integrationID: "x" }, { id: "b", activation: "disabled" }, { id: "c" }, { nope: 1 }] }) },
      model: { list: async () => [{ id: "m", providerID: "a", enabled: true }, { id: "n" }] },
    });
    expect(result).toEqual({ providers: ["a", "c"], models: [{ id: "m", providerID: "a" }] });
  });

  test("a missing or failing provider list is unknown", async () => {
    expect(await readAvailability({})).toBe("unknown");
    expect(await readAvailability({ provider: {} })).toBe("unknown");
    expect(await readAvailability({ provider: { list: async () => Promise.reject(new Error("no")) } })).toBe("unknown");
    expect(await readAvailability({ provider: { list: () => { throw new Error("sync"); } } })).toBe("unknown");
    expect(await readAvailability({ provider: { list: async () => "odd" } })).toBe("unknown");
  });

  test("a missing or failing model list leaves the models out", async () => {
    const provider = { list: async () => [{ id: "a" }] };
    expect(await readAvailability({ provider })).toEqual({ providers: ["a"] });
    expect(await readAvailability({ provider, model: { list: async () => Promise.reject(new Error("no")) } })).toEqual({ providers: ["a"] });
  });

  test("a list that never answers counts as missing once the time is up", async () => {
    const hang = () => new Promise<never>(() => {});
    expect(await readAvailability({ provider: { list: hang } }, 10)).toBe("unknown");
    expect(await readAvailability({ provider: { list: async () => [{ id: "a" }] }, model: { list: hang } }, 10)).toEqual({ providers: ["a"] });
  });
});

describe("ModelChoices", () => {
  const plans: AgentPlan[] = [
    { id: "lead", model: "anthropic/opus", effort: "xhigh", fallback: [{ model: "openai/gpt", effort: "high" }] },
    { id: "scout", model: "anthropic/sonnet" },
    { id: "tester", model: "anthropic/opus", fallback: [{ model: "openai/gpt" }] },
    { id: "empty", model: "anthropic/haiku", fallback: [] },
    { id: "stuck", model: "anthropic/opus", fallback: [{ model: "google/gem" }] },
    { id: "free" },
  ];
  const active = (id: string) => id !== "tester";

  test("before any snapshot the plans are unchanged", () => {
    expect(new ModelChoices("x", plans).plans()).toEqual(plans);
  });

  test("a usable primary changes nothing and says nothing", () => {
    const choices = new ModelChoices("x", plans, active);
    expect(choices.update({ providers: ["anthropic", "openai"] })).toEqual({ changed: false, problems: [] });
    expect(choices.plans()).toEqual(plans);
  });

  test("a fallback replaces model and effort, is announced once, and a repeat is silent", () => {
    const choices = new ModelChoices("x", plans, active);
    const first = choices.update({ providers: ["openai"] });
    expect(first.changed).toBe(true);
    expect(first.problems.map((problem) => problem.message)).toEqual([
      "x: lead runs on openai/gpt, its fallback number 1: anthropic/opus skipped: provider anthropic is not available",
      "x: stuck: none of its model and 1 fallback is usable, so anthropic/opus stays: anthropic/opus skipped: provider anthropic is not available; google/gem skipped: provider google is not available",
    ]);
    // Both are shown: a review on another model than the one chosen is worth a toast.
    expect(first.problems.map((problem) => problem.notify)).toEqual([true, true]);
    const lead = choices.plans().find((plan) => plan.id === "lead")!;
    expect(lead).toEqual({ id: "lead", model: "openai/gpt", effort: "high", fallback: plans[0]!.fallback });
    expect(choices.plans().find((plan) => plan.id === "stuck")).toEqual(plans[4]!);
    expect(choices.update({ providers: ["openai"] })).toEqual({ changed: false, problems: [] });
  });

  test("an agent without a fallback, or with an empty one, is neither resolved nor reported", () => {
    const choices = new ModelChoices("x", plans, active);
    const update = choices.update({ providers: [] });
    const said = update.problems.map((problem) => problem.message).join("\n");
    for (const id of ["scout", "empty", "free"]) expect(said).not.toContain(`x: ${id}`);
    for (const id of ["scout", "empty", "free"]) {
      expect(choices.plans().find((plan) => plan.id === id)).toEqual(plans.find((plan) => plan.id === id)!);
    }
    const alone = new ModelChoices("x", [plans[1]!, plans[3]!]);
    expect(alone.update({ providers: [] })).toEqual({ changed: false, problems: [] });
  });

  test("the primary comes back when it is usable again, and a fallback without effort has none", () => {
    const choices = new ModelChoices("x", plans);
    choices.update({ providers: ["openai"] });
    expect(choices.plans().find((plan) => plan.id === "tester")).toMatchObject({ model: "openai/gpt" });
    expect("effort" in choices.plans().find((plan) => plan.id === "tester")!).toBe(false);
    const back = choices.update({ providers: ["anthropic", "openai"] });
    expect(back.changed).toBe(true);
    expect(back.problems).toEqual([]);
    expect(choices.plans()).toEqual(plans);
  });

  test("an unknown snapshot restores the primary, with its effort, once and silently", () => {
    const choices = new ModelChoices("x", plans);
    choices.update({ providers: ["openai"] });
    expect(choices.plans().find((plan) => plan.id === "lead")!.model).toBe("openai/gpt");
    expect(choices.update("unknown")).toEqual({ changed: true, problems: [] });
    expect(choices.plans()).toEqual(plans);
    expect(choices.update("unknown")).toEqual({ changed: false, problems: [] });
  });

  test("an unknown snapshot before any read changes nothing", () => {
    const choices = new ModelChoices("x", plans);
    expect(choices.update("unknown")).toEqual({ changed: false, problems: [] });
    expect(choices.plans()).toEqual(plans);
  });

  test("an agent that is not active is changed but not announced", () => {
    const choices = new ModelChoices("x", plans, active);
    const update = choices.update({ providers: ["openai"] });
    expect(update.problems.some((problem) => problem.message.includes("tester"))).toBe(false);
    expect(choices.plans().find((plan) => plan.id === "tester")!.model).toBe("openai/gpt");
  });
});
