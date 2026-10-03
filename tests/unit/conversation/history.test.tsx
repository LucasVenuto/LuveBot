// tests/unit/conversation/history.test.tsx
// A reload brings the conversation back (contract v0.4 B1, T11.0): the UI reads the history route, shows what was
// said, and the next message continues the same session instead of opening a new one.
import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { latestConversation, turnsFromHistory } from "@/components/chat/history";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import type { HistoryMessage, HistorySession } from "@/api/types";

const msg = (id: number, role: HistoryMessage["role"], text: string, extra: Partial<HistoryMessage> = {}): HistoryMessage => ({ id, role, text, ...extra });
const session = (id: string, kind: HistorySession["kind"], last_active: number): HistorySession => ({ id, kind, last_active });
const textOf = (turn: ReturnType<typeof turnsFromHistory>[number]) =>
  turn.state.items.filter((i) => i.kind === "message").map((i) => (i as { text: string }).text).join("");

beforeEach(() => { cleanup(); resetCsrfToken(); setCustomFetchJSON(null); });

describe("history → turns", () => {
  it("one turn per message, replies joined after it, the introduction without a person's bubble, tool rows and hidden rows left out", () => {
    const turns = turnsFromHistory([
      msg(1, "assistant", "Oi! Eu sou Vendas."),
      msg(2, "user", "Quais leads?"),
      msg(3, "assistant", "Vou olhar o CRM."),
      msg(4, "tool", "{raw tool output}"),
      msg(5, "assistant", "Três leads quentes."),
      msg(6, "user", "nota interna", { display_kind: "hidden" }),
      msg(7, "user", "Resuma a página", { page_ref: { slug: "plano" } }),
      msg(8, "assistant", "Não consegui.", { display_kind: "failed_turn" }),
    ]);
    expect(turns.map((t) => t.user)).toEqual(["", "Quais leads?", "Resuma a página"]);
    expect(textOf(turns[0])).toBe("Oi! Eu sou Vendas.");
    expect(textOf(turns[1])).toBe("Vou olhar o CRM.\n\nTrês leads quentes.");
    expect(textOf(turns[1])).not.toContain("raw tool output");
    expect(turns[2].aboutPage).toBe("plano");
    expect(turns.map((t) => t.confirmed)).toEqual(["completed", "completed", "failed"]);
    expect(turns.map((t) => t.state.status)).toEqual(["completed", "completed", "failed"]);
  });

  it("the conversation continues the newest conversation or introduction, never a channel or a routine", () => {
    expect(latestConversation([session("tg", "channel", 90), session("old", "conversation", 10), session("new", "conversation", 50), session("cron", "routine", 99)])?.id).toBe("new");
    expect(latestConversation([session("intro", "introduction", 5)])?.id).toBe("intro");
    expect(latestConversation([session("tg", "channel", 90)])).toBeNull();
  });
});

describe("Conversation after a reload", () => {
  it("shows the past messages and sends the next one in the SAME session, without creating another", async () => {
    const calls: Array<{ method: string; url: string; body?: any }> = [];
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
      if (method === "GET" && url.includes("/bots/vendas/sessions?")) return { sessions: [session("s-old", "conversation", 10), session("s-new", "conversation", 20)] };
      if (method === "GET" && url.includes("/bots/vendas/sessions/s-new/messages")) return { messages: [msg(1, "user", "O que você faz?"), msg(2, "assistant", "Prospecção B2B.")] };
      if (method === "POST" && url.endsWith("/bots/vendas/sessions")) return { session: { id: "s-created" } };
      if (method === "POST" && url.endsWith("/runs")) return { run: { id: "run_1", status: "started", session_id: "s-new" } };
      if (method === "GET" && url.includes("/runs/")) return { run: { id: "run_1", status: "completed" } };
      throw new Error("unexpected " + method + " " + url);
    });
    const empty = async () => new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    render(<Conversation bot={{ name: "vendas", label: "Vendas" }} fetcher={empty} pollMs={5} />);
    const chat = within(screen.getByLabelText(/^Conversa com/));
    expect(await chat.findByText("O que você faz?")).toBeTruthy();
    expect(chat.getByText("Prospecção B2B.")).toBeTruthy();
    expect(screen.queryByTestId("conversation-empty-state")).toBeNull();

    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "E os leads?" } });
    fireEvent.click(screen.getByText("Enviar"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/runs"))).toBe(true));
    const run = calls.find((c) => c.method === "POST" && c.url.endsWith("/runs"))!;
    expect(run.body.session_id).toBe("s-new");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/sessions"))).toBe(false);
  });
});
