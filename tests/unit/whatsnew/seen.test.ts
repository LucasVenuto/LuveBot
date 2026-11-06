// tests/unit/whatsnew/seen.test.ts
// Proof 2 of docs/contracts/whats-new-v0.md section 7: the "new" mark. A device that never came marks the older versions seen at once; an item added by an update shows the dot; leaving the screen marks
// everything seen; storage that throws, is absent or holds garbage gives NO dot and NO tag (and the value is not touched); at most 500 ids are kept; an item hidden by its `feature` does not count.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNews } from "@/whatsnew/useNews";
import { SEEN_KEY, MAX_SEEN } from "@/whatsnew/seen";
import type { NewsItem, NewsVersionInfo } from "@/whatsnew/types";

const VERSIONS: NewsVersionInfo[] = [{ version: "v0.2", status: "unreleased" }, { version: "v0.1", status: "released", date: "2026-10-03" }];
const item = (id: string, since: NewsItem["since"], more: Partial<NewsItem> = {}): NewsItem => ({ id, since, title: { pt: id, en: id }, what: { pt: "x", en: "x" }, where: { pt: "Hoje", en: "Today" }, ...more });
const OLD = item("v01-a", "v0.1"), NEW1 = item("v02-b", "v0.2"), NEW2 = item("v02-c", "v0.2");
const LIST = [OLD, NEW1];
const REAL = window.localStorage;   // the test environment's own storage object (tests/setup.ts), kept so every test can put it back
const stored = () => REAL.getItem(SEEN_KEY);
const ids = () => (JSON.parse(stored() as string) as { v: number; ids: string[] }).ids;
const mount = (list: readonly NewsItem[] = LIST, features: Record<string, unknown> = {}) => renderHook(() => useNews(features, list, VERSIONS));
const quiet = (r: { result: { current: ReturnType<typeof useNews> } }, list: readonly NewsItem[]) => {
  expect(r.result.current.hasNew).toBe(false);
  for (const i of list) expect(r.result.current.isNew(i.id)).toBe(false);
};

const back = () => Object.defineProperty(window, "localStorage", { value: REAL, configurable: true, writable: true });
beforeEach(() => { back(); REAL.clear(); });
afterEach(() => { vi.restoreAllMocks(); back(); REAL.clear(); });

describe("the first visit of a device", () => {
  it("marks the older versions seen at once: only the newest version carries the dot and the tag", () => {
    const r = mount();
    expect(r.result.current.hasNew).toBe(true);
    expect(r.result.current.isNew(NEW1.id)).toBe(true);
    expect(r.result.current.isNew(OLD.id)).toBe(false);
    expect(JSON.parse(stored() as string)).toEqual({ v: 1, ids: ["v01-a"] });   // written down at once, and only the older ones
  });
  it("a list with nothing in the newest version has no dot", () => {
    quiet(mount([OLD]), [OLD]);
  });
});

describe("after an update", () => {
  it("an item that this device has not seen shows the dot and the tag; the ones it has seen do not", () => {
    REAL.setItem(SEEN_KEY, JSON.stringify({ v: 1, ids: ["v01-a", "v02-b"] }));
    const r = mount([OLD, NEW1, NEW2]);
    expect(r.result.current.hasNew).toBe(true);
    expect(r.result.current.isNew("v02-c")).toBe(true);
    expect(r.result.current.isNew("v02-b")).toBe(false);
  });
});

describe("leaving the screen", () => {
  it("the tags stay for the visit; leaving marks everything seen, remembers it, and the next load has no dot", () => {
    const r = mount();
    expect(r.result.current.isNew(NEW1.id)).toBe(true);             // during the visit
    act(() => r.result.current.leave());
    quiet(r, LIST);
    expect(ids().sort()).toEqual(["v01-a", "v02-b"]);
    quiet(mount(), LIST);                                            // a new load of the app
  });
  it("marks only what the screen showed: an item the host hides stays unseen, and is new the day it shows", () => {
    const hidden = item("v02-gated", "v0.2", { feature: "gated" });
    const list = [OLD, NEW1, hidden];
    const r = mount(list, {});
    act(() => r.result.current.leave());
    expect(ids()).not.toContain("v02-gated");
    const later = mount(list, { gated: "ok" });
    expect(later.result.current.isNew("v02-gated")).toBe(true);
    expect(later.result.current.hasNew).toBe(true);
  });
});

describe("an item hidden by its feature", () => {
  it("does not count for the dot, and is not on the screen", () => {
    const hidden = item("v02-gated", "v0.2", { feature: "gated" });
    REAL.setItem(SEEN_KEY, JSON.stringify({ v: 1, ids: ["v01-a", "v02-b"] }));
    const off = mount([OLD, NEW1, hidden], {});
    expect(off.result.current.hasNew).toBe(false);
    expect(off.result.current.items.map((i) => i.id)).toEqual(["v01-a", "v02-b"]);
    const on = mount([OLD, NEW1, hidden], { gated: "ok" });
    expect(on.result.current.hasNew).toBe(true);
    expect(on.result.current.items.map((i) => i.id)).toContain("v02-gated");
  });
});

describe("storage that cannot be trusted: no dot, no tag, no crash", () => {
  it("a read that throws", () => {
    vi.spyOn(REAL, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const r = mount();
    quiet(r, LIST);
    expect(() => act(() => r.result.current.leave())).not.toThrow();
  });
  it("a write that throws (a first visit that cannot be written down would come back at every load)", () => {
    vi.spyOn(REAL, "setItem").mockImplementation(() => { throw new Error("quota"); });
    const r = mount();
    quiet(r, LIST);
    expect(() => act(() => r.result.current.leave())).not.toThrow();
  });
  it("no storage at all: the property throws, or is missing", () => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); }, configurable: true });
    quiet(mount(), LIST);
    Object.defineProperty(window, "localStorage", { value: undefined, configurable: true });
    quiet(mount(), LIST);
  });
  it("garbage in the key: every shape that is not {v:1, ids:[strings]} gives no dot and no tag, and the value is left as it was", () => {
    for (const garbage of ["not json", "{}", '{"v":2,"ids":[]}', '{"v":1,"ids":"x"}', '{"v":1,"ids":[1]}', "null", "[]", '"text"', "7"]) {
      REAL.setItem(SEEN_KEY, garbage);
      const r = mount();
      quiet(r, LIST);
      act(() => r.result.current.leave());
      expect(stored()).toBe(garbage);
    }
  });
});

describe("the cap", () => {
  const many = Array.from({ length: MAX_SEEN + 100 }, (_, n) => item(`v02-item-${n}`, "v0.2"));
  it("at most 500 ids are kept, the newest ones, even when the list is larger", () => {
    REAL.setItem(SEEN_KEY, JSON.stringify({ v: 1, ids: many.slice(0, 50).map((i) => i.id) }));
    const r = mount(many);
    act(() => r.result.current.leave());
    expect(ids()).toHaveLength(MAX_SEEN);
    expect(ids()[MAX_SEEN - 1]).toBe(many[many.length - 1].id);
  });
  it("a stored value with more than 500 ids is read at most 500 and written back at most 500", () => {
    REAL.setItem(SEEN_KEY, JSON.stringify({ v: 1, ids: many.map((i) => i.id) }));
    const r = mount(many);
    act(() => r.result.current.leave());
    expect(ids().length).toBeLessThanOrEqual(MAX_SEEN);
  });
});
