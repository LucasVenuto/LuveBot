// tests/unit/conversation/steps.test.tsx
// T12.3 (the CEO): a turn's tool steps are ONE compact line in the chat, the detail lives in the work panel; "Ver na Atividade"
// takes you to that turn; the panel can be hidden (kept per browser) and a dot says when something new happened; the approval
// card speaks plainly (the rule's label, the tool, the redacted command; ids only in a collapsed detail).
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { stepsSummary } from "@/components/conversation/StepsLine";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";

const enc = new TextEncoder();
const frame = (seq: number, data: Record<string, any>) => `id: ${seq}\ndata: ${JSON.stringify({ run_id: "run_r1", seq, ...data })}\n\n`;
const tool = (name: string, preview: string, status: "running" | "done" | "error" = "done") => ({ kind: "tool", id: name, name, status, preview }) as any;

function manual() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  return { stream, push: (s: string) => act(() => { ctl.enqueue(enc.encode(s)); }), close: () => act(() => { ctl.close(); }) };
}
function backend(extra: (method: string, url: string) => unknown = () => undefined) {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const x = extra(method, url);
    if (x !== undefined) return x;
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
    if (method === "POST" && url.endsWith("/sessions")) return { session: { id: "s1" } };
    if (method === "POST" && url.endsWith("/runs")) return { run: { id: "run_r1", status: "started", session_id: "s1" } };
    if (method === "GET" && url.includes("/runs/")) return { run: { id: "run_r1", status: "started" } };
    return {};
  });
}
const desktop = () => vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
const phone = () => vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
const chat = () => within(screen.getByLabelText(/^Conversa com/));
async function turnWith3Tools() {
  const s = manual();
  render(<Conversation bot={{ name: "vendas", label: "Vendas" }} fetcher={async () => new Response(s.stream, { status: 200, headers: { "content-type": "text/event-stream" } })} pollMs={10_000} />);
  fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "levante os leads" } });
  fireEvent.click(screen.getByText("Enviar"));
  await waitFor(() => expect(screen.getByText("Parar")).toBeTruthy());
  let n = 0;
  for (const [name, preview] of [["crm_read", "leads abertos"], ["web_search", "Alder empresa"], ["write_file", "/tmp/leads.md"]]) {
    s.push(frame(n++, { event: "tool.started", tool: name, preview }));
    s.push(frame(n++, { event: "tool.completed", tool: name, duration: 0.2, error: false }));
  }
  s.push(frame(n++, { event: "message.delta", delta: "Três leads quentes." }));
  return { s, n };
}

beforeEach(() => { cleanup(); resetCsrfToken(); try { localStorage.clear(); } catch { /* */ } desktop(); });
afterEach(() => { vi.unstubAllGlobals(); setCustomFetchJSON(null); });

describe("one compact line of steps per turn", () => {
  it("summarises the count, the first tools and the state", () => {
    expect(stepsSummary([tool("crm_read", ""), tool("web_search", ""), tool("write_file", "")])).toEqual({ count: 3, names: "crm_read, web_search…", state: "done" });
    expect(stepsSummary([tool("a", ""), tool("a", "", "running")]).state).toBe("running");
    expect(stepsSummary([tool("a", "", "error"), tool("b", "")]).state).toBe("error");
  });

  it("the chat shows ONE line for the turn's 3 steps; the full detail is in the work panel; it opens in place too", async () => {
    backend();
    await turnWith3Tools();
    const lines = await chat().findAllByRole("button", { name: /3 passos/ });
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain("3 passos");
    expect(lines[0].textContent).toContain("crm_read, web_search…");
    expect(chat().queryByText("Alder empresa")).toBeNull();                 // no tool card in the chat
    const panel = within(document.getElementById("lb-work-panel")!);
    expect(panel.getByText("Alder empresa")).toBeTruthy();                  // the detail is in the panel
    fireEvent.click(lines[0]);
    expect(lines[0].getAttribute("aria-expanded")).toBe("true");
    expect(chat().getByText("Alder empresa")).toBeTruthy();                 // and can open in place
  });

  it("'Ver na Atividade' brings that turn into view in the panel, and reopens a hidden panel", async () => {
    backend();
    await turnWith3Tools();
    fireEvent.click(screen.getByRole("button", { name: "Ocultar painel de trabalho" }));
    expect(document.getElementById("lb-work-panel")).toBeNull();
    fireEvent.click(await chat().findByRole("button", { name: "Ver na Atividade" }));
    await waitFor(() => expect((document.activeElement as HTMLElement)?.dataset.workTurn).toBeDefined());
    expect(document.getElementById("lb-work-panel")?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Pedido: levante os leads");
  });

  it("the approval card and the turn's error stay whole in the chat", async () => {
    backend();
    const { s, n } = await turnWith3Tools();
    s.push(frame(n, { event: "approval.request", request_id: "req-1", command: "rm -rf /tmp/x", description: "dangerous command", choices: ["once", "deny"] }));
    await waitFor(() => expect(chat().getByRole("group", { name: "Pedido de aprovação" })).toBeTruthy());
    expect(chat().getByText("rm -rf /tmp/x")).toBeTruthy();
  });
});

describe("the work panel can be hidden", () => {
  it("the header button toggles it (aria-expanded), the conversation takes the width, and the choice is kept in this browser", async () => {
    backend();
    const { unmount } = render(<Conversation bot={{ name: "vendas", label: "Vendas" }} fetcher={async () => new Response("")} />);
    const btn = screen.getByRole("button", { name: "Ocultar painel de trabalho" });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("lb-work-panel")).not.toBeNull();
    fireEvent.click(btn);
    expect(document.getElementById("lb-work-panel")).toBeNull();
    expect(screen.getByRole("button", { name: "Mostrar painel de trabalho" }).getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("luvebot.workpanel")).toBe("closed");
    unmount();
    render(<Conversation bot={{ name: "vendas", label: "Vendas" }} fetcher={async () => new Response("")} />);
    expect(document.getElementById("lb-work-panel")).toBeNull();          // kept after a reload
  });

  it("with the panel closed, new activity puts a dot on the button (and in its name); opening clears it", async () => {
    backend();
    const s = manual();
    render(<Conversation bot={{ name: "vendas", label: "Vendas" }} fetcher={async () => new Response(s.stream, { status: 200, headers: { "content-type": "text/event-stream" } })} pollMs={10_000} />);
    fireEvent.click(screen.getByRole("button", { name: "Ocultar painel de trabalho" }));
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText("Enviar"));
    await waitFor(() => expect(screen.getByText("Parar")).toBeTruthy());
    s.push(frame(0, { event: "tool.started", tool: "crm_read", preview: "x" }));
    const btn = await screen.findByRole("button", { name: "Mostrar painel de trabalho (atividade nova)" });
    expect(btn.querySelector(".lb-panel-dot")).not.toBeNull();
    fireEvent.click(btn);
    expect(screen.getByRole("button", { name: "Ocultar painel de trabalho" }).querySelector(".lb-panel-dot")).toBeNull();
  });

  it("a browser that blocks storage still shows and hides the panel", () => {
    backend();
    const real = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
    try {
      render(<Conversation bot={{ name: "vendas", label: "Vendas" }} fetcher={async () => new Response("")} />);
      fireEvent.click(screen.getByRole("button", { name: "Ocultar painel de trabalho" }));
      expect(document.getElementById("lb-work-panel")).toBeNull();
    } finally { Object.defineProperty(window, "localStorage", real); }
  });

  it("on a phone the line opens the Atividade as a screen of its own, at that turn", async () => {
    phone();
    backend();
    await turnWith3Tools();
    expect(screen.queryByRole("button", { name: /painel de trabalho$/ })).toBeNull();  // no side-panel toggle on a phone
    fireEvent.click(await chat().findByRole("button", { name: "Ver na Atividade" }));
    const screenOwn = await screen.findByRole("dialog", { name: "Painel de trabalho" });
    await waitFor(() => expect(screenOwn.contains(document.activeElement) && (document.activeElement as HTMLElement).dataset.workTurn !== undefined).toBe(true));
    expect(within(screenOwn).getByRole("button", { name: /Voltar para a conversa/ })).toBeTruthy();
  });
});

