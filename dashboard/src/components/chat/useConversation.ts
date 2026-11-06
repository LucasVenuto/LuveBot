// dashboard/src/components/chat/useConversation.ts
// Turn logic of a conversation with a Bot (spec 4.3, contract §5/§6), with no markup, so any shell can use it.
// Run surface by default (A-3); chat surface as fallback. A turn ends ONLY when Hermes confirms a terminal
// state (run.* frame or GET run). Our own luvebot.error and a closed stream are not confirmation, so neither
// ends it, and Parar stays available. Closing the stream never stops the run (§6.0).

import React from "react";
import { openStream, reduce, initialTranscript, type Frame, type TranscriptState } from "../../lib/stream";
import { ApiError, createSession, createRun, getRun, stopRun, forkSession, runEventsUrl, chatStreamUrl, newChatStreamUrl, threadsUrl, getCsrf, getBotSessions, getSessionMessages, getActivity, type RunInfo } from "../../api/client";
import { latestConversation, turnsFromHistory } from "./history";
import type { MessageRow } from "../../api/types";
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
  checking?: boolean;  // the history is drawn and whether this last turn still runs is being read: "Conferindo…" until it is known
  queued?: boolean;    // Hermes accepted it and runs it when it is back (contract v0.9 §1.6): never resent
  otherChannel?: { source: string | null };  // the session belongs to another channel (409 session_other_channel): a way out is offered
  botMessages?: number;  // a skill-draft turn read from the HISTORY: how many Bot rows with text its span held (a live one is bound by run id and has none; contract v0.11 3.2 step 2, A-183)
  skillDraft?: boolean;  // the hidden turn that asks the Bot for a skill draft (contract v0.11 3.2): no person's bubble, a label line, and the Bot's answer drawn as a card (A-175)
  steers?: string[];      // what was sent into the run as a steer (a denial's reason, a worker's note), read from the HISTORY: a note inside the turn, never a bubble (contract v0.11 section 8, A-209); a live turn has none
  userRow?: MessageRow;   // the saved row of the person's message and of the Bot's last reply (from the history; a live turn gets them when asked, history.ts rowsOfLive)
  replyRow?: MessageRow;
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
  /** A thread (contract v0.8 §4) instead of the Bot's newest conversation: `open` is an existing thread's session; `thread` is the message a new
   *  one answers (its first message goes to POST /threads, which makes the session and says its id in the first frame). Chat surface. */
  open?: string;
  thread?: { session: string; message: number };
}

const HERMES_TERMINAL: Record<string, Terminal> = { "run.completed": "completed", "run.cancelled": "cancelled", "run.failed": "failed" };
const GET_RUN_TERMINAL: Record<string, Terminal> = { completed: "completed", cancelled: "cancelled", failed: "failed", interrupted: "interrupted" };
const STATE_OF_END = { completed: "completed", failed: "failed", cancelled: "cancelled", interrupted: "cancelled" } as const;
const endOf = (run: RunInfo): Terminal | undefined => (run.status_raw === "interrupted" ? "interrupted" : GET_RUN_TERMINAL[run.status]);

// The bubble says what happened in words (the CEO saw "Hermes is unavailable." in English); the code stays in the detail.
const msgOf = (e: unknown, t: (k: TranslationKey) => string): ErrorState =>
  e instanceof ApiError ? humanError(e, t, "commErrorLuveBot") : e instanceof Error ? t("commErrorLuveBot") : t("unexpectedError");

const DELTA_BATCH_MS = 16;   // about one animation frame: the text of a fast stream is drawn at most ~60 times a second
const CLIP_USER = 280, CLIP_BOT = 400, SUMMARY_TURNS = 3;
const clip = (x: string, n: number) => (x.length > n ? x.slice(0, n).trimEnd() + "…" : x);
const whereOf = (source: string | null, t: (k: TranslationKey) => string) => (source === "cli" ? t("channelSrcCli") : source === "telegram" ? t("channelSrcTelegram") : t("channelSrcOther"));

/** The note that opens a new conversation after another channel's: where it came from and the last few exchanges as plain text (what the
 *  person already sees on screen), so the Bot knows what is being continued. Empty when there is nothing to carry. */
export function summaryOf(turns: readonly Turn[], source: string | null, t: (k: TranslationKey, p?: Record<string, string | number>) => string): string {
  const lines = turns.filter((x) => x.user || x.state.items.some((i) => i.kind === "message")).slice(-SUMMARY_TURNS).flatMap((x) => {
    const bot = x.state.items.flatMap((i) => (i.kind === "message" ? [i.text] : [])).join("\n\n").trim();
    return [x.user ? `${t("summaryYou")}: ${clip(x.user.trim(), CLIP_USER)}` : "", bot ? `${t("summaryBot")}: ${clip(bot, CLIP_BOT)}` : ""].filter(Boolean);
  });
  return lines.length ? `${t("summaryHead", { where: whereOf(source, t) })}\n${lines.join("\n")}\n\n` : "";
}

