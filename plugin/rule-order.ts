// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Keeps each registered agent's own permission rules after the user's config rules, as they are
// when the agent comes from a file.
//
// opencode's loader for agent files and config adds a config's top-level `permissions` to every
// agent that exists when it runs, and then an agent file's own rules after them
// (core/src/config/plugin/agent.ts:83-127 at v2.0.29). The rules are evaluated last match wins
// (core/src/permission.ts, `evaluate`), so an agent file's rules win over the user's. The agents
// the plugin registers exist before that loader runs, so the config's rules land after theirs
// and would win instead: a global "allow every shell command" would loosen `scout`'s read-only
// shell rules.
//
// To put the rules back in the file order, the registration transform also adds a hidden probe
// agent with no rules. Every rule added after it to all agents reaches the probe too: the
// config's, and those opencode adds after the config (2.0.29 denies `browser` to every agent,
// plugin-browser/src/connection.ts). The late transform (v2.ts), which runs after all of them,
// reads these rules from the probe, removes the probe and moves each agent's own rules past
// them. Rules given to one agent alone, such as the user's `agents.scout.permissions`, stop the
// move and stay after the agent's own, as with files. Without such rules the agent's own rules
// also end up after opencode's own later ones, where with files they come before; the harness
// has no rule for what those cover. The probe is only added once the late transform is
// registered, so it never reaches the agents opencode lists.

import { expandPermissions } from "./register.ts";
import type { EmbeddedHarness, PermissionRule, V2AgentEditor } from "./types.ts";

function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return a.action === b.action && a.resource === b.resource && a.effect === b.effect;
}

/** Index of the first run of `part` in `rules`, or -1. */
export function findRun(rules: readonly PermissionRule[], part: readonly PermissionRule[]): number {
  if (part.length === 0) return -1;
  for (let start = 0; start + part.length <= rules.length; start++) {
    if (part.every((rule, index) => sameRule(rules[start + index]!, rule))) return start;
  }
  return -1;
}

/**
 * The rules with the agent's own run moved past the rules that follow it and that every agent
 * received in the same order (`everyAgent`, read from the probe). Rules given to this agent alone
 * stop the move, so they stay after its own. Unchanged when the agent's own run is missing.
 */
export function ownRulesLast(rules: readonly PermissionRule[], own: readonly PermissionRule[], everyAgent: readonly PermissionRule[]): PermissionRule[] {
  const start = findRun(rules, own);
  if (start === -1) return [...rules];
  const end = start + own.length;
  let shared = 0;
  while (shared < everyAgent.length && end + shared < rules.length && sameRule(rules[end + shared]!, everyAgent[shared]!)) shared++;
  if (shared === 0) return [...rules];
  return [...rules.slice(0, start), ...rules.slice(end, end + shared), ...rules.slice(start, end), ...rules.slice(end + shared)];
}

export class RuleOrder {
  private active = false;
  readonly probe: string;

  constructor(
    private readonly harness: EmbeddedHarness,
    private readonly home: string,
  ) {
    this.probe = `${harness.name}-rule-probe`;
  }

  /** Called before the late transform is registered: from then on the probe is added. */
  start(): void {
    this.active = true;
  }

  /** In the registration transform, before opencode's loader. */
  addProbe(editor: V2AgentEditor): void {
    if (!this.active || typeof editor.remove !== "function") return;
    editor.update(this.probe, (agent) => {
      agent.mode = "subagent";
      agent.hidden = true;
      agent.permissions = [];
    });
  }

  /** In the late transform, after opencode's loader. */
  apply(editor: V2AgentEditor): void {
    const probe = editor.get(this.probe);
    if (probe === undefined) return;
    const everyAgent = [...(probe.permissions ?? [])];
    editor.remove?.(this.probe);
    if (everyAgent.length === 0) return;
    for (const embedded of this.harness.agents) {
      if (embedded.permissions === undefined || embedded.permissions.length === 0) continue;
      const own = expandPermissions(embedded.permissions, this.home);
      if (editor.get(embedded.id) === undefined) continue;
      editor.update(embedded.id, (agent) => {
        if (Array.isArray(agent.permissions)) agent.permissions = ownRulesLast(agent.permissions, own, everyAgent);
      });
    }
  }
}
