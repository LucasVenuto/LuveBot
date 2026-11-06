// tests/unit/chat/inline-approval.test.tsx
// The approval card inside the conversation (T7.1 F3): decided for real, by a human click only (invariant 6),
// and only when the backend stored the request and gave it a luvebot_digest (contract v0.1 A-14).
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { InlineApproval } from "@/components/chat/InlineApproval";
import { parseSse } from "@/components/transcript";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";

const real = parseSse(readFileSync(path.resolve(__dirname, "../../contract/frames/run/approval.request.sse"), "utf8"));
const stored = { ...real, luvebot_digest: "dg-123" };

type Call = { method: string; url: string; csrf: string | null; body?: any };
function backend(answer: (c: Call) => any = () => ({ approval: { status: "decided" } })) {
  const calls: Call[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const c: Call = { method: init?.method ?? "GET", url, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF"), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
    return answer(c);
  });
  return calls;
}
const decisions = (calls: Call[]) => calls.filter((c) => c.method === "POST" && /approval/.test(c.url));

beforeEach(() => { cleanup(); resetCsrfToken(); setCustomFetchJSON(null); });

describe("InlineApproval", () => {
  it("shows the command and nothing is sent without a click", () => {
    const calls = backend();
    render(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending />);
    expect(screen.getByText("rm -rf /tmp/luvebot-approval-canary")).toBeTruthy();
    // native "session" and "always" are never offered: once, always-as-draft, deny
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Permitir uma vez", "Sempre permitir…", "Negar…"]);
    expect(decisions(calls)).toHaveLength(0);
  });

  it("Permitir uma vez resolves this run's request with the stored digest and CSRF", async () => {
    const calls = backend();
    render(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending />);
    fireEvent.click(screen.getByText("Permitir uma vez"));
    await screen.findByText("Permitida uma vez.");
    expect(decisions(calls)).toEqual([{
      method: "POST", url: "/api/plugins/luvebot/bots/vendas/runs/run_r1/approval", csrf: "csrf-1",
      body: { request_id: real.request_id, digest: "dg-123", choice: "once" },
    }]);
    expect(screen.queryByText("Permitir uma vez")).toBeNull(); // decided once; no second click possible
  });

  it("Sempre permitir sends once plus a draft rule, never 'always'", async () => {
    const calls = backend();
    render(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending />);
    fireEvent.click(screen.getByText("Sempre permitir…"));
    expect(decisions(calls)).toHaveLength(0);
    fireEvent.click(screen.getByText("Criar rascunho e permitir uma vez"));
    await waitFor(() => expect(decisions(calls)).toHaveLength(1));
    const body = decisions(calls)[0].body;
    expect(body).toMatchObject({ request_id: real.request_id, digest: "dg-123", choice: "once", draft_rule: { level: "allow" } });
    expect(body.draft_rule.label).toContain("delete in root path");
    expect(JSON.stringify(body)).not.toContain('"always"');
  });

  it("Negar needs a reason; the reason goes to the backend", async () => {
    const calls = backend();
    render(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending />);
    fireEvent.click(screen.getByText("Negar…"));
    const confirm = screen.getByText("Confirmar negação") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Motivo da negação/), { target: { value: "   " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Motivo da negação/), { target: { value: " não apague nada " } });
    fireEvent.click(confirm);
    await screen.findByText("Negada.");
    expect(decisions(calls)[0].body).toEqual({ request_id: real.request_id, digest: "dg-123", choice: "deny", reason: "não apague nada" });
  });

  it("without luvebot_digest (the backend could not store it) nothing can be decided here", () => {
    const calls = backend();
    render(<InlineApproval frame={real} bot="vendas" runId="run_r1" pending />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText(/não pode ser decidido por aqui/)).toBeTruthy();
    expect(decisions(calls)).toHaveLength(0);
  });

  it("once the turn is over the request is no longer decidable", () => {
    render(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending={false} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("Este pedido não está mais pendente.")).toBeTruthy();
  });

  it("a refusal from the server is shown and the buttons stay for a new human decision", async () => {
    backend(() => { throw new ApiError({ code: "loopback_not_human", message: "x", status: 403 }); });
    render(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending />);
    fireEvent.click(screen.getByText("Permitir uma vez"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/loopback|humano|sessão/i);
    expect(screen.getByText("Permitir uma vez")).toBeTruthy();
  });
});

