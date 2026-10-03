// tests/unit/approvals/approvals.test.tsx
// Unit tests for Caixa de Aprovações (spec §4.8, contract v0.1 §1-§2, ADR-002).
// Invariants tested:
// - Invariant 6: No approval resolved without explicit human click.
// - Red Team 4: Only authorized resolve routes.
// - Red Team 5: 'Sempre permitir' creates a draft rule and resolves with 'once' (NEVER 'always').
// - Red Team 9: Exact digest verified per request, no token/digest reuse.
// - Deny requires a mandatory reason.
// - Loopback mode (auth_mode='loopback') is strictly read-only with warning banner.
// - Batch resolution requires explicit selection and confirmation.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ApprovalsInbox } from "@/components/approvals";
import { MessengerShell } from "@/components/messenger/MessengerShell";
import {
  setCustomFetchJSON,
  resetCsrfToken,
  resolveApproval,
  ApiError,
} from "@/api/client";
import type { Approval, Bot } from "@/api/types";

const mockBots: Bot[] = [
  {
    name: "vendas",
    is_default: false,
    display: {
      label: "Vendas",
      role: "Vendas B2B",
      color: "#60a5fa",
      avatar: { kind: "emoji", value: "💼" },
    },
    description: "Bot de prospecção e vendas",
    model: { provider: "anthropic", name: "claude-3-5-sonnet" },
    status: "waiting_approval",
  },
  {
    name: "dev",
    is_default: false,
    display: {
      label: "Engenheiro Dev",
      role: "Desenvolvimento",
      color: "#10b981",
      avatar: { kind: "emoji", value: "💻" },
    },
    description: "Bot de engenharia e código",
    model: { provider: "anthropic", name: "claude-3-5-sonnet" },
    status: "idle",
  },
];

const sampleApprovals: Approval[] = [
  {
    request_id: "req-1",
    bot: "vendas",
    surface: "gateway",
    mechanism: "command",
    source: "transport",
    digest: "d111111111111111111111111111111111111111111111111111111111111111",
    command_redacted: "curl -X POST https://api.crm.internal/sync",
    description: "Sincronização de contatos com CRM",
    pattern_keys: ["curl", "network"],
    allowed_choices: ["once", "deny", "always"],
    action_class_hash: "hash-class-vendas-curl",
    created_at: new Date(Date.now() - 5 * 60000).toISOString(),
    expires_at: new Date(Date.now() + 55 * 60000).toISOString(),
    status: "pending",
  },
  {
    request_id: "req-2",
    bot: "vendas",
    surface: "gateway",
    mechanism: "command",
    source: "transport",
    digest: "d22222222222222222222222222222222222222222222222222222222222222",
    command_redacted: "curl -X POST https://api.crm.internal/contacts",
    description: "Exportação de contatos",
    pattern_keys: ["curl", "network"],
    allowed_choices: ["once", "deny", "always"],
    action_class_hash: "hash-class-vendas-curl",
    created_at: new Date(Date.now() - 3 * 60000).toISOString(),
    expires_at: new Date(Date.now() + 57 * 60000).toISOString(),
    status: "pending",
  },
  {
    request_id: "req-3",
    bot: "dev",
    surface: "sandbox",
    mechanism: "exec",
    source: "run",
    digest: "d33333333333333333333333333333333333333333333333333333333333333",
    command_redacted: "rm -rf /tmp/build-cache",
    description: "Limpeza de cache de compilação",
    pattern_keys: ["rm", "filesystem"],
    allowed_choices: ["once", "deny"],
    action_class_hash: "hash-class-dev-rm",
    created_at: new Date(Date.now() - 10 * 60000).toISOString(),
    expires_at: new Date(Date.now() + 50 * 60000).toISOString(),
    status: "pending",
    run_id: "run-abc-123",
  },
];

type CapturedCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: any;
};

