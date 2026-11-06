// tests/unit/whatsnew/list-integrity.test.ts
// Proof 1 of docs/contracts/whats-new-v0.md section 7, for the PUBLIC list: unique kebab-case ids, both languages in every field, the caps (40, 140, 70, 100), `go` is a whole tab, a released version has a date,
// no character of the hidden-characters table, no internal reference. (The words a public list must not hold, and the uniqueness across both lists, are checked in tests/unit/private/, which the release deletes.)
import { describe, it, expect } from "vitest";
import { NEWS_ITEMS, NEWS_VERSIONS } from "@/whatsnew/items";
import { TAB_IDS } from "@/components/messenger/MessengerShell";
import { extraNews } from "../../../dashboard/src/extra-empty";
import type { NewsItem } from "@/whatsnew/types";
import { problemsOf } from "./integrity";

const ok: NewsItem = { id: "v01-example", since: "v0.1", title: { pt: "Exemplo", en: "Example" }, what: { pt: "Faz uma coisa.", en: "Does one thing." }, where: { pt: "Hoje", en: "Today" } };
const text = (n: number) => "x".repeat(n);

describe("the public list", () => {
  it("has nothing wrong: ids, both languages, caps, `go`, versions, hidden characters, internal references", () => {
    expect(problemsOf(NEWS_ITEMS, NEWS_VERSIONS)).toEqual([]);
  });
  it("has items, and every version it names is a version it describes", () => {
    expect(NEWS_ITEMS.length).toBeGreaterThan(0);
    expect(NEWS_VERSIONS.map((v) => v.version)).toEqual(expect.arrayContaining([...new Set(NEWS_ITEMS.map((i) => i.since))]));
  });
  it("the shell exports its tab ids once, and each `go` of the list is one of them", () => {
    for (const item of NEWS_ITEMS) if (item.go) expect(TAB_IDS).toContain(item.go);
    expect(new Set(TAB_IDS).size).toBe(TAB_IDS.length);
  });
  it("the public build's extension point carries no news of its own", () => {
    expect(extraNews).toEqual([]);
  });
});

describe("the check sees what it must (a list made wrong on purpose)", () => {
  const versions = [{ version: "v0.1" as const, status: "released" as const, date: "2026-10-03" }];
  const wrong = (patch: Partial<NewsItem>, extra: NewsItem[] = []) => problemsOf([{ ...ok, ...patch } as NewsItem, ...extra], versions).join(" | ");
  it("a good item has no problem", () => expect(problemsOf([ok], versions)).toEqual([]));
  it("a repeated id", () => expect(problemsOf([ok, ok], versions).join()).toMatch(/duplicate id/));
  it("an id that is not kebab-case", () => expect(wrong({ id: "V01_Example" })).toMatch(/kebab/));
  it("a missing or empty language", () => {
    expect(wrong({ what: { pt: "Faz.", en: "" } })).toMatch(/what\.en is empty/);
    expect(wrong({ title: undefined as never })).toMatch(/title missing/);
  });
  it("each cap: 40, 140, 70, 100", () => {
    expect(wrong({ title: { pt: text(41), en: "ok" } })).toMatch(/title\.pt is over 40/);
    expect(wrong({ what: { pt: "ok", en: text(141) } })).toMatch(/what\.en is over 140/);
    expect(wrong({ where: { pt: text(71), en: "ok" } })).toMatch(/where\.pt is over 70/);
    expect(wrong({ note: { pt: text(101), en: "ok" } })).toMatch(/note\.pt is over 100/);
    expect(wrong({ title: { pt: text(40), en: text(40) }, what: { pt: text(140), en: text(140) }, where: { pt: text(70), en: text(70) }, note: { pt: text(100), en: text(100) } })).toBe("");
  });
  it("a `go` that is not a whole tab", () => expect(wrong({ go: "perfil-do-bot" })).toMatch(/not a whole tab/));
  it("a version that was not described, a released version without a date", () => {
    expect(wrong({ since: "v0.3" })).toMatch(/no version entry/);
    expect(problemsOf([ok], [{ version: "v0.1", status: "released" }]).join()).toMatch(/released needs a date/);
  });
  it("a character of the hidden-characters table: a zero-width space, an override", () => {
    expect(wrong({ what: { pt: "a" + String.fromCodePoint(0x200b) + "b", en: "ok" } })).toMatch(/hidden-characters/);
    expect(wrong({ title: { pt: "ok", en: "a" + String.fromCodePoint(0x202e) } })).toMatch(/hidden-characters/);
  });
  it("an internal reference: a decision number, a task, an issue, an agent's name", () => {
    for (const bad of ["Veja o A-231", "ver R-15c", "ADR-007", "T-12", "issue #482", "feito pelo Prumo", "pedido do Maestro"]) expect(wrong({ what: { pt: bad, en: "ok" } })).toMatch(/internal reference/);
  });
});
