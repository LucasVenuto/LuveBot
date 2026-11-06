// tests/unit/rules/conditions.test.tsx
// Condições no editor de regras (docs/contracts/rules-conditions-v0.md, 22a caminho e 22b destinatário): the editor sends
// `match.conditions = [{fact, op, value}]` (path: under | glob | eq; recipient: eq) with the tools whose adapter reads the fact; the
// backend's refusals (422) are said in words INSIDE the editor; the rule's card shows the condition, what the seal does NOT see
// (qualifiers from the SealResult only) and a hook too old in words; an allow towards a Bot carries its warning; the simulator takes
// the two facts and says it ran without the real turn.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RulesView } from "@/components/rules";
import { conditionFor, conditionsOf, toolsFor } from "@/components/rules/RuleConditions";
import { ApiError, resetCsrfToken, setCachedCsrf, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Bot, Rule, RuleWithSeal } from "@/api/types";

const bot = (name: string, label: string): Bot => ({
  name, is_default: false, description: "", model: { provider: "x", name: "y" }, status: "idle",
  display: { label, role: "", color: "#3b82f6", avatar: { kind: "mascot", value: "luvi" } },
} as Bot);
const BOTS = [bot("vendas", "Vendas"), bot("suporte", "Suporte")];

const rule = (id: string, over: Partial<Rule> = {}): Rule => ({
  id, label: `Regra ${id}`, level: "ask", scope: { kind: "bot", ref: "vendas" }, match: { tools: ["write_file"] }, state: "draft", origin: "human", builtin: false, version: 1, ...over,
} as Rule);
const withSeal = (r: Rule, seal: Partial<RuleWithSeal["seal_result"]> = {}): RuleWithSeal => ({ rule: r, seal_result: { seal: "hand", mechanisms: [], problems: [], qualifiers: [], ...seal } });

let calls: { url: string; method: string; body?: any }[], refuse: ApiError | null, simulation: any;
const err422 = (code: string) => new ApiError({ code, message: code, status: 422 } as never);

beforeEach(() => {
  cleanup(); setLuveLocale("pt"); resetCsrfToken(); setCachedCsrf("csrf-c");
  calls = []; refuse = null; simulation = { decision: { effect: "ask", winner: null, hits: [], reason: "default" }, caveats: [] };
  setCustomFetchJSON(async (url, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith("/suggestions")) return { suggestions: [] };
    if (url.endsWith("/rules/simulate")) return simulation;
    if (url.endsWith("/rules") && method === "POST") { if (refuse) throw refuse; return { rule: rule("novo", { label: body.label, match: body.match }), seal_result: { seal: "hand" } }; }
    return { rules: [] };
  });
});
afterEach(() => cleanup());

const view = (initialRules: RuleWithSeal[] = []) => render(<RulesView bots={BOTS} authMode="gated" initialRules={initialRules} />);
const openEditor = () => fireEvent.click(screen.getAllByRole("button", { name: /Nova regra/ })[0]);
const kind = () => screen.getByLabelText("Condição (opcional)") as HTMLSelectElement;
const tools = () => screen.getByLabelText("Ferramentas", { exact: false }) as HTMLInputElement;
const posts = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/rules"));
const save = (label = "Regra nova") => {
  fireEvent.change(screen.getByLabelText(/Nome \/ Rótulo da regra/), { target: { value: label } });
  fireEvent.click(screen.getByRole("button", { name: /Criar rascunho/ }));
};

