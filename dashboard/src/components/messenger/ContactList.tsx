// dashboard/src/components/messenger/ContactList.tsx
// Contacts column (spec 4.1, Grok Bot §1.4, Cue): Bots as colleagues with avatar and attention state, then rooms,
// then hidden Bots. Only real fields: no preview or time until the backend serves history (contract v0.4 B1).
// Each Bot is a toggle button (aria-pressed): the e2e picks Bots by `aside[aria-label=sidebar] button[aria-pressed]`.

import React from "react";
import type { Bot, Room } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { Avatar } from "../ui/Avatar";
import { displayFace } from "../ui/mascots";
import { AvatarStack } from "../ui/AvatarStack";
import { AttentionBadge } from "../ui/AttentionBadge";
import { attention } from "./attention";
import { PlusIcon } from "../Icons";

export interface ContactListProps {
  bots: Bot[];
  rooms?: Room[];
  loading?: boolean;
  error?: string | null;
  isOffline?: boolean;
  selectedBotName?: string | null;
  selectedRoomId?: string | null;
  pendingByBot?: Record<string, number>;  // pending approvals per Bot
  onSelectBot?: (bot: Bot) => void;
  onSelectRoom?: (room: Room) => void;
  onOpenCreate?: () => void;
  onOpenCreateRoom?: () => void;
  onRetry?: () => void;
}

const notice = (tone: string): React.CSSProperties => ({
  margin: "8px 10px", padding: "10px 12px", borderRadius: 12, fontSize: 12, display: "flex", flexDirection: "column", gap: 4,
  background: `color-mix(in srgb, ${tone} 12%, transparent)`, color: "var(--color-foreground)",
});
const linkBtn: React.CSSProperties = { alignSelf: "flex-start", minHeight: 44, border: "none", background: "none", padding: 0, color: "var(--color-primary)", textDecoration: "underline", cursor: "pointer", fontSize: 12 };

function BotRow({ bot, selected, pending, onSelect }: { bot: Bot; selected: boolean; pending: number; onSelect?: (b: Bot) => void }) {
  const { t } = useLuveI18n();
  const state = attention(bot, pending);
  const name = bot.display?.label || bot.name;
  return (
    <button type="button" aria-pressed={selected} onClick={() => onSelect?.(bot)} className="lb-contact">
      <Avatar name={name} avatar={bot.display?.avatar} color={bot.display?.color} size={40} ring={selected} attention={state} />
      <span className="lb-row-stack">
        <span className="lb-headline lb-truncate" style={{ fontWeight: state === "unread" ? 700 : 600 }}>{name}</span>
        <span className="lb-subhead lb-truncate">
          {state === "working" ? t("statusTyping") : bot.display?.role}
        </span>
      </span>
      <AttentionBadge state={state} />
    </button>
  );
}

function RoomRow({ room, selected, bots, onSelect }: { room: Room; selected: boolean; bots: Bot[]; onSelect?: (r: Room) => void }) {
  const faces = room.members.slice(0, 2);
  return (
    <button type="button" aria-current={selected || undefined} onClick={() => onSelect?.(room)} className="lb-contact">
      <span style={{ minWidth: 40, display: "inline-flex", justifyContent: "center", flexShrink: 0 }}>
        <AvatarStack size={24} max={2} ring="var(--color-card)" faces={faces.map((m) => {
          const b = bots.find((x) => x.name === m.bot);
          return { key: m.member_id || m.bot, name: m.display_name || m.handle, avatar: displayFace(m.bot, m.avatar ?? b?.display?.avatar), color: m.color ?? b?.display?.color };
        })} />
      </span>
      <span className="lb-row-stack">
        <span className="lb-headline lb-truncate">{room.name}</span>
        {room.goal && <span className="lb-subhead lb-truncate">{room.goal}</span>}
      </span>
      {room.driver.running && <AttentionBadge state="working" />}
    </button>
  );
}

