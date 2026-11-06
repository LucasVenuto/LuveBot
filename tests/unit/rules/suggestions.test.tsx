// tests/unit/rules/suggestions.test.tsx
// Sugestões de regra na tela (contract v0.8 §5; spec 4.10 "Bots podem propor regras, mas só você aprova"): the backend lists, from OUR
// approvals, the actions a person allowed "uma vez" 3 or more times in 7 days. "Criar regra" opens the editor prefilled from the DRAFT
// preview and saves a DRAFT (never active: invariant 6); "Ignorar" hides it for 30 days; the command is only ever text.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RulesView } from "@/components/rules";
import { ApiError, resetCsrfToken, setCachedCsrf, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Bot, Rule, RuleSuggestion } from "@/api/types";

const bot = (name: string, label: string): Bot => ({
  name, is_default: false, description: "", model: { provider: "x", name: "y" }, status: "idle",
  display: { label, role: "", color: "#3b82f6", avatar: { kind: "mascot", value: "luvi" } },
} as Bot);
const BOTS = [bot("vendas", "Vendas"), bot("suporte", "Suporte")];
const HASH = "a".repeat(64), HASH2 = "b".repeat(64);

const preview = (over: Partial<Rule> = {}): Rule => ({
  id: "sg-preview", label: "vendas: permitir terminal", level: "allow", scope: { kind: "bot", ref: "vendas" },
  match: { tools: ["terminal"], commands: ["git status"] }, state: "draft", origin: "always_allow", builtin: false, version: 1, ...over,
} as Rule);
const suggestion = (over: Partial<RuleSuggestion> = {}): RuleSuggestion => ({
  kind: "rule", bot: "vendas", action_class: HASH, count: 4, action: { tool: "terminal", command: "git status" }, draft_preview: preview(), ...over,
});

let calls: { url: string; method: string; body?: any; csrf?: string | null }[], list: RuleSuggestion[], failGet: boolean, failDismiss: boolean;

beforeEach(() => {
  cleanup(); setLuveLocale("pt"); resetCsrfToken(); setCachedCsrf("csrf-s");
  calls = []; list = [suggestion()]; failGet = false; failDismiss = false;
  setCustomFetchJSON(async (url, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/suggestions") && method === "GET") { if (failGet) throw new ApiError({ code: "hermes_unreachable", message: "x", status: 502 } as never); return { suggestions: list }; }
    if (url.endsWith("/suggestions/dismiss")) { if (failDismiss) throw new ApiError({ code: "hermes_unreachable", message: "x", status: 502 } as never); return { until: 1 }; }
    if (url.endsWith("/rules") && method === "POST") return { rule: { ...preview(), id: "novo", label: body.label, state: "draft", origin: "human" }, seal_result: { seal: "none" } };
    if (url.includes("/rules")) return { rules: [] };
    return {};
  });
});
afterEach(() => cleanup());

const view = (props: Partial<React.ComponentProps<typeof RulesView>> = {}) => render(<RulesView bots={BOTS} authMode="gated" initialRules={[]} {...props} />);
const key = (s: RuleSuggestion) => `${s.bot}:${s.action_class}`;
const only = (method: string, suffix: string) => calls.filter((c) => c.method === method && c.url.endsWith(suffix));

