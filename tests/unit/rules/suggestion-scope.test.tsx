// tests/unit/rules/suggestion-scope.test.tsx
// Red team 29/10 M2 (screen side): a suggestion for an action with no command used to read "you allowed the same action N times" and "Criar regra" opened
// `allow write_file` for EVERY file, saying nothing. Now the server says `whole_tool` and the screen says it in words (on the card and in the editor), and the
// editor taken from a suggestion carries the draft's CONDITIONS too, not only tools and commands (and says when it could not carry them all).
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RulesView } from "@/components/rules";
import { editorCondition } from "@/components/rules/RuleConditions";
import { resetCsrfToken, setCachedCsrf, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Bot, Rule, RuleSuggestion } from "@/api/types";

const bot = (name: string, label: string): Bot => ({ name, is_default: false, description: "", model: { provider: "x", name: "y" }, status: "idle",
  display: { label, role: "", color: "#3b82f6", avatar: { kind: "mascot", value: "luvi" } } } as Bot);
const BOTS = [bot("vendas", "Vendas"), bot("suporte", "Suporte")];
const HASH = "a".repeat(64);
const preview = (match: Record<string, unknown>, over: Partial<Rule> = {}): Rule => ({ id: "sg-preview", label: "vendas: permitir write_file", level: "allow", scope: { kind: "bot", ref: "vendas" },
  match, state: "draft", origin: "always_allow", builtin: false, version: 1, ...over } as unknown as Rule);
const suggestion = (over: Partial<RuleSuggestion> = {}): RuleSuggestion => ({ kind: "rule", bot: "vendas", action_class: HASH, count: 3, action: { tool: "write_file", command: null },
  whole_tool: true, draft_preview: preview({ tools: ["write_file"] }), ...over });
const key = (s: RuleSuggestion) => `${s.bot}:${s.action_class}`;

let list: RuleSuggestion[], posts: Array<{ url: string; body: any }>;
beforeEach(() => {
  cleanup(); setLuveLocale("pt"); resetCsrfToken(); setCachedCsrf("csrf-s"); posts = []; list = [suggestion()];
  setCustomFetchJSON(async (url, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (url.endsWith("/suggestions") && method === "GET") return { suggestions: list };
    if (url.endsWith("/rules") && method === "POST") { posts.push({ url, body }); return { rule: { ...list[0].draft_preview, id: "novo", state: "draft", origin: "human" }, seal_result: { seal: "none" } }; }
    if (url.includes("/rules")) return { rules: [] };
    return {};
  });
});
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });
const view = () => render(<RulesView bots={BOTS} authMode="gated" initialRules={[]} />);
const create = async () => fireEvent.click(await screen.findByTestId(`btn-suggestion-create-${key(list[0])}`));
const kind = () => screen.getByLabelText("Condição (opcional)") as HTMLSelectElement;
const valueField = () => screen.getByLabelText("Caminho da condição") as HTMLInputElement;

describe("a rule for the whole tool says so", () => {
  it("the card and the editor both say 'toda vez que o Bot usar write_file'; an action with a command does not", async () => {
    view();
    const card = await screen.findByTestId(`suggestion-${key(list[0])}`);
    expect(screen.getByTestId(`suggestion-whole-${key(list[0])}`).textContent).toBe("Atenção: a regra libera write_file TODA vez que o Bot usar, não só este caso.");
    expect(card.textContent).toContain("Nada vale até você ativar.");
    await create();
    expect(screen.getByTestId("suggestion-draft-whole").textContent).toContain("write_file TODA vez");
    cleanup();
    list = [suggestion({ whole_tool: false, action: { tool: "terminal", command: "git status" }, draft_preview: preview({ tools: ["terminal"], commands: ["git status"] }) })];
    view();
    await screen.findByTestId(`suggestion-${key(list[0])}`);
    expect(screen.queryByTestId(`suggestion-whole-${key(list[0])}`)).toBeNull();
    await create();
    expect(screen.queryByTestId("suggestion-draft-whole")).toBeNull();
  });

  it("with no draft to create there is no promise to warn about; an older server (no field) says nothing extra", async () => {
    list = [suggestion({ draft_preview: null })];
    view();
    await screen.findByTestId(`suggestion-${key(list[0])}`);
    expect(screen.queryByTestId(`suggestion-whole-${key(list[0])}`)).toBeNull();
    cleanup();
    const { whole_tool: _drop, ...older } = suggestion();
    list = [older as RuleSuggestion];
    view();
    await screen.findByTestId(`suggestion-${key(list[0])}`);
    expect(screen.queryByTestId(`suggestion-whole-${key(list[0])}`)).toBeNull();
  });

  it("in English", async () => {
    setLuveLocale("en");
    view();
    await screen.findByTestId(`suggestion-${key(list[0])}`);
    expect(screen.getByTestId(`suggestion-whole-${key(list[0])}`).textContent).toBe("Careful: the rule allows write_file EVERY time the Bot uses it, not only this case.");
  });
});