/** Active while a turn exists and Hermes has not confirmed an end. */
export const isActive = (t: Turn) => !t.confirmed;

export function statusLabel(turn: Turn, tr: (k: TranslationKey) => string): string {
  if (turn.checking) return tr("statusChecking");
  if (turn.otherChannel) return tr("statusOtherChannel");
  if (turn.queued && (!turn.confirmed || !turn.runId)) return tr("statusQueued");  // no run to follow = parked at Hermes, not "done"
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

export function useConversation({ bot, surface = "run", fetcher, pollMs = 2000, initialTurns, onPageUpdated, open, thread }: UseConversationOptions) {
  const { t } = useLuveI18n();
  const [turns, setTurns] = React.useState<Turn[]>(initialTurns ?? []);
  const sessionId = React.useRef<string | null>(null);
  const alive = React.useRef(true);
  const abort = React.useRef<AbortController | null>(null);
  const followers = React.useRef(new Set<AbortController>());   // streams of a call's delegations (they overlap the composer's turn)
  const nextId = React.useRef(0);

  // B1 history: on open, the newest conversation comes back and the next message continues that same session.
  // Without this a reload showed the introduction again and the first message opened a new session.
  // The history is drawn as soon as its messages arrive; whether its last turn still runs (two more reads) is applied on top afterwards,
  // under "Conferindo…", instead of holding the whole conversation back for it (perf-tela.md item 3).
  const fresh = !!thread && !open;   // a thread being started has no history to read
  const [historyReady, setHistoryReady] = React.useState(!!initialTurns || fresh);
  React.useEffect(() => {
    if (initialTurns || fresh) return;
    let cancelled = false;
    (async () => {
      try {
        const latest = open ? { id: open } : latestConversation((await getBotSessions(bot, { limit: 20 })).sessions ?? []);
        if (!latest || cancelled) return;
        const past = turnsFromHistory((await getSessionMessages(bot, latest.id, { limit: 100 })).messages ?? []);
        if (cancelled) return;
        if (!sessionId.current) sessionId.current = latest.id;
        const lastId = past.length ? past[past.length - 1].id : null;
        if (past.length) { past[past.length - 1] = { ...past[past.length - 1], checking: true }; setTurns((ts) => [...past, ...ts]); }
        setHistoryReady(true);
        const live = past.length ? await indexedRunOf(latest.id) : null;
        if (cancelled || lastId === null) return;
        const end = live && endOf(live);
        // The session's newest run as Hermes reports it now. Still open (waiting for an approval, working): its turn is not
        // "Concluído" and follows Hermes until Hermes ends it. Already ended: the turn shows that end.
        patch(lastId, ({ checking: _checking, ...turn }) => {
          if (!live) return turn;
          const status = end ? STATE_OF_END[end] : live.status === "waiting_for_approval" ? "waiting_approval" : "running";
          return { ...turn, confirmed: end || undefined, runId: live.id, state: { ...turn.state, status } };
        });
        if (live && !end) void pollUntilTerminal(lastId, live.id, new AbortController());
      } catch { /* history is best effort: the conversation still works from a blank screen */ }
      finally { if (!cancelled) setHistoryReady(true); }
    })();
    return () => { cancelled = true; };
  }, [bot, open]); // eslint-disable-line react-hooks/exhaustive-deps

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
    return () => { alive.current = false; abort.current?.abort(); followers.current.forEach((a) => a.abort()); }; // closing the stream never stops the run (§6.0)
  }, []);

  const patch = React.useCallback((id: number, f: (tTurn: Turn) => Turn) => {
    if (alive.current) setTurns((ts) => ts.map((item) => (item.id === id ? f(item) : item)));
  }, []);

  type Local = { confirmed?: Terminal; runId?: string };
  // Text arrives token by token: every delta used to be its own redraw. The deltas of one animation frame are applied together (one setTurns); any
  // other frame (a tool, an approval, the end) first applies what is waiting, so the ORDER of what the person sees never changes, and the end of the
  // stream flushes too. `flush` is called when the stream closes, before anything reads the turn's state.
  const onFrame = (id: number, local: Local) => {
    let waiting: Frame[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const apply = (frames: Frame[]) => patch(id, (turnItem) => {
      let state = turnItem.state, confirmed = turnItem.confirmed;
      for (const f of frames) { confirmed = HERMES_TERMINAL[f.event] ?? confirmed; state = reduce(state, f); }
      return { ...turnItem, state, confirmed, runId: turnItem.runId ?? state.runId, resuming: false, queued: false };
    });
    const flush = () => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (waiting.length) { const frames = waiting; waiting = []; apply(frames); }
    };
    const handle = (frame: Frame) => {
      if (frame.event === "luvebot.stream.open" && !sessionId.current && typeof frame.data.session_id === "string" && frame.data.session_id) sessionId.current = frame.data.session_id;  // a chat that made its session (§10)
      if (frame.event === "luvebot.page.updated") {
        const u = pageUpdateOf(frame);
        if (!u) return;
        flush();
        patch(id, (turnItem) => ({ ...turnItem, pages: [...(turnItem.pages ?? []).filter((x) => x.slug !== u.slug), u] }));
        onPageUpdated?.(u);
        return;
      }
      local.confirmed = HERMES_TERMINAL[frame.event] ?? local.confirmed;
      local.runId = local.runId ?? (typeof frame.data.run_id === "string" ? frame.data.run_id : undefined);
      if (frame.event === "run.queued") {  // our frame (v0.9 §1.6): accepted, waiting for Hermes's next owner. The stream ends without a terminal event; GET follows the run.
        flush();
        patch(id, (turnItem) => ({ ...turnItem, queued: true, runId: turnItem.runId ?? local.runId }));
        return;
      }
      if (frame.event === "message.delta" || frame.event === "assistant.delta") {
        waiting.push(frame);
        if (timer === null) timer = setTimeout(flush, DELTA_BATCH_MS);
        return;
      }
      flush();
      apply([frame]);
    };
    return Object.assign(handle, { flush });
  };

  /** Follows a run by GET until Hermes ends it. -> the final answer when it completed (what a call's delegation speaks), else null. */
  async function pollUntilTerminal(id: number, runId: string, ac: AbortController): Promise<string | null> {
    while (alive.current && !ac.signal.aborted) {
      try {
        const { run } = await getRun(bot, runId);
        const done = endOf(run);
        if (!done) {
          // still open: say what Hermes says now (an approval decided elsewhere moves it from waiting back to working)
          const status = run.status === "waiting_for_approval" ? "waiting_approval" : "running";
          const queued = run.status === "queued";  // v0.9: a normal state, not an error; it runs when Hermes is back
          patch(id, (turnItem) => (turnItem.confirmed || (turnItem.state.status === status && !!turnItem.queued === queued) ? turnItem
            : { ...turnItem, resuming: false, queued, state: { ...turnItem.state, status } }));
        }
        if (done) {
          // The stream ended before Hermes's terminal frame: the answer is in the run itself, so it is not lost. Our own
          // luvebot.error is not a Hermes end, so the transcript is closed from "running" with Hermes's own result.
          const final = done === "completed" && typeof run.output === "string" ? { event: "run.completed", data: { output: run.output } } : null;
          patch(id, (turnItem) => ({
            ...turnItem, confirmed: turnItem.confirmed ?? done,
            state: final && turnItem.state.status !== "completed" ? reduce({ ...turnItem.state, status: "running" }, final) : turnItem.state,
          }));
          return done === "completed" && typeof run.output === "string" ? run.output : null;
        }
      } catch { /* keep trying: Parar stays visible */ }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
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
      // The first message of a conversation makes its session in the same call (contract v0.9 §10): no separate "create a session" round trip.
      if (surface === "run") {
        const created = await createRun(bot, { input, ...(sessionId.current ? { session_id: sessionId.current } : {}), idempotency_key: crypto.randomUUID?.(), ...(page ? { page } : {}) });
        const made = created.run?.session_id ?? created.session_id;
        if (!sessionId.current && typeof made === "string" && made) sessionId.current = made;
        if (!created.run) {  // 202 queued with no run to follow (v0.9 §1.6): kept by Hermes, never resent; the input is free again
          patch(id, (turnItem) => ({ ...turnItem, queued: true, confirmed: "completed" }));
          return;
        }
        const runId = created.run.id;
        local.runId = runId;
        patch(id, (turnItem) => ({ ...turnItem, runId }));
        const handler = onFrame(id, local);
        await openStream(runEventsUrl(bot, runId), handler, { fetcher, signal: ac.signal }).catch(fail).finally(handler.flush);
      } else {
        const csrf = await getCsrf();
        const handler = onFrame(id, local);
        const starting = !sessionId.current && thread;   // the first message of a thread: exactly these three fields, the server writes the quote
        await openStream(sessionId.current ? chatStreamUrl(bot, sessionId.current) : starting ? threadsUrl(bot) : newChatStreamUrl(bot), handler, {
          method: "POST", body: JSON.stringify(starting ? { session_id: thread.session, message_id: thread.message, input } : { input, client_message_id: crypto.randomUUID?.(), ...(page ? { page } : {}) }),
          headers: { "Content-Type": "application/json", "X-LuveBot-CSRF": csrf }, fetcher, signal: ac.signal,
        }).catch((e) => { if (e instanceof ApiError && e.code === "session_other_channel") throw e; fail(e); }).finally(handler.flush);   // another channel's session: the card below, not an error line
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "session_other_channel") {  // not an error to show: a way out (new conversation, or a copy) is offered
        const src = e.details?.source;
        patch(id, (turnItem) => ({ ...turnItem, otherChannel: { source: typeof src === "string" ? src : null } }));
      } else fail(e);
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

  /** The conversation's session, made now when it has none yet: a call belongs to a session (contract v0.7 3.2). */
  async function ensureSession(): Promise<string> {
    if (!sessionId.current) sessionId.current = (await createSession(bot)).session.id;
    return sessionId.current;
  }

  /** A streamed turn that did not start from the composer (a call's delegation, v0.7 3.3) shown as one of the conversation's turns, so the person
   *  sees what was done, approvals included. `said` is what the person said aloud. -> the Bot's reply, or null with the error when it failed.
   *  `skillDraft` (with the run the request started): the turn that asks for a skill draft, which says nothing the person typed (no bubble: the screen draws its own label and card). */
  async function follow(said: string, open: (onFrame: (f: Frame) => void, signal: AbortSignal) => Promise<unknown>, opts: { skillDraft?: boolean; runId?: string } = {}): Promise<{ text: string | null; error: unknown }> {
    const id = nextId.current++;
    const ac = new AbortController();
    followers.current.add(ac);
    const local: Local = opts.runId ? { runId: opts.runId } : {};
    let state = initialTranscript();
    let error: unknown = null;
    setTurns((ts) => [...ts, { id, user: opts.skillDraft ? "" : said || t("callTaskTurn"), state: initialTranscript(), stopping: false, errors: [],
      ...(opts.skillDraft ? { skillDraft: true } : {}), ...(opts.runId ? { runId: opts.runId } : {}) }]);
    const base = onFrame(id, local);
    try {
      await open((frame) => { state = reduce(state, frame); base(frame); }, ac.signal);
    } catch (e) {
      error = e;
      patch(id, (x) => ({ ...x, errors: [...x.errors, msgOf(e, t)] }));
    } finally {
      base.flush();
    }
    let text: string | null = null;
    if (!local.runId && !local.confirmed) patch(id, (x) => (x.runId ? x : { ...x, confirmed: "failed" }));
    else if (local.confirmed === "completed") text = state.items.flatMap((i) => (i.kind === "message" ? [i.text] : [])).join("\n\n").trim() || null;
    else if (!local.confirmed && local.runId) text = (await pollUntilTerminal(id, local.runId, ac))?.trim() || null;
    followers.current.delete(ac);
    return { text, error };
  }

  /** "Nova conversa" out of another channel's conversation (v0.9 §1.7): the screen starts clean, and the text for the composer is the end of the
   *  old one (what is on screen) plus the message that was refused. Nothing is sent: the person reviews it and sends. */
  function startNew(refused: Turn): string {
    const note = summaryOf(turns.filter((x) => x.id !== refused.id), refused.otherChannel?.source ?? null, t);
    sessionId.current = null;
    setTurns([]);
    return note + refused.user;
  }

  /** "Continuar numa cópia": Hermes copies the conversation and ENDS the original, so this runs only on a person's click. -> the refused
   *  message for the composer, or null when the copy failed (the card stays, with the reason). */
  async function forkConversation(refused: Turn): Promise<string | null> {
    const sid = sessionId.current;
    if (!sid) return null;
    try {
      sessionId.current = (await forkSession(bot, sid)).session.id;
      setTurns((ts) => ts.filter((x) => x.id !== refused.id));
      return refused.user;
    } catch (e) {
      patch(refused.id, (x) => ({ ...x, errors: [...x.errors, msgOf(e, t)] }));
      return null;
    }
  }

  /** The session this conversation continues (null before the first message): where background results are delivered. */
  const session = React.useCallback(() => sessionId.current, []);
  return { turns, active: turns.find(isActive), loadingHistory: !historyReady, send, stop, markResuming, session, startNew, forkConversation, ensureSession, follow };
}
