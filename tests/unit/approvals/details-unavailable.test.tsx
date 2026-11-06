// tests/unit/approvals/details-unavailable.test.tsx
// Contract v0.9 §1.9 (hook 0.8.0): on a canonical Hermes a request from a hook BEFORE 0.8.0 names only Hermes's placeholder, never the call, so the backend marks it
// `details_unavailable`. The card says so in words and offers ONLY "Negar" (a denial runs nothing; the server refuses every approve) plus "Atualizar o hook deste Bot";
// the placeholder is never shown as if it were the command; a batch may deny it but never approve it; the Perguntar rules whose seal says `hook_outdated` carry the same
// update button (for the Bot the seal is about). The same card in the Caixa, in Hoje and in the conversation (they share ApprovalDecision).
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within, configure } from "@testing-library/react";
import { ApprovalsInbox } from "@/components/approvals";
import { ApprovalDecision, InlineApproval } from "@/components/chat/InlineApproval";
import { RulesView } from "@/components/rules";
import { batchItems, approvalErrorText, isBlind } from "@/components/approvals/decide";
import { approvalTitle } from "@/components/approvals/humanize";
import { needsYou } from "@/components/home/derive";
import { setCustomFetchJSON, resetCsrfToken, setCachedCsrf, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Approval, Bot, Rule, RuleWithSeal } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });

const bots: Bot[] = [{ name: "vendas", is_default: false, description: "", model: { provider: "p", name: "m" }, status: "waiting_approval",
  display: { label: "Vendas", role: "B2B", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } } }];
const PLACEHOLDER = "<terminal> (plugin approval rule)";
const now = Date.now();
const blind = (over: Partial<Approval> = {}): Approval => ({
  request_id: "req-blind", bot: "vendas", source: "run", surface: "run", mechanism: "hook_approve", tool: "terminal", rule_id: "regra-1", run_id: "run-1",
  digest: "b".repeat(64), command_redacted: PLACEHOLDER, description: "luvebot:ask:regra-1", allowed_choices: ["once", "deny"], action_class_hash: "h-same",
  status: "pending", details_unavailable: true,
  created_at: new Date(now - 30_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString(), ...over,
});
const readable = (over: Partial<Approval> = {}): Approval => ({
  request_id: "req-ok", bot: "vendas", source: "run", surface: "run", mechanism: "hook_approve", tool: "terminal", rule_id: "regra-1", run_id: "run-2",
  digest: "c".repeat(64), command_redacted: "curl https://x.test/", description: "buscar", allowed_choices: ["once", "deny"], action_class_hash: "h-same",
  status: "pending", details_unavailable: false,
  created_at: new Date(now - 20_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString(), ...over,
});

type Call = { method: string; url: string; body?: any; csrf: string | null };
function backend(list: Approval[]) {
  const calls: Call[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "tester", auth_mode: "gated" };
    if (method === "POST" && url.endsWith("/hook/install")) return { hook: { status: "live", version: "0.8.0" }, changed: true, gateway_reloaded: true, restart_required: false };
    if (method === "POST" && url.endsWith("/approvals/batch")) return { approvals: [], failed: [] };
    if (method === "POST") return { ok: true, reason_delivered: true };
    if (method === "GET" && url.includes("/approvals")) return { ok: true, approvals: list, total: list.length };
    if (url.includes("/rules")) return { rules: [] };
    return {};
  });
  return calls;
}
const decisions = (calls: Call[]) => calls.filter((c) => c.method === "POST" && !c.url.endsWith("/hook/install"));
const installs = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.url.endsWith("/hook/install"));
const btn = (el: HTMLElement, name: string | RegExp) => within(el).queryByRole("button", { name });

beforeEach(() => { cleanup(); setLuveLocale("pt"); resetCsrfToken(); });
afterEach(() => { setCustomFetchJSON(null); });

