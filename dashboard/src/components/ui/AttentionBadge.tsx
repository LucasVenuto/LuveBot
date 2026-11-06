// dashboard/src/components/ui/AttentionBadge.tsx
// The visible mark of a Bot's attention state. Every mark carries its text label for screen readers;
// idle draws nothing (a quiet contact, as in Dots and Grok Bot).

import React from "react";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import type { Attention } from "../messenger/attention";
import { INK } from "./color";

const META: Record<Exclude<Attention, "idle">, { label: TranslationKey; title: TranslationKey }> = {
  needs_you: { label: "statusNeedsYouLabel", title: "statusNeedsYouTitle" },
  error: { label: "statusErrorLabel", title: "statusErrorTitle" },
  offline: { label: "statusOfflineLabel", title: "statusOfflineTitle" },
  paused: { label: "statusPausedLabel", title: "statusPausedTitle" },
  working: { label: "statusWorkingLabel", title: "statusWorkingTitle" },
  unread: { label: "statusUnreadLabel", title: "statusUnreadTitle" },
};

const pill: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  minWidth: 18, height: 18, padding: "0 5px", borderRadius: 9, fontSize: 12, fontWeight: 700, lineHeight: 1,
};

export function AttentionBadge({ state }: { state: Attention }) {
  const { t } = useLuveI18n();
  if (state === "idle") return null;
  const a11y = { role: "img" as const, "aria-label": t(META[state].label), title: t(META[state].title) };
  switch (state) {
    case "needs_you":
      return <span {...a11y} className="luve-pulse" style={{ ...pill, background: "var(--color-warning)", color: INK }}>!</span>;
    case "error":
      return <span {...a11y} style={{ ...pill, background: "var(--color-destructive)", color: "var(--color-destructive-foreground)" }}>×</span>;
    case "paused":
      return <span {...a11y} style={{ ...pill, background: "var(--color-muted)", color: "var(--color-muted-foreground)" }}>‖</span>;
    case "offline":
      return <span {...a11y} style={{ width: 10, height: 10, borderRadius: "50%", boxSizing: "border-box", flexShrink: 0, border: "2px solid var(--color-muted-foreground)" }} />;
    case "unread":
      return <span {...a11y} style={{ width: 10, height: 10, borderRadius: 5, flexShrink: 0, background: "var(--color-primary)" }} />;
    case "working":
      return (
        <span {...a11y} className="luve-typing" style={{ display: "inline-flex", gap: 3, alignItems: "center", flexShrink: 0 }}>
          <i /><i /><i />
        </span>
      );
  }
}
