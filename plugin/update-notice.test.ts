// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { UpdateNotice, packageSource, updateAvailable, updateNoticeText, type NoticeView } from "./update-notice.ts";

const NAME = "ecmwf-multi-agents";
const TARGET = "@ecmwf.int/multi-agents";

/** `plugin.list` as opencode 2.2.6 answers it: `{ data: Plugin.Info[] }`. */
function listed(source: Record<string, unknown>, status = "active"): unknown {
  return {
    location: {},
    data: [
      { id: "opencode.agent", source: { type: "builtin" }, features: { server: true }, state: { status: "active" } },
      { id: NAME, source, features: { server: true, tui: true, rpc: true }, state: { status } },
    ],
  };
}

const OUTDATED = { type: "package", target: TARGET, version: "1.0.0", outdated: true };
const CURRENT = { type: "package", target: TARGET, version: "1.0.0" };

function watch(): { notice: UpdateNotice; seen: NoticeView[] } {
  const notice = new UpdateNotice(NAME);
  const seen: NoticeView[] = [];
  notice.onAdd((view) => seen.push(view));
  return { notice, seen };
}

describe("the update notice", () => {
  test("says what to run", () => {
    expect(updateNoticeText(NAME)).toBe("A newer ecmwf-multi-agents is available: run `opencode plugin update`, then restart opencode.");
  });

  test("a package plugin opencode marks outdated: one notice, however often the list is read", () => {
    const { notice, seen } = watch();
    notice.observe(listed(CURRENT));
    expect(seen).toEqual([]);
    notice.observe(listed(OUTDATED));
    notice.observe(listed(OUTDATED));
    notice.observe([...((listed(OUTDATED) as { data: unknown[] }).data)]);
    expect(seen).toEqual([{ notice: updateNoticeText(NAME), id: 1 }]);
    expect(notice.list()).toEqual([{ notice: updateNoticeText(NAME), id: 1 }]);
  });

  test("a checkout or a folder plugin never gets the notice", () => {
    const { notice, seen } = watch();
    notice.observe(listed({ type: "local", path: "/home/user/ecmwf-multi-agents", outdated: true }));
    notice.observe(listed({ type: "builtin" }));
    notice.observe(listed({ type: "sdk" }));
    expect(seen).toEqual([]);
    expect(notice.list()).toEqual([]);
  });

  test("while opencode installs the update: no notice", () => {
    const { notice, seen } = watch();
    notice.observe(listed({ ...OUTDATED, updating: true }));
    expect(seen).toEqual([]);
    expect(notice.list()).toEqual([]);
    // Installed: no longer outdated, and nothing to say.
    notice.observe(listed({ ...CURRENT, updating: true }));
    notice.observe(listed(CURRENT));
    expect(seen).toEqual([]);
  });

  test("shown while updating is hidden then, and not shown again if the update fails", () => {
    const { notice, seen } = watch();
    notice.observe(listed(OUTDATED));
    notice.observe(listed({ ...OUTDATED, updating: true }));
    expect(notice.list()).toEqual([]);
    notice.observe(listed(OUTDATED));
    expect(seen).toHaveLength(1);
    expect(notice.list()).toHaveLength(1);
  });

  test("a list without the plugin's active entry, as during a reload, keeps the notice: no second one", () => {
    const { notice, seen } = watch();
    notice.observe(listed(OUTDATED));
    notice.observe({ location: {}, data: [{ id: "opencode.agent", source: { type: "builtin" }, state: { status: "active" } }] });
    notice.observe(listed(OUTDATED, "activating"));
    expect(notice.list()).toHaveLength(1);
    notice.observe(listed(OUTDATED));
    expect(seen).toHaveLength(1);
    expect(notice.list()).toEqual([seen[0]!]);
  });

  test("cleared and then set again: a new notice", () => {
    const { notice, seen } = watch();
    notice.observe(listed(OUTDATED));
    notice.observe(listed(CURRENT));
    expect(notice.list()).toEqual([]);
    notice.observe(listed(OUTDATED));
    expect(seen.map((view) => view.id)).toEqual([1, 2]);
  });

  test("only the plugin's own active entry counts; a list it cannot read changes nothing", () => {
    const { notice, seen } = watch();
    notice.observe({ data: [{ id: "other", source: OUTDATED, state: { status: "active" } }] });
    // The line's copy that opencode dropped as a duplicate is not the one running.
    notice.observe(listed(OUTDATED, "failed"));
    notice.observe(undefined);
    notice.observe({ data: "nonsense" });
    expect(seen).toEqual([]);
  });

  test("updateAvailable and packageSource read the plugin's own entry", () => {
    expect(updateAvailable(listed(OUTDATED), NAME)).toBe(true);
    expect(updateAvailable(listed({ ...OUTDATED, updating: true }), NAME)).toBe(false);
    expect(updateAvailable(listed(CURRENT), NAME)).toBe(false);
    expect(updateAvailable(listed({ type: "local", path: "/x", outdated: true }), NAME)).toBe(false);
    expect(packageSource(listed(CURRENT), NAME)).toBe(true);
    expect(packageSource(listed({ type: "local", path: "/x" }), NAME)).toBe(false);
    expect(packageSource([], NAME)).toBe(false);
  });

  test("waiting for opencode's check: until the window since the start has passed, or a notice came", async () => {
    let now = 1_000;
    const notice = new UpdateNotice(NAME, () => now);
    now = 1_010;
    const started = Date.now();
    await notice.checked(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    now = 2_000;
    const late = Date.now();
    await notice.checked(30);
    expect(Date.now() - late).toBeLessThan(15);
    now = 1_000;
    const waiting = notice.checked(10_000);
    notice.observe(listed(OUTDATED));
    await waiting;
  });
});
