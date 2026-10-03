// tests/unit/conversation/conversation.test.tsx
// Conversation with an injected fetcher replaying the REAL Hermes streams (tests/harness/evidence/t08).
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";

const ROOT = path.resolve(__dirname, "../../");
const evidence = (n: string) => readFileSync(path.join(ROOT, "harness/evidence/t08", n));
const BOT = { name: "vendas", label: "Vendas", color: "#60a5fa" };
const enc = new TextEncoder();

/** Cuts the bytes at awkward places (mid-line, mid-character) like a real network would. */
function chunked(bytes: Uint8Array, n = 23): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += n) c.enqueue(bytes.slice(i, i + n)); c.close(); } });
}

type Calls = { json: Array<{ method: string; url: string; csrf: string | null; body?: any }>; streams: Array<{ url: string; method?: string; csrf: string | null }> };

type RunStatusReturn = string | { status: string; status_raw?: string; output?: string };

function setup(opts: { runStatus?: () => RunStatusReturn; failRun?: boolean } = {}) {
  const calls: Calls = { json: [], streams: [] };
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const h = new Headers(init?.headers);
    calls.json.push({ method, url, csrf: h.get("X-LuveBot-CSRF"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
    if (url.endsWith("/sessions")) return { session: { id: "api_s1" } };
    if (method === "POST" && url.endsWith("/runs")) {
      if (opts.failRun) throw new ApiError({ code: "bot_paused", message: "Este Bot está pausado.", status: 409 });
      return { run: { id: "run_r1", status: "started", session_id: "api_s1" } };
    }
    if (url.endsWith("/stop")) return { run: { id: "run_r1", status: "stopping" } };
    if (method === "GET" && url.includes("/runs/")) {
      const res = opts.runStatus?.() ?? "started";
      if (typeof res === "string") return { run: { id: "run_r1", status: res } };
      return { run: { id: "run_r1", status: res.status, status_raw: res.status_raw, output: res.output } };
    }
    throw new Error("unexpected " + method + " " + url);
  });
  return calls;
}

const fetcherFor = (calls: Calls, body: () => ReadableStream<Uint8Array>) => async (url: string, init?: RequestInit) => {
  calls.streams.push({ url, method: init?.method, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
  return new Response(body(), { status: 200, headers: { "content-type": "text/event-stream" } });
};

async function sendMessage(text = "oi") {
  fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: text } });
  fireEvent.click(screen.getByText("Enviar"));
}

/** The answer text outside any collapsed "Pensamento" (reasoning repeats it in the recorded frames). */
/** The transcript column only (the work panel repeats tool names and previews). */
const chat = () => within(screen.getByLabelText(/^Conversa com/));
const answerShown = (t: string) => chat().queryAllByText(t).some((el) => !el.closest("details"));

