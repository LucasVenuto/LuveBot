// dashboard/src/components/pages/DiffView.tsx
// Two versions of a page, line by line: removed lines marked "−", added "+". Text only, never rendered Markdown,
// so nothing in either version is interpreted.

import React from "react";
import { useLuveI18n } from "../../i18n";
import type { DiffLine } from "./pages";

export function DiffView({ lines, beforeLabel, afterLabel }: { lines: DiffLine[] | null; beforeLabel: string; afterLabel: string }) {
  const { t } = useLuveI18n();
  if (!lines) return <p className="lb-subhead">{t("pageDiffTooBig")}</p>;
  const changed = lines.some((l) => l.kind !== "same");
  return (
    <div>
      <p className="lb-caption" style={{ color: "var(--color-muted-foreground)", margin: "0 0 8px" }}>
        {t("pageDiffLegend", { before: beforeLabel, after: afterLabel })}
      </p>
      {!changed ? <p className="lb-subhead">{t("pageDiffSame")}</p> : (
        <ol aria-label={t("pageDiffLabel")} className="lb-mono" style={{ listStyle: "none", margin: 0, padding: 12, borderRadius: 12, background: "var(--lb-fill)", fontSize: 13, lineHeight: "20px", maxHeight: "60vh", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {lines.map((l, i) => (
            <li key={i} style={{
              background: l.kind === "add" ? "color-mix(in srgb, var(--color-success) 14%, transparent)" : l.kind === "del" ? "color-mix(in srgb, var(--color-destructive) 12%, transparent)" : undefined,
              color: l.kind === "same" ? "var(--color-muted-foreground)" : "var(--color-foreground)", padding: "0 6px", borderRadius: 4,
            }}>
              <span aria-hidden="true">{l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}</span>
              <span className="lb:sr-only">{l.kind === "add" ? t("pageDiffAdded") : l.kind === "del" ? t("pageDiffRemoved") : ""}</span>
              {l.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
