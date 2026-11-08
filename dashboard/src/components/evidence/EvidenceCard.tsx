// dashboard/src/components/evidence/EvidenceCard.tsx
// The evidence card (contract v0.10 §3.2): what a Bot wrote in a closed `luve-evidence` block (lib/evidence.ts parsed it, all or nothing),
// drawn as five calm blocks in the spec's order: facts, assumptions, done, awaiting approval, open questions. It is a FORMAT and a READING,
// never a verification: the line at the top says the Bot wrote it and LuveBot did not check it, the bullets are neutral (no check marks: "done"
// is what the Bot claims, not what happened) and every text is plain text. A source is text with a copy button, never a link.
// "Awaiting approval" is the one block that must not lie (invariant 6): its header shows the REAL count of pending approvals of this
// conversation, from the approvals the screen already holds (the renderer passes `pending`; no route of its own; `null` = this screen does not
// know: no count and no comparison), the Bot's own items are labeled "the Bot says", and a calm line says so when the two disagree. Nothing on
// the card approves, denies or accepts anything: it shows, it copies a source, and it links to Approvals (only when given a way to open it).

import React from "react";
import type { Evidence, EvidenceItem, Section } from "../../lib/evidence";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { proseTokens, visibleTokens } from "../../lib/hiddenChars";

// The spec's order (PRODUCT_SPEC, "Evidência"); lib/evidence.ts's SECTIONS says the same and a test holds them together.
const ORDER: readonly Section[] = ["facts", "assumptions", "done", "awaiting", "questions"];

const TITLE: Record<Section, TranslationKey> = {
  facts: "eviFacts", assumptions: "eviAssumptions", done: "eviDone", awaiting: "eviAwaiting", questions: "eviQuestions",
};
const muted: React.CSSProperties = { color: "var(--color-muted-foreground)", fontSize: 12, lineHeight: "16px" };

function Source({ source: raw }: { source: string }) {
  const { t } = useLuveI18n();
  const source = visibleTokens(raw);   // a source is what a person copies: every hidden character as a visible token, and the copy button copies what is drawn (contract v0.11 §8)
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => { if (!copied) return; const id = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(id); }, [copied]);
  const copy = async () => { try { await navigator.clipboard.writeText(source); setCopied(true); } catch { setCopied(false); } };
  return (
    <span style={{ ...muted, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <span data-testid="evidence-source" style={{ overflowWrap: "anywhere", minWidth: 0 }}>{t("eviSource", { source })}</span>
      <button type="button" className="lb-btn" aria-label={`${t("eviCopySource")}: ${source}`} onClick={() => void copy()}
        style={{ minHeight: 28, padding: "2px 10px", fontSize: 12 }}>{t("eviCopy")}</button>
      <span role="status" aria-live="polite">{copied ? t("eviCopied") : ""}</span>
    </span>
  );
}

function Items({ items }: { items: EvidenceItem[] }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((it, i) => (
        <li key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span aria-hidden="true" style={{ color: "var(--color-muted-foreground)", lineHeight: "20px" }}>•</span>
          <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span data-testid="evidence-item" style={{ fontSize: 14, lineHeight: "20px", overflowWrap: "anywhere" }}>{proseTokens(it.text)}</span>
            {it.source !== undefined && <Source source={it.source} />}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Block({ section, block, extra }: { section: Section; block: Evidence[Section]; extra?: React.ReactNode }) {
  const { t } = useLuveI18n();
  const id = React.useId();
  return (
    <section data-testid={`evidence-${section}`} aria-labelledby={id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <h4 id={id} style={{ margin: 0, font: "600 13px/18px var(--lb-font)", color: "var(--color-foreground)" }}>{t(TITLE[section])}</h4>
      {extra}
      {block === null
        ? <span data-testid={`evidence-${section}-absent`} style={muted}>{t("eviAbsent")}</span>
        : block.length === 0
          ? <span data-testid={`evidence-${section}-none`} style={muted}>{t("eviNone")}</span>
          : <Items items={block} />}
    </section>
  );
}

/** The real count and the two honest mismatch lines of "awaiting approval"; nothing at all when this screen does not know the count. */
function Awaiting({ block, pending, onOpenApprovals }: { block: Evidence["awaiting"]; pending: number | null; onOpenApprovals?: () => void }) {
  const { t } = useLuveI18n();
  const listed = block?.length ?? 0;
  const known = pending !== null && Number.isFinite(pending) && pending >= 0;
  const extra = (
    <>
      {known && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <span className="lb-pill" data-testid="evidence-in-box" style={{ background: "var(--lb-fill-2)" }}>{t("eviInBox", { count: pending as number })}</span>
          {onOpenApprovals && <button type="button" data-testid="evidence-open-approvals" className="lb-btn" style={{ minHeight: 28, padding: "2px 12px", fontSize: 12 }} onClick={onOpenApprovals}>{t("eviOpenBox")}</button>}
        </div>
      )}
      {known && listed > 0 && pending === 0 && <span role="note" data-testid="evidence-mismatch" style={{ ...muted, color: "var(--color-warning)", fontWeight: 600 }}>{t("eviNoPending")}</span>}
      {known && listed === 0 && (pending as number) > 0 && (
        <span role="note" data-testid="evidence-mismatch" style={{ ...muted, color: "var(--color-warning)", fontWeight: 600 }}>
          {(pending as number) === 1 ? t("eviExtraOne") : t("eviExtraMany", { count: pending as number })}
        </span>
      )}
      {!known && <span data-testid="evidence-count-unknown" style={muted}>{t("eviCountUnknown")}</span>}
      {listed > 0 && <span style={muted}>{t("eviBotSays")}</span>}
    </>
  );
  return <Block section="awaiting" block={block} extra={extra} />;
}

export interface EvidenceCardProps {
  evidence: Evidence;
  /** Pending approvals of THIS conversation, from what the screen already holds; null when it does not know (then no count and no comparison). */
  pending: number | null;
  /** Opens Approvals. Without it the count is shown and there is no link. */
  onOpenApprovals?: () => void;
}

export function EvidenceCard({ evidence, pending, onOpenApprovals }: EvidenceCardProps) {
  const { t } = useLuveI18n();
  return (
    <div data-testid="evidence-card" role="group" aria-label={t("eviLabel")}
      style={{ border: "1px solid var(--color-border)", background: "var(--lb-fill)", color: "var(--color-card-foreground)", borderRadius: 14, padding: "12px 14px", margin: "8px 0", display: "flex", flexDirection: "column", gap: 12 }}>
      <p data-testid="evidence-top" style={{ margin: 0, ...muted }}>{t("eviTop")}</p>
      {ORDER.map((s) => (s === "awaiting" ? <Awaiting key={s} block={evidence[s]} pending={pending} onOpenApprovals={onOpenApprovals} /> : <Block key={s} section={s} block={evidence[s]} />))}
    </div>
  );
}
