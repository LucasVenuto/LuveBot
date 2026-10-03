// dashboard/src/api/client.ts
// Typed client for LuveBot plugin API v0 (docs/contracts/plugin-api-v0.md)
// Uses SDK fetchJSON, sends X-LuveBot-CSRF on mutations, handles Section 7 errors, NEVER EventSource.

import { getSDK } from "../sdk";
import type {
  HealthResponse,
  SessionResponse,
  BotsResponse,
  Bot,
  BotDetail,
  TemplatesResponse,
  CreateBotRequest,
  CreateBotResponse,
  UpdateBotDisplayRequest,
  ApiErrorPayload,
  ApprovalsResponse,
  ResolveApprovalRequest,
  ResolveApprovalResponse,
  BatchResolveRequest,
  BatchResolveResponse,
  RunApprovalRequest,
  Rule,
  RuleWithSeal,
  RulesResponse,
  RuleAction,
  Simulation,
  SealResult,
  CostPeriod,
  CostGroupKey,
  CostsResponse,
  BudgetSnapshot,
  SetBudgetLimitRequest,
  SetBudgetLimitResponse,
  ResumeBotBudgetResponse,
  Routine,
  RoutineDetail,
  RoutineRun,
  RoutinesResponse,
  RoutineRunsResponse,
  CreateRoutineRequest,
  UpdateRoutineRequest,
  ActivityFilterParams,
  ActivityResponse,
  ActivityContextRequest,
  ActivityRedirectRequest,
  ActivityStopRequest,
  ActivityItem,
  Room,
  RoomMember,
  RoomResponse,
  RoomsListResponse,
  RoomLogResponse,
  CreateRoomRequest,
  PatchRoomRequest,
  SendRoomMessageRequest,
  SendRoomMessageResponse,
  StopRoomResponse,
  Handoff,
  HandoffsListResponse,
  PauseRequest,
  PauseResponse,
  CreateHandoffRequest,
  TeamMapResponse,
  SearchParams,
  SearchResponse,
  PagesListResponse,
  PageWithContent,
  PageRevisionsResponse,
  PageRevisionWithContent,
  PageSaveResponse,
  HistorySessionsResponse,
  HistoryMessagesResponse,
  ApprovalSurface,
  HookInstallResult,
  ApprovalSurfaceMode,
  BotScreen,
  ScreenTicket,
  ScreenLease,
  Attachment,
  PagesWorkspaceState,
  IntroductionView,
} from "./types";

export const BASE_API_PATH = "/api/plugins/luvebot";

export class ApiError extends Error {
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
  readonly status: number;
  readonly rawBody?: string;
  readonly details?: Record<string, any>;

  constructor(opts: {
    code: string;
    message: string;
    requestId?: string;
    status: number;
    rawBody?: string;
    details?: Record<string, any>;
  }) {
    super(opts.message);
    this.name = "ApiError";
    this.code = opts.code;
    this.message = opts.message;
    this.requestId = opts.requestId;
    this.status = opts.status;
    this.rawBody = opts.rawBody;
    this.details = opts.details;
  }
}

// In-memory CSRF token cache (never written to window, localStorage or cookie — T7)
let _inMemoryCsrf: string | null = null;

// Allow plugging in a custom fetchJSON for testing
type FetchJSONFn = (
  url: string,
  init?: RequestInit,
  options?: { allowUnauthorized?: boolean }
) => Promise<any>;

let _customFetchJSON: FetchJSONFn | null = null;

export function setCustomFetchJSON(fn: FetchJSONFn | null): void {
  _customFetchJSON = fn;
}

export function resetCsrfToken(): void {
  _inMemoryCsrf = null;
}

export function getCachedCsrf(): string | null {
  return _inMemoryCsrf;
}

export function setCachedCsrf(token: string | null): void {
  _inMemoryCsrf = token;
}

/**
 * Maps HTTP status codes to canonical LuveBot API v0 error codes (Section 7).
 */
function defaultErrorCode(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthenticated";
    case 403:
      return "csrf_required";
    case 404:
      return "bot_not_found";
    case 409:
      return "conflict";
    case 413:
      return "too_large";
    case 422:
      return "invalid_name";
    case 429:
      return "rate_limited";
    case 501:
      return "not_implemented";
    case 502:
      return "hermes_error";
    case 503:
      return "hermes_unreachable";
    case 504:
      return "hermes_timeout";
    default:
      return "unknown_error";
  }
}

/**
 * Attempts to parse an error response body conforming to Contract §7:
 * { "error": { "code": "...", "message": "...", "request_id": "..." } }
 */