function setupFetchMock(opts: {
  approvals?: Approval[];
  authMode?: "loopback" | "gated";
  resolveError?: ApiError;
} = {}) {
  const calls: CapturedCall[] = [];
  const approvalsList = opts.approvals ?? [...sampleApprovals];
  const authMode = opts.authMode ?? "gated";

  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, headers, body });

    if (url.endsWith("/session")) {
      return { csrf: "csrf-token-test-123", actor: "tester", auth_mode: authMode };
    }

    if (method === "GET" && url.includes("/approvals")) {
      return { ok: true, approvals: approvalsList, total: approvalsList.length };
    }

    if (method === "POST" && url.includes("/resolve")) {
      if (opts.resolveError) throw opts.resolveError;
      return {
        ok: true,
        approval: {
          request_id: "req-1",
          status: "decided",
          decided_choice: body?.choice,
        },
        draft_rule: body?.draft_rule
          ? { id: "rule-draft-1", label: body.draft_rule.label, state: "draft" }
          : undefined,
      };
    }

    if (method === "POST" && url.endsWith("/approvals/batch")) {
      if (opts.resolveError) throw opts.resolveError;
      return {
        ok: true,
        approvals: (body?.items || []).map((it: any) => ({
          request_id: it.request_id,
          status: "decided",
          decided_choice: it.choice,
        })),
      };
    }

    throw new Error(`Unexpected call: ${method} ${url}`);
  });

  return { calls };
}

