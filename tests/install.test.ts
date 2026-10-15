// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Fast tests for install.sh. Each test builds a fixture dist folder and fake `opencode` and
// `opencode2` commands in a temporary folder, points HOME and XDG_CONFIG_HOME there, and runs
// the installer. No real opencode, user configuration or network is involved.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");
const INSTALL = path.join(REPO, "install.sh");
const NAME = "ecmwf-multi-agents";
const MARKER_MD = `# managed by ${NAME}`;
const MARKER_JS = `// managed by ${NAME}`;
/** The opencode 2 version the installer is tested with, read from install.sh so the two never drift. */
const V2_PINNED = /^V2_PINNED=(\S+)$/m.exec(readFileSync(INSTALL, "utf8"))![1]!;
const PLUGIN = `plugins/${NAME}`;
const NPM = "@ecmwf.int/multi-agents";

/** What the plugin's RPC answers `doctor` with when all is well (see plugin/rpc.ts). */
const GOOD_DOCTOR = {
  output: {
    name: NAME,
    version: "9.9.9",
    defaultAgent: "lead",
    leadLoaded: true,
    leadDefinition: "harness",
    leadChanged: [],
    leadCandidateFiles: [],
    leadConfigFiles: [],
    reviewLine: "Review policy: auto",
    leadModel: "anthropic/claude-opus-5-5#xhigh",
    settings: { review: "auto", profile: "default", default_agent: true, agents: {} },
    settingsFiles: [],
    settingsSources: {},
    problems: [],
    plugins: [{ id: NAME, status: "active" }],
  },
};
const UNAVAILABLE = { type: "rpc.unavailable", message: `RPC is unavailable: ${NAME}` };

/**
 * The system's commands without any opencode, so a real opencode on the developer's machine,
 * even one in /usr/bin, is never found: one folder of links to everything else in the system
 * folders.
 */
const SYSTEM_BIN = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "install-test-system-"));
  const linked = new Set<string>();
  for (const folder of ["/usr/local/bin", "/usr/bin", "/bin"]) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) {
      if (name.startsWith("opencode") || linked.has(name)) continue;
      linked.add(name);
      symlinkSync(path.join(folder, name), path.join(dir, name));
    }
  }
  return dir;
})();

afterAll(() => rmSync(SYSTEM_BIN, { recursive: true, force: true }));

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