function parseApiError(err: unknown, statusFallback = 500): ApiError {
  if (err instanceof ApiError) {
    return err;
  }

  let status = statusFallback;
  let rawBody = "";
  let message = "Erro inesperado na comunicação com o LuveBot.";
  let code = defaultErrorCode(status);
  let requestId: string | undefined = undefined;
  let details: Record<string, any> | undefined = undefined;
  let enveloped = false;  // the body is LuveBot's own error (contract §7), not the dashboard's

  if (err && typeof err === "object") {
    const errorRecord = err as Record<string, unknown>;

    if (typeof errorRecord.status === "number") {
      status = errorRecord.status;
      code = defaultErrorCode(status);
    }

    if (typeof errorRecord.details === "object" && errorRecord.details !== null) {
      details = errorRecord.details as Record<string, any>;
    }

    if (typeof errorRecord.body === "string") {
      rawBody = errorRecord.body;
    } else if (typeof errorRecord.message === "string") {
      rawBody = errorRecord.message;
    }

    // Try parsing raw JSON body if available
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody) as ApiErrorPayload;
        if (parsed?.error) {
          enveloped = true;
          if (parsed.error.code) code = parsed.error.code;
          if (parsed.error.message) message = parsed.error.message;
          if (parsed.error.request_id) requestId = parsed.error.request_id;
          if (parsed.error.details) details = parsed.error.details;
        }
      } catch {
        // Not JSON formatted; use rawBody as message if reasonably sized
        if (rawBody.trim() && rawBody.length < 300 && !rawBody.trim().startsWith("<")) {
          message = rawBody.trim();
        }
      }
    }
  } else if (typeof err === "string") {
    rawBody = err;
    message = err;
  }

  // A 404 without our envelope: the dashboard has no such route, i.e. the LuveBot backend it runs predates this UI (an update
  // that needs the dashboard restarted to mount the new routes). Never "Bot não encontrado": every route of ours answers its
  // own 404s with the envelope. The SDK's fetchJSON error carries {status, body} (web/src/lib/api-error.ts).
  // A POST/PUT/DELETE to such a route gets 405 {"detail":"Method Not Allowed"} instead (the dashboard's catch-all answers GET
  // only; seen in the harness on POST /attachments before a restart): the same case.
  if ((status === 404 || status === 405) && !enveloped) code = "plugin_route_missing";

  return new ApiError({
    code,
    message,
    requestId,
    status,
    rawBody,
    details,
  });
}

/**
 * Low-level dispatch via SDK fetchJSON or fallback.
 */
async function dispatchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  if (_customFetchJSON) {
    return (await _customFetchJSON(url, init)) as T;
  }

  const sdk = getSDK();
  if (sdk?.fetchJSON) {
    return sdk.fetchJSON<T>(url, init);
  }

  if (typeof fetch !== "undefined") {
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw parseApiError({ status: res.status, body: text });
    }
    return res.json() as Promise<T>;
  }

  throw new ApiError({
    code: "sdk_unavailable",
    message: "Hermes Plugin SDK fetchJSON is not available in this environment.",
    status: 503,
  });
}

/**
 * Generic request helper. Handles CSRF injection on mutations and error parsing.
 */
async function request<T>(
  path: string,
  init: RequestInit = {},
  isMutation = false
): Promise<T> {
  const url = `${BASE_API_PATH}${path}`;
  const headers = new Headers(init.headers || {});

  if (isMutation) {
    // Mutations (POST, PATCH, PUT, DELETE) MUST send X-LuveBot-CSRF (Contract §1 & §7)
    if (!_inMemoryCsrf) {
      const session = await getSession();
      _inMemoryCsrf = session.csrf;
    }
    headers.set("X-LuveBot-CSRF", _inMemoryCsrf);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }

  try {
    return await dispatchJSON<T>(url, {
      ...init,
      headers,
    });
  } catch (err: unknown) {
    const apiError = parseApiError(err);
    // If CSRF was rejected, invalidate the cached token
    if (apiError.code === "csrf_required" || apiError.status === 403) {
      _inMemoryCsrf = null;
    }
    throw apiError;
  }
}

// ---------------------------------------------------------------------------
// Typed API Methods (Contract §3 & §4)
// ---------------------------------------------------------------------------

/**
 * GET /health (Contract §3)
 * Reports plugin and compatibility state. Never fails with 5xx for unhealthy dependencies.
 */
export async function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health", { method: "GET" }, false);
}

/**
 * GET /session (Contract §3)
 * Retrieves CSRF token, actor identity and auth_mode.
 */
export async function getSession(): Promise<SessionResponse> {
  const session = await request<SessionResponse>("/session", { method: "GET" }, false);
  if (session?.csrf) {
    _inMemoryCsrf = session.csrf;
  }
  return session;
}

/**
 * GET /bots (Contract §4)
 * Returns the list of all Bots (Hermes profiles merged with LuveBot metadata).
 */
export async function getBots(): Promise<BotsResponse> {
  return request<BotsResponse>("/bots", { method: "GET" }, false);
}

/**
 * GET /bots/{bot} (Contract §4)
 * Returns a specific Bot along with its soul and toolsets.
 */
export async function getBot(botName: string): Promise<BotDetail> {
  return request<BotDetail>(`/bots/${encodeURIComponent(botName)}`, { method: "GET" }, false);
}

/**
 * GET /templates (Contract §4)
 * Returns available starter templates for creating Bots.
 */
export async function getTemplates(): Promise<TemplatesResponse> {
  return request<TemplatesResponse>("/templates", { method: "GET" }, false);
}

/**
 * POST /bots (Contract §4)
 * Mutating, audited call to create a new Bot profile.
 * Sends X-LuveBot-CSRF header.
 */
export async function createBot(req: CreateBotRequest): Promise<CreateBotResponse> {
  return request<CreateBotResponse>(
    "/bots",
    {
      method: "POST",
      body: JSON.stringify(req),
    },
    true
  );
}

/**
 * PATCH /bots/{bot}/display (Contract §4)
 * Mutating, audited call to update a Bot's display metadata.
 * Sends X-LuveBot-CSRF header.
 */
export async function updateBotDisplay(
  botName: string,
  req: UpdateBotDisplayRequest
): Promise<Bot> {
  return request<Bot>(
    `/bots/${encodeURIComponent(botName)}/display`,
    {
      method: "PATCH",
      body: JSON.stringify(req),
    },
    true
  );
}

// ---------------------------------------------------------------------------
// Sessions and runs (Contract §5). Mutations send X-LuveBot-CSRF through request().
// ---------------------------------------------------------------------------

export interface RunInfo {
  id: string;
  status: string; // started | waiting_for_approval | stopping | completed | failed | cancelled | unknown
  status_raw?: string;
  session_id?: string | null;
  output?: string | null; // the final answer once completed (contract §5, _run_view)
}

