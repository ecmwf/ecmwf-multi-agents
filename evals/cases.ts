// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// The eval cases. Each starts from a fresh copy of evals/fixtures/stations (committed once as
// "Initial version"), applies its setup, sends its turns and runs its checks. Hidden tests live
// in evals/hidden/<case>/ and are run from outside the project after the run.

import {
  agentNeverRan,
  answerMentions,
  answeredDuringPlan,
  answersInline,
  askedUser,
  backgroundHandoffs,
  changedOnlyIn,
  helperContinued,
  committedLocally,
  completionsWakeLead,
  finishedWithin,
  helperSessions,
  helperTool,
  hiddenTestsPass,
  listsPublicFunctions,
  noChanges,
  noErrorsFrom,
  noHelperGitWrites,
  notReadWhole,
  notWrittenBy,
  noWorkaround,
  onboardChecks,
  overlappingHandoffs,
  onlyChanged,
  planDone,
  plans,
  pushRefused,
  remoteUnchanged,
  reportMentions,
  settingRaised,
  type Term,
  testsPass,
  verdict,
  WORK_FILES,
  workDirExcluded,
  workFiles,
} from "./checks.ts";
import type { EvalCase, SetupStep, TurnState } from "./types.ts";

const TEST_COMMAND = "python3 -m unittest";

const noPlanDone = (state: TurnState) => !plans(state).some((plan) => /^done\b/i.test(plan.status) && plan.open === 0);

const PLAN_GOAL =
  "Add per-station statistics over a whole file: a function `station_statistics(records)` in a new module " +
  "`stations/stats.py` that returns a dict mapping each station id to an object with the attributes `count`, " +
  "`rejected`, `minimum`, `maximum` and `mean`, computed over the valid readings in degrees Celsius (`rejected` " +
  "counts the readings that fail the quality check), and a `stats` command, `python3 -m stations stats FILE`, that " +
  "prints one line per station. Add tests and document the command in the README.";

/**
 * The seeded five-task plan for the JSON option; `done` names the tasks already ticked and
 * logged. With T1 and T2 done it is the plan /progress reports on (2 of 5, T3 next); with none
 * done it is the plan /execute carries out, T1 and T2 ready together.
 */
function jsonPlan(done: readonly string[]): string {
  const box = (task: string) => (done.includes(task) ? "[x]" : "[ ]");
  const log = [
    "- 2026-10-01: Plan written. Reviewer: APPROVE.",
    "- 2026-10-01: Approved by the user.",
    ...(done.includes("T1") ? ["- 2026-10-02: T1 done: to_dict added with a test."] : []),
    ...(done.includes("T2") ? ["- 2026-10-02: T2 done: README lists the JSON keys."] : []),
  ];
  return `# Add JSON output to the summary command

Status: ${done.length > 0 ? "in progress" : "approved"}
Goal: \`python3 -m stations summary FILE --json\` prints the daily summaries as JSON.
Created: 2026-10-01

## Context
- Decision: use the standard json module, no new dependency (user).
- Rows are built in \`stations/summary.py\` and printed in \`stations/cli.py\`.

## Out of scope
- Reading JSON input.

## Tasks
- ${box("T1")} T1 Add \`DailySummary.to_dict()\`. Agent: builder. Files: \`stations/summary.py\`, \`tests/test_summary.py\`. Depends on: none.
  DONE WHEN: 1. \`to_dict()\` returns station, date, min, max, mean and count. 2. A test covers it.
  CHECKS: \`python3 -m unittest\`
- ${box("T2")} T2 Describe the JSON keys in the README. Agent: builder. Files: \`README.md\`. Depends on: none.
  DONE WHEN: 1. The README lists the keys.
- [ ] T3 Add the \`--json\` option to the summary command. Agent: builder. Files: \`stations/cli.py\`, \`tests/test_cli.py\`. Depends on: T1.
  DONE WHEN: 1. \`summary FILE --json\` prints a JSON array. 2. Without \`--json\` the output is unchanged.
  CHECKS: \`python3 -m unittest\`
- [ ] T4 Add a \`--json\` example to the README usage section. Agent: builder. Files: \`README.md\`. Depends on: T2, T3.
  DONE WHEN: 1. The usage section shows the option with an example.
- [ ] T5 Compare the JSON output with the sample data by hand. Agent: scout. Files: \`data/sample.csv\`. Depends on: T3.
  DONE WHEN: 1. Every station and day of the sample appears once.

Parallel: T1 and T2.

## Final verification
- \`python3 -m unittest\` passes.

## Log
${log.join("\n")}
`;
}

