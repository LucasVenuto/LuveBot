// tests/unit/whatsnew/screen.test.tsx
// Proof 3 of docs/contracts/whats-new-v0.md section 7: the screen. Versions newest first, the newest open and the older ones closed, each saying in words whether it is released; each item draws its sentence and its
// "Onde achar"; "Abrir" calls the tab change with the right id and exists only with a `go`; the text is a text node (a `<b>` in it is drawn as characters); the tag "novo" follows `isNew`; leaving the screen
// (and only leaving) calls `onLeave`. The items are the test's own, so the content of the real list can change freely.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { WhatsNewScreen, newsDate } from "@/whatsnew/WhatsNewScreen";
import { setLuveLocale } from "@/i18n";
import type { NewsItem, NewsVersionInfo } from "@/whatsnew/types";

const item = (id: string, since: NewsItem["since"], more: Partial<NewsItem> = {}): NewsItem => ({
  id, since, title: { pt: `Titulo ${id}`, en: `Title ${id}` }, what: { pt: `Faz ${id}.`, en: `Does ${id}.` }, where: { pt: `Tela ${id} › Aba`, en: `Screen ${id} › Tab` }, ...more,
});
const VERSIONS: NewsVersionInfo[] = [{ version: "v0.1", status: "released", date: "2026-10-03" }, { version: "v0.3", status: "unreleased" }, { version: "v0.2", status: "unreleased" }];   // out of order on purpose
const ITEMS: NewsItem[] = [item("a", "v0.1", { go: "aprovacoes" }), item("b", "v0.3", { go: "regras", note: { pt: "Precisa de uma chave.", en: "Needs a key." } }), item("c", "v0.2"), item("d", "v0.3")];

const show = (over: Partial<React.ComponentProps<typeof WhatsNewScreen>> = {}) => {
  const props = { items: ITEMS, versions: VERSIONS, isNew: () => false, onOpenTab: vi.fn(), onLeave: vi.fn(), ...over };
  return { ...render(<WhatsNewScreen {...props} />), props };
};
afterEach(() => { cleanup(); setLuveLocale("pt"); });

describe("the versions", () => {
  it("newest first, whatever the order they were given in", () => {
    show();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["v0.3", "v0.2", "v0.1"]);
  });
  it("the newest is open and the older ones are closed (a native details)", () => {
    const { container } = show();
    expect([...container.querySelectorAll("details")].map((d) => d.open)).toEqual([true, false, false]);
  });
  it("each says in words whether it was released; a version with no item to show is not drawn", () => {
    show();
    expect(screen.getByText("Lançada em 3/10/2026")).toBeTruthy();
    expect(screen.getAllByText("Em teste, ainda não lançada")).toHaveLength(2);
    cleanup();
    show({ items: ITEMS.filter((i) => i.since !== "v0.2") });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["v0.3", "v0.1"]);
  });
  it("in English: the date reads '3 Oct 2026' and the words are the English ones", () => {
    setLuveLocale("en");
    show();
    expect(screen.getByText("Released on 3 Oct 2026")).toBeTruthy();
    expect(screen.getAllByText("Being tested, not released yet")).toHaveLength(2);
    expect(screen.getByText("Title b")).toBeTruthy();
    expect(screen.getAllByText("Where to find it").length).toBeGreaterThan(0);
  });
  it("the dates are written by hand, in both forms, and a text that is not a date is shown as it is", () => {
    expect(newsDate("2026-10-03", "pt")).toBe("3/10/2026");
    expect(newsDate("2026-10-03", "en")).toBe("3 Oct 2026");
    expect(newsDate("2026-12-25", "en")).toBe("25 Dec 2026");
    expect(newsDate("soon", "pt")).toBe("soon");
  });
});