const botPath = (bot: string) => `/bots/${encodeURIComponent(bot)}`;

/** D-025 §d: where this Bot's approvals are answered. GET reads; PUT is audited by the backend and needs CSRF. */
export async function getApprovalSurface(bot: string): Promise<{ approval_surface: ApprovalSurface }> {
  return request(`${botPath(bot)}/approval-surface`, { method: "GET" }, false);
}
export async function putApprovalSurface(bot: string, body: { mode: ApprovalSurfaceMode; approvers?: string[] }): Promise<{ approval_surface: ApprovalSurface }> {
  return request(`${botPath(bot)}/approval-surface`, { method: "PUT", body: JSON.stringify(body) }, true);
}

/** POST /bots/{bot}/hook/install (ADR-003 3.3): installs or updates the LuveBot rules hook in the Bot. No body; CSRF; audited. */
export async function installBotHook(bot: string): Promise<HookInstallResult> {
  return request<HookInstallResult>(`${botPath(bot)}/hook/install`, { method: "POST" }, true);
}

/** D-007 §4: the Bot's live screen. GET reads Hermes's own status; every POST is audited by the backend and needs CSRF. */
export async function getScreen(bot: string): Promise<{ screen: BotScreen }> {
  return request(`${botPath(bot)}/screen`, { method: "GET" }, false);
}
export async function startScreen(bot: string): Promise<{ screen: BotScreen }> {
  return request(`${botPath(bot)}/screen/start`, { method: "POST" }, true);
}
export async function watchScreen(bot: string): Promise<ScreenTicket> {
  return request(`${botPath(bot)}/screen/watch`, { method: "POST" }, true);
}
export async function takeScreen(bot: string, reason?: string): Promise<ScreenTicket> {
  return request(`${botPath(bot)}/screen/take`, { method: "POST", ...(reason ? { body: JSON.stringify({ reason }) } : {}) }, true);
}
export async function returnScreen(bot: string): Promise<{ lease: ScreenLease }> {
  return request(`${botPath(bot)}/screen/return`, { method: "POST" }, true);
}

/** GET /bots/{bot}/sessions (contract v0.4 B1): the Bot's sessions, redacted by the backend; rooms are never listed. */
export async function getBotSessions(bot: string, params: { limit?: number; cursor?: string } = {}): Promise<HistorySessionsResponse> {
  const q = new URLSearchParams();
  if (params.limit) q.set("limit", String(params.limit));
  if (params.cursor) q.set("cursor", params.cursor);
  const qs = q.toString();
  return request(`${botPath(bot)}/sessions${qs ? `?${qs}` : ""}`, { method: "GET" }, false);
}

/** GET /bots/{bot}/sessions/{sid}/messages (contract v0.4 B1): one page, chronological, redacted and capped. */
export async function getSessionMessages(bot: string, sid: string, params: { limit?: number; before?: string } = {}): Promise<HistoryMessagesResponse> {
  const q = new URLSearchParams();
  if (params.limit) q.set("limit", String(params.limit));
  if (params.before) q.set("before", params.before);
  const qs = q.toString();
  return request(`${botPath(bot)}/sessions/${encodeURIComponent(sid)}/messages${qs ? `?${qs}` : ""}`, { method: "GET" }, false);
}

/** POST /bots/{bot}/sessions (§5) */
export async function createSession(bot: string, title?: string): Promise<{ session: { id: string; title?: string } }> {
  return request(`${botPath(bot)}/sessions`, { method: "POST", body: JSON.stringify(title ? { title } : {}) }, true);
}

/** POST /bots/{bot}/runs (§5): 202 { run } */
export async function createRun(
  bot: string,
  req: { input: string; session_id?: string; idempotency_key?: string; page?: { slug: string } }, // page: v0.5 §7.2
): Promise<{ run: RunInfo }> {
  return request(`${botPath(bot)}/runs`, { method: "POST", body: JSON.stringify(req) }, true);
}

/** GET /bots/{bot}/runs/{id} (§5): the status Hermes keeps */
export async function getRun(bot: string, runId: string): Promise<{ run: RunInfo }> {
  return request(`${botPath(bot)}/runs/${encodeURIComponent(runId)}`, { method: "GET" }, false);
}