/** A stream the test keeps open and feeds by hand. */
function manualStream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  return { stream, push: (s: string) => ctl.enqueue(enc.encode(s)), close: () => ctl.close() };
}
const sseRun = (seq: number, data: Record<string, any>) => `id: ${seq}\ndata: ${JSON.stringify({ ...data, run_id: "run_r1", seq })}\n\n`;
const sseOurs = (seq: number, event: string, data: Record<string, any>) => `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

beforeEach(() => { cleanup(); resetCsrfToken(); setCustomFetchJSON(null); });

describe("Conversation: real streams to the final screen", () => {
  it("run surface: creates session and run with CSRF, streams, ends with the tool card and the answer", async () => {
    const calls = setup();
    render(<Conversation bot={BOT} fetcher={fetcherFor(calls, () => chunked(evidence("run-stream.sse")))} />);
    await sendMessage("faça o teste");
    await screen.findByText("Concluído");
    expect(screen.getByText("faça o teste")).toBeTruthy();
    // the chat shows ONE compact line of the turn's steps; the full card opens in place, and lives in the work panel
    const line = chat().getByRole("button", { expanded: false, name: /1 passo/ });
    expect(line.textContent).toContain("terminal");
    expect(chat().queryByText("printf luvebot-real-tool-frame")).toBeNull();
    fireEvent.click(line);
    expect(chat().getByText("printf luvebot-real-tool-frame")).toBeTruthy();
    expect(chat().getByText(/0\.1s/)).toBeTruthy();
    expect(answerShown("Harness model response")).toBe(true);
    expect(screen.getAllByText("Pensamento")).toHaveLength(2); // collapsed, never the answer
    expect(screen.queryByText("Parar")).toBeNull();
    expect(screen.getByText("Enviar")).toBeTruthy();
    const post = calls.json.filter((c) => c.method === "POST");
    expect(post.map((c) => c.url.replace("/api/plugins/luvebot", ""))).toEqual(["/bots/vendas/sessions", "/bots/vendas/runs"]);
    expect(post.every((c) => c.csrf === "csrf-1")).toBe(true);
    expect(post[1].body).toMatchObject({ input: "faça o teste", session_id: "api_s1" });
    expect(calls.streams[0].url).toBe("/api/plugins/luvebot/bots/vendas/runs/run_r1/events");
  });

  it("chat surface: POSTs chat/stream with CSRF in the header and reaches the final screen", async () => {
    const calls = setup();
    render(<Conversation bot={BOT} surface="chat" fetcher={fetcherFor(calls, () => chunked(evidence("chat-stream.sse"), 11))} />);
    await sendMessage();
    await screen.findByText("Concluído");
    expect(calls.streams[0]).toEqual({ url: "/api/plugins/luvebot/bots/vendas/sessions/api_s1/chat/stream", method: "POST", csrf: "csrf-1" });
    expect(chat().getByRole("button", { name: /1 passo/ }).textContent).toContain("terminal");
    expect(answerShown("Harness model response")).toBe(true);
    expect(calls.json.some((c) => c.url.endsWith("/runs"))).toBe(false);
  });

  it("run stopped at an approval the backend did not store (no luvebot_digest): nothing is resolvable, ends as Interrompido", async () => {
    const calls = setup();
    render(<Conversation bot={BOT} fetcher={fetcherFor(calls, () => chunked(evidence("run-approval-stream.sse")))} />);
    await sendMessage();
    await screen.findByText("Interrompido");
    expect(chat().getByText("Pedido de aprovação")).toBeTruthy();
    // the approval card stays whole in the chat (it needs a person); the tool's own preview is only in the compact line's detail
    expect(chat().getAllByText("rm -rf /tmp/luvebot-approval-canary").length).toBeGreaterThanOrEqual(1);
    expect(chat().queryByText("Permitir uma vez")).toBeNull();
    expect(calls.json.some((c) => /approval/.test(c.url))).toBe(false);
    expect(calls.streams).toHaveLength(1);
    expect(screen.getByText(/não pode ser decidido por aqui/)).toBeTruthy();
  });

  it("an approval the backend stored is decided inline by a click: POST run approval with digest and CSRF", async () => {
    const calls = setup();
    const m = manualStream();
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.json.push({ method, url, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
      if (url.endsWith("/sessions")) return { session: { id: "api_s1" } };
      if (method === "POST" && url.endsWith("/runs")) return { run: { id: "run_r1", status: "started", session_id: "api_s1" } };
      if (url.endsWith("/approval")) return { approval: { status: "decided" } };
      return { run: { id: "run_r1", status: "started" } };
    });
    render(<Conversation bot={BOT} pollMs={10} fetcher={fetcherFor(calls, () => m.stream)} />);
    await sendMessage();
    m.push(sseRun(0, { event: "approval.request", request_id: "req_9", command: "git push", description: "push", choices: ["once", "session", "always", "deny"], luvebot_digest: "dg-9" }));
    await screen.findByText("Aguardando aprovação");
    expect(calls.json.some((c) => c.url.endsWith("/approval"))).toBe(false); // nothing before the click
    fireEvent.click(chat().getByText("Permitir uma vez"));
    await screen.findByText("Permitida uma vez.");
    // Right after the decision the turn says it is resuming, not still waiting, and the header no longer asks for you
    expect(screen.getByText("Retomando…")).toBeTruthy();
    expect(screen.queryByText("Aguardando aprovação")).toBeNull();
    expect(screen.queryByText("Precisa de você")).toBeNull();
    expect(calls.json.filter((c) => c.url.endsWith("/approval"))).toEqual([{
      method: "POST", url: "/api/plugins/luvebot/bots/vendas/runs/run_r1/approval", csrf: "csrf-1",
      body: { request_id: "req_9", digest: "dg-9", choice: "once" },
    }]);
    m.push(sseRun(1, { event: "run.completed", output: "feito" }));
    m.close();
    await screen.findByText("Concluído");
  });

  it("hostile agent text stays text", async () => {
    const calls = setup();
    const bytes = enc.encode(sseRun(0, { event: "message.delta", delta: '<img src=x onerror="window.__pwn=1"> [x](javascript:alert(1))' }) + sseRun(1, { event: "run.completed", output: "" }));
    const { container } = render(<Conversation bot={BOT} fetcher={fetcherFor(calls, () => chunked(bytes))} />);
    await sendMessage();
    await screen.findByText("Concluído");
    expect(container.querySelector("img, a")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=");
    expect((window as any).__pwn).toBeUndefined();
  });

  it("a refused run (409 bot_paused) shows our message and frees the input", async () => {
    const calls = setup({ failRun: true });
    render(<Conversation bot={BOT} fetcher={fetcherFor(calls, () => chunked(new Uint8Array()))} />);
    await sendMessage();
    await screen.findByText("Este Bot está pausado. Retome o Bot e tente de novo.");  // our words for bot_paused, not the backend's
    expect(screen.getByText("Enviar")).toBeTruthy();
    expect(screen.queryByText("Parar")).toBeNull();
    expect(calls.streams).toHaveLength(0);
  });
});

describe("Conversation: Parar", () => {
  it("is visible while running, calls POST stop, shows Parando… and stays until Hermes confirms", async () => {
    let status = "started";
    const calls = setup({ runStatus: () => status });
    const m = manualStream();
    render(<Conversation bot={BOT} pollMs={10} fetcher={fetcherFor(calls, () => m.stream)} />);
    await sendMessage();
    m.push(sseRun(0, { event: "message.delta", delta: "pensando" }));
    await screen.findByText("pensando");
    fireEvent.click(screen.getByText("Parar"));
    await screen.findByText("Parando…");
    expect(calls.json.find((c) => c.url.endsWith("/runs/run_r1/stop"))).toMatchObject({ method: "POST", csrf: "csrf-1" });
    expect(screen.getByText("Parar")).toBeTruthy();
    m.push(sseRun(1, { event: "run.cancelled", interrupted: true }));
    m.close();
    await screen.findByText("Interrompido");
    expect(screen.queryByText("Parar")).toBeNull();
  });

  it("stays visible after luvebot.error", async () => {
    const calls = setup();
    const m = manualStream();
    render(<Conversation bot={BOT} pollMs={10} fetcher={fetcherFor(calls, () => m.stream)} />);
    await sendMessage();
    m.push(sseRun(0, { event: "message.delta", delta: "a" }));
    m.push(sseOurs(1, "luvebot.error", { code: "hermes_timeout", message: "Tempo esgotado." }));
    await screen.findByText("O Hermes demorou demais para responder. Tente de novo em instantes.");  // by code, not the frame's text
    expect(screen.getByText("Parar")).toBeTruthy();
  });

  it("stays visible after the stream closes without a terminal frame, until GET run confirms", async () => {
    let status = "started";
    const calls = setup({ runStatus: () => status });
    const m = manualStream();
    render(<Conversation bot={BOT} pollMs={10} fetcher={fetcherFor(calls, () => m.stream)} />);
    await sendMessage();
    m.push(sseRun(0, { event: "message.delta", delta: "a" }));
    m.push(sseOurs(1, "luvebot.error", { code: "hermes_timeout", message: "Tempo esgotado." }));
    m.push(sseOurs(2, "luvebot.stream.close", { reason: "upstream_closed" }));
    m.close();
    await screen.findByText("O Hermes demorou demais para responder. Tente de novo em instantes.");  // by code, not the frame's text
    await new Promise((r) => setTimeout(r, 60)); // several polls answered "started"
    expect(screen.getByText("Parar")).toBeTruthy();
    expect(calls.json.filter((c) => c.method === "GET" && c.url.endsWith("/runs/run_r1")).length).toBeGreaterThan(1);
    status = "cancelled";
    await screen.findByText("Interrompido");
    expect(screen.queryByText("Parar")).toBeNull();
  });

  it("chat: a fetcher that rejects at once ends the turn as failed and frees the input", async () => {
    const calls = setup();
    render(<Conversation bot={BOT} surface="chat" fetcher={async () => { throw new Error("rede caiu"); }} />);
    await sendMessage();
    await screen.findByText("Falhou");
    expect(screen.getByText("Falha na comunicação com o LuveBot.")).toBeTruthy();
    expect(screen.queryByText("Parar")).toBeNull();
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "de novo" } });
    expect((screen.getByText("Enviar") as HTMLButtonElement).disabled).toBe(false);
    expect(calls.json.some((c) => c.method === "GET" && c.url.includes("/runs/"))).toBe(false);
  });

  it("run: when the stream rejects AFTER the run exists, it keeps asking GET run and keeps Parar", async () => {
    let status = "started";
    const calls = setup({ runStatus: () => status });
    render(<Conversation bot={BOT} pollMs={10} fetcher={async () => { throw new Error("rede caiu"); }} />);
    await sendMessage();
    await screen.findByText("Falha na comunicação com o LuveBot.");
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByText("Parar")).toBeTruthy();
    expect(calls.json.filter((c) => c.method === "GET" && c.url.endsWith("/runs/run_r1")).length).toBeGreaterThan(1);
    status = "completed";
    await screen.findByText("Concluído");
    expect(screen.queryByText("Parar")).toBeNull();
  });

  it("GET run returning unknown + status_raw 'interrupted' ends turn as Interrompido and hides Parar", async () => {
    let status: RunStatusReturn = "started";
    const calls = setup({ runStatus: () => status });
    const m = manualStream();
    render(<Conversation bot={BOT} pollMs={10} fetcher={fetcherFor(calls, () => m.stream)} />);
    await sendMessage();
    m.push(sseRun(0, { event: "message.delta", delta: "executando" }));
    m.close();
    await screen.findByText("executando");
    expect(screen.getByText("Parar")).toBeTruthy();

    status = { status: "unknown", status_raw: "interrupted" };
    await screen.findByText("Interrompido");
    expect(screen.queryByText("Parar")).toBeNull();
    expect(screen.getByText("Enviar")).toBeTruthy();
  });

  it("GET run returning unknown without status_raw keeps Parar visible (non-terminal)", async () => {
    let status: RunStatusReturn = { status: "unknown" };
    const calls = setup({ runStatus: () => status });
    const m = manualStream();
    render(<Conversation bot={BOT} pollMs={10} fetcher={fetcherFor(calls, () => m.stream)} />);
    await sendMessage();
    m.push(sseRun(0, { event: "message.delta", delta: "processando" }));
    m.close();
    await screen.findByText("processando");

    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByText("Parar")).toBeTruthy();
    expect(screen.queryByText("Interrompido")).toBeNull();
    expect(calls.json.filter((c) => c.method === "GET" && c.url.endsWith("/runs/run_r1")).length).toBeGreaterThan(1);

    status = { status: "unknown", status_raw: "interrupted" };
    await screen.findByText("Interrompido");
    expect(screen.queryByText("Parar")).toBeNull();
  });
});

describe("Conversation: the answer is never lost", () => {
  it("the stream ends before run.completed: GET run confirms and its output is shown as the Bot's message", async () => {
    let status: RunStatusReturn = "started";
    const calls = setup({ runStatus: () => status });
    const m = manualStream();
    render(<Conversation bot={BOT} pollMs={10} fetcher={fetcherFor(calls, () => m.stream)} />);
    await sendMessage("Luve");
    m.push(sseOurs(0, "luvebot.stream.close", { reason: "upstream_closed" }));
    m.close();
    status = { status: "completed", output: "Oi! Sou o Bot de marketing." };
    await screen.findByText("Concluído");
    await waitFor(() => expect(answerShown("Oi! Sou o Bot de marketing.")).toBe(true));
  });

  it("the run stream carries the answer only in run.completed after a whitespace delta", async () => {
    const calls = setup();
    const bytes = enc.encode(sseRun(0, { event: "message.delta", delta: "\n" }) + sseRun(1, { event: "run.completed", output: "Oi! Sou o Bot de marketing." }));
    render(<Conversation bot={BOT} fetcher={fetcherFor(calls, () => chunked(bytes))} />);
    await sendMessage("Luve");
    await screen.findByText("Concluído");
    expect(answerShown("Oi! Sou o Bot de marketing.")).toBe(true);
  });
});
