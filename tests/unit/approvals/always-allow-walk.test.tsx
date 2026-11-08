// tests/unit/approvals/always-allow-walk.test.tsx
// AA-2, the whole walk through the app (plugin-api v0.11 section 11): the Caixa -> "Sempre permitir…" -> the draft sentence and "Revisar e ativar" -> the Rules screen of THAT Bot on THAT draft (banner, the focus on the card's
// heading, "Ativar" untouched) -> and only a second click of the person turns the rule on, with the version they saw. Two acts, never one: the walk sends ONE write before the second click (the approval) and no PATCH at all.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { LuveBotApp } from "@/index";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";

const face = (label: string, v: string) => ({ label, role: "", color: "#60a5fa", avatar: { kind: "initials", value: v } });
const pending = {
  request_id: "req-1", bot: "vendas", surface: "gateway", mechanism: "command", source: "transport", digest: "d".repeat(64), command_redacted: "curl -X POST https://api.example.com/sync",
  description: "Sync", pattern_keys: ["curl"], allowed_choices: ["once", "deny", "always"], action_class_hash: "h", created_at: new Date(Date.now() - 60000).toISOString(),
  expires_at: new Date(Date.now() + 3600000).toISOString(), status: "pending",
};
const DRAFT = { id: "aa-1", label: "Permitir curl", level: "allow", scope: { kind: "bot", ref: "vendas" }, state: "draft", origin: "always_allow" };
const draftRule = { id: "aa-1", label: "Permitir curl", level: "allow", scope: { kind: "bot", ref: "vendas" }, match: { tools: ["terminal"], commands: ["curl -X POST https://api.example.com/sync"] }, state: "draft", origin: "always_allow", builtin: false, version: 3, exact: true, covers: "command" };

type Call = { method: string; url: string; body?: any };
let calls: Call[];
beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt"); calls = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (/\/bots$/.test(url)) return { bots: [{ name: "vendas", status: "idle", display: face("Vendas", "VE") }, { name: "dev", status: "idle", display: face("Dev", "DE") }] };
    if (method === "GET" && /\/approvals(\?|$)/.test(url)) return { ok: true, approvals: [pending], total: 1 };
    if (method === "POST" && url.includes("/resolve")) return { ok: true, approval: { request_id: "req-1", status: "decided", decided_choice: "once" }, draft_rule: DRAFT };
    if (url.endsWith("/suggestions")) return { suggestions: [] };
    if (method === "GET" && url.includes("/rules")) return { rules: [{ rule: draftRule, seal_result: { seal: "hand", mechanisms: [], problems: [], qualifiers: [] } }] };
    if (method === "PATCH") return { rule: { ...draftRule, state: "active", version: 4 }, seal_result: { seal: "hand" } };
    return {};
  });
});
afterEach(() => { cleanup(); setCustomFetchJSON(null); setLuveLocale("pt"); });

async function toTheStrip() {
  render(<LuveBotApp />);
  fireEvent.click((await screen.findAllByRole("button", { name: /Aprovações/ }))[0]);
  const card = await screen.findByTestId("approval-card-req-1");
  fireEvent.click(within(card).getByRole("button", { name: /sempre permitir…/i }));
  fireEvent.click(screen.getByRole("button", { name: /criar rascunho e permitir uma vez/i }));
  return screen.findByRole("button", { name: "Revisar e ativar" });
}

describe("the walk: Sempre permitir -> Revisar e ativar -> the Rules screen of that Bot -> Ativar", () => {
  it("the first act writes ONE thing (the approval, once, with the draft); \"Revisar e ativar\" writes nothing and lands on the draft with the banner and the focus on its heading", async () => {
    const review = await toTheStrip();
    const writes = () => calls.filter((c) => c.method !== "GET");
    expect(writes().map((c) => `${c.method} ${c.url.split("/api/plugins/luvebot")[1]}`)).toEqual(["POST /approvals/req-1/resolve"]);
    expect(writes()[0].body.choice).toBe("once");                                          // never 'always'
    fireEvent.click(review);
    const banner = await screen.findByRole("note");
    expect(banner.textContent).toBe("Esta regra nasceu de um 'Sempre permitir' que você deu. Ela só vale depois que você ativar.");
    const card = screen.getByTestId("rule-card-aa-1");
    const heading = within(card).getByRole("heading", { level: 3 });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(document.activeElement).not.toBe(within(card).getByRole("button", { name: "Ativar regra" }));
    expect(card.textContent).toContain("Cobre só este comando exato");
    expect(calls.some((c) => c.method === "GET" && /\/rules\?.*bot=vendas|\/rules.*vendas/.test(c.url))).toBe(true);   // the rules of THAT Bot
    expect(writes().map((c) => c.method)).toEqual(["POST"]);                               // no PATCH: nothing was turned on by arriving
  });

  it("only the second click turns it on, with the version that was shown, and the card then says it counts for that Bot", async () => {
    fireEvent.click(await toTheStrip());
    const card = await screen.findByTestId("rule-card-aa-1");
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    fireEvent.click(within(card).getByRole("button", { name: "Ativar regra" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ id: "aa-1", version: 3, state: "active" });
    expect(await within(card).findByText("Regra ativa: vale sempre para Vendas")).toBeTruthy();
  });

  it("the arrival is for ONE visit: leaving the screen and coming back to the Bot's rules by the profile shows no banner and moves no focus", async () => {
    fireEvent.click(await toTheStrip());
    await screen.findByRole("note");
    fireEvent.click(screen.getByRole("button", { name: /Voltar para a conversa|Back to the conversation/ }));
    await waitFor(() => expect(screen.queryByTestId("rule-card-aa-1")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Perfil" }));
    fireEvent.click(await screen.findByRole("button", { name: /Regras deste Bot/ }));
    const card = await screen.findByTestId("rule-card-aa-1");
    expect(screen.queryByRole("note")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(document.activeElement).not.toBe(within(card).getByRole("heading", { level: 3 }));
    expect(card.textContent).toContain("Cobre só este comando exato");                  // the card still tells what it covers: that part is not the arrival's
  });
});
