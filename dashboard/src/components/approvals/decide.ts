// dashboard/src/components/approvals/decide.ts
// Pure request builders for human approval decisions (invariant 6, ADR-002). No I/O: callers send
// what these return, and only after a human click. "Sempre permitir" resolves ONCE plus a draft rule;
// nothing here can produce "always". Denying always carries a reason; whether it reached the Bot is the backend's word.

import type { Approval, ApprovalChoice, BatchApprovalItem, ResolveApprovalRequest } from "../../api/types";
import { ApiError, getApprovals } from "../../api/client";
import type { TranslationKey } from "../../i18n";
import { humanError, type ErrorState } from "../ui/ErrorNote";

type Digest = Pick<Approval, "digest">;

/** "Always allow" is approved ONCE and its rule is only a draft. When the server could not save the draft it says so in `draft_error` (a rule code): the person is told, next to "approved this once", that the rule was NOT saved
 *  and, for the code that has its own words (`fold_divergence`), why. Never the raw code. A draft is SAVED only on positive evidence (A-216): a `draft_rule` and no `draft_error`; the
 *  backend sends exactly one of the two. Neither, or a `draft_error` that is not a non-empty string (empty, `true`, an object, `null`): the general "not saved". null = saved. */
export function alwaysNotSavedText(res: { draft_rule?: unknown; draft_error?: unknown } | null | undefined, t: (k: TranslationKey) => string): string | null {
  const code = res?.draft_error;
  if (code === undefined && res?.draft_rule && typeof res.draft_rule === "object") return null;
  if (code === "fold_divergence") return t("alwaysNotSavedFold");
  const why = typeof code === "string" ? NOT_SAVED_BECAUSE[code] : undefined;                                      // every code `approvals._draft` hands back has its words (the editor's where it has them); an unknown one: "the rule could not be created", never "saved"
  return `${t("alwaysNotSavedHead")} ${t(why ?? "alwaysNotSavedGeneric")} ${t("alwaysNotSavedAgain")}`;
}
/** The draft "Always allow" saved, to open it on the Rules screen: on the SAME positive evidence as `alwaysNotSavedText` (a `draft_rule` that is an object and no `draft_error`) and, to have something to open, a `draft_rule.id` that is a
 *  non-empty text. Anything else is null: no "Revisar e ativar" (v0.11 11 (2)). */
export function savedDraftId(res: { draft_rule?: unknown; draft_error?: unknown } | null | undefined): string | null {
  if (!res || res.draft_error !== undefined || !res.draft_rule || typeof res.draft_rule !== "object") return null;
  const id = (res.draft_rule as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}
const NOT_SAVED_BECAUSE: Record<string, TranslationKey> = {
  noncanonical_action: "alwaysNotSavedNoncanonical", command_too_long: "alwaysNotSavedTooLong", draft_not_saved: "alwaysNotSavedStore",
  multiple_paths: "errMultiplePaths", unusable_path: "errUnusablePath", multiple_recipients: "errMultipleRecipients", unusable_recipient: "errUnusableRecipient",
};

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

// ---- 21a, pages-review-v0 §3: a request to save a page -------------------------------------------------------------------------
/** A page-review approval (a write_file / patch on exactly one page): decided ALONE, each with its own diff; never in a batch. */
export const isPageReview = (a: Pick<Approval, "page">): boolean => !!a.page;

/** pages-review-v0 §6: an APPROVED whole-page save over a page that already exists. Hermes's write_file overwrites such a page only if the Bot read it whole
 *  first, else it refuses and leaves the page as it is (LuveBot cannot see the result: the hook runs before the tool). So the decided row says what MAY
 *  happen, never that it did. Not for `replace`, `v4a` or a new page (base_sha null): Hermes's lock does not cover them. */
export const mayBeRefusedByHermes = (a: Pick<Approval, "page" | "proposal" | "decided_choice">): boolean =>
  isPageReview(a) && a.decided_choice === "once" && a.proposal?.kind === "whole" && typeof a.page?.base_sha === "string";

/** The label of "once" for a file-tool approval: "Aprovar e salvar" only when the request carries a proposal (the preview the person
 *  decides on), else "Aprovar". `null`: not a file-tool approval, the usual label stays. */
export function reviewApproveKey(a: Pick<Approval, "review" | "proposal">): TranslationKey | null {
  if (!a.review) return null;
  if (a.proposal?.truncated) return "pageReviewApproveCut";   // the end of the text is not on screen: the button says what the person is doing
  return a.review.label === "approve_and_save" && a.proposal ? "pageReviewApproveSave" : "pageReviewApprove";
}

/** 409 page_changed: the page is not what it was at the request. Nothing was decided; the Bot keeps waiting; denying stays possible. */
export const isPageChanged = (err: unknown): boolean => err instanceof ApiError && err.code === "page_changed";

/** v0.9 §1.9: a request LuveBot cannot read (it is never approved blind: once, always and "Sempre permitir" are refused by the server). Only "Negar" is offered. */
export const isBlind = (a: Pick<Approval, "details_unavailable">): boolean => a.details_unavailable === true;

/** A batch may only group approvals of one action class (contract v0.1 §2). */
export function mixedActionClass(items: readonly Approval[]): boolean {
  return items.length > 1 && items.some((i) => i.action_class_hash !== items[0].action_class_hash);
}

/** null when the batch must be refused: mixed action classes, or a deny without reason. */
export function batchItems(items: readonly Approval[], choice: ApprovalChoice, reason: string): BatchApprovalItem[] | null {
  const r = reason.trim();
  if (mixedActionClass(items) || items.some(isPageReview) || (choice === "deny" && !r) || (choice !== "deny" && items.some(isBlind))) return null;
  return items.map((i) => ({ request_id: i.request_id, digest: i.digest, choice, reason: choice === "deny" ? r : undefined }));
}

/** What to tell the human when a decision is refused. The server's refusal is final: nothing is retried. */
export function approvalErrorText(err: unknown, t: (k: TranslationKey) => string): ErrorState {
  if (err instanceof ApiError) {
    if (err.code === "page_changed") return t("errorPageChanged");   // before the generic 409: it is not "someone else decided"
    if (err.code === "details_unavailable") return t("errorDetailsUnavailable");   // same: the request is still pending, it just cannot be approved
    if (err.code === "not_batchable") return t("errorNotBatchable");
    if (err.code === "multiple_paths") return t("errorMultiplePaths");
    if (err.code === "credential_not_human") return humanError(err, t, "errorUnexpectedApproval");   // a sign-in LuveBot does not take for a person (the deployment token, or an unknown provider), not "this dashboard has no login"
    if (err.code === "loopback_not_human" || err.status === 403) return t("errorLoopbackApprovalBlocked");
    if (err.code === "stale" || err.status === 409) return t("errorStaleConflict");
    if (err.code === "csrf_required") return t("errorCsrfRequired");
  }
  return humanError(err, t, "errorUnexpectedApproval");
}
