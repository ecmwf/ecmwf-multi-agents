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
    leadSource: "plugin",
    leadFiles: [],
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
  write(path.join(root, NAME, "files.txt"), `${[...files].sort().join("\n")}\n`);
}

/**
 * A fake opencode command: prints a version and a model list, and answers `opencode api` with
 * the file rpc.json next to its folder (exit code in rpc.exit), or with a good doctor report.
 * Each api call is logged to api.log with the folder it ran in.
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
    if [ -f '${box}/rpc.json' ]; then cat '${box}/rpc.json'; exit "$(cat '${box}/rpc.exit' 2>/dev/null || echo 0)"; fi
    printf '%s\\n' '${JSON.stringify(GOOD_DOCTOR)}'
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
    expect(run(box, ["--central", box.dir]).out).toContain("unknown option: --central");
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
    expect(out).toContain("FAIL  the files installed here are for opencode 1, which is no longer supported; run ./install.sh");
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
    expect(out).toContain("OK    lead is loaded from the plugin 9.9.9");
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

  test("problems, another default agent, lead from files, and no lead", () => {
    const box = makeBox();
    run(box, []);
    answer(box, {
      output: {
        ...GOOD_DOCTOR.output,
        defaultAgent: "build",
        leadSource: "files",
        leadFiles: ["/x/agents/lead.md"],
        problems: [
          { problem: `${NAME}: ignoring /x/${NAME}.jsonc: "review" must be auto, ask, always or never, not "often"`, notify: true },
          { problem: "second problem", notify: false },
        ],
      },
    });
    const { code, out } = run(box, ["doctor"]);
    expect(code).toBe(0);
    expect(out).toContain("OK    lead is loaded from files (/x/agents/lead.md), with the plugin 9.9.9 active");
    expect(out).toContain("WARN  the default agent is build, not lead");
    expect(out).toContain(`WARN  ${NAME}: ignoring /x/${NAME}.jsonc: "review" must be auto, ask, always or never, not "often"`);
    expect(out).toContain("WARN  second problem");
    answer(box, { output: { ...GOOD_DOCTOR.output, leadLoaded: false, leadSource: null, reviewLine: null } });
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
    expect(out).toContain("OK    lead is loaded from the plugin 9.9.9");
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

  test("no line and no files: not switched on", () => {
    const box = makeBox();
    const dir = project(box, { plugins: ["some-other-plugin@1.0.0"] });
    const { code, out } = run(box, ["doctor", "--project", dir]);
    expect(code).toBe(1);
    expect(out).toContain(`FAIL  ${NAME} is not switched on here`);
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
