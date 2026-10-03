// tests/unit/ui/restart-required.test.tsx
// Forja's finding (VPS: the Tela said "Bot não encontrado"): after an update, the dashboard keeps the OLD LuveBot routes until it
// is restarted, while the UI is read fresh. (1) A 404 WITHOUT our envelope is a route this backend lacks: say "restart the
// dashboard", never "Bot não encontrado"; our own 404s (with the envelope) keep their meaning. (2) /health's
// plugin_restart_required shows a discreet notice that stays while /health reports it.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { LuveBotApp } from "@/index";
import { ScreenTab } from "@/components/screen/ScreenTab";
import { useFileDownloads } from "@/components/conversation/FileCard";
import { setCustomFetchJSON, resetCsrfToken, getRules, ApiError } from "@/api/client";
import { humanError } from "@/components/ui/ErrorNote";
import { translations } from "@/i18n";

const tr = (k: string) => (translations.pt as Record<string, string>)[k];
const notFound = (body: string) => ({ status: 404, body });  // the SDK's fetchJSON error: {status, body} (web/src/lib/api-error.ts)
const RESTART = "Esta função ainda não está ativa: o painel do Hermes precisa ser reiniciado para carregar a versão nova do LuveBot.";

beforeEach(() => { cleanup(); resetCsrfToken(); });
afterEach(() => { setCustomFetchJSON(null); vi.useRealTimers(); });

describe("a 404 without LuveBot's envelope", () => {
  async function codeOf(body: string, status = 404) {
    setCustomFetchJSON(async () => { throw { status, body }; });
    try { await getRules(); } catch (e) { return (e as ApiError).code; }
    return null;
  }
  it("is a route the running backend lacks (plugin_route_missing), not 'bot_not_found'; our own 404 keeps its code", async () => {
    expect(await codeOf('{"detail":"Not Found"}')).toBe("plugin_route_missing");      // FastAPI's own 404
    expect(await codeOf("Not Found")).toBe("plugin_route_missing");
    // a POST to a route the running backend lacks: the dashboard's catch-all answers GET only, so 405 (harness, POST /attachments)
    expect(await codeOf('{"detail":"Method Not Allowed"}', 405)).toBe("plugin_route_missing");
    expect(await codeOf(JSON.stringify({ error: { code: "bot_not_found", message: "No such Bot." } }))).toBe("bot_not_found");
    expect(humanError(new ApiError({ code: "plugin_route_missing", message: "x", status: 404 }), tr as any, "unexpectedError").text).toBe(RESTART);
  });

  it("the Tela of an updated LuveBot on a dashboard not restarted (the VPS case) says to restart, not 'Bot não encontrado'", async () => {
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      throw notFound('{"detail":"Not Found"}');
    });
    render(<ScreenTab bot="default" label="Default" />);
    expect((await screen.findByRole("alert")).textContent).toContain(RESTART);
    expect(document.body.textContent).not.toContain("não foi encontrado");
  });
});

describe("a download whose route is missing", () => {
  it("'Baixar' says to restart the dashboard (a bare 404), and keeps 'arquivo não disponível' for our own 404", async () => {
    let state: Record<string, any> = {};
    function Probe({ path }: { path: string }) {
      const d = useFileDownloads("vendas");
      state = d.state;
      return <button onClick={() => void d.download("k", path)}>go</button>;
    }
    for (const [body, said] of [["Not Found", RESTART], [JSON.stringify({ error: { code: "file_not_found", message: "File not found." } }), tr("fileErrNotFound")]] as const) {
      (window as any).__HERMES_PLUGIN_SDK__ = { authedFetch: async () => new Response(body, { status: 404 }) };
      const r = render(<Probe path="a.md" />);
      await act(async () => { screen.getByText("go").click(); });
      await waitFor(() => expect(state.k?.error).toBeTruthy());
      const text = typeof state.k.error === "string" ? state.k.error : state.k.error.text;
      expect(text).toBe(said);
      r.unmount();
    }
    delete (window as any).__HERMES_PLUGIN_SDK__;
  });
});

describe("the restart notice from /health", () => {
  function app(health: () => unknown) {
    let calls = 0;
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.endsWith("/health")) { calls++; return health(); }
      if (/\/bots$/.test(url)) return { bots: [] };
      return {};
    });
    render(<LuveBotApp />);
    return { calls: () => calls };
  }
  const stale = { ok: false, plugin: { version: "0.1.0", api: "0", db: { ok: true, schema_version: 1 }, code_current: false },
    problems: [{ code: "plugin_restart_required", feature: "plugin", message: "LuveBot was updated on disk…" }] };
  const fresh = { ok: true, plugin: { version: "0.1.0", api: "0", db: { ok: true, schema_version: 1 }, code_current: true }, problems: [] };

  it("shows while /health reports it, stays through a failed read, and goes when the dashboard runs the new code", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let now: unknown = stale;
    const a = app(() => { if (now === "fail") throw new Error("timeout"); return now; });
    expect((await screen.findByTestId("restart-notice")).textContent).toBe("O LuveBot foi atualizado; reinicie o painel do Hermes para usar a versão nova.");
    expect(screen.getByTestId("restart-notice").getAttribute("role")).toBe("status");
    now = "fail";
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId("restart-notice")).toBeTruthy();                       // a failed read keeps what was known
    now = fresh;
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await waitFor(() => expect(screen.queryByTestId("restart-notice")).toBeNull());
    expect(a.calls()).toBeGreaterThanOrEqual(3);
  });

  it("no notice when the code is current (or /health predates the field)", async () => {
    app(() => ({ ...fresh, plugin: { version: "0.1.0", api: "0", db: { ok: true, schema_version: 1 } } }));
    await waitFor(() => expect(screen.getByRole("navigation")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("restart-notice")).toBeNull();
  });
});
