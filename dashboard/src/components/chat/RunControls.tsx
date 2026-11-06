// dashboard/src/components/chat/RunControls.tsx
// What a Hermes main (session authority) can make a run wait for, said inside the conversation (contract v0.9 §1.2-1.4): the Bot's question
// (clarify: one question, its choices, one or more) and a run Hermes lost track of (unknown). Both are a person's click, with a login
// (the Bot uses clarify as a soft confirmation: invariant 6), never automatic. Clarify never reaches the stream: the run is read by GET every
// 3 s while the turn is open, and only while the backend sends `pending_controls` (a backend or Hermes without it is asked once, then left alone).
// The question and the choices are the Bot's words: plain text, never markup. No <form> (the composer is the conversation's only form).

import React from "react";
import { getRun, getSession, answerClarify, skipClarify, resolveUnknownRun, type RunInfo } from "../../api/client";
import type { RunControl } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { displayQuestion, displayChoice } from "../../lib/clarifyText";
import { noLoginOf, type NoLogin } from "../../lib/authMode";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";
import { card, field, closedLine, atRest, focusIsFree } from "./InlineApproval";

type Clarify = Extract<RunControl, { kind: "clarify" }>;
export const POLL_MS = 3000;

/** The run's open controls, from GET run every `pollMs` while `active`. */
export function useRunControls(bot: string, runId: string | undefined, active: boolean, pollMs = POLL_MS) {
  const [run, setRun] = React.useState<RunInfo | null>(null);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!active || !runId) { setRun(null); return; }
    let alive = true;
    let timer: number | undefined;
    const read = async () => {
      let again = true;
      try {
        const { run: r } = await getRun(bot, runId);
        if (!alive) return;
        if (!Array.isArray(r.pending_controls) && !r.resolution) { setRun(null); again = false; }  // this backend does not say: stop asking
        else setRun(r);
      } catch { /* asked again on the next tick */ }
      if (alive && again) timer = window.setTimeout(read, pollMs);
    };
    void read();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [bot, runId, active, pollMs, tick]);
  const refresh = React.useCallback(() => setTick((n) => n + 1), []);
  const generation = run?.execution_generation;
  const clarify = (run?.pending_controls ?? []).filter((c): c is Clarify => c.kind === "clarify" && !!c.request_id);
  const unknown = run?.status === "unknown" && run.resolution?.needed ? run.resolution : null;
  return { clarify, unknown, generation, refresh };
}

type RunControlsProps = { bot: string; runId?: string; active: boolean; onNeedsYou?: (needs: boolean) => void; pollMs?: number };

/** One run, one state (A-169): what is read, the cards (what was typed, "skipped", "sent") and the list of what this person closed all belong to ONE run, so when the run changes everything starts empty, however the
 *  request ids look (Hermes makes the id per question, but that is chance, not its contract: two runs may show the same id for different questions, and different ids would still leave the first run's lines). */
export function RunControls(props: RunControlsProps) {
  return <RunControlsOf key={`${props.bot}/${props.runId ?? ""}`} {...props} />;
}

function RunControlsOf({ bot, runId, active, onNeedsYou, pollMs }: RunControlsProps) {
  const { clarify, unknown, generation, refresh } = useRunControls(bot, runId, active, pollMs);
  const needs = clarify.length > 0 || !!unknown;
  React.useEffect(() => { onNeedsYou?.(needs); return () => onNeedsYou?.(false); }, [needs]); // eslint-disable-line react-hooks/exhaustive-deps
  // What this person closed HERE (an answer, a skip, "it ended") stays on screen as its confirmation line while the turn is open: Hermes stops listing the control the moment it is resolved, and
  // without this the confirmation lived one round trip (a few ms): nobody read it, no screen reader said it, and the focus had nowhere to land. One list, one key per question, so the card
  // that finished is the SAME card afterwards (its state, its focus). Questions that left without this person's click are not kept.
  const [closed, setClosed] = React.useState<Clarify[]>([]);
  const [resolved, setResolved] = React.useState<typeof unknown>(null);
  if (!runId) return null;
  const shown = [...closed.filter((k) => !clarify.some((c) => c.request_id === k.request_id)), ...clarify];
  const unknownShown = unknown ?? resolved;
  return (
    <>
      {shown.map((c) => (generation != null || closed.includes(c)) && (
        <ClarifyCard key={`${runId}:${c.request_id}`} bot={bot} runId={runId} control={c} generation={generation ?? 0}
          onDone={() => { setClosed((all) => (all.some((k) => k.request_id === c.request_id) ? all : [...all, c])); refresh(); }} />
      ))}
      {unknownShown && <UnknownRunCard bot={bot} runId={runId} generation={unknownShown.execution_generation} onDone={() => { setResolved(unknown); refresh(); }} />}
    </>
  );
}

