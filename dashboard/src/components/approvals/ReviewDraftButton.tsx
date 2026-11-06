// dashboard/src/components/approvals/ReviewDraftButton.tsx
// "Revisar e ativar" (plugin-api v0.11 section 11, AA-2): the way from "Sempre permitir" to the SECOND act. It turns nothing on: it asks the app to open the Rules screen of that Bot on that draft
// (`ReviewDraft`, provided once by the app), and the person turns the rule on THERE, on a card that shows what it covers (invariant 6). Without that provider (a screen drawn alone) or without the
// id of a saved draft there is no button: nothing to open is nothing to offer.

import React from "react";
import { useLuveI18n } from "../../i18n";

export type ReviewDraft = (bot: string, ruleId: string) => void;
export const ReviewDraftContext = React.createContext<ReviewDraft | null>(null);

export function ReviewDraftButton({ bot, ruleId }: { bot: string; ruleId: string | null }) {
  const open = React.useContext(ReviewDraftContext);
  const { t } = useLuveI18n();
  if (!open || !ruleId) return null;
  return <button type="button" className="lb-btn" onClick={() => open(bot, ruleId)}>{t("reviewAndActivate")}</button>;
}
