// dashboard/src/components/chat/useConversation.ts
// Turn logic of a conversation with a Bot (spec 4.3, contract §5/§6), with no markup, so any shell can use it.
// Run surface by default (A-3); chat surface as fallback. A turn ends ONLY when Hermes confirms a terminal
// state (run.* frame or GET run). Our own luvebot.error and a closed stream are not confirmation, so neither
// ends it, and Parar stays available. Closing the stream never stops the run (§6.0).

import React from "react";
import { openStream, reduce, initialTranscript, type Frame, type TranscriptState } from "../../lib/stream";
import { ApiError, createSession, createRun, getRun, stopRun, runEventsUrl, chatStreamUrl, getCsrf, getBotSessions, getSessionMessages, getActivity, type RunInfo } from "../../api/client";
import { latestConversation, turnsFromHistory } from "./history";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { isSlug } from "../pages/pages";
import { humanError, type ErrorState } from "../ui/ErrorNote";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type Terminal = "completed" | "cancelled" | "failed" | "interrupted";

/** Our own luvebot.page.updated (contract v0.5 §7.1): the Bot wrote one of its pages during this turn. */
export type PageUpdate = { slug: string; rev: number; title: string };

export type Turn = {
  id: number; user: string; state: TranscriptState;
  runId?: string; confirmed?: Terminal; stopping: boolean; errors: ErrorState[];
  pages?: PageUpdate[];
  aboutPage?: string;  // the slug this message asked about ("Perguntar ao Bot sobre esta página")
  resuming?: boolean;  // a human just decided its approval; cleared by Hermes's next frame or the end of the turn
};

/** The frame's fields as data: a slug that is not a slug, or a missing rev, is dropped (never used as a path). */
function pageUpdateOf(frame: Frame): PageUpdate | null {
  const d = frame.data as Record<string, unknown>;
  if (!isSlug(d.slug) || typeof d.rev !== "number" || !Number.isInteger(d.rev)) return null;
  return { slug: d.slug, rev: d.rev, title: typeof d.title === "string" && d.title.trim() ? d.title.slice(0, 120) : d.slug };
}

export interface UseConversationOptions {
  bot: string;
  surface?: "run" | "chat";
  fetcher?: Fetcher;  // stream fetcher; default is the SDK authedFetch
  pollMs?: number;    // how often GET run is asked after the stream ends without a terminal frame
  initialTurns?: Turn[];
  onPageUpdated?: (u: PageUpdate) => void;
}

const HERMES_TERMINAL: Record<string, Terminal> = { "run.completed": "completed", "run.cancelled": "cancelled", "run.failed": "failed" };
const GET_RUN_TERMINAL: Record<string, Terminal> = { completed: "completed", cancelled: "cancelled", failed: "failed", interrupted: "interrupted" };
const STATE_OF_END = { completed: "completed", failed: "failed", cancelled: "cancelled", interrupted: "cancelled" } as const;
const endOf = (run: RunInfo): Terminal | undefined => (run.status_raw === "interrupted" ? "interrupted" : GET_RUN_TERMINAL[run.status]);

// The bubble says what happened in words (the CEO saw "Hermes is unavailable." in English); the code stays in the detail.
const msgOf = (e: unknown, t: (k: TranslationKey) => string): ErrorState =>
  e instanceof ApiError ? humanError(e, t, "commErrorLuveBot") : e instanceof Error ? t("commErrorLuveBot") : t("unexpectedError");

/** Active while a turn exists and Hermes has not confirmed an end. */
export const isActive = (t: Turn) => !t.confirmed;

export function statusLabel(turn: Turn, tr: (k: TranslationKey) => string): string {
  if (turn.confirmed) {
    return {
      completed: tr("statusCompleted"),
      cancelled: tr("statusInterrupted"),
      failed: tr("statusFailed"),
      interrupted: tr("statusInterrupted"),
    }[turn.confirmed];
  }
  if (turn.stopping) return tr("statusStopping");
  if (turn.resuming) return tr("statusResuming");
  if (turn.state.status === "waiting_approval") return tr("statusWaitingApproval");
  return tr("statusWorking");
}

