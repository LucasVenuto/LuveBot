// dashboard/src/components/NeedsInProcess.tsx
// The ONE screen for Hermes's 409 `luvebot_needs_in_process` (plugins.isolation: host): what it is, and the three steps back. Shown by the
// app instead of the shell the moment any call meets that code; nothing else on the page can work, so nothing else is drawn.

import React from "react";
import { Wordmark } from "./ui/Wordmark";
import { useLuveI18n } from "../i18n";
import { useScheme } from "../hooks/useHost";

export function NeedsInProcess() {
  const { t } = useLuveI18n();
  const { scheme } = useScheme();
  return (
    <div className="lb-root" data-lb-scheme={scheme} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", minHeight: "100%", padding: 24, boxSizing: "border-box", background: "var(--color-background)", color: "var(--color-foreground)" }}>
      <main data-testid="needs-in-process" aria-labelledby="needs-in-process-title" style={{ maxWidth: 520 }}>
        <Wordmark scheme={scheme} />
        <h1 id="needs-in-process-title" className="lb-title" style={{ margin: "20px 0 8px" }}>{t("needsInProcessTitle")}</h1>
        <p className="lb-body" style={{ margin: "0 0 8px" }}>{t("needsInProcessBody")}</p>
        <ol className="lb-body" style={{ margin: "0 0 16px", paddingLeft: 22 }}>
          <li>{t("needsInProcessStep1")}</li>
          <li>{t("needsInProcessStep2")}</li>
          <li>{t("needsInProcessStep3")}</li>
        </ol>
        <button type="button" className="lb-btn lb-btn-primary" onClick={() => window.location.reload()}>{t("needsInProcessReload")}</button>
      </main>
    </div>
  );
}
