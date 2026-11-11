// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Which model an agent runs on when its own model may not be set up: the first usable one of
// [primary, ...fallback]. The caller reads opencode's provider and model lists into an
// `Availability` snapshot (ids only, never credentials) and gets the choice back.
//
// opencode 2.2.5 and 2.2.6 (docs/research/opencode-v2.md, "Addendum: fallback models"):
// `provider.list` and `model.list` return only what is available (a provider that is set up, an
// enabled chat model), so being listed means being usable and the plugin does not recompute
// opencode's own rule.
//
// `ModelChoices` keeps the current choice of every agent, shared by the agent transform and the
// doctor check so both name the same model. Nothing here reads credentials or a provider's
// settings, headers or body: only ids.

import type { AgentPlan } from "./apply.ts";
import { unwrap } from "./register.ts";
import type { FallbackEntry, Problem } from "./types.ts";

/** A model as opencode lists it. */
export interface ModelState {
  id: string;
  providerID: string;
}

/**
 * What opencode lists right now. `models` is left out when the model list could not be read: a
 * model is then judged on its provider alone. "unknown": the provider list could not be read,
 * so nothing can be judged.
 */
export type Availability = "unknown" | { providers: readonly string[]; models?: readonly ModelState[] };

export interface ModelChoice {
  /** The chosen candidate, with its own effort. The primary when none is usable or availability is unknown. */
  choice: FallbackEntry;
  /** Position in [primary, ...fallback]; 0 for the primary. */
  index: number;
  /** Why each candidate tried before the choice was skipped. */
  notes: string[];
  /** Set when no candidate is usable, so the primary stays. */
  problem?: Problem;
}

/** Split `provider/model[#variant]` at the first "/" and drop the variant; undefined without a "/". */
function parts(model: string): { providerID: string; id: string } | undefined {
  const slash = model.indexOf("/");
  if (slash < 0) return undefined;
  const hash = model.indexOf("#", slash);
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1, hash < 0 ? undefined : hash) };
}

/** Why a candidate is not usable (not listed by opencode), or undefined when it is. */
function unusableReason(model: string, available: Exclude<Availability, "unknown">): string | undefined {
  const ref = parts(model);
  if (ref === undefined) return "it is not written as provider/model";
  if (!available.providers.includes(ref.providerID)) return `provider ${ref.providerID} is not available`;
  // A disabled or unknown model is not listed: opencode lists enabled chat models only.
  if (available.models !== undefined && !available.models.some((item) => item.providerID === ref.providerID && item.id === ref.id)) {
    return `model ${ref.id} is not available for provider ${ref.providerID}`;
  }
  return undefined;
}

/**
 * The first usable of [primary, ...fallback], keeping its own effort. With "unknown"
 * availability the primary, as before fallbacks existed. When none is usable, the primary and
 * a problem to report.
 */
export function chooseModel(primary: FallbackEntry, fallback: readonly FallbackEntry[], available: Availability): ModelChoice {
  if (available === "unknown") return { choice: primary, index: 0, notes: [] };
  const candidates = [primary, ...fallback];
  const notes: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const reason = unusableReason(candidate.model, available);
    if (reason === undefined) return { choice: candidate, index, notes };
    notes.push(`${candidate.model} skipped: ${reason}`);
  }
  const tried = candidates.length === 1 ? "its model" : `its model and ${candidates.length - 1} fallback${candidates.length === 2 ? "" : "s"}`;
  return {
    choice: primary,
    index: 0,
    notes,
    problem: { message: `none of ${tried} is usable, so ${primary.model} stays: ${notes.join("; ")}`, notify: true },
  };
}

/** The provider and model lists of opencode's plugin context, as far as this module reads them. */
export interface AvailabilitySource {
  provider?: { list?: () => Promise<unknown> };
  model?: { list?: () => Promise<unknown> };
}

/** How long a list call may take; opencode's own server gives up on plugins after 5 seconds. */
export const READ_TIMEOUT_MS = 5000;

