// dashboard/src/components/chat/InlineApproval.tsx
// An approval request inside the conversation or on the home feed (Grok Bot §1.9, brief §2.3), decided for real, by a human click only
// (invariant 6). The request is resolvable here only when the backend stored it and put `luvebot_digest` in the frame
// (contract v0.1 A-14); without it nothing can be decided from here (fail closed). "Sempre permitir" resolves ONCE plus
// a draft rule; "Negar" needs a reason. No <form>: the composer is the conversation's only form (test_sanitize).

import React from "react";
import { resolveRunApproval, getApprovals } from "../../api/client";
import { humanApproval, useRuleLabels, ruleIdOf, type ApprovalFacts, draftLabel } from "../approvals/humanize";
import { useLuveI18n } from "../../i18n";
import { approvalFromFrame } from "../transcript/frames";
import { alwaysNotSavedText, savedDraftId, onceRequest, alwaysRequest, denyRequest, approvalErrorText, reasonState, reasonText, followReasons, reviewApproveKey, isPageChanged, mayBeRefusedByHermes, type ReasonState } from "../approvals/decide";
import { PageReview } from "../approvals/PageReview";
import { BlindNote } from "../approvals/BlindNote";
import { ReviewDraftButton } from "../approvals/ReviewDraftButton";
import type { Approval, ResolveApprovalRequest } from "../../api/types";
import { ErrorNote, type ErrorState } from "../ui/ErrorNote";

export interface InlineApprovalProps {
  frame: Record<string, any>;
  bot: string;
  runId?: string;
  pending: boolean;  // the turn is still waiting; once Hermes ends it, the request is no longer decidable
  onDecided?: () => void;  // the decision was accepted: the run resumes before Hermes's next frame arrives
}

/** One request as the decision needs it, from a stream frame or from the approvals inbox. */
export interface DecisionRequest {
  requestId: string;
  digest: string | null;  // null: nothing can be decided from here (fail closed)
  choices: string[];
  command?: string;
  description?: string;
  patternKey?: string;
  commandRedacted?: string | null;
  tool?: string | null;
  ruleId?: string | null;
  /** v0.9 1.9: the backend could not tie this request to its call (a hook before 0.8.0): no approve, no "Sempre permitir", only "Negar". */
  detailsUnavailable?: boolean;
  /** 21a: a write_file / patch request: its proposal, diff and label (pages-review-v0). Absent for any other request. */
  pageReview?: Pick<Approval, "page" | "proposal" | "review" | "diff">;
}

export interface ApprovalDecisionProps {
  request: DecisionRequest;
  bot: string;
  pending: boolean;
  resolve: (body: ResolveApprovalRequest) => Promise<unknown>;  // the route that decides this request
  bare?: boolean;  // the caller already shows what is being asked: only the decision
  onDecided?: (kind: "once" | "always" | "deny") => void;
}

type Mode = "idle" | "always" | "deny";
type Done = "once" | "always" | "deny";

export const card: React.CSSProperties = {
  maxWidth: "min(85%, 640px)", margin: "8px 0", padding: "12px 14px", borderRadius: 18, borderBottomLeftRadius: 6,
  background: "var(--color-muted)", color: "var(--color-foreground)",
  boxShadow: "inset 3px 0 0 var(--color-warning)",
  overflowWrap: "anywhere", minWidth: 0,   // what the Bot wrote (a question, an option, a command) wraps inside the card, whatever it holds
};
/** The line that says a card is closed. It takes the focus (tabIndex -1), so it has room for the ring. */
export const closedLine: React.CSSProperties = { margin: "4px 0 0 -6px", padding: "4px 6px", borderRadius: 8, outlineOffset: 1 };
/** A closed card is not asking for anything any more: the warning edge ("it needs you") goes calm. */
export const atRest: React.CSSProperties = { ...card, boxShadow: "inset 3px 0 0 var(--color-border)" };
/** Where the focus is, is this card's to say only while it is inside it or lost: Chrome drops it on the page body when the control used turns disabled or leaves. A person who moved on keeps theirs. */
export const focusIsFree = (box: React.RefObject<HTMLElement | null>) => { const a = document.activeElement; return !a || a === document.body || !!box.current?.contains(a); };
export const field: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", marginTop: 6, padding: "8px 10px", borderRadius: 10, fontSize: 13,
  border: "1px solid var(--color-border)", background: "var(--color-background)", color: "var(--color-foreground)",
};

