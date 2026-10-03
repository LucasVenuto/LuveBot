// dashboard/src/index.tsx
// Entry point for LuveBot Hermes Dashboard Plugin.
// Registers the plugin component via window.__HERMES_PLUGINS__.register('luvebot', Component).

import React, { useState, useEffect, useCallback } from "react";
import type { Bot, Room } from "./api/types";
import { getBots, getApprovals, getRooms, getHealth } from "./api/client";
import { MessengerShell } from "./components/messenger/MessengerShell";
import { Hoje } from "./components/Hoje";
import { BotProfile, BotCreateModal } from "./components/bots";
import { Conversation } from "./components/conversation";
import { AgentPanel, type AgentPage } from "./components/agent/AgentPanel";
import { SidePanel } from "./components/ui/SidePanel";
import { ApprovalsInbox } from "./components/approvals";
import { RulesView } from "./components/rules";
import { SettingsView } from "./components/settings/SettingsView";
import { stopActivity, testRoutine } from "./api/client";
import { CostsView } from "./components/costs";
import { RoutinesView } from "./components/routines";
import { ActivityView } from "./components/activity";
import { RoomsView, CreateRoomModal as CreateSalaModal } from "./components/rooms";
import { TeamMapView } from "./components/map";
import { CommandPaletteModal } from "./components/search";
import { PagesScreen, PageView } from "./components/pages";
import { registerPwa } from "./pwa";
import { getPluginRegistry } from "./sdk";
import { withDisplayName } from "./lib/botName";
import { withDefaultFace } from "./components/ui/mascots";
import { useLiveRefresh } from "./hooks/useLiveRefresh";
import { useCues, readSoundPref } from "./sound/cues";
import { navigateHost } from "./hooks/useHost";
import { LuveBotRoute, LuveBotOverlay } from "./host/overlay";
import { useLuveI18n } from "./i18n";
import type { ListStatus } from "./components/ui/ListState";
import { humanError, ErrorNote, type ErrorState } from "./components/ui/ErrorNote";

