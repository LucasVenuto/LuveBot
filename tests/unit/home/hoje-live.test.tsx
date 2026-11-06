// tests/unit/home/hoje-live.test.tsx
// perf-tela.md item 2: Hoje was a photo. It said "nothing needs you" while its first reads were still on the way, never read again while
// open (the sidebar did, every 15 s), asked /approvals twice at opening, and a decision taken in it did not move the sidebar's "!".
// Now: a column says "loading" (or that the read failed) until a read answered; what it last showed is drawn at once when coming back and read
// again underneath; what needs the person is read every 15 s while visible, what changes slowly at most once a minute; a decision tells the app.
// The tests share the page's last-seen copy, so the order below matters: the cases that need a cold start come first.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor, within } from "@testing-library/react";
import { Hoje } from "@/components/Hoje";
import { getApprovals, setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Approval } from "@/api/types";

const BOTS = [{ name: "vendas", display: { label: "Vendas", role: "", color: "#60a5fa", avatar: { kind: "initials", value: "VE" } }, status: "idle" }] as any[];
const approval = (id: string, over: Partial<Approval> = {}): Approval => ({ request_id: id, bot: "vendas", status: "pending", description: `pedido ${id}`, command_redacted: "git push",
  digest: "dg-" + id, allowed_choices: ["once", "deny"], pattern_keys: [], ...over } as any);

type Gate = { promise: Promise<unknown>; open: (v?: unknown) => void; fail: () => void };
const gate = (): Gate => { let open!: (v?: unknown) => void, fail!: () => void; const promise = new Promise((ok, no) => { open = ok; fail = () => no(new Error("down")); }); return { promise, open, fail }; };
let asked: string[];
let world: { holds: Record<string, Gate>; data: Record<string, unknown>; posts: Array<{ url: string; body: any }> };
const reply = (url: string) => {
  const key = ["/approvals", "/handoffs", "/activity?tab=running", "/activity?tab=done", "/routines", "/costs", "/budget", "/waiting"].find((k) => url.includes(k));
  return key ? { key, data: world.data[key] } : null;
};
function backend() {
  asked = []; world.posts = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
    if (init?.method === "POST") { world.posts.push({ url, body: JSON.parse(String(init.body)) }); return { approval: { status: "decided" } }; }
    const r = reply(url);
    if (!r) throw new Error("unexpected " + url);
    asked.push(r.key);
    if (world.holds[r.key]) await world.holds[r.key].promise;
    return world.data[r.key];                                  // read AFTER the hold: a held read answers with what the world is by then
  });
}
const live = (extra: Record<string, unknown> = {}) => render(<Hoje autoFetch bots={BOTS} {...extra} />);
const SMALL = { "/approvals": { approvals: [] }, "/handoffs": { handoffs: [] }, "/activity?tab=running": { items: [] }, "/activity?tab=done": { items: [] },
  "/routines": { routines: [] }, "/costs": { totals: { spend_cents: 0 } }, "/budget": { limits: [] }, "/waiting": { waiting: [], partial: [] } };

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); world = { holds: {}, data: { ...SMALL }, posts: [] }; backend(); });
afterEach(() => { setCustomFetchJSON(null); vi.useRealTimers(); });

describe("Hoje opens honestly", () => {
  it("cold start: 'Carregando…' and a '…' count while the reads are on their way; a read that FAILS says so quietly (never 'nada precisa de você'); the next turn fills it in", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    world.holds = { "/approvals": gate(), "/handoffs": gate(), "/activity?tab=running": gate(), "/routines": gate() };
    live();
    expect(screen.getByTestId("needs-you-loading").textContent).toContain("Carregando…");
    expect(screen.queryByTestId("needs-you-empty")).toBeNull();
    expect(screen.getByTestId("needs-you-count").textContent).toBe("…");
    expect(screen.getByTestId("in-progress-loading")).toBeTruthy();
    expect(screen.queryByTestId("in-progress-empty")).toBeNull();
    expect(screen.getByTestId("routines-loading")).toBeTruthy();
    await act(async () => { world.holds["/approvals"].fail(); world.holds["/handoffs"].open(); world.holds["/activity?tab=running"].open(); world.holds["/routines"].open(); });
    await waitFor(() => expect(screen.getByTestId("needs-you-loading").textContent).toContain("Não foi possível ler agora"));
    expect(screen.queryByTestId("needs-you-empty")).toBeNull();                                // a failed read is not an empty list
    expect(await screen.findByTestId("in-progress-empty")).toBeTruthy();                      // the others answered: an empty list is now true
    world.holds = {};
    world.data["/approvals"] = { approvals: [approval("r1")] };
    await act(async () => { vi.advanceTimersByTime(16_000); });
    await screen.findByTestId("needs-you-item-r1");
    expect(screen.queryByTestId("needs-you-loading")).toBeNull();
    expect(screen.getByTestId("needs-you-count").textContent).toBe("1");
  });

  it("coming back: what it last showed is drawn AT ONCE (no 'Carregando…'), and the new reads replace it underneath", async () => {
    cleanup();
    world.data["/approvals"] = { approvals: [approval("novo")] };
    world.holds = { "/approvals": gate(), "/handoffs": gate(), "/activity?tab=running": gate() };
    live();
    expect(screen.queryByTestId("needs-you-loading")).toBeNull();
    expect(screen.getByTestId("needs-you-item-r1")).toBeTruthy();                             // the copy from the first visit
    await act(async () => { Object.values(world.holds).forEach((g) => g.open()); });
    await screen.findByTestId("needs-you-item-novo");
    expect(screen.queryByTestId("needs-you-item-r1")).toBeNull();
  });
});

