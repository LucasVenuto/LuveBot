// tests/unit/conversation/subagent.test.tsx
// A helper the Bot delegates to (Hermes subagent.start / subagent.complete on the run surface) shows up in the conversation as
// the SubagentCard: its goal while it runs, then the state and summary Hermes reported. Nothing is filled in: the summary goes
// through <Markdown>, and a helper that never reported back says so instead of pretending it finished.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { delegateSummary } from "@/components/conversation/delegate";

const enc = new TextEncoder();
const frame = (seq: number, data: Record<string, any>) => `id: ${seq}\ndata: ${JSON.stringify({ run_id: "run_r1", seq, ...data })}\n\n`;

function manual() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  return { stream, push: (s: string) => act(() => { ctl.enqueue(enc.encode(s)); }) };
}
function backend() {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
    if (method === "POST" && url.endsWith("/sessions")) return { session: { id: "s1" } };
    if (method === "POST" && url.endsWith("/runs")) return { run: { id: "run_r1", status: "started", session_id: "s1" } };
    if (method === "GET" && url.includes("/runs/")) return { run: { id: "run_r1", status: "started" } };
    return {};
  });
}
const chat = () => within(screen.getByLabelText(/^Conversa com/));
const card = (goal: string) => within(chat().getByText(goal).parentElement!);  // the SubagentCard holding that goal
async function send() {
  const s = manual();
  render(<Conversation bot={{ name: "vendas", label: "Vendas" }} fetcher={async () => new Response(s.stream, { status: 200, headers: { "content-type": "text/event-stream" } })} pollMs={10_000} />);
  fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "pesquise os concorrentes" } });
  fireEvent.click(screen.getByText("Enviar"));
  await waitFor(() => expect(screen.getByText("Parar")).toBeTruthy());
  return s;
}

