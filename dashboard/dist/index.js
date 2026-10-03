"use strict";
var LuveBotPluginBundle = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // dashboard/src/index.tsx
  var index_exports = {};
  __export(index_exports, {
    BackToLuveBot: () => BackToLuveBot,
    LuveBotApp: () => LuveBotApp,
    LuveBotOverlaySlot: () => LuveBotOverlaySlot,
    default: () => index_default
  });

  // dashboard/src/shims/react.ts
  var getSDK = () => {
    if (typeof window !== "undefined" && window.__HERMES_PLUGIN_SDK__) {
      return window.__HERMES_PLUGIN_SDK__;
    }
    return void 0;
  };
  var getReact = () => getSDK()?.React || (typeof globalThis !== "undefined" ? globalThis.React : void 0);
  var React = getReact();
  var react_default = React;
  var useState = ((...args) => {
    const r = getReact();
    return (r?.useState || getSDK()?.hooks?.useState)(...args);
  });
  var useEffect = ((...args) => {
    const r = getReact();
    return (r?.useEffect || getSDK()?.hooks?.useEffect)(...args);
  });
  var useCallback = ((...args) => {
    const r = getReact();
    return (r?.useCallback || getSDK()?.hooks?.useCallback)(...args);
  });
  var useMemo = ((...args) => {
    const r = getReact();
    return (r?.useMemo || getSDK()?.hooks?.useMemo)(...args);
  });
  var useRef = ((...args) => {
    const r = getReact();
    return (r?.useRef || getSDK()?.hooks?.useRef)(...args);
  });
  var Fragment = getReact()?.Fragment || Symbol.for("react.fragment");

  // dashboard/src/sdk.ts
  function getSDK2() {
    if (typeof window !== "undefined") {
      return window.__HERMES_PLUGIN_SDK__;
    }
    return void 0;
  }
  function getPluginRegistry() {
    if (typeof window !== "undefined") {
      return window.__HERMES_PLUGINS__;
    }
    return void 0;
  }

  // dashboard/src/api/client.ts
  var BASE_API_PATH = "/api/plugins/luvebot";
  var ApiError = class extends Error {
    code;
    message;
    requestId;
    status;
    rawBody;
    details;
    constructor(opts) {
      super(opts.message);
      this.name = "ApiError";
      this.code = opts.code;
      this.message = opts.message;
      this.requestId = opts.requestId;
      this.status = opts.status;
      this.rawBody = opts.rawBody;
      this.details = opts.details;
    }
  };
  var _inMemoryCsrf = null;
  var _customFetchJSON = null;
  function defaultErrorCode(status) {
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
  function parseApiError(err, statusFallback = 500) {
    if (err instanceof ApiError) {
      return err;
    }
    let status = statusFallback;
    let rawBody = "";
    let message = "Erro inesperado na comunica\xE7\xE3o com o LuveBot.";
    let code2 = defaultErrorCode(status);
    let requestId = void 0;
    let details = void 0;
    let enveloped = false;
    if (err && typeof err === "object") {
      const errorRecord = err;
      if (typeof errorRecord.status === "number") {
        status = errorRecord.status;
        code2 = defaultErrorCode(status);
      }
      if (typeof errorRecord.details === "object" && errorRecord.details !== null) {
        details = errorRecord.details;
      }
      if (typeof errorRecord.body === "string") {
        rawBody = errorRecord.body;
      } else if (typeof errorRecord.message === "string") {
        rawBody = errorRecord.message;
      }
      if (rawBody) {
        try {
          const parsed = JSON.parse(rawBody);
          if (parsed?.error) {
            enveloped = true;
            if (parsed.error.code) code2 = parsed.error.code;
            if (parsed.error.message) message = parsed.error.message;
            if (parsed.error.request_id) requestId = parsed.error.request_id;
            if (parsed.error.details) details = parsed.error.details;
          }
        } catch {
          if (rawBody.trim() && rawBody.length < 300 && !rawBody.trim().startsWith("<")) {
            message = rawBody.trim();
          }
        }
      }
    } else if (typeof err === "string") {
      rawBody = err;
      message = err;
    }
    if ((status === 404 || status === 405) && !enveloped) code2 = "plugin_route_missing";
    return new ApiError({
      code: code2,
      message,
      requestId,
      status,
      rawBody,
      details
    });
  }
  async function dispatchJSON(url, init) {
    if (_customFetchJSON) {
      return await _customFetchJSON(url, init);
    }
    const sdk = getSDK2();
    if (sdk?.fetchJSON) {
      return sdk.fetchJSON(url, init);
    }
    if (typeof fetch !== "undefined") {
      const res = await fetch(url, init);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw parseApiError({ status: res.status, body: text });
      }
      return res.json();
    }
    throw new ApiError({
      code: "sdk_unavailable",
      message: "Hermes Plugin SDK fetchJSON is not available in this environment.",
      status: 503
    });
  }
  async function request(path, init = {}, isMutation = false) {
    const url = `${BASE_API_PATH}${path}`;
    const headers = new Headers(init.headers || {});
    if (isMutation) {
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
      return await dispatchJSON(url, {
        ...init,
        headers
      });
    } catch (err) {
      const apiError = parseApiError(err);
      if (apiError.code === "csrf_required" || apiError.status === 403) {
        _inMemoryCsrf = null;
      }
      throw apiError;
    }
  }
  async function getHealth() {
    return request("/health", { method: "GET" }, false);
  }
  async function getSession() {
    const session = await request("/session", { method: "GET" }, false);
    if (session?.csrf) {
      _inMemoryCsrf = session.csrf;
    }
    return session;
  }
  async function getBots() {
    return request("/bots", { method: "GET" }, false);
  }
  async function getBot(botName) {
    return request(`/bots/${encodeURIComponent(botName)}`, { method: "GET" }, false);
  }
  async function createBot(req) {
    return request(
      "/bots",
      {
        method: "POST",
        body: JSON.stringify(req)
      },
      true
    );
  }
  async function updateBotDisplay(botName, req) {
    return request(
      `/bots/${encodeURIComponent(botName)}/display`,
      {
        method: "PATCH",
        body: JSON.stringify(req)
      },
      true
    );
  }
  var botPath = (bot) => `/bots/${encodeURIComponent(bot)}`;
  async function getApprovalSurface(bot) {
    return request(`${botPath(bot)}/approval-surface`, { method: "GET" }, false);
  }
  async function putApprovalSurface(bot, body) {
    return request(`${botPath(bot)}/approval-surface`, { method: "PUT", body: JSON.stringify(body) }, true);
  }
  async function installBotHook(bot) {
    return request(`${botPath(bot)}/hook/install`, { method: "POST" }, true);
  }
  async function getScreen(bot) {
    return request(`${botPath(bot)}/screen`, { method: "GET" }, false);
  }
  async function startScreen(bot) {
    return request(`${botPath(bot)}/screen/start`, { method: "POST" }, true);
  }
  async function watchScreen(bot) {
    return request(`${botPath(bot)}/screen/watch`, { method: "POST" }, true);
  }
  async function takeScreen(bot, reason) {
    return request(`${botPath(bot)}/screen/take`, { method: "POST", ...reason ? { body: JSON.stringify({ reason }) } : {} }, true);
  }
  async function returnScreen(bot) {
    return request(`${botPath(bot)}/screen/return`, { method: "POST" }, true);
  }
  async function getBotSessions(bot, params = {}) {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.cursor) q.set("cursor", params.cursor);
    const qs = q.toString();
    return request(`${botPath(bot)}/sessions${qs ? `?${qs}` : ""}`, { method: "GET" }, false);
  }
  async function getSessionMessages(bot, sid, params = {}) {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.before) q.set("before", params.before);
    const qs = q.toString();
    return request(`${botPath(bot)}/sessions/${encodeURIComponent(sid)}/messages${qs ? `?${qs}` : ""}`, { method: "GET" }, false);
  }
  async function createSession(bot, title) {
    return request(`${botPath(bot)}/sessions`, { method: "POST", body: JSON.stringify(title ? { title } : {}) }, true);
  }
  async function createRun(bot, req) {
    return request(`${botPath(bot)}/runs`, { method: "POST", body: JSON.stringify(req) }, true);
  }
  async function getRun(bot, runId) {
    return request(`${botPath(bot)}/runs/${encodeURIComponent(runId)}`, { method: "GET" }, false);
  }
  async function stopRun(bot, runId) {
    return request(`${botPath(bot)}/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" }, true);
  }
  var runEventsUrl = (bot, runId) => `${BASE_API_PATH}${botPath(bot)}/runs/${encodeURIComponent(runId)}/events`;
  var chatStreamUrl = (bot, sessionId) => `${BASE_API_PATH}${botPath(bot)}/sessions/${encodeURIComponent(sessionId)}/chat/stream`;
  async function getCsrf() {
    return _inMemoryCsrf ?? (await getSession()).csrf;
  }
  async function getApprovals(cursor) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return request(`/approvals${query}`, { method: "GET" }, false);
  }
  async function resolveApproval(requestId, req) {
    if (req.choice === "always") {
      throw new ApiError({
        code: "invalid_choice",
        message: "Invariant 6 violation: 'always' is not an allowed wire choice. Only 'once' or 'deny' are permitted.",
        status: 400
      });
    }
    return request(
      `/approvals/${encodeURIComponent(requestId)}/resolve`,
      {
        method: "POST",
        body: JSON.stringify(req)
      },
      true
    );
  }
  async function batchResolveApprovals(req) {
    for (const item2 of req.items) {
      if (item2.choice === "always") {
        throw new ApiError({
          code: "invalid_choice",
          message: "Invariant 6 violation: 'always' is not an allowed wire choice in batch resolution.",
          status: 400
        });
      }
    }
    return request(
      "/approvals/batch",
      {
        method: "POST",
        body: JSON.stringify(req)
      },
      true
    );
  }
  async function resolveRunApproval(bot, runId, req) {
    if (req.choice === "always") {
      throw new ApiError({
        code: "invalid_choice",
        message: "Invariant 6 violation: 'always' is not an allowed wire choice. Only 'once' or 'deny' are permitted.",
        status: 400
      });
    }
    return request(
      `${botPath(bot)}/runs/${encodeURIComponent(runId)}/approval`,
      {
        method: "POST",
        body: JSON.stringify(req)
      },
      true
    );
  }
  async function getRules(cursor, bot) {
    const q = new URLSearchParams();
    if (cursor) q.set("cursor", cursor);
    if (bot) q.set("bot", bot);
    const query = q.toString() ? `?${q}` : "";
    return request(`/rules${query}`, { method: "GET" }, false);
  }
  async function createRule(rule) {
    return request(
      "/rules",
      {
        method: "POST",
        body: JSON.stringify(rule)
      },
      true
    );
  }
  async function patchRule(update) {
    return request(
      "/rules",
      {
        method: "PATCH",
        body: JSON.stringify(update)
      },
      true
    );
  }
  async function simulateRule(action) {
    return request(
      "/rules/simulate",
      {
        method: "POST",
        body: JSON.stringify(action)
      },
      true
    );
  }
  async function getCosts(params) {
    const q = new URLSearchParams();
    if (params?.period) q.set("period", params.period);
    if (params?.group) q.set("group", params.group);
    if (params?.bot) q.set("bot", params.bot);
    const qs = q.toString() ? `?${q.toString()}` : "";
    return request(`/costs${qs}`, { method: "GET" }, false);
  }
  async function getBudget() {
    return request("/budget", { method: "GET" }, false);
  }
  async function setBudgetLimit(req) {
    return request(
      "/budget/limits",
      {
        method: "PUT",
        body: JSON.stringify(req)
      },
      true
    );
  }
  async function resumeBotBudget(bot) {
    return request(
      `/bots/${encodeURIComponent(bot)}/budget/resume`,
      {
        method: "POST",
        body: JSON.stringify({})
      },
      true
    );
  }
  async function getRoutines(params) {
    const q = new URLSearchParams();
    if (params?.bot) q.set("bot", params.bot);
    if (params?.state) q.set("state", params.state);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.cursor) q.set("cursor", params.cursor);
    const qs = q.toString() ? `?${q.toString()}` : "";
    return request(`/routines${qs}`, { method: "GET" }, false);
  }
  async function getRoutine(id) {
    return request(
      `/routines/${encodeURIComponent(id)}`,
      { method: "GET" },
      false
    );
  }
  async function getRoutineRuns(id, params) {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.cursor) q.set("cursor", params.cursor);
    const qs = q.toString() ? `?${q.toString()}` : "";
    return request(
      `/routines/${encodeURIComponent(id)}/runs${qs}`,
      { method: "GET" },
      false
    );
  }
  async function fetchAllRoutineRuns(id, limitPerPage = 100) {
    let allRuns = [];
    let cursor = void 0;
    let isTruncated = false;
    do {
      const res = await getRoutineRuns(id, {
        limit: limitPerPage,
        cursor
      });
      if (res.runs && res.runs.length > 0) {
        allRuns = allRuns.concat(res.runs);
      }
      if (res.truncated) {
        isTruncated = true;
      }
      cursor = res.next_cursor || void 0;
    } while (cursor);
    return { runs: allRuns, truncated: isTruncated };
  }
  async function createRoutine(req) {
    return request(
      "/routines",
      {
        method: "POST",
        body: JSON.stringify(req)
      },
      true
    );
  }
  async function updateRoutine(id, req) {
    return request(
      `/routines/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(req)
      },
      true
    );
  }
  async function duplicateRoutine(id) {
    return request(
      `/routines/${encodeURIComponent(id)}/duplicate`,
      {
        method: "POST",
        body: JSON.stringify({})
      },
      true
    );
  }
  async function pauseRoutine(id) {
    return request(
      `/routines/${encodeURIComponent(id)}/pause`,
      {
        method: "POST",
        body: JSON.stringify({})
      },
      true
    );
  }
  async function resumeRoutine(id) {
    return request(
      `/routines/${encodeURIComponent(id)}/resume`,
      {
        method: "POST",
        body: JSON.stringify({})
      },
      true
    );
  }
  async function testRoutine(id) {
    return request(
      `/routines/${encodeURIComponent(id)}/test`,
      {
        method: "POST",
        body: JSON.stringify({ confirm: true })
      },
      true
    );
  }
  async function deleteRoutine(id, confirmName) {
    return request(
      `/routines/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ confirm_name: confirmName })
      },
      true
    );
  }
  async function getActivity(params) {
    const q = new URLSearchParams();
    q.set("tab", params.tab);
    if (params.bot && params.bot !== "all") q.set("bot", params.bot);
    if (params.room) q.set("room", params.room);
    if (params.origin && params.origin !== "all") q.set("origin", params.origin);
    if (params.status && params.status !== "all") q.set("status", params.status);
    if (params.since) q.set("since", params.since);
    if (params.until) q.set("until", params.until);
    if (params.min_cost_cents !== void 0) q.set("min_cost_cents", String(params.min_cost_cents));
    if (params.limit !== void 0) q.set("limit", String(params.limit));
    if (params.cursor) q.set("cursor", params.cursor);
    return request(
      `/activity?${q.toString()}`,
      { method: "GET" },
      false
    );
  }
  async function addActivityContext(id, req) {
    return request(
      `/activity/${encodeURIComponent(id)}/context`,
      {
        method: "POST",
        body: JSON.stringify(req)
      },
      true
    );
  }
  async function redirectActivity(id, req) {
    return request(
      `/activity/${encodeURIComponent(id)}/redirect`,
      {
        method: "POST",
        body: JSON.stringify(req)
      },
      true
    );
  }
  async function stopActivity(id, req) {
    return request(
      `/activity/${encodeURIComponent(id)}/stop`,
      {
        method: "POST",
        body: JSON.stringify(req || {})
      },
      true
    );
  }
  async function getRooms(params) {
    const q = new URLSearchParams();
    if (params?.include_disbanded) q.set("include_disbanded", "true");
    if (params?.limit !== void 0) q.set("limit", String(params.limit));
    if (params?.cursor) q.set("cursor", params.cursor);
    const query = q.toString();
    return request(
      query ? `/rooms?${query}` : "/rooms",
      { method: "GET" },
      false
    );
  }
  async function getRoom(roomId) {
    return request(
      `/rooms/${encodeURIComponent(roomId)}`,
      { method: "GET" },
      false
    );
  }
  async function getRoomLog(roomId, params) {
    const q = new URLSearchParams();
    if (params?.since_seq !== void 0) q.set("since_seq", String(params.since_seq));
    if (params?.limit !== void 0) q.set("limit", String(params.limit));
    const query = q.toString();
    return request(
      query ? `/rooms/${encodeURIComponent(roomId)}/log?${query}` : `/rooms/${encodeURIComponent(roomId)}/log`,
      { method: "GET" },
      false
    );
  }
  async function createRoom(data) {
    return request(
      "/rooms",
      {
        method: "POST",
        body: JSON.stringify(data)
      },
      true
    );
  }
  async function patchRoom(roomId, data) {
    return request(
      `/rooms/${encodeURIComponent(roomId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(data)
      },
      true
    );
  }
  async function sendRoomMessage(roomId, data) {
    return request(
      `/rooms/${encodeURIComponent(roomId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify(data)
      },
      true
    );
  }
  async function stopRoom(roomId) {
    return request(
      `/rooms/${encodeURIComponent(roomId)}/stop`,
      {
        method: "POST",
        body: JSON.stringify({})
      },
      true
    );
  }
  async function retryRoomTask(roomId, taskId) {
    return request(
      `/rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}/retry`,
      {
        method: "POST",
        body: JSON.stringify({ confirm: true })
      },
      true
    );
  }
  async function disbandRoom(roomId, confirmName) {
    return request(
      `/rooms/${encodeURIComponent(roomId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ confirm_name: confirmName })
      },
      true
    );
  }
  async function getHandoffs(params) {
    const q = new URLSearchParams();
    if (params?.room) q.set("room", params.room);
    if (params?.bot) q.set("bot", params.bot);
    if (params?.state) q.set("state", params.state);
    if (params?.limit !== void 0) q.set("limit", String(params.limit));
    if (params?.cursor) q.set("cursor", params.cursor);
    const query = q.toString();
    return request(
      query ? `/handoffs?${query}` : "/handoffs",
      { method: "GET" },
      false
    );
  }
  async function promoteHandoff(handoffId) {
    return request(
      `/handoffs/${encodeURIComponent(handoffId)}/promote`,
      {
        method: "POST",
        body: JSON.stringify({})
      },
      true
    );
  }
  async function getTeamMap(params) {
    const query = params?.window ? `?window=${params.window}` : "";
    return request(`/map${query}`, { method: "GET" }, false);
  }
  async function searchLuveBot(params) {
    const qs = new URLSearchParams();
    qs.set("q", params.q);
    if (params.types) qs.set("types", params.types);
    if (params.bots) qs.set("bots", params.bots);
    if (params.limit !== void 0) qs.set("limit", String(params.limit));
    return request(`/search?${qs.toString()}`, { method: "GET" }, false);
  }
  async function pauseBot(bot, body = {}) {
    return request(`${botPath(bot)}/pause`, { method: "POST", body: JSON.stringify(body) }, true);
  }
  async function resumeBot(bot) {
    return request(`${botPath(bot)}/resume`, { method: "POST", body: JSON.stringify({}) }, true);
  }
  var pagePath = (bot, slug) => `${botPath(bot)}/pages/${encodeURIComponent(slug)}`;
  async function listPages(bot, q) {
    const qs = q ? `?q=${encodeURIComponent(q)}` : "";
    return request(`${botPath(bot)}/pages${qs}`, { method: "GET" }, false);
  }
  async function getPage(bot, slug) {
    return request(pagePath(bot, slug), { method: "GET" }, false);
  }
  async function listPageRevisions(bot, slug, cursor) {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return request(`${pagePath(bot, slug)}/revisions${qs}`, { method: "GET" }, false);
  }
  async function getPageRevision(bot, slug, rev) {
    return request(`${pagePath(bot, slug)}/revisions/${rev}`, { method: "GET" }, false);
  }
  async function createPage(bot, body) {
    return request(`${botPath(bot)}/pages`, { method: "POST", body: JSON.stringify(body) }, true);
  }
  async function savePage(bot, slug, body) {
    return request(pagePath(bot, slug), { method: "PUT", body: JSON.stringify(body) }, true);
  }
  async function restorePageRevision(bot, slug, rev, body) {
    return request(`${pagePath(bot, slug)}/revisions/${rev}/restore`, { method: "POST", body: JSON.stringify(body) }, true);
  }
  async function downloadBotFile(bot, path) {
    const authed = getSDK2()?.authedFetch;
    if (!authed) throw new ApiError({ code: "sdk_unavailable", message: "Hermes Plugin SDK authedFetch is not available in this environment.", status: 503 });
    const res = await authed(`${BASE_API_PATH}${botPath(bot)}/files/download?path=${encodeURIComponent(path)}`, { method: "GET" });
    if (!res.ok) throw parseApiError({ status: res.status, body: await res.text().catch(() => "") });
    let name = path.split("/").pop() || path;
    const m = (res.headers.get("Content-Disposition") ?? "").match(/filename\*=UTF-8''([^;\s]+)/i);
    if (m) {
      try {
        name = decodeURIComponent(m[1]);
      } catch {
      }
    }
    return { name, blob: await res.blob() };
  }
  async function uploadAttachment(bot, file) {
    const authed = getSDK2()?.authedFetch;
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
  async function setBotWorkspace(bot) {
    return request(`${botPath(bot)}/workspace`, { method: "POST" }, true);
  }
  async function getIntroduction(bot) {
    return request(`${botPath(bot)}/introduction`, { method: "GET" }, false);
  }
  async function startIntroduction(bot) {
    return request(`${botPath(bot)}/introduction`, { method: "POST", body: JSON.stringify({ confirm_cost: true }) }, true);
  }

  // dashboard/src/pwa/register.ts
  function getPluginBasePath() {
    if (typeof window === "undefined") return "";
    return window.__HERMES_BASE_PATH__ || "";
  }
  function injectManifestLink(basePath = getPluginBasePath()) {
    if (typeof document === "undefined") return null;
    const manifestHref = `${basePath}/dashboard-plugins/luvebot/pwa.json`;
    let existing = document.querySelector('link[rel="manifest"]');
    if (!existing) {
      existing = document.createElement("link");
      existing.rel = "manifest";
      existing.href = manifestHref;
      document.head.appendChild(existing);
    }
    if (!document.querySelector('meta[name="theme-color"]')) {
      const meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.content = "#0b0f19";
      document.head.appendChild(meta);
    }
    return existing;
  }
  function pluginIconUrl(file, basePath = getPluginBasePath()) {
    return `${basePath}/dashboard-plugins/luvebot/icons/${file}`;
  }
  function injectIconLinks(basePath = getPluginBasePath()) {
    if (typeof document === "undefined") return [];
    const want = [
      ["icon", "favicon-32.png", "32x32"],
      ["icon", "icon.svg"],
      ["apple-touch-icon", "apple-touch-icon.png", "180x180"]
    ];
    return want.map(([rel, file, sizes]) => {
      const href = pluginIconUrl(file, basePath);
      let link = document.querySelector(`link[data-luvebot][rel="${rel}"][href="${href}"]`);
      if (!link) {
        link = document.createElement("link");
        link.rel = rel;
        link.href = href;
        if (sizes) link.setAttribute("sizes", sizes);
        link.setAttribute("data-luvebot", "");
        document.head.appendChild(link);
      }
      return link;
    });
  }
  async function registerServiceWorker(basePath = getPluginBasePath()) {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return null;
    }
    const isSecure = window.location.protocol === "https:" || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    if (!isSecure) {
      return null;
    }
    const swUrl = `${basePath}/dashboard-plugins/luvebot/sw.js`;
    const scope = `${basePath}/dashboard-plugins/luvebot/`;
    try {
      const registration = await navigator.serviceWorker.register(swUrl, { scope });
      return registration;
    } catch (err) {
      return null;
    }
  }
  async function registerPwa(basePath = getPluginBasePath()) {
    const link = injectManifestLink(basePath);
    const manifestInjected = link !== null;
    injectIconLinks(basePath);
    const sw = await registerServiceWorker(basePath);
    const serviceWorkerRegistered = sw !== null;
    return {
      manifestInjected,
      serviceWorkerRegistered,
      scope: `${basePath}/dashboard-plugins/luvebot/`
    };
  }

  // dashboard/src/shims/react-jsx-runtime.ts
  var getSDK3 = () => {
    if (typeof window !== "undefined" && window.__HERMES_PLUGIN_SDK__) {
      return window.__HERMES_PLUGIN_SDK__;
    }
    return void 0;
  };
  var getReact2 = () => getSDK3()?.React || (typeof globalThis !== "undefined" ? globalThis.React : void 0);
  function jsx(type, props, key) {
    const React16 = getReact2();
    if (!React16) {
      throw new Error("[LuveBot] Hermes Plugin SDK React is not loaded on window.__HERMES_PLUGIN_SDK__");
    }
    const { children, ...rest } = props || {};
    if (key !== void 0) {
      rest.key = key;
    }
    return React16.createElement(type, rest, children);
  }
  function jsxs(type, props, key) {
    return jsx(type, props, key);
  }
  var Fragment2 = getReact2()?.Fragment || Symbol.for("react.fragment");

  // dashboard/src/components/ui/Wordmark.tsx
  function Wordmark({ scheme, height = 36 }) {
    return /* @__PURE__ */ jsx(
      "img",
      {
        src: pluginIconUrl(scheme === "dark" ? "luvebot-wordmark-white.svg" : "luvebot-wordmark.svg"),
        alt: "LuveBot",
        height,
        style: { display: "block", height, width: "auto" }
      }
    );
  }

  // dashboard/src/i18n.ts
  var translations = {
    pt: {
      // Topbar & Global
      searchPlaceholder: "Buscar mensagens, bots, rotinas... (\u2318K)",
      activeBotsCount: "0 Bots ativos",
      pauseAll: "Pausar tudo",
      resumeAll: "Retomar",
      langPortuguese: "Portugu\xEAs",
      langEnglish: "English",
      toggleLanguage: "Alternar idioma (PT/EN)",
      toggleMenu: "Alternar menu",
      btnProfile: "Perfil",
      pageArea: "\xC1rea da p\xE1gina: {tab}",
      // Sidebar
      navSectionMain: "Navega\xE7\xE3o Principal",
      navHoje: "Hoje",
      navAprovacoes: "Aprova\xE7\xF5es",
      navAtividade: "Atividade",
      navRotinas: "Rotinas",
      navMapa: "Mapa",
      navCustos: "Custos",
      navConfig: "Configura\xE7\xF5es",
      navSearch: "Buscar",
      backToList: "Voltar para as conversas",
      hermesPanel: "Painel do Hermes",
      themeLabel: "Tema do LuveBot",
      themeAuto: "Autom\xE1tico",
      themeAutoHint: "Segue o claro ou escuro do sistema.",
      themeLight: "Claro",
      themeDark: "Escuro",
      backToLuveBot: "Voltar ao LuveBot",
      activityRunTitle: "Conversa",
      activityRoutineRunTitle: "Rotina",
      activityRoutineDueTitle: "Rotina agendada",
      activityTaskTitle: "Tarefa",
      sectionBots: "Bots",
      newBot: "Novo Bot",
      emptyBots: "Nenhum Bot ainda",
      sectionSalas: "Salas",
      newSala: "Nova sala",
      emptySalas: "Nenhuma sala",
      sectionOcultos: "Ocultos",
      // Home "Hoje"
      hojeTitle: "Hoje",
      needsYouTitle: "Precisa de voc\xEA",
      inProgressTitle: "Em andamento",
      completedTodayTitle: "Conclu\xEDdo hoje",
      // Empty States
      needsYouEmpty: "Tudo tranquilo. Nenhuma aprova\xE7\xE3o, pergunta ou handoff pendente no momento.",
      inProgressEmpty: "Nenhuma tarefa em andamento. Inicie uma conversa com um Bot ou aguarde a pr\xF3xima rotina programada.",
      completedTodayEmpty: "Nenhuma tarefa conclu\xEDda hoje ainda. Os resultados e artefatos entregues pelos Bots aparecer\xE3o aqui.",
      // Onboarding 3 templates
      onboardingTitle: "Nenhum Bot criado ainda",
      onboardingSubtitle: "Crie seu primeiro colega de trabalho a partir de um modelo comprovado:",
      templateGabineteTitle: "Chefe de Gabinete",
      templateGabineteDesc: "Coordena tarefas, distribui demandas e supervisiona o time de agentes.",
      templateVendasTitle: "Vendas B2B",
      templateVendasDesc: "Pesquisa prospects, l\xEA CRM e prepara follow-ups para aprova\xE7\xE3o humana.",
      templateDevTitle: "Engenheiro Dev",
      templateDevDesc: "Diagn\xF3stica bugs, executa testes em sandbox e prepara corre\xE7\xF5es de c\xF3digo.",
      createTemplateBtn: "Criar este Bot",
      // Routines footer
      nextRoutinesTitle: "Pr\xF3ximas rotinas",
      noRoutinesScheduled: "Nenhuma rotina agendada para hoje.",
      zeroScheduled: "0 agendadas",
      scheduledCount: "{count} agendadas",
      activeBotsCountParam: "{count} Bots ativos",
      activeBotCountParamSingle: "{count} Bot ativo",
      // Bot Sidebar List & Badges
      statusUnreadLabel: "N\xE3o lido",
      statusUnreadTitle: "Resultado n\xE3o lido",
      statusNeedsYouLabel: "Precisa de voc\xEA",
      statusNeedsYouTitle: "Precisa de voc\xEA (aprova\xE7\xE3o ou pergunta pendente)",
      statusWorkingLabel: "Trabalhando",
      statusWorkingTitle: "Bot trabalhando",
      statusTyping: "digitando...",
      statusPausedLabel: "Pausado",
      statusPausedTitle: "Bot pausado (ESTOP ou limite de gastos)",
      statusErrorLabel: "Erro",
      statusErrorTitle: "Erro recente na execu\xE7\xE3o",
      statusOfflineLabel: "Desconectado",
      statusOfflineTitle: "Gateway desconectado para este perfil",
      statusIdleLabel: "Inativo",
      statusIdleTitle: "Dispon\xEDvel",
      offlineHeader: "Sem conex\xE3o com o Hermes",
      offlineSub: "Aguardando sinal do API Server...",
      reconnectNow: "Reconectar agora",
      errorLoadingBots: "Erro ao carregar bots",
      retry: "Tentar novamente",
      loadingBots: "Carregando bots",
      createFirstBot: "Criar primeiro Bot",
      // BotCreateModal (Wizard)
      createBotModalTitle: "Criar Novo Bot",
      stepOf: "Passo {step} de 4",
      close: "Fechar",
      wizardStep1Title: "1. Escolha um modelo ou comece do zero",
      wizardStep1Subtitle: "Cada modelo vem configurado com instru\xE7\xF5es especializadas e ferramentas adequadas.",
      useThisTemplate: "Usar este modelo",
      createFromScratch: "Criar do Zero",
      createFromScratchDesc: "Configure um Bot totalmente personalizado sem instru\xE7\xF5es pr\xE9vias.",
      customBadge: "Personalizado",
      wizardStep2Title: "2. Identidade do Bot",
      wizardStep2Subtitle: "Defina o nome do perfil Hermes e a apresenta\xE7\xE3o visual do agente.",
      profileIdentifierLabel: "Identificador do Perfil (Hermes) *",
      profileIdentifierPlaceholder: "ex: vendas",
      visibleNameLabel: "Nome vis\xEDvel (Label)",
      visibleNamePlaceholder: "ex: Vendas B2B",
      primaryRoleLabel: "Papel principal",
      primaryRolePlaceholder: "ex: Prospec\xE7\xE3o B2B",
      callMeLabel: "Como ele deve te chamar",
      callMePlaceholder: "ex: Alex",
      avatarLabel: "Avatar (Emoji)",
      botColorLabel: "Cor do Bot (8 Arqu\xE9tipos)",
      nameRequired: "O identificador do perfil \xE9 obrigat\xF3rio.",
      nameFormatError: "Deve come\xE7ar com letra/n\xFAmero e conter at\xE9 64 caracteres (apenas letras, n\xFAmeros, h\xEDfens ou sublinhados).",
      nameInvalid: "Nome de perfil inv\xE1lido.",
      wizardStep3Title: "3. Diretrizes e Pol\xEDticas Operacionais",
      wizardStep3Subtitle: "Orienta\xE7\xF5es para o funcionamento e limites do Bot.",
      operationalDescriptionLabel: "Descri\xE7\xE3o em termos operacionais",
      operationalDescriptionDefault: "Agente especializado configurado conforme o modelo selecionado.",
      technicalRulesNoticeTitle: "Pol\xEDticas e regras t\xE9cnicas:",
      technicalRulesNotice: "O motor de regras t\xE9cnicas com bloqueios nativos e aprova\xE7\xF5es humanas ser\xE1 integrado na Fase 3. Por enquanto, as diretrizes de conduta s\xE3o orientadas pelo perfil e pelo modelo selecionado.",
      permanentSoulLabel: "Instru\xE7\xF5es permanentes do modelo (SOUL.md)",
      wizardStep4Title: "4. Modelo de Intelig\xEAncia Artificial",
      wizardStep4Subtitle: "Selecione o provedor e modelo recomendados para a especialidade do Bot.",
      providerLabel: "Provedor",
      providerOpenRouter: "OpenRouter (Recomendado)",
      providerAnthropic: "Anthropic Claude",
      providerOpenAI: "OpenAI",
      providerNous: "Nous Research",
      providerLocal: "Modelo Local (Ollama / vLLM)",
      modelLabel: "Modelo",
      modelPlaceholder: "claude-sonnet-5-5",
      connectMinimumNotice: "Conectar o m\xEDnimo necess\xE1rio: integra\xE7\xF5es com canais externos (Telegram, Slack, WhatsApp) poder\xE3o ser ativadas posteriormente na aba Canais do Perfil.",
      botCreatedSuccess: "Bot criado com sucesso!",
      introTitle: "O Bot se apresenta",
      introLoading: "Verificando a apresenta\xE7\xE3o do Bot\u2026",
      introOffer: "O Bot pode se apresentar agora: \xE9 uma execu\xE7\xE3o real do modelo, que custa cerca de {cost}.",
      introOfferNoEstimate: "O Bot pode se apresentar agora: \xE9 uma execu\xE7\xE3o real do modelo, com custo.",
      introStart: "Pedir que o Bot se apresente",
      introStarting: "Pedindo\u2026",
      introRunning: "O Bot est\xE1 se apresentando\u2026",
      introSlow: "A apresenta\xE7\xE3o est\xE1 demorando; ela aparece na conversa com o Bot assim que terminar.",
      introEmpty: "O Bot terminou sem dizer nada.",
      introFailed: "A apresenta\xE7\xE3o n\xE3o terminou. Voc\xEA pode conversar com o Bot mesmo assim.",
      introUnavailable: "A apresenta\xE7\xE3o n\xE3o est\xE1 dispon\xEDvel agora.",
      introNoTemplate: "Este Bot n\xE3o foi criado a partir de um modelo, ent\xE3o n\xE3o h\xE1 apresenta\xE7\xE3o para ele.",
      introHookNotLive: "A apresenta\xE7\xE3o come\xE7a quando o hook do LuveBot estiver ativo neste Bot (o gateway precisa estar rodando).",
      introBotOffline: "Este Bot est\xE1 sem conex\xE3o com o Hermes; a apresenta\xE7\xE3o come\xE7a quando ele estiver no ar.",
      introBotPaused: "Este Bot est\xE1 pausado; retome-o para que ele se apresente.",
      introBudgetExceeded: "O teto de gasto deste Bot foi atingido; ajuste em Custos para que ele se apresente.",
      botReadyToOperate: "est\xE1 pronto para operar",
      back: "Voltar",
      next: "Avan\xE7ar",
      createBotBtn: "Criar Bot",
      creatingBotBtn: "Criando Bot...",
      startWithThisBot: "Iniciar com este Bot",
      // BotProfile
      botProfileTabs: "Abas do perfil",
      profileLoading: "Carregando perfil do Bot...",
      tabIdentity: "1. Identidade",
      tabInstructions: "2. Instru\xE7\xF5es (SOUL.md)",
      tabModel: "3. Modelo",
      tabRules: "4. Regras",
      closeProfile: "Fechar perfil",
      defaultRoleAgent: "Agente LuveBot",
      identitySaveSuccess: "Identidade atualizada com sucesso!",
      errorSaving: "Erro ao salvar altera\xE7\xF5es",
      hermesIdentifierLabel: "Identificador Hermes (Perfil)",
      callMeLabelProfile: "Como deve te chamar (Call me)",
      avatarEmojiInitialsLabel: "Avatar (Emoji ou Iniciais)",
      saveChanges: "Salvar altera\xE7\xF5es",
      saving: "Salvando...",
      soulNotice: "Visualiza\xE7\xE3o somente leitura. A edi\xE7\xE3o do SOUL.md pelo LuveBot ser\xE1 disponibilizada em fase futura com auditoria completa.",
      readOnlyBadge: "Somente Leitura",
      soulTipTitle: "Editor do SOUL.md:",
      soulTipText: "Regras permanentes aqui; tarefas na conversa.",
      soulTipSub: "O SOUL define a personalidade, permiss\xF5es \xE9ticas e instru\xE7\xF5es perp\xE9tuas de sistema do Bot.",
      soulContentTitle: "Conte\xFAdo do arquivo SOUL.md",
      charactersCount: "caracteres",
      soulPlaceholder: "# SOUL.md\nDefina aqui o prop\xF3sito e as diretrizes do Bot...",
      modelNotice: "Configura\xE7\xE3o atual do modelo. A altera\xE7\xE3o de provedor e modelo pelo LuveBot ser\xE1 disponibilizada em fase futura com auditoria completa.",
      providerAILabel: "Provedor de IA",
      mainModelLabel: "Modelo Principal",
      thinkingModeLabel: "Modo Racioc\xEDnio (Thinking)",
      thinkingModeDesc: "Permite ao modelo detalhar seu pensamento antes de executar ferramentas.",
      fallbackModelLabel: "Modelo de Fallback (Conting\xEAncia)",
      // Conversation
      conversationWith: "Conversa com",
      thought: "Pensamento",
      // Transcript cards & honest fallbacks (T7.1 F0)
      cardSubagent: "Subagente",
      subagentTimeout: "Passou do tempo",
      subagentUnknown: "Terminou sem dizer o resultado",
      subagentBackground: "Rodando em segundo plano",
      subagentBackgroundLate: "O subagente est\xE1 em segundo plano; o resultado ainda n\xE3o chegou a esta conversa",
      approvalStatePending: "pendente",
      approvalStateDecided: "decidida",
      approvalStateConsumed: "executada",
      approvalStateExpired: "expirada",
      approvalStateStale: "desatualizada",
      approvalDecidedOnce: "Permitida uma vez",
      approvalDecidedDeny: "Negada",
      approvalChoiceOnce: "Permitir uma vez",
      approvalChoiceSession: "Permitir nesta sess\xE3o",
      approvalChoiceAlways: "Sempre permitir",
      approvalChoiceDeny: "Negar",
      routineRunRunning: "em execu\xE7\xE3o",
      handoffStateTriage: "em triagem",
      handoffStateReady: "pronto",
      handoffStateRunning: "em andamento",
      handoffStateBlocked: "bloqueado",
      handoffStateReview: "em revis\xE3o",
      handoffStateDone: "conclu\xEDdo",
      handoffStateCancelled: "cancelado",
      hojeRoutinesNext: 'Pe\xE7a a um Bot "toda manh\xE3 \xE0s 8h\u2026" ou crie uma rotina.',
      settingsTabGeneral: "Geral",
      settingsTabCosts: "Custos",
      settingsTabRules: "Regras",
      settingsLanguage: "Idioma",
      settingsThemeNote: "Claro ou escuro segue o tema do dashboard do Hermes (e o do sistema).",
      soundsTitle: "Sons do LuveBot",
      soundsAll: "Mensagens novas e o que precisa de voc\xEA",
      soundsNeedsYou: "S\xF3 o que precisa de voc\xEA",
      soundsOff: "Desligados",
      soundsNote: "Tocam s\xF3 quando voc\xEA n\xE3o est\xE1 olhando para aquele Bot (aba em segundo plano ou outra tela aberta), nunca pelo que voc\xEA mesmo fez, no m\xE1ximo um a cada 2 s. Guardado neste navegador.",
      settingsAppTitle: "App",
      shortcutsTitle: "Atalhos do teclado",
      shortcutSearch: "Buscar",
      shortcutNewBot: "Novo Bot",
      shortcutNewRoom: "Nova sala",
      shortcutSidebar: "Mostrar ou esconder a lista de conversas",
      shortcutBotN: "Abrir o Bot 1 a 9 da lista",
      shortcutBotStep: "Bot anterior ou pr\xF3ximo",
      shortcutComposer: "Ir para o campo de mensagem",
      shortcutApprovals: "G e depois A: Aprova\xE7\xF5es",
      shortcutClose: "Fechar o painel ou a janela",
      shortcutsNote: "\u2318 no Mac, Ctrl nos outros sistemas. Numa aba do navegador, \u2318N e \u23181\u20269 ficam com o pr\xF3prio navegador; no LuveBot instalado como app eles funcionam. Atalhos de letra n\xE3o valem enquanto voc\xEA digita.",
      hojeConfirmTest: "Confirmar teste",
      hojeTestRealWork: "Rodar teste executa trabalho real.",
      roomMembersBtn: "Membros",
      roomTeamMapBtn: "Mapa do time",
      roomKickoffTemplate: "@{a} junte as fontes. @{b} transforme em rascunho. N\xE3o publique nada.",
      agentPanelLabel: "Perfil de {name}",
      agentCallsYou: "Te chama de {name}",
      agentModel: "Modelo: {model}",
      agentActivityTabs: "Atividade do Bot",
      agentPausedUser: "Pausado por voc\xEA",
      agentPausedBudget: "Pausado pelo teto de gasto",
      agentPausedEstop: "Pausado no Hermes (n\xE3o pelo LuveBot)",
      agentPausedAll: "Tudo est\xE1 pausado",
      agentLoading: "Carregando\u2026",
      agentEmptyRunning: "Estou livre agora.",
      agentEmptyScheduled: "Ainda n\xE3o tenho rotinas.",
      agentEmptyDone: "Ainda n\xE3o terminei nada por aqui.",
      agentConfirmStop: "Confirmar parada",
      agentBudgetTitle: "Or\xE7amento",
      agentBudgetNone: "Voc\xEA ainda n\xE3o definiu um teto para mim.",
      agentBudgetLine: "Teto {period}: {spent} de {cap}",
      agentPeriodDay: "di\xE1rio",
      agentPeriodMonth: "mensal",
      agentManageCosts: "Gerenciar tetos",
      agentCustomize: "Personalizar",
      surfaceTitle: "Onde aprovar",
      surfaceIntro: "Quando uma regra pede confirma\xE7\xE3o, \xE9 aqui que voc\xEA escolhe onde responder.",
      surfaceLuvebot: "S\xF3 no LuveBot (padr\xE3o)",
      surfaceLuvebotDesc: "Os pedidos aparecem aqui no LuveBot. Nos canais, a a\xE7\xE3o fica bloqueada at\xE9 algu\xE9m aprovar aqui.",
      surfaceChannel: "Onde a conversa acontece",
      surfaceChannelDesc: "Em {platforms}, numa conversa privada, por quem voc\xEA nomear abaixo. As outras plataformas continuam bloqueando.",
      surfaceApproversLabel: "Quem pode aprovar no Telegram (ID num\xE9rico)",
      surfaceIdsPlaceholder: "ex.: 123456789, 987654321",
      surfaceApproversHelp: "Seu ID de usu\xE1rio no Telegram (da conta que conversa com o Bot, n\xE3o o ID do Bot). Pe\xE7a ao",
      surfaceUserInfoBot: "@userinfobot",
      surfaceApproversHelpAfter: "pela mesma conta.",
      surfaceIdsEmpty: "Nomeie pelo menos uma pessoa.",
      surfaceIdsFormat: "Use s\xF3 n\xFAmeros, separados por v\xEDrgula.",
      surfaceIdsMany: "No m\xE1ximo 20 pessoas.",
      surfaceIdsRepeat: "H\xE1 um ID repetido.",
      surfaceAllowAll: "Aten\xE7\xE3o: {reason} Enquanto for assim, a aprova\xE7\xE3o no canal n\xE3o vale.",
      surfacePending: "Aplicando: o hook confirma em alguns segundos.",
      surfacePendingSlow: "Ainda aplicando. Se n\xE3o confirmar, veja se o gateway deste Bot est\xE1 rodando; at\xE9 l\xE1, aprove no LuveBot.",
      surfaceHookOutdated: "Ainda n\xE3o aplicado: o hook deste Bot precisa ser atualizado (vers\xE3o agora: {version}; precisa {needed}+). At\xE9 l\xE1, aprove no LuveBot.",
      surfaceHookNotLive: "Ainda n\xE3o aplicado: o hook deste Bot n\xE3o est\xE1 ativo agora (o gateway precisa estar rodando com o hook instalado). At\xE9 l\xE1, aprove no LuveBot.",
      hookUpdateBtn: "Atualizar o hook deste Bot",
      hookUpdating: "Atualizando o hook\u2026",
      hookUpdated: "Hook atualizado.",
      hookAlreadyCurrent: "O hook deste Bot j\xE1 estava na vers\xE3o atual.",
      hookUpdateRestart: "Hook atualizado no disco, mas o gateway deste Bot precisa ser reiniciado para usar a vers\xE3o nova. At\xE9 l\xE1, aprove no LuveBot.",
      hookUpdateFailed: "N\xE3o deu para atualizar o hook deste Bot agora. Nada mudou; tente de novo.",
      surfaceNotAppliedUnknown: "Ainda n\xE3o aplicado por este Bot. At\xE9 l\xE1, aprove no LuveBot.",
      surfaceNoHook: "nenhuma",
      surfaceSaved: "Salvo.",
      surfaceSealsLabel: "Selo das regras que pedem confirma\xE7\xE3o, agora",
      surfaceErrUnsafe: "N\xE3o d\xE1 para aprovar no canal: {reason}",
      surfaceErrLoopback: "Este painel est\xE1 em modo loopback, sem login. Ligar a aprova\xE7\xE3o no canal ou nomear algu\xE9m precisa de uma pessoa com login no dashboard.",
      surfaceErrInvalid: "Confira os IDs: s\xF3 n\xFAmeros, de 1 a 20 pessoas, sem repetir.",
      surfaceErrCsrf: "A sess\xE3o expirou. Recarregue a p\xE1gina e tente de novo.",
      surfaceErrNetwork: "N\xE3o foi poss\xEDvel falar com o LuveBot agora.",
      surfaceErrGeneric: "N\xE3o foi poss\xEDvel salvar agora. Tente de novo.",
      errTechnical: "Detalhe t\xE9cnico",
      errHermesUnreachable: "O LuveBot n\xE3o conseguiu falar com o Hermes agora. Confira se o gateway est\xE1 rodando e tente de novo.",
      errHermesError: "O Hermes respondeu com um erro. Tente de novo; se continuar, veja os registros do Hermes.",
      errHermesTimeout: "O Hermes demorou demais para responder. Tente de novo em instantes.",
      errHermesUnverified: "N\xE3o deu para confirmar a vers\xE3o do Hermes agora. Tente de novo em instantes.",
      errCsrf: "Esta p\xE1gina ficou desatualizada. Recarregue a p\xE1gina e tente de novo.",
      errUnauthenticated: "Sua sess\xE3o no painel do Hermes acabou. Entre de novo e tente outra vez.",
      errRateLimited: "Muitas tentativas seguidas. Espere um pouco e tente de novo.",
      errInvalid: "Algum dado n\xE3o foi aceito. Confira o que foi preenchido e tente de novo.",
      errCapabilityMissing: "Esta vers\xE3o do Hermes n\xE3o oferece isso. Atualize o Hermes para usar.",
      errNotImplemented: "Isso ainda n\xE3o existe nesta vers\xE3o do LuveBot.",
      errBotNotFound: "Este Bot n\xE3o foi encontrado. Ele pode ter sido apagado no Hermes.",
      errBotPaused: "Este Bot est\xE1 pausado. Retome o Bot e tente de novo.",
      errBotOffline: "Este Bot est\xE1 sem conex\xE3o com o Hermes agora.",
      errBudgetExceeded: "O teto de gasto foi atingido. Ajuste o teto em Custos para continuar.",
      errTooLarge: "Isso \xE9 grande demais para enviar.",
      errConflict: "Algo mudou enquanto voc\xEA mexia aqui. Recarregue e tente de novo.",
      errLoopback: "Neste modo (loopback, sem login) o LuveBot n\xE3o deixa fazer isso. Entre pelo painel do Hermes com senha.",
      errAuditUnavailable: "O registro de auditoria do LuveBot n\xE3o est\xE1 dispon\xEDvel agora, ent\xE3o nada foi feito. Tente de novo.",
      errSdkUnavailable: "O painel do Hermes n\xE3o carregou por completo. Recarregue a p\xE1gina.",
      errRouteMissing: "Esta fun\xE7\xE3o ainda n\xE3o est\xE1 ativa: o painel do Hermes precisa ser reiniciado para carregar a vers\xE3o nova do LuveBot.",
      restartNotice: "O LuveBot foi atualizado; reinicie o painel do Hermes para usar a vers\xE3o nova.",
      errBotExists: "J\xE1 existe um Bot com esse nome. Escolha outro.",
      errDuplicate: "Isso j\xE1 existe. Confira a lista antes de criar de novo.",
      errRunNotFound: "Esta execu\xE7\xE3o n\xE3o foi encontrada no Hermes; ela pode j\xE1 ter terminado.",
      errSessionNotFound: "Esta conversa n\xE3o foi encontrada no Hermes.",
      surfaceReasonGatewayAll: "o gateway libera todos os usu\xE1rios (GATEWAY_ALLOW_ALL_USERS).",
      surfaceReasonTelegramAll: "o Telegram libera todos os usu\xE1rios (TELEGRAM_ALLOW_ALL_USERS).",
      surfaceReasonTelegramStar: "a lista de usu\xE1rios do Telegram tem o curinga * (TELEGRAM_ALLOWED_USERS).",
      surfaceReasonGatewayStar: "a lista de usu\xE1rios do gateway tem o curinga * (GATEWAY_ALLOWED_USERS).",
      surfaceReasonConfigAll: "o config.yaml libera todos os usu\xE1rios (allow_all_users).",
      surfaceReasonConfigStar: "o config.yaml tem o curinga * em allow_from.",
      surfaceReasonUnreadable: "n\xE3o foi poss\xEDvel ler quem o gateway deixa entrar.",
      agentIdentity: "Identidade e instru\xE7\xF5es",
      agentRules: "Regras deste Bot",
      agentRoutines: "Rotinas deste Bot",
      agentPause: "Pausar Bot",
      agentResume: "Retomar Bot",
      agentPauseExplain: "Rotinas e novos trabalhos deste Bot ficam parados at\xE9 voc\xEA retomar. O que j\xE1 foi feito n\xE3o \xE9 desfeito.",
      agentPauseStopActive: "Parar tamb\xE9m o trabalho em andamento",
      agentPauseConfirm: "Confirmar pausa",
      agentPauseDefaultScope: "No Bot padr\xE3o, a pausa vale para o LuveBot e as rotinas; canais como o Telegram continuam (use Pausar tudo para eles).",
      agentErrPausedAll: "Tudo est\xE1 pausado. Retome tudo antes de retomar este Bot.",
      agentErrBudgetHeld: "O teto de gasto segura este Bot. Retome pelo or\xE7amento.",
      agentErrNotOurs: "Esta pausa foi feita no Hermes ou por outra pessoa; o LuveBot n\xE3o a altera.",
      agentErrLoopback: "Em modo loopback, retomar exige uma sess\xE3o humana do dashboard.",
      backToConversation: "Voltar para a conversa",
      composerPlaceholder: "Mensagem para {name}",
      approvalNotResolvableHere: "O LuveBot n\xE3o conseguiu registrar este pedido, ent\xE3o ele n\xE3o pode ser decidido por aqui. Nada foi aprovado.",
      approvalNoLongerPending: "Este pedido n\xE3o est\xE1 mais pendente.",
      textTruncated: "\u2026 (texto truncado)",
      cardSubagentCost: "US$ {cost}",
      cardViewSession: "ver sess\xE3o",
      cardCommentary: "coment\xE1rio",
      cardApproval: "Pedido de aprova\xE7\xE3o",
      cardCopyId: "copiar ID",
      cardChoiceSession: "Nesta sess\xE3o",
      checkpointProgress: "{done} de {total}",
      checkpointProgressReview: "{done} de {total} \xB7 {review} para revisar",
      needsYouKindApproval: "Aprova\xE7\xE3o",
      needsYouKindHandoff: "Handoff",
      unknownHandle: "desconhecido",
      pausedReasonCapReached: "teto atingido",
      statusCompleted: "Conclu\xEDdo",
      statusInterrupted: "Interrompido",
      statusFailed: "Falhou",
      statusStopping: "Parando\u2026",
      statusWaitingApproval: "Aguardando aprova\xE7\xE3o",
      statusWorking: "Trabalhando\u2026",
      workPanelBtn: "Painel de trabalho",
      workPanelShort: "Painel",
      stepsOne: "1 passo",
      stepsMany: "{count} passos",
      stepsRunning: "em andamento",
      stepsDone: "conclu\xEDdos",
      stepsError: "com erro",
      stepsSeeInActivity: "Ver na Atividade",
      activityTurnIntro: "Apresenta\xE7\xE3o do Bot",
      activityTurnLabel: "Pedido: {text}",
      workPanelShow: "Mostrar painel de trabalho",
      workPanelHide: "Ocultar painel de trabalho",
      workPanelNew: "atividade nova",
      mascotPickerLabel: "Rosto do Bot (mascote)",
      pagesTitle: "P\xE1ginas",
      pageNewBtn: "Nova p\xE1gina",
      pageNewTitle: "Nova p\xE1gina",
      pageSaveAsTitle: "Salvar como p\xE1gina",
      pageTitleLabel: "T\xEDtulo",
      pageCreate: "Criar",
      pageSaveIn: "Fica em P\xE1ginas de {name}.",
      pageExists: "J\xE1 existe uma p\xE1gina com esse nome ({slug}). Escolha outro t\xEDtulo.",
      pageTitleInvalid: "Use letras ou n\xFAmeros no t\xEDtulo.",
      pageTooLarge: "A p\xE1gina passou de 1 MB; nada foi gravado.",
      pagesReadOnly: "Voc\xEA pode ler as p\xE1ginas, mas esta vers\xE3o do Hermes n\xE3o deixa o LuveBot salvar. Atualize o Hermes para editar.",
      pagesStateUnsupported: "P\xE1ginas ainda n\xE3o existe nesta instala\xE7\xE3o do LuveBot. Atualize o LuveBot para usar.",
      pagesStateUnavailable: "Esta vers\xE3o do Hermes n\xE3o tem o que o LuveBot precisa para P\xE1ginas. Atualize o Hermes.",
      pagesStateNoWorkspace: "Defina a pasta de trabalho de {name} para usar P\xE1ginas: no Hermes, abra {path} e preencha terminal.cwd com um caminho absoluto de uma pasta que j\xE1 exista, fora de ~/.hermes. O LuveBot n\xE3o tem esse campo no Perfil do Bot.",
      pagesProfileConfigFile: "o config.yaml do perfil deste Bot",
      pagesStateNotLocal: "P\xE1ginas ainda n\xE3o funciona com o terminal remoto ou em cont\xEAiner deste Bot.",
      pagesStateInsideHermes: "A pasta de trabalho do Bot fica dentro do Hermes; escolha outra.",
      pagesStateUnsafe: "A pasta pages/ deste Bot \xE9 um atalho; o LuveBot n\xE3o a abre.",
      pagesStateError: "N\xE3o deu para abrir as p\xE1ginas agora. Tente de novo em instantes.",
      pagesEmpty: "Nenhuma p\xE1gina ainda. Pe\xE7a ao Bot um documento ou crie a primeira.",
      pagesNoMatch: "Nenhuma p\xE1gina com esse texto.",
      pagesSearchLabel: "Buscar nas p\xE1ginas de {name}",
      pagesViewLabel: "Ver como",
      pagesViewGrid: "Grade",
      pagesViewList: "Lista",
      pagesSeeAll: "Ver todas ({count})",
      pagesOpenLibrary: "Abrir P\xE1ginas",
      pageChangedMark: "Mudou desde a sua \xFAltima leitura",
      pageLoading: "Abrindo\u2026",
      pageNotFound: "Esta p\xE1gina n\xE3o existe mais.",
      pageOfBot: "P\xE1gina de {name}",
      pageEdit: "Editar",
      pageHistory: "Hist\xF3rico",
      pageAskBot: "Perguntar ao {name} sobre esta p\xE1gina",
      pageMeta: "Atualizada por {who} em {when}",
      pageRevision: "revis\xE3o {rev}",
      pageRegionLabel: "P\xE1gina {title}",
      pageUpdatedWhileReading: "{name} atualizou esta p\xE1gina enquanto voc\xEA lia.",
      pageChangedSinceRead: "Esta p\xE1gina mudou desde a sua \xFAltima leitura.",
      pageSeeChanges: "Ver mudan\xE7as",
      pageChangesTitle: "O que mudou",
      pageVersionYouHad: "A vers\xE3o que voc\xEA tinha",
      pageVersionNow: "A vers\xE3o de agora",
      pageOldVersionGone: "A vers\xE3o que voc\xEA leu n\xE3o est\xE1 mais no hist\xF3rico (ele guarda as \xFAltimas 50).",
      pageRedactedBody: "Esta p\xE1gina tem algo que parece um segredo. A edi\xE7\xE3o aqui fica desligada; pe\xE7a ao Bot para tirar.",
      pageHistoryEmpty: "Ainda n\xE3o h\xE1 revis\xF5es gravadas pelo LuveBot.",
      pageHistoryLimit: "O hist\xF3rico guarda as \xFAltimas 50 revis\xF5es.",
      pageCurrentVersion: "atual",
      pageRestore: "Restaurar esta vers\xE3o",
      pageRestoreTitle: "Restaurar a revis\xE3o {rev}?",
      pageRestoreBody: "A p\xE1gina volta a este texto como uma revis\xE3o nova. Nada do hist\xF3rico \xE9 apagado.",
      pageRestoreConflict: "A p\xE1gina mudou enquanto voc\xEA olhava o hist\xF3rico. Abra de novo e tente outra vez.",
      pageSaving: "Salvando\u2026",
      pageUnsaved: "N\xE3o salvo ainda",
      pageSaveFailed: "N\xE3o salvo. Seu texto continua aqui.",
      pageSavedAt: "Salvo \xE0s {time}",
      pageNoChanges: "Sem mudan\xE7as",
      pageDone: "Concluir",
      pageConflictShort: "N\xE3o salvo: conflito",
      pageRedactedShort: "Edi\xE7\xE3o desligada: parece haver um segredo",
      pageConflictBody: "{who} alterou esta p\xE1gina. Recarregue para ver a outra vers\xE3o; seu texto fica guardado aqui.",
      pageCompare: "Comparar",
      pageCompareTitle: "Comparar as vers\xF5es",
      pageUseTheirs: "Usar a outra vers\xE3o",
      pageUseTheirsTitle: "Usar a vers\xE3o de {who}?",
      pageUseTheirsBody: "Seu texto n\xE3o salvo ser\xE1 descartado. Copie antes se quiser guardar.",
      pageWriteOver: "Gravar a minha por cima",
      pageCopyDraft: "Copiar meu texto",
      pageDraftCopied: "Copiado",
      pageYourDraft: "Seu texto",
      pageLeaveTitle: "Sair sem salvar?",
      pageLeaveBody: "H\xE1 mudan\xE7as que ainda n\xE3o foram gravadas. Se sair agora, elas se perdem.",
      pageKeepEditing: "Continuar editando",
      pageLeaveDiscard: "Sair sem salvar",
      pageSourceLabel: "Texto da p\xE1gina em Markdown",
      pagePreviewLabel: "Pr\xE9via da p\xE1gina",
      pageEditorViews: "Ver o texto ou a pr\xE9via",
      pageSourceTab: "Editar",
      pagePreviewTab: "Pr\xE9via",
      pageExpand: "Expandir",
      pageCollapse: "Recolher",
      pageDiffTooBig: "As vers\xF5es s\xE3o grandes demais para comparar aqui.",
      pageDiffLegend: "Linhas com \u2212 est\xE3o em {before}; com +, em {after}.",
      pageDiffSame: "As duas vers\xF5es s\xE3o iguais.",
      pageDiffLabel: "Diferen\xE7as linha a linha",
      pageDiffAdded: "Linha acrescentada: ",
      pageDiffRemoved: "Linha tirada: ",
      pageCardMeta: "P\xE1gina \xB7 atualizada por {name}",
      pageOpen: "Abrir",
      pageOpenNamed: "Abrir a p\xE1gina {title}",
      pageSaveAsMenu: "Salvar como p\xE1gina do Bot",
      pageSaveAsHint: "Guarda esta resposta como um documento do Bot, para abrir e editar depois em P\xE1ginas.",
      messageMoreActions: "Mais a\xE7\xF5es desta mensagem",
      attachBtn: "Anexar arquivo",
      attachListLabel: "Anexos desta mensagem",
      attachSentLabel: "Anexos enviados",
      attachSentItem: "Anexo {name}, {type}, {size}",
      attachRemove: "Remover {name}",
      attachNotice: "O conte\xFAdo dos anexos vai para o provedor do modelo deste Bot.",
      attachUploading: "Enviando anexo\u2026",
      attachDrop: "Solte para anexar",
      attachTooLarge: "{name} passa do limite: 10 MB para imagens, 20 MB para documentos.",
      attachTypeRefused: "{name} n\xE3o pode ser anexado. Aceitos: imagens (PNG, JPG, GIF, WebP), PDF, Word, Excel, PowerPoint e texto (TXT, MD, CSV, JSON).",
      attachTooMany: "At\xE9 {n} anexos por mensagem.",
      attachErrTooLarge: "O arquivo passa do limite: 10 MB para imagens, 20 MB para documentos.",
      attachErrType: "O LuveBot n\xE3o aceitou este arquivo: pelo conte\xFAdo, n\xE3o \xE9 de um tipo aceito. Aceitos: imagens (PNG, JPG, GIF, WebP), PDF, Word, Excel, PowerPoint e texto (TXT, MD, CSV, JSON).",
      attachErrSensitive: "Este nome de arquivo parece guardar segredos (como .env ou uma chave) e n\xE3o pode ser anexado.",
      attachErrGeneric: "N\xE3o deu para enviar o anexo. Tente de novo.",
      attachWsNone: "Este Bot ainda n\xE3o tem uma pasta de trabalho, que \xE9 onde os anexos ficam.",
      attachWsCreate: "Criar a pasta do Bot",
      attachWsCreated: "Pasta criada. Envie de novo.",
      attachWsCreateFailed: "N\xE3o deu para criar a pasta do Bot agora. Tente de novo.",
      pagesNoFolder: "{name} ainda n\xE3o tem uma pasta de trabalho para as P\xE1ginas.",
      pagesCreatingFolder: "Criando a pasta\u2026",
      attachWsNotLocal: "Anexos ainda n\xE3o funcionam com o terminal remoto ou em cont\xEAiner deste Bot.",
      attachWsInside: "A pasta de trabalho do Bot fica dentro do Hermes; escolha outra no Hermes para usar anexos.",
      attachWsUnsafe: "A pasta de anexos deste Bot \xE9 um atalho; o LuveBot n\xE3o grava nela.",
      attachWsOther: "A pasta de trabalho deste Bot n\xE3o est\xE1 dispon\xEDvel agora.",
      fileCardMeta: "Arquivo de {name} \xB7 {path}",
      fileDownload: "Baixar",
      fileEdit: "Editar",
      fileEditNamed: "Editar {file}",
      fileOpenInEditor: "Abrir no editor",
      fileOpenInEditorNamed: "Abrir {file} no editor",
      fileOpening: "Abrindo\u2026",
      fileCopyNote: "Abre uma c\xF3pia em P\xE1ginas para voc\xEA editar. O arquivo original fica no workspace do Bot, e o Bot continua mexendo nele, n\xE3o na c\xF3pia.",
      fileCopyExists: "J\xE1 existe uma p\xE1gina com esse nome ({slug}); nada foi sobrescrito.",
      fileOpenExisting: "Abrir a p\xE1gina existente",
      fileCopyNoPages: "As P\xE1ginas deste Bot ainda n\xE3o est\xE3o dispon\xEDveis (veja Perfil > P\xE1ginas); o arquivo continua em Baixar.",
      fileDownloadNamed: "Baixar {file}",
      fileDownloading: "Baixando\u2026",
      fileDownloadHint: "Salva este arquivo da pasta do Bot no seu aparelho.",
      fileErrNotFound: "Arquivo n\xE3o dispon\xEDvel: ele n\xE3o est\xE1 na pasta do Bot.",
      fileErrRedacted: "N\xE3o foi entregue: o arquivo cont\xE9m algo que parece um segredo.",
      fileErrNoWorkspace: "A pasta de trabalho deste Bot n\xE3o est\xE1 dispon\xEDvel.",
      fileErrTooLarge: "O arquivo passa de 25 MiB e n\xE3o pode ser baixado por aqui.",
      fileErrNetwork: "Sem conex\xE3o com o LuveBot. Tente de novo.",
      fileErrGeneric: "N\xE3o deu para baixar o arquivo agora. Tente de novo.",
      pageAboutChip: "Sobre a p\xE1gina {title}",
      pageAboutRemove: "Tirar a p\xE1gina desta mensagem",
      pageAboutSent: "sobre a p\xE1gina {slug}",
      pagesSearchCategory: "P\xE1ginas",
      workPanelTabs: "Abas do painel de trabalho",
      closePanelBtn: "Fechar painel",
      messageLabel: "Mensagem",
      stopBtn: "Parar",
      sendBtn: "Enviar",
      commErrorLuveBot: "Falha na comunica\xE7\xE3o com o LuveBot.",
      streamErrorGeneric: "A conversa com o Bot foi interrompida por um erro. Tente de novo.",
      unexpectedError: "Erro inesperado.",
      // WorkPanel
      tabActivity: "Atividade",
      tabTerminal: "Terminal",
      tabFiles: "Arquivos",
      tabScreen: "Tela",
      screenRegion: "Tela do Bot {name}",
      screenLoading: "Lendo a tela do Bot\u2026",
      screenUnsupported: "Esta m\xE1quina n\xE3o tem tela de Bot (s\xF3 servidores Linux).",
      screenNotInstalled: "Faltam pacotes da tela no servidor. O LuveBot n\xE3o instala nada: quem administra o servidor instala.",
      screenMissingLabel: "Faltam",
      screenInstallCommandLabel: "Comando sugerido pelo Hermes",
      screenReadmeLink: "Se\xE7\xE3o \u201CTela ao vivo\u201D do README",
      screenNoMemory: "Pouca mem\xF3ria livre para iniciar a tela agora.",
      screenMemoryNumbers: "Livre: {available} MB \xB7 necess\xE1rio: {needed} MB",
      screenHermesSays: "O Hermes informa",
      screenSandbox: "A tela fica no sandbox do terminal ({placement}); use a imagem com desktop.",
      screenStopped: "A tela do Bot est\xE1 parada.",
      screenStartBtn: "Iniciar a tela",
      screenStarting: "Iniciando a tela\u2026",
      screenConnecting: "Conectando \xE0 tela\u2026",
      screenWatching: "Voc\xEA est\xE1 vendo a tela. O Bot continua no controle.",
      screenOtherHuman: "Uma pessoa est\xE1 no controle desta tela agora.",
      screenTakeBtn: "Assumir controle",
      screenTakeTitle: "Assumir o controle da tela?",
      screenTakeBody: "Enquanto voc\xEA controla, o Bot para de usar a tela. Devolva quando terminar.",
      screenTakeOther: "Outra pessoa est\xE1 no controle agora; ela volta a s\xF3 ver.",
      screenReasonLabel: "Motivo (opcional, o Bot v\xEA)",
      screenTakeConfirm: "Assumir",
      screenInControl: "Voc\xEA est\xE1 no controle",
      screenReturnBtn: "Devolver ao Bot",
      screenReturnTitle: "Devolver o controle ao Bot?",
      screenReturnBody: "O Bot volta a poder usar a tela.",
      screenReturnConfirm: "Devolver",
      screenControlTaken: "Outra pessoa assumiu o controle. Voc\xEA voltou a s\xF3 ver.",
      screenTicketSpent: "A conex\xE3o expirou; reconectando para ver.",
      screenWentDown: "A tela parou.",
      screenOriginRefused: "O Hermes recusou a origem desta p\xE1gina; a tela n\xE3o abre aqui.",
      screenLost: "A conex\xE3o com a tela caiu.",
      screenReconnectBtn: "Reconectar",
      screenNoImage: "Sem imagem h\xE1 {n} s. A conex\xE3o est\xE1 aberta, mas nenhuma imagem nova chegou.",
      screenKeyboardBtn: "Teclado",
      screenKeyboardInput: "Digitar na tela do Bot",
      screenFullscreenBtn: "Tela cheia",
      screenRetryBtn: "Tentar de novo",
      screenErrUnavailable: "A tela ao vivo n\xE3o est\xE1 dispon\xEDvel nesta instala\xE7\xE3o.",
      screenErrInUse: "Uma pessoa est\xE1 no controle; a tela n\xE3o \xE9 parada embaixo dela.",
      screenErrNotRunning: "A tela n\xE3o est\xE1 rodando.",
      screenErrNotYours: "Voc\xEA n\xE3o est\xE1 no controle desta tela.",
      screenErrLoopback: "Devolver o controle precisa de um painel com login; este est\xE1 em modo loopback.",
      screenErrGeneric: "N\xE3o foi poss\xEDvel falar com a tela agora. Tente de novo.",
      screenErrNetwork: "Sem resposta da tela: a rede caiu ou o visualizador (noVNC) n\xE3o carregou.",
      emptyActivity: "Nada aconteceu ainda. As ferramentas usadas pelo Bot aparecem aqui.",
      emptyTerminal: "Nenhum comando de terminal nesta conversa.",
      runningStatus: "executando\u2026",
      noOutputChannel: "sem sa\xEDda registrada neste canal",
      outputExit: "sa\xEDda",
      emptyFiles: "Nenhuma ferramenta de arquivo foi observada nesta conversa. Quando o Hermes enviar uma, os caminhos lidos e escritos aparecem aqui.",
      writtenOp: "escrito",
      filesDelivered: "Entregues na conversa",
      readOp: "lido",
      // ApprovalsInbox
      approvalsTitle: "Caixa de Aprova\xE7\xF5es",
      pendingActionCountOne: "1 a\xE7\xE3o aguardando sua autoriza\xE7\xE3o",
      pendingActionCountMany: "{count} a\xE7\xF5es aguardando sua autoriza\xE7\xE3o",
      filterByBot: "Filtrar por Bot",
      filterByStatus: "Filtrar por status",
      filterAllBots: "Todos os Bots",
      filterPending: "Pendentes",
      filterAll: "Todas",
      refreshApprovals: "Atualizar aprova\xE7\xF5es",
      loopbackWarningApprovals: "Modo loopback ativo: aprova\xE7\xF5es est\xE3o em modo somente leitura (loopback_not_human). Conecte-se com autentica\xE7\xE3o protegida para decidir.",
      closeError: "Fechar erro",
      selectedCount: "{count} selecionado(s)",
      mismatchedClassWarning: "\u26A0 Classes diferentes selecionadas. O lote exige a mesma classe de a\xE7\xE3o.",
      allowSelectedOnce: "Permitir selecionados (uma vez)",
      denySelected: "Negar selecionados",
      clearSelection: "Limpar sele\xE7\xE3o",
      selectAllPending: "Selecionar todas as pendentes",
      totalCount: "{count} no total",
      noPendingApprovalsTitle: "Nenhuma aprova\xE7\xE3o pendente",
      noPendingApprovalsDesc: "Tudo em dia! O LuveBot notificar\xE1 voc\xEA assim que algum Bot solicitar permiss\xE3o para executar comandos, scripts ou a\xE7\xF5es protegidas.",
      actionAllowedOnce: "A\xE7\xE3o de {bot} permitida uma vez.",
      actionDenied: "A\xE7\xE3o de {bot} negada.",
      approvalInlineOnce: "Permitida uma vez.",
      statusResuming: "Retomando\u2026",
      approvalInlineDeny: "Negada.",
      denyReasonDelivered: "O motivo foi entregue ao Bot como instru\xE7\xE3o humana.",
      denyReasonSending: "Enviando o motivo ao Bot\u2026",
      denyReasonUnknown: "O motivo foi enviado, mas ainda n\xE3o h\xE1 confirma\xE7\xE3o de que o Bot o recebeu.",
      denyReasonKept: "O motivo ficou registrado no LuveBot e na auditoria; ele n\xE3o foi entregue ao Bot.",
      approvalInlineAlways: "Permitida uma vez; a regra ficou em rascunho.",
      actionAlwaysResolved: "A\xE7\xE3o de {bot} resolvida uma vez e regra criada em rascunho.",
      batchResolved: "{count} a\xE7\xF5es resolvidas em lote como '{choice}'.",
      viewParamsBtn: "Ver par\xE2metros",
      denyBtn: "Negar\u2026",
      alwaysAllowBtn: "Sempre permitir\u2026",
      allowOnceBtn: "Permitir uma vez",
      approvalRuleNoncanonical: "A\xE7\xE3o fora do padr\xE3o: o LuveBot pede a sua confirma\xE7\xE3o",
      approvalRuleNamed: "Regra \u201C{label}\u201D pede a sua confirma\xE7\xE3o",
      approvalRuleUnknown: "Uma regra do LuveBot pede a sua confirma\xE7\xE3o",
      approvalTechnicalDetail: "Detalhe t\xE9cnico",
      toolTerminal: "Comando no terminal",
      toolWriteFile: "Escrever arquivo",
      toolReadFile: "Ler arquivo",
      toolPatch: "Editar arquivo",
      toolWebSearch: "Busca na web",
      toolWebExtract: "Ler p\xE1gina da web",
      toolBrowser: "Navegador",
      toolSendMessage: "Enviar mensagem",
      disabledInLoopback: "Desabilitado em modo loopback",
      timeNow: "agora",
      timeAgoMins: "h\xE1 {mins} min",
      timeAgoHours: "h\xE1 {hrs} h",
      timeExpired: "expirado",
      timeExpiresMins: "expira em {mins} min",
      timeExpiresHours: "expira em {hrs} h",
      defaultActionLabel: "a\xE7\xE3o",
      selectApprovalAria: "Selecionar aprova\xE7\xE3o {id}",
      originRun: "Origem: Run",
      originTransport: "Origem: Transporte do canal",
      nativeChoices: "Op\xE7\xF5es nativas:",
      patternsLabel: "Padr\xF5es:",
      alwaysModalTitle: "Sempre permitir a\xE7\xF5es semelhantes?",
      alwaysModalHeader: "Sempre permitir\u2026 (Criar rascunho de regra)",
      alwaysModalExplanation: "O LuveBot segue a Invariante 6: nenhuma permiss\xE3o permanente \xE9 gravada diretamente no Hermes. Ao confirmar, criamos um rascunho de regra para revis\xE3o e autorizamos a execu\xE7\xE3o atual apenas uma vez (once).",
      alwaysModalExplanationP1: "Por seguran\xE7a (Invariante 6 e ADR-002), o LuveBot nunca grava permiss\xF5es permanentes diretas no Hermes sem revis\xE3o humana.",
      alwaysModalExplanationP2: "Esta a\xE7\xE3o resolver\xE1 o pedido atual uma \xFAnica vez (once) e criar\xE1 uma regra em rascunho com escopo do Bot {bot} para que voc\xEA possa revis\xE1-la e ativ\xE1-la quando desejar.",
      alwaysModalDraftLabel: "R\xF3tulo da regra em rascunho:",
      alwaysModalCancel: "Cancelar",
      alwaysModalConfirm: "Criar rascunho e permitir uma vez",
      denyModalTitle: "Negar solicita\xE7\xE3o de a\xE7\xE3o",
      denyModalTitleWithBot: "Negar a\xE7\xE3o do Bot '{bot}'",
      denyModalExplanation: "O motivo da nega\xE7\xE3o \xE9 obrigat\xF3rio e fica registrado no LuveBot e na auditoria.",
      denyModalReasonLabel: "Motivo da nega\xE7\xE3o (obrigat\xF3rio):",
      denyModalPlaceholder: "Explique por que esta a\xE7\xE3o n\xE3o \xE9 permitida...",
      denyModalConfirm: "Confirmar nega\xE7\xE3o",
      denyReasonRequired: "O motivo da nega\xE7\xE3o \xE9 obrigat\xF3rio para orientar o Bot.",
      denyReasonEmpty: "O motivo n\xE3o pode ficar em branco.",
      batchDenyModalTitle: "Negar solicita\xE7\xF5es em lote",
      batchDenyReasonLabel: "Motivo da nega\xE7\xE3o para o lote:",
      batchDenyReasonRequired: "O motivo da nega\xE7\xE3o em lote \xE9 obrigat\xF3rio.",
      batchDenyPlaceholder: "Ex: Opera\xE7\xF5es em lote recusadas pelo administrador...",
      batchMismatchRefused: "Aprova\xE7\xE3o em lote recusada: todos os itens devem pertencer \xE0 mesma classe de a\xE7\xE3o.",
      batchConfirmOnceTitle: "Permitir {count} a\xE7\xF5es em lote?",
      batchConfirmDenyTitle: "Negar {count} a\xE7\xF5es em lote?",
      batchConfirmExplanation: "Voc\xEA est\xE1 prestes a decidir {count} pedidos simultaneamente. Cada pedido ser\xE1 processado individualmente com seu respectivo digest verificado.",
      batchConfirmBtn: "Confirmar decis\xE3o em lote",
      editModalTitle: "Detalhes e Edi\xE7\xE3o da A\xE7\xE3o",
      editModalParametersTitle: "Par\xE2metros da a\xE7\xE3o",
      editModalWarning: "O LuveBot n\xE3o edita argumentos de uma aprova\xE7\xE3o: decida como est\xE1 ou negue com um motivo para o Bot refazer.",
      editModalActionLabel: "A\xE7\xE3o:",
      editModalCommandLabel: "Comando:",
      editModalDetailsLabel: "Detalhes:",
      editModalCommand: "Comando a executar:",
      editModalClose: "Fechar",
      digestVerifiedTitle: "Digest verificado: {digest}",
      digestPrefix: "digest:",
      errorLoopbackApprovalBlocked: "A\xE7\xE3o bloqueada: aprova\xE7\xF5es n\xE3o permitidas em conex\xE3o local (loopback_not_human).",
      errorStaleConflict: "Conflito: este pedido expirou, foi modificado ou j\xE1 foi decidido anteriormente (stale).",
      errorCsrfRequired: "Erro de seguran\xE7a: token CSRF ausente ou inv\xE1lido.",
      errorUnexpectedApproval: "Erro inesperado ao processar decis\xE3o de aprova\xE7\xE3o.",
      errorLoadingApprovals: "Falha ao carregar lista de aprova\xE7\xF5es.",
      // RulesView
      rulesTitle: "Regras e Governan\xE7a",
      rulesTitleBot: "Regras do Bot: {bot}",
      rulesSubtitle: "4 n\xEDveis de autonomia + bloqueio, preced\xEAncia estrita e selo honesto verificado em tempo real.",
      rulesTabRules: "Regras ({count})",
      rulesTabSimulator: "Simulador",
      newRuleBtn: "Nova regra",
      refreshRules: "Atualizar regras",
      loopbackWarningRules: "Modo loopback ativo: ativa\xE7\xE3o de regras e aprova\xE7\xF5es est\xE3o em modo somente leitura (loopback_not_human, D-012).",
      searchRulesPlaceholder: "Buscar por nome, ferramenta ou comando...",
      filterByLevel: "Filtrar por n\xEDvel",
      filterByState: "Filtrar por estado",
      filterAllLevels: "Todos os n\xEDveis",
      filterAllStates: "Todos os estados",
      filterActive: "Ativas",
      filterDrafts: "Rascunhos",
      filterSuggestions: "Sugest\xF5es do Bot",
      filterArchived: "Arquivadas",
      precedenceRuleText: "Preced\xEAncia: Bloquear > Devolver > Perguntar > Expl\xEDcito > Agir",
      noRulesFoundTitle: "Nenhuma regra encontrada",
      noRulesFoundDesc: "Crie uma nova regra ou ajuste os filtros para visualizar as diretivas de governan\xE7a.",
      sealLock: "Bloqueio real",
      sealHand: "Aprova\xE7\xE3o real",
      sealNote: "Orienta\xE7\xE3o",
      sealBroken: "Quebrado",
      sealCaveatHand: "Aprova\xE7\xE3o real para as formas que o padr\xE3o reconhece.",
      sealCaveatLock: "Bloqueio real para as formas que o padr\xE3o reconhece.",
      sealCaveatWhy: "O padr\xE3o l\xEA o comando como foi escrito: c\xF3digo inline, comando montado na execu\xE7\xE3o, scripts e alias n\xE3o s\xE3o lidos.",
      sealUnverified: "Sem selo",
      levelAllow: "1. Agir sem perguntar",
      levelExplicit: "2. Agir se eu pedir explicitamente",
      levelAsk: "3. Perguntar antes",
      levelHandback: "4. Devolver para mim",
      levelBlock: "Bloquear",
      badgeBuiltin: "\u{1F512} Embutida (imut\xE1vel)",
      badgeDraft: "Rascunho (sem efeito)",
      badgeSuggestion: "Sugest\xE3o do Bot (pendente de revis\xE3o)",
      ruleScopeGlobal: "Todos os Bots",
      ruleScopeRoom: "Sala {name}",
      ruleScopeRoutine: "Rotina {name}",
      toolsLabel: "Ferramentas:",
      commandsLabel: "Comandos:",
      problemsDetectedTitle: "\u26A0 Problemas detectados no selo de execu\xE7\xE3o:",
      qualifiersLabel: "Qualificadores:",
      statusBuiltinProtection: "Prote\xE7\xE3o de sistema imut\xE1vel",
      statusDraftInactive: "Rascunho inativo \u2014 ative para aplicar na execu\xE7\xE3o",
      statusHumanReviewNeeded: "Revis\xE3o humana necess\xE1ria",
      statusActiveVersion: "Ativa (vers\xE3o {version})",
      activateRuleBtn: "Ativar regra",
      reviewAsDraftBtn: "Revisar como rascunho",
      archiveBtn: "Arquivar",
      ruleActivatedSuccess: "Regra '{label}' ativada com sucesso.",
      ruleDraftConverted: "Sugest\xE3o convertida em rascunho para '{label}'. Revise antes de ativar.",
      ruleArchivedSuccess: "Regra '{label}' arquivada.",
      ruleDraftCreated: "Rascunho da regra '{label}' criado.",
      newRuleModalTitle: "Criar Nova Regra de Governan\xE7a",
      newRuleModalDesc: "Toda regra criada nasce em modo rascunho (draft) e requer ativa\xE7\xE3o expl\xEDcita para produzir efeitos.",
      ruleLabelInput: "Nome / R\xF3tulo da regra *",
      ruleLabelPlaceholder: "ex: Bloquear terminal rm -rf",
      ruleLevelInput: "N\xEDvel de Autonomia *",
      ruleScopeKindInput: "Escopo *",
      scopeGlobal: "Global (todos os Bots)",
      scopeBot: "Espec\xEDfico para um Bot",
      targetBotInput: "Bot alvo *",
      toolsMatchInput: "Ferramentas (separadas por v\xEDrgula)",
      toolsMatchPlaceholder: "ex: terminal, bash",
      commandsMatchInput: "Comandos / Padr\xF5es (separados por v\xEDrgula)",
      commandsMatchPlaceholder: "ex: rm -rf *, curl *",
      cancelBtn: "Cancelar",
      createDraftBtn: "Criar rascunho",
      simulatorTitle: "Simulador de A\xE7\xF5es e Preced\xEAncia de Regras",
      simulatorSubtitle: "Teste como o motor de regras avalia uma ferramenta ou comando para um Bot espec\xEDfico.",
      simBotLabel: "Bot:",
      simToolLabel: "Nome da ferramenta (tool):",
      simToolPlaceholder: "Ex: send_email, exec_command, install_package",
      simCommandLabel: "Comando executado (opcional):",
      simCommandPlaceholder: "ex: rm -rf /tmp",
      simEvaluating: "Avaliando...",
      simEvaluateBtn: "Simular a\xE7\xE3o",
      simResultTitle: "Resultado da Simula\xE7\xE3o:",
      simResultEvaluation: "Resultado da avalia\xE7\xE3o:",
      simDecisionLabel: "Decis\xE3o:",
      simWinningRuleLabel: "Regra vencedora:",
      simReasonLabel: "Motivo:",
      simMatchingRulesTitle: "Regras que casaram ({count}):",
      simNoMatchingRules: "Nenhuma regra ativa casou com esta a\xE7\xE3o. O efeito padr\xE3o \xE9 permitir sem restri\xE7\xE3o.",
      simMatchedOn: "(casou em: {pattern})",
      simPrecedenceExplanation: "A decis\xE3o final segue estritamente a preced\xEAncia: Bloquear > Devolver > Perguntar > Expl\xEDcito > Agir.",
      errorLoopbackRuleBlocked: "Ativa\xE7\xE3o de regra bloqueada em modo loopback para seguran\xE7a (loopback_not_human, D-012).",
      errorBuiltinImmutable: "Regras embutidas s\xE3o imut\xE1veis e n\xE3o podem ser alteradas.",
      errorStaleRule: "Vers\xE3o desatualizada da regra (stale). Recarregue a p\xE1gina.",
      errorUnexpectedRule: "Erro inesperado ao processar regra.",
      errorLoadingRules: "Erro ao carregar regras.",
      errorSimulatingRule: "Erro ao executar simula\xE7\xE3o de regras.",
      // Costs & Budget (spec §4.13, contract v0.2 §4)
      costsTitle: "Custos e Or\xE7amento",
      costsSubtitle: "Monitore gastos reais e gerencie tetos de or\xE7amento com seguran\xE7a.",
      tabOverview: "Vis\xE3o Geral de Gastos",
      tabBudgetLimits: "Tetos e Limites",
      tabPausedBots: "Bots Pausados",
      periodLabel: "Per\xEDodo:",
      periodDay: "Hoje",
      period7d: "\xDAltimos 7 dias",
      periodMonth: "M\xEAs atual",
      period30d: "\xDAltimos 30 dias",
      groupLabel: "Agrupar por:",
      groupBot: "Bot",
      groupModel: "Modelo",
      groupRoutine: "Rotina",
      groupDay: "Dia",
      filterBotLabel: "Filtrar por Bot:",
      allBotsOption: "Todos os Bots",
      totalSpendLabel: "Gasto Total ({period})",
      unpricedSessionsNotice: "{count} sess\xF5es sem precifica\xE7\xE3o do modelo",
      ledgerLagLabel: "Lat\xEAncia do ledger:",
      ledgerLagSeconds: "{seconds}s de atraso",
      ledgerStaleWarning: "Watcher desatualizado: novos runs podem ser recusados (watcher_stale)",
      ledgerBadge: "ledger",
      tableHeaderKey: "Item / Chave",
      tableHeaderSpend: "Gasto",
      tableHeaderTokens: "Tokens",
      tableHeaderSessions: "Sess\xF5es",
      noCostsData: "Nenhum dado de custo registrado para os filtros selecionados.",
      limitsTitle: "Tetos de Or\xE7amento Ativos",
      limitsSubtitle: "Quando um Bot atinge o teto, seus cron jobs s\xE3o pausados e novos runs pelo LuveBot s\xE3o recusados. Ele ainda responde no Telegram e nos outros canais.",
      scopeGlobalLabel: "Global",
      scopeBotLabel: "Bot: {name}",
      scopeRoutineLabel: "Rotina: {name}",
      limitPeriodDay: "Di\xE1rio",
      limitPeriodMonth: "Mensal",
      limitSpentOf: "{spent} de {limit} ({percent}%)",
      limitReserved: "Reservado: {reserved}",
      limitZeroBlocked: "Teto 0: todo trabalho bloqueado para este escopo",
      btnEditLimit: "Ajustar teto",
      btnSetLimit: "Definir novo teto",
      btnRemoveLimit: "Remover teto",
      noLimitsConfigured: "Nenhum teto de or\xE7amento configurado.",
      modalLimitTitle: "Configurar Teto de Or\xE7amento",
      limitScopeInput: "Escopo *",
      limitPeriodInput: "Per\xEDodo *",
      limitTargetInput: "Alvo (Bot / Rotina)",
      limitAmountLabel: "Valor do teto (USD) *",
      limitAmountPlaceholder: "ex: 10.00",
      limitCurrentValue: "Teto atual: {amount}",
      limitAmountCentsHint: "Valores s\xE3o processados em centavos inteiros pelo backend.",
      btnSaveLimit: "Salvar teto",
      btnConfirmRemoveLimit: "Confirmar remo\xE7\xE3o",
      pausedBotsTitle: "Bots Pausados por Estouro de Teto",
      pausedBotsEmpty: "Nenhum Bot pausado por teto no momento.",
      pausedBotReason: "Motivo: Estouro de teto or\xE7ament\xE1rio ({reason})",
      pausedSince: "Pausado desde: {time}",
      btnResumeBot: "Retomar Bot",
      resumeBotConfirmationTitle: "Confirmar Retomada do Bot",
      resumeBotConfirmationBody: "Tem certeza de que deseja retomar o bot '{bot}'? Cron jobs pausados pelo teto ser\xE3o reativados se o saldo permitir.",
      btnConfirmResume: "Confirmar Retomada",
      resumingBot: "Retomando...",
      botResumedSuccess: "Bot retomado com sucesso.",
      loopbackBudgetWarningTitle: "Modo Loopback Ativo (D-014)",
      loopbackBudgetWarningDetail: "Em modo loopback, apenas reduzir tetos existentes \xE9 permitido. Aumentar ou remover tetos e retomar Bots pausados exigem sess\xE3o humana autenticada (loopback_not_human).",
      errorLoopbackBudgetRaiseBlocked: "Aumentar ou remover teto bloqueado em modo loopback (loopback_not_human).",
      errorLoopbackBudgetResumeBlocked: "Retomada de Bot bloqueada em modo loopback. Requer confirma\xE7\xE3o humana (loopback_not_human).",
      errorLoadingCosts: "Erro ao carregar dados de custos.",
      errorLoadingBudget: "Erro ao carregar or\xE7amento e tetos.",
      errorSavingLimit: "Erro ao salvar teto de or\xE7amento.",
      errorResumingBot: "Erro ao retomar bot.",
      budgetAlertExceeded: "Alerta: Teto excedido ({percent}%) para {scope}",
      budgetAlertWarning: "Alerta: {percent}% do teto atingido para {scope}",
      refreshCostsAriaLabel: "Recarregar dados de custos",
      filterGroupAriaLabel: "Seletor de agrupamento de custos",
      filterPeriodAriaLabel: "Seletor de per\xEDodo de custos",
      filterBotAriaLabel: "Seletor de bot para filtro de custos",
      limitAmountInputAriaLabel: "Valor do teto em d\xF3lares",
      loopbackBadge: "loopback_not_human",
      limitTargetPlaceholder: "ex: vendas, rotina-1",
      // Routines (spec §4.9, contract v0.2 §3)
      routinesTitle: "Rotinas e Agendamentos",
      routinesSubtitle: "Gerencie tarefas recorrentes, hist\xF3rico completo e testes com seguran\xE7a.",
      newRoutineBtn: "Nova rotina",
      refreshRoutinesAriaLabel: "Recarregar lista de rotinas",
      filterRoutinesBotLabel: "Filtrar por Bot:",
      filterRoutinesStateLabel: "Estado:",
      stateAll: "Todos os estados",
      stateScheduled: "Agendadas",
      statePaused: "Pausadas",
      noRoutinesFound: "Nenhuma rotina encontrada com os filtros selecionados.",
      scheduleLabel: "Agenda: {expr}",
      nextRunLabel: "Pr\xF3xima execu\xE7\xE3o: {time}",
      lastRunLabel: "\xDAltima execu\xE7\xE3o: {time}",
      noRunYet: "Ainda n\xE3o executada",
      statusSuccess: "Sucesso",
      statusError: "Erro",
      statusRunning: "Em execu\xE7\xE3o",
      statusStopped: "Parada",
      pausedReasonUser: "Pausada pelo usu\xE1rio",
      pausedReasonBudget: "Pausada pelo teto de or\xE7amento",
      routineCapLabel: "Teto: {cap}",
      routineSpendLabel: "Gasto no per\xEDodo: {spend}",
      btnPauseRoutine: "Pausar",
      btnResumeRoutine: "Ativar",
      btnTestRoutine: "Rodar teste",
      btnEditRoutine: "Editar",
      btnDuplicateRoutine: "Duplicar",
      btnDeleteRoutine: "Apagar",
      btnViewHistory: "Hist\xF3rico e Detalhes",
      testDisabledPausedRoutine: "Testar desabilitado: n\xE3o \xE9 poss\xEDvel testar rotina pausada (routine_paused)",
      testWarningRealWork: "Aviso: Rodar teste executa trabalho real.",
      modalConfirmTestTitle: "Confirmar Teste da Rotina",
      modalConfirmTestBody: "Esta a\xE7\xE3o executa trabalho real atrav\xE9s do agente para a rotina '{name}'. Tem certeza que deseja prosseguir?",
      btnConfirmTest: "Executar teste",
      modalConfirmPauseTitle: "Confirmar Pausa da Rotina",
      modalConfirmPauseBody: "Deseja pausar a rotina '{name}'? As execu\xE7\xF5es programadas n\xE3o ser\xE3o iniciadas.",
      btnConfirmPause: "Pausar rotina",
      modalConfirmResumeTitle: "Confirmar Ativa\xE7\xE3o da Rotina",
      modalConfirmResumeBody: "Deseja ativar a rotina '{name}'? As pr\xF3ximas execu\xE7\xF5es seguir\xE3o a agenda.",
      btnConfirmResumeRoutine: "Ativar rotina",
      modalConfirmDeleteTitle: "Apagar Rotina Permanentemente",
      modalConfirmDeleteBody: "Esta a\xE7\xE3o \xE9 irrevers\xEDvel. Digite o nome da rotina '{name}' para confirmar a exclus\xE3o:",
      deleteRoutineInputPlaceholder: "Nome da rotina",
      btnConfirmDelete: "Apagar rotina",
      routineDetailTitle: "Detalhes da Rotina: {name}",
      instructionLabel: "Instru\xE7\xE3o (Prompt):",
      inputSourceLabel: "Fonte de entrada:",
      deliverySummaryLabel: "Entrega:",
      historyTitle: "Hist\xF3rico Completo de Execu\xE7\xF5es ({count})",
      historyTruncatedWarning: "Aviso: hist\xF3rico de scripts truncado em 100 execu\xE7\xF5es pelo runtime.",
      tableHeaderSession: "Sess\xE3o / Execu\xE7\xE3o",
      tableHeaderStarted: "In\xEDcio",
      tableHeaderDuration: "Dura\xE7\xE3o",
      tableHeaderStatus: "Status",
      tableHeaderCost: "Custo",
      noRunsRecorded: "Nenhuma execu\xE7\xE3o registrada para esta rotina ainda.",
      btnCloseDetail: "Voltar \xE0 lista",
      modalCreateRoutineTitle: "Criar Nova Rotina",
      modalEditRoutineTitle: "Editar Rotina",
      routineNameInput: "Nome da rotina *",
      routineNamePlaceholder: "ex: Relat\xF3rio matinal de vendas",
      routineScheduleExprInput: "Express\xE3o da agenda (Cron / Leg\xEDvel) *",
      routineScheduleExprPlaceholder: "ex: 0 8 * * 1-5",
      routinePromptInput: "Instru\xE7\xE3o / Prompt do agente *",
      routinePromptPlaceholder: "ex: Analise os novos leads e envie um resumo...",
      routineBotInput: "Bot respons\xE1vel *",
      btnSaveRoutine: "Salvar rotina",
      errorDeletingNameMismatch: "O nome digitado n\xE3o confere com o nome da rotina.",
      errorLoadingRoutines: "Erro ao carregar rotinas.",
      errorLoadingRoutineRuns: "Erro ao carregar hist\xF3rico de execu\xE7\xF5es.",
      errorTestingRoutine: "Erro ao rodar teste da rotina.",
      errorPausingRoutine: "Erro ao pausar rotina.",
      errorResumingRoutine: "Erro ao ativar rotina.",
      errorDeletingRoutine: "Erro ao apagar rotina.",
      errorSavingRoutine: "Erro ao salvar rotina.",
      routineTestedSuccess: "Teste da rotina iniciado com sucesso.",
      routinePausedSuccess: "Rotina pausada com sucesso.",
      routineResumedSuccess: "Rotina ativada com sucesso.",
      routineDeletedSuccess: "Rotina apagada com sucesso.",
      // Activity (spec §4.7, contract v0.2 §2)
      activityHeaderTitle: "Atividade",
      tabRunning: "Em andamento",
      tabScheduled: "Agendado",
      tabDone: "Conclu\xEDdo",
      viewList: "Lista",
      viewKanban: "Kanban",
      filterAllOrigins: "Todas as origens",
      filterAllStatuses: "Todos os status",
      filterOriginMessage: "Mensagem",
      filterOriginRoutine: "Rotina",
      filterOriginWebhook: "Webhook",
      filterOriginHandoff: "Handoff",
      filterStatusRunning: "Executando",
      filterStatusWaitingApproval: "Aguardando aprova\xE7\xE3o",
      filterStatusScheduled: "Agendado",
      filterStatusDone: "Conclu\xEDdo",
      filterStatusError: "Erro",
      filterStatusStopped: "Interrompido",
      filterStatusBlocked: "Bloqueado",
      activitySearchPlaceholder: "Buscar atividade...",
      activityMinCostPlaceholder: "Custo m\xEDn. (centavos)",
      kanbanColTriage: "Triagem",
      kanbanColTodo: "A Fazer",
      kanbanColScheduled: "Agendado",
      kanbanColReady: "Pronto",
      kanbanColRunning: "Em Execu\xE7\xE3o",
      kanbanColBlocked: "Bloqueado",
      kanbanColReview: "Em Revis\xE3o",
      kanbanColDone: "Conclu\xEDdo",
      activityBtnContext: "Adicionar contexto",
      activityBtnCorrect: "Corrigir",
      activityBtnRedirect: "Redirecionar",
      activityBtnStop: "Parar",
      activityBtnStopping: "Parando...",
      activityBtnConversation: "Conversa",
      activityBtnEvents: "Ver eventos",
      activityStopModalTitle: "Confirmar Parada",
      activityStopModalDesc: "Tem certeza de que deseja parar esta execu\xE7\xE3o? Esta a\xE7\xE3o enviar\xE1 um pedido de t\xE9rmino.",
      activityStopReasonPlaceholder: "Motivo opcional da parada...",
      activityStopConfirmBtn: "Confirmar Parada",
      activityRedirectModalTitle: "Redirecionar Tarefa",
      activityRedirectModalDesc: "Selecione o Bot para o qual esta tarefa ser\xE1 transferida.",
      activityRedirectSelectBotLabel: "Destino (Bot):",
      activityRedirectReasonPlaceholder: "Motivo da transfer\xEAncia...",
      activityRedirectConfirmBtn: "Confirmar Redirecionamento",
      activityContextModalTitle: "Adicionar Contexto ou Corre\xE7\xE3o",
      activityContextKindContext: "Contexto",
      activityContextKindCorrection: "Corre\xE7\xE3o",
      activityContextTextPlaceholder: "Instru\xE7\xF5es adicionais ou contexto para o Bot...",
      activityContextNotice: "Este texto entra no fio da tarefa e o Bot l\xEA na pr\xF3xima vez que abrir a tarefa. \xC9 dado de trabalho, nunca comando ao LuveBot.",
      activityContextConfirmBtn: "Enviar Informa\xE7\xE3o",
      activityPartialWarning: "Aviso: fontes parciais indispon\xEDveis ({sources})",
      noActivityFound: "Nenhuma atividade encontrada para os filtros atuais.",
      activityCheckpointBadge: "Checkpoint: {done}/{total} ({review} para revis\xE3o)",
      activityDurationLabel: "Dura\xE7\xE3o: {seconds}s",
      activityCostLabel: "Custo: {cost}",
      activityStartedAtLabel: "In\xEDcio: {time}",
      activityEndedAtLabel: "Fim: {time}",
      activityLanesGroupBot: "Raia do Bot: {bot}",
      activityRefreshBtn: "Atualizar",
      errorLoadingActivity: "Erro ao carregar atividades.",
      errorStoppingActivity: "Erro ao parar atividade.",
      errorRedirectingActivity: "Erro ao redirecionar atividade.",
      errorAddingContext: "Erro ao adicionar contexto.",
      activityStopSuccess: "Pedido de parada enviado com sucesso.",
      activityRedirectSuccess: "Atividade redirecionada com sucesso.",
      activityContextSuccess: "Contexto adicionado com sucesso.",
      // Rooms (spec §4.4, contract v0.3 §3, §4)
      roomsTitle: "Salas de Trabalho",
      roomsSubtitle: "Coordena\xE7\xE3o e discuss\xE3o em grupo com Bots do Hermes.",
      newRoomBtn: "Nova Sala",
      createRoomModalTitle: "Criar Nova Sala",
      editRoomModalTitle: "Editar Sala",
      roomNameLabel: "Nome da sala *",
      roomNamePlaceholder: "ex.: Lan\xE7amento Q4, Esquadr\xE3o Suporte",
      roomGoalLabel: "Objetivo da sala",
      roomGoalPlaceholder: "ex.: Coordenar prospec\xE7\xE3o e envio de propostas",
      roomMembersLabel: "Bots Membros (escolha de 2 a 6) *",
      roomMembersHelp: "Selecione de 2 a 6 Bots ativos. O elenco \xE9 fixado na cria\xE7\xE3o.",
      roomOwnerLabel: "Dono do pr\xF3ximo passo (Opcional)",
      roomCoordinatorLabel: "Coordenador da sala (Opcional)",
      roomKickoffLabel: "Iniciar com objetivo como primeira mensagem (consome 1 rodada)",
      roomKickoffNotice: "O objetivo ser\xE1 enviado como a primeira mensagem da discuss\xE3o.",
      btnSaveRoom: "Salvar Sala",
      btnCreateRoom: "Criar Sala",
      roomNeedTwoReady: "Faltam Bots conectados ao Hermes.",
      roomTooFewReadyTitle: "S\xF3 {count} Bot conectado ao Hermes; uma sala precisa de 2.",
      roomTooFewReadyHelp: "No Hermes, abra Canais no perfil de outro Bot, ative o API server com uma chave e reinicie o gateway desse perfil.",
      roomBotNotReady: "Sem conex\xE3o com o Hermes: habilite o API Server deste perfil.",
      roomNeedName: "D\xEA um nome \xE0 sala.",
      roomNeedTwoBots: "Escolha pelo menos 2 Bots ({count} de 2).",
      roomCreateTimeout: "O Hermes n\xE3o respondeu em 20 s. A sala pode ter sido criada: confira a lista de salas antes de tentar de novo.",
      roomsUnavailableTitle: "As salas n\xE3o est\xE3o dispon\xEDveis agora.",
      roomsCheckAgain: "Verificar de novo",
      roomsChecking: "Verificando se as salas est\xE3o dispon\xEDveis neste Hermes\u2026",
      roomDisbandBtn: "Desmantelar Sala",
      modalDisbandRoomTitle: "Desmantelar Sala Permanentemente",
      modalDisbandRoomBody: "Esta a\xE7\xE3o encerra a sala em definitivo. Digite o nome da sala '{name}' para confirmar:",
      disbandRoomInputPlaceholder: "Nome da sala",
      btnConfirmDisband: "Desmantelar sala",
      roomStopBtn: "Parar",
      roomStoppingBtn: "Parando...",
      modalStopRoomTitle: "Parar Execu\xE7\xE3o da Sala",
      modalStopRoomBody: "Deseja parar todas as tarefas e discuss\xF5es em andamento desta sala?",
      btnConfirmStopRoom: "Confirmar Parada",
      roomRetryBtn: "Tentar novamente",
      modalRetryRoomTitle: "Repetir Tarefa da Sala",
      modalRetryRoomBody: "Deseja reexecutar esta tarefa indeterminada na sala?",
      btnConfirmRetryRoom: "Repetir Tarefa",
      modalCostConfirmTitle: "Aviso de Custo: @todos",
      modalCostConfirmBody: "Mencionar @todos ou m\xFAltiplos Bots acionar\xE1 rodadas coordenadas entre todos os membros (at\xE9 3 rodadas, at\xE9 10 mensagens). Deseja continuar?",
      btnConfirmCostSend: "Confirmar e Enviar",
      roomNotAMemberError: "O Bot '@{handle}' n\xE3o \xE9 membro desta sala e n\xE3o pode ser acionado.",
      roomOpenTasksTitle: "Tarefas Abertas ({count})",
      roomNoOpenTasks: "Nenhuma tarefa aberta no momento.",
      roomHandoffCardTitle: "Handoff",
      roomHandoffFromTo: "De @{from} para @{to}",
      roomHandoffTaskLink: "Ver tarefa no Kanban",
      btnPromoteHandoff: "Promover",
      btnCancelHandoff: "Cancelar",
      roomInputPlaceholder: "Digite uma mensagem... Use @ para mencionar membros da sala ou @todos",
      roomMembersCount: "{count} membros",
      roomDriverRunning: "Em execu\xE7\xE3o",
      roomDriverIdle: "Ocioso",
      roomSelectOptionNone: "Nenhum",
      roomGoalBadge: "Objetivo",
      roomOwnerBadge: "Dono: @{handle}",
      roomCoordinatorBadge: "Coord: @{handle}",
      roomMentionTodosLabel: "todos \u2014 Acionar todos os membros",
      errorLoadingRooms: "Erro ao carregar salas.",
      errorLoadingRoom: "Erro ao carregar sala.",
      errorLoadingRoomLog: "Erro ao carregar hist\xF3rico da sala.",
      errorCreatingRoom: "Erro ao criar sala.",
      errorPatchingRoom: "Erro ao editar sala.",
      errorSendingRoomMessage: "Erro ao enviar mensagem.",
      errorStoppingRoom: "Erro ao parar sala.",
      errorRetryingRoomTask: "Erro ao repetir tarefa.",
      errorDisbandingRoom: "Erro ao desmantelar sala.",
      errorDisbandingNameMismatch: "O nome digitado n\xE3o confere com o nome da sala.",
      errorLoadingHandoffs: "Erro ao carregar handoffs.",
      errorPromotingHandoff: "Erro ao promover handoff.",
      roomMessageAccepted: "Mensagem enviada \xE0 sala.",
      roomDisbandedSuccess: "Sala desmantelada com sucesso.",
      roomCreatedSuccess: "Sala criada com sucesso.",
      roomStoppedSuccess: "Execu\xE7\xE3o da sala interrompida.",
      noRoomSelected: "Nenhuma sala selecionada. Selecione uma sala na barra lateral ou crie uma nova sala.",
      roomMembersMinMaxError: "Uma sala deve ter entre 2 e 6 Bots membros.",
      roomNameRequiredError: "O nome da sala \xE9 obrigat\xF3rio.",
      roomMentionsListAriaLabel: "Sugest\xF5es de men\xE7\xF5es",
      // Team Map (T5.2, spec §4.12, contract v0.3 §5)
      mapTitle: "Mapa do Time",
      mapSubtitle: "Vis\xE3o do time de Bots, salas ativas e handoffs",
      mapWindow7d: "\xDAltimos 7 dias",
      mapWindow30d: "\xDAltimos 30 dias",
      mapViewVisual: "Grafo",
      mapViewAccessible: "Lista Acess\xEDvel",
      mapViewVisualDesc: "Visualiza\xE7\xE3o visual do grafo",
      mapViewAccessibleDesc: "Visualiza\xE7\xE3o em lista acess\xEDvel para teclado e leitor de tela",
      mapLiveHandoffBadge: "Handoff ao vivo",
      mapHandoffsCount: "{count} handoffs",
      mapHandoffsCountSingle: "1 handoff",
      mapHandoffDrawerTitle: "Handoffs entre Bots",
      mapHandoffBetween: "{from} \u2192 {to}",
      mapLastActivity: "\xDAltima atividade: {date}",
      mapCurrentTask: "Tarefa atual: {task}",
      mapNoTask: "Nenhuma tarefa em execu\xE7\xE3o",
      mapCostWeek: "Gasto da semana: {cost}",
      mapRoomsCount: "{count} salas",
      mapRoomsCountSingle: "1 sala",
      mapNoNodes: "Nenhum Bot encontrado no mapa",
      mapNoEdges: "Nenhum handoff registrado no per\xEDodo selecionado.",
      mapLoading: "Carregando mapa do time...",
      mapError: "Erro ao carregar mapa do time.",
      mapEdgesSection: "Conex\xF5es e Handoffs",
      mapNodesSection: "Membros do Time",
      mapEdgeLiveIndicator: "Ao vivo",
      mapViewKanbanTask: "Ver tarefa no Kanban",
      // Command Palette & Search (T5.2, spec §4.14, contract v0.3 §6)
      searchPaletteTitle: "Busca e A\xE7\xF5es R\xE1pidas",
      searchCategoryAll: "Tudo",
      searchCategoryMessages: "Mensagens",
      searchCategoryBots: "Bots",
      searchCategoryRooms: "Salas",
      searchCategoryRoutines: "Rotinas",
      searchCategoryFiles: "Arquivos",
      searchCategoryActions: "A\xE7\xF5es",
      searchPlaceholderInput: "Digite para buscar mensagens, bots, salas, rotinas ou a\xE7\xF5es...",
      searchQuickActionsHeader: "A\xE7\xF5es R\xE1pidas",
      searchResultsHeader: "Resultados",
      searchNoResults: 'Nenhum resultado encontrado para "{query}"',
      searchLoading: "Buscando...",
      searchNavigateAction: "Navegar",
      searchOpenModalAction: "Abrir",
      searchShortcutKey: "Atalho",
      searchConfirmModalTitle: "Confirma\xE7\xE3o de A\xE7\xE3o",
      searchConfirmPauseAllTitle: "Confirmar Pausa Geral",
      searchConfirmPauseAllBody: "Deseja pausar todos os Bots e rotinas? Nenhuma rotina, tarefa nova ou mensagem do gateway come\xE7ar\xE1 at\xE9 voc\xEA retomar. O que est\xE1 em andamento termina.",
      searchConfirmBtn: "Confirmar",
      searchConfirmPauseAllBtn: "Pausar tudo agora",
      searchActionNewBot: "Criar Novo Bot",
      searchActionNewBotDesc: "Abre assistente para criar um novo Bot no Hermes",
      searchActionNewRoom: "Criar Nova Sala",
      searchActionNewRoomDesc: "Cria uma nova sala de colabora\xE7\xE3o entre m\xFAltiplos Bots",
      searchActionApprovals: "Ir para Caixa de Aprova\xE7\xF5es",
      searchActionApprovalsDesc: "Revisa solicita\xE7\xF5es pendentes de ferramentas e runs",
      searchActionActivity: "Ver Atividade",
      searchActionActivityDesc: "Exibe tarefas em andamento, agendadas e conclu\xEDdas",
      searchActionCosts: "Ver Custos e Or\xE7amento",
      searchActionCostsDesc: "Gerencia limites e consumo financeiro dos Bots",
      searchActionRoutines: "Ver Rotinas",
      searchActionRoutinesDesc: "Lista e gerencia cron jobs e tarefas recorrentes",
      searchActionMap: "Ver Mapa do Time",
      searchActionMapDesc: "Visualiza topologia de Bots e fluxo de handoffs",
      searchActionPauseAll: "Pausar tudo",
      searchActionPauseAllDesc: "Pausa preventiva de todos os runs e rotinas (exige confirma\xE7\xE3o)",
      searchPartialResultsNotice: "Alguns servi\xE7os n\xE3o responderam a tempo: {sources}",
      searchFilesNotice: "A busca em arquivos filtra pelo nome dos arquivos no reposit\xF3rio.",
      searchHitFromBot: "Por {bot}",
      searchHitInSession: "Sess\xE3o: {session}",
      searchHitInRoom: "Na sala {room}",
      searchResultCount: "{count} resultados encontrados",
      clearSearch: "Limpar busca",
      mapHandoffTotal: "Total",
      mapHandoffStatus: "Status",
      mapRecentTasks: "Tarefas recentes ({count})",
      mapHandoffItemLabel: "Handoff: {id}",
      // PWA & Mobile (spec §4.16, contract v0.3 §7)
      pwaOfflineNoticeHeader: "Modo offline n\xE3o suportado",
      pwaOfflineNoticeBody: "O LuveBot \xE9 instal\xE1vel como PWA e responsivo, mas n\xE3o funciona offline: requer conex\xE3o ativa com o Hermes para gerenciar agentes e regras.",
      pwaInstallableBadge: "PWA Instal\xE1vel",
      pwaScopeNotice: "Escopo restrito ao plugin (/dashboard-plugins/luvebot/). Nenhuma rota de API \xE9 guardada em cache.",
      // Empty States & Next Steps (spec §4.2, T6.4)
      needsYouEmptyNextStep: "Aprova\xE7\xF5es e perguntas que precisarem de voc\xEA aparecer\xE3o aqui para decis\xE3o r\xE1pida.",
      inProgressEmptyNextStep: "Inicie uma conversa com um Bot para delegar novas tarefas ou acione uma rotina.",
      completedTodayEmptyNextStep: "Os resultados, relat\xF3rios e artefatos conclu\xEDdos aparecer\xE3o aqui ao longo do dia.",
      createFirstRoutine: "Criar rotina",
      conversationEmptyTitle: "Oi! Eu sou {name}.",
      conversationEmptyDesc: "Me diga o que voc\xEA precisa. Se quiser, comece por uma destas:",
      conversationPromptSuggestion1: "Como voc\xEA pode me ajudar hoje?",
      conversationPromptSuggestion2: "Liste as habilidades e ferramentas dispon\xEDveis.",
      approvalsEmptyNextStep: "Seus Bots solicitar\xE3o autoriza\xE7\xE3o aqui antes de executar a\xE7\xF5es de risco ou ferramentas protegidas.",
      costsEmptyNextStep: "Os custos de execu\xE7\xE3o e consumo de tokens aparecer\xE3o aqui conforme os Bots forem utilizados.",
      roomsEmptyNextStep: "Crie uma sala para reunir m\xFAltiplos Bots e humanos colaborando em um objetivo comum.",
      roomEmptyKickoffTitle: "Objetivo da sala e kickoff",
      roomEmptyKickoffDesc: "Mencione um Bot com @handle para iniciar a colabora\xE7\xE3o. Ex: @Pesquisa busque fontes, @Reda\xE7\xE3o fa\xE7a o rascunho.",
      mapEmptyNextStep: "Crie Bots e configure salas para visualizar a estrutura do time e os handoffs entre agentes.",
      searchEmptyPrompt: "Digite para buscar mensagens, Bots, salas, rotinas e arquivos.",
      searchEmptyNextStep: "Use as setas para navegar ou selecione uma a\xE7\xE3o r\xE1pida.",
      viewConversationBtn: "Ver conversa",
      reviewHandoffBtn: "Revisar",
      todaySpendVsBudget: "{spend} hoje / {budget}",
      todaySpendOnly: "{spend} hoje",
      checkpointDoneParam: "{done} de {total}"
    },
    en: {
      // Topbar & Global
      searchPlaceholder: "Search messages, bots, routines... (\u2318K)",
      activeBotsCount: "0 active Bots",
      pauseAll: "Pause all",
      resumeAll: "Resume",
      langPortuguese: "Portugu\xEAs",
      langEnglish: "English",
      toggleLanguage: "Toggle language (PT/EN)",
      toggleMenu: "Toggle menu",
      btnProfile: "Profile",
      pageArea: "Page area: {tab}",
      // Sidebar
      navSectionMain: "Main Navigation",
      navHoje: "Today",
      navAprovacoes: "Approvals",
      navAtividade: "Activity",
      navRotinas: "Routines",
      navMapa: "Team Map",
      navCustos: "Costs",
      navConfig: "Settings",
      navSearch: "Search",
      backToList: "Back to conversations",
      hermesPanel: "Hermes dashboard",
      themeLabel: "LuveBot theme",
      themeAuto: "Automatic",
      themeAutoHint: "Follows the system's light or dark.",
      themeLight: "Light",
      themeDark: "Dark",
      backToLuveBot: "Back to LuveBot",
      activityRunTitle: "Conversation",
      activityRoutineRunTitle: "Routine",
      activityRoutineDueTitle: "Scheduled routine",
      activityTaskTitle: "Task",
      sectionBots: "Bots",
      newBot: "New Bot",
      emptyBots: "No Bots yet",
      sectionSalas: "Rooms",
      newSala: "New Room",
      emptySalas: "No rooms",
      sectionOcultos: "Hidden",
      // Home "Hoje"
      hojeTitle: "Today",
      needsYouTitle: "Needs you",
      inProgressTitle: "In progress",
      completedTodayTitle: "Completed today",
      // Empty States
      needsYouEmpty: "All clear. No pending approvals, questions, or handoffs at the moment.",
      inProgressEmpty: "No tasks in progress. Start a conversation with a Bot or wait for the next scheduled routine.",
      completedTodayEmpty: "No tasks completed today yet. Delivered results and artifacts will appear here.",
      // Onboarding 3 templates
      onboardingTitle: "No Bots created yet",
      onboardingSubtitle: "Create your first digital teammate from a battle-tested template:",
      templateGabineteTitle: "Chief of Staff",
      templateGabineteDesc: "Coordinates tasks, delegates work, and monitors the agent team.",
      templateVendasTitle: "B2B Sales",
      templateVendasDesc: "Researches prospects, reads CRM data, and drafts emails for review.",
      templateDevTitle: "Dev Engineer",
      templateDevDesc: "Diagnoses issues, executes test suites in sandbox, and writes pull requests.",
      createTemplateBtn: "Create this Bot",
      // Routines footer
      nextRoutinesTitle: "Upcoming routines",
      noRoutinesScheduled: "No routines scheduled for today.",
      zeroScheduled: "0 scheduled",
      scheduledCount: "{count} scheduled",
      activeBotsCountParam: "{count} active Bots",
      activeBotCountParamSingle: "{count} active Bot",
      // Bot Sidebar List & Badges
      statusUnreadLabel: "Unread",
      statusUnreadTitle: "Unread result",
      statusNeedsYouLabel: "Needs you",
      statusNeedsYouTitle: "Needs you (pending approval or question)",
      statusWorkingLabel: "Working",
      statusWorkingTitle: "Bot working",
      statusTyping: "typing...",
      statusPausedLabel: "Paused",
      statusPausedTitle: "Bot paused (ESTOP or budget limit)",
      statusErrorLabel: "Error",
      statusErrorTitle: "Recent execution error",
      statusOfflineLabel: "Disconnected",
      statusOfflineTitle: "Gateway disconnected for this profile",
      statusIdleLabel: "Idle",
      statusIdleTitle: "Available",
      offlineHeader: "No connection to Hermes",
      offlineSub: "Waiting for API Server signal...",
      reconnectNow: "Reconnect now",
      errorLoadingBots: "Error loading bots",
      retry: "Try again",
      loadingBots: "Loading bots",
      createFirstBot: "Create first Bot",
      // BotCreateModal (Wizard)
      createBotModalTitle: "Create New Bot",
      stepOf: "Step {step} of 4",
      close: "Close",
      wizardStep1Title: "1. Choose a template or start from scratch",
      wizardStep1Subtitle: "Each template is configured with specialized instructions and appropriate tools.",
      useThisTemplate: "Use this template",
      createFromScratch: "Create from Scratch",
      createFromScratchDesc: "Configure a fully custom Bot with no prior instructions.",
      customBadge: "Custom",
      wizardStep2Title: "2. Bot Identity",
      wizardStep2Subtitle: "Set the Hermes profile name and the agent's visual presentation.",
      profileIdentifierLabel: "Profile Identifier (Hermes) *",
      profileIdentifierPlaceholder: "e.g.: sales",
      visibleNameLabel: "Display Name (Label)",
      visibleNamePlaceholder: "e.g.: B2B Sales",
      primaryRoleLabel: "Primary role",
      primaryRolePlaceholder: "e.g.: B2B Prospecting",
      callMeLabel: "What it should call you",
      callMePlaceholder: "e.g.: Alex",
      avatarLabel: "Avatar (Emoji)",
      botColorLabel: "Bot Color (8 Archetypes)",
      nameRequired: "Profile identifier is required.",
      nameFormatError: "Must start with letter/number and contain up to 64 chars (letters, numbers, hyphens or underscores only).",
      nameInvalid: "Invalid profile name.",
      wizardStep3Title: "3. Operational Guidelines and Policies",
      wizardStep3Subtitle: "Guidelines for Bot operation and boundaries.",
      operationalDescriptionLabel: "Description in operational terms",
      operationalDescriptionDefault: "Specialized agent configured according to the selected template.",
      technicalRulesNoticeTitle: "Technical policies and rules:",
      technicalRulesNotice: "The technical rules engine with native blocks and human approvals is integrated in Phase 3. Meanwhile, conduct guidelines follow the profile and selected template.",
      permanentSoulLabel: "Permanent template instructions (SOUL.md)",
      wizardStep4Title: "4. Artificial Intelligence Model",
      wizardStep4Subtitle: "Select the recommended provider and model for the Bot specialty.",
      providerLabel: "Provider",
      providerOpenRouter: "OpenRouter (Recommended)",
      providerAnthropic: "Anthropic Claude",
      providerOpenAI: "OpenAI",
      providerNous: "Nous Research",
      providerLocal: "Local Model (Ollama / vLLM)",
      modelLabel: "Model",
      modelPlaceholder: "claude-sonnet-5-5",
      connectMinimumNotice: "Connect minimum necessary: external channel integrations (Telegram, Slack, WhatsApp) can be activated later in the Profile Channels tab.",
      botCreatedSuccess: "Bot created successfully!",
      introTitle: "The Bot introduces itself",
      introLoading: "Checking the Bot's introduction\u2026",
      introOffer: "The Bot can introduce itself now: it is a real model run, costing about {cost}.",
      introOfferNoEstimate: "The Bot can introduce itself now: it is a real model run, with a cost.",
      introStart: "Ask the Bot to introduce itself",
      introStarting: "Asking\u2026",
      introRunning: "The Bot is introducing itself\u2026",
      introSlow: "The introduction is taking long; it shows in the conversation with the Bot as soon as it ends.",
      introEmpty: "The Bot finished without saying anything.",
      introFailed: "The introduction did not finish. You can talk to the Bot anyway.",
      introUnavailable: "The introduction is not available right now.",
      introNoTemplate: "This Bot was not made from a template, so there is no introduction for it.",
      introHookNotLive: "The introduction starts once LuveBot's hook is live on this Bot (the gateway must be running).",
      introBotOffline: "This Bot has no connection to Hermes; the introduction starts once it is up.",
      introBotPaused: "This Bot is paused; resume it so it can introduce itself.",
      introBudgetExceeded: "This Bot's spending cap was reached; adjust it in Costs so it can introduce itself.",
      botReadyToOperate: "is ready to operate",
      back: "Back",
      next: "Next",
      createBotBtn: "Create Bot",
      creatingBotBtn: "Creating Bot...",
      startWithThisBot: "Start with this Bot",
      // BotProfile
      botProfileTabs: "Profile tabs",
      profileLoading: "Loading Bot profile...",
      tabIdentity: "1. Identity",
      tabInstructions: "2. Instructions (SOUL.md)",
      tabModel: "3. Model",
      tabRules: "4. Rules",
      closeProfile: "Close profile",
      defaultRoleAgent: "LuveBot Agent",
      identitySaveSuccess: "Identity updated successfully!",
      errorSaving: "Error saving changes",
      hermesIdentifierLabel: "Hermes Identifier (Profile)",
      callMeLabelProfile: "What it should call you (Call me)",
      avatarEmojiInitialsLabel: "Avatar (Emoji or Initials)",
      saveChanges: "Save changes",
      saving: "Saving...",
      soulNotice: "Read-only view. SOUL.md editing via LuveBot will be available in a future phase with full auditing.",
      readOnlyBadge: "Read-Only",
      soulTipTitle: "SOUL.md Editor:",
      soulTipText: "Permanent rules here; tasks in the conversation.",
      soulTipSub: "SOUL defines the Bot's personality, ethical permissions, and perpetual system instructions.",
      soulContentTitle: "SOUL.md file content",
      charactersCount: "characters",
      soulPlaceholder: "# SOUL.md\nDefine Bot purpose and guidelines here...",
      modelNotice: "Current model configuration. Changing provider and model via LuveBot will be available in a future phase with full auditing.",
      providerAILabel: "AI Provider",
      mainModelLabel: "Main Model",
      thinkingModeLabel: "Thinking Mode (Reasoning)",
      thinkingModeDesc: "Allows the model to detail its reasoning before executing tools.",
      fallbackModelLabel: "Fallback Model (Contingency)",
      // Conversation
      conversationWith: "Conversation with",
      thought: "Thought",
      // Transcript cards & honest fallbacks (T7.1 F0)
      cardSubagent: "Subagent",
      subagentTimeout: "Timed out",
      subagentUnknown: "Ended without reporting a result",
      subagentBackground: "Running in the background",
      subagentBackgroundLate: "The subagent is in the background; its result has not reached this conversation yet",
      approvalStatePending: "pending",
      approvalStateDecided: "decided",
      approvalStateConsumed: "carried out",
      approvalStateExpired: "expired",
      approvalStateStale: "out of date",
      approvalDecidedOnce: "Allowed once",
      approvalDecidedDeny: "Denied",
      approvalChoiceOnce: "Allow once",
      approvalChoiceSession: "Allow for this session",
      approvalChoiceAlways: "Always allow",
      approvalChoiceDeny: "Deny",
      routineRunRunning: "running",
      handoffStateTriage: "in triage",
      handoffStateReady: "ready",
      handoffStateRunning: "running",
      handoffStateBlocked: "blocked",
      handoffStateReview: "in review",
      handoffStateDone: "done",
      handoffStateCancelled: "cancelled",
      hojeRoutinesNext: 'Ask a Bot "every morning at 8\u2026" or create a routine.',
      settingsTabGeneral: "General",
      settingsTabCosts: "Costs",
      settingsTabRules: "Rules",
      settingsLanguage: "Language",
      settingsThemeNote: "Light or dark follows the Hermes dashboard theme (and the system's).",
      soundsTitle: "LuveBot sounds",
      soundsAll: "New messages and what needs you",
      soundsNeedsYou: "Only what needs you",
      soundsOff: "Off",
      soundsNote: "They play only when you are not looking at that Bot (tab in the background or another screen open), never for what you did yourself, at most one every 2 s. Kept in this browser.",
      settingsAppTitle: "App",
      shortcutsTitle: "Keyboard shortcuts",
      shortcutSearch: "Search",
      shortcutNewBot: "New Bot",
      shortcutNewRoom: "New room",
      shortcutSidebar: "Show or hide the conversation list",
      shortcutBotN: "Open Bot 1 to 9 of the list",
      shortcutBotStep: "Previous or next Bot",
      shortcutComposer: "Go to the message field",
      shortcutApprovals: "G then A: Approvals",
      shortcutClose: "Close the panel or the dialog",
      shortcutsNote: "\u2318 on Mac, Ctrl on other systems. In a browser tab, \u2318N and \u23181\u20269 stay with the browser; in LuveBot installed as an app they work. Letter shortcuts do not apply while you type.",
      hojeConfirmTest: "Confirm test",
      hojeTestRealWork: "A test run does real work.",
      roomMembersBtn: "Members",
      roomTeamMapBtn: "Team map",
      roomKickoffTemplate: "@{a} gather the sources. @{b} turn them into a draft. Do not publish anything.",
      agentPanelLabel: "{name}'s profile",
      agentCallsYou: "Calls you {name}",
      agentModel: "Model: {model}",
      agentActivityTabs: "Bot activity",
      agentPausedUser: "Paused by you",
      agentPausedBudget: "Paused by the spending cap",
      agentPausedEstop: "Paused in Hermes (not by LuveBot)",
      agentPausedAll: "Everything is paused",
      agentLoading: "Loading\u2026",
      agentEmptyRunning: "I'm free right now.",
      agentEmptyScheduled: "I have no routines yet.",
      agentEmptyDone: "I haven't finished anything here yet.",
      agentConfirmStop: "Confirm stop",
      agentBudgetTitle: "Budget",
      agentBudgetNone: "You haven't set a cap for me yet.",
      agentBudgetLine: "{period} cap: {spent} of {cap}",
      agentPeriodDay: "Daily",
      agentPeriodMonth: "Monthly",
      agentManageCosts: "Manage caps",
      agentCustomize: "Customize",
      surfaceTitle: "Where to approve",
      surfaceIntro: "When a rule asks for confirmation, choose here where you answer.",
      surfaceLuvebot: "Only in LuveBot (default)",
      surfaceLuvebotDesc: "Requests show up here in LuveBot. In channels the action stays blocked until someone approves here.",
      surfaceChannel: "Where the conversation happens",
      surfaceChannelDesc: "In {platforms}, in a private chat, by the people you name below. Other platforms keep blocking.",
      surfaceApproversLabel: "Who can approve on Telegram (numeric ID)",
      surfaceIdsPlaceholder: "e.g. 123456789, 987654321",
      surfaceApproversHelp: "Your Telegram user ID (of the account that talks to the Bot, not the Bot's ID). Ask",
      surfaceUserInfoBot: "@userinfobot",
      surfaceApproversHelpAfter: "from that same account.",
      surfaceIdsEmpty: "Name at least one person.",
      surfaceIdsFormat: "Use numbers only, separated by commas.",
      surfaceIdsMany: "At most 20 people.",
      surfaceIdsRepeat: "An ID is repeated.",
      surfaceAllowAll: "Warning: {reason} While it stays so, approving in the channel does not count.",
      surfacePending: "Applying: the hook confirms in a few seconds.",
      surfacePendingSlow: "Still applying. If it does not confirm, check that this Bot's gateway is running; until then, approve in LuveBot.",
      surfaceHookOutdated: "Not applied yet: this Bot's hook needs an update (now: {version}; needs {needed}+). Until then, approve in LuveBot.",
      surfaceHookNotLive: "Not applied yet: this Bot's hook is not live right now (the gateway must be running with the hook installed). Until then, approve in LuveBot.",
      hookUpdateBtn: "Update this Bot's hook",
      hookUpdating: "Updating the hook\u2026",
      hookUpdated: "Hook updated.",
      hookAlreadyCurrent: "This Bot's hook was already current.",
      hookUpdateRestart: "Hook updated on disk, but this Bot's gateway must be restarted to use the new version. Until then, approve in LuveBot.",
      hookUpdateFailed: "Could not update this Bot's hook right now. Nothing changed; try again.",
      surfaceNotAppliedUnknown: "Not applied yet by this Bot. Until then, approve in LuveBot.",
      surfaceNoHook: "none",
      surfaceSaved: "Saved.",
      surfaceSealsLabel: "Seal of the rules that ask for confirmation, now",
      surfaceErrUnsafe: "Approving in the channel is not possible: {reason}",
      surfaceErrLoopback: "This dashboard is in loopback mode, without a login. Turning on channel approval or naming someone needs a person signed in to the dashboard.",
      surfaceErrInvalid: "Check the IDs: numbers only, 1 to 20 people, no repeats.",
      surfaceErrCsrf: "The session expired. Reload the page and try again.",
      surfaceErrNetwork: "Could not reach LuveBot right now.",
      surfaceErrGeneric: "Could not save right now. Try again.",
      errTechnical: "Technical detail",
      errHermesUnreachable: "LuveBot could not reach Hermes right now. Check that the gateway is running and try again.",
      errHermesError: "Hermes answered with an error. Try again; if it persists, check the Hermes logs.",
      errHermesTimeout: "Hermes took too long to answer. Try again in a moment.",
      errHermesUnverified: "Could not confirm the Hermes version right now. Try again in a moment.",
      errCsrf: "This page is out of date. Reload the page and try again.",
      errUnauthenticated: "Your Hermes dashboard session ended. Sign in again and retry.",
      errRateLimited: "Too many tries in a row. Wait a little and try again.",
      errInvalid: "Something was not accepted. Check what was filled in and try again.",
      errCapabilityMissing: "This Hermes version does not offer this. Update Hermes to use it.",
      errNotImplemented: "This does not exist yet in this LuveBot version.",
      errBotNotFound: "This Bot was not found. It may have been deleted in Hermes.",
      errBotPaused: "This Bot is paused. Resume it and try again.",
      errBotOffline: "This Bot has no connection to Hermes right now.",
      errBudgetExceeded: "The spending cap was reached. Adjust it in Costs to continue.",
      errTooLarge: "This is too large to send.",
      errConflict: "Something changed while you were here. Reload and try again.",
      errLoopback: "In this mode (loopback, no sign-in) LuveBot does not allow this. Sign in to the Hermes dashboard with a password.",
      errAuditUnavailable: "LuveBot's audit log is not available right now, so nothing was done. Try again.",
      errSdkUnavailable: "The Hermes dashboard did not fully load. Reload the page.",
      errRouteMissing: "This feature is not active yet: the Hermes dashboard must be restarted to load the new LuveBot version.",
      restartNotice: "LuveBot was updated; restart the Hermes dashboard to use the new version.",
      errBotExists: "A Bot with that name already exists. Pick another.",
      errDuplicate: "This already exists. Check the list before creating it again.",
      errRunNotFound: "This run was not found in Hermes; it may have already ended.",
      errSessionNotFound: "This conversation was not found in Hermes.",
      surfaceReasonGatewayAll: "the gateway lets every user in (GATEWAY_ALLOW_ALL_USERS).",
      surfaceReasonTelegramAll: "Telegram lets every user in (TELEGRAM_ALLOW_ALL_USERS).",
      surfaceReasonTelegramStar: "the Telegram user list has the * wildcard (TELEGRAM_ALLOWED_USERS).",
      surfaceReasonGatewayStar: "the gateway user list has the * wildcard (GATEWAY_ALLOWED_USERS).",
      surfaceReasonConfigAll: "config.yaml lets every user in (allow_all_users).",
      surfaceReasonConfigStar: "config.yaml has the * wildcard in allow_from.",
      surfaceReasonUnreadable: "it was not possible to read who the gateway lets in.",
      agentIdentity: "Identity and instructions",
      agentRules: "This Bot's rules",
      agentRoutines: "This Bot's routines",
      agentPause: "Pause Bot",
      agentResume: "Resume Bot",
      agentPauseExplain: "This Bot's routines and new work stay stopped until you resume. What was already done is not undone.",
      agentPauseStopActive: "Also stop work in progress",
      agentPauseConfirm: "Confirm pause",
      agentPauseDefaultScope: "For the default Bot, the pause covers LuveBot and routines; channels such as Telegram keep running (use Pause all for them).",
      agentErrPausedAll: "Everything is paused. Resume everything before resuming this Bot.",
      agentErrBudgetHeld: "The spending cap holds this Bot. Resume it from the budget.",
      agentErrNotOurs: "This pause was set in Hermes or by someone else; LuveBot does not change it.",
      agentErrLoopback: "In loopback mode, resuming needs a human dashboard session.",
      backToConversation: "Back to the conversation",
      composerPlaceholder: "Message {name}",
      approvalNotResolvableHere: "LuveBot could not record this request, so it cannot be decided here. Nothing was approved.",
      approvalNoLongerPending: "This request is no longer pending.",
      textTruncated: "\u2026 (text truncated)",
      cardSubagentCost: "US$ {cost}",
      cardViewSession: "view session",
      cardCommentary: "commentary",
      cardApproval: "Approval request",
      cardCopyId: "copy ID",
      cardChoiceSession: "This session",
      checkpointProgress: "{done} of {total}",
      checkpointProgressReview: "{done} of {total} \xB7 {review} to review",
      needsYouKindApproval: "Approval",
      needsYouKindHandoff: "Handoff",
      unknownHandle: "unknown",
      pausedReasonCapReached: "cap reached",
      statusCompleted: "Completed",
      statusInterrupted: "Interrupted",
      statusFailed: "Failed",
      statusStopping: "Stopping\u2026",
      statusWaitingApproval: "Waiting for approval",
      statusWorking: "Working\u2026",
      workPanelBtn: "Work panel",
      workPanelShort: "Panel",
      stepsOne: "1 step",
      stepsMany: "{count} steps",
      stepsRunning: "running",
      stepsDone: "done",
      stepsError: "with an error",
      stepsSeeInActivity: "See in Activity",
      activityTurnIntro: "The Bot's introduction",
      activityTurnLabel: "Request: {text}",
      workPanelShow: "Show work panel",
      workPanelHide: "Hide work panel",
      workPanelNew: "new activity",
      mascotPickerLabel: "Bot face (mascot)",
      pagesTitle: "Pages",
      pageNewBtn: "New page",
      pageNewTitle: "New page",
      pageSaveAsTitle: "Save as page",
      pageTitleLabel: "Title",
      pageCreate: "Create",
      pageSaveIn: "Goes to {name}'s Pages.",
      pageExists: "A page with that name already exists ({slug}). Pick another title.",
      pageTitleInvalid: "Use letters or numbers in the title.",
      pageTooLarge: "The page is over 1 MB; nothing was saved.",
      pagesReadOnly: "You can read the pages, but this Hermes version does not let LuveBot save. Update Hermes to edit.",
      pagesStateUnsupported: "Pages does not exist in this LuveBot install yet. Update LuveBot to use it.",
      pagesStateUnavailable: "This Hermes version lacks what LuveBot needs for Pages. Update Hermes.",
      pagesStateNoWorkspace: "Set {name}'s working folder to use Pages: in Hermes, open {path} and set terminal.cwd to the absolute path of a folder that already exists, outside ~/.hermes. The LuveBot Bot profile has no such field.",
      pagesProfileConfigFile: "this Bot's profile config.yaml",
      pagesStateNotLocal: "Pages does not work yet with this Bot's remote or container terminal.",
      pagesStateInsideHermes: "The Bot's working folder is inside Hermes; pick another one.",
      pagesStateUnsafe: "This Bot's pages/ folder is a shortcut; LuveBot does not open it.",
      pagesStateError: "Could not open the pages right now. Try again in a moment.",
      pagesEmpty: "No pages yet. Ask the Bot for a document or create the first one.",
      pagesNoMatch: "No page with that text.",
      pagesSearchLabel: "Search {name}'s pages",
      pagesViewLabel: "View as",
      pagesViewGrid: "Grid",
      pagesViewList: "List",
      pagesSeeAll: "See all ({count})",
      pagesOpenLibrary: "Open Pages",
      pageChangedMark: "Changed since you last read it",
      pageLoading: "Opening\u2026",
      pageNotFound: "This page no longer exists.",
      pageOfBot: "{name}'s page",
      pageEdit: "Edit",
      pageHistory: "History",
      pageAskBot: "Ask {name} about this page",
      pageMeta: "Updated by {who} on {when}",
      pageRevision: "revision {rev}",
      pageRegionLabel: "Page {title}",
      pageUpdatedWhileReading: "{name} updated this page while you were reading.",
      pageChangedSinceRead: "This page changed since you last read it.",
      pageSeeChanges: "See changes",
      pageChangesTitle: "What changed",
      pageVersionYouHad: "The version you had",
      pageVersionNow: "The version now",
      pageOldVersionGone: "The version you read is no longer in the history (it keeps the last 50).",
      pageRedactedBody: "This page has something that looks like a secret. Editing here is off; ask the Bot to remove it.",
      pageHistoryEmpty: "No revisions saved by LuveBot yet.",
      pageHistoryLimit: "The history keeps the last 50 revisions.",
      pageCurrentVersion: "current",
      pageRestore: "Restore this version",
      pageRestoreTitle: "Restore revision {rev}?",
      pageRestoreBody: "The page goes back to this text as a new revision. Nothing in the history is deleted.",
      pageRestoreConflict: "The page changed while you were looking at the history. Open it again and retry.",
      pageSaving: "Saving\u2026",
      pageUnsaved: "Not saved yet",
      pageSaveFailed: "Not saved. Your text is still here.",
      pageSavedAt: "Saved at {time}",
      pageNoChanges: "No changes",
      pageDone: "Done",
      pageConflictShort: "Not saved: conflict",
      pageRedactedShort: "Editing off: something looks like a secret",
      pageConflictBody: "{who} changed this page. Reload to see the other version; your text is kept here.",
      pageCompare: "Compare",
      pageCompareTitle: "Compare the versions",
      pageUseTheirs: "Use the other version",
      pageUseTheirsTitle: "Use {who}'s version?",
      pageUseTheirsBody: "Your unsaved text will be discarded. Copy it first if you want to keep it.",
      pageWriteOver: "Write mine over it",
      pageCopyDraft: "Copy my text",
      pageDraftCopied: "Copied",
      pageYourDraft: "Your text",
      pageLeaveTitle: "Leave without saving?",
      pageLeaveBody: "Some changes are not saved yet. If you leave now, they are lost.",
      pageKeepEditing: "Keep editing",
      pageLeaveDiscard: "Leave without saving",
      pageSourceLabel: "Page text in Markdown",
      pagePreviewLabel: "Page preview",
      pageEditorViews: "Show the text or the preview",
      pageSourceTab: "Edit",
      pagePreviewTab: "Preview",
      pageExpand: "Expand",
      pageCollapse: "Collapse",
      pageDiffTooBig: "The versions are too big to compare here.",
      pageDiffLegend: "Lines with \u2212 are in {before}; with +, in {after}.",
      pageDiffSame: "Both versions are the same.",
      pageDiffLabel: "Line by line differences",
      pageDiffAdded: "Line added: ",
      pageDiffRemoved: "Line removed: ",
      pageCardMeta: "Page \xB7 updated by {name}",
      pageOpen: "Open",
      pageOpenNamed: "Open the page {title}",
      pageSaveAsMenu: "Save as the Bot's page",
      pageSaveAsHint: "Keeps this reply as one of the Bot's documents, to open and edit later in Pages.",
      messageMoreActions: "More actions for this message",
      attachBtn: "Attach a file",
      attachListLabel: "Attachments of this message",
      attachSentLabel: "Sent attachments",
      attachSentItem: "Attachment {name}, {type}, {size}",
      attachRemove: "Remove {name}",
      attachNotice: "The content of attachments goes to this Bot's model provider.",
      attachUploading: "Sending attachment\u2026",
      attachDrop: "Drop to attach",
      attachTooLarge: "{name} is over the limit: 10 MB for images, 20 MB for documents.",
      attachTypeRefused: "{name} cannot be attached. Accepted: images (PNG, JPG, GIF, WebP), PDF, Word, Excel, PowerPoint and text (TXT, MD, CSV, JSON).",
      attachTooMany: "Up to {n} attachments per message.",
      attachErrTooLarge: "The file is over the limit: 10 MB for images, 20 MB for documents.",
      attachErrType: "LuveBot did not accept this file: by its content, it is not an accepted type. Accepted: images (PNG, JPG, GIF, WebP), PDF, Word, Excel, PowerPoint and text (TXT, MD, CSV, JSON).",
      attachErrSensitive: "This file name looks like it holds secrets (like .env or a key) and cannot be attached.",
      attachErrGeneric: "Could not send the attachment. Try again.",
      attachWsNone: "This Bot has no work folder yet, which is where attachments are kept.",
      attachWsCreate: "Create the Bot's folder",
      attachWsCreated: "Folder created. Send again.",
      attachWsCreateFailed: "Could not create the Bot's folder right now. Try again.",
      pagesNoFolder: "{name} does not have a working folder for Pages yet.",
      pagesCreatingFolder: "Creating the folder\u2026",
      attachWsNotLocal: "Attachments do not work yet with this Bot's remote or container terminal.",
      attachWsInside: "The Bot's work folder is inside Hermes; pick another one in Hermes to use attachments.",
      attachWsUnsafe: "This Bot's attachments folder is a shortcut; LuveBot does not write to it.",
      attachWsOther: "This Bot's work folder is not available right now.",
      fileCardMeta: "{name}'s file \xB7 {path}",
      fileDownload: "Download",
      fileEdit: "Edit",
      fileEditNamed: "Edit {file}",
      fileOpenInEditor: "Open in editor",
      fileOpenInEditorNamed: "Open {file} in the editor",
      fileOpening: "Opening\u2026",
      fileCopyNote: "Opens a copy in Pages for you to edit. The original file stays in the Bot's workspace, and the Bot keeps working on it, not on the copy.",
      fileCopyExists: "A page with that name already exists ({slug}); nothing was overwritten.",
      fileOpenExisting: "Open the existing page",
      fileCopyNoPages: "This Bot's Pages are not available yet (see Profile > Pages); the file is still under Download.",
      fileDownloadNamed: "Download {file}",
      fileDownloading: "Downloading\u2026",
      fileDownloadHint: "Saves this file from the Bot's folder to your device.",
      fileErrNotFound: "File not available: it is not in the Bot's folder.",
      fileErrRedacted: "Not delivered: the file holds something that looks like a secret.",
      fileErrNoWorkspace: "This Bot's work folder is not available.",
      fileErrTooLarge: "The file is over 25 MiB and cannot be downloaded here.",
      fileErrNetwork: "No connection to LuveBot. Try again.",
      fileErrGeneric: "Could not download the file right now. Try again.",
      pageAboutChip: "About the page {title}",
      pageAboutRemove: "Remove the page from this message",
      pageAboutSent: "about the page {slug}",
      pagesSearchCategory: "Pages",
      workPanelTabs: "Work panel tabs",
      closePanelBtn: "Close panel",
      messageLabel: "Message",
      stopBtn: "Stop",
      sendBtn: "Send",
      commErrorLuveBot: "Communication failure with LuveBot.",
      streamErrorGeneric: "The conversation with the Bot was interrupted by an error. Try again.",
      unexpectedError: "Unexpected error.",
      // WorkPanel
      tabActivity: "Activity",
      tabTerminal: "Terminal",
      tabFiles: "Files",
      tabScreen: "Screen",
      screenRegion: "{name}'s screen",
      screenLoading: "Reading the Bot's screen\u2026",
      screenUnsupported: "This machine has no Bot screen (Linux servers only).",
      screenNotInstalled: "The screen packages are missing on the server. LuveBot installs nothing: whoever runs the server installs them.",
      screenMissingLabel: "Missing",
      screenInstallCommandLabel: "Command suggested by Hermes",
      screenReadmeLink: "README section \u201CLive screen\u201D",
      screenNoMemory: "Not enough free memory to start the screen now.",
      screenMemoryNumbers: "Free: {available} MB \xB7 needed: {needed} MB",
      screenHermesSays: "Hermes says",
      screenSandbox: "The screen lives in the terminal sandbox ({placement}); use the image with a desktop.",
      screenStopped: "The Bot's screen is stopped.",
      screenStartBtn: "Start the screen",
      screenStarting: "Starting the screen\u2026",
      screenConnecting: "Connecting to the screen\u2026",
      screenWatching: "You are watching the screen. The Bot stays in control.",
      screenOtherHuman: "A person has control of this screen now.",
      screenTakeBtn: "Take control",
      screenTakeTitle: "Take control of the screen?",
      screenTakeBody: "While you are in control, the Bot stops using the screen. Give it back when you are done.",
      screenTakeOther: "Another person has control now; they go back to watching.",
      screenReasonLabel: "Reason (optional, the Bot sees it)",
      screenTakeConfirm: "Take control",
      screenInControl: "You are in control",
      screenReturnBtn: "Give back to the Bot",
      screenReturnTitle: "Give control back to the Bot?",
      screenReturnBody: "The Bot can use the screen again.",
      screenReturnConfirm: "Give back",
      screenControlTaken: "Someone else took control. You are watching again.",
      screenTicketSpent: "The connection expired; reconnecting to watch.",
      screenWentDown: "The screen stopped.",
      screenOriginRefused: "Hermes refused this page's origin; the screen does not open here.",
      screenLost: "The connection to the screen dropped.",
      screenReconnectBtn: "Reconnect",
      screenNoImage: "No picture for {n} s. The connection is open, but no new image came in.",
      screenKeyboardBtn: "Keyboard",
      screenKeyboardInput: "Type on the Bot's screen",
      screenFullscreenBtn: "Full screen",
      screenRetryBtn: "Try again",
      screenErrUnavailable: "The live screen is not available in this installation.",
      screenErrInUse: "A person has control; the screen is not stopped under them.",
      screenErrNotRunning: "The screen is not running.",
      screenErrNotYours: "You do not have control of this screen.",
      screenErrLoopback: "Giving control back needs a dashboard with a login; this one is in loopback mode.",
      screenErrGeneric: "Could not reach the screen right now. Try again.",
      screenErrNetwork: "No answer from the screen: the network dropped or the viewer (noVNC) did not load.",
      emptyActivity: "Nothing happened yet. Tools used by the Bot will appear here.",
      emptyTerminal: "No terminal commands in this conversation.",
      runningStatus: "running\u2026",
      noOutputChannel: "no output recorded on this channel",
      outputExit: "exit",
      emptyFiles: "No file tools were observed in this conversation. When Hermes reports one, read and written paths will appear here.",
      writtenOp: "written",
      filesDelivered: "Delivered in the conversation",
      readOp: "read",
      // ApprovalsInbox
      approvalsTitle: "Approvals Inbox",
      pendingActionCountOne: "1 action awaiting your authorization",
      pendingActionCountMany: "{count} actions awaiting your authorization",
      filterByBot: "Filter by Bot",
      filterByStatus: "Filter by status",
      filterAllBots: "All Bots",
      filterPending: "Pending",
      filterAll: "All",
      refreshApprovals: "Refresh approvals",
      loopbackWarningApprovals: "Loopback mode active: approvals are in read-only mode (loopback_not_human). Connect via authenticated session to decide.",
      closeError: "Close error",
      selectedCount: "{count} selected",
      mismatchedClassWarning: "\u26A0 Different classes selected. Batch resolution requires the same action class.",
      allowSelectedOnce: "Allow selected (once)",
      denySelected: "Deny selected",
      clearSelection: "Clear selection",
      selectAllPending: "Select all pending",
      totalCount: "{count} total",
      noPendingApprovalsTitle: "No pending approvals",
      noPendingApprovalsDesc: "All caught up! LuveBot will notify you when a Bot requests permission to execute commands, scripts or protected actions.",
      actionAllowedOnce: "{bot}'s action allowed once.",
      actionDenied: "{bot}'s action denied.",
      approvalInlineOnce: "Allowed once.",
      statusResuming: "Resuming\u2026",
      approvalInlineDeny: "Denied.",
      denyReasonDelivered: "The reason was delivered to the Bot as human guidance.",
      denyReasonSending: "Sending the reason to the Bot\u2026",
      denyReasonUnknown: "The reason was sent, but there is no confirmation yet that the Bot received it.",
      denyReasonKept: "The reason was recorded in LuveBot and in the audit log; it was not delivered to the Bot.",
      approvalInlineAlways: "Allowed once; the rule was saved as a draft.",
      actionAlwaysResolved: "{bot}'s action resolved once and a draft rule was created.",
      batchResolved: "{count} actions batch resolved as '{choice}'.",
      viewParamsBtn: "View parameters",
      denyBtn: "Deny\u2026",
      alwaysAllowBtn: "Always allow\u2026",
      allowOnceBtn: "Allow once",
      approvalRuleNoncanonical: "Unusual action: LuveBot asks you to confirm",
      approvalRuleNamed: "Rule \u201C{label}\u201D asks you to confirm",
      approvalRuleUnknown: "A LuveBot rule asks you to confirm",
      approvalTechnicalDetail: "Technical detail",
      toolTerminal: "Terminal command",
      toolWriteFile: "Write file",
      toolReadFile: "Read file",
      toolPatch: "Edit file",
      toolWebSearch: "Web search",
      toolWebExtract: "Read web page",
      toolBrowser: "Browser",
      toolSendMessage: "Send message",
      disabledInLoopback: "Disabled in loopback mode",
      timeNow: "just now",
      timeAgoMins: "{mins}m ago",
      timeAgoHours: "{hrs}h ago",
      timeExpired: "expired",
      timeExpiresMins: "expires in {mins}m",
      timeExpiresHours: "expires in {hrs}h",
      defaultActionLabel: "action",
      selectApprovalAria: "Select approval {id}",
      originRun: "Origin: Run",
      originTransport: "Origin: Channel transport",
      nativeChoices: "Native options:",
      patternsLabel: "Patterns:",
      alwaysModalTitle: "Always allow similar actions?",
      alwaysModalHeader: "Always allow\u2026 (Create draft rule)",
      alwaysModalExplanation: "LuveBot adheres to Invariant 6: no permanent permissions are written directly to Hermes. Upon confirming, a draft rule is created for review and current execution is authorized once (once).",
      alwaysModalExplanationP1: "For security (Invariant 6 and ADR-002), LuveBot never writes direct permanent permissions to Hermes without human review.",
      alwaysModalExplanationP2: "This action will resolve the current request once and create a draft rule scoped to Bot {bot} so you can review and activate it whenever desired.",
      alwaysModalDraftLabel: "Draft rule label:",
      alwaysModalCancel: "Cancel",
      alwaysModalConfirm: "Create draft and allow once",
      denyModalTitle: "Deny action request",
      denyModalTitleWithBot: "Deny action for Bot '{bot}'",
      denyModalExplanation: "Denial reason is mandatory; it is recorded in LuveBot and in the audit log.",
      denyModalReasonLabel: "Denial reason (mandatory):",
      denyModalPlaceholder: "Explain why this action is not allowed...",
      denyModalConfirm: "Confirm denial",
      denyReasonRequired: "Denial reason is mandatory to guide the Bot.",
      denyReasonEmpty: "Reason cannot be blank.",
      batchDenyModalTitle: "Batch deny requests",
      batchDenyReasonLabel: "Denial reason for batch:",
      batchDenyReasonRequired: "Batch denial reason is mandatory.",
      batchDenyPlaceholder: "e.g.: Batch operations denied by administrator...",
      batchMismatchRefused: "Batch resolution rejected: all items must belong to the same action class.",
      batchConfirmOnceTitle: "Allow {count} batch actions?",
      batchConfirmDenyTitle: "Deny {count} batch actions?",
      batchConfirmExplanation: "You are about to decide {count} requests simultaneously. Each request will be processed individually with its verified digest.",
      batchConfirmBtn: "Confirm batch decision",
      editModalTitle: "Action Details and Editing",
      editModalParametersTitle: "Action parameters",
      editModalWarning: "LuveBot does not edit an approval's arguments: decide it as it is, or deny with a reason so the Bot redoes it.",
      editModalActionLabel: "Action:",
      editModalCommandLabel: "Command:",
      editModalDetailsLabel: "Details:",
      editModalCommand: "Command to execute:",
      editModalClose: "Close",
      digestVerifiedTitle: "Verified digest: {digest}",
      digestPrefix: "digest:",
      errorLoopbackApprovalBlocked: "Action blocked: approvals not allowed over local connection (loopback_not_human).",
      errorStaleConflict: "Conflict: this request expired, was modified, or already decided (stale).",
      errorCsrfRequired: "Security error: CSRF token missing or invalid.",
      errorUnexpectedApproval: "Unexpected error while processing approval decision.",
      errorLoadingApprovals: "Failed to load approvals list.",
      // RulesView
      rulesTitle: "Rules and Governance",
      rulesTitleBot: "Bot Rules: {bot}",
      rulesSubtitle: "4 autonomy levels + block, strict precedence and honest seal verified in real time.",
      rulesTabRules: "Rules ({count})",
      rulesTabSimulator: "Simulator",
      newRuleBtn: "New rule",
      refreshRules: "Refresh rules",
      loopbackWarningRules: "Loopback mode active: rule activation and approvals are in read-only mode (loopback_not_human, D-012).",
      searchRulesPlaceholder: "Search by name, tool or command...",
      filterByLevel: "Filter by level",
      filterByState: "Filter by state",
      filterAllLevels: "All levels",
      filterAllStates: "All states",
      filterActive: "Active",
      filterDrafts: "Drafts",
      filterSuggestions: "Bot Suggestions",
      filterArchived: "Archived",
      precedenceRuleText: "Precedence: Block > Handback > Ask > Explicit > Allow",
      noRulesFoundTitle: "No rules found",
      noRulesFoundDesc: "Create a new rule or adjust filters to view governance directives.",
      sealLock: "Real block",
      sealHand: "Real approval",
      sealNote: "Guidance",
      sealBroken: "Broken",
      sealCaveatHand: "Real approval for the forms the pattern recognizes.",
      sealCaveatLock: "Real block for the forms the pattern recognizes.",
      sealCaveatWhy: "The pattern reads the command as written: inline code, a command built at run time, scripts and aliases are not read.",
      sealUnverified: "No seal",
      levelAllow: "1. Act without asking",
      levelExplicit: "2. Act if explicitly requested",
      levelAsk: "3. Ask before acting",
      levelHandback: "4. Hand back to me",
      levelBlock: "Block",
      badgeBuiltin: "\u{1F512} Built-in (immutable)",
      badgeDraft: "Draft (no effect)",
      badgeSuggestion: "Bot Suggestion (pending review)",
      ruleScopeGlobal: "All Bots",
      ruleScopeRoom: "Room {name}",
      ruleScopeRoutine: "Routine {name}",
      toolsLabel: "Tools:",
      commandsLabel: "Commands:",
      problemsDetectedTitle: "\u26A0 Problems detected in execution seal:",
      qualifiersLabel: "Qualifiers:",
      statusBuiltinProtection: "Immutable system protection",
      statusDraftInactive: "Inactive draft \u2014 activate to apply during execution",
      statusHumanReviewNeeded: "Human review needed",
      statusActiveVersion: "Active (version {version})",
      activateRuleBtn: "Activate rule",
      reviewAsDraftBtn: "Review as draft",
      archiveBtn: "Archive",
      ruleActivatedSuccess: "Rule '{label}' activated successfully.",
      ruleDraftConverted: "Suggestion converted to draft for '{label}'. Review before activating.",
      ruleArchivedSuccess: "Rule '{label}' archived.",
      ruleDraftCreated: "Draft of rule '{label}' created.",
      newRuleModalTitle: "Create New Governance Rule",
      newRuleModalDesc: "All newly created rules start as drafts and require explicit activation to take effect.",
      ruleLabelInput: "Rule Name / Label *",
      ruleLabelPlaceholder: "e.g.: Block terminal rm -rf",
      ruleLevelInput: "Autonomy Level *",
      ruleScopeKindInput: "Scope *",
      scopeGlobal: "Global (all Bots)",
      scopeBot: "Specific to a Bot",
      targetBotInput: "Target Bot *",
      toolsMatchInput: "Tools (comma-separated)",
      toolsMatchPlaceholder: "e.g.: terminal, bash",
      commandsMatchInput: "Commands / Patterns (comma-separated)",
      commandsMatchPlaceholder: "e.g.: rm -rf *, curl *",
      cancelBtn: "Cancel",
      createDraftBtn: "Create draft",
      simulatorTitle: "Rule Actions and Precedence Simulator",
      simulatorSubtitle: "Test how the rules engine evaluates a tool or command for a specific Bot.",
      simBotLabel: "Bot:",
      simToolLabel: "Tool name (tool):",
      simToolPlaceholder: "e.g.: send_email, exec_command, install_package",
      simCommandLabel: "Command executed (optional):",
      simCommandPlaceholder: "e.g.: rm -rf /tmp",
      simEvaluating: "Evaluating...",
      simEvaluateBtn: "Simulate action",
      simResultTitle: "Simulation Result:",
      simResultEvaluation: "Evaluation result:",
      simDecisionLabel: "Decision:",
      simWinningRuleLabel: "Winning rule:",
      simReasonLabel: "Reason:",
      simMatchingRulesTitle: "Matching rules ({count}):",
      simNoMatchingRules: "No active rules matched this action. Default effect is allow without restriction.",
      simMatchedOn: "(matched on: {pattern})",
      simPrecedenceExplanation: "The final decision strictly follows precedence: Block > Handback > Ask > Explicit > Allow.",
      errorLoopbackRuleBlocked: "Rule activation blocked in loopback mode for security (loopback_not_human, D-012).",
      errorBuiltinImmutable: "Built-in rules are immutable and cannot be modified.",
      errorStaleRule: "Outdated rule version (stale). Refresh the page.",
      errorUnexpectedRule: "Unexpected error while processing rule.",
      errorLoadingRules: "Failed to load rules.",
      errorSimulatingRule: "Failed to execute rule simulation.",
      // Costs & Budget (spec §4.13, contract v0.2 §4)
      costsTitle: "Costs & Budget",
      costsSubtitle: "Monitor actual spend and manage budget ceilings safely.",
      tabOverview: "Spend Overview",
      tabBudgetLimits: "Ceilings & Limits",
      tabPausedBots: "Paused Bots",
      periodLabel: "Period:",
      periodDay: "Today",
      period7d: "Last 7 days",
      periodMonth: "Current month",
      period30d: "Last 30 days",
      groupLabel: "Group by:",
      groupBot: "Bot",
      groupModel: "Model",
      groupRoutine: "Routine",
      groupDay: "Day",
      filterBotLabel: "Filter by Bot:",
      allBotsOption: "All Bots",
      totalSpendLabel: "Total Spend ({period})",
      unpricedSessionsNotice: "{count} unpriced model sessions",
      ledgerLagLabel: "Ledger lag:",
      ledgerLagSeconds: "{seconds}s lag",
      ledgerStaleWarning: "Watcher stale: new runs may be refused (watcher_stale)",
      ledgerBadge: "ledger",
      tableHeaderKey: "Item / Key",
      tableHeaderSpend: "Spend",
      tableHeaderTokens: "Tokens",
      tableHeaderSessions: "Sessions",
      noCostsData: "No cost data recorded for the selected filters.",
      limitsTitle: "Active Budget Ceilings",
      limitsSubtitle: "When a Bot hits the ceiling, its cron jobs are paused and new runs through LuveBot are refused. It still answers on Telegram and its other channels.",
      scopeGlobalLabel: "Global",
      scopeBotLabel: "Bot: {name}",
      scopeRoutineLabel: "Routine: {name}",
      limitPeriodDay: "Daily",
      limitPeriodMonth: "Monthly",
      limitSpentOf: "{spent} of {limit} ({percent}%)",
      limitReserved: "Reserved: {reserved}",
      limitZeroBlocked: "Ceiling 0: all work blocked for this scope",
      btnEditLimit: "Adjust ceiling",
      btnSetLimit: "Set new ceiling",
      btnRemoveLimit: "Remove ceiling",
      noLimitsConfigured: "No budget ceilings configured.",
      modalLimitTitle: "Configure Budget Ceiling",
      limitScopeInput: "Scope *",
      limitPeriodInput: "Period *",
      limitTargetInput: "Target (Bot / Routine)",
      limitAmountLabel: "Ceiling amount (USD) *",
      limitAmountPlaceholder: "e.g.: 10.00",
      limitCurrentValue: "Current ceiling: {amount}",
      limitAmountCentsHint: "Values are processed in integer cents by the backend.",
      btnSaveLimit: "Save ceiling",
      btnConfirmRemoveLimit: "Confirm removal",
      pausedBotsTitle: "Bots Paused by Budget Ceiling Breach",
      pausedBotsEmpty: "No Bots paused by budget ceiling at the moment.",
      pausedBotReason: "Reason: Budget ceiling breach ({reason})",
      pausedSince: "Paused since: {time}",
      btnResumeBot: "Resume Bot",
      resumeBotConfirmationTitle: "Confirm Bot Resume",
      resumeBotConfirmationBody: "Are you sure you want to resume bot '{bot}'? Cron jobs paused by budget will be reactivated if balance permits.",
      btnConfirmResume: "Confirm Resume",
      resumingBot: "Resuming...",
      botResumedSuccess: "Bot resumed successfully.",
      loopbackBudgetWarningTitle: "Loopback Mode Active (D-014)",
      loopbackBudgetWarningDetail: "In loopback mode, only lowering existing ceilings is allowed. Raising or removing ceilings and resuming paused Bots require an authenticated human session (loopback_not_human).",
      errorLoopbackBudgetRaiseBlocked: "Raising or removing ceiling is blocked in loopback mode (loopback_not_human).",
      errorLoopbackBudgetResumeBlocked: "Resuming Bot is blocked in loopback mode. Requires human confirmation (loopback_not_human).",
      errorLoadingCosts: "Error loading costs data.",
      errorLoadingBudget: "Error loading budget and ceilings.",
      errorSavingLimit: "Error saving budget ceiling.",
      errorResumingBot: "Error resuming bot.",
      budgetAlertExceeded: "Alert: Ceiling exceeded ({percent}%) for {scope}",
      budgetAlertWarning: "Alert: {percent}% of ceiling reached for {scope}",
      refreshCostsAriaLabel: "Reload costs data",
      filterGroupAriaLabel: "Cost grouping selector",
      filterPeriodAriaLabel: "Cost period selector",
      filterBotAriaLabel: "Bot filter selector for costs",
      limitAmountInputAriaLabel: "Ceiling amount in dollars",
      loopbackBadge: "loopback_not_human",
      limitTargetPlaceholder: "e.g.: vendas, routine-1",
      // Routines (spec §4.9, contract v0.2 §3)
      routinesTitle: "Routines & Schedules",
      routinesSubtitle: "Manage recurring tasks, full history, and test runs safely.",
      newRoutineBtn: "New routine",
      refreshRoutinesAriaLabel: "Reload routines list",
      filterRoutinesBotLabel: "Filter by Bot:",
      filterRoutinesStateLabel: "State:",
      stateAll: "All states",
      stateScheduled: "Scheduled",
      statePaused: "Paused",
      noRoutinesFound: "No routines found with the selected filters.",
      scheduleLabel: "Schedule: {expr}",
      nextRunLabel: "Next run: {time}",
      lastRunLabel: "Last run: {time}",
      noRunYet: "Not run yet",
      statusSuccess: "Success",
      statusError: "Error",
      statusRunning: "Running",
      statusStopped: "Stopped",
      pausedReasonUser: "Paused by user",
      pausedReasonBudget: "Paused by budget ceiling",
      routineCapLabel: "Ceiling: {cap}",
      routineSpendLabel: "Period spend: {spend}",
      btnPauseRoutine: "Pause",
      btnResumeRoutine: "Resume",
      btnTestRoutine: "Run test",
      btnEditRoutine: "Edit",
      btnDuplicateRoutine: "Duplicate",
      btnDeleteRoutine: "Delete",
      btnViewHistory: "History & Details",
      testDisabledPausedRoutine: "Test disabled: cannot run test on a paused routine (routine_paused)",
      testWarningRealWork: "Warning: Running test executes real work.",
      modalConfirmTestTitle: "Confirm Routine Test",
      modalConfirmTestBody: "This action executes real work through the agent for routine '{name}'. Are you sure you want to proceed?",
      btnConfirmTest: "Execute test",
      modalConfirmPauseTitle: "Confirm Pause Routine",
      modalConfirmPauseBody: "Do you want to pause routine '{name}'? Scheduled executions will not run.",
      btnConfirmPause: "Pause routine",
      modalConfirmResumeTitle: "Confirm Resume Routine",
      modalConfirmResumeBody: "Do you want to resume routine '{name}'? Upcoming runs will follow the schedule.",
      btnConfirmResumeRoutine: "Resume routine",
      modalConfirmDeleteTitle: "Permanently Delete Routine",
      modalConfirmDeleteBody: "This action is irreversible. Type the routine name '{name}' to confirm deletion:",
      deleteRoutineInputPlaceholder: "Routine name",
      btnConfirmDelete: "Delete routine",
      routineDetailTitle: "Routine Details: {name}",
      instructionLabel: "Instruction (Prompt):",
      inputSourceLabel: "Input source:",
      deliverySummaryLabel: "Delivery:",
      historyTitle: "Complete Execution History ({count})",
      historyTruncatedWarning: "Warning: script history truncated at 100 runs by runtime.",
      tableHeaderSession: "Session / Run",
      tableHeaderStarted: "Started",
      tableHeaderDuration: "Duration",
      tableHeaderStatus: "Status",
      tableHeaderCost: "Cost",
      noRunsRecorded: "No runs recorded for this routine yet.",
      btnCloseDetail: "Back to list",
      modalCreateRoutineTitle: "Create New Routine",
      modalEditRoutineTitle: "Edit Routine",
      routineNameInput: "Routine name *",
      routineNamePlaceholder: "e.g.: Morning sales report",
      routineScheduleExprInput: "Schedule expression (Cron / Readable) *",
      routineScheduleExprPlaceholder: "e.g.: 0 8 * * 1-5",
      routinePromptInput: "Agent instruction / prompt *",
      routinePromptPlaceholder: "e.g.: Analyze new leads and send a summary...",
      routineBotInput: "Responsible Bot *",
      btnSaveRoutine: "Save routine",
      errorDeletingNameMismatch: "The entered name does not match the routine name.",
      errorLoadingRoutines: "Error loading routines.",
      errorLoadingRoutineRuns: "Error loading execution history.",
      errorTestingRoutine: "Error running routine test.",
      errorPausingRoutine: "Error pausing routine.",
      errorResumingRoutine: "Error resuming routine.",
      errorDeletingRoutine: "Error deleting routine.",
      errorSavingRoutine: "Error saving routine.",
      routineTestedSuccess: "Routine test started successfully.",
      routinePausedSuccess: "Routine paused successfully.",
      routineResumedSuccess: "Routine resumed successfully.",
      routineDeletedSuccess: "Routine deleted successfully.",
      // Activity (spec §4.7, contract v0.2 §2)
      activityHeaderTitle: "Activity",
      tabRunning: "In progress",
      tabScheduled: "Scheduled",
      tabDone: "Completed",
      viewList: "List",
      viewKanban: "Kanban",
      filterAllOrigins: "All origins",
      filterAllStatuses: "All statuses",
      filterOriginMessage: "Message",
      filterOriginRoutine: "Routine",
      filterOriginWebhook: "Webhook",
      filterOriginHandoff: "Handoff",
      filterStatusRunning: "Running",
      filterStatusWaitingApproval: "Waiting approval",
      filterStatusScheduled: "Scheduled",
      filterStatusDone: "Done",
      filterStatusError: "Error",
      filterStatusStopped: "Stopped",
      filterStatusBlocked: "Blocked",
      activitySearchPlaceholder: "Search activity...",
      activityMinCostPlaceholder: "Min cost (cents)",
      kanbanColTriage: "Triage",
      kanbanColTodo: "To Do",
      kanbanColScheduled: "Scheduled",
      kanbanColReady: "Ready",
      kanbanColRunning: "Running",
      kanbanColBlocked: "Blocked",
      kanbanColReview: "In Review",
      kanbanColDone: "Done",
      activityBtnContext: "Add context",
      activityBtnCorrect: "Correct",
      activityBtnRedirect: "Redirect",
      activityBtnStop: "Stop",
      activityBtnStopping: "Stopping...",
      activityBtnConversation: "Conversation",
      activityBtnEvents: "View events",
      activityStopModalTitle: "Confirm Stop",
      activityStopModalDesc: "Are you sure you want to stop this run? This will send a termination request.",
      activityStopReasonPlaceholder: "Optional stop reason...",
      activityStopConfirmBtn: "Confirm Stop",
      activityRedirectModalTitle: "Redirect Task",
      activityRedirectModalDesc: "Select the Bot to which this task will be transferred.",
      activityRedirectSelectBotLabel: "Target (Bot):",
      activityRedirectReasonPlaceholder: "Reason for transfer...",
      activityRedirectConfirmBtn: "Confirm Redirect",
      activityContextModalTitle: "Add Context or Correction",
      activityContextKindContext: "Context",
      activityContextKindCorrection: "Correction",
      activityContextTextPlaceholder: "Additional instructions or context for the Bot...",
      activityContextNotice: "This text goes into the task's thread, and the Bot reads it the next time it opens the task. It is work data, never a command to LuveBot.",
      activityContextConfirmBtn: "Send Information",
      activityPartialWarning: "Warning: partial sources unavailable ({sources})",
      noActivityFound: "No activity found for current filters.",
      activityCheckpointBadge: "Checkpoint: {done}/{total} ({review} to review)",
      activityDurationLabel: "Duration: {seconds}s",
      activityCostLabel: "Cost: {cost}",
      activityStartedAtLabel: "Started: {time}",
      activityEndedAtLabel: "Ended: {time}",
      activityLanesGroupBot: "Bot Lane: {bot}",
      activityRefreshBtn: "Refresh",
      errorLoadingActivity: "Error loading activity.",
      errorStoppingActivity: "Error stopping activity.",
      errorRedirectingActivity: "Error redirecting activity.",
      errorAddingContext: "Error adding context.",
      activityStopSuccess: "Stop request sent successfully.",
      activityRedirectSuccess: "Activity redirected successfully.",
      activityContextSuccess: "Context added successfully.",
      // Rooms (spec §4.4, contract v0.3 §3, §4)
      roomsTitle: "Work Rooms",
      roomsSubtitle: "Group coordination and discussion with Hermes Bots.",
      newRoomBtn: "New Room",
      createRoomModalTitle: "Create New Room",
      editRoomModalTitle: "Edit Room",
      roomNameLabel: "Room name *",
      roomNamePlaceholder: "e.g.: Q4 Launch, Support Squad",
      roomGoalLabel: "Room goal",
      roomGoalPlaceholder: "e.g.: Coordinate prospecting and proposal sending",
      roomMembersLabel: "Member Bots (choose 2 to 6) *",
      roomMembersHelp: "Select between 2 and 6 active Bots. Roster is frozen at creation.",
      roomOwnerLabel: "Next step owner (Optional)",
      roomCoordinatorLabel: "Room coordinator (Optional)",
      roomKickoffLabel: "Start with goal as first message (consumes 1 round)",
      roomKickoffNotice: "The goal will be sent as the first message of the discussion.",
      btnSaveRoom: "Save Room",
      btnCreateRoom: "Create Room",
      roomNeedTwoReady: "Not enough Bots connected to Hermes.",
      roomTooFewReadyTitle: "Only {count} Bot is connected to Hermes; a room needs 2.",
      roomTooFewReadyHelp: "In Hermes, open Channels for another Bot's profile, turn on the API server with a key and restart that profile's gateway.",
      roomBotNotReady: "Not connected to Hermes: turn on this profile's API Server.",
      roomNeedName: "Give the room a name.",
      roomNeedTwoBots: "Pick at least 2 Bots ({count} of 2).",
      roomCreateTimeout: "Hermes did not answer within 20 s. The room may have been created: check the list of rooms before trying again.",
      roomsUnavailableTitle: "Rooms are not available right now.",
      roomsCheckAgain: "Check again",
      roomsChecking: "Checking that rooms are available on this Hermes\u2026",
      roomDisbandBtn: "Disband Room",
      modalDisbandRoomTitle: "Disband Room Permanently",
      modalDisbandRoomBody: "This action permanently terminates the room. Type the room name '{name}' to confirm:",
      disbandRoomInputPlaceholder: "Room name",
      btnConfirmDisband: "Disband room",
      roomStopBtn: "Stop",
      roomStoppingBtn: "Stopping...",
      modalStopRoomTitle: "Stop Room Execution",
      modalStopRoomBody: "Do you want to stop all tasks and discussions in progress for this room?",
      btnConfirmStopRoom: "Confirm Stop",
      roomRetryBtn: "Retry",
      modalRetryRoomTitle: "Retry Room Task",
      modalRetryRoomBody: "Do you want to re-execute this indeterminate task in the room?",
      btnConfirmRetryRoom: "Retry Task",
      modalCostConfirmTitle: "Cost Notice: @todos",
      modalCostConfirmBody: "Mentioning @todos or multiple Bots will trigger coordinated rounds between all members (up to 3 rounds, up to 10 messages). Do you want to continue?",
      btnConfirmCostSend: "Confirm and Send",
      roomNotAMemberError: "Bot '@{handle}' is not a member of this room and cannot be targeted.",
      roomOpenTasksTitle: "Open Tasks ({count})",
      roomNoOpenTasks: "No open tasks at the moment.",
      roomHandoffCardTitle: "Handoff",
      roomHandoffFromTo: "From @{from} to @{to}",
      roomHandoffTaskLink: "View task in Kanban",
      btnPromoteHandoff: "Promote",
      btnCancelHandoff: "Cancel",
      roomInputPlaceholder: "Type a message... Use @ to mention room members or @todos",
      roomMembersCount: "{count} members",
      roomDriverRunning: "Running",
      roomDriverIdle: "Idle",
      roomSelectOptionNone: "None",
      roomGoalBadge: "Goal",
      roomOwnerBadge: "Owner: @{handle}",
      roomCoordinatorBadge: "Coord: @{handle}",
      roomMentionTodosLabel: "todos \u2014 Trigger all members",
      errorLoadingRooms: "Error loading rooms.",
      errorLoadingRoom: "Error loading room.",
      errorLoadingRoomLog: "Error loading room events.",
      errorCreatingRoom: "Error creating room.",
      errorPatchingRoom: "Error editing room.",
      errorSendingRoomMessage: "Error sending message.",
      errorStoppingRoom: "Error stopping room.",
      errorRetryingRoomTask: "Error retrying task.",
      errorDisbandingRoom: "Error disbanding room.",
      errorDisbandingNameMismatch: "Entered name does not match room name.",
      errorLoadingHandoffs: "Error loading handoffs.",
      errorPromotingHandoff: "Error promoting handoff.",
      roomMessageAccepted: "Message sent to room.",
      roomDisbandedSuccess: "Room disbanded successfully.",
      roomCreatedSuccess: "Room created successfully.",
      roomStoppedSuccess: "Room execution stopped.",
      noRoomSelected: "No room selected. Select a room in the sidebar or create a new room.",
      roomMembersMinMaxError: "A room must have between 2 and 6 member Bots.",
      roomNameRequiredError: "Room name is required.",
      roomMentionsListAriaLabel: "Mention suggestions",
      // Team Map (T5.2, spec §4.12, contract v0.3 §5)
      mapTitle: "Team Map",
      mapSubtitle: "Overview of Bot team, active rooms, and handoffs",
      mapWindow7d: "Last 7 days",
      mapWindow30d: "Last 30 days",
      mapViewVisual: "Graph",
      mapViewAccessible: "Accessible List",
      mapViewVisualDesc: "Visual graph view",
      mapViewAccessibleDesc: "Accessible list view for keyboard and screen readers",
      mapLiveHandoffBadge: "Live handoff",
      mapHandoffsCount: "{count} handoffs",
      mapHandoffsCountSingle: "1 handoff",
      mapHandoffDrawerTitle: "Handoffs between Bots",
      mapHandoffBetween: "{from} \u2192 {to}",
      mapLastActivity: "Last activity: {date}",
      mapCurrentTask: "Current task: {task}",
      mapNoTask: "No task currently running",
      mapCostWeek: "Week spend: {cost}",
      mapRoomsCount: "{count} rooms",
      mapRoomsCountSingle: "1 room",
      mapNoNodes: "No Bots found in map",
      mapNoEdges: "No handoffs recorded in the selected period.",
      mapLoading: "Loading team map...",
      mapError: "Error loading team map.",
      mapEdgesSection: "Connections & Handoffs",
      mapNodesSection: "Team Members",
      mapEdgeLiveIndicator: "Live",
      mapViewKanbanTask: "View task in Kanban",
      // Command Palette & Search (T5.2, spec §4.14, contract v0.3 §6)
      searchPaletteTitle: "Search & Quick Actions",
      searchCategoryAll: "All",
      searchCategoryMessages: "Messages",
      searchCategoryBots: "Bots",
      searchCategoryRooms: "Rooms",
      searchCategoryRoutines: "Routines",
      searchCategoryFiles: "Files",
      searchCategoryActions: "Actions",
      searchPlaceholderInput: "Type to search messages, bots, rooms, routines or actions...",
      searchQuickActionsHeader: "Quick Actions",
      searchResultsHeader: "Results",
      searchNoResults: 'No results found for "{query}"',
      searchLoading: "Searching...",
      searchNavigateAction: "Navigate",
      searchOpenModalAction: "Open",
      searchShortcutKey: "Shortcut",
      searchConfirmModalTitle: "Action Confirmation",
      searchConfirmPauseAllTitle: "Confirm Pause All",
      searchConfirmPauseAllBody: "Do you want to pause all Bots and routines? No new routine, task or gateway message will start until resumed. Work in progress will complete.",
      searchConfirmBtn: "Confirm",
      searchConfirmPauseAllBtn: "Pause all now",
      searchActionNewBot: "Create New Bot",
      searchActionNewBotDesc: "Opens wizard to create a new Bot in Hermes",
      searchActionNewRoom: "Create New Room",
      searchActionNewRoomDesc: "Creates a new collaboration room among multiple Bots",
      searchActionApprovals: "Go to Approvals Inbox",
      searchActionApprovalsDesc: "Reviews pending tool and run requests",
      searchActionActivity: "View Activity",
      searchActionActivityDesc: "Displays in progress, scheduled, and completed tasks",
      searchActionCosts: "View Costs & Budget",
      searchActionCostsDesc: "Manages budget limits and Bot consumption",
      searchActionRoutines: "View Routines",
      searchActionRoutinesDesc: "Lists and manages cron jobs and recurring tasks",
      searchActionMap: "View Team Map",
      searchActionMapDesc: "Visualizes Bot topology and handoff flow",
      searchActionPauseAll: "Pause all",
      searchActionPauseAllDesc: "Preventive pause of all runs and routines (requires confirmation)",
      searchPartialResultsNotice: "Some services did not respond in time: {sources}",
      searchFilesNotice: "File search filters by file name in the repository.",
      searchHitFromBot: "By {bot}",
      searchHitInSession: "Session: {session}",
      searchHitInRoom: "In room {room}",
      searchResultCount: "{count} results found",
      clearSearch: "Clear search",
      mapHandoffTotal: "Total",
      mapHandoffStatus: "Status",
      mapRecentTasks: "Recent tasks ({count})",
      mapHandoffItemLabel: "Handoff: {id}",
      // PWA & Mobile (spec §4.16, contract v0.3 §7)
      pwaOfflineNoticeHeader: "Offline mode not supported",
      pwaOfflineNoticeBody: "LuveBot is installable as a PWA and responsive, but does not work offline: it requires an active connection to Hermes to manage agents and rules.",
      pwaInstallableBadge: "PWA Installable",
      pwaScopeNotice: "Scope restricted to plugin (/dashboard-plugins/luvebot/). No API routes are cached.",
      // Empty States & Next Steps (spec §4.2, T6.4)
      needsYouEmptyNextStep: "Approvals and questions requiring your input will appear here for quick decisions.",
      inProgressEmptyNextStep: "Start a conversation with a Bot to delegate new tasks or trigger a routine.",
      completedTodayEmptyNextStep: "Completed results, reports, and artifacts will appear here throughout the day.",
      createFirstRoutine: "Create routine",
      conversationEmptyTitle: "Hi! I'm {name}.",
      conversationEmptyDesc: "Tell me what you need. If you like, start with one of these:",
      conversationPromptSuggestion1: "How can you help me today?",
      conversationPromptSuggestion2: "List available skills and tools.",
      approvalsEmptyNextStep: "Your Bots will request permission here before performing risky actions or protected tools.",
      costsEmptyNextStep: "Execution costs and token usage will appear here as Bots are utilized.",
      roomsEmptyNextStep: "Create a room to bring together multiple Bots and humans collaborating toward a common goal.",
      roomEmptyKickoffTitle: "Room goal and kickoff",
      roomEmptyKickoffDesc: "Mention a Bot with @handle to start collaborating. E.g.: @Research find sources, @Copy prepare draft.",
      mapEmptyNextStep: "Create Bots and configure rooms to visualize team structure and handoffs between agents.",
      searchEmptyPrompt: "Type to search messages, Bots, rooms, routines, and files.",
      searchEmptyNextStep: "Use arrow keys to navigate or pick a quick action.",
      viewConversationBtn: "View conversation",
      reviewHandoffBtn: "Review",
      todaySpendVsBudget: "{spend} today / {budget}",
      todaySpendOnly: "{spend} today",
      checkpointDoneParam: "{done} of {total}"
    }
  };
  var _checkEnKeys = translations.en;
  function formatString(str3, params) {
    if (!params) return str3;
    return str3.replace(
      /\{(\w+)\}/g,
      (match, key) => params[key] !== void 0 ? String(params[key]) : match
    );
  }
  var STORAGE_KEY = "luvebot_locale";
  var LOCALE_EVENT = "luvebot_locale_change";
  function getInitialLocale() {
    try {
      const storage = typeof window !== "undefined" && window.localStorage ? window.localStorage : typeof localStorage !== "undefined" ? localStorage : null;
      if (storage) {
        const saved = storage.getItem(STORAGE_KEY);
        if (saved === "pt" || saved === "en") {
          return saved;
        }
      }
    } catch {
    }
    if (typeof navigator !== "undefined") {
      const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
      for (const l of langs) {
        if (l && typeof l === "string") {
          const lower = l.toLowerCase();
          if (lower.startsWith("pt")) return "pt";
          if (lower.startsWith("en")) return "en";
        }
      }
    }
    const sdk = getSDK2();
    if (sdk?.useI18n) {
      try {
        const i18nResult = sdk.useI18n();
        if (i18nResult?.locale && typeof i18nResult.locale === "string") {
          const lower = i18nResult.locale.toLowerCase();
          if (lower.startsWith("pt")) return "pt";
          if (lower.startsWith("en")) return "en";
        }
      } catch {
      }
    }
    return "pt";
  }
  function setLuveLocale(newLocale) {
    try {
      const storage = typeof window !== "undefined" && window.localStorage ? window.localStorage : typeof localStorage !== "undefined" ? localStorage : null;
      if (storage) {
        storage.setItem(STORAGE_KEY, newLocale);
      }
    } catch {
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(LOCALE_EVENT, { detail: newLocale }));
    }
  }
  function useLuveI18n() {
    const [locale, setLocaleState] = react_default.useState(() => getInitialLocale());
    react_default.useEffect(() => {
      if (typeof window === "undefined") return;
      const handleLocaleChange = (e) => {
        const customEvent = e;
        if (customEvent.detail === "pt" || customEvent.detail === "en") {
          setLocaleState(customEvent.detail);
        } else {
          setLocaleState(getInitialLocale());
        }
      };
      window.addEventListener(LOCALE_EVENT, handleLocaleChange);
      return () => {
        window.removeEventListener(LOCALE_EVENT, handleLocaleChange);
      };
    }, []);
    const dict = translations[locale] || translations.pt;
    const t = react_default.useCallback(
      (key, params) => {
        const str3 = dict[key] || translations.pt[key] || String(key);
        return formatString(str3, params);
      },
      [dict]
    );
    const setLocale = react_default.useCallback((next) => {
      setLuveLocale(next);
    }, []);
    return { locale, t, setLocale };
  }

  // dashboard/src/hooks/useNarrow.ts
  var NARROW = "(max-width: 767px)";
  function useNarrow() {
    const mq = () => typeof window !== "undefined" && window.matchMedia ? window.matchMedia(NARROW) : null;
    const [narrow, setNarrow] = react_default.useState(() => mq()?.matches ?? false);
    react_default.useEffect(() => {
      const m = mq();
      if (!m) return;
      const on = () => setNarrow(m.matches);
      m.addEventListener?.("change", on);
      return () => m.removeEventListener?.("change", on);
    }, []);
    return narrow;
  }

  // dashboard/src/components/ui/color.ts
  var HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  var FALLBACK_COLOR = "var(--color-primary)";
  var botColor = (c) => c && HEX.test(c) ? c : FALLBACK_COLOR;
  function luminance(hex) {
    const h = hex.length === 4 ? hex.slice(1).split("").map((x) => x + x).join("") : hex.slice(1);
    const [r, g, b] = [0, 2, 4].map((i) => {
      const v = parseInt(h.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(a, b) {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  }
  var INK = "#0b0f19";
  var PAPER = "#ffffff";
  function readableOn(c) {
    const bg = botColor(c);
    if (!HEX.test(bg)) return "var(--color-primary-foreground)";
    return contrast(bg, INK) >= contrast(bg, PAPER) ? INK : PAPER;
  }
  var tint = (c, pct) => `color-mix(in srgb, ${botColor(c)} ${pct}%, transparent)`;

  // dashboard/src/components/ui/mascots.ts
  var MASCOTS = [
    { id: "luvi", name: "Luvi" },
    { id: "brisa", name: "Brisa" },
    { id: "faro", name: "Faro" },
    { id: "pipo", name: "Pipo" },
    { id: "nimbo", name: "Nimbo" },
    { id: "tinta", name: "Tinta" },
    { id: "rumo", name: "Rumo" },
    { id: "vera", name: "Vera" },
    { id: "zuca", name: "Zuca" },
    { id: "niquel", name: "N\xEDquel" },
    { id: "quadra", name: "Quadra" },
    { id: "flora", name: "Flora" },
    { id: "eco", name: "Eco" },
    { id: "lacre", name: "Lacre" },
    { id: "tico", name: "Tico" }
  ];
  var IDS = new Set(MASCOTS.map((m) => m.id));
  var isMascot = (id) => !!id && IDS.has(id);
  var MINI_BELOW = 56;
  function mascotUrl(id, state, size = 40) {
    if (!isMascot(id)) return null;
    const frag = state === "working" ? "#lb-working" : state === "needs_you" ? "#lb-needs-you" : "";
    return pluginIconUrl(`mascots/${id}${size < MINI_BELOW ? "-mini" : ""}.svg`) + frag;
  }
  function defaultMascot(bot) {
    let h = 2166136261;
    for (let i = 0; i < bot.length; i++) h = Math.imul(h ^ bot.charCodeAt(i), 16777619) >>> 0;
    return MASCOTS[h % MASCOTS.length].id;
  }
  function displayFace(bot, avatar) {
    const unset = !avatar || !avatar.value || avatar.kind === "initials" && avatar.value === bot.slice(0, 2).toUpperCase();
    return unset ? { kind: "mascot", value: defaultMascot(bot) } : avatar;
  }
  function withDefaultFace(b) {
    if (!b.display) return b;
    const avatar = displayFace(b.name, b.display.avatar);
    return avatar === b.display.avatar ? b : { ...b, display: { ...b.display, avatar } };
  }

  // dashboard/src/components/ui/Avatar.tsx
  var initialsOf = (s) => Array.from(s.trim()).slice(0, 2).join("").toUpperCase() || "?";
  function Avatar({ name, avatar, color, size = 40, ring = false, attention: attention2 }) {
    const accent = botColor(color);
    const src = avatar?.kind === "mascot" ? mascotUrl(avatar.value, attention2, size) : null;
    const box3 = src ? {
      width: size,
      height: size,
      flexShrink: 0,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      userSelect: "none"
    } : {
      width: size,
      height: size,
      flexShrink: 0,
      borderRadius: "36%",
      overflow: "hidden",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      userSelect: "none",
      background: tint(color, 18),
      color: accent,
      boxShadow: ring ? `0 0 0 2px var(--color-background, #fff), 0 0 0 4px ${accent}` : void 0
    };
    let face;
    if (src) face = /* @__PURE__ */ jsx("img", { src, alt: "", referrerPolicy: "no-referrer", width: size, height: size, style: { objectFit: "contain", width: "100%", height: "100%", ...ring ? { filter: `drop-shadow(0 0 1px ${accent}) drop-shadow(0 0 1.5px ${accent})` } : {} } });
    else if (avatar?.kind === "emoji" && avatar.value) face = /* @__PURE__ */ jsx("span", { style: { fontSize: size * 0.58, lineHeight: 1 }, children: avatar.value });
    else face = /* @__PURE__ */ jsx("span", { style: { fontSize: size * 0.38, fontWeight: 700, letterSpacing: "-0.02em" }, children: initialsOf(avatar?.kind === "initials" ? avatar.value : name) });
    return /* @__PURE__ */ jsx("span", { "aria-hidden": "true", style: box3, children: face });
  }

  // dashboard/src/components/ui/AvatarStack.tsx
  function AvatarStack({ faces, size = 28, max = 3, ring = "var(--color-background)" }) {
    const shown = faces.slice(0, max);
    return /* @__PURE__ */ jsx("span", { "aria-hidden": "true", style: { display: "inline-flex", alignItems: "center", flexShrink: 0 }, children: shown.map((f, i) => /* @__PURE__ */ jsx("span", { style: {
      display: "inline-flex",
      marginLeft: i ? -Math.round(size / 6) : 0,
      borderRadius: "38%",
      position: "relative",
      zIndex: shown.length - i,
      ...f.avatar?.kind === "mascot" ? {} : { boxShadow: `0 0 0 2px ${ring}` }
    }, children: /* @__PURE__ */ jsx(Avatar, { name: f.name, avatar: f.avatar, color: f.color, size }) }, f.key)) });
  }

  // dashboard/src/components/ui/AttentionBadge.tsx
  var META = {
    needs_you: { label: "statusNeedsYouLabel", title: "statusNeedsYouTitle" },
    error: { label: "statusErrorLabel", title: "statusErrorTitle" },
    offline: { label: "statusOfflineLabel", title: "statusOfflineTitle" },
    paused: { label: "statusPausedLabel", title: "statusPausedTitle" },
    working: { label: "statusWorkingLabel", title: "statusWorkingTitle" },
    unread: { label: "statusUnreadLabel", title: "statusUnreadTitle" }
  };
  var pill = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    minWidth: 18,
    height: 18,
    padding: "0 5px",
    borderRadius: 9,
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1
  };
  function AttentionBadge({ state }) {
    const { t } = useLuveI18n();
    if (state === "idle") return null;
    const a11y = { role: "img", "aria-label": t(META[state].label), title: t(META[state].title) };
    switch (state) {
      case "needs_you":
        return /* @__PURE__ */ jsx("span", { ...a11y, className: "luve-pulse", style: { ...pill, background: "var(--color-warning)", color: INK }, children: "!" });
      case "error":
        return /* @__PURE__ */ jsx("span", { ...a11y, style: { ...pill, background: "var(--color-destructive)", color: "var(--color-destructive-foreground)" }, children: "\xD7" });
      case "paused":
        return /* @__PURE__ */ jsx("span", { ...a11y, style: { ...pill, background: "var(--color-muted)", color: "var(--color-muted-foreground)" }, children: "\u2016" });
      case "offline":
        return /* @__PURE__ */ jsx("span", { ...a11y, style: { width: 10, height: 10, borderRadius: "50%", boxSizing: "border-box", flexShrink: 0, border: "2px solid var(--color-muted-foreground)" } });
      case "unread":
        return /* @__PURE__ */ jsx("span", { ...a11y, style: { width: 10, height: 10, borderRadius: 5, flexShrink: 0, background: "var(--color-primary)" } });
      case "working":
        return /* @__PURE__ */ jsxs("span", { ...a11y, className: "luve-typing", style: { display: "inline-flex", gap: 3, alignItems: "center", flexShrink: 0 }, children: [
          /* @__PURE__ */ jsx("i", {}),
          /* @__PURE__ */ jsx("i", {}),
          /* @__PURE__ */ jsx("i", {})
        ] });
    }
  }

  // dashboard/src/components/messenger/attention.ts
  function hasUnread(unread) {
    if (unread && typeof unread === "object") return Number(unread.count) > 0;
    return unread === true;
  }
  function attention(bot, pendingApprovals = 0) {
    if (bot.status === "waiting_approval" || pendingApprovals > 0) return "needs_you";
    if (bot.status === "error") return "error";
    if (bot.status === "offline") return "offline";
    if (bot.status === "paused") return "paused";
    if (bot.status === "working") return "working";
    if (hasUnread(bot.unread)) return "unread";
    return "idle";
  }

  // dashboard/src/components/Icons.tsx
  function SunIcon({ className = "", size = 15 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "4" }),
      /* @__PURE__ */ jsx("path", { d: "M12 2v2" }),
      /* @__PURE__ */ jsx("path", { d: "M12 20v2" }),
      /* @__PURE__ */ jsx("path", { d: "m4.93 4.93 1.41 1.41" }),
      /* @__PURE__ */ jsx("path", { d: "m17.66 17.66 1.41 1.41" }),
      /* @__PURE__ */ jsx("path", { d: "M2 12h2" }),
      /* @__PURE__ */ jsx("path", { d: "M20 12h2" }),
      /* @__PURE__ */ jsx("path", { d: "m6.34 17.66-1.41 1.41" }),
      /* @__PURE__ */ jsx("path", { d: "m19.07 4.93-1.41 1.41" })
    ] });
  }
  function CheckCircleIcon({ className = "", size = 15 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("path", { d: "M22 11.08V12a10 10 0 1 1-5.93-9.14" }),
      /* @__PURE__ */ jsx("polyline", { points: "22 4 12 14.01 9 11.01" })
    ] });
  }
  function ClockIcon({ className = "", size = 15 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "10" }),
      /* @__PURE__ */ jsx("polyline", { points: "12 6 12 12 16 14" })
    ] });
  }
  function RefreshCwIcon({ className = "", size = 15 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }),
      /* @__PURE__ */ jsx("path", { d: "M21 3v5h-5" }),
      /* @__PURE__ */ jsx("path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }),
      /* @__PURE__ */ jsx("path", { d: "M3 21v-5h5" })
    ] });
  }
  function NetworkIcon({ className = "", size = 15 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("circle", { cx: "12", cy: "5", r: "3" }),
      /* @__PURE__ */ jsx("circle", { cx: "6", cy: "19", r: "3" }),
      /* @__PURE__ */ jsx("circle", { cx: "18", cy: "19", r: "3" }),
      /* @__PURE__ */ jsx("path", { d: "M12 8v5" }),
      /* @__PURE__ */ jsx("path", { d: "m9 16-3-3" }),
      /* @__PURE__ */ jsx("path", { d: "m15 16 3-3" })
    ] });
  }
  function DollarSignIcon({ className = "", size = 15 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("line", { x1: "12", y1: "1", x2: "12", y2: "23" }),
      /* @__PURE__ */ jsx("path", { d: "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" })
    ] });
  }
  function SettingsIcon({ className = "", size = 15 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "3" }),
      /* @__PURE__ */ jsx("path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" })
    ] });
  }
  function PlusIcon({ className = "", size = 14 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("line", { x1: "12", y1: "5", x2: "12", y2: "19" }),
      /* @__PURE__ */ jsx("line", { x1: "5", y1: "12", x2: "19", y2: "12" })
    ] });
  }
  function PauseIcon({ className = "", size = 14 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("rect", { x: "6", y: "4", width: "4", height: "16" }),
      /* @__PURE__ */ jsx("rect", { x: "14", y: "4", width: "4", height: "16" })
    ] });
  }
  function PlayIcon({ className = "", size = 14 }) {
    return /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", className, children: /* @__PURE__ */ jsx("polygon", { points: "5 3 19 12 5 21 5 3" }) });
  }
  function SearchIcon({ className = "", size = 14 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("circle", { cx: "11", cy: "11", r: "8" }),
      /* @__PURE__ */ jsx("line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" })
    ] });
  }
  function XIcon({ className = "", size = 18 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("line", { x1: "18", y1: "6", x2: "6", y2: "18" }),
      /* @__PURE__ */ jsx("line", { x1: "6", y1: "6", x2: "18", y2: "18" })
    ] });
  }
  function BotIcon({ className = "", size = 16 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("rect", { x: "3", y: "11", width: "18", height: "10", rx: "2" }),
      /* @__PURE__ */ jsx("circle", { cx: "12", cy: "5", r: "2" }),
      /* @__PURE__ */ jsx("path", { d: "M12 7v4" }),
      /* @__PURE__ */ jsx("line", { x1: "8", y1: "16", x2: "8", y2: "16" }),
      /* @__PURE__ */ jsx("line", { x1: "16", y1: "16", x2: "16", y2: "16" })
    ] });
  }
  function HashIcon({ className = "", size = 14 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("line", { x1: "4", y1: "9", x2: "20", y2: "9" }),
      /* @__PURE__ */ jsx("line", { x1: "4", y1: "15", x2: "20", y2: "15" }),
      /* @__PURE__ */ jsx("line", { x1: "10", y1: "3", x2: "8", y2: "21" }),
      /* @__PURE__ */ jsx("line", { x1: "16", y1: "3", x2: "14", y2: "21" })
    ] });
  }
  function SparklesIcon({ className = "", size = 16 }) {
    return /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: /* @__PURE__ */ jsx("path", { d: "m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" }) });
  }
  function ArrowRightIcon({ className = "", size = 14 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("line", { x1: "5", y1: "12", x2: "19", y2: "12" }),
      /* @__PURE__ */ jsx("polyline", { points: "12 5 19 12 12 19" })
    ] });
  }
  function ShieldAlertIcon({ className = "", size = 16 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" }),
      /* @__PURE__ */ jsx("line", { x1: "12", y1: "8", x2: "12", y2: "12" }),
      /* @__PURE__ */ jsx("line", { x1: "12", y1: "16", x2: "12.01", y2: "16" })
    ] });
  }
  function CheckIcon({ className = "", size = 14 }) {
    return /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", className, children: /* @__PURE__ */ jsx("polyline", { points: "20 6 9 17 4 12" }) });
  }
  function FilterIcon({ className = "", size = 14 }) {
    return /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: /* @__PURE__ */ jsx("polygon", { points: "22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" }) });
  }
  function ChevronRightIcon({ className = "", size = 16 }) {
    return /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: /* @__PURE__ */ jsx("path", { d: "m9 18 6-6-6-6" }) });
  }
  function ContrastIcon({ className = "", size = 15 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "9" }),
      /* @__PURE__ */ jsx("path", { d: "M12 3a9 9 0 0 1 0 18z", fill: "currentColor" })
    ] });
  }
  function ExitIcon({ className = "", size = 15 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, "data-icon": "exit", children: [
      /* @__PURE__ */ jsx("path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }),
      /* @__PURE__ */ jsx("path", { d: "m16 17 5-5-5-5" }),
      /* @__PURE__ */ jsx("path", { d: "M21 12H9" })
    ] });
  }
  function PanelRightIcon({ className = "", size = 15 }) {
    return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round", className, children: [
      /* @__PURE__ */ jsx("rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }),
      /* @__PURE__ */ jsx("path", { d: "M15 4v16" })
    ] });
  }
  function PaperclipIcon({ className = "", size = 18 }) {
    return /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", className, "aria-hidden": "true", children: /* @__PURE__ */ jsx("path", { d: "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" }) });
  }

  // dashboard/src/components/messenger/ContactList.tsx
  var notice = (tone2) => ({
    margin: "8px 10px",
    padding: "10px 12px",
    borderRadius: 12,
    fontSize: 12,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    background: `color-mix(in srgb, ${tone2} 12%, transparent)`,
    color: "var(--color-foreground)"
  });
  var linkBtn = { alignSelf: "flex-start", minHeight: 44, border: "none", background: "none", padding: 0, color: "var(--color-primary)", textDecoration: "underline", cursor: "pointer", fontSize: 12 };
  function BotRow({ bot, selected, pending, onSelect }) {
    const { t } = useLuveI18n();
    const state = attention(bot, pending);
    const name = bot.display?.label || bot.name;
    return /* @__PURE__ */ jsxs("button", { type: "button", "aria-pressed": selected, onClick: () => onSelect?.(bot), className: "lb-contact", children: [
      /* @__PURE__ */ jsx(Avatar, { name, avatar: bot.display?.avatar, color: bot.display?.color, size: 40, ring: selected, attention: state }),
      /* @__PURE__ */ jsxs("span", { className: "lb-row-stack", children: [
        /* @__PURE__ */ jsx("span", { className: "lb-headline lb-truncate", style: { fontWeight: state === "unread" ? 700 : 600 }, children: name }),
        /* @__PURE__ */ jsx("span", { className: "lb-subhead lb-truncate", children: state === "working" ? t("statusTyping") : bot.display?.role })
      ] }),
      /* @__PURE__ */ jsx(AttentionBadge, { state })
    ] });
  }
  function RoomRow({ room, selected, bots, onSelect }) {
    const faces = room.members.slice(0, 2);
    return /* @__PURE__ */ jsxs("button", { type: "button", "aria-current": selected || void 0, onClick: () => onSelect?.(room), className: "lb-contact", children: [
      /* @__PURE__ */ jsx("span", { style: { minWidth: 40, display: "inline-flex", justifyContent: "center", flexShrink: 0 }, children: /* @__PURE__ */ jsx(AvatarStack, { size: 24, max: 2, ring: "var(--color-card)", faces: faces.map((m) => {
        const b = bots.find((x) => x.name === m.bot);
        return { key: m.member_id || m.bot, name: m.display_name || m.handle, avatar: displayFace(m.bot, m.avatar ?? b?.display?.avatar), color: m.color ?? b?.display?.color };
      }) }) }),
      /* @__PURE__ */ jsxs("span", { className: "lb-row-stack", children: [
        /* @__PURE__ */ jsx("span", { className: "lb-headline lb-truncate", children: room.name }),
        room.goal && /* @__PURE__ */ jsx("span", { className: "lb-subhead lb-truncate", children: room.goal })
      ] }),
      room.driver.running && /* @__PURE__ */ jsx(AttentionBadge, { state: "working" })
    ] });
  }
  function ContactList({
    bots,
    rooms = [],
    loading: loading2 = false,
    error = null,
    isOffline = false,
    selectedBotName = null,
    selectedRoomId = null,
    pendingByBot = {},
    onSelectBot,
    onSelectRoom,
    onOpenCreate,
    onOpenCreateRoom,
    onRetry
  }) {
    const { t } = useLuveI18n();
    const [showHidden, setShowHidden] = react_default.useState(false);
    const visible = bots.filter((b) => !b.display?.hidden);
    const hidden = bots.filter((b) => b.display?.hidden);
    const ready = !loading2 && !error;
    return /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", padding: "0 6px 12px" }, children: [
      /* @__PURE__ */ jsxs("div", { className: "lb-section-label", children: [
        /* @__PURE__ */ jsx("span", { children: t("sectionBots") }),
        /* @__PURE__ */ jsx("button", { type: "button", onClick: onOpenCreate, "aria-label": t("newBot"), title: t("newBot"), className: "lb-icon-btn", children: /* @__PURE__ */ jsx(PlusIcon, { size: 16 }) })
      ] }),
      isOffline && /* @__PURE__ */ jsxs("div", { role: "status", style: notice("var(--color-warning)"), children: [
        /* @__PURE__ */ jsx("strong", { children: t("offlineHeader") }),
        /* @__PURE__ */ jsx("span", { style: { color: "var(--color-muted-foreground)" }, children: t("offlineSub") }),
        onRetry && /* @__PURE__ */ jsx("button", { type: "button", onClick: onRetry, style: linkBtn, children: t("reconnectNow") })
      ] }),
      error && !isOffline && /* @__PURE__ */ jsxs("div", { role: "alert", style: notice("var(--color-destructive)"), children: [
        /* @__PURE__ */ jsx("strong", { children: t("errorLoadingBots") }),
        /* @__PURE__ */ jsx("span", { className: "lb-truncate", style: { color: "var(--color-muted-foreground)" }, title: error, children: error }),
        onRetry && /* @__PURE__ */ jsx("button", { type: "button", onClick: onRetry, style: linkBtn, children: t("retry") })
      ] }),
      loading2 && !error && /* @__PURE__ */ jsx("div", { "aria-busy": "true", "aria-label": t("loadingBots"), style: { display: "flex", flexDirection: "column", gap: 4 }, children: [0, 1, 2].map((k) => /* @__PURE__ */ jsxs("div", { className: "lb-contact", style: { cursor: "default" }, children: [
        /* @__PURE__ */ jsx("span", { style: { width: 40, height: 40, borderRadius: "36%", background: "var(--color-muted)" } }),
        /* @__PURE__ */ jsx("span", { style: { flex: 1, height: 12, borderRadius: 6, background: "var(--color-muted)" } })
      ] }, k)) }),
      ready && !isOffline && bots.length === 0 && /* @__PURE__ */ jsxs("div", { "data-testid": "bots-empty-state", style: { padding: "6px 10px", display: "flex", flexDirection: "column", gap: 4 }, children: [
        /* @__PURE__ */ jsx("span", { className: "lb-subhead", children: t("emptyBots") }),
        onOpenCreate && /* @__PURE__ */ jsxs("button", { type: "button", onClick: onOpenCreate, style: { ...linkBtn, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600 }, children: [
          /* @__PURE__ */ jsx(PlusIcon, { size: 12 }),
          /* @__PURE__ */ jsx("span", { children: t("createFirstBot") })
        ] })
      ] }),
      ready && visible.map((bot) => /* @__PURE__ */ jsx(BotRow, { bot, selected: selectedBotName === bot.name, pending: pendingByBot[bot.name] ?? 0, onSelect: onSelectBot }, bot.name)),
      /* @__PURE__ */ jsxs("div", { className: "lb-section-label", children: [
        /* @__PURE__ */ jsx("span", { children: t("sectionSalas") }),
        /* @__PURE__ */ jsx("button", { type: "button", onClick: onOpenCreateRoom, "aria-label": t("newSala"), title: t("newSala"), className: "lb-icon-btn", children: /* @__PURE__ */ jsx(PlusIcon, { size: 16 }) })
      ] }),
      rooms.length === 0 ? /* @__PURE__ */ jsx("span", { className: "lb-subhead", style: { padding: "6px 10px" }, children: t("emptySalas") }) : rooms.map((room) => /* @__PURE__ */ jsx(RoomRow, { room, bots, selected: selectedRoomId === room.id && !selectedBotName, onSelect: onSelectRoom }, room.id)),
      ready && hidden.length > 0 && /* @__PURE__ */ jsxs(Fragment2, { children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            "aria-expanded": showHidden,
            onClick: () => setShowHidden(!showHidden),
            className: "lb-section-label",
            style: { border: "none", background: "none", cursor: "pointer", width: "100%", minHeight: 44 },
            children: /* @__PURE__ */ jsxs("span", { children: [
              t("sectionOcultos"),
              " (",
              hidden.length,
              ")"
            ] })
          }
        ),
        showHidden && hidden.map((bot) => /* @__PURE__ */ jsx(BotRow, { bot, selected: selectedBotName === bot.name, pending: pendingByBot[bot.name] ?? 0, onSelect: onSelectBot }, bot.name))
      ] })
    ] });
  }

  // dashboard/src/components/messenger/shortcuts.ts
  var G_WINDOW_MS = 1500;
  function shortcutFor(k, gArmedAt, now) {
    const mod = k.metaKey || k.ctrlKey;
    const key = k.key.length === 1 ? k.key.toLowerCase() : k.key;
    if (mod && !k.altKey) {
      if (key === "k") return { type: "search" };
      if (key === "i") return { type: "composer" };
      if (k.editable) return null;
      if (key === "n") return k.shiftKey ? { type: "newRoom" } : { type: "newBot" };
      if (key === "b" && !k.shiftKey) return { type: "toggleSidebar" };
      if (/^[1-9]$/.test(key) && !k.shiftKey) return { type: "bot", index: Number(key) - 1 };
      return null;
    }
    if (k.editable) return null;
    if (k.altKey && !mod && !k.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) return { type: "step", delta: key === "ArrowUp" ? -1 : 1 };
    if (!mod && !k.altKey && !k.shiftKey) {
      if (key === "a" && gArmedAt !== null && now - gArmedAt <= G_WINDOW_MS) return { type: "approvals" };
      if (key === "g") return { type: "armG" };
    }
    return null;
  }
  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
  }
  function botAt(list, selected, a) {
    if (!list.length) return null;
    if (a.type === "bot") return list[a.index] ?? null;
    const i = list.findIndex((b) => b.name === selected);
    if (i < 0) return a.delta > 0 ? list[0] : list[list.length - 1];
    return list[(i + a.delta + list.length) % list.length];
  }

  // dashboard/src/hooks/useHost.ts
  var SCHEME_KEY = "luvebot.scheme";
  function readPref() {
    try {
      const v = window.localStorage.getItem(SCHEME_KEY);
      return v === "light" || v === "dark" ? v : "auto";
    } catch {
      return "auto";
    }
  }
  var systemDark = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  function useScheme() {
    const [pref, setPrefState] = react_default.useState(() => typeof window === "undefined" ? "auto" : readPref());
    const [dark, setDark] = react_default.useState(systemDark);
    react_default.useEffect(() => {
      const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
      const on = () => setDark(!!mq?.matches);
      mq?.addEventListener?.("change", on);
      return () => mq?.removeEventListener?.("change", on);
    }, []);
    const setPref = react_default.useCallback((p) => {
      setPrefState(p);
      try {
        if (p === "auto") window.localStorage.removeItem(SCHEME_KEY);
        else window.localStorage.setItem(SCHEME_KEY, p);
      } catch {
      }
    }, []);
    const scheme = pref === "auto" ? dark ? "dark" : "light" : pref;
    return { scheme, pref, setPref };
  }
  function navigateHost(path) {
    window.history.pushState(null, "", path + window.location.search);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  // dashboard/src/components/messenger/phoneBar.tsx
  var PhoneBarContext = react_default.createContext(null);
  function usePhoneBar() {
    const bar = react_default.useContext(PhoneBarContext);
    const claim = bar?.claim;
    react_default.useLayoutEffect(() => claim?.(), [claim]);
    return bar;
  }

  // dashboard/src/components/ui/ThemePicker.tsx
  var OPTIONS = [["auto", "themeAuto"], ["light", "themeLight"], ["dark", "themeDark"]];
  function ThemePicker({ pref, onChange, className, placement = "right" }) {
    const { t } = useLuveI18n();
    const [open, setOpen] = react_default.useState(false);
    const button = react_default.useRef(null);
    const group = react_default.useRef(null);
    const id = react_default.useId();
    const current = OPTIONS.find(([p]) => p === pref);
    const label = `${t("themeLabel")}: ${t(current[1])}`;
    react_default.useEffect(() => {
      if (!open) return;
      group.current?.querySelector('[aria-checked="true"]')?.focus();
      const away = (e) => {
        if (!group.current?.contains(e.target) && !button.current?.contains(e.target)) setOpen(false);
      };
      document.addEventListener("pointerdown", away);
      return () => document.removeEventListener("pointerdown", away);
    }, [open]);
    const close = () => {
      setOpen(false);
      button.current?.focus();
    };
    const onKey = (e) => {
      const at = OPTIONS.findIndex(([p]) => p === pref);
      const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (!step) return;
      e.preventDefault();
      const next = OPTIONS[(at + step + OPTIONS.length) % OPTIONS.length][0];
      onChange(next);
      requestAnimationFrame(() => group.current?.querySelector(`[data-pref="${next}"]`)?.focus());
    };
    return /* @__PURE__ */ jsxs("span", { style: { position: "relative", display: "inline-flex" }, children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          ref: button,
          type: "button",
          className,
          "aria-label": label,
          title: label,
          "aria-haspopup": "true",
          "aria-expanded": open,
          "aria-controls": open ? id : void 0,
          onClick: () => setOpen((o) => !o),
          children: /* @__PURE__ */ jsx(ContrastIcon, { size: 20 })
        }
      ),
      open && /* @__PURE__ */ jsx("div", { ref: group, id, role: "radiogroup", "aria-label": t("themeLabel"), className: `lb-theme-pop lb-theme-pop-${placement}`, onKeyDown: onKey, children: OPTIONS.map(([p, key]) => /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          role: "radio",
          "aria-checked": pref === p,
          "data-pref": p,
          tabIndex: pref === p ? 0 : -1,
          className: "lb-msg-menu-item",
          onClick: () => {
            onChange(p);
            close();
          },
          children: [
            /* @__PURE__ */ jsx("span", { className: "lb-headline", children: t(key) }),
            p === "auto" && /* @__PURE__ */ jsx("span", { className: "lb-caption", children: t("themeAutoHint") })
          ]
        },
        p
      )) })
    ] });
  }

  // dashboard/src/components/messenger/MessengerShell.tsx
  function MessengerShell({
    children,
    bots = [],
    botsLoading = false,
    botsError = null,
    isOffline = false,
    selectedBotName = null,
    onSelectBot,
    onOpenCreateBot,
    onRetryBots,
    rooms = [],
    selectedRoomId = null,
    onSelectRoom,
    onOpenCreateRoom,
    activeTab: controlledTab,
    onTabChange,
    approvalsCount,
    pendingByBot,
    onOpenSearch,
    onBack,
    modals,
    restartRequired = false
  }) {
    const { locale, t, setLocale } = useLuveI18n();
    const narrow = useNarrow();
    const { scheme, pref, setPref } = useScheme();
    const [ownTab, setOwnTab] = react_default.useState("hoje");
    const [phoneMain, setPhoneMain] = react_default.useState(false);
    const activeTab = controlledTab ?? ownTab;
    const [sidebarHidden, setSidebarHidden] = react_default.useState(false);
    const [barClaims, setBarClaims] = react_default.useState(0);
    const claimBar = react_default.useCallback(() => {
      setBarClaims((n) => n + 1);
      return () => setBarClaims((n) => n - 1);
    }, []);
    const goTab = (id) => {
      onTabChange ? onTabChange(id) : setOwnTab(id);
      setPhoneMain(true);
    };
    const latest = react_default.useRef({ bots, selectedBotName, onSelectBot, onOpenCreateBot, onOpenCreateRoom, onOpenSearch, goTab, narrow });
    latest.current = { bots, selectedBotName, onSelectBot, onOpenCreateBot, onOpenCreateRoom, onOpenSearch, goTab, narrow };
    const gArmedAt = react_default.useRef(null);
    react_default.useEffect(() => {
      const onKey = (e) => {
        const now = Date.now();
        const a = shortcutFor({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, editable: isEditable(document.activeElement) }, gArmedAt.current, now);
        if (!["Shift", "Meta", "Control", "Alt"].includes(e.key)) gArmedAt.current = a?.type === "armG" ? now : null;
        if (!a) return;
        const L = latest.current;
        const run = (f) => {
          if (f) {
            e.preventDefault();
            f();
          }
        };
        switch (a.type) {
          case "search":
            return run(L.onOpenSearch);
          case "newBot":
            return run(L.onOpenCreateBot);
          case "newRoom":
            return run(L.onOpenCreateRoom);
          case "toggleSidebar":
            return run(L.narrow ? void 0 : () => setSidebarHidden((h) => !h));
          case "composer": {
            const box3 = document.querySelector("main form textarea");
            return run(box3 ? () => box3.focus() : void 0);
          }
          case "bot":
          case "step": {
            const target = botAt(L.bots.filter((b) => !b.display?.hidden), L.selectedBotName, a);
            const select = L.onSelectBot;
            return run(target && select ? () => select(target) : void 0);
          }
          case "approvals":
            return run(() => L.goTab("aprovacoes"));
          case "armG":
            return;
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, []);
    const items = [
      { id: "hoje", label: t("navHoje"), icon: SunIcon },
      { id: "aprovacoes", label: t("navAprovacoes"), icon: CheckCircleIcon, badge: approvalsCount },
      { id: "atividade", label: t("navAtividade"), icon: ClockIcon },
      { id: "mapa", label: t("navMapa"), icon: NetworkIcon }
      // the CEO did not find it in ⌘K alone: a fixed place (⌘K keeps it too)
    ];
    const inConversation = !!(selectedBotName || selectedRoomId);
    const showMain = !narrow || inConversation || phoneMain;
    const showList = !narrow || !showMain;
    const railButton = (key, label, Icon, active, onClick, badge, extra = {}) => /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        className: "lb-rail-btn",
        "aria-current": active ? "page" : void 0,
        onClick,
        ...extra,
        "aria-label": narrow ? void 0 : badge ? `${label} (${badge})` : label,
        title: narrow ? void 0 : label,
        children: [
          /* @__PURE__ */ jsx(Icon, { size: 20 }),
          narrow && /* @__PURE__ */ jsx("span", { children: label }),
          badge !== void 0 && badge > 0 && /* @__PURE__ */ jsx("span", { "aria-hidden": narrow ? void 0 : "true", style: { position: "absolute", top: 2, right: narrow ? 8 : 2, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, font: "600 12px/16px var(--lb-font)", background: "var(--color-destructive)", color: "var(--color-destructive-foreground)" }, children: badge })
        ]
      },
      key
    );
    const tabButton = (it) => railButton(it.id, it.label, it.icon, activeTab === it.id && !inConversation, () => goTab(it.id), it.badge);
    const searchBtn = railButton("search", t("navSearch"), SearchIcon, false, () => onOpenSearch?.(), void 0, { "aria-keyshortcuts": "Meta+K Control+K" });
    const hermesLink = /* @__PURE__ */ jsxs(
      "a",
      {
        href: "/sessions" + (typeof window === "undefined" ? "" : window.location.search),
        className: narrow ? "lb-host-btn" : "lb-rail-btn",
        "aria-label": narrow ? void 0 : t("hermesPanel"),
        title: narrow ? void 0 : t("hermesPanel"),
        onClick: (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          navigateHost("/sessions");
        },
        children: [
          /* @__PURE__ */ jsx(ExitIcon, { size: 20 }),
          narrow && /* @__PURE__ */ jsx("span", { children: t("hermesPanel") })
        ]
      }
    );
    const backBtn = /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        "aria-label": t("backToList"),
        onClick: () => {
          setPhoneMain(false);
          onBack?.();
        },
        style: { minWidth: 44, minHeight: 44, border: "none", background: "none", color: "var(--color-foreground)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", transform: "scaleX(-1)", flexShrink: 0 },
        children: /* @__PURE__ */ jsx(ArrowRightIcon, { size: 20 })
      }
    );
    const hermesIcon = /* @__PURE__ */ jsx(
      "a",
      {
        href: "/sessions" + (typeof window === "undefined" ? "" : window.location.search),
        className: "lb-icon-btn",
        "aria-label": t("hermesPanel"),
        title: t("hermesPanel"),
        onClick: (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          navigateHost("/sessions");
        },
        children: /* @__PURE__ */ jsx(ExitIcon, { size: 20 })
      }
    );
    const phoneBar = narrow ? { back: backBtn, hermes: hermesIcon, claim: claimBar } : null;
    const settingsBtn = railButton("config", t("navConfig"), SettingsIcon, activeTab === "config" && !inConversation, () => goTab("config"));
    const rail = narrow ? /* @__PURE__ */ jsxs("nav", { "aria-label": t("navSectionMain"), className: "lb-tabbar", style: { display: "flex", justifyContent: "space-around", borderTop: "1px solid var(--lb-separator)", background: "var(--color-card)", padding: "4px 4px calc(4px + env(safe-area-inset-bottom))" }, children: [
      items.map(tabButton),
      searchBtn,
      settingsBtn
    ] }) : /* @__PURE__ */ jsxs("nav", { "aria-label": t("navSectionMain"), style: { width: 64, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "14px 0", borderRight: "1px solid var(--lb-separator)", background: "var(--color-card)" }, children: [
      items.map(tabButton),
      searchBtn,
      /* @__PURE__ */ jsx("div", { style: { flex: 1 } }),
      hermesLink,
      /* @__PURE__ */ jsx(ThemePicker, { pref, onChange: setPref, className: "lb-rail-btn" }),
      settingsBtn,
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          className: "lb-rail-btn",
          onClick: () => setLocale(locale === "pt" ? "en" : "pt"),
          "aria-label": t("toggleLanguage"),
          title: locale === "pt" ? t("langEnglish") : t("langPortuguese"),
          style: { font: "600 12px/16px var(--lb-font)" },
          children: locale.toUpperCase()
        }
      )
    ] });
    return /* @__PURE__ */ jsxs("div", { className: "lb-root", "data-lb-scheme": scheme, style: { display: "flex", flexDirection: narrow ? "column" : "row", width: "100%", overflow: "hidden", background: "var(--color-background)", color: "var(--color-foreground)" }, children: [
      !narrow && rail,
      showList && !(sidebarHidden && !narrow) && /* @__PURE__ */ jsxs("aside", { "aria-label": "sidebar", style: { width: narrow ? "100%" : 300, flex: narrow ? 1 : void 0, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", borderRight: narrow ? void 0 : "1px solid var(--lb-separator)", background: "var(--color-card)" }, children: [
        /* @__PURE__ */ jsxs("div", { style: { padding: "16px 16px 6px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }, children: [
          /* @__PURE__ */ jsx(Wordmark, { scheme }),
          narrow && /* @__PURE__ */ jsxs("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 }, children: [
            /* @__PURE__ */ jsx(ThemePicker, { pref, onChange: setPref, className: "lb-icon-btn", placement: "below" }),
            hermesLink
          ] })
        ] }),
        restartRequired && !showMain && /* @__PURE__ */ jsx(RestartNotice, {}),
        /* @__PURE__ */ jsx("div", { className: "luvebot-scroll-container", style: { flex: 1, minHeight: 0 }, children: /* @__PURE__ */ jsx(
          ContactList,
          {
            bots,
            rooms,
            loading: botsLoading,
            error: botsError,
            isOffline,
            selectedBotName,
            selectedRoomId,
            pendingByBot,
            onSelectBot,
            onSelectRoom,
            onOpenCreate: onOpenCreateBot,
            onOpenCreateRoom,
            onRetry: onRetryBots
          }
        ) })
      ] }),
      showMain && /* @__PURE__ */ jsxs("main", { style: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--color-background)" }, children: [
        narrow && barClaims === 0 && /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", borderBottom: "1px solid var(--color-border)" }, children: [
          backBtn,
          /* @__PURE__ */ jsx("span", { style: { flex: 1 } }),
          hermesLink
        ] }),
        restartRequired && /* @__PURE__ */ jsx(RestartNotice, {}),
        isOffline && /* @__PURE__ */ jsxs("div", { role: "status", "data-testid": "pwa-offline-notice", style: { padding: "10px 16px", fontSize: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", background: "color-mix(in srgb, var(--color-warning) 12%, transparent)" }, children: [
          /* @__PURE__ */ jsxs("strong", { children: [
            t("pwaOfflineNoticeHeader"),
            ":"
          ] }),
          /* @__PURE__ */ jsx("span", { children: t("pwaOfflineNoticeBody") }),
          onRetryBots && /* @__PURE__ */ jsx("button", { type: "button", onClick: onRetryBots, style: { minHeight: 44, border: "none", background: "none", textDecoration: "underline", color: "inherit", cursor: "pointer" }, children: t("reconnectNow") })
        ] }),
        /* @__PURE__ */ jsx(PhoneBarContext.Provider, { value: phoneBar, children: /* @__PURE__ */ jsx("div", { className: "luvebot-scroll-container", style: { flex: 1, minHeight: 0 }, children }) })
      ] }),
      narrow && !inConversation && rail,
      modals
    ] });
  }
  function RestartNotice() {
    const { t } = useLuveI18n();
    return /* @__PURE__ */ jsx(
      "div",
      {
        role: "status",
        "data-testid": "restart-notice",
        className: "lb-caption",
        style: { padding: "8px 16px", display: "flex", gap: 8, alignItems: "center", color: "var(--color-foreground)", background: "color-mix(in srgb, var(--color-primary) 10%, transparent)", borderBottom: "1px solid var(--lb-separator)" },
        children: t("restartNotice")
      }
    );
  }

  // dashboard/src/components/approvals/humanize.ts
  var SYNTHETIC = /^<([A-Za-z0-9_.:-]{1,64})> \(plugin approval rule\)$/;
  var RAW = /^luvebot:/;
  var TOOLS = {
    terminal: "toolTerminal",
    write_file: "toolWriteFile",
    read_file: "toolReadFile",
    patch: "toolPatch",
    web_search: "toolWebSearch",
    web_extract: "toolWebExtract",
    browser_navigate: "toolBrowser",
    send_message: "toolSendMessage"
  };
  function ruleIdOf(f) {
    if (f.ruleId) return f.ruleId;
    const m = (f.patternKey ?? "").match(/(?:^|:)luvebot:([^#\s]+)#/) ?? (f.description ?? "").match(/^luvebot:(?:channel_block:[^:]+:)?([^:\s]+)$/);
    return m ? m[1] : null;
  }
  function toolOf(f) {
    return f.tool || (f.command ?? "").match(SYNTHETIC)?.[1] || null;
  }
  function humanApproval(f, ruleLabel, t) {
    const rule = ruleIdOf(f);
    const tool = toolOf(f);
    const label = rule && rule !== "noncanonical" ? ruleLabel(rule) : void 0;
    const plainDescription = f.description && !RAW.test(f.description) ? f.description : null;
    const title = rule === "noncanonical" ? t("approvalRuleNoncanonical") : label ? t("approvalRuleNamed", { label }) : plainDescription ?? (rule ? t("approvalRuleUnknown") : t("defaultActionLabel"));
    const command = f.command && !SYNTHETIC.test(f.command) ? f.command : null;
    const preview = f.commandRedacted || command || null;
    const technical = [f.description, f.command, f.patternKey, rule].filter((x, i, all) => !!x && all.indexOf(x) === i).filter((x) => x !== title && x !== preview);
    return { title, tool: tool ? TOOLS[tool] ? t(TOOLS[tool]) : tool : null, preview, technical };
  }
  function approvalTitle(a, ruleLabel, t) {
    return humanApproval({ description: a.description, commandRedacted: a.command_redacted, patternKey: a.pattern_keys?.[0], tool: a.tool, ruleId: a.rule_id }, ruleLabel, t).title;
  }
  var labels = null;
  var readLabels = () => getRules().then((r) => new Map((r?.rules ?? []).map((x) => [x.rule.id, x.rule.label]))).catch(() => {
    labels = null;
    return /* @__PURE__ */ new Map();
  });
  function useRuleLabels(enabled = true, want) {
    const [map, setMap] = react_default.useState(/* @__PURE__ */ new Map());
    react_default.useEffect(() => {
      if (!enabled) return;
      let alive = true;
      labels ??= readLabels();
      void labels.then((m) => {
        if (want && want !== "noncanonical" && !m.has(want)) labels = readLabels().then((fresh) => fresh);
        return labels;
      }).then((m) => {
        if (alive) setMap(m);
      });
      return () => {
        alive = false;
      };
    }, [enabled, want]);
    return react_default.useCallback((id) => map.get(id), [map]);
  }

  // dashboard/src/components/labels.ts
  var HANDOFF = {
    triage: "handoffStateTriage",
    ready: "handoffStateReady",
    running: "handoffStateRunning",
    blocked: "handoffStateBlocked",
    review: "handoffStateReview",
    done: "handoffStateDone",
    cancelled: "handoffStateCancelled"
  };
  var BOT = {
    idle: "statusIdleLabel",
    working: "statusWorkingLabel",
    waiting_approval: "statusNeedsYouLabel",
    paused: "statusPausedLabel",
    error: "statusErrorLabel",
    offline: "statusOfflineLabel"
  };
  var SUBAGENT = { running: "statusWorking", completed: "statusCompleted", failed: "statusFailed", timeout: "subagentTimeout", unknown: "subagentUnknown", background: "subagentBackground", background_late: "subagentBackgroundLate" };
  var APPROVAL = {
    pending: "approvalStatePending",
    decided: "approvalStateDecided",
    consumed: "approvalStateConsumed",
    expired: "approvalStateExpired",
    stale: "approvalStateStale"
  };
  var DECISION = { once: "approvalDecidedOnce", deny: "approvalDecidedDeny" };
  var CHOICE = { once: "approvalChoiceOnce", session: "approvalChoiceSession", always: "approvalChoiceAlways", deny: "approvalChoiceDeny" };
  var ROUTINE_RUN = { success: "statusSuccess", error: "statusError", running: "routineRunRunning" };
  var pick = (table) => (code2, t) => code2 && Object.prototype.hasOwnProperty.call(table, code2) ? t(table[code2]) : code2 ?? "";
  var handoffStateLabel = pick(HANDOFF);
  var botStatusLabel = pick(BOT);
  var subagentStatusLabel = pick(SUBAGENT);
  var approvalStateLabel = pick(APPROVAL);
  var approvalDecisionLabel = pick(DECISION);
  var routineRunStatusLabel = pick(ROUTINE_RUN);
  var approvalChoiceLabel = pick(CHOICE);
  var UNTITLED = {
    run: "activityRunTitle",
    routine_run: "activityRoutineRunTitle",
    routine_due: "activityRoutineDueTitle",
    task: "activityTaskTitle"
  };
  function activityTitle(item2, t) {
    const key = UNTITLED[item2.kind];
    const legacy = item2.title === "Conversation run" || item2.title === "Routine" || item2.title === "Task" || item2.kind === "routine_run" && !!item2.links?.job_id && item2.title === `Routine ${item2.links.job_id}`;
    if (key && (!item2.title || legacy)) return t(key);
    return item2.title ?? "";
  }

  // dashboard/src/hooks/useFocusTrap.ts
  var FOCUSABLE_ELEMENTS_SELECTOR = [
    "button:not([disabled])",
    "[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])"
  ].join(", ");
  function useFocusTrap({
    isOpen,
    onClose,
    disableTrap = false,
    initialFocusRef
  }) {
    const containerRef = useRef(null);
    const triggerElementRef = useRef(null);
    useEffect(() => {
      if (!isOpen) {
        if (triggerElementRef.current && typeof triggerElementRef.current.focus === "function") {
          triggerElementRef.current.focus();
        }
        return;
      }
      if (document.activeElement instanceof HTMLElement) {
        triggerElementRef.current = document.activeElement;
      }
      const container = containerRef.current;
      if (container) {
        if (initialFocusRef?.current) {
          initialFocusRef.current.focus();
        } else {
          const focusables = Array.from(
            container.querySelectorAll(FOCUSABLE_ELEMENTS_SELECTOR)
          );
          if (focusables.length > 0) {
            focusables[0].focus();
          } else {
            container.focus();
          }
        }
      }
      if (disableTrap) return;
      const handleKeyDown = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose?.();
          return;
        }
        if (e.key === "Tab") {
          const currentContainer = containerRef.current;
          if (!currentContainer) return;
          const focusables = Array.from(
            currentContainer.querySelectorAll(FOCUSABLE_ELEMENTS_SELECTOR)
          ).filter(
            (el) => !el.hasAttribute("disabled") && el.getAttribute("tabindex") !== "-1"
          );
          if (focusables.length === 0) {
            e.preventDefault();
            return;
          }
          const firstElement = focusables[0];
          const lastElement = focusables[focusables.length - 1];
          if (e.shiftKey) {
            if (document.activeElement === firstElement || !currentContainer.contains(document.activeElement)) {
              e.preventDefault();
              lastElement.focus();
            }
          } else {
            if (document.activeElement === lastElement || !currentContainer.contains(document.activeElement)) {
              e.preventDefault();
              firstElement.focus();
            }
          }
        }
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => {
        window.removeEventListener("keydown", handleKeyDown);
      };
    }, [isOpen, onClose, disableTrap, initialFocusRef]);
    return containerRef;
  }

  // dashboard/src/components/ui/ErrorNote.tsx
  var GENERAL = {
    hermes_unreachable: "errHermesUnreachable",
    hermes_error: "errHermesError",
    hermes_timeout: "errHermesTimeout",
    hermes_status_unverified: "errHermesUnverified",
    csrf_required: "errCsrf",
    unauthenticated: "errUnauthenticated",
    unauthorized: "errUnauthenticated",
    rate_limited: "errRateLimited",
    bad_request: "errInvalid",
    invalid_field: "errInvalid",
    invalid_name: "errInvalid",
    capability_missing: "errCapabilityMissing",
    not_supported: "errCapabilityMissing",
    not_implemented: "errNotImplemented",
    bot_not_found: "errBotNotFound",
    bot_paused: "errBotPaused",
    bot_offline: "errBotOffline",
    budget_exceeded: "errBudgetExceeded",
    too_large: "errTooLarge",
    conflict: "errConflict",
    stale: "errConflict",
    loopback_not_human: "errLoopback",
    audit_unavailable: "errAuditUnavailable",
    sdk_unavailable: "errSdkUnavailable",
    plugin_route_missing: "errRouteMissing",
    bot_exists: "errBotExists",
    duplicate: "errDuplicate",
    run_not_found: "errRunNotFound",
    session_not_found: "errSessionNotFound"
  };
  function humanError(e, t, fallback) {
    if (!(e instanceof ApiError)) return { text: t(fallback), code: null };
    return { text: t(GENERAL[e.code] ?? fallback), code: e.code || null };
  }
  function humanCode(code2, t, fallback) {
    return { text: t(code2 && GENERAL[code2] || fallback), code: code2 || null };
  }
  function ErrorNote({ error }) {
    const { t } = useLuveI18n();
    const [open, setOpen] = react_default.useState(false);
    if (!error) return null;
    if (typeof error === "string") return /* @__PURE__ */ jsx(Fragment2, { children: error });
    return /* @__PURE__ */ jsxs(Fragment2, { children: [
      error.text,
      error.code && /* @__PURE__ */ jsxs(Fragment2, { children: [
        " ",
        /* @__PURE__ */ jsx("button", { type: "button", className: "lb-error-more", "aria-expanded": open, onClick: () => setOpen((o) => !o), children: t("errTechnical") }),
        open && /* @__PURE__ */ jsx("code", { className: "lb-error-code", children: error.code })
      ] })
    ] });
  }

  // dashboard/src/components/costs/CostsView.tsx
  function formatCents(cents, locale) {
    const dollars = cents / 100;
    return dollars.toLocaleString(locale === "pt" ? "pt-BR" : "en-US", {
      style: "currency",
      currency: "USD"
    });
  }
  function CostsView({
    bots = [],
    authMode: controlledAuthMode,
    initialCosts,
    initialBudget,
    onRefresh
  }) {
    const { locale, t } = useLuveI18n();
    const [authMode, setAuthMode] = useState(
      controlledAuthMode || "gated"
    );
    const [activeTab, setActiveTab] = useState(
      "overview"
    );
    const [period, setPeriod] = useState("day");
    const [group, setGroup] = useState("bot");
    const botLabel = (name) => bots.find((b) => b.name === name)?.display?.label || name;
    const [selectedBotFilter, setSelectedBotFilter] = useState("");
    const [costsData, setCostsData] = useState(
      initialCosts || null
    );
    const [budgetData, setBudgetData] = useState(
      initialBudget || null
    );
    const [loadingCosts, setLoadingCosts] = useState(!initialCosts);
    const [loadingBudget, setLoadingBudget] = useState(!initialBudget);
    const [costsError, setCostsError] = useState(null);
    const [budgetError, setBudgetError] = useState(null);
    const [actionSuccess, setActionSuccess] = useState(null);
    const [actionError, setActionError] = useState(null);
    const [limitModalOpen, setLimitModalOpen] = useState(false);
    const [editingLimit, setEditingLimit] = useState(null);
    const [limitScope, setLimitScope] = useState("global");
    const [limitPeriod, setLimitPeriod] = useState("day");
    const [limitRef, setLimitRef] = useState("");
    const [limitDollarsInput, setLimitDollarsInput] = useState("");
    const [isSavingLimit, setIsSavingLimit] = useState(false);
    const [resumeModalOpen, setResumeModalOpen] = useState(false);
    const [botToResume, setBotToResume] = useState(null);
    const [isResuming, setIsResuming] = useState(false);
    const limitModalRef = useFocusTrap({
      isOpen: limitModalOpen,
      onClose: () => setLimitModalOpen(false)
    });
    const resumeModalRef = useFocusTrap({
      isOpen: resumeModalOpen && Boolean(botToResume),
      onClose: () => setResumeModalOpen(false)
    });
    const isLoopback = authMode === "loopback";
    useEffect(() => {
      if (!controlledAuthMode) {
        getSession().then((s) => {
          if (s?.auth_mode) setAuthMode(s.auth_mode);
        }).catch(() => {
        });
      }
    }, [controlledAuthMode]);
    const loadCosts = useCallback(async () => {
      try {
        setLoadingCosts(true);
        setCostsError(null);
        const res = await getCosts({
          period,
          group,
          bot: selectedBotFilter || void 0
        });
        setCostsData(res);
      } catch (err) {
        const msg = humanError(err, t, "errorLoadingCosts");
        setCostsError(msg);
      } finally {
        setLoadingCosts(false);
      }
    }, [period, group, selectedBotFilter, t]);
    const loadBudget = useCallback(async () => {
      try {
        setLoadingBudget(true);
        setBudgetError(null);
        const res = await getBudget();
        setBudgetData(res);
      } catch (err) {
        const msg = humanError(err, t, "errorLoadingBudget");
        setBudgetError(msg);
      } finally {
        setLoadingBudget(false);
      }
    }, [t]);
    useEffect(() => {
      if (!initialCosts) {
        loadCosts();
      }
    }, [loadCosts, initialCosts]);
    useEffect(() => {
      if (!initialBudget) {
        loadBudget();
      }
    }, [loadBudget, initialBudget]);
    const handleRefreshAll = () => {
      loadCosts();
      loadBudget();
      if (onRefresh) onRefresh();
    };
    const openEditLimitModal = (existing) => {
      setActionError(null);
      setActionSuccess(null);
      if (existing) {
        setEditingLimit(existing);
        setLimitScope(existing.scope);
        setLimitPeriod(existing.period);
        setLimitRef(existing.ref || "");
        setLimitDollarsInput((existing.cents / 100).toFixed(2));
      } else {
        setEditingLimit(null);
        setLimitScope("global");
        setLimitPeriod("day");
        setLimitRef("");
        setLimitDollarsInput("10.00");
      }
      setLimitModalOpen(true);
    };
    const parsedCents = useMemo(() => {
      const val = parseFloat(limitDollarsInput.replace(",", "."));
      if (isNaN(val) || val < 0) return null;
      return Math.round(val * 100);
    }, [limitDollarsInput]);
    const isRaiseInLoopback = useMemo(() => {
      if (!isLoopback) return false;
      if (!editingLimit) return true;
      if (parsedCents === null) return true;
      return parsedCents >= editingLimit.cents;
    }, [isLoopback, editingLimit, parsedCents]);
    const handleSaveLimit = async () => {
      if (parsedCents === null) return;
      if (isRaiseInLoopback) {
        setActionError(t("errorLoopbackBudgetRaiseBlocked"));
        return;
      }
      try {
        setIsSavingLimit(true);
        setActionError(null);
        await setBudgetLimit({
          scope: limitScope,
          ref: limitScope === "global" ? null : limitRef || null,
          period: limitPeriod,
          cents: parsedCents
        });
        setLimitModalOpen(false);
        await loadBudget();
      } catch (err) {
        const msg = humanError(err, t, "errorSavingLimit");
        setActionError(msg);
      } finally {
        setIsSavingLimit(false);
      }
    };
    const handleRemoveLimit = async () => {
      if (!editingLimit) return;
      if (isLoopback) {
        setActionError(t("errorLoopbackBudgetRaiseBlocked"));
        return;
      }
      try {
        setIsSavingLimit(true);
        setActionError(null);
        await setBudgetLimit({
          scope: editingLimit.scope,
          ref: editingLimit.ref || null,
          period: editingLimit.period,
          cents: null
        });
        setLimitModalOpen(false);
        await loadBudget();
      } catch (err) {
        const msg = humanError(err, t, "errorSavingLimit");
        setActionError(msg);
      } finally {
        setIsSavingLimit(false);
      }
    };
    const openResumeModal = (botName) => {
      if (isLoopback) {
        setActionError(t("errorLoopbackBudgetResumeBlocked"));
        return;
      }
      setBotToResume(botName);
      setResumeModalOpen(true);
    };
    const handleConfirmResumeBot = async () => {
      if (!botToResume) return;
      if (isLoopback) {
        setActionError(t("errorLoopbackBudgetResumeBlocked"));
        setResumeModalOpen(false);
        return;
      }
      try {
        setIsResuming(true);
        setActionError(null);
        await resumeBotBudget(botToResume);
        setResumeModalOpen(false);
        setBotToResume(null);
        setActionSuccess(t("botResumedSuccess"));
        await loadBudget();
      } catch (err) {
        const msg = humanError(err, t, "errorResumingBot");
        setActionError(msg);
      } finally {
        setIsResuming(false);
      }
    };
    const getPeriodKeyLabel = (p) => {
      switch (p) {
        case "day":
          return t("periodDay");
        case "7d":
          return t("period7d");
        case "month":
          return t("periodMonth");
        case "30d":
          return t("period30d");
      }
    };
    const pausedCount = budgetData?.paused?.length || 0;
    return /* @__PURE__ */ jsxs(
      "div",
      {
        "data-testid": "costs-view",
        className: "lb:flex lb:flex-col lb:h-full lb:w-full lb:overflow-y-auto lb:bg-[var(--background)] lb:text-[var(--color-foreground)]",
        children: [
          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:sm:flex-row lb:sm:items-center lb:justify-between lb:gap-3 lb:px-6 lb:pt-6 lb:pb-2", children: [
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-3", children: [
              /* @__PURE__ */ jsx("div", { className: "lb:p-2 lb:rounded-2xl lb:bg-[var(--color-primary)]/10 lb:text-[var(--color-primary)]", children: /* @__PURE__ */ jsx(DollarSignIcon, { size: 20 }) }),
              /* @__PURE__ */ jsxs("div", { children: [
                /* @__PURE__ */ jsx("h1", { className: "lb-title", children: t("costsTitle") }),
                /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("costsSubtitle") })
              ] })
            ] }),
            /* @__PURE__ */ jsx("div", { className: "lb:flex lb:items-center lb:gap-2", children: /* @__PURE__ */ jsxs(
              "button",
              {
                type: "button",
                "aria-label": t("refreshCostsAriaLabel"),
                onClick: handleRefreshAll,
                className: "lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:motion-safe:transition-colors lb:rounded-full",
                children: [
                  /* @__PURE__ */ jsx(RefreshCwIcon, { size: 13 }),
                  /* @__PURE__ */ jsx("span", { children: t("retry") })
                ]
              }
            ) })
          ] }),
          isLoopback && /* @__PURE__ */ jsxs(
            "div",
            {
              role: "alert",
              className: "lb:mx-4 lb:mt-4 lb:md:mx-6 lb:p-3.5 lb:rounded-2xl lb:border-[var(--color-warning)]/40 lb:bg-[var(--color-warning)]/10 lb:text-[var(--color-foreground)] lb:flex lb:items-start lb:gap-3",
              children: [
                /* @__PURE__ */ jsx("div", { className: "lb:text-[var(--color-warning)] lb:mt-0.5", children: /* @__PURE__ */ jsx(ShieldAlertIcon, { size: 16 }) }),
                /* @__PURE__ */ jsxs("div", { className: "lb:flex-1", children: [
                  /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                    /* @__PURE__ */ jsx("span", { className: "lb:text-[13px] lb:font-semibold lb:text-[var(--color-warning)]", children: t("loopbackBudgetWarningTitle") }),
                    /* @__PURE__ */ jsx(
                      "span",
                      {
                        "data-testid": "badge-loopback",
                        className: "lb:px-1.5 lb:py-0.2 lb:rounded-lg lb:text-xs lb:tabular-nums lb:bg-[var(--color-warning)]/20 lb:text-[var(--color-warning)]",
                        children: t("loopbackBadge")
                      }
                    )
                  ] }),
                  /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:mt-0.5", children: t("loopbackBudgetWarningDetail") })
                ] })
              ]
            }
          ),
          actionError && /* @__PURE__ */ jsxs(
            "div",
            {
              role: "alert",
              className: "lb:mx-4 lb:mt-4 lb:md:mx-6 lb:p-3 lb:rounded-xl lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:text-[13px] lb:text-[var(--color-destructive)] lb:flex lb:items-center lb:justify-between",
              children: [
                /* @__PURE__ */ jsx("span", { children: /* @__PURE__ */ jsx(ErrorNote, { error: actionError }) }),
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    "aria-label": t("close"),
                    onClick: () => setActionError(null),
                    children: /* @__PURE__ */ jsx(XIcon, { size: 14 })
                  }
                )
              ]
            }
          ),
          actionSuccess && /* @__PURE__ */ jsxs("div", { className: "lb:mx-4 lb:mt-4 lb:md:mx-6 lb:p-3 lb:rounded-xl lb:bg-[var(--color-success)]/10 lb:border-[var(--color-success)]/30 lb:text-[13px] lb:text-[var(--color-success)] lb:flex lb:items-center lb:justify-between", children: [
            /* @__PURE__ */ jsx("span", { children: actionSuccess }),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                "aria-label": t("close"),
                onClick: () => setActionSuccess(null),
                children: /* @__PURE__ */ jsx(XIcon, { size: 14 })
              }
            )
          ] }),
          budgetData?.watcher?.stale && /* @__PURE__ */ jsxs(
            "div",
            {
              role: "alert",
              className: "lb:mx-4 lb:mt-4 lb:md:mx-6 lb:p-3 lb:rounded-xl lb:bg-[var(--color-warning)]/15 lb:border-[var(--color-warning)]/40 lb:text-[13px] lb:text-[var(--color-warning)] lb:flex lb:items-center lb:gap-2",
              children: [
                /* @__PURE__ */ jsx(ShieldAlertIcon, { size: 14 }),
                /* @__PURE__ */ jsx("span", { children: t("ledgerStaleWarning") })
              ]
            }
          ),
          budgetData?.alerts && budgetData.alerts.length > 0 && /* @__PURE__ */ jsx("div", { className: "lb:mx-4 lb:mt-4 lb:md:mx-6 lb:space-y-2", children: budgetData.alerts.map((alert, idx) => /* @__PURE__ */ jsxs(
            "div",
            {
              role: "alert",
              className: `lb:p-2.5 lb:rounded-xl lb:text-[13px] lb:flex lb:items-center lb:gap-2 ${alert.percent >= 100 ? "lb:bg-[var(--color-destructive)]/15 lb:border-[var(--color-destructive)]/40 lb:text-[var(--color-destructive)]" : "lb:bg-[var(--color-warning)]/15 lb:border-[var(--color-warning)]/40 lb:text-[var(--color-warning)]"}`,
              children: [
                /* @__PURE__ */ jsx(ShieldAlertIcon, { size: 13 }),
                /* @__PURE__ */ jsx("span", { children: alert.percent >= 100 ? t("budgetAlertExceeded", {
                  percent: alert.percent,
                  scope: alert.scope === "global" ? t("ruleScopeGlobal") : alert.scope === "bot" ? botLabel(alert.ref || "") : alert.ref || ""
                }) : t("budgetAlertWarning", {
                  percent: alert.percent,
                  scope: alert.scope === "global" ? t("ruleScopeGlobal") : alert.scope === "bot" ? botLabel(alert.ref || "") : alert.ref || ""
                }) })
              ]
            },
            idx
          )) }),
          /* @__PURE__ */ jsxs("div", { className: "lb-segmented lb:mx-4 lb:md:mx-6 lb:mt-4 lb:shrink-0", style: { maxWidth: 520 }, children: [
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: () => setActiveTab("overview"),
                "aria-pressed": activeTab === "overview",
                className: "lb-segment",
                children: t("tabOverview")
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: () => setActiveTab("limits"),
                "aria-pressed": activeTab === "limits",
                className: "lb-segment",
                children: t("tabBudgetLimits")
              }
            ),
            /* @__PURE__ */ jsxs(
              "button",
              {
                type: "button",
                onClick: () => setActiveTab("paused"),
                "aria-pressed": activeTab === "paused",
                className: "lb-segment lb:inline-flex lb:items-center lb:justify-center lb:gap-1.5",
                children: [
                  /* @__PURE__ */ jsx("span", { children: t("tabPausedBots") }),
                  pausedCount > 0 && /* @__PURE__ */ jsx(
                    "span",
                    {
                      "data-testid": "paused-count-badge",
                      className: "lb:px-1.5 lb:py-0.2 lb:rounded-full lb:text-xs lb:font-bold lb:bg-[var(--color-destructive)] lb:text-white",
                      children: pausedCount
                    }
                  )
                ]
              }
            )
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "lb:p-4 lb:md:p-6 lb:space-y-6", children: [
            activeTab === "overview" && /* @__PURE__ */ jsxs("div", { className: "lb:space-y-5", children: [
              /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-wrap lb:items-center lb:gap-3 lb:p-3 lb:rounded-2xl lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)]", children: [
                /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-1.5", children: [
                  /* @__PURE__ */ jsx("span", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("periodLabel") }),
                  /* @__PURE__ */ jsxs(
                    "select",
                    {
                      "aria-label": t("filterPeriodAriaLabel"),
                      value: period,
                      onChange: (e) => setPeriod(e.target.value),
                      className: "lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)]",
                      children: [
                        /* @__PURE__ */ jsx("option", { value: "day", children: t("periodDay") }),
                        /* @__PURE__ */ jsx("option", { value: "7d", children: t("period7d") }),
                        /* @__PURE__ */ jsx("option", { value: "month", children: t("periodMonth") }),
                        /* @__PURE__ */ jsx("option", { value: "30d", children: t("period30d") })
                      ]
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-1.5", children: [
                  /* @__PURE__ */ jsx("span", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("groupLabel") }),
                  /* @__PURE__ */ jsxs(
                    "select",
                    {
                      "aria-label": t("filterGroupAriaLabel"),
                      value: group,
                      onChange: (e) => setGroup(e.target.value),
                      className: "lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)]",
                      children: [
                        /* @__PURE__ */ jsx("option", { value: "bot", children: t("groupBot") }),
                        /* @__PURE__ */ jsx("option", { value: "model", children: t("groupModel") }),
                        /* @__PURE__ */ jsx("option", { value: "routine", children: t("groupRoutine") }),
                        /* @__PURE__ */ jsx("option", { value: "day", children: t("groupDay") })
                      ]
                    }
                  )
                ] }),
                bots.length > 0 && /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-1.5", children: [
                  /* @__PURE__ */ jsx("span", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("filterBotLabel") }),
                  /* @__PURE__ */ jsxs(
                    "select",
                    {
                      "aria-label": t("filterBotAriaLabel"),
                      value: selectedBotFilter,
                      onChange: (e) => setSelectedBotFilter(e.target.value),
                      className: "lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)]",
                      children: [
                        /* @__PURE__ */ jsx("option", { value: "", children: t("allBotsOption") }),
                        bots.map((b) => /* @__PURE__ */ jsx("option", { value: b.name, children: b.display?.label || b.name }, b.name))
                      ]
                    }
                  )
                ] })
              ] }),
              loadingCosts && !costsData && /* @__PURE__ */ jsx("div", { className: "lb:p-8 lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("loadingBots") }),
              costsError && /* @__PURE__ */ jsx(
                "div",
                {
                  role: "alert",
                  className: "lb:p-4 lb:rounded-xl lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:text-[13px] lb:text-[var(--color-destructive)]",
                  children: /* @__PURE__ */ jsx(ErrorNote, { error: costsError })
                }
              ),
              costsData && /* @__PURE__ */ jsxs(Fragment2, { children: [
                /* @__PURE__ */ jsxs("div", { className: "lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:lg:grid-cols-3 lb:gap-3", children: [
                  /* @__PURE__ */ jsxs(
                    "div",
                    {
                      "data-testid": "total-spend-card",
                      className: "lb:p-4 lb:rounded-2xl lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:flex lb:flex-col lb:justify-between",
                      children: [
                        /* @__PURE__ */ jsx("span", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("totalSpendLabel", {
                          period: getPeriodKeyLabel(costsData.period)
                        }) }),
                        /* @__PURE__ */ jsx("div", { className: "lb:mt-2 lb:flex lb:items-baseline lb:gap-2", children: /* @__PURE__ */ jsx(
                          "span",
                          {
                            "data-testid": "total-spend-amount",
                            className: "lb:text-2xl lb:tabular-nums lb:font-bold lb:text-[var(--color-foreground)]",
                            children: formatCents(costsData.totals.spend_cents, locale)
                          }
                        ) }),
                        costsData.totals.unpriced_sessions > 0 && /* @__PURE__ */ jsxs("div", { className: "lb:mt-2 lb:text-xs lb:text-[var(--color-warning)] lb:flex lb:items-center lb:gap-1", children: [
                          /* @__PURE__ */ jsx(ShieldAlertIcon, { size: 12 }),
                          /* @__PURE__ */ jsx("span", { children: t("unpricedSessionsNotice", {
                            count: costsData.totals.unpriced_sessions
                          }) })
                        ] })
                      ]
                    }
                  ),
                  /* @__PURE__ */ jsxs(
                    "div",
                    {
                      "data-testid": "ledger-status-card",
                      className: "lb:p-4 lb:rounded-2xl lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:flex lb:flex-col lb:justify-between",
                      children: [
                        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between", children: [
                          /* @__PURE__ */ jsx("span", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("ledgerLagLabel") }),
                          /* @__PURE__ */ jsx(
                            "span",
                            {
                              "data-testid": "badge-ledger",
                              className: "lb:px-1.5 lb:py-0.2 lb:rounded-lg lb:text-xs lb:tabular-nums lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]",
                              children: t("ledgerBadge")
                            }
                          )
                        ] }),
                        /* @__PURE__ */ jsx("div", { className: "lb:mt-2", children: /* @__PURE__ */ jsx(
                          "span",
                          {
                            "data-testid": "ledger-lag-seconds",
                            className: "lb:text-xl lb:tabular-nums lb:font-semibold lb:text-[var(--color-foreground)]",
                            children: t("ledgerLagSeconds", {
                              seconds: costsData.ledger.lag_s
                            })
                          }
                        ) }),
                        costsData.ledger.watcher_stale ? /* @__PURE__ */ jsx("div", { className: "lb:mt-2 lb:text-xs lb:text-[var(--color-destructive)]", children: t("ledgerStaleWarning") }) : /* @__PURE__ */ jsxs("div", { className: "lb:mt-2 lb:text-xs lb:text-[var(--color-success)] lb:flex lb:items-center lb:gap-1", children: [
                          /* @__PURE__ */ jsx(CheckIcon, { size: 12 }),
                          /* @__PURE__ */ jsx("span", { children: t("activeBotsCount") })
                        ] })
                      ]
                    }
                  )
                ] }),
                /* @__PURE__ */ jsx("div", { className: "lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:overflow-hidden", children: /* @__PURE__ */ jsx("div", { className: "lb:overflow-x-auto", children: /* @__PURE__ */ jsxs("table", { className: "lb:w-full lb:text-left lb:border-collapse", children: [
                  /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { className: "lb:border-b lb:border-[var(--lb-separator)] lb:bg-[var(--color-muted)]/40 lb:text-xs lb:font-semibold lb:text-[var(--color-muted-foreground)]", children: [
                    /* @__PURE__ */ jsx("th", { className: "lb:py-2.5 lb:px-4", children: t("tableHeaderKey") }),
                    /* @__PURE__ */ jsx("th", { className: "lb:py-2.5 lb:px-4 lb:text-right", children: t("tableHeaderSpend") }),
                    /* @__PURE__ */ jsx("th", { className: "lb:py-2.5 lb:px-4 lb:text-right", children: t("tableHeaderTokens") }),
                    /* @__PURE__ */ jsx("th", { className: "lb:py-2.5 lb:px-4 lb:text-right", children: t("tableHeaderSessions") })
                  ] }) }),
                  /* @__PURE__ */ jsx("tbody", { className: "lb:divide-y lb:divide-[var(--lb-separator)] lb:text-[13px]", children: costsData.groups.length === 0 ? /* @__PURE__ */ jsx("tr", { children: /* @__PURE__ */ jsx(
                    "td",
                    {
                      colSpan: 4,
                      "data-testid": "costs-empty-state",
                      className: "lb:py-12 lb:px-4 lb:text-center",
                      children: /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:items-center lb:justify-center lb:gap-2", children: [
                        /* @__PURE__ */ jsx("span", { className: "lb:text-[15px] lb:font-medium lb:text-[var(--color-foreground)]", children: t("noCostsData") }),
                        /* @__PURE__ */ jsx("span", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:max-w-md", children: t("costsEmptyNextStep") }),
                        /* @__PURE__ */ jsx(
                          "button",
                          {
                            type: "button",
                            onClick: () => setActiveTab("limits"),
                            className: "lb:mt-2 lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:bg-[var(--lb-fill)] lb:text-[var(--color-secondary-foreground)] lb:text-[13px] lb:font-medium lb:hover:bg-[var(--lb-fill-2)] lb:border-[var(--lb-separator)] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                            children: t("btnSetLimit")
                          }
                        )
                      ] })
                    }
                  ) }) : costsData.groups.map((item2, idx) => /* @__PURE__ */ jsxs(
                    "tr",
                    {
                      "data-testid": `cost-group-row-${item2.key}`,
                      className: "lb:hover:bg-[var(--color-muted)]/20 lb:motion-safe:transition-colors",
                      children: [
                        /* @__PURE__ */ jsx("td", { className: "lb:py-2.5 lb:px-4 lb:font-medium", children: group === "bot" ? botLabel(item2.key) : item2.key }),
                        /* @__PURE__ */ jsx(
                          "td",
                          {
                            "data-testid": `cost-group-spend-${item2.key}`,
                            className: "lb:py-2.5 lb:px-4 lb:text-right lb:tabular-nums lb:font-semibold",
                            children: formatCents(item2.spend_cents, locale)
                          }
                        ),
                        /* @__PURE__ */ jsx("td", { className: "lb:py-2.5 lb:px-4 lb:text-right lb:tabular-nums lb:text-[var(--color-muted-foreground)]", children: item2.tokens !== void 0 ? item2.tokens.toLocaleString() : "-" }),
                        /* @__PURE__ */ jsx("td", { className: "lb:py-2.5 lb:px-4 lb:text-right lb:tabular-nums lb:text-[var(--color-muted-foreground)]", children: item2.sessions !== void 0 ? item2.sessions : "-" })
                      ]
                    },
                    idx
                  )) })
                ] }) }) })
              ] })
            ] }),
            activeTab === "limits" && /* @__PURE__ */ jsxs("div", { className: "lb:space-y-4", children: [
              /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:sm:flex-row lb:sm:items-center lb:justify-between lb:gap-3", children: [
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx("h2", { className: "lb-title", children: t("limitsTitle") }),
                  /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("limitsSubtitle") })
                ] }),
                /* @__PURE__ */ jsxs(
                  "button",
                  {
                    type: "button",
                    "data-testid": "btn-new-limit",
                    onClick: () => openEditLimitModal(),
                    disabled: isLoopback,
                    title: isLoopback ? t("errorLoopbackBudgetRaiseBlocked") : t("btnSetLimit"),
                    className: `lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${isLoopback ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed" : "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90"}`,
                    children: [
                      /* @__PURE__ */ jsx(PlusIcon, { size: 13 }),
                      /* @__PURE__ */ jsx("span", { children: t("btnSetLimit") })
                    ]
                  }
                )
              ] }),
              loadingBudget && !budgetData && /* @__PURE__ */ jsx("div", { className: "lb:p-8 lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("loadingBots") }),
              budgetError && /* @__PURE__ */ jsx(
                "div",
                {
                  role: "alert",
                  className: "lb:p-4 lb:rounded-xl lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:text-[13px] lb:text-[var(--color-destructive)]",
                  children: /* @__PURE__ */ jsx(ErrorNote, { error: budgetError })
                }
              ),
              budgetData && /* @__PURE__ */ jsx("div", { className: "lb:space-y-3", children: budgetData.limits.length === 0 ? /* @__PURE__ */ jsx("div", { className: "lb:p-8 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("noLimitsConfigured") }) : budgetData.limits.map((limit, idx) => {
                const isZeroCap = limit.cents === 0;
                const percent = Math.min(100, Math.max(0, limit.percent));
                const isBreached = limit.percent >= 100;
                const isHigh = limit.percent >= 80;
                return /* @__PURE__ */ jsxs(
                  "div",
                  {
                    "data-testid": `budget-limit-card-${limit.scope}-${limit.ref || "all"}-${limit.period}`,
                    className: "lb:p-4 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:space-y-3",
                    children: [
                      /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:gap-2", children: [
                        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                          /* @__PURE__ */ jsx("span", { className: "lb:font-semibold lb:text-[13px]", children: limit.scope === "global" ? t("scopeGlobalLabel") : limit.scope === "bot" ? t("scopeBotLabel", {
                            name: botLabel(limit.ref || "")
                          }) : t("scopeRoutineLabel", {
                            name: limit.ref || ""
                          }) }),
                          /* @__PURE__ */ jsx("span", { className: "lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]", children: limit.period === "day" ? t("limitPeriodDay") : t("limitPeriodMonth") }),
                          /* @__PURE__ */ jsx(
                            "span",
                            {
                              "data-testid": "badge-ledger",
                              className: "lb:px-1.5 lb:py-0.2 lb:rounded-lg lb:text-xs lb:tabular-nums lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]",
                              children: t("ledgerBadge")
                            }
                          )
                        ] }),
                        /* @__PURE__ */ jsx("div", { className: "lb:flex lb:items-center lb:gap-2", children: /* @__PURE__ */ jsx(
                          "button",
                          {
                            type: "button",
                            "data-testid": `btn-edit-limit-${limit.scope}-${limit.ref || "all"}`,
                            onClick: () => openEditLimitModal(limit),
                            className: "lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:motion-safe:transition-colors lb:rounded-full",
                            children: t("btnEditLimit")
                          }
                        ) })
                      ] }),
                      isZeroCap ? /* @__PURE__ */ jsx("div", { className: "lb:p-2 lb:rounded-lg lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:text-[13px] lb:text-[var(--color-destructive)]", children: t("limitZeroBlocked") }) : /* @__PURE__ */ jsxs("div", { className: "lb:space-y-1.5", children: [
                        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:text-[13px] lb:tabular-nums", children: [
                          /* @__PURE__ */ jsx("span", { "data-testid": "limit-spent-of", children: t("limitSpentOf", {
                            spent: formatCents(
                              limit.spent_cents,
                              locale
                            ),
                            limit: formatCents(limit.cents, locale),
                            percent: limit.percent
                          }) }),
                          limit.reserved_cents ? /* @__PURE__ */ jsx("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)]", children: t("limitReserved", {
                            reserved: formatCents(
                              limit.reserved_cents,
                              locale
                            )
                          }) }) : null
                        ] }),
                        /* @__PURE__ */ jsx("div", { className: "lb:w-full lb:h-2 lb:rounded-full lb:bg-[var(--lb-fill)] lb:overflow-hidden", children: /* @__PURE__ */ jsx(
                          "div",
                          {
                            style: { width: `${percent}%` },
                            className: `lb:h-full lb:motion-safe:transition-all ${isBreached ? "lb:bg-[var(--color-destructive)]" : isHigh ? "lb:bg-[var(--color-warning)]" : "lb:bg-[var(--color-foreground)]"}`
                          }
                        ) })
                      ] })
                    ]
                  },
                  idx
                );
              }) })
            ] }),
            activeTab === "paused" && /* @__PURE__ */ jsxs("div", { className: "lb:space-y-4", children: [
              /* @__PURE__ */ jsxs("div", { children: [
                /* @__PURE__ */ jsx("h2", { className: "lb-title", children: t("pausedBotsTitle") }),
                /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("limitsSubtitle") })
              ] }),
              loadingBudget && !budgetData && /* @__PURE__ */ jsx("div", { className: "lb:p-8 lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("loadingBots") }),
              budgetData && /* @__PURE__ */ jsx("div", { className: "lb:space-y-3", children: budgetData.paused.length === 0 ? /* @__PURE__ */ jsx("div", { className: "lb:p-8 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("pausedBotsEmpty") }) : budgetData.paused.map((paused) => /* @__PURE__ */ jsxs(
                "div",
                {
                  "data-testid": `paused-bot-${paused.bot}`,
                  className: "lb:p-4 lb:rounded-2xl lb:border-[var(--color-destructive)]/40 lb:bg-[var(--color-destructive)]/5 lb:flex lb:flex-col lb:sm:flex-row lb:sm:items-center lb:justify-between lb:gap-3",
                  children: [
                    /* @__PURE__ */ jsxs("div", { className: "lb:space-y-1", children: [
                      /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                        /* @__PURE__ */ jsx("span", { className: "lb-headline", children: botLabel(paused.bot) }),
                        /* @__PURE__ */ jsx(
                          "span",
                          {
                            "data-testid": "badge-paused",
                            className: "lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-destructive)]/20 lb:text-[var(--color-destructive)]",
                            children: t("statusPausedLabel")
                          }
                        )
                      ] }),
                      /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-destructive)]", children: t("pausedBotReason", {
                        reason: paused.plan_status || t("pausedReasonCapReached")
                      }) }),
                      /* @__PURE__ */ jsx("p", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)]", children: t("pausedSince", {
                        time: new Date(paused.since).toLocaleString(
                          locale === "pt" ? "pt-BR" : "en-US"
                        )
                      }) })
                    ] }),
                    /* @__PURE__ */ jsxs(
                      "button",
                      {
                        type: "button",
                        "data-testid": `btn-resume-bot-${paused.bot}`,
                        disabled: isLoopback,
                        onClick: () => openResumeModal(paused.bot),
                        title: isLoopback ? t("errorLoopbackBudgetResumeBlocked") : t("btnResumeBot"),
                        className: `lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${isLoopback ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed" : "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90"}`,
                        children: [
                          /* @__PURE__ */ jsx(PlayIcon, { size: 12 }),
                          /* @__PURE__ */ jsx("span", { children: t("btnResumeBot") })
                        ]
                      }
                    )
                  ]
                },
                paused.bot
              )) })
            ] })
          ] }),
          limitModalOpen && /* @__PURE__ */ jsx(
            "div",
            {
              ref: limitModalRef,
              role: "dialog",
              "aria-modal": "true",
              "aria-labelledby": "modal-limit-title",
              className: "lb-dialog-overlay",
              children: /* @__PURE__ */ jsxs(
                "div",
                {
                  "data-testid": "modal-limit-config",
                  className: "lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto",
                  children: [
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between", children: [
                      /* @__PURE__ */ jsx("h3", { id: "modal-limit-title", className: "lb-title", children: t("modalLimitTitle") }),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "aria-label": t("close"),
                          onClick: () => setLimitModalOpen(false),
                          className: "lb-icon-btn",
                          style: { background: "var(--lb-fill)" },
                          children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsxs("div", { className: "lb:space-y-1", children: [
                      /* @__PURE__ */ jsx("label", { className: "lb:text-[13px] lb:font-medium lb:text-[var(--color-foreground)]", children: t("limitScopeInput") }),
                      /* @__PURE__ */ jsxs(
                        "select",
                        {
                          disabled: Boolean(editingLimit),
                          value: limitScope,
                          onChange: (e) => setLimitScope(e.target.value),
                          className: "lb-input",
                          children: [
                            /* @__PURE__ */ jsx("option", { value: "global", children: t("scopeGlobalLabel") }),
                            /* @__PURE__ */ jsx("option", { value: "bot", children: t("groupBot") }),
                            /* @__PURE__ */ jsx("option", { value: "routine", children: t("groupRoutine") })
                          ]
                        }
                      )
                    ] }),
                    limitScope !== "global" && /* @__PURE__ */ jsxs("div", { className: "lb:space-y-1", children: [
                      /* @__PURE__ */ jsx("label", { className: "lb:text-[13px] lb:font-medium lb:text-[var(--color-foreground)]", children: t("limitTargetInput") }),
                      /* @__PURE__ */ jsx(
                        "input",
                        {
                          type: "text",
                          disabled: Boolean(editingLimit),
                          value: limitRef,
                          onChange: (e) => setLimitRef(e.target.value),
                          placeholder: t("limitTargetPlaceholder"),
                          className: "lb-input"
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsxs("div", { className: "lb:space-y-1", children: [
                      /* @__PURE__ */ jsx("label", { className: "lb:text-[13px] lb:font-medium lb:text-[var(--color-foreground)]", children: t("limitPeriodInput") }),
                      /* @__PURE__ */ jsxs(
                        "select",
                        {
                          disabled: Boolean(editingLimit),
                          value: limitPeriod,
                          onChange: (e) => setLimitPeriod(e.target.value),
                          className: "lb-input",
                          children: [
                            /* @__PURE__ */ jsx("option", { value: "day", children: t("limitPeriodDay") }),
                            /* @__PURE__ */ jsx("option", { value: "month", children: t("limitPeriodMonth") })
                          ]
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsxs("div", { className: "lb:space-y-1", children: [
                      /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between", children: [
                        /* @__PURE__ */ jsx("label", { className: "lb:text-[13px] lb:font-medium lb:text-[var(--color-foreground)]", children: t("limitAmountLabel") }),
                        editingLimit && /* @__PURE__ */ jsx("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)]", children: t("limitCurrentValue", {
                          amount: formatCents(editingLimit.cents, locale)
                        }) })
                      ] }),
                      /* @__PURE__ */ jsx(
                        "input",
                        {
                          type: "text",
                          "data-testid": "input-limit-amount",
                          "aria-label": t("limitAmountInputAriaLabel"),
                          placeholder: t("limitAmountPlaceholder"),
                          value: limitDollarsInput,
                          onChange: (e) => setLimitDollarsInput(e.target.value),
                          className: "lb-input lb-mono"
                        }
                      ),
                      /* @__PURE__ */ jsx("p", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)]", children: t("limitAmountCentsHint") })
                    ] }),
                    isRaiseInLoopback && /* @__PURE__ */ jsx(
                      "div",
                      {
                        role: "alert",
                        className: "lb:p-2.5 lb:rounded-lg lb:bg-[var(--color-warning)]/15 lb:border-[var(--color-warning)]/30 lb:text-[13px] lb:text-[var(--color-warning)]",
                        children: t("errorLoopbackBudgetRaiseBlocked")
                      }
                    ),
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]", children: [
                      editingLimit ? /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "data-testid": "btn-remove-limit",
                          disabled: isLoopback || isSavingLimit,
                          onClick: handleRemoveLimit,
                          className: `lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${isLoopback ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed" : "lb:bg-[var(--color-destructive)]/10 lb:text-[var(--color-destructive)] lb:hover:bg-[var(--color-destructive)]/20"}`,
                          children: t("btnRemoveLimit")
                        }
                      ) : /* @__PURE__ */ jsx("div", {}),
                      /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                        /* @__PURE__ */ jsx(
                          "button",
                          {
                            type: "button",
                            onClick: () => setLimitModalOpen(false),
                            className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:motion-safe:transition-colors lb:rounded-full",
                            children: t("cancelBtn")
                          }
                        ),
                        /* @__PURE__ */ jsx(
                          "button",
                          {
                            type: "button",
                            "data-testid": "btn-save-limit",
                            disabled: isRaiseInLoopback || isSavingLimit || parsedCents === null,
                            onClick: handleSaveLimit,
                            className: `lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${isRaiseInLoopback || parsedCents === null ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed" : "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90"}`,
                            children: isSavingLimit ? t("loadingBots") : t("btnSaveLimit")
                          }
                        )
                      ] })
                    ] })
                  ]
                }
              )
            }
          ),
          resumeModalOpen && botToResume && /* @__PURE__ */ jsx(
            "div",
            {
              ref: resumeModalRef,
              role: "dialog",
              "aria-modal": "true",
              "aria-labelledby": "modal-resume-title",
              className: "lb-dialog-overlay",
              children: /* @__PURE__ */ jsxs(
                "div",
                {
                  "data-testid": "modal-resume-confirmation",
                  className: "lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto",
                  children: [
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between", children: [
                      /* @__PURE__ */ jsx("h3", { id: "modal-resume-title", className: "lb-title", children: t("resumeBotConfirmationTitle") }),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "aria-label": t("close"),
                          onClick: () => setResumeModalOpen(false),
                          className: "lb-icon-btn",
                          style: { background: "var(--lb-fill)" },
                          children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("resumeBotConfirmationBody", { bot: botToResume }) }),
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]", children: [
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          onClick: () => setResumeModalOpen(false),
                          className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                          children: t("cancelBtn")
                        }
                      ),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "data-testid": "btn-confirm-resume",
                          disabled: isResuming || isLoopback,
                          onClick: handleConfirmResumeBot,
                          className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                          children: isResuming ? t("resumingBot") : t("btnConfirmResume")
                        }
                      )
                    ] })
                  ]
                }
              )
            }
          )
        ]
      }
    );
  }

  // dashboard/src/components/transcript/frames.ts
  var str = (v) => typeof v === "string" ? v : void 0;
  function approvalFromFrame(f) {
    return {
      requestId: String(f.request_id ?? ""),
      command: str(f.command) ?? "",
      description: str(f.description) ?? "",
      patternKey: str(f.pattern_key) ?? (Array.isArray(f.pattern_keys) ? str(f.pattern_keys[0]) : void 0),
      choices: Array.isArray(f.choices) ? f.choices : []
    };
  }

  // dashboard/src/components/approvals/decide.ts
  var onceRequest = (a) => ({ digest: a.digest, choice: "once" });
  var alwaysRequest = (a, label) => ({
    digest: a.digest,
    choice: "once",
    draft_rule: { label, level: "allow" }
  });
  function denyRequest(a, reason) {
    const r = reason.trim();
    return r ? { digest: a.digest, choice: "deny", reason: r } : null;
  }
  var REASON_TEXT = {
    delivered: "denyReasonDelivered",
    sending: "denyReasonSending",
    kept: "denyReasonKept",
    unknown: "denyReasonUnknown"
  };
  var reasonText = (s) => REASON_TEXT[s];
  var reasonState = (v) => v === true ? "delivered" : v === null ? "sending" : "kept";
  var reasonsState = (vs) => vs.length > 0 && vs.every((v) => v === true) ? "delivered" : vs.some((v) => v === null) ? "sending" : "kept";
  var FOLLOW_MS = 2e3;
  var FOLLOW_TRIES = 90;
  async function followReasons(ids, onState, alive) {
    for (let i = 0; i < FOLLOW_TRIES && alive(); i++) {
      await new Promise((r) => setTimeout(r, FOLLOW_MS));
      if (!alive()) return;
      try {
        const rows = (await getApprovals())?.approvals ?? [];
        const state = reasonsState(ids.map((id) => {
          const row = rows.find((a) => a.request_id === id);
          return row ? row.reason_delivered : null;
        }));
        if (state !== "sending") {
          onState(state);
          return;
        }
      } catch {
      }
    }
    if (alive()) onState("unknown");
  }
  function mixedActionClass(items) {
    return items.length > 1 && items.some((i) => i.action_class_hash !== items[0].action_class_hash);
  }
  function batchItems(items, choice, reason) {
    const r = reason.trim();
    if (mixedActionClass(items) || choice === "deny" && !r) return null;
    return items.map((i) => ({ request_id: i.request_id, digest: i.digest, choice, reason: choice === "deny" ? r : void 0 }));
  }
  function approvalErrorText(err, t) {
    if (err instanceof ApiError) {
      if (err.code === "loopback_not_human" || err.status === 403) return t("errorLoopbackApprovalBlocked");
      if (err.code === "stale" || err.status === 409) return t("errorStaleConflict");
      if (err.code === "csrf_required") return t("errorCsrfRequired");
    }
    return humanError(err, t, "errorUnexpectedApproval");
  }

  // dashboard/src/components/chat/InlineApproval.tsx
  var card = {
    maxWidth: "min(85%, 640px)",
    margin: "8px 0",
    padding: "12px 14px",
    borderRadius: 18,
    borderBottomLeftRadius: 6,
    background: "var(--color-muted)",
    color: "var(--color-foreground)",
    boxShadow: "inset 3px 0 0 var(--color-warning)"
  };
  var field = {
    width: "100%",
    boxSizing: "border-box",
    marginTop: 6,
    padding: "8px 10px",
    borderRadius: 10,
    fontSize: 13,
    border: "1px solid var(--color-border)",
    background: "var(--color-background)",
    color: "var(--color-foreground)"
  };
  function InlineApproval({ frame, bot, runId, pending, onDecided }) {
    const a = approvalFromFrame(frame);
    const digest = typeof frame.luvebot_digest === "string" && frame.luvebot_digest ? frame.luvebot_digest : null;
    const [stored, setStored] = react_default.useState({});
    react_default.useEffect(() => {
      if (!digest || !a.requestId) return;
      let alive = true;
      getApprovals().then((r) => {
        const row = (r?.approvals ?? []).find((x) => x.request_id === a.requestId);
        if (alive && row) setStored({ commandRedacted: row.command_redacted ?? null, tool: row.tool ?? null, ruleId: row.rule_id ?? null });
      }).catch(() => {
      });
      return () => {
        alive = false;
      };
    }, [digest, a.requestId]);
    return /* @__PURE__ */ jsx(
      ApprovalDecision,
      {
        bot,
        pending: pending && !!runId,
        onDecided,
        request: { requestId: a.requestId, digest, choices: a.choices, command: a.command, description: a.description, patternKey: a.patternKey, ...stored },
        resolve: (body) => resolveRunApproval(bot, runId, { request_id: a.requestId, ...body })
      }
    );
  }
  function ApprovalDecision({ request: a, bot, pending, resolve, bare = false, onDecided }) {
    const { t } = useLuveI18n();
    const digest = a.digest;
    const can = (c) => a.choices.includes(c);
    const [mode, setMode] = react_default.useState("idle");
    const [label, setLabel] = react_default.useState("");
    const [reason, setReason] = react_default.useState("");
    const [busy, setBusy] = react_default.useState(false);
    const [done, setDone] = react_default.useState(null);
    const [error, setError] = react_default.useState(null);
    const [reasonOutcome, setReasonOutcome] = react_default.useState(null);
    const alive = react_default.useRef(true);
    react_default.useEffect(() => () => {
      alive.current = false;
    }, []);
    async function decide(kind, body) {
      if (!body || !digest || busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await resolve(body);
        if (kind === "deny") {
          const first = reasonState(res?.reason_delivered);
          setReasonOutcome(first);
          if (first === "sending" && a.requestId) void followReasons([a.requestId], setReasonOutcome, () => alive.current);
        }
        setDone(kind);
        setMode("idle");
        onDecided?.(kind);
      } catch (e) {
        setError(approvalErrorText(e, t));
      } finally {
        setBusy(false);
      }
    }
    const facts = { description: a.description, command: a.command, commandRedacted: a.commandRedacted, patternKey: a.patternKey, tool: a.tool, ruleId: a.ruleId };
    const ruleLabel = useRuleLabels(!bare, ruleIdOf(facts));
    const human = humanApproval(facts, ruleLabel, t);
    const decidable = !!digest && pending && !done;
    const openAlways = () => {
      setLabel(`${t("allowOnceBtn")} ${a.patternKey || a.command || a.description || t("defaultActionLabel")} ${bot}`);
      setMode("always");
    };
    return /* @__PURE__ */ jsxs("div", { role: "group", "aria-label": t("cardApproval"), style: bare ? void 0 : card, children: [
      !bare && /* @__PURE__ */ jsx("div", { className: "lb-caption", children: t("cardApproval") }),
      !bare && /* @__PURE__ */ jsx("div", { className: "lb-headline", style: { marginTop: 4, overflowWrap: "anywhere" }, children: human.title }),
      !bare && human.tool && /* @__PURE__ */ jsx("div", { className: "lb-caption", style: { marginTop: 2 }, children: human.tool }),
      !bare && human.preview && /* @__PURE__ */ jsx("pre", { style: { margin: "8px 0 0", padding: "8px 10px", borderRadius: 10, background: "var(--color-background)", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }, children: human.preview }),
      !bare && human.technical.length > 0 && /* @__PURE__ */ jsxs("details", { style: { marginTop: 6 }, children: [
        /* @__PURE__ */ jsx("summary", { className: "lb-caption", style: { cursor: "pointer" }, children: t("approvalTechnicalDetail") }),
        /* @__PURE__ */ jsx("pre", { className: "lb-caption", style: { margin: "4px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--lb-mono)" }, children: human.technical.join("\n") })
      ] }),
      done && /* @__PURE__ */ jsxs("div", { role: "status", style: { marginTop: 8, fontSize: 13, fontWeight: 600 }, children: [
        t(done === "once" ? "approvalInlineOnce" : done === "deny" ? "approvalInlineDeny" : "approvalInlineAlways"),
        reasonOutcome && /* @__PURE__ */ jsx("div", { className: "lb-caption", style: { fontWeight: 400, marginTop: 2 }, children: t(reasonText(reasonOutcome)) })
      ] }),
      !done && !digest && /* @__PURE__ */ jsx("div", { style: { marginTop: 8, fontSize: 12, color: "var(--color-muted-foreground)" }, children: t("approvalNotResolvableHere") }),
      !done && digest && !pending && /* @__PURE__ */ jsx("div", { style: { marginTop: 8, fontSize: 12, color: "var(--color-muted-foreground)" }, children: t("approvalNoLongerPending") }),
      decidable && mode === "idle" && /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }, children: [
        can("once") && /* @__PURE__ */ jsx("button", { type: "button", disabled: busy, onClick: () => void decide("once", onceRequest({ digest })), className: "lb-btn lb-btn-primary", children: t("allowOnceBtn") }),
        can("once") && /* @__PURE__ */ jsx("button", { type: "button", disabled: busy, onClick: openAlways, className: "lb-btn", children: t("alwaysAllowBtn") }),
        can("deny") && /* @__PURE__ */ jsx("button", { type: "button", disabled: busy, onClick: () => {
          setReason("");
          setMode("deny");
        }, className: "lb-btn lb-btn-destructive", children: t("denyBtn") })
      ] }),
      decidable && mode === "always" && /* @__PURE__ */ jsxs("div", { style: { marginTop: 10 }, children: [
        /* @__PURE__ */ jsx("div", { style: { fontSize: 12, color: "var(--color-muted-foreground)" }, children: t("alwaysModalExplanationP1") }),
        /* @__PURE__ */ jsxs("label", { style: { display: "block", marginTop: 8, fontSize: 12, fontWeight: 600 }, children: [
          t("alwaysModalDraftLabel"),
          /* @__PURE__ */ jsx("input", { value: label, onChange: (e) => setLabel(e.target.value), style: field })
        ] }),
        /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 8, marginTop: 8 }, children: [
          /* @__PURE__ */ jsx("button", { type: "button", disabled: busy, onClick: () => void decide("always", alwaysRequest({ digest }, label.trim() || t("rulesTitleBot", { bot }))), className: "lb-btn lb-btn-primary", children: t("alwaysModalConfirm") }),
          /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setMode("idle"), className: "lb-btn", children: t("alwaysModalCancel") })
        ] })
      ] }),
      decidable && mode === "deny" && /* @__PURE__ */ jsxs("div", { style: { marginTop: 10 }, children: [
        /* @__PURE__ */ jsxs("label", { style: { display: "block", fontSize: 12, fontWeight: 600 }, children: [
          t("denyModalReasonLabel"),
          /* @__PURE__ */ jsx("textarea", { value: reason, rows: 2, onChange: (e) => setReason(e.target.value), placeholder: t("denyModalPlaceholder"), style: { ...field, resize: "vertical" } })
        ] }),
        /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 8, marginTop: 8 }, children: [
          /* @__PURE__ */ jsx("button", { type: "button", disabled: busy || !reason.trim(), onClick: () => void decide("deny", denyRequest({ digest }, reason)), className: "lb-btn lb-btn-destructive", children: t("denyModalConfirm") }),
          /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setMode("idle"), className: "lb-btn", children: t("alwaysModalCancel") })
        ] })
      ] }),
      error && /* @__PURE__ */ jsx("div", { role: "alert", style: { marginTop: 8, fontSize: 12, color: "var(--color-destructive)", overflowWrap: "anywhere" }, children: /* @__PURE__ */ jsx(ErrorNote, { error }) })
    ] });
  }

  // dashboard/src/api/templates.ts
  var BOT_COLORS = [
    { hex: "#60a5fa", name: "Azul El\xE9trico", archetype: "Vendas" },
    { hex: "#34d399", name: "Esmeralda", archetype: "Suporte" },
    { hex: "#a78bfa", name: "Violeta", archetype: "Dev" },
    { hex: "#fbbf24", name: "\xC2mbar Ouro", archetype: "Pesquisa" },
    { hex: "#fb7185", name: "Rosa Coral", archetype: "Conte\xFAdo" },
    { hex: "#38bdf8", name: "Ciano \xC1rtico", archetype: "Ops" },
    { hex: "#fb923c", name: "Laranja Fogo", archetype: "Chefe de Gabinete" },
    { hex: "#e879f9", name: "F\xFAcsia Neon", archetype: "Revisor" }
  ];
  var DEFAULT_TEMPLATES = [
    {
      id: "chief-of-staff",
      label: "Chefe de Gabinete",
      role: "Coordena\xE7\xE3o geral e triagem",
      description: "Coordena tarefas, distribui demandas entre agentes e faz acompanhamento de entregas.",
      color: "#fb923c",
      avatar: { kind: "mascot", value: "rumo" },
      toolsets: ["web", "delegate"],
      model_hint: "claude-sonnet-5-5",
      soul: `# SOUL do Chefe de Gabinete
Voc\xEA \xE9 o Chefe de Gabinete do time de agentes LuveBot.
Sua miss\xE3o \xE9 coordenar demandas, alinhar prioridades e delegar subtarefas aos bots especialistas.
Regras permanentes:
- Sempre confirme com o usu\xE1rio antes de delegar tarefas cr\xEDticas.
- Mantenha resumos concisos e checkpoints objetivos.
- Tarefas do dia a dia pertencem \xE0 conversa; regras permanentes residem aqui.`,
      intro_prompt: "Ol\xE1! Sou seu Chefe de Gabinete. Posso coordenar tarefas entre agentes e organizar seu dia. Como posso ajudar agora?"
    },
    {
      id: "sales",
      label: "Vendas",
      role: "Prospec\xE7\xE3o e follow-up B2B",
      description: "Pesquisa leads, l\xEA CRM e prepara follow-ups para aprova\xE7\xE3o humana.",
      color: "#60a5fa",
      avatar: { kind: "mascot", value: "zuca" },
      toolsets: ["web", "crm"],
      model_hint: "claude-sonnet-5-5",
      soul: `# SOUL do Bot Vendas
Voc\xEA \xE9 o especialista de Vendas B2B do LuveBot.
Sua miss\xE3o \xE9 encontrar prospects qualificados e preparar cad\xEAncias de e-mail personalizadas.
Regras permanentes:
- NUNCA envie e-mails ou mensagens para contatos externos sem aprova\xE7\xE3o pr\xE9via.
- Valide nomes, cargos e dom\xEDnios antes de sugerir um contato.`,
      intro_prompt: "Ol\xE1! Sou o agente de Vendas. Posso pesquisar prospects e preparar follow-ups. Quer que eu revise os leads recentes?"
    },
    {
      id: "support",
      label: "Suporte",
      role: "Atendimento e resolu\xE7\xE3o de tickets",
      description: "Atende clientes, consulta documenta\xE7\xE3o e escala chamados com contexto completo.",
      color: "#34d399",
      avatar: { kind: "mascot", value: "brisa" },
      toolsets: ["web", "docs"],
      model_hint: "claude-sonnet-5-5",
      soul: `# SOUL do Bot Suporte
Voc\xEA \xE9 o especialista de Suporte e Atendimento do LuveBot.
Sua miss\xE3o \xE9 resolver d\xFAvidas de usu\xE1rios com empatia e precis\xE3o t\xE9cnica.
Regras permanentes:
- Sempre consulte a base de conhecimento oficial antes de responder.
- Se n\xE3o tiver certeza absoluta, pe\xE7a confirma\xE7\xE3o ou escale para um humano.`,
      intro_prompt: "Ol\xE1! Sou o agente de Suporte. Estou pronto para ajudar seus clientes e resolver tickets com rapidez."
    },
    {
      id: "ops-finance",
      label: "Opera\xE7\xF5es e Financeiro",
      role: "Monitoramento e concilia\xE7\xE3o",
      description: "Acompanha rotinas, relat\xF3rios de despesas, cron jobs e alertas operacionais.",
      color: "#38bdf8",
      avatar: { kind: "mascot", value: "nimbo" },
      toolsets: ["terminal", "metrics"],
      model_hint: "claude-sonnet-5-5",
      soul: `# SOUL do Bot Opera\xE7\xF5es e Financeiro
Voc\xEA \xE9 o respons\xE1vel por Opera\xE7\xF5es e Finan\xE7as do LuveBot.
Sua miss\xE3o \xE9 manter sistemas monitorados e concilia\xE7\xF5es em dia.
Regras permanentes:
- NUNCA execute transfer\xEAncias ou altere credenciais de pagamento.
- Emita alertas imediatos se o teto de gastos for atingido.`,
      intro_prompt: "Ol\xE1! Sou o agente de Opera\xE7\xF5es e Financeiro. Monitoro suas rotinas, infraestrutura e despesas."
    },
    {
      id: "dev",
      label: "Engenheiro Dev",
      role: "Diagn\xF3stico e corre\xE7\xF5es de c\xF3digo",
      description: "Investiga bugs, executa testes em sandbox e prepara corre\xE7\xF5es de c\xF3digo e PRs.",
      color: "#a78bfa",
      avatar: { kind: "mascot", value: "pipo" },
      toolsets: ["terminal", "git", "filesystem"],
      model_hint: "claude-sonnet-5-5",
      soul: `# SOUL do Engenheiro Dev
Voc\xEA \xE9 o Engenheiro Dev do LuveBot.
Sua miss\xE3o \xE9 analisar reposit\xF3rios, investigar problemas e propor corre\xE7\xF5es seguras.
Regras permanentes:
- NUNCA execute comandos destrutivos (rm -rf, DROP TABLE, etc.).
- Sempre rode testes antes de concluir uma tarefa de c\xF3digo.`,
      intro_prompt: "Ol\xE1! Sou o Engenheiro Dev. Posso investigar bugs, rodar testes seguros e preparar pull requests."
    },
    {
      id: "research",
      label: "Pesquisa",
      role: "Pesquisa anal\xEDtica e s\xEDntese",
      description: "Pesquisa web proativa, leitura anal\xEDtica e elabora\xE7\xE3o de relat\xF3rios estruturados.",
      color: "#fbbf24",
      avatar: { kind: "mascot", value: "faro" },
      toolsets: ["web", "analysis"],
      model_hint: "claude-sonnet-5-5",
      soul: `# SOUL do Bot Pesquisa
Voc\xEA \xE9 o analista de Pesquisa e Intelig\xEAncia do LuveBot.
Sua miss\xE3o \xE9 varrer fontes confi\xE1veis e produzir s\xEDnteses claras e com links.
Regras permanentes:
- Sempre cite as fontes e URLs consultadas.
- Diferencie fatos confirmados de hip\xF3teses ou estimativas.`,
      intro_prompt: "Ol\xE1! Sou o agente de Pesquisa. Posso analisar mercados, competidores e temas t\xE9cnicos com profundidade."
    },
    {
      id: "content",
      label: "Conte\xFAdo",
      role: "Reda\xE7\xE3o e comunica\xE7\xE3o",
      description: "Redige newsletters, posts, changelogs e materiais de comunica\xE7\xE3o.",
      color: "#fb7185",
      avatar: { kind: "mascot", value: "tinta" },
      toolsets: ["web", "drafting"],
      model_hint: "claude-sonnet-5-5",
      soul: `# SOUL do Bot Conte\xFAdo
Voc\xEA \xE9 o redator de Conte\xFAdo do LuveBot.
Sua miss\xE3o \xE9 escrever com clareza, personalidade e alta densidade de informa\xE7\xE3o.
Regras permanentes:
- Mantenha tom profissional, elegante e direto.
- Submeta sempre rascunhos para revis\xE3o antes de considerar finalizado.`,
      intro_prompt: "Ol\xE1! Sou o agente de Conte\xFAdo. Posso criar posts, newsletters e textos com o tom de voz ideal."
    }
  ];

  // dashboard/src/components/home/derive.ts
  function needsYou(approvals = [], handoffs = []) {
    return [
      ...approvals.filter((a) => a.status === "pending").map((a) => ({
        id: a.request_id,
        kind: "approval",
        bot: a.bot,
        // never the digest: it is a hash the human cannot read
        title: a.description || a.command_redacted || a.request_id,
        detail: a.description && a.command_redacted ? a.command_redacted : void 0,
        rawApproval: a
      })),
      ...handoffs.filter((h) => h.needs_review || h.state === "triage" || h.state === "review").map((h) => ({
        id: h.id,
        kind: "handoff",
        bot: h.from,
        title: `${h.from} \u2192 ${h.to}: ${h.title}`,
        detail: h.body,
        rawHandoff: h
      }))
    ];
  }
  var inProgress = (items = []) => items.filter((i) => i.status === "running" || i.status === "waiting_approval");
  var completed = (items = []) => items.filter((i) => i.status === "done");
  var upcomingRoutines = (routines = [], max = 5) => routines.filter((r) => r.enabled && r.state !== "paused").slice(0, max);
  var activeBotCount = (bots) => bots.filter((b) => b.status !== "offline" && b.status !== "paused").length;

  // dashboard/src/components/ui/ListState.tsx
  function BotsLoading({ rows = 2 }) {
    const { t } = useLuveI18n();
    return /* @__PURE__ */ jsx("div", { "data-testid": "bots-loading", "aria-busy": "true", "aria-label": t("loadingBots"), style: { display: "flex", flexDirection: "column", gap: 8 }, children: Array.from({ length: rows }, (_, k) => /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 12 }, children: [
      /* @__PURE__ */ jsx("span", { style: { width: 36, height: 36, flexShrink: 0, borderRadius: "36%", background: "var(--color-muted)" } }),
      /* @__PURE__ */ jsx("span", { style: { flex: 1, height: 12, borderRadius: 6, background: "var(--color-muted)" } })
    ] }, k)) });
  }
  function BotsError({ onRetry }) {
    const { t } = useLuveI18n();
    return /* @__PURE__ */ jsxs("div", { role: "alert", "data-testid": "bots-error", className: "lb-alert", children: [
      /* @__PURE__ */ jsx("strong", { children: t("errorLoadingBots") }),
      onRetry && /* @__PURE__ */ jsx("div", { children: /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn lb-btn-plain", onClick: onRetry, children: t("retry") }) })
    ] });
  }

  // dashboard/src/lib/render/markdown.tsx
  var MAX_CHARS = 1e5;
  var SAFE_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:", "mailto:"]);
  function safeHref(raw) {
    if (/[\u0000-\u0020\u007f-\u009f\u00a0\u2028\u2029\ufeff]/.test(raw)) return null;
    if (!/^(https?:\/\/|mailto:)/i.test(raw)) return null;
    try {
      const u = new URL(raw);
      return SAFE_PROTOCOLS.has(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  }
  var INLINE = /`([^`\n]{1,2000})`|\*\*([^\n]{1,2000}?)\*\*|\*([^*\n]{1,2000}?)\*|\[([^\]\n]{1,500})\]\(([^)\n]{0,2000})\)/;
  function inline(src, key) {
    const out = [];
    let rest = src;
    let i = 0;
    while (rest) {
      const m = INLINE.exec(rest);
      if (!m) {
        out.push(rest);
        break;
      }
      if (m.index) out.push(rest.slice(0, m.index));
      const k = `${key}.${i++}`;
      if (m[1] !== void 0) out.push(/* @__PURE__ */ jsx("code", { className: "luve-md-code", style: codeStyle, children: m[1] }, k));
      else if (m[2] !== void 0) out.push(/* @__PURE__ */ jsx("strong", { children: inline(m[2], k) }, k));
      else if (m[3] !== void 0) out.push(/* @__PURE__ */ jsx("em", { children: inline(m[3], k) }, k));
      else {
        const href = safeHref(m[5]);
        out.push(href ? /* @__PURE__ */ jsx("a", { href, target: "_blank", rel: "noopener noreferrer", style: { color: "var(--color-primary)", textDecoration: "underline" }, children: m[4] }, k) : m[0]);
      }
      rest = rest.slice(m.index + m[0].length);
    }
    return out;
  }
  var codeStyle = {
    background: "var(--color-muted)",
    color: "var(--color-foreground)",
    borderRadius: 4,
    padding: "0 4px",
    fontFamily: "monospace",
    fontSize: "0.9em"
  };
  var blockStyle = {
    ...codeStyle,
    display: "block",
    padding: 8,
    overflowX: "auto",
    whiteSpace: "pre"
  };
  var LIST = /^\s*(?:[-*+]|\d{1,9}\.)\s+(.*)$/;
  var HEADING = /^ {0,3}(#{1,3})[ \t]+(\S.*)$/;
  var HEADING_TAG = ["h2", "h3", "h4"];
  var headingStyle = { margin: "12px 0 4px", fontWeight: 600, lineHeight: 1.3 };
  var HEADING_SIZE = ["1.25em", "1.1em", "1em"];
  function headingText(body) {
    let end = body.length;
    while (end > 0 && (body[end - 1] === " " || body[end - 1] === "	")) end--;
    let h = end;
    while (h > 0 && body[h - 1] === "#") h--;
    if (h < end && h > 0 && (body[h - 1] === " " || body[h - 1] === "	")) {
      end = h;
      while (end > 0 && (body[end - 1] === " " || body[end - 1] === "	")) end--;
    }
    return body.slice(0, end);
  }
  var ORDERED = /^\s*\d{1,9}\.\s/;
  function Markdown({ text }) {
    const { t } = useLuveI18n();
    const truncated = text.length > MAX_CHARS;
    const lines = (truncated ? text.slice(0, MAX_CHARS) : text).split(/\r?\n/);
    const blocks2 = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const k = `b${blocks2.length}`;
      if (/^\s*```/.test(line)) {
        const code2 = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code2.push(lines[i++]);
        i++;
        blocks2.push(/* @__PURE__ */ jsx("pre", { style: { margin: "4px 0" }, children: /* @__PURE__ */ jsx("code", { style: blockStyle, children: code2.join("\n") }) }, k));
      } else if (!line.trim()) {
        i++;
      } else if (HEADING.test(line)) {
        const [, hashes, body] = HEADING.exec(line);
        const Tag = HEADING_TAG[hashes.length - 1];
        blocks2.push(/* @__PURE__ */ jsx(Tag, { style: { ...headingStyle, fontSize: HEADING_SIZE[hashes.length - 1] }, children: inline(headingText(body), k) }, k));
        i++;
      } else if (LIST.test(line)) {
        const ordered = ORDERED.test(line);
        const items = [];
        while (i < lines.length && LIST.test(lines[i])) {
          items.push(/* @__PURE__ */ jsx("li", { children: inline(LIST.exec(lines[i])[1], `${k}.${items.length}`) }, items.length));
          i++;
        }
        blocks2.push(ordered ? /* @__PURE__ */ jsx("ol", { style: { paddingLeft: 20, listStyle: "decimal" }, children: items }, k) : /* @__PURE__ */ jsx("ul", { style: { paddingLeft: 20, listStyle: "disc" }, children: items }, k));
      } else if (/^\s*>/.test(line)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
        blocks2.push(
          /* @__PURE__ */ jsx("blockquote", { style: { borderLeft: "3px solid var(--color-border)", paddingLeft: 8, color: "var(--color-muted-foreground)", whiteSpace: "pre-wrap" }, children: inline(q.join("\n"), k) }, k)
        );
      } else {
        const p = [];
        while (i < lines.length && lines[i].trim() && !/^\s*(```|>)/.test(lines[i]) && !LIST.test(lines[i]) && !HEADING.test(lines[i])) p.push(lines[i++]);
        blocks2.push(/* @__PURE__ */ jsx("p", { style: { whiteSpace: "pre-wrap", margin: "4px 0" }, children: inline(p.join("\n"), k) }, k));
      }
    }
    if (truncated) blocks2.push(/* @__PURE__ */ jsx("p", { style: { color: "var(--color-muted-foreground)" }, children: t("textTruncated") }, "trunc"));
    return /* @__PURE__ */ jsx("div", { className: "luve-md", style: { overflowWrap: "anywhere" }, children: blocks2 });
  }

  // dashboard/src/components/Hoje.tsx
  function Hoje({
    bots = [],
    approvals: initialApprovals,
    handoffs: initialHandoffs,
    inProgressItems: initialInProgress,
    completedItems: initialCompleted,
    routines: initialRoutines,
    costs: initialCosts,
    budget: initialBudget,
    onOpenCreateBot,
    onNavigateTab,
    onSelectBot,
    onStopActivity,
    onRunRoutine,
    autoFetch = false,
    botsStatus = "ready",
    onRetryBots
  } = {}) {
    const { t, locale } = useLuveI18n();
    const ruleLabel = useRuleLabels();
    const [confirming, setConfirming] = useState(null);
    const [actionError, setActionError] = useState(null);
    const act = (fn) => {
      setConfirming(null);
      setActionError(null);
      const fail = (e) => setActionError(humanError(e, t, "unexpectedError"));
      try {
        Promise.resolve(fn()).catch(fail);
      } catch (e) {
        fail(e);
      }
    };
    const [approvalsData, setApprovalsData] = useState(initialApprovals || []);
    const [handoffsData, setHandoffsData] = useState(initialHandoffs || []);
    const [inProgressData, setInProgressData] = useState(initialInProgress || []);
    const [completedData, setCompletedData] = useState(initialCompleted || []);
    const [routinesData, setRoutinesData] = useState(initialRoutines || []);
    const [costsData, setCostsData] = useState(initialCosts);
    const [budgetData, setBudgetData] = useState(initialBudget);
    useEffect(() => {
      if (initialApprovals !== void 0) setApprovalsData(initialApprovals);
    }, [initialApprovals]);
    useEffect(() => {
      if (initialHandoffs !== void 0) setHandoffsData(initialHandoffs);
    }, [initialHandoffs]);
    useEffect(() => {
      if (initialInProgress !== void 0) setInProgressData(initialInProgress);
    }, [initialInProgress]);
    useEffect(() => {
      if (initialCompleted !== void 0) setCompletedData(initialCompleted);
    }, [initialCompleted]);
    useEffect(() => {
      if (initialRoutines !== void 0) setRoutinesData(initialRoutines);
    }, [initialRoutines]);
    useEffect(() => {
      if (initialCosts !== void 0) setCostsData(initialCosts);
    }, [initialCosts]);
    useEffect(() => {
      if (initialBudget !== void 0) setBudgetData(initialBudget);
    }, [initialBudget]);
    useEffect(() => {
      if (!autoFetch) return;
      let mounted = true;
      if (initialApprovals === void 0) {
        getApprovals().then((res) => {
          if (mounted && res?.approvals) setApprovalsData(res.approvals);
        }).catch(() => {
        });
      }
      if (initialHandoffs === void 0) {
        getHandoffs().then((res) => {
          if (mounted && res?.handoffs) setHandoffsData(res.handoffs);
        }).catch(() => {
        });
      }
      if (initialInProgress === void 0) {
        getActivity({ tab: "running" }).then((res) => {
          if (mounted && res?.items) setInProgressData(res.items);
        }).catch(() => {
        });
      }
      if (initialCompleted === void 0) {
        getActivity({ tab: "done" }).then((res) => {
          if (mounted && res?.items) setCompletedData(res.items);
        }).catch(() => {
        });
      }
      if (initialRoutines === void 0) {
        getRoutines().then((res) => {
          if (mounted && res?.routines) setRoutinesData(res.routines);
        }).catch(() => {
        });
      }
      if (initialCosts === void 0) {
        getCosts({ period: "day" }).then((res) => {
          if (mounted && res) setCostsData(res);
        }).catch(() => {
        });
      }
      if (initialBudget === void 0) {
        getBudget().then((res) => {
          if (mounted && res) setBudgetData(res);
        }).catch(() => {
        });
      }
      return () => {
        mounted = false;
      };
    }, [
      autoFetch,
      initialApprovals,
      initialHandoffs,
      initialInProgress,
      initialCompleted,
      initialRoutines,
      initialCosts,
      initialBudget
    ]);
    const activeCount = activeBotCount(bots);
    const activeBotsLabel = activeCount === 0 ? t("activeBotsCount") : activeCount === 1 ? t("activeBotCountParamSingle", { count: activeCount }) : t("activeBotsCountParam", { count: activeCount });
    const needsYouItems = useMemo(() => needsYou(approvalsData, handoffsData), [approvalsData, handoffsData]);
    const inProgressList = useMemo(() => inProgress(inProgressData), [inProgressData]);
    const completedList = useMemo(() => completed(completedData), [completedData]);
    const upcomingRoutines2 = useMemo(() => upcomingRoutines(routinesData), [routinesData]);
    const todaySpendCents = costsData?.totals?.spend_cents;
    const globalDayLimit = budgetData?.limits?.find(
      (l) => l.scope === "global" && l.period === "day"
    );
    const botOf = (name) => bots.find((b) => b.name === name);
    const who = (name) => {
      const b = botOf(name);
      return { label: b?.display?.label || name, avatar: b?.display?.avatar, color: b?.display?.color };
    };
    const templates = [
      ["gabinete", "templateGabineteTitle", "templateGabineteDesc", BOT_COLORS[6].hex],
      ["vendas", "templateVendasTitle", "templateVendasDesc", BOT_COLORS[0].hex],
      ["dev", "templateDevTitle", "templateDevDesc", BOT_COLORS[2].hex]
    ];
    const sectionHead = (title, count, countId) => /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, padding: "0 4px 8px" }, children: [
      /* @__PURE__ */ jsx("h2", { className: "lb-headline", children: title }),
      /* @__PURE__ */ jsx("span", { "data-testid": countId, className: "lb-caption", children: count })
    ] });
    const empty = (testid, icon, title, next, action) => /* @__PURE__ */ jsxs("div", { "data-testid": testid, className: "lb-group lb-empty", children: [
      /* @__PURE__ */ jsx("span", { className: "lb-empty-icon", "aria-hidden": "true", children: icon }),
      /* @__PURE__ */ jsx("h3", { className: "lb-headline", children: title }),
      /* @__PURE__ */ jsx("p", { className: "lb-subhead", style: { maxWidth: 320 }, children: next }),
      action
    ] });
    const face = (name) => {
      const w = who(name);
      return /* @__PURE__ */ jsx(Avatar, { name: w.label, avatar: w.avatar, color: w.color, size: 36 });
    };
    return /* @__PURE__ */ jsxs("div", { className: "lb-appear", style: { display: "flex", flexDirection: "column", gap: 32, padding: "28px 24px 40px", width: "100%", maxWidth: 1180, margin: "0 auto", boxSizing: "border-box", fontFamily: "var(--lb-font)" }, children: [
      actionError && /* @__PURE__ */ jsx("div", { role: "alert", className: "lb-group lb-subhead", style: { padding: "12px 16px", color: "var(--color-destructive)" }, children: /* @__PURE__ */ jsx(ErrorNote, { error: actionError }) }),
      /* @__PURE__ */ jsxs("header", { style: { display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }, children: [
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("h1", { className: "lb-large-title", children: t("hojeTitle") }),
          /* @__PURE__ */ jsx("p", { className: "lb-subhead", style: { fontSize: 15, marginTop: 2 }, children: (/* @__PURE__ */ new Date()).toLocaleDateString(locale === "pt" ? "pt-BR" : "en-US", { weekday: "long", day: "numeric", month: "long" }) })
        ] }),
        /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 }, children: [
          todaySpendCents !== void 0 && todaySpendCents !== null && /* @__PURE__ */ jsx("span", { "data-testid": "hoje-spend-badge", className: "lb-pill", style: { fontVariantNumeric: "tabular-nums" }, children: globalDayLimit && globalDayLimit.cents > 0 ? t("todaySpendVsBudget", { spend: formatCents(todaySpendCents, locale), budget: formatCents(globalDayLimit.cents, locale) }) : t("todaySpendOnly", { spend: formatCents(todaySpendCents, locale) }) }),
          botsStatus === "ready" && /* @__PURE__ */ jsx("span", { className: "lb-pill", children: /* @__PURE__ */ jsx("span", { "data-testid": "active-bots-count", children: activeBotsLabel }) })
        ] })
      ] }),
      botsStatus === "loading" && /* @__PURE__ */ jsx(BotsLoading, {}),
      botsStatus === "error" && /* @__PURE__ */ jsx(BotsError, { onRetry: onRetryBots }),
      botsStatus === "ready" && bots.length === 0 && /* @__PURE__ */ jsxs("section", { "aria-label": "onboarding", children: [
        /* @__PURE__ */ jsxs("div", { style: { padding: "0 4px 12px" }, children: [
          /* @__PURE__ */ jsx("h2", { className: "lb-title", children: t("onboardingTitle") }),
          /* @__PURE__ */ jsx("p", { className: "lb-subhead", style: { marginTop: 4 }, children: t("onboardingSubtitle") })
        ] }),
        /* @__PURE__ */ jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }, children: templates.map(([id, title, desc, color]) => /* @__PURE__ */ jsxs("div", { className: "lb-group", style: { display: "flex", flexDirection: "column", gap: 10, padding: 16 }, children: [
          /* @__PURE__ */ jsx(Avatar, { name: t(title), color, size: 40 }),
          /* @__PURE__ */ jsx("h3", { className: "lb-headline", children: t(title) }),
          /* @__PURE__ */ jsx("p", { className: "lb-subhead", style: { flex: 1 }, children: t(desc) }),
          /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn lb-btn-primary", style: { alignSelf: "flex-start" }, onClick: () => onOpenCreateBot?.(id), children: t("createTemplateBtn") })
        ] }, id)) })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "lb-sections", children: /* @__PURE__ */ jsxs("div", { className: "lb-section-grid", children: [
        /* @__PURE__ */ jsxs("section", { "aria-label": t("needsYouTitle"), children: [
          sectionHead(t("needsYouTitle"), needsYouItems.length, "needs-you-count"),
          needsYouItems.length === 0 ? empty("needs-you-empty", /* @__PURE__ */ jsx(CheckCircleIcon, { size: 20 }), t("needsYouEmpty"), t("needsYouEmptyNextStep")) : /* @__PURE__ */ jsx("div", { className: "lb-group", children: needsYouItems.map((item2) => /* @__PURE__ */ jsxs("div", { "data-testid": `needs-you-item-${item2.id}`, className: "lb-row", style: { alignItems: "flex-start" }, children: [
            face(item2.bot),
            /* @__PURE__ */ jsxs("div", { className: "lb-row-stack", children: [
              /* @__PURE__ */ jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: 8 }, children: [
                /* @__PURE__ */ jsx("span", { className: "lb-headline lb-truncate", children: who(item2.bot).label }),
                /* @__PURE__ */ jsx("span", { className: "lb-caption", children: item2.kind === "approval" ? t("needsYouKindApproval") : t("needsYouKindHandoff") })
              ] }),
              item2.kind === "approval" && item2.rawApproval ? /* @__PURE__ */ jsx("div", { className: "lb-body lb-clamp-2", children: approvalTitle(item2.rawApproval, ruleLabel, t) }) : /* @__PURE__ */ jsx("div", { className: "lb-body lb-clamp-2", children: /* @__PURE__ */ jsx(Markdown, { text: item2.title }) }),
              item2.detail && /* @__PURE__ */ jsx("div", { className: "lb-subhead lb-mono", style: { overflowWrap: "anywhere" }, children: /* @__PURE__ */ jsx(Markdown, { text: item2.detail }) }),
              /* @__PURE__ */ jsx("div", { style: { marginTop: 6 }, children: item2.kind === "approval" && item2.rawApproval ? /* @__PURE__ */ jsx(
                ApprovalDecision,
                {
                  bare: true,
                  bot: item2.bot,
                  pending: item2.rawApproval.status === "pending",
                  request: {
                    requestId: item2.rawApproval.request_id,
                    digest: item2.rawApproval.digest || null,
                    choices: item2.rawApproval.allowed_choices,
                    command: item2.rawApproval.command_redacted,
                    description: item2.rawApproval.description,
                    patternKey: item2.rawApproval.pattern_keys?.[0]
                  },
                  resolve: (body) => resolveApproval(item2.rawApproval.request_id, body)
                }
              ) : /* @__PURE__ */ jsxs("button", { type: "button", className: "lb-btn", onClick: () => onNavigateTab?.("atividade"), children: [
                /* @__PURE__ */ jsx("span", { children: t("reviewHandoffBtn") }),
                /* @__PURE__ */ jsx(ArrowRightIcon, { size: 14 })
              ] }) })
            ] })
          ] }, item2.id)) })
        ] }),
        /* @__PURE__ */ jsxs("section", { "aria-label": t("inProgressTitle"), children: [
          sectionHead(t("inProgressTitle"), inProgressList.length, "in-progress-count"),
          inProgressList.length === 0 ? empty("in-progress-empty", /* @__PURE__ */ jsx(ClockIcon, { size: 20 }), t("inProgressEmpty"), t("inProgressEmptyNextStep")) : /* @__PURE__ */ jsx("div", { className: "lb-group", children: inProgressList.map((item2) => /* @__PURE__ */ jsxs("div", { "data-testid": `in-progress-item-${item2.id}`, className: "lb-row", children: [
            face(item2.bot),
            /* @__PURE__ */ jsxs("div", { className: "lb-row-stack", children: [
              /* @__PURE__ */ jsx("div", { className: "lb-body lb-clamp-2", children: /* @__PURE__ */ jsx(Markdown, { text: activityTitle(item2, t) }) }),
              /* @__PURE__ */ jsxs("span", { className: "lb-caption", children: [
                who(item2.bot).label,
                item2.checkpoint && /* @__PURE__ */ jsxs(Fragment2, { children: [
                  " \xB7 ",
                  /* @__PURE__ */ jsx("span", { children: t("checkpointDoneParam", { done: item2.checkpoint.done, total: item2.checkpoint.total }) })
                ] })
              ] })
            ] }),
            /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }, children: [
              /* @__PURE__ */ jsxs("span", { className: "lb-caption", children: [
                item2.duration_s !== null && item2.duration_s !== void 0 && /* @__PURE__ */ jsxs("span", { children: [
                  item2.duration_s,
                  "s"
                ] }),
                item2.cost_cents !== null && item2.cost_cents !== void 0 && /* @__PURE__ */ jsxs("span", { children: [
                  " \xB7 ",
                  formatCents(item2.cost_cents, locale)
                ] })
              ] }),
              onStopActivity && /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  className: "lb-btn lb-btn-destructive",
                  onClick: () => {
                    if (confirming === `stop:${item2.id}`) act(() => onStopActivity(item2.id));
                    else setConfirming(`stop:${item2.id}`);
                  },
                  children: confirming === `stop:${item2.id}` ? t("agentConfirmStop") : t("stopBtn")
                }
              )
            ] })
          ] }, item2.id)) })
        ] }),
        /* @__PURE__ */ jsxs("section", { "aria-label": t("completedTodayTitle"), children: [
          sectionHead(t("completedTodayTitle"), completedList.length, "completed-today-count"),
          completedList.length === 0 ? empty("completed-today-empty", /* @__PURE__ */ jsx(BotIcon, { size: 20 }), t("completedTodayEmpty"), t("completedTodayEmptyNextStep")) : /* @__PURE__ */ jsx("div", { className: "lb-group", children: completedList.map((item2) => /* @__PURE__ */ jsxs("div", { "data-testid": `completed-today-item-${item2.id}`, className: "lb-row", children: [
            face(item2.bot),
            /* @__PURE__ */ jsxs("div", { className: "lb-row-stack", children: [
              /* @__PURE__ */ jsx("div", { className: "lb-body lb-clamp-2", children: /* @__PURE__ */ jsx(Markdown, { text: activityTitle(item2, t) }) }),
              /* @__PURE__ */ jsxs("span", { className: "lb-caption", children: [
                who(item2.bot).label,
                item2.cost_cents !== null && item2.cost_cents !== void 0 && /* @__PURE__ */ jsxs(Fragment2, { children: [
                  " \xB7 ",
                  formatCents(item2.cost_cents, locale)
                ] })
              ] })
            ] }),
            /* @__PURE__ */ jsxs("button", { type: "button", className: "lb-btn lb-btn-plain", onClick: () => onSelectBot?.(item2.bot), children: [
              /* @__PURE__ */ jsx("span", { children: t("viewConversationBtn") }),
              /* @__PURE__ */ jsx(ArrowRightIcon, { size: 14 })
            ] })
          ] }, item2.id)) })
        ] })
      ] }) }),
      /* @__PURE__ */ jsxs("section", { "aria-label": t("nextRoutinesTitle"), children: [
        sectionHead(t("nextRoutinesTitle"), upcomingRoutines2.length === 0 ? t("zeroScheduled") : t("scheduledCount", { count: upcomingRoutines2.length }), "routines-count"),
        upcomingRoutines2.length === 0 ? empty(
          "hoje-routines-empty",
          /* @__PURE__ */ jsx(ClockIcon, { size: 20 }),
          t("noRoutinesScheduled"),
          t("hojeRoutinesNext"),
          onNavigateTab && /* @__PURE__ */ jsxs("button", { type: "button", className: "lb-btn", style: { marginTop: 6 }, onClick: () => onNavigateTab("rotinas"), children: [
            /* @__PURE__ */ jsx(PlusIcon, { size: 14 }),
            /* @__PURE__ */ jsx("span", { children: t("createFirstRoutine") })
          ] })
        ) : /* @__PURE__ */ jsx("div", { className: "lb-group", children: upcomingRoutines2.map((routine) => {
          const scheduleLabel = typeof routine.schedule === "object" ? routine.schedule.expr || routine.schedule.kind || "cron" : String(routine.schedule);
          return /* @__PURE__ */ jsxs("div", { "data-testid": `routine-item-${routine.id}`, className: "lb-row", children: [
            face(routine.bot),
            /* @__PURE__ */ jsxs("div", { className: "lb-row-stack", children: [
              /* @__PURE__ */ jsx("span", { className: "lb-body lb-truncate", children: routine.name }),
              /* @__PURE__ */ jsxs("span", { className: "lb-caption", children: [
                who(routine.bot).label,
                " \xB7 ",
                /* @__PURE__ */ jsx("span", { className: "lb-mono", children: scheduleLabel })
              ] })
            ] }),
            onRunRoutine && /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                className: "lb-btn",
                title: t("hojeTestRealWork"),
                onClick: () => {
                  if (confirming === `test:${routine.id}`) act(() => onRunRoutine(routine.id));
                  else setConfirming(`test:${routine.id}`);
                },
                children: confirming === `test:${routine.id}` ? t("hojeConfirmTest") : t("btnTestRoutine")
              }
            )
          ] }, routine.id);
        }) })
      ] })
    ] });
  }

  // dashboard/src/components/rules/seal.ts
  function sealVariant(r) {
    if (!r || !r.seal) return "unverified";
    switch (r.seal) {
      case "lock":
        return "lock";
      case "hand":
        return "hand";
      case "note":
      case "none":
        return "note";
      default:
        return "broken";
    }
  }
  function filterRules(rules, f) {
    const q = f.query.trim().toLowerCase();
    return rules.filter(({ rule }) => {
      if (f.botName && rule.scope.kind === "bot" && rule.scope.ref !== f.botName) return false;
      if (f.level !== "all" && rule.level !== f.level) return false;
      if (f.state !== "all" && rule.state !== f.state) return false;
      if (q && !rule.label.toLowerCase().includes(q) && !rule.match.tools?.some((x) => x.toLowerCase().includes(q)) && !rule.match.commands?.some((x) => x.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  // dashboard/src/components/rules/SealBadge.tsx
  function SealBadge({ sealResult }) {
    const { t } = useLuveI18n();
    switch (sealVariant(sealResult)) {
      case "unverified":
        return /* @__PURE__ */ jsx(
          "span",
          {
            "data-testid": "seal-unverified",
            className: "lb:inline-flex lb:items-center lb:gap-1 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]",
            children: t("sealUnverified")
          }
        );
      case "lock":
        return /* @__PURE__ */ jsxs(
          "span",
          {
            "data-testid": "seal-lock",
            className: "lb:inline-flex lb:items-center lb:gap-1.5 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-medium lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)] lb:border-[var(--color-success)]/30",
            children: [
              /* @__PURE__ */ jsx("span", { children: "\u{1F512}" }),
              /* @__PURE__ */ jsx("span", { children: t("sealLock") })
            ]
          }
        );
      case "hand":
        return /* @__PURE__ */ jsxs(
          "span",
          {
            "data-testid": "seal-hand",
            className: "lb:inline-flex lb:items-center lb:gap-1.5 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-medium lb:bg-[var(--color-primary)]/15 lb:text-[var(--color-primary)] lb:border-[var(--color-primary)]/30",
            children: [
              /* @__PURE__ */ jsx("span", { children: "\u270B" }),
              /* @__PURE__ */ jsx("span", { children: t("sealHand") })
            ]
          }
        );
      case "note":
        return /* @__PURE__ */ jsxs(
          "span",
          {
            "data-testid": "seal-note",
            className: "lb:inline-flex lb:items-center lb:gap-1.5 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-medium lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:border-[var(--lb-separator)]",
            children: [
              /* @__PURE__ */ jsx("span", { children: "\u{1F4AC}" }),
              /* @__PURE__ */ jsx("span", { children: t("sealNote") })
            ]
          }
        );
      case "broken":
        return /* @__PURE__ */ jsxs(
          "span",
          {
            "data-testid": "seal-broken",
            className: "lb:inline-flex lb:items-center lb:gap-1.5 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-semibold lb:bg-[var(--color-destructive)]/15 lb:text-[var(--color-destructive)] lb:border-[var(--color-destructive)]/40",
            children: [
              /* @__PURE__ */ jsx("span", { children: "\u26A0" }),
              /* @__PURE__ */ jsx("span", { children: t("sealBroken") })
            ]
          }
        );
    }
  }
  function SealCaveat({ sealResult }) {
    const { t } = useLuveI18n();
    const variant = sealVariant(sealResult);
    if (variant !== "hand" && variant !== "lock" || !sealResult?.qualifiers?.includes("pattern")) return null;
    return /* @__PURE__ */ jsxs("span", { "data-testid": "seal-caveat", className: "lb-caption", style: { display: "block", color: "var(--color-muted-foreground)" }, children: [
      /* @__PURE__ */ jsx("span", { style: { display: "block", fontWeight: 600 }, children: t(variant === "lock" ? "sealCaveatLock" : "sealCaveatHand") }),
      /* @__PURE__ */ jsx("span", { style: { display: "block" }, children: t("sealCaveatWhy") })
    ] });
  }

  // dashboard/src/components/rules/RulesView.tsx
  function RulesView({
    botName,
    bots = [],
    authMode: controlledAuthMode,
    initialRules,
    onRulesChanged
  }) {
    const { t } = useLuveI18n();
    const [rulesWithSeals, setRulesWithSeals] = useState(
      initialRules || []
    );
    const [loading2, setLoading] = useState(!initialRules);
    const [error, setError] = useState(null);
    const [authMode, setAuthMode] = useState(
      controlledAuthMode || "gated"
    );
    const [activeTab, setActiveTab] = useState("regras");
    const [filterLevel, setFilterLevel] = useState("all");
    const [filterState, setFilterState] = useState("all");
    const [searchQuery, setSearchQuery] = useState("");
    const [createModalOpen, setCreateModalOpen] = useState(false);
    const [newLabel, setNewLabel] = useState("");
    const [newLevel, setNewLevel] = useState("ask");
    const [newScopeKind, setNewScopeKind] = useState(
      botName ? "bot" : "global"
    );
    const [newScopeRef, setNewScopeRef] = useState(botName || "");
    const [newTools, setNewTools] = useState("");
    const [newCommands, setNewCommands] = useState("");
    const createRuleModalRef = useFocusTrap({
      isOpen: createModalOpen,
      onClose: () => setCreateModalOpen(false)
    });
    const [simBot, setSimBot] = useState(botName || (bots[0]?.name || "vendas"));
    const [simTool, setSimTool] = useState("send_email");
    const [simCommand, setSimCommand] = useState("");
    const [simResult, setSimResult] = useState(null);
    const [simLoading, setSimLoading] = useState(false);
    const [simError, setSimError] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [successMsg, setSuccessMsg] = useState(null);
    const isLoopback = authMode === "loopback";
    useEffect(() => {
      if (!controlledAuthMode) {
        getSession().then((s) => {
          if (s?.auth_mode) setAuthMode(s.auth_mode);
        }).catch(() => {
        });
      } else {
        setAuthMode(controlledAuthMode);
      }
    }, [controlledAuthMode]);
    const loadRulesList = useCallback(async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await getRules(void 0, botName);
        setRulesWithSeals(res?.rules || []);
        onRulesChanged?.();
      } catch (err) {
        setError(humanError(err, t, "errorLoadingRules"));
      } finally {
        setLoading(false);
      }
    }, [onRulesChanged, t, botName]);
    useEffect(() => {
      if (!initialRules) {
        loadRulesList();
      }
    }, [initialRules, loadRulesList]);
    const displayedRules = useMemo(
      () => filterRules(rulesWithSeals, { botName, level: filterLevel, state: filterState, query: searchQuery }),
      [rulesWithSeals, botName, filterLevel, filterState, searchQuery]
    );
    const handleActivateRule = async (rule) => {
      if (isLoopback) {
        setError(t("errorLoopbackRuleBlocked"));
        return;
      }
      if (rule.builtin) return;
      try {
        setIsSubmitting(true);
        setError(null);
        const res = await patchRule({
          id: rule.id,
          version: rule.version,
          state: "active"
        });
        setRulesWithSeals(
          (prev) => prev.map(
            (item2) => item2.rule.id === rule.id ? { ...item2, rule: res.rule, seal_result: res.seal_result } : item2
          )
        );
        setSuccessMsg(t("ruleActivatedSuccess", { label: rule.label }));
        setTimeout(() => setSuccessMsg(null), 4e3);
        onRulesChanged?.();
      } catch (err) {
        handleApiError(err);
      } finally {
        setIsSubmitting(false);
      }
    };
    const handleReviewSuggestion = async (rule) => {
      if (rule.builtin) return;
      try {
        setIsSubmitting(true);
        setError(null);
        const res = await patchRule({
          id: rule.id,
          version: rule.version,
          state: "draft"
        });
        setRulesWithSeals(
          (prev) => prev.map(
            (item2) => item2.rule.id === rule.id ? { ...item2, rule: res.rule, seal_result: res.seal_result } : item2
          )
        );
        setSuccessMsg(t("ruleDraftConverted", { label: rule.label }));
        setTimeout(() => setSuccessMsg(null), 4e3);
        onRulesChanged?.();
      } catch (err) {
        handleApiError(err);
      } finally {
        setIsSubmitting(false);
      }
    };
    const handleArchiveRule = async (rule) => {
      if (rule.builtin) return;
      try {
        setIsSubmitting(true);
        setError(null);
        const res = await patchRule({
          id: rule.id,
          version: rule.version,
          state: "archived"
        });
        setRulesWithSeals(
          (prev) => prev.map(
            (item2) => item2.rule.id === rule.id ? { ...item2, rule: res.rule, seal_result: res.seal_result } : item2
          )
        );
        setSuccessMsg(t("ruleArchivedSuccess", { label: rule.label }));
        setTimeout(() => setSuccessMsg(null), 4e3);
        onRulesChanged?.();
      } catch (err) {
        handleApiError(err);
      } finally {
        setIsSubmitting(false);
      }
    };
    const handleCreateRule = async (e) => {
      e.preventDefault();
      if (!newLabel.trim()) return;
      try {
        setIsSubmitting(true);
        setError(null);
        const toolsList = newTools.split(",").map((t2) => t2.trim()).filter(Boolean);
        const cmdsList = newCommands.split(",").map((c) => c.trim()).filter(Boolean);
        const res = await createRule({
          label: newLabel.trim(),
          level: newLevel,
          scope: {
            kind: newScopeKind,
            ref: newScopeKind === "bot" ? newScopeRef || botName : null
          },
          match: {
            tools: toolsList.length > 0 ? toolsList : void 0,
            commands: cmdsList.length > 0 ? cmdsList : void 0
          },
          state: "draft"
          // Human creation produces draft
        });
        setRulesWithSeals((prev) => [
          { rule: res.rule, seal_result: res.seal_result },
          ...prev
        ]);
        setCreateModalOpen(false);
        setNewLabel("");
        setNewTools("");
        setNewCommands("");
        setSuccessMsg(t("ruleDraftCreated", { label: res.rule.label }));
        setTimeout(() => setSuccessMsg(null), 4e3);
        onRulesChanged?.();
      } catch (err) {
        handleApiError(err);
      } finally {
        setIsSubmitting(false);
      }
    };
    const handleRunSimulation = async (e) => {
      e.preventDefault();
      if (!simBot || !simTool) return;
      try {
        setSimLoading(true);
        setSimError(null);
        setSimResult(null);
        const actionPayload = {
          bot: simBot,
          tool: simTool.trim(),
          command: simCommand.trim() || void 0
        };
        const result = await simulateRule(actionPayload);
        setSimResult(result);
      } catch (err) {
        setSimError(humanError(err, t, "errorSimulatingRule"));
      } finally {
        setSimLoading(false);
      }
    };
    const handleApiError = (err) => {
      if (err instanceof ApiError) {
        if (err.code === "loopback_not_human" || err.status === 403) {
          setError(t("errorLoopbackRuleBlocked"));
        } else if (err.code === "builtin_immutable") {
          setError(t("errorBuiltinImmutable"));
        } else if (err.code === "stale") {
          setError(t("errorStaleRule"));
        } else {
          setError(humanError(err, t, "errorUnexpectedRule"));
        }
      } else {
        setError(humanError(err, t, "errorUnexpectedRule"));
      }
    };
    const renderSealBadge = (sealResult) => /* @__PURE__ */ jsx(SealBadge, { sealResult });
    const getLevelLabel = (level) => {
      switch (level) {
        case "allow":
          return t("levelAllow");
        case "explicit":
          return t("levelExplicit");
        case "ask":
          return t("levelAsk");
        case "handback":
          return t("levelHandback");
        case "block":
          return t("levelBlock");
      }
    };
    const getLevelBadgeClass = (level) => {
      switch (level) {
        case "block":
          return "lb:bg-[var(--color-destructive)]/15 lb:text-[var(--color-destructive)]";
        case "handback":
          return "lb:bg-[var(--color-warning)]/15 lb:text-[var(--color-warning)]";
        case "ask":
          return "lb:bg-[var(--color-primary)]/15 lb:text-[var(--color-primary)]";
        case "explicit":
          return "lb:bg-[var(--color-accent)] lb:text-[var(--color-card-foreground)]";
        case "allow":
          return "lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)]";
      }
    };
    const botLabel = (name) => bots.find((b) => b.name === name)?.display?.label || name;
    const scopeText = (scope) => scope.kind === "global" ? t("ruleScopeGlobal") : scope.kind === "bot" ? botLabel(scope.ref || "") : scope.kind === "room" ? t("ruleScopeRoom", { name: scope.ref || "" }) : scope.kind === "routine" ? t("ruleScopeRoutine", { name: scope.ref || "" }) : scope.kind;
    return /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:h-full lb:w-full lb:overflow-hidden lb:bg-[var(--background)] lb:text-[var(--color-foreground)]", children: [
      /* @__PURE__ */ jsxs("header", { className: "lb:px-6 lb:pt-6 lb:pb-2 lb:flex lb:flex-wrap lb:items-center lb:justify-between lb:gap-3 lb:shrink-0", children: [
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("h1", { className: "lb-large-title", children: botName ? t("rulesTitleBot", { bot: botLabel(botName) }) : t("rulesTitle") }),
          /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("rulesSubtitle") })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
          /* @__PURE__ */ jsxs("div", { role: "tablist", "aria-label": t("rulesTabRules", { count: displayedRules.length }), className: "lb-segmented", children: [
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                role: "tab",
                "aria-selected": activeTab === "regras",
                onClick: () => setActiveTab("regras"),
                className: "lb-segment",
                style: { padding: "0 12px", flex: "none" },
                children: t("rulesTabRules", { count: displayedRules.length })
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                role: "tab",
                "aria-selected": activeTab === "simulador",
                onClick: () => setActiveTab("simulador"),
                className: "lb-segment",
                style: { padding: "0 12px", flex: "none" },
                children: t("rulesTabSimulator")
              }
            )
          ] }),
          /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              onClick: () => setCreateModalOpen(true),
              className: "lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:motion-safe:transition-opacity focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
              children: [
                /* @__PURE__ */ jsx(PlusIcon, { size: 13 }),
                /* @__PURE__ */ jsx("span", { children: t("newRuleBtn") })
              ]
            }
          ),
          /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              onClick: loadRulesList,
              disabled: loading2,
              "aria-label": t("refreshRules"),
              className: "lb:p-1.5 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] disabled:lb:opacity-50",
              children: /* @__PURE__ */ jsx(RefreshCwIcon, { size: 14, className: loading2 ? "lb:animate-spin" : "" })
            }
          )
        ] })
      ] }),
      isLoopback && /* @__PURE__ */ jsxs(
        "div",
        {
          role: "alert",
          className: "lb:px-4 lb:py-2.5 lb:bg-[var(--color-warning)]/15 lb:border-b lb:border-[var(--color-warning)]/30 lb:text-[var(--color-warning)] lb:flex lb:items-center lb:gap-2.5 lb:text-[13px] lb:shrink-0",
          children: [
            /* @__PURE__ */ jsx(ShieldAlertIcon, { size: 16, className: "lb:shrink-0" }),
            /* @__PURE__ */ jsx("span", { children: t("loopbackWarningRules") })
          ]
        }
      ),
      error && /* @__PURE__ */ jsxs(
        "div",
        {
          role: "alert",
          className: "lb:px-4 lb:py-2.5 lb:bg-[var(--color-destructive)]/15 lb:border-b lb:border-[var(--color-destructive)]/30 lb:text-[var(--color-destructive)] lb:flex lb:items-center lb:justify-between lb:gap-2 lb:text-[13px] lb:shrink-0",
          children: [
            /* @__PURE__ */ jsx("span", { children: /* @__PURE__ */ jsx(ErrorNote, { error }) }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setError(null), "aria-label": t("closeError"), children: /* @__PURE__ */ jsx(XIcon, { size: 14 }) })
          ]
        }
      ),
      successMsg && /* @__PURE__ */ jsxs(
        "div",
        {
          role: "status",
          className: "lb:px-4 lb:py-2.5 lb:bg-[var(--color-success)]/15 lb:border-b lb:border-[var(--color-success)]/30 lb:text-[var(--color-success)] lb:flex lb:items-center lb:gap-2 lb:text-[13px] lb:shrink-0",
          children: [
            /* @__PURE__ */ jsx(CheckIcon, { size: 14 }),
            /* @__PURE__ */ jsx("span", { children: successMsg })
          ]
        }
      ),
      activeTab === "regras" && /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:flex-1 lb:overflow-hidden", children: [
        /* @__PURE__ */ jsxs("div", { className: "lb:px-4 lb:py-2.5 lb:border-b lb:border-[var(--lb-separator)] lb:bg-[var(--color-card)]/50 lb:flex lb:flex-wrap lb:items-center lb:justify-between lb:gap-2 lb:shrink-0", children: [
          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2 lb:flex-wrap", children: [
            /* @__PURE__ */ jsx(
              "input",
              {
                type: "text",
                value: searchQuery,
                onChange: (e) => setSearchQuery(e.target.value),
                placeholder: t("searchRulesPlaceholder"),
                className: "lb:px-2.5 lb:py-1 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] lb:w-80 focus:lb:outline-none focus:lb:border-[var(--color-primary)]"
              }
            ),
            /* @__PURE__ */ jsxs(
              "select",
              {
                "aria-label": t("filterByLevel"),
                value: filterLevel,
                onChange: (e) => setFilterLevel(e.target.value),
                className: "lb:px-2 lb:py-1 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:border-[var(--color-primary)]",
                children: [
                  /* @__PURE__ */ jsx("option", { value: "all", children: t("filterAllLevels") }),
                  /* @__PURE__ */ jsx("option", { value: "block", children: t("levelBlock") }),
                  /* @__PURE__ */ jsx("option", { value: "handback", children: t("levelHandback") }),
                  /* @__PURE__ */ jsx("option", { value: "ask", children: t("levelAsk") }),
                  /* @__PURE__ */ jsx("option", { value: "explicit", children: t("levelExplicit") }),
                  /* @__PURE__ */ jsx("option", { value: "allow", children: t("levelAllow") })
                ]
              }
            ),
            /* @__PURE__ */ jsxs(
              "select",
              {
                "aria-label": t("filterByState"),
                value: filterState,
                onChange: (e) => setFilterState(e.target.value),
                className: "lb:px-2 lb:py-1 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:border-[var(--color-primary)]",
                children: [
                  /* @__PURE__ */ jsx("option", { value: "all", children: t("filterAllStates") }),
                  /* @__PURE__ */ jsx("option", { value: "active", children: t("filterActive") }),
                  /* @__PURE__ */ jsx("option", { value: "draft", children: t("filterDrafts") }),
                  /* @__PURE__ */ jsx("option", { value: "suggestion", children: t("filterSuggestions") }),
                  /* @__PURE__ */ jsx("option", { value: "archived", children: t("filterArchived") })
                ]
              }
            )
          ] }),
          /* @__PURE__ */ jsx("div", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("precedenceRuleText") })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "lb:flex-1 lb:overflow-y-auto lb:p-4 lb:space-y-3 luvebot-scroll-container", children: [
          displayedRules.length === 0 && !loading2 && /* @__PURE__ */ jsxs(
            "div",
            {
              "data-testid": "rules-empty-state",
              className: "lb:p-12 lb:text-center lb:flex lb:flex-col lb:items-center lb:justify-center lb:gap-2 lb:border-dashed lb:border-[var(--lb-separator)] lb:rounded-2xl lb:bg-[var(--color-card)]/50",
              children: [
                /* @__PURE__ */ jsx(CheckCircleIcon, { size: 24, className: "lb:text-[var(--color-muted-foreground)]" }),
                /* @__PURE__ */ jsx("h3", { className: "lb-headline", children: t("noRulesFoundTitle") }),
                /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("noRulesFoundDesc") }),
                /* @__PURE__ */ jsxs(
                  "button",
                  {
                    type: "button",
                    onClick: () => setCreateModalOpen(true),
                    className: "lb:mt-2 lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:text-[13px] lb:font-semibold lb:hover:opacity-90 lb:motion-safe:transition-opacity lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                    children: [
                      /* @__PURE__ */ jsx(PlusIcon, { size: 14 }),
                      /* @__PURE__ */ jsx("span", { children: t("newRuleBtn") })
                    ]
                  }
                )
              ]
            }
          ),
          displayedRules.map(({ rule, seal_result }) => {
            const isDraft = rule.state === "draft";
            const isSuggestion = rule.state === "suggestion";
            const isBuiltin = rule.builtin;
            const isBroken = seal_result?.seal === "broken";
            const hasProblems = seal_result?.problems && seal_result.problems.length > 0;
            return /* @__PURE__ */ jsxs(
              "div",
              {
                "data-testid": `rule-card-${rule.id}`,
                className: `lb:rounded-2xl lb:p-4 lb:flex lb:flex-col lb:gap-3 lb:motion-safe:transition-colors ${isDraft ? "lb:border-dashed lb:border-[var(--color-warning)]/40 lb:bg-[var(--color-card)]/80" : isSuggestion ? "lb:border-dashed lb:border-[var(--color-primary)]/40 lb:bg-[var(--color-card)]/80" : isBroken ? "lb:border-[var(--color-destructive)]/40 lb:bg-[var(--lb-fill)]" : "lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)]"}`,
                children: [
                  /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-start lb:justify-between lb:gap-2", children: [
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2 lb:flex-wrap", children: [
                      /* @__PURE__ */ jsx(
                        "span",
                        {
                          className: `lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-[13px] lb:font-bold ${getLevelBadgeClass(
                            rule.level
                          )}`,
                          children: getLevelLabel(rule.level)
                        }
                      ),
                      /* @__PURE__ */ jsx("h3", { className: "lb:text-[13px] lb:font-bold lb:text-[var(--color-card-foreground)]", children: rule.label }),
                      isBuiltin && /* @__PURE__ */ jsx(
                        "span",
                        {
                          "data-testid": "badge-builtin",
                          className: "lb:inline-flex lb:items-center lb:gap-1 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-semibold lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:border-[var(--lb-separator)]",
                          children: t("badgeBuiltin")
                        }
                      ),
                      isDraft && /* @__PURE__ */ jsx(
                        "span",
                        {
                          "data-testid": "badge-draft",
                          className: "lb:inline-flex lb:items-center lb:gap-1 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-semibold lb:bg-[var(--color-warning)]/15 lb:text-[var(--color-warning)] lb:border-[var(--color-warning)]/30",
                          children: t("badgeDraft")
                        }
                      ),
                      isSuggestion && /* @__PURE__ */ jsx(
                        "span",
                        {
                          "data-testid": "badge-suggestion",
                          className: "lb:inline-flex lb:items-center lb:gap-1 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-semibold lb:bg-[var(--color-primary)]/15 lb:text-[var(--color-primary)] lb:border-[var(--color-primary)]/30",
                          children: t("badgeSuggestion")
                        }
                      ),
                      /* @__PURE__ */ jsx("span", { className: "lb-pill lb-caption", children: scopeText(rule.scope) })
                    ] }),
                    /* @__PURE__ */ jsx("div", { className: "lb:shrink-0", children: renderSealBadge(seal_result) })
                  ] }),
                  /* @__PURE__ */ jsxs("div", { className: "lb:space-y-1.5 lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: [
                    rule.match.tools && rule.match.tools.length > 0 && /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-1.5 lb:flex-wrap", children: [
                      /* @__PURE__ */ jsx("span", { className: "lb:font-medium", children: t("toolsLabel") }),
                      rule.match.tools.map((toolName) => /* @__PURE__ */ jsx(
                        "span",
                        {
                          className: "lb:font-mono lb:text-xs lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:bg-[var(--background)] lb:border-[var(--lb-separator)]",
                          children: toolName
                        },
                        toolName
                      ))
                    ] }),
                    rule.match.commands && rule.match.commands.length > 0 && /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-1.5 lb:flex-wrap", children: [
                      /* @__PURE__ */ jsx("span", { className: "lb:font-medium", children: t("commandsLabel") }),
                      rule.match.commands.map((cmd) => /* @__PURE__ */ jsx(
                        "span",
                        {
                          className: "lb:font-mono lb:text-xs lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:bg-[var(--background)] lb:border-[var(--lb-separator)]",
                          children: cmd
                        },
                        cmd
                      ))
                    ] })
                  ] }),
                  /* @__PURE__ */ jsx(SealCaveat, { sealResult: seal_result }),
                  (isBroken || hasProblems) && /* @__PURE__ */ jsxs(
                    "div",
                    {
                      "data-testid": `rule-problems-${rule.id}`,
                      className: "lb:p-2.5 lb:rounded-xl lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:space-y-1 lb:text-[13px]",
                      children: [
                        /* @__PURE__ */ jsx("div", { className: "lb:font-semibold lb:text-[var(--color-destructive)] lb:flex lb:items-center lb:gap-1.5", children: /* @__PURE__ */ jsx("span", { children: t("problemsDetectedTitle") }) }),
                        /* @__PURE__ */ jsx("ul", { className: "lb:list-disc lb:list-inside lb:space-y-0.5 lb:text-[var(--color-destructive)]", children: seal_result?.problems?.map((p, idx) => /* @__PURE__ */ jsxs("li", { children: [
                          /* @__PURE__ */ jsx("code", { className: "lb:font-mono lb:font-bold", children: p.code }),
                          ":",
                          " ",
                          p.detail
                        ] }, idx)) }),
                        seal_result?.qualifiers && seal_result.qualifiers.length > 0 && /* @__PURE__ */ jsxs("div", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)] lb:mt-1", children: [
                          t("qualifiersLabel"),
                          " ",
                          /* @__PURE__ */ jsx("span", { className: "lb:font-mono", children: seal_result.qualifiers.join(", ") })
                        ] })
                      ]
                    }
                  ),
                  /* @__PURE__ */ jsxs("div", { className: "lb:pt-2 lb:border-t lb:border-[var(--lb-separator)] lb:flex lb:items-center lb:justify-between lb:gap-2", children: [
                    /* @__PURE__ */ jsx("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)]", children: isBuiltin ? t("statusBuiltinProtection") : isDraft ? t("statusDraftInactive") : isSuggestion ? t("statusHumanReviewNeeded") : t("statusActiveVersion", { version: rule.version }) }),
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                      isDraft && /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          disabled: isLoopback || isSubmitting,
                          title: isLoopback ? t("errorLoopbackRuleBlocked") : void 0,
                          onClick: () => handleActivateRule(rule),
                          className: "lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 disabled:lb:opacity-50 lb:rounded-full",
                          children: t("activateRuleBtn")
                        }
                      ),
                      isSuggestion && /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          disabled: isSubmitting,
                          onClick: () => handleReviewSuggestion(rule),
                          className: "lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--color-primary)] lb:text-[var(--color-primary)] lb:hover:bg-[var(--color-primary)]/10 lb:rounded-full",
                          children: t("reviewAsDraftBtn")
                        }
                      ),
                      !isBuiltin && rule.state !== "archived" && /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          disabled: isSubmitting,
                          onClick: () => handleArchiveRule(rule),
                          className: "lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-destructive)] lb:rounded-full",
                          children: t("archiveBtn")
                        }
                      )
                    ] })
                  ] })
                ]
              },
              rule.id
            );
          })
        ] })
      ] }),
      activeTab === "simulador" && /* @__PURE__ */ jsx("div", { className: "lb:flex-1 lb:overflow-y-auto lb:p-6 lb:space-y-6 luvebot-scroll-container", children: /* @__PURE__ */ jsxs("div", { className: "lb:max-w-2xl lb:mx-auto lb:space-y-5", children: [
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("h2", { className: "lb-title", children: t("simulatorTitle") }),
          /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("simulatorSubtitle") })
        ] }),
        /* @__PURE__ */ jsxs(
          "form",
          {
            onSubmit: handleRunSimulation,
            className: "lb:p-4 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:space-y-4",
            children: [
              /* @__PURE__ */ jsxs("div", { className: "lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-3", children: [
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx(
                    "label",
                    {
                      htmlFor: "sim-bot-select",
                      className: "lb-label lb:block lb:mb-1",
                      children: t("simBotLabel")
                    }
                  ),
                  /* @__PURE__ */ jsx(
                    "select",
                    {
                      id: "sim-bot-select",
                      value: simBot,
                      onChange: (e) => setSimBot(e.target.value),
                      className: "lb-input",
                      children: bots.length > 0 ? bots.map((b) => /* @__PURE__ */ jsx("option", { value: b.name, children: b.display?.label || b.name }, b.name)) : /* @__PURE__ */ jsx("option", { value: "vendas", children: "vendas" })
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx(
                    "label",
                    {
                      htmlFor: "sim-tool-input",
                      className: "lb-label lb:block lb:mb-1",
                      children: t("simToolLabel")
                    }
                  ),
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      id: "sim-tool-input",
                      type: "text",
                      required: true,
                      value: simTool,
                      onChange: (e) => setSimTool(e.target.value),
                      placeholder: t("simToolPlaceholder"),
                      className: "lb-input"
                    }
                  )
                ] })
              ] }),
              /* @__PURE__ */ jsxs("div", { children: [
                /* @__PURE__ */ jsx(
                  "label",
                  {
                    htmlFor: "sim-command-input",
                    className: "lb-label lb:block lb:mb-1",
                    children: t("simCommandLabel")
                  }
                ),
                /* @__PURE__ */ jsx(
                  "input",
                  {
                    id: "sim-command-input",
                    type: "text",
                    value: simCommand,
                    onChange: (e) => setSimCommand(e.target.value),
                    placeholder: t("simCommandPlaceholder"),
                    className: "lb-input"
                  }
                )
              ] }),
              /* @__PURE__ */ jsx("div", { className: "lb:flex lb:justify-end", children: /* @__PURE__ */ jsxs(
                "button",
                {
                  type: "submit",
                  disabled: simLoading || !simTool.trim(),
                  className: "lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3.5 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 disabled:lb:opacity-50 lb:rounded-full",
                  children: [
                    /* @__PURE__ */ jsx(PlayIcon, { size: 12 }),
                    /* @__PURE__ */ jsx("span", { children: simLoading ? t("simEvaluating") : t("simEvaluateBtn") })
                  ]
                }
              ) })
            ]
          }
        ),
        simError && /* @__PURE__ */ jsx(
          "div",
          {
            role: "alert",
            className: "lb:p-3 lb:rounded-xl lb:bg-[var(--color-destructive)]/15 lb:text-[var(--color-destructive)] lb:text-[13px]",
            children: /* @__PURE__ */ jsx(ErrorNote, { error: simError })
          }
        ),
        simResult && /* @__PURE__ */ jsxs(
          "div",
          {
            "data-testid": "simulation-result",
            className: "lb:p-5 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:space-y-4 lb:animate-in lb:fade-in",
            children: [
              /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:border-b lb:border-[var(--lb-separator)] lb:pb-3", children: [
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)]", children: t("simResultEvaluation") }),
                  /* @__PURE__ */ jsx("div", { className: "lb:flex lb:items-center lb:gap-2 lb:mt-0.5", children: /* @__PURE__ */ jsx(
                    "span",
                    {
                      className: `lb:px-2.5 lb:py-0.5 lb:rounded-lg lb:text-[13px] lb:font-bold ${getLevelBadgeClass(
                        simResult.decision.effect
                      )}`,
                      children: getLevelLabel(simResult.decision.effect)
                    }
                  ) })
                ] }),
                simResult.decision.winner && /* @__PURE__ */ jsxs("div", { className: "lb:text-right", children: [
                  /* @__PURE__ */ jsx("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)]", children: t("simWinningRuleLabel") }),
                  /* @__PURE__ */ jsx("div", { className: "lb:text-[13px] lb:font-semibold lb:text-[var(--color-card-foreground)]", children: simResult.decision.winner.rule_id })
                ] })
              ] }),
              simResult.decision.reason && /* @__PURE__ */ jsxs("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: [
                /* @__PURE__ */ jsx("strong", { children: t("simReasonLabel") }),
                " ",
                simResult.decision.reason
              ] }),
              /* @__PURE__ */ jsxs("div", { children: [
                /* @__PURE__ */ jsx("h4", { className: "lb:text-[13px] lb:font-semibold lb:text-[var(--color-card-foreground)] lb:mb-2", children: t("simMatchingRulesTitle", { count: simResult.decision.hits?.length || 0 }) }),
                simResult.decision.hits && simResult.decision.hits.length > 0 ? /* @__PURE__ */ jsx("div", { className: "lb:space-y-2", children: simResult.decision.hits.map((hit, idx) => /* @__PURE__ */ jsxs(
                  "div",
                  {
                    className: "lb:p-2.5 lb:rounded-lg lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:flex lb:items-center lb:justify-between lb:text-[13px]",
                    children: [
                      /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                        /* @__PURE__ */ jsx(
                          "span",
                          {
                            className: `lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-bold ${getLevelBadgeClass(
                              hit.level
                            )}`,
                            children: hit.level
                          }
                        ),
                        /* @__PURE__ */ jsx("span", { className: "lb:font-semibold lb:text-[var(--color-card-foreground)]", children: hit.rule_id }),
                        /* @__PURE__ */ jsx("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)]", children: t("simMatchedOn", { pattern: hit.matched_on }) })
                      ] }),
                      /* @__PURE__ */ jsx("span", { className: "lb-caption lb:text-[var(--color-muted-foreground)]", children: scopeText(hit.scope) })
                    ]
                  },
                  idx
                )) }) : /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("simNoMatchingRules") })
              ] })
            ]
          }
        )
      ] }) }),
      createModalOpen && /* @__PURE__ */ jsx(
        "div",
        {
          ref: createRuleModalRef,
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "create-rule-title",
          className: "lb-dialog-overlay",
          children: /* @__PURE__ */ jsxs(
            "form",
            {
              onSubmit: handleCreateRule,
              className: "lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto",
              children: [
                /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-start lb:justify-between lb:gap-2", children: [
                  /* @__PURE__ */ jsx(
                    "h2",
                    {
                      id: "create-rule-title",
                      className: "lb-title",
                      children: t("newRuleModalTitle")
                    }
                  ),
                  /* @__PURE__ */ jsx(
                    "button",
                    {
                      type: "button",
                      "aria-label": t("close"),
                      onClick: () => setCreateModalOpen(false),
                      className: "lb-icon-btn",
                      style: { background: "var(--lb-fill)" },
                      children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
                    }
                  )
                ] }),
                /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("newRuleModalDesc") }),
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx(
                    "label",
                    {
                      htmlFor: "new-rule-label",
                      className: "lb-label lb:block lb:mb-1",
                      children: t("ruleLabelInput")
                    }
                  ),
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      id: "new-rule-label",
                      type: "text",
                      required: true,
                      value: newLabel,
                      onChange: (e) => setNewLabel(e.target.value),
                      placeholder: t("ruleLabelPlaceholder"),
                      className: "lb-input"
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx(
                    "label",
                    {
                      htmlFor: "new-rule-level",
                      className: "lb-label lb:block lb:mb-1",
                      children: t("ruleLevelInput")
                    }
                  ),
                  /* @__PURE__ */ jsxs(
                    "select",
                    {
                      id: "new-rule-level",
                      value: newLevel,
                      onChange: (e) => setNewLevel(e.target.value),
                      className: "lb-input",
                      children: [
                        /* @__PURE__ */ jsx("option", { value: "block", children: t("levelBlock") }),
                        /* @__PURE__ */ jsx("option", { value: "handback", children: t("levelHandback") }),
                        /* @__PURE__ */ jsx("option", { value: "ask", children: t("levelAsk") }),
                        /* @__PURE__ */ jsx("option", { value: "explicit", children: t("levelExplicit") }),
                        /* @__PURE__ */ jsx("option", { value: "allow", children: t("levelAllow") })
                      ]
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "lb:grid lb:grid-cols-2 lb:gap-3", children: [
                  /* @__PURE__ */ jsxs("div", { children: [
                    /* @__PURE__ */ jsx(
                      "label",
                      {
                        htmlFor: "new-rule-scope",
                        className: "lb-label lb:block lb:mb-1",
                        children: t("ruleScopeKindInput")
                      }
                    ),
                    /* @__PURE__ */ jsxs(
                      "select",
                      {
                        id: "new-rule-scope",
                        value: newScopeKind,
                        onChange: (e) => setNewScopeKind(e.target.value),
                        className: "lb-input",
                        children: [
                          /* @__PURE__ */ jsx("option", { value: "global", children: t("scopeGlobal") }),
                          /* @__PURE__ */ jsx("option", { value: "bot", children: t("scopeBot") })
                        ]
                      }
                    )
                  ] }),
                  newScopeKind === "bot" && /* @__PURE__ */ jsxs("div", { children: [
                    /* @__PURE__ */ jsx(
                      "label",
                      {
                        htmlFor: "new-rule-bot-ref",
                        className: "lb-label lb:block lb:mb-1",
                        children: t("targetBotInput")
                      }
                    ),
                    /* @__PURE__ */ jsx(
                      "input",
                      {
                        id: "new-rule-bot-ref",
                        type: "text",
                        value: newScopeRef,
                        onChange: (e) => setNewScopeRef(e.target.value),
                        placeholder: "vendas",
                        className: "lb-input"
                      }
                    )
                  ] })
                ] }),
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx(
                    "label",
                    {
                      htmlFor: "new-rule-tools",
                      className: "lb-label lb:block lb:mb-1",
                      children: t("toolsMatchInput")
                    }
                  ),
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      id: "new-rule-tools",
                      type: "text",
                      value: newTools,
                      onChange: (e) => setNewTools(e.target.value),
                      placeholder: t("toolsMatchPlaceholder"),
                      className: "lb-input"
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx(
                    "label",
                    {
                      htmlFor: "new-rule-commands",
                      className: "lb-label lb:block lb:mb-1",
                      children: t("commandsMatchInput")
                    }
                  ),
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      id: "new-rule-commands",
                      type: "text",
                      value: newCommands,
                      onChange: (e) => setNewCommands(e.target.value),
                      placeholder: t("commandsMatchPlaceholder"),
                      className: "lb-input"
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2", children: [
                  /* @__PURE__ */ jsx(
                    "button",
                    {
                      type: "button",
                      onClick: () => setCreateModalOpen(false),
                      className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                      children: t("cancelBtn")
                    }
                  ),
                  /* @__PURE__ */ jsx(
                    "button",
                    {
                      type: "submit",
                      disabled: isSubmitting || !newLabel.trim(),
                      className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 disabled:lb:opacity-50 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                      children: t("createDraftBtn")
                    }
                  )
                ] })
              ]
            }
          )
        }
      )
    ] });
  }

  // dashboard/src/components/ui/MascotPicker.tsx
  function MascotPicker({ value, onPick, color }) {
    const { t } = useLuveI18n();
    return /* @__PURE__ */ jsx("div", { role: "group", "aria-label": t("mascotPickerLabel"), className: "lb-mascot-grid", children: MASCOTS.map((m) => /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        "aria-pressed": value === m.id,
        "aria-label": m.name,
        title: m.name,
        onClick: () => onPick(m.id),
        className: "lb-mascot-pick",
        children: /* @__PURE__ */ jsx(Avatar, { name: m.name, avatar: { kind: "mascot", value: m.id }, color, size: 40 })
      },
      m.id
    )) });
  }

  // dashboard/src/lib/botName.ts
  function displayName(name, label) {
    if (label && label !== name) return label;
    return name.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || name;
  }
  function withDisplayName(bot) {
    if (!bot.display) return bot;
    const label = displayName(bot.name, bot.display.label);
    return label === bot.display.label ? bot : { ...bot, display: { ...bot.display, label } };
  }

  // dashboard/src/components/bots/BotProfile.tsx
  function BotProfile({
    botName,
    initialBot,
    onClose,
    onBotUpdated
  }) {
    const { t } = useLuveI18n();
    const [activeTab, setActiveTab] = useState("identidade");
    const [bot, setBot] = useState(initialBot || null);
    const [loading2, setLoading] = useState(!initialBot);
    const [error, setError] = useState(null);
    const [label, setLabel] = useState(initialBot?.display?.label || botName);
    const [role, setRole] = useState(initialBot?.display?.role || "");
    const [callMe, setCallMe] = useState(initialBot?.display?.call_me || "");
    const [color, setColor] = useState(initialBot?.display?.color || "#38bdf8");
    const [avatarValue, setAvatarValue] = useState(initialBot?.display?.avatar?.value || "\u{1F916}");
    const [avatarKind, setAvatarKind] = useState(initialBot?.display?.avatar?.kind || "emoji");
    const [isSavingDisplay, setIsSavingDisplay] = useState(false);
    const [saveSuccessMessage, setSaveSuccessMessage] = useState(null);
    const [soul, setSoul] = useState(initialBot?.soul || "");
    useEffect(() => {
      let cancelled = false;
      async function load() {
        try {
          setLoading(true);
          setError(null);
          const data = withDisplayName(await getBot(botName));
          if (!cancelled) {
            setBot(data);
            setLabel(data.display?.label || data.name);
            setRole(data.display?.role || "");
            setCallMe(data.display?.call_me || "");
            setColor(data.display?.color || "#38bdf8");
            setAvatarValue(data.display?.avatar?.value || "\u{1F916}");
            setAvatarKind(data.display?.avatar?.kind || "emoji");
            setSoul(data.soul || "");
          }
        } catch (err) {
          if (!cancelled) {
            const msg = humanError(err, t, "errorLoadingBots");
            setError(msg);
          }
        } finally {
          if (!cancelled) {
            setLoading(false);
          }
        }
      }
      if (!initialBot || initialBot.name !== botName) {
        load();
      }
      return () => {
        cancelled = true;
      };
    }, [botName, initialBot, t]);
    useEffect(() => {
      if (!onClose) return;
      const handleKeyDown = (e) => {
        if (e.key === "Escape") {
          onClose();
        }
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [onClose]);
    const handleSaveDisplay = async (e) => {
      e.preventDefault();
      setIsSavingDisplay(true);
      setSaveSuccessMessage(null);
      setError(null);
      try {
        const avatar = { kind: avatarKind, value: avatarValue.trim() || "\u{1F916}" };
        const updatedBot = await updateBotDisplay(botName, {
          label: label.trim(),
          role: role.trim(),
          call_me: callMe.trim() || null,
          color,
          avatar
        });
        const fullUpdated = {
          ...bot || {},
          ...updatedBot,
          soul: bot?.soul || ""
        };
        setBot(fullUpdated);
        setSaveSuccessMessage(t("identitySaveSuccess"));
        onBotUpdated?.(fullUpdated);
        setTimeout(() => setSaveSuccessMessage(null), 3e3);
      } catch (err) {
        const msg = humanError(err, t, "errorSaving");
        setError(msg);
      } finally {
        setIsSavingDisplay(false);
      }
    };
    if (loading2) {
      return /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:items-center lb:justify-center lb:p-12 lb:text-[15px] lb:text-[var(--color-muted-foreground)]", "aria-busy": "true", children: [
        /* @__PURE__ */ jsx("div", { className: "lb:w-6 lb:h-6 lb:border-2 lb:border-[var(--color-primary)] lb:border-t-transparent lb:rounded-full lb:animate-spin lb:mb-3" }),
        /* @__PURE__ */ jsx("span", { children: t("profileLoading") })
      ] });
    }
    return /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:h-full lb:w-full lb:bg-[var(--background)] lb:overflow-y-auto", "data-testid": "bot-profile", children: [
      /* @__PURE__ */ jsxs("header", { className: "lb:px-6 lb:pt-6 lb:pb-2 lb:shrink-0", children: [
        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:gap-4 lb:max-w-4xl lb:mx-auto", children: [
          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-3.5", children: [
            /* @__PURE__ */ jsx(Avatar, { name: label || botName, avatar: displayFace(botName, { kind: avatarKind, value: avatarValue }), color, size: 56 }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                /* @__PURE__ */ jsx("h1", { className: "lb-large-title", children: label || botName }),
                bot && /* @__PURE__ */ jsx(AttentionBadge, { state: attention(bot) })
              ] }),
              /* @__PURE__ */ jsx("p", { className: "lb-subhead lb:text-[var(--color-muted-foreground)] lb:mt-0.5", children: role || t("defaultRoleAgent") })
            ] })
          ] }),
          onClose && /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              onClick: onClose,
              "aria-label": t("closeProfile"),
              className: "lb:p-2 lb:min-h-11 lb:min-w-11 lb:flex lb:items-center lb:justify-center lb:rounded-xl lb:hover:bg-[var(--lb-fill-2)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none",
              children: /* @__PURE__ */ jsx(XIcon, { size: 18 })
            }
          )
        ] }),
        /* @__PURE__ */ jsxs("div", { role: "tablist", "aria-label": t("botProfileTabs"), className: "lb-segmented lb:mt-6 lb:max-w-4xl lb:mx-auto", children: [
          /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              role: "tab",
              id: "tab-identidade",
              "aria-controls": "panel-identidade",
              "aria-selected": activeTab === "identidade",
              onClick: () => setActiveTab("identidade"),
              className: "lb-segment",
              children: t("tabIdentity")
            }
          ),
          /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              role: "tab",
              id: "tab-instrucoes",
              "aria-controls": "panel-instrucoes",
              "aria-selected": activeTab === "instrucoes",
              onClick: () => setActiveTab("instrucoes"),
              className: "lb-segment",
              children: t("tabInstructions")
            }
          ),
          /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              role: "tab",
              id: "tab-modelo",
              "aria-controls": "panel-modelo",
              "aria-selected": activeTab === "modelo",
              onClick: () => setActiveTab("modelo"),
              className: "lb-segment",
              children: t("tabModel")
            }
          ),
          /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              role: "tab",
              id: "tab-regras",
              "aria-controls": "panel-regras",
              "aria-selected": activeTab === "regras",
              onClick: () => setActiveTab("regras"),
              className: "lb-segment",
              children: t("tabRules")
            }
          )
        ] })
      ] }),
      saveSuccessMessage && /* @__PURE__ */ jsx("div", { className: "lb:max-w-4xl lb:mx-auto lb:w-full lb:px-4 lb:md:px-6 lb:pt-4", children: /* @__PURE__ */ jsxs("div", { className: "lb:p-3 lb:rounded-xl lb:border-[var(--color-success)]/40 lb:bg-[var(--color-success)]/10 lb:text-[var(--color-success)] lb:text-[13px] lb:flex lb:items-center lb:gap-2", children: [
        /* @__PURE__ */ jsx(CheckCircleIcon, { size: 15 }),
        /* @__PURE__ */ jsx("span", { children: saveSuccessMessage })
      ] }) }),
      error && /* @__PURE__ */ jsx("div", { className: "lb:max-w-4xl lb:mx-auto lb:w-full lb:px-4 lb:md:px-6 lb:pt-4", children: /* @__PURE__ */ jsxs("div", { className: "lb:p-3 lb:rounded-xl lb:border-[var(--color-destructive)]/40 lb:bg-[var(--color-destructive)]/10 lb:text-[var(--color-destructive)] lb:text-[13px] lb:flex lb:items-center lb:justify-between lb:gap-2", children: [
        /* @__PURE__ */ jsx("span", { children: /* @__PURE__ */ jsx(ErrorNote, { error }) }),
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            onClick: () => setError(null),
            className: "lb:text-xs lb:underline lb:hover:no-underline",
            children: t("close")
          }
        )
      ] }) }),
      /* @__PURE__ */ jsxs("main", { className: "lb:flex-1 lb:p-4 lb:md:p-6 lb:max-w-4xl lb:mx-auto lb:w-full", children: [
        activeTab === "identidade" && /* @__PURE__ */ jsxs("form", { role: "tabpanel", id: "panel-identidade", "aria-labelledby": "tab-identidade", onSubmit: handleSaveDisplay, className: "lb:flex lb:flex-col lb:gap-5", children: [
          /* @__PURE__ */ jsxs("div", { className: "lb:grid lb:grid-cols-1 lb:md:grid-cols-2 lb:gap-4", children: [
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("visibleNameLabel") }),
              /* @__PURE__ */ jsx(
                "input",
                {
                  type: "text",
                  value: label,
                  onChange: (e) => setLabel(e.target.value),
                  placeholder: t("visibleNamePlaceholder"),
                  required: true,
                  className: "lb-input"
                }
              )
            ] }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("hermesIdentifierLabel") }),
              /* @__PURE__ */ jsx(
                "input",
                {
                  type: "text",
                  value: botName,
                  disabled: true,
                  className: "lb-input lb-mono lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed"
                }
              )
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "lb:grid lb:grid-cols-1 lb:md:grid-cols-2 lb:gap-4", children: [
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("primaryRoleLabel") }),
              /* @__PURE__ */ jsx(
                "input",
                {
                  type: "text",
                  value: role,
                  onChange: (e) => setRole(e.target.value),
                  placeholder: t("primaryRolePlaceholder"),
                  className: "lb-input"
                }
              )
            ] }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("callMeLabelProfile") }),
              /* @__PURE__ */ jsx(
                "input",
                {
                  type: "text",
                  value: callMe,
                  onChange: (e) => setCallMe(e.target.value),
                  placeholder: t("callMePlaceholder"),
                  className: "lb-input"
                }
              )
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("div", { className: "lb-label lb:block lb:mb-2", children: t("mascotPickerLabel") }),
            /* @__PURE__ */ jsx(
              MascotPicker,
              {
                value: avatarKind === "mascot" ? avatarValue : null,
                color,
                onPick: (id) => {
                  setAvatarKind("mascot");
                  setAvatarValue(id);
                }
              }
            )
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "lb:grid lb:grid-cols-1 lb:md:grid-cols-2 lb:gap-4", children: [
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("avatarEmojiInitialsLabel") }),
              /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                /* @__PURE__ */ jsx(
                  "input",
                  {
                    type: "text",
                    "aria-label": t("avatarEmojiInitialsLabel"),
                    value: avatarKind === "emoji" || avatarKind === "initials" ? avatarValue : "",
                    onChange: (e) => {
                      if (avatarKind !== "initials") setAvatarKind("emoji");
                      setAvatarValue(e.target.value);
                    },
                    maxLength: 4,
                    className: "lb:w-20 lb:px-3 lb:py-1.5 lb:text-base lb:text-center lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-foreground)] lb:focus:border-[var(--color-primary)] lb:focus:outline-hidden"
                  }
                ),
                /* @__PURE__ */ jsx("div", { className: "lb:flex lb:gap-1.5 lb:text-[13px]", children: ["\u{1F4BC}", "\u{1F3A7}", "\u{1F4BB}", "\u{1F50D}", "\u270D\uFE0F", "\u{1F4CA}", "\u{1F454}", "\u{1F916}"].map((em) => /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    onClick: () => {
                      setAvatarValue(em);
                      setAvatarKind("emoji");
                    },
                    className: "lb:w-7 lb:h-7 lb:flex lb:items-center lb:justify-center lb:rounded-lg lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:motion-safe:transition-colors",
                    children: em
                  },
                  em
                )) })
              ] })
            ] }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("botColorLabel") }),
              /* @__PURE__ */ jsx("div", { className: "lb:flex lb:items-center lb:gap-2 lb:flex-wrap", children: BOT_COLORS.map((c) => {
                const isSelected = color.toLowerCase() === c.hex.toLowerCase();
                return /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    onClick: () => setColor(c.hex),
                    title: `${c.name} (${c.archetype})`,
                    className: `lb:w-7 lb:h-7 lb:rounded-full lb:motion-safe:transition-transform lb:flex lb:items-center lb:justify-center ${isSelected ? "lb:scale-110 lb:ring-2 lb:ring-offset-2 lb:ring-offset-[var(--background)] lb:ring-[var(--color-foreground)]" : "lb:hover:scale-105 lb:opacity-80 lb:hover:opacity-100"}`,
                    style: { backgroundColor: c.hex },
                    children: isSelected && /* @__PURE__ */ jsx("span", { className: "lb:w-2 lb:h-2 lb:rounded-full lb:bg-white" })
                  },
                  c.hex
                );
              }) })
            ] })
          ] }),
          /* @__PURE__ */ jsx("div", { className: "lb:pt-4 lb:border-t lb:border-[var(--lb-separator)] lb:flex lb:justify-end", children: /* @__PURE__ */ jsx(
            "button",
            {
              type: "submit",
              disabled: isSavingDisplay,
              className: "lb:px-4 lb:py-2 lb:text-[13px] lb:font-semibold lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:disabled:opacity-50 lb:motion-safe:transition-opacity lb:rounded-full",
              children: isSavingDisplay ? t("saving") : t("saveChanges")
            }
          ) })
        ] }),
        activeTab === "instrucoes" && /* @__PURE__ */ jsxs("div", { role: "tabpanel", id: "panel-instrucoes", "aria-labelledby": "tab-instrucoes", className: "lb:flex lb:flex-col lb:gap-4", children: [
          /* @__PURE__ */ jsxs("div", { className: "lb:p-3 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:flex lb:items-center lb:justify-between", children: [
            /* @__PURE__ */ jsx("span", { children: t("soulNotice") }),
            /* @__PURE__ */ jsx("span", { className: "lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-semibold lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:shrink-0 lb:ml-2", children: t("readOnlyBadge") })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "lb:p-3 lb:rounded-2xl lb:border-[var(--color-primary)]/30 lb:bg-[var(--color-accent)] lb:text-[13px] lb:text-[var(--color-card-foreground)] lb:flex lb:items-start lb:gap-2.5", children: [
            /* @__PURE__ */ jsx(SparklesIcon, { size: 16, className: "lb:text-[var(--color-primary)] lb:shrink-0 lb:mt-0.5" }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("span", { className: "lb:font-semibold lb:text-[var(--color-primary)]", children: t("soulTipTitle") }),
              " ",
              /* @__PURE__ */ jsx("span", { children: t("soulTipText") }),
              /* @__PURE__ */ jsx("p", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)] lb:mt-0.5", children: t("soulTipSub") })
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:gap-1", children: [
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: [
              /* @__PURE__ */ jsx("span", { className: "lb:font-semibold lb:text-[var(--color-card-foreground)]", children: t("soulContentTitle") }),
              /* @__PURE__ */ jsxs("span", { className: "lb:font-mono lb:text-xs", children: [
                (bot?.soul || soul).length,
                " ",
                t("charactersCount")
              ] })
            ] }),
            /* @__PURE__ */ jsx(
              "textarea",
              {
                value: bot?.soul || soul,
                readOnly: true,
                rows: 14,
                className: "lb-input lb-mono lb:leading-relaxed lb:resize-y lb:cursor-default",
                placeholder: t("soulPlaceholder")
              }
            )
          ] })
        ] }),
        activeTab === "modelo" && /* @__PURE__ */ jsxs("div", { role: "tabpanel", id: "panel-modelo", "aria-labelledby": "tab-modelo", className: "lb:flex lb:flex-col lb:gap-5", children: [
          /* @__PURE__ */ jsxs("div", { className: "lb:p-3 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:flex lb:items-center lb:justify-between", children: [
            /* @__PURE__ */ jsx("span", { children: t("modelNotice") }),
            /* @__PURE__ */ jsx("span", { className: "lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-semibold lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:shrink-0 lb:ml-2", children: t("readOnlyBadge") })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "lb:grid lb:grid-cols-1 lb:md:grid-cols-2 lb:gap-4", children: [
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("providerAILabel") }),
              /* @__PURE__ */ jsx(
                "input",
                {
                  type: "text",
                  value: bot?.model?.provider || "\u2014",
                  disabled: true,
                  className: "lb-input lb-mono lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed"
                }
              )
            ] }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("mainModelLabel") }),
              /* @__PURE__ */ jsx(
                "input",
                {
                  type: "text",
                  value: bot?.model?.name || "\u2014",
                  disabled: true,
                  className: "lb-input lb-mono lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed"
                }
              )
            ] })
          ] })
        ] }),
        activeTab === "regras" && /* @__PURE__ */ jsx("div", { role: "tabpanel", id: "panel-regras", "aria-labelledby": "tab-regras", className: "lb:max-w-4xl lb:mx-auto lb:w-full lb:h-[600px] lb:flex lb:flex-col lb:border-[var(--lb-separator)] lb:rounded-2xl lb:overflow-hidden", children: /* @__PURE__ */ jsx(RulesView, { botName }) })
      ] })
    ] });
  }

  // dashboard/src/components/bots/BotIntroduction.tsx
  var POLL_MS = 2e3;
  var POLL_TRIES = 60;
  var RECHECK_MS = 3e3;
  var RECHECK_TRIES = 40;
  var TRANSIENT = /* @__PURE__ */ new Set(["bot_offline", "hook_not_live"]);
  var TERMINAL = /* @__PURE__ */ new Set(["completed", "failed", "cancelled", "interrupted"]);
  var REASON = {
    no_template: "introNoTemplate",
    hook_not_live: "introHookNotLive",
    bot_offline: "introBotOffline",
    bot_paused: "introBotPaused",
    budget_exceeded: "introBudgetExceeded"
  };
  function BotIntroduction({ bot, onSession }) {
    const { t, locale } = useLuveI18n();
    const [phase, setPhase] = react_default.useState({ kind: "loading" });
    const [busy, setBusy] = react_default.useState(false);
    const alive = react_default.useRef(true);
    react_default.useEffect(() => () => {
      alive.current = false;
    }, []);
    const follow = react_default.useCallback(async (view) => {
      if (view.session_id) onSession?.(view.session_id);
      if (!view.run_id) {
        setPhase({ kind: "failed", error: t("introFailed") });
        return;
      }
      setPhase({ kind: "running" });
      for (let i = 0; i < POLL_TRIES && alive.current; i++) {
        try {
          const { run } = await getRun(bot, view.run_id);
          if (!alive.current) return;
          if (TERMINAL.has(run.status)) {
            if (run.status === "completed" && run.output && run.output.trim()) setPhase({ kind: "answer", text: run.output });
            else setPhase({ kind: "failed", error: t(run.status === "completed" ? "introEmpty" : "introFailed") });
            return;
          }
        } catch (e) {
          if (alive.current) setPhase({ kind: "failed", error: humanError(e, t, "introFailed") });
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      if (alive.current) setPhase({ kind: "slow" });
    }, [bot, t, onSession]);
    const check = react_default.useCallback(async (waitFirst = false) => {
      if (waitFirst) await new Promise((r) => setTimeout(r, RECHECK_MS));
      for (let i = 0; alive.current; i++) {
        try {
          const view = await getIntroduction(bot);
          if (!alive.current) return;
          if (view.state === "unavailable") {
            setPhase({ kind: "unavailable", reason: view.reason ?? "" });
            if (TRANSIENT.has(view.reason ?? "") && i < RECHECK_TRIES) {
              await new Promise((r) => setTimeout(r, RECHECK_MS));
              continue;
            }
          } else if (view.state === "none") setPhase({ kind: "offer", estimate: view.estimate_cents });
          else await follow(view);
        } catch (e) {
          if (alive.current) setPhase({ kind: "failed", error: humanError(e, t, "introFailed") });
        }
        return;
      }
    }, [bot, t, follow]);
    react_default.useEffect(() => {
      void check();
    }, [bot]);
    async function start() {
      setBusy(true);
      try {
        await follow(await startIntroduction(bot));
      } catch (e) {
        const reason = e instanceof ApiError ? e.code : "";
        setPhase(REASON[reason] ? { kind: "unavailable", reason } : { kind: "failed", error: humanError(e, t, "introFailed") });
        if (TRANSIENT.has(reason)) void check(true);
      } finally {
        if (alive.current) setBusy(false);
      }
    }
    const box3 = {
      width: "100%",
      textAlign: "left",
      display: "flex",
      flexDirection: "column",
      gap: 10,
      padding: 16,
      borderRadius: 16,
      border: "1px solid var(--lb-separator)",
      background: "var(--color-popover)",
      fontSize: 14
    };
    return /* @__PURE__ */ jsxs("section", { "aria-label": t("introTitle"), style: box3, "data-testid": "bot-introduction", children: [
      /* @__PURE__ */ jsx("h4", { className: "lb-headline", style: { margin: 0 }, children: t("introTitle") }),
      phase.kind === "loading" && /* @__PURE__ */ jsx("p", { role: "status", className: "lb-subhead", style: { margin: 0 }, children: t("introLoading") }),
      phase.kind === "offer" && /* @__PURE__ */ jsxs(Fragment2, { children: [
        /* @__PURE__ */ jsx("p", { className: "lb-subhead", style: { margin: 0 }, children: phase.estimate !== null ? t("introOffer", { cost: formatCents(phase.estimate, locale) }) : t("introOfferNoEstimate") }),
        /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn lb-btn-primary", style: { alignSelf: "flex-start" }, disabled: busy, onClick: () => void start(), children: busy ? t("introStarting") : t("introStart") })
      ] }),
      phase.kind === "running" && /* @__PURE__ */ jsx("p", { role: "status", className: "lb-subhead", style: { margin: 0 }, children: t("introRunning") }),
      phase.kind === "answer" && /* @__PURE__ */ jsx("div", { "data-testid": "bot-introduction-answer", children: /* @__PURE__ */ jsx(Markdown, { text: phase.text }) }),
      phase.kind === "slow" && /* @__PURE__ */ jsx("p", { role: "status", className: "lb-subhead", style: { margin: 0 }, children: t("introSlow") }),
      phase.kind === "unavailable" && /* @__PURE__ */ jsx("p", { role: "status", className: "lb-subhead", style: { margin: 0 }, children: t(REASON[phase.reason] ?? "introUnavailable") }),
      phase.kind === "failed" && /* @__PURE__ */ jsx("p", { role: "alert", className: "lb-caption", style: { margin: 0, color: "var(--color-destructive)" }, children: /* @__PURE__ */ jsx(ErrorNote, { error: phase.error }) })
    ] });
  }

  // dashboard/src/components/bots/BotCreateModal.tsx
  var PROFILE_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
  function BotCreateModal(props) {
    const trapRef = useFocusTrap({ isOpen: props.isOpen, onClose: props.onClose, disableTrap: props.disableFocusTrap });
    return props.isOpen ? /* @__PURE__ */ jsx(BotCreateWizard, { ...props, trapRef }) : null;
  }
  function BotCreateWizard({
    onClose,
    onBotCreated,
    templates = DEFAULT_TEMPLATES,
    trapRef: modalContainerRef
  }) {
    const { t } = useLuveI18n();
    const [step, setStep] = useState(1);
    const [selectedTemplate, setSelectedTemplate] = useState(null);
    const [name, setName] = useState("");
    const [nameError, setNameError] = useState(null);
    const [label, setLabel] = useState("");
    const [role, setRole] = useState("");
    const [callMe, setCallMe] = useState("");
    const [avatarValue, setAvatarValue] = useState("luvi");
    const [avatarKind, setAvatarKind] = useState("mascot");
    const [color, setColor] = useState("#38bdf8");
    const [description, setDescription] = useState("");
    const [soul, setSoul] = useState("");
    const [provider, setProvider] = useState("openrouter");
    const [modelName, setModelName] = useState("claude-sonnet-5-5");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [apiError, setApiError] = useState(null);
    const [createdBot, setCreatedBot] = useState(null);
    const [createdSessionId, setCreatedSessionId] = useState(null);
    const handleSelectTemplate = (tpl) => {
      setSelectedTemplate(tpl);
      if (tpl) {
        const defaultName = tpl.id === "sales" ? "vendas" : tpl.id.replace(/[^a-zA-Z0-9_-]/g, "");
        setName(defaultName);
        setLabel(tpl.label);
        setRole(tpl.role);
        setDescription(tpl.description || "");
        setColor(tpl.color || "#38bdf8");
        setAvatarKind(tpl.avatar?.kind || "mascot");
        setAvatarValue(tpl.avatar?.value || "luvi");
        setSoul(tpl.soul);
        if (tpl.model_hint) {
          setModelName(tpl.model_hint);
        }
      } else {
        setName("");
        setLabel("");
        setRole("");
        setDescription("");
        setColor("#38bdf8");
        setAvatarKind("mascot");
        setAvatarValue("luvi");
        setSoul("# SOUL.md\nDefina regras perp\xE9tuas para este Bot...");
      }
      setNameError(null);
      setStep(2);
    };
    const handleNameChange = (val) => {
      setName(val);
      if (!val) {
        setNameError(t("nameRequired"));
      } else if (!PROFILE_NAME_REGEX.test(val)) {
        setNameError(t("nameFormatError"));
      } else {
        setNameError(null);
      }
    };
    const handleCreateSubmit = async (e) => {
      e.preventDefault();
      if (!PROFILE_NAME_REGEX.test(name)) {
        setNameError(t("nameInvalid"));
        return;
      }
      setIsSubmitting(true);
      setApiError(null);
      const payload = {
        name: name.trim(),
        template: selectedTemplate?.id,
        display: {
          label: label.trim() || name.trim(),
          role: role.trim(),
          call_me: callMe.trim() || null,
          color,
          avatar: { kind: avatarKind, value: avatarValue }
        },
        model: {
          provider,
          name: modelName
        }
      };
      try {
        const resp = await createBot(payload);
        setCreatedBot(resp.bot);
        setCreatedSessionId(resp.intro?.session_id || null);
        setStep(5);
      } catch (err) {
        const msg = humanError(err, t, "errorLoadingBots");
        setApiError(msg);
      } finally {
        setIsSubmitting(false);
      }
    };
    const handleFinish = () => {
      if (createdBot) {
        onBotCreated?.(createdBot, createdSessionId || void 0);
      }
      onClose();
    };
    return /* @__PURE__ */ jsx(
      "div",
      {
        ref: modalContainerRef,
        className: "lb-dialog-overlay",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "modal-title",
        children: /* @__PURE__ */ jsxs("div", { className: "lb-dialog lb:max-w-2xl lb:overflow-y-auto", children: [
          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:px-5 lb:pt-5 lb:pb-3 lb:shrink-0", children: [
            /* @__PURE__ */ jsx("div", { className: "lb:flex lb:items-center lb:gap-2", children: /* @__PURE__ */ jsxs("h2", { id: "modal-title", className: "lb-title", children: [
              t("createBotModalTitle"),
              " ",
              step < 5 && `\xB7 ${t("stepOf", { step })}`
            ] }) }),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: onClose,
                "aria-label": t("close"),
                className: "lb-icon-btn",
                style: { background: "var(--lb-fill)" },
                children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
              }
            )
          ] }),
          step < 5 && /* @__PURE__ */ jsx("div", { className: "lb:flex lb:h-1 lb:bg-[var(--lb-fill)]", children: /* @__PURE__ */ jsx(
            "div",
            {
              className: "lb:bg-[var(--color-foreground)] lb:motion-safe:transition-all lb:duration-300",
              style: { width: `${step / 4 * 100}%` }
            }
          ) }),
          apiError && /* @__PURE__ */ jsx("div", { className: "lb:mx-4 lb:mt-3 lb:p-3 lb:rounded-lg lb:text-[13px] lb:bg-[var(--color-destructive)]/15 lb:border-[var(--color-destructive)]/40 lb:text-[var(--color-destructive)]", children: /* @__PURE__ */ jsx(ErrorNote, { error: apiError }) }),
          /* @__PURE__ */ jsxs("div", { className: "lb:flex-1 lb:overflow-y-auto lb:p-4 lb:md:p-6 lb:text-[13px] lb:text-[var(--color-foreground)]", children: [
            step === 1 && /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:gap-4", children: [
              /* @__PURE__ */ jsxs("div", { children: [
                /* @__PURE__ */ jsx("h3", { className: "lb-headline", children: t("wizardStep1Title") }),
                /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:mt-0.5", children: t("wizardStep1Subtitle") })
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-2.5", children: [
                templates.map((tpl) => /* @__PURE__ */ jsxs(
                  "button",
                  {
                    type: "button",
                    onClick: () => handleSelectTemplate(tpl),
                    className: "lb:p-3 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--color-popover)]/60 lb:hover:bg-[var(--lb-fill-2)] lb:hover:border-[var(--color-primary)] lb:text-left lb:motion-safe:transition-all lb:flex lb:flex-col lb:justify-between lb:group",
                    children: [
                      /* @__PURE__ */ jsxs("div", { children: [
                        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                          /* @__PURE__ */ jsx(Avatar, { name: tpl.label, avatar: tpl.avatar, color: tpl.color, size: 28 }),
                          /* @__PURE__ */ jsx("span", { className: "lb:font-semibold lb:text-[13px] lb:text-[var(--color-card-foreground)] lb:group-hover:text-[var(--color-primary)]", children: tpl.label })
                        ] }),
                        /* @__PURE__ */ jsx("p", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)] lb:mt-1 lb:line-clamp-2 lb:leading-relaxed", children: tpl.description })
                      ] }),
                      /* @__PURE__ */ jsxs("span", { className: "lb:text-xs lb:text-[var(--color-primary)] lb:font-medium lb:mt-2 lb:flex lb:items-center lb:gap-1", children: [
                        t("useThisTemplate"),
                        " ",
                        /* @__PURE__ */ jsx(ArrowRightIcon, { size: 11 })
                      ] })
                    ]
                  },
                  tpl.id
                )),
                /* @__PURE__ */ jsxs(
                  "button",
                  {
                    type: "button",
                    onClick: () => handleSelectTemplate(null),
                    className: "lb:p-3 lb:rounded-2xl lb:border-dashed lb:border-[var(--lb-separator)] lb:hover:border-[var(--color-foreground)] lb:bg-transparent lb:text-left lb:motion-safe:transition-all lb:flex lb:flex-col lb:justify-between",
                    children: [
                      /* @__PURE__ */ jsxs("div", { children: [
                        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                          /* @__PURE__ */ jsx(Avatar, { name: t("createFromScratch"), avatar: { kind: "mascot", value: "luvi" }, size: 28 }),
                          /* @__PURE__ */ jsx("span", { className: "lb:font-semibold lb:text-[13px] lb:text-[var(--color-card-foreground)]", children: t("createFromScratch") })
                        ] }),
                        /* @__PURE__ */ jsx("p", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)] lb:mt-1 lb:leading-relaxed", children: t("createFromScratchDesc") })
                      ] }),
                      /* @__PURE__ */ jsxs("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)] lb:font-medium lb:mt-2 lb:flex lb:items-center lb:gap-1", children: [
                        t("customBadge"),
                        " ",
                        /* @__PURE__ */ jsx(ArrowRightIcon, { size: 11 })
                      ] })
                    ]
                  }
                )
              ] })
            ] }),
            step === 2 && /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:gap-4", children: [
              /* @__PURE__ */ jsxs("div", { children: [
                /* @__PURE__ */ jsx("h3", { className: "lb-headline", children: t("wizardStep2Title") }),
                /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:mt-0.5", children: t("wizardStep2Subtitle") })
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-3.5", children: [
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("profileIdentifierLabel") }),
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      type: "text",
                      value: name,
                      onChange: (e) => handleNameChange(e.target.value),
                      placeholder: t("profileIdentifierPlaceholder"),
                      required: true,
                      className: `lb:w-full lb:px-3 lb:py-1.5 lb:font-mono lb:rounded-lg ${nameError ? "lb:border-[var(--color-destructive)] lb:bg-[var(--color-destructive)]/10" : "lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)]"} lb:text-[var(--color-foreground)] lb:focus:border-[var(--color-primary)] lb:focus:outline-hidden`
                    }
                  ),
                  nameError && /* @__PURE__ */ jsx("span", { className: "lb:text-xs lb:text-[var(--color-destructive)] lb:mt-1 lb:block", children: nameError })
                ] }),
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("visibleNameLabel") }),
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      type: "text",
                      value: label,
                      onChange: (e) => setLabel(e.target.value),
                      placeholder: t("visibleNamePlaceholder"),
                      className: "lb-input"
                    }
                  )
                ] })
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-3.5", children: [
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("primaryRoleLabel") }),
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      type: "text",
                      value: role,
                      onChange: (e) => setRole(e.target.value),
                      placeholder: t("primaryRolePlaceholder"),
                      className: "lb-input"
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("callMeLabel") }),
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      type: "text",
                      value: callMe,
                      onChange: (e) => setCallMe(e.target.value),
                      placeholder: t("callMePlaceholder"),
                      className: "lb-input"
                    }
                  )
                ] })
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "lb:pt-2", children: [
                /* @__PURE__ */ jsx("div", { className: "lb-label lb:block lb:mb-2", children: t("mascotPickerLabel") }),
                /* @__PURE__ */ jsx(
                  MascotPicker,
                  {
                    value: avatarKind === "mascot" ? avatarValue : null,
                    color,
                    onPick: (id) => {
                      setAvatarKind("mascot");
                      setAvatarValue(id);
                    }
                  }
                )
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-3.5 lb:pt-2", children: [
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("avatarLabel") }),
                  /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                    /* @__PURE__ */ jsx(
                      "input",
                      {
                        type: "text",
                        "aria-label": t("avatarLabel"),
                        value: avatarKind === "emoji" ? avatarValue : "",
                        onChange: (e) => {
                          setAvatarKind("emoji");
                          setAvatarValue(e.target.value);
                        },
                        maxLength: 4,
                        className: "lb:w-16 lb:px-2 lb:py-1.5 lb:text-center lb:text-[15px] lb:rounded-lg lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)]"
                      }
                    ),
                    /* @__PURE__ */ jsx("div", { className: "lb:flex lb:gap-1", children: ["\u{1F454}", "\u{1F4BC}", "\u{1F3A7}", "\u{1F4CA}", "\u{1F4BB}", "\u{1F50D}", "\u270D\uFE0F", "\u{1F916}"].map((em) => /* @__PURE__ */ jsx(
                      "button",
                      {
                        type: "button",
                        onClick: () => {
                          setAvatarKind("emoji");
                          setAvatarValue(em);
                        },
                        className: "lb:w-6 lb:h-6 lb:flex lb:items-center lb:justify-center lb:rounded-lg lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)]",
                        children: em
                      },
                      em
                    )) })
                  ] })
                ] }),
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("botColorLabel") }),
                  /* @__PURE__ */ jsx("div", { className: "lb:flex lb:items-center lb:gap-2 lb:flex-wrap", children: BOT_COLORS.map((c) => {
                    const isSelected = color.toLowerCase() === c.hex.toLowerCase();
                    return /* @__PURE__ */ jsx(
                      "button",
                      {
                        type: "button",
                        onClick: () => setColor(c.hex),
                        title: `${c.name} (${c.archetype})`,
                        className: `lb:w-6 lb:h-6 lb:rounded-full lb:motion-safe:transition-transform lb:flex lb:items-center lb:justify-center ${isSelected ? "lb:scale-110 lb:ring-2 lb:ring-offset-2 lb:ring-offset-[var(--background)] lb:ring-[var(--color-foreground)]" : "lb:opacity-80 lb:hover:opacity-100"}`,
                        style: { backgroundColor: c.hex },
                        children: isSelected && /* @__PURE__ */ jsx("span", { className: "lb:w-1.5 lb:h-1.5 lb:rounded-full lb:bg-white" })
                      },
                      c.hex
                    );
                  }) })
                ] })
              ] })
            ] }),
            step === 3 && /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:gap-4", children: [
              /* @__PURE__ */ jsxs("div", { children: [
                /* @__PURE__ */ jsx("h3", { className: "lb-headline", children: t("wizardStep3Title") }),
                /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:mt-0.5", children: t("wizardStep3Subtitle") })
              ] }),
              /* @__PURE__ */ jsxs("div", { children: [
                /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("operationalDescriptionLabel") }),
                /* @__PURE__ */ jsx("div", { className: "lb:p-3 lb:rounded-lg lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-xs lb:text-[var(--color-card-foreground)] lb:leading-relaxed", children: description || t("operationalDescriptionDefault") })
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "lb:p-3.5 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--color-popover)]/60 lb:flex lb:flex-col lb:gap-2", children: [
                /* @__PURE__ */ jsxs("span", { className: "lb:font-semibold lb:text-[13px] lb:text-[var(--color-card-foreground)] lb:flex lb:items-center lb:gap-1.5", children: [
                  /* @__PURE__ */ jsx("span", { className: "lb:text-[var(--color-muted-foreground)]", children: "\u2139\uFE0F" }),
                  /* @__PURE__ */ jsx("span", { children: t("technicalRulesNoticeTitle") })
                ] }),
                /* @__PURE__ */ jsx("p", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)] lb:leading-relaxed", children: t("technicalRulesNotice") })
              ] }),
              /* @__PURE__ */ jsxs("div", { children: [
                /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("permanentSoulLabel") }),
                /* @__PURE__ */ jsx("div", { className: "lb:p-2.5 lb:font-mono lb:text-xs lb:rounded-lg lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:max-h-32 lb:overflow-y-auto lb:whitespace-pre-wrap", children: soul })
              ] })
            ] }),
            step === 4 && /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:gap-4", children: [
              /* @__PURE__ */ jsxs("div", { children: [
                /* @__PURE__ */ jsx("h3", { className: "lb-headline", children: t("wizardStep4Title") }),
                /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:mt-0.5", children: t("wizardStep4Subtitle") })
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-3.5", children: [
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("providerLabel") }),
                  /* @__PURE__ */ jsxs(
                    "select",
                    {
                      value: provider,
                      onChange: (e) => setProvider(e.target.value),
                      className: "lb-input",
                      children: [
                        /* @__PURE__ */ jsx("option", { value: "openrouter", children: t("providerOpenRouter") }),
                        /* @__PURE__ */ jsx("option", { value: "anthropic", children: t("providerAnthropic") }),
                        /* @__PURE__ */ jsx("option", { value: "openai", children: t("providerOpenAI") }),
                        /* @__PURE__ */ jsx("option", { value: "nous", children: t("providerNous") })
                      ]
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx("label", { className: "lb-label lb:block lb:mb-1", children: t("modelLabel") }),
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      type: "text",
                      value: modelName,
                      onChange: (e) => setModelName(e.target.value),
                      placeholder: t("modelPlaceholder"),
                      className: "lb-input lb-mono"
                    }
                  )
                ] })
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "lb:p-3 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-xs lb:text-[var(--color-muted-foreground)]", children: [
                "\u{1F4A1} ",
                /* @__PURE__ */ jsx("span", { className: "lb:font-semibold lb:text-[var(--color-foreground)]", children: "LuveBot:" }),
                " ",
                t("connectMinimumNotice")
              ] })
            ] }),
            step === 5 && /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:items-center lb:text-center lb:gap-4 lb:py-2", "data-testid": "bot-presentation", children: [
              /* @__PURE__ */ jsx(Avatar, { name: label || name, avatar: { kind: avatarKind, value: avatarValue }, color, size: 64 }),
              /* @__PURE__ */ jsxs("div", { children: [
                /* @__PURE__ */ jsx("span", { className: "lb:px-2.5 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)] lb:border-[var(--color-success)]/30", children: t("botCreatedSuccess") }),
                /* @__PURE__ */ jsxs("h3", { className: "lb-headline lb:mt-2", children: [
                  label || name,
                  " ",
                  t("botReadyToOperate")
                ] })
              ] }),
              createdBot && /* @__PURE__ */ jsx(BotIntroduction, { bot: createdBot.name, onSession: setCreatedSessionId })
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:px-5 lb:py-4 lb:border-t lb:border-[var(--lb-separator)] lb:shrink-0", children: [
            step > 1 && step < 5 ? /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: () => setStep((s) => s - 1),
                className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:motion-safe:transition-colors lb:rounded-full",
                children: t("back")
              }
            ) : /* @__PURE__ */ jsx("div", {}),
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
              step < 4 && /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: () => {
                    if (step === 2 && !PROFILE_NAME_REGEX.test(name)) {
                      setNameError(t("nameInvalid"));
                      return;
                    }
                    setStep((s) => s + 1);
                  },
                  disabled: step === 2 && !name,
                  className: "lb:px-3.5 lb:py-1.5 lb:text-[13px] lb:font-semibold lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:disabled:opacity-50 lb:motion-safe:transition-opacity lb:rounded-full",
                  children: t("next")
                }
              ),
              step === 4 && /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: handleCreateSubmit,
                  disabled: isSubmitting || !name,
                  className: "lb:px-4 lb:py-1.5 lb:text-[13px] lb:font-semibold lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:disabled:opacity-50 lb:motion-safe:transition-opacity lb:rounded-full",
                  children: isSubmitting ? t("creatingBotBtn") : t("createBotBtn")
                }
              ),
              step === 5 && /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: handleFinish,
                  className: "lb:px-4 lb:py-1.5 lb:text-[13px] lb:font-semibold lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:motion-safe:transition-opacity lb:rounded-full",
                  children: t("startWithThisBot")
                }
              )
            ] })
          ] })
        ] })
      }
    );
  }

  // dashboard/src/components/conversation/MessageMenu.tsx
  function MessageMenu({ items, children }) {
    const { t } = useLuveI18n();
    const [open, setOpen] = react_default.useState(false);
    const button = react_default.useRef(null);
    const menu = react_default.useRef(null);
    const press = react_default.useRef(null);
    const id = react_default.useId();
    const close = (refocus = true) => {
      setOpen(false);
      if (refocus) button.current?.focus();
    };
    react_default.useEffect(() => {
      if (!open) return;
      menu.current?.querySelector('[role="menuitem"]')?.focus();
      const away = (e) => {
        if (!menu.current?.contains(e.target) && e.target !== button.current) setOpen(false);
      };
      document.addEventListener("pointerdown", away);
      return () => document.removeEventListener("pointerdown", away);
    }, [open]);
    const onMenuKey = (e) => {
      const all = Array.from(menu.current?.querySelectorAll('[role="menuitem"]') ?? []);
      const at = all.indexOf(document.activeElement);
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        all[(at + 1) % all.length]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        all[(at - 1 + all.length) % all.length]?.focus();
      } else if (e.key === "Tab") setOpen(false);
    };
    const cancelPress = () => {
      if (press.current !== null) {
        window.clearTimeout(press.current);
        press.current = null;
      }
    };
    const onPointerDown = (e) => {
      if (e.pointerType !== "touch") return;
      cancelPress();
      press.current = window.setTimeout(() => {
        press.current = null;
        setOpen(true);
      }, 500);
    };
    return /* @__PURE__ */ jsxs("div", { className: "lb-msg", onPointerDown, onPointerUp: cancelPress, onPointerMove: cancelPress, onPointerCancel: cancelPress, children: [
      children,
      /* @__PURE__ */ jsxs("div", { className: "lb-msg-actions", children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            ref: button,
            type: "button",
            className: "lb-icon-btn lb-msg-more",
            "aria-label": t("messageMoreActions"),
            title: t("messageMoreActions"),
            "aria-haspopup": "menu",
            "aria-expanded": open,
            "aria-controls": open ? id : void 0,
            onClick: () => setOpen((o) => !o),
            onKeyDown: (e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
              }
            },
            children: /* @__PURE__ */ jsx("span", { "aria-hidden": "true", style: { fontSize: 18, lineHeight: 1, letterSpacing: 1 }, children: "\u2026" })
          }
        ),
        open && /* @__PURE__ */ jsx("div", { ref: menu, id, role: "menu", "aria-label": t("messageMoreActions"), className: "lb-msg-menu", onKeyDown: onMenuKey, children: items.map((it, i) => /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            role: "menuitem",
            tabIndex: -1,
            className: "lb-msg-menu-item",
            "aria-label": it.label,
            "aria-describedby": `${id}-hint-${i}`,
            onClick: () => {
              close(false);
              it.onSelect();
            },
            children: [
              /* @__PURE__ */ jsx("span", { className: "lb-headline", children: it.label }),
              /* @__PURE__ */ jsx("span", { id: `${id}-hint-${i}`, className: "lb-caption", children: it.hint })
            ]
          },
          i
        )) })
      ] })
    ] });
  }

  // dashboard/src/components/ui/Bubble.tsx
  function Bubble({ side, color, author, meta, children }) {
    const me = side === "me";
    return /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: me ? "flex-end" : "flex-start", margin: "6px 0" }, children: [
      author && !me && /* @__PURE__ */ jsx("div", { style: { fontSize: 12, fontWeight: 600, color: botColor(color), margin: "0 0 2px 12px" }, children: author }),
      /* @__PURE__ */ jsx("div", { style: {
        maxWidth: "min(75%, 640px)",
        padding: "10px 14px",
        borderRadius: 20,
        [me ? "borderBottomRightRadius" : "borderBottomLeftRadius"]: 6,
        background: me ? botColor(color) : "var(--color-muted)",
        color: me ? readableOn(color) : "var(--color-foreground)",
        fontSize: 15,
        lineHeight: 1.45,
        whiteSpace: me ? "pre-wrap" : void 0,
        overflowWrap: "anywhere"
      }, children }),
      meta && /* @__PURE__ */ jsx("div", { style: { fontSize: 12, color: "var(--color-muted-foreground)", margin: "3px 8px 0" }, children: meta })
    ] });
  }

  // dashboard/src/components/transcript/cards.tsx
  var box = {
    border: "1px solid var(--color-border)",
    background: "var(--color-card)",
    color: "var(--color-card-foreground)",
    borderRadius: 8,
    padding: "8px 12px",
    margin: "6px 0"
  };
  var muted = { color: "var(--color-muted-foreground)", fontSize: 12 };
  var pre = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "4px 0 0", fontFamily: "monospace", fontSize: 12 };
  function MessageCard({ who, time, text, color }) {
    return /* @__PURE__ */ jsx(Bubble, { side: "bot", author: who, color, meta: time, children: /* @__PURE__ */ jsx(Markdown, { text }) });
  }
  var STATUS = { running: "\u27F3", done: "\u2713", error: "\u2715" };
  function ToolCard({ name, status, preview, args, durationS, result }) {
    const [open, setOpen] = react_default.useState(false);
    const detail = [args && JSON.stringify(args, null, 2), result].filter(Boolean).join("\n\n");
    return /* @__PURE__ */ jsxs("div", { style: { padding: "2px 0" }, children: [
      /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          "aria-expanded": open,
          onClick: () => setOpen(!open),
          style: { all: "unset", cursor: "pointer", display: "flex", alignItems: "baseline", gap: 8, width: "100%", minHeight: 28, fontSize: 14 },
          children: [
            /* @__PURE__ */ jsx("span", { "aria-hidden": "true", style: { width: 14, flexShrink: 0, textAlign: "center", color: status === "error" ? "var(--color-destructive)" : status === "done" ? "var(--color-success)" : "var(--color-muted-foreground)" }, children: STATUS[status] }),
            /* @__PURE__ */ jsx("strong", { style: { fontWeight: 600 }, children: name }),
            /* @__PURE__ */ jsx("span", { style: { ...muted, fontSize: 13, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: preview }),
            durationS !== void 0 && /* @__PURE__ */ jsxs("span", { style: muted, children: [
              durationS.toFixed(1),
              "s"
            ] })
          ]
        }
      ),
      open && /* @__PURE__ */ jsx("pre", { style: { ...pre, marginLeft: 22, padding: "8px 10px", borderRadius: 10, background: "var(--color-background)" }, children: detail || "\u2014" })
    ] });
  }
  function SubagentCard(p) {
    const { t } = useLuveI18n();
    return /* @__PURE__ */ jsxs("div", { style: box, children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("strong", { children: t("cardSubagent") }),
        " ",
        /* @__PURE__ */ jsx("span", { style: muted, children: subagentStatusLabel(p.status, t) })
      ] }),
      /* @__PURE__ */ jsx("div", { style: { overflowWrap: "anywhere" }, children: p.goal }),
      p.summary && /* @__PURE__ */ jsx(Markdown, { text: p.summary }),
      /* @__PURE__ */ jsxs("div", { style: muted, children: [
        p.costUsd !== void 0 && /* @__PURE__ */ jsxs("span", { children: [
          t("cardSubagentCost", { cost: p.costUsd.toFixed(4) }),
          " "
        ] }),
        p.childSessionId && p.onOpenSession && /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            onClick: () => p.onOpenSession(p.childSessionId),
            style: { all: "unset", cursor: "pointer", color: "var(--color-primary)" },
            children: t("cardViewSession")
          }
        )
      ] })
    ] });
  }
  function CommentaryCard({ text }) {
    const { t } = useLuveI18n();
    return /* @__PURE__ */ jsxs("details", { style: { ...muted, margin: "4px 0" }, children: [
      /* @__PURE__ */ jsx("summary", { style: { cursor: "pointer" }, children: t("cardCommentary") }),
      /* @__PURE__ */ jsx("div", { style: { color: "var(--color-muted-foreground)" }, children: /* @__PURE__ */ jsx(Markdown, { text }) })
    ] });
  }
  function ErrorCard({ message, id }) {
    const { t } = useLuveI18n();
    return /* @__PURE__ */ jsxs("div", { role: "alert", style: { maxWidth: "min(85%, 640px)", margin: "8px 0", padding: "10px 14px", borderRadius: 16, background: "color-mix(in srgb, var(--color-destructive) 10%, transparent)", font: "400 14px/20px var(--lb-font)" }, children: [
      /* @__PURE__ */ jsx("div", { style: { color: "var(--color-destructive)", overflowWrap: "anywhere" }, children: /* @__PURE__ */ jsx(ErrorNote, { error: message }) }),
      id && /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          onClick: () => navigator.clipboard?.writeText(id),
          style: { all: "unset", cursor: "pointer", ...muted },
          children: t("cardCopyId")
        }
      )
    ] });
  }

  // dashboard/src/components/conversation/derive.ts
  var TERMINAL_TOOL = "terminal";
  var FILE_TOOLS = {
    read_file: { op: "read", pathArg: "path" },
    write_file: { op: "write", pathArg: "path" },
    patch: { op: "write", pathArg: "path" }
  };
  var MAX = 2e4;
  var cap = (s) => s.length > MAX ? s.slice(0, MAX) + "\n\u2026" : s;
  function deriveActivity(s) {
    const out = [];
    for (const i of s.items) {
      if (i.kind === "tool") {
        out.push({ kind: "tool", id: i.id, name: i.name, status: i.status, preview: i.preview, durationS: i.durationS, error: i.status === "error" ? i.result : void 0 });
      } else if (i.kind === "commentary") out.push({ kind: "commentary", id: i.id, text: i.text });
    }
    return out;
  }
  function parseResult(raw) {
    if (raw === void 0) return {};
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === "object" && !Array.isArray(j)) {
        const o = j;
        const output = typeof o.output === "string" ? o.output : void 0;
        const err = typeof o.error === "string" && o.error ? o.error : void 0;
        return { output: cap([output, err].filter((x) => x !== void 0).join("\n")), exitCode: typeof o.exit_code === "number" ? o.exit_code : void 0 };
      }
    } catch {
    }
    return { output: cap(raw) };
  }
  function deriveTerminal(s) {
    return s.items.filter((i) => i.kind === "tool" && i.name === TERMINAL_TOOL).map((t) => {
      const cmd = t.args && typeof t.args.command === "string" ? t.args.command : t.preview ?? "";
      return { id: t.id, command: cmd, status: t.status, durationS: t.durationS, ...parseResult(t.result) };
    });
  }
  function deriveFiles(s, tools = FILE_TOOLS) {
    const out = [];
    for (const i of s.items) {
      if (i.kind !== "tool") continue;
      const spec = Object.prototype.hasOwnProperty.call(tools, i.name) ? tools[i.name] : void 0;
      const path = spec && i.args ? i.args[spec.pathArg] : void 0;
      if (spec && typeof path === "string" && path) out.push({ id: i.id, path, op: spec.op, preview: i.result ? cap(i.result) : void 0, status: i.status });
    }
    return out;
  }

  // dashboard/src/components/ui/Dialog.tsx
  function Dialog({ open, onClose, title, titleId, tone: tone2 = "default", width = 440, children }) {
    const { t } = useLuveI18n();
    const ref = useFocusTrap({ isOpen: open, onClose });
    if (!open) return null;
    const color = tone2 === "destructive" ? "var(--color-destructive)" : "var(--color-foreground)";
    return /* @__PURE__ */ jsx("div", { ref, role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, className: "lb-dialog-overlay", children: /* @__PURE__ */ jsxs("div", { className: "lb-dialog", style: { maxWidth: width }, children: [
      /* @__PURE__ */ jsxs("div", { className: "lb-dialog-head", children: [
        /* @__PURE__ */ jsx("h2", { id: titleId, className: "lb-title", style: { color }, children: title }),
        /* @__PURE__ */ jsx("button", { type: "button", onClick: onClose, "aria-label": t("close"), className: "lb-icon-btn", style: { background: "var(--lb-fill)" }, children: /* @__PURE__ */ jsx(XIcon, { size: 16 }) })
      ] }),
      children
    ] }) });
  }

  // dashboard/src/components/screen/novnc.ts
  var novncUrl = () => `${getPluginBasePath()}/dashboard-plugins/luvebot/vendor/novnc/core/rfb.js`;
  var loading = null;
  function loadRFB() {
    const url = novncUrl();
    loading ??= import(
      /* @vite-ignore */
      url
    ).then((m) => m.default).catch((e) => {
      loading = null;
      throw e;
    });
    return loading;
  }
  function screenSocketUrl(path, ticket) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}${getPluginBasePath()}${path}?display_ticket=${encodeURIComponent(ticket)}`;
  }
  var keysymOf = (ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c < 256 ? c : 16777216 + c;
  };
  var XK_RETURN = 65293;
  var XK_BACKSPACE = 65288;
  var SAMPLE_W = 64;
  var SAMPLE_H = 40;
  var sampler = null;
  function canvasSignature(canvas) {
    if (!canvas || !canvas.width || !canvas.height) return "blank";
    try {
      if (!sampler) {
        const c = document.createElement("canvas");
        c.width = SAMPLE_W;
        c.height = SAMPLE_H;
        sampler = c.getContext("2d", { willReadFrequently: true });
      }
      if (!sampler) return null;
      sampler.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
      sampler.drawImage(canvas, 0, 0, SAMPLE_W, SAMPLE_H);
      const d = sampler.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
      let alpha = 0, h = 2166136261;
      for (let i = 0; i < d.length; i++) {
        if ((i & 3) === 3) alpha += d[i];
        h = Math.imul(h ^ d[i], 16777619) >>> 0;
      }
      return alpha === 0 ? "blank" : h.toString(36);
    } catch {
      return null;
    }
  }

  // dashboard/src/components/screen/screen.ts
  function screenState(s) {
    if (!s.supported) return { kind: "unsupported" };
    if (!s.installed) return { kind: "not_installed", missing: s.missing ?? [], installCommand: s.install_command ?? null };
    if (s.placement && s.placement.startsWith("terminal:")) return { kind: "sandbox", placement: s.placement };
    if (s.running) return { kind: "running" };
    if (s.blocker) return { kind: "no_memory", availableMb: s.memory?.available_mb ?? null, neededMb: s.memory?.needed_mb ?? null, blocker: s.blocker };
    return { kind: "stopped" };
  }
  function closeOutcome(code2) {
    return code2 === 4e3 ? "taken" : code2 === 4401 ? "ticket" : code2 === 4001 ? "stopped" : code2 === 4403 ? "refused" : "lost";
  }
  var NO_IMAGE_S = 10;
  function noImageFor(now, w, n = NO_IMAGE_S) {
    const from = w.painted === null ? w.since : w.pending;
    if (from === null) return null;
    const s = Math.floor((now - from) / 1e3);
    return s >= n ? s : null;
  }

  // dashboard/src/components/screen/ScreenTab.tsx
  var README_SCREEN = "https://github.com/LucasVenuto/LuveBot#live-screen";
  var ERR = {
    screen_unavailable: "screenErrUnavailable",
    screen_in_use: "screenErrInUse",
    screen_not_running: "screenErrNotRunning",
    screen_not_yours: "screenErrNotYours",
    loopback_not_human: "screenErrLoopback",
    screen_unsupported: "screenUnsupported",
    screen_not_installed: "screenNotInstalled",
    screen_no_memory: "screenNoMemory"
  };
  var muted2 = { color: "var(--color-muted-foreground)", font: "400 13px/18px var(--lb-font)", margin: 0 };
  var box2 = { padding: "12px 14px", borderRadius: 12, background: "var(--lb-fill)", display: "flex", flexDirection: "column", gap: 8 };
  var code = { fontFamily: "var(--lb-mono)", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 };
  function ScreenTab({ bot, label }) {
    const { t } = useLuveI18n();
    const narrow = useNarrow();
    const [screen, setScreen] = react_default.useState(null);
    const [refusal, setRefusal] = react_default.useState(null);
    const [phase, setPhase] = react_default.useState("loading");
    const [notice2, setNotice] = react_default.useState(null);
    const [error, setError] = react_default.useState(null);
    const [confirm, setConfirm] = react_default.useState(null);
    const [reason, setReason] = react_default.useState("");
    const target = react_default.useRef(null);
    const kbd = react_default.useRef(null);
    const live = react_default.useRef(null);
    const spent = react_default.useRef(0);
    const alive = react_default.useRef(true);
    const frames = react_default.useRef(null);
    const [noImage, setNoImage] = react_default.useState(null);
    const errText = (e) => {
      if (e instanceof ApiError) return ERR[e.code] ? t(ERR[e.code]) : humanError(e, t, "screenErrGeneric");
      return t("screenErrNetwork");
    };
    const drop = () => {
      const cur = live.current;
      live.current = null;
      if (cur) {
        try {
          cur.rfb.disconnect();
        } catch {
        }
      }
    };
    const load = react_default.useCallback(async () => {
      setPhase("loading");
      try {
        const { screen: s } = await getScreen(bot);
        if (!alive.current) return;
        setScreen(s);
        setRefusal(null);
        if (screenState(s).kind === "running") await open("watch");
        else setPhase("idle");
      } catch (e) {
        if (alive.current) {
          setError(errText(e));
          setPhase("error");
        }
      }
    }, [bot]);
    async function connect(mode, ticket) {
      drop();
      setPhase("connecting");
      const RFB = await loadRFB();
      if (!alive.current || !target.current) return;
      const ws = new WebSocket(screenSocketUrl(ticket.path, ticket.ticket));
      ws.binaryType = "arraybuffer";
      const rfb = new RFB(target.current, ws, {});
      rfb.viewOnly = mode === "watch";
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      live.current = { ws, rfb };
      rfb.addEventListener("connect", () => {
        if (live.current?.ws !== ws) return;
        spent.current = 0;
        frames.current = { ws, since: Date.now(), painted: null, pending: null, sig: "blank" };
        setNoImage(null);
        setPhase(mode === "watch" ? "watching" : "control");
      });
      ws.addEventListener("message", () => {
        const f = frames.current;
        if (f?.ws === ws && f.pending === null) f.pending = Date.now();
      });
      ws.addEventListener("close", (ev) => {
        if (live.current?.ws === ws) void onClosed(ev.code);
      });
    }
    async function onClosed(closeCode) {
      live.current = null;
      frames.current = null;
      setNoImage(null);
      const outcome = closeOutcome(closeCode);
      if (outcome === "taken") {
        setNotice(t("screenControlTaken"));
        await open("watch");
      } else if (outcome === "ticket" && spent.current < 1) {
        spent.current += 1;
        setNotice(t("screenTicketSpent"));
        await open("watch");
      } else if (outcome === "stopped") {
        setNotice(t("screenWentDown"));
        await load();
      } else if (outcome === "refused") {
        setError(t("screenOriginRefused"));
        setPhase("refused");
      } else {
        setNotice(t("screenLost"));
        setPhase("lost");
      }
    }
    async function open(mode, why) {
      try {
        const ticket = mode === "watch" ? await watchScreen(bot) : await takeScreen(bot, why);
        if (alive.current) await connect(mode, ticket);
      } catch (e) {
        if (!alive.current) return;
        setError(errText(e));
        if (mode === "control" && live.current) setPhase("watching");
        else setPhase("error");
      }
    }
    async function start() {
      setPhase("starting");
      setError(null);
      try {
        const { screen: s } = await startScreen(bot);
        if (!alive.current) return;
        setScreen(s);
        if (screenState(s).kind === "running") await open("watch");
        else setPhase("idle");
      } catch (e) {
        if (!alive.current) return;
        const d = e instanceof ApiError ? e.details ?? {} : {};
        if (e instanceof ApiError && e.code === "screen_not_installed") setRefusal({ kind: "not_installed", missing: Array.isArray(d.missing) ? d.missing.map(String) : [], installCommand: typeof d.install_command === "string" ? d.install_command : null });
        else if (e instanceof ApiError && e.code === "screen_no_memory") setRefusal({ kind: "no_memory", availableMb: d.available_mb ?? null, neededMb: d.needed_mb ?? null, blocker: null });
        else if (e instanceof ApiError && e.code === "screen_unsupported") setRefusal({ kind: "unsupported" });
        else setError(errText(e));
        setPhase("idle");
      }
    }
    async function giveBack() {
      setConfirm(null);
      try {
        await returnScreen(bot);
        if (alive.current) {
          setNotice(null);
          await open("watch");
        }
      } catch (e) {
        if (alive.current) setError(errText(e));
      }
    }
    react_default.useEffect(() => {
      alive.current = true;
      void load();
      return () => {
        alive.current = false;
        drop();
      };
    }, [load]);
    const showing = phase === "watching" || phase === "control";
    react_default.useEffect(() => {
      if (!showing) return;
      const id = window.setInterval(() => {
        const f = frames.current;
        if (!f || live.current?.ws !== f.ws) return;
        const sig = canvasSignature(target.current?.querySelector("canvas") ?? null);
        const now = Date.now();
        if (sig === null) {
          setNoImage(null);
          return;
        }
        if (sig !== "blank" && sig !== f.sig) {
          f.sig = sig;
          f.painted = now;
          f.pending = null;
        }
        setNoImage(noImageFor(now, f));
      }, 1e3);
      return () => window.clearInterval(id);
    }, [showing]);
    const reconnect = () => {
      setNoImage(null);
      frames.current = null;
      void open(phase === "control" ? "control" : "watch");
    };
    const onType = (e) => {
      const rfb = live.current?.rfb;
      const text = e.currentTarget.value;
      e.currentTarget.value = "";
      if (rfb) for (const ch of Array.from(text)) rfb.sendKey(keysymOf(ch), null);
    };
    const onTypeKey = (e) => {
      const rfb = live.current?.rfb;
      if (!rfb) return;
      if (e.key === "Enter") {
        e.preventDefault();
        rfb.sendKey(XK_RETURN, "Enter");
      } else if (e.key === "Backspace") {
        e.preventDefault();
        rfb.sendKey(XK_BACKSPACE, "Backspace");
      }
    };
    const state = refusal ?? (screen ? screenState(screen) : null);
    const otherHuman = screen?.lease.holder === "human" && !screen.lease.mine;
    const showCanvas = phase === "connecting" || phase === "watching" || phase === "control";
    const status = phase === "loading" ? t("screenLoading") : phase === "starting" ? t("screenStarting") : phase === "connecting" ? t("screenConnecting") : phase === "watching" ? otherHuman ? t("screenOtherHuman") : t("screenWatching") : phase === "control" ? t("screenInControl") : null;
    return /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 10, minHeight: 0, height: "100%" }, children: [
      /* @__PURE__ */ jsx("p", { role: "status", "aria-live": "polite", style: { ...muted2, minHeight: 18 }, children: [notice2, status].filter(Boolean).join(" ") }),
      error && /* @__PURE__ */ jsx("p", { role: "alert", style: { ...muted2, color: "var(--color-destructive)" }, children: /* @__PURE__ */ jsx(ErrorNote, { error }) }),
      !showCanvas && state && phase !== "loading" && /* @__PURE__ */ jsx(Refusal, { state, t, onStart: () => void start(), busy: phase === "starting" }),
      (phase === "lost" || phase === "error") && /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn", style: { alignSelf: "flex-start" }, onClick: () => {
        setError(null);
        setNotice(null);
        void load();
      }, children: phase === "lost" ? t("screenReconnectBtn") : t("screenRetryBtn") }),
      /* @__PURE__ */ jsx(
        "div",
        {
          ref: target,
          role: "region",
          "aria-label": t("screenRegion", { name: label }),
          tabIndex: showCanvas ? 0 : -1,
          hidden: !showCanvas,
          className: "lb-screen",
          "data-mode": phase === "control" ? "control" : "watch"
        }
      ),
      phase === "control" && /* @__PURE__ */ jsx("div", { className: "lb-screen-banner", role: "note", children: t("screenInControl") }),
      showing && noImage !== null && /* @__PURE__ */ jsxs("div", { role: "status", style: { ...box2, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, children: [
        /* @__PURE__ */ jsx("p", { style: muted2, children: t("screenNoImage", { n: Math.floor(noImage / 5) * 5 }) }),
        /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn", onClick: reconnect, children: t("screenReconnectBtn") })
      ] }),
      (phase === "watching" || phase === "control") && /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 }, children: [
        phase === "watching" ? /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn lb-btn-primary", onClick: () => {
          setReason("");
          setConfirm("take");
        }, children: t("screenTakeBtn") }) : /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn lb-btn-primary", onClick: () => setConfirm("return"), children: t("screenReturnBtn") }),
        phase === "control" && narrow && /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn", onClick: () => kbd.current?.focus(), children: t("screenKeyboardBtn") }),
        typeof target.current?.requestFullscreen === "function" && /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn", onClick: () => void target.current?.requestFullscreen(), children: t("screenFullscreenBtn") })
      ] }),
      phase === "control" && narrow && /* @__PURE__ */ jsx(
        "textarea",
        {
          ref: kbd,
          "aria-label": t("screenKeyboardInput"),
          className: "lb-screen-kbd",
          autoCapitalize: "off",
          autoCorrect: "off",
          spellCheck: false,
          onInput: onType,
          onKeyDown: onTypeKey
        }
      ),
      /* @__PURE__ */ jsx(Dialog, { open: confirm === "take", onClose: () => setConfirm(null), title: t("screenTakeTitle"), titleId: "screen-take-title", tone: "warning", children: /* @__PURE__ */ jsxs("div", { className: "lb-dialog-body", children: [
        /* @__PURE__ */ jsx("p", { style: muted2, children: t("screenTakeBody") }),
        otherHuman && /* @__PURE__ */ jsx("p", { style: muted2, children: t("screenTakeOther") }),
        /* @__PURE__ */ jsxs("div", { className: "lb-field", children: [
          /* @__PURE__ */ jsx("label", { className: "lb-label", htmlFor: "screen-take-reason", children: t("screenReasonLabel") }),
          /* @__PURE__ */ jsx("input", { id: "screen-take-reason", className: "lb-input", maxLength: 120, value: reason, onChange: (e) => setReason(e.target.value) })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "lb-dialog-footer", children: [
          /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn", onClick: () => setConfirm(null), children: t("cancelBtn") }),
          /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn lb-btn-primary", onClick: () => {
            setConfirm(null);
            setNotice(null);
            setError(null);
            void open("control", reason.trim() || void 0);
          }, children: t("screenTakeConfirm") })
        ] })
      ] }) }),
      /* @__PURE__ */ jsx(Dialog, { open: confirm === "return", onClose: () => setConfirm(null), title: t("screenReturnTitle"), titleId: "screen-return-title", children: /* @__PURE__ */ jsxs("div", { className: "lb-dialog-body", children: [
        /* @__PURE__ */ jsx("p", { style: muted2, children: t("screenReturnBody") }),
        /* @__PURE__ */ jsxs("div", { className: "lb-dialog-footer", children: [
          /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn", onClick: () => setConfirm(null), children: t("cancelBtn") }),
          /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn lb-btn-primary", onClick: () => void giveBack(), children: t("screenReturnConfirm") })
        ] })
      ] }) })
    ] });
  }
  function Refusal({ state, t, onStart, busy }) {
    switch (state.kind) {
      case "unsupported":
        return /* @__PURE__ */ jsx("div", { style: box2, children: /* @__PURE__ */ jsx("p", { style: muted2, children: t("screenUnsupported") }) });
      case "not_installed":
        return /* @__PURE__ */ jsxs("div", { style: box2, children: [
          /* @__PURE__ */ jsx("p", { style: muted2, children: t("screenNotInstalled") }),
          state.missing.length > 0 && /* @__PURE__ */ jsxs("p", { style: muted2, children: [
            /* @__PURE__ */ jsxs("strong", { children: [
              t("screenMissingLabel"),
              ":"
            ] }),
            " ",
            state.missing.join(", ")
          ] }),
          state.installCommand && /* @__PURE__ */ jsxs(Fragment2, { children: [
            /* @__PURE__ */ jsxs("p", { style: muted2, children: [
              t("screenInstallCommandLabel"),
              ":"
            ] }),
            /* @__PURE__ */ jsx("pre", { style: code, children: state.installCommand })
          ] }),
          /* @__PURE__ */ jsx("a", { href: README_SCREEN, target: "_blank", rel: "noopener noreferrer", style: { color: "var(--color-primary)", fontSize: 13 }, children: t("screenReadmeLink") })
        ] });
      case "no_memory":
        return /* @__PURE__ */ jsxs("div", { style: box2, children: [
          /* @__PURE__ */ jsx("p", { style: muted2, children: t("screenNoMemory") }),
          /* @__PURE__ */ jsx("p", { style: muted2, children: t("screenMemoryNumbers", { available: state.availableMb ?? "?", needed: state.neededMb ?? "?" }) }),
          state.blocker && /* @__PURE__ */ jsxs(Fragment2, { children: [
            /* @__PURE__ */ jsxs("p", { style: muted2, children: [
              t("screenHermesSays"),
              ":"
            ] }),
            /* @__PURE__ */ jsx("pre", { style: code, children: state.blocker })
          ] })
        ] });
      case "sandbox":
        return /* @__PURE__ */ jsx("div", { style: box2, children: /* @__PURE__ */ jsx("p", { style: muted2, children: t("screenSandbox", { placement: state.placement }) }) });
      case "stopped":
        return /* @__PURE__ */ jsxs("div", { style: box2, children: [
          /* @__PURE__ */ jsx("p", { style: muted2, children: t("screenStopped") }),
          /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn lb-btn-primary", style: { alignSelf: "flex-start" }, disabled: busy, onClick: onStart, children: t("screenStartBtn") })
        ] });
      default:
        return null;
    }
  }

  // dashboard/src/components/pages/pages.ts
  var SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  var isSlug = (s) => typeof s === "string" && SLUG_RE.test(s);
  var SHA_RE = /^[0-9a-f]{64}$/;
  var seenKey = (bot, slug) => `luvebot:pages:seen:${bot}:${slug}`;
  function lastSeenSha(bot, slug) {
    try {
      const v = window.localStorage.getItem(seenKey(bot, slug));
      return v && SHA_RE.test(v) ? v : null;
    } catch {
      return null;
    }
  }
  function markSeen(bot, slug, sha) {
    if (!SHA_RE.test(sha)) return;
    try {
      window.localStorage.setItem(seenKey(bot, slug), sha);
    } catch {
    }
  }
  function changedSinceSeen(bot, slug, sha) {
    const seen = lastSeenSha(bot, slug);
    return seen !== null && seen !== sha;
  }
  var BLOCK_COPY = {
    unsupported: "pagesStateUnsupported",
    unavailable: "pagesStateUnavailable",
    no_workspace: "pagesStateNoWorkspace",
    not_local: "pagesStateNotLocal",
    inside_hermes: "pagesStateInsideHermes",
    unsafe: "pagesStateUnsafe",
    restart: "errRouteMissing",
    error: "pagesStateError"
  };
  function blockText(block, bot, t) {
    if (block !== "no_workspace") return t(BLOCK_COPY[block]);
    const path = bot.isDefault === true ? "~/.hermes/config.yaml" : bot.isDefault === false ? `~/.hermes/profiles/${bot.name}/config.yaml` : t("pagesProfileConfigFile");
    return t("pagesStateNoWorkspace", { name: bot.label || bot.name, path });
  }
  var WORKSPACE_BLOCKS = /* @__PURE__ */ new Set(["no_workspace", "not_local", "inside_hermes", "unsafe"]);
  function featureState(pages) {
    if (pages === "ok" || pages === "read_only") return pages;
    if (pages === "unavailable") return "unavailable";
    return "unsupported";
  }
  function blockOf(state) {
    if (state === "ready" || state === "empty") return null;
    return state && WORKSPACE_BLOCKS.has(state) ? state : "error";
  }
  var PAGE_404 = /* @__PURE__ */ new Set(["page_not_found", "revision_not_found"]);
  function blockFromError(e) {
    if (e instanceof ApiError) {
      if (e.code === "pages_unavailable") {
        const reason = e.details?.reason;
        if (typeof reason === "string" && WORKSPACE_BLOCKS.has(reason)) return reason;
      }
      if (e.code === "plugin_route_missing") return "restart";
      if (e.status === 404 && !PAGE_404.has(e.code)) return "unsupported";
      if (e.code === "capability_missing") return "unavailable";
    }
    return "error";
  }
  var errCode = (e) => e instanceof ApiError ? e.code : null;
  var errDetails = (e) => e instanceof ApiError && e.details ? e.details : {};
  var MAX_CELLS = 4e6;
  function lineDiff(before, after) {
    const a = before.split("\n");
    const b = after.split("\n");
    if (a.length * b.length > MAX_CELLS) return null;
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i2 = n - 1; i2 >= 0; i2--) for (let j2 = m - 1; j2 >= 0; j2--) dp[i2][j2] = a[i2] === b[j2] ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push({ kind: "same", text: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: "del", text: a[i++] });
      else out.push({ kind: "add", text: b[j++] });
    }
    while (i < n) out.push({ kind: "del", text: a[i++] });
    while (j < m) out.push({ kind: "add", text: b[j++] });
    return out;
  }
  function titleFrom(text) {
    const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    return line.replace(/^#+\s*/, "").replace(/[*_`]/g, "").slice(0, 120).trim();
  }
  var AUTOSAVE_IDLE_MS = 3e3;
  var MIN_SAVE_GAP_MS = 1e3;
  var MAX_PAGE_BYTES = 1024 * 1024;

  // dashboard/src/components/conversation/FileCard.tsx
  var EXT = /\.(?:md|txt|html?|csv|json|pdf|png|jpe?g|gif|webp|zip|docx|xlsx|pptx)$/i;
  var TOKEN = /[\p{L}\p{N}_\-./~]+\.(?:md|txt|html?|csv|json|pdf|png|jpe?g|gif|webp|zip|docx|xlsx|pptx)(?![\p{L}\p{N}_])/giu;
  var MAX2 = 3;
  function workspacePath(raw) {
    let p = raw.trim().replace(/^\.\//, "");
    if (p.startsWith("/")) {
      const m = p.match(/\/workspace\/(.+)$/);
      if (!m) return null;
      p = m[1];
    }
    if (p.length > 1024 || p.includes("\\") || p.startsWith("~")) return null;
    const parts = p.split("/");
    if (parts.length > 16 || parts.some((x) => !x || x.startsWith("."))) return null;
    return EXT.test(p) ? p : null;
  }
  function citedFiles(text) {
    const out = [];
    const add = (raw) => {
      const p = workspacePath(raw);
      if (p && !out.includes(p)) out.push(p);
    };
    const plain = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
    for (const m of plain.matchAll(/`([^`\n]{1,1024})`/g)) add(m[1]);
    for (const m of plain.replace(/`[^`\n]*`/g, " ").matchAll(TOKEN)) add(m[0]);
    return out.slice(0, MAX2);
  }
  var ERRORS = { file_redacted: "fileErrRedacted", workspace_unavailable: "fileErrNoWorkspace", too_large: "fileErrTooLarge" };
  function useFileDownloads(bot) {
    const { t } = useLuveI18n();
    const [state, setState] = react_default.useState({});
    const download = react_default.useCallback(async (key, path) => {
      setState((s) => ({ ...s, [key]: { busy: true } }));
      try {
        const { name, blob } = await downloadBotFile(bot, path);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        setState((s) => ({ ...s, [key]: {} }));
      } catch (e) {
        const error = !(e instanceof ApiError) ? t("fileErrNetwork") : e.status === 404 && e.code !== "plugin_route_missing" ? t("fileErrNotFound") : ERRORS[e.code] ? t(ERRORS[e.code]) : humanError(e, t, "fileErrGeneric");
        setState((s) => ({ ...s, [key]: { error } }));
      }
    }, [bot, t]);
    return { state, download };
  }
  var PAGE_FILE = /^pages\/([a-z0-9][a-z0-9-]{0,63})\.md$/;
  var COPY_ERRORS = { too_large: "pageTooLarge", capability_missing: "pagesReadOnly", pages_unavailable: "fileCopyNoPages" };
  function FileCard({ path, botLabel, state, onDownload, bot, onOpenPage }) {
    const { t } = useLuveI18n();
    const name = path.split("/").pop() ?? path;
    const pageSlug = PAGE_FILE.exec(path)?.[1];
    const editable = !!bot && !!onOpenPage && /\.md$/i.test(path);
    const [copy, setCopy] = react_default.useState({});
    async function openInEditor() {
      if (!bot || !onOpenPage || copy.busy) return;
      setCopy({ busy: true });
      try {
        const { blob } = await downloadBotFile(bot, path);
        const { page } = await createPage(bot, { title: name.replace(/\.md$/i, ""), content: await blob.text() });
        setCopy({});
        onOpenPage(page.slug);
      } catch (e) {
        const code2 = errCode(e) ?? "";
        if (code2 === "page_exists") {
          setCopy({ existing: String(errDetails(e).slug ?? "") });
          return;
        }
        setCopy({ error: COPY_ERRORS[code2] ? t(COPY_ERRORS[code2]) : e instanceof ApiError && e.status === 404 && code2 !== "plugin_route_missing" ? t("fileErrNotFound") : ERRORS[code2] ? t(ERRORS[code2]) : humanError(e, t, "fileErrGeneric") });
      }
    }
    return /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsxs("div", { className: "lb-page-card", children: [
        /* @__PURE__ */ jsxs("span", { "aria-hidden": "true", className: "lb-page-glyph", children: [
          /* @__PURE__ */ jsx("i", {}),
          /* @__PURE__ */ jsx("i", {}),
          /* @__PURE__ */ jsx("i", {})
        ] }),
        /* @__PURE__ */ jsxs("span", { className: "lb-row-stack", children: [
          /* @__PURE__ */ jsx("span", { className: "lb-headline lb-truncate", children: name }),
          /* @__PURE__ */ jsx("span", { className: "lb-caption lb-truncate", children: t("fileCardMeta", { name: botLabel, path }) })
        ] }),
        /* @__PURE__ */ jsx("button", { type: "button", onClick: onDownload, disabled: state?.busy, className: "lb-btn", "aria-label": t("fileDownloadNamed", { file: name }), children: state?.busy ? t("fileDownloading") : t("fileDownload") }),
        editable && pageSlug && /* @__PURE__ */ jsx("button", { type: "button", onClick: () => onOpenPage(pageSlug), className: "lb-btn", "aria-label": t("fileEditNamed", { file: name }), children: t("fileEdit") }),
        editable && !pageSlug && /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void openInEditor(), disabled: copy.busy, className: "lb-btn", "aria-label": t("fileOpenInEditorNamed", { file: name }), children: copy.busy ? t("fileOpening") : t("fileOpenInEditor") })
      ] }),
      editable && !pageSlug && !copy.existing && /* @__PURE__ */ jsx("p", { className: "lb-caption", style: { margin: "0 4px 8px" }, children: t("fileCopyNote") }),
      copy.existing && /* @__PURE__ */ jsxs("p", { role: "status", className: "lb-caption", style: { margin: "0 4px 8px" }, children: [
        t("fileCopyExists", { slug: copy.existing }),
        " ",
        /* @__PURE__ */ jsx("button", { type: "button", onClick: () => onOpenPage(copy.existing), className: "lb-btn lb-btn-plain", children: t("fileOpenExisting") })
      ] }),
      state?.error && /* @__PURE__ */ jsx("p", { role: "alert", className: "lb-caption", style: { margin: "0 4px 8px", color: "var(--color-destructive)" }, children: /* @__PURE__ */ jsx(ErrorNote, { error: state.error }) }),
      copy.error && /* @__PURE__ */ jsx("p", { role: "alert", className: "lb-caption", style: { margin: "0 4px 8px", color: "var(--color-destructive)" }, children: /* @__PURE__ */ jsx(ErrorNote, { error: copy.error }) })
    ] });
  }

  // dashboard/src/components/conversation/WorkPanel.tsx
  var muted3 = { color: "var(--color-muted-foreground)", font: "400 13px/18px var(--lb-font)" };
  var mono = { fontFamily: "var(--lb-mono)", fontSize: 12, lineHeight: "17px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 };
  var item = { padding: "10px 12px", borderRadius: 12, background: "var(--lb-fill)", marginBottom: 8 };
  var ICON = { running: "\u27F3", done: "\u2713", error: "\u2715" };
  var Empty = ({ children }) => /* @__PURE__ */ jsx("p", { style: { ...muted3, padding: "24px 8px", textAlign: "center", margin: 0 }, children });
  function WorkPanel({ items, fileTools, turns, focus, bot, delivered = [], onOpenPage }) {
    const { t } = useLuveI18n();
    const [tab, setTab] = react_default.useState("atividade");
    const s = { items };
    const panelRef = react_default.useRef(null);
    react_default.useEffect(() => {
      if (!focus) return;
      setTab("atividade");
      requestAnimationFrame(() => {
        const el = panelRef.current?.querySelector(`[data-work-turn="${focus.turnId}"]`);
        el?.scrollIntoView?.({ block: "start" });
        el?.focus();
      });
    }, [focus]);
    const tabs = [
      ["atividade", t("tabActivity")],
      ["terminal", t("tabTerminal")],
      ["arquivos", t("tabFiles")],
      ...bot ? [["tela", t("tabScreen")]] : []
      // D-007: the Bot's live screen, read from Hermes
    ];
    return /* @__PURE__ */ jsxs("div", { "aria-label": t("workPanelBtn"), style: { display: "flex", flexDirection: "column", minHeight: 0, height: "100%", background: "var(--color-card)", color: "var(--color-card-foreground)", fontFamily: "var(--lb-font)" }, children: [
      /* @__PURE__ */ jsx("div", { role: "tablist", "aria-label": t("workPanelTabs"), className: "lb-segmented lb-segmented-fit", style: { margin: 12 }, children: tabs.map(([k, label]) => /* @__PURE__ */ jsx("button", { type: "button", role: "tab", "aria-selected": tab === k, onClick: () => setTab(k), className: "lb-segment", children: label }, k)) }),
      /* @__PURE__ */ jsxs("div", { ref: panelRef, role: "tabpanel", style: { flex: 1, overflowY: "auto", padding: "0 12px 12px" }, children: [
        tab === "atividade" && (turns ? /* @__PURE__ */ jsx(TurnsActivity, { turns, t }) : /* @__PURE__ */ jsx(Activity, { s, t })),
        tab === "terminal" && /* @__PURE__ */ jsx(Terminal, { s, t }),
        tab === "arquivos" && /* @__PURE__ */ jsx(Files, { s, tools: fileTools, delivered, botLabel: bot?.label ?? "", bot: bot?.name, onOpenPage, t }),
        tab === "tela" && bot && /* @__PURE__ */ jsx(ScreenTab, { bot: bot.name, label: bot.label })
      ] })
    ] });
  }
  function Activity({ s, t }) {
    const rows = deriveActivity(s);
    if (!rows.length) return /* @__PURE__ */ jsx(Empty, { children: t("emptyActivity") });
    return /* @__PURE__ */ jsx("ol", { style: { listStyle: "none", margin: 0, padding: 0 }, children: rows.map((r) => r.kind === "commentary" ? /* @__PURE__ */ jsx("li", { style: { ...muted3, padding: "4px 4px 10px" }, children: r.text }, r.id) : /* @__PURE__ */ jsxs("li", { style: item, children: [
      /* @__PURE__ */ jsxs("span", { style: { font: "400 14px/20px var(--lb-font)", color: r.status === "error" ? "var(--color-destructive)" : void 0 }, children: [
        ICON[r.status],
        " ",
        /* @__PURE__ */ jsx("strong", { style: { fontWeight: 600 }, children: r.name })
      ] }),
      r.durationS !== void 0 && /* @__PURE__ */ jsxs("span", { style: muted3, children: [
        " ",
        r.durationS.toFixed(1),
        "s"
      ] }),
      r.preview && /* @__PURE__ */ jsx("div", { style: { ...muted3, overflowWrap: "anywhere" }, children: r.preview }),
      r.error && /* @__PURE__ */ jsx("div", { style: { color: "var(--color-destructive)", fontSize: 12, overflowWrap: "anywhere" }, children: r.error })
    ] }, r.id)) });
  }
  function TurnsActivity({ turns, t }) {
    const shown = turns.filter((x) => deriveActivity({ items: x.items }).length > 0);
    if (!shown.length) return /* @__PURE__ */ jsx(Empty, { children: t("emptyActivity") });
    return /* @__PURE__ */ jsx(Fragment2, { children: shown.map((x) => /* @__PURE__ */ jsxs("section", { "data-work-turn": x.id, tabIndex: -1, "aria-label": x.label, className: "lb-work-turn", children: [
      /* @__PURE__ */ jsx("h3", { className: "lb-caption lb-truncate", style: { margin: "10px 4px 6px" }, children: x.label }),
      /* @__PURE__ */ jsx(Activity, { s: { items: x.items }, t })
    ] }, x.id)) });
  }
  function Terminal({ s, t }) {
    const rows = deriveTerminal(s);
    if (!rows.length) return /* @__PURE__ */ jsx(Empty, { children: t("emptyTerminal") });
    return /* @__PURE__ */ jsx("div", { children: rows.map((r) => /* @__PURE__ */ jsxs("div", { style: item, children: [
      /* @__PURE__ */ jsxs("pre", { style: { ...mono, color: "var(--color-primary)" }, children: [
        "$ ",
        r.command
      ] }),
      r.output !== void 0 ? /* @__PURE__ */ jsx("pre", { style: mono, children: r.output }) : /* @__PURE__ */ jsx("div", { style: muted3, children: r.status === "running" ? t("runningStatus") : t("noOutputChannel") }),
      r.exitCode !== void 0 && /* @__PURE__ */ jsxs("div", { style: muted3, children: [
        t("outputExit"),
        " ",
        r.exitCode,
        r.durationS !== void 0 ? ` \xB7 ${r.durationS.toFixed(1)}s` : ""
      ] })
    ] }, r.id)) });
  }
  function Files({ s, tools, delivered, botLabel, bot, onOpenPage, t }) {
    const rows = deriveFiles(s, tools);
    if (!rows.length && !delivered.length) return /* @__PURE__ */ jsx(Empty, { children: t("emptyFiles") });
    return /* @__PURE__ */ jsxs(Fragment2, { children: [
      rows.length > 0 && /* @__PURE__ */ jsx("ul", { style: { listStyle: "none", margin: 0, padding: 0 }, children: rows.map((r) => /* @__PURE__ */ jsxs("li", { style: item, children: [
        /* @__PURE__ */ jsx("span", { style: muted3, children: r.op === "write" ? t("writtenOp") : t("readOp") }),
        " ",
        /* @__PURE__ */ jsx("code", { style: { overflowWrap: "anywhere" }, children: r.path }),
        r.preview && /* @__PURE__ */ jsx("pre", { style: { ...mono, ...muted3 }, children: r.preview })
      ] }, r.id)) }),
      delivered.length > 0 && /* @__PURE__ */ jsxs("section", { "aria-label": t("filesDelivered"), children: [
        /* @__PURE__ */ jsx("h4", { className: "lb-caption", style: { margin: "8px 4px" }, children: t("filesDelivered") }),
        delivered.map((d) => /* @__PURE__ */ jsx(FileCard, { path: d.path, botLabel, state: d.state, onDownload: d.onDownload, bot, onOpenPage }, d.key))
      ] })
    ] });
  }

  // dashboard/src/components/conversation/StepsLine.tsx
  var ICON2 = { running: "\u27F3", done: "\u2713", error: "\u2715" };
  function stepsSummary(tools) {
    const unique = Array.from(new Set(tools.map((x) => x.name)));
    const names = unique.slice(0, 2).join(", ") + (unique.length > 2 ? "\u2026" : "");
    const state = tools.some((x) => x.status === "running") ? "running" : tools.some((x) => x.status === "error") ? "error" : "done";
    return { count: tools.length, names, state };
  }
  function StepsLine({ tools, onOpenActivity }) {
    const { t } = useLuveI18n();
    const [open, setOpen] = react_default.useState(false);
    const id = react_default.useId();
    const s = stepsSummary(tools);
    const count = t(s.count === 1 ? "stepsOne" : "stepsMany", { count: s.count });
    const state = t(s.state === "running" ? "stepsRunning" : s.state === "error" ? "stepsError" : "stepsDone");
    return /* @__PURE__ */ jsxs("div", { className: "lb-steps", "data-state": s.state, children: [
      /* @__PURE__ */ jsxs("div", { className: "lb-steps-line", children: [
        /* @__PURE__ */ jsxs("button", { type: "button", className: "lb-steps-toggle", "aria-expanded": open, "aria-controls": id, onClick: () => setOpen((o) => !o), children: [
          /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: ICON2[s.state] }),
          " ",
          /* @__PURE__ */ jsx("strong", { children: count }),
          " \xB7 ",
          s.names,
          " ",
          /* @__PURE__ */ jsxs("span", { className: "lb-caption", children: [
            "\xB7 ",
            state
          ] })
        ] }),
        /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn lb-btn-plain", onClick: onOpenActivity, children: t("stepsSeeInActivity") })
      ] }),
      open && /* @__PURE__ */ jsx("div", { id, className: "lb-steps-detail", children: tools.map((x) => /* @__PURE__ */ jsx(ToolCard, { name: x.name, status: x.status, preview: x.preview, args: x.args, durationS: x.durationS, result: x.result }, x.id)) })
    ] });
  }

  // dashboard/src/components/conversation/delegate.ts
  var DELEGATE_TOOL = "delegate_task";
  var DELIVERY_MS = 5e3;
  var DELIVERY_TRIES = 120;
  var unescape = (s) => {
    try {
      return JSON.parse(`"${s}"`);
    } catch {
      return s;
    }
  };
  function delegateSummary(result) {
    const text = result?.trim();
    if (!text) return void 0;
    try {
      const data = JSON.parse(text);
      const rows = data && typeof data === "object" && Array.isArray(data.results) ? data.results : [data];
      const found = rows.map((r) => r && typeof r === "object" ? r.summary : void 0).filter((x) => typeof x === "string" && !!x.trim());
      if (found.length) return found.join("\n\n");
    } catch {
      const cut = [...text.matchAll(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)/g)].map((m) => unescape(m[1])).filter((x) => x.trim());
      if (cut.length) {
        const cutShort = text.endsWith("...");
        if (cutShort) cut[cut.length - 1] = cut[cut.length - 1].replace(/\.\.\.$/, "");
        return cut.join("\n\n") + (cutShort ? "\u2026" : "");
      }
    }
    return text;
  }
  function dispatchedId(result) {
    try {
      const d = JSON.parse(result ?? "");
      return d && d.status === "dispatched" && typeof d.delegation_id === "string" && d.delegation_id ? d.delegation_id : null;
    } catch {
      const text = result ?? "";
      const id = /"delegation_id"\s*:\s*"([^"\\]+)"/.exec(text)?.[1];
      return /^\s*\{\s*"status"\s*:\s*"dispatched"/.test(text) && id ? id : null;
    }
  }
  function dispatchedGoal(result) {
    try {
      const goals = JSON.parse(result ?? "").goals;
      return Array.isArray(goals) && typeof goals[0] === "string" ? goals[0] : void 0;
    } catch {
      return void 0;
    }
  }
  function delegateView(tool, deliveries = /* @__PURE__ */ new Map(), late = /* @__PURE__ */ new Set()) {
    const goal = typeof tool.args?.goal === "string" ? tool.args.goal : tool.preview ?? "";
    if (tool.status === "running") return { goal, status: "running" };
    if (tool.status === "error") return { goal, status: "failed", summary: delegateSummary(tool.result) };
    const id = dispatchedId(tool.result);
    if (!id) return { goal, status: "completed", summary: delegateSummary(tool.result) };
    const delivered = deliveries.get(id);
    if (delivered) return { goal, status: delivered.status, summary: delivered.text, delegationId: id };
    return { goal, status: late.has(id) ? "background_late" : "background", delegationId: id };
  }
  function backgroundIds(items, deliveries) {
    return items.flatMap((i) => i.kind === "tool" && i.name === DELEGATE_TOOL && i.status === "done" ? [dispatchedId(i.result)] : []).filter((id) => !!id && !deliveries.has(id));
  }
  function fillFromDelegate(sub, items, deliveries = /* @__PURE__ */ new Map(), late = /* @__PURE__ */ new Set()) {
    if (sub.summary || sub.status !== "unknown" && sub.status !== "running") return null;
    const done = items.filter((i) => i.kind === "tool" && i.name === DELEGATE_TOOL && i.status !== "running");
    const call = done.find((t) => delegateView(t).goal === sub.goal) ?? (done.length === 1 ? done[0] : void 0);
    if (!call) return null;
    const v = delegateView(call, deliveries, late);
    return { status: v.status, summary: v.summary };
  }
  var TASK = /^---\s*(\S+)\s*TASK\s+\d+\/\d+:\s*(.*?)\s*\(status=([a-z_]+)[^)]*\)\s*---\s*$/;
  function deliveryView(text, meta) {
    const id = meta?.delegation_id || /^\[ASYNC DELEGATION[^\]]*?(deleg_[A-Za-z0-9_-]+)\]/.exec(text.trim())?.[1];
    const tasks = [];
    for (const line of text.split("\n")) {
      const head = TASK.exec(line.trim());
      if (head) {
        tasks.push({ goal: head[2], status: head[3], lines: [] });
        continue;
      }
      const cur = tasks[tasks.length - 1];
      if (!cur || /^Full live transcript/.test(line) || /^---/.test(line.trim())) continue;
      cur.lines.push(line);
    }
    const parts = tasks.map((x) => ({ ...x, body: x.lines.join("\n").trim() })).filter((x) => x.body);
    const summary = !parts.length ? text : parts.length === 1 ? parts[0].body : parts.map((x) => `**${x.goal}**

${x.body}`).join("\n\n");
    const failedOnly = tasks.length > 0 && tasks.every((x) => x.status === "failed" || x.status === "error");
    const status = meta && (meta.failed_count !== void 0 || meta.completed_count !== void 0) ? deliveryStatus(meta) : failedOnly ? "failed" : "completed";
    return { id, status, summary };
  }
  function deliveriesOf(rows) {
    const out = /* @__PURE__ */ new Map();
    for (const r of rows) {
      if (r.display_kind !== "async_delegation_complete") continue;
      const v = deliveryView(r.text, r.display_metadata);
      if (v.id) out.set(v.id, { status: v.status, text: v.summary });
    }
    return out;
  }
  var deliveryStatus = (m) => (m?.failed_count ?? 0) > 0 && !(m?.completed_count ?? 0) ? "failed" : "completed";

  // dashboard/src/lib/stream/sse.ts
  var MAX_BUFFER = 1e6;
  var SseParser = class {
    dec = new TextDecoder("utf-8");
    buf = "";
    ev = "";
    id;
    data = [];
    push(chunk) {
      this.buf += typeof chunk === "string" ? chunk : this.dec.decode(chunk, { stream: true });
      if (this.buf.length > MAX_BUFFER) throw new Error("sse: frame too large");
      const hold = this.buf.endsWith("\r") ? "\r" : "";
      const text = (hold ? this.buf.slice(0, -1) : this.buf).replace(/\r\n|\r/g, "\n");
      const lines = text.split("\n");
      this.buf = lines.pop() + hold;
      const out = [];
      for (const line of lines) {
        const f = this.line(line);
        if (f) out.push(f);
      }
      return out;
    }
    /** An event cut off before its blank line is discarded, as the SSE spec says. */
    end() {
      this.buf = "";
      this.ev = "";
      this.id = void 0;
      this.data = [];
    }
    line(line) {
      if (line === "") {
        const raw = this.data.join("\n"), ev = this.ev, id = this.id;
        const had = this.data.length > 0;
        this.ev = "";
        this.id = void 0;
        this.data = [];
        if (!had) return null;
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          return null;
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) return null;
        const d = data;
        const event = ev || (typeof d.event === "string" ? d.event : "");
        return event ? { event, id, data: d } : null;
      }
      if (line.startsWith(":")) return null;
      const i = line.indexOf(":");
      const field2 = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field2 === "event") this.ev = value;
      else if (field2 === "id") this.id = value;
      else if (field2 === "data") this.data.push(value);
      return null;
    }
  };
  var StreamHttpError = class extends Error {
    constructor(status) {
      super(`stream http ${status}`);
      this.status = status;
    }
  };
  async function readFrames(res, onFrame, signal) {
    if (!res.ok) throw new StreamHttpError(res.status);
    if (!res.body) throw new Error("stream: response has no body");
    const reader = res.body.getReader();
    const parser = new SseParser();
    const onAbort = () => {
      reader.cancel().catch(() => {
      });
    };
    signal?.addEventListener("abort", onAbort);
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const f of parser.push(value)) onFrame(f);
      }
    } catch (e) {
      if (!signal?.aborted) throw e;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      parser.end();
    }
  }
  async function openStream(url, onFrame, opts = {}) {
    if (/[?&](token|access_token|session_token)=/i.test(url)) throw new Error("stream: token must travel in a header, not the URL");
    const fetcher = opts.fetcher ?? getSDK2()?.authedFetch;
    if (!fetcher) throw new Error("stream: Hermes Plugin SDK authedFetch is not available");
    const res = await fetcher(url, {
      method: opts.method ?? "GET",
      body: opts.body,
      headers: { Accept: "text/event-stream", ...opts.headers },
      signal: opts.signal
    });
    await readFrames(res, onFrame, opts.signal);
  }

  // dashboard/src/lib/stream/reducer.ts
  var initialTranscript = () => ({
    surface: null,
    status: "idle",
    items: [],
    subagents: {},
    lastSeq: -1,
    done: false
  });
  var RUN_ONLY = /* @__PURE__ */ new Set(["message.delta", "reasoning.available", "message.interim", "subagent.start", "subagent.complete"]);
  var CHAT_ONLY = /* @__PURE__ */ new Set(["run.started", "message.started", "assistant.delta", "assistant.commentary", "assistant.completed", "tool.progress", "done"]);
  var KNOWN = /* @__PURE__ */ new Set([...RUN_ONLY, ...CHAT_ONLY, "tool.started", "tool.completed", "tool.failed", "approval.request", "run.completed", "run.cancelled", "run.failed"]);
  var str2 = (v) => typeof v === "string" ? v : void 0;
  var TERMINAL2 = ["completed", "cancelled", "failed"];
  function withItems(s, items, patch = {}) {
    return { ...s, ...patch, items };
  }
  function appendText(s, kind, text, patch) {
    const last2 = s.items[s.items.length - 1];
    if (last2 && last2.kind === kind) {
      return withItems(s, [...s.items.slice(0, -1), { ...last2, text: last2.text + text }], patch);
    }
    return withItems(s, [...s.items, { kind, id: `i${s.items.length}`, text }], patch);
  }
  function startTool(s, f, patch) {
    const name = str2(f.tool_name) ?? str2(f.tool) ?? "?";
    const messageId = str2(f.message_id);
    const twin = s.items.some((i) => i.kind === "tool" && i.status === "running" && i.name === name && i.messageId === messageId);
    const items = twin ? s.items.map((i) => i.kind === "tool" && i.status === "running" && i.name === name && i.messageId === messageId ? { ...i, ambiguous: true } : i) : s.items;
    const tool = {
      kind: "tool",
      id: `i${items.length}`,
      messageId,
      name,
      status: "running",
      preview: str2(f.preview),
      args: f.args && typeof f.args === "object" ? f.args : void 0,
      ambiguous: twin || void 0
    };
    return withItems(s, [...items, tool], patch);
  }
  function finishTool(s, event, f, patch) {
    const name = str2(f.tool_name) ?? str2(f.tool) ?? "?";
    const messageId = str2(f.message_id);
    const status = event === "tool.failed" || f.error === true ? "error" : "done";
    const preview = str2(f.preview);
    const fields = {
      status,
      durationS: typeof f.duration === "number" ? f.duration : void 0,
      result: preview
      // run surface: JSON result; chat surface: null (A-11, card shows only "done")
    };
    const idx = s.items.findIndex((i) => i.kind === "tool" && i.status === "running" && i.name === name && i.messageId === messageId);
    if (idx < 0) {
      return withItems(s, [...s.items, { kind: "tool", id: `i${s.items.length}`, messageId, name, preview, ...fields }], patch);
    }
    const items = s.items.slice();
    const t = items[idx];
    items[idx] = { ...t, ...fields, preview: t.preview ?? preview };
    return withItems(s, items, patch);
  }
  function subagentKey(f) {
    if (typeof f.subagent_id === "string" && f.subagent_id) return f.subagent_id;
    if (typeof f.delegation_id === "string" && f.delegation_id) {
      const idx = f.task_index !== void 0 ? String(f.task_index) : "0";
      return `${f.delegation_id}:${idx}`;
    }
    return void 0;
  }
  function startSubagent(s, f, patch) {
    const key = subagentKey(f);
    if (!key) return s;
    const goal = str2(f.goal) ?? str2(f.preview) ?? "";
    const model = str2(f.model);
    const depth = typeof f.depth === "number" ? f.depth : void 0;
    const taskIndex = typeof f.task_index === "number" ? f.task_index : void 0;
    const taskCount = typeof f.task_count === "number" ? f.task_count : void 0;
    const parentId = str2(f.parent_id);
    const childSessionId = str2(f.child_session_id);
    const idx = s.items.findIndex((i) => i.kind === "subagent" && i.subagentId === key);
    if (idx >= 0) {
      const existing = s.items[idx];
      const updated = {
        ...existing,
        goal: goal || existing.goal,
        model: model ?? existing.model,
        depth: depth ?? existing.depth,
        taskIndex: taskIndex ?? existing.taskIndex,
        taskCount: taskCount ?? existing.taskCount,
        parentId: parentId ?? existing.parentId,
        childSessionId: childSessionId ?? existing.childSessionId
      };
      const items = s.items.slice();
      items[idx] = updated;
      const subagents2 = { ...s.subagents, [key]: updated };
      return withItems(s, items, { ...patch, subagents: subagents2 });
    }
    const item2 = {
      kind: "subagent",
      id: `i${s.items.length}`,
      subagentId: key,
      goal,
      status: "running",
      model,
      depth,
      taskIndex,
      taskCount,
      parentId,
      childSessionId
    };
    const subagents = { ...s.subagents, [key]: item2 };
    return withItems(s, [...s.items, item2], { ...patch, subagents });
  }
  function completeSubagent(s, f, patch) {
    const key = subagentKey(f);
    if (!key) return s;
    const rawStatus = str2(f.status);
    const status = rawStatus === "failed" ? "failed" : rawStatus === "timeout" ? "timeout" : "completed";
    const summary = str2(f.summary) ?? str2(f.preview);
    const durationS = typeof f.duration_seconds === "number" ? f.duration_seconds : typeof f.duration === "number" ? f.duration : void 0;
    const costCents = typeof f.cost_cents === "number" ? f.cost_cents : void 0;
    const costUsd = typeof f.cost_usd === "number" ? f.cost_usd : typeof f.cost_cents === "number" ? f.cost_cents / 100 : void 0;
    const childSessionId = str2(f.child_session_id);
    const outputTail = str2(f.output_tail);
    const filesRead = Array.isArray(f.files_read) ? f.files_read.filter((x) => typeof x === "string") : void 0;
    const filesWritten = Array.isArray(f.files_written) ? f.files_written.filter((x) => typeof x === "string") : void 0;
    const tokens = typeof f.input_tokens === "number" || typeof f.output_tokens === "number" || typeof f.reasoning_tokens === "number" ? { input: f.input_tokens, output: f.output_tokens, reasoning: f.reasoning_tokens } : void 0;
    const idx = s.items.findIndex((i) => i.kind === "subagent" && i.subagentId === key);
    if (idx < 0) {
      const goal = str2(f.goal) ?? str2(f.preview) ?? summary ?? "";
      const item2 = {
        kind: "subagent",
        id: `i${s.items.length}`,
        subagentId: key,
        goal,
        status,
        summary,
        model: str2(f.model),
        depth: typeof f.depth === "number" ? f.depth : void 0,
        taskIndex: typeof f.task_index === "number" ? f.task_index : void 0,
        taskCount: typeof f.task_count === "number" ? f.task_count : void 0,
        parentId: str2(f.parent_id),
        durationS,
        costCents,
        costUsd,
        childSessionId,
        tokens,
        filesRead,
        filesWritten,
        outputTail
      };
      const subagents2 = { ...s.subagents, [key]: item2 };
      return withItems(s, [...s.items, item2], { ...patch, subagents: subagents2 });
    }
    const existing = s.items[idx];
    const updated = {
      ...existing,
      status,
      summary: summary ?? existing.summary,
      durationS: durationS ?? existing.durationS,
      costCents: costCents ?? existing.costCents,
      costUsd: costUsd ?? existing.costUsd,
      childSessionId: childSessionId ?? existing.childSessionId,
      tokens: tokens ?? existing.tokens,
      filesRead: filesRead ?? existing.filesRead,
      filesWritten: filesWritten ?? existing.filesWritten,
      outputTail: outputTail ?? existing.outputTail
    };
    const items = s.items.slice();
    items[idx] = updated;
    const subagents = { ...s.subagents, [key]: updated };
    return withItems(s, items, { ...patch, subagents });
  }
  function terminate(s, status, f, patch) {
    if (TERMINAL2.includes(s.status)) return s;
    let items = s.items.map((i) => {
      if (i.kind === "tool" && i.status === "running") {
        return { ...i, status: status === "completed" ? "done" : "error" };
      }
      if (i.kind === "subagent" && i.status === "running") {
        return { ...i, status: "unknown" };
      }
      return i;
    });
    let subagents = s.subagents;
    if (subagents) {
      let changed = false;
      const nextSub = { ...subagents };
      for (const [k, v] of Object.entries(nextSub)) {
        if (v.status === "running") {
          nextSub[k] = { ...v, status: "unknown" };
          changed = true;
        }
      }
      if (changed) subagents = nextSub;
    }
    const output = str2(f.output);
    if (status === "completed" && output && output.trim()) {
      const lastWork = items.map((i) => i.kind !== "message" && i.kind !== "reasoning").lastIndexOf(true);
      const lastMsg = items.map((i) => i.kind).lastIndexOf("message");
      if (lastMsg > lastWork) {
        items = items.slice();
        items[lastMsg] = { ...items[lastMsg], text: output };
      } else {
        items = [...items, { kind: "message", id: `i${items.length}`, text: output }];
      }
    }
    const usage = f.usage && typeof f.usage === "object" ? f.usage : s.usage;
    return withItems(s, items, { ...patch, status, usage, subagents });
  }
  function reduce(state, frame) {
    const { event, data: f } = frame;
    if (event === "luvebot.stream.open") {
      const surface2 = f.surface === "run" || f.surface === "chat" ? f.surface : state.surface;
      return { ...state, surface: surface2, runId: str2(f.run_id) ?? state.runId, sessionId: str2(f.session_id) ?? state.sessionId, status: state.status === "idle" ? "running" : state.status };
    }
    if (event === "luvebot.stream.close") {
      const reason = str2(f.reason);
      const status = TERMINAL2.includes(state.status) ? state.status : reason === "completed" ? "completed" : reason === "cancelled" ? "cancelled" : state.status;
      return { ...state, status, closeReason: reason, done: true };
    }
    if (event === "luvebot.error") {
      const it = { kind: "error", id: `i${state.items.length}`, code: str2(f.code), message: str2(f.message) ?? "Erro no stream." };
      return withItems(state, [...state.items, it], { status: TERMINAL2.includes(state.status) ? state.status : "failed" });
    }
    if (!KNOWN.has(event)) return state;
    const surface = state.surface ?? (RUN_ONLY.has(event) ? "run" : CHAT_ONLY.has(event) ? "chat" : null);
    const seq2 = typeof f.seq === "number" ? f.seq : void 0;
    if (seq2 !== void 0 && seq2 <= state.lastSeq) return state;
    const live = state.status === "idle" || state.status === "waiting_approval" ? "running" : state.status;
    const patch = {
      surface,
      status: live,
      lastSeq: seq2 ?? state.lastSeq,
      runId: str2(f.run_id) ?? state.runId,
      sessionId: str2(f.session_id) ?? state.sessionId
    };
    const finished = TERMINAL2.includes(state.status);
    switch (event) {
      case "message.delta":
      case "assistant.delta":
        return finished ? state : appendText(state, "message", str2(f.delta) ?? "", patch);
      case "reasoning.available":
        return finished ? state : appendText(state, "reasoning", str2(f.text) ?? "", patch);
      case "tool.progress":
        return finished || f.tool_name !== "_thinking" ? { ...state, ...patch } : appendText(state, "reasoning", str2(f.delta) ?? "", patch);
      case "message.interim":
      case "assistant.commentary": {
        const text = str2(f.text);
        if (finished || !text || f.already_streamed === true) return { ...state, ...patch };
        return withItems(state, [...state.items, { kind: "commentary", id: `i${state.items.length}`, text }], patch);
      }
      case "tool.started":
        return finished ? state : startTool(state, f, patch);
      case "tool.completed":
      case "tool.failed":
        return finished ? state : finishTool(state, event, f, patch);
      case "approval.request":
        return finished ? state : withItems(state, [...state.items, { kind: "approval", id: `i${state.items.length}`, requestId: String(f.request_id ?? ""), frame: f }], { ...patch, status: "waiting_approval" });
      case "subagent.start":
        if (state.surface === "chat" || finished) return state;
        return startSubagent(state, f, patch);
      case "subagent.complete":
        if (state.surface === "chat" || finished) return state;
        return completeSubagent(state, f, patch);
      case "assistant.completed": {
        const content = str2(f.content);
        if (finished || content === void 0) return { ...state, ...patch };
        const idx = state.items.map((i) => i.kind).lastIndexOf("message");
        if (idx < 0) return withItems(state, [...state.items, { kind: "message", id: `i${state.items.length}`, text: content }], patch);
        const items = state.items.slice();
        items[idx] = { ...items[idx], text: content };
        return withItems(state, items, patch);
      }
      case "run.completed":
        return terminate(state, "completed", f, patch);
      case "run.cancelled":
        return terminate(state, "cancelled", f, patch);
      case "run.failed":
        return terminate(state, "failed", f, patch);
      case "done":
        return { ...state, ...patch, done: true };
      default:
        return { ...state, ...patch };
    }
  }

  // dashboard/src/components/chat/history.ts
  function latestConversation(sessions) {
    const mine = sessions.filter((s) => s.kind === "conversation" || s.kind === "introduction");
    const when = (s) => s.last_active ?? s.started_at ?? 0;
    return mine.reduce((best, s) => !best || when(s) > when(best) ? s : best, null);
  }
  function turnsFromHistory(messages, firstId = -1e6) {
    const turns = [];
    let id = firstId;
    const open = (user, aboutPage) => {
      const turn = { id: id++, user, state: initialTranscript(), stopping: false, errors: [], confirmed: "completed", ...aboutPage ? { aboutPage } : {} };
      turns.push(turn);
      return turn;
    };
    for (const m of messages) {
      if (m.display_kind === "hidden") continue;
      if (m.role === "tool" && m.tool_name === DELEGATE_TOOL && dispatchedId(m.text)) {
        const turn2 = turns[turns.length - 1] ?? open("");
        turn2.state = { ...turn2.state, items: [...turn2.state.items, {
          kind: "tool",
          id: `h${m.id}`,
          name: DELEGATE_TOOL,
          status: "done",
          preview: dispatchedGoal(m.text) ?? "",
          result: m.text
        }] };
        continue;
      }
      if (m.role === "tool") continue;
      if (m.display_kind === "async_delegation_complete") {
        const turn2 = turns[turns.length - 1] ?? open("");
        const v = deliveryView(m.text, m.display_metadata);
        const call = turn2.state.items.find((i) => i.kind === "tool" && i.name === DELEGATE_TOOL && v.id && dispatchedId(i.result) === v.id);
        turn2.state = { ...turn2.state, items: [...turn2.state.items, {
          kind: "subagent",
          id: `d${m.id}`,
          subagentId: v.id ?? String(m.id),
          goal: call && call.kind === "tool" ? call.preview ?? "" : "",
          status: v.status,
          summary: v.summary
        }] };
        continue;
      }
      if (m.role === "user") {
        open(m.text, m.page_ref?.slug);
        continue;
      }
      if (!m.text) continue;
      const turn = turns[turns.length - 1] ?? open("");
      const sep = turn.state.items.length ? "\n\n" : "";
      turn.state = reduce(turn.state, { event: "message.delta", data: { delta: sep + m.text } });
      if (m.display_kind === "failed_turn") turn.confirmed = "failed";
    }
    for (const turn of turns) {
      turn.state = reduce(turn.state, { event: turn.confirmed === "failed" ? "run.failed" : "run.completed", data: {} });
    }
    return turns;
  }

  // dashboard/src/components/chat/useConversation.ts
  function pageUpdateOf(frame) {
    const d = frame.data;
    if (!isSlug(d.slug) || typeof d.rev !== "number" || !Number.isInteger(d.rev)) return null;
    return { slug: d.slug, rev: d.rev, title: typeof d.title === "string" && d.title.trim() ? d.title.slice(0, 120) : d.slug };
  }
  var HERMES_TERMINAL = { "run.completed": "completed", "run.cancelled": "cancelled", "run.failed": "failed" };
  var GET_RUN_TERMINAL = { completed: "completed", cancelled: "cancelled", failed: "failed", interrupted: "interrupted" };
  var STATE_OF_END = { completed: "completed", failed: "failed", cancelled: "cancelled", interrupted: "cancelled" };
  var endOf = (run) => run.status_raw === "interrupted" ? "interrupted" : GET_RUN_TERMINAL[run.status];
  var msgOf = (e, t) => e instanceof ApiError ? humanError(e, t, "commErrorLuveBot") : e instanceof Error ? t("commErrorLuveBot") : t("unexpectedError");
  var isActive = (t) => !t.confirmed;
  function statusLabel(turn, tr) {
    if (turn.confirmed) {
      return {
        completed: tr("statusCompleted"),
        cancelled: tr("statusInterrupted"),
        failed: tr("statusFailed"),
        interrupted: tr("statusInterrupted")
      }[turn.confirmed];
    }
    if (turn.stopping) return tr("statusStopping");
    if (turn.resuming) return tr("statusResuming");
    if (turn.state.status === "waiting_approval") return tr("statusWaitingApproval");
    return tr("statusWorking");
  }
  function useConversation({ bot, surface = "run", fetcher, pollMs = 2e3, initialTurns, onPageUpdated }) {
    const { t } = useLuveI18n();
    const [turns, setTurns] = react_default.useState(initialTurns ?? []);
    const sessionId = react_default.useRef(null);
    const alive = react_default.useRef(true);
    const abort = react_default.useRef(null);
    const nextId = react_default.useRef(0);
    react_default.useEffect(() => {
      if (initialTurns) return;
      let cancelled = false;
      (async () => {
        try {
          const latest = latestConversation((await getBotSessions(bot, { limit: 20 })).sessions ?? []);
          if (!latest || cancelled) return;
          const past = turnsFromHistory((await getSessionMessages(bot, latest.id, { limit: 100 })).messages ?? []);
          const live = past.length ? await indexedRunOf(latest.id) : null;
          if (cancelled) return;
          if (!sessionId.current) sessionId.current = latest.id;
          const end = live && endOf(live);
          if (live) {
            const last2 = past[past.length - 1];
            const status = end ? STATE_OF_END[end] : live.status === "waiting_for_approval" ? "waiting_approval" : "running";
            past[past.length - 1] = { ...last2, confirmed: end || void 0, runId: live.id, state: { ...last2.state, status } };
          }
          if (past.length) setTurns((ts) => [...past, ...ts]);
          if (live && !end) void pollUntilTerminal(past[past.length - 1].id, live.id, new AbortController());
        } catch {
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [bot]);
    async function indexedRunOf(session2) {
      try {
        const items = (await getActivity({ tab: "running", bot, limit: 100 })).items ?? [];
        const runId = items.find((i) => i.kind === "run" && i.links?.session_id === session2)?.links?.run_id;
        return runId ? { ...(await getRun(bot, runId)).run, id: runId } : null;
      } catch {
        return null;
      }
    }
    react_default.useEffect(() => {
      alive.current = true;
      return () => {
        alive.current = false;
        abort.current?.abort();
      };
    }, []);
    const patch = react_default.useCallback((id, f) => {
      if (alive.current) setTurns((ts) => ts.map((item2) => item2.id === id ? f(item2) : item2));
    }, []);
    const onFrame = (id, local) => (frame) => {
      if (frame.event === "luvebot.page.updated") {
        const u = pageUpdateOf(frame);
        if (!u) return;
        patch(id, (turnItem) => ({ ...turnItem, pages: [...(turnItem.pages ?? []).filter((x) => x.slug !== u.slug), u] }));
        onPageUpdated?.(u);
        return;
      }
      local.confirmed = HERMES_TERMINAL[frame.event] ?? local.confirmed;
      local.runId = local.runId ?? (typeof frame.data.run_id === "string" ? frame.data.run_id : void 0);
      patch(id, (turnItem) => {
        const confirmed = HERMES_TERMINAL[frame.event] ?? turnItem.confirmed;
        const state = reduce(turnItem.state, frame);
        return { ...turnItem, state, confirmed, runId: turnItem.runId ?? state.runId, resuming: false };
      });
    };
    async function pollUntilTerminal(id, runId, ac) {
      while (alive.current && !ac.signal.aborted) {
        try {
          const { run } = await getRun(bot, runId);
          const done = endOf(run);
          if (!done) {
            const status = run.status === "waiting_for_approval" ? "waiting_approval" : "running";
            patch(id, (turnItem) => turnItem.confirmed || turnItem.state.status === status ? turnItem : { ...turnItem, resuming: false, state: { ...turnItem.state, status } });
          }
          if (done) {
            const final = done === "completed" && typeof run.output === "string" ? { event: "run.completed", data: { output: run.output } } : null;
            patch(id, (turnItem) => ({
              ...turnItem,
              confirmed: turnItem.confirmed ?? done,
              state: final && turnItem.state.status !== "completed" ? reduce({ ...turnItem.state, status: "running" }, final) : turnItem.state
            }));
            return;
          }
        } catch {
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
    async function send(raw, opts = {}) {
      const page = opts.page && isSlug(opts.page.slug) ? { slug: opts.page.slug } : void 0;
      const input = raw.trim();
      if (!input || turns.some(isActive)) return;
      const id = nextId.current++;
      const ac = new AbortController();
      abort.current = ac;
      const local = {};
      setTurns((ts) => [...ts, { id, user: input, state: initialTranscript(), stopping: false, errors: [], ...page ? { aboutPage: page.slug } : {} }]);
      const fail = (e) => patch(id, (turnItem) => ({ ...turnItem, errors: [...turnItem.errors, msgOf(e, t)] }));
      try {
        if (!sessionId.current) sessionId.current = (await createSession(bot)).session.id;
        if (surface === "run") {
          const runId = (await createRun(bot, { input, session_id: sessionId.current, idempotency_key: crypto.randomUUID?.(), ...page ? { page } : {} })).run.id;
          local.runId = runId;
          patch(id, (turnItem) => ({ ...turnItem, runId }));
          await openStream(runEventsUrl(bot, runId), onFrame(id, local), { fetcher, signal: ac.signal }).catch(fail);
        } else {
          const csrf = await getCsrf();
          await openStream(chatStreamUrl(bot, sessionId.current), onFrame(id, local), {
            method: "POST",
            body: JSON.stringify({ input, client_message_id: crypto.randomUUID?.(), ...page ? { page } : {} }),
            headers: { "Content-Type": "application/json", "X-LuveBot-CSRF": csrf },
            fetcher,
            signal: ac.signal
          }).catch(fail);
        }
      } catch (e) {
        fail(e);
      }
      if (!local.runId && !local.confirmed) {
        patch(id, (turnItem) => turnItem.runId ? turnItem : { ...turnItem, confirmed: "failed" });
        return;
      }
      if (local.runId && !local.confirmed) await pollUntilTerminal(id, local.runId, ac);
    }
    async function stop(turnItem) {
      if (!turnItem.runId) return;
      patch(turnItem.id, (x) => ({ ...x, stopping: true }));
      try {
        await stopRun(bot, turnItem.runId);
      } catch (e) {
        patch(turnItem.id, (x) => ({ ...x, stopping: false, errors: [...x.errors, msgOf(e, t)] }));
      }
    }
    const markResuming = (id) => patch(id, (turnItem) => turnItem.confirmed ? turnItem : { ...turnItem, resuming: true });
    const session = react_default.useCallback(() => sessionId.current, []);
    return { turns, active: turns.find(isActive), send, stop, markResuming, session };
  }

  // dashboard/src/components/pages/PageCard.tsx
  function PageCard({ title, botLabel, onOpen }) {
    const { t } = useLuveI18n();
    return /* @__PURE__ */ jsxs("div", { className: "lb-page-card", children: [
      /* @__PURE__ */ jsxs("span", { "aria-hidden": "true", className: "lb-page-glyph", children: [
        /* @__PURE__ */ jsx("i", {}),
        /* @__PURE__ */ jsx("i", {}),
        /* @__PURE__ */ jsx("i", {})
      ] }),
      /* @__PURE__ */ jsxs("span", { className: "lb-row-stack", children: [
        /* @__PURE__ */ jsx("span", { className: "lb-headline lb-truncate", children: title }),
        /* @__PURE__ */ jsx("span", { className: "lb-caption", children: t("pageCardMeta", { name: botLabel }) })
      ] }),
      onOpen && /* @__PURE__ */ jsx("button", { type: "button", onClick: onOpen, className: "lb-btn", "aria-label": t("pageOpenNamed", { title }), children: t("pageOpen") })
    ] });
  }

  // dashboard/src/components/pages/NewPageDialog.tsx
  function NewPageDialog({ open, bot, botLabel, initialTitle = "", content, onClose, onCreated }) {
    const { t } = useLuveI18n();
    const [title, setTitle] = react_default.useState(initialTitle);
    const [error, setError] = react_default.useState(null);
    const [busy, setBusy] = react_default.useState(false);
    react_default.useEffect(() => {
      if (open) {
        setTitle(initialTitle);
        setError(null);
      }
    }, [open, initialTitle]);
    async function create() {
      const name = title.trim();
      if (!name || busy) return;
      setBusy(true);
      setError(null);
      try {
        const { page } = await createPage(bot, content !== void 0 ? { title: name, content } : { title: name });
        onCreated(page);
      } catch (e) {
        const code2 = errCode(e);
        if (code2 === "page_exists") setError(t("pageExists", { slug: String(errDetails(e).slug ?? "") }));
        else if (code2 === "invalid_field") setError(t("pageTitleInvalid"));
        else if (code2 === "too_large") setError(t("pageTooLarge"));
        else if (code2 === "capability_missing") setError(t("pagesReadOnly"));
        else if (code2 === "pages_unavailable" || code2 === "not_found") setError(blockText(blockFromError(e), { name: bot, label: botLabel }, t));
        else setError(humanError(e, t, "unexpectedError"));
      } finally {
        setBusy(false);
      }
    }
    return /* @__PURE__ */ jsx(Dialog, { open, onClose, title: content !== void 0 ? t("pageSaveAsTitle") : t("pageNewTitle"), titleId: "page-new-title", children: /* @__PURE__ */ jsxs("div", { className: "lb-dialog-body", children: [
      /* @__PURE__ */ jsxs("label", { className: "lb-field", children: [
        /* @__PURE__ */ jsx("span", { className: "lb-label", children: t("pageTitleLabel") }),
        /* @__PURE__ */ jsx(
          "input",
          {
            className: "lb-input",
            value: title,
            maxLength: 120,
            autoFocus: true,
            onChange: (e) => setTitle(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              }
            }
          }
        )
      ] }),
      /* @__PURE__ */ jsx("p", { className: "lb-caption", style: { color: "var(--color-muted-foreground)", margin: 0 }, children: t("pageSaveIn", { name: botLabel }) }),
      error && /* @__PURE__ */ jsx("p", { role: "alert", className: "lb-alert", style: { margin: 0 }, children: /* @__PURE__ */ jsx(ErrorNote, { error }) }),
      /* @__PURE__ */ jsxs("div", { className: "lb-dialog-footer", children: [
        /* @__PURE__ */ jsx("button", { type: "button", onClick: onClose, className: "lb-btn", children: t("cancelBtn") }),
        /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void create(), disabled: !title.trim() || busy, className: "lb-btn lb-btn-primary", children: t("pageCreate") })
      ] })
    ] }) });
  }

  // dashboard/src/components/conversation/Attachments.tsx
  var IMAGE_MAX = 10 * 1024 * 1024;
  var DOC_MAX = 20 * 1024 * 1024;
  var MAX_FILES = 5;
  var IMAGE_EXT = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "gif", "webp"]);
  var DOC_EXT = /* @__PURE__ */ new Set(["pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "json"]);
  var IMAGE_MIME = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  var ACCEPT = [...IMAGE_EXT, ...DOC_EXT].map((e) => `.${e}`).join(",") + "," + [...IMAGE_MIME].join(",");
  function precheck(file) {
    const ext = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "";
    const image = IMAGE_EXT.has(ext) || !ext && IMAGE_MIME.has(file.type);
    if (!image && !DOC_EXT.has(ext)) return "type";
    return file.size > (image ? IMAGE_MAX : DOC_MAX) ? "size" : null;
  }
  function formatSize(bytes2) {
    return bytes2 >= 1024 * 1024 ? `${(bytes2 / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes2 / 1024))} KB`;
  }
  var WORKSPACE = {
    no_workspace: "attachWsNone",
    not_local: "attachWsNotLocal",
    inside_hermes: "attachWsInside",
    unsafe: "attachWsUnsafe"
  };
  function attachError(e, t) {
    if (e instanceof ApiError) {
      const reason = typeof e.details?.reason === "string" ? e.details.reason : "";
      if (e.code === "too_large") return { error: { text: t("attachErrTooLarge"), code: e.code }, canCreateWorkspace: false };
      if (e.code === "attachment_refused") return { error: { text: t(reason === "sensitive_name" ? "attachErrSensitive" : "attachErrType"), code: `${e.code}:${reason || "?"}` }, canCreateWorkspace: false };
      if (e.code === "workspace_unavailable") return { error: { text: t(WORKSPACE[reason] ?? "attachWsOther"), code: `${e.code}:${reason || "?"}` }, canCreateWorkspace: reason === "no_workspace" };
    }
    return { error: humanError(e, t, "attachErrGeneric"), canCreateWorkspace: false };
  }
  var seq = 0;
  function useAttachments(bot) {
    const { t } = useLuveI18n();
    const [items, setItems] = react_default.useState([]);
    const [error, setError] = react_default.useState(null);
    const [canCreate, setCanCreate] = react_default.useState(false);
    const [busy, setBusy] = react_default.useState(false);
    const [notice2, setNotice] = react_default.useState(null);
    const add = (files) => {
      const list = Array.from(files ?? []);
      if (!list.length) return;
      const next = [...items];
      let refusal = null;
      for (const file of list) {
        const why = precheck(file);
        if (why) {
          refusal = t(why === "type" ? "attachTypeRefused" : "attachTooLarge", { name: file.name });
          continue;
        }
        if (next.length >= MAX_FILES) {
          refusal = t("attachTooMany", { n: MAX_FILES });
          break;
        }
        next.push({ id: `a${++seq}`, file });
      }
      setItems(next);
      setError(refusal);
      setCanCreate(false);
      setNotice(null);
    };
    const remove = (id) => {
      setItems((cur) => cur.filter((x) => x.id !== id));
      setError(null);
      setCanCreate(false);
      setNotice(null);
    };
    const clear = () => {
      setItems([]);
      setError(null);
      setCanCreate(false);
      setNotice(null);
    };
    const upload = async () => {
      setBusy(true);
      setError(null);
      setCanCreate(false);
      setNotice(null);
      try {
        const refs = [];
        for (const item2 of items) {
          if (item2.reference) {
            refs.push(item2.reference);
            continue;
          }
          try {
            const { attachment } = await uploadAttachment(bot, item2.file);
            refs.push(attachment.reference);
            setItems((cur) => cur.map((x) => x.id === item2.id ? { ...x, reference: attachment.reference } : x));
          } catch (e) {
            const why = attachError(e, t);
            setError(why.error);
            setCanCreate(why.canCreateWorkspace);
            return null;
          }
        }
        return refs;
      } finally {
        setBusy(false);
      }
    };
    const createWorkspace = async () => {
      setBusy(true);
      try {
        const { workspace } = await setBotWorkspace(bot);
        if (workspace.state === "ready" || workspace.state === "empty") {
          setCanCreate(false);
          setError(null);
          setNotice(t("attachWsCreated"));
        } else {
          setCanCreate(false);
          setError({ text: t(WORKSPACE[workspace.state] ?? "attachWsOther"), code: `workspace:${workspace.state}` });
        }
      } catch (e) {
        setCanCreate(false);
        setError(humanError(e, t, "attachWsCreateFailed"));
      } finally {
        setBusy(false);
      }
    };
    return { items, error, notice: notice2, canCreate, busy, add, remove, clear, upload, createWorkspace };
  }
  function AttachmentTray({ a }) {
    const { t } = useLuveI18n();
    if (!a.items.length && !a.error && !a.notice) return null;
    return /* @__PURE__ */ jsxs("div", { style: { margin: "0 16px 6px", display: "flex", flexDirection: "column", gap: 6 }, children: [
      a.items.length > 0 && /* @__PURE__ */ jsx("ul", { "aria-label": t("attachListLabel"), style: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 6 }, children: a.items.map((x) => /* @__PURE__ */ jsxs("li", { className: "lb-pill", style: { fontSize: 13, padding: "4px 6px 4px 12px", maxWidth: "100%" }, children: [
        /* @__PURE__ */ jsx("span", { className: "lb-truncate", style: { maxWidth: 220 }, children: x.file.name }),
        /* @__PURE__ */ jsx("span", { className: "lb-caption", style: { whiteSpace: "nowrap" }, children: formatSize(x.file.size) }),
        /* @__PURE__ */ jsx("button", { type: "button", onClick: () => a.remove(x.id), disabled: a.busy, "aria-label": t("attachRemove", { name: x.file.name }), className: "lb-icon-btn", style: { width: 28, height: 28 }, children: /* @__PURE__ */ jsx(XIcon, { size: 14 }) })
      ] }, x.id)) }),
      a.items.length > 0 && /* @__PURE__ */ jsx("p", { className: "lb-caption", style: { margin: 0 }, children: t("attachNotice") }),
      a.notice && /* @__PURE__ */ jsx("p", { role: "status", className: "lb-caption", style: { margin: 0 }, children: a.notice }),
      a.error && /* @__PURE__ */ jsxs("div", { role: "alert", className: "lb-caption", style: { color: "var(--color-destructive)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ jsx("span", { children: /* @__PURE__ */ jsx(ErrorNote, { error: a.error }) }),
        a.canCreate && /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn", disabled: a.busy, onClick: () => void a.createWorkspace(), children: t("attachWsCreate") })
      ] })
    ] });
  }
  var REF = /^\[Anexo: attachments\/([^,\]\n]+), ([^,\]\n]+), ([^,\]\n]+)\]$/;
  var FORMAT = {
    "application/pdf": "PDF",
    "image/png": "PNG",
    "image/jpeg": "JPG",
    "image/gif": "GIF",
    "image/webp": "WebP",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
    "text/plain": "TXT",
    "text/markdown": "Markdown",
    "text/csv": "CSV",
    "application/json": "JSON"
  };
  function splitReferences(text) {
    const refs = [];
    const rest = [];
    for (const line of text.split("\n")) {
      const m = line.trim().match(REF);
      if (m) refs.push({ name: m[1].replace(/^[0-9a-f]{32}-/, ""), type: FORMAT[m[2]] ?? m[2], size: m[3] });
      else rest.push(line);
    }
    return { text: rest.join("\n").trim(), refs };
  }
  function nameParts(name) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot - 1 >= 1 && name.length - dot - 1 <= 8 ? name.slice(dot) : "";
    const stem = ext ? name.slice(0, dot) : name;
    const keep = Math.min(3, Math.max(0, stem.length - 1));
    return { head: stem.slice(0, stem.length - keep), tail: stem.slice(stem.length - keep) + ext };
  }
  function SentAttachments({ refs, spaced }) {
    const { t } = useLuveI18n();
    return /* @__PURE__ */ jsx("ul", { "aria-label": t("attachSentLabel"), style: { listStyle: "none", margin: spaced ? "8px 0 0" : 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 6 }, children: refs.map((r, i) => /* @__PURE__ */ jsxs(
      "li",
      {
        "aria-label": t("attachSentItem", { name: r.name, type: r.type, size: r.size }),
        title: r.name,
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          maxWidth: "min(100%, 420px)",
          minWidth: 0,
          padding: "6px 10px",
          borderRadius: 12,
          background: "color-mix(in srgb, currentColor 14%, transparent)",
          whiteSpace: "nowrap"
        },
        children: [
          /* @__PURE__ */ jsxs("span", { "aria-hidden": "true", className: "lb-page-glyph", style: { width: 18, height: 22, padding: 3, gap: 2, borderRadius: 4 }, children: [
            /* @__PURE__ */ jsx("i", {}),
            /* @__PURE__ */ jsx("i", {}),
            /* @__PURE__ */ jsx("i", {})
          ] }),
          /* @__PURE__ */ jsxs("span", { "data-testid": "sent-name", style: { display: "inline-flex", minWidth: 0, fontWeight: 600 }, children: [
            /* @__PURE__ */ jsx("span", { className: "lb-truncate", style: { minWidth: 0 }, children: nameParts(r.name).head }),
            /* @__PURE__ */ jsx("span", { style: { flexShrink: 0 }, children: nameParts(r.name).tail })
          ] }),
          /* @__PURE__ */ jsxs("span", { style: { opacity: 0.8, fontSize: 13, flexShrink: 0 }, children: [
            r.type,
            " \xB7 ",
            r.size
          ] })
        ]
      },
      i
    )) });
  }

  // dashboard/src/components/conversation/Conversation.tsx
  var PANEL_KEY = "luvebot.workpanel";
  function blocks(items, card2 = () => false) {
    const out = [];
    for (const item2 of items) {
      const last2 = out[out.length - 1];
      if (item2.kind === "tool" && card2(item2)) out.push({ kind: "item", item: item2 });
      else if (item2.kind === "tool" && last2?.kind === "steps") last2.tools.push(item2);
      else out.push(item2.kind === "tool" ? { kind: "steps", id: item2.id, tools: [item2] } : { kind: "item", item: item2 });
    }
    return out;
  }
  var turnFiles = (turn) => [...new Set(turn.state.items.flatMap((i) => i.kind === "message" ? citedFiles(i.text) : []))];
  var quiet = { margin: "4px 0", color: "var(--color-muted-foreground)", fontSize: 12 };
  function Thought({ text, t }) {
    return /* @__PURE__ */ jsxs("details", { style: quiet, children: [
      /* @__PURE__ */ jsx("summary", { style: { cursor: "pointer" }, children: t("thought") }),
      /* @__PURE__ */ jsx(Markdown, { text })
    ] });
  }
  function SystemLine({ children, live = false }) {
    return /* @__PURE__ */ jsx("div", { ...live ? { role: "status", "aria-live": "polite" } : {}, className: "lb-caption", style: { textAlign: "center", margin: "6px 0 16px" }, children });
  }
  function Conversation({ bot, surface = "run", fetcher, pollMs = 2e3, initialTurns, onActivityChange, onCloseSidePanel, onOpenProfile, panel: sidePanel, onOpenPage, onOpenPages, onPageUpdated, askAbout, onClearAsk }) {
    const { t } = useLuveI18n();
    const { turns, active, send: start, stop, markResuming, session } = useConversation({ bot: bot.name, surface, fetcher, pollMs, initialTurns, onPageUpdated });
    const [deliveries, setDeliveries] = react_default.useState(() => /* @__PURE__ */ new Map());
    const [late, setLate] = react_default.useState(() => /* @__PURE__ */ new Set());
    const pendingHelpers = turns.flatMap((x) => backgroundIds(x.state.items, deliveries)).filter((id) => !late.has(id));
    const waitKey = pendingHelpers.join(",");
    react_default.useEffect(() => {
      if (!waitKey) return;
      let alive = true, tries = 0;
      const id = window.setInterval(async () => {
        if (++tries > DELIVERY_TRIES) {
          window.clearInterval(id);
          if (alive) setLate((prev) => /* @__PURE__ */ new Set([...prev, ...waitKey.split(",")]));
          return;
        }
        const sid = session();
        if (!sid) return;
        try {
          const found = deliveriesOf((await getSessionMessages(bot.name, sid, { limit: 50 })).messages ?? []);
          if (alive && found.size) setDeliveries((prev) => new Map([...prev, ...found]));
        } catch {
        }
      }, DELIVERY_MS);
      return () => {
        alive = false;
        window.clearInterval(id);
      };
    }, [waitKey, bot.name, session]);
    const [draft, setDraft] = react_default.useState("");
    const [saveAs, setSaveAs] = react_default.useState(null);
    const files = useFileDownloads(bot.name);
    const name = bot.label ?? bot.name;
    const waiting = !!active && !active.stopping && !active.resuming && active.state.status === "waiting_approval";
    const att = useAttachments(bot.name);
    const fileInput = react_default.useRef(null);
    const [dragging, setDragging] = react_default.useState(false);
    const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    async function send() {
      if (!draft.trim() && !att.items.length || active || att.busy) return;
      let input = draft;
      if (att.items.length) {
        const refs = await att.upload();
        if (!refs) return;
        input = [draft.trim(), ...refs].filter(Boolean).join("\n");
        att.clear();
      }
      setDraft("");
      void start(input, askAbout ? { page: { slug: askAbout.slug } } : {});
      onClearAsk?.();
    }
    const activity = active ? active.runId ? active.runId + (waiting ? ":waiting" : "") : null : "idle";
    const seenActivity = react_default.useRef(activity);
    react_default.useEffect(() => {
      if (activity === seenActivity.current) return;
      seenActivity.current = activity;
      if (activity !== null) onActivityChange?.();
    }, [activity]);
    const narrow = useNarrow();
    const phone = usePhoneBar();
    const [drawer, setDrawer] = react_default.useState(false);
    const [panelOpen, setPanelOpenState] = react_default.useState(() => {
      try {
        return window.localStorage.getItem(PANEL_KEY) !== "closed";
      } catch {
        return true;
      }
    });
    const setPanelOpen = (open) => {
      setPanelOpenState(open);
      try {
        if (open) window.localStorage.removeItem(PANEL_KEY);
        else window.localStorage.setItem(PANEL_KEY, "closed");
      } catch {
      }
    };
    const [focus, setFocus] = react_default.useState(null);
    const drawerRef = useFocusTrap({ isOpen: narrow && drawer, onClose: () => setDrawer(false) });
    const scrollRef = react_default.useRef(null);
    react_default.useEffect(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [turns]);
    const renderItem = (item2, turn) => {
      switch (item2.kind) {
        case "message":
          return turn.confirmed === "completed" ? /* @__PURE__ */ jsx(MessageMenu, { items: [
            { label: t("pageSaveAsMenu"), hint: t("pageSaveAsHint"), onSelect: () => setSaveAs(item2.text) },
            ...citedFiles(item2.text).map((p) => ({ label: t("fileDownloadNamed", { file: p.split("/").pop() ?? p }), hint: t("fileDownloadHint"), onSelect: () => void files.download(`${turn.id}|${p}`, p) }))
          ], children: /* @__PURE__ */ jsx(MessageCard, { text: item2.text, color: bot.color }) }, item2.id) : /* @__PURE__ */ jsx(MessageCard, { text: item2.text, color: bot.color }, item2.id);
        case "reasoning":
          return /* @__PURE__ */ jsx(Thought, { text: item2.text, t }, item2.id);
        case "commentary":
          return /* @__PURE__ */ jsx("div", { style: quiet, children: /* @__PURE__ */ jsx(CommentaryCard, { text: item2.text }) }, item2.id);
        // a helper the Bot delegated to (subagent.start/complete): its goal, state and summary as Hermes reported them
        case "subagent": {
          const fill = fillFromDelegate(item2, turn.state.items, deliveries, late);
          return /* @__PURE__ */ jsx(SubagentCard, { goal: item2.goal, status: fill?.status ?? item2.status, summary: fill?.summary ?? item2.summary, costUsd: item2.costUsd }, item2.id);
        }
        case "tool": {
          const d = delegateView(item2, deliveries, late);
          return /* @__PURE__ */ jsx(SubagentCard, { goal: d.goal, status: d.status, summary: d.summary }, item2.id);
        }
        case "approval":
          return /* @__PURE__ */ jsx(InlineApproval, { frame: item2.frame, bot: bot.name, runId: turn.runId, pending: !turn.confirmed && turn.state.status === "waiting_approval", onDecided: () => markResuming(turn.id) }, item2.id);
        case "error":
          return /* @__PURE__ */ jsx(ErrorCard, { message: humanCode(item2.code, t, "streamErrorGeneric") }, item2.id);
        // our frame: code + English text
        default:
          return null;
      }
    };
    const workTurns = turns.map((x) => ({ id: x.id, label: x.user ? t("activityTurnLabel", { text: x.user }) : t("activityTurnIntro"), items: x.state.items }));
    const delivered = turns.filter((x) => x.confirmed === "completed").flatMap((x) => turnFiles(x).map((p) => {
      const key = `${x.id}|${p}`;
      return { key, path: p, state: files.state[key], onDownload: () => void files.download(key, p) };
    }));
    const panel = /* @__PURE__ */ jsx(WorkPanel, { items: turns.flatMap((item2) => item2.state.items), turns: workTurns, focus, bot: { name: bot.name, label: name }, delivered, onOpenPage });
    const activityCount = workTurns.reduce((n, x) => n + deriveActivity({ items: x.items }).length, 0);
    const seen = react_default.useRef(activityCount);
    if (panelOpen && !narrow) seen.current = activityCount;
    const newActivity = !narrow && !panelOpen && activityCount > seen.current;
    const openActivity = (turnId) => {
      if (narrow) setDrawer(true);
      else {
        setPanelOpen(true);
        if (sidePanel) onCloseSidePanel?.();
      }
      setFocus((f) => ({ turnId, n: (f?.n ?? 0) + 1 }));
    };
    return /* @__PURE__ */ jsxs("div", { style: { display: "flex", height: "100%", minHeight: 0 }, children: [
      /* @__PURE__ */ jsxs(
        "section",
        {
          "aria-label": `${t("conversationWith")} ${name}`,
          style: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 },
          onDragOver: (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            setDragging(true);
          },
          onDragLeave: (e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
          },
          onDrop: (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            setDragging(false);
            att.add(e.dataTransfer.files);
          },
          children: [
            /* @__PURE__ */ jsx("div", { role: "status", "aria-live": "polite", className: "lb:sr-only", children: active ? `${name}: ${statusLabel(active, t)}` : name }),
            /* @__PURE__ */ jsxs("header", { style: { display: "flex", alignItems: "center", gap: phone ? 8 : 12, padding: phone ? "10px 8px" : "10px 16px", minHeight: 64, borderBottom: "1px solid var(--lb-separator)" }, children: [
              phone?.back,
              /* @__PURE__ */ jsx(Avatar, { name, avatar: bot.avatar, color: bot.color, size: 40, attention: waiting ? "needs_you" : active ? "working" : void 0 }),
              /* @__PURE__ */ jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [
                /* @__PURE__ */ jsx("div", { className: "lb-headline lb-truncate", children: name }),
                /* @__PURE__ */ jsx("div", { "aria-hidden": "true", className: "lb-caption", style: { display: "flex", alignItems: "center", gap: 6, overflow: "hidden", whiteSpace: "nowrap" }, children: waiting ? /* @__PURE__ */ jsxs(Fragment2, { children: [
                  /* @__PURE__ */ jsx(AttentionBadge, { state: "needs_you" }),
                  t("statusNeedsYouLabel")
                ] }) : active ? /* @__PURE__ */ jsxs(Fragment2, { children: [
                  /* @__PURE__ */ jsx(AttentionBadge, { state: "working" }),
                  t("statusTyping")
                ] }) : bot.role })
              ] }),
              narrow && // short visible label so the Bot's status fits on a phone; the accessible name still starts with it
              /* @__PURE__ */ jsx("button", { type: "button", "aria-expanded": drawer, "aria-label": drawer ? t("closePanelBtn") : t("workPanelBtn"), onClick: () => setDrawer(!drawer), className: "lb-btn", children: drawer ? t("closePanelBtn") : t("workPanelShort") }),
              !narrow && /* @__PURE__ */ jsxs(
                "button",
                {
                  type: "button",
                  className: "lb-icon-btn lb-panel-toggle",
                  "aria-expanded": panelOpen,
                  "aria-controls": "lb-work-panel",
                  "aria-label": (panelOpen ? t("workPanelHide") : t("workPanelShow")) + (newActivity ? ` (${t("workPanelNew")})` : ""),
                  title: panelOpen ? t("workPanelHide") : t("workPanelShow"),
                  onClick: () => setPanelOpen(!panelOpen),
                  children: [
                    /* @__PURE__ */ jsx(PanelRightIcon, { size: 18 }),
                    newActivity && /* @__PURE__ */ jsx("span", { className: "lb-panel-dot", "aria-hidden": "true" })
                  ]
                }
              ),
              onOpenPages && !narrow && /* @__PURE__ */ jsx("button", { type: "button", onClick: onOpenPages, className: "lb-btn", children: t("pagesTitle") }),
              onOpenProfile && /* @__PURE__ */ jsx("button", { type: "button", onClick: onOpenProfile, className: "lb-btn", children: t("btnProfile") }),
              phone?.hermes
            ] }),
            /* @__PURE__ */ jsxs("div", { ref: scrollRef, style: { flex: 1, overflowY: "auto", padding: "16px 20px" }, children: [
              turns.length === 0 && /* @__PURE__ */ jsxs("div", { "data-testid": "conversation-empty-state", style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100%", textAlign: "center", gap: 6 }, children: [
                /* @__PURE__ */ jsx(Avatar, { name, avatar: bot.avatar, color: bot.color, size: 72 }),
                /* @__PURE__ */ jsx("h3", { className: "lb-title", style: { marginTop: 10 }, children: t("conversationEmptyTitle", { name }) }),
                /* @__PURE__ */ jsx("p", { className: "lb-subhead", style: { maxWidth: 380 }, children: t("conversationEmptyDesc") }),
                /* @__PURE__ */ jsx("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 10, maxWidth: 460 }, children: ["conversationPromptSuggestion1", "conversationPromptSuggestion2"].map((k) => /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setDraft(t(k)), className: "lb-btn", children: t(k) }, k)) })
              ] }),
              turns.map((turn) => /* @__PURE__ */ jsxs("div", { "data-turn": turn.id, children: [
                turn.user && (() => {
                  const sent = splitReferences(turn.user);
                  return /* @__PURE__ */ jsxs(Bubble, { side: "me", color: bot.color, meta: turn.aboutPage ? t("pageAboutSent", { slug: turn.aboutPage }) : void 0, children: [
                    sent.text,
                    sent.refs.length > 0 && /* @__PURE__ */ jsx(SentAttachments, { refs: sent.refs, spaced: !!sent.text })
                  ] });
                })(),
                (() => {
                  const viaHermes = turn.state.items.some((i) => i.kind === "subagent");
                  const card2 = (x) => !viaHermes && x.name === DELEGATE_TOOL;
                  const all = turn.state.items.filter((i) => i.kind === "tool" && !card2(i));
                  let shown = false;
                  return blocks(turn.state.items, card2).map((b) => {
                    if (b.kind !== "steps") return renderItem(b.item, turn);
                    if (shown) return null;
                    shown = true;
                    return /* @__PURE__ */ jsx(StepsLine, { tools: all, onOpenActivity: () => openActivity(turn.id) }, b.id);
                  });
                })(),
                turn.confirmed === "completed" && turnFiles(turn).map((p) => /* @__PURE__ */ jsx(
                  FileCard,
                  {
                    path: p,
                    botLabel: name,
                    state: files.state[`${turn.id}|${p}`],
                    onDownload: () => void files.download(`${turn.id}|${p}`, p),
                    bot: bot.name,
                    onOpenPage
                  },
                  `f${p}`
                )),
                (turn.pages ?? []).map((p) => /* @__PURE__ */ jsx(PageCard, { title: p.title, botLabel: name, onOpen: onOpenPage ? () => onOpenPage(p.slug) : void 0 }, p.slug)),
                turn.errors.map((m, i) => /* @__PURE__ */ jsx(ErrorCard, { message: m }, `e${i}`)),
                /* @__PURE__ */ jsx(SystemLine, { live: true, children: statusLabel(turn, t) })
              ] }, turn.id))
            ] }),
            askAbout && /* @__PURE__ */ jsx("div", { style: { margin: "0 16px 6px" }, children: /* @__PURE__ */ jsxs("span", { className: "lb-pill", style: { fontSize: 13, padding: "4px 6px 4px 12px" }, children: [
              t("pageAboutChip", { title: askAbout.title }),
              /* @__PURE__ */ jsx("button", { type: "button", onClick: onClearAsk, "aria-label": t("pageAboutRemove"), className: "lb-icon-btn", style: { width: 24, height: 24 }, children: /* @__PURE__ */ jsx(XIcon, { size: 14 }) })
            ] }) }),
            /* @__PURE__ */ jsx(AttachmentTray, { a: att }),
            /* @__PURE__ */ jsxs(
              "form",
              {
                onSubmit: (e) => {
                  e.preventDefault();
                  void send();
                },
                style: {
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 8,
                  margin: "0 16px 16px",
                  padding: "6px 6px 6px 6px",
                  borderRadius: 24,
                  background: "var(--lb-fill)",
                  ...dragging ? { outline: "2px dashed var(--color-primary)", outlineOffset: 2 } : {}
                },
                children: [
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      ref: fileInput,
                      type: "file",
                      multiple: true,
                      accept: ACCEPT,
                      hidden: true,
                      tabIndex: -1,
                      onChange: (e) => {
                        att.add(e.currentTarget.files);
                        e.currentTarget.value = "";
                      }
                    }
                  ),
                  /* @__PURE__ */ jsx(
                    "button",
                    {
                      type: "button",
                      className: "lb-icon-btn",
                      "aria-label": t("attachBtn"),
                      title: t("attachBtn"),
                      disabled: att.busy,
                      onClick: () => fileInput.current?.click(),
                      style: { width: 40, height: 40, flexShrink: 0 },
                      children: /* @__PURE__ */ jsx(PaperclipIcon, { size: 18 })
                    }
                  ),
                  /* @__PURE__ */ jsx(
                    "textarea",
                    {
                      "aria-label": t("messageLabel"),
                      placeholder: dragging ? t("attachDrop") : t("composerPlaceholder", { name }),
                      value: draft,
                      rows: 1,
                      onChange: (e) => setDraft(e.target.value),
                      onPaste: (e) => {
                        const files2 = e.clipboardData?.files;
                        if (!files2?.length) return;
                        if (!e.clipboardData.getData("text/plain")) e.preventDefault();
                        att.add(files2);
                      },
                      onKeyDown: (e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void send();
                        }
                      },
                      className: "lb-body",
                      style: { flex: 1, minHeight: 40, maxHeight: 160, padding: "10px 0", border: "none", outline: "none", resize: "none", background: "transparent", fieldSizing: "content" }
                    }
                  ),
                  active ? /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void stop(active), disabled: !active.runId, className: "lb-btn lb-btn-destructive", style: { minHeight: 40 }, children: t("stopBtn") }) : /* @__PURE__ */ jsx("button", { type: "submit", disabled: !draft.trim() && !att.items.length || att.busy, className: "lb-btn lb-btn-primary", style: { minHeight: 40 }, children: att.busy ? t("attachUploading") : t("sendBtn") })
                ]
              }
            )
          ]
        }
      ),
      /* @__PURE__ */ jsx(
        NewPageDialog,
        {
          open: saveAs !== null,
          bot: bot.name,
          botLabel: name,
          initialTitle: saveAs ? titleFrom(saveAs) : "",
          content: saveAs ?? void 0,
          onClose: () => setSaveAs(null),
          onCreated: (page) => {
            setSaveAs(null);
            onOpenPage?.(page.slug);
          }
        }
      ),
      sidePanel,
      !sidePanel && !narrow && panelOpen && /* @__PURE__ */ jsx("aside", { id: "lb-work-panel", style: { width: 320, flexShrink: 0, borderLeft: "1px solid var(--lb-separator)", minHeight: 0 }, children: panel }),
      narrow && drawer && // a phone has no side panel: the work panel is a screen of its own, with its own way out
      /* @__PURE__ */ jsxs("aside", { ref: drawerRef, role: "dialog", "aria-modal": "true", "aria-label": t("workPanelBtn"), style: { position: "fixed", inset: 0, zIndex: 50, display: "flex", flexDirection: "column", background: "var(--color-card)" }, children: [
        /* @__PURE__ */ jsx("div", { style: { display: "flex", justifyContent: "flex-end", padding: "8px 8px 0" }, children: /* @__PURE__ */ jsxs("button", { type: "button", className: "lb-btn", onClick: () => setDrawer(false), children: [
          "\u2039 ",
          t("backToConversation")
        ] }) }),
        /* @__PURE__ */ jsx("div", { style: { flex: 1, minHeight: 0 }, children: panel })
      ] })
    ] });
  }

  // dashboard/src/components/agent/ApprovalSurfaceCard.tsx
  var ID = /^\d{1,20}$/;
  var PENDING_EVERY_MS = 2e3;
  var PENDING_TRIES = 15;
  var NEEDS = { channel: "0.3.0", luvebot: "0.2.0" };
  var REASON2 = {
    GATEWAY_ALLOW_ALL_USERS: "surfaceReasonGatewayAll",
    TELEGRAM_ALLOW_ALL_USERS: "surfaceReasonTelegramAll",
    TELEGRAM_ALLOWED_USERS: "surfaceReasonTelegramStar",
    GATEWAY_ALLOWED_USERS: "surfaceReasonGatewayStar",
    allow_all_users: "surfaceReasonConfigAll",
    allow_from: "surfaceReasonConfigStar",
    unreadable: "surfaceReasonUnreadable"
  };
  function olderVersion(have, latest) {
    const parts = (v) => v.split(".").map((x) => Number(x));
    if (!have || !latest) return false;
    const [a, b] = [parts(have), parts(latest)];
    if ([...a, ...b].some((n) => !Number.isInteger(n) || n < 0)) return false;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return d < 0;
    }
    return false;
  }
  function parseApprovers(text) {
    const ids = text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (ids.some((x) => !ID.test(x))) return { ids, error: "format" };
    if (ids.length > 20) return { ids, error: "many" };
    if (new Set(ids).size !== ids.length) return { ids, error: "repeat" };
    return { ids, error: null };
  }
  function ApprovalSurfaceCard({ bot }) {
    const { t } = useLuveI18n();
    const [surface, setSurface] = react_default.useState(null);
    const [mode, setMode] = react_default.useState("luvebot");
    const [ids, setIds] = react_default.useState("");
    const [rules, setRules] = react_default.useState(null);
    const [busy, setBusy] = react_default.useState(false);
    const [error, setError] = react_default.useState(null);
    const [saved, setSaved] = react_default.useState(false);
    const errRef = react_default.useRef(null);
    const tries = react_default.useRef(0);
    const [retry, setRetry] = react_default.useState(0);
    const [hookBusy, setHookBusy] = react_default.useState(false);
    const [hookResult, setHookResult] = react_default.useState(null);
    const [hookError, setHookError] = react_default.useState(null);
    const reasonText2 = (r) => r && REASON2[r] ? t(REASON2[r]) : t("surfaceReasonUnreadable");
    const errorText = (e) => {
      if (!(e instanceof ApiError)) return t("surfaceErrNetwork");
      if (e.code === "approval_surface_unsafe") return t("surfaceErrUnsafe", { reason: reasonText2(e.details?.reason) });
      if (e.code === "loopback_not_human") return t("surfaceErrLoopback");
      if (e.code === "invalid_field") return t("surfaceErrInvalid");
      if (e.code === "csrf_required") return t("surfaceErrCsrf");
      return humanError(e, t, "surfaceErrGeneric");
    };
    const load = react_default.useCallback(async () => {
      try {
        const { approval_surface: s } = await getApprovalSurface(bot);
        setSurface(s);
        setMode(s.mode);
        setIds(s.approvers.map((a) => a.replace(/^telegram:/, "")).join(", "));
      } catch (e) {
        setError(errorText(e));
      }
      try {
        const r = await getRules(void 0, bot);
        setRules((r?.rules ?? []).filter(({ rule }) => rule.level === "ask" && rule.state === "active"));
      } catch {
        setRules([]);
      }
    }, [bot]);
    react_default.useEffect(() => {
      void load();
    }, [load]);
    react_default.useEffect(() => {
      if (error) errRef.current?.focus();
    }, [error]);
    react_default.useEffect(() => {
      if (surface?.applied_reason !== "pending" || tries.current >= PENDING_TRIES) return;
      const id = window.setTimeout(async () => {
        tries.current += 1;
        try {
          setSurface((await getApprovalSurface(bot)).approval_surface);
        } catch {
        }
        setRetry((n) => n + 1);
      }, PENDING_EVERY_MS);
      return () => window.clearTimeout(id);
    }, [surface?.applied_reason, bot, retry]);
    const parsed = parseApprovers(ids);
    const localError = mode === "channel" ? parsed.error ?? (parsed.ids.length === 0 ? "empty" : null) : null;
    const current = surface ? `${surface.mode}|${surface.approvers.join(",")}` : "";
    const next = `${mode}|${parsed.error ? ids : parsed.ids.map((x) => `telegram:${x}`).join(",")}`;
    const changed = !!surface && current !== next;
    async function updateHook() {
      setHookBusy(true);
      setHookError(null);
      setHookResult(null);
      try {
        const r = await installBotHook(bot);
        setHookResult(r.restart_required ? "hookUpdateRestart" : r.changed ? "hookUpdated" : "hookAlreadyCurrent");
        void load();
      } catch (e) {
        setHookError(e instanceof ApiError && e.code === "hook_install_failed" ? t("hookUpdateFailed") : humanError(e, t, "hookUpdateFailed"));
      } finally {
        setHookBusy(false);
      }
    }
    async function save() {
      setBusy(true);
      setError(null);
      setSaved(false);
      tries.current = 0;
      setRetry((n) => n + 1);
      try {
        const approvers = parsed.error ? void 0 : parsed.ids.map((x) => `telegram:${x}`);
        const { approval_surface: s } = await putApprovalSurface(bot, { mode, ...approvers && (mode === "channel" || approvers.length) ? { approvers } : {} });
        setSurface(s);
        setMode(s.mode);
        setSaved(true);
        void load();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    }
    const option = (value, title, desc) => /* @__PURE__ */ jsxs("label", { className: "lb-row lb-row-flat", style: { alignItems: "flex-start", gap: 12, cursor: "pointer" }, children: [
      /* @__PURE__ */ jsx("input", { type: "radio", name: `surface-${bot}`, value, checked: mode === value, onChange: () => {
        setMode(value);
        setSaved(false);
      }, style: { marginTop: 4 } }),
      /* @__PURE__ */ jsxs("span", { className: "lb-row-stack", children: [
        /* @__PURE__ */ jsx("span", { className: "lb-body", style: { fontWeight: 600 }, children: t(title) }),
        /* @__PURE__ */ jsx("span", { className: "lb-subhead", children: desc })
      ] })
    ] });
    return /* @__PURE__ */ jsxs("section", { "aria-labelledby": `surface-title-${bot}`, children: [
      /* @__PURE__ */ jsx("h3", { id: `surface-title-${bot}`, className: "lb-headline", style: { margin: "24px 4px 4px" }, children: t("surfaceTitle") }),
      /* @__PURE__ */ jsx("p", { className: "lb-subhead", style: { margin: "0 4px 8px" }, children: t("surfaceIntro") }),
      !surface && !error && /* @__PURE__ */ jsx("p", { className: "lb-subhead", style: { margin: "0 4px" }, children: t("agentLoading") }),
      surface && /* @__PURE__ */ jsxs("div", { className: "lb-group", children: [
        /* @__PURE__ */ jsxs("div", { role: "radiogroup", "aria-labelledby": `surface-title-${bot}`, children: [
          option("luvebot", "surfaceLuvebot", t("surfaceLuvebotDesc")),
          option("channel", "surfaceChannel", t("surfaceChannelDesc", { platforms: (surface.platforms.length ? surface.platforms : ["telegram"]).map((p) => p[0].toUpperCase() + p.slice(1)).join(", ") }))
        ] }),
        mode === "channel" && /* @__PURE__ */ jsxs("div", { style: { padding: "4px 16px 14px" }, children: [
          /* @__PURE__ */ jsx("label", { htmlFor: `surface-ids-${bot}`, className: "lb-label", children: t("surfaceApproversLabel") }),
          /* @__PURE__ */ jsx(
            "input",
            {
              id: `surface-ids-${bot}`,
              className: "lb-input",
              inputMode: "numeric",
              value: ids,
              placeholder: t("surfaceIdsPlaceholder"),
              "aria-describedby": `surface-ids-help-${bot}`,
              "aria-invalid": !!localError || void 0,
              onChange: (e) => {
                setIds(e.target.value);
                setSaved(false);
              }
            }
          ),
          /* @__PURE__ */ jsxs("p", { id: `surface-ids-help-${bot}`, className: "lb-caption", style: { margin: "6px 0 0" }, children: [
            t("surfaceApproversHelp"),
            " ",
            /* @__PURE__ */ jsx("a", { href: "https://t.me/userinfobot", target: "_blank", rel: "noopener noreferrer", children: t("surfaceUserInfoBot") }),
            " ",
            t("surfaceApproversHelpAfter")
          ] }),
          localError && /* @__PURE__ */ jsx("p", { className: "lb-caption", style: { margin: "6px 0 0", color: "var(--color-destructive)" }, children: t(localError === "empty" ? "surfaceIdsEmpty" : localError === "many" ? "surfaceIdsMany" : localError === "repeat" ? "surfaceIdsRepeat" : "surfaceIdsFormat") })
        ] }),
        surface.mode === "channel" && surface.allow_all && /* @__PURE__ */ jsx("p", { role: "status", className: "lb-caption", style: { margin: 0, padding: "0 16px 12px", color: "var(--color-warning)" }, children: t("surfaceAllowAll", { reason: reasonText2(surface.allow_all_reason) }) }),
        (surface.applied_reason === "hook_outdated" || olderVersion(surface.hook_version, surface.hook_latest_version)) && /* @__PURE__ */ jsx("div", { style: { padding: "0 16px 12px" }, children: /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn", disabled: hookBusy, onClick: () => void updateHook(), children: hookBusy ? t("hookUpdating") : t("hookUpdateBtn") }) }),
        hookResult && /* @__PURE__ */ jsx("p", { role: "status", className: "lb-caption", style: { margin: 0, padding: "0 16px 12px", color: hookResult === "hookUpdateRestart" ? "var(--color-warning)" : void 0 }, children: t(hookResult) }),
        hookError && /* @__PURE__ */ jsx("p", { role: "alert", className: "lb-caption", style: { margin: 0, padding: "0 16px 12px", color: "var(--color-destructive)" }, children: /* @__PURE__ */ jsx(ErrorNote, { error: hookError }) }),
        !surface.applied && (() => {
          const why = surface.applied_reason;
          const pending = why === "pending";
          const text = pending ? t(tries.current >= PENDING_TRIES ? "surfacePendingSlow" : "surfacePending") : why === "hook_outdated" ? t("surfaceHookOutdated", { version: surface.hook_version ?? t("surfaceNoHook"), needed: NEEDS[surface.mode] ?? NEEDS.channel }) : why === "hook_not_live" ? t("surfaceHookNotLive") : t("surfaceNotAppliedUnknown");
          return /* @__PURE__ */ jsx("p", { role: "status", className: "lb-caption", style: { margin: 0, padding: "0 16px 12px", color: pending ? "var(--color-muted-foreground)" : "var(--color-warning)" }, children: text });
        })()
      ] }),
      surface && /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 8 }, children: [
        /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn lb-btn-primary", disabled: busy || !changed || !!localError, onClick: () => void save(), children: busy ? t("saving") : t("saveChanges") }),
        saved && /* @__PURE__ */ jsx("span", { role: "status", className: "lb-caption", children: t("surfaceSaved") })
      ] }),
      error && /* @__PURE__ */ jsx("p", { ref: errRef, tabIndex: -1, role: "alert", className: "lb-caption", style: { margin: "8px 4px 0", color: "var(--color-destructive)" }, children: /* @__PURE__ */ jsx(ErrorNote, { error }) }),
      rules && rules.length > 0 && /* @__PURE__ */ jsxs("div", { style: { marginTop: 12 }, children: [
        /* @__PURE__ */ jsx("p", { className: "lb-caption", style: { margin: "0 4px 6px" }, children: t("surfaceSealsLabel") }),
        /* @__PURE__ */ jsx("ul", { className: "lb-group", style: { listStyle: "none", margin: 0, padding: 0 }, children: rules.slice(0, 4).map(({ rule, seal_result }) => /* @__PURE__ */ jsxs("li", { className: "lb-row lb-row-flat", style: { justifyContent: "space-between", gap: 8 }, children: [
          /* @__PURE__ */ jsxs("span", { className: "lb-row-stack", style: { minWidth: 0 }, children: [
            /* @__PURE__ */ jsx("span", { className: "lb-body lb-truncate", children: rule.label }),
            /* @__PURE__ */ jsx(SealCaveat, { sealResult: seal_result })
          ] }),
          /* @__PURE__ */ jsx(SealBadge, { sealResult: seal_result })
        ] }, rule.id)) })
      ] })
    ] });
  }

  // dashboard/src/components/pages/WorkspaceOffer.tsx
  function WorkspaceOffer({ bot, label, isDefault, onReady }) {
    const { t } = useLuveI18n();
    const [busy, setBusy] = react_default.useState(false);
    const [error, setError] = react_default.useState(null);
    async function create() {
      setBusy(true);
      setError(null);
      try {
        const { workspace } = await setBotWorkspace(bot);
        const still = blockOf(workspace.state);
        if (still) setError(blockText(still, { name: bot, label, isDefault }, t));
        else onReady();
      } catch (e) {
        setError(humanError(e, t, "attachWsCreateFailed"));
      } finally {
        setBusy(false);
      }
    }
    return /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }, children: [
      /* @__PURE__ */ jsx("p", { className: "lb-subhead", style: { margin: 0 }, children: t("pagesNoFolder", { name: label || bot }) }),
      /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void create(), disabled: busy, className: "lb-btn lb-btn-primary", children: busy ? t("pagesCreatingFolder") : t("attachWsCreate") }),
      error && /* @__PURE__ */ jsx("p", { role: "alert", className: "lb-caption", style: { margin: 0, color: "var(--color-destructive)" }, children: /* @__PURE__ */ jsx(ErrorNote, { error }) })
    ] });
  }

  // dashboard/src/components/pages/PagesSection.tsx
  function PagesSection({ bot, label, isDefault, onOpen, onOpenAll }) {
    const { t } = useLuveI18n();
    const [load, setLoad] = react_default.useState({ kind: "loading" });
    const [nonce, setNonce] = react_default.useState(0);
    react_default.useEffect(() => {
      let alive = true;
      listPages(bot).then(
        (r) => {
          if (!alive) return;
          const b = blockOf(r.workspace?.state);
          setLoad(b ? { kind: "blocked", block: b } : { kind: "ready", pages: r.pages });
        },
        (e) => alive && setLoad({ kind: "blocked", block: blockFromError(e) })
      );
      return () => {
        alive = false;
      };
    }, [bot, nonce]);
    return /* @__PURE__ */ jsxs("section", { "aria-labelledby": "agent-pages-title", children: [
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", margin: "24px 4px 8px" }, children: [
        /* @__PURE__ */ jsx("h3", { id: "agent-pages-title", className: "lb-headline", style: { margin: 0 }, children: t("pagesTitle") }),
        load.kind === "ready" && load.pages.length > 0 && /* @__PURE__ */ jsx("button", { type: "button", onClick: onOpenAll, className: "lb-btn lb-btn-plain", children: t("pagesSeeAll", { count: load.pages.length }) })
      ] }),
      load.kind === "loading" ? /* @__PURE__ */ jsx("p", { className: "lb-group lb-subhead", style: { padding: "14px 16px" }, children: t("pageLoading") }) : load.kind === "blocked" && load.block === "no_workspace" ? /* @__PURE__ */ jsx("div", { className: "lb-group", style: { padding: "14px 16px" }, children: /* @__PURE__ */ jsx(WorkspaceOffer, { bot, label, isDefault, onReady: () => setNonce((n) => n + 1) }) }) : load.kind === "blocked" ? /* @__PURE__ */ jsx("p", { className: "lb-group lb-subhead", style: { padding: "14px 16px" }, children: blockText(load.block, { name: bot, label, isDefault }, t) }) : load.pages.length === 0 ? /* @__PURE__ */ jsxs("div", { className: "lb-group", style: { padding: "14px 16px", display: "flex", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ jsx("span", { className: "lb-subhead", style: { flex: 1 }, children: t("pagesEmpty") }),
        /* @__PURE__ */ jsx("button", { type: "button", onClick: onOpenAll, className: "lb-btn lb-btn-plain", children: t("pagesOpenLibrary") })
      ] }) : /* @__PURE__ */ jsx("ul", { className: "lb-group", style: { listStyle: "none", margin: 0, padding: 0 }, children: load.pages.slice(0, 3).map((p) => /* @__PURE__ */ jsx("li", { className: "lb-row lb-row-flat", style: { padding: 0 }, children: /* @__PURE__ */ jsxs("button", { type: "button", onClick: () => onOpen(p.slug), className: "lb-contact", style: { borderRadius: 0, padding: "8px 16px", minHeight: 52 }, children: [
        /* @__PURE__ */ jsxs("span", { className: "lb-row-stack", children: [
          /* @__PURE__ */ jsxs("span", { className: "lb-body lb-truncate", style: { display: "flex", alignItems: "center", gap: 8 }, children: [
            changedSinceSeen(bot, p.slug, p.sha) && /* @__PURE__ */ jsx("span", { role: "img", "aria-label": t("pageChangedMark"), style: { width: 8, height: 8, borderRadius: 4, background: "var(--color-primary)", flexShrink: 0 } }),
            p.title
          ] }),
          /* @__PURE__ */ jsx("span", { className: "lb-caption", children: p.author_label })
        ] }),
        /* @__PURE__ */ jsx("span", { "aria-hidden": "true", style: { color: "var(--color-muted-foreground)", display: "inline-flex" }, children: /* @__PURE__ */ jsx(ChevronRightIcon, { size: 16 }) })
      ] }) }, p.slug)) })
    ] });
  }

  // dashboard/src/components/agent/AgentPanel.tsx
  function useLoad(fn, deps) {
    const { t } = useLuveI18n();
    const [load, setLoad] = react_default.useState({ state: "loading" });
    const [nonce, setNonce] = react_default.useState(0);
    react_default.useEffect(() => {
      let alive = true;
      setLoad({ state: "loading" });
      fn().then((data) => alive && setLoad({ state: "ready", data }), (e) => alive && setLoad({ state: "error", message: humanError(e, t, "unexpectedError") }));
      return () => {
        alive = false;
      };
    }, [...deps, nonce]);
    return [load, () => setNonce((n) => n + 1)];
  }
  var PAUSE_ERRORS = {
    paused_all: "agentErrPausedAll",
    budget_held: "agentErrBudgetHeld",
    not_ours: "agentErrNotOurs",
    loopback_not_human: "agentErrLoopback"
  };
  var STATE_LABEL = {
    needs_you: "statusNeedsYouLabel",
    error: "statusErrorLabel",
    offline: "statusOfflineLabel",
    paused: "statusPausedLabel",
    working: "statusWorkingLabel",
    unread: "statusUnreadLabel"
  };
  var PAUSED_REASON = {
    user: "agentPausedUser",
    budget: "agentPausedBudget",
    estop: "agentPausedEstop",
    all: "agentPausedAll"
  };
  var sectionTitle = { margin: "24px 4px 8px" };
  function Empty2({ children }) {
    return /* @__PURE__ */ jsx("p", { className: "lb-group lb-subhead", style: { padding: "14px 16px" }, children });
  }
  function Rows({ load, empty, render }) {
    const { t } = useLuveI18n();
    if (load.state === "loading") return /* @__PURE__ */ jsx(Empty2, { children: t("agentLoading") });
    if (load.state === "error") return /* @__PURE__ */ jsx("p", { role: "alert", className: "lb-group lb-subhead", style: { padding: "14px 16px", color: "var(--color-destructive)" }, children: /* @__PURE__ */ jsx(ErrorNote, { error: load.message }) });
    if (!load.data.length) return /* @__PURE__ */ jsx(Empty2, { children: empty });
    return /* @__PURE__ */ jsx("ul", { className: "lb-group", style: { listStyle: "none", margin: 0, padding: 0 }, children: load.data.map((x, i) => /* @__PURE__ */ jsx("li", { className: "lb-row lb-row-flat", children: render(x, i) }, i)) });
  }
  function AgentPanel({ bot, pendingApprovals = 0, onOpenPage, onChanged, onOpenPageSlug }) {
    const { t, locale } = useLuveI18n();
    const name = bot.display?.label || bot.name;
    const [tab, setTab] = react_default.useState("running");
    const [running, reloadRunning] = useLoad(() => getActivity({ tab: "running", bot: bot.name }).then((r) => r.items ?? []), [bot.name]);
    const [done] = useLoad(() => getActivity({ tab: "done", bot: bot.name }).then((r) => r.items ?? []), [bot.name]);
    const [routines] = useLoad(() => getRoutines({ bot: bot.name }).then((r) => r.routines ?? []), [bot.name]);
    const [budget] = useLoad(() => getBudget().then((b) => b.limits.filter((l) => l.scope === "bot" && l.ref === bot.name)), [bot.name]);
    const [confirmStop, setConfirmStop] = react_default.useState(null);
    const [stopping, setStopping] = react_default.useState(/* @__PURE__ */ new Set());
    const [pausing, setPausing] = react_default.useState(false);
    const [stopActive, setStopActive] = react_default.useState(false);
    const [busy, setBusy] = react_default.useState(false);
    const [error, setError] = react_default.useState(null);
    const state = attention(bot, pendingApprovals);
    const paused = bot.status === "paused";
    const reason = paused ? PAUSED_REASON[bot.status_reason ?? ""] : void 0;
    async function act(fn) {
      setBusy(true);
      setError(null);
      try {
        await fn();
        setPausing(false);
        onChanged?.();
      } catch (e) {
        setError(e instanceof ApiError && PAUSE_ERRORS[e.code] ? t(PAUSE_ERRORS[e.code]) : humanError(e, t, "unexpectedError"));
      } finally {
        setBusy(false);
      }
    }
    async function stop(id) {
      setConfirmStop(null);
      setError(null);
      setStopping((s) => new Set(s).add(id));
      try {
        await stopActivity(id, {});
        reloadRunning();
      } catch (e) {
        setStopping((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
        setError(humanError(e, t, "unexpectedError"));
      }
    }
    const tabs = [["running", "tabRunning"], ["scheduled", "tabScheduled"], ["done", "tabDone"]];
    const when = (iso) => iso ? new Date(typeof iso === "number" ? iso * 1e3 : iso).toLocaleString(locale === "pt" ? "pt-BR" : "en-US", { dateStyle: "short", timeStyle: "short" }) : null;
    return /* @__PURE__ */ jsxs("div", { style: { fontFamily: "var(--lb-font)" }, children: [
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", paddingTop: 8 }, children: [
        /* @__PURE__ */ jsx(Avatar, { name, avatar: bot.display?.avatar, color: bot.display?.color, size: 80 }),
        /* @__PURE__ */ jsx("h2", { className: "lb-title", style: { marginTop: 12 }, children: name }),
        bot.display?.role && /* @__PURE__ */ jsx("div", { className: "lb-subhead", children: bot.display.role }),
        /* @__PURE__ */ jsxs("div", { className: "lb-caption", style: { display: "flex", alignItems: "center", gap: 6, marginTop: 8 }, children: [
          /* @__PURE__ */ jsx(AttentionBadge, { state }),
          reason ? t(reason) : state !== "idle" ? t(STATE_LABEL[state]) : null
        ] }),
        bot.display?.call_me && /* @__PURE__ */ jsx("div", { className: "lb-caption", style: { marginTop: 4 }, children: t("agentCallsYou", { name: bot.display.call_me }) }),
        bot.model?.name && /* @__PURE__ */ jsx("div", { className: "lb-pill", style: { marginTop: 10 }, children: t("agentModel", { model: bot.model.name }) })
      ] }),
      /* @__PURE__ */ jsx("div", { role: "tablist", "aria-label": t("agentActivityTabs"), className: "lb-segmented", style: { marginTop: 24 }, children: tabs.map(([k, label]) => /* @__PURE__ */ jsx("button", { type: "button", role: "tab", "aria-selected": tab === k, onClick: () => setTab(k), className: "lb-segment", children: t(label) }, k)) }),
      /* @__PURE__ */ jsxs("div", { role: "tabpanel", style: { marginTop: 12 }, children: [
        tab === "running" && /* @__PURE__ */ jsx(Rows, { load: running, empty: t("agentEmptyRunning"), render: (it) => /* @__PURE__ */ jsxs(Fragment2, { children: [
          /* @__PURE__ */ jsx("span", { className: "lb-body lb-clamp-2", style: { flex: 1, minWidth: 0 }, children: activityTitle(it, t) }),
          stopping.has(it.id) ? /* @__PURE__ */ jsx("span", { className: "lb-caption", children: t("statusStopping") }) : confirmStop === it.id ? /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void stop(it.id), className: "lb-btn lb-btn-destructive", children: t("agentConfirmStop") }) : /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setConfirmStop(it.id), className: "lb-btn lb-btn-destructive", children: t("stopBtn") })
        ] }) }),
        tab === "scheduled" && /* @__PURE__ */ jsx(Rows, { load: routines, empty: t("agentEmptyScheduled"), render: (r) => /* @__PURE__ */ jsxs("span", { className: "lb-row-stack", children: [
          /* @__PURE__ */ jsx("span", { className: "lb-body lb-truncate", children: r.name }),
          /* @__PURE__ */ jsxs("span", { className: "lb-caption", children: [
            /* @__PURE__ */ jsx("span", { className: "lb-mono", children: r.schedule.expr }),
            " \xB7 ",
            r.state === "paused" || !r.enabled ? t("statusPausedLabel") : when(r.next_run_at) ? t("nextRunLabel", { time: when(r.next_run_at) }) : null
          ] })
        ] }) }),
        tab === "done" && /* @__PURE__ */ jsx(Rows, { load: done, empty: t("agentEmptyDone"), render: (it) => /* @__PURE__ */ jsxs("span", { className: "lb-row-stack", children: [
          /* @__PURE__ */ jsx("span", { className: "lb-body lb-clamp-2", children: activityTitle(it, t) }),
          /* @__PURE__ */ jsx("span", { className: "lb-caption", children: [when(it.ended_at), it.cost_cents != null ? formatCents(it.cost_cents, locale) : null].filter(Boolean).join(" \xB7 ") })
        ] }) })
      ] }),
      /* @__PURE__ */ jsx("h3", { className: "lb-headline", style: sectionTitle, children: t("agentBudgetTitle") }),
      /* @__PURE__ */ jsx(Rows, { load: budget, empty: t("agentBudgetNone"), render: (l) => /* @__PURE__ */ jsxs("span", { style: { flex: 1 }, children: [
        /* @__PURE__ */ jsx("span", { className: "lb-body", style: { display: "block", fontVariantNumeric: "tabular-nums" }, children: t("agentBudgetLine", { period: t(l.period === "day" ? "agentPeriodDay" : "agentPeriodMonth"), spent: formatCents(l.spent_cents, locale), cap: formatCents(l.cents, locale) }) }),
        /* @__PURE__ */ jsx(
          "span",
          {
            role: "progressbar",
            "aria-label": t("agentBudgetTitle"),
            "aria-valuenow": Math.min(100, Math.round(l.percent)),
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            style: { display: "block", height: 6, marginTop: 8, borderRadius: 3, background: "var(--lb-fill-2)" },
            children: /* @__PURE__ */ jsx("span", { style: { display: "block", height: "100%", borderRadius: 3, width: `${Math.min(100, l.percent)}%`, background: l.percent >= 100 ? "var(--color-destructive)" : l.percent >= 80 ? "var(--color-warning)" : "var(--color-success)" } })
          }
        )
      ] }) }),
      /* @__PURE__ */ jsx("button", { type: "button", onClick: () => onOpenPage("costs"), className: "lb-btn lb-btn-plain", style: { marginTop: 6 }, children: t("agentManageCosts") }),
      /* @__PURE__ */ jsx(PagesSection, { bot: bot.name, label: bot.display?.label, isDefault: bot.is_default, onOpen: (slug) => onOpenPageSlug ? onOpenPageSlug(slug) : onOpenPage("pages"), onOpenAll: () => onOpenPage("pages") }),
      /* @__PURE__ */ jsx(ApprovalSurfaceCard, { bot: bot.name }),
      /* @__PURE__ */ jsx("h3", { className: "lb-headline", style: sectionTitle, children: t("agentCustomize") }),
      /* @__PURE__ */ jsx("ul", { className: "lb-group", style: { listStyle: "none", margin: 0, padding: 0 }, children: [["profile", "agentIdentity"], ["rules", "agentRules"], ["routines", "agentRoutines"]].map(([page, label]) => /* @__PURE__ */ jsx("li", { className: "lb-row lb-row-flat", style: { padding: 0 }, children: /* @__PURE__ */ jsxs("button", { type: "button", onClick: () => onOpenPage(page), className: "lb-contact", style: { borderRadius: 0, padding: "0 16px", minHeight: 52 }, children: [
        /* @__PURE__ */ jsx("span", { className: "lb-body", style: { flex: 1 }, children: t(label) }),
        /* @__PURE__ */ jsx("span", { "aria-hidden": "true", style: { color: "var(--color-muted-foreground)", display: "inline-flex" }, children: /* @__PURE__ */ jsx(ChevronRightIcon, { size: 16 }) })
      ] }) }, page)) }),
      /* @__PURE__ */ jsxs("div", { style: { marginTop: 20 }, children: [
        paused && bot.status_reason === "user" && /* @__PURE__ */ jsx("button", { type: "button", disabled: busy, onClick: () => void act(() => resumeBot(bot.name)), className: "lb-btn lb-btn-primary", children: t("agentResume") }),
        !paused && bot.status !== "offline" && !pausing && /* @__PURE__ */ jsx("button", { type: "button", onClick: () => {
          setStopActive(false);
          setPausing(true);
        }, className: "lb-btn lb-btn-destructive", children: t("agentPause") }),
        !paused && pausing && /* @__PURE__ */ jsxs("div", { className: "lb-group", style: { padding: 16 }, children: [
          /* @__PURE__ */ jsx("p", { className: "lb-body", style: { margin: 0 }, children: t("agentPauseExplain") }),
          bot.is_default && /* @__PURE__ */ jsx("p", { className: "lb-subhead", style: { marginTop: 6 }, children: t("agentPauseDefaultScope") }),
          /* @__PURE__ */ jsxs("label", { className: "lb-body", style: { display: "flex", alignItems: "center", gap: 10, marginTop: 10, minHeight: 44 }, children: [
            /* @__PURE__ */ jsx("input", { type: "checkbox", checked: stopActive, onChange: (e) => setStopActive(e.target.checked) }),
            t("agentPauseStopActive")
          ] }),
          /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 8, marginTop: 8 }, children: [
            /* @__PURE__ */ jsx("button", { type: "button", disabled: busy, onClick: () => void act(() => pauseBot(bot.name, { stop_active: stopActive })), className: "lb-btn lb-btn-destructive", children: t("agentPauseConfirm") }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setPausing(false), className: "lb-btn", children: t("cancelBtn") })
          ] })
        ] }),
        error && /* @__PURE__ */ jsx("p", { role: "alert", className: "lb-subhead", style: { color: "var(--color-destructive)", marginTop: 8 }, children: /* @__PURE__ */ jsx(ErrorNote, { error }) })
      ] })
    ] });
  }

  // dashboard/src/components/ui/SidePanel.tsx
  function SidePanel({ open, onClose, label, children }) {
    const { t } = useLuveI18n();
    const narrow = useNarrow();
    const sheetRef = useFocusTrap({ isOpen: open && narrow, onClose });
    if (!open) return null;
    const close = /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        onClick: onClose,
        "aria-label": t("closePanelBtn"),
        className: "lb-icon-btn",
        style: { position: "absolute", top: 12, right: 12, background: "var(--lb-fill)", color: "var(--color-foreground)" },
        children: /* @__PURE__ */ jsx(XIcon, { size: 18 })
      }
    );
    const body = /* @__PURE__ */ jsx("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px 24px" }, children });
    if (narrow) {
      return /* @__PURE__ */ jsxs(Fragment2, { children: [
        /* @__PURE__ */ jsx("div", { "aria-hidden": "true", onClick: onClose, style: { position: "fixed", inset: 0, zIndex: 49, background: "rgba(0,0,0,0.32)" } }),
        /* @__PURE__ */ jsxs(
          "aside",
          {
            ref: sheetRef,
            role: "dialog",
            "aria-modal": "true",
            "aria-label": label,
            className: "lb-sheet",
            style: { position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 50, maxHeight: "88vh", display: "flex", flexDirection: "column", background: "var(--color-card)", color: "var(--color-card-foreground)", borderTopLeftRadius: 24, borderTopRightRadius: 24, boxShadow: "0 -8px 32px rgba(0,0,0,0.18)" },
            children: [
              /* @__PURE__ */ jsx("div", { "aria-hidden": "true", style: { width: 36, height: 5, borderRadius: 3, background: "var(--lb-fill-2)", margin: "8px auto 0" } }),
              close,
              body
            ]
          }
        )
      ] });
    }
    return /* @__PURE__ */ jsxs(
      "aside",
      {
        "aria-label": label,
        onKeyDown: (e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        },
        style: { position: "relative", width: 380, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--color-card)", color: "var(--color-card-foreground)", borderLeft: "1px solid var(--lb-separator)" },
        children: [
          close,
          body
        ]
      }
    );
  }

  // dashboard/src/components/approvals/ApprovalsInbox.tsx
  function ApprovalsInbox({
    bots = [],
    authMode: controlledAuthMode,
    initialApprovals,
    onApprovalsChanged
  }) {
    const { t } = useLuveI18n();
    const ruleLabel = useRuleLabels();
    const labelOf = (name) => bots.find((b) => b.name === name)?.display?.label || name;
    const [approvals, setApprovals] = useState(initialApprovals || []);
    const [loading2, setLoading] = useState(!initialApprovals);
    const [error, setError] = useState(null);
    const [authMode, setAuthMode] = useState(
      controlledAuthMode || "gated"
    );
    const [selectedIds, setSelectedIds] = useState(/* @__PURE__ */ new Set());
    const [botFilter, setBotFilter] = useState("all");
    const [statusFilter, setStatusFilter] = useState("pending");
    const [alwaysModalItem, setAlwaysModalItem] = useState(null);
    const [alwaysDraftLabel, setAlwaysDraftLabel] = useState("");
    const [denyModalItem, setDenyModalItem] = useState(null);
    const [denyReason, setDenyReason] = useState("");
    const [editModalItem, setEditModalItem] = useState(null);
    const [batchConfirmMode, setBatchConfirmMode] = useState(null);
    const [batchDenyReason, setBatchDenyReason] = useState("");
    const alwaysModalRef = useFocusTrap({
      isOpen: Boolean(alwaysModalItem),
      onClose: () => setAlwaysModalItem(null)
    });
    const denyModalRef = useFocusTrap({
      isOpen: Boolean(denyModalItem),
      onClose: () => setDenyModalItem(null)
    });
    const editModalRef = useFocusTrap({
      isOpen: Boolean(editModalItem),
      onClose: () => setEditModalItem(null)
    });
    const batchModalRef = useFocusTrap({
      isOpen: Boolean(batchConfirmMode),
      onClose: () => setBatchConfirmMode(null)
    });
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [actionSuccessMsg, setActionSuccessMsg] = useState(null);
    const mounted = useRef(true);
    useEffect(() => () => {
      mounted.current = false;
    }, []);
    const sayDenied = (head, first, ids) => {
      const show = (s) => {
        setActionSuccessMsg(`${head} ${t(reasonText(s))}`);
        if (s !== "sending") setTimeout(() => {
          if (mounted.current) setActionSuccessMsg(null);
        }, 4e3);
      };
      show(first);
      if (first === "sending") void followReasons(ids, show, () => mounted.current);
    };
    const isLoopback = authMode === "loopback";
    useEffect(() => {
      if (!controlledAuthMode) {
        getSession().then((s) => {
          if (s?.auth_mode) {
            setAuthMode(s.auth_mode);
          }
        }).catch(() => {
        });
      } else {
        setAuthMode(controlledAuthMode);
      }
    }, [controlledAuthMode]);
    const loadApprovalsList = useCallback(async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await getApprovals();
        const list = res?.approvals || [];
        setApprovals(list);
        const pendingCount2 = list.filter((a) => a.status === "pending").length;
        onApprovalsChanged?.(pendingCount2);
      } catch (err) {
        setError(humanError(err, t, "errorLoadingApprovals"));
      } finally {
        setLoading(false);
      }
    }, [onApprovalsChanged, t]);
    useEffect(() => {
      if (!initialApprovals) {
        loadApprovalsList();
      }
    }, [initialApprovals, loadApprovalsList]);
    const updateApprovalsState = useCallback(
      (updater) => {
        setApprovals((prev) => {
          const next = updater(prev);
          const pendingCount2 = next.filter((a) => a.status === "pending").length;
          onApprovalsChanged?.(pendingCount2);
          return next;
        });
      },
      [onApprovalsChanged]
    );
    const displayedApprovals = useMemo(() => {
      return approvals.filter((a) => {
        if (statusFilter === "pending" && a.status !== "pending") return false;
        if (botFilter !== "all" && a.bot !== botFilter) return false;
        return true;
      });
    }, [approvals, statusFilter, botFilter]);
    const pendingCount = useMemo(() => {
      return approvals.filter((a) => a.status === "pending").length;
    }, [approvals]);
    const selectedItems = useMemo(() => {
      return approvals.filter((a) => selectedIds.has(a.request_id));
    }, [approvals, selectedIds]);
    const hasMismatchedActionClass = useMemo(() => mixedActionClass(selectedItems), [selectedItems]);
    const toggleSelect = (requestId) => {
      if (isLoopback) return;
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(requestId)) {
          next.delete(requestId);
        } else {
          next.add(requestId);
        }
        return next;
      });
    };
    const selectAllVisible = () => {
      if (isLoopback) return;
      const pendingVisible = displayedApprovals.filter((a) => a.status === "pending");
      if (selectedIds.size === pendingVisible.length && pendingVisible.length > 0) {
        setSelectedIds(/* @__PURE__ */ new Set());
      } else {
        setSelectedIds(new Set(pendingVisible.map((a) => a.request_id)));
      }
    };
    const handleResolveOnce = async (item2) => {
      if (isLoopback || isSubmitting) return;
      try {
        setIsSubmitting(true);
        setError(null);
        await resolveApproval(item2.request_id, onceRequest(item2));
        updateApprovalsState(
          (prev) => prev.map(
            (a) => a.request_id === item2.request_id ? { ...a, status: "decided", decided_choice: "once" } : a
          )
        );
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(item2.request_id);
          return next;
        });
        setActionSuccessMsg(t("actionAllowedOnce", { bot: labelOf(item2.bot) }));
        setTimeout(() => setActionSuccessMsg(null), 4e3);
      } catch (err) {
        handleApiError(err);
      } finally {
        setIsSubmitting(false);
      }
    };
    const openAlwaysModal = (item2) => {
      if (isLoopback) return;
      const defaultLabel = `${t("allowOnceBtn")} ${item2.pattern_keys?.[0] || item2.command_redacted || item2.description || t("defaultActionLabel")} ${item2.bot}`;
      setAlwaysDraftLabel(defaultLabel);
      setAlwaysModalItem(item2);
    };
    const handleConfirmAlways = async () => {
      if (!alwaysModalItem || isLoopback || isSubmitting) return;
      try {
        setIsSubmitting(true);
        setError(null);
        const label = alwaysDraftLabel.trim() || t("rulesTitleBot", { bot: labelOf(alwaysModalItem.bot) });
        await resolveApproval(alwaysModalItem.request_id, alwaysRequest(alwaysModalItem, label));
        updateApprovalsState(
          (prev) => prev.map(
            (a) => a.request_id === alwaysModalItem.request_id ? { ...a, status: "decided", decided_choice: "once" } : a
          )
        );
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(alwaysModalItem.request_id);
          return next;
        });
        setAlwaysModalItem(null);
        setActionSuccessMsg(t("actionAlwaysResolved", { bot: labelOf(alwaysModalItem.bot) }));
        setTimeout(() => setActionSuccessMsg(null), 4e3);
      } catch (err) {
        handleApiError(err);
      } finally {
        setIsSubmitting(false);
      }
    };
    const openDenyModal = (item2) => {
      if (isLoopback) return;
      setDenyReason("");
      setDenyModalItem(item2);
    };
    const handleConfirmDeny = async () => {
      if (!denyModalItem || isLoopback || isSubmitting) return;
      const denyBody = denyRequest(denyModalItem, denyReason);
      if (!denyBody) {
        setError(t("denyReasonRequired"));
        return;
      }
      try {
        setIsSubmitting(true);
        setError(null);
        const res = await resolveApproval(denyModalItem.request_id, denyBody);
        updateApprovalsState(
          (prev) => prev.map(
            (a) => a.request_id === denyModalItem.request_id ? { ...a, status: "decided", decided_choice: "deny" } : a
          )
        );
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(denyModalItem.request_id);
          return next;
        });
        setDenyModalItem(null);
        setDenyReason("");
        sayDenied(t("actionDenied", { bot: labelOf(denyModalItem.bot) }), reasonState(res?.reason_delivered), [denyModalItem.request_id]);
      } catch (err) {
        handleApiError(err);
      } finally {
        setIsSubmitting(false);
      }
    };
    const handleConfirmBatch = async () => {
      if (selectedItems.length === 0 || isLoopback || isSubmitting || !batchConfirmMode) return;
      if (hasMismatchedActionClass) {
        setError(t("batchMismatchRefused"));
        return;
      }
      if (batchConfirmMode === "deny" && !batchDenyReason.trim()) {
        setError(t("batchDenyReasonRequired"));
        return;
      }
      const itemsPayload = batchItems(selectedItems, batchConfirmMode, batchDenyReason);
      if (!itemsPayload) return;
      try {
        setIsSubmitting(true);
        setError(null);
        const batch = await batchResolveApprovals({ items: itemsPayload });
        const resolvedIds = new Set(selectedItems.map((i) => i.request_id));
        updateApprovalsState(
          (prev) => prev.map(
            (a) => resolvedIds.has(a.request_id) ? { ...a, status: "decided", decided_choice: batchConfirmMode } : a
          )
        );
        setSelectedIds(/* @__PURE__ */ new Set());
        setBatchConfirmMode(null);
        setBatchDenyReason("");
        const head = t("batchResolved", { count: selectedItems.length, choice: batchConfirmMode });
        if (batchConfirmMode === "deny") {
          const done = batch?.approvals ?? [];
          sayDenied(head, reasonsState(done.length ? done.map((a) => a.reason_delivered) : [void 0]), done.map((a) => a.request_id));
        } else {
          setActionSuccessMsg(head);
          setTimeout(() => setActionSuccessMsg(null), 4e3);
        }
      } catch (err) {
        handleApiError(err);
      } finally {
        setIsSubmitting(false);
      }
    };
    const handleApiError = (err) => setError(approvalErrorText(err, t));
    const formatTimeAgo = (isoDate) => {
      try {
        const ms = Date.now() - new Date(isoDate).getTime();
        const mins = Math.max(0, Math.floor(ms / 6e4));
        if (mins < 1) return t("timeNow");
        if (mins < 60) return t("timeAgoMins", { mins });
        const hrs = Math.floor(mins / 60);
        return t("timeAgoHours", { hrs });
      } catch {
        return isoDate;
      }
    };
    const formatExpiresIn = (isoDate) => {
      try {
        const ms = new Date(isoDate).getTime() - Date.now();
        if (ms <= 0) return t("timeExpired");
        const mins = Math.ceil(ms / 6e4);
        if (mins < 60) return t("timeExpiresMins", { mins });
        const hrs = Math.floor(mins / 60);
        return t("timeExpiresHours", { hrs });
      } catch {
        return "";
      }
    };
    return /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:h-full lb:w-full lb:overflow-hidden lb:bg-[var(--background)] lb:text-[var(--color-foreground)]", children: [
      /* @__PURE__ */ jsxs("header", { className: "lb:px-6 lb:pt-6 lb:pb-4 lb:flex lb:flex-wrap lb:items-center lb:justify-between lb:gap-3 lb:shrink-0", children: [
        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2.5", children: [
          /* @__PURE__ */ jsx("div", { className: "lb:p-1.5 lb:rounded-xl lb:bg-[var(--color-primary)]/10 lb:text-[var(--color-primary)]", children: /* @__PURE__ */ jsx(CheckCircleIcon, { size: 18 }) }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("h1", { className: "lb-large-title", children: t("approvalsTitle") }),
            /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: pendingCount === 1 ? t("pendingActionCountOne") : t("pendingActionCountMany", { count: pendingCount }) })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-1.5 lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: [
            /* @__PURE__ */ jsx(FilterIcon, { size: 12 }),
            /* @__PURE__ */ jsxs(
              "select",
              {
                "aria-label": t("filterByBot"),
                value: botFilter,
                onChange: (e) => setBotFilter(e.target.value),
                className: "lb:px-2 lb:py-1 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:border-[var(--color-primary)]",
                children: [
                  /* @__PURE__ */ jsx("option", { value: "all", children: t("filterAllBots") }),
                  bots.map((b) => /* @__PURE__ */ jsx("option", { value: b.name, children: b.display?.label || b.name }, b.name))
                ]
              }
            )
          ] }),
          /* @__PURE__ */ jsxs(
            "select",
            {
              "aria-label": t("filterByStatus"),
              value: statusFilter,
              onChange: (e) => setStatusFilter(e.target.value),
              className: "lb:px-2 lb:py-1 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:border-[var(--color-primary)]",
              children: [
                /* @__PURE__ */ jsx("option", { value: "pending", children: t("filterPending") }),
                /* @__PURE__ */ jsx("option", { value: "all", children: t("filterAll") })
              ]
            }
          ),
          /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              onClick: loadApprovalsList,
              disabled: loading2,
              "aria-label": t("refreshApprovals"),
              className: "lb:p-1.5 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:hover:bg-[var(--lb-fill-2)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:motion-safe:transition-colors disabled:lb:opacity-50",
              children: /* @__PURE__ */ jsx(RefreshCwIcon, { size: 14, className: loading2 ? "lb:motion-safe:animate-spin" : "" })
            }
          )
        ] })
      ] }),
      isLoopback && /* @__PURE__ */ jsxs(
        "div",
        {
          role: "alert",
          className: "lb:px-4 lb:py-2.5 lb:bg-[var(--color-warning)]/15 lb:border-b lb:border-[var(--color-warning)]/30 lb:text-[var(--color-warning)] lb:flex lb:items-center lb:gap-2.5 lb:text-[13px] lb:shrink-0",
          children: [
            /* @__PURE__ */ jsx(ShieldAlertIcon, { size: 16, className: "lb:shrink-0" }),
            /* @__PURE__ */ jsx("span", { children: t("loopbackWarningApprovals") })
          ]
        }
      ),
      error && /* @__PURE__ */ jsxs(
        "div",
        {
          role: "alert",
          className: "lb:px-4 lb:py-2.5 lb:bg-[var(--color-destructive)]/15 lb:border-b lb:border-[var(--color-destructive)]/30 lb:text-[var(--color-destructive)] lb:flex lb:items-center lb:justify-between lb:gap-2 lb:text-[13px] lb:shrink-0",
          children: [
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
              /* @__PURE__ */ jsx(XIcon, { size: 14, className: "lb:shrink-0" }),
              /* @__PURE__ */ jsx("span", { children: /* @__PURE__ */ jsx(ErrorNote, { error }) })
            ] }),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: () => setError(null),
                className: "lb:p-1 lb:hover:opacity-80",
                "aria-label": t("closeError"),
                children: /* @__PURE__ */ jsx(XIcon, { size: 12 })
              }
            )
          ]
        }
      ),
      actionSuccessMsg && /* @__PURE__ */ jsxs(
        "div",
        {
          role: "status",
          className: "lb:px-4 lb:py-2.5 lb:bg-[var(--color-success)]/15 lb:border-b lb:border-[var(--color-success)]/30 lb:text-[var(--color-success)] lb:flex lb:items-center lb:gap-2 lb:text-[13px] lb:shrink-0",
          children: [
            /* @__PURE__ */ jsx(CheckIcon, { size: 14, className: "lb:shrink-0" }),
            /* @__PURE__ */ jsx("span", { children: actionSuccessMsg })
          ]
        }
      ),
      selectedIds.size > 0 && /* @__PURE__ */ jsxs("div", { className: "lb:px-4 lb:py-2 lb:bg-[var(--color-accent)] lb:border-b lb:border-[var(--lb-separator)] lb:flex lb:items-center lb:justify-between lb:gap-3 lb:shrink-0 lb:motion-safe:animate-in lb:fade-in", children: [
        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-3 lb:text-[13px]", children: [
          /* @__PURE__ */ jsx("span", { className: "lb:font-semibold lb:text-[var(--color-card-foreground)]", children: t("selectedCount", { count: selectedIds.size }) }),
          hasMismatchedActionClass && /* @__PURE__ */ jsx("span", { className: "lb:text-[var(--color-destructive)] lb:text-xs lb:font-medium", children: t("mismatchedClassWarning") })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
          /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              disabled: isLoopback || hasMismatchedActionClass || isSubmitting,
              onClick: () => setBatchConfirmMode("once"),
              className: "lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:motion-safe:transition-opacity disabled:lb:opacity-50 lb:rounded-full",
              children: t("allowSelectedOnce")
            }
          ),
          /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              disabled: isLoopback || hasMismatchedActionClass || isSubmitting,
              onClick: () => {
                setBatchDenyReason("");
                setBatchConfirmMode("deny");
              },
              className: "lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--color-destructive)] lb:text-[var(--color-destructive)] lb:hover:bg-[var(--color-destructive)]/10 lb:motion-safe:transition-colors disabled:lb:opacity-50 lb:rounded-full",
              children: t("denySelected")
            }
          ),
          /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              onClick: () => setSelectedIds(/* @__PURE__ */ new Set()),
              className: "lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:rounded-full",
              children: t("clearSelection")
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "lb:flex-1 lb:overflow-y-auto lb:p-4 lb:space-y-3 luvebot-scroll-container", children: [
        displayedApprovals.some((a) => a.status === "pending") && /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:px-1 lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: [
          /* @__PURE__ */ jsxs("label", { className: "lb:flex lb:items-center lb:gap-2 lb:cursor-pointer lb:select-none", children: [
            /* @__PURE__ */ jsx(
              "input",
              {
                type: "checkbox",
                disabled: isLoopback,
                checked: selectedIds.size > 0 && selectedIds.size === displayedApprovals.filter((a) => a.status === "pending").length,
                onChange: selectAllVisible,
                className: "lb:rounded-lg lb:border-[var(--lb-separator)] lb:text-[var(--color-primary)] focus:lb:ring-[var(--color-primary)]"
              }
            ),
            /* @__PURE__ */ jsx("span", { children: t("selectAllPending") })
          ] }),
          /* @__PURE__ */ jsx("span", { children: t("totalCount", { count: displayedApprovals.length }) })
        ] }),
        displayedApprovals.length === 0 && !loading2 && /* @__PURE__ */ jsxs(
          "div",
          {
            "data-testid": "approvals-empty-state",
            className: "lb:p-12 lb:text-center lb:flex lb:flex-col lb:items-center lb:justify-center lb:gap-2 lb:border-dashed lb:border-[var(--lb-separator)] lb:rounded-2xl lb:bg-[var(--color-card)]/50",
            children: [
              /* @__PURE__ */ jsx("div", { className: "lb:p-3 lb:rounded-full lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]", children: /* @__PURE__ */ jsx(CheckCircleIcon, { size: 24 }) }),
              /* @__PURE__ */ jsx("h3", { className: "lb:text-[15px] lb:font-medium lb:text-[var(--color-card-foreground)]", children: t("noPendingApprovalsTitle") }),
              /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:max-w-sm", children: t("noPendingApprovalsDesc") }),
              /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:max-w-sm lb:mt-1", children: t("approvalsEmptyNextStep") })
            ]
          }
        ),
        displayedApprovals.map((item2) => {
          const isSelected = selectedIds.has(item2.request_id);
          const isPending = item2.status === "pending";
          const botInfo = bots.find((b) => b.name === item2.bot);
          return /* @__PURE__ */ jsxs(
            "div",
            {
              "data-testid": `approval-card-${item2.request_id}`,
              className: `lb:rounded-2xl lb:bg-[var(--lb-fill)] lb:p-4 lb:flex lb:flex-col lb:gap-3 lb:motion-safe:transition-colors ${isSelected ? "lb:border-[var(--color-primary)] lb:ring-1 lb:ring-[var(--color-primary)]" : "lb:border-[var(--lb-separator)]"}  ${!isPending ? "lb:opacity-75" : ""}`,
              children: [
                /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-start lb:justify-between lb:gap-2", children: [
                  /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2.5 lb:flex-wrap", children: [
                    isPending && /* @__PURE__ */ jsx(
                      "input",
                      {
                        type: "checkbox",
                        disabled: isLoopback,
                        checked: isSelected,
                        onChange: () => toggleSelect(item2.request_id),
                        "aria-label": t("selectApprovalAria", { id: item2.request_id }),
                        className: "lb:rounded-lg lb:border-[var(--lb-separator)] lb:text-[var(--color-primary)] focus:lb:ring-[var(--color-primary)] lb:cursor-pointer"
                      }
                    ),
                    /* @__PURE__ */ jsxs("span", { className: "lb:inline-flex lb:items-center lb:gap-2", children: [
                      /* @__PURE__ */ jsx(Avatar, { name: botInfo?.display?.label || item2.bot, avatar: botInfo?.display?.avatar, color: botInfo?.display?.color, size: 28 }),
                      /* @__PURE__ */ jsx("span", { className: "lb-headline", children: botInfo?.display?.label || item2.bot })
                    ] }),
                    /* @__PURE__ */ jsx("span", { className: "lb-caption", children: item2.mechanism || item2.surface || t("defaultActionLabel") }),
                    /* @__PURE__ */ jsxs("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)]", children: [
                      "\xB7 ",
                      formatTimeAgo(item2.created_at)
                    ] }),
                    isPending && item2.expires_at && /* @__PURE__ */ jsxs("span", { className: "lb-pill lb-caption", children: [
                      /* @__PURE__ */ jsx(ClockIcon, { size: 12 }),
                      formatExpiresIn(item2.expires_at)
                    ] }),
                    !isPending && /* @__PURE__ */ jsx(
                      "span",
                      {
                        className: `lb:text-xs lb:font-medium lb:px-1.5 lb:py-0.5 lb:rounded-lg ${item2.decided_choice === "once" ? "lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)]" : item2.decided_choice === "deny" ? "lb:bg-[var(--color-destructive)]/15 lb:text-[var(--color-destructive)]" : "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]"}`,
                        children: item2.decided_choice ? approvalDecisionLabel(item2.decided_choice, t) : approvalStateLabel(item2.status, t)
                      }
                    )
                  ] }),
                  /* @__PURE__ */ jsxs(
                    "div",
                    {
                      title: t("digestVerifiedTitle", { digest: item2.digest }),
                      className: "lb:text-xs lb:font-mono lb:text-[var(--color-muted-foreground)] lb:select-all lb:shrink-0",
                      children: [
                        t("digestPrefix"),
                        " ",
                        item2.digest.slice(0, 10),
                        "..."
                      ]
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "lb:space-y-2", children: [
                  item2.command_redacted && /* @__PURE__ */ jsx("div", { className: "lb:rounded-xl lb:bg-[var(--background)] lb:p-2.5 lb:border-[var(--lb-separator)] lb:font-mono lb:text-[13px] lb:text-[var(--color-foreground)] lb:overflow-x-auto", children: /* @__PURE__ */ jsx("code", { children: item2.command_redacted }) }),
                  /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:leading-relaxed", children: approvalTitle(item2, ruleLabel, t) }),
                  item2.pattern_keys && item2.pattern_keys.length > 0 && /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-1.5 lb:flex-wrap lb:text-xs lb:text-[var(--color-muted-foreground)]", children: [
                    /* @__PURE__ */ jsx("span", { className: "lb:font-medium", children: t("patternsLabel") }),
                    item2.pattern_keys.map((pk) => /* @__PURE__ */ jsx(
                      "span",
                      {
                        className: "lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:font-mono lb:text-xs",
                        children: pk
                      },
                      pk
                    ))
                  ] }),
                  /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-3 lb:text-xs lb:text-[var(--color-muted-foreground)]", children: [
                    item2.run_id && /* @__PURE__ */ jsxs("span", { children: [
                      t("originRun"),
                      " ",
                      /* @__PURE__ */ jsx("span", { className: "lb:font-mono", children: item2.run_id })
                    ] }),
                    item2.source === "transport" && /* @__PURE__ */ jsxs("span", { children: [
                      t("originTransport"),
                      item2.surface ? ` (${item2.surface})` : ""
                    ] }),
                    item2.allowed_choices && item2.allowed_choices.length > 0 && /* @__PURE__ */ jsxs("span", { children: [
                      t("nativeChoices"),
                      " ",
                      /* @__PURE__ */ jsx("span", { children: item2.allowed_choices.map((c) => approvalChoiceLabel(c, t)).join(" \xB7 ") })
                    ] })
                  ] })
                ] }),
                isPending && /* @__PURE__ */ jsxs("div", { className: "lb:pt-2 lb:border-t lb:border-[var(--lb-separator)] lb:flex lb:items-center lb:justify-between lb:gap-2 lb:flex-wrap", children: [
                  /* @__PURE__ */ jsx("div", { className: "lb:flex lb:items-center lb:gap-2", children: /* @__PURE__ */ jsx(
                    "button",
                    {
                      type: "button",
                      onClick: () => setEditModalItem(item2),
                      className: "lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:motion-safe:transition-colors lb:rounded-full",
                      children: t("viewParamsBtn")
                    }
                  ) }),
                  /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                    /* @__PURE__ */ jsx(
                      "button",
                      {
                        type: "button",
                        disabled: isLoopback || isSubmitting,
                        title: isLoopback ? t("disabledInLoopback") : void 0,
                        onClick: () => openDenyModal(item2),
                        className: "lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--color-destructive)]/40 lb:text-[var(--color-destructive)] lb:hover:bg-[var(--color-destructive)]/10 lb:motion-safe:transition-colors disabled:lb:opacity-50 lb:rounded-full",
                        children: t("denyBtn")
                      }
                    ),
                    /* @__PURE__ */ jsx(
                      "button",
                      {
                        type: "button",
                        disabled: isLoopback || isSubmitting,
                        title: isLoopback ? t("disabledInLoopback") : void 0,
                        onClick: () => openAlwaysModal(item2),
                        className: "lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-card-foreground)] lb:hover:bg-[var(--lb-fill-2)] lb:motion-safe:transition-colors disabled:lb:opacity-50 lb:rounded-full",
                        children: t("alwaysAllowBtn")
                      }
                    ),
                    /* @__PURE__ */ jsx(
                      "button",
                      {
                        type: "button",
                        disabled: isLoopback || isSubmitting,
                        title: isLoopback ? t("disabledInLoopback") : void 0,
                        onClick: () => handleResolveOnce(item2),
                        className: "lb:px-3 lb:py-1 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:motion-safe:transition-opacity disabled:lb:opacity-50 lb:rounded-full",
                        children: t("allowOnceBtn")
                      }
                    )
                  ] })
                ] })
              ]
            },
            item2.request_id
          );
        })
      ] }),
      alwaysModalItem && /* @__PURE__ */ jsx(
        "div",
        {
          ref: alwaysModalRef,
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "always-modal-title",
          className: "lb:fixed lb:inset-0 lb:z-50 lb:bg-black/60 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:p-4",
          children: /* @__PURE__ */ jsxs("div", { className: "lb:w-full lb:max-w-md lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--color-card)] lb:text-[var(--color-card-foreground)] lb:p-5 lb:shadow-xl lb:space-y-4", children: [
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-start lb:justify-between lb:gap-2", children: [
              /* @__PURE__ */ jsx(
                "h2",
                {
                  id: "always-modal-title",
                  className: "lb:text-[15px] lb:font-bold lb:text-[var(--color-card-foreground)]",
                  children: t("alwaysModalHeader")
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  "aria-label": t("close"),
                  onClick: () => setAlwaysModalItem(null),
                  className: "lb:p-2 lb:min-h-11 lb:min-w-11 lb:flex lb:items-center lb:justify-center lb:rounded-lg lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none",
                  children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
                }
              )
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:space-y-2", children: [
              /* @__PURE__ */ jsx("p", { children: t("alwaysModalExplanationP1") }),
              /* @__PURE__ */ jsx("p", { className: "lb:p-2.5 lb:rounded-lg lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)]", children: t("alwaysModalExplanationP2", { bot: labelOf(alwaysModalItem.bot) }) })
            ] }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx(
                "label",
                {
                  htmlFor: "draft-rule-label",
                  className: "lb:block lb:text-[13px] lb:font-medium lb:text-[var(--color-card-foreground)] lb:mb-1",
                  children: t("alwaysModalDraftLabel")
                }
              ),
              /* @__PURE__ */ jsx(
                "input",
                {
                  id: "draft-rule-label",
                  type: "text",
                  value: alwaysDraftLabel,
                  onChange: (e) => setAlwaysDraftLabel(e.target.value),
                  className: "lb:w-full lb:px-3 lb:py-1.5 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:border-[var(--color-primary)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)]"
                }
              )
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2", children: [
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: () => setAlwaysModalItem(null),
                  className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                  children: t("alwaysModalCancel")
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  disabled: isSubmitting,
                  onClick: handleConfirmAlways,
                  className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 disabled:lb:opacity-50 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                  children: t("alwaysModalConfirm")
                }
              )
            ] })
          ] })
        }
      ),
      denyModalItem && /* @__PURE__ */ jsx(
        "div",
        {
          ref: denyModalRef,
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "deny-modal-title",
          className: "lb:fixed lb:inset-0 lb:z-50 lb:bg-black/60 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:p-4",
          children: /* @__PURE__ */ jsxs("div", { className: "lb:w-full lb:max-w-md lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--color-card)] lb:text-[var(--color-card-foreground)] lb:p-5 lb:shadow-xl lb:space-y-4", children: [
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-start lb:justify-between lb:gap-2", children: [
              /* @__PURE__ */ jsx(
                "h2",
                {
                  id: "deny-modal-title",
                  className: "lb:text-[15px] lb:font-bold lb:text-[var(--color-destructive)]",
                  children: t("denyModalTitleWithBot", { bot: labelOf(denyModalItem.bot) })
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  "aria-label": t("close"),
                  onClick: () => setDenyModalItem(null),
                  className: "lb:p-2 lb:min-h-11 lb:min-w-11 lb:flex lb:items-center lb:justify-center lb:rounded-lg lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)] focus-visible:lb:outline-none",
                  children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
                }
              )
            ] }),
            /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("denyModalExplanation") }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx(
                "label",
                {
                  htmlFor: "deny-reason-input",
                  className: "lb:block lb:text-[13px] lb:font-medium lb:text-[var(--color-card-foreground)] lb:mb-1",
                  children: t("denyModalReasonLabel")
                }
              ),
              /* @__PURE__ */ jsx(
                "textarea",
                {
                  id: "deny-reason-input",
                  rows: 3,
                  required: true,
                  value: denyReason,
                  onChange: (e) => setDenyReason(e.target.value),
                  placeholder: t("denyModalPlaceholder"),
                  className: "lb:w-full lb:px-3 lb:py-2 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:border-[var(--color-destructive)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)]"
                }
              ),
              !denyReason.trim() && /* @__PURE__ */ jsx("span", { className: "lb:text-xs lb:text-[var(--color-destructive)]", children: t("denyReasonEmpty") })
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2", children: [
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: () => setDenyModalItem(null),
                  className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                  children: t("alwaysModalCancel")
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  disabled: !denyReason.trim() || isSubmitting,
                  onClick: handleConfirmDeny,
                  className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-destructive)] lb:text-[var(--color-destructive-foreground)] lb:hover:opacity-90 disabled:lb:opacity-50 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)] focus-visible:lb:outline-none lb:rounded-full",
                  children: t("denyModalConfirm")
                }
              )
            ] })
          ] })
        }
      ),
      editModalItem && /* @__PURE__ */ jsx(
        "div",
        {
          ref: editModalRef,
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "edit-modal-title",
          className: "lb:fixed lb:inset-0 lb:z-50 lb:bg-black/60 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:p-4",
          children: /* @__PURE__ */ jsxs("div", { className: "lb:w-full lb:max-w-md lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--color-card)] lb:text-[var(--color-card-foreground)] lb:p-5 lb:shadow-xl lb:space-y-4", children: [
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-start lb:justify-between lb:gap-2", children: [
              /* @__PURE__ */ jsx(
                "h2",
                {
                  id: "edit-modal-title",
                  className: "lb:text-[15px] lb:font-bold lb:text-[var(--color-card-foreground)]",
                  children: t("editModalParametersTitle")
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  "aria-label": t("close"),
                  onClick: () => setEditModalItem(null),
                  className: "lb:p-2 lb:min-h-11 lb:min-w-11 lb:flex lb:items-center lb:justify-center lb:rounded-lg lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none",
                  children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
                }
              )
            ] }),
            /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("editModalWarning") }),
            /* @__PURE__ */ jsxs("div", { className: "lb:rounded-xl lb:bg-[var(--background)] lb:p-3 lb:border-[var(--lb-separator)] lb:font-mono lb:text-[13px] lb:overflow-x-auto", children: [
              /* @__PURE__ */ jsxs("div", { children: [
                /* @__PURE__ */ jsx("strong", { children: t("editModalActionLabel") }),
                " ",
                editModalItem.mechanism
              ] }),
              editModalItem.command_redacted && /* @__PURE__ */ jsxs("div", { className: "lb:mt-1", children: [
                /* @__PURE__ */ jsx("strong", { children: t("editModalCommandLabel") }),
                " ",
                editModalItem.command_redacted
              ] }),
              editModalItem.description && /* @__PURE__ */ jsxs("div", { className: "lb:mt-1", children: [
                /* @__PURE__ */ jsx("strong", { children: t("editModalDetailsLabel") }),
                " ",
                editModalItem.description
              ] })
            ] }),
            /* @__PURE__ */ jsx("div", { className: "lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2", children: /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: () => setEditModalItem(null),
                className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                children: t("editModalClose")
              }
            ) })
          ] })
        }
      ),
      batchConfirmMode && /* @__PURE__ */ jsx(
        "div",
        {
          ref: batchModalRef,
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "batch-confirm-title",
          className: "lb:fixed lb:inset-0 lb:z-50 lb:bg-black/60 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:p-4",
          children: /* @__PURE__ */ jsxs("div", { className: "lb:w-full lb:max-w-md lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--color-card)] lb:text-[var(--color-card-foreground)] lb:p-5 lb:shadow-xl lb:space-y-4", children: [
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-start lb:justify-between lb:gap-2", children: [
              /* @__PURE__ */ jsx(
                "h2",
                {
                  id: "batch-confirm-title",
                  className: "lb:text-[15px] lb:font-bold lb:text-[var(--color-card-foreground)]",
                  children: batchConfirmMode === "once" ? t("batchConfirmOnceTitle", { count: selectedItems.length }) : t("batchConfirmDenyTitle", { count: selectedItems.length })
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  "aria-label": t("close"),
                  onClick: () => setBatchConfirmMode(null),
                  className: "lb:p-2 lb:min-h-11 lb:min-w-11 lb:flex lb:items-center lb:justify-center lb:rounded-lg lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none",
                  children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
                }
              )
            ] }),
            /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("batchConfirmExplanation", { count: selectedItems.length }) }),
            batchConfirmMode === "deny" && /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx(
                "label",
                {
                  htmlFor: "batch-deny-reason",
                  className: "lb:block lb:text-[13px] lb:font-medium lb:text-[var(--color-card-foreground)] lb:mb-1",
                  children: t("batchDenyReasonLabel")
                }
              ),
              /* @__PURE__ */ jsx(
                "textarea",
                {
                  id: "batch-deny-reason",
                  rows: 2,
                  required: true,
                  value: batchDenyReason,
                  onChange: (e) => setBatchDenyReason(e.target.value),
                  placeholder: t("batchDenyPlaceholder"),
                  className: "lb:w-full lb:px-3 lb:py-2 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:border-[var(--color-destructive)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)]"
                }
              )
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2", children: [
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: () => setBatchConfirmMode(null),
                  className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                  children: t("alwaysModalCancel")
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  disabled: isSubmitting || batchConfirmMode === "deny" && !batchDenyReason.trim(),
                  onClick: handleConfirmBatch,
                  className: `lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium disabled:lb:opacity-50 focus-visible:lb:ring-2 focus-visible:lb:outline-none lb:rounded-full ${batchConfirmMode === "once" ? "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 focus-visible:lb:ring-[var(--color-primary)]" : "lb:bg-[var(--color-destructive)] lb:text-[var(--color-destructive-foreground)] lb:hover:opacity-90 focus-visible:lb:ring-[var(--color-destructive)]"}`,
                  children: t("batchConfirmBtn")
                }
              )
            ] })
          ] })
        }
      )
    ] });
  }

  // dashboard/src/sound/cues.ts
  var KEY = "luvebot.sounds";
  var MIN_GAP_MS = 2e3;
  function readSoundPref() {
    try {
      const v = window.localStorage.getItem(KEY);
      return v === "needs_you" || v === "off" ? v : "all";
    } catch {
      return "all";
    }
  }
  function writeSoundPref(p) {
    try {
      if (p === "all") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, p);
    } catch {
    }
  }
  var ctx = null;
  var last = -Infinity;
  function unlock() {
    if (ctx) return;
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      void ctx.resume?.();
    } catch {
      ctx = null;
    }
  }
  function tone(c, freq, at, dur, peak, type, glideTo) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur * 0.6);
    g.gain.setValueAtTime(1e-4, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.015);
    g.gain.exponentialRampToValueAtTime(1e-4, at + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(at);
    o.stop(at + dur + 0.02);
  }
  function synth(c, cue) {
    const t = c.currentTime + 0.01;
    if (cue === "message") tone(c, 740, t, 0.16, 0.05, "sine", 988);
    else {
      tone(c, 659, t, 0.12, 0.06, "triangle");
      tone(c, 988, t + 0.13, 0.14, 0.06, "triangle");
    }
  }
  function looking(bot, openBot) {
    return document.visibilityState !== "hidden" && document.hasFocus() && openBot === bot;
  }
  function playCue(cue, bot, openBot) {
    const pref = readSoundPref();
    if (pref === "off" || pref === "needs_you" && cue === "message") return false;
    if (!ctx || looking(bot, openBot)) return false;
    const now = Date.now();
    if (now - last < MIN_GAP_MS) return false;
    last = now;
    try {
      synth(ctx, cue);
    } catch {
      return false;
    }
    return true;
  }
  var seenOf = (b) => {
    const u = b.unread;
    return {
      replies: typeof u?.replies === "number" ? u.replies : void 0,
      routines: typeof u?.routine_results === "number" ? u.routine_results : void 0,
      waiting: b.status === "waiting_approval"
    };
  };
  var grew = (now, before) => now !== void 0 && before !== void 0 && now > before;
  function useCues(bots, pending, openBot) {
    const seen = react_default.useRef(null);
    const waiting = react_default.useRef(null);
    const fresh = react_default.useRef(/* @__PURE__ */ new Set());
    const open = react_default.useRef(openBot);
    open.current = openBot;
    react_default.useEffect(() => {
      const on = () => {
        unlock();
        off();
      };
      const off = () => {
        document.removeEventListener("pointerdown", on, true);
        document.removeEventListener("keydown", on, true);
      };
      document.addEventListener("pointerdown", on, true);
      document.addEventListener("keydown", on, true);
      return off;
    }, []);
    react_default.useEffect(() => {
      if (!bots) return;
      const before = seen.current;
      seen.current = new Map(bots.map((b) => [b.name, seenOf(b)]));
      if (!before) return;
      fresh.current = new Set([...seen.current.keys()].filter((name) => !before.has(name)));
      const needs = [];
      const news = [];
      for (const [name, s] of seen.current) {
        const p = before.get(name);
        if (!p) continue;
        if (s.waiting && !p.waiting) needs.push(name);
        if (grew(s.replies, p.replies) || grew(s.routines, p.routines)) news.push(name);
      }
      void (needs.some((b) => playCue("needs_you", b, open.current)) || news.some((b) => playCue("message", b, open.current)));
    }, [bots]);
    react_default.useEffect(() => {
      if (!pending) return;
      const before = waiting.current;
      waiting.current = pending;
      if (!before) return;
      void Object.keys(pending).some((b) => !!seen.current?.has(b) && !fresh.current.has(b) && pending[b] > (before[b] ?? 0) && playCue("needs_you", b, open.current));
    }, [pending]);
  }

  // dashboard/src/components/settings/SettingsView.tsx
  var SHORTCUTS = [
    ["\u2318K", "shortcutSearch"],
    ["\u2318N", "shortcutNewBot"],
    ["\u2318\u21E7N", "shortcutNewRoom"],
    ["\u2318B", "shortcutSidebar"],
    ["\u23181\u20269", "shortcutBotN"],
    ["\u2325\u2191 / \u2325\u2193", "shortcutBotStep"],
    ["\u2318I", "shortcutComposer"],
    ["G \xB7 A", "shortcutApprovals"],
    ["Esc", "shortcutClose"]
  ];
  function SettingsView({ bots = [] }) {
    const { t, locale, setLocale } = useLuveI18n();
    const [tab, setTab] = react_default.useState("general");
    const [sound, setSound] = react_default.useState(readSoundPref);
    const sounds = [["all", "soundsAll"], ["needs_you", "soundsNeedsYou"], ["off", "soundsOff"]];
    const tabs = [["general", "settingsTabGeneral"], ["costs", "settingsTabCosts"], ["rules", "settingsTabRules"]];
    return /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--color-background)" }, children: [
      /* @__PURE__ */ jsxs("header", { style: { padding: "24px 24px 0" }, children: [
        /* @__PURE__ */ jsx("h1", { className: "lb-large-title", style: { margin: 0 }, children: t("navConfig") }),
        /* @__PURE__ */ jsx("div", { role: "tablist", "aria-label": t("navConfig"), className: "lb-segmented", style: { marginTop: 16, maxWidth: 420 }, children: tabs.map(([k, label]) => /* @__PURE__ */ jsx("button", { type: "button", role: "tab", "aria-selected": tab === k, onClick: () => setTab(k), className: "lb-segment", children: t(label) }, k)) })
      ] }),
      /* @__PURE__ */ jsxs("div", { role: "tabpanel", style: { flex: 1, minHeight: 0, overflowY: "auto", marginTop: 16 }, children: [
        tab === "general" && /* @__PURE__ */ jsxs("div", { style: { padding: "8px 24px", maxWidth: 560 }, children: [
          /* @__PURE__ */ jsx("div", { className: "lb-group", children: /* @__PURE__ */ jsxs("label", { className: "lb-row", style: { justifyContent: "space-between" }, children: [
            /* @__PURE__ */ jsx("span", { className: "lb-body", children: t("settingsLanguage") }),
            /* @__PURE__ */ jsxs("select", { value: locale, onChange: (e) => setLocale(e.target.value), className: "lb-input", style: { width: "auto", minWidth: 140 }, children: [
              /* @__PURE__ */ jsx("option", { value: "pt", children: t("langPortuguese") }),
              /* @__PURE__ */ jsx("option", { value: "en", children: t("langEnglish") })
            ] })
          ] }) }),
          /* @__PURE__ */ jsx("p", { className: "lb-caption", style: { color: "var(--color-muted-foreground)", margin: "8px 16px" }, children: t("settingsThemeNote") }),
          /* @__PURE__ */ jsx("h2", { id: "settings-sounds", className: "lb-headline", style: { margin: "24px 4px 8px" }, children: t("soundsTitle") }),
          /* @__PURE__ */ jsx("div", { role: "radiogroup", "aria-labelledby": "settings-sounds", className: "lb-group", children: sounds.map(([value, label]) => /* @__PURE__ */ jsxs("label", { className: "lb-row lb-row-flat", style: { minHeight: 44, gap: 12, cursor: "pointer" }, children: [
            /* @__PURE__ */ jsx("input", { type: "radio", name: "luvebot-sounds", value, checked: sound === value, onChange: () => {
              setSound(value);
              writeSoundPref(value);
            } }),
            /* @__PURE__ */ jsx("span", { className: "lb-body", children: t(label) })
          ] }, value)) }),
          /* @__PURE__ */ jsx("p", { className: "lb-caption", style: { color: "var(--color-muted-foreground)", margin: "8px 16px" }, children: t("soundsNote") }),
          /* @__PURE__ */ jsx("h2", { className: "lb-headline", style: { margin: "24px 4px 8px" }, children: t("settingsAppTitle") }),
          /* @__PURE__ */ jsxs("div", { className: "lb-group", children: [
            /* @__PURE__ */ jsx("div", { className: "lb-row lb-row-flat", style: { minHeight: 44 }, children: /* @__PURE__ */ jsx("span", { className: "lb-body", children: t("pwaInstallableBadge") }) }),
            /* @__PURE__ */ jsx("div", { className: "lb-row lb-row-flat", style: { minHeight: 44 }, children: /* @__PURE__ */ jsx("span", { className: "lb-body", children: t("pwaOfflineNoticeHeader") }) })
          ] }),
          /* @__PURE__ */ jsx("p", { className: "lb-caption", style: { color: "var(--color-muted-foreground)", margin: "8px 16px" }, children: t("pwaScopeNotice") }),
          /* @__PURE__ */ jsx("h2", { className: "lb-headline", style: { margin: "24px 4px 8px" }, children: t("shortcutsTitle") }),
          /* @__PURE__ */ jsx("dl", { className: "lb-group", style: { margin: 0 }, children: SHORTCUTS.map(([keys, label]) => /* @__PURE__ */ jsxs("div", { className: "lb-row lb-row-flat", style: { minHeight: 44, justifyContent: "space-between" }, children: [
            /* @__PURE__ */ jsx("dt", { className: "lb-body", children: t(label) }),
            /* @__PURE__ */ jsx("dd", { style: { margin: 0 }, children: /* @__PURE__ */ jsx("kbd", { className: "lb-pill", style: { fontFamily: "var(--lb-font)" }, children: keys }) })
          ] }, keys)) }),
          /* @__PURE__ */ jsx("p", { className: "lb-caption", style: { color: "var(--color-muted-foreground)", margin: "8px 16px" }, children: t("shortcutsNote") })
        ] }),
        tab === "costs" && /* @__PURE__ */ jsx(CostsView, { bots }),
        tab === "rules" && /* @__PURE__ */ jsx(RulesView, { bots })
      ] })
    ] });
  }

  // dashboard/src/components/routines/RoutinesView.tsx
  function RoutinesView({
    bots = [],
    initialRoutines,
    onRefresh,
    botName
  }) {
    const { locale, t } = useLuveI18n();
    const [routines, setRoutines] = useState(initialRoutines || []);
    const [loading2, setLoading] = useState(!initialRoutines);
    const [error, setError] = useState(null);
    const [actionSuccess, setActionSuccess] = useState(null);
    const [actionError, setActionError] = useState(null);
    const [filterBot, setFilterBot] = useState(botName ?? "");
    const [filterState, setFilterState] = useState("all");
    const [selectedRoutineId, setSelectedRoutineId] = useState(null);
    const [routineDetail, setRoutineDetail] = useState(null);
    const [historyRuns, setHistoryRuns] = useState([]);
    const [isHistoryTruncated, setIsHistoryTruncated] = useState(false);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [createModalOpen, setCreateModalOpen] = useState(false);
    const [editRoutine, setEditRoutine] = useState(null);
    const [newBot, setNewBot] = useState(botName || bots[0]?.name || "vendas");
    const [newName, setNewName] = useState("");
    const [newScheduleExpr, setNewScheduleExpr] = useState("0 8 * * 1-5");
    const [newPrompt, setNewPrompt] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [confirmTestRoutine, setConfirmTestRoutine] = useState(null);
    const [confirmPauseRoutine, setConfirmPauseRoutine] = useState(null);
    const [confirmResumeRoutine, setConfirmResumeRoutine] = useState(null);
    const [confirmDeleteRoutine, setConfirmDeleteRoutine] = useState(null);
    const [deleteTypedName, setDeleteTypedName] = useState("");
    const formModalRef = useFocusTrap({
      isOpen: createModalOpen,
      onClose: () => setCreateModalOpen(false)
    });
    const testModalRef = useFocusTrap({
      isOpen: Boolean(confirmTestRoutine),
      onClose: () => setConfirmTestRoutine(null)
    });
    const pauseModalRef = useFocusTrap({
      isOpen: Boolean(confirmPauseRoutine),
      onClose: () => setConfirmPauseRoutine(null)
    });
    const resumeModalRef = useFocusTrap({
      isOpen: Boolean(confirmResumeRoutine),
      onClose: () => setConfirmResumeRoutine(null)
    });
    const deleteModalRef = useFocusTrap({
      isOpen: Boolean(confirmDeleteRoutine),
      onClose: () => setConfirmDeleteRoutine(null)
    });
    const loadRoutinesList = useCallback(async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await getRoutines({
          bot: filterBot || void 0,
          state: filterState !== "all" ? filterState : void 0
        });
        setRoutines(res.routines || []);
      } catch (err) {
        const msg = humanError(err, t, "errorLoadingRoutines");
        setError(msg);
      } finally {
        setLoading(false);
      }
    }, [filterBot, filterState, t]);
    useEffect(() => {
      if (!initialRoutines) {
        loadRoutinesList();
      }
    }, [loadRoutinesList, initialRoutines]);
    const loadRoutineDetailAndHistory = useCallback(
      async (id) => {
        setSelectedRoutineId(id);
        setLoadingHistory(true);
        setActionError(null);
        try {
          const detailRes = await getRoutine(id);
          setRoutineDetail(detailRes);
          const full = await fetchAllRoutineRuns(id, 100);
          setHistoryRuns(full.runs);
          setIsHistoryTruncated(full.truncated);
        } catch (err) {
          const msg = humanError(err, t, "errorLoadingRoutineRuns");
          setActionError(msg);
        } finally {
          setLoadingHistory(false);
        }
      },
      [t]
    );
    const handleRefresh = () => {
      loadRoutinesList();
      if (selectedRoutineId) {
        loadRoutineDetailAndHistory(selectedRoutineId);
      }
      if (onRefresh) onRefresh();
    };
    const handleOpenCreateModal = () => {
      setEditRoutine(null);
      setNewBot(bots[0]?.name || "vendas");
      setNewName("");
      setNewScheduleExpr("0 8 * * 1-5");
      setNewPrompt("");
      setCreateModalOpen(true);
    };
    const handleOpenEditModal = (r) => {
      setEditRoutine(r);
      setNewBot(r.bot);
      setNewName(r.name);
      setNewScheduleExpr(r.schedule.expr);
      setNewPrompt("");
      setCreateModalOpen(true);
    };
    const handleSaveRoutine = async () => {
      if (!newName.trim() || !newScheduleExpr.trim()) return;
      try {
        setIsSubmitting(true);
        setActionError(null);
        if (editRoutine) {
          await updateRoutine(editRoutine.id, {
            name: newName.trim(),
            schedule: { expr: newScheduleExpr.trim() },
            prompt: newPrompt.trim() || void 0
          });
        } else {
          await createRoutine({
            bot: newBot,
            name: newName.trim(),
            schedule: { expr: newScheduleExpr.trim() },
            prompt: newPrompt.trim() || void 0
          });
        }
        setCreateModalOpen(false);
        await loadRoutinesList();
      } catch (err) {
        const msg = humanError(err, t, "errorSavingRoutine");
        setActionError(msg);
      } finally {
        setIsSubmitting(false);
      }
    };
    const handleExecuteTest = async () => {
      if (!confirmTestRoutine) return;
      try {
        setIsSubmitting(true);
        setActionError(null);
        await testRoutine(confirmTestRoutine.id);
        setConfirmTestRoutine(null);
        setActionSuccess(t("routineTestedSuccess"));
        await loadRoutinesList();
      } catch (err) {
        const msg = humanError(err, t, "errorTestingRoutine");
        setActionError(msg);
      } finally {
        setIsSubmitting(false);
      }
    };
    const handleExecutePause = async () => {
      if (!confirmPauseRoutine) return;
      try {
        setIsSubmitting(true);
        setActionError(null);
        await pauseRoutine(confirmPauseRoutine.id);
        setConfirmPauseRoutine(null);
        setActionSuccess(t("routinePausedSuccess"));
        await loadRoutinesList();
      } catch (err) {
        const msg = humanError(err, t, "errorPausingRoutine");
        setActionError(msg);
      } finally {
        setIsSubmitting(false);
      }
    };
    const handleExecuteResume = async () => {
      if (!confirmResumeRoutine) return;
      try {
        setIsSubmitting(true);
        setActionError(null);
        await resumeRoutine(confirmResumeRoutine.id);
        setConfirmResumeRoutine(null);
        setActionSuccess(t("routineResumedSuccess"));
        await loadRoutinesList();
      } catch (err) {
        const msg = humanError(err, t, "errorResumingRoutine");
        setActionError(msg);
      } finally {
        setIsSubmitting(false);
      }
    };
    const handleExecuteDuplicate = async (r) => {
      try {
        setIsSubmitting(true);
        setActionError(null);
        await duplicateRoutine(r.id);
        await loadRoutinesList();
      } catch (err) {
        const msg = humanError(err, t, "errorSavingRoutine");
        setActionError(msg);
      } finally {
        setIsSubmitting(false);
      }
    };
    const handleExecuteDelete = async () => {
      if (!confirmDeleteRoutine) return;
      if (deleteTypedName.trim() !== confirmDeleteRoutine.name) {
        setActionError(t("errorDeletingNameMismatch"));
        return;
      }
      try {
        setIsSubmitting(true);
        setActionError(null);
        await deleteRoutine(confirmDeleteRoutine.id, deleteTypedName.trim());
        setConfirmDeleteRoutine(null);
        setDeleteTypedName("");
        setActionSuccess(t("routineDeletedSuccess"));
        if (selectedRoutineId === confirmDeleteRoutine.id) {
          setSelectedRoutineId(null);
          setRoutineDetail(null);
        }
        await loadRoutinesList();
      } catch (err) {
        const msg = humanError(err, t, "errorDeletingRoutine");
        setActionError(msg);
      } finally {
        setIsSubmitting(false);
      }
    };
    const filteredRoutines = useMemo(() => {
      return routines.filter((r) => {
        if (filterBot && r.bot !== filterBot) return false;
        if (filterState === "scheduled" && (r.state === "paused" || !r.enabled))
          return false;
        if (filterState === "paused" && r.state !== "paused" && r.enabled)
          return false;
        return true;
      });
    }, [routines, filterBot, filterState]);
    const botInfo = (name) => bots.find((b) => b.name === name);
    const botLabel = (name) => botInfo(name)?.display?.label || name;
    return /* @__PURE__ */ jsxs(
      "div",
      {
        "data-testid": "routines-view",
        className: "lb:flex lb:flex-col lb:h-full lb:w-full lb:overflow-y-auto lb:bg-[var(--background)] lb:text-[var(--color-foreground)]",
        children: [
          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:sm:flex-row lb:sm:items-center lb:justify-between lb:gap-3 lb:px-6 lb:pt-6 lb:pb-2", children: [
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-3", children: [
              /* @__PURE__ */ jsx("div", { className: "lb:p-2 lb:rounded-2xl lb:bg-[var(--color-primary)]/10 lb:text-[var(--color-primary)]", children: /* @__PURE__ */ jsx(ClockIcon, { size: 20 }) }),
              /* @__PURE__ */ jsxs("div", { children: [
                /* @__PURE__ */ jsx("h1", { className: "lb-large-title", children: t("routinesTitle") }),
                /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("routinesSubtitle") })
              ] })
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
              /* @__PURE__ */ jsxs(
                "button",
                {
                  type: "button",
                  "aria-label": t("refreshRoutinesAriaLabel"),
                  onClick: handleRefresh,
                  className: "lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:motion-safe:transition-colors lb:rounded-full",
                  children: [
                    /* @__PURE__ */ jsx(RefreshCwIcon, { size: 13 }),
                    /* @__PURE__ */ jsx("span", { children: t("retry") })
                  ]
                }
              ),
              /* @__PURE__ */ jsxs(
                "button",
                {
                  type: "button",
                  "data-testid": "btn-new-routine",
                  onClick: handleOpenCreateModal,
                  className: "lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:motion-safe:transition-colors lb:rounded-full",
                  children: [
                    /* @__PURE__ */ jsx(PlusIcon, { size: 13 }),
                    /* @__PURE__ */ jsx("span", { children: t("newRoutineBtn") })
                  ]
                }
              )
            ] })
          ] }),
          actionError && /* @__PURE__ */ jsxs(
            "div",
            {
              role: "alert",
              className: "lb:mx-4 lb:mt-4 lb:md:mx-6 lb:p-3 lb:rounded-xl lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:text-[13px] lb:text-[var(--color-destructive)] lb:flex lb:items-center lb:justify-between",
              children: [
                /* @__PURE__ */ jsx("span", { children: /* @__PURE__ */ jsx(ErrorNote, { error: actionError }) }),
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    "aria-label": t("close"),
                    onClick: () => setActionError(null),
                    children: /* @__PURE__ */ jsx(XIcon, { size: 14 })
                  }
                )
              ]
            }
          ),
          actionSuccess && /* @__PURE__ */ jsxs("div", { className: "lb:mx-4 lb:mt-4 lb:md:mx-6 lb:p-3 lb:rounded-xl lb:bg-[var(--color-success)]/10 lb:border-[var(--color-success)]/30 lb:text-[13px] lb:text-[var(--color-success)] lb:flex lb:items-center lb:justify-between", children: [
            /* @__PURE__ */ jsx("span", { children: actionSuccess }),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                "aria-label": t("close"),
                onClick: () => setActionSuccess(null),
                children: /* @__PURE__ */ jsx(XIcon, { size: 14 })
              }
            )
          ] }),
          selectedRoutineId ? /* @__PURE__ */ jsxs("div", { className: "lb:p-4 lb:md:p-6 lb:space-y-6", children: [
            /* @__PURE__ */ jsx("div", { className: "lb:flex lb:items-center lb:justify-between lb:border-b lb:border-[var(--lb-separator)] lb:pb-4", children: /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-3", children: [
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  "data-testid": "btn-back-to-list",
                  onClick: () => setSelectedRoutineId(null),
                  className: "lb:px-2.5 lb:py-1 lb:text-[13px] lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:rounded-full",
                  children: t("btnCloseDetail")
                }
              ),
              /* @__PURE__ */ jsx("h2", { className: "lb-title", children: t("routineDetailTitle", {
                name: routineDetail?.routine?.name || selectedRoutineId
              }) })
            ] }) }),
            loadingHistory && /* @__PURE__ */ jsx("div", { className: "lb:p-8 lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("loadingBots") }),
            routineDetail && !loadingHistory && /* @__PURE__ */ jsxs("div", { className: "lb:space-y-5", children: [
              /* @__PURE__ */ jsxs("div", { className: "lb:p-4 lb:rounded-2xl lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:space-y-2", children: [
                /* @__PURE__ */ jsx("div", { className: "lb:text-[13px] lb:font-semibold lb:text-[var(--color-muted-foreground)]", children: t("instructionLabel") }),
                /* @__PURE__ */ jsx("div", { className: "lb-body lb:bg-[var(--background)] lb:p-3 lb:rounded-xl lb:whitespace-pre-wrap", children: routineDetail.detail?.instruction || "-" })
              ] }),
              isHistoryTruncated && /* @__PURE__ */ jsx(
                "div",
                {
                  role: "alert",
                  className: "lb:p-3 lb:rounded-xl lb:bg-[var(--color-warning)]/15 lb:border-[var(--color-warning)]/40 lb:text-[13px] lb:text-[var(--color-warning)]",
                  children: t("historyTruncatedWarning")
                }
              ),
              /* @__PURE__ */ jsxs("div", { className: "lb:space-y-3", children: [
                /* @__PURE__ */ jsx(
                  "h3",
                  {
                    "data-testid": "history-title",
                    className: "lb:text-[13px] lb:font-bold lb:text-[var(--color-foreground)]",
                    children: t("historyTitle", { count: historyRuns.length })
                  }
                ),
                /* @__PURE__ */ jsx("div", { className: "lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:overflow-hidden", children: /* @__PURE__ */ jsx("div", { className: "lb:overflow-x-auto", children: /* @__PURE__ */ jsxs("table", { className: "lb:w-full lb:text-left lb:border-collapse", children: [
                  /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { className: "lb:border-b lb:border-[var(--lb-separator)] lb:bg-[var(--color-muted)]/40 lb:text-xs lb:font-semibold lb:text-[var(--color-muted-foreground)]", children: [
                    /* @__PURE__ */ jsx("th", { className: "lb:py-2.5 lb:px-4", children: t("tableHeaderSession") }),
                    /* @__PURE__ */ jsx("th", { className: "lb:py-2.5 lb:px-4", children: t("tableHeaderStarted") }),
                    /* @__PURE__ */ jsx("th", { className: "lb:py-2.5 lb:px-4", children: t("tableHeaderDuration") }),
                    /* @__PURE__ */ jsx("th", { className: "lb:py-2.5 lb:px-4", children: t("tableHeaderStatus") }),
                    /* @__PURE__ */ jsx("th", { className: "lb:py-2.5 lb:px-4 lb:text-right", children: t("tableHeaderCost") })
                  ] }) }),
                  /* @__PURE__ */ jsx("tbody", { className: "lb:divide-y lb:divide-[var(--lb-separator)] lb:text-[13px]", children: historyRuns.length === 0 ? /* @__PURE__ */ jsx("tr", { children: /* @__PURE__ */ jsx(
                    "td",
                    {
                      colSpan: 5,
                      className: "lb:py-8 lb:px-4 lb:text-center lb:text-[var(--color-muted-foreground)]",
                      children: t("noRunsRecorded")
                    }
                  ) }) : historyRuns.map((run, idx) => /* @__PURE__ */ jsxs(
                    "tr",
                    {
                      "data-testid": `routine-run-row-${idx}`,
                      className: "lb:hover:bg-[var(--color-muted)]/20 lb:motion-safe:transition-colors",
                      children: [
                        /* @__PURE__ */ jsx("td", { className: "lb:py-2.5 lb:px-4 lb:font-mono lb:text-xs", children: run.session_id }),
                        /* @__PURE__ */ jsx("td", { className: "lb:py-2.5 lb:px-4 lb:text-xs", children: new Date(run.started_at).toLocaleString(
                          locale === "pt" ? "pt-BR" : "en-US"
                        ) }),
                        /* @__PURE__ */ jsx("td", { className: "lb:py-2.5 lb:px-4 lb:tabular-nums", children: run.duration_s !== void 0 ? `${run.duration_s}s` : "-" }),
                        /* @__PURE__ */ jsx("td", { className: "lb:py-2.5 lb:px-4", children: /* @__PURE__ */ jsx(
                          "span",
                          {
                            className: `lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-semibold ${run.status === "success" ? "lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)]" : run.status === "error" ? "lb:bg-[var(--color-destructive)]/15 lb:text-[var(--color-destructive)]" : "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]"}`,
                            children: routineRunStatusLabel(run.status, t)
                          }
                        ) }),
                        /* @__PURE__ */ jsx("td", { className: "lb:py-2.5 lb:px-4 lb:text-right lb:tabular-nums", children: formatCents(run.cost_cents || 0, locale) })
                      ]
                    },
                    idx
                  )) })
                ] }) }) })
              ] })
            ] })
          ] }) : (
            /* Routines List View */
            /* @__PURE__ */ jsxs("div", { className: "lb:p-4 lb:md:p-6 lb:space-y-4", children: [
              /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-wrap lb:items-center lb:gap-3 lb:p-3 lb:rounded-2xl lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)]", children: [
                bots.length > 0 && /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-1.5", children: [
                  /* @__PURE__ */ jsx("span", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("filterRoutinesBotLabel") }),
                  /* @__PURE__ */ jsxs(
                    "select",
                    {
                      value: filterBot,
                      onChange: (e) => setFilterBot(e.target.value),
                      className: "lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)]",
                      children: [
                        /* @__PURE__ */ jsx("option", { value: "", children: t("allBotsOption") }),
                        bots.map((b) => /* @__PURE__ */ jsx("option", { value: b.name, children: b.display?.label || b.name }, b.name))
                      ]
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-1.5", children: [
                  /* @__PURE__ */ jsx("span", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("filterRoutinesStateLabel") }),
                  /* @__PURE__ */ jsxs(
                    "select",
                    {
                      value: filterState,
                      onChange: (e) => setFilterState(e.target.value),
                      className: "lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)]",
                      children: [
                        /* @__PURE__ */ jsx("option", { value: "all", children: t("stateAll") }),
                        /* @__PURE__ */ jsx("option", { value: "scheduled", children: t("stateScheduled") }),
                        /* @__PURE__ */ jsx("option", { value: "paused", children: t("statePaused") })
                      ]
                    }
                  )
                ] })
              ] }),
              loading2 && !routines.length && /* @__PURE__ */ jsx("div", { className: "lb:p-8 lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("loadingBots") }),
              error && /* @__PURE__ */ jsx(
                "div",
                {
                  role: "alert",
                  className: "lb:p-4 lb:rounded-xl lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:text-[13px] lb:text-[var(--color-destructive)]",
                  children: /* @__PURE__ */ jsx(ErrorNote, { error })
                }
              ),
              /* @__PURE__ */ jsx("div", { className: "lb:space-y-3", children: filteredRoutines.length === 0 ? /* @__PURE__ */ jsxs(
                "div",
                {
                  "data-testid": "routines-empty-state",
                  className: "lb:p-8 lb:rounded-2xl lb:border-dashed lb:border-[var(--lb-separator)] lb:text-center lb:flex lb:flex-col lb:items-center lb:justify-center lb:gap-2 lb:bg-[var(--color-card)]/50",
                  children: [
                    /* @__PURE__ */ jsx(ClockIcon, { size: 24, className: "lb:text-[var(--color-muted-foreground)]" }),
                    /* @__PURE__ */ jsx("h3", { className: "lb-headline", children: t("noRoutinesFound") }),
                    /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:max-w-sm", children: t("routinesSubtitle") }),
                    /* @__PURE__ */ jsxs(
                      "button",
                      {
                        type: "button",
                        onClick: handleOpenCreateModal,
                        className: "lb:mt-2 lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:text-[13px] lb:font-medium lb:hover:opacity-90 lb:motion-safe:transition-opacity lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                        children: [
                          /* @__PURE__ */ jsx(PlusIcon, { size: 14 }),
                          /* @__PURE__ */ jsx("span", { children: t("createFirstRoutine") })
                        ]
                      }
                    )
                  ]
                }
              ) : filteredRoutines.map((routine) => {
                const isPaused = routine.state === "paused" || !routine.enabled;
                const isPausedByBudget = routine.paused_reason === "budget";
                const isPausedByUser = routine.paused_reason === "user";
                return /* @__PURE__ */ jsxs(
                  "div",
                  {
                    "data-testid": `routine-card-${routine.id}`,
                    className: "lb:p-4 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:space-y-3",
                    children: [
                      /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:sm:flex-row lb:sm:items-center lb:justify-between lb:gap-2", children: [
                        /* @__PURE__ */ jsxs("div", { className: "lb:space-y-1", children: [
                          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                            /* @__PURE__ */ jsx("span", { className: "lb-headline", children: routine.name }),
                            /* @__PURE__ */ jsxs("span", { className: "lb:inline-flex lb:items-center lb:gap-1.5 lb-caption lb:text-[var(--color-muted-foreground)]", children: [
                              /* @__PURE__ */ jsx(Avatar, { name: botLabel(routine.bot), avatar: botInfo(routine.bot)?.display?.avatar, color: botInfo(routine.bot)?.display?.color, size: 20 }),
                              botLabel(routine.bot)
                            ] }),
                            isPausedByBudget ? /* @__PURE__ */ jsx(
                              "span",
                              {
                                "data-testid": `badge-paused-budget-${routine.id}`,
                                className: "lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-destructive)]/20 lb:text-[var(--color-destructive)]",
                                children: t("pausedReasonBudget")
                              }
                            ) : isPausedByUser ? /* @__PURE__ */ jsx(
                              "span",
                              {
                                "data-testid": `badge-paused-user-${routine.id}`,
                                className: "lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-warning)]/20 lb:text-[var(--color-warning)]",
                                children: t("pausedReasonUser")
                              }
                            ) : /* @__PURE__ */ jsx(
                              "span",
                              {
                                "data-testid": `badge-scheduled-${routine.id}`,
                                className: "lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)]",
                                children: t("stateScheduled")
                              }
                            )
                          ] }),
                          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-wrap lb:items-center lb:gap-3 lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: [
                            /* @__PURE__ */ jsx("span", { children: t("scheduleLabel", { expr: routine.schedule.expr }) }),
                            /* @__PURE__ */ jsx("span", { children: "\u2022" }),
                            /* @__PURE__ */ jsx("span", { children: t("nextRunLabel", {
                              time: routine.next_run_at ? new Date(routine.next_run_at).toLocaleString(
                                locale === "pt" ? "pt-BR" : "en-US"
                              ) : t("noRunYet")
                            }) }),
                            routine.last_run_at && /* @__PURE__ */ jsxs(Fragment2, { children: [
                              /* @__PURE__ */ jsx("span", { children: "\u2022" }),
                              /* @__PURE__ */ jsx("span", { children: t("lastRunLabel", {
                                time: new Date(
                                  routine.last_run_at
                                ).toLocaleString(
                                  locale === "pt" ? "pt-BR" : "en-US"
                                )
                              }) })
                            ] })
                          ] })
                        ] }),
                        (routine.cap || routine.spend_cents) && /* @__PURE__ */ jsxs("div", { className: "lb:text-[13px] lb:tabular-nums lb:text-[var(--color-muted-foreground)] lb:text-right", children: [
                          routine.cap && /* @__PURE__ */ jsx("div", { children: t("routineCapLabel", {
                            cap: formatCents(routine.cap.cents, locale)
                          }) }),
                          routine.spend_cents !== void 0 && routine.spend_cents !== null && /* @__PURE__ */ jsx("div", { children: t("routineSpendLabel", {
                            spend: formatCents(
                              routine.spend_cents,
                              locale
                            )
                          }) })
                        ] })
                      ] }),
                      /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-wrap lb:items-center lb:justify-between lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]", children: [
                        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                          /* @__PURE__ */ jsxs(
                            "button",
                            {
                              type: "button",
                              "data-testid": `btn-test-routine-${routine.id}`,
                              disabled: isPaused,
                              onClick: () => setConfirmTestRoutine(routine),
                              title: isPaused ? t("testDisabledPausedRoutine") : t("btnTestRoutine"),
                              className: `lb:inline-flex lb:items-center lb:gap-1 lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${isPaused ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed" : "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90"}`,
                              children: [
                                /* @__PURE__ */ jsx(PlayIcon, { size: 11 }),
                                /* @__PURE__ */ jsx("span", { children: t("btnTestRoutine") })
                              ]
                            }
                          ),
                          isPaused ? /* @__PURE__ */ jsxs(
                            "button",
                            {
                              type: "button",
                              "data-testid": `btn-resume-routine-${routine.id}`,
                              onClick: () => setConfirmResumeRoutine(routine),
                              className: "lb:inline-flex lb:items-center lb:gap-1 lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:rounded-full",
                              children: [
                                /* @__PURE__ */ jsx(PlayIcon, { size: 11 }),
                                /* @__PURE__ */ jsx("span", { children: t("btnResumeRoutine") })
                              ]
                            }
                          ) : /* @__PURE__ */ jsxs(
                            "button",
                            {
                              type: "button",
                              "data-testid": `btn-pause-routine-${routine.id}`,
                              onClick: () => setConfirmPauseRoutine(routine),
                              className: "lb:inline-flex lb:items-center lb:gap-1 lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:rounded-full",
                              children: [
                                /* @__PURE__ */ jsx(PauseIcon, { size: 11 }),
                                /* @__PURE__ */ jsx("span", { children: t("btnPauseRoutine") })
                              ]
                            }
                          ),
                          /* @__PURE__ */ jsx(
                            "button",
                            {
                              type: "button",
                              "data-testid": `btn-history-routine-${routine.id}`,
                              onClick: () => loadRoutineDetailAndHistory(routine.id),
                              className: "lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:rounded-full",
                              children: t("btnViewHistory")
                            }
                          )
                        ] }),
                        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                          /* @__PURE__ */ jsx(
                            "button",
                            {
                              type: "button",
                              "data-testid": `btn-edit-routine-${routine.id}`,
                              onClick: () => handleOpenEditModal(routine),
                              className: "lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:rounded-full",
                              children: t("btnEditRoutine")
                            }
                          ),
                          /* @__PURE__ */ jsx(
                            "button",
                            {
                              type: "button",
                              "data-testid": `btn-duplicate-routine-${routine.id}`,
                              onClick: () => handleExecuteDuplicate(routine),
                              className: "lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:rounded-full",
                              children: t("btnDuplicateRoutine")
                            }
                          ),
                          /* @__PURE__ */ jsx(
                            "button",
                            {
                              type: "button",
                              "data-testid": `btn-delete-routine-${routine.id}`,
                              onClick: () => {
                                setConfirmDeleteRoutine(routine);
                                setDeleteTypedName("");
                              },
                              className: "lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-destructive)] lb:hover:bg-[var(--color-destructive)]/10 lb:rounded-full",
                              children: t("btnDeleteRoutine")
                            }
                          )
                        ] })
                      ] })
                    ]
                  },
                  routine.id
                );
              }) })
            ] })
          ),
          createModalOpen && /* @__PURE__ */ jsx(
            "div",
            {
              ref: formModalRef,
              role: "dialog",
              "aria-modal": "true",
              "aria-labelledby": "modal-routine-title",
              className: "lb-dialog-overlay",
              children: /* @__PURE__ */ jsxs(
                "div",
                {
                  "data-testid": "modal-routine-form",
                  className: "lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto",
                  children: [
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between", children: [
                      /* @__PURE__ */ jsx("h3", { id: "modal-routine-title", className: "lb-title", children: editRoutine ? t("modalEditRoutineTitle") : t("modalCreateRoutineTitle") }),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "aria-label": t("close"),
                          onClick: () => setCreateModalOpen(false),
                          className: "lb-icon-btn",
                          style: { background: "var(--lb-fill)" },
                          children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
                        }
                      )
                    ] }),
                    !editRoutine && /* @__PURE__ */ jsxs("div", { className: "lb:space-y-1", children: [
                      /* @__PURE__ */ jsx("label", { className: "lb:text-[13px] lb:font-medium", children: t("routineBotInput") }),
                      /* @__PURE__ */ jsx(
                        "select",
                        {
                          value: newBot,
                          onChange: (e) => setNewBot(e.target.value),
                          className: "lb-input",
                          children: bots.map((b) => /* @__PURE__ */ jsx("option", { value: b.name, children: b.display?.label || b.name }, b.name))
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsxs("div", { className: "lb:space-y-1", children: [
                      /* @__PURE__ */ jsx("label", { className: "lb:text-[13px] lb:font-medium", children: t("routineNameInput") }),
                      /* @__PURE__ */ jsx(
                        "input",
                        {
                          type: "text",
                          "data-testid": "input-routine-name",
                          placeholder: t("routineNamePlaceholder"),
                          value: newName,
                          onChange: (e) => setNewName(e.target.value),
                          className: "lb-input"
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsxs("div", { className: "lb:space-y-1", children: [
                      /* @__PURE__ */ jsx("label", { className: "lb:text-[13px] lb:font-medium", children: t("routineScheduleExprInput") }),
                      /* @__PURE__ */ jsx(
                        "input",
                        {
                          type: "text",
                          "data-testid": "input-routine-schedule",
                          placeholder: t("routineScheduleExprPlaceholder"),
                          value: newScheduleExpr,
                          onChange: (e) => setNewScheduleExpr(e.target.value),
                          className: "lb-input lb-mono"
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsxs("div", { className: "lb:space-y-1", children: [
                      /* @__PURE__ */ jsx("label", { className: "lb:text-[13px] lb:font-medium", children: t("routinePromptInput") }),
                      /* @__PURE__ */ jsx(
                        "textarea",
                        {
                          rows: 3,
                          "data-testid": "input-routine-prompt",
                          placeholder: t("routinePromptPlaceholder"),
                          value: newPrompt,
                          onChange: (e) => setNewPrompt(e.target.value),
                          className: "lb-input"
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]", children: [
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          onClick: () => setCreateModalOpen(false),
                          className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:rounded-full",
                          children: t("cancelBtn")
                        }
                      ),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "data-testid": "btn-save-routine",
                          disabled: isSubmitting || !newName.trim(),
                          onClick: handleSaveRoutine,
                          className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 disabled:lb:opacity-50 lb:rounded-full",
                          children: isSubmitting ? t("loadingBots") : t("btnSaveRoutine")
                        }
                      )
                    ] })
                  ]
                }
              )
            }
          ),
          confirmTestRoutine && /* @__PURE__ */ jsx(
            "div",
            {
              ref: testModalRef,
              role: "dialog",
              "aria-modal": "true",
              "aria-labelledby": "modal-test-title",
              className: "lb-dialog-overlay",
              children: /* @__PURE__ */ jsxs(
                "div",
                {
                  "data-testid": "modal-confirm-test",
                  className: "lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto",
                  children: [
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between", children: [
                      /* @__PURE__ */ jsx("h3", { id: "modal-test-title", className: "lb-title", children: t("modalConfirmTestTitle") }),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "aria-label": t("close"),
                          onClick: () => setConfirmTestRoutine(null),
                          className: "lb-icon-btn",
                          style: { background: "var(--lb-fill)" },
                          children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("modalConfirmTestBody", { name: confirmTestRoutine.name }) }),
                    /* @__PURE__ */ jsx("div", { className: "lb:p-2.5 lb:rounded-lg lb:bg-[var(--color-warning)]/15 lb:border-[var(--color-warning)]/40 lb:text-[13px] lb:text-[var(--color-warning)]", children: t("testWarningRealWork") }),
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]", children: [
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          onClick: () => setConfirmTestRoutine(null),
                          className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                          children: t("cancelBtn")
                        }
                      ),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "data-testid": "btn-confirm-test",
                          disabled: isSubmitting,
                          onClick: handleExecuteTest,
                          className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                          children: isSubmitting ? t("loadingBots") : t("btnConfirmTest")
                        }
                      )
                    ] })
                  ]
                }
              )
            }
          ),
          confirmPauseRoutine && /* @__PURE__ */ jsx(
            "div",
            {
              ref: pauseModalRef,
              role: "dialog",
              "aria-modal": "true",
              "aria-labelledby": "modal-pause-title",
              className: "lb-dialog-overlay",
              children: /* @__PURE__ */ jsxs(
                "div",
                {
                  "data-testid": "modal-confirm-pause",
                  className: "lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto",
                  children: [
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between", children: [
                      /* @__PURE__ */ jsx("h3", { id: "modal-pause-title", className: "lb-title", children: t("modalConfirmPauseTitle") }),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "aria-label": t("close"),
                          onClick: () => setConfirmPauseRoutine(null),
                          className: "lb-icon-btn",
                          style: { background: "var(--lb-fill)" },
                          children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("modalConfirmPauseBody", { name: confirmPauseRoutine.name }) }),
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]", children: [
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          onClick: () => setConfirmPauseRoutine(null),
                          className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                          children: t("cancelBtn")
                        }
                      ),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "data-testid": "btn-confirm-pause",
                          disabled: isSubmitting,
                          onClick: handleExecutePause,
                          className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-warning)] lb:text-[var(--color-foreground)] lb:hover:opacity-90 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-warning)] focus-visible:lb:outline-none lb:rounded-full",
                          children: isSubmitting ? t("loadingBots") : t("btnConfirmPause")
                        }
                      )
                    ] })
                  ]
                }
              )
            }
          ),
          confirmResumeRoutine && /* @__PURE__ */ jsx(
            "div",
            {
              ref: resumeModalRef,
              role: "dialog",
              "aria-modal": "true",
              "aria-labelledby": "modal-resume-title",
              className: "lb-dialog-overlay",
              children: /* @__PURE__ */ jsxs(
                "div",
                {
                  "data-testid": "modal-confirm-resume",
                  className: "lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto",
                  children: [
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between", children: [
                      /* @__PURE__ */ jsx("h3", { id: "modal-resume-title", className: "lb-title", children: t("modalConfirmResumeTitle") }),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "aria-label": t("close"),
                          onClick: () => setConfirmResumeRoutine(null),
                          className: "lb-icon-btn",
                          style: { background: "var(--lb-fill)" },
                          children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("modalConfirmResumeBody", { name: confirmResumeRoutine.name }) }),
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]", children: [
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          onClick: () => setConfirmResumeRoutine(null),
                          className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                          children: t("cancelBtn")
                        }
                      ),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "data-testid": "btn-confirm-resume-routine",
                          disabled: isSubmitting,
                          onClick: handleExecuteResume,
                          className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                          children: isSubmitting ? t("loadingBots") : t("btnConfirmResumeRoutine")
                        }
                      )
                    ] })
                  ]
                }
              )
            }
          ),
          confirmDeleteRoutine && /* @__PURE__ */ jsx(
            "div",
            {
              ref: deleteModalRef,
              role: "dialog",
              "aria-modal": "true",
              "aria-labelledby": "modal-delete-title",
              className: "lb-dialog-overlay",
              children: /* @__PURE__ */ jsxs(
                "div",
                {
                  "data-testid": "modal-confirm-delete",
                  className: "lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto",
                  children: [
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between", children: [
                      /* @__PURE__ */ jsx("h3", { id: "modal-delete-title", className: "lb-title", children: t("modalConfirmDeleteTitle") }),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "aria-label": t("close"),
                          onClick: () => setConfirmDeleteRoutine(null),
                          className: "lb-icon-btn",
                          style: { background: "var(--lb-fill)" },
                          children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("modalConfirmDeleteBody", { name: confirmDeleteRoutine.name }) }),
                    /* @__PURE__ */ jsx(
                      "input",
                      {
                        type: "text",
                        "data-testid": "input-delete-confirm-name",
                        placeholder: t("deleteRoutineInputPlaceholder"),
                        value: deleteTypedName,
                        onChange: (e) => setDeleteTypedName(e.target.value),
                        className: "lb-input"
                      }
                    ),
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]", children: [
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          onClick: () => setConfirmDeleteRoutine(null),
                          className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                          children: t("cancelBtn")
                        }
                      ),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "data-testid": "btn-confirm-delete",
                          disabled: isSubmitting || deleteTypedName.trim() !== confirmDeleteRoutine.name,
                          onClick: handleExecuteDelete,
                          className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-destructive)] lb:text-white hover:lb:opacity-90 disabled:lb:opacity-50 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)] focus-visible:lb:outline-none lb:rounded-full",
                          children: isSubmitting ? t("loadingBots") : t("btnConfirmDelete")
                        }
                      )
                    ] })
                  ]
                }
              )
            }
          )
        ]
      }
    );
  }

  // dashboard/src/api/types.ts
  var HERMES_KANBAN_COLUMNS = [
    "triage",
    "todo",
    "scheduled",
    "ready",
    "running",
    "blocked",
    "review",
    "done"
  ];

  // dashboard/src/components/activity/ActivityView.tsx
  function mapActivityItemToKanbanColumn(item2) {
    if (item2.column && HERMES_KANBAN_COLUMNS.includes(item2.column)) {
      return item2.column;
    }
    switch (item2.status) {
      case "running":
        return "running";
      case "waiting_approval":
        return "review";
      case "scheduled":
        return item2.kind === "routine_due" ? "scheduled" : "ready";
      case "done":
        return "done";
      case "stopped":
        return "done";
      case "error":
      case "blocked":
        return "blocked";
      default:
        return "todo";
    }
  }
  function ActivityView({
    bots = [],
    initialItems,
    onRefresh,
    onOpenConversation,
    initialView = "list"
  }) {
    const { locale, t } = useLuveI18n();
    const botInfo = (name) => bots.find((b) => b.name === name);
    const botLabel = (name) => botInfo(name)?.display?.label || name;
    const [tab, setTab] = useState("running");
    const [viewMode, setViewMode] = useState(initialView);
    const [selectedBot, setSelectedBot] = useState("all");
    const [selectedOrigin, setSelectedOrigin] = useState("all");
    const [selectedStatus, setSelectedStatus] = useState("all");
    const [searchQuery, setSearchQuery] = useState("");
    const [minCost, setMinCost] = useState("");
    const [items, setItems] = useState(initialItems || []);
    const [loading2, setLoading] = useState(!initialItems);
    const [error, setError] = useState(null);
    const [partialSources, setPartialSources] = useState(null);
    const [nextCursor, setNextCursor] = useState(null);
    const [stoppingIds, setStoppingIds] = useState({});
    const [stopModalItem, setStopModalItem] = useState(null);
    const [stopReason, setStopReason] = useState("");
    const [submittingStop, setSubmittingStop] = useState(false);
    const [redirectModalItem, setRedirectModalItem] = useState(null);
    const [redirectBot, setRedirectBot] = useState(bots[0]?.name || "");
    const [redirectReason, setRedirectReason] = useState("");
    const [submittingRedirect, setSubmittingRedirect] = useState(false);
    const [contextModalItem, setContextModalItem] = useState(null);
    const [contextKind, setContextKind] = useState("context");
    const [contextText, setContextText] = useState("");
    const [submittingContext, setSubmittingContext] = useState(false);
    const stopModalRef = useFocusTrap({
      isOpen: !!stopModalItem,
      onClose: () => setStopModalItem(null)
    });
    const redirectModalRef = useFocusTrap({
      isOpen: !!redirectModalItem,
      onClose: () => setRedirectModalItem(null)
    });
    const contextModalRef = useFocusTrap({
      isOpen: !!contextModalItem,
      onClose: () => setContextModalItem(null)
    });
    const [toastMessage, setToastMessage] = useState(null);
    const showToast = useCallback((msg) => {
      setToastMessage(msg);
      setTimeout(() => setToastMessage(null), 3500);
    }, []);
    const loadActivity = useCallback(async () => {
      setLoading(true);
      setError(null);
      try {
        const params = {
          tab,
          bot: selectedBot !== "all" ? selectedBot : void 0,
          origin: selectedOrigin !== "all" ? selectedOrigin : void 0,
          status: selectedStatus !== "all" ? selectedStatus : void 0,
          min_cost_cents: minCost ? parseInt(minCost, 10) : void 0
        };
        const res = await getActivity(params);
        setItems(res.items || []);
        setNextCursor(res.next_cursor || null);
        setPartialSources(res.partial && res.partial.length > 0 ? res.partial : null);
      } catch (err) {
        setError(humanError(err, t, "errorLoadingActivity"));
      } finally {
        setLoading(false);
      }
    }, [tab, selectedBot, selectedOrigin, selectedStatus, minCost, t]);
    useEffect(() => {
      if (initialItems) {
        setItems(initialItems);
      } else {
        void loadActivity();
      }
    }, [loadActivity, initialItems]);
    const handleRefresh = useCallback(() => {
      void loadActivity();
      if (onRefresh) onRefresh();
    }, [loadActivity, onRefresh]);
    const filteredItems = useMemo(() => {
      return items.filter((item2) => {
        if (selectedBot !== "all" && item2.bot !== selectedBot) return false;
        if (selectedOrigin !== "all" && item2.origin !== selectedOrigin) return false;
        if (selectedStatus !== "all" && item2.status !== selectedStatus) return false;
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const matchTitle = activityTitle(item2, t).toLowerCase().includes(q);
          const matchId = item2.id.toLowerCase().includes(q);
          const matchBot = item2.bot.toLowerCase().includes(q);
          if (!matchTitle && !matchId && !matchBot) return false;
        }
        return true;
      });
    }, [items, selectedBot, selectedOrigin, selectedStatus, searchQuery]);
    const handleConfirmStop = async () => {
      if (!stopModalItem) return;
      setSubmittingStop(true);
      try {
        await stopActivity(stopModalItem.id, {
          reason: stopReason.trim() || void 0
        });
        setStoppingIds((prev) => ({ ...prev, [stopModalItem.id]: true }));
        showToast(t("activityStopSuccess"));
        setStopModalItem(null);
        setStopReason("");
      } catch (err) {
        showToast(humanError(err, t, "errorStoppingActivity").text);
      } finally {
        setSubmittingStop(false);
      }
    };
    const handleConfirmRedirect = async () => {
      if (!redirectModalItem || !redirectBot) return;
      setSubmittingRedirect(true);
      try {
        await redirectActivity(redirectModalItem.id, {
          bot: redirectBot,
          reason: redirectReason.trim() || void 0
        });
        showToast(t("activityRedirectSuccess"));
        setRedirectModalItem(null);
        setRedirectReason("");
        void loadActivity();
      } catch (err) {
        showToast(humanError(err, t, "errorRedirectingActivity").text);
      } finally {
        setSubmittingRedirect(false);
      }
    };
    const handleConfirmContext = async () => {
      if (!contextModalItem || !contextText.trim()) return;
      setSubmittingContext(true);
      try {
        await addActivityContext(contextModalItem.id, {
          text: contextText.trim(),
          kind: contextKind
        });
        showToast(t("activityContextSuccess"));
        setContextModalItem(null);
        setContextText("");
        void loadActivity();
      } catch (err) {
        showToast(humanError(err, t, "errorAddingContext").text);
      } finally {
        setSubmittingContext(false);
      }
    };
    const getOriginLabel = (origin) => {
      switch (origin) {
        case "message":
          return t("filterOriginMessage");
        case "routine":
          return t("filterOriginRoutine");
        case "webhook":
          return t("filterOriginWebhook");
        case "handoff":
          return t("filterOriginHandoff");
        default:
          return origin;
      }
    };
    const getStatusLabel = (status) => {
      switch (status) {
        case "running":
          return t("filterStatusRunning");
        case "waiting_approval":
          return t("filterStatusWaitingApproval");
        case "scheduled":
          return t("filterStatusScheduled");
        case "done":
          return t("filterStatusDone");
        case "error":
          return t("filterStatusError");
        case "stopped":
          return t("filterStatusStopped");
        case "blocked":
          return t("filterStatusBlocked");
        default:
          return status;
      }
    };
    const getKanbanColumnTitle = (col) => {
      switch (col) {
        case "triage":
          return t("kanbanColTriage");
        case "todo":
          return t("kanbanColTodo");
        case "scheduled":
          return t("kanbanColScheduled");
        case "ready":
          return t("kanbanColReady");
        case "running":
          return t("kanbanColRunning");
        case "blocked":
          return t("kanbanColBlocked");
        case "review":
          return t("kanbanColReview");
        case "done":
          return t("kanbanColDone");
      }
    };
    const kanbanColumnsData = useMemo(() => {
      const cols = {
        triage: [],
        todo: [],
        scheduled: [],
        ready: [],
        running: [],
        blocked: [],
        review: [],
        done: []
      };
      for (const item2 of filteredItems) {
        const col = mapActivityItemToKanbanColumn(item2);
        cols[col].push(item2);
      }
      return cols;
    }, [filteredItems]);
    return /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:h-full lb:w-full lb:overflow-hidden lb:bg-[var(--background)] lb:text-[var(--color-foreground)]", children: [
      /* @__PURE__ */ jsxs("div", { className: "lb:border-b lb:border-[var(--lb-separator)] lb:p-3 lb:md:p-4 lb:flex lb:flex-wrap lb:items-center lb:justify-between lb:gap-3 lb:shrink-0", children: [
        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-3", children: [
          /* @__PURE__ */ jsx(ClockIcon, { size: 18, className: "lb:text-[var(--color-primary)]" }),
          /* @__PURE__ */ jsx("h1", { className: "lb-large-title", children: t("activityHeaderTitle") }),
          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-1 lb:bg-[var(--color-muted)]/50 lb:p-0.5 lb:rounded-xl lb:border-[var(--lb-separator)]", children: [
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                "data-testid": "tab-running",
                onClick: () => setTab("running"),
                className: `lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${tab === "running" ? "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)]" : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"}`,
                children: t("tabRunning")
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                "data-testid": "tab-scheduled",
                onClick: () => setTab("scheduled"),
                className: `lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${tab === "scheduled" ? "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)]" : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"}`,
                children: t("tabScheduled")
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                "data-testid": "tab-done",
                onClick: () => setTab("done"),
                className: `lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${tab === "done" ? "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)]" : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"}`,
                children: t("tabDone")
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:bg-[var(--color-muted)]/50 lb:p-0.5 lb:rounded-xl lb:border-[var(--lb-separator)]", children: [
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                "data-testid": "toggle-view-list",
                onClick: () => setViewMode("list"),
                className: `lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${viewMode === "list" ? "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)]" : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"}`,
                children: t("viewList")
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                "data-testid": "toggle-view-kanban",
                onClick: () => setViewMode("kanban"),
                className: `lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${viewMode === "kanban" ? "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)]" : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"}`,
                children: t("viewKanban")
              }
            )
          ] }),
          /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              "data-testid": "btn-refresh-activity",
              onClick: handleRefresh,
              "aria-label": t("activityRefreshBtn"),
              className: "lb:flex lb:items-center lb:gap-1.5 lb:px-2.5 lb:py-1 lb:border-[var(--lb-separator)] lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:hover:bg-[var(--color-muted)]/50 lb:motion-safe:transition-colors lb:rounded-full",
              children: [
                /* @__PURE__ */ jsx(RefreshCwIcon, { size: 13 }),
                /* @__PURE__ */ jsx("span", { children: t("activityRefreshBtn") })
              ]
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "lb:border-b lb:border-[var(--lb-separator)] lb:px-3 lb:py-2 lb:md:px-4 lb:flex lb:flex-wrap lb:items-center lb:gap-2 lb:bg-[var(--color-muted)]/20 lb:text-[13px] lb:shrink-0", children: [
        /* @__PURE__ */ jsx(FilterIcon, { size: 13, className: "lb:text-[var(--color-muted-foreground)]" }),
        /* @__PURE__ */ jsxs(
          "select",
          {
            "data-testid": "filter-bot",
            "aria-label": t("filterAllBots"),
            value: selectedBot,
            onChange: (e) => setSelectedBot(e.target.value),
            className: "lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:ring-1 focus:lb:ring-[var(--color-primary)]",
            children: [
              /* @__PURE__ */ jsx("option", { value: "all", children: t("filterAllBots") }),
              bots.map((b) => /* @__PURE__ */ jsx("option", { value: b.name, children: b.display?.label || b.name }, b.name))
            ]
          }
        ),
        /* @__PURE__ */ jsxs(
          "select",
          {
            "data-testid": "filter-origin",
            "aria-label": t("filterAllOrigins"),
            value: selectedOrigin,
            onChange: (e) => setSelectedOrigin(e.target.value),
            className: "lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:ring-1 focus:lb:ring-[var(--color-primary)]",
            children: [
              /* @__PURE__ */ jsx("option", { value: "all", children: t("filterAllOrigins") }),
              /* @__PURE__ */ jsx("option", { value: "message", children: t("filterOriginMessage") }),
              /* @__PURE__ */ jsx("option", { value: "routine", children: t("filterOriginRoutine") }),
              /* @__PURE__ */ jsx("option", { value: "webhook", children: t("filterOriginWebhook") }),
              /* @__PURE__ */ jsx("option", { value: "handoff", children: t("filterOriginHandoff") })
            ]
          }
        ),
        /* @__PURE__ */ jsxs(
          "select",
          {
            "data-testid": "filter-status",
            "aria-label": t("filterAllStatuses"),
            value: selectedStatus,
            onChange: (e) => setSelectedStatus(e.target.value),
            className: "lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:ring-1 focus:lb:ring-[var(--color-primary)]",
            children: [
              /* @__PURE__ */ jsx("option", { value: "all", children: t("filterAllStatuses") }),
              /* @__PURE__ */ jsx("option", { value: "running", children: t("filterStatusRunning") }),
              /* @__PURE__ */ jsx("option", { value: "waiting_approval", children: t("filterStatusWaitingApproval") }),
              /* @__PURE__ */ jsx("option", { value: "scheduled", children: t("filterStatusScheduled") }),
              /* @__PURE__ */ jsx("option", { value: "done", children: t("filterStatusDone") }),
              /* @__PURE__ */ jsx("option", { value: "error", children: t("filterStatusError") }),
              /* @__PURE__ */ jsx("option", { value: "stopped", children: t("filterStatusStopped") }),
              /* @__PURE__ */ jsx("option", { value: "blocked", children: t("filterStatusBlocked") })
            ]
          }
        ),
        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-1 lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-0.5 lb:grow lb:max-w-xs", children: [
          /* @__PURE__ */ jsx(SearchIcon, { size: 12, className: "lb:text-[var(--color-muted-foreground)]" }),
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "text",
              "data-testid": "input-search-activity",
              "aria-label": t("activitySearchPlaceholder"),
              placeholder: t("activitySearchPlaceholder"),
              value: searchQuery,
              onChange: (e) => setSearchQuery(e.target.value),
              className: "lb:bg-transparent lb:w-full lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none"
            }
          ),
          searchQuery && /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              "aria-label": t("closePanelBtn"),
              onClick: () => setSearchQuery(""),
              className: "lb:text-[var(--color-muted-foreground)] hover:lb:text-[var(--color-foreground)]",
              children: /* @__PURE__ */ jsx(XIcon, { size: 12 })
            }
          )
        ] }),
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "number",
            "data-testid": "input-min-cost",
            "aria-label": t("activityMinCostPlaceholder"),
            placeholder: t("activityMinCostPlaceholder"),
            value: minCost,
            onChange: (e) => setMinCost(e.target.value),
            className: "lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:w-44 lb:text-[var(--color-foreground)] focus:lb:outline-none"
          }
        )
      ] }),
      partialSources && partialSources.length > 0 && /* @__PURE__ */ jsxs(
        "div",
        {
          role: "alert",
          className: "lb:bg-[var(--color-warning)]/15 lb:border-b lb:border-[var(--color-warning)]/30 lb:px-4 lb:py-2 lb:flex lb:items-center lb:gap-2 lb:text-[13px] lb:text-[var(--color-warning)] lb:shrink-0",
          children: [
            /* @__PURE__ */ jsx(ShieldAlertIcon, { size: 14 }),
            /* @__PURE__ */ jsx("span", { children: t("activityPartialWarning", { sources: partialSources.join(", ") }) })
          ]
        }
      ),
      toastMessage && /* @__PURE__ */ jsx(
        "div",
        {
          role: "status",
          className: "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:px-3 lb:py-1.5 lb:rounded-xl lb:text-[13px] lb:shadow-lg lb:fixed lb:bottom-4 lb:right-4 lb:z-50 lb:motion-safe:animate-in lb:fade-in",
          children: toastMessage
        }
      ),
      error && /* @__PURE__ */ jsxs("div", { className: "lb:p-4 lb:bg-[var(--color-destructive)]/15 lb:border-b lb:border-[var(--color-destructive)]/30 lb:text-[13px] lb:text-[var(--color-destructive)] lb:flex lb:items-center lb:justify-between", children: [
        /* @__PURE__ */ jsx("span", { children: /* @__PURE__ */ jsx(ErrorNote, { error }) }),
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            onClick: handleRefresh,
            className: "lb:underline lb:font-medium hover:lb:opacity-80",
            children: t("retry")
          }
        )
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "lb:flex-1 lb:overflow-hidden lb:relative", children: [
        loading2 && /* @__PURE__ */ jsx("div", { className: "lb:absolute lb:inset-0 lb:bg-[var(--background)]/60 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:z-10", children: /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2 lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: [
          /* @__PURE__ */ jsx(RefreshCwIcon, { size: 14, className: "lb:motion-safe:animate-spin" }),
          /* @__PURE__ */ jsx("span", { children: t("loadingBots") })
        ] }) }),
        filteredItems.length === 0 && !loading2 ? /* @__PURE__ */ jsxs(
          "div",
          {
            "data-testid": "activity-empty-state",
            className: "lb:h-full lb:flex lb:flex-col lb:items-center lb:justify-center lb:p-8 lb:text-center",
            children: [
              /* @__PURE__ */ jsx(ClockIcon, { size: 32, className: "lb:text-[var(--color-muted-foreground)] lb:mb-2 lb:opacity-40" }),
              /* @__PURE__ */ jsx("h3", { className: "lb:text-[15px] lb:font-medium lb:text-[var(--color-card-foreground)]", children: t("noActivityFound") }),
              /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:max-w-md lb:mt-1", children: t("inProgressEmptyNextStep") }),
              (selectedBot !== "all" || selectedOrigin !== "all" || selectedStatus !== "all" || searchQuery || minCost) && /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: () => {
                    setSelectedBot("all");
                    setSelectedOrigin("all");
                    setSelectedStatus("all");
                    setSearchQuery("");
                    setMinCost("");
                  },
                  className: "lb:mt-3 lb:px-3 lb:py-1.5 lb:bg-[var(--lb-fill)] lb:text-[var(--color-secondary-foreground)] lb:text-[13px] lb:font-medium lb:hover:bg-[var(--lb-fill-2)] lb:border-[var(--lb-separator)] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                  children: t("clearSearch")
                }
              )
            ]
          }
        ) : viewMode === "list" ? (
          /* List View */
          /* @__PURE__ */ jsx("div", { className: "lb:h-full lb:overflow-y-auto lb:p-3 lb:md:p-4 lb:space-y-2", children: filteredItems.map((item2) => {
            const isStoppable = item2.status === "running" || item2.status === "waiting_approval";
            const isStopping = Boolean(stoppingIds[item2.id]);
            return /* @__PURE__ */ jsxs(
              "div",
              {
                "data-testid": `activity-item-${item2.id}`,
                className: "lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:rounded-2xl lb:p-3 lb:hover:border-[var(--color-primary)]/40 lb:motion-safe:transition-colors lb:flex lb:flex-col lb:gap-2",
                children: [
                  /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-start lb:justify-between lb:gap-3", children: [
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2 lb:flex-wrap", children: [
                      /* @__PURE__ */ jsxs("span", { className: "lb:inline-flex lb:items-center lb:gap-2", children: [
                        /* @__PURE__ */ jsx(Avatar, { name: botLabel(item2.bot), avatar: botInfo(item2.bot)?.display?.avatar, color: botInfo(item2.bot)?.display?.color, size: 24 }),
                        /* @__PURE__ */ jsx("span", { className: "lb-headline", children: botLabel(item2.bot) })
                      ] }),
                      /* @__PURE__ */ jsx("span", { className: "lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:text-xs lb:bg-[var(--color-muted)]/70 lb:text-[var(--color-muted-foreground)]", children: getOriginLabel(item2.origin) }),
                      /* @__PURE__ */ jsx(
                        "span",
                        {
                          className: `lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-medium ${item2.status === "running" ? "lb:bg-[var(--color-primary)]/20 lb:text-[var(--color-primary)]" : item2.status === "waiting_approval" ? "lb:bg-[var(--color-warning)]/20 lb:text-[var(--color-warning)]" : item2.status === "done" ? "lb:bg-[var(--color-success,var(--color-primary))]/20 lb:text-[var(--color-foreground)]" : item2.status === "error" || item2.status === "blocked" ? "lb:bg-[var(--color-destructive)]/20 lb:text-[var(--color-destructive)]" : "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]"}`,
                          children: getStatusLabel(item2.status)
                        }
                      ),
                      item2.checkpoint && /* @__PURE__ */ jsx("span", { className: "lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:text-xs lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]", children: t("activityCheckpointBadge", {
                        done: item2.checkpoint.done,
                        total: item2.checkpoint.total,
                        review: item2.checkpoint.to_review
                      }) })
                    ] }),
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2 lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:shrink-0", children: [
                      item2.duration_s !== null && item2.duration_s !== void 0 && /* @__PURE__ */ jsx("span", { children: t("activityDurationLabel", { seconds: item2.duration_s }) }),
                      item2.cost_cents !== null && item2.cost_cents !== void 0 && /* @__PURE__ */ jsx("span", { className: "lb:text-[var(--color-foreground)]", style: { fontVariantNumeric: "tabular-nums" }, children: t("activityCostLabel", { cost: formatCents(item2.cost_cents, locale) }) })
                    ] })
                  ] }),
                  /* @__PURE__ */ jsx(
                    "div",
                    {
                      "data-testid": `activity-title-${item2.id}`,
                      className: "lb:text-[13px] lb:font-medium lb:text-[var(--color-foreground)] lb:break-words",
                      children: /* @__PURE__ */ jsx(Markdown, { text: activityTitle(item2, t) })
                    }
                  ),
                  /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:gap-2 lb:pt-1 lb:border-t lb:border-[var(--color-border)]/40 lb:mt-1", children: [
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                      item2.kind === "task" && /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "data-testid": `btn-context-${item2.id}`,
                          onClick: () => {
                            setContextModalItem(item2);
                            setContextKind("context");
                            setContextText("");
                          },
                          className: "lb:text-[13px] lb:px-2 lb:py-0.5 lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:hover:bg-[var(--color-muted)]/50 lb:motion-safe:transition-colors lb:rounded-full",
                          children: t("activityBtnContext")
                        }
                      ),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "data-testid": `btn-redirect-${item2.id}`,
                          onClick: () => {
                            setRedirectModalItem(item2);
                            setRedirectBot(bots[0]?.name || "");
                            setRedirectReason("");
                          },
                          className: "lb:text-[13px] lb:px-2 lb:py-0.5 lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:hover:bg-[var(--color-muted)]/50 lb:motion-safe:transition-colors lb:rounded-full",
                          children: t("activityBtnRedirect")
                        }
                      ),
                      isStoppable ? /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "data-testid": `btn-stop-${item2.id}`,
                          disabled: isStopping,
                          onClick: () => {
                            setStopModalItem(item2);
                            setStopReason("");
                          },
                          className: "lb:text-[13px] lb:px-2 lb:py-0.5 lb:border-[var(--color-destructive)] lb:text-[var(--color-destructive)] lb:hover:bg-[var(--color-destructive)]/10 lb:disabled:opacity-50 lb:motion-safe:transition-colors lb:rounded-full",
                          children: isStopping ? t("activityBtnStopping") : t("activityBtnStop")
                        }
                      ) : null
                    ] }),
                    onOpenConversation && /* @__PURE__ */ jsx(
                      "button",
                      {
                        type: "button",
                        onClick: () => onOpenConversation(item2.bot),
                        className: "lb:text-[13px] lb:text-[var(--color-primary)] lb:underline lb:hover:no-underline lb:min-h-11 lb:md:min-h-6 lb:flex lb:items-center focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none",
                        children: t("activityBtnConversation")
                      }
                    )
                  ] })
                ]
              },
              item2.id
            );
          }) })
        ) : (
          /* Kanban View: Exactly the 8 Hermes Kanban columns */
          /* @__PURE__ */ jsx(
            "div",
            {
              "data-testid": "kanban-board",
              className: "lb:h-full lb:overflow-x-auto lb:flex lb:gap-3 lb:p-3 lb:md:p-4",
              children: HERMES_KANBAN_COLUMNS.map((colKey) => {
                const colItems = kanbanColumnsData[colKey];
                return /* @__PURE__ */ jsxs(
                  "div",
                  {
                    "data-testid": `kanban-col-${colKey}`,
                    className: "lb:w-72 lb:shrink-0 lb:flex lb:flex-col lb:bg-[var(--color-muted)]/30 lb:border-[var(--lb-separator)] lb:rounded-2xl lb:overflow-hidden",
                    children: [
                      /* @__PURE__ */ jsxs("div", { className: "lb:p-2.5 lb:border-b lb:border-[var(--lb-separator)] lb:bg-[var(--color-muted)]/50 lb:flex lb:items-center lb:justify-between", children: [
                        /* @__PURE__ */ jsx("span", { className: "lb:text-[13px] lb:font-semibold lb:text-[var(--color-foreground)]", children: getKanbanColumnTitle(colKey) }),
                        /* @__PURE__ */ jsx("span", { className: "lb:text-xs lb:font-mono lb:px-1.5 lb:py-0.2 lb:rounded-full lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]", children: colItems.length })
                      ] }),
                      /* @__PURE__ */ jsx("div", { className: "lb:flex-1 lb:overflow-y-auto lb:p-2 lb:space-y-2", children: colItems.map((item2) => {
                        const isStoppable = item2.status === "running" || item2.status === "waiting_approval";
                        const isStopping = Boolean(stoppingIds[item2.id]);
                        return /* @__PURE__ */ jsxs(
                          "div",
                          {
                            "data-testid": `kanban-card-${item2.id}`,
                            className: "lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:p-2.5 lb:space-y-1.5 lb:hover:border-[var(--color-primary)]/40 lb:motion-safe:transition-colors",
                            children: [
                              /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:gap-1.5", children: [
                                /* @__PURE__ */ jsxs("span", { className: "lb:inline-flex lb:items-center lb:gap-1.5 lb:text-xs lb:font-semibold", children: [
                                  /* @__PURE__ */ jsx(Avatar, { name: botLabel(item2.bot), avatar: botInfo(item2.bot)?.display?.avatar, color: botInfo(item2.bot)?.display?.color, size: 20 }),
                                  botLabel(item2.bot)
                                ] }),
                                /* @__PURE__ */ jsx("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)]", children: getOriginLabel(item2.origin) })
                              ] }),
                              /* @__PURE__ */ jsx(
                                "div",
                                {
                                  "data-testid": `kanban-card-title-${item2.id}`,
                                  className: "lb:text-[13px] lb:text-[var(--color-foreground)] lb:break-words",
                                  children: /* @__PURE__ */ jsx(Markdown, { text: activityTitle(item2, t) })
                                }
                              ),
                              /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:pt-1 lb:border-t lb:border-[var(--color-border)]/40 lb:text-xs", children: [
                                item2.kind === "task" ? /* @__PURE__ */ jsx(
                                  "button",
                                  {
                                    type: "button",
                                    "data-testid": `kanban-btn-context-${item2.id}`,
                                    onClick: () => {
                                      setContextModalItem(item2);
                                      setContextKind("context");
                                      setContextText("");
                                    },
                                    className: "lb:text-[var(--color-muted-foreground)] hover:lb:text-[var(--color-foreground)]",
                                    children: t("activityBtnContext")
                                  }
                                ) : /* @__PURE__ */ jsx("span", {}),
                                /* @__PURE__ */ jsx(
                                  "button",
                                  {
                                    type: "button",
                                    onClick: () => {
                                      setRedirectModalItem(item2);
                                      setRedirectBot(bots[0]?.name || "");
                                      setRedirectReason("");
                                    },
                                    className: "lb:text-[var(--color-muted-foreground)] hover:lb:text-[var(--color-foreground)]",
                                    children: t("activityBtnRedirect")
                                  }
                                ),
                                isStoppable ? /* @__PURE__ */ jsx(
                                  "button",
                                  {
                                    type: "button",
                                    "data-testid": `kanban-btn-stop-${item2.id}`,
                                    disabled: isStopping,
                                    onClick: () => {
                                      setStopModalItem(item2);
                                      setStopReason("");
                                    },
                                    className: "lb:text-[var(--color-destructive)] hover:lb:underline lb:disabled:opacity-50",
                                    children: isStopping ? t("activityBtnStopping") : t("activityBtnStop")
                                  }
                                ) : null
                              ] })
                            ]
                          },
                          item2.id
                        );
                      }) })
                    ]
                  },
                  colKey
                );
              })
            }
          )
        )
      ] }),
      stopModalItem && /* @__PURE__ */ jsx(
        "div",
        {
          ref: stopModalRef,
          role: "dialog",
          "aria-modal": "true",
          "aria-label": t("activityStopModalTitle"),
          className: "lb:fixed lb:inset-0 lb:bg-black/50 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:p-4 lb:z-50",
          children: /* @__PURE__ */ jsxs("div", { className: "lb:bg-[var(--color-card)] lb:text-[var(--color-card-foreground)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:max-w-md lb:w-full lb:p-5 lb:shadow-xl lb:space-y-4", children: [
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2 lb:text-[var(--color-destructive)]", children: [
              /* @__PURE__ */ jsx(ShieldAlertIcon, { size: 18 }),
              /* @__PURE__ */ jsx("h2", { className: "lb:text-[15px] lb:font-bold", children: t("activityStopModalTitle") })
            ] }),
            /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("activityStopModalDesc") }),
            /* @__PURE__ */ jsx("div", { className: "lb:text-[13px] lb:font-mono lb:bg-[var(--color-muted)]/50 lb:p-2 lb:rounded-lg lb:break-words", children: activityTitle(stopModalItem, t) }),
            /* @__PURE__ */ jsx(
              "input",
              {
                type: "text",
                "data-testid": "input-stop-reason",
                "aria-label": t("activityStopReasonPlaceholder"),
                placeholder: t("activityStopReasonPlaceholder"),
                value: stopReason,
                onChange: (e) => setStopReason(e.target.value),
                className: "lb:w-full lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:p-2 lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:ring-1 focus:lb:ring-[var(--color-destructive)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)]"
              }
            ),
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:justify-end lb:gap-2 lb:pt-2", children: [
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: () => setStopModalItem(null),
                  className: "lb:px-3 lb:py-1.5 lb:border-[var(--lb-separator)] lb:text-[13px] lb:text-[var(--color-muted-foreground)] hover:lb:text-[var(--color-foreground)] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                  children: t("cancelBtn")
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  "data-testid": "btn-confirm-stop",
                  disabled: submittingStop,
                  onClick: handleConfirmStop,
                  className: "lb:px-3 lb:py-1.5 lb:bg-[var(--color-destructive)] lb:text-[var(--color-destructive-foreground,white)] lb:text-[13px] lb:font-medium hover:lb:opacity-90 lb:disabled:opacity-50 lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)] focus-visible:lb:outline-none lb:rounded-full",
                  children: t("activityStopConfirmBtn")
                }
              )
            ] })
          ] })
        }
      ),
      redirectModalItem && /* @__PURE__ */ jsx(
        "div",
        {
          ref: redirectModalRef,
          role: "dialog",
          "aria-modal": "true",
          "aria-label": t("activityRedirectModalTitle"),
          className: "lb:fixed lb:inset-0 lb:bg-black/50 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:p-4 lb:z-50",
          children: /* @__PURE__ */ jsxs("div", { className: "lb:bg-[var(--color-card)] lb:text-[var(--color-card-foreground)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:max-w-md lb:w-full lb:p-5 lb:shadow-xl lb:space-y-4", children: [
            /* @__PURE__ */ jsx("h2", { className: "lb:text-[15px] lb:font-bold", children: t("activityRedirectModalTitle") }),
            /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("activityRedirectModalDesc") }),
            /* @__PURE__ */ jsxs("div", { className: "lb:space-y-2", children: [
              /* @__PURE__ */ jsx("label", { className: "lb:text-[13px] lb:font-medium lb:text-[var(--color-foreground)]", children: t("activityRedirectSelectBotLabel") }),
              /* @__PURE__ */ jsx(
                "select",
                {
                  "data-testid": "select-redirect-bot",
                  "aria-label": t("activityRedirectSelectBotLabel"),
                  value: redirectBot,
                  onChange: (e) => setRedirectBot(e.target.value),
                  className: "lb:w-full lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:p-2 lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:ring-1 focus:lb:ring-[var(--color-primary)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)]",
                  children: bots.map((b) => /* @__PURE__ */ jsx("option", { value: b.name, children: b.display?.label || b.name }, b.name))
                }
              )
            ] }),
            /* @__PURE__ */ jsx(
              "input",
              {
                type: "text",
                "data-testid": "input-redirect-reason",
                "aria-label": t("activityRedirectReasonPlaceholder"),
                placeholder: t("activityRedirectReasonPlaceholder"),
                value: redirectReason,
                onChange: (e) => setRedirectReason(e.target.value),
                className: "lb:w-full lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:p-2 lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:ring-1 focus:lb:ring-[var(--color-primary)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)]"
              }
            ),
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:justify-end lb:gap-2 lb:pt-2", children: [
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: () => setRedirectModalItem(null),
                  className: "lb:px-3 lb:py-1.5 lb:border-[var(--lb-separator)] lb:text-[13px] lb:text-[var(--color-muted-foreground)] hover:lb:text-[var(--color-foreground)] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                  children: t("cancelBtn")
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  "data-testid": "btn-confirm-redirect",
                  disabled: submittingRedirect || !redirectBot,
                  onClick: handleConfirmRedirect,
                  className: "lb:px-3 lb:py-1.5 lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:text-[13px] lb:font-medium hover:lb:opacity-90 lb:disabled:opacity-50 lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                  children: t("activityRedirectConfirmBtn")
                }
              )
            ] })
          ] })
        }
      ),
      contextModalItem && /* @__PURE__ */ jsx(
        "div",
        {
          ref: contextModalRef,
          role: "dialog",
          "aria-modal": "true",
          "aria-label": t("activityContextModalTitle"),
          className: "lb:fixed lb:inset-0 lb:bg-black/50 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:p-4 lb:z-50",
          children: /* @__PURE__ */ jsxs("div", { className: "lb:bg-[var(--color-card)] lb:text-[var(--color-card-foreground)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:max-w-md lb:w-full lb:p-5 lb:shadow-xl lb:space-y-4", children: [
            /* @__PURE__ */ jsx("h2", { className: "lb:text-[15px] lb:font-bold", children: t("activityContextModalTitle") }),
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  "data-testid": "btn-kind-context",
                  onClick: () => setContextKind("context"),
                  className: `lb:px-2.5 lb:py-1 lb:text-[13px] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full ${contextKind === "context" ? "lb:border-[var(--color-primary)] lb:bg-[var(--color-primary)]/10 lb:text-[var(--color-primary)] lb:font-medium" : "lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)]"}`,
                  children: t("activityContextKindContext")
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  "data-testid": "btn-kind-correction",
                  onClick: () => setContextKind("correction"),
                  className: `lb:px-2.5 lb:py-1 lb:text-[13px] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full ${contextKind === "correction" ? "lb:border-[var(--color-primary)] lb:bg-[var(--color-primary)]/10 lb:text-[var(--color-primary)] lb:font-medium" : "lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)]"}`,
                  children: t("activityContextKindCorrection")
                }
              )
            ] }),
            /* @__PURE__ */ jsx(
              "textarea",
              {
                rows: 3,
                "data-testid": "textarea-context",
                "aria-label": t("activityContextTextPlaceholder"),
                placeholder: t("activityContextTextPlaceholder"),
                value: contextText,
                onChange: (e) => setContextText(e.target.value),
                className: "lb:w-full lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:p-2 lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:ring-1 focus:lb:ring-[var(--color-primary)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)]"
              }
            ),
            /* @__PURE__ */ jsx("p", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)] lb:bg-[var(--color-muted)]/30 lb:p-2 lb:rounded-lg", children: t("activityContextNotice") }),
            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:justify-end lb:gap-2 lb:pt-2", children: [
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: () => setContextModalItem(null),
                  className: "lb:px-3 lb:py-1.5 lb:border-[var(--lb-separator)] lb:text-[13px] lb:text-[var(--color-muted-foreground)] hover:lb:text-[var(--color-foreground)] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                  children: t("cancelBtn")
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  "data-testid": "btn-confirm-context",
                  disabled: submittingContext || !contextText.trim(),
                  onClick: handleConfirmContext,
                  className: "lb:px-3 lb:py-1.5 lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:text-[13px] lb:font-medium hover:lb:opacity-90 lb:disabled:opacity-50 lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                  children: t("activityContextConfirmBtn")
                }
              )
            ] })
          ] })
        }
      )
    ] });
  }

  // dashboard/src/components/rooms/mentions.ts
  var ALL = ["todos", "all", "everyone"];
  function mentionAt(text, cursor) {
    const m = text.slice(0, cursor).match(/@([a-zA-Z0-9._:-]*)$/);
    return m && m.index !== void 0 ? { query: m[1].toLowerCase(), start: m.index } : null;
  }
  var offersAll = (query) => ALL.some((w) => w.includes(query));
  var matchingMembers = (members, query) => members.filter((m) => m.handle.toLowerCase().includes(query) || !!m.display_name?.toLowerCase().includes(query));
  function isMultiTarget(text) {
    const handles = Array.from(text.matchAll(/@([A-Za-z0-9._:-]+)/g)).map((m) => m[1].toLowerCase());
    return handles.some((h) => ALL.includes(h)) || handles.length > 1;
  }
  function insertMention(text, start, cursor, handle) {
    const before = text.slice(0, start) + `@${handle} `;
    return { text: before + text.slice(cursor), caret: before.length };
  }

  // dashboard/src/components/rooms/CreateRoomModal.tsx
  var ROOM_CREATE_TIMEOUT_MS = 2e4;
  var RoomTimeout = class extends Error {
  };
  function CreateRoomModal({
    isOpen,
    onClose,
    availableBots,
    onRoomCreated,
    botsStatus = "ready",
    onRetryBots
  }) {
    const { t } = useLuveI18n();
    const [name, setName] = useState("");
    const [goal, setGoal] = useState("");
    const [selectedBotSlugs, setSelectedBotSlugs] = useState([]);
    const [owner, setOwner] = useState("");
    const [coordinator, setCoordinator] = useState("");
    const [kickoff, setKickoff] = useState(false);
    const [error, setError] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [roomsDown, setRoomsDown] = useState(null);
    const [checking, setChecking] = useState(true);
    const alertRef = useRef(null);
    const checkRooms = react_default.useCallback(async () => {
      setChecking(true);
      try {
        const h = await getHealth();
        const state = h?.features?.groups;
        if (state === "unavailable" || state === "unknown") {
          const why2 = (h.problems ?? []).find((p) => p.feature === "groups")?.message;
          setRoomsDown(why2 || state);
        } else setRoomsDown(null);
      } catch {
        setRoomsDown(null);
      } finally {
        setChecking(false);
      }
    }, []);
    useEffect(() => {
      if (isOpen) void checkRooms();
    }, [isOpen, checkRooms]);
    useEffect(() => {
      if (error && alertRef.current) {
        alertRef.current.scrollIntoView?.({ block: "nearest" });
        alertRef.current.focus();
      }
    }, [error]);
    if (!isOpen) return null;
    const toggleBotSelection = (slug) => {
      setError(null);
      if (selectedBotSlugs.includes(slug)) {
        const next = selectedBotSlugs.filter((s) => s !== slug);
        setSelectedBotSlugs(next);
        if (owner === slug) setOwner("");
        if (coordinator === slug) setCoordinator("");
      } else {
        if (selectedBotSlugs.length >= 6) {
          setError(t("roomMembersMinMaxError"));
          return;
        }
        setSelectedBotSlugs([...selectedBotSlugs, slug]);
      }
    };
    const handleSubmit = async (e) => {
      e.preventDefault();
      setError(null);
      const trimmedName = name.trim();
      if (!trimmedName) {
        setError(t("roomNameRequiredError"));
        return;
      }
      if (selectedBotSlugs.length < 2 || selectedBotSlugs.length > 6) {
        setError(t("roomMembersMinMaxError"));
        return;
      }
      const members = selectedBotSlugs.map((slug) => {
        const bot = availableBots.find((b) => b.name === slug);
        return {
          bot: slug,
          handle: slug,
          display_name: bot?.display?.label || slug
        };
      });
      const payload = {
        name: trimmedName,
        members,
        goal: goal.trim() || void 0,
        owner: owner || void 0,
        coordinator: coordinator || void 0,
        kickoff
      };
      let timer;
      try {
        setIsSubmitting(true);
        const timedOut = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new RoomTimeout()), ROOM_CREATE_TIMEOUT_MS);
        });
        const res = await Promise.race([createRoom(payload), timedOut]);
        setIsSubmitting(false);
        onRoomCreated?.(res.room);
        onClose();
      } catch (err) {
        setIsSubmitting(false);
        const msg = err instanceof RoomTimeout ? t("roomCreateTimeout") : humanError(err, t, "errorCreatingRoom");
        setError(msg);
      } finally {
        clearTimeout(timer);
      }
    };
    const ready = (b) => b.status !== "offline";
    const readyCount = availableBots.filter(ready).length;
    const tooFewReady = botsStatus === "ready" && readyCount < 2;
    const why = roomsDown ? t("roomsUnavailableTitle") : botsStatus === "loading" ? t("loadingBots") : botsStatus === "error" ? t("errorLoadingBots") : tooFewReady ? t("roomNeedTwoReady") : !name.trim() ? t("roomNeedName") : selectedBotSlugs.length < 2 ? t("roomNeedTwoBots", { count: selectedBotSlugs.length }) : checking ? t("roomsChecking") : null;
    const selectedOptions = selectedBotSlugs.map((slug) => /* @__PURE__ */ jsxs("option", { value: slug, children: [
      "@",
      slug
    ] }, slug));
    return /* @__PURE__ */ jsx(Dialog, { open: isOpen, onClose, title: t("createRoomModalTitle"), titleId: "create-room-title", width: 520, children: /* @__PURE__ */ jsxs("form", { onSubmit: handleSubmit, className: "lb-dialog-body", children: [
      roomsDown && /* @__PURE__ */ jsxs("div", { role: "status", className: "lb-alert", "data-testid": "rooms-unavailable", children: [
        /* @__PURE__ */ jsx("strong", { children: t("roomsUnavailableTitle") }),
        " ",
        roomsDown,
        /* @__PURE__ */ jsx("div", { children: /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn lb-btn-plain", onClick: () => void checkRooms(), children: t("roomsCheckAgain") }) })
      ] }),
      !roomsDown && tooFewReady && /* @__PURE__ */ jsxs("div", { role: "status", className: "lb-alert", "data-testid": "rooms-too-few-ready", children: [
        /* @__PURE__ */ jsx("strong", { children: t("roomTooFewReadyTitle", { count: readyCount }) }),
        " ",
        t("roomTooFewReadyHelp")
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "lb-field", children: [
        /* @__PURE__ */ jsx("label", { htmlFor: "create-room-name-input", className: "lb-label", children: t("roomNameLabel") }),
        /* @__PURE__ */ jsx("input", { id: "create-room-name-input", type: "text", value: name, onChange: (e) => setName(e.target.value), placeholder: t("roomNamePlaceholder"), maxLength: 200, required: true, className: "lb-input" })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "lb-field", children: [
        /* @__PURE__ */ jsx("label", { htmlFor: "create-room-goal-input", className: "lb-label", children: t("roomGoalLabel") }),
        /* @__PURE__ */ jsx("textarea", { id: "create-room-goal-input", value: goal, onChange: (e) => setGoal(e.target.value), placeholder: t("roomGoalPlaceholder"), rows: 2, className: "lb-input", style: { resize: "vertical" } })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "lb-field", children: [
        /* @__PURE__ */ jsx("span", { className: "lb-label", children: t("roomMembersLabel") }),
        /* @__PURE__ */ jsx("span", { className: "lb-subhead", children: t("roomMembersHelp") }),
        botsStatus === "loading" && /* @__PURE__ */ jsx(BotsLoading, {}),
        botsStatus === "error" && /* @__PURE__ */ jsx(BotsError, { onRetry: onRetryBots }),
        /* @__PURE__ */ jsx("div", { className: "lb-group", style: { marginTop: 4 }, children: availableBots.map((bot) => {
          const isSelected = selectedBotSlugs.includes(bot.name);
          const label = bot.display?.label || bot.name;
          const offline = !ready(bot);
          return /* @__PURE__ */ jsxs("button", { type: "button", "aria-pressed": isSelected, disabled: offline, onClick: () => toggleBotSelection(bot.name), className: "lb-contact", style: { borderRadius: 0, padding: "8px 14px", ...offline ? { opacity: 0.55, cursor: "not-allowed" } : {} }, children: [
            /* @__PURE__ */ jsx(Avatar, { name: label, avatar: bot.display?.avatar, color: bot.display?.color, size: 32 }),
            /* @__PURE__ */ jsxs("span", { className: "lb-row-stack", children: [
              /* @__PURE__ */ jsx("span", { className: "lb-headline lb-truncate", children: label }),
              /* @__PURE__ */ jsxs("span", { className: "lb-subhead lb-truncate", children: [
                "@",
                bot.name
              ] }),
              offline && /* @__PURE__ */ jsx("span", { className: "lb-caption", children: t("roomBotNotReady") })
            ] }),
            /* @__PURE__ */ jsx("span", { "aria-hidden": "true", style: { width: 22, height: 22, borderRadius: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", background: isSelected ? "var(--color-foreground)" : "transparent", color: "var(--color-background)", boxShadow: isSelected ? void 0 : "inset 0 0 0 1.5px var(--color-muted-foreground)" }, children: isSelected && /* @__PURE__ */ jsx(CheckIcon, { size: 14 }) })
          ] }, bot.name);
        }) })
      ] }),
      selectedBotSlugs.length > 0 && /* @__PURE__ */ jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }, children: [
        /* @__PURE__ */ jsxs("div", { className: "lb-field", children: [
          /* @__PURE__ */ jsx("label", { htmlFor: "create-room-owner-select", className: "lb-label", children: t("roomOwnerLabel") }),
          /* @__PURE__ */ jsxs("select", { id: "create-room-owner-select", value: owner, onChange: (e) => setOwner(e.target.value), className: "lb-input", children: [
            /* @__PURE__ */ jsx("option", { value: "", children: t("roomSelectOptionNone") }),
            selectedOptions
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "lb-field", children: [
          /* @__PURE__ */ jsx("label", { htmlFor: "create-room-coordinator-select", className: "lb-label", children: t("roomCoordinatorLabel") }),
          /* @__PURE__ */ jsxs("select", { id: "create-room-coordinator-select", value: coordinator, onChange: (e) => setCoordinator(e.target.value), className: "lb-input", children: [
            /* @__PURE__ */ jsx("option", { value: "", children: t("roomSelectOptionNone") }),
            selectedOptions
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsxs("label", { className: "lb-check", children: [
          /* @__PURE__ */ jsx("input", { type: "checkbox", checked: kickoff, onChange: (e) => setKickoff(e.target.checked) }),
          /* @__PURE__ */ jsx("span", { children: t("roomKickoffLabel") })
        ] }),
        /* @__PURE__ */ jsx("p", { className: "lb-subhead", style: { paddingLeft: 28 }, children: t("roomKickoffNotice") })
      ] }),
      error && /* @__PURE__ */ jsx("div", { ref: alertRef, role: "alert", tabIndex: -1, className: "lb-alert", children: /* @__PURE__ */ jsx(ErrorNote, { error }) }),
      /* @__PURE__ */ jsxs("div", { className: "lb-dialog-footer", children: [
        why && !isSubmitting && /* @__PURE__ */ jsx("span", { id: "create-room-why", className: "lb-caption", style: { marginRight: "auto", alignSelf: "center" }, children: why }),
        /* @__PURE__ */ jsx("button", { type: "button", onClick: onClose, className: "lb-btn", children: t("cancelBtn") }),
        /* @__PURE__ */ jsx("button", { type: "submit", disabled: isSubmitting || !!why, "aria-describedby": why ? "create-room-why" : void 0, className: "lb-btn lb-btn-primary", children: isSubmitting ? t("saving") : t("btnCreateRoom") })
      ] })
    ] }) });
  }

  // dashboard/src/components/rooms/EditRoomModal.tsx
  function EditRoomModal({
    isOpen,
    onClose,
    room,
    onRoomUpdated
  }) {
    const { t } = useLuveI18n();
    const [name, setName] = useState(room.name);
    const [goal, setGoal] = useState(room.goal || "");
    const [owner, setOwner] = useState(room.owner || "");
    const [coordinator, setCoordinator] = useState(room.coordinator || "");
    const [error, setError] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    if (!isOpen) return null;
    const handleSubmit = async (e) => {
      e.preventDefault();
      setError(null);
      const trimmedName = name.trim();
      if (!trimmedName) {
        setError(t("roomNameRequiredError"));
        return;
      }
      try {
        setIsSubmitting(true);
        const res = await patchRoom(room.id, {
          name: trimmedName,
          goal: goal.trim() || void 0,
          owner: owner || void 0,
          coordinator: coordinator || void 0
        });
        setIsSubmitting(false);
        onRoomUpdated?.(res.room);
        onClose();
      } catch (err) {
        setIsSubmitting(false);
        const msg = humanError(err, t, "errorPatchingRoom");
        setError(msg);
      }
    };
    const memberOptions = room.members.map((m) => /* @__PURE__ */ jsxs("option", { value: m.handle, children: [
      "@",
      m.handle
    ] }, m.handle));
    return /* @__PURE__ */ jsx(Dialog, { open: isOpen, onClose, title: t("editRoomModalTitle"), titleId: "edit-room-title", width: 480, children: /* @__PURE__ */ jsxs("form", { onSubmit: handleSubmit, className: "lb-dialog-body", children: [
      error && /* @__PURE__ */ jsx("div", { role: "alert", className: "lb-alert", children: /* @__PURE__ */ jsx(ErrorNote, { error }) }),
      /* @__PURE__ */ jsxs("div", { className: "lb-field", children: [
        /* @__PURE__ */ jsx("label", { htmlFor: "edit-room-name-input", className: "lb-label", children: t("roomNameLabel") }),
        /* @__PURE__ */ jsx("input", { id: "edit-room-name-input", type: "text", value: name, onChange: (e) => setName(e.target.value), placeholder: t("roomNamePlaceholder"), maxLength: 200, required: true, className: "lb-input" })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "lb-field", children: [
        /* @__PURE__ */ jsx("label", { htmlFor: "edit-room-goal-input", className: "lb-label", children: t("roomGoalLabel") }),
        /* @__PURE__ */ jsx("textarea", { id: "edit-room-goal-input", value: goal, onChange: (e) => setGoal(e.target.value), placeholder: t("roomGoalPlaceholder"), rows: 2, className: "lb-input", style: { resize: "vertical" } })
      ] }),
      /* @__PURE__ */ jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }, children: [
        /* @__PURE__ */ jsxs("div", { className: "lb-field", children: [
          /* @__PURE__ */ jsx("label", { htmlFor: "edit-room-owner-select", className: "lb-label", children: t("roomOwnerLabel") }),
          /* @__PURE__ */ jsxs("select", { id: "edit-room-owner-select", value: owner, onChange: (e) => setOwner(e.target.value), className: "lb-input", children: [
            /* @__PURE__ */ jsx("option", { value: "", children: t("roomSelectOptionNone") }),
            memberOptions
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "lb-field", children: [
          /* @__PURE__ */ jsx("label", { htmlFor: "edit-room-coordinator-select", className: "lb-label", children: t("roomCoordinatorLabel") }),
          /* @__PURE__ */ jsxs("select", { id: "edit-room-coordinator-select", value: coordinator, onChange: (e) => setCoordinator(e.target.value), className: "lb-input", children: [
            /* @__PURE__ */ jsx("option", { value: "", children: t("roomSelectOptionNone") }),
            memberOptions
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsx("p", { className: "lb-subhead", children: t("roomMembersHelp") }),
      /* @__PURE__ */ jsxs("div", { className: "lb-dialog-footer", children: [
        /* @__PURE__ */ jsx("button", { type: "button", onClick: onClose, className: "lb-btn", children: t("cancelBtn") }),
        /* @__PURE__ */ jsx("button", { type: "submit", disabled: isSubmitting || !name.trim(), className: "lb-btn lb-btn-primary", children: isSubmitting ? t("saving") : t("btnSaveRoom") })
      ] })
    ] }) });
  }

  // dashboard/src/components/rooms/DisbandRoomModal.tsx
  function DisbandRoomModal({
    isOpen,
    onClose,
    room,
    onRoomDisbanded
  }) {
    const { t } = useLuveI18n();
    const [confirmName, setConfirmName] = useState("");
    const [error, setError] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    if (!isOpen) return null;
    const isNameMatch = confirmName.trim() === room.name;
    const handleSubmit = async (e) => {
      e.preventDefault();
      if (!isNameMatch) {
        setError(t("errorDisbandingNameMismatch"));
        return;
      }
      try {
        setIsSubmitting(true);
        await disbandRoom(room.id, confirmName.trim());
        setIsSubmitting(false);
        onRoomDisbanded?.(room.id);
        onClose();
      } catch (err) {
        setIsSubmitting(false);
        const msg = humanError(err, t, "errorDisbandingRoom");
        setError(msg);
      }
    };
    return /* @__PURE__ */ jsx(Dialog, { open: isOpen, onClose, title: t("modalDisbandRoomTitle"), titleId: "disband-room-title", tone: "destructive", width: 420, children: /* @__PURE__ */ jsxs("form", { onSubmit: handleSubmit, className: "lb-dialog-body", children: [
      error && /* @__PURE__ */ jsx("div", { role: "alert", className: "lb-alert", children: /* @__PURE__ */ jsx(ErrorNote, { error }) }),
      /* @__PURE__ */ jsx("p", { className: "lb-body", style: { margin: 0 }, children: t("modalDisbandRoomBody", { name: room.name }) }),
      /* @__PURE__ */ jsxs("label", { className: "lb-field", children: [
        /* @__PURE__ */ jsx("span", { className: "lb-label", children: t("disbandRoomInputPlaceholder") }),
        /* @__PURE__ */ jsx("input", { type: "text", value: confirmName, onChange: (e) => setConfirmName(e.target.value), className: "lb-input", autoFocus: true })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "lb-dialog-footer", children: [
        /* @__PURE__ */ jsx("button", { type: "button", onClick: onClose, className: "lb-btn", children: t("cancelBtn") }),
        /* @__PURE__ */ jsx("button", { type: "submit", disabled: !isNameMatch || isSubmitting, className: "lb-btn lb-btn-destructive", children: isSubmitting ? t("saving") : t("btnConfirmDisband") })
      ] })
    ] }) });
  }

  // dashboard/src/components/rooms/CostConfirmModal.tsx
  function CostConfirmModal({
    isOpen,
    onClose,
    onConfirm,
    isSubmitting = false
  }) {
    const { t } = useLuveI18n();
    return /* @__PURE__ */ jsx(Dialog, { open: isOpen, onClose, title: t("modalCostConfirmTitle"), titleId: "cost-confirm-title", width: 420, children: /* @__PURE__ */ jsxs("div", { className: "lb-dialog-body", children: [
      /* @__PURE__ */ jsx("p", { className: "lb-body", style: { margin: 0 }, children: t("modalCostConfirmBody") }),
      /* @__PURE__ */ jsxs("div", { className: "lb-dialog-footer", children: [
        /* @__PURE__ */ jsx("button", { type: "button", onClick: onClose, className: "lb-btn", children: t("cancelBtn") }),
        /* @__PURE__ */ jsx("button", { type: "button", onClick: onConfirm, disabled: isSubmitting, className: "lb-btn lb-btn-primary", children: isSubmitting ? t("saving") : t("btnConfirmCostSend") })
      ] })
    ] }) });
  }

  // dashboard/src/components/rooms/RoomsView.tsx
  function RoomsView({ roomId = null, availableBots, onSelectRoom, onNavigateToKanban, onOpenTeamMap, pollMs = 4e3 }) {
    const { t } = useLuveI18n();
    const phone = usePhoneBar();
    const [currentRoom, setCurrentRoom] = useState(null);
    const [roomEvents, setRoomEvents] = useState([]);
    const [handoffs, setHandoffs] = useState([]);
    const [error, setError] = useState(null);
    const [inputText, setInputText] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [showMentionDropdown, setShowMentionDropdown] = useState(false);
    const [mentionQuery, setMentionQuery] = useState("");
    const [mentionStartIndex, setMentionStartIndex] = useState(-1);
    const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
    const [stoppingIds, setStoppingIds] = useState({});
    const [createModalOpen, setCreateModalOpen] = useState(false);
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [disbandModalOpen, setDisbandModalOpen] = useState(false);
    const [costModalOpen, setCostModalOpen] = useState(false);
    const [stopModalOpen, setStopModalOpen] = useState(false);
    const [retryModalOpen, setRetryModalOpen] = useState(false);
    const [retryTaskId, setRetryTaskId] = useState(null);
    const [pendingTextToSend, setPendingTextToSend] = useState(null);
    const [membersOpen, setMembersOpen] = useState(false);
    const textareaRef = useRef(null);
    const scrollRef = useRef(null);
    const loadRoomDetails = useCallback(async (id, quiet2 = false) => {
      try {
        if (!quiet2) setError(null);
        const [roomRes, logRes, handoffRes] = await Promise.all([getRoom(id), getRoomLog(id), getHandoffs({ room: id })]);
        setCurrentRoom(roomRes.room);
        setRoomEvents(logRes.events || []);
        setHandoffs(handoffRes.handoffs || []);
        if (!roomRes.room.driver.running) {
          setStoppingIds((prev) => {
            if (!prev[id]) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }
      } catch (err) {
        if (!quiet2) setError(humanError(err, t, "errorLoadingRoom"));
      }
    }, [t]);
    useEffect(() => {
      setMembersOpen(false);
      setInputText("");
      setShowMentionDropdown(false);
      if (roomId) void loadRoomDetails(roomId);
      else {
        setCurrentRoom(null);
        setRoomEvents([]);
        setHandoffs([]);
      }
    }, [roomId, loadRoomDetails]);
    useEffect(() => {
      if (!roomId || pollMs <= 0) return;
      const timer = setInterval(() => {
        if (typeof document === "undefined" || document.visibilityState !== "hidden") void loadRoomDetails(roomId, true);
      }, pollMs);
      return () => clearInterval(timer);
    }, [roomId, pollMs, loadRoomDetails]);
    useEffect(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [roomEvents.length]);
    const members = currentRoom?.members || [];
    const botOf = (bot) => availableBots.find((b) => b.name === bot);
    const colorOf = (m) => m?.color || (m ? botOf(m.bot)?.display?.color : void 0);
    const handleTextChange = (e) => {
      const val = e.target.value;
      setInputText(val);
      setError(null);
      const match = mentionAt(val, e.target.selectionStart);
      if (match) {
        setMentionQuery(match.query);
        setMentionStartIndex(match.start);
        setShowMentionDropdown(true);
        setMentionSelectedIndex(0);
      } else {
        setShowMentionDropdown(false);
        setMentionStartIndex(-1);
      }
    };
    const mentionOptions = [
      ...offersAll(mentionQuery) ? [{ id: "todos", handle: "todos", label: t("roomMentionTodosLabel"), color: "var(--color-warning)" }] : [],
      ...matchingMembers(members, mentionQuery).map((m) => ({
        id: m.member_id || m.bot,
        handle: m.handle,
        avatar: displayFace(m.bot, m.avatar ?? botOf(m.bot)?.display?.avatar),
        color: colorOf(m),
        label: m.display_name ? `${m.display_name} (@${m.handle})` : `@${m.handle}`
      }))
    ];
    const handleSelectMention = (opt) => {
      if (mentionStartIndex < 0) return;
      const cursor = textareaRef.current?.selectionStart || inputText.length;
      const next = insertMention(inputText, mentionStartIndex, cursor, opt.handle);
      setInputText(next.text);
      setShowMentionDropdown(false);
      setTimeout(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(next.caret, next.caret);
      }, 0);
    };
    const handleKeyDown = (e) => {
      if (showMentionDropdown && mentionOptions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionSelectedIndex((p) => (p + 1) % mentionOptions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionSelectedIndex((p) => (p - 1 + mentionOptions.length) % mentionOptions.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          handleSelectMention(mentionOptions[mentionSelectedIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowMentionDropdown(false);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSendMessage(false);
      }
    };
    const handleSendMessage = async (confirmCost = false) => {
      if (!currentRoom || !inputText.trim() || isSending) return;
      setError(null);
      const textToSend = inputText.trim();
      if (isMultiTarget(textToSend) && !confirmCost) {
        setPendingTextToSend(textToSend);
        setCostModalOpen(true);
        return;
      }
      try {
        setIsSending(true);
        const res = await sendRoomMessage(currentRoom.id, {
          text: textToSend,
          event_id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `msg-${Date.now()}`,
          confirm_cost: confirmCost || void 0
        });
        setInputText("");
        setShowMentionDropdown(false);
        setCostModalOpen(false);
        setPendingTextToSend(null);
        if (res?.event) setRoomEvents((prev) => [...prev, res.event]);
        await loadRoomDetails(currentRoom.id);
      } catch (err) {
        const e = err;
        if (e?.code === "not_a_member") {
          setError(t("roomNotAMemberError", { handle: e.details?.handles?.[0] || t("unknownHandle") }));
          return;
        }
        if (e?.code === "cost_confirmation_required") {
          setPendingTextToSend(textToSend);
          setCostModalOpen(true);
          return;
        }
        setError(humanError(err, t, "errorSendingRoomMessage"));
      } finally {
        setIsSending(false);
      }
    };
    const handleStopRoom = async () => {
      if (!currentRoom) return;
      try {
        setStoppingIds((prev) => ({ ...prev, [currentRoom.id]: true }));
        setStopModalOpen(false);
        await stopRoom(currentRoom.id);
        await loadRoomDetails(currentRoom.id);
      } catch (err) {
        setError(humanError(err, t, "errorStoppingRoom"));
      }
    };
    const handleRetryTask = async () => {
      if (!currentRoom || !retryTaskId) return;
      try {
        setRetryModalOpen(false);
        await retryRoomTask(currentRoom.id, retryTaskId);
        setRetryTaskId(null);
        await loadRoomDetails(currentRoom.id);
      } catch (err) {
        setError(humanError(err, t, "errorRetryingRoomTask"));
      }
    };
    const handlePromoteHandoff = async (handoffId) => {
      try {
        await promoteHandoff(handoffId);
        if (roomId) await loadRoomDetails(roomId);
      } catch (err) {
        setError(humanError(err, t, "errorPromotingHandoff"));
      }
    };
    const isStopping = currentRoom ? Boolean(stoppingIds[currentRoom.id]) : false;
    const isStoppable = !!currentRoom && (currentRoom.driver.running || isStopping);
    const kickoff = members.length >= 2 ? t("roomKickoffTemplate", { a: members[0].handle, b: members[1].handle }) : null;
    const modals = /* @__PURE__ */ jsxs(Fragment2, { children: [
      /* @__PURE__ */ jsx(CreateRoomModal, { isOpen: createModalOpen, onClose: () => setCreateModalOpen(false), availableBots, onRoomCreated: (r) => onSelectRoom?.(r) }),
      currentRoom && /* @__PURE__ */ jsx(EditRoomModal, { isOpen: editModalOpen, onClose: () => setEditModalOpen(false), room: currentRoom, onRoomUpdated: setCurrentRoom }),
      currentRoom && /* @__PURE__ */ jsx(DisbandRoomModal, { isOpen: disbandModalOpen, onClose: () => setDisbandModalOpen(false), room: currentRoom, onRoomDisbanded: () => {
        setCurrentRoom(null);
        setRoomEvents([]);
      } }),
      /* @__PURE__ */ jsx(
        CostConfirmModal,
        {
          isOpen: costModalOpen,
          onClose: () => {
            setCostModalOpen(false);
            setPendingTextToSend(null);
          },
          onConfirm: () => {
            if (pendingTextToSend) void handleSendMessage(true);
          },
          isSubmitting: isSending
        }
      ),
      /* @__PURE__ */ jsx(Dialog, { open: stopModalOpen, onClose: () => setStopModalOpen(false), title: t("modalStopRoomTitle"), titleId: "stop-room-title", tone: "destructive", width: 420, children: /* @__PURE__ */ jsxs("div", { className: "lb-dialog-body", children: [
        /* @__PURE__ */ jsx("p", { className: "lb-body", style: { margin: 0 }, children: t("modalStopRoomBody") }),
        /* @__PURE__ */ jsxs("div", { className: "lb-dialog-footer", children: [
          /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setStopModalOpen(false), className: "lb-btn", children: t("cancelBtn") }),
          /* @__PURE__ */ jsx("button", { type: "button", onClick: handleStopRoom, className: "lb-btn lb-btn-destructive", children: t("btnConfirmStopRoom") })
        ] })
      ] }) }),
      /* @__PURE__ */ jsx(Dialog, { open: retryModalOpen, onClose: () => setRetryModalOpen(false), title: t("modalRetryRoomTitle"), titleId: "retry-room-title", width: 420, children: /* @__PURE__ */ jsxs("div", { className: "lb-dialog-body", children: [
        /* @__PURE__ */ jsx("p", { className: "lb-body", style: { margin: 0 }, children: t("modalRetryRoomBody") }),
        /* @__PURE__ */ jsxs("div", { className: "lb-dialog-footer", children: [
          /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setRetryModalOpen(false), className: "lb-btn", children: t("cancelBtn") }),
          /* @__PURE__ */ jsx("button", { type: "button", onClick: handleRetryTask, className: "lb-btn lb-btn-primary", children: t("btnConfirmRetryRoom") })
        ] })
      ] }) })
    ] });
    if (!currentRoom) {
      return /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", height: "100%" }, children: [
        /* @__PURE__ */ jsxs("header", { style: { display: "flex", alignItems: "center", gap: 8, padding: phone ? "12px 8px" : "12px 16px", minHeight: 64, borderBottom: "1px solid var(--lb-separator)" }, children: [
          phone?.back,
          /* @__PURE__ */ jsx("h1", { className: "lb-headline", style: { flex: 1 }, children: t("roomsTitle") }),
          /* @__PURE__ */ jsxs("button", { type: "button", onClick: () => setCreateModalOpen(true), className: "lb-btn", children: [
            /* @__PURE__ */ jsx(PlusIcon, { size: 14 }),
            /* @__PURE__ */ jsx("span", { children: t("newRoomBtn") })
          ] }),
          phone?.hermes
        ] }),
        error && /* @__PURE__ */ jsx("div", { role: "alert", className: "lb-alert", style: { margin: 12 }, children: /* @__PURE__ */ jsx(ErrorNote, { error }) }),
        /* @__PURE__ */ jsxs("div", { "data-testid": "rooms-empty-state", className: "lb-empty", style: { flex: 1, justifyContent: "center" }, children: [
          /* @__PURE__ */ jsx("h3", { className: "lb-title", children: t("noRoomSelected") }),
          /* @__PURE__ */ jsx("p", { className: "lb-subhead", style: { maxWidth: 380 }, children: t("roomsEmptyNextStep") }),
          /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setCreateModalOpen(true), className: "lb-btn lb-btn-primary", style: { marginTop: 6 }, children: t("newRoomBtn") })
        ] }),
        modals
      ] });
    }
    return /* @__PURE__ */ jsxs("div", { style: { display: "flex", height: "100%", minHeight: 0 }, children: [
      /* @__PURE__ */ jsxs("section", { "aria-label": currentRoom.name, style: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }, children: [
        /* @__PURE__ */ jsxs("header", { style: { display: "flex", alignItems: "center", gap: phone ? 8 : 12, padding: phone ? "10px 8px" : "10px 16px", minHeight: 64, borderBottom: "1px solid var(--lb-separator)", flexWrap: "wrap" }, children: [
          phone?.back,
          /* @__PURE__ */ jsx(AvatarStack, { size: 30, faces: members.map((m) => ({ key: m.member_id || m.bot, name: m.display_name || m.handle, avatar: displayFace(m.bot, m.avatar ?? botOf(m.bot)?.display?.avatar), color: colorOf(m) })) }),
          /* @__PURE__ */ jsxs("div", { style: { flex: 1, minWidth: 140 }, children: [
            /* @__PURE__ */ jsx("h1", { className: "lb-headline lb-truncate", children: currentRoom.name }),
            /* @__PURE__ */ jsxs("div", { role: "status", className: "lb-caption", style: { display: "flex", alignItems: "center", gap: 6, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }, children: [
              currentRoom.driver.running ? /* @__PURE__ */ jsxs(Fragment2, { children: [
                /* @__PURE__ */ jsx(AttentionBadge, { state: "working" }),
                t("roomDriverRunning")
              ] }) : /* @__PURE__ */ jsx(Fragment2, { children: t("roomMembersCount", { count: members.length }) }),
              currentRoom.goal && /* @__PURE__ */ jsxs("span", { title: currentRoom.goal, style: { overflow: "hidden", textOverflow: "ellipsis" }, children: [
                "\xB7 ",
                currentRoom.goal
              ] })
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" }, children: [
            /* @__PURE__ */ jsx("button", { type: "button", "aria-expanded": membersOpen, onClick: () => setMembersOpen(!membersOpen), className: "lb-btn", children: t("roomMembersBtn") }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setEditModalOpen(true), className: "lb-btn", children: t("editRoomModalTitle") }),
            isStoppable && /* @__PURE__ */ jsx("button", { type: "button", "data-testid": "btn-stop-room", disabled: isStopping, onClick: () => setStopModalOpen(true), className: "lb-btn lb-btn-destructive", children: isStopping ? t("roomStoppingBtn") : t("roomStopBtn") }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setDisbandModalOpen(true), title: t("roomDisbandBtn"), "aria-label": t("roomDisbandBtn"), className: "lb-icon-btn", children: /* @__PURE__ */ jsx(XIcon, { size: 14 }) }),
            phone?.hermes
          ] })
        ] }),
        error && /* @__PURE__ */ jsxs("div", { role: "alert", className: "lb-alert", style: { margin: "10px 16px 0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }, children: [
          /* @__PURE__ */ jsx("span", { children: /* @__PURE__ */ jsx(ErrorNote, { error }) }),
          /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setError(null), "aria-label": t("close"), className: "lb-icon-btn", style: { color: "inherit" }, children: /* @__PURE__ */ jsx(XIcon, { size: 14 }) })
        ] }),
        /* @__PURE__ */ jsxs("div", { ref: scrollRef, style: { flex: 1, overflowY: "auto", padding: "16px 20px" }, children: [
          roomEvents.length === 0 && /* @__PURE__ */ jsxs("div", { "data-testid": "room-events-empty", style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100%", gap: 8, textAlign: "center" }, children: [
            /* @__PURE__ */ jsx("h3", { className: "lb-title", children: t("roomEmptyKickoffTitle") }),
            /* @__PURE__ */ jsx("p", { className: "lb-subhead", style: { maxWidth: 420 }, children: t("roomEmptyKickoffDesc") }),
            kickoff && /* @__PURE__ */ jsx("button", { type: "button", onClick: () => {
              setInputText(kickoff);
              textareaRef.current?.focus();
            }, className: "lb-btn", style: { marginTop: 6, maxWidth: 460, height: "auto", padding: "8px 14px", lineHeight: "18px", whiteSpace: "normal", textAlign: "left" }, children: kickoff })
          ] }),
          roomEvents.map((evt) => {
            const key = evt.event_id || evt.seq;
            if (evt.kind === "handoff.card" || evt.payload.handoff_id) {
              return /* @__PURE__ */ jsxs(
                "div",
                {
                  "data-testid": `handoff-card-${evt.payload.handoff_id || evt.seq}`,
                  className: "lb-group",
                  style: { maxWidth: 520, margin: "14px auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6 },
                  children: [
                    /* @__PURE__ */ jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }, children: [
                      /* @__PURE__ */ jsx("span", { className: "lb-caption", children: t("roomHandoffCardTitle") }),
                      evt.payload.status && /* @__PURE__ */ jsx("span", { className: "lb-pill", children: handoffStateLabel(evt.payload.status, t) })
                    ] }),
                    /* @__PURE__ */ jsx("div", { className: "lb-headline", children: t("roomHandoffFromTo", { from: evt.payload.from || "?", to: evt.payload.to || "?" }) }),
                    evt.payload.title && /* @__PURE__ */ jsx("div", { className: "lb-body", children: /* @__PURE__ */ jsx(Markdown, { text: evt.payload.title }) }),
                    /* @__PURE__ */ jsx("button", { type: "button", "data-testid": "handoff-kanban-link", onClick: () => onNavigateToKanban?.(evt.payload.task_id), className: "lb-btn lb-btn-plain", style: { alignSelf: "flex-start", marginTop: 2 }, children: t("roomHandoffTaskLink") })
                  ]
                },
                key
              );
            }
            if (evt.kind === "message.user" || evt.actor.kind === "user") {
              return /* @__PURE__ */ jsx(Bubble, { side: "me", children: evt.payload.text || "" }, key);
            }
            if (evt.kind === "turn.failed") {
              const taskId = evt.payload.task_id || evt.event_id;
              return /* @__PURE__ */ jsxs("div", { style: { maxWidth: "min(85%, 640px)", margin: "8px 0", padding: "12px 14px", borderRadius: 18, background: "color-mix(in srgb, var(--color-destructive) 10%, transparent)", display: "flex", flexDirection: "column", gap: 6 }, children: [
                /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }, children: [
                  /* @__PURE__ */ jsx("span", { className: "lb-headline", style: { color: "var(--color-destructive)" }, children: t("statusFailed") }),
                  /* @__PURE__ */ jsx("button", { type: "button", onClick: () => {
                    setRetryTaskId(taskId);
                    setRetryModalOpen(true);
                  }, className: "lb-btn lb-btn-destructive", children: t("roomRetryBtn") })
                ] }),
                evt.payload.error && /* @__PURE__ */ jsx("div", { className: "lb-subhead", style: { overflowWrap: "anywhere" }, children: evt.payload.error })
              ] }, key);
            }
            if (evt.kind !== "message.member" || !(evt.payload.text || "").trim()) return null;
            const member = members.find((m) => m.bot === evt.actor.id || m.handle === evt.actor.id || m.member_id === evt.actor.id);
            const author = member?.display_name || evt.actor.display_name || evt.actor.id;
            return /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "flex-end", gap: 8 }, children: [
              /* @__PURE__ */ jsx("span", { style: { marginBottom: 8 }, children: /* @__PURE__ */ jsx(Avatar, { name: author, avatar: member ? displayFace(member.bot, member.avatar ?? botOf(member.bot)?.display?.avatar) : void 0, color: colorOf(member), size: 28 }) }),
              /* @__PURE__ */ jsx("div", { style: { flex: 1, minWidth: 0 }, children: /* @__PURE__ */ jsx(Bubble, { side: "bot", author, color: botColor(colorOf(member)), children: /* @__PURE__ */ jsx(Markdown, { text: evt.payload.text || "" }) }) })
            ] }, key);
          })
        ] }),
        /* @__PURE__ */ jsxs("div", { style: { position: "relative", margin: "0 16px 16px" }, children: [
          showMentionDropdown && mentionOptions.length > 0 && /* @__PURE__ */ jsx(
            "div",
            {
              role: "listbox",
              "aria-label": t("roomMentionsListAriaLabel"),
              style: { position: "absolute", bottom: "100%", left: 0, width: "min(100%, 340px)", marginBottom: 6, borderRadius: 16, border: "1px solid var(--color-border)", background: "var(--color-card)", boxShadow: "0 12px 32px rgba(0,0,0,0.18)", overflow: "hidden", zIndex: 30, maxHeight: 240, overflowY: "auto" },
              children: mentionOptions.map((opt, idx) => /* @__PURE__ */ jsxs(
                "button",
                {
                  role: "option",
                  "aria-selected": idx === mentionSelectedIndex,
                  type: "button",
                  onClick: () => handleSelectMention(opt),
                  className: "lb-contact",
                  style: { minHeight: 44, borderRadius: 0, padding: "6px 12px", background: idx === mentionSelectedIndex ? "var(--lb-fill-2)" : void 0 },
                  children: [
                    opt.id === "todos" ? /* @__PURE__ */ jsx("span", { "aria-hidden": "true", style: { width: 24, height: 24, borderRadius: 12, background: opt.color } }) : /* @__PURE__ */ jsx(Avatar, { name: opt.handle, avatar: opt.avatar, color: opt.color, size: 24 }),
                    /* @__PURE__ */ jsx("span", { className: "lb-body lb-truncate", children: opt.label })
                  ]
                },
                opt.id
              ))
            }
          ),
          /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "flex-end", gap: 8, padding: "6px 6px 6px 16px", borderRadius: 24, background: "var(--lb-fill)" }, children: [
            /* @__PURE__ */ jsx(
              "textarea",
              {
                ref: textareaRef,
                "aria-label": t("messageLabel"),
                value: inputText,
                onChange: handleTextChange,
                onKeyDown: handleKeyDown,
                placeholder: t("roomInputPlaceholder"),
                rows: 1,
                className: "lb-body",
                style: { flex: 1, minHeight: 40, maxHeight: 160, padding: "10px 0", border: "none", outline: "none", resize: "none", background: "transparent", fieldSizing: "content" }
              }
            ),
            /* @__PURE__ */ jsx("button", { type: "button", disabled: !inputText.trim() || isSending, onClick: () => void handleSendMessage(false), className: "lb-btn lb-btn-primary", style: { minHeight: 40 }, children: isSending ? t("saving") : t("sendBtn") })
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxs(SidePanel, { open: membersOpen, onClose: () => setMembersOpen(false), label: t("roomMembersBtn"), children: [
        /* @__PURE__ */ jsx("h2", { className: "lb-title", style: { margin: "4px 0 12px" }, children: t("roomMembersCount", { count: members.length }) }),
        /* @__PURE__ */ jsx("ul", { className: "lb-group", style: { listStyle: "none", margin: 0, padding: 0 }, children: members.map((m) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            onClick: () => {
              setInputText((p) => `${p}@${m.handle} `);
              setMembersOpen(false);
              textareaRef.current?.focus();
            },
            className: "lb-contact",
            style: { borderRadius: 0, padding: "8px 14px" },
            children: [
              /* @__PURE__ */ jsx(Avatar, { name: m.display_name || m.handle, avatar: displayFace(m.bot, m.avatar ?? botOf(m.bot)?.display?.avatar), color: colorOf(m), size: 36 }),
              /* @__PURE__ */ jsxs("span", { className: "lb-row-stack", children: [
                /* @__PURE__ */ jsx("span", { className: "lb-headline lb-truncate", children: m.display_name || m.handle }),
                /* @__PURE__ */ jsxs("span", { className: "lb-subhead", children: [
                  "@",
                  m.handle
                ] })
              ] }),
              currentRoom.owner === m.handle && /* @__PURE__ */ jsx("span", { className: "lb-caption", children: t("roomOwnerBadge", { handle: m.handle }) }),
              currentRoom.coordinator === m.handle && /* @__PURE__ */ jsx("span", { className: "lb-caption", children: t("roomCoordinatorBadge", { handle: m.handle }) })
            ]
          }
        ) }, m.member_id || m.bot)) }),
        /* @__PURE__ */ jsx("h3", { className: "lb-headline", style: { margin: "24px 4px 8px" }, children: t("roomOpenTasksTitle", { count: handoffs.length }) }),
        handoffs.length === 0 ? /* @__PURE__ */ jsx("p", { className: "lb-group lb-subhead", style: { padding: "14px 16px" }, children: t("roomNoOpenTasks") }) : /* @__PURE__ */ jsx("ul", { className: "lb-group", style: { listStyle: "none", margin: 0, padding: 0 }, children: handoffs.map((h) => /* @__PURE__ */ jsxs("li", { className: "lb-row lb-row-flat", style: { flexDirection: "column", alignItems: "stretch", gap: 4 }, children: [
          /* @__PURE__ */ jsxs("span", { className: "lb-caption", children: [
            "@",
            h.from,
            " \u2192 @",
            h.to,
            " \xB7 ",
            handoffStateLabel(h.state, t)
          ] }),
          /* @__PURE__ */ jsx("span", { className: "lb-body lb-clamp-2", children: h.title }),
          /* @__PURE__ */ jsxs("span", { style: { display: "flex", gap: 8, alignItems: "center" }, children: [
            /* @__PURE__ */ jsx("button", { type: "button", onClick: () => onNavigateToKanban?.(h.task_id), className: "lb-btn lb-btn-plain", children: t("roomHandoffTaskLink") }),
            h.state === "triage" && /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void handlePromoteHandoff(h.id), className: "lb-btn lb-btn-primary", children: t("btnPromoteHandoff") })
          ] })
        ] }, h.id)) }),
        onOpenTeamMap && /* @__PURE__ */ jsx("button", { type: "button", onClick: onOpenTeamMap, className: "lb-btn", style: { marginTop: 20 }, children: t("roomTeamMapBtn") })
      ] }),
      modals
    ] });
  }

  // dashboard/src/components/map/HandoffDetailDrawer.tsx
  function HandoffDetailDrawer({
    isOpen,
    edge,
    onClose,
    onNavigateToKanban
  }) {
    const { t } = useLuveI18n();
    const containerRef = useFocusTrap({
      isOpen,
      onClose
    });
    if (!isOpen || !edge) return null;
    return /* @__PURE__ */ jsx(
      "div",
      {
        className: "lb:fixed lb:inset-0 lb:z-50 lb:flex lb:justify-end lb:bg-black/60 lb:backdrop-blur-xs lb:motion-safe:animate-in lb:fade-in lb:motion-safe:duration-150",
        onClick: (e) => {
          if (e.target === e.currentTarget) onClose();
        },
        children: /* @__PURE__ */ jsxs(
          "div",
          {
            ref: containerRef,
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "handoff-drawer-title",
            tabIndex: -1,
            className: "lb:w-full lb:max-w-md lb:h-full lb:bg-[var(--lb-fill)] lb:border-l lb:border-[var(--lb-separator)] lb:shadow-2xl lb:flex lb:flex-col lb:focus:outline-none",
            children: [
              /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:p-4 lb:border-b lb:border-[var(--lb-separator)] lb:shrink-0", children: [
                /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                  /* @__PURE__ */ jsx(
                    "h2",
                    {
                      id: "handoff-drawer-title",
                      className: "lb:text-[15px] lb:font-bold lb:text-[var(--color-card-foreground)]",
                      children: t("mapHandoffDrawerTitle")
                    }
                  ),
                  edge.live && /* @__PURE__ */ jsxs("span", { className: "lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)] lb:flex lb:items-center lb:gap-1", children: [
                    /* @__PURE__ */ jsx("span", { className: "lb:w-1.5 lb:h-1.5 lb:rounded-full lb:bg-[var(--color-success)] lb:motion-safe:animate-pulse" }),
                    t("mapEdgeLiveIndicator")
                  ] })
                ] }),
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    onClick: onClose,
                    "aria-label": t("close"),
                    className: "lb:p-1.5 lb:rounded-lg lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-card-foreground)] lb:hover:bg-[var(--lb-fill-2)] lb:min-h-11 lb:min-w-11 lb:flex lb:items-center lb:justify-center focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none",
                    children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
                  }
                )
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "lb:flex-1 lb:overflow-y-auto lb:p-4 lb:space-y-4", children: [
                /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-center lb:gap-3 lb:p-3 lb:rounded-xl lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)]", children: [
                  /* @__PURE__ */ jsxs("span", { className: "lb:font-mono lb:font-semibold lb:text-[13px] lb:text-[var(--color-primary)]", children: [
                    "@",
                    edge.from
                  ] }),
                  /* @__PURE__ */ jsx(ArrowRightIcon, { size: 14, className: "lb:text-[var(--color-muted-foreground)]" }),
                  /* @__PURE__ */ jsxs("span", { className: "lb:font-mono lb:font-semibold lb:text-[13px] lb:text-[var(--color-primary)]", children: [
                    "@",
                    edge.to
                  ] })
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "lb:grid lb:grid-cols-2 lb:gap-2", children: [
                  /* @__PURE__ */ jsxs("div", { className: "lb:p-3 lb:rounded-lg lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)]", children: [
                    /* @__PURE__ */ jsx("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)] lb:font-semibold lb:block", children: t("mapHandoffTotal") }),
                    /* @__PURE__ */ jsx("span", { className: "lb:text-base lb:font-bold lb:text-[var(--color-foreground)]", children: t("mapHandoffsCount", { count: edge.count }) })
                  ] }),
                  /* @__PURE__ */ jsxs("div", { className: "lb:p-3 lb:rounded-lg lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)]", children: [
                    /* @__PURE__ */ jsx("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)] lb:font-semibold lb:block", children: t("mapHandoffStatus") }),
                    /* @__PURE__ */ jsx(
                      "span",
                      {
                        className: `lb:text-[13px] lb:font-semibold lb:block lb:mt-1 ${edge.live ? "lb:text-[var(--color-success)]" : "lb:text-[var(--color-muted-foreground)]"}`,
                        children: edge.live ? t("mapLiveHandoffBadge") : t("roomDriverIdle")
                      }
                    )
                  ] })
                ] }),
                edge.last_at && /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: t("mapLastActivity", { date: new Date(edge.last_at).toLocaleString() }) }),
                /* @__PURE__ */ jsxs("div", { className: "lb:space-y-2", children: [
                  /* @__PURE__ */ jsx("h3", { className: "lb:text-[13px] lb:font-semibold lb:text-[var(--color-card-foreground)]", children: t("mapRecentTasks", { count: edge.handoff_ids?.length || 0 }) }),
                  !edge.handoff_ids || edge.handoff_ids.length === 0 ? /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:italic", children: t("mapNoEdges") }) : /* @__PURE__ */ jsx("ul", { className: "lb:space-y-2", children: edge.handoff_ids.map((id) => /* @__PURE__ */ jsxs(
                    "li",
                    {
                      className: "lb:p-3 lb:rounded-lg lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:flex lb:items-center lb:justify-between lb:gap-2",
                      children: [
                        /* @__PURE__ */ jsxs("div", { className: "lb:min-w-0", children: [
                          /* @__PURE__ */ jsx("span", { className: "lb:font-mono lb:text-[13px] lb:font-semibold lb:text-[var(--color-foreground)] lb:block lb:truncate", children: t("mapHandoffItemLabel", { id }) }),
                          /* @__PURE__ */ jsxs("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)] lb:block", children: [
                            edge.from,
                            " \u2192 ",
                            edge.to
                          ] })
                        ] }),
                        onNavigateToKanban && /* @__PURE__ */ jsx(
                          "button",
                          {
                            type: "button",
                            "data-testid": "map-handoff-kanban-link",
                            onClick: () => onNavigateToKanban(id),
                            className: "lb:px-2.5 lb:py-1.5 lb:text-[13px] lb:font-semibold lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:min-h-11 lb:md:min-h-7 lb:shrink-0 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                            children: t("mapViewKanbanTask")
                          }
                        )
                      ]
                    },
                    id
                  )) })
                ] })
              ] }),
              /* @__PURE__ */ jsx("div", { className: "lb:p-4 lb:border-t lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:shrink-0 lb:flex lb:justify-end", children: /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: onClose,
                  className: "lb:px-4 lb:py-2 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-card-foreground)] lb:hover:bg-[var(--lb-fill-2)] lb:min-h-11 lb:md:min-h-8 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                  children: t("cancelBtn")
                }
              ) })
            ]
          }
        )
      }
    );
  }

  // dashboard/src/components/map/TeamMapView.tsx
  var faceSrc = (avatar, status) => avatar?.kind === "mascot" ? mascotUrl(avatar.value, status === "working" ? "working" : status === "waiting_approval" ? "needs_you" : void 0, 48) : null;
  var faceText = (node) => {
    const a = node.display?.avatar;
    if (a?.kind === "emoji" && a.value) return a.value;
    const src = a?.kind === "initials" && a.value ? a.value : node.display?.label || node.bot;
    return Array.from(src.trim()).slice(0, 2).join("").toUpperCase();
  };
  function edgeGap(ux, uy, labelChars) {
    const ring = 30;
    if (uy <= 0) return ring;
    const halfWidth = labelChars * 3.6 + 6;
    const enter = 26 / uy;
    const exit = Math.min(58 / uy, ux === 0 ? Infinity : halfWidth / Math.abs(ux));
    return exit >= enter ? Math.max(ring, exit + 4) : ring;
  }
  function TeamMapView({
    availableBots = [],
    initialMapData,
    onSelectBot,
    onNavigateToKanban,
    onNavigateToRoom
  }) {
    const { locale, t } = useLuveI18n();
    const [timeWindow, setTimeWindow] = useState("7d");
    const [viewMode, setViewMode] = useState("visual");
    const [mapData, setMapData] = useState(initialMapData || null);
    const [loading2, setLoading] = useState(!initialMapData);
    const [error, setError] = useState(null);
    const [selectedEdge, setSelectedEdge] = useState(null);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const loadMapData = useCallback(async (win) => {
      try {
        setLoading(true);
        setError(null);
        const data = await getTeamMap({ window: win });
        setMapData(data);
      } catch (err) {
        const msg = humanError(err, t, "mapError");
        setError(msg);
      } finally {
        setLoading(false);
      }
    }, [t]);
    useEffect(() => {
      if (!initialMapData) {
        loadMapData(timeWindow);
      }
    }, [timeWindow, initialMapData, loadMapData]);
    const nodes = useMemo(() => (mapData?.nodes || []).map((n) => ({ ...n, display: { ...n.display, label: displayName(n.bot, n.display?.label), avatar: displayFace(n.bot, n.display?.avatar) } })), [mapData]);
    const edges = useMemo(() => mapData?.edges || [], [mapData]);
    const handleEdgeClick = (edge) => {
      setSelectedEdge(edge);
      setDrawerOpen(true);
    };
    const formatCost = (cents) => {
      if (cents === void 0 || cents === null) return "$0.00";
      return (cents / 100).toLocaleString(locale === "pt" ? "pt-BR" : "en-US", {
        style: "currency",
        currency: "USD"
      });
    };
    const nodeCoordinates = useMemo(() => {
      const coords = /* @__PURE__ */ new Map();
      const total = nodes.length;
      if (total === 0) return coords;
      const centerX = 350;
      const centerY = 240;
      const radius = 180;
      nodes.forEach((n, idx) => {
        const angle = idx / total * 2 * Math.PI - Math.PI / 2;
        coords.set(n.bot, {
          x: centerX + radius * Math.cos(angle),
          y: centerY + radius * Math.sin(angle)
        });
      });
      return coords;
    }, [nodes]);
    const labelChars = (bot) => {
      const n = nodes.find((x) => x.bot === bot);
      return n ? Math.max((n.display?.label || n.bot).length, botStatusLabel(n.status, t).length) : 0;
    };
    return /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-col lb:h-full lb:min-h-0 lb:bg-[var(--color-background)]", children: [
      /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:flex-wrap lb:items-center lb:justify-between lb:gap-3 lb:p-3 lb:md:px-4 lb:border-b lb:border-[var(--lb-separator)] lb:shrink-0", children: [
        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-3", children: [
          /* @__PURE__ */ jsx("div", { className: "lb:w-8 lb:h-8 lb:rounded-xl lb:bg-[var(--color-primary)]/10 lb:text-[var(--color-primary)] lb:flex lb:items-center lb:justify-center lb:shrink-0", children: /* @__PURE__ */ jsx(NetworkIcon, { size: 18 }) }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("h1", { className: "lb-large-title", children: t("mapTitle") }),
            /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:hidden lb:sm:block", children: t("mapSubtitle") })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:border-[var(--lb-separator)] lb:rounded-xl lb:p-0.5 lb:bg-[var(--lb-fill)]", children: [
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: () => setTimeWindow("7d"),
                "aria-pressed": timeWindow === "7d",
                className: `lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:min-h-11 lb:md:min-h-7 lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full ${timeWindow === "7d" ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-foreground)]" : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"}`,
                children: t("mapWindow7d")
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: () => setTimeWindow("30d"),
                "aria-pressed": timeWindow === "30d",
                className: `lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:min-h-11 lb:md:min-h-7 lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full ${timeWindow === "30d" ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-foreground)]" : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"}`,
                children: t("mapWindow30d")
              }
            )
          ] }),
          /* @__PURE__ */ jsxs(
            "div",
            {
              role: "tablist",
              "aria-label": t("mapTitle"),
              className: "lb:flex lb:items-center lb:border-[var(--lb-separator)] lb:rounded-xl lb:p-0.5 lb:bg-[var(--lb-fill)]",
              children: [
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    role: "tab",
                    id: "tab-map-visual",
                    "aria-selected": viewMode === "visual",
                    "aria-controls": "panel-map-visual",
                    title: t("mapViewVisualDesc"),
                    onClick: () => setViewMode("visual"),
                    className: `lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:min-h-11 lb:md:min-h-7 lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full ${viewMode === "visual" ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-foreground)]" : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"}`,
                    children: t("mapViewVisual")
                  }
                ),
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    role: "tab",
                    id: "tab-map-accessible",
                    "aria-selected": viewMode === "accessible",
                    "aria-controls": "panel-map-accessible",
                    title: t("mapViewAccessibleDesc"),
                    onClick: () => setViewMode("accessible"),
                    className: `lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:min-h-11 lb:md:min-h-7 lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full ${viewMode === "accessible" ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-foreground)]" : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"}`,
                    children: t("mapViewAccessible")
                  }
                )
              ]
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "lb:flex-1 lb:min-h-0 lb:overflow-auto lb:relative", children: loading2 ? /* @__PURE__ */ jsx("div", { className: "lb:flex lb:items-center lb:justify-center lb:h-full lb:p-8 lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: /* @__PURE__ */ jsx("span", { className: "lb:motion-safe:animate-pulse", children: t("mapLoading") }) }) : error ? /* @__PURE__ */ jsx("div", { className: "lb:flex lb:items-center lb:justify-center lb:h-full lb:p-8", role: "alert", children: /* @__PURE__ */ jsxs("div", { className: "lb:p-4 lb:rounded-xl lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:text-[var(--color-destructive)] lb:text-[13px]", children: [
        /* @__PURE__ */ jsx(ErrorNote, { error }),
        /* @__PURE__ */ jsx("div", { children: /* @__PURE__ */ jsx("button", { type: "button", className: "lb-btn lb-btn-plain", onClick: () => void loadMapData(timeWindow), children: t("retry") }) })
      ] }) }) : nodes.length === 0 ? /* @__PURE__ */ jsxs(
        "div",
        {
          "data-testid": "map-empty-state",
          className: "lb:flex lb:flex-col lb:items-center lb:justify-center lb:h-full lb:p-8 lb:text-center lb:gap-2",
          children: [
            /* @__PURE__ */ jsx("h3", { className: "lb:text-[15px] lb:font-medium lb:text-[var(--color-foreground)]", children: t("mapNoNodes") }),
            /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:max-w-sm", children: t("mapEmptyNextStep") })
          ]
        }
      ) : viewMode === "visual" ? (
        /* Visual Graph View */
        /* @__PURE__ */ jsx(
          "div",
          {
            id: "panel-map-visual",
            role: "tabpanel",
            "aria-labelledby": "tab-map-visual",
            className: "lb:w-full lb:h-full lb:min-h-[500px] lb:flex lb:items-center lb:justify-center lb:p-4 lb:overflow-auto",
            children: /* @__PURE__ */ jsxs(
              "svg",
              {
                viewBox: "0 0 700 480",
                className: "lb:w-full lb:max-w-3xl lb:h-auto lb:max-h-[520px] lb:select-none",
                children: [
                  /* @__PURE__ */ jsxs("defs", { children: [
                    /* @__PURE__ */ jsx(
                      "marker",
                      {
                        id: "arrow-default",
                        viewBox: "0 0 10 10",
                        refX: "9",
                        refY: "5",
                        markerUnits: "userSpaceOnUse",
                        markerWidth: "12",
                        markerHeight: "12",
                        orient: "auto-start-reverse",
                        children: /* @__PURE__ */ jsx("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "var(--color-muted-foreground)", fillOpacity: "0.7" })
                      }
                    ),
                    /* @__PURE__ */ jsx(
                      "marker",
                      {
                        id: "arrow-live",
                        viewBox: "0 0 10 10",
                        refX: "9",
                        refY: "5",
                        markerUnits: "userSpaceOnUse",
                        markerWidth: "12",
                        markerHeight: "12",
                        orient: "auto-start-reverse",
                        children: /* @__PURE__ */ jsx("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "var(--color-success)" })
                      }
                    )
                  ] }),
                  edges.map((edge) => {
                    const fromCoord = nodeCoordinates.get(edge.from);
                    const toCoord = nodeCoordinates.get(edge.to);
                    if (!fromCoord || !toCoord) return null;
                    const strokeWidth = Math.min(8, Math.max(2, Math.log2(edge.count + 1) * 2));
                    const len = Math.hypot(toCoord.x - fromCoord.x, toCoord.y - fromCoord.y) || 1;
                    const ux = (toCoord.x - fromCoord.x) / len;
                    const uy = (toCoord.y - fromCoord.y) / len;
                    const g1 = edgeGap(ux, uy, labelChars(edge.from));
                    const g2 = edgeGap(-ux, -uy, labelChars(edge.to));
                    const x1 = fromCoord.x + ux * g1;
                    const y1 = fromCoord.y + uy * g1;
                    const x2 = toCoord.x - ux * g2;
                    const y2 = toCoord.y - uy * g2;
                    const midX = (x1 + x2) / 2 - uy * 18;
                    const midY = (y1 + y2) / 2 + ux * 18;
                    return /* @__PURE__ */ jsxs(
                      "g",
                      {
                        className: "lb:cursor-pointer lb:group",
                        onClick: () => handleEdgeClick(edge),
                        children: [
                          /* @__PURE__ */ jsx(
                            "line",
                            {
                              x1,
                              y1,
                              x2,
                              y2,
                              stroke: "transparent",
                              strokeWidth: "24"
                            }
                          ),
                          /* @__PURE__ */ jsx(
                            "line",
                            {
                              x1,
                              y1,
                              x2,
                              y2,
                              stroke: edge.live ? "var(--color-success)" : "var(--color-muted-foreground)",
                              strokeOpacity: edge.live ? 1 : 0.7,
                              strokeWidth,
                              strokeDasharray: edge.live ? "6,4" : void 0,
                              className: edge.live ? "lb:motion-safe:animate-pulse" : "",
                              markerEnd: edge.live ? "url(#arrow-live)" : "url(#arrow-default)"
                            }
                          ),
                          /* @__PURE__ */ jsx(
                            "rect",
                            {
                              x: midX - 14,
                              y: midY - 10,
                              width: "28",
                              height: "20",
                              rx: "4",
                              fill: "var(--color-card)",
                              stroke: edge.live ? "var(--color-success)" : "var(--color-border)",
                              strokeWidth: "1"
                            }
                          ),
                          /* @__PURE__ */ jsx(
                            "text",
                            {
                              x: midX,
                              y: midY + 4,
                              textAnchor: "middle",
                              fontSize: "12",
                              fontWeight: "bold",
                              fill: edge.live ? "var(--color-success)" : "var(--color-muted-foreground)",
                              children: edge.count
                            }
                          )
                        ]
                      },
                      `${edge.from}->${edge.to}`
                    );
                  }),
                  nodes.map((node) => {
                    const coord = nodeCoordinates.get(node.bot) || { x: 350, y: 240 };
                    const botColor2 = node.display?.color || "#38bdf8";
                    const isWorking = node.status === "working";
                    const isPaused = node.status === "paused";
                    const isOffline = node.status === "offline";
                    return /* @__PURE__ */ jsxs(
                      "g",
                      {
                        transform: `translate(${coord.x}, ${coord.y})`,
                        className: "lb:cursor-pointer lb:group",
                        onClick: () => onSelectBot?.(node.bot),
                        children: [
                          !faceSrc(node.display?.avatar, node.status) && /* @__PURE__ */ jsx(
                            "circle",
                            {
                              r: "22",
                              fill: "var(--color-card)",
                              stroke: botColor2,
                              strokeWidth: "2"
                            }
                          ),
                          faceSrc(node.display?.avatar, node.status) ? /* @__PURE__ */ jsx(
                            "image",
                            {
                              href: faceSrc(node.display?.avatar, node.status),
                              x: "-24",
                              y: "-24",
                              width: "48",
                              height: "48",
                              preserveAspectRatio: "xMidYMid meet"
                            }
                          ) : /* @__PURE__ */ jsx(
                            "text",
                            {
                              y: "5",
                              textAnchor: "middle",
                              fontSize: "15",
                              fontWeight: "bold",
                              fill: "var(--color-foreground)",
                              children: faceText(node)
                            }
                          ),
                          (isWorking || isPaused || isOffline) && /* @__PURE__ */ jsx(
                            "circle",
                            {
                              "data-testid": "map-state-dot",
                              cx: "17",
                              cy: "17",
                              r: "5",
                              fill: isWorking ? "var(--color-success)" : isPaused ? "var(--color-warning)" : "var(--color-destructive)",
                              stroke: "var(--color-background)",
                              strokeWidth: "2"
                            }
                          ),
                          /* @__PURE__ */ jsx(
                            "text",
                            {
                              y: "38",
                              textAnchor: "middle",
                              stroke: "var(--color-background)",
                              strokeWidth: "4",
                              strokeLinejoin: "round",
                              paintOrder: "stroke",
                              fontSize: "12",
                              fontWeight: "bold",
                              fill: "var(--color-foreground)",
                              children: node.display?.label || node.bot
                            }
                          ),
                          /* @__PURE__ */ jsx(
                            "text",
                            {
                              y: "50",
                              textAnchor: "middle",
                              stroke: "var(--color-background)",
                              strokeWidth: "4",
                              strokeLinejoin: "round",
                              paintOrder: "stroke",
                              fontSize: "12",
                              fill: "var(--color-muted-foreground)",
                              children: botStatusLabel(node.status, t)
                            }
                          )
                        ]
                      },
                      node.bot
                    );
                  })
                ]
              }
            )
          }
        )
      ) : (
        /* Accessible Keyboard Navigation List View */
        /* @__PURE__ */ jsxs(
          "div",
          {
            id: "panel-map-accessible",
            role: "tabpanel",
            "aria-labelledby": "tab-map-accessible",
            className: "lb:p-4 lb:space-y-6 lb:max-w-4xl lb:mx-auto",
            children: [
              /* @__PURE__ */ jsxs("div", { className: "lb:space-y-3", children: [
                /* @__PURE__ */ jsxs("h2", { className: "lb:text-[13px] lb:font-bold lb:text-[var(--color-muted-foreground)]", children: [
                  t("mapNodesSection"),
                  " (",
                  nodes.length,
                  ")"
                ] }),
                /* @__PURE__ */ jsx("ul", { className: "lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-3", "aria-label": t("mapNodesSection"), children: nodes.map((node) => {
                  const botColor2 = node.display?.color || "#38bdf8";
                  const isWorking = node.status === "working";
                  const isPaused = node.status === "paused";
                  const isOffline = node.status === "offline";
                  return /* @__PURE__ */ jsxs(
                    "li",
                    {
                      className: "lb:p-3.5 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:flex lb:flex-col lb:justify-between lb:gap-2.5",
                      children: [
                        /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-start lb:justify-between lb:gap-2", children: [
                          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2.5", children: [
                            /* @__PURE__ */ jsx(
                              "span",
                              {
                                className: "lb:w-3.5 lb:h-3.5 lb:rounded-full lb:shrink-0",
                                style: { backgroundColor: botColor2 }
                              }
                            ),
                            /* @__PURE__ */ jsxs("div", { children: [
                              /* @__PURE__ */ jsx("span", { className: "lb:text-[13px] lb:font-bold lb:text-[var(--color-card-foreground)] lb:block", children: node.display?.label || node.bot }),
                              /* @__PURE__ */ jsxs("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)] lb:block", children: [
                                "@",
                                node.bot,
                                " \xB7 ",
                                node.display?.role || t("btnProfile")
                              ] })
                            ] })
                          ] }),
                          /* @__PURE__ */ jsxs(
                            "span",
                            {
                              role: "status",
                              className: `lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:flex lb:items-center lb:gap-1.5 ${isWorking ? "lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)]" : isPaused ? "lb:bg-[var(--color-warning)]/15 lb:text-[var(--color-warning)]" : isOffline ? "lb:bg-[var(--color-destructive)]/15 lb:text-[var(--color-destructive)]" : "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]"}`,
                              children: [
                                isWorking && /* @__PURE__ */ jsx("span", { className: "lb:w-1.5 lb:h-1.5 lb:rounded-full lb:bg-[var(--color-success)] lb:motion-safe:animate-pulse" }),
                                botStatusLabel(node.status, t)
                              ]
                            }
                          )
                        ] }),
                        /* @__PURE__ */ jsxs("div", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)] lb:space-y-1 lb:border-t lb:border-[var(--color-border)]/50 lb:pt-2", children: [
                          /* @__PURE__ */ jsx("p", { className: "lb:truncate", children: node.current_task?.title ? t("mapCurrentTask", { task: node.current_task.title }) : t("mapNoTask") }),
                          /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:gap-2", children: [
                            /* @__PURE__ */ jsx("span", { children: t("mapRoomsCount", { count: node.rooms?.length || 0 }) }),
                            /* @__PURE__ */ jsx("span", { className: "lb:font-mono lb:font-medium lb:text-[var(--color-foreground)]", children: t("mapCostWeek", { cost: formatCost(node.week_cost_cents) }) })
                          ] })
                        ] }),
                        onSelectBot && /* @__PURE__ */ jsx(
                          "button",
                          {
                            type: "button",
                            onClick: () => onSelectBot(node.bot),
                            className: "lb:w-full lb:mt-1 lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:hover:bg-[var(--lb-fill-2)] lb:text-[var(--color-card-foreground)] lb:motion-safe:transition-colors lb:min-h-11 lb:md:min-h-7 lb:flex lb:items-center lb:justify-center focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                            children: t("btnProfile")
                          }
                        )
                      ]
                    },
                    node.bot
                  );
                }) })
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "lb:space-y-3", children: [
                /* @__PURE__ */ jsxs("h2", { className: "lb:text-[13px] lb:font-bold lb:text-[var(--color-muted-foreground)]", children: [
                  t("mapEdgesSection"),
                  " (",
                  edges.length,
                  ")"
                ] }),
                edges.length === 0 ? /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:italic", children: t("mapNoEdges") }) : /* @__PURE__ */ jsx("ul", { className: "lb:space-y-2", "aria-label": t("mapEdgesSection"), children: edges.map((edge) => /* @__PURE__ */ jsxs(
                  "li",
                  {
                    "data-testid": "map-handoff-item",
                    className: "lb:p-3 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:flex lb:flex-wrap lb:items-center lb:justify-between lb:gap-3",
                    children: [
                      /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-3", children: [
                        /* @__PURE__ */ jsxs("span", { className: "lb:font-mono lb:font-bold lb:text-[13px] lb:text-[var(--color-primary)]", children: [
                          "@",
                          edge.from
                        ] }),
                        /* @__PURE__ */ jsx(ArrowRightIcon, { size: 13, className: "lb:text-[var(--color-muted-foreground)]" }),
                        /* @__PURE__ */ jsxs("span", { className: "lb:font-mono lb:font-bold lb:text-[13px] lb:text-[var(--color-primary)]", children: [
                          "@",
                          edge.to
                        ] }),
                        edge.live && /* @__PURE__ */ jsxs("span", { className: "lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)] lb:flex lb:items-center lb:gap-1", children: [
                          /* @__PURE__ */ jsx("span", { className: "lb:w-1.5 lb:h-1.5 lb:rounded-full lb:bg-[var(--color-success)] lb:motion-safe:animate-pulse" }),
                          t("mapLiveHandoffBadge")
                        ] })
                      ] }),
                      /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-3", children: [
                        /* @__PURE__ */ jsx("span", { className: "lb:text-[13px] lb:font-semibold lb:text-[var(--color-foreground)]", children: t("mapHandoffsCount", { count: edge.count }) }),
                        /* @__PURE__ */ jsx(
                          "button",
                          {
                            type: "button",
                            "data-testid": "map-edge-detail-btn",
                            onClick: () => handleEdgeClick(edge),
                            className: "lb:px-2.5 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-card-foreground)] lb:hover:bg-[var(--lb-fill-2)] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                            children: t("mapHandoffDrawerTitle")
                          }
                        )
                      ] })
                    ]
                  },
                  `${edge.from}->${edge.to}`
                )) })
              ] })
            ]
          }
        )
      ) }),
      /* @__PURE__ */ jsx(
        HandoffDetailDrawer,
        {
          isOpen: drawerOpen,
          edge: selectedEdge,
          onClose: () => setDrawerOpen(false),
          onNavigateToKanban
        }
      )
    ] });
  }

  // dashboard/src/components/search/HighlightedSnippet.tsx
  function HighlightedSnippet({
    text,
    query,
    className = ""
  }) {
    if (!text) return null;
    if (!query || !query.trim()) {
      return /* @__PURE__ */ jsx("span", { className, children: text });
    }
    const trimmed = query.trim();
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(${escaped})`, "gi");
    const parts = text.split(regex);
    return /* @__PURE__ */ jsx("span", { className, children: parts.map((part, idx) => {
      if (part.toLowerCase() === trimmed.toLowerCase()) {
        return /* @__PURE__ */ jsx(
          "mark",
          {
            className: "lb:bg-[var(--color-warning)]/30 lb:text-[var(--color-card-foreground)] lb:font-medium lb:px-0.5 lb:rounded-xs",
            children: part
          },
          idx
        );
      }
      return /* @__PURE__ */ jsx(react_default.Fragment, { children: part }, idx);
    }) });
  }

  // dashboard/src/components/search/CommandPaletteModal.tsx
  function CommandPaletteModal({
    isOpen,
    onClose,
    availableBots = [],
    availableRooms = [],
    botsStatus = "ready",
    onRetryBots,
    initialSearchData,
    onNavigateTab,
    onSelectBot,
    onSelectRoom,
    onOpenCreateBot,
    onOpenCreateRoom,
    onConfirmPauseAll,
    onSelectPage
  }) {
    const { t } = useLuveI18n();
    const [query, setQuery] = useState("");
    const [selectedCategory, setSelectedCategory] = useState("all");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [searchResults, setSearchResults] = useState(
      initialSearchData || null
    );
    const [isLoading, setIsLoading] = useState(false);
    const [confirmPauseAllOpen, setConfirmPauseAllOpen] = useState(false);
    const inputRef = useRef(null);
    const modalRef = useFocusTrap({
      isOpen: isOpen && !confirmPauseAllOpen,
      onClose,
      initialFocusRef: inputRef
    });
    const confirmModalRef = useFocusTrap({
      isOpen: confirmPauseAllOpen,
      onClose: () => setConfirmPauseAllOpen(false)
    });
    useEffect(() => {
      if (isOpen) {
        setQuery("");
        setSelectedIndex(0);
        setConfirmPauseAllOpen(false);
        if (initialSearchData) {
          setSearchResults(initialSearchData);
        } else {
          setSearchResults(null);
        }
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    }, [isOpen, initialSearchData]);
    const quickActions = useMemo(() => [
      {
        id: "act-new-bot",
        title: t("searchActionNewBot"),
        description: t("searchActionNewBotDesc"),
        actionKey: "new_bot",
        category: "actions"
      },
      {
        id: "act-new-room",
        title: t("searchActionNewRoom"),
        description: t("searchActionNewRoomDesc"),
        actionKey: "new_room",
        category: "actions"
      },
      {
        id: "act-approvals",
        title: t("searchActionApprovals"),
        description: t("searchActionApprovalsDesc"),
        actionKey: "approvals",
        category: "actions"
      },
      {
        id: "act-activity",
        title: t("searchActionActivity"),
        description: t("searchActionActivityDesc"),
        actionKey: "activity",
        category: "actions"
      },
      {
        id: "act-routines",
        title: t("searchActionRoutines"),
        description: t("searchActionRoutinesDesc"),
        actionKey: "routines",
        category: "actions"
      },
      {
        id: "act-map",
        title: t("searchActionMap"),
        description: t("searchActionMapDesc"),
        actionKey: "map",
        category: "actions"
      },
      {
        id: "act-costs",
        title: t("searchActionCosts"),
        description: t("searchActionCostsDesc"),
        actionKey: "costs",
        category: "actions"
      },
      // D2: offered only when the caller wires a real pause; a confirmation that does nothing is not an action
      ...onConfirmPauseAll ? [{
        id: "act-pause-all",
        title: t("searchActionPauseAll"),
        description: t("searchActionPauseAllDesc"),
        actionKey: "pause_all",
        category: "actions",
        requiresConfirmation: true,
        confirmMessage: t("searchConfirmPauseAllBody")
      }] : []
    ], [t, onConfirmPauseAll]);
    const handleAction = useCallback(
      (actionKey, requiresConfirmation = false) => {
        if (requiresConfirmation) {
          setConfirmPauseAllOpen(true);
          return;
        }
        switch (actionKey) {
          case "new_bot":
            onOpenCreateBot?.();
            onClose();
            break;
          case "new_room":
            onOpenCreateRoom?.();
            onClose();
            break;
          case "approvals":
            onNavigateTab?.("aprovacoes");
            onClose();
            break;
          case "activity":
            onNavigateTab?.("atividade");
            onClose();
            break;
          case "routines":
            onNavigateTab?.("rotinas");
            onClose();
            break;
          case "map":
            onNavigateTab?.("mapa");
            onClose();
            break;
          case "costs":
            onNavigateTab?.("custos");
            onClose();
            break;
          case "pause_all":
            onConfirmPauseAll?.();
            onClose();
            break;
          default:
            onClose();
            break;
        }
      },
      [
        onConfirmPauseAll,
        onClose,
        onOpenCreateBot,
        onOpenCreateRoom,
        onNavigateTab
      ]
    );
    const matchActions = useCallback((q) => {
      const lower = q.trim().toLowerCase();
      return quickActions.filter((a) => a.title.toLowerCase().includes(lower) || a.description?.toLowerCase().includes(lower));
    }, [quickActions]);
    const executeSearch = useCallback(
      async (q, category) => {
        if (!q.trim()) {
          setSearchResults(null);
          return;
        }
        try {
          setIsLoading(true);
          const typesParam = category === "all" ? "messages,bots,rooms,routines,files,actions" : category;
          const res = await searchLuveBot({
            q: q.trim(),
            types: typesParam,
            limit: 10
          });
          const local = category === "all" || category === "actions" ? matchActions(q) : [];
          const keys = new Set(local.map((a) => a.actionKey));
          setSearchResults({ ...res, actions: [...local, ...(res.actions ?? []).filter((a) => !keys.has(a.actionKey))] });
        } catch {
          const lower = q.toLowerCase();
          const fallbackBots = availableBots.filter(
            (b) => b.name.toLowerCase().includes(lower) || b.display?.label.toLowerCase().includes(lower) || b.description?.toLowerCase().includes(lower)
          ).map((b) => ({
            name: b.name,
            display: b.display,
            description: b.description,
            status: b.status
          }));
          const fallbackRooms = availableRooms.filter((r) => r.name.toLowerCase().includes(lower)).map((r) => ({
            id: r.id,
            name: r.name,
            goal: r.goal,
            members_count: r.members.length
          }));
          setSearchResults({
            messages: [],
            bots: fallbackBots,
            rooms: fallbackRooms,
            routines: [],
            files: [],
            actions: matchActions(q)
          });
        } finally {
          setIsLoading(false);
        }
      },
      [availableBots, availableRooms, matchActions]
    );
    useEffect(() => {
      if (!initialSearchData) {
        const timer = setTimeout(() => {
          if (query.trim()) {
            executeSearch(query, selectedCategory);
          } else {
            setSearchResults(null);
          }
        }, 150);
        return () => clearTimeout(timer);
      }
    }, [query, selectedCategory, executeSearch, initialSearchData]);
    const [pageHits, setPageHits] = useState([]);
    const botsKey = availableBots.map((b) => `${b.name}\0${b.display?.label ?? ""}`).join("");
    const botsRef = useRef(availableBots);
    botsRef.current = availableBots;
    useEffect(() => {
      const q = query.trim();
      if (!onSelectPage || q.length < 2 || selectedCategory !== "all" && selectedCategory !== "pages") {
        setPageHits((h) => h.length ? [] : h);
        return;
      }
      let alive = true;
      const timer = setTimeout(async () => {
        const results = await Promise.allSettled(botsRef.current.map((b) => listPages(b.name, q).then((r) => ({ b, r }))));
        if (!alive) return;
        const hits = results.flatMap((x) => x.status === "fulfilled" && (x.value.r.workspace?.state === "ready" || x.value.r.workspace?.state === "empty") ? x.value.r.pages.map((page) => ({ bot: x.value.b.name, botLabel: x.value.b.display?.label || x.value.b.name, page })) : []);
        setPageHits(hits.slice(0, 10));
      }, 250);
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }, [query, selectedCategory, botsKey, onSelectPage]);
    const displayedItems = useMemo(() => {
      const items = [];
      if (!query.trim() && (!searchResults || Object.keys(searchResults).length === 0)) {
        quickActions.forEach((act) => {
          items.push({
            id: act.id,
            category: "actions",
            title: act.title,
            subtitle: act.description,
            shortcut: act.shortcut,
            requiresConfirmation: act.requiresConfirmation,
            onSelect: () => handleAction(act.actionKey, act.requiresConfirmation)
          });
        });
        return items;
      }
      if (!searchResults) return items;
      if (selectedCategory === "all" || selectedCategory === "actions") {
        (searchResults.actions || []).forEach((act) => {
          items.push({
            id: act.id,
            category: "actions",
            title: act.title,
            subtitle: act.description,
            shortcut: act.shortcut,
            requiresConfirmation: act.requiresConfirmation,
            onSelect: () => handleAction(act.actionKey, act.requiresConfirmation)
          });
        });
      }
      if (selectedCategory === "all" || selectedCategory === "bots") {
        (searchResults.bots || []).forEach((bot) => {
          items.push({
            id: `bot-${bot.name}`,
            category: "bots",
            title: bot.display?.label || bot.name,
            subtitle: `@${bot.name} \xB7 ${bot.description || bot.display?.role || ""}`,
            badge: bot.status,
            onSelect: () => {
              onSelectBot?.(bot.name);
              onClose();
            }
          });
        });
      }
      if (selectedCategory === "all" || selectedCategory === "rooms") {
        (searchResults.rooms || []).forEach((room) => {
          items.push({
            id: `room-${room.id}`,
            category: "rooms",
            title: room.name,
            subtitle: room.goal || t("roomMembersCount", { count: room.members_count }),
            badge: t("searchCategoryRooms"),
            onSelect: () => {
              onSelectRoom?.(room.id);
              onClose();
            }
          });
        });
      }
      if (selectedCategory === "all" || selectedCategory === "messages") {
        (searchResults.messages || []).forEach((msg, idx) => {
          items.push({
            id: `msg-${msg.session_id}-${idx}`,
            category: "messages",
            title: msg.title || t("searchHitFromBot", { bot: msg.bot }),
            subtitle: t("searchHitFromBot", { bot: msg.bot }),
            snippet: msg.snippet,
            onSelect: () => {
              if (msg.links?.room_id) {
                onSelectRoom?.(msg.links.room_id);
              } else if (msg.bot) {
                onSelectBot?.(msg.bot);
              }
              onClose();
            }
          });
        });
      }
      if (selectedCategory === "all" || selectedCategory === "routines") {
        (searchResults.routines || []).forEach((routine) => {
          items.push({
            id: `routine-${routine.id}`,
            category: "routines",
            title: routine.name,
            subtitle: `@${routine.bot} \xB7 ${routine.schedule}`,
            badge: routine.paused ? t("statusPausedLabel") : t("statusWorkingLabel"),
            onSelect: () => {
              onNavigateTab?.("rotinas");
              onClose();
            }
          });
        });
      }
      if (selectedCategory === "all" || selectedCategory === "files") {
        (searchResults.files || []).forEach((file, idx) => {
          items.push({
            id: `file-${file.name}-${idx}`,
            category: "files",
            title: file.name,
            subtitle: file.path,
            onSelect: () => {
              onClose();
            }
          });
        });
      }
      if (selectedCategory === "all" || selectedCategory === "pages") {
        pageHits.forEach(({ bot, botLabel, page }) => {
          items.push({
            id: `page-${bot}-${page.slug}`,
            category: "pages",
            title: page.title,
            subtitle: t("pageOfBot", { name: botLabel }),
            snippet: page.excerpt || void 0,
            onSelect: () => {
              onSelectPage?.(bot, page.slug);
              onClose();
            }
          });
        });
      }
      return items;
    }, [
      pageHits,
      onSelectPage,
      query,
      searchResults,
      selectedCategory,
      quickActions,
      handleAction,
      onSelectBot,
      onSelectRoom,
      onNavigateTab,
      onClose,
      t
    ]);
    useEffect(() => {
      if (selectedIndex >= displayedItems.length) {
        setSelectedIndex(Math.max(0, displayedItems.length - 1));
      }
    }, [displayedItems.length, selectedIndex]);
    const handleKeyDown = (e) => {
      if (confirmPauseAllOpen) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % Math.max(1, displayedItems.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(
          (prev) => prev <= 0 ? Math.max(0, displayedItems.length - 1) : prev - 1
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const current = displayedItems[selectedIndex];
        if (current) {
          current.onSelect();
        }
      }
    };
    if (!isOpen) return null;
    const categories = [
      { id: "all", label: t("searchCategoryAll") },
      { id: "messages", label: t("searchCategoryMessages") },
      { id: "bots", label: t("searchCategoryBots") },
      { id: "rooms", label: t("searchCategoryRooms") },
      { id: "routines", label: t("searchCategoryRoutines") },
      { id: "actions", label: t("searchCategoryActions") },
      ...onSelectPage ? [{ id: "pages", label: t("pagesSearchCategory") }] : []
    ];
    return /* @__PURE__ */ jsxs(
      "div",
      {
        className: "lb-dialog-overlay",
        style: { alignItems: "flex-start", paddingTop: 64 },
        onClick: (e) => {
          if (e.target === e.currentTarget) onClose();
        },
        children: [
          /* @__PURE__ */ jsxs(
            "div",
            {
              ref: modalRef,
              role: "dialog",
              "aria-modal": "true",
              "aria-label": t("searchPaletteTitle"),
              tabIndex: -1,
              onKeyDown: handleKeyDown,
              className: "lb-dialog lb:max-w-2xl lb:overflow-y-auto",
              children: [
                /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-3 lb:px-4 lb:py-3.5 lb:border-b lb:border-[var(--lb-separator)] lb:shrink-0", children: [
                  /* @__PURE__ */ jsx(SearchIcon, { size: 18, className: "lb:text-[var(--color-muted-foreground)] lb:shrink-0" }),
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      ref: inputRef,
                      type: "text",
                      role: "combobox",
                      "aria-expanded": "true",
                      "aria-autocomplete": "list",
                      "aria-controls": "palette-results-list",
                      "aria-activedescendant": displayedItems[selectedIndex] ? `item-${displayedItems[selectedIndex].id}` : void 0,
                      placeholder: t("searchPlaceholderInput"),
                      value: query,
                      onChange: (e) => {
                        setQuery(e.target.value);
                        setSelectedIndex(0);
                      },
                      className: "lb:flex-1 lb:bg-transparent lb:border-none lb:text-[15px] lb:text-[var(--color-card-foreground)] lb:placeholder-[var(--color-muted-foreground)] focus:lb:outline-none"
                    }
                  ),
                  query && /* @__PURE__ */ jsx(
                    "button",
                    {
                      type: "button",
                      "aria-label": t("clearSearch"),
                      onClick: () => {
                        setQuery("");
                        setSelectedIndex(0);
                      },
                      className: "lb:p-1 lb:rounded-lg lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-card-foreground)] lb:min-h-11 lb:min-w-11 lb:flex lb:items-center lb:justify-center focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none",
                      children: /* @__PURE__ */ jsx(XIcon, { size: 14 })
                    }
                  ),
                  /* @__PURE__ */ jsx("kbd", { className: "lb:hidden lb:sm:inline-flex lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-mono lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)]", children: "ESC" })
                ] }),
                /* @__PURE__ */ jsx("div", { className: "lb:flex lb:items-center lb:gap-1 lb:px-4 lb:py-2 lb:border-b lb:border-[var(--lb-separator)] lb:bg-[var(--color-popover)]/60 lb:overflow-x-auto lb:shrink-0", children: categories.map((cat) => /* @__PURE__ */ jsx(
                  "button",
                  {
                    type: "button",
                    onClick: () => {
                      setSelectedCategory(cat.id);
                      setSelectedIndex(0);
                      if (query.trim()) {
                        executeSearch(query, cat.id);
                      }
                    },
                    "aria-pressed": selectedCategory === cat.id,
                    className: `lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:whitespace-nowrap lb:min-h-11 lb:md:min-h-7 lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full ${selectedCategory === cat.id ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-foreground)] lb:border-[var(--lb-separator)]" : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"}`,
                    children: cat.label
                  },
                  cat.id
                )) }),
                /* @__PURE__ */ jsx(
                  "div",
                  {
                    id: "palette-results-list",
                    role: "listbox",
                    "aria-label": t("searchResultsHeader"),
                    className: "lb:flex-1 lb:overflow-y-auto lb:p-2 lb:space-y-1",
                    children: isLoading || botsStatus === "loading" && displayedItems.length === 0 ? /* @__PURE__ */ jsx("div", { className: "lb:p-8 lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]", children: /* @__PURE__ */ jsx("span", { className: "lb:animate-pulse", children: isLoading ? t("searchLoading") : t("loadingBots") }) }) : botsStatus === "error" && displayedItems.length === 0 ? /* @__PURE__ */ jsx(BotsError, { onRetry: onRetryBots }) : displayedItems.length === 0 ? /* @__PURE__ */ jsxs(
                      "div",
                      {
                        "data-testid": "search-empty-state",
                        className: "lb:p-8 lb:text-center lb:flex lb:flex-col lb:items-center lb:justify-center lb:gap-1.5 lb:text-[13px] lb:text-[var(--color-muted-foreground)]",
                        children: [
                          /* @__PURE__ */ jsx("span", { className: "lb:font-medium lb:text-[var(--color-foreground)]", children: query.trim() ? t("searchNoResults", { query }) : t("searchEmptyPrompt") }),
                          /* @__PURE__ */ jsx("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)]", children: t("searchEmptyNextStep") })
                        ]
                      }
                    ) : displayedItems.map((item2, idx) => {
                      const isSelected = idx === selectedIndex;
                      return /* @__PURE__ */ jsxs(
                        "div",
                        {
                          id: `item-${item2.id}`,
                          role: "option",
                          "aria-selected": isSelected,
                          onClick: () => item2.onSelect(),
                          onMouseEnter: () => setSelectedIndex(idx),
                          className: `lb:px-3 lb:py-2.5 lb:rounded-2xl lb:flex lb:items-center lb:justify-between lb:gap-3 lb:cursor-pointer lb:motion-safe:transition-colors lb:min-h-11 ${isSelected ? "lb:bg-[var(--color-primary)]/10 lb:text-[var(--color-foreground)]" : "lb:hover:bg-[var(--lb-fill-2)] lb:text-[var(--color-card-foreground)]"}`,
                          children: [
                            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-start lb:gap-3 lb:min-w-0", children: [
                              /* @__PURE__ */ jsxs("span", { className: "lb:mt-0.5 lb:text-[var(--color-muted-foreground)] lb:shrink-0", children: [
                                item2.category === "bots" && /* @__PURE__ */ jsx(BotIcon, { size: 15 }),
                                item2.category === "rooms" && /* @__PURE__ */ jsx(NetworkIcon, { size: 15 }),
                                item2.category === "actions" && /* @__PURE__ */ jsx(PlusIcon, { size: 15 }),
                                item2.category === "routines" && /* @__PURE__ */ jsx(ClockIcon, { size: 15 }),
                                item2.category === "messages" && /* @__PURE__ */ jsx(HashIcon, { size: 15 })
                              ] }),
                              /* @__PURE__ */ jsxs("div", { className: "lb:min-w-0", children: [
                                /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2", children: [
                                  /* @__PURE__ */ jsx("span", { className: "lb:text-[13px] lb:font-semibold lb:truncate", children: item2.title }),
                                  item2.badge && /* @__PURE__ */ jsx("span", { className: "lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-medium lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)]", children: item2.badge })
                                ] }),
                                item2.subtitle && /* @__PURE__ */ jsx("span", { className: "lb:text-xs lb:text-[var(--color-muted-foreground)] lb:block lb:truncate", children: item2.subtitle }),
                                item2.snippet && /* @__PURE__ */ jsx("div", { className: "lb:mt-1 lb:p-1.5 lb:rounded-lg lb:bg-[var(--lb-fill)] lb:border-[var(--color-border)]/50 lb:text-xs", children: /* @__PURE__ */ jsx(HighlightedSnippet, { text: item2.snippet, query }) })
                              ] })
                            ] }),
                            /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-2 lb:shrink-0", children: [
                              item2.shortcut && /* @__PURE__ */ jsx("kbd", { className: "lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-mono lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)]", children: item2.shortcut }),
                              isSelected && /* @__PURE__ */ jsxs("span", { className: "lb:text-xs lb:font-medium lb:text-[var(--color-primary)] lb:hidden lb:sm:inline-flex lb:items-center lb:gap-1", children: [
                                t("searchOpenModalAction"),
                                " \u21B5"
                              ] })
                            ] })
                          ]
                        },
                        item2.id
                      );
                    })
                  }
                ),
                /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-between lb:px-4 lb:py-2.5 lb:border-t lb:border-[var(--lb-separator)] lb:bg-[var(--color-popover)]/60 lb:text-xs lb:text-[var(--color-muted-foreground)] lb:shrink-0", children: [
                  /* @__PURE__ */ jsx("span", { children: t("searchResultCount", { count: displayedItems.length }) }),
                  /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:gap-3", children: [
                    /* @__PURE__ */ jsxs("span", { children: [
                      "\u2191\u2193 ",
                      t("searchNavigateAction")
                    ] }),
                    /* @__PURE__ */ jsxs("span", { children: [
                      "\u21B5 ",
                      t("searchOpenModalAction")
                    ] }),
                    /* @__PURE__ */ jsxs("span", { children: [
                      "Esc ",
                      t("close")
                    ] })
                  ] })
                ] })
              ]
            }
          ),
          confirmPauseAllOpen && /* @__PURE__ */ jsx(
            "div",
            {
              className: "lb-dialog-overlay",
              style: { zIndex: 60 },
              onClick: (e) => {
                if (e.target === e.currentTarget) setConfirmPauseAllOpen(false);
              },
              children: /* @__PURE__ */ jsxs(
                "div",
                {
                  ref: confirmModalRef,
                  role: "dialog",
                  "aria-modal": "true",
                  "aria-labelledby": "confirm-pause-title",
                  tabIndex: -1,
                  className: "lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto",
                  children: [
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-start lb:justify-between lb:gap-3", children: [
                      /* @__PURE__ */ jsx(
                        "h2",
                        {
                          id: "confirm-pause-title",
                          className: "lb-title lb:text-[var(--color-destructive)]",
                          children: t("searchConfirmPauseAllTitle")
                        }
                      ),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          onClick: () => setConfirmPauseAllOpen(false),
                          "aria-label": t("close"),
                          className: "lb-icon-btn",
                          style: { background: "var(--lb-fill)" },
                          children: /* @__PURE__ */ jsx(XIcon, { size: 16 })
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsx("p", { className: "lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:leading-relaxed", children: t("searchConfirmPauseAllBody") }),
                    /* @__PURE__ */ jsxs("div", { className: "lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2", children: [
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          onClick: () => setConfirmPauseAllOpen(false),
                          className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-card-foreground)] lb:hover:bg-[var(--lb-fill-2)] lb:min-h-11 lb:md:min-h-8 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full",
                          children: t("cancelBtn")
                        }
                      ),
                      /* @__PURE__ */ jsx(
                        "button",
                        {
                          type: "button",
                          "data-testid": "btn-confirm-pause-all",
                          onClick: async () => {
                            setConfirmPauseAllOpen(false);
                            if (onConfirmPauseAll) {
                              await onConfirmPauseAll();
                            }
                            onClose();
                          },
                          className: "lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-semibold lb:bg-[var(--color-destructive)] lb:text-[var(--color-destructive-foreground)] lb:hover:opacity-90 lb:min-h-11 lb:md:min-h-8 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)] focus-visible:lb:outline-none lb:rounded-full",
                          children: t("searchConfirmPauseAllBtn")
                        }
                      )
                    ] })
                  ]
                }
              )
            }
          )
        ]
      }
    );
  }

  // dashboard/src/components/pages/PagesLibrary.tsx
  var VIEW_KEY = "luvebot:pages:view";
  function savedView() {
    try {
      return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  }
  function PagesLibrary({ bot, onOpen }) {
    const { t, locale } = useLuveI18n();
    const botLabel = bot.display?.label || bot.name;
    const [load, setLoad] = react_default.useState({ kind: "loading" });
    const [feature, setFeature] = react_default.useState("pending");
    const [query, setQuery] = react_default.useState("");
    const [view, setView] = react_default.useState(savedView);
    const [creating, setCreating] = react_default.useState(false);
    const [nonce, setNonce] = react_default.useState(0);
    react_default.useEffect(() => {
      let alive = true;
      setLoad({ kind: "loading" });
      setFeature("pending");
      const blocked = (block) => {
        if (alive) setLoad({ kind: "blocked", block });
      };
      getHealth().then((health) => {
        const f = featureState(health.features?.pages);
        if (f === "ok" || f === "read_only") {
          if (alive) setFeature(f);
        } else blocked(f);
      }, (e) => blocked(blockFromError(e)));
      listPages(bot.name).then((r) => {
        const block = blockOf(r.workspace?.state);
        if (alive) setLoad((prev) => prev.kind === "blocked" ? prev : block ? { kind: "blocked", block } : { kind: "ready", pages: r.pages });
      }, (e) => {
        if (alive) setLoad((prev) => prev.kind === "blocked" ? prev : { kind: "blocked", block: blockFromError(e) });
      });
      return () => {
        alive = false;
      };
    }, [bot.name, nonce]);
    const pick2 = (v) => {
      setView(v);
      try {
        window.localStorage.setItem(VIEW_KEY, v);
      } catch {
      }
    };
    const q = query.trim().toLowerCase();
    const pages = load.kind === "ready" ? load.pages.filter((p) => !q || p.title.toLowerCase().includes(q) || p.slug.includes(q) || p.excerpt.toLowerCase().includes(q)) : [];
    const canCreate = load.kind === "ready" && feature === "ok";
    const when = (iso) => new Date(iso).toLocaleString(locale === "pt" ? "pt-BR" : "en-US", { dateStyle: "short", timeStyle: "short" });
    const meta = (p) => `${p.author_label} \xB7 ${when(p.mtime)}`;
    const mark = (p) => changedSinceSeen(bot.name, p.slug, p.sha) ? /* @__PURE__ */ jsx("span", { role: "img", "aria-label": t("pageChangedMark"), title: t("pageChangedMark"), style: { width: 8, height: 8, borderRadius: 4, background: "var(--color-primary)", flexShrink: 0 } }) : null;
    return /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--color-background)" }, children: [
      /* @__PURE__ */ jsxs("header", { style: { display: "flex", alignItems: "flex-end", gap: 12, padding: "24px 24px 8px", flexWrap: "wrap" }, children: [
        /* @__PURE__ */ jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [
          /* @__PURE__ */ jsxs("div", { className: "lb-caption", style: { display: "flex", alignItems: "center", gap: 6, color: "var(--color-muted-foreground)" }, children: [
            /* @__PURE__ */ jsx(Avatar, { name: botLabel, avatar: bot.display?.avatar, color: bot.display?.color, size: 20 }),
            botLabel
          ] }),
          /* @__PURE__ */ jsx("h1", { className: "lb-large-title", style: { margin: "4px 0 0" }, children: t("pagesTitle") })
        ] }),
        canCreate && /* @__PURE__ */ jsxs("button", { type: "button", onClick: () => setCreating(true), className: "lb-btn lb-btn-primary", children: [
          /* @__PURE__ */ jsx(PlusIcon, { size: 16 }),
          t("pageNewBtn")
        ] })
      ] }),
      load.kind === "ready" && /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 12, alignItems: "center", padding: "8px 24px 16px", flexWrap: "wrap" }, children: [
        /* @__PURE__ */ jsxs("label", { className: "lb-input", style: { display: "flex", alignItems: "center", gap: 8, maxWidth: 420, flex: "1 1 240px" }, children: [
          /* @__PURE__ */ jsx("span", { "aria-hidden": "true", style: { color: "var(--color-muted-foreground)", display: "inline-flex" }, children: /* @__PURE__ */ jsx(SearchIcon, { size: 16 }) }),
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "search",
              "aria-label": t("pagesSearchLabel", { name: botLabel }),
              placeholder: t("pagesSearchLabel", { name: botLabel }),
              value: query,
              onChange: (e) => setQuery(e.target.value),
              style: { flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", font: "inherit", color: "inherit" }
            }
          )
        ] }),
        /* @__PURE__ */ jsx("div", { style: { flex: 1 } }),
        /* @__PURE__ */ jsxs("div", { role: "group", "aria-label": t("pagesViewLabel"), className: "lb-segmented", style: { width: "auto" }, children: [
          /* @__PURE__ */ jsx("button", { type: "button", "aria-pressed": view === "grid", onClick: () => pick2("grid"), className: "lb-segment", style: { padding: "0 12px", flex: "none" }, children: t("pagesViewGrid") }),
          /* @__PURE__ */ jsx("button", { type: "button", "aria-pressed": view === "list", onClick: () => pick2("list"), className: "lb-segment", style: { padding: "0 12px", flex: "none" }, children: t("pagesViewList") })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "0 24px 24px" }, children: [
        load.kind === "loading" && /* @__PURE__ */ jsx("p", { className: "lb-group lb-subhead", style: { padding: "14px 16px" }, children: t("pageLoading") }),
        load.kind === "blocked" && /* @__PURE__ */ jsxs("div", { role: "status", className: "lb-group lb-empty", style: { padding: "24px 20px", display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }, children: [
          load.block === "no_workspace" ? /* @__PURE__ */ jsx(WorkspaceOffer, { bot: bot.name, label: botLabel, isDefault: bot.is_default, onReady: () => setNonce((n) => n + 1) }) : /* @__PURE__ */ jsx("p", { className: "lb-body", style: { margin: 0 }, children: blockText(load.block, { name: bot.name, label: botLabel, isDefault: bot.is_default }, t) }),
          load.block === "error" && /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setNonce((n) => n + 1), className: "lb-btn", children: t("retry") })
        ] }),
        load.kind === "ready" && feature === "read_only" && /* @__PURE__ */ jsx("p", { role: "status", className: "lb-group lb-subhead", style: { padding: "12px 16px", marginTop: 0 }, children: t("pagesReadOnly") }),
        load.kind === "ready" && load.pages.length === 0 && /* @__PURE__ */ jsx("p", { className: "lb-group lb-subhead", style: { padding: "24px 20px" }, children: t("pagesEmpty") }),
        load.kind === "ready" && load.pages.length > 0 && pages.length === 0 && /* @__PURE__ */ jsx("p", { className: "lb-group lb-subhead", style: { padding: "14px 16px" }, children: t("pagesNoMatch") }),
        pages.length > 0 && view === "grid" && /* @__PURE__ */ jsx("ul", { style: { listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }, children: pages.map((p) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsxs("button", { type: "button", onClick: () => onOpen(p.slug), className: "lb-group", style: { width: "100%", minHeight: 160, display: "flex", flexDirection: "column", gap: 8, padding: 16, border: "none", textAlign: "left", cursor: "pointer", color: "inherit" }, children: [
          /* @__PURE__ */ jsxs("span", { className: "lb-headline", style: { display: "flex", alignItems: "center", gap: 8 }, children: [
            mark(p),
            /* @__PURE__ */ jsx("span", { className: "lb-clamp-2", children: p.title })
          ] }),
          /* @__PURE__ */ jsx("span", { className: "lb-caption", style: { flex: 1, color: "var(--color-muted-foreground)", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }, children: p.excerpt }),
          /* @__PURE__ */ jsx("span", { className: "lb-caption", style: { color: "var(--color-muted-foreground)" }, children: meta(p) })
        ] }) }, p.slug)) }),
        pages.length > 0 && view === "list" && /* @__PURE__ */ jsx("ul", { className: "lb-group", style: { listStyle: "none", margin: 0, padding: 0 }, children: pages.map((p) => /* @__PURE__ */ jsx("li", { className: "lb-row lb-row-flat", style: { padding: 0 }, children: /* @__PURE__ */ jsxs("button", { type: "button", onClick: () => onOpen(p.slug), className: "lb-contact", style: { borderRadius: 0, padding: "10px 16px", minHeight: 56 }, children: [
          /* @__PURE__ */ jsxs("span", { className: "lb-row-stack", children: [
            /* @__PURE__ */ jsxs("span", { className: "lb-headline", style: { display: "flex", alignItems: "center", gap: 8 }, children: [
              mark(p),
              /* @__PURE__ */ jsx("span", { className: "lb-truncate", children: p.title })
            ] }),
            p.excerpt && /* @__PURE__ */ jsx("span", { className: "lb-subhead lb-truncate", children: p.excerpt })
          ] }),
          /* @__PURE__ */ jsx("span", { className: "lb-caption", style: { whiteSpace: "nowrap", color: "var(--color-muted-foreground)" }, children: meta(p) })
        ] }) }, p.slug)) })
      ] }),
      /* @__PURE__ */ jsx(
        NewPageDialog,
        {
          open: creating,
          bot: bot.name,
          botLabel,
          onClose: () => setCreating(false),
          onCreated: (page) => {
            setCreating(false);
            onOpen(page.slug);
          }
        }
      )
    ] });
  }

  // dashboard/src/components/pages/DiffView.tsx
  function DiffView({ lines, beforeLabel, afterLabel }) {
    const { t } = useLuveI18n();
    if (!lines) return /* @__PURE__ */ jsx("p", { className: "lb-subhead", children: t("pageDiffTooBig") });
    const changed = lines.some((l) => l.kind !== "same");
    return /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsx("p", { className: "lb-caption", style: { color: "var(--color-muted-foreground)", margin: "0 0 8px" }, children: t("pageDiffLegend", { before: beforeLabel, after: afterLabel }) }),
      !changed ? /* @__PURE__ */ jsx("p", { className: "lb-subhead", children: t("pageDiffSame") }) : /* @__PURE__ */ jsx("ol", { "aria-label": t("pageDiffLabel"), className: "lb-mono", style: { listStyle: "none", margin: 0, padding: 12, borderRadius: 12, background: "var(--lb-fill)", fontSize: 13, lineHeight: "20px", maxHeight: "60vh", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }, children: lines.map((l, i) => /* @__PURE__ */ jsxs("li", { style: {
        background: l.kind === "add" ? "color-mix(in srgb, var(--color-success) 14%, transparent)" : l.kind === "del" ? "color-mix(in srgb, var(--color-destructive) 12%, transparent)" : void 0,
        color: l.kind === "same" ? "var(--color-muted-foreground)" : "var(--color-foreground)",
        padding: "0 6px",
        borderRadius: 4
      }, children: [
        /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: l.kind === "add" ? "+ " : l.kind === "del" ? "\u2212 " : "  " }),
        /* @__PURE__ */ jsx("span", { className: "lb:sr-only", children: l.kind === "add" ? t("pageDiffAdded") : l.kind === "del" ? t("pageDiffRemoved") : "" }),
        l.text
      ] }, i)) })
    ] });
  }

  // dashboard/src/components/pages/PageEditor.tsx
  var bytes = (s) => new TextEncoder().encode(s).length;
  var SIDE_BY_SIDE_MIN = 720;
  function PageEditor({ bot, botLabel, page, onSaved, onDone }) {
    const { t, locale } = useLuveI18n();
    const narrow = useNarrow();
    const [text, setText] = react_default.useState(page.content);
    const [status, setStatus] = react_default.useState({ kind: "saved" });
    const [view, setView] = react_default.useState("source");
    const [dialog, setDialog] = react_default.useState(null);
    const [copied, setCopied] = react_default.useState(false);
    const [expanded, setExpanded] = react_default.useState(false);
    const rootRef = react_default.useRef(null);
    const [width, setWidth] = react_default.useState(Infinity);
    react_default.useEffect(() => {
      const el = rootRef.current;
      const RO = typeof window !== "undefined" ? window.ResizeObserver : void 0;
      if (!el || !RO) return;
      const ro = new RO((entries) => setWidth(entries[0]?.contentRect.width ?? Infinity));
      ro.observe(el);
      return () => ro.disconnect();
    }, []);
    const oneAtATime = narrow || !expanded && width < SIDE_BY_SIDE_MIN;
    const textRef = react_default.useRef(text);
    const base = react_default.useRef(page.sha);
    const saved = react_default.useRef(page.content);
    const current = react_default.useRef(page);
    const lastSave = react_default.useRef(0);
    const inflight = react_default.useRef(false);
    const timer = react_default.useRef(null);
    const statusRef = react_default.useRef(status);
    statusRef.current = status;
    textRef.current = text;
    const dirty = text !== saved.current;
    const schedule = (ms) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), ms);
    };
    async function save() {
      const s = statusRef.current.kind;
      if (inflight.current || s === "conflict" || s === "blocked") return;
      const content = textRef.current;
      if (content === saved.current) return;
      const wait = MIN_SAVE_GAP_MS - (Date.now() - lastSave.current);
      if (wait > 0) {
        schedule(wait);
        return;
      }
      if (bytes(content) > MAX_PAGE_BYTES) {
        setStatus({ kind: "blocked", reason: "too_large" });
        return;
      }
      inflight.current = true;
      setStatus({ kind: "saving" });
      try {
        const r = await savePage(bot, page.slug, { content, base_sha: base.current });
        base.current = r.page.sha;
        saved.current = content;
        current.current = r.page;
        lastSave.current = Date.now();
        setStatus({ kind: "saved", at: /* @__PURE__ */ new Date() });
        onSaved?.(r.page, content);
      } catch (e) {
        const code2 = errCode(e);
        if (code2 === "page_conflict") {
          const label = errDetails(e).changed_by_label;
          setStatus({ kind: "conflict", who: typeof label === "string" && label ? label : botLabel });
        } else if (code2 === "page_redacted") setStatus({ kind: "blocked", reason: "redacted" });
        else if (code2 === "too_large") setStatus({ kind: "blocked", reason: "too_large" });
        else if (code2 === "capability_missing") setStatus({ kind: "blocked", reason: "read_only" });
        else if (code2 === "rate_limited") {
          setStatus({ kind: "dirty" });
          schedule(MIN_SAVE_GAP_MS);
        } else setStatus({ kind: "failed", message: humanError(e, t, "unexpectedError") });
      } finally {
        inflight.current = false;
        lastSave.current = Date.now();
      }
    }
    react_default.useEffect(() => () => {
      if (timer.current) clearTimeout(timer.current);
    }, []);
    react_default.useEffect(() => {
      if (!dirty) return;
      const warn = (e) => {
        e.preventDefault();
        e.returnValue = "";
      };
      window.addEventListener("beforeunload", warn);
      return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    const onChange = (v) => {
      setText(v);
      if (statusRef.current.kind === "conflict" || statusRef.current.kind === "blocked") return;
      setStatus({ kind: "dirty" });
      schedule(AUTOSAVE_IDLE_MS);
    };
    async function compare() {
      try {
        const fresh = await getPage(bot, page.slug);
        setDialog({ compare: fresh.content });
      } catch (e) {
        setStatus({ kind: "failed", message: humanError(e, t, "unexpectedError") });
      }
    }
    async function takeTheirs() {
      setDialog(null);
      try {
        const fresh = await getPage(bot, page.slug);
        base.current = fresh.sha;
        saved.current = fresh.content;
        current.current = fresh;
        setText(fresh.content);
        setStatus({ kind: "saved" });
      } catch (e) {
        setStatus({ kind: "failed", message: humanError(e, t, "unexpectedError") });
      }
    }
    async function writeOver() {
      try {
        const fresh = await getPage(bot, page.slug);
        base.current = fresh.sha;
        setStatus({ kind: "dirty" });
        statusRef.current = { kind: "dirty" };
        lastSave.current = 0;
        await save();
      } catch (e) {
        setStatus({ kind: "failed", message: humanError(e, t, "unexpectedError") });
      }
    }
    async function copyDraft() {
      try {
        await navigator.clipboard.writeText(textRef.current);
        setCopied(true);
      } catch {
        setCopied(false);
      }
    }
    const finish = () => dirty || status.kind === "conflict" ? setDialog("leave") : onDone(current.current, saved.current);
    const statusText = status.kind === "saving" ? t("pageSaving") : status.kind === "dirty" ? t("pageUnsaved") : status.kind === "failed" ? t("pageSaveFailed") : status.kind === "conflict" ? t("pageConflictShort") : status.kind === "blocked" ? t(status.reason === "redacted" ? "pageRedactedShort" : status.reason === "too_large" ? "pageTooLarge" : "pagesReadOnly") : status.at ? t("pageSavedAt", { time: status.at.toLocaleTimeString(locale === "pt" ? "pt-BR" : "en-US", { hour: "2-digit", minute: "2-digit" }) }) : t("pageNoChanges");
    const dotColor = status.kind === "saved" ? "var(--color-success)" : status.kind === "conflict" || status.kind === "blocked" ? "var(--color-warning)" : status.kind === "failed" ? "var(--color-destructive)" : "var(--color-muted-foreground)";
    const source = /* @__PURE__ */ jsx(
      "textarea",
      {
        "aria-label": t("pageSourceLabel"),
        value: text,
        onChange: (e) => onChange(e.target.value),
        onBlur: () => void save(),
        spellCheck: true,
        className: "lb-mono",
        style: { flex: 1, minHeight: narrow ? 320 : "60vh", width: "100%", resize: "none", border: "none", borderRadius: 16, padding: 16, background: "var(--lb-fill)", color: "var(--color-foreground)", fontSize: 13, lineHeight: "21px" }
      }
    );
    const preview = /* @__PURE__ */ jsx("div", { "aria-label": t("pagePreviewLabel"), role: "region", className: "lb-group", style: { flex: 1, minHeight: narrow ? 320 : "60vh", padding: 20, overflowY: "auto" }, children: /* @__PURE__ */ jsx(Markdown, { text }) });
    return /* @__PURE__ */ jsxs(
      "div",
      {
        ref: rootRef,
        "data-expanded": expanded || void 0,
        onKeyDown: (e) => {
          if (expanded && e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setExpanded(false);
          }
        },
        style: expanded ? { position: "fixed", inset: 0, zIndex: 45, display: "flex", flexDirection: "column", minHeight: 0, background: "var(--color-background)", color: "var(--color-foreground)" } : { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
        children: [
          /* @__PURE__ */ jsxs("header", { style: { display: "flex", alignItems: "center", gap: 12, padding: "16px 20px 12px", flexWrap: "wrap" }, children: [
            /* @__PURE__ */ jsxs("div", { style: { flex: 1, minWidth: 160 }, children: [
              /* @__PURE__ */ jsx("div", { className: "lb-title lb-truncate", children: page.title }),
              /* @__PURE__ */ jsxs("span", { role: "status", className: "lb-caption", style: { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--color-muted-foreground)" }, children: [
                /* @__PURE__ */ jsx("span", { "aria-hidden": "true", style: { width: 6, height: 6, borderRadius: 3, background: dotColor } }),
                statusText
              ] })
            ] }),
            status.kind === "failed" && /* @__PURE__ */ jsx("button", { type: "button", onClick: () => {
              setStatus({ kind: "dirty" });
              statusRef.current = { kind: "dirty" };
              void save();
            }, className: "lb-btn", children: t("retry") }),
            !narrow && /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setExpanded(!expanded), "aria-pressed": expanded, className: "lb-btn", children: expanded ? t("pageCollapse") : t("pageExpand") }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: finish, className: "lb-btn lb-btn-primary", children: t("pageDone") })
          ] }),
          status.kind === "conflict" && /* @__PURE__ */ jsxs("div", { role: "status", className: "lb-group", style: { margin: "0 20px 12px", padding: "12px 16px", background: "color-mix(in srgb, var(--color-warning) 14%, transparent)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }, children: [
            /* @__PURE__ */ jsx("span", { className: "lb-subhead", style: { flex: "1 1 260px" }, children: t("pageConflictBody", { who: status.who }) }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void compare(), className: "lb-btn lb-btn-primary", children: t("pageCompare") }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setDialog("take"), className: "lb-btn", children: t("pageUseTheirs") }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void copyDraft(), className: "lb-btn", children: copied ? t("pageDraftCopied") : t("pageCopyDraft") }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void writeOver(), className: "lb-btn lb-btn-plain", style: { color: "var(--color-destructive)" }, children: t("pageWriteOver") })
          ] }),
          status.kind === "blocked" && status.reason === "redacted" && /* @__PURE__ */ jsx("p", { role: "status", className: "lb-alert", style: { margin: "0 20px 12px" }, children: t("pageRedactedBody") }),
          oneAtATime ? /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0, padding: "0 16px 16px" }, children: [
            /* @__PURE__ */ jsxs("div", { role: "tablist", "aria-label": t("pageEditorViews"), className: "lb-segmented", children: [
              /* @__PURE__ */ jsx("button", { type: "button", role: "tab", "aria-selected": view === "source", onClick: () => setView("source"), className: "lb-segment", children: t("pageSourceTab") }),
              /* @__PURE__ */ jsx("button", { type: "button", role: "tab", "aria-selected": view === "preview", onClick: () => setView("preview"), className: "lb-segment", children: t("pagePreviewTab") })
            ] }),
            view === "source" ? source : preview
          ] }) : /* @__PURE__ */ jsxs("div", { style: { flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, padding: "0 20px 20px" }, children: [
            /* @__PURE__ */ jsx("div", { style: { display: "flex", flexDirection: "column", minHeight: 0 }, children: source }),
            /* @__PURE__ */ jsx("div", { style: { display: "flex", flexDirection: "column", minHeight: 0 }, children: preview })
          ] }),
          /* @__PURE__ */ jsx(Dialog, { open: dialog === "leave", onClose: () => setDialog(null), title: t("pageLeaveTitle"), titleId: "page-leave-title", children: /* @__PURE__ */ jsxs("div", { className: "lb-dialog-body", children: [
            /* @__PURE__ */ jsx("p", { className: "lb-body", children: t("pageLeaveBody") }),
            /* @__PURE__ */ jsxs("div", { className: "lb-dialog-footer", children: [
              /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setDialog(null), className: "lb-btn", children: t("pageKeepEditing") }),
              /* @__PURE__ */ jsx("button", { type: "button", onClick: () => {
                setDialog(null);
                onDone(current.current, saved.current);
              }, className: "lb-btn lb-btn-destructive", children: t("pageLeaveDiscard") })
            ] })
          ] }) }),
          /* @__PURE__ */ jsx(Dialog, { open: dialog === "take", onClose: () => setDialog(null), title: t("pageUseTheirsTitle", { who: botLabel }), titleId: "page-take-title", children: /* @__PURE__ */ jsxs("div", { className: "lb-dialog-body", children: [
            /* @__PURE__ */ jsx("p", { className: "lb-body", children: t("pageUseTheirsBody") }),
            /* @__PURE__ */ jsxs("div", { className: "lb-dialog-footer", children: [
              /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setDialog(null), className: "lb-btn", children: t("cancelBtn") }),
              /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void takeTheirs(), className: "lb-btn lb-btn-destructive", children: t("pageUseTheirs") })
            ] })
          ] }) }),
          /* @__PURE__ */ jsx(Dialog, { open: !!dialog && typeof dialog === "object", onClose: () => setDialog(null), title: t("pageCompareTitle"), titleId: "page-compare-title", width: 760, children: /* @__PURE__ */ jsx("div", { className: "lb-dialog-body", children: dialog && typeof dialog === "object" && /* @__PURE__ */ jsx(DiffView, { lines: lineDiff(dialog.compare, text), beforeLabel: status.kind === "conflict" ? status.who : botLabel, afterLabel: t("pageYourDraft") }) }) })
        ]
      }
    );
  }

  // dashboard/src/components/pages/PageView.tsx
  function PageView({ bot, slug, liveRev, onAsk, onClose }) {
    const { t, locale } = useLuveI18n();
    const botLabel = bot.label || bot.name;
    const [page, setPage] = react_default.useState(null);
    const [error, setError] = react_default.useState(null);
    const [mode, setMode] = react_default.useState({ kind: "read" });
    const [diff, setDiff] = react_default.useState(null);
    const seenBefore = react_default.useRef(null);
    const shown = react_default.useRef(null);
    const fmt = (iso) => new Date(iso).toLocaleString(locale === "pt" ? "pt-BR" : "en-US", { dateStyle: "short", timeStyle: "short" });
    const load = react_default.useCallback(async () => {
      try {
        const p = await getPage(bot.name, slug);
        setPage(p);
        setError(null);
        markSeen(bot.name, slug, p.sha);
        return p;
      } catch (e) {
        const code2 = errCode(e);
        setError(code2 === "page_not_found" ? t("pageNotFound") : blockText(blockFromError(e), { name: bot.name, label: bot.label }, t));
        return null;
      }
    }, [bot.name, slug, t]);
    react_default.useEffect(() => {
      seenBefore.current = lastSeenSha(bot.name, slug);
      setPage(null);
      setMode({ kind: "read" });
      void load();
    }, [bot.name, slug, load]);
    react_default.useEffect(() => {
      if (page && mode.kind === "read") shown.current = page.content;
    }, [page, mode.kind]);
    const changedSince = !!page && seenBefore.current !== null && seenBefore.current !== page.sha;
    const liveNewer = !!page && liveRev != null && (page.rev == null || liveRev > page.rev);
    async function showChanges() {
      const before = liveNewer ? shown.current : null;
      const fresh = liveNewer ? await load() : page;
      if (!fresh) return;
      if (before != null) {
        setDiff({ before, label: t("pageVersionYouHad") });
        return;
      }
      try {
        const { revisions } = await listPageRevisions(bot.name, slug);
        const old = revisions.find((r2) => r2.sha === seenBefore.current);
        if (!old) {
          setDiff("missing");
          return;
        }
        const r = await getPageRevision(bot.name, slug, old.rev);
        setDiff({ before: r.content, label: t("pageVersionYouHad") });
      } catch {
        setDiff("missing");
      }
      seenBefore.current = fresh.sha;
    }
    if (error) return /* @__PURE__ */ jsx(Shell, { onClose, title: t("pageOfBot", { name: botLabel }), children: /* @__PURE__ */ jsx("p", { role: "alert", className: "lb-group lb-subhead", style: { padding: "14px 16px" }, children: /* @__PURE__ */ jsx(ErrorNote, { error }) }) });
    if (!page) return /* @__PURE__ */ jsx(Shell, { onClose, title: t("pageOfBot", { name: botLabel }), children: /* @__PURE__ */ jsx("p", { className: "lb-group lb-subhead", style: { padding: "14px 16px" }, children: t("pageLoading") }) });
    if (mode.kind === "edit") {
      return /* @__PURE__ */ jsx(
        PageEditor,
        {
          bot: bot.name,
          botLabel,
          page,
          onSaved: (p, content) => {
            markSeen(bot.name, slug, p.sha);
            seenBefore.current = p.sha;
            setPage({ ...page, ...p, content });
          },
          onDone: (p, content) => {
            setPage({ ...page, ...p, content });
            setMode({ kind: "read" });
          }
        }
      );
    }
    if (mode.kind === "history") return /* @__PURE__ */ jsx(History, { bot: bot.name, botLabel, page, fmt, onBack: () => setMode({ kind: "read" }), onOpen: (rev) => setMode({ kind: "revision", rev }) });
    if (mode.kind === "revision") {
      return /* @__PURE__ */ jsx(
        Revision,
        {
          bot: bot.name,
          botLabel,
          page,
          rev: mode.rev,
          fmt,
          onBack: () => setMode({ kind: "history" }),
          onRestored: async () => {
            await load();
            setMode({ kind: "read" });
          }
        }
      );
    }
    const readOnly = !page.editable;
    return /* @__PURE__ */ jsxs(
      Shell,
      {
        onClose,
        title: t("pageOfBot", { name: botLabel }),
        actions: /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setMode({ kind: "edit" }), disabled: readOnly, className: "lb-btn", children: t("pageEdit") }),
        children: [
          (liveNewer || changedSince) && /* @__PURE__ */ jsxs("div", { role: "status", className: "lb-group", style: { display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", marginBottom: 12, background: "color-mix(in srgb, var(--color-primary) 10%, transparent)" }, children: [
            /* @__PURE__ */ jsx(Avatar, { name: botLabel, avatar: bot.avatar, color: bot.color, size: 24 }),
            /* @__PURE__ */ jsx("span", { className: "lb-subhead", style: { flex: 1 }, children: liveNewer ? t("pageUpdatedWhileReading", { name: botLabel }) : t("pageChangedSinceRead") }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void showChanges(), className: "lb-btn lb-btn-plain", children: t("pageSeeChanges") })
          ] }),
          readOnly && /* @__PURE__ */ jsx("p", { role: "status", className: "lb-alert", style: { marginBottom: 12, background: "var(--lb-fill)", color: "var(--color-foreground)" }, children: t(page.readonly_reason === "redacted" ? "pageRedactedBody" : "pagesReadOnly") }),
          /* @__PURE__ */ jsxs("section", { "aria-label": t("pageRegionLabel", { title: page.title }), children: [
            /* @__PURE__ */ jsxs("p", { className: "lb-caption", style: { color: "var(--color-muted-foreground)", margin: "0 0 12px" }, children: [
              t("pageMeta", { who: page.author_label, when: fmt(page.mtime) }),
              page.rev != null ? ` \xB7 ${t("pageRevision", { rev: page.rev })}` : ""
            ] }),
            /* @__PURE__ */ jsx("div", { className: "lb-body", children: /* @__PURE__ */ jsx(Markdown, { text: page.content }) })
          ] }),
          /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 20, paddingTop: 12, borderTop: "1px solid var(--lb-separator)" }, children: [
            onAsk && /* @__PURE__ */ jsx("button", { type: "button", onClick: () => onAsk(page), className: "lb-btn", style: { flex: "1 1 auto" }, children: t("pageAskBot", { name: botLabel }) }),
            /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setMode({ kind: "history" }), className: "lb-btn", children: t("pageHistory") })
          ] }),
          /* @__PURE__ */ jsx(Dialog, { open: diff !== null, onClose: () => setDiff(null), title: t("pageChangesTitle"), titleId: "page-changes-title", width: 760, children: /* @__PURE__ */ jsx("div", { className: "lb-dialog-body", children: diff === "missing" ? /* @__PURE__ */ jsx("p", { className: "lb-subhead", children: t("pageOldVersionGone") }) : diff && /* @__PURE__ */ jsx(DiffView, { lines: lineDiff(diff.before, page.content), beforeLabel: diff.label, afterLabel: t("pageVersionNow") }) }) })
        ]
      }
    );
  }
  function Shell({ title, actions, onClose, children }) {
    return /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, margin: "0 40px 12px 0", minHeight: 32 }, children: [
        /* @__PURE__ */ jsx("span", { className: "lb-caption", style: { flex: 1, color: "var(--color-muted-foreground)" }, children: title }),
        actions,
        onClose && null
      ] }),
      children
    ] });
  }
  function History({ bot, botLabel, page, fmt, onBack, onOpen }) {
    const { t } = useLuveI18n();
    const [revs, setRevs] = react_default.useState(null);
    const [error, setError] = react_default.useState(null);
    react_default.useEffect(() => {
      listPageRevisions(bot, page.slug).then((r) => setRevs(r.revisions), (e) => setError(blockText(blockFromError(e), { name: bot }, t)));
    }, [bot, page.slug, t]);
    return /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsxs("button", { type: "button", onClick: onBack, className: "lb-btn lb-btn-plain", style: { marginBottom: 8 }, children: [
        "\u2039 ",
        page.title
      ] }),
      /* @__PURE__ */ jsx("h2", { className: "lb-title", style: { margin: "0 0 12px" }, children: t("pageHistory") }),
      error ? /* @__PURE__ */ jsx("p", { role: "alert", className: "lb-group lb-subhead", style: { padding: "14px 16px" }, children: /* @__PURE__ */ jsx(ErrorNote, { error }) }) : !revs ? /* @__PURE__ */ jsx("p", { className: "lb-group lb-subhead", style: { padding: "14px 16px" }, children: t("pageLoading") }) : !revs.length ? /* @__PURE__ */ jsx("p", { className: "lb-group lb-subhead", style: { padding: "14px 16px" }, children: t("pageHistoryEmpty") }) : /* @__PURE__ */ jsx("ul", { className: "lb-group", style: { listStyle: "none", margin: 0, padding: 0 }, children: revs.map((r) => /* @__PURE__ */ jsx("li", { className: "lb-row lb-row-flat", style: { padding: 0 }, children: /* @__PURE__ */ jsx("button", { type: "button", onClick: () => onOpen(r), className: "lb-contact", style: { borderRadius: 0, padding: "8px 16px", minHeight: 52 }, children: /* @__PURE__ */ jsxs("span", { className: "lb-row-stack", children: [
        /* @__PURE__ */ jsxs("span", { className: "lb-headline", children: [
          t("pageRevision", { rev: r.rev }),
          r.sha === page.sha ? ` \xB7 ${t("pageCurrentVersion")}` : ""
        ] }),
        /* @__PURE__ */ jsxs("span", { className: "lb-caption", children: [
          r.author_label,
          " \xB7 ",
          fmt(r.at)
        ] })
      ] }) }) }, r.rev)) }),
      /* @__PURE__ */ jsx("p", { className: "lb-caption", style: { color: "var(--color-muted-foreground)", marginTop: 8 }, children: t("pageHistoryLimit") })
    ] });
  }
  function Revision({ bot, botLabel, page, rev, fmt, onBack, onRestored }) {
    const { t } = useLuveI18n();
    const [content, setContent] = react_default.useState(null);
    const [confirm, setConfirm] = react_default.useState(false);
    const [error, setError] = react_default.useState(null);
    const [busy, setBusy] = react_default.useState(false);
    react_default.useEffect(() => {
      getPageRevision(bot, page.slug, rev.rev).then((r) => setContent(r.content), (e) => setError(humanError(e, t, "unexpectedError")));
    }, [bot, page.slug, rev.rev, t]);
    async function restore() {
      setBusy(true);
      try {
        await restorePageRevision(bot, page.slug, rev.rev, { base_sha: page.sha });
        setConfirm(false);
        onRestored();
      } catch (e) {
        setError(errCode(e) === "page_conflict" ? t("pageRestoreConflict") : humanError(e, t, "unexpectedError"));
        setConfirm(false);
      } finally {
        setBusy(false);
      }
    }
    const current = rev.sha === page.sha;
    return /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsxs("button", { type: "button", onClick: onBack, className: "lb-btn lb-btn-plain", style: { marginBottom: 8 }, children: [
        "\u2039 ",
        t("pageHistory")
      ] }),
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }, children: [
        /* @__PURE__ */ jsxs("div", { style: { flex: 1 }, children: [
          /* @__PURE__ */ jsx("h2", { className: "lb-title", style: { margin: 0 }, children: t("pageRevision", { rev: rev.rev }) }),
          /* @__PURE__ */ jsxs("span", { className: "lb-caption", style: { color: "var(--color-muted-foreground)" }, children: [
            rev.author_label,
            " \xB7 ",
            fmt(rev.at)
          ] })
        ] }),
        !current && page.editable && /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setConfirm(true), className: "lb-btn", children: t("pageRestore") })
      ] }),
      error && /* @__PURE__ */ jsx("p", { role: "alert", className: "lb-alert", style: { marginBottom: 12 }, children: /* @__PURE__ */ jsx(ErrorNote, { error }) }),
      content === null ? /* @__PURE__ */ jsx("p", { className: "lb-subhead", children: t("pageLoading") }) : /* @__PURE__ */ jsx("div", { className: "lb-body", children: /* @__PURE__ */ jsx(Markdown, { text: content }) }),
      /* @__PURE__ */ jsx(Dialog, { open: confirm, onClose: () => setConfirm(false), title: t("pageRestoreTitle", { rev: rev.rev }), titleId: "page-restore-title", children: /* @__PURE__ */ jsxs("div", { className: "lb-dialog-body", children: [
        /* @__PURE__ */ jsx("p", { className: "lb-body", children: t("pageRestoreBody") }),
        /* @__PURE__ */ jsxs("div", { className: "lb-dialog-footer", children: [
          /* @__PURE__ */ jsx("button", { type: "button", onClick: () => setConfirm(false), className: "lb-btn", children: t("cancelBtn") }),
          /* @__PURE__ */ jsx("button", { type: "button", onClick: () => void restore(), disabled: busy, className: "lb-btn lb-btn-primary", children: t("pageRestore") })
        ] })
      ] }) })
    ] });
  }

  // dashboard/src/components/pages/PagesScreen.tsx
  function PagesScreen({ bot, initialSlug = null, onAsk }) {
    const { t } = useLuveI18n();
    const [slug, setSlug] = react_default.useState(initialSlug);
    if (!slug) return /* @__PURE__ */ jsx(PagesLibrary, { bot, onOpen: setSlug });
    return /* @__PURE__ */ jsxs("div", { style: { height: "100%", overflowY: "auto", padding: "16px 24px 24px", background: "var(--color-background)" }, children: [
      /* @__PURE__ */ jsxs("button", { type: "button", onClick: () => setSlug(null), className: "lb-btn lb-btn-plain", style: { marginBottom: 8 }, children: [
        "\u2039 ",
        t("pagesTitle")
      ] }),
      /* @__PURE__ */ jsx("div", { style: { maxWidth: 1120 }, children: /* @__PURE__ */ jsx(PageView, { bot: { name: bot.name, label: bot.display?.label, avatar: bot.display?.avatar, color: bot.display?.color }, slug, onAsk }) })
    ] });
  }

  // dashboard/src/pwa/service-worker.ts
  var CACHE_NAME = "luvebot-static-v1";
  var ALLOWED_STATIC_EXTENSIONS = [
    ".js",
    ".mjs",
    ".css",
    ".json",
    ".html",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".woff2",
    ".woff",
    ".ttf",
    ".otf",
    ".map"
  ];
  function isApiUrl(urlInput) {
    try {
      const url = typeof urlInput === "string" ? new URL(urlInput, "http://localhost") : urlInput;
      const pathname = url.pathname;
      return pathname.includes("/api/") || pathname.startsWith("/api") || pathname.includes("/v1/") || pathname.includes("/p/") || pathname.includes("/api-server") || pathname.includes("/ws");
    } catch {
      const str3 = String(urlInput);
      return str3.includes("/api/") || str3.includes("/v1/") || str3.includes("/ws");
    }
  }
  function isCacheablePluginAsset(urlInput, method = "GET") {
    if (method.toUpperCase() !== "GET") {
      return false;
    }
    if (isApiUrl(urlInput)) {
      return false;
    }
    try {
      const url = typeof urlInput === "string" ? new URL(urlInput, "http://localhost") : urlInput;
      const pathname = url.pathname;
      if (!pathname.includes("/dashboard-plugins/luvebot/")) {
        return false;
      }
      const hasAllowedExt = ALLOWED_STATIC_EXTENSIONS.some(
        (ext) => pathname.toLowerCase().endsWith(ext)
      );
      return hasAllowedExt;
    } catch {
      return false;
    }
  }
  async function handleFetch(request2, fetchFn = fetch, cacheInstance) {
    const isCacheable = isCacheablePluginAsset(request2.url, request2.method);
    if (!isCacheable) {
      return fetchFn(request2);
    }
    try {
      if (cacheInstance) {
        const cached = await cacheInstance.match(request2);
        if (cached) {
          return cached;
        }
      }
      const networkResponse = await fetchFn(request2);
      if (networkResponse && networkResponse.status === 200 && cacheInstance) {
        if (isCacheablePluginAsset(request2.url, request2.method)) {
          await cacheInstance.put(request2, networkResponse.clone());
        }
      }
      return networkResponse;
    } catch (err) {
      if (cacheInstance) {
        const cached = await cacheInstance.match(request2);
        if (cached) {
          return cached;
        }
      }
      throw err;
    }
  }
  if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
    const swSelf = self;
    swSelf.addEventListener("install", (event) => {
      event.waitUntil(swSelf.skipWaiting());
    });
    swSelf.addEventListener("activate", (event) => {
      event.waitUntil(swSelf.clients.claim());
    });
    swSelf.addEventListener("fetch", (event) => {
      const url = new URL(event.request.url);
      if (url.pathname.includes("/dashboard-plugins/luvebot/")) {
        event.respondWith(
          caches.open(CACHE_NAME).then((cache) => handleFetch(event.request, fetch, cache))
        );
      }
    });
  }

  // dashboard/src/hooks/useLiveRefresh.ts
  var LIVE_REFRESH_MS = 15e3;
  var HIDDEN_REFRESH_MS = 6e4;
  function useLiveRefresh(refresh, everyMs = LIVE_REFRESH_MS, whileHidden) {
    const latest = react_default.useRef(refresh);
    latest.current = refresh;
    const hiddenOk = react_default.useRef(whileHidden);
    hiddenOk.current = whileHidden;
    react_default.useEffect(() => {
      const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
      const tick = () => {
        if (visible()) latest.current();
      };
      const hiddenTick = () => {
        if (!visible() && hiddenOk.current?.()) latest.current();
      };
      const id = window.setInterval(tick, everyMs);
      const hiddenId = window.setInterval(hiddenTick, HIDDEN_REFRESH_MS);
      document.addEventListener("visibilitychange", tick);
      return () => {
        window.clearInterval(id);
        window.clearInterval(hiddenId);
        document.removeEventListener("visibilitychange", tick);
      };
    }, [everyMs]);
  }

  // dashboard/src/host/overlay.tsx
  var routeActive = 0;
  var listeners = /* @__PURE__ */ new Set();
  var notify = () => listeners.forEach((l) => l());
  var subscribe = (l) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };
  var snapshot = () => routeActive > 0;
  function LuveBotRoute() {
    react_default.useLayoutEffect(() => {
      routeActive += 1;
      notify();
      return () => {
        routeActive -= 1;
        notify();
      };
    }, []);
    return null;
  }
  function useLuveBotRoute() {
    return react_default.useSyncExternalStore(subscribe, snapshot, () => false);
  }
  function isolate(el) {
    const parent = el.parentElement;
    if (!parent) return () => {
    };
    const touched = /* @__PURE__ */ new Map();
    const mark = (node) => {
      if (node === el || touched.has(node)) return;
      const record = { inert: !node.hasAttribute("inert"), hidden: !node.hasAttribute("aria-hidden") };
      if (record.inert) node.setAttribute("inert", "");
      if (record.hidden) node.setAttribute("aria-hidden", "true");
      touched.set(node, record);
    };
    Array.from(parent.children).forEach(mark);
    const mo = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => n instanceof Element && mark(n))));
    mo.observe(parent, { childList: true });
    return () => {
      mo.disconnect();
      touched.forEach((record, node) => {
        if (record.inert) node.removeAttribute("inert");
        if (record.hidden) node.removeAttribute("aria-hidden");
      });
    };
  }
  function LuveBotOverlay({ children }) {
    const open = useLuveBotRoute();
    return open ? /* @__PURE__ */ jsx(OpenOverlay, { children }) : null;
  }
  function OpenOverlay({ children }) {
    const ref = react_default.useRef(null);
    react_default.useLayoutEffect(() => {
      const el = ref.current;
      const undo = isolate(el);
      if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
      return undo;
    }, []);
    return /* @__PURE__ */ jsx("div", { ref, className: "lb-overlay", tabIndex: -1, children });
  }

  // dashboard/src/index.tsx
  function LuveBotApp() {
    const { t } = useLuveI18n();
    const [activeTab, setActiveTab] = useState("hoje");
    const [bots, setBots] = useState([]);
    const [botsLoading, setBotsLoading] = useState(true);
    const [botsError, setBotsError] = useState(null);
    const [botsLoaded, setBotsLoaded] = useState(false);
    const [isOffline, setIsOffline] = useState(false);
    const [selectedBotName, setSelectedBotName] = useState(null);
    const [createBotModalOpen, setCreateBotModalOpen] = useState(false);
    const [botPage, setBotPage] = useState(null);
    const [profileOpen, setProfileOpen] = useState(false);
    const [pageOpen, setPageOpen] = useState(null);
    const [pagesSlug, setPagesSlug] = useState(null);
    const [askOn, setAskOn] = useState(null);
    const [liveRevs, setLiveRevs] = useState({});
    const [activityView, setActivityView] = useState("list");
    const [approvalsCount, setApprovalsCount] = useState(0);
    const [pendingByBot, setPendingByBot] = useState({});
    const [approvalsLoaded, setApprovalsLoaded] = useState(false);
    const [rooms, setRooms] = useState([]);
    const [selectedRoomId, setSelectedRoomId] = useState(null);
    const [createRoomModalOpen, setCreateRoomModalOpen] = useState(false);
    const [searchModalOpen, setSearchModalOpen] = useState(false);
    const loadBots = useCallback(async (quiet2 = false) => {
      try {
        if (!quiet2) {
          setBotsLoading(true);
          setBotsError(null);
        }
        const data = await getBots();
        setIsOffline(false);
        setBots((data?.bots || []).map((b) => withDefaultFace(withDisplayName(b))));
        setBotsLoaded(true);
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && err.code === "hermes_unreachable") {
          setIsOffline(true);
        } else if (!quiet2) {
          const msg = humanError(err, t, "errorLoadingBots");
          setBotsError(msg.text);
        }
      } finally {
        if (!quiet2) setBotsLoading(false);
      }
    }, []);
    const botsStatus = botsLoading ? "loading" : botsLoaded ? "ready" : "error";
    const retryBots = () => void loadBots();
    const loadApprovalsCount = useCallback(async () => {
      try {
        const res = await getApprovals();
        const pending = (res?.approvals || []).filter((a) => a.status === "pending");
        setApprovalsCount(pending.length);
        const byBot = {};
        for (const a of pending) byBot[a.bot] = (byBot[a.bot] ?? 0) + 1;
        setPendingByBot(byBot);
        setApprovalsLoaded(true);
      } catch {
      }
    }, []);
    const loadRooms = useCallback(async () => {
      try {
        const res = await getRooms();
        setRooms(res?.rooms || []);
      } catch {
      }
    }, []);
    useEffect(() => {
      void registerPwa();
      loadBots();
      loadApprovalsCount();
      loadRooms();
    }, [loadBots, loadApprovalsCount, loadRooms]);
    const refreshLive = useCallback(() => {
      void loadBots(true);
      void loadApprovalsCount();
      void loadRooms();
    }, [loadBots, loadApprovalsCount, loadRooms]);
    useLiveRefresh(refreshLive, void 0, () => readSoundPref() !== "off");
    const [restartRequired, setRestartRequired] = useState(false);
    useEffect(() => {
      let alive = true;
      const check = () => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        getHealth().then((h) => {
          if (alive) setRestartRequired(h?.plugin?.code_current === false || (h?.problems ?? []).some((p) => p.code === "plugin_restart_required"));
        }, () => {
        });
      };
      check();
      const id = window.setInterval(check, 6e4);
      return () => {
        alive = false;
        window.clearInterval(id);
      };
    }, []);
    useCues(botsLoaded ? bots : null, approvalsLoaded ? pendingByBot : null, selectedBotName && !botPage ? selectedBotName : null);
    const selectedBot = bots.find((b) => b.name === selectedBotName);
    const panelPage = pageOpen && pageOpen.bot === selectedBotName ? pageOpen.slug : null;
    const askAbout = askOn && askOn.bot === selectedBotName ? { slug: askOn.slug, title: askOn.title } : null;
    const setPanelPage = (slug) => setPageOpen(slug && selectedBotName ? { bot: selectedBotName, slug } : null);
    const setAskAbout = (a) => setAskOn(a && selectedBotName ? { bot: selectedBotName, ...a } : null);
    const openBotPage = (page) => {
      if (page === "costs") {
        setActiveTab("custos");
        setSelectedBotName(null);
        setBotPage(null);
      } else setBotPage(page);
    };
    const handleSelectBot = (bot) => {
      setProfileOpen(false);
      setSelectedBotName(bot.name);
      setBotPage(null);
    };
    const handleBotCreated = (newBot) => {
      setBots((prev) => [newBot, ...prev.filter((b) => b.name !== newBot.name)]);
      setSelectedBotName(newBot.name);
      setBotPage(null);
      setCreateBotModalOpen(false);
    };
    const modals = /* @__PURE__ */ jsxs(Fragment2, { children: [
      /* @__PURE__ */ jsx(
        BotCreateModal,
        {
          isOpen: createBotModalOpen,
          onClose: () => setCreateBotModalOpen(false),
          onBotCreated: handleBotCreated
        }
      ),
      /* @__PURE__ */ jsx(
        CreateRoomModal,
        {
          botsStatus,
          onRetryBots: retryBots,
          isOpen: createRoomModalOpen,
          onClose: () => setCreateRoomModalOpen(false),
          availableBots: bots,
          onRoomCreated: (newRoom) => {
            setRooms((prev) => [newRoom, ...prev.filter((r) => r.id !== newRoom.id)]);
            void loadRooms();
            setSelectedRoomId(newRoom.id);
            setSelectedBotName(null);
            setBotPage(null);
            setCreateRoomModalOpen(false);
          }
        }
      ),
      /* @__PURE__ */ jsx(
        CommandPaletteModal,
        {
          botsStatus,
          onRetryBots: retryBots,
          isOpen: searchModalOpen,
          onClose: () => setSearchModalOpen(false),
          availableBots: bots,
          availableRooms: rooms,
          onNavigateTab: (tab) => {
            setActiveTab(tab);
            setSelectedBotName(null);
            setSelectedRoomId(null);
            setBotPage(null);
          },
          onSelectBot: (name) => {
            setSelectedBotName(name);
            setSelectedRoomId(null);
            setBotPage(null);
          },
          onSelectRoom: (roomId) => {
            setSelectedRoomId(roomId);
            setSelectedBotName(null);
            setBotPage(null);
          },
          onOpenCreateBot: () => setCreateBotModalOpen(true),
          onOpenCreateRoom: () => setCreateRoomModalOpen(true),
          onSelectPage: (name, slug) => {
            setSelectedBotName(name);
            setSelectedRoomId(null);
            setBotPage(null);
            setProfileOpen(false);
            setPageOpen({ bot: name, slug });
          }
        }
      )
    ] });
    return /* @__PURE__ */ jsx(
      MessengerShell,
      {
        modals,
        bots,
        botsLoading,
        botsError,
        isOffline,
        selectedBotName,
        onSelectBot: handleSelectBot,
        onOpenCreateBot: () => setCreateBotModalOpen(true),
        onRetryBots: () => void loadBots(),
        restartRequired,
        rooms,
        selectedRoomId,
        onSelectRoom: (room) => {
          setSelectedRoomId(room.id);
          setSelectedBotName(null);
          setBotPage(null);
        },
        onOpenCreateRoom: () => setCreateRoomModalOpen(true),
        activeTab,
        approvalsCount,
        pendingByBot,
        onOpenSearch: () => setSearchModalOpen(true),
        onBack: () => {
          setSelectedBotName(null);
          setSelectedRoomId(null);
          setBotPage(null);
        },
        onTabChange: (tab) => {
          setActiveTab(tab);
          setSelectedBotName(null);
          setSelectedRoomId(null);
        },
        children: selectedRoomId && !selectedBotName ? /* @__PURE__ */ jsx(
          RoomsView,
          {
            roomId: selectedRoomId,
            availableBots: bots,
            onSelectRoom: (room) => {
              setSelectedRoomId(room.id);
              setRooms((prev) => prev.some((r) => r.id === room.id) ? prev : [room, ...prev]);
              void loadRooms();
            },
            onNavigateToKanban: () => {
              setActiveTab("atividade");
              setActivityView("kanban");
              setSelectedRoomId(null);
            },
            onOpenTeamMap: () => {
              setActiveTab("mapa");
              setSelectedRoomId(null);
            }
          }
        ) : selectedBotName && !botPage ? (
          // key: a new Bot starts a new conversation
          /* @__PURE__ */ jsx(
            Conversation,
            {
              onActivityChange: refreshLive,
              onCloseSidePanel: () => {
                setProfileOpen(false);
                setPanelPage(null);
              },
              onOpenProfile: () => {
                setPanelPage(null);
                setProfileOpen(true);
              },
              bot: { name: selectedBotName, ...selectedBot?.display },
              onOpenPage: (slug) => {
                setProfileOpen(false);
                setPanelPage(slug);
              },
              onOpenPages: () => {
                setProfileOpen(false);
                openBotPage("pages");
              },
              onPageUpdated: (u) => setLiveRevs((m) => ({ ...m, [`${selectedBotName}:${u.slug}`]: u.rev })),
              askAbout,
              onClearAsk: () => setAskAbout(null),
              panel: panelPage && selectedBot ? /* @__PURE__ */ jsx(SidePanel, { open: true, onClose: () => setPanelPage(null), label: t("pageOfBot", { name: selectedBot.display?.label || selectedBot.name }), children: /* @__PURE__ */ jsx(
                PageView,
                {
                  bot: { name: selectedBot.name, label: selectedBot.display?.label, avatar: selectedBot.display?.avatar, color: selectedBot.display?.color },
                  slug: panelPage,
                  liveRev: liveRevs[`${selectedBot.name}:${panelPage}`],
                  onAsk: (page) => setAskAbout({ slug: page.slug, title: page.title })
                },
                panelPage
              ) }) : profileOpen && selectedBot ? /* @__PURE__ */ jsx(SidePanel, { open: true, onClose: () => setProfileOpen(false), label: t("agentPanelLabel", { name: selectedBot.display?.label || selectedBot.name }), children: /* @__PURE__ */ jsx(
                AgentPanel,
                {
                  bot: selectedBot,
                  pendingApprovals: pendingByBot[selectedBot.name],
                  onOpenPage: openBotPage,
                  onChanged: () => void loadBots(),
                  onOpenPageSlug: (slug) => {
                    setProfileOpen(false);
                    setPanelPage(slug);
                  }
                }
              ) }) : void 0
            },
            selectedBotName
          )
        ) : selectedBotName ? /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }, children: [
          /* @__PURE__ */ jsx("div", { style: { padding: "6px 12px", borderBottom: "1px solid var(--color-border)" }, children: /* @__PURE__ */ jsxs("button", { type: "button", onClick: () => setBotPage(null), style: { minHeight: 44, border: "none", background: "none", color: "var(--color-primary)", cursor: "pointer", fontSize: 14, fontWeight: 600 }, children: [
            "\u2039 ",
            t("backToConversation")
          ] }) }),
          /* @__PURE__ */ jsx("div", { style: { flex: 1, minHeight: 0, overflowY: "auto" }, children: botPage === "pages" && selectedBot ? /* @__PURE__ */ jsx(
            PagesScreen,
            {
              bot: selectedBot,
              initialSlug: pagesSlug?.bot === selectedBot.name ? pagesSlug.slug : null,
              onAsk: (page) => {
                setBotPage(null);
                setPagesSlug(null);
                setAskAbout({ slug: page.slug, title: page.title });
              }
            },
            selectedBot.name
          ) : botPage === "rules" ? /* @__PURE__ */ jsx(RulesView, { botName: selectedBotName, bots }) : botPage === "routines" ? /* @__PURE__ */ jsx(RoutinesView, { botName: selectedBotName, bots }) : /* @__PURE__ */ jsx(
            BotProfile,
            {
              botName: selectedBotName,
              onClose: () => setBotPage(null),
              onBotUpdated: (updated) => {
                setBots(
                  (prev) => prev.map((b) => b.name === updated.name ? withDefaultFace(withDisplayName({ ...b, ...updated })) : b)
                );
              }
            }
          ) })
        ] }) : activeTab === "hoje" ? /* @__PURE__ */ jsx(
          Hoje,
          {
            botsStatus,
            onRetryBots: retryBots,
            bots,
            onOpenCreateBot: () => setCreateBotModalOpen(true),
            onStopActivity: (id) => stopActivity(id, {}),
            onRunRoutine: (id) => testRoutine(id),
            onNavigateTab: (tab) => {
              setActiveTab(tab);
              setSelectedBotName(null);
              setSelectedRoomId(null);
              setBotPage(null);
            },
            onSelectBot: (name) => {
              setSelectedBotName(name);
              setSelectedRoomId(null);
              setBotPage(null);
            },
            autoFetch: true
          }
        ) : activeTab === "aprovacoes" ? /* @__PURE__ */ jsx(
          ApprovalsInbox,
          {
            bots,
            onApprovalsChanged: (count) => setApprovalsCount(count)
          }
        ) : activeTab === "config" ? /* @__PURE__ */ jsx(SettingsView, { bots }) : activeTab === "regras" ? /* @__PURE__ */ jsx(RulesView, { bots }) : activeTab === "atividade" ? /* @__PURE__ */ jsx(ActivityView, { bots, initialView: activityView, onOpenConversation: (name) => {
          setSelectedBotName(name);
          setSelectedRoomId(null);
          setBotPage(null);
        } }, activityView) : activeTab === "custos" ? /* @__PURE__ */ jsx(CostsView, { bots }) : activeTab === "rotinas" ? /* @__PURE__ */ jsx(RoutinesView, { bots }) : activeTab === "mapa" ? /* @__PURE__ */ jsx(
          TeamMapView,
          {
            availableBots: bots,
            onSelectBot: (name) => {
              setSelectedBotName(name);
              setSelectedRoomId(null);
              setBotPage(null);
            },
            onNavigateToKanban: () => {
              setActiveTab("atividade");
              setActivityView("kanban");
              setSelectedBotName(null);
              setSelectedRoomId(null);
            },
            onNavigateToRoom: (roomId) => {
              setSelectedRoomId(roomId);
              setSelectedBotName(null);
              setBotPage(null);
            }
          }
        ) : /* @__PURE__ */ jsx("div", { className: "lb:p-8 lb:text-center lb:text-xs lb:text-[var(--color-muted-foreground)]", children: t("pageArea", { tab: activeTab }) })
      }
    );
  }
  function BackToLuveBot() {
    const { t } = useLuveI18n();
    return /* @__PURE__ */ jsxs(
      "a",
      {
        href: "/" + window.location.search,
        className: "lb-host-link",
        style: { font: "600 12px/16px var(--lb-font)", color: "inherit", padding: "4px 8px", borderRadius: 999, border: "1px solid currentColor", whiteSpace: "nowrap" },
        onClick: (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          navigateHost("/");
        },
        children: [
          "\u2039 ",
          t("backToLuveBot")
        ]
      }
    );
  }
  function LuveBotOverlaySlot() {
    return /* @__PURE__ */ jsx(LuveBotOverlay, { children: /* @__PURE__ */ jsx(LuveBotApp, {}) });
  }
  var registry = getPluginRegistry();
  if (registry && typeof registry.register === "function") {
    if (typeof registry.registerSlot === "function") {
      registry.register("luvebot", LuveBotRoute);
      registry.registerSlot("luvebot", "overlay", LuveBotOverlaySlot);
      registry.registerSlot("luvebot", "header-left", BackToLuveBot);
    } else {
      registry.register("luvebot", LuveBotApp);
    }
  }
  var index_default = LuveBotApp;
  return __toCommonJS(index_exports);
})();
