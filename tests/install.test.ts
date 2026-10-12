// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Fast tests for install.sh. Each test builds a fixture dist folder and fake `opencode` and
// `opencode2` commands in a temporary folder, points HOME and XDG_CONFIG_HOME there, and runs
// the installer. No real opencode, user configuration or network is involved.

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");
const INSTALL = path.join(REPO, "install.sh");
const NAME = "ecmwf-multi-agents";
const MARKER_MD = `# managed by ${NAME}`;
const MARKER_JS = `// managed by ${NAME}`;
// Only system folders, so the real opencode on the developer's PATH is never found.
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";

const PROFILES: Record<string, Record<string, { model: string; effort: string }>> = {
  default: {
    lead: { model: "anthropic/claude-opus-5-5", effort: "xhigh" },
    scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" },
    reviewer: { model: "github-copilot/gpt-6.1-sol", effort: "medium" },
  },
  anthropic: {
    lead: { model: "anthropic/claude-opus-5-5", effort: "xhigh" },
    scout: { model: "anthropic/claude-sonnet-5-5", effort: "medium" },
    reviewer: { model: "anthropic/claude-opus-5-5", effort: "high" },
  },
  inherit: {},
};

const MARKDOWN = [
  "agents/lead.md",
  "agents/scout.md",
  "agents/reviewer.md",
  "commands/plan.md",
  `skills/${NAME}-plan/SKILL.md`,
];

interface Box {
  dir: string;
  home: string;
  config: string;
  bin: string;
  dist: string;
}

const boxes: string[] = [];

