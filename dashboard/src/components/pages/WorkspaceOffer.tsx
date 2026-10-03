// dashboard/src/components/pages/WorkspaceOffer.tsx
// A Bot without a working folder (no_workspace): instead of telling the person to edit config.yaml by hand, one click makes the
// Bot's own folder by the same route the attachments use (POST /bots/{bot}/workspace, ADR-005 §3, audited by the backend).
// Only for no_workspace: a folder outside the machine, inside ~/.hermes or unsafe is not fixed by making one, so it keeps its text.

import React from "react";
import { setBotWorkspace } from "../../api/client";
import { useLuveI18n } from "../../i18n";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";
import { blockOf, blockText } from "./pages";

export function WorkspaceOffer({ bot, label, isDefault, onReady }: { bot: string; label?: string; isDefault?: boolean; onReady: () => void }) {
  const { t } = useLuveI18n();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  async function create() {
    setBusy(true); setError(null);
    try {
      const { workspace } = await setBotWorkspace(bot);
      const still = blockOf(workspace.state);
      if (still) setError(blockText(still, { name: bot, label, isDefault }, t));  // what Hermes says now, in words
      else onReady();
    } catch (e) {
      setError(humanError(e, t, "attachWsCreateFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
      <p className="lb-subhead" style={{ margin: 0 }}>{t("pagesNoFolder", { name: label || bot })}</p>
      <button type="button" onClick={() => void create()} disabled={busy} className="lb-btn lb-btn-primary">
        {busy ? t("pagesCreatingFolder") : t("attachWsCreate")}
      </button>
      {error && <p role="alert" className="lb-caption" style={{ margin: 0, color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
    </div>
  );
}
