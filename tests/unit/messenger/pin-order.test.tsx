// tests/unit/messenger/pin-order.test.tsx (contract v0.8 section 9)
// The sidebar: pinned in the shared order, then the rest in order, then "Ocultos (N)". Pin, hide and order go to the server
// (PATCH display, PUT /bots/order with EVERY Bot once) and the list is read again; nothing moves before the server has it.
// "Mover para cima/baixo" (phone and keyboard) and drag (PC) stay inside the Bot's own group. Hiding says it pauses nothing.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { ContactList, sidebarGroups, reorder } from "@/components/messenger/ContactList";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";
import type { Bot } from "@/api/types";

const bot = (name: string, display: Partial<NonNullable<Bot["display"]>> = {}): Bot =>
  ({ name, status: "idle", display: { label: name[0].toUpperCase() + name.slice(1), role: "", color: "#60a5fa", avatar: { kind: "initials", value: "XX" }, ...display } } as Bot);
const BOTS = [
  bot("ana", { position: 3 }), bot("bia", { position: 0, pinned: true }), bot("caio", { position: 1 }),
  bot("davi", { position: 2, pinned: true }), bot("eva", { hidden: true, position: 4 }), bot("novo"),
];

let calls: Array<{ url: string; method: string; body: any }>;
let fail = false;
beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt"); calls = []; fail = false;
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (fail) throw Object.assign(new Error("x"), {});
    return url.endsWith("/bots/order") ? { bots: [] } : {};
  });
});
afterEach(() => setCustomFetchJSON(null));

const names = () => Array.from(document.querySelectorAll("button[aria-pressed] .lb-headline")).map((b) => b.textContent);
const menu = (label: string) => { fireEvent.click(screen.getByRole("button", { name: `Opções de ${label}` })); return within(screen.getByRole("menu", { name: `Opções de ${label}` })); };

describe("order", () => {
  it("pinned in order, then the rest in order (never ordered last), then the hidden", () => {
    const g = sidebarGroups(BOTS);
    expect(g.pinned.map((b) => b.name)).toEqual(["bia", "davi"]);
    expect(g.rest.map((b) => b.name)).toEqual(["caio", "ana", "novo"]);
    expect(g.hidden.map((b) => b.name)).toEqual(["eva"]);
    expect(reorder(g, "novo", 0)).toEqual(["bia", "davi", "novo", "caio", "ana", "eva"]);   // every Bot once, inside its group
  });

  it("the sidebar draws that order, a pin mark on the pinned, and 'Ocultos (1)'", () => {
    render(<ContactList bots={BOTS} onBotsChanged={() => {}} />);
    expect(names()).toEqual(["Bia", "Davi", "Caio", "Ana", "Novo"]);
    expect(screen.getAllByRole("img", { name: "Fixado" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Ocultos (1)" })).toBeTruthy();
  });
});

describe("changing it goes to the server, then the list is read again", () => {
  it("'Mover para cima' sends the WHOLE order with the Bot one up in its group; the first of a group has no 'cima'", async () => {
    const changed = vi.fn();
    render(<ContactList bots={BOTS} onBotsChanged={changed} />);
    expect(menu("Caio").queryByRole("menuitem", { name: "Mover para cima" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    menu("Ana").getByRole("menuitem", { name: "Mover para cima" }).click();
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(calls).toEqual([{ url: expect.stringMatching(/\/bots\/order$/), method: "PUT", body: { bots: ["bia", "davi", "ana", "caio", "novo", "eva"] } }]);
    expect(names()).toEqual(["Bia", "Davi", "Caio", "Ana", "Novo"]);   // unchanged until the server's list comes back
  });

  it("pin and hide by PATCH display; hiding says it pauses nothing", async () => {
    const changed = vi.fn();
    render(<ContactList bots={BOTS} onBotsChanged={changed} />);
    menu("Caio").getByRole("menuitem", { name: "Fixar no topo" }).click();
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    const m = menu("Ana");
    expect(m.getByText(translations.pt.botHideHint)).toBeTruthy();
    m.getByRole("menuitem", { name: "Ocultar" }).click();
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(calls.map((c) => [c.method, c.url.replace(/.*luvebot/, ""), c.body])).toEqual([
      ["PATCH", "/bots/caio/display", { pinned: true }], ["PATCH", "/bots/ana/display", { hidden: true }],
    ]);
  });

  it("drag onto a Bot of the same group takes its place; onto another group does nothing", async () => {
    const changed = vi.fn();
    render(<ContactList bots={BOTS} onBotsChanged={changed} />);
    const row = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) , pressed: false });
    const dt = { setData: () => {}, effectAllowed: "" };
    fireEvent.dragStart(row("Novo"), { dataTransfer: dt });
    fireEvent.drop(row("Bia"), { dataTransfer: dt });            // a pinned Bot: another group
    await new Promise((ok) => setTimeout(ok, 50));               // a request would have been recorded by now
    expect(calls).toHaveLength(0);
    fireEvent.dragStart(row("Novo"), { dataTransfer: dt });
    fireEvent.drop(row("Caio"), { dataTransfer: dt });
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(calls[0].body).toEqual({ bots: ["bia", "davi", "novo", "caio", "ana", "eva"] });
  });

  it("a refusal is said, and the list stays as the server has it", async () => {
    fail = true;
    const changed = vi.fn();
    render(<ContactList bots={BOTS} onBotsChanged={changed} />);
    menu("Ana").getByRole("menuitem", { name: "Mover para cima" }).click();
    expect((await screen.findByRole("alert")).textContent).toContain(translations.pt.botsOrderError);
    expect(changed).not.toHaveBeenCalled();
  });
});
