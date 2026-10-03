// dashboard/src/components/rooms/CreateRoomModal.tsx
// Modal for creating a new room adhering to Contract v0.3 §3.2 and spec §4.4:
// - 2 to 6 member bots (roster frozen at creation)
// - Name (required)
// - Optional goal, owner, coordinator
// - Kickoff checkbox (goal sent as first message)
// - WCAG 2.1 accessible focus trap (useFocusTrap)

import React, { useState, useEffect, useRef } from "react";
import type { Bot, CreateRoomRequest, Room } from "../../api/types";
import { createRoom, getHealth } from "../../api/client";
import { useLuveI18n } from "../../i18n";
import { BotsLoading, BotsError, type ListStatus } from "../ui/ListState";
import { Dialog } from "../ui/Dialog";
import { Avatar } from "../ui/Avatar";
import { CheckIcon } from "../Icons";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";

/** How long creating a room may take before the person is told (Hermes can hang on Group Chat); the request may still land. */
export const ROOM_CREATE_TIMEOUT_MS = 20_000;
class RoomTimeout extends Error {}

export interface CreateRoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  availableBots: Bot[];
  onRoomCreated?: (room: Room) => void;
  /** "0 Bots prontos" only once the list loaded (ui/ListState). */
  botsStatus?: ListStatus;
  onRetryBots?: () => void;
}

