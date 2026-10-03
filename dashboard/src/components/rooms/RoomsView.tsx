// dashboard/src/components/rooms/RoomsView.tsx
// A room is a group chat (Grok Bot §1.6, Cue §3.4, brief §2.7), drawn like the 1:1 conversation: each Bot signs its
// own bubble with its face and color, a handoff is a card in the thread, the members sit in the side panel.
// Contract v0.3 §3/§4 and spec §4.4 hold as before:
// - @ autocomplete ONLY offers member Bots (and @todos); the backend refuses a non-member (422 not_a_member)
// - @todos or several @ need a cost confirmation (confirm_cost)
// - Bot and tool text through <Markdown> only, never HTML
// - Parar and Repetir need confirmation; Parar stays until the backend confirms the room stopped
// The room follows the `roomId` prop (switching rooms in the list switches here, D10) and refreshes on its own.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { Room, RoomEvent, Handoff, Bot } from "../../api/types";
import { getRoom, getRoomLog, sendRoomMessage, stopRoom, retryRoomTask, getHandoffs, promoteHandoff } from "../../api/client";
import { useLuveI18n } from "../../i18n";
import { handoffStateLabel } from "../labels";
import { mentionAt, offersAll, matchingMembers, isMultiTarget, insertMention } from "./mentions";
import { Markdown } from "../../lib/render/markdown";
import { CreateRoomModal } from "./CreateRoomModal";
import { EditRoomModal } from "./EditRoomModal";
import { DisbandRoomModal } from "./DisbandRoomModal";
import { CostConfirmModal } from "./CostConfirmModal";
import { Avatar } from "../ui/Avatar";
import { AvatarStack } from "../ui/AvatarStack";
import { AttentionBadge } from "../ui/AttentionBadge";
import { Bubble } from "../ui/Bubble";
import { SidePanel } from "../ui/SidePanel";
import { Dialog } from "../ui/Dialog";
import { botColor } from "../ui/color";
import { PlusIcon, XIcon } from "../Icons";
import { usePhoneBar } from "../messenger/phoneBar";
import { displayFace } from "../ui/mascots";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";

export interface RoomsViewProps {
  roomId?: string | null;
  availableBots: Bot[];
  onSelectRoom?: (room: Room) => void;
  onNavigateToKanban?: (taskId?: string) => void;
  onOpenTeamMap?: () => void;
  pollMs?: number;  // how often the open room is re-read (new Bot messages, driver state)
}

interface MentionOption { id: string; handle: string; label: string; color?: string; avatar?: Room["members"][number]["avatar"] }

