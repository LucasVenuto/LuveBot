// dashboard/src/components/screen/ScreenTab.tsx
// The work panel's "Tela" tab (D-007 §4): an honest refusal when Hermes cannot show a screen (its own words, as text),
// watching by default, and taking / giving back control only after a confirmation. noVNC is loaded at run time (novnc.ts).
// The socket is opened here and handed to noVNC, so Hermes's close codes (4000, 4401, 4001, 4403) are read without
// touching the vendored code.

import React from "react";
import { ApiError, getScreen, startScreen, watchScreen, takeScreen, returnScreen } from "../../api/client";
import type { BotScreen, ScreenTicket } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { useNarrow } from "../../hooks/useNarrow";
import { Dialog } from "../ui/Dialog";
import { loadRFB, screenSocketUrl, keysymOf, XK_RETURN, XK_BACKSPACE, canvasSignature, type RFBLike } from "./novnc";
import { screenState, closeOutcome, noImageFor, type ScreenState } from "./screen";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

const README_SCREEN = "https://github.com/LucasVenuto/LuveBot#live-screen";
type Mode = "watch" | "control";
type Phase = "loading" | "idle" | "starting" | "connecting" | "watching" | "control" | "lost" | "refused" | "error";

const ERR: Record<string, TranslationKey> = {
  screen_unavailable: "screenErrUnavailable", screen_in_use: "screenErrInUse", screen_not_running: "screenErrNotRunning",
  screen_not_yours: "screenErrNotYours", loopback_not_human: "screenErrLoopback",
  screen_unsupported: "screenUnsupported", screen_not_installed: "screenNotInstalled", screen_no_memory: "screenNoMemory",
};
const muted: React.CSSProperties = { color: "var(--color-muted-foreground)", font: "400 13px/18px var(--lb-font)", margin: 0 };
const box: React.CSSProperties = { padding: "12px 14px", borderRadius: 12, background: "var(--lb-fill)", display: "flex", flexDirection: "column", gap: 8 };
const code: React.CSSProperties = { fontFamily: "var(--lb-mono)", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 };