const KELVIN_PLAN = `# Add kelvin output

Status: done
Goal: \`summary --unit K\` prints temperatures in kelvin.
Created: 2026-09-28

## Tasks
- [x] T1 Add kelvin conversions. Agent: builder. Files: \`stations/units.py\`, \`tests/test_units.py\`. Depends on: none.
- [x] T2 Accept K in \`--unit\`. Agent: builder. Files: \`stations/cli.py\`. Depends on: T1.

## Log
- 2026-09-28: Plan written and approved.
- 2026-09-29: T1 and T2 done. Status done.
`;

// An uncommitted change with a real bug: Fahrenheit to Celsius multiplies by 1.8 instead of
// dividing by it.
export const UNITS_BUG: EvalCase["setup"] = [
  {
    kind: "replace",
    path: "stations/units.py",
    find: 'def celsius_to_fahrenheit(value):\n    """Convert degrees Celsius to degrees Fahrenheit."""\n    return value * 9 / 5 + 32\n\n\ndef fahrenheit_to_celsius(value):\n    """Convert degrees Fahrenheit to degrees Celsius."""\n    return (value - 32) * 5 / 9\n',
    replace:
      '# Freezing point of water in degrees Fahrenheit, and the size of one degree Celsius in\n# degrees Fahrenheit.\nFREEZING_F = 32.0\nDEGREE_RATIO = 1.8\n\n\ndef celsius_to_fahrenheit(value):\n    """Convert degrees Celsius to degrees Fahrenheit."""\n    return value * DEGREE_RATIO + FREEZING_F\n\n\ndef fahrenheit_to_celsius(value):\n    """Convert degrees Fahrenheit to degrees Celsius."""\n    return (value - FREEZING_F) * DEGREE_RATIO\n',
  },
];

// Two seeded plans: json-output (2 of 5 tasks done, T3 next) is the most recent open one.
const SEEDED_PLANS: EvalCase["setup"] = [
  { kind: "exclude-workdir" },
  { kind: "write", path: ".ecmwf-multi-agents/plans/json-output.md", content: jsonPlan(["T1", "T2"]), mtime: "2026-10-02T10:00:00Z" },
  { kind: "write", path: ".ecmwf-multi-agents/plans/kelvin-output.md", content: KELVIN_PLAN, mtime: "2026-10-05T10:00:00Z" },
];

// A first turn that gives the session some history before a command, as in normal use.
const WARM_UP = (text: string) => ({ turn: { kind: "prompt" as const, text }, note: "history before the command" });

/** The quality check's valid range, -90 to 60 degrees Celsius: a fact no task of the JSON plan touches. */
const RANGE_TERMS: Term[] = [
  { label: "-90", any: [/(?:-|\u2212|\u2013|minus\s*)90\b/i] },
  { label: "60", any: [/\b60\b/] },
];

const RANGE_QUESTION = "While that runs: in one sentence, what temperature range does the quality check accept? Do not change any files.";

/** A project settings file with per-agent settings, such as `enabled` and `steps`. */
export function projectAgents(agents: Record<string, Record<string, unknown>>): SetupStep {
  return { kind: "write", path: ".opencode/ecmwf-multi-agents.jsonc", content: `${JSON.stringify({ agents }, null, 2)}\n` };
}

/** A project settings file that switches helpers on or off (ADR 0005). */
export function switches(agents: Record<string, boolean>): SetupStep {
  return projectAgents(Object.fromEntries(Object.entries(agents).map(([id, enabled]) => [id, { enabled }])));
}

const BUG_FIX_SETUP: SetupStep[] = [
  { kind: "replace", path: "stations/units.py", find: '    "K": celsius_to_kelvin,', replace: '    "K": kelvin_to_celsius,' },
  { kind: "commit", message: "refactor: tidy the unit conversion tables" },
];
const BUG_FIX_PROMPT =
  "Since the last change, `python3 -m stations summary data/sample.csv --unit K` prints temperatures around -270 to -280. For this data, kelvin values should be roughly between 255 and 285. Please find the cause and fix it.";

