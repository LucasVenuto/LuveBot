// dashboard/src/api/client.ts
// Typed client for LuveBot plugin API v0 (docs/contracts/plugin-api-v0.md)
// Uses SDK fetchJSON, sends X-LuveBot-CSRF on mutations, handles Section 7 errors, NEVER EventSource.

import { getSDK } from "../sdk";
import type {
  RuleSuggestion,
  AvatarUploadResponse,
  RoutineSuggestionsResponse,
  AcceptRoutineSuggestionResponse,
  InactivityDays, InactivityStatus,
  BotAvatar, HeatmapResponse, TimelineResponse,
  BotSkillsResponse, SkillsMatrix, SkillToggleResult, SkillContent, SkillPreview, SkillCreated, SkillEdited,
  VoiceStatus,
  VoiceLanguage,
  SoulView,
  BotModelInfo,
  ModelOptions,
  ModelSetResult,
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
  PagesListResponse, PagesReviewState,
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
  RunControl,
  RunResolution,
  PlanQuotaResponse,
  WaitingResponse,
  CallStart,
  CallBeat,
  CallReceipt,
  FreePassesResponse,
  MemoryTarget,
  MemoryViewResponse,
  MessageReaction,
  ThreadsResponse,
  PushConfig,
  PushDevice,
} from "./types";

export const BASE_API_PATH = "/api/plugins/luvebot";

export class ApiError extends Error {
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
  readonly status: number;
  readonly rawBody?: string;
  readonly details?: Record<string, any>;
  /** The reason a `skill_invalid` refusal names (contract v0.11 3.4: `bad_name`, `description_too_long`, `hidden_characters`...); it comes beside `details` in the error, a word from a closed list, never text from the draft. */
  readonly why?: string;