/** The list in an answer, or undefined when the call is missing, throws, answers oddly or hangs. */
async function entriesOf(read: () => unknown, timeoutMs: number): Promise<unknown[] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    const value = unwrap<unknown>(await Promise.race([Promise.resolve().then(read), timeout]));
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function text(entry: unknown, key: string): string | undefined {
  const value = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Read what opencode lists: provider ids, and model ids with their provider. "unknown" when the
 * provider list is missing or fails; without a model list the choice rests on providers alone.
 * Only ids are read, so nothing secret passes through.
 */
export async function readAvailability(source: AvailabilitySource, timeoutMs = READ_TIMEOUT_MS): Promise<Availability> {
  const providers = await entriesOf(() => source.provider?.list?.(), timeoutMs);
  if (providers === undefined) return "unknown";
  const ids = providers.flatMap((entry) => {
    const id = text(entry, "id");
    return id === undefined || text(entry, "activation") === "disabled" ? [] : [id];
  });
  const models = await entriesOf(() => source.model?.list?.(), timeoutMs);
  if (models === undefined) return { providers: ids };
  return {
    providers: ids,
    models: models.flatMap((entry) => {
      const id = text(entry, "id");
      const providerID = text(entry, "providerID");
      return id === undefined || providerID === undefined ? [] : [{ id, providerID }];
    }),
  };
}

/** What `ModelChoices.update` found: whether any agent's model changed, and what to tell the user. */
export interface ChoiceUpdate {
  changed: boolean;
  problems: Problem[];
}

/**
 * The model and effort each agent runs on now. Until `update` has been given a snapshot every
 * agent runs on its own (primary) model, as it did before fallbacks existed. Repeating `update`
 * with the same snapshot changes and announces nothing, so duplicate events are harmless.
 */
export class ModelChoices {
  private readonly chosen = new Map<string, string>();
  private readonly results = new Map<string, FallbackEntry>();
  private readonly told = new Map<string, string>();

  /**
   * @param base each agent's own model and effort, and its fallbacks
   * @param active whether to tell the user about an agent: a helper that is switched off is not told
   */
  constructor(
    private readonly name: string,
    private readonly base: readonly AgentPlan[],
    private readonly active: (id: string) => boolean = () => true,
  ) {}

  /** The plans with each agent's model and effort as currently chosen. */
  plans(): AgentPlan[] {
    return this.base.map((plan) => {
      const result = this.results.get(plan.id);
      if (result === undefined || plan.model === undefined) return plan;
      const { effort: _own, ...rest } = plan;
      return { ...rest, model: result.model, ...(result.effort === undefined ? {} : { effort: result.effort }) };
    });
  }

  /**
   * Choose again from a snapshot. "unknown" sends every agent back to its primary. An agent
   * without a fallback is never resolved or reported: it keeps its primary, as before fallbacks.
   */
  update(availability: Availability): ChoiceUpdate {
    const update: ChoiceUpdate = { changed: false, problems: [] };
    for (const plan of this.base) {
      if (plan.model === undefined || plan.fallback === undefined || plan.fallback.length === 0) continue;
      const primary: FallbackEntry = { model: plan.model, ...(plan.effort === undefined ? {} : { effort: plan.effort }) };
      const result = chooseModel(primary, plan.fallback, availability);
      const signature = `${result.choice.model}\n${result.choice.effort ?? ""}`;
      const before = this.chosen.get(plan.id) ?? `${primary.model}\n${primary.effort ?? ""}`;
      this.chosen.set(plan.id, signature);
      this.results.set(plan.id, result.choice);
      if (signature !== before) update.changed = true;
      if (!this.active(plan.id)) continue;
      if (signature !== before && result.index > 0) {
        update.problems.push({ message: `${this.name}: ${plan.id} runs on ${result.choice.model}, its fallback number ${result.index}: ${result.notes.join("; ")}`, notify: true });
      }
      const problem = result.problem === undefined ? undefined : `${this.name}: ${plan.id}: ${result.problem.message}`;
      if (problem === undefined) this.told.delete(plan.id);
      else if (this.told.get(plan.id) !== problem) {
        this.told.set(plan.id, problem);
        update.problems.push({ message: problem, notify: true });
      }
    }
    return update;
  }
}