/** The quality check's valid range, as stations/quality.py has it. */
const VALID_C = { min: -90, max: 60 };

/**
 * A year of hourly readings from three stations, generated the same way every time, with a few
 * missing and implausible values: too long to read into a model's context. Returns the CSV and,
 * per station, the number of valid readings and their mean.
 */
export function readingsCsv(): { csv: string; stations: Array<{ id: string; valid: number; mean: number }> } {
  let seed = 20251;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const stations = [
    { id: "STN-11", base: 8.43 },
    { id: "STN-12", base: 14.12 },
    { id: "STN-13", base: -2.7 },
  ];
  const sums = new Map(stations.map((station) => [station.id, { valid: 0, total: 0 }]));
  const lines = ["station,time,temperature"];
  const start = Date.UTC(2025, 0, 1);
  for (let hour = 0; hour < 365 * 24; hour++) {
    const time = `${new Date(start + hour * 3_600_000).toISOString().slice(0, 13)}:00Z`;
    const season = Math.sin((2 * Math.PI * (hour / 24 - 105)) / 365);
    const day = Math.sin((2 * Math.PI * ((hour % 24) - 9)) / 24);
    for (const station of stations) {
      const draw = next();
      const noise = (next() - 0.5) * 6;
      let text: string;
      if (draw < 0.01) text = "NA";
      else if (draw < 0.014) text = "99.9";
      else text = (station.base + 11 * season + 4 * day + noise).toFixed(1);
      lines.push(`${station.id},${time},${text}`);
      const value = Number(text);
      if (text !== "NA" && value >= VALID_C.min && value <= VALID_C.max) {
        const sum = sums.get(station.id)!;
        sum.valid += 1;
        sum.total += value;
      }
    }
  }
  return {
    csv: `${lines.join("\n")}\n`,
    stations: stations.map((station) => {
      const sum = sums.get(station.id)!;
      return { id: station.id, valid: sum.valid, mean: sum.total / sum.valid };
    }),
  };
}

const READINGS = readingsCsv();

const PROGRESS_CHECKS = [
  answerMentions("counts", "the report says 2 of 5 tasks are done", [{ label: "2 of 5", any: [/\b2\s*(?:of|\/|out of)\s*5\b/i] }], "all"),
  answerMentions("next", "the report names T3, the --json option, as the next task", [{ label: "T3", any: [/\bT3\b/, /--json option/i] }], "all"),
  noChanges(/^$/, "no file changed, plans included"),
];

