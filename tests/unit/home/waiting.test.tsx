// tests/unit/home/waiting.test.tsx
// "Bot esperando você" (contract v0.9 §1.8 and §7, F6-B): what the Bots wait for outside LuveBot's inbox, as the hook SAW it. The screen only
// says where the person has to go (invariant 6: nothing here answers anything). Sentences are ours by kind and platform; a clarify's question is
// the Bot's text, shown as plain text; sudo and approval carry no text; Activity's "waiting" item has no action and no detail; the sidebar says
// why a Bot is waiting. The route is read at most every 30 s and only with the tab visible. The backend here is a stand-in (the route lands later).
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { Hoje } from "@/components/Hoje";
import { ActivityView } from "@/components/activity/ActivityView";
import { ContactList } from "@/components/messenger/ContactList";
import { waitView, WAIT_MIN_MS } from "@/components/home/waiting";
import { inProgress } from "@/components/home/derive";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";
import type { WaitingItem, WaitingResponse, Bot, ActivityItem } from "@/api/types";

const tr = (k: string, p?: Record<string, string | number>) => (translations.pt as Record<string, string>)[k].replace(/\{(\w+)\}/g, (_, n) => String(p?.[n]));
const SINCE = (() => { const d = new Date(); d.setHours(9, 5, 0, 0); return d.getTime() / 1000; })();
const w = (over: Partial<WaitingItem> = {}): WaitingItem =>
  ({ bot: "vendas", request_id: "a".repeat(32), kind: "clarify", since: SINCE, session_id: "s1", platform: "api_server", prompt: "Qual <b>cliente</b>?", ...over });
const BOTS = [{ name: "vendas", display: { label: "Vendas", role: "Cuida das vendas", color: "#60a5fa", avatar: { kind: "initials", value: "VE" } }, status: "idle" }] as unknown as Bot[];
const hoje = (waiting: WaitingItem[], extra: Record<string, unknown> = {}) =>
  render(<Hoje bots={BOTS} approvals={[]} handoffs={[]} inProgressItems={[]} completedItems={[]} routines={[]} waiting={waiting} {...extra} />);

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); vi.useRealTimers(); });

describe("a frase de 'pular' que o Hermes acrescenta (v0.11 §4.1)", () => {
  const HINT = 'Reply "skip" to skip this question.';
  it("where the person answers in LuveBot it is not shown (the run surface does not honour it); where the answer is given elsewhere, it is the Bot's text as it came", () => {
    expect(waitView(w({ prompt: `Qual cliente?\n\n${HINT}` }), tr as any).title).toBe("Qual cliente?");
    expect(waitView(w({ platform: null, prompt: `Qual cliente?\n\n${HINT}` }), tr as any).title).toBe("Qual cliente?");
    for (const platform of ["telegram", "cli", "discord"]) expect(waitView(w({ platform, prompt: `Qual cliente?\n\n${HINT}` }), tr as any).title, platform).toBe(`Qual cliente?\n\n${HINT}`);
  });

  it("a question that is only the sentence keeps it (never an empty title), and a reworded one is shown as it is", () => {
    expect(waitView(w({ prompt: HINT }), tr as any).title).toBe(HINT);
    expect(waitView(w({ prompt: 'Qual?\n\nReply skip to skip.' }), tr as any).title).toBe("Qual?\n\nReply skip to skip.");
  });
});

describe("o que cada espera diz", () => {
  it("by kind and platform, in our words; only a clarify has the Bot's text (the question), and sudo never carries one", () => {
    expect(waitView(w(), tr as any)).toMatchObject({ title: "Qual <b>cliente</b>?", where: "Responda na conversa, aqui no LuveBot.", inLuveBot: true });
    expect(waitView(w({ platform: null }), tr as any).inLuveBot).toBe(true);
    expect(waitView(w({ platform: "cli", prompt: null }), tr as any)).toMatchObject({ title: "O Bot fez uma pergunta", where: "Responda no terminal do computador onde o Hermes roda.", inLuveBot: false });
    expect(waitView(w({ platform: "telegram" }), tr as any).where).toBe("Responda no Telegram.");
    expect(waitView(w({ platform: "discord" }), tr as any).where).toBe("Responda no canal onde a conversa começou.");
    expect(waitView(w({ kind: "sudo", prompt: "sudo rm -rf /" }), tr as any)).toMatchObject({ title: "O Bot pediu uma senha (sudo)", where: "Digite a senha no terminal do computador onde o Hermes roda. O LuveBot nunca recebe a senha.", inLuveBot: false });
    expect(waitView(w({ kind: "approval", platform: "telegram", prompt: null }), tr as any)).toMatchObject({ title: "O Bot pediu uma aprovação", where: "Aprove no Telegram." });
    expect(waitView(w({ kind: "approval", platform: "cli", prompt: null }), tr as any).where).toBe("Aprove no terminal do computador onde o Hermes roda.");
    expect(waitView(w({ kind: "other", prompt: null }), tr as any)).toMatchObject({ title: "O Bot está esperando uma resposta sua", where: "Veja no canal onde a conversa começou." });
  });
});