describe("Caixa de Aprovações (ApprovalsInbox)", () => {
  beforeEach(() => {
    resetCsrfToken();
  });

  it("renders pending approvals with rich cards, badges, and accurate count", async () => {
    setupFetchMock();
    render(<ApprovalsInbox bots={mockBots} authMode="gated" />);

    expect(await screen.findByText(/3 ações aguardando sua autorização/i)).toBeDefined();
    expect(screen.getByText("curl -X POST https://api.crm.internal/sync")).toBeDefined();
    expect(screen.getByText("rm -rf /tmp/build-cache")).toBeDefined();
    expect(screen.getByText(/run-abc-123/)).toBeDefined();

    // Verify verified digest prefix is displayed on cards
    expect(screen.getByText(/digest: d111111111/)).toBeDefined();
    expect(screen.getByText(/digest: d333333333/)).toBeDefined();

    // Native choices arrive as codes and are spoken in the person's language, never as [once, deny]
    expect(screen.getAllByText("Permitir uma vez · Negar · Sempre permitir").length).toBeGreaterThan(0);
    expect(screen.queryByText(/\bonce\b|\[once/)).toBeNull();
  });

  it("Invariant 6: NO approval is resolved automatically without explicit human click", async () => {
    const { calls } = setupFetchMock();
    render(<ApprovalsInbox bots={mockBots} authMode="gated" />);

    await screen.findByText(/3 ações aguardando sua autorização/i);

    // Filter changes or clicking unrelated elements must NOT trigger resolve
    fireEvent.change(screen.getByLabelText("Filtrar por Bot"), {
      target: { value: "vendas" },
    });
    expect(screen.getByText("curl -X POST https://api.crm.internal/sync")).toBeDefined();

    const resolveCalls = calls.filter((c) => c.url.includes("/resolve") || c.url.includes("/batch"));
    expect(resolveCalls.length).toBe(0);
  });

  it("Permitir uma vez: sends decision 'once' with exact digest and CSRF header upon explicit human click", async () => {
    const { calls } = setupFetchMock();
    render(<ApprovalsInbox bots={mockBots} authMode="gated" />);

    await screen.findByText(/3 ações aguardando sua autorização/i);
    const card = screen.getByTestId("approval-card-req-1");
    const allowBtn = within(card).getByRole("button", { name: /permitir uma vez/i });

    fireEvent.click(allowBtn);

    await waitFor(() => {
      const resolveCall = calls.find((c) => c.url.endsWith("/approvals/req-1/resolve"));
      expect(resolveCall).toBeDefined();
      expect(resolveCall?.method).toBe("POST");
      expect(resolveCall?.body).toEqual({
        digest: "d111111111111111111111111111111111111111111111111111111111111111",
        choice: "once",
      });
      expect(resolveCall?.headers["x-luvebot-csrf"]).toBe("csrf-token-test-123");
    });
  });

  it("Sempre permitir…: opens draft creator and resolves with choice 'once' and draft_rule (NEVER 'always')", async () => {
    const { calls } = setupFetchMock();
    render(<ApprovalsInbox bots={mockBots} authMode="gated" />);

    await screen.findByText(/3 ações aguardando sua autorização/i);
    const card = screen.getByTestId("approval-card-req-1");
    const alwaysBtn = within(card).getByRole("button", { name: /sempre permitir…/i });

    fireEvent.click(alwaysBtn);

    // Dialog opens with draft explanation
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(
      screen.getByText(/nunca grava permissões permanentes diretas no Hermes/i)
    ).toBeDefined();

    const confirmBtn = screen.getByRole("button", {
      name: /criar rascunho e permitir uma vez/i,
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const resolveCall = calls.find((c) => c.url.endsWith("/approvals/req-1/resolve"));
      expect(resolveCall).toBeDefined();
      expect(resolveCall?.method).toBe("POST");
      // INVARIANT 6 & ADR-002: Choice MUST be 'once', NEVER 'always'
      expect(resolveCall?.body.choice).toBe("once");
      expect(resolveCall?.body.choice).not.toBe("always");
      expect(resolveCall?.body.draft_rule).toBeDefined();
      expect(resolveCall?.body.draft_rule.level).toBe("allow");
      expect(resolveCall?.body.digest).toBe(
        "d111111111111111111111111111111111111111111111111111111111111111"
      );
    });
  });

  it("Negar…: requires mandatory non-empty reason; blocks submission until reason is provided", async () => {
    const { calls } = setupFetchMock();
    render(<ApprovalsInbox bots={mockBots} authMode="gated" />);

    await screen.findByText(/3 ações aguardando sua autorização/i);
    const card = screen.getByTestId("approval-card-req-1");
    const denyBtn = within(card).getByRole("button", { name: /negar…/i });

    fireEvent.click(denyBtn);

    // Modal opens
    const modal = screen.getByRole("dialog");
    expect(modal).toBeDefined();
    const submitDenyBtn = within(modal).getByRole("button", { name: /confirmar negação/i });

    // Initially button is DISABLED because reason is empty
    expect((submitDenyBtn as HTMLButtonElement).disabled).toBe(true);

    // Typing spaces only still keeps it disabled
    const textarea = within(modal).getByLabelText(/motivo da negação/i);
    fireEvent.change(textarea, { target: { value: "   " } });
    expect((submitDenyBtn as HTMLButtonElement).disabled).toBe(true);

    // Typing valid reason enables button
    fireEvent.change(textarea, {
      target: { value: "Comando curl para endpoint não homologado." },
    });
    expect((submitDenyBtn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(submitDenyBtn);

    await waitFor(() => {
      const resolveCall = calls.find((c) => c.url.endsWith("/approvals/req-1/resolve"));
      expect(resolveCall).toBeDefined();
      expect(resolveCall?.body).toEqual({
        digest: "d111111111111111111111111111111111111111111111111111111111111111",
        choice: "deny",
        reason: "Comando curl para endpoint não homologado.",
      });
    });
  });

  it("Loopback auth mode: displays read-only warning banner and disables resolution actions (Contract §1 & §6 loopback_not_human)", async () => {
    const { calls } = setupFetchMock({ authMode: "loopback" });
    render(<ApprovalsInbox bots={mockBots} authMode="loopback" />);

    await screen.findByText(/3 ações aguardando sua autorização/i);

    // Warning banner is displayed
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/Modo loopback ativo/i)).toBeDefined();
    expect(screen.getByText(/loopback_not_human/i)).toBeDefined();

    // Action buttons are disabled
    const card = screen.getByTestId("approval-card-req-1");
    const allowBtn = within(card).getByRole("button", { name: /permitir uma vez/i });
    const alwaysBtn = within(card).getByRole("button", { name: /sempre permitir…/i });
    const denyBtn = within(card).getByRole("button", { name: /negar…/i });

    expect((allowBtn as HTMLButtonElement).disabled).toBe(true);
    expect((alwaysBtn as HTMLButtonElement).disabled).toBe(true);
    expect((denyBtn as HTMLButtonElement).disabled).toBe(true);

    // Clicking does not send any request
    fireEvent.click(allowBtn);
    fireEvent.click(alwaysBtn);
    fireEvent.click(denyBtn);

    const resolveCalls = calls.filter((c) => c.url.includes("/resolve"));
    expect(resolveCalls.length).toBe(0);
  });

  it("Batch resolution: requires explicit multi-selection, checks same action_class_hash, and asks for confirmation", async () => {
    const { calls } = setupFetchMock();
    render(<ApprovalsInbox bots={mockBots} authMode="gated" />);

    await screen.findByText(/3 ações aguardando sua autorização/i);

    // Select req-1 and req-2 (both share hash-class-vendas-curl)
    const card1 = screen.getByTestId("approval-card-req-1");
    const card2 = screen.getByTestId("approval-card-req-2");

    const checkbox1 = within(card1).getByRole("checkbox");
    const checkbox2 = within(card2).getByRole("checkbox");

    fireEvent.click(checkbox1);
    fireEvent.click(checkbox2);

    expect(screen.getByText(/2 selecionado\(s\)/i)).toBeDefined();

    // Click batch allow button
    const batchAllowBtn = screen.getByRole("button", {
      name: /permitir selecionados \(uma vez\)/i,
    });
    fireEvent.click(batchAllowBtn);

    // Batch confirmation dialog must be confirmed explicitly
    const modal = screen.getByRole("dialog");
    expect(modal).toBeDefined();
    expect(screen.getByText(/permitir 2 ações em lote\?/i)).toBeDefined();

    const confirmBatchBtn = within(modal).getByRole("button", {
      name: /confirmar decisão em lote/i,
    });
    fireEvent.click(confirmBatchBtn);

    await waitFor(() => {
      const batchCall = calls.find((c) => c.url.endsWith("/approvals/batch"));
      expect(batchCall).toBeDefined();
      expect(batchCall?.method).toBe("POST");
      expect(batchCall?.body.items).toHaveLength(2);
      expect(batchCall?.body.items[0]).toEqual({
        request_id: "req-1",
        digest: "d111111111111111111111111111111111111111111111111111111111111111",
        choice: "once",
      });
      expect(batchCall?.body.items[1]).toEqual({
        request_id: "req-2",
        digest: "d22222222222222222222222222222222222222222222222222222222222222",
        choice: "once",
      });
    });
  });

  it("Batch resolution: warns and prevents batch action if selected items have different action classes", async () => {
    setupFetchMock();
    render(<ApprovalsInbox bots={mockBots} authMode="gated" />);

    await screen.findByText(/3 ações aguardando sua autorização/i);

    // Select req-1 (vendas curl) and req-3 (dev rm) -> different classes
    const card1 = screen.getByTestId("approval-card-req-1");
    const card3 = screen.getByTestId("approval-card-req-3");

    fireEvent.click(within(card1).getByRole("checkbox"));
    fireEvent.click(within(card3).getByRole("checkbox"));

    expect(screen.getByText(/Classes diferentes selecionadas/i)).toBeDefined();
    const batchAllowBtn = screen.getByRole("button", {
      name: /permitir selecionados \(uma vez\)/i,
    });
    expect((batchAllowBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("Shell updates real approvals counter badge when approvals are loaded", () => {
    render(<MessengerShell approvalsCount={3} />);

    const nav = within(screen.getByRole("navigation"));
    const approvalsBtn = nav.getByRole("button", { name: /aprovações/i });
    expect(approvalsBtn).toBeDefined();
    expect(within(approvalsBtn).getByText("3")).toBeDefined();
  });

  it("Mutation check: sending 'always' as wire choice is strictly blocked and fails", async () => {
    // If client or UI ever sends 'always', resolveApproval throws ApiError per Invariant 6
    await expect(
      resolveApproval("req-1", {
        digest: "d111",
        choice: "always" as any,
      })
    ).rejects.toThrow(/Invariant 6 violation: 'always' is not an allowed wire choice/i);
  });
});

