// tests/unit/agent/free-mode-visible.test.tsx
// Red team T1: the Livre mode used to be visible only inside the Bot's profile, and "what the Livre let through" (GET /bots/{bot}/free-passes)
// had no screen. Now a Bot that LuveBot asks nothing for wears a "Livre" chip in the contact list, in the conversation header and in Hoje, and
// its profile lists what went through, marking (and warning about) any row no recorded turn-on of the Livre explains.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within, act } from "@testing-library/react";
import { ContactList } from "@/components/messenger/ContactList";
import { Conversation } from "@/components/conversation";
import { Hoje } from "@/components/Hoje";
import { FreePassesCard } from "@/components/agent/FreePassesCard";
import { ApprovalSurfaceCard } from "@/components/agent/ApprovalSurfaceCard";
import { useApprovalModes, announceMode } from "@/components/agent/freeMode";
import { LuveBotApp } from "@/index";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Bot } from "@/api/types";

const bot = (name: string, label: string, mode?: "free"): Bot => ({ name, status: "idle", approval_mode: mode,
  display: { label, role: `papel de ${label}`, color: "#60a5fa", avatar: { kind: "initials", value: label.slice(0, 2).toUpperCase() } } } as any);
const surface = (name: string, mode: string) => ({ approval_surface: { bot: name, mode, approvers: [], platforms: ["telegram"], allow_all: false, allow_all_reason: null, applied: true, applied_reason: "applied", hook_version: "0.5.0", updated_at: null, updated_by: null } });

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); vi.useRealTimers(); });