describe("o cartão na Caixa", () => {
  it("says in words that it cannot read the request; the placeholder is not shown as the command; only Negar and the update are offered", async () => {
    backend([blind()]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const c = await screen.findByTestId("approval-card-req-blind");
    expect(within(c).getByText("Um pedido que o LuveBot não consegue ler")).toBeTruthy();
    expect(within(c).getByTestId("approval-blind").textContent).toMatch(/hook deste Bot é antigo e não diz o que ele quer fazer.*não deixa aprovar no escuro.*negar não executa nada/);
    expect(within(c).queryByTestId("approval-command")).toBeNull();                          // Hermes's placeholder is not the call
    expect(btn(c, "Permitir uma vez")).toBeNull();
    expect(btn(c, "Sempre permitir…")).toBeNull();
    expect(btn(c, "Negar…")).toBeTruthy();
    expect(btn(c, "Atualizar o hook deste Bot")).toBeTruthy();
  });

  it("a request that can be read keeps all its buttons (and no note)", async () => {
    backend([readable()]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const c = await screen.findByTestId("approval-card-req-ok");
    expect(btn(c, "Permitir uma vez")).toBeTruthy();
    expect(btn(c, "Sempre permitir…")).toBeTruthy();
    expect(within(c).queryByTestId("approval-blind")).toBeNull();
    expect(btn(c, "Atualizar o hook deste Bot")).toBeNull();
  });

  it("Negar works: the reason goes with the deny and nothing but a deny is ever sent", async () => {
    const calls = backend([blind()]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const c = await screen.findByTestId("approval-card-req-blind");
    fireEvent.click(btn(c, "Negar…")!);
    const modal = screen.getByRole("dialog");
    fireEvent.change(within(modal).getByLabelText(/motivo da negação/i), { target: { value: "Hook antigo: não sei o que é." } });
    fireEvent.click(within(modal).getByRole("button", { name: /confirmar negação/i }));
    await waitFor(() => expect(decisions(calls)).toHaveLength(1));
    expect(decisions(calls)[0].body).toMatchObject({ choice: "deny", reason: "Hook antigo: não sei o que é." });
    expect(decisions(calls).filter((d) => d.body?.choice !== "deny")).toHaveLength(0);
  });

  it("'Atualizar o hook deste Bot' installs on a click only (no body, CSRF) and decides nothing", async () => {
    const calls = backend([blind()]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const c = await screen.findByTestId("approval-card-req-blind");
    expect(installs(calls)).toHaveLength(0);                                                 // nothing on its own
    fireEvent.click(btn(c, "Atualizar o hook deste Bot")!);
    expect(await within(c).findByText("Hook atualizado.")).toBeTruthy();
    expect(installs(calls)).toHaveLength(1);
    expect(installs(calls)[0]).toMatchObject({ url: "/api/plugins/luvebot/bots/vendas/hook/install", body: undefined, csrf: "csrf-1" });
    expect(decisions(calls)).toHaveLength(0);
  });
});

describe("em lote", () => {
  it("a selection with a blind request can be denied but not approved (the button says why)", async () => {
    backend([blind(), readable()]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    await screen.findByTestId("approval-card-req-blind");
    fireEvent.click(within(screen.getByTestId("approval-card-req-blind")).getByRole("checkbox"));
    fireEvent.click(within(screen.getByTestId("approval-card-req-ok")).getByRole("checkbox"));
    expect((screen.getByRole("button", { name: "Permitir selecionados (uma vez)" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Negar selecionados" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("batch-blind").textContent).toBe("Na seleção há pedidos sem detalhes: eles só podem ser negados.");
  });

  it("without the blind one the approve is open again", async () => {
    backend([blind(), readable()]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    await screen.findByTestId("approval-card-req-ok");
    fireEvent.click(within(screen.getByTestId("approval-card-req-ok")).getByRole("checkbox"));
    expect((screen.getByRole("button", { name: "Permitir selecionados (uma vez)" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("batch-blind")).toBeNull();
  });

  it("batchItems: a blind request goes out only as a deny", () => {
    expect(batchItems([blind(), readable()], "once", "")).toBeNull();
    expect(batchItems([blind(), readable()], "deny", "motivo")?.map((i) => i.choice)).toEqual(["deny", "deny"]);
    expect(batchItems([readable()], "once", "")).toHaveLength(1);
  });
});

describe("as palavras", () => {
  it("the server's 409 details_unavailable is said as itself, not as 'someone else decided'", () => {
    const t = (k: string) => k;
    const refused = new ApiError({ code: "details_unavailable", message: "LuveBot could not tie this request", status: 409 } as never);
    expect(approvalErrorText(refused, t as never)).toBe("errorDetailsUnavailable");
    expect(approvalErrorText(new ApiError({ code: "stale", message: "x", status: 409 } as never), t as never)).toBe("errorStaleConflict");
  });

  it("the title and the Hoje line never carry the placeholder", () => {
    expect(approvalTitle(blind(), () => undefined, ((k: string) => k) as never)).toBe("approvalBlindTitle");
    expect(needsYou([blind()])[0].detail).toBeUndefined();
    expect(needsYou([readable()])[0].detail).toBe("curl https://x.test/");
    expect(isBlind(blind())).toBe(true);
    expect(isBlind({})).toBe(false);                                                         // an older backend does not say: as it always was
  });
});

describe("o mesmo cartão em Hoje e na conversa", () => {
  const decision = (over: object = {}) => ({ requestId: "req-blind", digest: "b".repeat(64), choices: ["once", "deny"], command: PLACEHOLDER, description: "luvebot:ask:regra-1", detailsUnavailable: true, ...over });

  it("ApprovalDecision (Hoje, bare): no approve, no Sempre permitir, Negar and the note", () => {
    backend([]);
    render(<ApprovalDecision bare bot="vendas" pending request={decision()} resolve={async () => ({})} />);
    expect(screen.queryByRole("button", { name: "Permitir uma vez" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sempre permitir…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Negar…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Atualizar o hook deste Bot" })).toBeTruthy();
    expect(screen.getByTestId("approval-blind")).toBeTruthy();
  });

  it("ApprovalDecision (full card): the placeholder is not previewed; the title is the plain one", () => {
    backend([]);
    render(<ApprovalDecision bot="vendas" pending request={decision({ commandRedacted: PLACEHOLDER })} resolve={async () => ({})} />);
    expect(screen.getByText("Um pedido que o LuveBot não consegue ler")).toBeTruthy();
    expect(screen.queryByText(PLACEHOLDER)).toBeNull();
  });

  it("ApprovalDecision: a request the backend could read keeps Aprovar and Sempre permitir", () => {
    backend([]);
    render(<ApprovalDecision bot="vendas" pending request={decision({ detailsUnavailable: false })} resolve={async () => ({})} />);
    expect(screen.getByRole("button", { name: "Permitir uma vez" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sempre permitir…" })).toBeTruthy();
    expect(screen.queryByTestId("approval-blind")).toBeNull();
  });

  it("in the conversation: once the stored request says details_unavailable, only Negar is left; denying sends a deny", async () => {
    const calls = backend([blind()]);
    const frame = { request_id: "req-blind", command: PLACEHOLDER, description: "luvebot:ask:regra-1", choices: ["once", "deny"], luvebot_digest: "b".repeat(64) };
    render(<InlineApproval frame={frame} bot="vendas" runId="run-1" pending />);
    await waitFor(() => expect(screen.getByTestId("approval-blind")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Permitir uma vez" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sempre permitir…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Negar…" }));
    fireEvent.change(screen.getByLabelText(/motivo da negação/i), { target: { value: "sem detalhes" } });
    fireEvent.click(screen.getByRole("button", { name: /confirmar negação/i }));
    await waitFor(() => expect(decisions(calls)).toHaveLength(1));
    expect(decisions(calls)[0].body).toMatchObject({ request_id: "req-blind", choice: "deny", reason: "sem detalhes" });
  });
});

describe("o selo hook_outdated das regras Perguntar", () => {
  const rule = (id: string, scope: Rule["scope"]): Rule => ({ id, label: `Regra ${id}`, level: "ask", scope, match: { tools: ["terminal"] }, state: "active", origin: "human", builtin: false, version: 1 } as Rule);
  const outdated = (r: Rule): RuleWithSeal => ({ rule: r, seal_result: { seal: "broken", mechanisms: [], qualifiers: [],
    problems: [{ code: "hook_outdated", detail: "the hook is older than 0.8.0 (or its version is unknown): on this Hermes its requests would not say what they want to do" }] } });

  it("a rule of one Bot says it in words and offers 'Atualizar o hook deste Bot' for THAT Bot; the click installs, then the seal is read again", async () => {
    const r = rule("a", { kind: "bot", ref: "vendas" });
    let updated = false;
    const calls = backend([]);
    const inner = setCustomFetchJSON as unknown as (f: unknown) => void;
    inner(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "tester", auth_mode: "gated" };
      if (method === "POST" && url.endsWith("/hook/install")) { updated = true; return { hook: { status: "live", version: "0.8.0" }, changed: true, gateway_reloaded: true, restart_required: false }; }
      if (url.includes("/rules")) return { rules: [updated ? { rule: r, seal_result: { seal: "hand", mechanisms: [], problems: [], qualifiers: [] } } : outdated(r)] };
      return {};
    });
    render(<RulesView bots={bots} authMode="gated" initialRules={[outdated(r)]} />);
    const box = screen.getByTestId("rule-problems-a");
    expect(box.textContent).toContain("hook_outdated");
    expect(box.textContent).toContain("um pedido de Perguntar chega sem detalhes: só dá para negar");
    expect(box.textContent).not.toContain("the hook is older than 0.8.0");                    // the words, not the English detail
    fireEvent.click(within(box).getByRole("button", { name: "Atualizar o hook deste Bot" }));
    await waitFor(() => expect(screen.queryByTestId("rule-problems-a")).toBeNull());          // the seal is read again: it no longer says hook_outdated
    expect(installs(calls)).toHaveLength(1);
    expect(installs(calls)[0]).toMatchObject({ url: "/api/plugins/luvebot/bots/vendas/hook/install", csrf: "csrf-1" });
  });

  it("a rule of EVERY Bot (an aggregate seal, no single Bot) offers no button: it would update the wrong hook", () => {
    backend([]);
    render(<RulesView bots={bots} authMode="gated" initialRules={[outdated(rule("g", { kind: "global" }))]} />);
    const box = screen.getByTestId("rule-problems-g");
    expect(box.textContent).toContain("hook_outdated");
    expect(within(box).queryByRole("button", { name: "Atualizar o hook deste Bot" })).toBeNull();
  });

  it("on a Bot's own Rules page the button is for that Bot, even for a global rule", () => {
    backend([]);
    render(<RulesView bots={bots} botName="vendas" authMode="gated" initialRules={[outdated(rule("g", { kind: "global" }))]} />);
    expect(within(screen.getByTestId("rule-problems-g")).getByRole("button", { name: "Atualizar o hook deste Bot" })).toBeTruthy();
  });

  it("no hook_outdated, no button", () => {
    backend([]);
    render(<RulesView bots={bots} authMode="gated" initialRules={[{ rule: rule("a", { kind: "bot", ref: "vendas" }), seal_result: { seal: "hand", mechanisms: [], problems: [], qualifiers: [] } }]} />);
    expect(screen.queryByRole("button", { name: "Atualizar o hook deste Bot" })).toBeNull();
  });
});