describe("o campo de condição no editor", () => {
  it("offers no condition, three ways to name a file, and a recipient", () => {
    view(); openEditor();
    expect([...kind().options].map((o) => o.textContent)).toEqual(["Sem condição", "Arquivo dentro de", "Arquivo que combina com", "Arquivo exatamente", "Destinatário é"]);
    expect(screen.queryByTestId("condition-scope")).toBeNull();                     // nothing more until one is chosen
  });

  it("a file condition offers write_file and patch when the tools are empty, says it only covers them, and never overwrites tools already typed", () => {
    view(); openEditor();
    fireEvent.change(kind(), { target: { value: "under" } });
    expect(tools().value).toBe("write_file, patch");
    expect(screen.getByLabelText("Caminho da condição").getAttribute("placeholder")).toBe("workspace:pages");
    expect(screen.getByTestId("condition-scope").textContent).toContain("Só vale para as ferramentas de arquivo do Hermes (write_file e patch)");
    cleanup(); view(); openEditor();
    fireEvent.change(tools(), { target: { value: "patch" } });
    fireEvent.change(kind(), { target: { value: "glob" } });
    expect(tools().value).toBe("patch");
  });

  it("a recipient offers kanban_create and cronjob_manage, the words and every Bot as options, and says what it does not see", () => {
    view(); openEditor();
    fireEvent.change(kind(), { target: { value: "recipient" } });
    expect(tools().value).toBe("kanban_create, cronjob_manage");
    expect([...document.querySelectorAll("#new-rule-recipients option")].map((o) => (o as HTMLOptionElement).value)).toEqual(["origin", "local", "all", "bot:vendas", "bot:suporte"]);
    expect(screen.getByTestId("condition-scope").textContent).toContain("Só vale para kanban_create e cronjob_manage");
    expect(screen.getByTestId("condition-scope").textContent).toContain("notificador do Kanban");
  });

  it.each([
    ["under", "workspace:pages", { fact: "path", op: "under", value: "workspace:pages" }, "write_file, patch"],
    ["glob", "workspace:pages/**", { fact: "path", op: "glob", value: "workspace:pages/**" }, "write_file, patch"],
    ["eq", "workspace:pages/a.md", { fact: "path", op: "eq", value: "workspace:pages/a.md" }, "write_file, patch"],
    ["recipient", "bot:suporte", { fact: "recipient", op: "eq", value: "bot:suporte" }, "kanban_create, cronjob_manage"],
  ] as const)("saving a %s condition sends it as {fact, op, value} with its tools, as a DRAFT", async (k, value, expected, toolText) => {
    view(); openEditor();
    fireEvent.change(kind(), { target: { value: k } });
    fireEvent.change(screen.getByLabelText("Caminho da condição"), { target: { value } });
    save();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body.match.conditions).toEqual([expected]);
    expect(posts()[0].body.match.tools).toEqual(toolText.split(", "));
    expect(posts()[0].body.state).toBe("draft");
  });

  it("no condition, or a kind with no value, sends no `conditions` at all", async () => {
    view(); openEditor();
    fireEvent.change(tools(), { target: { value: "send_email" } });
    save();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body.match).not.toHaveProperty("conditions");
    cleanup(); calls = [];
    view(); openEditor();
    fireEvent.change(kind(), { target: { value: "under" } });
    save();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body.match).not.toHaveProperty("conditions");
  });

  it("warns that an allow towards a Bot makes that Bot receive what this one writes, and only then", () => {
    view(); openEditor();
    fireEvent.change(screen.getByLabelText(/Nível de Autonomia/), { target: { value: "allow" } });
    fireEvent.change(kind(), { target: { value: "recipient" } });
    fireEvent.change(screen.getByLabelText("Caminho da condição"), { target: { value: "bot:suporte" } });
    expect(screen.getByTestId("recipient-warning").textContent).toBe("Permitir assim faz o Bot Suporte passar a receber o que este Bot escrever. As regras do Bot Suporte continuam valendo para o que ele fizer.");
    fireEvent.change(screen.getByLabelText("Caminho da condição"), { target: { value: "local" } });
    expect(screen.queryByTestId("recipient-warning")).toBeNull();
    fireEvent.change(screen.getByLabelText("Caminho da condição"), { target: { value: "bot:suporte" } });
    fireEvent.change(screen.getByLabelText(/Nível de Autonomia/), { target: { value: "ask" } });
    expect(screen.queryByTestId("recipient-warning")).toBeNull();
  });
});

