// tests/unit/conversation/skill-draft-flow.test.tsx
// "Save as a skill" in the conversation, end to end (contract v0.11 3.2 steps 1 and 2, A-175): the menu item, the dialog, ONE request, the run it starts followed as a turn with a label line and NO person's bubble, the
// Bot's FINAL answer of THAT turn drawn as a card (never the text), the same after a reload (the history's placeholder row), and a `luve-skill` fence anywhere else is just a message.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within, configure } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { turnsFromHistory } from "@/components/chat/history";
import { resetCsrfToken, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const BOT = { name: "vendas", label: "Vendas", color: "#60a5fa" };
const BODY = "---\nname: send-report\ndescription: Use when a report must go out.\n---\n1. Open the SECRET-STEP report.\n2. Send it.";
const FENCE = "```luve-skill\n" + BODY + "\n```";
const enc = new TextEncoder();
const sse = (run: string, seq: number, data: Record<string, any>) => `id: ${seq}\ndata: ${JSON.stringify({ ...data, run_id: run, seq })}\n\n`;
const streamOf = (...chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { chunks.forEach((x) => c.enqueue(enc.encode(x))); c.close(); } });
const open = (body: ReadableStream<Uint8Array>) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

type Seen = { posts: Array<{ url: string; body: any }> };
let seen: Seen;
let draftBody: () => ReadableStream<Uint8Array>;
function backend() {
  seen = { posts: [] };
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace("/api/plugins/luvebot", "");
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (method === "POST") seen.posts.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === "POST" && path === "/bots/vendas/runs") return { run: { id: "run_1", status: "started", session_id: "s1" } };
    if (method === "POST" && path === "/bots/vendas/skills/draft") return { run: { id: "run_d1", status: "started", bot: "vendas", session_id: "s1" } };
    if (method === "GET" && /\/runs\/run_(1|d1)$/.test(path)) return { run: { id: path.split("/").pop(), status: "completed" } };
    return {};
  });
}
const fetcher = async (url: string) => (url.includes("/runs/run_d1/events") ? open(draftBody())
  : url.includes("/runs/run_1/events") ? open(streamOf(sse("run_1", 1, { event: "message.delta", delta: "Feito, enviei o relatório." }), sse("run_1", 2, { event: "run.completed", output: "Feito, enviei o relatório." })))
  : open(new ReadableStream()));
const says = async (text = "faça o relatório") => { fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: text } }); fireEvent.click(screen.getByText("Enviar")); await screen.findByText("Feito, enviei o relatório."); await waitFor(() => expect(screen.queryByText("Parar")).toBeNull()); };
const draftEnds = (text: string) => () => streamOf(sse("run_d1", 1, { event: "message.delta", delta: text }), sse("run_d1", 2, { event: "run.completed", output: text }));
const pickAsk = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Mais ações desta mensagem" }));
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Salvar como skill/ }));
};
const ask = () => fireEvent.click(screen.getByRole("button", { name: "Pedir o rascunho" }));

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); backend(); draftBody = draftEnds(FENCE); });
afterEach(() => setCustomFetchJSON(null));

