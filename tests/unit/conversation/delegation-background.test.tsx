// tests/unit/conversation/delegation-background.test.tsx
// t165, redone on the pinned Hermes's real path: a top-level delegate_task always runs in the BACKGROUND. The call answers at once
// {status:"dispatched", delegation_id} (async_delegation.py), so its tool.completed is not the helper being done: the card says
// "Rodando em segundo plano". For an API session the result comes later as a DELIVERY ROW of the session's history
// (gateway/wake.py persist_delegation_delivery: role "user", display_kind "async_delegation_complete", display_metadata.delegation_id):
// the screen reads the history again until it arrives, then "Concluído" with its text. That row is never the person's bubble.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { turnsFromHistory } from "@/components/chat/history";
import { DELIVERY_MS, DELIVERY_TRIES } from "@/components/conversation/delegate";
// Raw captures of the harness (Mochi, janela-20261003-0301/demo-captura): what LuveBot's history route returned after a real
// delegate_task, and the async_delegations row (delivery_state pending: the result never reached the session)
import RAW from "./fixtures/delegation-luvebot-messages.json";
import ROW from "./fixtures/delegation-async-row.json";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import type { HistoryMessage } from "@/api/types";

const enc = new TextEncoder();
const frame = (seq: number, data: Record<string, any>) => `id: ${seq}\ndata: ${JSON.stringify({ run_id: "run_r1", seq, ...data })}\n\n`;
const MESSAGES = (RAW as { messages: HistoryMessage[] }).messages;
const TOOL_ROW = MESSAGES.find((m) => m.tool_name === "delegate_task")!;
const G = "Ler pedidos.js e achar por que o total do pedido 4812 chega vazio.";
// the run stream carries the tool result cut at 500 characters (api_server_runs.py _tool_completed_preview): the real one is ~1 KB
const DISPATCHED = TOOL_ROW.text.length > 500 ? TOOL_ROW.text.slice(0, 497) + "..." : TOOL_ROW.text;
const ID = ROW.delegation_id;  // "deleg_27d82790"
/** The delivery row as gateway/wake.py writes it (role "user"), passed through by the backend (b4). */
const delivery = (over: Partial<HistoryMessage> = {}): HistoryMessage => ({ id: 9, role: "user", text: ROW.summary.replace("pedidos.js:88", "**pedidos.js:88**"),
  display_kind: "async_delegation_complete", display_metadata: { delegation_id: ID, task_count: 1, completed_count: 1, failed_count: 0 }, ...over });

function manual() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  return { stream, push: (s: string) => act(() => { ctl.enqueue(enc.encode(s)); }) };
}
/** `history`: what the session's messages route answers now (the test changes it when Hermes delivers). */
function backend(history: { rows: HistoryMessage[] }) {
  const reads: string[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "c", actor: "x", auth_mode: "gated" };
    if (method === "POST" && url.endsWith("/sessions")) return { session: { id: "s1" } };
    if (method === "POST" && url.endsWith("/runs")) return { run: { id: "run_r1", status: "started", session_id: "s1" } };
    if (url.includes("/runs/")) return { run: { id: "run_r1", status: "completed" } };
    if (url.includes("/sessions/s1/messages")) { reads.push(url); return { messages: history.rows }; }
    if (url.includes("/sessions?")) return { sessions: [] };
    return {};
  });
  return reads;
}
const chat = () => within(screen.getByLabelText(/^Conversa com/));
const card = (goal: string) => within(chat().getByText(goal).parentElement!);
async function send(history: { rows: HistoryMessage[] }) {
  const reads = backend(history);
  const s = manual();
  render(<Conversation bot={{ name: "vendas", label: "Vendas" }} fetcher={async () => new Response(s.stream, { status: 200, headers: { "content-type": "text/event-stream" } })} pollMs={10_000} />);
  fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "investigue com um subagente" } });
  fireEvent.click(screen.getByText("Enviar"));
  await waitFor(() => expect(screen.getByText("Parar")).toBeTruthy());
  return { s, reads };
}
const tick = (n = 1) => act(async () => { for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(DELIVERY_MS); });

beforeEach(() => {
  cleanup(); resetCsrfToken(); vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setCustomFetchJSON(null); });