describe("Hoje follows the Bots while it is open", () => {
  it("what needs the person is read every 15 s; the slow things (done today, routines, spending, budget) at most once a minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    live();
    await waitFor(() => expect(asked.filter((k) => k === "/budget")).toHaveLength(1));
    const count = (k: string) => asked.filter((x) => x === k).length;
    expect(count("/approvals")).toBe(1);
    await act(async () => { vi.advanceTimersByTime(16_000); });
    await waitFor(() => expect(count("/approvals")).toBe(2));
    expect(count("/handoffs")).toBe(2);
    expect(count("/activity?tab=running")).toBe(2);
    expect([count("/activity?tab=done"), count("/routines"), count("/costs"), count("/budget")]).toEqual([1, 1, 1, 1]);   // not yet
    await act(async () => { vi.advanceTimersByTime(46_000); });
    await waitFor(() => expect(count("/budget")).toBe(2));                                     // a minute on: the slow ones again
    expect(count("/activity?tab=done")).toBe(2);
  });

  it("a hidden tab does not read", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    live();
    await waitFor(() => expect(asked.filter((k) => k === "/budget")).toHaveLength(1));
    const before = asked.length;
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try { await act(async () => { vi.advanceTimersByTime(61_000); }); expect(asked.length).toBe(before); } finally { hidden.mockRestore(); }
  });
});

describe("a decision taken in Hoje", () => {
  it("tells the app at once (its '!' and the Bots are read again) and reads the list again", async () => {
    world.data["/approvals"] = { approvals: [approval("d1")] };
    const onChanged = vi.fn();
    live({ onChanged });
    await screen.findByTestId("needs-you-item-d1");
    const before = asked.filter((k) => k === "/approvals").length;
    world.data["/approvals"] = { approvals: [] };
    fireEvent.click(screen.getByText("Permitir uma vez"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(world.posts.some((p) => p.url.includes("/approvals/d1/resolve") || p.url.includes("/resolve"))).toBe(true);
    await waitFor(() => expect(asked.filter((k) => k === "/approvals").length).toBe(before + 1));
    // the read came back WITHOUT the request: what is pending is 0 (count, empty list), but the row this person decided stays as its confirmation
    await waitFor(() => expect(screen.getByTestId("needs-you-count").textContent).toBe("0"));
    const row = screen.getByTestId("needs-you-item-d1");
    expect(within(row).getByText("Permitida uma vez.")).toBeTruthy();
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
  });

  it("the row decided HERE stays in its place and holds the FOCUS (the read that drops it from the list no longer drops the focus on the page body)", async () => {
    world.data["/approvals"] = { approvals: [approval("a1"), approval("a2"), approval("a3")] };
    live();
    await screen.findByTestId("needs-you-item-a2");
    // Chrome drops the focus of the control the moment it turns disabled; jsdom keeps it, so the test does what the browser does
    const asChromeDoes = () => { const t = document.createElement("div"); t.tabIndex = -1; document.body.appendChild(t); t.focus(); t.blur(); t.remove(); };
    const mine = within(screen.getByTestId("needs-you-item-a2")).getByText("Permitir uma vez");
    mine.focus();
    world.data["/approvals"] = { approvals: [approval("a1"), approval("a3")] };         // the next read: a2 is gone
    fireEvent.click(mine);
    asChromeDoes();
    const said = await within(screen.getByTestId("needs-you-item-a2")).findByText("Permitida uma vez.");
    await waitFor(() => expect(document.activeElement).toBe(said));
    await waitFor(() => expect(screen.getByTestId("needs-you-count").textContent).toBe("2"));
    expect(screen.getAllByTestId(/^needs-you-item-a/).map((e) => e.getAttribute("data-testid"))).toEqual(["needs-you-item-a1", "needs-you-item-a2", "needs-you-item-a3"]);   // same place
    expect(document.activeElement).toBe(said);                                           // and still there after the read
  });

  it("when the last pending request is the one decided here, the list stays (with its confirmation) instead of the empty state taking its place under the focus", async () => {
    world.data["/approvals"] = { approvals: [approval("z1")] };
    live();
    const btn = within(await screen.findByTestId("needs-you-item-z1")).getByText("Permitir uma vez");
    world.data["/approvals"] = { approvals: [] };
    fireEvent.click(btn);
    const said = await within(screen.getByTestId("needs-you-item-z1")).findByText("Permitida uma vez.");
    await waitFor(() => expect(screen.getByTestId("needs-you-count").textContent).toBe("0"));
    expect(screen.queryByTestId("needs-you-empty")).toBeNull();
    expect(screen.getByTestId("needs-you-item-z1").contains(said)).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(said));
  });
});

describe("the app and Hoje share a read that is already on its way", () => {
  it("two GET /approvals at the same moment are ONE request; a later one is a new request (never a stored copy)", async () => {
    world.holds = { "/approvals": gate() };
    const a = getApprovals(), b = getApprovals();
    await act(async () => { world.holds["/approvals"].open(); });
    await Promise.all([a, b]);
    expect(asked.filter((k) => k === "/approvals")).toHaveLength(1);
    world.holds = {};
    await getApprovals();
    expect(asked.filter((k) => k === "/approvals")).toHaveLength(2);
  });
});