export function LuveBotApp() {
  const { t } = useLuveI18n();
  const [activeTab, setActiveTab] = useState<string>("hoje");
  const [bots, setBots] = useState<Bot[]>([]);
  const [botsLoading, setBotsLoading] = useState<boolean>(true);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [botsLoaded, setBotsLoaded] = useState(false);  // a list came back at least once: only then may a screen say "no Bot"
  const [isOffline, setIsOffline] = useState<boolean>(false);
  const [selectedBotName, setSelectedBotName] = useState<string | null>(null);
  const [createBotModalOpen, setCreateBotModalOpen] = useState<boolean>(false);
  const [botPage, setBotPage] = useState<AgentPage | null>(null);  // a full screen of the selected Bot instead of its conversation
  const [profileOpen, setProfileOpen] = useState<boolean>(false);
  // Pages (contract v0.5) belong to one Bot: each piece of state carries it and only shows for that Bot.
  const [pageOpen, setPageOpen] = useState<{ bot: string; slug: string } | null>(null);   // beside the conversation
  const [pagesSlug, setPagesSlug] = useState<{ bot: string; slug: string } | null>(null); // in the Pages screen
  const [askOn, setAskOn] = useState<{ bot: string; slug: string; title: string } | null>(null);
  const [liveRevs, setLiveRevs] = useState<Record<string, number>>({});  // newest revision the Bot wrote, per bot:slug
  const [activityView, setActivityView] = useState<"list" | "kanban">("list");  // a handoff's Kanban link opens the board  // the Bot's profile panel beside the conversation
  const [approvalsCount, setApprovalsCount] = useState<number>(0);
  const [pendingByBot, setPendingByBot] = useState<Record<string, number>>({});
  const [approvalsLoaded, setApprovalsLoaded] = useState(false);

  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [createRoomModalOpen, setCreateRoomModalOpen] = useState<boolean>(false);
  const [searchModalOpen, setSearchModalOpen] = useState<boolean>(false);

  // `quiet`: a background refresh (useLiveRefresh, end of a turn) keeps the list on screen, no skeleton, and a failed
  // refresh keeps the last list rather than replacing it with an error.
  const loadBots = useCallback(async (quiet = false) => {
    try {
      if (!quiet) {
        setBotsLoading(true);
        setBotsError(null);
      }
      const data = await getBots();
      setIsOffline(false);
      setBots((data?.bots || []).map((b) => withDefaultFace(withDisplayName(b))));
      setBotsLoaded(true);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "hermes_unreachable") {
        setIsOffline(true);
      } else if (!quiet) {
        const msg = humanError(err, t, "errorLoadingBots");
        setBotsError(msg.text);
      }
    } finally {
      if (!quiet) setBotsLoading(false);
    }
  }, []);

  // ui/ListState: loading until the first answer; a failed first load (error or Hermes unreachable) is an error, never empty.
  const botsStatus: ListStatus = botsLoading ? "loading" : botsLoaded ? "ready" : "error";
  const retryBots = () => void loadBots();

  const loadApprovalsCount = useCallback(async () => {
    try {
      const res = await getApprovals();
      const pending = (res?.approvals || []).filter((a) => a.status === "pending");
      setApprovalsCount(pending.length);
      const byBot: Record<string, number> = {};
      for (const a of pending) byBot[a.bot] = (byBot[a.bot] ?? 0) + 1;
      setPendingByBot(byBot);
      setApprovalsLoaded(true);
    } catch {
      // Backend route might not exist yet; fail gracefully
    }
  }, []);

  const loadRooms = useCallback(async () => {
    try {
      const res = await getRooms();
      setRooms(res?.rooms || []);
    } catch {
      // Fail gracefully
    }
  }, []);

  useEffect(() => {
    void registerPwa();
    loadBots();
    loadApprovalsCount();
    loadRooms();
  }, [loadBots, loadApprovalsCount, loadRooms]);

  // Bot states and the pending-approval "!" stay current: every 15 s with the tab visible, and when a turn starts or ends.
  const refreshLive = useCallback(() => { void loadBots(true); void loadApprovalsCount(); void loadRooms(); }, [loadBots, loadApprovalsCount, loadRooms]);
  useLiveRefresh(refreshLive, undefined, () => readSoundPref() !== "off");
  // /health tells when the dashboard still runs an older LuveBot than the one on disk: a discreet notice while it lasts.
  // On load and once a minute with the tab visible; a failed read keeps what was known.
  const [restartRequired, setRestartRequired] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      getHealth().then((h) => { if (alive) setRestartRequired(h?.plugin?.code_current === false || (h?.problems ?? []).some((p) => p.code === "plugin_restart_required")); }, () => {});
    };
    check();
    const id = window.setInterval(check, 60_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);  // a hidden tab keeps listening only for the sounds
  // Sounds (sound/cues.ts): from what is refreshed above, only once each has loaded; the open conversation counts as looking.
  useCues(botsLoaded ? bots : null, approvalsLoaded ? pendingByBot : null, selectedBotName && !botPage ? selectedBotName : null);

  const selectedBot = bots.find((b) => b.name === selectedBotName);
  const panelPage = pageOpen && pageOpen.bot === selectedBotName ? pageOpen.slug : null;
  const askAbout = askOn && askOn.bot === selectedBotName ? { slug: askOn.slug, title: askOn.title } : null;
  const setPanelPage = (slug: string | null) => setPageOpen(slug && selectedBotName ? { bot: selectedBotName, slug } : null);
  const setAskAbout = (a: { slug: string; title: string } | null) => setAskOn(a && selectedBotName ? { bot: selectedBotName, ...a } : null);

  const openBotPage = (page: AgentPage) => {
    if (page === "costs") {
      setActiveTab("custos");
      setSelectedBotName(null);
      setBotPage(null);
    } else setBotPage(page);
  };

  const handleSelectBot = (bot: Bot) => {
    setProfileOpen(false);
    setSelectedBotName(bot.name);
    setBotPage(null);
  };

  const handleBotCreated = (newBot: Bot) => {
    setBots((prev) => [newBot, ...prev.filter((b) => b.name !== newBot.name)]);
    setSelectedBotName(newBot.name);
    setBotPage(null);
    setCreateBotModalOpen(false);
  };

  // Dialogs live outside the screen area: on a phone the list replaces the screen, and a dialog opened from the list
  // ("Nova sala", "Novo Bot", ⌘K) must still mount.
  const modals = (
    <>
      {/* Bot Creation Modal */}
      <BotCreateModal
        isOpen={createBotModalOpen}
        onClose={() => setCreateBotModalOpen(false)}
        onBotCreated={handleBotCreated}
      />

      {/* Sala Creation Modal */}
      <CreateSalaModal
        botsStatus={botsStatus}
        onRetryBots={retryBots}
        isOpen={createRoomModalOpen}
        onClose={() => setCreateRoomModalOpen(false)}
        availableBots={bots}
        onRoomCreated={(newRoom) => {
          setRooms((prev) => [newRoom, ...prev.filter((r) => r.id !== newRoom.id)]);
          void loadRooms();  // the server's list is the truth (members, order)
          setSelectedRoomId(newRoom.id);
          setSelectedBotName(null);
          setBotPage(null);
          setCreateRoomModalOpen(false);
        }}
      />

      {/* ⌘K Command Palette & Search Modal */}
      <CommandPaletteModal
        botsStatus={botsStatus}
        onRetryBots={retryBots}
        isOpen={searchModalOpen}
        onClose={() => setSearchModalOpen(false)}
        availableBots={bots}
        availableRooms={rooms}
        onNavigateTab={(tab) => {
          setActiveTab(tab);
          setSelectedBotName(null);
          setSelectedRoomId(null);
          setBotPage(null);
        }}
        onSelectBot={(name) => {
          setSelectedBotName(name);
          setSelectedRoomId(null);
          setBotPage(null);
        }}
        onSelectRoom={(roomId) => {
          setSelectedRoomId(roomId);
          setSelectedBotName(null);
          setBotPage(null);
        }}
        onOpenCreateBot={() => setCreateBotModalOpen(true)}
        onOpenCreateRoom={() => setCreateRoomModalOpen(true)}
        onSelectPage={(name, slug) => {
          setSelectedBotName(name);
          setSelectedRoomId(null);
          setBotPage(null);
          setProfileOpen(false);
          setPageOpen({ bot: name, slug });
        }}
      />
    </>
  );

  return (
    <MessengerShell
      modals={modals}
      bots={bots}
      botsLoading={botsLoading}
      botsError={botsError}
      isOffline={isOffline}
      selectedBotName={selectedBotName}
      onSelectBot={handleSelectBot}
      onOpenCreateBot={() => setCreateBotModalOpen(true)}
      onRetryBots={() => void loadBots()}
      restartRequired={restartRequired}
      rooms={rooms}
      selectedRoomId={selectedRoomId}
      onSelectRoom={(room) => {
        setSelectedRoomId(room.id);
        setSelectedBotName(null);
        setBotPage(null);
      }}
      onOpenCreateRoom={() => setCreateRoomModalOpen(true)}
      activeTab={activeTab}
      approvalsCount={approvalsCount}
      pendingByBot={pendingByBot}
      onOpenSearch={() => setSearchModalOpen(true)}
      onBack={() => {
        setSelectedBotName(null);
        setSelectedRoomId(null);
        setBotPage(null);
      }}
      onTabChange={(tab) => {
        setActiveTab(tab);
        setSelectedBotName(null);
        setSelectedRoomId(null);
      }}
    >
      {selectedRoomId && !selectedBotName ? (
        <RoomsView
          roomId={selectedRoomId}
          availableBots={bots}
          onSelectRoom={(room) => {
            setSelectedRoomId(room.id);
            // a room created inside the room view arrives here too: list it at once, then take the server's list
            setRooms((prev) => (prev.some((r) => r.id === room.id) ? prev : [room, ...prev]));
            void loadRooms();
          }}
          onNavigateToKanban={() => {
            setActiveTab("atividade");
            setActivityView("kanban");
            setSelectedRoomId(null);
          }}
          onOpenTeamMap={() => {
            setActiveTab("mapa");
            setSelectedRoomId(null);
          }}
        />
      ) : selectedBotName && !botPage ? (
        // key: a new Bot starts a new conversation
        <Conversation key={selectedBotName} onActivityChange={refreshLive} onCloseSidePanel={() => { setProfileOpen(false); setPanelPage(null); }} onOpenProfile={() => { setPanelPage(null); setProfileOpen(true); }} bot={{ name: selectedBotName, ...selectedBot?.display }}
          onOpenPage={(slug) => { setProfileOpen(false); setPanelPage(slug); }}
          onOpenPages={() => { setProfileOpen(false); openBotPage("pages"); }}
          onPageUpdated={(u) => setLiveRevs((m) => ({ ...m, [`${selectedBotName}:${u.slug}`]: u.rev }))}
          askAbout={askAbout} onClearAsk={() => setAskAbout(null)}
          panel={panelPage && selectedBot ? (
            <SidePanel open onClose={() => setPanelPage(null)} label={t("pageOfBot", { name: selectedBot.display?.label || selectedBot.name })}>
              <PageView key={panelPage} bot={{ name: selectedBot.name, label: selectedBot.display?.label, avatar: selectedBot.display?.avatar, color: selectedBot.display?.color }}
                slug={panelPage} liveRev={liveRevs[`${selectedBot.name}:${panelPage}`]}
                onAsk={(page) => setAskAbout({ slug: page.slug, title: page.title })} />
            </SidePanel>
          ) : profileOpen && selectedBot ? (
            <SidePanel open onClose={() => setProfileOpen(false)} label={t("agentPanelLabel", { name: selectedBot.display?.label || selectedBot.name })}>
              <AgentPanel bot={selectedBot} pendingApprovals={pendingByBot[selectedBot.name]} onOpenPage={openBotPage} onChanged={() => void loadBots()}
                onOpenPageSlug={(slug) => { setProfileOpen(false); setPanelPage(slug); }} />
            </SidePanel>
          ) : undefined} />
      ) : selectedBotName ? (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--color-border)" }}>
            <button type="button" onClick={() => setBotPage(null)} style={{ minHeight: 44, border: "none", background: "none", color: "var(--color-primary)", cursor: "pointer", fontSize: 14, fontWeight: 600 }}>
              ‹ {t("backToConversation")}
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            {botPage === "pages" && selectedBot ? <PagesScreen key={selectedBot.name} bot={selectedBot} initialSlug={pagesSlug?.bot === selectedBot.name ? pagesSlug.slug : null}
                onAsk={(page) => { setBotPage(null); setPagesSlug(null); setAskAbout({ slug: page.slug, title: page.title }); }} />
              : botPage === "rules" ? <RulesView botName={selectedBotName} bots={bots} />
              : botPage === "routines" ? <RoutinesView botName={selectedBotName} bots={bots} />
              : <BotProfile
                  botName={selectedBotName}
                  onClose={() => setBotPage(null)}
                  onBotUpdated={(updated) => {
                    setBots((prev) =>
                      prev.map((b) => (b.name === updated.name ? withDefaultFace(withDisplayName({ ...b, ...updated })) : b))
                    );
                  }}
                />}
          </div>
        </div>
      ) : activeTab === "hoje" ? (
        <Hoje
          botsStatus={botsStatus}
          onRetryBots={retryBots}
          bots={bots}
          onOpenCreateBot={() => setCreateBotModalOpen(true)}
          onStopActivity={(id) => stopActivity(id, {})}
          onRunRoutine={(id) => testRoutine(id)}
          onNavigateTab={(tab) => {
            setActiveTab(tab);
            setSelectedBotName(null);
            setSelectedRoomId(null);
            setBotPage(null);
          }}
          onSelectBot={(name) => {
            setSelectedBotName(name);
            setSelectedRoomId(null);
            setBotPage(null);
          }}
          autoFetch={true}
        />
      ) : activeTab === "aprovacoes" ? (
        <ApprovalsInbox
          bots={bots}
          onApprovalsChanged={(count) => setApprovalsCount(count)}
        />
      ) : activeTab === "config" ? (
        <SettingsView bots={bots} />
      ) : activeTab === "regras" ? (
        <RulesView bots={bots} />
      ) : activeTab === "atividade" ? (
        <ActivityView key={activityView} bots={bots} initialView={activityView} onOpenConversation={(name) => { setSelectedBotName(name); setSelectedRoomId(null); setBotPage(null); }} />
      ) : activeTab === "custos" ? (
        <CostsView bots={bots} />
      ) : activeTab === "rotinas" ? (
        <RoutinesView bots={bots} />
      ) : activeTab === "mapa" ? (
        <TeamMapView
          availableBots={bots}
          onSelectBot={(name) => {
            setSelectedBotName(name);
            setSelectedRoomId(null);
            setBotPage(null);
          }}
          onNavigateToKanban={() => {
            setActiveTab("atividade");
            setActivityView("kanban");
            setSelectedBotName(null);
            setSelectedRoomId(null);
          }}
          onNavigateToRoom={(roomId) => {
            setSelectedRoomId(roomId);
            setSelectedBotName(null);
            setBotPage(null);
          }}
        />
      ) : (
        <div className="lb:p-8 lb:text-center lb:text-xs lb:text-[var(--color-muted-foreground)]">
          {t("pageArea", { tab: activeTab })}
        </div>
      )}

    </MessengerShell>
  );
}

