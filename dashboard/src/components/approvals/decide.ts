// dashboard/src/components/approvals/decide.ts
// Pure request builders for human approval decisions (invariant 6, ADR-002). No I/O: callers send
// what these return, and only after a human click. "Sempre permitir" resolves ONCE plus a draft rule;
// nothing here can produce "always". Denying always carries a reason; whether it reached the Bot is the backend's word.

import type { Approval, ApprovalChoice, BatchApprovalItem, ResolveApprovalRequest } from "../../api/types";
import { ApiError, getApprovals } from "../../api/client";
import type { TranslationKey } from "../../i18n";
import { humanError, type ErrorState } from "../ui/ErrorNote";

type Digest = Pick<Approval, "digest">;

export const onceRequest = (a: Digest): ResolveApprovalRequest => ({ digest: a.digest, choice: "once" });

export const alwaysRequest = (a: Digest, label: string): ResolveApprovalRequest => ({
  digest: a.digest,
  choice: "once",
  draft_rule: { label, level: "allow" },
});

/** null when the reason is blank. */
export function denyRequest(a: Digest, reason: string): ResolveApprovalRequest | null {
  const r = reason.trim();
  return r ? { digest: a.digest, choice: "deny", reason: r } : null;
}

/** After a deny, what became of the reason (reason_delivered, R-4 / b3). Only an explicit true is "delivered"; null is "sending"
 *  (Hermes accepted it as a steer and the run still goes on); false, or absent (an older backend), is "kept" in LuveBot and its
 *  audit. "unknown": still sending when we stopped asking: never claimed delivered. */
export type ReasonState = "delivered" | "sending" | "kept" | "unknown";
const REASON_TEXT: Record<ReasonState, TranslationKey> = {
  delivered: "denyReasonDelivered", sending: "denyReasonSending", kept: "denyReasonKept", unknown: "denyReasonUnknown",
};
export const reasonText = (s: ReasonState): TranslationKey => REASON_TEXT[s];
export const reasonState = (v: unknown): ReasonState => (v === true ? "delivered" : v === null ? "sending" : "kept");
/** Several reasons (a batch): delivered only when all are, sending while any is, else kept. */
export const reasonsState = (vs: readonly unknown[]): ReasonState =>
  vs.length > 0 && vs.every((v) => v === true) ? "delivered" : vs.some((v) => v === null) ? "sending" : "kept";
export const denyReasonOutcome = (res: unknown): TranslationKey =>
  reasonText(reasonState((res as { reason_delivered?: unknown } | null)?.reason_delivered));

export const FOLLOW_MS = 2000;
export const FOLLOW_TRIES = 90;  // three minutes; then "unknown", never "delivered"
/** While reasons are being sent, reads the approvals again until every one settles (true or false), and says the result. */
export async function followReasons(ids: readonly string[], onState: (s: ReasonState) => void, alive: () => boolean): Promise<void> {
  for (let i = 0; i < FOLLOW_TRIES && alive(); i++) {
    await new Promise((r) => setTimeout(r, FOLLOW_MS));
    if (!alive()) return;
    try {
      const rows = (await getApprovals())?.approvals ?? [];
      // a row not on this page yet counts as still sending: it is asked again
      const state = reasonsState(ids.map((id) => { const row = rows.find((a) => a.request_id === id); return row ? row.reason_delivered : null; }));
      if (state !== "sending") { onState(state); return; }
    } catch { /* asked again on the next turn */ }
  }
  if (alive()) onState("unknown");
}

/** A batch may only group approvals of one action class (contract v0.1 §2). */
export function mixedActionClass(items: readonly Approval[]): boolean {
  return items.length > 1 && items.some((i) => i.action_class_hash !== items[0].action_class_hash);
}

/** null when the batch must be refused: mixed action classes, or a deny without reason. */
export function batchItems(items: readonly Approval[], choice: ApprovalChoice, reason: string): BatchApprovalItem[] | null {
  const r = reason.trim();
  if (mixedActionClass(items) || (choice === "deny" && !r)) return null;
  return items.map((i) => ({ request_id: i.request_id, digest: i.digest, choice, reason: choice === "deny" ? r : undefined }));
}

/** What to tell the human when a decision is refused. The server's refusal is final: nothing is retried. */
export function approvalErrorText(err: unknown, t: (k: TranslationKey) => string): ErrorState {
  if (err instanceof ApiError) {
    if (err.code === "loopback_not_human" || err.status === 403) return t("errorLoopbackApprovalBlocked");
    if (err.code === "stale" || err.status === 409) return t("errorStaleConflict");
    if (err.code === "csrf_required") return t("errorCsrfRequired");
  }
  return humanError(err, t, "errorUnexpectedApproval");
}
