// dashboard/src/voice/CallButton.tsx
// The Call button in the composer (paginas-ui §9, contract v0.7 section 4.1): the phone. The microphone is asked ONLY from its click (the
// first call shows the cost notice first, and "Ligar mesmo assim" is the click that starts it). Off, with the reason, when the Bot's
// voice status does not allow a call (invariant 9: a call is offered only when it can work, and never past the spending cap).
import React from "react";
import { useLuveI18n } from "../i18n";
import { PhoneIcon } from "../components/Icons";
import type { VoiceStatus } from "../api/types";

let noticeSeen = false;   // said once per page load, in memory only (nothing of a call is stored)

type Call = { phase: string; begin: () => Promise<void> };

export function CallButton({ call, status, disabled, reason }: { call: Call; status: VoiceStatus["call"] | null; disabled: boolean; reason?: string }) {
  const { t, locale } = useLuveI18n();
  const [notice, setNotice] = React.useState(false);
  const busy = call.phase !== "idle";
  const money = (cents: number) => (cents / 100).toLocaleString(locale === "pt" ? "pt-BR" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const price = status ? money(status.cents_per_minute) : "";
  const minutes = status ? Math.round(status.max_seconds / 60) : 0;
  const reserve = status ? money(status.cents_per_minute * minutes) : "";
  const go = () => { noticeSeen = true; setNotice(false); void call.begin(); };

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button type="button" className="lb-icon-btn" disabled={disabled || busy} aria-label={t("callLabel")} title={reason ?? t("callLabel")} data-testid="call-button"
        aria-haspopup="dialog" aria-expanded={notice}
        onClick={() => { if (disabled || busy) return; if (noticeSeen) go(); else setNotice((n) => !n); }}
        style={{ width: 40, height: 40, flexShrink: 0 }}>
        <PhoneIcon size={18} />
      </button>
      {notice && (
        <div role="dialog" aria-label={t("callNoticeTitle")} data-testid="call-notice" onKeyDown={(e) => { if (e.key === "Escape") setNotice(false); }}
          style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, width: 300, maxWidth: "80vw", padding: 14, borderRadius: 16, zIndex: 30,
            background: "var(--color-card)", color: "var(--color-foreground)", border: "1px solid var(--lb-separator)", boxShadow: "0 8px 28px rgba(0,0,0,.18)" }}>
          <div className="lb-headline">{t("callNoticeTitle")}</div>
          <p className="lb-subhead" style={{ margin: "6px 0 10px" }}>{t("callNoticeBody", { price, reserve, minutes })}</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="lb-btn" onClick={() => setNotice(false)}>{t("callNoticeCancel")}</button>
            <button type="button" className="lb-btn lb-btn-primary" autoFocus onClick={go}>{t("callNoticeGo")}</button>
          </div>
        </div>
      )}
    </span>
  );
}