/** POST /bots/{bot}/runs/{id}/stop (§5): 202 { run: { status: "stopping" } } */
export async function stopRun(bot: string, runId: string): Promise<{ run: RunInfo }> {
  return request(`${botPath(bot)}/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" }, true);
}

/** Stream URLs (§5, §6): consumed with lib/stream openStream, never EventSource. */
export const runEventsUrl = (bot: string, runId: string) => `${BASE_API_PATH}${botPath(bot)}/runs/${encodeURIComponent(runId)}/events`;
export const chatStreamUrl = (bot: string, sessionId: string) => `${BASE_API_PATH}${botPath(bot)}/sessions/${encodeURIComponent(sessionId)}/chat/stream`;

/** CSRF header value for mutating streams (chat/stream POST); fetched once, kept in memory only. */
export async function getCsrf(): Promise<string> {
  return _inMemoryCsrf ?? (await getSession()).csrf;
}

// ---------------------------------------------------------------------------
// Approvals (Contract v0.1 §1, §2, §6 & ADR-002)
// ---------------------------------------------------------------------------

/**
 * GET /approvals (Contract v0.1 §2)
 * Returns the list of pending approvals from transport or runs.
 */
export async function getApprovals(cursor?: string): Promise<ApprovalsResponse> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request<ApprovalsResponse>(`/approvals${query}`, { method: "GET" }, false);
}

/**
 * POST /approvals/{request_id}/resolve (Contract v0.1 §1, §2)
 * Resolves an approval with choice 'once' or 'deny'.
 * Invariant 6: LuveBot never sends 'always' over the wire. 'Sempre permitir' creates a draft rule and sends 'once'.
 * Sends X-LuveBot-CSRF header.
 */
export async function resolveApproval(
  requestId: string,
  req: ResolveApprovalRequest
): Promise<ResolveApprovalResponse> {
  if ((req.choice as string) === "always") {
    throw new ApiError({
      code: "invalid_choice",
      message: "Invariant 6 violation: 'always' is not an allowed wire choice. Only 'once' or 'deny' are permitted.",
      status: 400,
    });
  }
  return request<ResolveApprovalResponse>(
    `/approvals/${encodeURIComponent(requestId)}/resolve`,
    {
      method: "POST",
      body: JSON.stringify(req),
    },
    true
  );
}

/**
 * POST /approvals/batch (Contract v0.1 §1, §2)
 * Batch resolves approvals sharing the same action_class_hash (up to 50 items).
 * Sends X-LuveBot-CSRF header.
 */
export async function batchResolveApprovals(
  req: BatchResolveRequest
): Promise<BatchResolveResponse> {
  for (const item of req.items) {
    if ((item.choice as string) === "always") {
      throw new ApiError({
        code: "invalid_choice",
        message: "Invariant 6 violation: 'always' is not an allowed wire choice in batch resolution.",
        status: 400,
      });
    }
  }
  return request<BatchResolveResponse>(
    "/approvals/batch",
    {
      method: "POST",
      body: JSON.stringify(req),
    },
    true
  );
}

/**
 * POST /bots/{bot}/runs/{id}/approval (Contract v0.1 §1, §2)
 * Resolves an approval request on a specific run.
 * Sends X-LuveBot-CSRF header.
 */
export async function resolveRunApproval(
  bot: string,
  runId: string,
  req: RunApprovalRequest
): Promise<ResolveApprovalResponse> {
  if ((req.choice as string) === "always") {
    throw new ApiError({
      code: "invalid_choice",
      message: "Invariant 6 violation: 'always' is not an allowed wire choice. Only 'once' or 'deny' are permitted.",
      status: 400,
    });
  }
  return request<ResolveApprovalResponse>(
    `${botPath(bot)}/runs/${encodeURIComponent(runId)}/approval`,
    {
      method: "POST",
      body: JSON.stringify(req),
    },
    true
  );
}

// ---------------------------------------------------------------------------
// Rules & Simulation (Contract v0.1 §3 & ADR-002)
// ---------------------------------------------------------------------------

/**
 * GET /rules (Contract v0.1 §3)
 * Reads rules and recomputed live seals. Without `bot`, a global rule's seal is the AGGREGATE over every Bot (broken if any
 * Bot is broken, problems prefixed "<bot>: …"); a screen about one Bot passes `bot` (?bot=) to get that Bot's own seal
 * and only the rules that apply to it (invariant 8: the seal shown is the one the backend computed for what is shown).
 */
export async function getRules(cursor?: string, bot?: string): Promise<RulesResponse> {
  const q = new URLSearchParams();
  if (cursor) q.set("cursor", cursor);
  if (bot) q.set("bot", bot);
  const query = q.toString() ? `?${q}` : "";
  return request<RulesResponse>(`/rules${query}`, { method: "GET" }, false);
}

/**
 * POST /rules (Contract v0.1 §3)
 * Human creation produces a draft rule.
 * Sends X-LuveBot-CSRF header.
 */
export async function createRule(
  rule: Partial<Rule>
): Promise<{ ok?: boolean; rule: Rule; seal_result: SealResult }> {
  return request<{ ok?: boolean; rule: Rule; seal_result: SealResult }>(
    "/rules",
    {
      method: "POST",
      body: JSON.stringify(rule),
    },
    true
  );
}

/**
 * PATCH /rules (Contract v0.1 §3)
 * Transitions draft -> active, suggestion -> draft, or archives rule.
 * Refuses built-in edits/activation/archival.
 * In loopback mode, activation returns 403 loopback_not_human (D-012).
 * Sends X-LuveBot-CSRF header.
 */
export async function patchRule(
  update: { id: string; version: number; [key: string]: any }
): Promise<{ ok?: boolean; rule: Rule; seal_result: SealResult }> {
  return request<{ ok?: boolean; rule: Rule; seal_result: SealResult }>(
    "/rules",
    {
      method: "PATCH",
      body: JSON.stringify(update),
    },
    true
  );
}

/**
 * POST /rules/simulate (Contract v0.1 §3)
 * Pure evaluation only against live state and stored rules.
 * Returns decision, seals, and effective mechanisms.
 */
export async function simulateRule(action: RuleAction): Promise<Simulation> {
  return request<Simulation>(
    "/rules/simulate",
    {
      method: "POST",
      body: JSON.stringify(action),
    },
    true
  );
}

// ---------------------------------------------------------------------------
// Costs & Budget (Contract v0.2 §4)
// ---------------------------------------------------------------------------

/**
 * GET /costs (Contract v0.2 §4)
 * Query period (day, 7d, month, 30d), group (bot, model, routine, day), bot.
 */
export async function getCosts(params?: {
  period?: CostPeriod;
  group?: CostGroupKey;
  bot?: string;
}): Promise<CostsResponse> {
  const q = new URLSearchParams();
  if (params?.period) q.set("period", params.period);
  if (params?.group) q.set("group", params.group);
  if (params?.bot) q.set("bot", params.bot);
  const qs = q.toString() ? `?${q.toString()}` : "";
  return request<CostsResponse>(`/costs${qs}`, { method: "GET" }, false);
}

/**
 * GET /budget (Contract v0.2 §4)
 * Returns limits, paused bots, watcher status, and alerts.
 */
export async function getBudget(): Promise<BudgetSnapshot> {
  return request<BudgetSnapshot>("/budget", { method: "GET" }, false);
}

/**
 * PUT /budget/limits (Contract v0.2 §4)
 * Sets or updates a budget limit. cents: null removes the limit.
 * Sends X-LuveBot-CSRF header.
 */
export async function setBudgetLimit(
  req: SetBudgetLimitRequest
): Promise<SetBudgetLimitResponse> {
  return request<SetBudgetLimitResponse>(
    "/budget/limits",
    {
      method: "PUT",
      body: JSON.stringify(req),
    },
    true
  );
}

/**
 * POST /bots/{bot}/budget/resume (Contract v0.2 §4)
 * Resumes a bot paused due to budget breach.
 * Requires human confirmation. In loopback mode, returns 403 loopback_not_human.
 * Sends X-LuveBot-CSRF header.
 */
export async function resumeBotBudget(
  bot: string
): Promise<ResumeBotBudgetResponse> {
  return request<ResumeBotBudgetResponse>(
    `/bots/${encodeURIComponent(bot)}/budget/resume`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
    true
  );
}

// ---------------------------------------------------------------------------
// Routines (Contract v0.2 §3)
// ---------------------------------------------------------------------------

/**
 * GET /routines (Contract v0.2 §3)
 * Lists cron jobs per profile with caps and budget pause status.
 */
export async function getRoutines(params?: {
  bot?: string;
  state?: string;
  limit?: number;
  cursor?: string;
}): Promise<RoutinesResponse> {
  const q = new URLSearchParams();
  if (params?.bot) q.set("bot", params.bot);
  if (params?.state) q.set("state", params.state);
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.cursor) q.set("cursor", params.cursor);
  const qs = q.toString() ? `?${q.toString()}` : "";
  return request<RoutinesResponse>(`/routines${qs}`, { method: "GET" }, false);
}

/**
 * GET /routines/{id} (Contract v0.2 §3)
 * Reads routine details, prompt, input source and delivery.
 */
export async function getRoutine(id: string): Promise<RoutineDetail> {
  return request<RoutineDetail>(
    `/routines/${encodeURIComponent(id)}`,
    { method: "GET" },
    false
  );
}

/**
 * GET /routines/{id}/runs (Contract v0.2 §3)
 * Full history paged by offset cursor without 20 or 100 limit.
 */
export async function getRoutineRuns(
  id: string,
  params?: { limit?: number; cursor?: string }
): Promise<RoutineRunsResponse> {
  const q = new URLSearchParams();
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.cursor) q.set("cursor", params.cursor);
  const qs = q.toString() ? `?${q.toString()}` : "";
  return request<RoutineRunsResponse>(
    `/routines/${encodeURIComponent(id)}/runs${qs}`,
    { method: "GET" },
    false
  );
}

/**
 * Fetches all routine runs across all pages using offset pagination (A-25).
 * Guarantees complete history without a 20 or 100 limit.
 */
export async function fetchAllRoutineRuns(
  id: string,
  limitPerPage = 100
): Promise<{ runs: RoutineRun[]; truncated: boolean }> {
  let allRuns: RoutineRun[] = [];
  let cursor: string | undefined = undefined;
  let isTruncated = false;

  do {
    const res: RoutineRunsResponse = await getRoutineRuns(id, {
      limit: limitPerPage,
      cursor,
    });
    if (res.runs && res.runs.length > 0) {
      allRuns = allRuns.concat(res.runs);
    }
    if (res.truncated) {
      isTruncated = true;
    }
    cursor = res.next_cursor || undefined;
  } while (cursor);

  return { runs: allRuns, truncated: isTruncated };
}

/**
 * POST /routines (Contract v0.2 §3)
 * Creates routine paused unless start: true.
 * Sends X-LuveBot-CSRF header.
 */
export async function createRoutine(
  req: CreateRoutineRequest
): Promise<{ routine: Routine }> {
  return request<{ routine: Routine }>(
    "/routines",
    {
      method: "POST",
      body: JSON.stringify(req),
    },
    true
  );
}

/**
 * PATCH /routines/{id} (Contract v0.2 §3)
 * Updates routine fields from allowlist.
 * Sends X-LuveBot-CSRF header.
 */
export async function updateRoutine(
  id: string,
  req: UpdateRoutineRequest
): Promise<{ routine: Routine }> {
  return request<{ routine: Routine }>(
    `/routines/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify(req),
    },
    true
  );
}