describe("Hoje, 'Precisa de você'", () => {
  it("lists the waits next to approvals: the question as plain text, where to go, since when; 'Abrir conversa' only for LuveBot's own conversation", () => {
    const onSelectBot = vi.fn();
    hoje([w({ request_id: "1".repeat(32) }), w({ request_id: "2".repeat(32), kind: "sudo", prompt: null, platform: "cli" }),
      w({ request_id: "3".repeat(32), kind: "approval", prompt: null, platform: "telegram" })], { onSelectBot });
    expect(screen.getByTestId("needs-you-count").textContent).toBe("3");
    const q = screen.getByTestId(`needs-you-item-waiting:${"1".repeat(32)}`);
    expect(q.textContent).toContain("Qual <b>cliente</b>?");
    expect(q.querySelector("b")).toBeNull();                                                  // text, never markup
    expect(q.textContent).toContain("Responda na conversa, aqui no LuveBot.");
    expect(q.textContent).toContain("Esperando você");
    expect(q.textContent).toMatch(/desde \d{2}:\d{2}/);
    fireEvent.click(within(q).getByRole("button", { name: /Abrir conversa/ }));
    expect(onSelectBot).toHaveBeenCalledWith("vendas", "s1");                          // and WHICH session: a wait in a thread opens that thread (red team M4)
    const sudo = screen.getByTestId(`needs-you-item-waiting:${"2".repeat(32)}`);
    expect(sudo.textContent).toContain("O Bot pediu uma senha (sudo)");
    expect(sudo.textContent).toContain("O LuveBot nunca recebe a senha.");
    expect(within(sudo).queryByRole("button")).toBeNull();                                     // nothing to press: it is answered elsewhere
    expect(within(screen.getByTestId(`needs-you-item-waiting:${"3".repeat(32)}`)).queryByRole("button")).toBeNull();
  });

  it("a Bot's question with no spaces wraps inside the row (red team T2)", () => {
    const long = "x".repeat(320);
    hoje([w({ prompt: long })]);
    const title = within(screen.getByTestId(`needs-you-item-waiting:${"a".repeat(32)}`)).getByText(long);
    expect(title.style.overflowWrap).toBe("anywhere");
    expect(title.style.whiteSpace).toBe("pre-wrap");
  });

  it("an activity 'waiting' item is not 'em andamento' with a Parar: it has no action route", () => {
    const item = { id: "waiting:x", kind: "waiting", bot: "vendas", title: null, origin: "message", status: "waiting_approval" } as ActivityItem;
    expect(inProgress([item])).toEqual([]);
    hoje([], { inProgressItems: [item], onStopActivity: vi.fn() });
    expect(screen.queryByTestId("in-progress-item-waiting:x")).toBeNull();
    expect(screen.queryByRole("button", { name: "Parar" })).toBeNull();
  });
});

