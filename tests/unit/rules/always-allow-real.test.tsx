// tests/unit/rules/always-allow-real.test.tsx
// AA-2 against the REAL API (AA-1 and AA-1b, plugin-api v0.11 section 11, A-286): the rules in fixtures/rules-always-allow-real.json are what `draft_from_always_allow` and `rules_store.api_dict` say (the engine's `exact`, its `covers`, the API shape of
// `match`: toolsets, mcp_servers, conditions as a list; tests/unit/backend/test_rules_screen_fixture.py keeps the file equal to the API), and here the Rules screen draws them: the sentence of what the draft covers comes from `covers` and from nothing
// else: a command ("only this exact command"), a command edited with a `*` ("MORE"), a tool with no command and no condition ("every call of web_search") and a file ("only calls of write_file that match the conditions"); take `covers`
// away (an older server) and the neutral sentence stands, which is true of every rule.
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RulesView } from "@/components/rules";
import { resetCsrfToken, setCachedCsrf, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Bot, Rule, RuleWithSeal } from "@/api/types";

const REAL: Record<string, any> = JSON.parse(fs.readFileSync(path.resolve(__dirname, "fixtures/rules-always-allow-real.json"), "utf8"));
const BOTS = [{ name: "vendas", is_default: false, description: "", model: { provider: "x", name: "y" }, status: "idle", display: { label: "Vendas", role: "", color: "#3b82f6", avatar: { kind: "mascot", value: "luvi" } } } as Bot];
const seal = { seal: "hand", mechanisms: [], problems: [], qualifiers: [] } as RuleWithSeal["seal_result"];
const real = (name: string): RuleWithSeal => ({ rule: JSON.parse(JSON.stringify(REAL[name])) as Rule, seal_result: seal });
const EXACT_PT = "Cobre só este comando exato (e este arquivo, se houver), no Bot Vendas, toda vez que for pedido. Não cobre variações.";
const MORE_PT = "Cobre MAIS do que você aprovou: qualquer comando que combine com o padrão abaixo.";
const TOOL_PT = "Cobre toda chamada de web_search, com qualquer argumento, no Bot Vendas, toda vez que for pedido. Não cobre outras ferramentas.";
const FACTS_PT = "Cobre só chamadas de write_file que combinem exatamente com as condições abaixo (arquivo ou destinatário), no Bot Vendas, toda vez que for pedido. Não cobre variações.";
const NEUTRAL_PT = "Vale exatamente o padrão abaixo, no Bot Vendas, toda vez que for pedido.";
const SENTENCES = [EXACT_PT, MORE_PT, TOOL_PT, FACTS_PT, NEUTRAL_PT];

let patched: any[];
beforeEach(() => {
  cleanup(); setLuveLocale("pt"); resetCsrfToken(); setCachedCsrf("csrf-c"); patched = [];
  setCustomFetchJSON(async (url, init) => {
    if (url.endsWith("/suggestions")) return { suggestions: [] };
    if (init?.method === "PATCH") { const body = JSON.parse(String(init.body)); patched.push(body); return { rule: { ...REAL.exact, state: "active", version: body.version + 1 }, seal_result: seal }; }
    return { rules: [] };
  });
});
afterEach(() => { cleanup(); setCustomFetchJSON(null); setLuveLocale("pt"); });

const arrive = (name: string) => render(<RulesView botName="vendas" bots={BOTS} authMode="gated" initialRules={[real(name)]} openDraft={REAL[name].id} />);
const card = (name: string) => screen.getByTestId(`rule-card-${REAL[name].id}`);

describe("the fixture is what the file says", () => {
  it("four real rules: the draft of a command, the same edited with a wildcard, the draft of a tool with no command and the draft of a file, each with the `covers` of the contract", () => {
    expect(REAL.exact).toMatchObject({ state: "draft", origin: "always_allow", exact: true, covers: "command", scope: { kind: "bot", ref: "vendas" }, version: 1 });
    expect(REAL.wider).toMatchObject({ exact: false, covers: "wider", match: { commands: ["curl *"] } });
    expect(REAL.whole_tool).toMatchObject({ exact: true, covers: "tool", match: { tools: ["web_search"], commands: [], conditions: [] } });
    expect(REAL.file).toMatchObject({ exact: true, covers: "facts", match: { tools: ["write_file"], commands: [] } });
    expect(REAL.file.match.conditions).toHaveLength(1);
    for (const name of ["exact", "wider", "whole_tool", "file"]) expect(Object.keys(REAL[name].match).sort()).toEqual(["commands", "conditions", "mcp_servers", "tools", "toolsets"]);
  });
  it("`exact` stays a boolean on every rule: a screen that tests it must never meet a string", () => {
    for (const name of ["exact", "wider", "whole_tool", "file"]) expect(typeof REAL[name].exact).toBe("boolean");
  });
});

describe("the Rules screen draws the real rules", () => {
  const says = (name: string, sentence: string) => {
    expect(within(card(name)).getByText(sentence)).toBeTruthy();
    for (const other of SENTENCES.filter((x) => x !== sentence)) expect(within(card(name)).queryByText(other)).toBeNull();
  };
  it("the command draft: the banner, the focus on the heading, the pattern the ENGINE stored (case-folded), and the sentence of an exact command", async () => {
    arrive("exact");
    expect(screen.getByRole("note").textContent).toContain("Esta regra nasceu de um 'Sempre permitir'");
    await waitFor(() => expect(document.activeElement).toBe(within(card("exact")).getByRole("heading", { level: 3 })));
    says("exact", EXACT_PT);
    expect(within(card("exact")).getByText(REAL.exact.match.commands[0])).toBeTruthy();         // what the server stored, not what the card said
    expect(patched).toHaveLength(0);
  });
  it("the same draft edited with a wildcard: it covers MORE", () => { arrive("wider"); says("wider", MORE_PT); });
  it("a tool with no command and no condition: every call of the tool, any argument, no other tool", () => { arrive("whole_tool"); says("whole_tool", TOOL_PT); });
  it("a file: only the calls of the tool that match the file exactly", () => {
    arrive("file");
    says("file", FACTS_PT);
    expect(within(card("file")).getByText(/workspace:notas\/a\.md/)).toBeTruthy();                  // the condition the sentence points at is on the card, drawn by the strict helper
  });
  it("take `covers` away (an older server): the neutral sentence, for every one of the four", () => {
    for (const name of ["exact", "wider", "whole_tool", "file"]) {
      cleanup();
      const old = real(name); delete (old.rule as { covers?: string }).covers;
      render(<RulesView botName="vendas" bots={BOTS} authMode="gated" initialRules={[old]} openDraft={REAL[name].id} />);
      says(name, NEUTRAL_PT);
    }
  });
  it("the activation of the real command draft sends the version it came with (the real one) and nothing else", async () => {
    arrive("exact");
    fireEvent.click(screen.getByRole("button", { name: "Ativar regra" }));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toEqual({ id: "aa-1", version: 1, state: "active" });
  });
  it("in English", () => {
    setLuveLocale("en");
    arrive("whole_tool");
    expect(within(card("whole_tool")).getByText("Covers every call of web_search, with any arguments, for the Bot Vendas, every time it is asked. It does not cover other tools.")).toBeTruthy();
    cleanup();
    arrive("file");
    expect(within(card("file")).getByText("Covers only calls of write_file that match the conditions below exactly (file or recipient), for the Bot Vendas, every time it is asked. It does not cover variations.")).toBeTruthy();
  });
});
