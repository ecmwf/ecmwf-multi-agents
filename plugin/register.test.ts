// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { registerV1, skillsDirOf } from "./register.ts";
import { embeddedFixture } from "./testing.ts";
import type { V1Config } from "./types.ts";

const harness = embeddedFixture();
const SKILLS = "/checkout/dist/opencode-v1/skills";
/** Every skill of the fixture is in the skills folder. */
const allSkills = (file: string) => (file.startsWith(`${SKILLS}/`) && file.endsWith("/SKILL.md") ? "---\nname: x\n---\n" : undefined);
const options = { skillsDir: SKILLS, readFile: allSkills };

describe("registerV1", () => {
  test("into a config without the harness: every agent and command as embedded, and the skills folder", () => {
    const config: V1Config = {};
    expect(registerV1(config, harness, options)).toEqual([]);
    expect(Object.keys(config.agent!)).toEqual(["lead", "scout", "builder", "reviewer"]);
    expect(config.agent!.lead).toEqual(harness.v1.agents.lead!);
    expect(config.agent!.scout!.prompt).toBe(String(harness.v1.agents.scout!.prompt));
    expect(Object.keys(config.command!)).toEqual(["plan", "review"]);
    expect(config.command!.review).toEqual(harness.v1.commands.review);
    expect(config.skills).toEqual({ paths: [SKILLS] });
  });

  test("copies the entries, so changes to the config never reach the embedded data", () => {
    const config: V1Config = {};
    registerV1(config, harness, options);
    config.agent!.lead!.prompt = "changed";
    expect(harness.v1.agents.lead!.prompt).not.toBe("changed");
  });

  test("does nothing when lead is defined: the harness files are installed", () => {
    const config: V1Config = { agent: { lead: { prompt: "installed" } }, command: {} };
    expect(registerV1(config, harness, options)).toEqual([]);
    expect(Object.keys(config.agent!)).toEqual(["lead"]);
    expect(config.command).toEqual({});
    expect(config.skills).toBeUndefined();
  });

  test("keeps what is defined elsewhere, and says so: a project's own scout and /plan win", () => {
    const own = { mode: "subagent", prompt: "the project's scout" };
    const config: V1Config = { agent: { build: { mode: "primary" }, scout: own }, command: { plan: { template: "the project's plan" } } };
    const problems = registerV1(config, harness, options);
    expect(config.agent!.scout).toBe(own);
    expect(config.agent!.build).toEqual({ mode: "primary" });
    expect(config.agent!.lead).toEqual(harness.v1.agents.lead!);
    expect(config.command!.plan).toEqual({ template: "the project's plan" });
    expect(config.command!.review).toEqual(harness.v1.commands.review);
    expect(problems).toEqual([
      { message: "ecmwf-multi-agents: the agent scout is defined elsewhere (this project or your opencode config), so that definition is used, not the harness's", notify: true },
      { message: "ecmwf-multi-agents: the command /plan is defined elsewhere (this project or your opencode config), so that one runs, not the harness's", notify: false },
    ]);
  });

  test("adds the skills folder to the paths already configured, once", () => {
    const config: V1Config = { skills: { paths: ["/mine"], urls: ["https://example.org/skills/"] } };
    registerV1(config, harness, options);
    expect(config.skills).toEqual({ paths: ["/mine", SKILLS], urls: ["https://example.org/skills/"] });
    const again: V1Config = { skills: { paths: [SKILLS] } };
    registerV1(again, harness, options);
    expect(again.skills!.paths).toEqual([SKILLS]);
  });

  test("an incomplete skills folder is reported and not added; the agents still come", () => {
    const config: V1Config = {};
    const problems = registerV1(config, harness, { skillsDir: SKILLS, readFile: () => undefined });
    expect(config.agent!.lead).toBeDefined();
    expect(config.skills).toEqual({});
    expect(problems).toEqual([
      {
        message: `ecmwf-multi-agents: the skills folder next to the plugin is incomplete (ecmwf-multi-agents-plan not found in ${SKILLS}), so lead cannot load them; check the checkout`,
        notify: true,
      },
    ]);
    const unknown: V1Config = {};
    expect(registerV1(unknown, harness, { skillsDir: undefined, readFile: allSkills })[0]!.message).toContain("(ecmwf-multi-agents-plan not found)");
  });

  test("a config of an unexpected shape is reported and left alone", () => {
    const config = { agent: "lead" } as unknown as V1Config;
    expect(registerV1(config, harness, options)).toEqual([
      { message: "ecmwf-multi-agents: the opencode config has an unexpected shape, so the harness was not switched on", notify: true },
    ]);
    expect(config.agent as unknown).toBe("lead");
  });
});

test("skillsDirOf: the skills folder next to the folder the bundle is in", () => {
  expect(skillsDirOf("/checkout/dist/opencode-v1/plugins/ecmwf-multi-agents.js")).toBe(path.join("/checkout/dist/opencode-v1", "skills"));
  expect(skillsDirOf(undefined)).toBeUndefined();
  expect(skillsDirOf("")).toBeUndefined();
});
