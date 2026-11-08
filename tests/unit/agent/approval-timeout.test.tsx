// tests/unit/agent/approval-timeout.test.tsx
// "Tempo para responder aprovações" (contract v0.6 Part D): the 5 waits; the text says silence is still "no" and that it also
// applies in Telegram; a tap sends a JSON integer with CSRF; the screen says "salvo" only with Hermes's re-read value, never on
// a refusal (502 hermes_error, 422, 503 audit); Configurações applies to every Bot and says the result of each.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { ApprovalTimeoutCard, ApprovalTimeoutAll } from "@/components/agent/ApprovalTimeoutCard";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";

type Call = { url: string; method: string; body?: any; csrf: string | null };
let calls: Call[];
function backend(opts: { timeouts: Record<string, { seconds: number; source: string }>; put?: (url: string, body: any) => any }) {
  calls = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    const bot = url.match(/\/bots\/([^/]+)$/)?.[1];
    if (method === "GET" && bot) return { name: bot, display: { label: bot }, soul: "", toolsets: [], mcp_servers: [], approval_timeout: opts.timeouts[bot] };
    if (method === "PUT" && opts.put) return opts.put(url, JSON.parse(String(init!.body)));
    throw new Error(`unexpected ${method} ${url}`);
  });
}
const checked = () => screen.getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent);

beforeEach(() => { cleanup(); resetCsrfToken(); });
afterEach(() => setCustomFetchJSON(null));

describe("in the Bot's profile", () => {
  it("says what the wait means, shows the 5 choices with the current one, and saves a tap as a JSON integer with CSRF", async () => {
    backend({ timeouts: { vendas: { seconds: 3600, source: "profile" } }, put: (_u, body) => ({ seconds: body.seconds, effective: body.seconds }) });
    render(<ApprovalTimeoutCard bot="vendas" />);
    const group = await screen.findByRole("radiogroup", { name: "Tempo para responder aprovações" });
    expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["5 min", "15 min", "30 min", "1 h", "4 h"]);
    expect(checked()).toEqual(["1 h"]);
    expect(screen.getByText(/silêncio continua sendo "não"/)).toBeTruthy();
    expect(screen.getByText(/Vale também no Telegram e nos outros canais deste Bot/)).toBeTruthy();
    expect(screen.getByText("Agora: 1 h.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "4 h" }));
    expect(await screen.findByText("Salvo: 4 h. O Hermes confirmou o novo tempo.")).toBeTruthy();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/plugins/luvebot/bots/vendas/approval-timeout");
    expect(put.body).toEqual({ seconds: 14400 });
    expect(typeof put.body.seconds).toBe("number");
    expect(put.csrf).toBe("csrf-1");
    expect(checked()).toEqual(["4 h"]);
  });

  it("a Bot whose profile never set it shows Hermes's default as such; tapping the current value sends nothing", async () => {
    backend({ timeouts: { dev: { seconds: 300, source: "hermes_default" } } });
    render(<ApprovalTimeoutCard bot="dev" />);
    expect(await screen.findByText(/Agora: 5 min, o padrão do Hermes/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "5 min" }));
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("refusals in plain words, and never 'salvo' nor a moved choice when Hermes did not keep the value", async () => {
    const cases: Array<[ApiError, RegExp]> = [
      [new ApiError({ code: "hermes_error", message: "x", status: 502 }), /O Hermes não guardou esse tempo/],
      [new ApiError({ code: "invalid_field", message: "x", status: 422 }), /Esse tempo não é aceito/],
      [new ApiError({ code: "audit_unavailable", message: "x", status: 503 }), /registrar a mudança na auditoria/],
    ];
    for (const [error, words] of cases) {
      cleanup(); resetCsrfToken();
      backend({ timeouts: { vendas: { seconds: 900, source: "profile" } }, put: () => { throw error; } });
      render(<ApprovalTimeoutCard bot="vendas" />);
      fireEvent.click(await screen.findByRole("radio", { name: "1 h" }));
      expect((await screen.findByRole("alert")).textContent).toMatch(words);
      expect(screen.queryByText(/Salvo:/)).toBeNull();
      expect(checked()).toEqual(["15 min"]);
    }
  });
});

describe("in Configurações, for every Bot", () => {
  it("shows each Bot's wait today, applies one choice to all and says each result; a failure undoes nothing", async () => {
    backend({
      timeouts: { vendas: { seconds: 3600, source: "profile" }, dev: { seconds: 300, source: "hermes_default" } },
      put: (url, body) => (url.endsWith("/approval-timeout") ? { results: [{ bot: "vendas", seconds: body.seconds }, { bot: "dev", error: "hermes_error" }] } : {}),
    });
    const bots = [{ name: "vendas", display: { label: "Vendas" } }, { name: "dev", display: { label: "Dev" } }] as any;
    render(<ApprovalTimeoutAll bots={bots} />);
    const today = await screen.findByRole("list", { name: "Tempo de cada Bot hoje" });
    await waitFor(() => expect(today.textContent).toBe("Vendas: 1 hDev: 5 min"));
    const apply = screen.getByRole("button", { name: "Aplicar a todos os Bots" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);  // nothing chosen yet
    fireEvent.click(screen.getByRole("radio", { name: "30 min" }));
    fireEvent.click(apply);
    expect(await screen.findByText("Aplicado a 1 Bot(s): 30 min.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Dev: O Hermes não guardou esse tempo");
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/plugins/luvebot/approval-timeout");
    expect(put.body).toEqual({ seconds: 1800 });
    expect(today.textContent).toBe("Vendas: 30 minDev: 5 min");
    expect(screen.getByText(/um Bot criado depois começa com 1 h/)).toBeTruthy();
    // F7: "Aplicado" says what was SAVED, not the choice on screen: picking another time afterwards does not change it
    fireEvent.click(screen.getByRole("radio", { name: "4 h" }));
    expect(screen.getByText("Aplicado a 1 Bot(s): 30 min.")).toBeTruthy();
  });

  it("F7: a Bot whose wait cannot be read says 'desconhecido', never '…' for ever", async () => {
    backend({ timeouts: { vendas: { seconds: 3600, source: "profile" } } });
    const bots = [{ name: "vendas", display: { label: "Vendas" } }, { name: "sumido", display: { label: "Sumido" } }] as any;
    render(<ApprovalTimeoutAll bots={bots} />);
    const today = await screen.findByRole("list", { name: "Tempo de cada Bot hoje" });
    await waitFor(() => expect(today.textContent).toBe("Vendas: 1 hSumido: desconhecido"));
  });
});
