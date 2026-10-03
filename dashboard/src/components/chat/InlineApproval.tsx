// dashboard/src/components/chat/InlineApproval.tsx
// An approval request inside the conversation or on the home feed (Grok Bot §1.9, brief §2.3), decided for real, by a human click only
// (invariant 6). The request is resolvable here only when the backend stored it and put `luvebot_digest` in the frame
// (contract v0.1 A-14); without it nothing can be decided from here (fail closed). "Sempre permitir" resolves ONCE plus
// a draft rule; "Negar" needs a reason. No <form>: the composer is the conversation's only form (test_sanitize).

import React from "react";
import { resolveRunApproval, getApprovals } from "../../api/client";
import { humanApproval, useRuleLabels, ruleIdOf, type ApprovalFacts } from "../approvals/humanize";
import { useLuveI18n } from "../../i18n";
import { approvalFromFrame } from "../transcript/frames";
import { onceRequest, alwaysRequest, denyRequest, approvalErrorText, reasonState, reasonText, followReasons, type ReasonState } from "../approvals/decide";
import type { ResolveApprovalRequest } from "../../api/types";
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

const card: React.CSSProperties = {
  maxWidth: "min(85%, 640px)", margin: "8px 0", padding: "12px 14px", borderRadius: 18, borderBottomLeftRadius: 6,
  background: "var(--color-muted)", color: "var(--color-foreground)",
  boxShadow: "inset 3px 0 0 var(--color-warning)",
};
const field: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", marginTop: 6, padding: "8px 10px", borderRadius: 10, fontSize: 13,
  border: "1px solid var(--color-border)", background: "var(--color-background)", color: "var(--color-foreground)",
};

/** A request in a conversation: decided on its run's approval route. */
export function InlineApproval({ frame, bot, runId, pending, onDecided }: InlineApprovalProps) {
  const a = approvalFromFrame(frame);
  const digest = typeof frame.luvebot_digest === "string" && frame.luvebot_digest ? frame.luvebot_digest : null;
  // The frame only carries Hermes's synthetic label for a plugin rule; the command (redacted), the tool and the rule are in
  // the request the backend stored when the frame passed (A-14).
  const [stored, setStored] = React.useState<{ commandRedacted?: string | null; tool?: string | null; ruleId?: string | null }>({});
  React.useEffect(() => {
    if (!digest || !a.requestId) return;
    let alive = true;
    getApprovals().then((r) => {
      const row = (r?.approvals ?? []).find((x) => x.request_id === a.requestId);
      if (alive && row) setStored({ commandRedacted: row.command_redacted ?? null, tool: row.tool ?? null, ruleId: row.rule_id ?? null });
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
  const can = (c: string) => a.choices.includes(c);
  const [mode, setMode] = React.useState<Mode>("idle");
  const [label, setLabel] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<Done | null>(null);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [reasonOutcome, setReasonOutcome] = React.useState<ReasonState | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);

  async function decide(kind: Done, body: ResolveApprovalRequest | null) {
    if (!body || !digest || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await resolve(body);
      if (kind === "deny") {
        const first = reasonState((res as { reason_delivered?: unknown } | null)?.reason_delivered);
        setReasonOutcome(first);
        if (first === "sending" && a.requestId) void followReasons([a.requestId], setReasonOutcome, () => alive.current);
      }
      setDone(kind); setMode("idle");
      onDecided?.(kind);
    } catch (e) {
      setError(approvalErrorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  const facts: ApprovalFacts = { description: a.description, command: a.command, commandRedacted: a.commandRedacted, patternKey: a.patternKey, tool: a.tool, ruleId: a.ruleId };
  const ruleLabel = useRuleLabels(!bare, ruleIdOf(facts));  // a bare decision shows no title: nothing to look up
  const human = humanApproval(facts, ruleLabel, t);
  const decidable = !!digest && pending && !done;
  const openAlways = () => {
    setLabel(`${t("allowOnceBtn")} ${a.patternKey || a.command || a.description || t("defaultActionLabel")} ${bot}`);
    setMode("always");
  };

  return (
    <div role="group" aria-label={t("cardApproval")} style={bare ? undefined : card}>
      {!bare && <div className="lb-caption">{t("cardApproval")}</div>}
      {!bare && <div className="lb-headline" style={{ marginTop: 4, overflowWrap: "anywhere" }}>{human.title}</div>}
      {!bare && human.tool && <div className="lb-caption" style={{ marginTop: 2 }}>{human.tool}</div>}
      {!bare && human.preview && <pre style={{ margin: "8px 0 0", padding: "8px 10px", borderRadius: 10, background: "var(--color-background)", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{human.preview}</pre>}
      {!bare && human.technical.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary className="lb-caption" style={{ cursor: "pointer" }}>{t("approvalTechnicalDetail")}</summary>
          <pre className="lb-caption" style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--lb-mono)" }}>{human.technical.join("\n")}</pre>
        </details>
      )}

      {done && <div role="status" style={{ marginTop: 8, fontSize: 13, fontWeight: 600 }}>
        {/* inside the Bot's own conversation (or its card in Hoje), so the Bot's name is already on screen */}
        {t(done === "once" ? "approvalInlineOnce" : done === "deny" ? "approvalInlineDeny" : "approvalInlineAlways")}
        {reasonOutcome && <div className="lb-caption" style={{ fontWeight: 400, marginTop: 2 }}>{t(reasonText(reasonOutcome))}</div>}
      </div>}
      {!done && !digest && <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-muted-foreground)" }}>{t("approvalNotResolvableHere")}</div>}
      {!done && digest && !pending && <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-muted-foreground)" }}>{t("approvalNoLongerPending")}</div>}

      {decidable && mode === "idle" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {can("once") && <button type="button" disabled={busy} onClick={() => void decide("once", onceRequest({ digest }))} className="lb-btn lb-btn-primary">{t("allowOnceBtn")}</button>}
          {can("once") && <button type="button" disabled={busy} onClick={openAlways} className="lb-btn">{t("alwaysAllowBtn")}</button>}
          {can("deny") && <button type="button" disabled={busy} onClick={() => { setReason(""); setMode("deny"); }} className="lb-btn lb-btn-destructive">{t("denyBtn")}</button>}
        </div>
      )}
      {decidable && mode === "always" && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: "var(--color-muted-foreground)" }}>{t("alwaysModalExplanationP1")}</div>
          <label style={{ display: "block", marginTop: 8, fontSize: 12, fontWeight: 600 }}>
            {t("alwaysModalDraftLabel")}
            <input value={label} onChange={(e) => setLabel(e.target.value)} style={field} />
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
            <textarea value={reason} rows={2} onChange={(e) => setReason(e.target.value)} placeholder={t("denyModalPlaceholder")} style={{ ...field, resize: "vertical" }} />
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