export function RoomsView({ roomId = null, availableBots, onSelectRoom, onNavigateToKanban, onOpenTeamMap, pollMs = 4000 }: RoomsViewProps) {
  const { t } = useLuveI18n();
  const phone = usePhoneBar();  // on a phone, the shell's back and Hermes controls live in this header (one strip)

  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  const [roomEvents, setRoomEvents] = useState<RoomEvent[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [error, setError] = useState<ErrorState | null>(null);

  const [inputText, setInputText] = useState("");
  const [isSending, setIsSending] = useState(false);

  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);

  const [stoppingIds, setStoppingIds] = useState<Record<string, boolean>>({});  // "o Parar só some com fim confirmado"

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [disbandModalOpen, setDisbandModalOpen] = useState(false);
  const [costModalOpen, setCostModalOpen] = useState(false);
  const [stopModalOpen, setStopModalOpen] = useState(false);
  const [retryModalOpen, setRetryModalOpen] = useState(false);
  const [retryTaskId, setRetryTaskId] = useState<string | null>(null);
  const [pendingTextToSend, setPendingTextToSend] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadRoomDetails = useCallback(async (id: string, quiet = false) => {
    try {
      if (!quiet) setError(null);
      const [roomRes, logRes, handoffRes] = await Promise.all([getRoom(id), getRoomLog(id), getHandoffs({ room: id })]);
      setCurrentRoom(roomRes.room);
      setRoomEvents(logRes.events || []);
      setHandoffs(handoffRes.handoffs || []);
      if (!roomRes.room.driver.running) {
        // the backend confirmed the room is not running: only now does "Parando..." end
        setStoppingIds((prev) => {
          if (!prev[id]) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    } catch (err: unknown) {
      if (!quiet) setError(humanError(err, t, "errorLoadingRoom"));
    }
  }, [t]);

  // Follow the prop: picking another room in the contact list opens it here (D10).
  useEffect(() => {
    setMembersOpen(false);
    setInputText("");
    setShowMentionDropdown(false);
    if (roomId) void loadRoomDetails(roomId);
    else { setCurrentRoom(null); setRoomEvents([]); setHandoffs([]); }
  }, [roomId, loadRoomDetails]);

  // New Bot messages and the driver state arrive without a click.
  useEffect(() => {
    if (!roomId || pollMs <= 0) return;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void loadRoomDetails(roomId, true);
    }, pollMs);
    return () => clearInterval(timer);
  }, [roomId, pollMs, loadRoomDetails]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [roomEvents.length]);

  const members = currentRoom?.members || [];
  const botOf = (bot: string) => availableBots.find((b) => b.name === bot);
  const colorOf = (m?: Room["members"][number]) => m?.color || (m ? botOf(m.bot)?.display?.color : undefined);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputText(val);
    setError(null);
    const match = mentionAt(val, e.target.selectionStart);
    if (match) {
      setMentionQuery(match.query);
      setMentionStartIndex(match.start);
      setShowMentionDropdown(true);
      setMentionSelectedIndex(0);
    } else {
      setShowMentionDropdown(false);
      setMentionStartIndex(-1);
    }
  };

  // STRICTLY MEMBER BOTS ONLY (red team 10)
  const mentionOptions: MentionOption[] = [
    ...(offersAll(mentionQuery) ? [{ id: "todos", handle: "todos", label: t("roomMentionTodosLabel"), color: "var(--color-warning)" }] : []),
    ...matchingMembers(members, mentionQuery).map((m) => ({
      id: m.member_id || m.bot, handle: m.handle, avatar: displayFace(m.bot, m.avatar ?? botOf(m.bot)?.display?.avatar), color: colorOf(m),
      label: m.display_name ? `${m.display_name} (@${m.handle})` : `@${m.handle}`,
    })),
  ];

  const handleSelectMention = (opt: MentionOption) => {
    if (mentionStartIndex < 0) return;
    const cursor = textareaRef.current?.selectionStart || inputText.length;
    const next = insertMention(inputText, mentionStartIndex, cursor, opt.handle);
    setInputText(next.text);
    setShowMentionDropdown(false);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionDropdown && mentionOptions.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionSelectedIndex((p) => (p + 1) % mentionOptions.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMentionSelectedIndex((p) => (p - 1 + mentionOptions.length) % mentionOptions.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); handleSelectMention(mentionOptions[mentionSelectedIndex]); return; }
      if (e.key === "Escape") { e.preventDefault(); setShowMentionDropdown(false); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSendMessage(false); }
  };

  const handleSendMessage = async (confirmCost = false) => {
    if (!currentRoom || !inputText.trim() || isSending) return;
    setError(null);
    const textToSend = inputText.trim();
    if (isMultiTarget(textToSend) && !confirmCost) {
      setPendingTextToSend(textToSend);
      setCostModalOpen(true);
      return;
    }
    try {
      setIsSending(true);
      const res = await sendRoomMessage(currentRoom.id, {
        text: textToSend,
        event_id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `msg-${Date.now()}`,
        confirm_cost: confirmCost || undefined,
      });
      setInputText("");
      setShowMentionDropdown(false);
      setCostModalOpen(false);
      setPendingTextToSend(null);
      if (res?.event) setRoomEvents((prev) => [...prev, res.event]);
      await loadRoomDetails(currentRoom.id);
    } catch (err: unknown) {
      const e = err as { code?: string; details?: { handles?: string[] } } | null;
      if (e?.code === "not_a_member") {
        setError(t("roomNotAMemberError", { handle: e.details?.handles?.[0] || t("unknownHandle") }));
        return;
      }
      if (e?.code === "cost_confirmation_required") {
        setPendingTextToSend(textToSend);
        setCostModalOpen(true);
        return;
      }
      setError(humanError(err, t, "errorSendingRoomMessage"));
    } finally {
      setIsSending(false);
    }
  };

  const handleStopRoom = async () => {
    if (!currentRoom) return;
    try {
      setStoppingIds((prev) => ({ ...prev, [currentRoom.id]: true }));
      setStopModalOpen(false);
      await stopRoom(currentRoom.id);
      await loadRoomDetails(currentRoom.id);
    } catch (err: unknown) {
      setError(humanError(err, t, "errorStoppingRoom"));
    }
  };

  const handleRetryTask = async () => {
    if (!currentRoom || !retryTaskId) return;
    try {
      setRetryModalOpen(false);
      await retryRoomTask(currentRoom.id, retryTaskId);
      setRetryTaskId(null);
      await loadRoomDetails(currentRoom.id);
    } catch (err: unknown) {
      setError(humanError(err, t, "errorRetryingRoomTask"));
    }
  };

  const handlePromoteHandoff = async (handoffId: string) => {
    try {
      await promoteHandoff(handoffId);
      if (roomId) await loadRoomDetails(roomId);
    } catch (err: unknown) {
      setError(humanError(err, t, "errorPromotingHandoff"));
    }
  };

  const isStopping = currentRoom ? Boolean(stoppingIds[currentRoom.id]) : false;
  const isStoppable = !!currentRoom && (currentRoom.driver.running || isStopping);
  const kickoff = members.length >= 2 ? t("roomKickoffTemplate", { a: members[0].handle, b: members[1].handle }) : null;

  const modals = (
    <>
      <CreateRoomModal isOpen={createModalOpen} onClose={() => setCreateModalOpen(false)} availableBots={availableBots} onRoomCreated={(r) => onSelectRoom?.(r)} />
      {currentRoom && <EditRoomModal isOpen={editModalOpen} onClose={() => setEditModalOpen(false)} room={currentRoom} onRoomUpdated={setCurrentRoom} />}
      {currentRoom && <DisbandRoomModal isOpen={disbandModalOpen} onClose={() => setDisbandModalOpen(false)} room={currentRoom} onRoomDisbanded={() => { setCurrentRoom(null); setRoomEvents([]); }} />}
      <CostConfirmModal isOpen={costModalOpen} onClose={() => { setCostModalOpen(false); setPendingTextToSend(null); }}
        onConfirm={() => { if (pendingTextToSend) void handleSendMessage(true); }} isSubmitting={isSending} />
      <Dialog open={stopModalOpen} onClose={() => setStopModalOpen(false)} title={t("modalStopRoomTitle")} titleId="stop-room-title" tone="destructive" width={420}>
        <div className="lb-dialog-body">
          <p className="lb-body" style={{ margin: 0 }}>{t("modalStopRoomBody")}</p>
          <div className="lb-dialog-footer">
            <button type="button" onClick={() => setStopModalOpen(false)} className="lb-btn">{t("cancelBtn")}</button>
            <button type="button" onClick={handleStopRoom} className="lb-btn lb-btn-destructive">{t("btnConfirmStopRoom")}</button>
          </div>
        </div>
      </Dialog>
      <Dialog open={retryModalOpen} onClose={() => setRetryModalOpen(false)} title={t("modalRetryRoomTitle")} titleId="retry-room-title" width={420}>
        <div className="lb-dialog-body">
          <p className="lb-body" style={{ margin: 0 }}>{t("modalRetryRoomBody")}</p>
          <div className="lb-dialog-footer">
            <button type="button" onClick={() => setRetryModalOpen(false)} className="lb-btn">{t("cancelBtn")}</button>
            <button type="button" onClick={handleRetryTask} className="lb-btn lb-btn-primary">{t("btnConfirmRetryRoom")}</button>
          </div>
        </div>
      </Dialog>
    </>
  );

  if (!currentRoom) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 8, padding: phone ? "12px 8px" : "12px 16px", minHeight: 64, borderBottom: "1px solid var(--lb-separator)" }}>
          {phone?.back}
          <h1 className="lb-headline" style={{ flex: 1 }}>{t("roomsTitle")}</h1>
          <button type="button" onClick={() => setCreateModalOpen(true)} className="lb-btn"><PlusIcon size={14} /><span>{t("newRoomBtn")}</span></button>
          {phone?.hermes}
        </header>
        {error && <div role="alert" className="lb-alert" style={{ margin: 12 }}><ErrorNote error={error} /></div>}
        <div data-testid="rooms-empty-state" className="lb-empty" style={{ flex: 1, justifyContent: "center" }}>
          <h3 className="lb-title">{t("noRoomSelected")}</h3>
          <p className="lb-subhead" style={{ maxWidth: 380 }}>{t("roomsEmptyNextStep")}</p>
          <button type="button" onClick={() => setCreateModalOpen(true)} className="lb-btn lb-btn-primary" style={{ marginTop: 6 }}>{t("newRoomBtn")}</button>
        </div>
        {modals}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <section aria-label={currentRoom.name} style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}>
        <header style={{ display: "flex", alignItems: "center", gap: phone ? 8 : 12, padding: phone ? "10px 8px" : "10px 16px", minHeight: 64, borderBottom: "1px solid var(--lb-separator)", flexWrap: "wrap" }}>
          {phone?.back}
          <AvatarStack size={30} faces={members.map((m) => ({ key: m.member_id || m.bot, name: m.display_name || m.handle, avatar: displayFace(m.bot, m.avatar ?? botOf(m.bot)?.display?.avatar), color: colorOf(m) }))} />
          <div style={{ flex: 1, minWidth: 140 }}>
            <h1 className="lb-headline lb-truncate">{currentRoom.name}</h1>
            <div role="status" className="lb-caption" style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
              {(currentRoom.driver.working ?? currentRoom.driver.running) ? <><AttentionBadge state="working" />{t("roomDriverRunning")}</> : <>{t("roomMembersCount", { count: members.length })}</>}
              {currentRoom.goal && <span title={currentRoom.goal} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>· {currentRoom.goal}</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button type="button" aria-expanded={membersOpen} onClick={() => setMembersOpen(!membersOpen)} className="lb-btn">{t("roomMembersBtn")}</button>
            <button type="button" onClick={() => setEditModalOpen(true)} className="lb-btn">{t("editRoomModalTitle")}</button>
            {isStoppable && (
              <button type="button" data-testid="btn-stop-room" disabled={isStopping} onClick={() => setStopModalOpen(true)} className="lb-btn lb-btn-destructive">
                {isStopping ? t("roomStoppingBtn") : t("roomStopBtn")}
              </button>
            )}
            <button type="button" onClick={() => setDisbandModalOpen(true)} title={t("roomDisbandBtn")} aria-label={t("roomDisbandBtn")} className="lb-icon-btn">
              <XIcon size={14} />
            </button>
            {phone?.hermes}
          </div>
        </header>

        {error && (
          <div role="alert" className="lb-alert" style={{ margin: "10px 16px 0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span><ErrorNote error={error} /></span>
            <button type="button" onClick={() => setError(null)} aria-label={t("close")} className="lb-icon-btn" style={{ color: "inherit" }}><XIcon size={14} /></button>
          </div>
        )}

        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {roomEvents.length === 0 && (
            <div data-testid="room-events-empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100%", gap: 8, textAlign: "center" }}>
              <h3 className="lb-title">{t("roomEmptyKickoffTitle")}</h3>
              <p className="lb-subhead" style={{ maxWidth: 420 }}>{t("roomEmptyKickoffDesc")}</p>
              {kickoff && (
                <button type="button" onClick={() => { setInputText(kickoff); textareaRef.current?.focus(); }} className="lb-btn" style={{ marginTop: 6, maxWidth: 460, height: "auto", padding: "8px 14px", lineHeight: "18px", whiteSpace: "normal", textAlign: "left" }}>
                  {kickoff}
                </button>
              )}
            </div>
          )}
          {roomEvents.map((evt) => {
            const key = evt.event_id || evt.seq;
            if (evt.kind === "handoff.card" || evt.payload.handoff_id) {
              return (
                <div key={key} data-testid={`handoff-card-${evt.payload.handoff_id || evt.seq}`}
                  className="lb-group" style={{ maxWidth: 520, margin: "14px auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span className="lb-caption">{t("roomHandoffCardTitle")}</span>
                    {evt.payload.status && <span className="lb-pill">{handoffStateLabel(evt.payload.status, t)}</span>}
                  </div>
                  <div className="lb-headline">{t("roomHandoffFromTo", { from: evt.payload.from || "?", to: evt.payload.to || "?" })}</div>
                  {evt.payload.title && <div className="lb-body"><Markdown text={evt.payload.title} /></div>}
                  <button type="button" data-testid="handoff-kanban-link" onClick={() => onNavigateToKanban?.(evt.payload.task_id)} className="lb-btn lb-btn-plain" style={{ alignSelf: "flex-start", marginTop: 2 }}>
                    {t("roomHandoffTaskLink")}
                  </button>
                </div>
              );
            }
            if (evt.kind === "message.user" || evt.actor.kind === "user") {
              return <Bubble key={key} side="me">{evt.payload.text || ""}</Bubble>;
            }
            if (evt.kind === "turn.failed") {
              const taskId = evt.payload.task_id || evt.event_id;
              return (
                <div key={key} style={{ maxWidth: "min(85%, 640px)", margin: "8px 0", padding: "12px 14px", borderRadius: 18, background: "color-mix(in srgb, var(--color-destructive) 10%, transparent)", display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span className="lb-headline" style={{ color: "var(--color-destructive)" }}>{t("statusFailed")}</span>
                    <button type="button" onClick={() => { setRetryTaskId(taskId); setRetryModalOpen(true); }} className="lb-btn lb-btn-destructive">{t("roomRetryBtn")}</button>
                  </div>
                  {evt.payload.error && <div className="lb-subhead" style={{ overflowWrap: "anywhere" }}>{evt.payload.error}</div>}
                </div>
              );
            }
            // Only a member's message is a bubble. Control events (turn.*, room.*, member.*) are Hermes's bookkeeping, signed by the
            // gateway's own id ("install:<id>", hosted_rooms.py local_authority_gateway_id): never shown as someone speaking.
            if (evt.kind !== "message.member" || !(evt.payload.text || "").trim()) return null;
            const member = members.find((m) => m.bot === evt.actor.id || m.handle === evt.actor.id || m.member_id === evt.actor.id);
            const author = member?.display_name || evt.actor.display_name || evt.actor.id;
            return (
              <div key={key} style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                <span style={{ marginBottom: 8 }}>
                  <Avatar name={author} avatar={member ? displayFace(member.bot, member.avatar ?? botOf(member.bot)?.display?.avatar) : undefined} color={colorOf(member)} size={28} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Bubble side="bot" author={author} color={botColor(colorOf(member))}><Markdown text={evt.payload.text || ""} /></Bubble>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ position: "relative", margin: "0 16px 16px" }}>
          {showMentionDropdown && mentionOptions.length > 0 && (
            <div role="listbox" aria-label={t("roomMentionsListAriaLabel")}
              style={{ position: "absolute", bottom: "100%", left: 0, width: "min(100%, 340px)", marginBottom: 6, borderRadius: 16, border: "1px solid var(--color-border)", background: "var(--color-card)", boxShadow: "0 12px 32px rgba(0,0,0,0.18)", overflow: "hidden", zIndex: 30, maxHeight: 240, overflowY: "auto" }}>
              {mentionOptions.map((opt, idx) => (
                <button key={opt.id} role="option" aria-selected={idx === mentionSelectedIndex} type="button" onClick={() => handleSelectMention(opt)}
                  className="lb-contact" style={{ minHeight: 44, borderRadius: 0, padding: "6px 12px", background: idx === mentionSelectedIndex ? "var(--lb-fill-2)" : undefined }}>
                  {opt.id === "todos"
                    ? <span aria-hidden="true" style={{ width: 24, height: 24, borderRadius: 12, background: opt.color }} />
                    : <Avatar name={opt.handle} avatar={opt.avatar} color={opt.color} size={24} />}
                  <span className="lb-body lb-truncate">{opt.label}</span>
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, padding: "6px 6px 6px 16px", borderRadius: 24, background: "var(--lb-fill)" }}>
            <textarea ref={textareaRef} aria-label={t("messageLabel")} value={inputText} onChange={handleTextChange} onKeyDown={handleKeyDown} placeholder={t("roomInputPlaceholder")} rows={1}
              className="lb-body" style={{ flex: 1, minHeight: 40, maxHeight: 160, padding: "10px 0", border: "none", outline: "none", resize: "none", background: "transparent", fieldSizing: "content" } as React.CSSProperties} />
            <button type="button" disabled={!inputText.trim() || isSending} onClick={() => void handleSendMessage(false)} className="lb-btn lb-btn-primary" style={{ minHeight: 40 }}>
              {isSending ? t("saving") : t("sendBtn")}
            </button>
          </div>
        </div>
      </section>

      <SidePanel open={membersOpen} onClose={() => setMembersOpen(false)} label={t("roomMembersBtn")}>
        <h2 className="lb-title" style={{ margin: "4px 0 12px" }}>{t("roomMembersCount", { count: members.length })}</h2>
        <ul className="lb-group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {members.map((m) => (
            <li key={m.member_id || m.bot}>
              <button type="button" onClick={() => { setInputText((p) => `${p}@${m.handle} `); setMembersOpen(false); textareaRef.current?.focus(); }}
                className="lb-contact" style={{ borderRadius: 0, padding: "8px 14px" }}>
                <Avatar name={m.display_name || m.handle} avatar={displayFace(m.bot, m.avatar ?? botOf(m.bot)?.display?.avatar)} color={colorOf(m)} size={36} />
                <span className="lb-row-stack">
                  <span className="lb-headline lb-truncate">{m.display_name || m.handle}</span>
                  <span className="lb-subhead">@{m.handle}</span>
                </span>
                {currentRoom.owner === m.handle && <span className="lb-caption">{t("roomOwnerBadge", { handle: m.handle })}</span>}
                {currentRoom.coordinator === m.handle && <span className="lb-caption">{t("roomCoordinatorBadge", { handle: m.handle })}</span>}
              </button>
            </li>
          ))}
        </ul>

        <h3 className="lb-headline" style={{ margin: "24px 4px 8px" }}>{t("roomOpenTasksTitle", { count: handoffs.length })}</h3>
        {handoffs.length === 0 ? <p className="lb-group lb-subhead" style={{ padding: "14px 16px" }}>{t("roomNoOpenTasks")}</p> : (
          <ul className="lb-group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {handoffs.map((h) => (
              <li key={h.id} className="lb-row lb-row-flat" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                <span className="lb-caption">@{h.from} → @{h.to} · {handoffStateLabel(h.state, t)}</span>
                {h.title && <span className="lb-body lb-clamp-2">{h.title}</span>}
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button type="button" onClick={() => onNavigateToKanban?.(h.task_id)} className="lb-btn lb-btn-plain">{t("roomHandoffTaskLink")}</button>
                  {(h.state === "triage" || h.state === "needs_review") && <button type="button" onClick={() => void handlePromoteHandoff(h.id)} className="lb-btn lb-btn-primary">{t("btnPromoteHandoff")}</button>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {onOpenTeamMap && <button type="button" onClick={onOpenTeamMap} className="lb-btn" style={{ marginTop: 20 }}>{t("roomTeamMapBtn")}</button>}
      </SidePanel>
      {modals}
    </div>
  );
}
