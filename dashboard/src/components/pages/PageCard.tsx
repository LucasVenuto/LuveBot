// dashboard/src/components/pages/PageCard.tsx
// "O Bot atualizou X" in the conversation (v0.5 §7.1). The page glyph is CSS, not an svg, because the turn
// keeps no svg (test_sanitize). The title is text from our own event, shown as data.

import React from "react";
import { useLuveI18n } from "../../i18n";

export function PageCard({ title, botLabel, onOpen }: { title: string; botLabel: string; onOpen?: () => void }) {
  const { t } = useLuveI18n();
  return (
    <div className="lb-page-card">
      <span aria-hidden="true" className="lb-page-glyph"><i /><i /><i /></span>
      <span className="lb-row-stack">
        <span className="lb-headline lb-truncate">{title}</span>
        <span className="lb-caption">{t("pageCardMeta", { name: botLabel })}</span>
      </span>
      {onOpen && <button type="button" onClick={onOpen} className="lb-btn" aria-label={t("pageOpenNamed", { title })}>{t("pageOpen")}</button>}
    </div>
  );
}
