// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { RuleOrder, findRun, ownRulesLast } from "./rule-order.ts";
import { embeddedFixture } from "./testing.ts";
import type { PermissionRule, V2AgentEditor, V2AgentInfo } from "./types.ts";

const rule = (action: string, resource: string, effect: string): PermissionRule => ({ action, resource, effect });
const DEFAULTS = [rule("*", "*", "allow"), rule("read", "*.env", "ask")];
const OWN = [rule("shell", "*", "deny"), rule("shell", "git log *", "allow")];
const CONFIG = [rule("shell", "*", "allow"), rule("edit", "*", "allow")];
const PER_AGENT = [rule("shell", "ls *", "deny")];

/** opencode's evaluation: the last matching rule wins (wildcards reduced to `*` and prefix `x *`). */
function decide(rules: readonly PermissionRule[], action: string, resource: string): string | undefined {
  const matches = (pattern: string, value: string) => pattern === "*" || pattern === value || (pattern.endsWith(" *") && value.startsWith(pattern.slice(0, -1)));
  return [...rules].reverse().find((item) => matches(item.action, action) && matches(item.resource, resource))?.effect;
}

describe("ownRulesLast", () => {
  test("moves the agent's own rules after the config's, as an agent file has them", () => {
    const registered = [...DEFAULTS, ...OWN, ...CONFIG, ...PER_AGENT];
    const ordered = ownRulesLast(registered, OWN, CONFIG);
    expect(ordered).toEqual([...DEFAULTS, ...CONFIG, ...OWN, ...PER_AGENT]);
    expect(decide(registered, "shell", "touch x")).toBe("allow");
    expect(decide(ordered, "shell", "touch x")).toBe("deny");
    expect(decide(ordered, "shell", "git log -1")).toBe("allow");
    // The user's rules for this one agent still come last, and the config's rules still decide
    // what the agent's own rules leave alone.
    expect(decide(ordered, "shell", "ls -l")).toBe("deny");
    expect(decide(ordered, "edit", "src/a.ts")).toBe("allow");
  });

  test("rules every agent received after the config's stay after the agent's own when one agent has rules of its own", () => {
    const later = [rule("browser", "*", "deny")];
    const everyAgent = [...CONFIG, ...later];
    expect(ownRulesLast([...OWN, ...CONFIG, ...PER_AGENT, ...later], OWN, everyAgent)).toEqual([...CONFIG, ...OWN, ...PER_AGENT, ...later]);
    // Without any, the agent's own rules move past them as well.
    expect(ownRulesLast([...OWN, ...CONFIG, ...later], OWN, everyAgent)).toEqual([...CONFIG, ...later, ...OWN]);
  });

  test("an agent file's own rules after the config's keep the list equivalent", () => {
    expect(ownRulesLast([...OWN, ...CONFIG, ...OWN], OWN, CONFIG)).toEqual([...CONFIG, ...OWN, ...OWN]);
  });

  test("leaves the list alone when the agent's own rules are missing or nothing every agent received follows them", () => {
    expect(ownRulesLast([...DEFAULTS, ...CONFIG], OWN, CONFIG)).toEqual([...DEFAULTS, ...CONFIG]);
    expect(ownRulesLast([...DEFAULTS, ...OWN], OWN, CONFIG)).toEqual([...DEFAULTS, ...OWN]);
    expect(ownRulesLast([...CONFIG, ...OWN], OWN, CONFIG)).toEqual([...CONFIG, ...OWN]);
    expect(ownRulesLast([...OWN, ...CONFIG], OWN, [])).toEqual([...OWN, ...CONFIG]);
    expect(ownRulesLast([...OWN, ...CONFIG], [], CONFIG)).toEqual([...OWN, ...CONFIG]);
  });

  test("findRun matches whole runs only", () => {
    expect(findRun([...CONFIG, ...OWN, ...OWN], OWN)).toBe(2);
    expect(findRun([...OWN, ...CONFIG], [OWN[0]!, CONFIG[1]!])).toBe(-1);
    expect(findRun(OWN, [])).toBe(-1);
  });
});

/** An agent state with the editor opencode gives transforms. */
function state() {
  const agents = new Map<string, V2AgentInfo>();
  const editor: V2AgentEditor = {
    list: () => [...agents.values()],
    get: (id) => agents.get(id),
    default: () => {},
    update: (id, update) => {
      const agent = agents.get(id) ?? { id, permissions: [...DEFAULTS] };
      agents.set(id, agent);
      update(agent);
    },
    remove: (id) => void agents.delete(id),
  };
  return { agents, editor };
}

describe("RuleOrder", () => {
  const harness = embeddedFixture();
  const scout = harness.agents.find((agent) => agent.id === "scout")!.permissions!;
  /** The registration (early), opencode's loader with the config's rules, then the late transform. */
  const rebuild = (order: RuleOrder) => {
    const { agents, editor } = state();
    for (const agent of harness.agents) editor.update(agent.id, (info) => info.permissions!.push(...agent.permissions!));
    order.addProbe(editor);
    for (const agent of editor.list()) agent.permissions!.push(...CONFIG);
    editor.update("scout", (agent) => agent.permissions!.push(...PER_AGENT));
    order.apply(editor);
    return agents;
  };

  test("before the late transform is registered, nothing is added or moved", () => {
    const agents = rebuild(new RuleOrder(harness, "/home/user"));
    expect([...agents.keys()]).toEqual(harness.agents.map((agent) => agent.id));
    expect(agents.get("scout")!.permissions).toEqual([...DEFAULTS, ...scout, ...CONFIG, ...PER_AGENT]);
  });

  test("once started, every agent's own rules follow the config's and the probe is gone", () => {
    const order = new RuleOrder(harness, "/home/user");
    order.start();
    const agents = rebuild(order);
    expect([...agents.keys()]).toEqual(harness.agents.map((agent) => agent.id));
    expect(agents.get("scout")!.permissions).toEqual([...DEFAULTS, ...CONFIG, ...scout, ...PER_AGENT]);
    for (const agent of harness.agents) expect(agents.get(agent.id)!.permissions).toEqual([...DEFAULTS, ...CONFIG, ...agent.permissions!, ...(agent.id === "scout" ? PER_AGENT : [])]);
  });

  test("an editor without remove gets no probe", () => {
    const order = new RuleOrder(harness, "/home/user");
    order.start();
    const { agents, editor } = state();
    order.addProbe({ ...editor, remove: undefined });
    expect(agents.size).toBe(0);
  });
});
