// dashboard/src/components/skills/SkillTextNotes.tsx
// What the screen says about a skill's text BEFORE the server is asked, shared by the review of a new draft and by the editor of an existing skill (contract v0.11 3.2 step 3, 3.3, 3.4): a refused character or too many
// invisible ones (the same table, the same words), the panel that names the invisible characters the table allows with a read-only preview and "Remove them" (on the person's tap only), and the padding warnings.

import React from "react";
import { useLuveI18n } from "../../i18n";
import { classifyInvisible, codeOf } from "../../lib/skillDraft";
import { BLANK_RUN_MAX, LINE_COLUMNS_MAX, hasLongLine, longestBlankRun, markedPreview, markedSummary } from "../../lib/skillTeach";
import { whyText, type T } from "./skillWords";

/** The words for a text the table refuses (a refused character with its class and place, or more than 50 invisible ones), or null. The server checks again; this only spares the round trip and says it at once. */
export function localRefusal(text: string, t: T): string | null {
  const seen = classifyInvisible(text);
  if (seen.verdict === "refuse" && seen.refused) return whyText("hidden_characters", { code: codeOf(seen.refused.codePoint), line: seen.refused.line, column: seen.refused.column }, t);
  return seen.verdict === "too_many" ? whyText("too_many_invisible", { count: seen.count }, t) : null;
}

/** The panel above the text when it holds invisible characters the table ALLOWS: how many, which, on which lines, a preview with each one as a visible token, and the tap that removes exactly those. */
export function InvisiblePanel({ text, onRemove }: { text: string; onRemove: () => void }) {
  const { t, locale } = useLuveI18n();
  const seen = React.useMemo(() => classifyInvisible(text), [text]);
  const box = React.useRef<HTMLPreElement>(null);
  const first = React.useRef<HTMLElement>(null);
  // the box is short: open it on the first line that holds one, so the tokens are on screen and not below the fold
  React.useLayoutEffect(() => { if (box.current && first.current) box.current.scrollTop = Math.max(0, first.current.offsetTop - 24); }, [text]);
  if (seen.verdict !== "ok" || !seen.count) return null;
  const summary = markedSummary(text);
  const lines = new Intl.ListFormat(locale === "pt" ? "pt-BR" : "en", { style: "long", type: "conjunction" }).format(summary.lines.map(String));
  const rows = markedPreview(text).split("\n");
  const at = summary.lines[0] - 1;
  return (
    <div data-testid="skill-invisible-panel" className="lb-alert" style={{ margin: 0 }}>
      <p className="lb-body" style={{ margin: 0 }}>{t("skillInvisPanel", {
        what: summary.count === 1 ? t("skillInvisWhatOne") : t("skillInvisWhat", { count: summary.count }),
        kinds: summary.kinds.map((k) => `${k.name} ×${k.count}`).join(", "),
        where: summary.lines.length === 1 ? t("skillInvisWhereOne", { lines }) : t("skillInvisWhere", { lines }) })}</p>
      <pre ref={box} aria-label={t("skillInvisPreview")} tabIndex={0} data-testid="skill-marked-preview" className="lb-body"
        style={{ position: "relative", margin: "8px 0", maxHeight: 180, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--lb-mono)" }}>
        {at > 0 && rows.slice(0, at).join("\n") + "\n"}<mark ref={first} style={{ background: "transparent", color: "inherit", fontWeight: 700 }}>{rows[at]}</mark>{at < rows.length - 1 && "\n" + rows.slice(at + 1).join("\n")}</pre>
      <button type="button" className="lb-btn" onClick={onRemove}>{t("skillInvisRemove")}</button>
    </div>
  );
}

/** Padding must not push text out of sight: more than 20 blank lines in a row, or a line of more than 1,000 columns, is said (it never blocks). */
export function PaddingNotes({ text }: { text: string }) {
  const { t } = useLuveI18n();
  return (
    <>
      {longestBlankRun(text) > BLANK_RUN_MAX && <p role="note" className="lb-caption" style={{ margin: 0 }}>{t("skillSheetBlankWarn")}</p>}
      {hasLongLine(text, LINE_COLUMNS_MAX) && <p role="note" className="lb-caption" style={{ margin: 0 }}>{t("skillSheetLongWarn")}</p>}
    </>
  );
}
