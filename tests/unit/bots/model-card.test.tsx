// tests/unit/bots/model-card.test.tsx (contract v0.11 §1, slice M-3)
// The "Model" card of the Bot profile: the model in use, "Trocar" (which reads what Hermes offers THIS Bot only then), and the POST with the body EXACTLY
// {provider, model, expected: {provider, model}} (+ confirm_expensive only after the person confirmed Hermes's warning). Only what the route offered can be picked, no field for a key or an
// address exists, the answer applies from the next message (open LuveBot conversations too) and says so, stale and confirm_required are said in words, and without the route (404) the card is not drawn at all.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within, configure } from "@testing-library/react";
import { ModelCard } from "@/components/bots/ModelCard";
import { BotProfile } from "@/components/bots/BotProfile";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";
import type { BotDetail, ModelOptions } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });

const OPTIONS: ModelOptions = { providers: [
  { slug: "anthropic", name: "Anthropic", current: true, models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"] },
  { slug: "openrouter", name: "OpenRouter", models: ["meta/llama-4", "mistral/large"] },
  { slug: "empty", name: "Sem modelos", models: [] },
] };
type Call = { method: string; url: string; body?: any; csrf: string | null };
let calls: Call[];
let info: any;                                        // what GET /model answers (or an Error to throw)
let options: ModelOptions | Error | Promise<ModelOptions>;
let post: (body: any) => unknown;
function backend() {
  calls = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (url.endsWith("/bots/vendas/model") && method === "GET") { if (info instanceof Error) throw info; return info; }
    if (url.endsWith("/bots/vendas/model/options") && method === "GET") { const o = await options; if (o instanceof Error) throw o; return o; }
    if (url.endsWith("/bots/vendas/model") && method === "POST") return post(JSON.parse(String(init!.body)));
    return {};
  });
}
const posts = () => calls.filter((c) => c.method === "POST");
const optionReads = () => calls.filter((c) => c.url.endsWith("/model/options"));
const err = (code: string, status: number, details?: object) => new ApiError({ code, message: "English for developers.", status, ...(details ? { details } : {}) });
const open = async () => { render(<ModelCard bot="vendas" />); await screen.findByTestId("model-current"); };
const pick = async () => { fireEvent.click(screen.getByRole("button", { name: "Trocar" })); await screen.findByLabelText("Novo provedor"); };
const provider = () => screen.getByLabelText("Novo provedor") as HTMLSelectElement;
const modelBox = () => screen.getByLabelText("Novo modelo") as HTMLSelectElement;
const apply = () => screen.getByRole("button", { name: "Aplicar" }) as HTMLButtonElement;

beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt");
  info = { provider: "anthropic", model: "claude-sonnet-5-5", context_length: 200000 };
  options = OPTIONS;
  post = (b) => ({ provider: b.provider, model: b.model, applies: "next_message", stale_aux: [] });
  backend();
});
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });

