// dashboard/src/components/chat/OtherChannelCard.tsx
// A conversation that belongs to another channel (409 session_other_channel, contract v0.9 §1.7). Hermes only lets a conversation continue
// where it began, so the normal way out is a NEW conversation (the end of this one and the refused message go to the composer: nothing is
// sent). "Continuar numa cópia" is the second button, with its warning: Hermes ENDS the original. Both are a person's click.

import React from "react";
import { useLuveI18n } from "../../i18n";
import { card } from "./InlineApproval";

export function OtherChannelCard({ source, onNew, onFork }: { source: string | null; onNew: () => void; onFork: () => Promise<void> }) {
  const { t } = useLuveI18n();
  const [forking, setForking] = React.useState(false);
  const where = source === "cli" ? t("channelSrcCli") : source === "telegram" ? t("channelSrcTelegram") : t("channelSrcOther");
  return (
    <div data-testid="other-channel-card" role="group" aria-label={t("channelTitle")} style={card}>
      <div className="lb-body" style={{ fontWeight: 600 }}>{t("channelTitle")} <span className="lb-caption" style={{ fontWeight: 400 }}>({where})</span></div>
      <p className="lb-subhead" style={{ margin: "6px 0 0" }}>{t("channelBody")}</p>
      <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <button type="button" className="lb-btn lb-btn-primary" disabled={forking} onClick={onNew}>{t("channelNew")}</button>
        <button type="button" className="lb-btn" disabled={forking} aria-describedby="channel-fork-warn"
          onClick={async () => { setForking(true); try { await onFork(); } finally { setForking(false); } }}>{forking ? t("channelForking") : t("channelFork")}</button>
      </div>
      <p id="channel-fork-warn" className="lb-caption" style={{ margin: "6px 0 0" }}>{t("channelForkWarn")}</p>
    </div>
  );
}
