// dashboard/src/components/search/CommandPaletteModal.tsx
// Global ⌘K Command Palette and Unified Search (spec §4.14, contract v0.3 §6).
// Features:
// - Global shortcut ⌘K / Ctrl+K
// - Search across messages, bots, rooms, routines, files, actions
// - Safe snippet rendering without raw HTML
// - Quick actions: navigation or opens dialog with confirmation (NEVER direct POST)
// - Accessible keyboard navigation (Up/Down, Enter, Esc, focus trap and focus restoration)

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type {
  SearchCategory,
  SearchResponse,
  SearchMessageHit,
  SearchBotHit,
  SearchRoomHit,
  SearchRoutineHit,
  SearchFileHit,
  SearchActionHit,
  Bot,
  Room,
  Page,
} from "../../api/types";
import { searchLuveBot, listPages } from "../../api/client";
import { useLuveI18n } from "../../i18n";
import { BotsError, type ListStatus } from "../ui/ListState";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { HighlightedSnippet } from "./HighlightedSnippet";
import {
  SearchIcon,
  XIcon,
  BotIcon,
  ClockIcon,
  DollarSignIcon,
  NetworkIcon,
  CheckCircleIcon,
  PlusIcon,
  PauseIcon,
  ArrowRightIcon,
  HashIcon,
} from "../Icons";

export interface CommandPaletteModalProps {
  isOpen: boolean;
  onClose: () => void;
  availableBots?: Bot[];
  availableRooms?: Room[];
  initialSearchData?: SearchResponse;
  onNavigateTab?: (tabId: string) => void;
  onSelectBot?: (botName: string) => void;
  onSelectRoom?: (roomId: string) => void;
  onOpenCreateBot?: () => void;
  onOpenCreateRoom?: () => void;
  onConfirmPauseAll?: () => void | Promise<void>;
  onSelectPage?: (botName: string, slug: string) => void;  // contract v0.5: opens the page beside the Bot's conversation
  /** "No result" only once the Bot list loaded (ui/ListState): while it loads, or after it failed, say that instead. */
  botsStatus?: ListStatus;
  onRetryBots?: () => void;
}

interface PaletteItem {
  id: string;
  category: SearchCategory;
  title: string;
  subtitle?: string;
  snippet?: string;
  badge?: string;
  shortcut?: string;
  requiresConfirmation?: boolean;
  onSelect: () => void;
}

