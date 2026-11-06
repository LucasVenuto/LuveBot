// tests/unit/conversation/reactions.test.tsx
// Contract v0.8 §4: the team's mark on a message. Hermes keeps ONE `user` slot per message (a second person replaces the first) plus the Bot's own
// `agent` slot; the page shows "the team's reaction", never a name and never "mine", sets or clears it through PUT / DELETE, and takes the answer's
// list as the truth. A turn the history knows has its saved row ids; a turn drawn live asks the history once and is matched by what the person said
// (no match = no mark, never a guess). The note says one reaction per message and that another replaces it, never that the Bot saw or sent one.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { rowsOfLive, turnsFromHistory } from "@/components/chat/history";
import type { Turn } from "@/components/chat/useConversation";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import { REACTION_SET } from "@/components/conversation/reactionSet";

type Mark = { emoji: string; author: "user" | "agent" };
type Msg = { id: number; role: "user" | "assistant"; text: string };
type World = { messages: Msg[]; marks: Record<number, Mark[]>; fail?: (method: string, url: string) => ApiError | null; calls: Array<{ method: string; url: string; csrf: string | null }> };
let w: World;
const enc = (e: string) => encodeURIComponent(e);
const bare = (u: string) => u.replace("/api/plugins/luvebot", "");

function backend(stream: Array<[string, object]> = []) {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (method === "GET" && url.includes("/bots/vendas/sessions?")) return { sessions: w.messages.length ? [{ id: "s1", kind: "conversation", last_active: 5 }] : [] };
    if (method === "GET" && /\/sessions\/[^/]+\/messages/.test(url)) {
      w.calls.push({ method, url: bare(url), csrf: null });
      return { messages: w.messages.map((m) => ({ ...m, ...(w.marks[m.id]?.length ? { reactions: w.marks[m.id] } : {}) })) };
    }
    if (method === "GET" && url.includes("/activity?")) return { items: [] };
    if (method === "GET" && url.endsWith("/voice")) return {};
    const react = url.match(/\/sessions\/([^/]+)\/messages\/(\d+)\/reactions\/(.+)$/);
    if (react && (method === "PUT" || method === "DELETE")) {
      w.calls.push({ method, url: bare(url), csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
      const err = w.fail?.(method, url); if (err) throw err;
      const id = Number(react[2]), emoji = decodeURIComponent(react[3]);
      const others = (w.marks[id] ?? []).filter((m) => m.author !== "user");
      const stored = (w.marks[id] ?? []).find((m) => m.author === "user")?.emoji;
      if (method === "PUT") w.marks[id] = [{ emoji, author: "user" }, ...others];
      else if (stored === emoji) w.marks[id] = others;                       // DELETE clears only the mark it names
      return { reactions: w.marks[id] ?? [] };
    }
    if (method === "POST" && url.endsWith("/chat/stream")) return {};
    return {};
  });
  return stream.length ? async () => new Response(new ReadableStream({ start(c) { stream.forEach(([ev, d]) => c.enqueue(new TextEncoder().encode(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`))); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } }) : undefined;
}
const open = (fetcher?: any, surface: "run" | "chat" = "run") => render(<Conversation bot={{ name: "vendas", label: "Vendas" }} surface={surface} fetcher={fetcher} pollMs={10} />);
const strips = () => screen.getAllByTestId("reactions");
const writes = () => w.calls.filter((c) => c.method === "PUT" || c.method === "DELETE");

beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt");
  w = { messages: [{ id: 11, role: "user", text: "Qual o status?" }, { id: 12, role: "assistant", text: "Tudo certo por aqui." }], marks: {}, calls: [] };
});
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });

describe("marks on a message the history knows", () => {
  it("shows the team's mark and the Bot's own apart; the Bot's cannot be taken off here", async () => {
    w.marks[12] = [{ emoji: "👍", author: "user" }, { emoji: "👀", author: "agent" }];
    backend(); open();
    await screen.findByText("Tudo certo por aqui.");
    const reply = strips()[1];
    const team = within(reply).getByTestId("reaction-mark");
    expect(team.textContent).toBe("👍");
    expect(team.getAttribute("aria-label")).toBe("Reação da equipe: Tirar a reação 👍");
    expect(team.getAttribute("aria-pressed")).toBe("true");
    const bot = within(reply).getByTestId("reaction-mark-bot");
    expect(bot.textContent).toBe("👀");
    expect(bot.getAttribute("aria-label")).toBe("Reação do Bot: 👀");
    expect(bot.tagName).toBe("SPAN");                                            // not a button: nothing to click
    expect(within(strips()[0]).queryByTestId("reaction-mark")).toBeNull();        // the person's own message has none
  });

  it("reacting: PUT with the CSRF to the message's row, the emoji encoded; the answer's list is what is shown; the note says one reaction per message, never that the Bot saw it", async () => {
    backend(); open();
    await screen.findByText("Tudo certo por aqui.");
    fireEvent.click(within(strips()[1]).getByRole("button", { name: "Reagir" }));
    const picker = screen.getByRole("group", { name: "Escolha uma reação" });
    expect(within(picker).getAllByRole("button").map((b) => b.textContent)).toEqual([...REACTION_SET]);   // the grid of 24, in the contract's order
    expect(picker.textContent).toContain("Uma reação sua por mensagem; escolher outra troca a anterior.");
    expect(picker.textContent).not.toMatch(/Bot viu|o Bot leu/i);
    fireEvent.click(within(picker).getByRole("button", { name: "Reagir com ❤️" }));
    await waitFor(() => expect(within(strips()[1]).getByTestId("reaction-mark").textContent).toBe("❤️"));
    expect(writes()).toEqual([{ method: "PUT", url: `/bots/vendas/sessions/s1/messages/12/reactions/${enc("❤️")}`, csrf: "csrf-1" }]);
    expect(screen.queryByRole("group", { name: "Escolha uma reação" })).toBeNull();            // closed after saving
  });

  it("the person's own message takes a mark too (its own row); another emoji REPLACES the team's one (one slot); the same emoji takes it off (DELETE)", async () => {
    backend(); open();
    await screen.findByText("Tudo certo por aqui.");
    fireEvent.click(within(strips()[0]).getByRole("button", { name: "Reagir" }));
    fireEvent.click(screen.getByRole("button", { name: "Reagir com 🎉" }));
    await waitFor(() => expect(within(strips()[0]).getByTestId("reaction-mark").textContent).toBe("🎉"));
    expect(writes()[0].url).toBe(`/bots/vendas/sessions/s1/messages/11/reactions/${enc("🎉")}`);
    fireEvent.click(within(strips()[0]).getByRole("button", { name: "Reagir" }));
    fireEvent.click(screen.getByRole("button", { name: "Reagir com ✅" }));
    await waitFor(() => expect(within(strips()[0]).getByTestId("reaction-mark").textContent).toBe("✅"));
    expect(within(strips()[0]).getAllByTestId("reaction-mark")).toHaveLength(1);               // replaced, not added
    fireEvent.click(within(strips()[0]).getByTestId("reaction-mark"));                          // the chip itself takes it off
    await waitFor(() => expect(within(strips()[0]).queryByTestId("reaction-mark")).toBeNull());
    expect(writes().map((c) => c.method)).toEqual(["PUT", "PUT", "DELETE"]);
    expect(writes()[2].url).toBe(`/bots/vendas/sessions/s1/messages/11/reactions/${enc("✅")}`);
  });

  it("in the picker the current mark is pressed and offers to take it off; an unsaved message, a busy Hermes and a failure are said in words", async () => {
    w.marks[12] = [{ emoji: "👍", author: "user" }];
    backend(); open();
    await screen.findByText("Tudo certo por aqui.");
    fireEvent.click(within(strips()[1]).getByRole("button", { name: "Reagir" }));
    expect(screen.getByRole("button", { name: "Tirar a reação 👍" }).getAttribute("aria-pressed")).toBe("true");
    for (const [code, status, said] of [["message_not_saved", 409, "Esta mensagem ainda não foi salva no Hermes. Tente de novo em instantes."],
      ["hermes_busy", 503, "O Hermes está salvando outra coisa. Tente de novo."], ["something_new", 500, "Não foi possível salvar a reação."]] as const) {
      w.fail = () => new ApiError({ code, message: "English from the server", status });
      fireEvent.click(screen.getByRole("button", { name: "Reagir com 🎉" }));
      expect((await screen.findByRole("alert")).textContent).toContain(said);
      expect(screen.getByRole("alert").textContent).not.toContain("English from the server");
    }
    expect(writes().length).toBeGreaterThan(0);
    expect(within(strips()[1]).getByTestId("reaction-mark").textContent).toBe("👍");           // nothing changed on screen
  });

  it("a Hermes that cannot keep reactions (409 capability_missing): said once, and the '+' goes away from every message", async () => {
    backend(); open();
    await screen.findByText("Tudo certo por aqui.");
    w.fail = () => new ApiError({ code: "capability_missing", message: "x", status: 409 });
    fireEvent.click(within(strips()[1]).getByRole("button", { name: "Reagir" }));
    fireEvent.click(screen.getByRole("button", { name: "Reagir com 👍" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Este Hermes não guarda reações.");
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "Reagir" })).toHaveLength(0));
  });

  it("the turn keeps no svg (agent-facing turns never carry one; the '+' is a text glyph, like the steps line's)", async () => {
    w.marks[12] = [{ emoji: "👍", author: "user" }];
    backend(); open();
    await screen.findByText("Tudo certo por aqui.");
    fireEvent.click(within(strips()[1]).getByRole("button", { name: "Reagir" }));
    expect(screen.getByRole("group", { name: "Escolha uma reação" })).toBeTruthy();
    for (const turn of document.querySelectorAll("[data-turn]")) expect(turn.querySelector("svg")).toBeNull();
  });

  it("in English", async () => {
    setLuveLocale("en");
    w.marks[12] = [{ emoji: "👍", author: "user" }];
    backend(); open();
    await screen.findByText("Tudo certo por aqui.");
    expect(within(strips()[1]).getByTestId("reaction-mark").getAttribute("aria-label")).toBe("The team's reaction: Remove the 👍 reaction");
    fireEvent.click(within(strips()[1]).getByRole("button", { name: "React" }));
    expect(screen.getByRole("group", { name: "Pick a reaction" }).textContent).toContain("One reaction from you per message; picking another replaces it.");
  });
});

describe("a turn drawn live has no row yet: the history says where it was saved", () => {
  const frames: Array<[string, object]> = [["luvebot.stream.open", { bot: "vendas", surface: "chat", api: "0", session_id: "s-chat" }], ["message.delta", { delta: "feito" }], ["run.completed", { run_id: "r", output: "feito" }]];
  const send = (text: string) => { fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: text } }); fireEvent.click(screen.getByText("Enviar")); };

  it("reacting asks the history once, matches the turn by what the person said, and writes to the saved row", async () => {
    w.messages = [];                                                            // a new conversation
    const fetcher = backend(frames);
    open(fetcher, "chat");
    await waitFor(() => expect(screen.queryByTestId("conversation-loading")).toBeNull());
    send("oi");
    await screen.findByText("feito");
    await waitFor(() => expect(screen.queryByText("Parar")).toBeNull());
    w.messages = [{ id: 21, role: "user", text: "oi" }, { id: 22, role: "assistant", text: "feito" }];   // Hermes has stored it by now
    fireEvent.click(within(strips()[1]).getByRole("button", { name: "Reagir" }));
    fireEvent.click(screen.getByRole("button", { name: "Reagir com 👍" }));
    await waitFor(() => expect(within(strips()[1]).getByTestId("reaction-mark").textContent).toBe("👍"));
    expect(w.calls.filter((c) => c.method === "GET" && c.url.includes("/sessions/s-chat/messages"))).toHaveLength(1);
    expect(writes()).toEqual([{ method: "PUT", url: `/bots/vendas/sessions/s-chat/messages/22/reactions/${enc("👍")}`, csrf: "csrf-1" }]);
    fireEvent.click(within(strips()[0]).getByRole("button", { name: "Reagir" }));          // the person's own: already resolved, no second read
    fireEvent.click(screen.getByRole("button", { name: "Reagir com 🎉" }));
    await waitFor(() => expect(within(strips()[0]).getByTestId("reaction-mark").textContent).toBe("🎉"));
    expect(writes()[1].url).toBe(`/bots/vendas/sessions/s-chat/messages/21/reactions/${enc("🎉")}`);
    expect(w.calls.filter((c) => c.method === "GET" && c.url.includes("/messages"))).toHaveLength(1);
  });

  it("a history that does not show the turn the same way gives no row: 'ainda não foi salva', and NOTHING is written (never a guess)", async () => {
    w.messages = [];
    const fetcher = backend(frames);
    open(fetcher, "chat");
    await waitFor(() => expect(screen.queryByTestId("conversation-loading")).toBeNull());
    send("oi");
    await screen.findByText("feito");
    await waitFor(() => expect(screen.queryByText("Parar")).toBeNull());
    w.messages = [{ id: 31, role: "user", text: "outra coisa" }, { id: 32, role: "assistant", text: "feito" }];
    fireEvent.click(within(strips()[1]).getByRole("button", { name: "Reagir" }));
    fireEvent.click(screen.getByRole("button", { name: "Reagir com 👍" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Esta mensagem ainda não foi salva no Hermes.");
    expect(writes()).toHaveLength(0);
  });
});

describe("rowsOfLive (matching a live turn to the history)", () => {
  const live = (user: string, confirmed?: Turn["confirmed"]): Turn => ({ id: Math.floor(Math.random() * 1e6), user, state: { items: [], status: "idle" } as any, stopping: false, errors: [], confirmed });
  const hist = (...pairs: Array<[string, number, number]>) => pairs.flatMap(([u, a, b]) => [{ id: a, role: "user" as const, text: u }, { id: b, role: "assistant" as const, text: "r " + u }]);

  it("matches from the end; a turn still running is skipped (it is not stored yet) and the finished ones before it are still matched", () => {
    const a = live("um", "completed"), b = live("dois", "completed"), running = live("três");
    const found = rowsOfLive([a, b, running], hist(["um", 1, 2], ["dois", 3, 4]));
    expect(found.get(a.id)?.userRow?.id).toBe(1);
    expect(found.get(b.id)?.replyRow?.id).toBe(4);
    expect(found.has(running.id)).toBe(false);
  });

  it("stops at the first finished turn that does not match, and leaves older turns (already from the history) alone", () => {
    const old = turnsFromHistory(hist(["velho", 1, 2]))[0];
    const a = live("novo", "completed");
    expect(rowsOfLive([old, a], hist(["velho", 1, 2], ["novo", 3, 4])).get(a.id)?.userRow?.id).toBe(3);
    expect(rowsOfLive([old, a], hist(["velho", 1, 2], ["diferente", 3, 4])).size).toBe(0);
  });

  it("a message with no durable id (a string that is not digits) is not a row", () => {
    const turns = turnsFromHistory([{ id: "tmp-1", role: "user", text: "oi" }, { id: 0, role: "assistant", text: "ola" }] as any);
    expect(turns[0].userRow).toBeUndefined();
    expect(turns[0].replyRow).toBeUndefined();
  });
});