afterEach(() => {
  for (const dir of boxes.splice(0)) {
    // Read-only folders from the central tests must be writable again before removal.
    Bun.spawnSync(["chmod", "-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function profileJson(id: string): string {
  const agents = Object.fromEntries(Object.entries(PROFILES[id]!).map(([agent, value]) => [agent, value]));
  return `${JSON.stringify({ id, description: `The ${id} profile.`, agents }, null, 2)}\n`;
}

/** Write one platform folder of a fixture dist, with files.txt listing every file. */
function writePlatform(dist: string, platform: "v1" | "v2", extra: string[] = []): void {
  const root = path.join(dist, `opencode-${platform}`);
  const files: string[] = [];
  const put = (rel: string, content: string) => {
    write(path.join(root, rel), content);
    files.push(rel);
  };
  for (const rel of [...MARKDOWN, ...extra]) {
    put(rel, `---\n${MARKER_MD}\ndescription: ${rel} for opencode ${platform}\n---\n\nBody of ${rel}.\n`);
  }
  put(`plugins/${NAME}.js`, `${MARKER_JS}\nexport default { id: "${NAME}" };\n`);
  for (const id of Object.keys(PROFILES)) put(`${NAME}/profiles/${id}.json`, profileJson(id));
  put(`${NAME}/schema.json`, '{\n  "type": "object"\n}\n');
  files.push(`${NAME}/files.txt`);
  write(path.join(root, NAME, "files.txt"), `${[...files].sort().join("\n")}\n`);
}

/** A fake opencode command: prints a version, a model list and canned debug output. */
function fakeOpencode(file: string, version: string): void {
  write(
    file,
    `#!/bin/sh
case "$1" in
  --version) printf '%s\\n' '${version}' ;;
  models) printf '%s\\n' anthropic/claude-opus-5-5 anthropic/claude-sonnet-5-5 ;;
  debug)
    case "$2" in
      agent) printf '%s\\n' '{"name":"lead","model":{"providerID":"anthropic","modelID":"claude-opus-5-5"},"prompt":"You are lead.\\nReview policy: auto\\n"}' ;;
      config) printf '%s\\n' '{"default_agent":"lead"}' ;;
    esac ;;
esac
`,
  );
  chmodSync(file, 0o755);
}

function makeBox(versions: { opencode?: string; opencode2?: string } = { opencode: "1.18.35" }): Box {
  const dir = mkdtempSync(path.join(tmpdir(), "install-test-"));
  boxes.push(dir);
  const box: Box = {
    dir,
    home: path.join(dir, "home"),
    config: path.join(dir, "home", ".config", "opencode"),
    bin: path.join(dir, "bin"),
    dist: path.join(dir, "dist"),
  };
  mkdirSync(box.home, { recursive: true });
  mkdirSync(box.bin, { recursive: true });
  writePlatform(box.dist, "v1");
  writePlatform(box.dist, "v2");
  if (versions.opencode) fakeOpencode(path.join(box.bin, "opencode"), versions.opencode);
  if (versions.opencode2) fakeOpencode(path.join(box.bin, "opencode2"), versions.opencode2);
  return box;
}

function run(box: Box, args: string[], cwd = box.dir, extra: Record<string, string> = {}): { code: number; out: string } {
  const env: Record<string, string> = {
    HOME: box.home,
    XDG_CONFIG_HOME: path.join(box.home, ".config"),
    PATH: `${box.bin}:${SYSTEM_PATH}`,
    TMPDIR: box.dir,
    ECMWF_MULTI_AGENTS_DIST: box.dist,
    LC_ALL: "C",
    ...extra,
  };
  const result = Bun.spawnSync(["sh", INSTALL, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
}

/** Every path under a folder, sorted, with links marked "->" and their targets. */
function listing(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const rel = path.relative(root, full);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) out.push(`${rel} -> ${readlinkSync(full)}`);
      else if (stat.isDirectory()) {
        out.push(`${rel}/`);
        walk(full);
      } else out.push(`${rel} (${readFileSync(full, "utf8").length})`);
    }
  };
  walk(root);
  return out;
}

function fileList(box: Box, platform: "v1" | "v2"): string[] {
  return readFileSync(path.join(box.dist, `opencode-${platform}`, NAME, "files.txt"), "utf8").trim().split("\n");
}

function settingsJson(file: string): Record<string, unknown> {
  const text = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("install", () => {
  test("a global install links every file into the dist and writes settings and a record", () => {
    const box = makeBox();
    const { code, out } = run(box, []);
    expect(code).toBe(0);
    expect(out).toContain("Done: 11 added, 0 updated, 0 unchanged, 0 removed.");
    for (const rel of fileList(box, "v1")) {
      const target = path.join(box.config, rel);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(readlinkSync(target)).toBe(path.join(box.dist, "opencode-v1", rel));
    }
    expect(settingsJson(path.join(box.config, `${NAME}.jsonc`))).toEqual({
      $schema: `./${NAME}/schema.json`,
      review: "auto",
      profile: "default",
    });
    const record = readFileSync(path.join(box.config, NAME, "installed.txt"), "utf8");
    expect(record).toContain("platform=v1\nmode=link\n");
    expect(record).toContain("file=agents/lead.md\n");
    expect(out).toContain("restart opencode");
  });

  test("the settings file takes --profile and --review", () => {
    const box = makeBox();
    expect(run(box, ["--profile", "anthropic", "--review", "always"]).code).toBe(0);
    expect(settingsJson(path.join(box.config, `${NAME}.jsonc`))).toMatchObject({ review: "always", profile: "anthropic" });
  });

  test("re-running changes nothing", () => {
    const box = makeBox();
    run(box, []);
    const before = listing(box.config);
    const { code, out } = run(box, []);
    expect(code).toBe(0);
    expect(out).toContain("Done: 0 added, 0 updated, 11 unchanged, 0 removed.");
    expect(listing(box.config)).toEqual(before);
  });

  test("a file dropped from the dist is removed on the next run, with its empty folder", () => {
    const box = makeBox();
    run(box, []);
    const dropped = `skills/${NAME}-plan/SKILL.md`;
    const v1 = path.join(box.dist, "opencode-v1");
    rmSync(path.join(v1, dropped));
    const files = fileList(box, "v1").filter((rel) => rel !== dropped);
    writeFileSync(path.join(v1, NAME, "files.txt"), `${files.join("\n")}\n`);
    const { code, out } = run(box, []);
    expect(code).toBe(0);
    expect(out).toContain("1 removed.");
    expect(existsSync(path.join(box.config, `skills/${NAME}-plan`))).toBe(false);
    expect(readFileSync(path.join(box.config, NAME, "installed.txt"), "utf8")).not.toContain(dropped);
  });

  test("a new dist file is added on the next run", () => {
    const box = makeBox();
    run(box, []);
    writePlatform(box.dist, "v1", ["agents/extra.md"]);
    const { code, out } = run(box, []);
    expect(code).toBe(0);
    expect(out).toContain("Done: 1 added, 0 updated, 11 unchanged, 0 removed.");
    expect(lstatSync(path.join(box.config, "agents/extra.md")).isSymbolicLink()).toBe(true);
  });

  test("a file that is not ours is left alone and reported, the rest is installed, exit 1", () => {
    const box = makeBox();
    write(path.join(box.config, "commands/plan.md"), "my own plan command\n");
    const { code, out } = run(box, []);
    expect(code).toBe(1);
    expect(out).toContain(path.join(box.config, "commands/plan.md"));
    expect(out).toContain("not from ecmwf-multi-agents");
    expect(readFileSync(path.join(box.config, "commands/plan.md"), "utf8")).toBe("my own plan command\n");
    expect(lstatSync(path.join(box.config, "agents/lead.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(box.config, NAME, "installed.txt"), "utf8")).not.toContain("commands/plan.md");
  });

  test("a copied file with the marker is ours and gets replaced", () => {
    const box = makeBox();
    write(path.join(box.config, "agents/lead.md"), `---\n${MARKER_MD}\ndescription: old\n---\n\nOld body.\n`);
    const { code, out } = run(box, []);
    expect(code).toBe(0);
    expect(out).toContain("10 added, 1 updated");
    expect(lstatSync(path.join(box.config, "agents/lead.md")).isSymbolicLink()).toBe(true);
  });

  test("an existing settings file is never changed", () => {
    const box = makeBox();
    write(path.join(box.config, `${NAME}.jsonc`), '{ "review": "never" }\n');
    const { code, out } = run(box, ["--profile", "anthropic"]);
    expect(code).toBe(0);
    expect(readFileSync(path.join(box.config, `${NAME}.jsonc`), "utf8")).toBe('{ "review": "never" }\n');
    expect(out).toContain('"profile": "anthropic"');
  });

  test("invalid values are rejected before anything is installed", () => {
    const box = makeBox();
    const review = run(box, ["--review", "sometimes"]);
    expect(review.code).toBe(1);
    expect(review.out).toContain("--review must be auto, ask, always or never");
    const profile = run(box, ["--profile", "nope"]);
    expect(profile.code).toBe(1);
    expect(profile.out).toContain("unknown profile: nope");
    expect(run(box, ["--bogus"]).out).toContain("unknown option: --bogus");
    expect(existsSync(box.config)).toBe(false);
  });

  test("--dry-run changes nothing, for install and uninstall", () => {
    const box = makeBox();
    const dry = run(box, ["--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("would add");
    expect(dry.out).toContain("Would do: 11 added");
    expect(existsSync(box.config)).toBe(false);
    run(box, []);
    const before = listing(box.config);
    const dryUninstall = run(box, ["uninstall", "--dry-run"]);
    expect(dryUninstall.code).toBe(0);
    expect(dryUninstall.out).toContain("would remove");
    expect(listing(box.config)).toEqual(before);
  });
});

describe("platform", () => {
  const linkedPlatform = (box: Box) => readlinkSync(path.join(box.config, "agents/lead.md")).includes("opencode-v2") ? "v2" : "v1";

  test("opencode 1.x alone gets the v1 files", () => {
    const box = makeBox({ opencode: "1.19.0" });
    expect(run(box, []).code).toBe(0);
    expect(linkedPlatform(box)).toBe("v1");
  });

  test("opencode 1.x and 2 together get the v1 files, which opencode 2 also reads", () => {
    const box = makeBox({ opencode: "1.18.35", opencode2: "opencode v2.0.16" });
    expect(run(box, []).code).toBe(0);
    expect(linkedPlatform(box)).toBe("v1");
  });

  test("opencode 2 alone gets the v2 files", () => {
    const box = makeBox({ opencode: "opencode v2.0.16", opencode2: "opencode v2.0.16" });
    const { code, out } = run(box, []);
    expect(code).toBe(0);
    expect(linkedPlatform(box)).toBe("v2");
    expect(out).not.toContain("Warning");
  });

  test("an untested opencode 2 version gets a warning", () => {
    const box = makeBox({ opencode2: "opencode v2.0.20" });
    const { code, out } = run(box, []);
    expect(code).toBe(0);
    expect(out).toContain("tested with opencode 2.0.16");
  });

  test("no opencode at all stops with advice", () => {
    const box = makeBox({});
    const { code, out } = run(box, []);
    expect(code).toBe(1);
    expect(out).toContain("opencode was not found");
  });

  test("--platform v2 next to opencode 1.x warns about the missing safety rules", () => {
    const box = makeBox({ opencode: "1.18.35" });
    const { code, out } = run(box, ["--platform", "v2"]);
    expect(code).toBe(0);
    expect(out).toContain("without their safety rules");
    expect(linkedPlatform(box)).toBe("v2");
  });
});

describe("project and central installs", () => {
  test("a project install copies into .opencode, and writes settings only when asked", () => {
    const box = makeBox();
    const project = path.join(box.dir, "my project");
    mkdirSync(project);
    const plain = run(box, ["--project", project]);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain("files copied");
    const lead = path.join(project, ".opencode/agents/lead.md");
    expect(lstatSync(lead).isFile()).toBe(true);
    expect(readFileSync(lead, "utf8")).toContain(MARKER_MD);
    expect(existsSync(path.join(project, `.opencode/${NAME}.jsonc`))).toBe(false);
    expect(readFileSync(path.join(project, `.opencode/${NAME}/installed.txt`), "utf8")).not.toContain("dist=");

    const withReview = run(box, ["--project", project, "--review", "never"]);
    expect(withReview.code).toBe(0);
    expect(settingsJson(path.join(project, `.opencode/${NAME}.jsonc`))).toEqual({ $schema: `./${NAME}/schema.json`, review: "never" });
  });

  test("a project install refreshes copies that are older than the dist", () => {
    const box = makeBox();
    const project = path.join(box.dir, "proj");
    mkdirSync(project);
    run(box, ["--project", project]);
    write(path.join(box.dist, "opencode-v1/agents/lead.md"), `---\n${MARKER_MD}\ndescription: newer\n---\n\nNew body.\n`);
    const { out } = run(box, ["--project", project]);
    expect(out).toContain("0 added, 1 updated");
    expect(readFileSync(path.join(project, ".opencode/agents/lead.md"), "utf8")).toContain("New body.");
  });

  test("--central copies into the given folder and writes site settings only when asked", () => {
    const box = makeBox();
    const central = path.join(box.dir, "central");
    const { code, out } = run(box, ["--central", central, "--review", "always"]);
    expect(code).toBe(0);
    expect(lstatSync(path.join(central, "agents/lead.md")).isFile()).toBe(true);
    expect(settingsJson(path.join(central, `${NAME}.jsonc`))).toEqual({ $schema: `./${NAME}/schema.json`, review: "always" });
    expect(out).toContain(`OPENCODE_CONFIG_DIR=${central}`);
  });

  test("--central needs opencode 1.x", () => {
    const box = makeBox({ opencode2: "opencode v2.0.16" });
    const { code, out } = run(box, ["--central", path.join(box.dir, "central")]);
    expect(code).toBe(1);
    expect(out).toContain("opencode 1.x only");
  });
});

describe("uninstall", () => {
  test("removes our files, keeps foreign files and the settings file", () => {
    const box = makeBox();
    run(box, []);
    write(path.join(box.config, "agents/mine.md"), "my agent\n");
    const { code, out } = run(box, ["uninstall"]);
    expect(code).toBe(0);
    expect(out).toContain("Done: 11 files removed.");
    expect(listing(box.config)).toEqual(["agents/", "agents/mine.md (9)", `${NAME}.jsonc (${readFileSync(path.join(box.config, `${NAME}.jsonc`), "utf8").length})`]);
  });

  test("--purge also removes the settings file", () => {
    const box = makeBox();
    run(box, []);
    expect(run(box, ["uninstall", "--purge"]).code).toBe(0);
    expect(listing(box.config)).toEqual([]);
  });

  test("a project uninstall removes the copies", () => {
    const box = makeBox();
    const project = path.join(box.dir, "proj");
    mkdirSync(project);
    run(box, ["--project", project, "--profile", "anthropic"]);
    expect(run(box, ["uninstall", "--project", project, "--purge"]).code).toBe(0);
    expect(listing(path.join(project, ".opencode"))).toEqual([]);
  });

  test("--purge is only for uninstall", () => {
    const box = makeBox();
    expect(run(box, ["--purge"]).out).toContain("--purge only works with uninstall");
  });
});

describe("background helpers on opencode 1.x", () => {
  const FLAG = "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS";

  test("an install for opencode 1.x says how to turn them on, unless they already are", () => {
    const box = makeBox({ opencode: "1.18.35" });
    const { code, out } = run(box, []);
    expect(code).toBe(0);
    expect(out).toContain(`  export ${FLAG}=true`);
    expect(out).toContain("Without it, lead waits for every helper");
    const again = run(box, [], box.dir, { [FLAG]: "true" });
    expect(again.out).toContain(`Background helpers are on (${FLAG} is set)`);
    expect(again.out).not.toContain(`export ${FLAG}`);
  });

  test("a central install gives the module file forms", () => {
    const box = makeBox({ opencode: "1.18.35" });
    const { out } = run(box, ["--central", path.join(box.dir, "shared")]);
    expect(out).toContain(`Lmod:      setenv("${FLAG}", "true")`);
    expect(out).toContain(`Tcl:       setenv ${FLAG} true`);
  });

  test("an install for opencode 2 says nothing about the flag", () => {
    const box = makeBox({ opencode2: "opencode v2.0.16" });
    const { out } = run(box, []);
    expect(out).not.toContain(FLAG);
  });

  test("doctor warns when they are off and is satisfied by the flag or opencode's blanket experimental flag", () => {
    const box = makeBox({ opencode: "1.18.35" });
    run(box, []);
    expect(run(box, ["doctor"]).out).toContain("WARN  background helpers are off: lead waits for every helper");
    expect(run(box, ["doctor"], box.dir, { [FLAG]: "true" }).out).toContain(`OK    background helpers are on (${FLAG})`);
    expect(run(box, ["doctor"], box.dir, { [FLAG]: "1" }).out).toContain("OK    background helpers are on");
    expect(run(box, ["doctor"], box.dir, { OPENCODE_EXPERIMENTAL: "true" }).out).toContain("OK    background helpers are on");
    expect(run(box, ["doctor"], box.dir, { [FLAG]: "false" }).out).toContain("WARN  background helpers are off");
    // An explicit value wins over the blanket flag, as it does in opencode.
    expect(run(box, ["doctor"], box.dir, { [FLAG]: "false", OPENCODE_EXPERIMENTAL: "true" }).out).toContain("WARN  background helpers are off");
    expect(run(box, ["doctor"], box.dir, { [FLAG]: "on" }).out).toContain("OK    background helpers are on");
    // Set but empty is an explicit value too, and it is not true.
    expect(run(box, ["doctor"], box.dir, { [FLAG]: "", OPENCODE_EXPERIMENTAL: "true" }).out).toContain("WARN  background helpers are off");
  });
});

describe("doctor", () => {
  test("passes on a good install, with a warning for the model that is not available", () => {
    const box = makeBox();
    run(box, []);
    const { code, out } = run(box, ["doctor"]);
    expect(code).toBe(0);
    expect(out).toContain("OK    opencode 1.18.35");
    expect(out).toContain("OK    11 files installed for opencode v1 (link)");
    expect(out).toContain("WARN  profile default: not available: github-copilot/gpt-6.1-sol");
    expect(out).toContain("OK    opencode loads the lead agent");
    expect(out).toContain("OK    opencode starts on lead");
  });

  test("reports that the plugin is not active when lead ignores the review setting", () => {
    const box = makeBox();
    run(box, ["--review", "always"]);
    const { code, out } = run(box, ["doctor"]);
    expect(code).toBe(0);
    expect(out).toContain("the plugin is not active");
  });

  test("fails on a broken link and on a missing file", () => {
    const box = makeBox();
    run(box, []);
    rmSync(path.join(box.dist, "opencode-v1/agents/scout.md"));
    rmSync(path.join(box.config, "commands/plan.md"));
    const { code, out } = run(box, ["doctor"]);
    expect(code).toBe(1);
    expect(out).toContain(`FAIL  broken link: ${path.join(box.config, "agents/scout.md")}`);
    expect(out).toContain(`FAIL  missing: ${path.join(box.config, "commands/plan.md")}`);
  });

  test("fails on an invalid review value in the settings file", () => {
    const box = makeBox();
    run(box, []);
    write(path.join(box.config, `${NAME}.jsonc`), '{\n  "review": "sometimes"\n}\n');
    const { code, out } = run(box, ["doctor"]);
    expect(code).toBe(1);
    expect(out).toContain('review is "sometimes"');
  });

  test("fails when nothing is installed", () => {
    const box = makeBox();
    const { code, out } = run(box, ["doctor"]);
    expect(code).toBe(1);
    expect(out).toContain("is not installed here");
  });

  test("on opencode 2 says the agents cannot be checked from the shell", () => {
    const box = makeBox({ opencode2: "opencode v2.0.16" });
    run(box, []);
    const { code, out } = run(box, ["doctor"]);
    expect(code).toBe(0);
    expect(out).toContain("agents cannot be checked from the shell");
  });
});

test("install.sh passes shellcheck", () => {
  const shellcheck = Bun.which("shellcheck");
  if (!shellcheck) {
    console.warn("shellcheck is not installed; skipping");
    return;
  }
  const result = Bun.spawnSync([shellcheck, "-s", "sh", INSTALL], { stdout: "pipe", stderr: "pipe" });
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
