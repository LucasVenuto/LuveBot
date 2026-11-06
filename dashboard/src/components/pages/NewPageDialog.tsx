// dashboard/src/components/pages/NewPageDialog.tsx
// "Nova página" and "Salvar resposta como página" (v0.5 §4.1, §7.3): a title, then one audited create.
// An existing page is never overwritten: the person picks another title. No <form> here, because the
// conversation screen keeps exactly one form (its composer).

import React from "react";
import { createPage } from "../../api/client";
import type { Page } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { Dialog } from "../ui/Dialog";
import { blockText, blockFromError, errCode, errDetails } from "./pages";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";

export interface NewPageDialogProps {
  open: boolean;
  bot: string;
  botLabel: string;
  initialTitle?: string;
  content?: string;          // the Bot's message for "Salvar resposta como página"
  onClose: () => void;
  onCreated: (page: Page) => void;
}

export function NewPageDialog({ open, bot, botLabel, initialTitle = "", content, onClose, onCreated }: NewPageDialogProps) {
  const { t } = useLuveI18n();
  const [title, setTitle] = React.useState(initialTitle);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) { setTitle(initialTitle); setError(null); } }, [open, initialTitle]);

  async function create() {
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { page } = await createPage(bot, content !== undefined ? { title: name, content } : { title: name });
      onCreated(page);
    } catch (e) {
      const code = errCode(e);
      if (code === "page_exists") setError(t("pageExists", { slug: String(errDetails(e).slug ?? "") }));
      else if (code === "invalid_field") setError(t("pageTitleInvalid"));
      else if (code === "too_large") setError(t("pageTooLarge"));
      else if (code === "capability_missing") setError(t("pagesReadOnly"));
      else if (code === "pages_unavailable" || code === "not_found") setError(blockText(blockFromError(e), { name: bot, label: botLabel }, t));
      else setError(humanError(e, t, "unexpectedError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={content !== undefined ? t("pageSaveAsTitle") : t("pageNewTitle")} titleId="page-new-title">
      <div className="lb-dialog-body">
        <label className="lb-field">
          <span className="lb-label">{t("pageTitleLabel")}</span>
          <input className="lb-input" value={title} maxLength={120} autoFocus onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void create(); } }} />
        </label>
        <p className="lb-caption" style={{ color: "var(--color-muted-foreground)", margin: 0 }}>{t("pageSaveIn", { name: botLabel })}</p>
        {error && <p role="alert" className="lb-alert" style={{ margin: 0 }}><ErrorNote error={error} /></p>}
        <div className="lb-dialog-footer">
          <button type="button" onClick={onClose} className="lb-btn">{t("cancelBtn")}</button>
          <button type="button" onClick={() => void create()} disabled={!title.trim() || busy} className="lb-btn lb-btn-primary">{t("pageCreate")}</button>
        </div>
      </div>
    </Dialog>
  );
}