/**
 * POST /routines/{id}/duplicate (Contract v0.2 §3)
 * Duplicates stored record with new id, paused.
 * Sends X-LuveBot-CSRF header.
 */
export async function duplicateRoutine(
  id: string
): Promise<{ routine: Routine }> {
  return request<{ routine: Routine }>(
    `/routines/${encodeURIComponent(id)}/duplicate`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
    true
  );
}

/**
 * POST /routines/{id}/pause (Contract v0.2 §3)
 * Pauses routine.
 * Sends X-LuveBot-CSRF header.
 */
export async function pauseRoutine(
  id: string
): Promise<{ routine?: Routine }> {
  return request<{ routine?: Routine }>(
    `/routines/${encodeURIComponent(id)}/pause`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
    true
  );
}

/**
 * POST /routines/{id}/resume (Contract v0.2 §3)
 * Resumes routine. Refuses 409 if bot is paused by budget.
 * Sends X-LuveBot-CSRF header.
 */
export async function resumeRoutine(
  id: string
): Promise<{ routine?: Routine }> {
  return request<{ routine?: Routine }>(
    `/routines/${encodeURIComponent(id)}/resume`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
    true
  );
}

/**
 * POST /routines/{id}/test (Contract v0.2 §3)
 * Runs test execution ("Rodar teste", confirm: true).
 * Paused jobs refused with 409 routine_paused.
 * Sends X-LuveBot-CSRF header.
 */