describe("a leitura de /waiting", () => {
  let clock = new Date("2026-10-20T10:00:00").getTime();
  beforeEach(() => { clock += 31_000; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(clock); });
  function backend(res: WaitingResponse | Error, urls: string[] = []) {
    setCustomFetchJSON(async (url: string) => {
      if (url.includes("/waiting")) { urls.push(url); if (res instanceof Error) throw res; return res; }
      throw new Error("unexpected " + url);
    });
  }
  const live = () => render(<Hoje autoFetch bots={BOTS} approvals={[]} handoffs={[]} inProgressItems={[]} completedItems={[]} routines={[]} costs={{ totals: { spend_cents: 0 } } as any} budget={{ limits: [] } as any} />);

  it("Hoje reads it by itself, at most every 30 s (a remount reuses the last read), and shows what came", async () => {
    const urls: string[] = [];
    backend({ waiting: [w()], partial: [] }, urls);
    const r = live();
    await screen.findByTestId(`needs-you-item-waiting:${"a".repeat(32)}`);
    expect(urls).toEqual(["/api/plugins/luvebot/waiting"]);
    r.unmount();
    vi.setSystemTime(clock += 10_000);
    live();
    await screen.findByTestId(`needs-you-item-waiting:${"a".repeat(32)}`);
    expect(urls).toHaveLength(1);                                                              // 10 s later: not asked again
    cleanup();
    vi.setSystemTime(clock += WAIT_MIN_MS);
    live();
    await waitFor(() => expect(urls).toHaveLength(2));
  });

  it("a Bot whose rows could not be read is said quietly (never 'nobody waits'); a failed read shows nothing and no error", async () => {
    backend({ waiting: [], partial: ["dev"] });
    const r = live();
    expect((await screen.findByTestId("waiting-partial")).textContent).toBe("Não foi possível ver o que alguns Bots esperam de você agora.");
    r.unmount();
    vi.setSystemTime(clock += 31_000);
    backend(new Error("down"));
    live();
    await new Promise((res) => setTimeout(res, 40));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a hidden tab does not read it", async () => {
    const urls: string[] = [];
    backend({ waiting: [w()], partial: [] }, urls);
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try { live(); await new Promise((res) => setTimeout(res, 60)); expect(urls).toHaveLength(0); } finally { hidden.mockRestore(); }
  });
});

describe("Atividade", () => {
  const item = { id: "waiting:" + "b".repeat(32), kind: "waiting", bot: "vendas", title: null, origin: "message", status: "waiting_approval", started_at: null, links: { session_id: "s9" } } as unknown as ActivityItem;
  const other = { id: "run_1", kind: "run", bot: "vendas", title: null, origin: "message", status: "running" } as ActivityItem;
  const open = (view: "list" | "kanban") => {
    setCustomFetchJSON(async () => ({ items: [item, other], next_cursor: null }));
    return render(<ActivityView bots={BOTS} initialItems={[item, other]} initialView={view} />);
  };

  it("a wait with no LuveBot run is its own item, named by the screen, with no Parar, no Redirecionar, no detail: the list and the board", async () => {
    for (const view of ["list", "kanban"] as const) {
      const r = open(view);
      const card = await screen.findByTestId(view === "list" ? `activity-item-${item.id}` : `kanban-card-${item.id}`);
      expect(card.textContent).toContain("Esperando você em outro canal");
      expect(card.textContent).toContain("Responda onde a conversa está: o LuveBot só observa.");
      expect(within(card).queryByRole("button")).toBeNull();                                   // nothing to stop, redirect or open
      const run = screen.getByTestId(view === "list" ? "activity-item-run_1" : "kanban-card-run_1");
      expect(within(run).getAllByRole("button").length).toBeGreaterThan(0);                    // a real run keeps its actions
      r.unmount();
    }
  });
});

describe("a barra lateral diz por que o Bot espera", () => {
  const bot = (status: string, reason: string | null) => ({ ...BOTS[0], status, status_reason: reason }) as unknown as Bot;
  it("question, input (sudo) and a lost run each in words; an approval (no reason) and other states keep the Bot's role", () => {
    const rows: Array<[string, string | null, string]> = [
      ["waiting_approval", "question", "Fez uma pergunta"], ["waiting_approval", "input", "Pediu a senha no terminal"],
      ["waiting_approval", "run_unknown", "Execução perdida"], ["waiting_approval", null, "Cuida das vendas"],
      ["waiting_approval", "approval", "Cuida das vendas"], ["paused", "question", "Cuida das vendas"],
    ];
    for (const [status, reason, said] of rows) {
      const r = render(<ContactList bots={[bot(status, reason)]} onBotsChanged={() => {}} />);
      expect(document.querySelector("button[aria-pressed] .lb-subhead")!.textContent, `${status}/${reason}`).toBe(said);
      r.unmount();
    }
  });
});

describe("in English", () => {
  it("Hoje says it in English", () => {
    setLuveLocale("en");
    hoje([w({ kind: "sudo", prompt: null, platform: "cli" })]);
    const x = screen.getByTestId(`needs-you-item-waiting:${"a".repeat(32)}`);
    expect(x.textContent).toContain("The Bot asked for a password (sudo)");
    expect(x.textContent).toContain("LuveBot never receives the password.");
    expect(x.textContent).toContain("Waiting for you");
  });
});