describe("as recusas do backend, em palavras, dentro do editor", () => {
  it.each([
    ["path_condition_needs_file_tools", "Uma condição de arquivo só funciona com as ferramentas write_file e patch"],
    ["bad_path_condition", "O caminho não vale: comece com workspace:"],
    ["condition_needs_adapter_tools", "Uma condição de destinatário só funciona com kanban_create e cronjob_manage"],
    ["bad_recipient_condition", "O destinatário da condição não vale: use bot:<perfil>"],
  ])("%s", async (code, words) => {
    refuse = err422(code);
    view(); openEditor();
    fireEvent.change(kind(), { target: { value: "under" } });
    fireEvent.change(screen.getByLabelText("Caminho da condição"), { target: { value: "x" } });
    save();
    const alert = await screen.findByTestId("create-rule-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain(words);
    expect(screen.getByRole("dialog")).toBeDefined();                                 // the editor stays open, with what was typed
    expect(tools().value).toBe("write_file, patch");
  });

  it("the sentence goes when the editor closes", async () => {
    refuse = err422("bad_path_condition");
    view(); openEditor();
    fireEvent.change(kind(), { target: { value: "under" } });
    fireEvent.change(screen.getByLabelText("Caminho da condição"), { target: { value: "x" } });
    save();
    await screen.findByTestId("create-rule-error");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    openEditor();
    expect(screen.queryByTestId("create-rule-error")).toBeNull();
  });
});

describe("a regra com condição na lista", () => {
  it("shows its conditions in words, the new API list and the older object alike", () => {
    view([
      withSeal(rule("a", { match: { tools: ["write_file"], conditions: [{ fact: "path", op: "under", value: "workspace:pages" }] } })),
      withSeal(rule("b", { match: { tools: ["kanban_create"], conditions: [{ fact: "recipient", op: "eq", value: "bot:suporte" }] } })),
      withSeal(rule("c", { match: { tools: ["patch"], conditions: { path: "workspace:pages/a.md" } } })),
      withSeal(rule("d", { match: { tools: ["patch"], conditions: { sensibilidade: "alta" } } })),
    ]);
    expect(screen.getByTestId("rule-condition-a-0").textContent).toBe("Arquivo dentro deworkspace:pages");
    expect(screen.getByTestId("rule-condition-b-0").textContent).toBe("Destinatário ébot:suporte");
    expect(screen.getByTestId("rule-condition-c-0").textContent).toBe("Arquivo exatamenteworkspace:pages/a.md");   // the older object: an equality
    expect(screen.getByTestId("rule-condition-d-0").textContent).toBe("sensibilidadealta");                            // a fact the screen has no words for keeps its name
  });

  it("says what the seal does not see, from the qualifiers only, and nothing without them", () => {
    view([withSeal(rule("a"), { qualifiers: ["paths_file_tools_only"] })]);
    expect(screen.getByTestId("seal-paths-caveat").textContent).toContain("Só vale para as ferramentas de arquivo do Hermes.");
    expect(screen.getByTestId("seal-paths-caveat").textContent).toContain("pelo terminal, por execute_code ou por um servidor MCP");
    expect(screen.queryByTestId("seal-adapters-caveat")).toBeNull();
    cleanup();
    view([withSeal(rule("b", { match: { tools: ["kanban_create"] } }), { qualifiers: ["conditions_adapter_tools_only"] })]);
    expect(screen.getByTestId("seal-adapters-caveat").textContent).toContain("Só vale para as ferramentas que o LuveBot lê.");
    expect(screen.queryByTestId("seal-paths-caveat")).toBeNull();
    cleanup();
    view([withSeal(rule("c"), { qualifiers: [] })]);
    expect(screen.queryByTestId("seal-paths-caveat")).toBeNull();
    expect(screen.queryByTestId("seal-adapters-caveat")).toBeNull();
  });

  it("a hook too old reads in words (the code stays beside it); another problem keeps the backend's own detail", () => {
    view([withSeal(rule("a"), {
      seal: "broken", qualifiers: ["paths_file_tools_only"],
      problems: [{ code: "hook_outdated", detail: "the hook is older than 0.6.0" }, { code: "toolset_still_enabled", detail: "Toolset ainda habilitado no perfil vendas" }],
    })]);
    const box = screen.getByTestId("rule-problems-a");
    expect(box.textContent).toContain("hook_outdated");
    expect(box.textContent).toContain("O hook do Hermes está desatualizado (ou sem versão): ele não envia os caminhos dos arquivos");
    expect(box.textContent).not.toContain("the hook is older than 0.6.0");
    expect(box.textContent).toContain("Toolset ainda habilitado no perfil vendas");
  });

  it("an allow towards a Bot carries the warning on the card; an ask does not", () => {
    view([withSeal(rule("a", { level: "allow", match: { tools: ["kanban_create"], conditions: [{ fact: "recipient", op: "eq", value: "bot:suporte" }] } }))]);
    expect(screen.getByTestId("recipient-warning").textContent).toContain("Bot Suporte passar a receber");
    cleanup();
    view([withSeal(rule("b", { level: "ask", match: { tools: ["kanban_create"], conditions: [{ fact: "recipient", op: "eq", value: "bot:suporte" }] } }))]);
    expect(screen.queryByTestId("recipient-warning")).toBeNull();
  });

  it("conditionsOf, conditionFor and toolsFor", () => {
    expect(conditionsOf({ match: { conditions: { path: "abs:/x" } } as never })).toEqual([{ fact: "path", op: "eq", value: "abs:/x" }]);
    expect(conditionsOf({ match: { tools: ["a"] } as never })).toEqual([]);
    expect(conditionFor("", "x")).toBeNull();
    expect(conditionFor("glob", "  ")).toBeNull();
    expect(conditionFor("recipient", " local ")).toEqual({ fact: "recipient", op: "eq", value: "local" });
    expect(toolsFor("recipient")).toEqual(["kanban_create", "cronjob_manage"]);
    expect(toolsFor("under")).toEqual(["write_file", "patch"]);
    expect(toolsFor("")).toEqual([]);
  });
});

describe("o simulador com os dois fatos", () => {
  const openSimulator = () => { view(); fireEvent.click(screen.getByRole("tab", { name: /simulador/i })); };
  const simulate = async () => {
    fireEvent.change(screen.getByLabelText(/nome da ferramenta/i), { target: { value: "write_file" } });
    fireEvent.click(screen.getByRole("button", { name: /simular ação/i }));
    await screen.findByTestId("simulation-result");
    return calls.find((c) => c.url.endsWith("/rules/simulate"))!;
  };

  it("sends the path and the recipient as facts, and nothing when they are empty", async () => {
    openSimulator();
    fireEvent.change(screen.getByLabelText("Arquivo (opcional)"), { target: { value: "workspace:pages/a.md" } });
    fireEvent.change(screen.getByLabelText("Destinatário (opcional)"), { target: { value: "bot:suporte" } });
    expect((await simulate()).body.facts).toEqual({ path: "workspace:pages/a.md", recipient: "bot:suporte" });
    cleanup(); calls = [];
    openSimulator();
    expect((await simulate()).body).not.toHaveProperty("facts");
  });

  it("says it ran without the real turn when the backend says so, for each fact, and says nothing otherwise", async () => {
    simulation = { ...simulation, caveats: ["paths_lexical", "recipients_lexical"] };
    openSimulator();
    await simulate();
    expect(screen.getByTestId("sim-paths-lexical").textContent).toBe("Simulado sem a pasta do turno: o caminho vale como você escreveu.");
    expect(screen.getByTestId("sim-recipients-lexical").textContent).toBe("Simulado sem a chamada real: o destinatário vale como você escreveu.");
    cleanup();
    simulation = { ...simulation, caveats: [] };
    openSimulator();
    await simulate();
    expect(screen.queryByTestId("sim-paths-lexical")).toBeNull();
    expect(screen.queryByTestId("sim-recipients-lexical")).toBeNull();
  });
});

describe("English", () => {
  it("speaks English", () => {
    setLuveLocale("en");
    view(); fireEvent.click(screen.getAllByRole("button", { name: /New rule/ })[0]);
    const select = screen.getByLabelText("Condition (optional)") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["No condition", "File inside", "File matching", "File exactly", "Recipient is"]);
    fireEvent.change(select, { target: { value: "recipient" } });
    expect(screen.getByTestId("condition-scope").textContent).toContain("It only applies to kanban_create and cronjob_manage");
  });
});
