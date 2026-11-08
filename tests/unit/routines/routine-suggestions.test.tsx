// tests/unit/routines/routine-suggestions.test.tsx
// "Sugestão do Hermes" (contract v0.10 §2.2, slice P2-4), against the contract with mocks (the backend is P2-1/P2-2): one card per suggestion
// in Routines and Today; "Criar pausada" and "Criar e iniciar" go to POST .../accept with {start} and CSRF; a person without a login gets one
// line instead of the create buttons and keeps "Dispensar"; a suggestion LuveBot does not create says why and sends the person to Hermes;
// empty, a named error, a missing capability, a partial read and "already accepted" are each their own state. Everything text is text.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RoutineSuggestions } from "@/components/routines/RoutineSuggestions";
import { RoutinesView } from "@/components/routines";
import { Hoje } from "@/components/Hoje";
import { ApiError, resetCsrfToken, setCachedCsrf, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import REAL from "./fixtures/routine-suggestions-backend.json";
import type { Bot, RoutineSuggestion } from "@/api/types";

const bot = (name: string, label: string): Bot => ({
  name, is_default: false, description: "", model: { provider: "x", name: "y" }, status: "idle",
  display: { label, role: "", color: "#3b82f6", avatar: { kind: "mascot", value: "luvi" } },
} as Bot);
const BOTS = [bot("vendas", "Vendas"), bot("suporte", "Suporte")];
const ID = "a1b2c3d4e5f6", ID2 = "0123456789ab";
const sug = (over: Partial<RoutineSuggestion> = {}): RoutineSuggestion => ({
  bot: "vendas", id: ID, title: "Resumo da manhã", description: "Todo dia útil, junta o que aconteceu e manda para você.", source: "catalog",
  created_at: "2026-10-30T09:00:00Z", supported: true,
  spec: { name: "Resumo da manhã", schedule: "0 8 * * 1-5", prompt: "Leia as conversas de ontem e resuma em 5 linhas.", skills: ["resumo", "agenda"] },
  ...over,
});
const err = (code: string, status = 409) => new ApiError({ code, message: code, status } as never);

let calls: { url: string; method: string; body?: any; csrf?: string | null }[];
let list: RoutineSuggestion[], partial: string[], auth: string, getFails: ApiError | null, acceptFails: ApiError | null, dismissFails: ApiError | null, acceptReply: any;

beforeEach(() => {
  cleanup(); setLuveLocale("pt"); resetCsrfToken(); setCachedCsrf("csrf-r");
  calls = []; list = [sug()]; partial = []; auth = "gated"; getFails = acceptFails = dismissFails = null;
  acceptReply = { routine: { id: "job1", name: "Resumo da manhã", bot: "vendas", state: "paused" }, suggestion_id: ID, started: false };
  setCustomFetchJSON(async (url, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/session")) return { csrf: "csrf-r", actor: "basic:ceo", auth_mode: auth };
    if (url.endsWith("/routine-suggestions") && method === "GET") { if (getFails) throw getFails; return { items: list, partial }; }
    if (url.endsWith("/accept")) { if (acceptFails) throw acceptFails; return acceptReply; }
    if (url.endsWith("/dismiss")) { if (dismissFails) throw dismissFails; return { dismissed: true }; }
    if (url.includes("/routines")) return { routines: [] };
    return {};
  });
});
afterEach(() => { cleanup(); setCustomFetchJSON(null); });

const card = (s: RoutineSuggestion = list[0]) => screen.findByTestId(`routine-suggestion-${s.bot}:${s.id}`);
const k = (s: RoutineSuggestion = list[0]) => `${s.bot}:${s.id}`;
const only = (method: string, suffix: string) => calls.filter((c) => c.method === method && c.url.endsWith(suffix));
const view = (props: Partial<React.ComponentProps<typeof RoutineSuggestions>> = {}) => render(<RoutineSuggestions bots={BOTS} {...props} />);

describe("o cartão", () => {
  it("says what Hermes suggests, for which Bot, from where, when it runs in words, where the result goes, and what it will ask", async () => {
    view();
    const c = await card();
    expect(screen.getByRole("heading", { name: "Sugestão do Hermes", level: 2 })).toBeDefined();
    expect(c.textContent).toContain("Sugestão do Hermes · do catálogo do Hermes · para Vendas");
    expect(screen.getByTestId(`rsg-title-${k()}`).textContent).toBe("Resumo da manhã");
    expect(screen.getByTestId(`rsg-description-${k()}`).textContent).toContain("Todo dia útil");
    expect(screen.getByTestId(`rsg-when-${k()}`).textContent).toBe("De segunda a sexta, às 08:00");
    expect(c.textContent).toContain("O resultado fica aqui no LuveBot, no histórico da rotina.");
    expect(c.textContent).toContain("Skills: resumo, agenda");
    expect(screen.getByTestId(`rsg-prompt-${k()}`).textContent).toBe("Leia as conversas de ontem e resuma em 5 linhas.");
    expect(screen.getByTestId(`btn-rsg-paused-${k()}`).textContent).toBe("Criar pausada");
    expect(screen.getByTestId(`btn-rsg-start-${k()}`).textContent).toBe("Criar e iniciar");
    expect(screen.getByTestId(`btn-rsg-dismiss-${k()}`).textContent).toBe("Dispensar");
    expect(c.textContent).toContain("Pausada, ela só roda quando você iniciar em Rotinas.");
    expect(only("GET", "/routine-suggestions")).toHaveLength(1);
    expect(calls.filter((x) => x.method !== "GET")).toEqual([]);   // listing creates nothing
  });

  it("each source has its own words, and a schedule it cannot describe shows as it is", async () => {
    list = [sug({ id: "000000000001", source: "blueprint" }), sug({ id: "000000000002", source: "usage", spec: { schedule: "@weekly" } }), sug({ id: "000000000003", source: "integration" }), sug({ id: "000000000004", source: "dreamed-up" })];
    view();
    await card(list[0]);
    const text = (i: number) => screen.getByTestId(`routine-suggestion-${k(list[i])}`).textContent ?? "";
    expect(text(0)).toContain("de uma skill");
    expect(text(1)).toContain("do seu uso");
    expect(screen.getByTestId(`rsg-when-${k(list[1])}`).textContent).toBe("Agenda: @weekly");
    expect(text(2)).toContain("de uma conta conectada");
    expect(text(3)).toContain("· do Hermes ·");
    expect(screen.getByRole("heading", { name: "Sugestões do Hermes", level: 2 })).toBeDefined();
  });

  it("title, description and prompt are text, never elements: markup, a link that looks like a button, control characters", async () => {
    list = [sug({
      title: "<img src=x onerror=alert(1)>Resumo", description: "[clique aqui](https://evil.example) <a href=\"https://evil.example\">Aceitar</a> **negrito**",
      spec: { schedule: "every 1h", prompt: "<script>alert(1)</script>\u0007\n# título\n- item" },
    })];
    view();
    const c = await card();
    expect(c.querySelector("img[src='x'], script, a, strong[data-md], h1, ul")).toBeNull();
    expect(c.querySelectorAll("a")).toHaveLength(0);
    expect(screen.getByTestId(`rsg-title-${k()}`).textContent).toBe("<img src=x onerror=alert(1)>Resumo");
    expect(screen.getByTestId(`rsg-description-${k()}`).textContent).toContain("**negrito**");
    expect(screen.getByTestId(`rsg-prompt-${k()}`).textContent).toContain("<script>alert(1)</script>");
  });

  it("says when the text was cut", async () => {
    list = [sug({ truncated: { prompt: true } })];
    view();
    expect((await card()).textContent).toContain("O texto era longo e foi cortado aqui; o Hermes tem a versão inteira.");
  });

  it("speaks English too", async () => {
    setLuveLocale("en");
    view();
    const c = await card();
    expect(c.textContent).toContain("Suggestion from Hermes · from Hermes's catalog · for Vendas");
    expect(screen.getByTestId(`btn-rsg-paused-${k()}`).textContent).toBe("Create paused");
    expect(screen.getByTestId(`btn-rsg-start-${k()}`).textContent).toBe("Create and start");
    expect(screen.getByTestId(`btn-rsg-dismiss-${k()}`).textContent).toBe("Dismiss");
    expect(screen.getByTestId(`rsg-when-${k()}`).textContent).toBe("Monday to Friday at 08:00 AM");
  });
});

describe("Criar pausada e Criar e iniciar", () => {
  it("'Criar pausada' posts {start:false} with the CSRF token to the Bot's own path, then says it is paused and nothing else can be clicked", async () => {
    const onAccepted = vi.fn();
    view({ onAccepted });
    await card();
    fireEvent.click(screen.getByTestId(`btn-rsg-paused-${k()}`));
    const done = await screen.findByTestId(`rsg-created-${k()}`);
    const post = only("POST", `/bots/vendas/routine-suggestions/${ID}/accept`);
    expect(post).toHaveLength(1);
    expect(post[0].body).toEqual({ start: false });
    expect(post[0].csrf).toBe("csrf-r");
    expect(done.textContent).toBe("Rotina criada, pausada. Ela só roda quando você iniciar em Rotinas.");
    expect(screen.queryByTestId(`btn-rsg-paused-${k()}`)).toBeNull();
    expect(screen.queryByTestId(`btn-rsg-start-${k()}`)).toBeNull();
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it("'Criar e iniciar' posts {start:true}; started says so", async () => {
    acceptReply = { ...acceptReply, started: true };
    view();
    await card();
    fireEvent.click(screen.getByTestId(`btn-rsg-start-${k()}`));
    expect((await screen.findByTestId(`rsg-created-${k()}`)).textContent).toBe("Rotina criada e iniciada.");
    expect(only("POST", `/bots/vendas/routine-suggestions/${ID}/accept`)[0].body).toEqual({ start: true });
  });

  it("a start the gates refused (held) stays honest: created, but paused, and why", async () => {
    acceptReply = { ...acceptReply, started: false, held: "budget_held" };
    view();
    await card();
    fireEvent.click(screen.getByTestId(`btn-rsg-start-${k()}`));
    const text = (await screen.findByTestId(`rsg-created-${k()}`)).textContent ?? "";
    expect(text).toMatch(/^Rotina criada, mas ficou pausada: /);
    expect(text).not.toContain("iniciada");
    cleanup();
    acceptReply = { ...acceptReply, held: "some_new_code" };
    view();
    await card();
    fireEvent.click(screen.getByTestId(`btn-rsg-start-${k()}`));
    expect((await screen.findByTestId(`rsg-created-${k()}`)).textContent).toContain("o LuveBot não pôde iniciá-la agora.");
  });

  it("a replayed accept says nothing was doubled", async () => {
    acceptReply = { ...acceptReply, replayed: true };
    view();
    await card();
    fireEvent.click(screen.getByTestId(`btn-rsg-paused-${k()}`));
    expect((await screen.findByTestId(`rsg-created-${k()}`)).textContent).toContain("é a mesma rotina de antes, nada em dobro.");
  });

  it("while one request is in flight no button of any card can fire a second one (the backend is single-flight too)", async () => {
    list = [sug(), sug({ id: ID2 })];
    let release: (v: unknown) => void = () => {};
    setCustomFetchJSON(async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.endsWith("/session")) return { csrf: "csrf-r", actor: "x", auth_mode: "gated" };
      if (url.endsWith("/routine-suggestions")) return { items: list, partial: [] };
      if (url.endsWith("/accept")) return new Promise((r) => { release = r; });
      return {};
    });
    view();
    await card(list[0]);
    fireEvent.click(screen.getByTestId(`btn-rsg-paused-${k(list[0])}`));
    await waitFor(() => expect((screen.getByTestId(`btn-rsg-paused-${k(list[1])}`) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByTestId(`btn-rsg-start-${k(list[0])}`) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId(`btn-rsg-paused-${k(list[0])}`));
    expect(only("POST", `/bots/vendas/routine-suggestions/${ID}/accept`)).toHaveLength(1);
    release({ routine: { id: "j" }, suggestion_id: ID, started: false });
    await screen.findByTestId(`rsg-created-${k(list[0])}`);
  });

  it("the Bot and id go in the path encoded, never raw", async () => {
    list = [sug({ bot: "a/b", id: ID })];
    view();
    await screen.findByTestId(`routine-suggestion-a/b:${ID}`);
    fireEvent.click(screen.getByTestId(`btn-rsg-paused-a/b:${ID}`));
    await screen.findByTestId(`rsg-created-a/b:${ID}`);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/bots/a%2Fb/routine-suggestions/" + ID + "/accept"))).toBe(true);
  });
});

describe("já aceita", () => {
  it("409 suggestion_not_pending (another tab, or Hermes itself, got there first): the card says so, creates nothing, offers nothing", async () => {
    acceptFails = err("suggestion_not_pending");
    view();
    await card();
    fireEvent.click(screen.getByTestId(`btn-rsg-paused-${k()}`));
    expect((await screen.findByTestId(`rsg-gone-${k()}`)).textContent).toBe("Esta sugestão já foi aceita ou dispensada (aqui, em outra aba ou no Hermes).");
    expect(screen.queryByTestId(`btn-rsg-paused-${k()}`)).toBeNull();
    expect(screen.queryByTestId(`rsg-created-${k()}`)).toBeNull();
  });

  it("the same for Dispensar", async () => {
    dismissFails = err("suggestion_not_pending");
    view();
    await card();
    fireEvent.click(screen.getByTestId(`btn-rsg-dismiss-${k()}`));
    expect(await screen.findByTestId(`rsg-gone-${k()}`)).toBeDefined();
  });
});

describe("sem login (loopback)", () => {
  it("the create buttons are replaced by one line; Dispensar stays and works", async () => {
    auth = "loopback";
    view();
    await screen.findByTestId(`rsg-needlogin-${k()}`);
    expect(screen.getByTestId(`rsg-needlogin-${k()}`).textContent).toBe("Aceitar precisa de login no painel do Hermes. Sem login, você só pode dispensar.");
    expect(screen.queryByTestId(`btn-rsg-paused-${k()}`)).toBeNull();
    expect(screen.queryByTestId(`btn-rsg-start-${k()}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`btn-rsg-dismiss-${k()}`));
    await waitFor(() => expect(screen.queryByTestId(`routine-suggestion-${k()}`)).toBeNull());
    expect(only("POST", `/bots/vendas/routine-suggestions/${ID}/dismiss`)).toHaveLength(1);
    expect(screen.getByTestId("routine-suggestions-note").textContent).toBe("Sugestão dispensada.");
    expect(only("POST", "/accept")).toHaveLength(0);
  });

  it("the deployment token (a machine): the same line in the credential's words, never loopback's; Dispensar still works and nothing is created", async () => {
    auth = "deployment";
    view();
    await screen.findByTestId(`rsg-needlogin-${k()}`);
    expect(screen.getByTestId(`rsg-needlogin-${k()}`).textContent).toBe("Este acesso não é um login que o LuveBot reconheça como de uma pessoa (uma credencial de implantação ou um provedor que ele não conhece). Entre com o login de uma pessoa ou peça a quem administra o servidor que declare o provedor.");
    expect(screen.queryByTestId(`btn-rsg-paused-${k()}`)).toBeNull();
    expect(screen.queryByTestId(`btn-rsg-start-${k()}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`btn-rsg-dismiss-${k()}`));
    await waitFor(() => expect(screen.queryByTestId(`routine-suggestion-${k()}`)).toBeNull());
    expect(only("POST", "/accept")).toHaveLength(0);
  });

  it("a mode nobody knows, or none, is not a person: the create buttons are replaced by the same line (only `gated` is)", async () => {
    for (const m of ["", "service", "GATED"]) {
      cleanup(); auth = m; view();
      await screen.findByTestId(`rsg-needlogin-${k()}`);
      expect(screen.queryByTestId(`btn-rsg-paused-${k()}`), JSON.stringify(m)).toBeNull();
    }
  });

  it("if the server says 403 credential_not_human at the click (the screen could not tell), it switches to the line in the credential's words", async () => {
    acceptFails = err("credential_not_human", 403);
    view();
    await card();
    fireEvent.click(screen.getByTestId(`btn-rsg-paused-${k()}`));
    expect((await screen.findByTestId(`rsg-needlogin-${k()}`, undefined, { timeout: 10_000 })).textContent).toBe("Este acesso não é um login que o LuveBot reconheça como de uma pessoa (uma credencial de implantação ou um provedor que ele não conhece). Entre com o login de uma pessoa ou peça a quem administra o servidor que declare o provedor.");   // a wait that ends the moment it holds; the ceiling is only for a loaded machine
    expect(screen.getByTestId(`rsg-error-${k()}`).textContent).toContain("login que o LuveBot reconheça como de uma pessoa");
    expect(screen.getByTestId(`rsg-error-${k()}`).textContent).not.toMatch(/loopback/i);
    expect(screen.queryByTestId(`rsg-created-${k()}`)).toBeNull();
  });

  it("if the server says 403 loopback_not_human at the click (the screen could not tell), it says why and switches to the login line", async () => {
    acceptFails = err("loopback_not_human", 403);
    view();
    await card();
    fireEvent.click(screen.getByTestId(`btn-rsg-paused-${k()}`));
    expect((await screen.findByTestId(`rsg-needlogin-${k()}`)).textContent).toContain("precisa de login");
    expect(screen.getByTestId(`rsg-error-${k()}`).textContent).toContain("loopback");
    expect(screen.queryByTestId(`rsg-created-${k()}`)).toBeNull();
  });
});

describe("uma sugestão que o LuveBot não cria", () => {
  it.each([
    ["delivery_outside", "Ela entrega o resultado fora do LuveBot, num canal. O LuveBot nunca cria isso por conta própria."],
    ["no_agent", "Ela roda um script sem agente, e o LuveBot não cria esse tipo."],
    ["invalid_spec", "O LuveBot não conseguiu ler esta rotina com segurança."],
    ["too_large", "O texto é grande demais para conferir aqui."],
    ["something_new", "O LuveBot não cria esta."],
  ])("%s: the reason in words, no create button, 'Aceite no Hermes', Dispensar", async (why, text) => {
    list = [sug({ supported: false, why_not: why })];
    view();
    await card();
    expect(screen.getByTestId(`rsg-why-${k()}`).textContent).toBe(text);
    expect(screen.queryByTestId(`btn-rsg-paused-${k()}`)).toBeNull();
    expect(screen.queryByTestId(`btn-rsg-start-${k()}`)).toBeNull();
    expect((await card()).textContent).toContain("Aceite no Hermes: use o comando /suggestions no Bot, onde o destino aparece.");
    expect(screen.getByTestId(`btn-rsg-dismiss-${k()}`)).toBeDefined();
  });

  it("unsupported_fields names the keys (never their values)", async () => {
    list = [sug({ supported: false, why_not: "unsupported_fields", fields: ["script", "workdir"] })];
    view();
    await card();
    expect(screen.getByTestId(`rsg-why-${k()}`).textContent).toBe("Ela usa campos que o LuveBot não mostra nem cria (script, workdir).");
    cleanup();
    list = [sug({ supported: false, why_not: "unsupported_fields" })];
    view();
    await card();
    expect(screen.getByTestId(`rsg-why-${k()}`).textContent).toBe("Ela usa campos que o LuveBot não mostra nem cria.");
  });

  it("an unsupported card never says where the result goes as if LuveBot would run it", async () => {
    list = [sug({ supported: false, why_not: "delivery_outside", spec: { schedule: "0 9 * * *", deliver: "telegram:123" } })];
    view();
    const c = await card();
    expect(c.textContent).not.toContain("O resultado fica aqui");
    expect(c.textContent).not.toContain("telegram");
  });
});

describe("os estados", () => {
  it("nothing at all while it is still reading (no flash of 'empty')", async () => {
    let release: (v: unknown) => void = () => {};
    setCustomFetchJSON(async (url) => (url.endsWith("/routine-suggestions") ? new Promise((r) => { release = r; }) : { csrf: "c", actor: "x", auth_mode: "gated" }));
    const { container } = view();
    expect(container.textContent).toBe("");
    release({ items: [], partial: [] });
    expect(await screen.findByTestId("routine-suggestions-empty")).toBeDefined();
  });

  it("vazio: Routines says so calmly, Today shows nothing", async () => {
    list = [];
    view();
    expect((await screen.findByTestId("routine-suggestions-empty")).textContent).toContain("Nenhuma sugestão do Hermes agora.");
    cleanup();
    const { container } = view({ variant: "today" });
    await waitFor(() => expect(only("GET", "/routine-suggestions")).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(container.textContent).toBe("");
  });

  it("erro com nome: a named error with a retry that reads again", async () => {
    getFails = err("hermes_unreachable", 502);
    view();
    const e = await screen.findByTestId("routine-suggestions-error");
    expect(e.textContent).toContain("O LuveBot não conseguiu falar com o Hermes agora.");
    expect(screen.queryByTestId("routine-suggestions-empty")).toBeNull();   // an error is never shown as "no suggestions"
    getFails = null;
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await card();
    expect(only("GET", "/routine-suggestions")).toHaveLength(2);
  });

  it("capability missing: Routines names it (never an empty list), Today stays quiet", async () => {
    getFails = err("capability_missing", 501);
    view();
    expect((await screen.findByTestId("routine-suggestions-error")).textContent).toBeTruthy();
    expect(screen.queryByTestId("routine-suggestions-empty")).toBeNull();
    cleanup();
    const { container } = view({ variant: "today" });
    await waitFor(() => expect(only("GET", "/routine-suggestions")).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(container.textContent).toBe("");
  });

  it("Today stays quiet for ANY failed read (a side list: it never says 'none', it says nothing)", async () => {
    getFails = err("hermes_unreachable", 502);
    const { container } = view({ variant: "today" });
    await waitFor(() => expect(only("GET", "/routine-suggestions")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(container.textContent).toBe("");
  });

  it("asks who is looking (GET /session) only when there is a card that could be accepted", async () => {
    list = [];
    view({ variant: "today" });
    await new Promise((r) => setTimeout(r, 30));
    expect(only("GET", "/session")).toHaveLength(0);
    cleanup();
    list = [sug({ supported: false, why_not: "delivery_outside" })];
    view();
    await card();
    await new Promise((r) => setTimeout(r, 30));
    expect(only("GET", "/session")).toHaveLength(0);   // nothing here can be accepted
    cleanup();
    list = [sug()];
    view();
    await card();
    await waitFor(() => expect(only("GET", "/session")).toHaveLength(1));
  });

  it("partial: names the Bots it could not read, and does not call the rest 'none'", async () => {
    list = [];
    partial = ["suporte"];
    view();
    expect((await screen.findByTestId("routine-suggestions-partial")).textContent).toBe("Não deu para ler as sugestões de Suporte.");
    cleanup();
    list = [sug()];
    view();
    await card();
    expect(screen.getByTestId("routine-suggestions-partial")).toBeDefined();
  });

  it("an accept that fails keeps the card, names the error, and creates nothing", async () => {
    acceptFails = err("hermes_unreachable", 502);
    view();
    await card();
    fireEvent.click(screen.getByTestId(`btn-rsg-paused-${k()}`));
    expect((await screen.findByTestId(`rsg-error-${k()}`)).textContent).toContain("O LuveBot não conseguiu falar com o Hermes agora.");
    expect(screen.getByTestId(`btn-rsg-paused-${k()}`)).toBeDefined();   // can try again
    expect(screen.queryByTestId(`rsg-created-${k()}`)).toBeNull();
  });

  it("not supported at the click (409 suggestion_not_supported) has its own sentence", async () => {
    acceptFails = err("suggestion_not_supported");
    view();
    await card();
    fireEvent.click(screen.getByTestId(`btn-rsg-paused-${k()}`));
    expect((await screen.findByTestId(`rsg-error-${k()}`)).textContent).toContain("O LuveBot não cria esta sugestão. Aceite no Hermes.");
  });

  it("a Bot's own page lists only that Bot's suggestions (and only its unread files)", async () => {
    list = [sug(), sug({ bot: "suporte", id: ID2 })];
    partial = ["suporte", "vendas"];
    view({ botName: "vendas" });
    await card(list[0]);
    expect(screen.queryByTestId(`routine-suggestion-suporte:${ID2}`)).toBeNull();
    expect(screen.getByTestId("routine-suggestions-partial").textContent).toBe("Não deu para ler as sugestões de Vendas.");
  });

  it("a malformed answer does not crash the screen", async () => {
    setCustomFetchJSON(async (url) => (url.endsWith("/routine-suggestions") ? { items: null, partial: "x" } : { csrf: "c", actor: "x", auth_mode: "gated" }));
    view();
    expect(await screen.findByTestId("routine-suggestions-empty")).toBeDefined();
  });
});

describe("onde aparece", () => {
  it("Routines: the card sits in the list view, and creating a routine reads the list again", async () => {
    render(<RoutinesView bots={BOTS} initialRoutines={[]} />);
    await card();
    const before = calls.filter((c) => c.method === "GET" && /\/routines(\?|$)/.test(c.url)).length;
    fireEvent.click(screen.getByTestId(`btn-rsg-paused-${k()}`));
    await screen.findByTestId(`rsg-created-${k()}`);
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && /\/routines(\?|$)/.test(c.url)).length).toBeGreaterThan(before));
  });

  it("Routines opened from a Bot's profile shows only that Bot's suggestions", async () => {
    list = [sug(), sug({ bot: "suporte", id: ID2 })];
    render(<RoutinesView bots={BOTS} initialRoutines={[]} botName="vendas" />);
    await card(list[0]);
    expect(screen.queryByTestId(`routine-suggestion-suporte:${ID2}`)).toBeNull();
  });

  it("Today: the same card, below the routines", async () => {
    render(<Hoje bots={BOTS} />);
    const c = await card();
    expect(screen.getByTestId("routine-suggestions-today")).toBeDefined();
    expect(c.textContent).toContain("Resumo da manhã");
    expect(screen.getByTestId("routines-count").compareDocumentPosition(screen.getByTestId("routine-suggestions-today")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// The items below are what backend/routine_suggestions.py `items_of` really produced (a delivery to a channel, an unsupported key, a text over the limits, a source it does not know,
// a created_at that is a number / a text / null, a one-shot schedule): the card must draw every one of them from the REAL shape, not from the shape the contract describes.
describe("the real backend's shapes (fixtures/routine-suggestions-backend.json)", () => {
  beforeEach(() => { list = REAL.items as unknown as RoutineSuggestion[]; partial = REAL.partial; });
  const byId = (id: string) => (REAL.items as unknown as RoutineSuggestion[]).find((i) => i.id === id)!;

  it("draws all five, oldest first as the backend ordered them, with the partial note", async () => {
    view();
    await screen.findByTestId(`routine-suggestion-vendas:${REAL.items[0].id}`);
    const cards = screen.getAllByRole("article");
    expect(cards.map((c) => c.getAttribute("data-testid"))).toEqual(REAL.items.map((i) => `routine-suggestion-vendas:${i.id}`));
    expect(screen.getByTestId("routine-suggestions-partial").textContent).toBe("Não deu para ler as sugestões de Suporte.");
  });

  it("the supported one has the buttons and its schedule in words; created_at (a text) is not shown", async () => {
    view();
    const k = "vendas:a1b2c3d4e5f6";
    await screen.findByTestId(`routine-suggestion-${k}`);
    expect(screen.getByTestId(`btn-rsg-paused-${k}`)).toBeDefined();
    expect(screen.getByTestId(`rsg-when-${k}`).textContent).toBe("De segunda a sexta, às 08:00");
    expect(screen.getByTestId(`rsg-prompt-${k}`).textContent).toBe("Leia as conversas de ontem e resuma.");
  });

  it("delivery_outside, unsupported_fields (names only), no_agent and too_large each say their reason and offer no create button", async () => {
    view();
    await screen.findByTestId("routine-suggestion-vendas:0123456789ab");
    expect(screen.getByTestId("rsg-why-vendas:0123456789ab").textContent).toContain("fora do LuveBot, num canal");
    expect(screen.getByTestId("rsg-why-vendas:fedcba987654").textContent).toBe("Ela usa campos que o LuveBot não mostra nem cria (script, workdir).");
    expect(screen.getByTestId("rsg-why-vendas:222222222222").textContent).toContain("sem agente");
    expect(screen.getByTestId("rsg-why-vendas:111111111111").textContent).toBe("O texto é grande demais para conferir aqui.");
    for (const id of ["0123456789ab", "fedcba987654", "222222222222", "111111111111"]) expect(screen.queryByTestId(`btn-rsg-paused-vendas:${id}`)).toBeNull();
    expect(screen.getByTestId("routine-suggestion-vendas:111111111111").textContent).toContain("O texto era longo e foi cortado aqui");
  });

  it("a source the backend calls 'other' is 'do Hermes'; a one-shot '30m' says once, in 30 min; 'every 2h' says every 2 h", async () => {
    view();
    await screen.findByTestId("routine-suggestion-vendas:111111111111");
    expect(screen.getByTestId("routine-suggestion-vendas:111111111111").textContent).toContain("· do Hermes ·");
    expect(screen.getByTestId("rsg-when-vendas:111111111111").textContent).toBe("A cada 2 h");
    expect(screen.getByTestId("rsg-when-vendas:222222222222").textContent).toBe("Uma vez, daqui a 30 min");
    expect(byId("111111111111").title.length).toBe(120);   // what the backend cut: the card shows exactly that
    expect(screen.getByTestId("rsg-title-vendas:111111111111").textContent).toBe(byId("111111111111").title);
  });

  it("accepts with the real response shape: 201 {routine, suggestion_id, started, replayed} (replayed absent when false)", async () => {
    view();
    await screen.findByTestId("btn-rsg-paused-vendas:a1b2c3d4e5f6");
    fireEvent.click(screen.getByTestId("btn-rsg-paused-vendas:a1b2c3d4e5f6"));
    expect((await screen.findByTestId("rsg-created-vendas:a1b2c3d4e5f6")).textContent).toBe("Rotina criada, pausada. Ela só roda quando você iniciar em Rotinas.");
  });
});

describe("what the backend does at the edges", () => {
  it.each([
    ["bot_paused", "Este Bot está pausado. Retome o Bot e tente de novo."],
    ["budget_held", "O teto de gasto foi atingido. Ajuste o teto em Custos para continuar."],
    ["hermes_unreachable", "O LuveBot não conseguiu falar com o Hermes agora."],
    ["paused_all", "o LuveBot não pôde iniciá-la agora."],
  ])("held %s: created, paused, and why in words", async (held, words) => {
    acceptReply = { ...acceptReply, started: false, held };
    view();
    await card();
    fireEvent.click(screen.getByTestId(`btn-rsg-start-${k()}`));
    expect((await screen.findByTestId(`rsg-created-${k()}`)).textContent).toContain(words);
  });

  it("capability_missing at ACCEPT (this Hermes has no setter) is said in words, the create buttons give way to 'Aceite no Hermes', and Dispensar still works (list and dismiss follow)", async () => {
    acceptFails = err("capability_missing", 409);
    view();
    await card();
    fireEvent.click(screen.getByTestId(`btn-rsg-paused-${k()}`));
    expect((await screen.findByTestId(`rsg-error-${k()}`)).textContent).toBeTruthy();
    expect(screen.queryByTestId(`btn-rsg-paused-${k()}`)).toBeNull();
    expect(screen.queryByTestId(`btn-rsg-start-${k()}`)).toBeNull();
    expect((await card()).textContent).toContain("Aceite no Hermes");
    fireEvent.click(screen.getByTestId(`btn-rsg-dismiss-${k()}`));
    await waitFor(() => expect(screen.queryByTestId(`routine-suggestion-${k()}`)).toBeNull());
    expect(only("POST", `/bots/vendas/routine-suggestions/${ID}/dismiss`)).toHaveLength(1);
  });

  it("a replayed 201 (the same routine as before) says nothing was doubled, and a replay that is already running says 'iniciada'", async () => {
    acceptReply = { ...acceptReply, started: true, replayed: true };
    view();
    await card();
    fireEvent.click(screen.getByTestId(`btn-rsg-paused-${k()}`));
    const done = await screen.findByTestId(`rsg-created-${k()}`);
    expect(done.textContent).toContain("Rotina criada e iniciada.");
    expect(done.textContent).toContain("é a mesma rotina de antes, nada em dobro.");
  });
});
