// tests/unit/conversation/thread-controls.test.tsx
// Red team 29/10 M4: the thread panel had no Bot question (clarify), no lost run (unknown) and no "outro canal", so a Bot that asked something inside a
// thread waited with no card; and Hoje's "Abrir conversa" took the person to the main conversation, where the question is not. Now the panel mounts the same
// cards as the main conversation (every answer a person's click with a login), and Hoje opens the session the Bot waits in.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { Hoje } from "@/components/Hoje";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import { vi } from "vitest";

const QUOTE = "[Respondendo à mensagem de vendas (14:05 UTC): «Tudo certo por aqui.»]\n\n";
type Sent = { url: string; body: any; csrf: string | null };
let sent: Sent[], posts: Sent[], run: () => any, runStatusOf: "running" | "none", mainRun: boolean;
const bare = (u: string) => u.replace("/api/plugins/luvebot", "");

function backend() {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (method === "POST") { posts.push({ url: bare(url), body: JSON.parse(String(init?.body)), csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") }); return { clarify: { request_id: "q1", status: "resolved" }, run: { id: "r1", status: "started" } }; }
    if (method === "GET" && url.includes("/bots/vendas/sessions?")) return { sessions: [{ id: "s1", kind: "conversation", last_active: 5 }] };
    if (method === "GET" && url.includes("/sessions/s1/messages")) return { messages: [{ id: 11, role: "user", text: "Qual o status?" }, { id: 12, role: "assistant", text: "Tudo certo por aqui." }] };
    if (method === "GET" && url.includes("/sessions/c1/messages")) return { messages: [{ id: 31, role: "user", text: QUOTE + "e se for 30 dias?" }] };
    if (method === "GET" && url.includes("/sessions/s1/threads")) return { threads: [{ message_id: 12, child_session: "c1", replies: 1, last_at: null }], truncated: false };
    if (method === "GET" && url.includes("/activity?")) return { items: runStatusOf === "running" ? [{ id: "run:r1", kind: "run", bot: "vendas", title: null, origin: "message", status: "running", links: { run_id: "r1", session_id: "c1" } }] : [] };
    if (method === "GET" && url.endsWith("/bots/vendas/runs/r1")) return { run: run() };
    return {};
  });
}
const fetcher = async (url: string, init?: RequestInit) => {
  const u = bare(url);
  sent.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null, csrf: null });
  if (u.endsWith("/sessions/c1/chat/stream")) throw new ApiError({ code: "session_other_channel", message: "x", status: 409, details: { source: "telegram" } } as never);
  return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const open = (extra: Record<string, unknown> = {}) => render(<Conversation bot={{ name: "vendas", label: "Vendas" }} surface="chat" fetcher={fetcher as any} pollMs={10} {...extra} />);
const openThread = async () => { fireEvent.click(await screen.findByTestId("thread-chip")); return await screen.findByTestId("thread-panel"); };
const asking = (over: Record<string, unknown> = {}) => ({ id: "r1", status: "started", execution_generation: 7, pending_controls: [{ kind: "clarify", request_id: "q1", question: "Qual <b>cliente</b>?", choices: [], multi_select: false }], ...over });

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); sent = []; posts = []; runStatusOf = "running"; mainRun = false; run = () => asking(); backend(); });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });

describe("a Bot that asks inside a thread", () => {
  it("the question shows in the thread panel as TEXT, the status says it waits for the person, and the answer is a click with the generation it saw and the CSRF", async () => {
    open();
    const panel = await openThread();
    const card = await within(panel).findByTestId("clarify-card");
    expect(card.textContent).toContain("Qual <b>cliente</b>?");
    expect(card.querySelector("b")).toBeNull();
    await waitFor(() => expect(within(panel).getAllByRole("status").map((x) => x.textContent)).toContain("Esperando você"));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toHaveLength(0);                                                           // nothing is answered by itself
    fireEvent.change(within(panel).getByLabelText("Sua resposta"), { target: { value: "A Acme" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Responder" }));
    await within(panel).findByText("Resposta enviada. O Bot segue daqui.");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ url: "/bots/vendas/runs/r1/clarify", body: { request_id: "q1", execution_generation: 7, answer: "A Acme" }, csrf: "csrf-1" });
  });

  it("a run Hermes lost track of (unknown) has its card too, never resolved by itself", async () => {
    run = () => ({ id: "r1", status: "unknown", execution_generation: 3, pending_controls: [], resolution: { needed: true, admission_id: "a1", execution_generation: 3 } });
    open();
    const panel = await openThread();
    await within(panel).findByTestId("unknown-run-card");
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toHaveLength(0);
  });

  it("no open run, no card; the main conversation does not get the thread's question", async () => {
    runStatusOf = "none";
    open();
    const panel = await openThread();
    await within(panel).findByText("e se for 30 dias?");
    expect(within(panel).queryByTestId("clarify-card")).toBeNull();
    expect(screen.queryAllByTestId("clarify-card")).toHaveLength(0);
  });
});

describe("a thread of another channel", () => {
  it("the refusal shows the 'outro canal' card in the panel; 'Nova conversa' only fills the composer, and the next message starts a NEW THREAD (POST /threads), not a main conversation", async () => {
    runStatusOf = "none";
    open();
    const panel = await openThread();
    await within(panel).findByText("e se for 30 dias?");
    const box = within(panel).getByLabelText("Resposta na conversa");
    fireEvent.change(box, { target: { value: "oi" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const card = await within(panel).findByTestId("other-channel-card");
    expect(card.textContent).toContain("Telegram");
    sent.length = 0;
    fireEvent.click(within(card).getByRole("button", { name: "Nova conversa" }));
    await waitFor(() => expect((within(panel).getByLabelText("Resposta na conversa") as HTMLTextAreaElement).value).toContain("oi"));
    expect(sent).toHaveLength(0);                                                            // nothing is sent by the click
    fireEvent.keyDown(within(panel).getByLabelText("Resposta na conversa"), { key: "Enter" });
    await waitFor(() => expect(sent.some((s) => s.url === "/bots/vendas/threads")).toBe(true));
    expect(sent.find((s) => s.url === "/bots/vendas/threads")!.body).toMatchObject({ session_id: "s1", message_id: 12 });
    expect(sent.some((s) => s.url === "/bots/vendas/chat/stream")).toBe(false);
  });
});

describe("Hoje sends the person to the session the Bot waits in", () => {
  it("'Abrir conversa' hands the wait's session to the app, not only the Bot", () => {
    const onSelectBot = vi.fn();
    const BOTS = [{ name: "vendas", display: { label: "Vendas", role: "", color: "#60a5fa", avatar: { kind: "initials", value: "VE" } }, status: "idle" }] as any;
    render(<Hoje bots={BOTS} approvals={[]} handoffs={[]} inProgressItems={[]} completedItems={[]} routines={[]} onSelectBot={onSelectBot}
      waiting={[{ bot: "vendas", request_id: "a".repeat(32), kind: "clarify", since: 1_800_000_000, session_id: "c1", platform: "api_server", prompt: "Qual?" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /Abrir conversa/ }));
    expect(onSelectBot).toHaveBeenCalledWith("vendas", "c1");
  });

  it("a session that is not the main one opens as a thread panel, once; the main session itself opens nothing", async () => {
    runStatusOf = "none";
    const done = vi.fn();
    open({ focusSession: "c1", onFocusDone: done });
    const panel = await screen.findByTestId("thread-panel");
    await within(panel).findByText("e se for 30 dias?");
    expect(screen.getByTestId("thread-quote").textContent).toContain("Tudo certo por aqui.");          // the quote is the server's line, taken from the thread's own first message
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    cleanup(); done.mockClear(); backend();
    open({ focusSession: "s1", onFocusDone: done });
    await screen.findByText("Tudo certo por aqui.");
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("thread-panel")).toBeNull();
  });
});
