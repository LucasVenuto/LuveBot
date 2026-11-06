// tests/unit/conversation/open-fast.test.tsx
// perf-tela.md item 3: opening a conversation took four reads in a row (sessions, messages, activity, run) before anything was drawn, and the
// screen invited the person to start a conversation meanwhile. Now: "Carregando a conversa…" until the history question is answered; the
// history is drawn as soon as its messages arrive; whether its last turn still runs is read after, under "Conferindo…", and applied on top.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act, within } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";

type Gate = { promise: Promise<void>; open: () => void };
const gate = (): Gate => { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); return { promise, open }; };

function backend(holds: { sessions?: Gate; activity?: Gate; sessionsFail?: boolean } = {}, live: "idle" | "running" = "running") {
  const order: string[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "c", actor: "dashboard", auth_mode: "gated" };
    if (url.includes("/bots/vendas/sessions?")) {
      order.push("sessions"); if (holds.sessions) await holds.sessions.promise;
      if (holds.sessionsFail) throw new Error("down");
      return { sessions: [{ id: "s1", kind: "conversation", last_active: 5 }] };
    }
    if (url.includes("/sessions/s1/messages")) { order.push("messages"); return { messages: [{ id: 1, role: "user", text: "Qual o status?" }, { id: 2, role: "assistant", text: "Tudo certo por aqui." }] }; }
    if (url.includes("/activity?")) {
      order.push("activity"); if (holds.activity) await holds.activity.promise;
      return live === "running" ? { items: [{ id: "run:r9", kind: "run", bot: "vendas", title: null, origin: "message", status: "running", links: { run_id: "r9", session_id: "s1" } }] } : { items: [] };
    }
    if (url.includes("/runs/r9")) { order.push("run"); return { run: { id: "r9", status: "started" } }; }
    if (method === "GET" && url.endsWith("/voice")) return {};
    throw new Error("unexpected " + method + " " + url);
  });
  return order;
}
const open = () => { render(<Conversation bot={{ name: "vendas", label: "Vendas" }} pollMs={20} />); return within(screen.getByLabelText(/^Conversa com/)); };

beforeEach(() => { cleanup(); resetCsrfToken(); });
afterEach(() => setCustomFetchJSON(null));

describe("opening a conversation", () => {
  it("says 'Carregando a conversa…' while the history is being asked, never the invitation to start one; then the invitation only when there really is no history", async () => {
    const sessions = gate();
    backend({ sessions });
    const chat = open();
    expect(chat.getByTestId("conversation-loading").textContent).toBe("Carregando a conversa…");
    expect(chat.queryByTestId("conversation-empty-state")).toBeNull();
    await act(async () => { sessions.open(); });
    await chat.findByText("Tudo certo por aqui.");
    expect(chat.queryByTestId("conversation-loading")).toBeNull();
  });

  it("a history that cannot be read does not leave 'Carregando…' forever: the conversation works from a blank screen", async () => {
    backend({ sessionsFail: true });
    const chat = open();
    await chat.findByTestId("conversation-empty-state");
    expect(chat.queryByTestId("conversation-loading")).toBeNull();
  });

  it("the history is DRAWN while the 'does its last turn still run?' reads are still on the way, as 'Conferindo…'; then the live state lands on top", async () => {
    const activity = gate();
    const order = backend({ activity });
    const chat = open();
    expect(await chat.findByText("Tudo certo por aqui.")).toBeTruthy();                         // drawn although /activity has not answered
    expect(chat.getByText("Conferindo…")).toBeTruthy();
    expect(chat.queryByText("Concluído")).toBeNull();                                           // never claimed done before Hermes said so
    expect(chat.queryByText("Parar")).toBeNull();                                               // and not yet 'running' either
    expect(order).toEqual(["sessions", "messages", "activity"]);                                // the run is read only after the history is on screen
    await act(async () => { activity.open(); });
    await waitFor(() => expect(chat.queryByText("Conferindo…")).toBeNull());
    expect(await chat.findByText("Parar")).toBeTruthy();                                        // still running: the turn follows Hermes
  });

  it("a conversation whose last turn is over ends 'Concluído' after the check", async () => {
    backend({}, "idle");
    const chat = open();
    await chat.findByText("Tudo certo por aqui.");
    await waitFor(() => expect(chat.getByText("Concluído")).toBeTruthy());
    expect(chat.queryByText("Conferindo…")).toBeNull();
  });
});