export function CreateRoomModal({
  isOpen,
  onClose,
  availableBots,
  onRoomCreated,
  botsStatus = "ready",
  onRetryBots,
}: CreateRoomModalProps) {
  const { t } = useLuveI18n();

  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [selectedBotSlugs, setSelectedBotSlugs] = useState<string[]>([]);
  const [owner, setOwner] = useState<string>("");
  const [coordinator, setCoordinator] = useState<string>("");
  const [kickoff, setKickoff] = useState(false);

  const [error, setError] = useState<ErrorState | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Rooms run on Hermes's Group Chat: when health says it is unavailable or unverified, say why BEFORE the person tries.
  const [roomsDown, setRoomsDown] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);  // health can take up to 5 s: the form is usable, "Criar" waits
  const alertRef = useRef<HTMLDivElement>(null);

  const checkRooms = React.useCallback(async () => {
    setChecking(true);
    try {
      const h = await getHealth();
      const state = h?.features?.groups;
      if (state === "unavailable" || state === "unknown") {
        const why = (h.problems ?? []).find((p) => p.feature === "groups")?.message;
        setRoomsDown(why || state);
      } else setRoomsDown(null);
    } catch {
      setRoomsDown(null);  // health itself failed: let the person try; a failure shows next to the button
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => { if (isOpen) void checkRooms(); }, [isOpen, checkRooms]);
  // The error sits by the button; with many Bots the form scrolls, so bring it into view and focus it.
  useEffect(() => {
    if (error && alertRef.current) { alertRef.current.scrollIntoView?.({ block: "nearest" }); alertRef.current.focus(); }
  }, [error]);

  if (!isOpen) return null;

  const toggleBotSelection = (slug: string) => {
    setError(null);
    if (selectedBotSlugs.includes(slug)) {
      const next = selectedBotSlugs.filter((s) => s !== slug);
      setSelectedBotSlugs(next);
      if (owner === slug) setOwner("");
      if (coordinator === slug) setCoordinator("");
    } else {
      if (selectedBotSlugs.length >= 6) {
        setError(t("roomMembersMinMaxError"));
        return;
      }
      setSelectedBotSlugs([...selectedBotSlugs, slug]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("roomNameRequiredError"));
      return;
    }

    if (selectedBotSlugs.length < 2 || selectedBotSlugs.length > 6) {
      setError(t("roomMembersMinMaxError"));
      return;
    }

    const members = selectedBotSlugs.map((slug) => {
      const bot = availableBots.find((b) => b.name === slug);
      return {
        bot: slug,
        handle: slug,
        display_name: bot?.display?.label || slug,
      };
    });

    const payload: CreateRoomRequest = {
      name: trimmedName,
      members,
      goal: goal.trim() || undefined,
      owner: owner || undefined,
      coordinator: coordinator || undefined,
      kickoff,
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      setIsSubmitting(true);
      const timedOut = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RoomTimeout()), ROOM_CREATE_TIMEOUT_MS); });
      const res = await Promise.race([createRoom(payload), timedOut]);
      setIsSubmitting(false);
      onRoomCreated?.(res.room);
      onClose();
    } catch (err: unknown) {
      setIsSubmitting(false);
      const msg = err instanceof RoomTimeout ? t("roomCreateTimeout") : humanError(err, t, "errorCreatingRoom");
      setError(msg);
    } finally {
      clearTimeout(timer);
    }
  };

  // A Bot Hermes cannot reach (offline: its API Server is off or its gateway is down) cannot take part in a room.
  const ready = (b: Bot) => b.status !== "offline";
  const readyCount = availableBots.filter(ready).length;
  const tooFewReady = botsStatus === "ready" && readyCount < 2;
  // Why "Criar Sala" cannot be pressed yet, said next to it (a disabled button that does not say why reads as broken).
  const why = roomsDown ? t("roomsUnavailableTitle") : botsStatus === "loading" ? t("loadingBots") : botsStatus === "error" ? t("errorLoadingBots") : tooFewReady ? t("roomNeedTwoReady") : !name.trim() ? t("roomNeedName")
    : selectedBotSlugs.length < 2 ? t("roomNeedTwoBots", { count: selectedBotSlugs.length })
    : checking ? t("roomsChecking") : null;  // last: what the person can act on comes first
  const selectedOptions = selectedBotSlugs.map((slug) => <option key={slug} value={slug}>@{slug}</option>);
  return (
    <Dialog open={isOpen} onClose={onClose} title={t("createRoomModalTitle")} titleId="create-room-title" width={520}>
      <form onSubmit={handleSubmit} className="lb-dialog-body">
        {roomsDown && (
          <div role="status" className="lb-alert" data-testid="rooms-unavailable">
            <strong>{t("roomsUnavailableTitle")}</strong> {roomsDown}
            <div><button type="button" className="lb-btn lb-btn-plain" onClick={() => void checkRooms()}>{t("roomsCheckAgain")}</button></div>
          </div>
        )}
        {!roomsDown && tooFewReady && (
          <div role="status" className="lb-alert" data-testid="rooms-too-few-ready">
            <strong>{t("roomTooFewReadyTitle", { count: readyCount })}</strong> {t("roomTooFewReadyHelp")}
          </div>
        )}
        <div className="lb-field">
          <label htmlFor="create-room-name-input" className="lb-label">{t("roomNameLabel")}</label>
          <input id="create-room-name-input" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("roomNamePlaceholder")} maxLength={200} required className="lb-input" />
        </div>
        <div className="lb-field">
          <label htmlFor="create-room-goal-input" className="lb-label">{t("roomGoalLabel")}</label>
          <textarea id="create-room-goal-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t("roomGoalPlaceholder")} rows={2} className="lb-input" style={{ resize: "vertical" }} />
        </div>
        <div className="lb-field">
          <span className="lb-label">{t("roomMembersLabel")}</span>
          <span className="lb-subhead">{t("roomMembersHelp")}</span>
          {botsStatus === "loading" && <BotsLoading />}
          {botsStatus === "error" && <BotsError onRetry={onRetryBots} />}
          <div className="lb-group" style={{ marginTop: 4 }}>
            {availableBots.map((bot) => {
              const isSelected = selectedBotSlugs.includes(bot.name);
              const label = bot.display?.label || bot.name;
              const offline = !ready(bot);
              return (
                <button key={bot.name} type="button" aria-pressed={isSelected} disabled={offline} onClick={() => toggleBotSelection(bot.name)} className="lb-contact" style={{ borderRadius: 0, padding: "8px 14px", ...(offline ? { opacity: 0.55, cursor: "not-allowed" } : {}) }}>
                  <Avatar name={label} avatar={bot.display?.avatar} color={bot.display?.color} size={32} />
                  <span className="lb-row-stack">
                    <span className="lb-headline lb-truncate">{label}</span>
                    <span className="lb-subhead lb-truncate">@{bot.name}</span>
                    {offline && <span className="lb-caption">{t("roomBotNotReady")}</span>}
                  </span>
                  <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", background: isSelected ? "var(--color-foreground)" : "transparent", color: "var(--color-background)", boxShadow: isSelected ? undefined : "inset 0 0 0 1.5px var(--color-muted-foreground)" }}>
                    {isSelected && <CheckIcon size={14} />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        {selectedBotSlugs.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="lb-field">
              <label htmlFor="create-room-owner-select" className="lb-label">{t("roomOwnerLabel")}</label>
              <select id="create-room-owner-select" value={owner} onChange={(e) => setOwner(e.target.value)} className="lb-input">
                <option value="">{t("roomSelectOptionNone")}</option>{selectedOptions}
              </select>
            </div>
            <div className="lb-field">
              <label htmlFor="create-room-coordinator-select" className="lb-label">{t("roomCoordinatorLabel")}</label>
              <select id="create-room-coordinator-select" value={coordinator} onChange={(e) => setCoordinator(e.target.value)} className="lb-input">
                <option value="">{t("roomSelectOptionNone")}</option>{selectedOptions}
              </select>
            </div>
          </div>
        )}
        <div>
          <label className="lb-check">
            <input type="checkbox" checked={kickoff} onChange={(e) => setKickoff(e.target.checked)} />
            <span>{t("roomKickoffLabel")}</span>
          </label>
          <p className="lb-subhead" style={{ paddingLeft: 28 }}>{t("roomKickoffNotice")}</p>
        </div>
        {error && <div ref={alertRef} role="alert" tabIndex={-1} className="lb-alert"><ErrorNote error={error} /></div>}
        <div className="lb-dialog-footer">
          {why && !isSubmitting && <span id="create-room-why" className="lb-caption" style={{ marginRight: "auto", alignSelf: "center" }}>{why}</span>}
          <button type="button" onClick={onClose} className="lb-btn">{t("cancelBtn")}</button>
          <button type="submit" disabled={isSubmitting || !!why} aria-describedby={why ? "create-room-why" : undefined} className="lb-btn lb-btn-primary">
            {isSubmitting ? t("saving") : t("btnCreateRoom")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