/** Why this dashboard cannot decide, or null for a person: no login (loopback) or the deployment token (a machine). The server refuses these answers in both, so the card says so before the click. */
export function useNoLoginKind(): NoLogin | null {
  const [kind, setKind] = React.useState<NoLogin | null>(null);
  React.useEffect(() => {
    let alive = true;
    getSession().then((s) => { if (alive) setKind(noLoginOf(s?.auth_mode)); }, () => { /* the server decides at the click */ });
    return () => { alive = false; };
  }, []);
  return kind;
}
export const useNoLogin = (): boolean => useNoLoginKind() !== null;

function useSend(onDone: () => void) {
  const { t } = useLuveI18n();
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<"sent" | "skipped" | false>(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const box = React.useRef<HTMLDivElement>(null);         // the card: while focus is inside it, or lost, where it goes next is ours to say
  const status = React.useRef<HTMLParagraphElement>(null); // its confirmation line, once it worked
  const used = React.useRef<HTMLElement | null>(null);     // what had focus when the person acted: the button, or the answer field on Ctrl+Enter
  /** `how` is what the card says once it worked (an answer sent, or a question skipped): set only on SUCCESS, so a skip that failed never colours the answer that follows. */
  async function run(call: () => Promise<unknown>, how: "sent" | "skipped" = "sent") {
    if (busy || done) return;
    used.current = document.activeElement as HTMLElement | null;
    setBusy(true); setError(null);
    try { await call(); setDone(how); onDone(); }
    catch (e) { setError(humanError(e, t, "runErrGeneric")); }
    finally { setBusy(false); }
  }
  // The control that was used turns disabled while the request is on its way, and the browser drops its focus on the page body (Chrome does, at the click); on success the controls are gone as
  // well. Put the focus where the person will look next: the confirmation line, or back on what they used if it failed. A person who has already moved on (the composer, say) keeps their focus.
  const mine = () => focusIsFree(box);
  // Layout effects (see InlineApproval): the focus moves in the same commit that puts the confirmation on screen, never a frame on the page body.
  React.useLayoutEffect(() => { if (done && mine()) status.current?.focus(); }, [done]);
  React.useLayoutEffect(() => { if (error && !busy && mine()) used.current?.focus(); }, [error, busy]);
  return { busy, done, error, run, box, status };
}

const timeOf = (s: number) => (s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`);

function ClarifyCard({ bot, runId, control, generation, onDone }: { bot: string; runId: string; control: Clarify; generation: number; onDone: () => void }) {
  const { t } = useLuveI18n();
  const kind = useNoLoginKind();
  const noLogin = kind !== null;
  const choices = (control.choices ?? []).filter((c) => typeof c === "string" && c !== "");
  const many = choices.length > 0 && control.multi_select;
  const [text, setText] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>([]);
  const { busy, done, error, run, box, status } = useSend(onDone);
  // the exact label, or a JSON list of exact labels (in the Bot's order) when several may be chosen, or the free text (contract v0.9 §1.4)
  const answer = choices.length === 0 ? text.trim() : many ? (picked.length ? JSON.stringify(choices.filter((c) => picked.includes(c))) : "") : picked[0] ?? "";
  const send = () => { if (answer && !noLogin) void run(() => answerClarify(bot, runId, { request_id: control.request_id, execution_generation: generation, answer })); };
  // Skip (v0.11 §4.1): on every clarify control; the body is ONLY the request and the generation (whatever is typed or picked stays in the browser); the card then says it was skipped, never answered
  const skip = () => { if (!noLogin) void run(() => skipClarify(bot, runId, { request_id: control.request_id, execution_generation: generation }), "skipped"); };
  const toggle = (c: string) => setPicked((p) => (many ? (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]) : [c]));
  return (
    <div ref={box} data-testid="clarify-card" role="group" aria-label={t(done ? "clarifyHeadDone" : "clarifyHead")} style={done ? atRest : card}>
      <div className="lb-body" style={{ fontWeight: 600 }}>{t(done ? "clarifyHeadDone" : "clarifyHead")}</div>   {/* once closed it stays on screen: it no longer says the Bot is waiting */}
      <p className="lb-body" style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{displayQuestion(control.question)}</p>
      {control.timeout_s && !done ? <p className="lb-caption" style={{ margin: "4px 0 0" }}>{t("clarifyTimeout", { time: timeOf(control.timeout_s) })}</p> : null}
      {done ? <p ref={status} tabIndex={-1} role="status" className="lb-caption" style={closedLine}>{t(done === "skipped" ? "clarifySkipped" : "clarifySent")}</p> : (
        <>
          {choices.length > 0 ? (
            <div role={many ? "group" : "radiogroup"} aria-label={t(many ? "clarifyPickMany" : "clarifyPickOne")} style={{ marginTop: 8, display: "grid", gap: 6 }}>
              {choices.map((c, i) => {
                const shown = displayChoice(c, i === 0 && c === control.choices?.[0], choices.length);   // Hermes's English "(Recommended)" on the first choice, said in the screen's language; the answer stays `c`
                return (
                  <label key={c} className="lb-body" style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: busy ? "default" : "pointer" }}>
                    <input type={many ? "checkbox" : "radio"} name={`clarify-${control.request_id}`} checked={picked.includes(c)} disabled={busy} onChange={() => toggle(c)} style={{ marginTop: 4 }} />
                    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{shown.recommended ? `${shown.text} ${t("clarifyRecommended")}` : shown.text}</span>   {/* the Bot's text: a long address or hash must wrap, not push the card wider than the screen */}
                  </label>
                );
              })}
            </div>
          ) : (
            <textarea aria-label={t("clarifyAnswerLabel")} rows={2} value={text} disabled={busy} style={field}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
          )}
          {noLogin && <p role="status" className="lb-caption" style={{ margin: "8px 0 0" }}>{kind === "deployment" ? t("errCredentialNotHuman") : t("clarifyLogin")}</p>}
          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: 32, rowGap: 12 }}>
            <button type="button" className="lb-btn lb-btn-primary" disabled={busy || !answer || noLogin} onClick={send}>{busy ? t("clarifySending") : t("clarifySend")}</button>
            {/* apart from the send button (the far end of the row, or its own line when it wraps), a real button, never the field's default action, no confirmation: it is enabled exactly when the answer controls are */}
            <button type="button" className="lb-btn lb-btn-plain" aria-label={t("clarifySkipLabel")} disabled={busy || noLogin} onClick={skip} style={{ minWidth: 44 }}>{t("clarifySkip")}</button>
          </div>
        </>
      )}
      {error && <p role="alert" className="lb-caption" style={{ margin: "8px 0 0", color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
    </div>
  );
}

function UnknownRunCard({ bot, runId, generation, onDone }: { bot: string; runId: string; generation: number; onDone: () => void }) {
  const { t } = useLuveI18n();
  const kind = useNoLoginKind();
  const noLogin = kind !== null;
  const { busy, done, error, run, box, status } = useSend(onDone);
  return (
    <div ref={box} data-testid="unknown-run-card" role="group" aria-label={t("unknownHead")} style={done ? atRest : card}>
      <div className="lb-body" style={{ fontWeight: 600 }}>{t("unknownHead")}</div>
      {!done && <p className="lb-subhead" style={{ margin: "6px 0 0" }}>{t("unknownBody")}</p>}
      {done ? <p ref={status} tabIndex={-1} role="status" className="lb-caption" style={closedLine}>{t("unknownDone")}</p> : (
        <>
          {noLogin && <p role="status" className="lb-caption" style={{ margin: "8px 0 0" }}>{kind === "deployment" ? t("errCredentialNotHuman") : t("unknownLogin")}</p>}
          <div style={{ marginTop: 8 }}>
            <button type="button" className="lb-btn lb-btn-primary" disabled={busy || noLogin} onClick={() => void run(() => resolveUnknownRun(bot, runId, { execution_generation: generation }))}>{t("unknownBtn")}</button>
          </div>
        </>
      )}
      {error && <p role="alert" className="lb-caption" style={{ margin: "8px 0 0", color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
    </div>
  );
}
