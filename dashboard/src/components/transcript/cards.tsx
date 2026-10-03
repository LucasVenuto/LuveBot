// dashboard/src/components/transcript/cards.tsx
// Transcript cards (spec 5). Agent content is data: always text or <Markdown>, never HTML.
// Colors: only --color-* tokens; the Bot color comes in by prop. Approvals are decided in chat/InlineApproval.tsx.

import React from "react";
import { Markdown } from "../../lib/render/markdown";
import { type ToolProps } from "./frames";
import type { SubagentStatus } from "../../lib/stream/reducer";
import { Bubble } from "../ui/Bubble";
import { subagentStatusLabel } from "../labels";
import { useLuveI18n } from "../../i18n";
import { ErrorNote, type ErrorState } from "../ui/ErrorNote";

const box: React.CSSProperties = {
  border: "1px solid var(--color-border)", background: "var(--color-card)",
  color: "var(--color-card-foreground)", borderRadius: 8, padding: "8px 12px", margin: "6px 0",
};
const muted: React.CSSProperties = { color: "var(--color-muted-foreground)", fontSize: 12 };
const pre: React.CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "4px 0 0", fontFamily: "monospace", fontSize: 12 };

/** A Bot message: a neutral bubble with the text as <Markdown>. `who` names the author (rooms with several Bots). */
export function MessageCard({ who, time, text, color }: { who?: string; time?: string; text: string; color?: string }) {
  return <Bubble side="bot" author={who} color={color} meta={time}><Markdown text={text} /></Bubble>;
}

const STATUS = { running: "⟳", done: "✓", error: "✕" } as const;

/** One step of the Bot's work, as a line (Grok Bot: "✓ Salesforce → list pulled"); expands to arguments and result. */
export function ToolCard({ name, status, preview, args, durationS, result }: ToolProps & { color?: string }) {
  const [open, setOpen] = React.useState(false);
  const detail = [args && JSON.stringify(args, null, 2), result].filter(Boolean).join("\n\n");
  return (
    <div style={{ padding: "2px 0" }}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "baseline", gap: 8, width: "100%", minHeight: 28, fontSize: 14 }}>
        <span aria-hidden="true" style={{ width: 14, flexShrink: 0, textAlign: "center", color: status === "error" ? "var(--color-destructive)" : status === "done" ? "var(--color-success)" : "var(--color-muted-foreground)" }}>{STATUS[status]}</span>
        <strong style={{ fontWeight: 600 }}>{name}</strong>
        <span style={{ ...muted, fontSize: 13, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview}</span>
        {durationS !== undefined && <span style={muted}>{durationS.toFixed(1)}s</span>}
      </button>
      {open && <pre style={{ ...pre, marginLeft: 22, padding: "8px 10px", borderRadius: 10, background: "var(--color-background)" }}>{detail || "—"}</pre>}
    </div>
  );
}

export function SubagentCard(p: { goal: string; status: SubagentStatus | "background" | "background_late"; summary?: string; costUsd?: number; childSessionId?: string; onOpenSession?: (id: string) => void }) {
  const { t } = useLuveI18n();
  return (
    <div style={box}>
      <div><strong>{t("cardSubagent")}</strong> <span style={muted}>{subagentStatusLabel(p.status, t)}</span></div>
      <div style={{ overflowWrap: "anywhere" }}>{p.goal}</div>
      {p.summary && <Markdown text={p.summary} />}
      <div style={muted}>
        {p.costUsd !== undefined && <span>{t("cardSubagentCost", { cost: p.costUsd.toFixed(4) })} </span>}
        {p.childSessionId && p.onOpenSession && (
          <button type="button" onClick={() => p.onOpenSession!(p.childSessionId!)}
            style={{ all: "unset", cursor: "pointer", color: "var(--color-primary)" }}>{t("cardViewSession")}</button>
        )}
      </div>
    </div>
  );
}

export function CommentaryCard({ text }: { text: string }) {
  const { t } = useLuveI18n();
  return (
    <details style={{ ...muted, margin: "4px 0" }}>
      <summary style={{ cursor: "pointer" }}>{t("cardCommentary")}</summary>
      <div style={{ color: "var(--color-muted-foreground)" }}><Markdown text={text} /></div>
    </details>
  );
}

export function CheckpointCard({ done, total, review = 0 }: { done: number; total: number; review?: number }) {
  const { t } = useLuveI18n();
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div style={box}>
      <div>{review > 0 ? t("checkpointProgressReview", { done, total, review }) : t("checkpointProgress", { done, total })}</div>
      <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
        style={{ height: 4, background: "var(--color-muted)", borderRadius: 2, marginTop: 4 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--color-primary)", borderRadius: 2 }} />
      </div>
    </div>
  );
}

export function ErrorCard({ message, id }: { message: ErrorState; id?: string }) {
  const { t } = useLuveI18n();
  return (
    <div role="alert" style={{ maxWidth: "min(85%, 640px)", margin: "8px 0", padding: "10px 14px", borderRadius: 16, background: "color-mix(in srgb, var(--color-destructive) 10%, transparent)", font: "400 14px/20px var(--lb-font)" }}>
      <div style={{ color: "var(--color-destructive)", overflowWrap: "anywhere" }}><ErrorNote error={message} /></div>
      {id && (
        <button type="button" onClick={() => navigator.clipboard?.writeText(id)}
          style={{ all: "unset", cursor: "pointer", ...muted }}>{t("cardCopyId")}</button>
      )}
    </div>
  );
}
