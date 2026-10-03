// dashboard/src/components/rooms/DisbandRoomModal.tsx
// Modal for disbanding a room permanently (Contract v0.3 §3.2).
// Requires typing the room name for confirmation.

import React, { useState } from "react";
import type { Room } from "../../api/types";
import { disbandRoom } from "../../api/client";
import { useLuveI18n } from "../../i18n";
import { Dialog } from "../ui/Dialog";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";

export interface DisbandRoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  room: Room;
  onRoomDisbanded?: (roomId: string) => void;
}

export function DisbandRoomModal({
  isOpen,
  onClose,
  room,
  onRoomDisbanded,
}: DisbandRoomModalProps) {
  const { t } = useLuveI18n();
  const [confirmName, setConfirmName] = useState("");
  const [error, setError] = useState<ErrorState | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const isNameMatch = confirmName.trim() === room.name;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isNameMatch) {
      setError(t("errorDisbandingNameMismatch"));
      return;
    }

    try {
      setIsSubmitting(true);
      await disbandRoom(room.id, confirmName.trim());
      setIsSubmitting(false);
      onRoomDisbanded?.(room.id);
      onClose();
    } catch (err: unknown) {
      setIsSubmitting(false);
      const msg = humanError(err, t, "errorDisbandingRoom");
      setError(msg);
    }
  };

  return (
    <Dialog open={isOpen} onClose={onClose} title={t("modalDisbandRoomTitle")} titleId="disband-room-title" tone="destructive" width={420}>
      <form onSubmit={handleSubmit} className="lb-dialog-body">
        {error && <div role="alert" className="lb-alert"><ErrorNote error={error} /></div>}
        <p className="lb-body" style={{ margin: 0 }}>{t("modalDisbandRoomBody", { name: room.name })}</p>
        <label className="lb-field">
          <span className="lb-label">{t("disbandRoomInputPlaceholder")}</span>
          <input type="text" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} className="lb-input" autoFocus />
        </label>
        <div className="lb-dialog-footer">
          <button type="button" onClick={onClose} className="lb-btn">{t("cancelBtn")}</button>
          <button type="submit" disabled={!isNameMatch || isSubmitting} className="lb-btn lb-btn-destructive">
            {isSubmitting ? t("saving") : t("btnConfirmDisband")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