describe("asking for a draft", () => {
  it("the Bot's message menu has 'Salvar como skill'; it opens the dialog with the cost, and sends nothing until the click", async () => {
    render(<Conversation bot={BOT} fetcher={fetcher} pollMs={5} />);
    await says();
    await pickAsk();
    expect(screen.getByRole("dialog").textContent).toContain("Isto gasta uma vez do seu Bot");
    await new Promise((r) => setTimeout(r, 60));
    expect(seen.posts.map((p) => p.url)).toEqual(["/bots/vendas/runs"]);                         // only the first message so far
  });

  it("ONE request with the conversation's session; the run it starts is followed as a turn: a label line, no person's bubble, and the card", async () => {
    render(<Conversation bot={BOT} fetcher={fetcher} pollMs={5} />);
    await says();
    await pickAsk();
    fireEvent.change(screen.getByLabelText("Sobre o que a skill deve ser (opcional)"), { target: { value: "enviar o relatório" } });
    ask();
    const card = await screen.findByTestId("skill-draft-card");
    const drafts = seen.posts.filter((p) => p.url === "/bots/vendas/skills/draft");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toEqual({ session_id: "s1", note: "enviar o relatório" });
    expect(card.textContent).toContain("Rascunho pronto, 6 linhas");
    expect(screen.getByText("Você pediu ao seu Bot um rascunho de skill")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();                                           // the ask dialog closed
    expect(document.body.textContent).not.toContain("SECRET-STEP");                            // the draft text is nowhere in the conversation
    expect(document.body.textContent).not.toContain("enviar o relatório");                     // and the note is not drawn as something the person said
    const turns = document.querySelectorAll("[data-turn]");
    expect(turns).toHaveLength(2);
    expect(within(turns[1] as HTMLElement).queryByText(/faça|enviar/)).toBeNull();            // no bubble of the person in the draft turn
  });

  it("while the Bot writes it the text is NOT drawn (one calm line), and when it is done the card replaces the line", async () => {
    let finish!: () => void;
    draftBody = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(sse("run_d1", 1, { event: "message.delta", delta: "```luve-skill\n---\nname: SECRET-WIP" }))); finish = () => { c.enqueue(enc.encode(sse("run_d1", 2, { event: "message.delta", delta: "\n```" }))); c.enqueue(enc.encode(sse("run_d1", 3, { event: "run.completed", output: "x" }))); c.close(); }; } });
    render(<Conversation bot={BOT} fetcher={fetcher} pollMs={5} />);
    await says();
    await pickAsk();
    ask();
    await screen.findByText("O Bot está escrevendo o rascunho…");
    expect(document.body.textContent).not.toContain("SECRET-WIP");
    expect(screen.queryByTestId("skill-draft-card")).toBeNull();
    finish();
    await waitFor(() => expect(screen.queryByText("O Bot está escrevendo o rascunho…")).toBeNull());
  });

  it("the dialog's button is off while a turn is still running (the draft turn would have to wait)", async () => {
    render(<Conversation bot={BOT} fetcher={async (url: string) => (url.includes("/runs/run_1/events") ? open(new ReadableStream()) : open(new ReadableStream()))} pollMs={5000} />);
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "algo longo" } });
    fireEvent.click(screen.getByText("Enviar"));
    await screen.findByText("Parar");
    expect(screen.queryByRole("button", { name: "Mais ações desta mensagem" })).toBeNull();     // no completed Bot message yet: nothing to open the dialog from
  });
});

describe("what comes back", () => {
  it("an answer that is not a draft stays ordinary text, with the reason and 'Pedir de novo' (which opens the dialog again)", async () => {
    draftBody = draftEnds("Não consegui montar a skill, desculpe.");
    render(<Conversation bot={BOT} fetcher={fetcher} pollMs={5} />);
    await says();
    await pickAsk();
    ask();
    await screen.findByTestId("skill-draft-refused");
    expect(screen.getByText("Não consegui montar a skill, desculpe.")).toBeTruthy();
    expect(screen.getByTestId("skill-draft-refused").textContent).toContain("A resposta do Bot não é um rascunho de skill.");
    fireEvent.click(screen.getByRole("button", { name: "Pedir de novo" }));
    expect(screen.getByRole("dialog").textContent).toContain("Isto gasta uma vez do seu Bot");
  });

  it("a draft with a refused character: the reason in words (class and place, never the character), and the Bot's message is still drawn as an ordinary message (A-185)", async () => {
    const tag = String.fromCodePoint(0xe0041);
    draftBody = draftEnds(FENCE.replace("Send it.", "Send it." + tag));
    render(<Conversation bot={BOT} fetcher={fetcher} pollMs={5} />);
    await says();
    await pickAsk();
    ask();
    const note = await screen.findByTestId("skill-draft-refused");
    expect(note.textContent).toContain("um caractere de etiqueta Unicode");
    expect(note.textContent).not.toContain(tag);
    expect(document.body.textContent).toContain("SECRET-STEP");                                 // the message is on the screen, none of the Bot's words is kept from the person
    expect(screen.queryByTestId("skill-draft-card")).toBeNull();
  });

  it("the draft turn's own answer has no 'Salvar como skill' to ask again from (a card has no menu); the earlier message still has it", async () => {
    render(<Conversation bot={BOT} fetcher={fetcher} pollMs={5} />);
    await says();
    await pickAsk();
    ask();
    await screen.findByTestId("skill-draft-card");
    expect(screen.getAllByRole("button", { name: "Mais ações desta mensagem" })).toHaveLength(1);
  });
});