describe("an item", () => {
  it("draws its title, its sentence, 'Onde achar' with the path, and the note when there is one", () => {
    show();
    const li = screen.getByText("Titulo b").closest("li") as HTMLElement;
    expect(within(li).getByText("Faz b.")).toBeTruthy();
    expect(li.textContent).toContain("Onde achar: Tela b › Aba");
    expect(within(li).getByText("Precisa de uma chave.")).toBeTruthy();
    expect((screen.getByText("Titulo d").closest("li") as HTMLElement).textContent).not.toContain("Precisa");   // no note, none drawn
  });
  it("'Abrir' exists only with a `go`, and calls the tab change with that id", () => {
    const { props } = show();
    expect(screen.getAllByRole("button", { name: /^Abrir/ })).toHaveLength(2);     // b (regras) and, in the closed v0.1, a (aprovacoes): a closed details still holds its buttons
    fireEvent.click(screen.getByRole("button", { name: "Abrir Titulo b" }));
    expect(props.onOpenTab).toHaveBeenCalledTimes(1);
    expect(props.onOpenTab).toHaveBeenCalledWith("regras");
    fireEvent.click(screen.getByRole("button", { name: "Abrir Titulo a" }));
    expect(props.onOpenTab).toHaveBeenLastCalledWith("aprovacoes");
    expect((screen.getByText("Titulo d").closest("li") as HTMLElement).querySelector("button")).toBeNull();
    expect((screen.getByText("Titulo c").closest("li") as HTMLElement).querySelector("button")).toBeNull();
  });
  it("the tag 'novo' follows isNew, and only that", () => {
    show({ isNew: (id) => id === "b" });
    expect(screen.getAllByText("novo")).toHaveLength(1);
    expect((screen.getByText("Titulo b").closest("li") as HTMLElement).textContent).toContain("novo");
  });
  it("the text is a text node: a <b> or an <img> in it is drawn as characters, never as markup", () => {
    const hostile = item("h", "v0.3", { what: { pt: "<b>forte</b> e <img src=x onerror=alert(1)>", en: "x" }, title: { pt: "<i>t</i>", en: "t" }, where: { pt: "<u>w</u>", en: "w" }, note: { pt: "<a href=x>n</a>", en: "n" } });
    const { container } = show({ items: [hostile], versions: [{ version: "v0.3", status: "unreleased" }] });
    const li = container.querySelector("li") as HTMLElement;
    expect(li.textContent).toContain("<b>forte</b> e <img src=x onerror=alert(1)>");
    expect(li.textContent).toContain("<i>t</i>");
    expect(li.textContent).toContain("<a href=x>n</a>");
    expect(li.querySelectorAll("b, i, u, a, img, script")).toHaveLength(0);
  });
});

describe("leaving", () => {
  it("calls onLeave when the screen goes away, and not before", () => {
    const { props, unmount } = show();
    expect(props.onLeave).not.toHaveBeenCalled();
    unmount();
    expect(props.onLeave).toHaveBeenCalledTimes(1);
  });
});

describe("empty, order of the headings, keyboard, phone width", () => {
  it("with nothing to show it says so", () => {
    show({ items: [] });
    expect(screen.getByRole("status").textContent).toBe("Nada novo para mostrar por enquanto.");
    expect(document.querySelector("details")).toBeNull();
  });
  it("the headings keep their order: one h1, then each version h2, then its items h3 (no level is skipped)", () => {
    show();
    const levels = [...document.querySelectorAll("h1, h2, h3")].map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(1);
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    for (let n = 1; n < levels.length; n++) expect(levels[n] - levels[n - 1]).toBeLessThanOrEqual(1);
  });
  it("every control takes the keyboard: the summaries and the buttons are not taken out of the tab order", () => {
    show();
    for (const el of [...document.querySelectorAll("summary, button")]) expect(el.getAttribute("tabindex")).not.toBe("-1");
    expect(document.querySelectorAll("summary")).toHaveLength(3);
  });
  it("a 390 px phone reads without sideways scroll: the column has no fixed width, and long words break inside each item", () => {
    const { container } = show({ items: [item("long", "v0.3", { title: { pt: "T".repeat(80), en: "T" }, what: { pt: "u".repeat(140), en: "u" }, where: { pt: "W".repeat(70), en: "w" } })], versions: [{ version: "v0.3", status: "unreleased" }] });
    const column = container.firstElementChild?.firstElementChild as HTMLElement;
    expect(column.style.maxWidth).toBe("760px");
    expect(parseFloat(column.style.minWidth)).toBe(0);
    expect(column.style.width).toBe("");
    for (const li of container.querySelectorAll("li")) expect((li as HTMLElement).style.overflowWrap).toBe("anywhere");
    for (const el of container.querySelectorAll<HTMLElement>("*")) if (el.style.width.endsWith("px")) expect(parseFloat(el.style.width)).toBeLessThanOrEqual(390);
  });
});