describe("the approval card speaks plainly", () => {
  const ruleFrame = (rule: string) => ({ event: "approval.request", request_id: "req-9", luvebot_digest: "d9", choices: ["once", "deny"],
    description: `luvebot:${rule}`, command: "<terminal> (plugin approval rule)", pattern_key: `plugin_rule:luvebot:${rule}#12.abc` });

  it("no raw id in the title: 'noncanonical' reads as an unusual action, the tool by its name, the stored command redacted, ids in a collapsed detail", async () => {
    backend((method, url) => (method === "GET" && url.endsWith("/approvals")) ? { approvals: [{ request_id: "req-9", command_redacted: "curl -s https://api.exemplo.com/***", tool: "terminal", rule_id: null }] }
      : (method === "GET" && url.endsWith("/rules")) ? { rules: [] } : undefined);
    const s = manual();
    render(<Conversation bot={{ name: "vendas", label: "Vendas" }} fetcher={async () => new Response(s.stream, { status: 200, headers: { "content-type": "text/event-stream" } })} pollMs={10_000} />);
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText("Enviar"));
    await waitFor(() => expect(screen.getByText("Parar")).toBeTruthy());
    s.push(frame(0, ruleFrame("noncanonical")));
    const card = within(await screen.findByRole("group", { name: "Pedido de aprovação" }));
    expect(card.getByText("Ação fora do padrão: o LuveBot pede a sua confirmação")).toBeTruthy();
    expect(card.getByText("Comando no terminal")).toBeTruthy();
    expect(await card.findByText("curl -s https://api.exemplo.com/***")).toBeTruthy();
    const detail = card.getByText("Detalhe técnico").closest("details")!;
    expect(detail.hasAttribute("open")).toBe(false);
    // the raw strings exist only inside the collapsed detail
    for (const raw of ["luvebot:noncanonical", "<terminal> (plugin approval rule)"]) {
      for (const el of card.queryAllByText(raw, { exact: false })) expect(detail.contains(el)).toBe(true);
    }
  });

  it("a LuveBot rule is named by its label, never its id", async () => {
    backend((method, url) => (method === "GET" && url.endsWith("/rules")) ? { rules: [{ rule: { id: "r-envio", label: "Enviar e-mail para fora" }, seal_result: {} }] }
      : (method === "GET" && url.endsWith("/approvals")) ? { approvals: [] } : undefined);
    const s = manual();
    render(<Conversation bot={{ name: "vendas", label: "Vendas" }} fetcher={async () => new Response(s.stream, { status: 200, headers: { "content-type": "text/event-stream" } })} pollMs={10_000} />);
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText("Enviar"));
    await waitFor(() => expect(screen.getByText("Parar")).toBeTruthy());
    s.push(frame(0, ruleFrame("r-envio")));
    const card = within(await screen.findByRole("group", { name: "Pedido de aprovação" }));
    expect(await card.findByText("Regra “Enviar e-mail para fora” pede a sua confirmação")).toBeTruthy();
    const title = card.getByText(/pede a sua confirmação/);
    expect(title.textContent).not.toContain("r-envio");
  });
});
