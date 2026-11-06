// dashboard/src/components/messenger/ContactList.tsx
// Contacts column (spec 4.1, Grok Bot §1.4, Cue): Bots as colleagues with avatar and attention state, then rooms,
// then hidden Bots. Only real fields: no preview or time until the backend serves history (contract v0.4 B1).
// Each Bot is a toggle button (aria-pressed): the e2e picks Bots by `aside[aria-label=sidebar] button[aria-pressed]`.

import React from "react";
import type { Bot, Room } from "../../api/types";
import { setBotsOrder, updateBotDisplay } from "../../api/client";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { FreeChip } from "../agent/FreeChip";
import { MessageMenu, type MessageMenuItem } from "../conversation/MessageMenu";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";
import { Avatar } from "../ui/Avatar";
import { displayFace } from "../ui/mascots";
import { AvatarStack } from "../ui/AvatarStack";
import { AttentionBadge } from "../ui/AttentionBadge";
import { attention } from "./attention";
import { PlusIcon, PinIcon } from "../Icons";

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
  onBotsChanged?: () => void;  // pin, order or hide was saved: the list is read again (the order is the server's)
}

const byPosition = (list: Bot[]) => list
  .map((b, i) => ({ b, i }))
  .sort((x, y) => (x.b.display?.position ?? Infinity) - (y.b.display?.position ?? Infinity) || x.i - y.i)
  .map((x) => x.b);

/** Contract v0.8 section 9: pinned in order, then the rest in order, then the hidden ones (in order too). A Bot never ordered
 *  keeps the server's place after the ordered ones. */
export function sidebarGroups(bots: Bot[]): { pinned: Bot[]; rest: Bot[]; hidden: Bot[] } {
  const sorted = byPosition(bots);
  return {
    pinned: sorted.filter((b) => !b.display?.hidden && b.display?.pinned),
    rest: sorted.filter((b) => !b.display?.hidden && !b.display?.pinned),
    hidden: sorted.filter((b) => b.display?.hidden),
  };
}

/** The whole order with `name` moved to `to` inside its own group (drag, or "Mover para cima/baixo"). */
export function reorder(groups: { pinned: Bot[]; rest: Bot[]; hidden: Bot[] }, name: string, to: number): string[] {
  const lists = [groups.pinned, groups.rest, groups.hidden].map((g) => g.map((b) => b.name));
  const list = lists.find((g) => g.includes(name));
  if (list) {
    list.splice(list.indexOf(name), 1);
    list.splice(Math.max(0, Math.min(to, list.length)), 0, name);
  }
  return lists.flat();
}

const notice = (tone: string): React.CSSProperties => ({
  margin: "8px 10px", padding: "10px 12px", borderRadius: 12, fontSize: 12, display: "flex", flexDirection: "column", gap: 4,
  background: `color-mix(in srgb, ${tone} 12%, transparent)`, color: "var(--color-foreground)",
});
const linkBtn: React.CSSProperties = { alignSelf: "flex-start", minHeight: 44, border: "none", background: "none", padding: 0, color: "var(--color-primary)", textDecoration: "underline", cursor: "pointer", fontSize: 12 };

// why a waiting Bot needs the person (contract v0.9 §1.8): no reason = an approval, which keeps the Bot's role line
const REASON: Record<string, TranslationKey> = { question: "botReasonQuestion", input: "botReasonInput", run_unknown: "botReasonUnknown" };

