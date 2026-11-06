// tests/unit/conversation/threads.test.tsx
// Contract v0.8 §4: a thread is a NEW conversation of the same Bot about one message. It opens beside the conversation (a screen of its own on a phone),
// its first message goes to POST /threads with exactly {session_id, message_id, input} (the quote is written by the server, from what Hermes holds, never
// sent by the page), the quote shows as text at the top, a thread that exists shows as "N respostas" under its message, and the main conversation is
// never touched. The first message of a reopened thread carries the server's quote line: the panel takes it off the bubble and shows it as the quote.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { splitQuote } from "@/components/conversation/thread";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";

type Info = { message_id: number; child_session: string; replies: number | null; last_at: number | null };
type Sent = { url: string; body: any; csrf: string | null };
let threads: Info[], sent: Sent[], calls: string[], created: ApiError | null, childMessages: any[];
const bare = (u: string) => u.replace("/api/plugins/luvebot", "");
const QUOTE = "[Respondendo à mensagem de vendas (14:05 UTC): «Tudo certo por aqui.»]\n\n";

function backend() {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${bare(url)}`);
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (method === "GET" && url.includes("/bots/vendas/sessions?")) return { sessions: [{ id: "s1", kind: "conversation", last_active: 5 }] };
    if (method === "GET" && url.includes("/sessions/s1/messages")) return { messages: [{ id: 11, role: "user", text: "Qual o status?" }, { id: 12, role: "assistant", text: "Tudo certo por aqui." }] };
    if (method === "GET" && url.includes("/sessions/c1/messages")) return { messages: childMessages };
    if (method === "GET" && url.includes("/sessions/s1/threads")) return { threads, truncated: false };
    if (method === "GET" && url.includes("/activity?")) return { items: [] };
    return {};
  });
}
const sse = (...frames: Array<[string, object]>) => new Response(new ReadableStream({ start(c) { frames.forEach(([ev, d]) => c.enqueue(new TextEncoder().encode(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`))); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
const fetcher = async (url: string, init?: RequestInit) => {
  const u = bare(url);
  sent.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
  if (u.endsWith("/threads") && created) throw created;
  if (u.endsWith("/threads")) return sse(["luvebot.stream.open", { bot: "vendas", surface: "chat", api: "0", session_id: "c-new" }], ["message.delta", { delta: "Com 30 dias fecha em novembro." }], ["run.completed", { run_id: "r", output: "Com 30 dias fecha em novembro." }]);
  return sse(["luvebot.stream.open", { bot: "vendas", surface: "chat", api: "0", session_id: "c1" }], ["message.delta", { delta: "Anotado." }], ["run.completed", { run_id: "r", output: "Anotado." }]);
};
const open = () => render(<Conversation bot={{ name: "vendas", label: "Vendas" }} surface="chat" fetcher={fetcher as any} pollMs={10} />);
const strips = () => screen.getAllByTestId("reactions");
const panel = () => screen.getByTestId("thread-panel");
const chipText = (el: HTMLElement) => (el.textContent ?? "").replace("↩", "");
const mainTurns = () => document.querySelectorAll("[data-turn]").length;

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); threads = []; sent = []; calls = []; created = null;
  childMessages = [{ id: 31, role: "user", text: QUOTE + "e se for 30 dias?" }, { id: 32, role: "assistant", text: "Com 30 dias fecha em novembro." }]; });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); vi.unstubAllGlobals(); });

describe("the quote line the server writes", () => {
  it("is taken off the first message and returned as a quote (who, hour, excerpt); what does not match stays as it was said", () => {
    expect(splitQuote(QUOTE + "e se for 30 dias?")).toEqual({ quote: { who: "bot", name: "vendas", hour: "14:05 UTC", excerpt: "Tudo certo por aqui." }, text: "e se for 30 dias?" });
    expect(splitQuote("[Respondendo à mensagem da pessoa (2026-10-28 09:00 UTC): «Qual o status?»]\n\nok").quote).toMatchObject({ who: "person", name: null, hour: "2026-10-28 09:00 UTC" });
    expect(splitQuote("[Respondendo à mensagem da pessoa: «a\nb ] c»]\n\nok")).toEqual({ quote: { who: "person", name: null, hour: null, excerpt: "a\nb ] c" }, text: "ok" });
    expect(splitQuote("Respondendo à mensagem de vendas: «x»").quote).toBeNull();
    expect(splitQuote("oi [Respondendo à mensagem da pessoa: «x»]\n\ny")).toEqual({ quote: null, text: "oi [Respondendo à mensagem da pessoa: «x»]\n\ny" });   // only at the very start
  });
});