export function useConversation({ bot, surface = "run", fetcher, pollMs = 2000, initialTurns, onPageUpdated }: UseConversationOptions) {
  const { t } = useLuveI18n();
  const [turns, setTurns] = React.useState<Turn[]>(initialTurns ?? []);
  const sessionId = React.useRef<string | null>(null);
  const alive = React.useRef(true);
  const abort = React.useRef<AbortController | null>(null);
  const nextId = React.useRef(0);

  // B1 history: on open, the newest conversation comes back and the next message continues that same session.
  // Without this a reload showed the introduction again and the first message opened a new session.
  React.useEffect(() => {
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
          // The session's newest run as Hermes reports it now. Still open (waiting for an approval, working): its turn is not
          // "Concluído" and follows Hermes until Hermes ends it. Already ended: the turn shows that end.
          const last = past[past.length - 1];
          const status = end ? STATE_OF_END[end] : live.status === "waiting_for_approval" ? "waiting_approval" : "running";
          past[past.length - 1] = { ...last, confirmed: end || undefined, runId: live.id, state: { ...last.state, status } };
        }
        if (past.length) setTurns((ts) => [...past, ...ts]);
        if (live && !end) void pollUntilTerminal(past[past.length - 1].id, live.id, new AbortController());
      } catch { /* history is best effort: the conversation still works from a blank screen */ }
    })();
    return () => { cancelled = true; };
  }, [bot]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The session's newest run our index still has as open, as Hermes reports it now (GET run): the index only names it. */
  async function indexedRunOf(session: string): Promise<RunInfo | null> {
    try {
      const items = (await getActivity({ tab: "running", bot, limit: 100 })).items ?? [];
      const runId = items.find((i) => i.kind === "run" && i.links?.session_id === session)?.links?.run_id;
      return runId ? { ...(await getRun(bot, runId)).run, id: runId } : null;
    } catch { return null; }  // ponytail: unverifiable stays as history says; a "not confirmed" label if that proves misleading
  }

  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; abort.current?.abort(); }; // closing the stream never stops the run (§6.0)
  }, []);

  const patch = React.useCallback((id: number, f: (tTurn: Turn) => Turn) => {
    if (alive.current) setTurns((ts) => ts.map((item) => (item.id === id ? f(item) : item)));
  }, []);

  type Local = { confirmed?: Terminal; runId?: string };
  const onFrame = (id: number, local: Local) => (frame: Frame) => {
    if (frame.event === "luvebot.page.updated") {
      const u = pageUpdateOf(frame);
      if (!u) return;
      patch(id, (turnItem) => ({ ...turnItem, pages: [...(turnItem.pages ?? []).filter((x) => x.slug !== u.slug), u] }));
      onPageUpdated?.(u);
      return;
    }
    local.confirmed = HERMES_TERMINAL[frame.event] ?? local.confirmed;
    local.runId = local.runId ?? (typeof frame.data.run_id === "string" ? frame.data.run_id : undefined);
    patch(id, (turnItem) => {
      const confirmed = HERMES_TERMINAL[frame.event] ?? turnItem.confirmed;
      const state = reduce(turnItem.state, frame);
      return { ...turnItem, state, confirmed, runId: turnItem.runId ?? state.runId, resuming: false };
    });
  };

  async function pollUntilTerminal(id: number, runId: string, ac: AbortController) {
    while (alive.current && !ac.signal.aborted) {
      try {
        const { run } = await getRun(bot, runId);
        const done = endOf(run);
        if (!done) {
          // still open: say what Hermes says now (an approval decided elsewhere moves it from waiting back to working)
          const status = run.status === "waiting_for_approval" ? "waiting_approval" : "running";
          patch(id, (turnItem) => (turnItem.confirmed || turnItem.state.status === status ? turnItem
            : { ...turnItem, resuming: false, state: { ...turnItem.state, status } }));
        }
        if (done) {
          // The stream ended before Hermes's terminal frame: the answer is in the run itself, so it is not lost. Our own
          // luvebot.error is not a Hermes end, so the transcript is closed from "running" with Hermes's own result.
          const final = done === "completed" && typeof run.output === "string" ? { event: "run.completed", data: { output: run.output } } : null;
          patch(id, (turnItem) => ({
            ...turnItem, confirmed: turnItem.confirmed ?? done,
            state: final && turnItem.state.status !== "completed" ? reduce({ ...turnItem.state, status: "running" }, final) : turnItem.state,
          }));
          return;
        }
      } catch { /* keep trying: Parar stays visible */ }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** Starts a turn. Ignored while another turn is active or the input is blank. `page`: the page it asks about;
   *  the server, not the client, adds the context note (v0.5 §7.2, A-64). */
  async function send(raw: string, opts: { page?: { slug: string } } = {}) {
    const page = opts.page && isSlug(opts.page.slug) ? { slug: opts.page.slug } : undefined;
    const input = raw.trim();
    if (!input || turns.some(isActive)) return;
    const id = nextId.current++;
    const ac = new AbortController();
    abort.current = ac;
    const local: Local = {};
    setTurns((ts) => [...ts, { id, user: input, state: initialTranscript(), stopping: false, errors: [], ...(page ? { aboutPage: page.slug } : {}) }]);
    const fail = (e: unknown) => patch(id, (turnItem) => ({ ...turnItem, errors: [...turnItem.errors, msgOf(e, t)] }));
    try {
      if (!sessionId.current) sessionId.current = (await createSession(bot)).session.id;
      if (surface === "run") {
        const runId = (await createRun(bot, { input, session_id: sessionId.current, idempotency_key: crypto.randomUUID?.(), ...(page ? { page } : {}) })).run.id;
        local.runId = runId;
        patch(id, (turnItem) => ({ ...turnItem, runId }));
        await openStream(runEventsUrl(bot, runId), onFrame(id, local), { fetcher, signal: ac.signal }).catch(fail);
      } else {
        const csrf = await getCsrf();
        await openStream(chatStreamUrl(bot, sessionId.current), onFrame(id, local), {
          method: "POST", body: JSON.stringify({ input, client_message_id: crypto.randomUUID?.(), ...(page ? { page } : {}) }),
          headers: { "Content-Type": "application/json", "X-LuveBot-CSRF": csrf }, fetcher, signal: ac.signal,
        }).catch(fail);
      }
    } catch (e) {
      fail(e);
    }
    // No run id and no Hermes terminal frame (setup failed, or the stream died before its first frame):
    // there is nothing to poll or stop, so the turn ends as failed and the input is free again.
    if (!local.runId && !local.confirmed) { patch(id, (turnItem) => (turnItem.runId ? turnItem : { ...turnItem, confirmed: "failed" })); return; }
    // The stream ended (or failed) without a Hermes terminal frame: ask Hermes instead of assuming.
    if (local.runId && !local.confirmed) await pollUntilTerminal(id, local.runId, ac);
  }

  async function stop(turnItem: Turn) {
    if (!turnItem.runId) return;
    patch(turnItem.id, (x) => ({ ...x, stopping: true }));
    try { await stopRun(bot, turnItem.runId); }
    catch (e) { patch(turnItem.id, (x) => ({ ...x, stopping: false, errors: [...x.errors, msgOf(e, t)] })); }
    // No hiding here: only a Hermes terminal state ends the turn.
  }

  /** The approval was decided by a person: show "Retomando…" instead of "Aguardando aprovação" until Hermes speaks. */
  const markResuming = (id: number) => patch(id, (turnItem) => (turnItem.confirmed ? turnItem : { ...turnItem, resuming: true }));

  /** The session this conversation continues (null before the first message): where background results are delivered. */
  const session = React.useCallback(() => sessionId.current, []);
  return { turns, active: turns.find(isActive), send, stop, markResuming, session };
}
