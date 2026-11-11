// SPDX-FileCopyrightText: 2026 European Centre for Medium-Range Weather Forecasts (ECMWF)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { OFFER_PREFIX, Offers, fileStore, type OfferStore } from "./offers.ts";
import { fakeEnvironment } from "./testing.ts";

const files = { project: "/repo/.opencode/ecmwf-multi-agents.jsonc", user: "/home/u/.config/opencode/ecmwf-multi-agents.jsonc" };

class MemoryStore implements OfferStore {
  saved: string[] | undefined;
  constructor(public made: string[] = []) {}
  read(): string[] {
    return this.made;
  }
  add(made: string[]): void {
    this.made = [...this.made, ...made];
    this.saved = made;
  }
}

function makeOffers(store: OfferStore | null = new MemoryStore(), limits: Record<string, number> = { designer: 40, scout: 30 }) {
  return new Offers({ name: "ecmwf-multi-agents", files, store, limit: (agent) => limits[agent] });
}

describe("step limits", () => {
  test("the same helper at its limit a second time in a session: one note for lead in that session, with the limit, a suggestion, both files and the cost", () => {
    const offers = makeOffers();
    offers.stepLimit("root", "designer", "child-1:12");
    expect(offers.take("root")).toEqual([]);
    offers.stepLimit("root", "designer", "child-2:30");
    const notes = offers.take("root");
    expect(notes).toHaveLength(1);
    const note = notes[0]!;
    expect(note.startsWith(OFFER_PREFIX)).toBe(true);
    expect(note).toContain("designer reached its step limit of 40 twice in this session");
    expect(note).toContain('"agents": { "designer": { "steps": 60 } }');
    expect(note).toContain(files.project);
    expect(note).toContain(files.user);
    expect(note).toContain("restarts");
    expect(note).toContain("cost");
    // Taken once; a third hit in the same session asks nothing more.
    expect(offers.take("root")).toEqual([]);
    offers.stepLimit("root", "designer", "child-3:9");
    expect(offers.take("root")).toEqual([]);
  });

  test("a repeat of the same request counts once; other helpers and other sessions count apart", () => {
    const offers = makeOffers();
    offers.stepLimit("root", "designer", "child-1:12");
    offers.stepLimit("root", "designer", "child-1:12");
    offers.stepLimit("root", "scout", "child-2:5");
    offers.stepLimit("other", "designer", "child-3:5");
    expect(offers.take("root")).toEqual([]);
    expect(offers.take("other")).toEqual([]);
  });

  test("no note without a known limit", () => {
    const offers = makeOffers(undefined, {});
    offers.stepLimit("root", "designer", "a:1");
    offers.stepLimit("root", "designer", "b:1");
    expect(offers.take("root")).toEqual([]);
  });

  test("the suggestion is half as much again, rounded up", () => {
    const offers = makeOffers(undefined, { designer: 15 });
    offers.stepLimit("root", "designer", "a:1");
    offers.stepLimit("root", "designer", "b:1");
    expect(offers.take("root")[0]).toContain('"steps": 23');
  });
});

describe("fallback models", () => {
  const chosen = { id: "reviewer", model: "anthropic/claude-opus-5-5", effort: "high", own: "github-copilot/gpt-6.1-sol" };

  test("a fallback in use: one note for lead's next request in any session, with the project file only, and it is recorded", () => {
    const store = new MemoryStore();
    const offers = makeOffers(store);
    offers.fallback(chosen);
    const note = offers.take("root")[0]!;
    expect(note.startsWith(OFFER_PREFIX)).toBe(true);
    expect(note).toContain("reviewer runs on anthropic/claude-opus-5-5, its fallback, because github-copilot/gpt-6.1-sol is not available");
    expect(note).toContain('"agents": { "reviewer": { "model": "anthropic/claude-opus-5-5", "effort": "high" } }');
    expect(note).toContain(files.project);
    expect(note).not.toContain(files.user);
    expect(note).toContain("Do not change the user's own settings file");
    expect(store.saved).toEqual(["fallback reviewer anthropic/claude-opus-5-5"]);
    expect(offers.take("other")).toEqual([]);
  });

  test("asked once per project: a choice already offered, here or in an earlier opencode run, is not offered again", () => {
    const store = new MemoryStore(["fallback reviewer anthropic/claude-opus-5-5"]);
    const offers = makeOffers(store);
    offers.fallback(chosen);
    expect(offers.take("root")).toEqual([]);
    // Another agent, or another model for the same one, is a new offer.
    offers.fallback({ ...chosen, id: "tester" });
    expect(offers.take("root")).toHaveLength(1);
    expect(store.made).toEqual(["fallback reviewer anthropic/claude-opus-5-5", "fallback tester anthropic/claude-opus-5-5"]);
  });

  test("without a project (no store), it is asked once per opencode run", () => {
    const offers = makeOffers(null);
    offers.fallback(chosen);
    offers.fallback(chosen);
    expect(offers.take("root")).toHaveLength(1);
    offers.fallback(chosen);
    expect(offers.take("root")).toEqual([]);
  });

  test("a store that fails to read or write does not stop the offer", () => {
    const broken: OfferStore = {
      read: () => {
        throw new Error("unreadable");
      },
      add: () => {
        throw new Error("read-only");
      },
    };
    const offers = makeOffers(broken);
    offers.fallback(chosen);
    expect(offers.take("root")).toHaveLength(1);
  });

  test("a model without an effort is written without one", () => {
    const offers = makeOffers();
    offers.fallback({ id: "scout", model: "openai/gpt-x", own: "anthropic/sonnet" });
    expect(offers.take("root")[0]).toContain('"agents": { "scout": { "model": "openai/gpt-x" } }');
  });
});

test("the file store keeps one offer per line and only appends", () => {
  const files: Record<string, string> = {};
  const store = fileStore(fakeEnvironment(files), "/repo/.ecmwf-multi-agents/offers");
  expect(store.read()).toEqual([]);
  store.add(["fallback reviewer a/b"]);
  store.add([]);
  store.add(["fallback tester a/b"]);
  expect(files["/repo/.ecmwf-multi-agents/offers"]).toBe("fallback reviewer a/b\nfallback tester a/b\n");
  expect(store.read()).toEqual(["fallback reviewer a/b", "fallback tester a/b"]);
});
