// tests/unit/agent/approval-surface.test.tsx
// "Onde aprovar" in the Bot profile (D-025 §d): two real options, the approvers' numeric Telegram IDs with a short help, the
// server's refusals (409 gateway open to everyone, 403 loopback) in plain words, and the rule seals from SealResult only.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { ApprovalSurfaceCard, parseApprovers, PENDING_EVERY_MS, PENDING_TRIES } from "@/components/agent/ApprovalSurfaceCard";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { ApprovalSurface } from "@/api/types";

const surface = (over: Partial<ApprovalSurface> = {}): ApprovalSurface => ({
  bot: "vendas", mode: "luvebot", approvers: [], platforms: ["telegram"], allow_all: false, allow_all_reason: null,
  applied: true, hook_version: "0.3.0", updated_at: null, updated_by: null, ...over,
});
const askRule = (id: string, label: string, seal: string, scope: any = { kind: "bot", ref: "vendas" }) => ({
  rule: { id, label, level: "ask", scope, match: {}, state: "active", origin: "human", builtin: false, version: 1 }, seal_result: { seal },
});
type World = { surface: ApprovalSurface; rules: any[]; puts: Array<{ body: any; csrf: string | null }>; put?: (body: any) => unknown };
function backend(w: World) {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (url.endsWith("/bots/vendas/approval-surface") && method === "GET") return { approval_surface: w.surface };
    if (url.endsWith("/bots/vendas/approval-surface") && method === "PUT") {
      const body = JSON.parse(String(init?.body));
      w.puts.push({ body, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
      if (w.put) return w.put(body);
      w.surface = surface({ mode: body.mode, approvers: body.approvers ?? w.surface.approvers });
      return { approval_surface: w.surface };
    }
    if (url.includes("/rules")) {  // like the backend: ?bot= gives only the rules that apply to that Bot (rules_service.applies_to)
      const bot = new URL(url, "http://x").searchParams.get("bot");
      return { rules: bot ? w.rules.filter((x: any) => x.rule.scope.kind === "global" || x.rule.scope.ref === bot) : w.rules };
    }
    throw new Error("unexpected " + method + " " + url);
  });
}
const radio = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLInputElement;
const saveBtn = () => screen.getByRole("button", { name: "Salvar alterações" }) as HTMLButtonElement;

beforeEach(() => { cleanup(); resetCsrfToken(); });
afterEach(() => setCustomFetchJSON(null));

