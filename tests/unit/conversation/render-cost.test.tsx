// tests/unit/conversation/render-cost.test.tsx
// A token of the Bot's answer used to redraw the WHOLE conversation: every finished turn parsed
// its Markdown again and the activity of every turn was derived again, so a long conversation got slower with each word. Only the turn that
// is streaming may redraw. Counted on the real components: how many times the Markdown of an OLD turn is parsed while a new answer streams,
// (the activity and the files of a finished turn are cached by their items array too, so they are not derived again.)
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";

const counts = vi.hoisted(() => ({ markdown: new Map<string, number>() }));
vi.mock("@/lib/render/markdown", async (orig) => {
  const real = await orig<typeof import("@/lib/render/markdown")>();
  return { ...real, Markdown: (p: { text: string }) => { counts.markdown.set(p.text, (counts.markdown.get(p.text) ?? 0) + 1); return real.Markdown(p); } };
});

import { Conversation } from "@/components/conversation";
import { turnsFromHistory } from "@/components/chat/history";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";

const BOT = { name: "vendas", label: "Vendas" };
const TURNS = 30;
const past = () => turnsFromHistory(Array.from({ length: TURNS }, (_, i) => [
  { id: `u${i}`, role: "user", text: `pergunta número ${i}` },
  { id: `a${i}`, role: "assistant", text: `resposta **número ${i}** com [um link](https://exemplo.invalid/${i}) e bastante texto para parsear` },
]).flat() as any);

function manualStream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  const enc = new TextEncoder();
  return { stream, push: (s: string) => ctl.enqueue(enc.encode(s)), close: () => ctl.close() };
}
const frame = (seq: number, data: object) => `id: ${seq}\ndata: ${JSON.stringify({ ...data, run_id: "run_r1", seq })}\n\n`;

beforeEach(() => {
  cleanup(); resetCsrfToken(); counts.markdown.clear();
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "c", actor: "dashboard", auth_mode: "gated" };
    if (method === "POST" && url.endsWith("/sessions")) return { session: { id: "s1" } };
    if (method === "POST" && url.endsWith("/runs")) return { run: { id: "run_r1", status: "started", session_id: "s1" } };
    return { run: { id: "run_r1", status: "started" } };
  });
});
afterEach(() => setCustomFetchJSON(null));

describe("a streaming answer redraws only its own turn", () => {
  it(`with ${TURNS} finished turns on screen, 40 tokens parse the old turns' Markdown 0 times`, async () => {
    const m = manualStream();
    render(<Conversation bot={BOT} initialTurns={past()} fetcher={async () => new Response(m.stream, { status: 200, headers: { "content-type": "text/event-stream" } })} />);
    await screen.findByText("pergunta número 29");
    const olds = [...counts.markdown.keys()].filter((k) => k.startsWith("resposta"));
    expect(olds).toHaveLength(TURNS);                                                          // each old answer was drawn once on open
    counts.markdown.clear();
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "e agora?" } });
    fireEvent.click(screen.getByText("Enviar"));
    await waitFor(() => expect(counts.markdown.size).toBeGreaterThanOrEqual(0));
    counts.markdown.clear();                                                // from here on: tokens only
    await act(async () => { m.push(frame(0, { event: "message.started" })); });
    for (let i = 0; i < 40; i++) await act(async () => { m.push(frame(i + 1, { event: "message.delta", delta: `palavra${i} ` })); await new Promise((r) => setTimeout(r, 20)); });
    await screen.findByText(/palavra39/);
    const redrawnOld = olds.reduce((n, k) => n + (counts.markdown.get(k) ?? 0), 0);
    expect(redrawnOld).toBe(0);                                                                // the finished turns were not parsed again
    await act(async () => { m.push(frame(50, { event: "run.completed", output: "fim" })); m.close(); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Parar" })).toBeNull());     // the new turn ended too
  }, 60_000);
});

describe("the tokens of one animation frame are drawn together", () => {
  it("40 deltas pushed back to back are far fewer redraws of the live answer, the text is complete and a tool between them keeps the order", async () => {
    const m = manualStream();
    render(<Conversation bot={BOT} fetcher={async () => new Response(m.stream, { status: 200, headers: { "content-type": "text/event-stream" } })} />);
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText("Enviar"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Parar" })).toBeTruthy());
    counts.markdown.clear();
    await act(async () => { m.push(frame(0, { event: "message.started" })); });
    for (let i = 0; i < 20; i++) await act(async () => { m.push(frame(i + 1, { event: "message.delta", delta: `A${i} ` })); });
    await act(async () => { m.push(frame(30, { event: "tool.started", tool_name: "terminal", preview: "ls" })); });
    for (let i = 0; i < 20; i++) await act(async () => { m.push(frame(31 + i, { event: "message.delta", delta: `B${i} ` })); });
    await screen.findByText(/B19/);
    const liveRenders = [...counts.markdown.entries()].filter(([k]) => /^(A|B)\d/.test(k)).reduce((n, [, c]) => n + c, 0);
    expect(liveRenders).toBeLessThan(25);                                                      // not one per token (it was 40 or more)
    const text = document.querySelector("[data-turn]")!.textContent!;
    expect(text.indexOf("A0 ")).toBeGreaterThan(-1);
    expect(text.indexOf("A19")).toBeLessThan(text.indexOf("B0 "));                              // the order of the stream is the order on screen
    expect(/A0 .*A19.*B0 .*B19/s.test(text.replace(/\s+/g, " "))).toBe(true);
    await act(async () => { m.push(frame(80, { event: "run.completed", output: "fim" })); m.close(); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Parar" })).toBeNull());
  }, 30_000);
});