export async function testRoutine(
  id: string
): Promise<{ routine?: Routine; started?: boolean }> {
  return request<{ routine?: Routine; started?: boolean }>(
    `/routines/${encodeURIComponent(id)}/test`,
    {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    },
    true
  );
}

/**
 * DELETE /routines/{id} (Contract v0.2 §3)
 * Removes routine. Requires confirm_name.
 * Sends X-LuveBot-CSRF header.
 */
export async function deleteRoutine(
  id: string,
  confirmName: string
): Promise<{ ok?: boolean }> {
  return request<{ ok?: boolean }>(
    `/routines/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ confirm_name: confirmName }),
    },
    true
  );
}

/**
 * GET /activity (Contract v0.2 §2)
 * Returns merged activity items across runs, routines, and tasks.
 */
export async function getActivity(
  params: ActivityFilterParams
): Promise<ActivityResponse> {
  const q = new URLSearchParams();
  q.set("tab", params.tab);
  if (params.bot && params.bot !== "all") q.set("bot", params.bot);
  if (params.room) q.set("room", params.room);
  if (params.origin && params.origin !== "all") q.set("origin", params.origin);
  if (params.status && params.status !== "all") q.set("status", params.status);
  if (params.since) q.set("since", params.since);
  if (params.until) q.set("until", params.until);
  if (params.min_cost_cents !== undefined) q.set("min_cost_cents", String(params.min_cost_cents));
  if (params.limit !== undefined) q.set("limit", String(params.limit));
  if (params.cursor) q.set("cursor", params.cursor);

  return request<ActivityResponse>(
    `/activity?${q.toString()}`,
    { method: "GET" },
    false
  );
}

/**
 * POST /activity/{id}/context (Contract v0.2 §2)
 * Adds context or correction to an activity item.
 * Sends X-LuveBot-CSRF header.
 */
export async function addActivityContext(
  id: string,
  req: ActivityContextRequest
): Promise<{ ok?: boolean }> {
  return request<{ ok?: boolean }>(
    `/activity/${encodeURIComponent(id)}/context`,
    {
      method: "POST",
      body: JSON.stringify(req),
    },
    true
  );
}

/**
 * POST /activity/{id}/redirect (Contract v0.2 §2)
 * Reassigns/redirects an activity item to another bot.
 * Sends X-LuveBot-CSRF header.
 */
export async function redirectActivity(
  id: string,
  req: ActivityRedirectRequest
): Promise<{ ok?: boolean }> {
  return request<{ ok?: boolean }>(
    `/activity/${encodeURIComponent(id)}/redirect`,
    {
      method: "POST",
      body: JSON.stringify(req),
    },
    true
  );
}

/**
 * POST /activity/{id}/stop (Contract v0.2 §2)
 * Stops an active activity item.
 * Sends X-LuveBot-CSRF header.
 */
export async function stopActivity(
  id: string,
  req?: ActivityStopRequest
): Promise<{ ok?: boolean }> {
  return request<{ ok?: boolean }>(
    `/activity/${encodeURIComponent(id)}/stop`,
    {
      method: "POST",
      body: JSON.stringify(req || {}),
    },
    true
  );
}

/**
 * GET /rooms (Contract v0.3 §3.2)
 * Lists rooms with metadata.
 */
export async function getRooms(params?: {
  include_disbanded?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<RoomsListResponse> {
  const q = new URLSearchParams();
  if (params?.include_disbanded) q.set("include_disbanded", "true");
  if (params?.limit !== undefined) q.set("limit", String(params.limit));
  if (params?.cursor) q.set("cursor", params.cursor);

  const query = q.toString();
  return request<RoomsListResponse>(
    query ? `/rooms?${query}` : "/rooms",
    { method: "GET" },
    false
  );
}

/**
 * GET /rooms/{room} (Contract v0.3 §3.2)
 * Gets room state and metadata.
 */
export async function getRoom(roomId: string): Promise<RoomResponse> {
  return request<RoomResponse>(
    `/rooms/${encodeURIComponent(roomId)}`,
    { method: "GET" },
    false
  );
}

/**
 * GET /rooms/{room}/log (Contract v0.3 §3.2)
 * Gets redacted room events log.
 */
export async function getRoomLog(
  roomId: string,
  params?: { since_seq?: number; limit?: number }
): Promise<RoomLogResponse> {
  const q = new URLSearchParams();
  if (params?.since_seq !== undefined) q.set("since_seq", String(params.since_seq));
  if (params?.limit !== undefined) q.set("limit", String(params.limit));

  const query = q.toString();
  return request<RoomLogResponse>(
    query ? `/rooms/${encodeURIComponent(roomId)}/log?${query}` : `/rooms/${encodeURIComponent(roomId)}/log`,
    { method: "GET" },
    false
  );
}

/**
 * POST /rooms (Contract v0.3 §3.2)
 * Creates a room with 2 to 6 member bots.
 * Sends X-LuveBot-CSRF header.
 */
export async function createRoom(data: CreateRoomRequest): Promise<RoomResponse> {
  return request<RoomResponse>(
    "/rooms",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true
  );
}

/**
 * PATCH /rooms/{room} (Contract v0.3 §3.2)
 * Updates room name, goal, owner, or coordinator.
 * Sends X-LuveBot-CSRF header.
 */
export async function patchRoom(
  roomId: string,
  data: PatchRoomRequest
): Promise<RoomResponse> {
  return request<RoomResponse>(
    `/rooms/${encodeURIComponent(roomId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(data),
    },
    true
  );
}

/**
 * POST /rooms/{room}/messages (Contract v0.3 §3.2, §3.3)
 * Sends a message to a room.
 * Sends X-LuveBot-CSRF header.
 */
export async function sendRoomMessage(
  roomId: string,
  data: SendRoomMessageRequest
): Promise<SendRoomMessageResponse> {
  return request<SendRoomMessageResponse>(
    `/rooms/${encodeURIComponent(roomId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true
  );
}

/**
 * POST /rooms/{room}/stop (Contract v0.3 §3.2)
 * Stops queued and running work of the whole room.
 * Sends X-LuveBot-CSRF header.
 */
export async function stopRoom(roomId: string): Promise<StopRoomResponse> {
  return request<StopRoomResponse>(
    `/rooms/${encodeURIComponent(roomId)}/stop`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
    true
  );
}

/**
 * POST /rooms/{room}/tasks/{task_id}/retry (Contract v0.3 §3.2)
 * Retries an indeterminate room task.
 * Sends X-LuveBot-CSRF header.
 */
export async function retryRoomTask(
  roomId: string,
  taskId: string
): Promise<{ retried: boolean }> {
  return request<{ retried: boolean }>(
    `/rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}/retry`,
    {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    },
    true
  );
}

/**
 * DELETE /rooms/{room} (Contract v0.3 §3.2)
 * Disbands a room permanently.
 * Sends X-LuveBot-CSRF header.
 */
export async function disbandRoom(
  roomId: string,
  confirmName: string
): Promise<{ disbanded: boolean }> {
  return request<{ disbanded: boolean }>(
    `/rooms/${encodeURIComponent(roomId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ confirm_name: confirmName }),
    },
    true
  );
}