describe("Onde aprovar", () => {
  it("parses the approvers: numbers only, at most 20, no repeats", () => {
    expect(parseApprovers("123, 456\n789")).toEqual({ ids: ["123", "456", "789"], error: null });
    expect(parseApprovers("123, @ana").error).toBe("format");
    expect(parseApprovers("1, 1").error).toBe("repeat");
    expect(parseApprovers(Array.from({ length: 21 }, (_, i) => String(i + 1)).join(",")).error).toBe("many");
  });

  it("shows the two real options with 'Só no LuveBot' as the default, and the seals of the Bot's ask rules from SealResult", async () => {
    backend({ surface: surface(), rules: [askRule("r1", "Enviar e-mail para fora", "hand"), askRule("r2", "Apagar arquivos", "broken"),
      askRule("r3", "De outro Bot", "lock", { kind: "bot", ref: "dev" })], puts: [] });
    render(<ApprovalSurfaceCard bot="vendas" />);
    expect((await screen.findByRole("radio", { name: /Só no LuveBot/ }) as HTMLInputElement).checked).toBe(true);
    expect(radio(/Onde a conversa acontece/).checked).toBe(false);
    expect(screen.getByRole("radiogroup", { name: "Onde aprovar" })).toBeTruthy();
    expect(screen.queryByLabelText(/Quem pode aprovar no Telegram/)).toBeNull();
    await screen.findByText("Enviar e-mail para fora");
    expect(screen.getByTestId("seal-hand")).toBeTruthy();
    expect(screen.getByTestId("seal-broken")).toBeTruthy();       // a broken seal stays broken: never inferred from the level
    expect(screen.queryByText("De outro Bot")).toBeNull();
    expect(saveBtn().disabled).toBe(true);                        // nothing changed yet
  });

  it("'Onde a conversa acontece' asks for numeric Telegram IDs, explains how to find yours, and validates before sending", async () => {
    const w: World = { surface: surface(), rules: [], puts: [] };
    backend(w);
    render(<ApprovalSurfaceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("radio", { name: /Onde a conversa acontece/ }));
    const field = screen.getByLabelText(/Quem pode aprovar no Telegram/) as HTMLInputElement;
    // whose ID it is (T13.8: the CEO had put the Bot's own ID and the approval button never came)
    const help = document.getElementById(field.getAttribute("aria-describedby")!)!;
    expect(help.textContent).toBe("Seu ID de usuário no Telegram (da conta que conversa com o Bot, não o ID do Bot). Peça ao @userinfobot pela mesma conta.");
    expect(screen.getByRole("link", { name: "@userinfobot" }).getAttribute("href")).toBe("https://t.me/userinfobot");
    expect(screen.getByText("Nomeie pelo menos uma pessoa.")).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
    fireEvent.change(field, { target: { value: "123, @ana" } });
    expect(screen.getByText("Use só números, separados por vírgula.")).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
    fireEvent.change(field, { target: { value: "123, 456" } });
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(saveBtn());
    await waitFor(() => expect(w.puts).toHaveLength(1));
    expect(w.puts[0]).toEqual({ body: { mode: "channel", approvers: ["telegram:123", "telegram:456"] }, csrf: "csrf-1" });
    expect(await screen.findByText("Salvo.")).toBeTruthy();
  });

  it("409 (the gateway lets everyone in) is said in plain words with the reason, and takes focus", async () => {
    const w: World = { surface: surface(), rules: [], puts: [],
      put: () => { throw new ApiError({ code: "approval_surface_unsafe", message: "x", status: 409, details: { reason: "TELEGRAM_ALLOW_ALL_USERS" } }); } };
    backend(w);
    render(<ApprovalSurfaceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("radio", { name: /Onde a conversa acontece/ }));
    fireEvent.change(screen.getByLabelText(/Quem pode aprovar no Telegram/), { target: { value: "123" } });
    fireEvent.click(saveBtn());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Não dá para aprovar no canal: o Telegram libera todos os usuários (TELEGRAM_ALLOW_ALL_USERS).");
    expect(alert.textContent).not.toContain("approval_surface_unsafe");
    await waitFor(() => expect(document.activeElement).toBe(alert));  // the focus comes from an effect right after the render
  });

  it("403 loopback is said in plain words", async () => {
    backend({ surface: surface(), rules: [], puts: [],
      put: () => { throw new ApiError({ code: "loopback_not_human", message: "x", status: 403 }); } });
    render(<ApprovalSurfaceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("radio", { name: /Onde a conversa acontece/ }));
    fireEvent.change(screen.getByLabelText(/Quem pode aprovar no Telegram/), { target: { value: "123" } });
    fireEvent.click(saveBtn());
    expect((await screen.findByRole("alert")).textContent).toContain("modo loopback, sem login");
  });

  it("says when the live hook is too old for it (only then 'precisa ser atualizado'), and when the gateway is open to everyone", async () => {
    backend({ surface: surface({ mode: "channel", approvers: ["telegram:123"], applied: false, applied_reason: "hook_outdated", hook_version: "0.2.0", allow_all: true, allow_all_reason: "GATEWAY_ALLOW_ALL_USERS" }), rules: [], puts: [] });
    render(<ApprovalSurfaceCard bot="vendas" />);
    expect(await screen.findByText("Ainda não aplicado: o hook deste Bot precisa ser atualizado (versão agora: 0.2.0; precisa 0.3.0+). Até lá, aprove no LuveBot.")).toBeTruthy();
    expect(screen.getByText(/o gateway libera todos os usuários \(GATEWAY_ALLOW_ALL_USERS\)/)).toBeTruthy();
    expect((screen.getByLabelText(/Quem pode aprovar no Telegram/) as HTMLInputElement).value).toBe("123");  // the id, without the prefix
  });

  it("going back to 'Só no LuveBot' keeps the named people stored, so turning the channel on again needs no retyping", async () => {
    const w: World = { surface: surface({ mode: "channel", approvers: ["telegram:123"] }), rules: [], puts: [] };
    backend(w);
    render(<ApprovalSurfaceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("radio", { name: /Só no LuveBot/ }));
    fireEvent.click(saveBtn());
    await waitFor(() => expect(w.puts).toHaveLength(1));
    expect(w.puts[0].body).toEqual({ mode: "luvebot", approvers: ["telegram:123"] });
  });

  describe("why it is not applied yet (applied_reason, VPS 2026-10-02: the card said 'needs an update' to a live 0.3.0 hook)", () => {
    afterEach(() => vi.useRealTimers());
    function counting(w: World & { calls: number; next?: () => ApprovalSurface }) {
      setCustomFetchJSON(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
        if (url.endsWith("/bots/vendas/approval-surface") && method === "GET") { w.calls++; if (w.next) w.surface = w.next(); return { approval_surface: w.surface }; }
        if (url.includes("/rules")) return { rules: [] };
        throw new Error("unexpected " + method + " " + url);
      });
    }
    const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };
    // The next poll is scheduled by a useEffect, which React runs AFTER the render that findBy* already saw: under load a
    // tick right after findBy* can advance the clock before that timer exists (1 failure in ~5 parallel runs). So advance in
    // small steps until the condition holds, never assuming when the timer was set; at most 6 s of fake time.
    const until = async (cond: () => boolean) => { for (let i = 0; i < 24 && !cond(); i++) await tick(250); expect(cond()).toBe(true); };

    it("pending: 'Aplicando…' (not 'atualizado'), asks again every 2 s and the note goes once the hook reports it", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const w = { surface: surface({ mode: "channel", approvers: ["telegram:123"], applied: false, applied_reason: "pending" }), rules: [], puts: [], calls: 0 } as any;
      counting(w);
      render(<ApprovalSurfaceCard bot="vendas" />);
      expect(await screen.findByText("Aplicando: o hook confirma em alguns segundos.")).toBeTruthy();
      expect(screen.queryByText(/precisa ser atualizado/)).toBeNull();
      const first = w.calls;
      const t0 = Date.now();                               // fake clock: a timer set late only makes this longer
      await until(() => w.calls > first);
      expect(w.calls).toBe(first + 1);                    // exactly one more ask...
      expect(Date.now() - t0).toBeGreaterThanOrEqual(PENDING_EVERY_MS - 250);  // ...and not before its 2 s
      w.surface = surface({ mode: "channel", approvers: ["telegram:123"], applied: true, applied_reason: "applied" });
      await until(() => screen.queryByText(/Aplicando/) === null);
      const done = w.calls;
      await tick(PENDING_EVERY_MS * 3);
      expect(w.calls).toBe(done);                       // applied: no more asking
    });

    it("pending that never confirms: stops asking after the limit and says it is taking long", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const w = { surface: surface({ mode: "channel", approvers: ["telegram:123"], applied: false, applied_reason: "pending" }), rules: [], puts: [], calls: 0 } as any;
      counting(w);
      render(<ApprovalSurfaceCard bot="vendas" />);
      await screen.findByText("Aplicando: o hook confirma em alguns segundos.");
      for (let i = 0; i < PENDING_TRIES + 5; i++) await tick(PENDING_EVERY_MS);
      await waitFor(() => expect(screen.getByText(/^Ainda aplicando\. Se não confirmar/)).toBeTruthy());
      expect(w.calls).toBe(1 + PENDING_TRIES);         // the first read plus the bounded retries
    });

    it("asking again never erases what the person is typing", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const w = { surface: surface({ mode: "channel", approvers: ["telegram:123"], applied: false, applied_reason: "pending" }), rules: [], puts: [], calls: 0 } as any;
      counting(w);
      render(<ApprovalSurfaceCard bot="vendas" />);
      const field = await screen.findByLabelText(/Quem pode aprovar no Telegram/) as HTMLInputElement;
      fireEvent.change(field, { target: { value: "123, 456" } });
      await until(() => w.calls > 1);
      expect((screen.getByLabelText(/Quem pode aprovar no Telegram/) as HTMLInputElement).value).toBe("123, 456");
    });

    it("hook not live, and a reason the backend did not send: each says its own thing, never 'precisa ser atualizado'", async () => {
      backend({ surface: surface({ mode: "channel", approvers: ["telegram:123"], applied: false, applied_reason: "hook_not_live", hook_version: "0.3.0" }), rules: [], puts: [] });
      const r = render(<ApprovalSurfaceCard bot="vendas" />);
      expect(await screen.findByText(/^Ainda não aplicado: o hook deste Bot não está ativo agora/)).toBeTruthy();
      expect(screen.queryByText(/precisa ser atualizado/)).toBeNull();
      r.unmount();
      backend({ surface: surface({ mode: "channel", approvers: ["telegram:123"], applied: false, hook_version: "0.3.0" }), rules: [], puts: [] });
      render(<ApprovalSurfaceCard bot="vendas" />);
      expect(await screen.findByText("Ainda não aplicado por este Bot. Até lá, aprove no LuveBot.")).toBeTruthy();
      expect(screen.queryByText(/precisa ser atualizado/)).toBeNull();
    });

    it("'Só no LuveBot' with a hook below 0.2.0 says the version that mode needs", async () => {
      backend({ surface: surface({ mode: "luvebot", applied: false, applied_reason: "hook_outdated", hook_version: "0.1.0" }), rules: [], puts: [] });
      render(<ApprovalSurfaceCard bot="vendas" />);
      expect(await screen.findByText(/versão agora: 0\.1\.0; precisa 0\.2\.0\+/)).toBeTruthy();
    });
  });

  it("in English too, the help says it is the user's own ID from the account that talks to the Bot, not the Bot's", async () => {
    setLuveLocale("en");
    try {
      backend({ surface: surface({ mode: "channel", approvers: ["telegram:123"] }), rules: [], puts: [] });
      render(<ApprovalSurfaceCard bot="vendas" />);
      const field = await screen.findByLabelText(/Who can approve on Telegram/);
      expect(document.getElementById(field.getAttribute("aria-describedby")!)!.textContent)
        .toBe("Your Telegram user ID (of the account that talks to the Bot, not the Bot's ID). Ask @userinfobot from that same account.");
    } finally { setLuveLocale("pt"); }
  });
});