const PLACEHOLDER = "@ECMWF_MULTI_AGENTS_DIR@";
const CENTRAL_TEMPLATE = {
  agents: { lead: { description: "Lead.", mode: "primary", hidden: false, permissions: [], system: "{file:./prompts/lead.md}" } },
  commands: { plan: { description: "Plan.", agent: "lead", template: "{file:./prompts/commands/plan.md}" } },
  skills: [`${PLACEHOLDER}/skills`],
  plugins: [{ package: `${PLACEHOLDER}/plugins/${NAME}`, options: { site: `${PLACEHOLDER}/${NAME}.jsonc` } }],
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
    // A central install is read-only.
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

/**
 * Write the opencode-v2 folder of a fixture dist, with files.txt listing every file; "v1" writes
 * the folder an install for opencode 1 linked to.
 */
function writePlatform(dist: string, platform: "v1" | "v2" = "v2", extra: string[] = []): void {
  const root = path.join(dist, `opencode-${platform}`);
  const files: string[] = [];
  const put = (rel: string, content: string) => {
    write(path.join(root, rel), content);
    files.push(rel);
  };
  for (const rel of [...MARKDOWN, ...extra]) {
    put(rel, `---\n${MARKER_MD}\ndescription: ${rel} for opencode ${platform}\n---\n\nBody of ${rel}.\n`);
  }
  if (platform === "v1") put(`plugins/${NAME}.js`, `${MARKER_JS}\nexport default { id: "${NAME}" };\n`);
  else {
    put(`${PLUGIN}/index.js`, `${MARKER_JS}\nexport default { id: "${NAME}" };\n`);
    put(`${PLUGIN}/tui.js`, `${MARKER_JS}\nexport default { id: "${NAME}" };\n`);
  }
  for (const id of Object.keys(PROFILES)) put(`${NAME}/profiles/${id}.json`, profileJson(id));
  put(`${NAME}/schema.json`, '{\n  "type": "object"\n}\n');
  files.push(`${NAME}/files.txt`);
  // The central install's template, which files.txt does not list.
  if (platform === "v2") {
    write(path.join(root, "central", "opencode.json"), `${JSON.stringify(CENTRAL_TEMPLATE, null, 2)}\n`);
    write(path.join(root, "central", "prompts", "lead.md"), "Lead prompt.\n");
    write(path.join(root, "central", "prompts", "commands", "plan.md"), "Plan: $ARGUMENTS\n");
  }
  write(path.join(root, NAME, "files.txt"), `${[...files].sort().join("\n")}\n`);
}

/**
 * A fake opencode command: prints a version and a model list, and answers `opencode api` with
 * the file rpc.json next to its folder (exit code in rpc.exit), or with a good doctor report.
 * Each api call is logged to api.log with the folder it ran in, and its OPENCODE_CONFIG to
 * api-env.log. `service` keeps OPENCODE_CONFIG in service-env and reads the port from
 * service-port; each service call is logged to service.log.
 */
function fakeOpencode(file: string, version: string): void {
  const box = path.dirname(path.dirname(file));
  write(
    file,
    `#!/bin/sh
case "$1" in
  --version) printf '%s\\n' '${version}' ;;
  models) printf '%s\\n' anthropic/claude-opus-5-5 anthropic/claude-sonnet-5-5 ;;
  api)
    printf '%s | %s\\n' "$(pwd)" "$*" >>'${box}/api.log'
    printf '%s\\n' "\${OPENCODE_CONFIG-}" >>'${box}/api-env.log'
    if [ -f '${box}/rpc.json' ]; then cat '${box}/rpc.json'; exit "$(cat '${box}/rpc.exit' 2>/dev/null || echo 0)"; fi
    printf '%s\\n' '${JSON.stringify(GOOD_DOCTOR)}'
    ;;
  service)
    printf '%s\\n' "$*" >>'${box}/service.log'
    case "$2 $3" in
      "get env") cat '${box}/service-env' 2>/dev/null; printf '\\n' ;;
      "get port") cat '${box}/service-port' 2>/dev/null; printf '\\n' ;;
      "get disabled") printf 'false\\n' ;;
      "set env") printf '%s' "$5" >'${box}/service-env' ;;
      "unset env") rm -f '${box}/service-env' ;;
    esac
    ;;
esac
`,
  );
  chmodSync(file, 0o755);
}

/** What the fake opencode answers to the RPC. */
function answer(box: Box, body: unknown, exit = 0): void {
  writeFileSync(path.join(box.dir, "rpc.json"), `${JSON.stringify(body)}\n`);
  writeFileSync(path.join(box.dir, "rpc.exit"), `${exit}\n`);
}

function makeBox(versions: { opencode?: string; opencode2?: string } = { opencode: `opencode v${V2_PINNED}`, opencode2: `opencode v${V2_PINNED}` }): Box {
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
  writePlatform(box.dist);
  if (versions.opencode) fakeOpencode(path.join(box.bin, "opencode"), versions.opencode);
  if (versions.opencode2) fakeOpencode(path.join(box.bin, "opencode2"), versions.opencode2);
  return box;
}

function run(box: Box, args: string[], cwd = box.dir, extra: Record<string, string> = {}): { code: number; out: string } {
  const env: Record<string, string> = {
    HOME: box.home,
    XDG_CONFIG_HOME: path.join(box.home, ".config"),
    PATH: `${box.bin}:${SYSTEM_BIN}`,
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

function fileList(box: Box): string[] {
  return readFileSync(path.join(box.dist, "opencode-v2", NAME, "files.txt"), "utf8").trim().split("\n");
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
    expect(out).toContain("Done: 12 added, 0 updated, 0 unchanged, 0 removed.");
    for (const rel of fileList(box)) {
      // The plugin folder is linked as a whole: opencode loads it only when its entry's real path is inside it.
      const linked = rel.startsWith(`${PLUGIN}/`) ? PLUGIN : rel;
      const target = path.join(box.config, linked);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(readlinkSync(target)).toBe(path.join(box.dist, "opencode-v2", linked));
    }
    expect(settingsJson(path.join(box.config, `${NAME}.jsonc`))).toEqual({
      $schema: `./${NAME}/schema.json`,
      review: "auto",
      profile: "default",
    });
    const record = readFileSync(path.join(box.config, NAME, "installed.txt"), "utf8");
    expect(record).toContain("platform=v2\nmode=link\n");
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
    expect(out).toContain("Done: 0 added, 0 updated, 12 unchanged, 0 removed.");
    expect(listing(box.config)).toEqual(before);
  });

  test("a file dropped from the dist is removed on the next run, with its empty folder", () => {
    const box = makeBox();
    run(box, []);
    const dropped = `skills/${NAME}-plan/SKILL.md`;
    const v2 = path.join(box.dist, "opencode-v2");
    rmSync(path.join(v2, dropped));
    const files = fileList(box).filter((rel) => rel !== dropped);
    writeFileSync(path.join(v2, NAME, "files.txt"), `${files.join("\n")}\n`);
    const { code, out } = run(box, []);
    expect(code).toBe(0);
    expect(out).toContain("1 removed.");
    expect(existsSync(path.join(box.config, `skills/${NAME}-plan`))).toBe(false);
    expect(readFileSync(path.join(box.config, NAME, "installed.txt"), "utf8")).not.toContain(dropped);
  });

  test("a new dist file is added on the next run", () => {
    const box = makeBox();
    run(box, []);
    writePlatform(box.dist, "v2", ["agents/extra.md"]);
    const { code, out } = run(box, []);
    expect(code).toBe(0);
    expect(out).toContain("Done: 1 added, 0 updated, 12 unchanged, 0 removed.");
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
    expect(out).toContain("11 added, 1 updated");
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

  test("an empty value is refused, also after =, instead of falling back to a global install", () => {
    const box = makeBox();
    for (const option of ["--project", "--central", "--profile", "--review"]) {
      for (const args of [[`${option}=`], [option, ""], ["uninstall", `${option}=`]]) {
        const { code, out } = run(box, args);
        expect(code).toBe(1);
        expect(out).toContain(`Error: ${option} needs a value (see ${INSTALL} --help)`);
      }
    }
    expect(existsSync(box.config)).toBe(false);
  });

  test("messages name the command that was run: its path, or the npm package's command", () => {
    const box = makeBox();
    expect(run(box, ["--bogus"]).out).toContain(`unknown option: --bogus (see ${INSTALL} --help)`);
    expect(run(box, []).out).toContain(`run ${INSTALL} doctor to check the installation`);
    rmSync(box.config, { recursive: true, force: true });
    const npm = run(box, ["doctor"], box.dir, { ECMWF_MULTI_AGENTS_COMMAND: "ecmwf-multi-agents" });
    expect(npm.out).toContain("is missing); run ecmwf-multi-agents\n");
    const help = run(box, ["--help"], box.dir, { ECMWF_MULTI_AGENTS_COMMAND: "ecmwf-multi-agents" }).out;
    expect(help).toStartWith("Usage: ecmwf-multi-agents [command] [options]");
    expect(help).not.toContain("install.sh");
    // Run by its name in the current folder.
    const bare = Bun.spawnSync(["sh", "install.sh", "--bogus"], { cwd: REPO, env: { PATH: SYSTEM_BIN, HOME: box.home }, stderr: "pipe" });
    expect(bare.stderr.toString()).toContain("(see sh install.sh --help)");
  });

  test("--dry-run changes nothing, for install and uninstall", () => {
    const box = makeBox();
    const dry = run(box, ["--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("would add");
    expect(dry.out).toContain("Would do: 12 added");
    expect(existsSync(box.config)).toBe(false);
    run(box, []);
    const before = listing(box.config);
    const dryUninstall = run(box, ["uninstall", "--dry-run"]);
    expect(dryUninstall.code).toBe(0);
    expect(dryUninstall.out).toContain("would remove");
    expect(listing(box.config)).toEqual(before);
  });
});

describe("opencode versions", () => {
  test("opencode 2 as opencode, or as opencode2 alone, gets the files without a warning", () => {
    for (const versions of [{ opencode: `opencode v${V2_PINNED}` }, { opencode2: `opencode v${V2_PINNED}` }]) {
      const box = makeBox(versions);
      const { code, out } = run(box, []);
      expect(code).toBe(0);
      expect(out).toContain("for opencode 2");
      expect(out).not.toContain("Warning");
      expect(readlinkSync(path.join(box.config, "agents/lead.md"))).toContain("opencode-v2");
    }
  });

  test("an old opencode next to opencode2 is passed over", () => {
    const box = makeBox({ opencode: "1.18.35", opencode2: `opencode v${V2_PINNED}` });
    const { code, out } = run(box, []);
    expect(code).toBe(0);
    expect(out).not.toContain("Warning");
    expect(run(box, ["doctor"]).out).toContain(`OK    opencode ${V2_PINNED}`);
  });

  test("an untested opencode 2 version gets a warning", () => {
    const box = makeBox({ opencode2: "opencode v2.0.20" });
    const { code, out } = run(box, []);
    expect(code).toBe(0);
    expect(out).toContain(`tested with opencode ${V2_PINNED}`);
  });

  test("no opencode at all stops with advice", () => {
    const box = makeBox({});
    const { code, out } = run(box, []);
    expect(code).toBe(1);
    expect(out).toContain("opencode was not found. Install opencode 2 first");
    expect(existsSync(box.config)).toBe(false);
  });

  test("only opencode 1 is refused with the upgrade command, and nothing is installed", () => {
    const box = makeBox({ opencode: "1.19.0" });
    const { code, out } = run(box, []);
    expect(code).toBe(1);
    expect(out).toContain('opencode 1.19.0 was found, but this harness needs opencode 2: upgrade with "opencode upgrade --major"');
    expect(existsSync(box.config)).toBe(false);
    expect(run(box, ["doctor"]).out).toContain('FAIL  opencode 1.19.0: this harness needs opencode 2: upgrade with "opencode upgrade --major"');
  });

  test("--platform is gone", () => {
    const box = makeBox();
    expect(run(box, ["--platform", "v1"]).out).toContain("unknown option: --platform");
  });
});

describe("an install for opencode 1", () => {
  /** What an install for opencode 1 left: links into dist/opencode-v1, one file only it had, and its record. */
  function oldInstall(box: Box): void {
    writePlatform(box.dist, "v1", ["commands/old.md"]);
    const files = readFileSync(path.join(box.dist, "opencode-v1", NAME, "files.txt"), "utf8").trim().split("\n");
    for (const rel of files) {
      mkdirSync(path.dirname(path.join(box.config, rel)), { recursive: true });
      symlinkSync(path.join(box.dist, "opencode-v1", rel), path.join(box.config, rel));
    }
    const record = ["# record", "platform=v1", "mode=link", `dist=${box.dist}`, ...files.map((rel) => `file=${rel}`)];
    write(path.join(box.config, NAME, "installed.txt"), `${record.join("\n")}\n`);
    // A checkout updated since has no opencode-v1 folder, so the old links are broken.
    rmSync(path.join(box.dist, "opencode-v1"), { recursive: true });
  }

  test("doctor says it needs replacing", () => {
    const box = makeBox();
    oldInstall(box);
    const { code, out } = run(box, ["doctor"]);
    expect(code).toBe(1);
    expect(out).toContain(`FAIL  the files installed here are for opencode 1, which is no longer supported; run ${INSTALL} to install the opencode 2 files`);
  });

  test("running the installer again replaces it with the opencode 2 files", () => {
    const box = makeBox();
    oldInstall(box);
    const { code, out } = run(box, []);
    expect(code).toBe(0);
    expect(out).toContain("are for opencode 1, which is no longer supported; they are replaced");
    expect(out).toContain("Done: 2 added, 10 updated, 0 unchanged, 2 removed.");
    expect(existsSync(path.join(box.config, "commands/old.md"))).toBe(false);
    for (const rel of fileList(box).filter((rel) => !rel.startsWith(`${PLUGIN}/`))) expect(readlinkSync(path.join(box.config, rel))).toBe(path.join(box.dist, "opencode-v2", rel));
    expect(readlinkSync(path.join(box.config, PLUGIN))).toBe(path.join(box.dist, "opencode-v2", PLUGIN));
    expect(existsSync(path.join(box.config, `plugins/${NAME}.js`))).toBe(false);
    expect(readFileSync(path.join(box.config, NAME, "installed.txt"), "utf8")).toContain("platform=v2\n");
    expect(run(box, ["doctor"]).code).toBe(0);
  });
});

describe("project installs", () => {
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
    write(path.join(box.dist, "opencode-v2/agents/lead.md"), `---\n${MARKER_MD}\ndescription: newer\n---\n\nNew body.\n`);
    const { out } = run(box, ["--project", project]);
    expect(out).toContain("0 added, 1 updated");
    expect(readFileSync(path.join(project, ".opencode/agents/lead.md"), "utf8")).toContain("New body.");
  });
});

describe("uninstall", () => {
  test("removes our files, keeps foreign files and the settings file", () => {
    const box = makeBox();
    run(box, []);
    write(path.join(box.config, "agents/mine.md"), "my agent\n");
    const { code, out } = run(box, ["uninstall"]);
    expect(code).toBe(0);
    expect(out).toContain("Done: 12 files removed.");
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

describe("doctor", () => {
  test("passes on a good install, with a warning for the model that is not available", () => {
    const box = makeBox();
    run(box, []);
    const { code, out } = run(box, ["doctor"]);
    expect(code).toBe(0);
    expect(out).toContain(`OK    opencode ${V2_PINNED}`);
    expect(out).toContain("OK    12 files installed (link)");
    expect(out).toContain("WARN  profile default: not available: github-copilot/gpt-6.1-sol");
    expect(out).toContain("OK    lead is the harness's, with the plugin 9.9.9 active");
    expect(out).toContain("OK    lead's Review policy: auto");
    expect(out).toContain("OK    lead is the default agent");
  });

  test("fails on a broken link and on a missing file", () => {
    const box = makeBox();
    run(box, []);
    rmSync(path.join(box.dist, "opencode-v2/agents/scout.md"));
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
});

describe("the plugin folder", () => {
  test("a link install links the folder; uninstall removes the link and leaves the checkout's files", () => {
    const box = makeBox();
    expect(run(box, []).code).toBe(0);
    expect(readlinkSync(path.join(box.config, PLUGIN))).toBe(path.join(box.dist, "opencode-v2", PLUGIN));
    expect(run(box, ["uninstall"]).code).toBe(0);
    expect(existsSync(path.join(box.config, "plugins"))).toBe(false);
    expect(existsSync(path.join(box.dist, "opencode-v2", PLUGIN, "index.js"))).toBe(true);
    expect(existsSync(path.join(box.dist, "opencode-v2", PLUGIN, "tui.js"))).toBe(true);
  });

  test("a copy install copies the folder, and a later link install replaces the copy with the link", () => {
    const box = makeBox();
    expect(run(box, ["--copy"]).code).toBe(0);
    expect(lstatSync(path.join(box.config, PLUGIN)).isDirectory()).toBe(true);
    expect(lstatSync(path.join(box.config, PLUGIN, "index.js")).isFile()).toBe(true);
    const linked = run(box, ["--link"]);
    expect(linked.code).toBe(0);
    expect(readlinkSync(path.join(box.config, PLUGIN))).toBe(path.join(box.dist, "opencode-v2", PLUGIN));
    const copied = run(box, ["--copy"]);
    expect(copied.code).toBe(0);
    expect(lstatSync(path.join(box.config, PLUGIN)).isDirectory()).toBe(true);
    expect(existsSync(path.join(box.dist, "opencode-v2", PLUGIN, "index.js"))).toBe(true);
  });

  test("the single-file plugin of an earlier release is removed, even when no record names it", () => {
    const box = makeBox();
    run(box, []);
    symlinkSync(path.join(box.dist, "opencode-v2", `plugins/${NAME}.js`), path.join(box.config, `plugins/${NAME}.js`));
    const { code, out } = run(box, []);
    expect(code).toBe(0);
    expect(out).toContain("1 removed.");
    expect(existsSync(path.join(box.config, `plugins/${NAME}.js`))).toBe(false);
    expect(readlinkSync(path.join(box.config, PLUGIN))).toBe(path.join(box.dist, "opencode-v2", PLUGIN));
  });

  test("a stray file in a copied plugin folder keeps the plugin's files recorded, so uninstall still removes them", () => {
    const box = makeBox();
    expect(run(box, ["--copy"]).code).toBe(0);
    const stray = path.join(box.config, PLUGIN, "index.js~");
    write(stray, "an editor backup\n");
    const linked = run(box, ["--link"]);
    expect(linked.code).toBe(1);
    expect(linked.out).toContain(`not from ${NAME}:\n  ${path.join(box.config, PLUGIN)}\n`);
    const record = readFileSync(path.join(box.config, NAME, "installed.txt"), "utf8");
    expect(record).toContain(`file=${PLUGIN}/index.js\n`);
    expect(record).toContain(`file=${PLUGIN}/tui.js\n`);
    const removed = run(box, ["uninstall"]);
    expect(removed.code).toBe(0);
    expect(existsSync(path.join(box.config, PLUGIN, "index.js"))).toBe(false);
    expect(existsSync(path.join(box.config, PLUGIN, "tui.js"))).toBe(false);
    expect(removed.out).toContain(`Warning: left in place, because it is not from ${NAME}: ${stray}`);
    expect(readFileSync(stray, "utf8")).toBe("an editor backup\n");
  });

  test("a plugin folder that is not ours is left alone and reported", () => {
    const box = makeBox();
    write(path.join(box.config, PLUGIN, "index.js"), "export default {};\n");
    const { code, out } = run(box, []);
    expect(code).toBe(1);
    expect(out).toContain(path.join(box.config, PLUGIN));
    expect(readFileSync(path.join(box.config, PLUGIN, "index.js"), "utf8")).toBe("export default {};\n");
    expect(readFileSync(path.join(box.config, NAME, "installed.txt"), "utf8")).not.toContain(`${PLUGIN}/`);
  });
});

describe("doctor asks opencode through the plugin's RPC", () => {
  const apiLog = (box: Box) => readFileSync(path.join(box.dir, "api.log"), "utf8");

  test("from the folder it checks, with a private server", () => {
    const box = makeBox();
    run(box, []);
    const project = path.join(box.dir, "proj");
    mkdirSync(project);
    expect(run(box, ["doctor"], project).code).toBe(0);
    expect(apiLog(box).trim()).toBe(`${project} | api --standalone POST /api/rpc/${NAME}/doctor -d {"input":{}} -H x-opencode-directory:${project}`);
  });

  test("an unavailable RPC means the plugin is not active: FAIL with advice", () => {
    const box = makeBox();
    run(box, []);
    answer(box, UNAVAILABLE, 1);
    const { code, out } = run(box, ["doctor"]);
    expect(code).toBe(1);
    expect(out).toContain(`FAIL  the ${NAME} plugin is not active in ${box.dir}, so opencode has no lead there.`);
  });

  test("problems, another default agent, a lead.md that changes nothing, a changed lead, and no lead", () => {
    const box = makeBox();
    run(box, []);
    answer(box, {
      output: {
        ...GOOD_DOCTOR.output,
        defaultAgent: "build",
        leadCandidateFiles: ["/x/agents/lead.md"],
        problems: [
          { problem: `${NAME}: ignoring /x/${NAME}.jsonc: "review" must be auto, ask, always or never, not "often"`, notify: true },
          { problem: "second problem", notify: false },
        ],
      },
    });
    const { code, out } = run(box, ["doctor"]);
    expect(code).toBe(0);
    expect(out).toContain("OK    lead is the harness's, with the plugin 9.9.9 active");
    expect(out).toContain("WARN  the default agent is build, not lead");
    expect(out).toContain(`WARN  ${NAME}: ignoring /x/${NAME}.jsonc: "review" must be auto, ask, always or never, not "often"`);
    expect(out).toContain("WARN  second problem");
    answer(box, {
      output: {
        ...GOOD_DOCTOR.output,
        leadDefinition: "changed",
        leadChanged: ["system", "description"],
        leadCandidateFiles: ["/x/agents/lead.md", "/p/.opencode/agents/lead.md"],
        leadConfigFiles: ["/p/opencode.json"],
      },
    });
    const changed = run(box, ["doctor"]);
    expect(changed.code).toBe(0);
    expect(changed.out).toContain("WARN  lead was changed: system, description; it may come from: /x/agents/lead.md, /p/.opencode/agents/lead.md, /p/opencode.json\n");
    answer(box, { output: { ...GOOD_DOCTOR.output, leadDefinition: "changed", leadChanged: ["model"] } });
    expect(run(box, ["doctor"]).out).toContain(
      "WARN  lead was changed: model; no lead.md file or opencode config with a lead entry was found, so another plugin may have changed it",
    );
    answer(box, { output: { ...GOOD_DOCTOR.output, leadLoaded: false, leadDefinition: null, reviewLine: null } });
    const missing = run(box, ["doctor"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("FAIL  opencode has no lead in");
    expect(missing.out).toContain("WARN  lead's prompt has no \"Review policy:\" line");
  });

  test("a global install masks a project's plugins line: a warning", () => {
    const box = makeBox();
    run(box, []);
    const project = path.join(box.dir, "proj");
    write(path.join(project, "opencode.jsonc"), `{\n  // the harness\n  "plugins": [\n    "${NPM}@0.6.0",\n  ],\n}\n`);
    for (const args of [["doctor"], ["doctor", "--project", project]]) {
      const { code, out } = run(box, args, project);
      expect(code).toBe(0);
      expect(out).toContain(`WARN  the harness installed in ${box.config} masks the one named in ${path.join(project, "opencode.jsonc")} (${NPM}@0.6.0)`);
      expect(out).toContain("Duplicate plugin ID");
    }
  });
});

describe("doctor --project for a project switched on by a plugins line", () => {
  function project(box: Box, config: unknown, where = "opencode.json"): string {
    const dir = path.join(box.dir, "proj");
    write(path.join(dir, where), `${JSON.stringify(config)}\n`);
    return dir;
  }

  test("the npm package: opencode resolves it, the RPC answers", () => {
    const box = makeBox();
    const dir = project(box, { plugins: [`${NPM}@1.2.3`] });
    const { code, out } = run(box, ["doctor", "--project", dir]);
    expect(code).toBe(0);
    expect(out).toContain(`OK    switched on by the plugins line in ${path.join(dir, "opencode.json")}: ${NPM}@1.2.3`);
    expect(out).toContain("OK    lead is the harness's, with the plugin 9.9.9 active");
    expect(out).not.toContain("not installed");
  });

  test("a checkout, named with {env:HOME} or as a package entry in .opencode/opencode.json", () => {
    const box = makeBox();
    const checkout = path.join(box.home, ".local", "share", NAME);
    write(path.join(checkout, "package.json"), `{ "name": "${NPM}", "version": "1.0.0" }\n`);
    write(path.join(checkout, "server.js"), "export { default } from './x.js';\n");
    const dir = project(box, { plugins: [{ package: `{env:HOME}/.local/share/${NAME}`, options: {} }] }, ".opencode/opencode.json");
    const missing = run(box, ["doctor", "--project", dir]);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain(`FAIL  the checkout ${checkout} has no plugin folder`);
    write(path.join(checkout, "dist", "opencode-v2", PLUGIN, "index.js"), `${MARKER_JS}\n`);
    write(path.join(checkout, "dist", "opencode-v2", PLUGIN, "tui.js"), `${MARKER_JS}\n`);
    const { code, out } = run(box, ["doctor", "--project", dir]);
    expect(code).toBe(0);
    expect(out).toContain(`OK    the checkout ${checkout} has the plugin folder`);
  });

  test("a relative path to a checkout that is not one", () => {
    const box = makeBox();
    write(path.join(box.dir, NAME, "README.md"), "not a checkout\n");
    const dir = project(box, { plugins: [`../${NAME}`] });
    const { code, out } = run(box, ["doctor", "--project", dir]);
    expect(code).toBe(1);
    expect(out).toContain(`FAIL  ${path.join(dir, "..", NAME)} is not a checkout of ${NAME}`);
  });

  test("an opencode 1 \"plugin\" line, which opencode 2 still reads: switched on, with advice to rename the key", () => {
    const box = makeBox();
    const checkout = path.join(box.home, ".local", "share", NAME);
    write(path.join(checkout, "package.json"), `{ "name": "${NPM}", "version": "1.0.0" }\n`);
    write(path.join(checkout, "server.js"), "export { default } from './x.js';\n");
    write(path.join(checkout, "dist", "opencode-v2", PLUGIN, "index.js"), `${MARKER_JS}\n`);
    write(path.join(checkout, "dist", "opencode-v2", PLUGIN, "tui.js"), `${MARKER_JS}\n`);
    const dir = project(box, { $schema: "https://opencode.ai/config.json", plugin: [`{env:HOME}/.local/share/${NAME}`] });
    const { code, out } = run(box, ["doctor", "--project", dir]);
    expect(code).toBe(0);
    expect(out).toContain(`OK    switched on by the plugins line in ${path.join(dir, "opencode.json")}: {env:HOME}/.local/share/${NAME}`);
    expect(out).toContain(`WARN  ${path.join(dir, "opencode.json")} names the harness under "plugin", as opencode 1 did; opencode 2 still reads that key, but rename it to "plugins"`);
    expect(out).toContain(`OK    the checkout ${checkout} has the plugin folder`);
    expect(out).not.toContain("not switched on");
  });

  test("a line in a comment does not count, and a // inside a string is not a comment", () => {
    const box = makeBox();
    const dir = path.join(box.dir, "proj");
    write(
      path.join(dir, "opencode.jsonc"),
      `{\n  "$schema": "https://opencode.ai/config.json",\n  // "plugins": ["${NPM}"],\n  /* "plugin": ["${NPM}"], */\n  "plugins": ["some-other-plugin@1.0.0"]\n}\n`,
    );
    const commented = run(box, ["doctor", "--project", dir]);
    expect(commented.code).toBe(1);
    expect(commented.out).toContain(`FAIL  ${NAME} is not switched on here`);
    write(path.join(dir, "opencode.jsonc"), `{\n  "$schema": "https://opencode.ai/config.json", // the schema\n  "plugins": [\n    /* pinned */ "${NPM}@0.6.0", // the harness\n  ],\n}\n`);
    const { code, out } = run(box, ["doctor", "--project", dir]);
    expect(code).toBe(0);
    expect(out).toContain(`OK    switched on by the plugins line in ${path.join(dir, "opencode.jsonc")}: ${NPM}@0.6.0`);
    expect(out).not.toContain('under "plugin"');
  });

  test("no line and no files: not switched on", () => {
    const box = makeBox();
    const dir = project(box, { plugins: ["some-other-plugin@1.0.0"] });
    const { code, out } = run(box, ["doctor", "--project", dir]);
    expect(code).toBe(1);
    expect(out).toContain(`FAIL  ${NAME} is not switched on here`);
  });
});


describe("central install", () => {
  const central = (box: Box) => path.join(box.dir, "shared", "ecmwf");
  const config = (box: Box) => path.join(central(box), "opencode.json");
  const writable = (file: string) => (lstatSync(file).mode & 0o222) !== 0;
  /** A fake ss that shows a listener on the service port owned by `uid`, or none. */
  const fakeSs = (box: Box, uid?: number) => {
    const line = uid === undefined ? "" : `LISTEN 0 512 127.0.0.1:49374 0.0.0.0:* uid:${uid} ino:1 sk:1 <->`;
    write(path.join(box.bin, "ss"), `#!/bin/sh\nprintf '%s\\n' '${line}'\n`);
    chmodSync(path.join(box.bin, "ss"), 0o755);
  };
  const uid = process.getuid!();

  test("--central writes a read-only folder of copies with the config's paths filled in, and prints the module lines", () => {
    const box = makeBox();
    const { code, out } = run(box, ["--central", central(box)]);
    expect(code).toBe(0);
    const dir = central(box);
    const json = JSON.parse(readFileSync(config(box), "utf8")) as typeof CENTRAL_TEMPLATE;
    expect(json).toEqual(JSON.parse(JSON.stringify(CENTRAL_TEMPLATE).replaceAll(PLACEHOLDER, dir)));
    expect(json.skills).toEqual([path.join(dir, "skills")]);
    expect(json.plugins[0]!.package).toBe(path.join(dir, PLUGIN));
    expect(readFileSync(path.join(dir, "prompts", "lead.md"), "utf8")).toBe("Lead prompt.\n");
    const size = (rel: string) => readFileSync(path.join(box.dist, "opencode-v2", rel), "utf8").length;
    expect(listing(dir)).toEqual([
      `${NAME}/`,
      `${NAME}/installed.txt (${readFileSync(path.join(dir, NAME, "installed.txt"), "utf8").length})`,
      `${NAME}/profiles/`,
      ...Object.keys(PROFILES).sort().map((id) => `${NAME}/profiles/${id}.json (${profileJson(id).length})`),
      `${NAME}/schema.json (${size(`${NAME}/schema.json`)})`,
      `opencode.json (${readFileSync(config(box), "utf8").length})`,
      "plugins/",
      `${PLUGIN}/`,
      `${PLUGIN}/index.js (${size(`${PLUGIN}/index.js`)})`,
      `${PLUGIN}/tui.js (${size(`${PLUGIN}/tui.js`)})`,
      "prompts/",
      "prompts/commands/",
      "prompts/commands/plan.md (17)",
      "prompts/lead.md (13)",
      "skills/",
      `skills/${NAME}-plan/`,
      `skills/${NAME}-plan/SKILL.md (${readFileSync(path.join(dir, "skills", `${NAME}-plan`, "SKILL.md"), "utf8").length})`,
    ]);
    expect(readFileSync(path.join(dir, NAME, "installed.txt"), "utf8")).toContain("mode=central\n");
    for (const file of [dir, config(box), path.join(dir, PLUGIN, "index.js")]) expect(writable(file)).toBe(false);
    // No site settings unless asked for, and nothing in the admin's own config.
    expect(existsSync(path.join(dir, `${NAME}.jsonc`))).toBe(false);
    expect(existsSync(box.config)).toBe(false);
    const file = config(box);
    expect(out).toContain(`    setenv("OPENCODE_CONFIG", "${file}")\n`);
    expect(out).toContain(`      LmodMessage("${NAME}: opencode's background service reads OPENCODE_CONFIG only when it starts. Run once: opencode service set env OPENCODE_CONFIG ${file}")`);
    expect(out).toContain(`    setenv OPENCODE_CONFIG ${file}\n`);
    expect(out).toContain("    if { [module-info mode load] } {");
    expect(out).toContain(`The one-time step, also offered as: ${INSTALL} central-enable ${dir}\n`);
    expect(out).toContain(`Check with: ${INSTALL} doctor --central ${dir}\n`);
  });

  test("--review and --profile write the site settings file, and only then", () => {
    const box = makeBox();
    expect(run(box, ["--central", central(box), "--review", "ask", "--profile", "anthropic"]).code).toBe(0);
    expect(settingsJson(path.join(central(box), `${NAME}.jsonc`))).toEqual({ $schema: `./${NAME}/schema.json`, review: "ask", profile: "anthropic" });
    const other = makeBox();
    expect(run(other, ["--central", central(other), "--review", "never"]).code).toBe(0);
    expect(settingsJson(path.join(central(other), `${NAME}.jsonc`))).toEqual({ $schema: `./${NAME}/schema.json`, review: "never" });
  });

  test("running it again updates the read-only folder: new files, stale ones gone, site settings kept", () => {
    const box = makeBox();
    expect(run(box, ["--central", central(box), "--review", "ask"]).code).toBe(0);
    writePlatform(box.dist, "v2", [`skills/${NAME}-new/SKILL.md`]);
    rmSync(path.join(box.dist, "opencode-v2", "central", "prompts", "commands", "plan.md"));
    const again = run(box, ["--central", central(box)]);
    expect(again.code).toBe(0);
    expect(existsSync(path.join(central(box), "skills", `${NAME}-new`, "SKILL.md"))).toBe(true);
    expect(again.out).toContain(`removed ${path.join(central(box), "prompts", "commands", "plan.md")}`);
    expect(existsSync(path.join(central(box), "prompts", "commands"))).toBe(false);
    expect(settingsJson(path.join(central(box), `${NAME}.jsonc`)).review).toBe("ask");
    expect(writable(central(box))).toBe(false);
  });

  test("refuses a folder that holds something else, --link, --project, odd paths and uninstall", () => {
    const box = makeBox();
    write(path.join(central(box), "mine.txt"), "x");
    const foreign = run(box, ["--central", central(box)]);
    expect(foreign.code).toBe(1);
    expect(foreign.out).toContain("is not empty and holds no central install");
    expect(readdirSync(central(box))).toEqual(["mine.txt"]);
    expect(run(box, ["--central", path.join(box.dir, "new"), "--link"]).out).toContain("always copied");
    expect(run(box, ["--central", path.join(box.dir, "new"), "--project", box.dir]).out).toContain("use --project or --central, not both");
    expect(run(box, ["--central", path.join(box.dir, "a b")]).out).toContain("may only contain letters");
    const uninstall = run(box, ["uninstall", "--central", central(box)]);
    expect(uninstall.code).toBe(1);
    expect(uninstall.out).toContain(`${central(box)} holds no central install of ${NAME}, so there is nothing to remove there.`);
    expect(uninstall.out).not.toContain("rm -rf");
    expect(existsSync(path.join(box.dir, "new"))).toBe(false);
  });

  test("uninstall --central advises deleting the folder only when it holds a central install", () => {
    const box = makeBox();
    expect(run(box, ["--central", central(box)]).code).toBe(0);
    const ours = run(box, ["uninstall", "--central", central(box)]);
    expect(ours.code).toBe(1);
    expect(ours.out).toContain(`delete its folder: chmod -R u+w ${central(box)} && rm -rf ${central(box)}`);
    expect(existsSync(config(box))).toBe(true);
    // A typo that names a system folder.
    const typo = run(box, ["uninstall", "--central", "/usr"]);
    expect(typo.code).toBe(1);
    expect(typo.out).toContain(`/usr holds no central install of ${NAME}`);
    expect(typo.out).not.toContain("rm -rf");
  });

  /**
   * What --central made in 0.5.x: an ordinary copy install for opencode 1 that users switched on
   * with OPENCODE_CONFIG_DIR, with a site settings file, made read-only by the administrator.
   */
  function earlierCentral(box: Box): string[] {
    const dir = central(box);
    writePlatform(box.dist, "v1");
    const v1 = path.join(box.dist, "opencode-v1");
    const files = readFileSync(path.join(v1, NAME, "files.txt"), "utf8").trim().split("\n");
    for (const rel of files) write(path.join(dir, rel), readFileSync(path.join(v1, rel), "utf8"));
    const record = [`# ${NAME} install record, written by install.sh. Do not edit.`, "platform=v1", "mode=copy", "version=0.5.3", ...files.map((rel) => `file=${rel}`)];
    write(path.join(dir, NAME, "installed.txt"), `${record.join("\n")}\n`);
    write(path.join(dir, `${NAME}.jsonc`), '{\n  "review": "ask"\n}\n');
    rmSync(v1, { recursive: true });
    Bun.spawnSync(["chmod", "-R", "a-w", dir]);
    return files;
  }

  test("--central replaces a central install from 0.5.x in place, keeping the site settings", () => {
    const box = makeBox();
    const files = earlierCentral(box);
    const { code, out } = run(box, ["--central", central(box)]);
    expect(code).toBe(0);
    expect(out).toContain(`${central(box)} holds a central install from an earlier release, for opencode 1; it is replaced, and the site settings file is kept.`);
    for (const rel of files.filter((rel) => rel.startsWith("agents/") || rel.startsWith("commands/") || rel.startsWith("plugins/"))) {
      expect(existsSync(path.join(central(box), rel))).toBe(false);
    }
    expect(existsSync(path.join(central(box), "agents"))).toBe(false);
    expect(existsSync(path.join(central(box), PLUGIN, "index.js"))).toBe(true);
    expect(JSON.parse(readFileSync(config(box), "utf8")).skills).toEqual([path.join(central(box), "skills")]);
    const record = readFileSync(path.join(central(box), NAME, "installed.txt"), "utf8");
    expect(record).toContain("platform=v2\nmode=central\n");
    expect(record).not.toContain("file=agents/");
    expect(settingsJson(path.join(central(box), `${NAME}.jsonc`))).toEqual({ review: "ask" });
    expect(writable(central(box))).toBe(false);
    expect(out).toContain(`Its users switched the earlier install on with OPENCODE_CONFIG_DIR=${central(box)}.`);
    expect(out).toContain(
      `change the module to set OPENCODE_CONFIG=${config(box)} instead of OPENCODE_CONFIG_DIR, and to drop OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS; each user then runs once: ${INSTALL} central-enable ${central(box)}.`,
    );
    expect(out).not.toContain("Warning");
    expect(run(box, ["doctor", "--central", central(box)]).out).toContain(`OK    central install in ${central(box)}`);
  });

  test("--central stops when a file the new install needs is not from the earlier one", () => {
    const box = makeBox();
    earlierCentral(box);
    Bun.spawnSync(["chmod", "u+w", central(box)]);
    write(config(box), '{ "provider": {} }\n');
    const before = listing(central(box));
    const { code, out } = run(box, ["--central", central(box)]);
    expect(code).toBe(1);
    expect(out).toContain(`holds a central install from an earlier release, and these files, which are not from ${NAME}, are where the new one goes:\n  ${config(box)}\n`);
    expect(listing(central(box))).toEqual(before);
  });

  test("doctor and central-enable send a central install from 0.5.x to the rerun and the new module", () => {
    const box = makeBox();
    fakeSs(box);
    earlierCentral(box);
    const named = run(box, ["doctor", "--central", central(box)]);
    expect(named.code).toBe(1);
    expect(named.out).toContain(`FAIL  ${central(box)} holds a central install from an earlier release, for opencode 1, which opencode 2 cannot use; run ${INSTALL} --central ${central(box)} to replace it`);
    expect(named.out).not.toContain("installed.txt is missing");
    const viaDir = run(box, ["doctor"], box.dir, { OPENCODE_CONFIG_DIR: `${central(box)}/` });
    expect(viaDir.code).toBe(1);
    expect(viaDir.out).toContain(`FAIL  OPENCODE_CONFIG_DIR names ${central(box)}, a central install from an earlier release, for opencode 1.`);
    expect(viaDir.out).toContain(`instead of OPENCODE_CONFIG_DIR, and to drop OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS; each user then runs once: ${INSTALL} central-enable ${central(box)}`);
    expect(viaDir.out).not.toContain("is not installed here");
    const enable = run(box, ["central-enable", central(box)]);
    expect(enable.code).toBe(1);
    expect(enable.out).toContain(`holds a central install from an earlier release, for opencode 1, which opencode 2 cannot use. Ask the administrator to replace it with: ${INSTALL} --central ${central(box)}`);
    expect(readFileSync(path.join(box.dir, "service.log"), "utf8")).not.toContain("set env");
    const uninstall = run(box, ["uninstall", "--central", central(box)]);
    expect(uninstall.out).toContain(`holds a central install from an earlier release, for opencode 1; replace it with: ${INSTALL} --central ${central(box)}`);
    expect(uninstall.out).not.toContain("rm -rf");
    // Replaced, but the module still sets OPENCODE_CONFIG_DIR.
    expect(run(box, ["--central", central(box)]).code).toBe(0);
    const stale = run(box, ["doctor"], box.dir, { OPENCODE_CONFIG_DIR: central(box), OPENCODE_CONFIG: config(box) });
    expect(stale.code).toBe(1);
    expect(stale.out).toContain(`FAIL  OPENCODE_CONFIG_DIR names the central install ${central(box)}.`);
    expect(stale.out).toContain(`Unset OPENCODE_CONFIG_DIR and set OPENCODE_CONFIG=${config(box)} instead`);
  });

  test("--dry-run writes nothing", () => {
    const box = makeBox();
    const { code, out } = run(box, ["--central", central(box), "--review", "ask", "--dry-run"]);
    expect(code).toBe(0);
    expect(out).toContain(`Would write the central install of ${NAME} into ${central(box)}`);
    expect(existsSync(central(box))).toBe(false);
  });

  test("central-enable keeps OPENCODE_CONFIG in the service's settings; central-disable removes it", () => {
    const box = makeBox();
    fakeSs(box);
    run(box, ["--central", central(box)]);
    const enabled = run(box, ["central-enable", central(box)]);
    expect(enabled.code).toBe(0);
    expect(readFileSync(path.join(box.dir, "service.log"), "utf8")).toContain(`service set env OPENCODE_CONFIG ${config(box)}\n`);
    expect(enabled.out).toContain(`Your opencode service now starts with OPENCODE_CONFIG=${config(box)}.`);
    expect(enabled.out).toContain(`Set it in your shell as well`);
    expect(enabled.out).toContain(`Check it with: ${INSTALL} doctor`);
    // Without a folder: the one the module named.
    rmSync(path.join(box.dir, "service.log"));
    const fromEnv = run(box, ["central-enable"], box.dir, { OPENCODE_CONFIG: config(box), ECMWF_MULTI_AGENTS_COMMAND: "ecmwf-multi-agents" });
    expect(fromEnv.code).toBe(0);
    expect(fromEnv.out).not.toContain("Set it in your shell");
    expect(fromEnv.out).toContain("Check it with: ecmwf-multi-agents doctor");
    expect(readFileSync(path.join(box.dir, "service.log"), "utf8")).toContain(`service set env OPENCODE_CONFIG ${config(box)}\n`);
    const disabled = run(box, ["central-disable"]);
    expect(disabled.code).toBe(0);
    expect(readFileSync(path.join(box.dir, "service.log"), "utf8")).toContain("service unset env OPENCODE_CONFIG\n");
    expect(existsSync(path.join(box.dir, "service-env"))).toBe(false);
  });

  test("central-enable refuses a folder that is not a central install, and needs one named", () => {
    const box = makeBox();
    mkdirSync(path.join(box.dir, "other"));
    const other = run(box, ["central-enable", path.join(box.dir, "other")]);
    expect(other.code).toBe(1);
    expect(other.out).toContain("is not a central install");
    const none = run(box, ["central-enable"], box.dir, { ECMWF_MULTI_AGENTS_COMMAND: "ecmwf-multi-agents" });
    expect(none.out).toContain("name the central folder: ecmwf-multi-agents central-enable DIR");
    expect(existsSync(path.join(box.dir, "service.log"))).toBe(false);
  });

  test("doctor follows OPENCODE_CONFIG: the folder, the shell, the service, the port, and opencode asked with the central config", () => {
    const box = makeBox();
    fakeSs(box);
    run(box, ["--central", central(box), "--review", "ask"]);
    run(box, ["central-enable", central(box)]);
    const { code, out } = run(box, ["doctor"], box.dir, { OPENCODE_CONFIG: config(box) });
    expect(out).toContain(`OK    central install in ${central(box)} (${NAME} `);
    expect(out).toContain("OK    OPENCODE_CONFIG in this shell names it");
    expect(out).toContain(`OK    your opencode service starts with OPENCODE_CONFIG=${config(box)}`);
    expect(out).toContain("OK    port 49374 for your opencode service is free");
    expect(out).toContain(`OK    settings ${path.join(central(box), `${NAME}.jsonc`)} (profile not set, review ask)`);
    expect(out).toContain("OK    lead is the harness's, from the central install, with the plugin 9.9.9 active");
    expect(out).not.toContain("is not installed here");
    expect(code).toBe(0);
    expect(readFileSync(path.join(box.dir, "api-env.log"), "utf8").trim()).toBe(config(box));
  });

  test("doctor warns when the service lacks OPENCODE_CONFIG, the shell lacks it, or another user holds the port", () => {
    const box = makeBox();
    fakeSs(box, uid + 1);
    run(box, ["--central", central(box)]);
    const viaService = run(box, ["doctor"]);
    expect(viaService.out).toContain("Checking ecmwf-multi-agents in");
    // Nothing points at it yet: an ordinary global doctor.
    expect(viaService.out).toContain("is not installed here");
    writeFileSync(path.join(box.dir, "service-port"), "50000");
    const { code, out } = run(box, ["doctor", "--central", central(box)], box.dir, { ECMWF_MULTI_AGENTS_COMMAND: "ecmwf-multi-agents" });
    expect(out).toContain(`Checking the central install of ${NAME} in ${central(box)}`);
    expect(out).toContain(`WARN  OPENCODE_CONFIG is not set in this shell; load the module, or export OPENCODE_CONFIG=${config(box)}`);
    expect(out).toContain(`WARN  your opencode service does not start with OPENCODE_CONFIG, so opencode may run without the harness; run once: ecmwf-multi-agents central-enable ${central(box)}`);
    expect(out).toContain(`WARN  port 50000, which your opencode service uses, is held by another user's process (uid ${uid + 1})`);
    expect(out).toContain("opencode service set port <number>");
    expect(out).toContain("opencode service set disabled true");
    expect(code).toBe(0);
    // The service alone names it: doctor finds it from there.
    writeFileSync(path.join(box.dir, "service-env"), config(box));
    const found = run(box, ["doctor"]);
    expect(found.out).toContain(`OK    central install in ${central(box)}`);
    expect(found.out).toContain(`OK    your opencode service starts with OPENCODE_CONFIG=${config(box)}`);
  });

  test("doctor fails on a central folder with missing files, and on a folder that is none", () => {
    const box = makeBox();
    fakeSs(box);
    run(box, ["--central", central(box)]);
    Bun.spawnSync(["chmod", "-R", "u+w", central(box)]);
    rmSync(path.join(central(box), "prompts", "lead.md"));
    const broken = run(box, ["doctor", "--central", central(box)]);
    expect(broken.code).toBe(1);
    expect(broken.out).toContain(`FAIL  1 files of the central install in ${central(box)} are missing; run ${INSTALL} --central ${central(box)} again`);
    const none = run(box, ["doctor", "--central", path.join(box.dir, "none")]);
    expect(none.code).toBe(1);
    expect(none.out).toContain("there is no central install of");
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
