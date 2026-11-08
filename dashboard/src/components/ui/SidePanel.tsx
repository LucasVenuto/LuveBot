// dashboard/src/components/ui/SidePanel.tsx
// The panel beside the conversation (Dots: the agent's profile, activity and results). On desktop it is a
// column that leaves the conversation usable; on a phone it is a bottom sheet that traps focus.
// Esc closes it in both. Its content mounts only while open, so a form inside never sits next to the composer.

import React from "react";
import { useLuveI18n } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useNarrow } from "../../hooks/useNarrow";
import { XIcon } from "../Icons";

export interface SidePanelProps {
  open: boolean;
  onClose: () => void;
  label: string;  // accessible name of the panel
  children: React.ReactNode;
}

export function SidePanel({ open, onClose, label, children }: SidePanelProps) {
  const { t } = useLuveI18n();
  const narrow = useNarrow();
  const sheetRef = useFocusTrap<HTMLElement>({ isOpen: open && narrow, onClose });
  if (!open) return null;

  const close = (
    <button type="button" onClick={onClose} aria-label={t("closePanelBtn")} className="lb-icon-btn"
      style={{ position: "absolute", top: 12, right: 12, background: "var(--lb-fill)", color: "var(--color-foreground)" }}>
      <XIcon size={18} />
    </button>
  );
  const body = <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px 24px" }}>{children}</div>;

  if (narrow) {
    return (
      <>
        <div aria-hidden="true" onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 49, background: "rgba(0,0,0,0.32)" }} />
        <aside ref={sheetRef} role="dialog" aria-modal="true" aria-label={label} className="lb-sheet"
          style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 50, maxHeight: "88vh", display: "flex", flexDirection: "column", background: "var(--color-card)", color: "var(--color-card-foreground)", borderTopLeftRadius: 24, borderTopRightRadius: 24, boxShadow: "0 -8px 32px rgba(0,0,0,0.18)" }}>
          <div aria-hidden="true" style={{ width: 36, height: 5, borderRadius: 3, background: "var(--lb-fill-2)", margin: "8px auto 0" }} />
          {close}
          {body}
        </aside>
      </>
    );
  }
  return (
    <aside aria-label={label} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      style={{ position: "relative", width: 380, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--color-card)", color: "var(--color-card-foreground)", borderLeft: "1px solid var(--lb-separator)" }}>
      {close}
      {body}
    </aside>
  );
}