/** In the Hermes sidebar (the official `header-left` slot): the way back to LuveBot from any Hermes page. */
export function BackToLuveBot() {
  const { t } = useLuveI18n();
  return (
    <a href={"/" + window.location.search} className="lb-host-link"
      style={{ font: "600 12px/16px var(--lb-font)", color: "inherit", padding: "4px 8px", borderRadius: 999, border: "1px solid currentColor", whiteSpace: "nowrap" }}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigateHost("/"); }}>
      ‹ {t("backToLuveBot")}
    </a>
  );
}

/** The `overlay` slot: LuveBot full screen while Hermes shows its route ("/"), nothing anywhere else. */
export function LuveBotOverlaySlot() {
  return <LuveBotOverlay><LuveBotApp /></LuveBotOverlay>;
}

// Register with Hermes Plugin Host if available. With slots (SDK 1.1.0), the "/" page is only the route marker and
// the app lives in the overlay; a host without registerSlot gets the app as a page inside its frame, as before.
const registry = getPluginRegistry();
if (registry && typeof registry.register === "function") {
  if (typeof registry.registerSlot === "function") {
    registry.register("luvebot", LuveBotRoute);
    registry.registerSlot("luvebot", "overlay", LuveBotOverlaySlot);
    registry.registerSlot("luvebot", "header-left", BackToLuveBot);
  } else {
    registry.register("luvebot", LuveBotApp);
  }
}

export default LuveBotApp;
