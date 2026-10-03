// dashboard/src/components/ui/ListState.tsx
// Where the Bot list stands. A screen may say "no Bot yet" only when the list LOADED and came back empty: while it loads
// it shows a skeleton, and a failed load is an error with "Tentar novamente", never an empty team (the CEO saw the
// onboarding on Hoje while the sidebar was still loading).

import React from "react";
import { useLuveI18n } from "../../i18n";

export type ListStatus = "loading" | "error" | "ready";

export function BotsLoading({ rows = 2 }: { rows?: number }) {
  const { t } = useLuveI18n();
  return (
    <div data-testid="bots-loading" aria-busy="true" aria-label={t("loadingBots")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: rows }, (_, k) => (
        <div key={k} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 36, height: 36, flexShrink: 0, borderRadius: "36%", background: "var(--color-muted)" }} />
          <span style={{ flex: 1, height: 12, borderRadius: 6, background: "var(--color-muted)" }} />
        </div>
      ))}
    </div>
  );
}

export function BotsError({ onRetry }: { onRetry?: () => void }) {
  const { t } = useLuveI18n();
  return (
    <div role="alert" data-testid="bots-error" className="lb-alert">
      <strong>{t("errorLoadingBots")}</strong>
      {onRetry && <div><button type="button" className="lb-btn lb-btn-plain" onClick={onRetry}>{t("retry")}</button></div>}
    </div>
  );
}