describe("the editor from a suggestion carries the draft's conditions", () => {
  it("a path condition fills the kind and the value, and saving sends it (the rule is no wider than the draft)", async () => {
    list = [suggestion({ whole_tool: false, draft_preview: preview({ tools: ["write_file"], conditions: [{ fact: "path", op: "under", value: "workspace:pages" }] }) })];
    view(); await create();
    expect(kind().value).toBe("under");
    expect(valueField().value).toBe("workspace:pages");
    fireEvent.click(screen.getByRole("button", { name: /Criar rascunho/i }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.match.conditions).toEqual([{ fact: "path", op: "under", value: "workspace:pages" }]);
    expect(posts[0].body).toMatchObject({ state: "draft", match: { tools: ["write_file"] } });
  });

  it("a recipient condition too (and the allow towards it carries the warning)", async () => {
    list = [suggestion({ whole_tool: false, action: { tool: "kanban_create", command: null }, draft_preview: preview({ tools: ["kanban_create"], conditions: [{ fact: "recipient", op: "eq", value: "all" }] }) })];
    view(); await create();
    expect(kind().value).toBe("recipient");
    expect(valueField().value).toBe("all");
    expect(screen.getByTestId("recipient-warning").getAttribute("data-scope")).toBe("all");
  });

  it("the older object shape ({fact: value}) is read as equality; no condition leaves the fields empty", async () => {
    expect(editorCondition({ match: { tools: ["write_file"], conditions: { path: "workspace:pages/a.md" } } as never })).toEqual({ kind: "eq", value: "workspace:pages/a.md", left: 0 });
    expect(editorCondition({ match: { tools: ["x"] } as never })).toEqual({ kind: "", value: "", left: 0 });
    list = [suggestion({ whole_tool: false, draft_preview: preview({ tools: ["write_file"] }) })];
    view(); await create();
    expect(kind().value).toBe("");
  });

  it("more conditions than the editor holds, or one it does not know: the first it can show is carried and the rest is SAID, never dropped in silence", async () => {
    expect(editorCondition({ match: { conditions: [{ fact: "path", op: "glob", value: "a/**" }, { fact: "recipient", op: "eq", value: "local" }] } as never })).toEqual({ kind: "glob", value: "a/**", left: 1 });
    expect(editorCondition({ match: { conditions: [{ fact: "branch", op: "eq", value: "main" }] } as never })).toEqual({ kind: "", value: "", left: 1 });
    list = [suggestion({ whole_tool: false, draft_preview: preview({ tools: ["write_file"], conditions: [{ fact: "path", op: "glob", value: "a/**" }, { fact: "recipient", op: "eq", value: "local" }] }) })];
    view(); await create();
    expect(kind().value).toBe("glob");
    expect(screen.getByTestId("suggestion-draft-left").textContent).toBe("Esta sugestão tem 1 condição a mais do que o editor mostra. Confira antes de criar.");
  });

  it("what a suggestion filled in does not leak into the next editor", async () => {
    list = [suggestion({ whole_tool: false, draft_preview: preview({ tools: ["write_file"], conditions: [{ fact: "path", op: "under", value: "workspace:pages" }] }) })];
    view(); await create();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Nova regra/ })[0]);
    expect(kind().value).toBe("");
    expect(screen.queryByTestId("suggestion-draft-left")).toBeNull();
    expect(screen.queryByTestId("suggestion-draft-whole")).toBeNull();
  });
});