describe("a luve-skill fence is a draft ONLY in the turn the request started", () => {
  it("in an ordinary answer (a web page, a tool result or a person's text steered the Bot into it) it is a message, never the card", async () => {
    const steered = "Segue:\n" + FENCE;
    const fetchSteered = async (url: string) => (url.includes("/runs/run_1/events")
      ? open(streamOf(sse("run_1", 1, { event: "message.delta", delta: steered }), sse("run_1", 2, { event: "run.completed", output: steered }))) : open(new ReadableStream()));
    render(<Conversation bot={BOT} fetcher={fetchSteered} pollMs={5} />);
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "leia esta página" } });
    fireEvent.click(screen.getByText("Enviar"));
    await screen.findByText("Segue:");
    await waitFor(() => expect(screen.queryByText("Parar")).toBeNull());
    expect(screen.queryByTestId("skill-draft-card")).toBeNull();
    expect(screen.queryByTestId("skill-draft-refused")).toBeNull();
    expect(screen.queryByText("Você pediu ao seu Bot um rascunho de skill")).toBeNull();
  });

  it("the history: ONLY the reply that follows the placeholder row is read as a draft; an earlier or later reply with a fence is a message", () => {
    const turns = turnsFromHistory([
      { id: 1, role: "user", text: "oi" }, { id: 2, role: "assistant", text: "Segue:\n" + FENCE },
      { id: 3, role: "user", text: "", display_kind: "skill_draft" }, { id: 4, role: "assistant", text: FENCE },
      { id: 5, role: "user", text: "outra" }, { id: 6, role: "assistant", text: "Outra:\n" + FENCE },
    ]);
    expect(turns.map((t) => !!t.skillDraft)).toEqual([false, true, false]);
  });
});

describe("after a reload (the history's placeholder row, A-175)", () => {
  const history = () => turnsFromHistory([
    { id: 1, role: "user", text: "faça o relatório" }, { id: 2, role: "assistant", text: "Feito, enviei o relatório." },
    { id: 3, role: "user", text: "", display_kind: "skill_draft" }, { id: 4, role: "assistant", text: FENCE },
  ]);
  it("the label comes from the row, the Bot's answer is the card, and the row is NEVER a person's bubble", () => {
    render(<Conversation bot={BOT} initialTurns={history()} />);
    expect(screen.getByText("Você pediu ao seu Bot um rascunho de skill")).toBeTruthy();
    expect(screen.getByTestId("skill-draft-card").textContent).toContain("Rascunho pronto, 6 linhas");
    expect(screen.getByText("faça o relatório")).toBeTruthy();
    const turns = document.querySelectorAll("[data-turn]");
    expect(turns).toHaveLength(2);
    expect(turns[1].querySelector(".lb-bubble-me, [data-side=\"me\"]")).toBeNull();
    expect(document.body.textContent).not.toContain("SECRET-STEP");
  });
  it("an answer that is not a draft comes back as ordinary text with the reason", () => {
    const turns = turnsFromHistory([{ id: 1, role: "user", text: "", display_kind: "skill_draft" }, { id: 2, role: "assistant", text: "Não deu." }]);
    render(<Conversation bot={BOT} initialTurns={turns} />);
    expect(screen.getByText("Não deu.")).toBeTruthy();
    expect(screen.getByTestId("skill-draft-refused")).toBeTruthy();
  });
});
