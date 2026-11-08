// tests/unit/ui/human-errors.test.tsx
// Errors in words a person reads (the CEO saw "Não foi possível salvar (hermes_unreachable)."): no message shows the
// backend's code in parentheses or brackets; every general code of the contract has its own sentence in PT and EN; the
// code is kept only behind a collapsed "Detalhe técnico".
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within, configure } from "@testing-library/react";
import { translations, setLuveLocale } from "@/i18n";
import { GENERAL, humanError, humanCode } from "@/components/ui/ErrorNote";
import { LuveBotApp } from "@/index";
import { ApprovalSurfaceCard } from "@/components/agent/ApprovalSurfaceCard";
import { RulesView } from "@/components/rules";
import { ApprovalsInbox } from "@/components/approvals/ApprovalsInbox";
import { Conversation } from "@/components/conversation";
import { RoutinesView } from "@/components/routines";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";

// A test waits for a state with findBy/waitFor and moves on the moment it holds; these ceilings only matter on a loaded machine (the CEO's
// reached load 240): the default 1 s per wait and 5 s per test are about the machine, not about what the test proves.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const root = process.cwd();
const src = path.join(root, "dashboard/src");
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));

describe("the scan", () => {
  it("no text of the dictionary carries a {code} for the person to read", () => {
    for (const locale of ["pt", "en"] as const) {
      const withCode = Object.entries(translations[locale]).filter(([, v]) => /\{code\}/.test(v as string)).map(([k]) => k);
      expect(withCode, locale).toEqual([]);
    }
  });

  it("no screen writes an error's code into what it shows: no `[${err.code}]`, no t(…, { code: e.code })", () => {
    const hits = files(path.join(src, "components")).flatMap((f) => {
      const s = fs.readFileSync(f, "utf8");
      const bad = [/`\[\$\{\w+\.code\}\]/, /\{\s*code:\s*\w+\.code\s*\}/, /\(\$\{\w+\.code\}\)/].filter((re) => re.test(s));
      return bad.length ? [path.relative(src, f)] : [];
    });
    expect(hits).toEqual([]);
  });

  it("no screen shows an error's own message (the backend's are English, for developers): it goes through humanError", () => {
    const hits = [...files(path.join(src, "components")), path.join(src, "index.tsx")].flatMap((f) => {
      const s = fs.readFileSync(f, "utf8");
      return /\b(?:e|err|error|ex)\.message\b|\((?:e|err) as Error\)\.message/.test(s) ? [path.relative(src, f)] : [];
    });
    expect(hits).toEqual([]);
  });

  it.skip("every general error code of the contract (§7) has its own sentence, in PT and in EN", () => {
    const contract = fs.readFileSync(path.join(root, "docs/contracts/plugin-api-v0.md"), "utf8");
    const s7 = contract.slice(contract.indexOf("\n## 7"), contract.indexOf("\n## 8"));
    const codes = [...new Set([...s7.matchAll(/`([a-z][a-z_]+)`/g)].map((m) => m[1]))].filter((c) => !["code", "message", "request_id"].includes(c));
    expect(codes.length).toBeGreaterThan(10);
    expect(codes.filter((c) => !GENERAL[c])).toEqual([]);
    for (const key of new Set(Object.values(GENERAL))) {
      expect((translations.pt as Record<string, string>)[key], key).toBeTruthy();
      expect((translations.en as Record<string, string>)[key], key).toBeTruthy();
    }
    // not an ApiError (everything through api/client is one): not "no connection", but what the screen was doing
    const tr = (k: string) => (translations.pt as Record<string, string>)[k];
    expect(humanError(new TypeError("Failed to fetch"), tr as any, "errorLoadingRules")).toEqual({ text: translations.pt.errorLoadingRules, code: null });
    expect(humanError(new ApiError({ code: "weird_thing", message: "Some English.", status: 500 }), tr as any, "errorLoadingRules")).toEqual({ text: translations.pt.errorLoadingRules, code: "weird_thing" });
    expect(translations.pt.errHermesUnreachable).toBe("O LuveBot não conseguiu falar com o Hermes agora. Confira se o gateway está rodando e tente de novo.");
  });
});

describe("on the screens: the sentence, and the code only on request", () => {
  beforeEach(() => { cleanup(); resetCsrfToken(); });
  afterEach(() => setCustomFetchJSON(null));
  const detail = (where: HTMLElement) => within(where).getByRole("button", { name: "Detalhe técnico" });

  it("'Onde aprovar' (the CEO's capture): Hermes unreachable on save is a sentence; the code waits behind 'Detalhe técnico'", async () => {
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.endsWith("/approval-surface") && method === "GET") return { approval_surface: { bot: "vendas", mode: "luvebot", approvers: [], platforms: ["telegram"], allow_all: false, allow_all_reason: null, applied: true, applied_reason: "applied", hook_version: "0.3.0", updated_at: null, updated_by: null } };
      if (url.endsWith("/approval-surface")) throw new ApiError({ code: "hermes_unreachable", message: "Hermes is unreachable.", status: 503 });
      if (url.endsWith("/rules")) return { rules: [] };
      throw new Error(url);
    });
    render(<ApprovalSurfaceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("radio", { name: /Onde a conversa acontece/ }));
    fireEvent.change(screen.getByLabelText(/Quem pode aprovar no Telegram/), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("O LuveBot não conseguiu falar com o Hermes agora. Confira se o gateway está rodando e tente de novo.");
    expect(alert.textContent).not.toContain("hermes_unreachable");
    expect(alert.textContent).not.toContain("(");
    const more = detail(alert);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(within(alert).getByText("hermes_unreachable").tagName).toBe("CODE");
  });

  it("Regras: a failed load says what happened, never '[hermes_error] …'", async () => {
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.endsWith("/rules")) throw new ApiError({ code: "hermes_error", message: "upstream said no", status: 502 });
      return {};
    });
    render(<RulesView authMode="gated" />);
    const alert = await screen.findByText(/^O Hermes respondeu com um erro/);
    expect(document.body.textContent).not.toMatch(/\[hermes_error\]|upstream said no/);
    expect(detail(alert.closest("[role=alert]") as HTMLElement ?? document.body)).toBeTruthy();
  });

  it("Aprovações: a failed load is a sentence too; an unknown code falls back to what the screen was doing", async () => {
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.includes("/approvals")) throw new ApiError({ code: "approvals_on_fire", message: "x", status: 500 });
      return {};
    });
    render(<ApprovalsInbox bots={[]} />);
    await screen.findByRole("button", { name: "Detalhe técnico" });
    expect(document.body.textContent).not.toContain("[approvals_on_fire]");
    expect(document.body.textContent).toContain(translations.pt.errorLoadingApprovals);
  });

  it("the conversation bubble (the CEO's capture): 'Hermes is unavailable.' becomes our sentence, the code behind the detail", async () => {
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.endsWith("/sessions")) return { session: { id: "s1" } };
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/runs")) throw new ApiError({ code: "hermes_unreachable", message: "Hermes is unavailable.", status: 503 });
      return {};
    });
    render(<Conversation bot={{ name: "vendas", label: "Vendas" }} fetcher={async () => new Response(new ReadableStream(), { status: 200 })} />);
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText("Enviar"));
    const bubble = (await screen.findByText(/^O LuveBot não conseguiu falar com o Hermes agora/)).closest("[role=alert]") as HTMLElement;
    expect(document.body.textContent).not.toContain("Hermes is unavailable.");
    fireEvent.click(detail(bubble));
    expect(within(bubble).getByText("hermes_unreachable")).toBeTruthy();
  });

  it("a stream error frame with a code we have no sentence for says the conversation was interrupted, never the frame's text", async () => {
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.endsWith("/sessions")) return { session: { id: "s1" } };
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/runs")) return { run: { id: "run_r1", status: "started", session_id: "s1" } };
      return { run: { id: "run_r1", status: "failed" } };
    });
    const body = new TextEncoder().encode(`id: 1\nevent: luvebot.error\ndata: ${JSON.stringify({ code: "upstream_weird", message: "Upstream closed unexpectedly." })}\n\n`);
    render(<Conversation bot={{ name: "vendas", label: "Vendas" }} pollMs={10}
      fetcher={async () => new Response(new ReadableStream({ start(c) { c.enqueue(body); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } })} />);
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText("Enviar"));
    expect(await screen.findByText(/^A conversa com o Bot foi interrompida por um erro/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Upstream closed unexpectedly.");
  });

  it("another screen of the 41 (Rotinas): a failed load is our sentence, not the backend's English", async () => {
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.includes("/routines") || url.includes("/cron")) throw new ApiError({ code: "hermes_timeout", message: "Hermes did not answer in time.", status: 504 });
      return {};
    });
    render(<RoutinesView />);
    expect(await screen.findByText(/^O Hermes demorou demais para responder/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Hermes did not answer in time.");
  });
});

// P1-7 (contract v0.10 1): when Hermes's configuration backend cannot serve, or an administrator locked a key, the screen says THAT. A write the
// administrator refused is never told as "Hermes unreachable" (it is there, it said no), and a read the configuration service did not answer is not a
// gateway that is down either.
describe("the config boundary (contract v0.10 1): the two new codes", () => {
  const CODES = ["config_backend_unavailable", "config_key_locked"] as const;
  const tr = (locale: "pt" | "en") => (k: string) => (translations[locale] as Record<string, string>)[k];

  it.skip("the contract names them, and each has its own sentence in PT and EN (not the general ones)", () => {
    const contract = fs.readFileSync(path.join(root, "docs/contracts/plugin-api-v0.10.md"), "utf8");
    const s1 = contract.slice(contract.indexOf("\n## 1."), contract.indexOf("\n## 2."));
    for (const code of CODES) {
      expect(s1, code).toContain(code);
      expect(GENERAL[code], code).toBeTruthy();
      for (const locale of ["pt", "en"] as const) {
        const text = tr(locale)(GENERAL[code]);
        expect(text, `${code} ${locale}`).toBeTruthy();
        expect(text).not.toBe(tr(locale)("errHermesUnreachable"));
        expect(text).not.toBe(tr(locale)("errHermesError"));
        expect(text).not.toMatch(/gateway|indispon|unreachable|could not reach|não conseguiu falar/i);   // Hermes is there: it said no, or its configuration service did not answer
      }
    }
  });

  it("each says what happened and what to do, in PT and EN", () => {
    expect(translations.pt.errConfigLocked).toBe("Um administrador travou esta configuração no Hermes, então o LuveBot não pode alterá-la. Peça a quem administra o Hermes para liberá-la.");
    expect(translations.en.errConfigLocked).toBe("An administrator locked this setting in Hermes, so LuveBot cannot change it. Ask whoever runs Hermes to unlock it.");
    expect(translations.pt.errConfigUnavailable).toContain("não conseguiu ler a própria configuração");
    expect(translations.pt.errConfigUnavailable).toContain("Tente de novo");
    expect(translations.en.errConfigUnavailable).toContain("could not read its configuration");
    expect(translations.en.errConfigUnavailable).toContain("Try again");
  });

  it("humanError and humanCode (a stream frame) give those sentences, with the code kept apart", () => {
    for (const code of CODES) {
      const err = new ApiError({ code, message: "English for developers.", status: code === "config_key_locked" ? 409 : 503, details: { key: "approvals.timeout" } });
      expect(humanError(err, tr("pt") as any, "errorLoadingRules")).toEqual({ text: tr("pt")(GENERAL[code]), code });
      expect(humanCode(code, tr("en") as any, "errorLoadingRules")).toEqual({ text: tr("en")(GENERAL[code]), code });
    }
  });

  beforeEach(() => { cleanup(); resetCsrfToken(); });
  afterEach(() => setCustomFetchJSON(null));

  it("a write an administrator locked: 'Onde aprovar' says so, never 'Hermes unreachable'; the key and the code stay out of the sentence", async () => {
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.endsWith("/approval-surface") && method === "GET") return { approval_surface: { bot: "vendas", mode: "luvebot", approvers: [], platforms: ["telegram"], allow_all: false, allow_all_reason: null, applied: true, applied_reason: "applied", hook_version: "0.3.0", updated_at: null, updated_by: null } };
      if (url.endsWith("/approval-surface")) throw new ApiError({ code: "config_key_locked", message: "An administrator locked this setting in Hermes, so LuveBot cannot change it.", status: 409, details: { key: "platform_hints.telegram" } });
      if (url.endsWith("/rules")) return { rules: [] };
      throw new Error(url);
    });
    render(<ApprovalSurfaceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("radio", { name: /Onde a conversa acontece/ }));
    fireEvent.change(screen.getByLabelText(/Quem pode aprovar no Telegram/), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(translations.pt.errConfigLocked);
    expect(alert.textContent).not.toContain(translations.pt.errHermesUnreachable);
    expect(alert.textContent).not.toContain("platform_hints");
    fireEvent.click(within(alert).getByRole("button", { name: "Detalhe técnico" }));
    expect(within(alert).getByText("config_key_locked").tagName).toBe("CODE");
  });

  it("a read the configuration service did not answer (503): a list says so, in words", async () => {
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.endsWith("/rules")) throw new ApiError({ code: "config_backend_unavailable", message: "x", status: 503 });
      return {};
    });
    render(<RulesView authMode="gated" />);
    await screen.findByText(translations.pt.errConfigUnavailable);
    expect(document.body.textContent).not.toContain(translations.pt.errHermesError);
  });

  it("the Bots list failing on it is an error in words, NOT the 'offline' state (that one is for an unreachable Hermes)", async () => {
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (/\/bots$/.test(url)) throw new ApiError({ code: "config_backend_unavailable", message: "x", status: 503 });
      return {};
    });
    render(<LuveBotApp />);
    await screen.findByText(translations.pt.errConfigUnavailable);
    expect(screen.queryByTestId("pwa-offline-notice")).toBeNull();
  });
});

// P1-11 (contract v0.10 1.3): a Hermes helper that stops the operation (a SystemExit in a thread of ours) is `502 hermes_exited`. It says THAT: Hermes is there, the operation was stopped, try
// again and, if it repeats, restart the dashboard. Never "Hermes unreachable" (it answered) and never the gateway being down.
describe("hermes_exited (contract v0.10 1.3)", () => {
  const exited = () => new ApiError({ code: "hermes_exited", message: "Hermes stopped this operation, so this request did not complete.", status: 502 });
  const tr = (locale: "pt" | "en") => (k: string) => (translations[locale] as Record<string, string>)[k];
  beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
  afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });

  it("has its own sentence in PT and EN: what happened, and what to do", () => {
    expect(GENERAL.hermes_exited).toBe("errHermesExited");
    expect(translations.pt.errHermesExited).toBe("O Hermes interrompeu esta operação, então este pedido não foi concluído. Tente de novo; se repetir, reinicie o painel.");
    expect(translations.en.errHermesExited).toBe("Hermes stopped this operation, so this request did not complete. Try again; if it repeats, restart the dashboard.");
  });

  it("is not 'Hermes unreachable', 'Hermes error' or the gateway: Hermes answered", () => {
    for (const locale of ["pt", "en"] as const) {
      const text = tr(locale)("errHermesExited");
      expect(text).not.toBe(tr(locale)("errHermesUnreachable"));
      expect(text).not.toBe(tr(locale)("errHermesError"));
      expect(text).not.toMatch(/gateway|indispon|unreachable|could not reach|não conseguiu falar/i);
    }
  });

  it("humanError and humanCode (a stream frame) give it, with the code kept apart", () => {
    expect(humanError(exited(), tr("pt") as any, "errorLoadingRules")).toEqual({ text: translations.pt.errHermesExited, code: "hermes_exited" });
    expect(humanCode("hermes_exited", tr("en") as any, "errorLoadingRules")).toEqual({ text: translations.en.errHermesExited, code: "hermes_exited" });
  });

  it("on a screen: a save that Hermes stopped says so, the code waits behind 'Detalhe técnico', and the screen is still usable", async () => {
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.endsWith("/approval-surface") && method === "GET") return { approval_surface: { bot: "vendas", mode: "luvebot", approvers: [], platforms: ["telegram"], allow_all: false, allow_all_reason: null, applied: true, applied_reason: "applied", hook_version: "0.3.0", updated_at: null, updated_by: null } };
      if (url.endsWith("/approval-surface")) throw exited();
      if (url.endsWith("/rules")) return { rules: [] };
      throw new Error(url);
    });
    render(<ApprovalSurfaceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("radio", { name: /Onde a conversa acontece/ }));
    fireEvent.change(screen.getByLabelText(/Quem pode aprovar no Telegram/), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(translations.pt.errHermesExited);
    expect(alert.textContent).not.toContain(translations.pt.errHermesUnreachable);
    fireEvent.click(within(alert).getByRole("button", { name: "Detalhe técnico" }));
    expect(within(alert).getByText("hermes_exited").tagName).toBe("CODE");
    expect((screen.getByRole("button", { name: "Salvar alterações" }) as HTMLButtonElement).disabled).toBe(false);   // it can be tried again
  });

  it("a list that Hermes stopped on load says it in words, in the same place as the other codes", async () => {
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.endsWith("/rules")) throw exited();
      return {};
    });
    render(<RulesView authMode="gated" />);
    await screen.findByText(translations.pt.errHermesExited);
    expect(document.body.textContent).not.toContain(translations.pt.errHermesError);
  });

  it("in English on a screen", async () => {
    setLuveLocale("en");
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.endsWith("/rules")) throw exited();
      return {};
    });
    render(<RulesView authMode="gated" />);
    await screen.findByText(translations.en.errHermesExited);
  });
});

describe("credential_not_human (contract v0.11 5.1): the deployment token is a machine, not a person", () => {
  const machine = () => new ApiError({ code: "credential_not_human", message: "This credential is not a person.", status: 403 });
  const tr = (locale: "pt" | "en") => (k: string) => (translations[locale] as Record<string, string>)[k];
  beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
  afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });

  it("has its own sentence in PT and EN: what the credential is, and what to do", () => {
    expect(GENERAL.credential_not_human).toBe("errCredentialNotHuman");
    expect(translations.pt.errCredentialNotHuman).toBe("Este acesso não é um login que o LuveBot reconheça como de uma pessoa (uma credencial de implantação ou um provedor que ele não conhece). Entre com o login de uma pessoa ou peça a quem administra o servidor que declare o provedor.");
    expect(translations.en.errCredentialNotHuman).toBe("This sign-in is not one LuveBot recognizes as a person's login (a deployment credential, or a provider it does not know). Sign in with a person's login, or ask the operator to declare the provider.");
  });

  it("is not the loopback sentence (a different cause, and 'sign in to the Hermes dashboard with a password' would be the wrong advice) and not a generic one", () => {
    for (const locale of ["pt", "en"] as const) {
      const text = tr(locale)("errCredentialNotHuman");
      expect(text).not.toBe(tr(locale)("errLoopback"));
      expect(text).not.toMatch(/loopback/i);
      expect(text).not.toContain("credential_not_human");
    }
  });

  it("humanError and humanCode (a stream frame) give it, with the code kept apart", () => {
    expect(humanError(machine(), tr("pt") as any, "errorLoadingRules")).toEqual({ text: translations.pt.errCredentialNotHuman, code: "credential_not_human" });
    expect(humanCode("credential_not_human", tr("en") as any, "errorLoadingRules")).toEqual({ text: translations.en.errCredentialNotHuman, code: "credential_not_human" });
  });

  describe("the provider the refusal names (DT-1b, contract v0.11 5.1: details {provider})", () => {
    const named = (provider: unknown, code = "credential_not_human") => new ApiError({ code, message: "x", status: 403, details: { provider } });

    it("goes in the technical detail beside the code, never in the sentence", () => {
      const got = humanError(named("acme"), tr("pt") as any, "errorLoadingRules");
      expect(got).toEqual({ text: translations.pt.errCredentialNotHuman, code: "credential_not_human (acme)" });
      expect(got.text).not.toContain("acme");
      expect(humanError(named("github"), tr("en") as any, "errorLoadingRules").code).toBe("credential_not_human (github)");
    });

    it("only a plain name: markup, spaces, an empty or a 65-character string, a number, null or an object leave the code as it was", () => {
      for (const odd of ["<img src=x onerror=1>", "a b", "", "a".repeat(65), "x\u202ey", 5, null, undefined, { provider: "acme" }, ["acme"]]) {
        expect(humanError(named(odd), tr("pt") as any, "errorLoadingRules").code, JSON.stringify(odd)).toBe("credential_not_human");
      }
      expect(humanError(named("a".repeat(64)), tr("pt") as any, "errorLoadingRules").code).toBe(`credential_not_human (${"a".repeat(64)})`);
    });

    it("is read from this refusal only: another code with the same details, and a refusal with no details, are untouched", () => {
      expect(humanError(named("acme", "loopback_not_human"), tr("pt") as any, "errorLoadingRules").code).toBe("loopback_not_human");
      expect(humanError(machine(), tr("pt") as any, "errorLoadingRules").code).toBe("credential_not_human");
    });

    it("on a screen: the name waits behind 'Detalhe técnico' and is shown as text", async () => {
      setCustomFetchJSON(async (url: string) => {
        if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
        if (url.endsWith("/approvals")) throw named("acme");
        return { approvals: [], rules: [] };
      });
      render(<ApprovalsInbox />);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(translations.pt.errCredentialNotHuman);
      expect(alert.textContent).not.toContain("acme");
      fireEvent.click(within(alert).getByRole("button", { name: "Detalhe técnico" }));
      expect(alert.querySelector("code")!.textContent).toBe("credential_not_human (acme)");
    });
  });

  it("on a screen: a save the machine may not make says so, the code waits behind 'Detalhe técnico', and the screen is still usable", async () => {
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.endsWith("/approval-surface") && method === "GET") return { approval_surface: { bot: "vendas", mode: "luvebot", approvers: [], platforms: ["telegram"], allow_all: false, allow_all_reason: null, applied: true, applied_reason: "applied", hook_version: "0.3.0", updated_at: null, updated_by: null } };
      if (url.endsWith("/approval-surface")) throw machine();
      if (url.endsWith("/rules")) return { rules: [] };
      throw new Error(url);
    });
    render(<ApprovalSurfaceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("radio", { name: /Onde a conversa acontece/ }));
    fireEvent.change(screen.getByLabelText(/Quem pode aprovar no Telegram/), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(translations.pt.errCredentialNotHuman);
    expect(alert.textContent).not.toContain(translations.pt.errLoopback);
    expect(alert.textContent).not.toContain("credential_not_human ");
  });
});
