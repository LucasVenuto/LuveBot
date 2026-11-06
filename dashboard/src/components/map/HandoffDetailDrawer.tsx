// dashboard/src/components/map/HandoffDetailDrawer.tsx
// Drawer / Modal displaying handoff details between two bots on the Team Map.

import React from "react";
import type { TeamMapEdge } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { XIcon, ArrowRightIcon } from "../Icons";

export interface HandoffDetailDrawerProps {
  isOpen: boolean;
  edge: TeamMapEdge | null;
  onClose: () => void;
  onNavigateToKanban?: (taskId: string) => void;
}

export function HandoffDetailDrawer({
  isOpen,
  edge,
  onClose,
  onNavigateToKanban,
}: HandoffDetailDrawerProps) {
  const { t } = useLuveI18n();

  const containerRef = useFocusTrap<HTMLDivElement>({
    isOpen,
    onClose,
  });

  if (!isOpen || !edge) return null;

  return (
    <div
      className="lb:fixed lb:inset-0 lb:z-50 lb:flex lb:justify-end lb:bg-black/60 lb:backdrop-blur-xs lb:motion-safe:animate-in lb:fade-in lb:motion-safe:duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="handoff-drawer-title"
        tabIndex={-1}
        className="lb:w-full lb:max-w-md lb:h-full lb:bg-[var(--lb-fill)] lb:border-l lb:border-[var(--lb-separator)] lb:shadow-2xl lb:flex lb:flex-col lb:focus:outline-none"
      >
        {/* Header */}
        <div className="lb:flex lb:items-center lb:justify-between lb:p-4 lb:border-b lb:border-[var(--lb-separator)] lb:shrink-0">
          <div className="lb:flex lb:items-center lb:gap-2">
            <h2
              id="handoff-drawer-title"
              className="lb:text-[15px] lb:font-bold lb:text-[var(--color-card-foreground)]"
            >
              {t("mapHandoffDrawerTitle")}
            </h2>
            {edge.live && (
              <span className="lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)] lb:flex lb:items-center lb:gap-1">
                <span className="lb:w-1.5 lb:h-1.5 lb:rounded-full lb:bg-[var(--color-success)] lb:motion-safe:animate-pulse" />
                {t("mapEdgeLiveIndicator")}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className="lb:p-1.5 lb:rounded-lg lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-card-foreground)] lb:hover:bg-[var(--lb-fill-2)] lb:min-h-11 lb:min-w-11 lb:flex lb:items-center lb:justify-center focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none"
          >
            <XIcon size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="lb:flex-1 lb:overflow-y-auto lb:p-4 lb:space-y-4">
          {/* Bots connection banner */}
          <div className="lb:flex lb:items-center lb:justify-center lb:gap-3 lb:p-3 lb:rounded-xl lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)]">
            <span className="lb:font-mono lb:font-semibold lb:text-[13px] lb:text-[var(--color-primary)]">
              @{edge.from}
            </span>
            <ArrowRightIcon size={14} className="lb:text-[var(--color-muted-foreground)]" />
            <span className="lb:font-mono lb:font-semibold lb:text-[13px] lb:text-[var(--color-primary)]">
              @{edge.to}
            </span>
          </div>

          {/* Stats */}
          <div className="lb:grid lb:grid-cols-2 lb:gap-2">
            <div className="lb:p-3 lb:rounded-lg lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)]">
              <span className="lb:text-xs lb:text-[var(--color-muted-foreground)] lb:font-semibold lb:block">
                {t("mapHandoffTotal")}
              </span>
              <span className="lb:text-base lb:font-bold lb:text-[var(--color-foreground)]">
                {t("mapHandoffsCount", { count: edge.count })}
              </span>
            </div>
            <div className="lb:p-3 lb:rounded-lg lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)]">
              <span className="lb:text-xs lb:text-[var(--color-muted-foreground)] lb:font-semibold lb:block">
                {t("mapHandoffStatus")}
              </span>
              <span
                className={`lb:text-[13px] lb:font-semibold lb:block lb:mt-1 ${
                  edge.live ? "lb:text-[var(--color-success)]" : "lb:text-[var(--color-muted-foreground)]"
                }`}
              >
                {edge.live ? t("mapLiveHandoffBadge") : t("roomDriverIdle")}
              </span>
            </div>
          </div>

          {edge.last_at && (
            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("mapLastActivity", { date: new Date(edge.last_at).toLocaleString() })}
            </p>
          )}

          {/* Handoff IDs / Tasks */}
          <div className="lb:space-y-2">
            <h3 className="lb:text-[13px] lb:font-semibold lb:text-[var(--color-card-foreground)]">
              {t("mapRecentTasks", { count: edge.handoff_ids?.length || 0 })}
            </h3>
            {(!edge.handoff_ids || edge.handoff_ids.length === 0) ? (
              <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:italic">
                {t("mapNoEdges")}
              </p>
            ) : (
              <ul className="lb:space-y-2">
                {edge.handoff_ids.map((id) => (
                  <li
                    key={id}
                    className="lb:p-3 lb:rounded-lg lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:flex lb:items-center lb:justify-between lb:gap-2"
                  >
                    <div className="lb:min-w-0">
                      <span className="lb:font-mono lb:text-[13px] lb:font-semibold lb:text-[var(--color-foreground)] lb:block lb:truncate">
                        {t("mapHandoffItemLabel", { id })}
                      </span>
                      <span className="lb:text-xs lb:text-[var(--color-muted-foreground)] lb:block">
                        {edge.from} → {edge.to}
                      </span>
                    </div>
                    {onNavigateToKanban && (
                      <button
                        type="button"
                        data-testid="map-handoff-kanban-link"
                        onClick={() => onNavigateToKanban(id)}
                        className="lb:px-2.5 lb:py-1.5 lb:text-[13px] lb:font-semibold lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:min-h-11 lb:md:min-h-7 lb:shrink-0 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
                      >
                        {t("mapViewKanbanTask")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="lb:p-4 lb:border-t lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:shrink-0 lb:flex lb:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="lb:px-4 lb:py-2 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-card-foreground)] lb:hover:bg-[var(--lb-fill-2)] lb:min-h-11 lb:md:min-h-8 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
          >
            {t("cancelBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}
