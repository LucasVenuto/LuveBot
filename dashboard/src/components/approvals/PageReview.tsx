// dashboard/src/components/approvals/PageReview.tsx
// What a write_file / patch approval asks to save (pages-review-v0 §2-§3), shown with the decision: the diff (the page now against the
// proposal) and the proposal itself. Both are Bot-written text and are TEXT ONLY: React text nodes, never markup, never a link. The
// backend redacted the proposal and cut it at 64 KiB (`truncated` says so); the diff is plain unified text it computed at read time.
// No proposal (a hook older than 0.6.0): it says "sem prévia" and the person decides without the text.

import React from "react";
import type { Approval } from "../../api/types";
import { useLuveI18n } from "../../i18n";

type Facts = Pick<Approval, "page" | "proposal" | "review" | "diff">;

const KIB = 1024;
const sizeText = (bytes: number) => (bytes >= KIB * KIB ? `${(bytes / KIB / KIB).toFixed(1)} MiB` : bytes >= KIB ? `${Math.round(bytes / KIB)} KiB` : `${bytes} B`);
const lineStyle = (line: string): React.CSSProperties => {
  const add = line.startsWith("+") && !line.startsWith("+++"), del = line.startsWith("-") && !line.startsWith("---");
  return {
    padding: "0 6px", borderRadius: 4,
    background: add ? "color-mix(in srgb, var(--color-success) 14%, transparent)" : del ? "color-mix(in srgb, var(--color-destructive) 12%, transparent)" : undefined,
    color: add || del ? "var(--color-foreground)" : "var(--color-muted-foreground)",
  };
};
const box: React.CSSProperties = {
  margin: 0, padding: 10, borderRadius: 10, background: "var(--color-background)", color: "var(--color-foreground)", fontFamily: "var(--lb-mono)",
  fontSize: 12, lineHeight: "18px", maxHeight: "40vh", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
};

/** Lines that are text with their own marker: the diff's, or a `replace` proposal's "- old / + new". */
function Lines({ lines, label }: { lines: readonly string[]; label: string }) {
  const { t } = useLuveI18n();
  return (
    <ol aria-label={label} className="lb-mono" style={{ ...box, listStyle: "none" }}>
      {lines.map((l, i) => (
        <li key={i} style={lineStyle(l)}>
          <span className="lb:sr-only">{l.startsWith("+") && !l.startsWith("+++") ? t("pageDiffAdded") : l.startsWith("-") && !l.startsWith("---") ? t("pageDiffRemoved") : ""}</span>
          {l}
        </li>
      ))}
    </ol>
  );
}

/** true when the approval is a file-tool call the screen reviews (its card says so; anything else shows nothing here). */
export const hasReview = (a: Facts) => !!a.review;

export function PageReview({ approval }: { approval: Facts }) {
  const { t } = useLuveI18n();
  const { page, proposal, diff } = approval;
  if (!approval.review) return null;
  if (!proposal) return <p data-testid="page-review-none" className="lb-caption" style={{ margin: "8px 0 0", color: "var(--color-muted-foreground)" }}>{t("pageReviewNoPreview")}</p>;
  const target = page?.slug ?? proposal.path_tag;
  const kind = t(proposal.kind === "whole" ? "pageReviewKindWhole" : proposal.kind === "replace" ? "pageReviewKindReplace" : "pageReviewKindV4a", { target });
  const lines = proposal.content.split("\n");
  // Red team M1: a proposal cut at 64 KiB hides the END of what would be saved, and a diff made against the cut text would show the page's tail as
  // removed. So the diff is not shown, the cut is said first and loudly, and the text that IS shown is open (the card's button reads "Aprovar sem ver tudo").
  const cut = proposal.truncated;
  return (
    <section data-testid="page-review" aria-label={t("pageReviewRegion")} style={{ display: "grid", gap: 8, margin: "8px 0 0", minWidth: 0 }}>
      <div className="lb-body" style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{kind}</div>
      {page && page.base_sha === null && <div data-testid="page-review-new" className="lb-caption">{t("pageReviewNew")}</div>}
      {!page && <div data-testid="page-review-no-guard" className="lb-caption">{t("pageReviewNoGuard")}</div>}
      {cut && <p role="note" data-testid="page-review-cut" className="lb-body" style={{ margin: 0, fontWeight: 600, color: "var(--color-warning)" }}>{t("pageReviewCut", { size: sizeText(proposal.size) })}</p>}
      {cut && diff && <div data-testid="page-review-diff-withheld" className="lb-caption">{t("pageReviewDiffWithheld")}</div>}
      {!cut && diff && (
        <div data-testid="page-review-diff">
          <div className="lb-caption" style={{ marginBottom: 4 }}>{t("pageReviewDiffTitle")}</div>
          {diff.lines.length === 0 ? <p className="lb-subhead" style={{ margin: 0 }}>{t("pageReviewDiffSame")}</p> : <Lines lines={diff.lines} label={t("pageReviewDiffLabel")} />}
          {diff.truncated && <p data-testid="page-review-diff-truncated" className="lb-caption" style={{ margin: "4px 0 0" }}>{t("pageReviewDiffTruncated")}</p>}
        </div>
      )}
      <details data-testid="page-review-preview" open={cut || !diff}>
        <summary className="lb-caption" style={{ cursor: "pointer" }}>{t("pageReviewPreviewTitle")}</summary>
        {proposal.kind === "replace"
          ? <Lines lines={lines} label={t("pageReviewPreviewTitle")} />
          : <pre aria-label={t("pageReviewPreviewTitle")} style={{ ...box, marginTop: 4 }}>{proposal.content}</pre>}
        {cut && <p data-testid="page-review-truncated" className="lb-caption" style={{ margin: "4px 0 0" }}>{t("pageReviewTruncated", { size: sizeText(proposal.size) })}</p>}
      </details>
    </section>
  );
}