function BotRow({ bot, selected, pending, onSelect, menu, drag }: {
  bot: Bot; selected: boolean; pending: number; onSelect?: (b: Bot) => void; menu?: MessageMenuItem[];
  drag?: { onStart: () => void; onOver: (e: React.DragEvent) => void; onDrop: () => void; onEnd: () => void } }) {
  const { t } = useLuveI18n();
  const state = attention(bot, pending);
  const reason = bot.status === "waiting_approval" ? REASON[bot.status_reason ?? ""] : undefined;
  const name = bot.display?.label || bot.name;
  const row = (
    <button type="button" aria-pressed={selected} onClick={() => onSelect?.(bot)} className="lb-contact"
      draggable={!!drag} onDragStart={drag ? (e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", bot.name); drag.onStart(); } : undefined}
      onDragOver={drag?.onOver} onDrop={drag ? (e) => { e.preventDefault(); drag.onDrop(); } : undefined} onDragEnd={drag?.onEnd}>
      <Avatar name={name} avatar={bot.display?.avatar} color={bot.display?.color} size={40} ring={selected} attention={state} />
      <span className="lb-row-stack">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          <span className="lb-headline lb-truncate" style={{ fontWeight: state === "unread" ? 700 : 600 }}>{name}</span>
          {bot.approval_mode === "free" ? <FreeChip /> : bot.approval_unknown ? <FreeChip unknown /> : null}
          {bot.display?.pinned && !bot.display?.hidden && <span role="img" aria-label={t("botPinned")} title={t("botPinned")} style={{ display: "inline-flex", color: "var(--color-muted-foreground)", flexShrink: 0 }}><PinIcon size={12} /></span>}
        </span>
        <span className="lb-subhead lb-truncate">
          {state === "working" ? t("statusTyping") : reason ? t(reason) : bot.display?.role}
        </span>
      </span>
      <AttentionBadge state={state} />
    </button>
  );
  if (!menu) return row;
  return (
    <MessageMenu items={menu} label={t("botMenu", { name })} menuStyle={{ top: "calc(100% + 4px)", bottom: "auto", left: "auto", right: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}>{row}</div>
    </MessageMenu>
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
  pendingByBot = {}, onSelectBot, onSelectRoom, onOpenCreate, onOpenCreateRoom, onRetry, onBotsChanged,
}: ContactListProps) {
  const { t } = useLuveI18n();
  const [showHidden, setShowHidden] = React.useState(false);
  const groups = sidebarGroups(bots);
  const hidden = groups.hidden;
  const ready = !loading && !error;
  const [saveError, setSaveError] = React.useState<ErrorState | null>(null);
  const busy = React.useRef(false);
  const dragged = React.useRef<string | null>(null);

  // Every change is the server's: saved, then the list is read again (nothing moves on screen before the server has it).
  async function save(work: () => Promise<unknown>) {
    if (busy.current) return;
    busy.current = true;
    setSaveError(null);
    try {
      await work();
      onBotsChanged?.();
    } catch (e) {
      setSaveError(humanError(e, t, "botsOrderError"));
    } finally {
      busy.current = false;
    }
  }
  const move = (name: string, to: number) => void save(() => setBotsOrder(reorder(groups, name, to)));
  const editable = !!onBotsChanged;

  const menuOf = (bot: Bot, group: Bot[]): MessageMenuItem[] | undefined => {
    if (!editable) return undefined;
    const at = group.indexOf(bot);
    const pinned = !!bot.display?.pinned, isHidden = !!bot.display?.hidden;
    return [
      ...(!isHidden ? [pinned
        ? { label: t("botUnpin"), hint: t("botUnpinHint"), onSelect: () => void save(() => updateBotDisplay(bot.name, { pinned: false })) }
        : { label: t("botPin"), hint: t("botPinHint"), onSelect: () => void save(() => updateBotDisplay(bot.name, { pinned: true })) }] : []),
      ...(at > 0 ? [{ label: t("botMoveUp"), hint: t("botMoveHint"), onSelect: () => move(bot.name, at - 1) }] : []),
      ...(at < group.length - 1 ? [{ label: t("botMoveDown"), hint: t("botMoveHint"), onSelect: () => move(bot.name, at + 1) }] : []),
      isHidden
        ? { label: t("botShow"), hint: t("botShowHint"), onSelect: () => void save(() => updateBotDisplay(bot.name, { hidden: false })) }
        : { label: t("botHide"), hint: t("botHideHint"), onSelect: () => void save(() => updateBotDisplay(bot.name, { hidden: true })) },
    ];
  };
  // PC: drag a Bot onto another of the SAME group to take its place (the phone and the keyboard use the menu).
  const dragOf = (bot: Bot, group: Bot[]) => !editable ? undefined : {
    onStart: () => { dragged.current = bot.name; },
    onOver: (e: React.DragEvent) => { const from = dragged.current; if (from && from !== bot.name && group.some((b) => b.name === from)) e.preventDefault(); },
    onDrop: () => { const from = dragged.current; dragged.current = null; if (from && from !== bot.name && group.some((b) => b.name === from)) move(from, group.indexOf(bot)); },
    onEnd: () => { dragged.current = null; },
  };
  const rowOf = (bot: Bot, group: Bot[]) => (
    <BotRow key={bot.name} bot={bot} selected={selectedBotName === bot.name} pending={pendingByBot[bot.name] ?? 0} onSelect={onSelectBot}
      menu={menuOf(bot, group)} drag={dragOf(bot, group)} />
  );

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
      {saveError && <div role="alert" style={notice("var(--color-destructive)")}><ErrorNote error={saveError} /></div>}
      {ready && groups.pinned.map((bot) => rowOf(bot, groups.pinned))}
      {ready && groups.rest.map((bot) => rowOf(bot, groups.rest))}

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
          {showHidden && hidden.map((bot) => rowOf(bot, hidden))}
        </>
      )}
    </div>
  );
}
