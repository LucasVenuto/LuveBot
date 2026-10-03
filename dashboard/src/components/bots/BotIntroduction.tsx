// dashboard/src/components/bots/BotIntroduction.tsx
// The last step of "Criar Bot": the Bot introduces itself for real (contract v0.4 B4, POST /bots/{bot}/introduction). It is a
// real model run, so it starts only on a click that confirms its cost; while it runs the step says so, and what is shown is
// the Bot's own answer (GET /runs/{id} output, through <Markdown>). Nothing is made up: a refusal or a failure is said in
// words, never replaced by a sample text.

import React from "react";
import { ApiError, getIntroduction, startIntroduction, getRun } from "../../api/client";
import type { IntroductionView } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { Markdown } from "../../lib/render/markdown";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";
import { formatCents } from "../costs/CostsView";

export const POLL_MS = 2000;
export const POLL_TRIES = 60;  // two minutes; after that the answer is in the conversation anyway
// A Bot just created is often not served by Hermes yet (offline, hook not live): those reasons pass, so it asks again for up
// to two minutes and the offer appears when the Bot is ready. The other reasons (no template, paused, cap) stay as said.
export const RECHECK_MS = 3000;
export const RECHECK_TRIES = 40;
const TRANSIENT = new Set(["bot_offline", "hook_not_live"]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const REASON: Record<string, TranslationKey> = {
  no_template: "introNoTemplate", hook_not_live: "introHookNotLive", bot_offline: "introBotOffline",
  bot_paused: "introBotPaused", budget_exceeded: "introBudgetExceeded",
};

type Phase =
  | { kind: "loading" }
  | { kind: "offer"; estimate: number | null }
  | { kind: "running" }
  | { kind: "answer"; text: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "failed"; error: ErrorState }
  | { kind: "slow" };

export function BotIntroduction({ bot, onSession }: { bot: string; onSession?: (sessionId: string) => void }) {
  const { t, locale } = useLuveI18n();
  const [phase, setPhase] = React.useState<Phase>({ kind: "loading" });
  const [busy, setBusy] = React.useState(false);
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);

  /** Follows the introduction's run until Hermes says it ended; only its real output is shown. */
  const follow = React.useCallback(async (view: IntroductionView) => {
    if (view.session_id) onSession?.(view.session_id);
    if (!view.run_id) { setPhase({ kind: "failed", error: t("introFailed") }); return; }
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

  /** What Hermes and LuveBot say now; a passing reason (TRANSIENT) is asked again until the Bot is ready. */
  const check = React.useCallback(async (waitFirst = false) => {
    if (waitFirst) await new Promise((r) => setTimeout(r, RECHECK_MS));  // the refusal stays on screen until it is asked again
    for (let i = 0; alive.current; i++) {
      try {
        const view = await getIntroduction(bot);
        if (!alive.current) return;
        if (view.state === "unavailable") {
          setPhase({ kind: "unavailable", reason: view.reason ?? "" });
          if (TRANSIENT.has(view.reason ?? "") && i < RECHECK_TRIES) { await new Promise((r) => setTimeout(r, RECHECK_MS)); continue; }
        } else if (view.state === "none") setPhase({ kind: "offer", estimate: view.estimate_cents });
        else await follow(view);  // running or done: show what it said
      } catch (e) {
        if (alive.current) setPhase({ kind: "failed", error: humanError(e, t, "introFailed") });
      }
      return;
    }
  }, [bot, t, follow]);

  React.useEffect(() => { void check(); }, [bot]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    setBusy(true);
    try {
      await follow(await startIntroduction(bot));  // the click is the cost confirmation
    } catch (e) {
      const reason = e instanceof ApiError ? e.code : "";
      setPhase(REASON[reason] ? { kind: "unavailable", reason } : { kind: "failed", error: humanError(e, t, "introFailed") });
      if (TRANSIENT.has(reason)) void check(true);  // refused because the Bot was not ready yet: the offer comes back when it is
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const box: React.CSSProperties = { width: "100%", textAlign: "left", display: "flex", flexDirection: "column", gap: 10, padding: 16, borderRadius: 16,
    border: "1px solid var(--lb-separator)", background: "var(--color-popover)", fontSize: 14 };
  return (
    <section aria-label={t("introTitle")} style={box} data-testid="bot-introduction">
      <h4 className="lb-headline" style={{ margin: 0 }}>{t("introTitle")}</h4>
      {phase.kind === "loading" && <p role="status" className="lb-subhead" style={{ margin: 0 }}>{t("introLoading")}</p>}
      {phase.kind === "offer" && (
        <>
          <p className="lb-subhead" style={{ margin: 0 }}>
            {phase.estimate !== null ? t("introOffer", { cost: formatCents(phase.estimate, locale) }) : t("introOfferNoEstimate")}
          </p>
          <button type="button" className="lb-btn lb-btn-primary" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void start()}>
            {busy ? t("introStarting") : t("introStart")}
          </button>
        </>
      )}
      {phase.kind === "running" && <p role="status" className="lb-subhead" style={{ margin: 0 }}>{t("introRunning")}</p>}
      {phase.kind === "answer" && <div data-testid="bot-introduction-answer"><Markdown text={phase.text} /></div>}
      {phase.kind === "slow" && <p role="status" className="lb-subhead" style={{ margin: 0 }}>{t("introSlow")}</p>}
      {phase.kind === "unavailable" && <p role="status" className="lb-subhead" style={{ margin: 0 }}>{t(REASON[phase.reason] ?? "introUnavailable")}</p>}
      {phase.kind === "failed" && <p role="alert" className="lb-caption" style={{ margin: 0, color: "var(--color-destructive)" }}><ErrorNote error={phase.error} /></p>}
    </section>
  );
}