  constructor(opts: {
    code: string;
    message: string;
    requestId?: string;
    status: number;
    rawBody?: string;
    details?: Record<string, any>;
    why?: string;
  }) {
    super(opts.message);
    this.name = "ApiError";
    this.code = opts.code;
    this.message = opts.message;
    this.requestId = opts.requestId;
    this.status = opts.status;
    this.rawBody = opts.rawBody;
    this.details = opts.details;
    this.why = opts.why;
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

// ADR-006 D2 / health contract F2-3: with `plugins.isolation: host` Hermes answers 409 `luvebot_needs_in_process` on EVERY route of
// ours, /health included. Any call can meet it; the app then shows ONE screen about it (never "Bot não encontrado", never a generic error).
// Sticky: nothing in the page can fix it, a reload after the config change starts clean.
export const NEEDS_IN_PROCESS = "luvebot_needs_in_process";
let _needsInProcess = false;
const _needsInProcessListeners = new Set<() => void>();
export const isNeedsInProcess = (): boolean => _needsInProcess;
export function onNeedsInProcess(fn: () => void): () => void {
  _needsInProcessListeners.add(fn);
  return () => { _needsInProcessListeners.delete(fn); };
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
  let why: string | undefined = undefined;
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
          if (typeof parsed.error.why === "string") why = parsed.error.why;
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

  if (code === NEEDS_IN_PROCESS && !_needsInProcess) {
    _needsInProcess = true;
    _needsInProcessListeners.forEach((fn) => fn());
  }

  return new ApiError({
    code,
    message,
    requestId,
    status,
    rawBody,
    details,
    ...(why !== undefined ? { why } : {}),
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

/** A plain GET on the plugin's API (`path` after /api/plugins/luvebot), for screens outside this file (extra screens). */
export function getJSON<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" }, false);
}

/** A POST with a JSON body on the plugin's API (`path` after /api/plugins/luvebot), with the CSRF header, for screens outside this file (extra screens). */
export function postJSON<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) }, true);
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

/** PUT /bots/{bot}/reactions/bot-sees (voice-language-reactions-v0 4, A-282): the body is EXACTLY {enabled: true | false} (anything else is 422); login and CSRF (loopback is 403 loopback_not_human); audited; written through Hermes's own
 *  configuration write. The answer is {reactions: {bot_sees}}: read it with botSees, it is the truth. */
export async function putReactionsBotSees(bot: string, enabled: boolean): Promise<unknown> {
  return request<unknown>(`${botPath(bot)}/reactions/bot-sees`, { method: "PUT", body: JSON.stringify({ enabled }) }, true);
}

/** PUT /bots/{bot}/approval-timeout (contract v0.6 10.1): Hermes re-reads it; 502 hermes_error when it did not keep the value. */
export async function setApprovalTimeout(botName: string, seconds: number): Promise<{ seconds: number; effective: number }> {
  return request(`/bots/${encodeURIComponent(botName)}/approval-timeout`, { method: "PUT", body: JSON.stringify({ seconds }) }, true);
}

/** PUT /approval-timeout (10.2): one audited write per Bot; a failure is reported for that Bot and undoes nothing (A-95). */
export async function setApprovalTimeoutAll(seconds: number): Promise<{ results: Array<{ bot: string; seconds?: number; error?: string }> }> {
  return request(`/approval-timeout`, { method: "PUT", body: JSON.stringify({ seconds }) }, true);
}

/** GET /bots/{bot}/skills (contract v0.6 2.1): every skill of the Bot, with its state per platform. */
export async function getBotSkills(bot: string): Promise<BotSkillsResponse> {
  return request<BotSkillsResponse>(`/bots/${encodeURIComponent(bot)}/skills`, { method: "GET" }, false);
}

/** GET /skills/matrix (2.2): every Bot x every skill. */
export async function getSkillsMatrix(): Promise<SkillsMatrix> {
  return request<SkillsMatrix>(`/skills/matrix`, { method: "GET" }, false);
}

/** PUT /bots/{bot}/skills/{skill} (2.3): Hermes's own toggle, re-read; ON needs a login (403 loopback_not_human). */
export async function setBotSkill(bot: string, skill: string, enabled: boolean): Promise<SkillToggleResult> {
  return request<SkillToggleResult>(`/bots/${encodeURIComponent(bot)}/skills/${encodeURIComponent(skill)}`, { method: "PUT", body: JSON.stringify({ enabled }) }, true);
}

/** POST /bots/{bot}/skills/draft (contract v0.11 3.2 step 1): ONE ordinary turn in that conversation asks the Bot for a skill draft; 202 { run }, or `run: null` + `queued` when Hermes keeps it for later. The note is the person's, at most 300 characters. */
export async function requestSkillDraft(bot: string, req: { session_id: string; note?: string }): Promise<{ run: RunInfo | null; queued?: boolean }> {
  return request(`/bots/${encodeURIComponent(bot)}/skills/draft`, { method: "POST", body: JSON.stringify(req) }, true);
}

/** POST /bots/{bot}/skills with `dry_run: true` (3.2 step 3): the normalized preview or a 422 `skill_invalid`; writes nothing. */
export async function previewSkill(bot: string, req: { name: string; category?: string; content: string }): Promise<SkillPreview> {
  return request<SkillPreview>(`/bots/${encodeURIComponent(bot)}/skills`, { method: "POST", body: JSON.stringify({ ...req, dry_run: true }) }, true);
}

/** POST /bots/{bot}/skills with `dry_run: false` (3.2 step 4): a person with a login; the skill is born OFF. 201 */
export async function createSkill(bot: string, req: { name: string; category?: string; content: string }): Promise<SkillCreated> {
  return request<SkillCreated>(`/bots/${encodeURIComponent(bot)}/skills`, { method: "POST", body: JSON.stringify({ ...req, dry_run: false }) }, true);
}

/** PUT /bots/{bot}/skills/{skill}/content (3.3): a full rewrite of a skill of `provenance: agent`, a person with a login; `expected_digest` is the one the editor loaded. */
export async function editSkill(bot: string, skill: string, req: { content: string; expected_digest: string }): Promise<SkillEdited> {
  return request<SkillEdited>(`/bots/${encodeURIComponent(bot)}/skills/${encodeURIComponent(skill)}/content`, { method: "PUT", body: JSON.stringify(req) }, true);
}

/** GET /bots/{bot}/skills/{skill}/content (2.4): the SKILL.md, redacted, read-only; shown as text. */
export async function getSkillContent(bot: string, skill: string): Promise<SkillContent> {
  return request<SkillContent>(`/bots/${encodeURIComponent(bot)}/skills/${encodeURIComponent(skill)}/content`, { method: "GET" }, false);
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

/** GET /settings/inactivity-pause (contract v0.8 §8): the days set (null = off) and, after the pause ran, what it paused. */
export async function getInactivityPause(): Promise<InactivityStatus> {
  return request<InactivityStatus>("/settings/inactivity-pause");
}

/** PUT /settings/inactivity-pause: CSRF, audited. Turning it on or shortening it is allowed anywhere; turning it off or lengthening it needs a login (403 loopback_not_human). */
export async function setInactivityPause(days: InactivityDays | null): Promise<{ days: InactivityDays | null }> {
  return request<{ days: InactivityDays | null }>("/settings/inactivity-pause", { method: "PUT", body: JSON.stringify({ days }) }, true);
}

/** POST /routines/inactivity-resume: a person with a login resumes ONLY the routines the inactivity pause paused. -> how many. */
export async function resumeAfterInactivity(): Promise<{ resumed: number }> {
  return request<{ resumed: number }>("/routines/inactivity-resume", { method: "POST" }, true);
}

/** GET /me/display (Crie seu Luve B2): the face of the person viewing, per login; null until they pick one. */
export async function getMyDisplay(): Promise<{ avatar: BotAvatar | null }> {
  return request<{ avatar: BotAvatar | null }>("/me/display");
}

/** PATCH /me/display: CSRF, audited as me.display.set; the body is only { avatar } (kinds initials, emoji, mascot, luve). */
export async function setMyDisplay(avatar: BotAvatar): Promise<{ avatar: BotAvatar }> {
  return request<{ avatar: BotAvatar }>("/me/display", { method: "PATCH", body: JSON.stringify({ avatar }) }, true);
}

/** PUT /bots/order (contract v0.8 section 9): the shared sidebar order, every listed Bot exactly once (else 422), audited. */
export async function setBotsOrder(bots: string[]): Promise<{ bots: string[] }> {
  return request<{ bots: string[] }>("/bots/order", { method: "PUT", body: JSON.stringify({ bots }) }, true);
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
  /** Hermes main only (contract v0.9 §1.2): absent = this backend/Hermes does not say. Status also gains `queued` and `unknown`. */
  execution_generation?: number;
  pending_controls?: RunControl[];
  resolution?: RunResolution | null;
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
): Promise<{ run: RunInfo | null; queued?: boolean; session_id?: string }> {  // run null + queued: accepted and waiting for Hermes's next owner (v0.9 §1.6); without a session_id the server makes the session (§10): run.session_id, or session_id when queued
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

/** POST /bots/{bot}/runs/{id}/clarify (v0.9 §1.4): the person's answer to the Bot's question; a person with a login. CSRF; audited by hash and size. */
export async function answerClarify(bot: string, runId: string, body: { request_id: string; execution_generation: number; answer: string }): Promise<{ clarify: { request_id: string; status: string } }> {
  return request(`${botPath(bot)}/runs/${encodeURIComponent(runId)}/clarify`, { method: "POST", body: JSON.stringify(body) }, true);
}

/** POST /bots/{bot}/runs/{id}/clarify with the EXCLUSIVE skip body (v0.11 §4.1): exactly `{request_id, execution_generation, skip: true}`, no answer, no choices, no text from the browser (the server sends Hermes its own
 *  constant). A person with a login, like an answer; the body is built here from the two values so nothing else can ride along. */
export async function skipClarify(bot: string, runId: string, body: { request_id: string; execution_generation: number }): Promise<{ clarify: { request_id: string; status: string } }> {
  return request(`${botPath(bot)}/runs/${encodeURIComponent(runId)}/clarify`, { method: "POST", body: JSON.stringify({ request_id: body.request_id, execution_generation: body.execution_generation, skip: true }) }, true);
}

/** POST /bots/{bot}/runs/{id}/resolve-unknown (v0.9 §1.3): a person with a login says a run Hermes lost track of has ended. CSRF; audited. */
export async function resolveUnknownRun(bot: string, runId: string, body: { execution_generation: number }): Promise<{ run: RunInfo }> {
  return request(`${botPath(bot)}/runs/${encodeURIComponent(runId)}/resolve-unknown`, { method: "POST", body: JSON.stringify(body) }, true);
}

/** POST /bots/{bot}/sessions/{sid}/fork (v0.9 §1.7): a copy of another channel's conversation. Hermes ENDS the original: only on a person's click. */
export async function forkSession(bot: string, sessionId: string): Promise<{ session: { id: string; title?: string } }> {
  return request(`${botPath(bot)}/sessions/${encodeURIComponent(sessionId)}/fork`, { method: "POST", body: JSON.stringify({}) }, true);
}

/** Stream URLs (§5, §6): consumed with lib/stream openStream, never EventSource. */
export const runEventsUrl = (bot: string, runId: string) => `${BASE_API_PATH}${botPath(bot)}/runs/${encodeURIComponent(runId)}/events`;
export const chatStreamUrl = (bot: string, sessionId: string) => `${BASE_API_PATH}${botPath(bot)}/sessions/${encodeURIComponent(sessionId)}/chat/stream`;
/** The chat without a session yet (contract v0.9 §10): the server makes it and says its id in the first frame (luvebot.stream.open). */
export const newChatStreamUrl = (bot: string) => `${BASE_API_PATH}${botPath(bot)}/chat/stream`;
/** POST /bots/{bot}/threads (contract v0.8 §4): a NEW conversation linked to one message; the quote is read from Hermes by the server. The answer is the chat stream. */
export const threadsUrl = (bot: string) => `${BASE_API_PATH}${botPath(bot)}/threads`;

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
let approvalsFlight: Promise<ApprovalsResponse> | null = null;
export async function getApprovals(cursor?: string): Promise<ApprovalsResponse> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  if (cursor) return request<ApprovalsResponse>(`/approvals${query}`, { method: "GET" }, false);
  // The first page: the app and Hoje both ask for it when it opens. A read already on its way answers both (never a stored copy: only the
  // one in flight is shared, so a decision is always seen by the next read).
  approvalsFlight ??= request<ApprovalsResponse>("/approvals", { method: "GET" }, false).finally(() => { approvalsFlight = null; });
  return approvalsFlight;
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

/** GET /suggestions (contract v0.8 §5): rule suggestions from our own approvals, each with a DRAFT preview. Nothing is saved or applied. */
export async function getSuggestions(): Promise<{ suggestions: RuleSuggestion[] }> {
  return request<{ suggestions: RuleSuggestion[] }>("/suggestions");
}

/** POST /suggestions/dismiss: "Ignorar" hides that action of that Bot for 30 days (CSRF, audited). */
export async function dismissSuggestion(bot: string, actionClass: string): Promise<{ until: number }> {
  return request<{ until: number }>("/suggestions/dismiss", { method: "POST", body: JSON.stringify({ bot, action_class: actionClass }) }, true);
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

/** GET /bots/{bot}/free-passes (v0.9 §5): what the Livre let through for this Bot, newest first, commands already redacted by the hook. `audited:
 *  false` = a row that no recorded turn-on of the Livre explains. Read only. */
export async function getFreePasses(bot: string, params: { limit?: number; before?: number } = {}): Promise<FreePassesResponse> {
  const q = new URLSearchParams();
  if (params.limit) q.set("limit", String(params.limit));
  if (params.before) q.set("before", String(params.before));
  return request<FreePassesResponse>(`${botPath(bot)}/free-passes${q.toString() ? `?${q}` : ""}`, { method: "GET" }, false);
}

/** Memory, item by item (contract v0.8 §1). Reads are open; ADD and EDIT need a person with a login (403 loopback_not_human), removing does not. Every
 *  write is audited with digests and lengths only. An edit is pinned to the exact item by its id (409 memory_changed when it moved meanwhile). */
export const getMemory = (bot: string): Promise<MemoryViewResponse> => request(`${botPath(bot)}/memory`, { method: "GET" }, false);
export const addMemory = (bot: string, target: MemoryTarget, text: string): Promise<{ id: string }> =>
  request(`${botPath(bot)}/memory/${target}`, { method: "POST", body: JSON.stringify({ text }) }, true);
export const replaceMemory = (bot: string, target: MemoryTarget, id: string, text: string): Promise<{ id: string }> =>
  request(`${botPath(bot)}/memory/${target}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ text }) }, true);
export const removeMemory = (bot: string, target: MemoryTarget, id: string): Promise<{ removed: number }> =>
  request(`${botPath(bot)}/memory/${target}/${encodeURIComponent(id)}`, { method: "DELETE" }, true);
export const clearMemory = (bot: string, target: MemoryTarget): Promise<{ removed: number; skipped: number }> =>
  request(`${botPath(bot)}/memory/${target}?confirm=all`, { method: "DELETE" }, true);

/** GET /bots/{bot}/memory/export: both memories as one Markdown file, redacted, through authedFetch (the token goes in the header). */
export async function exportMemory(bot: string): Promise<Blob> {
  const authed = getSDK()?.authedFetch;
  if (!authed) throw new ApiError({ code: "sdk_unavailable", message: "Hermes Plugin SDK authedFetch is not available in this environment.", status: 503 });
  const res = await authed(`${BASE_API_PATH}${botPath(bot)}/memory/export`, { method: "GET" });
  if (!res.ok) throw parseApiError({ status: res.status, body: await res.text().catch(() => "") });
  return res.blob();
}

/** GET /waiting (v0.9 §7): what the Bots wait for a person to do. Read only; the screen reads it at most every 30 s (home/waiting.ts). */
export async function getWaiting(bot?: string): Promise<WaitingResponse> {
  return request<WaitingResponse>(`/waiting${bot ? `?bot=${encodeURIComponent(bot)}` : ""}`, { method: "GET" }, false);
}

/** GET /costs/quota (F6.1): the plan quota Hermes reports, for every Bot. Always 200; `available: false` says why. Read only, and each
 *  read makes Hermes call the providers: the screen asks at most once a minute (PlanQuota). */
export async function getCostsQuota(): Promise<PlanQuotaResponse> {
  return request<PlanQuotaResponse>("/costs/quota", { method: "GET" }, false);
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

/** GET /routine-suggestions (contract v0.10 §2): what Hermes proposes, over every Bot. `partial` names the Bots whose file could not be read. */
export async function getRoutineSuggestions(): Promise<RoutineSuggestionsResponse> {
  return request<RoutineSuggestionsResponse>("/routine-suggestions");
}

/** POST /bots/{bot}/routine-suggestions/{id}/accept: creates the routine PAUSED (a person with a login; 403 loopback_not_human otherwise);
 *  `start: true` starts it only if the gates of POST /routines allow. A retry returns the same routine (`replayed`). CSRF, audited. */
export async function acceptRoutineSuggestion(bot: string, id: string, start = false): Promise<AcceptRoutineSuggestionResponse> {
  return request<AcceptRoutineSuggestionResponse>(
    `/bots/${encodeURIComponent(bot)}/routine-suggestions/${encodeURIComponent(id)}/accept`,
    { method: "POST", body: JSON.stringify({ start }) },
    true,
  );
}

/** POST /bots/{bot}/routine-suggestions/{id}/dismiss: creates nothing and latches the suggestion in Hermes; allowed in loopback. CSRF, audited. */
export async function dismissRoutineSuggestion(bot: string, id: string): Promise<{ dismissed: boolean }> {
  return request<{ dismissed: boolean }>(
    `/bots/${encodeURIComponent(bot)}/routine-suggestions/${encodeURIComponent(id)}/dismiss`,
    { method: "POST" },
    true,
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

/** GET /activity/timeline (contract v0.8 §2): lanes of runs and routine runs per Bot, approval diamonds and handoff lines in a window of at most 7 days (epoch seconds). */
export async function getActivityTimeline(params: { since: number; until: number; bot?: string }): Promise<TimelineResponse> {
  const q = new URLSearchParams({ since: String(params.since), until: String(params.until) });
  if (params.bot) q.set("bot", params.bot);
  return request<TimelineResponse>(`/activity/timeline?${q.toString()}`);
}

/** GET /activity/heatmap (contract v0.8 §2): run starts per Bot and hour of the day over 7, 28 or 90 days, counted in `tz`. */
export async function getActivityHeatmap(days: 7 | 28 | 90, tz: string): Promise<HeatmapResponse> {
  return request<HeatmapResponse>(`/activity/heatmap?${new URLSearchParams({ days: String(days), tz }).toString()}`);
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

/** GET /bots/{bot}/pages/review (pages-review-v0 §1): the "Revisar antes de salvar" switch. Read only, any session. */
export async function getPagesReview(bot: string): Promise<PagesReviewState> {
  return request<PagesReviewState>(`${botPath(bot)}/pages/review`, { method: "GET" }, false);
}

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

/** What LuveBot stores of a person's image is at most this (contract v0.11 §2.1: a 256 x 256 RGBA PNG cannot pass about 262.5 KB even as noise). */
export const AVATAR_MAX_BYTES = 288 * 1024;

/** GET /avatars/{id} (v0.11 §2.2): the stored PNG, through the SDK's authedFetch (an <img src> to the route would carry no session in loopback, so it is never used).
 *  The read stops at the cap; whether the bytes ARE the 256 x 256 PNG is checked by the caller (ui/avatarImage.ts). 404 (not yours, or not there) and 401 arrive as ApiError. */
export async function getAvatarImage(id: string): Promise<Uint8Array<ArrayBuffer>> {
  const authed = getSDK()?.authedFetch;
  if (!authed) throw new ApiError({ code: "sdk_unavailable", message: "Hermes Plugin SDK authedFetch is not available in this environment.", status: 503 });
  const res = await authed(`${BASE_API_PATH}/avatars/${encodeURIComponent(id)}`, { method: "GET" });
  if (!res.ok) throw parseApiError({ status: res.status, body: await res.text().catch(() => "") });
  if (Number(res.headers.get("Content-Length")) > AVATAR_MAX_BYTES) throw new ApiError({ code: "too_large", message: "avatar image over the cap", status: 413 });
  const tooLarge = () => new ApiError({ code: "too_large", message: "avatar image over the cap", status: 413 });
  const reader = res.body?.getReader?.();
  if (!reader) {                                   // no stream to stop (an old engine, a test): the body as a whole, then the cap
    const whole = new Uint8Array(await res.arrayBuffer());
    if (whole.length > AVATAR_MAX_BYTES) throw tooLarge();
    return whole;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {                                       // a chunked body with no announced size is read only up to the cap, then dropped
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > AVATAR_MAX_BYTES) { await reader.cancel().catch(() => {}); throw tooLarge(); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** POST /avatars (v0.11 §2.2): the raw PNG the browser drew (a canvas export), CSRF, audited. 201 {id}; the same pixels from the same owner give the same id back (`replayed`).
 *  422 invalid_image (`details.why`), 409 avatar_quota and 413 arrive as ApiError. Allowed in loopback (it loosens no control). */
export async function uploadAvatar(png: Blob): Promise<AvatarUploadResponse> {
  return request<AvatarUploadResponse>("/avatars", { method: "POST", body: png, headers: { "Content-Type": "image/png" } }, true);
}

/** DELETE /avatars/{id}: the owner only; 409 avatar_in_use while a Bot or a person still wears it. CSRF, audited. */
export async function deleteAvatar(id: string): Promise<{ deleted?: boolean }> {
  return request<{ deleted?: boolean }>(`/avatars/${encodeURIComponent(id)}`, { method: "DELETE" }, true);
}

/**
 * The same route for the image viewer (contract v0.6 §4, A-82): `purpose=view` makes the audit say `file.view` instead of
 * `file.download`; the response and its refusals are the download's. The bytes come back untyped: the viewer types them.
 */
export async function viewBotFile(bot: string, path: string): Promise<Blob> {
  const authed = getSDK()?.authedFetch;
  if (!authed) throw new ApiError({ code: "sdk_unavailable", message: "Hermes Plugin SDK authedFetch is not available in this environment.", status: 503 });
  const res = await authed(`${BASE_API_PATH}${botPath(bot)}/files/download?path=${encodeURIComponent(path)}&purpose=view`, { method: "GET" });
  if (!res.ok) throw parseApiError({ status: res.status, body: await res.text().catch(() => "") });
  return res.blob();
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

/**
 * POST /rooms/{room}/messages with files (contract v0.6 9.1): the message fields and up to 5 `file` parts as multipart, CSRF in the
 * header (the server checks it before reading the body), through authedFetch so the browser sets the boundary and the length.
 * Refusals as ApiError: 413 too_large, 415 attachment_refused, 409 workspace_unavailable (details.bots), 409
 * cost_confirmation_required (details.disk_bytes), 422 not_a_member, 403 csrf_required.
 */
export async function sendRoomMessageWithFiles(roomId: string, data: SendRoomMessageRequest, files: File[]): Promise<SendRoomMessageResponse> {
  const authed = getSDK()?.authedFetch;
  if (!authed) throw new ApiError({ code: "sdk_unavailable", message: "Hermes Plugin SDK authedFetch is not available in this environment.", status: 503 });
  if (!_inMemoryCsrf) _inMemoryCsrf = (await getSession()).csrf;
  const body = new FormData();
  body.append("text", data.text);
  body.append("event_id", data.event_id);
  if (data.thread_id) body.append("thread_id", data.thread_id);
  if (data.confirm_cost !== undefined) body.append("confirm_cost", data.confirm_cost ? "true" : "false");
  for (const file of files) body.append("file", file, file.name);
  const res = await authed(`${BASE_API_PATH}/rooms/${encodeURIComponent(roomId)}/messages`, { method: "POST", headers: { "X-LuveBot-CSRF": _inMemoryCsrf ?? "" }, body });
  if (!res.ok) {
    const err = parseApiError({ status: res.status, body: await res.text().catch(() => "") });
    if (err.code === "csrf_required" || err.status === 403) _inMemoryCsrf = null;
    throw err;
  }
  return res.json();
}

/** GET /bots/{bot}/model (contract v0.11 1.2): the provider and model in use now. Absent route (404 plugin_route_missing) = the Bot's model cannot be changed from here. */
export async function getBotModel(bot: string): Promise<BotModelInfo> {
  return request<BotModelInfo>(`${botPath(bot)}/model`, { method: "GET" }, false);
}

/** GET /bots/{bot}/model/options: ONLY what Hermes offers this Bot and LuveBot changes (no custom, local or nous). Read when the person opens the picker: it can take seconds. */
export async function getModelOptions(bot: string): Promise<ModelOptions> {
  return request<ModelOptions>(`${botPath(bot)}/model/options`, { method: "GET" }, false);
}

/** POST /bots/{bot}/model: the body is EXACTLY {provider, model, expected: {provider, model}} and, only after the person confirmed Hermes's price warning, `confirm_expensive: true`. No key, no address, no scope,
 *  no profile exists for LuveBot (the server refuses any other key with 422). 409 stale (the model changed since it was read), 409 confirm_required {details.warning}, 422 provider_not_supported / model_not_offered. */
export async function setBotModel(bot: string, choice: { provider: string; model: string }, expected: { provider: string | null; model: string | null }, confirmExpensive = false): Promise<ModelSetResult> {
  const body = { provider: choice.provider, model: choice.model, expected: { provider: expected.provider, model: expected.model }, ...(confirmExpensive ? { confirm_expensive: true } : {}) };
  return request<ModelSetResult>(`${botPath(bot)}/model`, { method: "POST", body: JSON.stringify(body) }, true);
}

/** GET /bots/{bot}/soul (contract v0.4 B6): the Bot's SOUL.md without the LuveBot rules block, redacted and capped at 64 KiB, with the digest an edit must send back. */
export async function getSoul(bot: string): Promise<SoulView> {
  return request<SoulView>(`${botPath(bot)}/soul`, { method: "GET" }, false);
}

/** PUT /bots/{bot}/soul (B6): a human edit, CSRF, audited `bot.soul.update` (the digest and the length, never the text). The server keeps the managed rules block byte for byte; the text
 *  must not contain its markers (422 invalid_field), 64 KiB at most (413 too_large), and `expectedDigest` is the one GET gave (409 stale: someone, the Bot included, edited it meanwhile). */
export async function putSoul(bot: string, content: string, expectedDigest: string): Promise<SoulView> {
  return request<SoulView>(`${botPath(bot)}/soul`, { method: "PUT", body: JSON.stringify({ content, expected_digest: expectedDigest }) }, true);
}

/** GET /bots/{bot}/voice (contract v0.7 3.1): Radio and Call availability, without a secret. */
export async function getVoice(bot: string): Promise<VoiceStatus> {
  return request<VoiceStatus>(`${botPath(bot)}/voice`, { method: "GET" }, false);
}

/** PUT /bots/{bot}/voice/language (voice-language-reactions-v0 section 2, VL-1): the body is EXACTLY {language: "pt" | "en" | "auto"}; the server writes `stt.language` (and, only for a default voice, `tts.edge.voice`) through Hermes's
 *  own configuration write, audited, login and CSRF (loopback is 403 loopback_not_human). The answer carries the new settings (read it with readVoiceSettings). */
export async function putVoiceLanguage(bot: string, language: VoiceLanguage): Promise<unknown> {
  return request<unknown>(`${botPath(bot)}/voice/language`, { method: "PUT", body: JSON.stringify({ language }) }, true);
}

/** PUT /bots/{bot}/voice/client-direct (contract v0.10 4, V6): ONLY off. While it is on, Hermes hands the voice providers' keys to the browser of anyone who opens its
 *  dashboard. Hermes writes it in this Bot's profile and LuveBot re-reads it: 502 hermes_error when it did not stick. There is no way to turn it on (422). */
export async function turnOffVoiceClientDirect(bot: string): Promise<{ client_direct: boolean }> {
  return request(`${botPath(bot)}/voice/client-direct`, { method: "PUT", body: JSON.stringify({ enabled: false }) }, true);
}

/** POST /bots/{bot}/voice/transcribe (2.1): the raw recording (its own Content-Type), CSRF, through authedFetch. -> {text, provider} */
export async function transcribeVoice(bot: string, recording: Blob): Promise<{ text: string; provider: string | null }> {
  const authed = getSDK()?.authedFetch;
  if (!authed) throw new ApiError({ code: "sdk_unavailable", message: "Hermes Plugin SDK authedFetch is not available in this environment.", status: 503 });
  if (!_inMemoryCsrf) _inMemoryCsrf = (await getSession()).csrf;
  const res = await authed(`${BASE_API_PATH}${botPath(bot)}/voice/transcribe`, {
    method: "POST", headers: { "X-LuveBot-CSRF": _inMemoryCsrf ?? "", "Content-Type": recording.type || "audio/webm" }, body: recording });
  if (!res.ok) {
    const err = parseApiError({ status: res.status, body: await res.text().catch(() => "") });
    if (err.code === "csrf_required" || err.status === 403) _inMemoryCsrf = null;
    throw err;
  }
  return res.json();
}

/** POST /bots/{bot}/voice/speak (2.2): the text (the server redacts it first) -> the audio bytes, played from a blob: URL. */
export async function speakVoice(bot: string, text: string): Promise<Blob> {
  const authed = getSDK()?.authedFetch;
  if (!authed) throw new ApiError({ code: "sdk_unavailable", message: "Hermes Plugin SDK authedFetch is not available in this environment.", status: 503 });
  if (!_inMemoryCsrf) _inMemoryCsrf = (await getSession()).csrf;
  const res = await authed(`${BASE_API_PATH}${botPath(bot)}/voice/speak`, {
    method: "POST", headers: { "X-LuveBot-CSRF": _inMemoryCsrf ?? "", "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  if (!res.ok) {
    const err = parseApiError({ status: res.status, body: await res.text().catch(() => "") });
    if (err.code === "csrf_required" || err.status === 403) _inMemoryCsrf = null;
    throw err;
  }
  return res.blob();
}

/** POST /bots/{bot}/voice/calls (v0.7 3.2): reserves the call's maximum and exchanges the browser's SDP through Hermes. CSRF; audited. Only the
 *  vendor's SDP answer and the call id come back (never a key). 409 call_in_progress / bot_paused / budget refusals, 502 voice_unavailable. */
export async function startCall(bot: string, body: { sdp: string; session_id: string | null }): Promise<CallStart> {
  return request(`${botPath(bot)}/voice/calls`, { method: "POST", body: JSON.stringify(body) }, true);
}

/** POST .../voice/calls/{id}/heartbeat (3.3), every `heartbeat_seconds`: `stop` tells the client to hang up (time, budget, pause). Not audited. */
export async function heartbeatCall(bot: string, callId: string): Promise<CallBeat> {
  return request(`${botPath(bot)}/voice/calls/${encodeURIComponent(callId)}/heartbeat`, { method: "POST" }, true);
}

/** POST .../voice/calls/{id}/end (3.4): the receipt. Idempotent. `vendor_seconds` is what the vendor's `session.closed` reported, or null. */
export async function endCall(bot: string, callId: string, body: { vendor_seconds: number | null; reason: "hangup" | "max_time" | "stop" | "error" }): Promise<CallReceipt> {
  return request(`${botPath(bot)}/voice/calls/${encodeURIComponent(callId)}/end`, { method: "POST", body: JSON.stringify(body) }, true);
}

/** The delegation route (3.3) answers like the conversation's send route: a stream the client follows with lib/stream openStream (POST). */
export const callDelegationUrl = (bot: string, callId: string) => `${BASE_API_PATH}${botPath(bot)}/voice/calls/${encodeURIComponent(callId)}/delegations`;

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

/** PUT / DELETE /bots/{bot}/sessions/{sid}/messages/{row}/reactions/{emoji} (contract v0.8 §4): the team's one mark on a message, kept by Hermes.
 *  The emoji is one of the closed six (the server checks it again); the answer is the message's reactions after the write. */
export const reactToMessage = (bot: string, sid: string, row: number, emoji: string, clear: boolean): Promise<{ reactions: MessageReaction[] }> =>
  request(`${botPath(bot)}/sessions/${encodeURIComponent(sid)}/messages/${row}/reactions/${encodeURIComponent(emoji)}`, { method: clear ? "DELETE" : "PUT" }, true);

/** GET /bots/{bot}/sessions/{sid}/threads: the "N respostas" of the conversation's messages (a message may have several threads). */
export const getThreads = (bot: string, sid: string): Promise<ThreadsResponse> =>
  request(`${botPath(bot)}/sessions/${encodeURIComponent(sid)}/threads`, { method: "GET" }, false);

/** Notifications (contract v0.8 §6): the push carries nothing; the worker asks /notifications/latest. Only {endpoint, kinds} are sent: the browser's keys are not (no payload to encrypt).
 *  POST is an UPSERT by endpoint: the same device again changes its kinds (a non-empty list); to stop everything, DELETE the device. */
export const getPushConfig = (): Promise<PushConfig> => request("/notifications/config", { method: "GET" }, false);
export const listPushDevices = (): Promise<{ subscriptions: PushDevice[] }> => request("/notifications/subscriptions", { method: "GET" }, false);
export const addPushDevice = (endpoint: string, kinds: string[], applicationServerKey?: string): Promise<{ id: number; kinds: string[] }> =>
  request("/notifications/subscriptions", { method: "POST", body: JSON.stringify({ endpoint, kinds, ...(applicationServerKey ? { application_server_key: applicationServerKey } : {}) }) }, true);   // the key the browser subscribed with (7.4): the server says 409 key_mismatch when it is not the current one
export const removePushDevice = (id: number): Promise<unknown> => request(`/notifications/subscriptions/${id}`, { method: "DELETE" }, true);
/** POST /notifications/test (7.3): an empty push to EVERY device of the signed-in person and what the push service answered for each (`reason` from a closed list; never the service's address or text). 429 `rate_limited`: one per 10 s. */
export const testPush = (): Promise<{ devices: Array<{ id: number; host: string | null; ok: boolean; status: number; reason: string | null }> }> =>
  request("/notifications/test", { method: "POST", body: JSON.stringify({}) }, true);
