// tests/unit/conversation/reopen-state.test.tsx
// Brasa's e2e on the phone: reopening the conversation showed the turn "Concluído" while Hermes said waiting_for_approval (the
// second gate still pending). A past turn's end comes from Hermes: when the session's newest run is still open, its turn says
// what Hermes says (waiting, working) and follows Hermes until Hermes ends it; "Concluído" only after Hermes says completed.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";

type Hermes = { status: string; status_raw?: string; output?: string };
function backend(opts: { runSession: string; hermes: () => Hermes | Promise<Hermes>; activity?: () => unknown }) {
  const calls: string[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
    if (url.includes("/bots/vendas/sessions?")) return { sessions: [{ id: "s-new", kind: "conversation", last_active: 20 }] };
    if (url.includes("/bots/vendas/sessions/s-new/messages"))
      return { messages: [{ id: 1, role: "user", text: "Peça a ferramenta perigosa." }, { id: 2, role: "assistant", text: "Testando a ferramenta local." }] };
    if (url.includes("/activity?")) return opts.activity ? opts.activity() : {
      items: [{ id: "run:run_w", kind: "run", bot: "vendas", title: null, origin: "message", status: "waiting_approval",
        links: { run_id: "run_w", session_id: opts.runSession } }],
    };
    if (url.includes("/bots/vendas/runs/run_w")) return { run: { id: "run_w", ...(await opts.hermes()) } };
    throw new Error("unexpected " + method + " " + url);
  });
  return calls;
}
const open = () => {
  render(<Conversation bot={{ name: "vendas", label: "Vendas" }} pollMs={5} />);
  return within(screen.getByLabelText(/^Conversa com/));
};

beforeEach(() => { cleanup(); resetCsrfToken(); });
afterEach(() => setCustomFetchJSON(null));

describe("a reopened conversation says what Hermes says about its last turn", () => {
  it("Hermes waiting_for_approval: the turn waits (not Concluído), then follows Hermes to working and to the end", async () => {
    let hermes: Hermes = { status: "waiting_for_approval" };
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let asked = 0;  // the first answer opens the turn; the follow-up polls wait, so what the reopen itself shows is checked
    backend({ runSession: "s-new", hermes: async () => { if (asked++ > 0) await held; return hermes; } });
    const chat = open();
    expect(await chat.findByText("Testando a ferramenta local.")).toBeTruthy();
    expect(await chat.findByText("Aguardando aprovação")).toBeTruthy();
    expect(chat.queryByText("Concluído")).toBeNull();
    expect(screen.getByText("Parar")).toBeTruthy();  // the run is open: it can be stopped, and a new message waits

    hermes = { status: "started" };  // someone approved it in the inbox, on another device
    release();
    expect(await chat.findByText("Trabalhando…")).toBeTruthy();
    expect(chat.queryByText("Aguardando aprovação")).toBeNull();
    expect(chat.queryByText("Concluído")).toBeNull();

    hermes = { status: "completed", output: "Ferramenta usada." };
    expect(await chat.findByText("Concluído")).toBeTruthy();
    expect(chat.getByText("Ferramenta usada.")).toBeTruthy();
    expect(screen.queryByText("Parar")).toBeNull();
  });

  it("the run index still lists it as open but Hermes says it ended: Hermes wins, with its own end", async () => {
    backend({ runSession: "s-new", hermes: () => ({ status: "failed" }) });
    const chat = open();
    expect(await chat.findByText("Testando a ferramenta local.")).toBeTruthy();
    await waitFor(() => expect(chat.getByText("Falhou")).toBeTruthy());  // not history's "Concluído"
    expect(chat.queryByText("Concluído")).toBeNull();
    expect(chat.queryByText("Aguardando aprovação")).toBeNull();
    expect(screen.queryByText("Parar")).toBeNull();
  });

  it("an open run of another session does not touch this conversation, and Hermes is not asked about it", async () => {
    const calls = backend({ runSession: "s-other", hermes: () => ({ status: "waiting_for_approval" }) });
    const chat = open();
    expect(await chat.findByText("Concluído")).toBeTruthy();
    expect(chat.queryByText("Aguardando aprovação")).toBeNull();
    expect(calls.some((c) => c.includes("/runs/run_w"))).toBe(false);
  });

  it("an interrupted run (status_raw) is an end, not an open turn", async () => {
    backend({ runSession: "s-new", hermes: () => ({ status: "unknown", status_raw: "interrupted" }) });
    const chat = open();
    expect(await chat.findByText("Interrompido")).toBeTruthy();
    expect(screen.queryByText("Parar")).toBeNull();
  });
});
