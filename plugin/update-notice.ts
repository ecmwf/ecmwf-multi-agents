// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

// Telling the user that a newer harness is available. opencode never installs a plugin update by
// itself: it checks a package plugin about once a day and marks it outdated in `plugin.list`
// (`source.outdated` and, while it installs one, `source.updating`; Plugin.Source in
// schema/src/plugin.ts, PluginSupervisor in core/src/plugin/supervisor.ts, opencode 2.2.6). The
// check runs after activation, and when it changes what is outdated opencode lists the plugins
// again and publishes `plugin.updated`. The plugin reads the list then, and the RPC passes the
// notice on to the TUI entry (rpc.ts, tui.ts); the model never sees it. A checkout or a folder
// plugin is not a package and is never outdated.

import { unwrap } from "./register.ts";
import type { NoticeView } from "./rpc-definition.ts";

export type { NoticeView };

export function updateNoticeText(name: string): string {
  // Plain text: opencode's toast shows Markdown as it is.
  return `A newer ${name} is available: run opencode plugin update, then restart opencode.`;
}

interface Source {
  type?: unknown;
  outdated?: unknown;
  updating?: unknown;
}

/** The source of the plugin's own entry: the active one with its id, not a copy opencode dropped. */
function ownSource(plugins: unknown, id: string): Source | undefined {
  const list = unwrap<unknown>(plugins);
  if (!Array.isArray(list)) return undefined;
  const entry = list.find((item) => item !== null && typeof item === "object" && item.id === id && item.state?.status === "active") as { source?: unknown } | undefined;
  const source = entry?.source;
  return source !== null && typeof source === "object" ? (source as Source) : undefined;
}

/** Whether opencode loaded the plugin as a package, the only kind it checks for updates. */
export function packageSource(plugins: unknown, id: string): boolean {
  return ownSource(plugins, id)?.type === "package";
}

/** Whether opencode marks the plugin's own package outdated and is not installing the update. */
export function updateAvailable(plugins: unknown, id: string): boolean {
  const source = ownSource(plugins, id);
  return source?.type === "package" && source.outdated === true && source.updating !== true;
}

/** The notice for one harness: published once, and again only after opencode cleared the mark and set it again. */
export class UpdateNotice {
  private current: NoticeView | undefined;
  private updating = false;
  private count = 0;
  /** One listener for each location's RPC: one opencode serves several locations. */
  private readonly emitters = new Set<(notice: NoticeView) => void>();
  private waiters: Array<() => void> = [];
  private readonly started: number;

  constructor(
    readonly name: string,
    private readonly now: () => number = Date.now,
  ) {
    this.started = now();
  }

  /**
   * Read `plugin.list`'s answer. Only the plugin's own active entry changes the notice: a list
   * without it (one opencode cannot give, or one taken while the plugin reloads) leaves it as it
   * is, so the same update is not announced twice.
   */
  observe(plugins: unknown): void {
    const source = ownSource(plugins, this.name);
    if (source === undefined) return;
    if (source.type !== "package" || source.outdated !== true) {
      this.current = undefined;
      this.updating = false;
      return;
    }
    this.updating = source.updating === true;
    if (this.updating || this.current !== undefined) return;
    this.current = { notice: updateNoticeText(this.name), id: ++this.count };
    for (const emit of this.emitters) emit(this.current);
    for (const wake of this.waiters.splice(0)) wake();
  }

  list(): NoticeView[] {
    return this.current === undefined || this.updating ? [] : [this.current];
  }

  /** Publish each new notice from now on, until the returned function is called. */
  onAdd(emit: (notice: NoticeView) => void): () => void {
    const own = (notice: NoticeView) => emit(notice);
    this.emitters.add(own);
    return () => void this.emitters.delete(own);
  }

  /**
   * Resolves once opencode has probably checked: `windowMs` after this notice was made, or as
   * soon as a notice comes. opencode does not say when its check ends, and says nothing when it
   * finds the plugin up to date.
   */
  checked(windowMs: number): Promise<void> {
    const left = this.started + windowMs - this.now();
    if (left <= 0 || this.current !== undefined) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, left);
      (timer as { unref?: () => void }).unref?.();
      const waiters = this.waiters;
      function done() {
        clearTimeout(timer);
        const index = waiters.indexOf(done);
        if (index !== -1) waiters.splice(index, 1);
        resolve();
      }
      waiters.push(done);
    });
  }
}

const shared = new Map<string, UpdateNotice>();

/**
 * The notice for this process. opencode sets the plugin up again when a plugin before it changes;
 * the notice stays the same, so the user is not told twice.
 */
export function processNotice(name: string): UpdateNotice {
  let notice = shared.get(name);
  if (notice === undefined) {
    notice = new UpdateNotice(name);
    shared.set(name, notice);
  }
  return notice;
}