export function ContactList({
  bots, rooms = [], loading = false, error = null, isOffline = false, selectedBotName = null, selectedRoomId = null,
  pendingByBot = {}, onSelectBot, onSelectRoom, onOpenCreate, onOpenCreateRoom, onRetry,
}: ContactListProps) {
  const { t } = useLuveI18n();
  const [showHidden, setShowHidden] = React.useState(false);
  const visible = bots.filter((b) => !b.display?.hidden);
  const hidden = bots.filter((b) => b.display?.hidden);
  const ready = !loading && !error;

  return (
    <div style={{ display: "flex", flexDirection: "column", padding: "0 6px 12px" }}>
      <div className="lb-section-label">
        <span>{t("sectionBots")}</span>
        <button type="button" onClick={onOpenCreate} aria-label={t("newBot")} title={t("newBot")} className="lb-icon-btn"><PlusIcon size={16} /></button>
      </div>

      {isOffline && (
        <div role="status" style={notice("var(--color-warning)")}>
          <strong>{t("offlineHeader")}</strong>
          <span style={{ color: "var(--color-muted-foreground)" }}>{t("offlineSub")}</span>
          {onRetry && <button type="button" onClick={onRetry} style={linkBtn}>{t("reconnectNow")}</button>}
        </div>
      )}
      {error && !isOffline && (
        <div role="alert" style={notice("var(--color-destructive)")}>
          <strong>{t("errorLoadingBots")}</strong>
          <span className="lb-truncate" style={{ color: "var(--color-muted-foreground)" }} title={error}>{error}</span>
          {onRetry && <button type="button" onClick={onRetry} style={linkBtn}>{t("retry")}</button>}
        </div>
      )}
      {loading && !error && (
        <div aria-busy="true" aria-label={t("loadingBots")} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {[0, 1, 2].map((k) => (
            <div key={k} className="lb-contact" style={{ cursor: "default" }}>
              <span style={{ width: 40, height: 40, borderRadius: "36%", background: "var(--color-muted)" }} />
              <span style={{ flex: 1, height: 12, borderRadius: 6, background: "var(--color-muted)" }} />
            </div>
          ))}
        </div>
      )}
      {ready && !isOffline && bots.length === 0 && (
        <div data-testid="bots-empty-state" style={{ padding: "6px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="lb-subhead">{t("emptyBots")}</span>
          {onOpenCreate && (
            <button type="button" onClick={onOpenCreate} style={{ ...linkBtn, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600 }}>
              <PlusIcon size={12} /><span>{t("createFirstBot")}</span>
            </button>
          )}
        </div>
      )}
      {ready && visible.map((bot) => (
        <BotRow key={bot.name} bot={bot} selected={selectedBotName === bot.name} pending={pendingByBot[bot.name] ?? 0} onSelect={onSelectBot} />
      ))}

      <div className="lb-section-label">
        <span>{t("sectionSalas")}</span>
        <button type="button" onClick={onOpenCreateRoom} aria-label={t("newSala")} title={t("newSala")} className="lb-icon-btn"><PlusIcon size={16} /></button>
      </div>
      {rooms.length === 0
        ? <span className="lb-subhead" style={{ padding: "6px 10px" }}>{t("emptySalas")}</span>
        : rooms.map((room) => (
          <RoomRow key={room.id} room={room} bots={bots} selected={selectedRoomId === room.id && !selectedBotName} onSelect={onSelectRoom} />
        ))}

      {ready && hidden.length > 0 && (
        <>
          <button type="button" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}
            className="lb-section-label" style={{ border: "none", background: "none", cursor: "pointer", width: "100%", minHeight: 44 }}>
            <span>{t("sectionOcultos")} ({hidden.length})</span>
          </button>
          {showHidden && hidden.map((bot) => (
            <BotRow key={bot.name} bot={bot} selected={selectedBotName === bot.name} pending={pendingByBot[bot.name] ?? 0} onSelect={onSelectBot} />
          ))}
        </>
      )}
    </div>
  );
}