describe("a Bot without its gate is visible where the Bot is", () => {
  it("contact list: the chip only on the Free Bot's row; the conversation header; Hoje's pill names the Free Bots", () => {
    const bots = [bot("vendas", "Vendas", "free"), bot("dev", "Dev")];
    const list = render(<ContactList bots={bots} onBotsChanged={() => {}} />);
    const rows = document.querySelectorAll("button[aria-pressed]");
    expect(within(rows[0] as HTMLElement).getByTestId("free-chip").textContent).toContain("Livre");
    expect(within(rows[1] as HTMLElement).queryByTestId("free-chip")).toBeNull();
    expect(screen.getByTestId("free-chip").getAttribute("title")).toBe("Este Bot está no modo Livre: o LuveBot não pede aprovação para ele.");
    list.unmount();
    setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "dashboard", auth_mode: "gated" } : {}));
    const chat = render(<Conversation bot={{ name: "vendas", label: "Vendas", approval_mode: "free" }} initialTurns={[]} />);
    expect(within(screen.getByRole("banner", { hidden: true }) ?? document.body).getByTestId("free-chip")).toBeTruthy();
    chat.unmount();
    render(<Hoje bots={bots} botsStatus="ready" approvals={[]} handoffs={[]} inProgressItems={[]} completedItems={[]} routines={[]} waiting={[]} />);
    expect(screen.getByTestId("hoje-free-pill").textContent).toBe("Livre: Vendas");
    cleanup();
    render(<Hoje bots={[bot("dev", "Dev")]} botsStatus="ready" approvals={[]} handoffs={[]} inProgressItems={[]} completedItems={[]} routines={[]} waiting={[]} />);
    expect(screen.queryByTestId("hoje-free-pill")).toBeNull();                                  // none Free: nothing to say
  });

  it("in the app: the chip follows /bots (no read of its own per Bot); the Perfil changing it moves the chip AT ONCE and is held against a /bots already on its way; a /bots that cannot say it, or fails, keeps what was known", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const modes: Record<string, string | undefined> = { alfa: "free", beta: "luvebot" };
    let fail = false;
    const urls: string[] = [];
    const face = (l: string, v: string) => ({ label: l, role: "", color: "#60a5fa", avatar: { kind: "initials", value: v } });
    setCustomFetchJSON(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/session")) return { csrf: "c", actor: "dashboard", auth_mode: "gated" };
      if (/\/bots$/.test(url)) {
        if (fail) throw new Error("down");
        return { bots: [{ name: "alfa", status: "idle", approval_mode: modes.alfa, display: face("Alfa", "AL") }, { name: "beta", status: "idle", approval_mode: modes.beta, display: face("Beta", "BE") }] };
      }
      return {};
    });
    render(<LuveBotApp />);
    await waitFor(() => expect(document.querySelectorAll("[data-testid=free-chip]").length).toBeGreaterThan(0));
    const rowOf = (label: string) => screen.getAllByRole("button").find((b) => b.hasAttribute("aria-pressed") && b.textContent?.includes(label))!;
    expect(within(rowOf("Alfa")).queryByTestId("free-chip")).toBeTruthy();
    expect(within(rowOf("Beta")).queryByTestId("free-chip")).toBeNull();
    expect(urls.some((u) => u.includes("approval-surface"))).toBe(false);                      // one /bots says it all: no read per Bot
    await act(async () => { announceMode("alfa", "luvebot"); announceMode("beta", "free"); });  // what the Perfil does when it reads or saves
    expect(within(rowOf("Alfa")).queryByTestId("free-chip")).toBeNull();
    expect(within(rowOf("Beta")).queryByTestId("free-chip")).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(16_000); });                                  // /bots again (15 s), still the OLD answer: the Perfil's word is held
    expect(within(rowOf("Alfa")).queryByTestId("free-chip")).toBeNull();
    expect(within(rowOf("Beta")).queryByTestId("free-chip")).toBeTruthy();
    modes.alfa = undefined; modes.beta = undefined;                                              // later /bots cannot say it: the last known stays
    await act(async () => { vi.advanceTimersByTime(31_000); });
    expect(within(rowOf("Beta")).queryByTestId("free-chip")).toBeTruthy();
    expect(within(rowOf("Alfa")).queryByTestId("free-chip")).toBeNull();
    modes.alfa = "free"; modes.beta = "luvebot"; fail = true;                                    // a failing /bots: nothing changes
    await act(async () => { vi.advanceTimersByTime(16_000); });
    expect(within(rowOf("Beta")).queryByTestId("free-chip")).toBeTruthy();
    fail = false;                                                                                // and when it works again, it follows the server (the hold is over)
    await act(async () => { vi.advanceTimersByTime(16_000); });
    await waitFor(() => expect(within(rowOf("Alfa")).queryByTestId("free-chip")).toBeTruthy());
    expect(within(rowOf("Beta")).queryByTestId("free-chip")).toBeNull();
  });

  it("saving Livre in the Perfil announces it: a chip somewhere else follows without waiting for the minute", async () => {
    const modes: Record<string, string> = { vendas: "luvebot" };
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "dashboard", auth_mode: "gated" };
      if (url.includes("/rules")) return { rules: [] };
      if (url.endsWith("/bots/vendas/approval-surface")) { if (init?.method === "PUT") modes.vendas = JSON.parse(String(init.body)).mode; return surface("vendas", modes.vendas); }
      return {};
    });
    const loaded = [bot("vendas", "Vendas")];
    function Elsewhere() { const free = useApprovalModes(loaded).filter((b) => b.approval_mode === "free"); return <span data-testid="elsewhere">{free.map((b) => b.name).join(",") || "nenhum"}</span>; }
    render(<><Elsewhere /><ApprovalSurfaceCard bot="vendas" /></>);
    await screen.findByRole("radio", { name: /Livre: não pedir aprovação/ });
    await waitFor(() => expect(screen.getByTestId("elsewhere").textContent).toBe("nenhum"));
    fireEvent.click(screen.getByRole("radio", { name: /Livre: não pedir aprovação/ }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(screen.getByTestId("elsewhere").textContent).toBe("vendas"));
  });
});

