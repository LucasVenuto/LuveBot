// dashboard/src/components/approvals/BlindNote.tsx
// A request LuveBot could not tie to the tool call it came from (contract v0.9 §1.9, `details_unavailable`): the hook of this Bot is older than 0.8.0,
// so on a canonical Hermes the request names only Hermes's placeholder, never the call. It stays listed; "Aprovar" and "Sempre permitir" are not offered
// (the server refuses them: nobody decides blind), "Negar" is (a denial runs nothing). The note says why in words and brings the update next to it.

import React from "react";
import { useLuveI18n } from "../../i18n";
import { HookUpdate } from "../agent/HookUpdate";

export function BlindNote({ bot }: { bot: string }) {
  const { t } = useLuveI18n();
  return (
    <div data-testid="approval-blind" style={{ display: "grid", gap: 6 }}>
      <p className="lb-caption" style={{ margin: 0 }}>{t("approvalBlindWhy")}</p>
      <div><HookUpdate bot={bot} /></div>
    </div>
  );
}