describe("the card", () => {
  it("says what is in use, with the context, and offers 'Trocar'; nothing is asked of Hermes' options until then", async () => {
    await open();
    expect(screen.getByTestId("model-current").textContent).toBe("Em uso: anthropic · claude-sonnet-5-5");
    expect(screen.getByText(/Contexto: 200.000 tokens|Contexto: 200,000 tokens/)).toBeTruthy();
    expect(screen.getByText(/Vale a partir da próxima mensagem, também nas conversas do LuveBot que já estão abertas/)).toBeTruthy();
    expect(optionReads()).toEqual([]);                                                          // lazy: the build can block for seconds
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("no model set: says so, and the card still offers 'Trocar'", async () => {
    info = { provider: null, model: null, context_length: null };
    await open();
    expect(screen.getByTestId("model-current").textContent).toBe("Nenhum modelo definido neste Bot.");
    expect(screen.queryByText(/Contexto:/)).toBeNull();
    expect(screen.getByRole("button", { name: "Trocar" })).toBeTruthy();
  });

  it("the provider and the model are TEXT: a name that looks like markup stays characters", async () => {
    info = { provider: "<img src=x onerror=alert(1)>", model: "**m**", context_length: null };
    const { container } = render(<ModelCard bot="vendas" />);
    expect((await screen.findByTestId("model-current")).textContent).toBe("Em uso: <img src=x onerror=alert(1)> · **m**");
    expect(container.querySelector("img, strong, b")).toBeNull();
  });
});

describe("without the route: the card is NOT drawn, no error", () => {
  it.each([
    ["404 plugin_route_missing (a backend without M-1)", new ApiError({ code: "plugin_route_missing", message: "x", status: 404 })],
    ["capability_missing (Hermes lacks the model handlers)", err("capability_missing", 409)],
  ])("%s: only the fallback shows, nothing red", async (_n, failure) => {
    info = failure;
    render(<ModelCard bot="vendas" fallback={<p>só leitura de antes</p>} />);
    expect(await screen.findByText("só leitura de antes")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Modelo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Trocar" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an answer that is not the contract's (no provider/model keys) is treated the same: not drawn", async () => {
    info = { something: "else" };
    render(<ModelCard bot="vendas" fallback={<p>só leitura de antes</p>} />);
    expect(await screen.findByText("só leitura de antes")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Trocar" })).toBeNull();
  });

  it("in the profile's Modelo tab: the card when the route exists, the old read-only content when it does not", async () => {
    const detail = { name: "vendas", is_default: false, display: { label: "Vendas", role: "B2B", call_me: "Lucas", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } }, description: "", model: { provider: "openrouter", name: "claude-sonnet-5-5" }, status: "idle", soul: "", toolsets: [], mcp_servers: [] } as BotDetail;
    render(<BotProfile botName="vendas" initialBot={detail} />);
    fireEvent.click(screen.getByText("3. Modelo"));
    expect(await screen.findByTestId("model-current")).toBeTruthy();
    expect(screen.queryByText(/será disponibilizada em fase futura/)).toBeNull();
    cleanup();
    info = new ApiError({ code: "plugin_route_missing", message: "x", status: 404 });
    render(<BotProfile botName="vendas" initialBot={detail} />);
    fireEvent.click(screen.getByText("3. Modelo"));
    expect(await screen.findByText(/será disponibilizada em fase futura/)).toBeTruthy();
    expect(screen.queryByTestId("model-current")).toBeNull();
  });
});

describe("the picker", () => {
  it("opens with a spinner, lists ONLY what the route offered (provider and its models), and preselects what is in use", async () => {
    let release!: (o: ModelOptions) => void;
    options = new Promise((r) => { release = r; });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Trocar" }));
    expect((await screen.findByRole("status")).textContent).toContain("Lendo os modelos que o Hermes oferece…");
    expect(screen.queryByLabelText("Novo provedor")).toBeNull();
    release(OPTIONS);
    await screen.findByLabelText("Novo provedor");
    expect([...provider().options].map((o) => o.textContent)).toEqual(["Anthropic", "OpenRouter", "Sem modelos"]);
    expect(provider().value).toBe("anthropic");
    expect([...modelBox().options].map((o) => o.value)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]);
    expect(modelBox().value).toBe("claude-sonnet-5-5");
    expect(optionReads()).toHaveLength(1);
    expect(screen.getByText("Só aparece o que o Hermes oferece para este Bot. Endereço e chave não se trocam aqui.")).toBeTruthy();
  });

  it("a slow read says it can take a few seconds (calm, no error)", async () => {
    let release!: (o: ModelOptions) => void;
    options = new Promise((r) => { release = r; });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Trocar" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Isto pode levar alguns segundos."), { timeout: 6000 });
    expect(screen.queryByRole("alert")).toBeNull();
    release(OPTIONS);
  });

  it("there is NO field for a key or an address anywhere on the card: only two lists and buttons", async () => {
    await open();
    await pick();
    expect(document.querySelectorAll("input")).toHaveLength(0);
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
    expect(document.querySelectorAll("select")).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/api[_ -]?key|base[_ -]?url|endpoint|http/i);
  });

  it("choosing another provider shows ITS models; 'Aplicar' stays off until the choice differs from what is in use; a provider with no models cannot be applied", async () => {
    await open();
    await pick();
    expect(apply().disabled).toBe(true);                                                         // the same as in use
    fireEvent.change(provider(), { target: { value: "openrouter" } });
    expect([...modelBox().options].map((o) => o.value)).toEqual(["meta/llama-4", "mistral/large"]);
    expect(modelBox().value).toBe("meta/llama-4");
    expect(apply().disabled).toBe(false);
    fireEvent.change(provider(), { target: { value: "empty" } });
    expect(screen.getByText("Este provedor não oferece modelos agora.")).toBeTruthy();
    expect(apply().disabled).toBe(true);
    fireEvent.change(provider(), { target: { value: "anthropic" } });
    expect(modelBox().value).toBe("claude-sonnet-5-5");                                          // back to what is in use
    expect(apply().disabled).toBe(true);
  });

  it("a read that fails says so in words (not the backend's English), and 'Tentar de novo' asks again", async () => {
    options = err("hermes_unreachable", 503);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Trocar" }));
    expect((await screen.findByRole("alert")).textContent).toContain(translations.pt.errHermesUnreachable);
    expect(screen.queryByLabelText("Novo provedor")).toBeNull();
    options = OPTIONS;
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await screen.findByLabelText("Novo provedor");
    expect(optionReads()).toHaveLength(2);
  });

  it("'Cancelar' closes the picker and writes nothing", async () => {
    await open();
    await pick();
    fireEvent.change(provider(), { target: { value: "openrouter" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByLabelText("Novo provedor")).toBeNull();
    expect(posts()).toEqual([]);
  });
});

describe("applying", () => {
  it("POSTs EXACTLY {provider, model, expected: {provider, model}} to THIS Bot with the CSRF header: no scope, profile, key or address; no confirm_expensive", async () => {
    await open();
    await pick();
    fireEvent.change(provider(), { target: { value: "openrouter" } });
    fireEvent.change(modelBox(), { target: { value: "mistral/large" } });
    fireEvent.click(apply());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toBe("/api/plugins/luvebot/bots/vendas/model");
    expect(posts()[0].body).toEqual({ provider: "openrouter", model: "mistral/large", expected: { provider: "anthropic", model: "claude-sonnet-5-5" } });
    expect(Object.keys(posts()[0].body).sort()).toEqual(["expected", "model", "provider"]);
    expect(Object.keys(posts()[0].body.expected).sort()).toEqual(["model", "provider"]);
    expect(posts()[0].csrf).toBe("csrf-1");
  });

  it("the `expected` is what the person SAW, also when none was set (nulls, not invented values)", async () => {
    info = { provider: null, model: null, context_length: null };
    await open();
    await pick();
    fireEvent.click(apply());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body.expected).toEqual({ provider: null, model: null });
  });

  it("success: says it applies from the next message, open LuveBot conversations too, shows the new model, closes the picker, and sends nothing else", async () => {
    await open();
    await pick();
    fireEvent.change(provider(), { target: { value: "openrouter" } });
    fireEvent.click(apply());
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Vale a partir da próxima mensagem, também nas conversas do LuveBot que já estão abertas.");
    expect(screen.getByTestId("model-current").textContent).toBe("Em uso: openrouter · meta/llama-4");
    expect(screen.queryByLabelText("Novo provedor")).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it("success with helper slots still on the previous provider: one calm line names them (plain text)", async () => {
    post = (b) => ({ provider: b.provider, model: b.model, applies: "next_message", stale_aux: ["vision", "<b>web</b>"] });
    await open();
    await pick();
    fireEvent.change(provider(), { target: { value: "openrouter" } });
    fireEvent.click(apply());
    expect((await screen.findByRole("status")).textContent).toContain("As tarefas auxiliares (vision, <b>web</b>) ainda usam o provedor anterior; troque no Hermes.");
    expect(document.querySelector("b")).toBeNull();
  });

  it("while it applies the button is busy and cannot be pressed twice", async () => {
    let release!: () => void;
    post = (b) => new Promise((r) => { release = () => r({ provider: b.provider, model: b.model, applies: "next_message", stale_aux: [] }); });
    await open();
    await pick();
    fireEvent.change(provider(), { target: { value: "openrouter" } });
    fireEvent.click(apply());
    const busy = await screen.findByRole("button", { name: "Aplicando…" });
    fireEvent.click(busy);
    expect(posts()).toHaveLength(1);
    release();
    await screen.findByRole("status");
  });
});

describe("refusals, in words", () => {
  const WARN = "Este modelo custa US$ 75 por milhão de tokens.\n<script>alert(1)</script> **cuidado** [link](javascript:alert(1))";
  it("409 confirm_required: Hermes's warning shows as a quoted PLAIN line, nothing is sent again until the person says so, and 'Cancelar' sends nothing", async () => {
    post = () => { throw err("confirm_required", 409, { warning: WARN }); };
    await open();
    await pick();
    fireEvent.change(provider(), { target: { value: "anthropic" } });
    fireEvent.change(modelBox(), { target: { value: "claude-opus-5-5" } });
    fireEvent.click(apply());
    const quote = await screen.findByTestId("model-warning");
    expect(quote.textContent).toBe(WARN);                                                        // text: no element, no link
    expect(quote.querySelector("script, a, strong")).toBeNull();
    expect(screen.getByText("O Hermes avisou:")).toBeTruthy();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body.confirm_expensive).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByTestId("model-warning")).toBeNull();
    expect(posts()).toHaveLength(1);                                                             // never retried on its own
  });

  it("confirming sends the SAME choice again with confirm_expensive: true, and then it is applied", async () => {
    let first = true;
    post = (b) => { if (first) { first = false; throw err("confirm_required", 409, { warning: "caro" }); } return { provider: b.provider, model: b.model, applies: "next_message", stale_aux: [] }; };
    await open();
    await pick();
    fireEvent.change(modelBox(), { target: { value: "claude-opus-5-5" } });
    fireEvent.click(apply());
    fireEvent.click(await screen.findByRole("button", { name: "Trocar mesmo assim" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].body).toEqual({ provider: "anthropic", model: "claude-opus-5-5", expected: { provider: "anthropic", model: "claude-sonnet-5-5" }, confirm_expensive: true });
    expect((await screen.findByRole("status")).textContent).toContain("Vale a partir da próxima mensagem");   // the status line: the opening text carries the same sentence
  });

  it("a confirm_required with no warning text still asks (the quote is just absent)", async () => {
    post = () => { throw err("confirm_required", 409); };
    await open();
    await pick();
    fireEvent.change(modelBox(), { target: { value: "claude-opus-5-5" } });
    fireEvent.click(apply());
    expect(await screen.findByRole("button", { name: "Trocar mesmo assim" })).toBeTruthy();
    expect(screen.queryByTestId("model-warning")).toBeNull();
  });

  it("409 stale: 'the model changed since you opened this', nothing applied, and 'Recarregar' reads the model and the list again", async () => {
    post = () => { throw err("stale", 409); };
    await open();
    await pick();
    fireEvent.change(provider(), { target: { value: "openrouter" } });
    fireEvent.click(apply());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("O modelo mudou desde que você abriu isto. Recarregue.");
    expect(alert.textContent).not.toContain("English for developers");
    info = { provider: "openrouter", model: "mistral/large", context_length: null };
    post = (b) => ({ provider: b.provider, model: b.model, applies: "next_message", stale_aux: [] });
    fireEvent.click(within(alert).getByRole("button", { name: "Recarregar" }));
    await waitFor(() => expect(screen.getByTestId("model-current").textContent).toBe("Em uso: openrouter · mistral/large"));
    await screen.findByLabelText("Novo provedor");
    expect(optionReads()).toHaveLength(2);
    fireEvent.change(modelBox(), { target: { value: "meta/llama-4" } });
    fireEvent.click(apply());
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].body.expected).toEqual({ provider: "openrouter", model: "mistral/large" });   // the new expectation, not the old one
  });

  it.each([
    ["provider_not_supported", 422, "Troque este provedor no Hermes: ele precisa de endereço, chave ou outros ajustes."],
    ["hermes_restart_required", 503, "O Hermes foi atualizado no disco; reinicie o painel antes."],
    ["model_not_offered", 422, "Este modelo já não está na lista do Hermes. Recarregue a lista."],
  ])("%s: %s, in our words, the code behind 'Detalhe técnico'", async (code, status, sentence) => {
    post = () => { throw err(code, status); };
    await open();
    await pick();
    fireEvent.change(provider(), { target: { value: "openrouter" } });
    fireEvent.click(apply());
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join(" ")).toContain(sentence);
    expect(document.body.textContent).not.toContain("English for developers");
    fireEvent.click(within(alerts.find((a) => a.textContent!.includes(sentence))!).getByRole("button", { name: "Detalhe técnico" }));
    expect(screen.getByText(code).tagName).toBe("CODE");
  });

  it("a key locked by an administrator or an outage of Hermes's configuration use the general sentences, not 'Hermes unreachable'", async () => {
    for (const [code, status, general] of [["config_key_locked", 409, translations.pt.errConfigLocked], ["config_backend_unavailable", 503, translations.pt.errConfigUnavailable]] as const) {
      cleanup(); backend();
      post = () => { throw err(code, status); };
      await open();
      await pick();
      fireEvent.change(provider(), { target: { value: "openrouter" } });
      fireEvent.click(apply());
      expect((await screen.findByRole("alert")).textContent).toContain(general);
      expect(document.body.textContent).not.toContain(translations.pt.errHermesUnreachable);
    }
  });
});