beforeEach(() => {
  cleanup(); resetCsrfToken(); backend();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { vi.unstubAllGlobals(); setCustomFetchJSON(null); });

describe("subagent card in the conversation", () => {
  it("a delegated helper appears with its goal while it runs, then with the state and summary Hermes reported", async () => {
    const s = await send();
    s.push(frame(1, { event: "subagent.start", subagent_id: "sub-1", goal: "Levantar preços da Alder", child_session_id: "sess-child" }));
    await waitFor(() => expect(chat().getByText("Subagente")).toBeTruthy());
    expect(chat().getByText("Levantar preços da Alder")).toBeTruthy();
    expect(card("Levantar preços da Alder").getByText("Trabalhando…")).toBeTruthy();

    s.push(frame(2, { event: "subagent.complete", subagent_id: "sub-1", status: "completed", summary: "Achei **três** tabelas.", cost_usd: 0.0125 }));
    await waitFor(() => expect(card("Levantar preços da Alder").getByText("Concluído")).toBeTruthy());
    const strong = chat().getByText("três");
    expect(strong.tagName).toBe("STRONG");  // through <Markdown>, not raw text
    expect(chat().getByText(/US\$ 0\.0125/)).toBeTruthy();
    expect(card("Levantar preços da Alder").queryByText("Trabalhando…")).toBeNull();
    expect(chat().getAllByText("Subagente")).toHaveLength(1);  // complete updates the same card
    expect(chat().queryByRole("button", { name: /ver sessão/i })).toBeNull();  // no way to open it here yet: no dead button
  });

  it("failed and timed-out helpers say so in words", async () => {
    const s = await send();
    s.push(frame(1, { event: "subagent.start", subagent_id: "a", goal: "Tarefa A" }));
    s.push(frame(2, { event: "subagent.start", subagent_id: "b", goal: "Tarefa B" }));
    s.push(frame(3, { event: "subagent.complete", subagent_id: "a", status: "failed" }));
    s.push(frame(4, { event: "subagent.complete", subagent_id: "b", status: "timeout" }));
    await waitFor(() => expect(card("Tarefa B").getByText("Passou do tempo")).toBeTruthy());
    expect(card("Tarefa A").getByText("Falhou")).toBeTruthy();
    expect(chat().queryByText("timeout")).toBeNull();
  });

  it("a helper still running when the turn ends is not shown as finished", async () => {
    const s = await send();
    s.push(frame(1, { event: "subagent.start", subagent_id: "x", goal: "Tarefa longa" }));
    await waitFor(() => expect(chat().getByText("Tarefa longa")).toBeTruthy());
    s.push(frame(2, { event: "run.completed", output: "Pronto." }));
    await waitFor(() => expect(card("Tarefa longa").getByText("Terminou sem dizer o resultado")).toBeTruthy());
    expect(chat().queryByText("unknown")).toBeNull();
  });
});

// t163: when the run stream brings no subagent.* frames, the Bot's own delegate_task call is the helper's card: the goal from the
// call, the state from started/completed/failed, the summary from the result Hermes sent. Hermes's subagent.* frames win.
describe("delegate_task as the helper's card", () => {
  const RESULT = JSON.stringify({ results: [{ task_index: 0, status: "completed", summary: "Causa: **pedidos.js:88** lê o total antes de somar." }] });
  it("started shows the goal working; completed shows the summary through Markdown, and it is not counted as a step", async () => {
    const s = await send();
    s.push(frame(0, { event: "tool.started", tool: "terminal", preview: "echo reproduzir" }));
    s.push(frame(0.5, { event: "tool.completed", tool: "terminal", duration: 0.1, error: false, preview: "ok" }));
    s.push(frame(1, { event: "tool.started", tool: "delegate_task", preview: "Ler pedidos.js e achar a causa" }));
    await waitFor(() => expect(card("Ler pedidos.js e achar a causa").getByText("Trabalhando…")).toBeTruthy());
    s.push(frame(2, { event: "tool.completed", tool: "delegate_task", duration: 4.2, error: false, preview: RESULT }));
    await waitFor(() => expect(card("Ler pedidos.js e achar a causa").getByText("Concluído")).toBeTruthy());
    expect(chat().getByText("pedidos.js:88").tagName).toBe("STRONG");
    expect(chat().queryByText(/US\$/)).toBeNull();                                  // no cost unless Hermes sends one
    expect(chat().queryByText(/delegate_task/)).toBeNull();                         // not a step line
    expect(chat().getByText(/1 passo/)).toBeTruthy();                                 // the steps line counts only the terminal
    expect(chat().queryByText(/"results"/)).toBeNull();                             // never the raw JSON
  });

  it("failed says so; a result Hermes cut at 500 characters still gives its summary", async () => {
    const s = await send();
    s.push(frame(1, { event: "tool.started", tool: "delegate_task", preview: "Tarefa A" }));
    s.push(frame(2, { event: "tool.completed", tool: "delegate_task", duration: 1, error: true, preview: "Subagent timed out" }));
    await waitFor(() => expect(card("Tarefa A").getByText("Falhou")).toBeTruthy());
    expect(delegateSummary('{"results": [{"task_index": 0, "summary": "Achei a causa em pedidos.js e mais um tre...')).toBe("Achei a causa em pedidos.js e mais um tre…");
    expect(delegateSummary('{"summary": "uma \\"citação\\" e\\nlinha"}')).toBe('uma "citação" e\nlinha');
    expect(delegateSummary("texto simples")).toBe("texto simples");
    expect(delegateSummary("  ")).toBeUndefined();
  });

  it("when Hermes sends subagent.* too, there is ONE card (Hermes's), and delegate_task stays a step", async () => {
    const s = await send();
    s.push(frame(1, { event: "tool.started", tool: "delegate_task", preview: "Tarefa B" }));
    s.push(frame(2, { event: "subagent.start", subagent_id: "sb1", goal: "Tarefa B" }));
    s.push(frame(3, { event: "subagent.complete", subagent_id: "sb1", status: "completed", summary: "Feito." }));
    s.push(frame(4, { event: "tool.completed", tool: "delegate_task", duration: 2, error: false, preview: RESULT }));
    await waitFor(() => expect(chat().getByText("Feito.")).toBeTruthy());
    expect(chat().getAllByText("Subagente")).toHaveLength(1);
    expect(chat().getByText(/delegate_task/)).toBeTruthy();
  });
});