/** A request in a conversation: decided on its run's approval route. */
export function InlineApproval({ frame, bot, runId, pending, onDecided }: InlineApprovalProps) {
  const a = approvalFromFrame(frame);
  const digest = typeof frame.luvebot_digest === "string" && frame.luvebot_digest ? frame.luvebot_digest : null;
  // The frame only carries Hermes's synthetic label for a plugin rule; the command (redacted), the tool and the rule are in
  // the request the backend stored when the frame passed (A-14).
  const [stored, setStored] = React.useState<{ commandRedacted?: string | null; tool?: string | null; ruleId?: string | null; detailsUnavailable?: boolean; pageReview?: DecisionRequest["pageReview"] }>({});
  React.useEffect(() => {
    if (!digest || !a.requestId) return;
    let alive = true;
    getApprovals().then((r) => {
      const row = (r?.approvals ?? []).find((x) => x.request_id === a.requestId);
      if (alive && row) setStored({ commandRedacted: row.command_redacted ?? null, tool: row.tool ?? null, ruleId: row.rule_id ?? null, detailsUnavailable: row.details_unavailable === true,
        pageReview: row.review ? { page: row.page, proposal: row.proposal, review: row.review, diff: row.diff } : undefined });
    }).catch(() => { /* the card still decides; it just shows less */ });
    return () => { alive = false; };
  }, [digest, a.requestId]);
  return (
    <ApprovalDecision bot={bot} pending={pending && !!runId} onDecided={onDecided}
      request={{ requestId: a.requestId, digest, choices: a.choices, command: a.command, description: a.description, patternKey: a.patternKey, ...stored }}
      resolve={(body) => resolveRunApproval(bot, runId!, { request_id: a.requestId, ...body })} />
  );
}

