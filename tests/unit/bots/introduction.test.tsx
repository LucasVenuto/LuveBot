// tests/unit/bots/introduction.test.tsx
// "O Bot se apresenta" for real (contract v0.4 B4): the wizard's last step used to show a fixed card with things the Bot never
// said. Now it reads GET /introduction, starts the real run only on a click that confirms its cost (POST with confirm_cost and
// CSRF), waits honestly, and shows the Bot's own answer through <Markdown>; a refusal or a failure is said, never a sample.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { BotIntroduction, POLL_MS, RECHECK_MS, RECHECK_TRIES } from "@/components/bots/BotIntroduction";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";

type World = { view: any; posts: Array<{ body: any; csrf: string | null }>; runs: string[]; post?: () => unknown };
function backend(w: World) {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (url.endsWith("/bots/vendas/introduction") && method === "GET") return w.view;
    if (url.endsWith("/bots/vendas/introduction") && method === "POST") {
      w.posts.push({ body: JSON.parse(String(init?.body)), csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
      if (w.post) return w.post();
      return { state: "running", session_id: "s_intro", run_id: "run_1", estimate_cents: 3, requires_confirm: true };
    }
    if (url.includes("/bots/vendas/runs/")) { const status = w.runs.shift() ?? "completed"; return { run: { id: "run_1", status, output: status === "completed" ? "Oi! Sou o **Vendas**: cuido dos leads." : null } }; }
    throw new Error("unexpected " + method + " " + url);
  });
}
const none = { state: "none", session_id: null, run_id: null, estimate_cents: 3, requires_confirm: true };

beforeEach(() => { cleanup(); resetCsrfToken(); });
afterEach(() => { setCustomFetchJSON(null); vi.useRealTimers(); });

