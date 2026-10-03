// dashboard/src/components/rooms/EditRoomModal.tsx
// Modal for editing room metadata (Contract v0.3 §3.2, A-35).
// Members are frozen at creation; only name, goal, owner, coordinator can be changed.

import React, { useState } from "react";
import type { Room } from "../../api/types";
import { patchRoom } from "../../api/client";
import { useLuveI18n } from "../../i18n";
import { Dialog } from "../ui/Dialog";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";

export interface EditRoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  room: Room;
  onRoomUpdated?: (updated: Room) => void;
}

export function EditRoomModal({
  isOpen,
  onClose,
  room,
  onRoomUpdated,
}: EditRoomModalProps) {
  const { t } = useLuveI18n();

  const [name, setName] = useState(room.name);
  const [goal, setGoal] = useState(room.goal || "");
  const [owner, setOwner] = useState(room.owner || "");
  const [coordinator, setCoordinator] = useState(room.coordinator || "");

  const [error, setError] = useState<ErrorState | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("roomNameRequiredError"));
      return;
    }

    try {
      setIsSubmitting(true);
      const res = await patchRoom(room.id, {
        name: trimmedName,
        goal: goal.trim() || undefined,
        owner: owner || undefined,
        coordinator: coordinator || undefined,
      });
      setIsSubmitting(false);
      onRoomUpdated?.(res.room);
      onClose();
    } catch (err: unknown) {
      setIsSubmitting(false);
      const msg = humanError(err, t, "errorPatchingRoom");
      setError(msg);
    }
  };

  const memberOptions = room.members.map((m) => <option key={m.handle} value={m.handle}>@{m.handle}</option>);
  return (
    <Dialog open={isOpen} onClose={onClose} title={t("editRoomModalTitle")} titleId="edit-room-title" width={480}>
      <form onSubmit={handleSubmit} className="lb-dialog-body">
        {error && <div role="alert" className="lb-alert"><ErrorNote error={error} /></div>}
        <div className="lb-field">
          <label htmlFor="edit-room-name-input" className="lb-label">{t("roomNameLabel")}</label>
          <input id="edit-room-name-input" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("roomNamePlaceholder")} maxLength={200} required className="lb-input" />
        </div>
        <div className="lb-field">
          <label htmlFor="edit-room-goal-input" className="lb-label">{t("roomGoalLabel")}</label>
          <textarea id="edit-room-goal-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t("roomGoalPlaceholder")} rows={2} className="lb-input" style={{ resize: "vertical" }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="lb-field">
            <label htmlFor="edit-room-owner-select" className="lb-label">{t("roomOwnerLabel")}</label>
            <select id="edit-room-owner-select" value={owner} onChange={(e) => setOwner(e.target.value)} className="lb-input">
              <option value="">{t("roomSelectOptionNone")}</option>{memberOptions}
            </select>
          </div>
          <div className="lb-field">
            <label htmlFor="edit-room-coordinator-select" className="lb-label">{t("roomCoordinatorLabel")}</label>
            <select id="edit-room-coordinator-select" value={coordinator} onChange={(e) => setCoordinator(e.target.value)} className="lb-input">
              <option value="">{t("roomSelectOptionNone")}</option>{memberOptions}
            </select>
          </div>
        </div>
        <p className="lb-subhead">{t("roomMembersHelp")}</p>
        <div className="lb-dialog-footer">
          <button type="button" onClick={onClose} className="lb-btn">{t("cancelBtn")}</button>
          <button type="submit" disabled={isSubmitting || !name.trim()} className="lb-btn lb-btn-primary">
            {isSubmitting ? t("saving") : t("btnSaveRoom")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