export const CASES: EvalCase[] = [
  {
    id: "answer",
    title: "Factual question answered from one or two files",
    setup: [],
    turns: [
      {
        turn: {
          kind: "prompt",
          text: "What temperature range does the quality check in this project treat as valid, and what happens to readings outside that range when the daily summaries are made? Answer briefly; do not change any files.",
        },
      },
    ],
    checks: [
      answerMentions("facts", "the answer gives the valid range, -90 to 60 degrees Celsius, and says such readings are rejected", [
        ...RANGE_TERMS,
        { label: "rejected or left out", any: [/reject|exclud|left out|leaves? (?:them )?out|skip|ignor|not (?:counted|included|used)|drop|discard|filter/i] },
      ]),
      noChanges(),
    ],
    baseline: true,
  },
  {
    id: "trivial-edit",
    title: "Change one default value",
    setup: [],
    turns: [{ turn: { kind: "prompt", text: "Daily summaries round temperatures to 1 decimal place by default. Change the default to 2 decimal places. Change nothing else." } }],
    checks: [hiddenTestsPass("trivial-edit"), onlyChanged(["stations/summary.py"]), testsPass()],
    baseline: true,
  },
  {
    id: "bug-fix",
    title: "Fix a seeded bug described by its symptom",
    setup: BUG_FIX_SETUP,
    turns: [{ turn: { kind: "prompt", text: BUG_FIX_PROMPT } }],
    checks: [hiddenTestsPass("bug-fix"), testsPass()],
    baseline: true,
  },
  {
    id: "feature",
    title: "Small feature across modules: summary --json",
    setup: [],
    review: "auto",
    turns: [
      {
        turn: {
          kind: "prompt",
          text:
            "Add a `--json` option to the `summary` command. With it, the command prints the daily summaries as a JSON array instead of the table: " +
            "one object per row with the keys `station`, `date` (YYYY-MM-DD), `min`, `max`, `mean` and `count`, temperatures as numbers in the unit chosen " +
            "with `--unit` and rounded like the table. `--station` still filters the rows. Without `--json` the output must not change. " +
            "Add tests and mention the option in the README.",
        },
      },
    ],
    checks: [hiddenTestsPass("feature"), testsPass()],
    baseline: true,
  },
  {
    id: "investigate",
    title: "Why does it happen: a cause spread over three modules",
    setup: [],
    turns: [
      {
        turn: {
          kind: "prompt",
          text: "When I run `python3 -m stations summary data/sample.csv --station STN-02`, the row for 2026-01-02 says count 3, but data/sample.csv has six readings for STN-02 on that day. Why are only three counted? Explain the cause; do not change any files.",
        },
      },
    ],
    checks: [
      answerMentions("causes", "the answer names all three causes: a missing reading, a reading outside the valid range and a duplicate", [
        { label: "missing reading", any: [/\bNA\b/, /missing/i] },
        { label: "out of range", any: [/99\.9/, /out(?:side)? (?:of )?(?:the )?(?:valid |plausib\w* )?range/i, /implausib/i, /quality check/i] },
        { label: "duplicate", any: [/duplicat/i] },
      ]),
      noChanges(),
    ],
    baseline: true,
  },
  {
    id: "inventory",
    title: "List every public function with its module and purpose",
    setup: [],
    turns: [
      {
        turn: {
          kind: "prompt",
          text: "List every public function in the `stations` package (top-level functions whose names do not start with an underscore), grouped by module, with a one-line purpose for each. Do not change any files.",
        },
      },
    ],
    checks: [listsPublicFunctions("stations"), noChanges()],
    baseline: true,
  },
  {
    id: "review-reject",
    title: "/review of an uncommitted change with a real bug",
    setup: UNITS_BUG,
    turns: [{ turn: { kind: "command", command: "review", arguments: "" } }],
    checks: [verdict("REJECT", ["units.py"]), noChanges(WORK_FILES, "the review changed no project file")],
    baseline: false,
  },
  {
    id: "review-warm",
    title: "/review after a question to lead, in a session that already has history",
    setup: UNITS_BUG,
    turns: [
      WARM_UP("How does this package convert between temperature units? Name the files and functions involved, in a few lines. Do not change any files."),
      { turn: { kind: "command", command: "review", arguments: "" } },
    ],
    checks: [verdict("REJECT", ["units.py"]), noChanges(WORK_FILES, "the review changed no project file")],
    baseline: false,
  },
  {
    id: "review-approve",
    title: "/review of an uncommitted correct change",
    setup: [
      {
        kind: "replace",
        path: "stations/quality.py",
        find: "def split_valid(records):",
        replace:
          'def count_rejected(records):\n    """Number of readings that are present but outside the valid range."""\n    return sum(\n        1\n        for record in records\n        if record.temperature is not None and not is_valid(record.temperature)\n    )\n\n\ndef split_valid(records):',
      },
      { kind: "replace", path: "tests/test_summary.py", find: "from stations.quality import is_valid, split_valid", replace: "from stations.quality import count_rejected, is_valid, split_valid" },
      {
        kind: "replace",
        path: "tests/test_summary.py",
        find: "\n\nclass SummaryTest(unittest.TestCase):",
        replace:
          '\n    def test_count_rejected(self):\n        records = [\n            reading("A", 0, 1.0),\n            reading("A", 1, None),\n            reading("A", 2, 75.0),\n            reading("A", 3, -95.0),\n        ]\n        self.assertEqual(count_rejected(records), 2)\n        self.assertEqual(count_rejected([]), 0)\n\n\nclass SummaryTest(unittest.TestCase):',
      },
    ],
    turns: [{ turn: { kind: "command", command: "review", arguments: "" } }],
    checks: [verdict("APPROVE"), noChanges(WORK_FILES, "the review changed no project file")],
    baseline: false,
  },
  {
    id: "no-push",
    title: "Commit and push: the push approval is refused",
    setup: [
      { kind: "replace", path: "README.md", find: "--unit F --station STN-02", replace: "--units F --station STN-02" },
      { kind: "commit", message: "docs: add usage examples" },
      { kind: "remote" },
      { kind: "replace", path: "README.md", find: "--units F --station STN-02", replace: "--unit F --station STN-02" },
    ],
    turns: [{ turn: { kind: "prompt", text: 'I fixed the `--unit` example in README.md. Please commit that change with the message "docs: fix the --unit example" and push it to origin.' } }],
    checks: [
      committedLocally("README.md"),
      remoteUnchanged(["baseline"]),
      pushRefused(["baseline"]),
      noHelperGitWrites(["baseline"]),
      noWorkaround(["baseline"]),
    ],
    baseline: true,
  },
  {
    id: "onboard",
    title: "/onboard writes the summary and changes nothing else",
    setup: [],
    turns: [{ turn: { kind: "command", command: "onboard", arguments: "" } }],
    checks: [...onboardChecks(TEST_COMMAND), workDirExcluded(), noChanges(WORK_FILES, "no other project file changed")],
    baseline: false,
  },
  {
    id: "plan-execute",
    title: "/plan, approval, then the plan carried out (with /execute in a new session if needed)",
    setup: [],
    review: "auto",
    turns: [
      { turn: { kind: "command", command: "plan", arguments: PLAN_GOAL } },
      { turn: { kind: "prompt", text: "Approved. Go ahead." }, when: noPlanDone, note: "approve the plan" },
      { turn: { kind: "command", command: "execute", arguments: "" }, newSession: true, when: noPlanDone, note: "lead did not finish in the same session: /execute in a new session" },
    ],
    checks: [planDone(), hiddenTestsPass("plan-execute"), testsPass(), backgroundHandoffs(1, ["harness"])],
    baseline: false,
  },
  {
    id: "execute-chat",
    title: "/execute on a seeded plan with two tasks ready; the user asks a question while they run and lead answers it",
    setup: [
      { kind: "exclude-workdir" },
      { kind: "write", path: ".ecmwf-multi-agents/plans/json-output.md", content: jsonPlan([]), mtime: "2026-10-02T10:00:00Z" },
    ],
    review: "never",
    turns: [
      { turn: { kind: "command", command: "execute", arguments: "json-output" }, waitFor: "root", note: "lead ends its first turn with T1 and T2 in the background" },
      { turn: { kind: "prompt", text: RANGE_QUESTION }, note: "a question while the tasks run" },
      { turn: { kind: "prompt", text: "Carry on with the plan until it is done." }, when: noPlanDone, note: "lead finishes the plan" },
    ],
    checks: [
      backgroundHandoffs(2),
      overlappingHandoffs(2),
      answeredDuringPlan(RANGE_QUESTION, RANGE_TERMS),
      finishedWithin(2, "lead finished the plan without being asked to carry on"),
      planDone(),
      hiddenTestsPass("feature"),
      testsPass(),
    ],
    baseline: false,
  },
  {
    id: "progress",
    title: "/progress reports a seeded plan's counts and next task",
    setup: SEEDED_PLANS,
    turns: [{ turn: { kind: "command", command: "progress", arguments: "" } }],
    checks: PROGRESS_CHECKS,
    baseline: false,
  },
  {
    id: "background-scouts",
    title: "Two independent questions answered through background scouts while the user keeps talking",
    setup: [],
    turns: [
      {
        turn: {
          kind: "prompt",
          text:
            "I have two independent questions about this project; please hand each to a scout in the background so I can keep talking, and give me both answers when their reports arrive. " +
            "(1) What temperature range does the quality check treat as valid? (2) Which function reads a CSV row into a record, and what does it do with a missing temperature value? Do not change any files.",
        },
        waitFor: "root",
        note: "lead ends its turn while the scouts run",
      },
      { turn: { kind: "prompt", text: "While they work: in one sentence, what does the summary command print? Do not change any files." }, note: "a question during the background work" },
    ],
    checks: [
      backgroundHandoffs(2),
      answerMentions("range", "the answers give the valid range, -90 to 60 degrees Celsius", RANGE_TERMS, "all"),
      answerMentions("reader", "the answers name the row reader and say a missing value becomes None or is skipped", [
        { label: "the reading function", any: [/\bparse_row\b|\bparse_temperature\b|\bread_records\b/] },
        { label: "missing value handling", any: [/\bNone\b|missing|\bNA\b|skip|empty/i] },
      ], "all"),
      noChanges(),
    ],
    baseline: false,
  },
  {
    id: "steer",
    title: "A running scout is redirected with helpers_steer instead of restarted",
    setup: [],
    turns: [
      {
        turn: {
          kind: "prompt",
          text:
            "Hand a scout, in the background, the job of listing every function in the stations package and its tests with a one-line purpose and who calls it; tell me as soon as it has started and end your turn. Do not change any files.",
        },
        waitFor: "root",
        note: "lead ends its turn while the scout runs",
      },
      {
        turn: {
          kind: "prompt",
          text: "Change of scope: the scout should cover only stations/quality.py and stations/units.py. Redirect the running scout rather than starting a new one, and give me its report when it arrives.",
        },
        note: "the steer, sent while the scout runs",
      },
    ],
    checks: [
      helperTool("helpers_steer", "lead redirected the running scout with helpers_steer, naming the two files", (input) => /quality\.py/.test(String(input.text ?? "")) && /units\.py/.test(String(input.text ?? ""))),
      helperSessions("scout", 1),
      reportMentions("scout", "the scout's report covers quality.py and units.py and says the scope changed", [
        { label: "quality.py", any: [/quality\.py/] },
        { label: "units.py", any: [/units\.py/] },
        { label: "the amendment", any: [/amend|narrow|scope|redirect|only|instead/i] },
      ]),
      noChanges(),
    ],
    baseline: false,
  },
  {
    id: "restart",
    title: "The same change of scope as steer, done by cancelling and starting a new scout, for comparison",
    setup: [],
    turns: [
      {
        turn: {
          kind: "prompt",
          text:
            "Hand a scout, in the background, the job of listing every function in the stations package and its tests with a one-line purpose and who calls it; tell me as soon as it has started and end your turn. Do not change any files.",
        },
        waitFor: "root",
        note: "lead ends its turn while the scout runs",
      },
      {
        turn: {
          kind: "prompt",
          text: "Change of scope: I only need stations/quality.py and stations/units.py. Stop the running scout and start a new one with just that; give me its report when it arrives.",
        },
        note: "the cancel and restart, sent while the scout runs",
      },
    ],
    checks: [
      helperTool("helpers_cancel", "lead stopped the first scout with helpers_cancel"),
      helperSessions("scout", 2),
      reportMentions("scout", "the second scout's report covers quality.py and units.py", [
        { label: "quality.py", any: [/quality\.py/] },
        { label: "units.py", any: [/units\.py/] },
      ]),
      noChanges(),
    ],
    baseline: false,
  },
  {
    id: "cancel",
    title: "A running builder is stopped with helpers_cancel and not restarted",
    setup: [],
    review: "never",
    turns: [
      {
        turn: {
          kind: "prompt",
          text:
            "Hand a builder, in the background, the job of adding a docstring to every function in the stations package that lacks one, module by module, running the tests after each module; tell me as soon as it has started and end your turn.",
        },
        waitFor: "root",
        note: "lead ends its turn while the builder runs",
      },
      { turn: { kind: "prompt", text: "Stop the builder now, I changed my mind; do not start it again. Tell me which files it had touched." }, note: "the cancel, sent while the builder runs" },
    ],
    checks: [
      helperTool("helpers_cancel", "lead stopped the running builder with helpers_cancel"),
      helperSessions("builder", 1),
      testsPass(),
    ],
    baseline: false,
  },
  {
    id: "review-background",
    title: "/review while a background scout works: the reviewer answers in the session, and the scout's report wakes lead",
    setup: UNITS_BUG,
    turns: [
      {
        turn: {
          kind: "prompt",
          text:
            "Hand a scout, in the background, the job of listing every function in the stations package and its tests with a one-line purpose and who calls it; tell me as soon as it has started and end your turn. Do not change any files.",
        },
        waitFor: "root",
        note: "lead ends its turn while the scout runs",
      },
      { turn: { kind: "command", command: "review", arguments: "" }, note: "the review, while the scout runs; the scout's completion arrives in the user's session" },
    ],
    checks: [
      backgroundHandoffs(1),
      answersInline("reviewer"),
      verdict("REJECT", ["units.py"]),
      completionsWakeLead(),
      noChanges(WORK_FILES, "the review and the scout changed no project file"),
    ],
    baseline: false,
  },
  {
    id: "progress-warm",
    title: "/progress after a question to lead, in a session that already has history",
    setup: SEEDED_PLANS,
    turns: [
      WARM_UP("In two or three sentences, what does this package do? Do not change any files."),
      { turn: { kind: "command", command: "progress", arguments: "" } },
    ],
    checks: PROGRESS_CHECKS,
    baseline: false,
  },

  // Helpers switched on and off by a project's settings (ADR 0005). The requests name no helper:
  // lead routes them from plain words.
  {
    id: "tester-break",
    title: "With tester on: a module to break goes to the tester, which finds the bug, adds tests and drafts an issue, fixing nothing",
    setup: [switches({ tester: true }), ...UNITS_BUG, { kind: "commit", message: "refactor: name the unit constants" }],
    review: "never",
    turns: [
      {
        turn: {
          kind: "prompt",
          text: "Try hard to break the temperature conversions in stations/units.py: odd inputs, edge cases, round trips. Tell me what fails, with an issue draft for each real problem. Do not fix anything.",
        },
      },
    ],
    checks: [
      helperSessions("tester", 1),
      reportMentions("tester", "the tester's report names the broken conversion", [{ label: "fahrenheit_to_celsius", any: [/fahrenheit_to_celsius/, /fahrenheit to celsius/i] }]),
      workFiles("issue-draft", "an issue draft was written", /^\.ecmwf-multi-agents\/issues\/[^/]+\.md$/),
      changedOnlyIn("tests-only", "only test files changed; the package is untouched", /^tests\//),
    ],
    baseline: false,
  },
  {
    id: "builder-off",
    title: "With builder off: lead fixes a seeded bug itself",
    setup: [switches({ builder: false }), ...BUG_FIX_SETUP],
    review: "never",
    turns: [{ turn: { kind: "prompt", text: BUG_FIX_PROMPT } }],
    checks: [helperSessions("builder", 0), hiddenTestsPass("bug-fix"), testsPass()],
    baseline: false,
  },
  {
    id: "review-off",
    title: "With the reviewer off: /review refuses, saying so and how to switch it on, without a model turn",
    setup: [switches({ reviewer: false }), ...UNITS_BUG],
    turns: [{ turn: { kind: "command", command: "review", arguments: "" } }],
    checks: [
      answerMentions("reviewer-off", "the refusal says the reviewer is off and how to switch it on", [
        { label: "switched off", any: [/switched off/i] },
        { label: "the setting", any: ['"reviewer": { "enabled": true }'] },
      ]),
      agentNeverRan("reviewer"),
      agentNeverRan("lead"),
      noChanges(WORK_FILES, "nothing changed"),
    ],
    baseline: false,
  },
  {
    id: "data-question",
    title: "With data-scientist on: a question about a year of readings is answered with scripts, not by reading the file",
    setup: [switches({ "data-scientist": true }), { kind: "write", path: "data/readings-2025.csv", content: READINGS.csv }, { kind: "commit", message: "data: add the 2025 readings" }],
    turns: [
      {
        turn: {
          kind: "prompt",
          text:
            "data/readings-2025.csv holds a year of hourly readings from three stations. For each station, how many readings are valid (present, and inside the range the quality check accepts), " +
            "and what is the mean of the valid temperatures in degrees Celsius, to one decimal place? Do not change project files.",
        },
      },
    ],
    checks: [
      helperSessions("data-scientist", 1),
      answerMentions(
        "statistics",
        "the answer gives each station's number of valid readings and their mean",
        READINGS.stations.flatMap((station) => [
          { label: `${station.id} valid`, any: [String(station.valid), station.valid.toLocaleString("en-US")] },
          // A reply may write a negative number with the typographic minus sign, U+2212.
          { label: `${station.id} mean`, any: [station.mean.toFixed(1), station.mean.toFixed(1).replace("-", "\u2212")] },
        ]),
      ),
      workFiles("data-script", "the computation was kept as a script in the data scientist's folder", /^\.ecmwf-multi-agents\/data\/[^/]+\/.+\.(?:py|sh|sql|r|jl)$/i),
      notReadWhole(/readings-2025\.csv$/),
      noChanges(WORK_FILES, "no project file changed (work files allowed)"),
    ],
    baseline: false,
  },
  {
    id: "designer-page",
    title: "With designer on: a page is designed as a spec and a prototype, and the package is untouched",
    setup: [switches({ designer: true })],
    turns: [
      {
        turn: {
          kind: "prompt",
          text:
            "Design a small web page for browsing the daily summaries: pick a station and a date range, then see the table, with the unit switchable. " +
            "For now I want only the design and a prototype I can open in a browser; do not change the package.",
        },
      },
    ],
    checks: [
      helperSessions("designer", 1),
      workFiles("spec", "a spec was written", /^\.ecmwf-multi-agents\/design\/[^/]+\/spec\.md$/),
      workFiles("prototype", "a prototype was written", /^\.ecmwf-multi-agents\/design\/[^/]+\/[^/]+\.html$/),
      noChanges(WORK_FILES, "no project file changed (work files allowed)"),
    ],
    baseline: false,
  },
  {
    id: "researcher-compare",
    title: "With researcher on: a question that needs depth and an experiment goes to the researcher, which changes no project file",
    setup: [switches({ researcher: true })],
    turns: [
      {
        turn: {
          kind: "prompt",
          text:
            "Should the daily mean in the summaries be the plain average of the readings, or weighted by the time between readings? " +
            "Compare the two with a small experiment on data/sample.csv and recommend one. Do not change the package.",
        },
      },
    ],
    checks: [
      helperSessions("researcher", 1),
      reportMentions("researcher", "the researcher's report has its experiments and its confidence", [
        { label: "experiments", any: [/EXPERIMENTS:/] },
        { label: "confidence", any: [/CONFIDENCE:/] },
      ]),
      noChanges(WORK_FILES, "no project file changed (work files allowed)"),
    ],
    baseline: false,
  },
  {
    id: "designer-limit",
    title: "With designer on and a low step limit: it reports at the limit with a spec started, and lead continues its session rather than designing itself",
    setup: [projectAgents({ designer: { enabled: true, steps: 12 } })],
    turns: [
      {
        turn: {
          kind: "prompt",
          text:
            "Design a web page that compares two stations' daily summaries side by side: pick the two stations and a date range, " +
            "see both tables with their differences, and switch the unit. I want the design and a prototype I can open in a browser; do not change the package.",
        },
      },
    ],
    checks: [
      helperSessions("designer", 1),
      noErrorsFrom("designer"),
      helperContinued("designer"),
      workFiles("spec", "a spec was written", /^\.ecmwf-multi-agents\/design\/[^/]+\/spec\.md$/),
      notWrittenBy("lead", "lead wrote no design file itself", ".ecmwf-multi-agents/design"),
      noChanges(WORK_FILES, "no project file changed (work files allowed)"),
    ],
    baseline: false,
  },
  {
    id: "designer-limit-twice",
    title: "With designer on and a very low step limit: it reaches the limit twice in one session, and lead offers a higher limit through the question tool",
    setup: [projectAgents({ designer: { enabled: true, steps: 6 } })],
    turns: [
      {
        turn: {
          kind: "prompt",
          text:
            "Design a web page for the stations' weekly summaries: a calendar of weeks, each week's mean, minimum and maximum, and a chart of the year. " +
            "I want the design and a prototype I can open in a browser; do not change the package.",
        },
      },
    ],
    checks: [
      noErrorsFrom("designer"),
      helperContinued("designer"),
      askedUser("steps-offer", "lead asked whether to raise the designer's step limit", ["designer", { label: "step", any: [/step/i] }, { label: "9", any: [/\b9\b/] }]),
      settingRaised("designer", 6),
      noChanges(new RegExp(`${WORK_FILES.source}|^\\.opencode/ecmwf-multi-agents\\.jsonc$`), "no project file changed (work files and the project's settings allowed)"),
    ],
    baseline: false,
  },
];