export function CommandPaletteModal({
  isOpen,
  onClose,
  availableBots = [],
  availableRooms = [],
  botsStatus = "ready",
  onRetryBots,
  initialSearchData,
  onNavigateTab,
  onSelectBot,
  onSelectRoom,
  onOpenCreateBot,
  onOpenCreateRoom,
  onConfirmPauseAll,
  onSelectPage,
}: CommandPaletteModalProps) {
  const { t } = useLuveI18n();

  const [query, setQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<SearchCategory>("all");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(
    initialSearchData || null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [confirmPauseAllOpen, setConfirmPauseAllOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus trap for main palette dialog
  const modalRef = useFocusTrap<HTMLDivElement>({
    isOpen: isOpen && !confirmPauseAllOpen,
    onClose,
    initialFocusRef: inputRef,
  });

  // Focus trap for pause confirmation sub-dialog
  const confirmModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: confirmPauseAllOpen,
    onClose: () => setConfirmPauseAllOpen(false),
  });

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setConfirmPauseAllOpen(false);
      if (initialSearchData) {
        setSearchResults(initialSearchData);
      } else {
        setSearchResults(null);
      }
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, initialSearchData]);

  // Static Quick Actions (spec §4.14)
  const quickActions: SearchActionHit[] = useMemo(() => [
    {
      id: "act-new-bot",
      title: t("searchActionNewBot"),
      description: t("searchActionNewBotDesc"),
      actionKey: "new_bot",
      category: "actions",
    },
    {
      id: "act-new-room",
      title: t("searchActionNewRoom"),
      description: t("searchActionNewRoomDesc"),
      actionKey: "new_room",
      category: "actions",
    },
    {
      id: "act-approvals",
      title: t("searchActionApprovals"),
      description: t("searchActionApprovalsDesc"),
      actionKey: "approvals",
      category: "actions",
    },
    {
      id: "act-activity",
      title: t("searchActionActivity"),
      description: t("searchActionActivityDesc"),
      actionKey: "activity",
      category: "actions",
    },
    {
      id: "act-routines",
      title: t("searchActionRoutines"),
      description: t("searchActionRoutinesDesc"),
      actionKey: "routines",
      category: "actions",
    },
    {
      id: "act-map",
      title: t("searchActionMap"),
      description: t("searchActionMapDesc"),
      actionKey: "map",
      category: "actions",
    },
    {
      id: "act-costs",
      title: t("searchActionCosts"),
      description: t("searchActionCostsDesc"),
      actionKey: "costs",
      category: "actions",
    },
    // D2: offered only when the caller wires a real pause; a confirmation that does nothing is not an action
    ...(onConfirmPauseAll ? [{
      id: "act-pause-all",
      title: t("searchActionPauseAll"),
      description: t("searchActionPauseAllDesc"),
      actionKey: "pause_all",
      category: "actions",
      requiresConfirmation: true,
      confirmMessage: t("searchConfirmPauseAllBody"),
    }] : []),
  ], [t, onConfirmPauseAll]);

  // Execute an action
  const handleAction = useCallback(
    (actionKey: string, requiresConfirmation = false) => {
      if (requiresConfirmation) {
        // MUST NEVER call POST directly without human confirmation!
        setConfirmPauseAllOpen(true);
        return;
      }

      switch (actionKey) {
        case "new_bot":
          onOpenCreateBot?.();
          onClose();
          break;
        case "new_room":
          onOpenCreateRoom?.();
          onClose();
          break;
        case "approvals":
          onNavigateTab?.("aprovacoes");
          onClose();
          break;
        case "activity":
          onNavigateTab?.("atividade");
          onClose();
          break;
        case "routines":
          onNavigateTab?.("rotinas");
          onClose();
          break;
        case "map":
          onNavigateTab?.("mapa");
          onClose();
          break;
        case "costs":
          onNavigateTab?.("custos");
          onClose();
          break;
        case "pause_all":
          // Reaches here if confirmed
          onConfirmPauseAll?.();
          onClose();
          break;
        default:
          onClose();
          break;
      }
    },
    [
      onConfirmPauseAll,
      onClose,
      onOpenCreateBot,
      onOpenCreateRoom,
      onNavigateTab,
    ]
  );

  // Execute search via API client
  const matchActions = useCallback((q: string) => {
    const lower = q.trim().toLowerCase();
    return quickActions.filter((a) => a.title.toLowerCase().includes(lower) || a.description?.toLowerCase().includes(lower));
  }, [quickActions]);

  const executeSearch = useCallback(
    async (q: string, category: SearchCategory) => {
      if (!q.trim()) {
        setSearchResults(null);
        return;
      }

      try {
        setIsLoading(true);
        const typesParam =
          category === "all"
            ? "messages,bots,rooms,routines,files,actions"
            : category;

        const res = await searchLuveBot({
          q: q.trim(),
          types: typesParam,
          limit: 10,
        });
        // The quick actions live in the UI, so they are matched here too: "Mapa" finds "Ver Mapa do Time" whatever the
        // backend answers; a backend action with the same key is not listed twice.
        const local = category === "all" || category === "actions" ? matchActions(q) : [];
        const keys = new Set(local.map((a) => a.actionKey));
        setSearchResults({ ...res, actions: [...local, ...(res.actions ?? []).filter((a) => !keys.has(a.actionKey))] });
      } catch {
        // In local/offline without backend, fallback to client-side search over available items
        const lower = q.toLowerCase();
        const fallbackBots: SearchBotHit[] = availableBots
          .filter(
            (b) =>
              b.name.toLowerCase().includes(lower) ||
              b.display?.label.toLowerCase().includes(lower) ||
              b.description?.toLowerCase().includes(lower)
          )
          .map((b) => ({
            name: b.name,
            display: b.display,
            description: b.description,
            status: b.status,
          }));

        const fallbackRooms: SearchRoomHit[] = availableRooms
          .filter((r) => r.name.toLowerCase().includes(lower))
          .map((r) => ({
            id: r.id,
            name: r.name,
            goal: r.goal,
            members_count: r.members.length,
          }));

        setSearchResults({
          messages: [],
          bots: fallbackBots,
          rooms: fallbackRooms,
          routines: [],
          files: [],
          actions: matchActions(q),
        });
      } finally {
        setIsLoading(false);
      }
    },
    [availableBots, availableRooms, matchActions]
  );

  // Debounced search on input change
  useEffect(() => {
    if (!initialSearchData) {
      const timer = setTimeout(() => {
        if (query.trim()) {
          executeSearch(query, selectedCategory);
        } else {
          setSearchResults(null);
        }
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [query, selectedCategory, executeSearch, initialSearchData]);

  // Pages (v0.5): titles searched in each Bot's list (no global route). A Bot whose Pages cannot open is skipped.
  const [pageHits, setPageHits] = useState<Array<{ bot: string; botLabel: string; page: Page }>>([]);
  const botsKey = availableBots.map((b) => `${b.name}\u0000${b.display?.label ?? ""}`).join("\u0001"); // stable across renders
  const botsRef = useRef(availableBots);
  botsRef.current = availableBots;
  useEffect(() => {
    const q = query.trim();
    if (!onSelectPage || q.length < 2 || (selectedCategory !== "all" && selectedCategory !== "pages")) { setPageHits((h) => (h.length ? [] : h)); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      const results = await Promise.allSettled(botsRef.current.map((b) => listPages(b.name, q).then((r) => ({ b, r }))));
      if (!alive) return;
      const hits = results.flatMap((x) => x.status === "fulfilled" && (x.value.r.workspace?.state === "ready" || x.value.r.workspace?.state === "empty")
        ? x.value.r.pages.map((page) => ({ bot: x.value.b.name, botLabel: x.value.b.display?.label || x.value.b.name, page })) : []);
      setPageHits(hits.slice(0, 10));
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, selectedCategory, botsKey, onSelectPage]);

  // Flatten active items for keyboard navigation and rendering
  const displayedItems: PaletteItem[] = useMemo(() => {
    const items: PaletteItem[] = [];

    // When query is empty, show Quick Actions
    if (!query.trim() && (!searchResults || Object.keys(searchResults).length === 0)) {
      quickActions.forEach((act) => {
        items.push({
          id: act.id,
          category: "actions",
          title: act.title,
          subtitle: act.description,
          shortcut: act.shortcut,
          requiresConfirmation: act.requiresConfirmation,
          onSelect: () => handleAction(act.actionKey, act.requiresConfirmation),
        });
      });
      return items;
    }

    if (!searchResults) return items;

    // 1. Actions
    if (selectedCategory === "all" || selectedCategory === "actions") {
      (searchResults.actions || []).forEach((act) => {
        items.push({
          id: act.id,
          category: "actions",
          title: act.title,
          subtitle: act.description,
          shortcut: act.shortcut,
          requiresConfirmation: act.requiresConfirmation,
          onSelect: () => handleAction(act.actionKey, act.requiresConfirmation),
        });
      });
    }

    // 2. Bots
    if (selectedCategory === "all" || selectedCategory === "bots") {
      (searchResults.bots || []).forEach((bot) => {
        items.push({
          id: `bot-${bot.name}`,
          category: "bots",
          title: bot.display?.label || bot.name,
          subtitle: `@${bot.name} · ${bot.description || bot.display?.role || ""}`,
          badge: bot.status,
          onSelect: () => {
            onSelectBot?.(bot.name);
            onClose();
          },
        });
      });
    }

    // 3. Rooms
    if (selectedCategory === "all" || selectedCategory === "rooms") {
      (searchResults.rooms || []).forEach((room) => {
        items.push({
          id: `room-${room.id}`,
          category: "rooms",
          title: room.name,
          subtitle: room.goal || t("roomMembersCount", { count: room.members_count }),
          badge: t("searchCategoryRooms"),
          onSelect: () => {
            onSelectRoom?.(room.id);
            onClose();
          },
        });
      });
    }

    // 4. Messages
    if (selectedCategory === "all" || selectedCategory === "messages") {
      (searchResults.messages || []).forEach((msg, idx) => {
        items.push({
          id: `msg-${msg.session_id}-${idx}`,
          category: "messages",
          title: msg.title || t("searchHitFromBot", { bot: msg.bot }),
          subtitle: t("searchHitFromBot", { bot: msg.bot }),
          snippet: msg.snippet,
          onSelect: () => {
            if (msg.links?.room_id) {
              onSelectRoom?.(msg.links.room_id);
            } else if (msg.bot) {
              onSelectBot?.(msg.bot);
            }
            onClose();
          },
        });
      });
    }

    // 5. Routines
    if (selectedCategory === "all" || selectedCategory === "routines") {
      (searchResults.routines || []).forEach((routine) => {
        items.push({
          id: `routine-${routine.id}`,
          category: "routines",
          title: routine.name,
          subtitle: `@${routine.bot} · ${routine.schedule}`,
          badge: routine.paused ? t("statusPausedLabel") : t("statusWorkingLabel"),
          onSelect: () => {
            onNavigateTab?.("rotinas");
            onClose();
          },
        });
      });
    }

    // 6. Files
    if (selectedCategory === "all" || selectedCategory === "files") {
      (searchResults.files || []).forEach((file, idx) => {
        items.push({
          id: `file-${file.name}-${idx}`,
          category: "files",
          title: file.name,
          subtitle: file.path,
          onSelect: () => {
            onClose();
          },
        });
      });
    }

    if (selectedCategory === "all" || selectedCategory === "pages") {
      pageHits.forEach(({ bot, botLabel, page }) => {
        items.push({
          id: `page-${bot}-${page.slug}`,
          category: "pages",
          title: page.title,
          subtitle: t("pageOfBot", { name: botLabel }),
          snippet: page.excerpt || undefined,
          onSelect: () => { onSelectPage?.(bot, page.slug); onClose(); },
        });
      });
    }

    return items;
  }, [
    pageHits,
    onSelectPage,
    query,
    searchResults,
    selectedCategory,
    quickActions,
    handleAction,
    onSelectBot,
    onSelectRoom,
    onNavigateTab,
    onClose,
    t,
  ]);

  // Adjust selectedIndex bounds
  useEffect(() => {
    if (selectedIndex >= displayedItems.length) {
      setSelectedIndex(Math.max(0, displayedItems.length - 1));
    }
  }, [displayedItems.length, selectedIndex]);

  // Keyboard navigation inside palette
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (confirmPauseAllOpen) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, displayedItems.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        prev <= 0 ? Math.max(0, displayedItems.length - 1) : prev - 1
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const current = displayedItems[selectedIndex];
      if (current) {
        current.onSelect();
      }
    }
  };

  if (!isOpen) return null;

  const categories: Array<{ id: SearchCategory; label: string }> = [
    { id: "all", label: t("searchCategoryAll") },
    { id: "messages", label: t("searchCategoryMessages") },
    { id: "bots", label: t("searchCategoryBots") },
    { id: "rooms", label: t("searchCategoryRooms") },
    { id: "routines", label: t("searchCategoryRoutines") },
    { id: "actions", label: t("searchCategoryActions") },
    ...(onSelectPage ? [{ id: "pages" as SearchCategory, label: t("pagesSearchCategory") }] : []),
  ];

  return (
    <div
      className="lb-dialog-overlay"
      style={{ alignItems: "flex-start", paddingTop: 64 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("searchPaletteTitle")}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="lb-dialog lb:max-w-2xl lb:overflow-y-auto"
      >
        {/* Search input header */}
        <div className="lb:flex lb:items-center lb:gap-3 lb:px-4 lb:py-3.5 lb:border-b lb:border-[var(--lb-separator)] lb:shrink-0">
          <SearchIcon size={18} className="lb:text-[var(--color-muted-foreground)] lb:shrink-0" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="palette-results-list"
            aria-activedescendant={
              displayedItems[selectedIndex]
                ? `item-${displayedItems[selectedIndex].id}`
                : undefined
            }
            placeholder={t("searchPlaceholderInput")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            className="lb:flex-1 lb:bg-transparent lb:border-none lb:text-[15px] lb:text-[var(--color-card-foreground)] lb:placeholder-[var(--color-muted-foreground)] focus:lb:outline-none"
          />

          {query && (
            <button
              type="button"
              aria-label={t("clearSearch")}
              onClick={() => {
                setQuery("");
                setSelectedIndex(0);
              }}
              className="lb:p-1 lb:rounded-lg lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-card-foreground)] lb:min-h-11 lb:min-w-11 lb:flex lb:items-center lb:justify-center focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none"
            >
              <XIcon size={14} />
            </button>
          )}

          <kbd className="lb:hidden lb:sm:inline-flex lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-mono lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)]">
            ESC
          </kbd>
        </div>

        {/* Categories Tab Bar */}
        <div className="lb:flex lb:items-center lb:gap-1 lb:px-4 lb:py-2 lb:border-b lb:border-[var(--lb-separator)] lb:bg-[var(--color-popover)]/60 lb:overflow-x-auto lb:shrink-0">
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => {
                setSelectedCategory(cat.id);
                setSelectedIndex(0);
                if (query.trim()) {
                  executeSearch(query, cat.id);
                }
              }}
              aria-pressed={selectedCategory === cat.id}
              className={`lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:whitespace-nowrap lb:min-h-11 lb:md:min-h-7 lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full ${
                selectedCategory === cat.id
                  ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-foreground)] lb:border-[var(--lb-separator)]"
                  : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Results List Area */}
        <div
          id="palette-results-list"
          role="listbox"
          aria-label={t("searchResultsHeader")}
          className="lb:flex-1 lb:overflow-y-auto lb:p-2 lb:space-y-1"
        >
          {isLoading || (botsStatus === "loading" && displayedItems.length === 0) ? (
            <div className="lb:p-8 lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              <span className="lb:animate-pulse">{isLoading ? t("searchLoading") : t("loadingBots")}</span>
            </div>
          ) : botsStatus === "error" && displayedItems.length === 0 ? (
            <BotsError onRetry={onRetryBots} />
          ) : displayedItems.length === 0 ? (
            <div
              data-testid="search-empty-state"
              className="lb:p-8 lb:text-center lb:flex lb:flex-col lb:items-center lb:justify-center lb:gap-1.5 lb:text-[13px] lb:text-[var(--color-muted-foreground)]"
            >
              <span className="lb:font-medium lb:text-[var(--color-foreground)]">
                {query.trim()
                  ? t("searchNoResults", { query })
                  : t("searchEmptyPrompt")}
              </span>
              <span className="lb:text-xs lb:text-[var(--color-muted-foreground)]">
                {t("searchEmptyNextStep")}
              </span>
            </div>
          ) : (
            displayedItems.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={item.id}
                  id={`item-${item.id}`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => item.onSelect()}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`lb:px-3 lb:py-2.5 lb:rounded-2xl lb:flex lb:items-center lb:justify-between lb:gap-3 lb:cursor-pointer lb:motion-safe:transition-colors lb:min-h-11 ${
                    isSelected
                      ? "lb:bg-[var(--color-primary)]/10 lb:text-[var(--color-foreground)]"
                      : "lb:hover:bg-[var(--lb-fill-2)] lb:text-[var(--color-card-foreground)]"
                  }`}
                >
                  <div className="lb:flex lb:items-start lb:gap-3 lb:min-w-0">
                    {/* Category Icon */}
                    <span className="lb:mt-0.5 lb:text-[var(--color-muted-foreground)] lb:shrink-0">
                      {item.category === "bots" && <BotIcon size={15} />}
                      {item.category === "rooms" && <NetworkIcon size={15} />}
                      {item.category === "actions" && <PlusIcon size={15} />}
                      {item.category === "routines" && <ClockIcon size={15} />}
                      {item.category === "messages" && <HashIcon size={15} />}
                    </span>

                    <div className="lb:min-w-0">
                      <div className="lb:flex lb:items-center lb:gap-2">
                        <span className="lb:text-[13px] lb:font-semibold lb:truncate">
                          {item.title}
                        </span>
                        {item.badge && (
                          <span className="lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-medium lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)]">
                            {item.badge}
                          </span>
                        )}
                      </div>

                      {item.subtitle && (
                        <span className="lb:text-xs lb:text-[var(--color-muted-foreground)] lb:block lb:truncate">
                          {item.subtitle}
                        </span>
                      )}

                      {/* Safe Highlighted Snippet */}
                      {item.snippet && (
                        <div className="lb:mt-1 lb:p-1.5 lb:rounded-lg lb:bg-[var(--lb-fill)] lb:border-[var(--color-border)]/50 lb:text-xs">
                          <HighlightedSnippet text={item.snippet} query={query} />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Shortcut key or Action indicator */}
                  <div className="lb:flex lb:items-center lb:gap-2 lb:shrink-0">
                    {item.shortcut && (
                      <kbd className="lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-mono lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)]">
                        {item.shortcut}
                      </kbd>
                    )}
                    {isSelected && (
                      <span className="lb:text-xs lb:font-medium lb:text-[var(--color-primary)] lb:hidden lb:sm:inline-flex lb:items-center lb:gap-1">
                        {t("searchOpenModalAction")} ↵
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer info */}
        <div className="lb:flex lb:items-center lb:justify-between lb:px-4 lb:py-2.5 lb:border-t lb:border-[var(--lb-separator)] lb:bg-[var(--color-popover)]/60 lb:text-xs lb:text-[var(--color-muted-foreground)] lb:shrink-0">
          <span>
            {t("searchResultCount", { count: displayedItems.length })}
          </span>
          <div className="lb:flex lb:items-center lb:gap-3">
            <span>↑↓ {t("searchNavigateAction")}</span>
            <span>↵ {t("searchOpenModalAction")}</span>
            <span>Esc {t("close")}</span>
          </div>
        </div>
      </div>

      {/* Confirmation Dialog for Sensitive Actions (e.g. Pause All) */}
      {confirmPauseAllOpen && (
        <div
          className="lb-dialog-overlay" style={{ zIndex: 60 }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmPauseAllOpen(false);
          }}
        >
          <div
            ref={confirmModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-pause-title"
            tabIndex={-1}
            className="lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto"
          >
            <div className="lb:flex lb:items-start lb:justify-between lb:gap-3">
              <h2
                id="confirm-pause-title"
                className="lb-title lb:text-[var(--color-destructive)]"
              >
                {t("searchConfirmPauseAllTitle")}
              </h2>
              <button
                type="button"
                onClick={() => setConfirmPauseAllOpen(false)}
                aria-label={t("close")}
                className="lb-icon-btn" style={{ background: "var(--lb-fill)" }}
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:leading-relaxed">
              {t("searchConfirmPauseAllBody")}
            </p>

            <div className="lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2">
              <button
                type="button"
                onClick={() => setConfirmPauseAllOpen(false)}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-card-foreground)] lb:hover:bg-[var(--lb-fill-2)] lb:min-h-11 lb:md:min-h-8 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("cancelBtn")}
              </button>
              <button
                type="button"
                data-testid="btn-confirm-pause-all"
                onClick={async () => {
                  setConfirmPauseAllOpen(false);
                  if (onConfirmPauseAll) {
                    await onConfirmPauseAll();
                  }
                  onClose();
                }}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-semibold lb:bg-[var(--color-destructive)] lb:text-[var(--color-destructive-foreground)] lb:hover:opacity-90 lb:min-h-11 lb:md:min-h-8 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("searchConfirmPauseAllBtn")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
