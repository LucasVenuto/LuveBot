// dashboard/src/components/settings/Inactivity.tsx
// Pause by inactivity (contract v0.8 §8; spec 4.9). Settings card: after X days with nobody opening LuveBot the ROUTINES are paused
// (conversations and channels are not). Banner, on the next visit: "Pausei N rotinas porque você ficou X dias fora" with "Retomar",
// which resumes ONLY what that pause paused (POST /routines/inactivity-resume, a person with a login: loopback gets 403). Nothing
// here resumes by itself, and the banner is the pending decision, so it has no "dispensar". Whether a change is allowed is the
// backend's call (turning it off or lengthening it needs a login); the screen says so in words and shows the sentence it gets back.

import React from "react";
import type { InactivityDays, InactivityStatus } from "../../api/types";
import { getInactivityPause, getSession, resumeAfterInactivity, setInactivityPause } from "../../api/client";
import { useLuveI18n } from "../../i18n";
import { noLoginOf, type NoLogin } from "../../lib/authMode";
import { ClockIcon } from "../Icons";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

export const INACTIVITY_DAYS: readonly InactivityDays[] = [3, 7, 14, 30];

/** The status of the pause (GET /settings/inactivity-pause), read once; a failed read is no banner and no value, never an error screen. */
function useInactivityStatus() {
  const [status, setStatus] = React.useState<InactivityStatus | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    getInactivityPause().then((s) => { if (alive) setStatus(s); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);
  return { status, setStatus, failed };
}

export function InactivityBanner({ onResumed, className = "" }: { onResumed?: (count: number) => void; className?: string }) {
  const { t, locale } = useLuveI18n();
  const { status, setStatus } = useInactivityStatus();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [resumed, setResumed] = React.useState<number | null>(null);

  if (resumed !== null) {
    return <p role="status" data-testid="inactivity-resumed" className={`lb-group lb-subhead ${className}`} style={{ padding: "12px 16px" }}>
      {resumed === 0 ? t("inactResumedNone") : resumed === 1 ? t("inactResumedOne") : t("inactResumedMany", { count: resumed })}
    </p>;
  }
  const paused = status?.paused;
  if (!paused) return null;
  const when = new Date(paused.at * 1000).toLocaleDateString(locale === "pt" ? "pt-BR" : "en-US", { day: "numeric", month: "long" });
  const resume = async () => {
    setBusy(true); setError(null);
    try {
      const { resumed: count } = await resumeAfterInactivity();
      setResumed(count); setStatus((s) => (s ? { ...s, paused: null } : s)); onResumed?.(count);
    } catch (e) {
      setError(humanError(e, t, "inactResumeError"));
      setBusy(false);
    }
  };
  return (
    <section data-testid="inactivity-banner" aria-label={t("inactTitle")} className={`lb-group ${className}`} style={{ padding: "12px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
      <ClockIcon size={18} />
      <div style={{ flex: "1 1 240px", minWidth: 0 }}>
        <p className="lb-body" style={{ margin: 0, fontWeight: 600 }}>
          {paused.count === 1 ? t("inactBannerOne", { days: paused.days }) : t("inactBannerMany", { count: paused.count, days: paused.days })}
        </p>
        <p className="lb-caption" style={{ margin: 0 }}>{t("inactBannerWhen", { date: when })}</p>
        {error && <p role="alert" className="lb-caption" style={{ margin: "4px 0 0", color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
      </div>
      <button type="button" data-testid="btn-inactivity-resume" className="lb-btn lb-btn-primary" disabled={busy} onClick={resume}>
        {busy ? t("inactResuming") : t("inactResume")}
      </button>
    </section>
  );
}

export function InactivityCard() {
  const { t } = useLuveI18n();
  const { status, setStatus, failed } = useInactivityStatus();
  const [noLogin, setNoLogin] = React.useState<NoLogin | null>(null);          // loopback (no login) or the deployment token (a machine): both may turn it on or shorten it, neither the rest
  const [note, setNote] = React.useState<"saved" | ErrorState | null>(null);
  React.useEffect(() => {
    let alive = true;
    getSession().then((s) => { if (alive) setNoLogin(noLoginOf(s?.auth_mode)); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const change = async (value: string) => {
    const days = value === "off" ? null : (Number(value) as InactivityDays);
    try {
      const saved = await setInactivityPause(days);
      setStatus((s) => (s ? { ...s, days: saved.days } : { days: saved.days, paused: null }));
      setNote("saved");
    } catch (e) {
      setNote(humanError(e, t, "inactError"));   // the select stays on what is stored: it is controlled by `status`
    }
  };

  return (
    <section aria-labelledby="settings-inactivity">
      <h2 id="settings-inactivity" className="lb-headline" style={{ margin: "24px 4px 8px" }}>{t("inactTitle")}</h2>
      <div className="lb-group">
        <label className="lb-row" style={{ justifyContent: "space-between", gap: 12 }}>
          <span className="lb-body">{t("inactLabel")}</span>
          <select data-testid="select-inactivity" disabled={!status} value={status ? (status.days === null ? "off" : String(status.days)) : "off"}
            onChange={(e) => void change(e.target.value)} className="lb-input" style={{ width: "auto", minWidth: 140 }}>
            <option value="off">{t("inactOff")}</option>
            {INACTIVITY_DAYS.map((d) => <option key={d} value={d}>{t("inactDays", { n: d })}</option>)}
          </select>
        </label>
      </div>
      <p className="lb-caption" style={{ color: "var(--color-muted-foreground)", margin: "8px 16px" }}>{t("inactHint")}</p>
      {noLogin && <p data-testid="inactivity-loopback" className="lb-caption" style={{ color: "var(--color-muted-foreground)", margin: "0 16px 8px" }}>{noLogin === "deployment" ? t("errCredentialNotHuman") : t("inactLoopbackHint")}</p>}
      {failed && <p role="alert" className="lb-caption" style={{ color: "var(--color-destructive)", margin: "0 16px" }}>{t("inactLoadError")}</p>}
      {note === "saved" && <p role="status" className="lb-caption" style={{ margin: "0 16px" }}>{t("inactSaved")}</p>}
      {note && note !== "saved" && <p role="alert" className="lb-caption" style={{ color: "var(--color-destructive)", margin: "0 16px" }}><ErrorNote error={note} /></p>}
    </section>
  );
}