describe("o cartão decidido: a confirmação fica e o FOCO tem onde pousar (passada de acessibilidade, o mesmo padrão do cartão da pergunta)", () => {
  /** Chrome drops the focus of a control the moment it turns disabled (the request is on its way) and it falls to the page body; jsdom keeps a disabled button focused, so the test does what the browser does. */
  const asChromeDoes = () => { const t = document.createElement("div"); t.tabIndex = -1; document.body.appendChild(t); t.focus(); t.blur(); t.remove(); };
  /** The decision's POST stays in flight until released (or refused). */
  // What the server's answer carries when "Sempre permitir" SAVED its draft (A-216: the card says "saved" only on this evidence).
  const SAVED_DRAFT = { id: "aa-1", label: "x", level: "allow", scope: { kind: "bot", ref: "vendas" }, state: "draft", origin: "always_allow" };
  function held() {
    let release!: () => void, refuse!: () => void;
    const gate = new Promise((ok, no) => { release = () => ok({ approval: { status: "decided" }, draft_rule: SAVED_DRAFT }); refuse = () => no(new ApiError({ code: "request_not_pending", message: "x", status: 409 })); });
    const calls = backend((c) => (c.method === "POST" && /approval/.test(c.url) ? gate : { approvals: [] }));
    return { calls, release: () => release(), refuse: () => refuse() };
  }
  const btn = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  const mount = (extra?: React.ReactNode) => render(<>{extra}<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending /></>);
  const card = () => screen.getByRole("group", { name: "Pedido de aprovação" });
  /** What the focus is the instant `find` first returns an element: a MutationObserver's callback runs right after the commit that changed the DOM (a microtask), before any passive effect or paint. */
  function firstSight(find: () => Element | null, focusIsRight: (el: Element) => boolean) {
    const out: { seen: boolean; focusAtFirstSight: "yes" | "no" | null } = { seen: false, focusAtFirstSight: null };
    const mo = new MutationObserver(() => { const el = find(); if (el && !out.seen) { out.seen = true; out.focusAtFirstSight = focusIsRight(el) ? "yes" : "no"; } });
    mo.observe(document.body, { childList: true, subtree: true });
    return { out, stop: () => mo.disconnect() };
  }

  it("Permitir uma vez: the buttons go, the confirmation line stays and HOLDS THE FOCUS, and the card's 'it needs you' edge goes calm", async () => {
    const h = held();
    mount();
    expect(card().getAttribute("style")).toContain("--color-warning");                  // asking: the card has the "it needs you" edge
    btn("Permitir uma vez").focus();
    fireEvent.click(btn("Permitir uma vez"));
    asChromeDoes();
    await waitFor(() => expect(decisions(h.calls)).toHaveLength(1));
    expect(document.activeElement).toBe(document.body);                                  // what the browser does while it is on its way
    h.release();
    const said = await screen.findByText("Permitida uma vez.");
    await waitFor(() => expect(document.activeElement).toBe(said));                      // the focus did not fall to the page body
    expect(said.getAttribute("role")).toBe("status");
    expect(said.getAttribute("tabindex")).toBe("-1");                                    // reachable for focus(), not a stop in the Tab order
    expect(card().contains(said)).toBe(true);
    expect(within(card()).queryAllByRole("button")).toHaveLength(0);
    expect(card().textContent).toContain("rm -rf /tmp/luvebot-approval-canary");         // what was decided stays on screen
    expect(card().getAttribute("style")).not.toContain("--color-warning");
    expect(card().getAttribute("style")).toContain("--color-border");
  });

  it("Sempre permitir…: opening it puts the focus in the draft's name, Cancelar gives it back to the button that opened it, and the draft's confirmation holds it", async () => {
    const h = held();
    mount();
    btn("Sempre permitir…").focus();
    fireEvent.click(btn("Sempre permitir…"));
    expect(document.activeElement).toBe(screen.getByLabelText(/Nome da regra|rascunho/i));   // the button that was clicked is gone: the field is where they go next
    fireEvent.click(btn("Cancelar"));
    expect(document.activeElement).toBe(btn("Sempre permitir…"));
    fireEvent.click(btn("Sempre permitir…"));
    btn("Criar rascunho e permitir uma vez").focus();
    fireEvent.click(btn("Criar rascunho e permitir uma vez"));
    asChromeDoes();
    await waitFor(() => expect(decisions(h.calls)).toHaveLength(1));
    h.release();
    const said = await screen.findByText("Permitido desta vez. A regra ainda é só um rascunho: ative para valer sempre.");
    await waitFor(() => expect(document.activeElement).toBe(said));
    expect(within(card()).queryAllByRole("button")).toHaveLength(0);
  });

  it("Negar…: the reason field takes the focus, Cancelar goes back to Negar…, and 'Negada.' holds it", async () => {
    const h = held();
    mount();
    btn("Negar…").focus();
    fireEvent.click(btn("Negar…"));
    const reason = screen.getByLabelText(/Motivo da negação/) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(reason);
    fireEvent.click(btn("Cancelar"));
    expect(document.activeElement).toBe(btn("Negar…"));
    fireEvent.click(btn("Negar…"));
    fireEvent.change(screen.getByLabelText(/Motivo da negação/), { target: { value: "não" } });
    btn("Confirmar negação").focus();
    fireEvent.click(btn("Confirmar negação"));
    asChromeDoes();
    await waitFor(() => expect(decisions(h.calls)).toHaveLength(1));
    h.release();
    const said = await screen.findByText("Negada.");
    await waitFor(() => expect(document.activeElement).toBe(said));
    expect(said.getAttribute("role")).toBe("status");
  });

  it("a REFUSED decision puts the focus back on the button that was used (it had dropped to the page body); the buttons stay", async () => {
    const h = held();
    mount();
    btn("Permitir uma vez").focus();
    fireEvent.click(btn("Permitir uma vez"));
    asChromeDoes();
    await waitFor(() => expect(decisions(h.calls)).toHaveLength(1));
    expect(document.activeElement).toBe(document.body);
    h.refuse();
    await screen.findByRole("alert");
    expect(document.activeElement).toBe(btn("Permitir uma vez"));
    expect(screen.queryByText("Permitida uma vez.")).toBeNull();                         // a refusal never reads as a decision
  });

  it("a refused denial goes back to the 'Confirmar negação' button with the reason still typed", async () => {
    const h = held();
    mount();
    fireEvent.click(btn("Negar…"));
    fireEvent.change(screen.getByLabelText(/Motivo da negação/), { target: { value: "não apague" } });
    btn("Confirmar negação").focus();
    fireEvent.click(btn("Confirmar negação"));
    asChromeDoes();
    await waitFor(() => expect(decisions(h.calls)).toHaveLength(1));
    h.refuse();
    await screen.findByRole("alert");
    expect(document.activeElement).toBe(btn("Confirmar negação"));
    expect((screen.getByLabelText(/Motivo da negação/) as HTMLTextAreaElement).value).toBe("não apague");
  });

  it("where the browser did not focus the button at the click (Safari), a refusal still lands the focus on a live control of the card, never the body", async () => {
    const h = held();
    mount();
    fireEvent.click(btn("Permitir uma vez"));                                            // no .focus(): the body had it
    await waitFor(() => expect(decisions(h.calls)).toHaveLength(1));
    h.refuse();
    await screen.findByRole("alert");
    expect(document.activeElement).not.toBe(document.body);
    expect(card().contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.tagName).toBe("BUTTON");
  });

  it("and the same where it worked: the confirmation line takes the focus the body had", async () => {
    const h = held();
    mount();
    fireEvent.click(btn("Permitir uma vez"));
    await waitFor(() => expect(decisions(h.calls)).toHaveLength(1));
    h.release();
    const said = await screen.findByText("Permitida uma vez.");
    await waitFor(() => expect(document.activeElement).toBe(said));                      // the effect that moves it runs a tick after the text is on screen
  });

  it("a person who has moved on keeps THEIR focus: neither the confirmation nor a refusal takes it back", async () => {
    const h = held();
    mount(<input aria-label="fora" />);
    btn("Permitir uma vez").focus();
    fireEvent.click(btn("Permitir uma vez"));
    asChromeDoes();
    await waitFor(() => expect(decisions(h.calls)).toHaveLength(1));
    (screen.getByLabelText("fora") as HTMLInputElement).focus();                         // they went to the composer while it was on its way
    h.release();
    await screen.findByText("Permitida uma vez.");
    await new Promise((r) => setTimeout(r, 40));                                         // past the tick where the confirmation would have taken it
    expect(document.activeElement).toBe(screen.getByLabelText("fora"));
    cleanup();
    const g = held();
    mount(<input aria-label="fora" />);
    btn("Permitir uma vez").focus();
    fireEvent.click(btn("Permitir uma vez"));
    asChromeDoes();
    await waitFor(() => expect(decisions(g.calls)).toHaveLength(1));
    (screen.getByLabelText("fora") as HTMLInputElement).focus();
    g.refuse();
    await screen.findByRole("alert");
    await new Promise((r) => setTimeout(r, 40));
    expect(document.activeElement).toBe(screen.getByLabelText("fora"));
  });

  it("in English the same line is 'Allowed once.'", async () => {
    setLuveLocale("en");
    try {
      const h = held();
      mount();
      fireEvent.click(btn("Allow once"));
      await waitFor(() => expect(decisions(h.calls)).toHaveLength(1));
      h.release();
      const said = await screen.findByText("Allowed once.");
      await waitFor(() => expect(document.activeElement).toBe(said));
    } finally { setLuveLocale("pt"); }
  });

  it("the focus moves in the SAME commit that puts the confirmation on screen (a layout effect): the instant the line exists in the DOM it already has the focus, never a frame on the page body", async () => {
    const h = held();
    mount();
    btn("Permitir uma vez").focus();
    fireEvent.click(btn("Permitir uma vez"));
    asChromeDoes();
    await waitFor(() => expect(decisions(h.calls)).toHaveLength(1));
    const sight = firstSight(() => [...document.querySelectorAll("[role=status]")].find((e) => e.textContent?.includes("Permitida uma vez.")) ?? null, (line) => document.activeElement === line);
    h.release();
    await screen.findByText("Permitida uma vez.");
    sight.stop();
    expect(sight.out).toEqual({ seen: true, focusAtFirstSight: "yes" });                  // a passive effect ran a tick later: the body had it
  });

  it("a REFUSED decision gives the focus back in the same commit that shows the refusal", async () => {
    const h = held();
    mount();
    btn("Permitir uma vez").focus();
    fireEvent.click(btn("Permitir uma vez"));
    asChromeDoes();
    await waitFor(() => expect(decisions(h.calls)).toHaveLength(1));
    const sight = firstSight(() => document.querySelector("[role=alert]"), () => document.activeElement === btn("Permitir uma vez"));
    h.refuse();
    await screen.findByRole("alert");
    sight.stop();
    expect(sight.out).toEqual({ seen: true, focusAtFirstSight: "yes" });
  });
});
