// dashboard/src/voice/CallNotes.tsx
// What went wrong with a call, in words (the vendor's and Hermes's own text never reaches the page), and the receipt line the conversation
// keeps after it: "Chamada de 3 min · 2 tarefas".
import React from "react";
import { ApiError } from "../api/client";
import type { CallReceipt } from "../api/types";
import { useLuveI18n, type TranslationKey } from "../i18n";
import { humanError, type ErrorState } from "../components/ui/ErrorNote";
import { durationText } from "../components/labels";
import type { CallProblem } from "./useCall";

const OWN: Record<string, TranslationKey> = { mic_denied: "callMicDenied", mic_missing: "callMicMissing", mic_error: "callMicError", connection: "callErrConnection", lost: "callErrLost" };

export function callProblemText(problem: CallProblem, t: (k: TranslationKey) => string): ErrorState {
  return problem instanceof ApiError ? humanError(problem, t, "callErrConnection") : t(OWN[problem]);
}

export function CallReceiptLine({ receipt }: { receipt: CallReceipt }) {
  const { t, locale } = useLuveI18n();
  const time = durationText(receipt.seconds, locale, t) ?? "";
  const tasks = receipt.delegations === 0 ? t("callTasksNone") : receipt.delegations === 1 ? t("callTasksOne") : t("callTasksMany", { n: receipt.delegations });
  return <div role="status" data-testid="call-receipt" className="lb-caption" style={{ textAlign: "center", padding: "8px 0", color: "var(--color-muted-foreground)" }}>{t("callReceipt", { time, tasks })}</div>;
}