/**
 * GET /handoffs (Contract v0.3 §4.3)
 * Lists handoffs with filters.
 */
export async function getHandoffs(params?: {
  room?: string;
  bot?: string;
  state?: string;
  limit?: number;
  cursor?: string;
}): Promise<HandoffsListResponse> {
  const q = new URLSearchParams();
  if (params?.room) q.set("room", params.room);
  if (params?.bot) q.set("bot", params.bot);
  if (params?.state) q.set("state", params.state);
  if (params?.limit !== undefined) q.set("limit", String(params.limit));
  if (params?.cursor) q.set("cursor", params.cursor);

  const query = q.toString();
  return request<HandoffsListResponse>(
    query ? `/handoffs?${query}` : "/handoffs",
    { method: "GET" },
    false
  );
}

/**
 * POST /handoffs (Contract v0.3 §4.3)
 * Creates a handoff task between two bots.
 * Sends X-LuveBot-CSRF header.
 */
export async function createHandoff(
  data: CreateHandoffRequest
): Promise<{ handoff: Handoff; task_id: string }> {
  return request<{ handoff: Handoff; task_id: string }>(
    "/handoffs",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true
  );
}

/**
 * POST /handoffs/{id}/promote (Contract v0.3 §4.3)
 * Moves a triage handoff task to ready.
 * Sends X-LuveBot-CSRF header.
 */
export async function promoteHandoff(
  handoffId: string
): Promise<{ promoted: boolean }> {
  return request<{ promoted: boolean }>(
    `/handoffs/${encodeURIComponent(handoffId)}/promote`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
    true
  );
}

/**
 * POST /handoffs/{id}/cancel (Contract v0.3 §4.3)
 * Cancels a handoff task.
 * Sends X-LuveBot-CSRF header.
 */