describe("a lista de sugestões", () => {
  it("says what was allowed and how many times, with the action as text, and that nothing counts until activated", async () => {
    view();
    const card = await screen.findByTestId(`suggestion-${key(list[0])}`);
    expect(card.textContent).toContain("Nos últimos 7 dias você permitiu 4 vezes, uma a uma, a mesma ação de Vendas.");
    expect(screen.getByTestId(`suggestion-action-${key(list[0])}`).textContent).toBe("terminal: git status");
    expect(card.textContent).toContain("Nada vale até você ativar.");
    expect(screen.getByRole("heading", { name: "Sugestões de regra" })).toBeDefined();
  });

  it("a command with markup is text, never an element", async () => {
    list = [suggestion({ action: { tool: "terminal", command: '<img src=x onerror="alert(1)">' } })];
    view();
    const line = await screen.findByTestId(`suggestion-action-${key(list[0])}`);
    expect(line.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(line.querySelector("img")).toBeNull();
  });

  it("shows nothing when there is none, or when the read fails: the rules are never blocked by it", async () => {
    list = [];
    view();
    await waitFor(() => expect(only("GET", "/suggestions")).toHaveLength(1));
    expect(screen.queryByTestId("rule-suggestions")).toBeNull();
    cleanup(); failGet = true; list = [suggestion()];
    view();
    await waitFor(() => expect(only("GET", "/suggestions")).toHaveLength(2));
    expect(screen.queryByTestId("rule-suggestions")).toBeNull();
    expect(screen.getByRole("heading", { name: /Regras/ })).toBeDefined();
  });

  it("a Bot's own page lists only that Bot's suggestions", async () => {
    list = [suggestion(), suggestion({ bot: "suporte", action_class: HASH2 })];
    view({ botName: "vendas" });
    await screen.findByTestId(`suggestion-${key(list[0])}`);
    expect(screen.queryByTestId(`suggestion-${key(list[1])}`)).toBeNull();
  });

  it("an action that cannot become a rule offers only 'Ignorar', and says why", async () => {
    list = [suggestion({ draft_preview: null })];
    view();
    const card = await screen.findByTestId(`suggestion-${key(list[0])}`);
    expect(card.textContent).toContain("não pode virar regra");
    expect(screen.queryByTestId(`btn-suggestion-create-${key(list[0])}`)).toBeNull();
    expect(screen.getByTestId(`btn-suggestion-ignore-${key(list[0])}`)).toBeDefined();
  });
});

describe("Criar regra", () => {
  it("opens the editor prefilled from the draft preview and says it goes in as a draft; nothing is saved by opening it", async () => {
    view();
    fireEvent.click(await screen.findByTestId(`btn-suggestion-create-${key(list[0])}`));
    expect((screen.getByLabelText(/Nome da regra|Rótulo|Label/i) as HTMLInputElement).value).toBe("vendas: permitir terminal");
    expect((screen.getByLabelText("Ferramentas", { exact: false }) as HTMLInputElement).value).toBe("terminal");
    expect((screen.getByLabelText("Comandos", { exact: false }) as HTMLInputElement).value).toBe("git status");
    expect(screen.getByTestId("suggestion-draft-note").textContent).toContain("Vai como rascunho: só vale depois que você ativar.");
    expect(only("POST", "/rules")).toHaveLength(0);
  });

  it("saving makes a DRAFT with the preview's level, scope and match, never active; the suggestion is gone and nothing is activated", async () => {
    view();
    fireEvent.click(await screen.findByTestId(`btn-suggestion-create-${key(list[0])}`));
    fireEvent.click(screen.getByRole("button", { name: /Criar rascunho/i }));
    await waitFor(() => expect(only("POST", "/rules")).toHaveLength(1));
    const sent = only("POST", "/rules")[0];
    expect(sent.body).toMatchObject({ level: "allow", state: "draft", scope: { kind: "bot", ref: "vendas" }, match: { tools: ["terminal"], commands: ["git status"] } });
    expect(sent.csrf).toBe("csrf-s");
    await waitFor(() => expect(screen.queryByTestId(`suggestion-${key(list[0])}`)).toBeNull());
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);        // no activation, ever, from here
    expect(only("POST", "/suggestions/dismiss")).toHaveLength(0);
  });

  it("closing the editor without saving changes nothing and the suggestion stays", async () => {
    view();
    fireEvent.click(await screen.findByTestId(`btn-suggestion-create-${key(list[0])}`));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(only("POST", "/rules")).toHaveLength(0);
    expect(screen.getByTestId(`suggestion-${key(list[0])}`)).toBeDefined();
  });

  it("'Nova regra' after a suggestion opens a plain editor, without the suggestion's note", async () => {
    view();
    fireEvent.click(await screen.findByTestId(`btn-suggestion-create-${key(list[0])}`));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Nova regra/ })[0]);
    expect(screen.queryByTestId("suggestion-draft-note")).toBeNull();
    expect((screen.getByLabelText(/Nome da regra|Rótulo|Label/i) as HTMLInputElement).value).toBe("");     // nor its prefilled fields
    expect((screen.getByLabelText("Ferramentas", { exact: false }) as HTMLInputElement).value).toBe("");
  });
});

describe("Ignorar", () => {
  it("hides it with CSRF (the backend keeps it hidden for 30 days) and takes the card off", async () => {
    view();
    fireEvent.click(await screen.findByTestId(`btn-suggestion-ignore-${key(list[0])}`));
    await waitFor(() => expect(screen.queryByTestId(`suggestion-${key(list[0])}`)).toBeNull());
    const sent = only("POST", "/suggestions/dismiss")[0];
    expect(sent.body).toEqual({ bot: "vendas", action_class: HASH });
    expect(sent.csrf).toBe("csrf-s");
  });

  it("a failure says so in words and the card stays", async () => {
    failDismiss = true;
    view();
    fireEvent.click(await screen.findByTestId(`btn-suggestion-ignore-${key(list[0])}`));
    expect((await screen.findByRole("alert")).textContent).not.toBe("");
    expect(screen.getByTestId(`suggestion-${key(list[0])}`)).toBeDefined();
  });
});

describe("English", () => {
  it("speaks English", async () => {
    setLuveLocale("en");
    view();
    const card = await screen.findByTestId(`suggestion-${key(list[0])}`);
    expect(within(card).getByRole("button", { name: "Create rule" })).toBeDefined();
    expect(card.textContent).toContain("In the last 7 days you allowed the same action of Vendas 4 times, one at a time.");
  });
});