export function ScreenTab({ bot, label }: { bot: string; label: string }) {
  const { t } = useLuveI18n();
  const narrow = useNarrow();
  const [screen, setScreen] = React.useState<BotScreen | null>(null);
  const [refusal, setRefusal] = React.useState<ScreenState | null>(null);  // from a refused start, with Hermes's details
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [confirm, setConfirm] = React.useState<"take" | "return" | null>(null);
  const [reason, setReason] = React.useState("");
  const target = React.useRef<HTMLDivElement>(null);
  const kbd = React.useRef<HTMLTextAreaElement>(null);
  const live = React.useRef<{ ws: WebSocket; rfb: RFBLike } | null>(null);
  const spent = React.useRef(0);   // consecutive 4401s: a second one in a row stops the loop
  const alive = React.useRef(true);
  const frames = React.useRef<{ ws: WebSocket; since: number; painted: number | null; pending: number | null; sig: string } | null>(null);
  const [noImage, setNoImage] = React.useState<number | null>(null);  // seconds without a picture (screen.ts noImageFor)

  const errText = (e: unknown): ErrorState => {
    if (e instanceof ApiError) return ERR[e.code] ? t(ERR[e.code]) : humanError(e, t, "screenErrGeneric");
    return t("screenErrNetwork");
  };

  const drop = () => {
    const cur = live.current;
    live.current = null;  // a socket that is no longer current never drives the state
    if (cur) { try { cur.rfb.disconnect(); } catch { /* already closed */ } }
  };

  const load = React.useCallback(async () => {
    setPhase("loading");
    try {
      const { screen: s } = await getScreen(bot);
      if (!alive.current) return;
      setScreen(s);
      setRefusal(null);
      if (screenState(s).kind === "running") await open("watch");
      else setPhase("idle");
    } catch (e) {
      if (alive.current) { setError(errText(e)); setPhase("error"); }
    }
  }, [bot]); // eslint-disable-line react-hooks/exhaustive-deps

  async function connect(mode: Mode, ticket: ScreenTicket) {
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
    ws.addEventListener("message", () => { const f = frames.current; if (f?.ws === ws && f.pending === null) f.pending = Date.now(); });
    ws.addEventListener("close", (ev) => { if (live.current?.ws === ws) void onClosed((ev as CloseEvent).code); });
  }

  async function onClosed(closeCode: number) {
    live.current = null;
    frames.current = null;
    setNoImage(null);
    const outcome = closeOutcome(closeCode);
    if (outcome === "taken") { setNotice(t("screenControlTaken")); await open("watch"); }
    else if (outcome === "ticket" && spent.current < 1) { spent.current += 1; setNotice(t("screenTicketSpent")); await open("watch"); }
    else if (outcome === "stopped") { setNotice(t("screenWentDown")); await load(); }
    else if (outcome === "refused") { setError(t("screenOriginRefused")); setPhase("refused"); }
    else { setNotice(t("screenLost")); setPhase("lost"); }
  }

  async function open(mode: Mode, why?: string) {
    try {
      const ticket = mode === "watch" ? await watchScreen(bot) : await takeScreen(bot, why);
      if (alive.current) await connect(mode, ticket);
    } catch (e) {
      if (!alive.current) return;
      setError(errText(e));
      if (mode === "control" && live.current) setPhase("watching"); else setPhase("error");
    }
  }

  async function start() {
    setPhase("starting");
    setError(null);
    try {
      const { screen: s } = await startScreen(bot);
      if (!alive.current) return;
      setScreen(s);
      if (screenState(s).kind === "running") await open("watch"); else setPhase("idle");
    } catch (e) {
      if (!alive.current) return;
      const d = e instanceof ApiError ? (e.details ?? {}) : {};
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
      if (alive.current) { setNotice(null); await open("watch"); }
    } catch (e) {
      if (alive.current) setError(errText(e));
    }
  }

  React.useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; drop(); };
  }, [load]);

  // Once a second while the picture is up: did the canvas change? If not, for how long without a picture (screen.ts).
  const showing = phase === "watching" || phase === "control";
  React.useEffect(() => {
    if (!showing) return;
    const id = window.setInterval(() => {
      const f = frames.current;
      if (!f || live.current?.ws !== f.ws) return;
      const sig = canvasSignature(target.current?.querySelector("canvas") ?? null);
      const now = Date.now();
      if (sig === null) { setNoImage(null); return; }  // this browser cannot read the canvas: say nothing rather than guess
      if (sig !== "blank" && sig !== f.sig) { f.sig = sig; f.painted = now; f.pending = null; }
      setNoImage(noImageFor(now, f));
    }, 1000);
    return () => window.clearInterval(id);
  }, [showing]);
  const reconnect = () => { setNoImage(null); frames.current = null; void open(phase === "control" ? "control" : "watch"); };

  // Phone keyboard: noVNC brings only its core, so typed characters are forwarded as keysyms while in control.
  const onType = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const rfb = live.current?.rfb;
    const text = e.currentTarget.value;
    e.currentTarget.value = "";
    if (rfb) for (const ch of Array.from(text)) rfb.sendKey(keysymOf(ch), null);
  };
  const onTypeKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const rfb = live.current?.rfb;
    if (!rfb) return;
    if (e.key === "Enter") { e.preventDefault(); rfb.sendKey(XK_RETURN, "Enter"); }
    else if (e.key === "Backspace") { e.preventDefault(); rfb.sendKey(XK_BACKSPACE, "Backspace"); }
  };

  const state = refusal ?? (screen ? screenState(screen) : null);
  const otherHuman = screen?.lease.holder === "human" && !screen.lease.mine;
  const showCanvas = phase === "connecting" || phase === "watching" || phase === "control";
  const status = phase === "loading" ? t("screenLoading") : phase === "starting" ? t("screenStarting") : phase === "connecting" ? t("screenConnecting")
    : phase === "watching" ? (otherHuman ? t("screenOtherHuman") : t("screenWatching")) : phase === "control" ? t("screenInControl") : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, height: "100%" }}>
      <p role="status" aria-live="polite" style={{ ...muted, minHeight: 18 }}>{[notice, status].filter(Boolean).join(" ")}</p>
      {error && <p role="alert" style={{ ...muted, color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}

      {!showCanvas && state && phase !== "loading" && <Refusal state={state} t={t} onStart={() => void start()} busy={phase === "starting"} />}
      {(phase === "lost" || phase === "error") && (
        <button type="button" className="lb-btn" style={{ alignSelf: "flex-start" }} onClick={() => { setError(null); setNotice(null); void load(); }}>
          {phase === "lost" ? t("screenReconnectBtn") : t("screenRetryBtn")}
        </button>
      )}

      <div ref={target} role="region" aria-label={t("screenRegion", { name: label })} tabIndex={showCanvas ? 0 : -1} hidden={!showCanvas}
        className="lb-screen" data-mode={phase === "control" ? "control" : "watch"} />

      {phase === "control" && <div className="lb-screen-banner" role="note">{t("screenInControl")}</div>}
      {showing && noImage !== null && (
        <div role="status" style={{ ...box, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <p style={muted}>{t("screenNoImage", { n: Math.floor(noImage / 5) * 5 })}</p>
          <button type="button" className="lb-btn" onClick={reconnect}>{t("screenReconnectBtn")}</button>
        </div>
      )}
      {(phase === "watching" || phase === "control") && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {phase === "watching"
            ? <button type="button" className="lb-btn lb-btn-primary" onClick={() => { setReason(""); setConfirm("take"); }}>{t("screenTakeBtn")}</button>
            : <button type="button" className="lb-btn lb-btn-primary" onClick={() => setConfirm("return")}>{t("screenReturnBtn")}</button>}
          {phase === "control" && narrow && <button type="button" className="lb-btn" onClick={() => kbd.current?.focus()}>{t("screenKeyboardBtn")}</button>}
          {typeof target.current?.requestFullscreen === "function" &&
            <button type="button" className="lb-btn" onClick={() => void target.current?.requestFullscreen()}>{t("screenFullscreenBtn")}</button>}
        </div>
      )}
      {phase === "control" && narrow && (
        <textarea ref={kbd} aria-label={t("screenKeyboardInput")} className="lb-screen-kbd" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          onInput={onType} onKeyDown={onTypeKey} />
      )}

      <Dialog open={confirm === "take"} onClose={() => setConfirm(null)} title={t("screenTakeTitle")} titleId="screen-take-title" tone="warning">
        <div className="lb-dialog-body">
          <p style={muted}>{t("screenTakeBody")}</p>
          {otherHuman && <p style={muted}>{t("screenTakeOther")}</p>}
          <div className="lb-field">
            <label className="lb-label" htmlFor="screen-take-reason">{t("screenReasonLabel")}</label>
            <input id="screen-take-reason" className="lb-input" maxLength={120} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="lb-dialog-footer">
            <button type="button" className="lb-btn" onClick={() => setConfirm(null)}>{t("cancelBtn")}</button>
            <button type="button" className="lb-btn lb-btn-primary" onClick={() => { setConfirm(null); setNotice(null); setError(null); void open("control", reason.trim() || undefined); }}>{t("screenTakeConfirm")}</button>
          </div>
        </div>
      </Dialog>
      <Dialog open={confirm === "return"} onClose={() => setConfirm(null)} title={t("screenReturnTitle")} titleId="screen-return-title">
        <div className="lb-dialog-body">
          <p style={muted}>{t("screenReturnBody")}</p>
          <div className="lb-dialog-footer">
            <button type="button" className="lb-btn" onClick={() => setConfirm(null)}>{t("cancelBtn")}</button>
            <button type="button" className="lb-btn lb-btn-primary" onClick={() => void giveBack()}>{t("screenReturnConfirm")}</button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function Refusal({ state, t, onStart, busy }: { state: ScreenState; t: (k: TranslationKey, p?: Record<string, string | number>) => string; onStart: () => void; busy: boolean }) {
  switch (state.kind) {
    case "unsupported": return <div style={box}><p style={muted}>{t("screenUnsupported")}</p></div>;
    case "not_installed": return (
      <div style={box}>
        <p style={muted}>{t("screenNotInstalled")}</p>
        {state.missing.length > 0 && <p style={muted}><strong>{t("screenMissingLabel")}:</strong> {state.missing.join(", ")}</p>}
        {state.installCommand && <><p style={muted}>{t("screenInstallCommandLabel")}:</p><pre style={code}>{state.installCommand}</pre></>}
        <a href={README_SCREEN} target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-primary)", fontSize: 13 }}>{t("screenReadmeLink")}</a>
      </div>
    );
    case "no_memory": return (
      <div style={box}>
        <p style={muted}>{t("screenNoMemory")}</p>
        <p style={muted}>{t("screenMemoryNumbers", { available: state.availableMb ?? "?", needed: state.neededMb ?? "?" })}</p>
        {state.blocker && <><p style={muted}>{t("screenHermesSays")}:</p><pre style={code}>{state.blocker}</pre></>}
      </div>
    );
    case "sandbox": return <div style={box}><p style={muted}>{t("screenSandbox", { placement: state.placement })}</p></div>;
    case "stopped": return (
      <div style={box}>
        <p style={muted}>{t("screenStopped")}</p>
        <button type="button" className="lb-btn lb-btn-primary" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={onStart}>{t("screenStartBtn")}</button>
      </div>
    );
    default: return null;
  }
}
