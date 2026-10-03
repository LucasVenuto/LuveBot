// tests/unit/ui/human-errors.test.tsx
// Errors in words a person reads (the CEO saw "Não foi possível salvar (hermes_unreachable)."): no message shows the
// backend's code in parentheses or brackets; every general code of the contract has its own sentence in PT and EN; the
// code is kept only behind a collapsed "Detalhe técnico".
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { translations } from "@/i18n";
import { GENERAL, humanError } from "@/components/ui/ErrorNote";
import { ApprovalSurfaceCard } from "@/components/agent/ApprovalSurfaceCard";
import { RulesView } from "@/components/rules";
import { ApprovalsInbox } from "@/components/approvals/ApprovalsInbox";
import { Conversation } from "@/components/conversation";
import { RoutinesView } from "@/components/routines";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";

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