describe("in English, and one Bot at a time", () => {
  it("English texts for the card, the picker and the success", async () => {
    setLuveLocale("en");
    await open();
    expect(screen.getByTestId("model-current").textContent).toBe("In use: anthropic · claude-sonnet-5-5");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await screen.findByLabelText("New provider");
    fireEvent.change(screen.getByLabelText("New provider"), { target: { value: "openrouter" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect((await screen.findByRole("status")).textContent).toContain("Valid from your next message, in LuveBot conversations that are already open too.");
  });

  it("a Bot that is not the one on screen any more: its card is reset, and a late answer is discarded", async () => {
    let late!: (v: unknown) => void;
    const slow = new Promise((r) => { late = r; });
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.endsWith("/bots/vendas/model")) return slow;
      if (url.endsWith("/bots/dev/model")) return { provider: "openai", model: "gpt-x", context_length: null };
      return {};
    });
    const r = render(<ModelCard bot="vendas" />);
    r.rerender(<ModelCard bot="dev" />);
    expect((await screen.findByTestId("model-current")).textContent).toBe("Em uso: openai · gpt-x");
    late({ provider: "anthropic", model: "old", context_length: null });
    await new Promise((res) => setTimeout(res, 50));
    expect(screen.getByTestId("model-current").textContent).toBe("Em uso: openai · gpt-x");        // vendas answered late: not shown under dev
  });
});