/** The human decision itself: once / always-as-draft / deny with a reason, sent only on a click. */
export function ApprovalDecision({ request: a, bot, pending, resolve, bare = false, onDecided }: ApprovalDecisionProps) {
  const { t } = useLuveI18n();
  const digest = a.digest;
  const blind = !!a.detailsUnavailable;   // the placeholder Hermes names is not the call: it is not shown as if it were, and nothing but "Negar" is offered
  const can = (c: string) => a.choices.includes(c);
  const [mode, setMode] = React.useState<Mode>("idle");
  const [label, setLabel] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<Done | null>(null);
  const [draftId, setDraftId] = React.useState<string | null>(null);   // "Always allow": the id of the draft that WAS saved, to open it on the Rules screen (AA-2)
  const hint = React.useId();
  const [notSaved, setNotSaved] = React.useState<string | null>(null);   // "Always allow": the request WAS decided once but its draft rule was not saved: the words say so and why (R-15)
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [reasonOutcome, setReasonOutcome] = React.useState<ReasonState | null>(null);
  const [changed, setChanged] = React.useState(false);  // 409 page_changed: nothing was decided; "Negar: a página mudou" is offered
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);
  const box = React.useRef<HTMLDivElement>(null);          // the card
  const status = React.useRef<HTMLDivElement>(null);       // its confirmation line, once it worked
  const used = React.useRef<HTMLElement | null>(null);     // what had focus when the person decided
  const alwaysBtn = React.useRef<HTMLButtonElement>(null), denyBtn = React.useRef<HTMLButtonElement>(null);
  const alwaysField = React.useRef<HTMLInputElement>(null), denyField = React.useRef<HTMLTextAreaElement>(null);
  const was = React.useRef<Mode>("idle");

  async function decide(kind: Done, body: ResolveApprovalRequest | null) {
    if (!body || !digest || busy || (blind && kind !== "deny")) return;
    used.current = document.activeElement as HTMLElement | null;
    setBusy(true); setError(null);
    try {
      const res = await resolve(body);
      if (kind === "always") {
        setNotSaved(alwaysNotSavedText(res as { draft_rule?: unknown; draft_error?: unknown } | null, t));
        setDraftId(savedDraftId(res as { draft_rule?: unknown; draft_error?: unknown } | null));
      }
      if (kind === "deny") {
        const first = reasonState((res as { reason_delivered?: unknown } | null)?.reason_delivered);
        setReasonOutcome(first);
        if (first === "sending" && a.requestId) void followReasons([a.requestId], setReasonOutcome, () => alive.current);
      }
      setDone(kind); setMode("idle");
      onDecided?.(kind);
    } catch (e) {
      if (kind === "once" && isPageChanged(e)) setChanged(true);
      setError(approvalErrorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  const facts: ApprovalFacts = { description: a.description, command: a.command, commandRedacted: a.commandRedacted, patternKey: a.patternKey, tool: a.tool, ruleId: a.ruleId };
  const ruleLabel = useRuleLabels(!bare, ruleIdOf(facts));  // a bare decision shows no title: nothing to look up
  const human = humanApproval(facts, ruleLabel, t);
  const decidable = !!digest && pending && !done;
  // Whole-page save over a page that exists, just approved: Hermes may still refuse it (the Caixa's decided row says the same, in the same words).
  const mayRefuse = done === "once" && !!a.pageReview && mayBeRefusedByHermes({ ...a.pageReview, decided_choice: "once" });
  const openAlways = () => {
    setLabel(draftLabel(facts, ruleLabel, bot, t));
    setMode("always");
  };
  // The button that opened the label or reason form is gone once it opens, and the one that decides is disabled while the request is on its way and gone when it worked: in all three the
  // browser leaves the focus on the page body. Put it where the person looks next: the field that opened, the button that opened it when they cancel, the confirmation line when it worked,
  // or what they used if it failed. A person who has already moved on (the composer, say) keeps their focus. LAYOUT effects: the focus moves in the SAME commit that changes the card, before the paint
  // (a passive effect ran a tick after it: the page body had the focus for up to 150 ms in the real Chrome, and a screen reader had nothing to say meanwhile). The refs of the fields and buttons are set
  // before the parent's layout effects run, and a disabled button is already enabled again when the one that refocuses it runs.
  React.useLayoutEffect(() => {
    const from = was.current; was.current = mode;
    if (done || !focusIsFree(box)) return;
    if (mode === "always") alwaysField.current?.focus();
    else if (mode === "deny") denyField.current?.focus();
    else if (from === "always") alwaysBtn.current?.focus();
    else if (from === "deny") denyBtn.current?.focus();
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useLayoutEffect(() => { if (done && focusIsFree(box)) status.current?.focus(); }, [done]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useLayoutEffect(() => {
    if (!error || busy || !focusIsFree(box)) return;
    const u = used.current;   // Safari does not focus a button on click: then it was the body, and the first live control stands in
    (u && u !== document.body && u.isConnected ? u : box.current?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
  }, [error, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={box} role="group" aria-label={t("cardApproval")} style={bare ? undefined : done ? atRest : card}>
      {!bare && <div className="lb-caption">{t("cardApproval")}</div>}
      {!bare && <div className="lb-headline" style={{ marginTop: 4, overflowWrap: "anywhere" }}>{blind ? t("approvalBlindTitle") : human.title}</div>}
      {!bare && human.tool && <div className="lb-caption" style={{ marginTop: 2 }}>{human.tool}</div>}
      {!bare && !blind && human.preview && <pre style={{ margin: "8px 0 0", padding: "8px 10px", borderRadius: 10, background: "var(--color-background)", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{human.preview}</pre>}
      {!bare && human.technical.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary className="lb-caption" style={{ cursor: "pointer" }}>{t("approvalTechnicalDetail")}</summary>
          <pre className="lb-caption" style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--lb-mono)" }}>{human.technical.join("\n")}</pre>
        </details>
      )}

      {a.pageReview && <PageReview approval={a.pageReview} />}
      {blind && !done && <div style={{ marginTop: 8 }}><BlindNote bot={bot} /></div>}

      {done && <div ref={status} tabIndex={-1} role="status" style={{ ...closedLine, fontSize: 13, fontWeight: mayRefuse ? 400 : 600 }}>
        {/* inside the Bot's own conversation (or its card in Hoje), so the Bot's name is already on screen; that sentence opens with "Aprovado." itself */}
        {done === "always" && notSaved ? notSaved : t(mayRefuse ? "pageReviewMayRefuse" : done === "once" ? "approvalInlineOnce" : done === "deny" ? "approvalInlineDeny" : "approvalInlineAlways")}
        {reasonOutcome && <div className="lb-caption" style={{ fontWeight: 400, marginTop: 2 }}>{t(reasonText(reasonOutcome))}</div>}
      </div>}
      {done === "always" && draftId && <div style={{ marginTop: 6 }}><ReviewDraftButton bot={bot} ruleId={draftId} /></div>}
      {!done && !digest && <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-muted-foreground)" }}>{t("approvalNotResolvableHere")}</div>}
      {!done && digest && !pending && <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-muted-foreground)" }}>{t("approvalNoLongerPending")}</div>}

      {decidable && mode === "idle" && (
        <>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {can("once") && !blind && <button type="button" disabled={busy} onClick={() => void decide("once", onceRequest({ digest }))} className="lb-btn lb-btn-primary">{a.pageReview && reviewApproveKey(a.pageReview) ? t(reviewApproveKey(a.pageReview)!) : t("allowOnceBtn")}</button>}
          {can("once") && !blind && <button type="button" ref={alwaysBtn} disabled={busy} onClick={openAlways} aria-describedby={hint} className="lb-btn">{a.pageReview?.page ? t("pageReviewAlways") : t("alwaysAllowBtn")}</button>}
          {changed && can("deny") && <button type="button" data-testid="deny-changed" disabled={busy} onClick={() => void decide("deny", denyRequest({ digest }, t("pageChangedReason")))} className="lb-btn lb-btn-destructive">{t("pageReviewDenyChanged")}</button>}
          {can("deny") && <button type="button" ref={denyBtn} disabled={busy} onClick={() => { setReason(""); setMode("deny"); }} className="lb-btn lb-btn-destructive">{t("denyBtn")}</button>}
        </div>
        {/* what "Sempre permitir…" does, BEFORE the click, where the person decides (the dialog that opens says it again): it allows now and leaves a DRAFT for them to turn on (AA-2) */}
        {can("once") && !blind && <div id={hint} className="lb-caption" style={{ marginTop: 6 }}>{t("alwaysAllowHint")}</div>}
        </>
      )}
      {decidable && mode === "always" && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: "var(--color-muted-foreground)" }}>{t("alwaysModalExplanationP1")}</div>
          <label style={{ display: "block", marginTop: 8, fontSize: 12, fontWeight: 600 }}>
            {t("alwaysModalDraftLabel")}
            <input ref={alwaysField} value={label} onChange={(e) => setLabel(e.target.value)} style={field} />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" disabled={busy} onClick={() => void decide("always", alwaysRequest({ digest }, label.trim() || t("rulesTitleBot", { bot })))} className="lb-btn lb-btn-primary">{t("alwaysModalConfirm")}</button>
            <button type="button" onClick={() => setMode("idle")} className="lb-btn">{t("alwaysModalCancel")}</button>
          </div>
        </div>
      )}
      {decidable && mode === "deny" && (
        <div style={{ marginTop: 10 }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 600 }}>
            {t("denyModalReasonLabel")}
            <textarea ref={denyField} value={reason} rows={2} onChange={(e) => setReason(e.target.value)} placeholder={t("denyModalPlaceholder")} style={{ ...field, resize: "vertical" }} />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" disabled={busy || !reason.trim()} onClick={() => void decide("deny", denyRequest({ digest }, reason))} className="lb-btn lb-btn-destructive">{t("denyModalConfirm")}</button>
            <button type="button" onClick={() => setMode("idle")} className="lb-btn">{t("alwaysModalCancel")}</button>
          </div>
        </div>
      )}
      {error && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: "var(--color-destructive)", overflowWrap: "anywhere" }}><ErrorNote error={error} /></div>}
    </div>
  );
}
