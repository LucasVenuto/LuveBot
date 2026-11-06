// tests/unit/whatsnew/app.test.tsx
// The pieces of "Novidades" wired in the app (docs/contracts/whats-new-v0.md sections 2 and 3): on a device that never came, the entry has the dot; opening the screen and leaving it clears the dot and
// remembers it across a reload; "Abrir" leaves the screen for the tab, the way the rail does.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { LuveBotApp } from "@/index";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { NEWS_ITEMS } from "@/whatsnew/items";
import { SEEN_KEY } from "@/whatsnew/seen";

const STORAGE = window.localStorage;   // the test environment's storage object, put back after the test that breaks it
vi.setConfig({ testTimeout: 30_000 });   // the whole app is rendered: a loaded machine needs more than 5 s
beforeEach(() => {
  Object.defineProperty(window, "localStorage", { value: STORAGE, configurable: true, writable: true });
  cleanup(); resetCsrfToken(); localStorage.clear();
  setCustomFetchJSON(async (url: string) => {
    if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
    if (url.endsWith("/health")) return { ok: true, features: {}, problems: [] };
    if (/\/bots$/.test(url)) return { bots: [] };
    return {};
  });
});
afterEach(() => { cleanup(); setCustomFetchJSON(null); });

const rail = async () => within(await screen.findByRole("navigation", { name: "Navegação Principal" }));

describe("in the app", () => {
  it("a device that never came: the entry has the dot; opening and leaving clears it, and a reload keeps it cleared", async () => {
    render(<LuveBotApp />);
    const first = await rail();
    fireEvent.click(await first.findByRole("button", { name: "Novidades, há novidades" }));
    await screen.findByRole("heading", { level: 1, name: "Novidades" });
    expect(first.getByRole("button", { name: "Novidades, há novidades" })).toBeTruthy();   // the tags and the dot stay for the visit
    expect(screen.getAllByText("novo").length).toBeGreaterThan(0);
    fireEvent.click(first.getByRole("button", { name: /^Hoje/ }));                            // leaving
    await waitFor(() => expect(first.getByRole("button", { name: "Novidades" })).toBeTruthy());
    expect(first.queryByRole("button", { name: /há novidades/ })).toBeNull();
    expect((JSON.parse(localStorage.getItem(SEEN_KEY) as string) as { ids: string[] }).ids).toEqual(expect.arrayContaining(NEWS_ITEMS.map((i) => i.id)));
    cleanup();
    render(<LuveBotApp />);                                                                   // a reload
    expect(await (await rail()).findByRole("button", { name: "Novidades" })).toBeTruthy();
    expect((await rail()).queryByRole("button", { name: /há novidades/ })).toBeNull();
  });

  it("'Abrir' takes the person to the tab and the Novidades screen goes away", async () => {
    render(<LuveBotApp />);
    fireEvent.click(await (await rail()).findByRole("button", { name: /^Novidades/ }));
    await screen.findByRole("heading", { level: 1, name: "Novidades" });
    const other = NEWS_ITEMS.find((i) => i.go && i.go !== "novidades");                       // an item that leads somewhere else (the one for this very screen would stay)
    expect(other).toBeDefined();
    fireEvent.click(await screen.findByRole("button", { name: `Abrir ${other?.title.pt}` }));
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Novidades" })).toBeNull());
  });

  it("a device whose storage is unusable never sees the dot or the tag, and the screen still opens", async () => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); }, configurable: true });
    try {
      render(<LuveBotApp />);
      const nav = await rail();
      expect(nav.queryByRole("button", { name: /há novidades/ })).toBeNull();
      fireEvent.click(nav.getByRole("button", { name: "Novidades" }));
      await screen.findByRole("heading", { level: 1, name: "Novidades" });
      expect(screen.queryByText("novo")).toBeNull();
    } finally {
      Object.defineProperty(window, "localStorage", { value: STORAGE, configurable: true, writable: true });
    }
  });
});