describe("starting a thread from a message", () => {
  it("opens beside the conversation with the quote as text; the first message goes to POST /threads with exactly three fields and the CSRF; the quote is NOT sent; the main conversation is untouched", async () => {
    backend(); open();
    await screen.findByText("Tudo certo por aqui.");
    const before = mainTurns();
    fireEvent.click(within(strips()[1]).getByRole("button", { name: "Responder em conversa" }));
    await screen.findByTestId("thread-panel");
    expect(screen.getByTestId("thread-quote").textContent).toContain("Respondendo a Vendas");
    expect(screen.getByTestId("thread-quote").textContent).toContain("Tudo certo por aqui.");
    expect(screen.getByTestId("thread-empty").textContent).toContain("Esta conversa fica ao lado e não mexe na conversa principal.");
    expect(screen.queryByRole("button", { name: "Fechar a conversa" })).toBeTruthy();
    const box = within(panel()).getByLabelText("Resposta na conversa");
    fireEvent.change(box, { target: { value: "e se for 30 dias?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await within(panel()).findByText("Com 30 dias fecha em novembro.");
    const post = sent.find((s) => s.url === "/bots/vendas/threads")!;
    expect(Object.keys(post.body).sort()).toEqual(["input", "message_id", "session_id"]);
    expect(post.body).toEqual({ session_id: "s1", message_id: 12, input: "e se for 30 dias?" });
    expect(post.csrf).toBe("csrf-1");
    expect(JSON.stringify(post.body)).not.toContain("Tudo certo por aqui.");                   // the server reads the quote from Hermes, never from the page
    expect(mainTurns()).toBe(before);                                                         // the thread is not a turn of the main conversation
    fireEvent.change(box, { target: { value: "e em dezembro?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(sent.some((s) => s.url === "/bots/vendas/sessions/c-new/chat/stream")).toBe(true));   // the next message continues the thread's own session
    expect(sent.filter((s) => s.url === "/bots/vendas/threads")).toHaveLength(1);
  });

  it("from the person's own message the quote says it is the person's; text with markup stays text", async () => {
    backend(); open();
    await screen.findByText("Tudo certo por aqui.");
    fireEvent.click(within(strips()[0]).getByRole("button", { name: "Responder em conversa" }));
    await screen.findByTestId("thread-panel");
    expect(screen.getByTestId("thread-quote").textContent).toContain("Respondendo a uma mensagem da pessoa");
    expect(screen.getByTestId("thread-quote").textContent).toContain("Qual o status?");
    fireEvent.click(screen.getByRole("button", { name: "Fechar a conversa" }));
    expect(screen.queryByTestId("thread-panel")).toBeNull();
  });

  it("a message Hermes has not saved: said in words, no panel opens, nothing is sent", async () => {
    backend();
    const live = [{ id: 7, user: "recém dita", state: { items: [{ kind: "message", id: "m", text: "resposta ao vivo" }], status: "completed" }, stopping: false, errors: [], confirmed: "completed" }] as any;
    render(<Conversation bot={{ name: "vendas", label: "Vendas" }} surface="chat" fetcher={fetcher as any} initialTurns={live} />);
    await screen.findByText("resposta ao vivo");
    fireEvent.click(within(strips()[1]).getByRole("button", { name: "Responder em conversa" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Esta mensagem ainda não foi salva no Hermes.");
    expect(screen.queryByTestId("thread-panel")).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("a refusal from the server (409 capability_missing) is said in the screen's own words, never the server's English; the person's text is not lost", async () => {
    created = new ApiError({ code: "capability_missing", message: "This Hermes cannot read one message, so threads are off.", status: 409 });
    backend(); open();
    await screen.findByText("Tudo certo por aqui.");
    fireEvent.click(within(strips()[1]).getByRole("button", { name: "Responder em conversa" }));
    const box = await within(await screen.findByTestId("thread-panel")).findByLabelText("Resposta na conversa");
    fireEvent.change(box, { target: { value: "tentando" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await within(panel()).findByText("tentando");                                              // what the person wrote stays on screen
    await waitFor(() => expect(panel().textContent).toContain("Esta versão do Hermes não oferece isso."));
    expect(panel().textContent).not.toContain("This Hermes cannot read one message");          // the sentence of the screen, never the server's English
  });
});

describe("a thread that exists", () => {
  it("shows 'N respostas' under its message (1 → '1 resposta', unknown → 'Conversa'), and opens its history with the quote at the top and only what the person typed in the bubble", async () => {
    threads = [{ message_id: 12, child_session: "c1", replies: 3, last_at: 1_800_000_000 }];
    backend(); open();
    await screen.findByText("Tudo certo por aqui.");
    const chip = await within(strips()[1]).findByTestId("thread-chip");
    expect(chipText(chip)).toBe("3 respostas");
    expect(within(strips()[0]).queryByTestId("thread-chip")).toBeNull();                      // under its own message only
    fireEvent.click(chip);
    const turn = await within(await screen.findByTestId("thread-panel")).findByTestId("thread-turn");
    expect(turn.textContent).toContain("e se for 30 dias?");
    expect(turn.textContent).not.toContain("Respondendo à mensagem");                         // the server's line is the quote above, not the person's words
    expect(screen.getByTestId("thread-quote").textContent).toContain("Respondendo a vendas · 14:05 UTC");
    expect(screen.getByTestId("thread-quote").textContent).toContain("Tudo certo por aqui.");
    await within(panel()).findByText("Com 30 dias fecha em novembro.");
    const box = within(panel()).getByLabelText("Resposta na conversa");
    fireEvent.change(box, { target: { value: "obrigado" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(sent.some((s) => s.url === "/bots/vendas/sessions/c1/chat/stream")).toBe(true));
    expect(sent.some((s) => s.url.endsWith("/threads"))).toBe(false);                         // an existing thread never goes through POST /threads again
  });

  it("the counts are read when the conversation opens and again when the thread is closed", async () => {
    threads = [{ message_id: 12, child_session: "c1", replies: 1, last_at: null }];
    backend(); open();
    await screen.findByText("Tudo certo por aqui.");
    expect(chipText(await within(strips()[1]).findByTestId("thread-chip"))).toBe("1 resposta");
    expect(calls.filter((c) => c === "GET /bots/vendas/sessions/s1/threads")).toHaveLength(1);
    threads = [{ message_id: 12, child_session: "c1", replies: null, last_at: null }, { message_id: 12, child_session: "c2", replies: 5, last_at: null }];
    fireEvent.click(within(strips()[1]).getByTestId("thread-chip"));
    await screen.findByTestId("thread-panel");
    fireEvent.click(screen.getByRole("button", { name: "Fechar a conversa" }));
    await waitFor(() => expect(within(strips()[1]).getAllByTestId("thread-chip").map(chipText)).toEqual(["Conversa", "5 respostas"]));   // several threads on one message: a chip each
    expect(calls.filter((c) => c === "GET /bots/vendas/sessions/s1/threads")).toHaveLength(2);
  });

  it("on a phone the thread is a screen of its own with its way back; in English", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
    setLuveLocale("en");
    threads = [{ message_id: 12, child_session: "c1", replies: 2, last_at: null }];
    backend(); open();
    await screen.findByText("Tudo certo por aqui.");
    fireEvent.click(await within(strips()[1]).findByTestId("thread-chip"));
    const dialog = await screen.findByRole("dialog", { name: "Conversation about a message" });
    expect(within(dialog).getByTestId("thread-panel")).toBeTruthy();
    expect(chipText(screen.getAllByTestId("thread-chip")[0])).toBe("2 replies");
    fireEvent.click(within(dialog).getByRole("button", { name: /Voltar para a conversa|Back to the conversation|Back to conversation/ }));
    expect(screen.queryByRole("dialog", { name: "Conversation about a message" })).toBeNull();
  });
});

describe("landmarks (red team 29/10, Info)", () => {
  const openChip = async () => {
    threads = [{ message_id: 12, child_session: "c1", replies: 2, last_at: null }];
    backend(); open();
    await screen.findByText("Tudo certo por aqui.");
    fireEvent.click(await within(strips()[1]).findByTestId("thread-chip"));
  };

  it("beside the conversation there is exactly ONE landmark named 'Conversa sobre uma mensagem', and it is not nested in another with that name", async () => {
    await openChip();
    await screen.findByTestId("thread-panel");
    const named = screen.getAllByRole("complementary", { name: "Conversa sobre uma mensagem" });
    expect(named).toHaveLength(1);
    expect(named[0].querySelector("[role=complementary]")).toBeNull();
  });

  it("on a phone it is one dialog with that name and no complementary landmark of it", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
    await openChip();
    await screen.findByRole("dialog", { name: "Conversa sobre uma mensagem" });
    expect(screen.queryAllByRole("complementary", { name: "Conversa sobre uma mensagem" })).toHaveLength(0);
  });
});
