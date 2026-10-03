// dashboard/src/components/messenger/MessengerShell.tsx
// The messenger shell (brief §2.1, plan §3.1): a narrow rail, the contacts column, and the open conversation.
// No menu of dashboard pages: Rotinas, Regras, Custos and Mapa live in the Bot's profile, in rooms and in
// Settings, and stay reachable through ⌘K. On a phone it is a stack: contacts first, then the conversation with
// a back button, and the rail becomes a bottom bar. Nothing here pretends to act: no pause or spend without a route.

import React from "react";
import { Wordmark } from "../ui/Wordmark";
import type { Bot, Room } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { useNarrow } from "../../hooks/useNarrow";
import { ContactList } from "./ContactList";
import { shortcutFor, isEditable, botAt } from "./shortcuts";
import { SunIcon, CheckCircleIcon, ClockIcon, NetworkIcon, SearchIcon, SettingsIcon, ArrowRightIcon, ExitIcon } from "../Icons";
import { useScheme, navigateHost } from "../../hooks/useHost";
import { PhoneBarContext, type PhoneBar } from "./phoneBar";
import { ThemePicker } from "../ui/ThemePicker";

export interface MessengerShellProps {
  children?: React.ReactNode;
  bots?: Bot[];
  botsLoading?: boolean;
  botsError?: string | null;
  isOffline?: boolean;
  selectedBotName?: string | null;
  onSelectBot?: (bot: Bot) => void;
  onOpenCreateBot?: () => void;
  onRetryBots?: () => void;
  rooms?: Room[];
  selectedRoomId?: string | null;
  onSelectRoom?: (room: Room) => void;
  onOpenCreateRoom?: () => void;
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  approvalsCount?: number;
  pendingByBot?: Record<string, number>;
  onOpenSearch?: () => void;
  onBack?: () => void;  // phone: leave the open conversation for the contact list
  modals?: React.ReactNode;  // always mounted, whichever column shows (a phone shows the list OR the screen)
  /** /health says the dashboard runs an older LuveBot than the one on disk (plugin_restart_required). */
  restartRequired?: boolean;
}

type RailItem = { id: string; label: string; icon: React.ComponentType<{ size?: number }>; badge?: number };

