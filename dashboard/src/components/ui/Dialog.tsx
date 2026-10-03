// dashboard/src/components/ui/Dialog.tsx
// The one modal frame (guide §2/§5): a dimmed, lightly blurred backdrop, a 22 px card that floats (shadow 3),
// a title, a close button, focus kept inside and Esc to close. Forms and footers go in `children`.

import React from "react";
import { useLuveI18n } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { XIcon } from "../Icons";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  titleId: string;
  tone?: "default" | "destructive" | "warning";
  width?: number;
  children: React.ReactNode;
}

export function Dialog({ open, onClose, title, titleId, tone = "default", width = 440, children }: DialogProps) {
  const { t } = useLuveI18n();
  const ref = useFocusTrap<HTMLDivElement>({ isOpen: open, onClose });
  if (!open) return null;
  const color = tone === "destructive" ? "var(--color-destructive)" : "var(--color-foreground)";
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className="lb-dialog-overlay">
      <div className="lb-dialog" style={{ maxWidth: width }}>
        <div className="lb-dialog-head">
          <h2 id={titleId} className="lb-title" style={{ color }}>{title}</h2>
          <button type="button" onClick={onClose} aria-label={t("close")} className="lb-icon-btn" style={{ background: "var(--lb-fill)" }}>
            <XIcon size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
