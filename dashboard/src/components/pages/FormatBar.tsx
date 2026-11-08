// dashboard/src/components/pages/FormatBar.tsx
// The page editor's toolbar (ADR-009 option C): title, bold, italic, list, quote, code, link. Each button only INSERTS Markdown through
// pages/format.ts; the buttons do not take focus from the text (mousedown is not allowed to move it), so the selection stays where it was.

import React from "react";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import type { FormatKind } from "./format";

// The letters on the buttons are symbols, not words (the names are the translated aria-labels).
const LETTER = { heading: "T", bold: "B", italic: "I" };

interface Item { kind: FormatKind; label: TranslationKey; glyph: React.ReactNode; keys?: string; code?: string }
const ITEMS: Item[] = [
  { kind: "heading", label: "fmtHeading", glyph: <span style={{ fontWeight: 700 }}>{LETTER.heading}</span> },
  { kind: "bold", label: "fmtBold", glyph: <span style={{ fontWeight: 800 }}>{LETTER.bold}</span>, keys: "B" },
  { kind: "italic", label: "fmtItalic", glyph: <span style={{ fontStyle: "italic", fontFamily: "serif" }}>{LETTER.italic}</span>, keys: "I" },
  { kind: "list", label: "fmtList", glyph: <span>•</span>, keys: "⇧7" },
  { kind: "quote", label: "fmtQuote", glyph: <span>“</span>, keys: "⇧." },
  { kind: "code", label: "fmtCode", glyph: <span className="lb-mono">{"</>"}</span>, keys: "E" },
  { kind: "link", label: "fmtLink", glyph: <span>↗</span>, keys: "⇧K" },
];

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

export function FormatBar({ onFormat }: { onFormat: (kind: FormatKind) => void }) {
  const { t } = useLuveI18n();
  const mod = isMac() ? "⌘" : "Ctrl+";
  return (
    <div role="toolbar" aria-label={t("fmtBarLabel")} data-testid="format-bar" style={{ display: "flex", flexWrap: "wrap", gap: 4, paddingBottom: 8 }}>
      {ITEMS.map((i) => {
        const shortcut = i.keys ? `${mod}${i.keys}` : "";
        return (
          <button key={i.kind} type="button" data-testid={`fmt-${i.kind}`} aria-label={t(i.label)} title={shortcut ? `${t(i.label)} (${shortcut})` : t(i.label)}
            aria-keyshortcuts={i.keys ? `${isMac() ? "Meta" : "Control"}+${i.keys.replace("⇧", "Shift+")}` : undefined}
            onMouseDown={(e) => e.preventDefault()} onClick={() => onFormat(i.kind)}
            className="lb-btn" style={{ minWidth: 40, minHeight: 40, padding: 0, justifyContent: "center" }}>
            {i.glyph}
          </button>
        );
      })}
    </div>
  );
}
