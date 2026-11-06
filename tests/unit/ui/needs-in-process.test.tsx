// tests/unit/ui/needs-in-process.test.tsx
// Health contract F2-3: with `plugins.isolation: host` Hermes answers 409 `luvebot_needs_in_process` on EVERY route of ours, /health
// included. Any call can meet it; the app then shows ONE screen (what it is, the three steps back), never "Bot não encontrado" and never
// a generic error. The signal is sticky for the page (a reload after the config change starts clean), so the cases that must NOT trigger
// it come first.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { LuveBotApp } from "@/index";
import { setCustomFetchJSON, resetCsrfToken, getBots, getHealth, downloadBotFile, isNeedsInProcess, onNeedsInProcess, ApiError } from "@/api/client";
import { humanError } from "@/components/ui/ErrorNote";
import { setLuveLocale, translations } from "@/i18n";

const tr = (k: string) => (translations.pt as Record<string, string>)[k];
const envelope = (code: string, status = 409) => ({ status, body: JSON.stringify({ error: { code, message: "English for developers", request_id: "req_1" } }) });
const NEEDS = envelope("luvebot_needs_in_process");

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); delete (window as any).__HERMES_PLUGIN_SDK__; });

describe("409 luvebot_needs_in_process", () => {
  it("other 409s and 404s do NOT trigger it: a Bot's conflict stays a conflict, and the app is the shell", async () => {
    for (const e of [envelope("conflict"), envelope("bot_not_found", 404), envelope("approval_surface_unsafe")]) {
      setCustomFetchJSON(async () => { throw e; });
      await getBots().catch(() => {});
    }
    expect(isNeedsInProcess()).toBe(false);
    setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "basic:ceo", auth_mode: "gated" } : /\/bots$/.test(url) ? { bots: [] } : {}));
    render(<LuveBotApp />);
    await screen.findByRole("navigation");
    expect(screen.queryByTestId("needs-in-process")).toBeNull();
  });

  it("any call that meets it throws the code itself (never 'conflict' or 'bot_not_found') and announces it once", async () => {
    const heard: number[] = [];
    const off = onNeedsInProcess(() => heard.push(1));
    setCustomFetchJSON(async () => { throw NEEDS; });
    const errs: ApiError[] = [];
    for (const call of [() => getBots(), () => getHealth()]) await call().catch((e) => errs.push(e));
    (window as any).__HERMES_PLUGIN_SDK__ = { authedFetch: async () => new Response(NEEDS.body, { status: 409 }) };   // the authedFetch routes too
    await downloadBotFile("vendas", "a.md").catch((e) => errs.push(e));
    off();
    expect(errs.map((e) => e.code)).toEqual(["luvebot_needs_in_process", "luvebot_needs_in_process", "luvebot_needs_in_process"]);
    expect(isNeedsInProcess()).toBe(true);
    expect(heard).toHaveLength(1);                                                       // sticky: said once
  });

  it("a screen that shows the error inline says it in words, with the code only behind 'Detalhe técnico'", () => {
    const h = humanError(new ApiError({ code: "luvebot_needs_in_process", message: "x", status: 409 }), tr as any, "unexpectedError");
    expect(h.text).toBe("O LuveBot não funciona com os plugins do Hermes em modo isolado (plugins.isolation: host). Volte para in_process no config.yaml e reinicie o painel.");
    expect(h.text).not.toContain("luvebot_needs_in_process");
  });

  it("the app shows ONE screen: what it is and the three steps back; no shell, no 'Bot não encontrado'", async () => {
    setCustomFetchJSON(async () => { throw NEEDS; });                                   // /health and everything else: the same answer
    render(<LuveBotApp />);
    const screenEl = await screen.findByTestId("needs-in-process");
    const t = screenEl.textContent!;
    expect(within(screenEl).getByRole("heading", { level: 1 }).textContent).toBe("O LuveBot precisa rodar dentro do painel do Hermes");
    expect(t).toContain("plugins.isolation: host");
    expect(within(screenEl).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Abra o config.yaml do Hermes e troque plugins.isolation para in_process (ou apague a linha).",
      "Reinicie o painel do Hermes.",
      "Recarregue esta página.",
    ]);
    expect(within(screenEl).getByRole("button", { name: "Recarregar a página" })).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(document.body.textContent).not.toMatch(/não foi encontrado|Bot não encontrado/);
    expect(document.body.textContent).not.toContain("luvebot_needs_in_process");
  });

  it("in English", async () => {
    setLuveLocale("en");
    setCustomFetchJSON(async () => { throw NEEDS; });
    render(<LuveBotApp />);
    const screenEl = await screen.findByTestId("needs-in-process");
    expect(within(screenEl).getByRole("heading", { level: 1 }).textContent).toBe("LuveBot has to run inside the Hermes dashboard");
    expect(screenEl.textContent).toContain("Restart the Hermes dashboard.");
    expect(within(screenEl).getByRole("button", { name: "Reload the page" })).toBeTruthy();
  });
});