describe("a helper running in the background", () => {
  it("dispatched: 'Rodando em segundo plano', never 'Concluído' nor the raw answer; the delivery row turns it into the result", async () => {
    const history = { rows: [] as HistoryMessage[] };
    const { s, reads } = await send(history);
    s.push(frame(1, { event: "tool.started", tool: "delegate_task", preview: G }));
    s.push(frame(2, { event: "tool.completed", tool: "delegate_task", duration: 0.1, error: false, preview: DISPATCHED }));
    s.push(frame(3, { event: "run.completed", output: "Mandei um subagente investigar." }));
    await waitFor(() => expect(card(G).getByText("Rodando em segundo plano")).toBeTruthy());
    expect(card(G).queryByText("Concluído")).toBeNull();
    expect(chat().queryByText(/dispatched/)).toBeNull();
    await tick(2);
    expect(reads.length).toBeGreaterThan(0);                                        // it asks the session's history
    expect(card(G).getByText("Rodando em segundo plano")).toBeTruthy();             // no row yet: still in the background
    history.rows = [delivery({ id: 8, text: "Outro resultado.", display_metadata: { delegation_id: "dg-outra", completed_count: 1, failed_count: 0 } })];
    await tick(2);
    expect(card(G).getByText("Rodando em segundo plano")).toBeTruthy();             // another delegation's row is not this one's result
    expect(chat().queryByText("Outro resultado.")).toBeNull();
    history.rows = [delivery()];
    await tick(2);
    await waitFor(() => expect(card(G).getByText("Concluído")).toBeTruthy());
    expect(chat().getByText("pedidos.js:88").tagName).toBe("STRONG");
    const n = reads.length;
    await tick(3);
    expect(reads.length).toBe(n);                                                   // delivered: it stops asking
  });

  it("Hermes's card (subagent.start, no complete) says background too, not 'Terminou sem dizer o resultado'; a failed unit says Falhou", async () => {
    const history = { rows: [] as HistoryMessage[] };
    const { s } = await send(history);
    s.push(frame(1, { event: "tool.started", tool: "delegate_task", preview: G }));
    s.push(frame(2, { event: "subagent.start", subagent_id: "sb1", delegation_id: ID, goal: G }));
    s.push(frame(3, { event: "tool.completed", tool: "delegate_task", duration: 0.1, error: false, preview: DISPATCHED }));
    s.push(frame(4, { event: "run.completed", output: "x" }));
    await waitFor(() => expect(card(G).getByText("Rodando em segundo plano")).toBeTruthy());
    expect(chat().queryByText("Terminou sem dizer o resultado")).toBeNull();
    expect(chat().getAllByText("Subagente")).toHaveLength(1);
    history.rows = [delivery({ text: "Não consegui abrir pedidos.js.", display_metadata: { delegation_id: ID, task_count: 1, completed_count: 0, failed_count: 1 } })];
    await tick(2);
    await waitFor(() => expect(card(G).getByText("Falhou")).toBeTruthy());
  });

  it("no result within the follow-up time: says so (in the background, not here yet), never 'Concluído' nor 'Terminou sem dizer'", async () => {
    const { s, reads } = await send({ rows: MESSAGES });   // the session as it really was: 8 rows, no delivery (Mochi's capture)
    s.push(frame(1, { event: "tool.started", tool: "delegate_task", preview: G }));
    s.push(frame(2, { event: "subagent.start", subagent_id: "sa-0-28583119", delegation_id: ID, goal: G }));
    s.push(frame(3, { event: "tool.completed", tool: "delegate_task", duration: 0.1, error: false, preview: DISPATCHED }));
    s.push(frame(4, { event: "run.completed", output: "Deleguei a investigação a um subagente do Hermes." }));
    await waitFor(() => expect(card(G).getByText("Rodando em segundo plano")).toBeTruthy());
    await tick(DELIVERY_TRIES + 1);
    await waitFor(() => expect(card(G).getByText("O subagente está em segundo plano; o resultado ainda não chegou a esta conversa")).toBeTruthy());
    expect(chat().queryByText("Terminou sem dizer o resultado")).toBeNull();
    expect(chat().queryByText("Concluído", { selector: "span" })).toBeNull();
    const n = reads.length;
    await tick(3);
    expect(reads.length).toBe(n);                                                   // and it stops asking
  });

  it("a delegation whose result came inside the call (synchronous) stays as it was: Concluído with its summary", async () => {
    const { s } = await send({ rows: [] });
    s.push(frame(1, { event: "tool.started", tool: "delegate_task", preview: G }));
    s.push(frame(2, { event: "tool.completed", tool: "delegate_task", duration: 2, error: false, preview: JSON.stringify({ results: [{ summary: "Feito." }] }) }));
    await waitFor(() => expect(card(G).getByText("Concluído")).toBeTruthy());
    expect(chat().getByText("Feito.")).toBeTruthy();
  });
});