export async function cancelHandoff(
  handoffId: string
): Promise<{ cancelled: boolean }> {
  return request<{ cancelled: boolean }>(
    `/handoffs/${encodeURIComponent(handoffId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
    true
  );
}

/**
 * GET /map?window=7d|30d (Contract v0.3 §5, spec §4.12)
 * Fetches Team Map nodes and edges.
 */
export async function getTeamMap(params?: {
  window?: "7d" | "30d";
}): Promise<TeamMapResponse> {
  const query = params?.window ? `?window=${params.window}` : "";
  return request<TeamMapResponse>(`/map${query}`, { method: "GET" }, false);
}

/**
 * GET /search?q=&types=&bots=&limit= (Contract v0.3 §6, spec §4.14)
 * Searches across messages, bots, rooms, routines, files, actions.
 */
export async function searchLuveBot(
  params: SearchParams
): Promise<SearchResponse> {
  const qs = new URLSearchParams();
  qs.set("q", params.q);
  if (params.types) qs.set("types", params.types);
  if (params.bots) qs.set("bots", params.bots);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));

  return request<SearchResponse>(`/search?${qs.toString()}`, { method: "GET" }, false);
}






// ---------------------------------------------------------------------------
// Contract v0.4 B3: pause and resume a Bot (audited, CSRF). Resume answers 409 paused_all, budget_held or not_ours,
// and 403 loopback_not_human in loopback mode.
// ---------------------------------------------------------------------------

export async function pauseBot(bot: string, body: PauseRequest = {}): Promise<PauseResponse> {
  return request<PauseResponse>(`${botPath(bot)}/pause`, { method: "POST", body: JSON.stringify(body) }, true);
}

export async function resumeBot(bot: string): Promise<PauseResponse> {
  return request<PauseResponse>(`${botPath(bot)}/resume`, { method: "POST", body: JSON.stringify({}) }, true);
}

// ---------------------------------------------------------------------------
// Contract v0.5 (T9.3): Pages. Reads need no CSRF; create, save and restore are audited mutations.
// The slug goes in the URL encoded; the backend answers 404 for anything that is not a slug.
// ---------------------------------------------------------------------------

const pagePath = (bot: string, slug: string) => `${botPath(bot)}/pages/${encodeURIComponent(slug)}`;

export async function listPages(bot: string, q?: string): Promise<PagesListResponse> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  return request<PagesListResponse>(`${botPath(bot)}/pages${qs}`, { method: "GET" }, false);
}

export async function getPage(bot: string, slug: string): Promise<PageWithContent> {
  return request<PageWithContent>(pagePath(bot, slug), { method: "GET" }, false);
}

export async function listPageRevisions(bot: string, slug: string, cursor?: string): Promise<PageRevisionsResponse> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request<PageRevisionsResponse>(`${pagePath(bot, slug)}/revisions${qs}`, { method: "GET" }, false);
}

export async function getPageRevision(bot: string, slug: string, rev: number): Promise<PageRevisionWithContent> {
  return request<PageRevisionWithContent>(`${pagePath(bot, slug)}/revisions/${rev}`, { method: "GET" }, false);
}

export async function createPage(bot: string, body: { title: string; content?: string }): Promise<PageSaveResponse> {
  return request<PageSaveResponse>(`${botPath(bot)}/pages`, { method: "POST", body: JSON.stringify(body) }, true);
}

/** Saves with the sha of the version the client loaded (never one it computed): 409 page_conflict if it changed. */
export async function savePage(bot: string, slug: string, body: { content: string; base_sha: string }): Promise<PageSaveResponse> {
  return request<PageSaveResponse>(pagePath(bot, slug), { method: "PUT", body: JSON.stringify(body) }, true);
}

export async function restorePageRevision(bot: string, slug: string, rev: number, body: { base_sha: string }): Promise<PageSaveResponse> {
  return request<PageSaveResponse>(`${pagePath(bot, slug)}/revisions/${rev}/restore`, { method: "POST", body: JSON.stringify(body) }, true);
}

/**
 * GET /bots/{bot}/files/download?path= (T12): a file of the Bot's workspace, as a blob. Through the SDK's authedFetch, so the
 * token goes in the header (never the query). The name is the server's Content-Disposition, else the path's last part.
 * 404 file_not_found, 409 file_redacted / workspace_unavailable, 413 too_large arrive as ApiError.
 */
export async function downloadBotFile(bot: string, path: string): Promise<{ name: string; blob: Blob }> {
  const authed = getSDK()?.authedFetch;
  if (!authed) throw new ApiError({ code: "sdk_unavailable", message: "Hermes Plugin SDK authedFetch is not available in this environment.", status: 503 });
  const res = await authed(`${BASE_API_PATH}${botPath(bot)}/files/download?path=${encodeURIComponent(path)}`, { method: "GET" });
  if (!res.ok) throw parseApiError({ status: res.status, body: await res.text().catch(() => "") });
  let name = path.split("/").pop() || path;
  const m = (res.headers.get("Content-Disposition") ?? "").match(/filename\*=UTF-8''([^;\s]+)/i);
  if (m) { try { name = decodeURIComponent(m[1]); } catch { /* keep the path's name */ } }
  return { name, blob: await res.blob() };
}

/**
 * POST /bots/{bot}/attachments (T14, ADR-005): one file as multipart field "file", with session + CSRF. Sent through the SDK's
 * authedFetch with a FormData body: request() would set a JSON Content-Type, and the browser must set the multipart boundary
 * (and the Content-Length the server requires). Refusals arrive as ApiError: 413 too_large, 415 attachment_refused
 * (details.reason), 409 workspace_unavailable (details.reason), 411, 403 csrf_required.
 */
export async function uploadAttachment(bot: string, file: File): Promise<{ attachment: Attachment }> {
  const authed = getSDK()?.authedFetch;
  if (!authed) throw new ApiError({ code: "sdk_unavailable", message: "Hermes Plugin SDK authedFetch is not available in this environment.", status: 503 });
  if (!_inMemoryCsrf) _inMemoryCsrf = (await getSession()).csrf;
  const body = new FormData();
  body.append("file", file, file.name);
  const res = await authed(`${BASE_API_PATH}${botPath(bot)}/attachments`, { method: "POST", headers: { "X-LuveBot-CSRF": _inMemoryCsrf ?? "" }, body });
  if (!res.ok) {
    const err = parseApiError({ status: res.status, body: await res.text().catch(() => "") });
    if (err.code === "csrf_required" || err.status === 403) _inMemoryCsrf = null;
    throw err;
  }
  return res.json();
}

/** POST /bots/{bot}/workspace (ADR-005 §3): a Bot without terminal.cwd gets its own <profile home>/workspace, by Hermes's writer. */
export async function setBotWorkspace(bot: string): Promise<{ workspace: { state: PagesWorkspaceState } }> {
  return request(`${botPath(bot)}/workspace`, { method: "POST" }, true);
}

/** GET /bots/{bot}/introduction (contract v0.4 B4): whether the Bot introduced itself, may do it now, or why not. */
export async function getIntroduction(bot: string): Promise<IntroductionView> {
  return request(`${botPath(bot)}/introduction`, { method: "GET" }, false);
}

/** POST /bots/{bot}/introduction: a real model run, so the body says the person confirmed its cost (never sent on its own). */
export async function startIntroduction(bot: string): Promise<IntroductionView> {
  return request(`${botPath(bot)}/introduction`, { method: "POST", body: JSON.stringify({ confirm_cost: true }) }, true);
}