describe("M-6: the texts say what the Forja measured, and the withdrawn sentence is in neither language", () => {
  const SAVED = { pt: "Vale a partir da próxima mensagem, também nas conversas do LuveBot que já estão abertas.", en: "Valid from your next message, in LuveBot conversations that are already open too." };
  it("both texts of the card carry the exact sentence, and none says an open conversation keeps the previous model", () => {
    for (const l of ["pt", "en"] as const) {
      expect(translations[l].mdlSaved).toBe(SAVED[l]);
      expect(translations[l].mdlIntro).toContain(SAVED[l]);
      for (const k of ["mdlIntro", "mdlSaved"] as const) expect(translations[l][k]).not.toMatch(/próximas conversas|continuam com|keep the previous|next conversations|new conversations/i);
    }
  });
  it("the sentence is limited to LuveBot's conversations: a channel conversation was not measured, so the card promises nothing about it", () => {
    for (const l of ["pt", "en"] as const) expect(translations[l].mdlSaved).toMatch(/LuveBot/);
  });
  it("the card says it, closed, before anything is done (PT and EN)", async () => {
    for (const l of ["pt", "en"] as const) {
      cleanup();
      setLuveLocale(l);
      await open();
      expect(screen.getByText(new RegExp(SAVED[l].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeTruthy();
    }
  });
});
