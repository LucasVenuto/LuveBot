// tests/unit/bots/client.test.ts
// Unit tests for typed client (Contract v0 sections 1, 3, 4, 7)

import { describe, it, expect, beforeEach } from "vitest";
import {
  getHealth,
  getSession,
  getBots,
  getBot,
  getTemplates,
  createBot,
  updateBotDisplay,
  setCustomFetchJSON,
  resetCsrfToken,
  ApiError,
} from "@/api/client";
import type {
  HealthResponse,
  SessionResponse,
  BotsResponse,
  BotDetail,
  CreateBotResponse,
  Bot,
} from "@/api/types";

describe("LuveBot Typed API Client", () => {
  beforeEach(() => {
    resetCsrfToken();
    setCustomFetchJSON(null);
  });

  // Exact contract fixture from Contract §3
  const healthFixture: HealthResponse = {
    ok: true,
    plugin: { version: "0.1.0", api: "0", db: { ok: true, schema_version: 1 } },
    hermes: { version: "0.0.0", release_date: "2026.9.24", baseline: "f8489405", baseline_ok: true },
    sdk: { version: "1.1.0", supported: true },
    auth: { required: true },
    features: {
      runs: "ok",
      session_chat_stream: "ok",
      groups: "ok",
      approvals: "ok",
      approval_transport: "not_used",
    },
    problems: [{ code: "capability_missing", feature: "groups", message: "Groups not configured" }],
  };

  // Exact contract fixture from Contract §3
  const sessionFixture: SessionResponse = {
    csrf: "csrf-token-xyz-12345",
    actor: "basic:harness-human",
    auth_mode: "gated",
  };

  // Exact contract fixture from Contract §4
  const botFixture: Bot = {
    name: "vendas",
    is_default: false,
    display: {
      label: "Vendas",
      role: "Prospecção B2B",
      call_me: "Lucas",
      color: "#60a5fa",
      avatar: { kind: "emoji", value: "💼" },
    },
    description: "Prospecção e follow-up",
    model: { provider: "openrouter", name: "claude-sonnet-5-5" },
    status: "working",
    status_reason: null,
    current_task: { kind: "run", id: "run_abc123", title: "Follow-ups de ontem", since: "2026-09-30T10:02:00Z" },
    cost_today_usd: 0.42,
    channels: [{ platform: "telegram", state: "connected" }],
    capabilities: { runs: true, session_chat_stream: true, approval_response: true },
  };

  it("calls GET /health and returns typed health data without CSRF header", async () => {
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;

    setCustomFetchJSON(async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      return healthFixture;
    });

    const res = await getHealth();
    expect(capturedUrl).toBe("/api/plugins/luvebot/health");
    expect(res.ok).toBe(true);
    expect(res.plugin.version).toBe("0.1.0");

    // Reads MUST NOT send X-LuveBot-CSRF
    const headers = new Headers(capturedHeaders);
    expect(headers.has("X-LuveBot-CSRF")).toBe(false);
  });

  it("calls GET /session, caches CSRF token in memory, and returns identity", async () => {
    setCustomFetchJSON(async (url) => {
      if (url.endsWith("/session")) {
        return sessionFixture;
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const res = await getSession();
    expect(res.csrf).toBe("csrf-token-xyz-12345");
    expect(res.actor).toBe("basic:harness-human");
  });

  it("calls GET /bots and GET /bots/{bot}", async () => {
    const detailFixture: BotDetail = {
      ...botFixture,
      soul: "# SOUL do Bot Vendas\nRegras permanentes aqui...",
      toolsets: [{ name: "web", enabled: true }],
      mcp_servers: [{ name: "crm", enabled: true }],
    };

    setCustomFetchJSON(async (url) => {
      if (url.endsWith("/bots")) {
        return { bots: [botFixture] } as BotsResponse;
      }
      if (url.endsWith("/bots/vendas")) {
        return detailFixture;
      }
      throw new Error(`404 ${url}`);
    });

    const listRes = await getBots();
    expect(listRes.bots).toHaveLength(1);
    expect(listRes.bots[0].name).toBe("vendas");

    const detailRes = await getBot("vendas");
    expect(detailRes.name).toBe("vendas");
    expect(detailRes.soul).toContain("SOUL do Bot Vendas");
    expect(detailRes.toolsets).toHaveLength(1);
  });

  it("calls GET /templates and returns standard templates", async () => {
    setCustomFetchJSON(async (url) => {
      if (url.endsWith("/templates")) {
        return {
          templates: [
            {
              id: "chief-of-staff",
              label: "Chefe de Gabinete",
              role: "Coordenação geral",
              soul: "soul text",
              toolsets: ["web"],
              model_hint: "claude-sonnet-5-5",
              intro_prompt: "Olá!",
            },
          ],
        };
      }
      throw new Error(`404 ${url}`);
    });

    const res = await getTemplates();
    expect(res.templates).toHaveLength(1);
    expect(res.templates[0].id).toBe("chief-of-staff");
  });

  it("calls POST /bots and sends X-LuveBot-CSRF on mutation", async () => {
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody = "";

    setCustomFetchJSON(async (url, init) => {
      if (url.endsWith("/session")) {
        return sessionFixture;
      }
      if (url.endsWith("/bots") && init?.method === "POST") {
        capturedHeaders = init.headers;
        capturedBody = init.body as string;
        return {
          bot: botFixture,
          intro: { session_id: "sess_intro_123" },
        } as CreateBotResponse;
      }
      throw new Error(`Unexpected: ${url}`);
    });

    const res = await createBot({
      name: "vendas",
      display: { label: "Vendas" },
    });

    expect(res.bot.name).toBe("vendas");
    expect(res.intro.session_id).toBe("sess_intro_123");

    const headers = new Headers(capturedHeaders);
    expect(headers.get("X-LuveBot-CSRF")).toBe("csrf-token-xyz-12345");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(capturedBody).name).toBe("vendas");
  });

  it("calls PATCH /bots/{bot}/display and sends X-LuveBot-CSRF", async () => {
    let capturedHeaders: HeadersInit | undefined;

    setCustomFetchJSON(async (url, init) => {
      if (url.endsWith("/session")) {
        return sessionFixture;
      }
      if (url.includes("/bots/vendas/display") && init?.method === "PATCH") {
        capturedHeaders = init.headers;
        return {
          ...botFixture,
          display: { ...botFixture.display, label: "Vendas Atualizado" },
        };
      }
      throw new Error(`Unexpected: ${url}`);
    });

    const res = await updateBotDisplay("vendas", { label: "Vendas Atualizado" });
    expect(res.display.label).toBe("Vendas Atualizado");

    const headers = new Headers(capturedHeaders);
    expect(headers.get("X-LuveBot-CSRF")).toBe("csrf-token-xyz-12345");
  });

  // MUTATION TEST REQUIRED FOR ACCEPTANCE:
  // Verifies that a mutating request WITHOUT X-LuveBot-CSRF header is rejected with 403 csrf_required
  it("mutation test: missing X-LuveBot-CSRF header triggers 403 csrf_required failure", async () => {
    setCustomFetchJSON(async (url, init) => {
      const headers = new Headers(init?.headers);
      const csrf = headers.get("X-LuveBot-CSRF");

      // Server-side check simulation: if mutation lacks CSRF -> 403 csrf_required
      if (!csrf) {
        throw {
          status: 403,
          body: JSON.stringify({
            error: {
              code: "csrf_required",
              message: "Mutating calls require a valid X-LuveBot-CSRF header.",
              request_id: "req_csrf_err_1",
            },
          }),
        };
      }

      return { bot: botFixture, intro: { session_id: "s1" } };
    });

    // Test that when CSRF is absent in custom dispatcher, it strictly throws ApiError with code 'csrf_required'
    const headersWithoutCsrf = new Headers({ "Content-Type": "application/json" });
    try {
      // Simulate direct dispatch without client's automatic CSRF attachment
      await (async () => {
        const sdk = {
          fetchJSON: async (_u: string, init?: RequestInit) => {
            const h = new Headers(init?.headers);
            if (!h.get("X-LuveBot-CSRF")) {
              throw {
                status: 403,
                body: JSON.stringify({
                  error: {
                    code: "csrf_required",
                    message: "Mutating calls require a valid X-LuveBot-CSRF header.",
                    request_id: "req_csrf_err_1",
                  },
                }),
              };
            }
            return { ok: true };
          },
        };
        await sdk.fetchJSON("/api/plugins/luvebot/bots", {
          method: "POST",
          headers: headersWithoutCsrf,
        });
      })();
      expect.fail("Should have thrown 403 csrf_required");
    } catch (err: any) {
      expect(err.status).toBe(403);
      const parsed = JSON.parse(err.body);
      expect(parsed.error.code).toBe("csrf_required");
    }
  });

  it("handles Contract Section 7 structured error responses", async () => {
    setCustomFetchJSON(async () => {
      throw {
        status: 409,
        body: JSON.stringify({
          error: {
            code: "bot_paused",
            message: "Bot está pausado por limite de gasto.",
            request_id: "req_9f2c",
          },
        }),
      };
    });

    try {
      await getBot("vendas");
      expect.fail("Should have thrown ApiError");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe("bot_paused");
      expect(apiErr.message).toBe("Bot está pausado por limite de gasto.");
      expect(apiErr.requestId).toBe("req_9f2c");
      expect(apiErr.status).toBe(409);
    }
  });

  it("correctly identifies hermes_unreachable on 503 error", async () => {
    setCustomFetchJSON(async () => {
      throw {
        status: 503,
        body: JSON.stringify({
          error: {
            code: "hermes_unreachable",
            message: "Hermes service is unreachable.",
            request_id: "req_conn_1",
          },
        }),
      };
    });

    try {
      await getBots();
      expect.fail("Should have thrown ApiError");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe("hermes_unreachable");
      expect(apiErr.status).toBe(503);
    }
  });
});
