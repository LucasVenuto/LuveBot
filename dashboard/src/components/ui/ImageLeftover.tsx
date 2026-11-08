// dashboard/src/components/ui/ImageLeftover.tsx
// "An image nobody wears is offered for deletion" (contract v0.11 §2.3): after a face stops being an image the person sent, this offers to delete it from the server (DELETE /avatars/{id},
// owner only, audited). It is asked, never done on its own; "Manter" leaves it. A refusal says why in words (still worn by a Bot or a person: change their face first).

import React from "react";
import { deleteAvatar } from "../../api/client";
import { useLuveI18n } from "../../i18n";
import { ErrorNote, humanError, type ErrorState } from "./ErrorNote";

export function ImageLeftover({ id, onDone }: { id: string; onDone: () => void }) {
  const { t } = useLuveI18n();
  const [state, setState] = React.useState<"ask" | "busy" | "deleted">("ask");
  const [error, setError] = React.useState<ErrorState | null>(null);
  const remove = async () => {
    setState("busy"); setError(null);
    try { await deleteAvatar(id); setState("deleted"); }
    catch (e) {
      setError(humanError(e, t, "aviErrDelete"));   // a 404 may be "not yours" (the server says nothing more): the sentence covers both
      setState("ask");
    }
  };
  if (state === "deleted") return <p role="status" data-testid="image-leftover-deleted" className="lb-caption" style={{ margin: 0 }}>{t("aviDeleted")}</p>;
  return (
    <div role="group" data-testid="image-leftover" aria-label={t("aviDeleteOffer")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p className="lb-caption" style={{ margin: 0 }}>{t("aviDeleteOffer")}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="button" data-testid="btn-image-delete" className="lb-btn" disabled={state === "busy"} aria-busy={state === "busy"} onClick={() => void remove()}>{t("aviDelete")}</button>
        <button type="button" data-testid="btn-image-keep" className="lb-btn" disabled={state === "busy"} onClick={onDone}>{t("aviKeep")}</button>
      </div>
      {error && <p role="alert" data-testid="image-leftover-error" className="lb-caption" style={{ margin: 0, color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
    </div>
  );
}
