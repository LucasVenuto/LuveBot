// tests/unit/conversation/first-message.test.tsx
// perf-tela.md item 4 (the part with contract v0.9 §10): the first message of a conversation used to pay GET /session (CSRF), POST /sessions,
// the send and, in run mode, the events: four round trips before the first byte. Now the CSRF token is asked when the app opens (beside the
// lists), and the send makes the session itself: POST /runs without session_id answers run.session_id (or session_id when queued), and the chat
// without a session streams from /bots/{bot}/chat/stream and says the id in its first frame. Later messages carry the id as before.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { LuveBotApp } from "@/index";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";

const BOT = { name: "vendas", label: "Vendas" };
type Seen = { posts: Array<{ url: string; body: any }>; urls: string[]; streams: string[] };
let seen: Seen;
function backend(over: { run?: (n: number) => unknown } = {}) {
  seen = { posts: [], urls: [], streams: [] };
  let runs = 0;
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    seen.urls.push(`${method} ${url.replace("/api/plugins/luvebot", "")}`);
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
    if (method === "POST") seen.posts.push({ url: url.replace("/api/plugins/luvebot", ""), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === "POST" && url.endsWith("/runs")) return over.run ? over.run(++runs) : { run: { id: `run_${++runs}`, status: "started", session_id: "s-made" } };
    if (method === "GET" && /\/runs\/run_\d+$/.test(url)) return { run: { id: url.split("/").pop(), status: "completed", output: "ok" } };
    if (/\/bots$/.test(url)) return { bots: [{ name: "vendas", status: "idle", display: { label: "Vendas" } }] };
    return {};
  });
}
const idle = async (url: string) => { seen.streams.push(url.replace("/api/plugins/luvebot", "")); return new Response(new ReadableStream(), { status: 200, headers: { "content-type": "text/event-stream" } }); };
// a stream that ends at once with no terminal frame: the turn then follows GET run, which says completed
const closing = async (url: string) => { seen.streams.push(url.replace("/api/plugins/luvebot", "")); return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } }); };
const sseChat = (...frames: Array<[string, object]>) => async (url: string, init?: RequestInit) => {
  seen.streams.push(`${init?.method ?? "GET"} ${url.replace("/api/plugins/luvebot", "")}`);
  return new Response(new ReadableStream({ start(c) { frames.forEach(([ev, d]) => c.enqueue(new TextEncoder().encode(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`))); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const send = async (text: string) => { fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: text } }); fireEvent.click(screen.getByText("Enviar")); };

beforeEach(() => { cleanup(); resetCsrfToken(); });
afterEach(() => setCustomFetchJSON(null));

describe("the first message makes its session in the same call", () => {
  it("run: ONE POST /runs with no session_id and no POST /sessions; the id from run.session_id is what the next message carries", async () => {
    backend();
    render(<Conversation bot={BOT} fetcher={closing} pollMs={5} />);
    await waitFor(() => expect(screen.queryByTestId("conversation-loading")).toBeNull());
    await send("primeira");
    await waitFor(() => expect(seen.posts.filter((p) => p.url.endsWith("/runs"))).toHaveLength(1));
    expect(seen.posts.map((p) => p.url)).toEqual(["/bots/vendas/runs"]);                          // no round trip to make a session
    expect("session_id" in seen.posts[0].body).toBe(false);
    await waitFor(() => expect(screen.queryByText("Parar")).toBeNull());                           // the turn ended (GET run: completed)
    await send("segunda");
    await waitFor(() => expect(seen.posts.filter((p) => p.url.endsWith("/runs"))).toHaveLength(2));
    expect(seen.posts[1].body.session_id).toBe("s-made");                                          // the id the server made in the first call
  });

  it("run queued (202 with no run): the session it made is kept, so the next message continues the same conversation", async () => {
    backend({ run: () => ({ queued: true, code: "run_queued", run: null, session_id: "s-queued" }) });
    render(<Conversation bot={BOT} fetcher={idle} />);
    await waitFor(() => expect(screen.queryByTestId("conversation-loading")).toBeNull());
    await send("na fila");
    await screen.findByText("Na fila do Hermes. Não envie de novo: roda assim que ele voltar.");
    await send("outra");
    await waitFor(() => expect(seen.posts.filter((p) => p.url.endsWith("/runs"))).toHaveLength(2));
    expect(seen.posts[1].body.session_id).toBe("s-queued");
  });

  it("chat: the first message streams from /chat/stream (no session in the URL), takes the session id from the first frame, and the next goes to that session", async () => {
    backend();
    const fetcher = sseChat(["luvebot.stream.open", { bot: "vendas", surface: "chat", api: "0", session_id: "s-chat" }], ["run.completed", { run_id: "r", output: "feito" }]);
    render(<Conversation bot={BOT} surface="chat" fetcher={fetcher} />);
    await waitFor(() => expect(screen.queryByTestId("conversation-loading")).toBeNull());
    await send("oi");
    await waitFor(() => expect(seen.streams).toEqual(["POST /bots/vendas/chat/stream"]));
    await waitFor(() => expect(screen.queryByText("Parar")).toBeNull());
    await send("de novo");
    await waitFor(() => expect(seen.streams).toHaveLength(2));
    expect(seen.streams[1]).toBe("POST /bots/vendas/sessions/s-chat/chat/stream");
    expect(seen.posts.some((p) => p.url.endsWith("/sessions"))).toBe(false);
  });

  it("an existing conversation keeps its session: the first message after the history carries that session_id", async () => {
    seen = { posts: [], urls: [], streams: [] };
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
      if (method === "GET" && url.includes("/bots/vendas/sessions?")) return { sessions: [{ id: "s-old", kind: "conversation", last_active: 5 }] };
      if (method === "GET" && url.includes("/sessions/s-old/messages")) return { messages: [{ id: 1, role: "user", text: "antes" }, { id: 2, role: "assistant", text: "resposta antiga" }] };
      if (method === "POST" && url.endsWith("/runs")) { seen.posts.push({ url: "/bots/vendas/runs", body: JSON.parse(String(init!.body)) }); return { run: { id: "run_x", status: "started", session_id: "s-old" } }; }
      return {};
    });
    render(<Conversation bot={BOT} fetcher={idle} />);
    await screen.findByText("resposta antiga");
    await send("continuando");
    await waitFor(() => expect(seen.posts).toHaveLength(1));
    expect(seen.posts[0].body.session_id).toBe("s-old");
  });
});

describe("the CSRF token is asked when the app opens, not at the first send", () => {
  it("GET /session goes out once at startup, beside the lists, before any POST", async () => {
    backend();
    render(<LuveBotApp />);
    await waitFor(() => expect(seen.urls.some((u) => u === "GET /session")).toBe(true));
    await waitFor(() => expect(["GET /bots", "GET /approvals", "GET /rooms"].every((u) => seen.urls.includes(u))).toBe(true));
    expect(seen.urls.filter((u) => u === "GET /session")).toHaveLength(1);
    expect(seen.urls.filter((u) => u.startsWith("POST"))).toEqual([]);
  });
});