describe("Executado sem pedir (GET /bots/{bot}/free-passes)", () => {
  const pass = (at: number, tool: string, over: Record<string, unknown> = {}) => ({ at, tool, rule_id: null, command: null, audited: true, ...over });
  function backend(pages: Array<{ free_passes: any[]; next_before: number | null }>, urls: string[] = []) {
    let n = 0;
    setCustomFetchJSON(async (url: string) => {
      if (url.includes("/rules")) return { rules: [{ rule: { id: "builtin.git_push", label: "Enviar código" }, seal_result: { seal: "hand" } }] };
      if (url.includes("/free-passes")) { urls.push(url); const p = pages[Math.min(n++, pages.length - 1)]; if (p instanceof Error) throw p; return p; }
      return {};
    });
  }

  it("lists the rows newest first as text (a command is never markup), names the rule, and says so when nothing went through", async () => {
    backend([{ free_passes: [pass(1_800_000_100, "terminal", { command: "git push <b>origin</b> main", rule_id: "builtin.git_push" }), pass(1_800_000_000, "send_email")], next_before: null }]);
    render(<FreePassesCard bot="vendas" />);
    const rows = await screen.findAllByTestId("free-pass");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("terminal");
    expect(rows[0].textContent).toContain("git push <b>origin</b> main");
    expect(rows[0].querySelector("b")).toBeNull();
    expect(rows[0].textContent).toMatch(/regra: /);
    expect(screen.queryByTestId("free-passes-unaudited")).toBeNull();                          // every row is explained by a recorded turn-on
    cleanup();
    backend([{ free_passes: [], next_before: null }]);
    render(<FreePassesCard bot="vendas" />);
    expect((await screen.findByTestId("free-passes-empty")).textContent).toBe("Nada passou direto no modo Livre ainda.");
  });

  it("a row nobody's recorded turn-on explains (audited false) is marked 'sem registro' and the card warns above the list", async () => {
    backend([{ free_passes: [pass(1_800_000_100, "terminal", { audited: false }), pass(1_800_000_000, "send_email")], next_before: null }]);
    render(<FreePassesCard bot="vendas" />);
    const warn = await screen.findByTestId("free-passes-unaudited");
    expect(warn.getAttribute("role")).toBe("alert");
    expect(warn.textContent).toContain("sem que haja registro de alguém ter ligado o Livre");
    expect(screen.getAllByTestId("free-pass-unaudited")).toHaveLength(1);
    expect(within(screen.getAllByTestId("free-pass")[0]).getByTestId("free-pass-unaudited").textContent).toBe("sem registro");
    expect(within(screen.getAllByTestId("free-pass")[1]).queryByTestId("free-pass-unaudited")).toBeNull();
  });

  it("'Ver mais' asks for the page before the last one (before=next_before) and adds to the list; a failed read is said in words", async () => {
    const urls: string[] = [];
    backend([{ free_passes: [pass(1_800_000_300, "a")], next_before: 1_800_000_300 }, { free_passes: [pass(1_800_000_200, "b")], next_before: null }], urls);
    render(<FreePassesCard bot="vendas" />);
    await screen.findAllByTestId("free-pass");
    fireEvent.click(screen.getByRole("button", { name: "Ver mais" }));
    await waitFor(() => expect(screen.getAllByTestId("free-pass")).toHaveLength(2));
    expect(urls[1]).toMatch(/free-passes\?limit=20&before=1800000300$/);
    expect(screen.queryByRole("button", { name: "Ver mais" })).toBeNull();
    cleanup();
    setCustomFetchJSON(async (url: string) => { if (url.includes("/rules")) return { rules: [] }; throw new Error("down"); });
    render(<FreePassesCard bot="vendas" />);
    expect((await screen.findByRole("alert")).textContent).toContain("Não foi possível ler o que passou direto agora");
  });

  it("in English", async () => {
    setLuveLocale("en");
    backend([{ free_passes: [pass(1_800_000_100, "terminal", { audited: false })], next_before: null }]);
    render(<FreePassesCard bot="vendas" />);
    expect((await screen.findByTestId("free-passes-unaudited")).textContent).toContain("with no record that someone turned Free on");
    expect(screen.getByText("Run without asking")).toBeTruthy();
    expect(screen.getByTestId("free-pass-unaudited").textContent).toBe("no record");
  });
});
