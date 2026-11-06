// tests/unit/conversation/queued-and-other-channel.test.tsx
// Contract v0.9 §1.6-1.7. A run Hermes accepted and queued is NORMAL: said as "na fila", never an error, never resent, followed by GET until
// it runs. A conversation that belongs to another channel (409 session_other_channel) is not an error either: "Nova conversa" comes first (the
// end of the old one and the refused message go to the composer, nothing is sent), and "Continuar numa cópia" is the second button with its
// warning, because Hermes ENDS the original. Both are a person's click.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { turnsFromHistory } from "@/components/chat/history";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";

const BOT = { name: "vendas", label: "Vendas" };
const refusal = (code: string, status: number, details?: Record<string, unknown>) => ({ status, body: JSON.stringify({ error: { code, message: "English for developers", details } }) });
const HISTORY = [{ id: 1, role: "user", text: "Quais leads de ontem?" }, { id: 2, role: "assistant", text: "Foram 12 leads, 5 de Campinas." }];
const past = () => turnsFromHistory(HISTORY as any);
type Calls = { runs: any[]; forks: string[]; gets: number };
function world(over: { createRun?: () => unknown; fork?: () => unknown; getRun?: (n: number) => unknown } = {}): Calls {
  const c: Calls = { runs: [], forks: [], gets: 0 };
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    // an existing conversation of the Bot (the first message of a NEW one makes its session in the same call: contract v0.9 §10)
    if (method === "GET" && url.includes("/bots/vendas/sessions?")) return { sessions: [{ id: "s1", kind: "conversation", last_active: 5 }] };
    if (method === "GET" && url.includes("/sessions/s1/messages")) return { messages: HISTORY };
    if (method === "POST" && url.endsWith("/runs")) { c.runs.push(JSON.parse(String(init?.body))); return over.createRun ? over.createRun() : { run: { id: "r1", status: "started", session_id: "s1" } }; }
    if (method === "POST" && /\/sessions\/[^/]+\/fork$/.test(url)) { c.forks.push(url); return over.fork ? over.fork() : { session: { id: "s2", title: "copia" } }; }
    if (method === "GET" && url.endsWith("/runs/r1")) return over.getRun ? over.getRun(++c.gets) : { run: { id: "r1", status: "completed", output: "ok" } };
    return {};
  });
  return c;
}
const idle = async () => new Response(new ReadableStream(), { status: 200, headers: { "content-type": "text/event-stream" } });
const sse = (...frames: object[]) => async () => new Response(new ReadableStream({ start(c) {
  frames.forEach((f, i) => c.enqueue(new TextEncoder().encode(`id: ${i + 1}\ndata: ${JSON.stringify(f)}\n\n`))); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
const composer = () => screen.getByRole("textbox", { name: /^(Mensagem|Message)$/ }) as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(composer(), { target: { value: text } });

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => setCustomFetchJSON(null));

describe("run na fila (queued)", () => {
  it("the stream's run.queued frame: 'na fila, não envie de novo' (not an error), followed by GET until it runs, then the answer", async () => {
    let phase: "queued" | "started" | "done" = "queued";   // each phase lasts until the test moves it: no race with the poll
    world({ getRun: () => ({ run: phase === "queued" ? { id: "r1", status: "queued" } : phase === "started" ? { id: "r1", status: "started" } : { id: "r1", status: "completed", output: "Pronto." } }) });
    render(<Conversation bot={BOT} fetcher={sse({ event: "run.queued", status: "queued", code: "run_queued", run_id: "r1" })} pollMs={20} />);
    type("faz isso"); fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByText("Na fila do Hermes. Não envie de novo: roda assim que ele voltar.");
    await new Promise((r) => setTimeout(r, 80));                                       // several polls: still queued, still not an error
    expect(screen.getByText("Na fila do Hermes. Não envie de novo: roda assim que ele voltar.")).toBeTruthy();
    expect(screen.queryByText(/falhou|erro/i)).toBeNull();
    phase = "started";
    await screen.findByText("Trabalhando…");                                           // Hermes picked it up: the line moves on by itself
    expect(screen.queryByText(/Na fila do Hermes/)).toBeNull();
    phase = "done";
    await screen.findByText("Pronto.");
  });

  it("accepted with no run to follow (202 queued): said as queued, the composer is free, and nothing is sent twice", async () => {
    const c = world({ createRun: () => ({ run: null, queued: true, code: "run_queued" }) });
    render(<Conversation bot={BOT} fetcher={idle} />);
    type("faz isso"); fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByText("Na fila do Hermes. Não envie de novo: roda assim que ele voltar.");
    expect(c.runs).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Parar" })).toBeNull();                 // nothing to stop: Hermes has it
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("conversa de outro canal (session_other_channel)", () => {
  const refuseRun = () => { throw refusal("session_other_channel", 409, { source: "cli", can_fork: true }); };

  it("not an error: a card with 'Nova conversa' FIRST and 'Continuar numa cópia' second, with the warning that Hermes ends the original", async () => {
    world({ createRun: refuseRun });
    render(<Conversation bot={BOT} fetcher={idle} />);
    await screen.findByText("Foram 12 leads, 5 de Campinas.");                          // the Bot's existing conversation (session s1) is open
    type("e os de hoje?"); fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    const card = await screen.findByTestId("other-channel-card");
    expect(card.textContent).toContain("Esta conversa é de outro canal");
    expect(card.textContent).toContain("(do terminal)");
    const buttons = within(card).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Nova conversa", "Continuar numa cópia"]);
    expect(buttons[0].className).toContain("lb-btn-primary");
    expect(buttons[1].className).not.toContain("lb-btn-primary");
    expect(card.textContent).toContain("A cópia continua a conversa de onde parou, mas o Hermes encerra a original.");
    expect(buttons[1].getAttribute("aria-describedby")).toBe("channel-fork-warn");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("session_other_channel");
  });

  it("'Nova conversa': the screen starts clean and the composer holds the end of the old one plus the refused message; NOTHING is sent until the person sends", async () => {
    const c = world({ createRun: refuseRun });
    render(<Conversation bot={BOT} fetcher={idle} />);
    await screen.findByText("Foram 12 leads, 5 de Campinas.");                          // the Bot's existing conversation (session s1) is open
    type("e os de hoje?"); fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Nova conversa" }));
    expect(screen.queryByTestId("other-channel-card")).toBeNull();
    expect(document.querySelector("[data-turn]")).toBeNull();                              // the old turns left the screen
    expect(composer().value).toBe("Continuando uma conversa do terminal. O fim dela:\nVocê: Quais leads de ontem?\nBot: Foram 12 leads, 5 de Campinas.\n\ne os de hoje?");
    expect(c.runs).toHaveLength(1);                                                       // only the refused attempt: nothing sent by the click
    expect(c.forks).toHaveLength(0);
  });

  it("'Continuar numa cópia': a click forks (Hermes ends the original), the refused message returns to the composer, and the next message goes to the COPY", async () => {
    let first = true;
    const c = world({ createRun: () => { if (first) { first = false; throw refusal("session_other_channel", 409, { source: "telegram" }); } return { run: { id: "r1", status: "started", session_id: "s2" } }; } });
    render(<Conversation bot={BOT} fetcher={idle} />);
    await screen.findByText("Foram 12 leads, 5 de Campinas.");                          // the Bot's existing conversation (session s1) is open
    type("e os de hoje?"); fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    const card = await screen.findByTestId("other-channel-card");
    expect(card.textContent).toContain("(do Telegram)");
    expect(c.forks).toHaveLength(0);                                                      // never before the click
    fireEvent.click(within(card).getByRole("button", { name: "Continuar numa cópia" }));
    await waitFor(() => expect(composer().value).toBe("e os de hoje?"));
    expect(c.forks).toHaveLength(1);
    expect(c.forks[0]).toMatch(/\/bots\/vendas\/sessions\/s1\/fork$/);
    expect(screen.queryByTestId("other-channel-card")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(c.runs).toHaveLength(2));
    expect(c.runs[1].session_id).toBe("s2");
  });

  it("a copy that fails is said in words and the card stays (Nova conversa still works)", async () => {
    world({ createRun: refuseRun, fork: () => { throw refusal("hermes_busy", 503); } });
    render(<Conversation bot={BOT} fetcher={idle} />);
    await screen.findByText("Foram 12 leads, 5 de Campinas.");                          // the Bot's existing conversation (session s1) is open
    type("e os de hoje?"); fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continuar numa cópia" }));
    await screen.findByText(/O Hermes está ocupado salvando/);
    expect(screen.getByTestId("other-channel-card")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Nova conversa" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("in English", async () => {
    setLuveLocale("en");
    world({ createRun: refuseRun });
    render(<Conversation bot={BOT} fetcher={idle} />);
    await screen.findByText("Foram 12 leads, 5 de Campinas.");                          // the Bot's existing conversation (session s1) is open
    type("and today's?"); fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const card = await screen.findByTestId("other-channel-card");
    expect(within(card).getAllByRole("button").map((b) => b.textContent)).toEqual(["New conversation", "Continue in a copy"]);
    fireEvent.click(within(card).getByRole("button", { name: "New conversation" }));
    expect(composer().value).toContain("Continuing a conversation from the terminal. The end of it:\nYou: Quais leads de ontem?");
  });
});
