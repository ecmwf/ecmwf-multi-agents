// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Settings changes the plugin offers the user through lead. The plugin notices the situation and
// words the offer; lead reads it as a note at the end of its next request in the user's session
// and asks the user with the question tool, changing a settings file only on a yes (lead's
// prompt, "Asking the user"). The note is not stored in the session: it is in one request only.
//
// - A helper that reaches its step limit a second time in one session: raise its `steps`, in the
//   project's file or the user's own. Counted again in each session.
// - An agent that runs on a fallback model: keep that model for this project, in the project's
//   file only. Asked once per project; what was offered is kept in the work folder.

import type { Environment } from "./types.ts";

/** How every note starts, so lead and the tests can tell it from the user's own words. */
export const OFFER_PREFIX = "Note from the ecmwf-multi-agents plugin, not from the user:";

/** Where offers made in this project are kept: one line per offer. */
export interface OfferStore {
  read(): string[];
  /** Keep these offers too. */
  add(made: string[]): void;
}

export interface OfferDeps {
  name: string;
  /** The settings files a note names. */
  files: { project?: string; user: string };
  /** null: no project, so fallback offers are remembered for this run only. */
  store: OfferStore | null;
  /** An agent's step limit as it runs: the settings', else its own. */
  limit: (agent: string) => number | undefined;
}

/** An agent on a fallback: its id, the chosen model and effort, and its own model. */
export interface FallbackInUse {
  id: string;
  model: string;
  effort?: string;
  own: string;
}

export class Offers {
  /** Step-limit hits by session and helper, each counted once by its request key. */
  private readonly hits = new Map<string, Set<string>>();
  private readonly session = new Map<string, string[]>();
  /** Notes for lead's next request in any session, by offer key. */
  private readonly anywhere = new Map<string, string>();
  private offered: Set<string> | undefined;

  constructor(private readonly deps: OfferDeps) {}

  /**
   * A helper's request ended at its step limit. `request` tells a repeat of the same request
   * (opencode may send it again) from a new hit. On the second hit in a session, lead gets a note.
   */
  stepLimit(root: string, helper: string, request: string): void {
    const key = `${root}\n${helper}`;
    const seen = this.hits.get(key) ?? new Set<string>();
    this.hits.set(key, seen);
    if (seen.has(request)) return;
    seen.add(request);
    const limit = this.deps.limit(helper);
    if (seen.size !== 2 || limit === undefined) return;
    const raised = Math.ceil(limit * 1.5);
    const where = this.deps.files.project === undefined ? `in ${this.deps.files.user}` : `in ${this.deps.files.project} for this project, or in ${this.deps.files.user} for every project`;
    this.add(
      root,
      `${OFFER_PREFIX} the ${helper} reached its step limit of ${limit} twice in this session. ` +
        `Ask the user with the question tool whether to raise it to ${raised}: set "agents": { "${helper}": { "steps": ${raised} } } ${where}, keeping the file's other settings. ` +
        `Pro: it can finish larger tasks. Con: each of its runs may take up to ${raised} steps, which can cost more. It takes effect when opencode restarts.`,
    );
  }

  /** An agent runs on a fallback; offered once per project. */
  fallback(inUse: FallbackInUse): void {
    const key = `fallback ${inUse.id} ${inUse.model}`;
    if (this.made().has(key) || this.anywhere.has(key)) return;
    const project = this.deps.files.project;
    if (project === undefined) return;
    const entry = `{ "model": "${inUse.model}"${inUse.effort === undefined ? "" : `, "effort": "${inUse.effort}"`} }`;
    const ownProvider = inUse.own.split("/")[0];
    this.anywhere.set(
      key,
      `${OFFER_PREFIX} the ${inUse.id} runs on ${inUse.model}, its fallback, because ${inUse.own} is not available. ` +
        `Ask the user with the question tool whether to keep this for this project: set "agents": { "${inUse.id}": ${entry} } in ${project}, keeping the file's other settings. ` +
        `Pro: the same model at every start, without the notice. Con: the ${inUse.id} stays on it after ${ownProvider} is set up. It takes effect when opencode restarts. Do not change the user's own settings file.`,
    );
  }

  /** The notes for lead's request in this session; each is given once. */
  take(root: string): string[] {
    const notes = this.session.get(root) ?? [];
    this.session.delete(root);
    if (this.anywhere.size === 0) return notes;
    const made = this.made();
    for (const [key, note] of this.anywhere) {
      notes.push(note);
      made.add(key);
    }
    const added = [...this.anywhere.keys()];
    this.anywhere.clear();
    try {
      this.deps.store?.add(added);
    } catch {
      // Not kept: the offer may come again after a restart.
    }
    return notes;
  }

  private add(root: string, note: string): void {
    const notes = this.session.get(root) ?? [];
    notes.push(note);
    this.session.set(root, notes);
  }

  private made(): Set<string> {
    if (this.offered === undefined) {
      try {
        this.offered = new Set(this.deps.store?.read() ?? []);
      } catch {
        this.offered = new Set();
      }
    }
    return this.offered;
  }
}

/** Offers kept in a file of the work folder, one per line. */
export function fileStore(environment: Pick<Environment, "readFile" | "appendFile">, file: string): OfferStore {
  return {
    read: () => (environment.readFile(file) ?? "").split("\n").filter((line) => line !== ""),
    add: (made) => {
      if (made.length > 0) environment.appendFile(file, made.map((line) => `${line}\n`).join(""));
    },
  };
}
