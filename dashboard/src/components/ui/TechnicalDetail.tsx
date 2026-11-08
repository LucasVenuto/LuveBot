// dashboard/src/components/ui/TechnicalDetail.tsx
// Ids and codes a person rarely needs (digest, run id, pattern key, rule id, session id): kept for whoever does, behind a
// collapsed "Detalhe técnico", never on the first read. Plain text that wraps anywhere, so a long id never widens a phone screen.
import React from "react";
import { useLuveI18n } from "../../i18n";
import { visibleTokens } from "../../lib/hiddenChars";

export function TechnicalDetail({ lines, testId }: { lines: ReadonlyArray<string | null | undefined | false>; testId?: string }) {
  const { t } = useLuveI18n();
  const shown = lines.filter((line): line is string => typeof line === "string" && line !== "");
  if (!shown.length) return null;
  return (
    <details data-testid={testId} style={{ minWidth: 0, maxWidth: "100%" }}>
      <summary className="lb-caption" style={{ cursor: "pointer" }}>{t("approvalTechnicalDetail")}</summary>
      <pre className="lb-caption" style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--lb-mono)" }}>{visibleTokens(shown.join("\n"))}</pre>
    </details>
  );
}