describe("the Bot introduces itself", () => {
  it("offers the real run with its cost, and sends nothing before the click", async () => {
    const w: World = { view: none, posts: [], runs: [] };
    backend(w);
    render(<BotIntroduction bot="vendas" />);
    expect(await screen.findByText("O Bot pode se apresentar agora: é uma execução real do modelo, que custa cerca de US$ 0,03.")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(w.posts).toHaveLength(0);                                    // a real model run: only a person's click starts it
  });

  it("the click confirms the cost (POST confirm_cost + CSRF); it waits, then shows the Bot's own answer and hands over its session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const w: World = { view: none, posts: [], runs: ["started", "started", "completed"] };
    backend(w);
    const onSession = vi.fn();
    render(<BotIntroduction bot="vendas" onSession={onSession} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pedir que o Bot se apresente" }));
    await waitFor(() => expect(w.posts).toEqual([{ body: { confirm_cost: true }, csrf: "csrf-1" }]));
    expect(await screen.findByText("O Bot está se apresentando…")).toBeTruthy();
    expect(onSession).toHaveBeenCalledWith("s_intro");
    for (let i = 0; i < 4 && !screen.queryByTestId("bot-introduction-answer"); i++) await act(async () => { vi.advanceTimersByTime(POLL_MS); });
    const answer = await screen.findByTestId("bot-introduction-answer");
    expect(answer.textContent).toBe("Oi! Sou o Vendas: cuido dos leads.");
    expect(answer.querySelector("strong")?.textContent).toBe("Vendas");      // the Bot's text, through <Markdown>
  });

  it("an introduction already made shows what the Bot said, without asking again", async () => {
    const w: World = { view: { state: "done", session_id: "s_intro", run_id: "run_1", estimate_cents: 3, requires_confirm: true }, posts: [], runs: ["completed"] };
    backend(w);
    render(<BotIntroduction bot="vendas" />);
    expect((await screen.findByTestId("bot-introduction-answer")).textContent).toBe("Oi! Sou o Vendas: cuido dos leads.");
    expect(w.posts).toHaveLength(0);
  });

  it("when it cannot happen, it says why (no template, hook not live), and offers nothing", async () => {
    for (const [reason, said] of [["no_template", "Este Bot não foi criado a partir de um modelo, então não há apresentação para ele."],
                                  ["hook_not_live", "A apresentação começa quando o hook do LuveBot estiver ativo neste Bot (o gateway precisa estar rodando)."]]) {
      backend({ view: { ...none, state: "unavailable", reason }, posts: [], runs: [] });
      const r = render(<BotIntroduction bot="vendas" />);
      expect(await screen.findByText(said)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Pedir que o Bot se apresente" })).toBeNull();
      r.unmount();
    }
  });

  it("a refused start, a failed run and an empty answer are said in words, never replaced by a sample", async () => {
    const w: World = { view: none, posts: [], runs: [], post: () => { throw new ApiError({ code: "bot_offline", message: "x", status: 409 }); } };
    backend(w);
    const r = render(<BotIntroduction bot="vendas" />);
    fireEvent.click(await screen.findByRole("button", { name: "Pedir que o Bot se apresente" }));
    expect(await screen.findByText("Este Bot está sem conexão com o Hermes; a apresentação começa quando ele estiver no ar.")).toBeTruthy();
    r.unmount();
    for (const [status, said] of [["failed", "A apresentação não terminou. Você pode conversar com o Bot mesmo assim."], ["completed-empty", "O Bot terminou sem dizer nada."]] as const) {
      setCustomFetchJSON(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
        if (url.endsWith("/introduction")) return { state: "done", session_id: "s", run_id: "run_1", estimate_cents: 3, requires_confirm: true };
        return { run: { id: "run_1", status: status === "failed" ? "failed" : "completed", output: status === "failed" ? null : "  " } };
      });
      const rr = render(<BotIntroduction bot="vendas" />);
      expect((await screen.findByRole("alert")).textContent).toBe(said);
      expect(screen.queryByTestId("bot-introduction-answer")).toBeNull();
      rr.unmount();
    }
  });

  it("a Bot just created and not served yet (offline, hook not live): it asks again and the offer appears when the Bot is ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let gets = 0;
    const views = [{ ...none, state: "unavailable", reason: "bot_offline" }, { ...none, state: "unavailable", reason: "hook_not_live" }, none];
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
      if (url.endsWith("/bots/vendas/introduction")) return views[Math.min(gets++, views.length - 1)];
      throw new Error("unexpected " + url);
    });
    render(<BotIntroduction bot="vendas" />);
    expect(await screen.findByText("Este Bot está sem conexão com o Hermes; a apresentação começa quando ele estiver no ar.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pedir que o Bot se apresente" })).toBeNull();
    for (let i = 0; i < 3 && !screen.queryByRole("button", { name: "Pedir que o Bot se apresente" }); i++) await act(async () => { vi.advanceTimersByTime(RECHECK_MS); });
    expect(await screen.findByRole("button", { name: "Pedir que o Bot se apresente" })).toBeTruthy();
    expect(gets).toBe(3);
  });

  it("a lasting reason (no template, paused, cap) is said once and not asked again; a passing one stops after about two minutes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (const [reason, maxGets] of [["no_template", 1], ["bot_paused", 1], ["budget_exceeded", 1], ["bot_offline", RECHECK_TRIES + 1]] as const) {
      let gets = 0;
      setCustomFetchJSON(async (url: string) => {
        if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
        gets++;
        return { ...none, state: "unavailable", reason };
      });
      const r = render(<BotIntroduction bot="vendas" />);
      await waitFor(() => expect(gets).toBeGreaterThan(0));
      for (let i = 0; i < RECHECK_TRIES + 5; i++) await act(async () => { vi.advanceTimersByTime(RECHECK_MS); });
      expect(gets).toBe(maxGets);
      expect(RECHECK_MS * RECHECK_TRIES).toBeLessThanOrEqual(150_000);
      r.unmount();
    }
  });

  it("a start refused because the Bot was not ready yet brings the offer back once it is", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let gets = 0;
    const w: World = { view: none, posts: [], runs: [], post: () => { throw new ApiError({ code: "hook_not_live", message: "x", status: 409 }); } };
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
      if (method === "GET") { gets++; return none; }
      w.posts.push({ body: JSON.parse(String(init?.body)), csrf: null });
      return w.post!();
    });
    render(<BotIntroduction bot="vendas" />);
    fireEvent.click(await screen.findByRole("button", { name: "Pedir que o Bot se apresente" }));
    expect(await screen.findByText(/hook do LuveBot estiver ativo/)).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(RECHECK_MS); });
    expect(await screen.findByRole("button", { name: "Pedir que o Bot se apresente" })).toBeTruthy();
    expect(gets).toBe(2);
    expect(w.posts).toHaveLength(1);  // asking again never starts the run: only a click does
  });
});