export function MessengerShell({
  children, bots = [], botsLoading = false, botsError = null, isOffline = false, selectedBotName = null,
  onSelectBot, onOpenCreateBot, onRetryBots, rooms = [], selectedRoomId = null, onSelectRoom, onOpenCreateRoom,
  activeTab: controlledTab, onTabChange, approvalsCount, pendingByBot, onOpenSearch, onBack, modals, restartRequired = false,
}: MessengerShellProps) {
  const { locale, t, setLocale } = useLuveI18n();
  const narrow = useNarrow();
  const { scheme, pref, setPref } = useScheme();
  const [ownTab, setOwnTab] = React.useState("hoje");
  const [phoneMain, setPhoneMain] = React.useState(false);
  const activeTab = controlledTab ?? ownTab;

  const [sidebarHidden, setSidebarHidden] = React.useState(false);
  const [barClaims, setBarClaims] = React.useState(0);  // screens that took the phone strip into their own header
  const claimBar = React.useCallback(() => { setBarClaims((n) => n + 1); return () => setBarClaims((n) => n - 1); }, []);  // ⌘B, desktop only
  const goTab = (id: string) => { onTabChange ? onTabChange(id) : setOwnTab(id); setPhoneMain(true); };

  // Spec §8 shortcuts. The handler reads the latest props through a ref, so it is registered once.
  const latest = React.useRef({ bots, selectedBotName, onSelectBot, onOpenCreateBot, onOpenCreateRoom, onOpenSearch, goTab, narrow });
  latest.current = { bots, selectedBotName, onSelectBot, onOpenCreateBot, onOpenCreateRoom, onOpenSearch, goTab, narrow };
  const gArmedAt = React.useRef<number | null>(null);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const now = Date.now();
      const a = shortcutFor({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, editable: isEditable(document.activeElement) }, gArmedAt.current, now);
      if (!["Shift", "Meta", "Control", "Alt"].includes(e.key)) gArmedAt.current = a?.type === "armG" ? now : null;
      if (!a) return;
      const L = latest.current;
      const run = (f?: () => void) => { if (f) { e.preventDefault(); f(); } };
      switch (a.type) {
        case "search": return run(L.onOpenSearch);
        case "newBot": return run(L.onOpenCreateBot);
        case "newRoom": return run(L.onOpenCreateRoom);
        case "toggleSidebar": return run(L.narrow ? undefined : () => setSidebarHidden((h) => !h));
        case "composer": {
          const box = document.querySelector<HTMLTextAreaElement>("main form textarea"); // the conversation's one composer
          return run(box ? () => box.focus() : undefined);
        }
        case "bot": case "step": {
          const target = botAt(L.bots.filter((b) => !b.display?.hidden), L.selectedBotName, a);
          const select = L.onSelectBot;
          return run(target && select ? () => select(target) : undefined);
        }
        case "approvals": return run(() => L.goTab("aprovacoes"));
        case "armG": return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const items: RailItem[] = [
    { id: "hoje", label: t("navHoje"), icon: SunIcon },
    { id: "aprovacoes", label: t("navAprovacoes"), icon: CheckCircleIcon, badge: approvalsCount },
    { id: "atividade", label: t("navAtividade"), icon: ClockIcon },
    { id: "mapa", label: t("navMapa"), icon: NetworkIcon },  // the CEO did not find it in ⌘K alone: a fixed place (⌘K keeps it too)
  ];
  const inConversation = !!(selectedBotName || selectedRoomId);
  const showMain = !narrow || inConversation || phoneMain;
  const showList = !narrow || !showMain;

  // Desktop: an icon rail with names for screen readers and a tooltip (Dots). Phone: a tab bar with 11 px labels (HIG).
  const railButton = (key: string, label: string, Icon: RailItem["icon"], active: boolean, onClick: () => void, badge?: number, extra: Record<string, string> = {}) => (
    <button key={key} type="button" className="lb-rail-btn" aria-current={active ? "page" : undefined} onClick={onClick} {...extra}
      aria-label={narrow ? undefined : badge ? `${label} (${badge})` : label} title={narrow ? undefined : label}>
      <Icon size={20} />
      {narrow && <span>{label}</span>}
      {badge !== undefined && badge > 0 && (
        <span aria-hidden={narrow ? undefined : "true"} style={{ position: "absolute", top: 2, right: narrow ? 8 : 2, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, font: "600 12px/16px var(--lb-font)", background: "var(--color-destructive)", color: "var(--color-destructive-foreground)" }}>
          {badge}
        </span>
      )}
    </button>
  );
  const tabButton = (it: RailItem) => railButton(it.id, it.label, it.icon, activeTab === it.id && !inConversation, () => goTab(it.id), it.badge);
  const searchBtn = railButton("search", t("navSearch"), SearchIcon, false, () => onOpenSearch?.(), undefined, { "aria-keyshortcuts": "Meta+K Control+K" });
  // The way back to the Hermes pages (the frame is hidden here). A real link, so a new tab works too.
  const hermesLink = (
    <a href={"/sessions" + (typeof window === "undefined" ? "" : window.location.search)} className={narrow ? "lb-host-btn" : "lb-rail-btn"}
      aria-label={narrow ? undefined : t("hermesPanel")} title={narrow ? undefined : t("hermesPanel")}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigateHost("/sessions"); }}>
      <ExitIcon size={20} />
      {narrow && <span>{t("hermesPanel")}</span>}
    </a>
  );
  // Phone: "back" and the Hermes link, in the shell's strip or, for a screen with its own header, inside that header.
  const backBtn = (
    <button type="button" aria-label={t("backToList")} onClick={() => { setPhoneMain(false); onBack?.(); }}
      style={{ minWidth: 44, minHeight: 44, border: "none", background: "none", color: "var(--color-foreground)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", transform: "scaleX(-1)", flexShrink: 0 }}>
      <ArrowRightIcon size={20} />
    </button>
  );
  const hermesIcon = (
    <a href={"/sessions" + (typeof window === "undefined" ? "" : window.location.search)} className="lb-icon-btn" aria-label={t("hermesPanel")} title={t("hermesPanel")}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigateHost("/sessions"); }}>
      <ExitIcon size={20} />
    </a>
  );
  const phoneBar: PhoneBar | null = narrow ? { back: backBtn, hermes: hermesIcon, claim: claimBar } : null;
  const settingsBtn = railButton("config", t("navConfig"), SettingsIcon, activeTab === "config" && !inConversation, () => goTab("config"));

  const rail = narrow ? (
    <nav aria-label={t("navSectionMain")} className="lb-tabbar" style={{ display: "flex", justifyContent: "space-around", borderTop: "1px solid var(--lb-separator)", background: "var(--color-card)", padding: "4px 4px calc(4px + env(safe-area-inset-bottom))" }}>
      {items.map(tabButton)}{searchBtn}{settingsBtn}
    </nav>
  ) : (
    <nav aria-label={t("navSectionMain")} style={{ width: 64, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "14px 0", borderRight: "1px solid var(--lb-separator)", background: "var(--color-card)" }}>
      {items.map(tabButton)}{searchBtn}
      <div style={{ flex: 1 }} />
      {hermesLink}
      <ThemePicker pref={pref} onChange={setPref} className="lb-rail-btn" />
      {settingsBtn}
      <button type="button" className="lb-rail-btn" onClick={() => setLocale(locale === "pt" ? "en" : "pt")} aria-label={t("toggleLanguage")} title={locale === "pt" ? t("langEnglish") : t("langPortuguese")}
        style={{ font: "600 12px/16px var(--lb-font)" }}>{locale.toUpperCase()}</button>
    </nav>
  );

  return (
    <div className="lb-root" data-lb-scheme={scheme} style={{ display: "flex", flexDirection: narrow ? "column" : "row", width: "100%", overflow: "hidden", background: "var(--color-background)", color: "var(--color-foreground)" }}>
      {!narrow && rail}
      {showList && !(sidebarHidden && !narrow) && (
        <aside aria-label="sidebar" style={{ width: narrow ? "100%" : 300, flex: narrow ? 1 : undefined, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", borderRight: narrow ? undefined : "1px solid var(--lb-separator)", background: "var(--color-card)" }}>
          <div style={{ padding: "16px 16px 6px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Wordmark scheme={scheme} />
            {narrow && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><ThemePicker pref={pref} onChange={setPref} className="lb-icon-btn" placement="below" />{hermesLink}</span>}
          </div>
          {restartRequired && !showMain && <RestartNotice />}
          <div className="luvebot-scroll-container" style={{ flex: 1, minHeight: 0 }}>
            <ContactList
              bots={bots} rooms={rooms} loading={botsLoading} error={botsError} isOffline={isOffline}
              selectedBotName={selectedBotName} selectedRoomId={selectedRoomId} pendingByBot={pendingByBot}
              onSelectBot={onSelectBot} onSelectRoom={onSelectRoom} onOpenCreate={onOpenCreateBot} onOpenCreateRoom={onOpenCreateRoom} onRetry={onRetryBots}
            />
          </div>
        </aside>
      )}
      {showMain && (
        <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--color-background)" }}>
          {narrow && barClaims === 0 && (
            <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--color-border)" }}>
              {backBtn}
              <span style={{ flex: 1 }} />
              {hermesLink}
            </div>
          )}
          {restartRequired && <RestartNotice />}
          {isOffline && (
            <div role="status" data-testid="pwa-offline-notice" style={{ padding: "10px 16px", fontSize: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", background: "color-mix(in srgb, var(--color-warning) 12%, transparent)" }}>
              <strong>{t("pwaOfflineNoticeHeader")}:</strong>
              <span>{t("pwaOfflineNoticeBody")}</span>
              {onRetryBots && <button type="button" onClick={onRetryBots} style={{ minHeight: 44, border: "none", background: "none", textDecoration: "underline", color: "inherit", cursor: "pointer" }}>{t("reconnectNow")}</button>}
            </div>
          )}
          <PhoneBarContext.Provider value={phoneBar}>
            <div className="luvebot-scroll-container" style={{ flex: 1, minHeight: 0 }}>{children}</div>
          </PhoneBarContext.Provider>
        </main>
      )}
      {narrow && !inConversation && rail}
      {modals}
    </div>
  );
}

/** Discreet and kept while /health reports it: the new LuveBot is on disk, the dashboard still runs the old one. */
function RestartNotice() {
  const { t } = useLuveI18n();
  return (
    <div role="status" data-testid="restart-notice" className="lb-caption"
      style={{ padding: "8px 16px", display: "flex", gap: 8, alignItems: "center", color: "var(--color-foreground)", background: "color-mix(in srgb, var(--color-primary) 10%, transparent)", borderBottom: "1px solid var(--lb-separator)" }}>
      {t("restartNotice")}
    </div>
  );
}