describe("the delivery row in the history", () => {
  it("the real history (Mochi's capture): the dispatched delegate_task row is the helper's card in the background, not raw JSON", () => {
    const turns = turnsFromHistory(MESSAGES);
    expect(turns.map((t) => t.user)).toEqual(["Dev, reproduza o bug do cliente X no terminal.", "Dev, investigue com um subagente e me conte a causa."]);
    backend({ rows: [] });
    render(<Conversation bot={{ name: "dev", label: "Dev" }} initialTurns={turns} />);
    expect(card(G).getByText("Rodando em segundo plano")).toBeTruthy();
    expect(chat().queryByText(/"status": "dispatched"/)).toBeNull();
    expect(chat().queryByText(/exit_code/)).toBeNull();                             // other tool rows stay out, as before
  });

  it("is the helper's completed card, never the person's bubble nor a new turn", () => {
    const turns = turnsFromHistory([
      { id: 1, role: "user", text: "investigue com um subagente" },
      { id: 2, role: "assistant", text: "Mandei um subagente investigar." },
      delivery({ id: 3 }),
    ]);
    expect(turns.map((t) => t.user)).toEqual(["investigue com um subagente"]);
    const sub = turns[0].state.items.find((i) => i.kind === "subagent") as any;
    expect(sub).toMatchObject({ status: "completed", subagentId: ID, summary: expect.stringContaining("pedidos.js:88") });
    const failed = turnsFromHistory([{ id: 1, role: "user", text: "x" }, delivery({ id: 2, display_metadata: { delegation_id: "d2", completed_count: 0, failed_count: 1 } })]);
    expect((failed[0].state.items.find((i) => i.kind === "subagent") as any).status).toBe("failed");
  });
});

// The real delivery row of the harness's default profile (Mochi/Prumo, janela-20261003-0323/exp-delegacao): a text written for
// the MODEL. The card shows the child's summary only, not the header, the instructions or the log path.
import DELIVERED from "./fixtures/delegation-delivery-default.json";
import { deliveryView } from "@/components/conversation/delegate";

describe("the real delivery text (written for the model)", () => {
  const CHILD = "Causa: pedidos.js:88 lê pedido.total antes de somar os itens, então o total sai vazio. Correção: somar os itens antes.";
  it("gives the delegation id from its header (metadata may be empty) and the child's summary only", () => {
    const v = deliveryView(DELIVERED.content, DELIVERED.display_metadata ?? undefined);
    expect(v).toEqual({ id: "deleg_677dbd1b", status: "completed", summary: CHILD });
    const failed = deliveryView("[ASYNC DELEGATION BATCH COMPLETE — deleg_x1]\nintro\n\n--- ✗ TASK 1/1: Ler pedidos.js  (status=failed, api_calls=1, 0.1s) ---\nNão consegui abrir o arquivo.\nFull live transcript: /x.log");
    expect(failed).toEqual({ id: "deleg_x1", status: "failed", summary: "Não consegui abrir o arquivo." });
    expect(deliveryView("um texto sem o formato").summary).toBe("um texto sem o formato");
  });

  it("live: the real row closes the card with the child's summary, never the model's header", async () => {
    const history = { rows: [] as HistoryMessage[] };
    const { s } = await send(history);
    const dispatched = DISPATCHED.replace(ID, "deleg_677dbd1b");
    s.push(frame(1, { event: "tool.started", tool: "delegate_task", preview: G }));
    s.push(frame(2, { event: "tool.completed", tool: "delegate_task", duration: 0.1, error: false, preview: dispatched }));
    s.push(frame(3, { event: "run.completed", output: "Deleguei." }));
    await waitFor(() => expect(card(G).getByText("Rodando em segundo plano")).toBeTruthy());
    history.rows = [{ id: 5, role: "user", text: DELIVERED.content, display_kind: "async_delegation_complete" }];  // b4, metadata empty
    await tick(2);
    await waitFor(() => expect(card(G).getByText("Concluído")).toBeTruthy());
    expect(chat().getByText(CHILD)).toBeTruthy();
    expect(chat().queryByText(/ASYNC DELEGATION/)).toBeNull();
    expect(chat().queryByText(/Full live transcript/)).toBeNull();
  });
});
