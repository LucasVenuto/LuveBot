// dashboard/src/components/map/TeamMapView.tsx
// Team Map Screen (spec §4.12, contract v0.3 §5):
// Visual Graph + Accessible Keyboard List view for Bots, active rooms and handoff flow.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import type { TeamMapResponse, TeamMapNode, TeamMapEdge, Bot, BotAvatar, BotDisplay } from "../../api/types";
import { displayName } from "../../lib/botName";
import { mascotUrl, displayFace } from "../ui/mascots";
import { getTeamMap } from "../../api/client";
import { useLuveI18n } from "../../i18n";
import { botStatusLabel } from "../labels";
import { HandoffDetailDrawer } from "./HandoffDetailDrawer";
import { NetworkIcon, ClockIcon, DollarSignIcon, ArrowRightIcon } from "../Icons";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";

export interface TeamMapViewProps {
  availableBots?: Bot[];
  initialMapData?: TeamMapResponse;
  onSelectBot?: (botSlug: string) => void;
  onNavigateToKanban?: (taskId: string) => void;
  onNavigateToRoom?: (roomId: string) => void;
}

/**
 * How far from a node's centre an edge leaving in direction (ux, uy) starts, so it clears the node
 * (r=26) and the name and status written under the node (y 26 to 54, about 7 px per character).
 */
// Only a mascot face shipped in the plugin, never an external URL (A-54); the state rides on the fragment (§14.3).
const faceSrc = (avatar: BotAvatar | null | undefined, status: string) =>
  avatar?.kind === "mascot" ? mascotUrl(avatar.value, status === "working" ? "working" : status === "waiting_approval" ? "needs_you" : undefined, 48) : null;
const faceText = (node: { bot: string; display?: { label?: string; avatar?: BotAvatar | null } | null }) => {
  const a = node.display?.avatar;
  if (a?.kind === "emoji" && a.value) return a.value;
  const src = a?.kind === "initials" && a.value ? a.value : node.display?.label || node.bot;
  return Array.from(src.trim()).slice(0, 2).join("").toUpperCase();
};

function edgeGap(ux: number, uy: number, labelChars: number): number {
  const ring = 30;
  if (uy <= 0) return ring;
  const halfWidth = labelChars * 3.6 + 6;
  const enter = 26 / uy;
  const exit = Math.min(58 / uy, ux === 0 ? Infinity : halfWidth / Math.abs(ux));
  return exit >= enter ? Math.max(ring, exit + 4) : ring;
}

export function TeamMapView({
  availableBots = [],
  initialMapData,
  onSelectBot,
  onNavigateToKanban,
  onNavigateToRoom,
}: TeamMapViewProps) {
  const { locale, t } = useLuveI18n();

  const [timeWindow, setTimeWindow] = useState<"7d" | "30d">("7d");
  const [viewMode, setViewMode] = useState<"visual" | "accessible">("visual");
  const [mapData, setMapData] = useState<TeamMapResponse | null>(initialMapData || null);
  const [loading, setLoading] = useState<boolean>(!initialMapData);
  const [error, setError] = useState<ErrorState | null>(null);

  // Selected edge for handoff details drawer
  const [selectedEdge, setSelectedEdge] = useState<TeamMapEdge | null>(null);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);

  // Fetch map data
  const loadMapData = useCallback(async (win: "7d" | "30d") => {
    try {
      setLoading(true);
      setError(null);
      const data = await getTeamMap({ window: win });
      setMapData(data);
    } catch (err: unknown) {
      const msg = humanError(err, t, "mapError");
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!initialMapData) {
      loadMapData(timeWindow);
    }
  }, [timeWindow, initialMapData, loadMapData]);

  // Nodes come from the map's own API, not the Bots list: the display name is applied here, once, for every label below.
  const nodes = useMemo(() => (mapData?.nodes || []).map((n) => ({ ...n, display: { ...n.display, label: displayName(n.bot, n.display?.label), avatar: displayFace(n.bot, n.display?.avatar) } as BotDisplay })), [mapData]);
  const edges = useMemo(() => mapData?.edges || [], [mapData]);

  // Handle clicking edge
  const handleEdgeClick = (edge: TeamMapEdge) => {
    setSelectedEdge(edge);
    setDrawerOpen(true);
  };

  // Format currency
  const formatCost = (cents?: number) => {
    if (cents === undefined || cents === null) return "$0.00";
    return (cents / 100).toLocaleString(locale === "pt" ? "pt-BR" : "en-US", {
      style: "currency",
      currency: "USD",
    });
  };

  // Node coordinate calculation for circular visual graph
  const nodeCoordinates = useMemo(() => {
    const coords = new Map<string, { x: number; y: number }>();
    const total = nodes.length;
    if (total === 0) return coords;

    const centerX = 350;
    const centerY = 240;
    // Wide enough that an edge between neighbours keeps a long visible line after it clears both labels.
    const radius = 180; // the most the 700x480 frame holds with names under the top and bottom nodes

    nodes.forEach((n, idx) => {
      const angle = (idx / total) * 2 * Math.PI - Math.PI / 2;
      coords.set(n.bot, {
        x: centerX + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle),
      });
    });

    return coords;
  }, [nodes]);

  // Width of the longest line written under a node (its name or its status), in characters.
  const labelChars = (bot: string) => {
    const n = nodes.find((x) => x.bot === bot);
    return n ? Math.max((n.display?.label || n.bot).length, botStatusLabel(n.status, t).length) : 0;
  };

  return (
    <div className="lb:flex lb:flex-col lb:h-full lb:min-h-0 lb:bg-[var(--color-background)]">
      {/* Top Header Bar */}
      <div className="lb:flex lb:flex-wrap lb:items-center lb:justify-between lb:gap-3 lb:p-3 lb:md:px-4 lb:border-b lb:border-[var(--lb-separator)] lb:shrink-0">
        <div className="lb:flex lb:items-center lb:gap-3">
          <div className="lb:w-8 lb:h-8 lb:rounded-xl lb:bg-[var(--color-primary)]/10 lb:text-[var(--color-primary)] lb:flex lb:items-center lb:justify-center lb:shrink-0">
            <NetworkIcon size={18} />
          </div>
          <div>
            <h1 className="lb-large-title">
              {t("mapTitle")}
            </h1>
            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:hidden lb:sm:block">
              {t("mapSubtitle")}
            </p>
          </div>
        </div>

        {/* Controls: Window Selector + View Mode Switcher */}
        <div className="lb:flex lb:items-center lb:gap-2">
          {/* Window: 7d vs 30d */}
          <div className="lb:flex lb:items-center lb:border-[var(--lb-separator)] lb:rounded-xl lb:p-0.5 lb:bg-[var(--lb-fill)]">
            <button
              type="button"
              onClick={() => setTimeWindow("7d")}
              aria-pressed={timeWindow === "7d"}
              className={`lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:min-h-11 lb:md:min-h-7 lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full ${
                timeWindow === "7d"
                  ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-foreground)]"
                  : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"
              }`}
            >
              {t("mapWindow7d")}
            </button>
            <button
              type="button"
              onClick={() => setTimeWindow("30d")}
              aria-pressed={timeWindow === "30d"}
              className={`lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:min-h-11 lb:md:min-h-7 lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full ${
                timeWindow === "30d"
                  ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-foreground)]"
                  : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"
              }`}
            >
              {t("mapWindow30d")}
            </button>
          </div>

          {/* View mode toggle: Visual vs Accessible */}
          <div
            role="tablist"
            aria-label={t("mapTitle")}
            className="lb:flex lb:items-center lb:border-[var(--lb-separator)] lb:rounded-xl lb:p-0.5 lb:bg-[var(--lb-fill)]"
          >
            <button
              type="button"
              role="tab"
              id="tab-map-visual"
              aria-selected={viewMode === "visual"}
              aria-controls="panel-map-visual"
              title={t("mapViewVisualDesc")}
              onClick={() => setViewMode("visual")}
              className={`lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:min-h-11 lb:md:min-h-7 lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full ${
                viewMode === "visual"
                  ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-foreground)]"
                  : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"
              }`}
            >
              {t("mapViewVisual")}
            </button>
            <button
              type="button"
              role="tab"
              id="tab-map-accessible"
              aria-selected={viewMode === "accessible"}
              aria-controls="panel-map-accessible"
              title={t("mapViewAccessibleDesc")}
              onClick={() => setViewMode("accessible")}
              className={`lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:min-h-11 lb:md:min-h-7 lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full ${
                viewMode === "accessible"
                  ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-foreground)]"
                  : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"
              }`}
            >
              {t("mapViewAccessible")}
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="lb:flex-1 lb:min-h-0 lb:overflow-auto lb:relative">
        {loading ? (
          <div className="lb:flex lb:items-center lb:justify-center lb:h-full lb:p-8 lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
            <span className="lb:motion-safe:animate-pulse">{t("mapLoading")}</span>
          </div>
        ) : error ? (
          <div className="lb:flex lb:items-center lb:justify-center lb:h-full lb:p-8" role="alert">
            <div className="lb:p-4 lb:rounded-xl lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:text-[var(--color-destructive)] lb:text-[13px]">
              <ErrorNote error={error} />
              <div><button type="button" className="lb-btn lb-btn-plain" onClick={() => void loadMapData(timeWindow)}>{t("retry")}</button></div>
            </div>
          </div>
        ) : nodes.length === 0 ? (
          <div
            data-testid="map-empty-state"
            className="lb:flex lb:flex-col lb:items-center lb:justify-center lb:h-full lb:p-8 lb:text-center lb:gap-2"
          >
            <h3 className="lb:text-[15px] lb:font-medium lb:text-[var(--color-foreground)]">
              {t("mapNoNodes")}
            </h3>
            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:max-w-sm">
              {t("mapEmptyNextStep")}
            </p>
          </div>
        ) : viewMode === "visual" ? (
          /* Visual Graph View */
          <div
            id="panel-map-visual"
            role="tabpanel"
            aria-labelledby="tab-map-visual"
            className="lb:w-full lb:h-full lb:min-h-[500px] lb:flex lb:items-center lb:justify-center lb:p-4 lb:overflow-auto"
          >
            <svg
              viewBox="0 0 700 480"
              className="lb:w-full lb:max-w-3xl lb:h-auto lb:max-h-[520px] lb:select-none"
            >
              <defs>
                {/* Arrow markers */}
                <marker
                  id="arrow-default"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerUnits="userSpaceOnUse"
                  markerWidth="12"
                  markerHeight="12"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-muted-foreground)" fillOpacity="0.7" />
                </marker>
                <marker
                  id="arrow-live"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerUnits="userSpaceOnUse"
                  markerWidth="12"
                  markerHeight="12"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-success)" />
                </marker>
              </defs>

              {/* Connecting Edges (Handoffs) */}
              {edges.map((edge) => {
                const fromCoord = nodeCoordinates.get(edge.from);
                const toCoord = nodeCoordinates.get(edge.to);
                if (!fromCoord || !toCoord) return null;

                const strokeWidth = Math.min(8, Math.max(2, Math.log2(edge.count + 1) * 2));
                // The line stops short of both nodes, so neither it nor the arrow crosses a name or status.
                const len = Math.hypot(toCoord.x - fromCoord.x, toCoord.y - fromCoord.y) || 1;
                const ux = (toCoord.x - fromCoord.x) / len;
                const uy = (toCoord.y - fromCoord.y) / len;
                const g1 = edgeGap(ux, uy, labelChars(edge.from));
                const g2 = edgeGap(-ux, -uy, labelChars(edge.to));
                const x1 = fromCoord.x + ux * g1;
                const y1 = fromCoord.y + uy * g1;
                const x2 = toCoord.x - ux * g2;
                const y2 = toCoord.y - uy * g2;
                // the count sits beside the line (not on it), so the whole line and its arrow stay visible
                const midX = (x1 + x2) / 2 - uy * 18;
                const midY = (y1 + y2) / 2 + ux * 18;

                return (
                  <g
                    key={`${edge.from}->${edge.to}`}
                    className="lb:cursor-pointer lb:group"
                    onClick={() => handleEdgeClick(edge)}
                  >
                    {/* Hit area */}
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke="transparent"
                      strokeWidth="24"
                    />
                    {/* Visible line */}
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke={edge.live ? "var(--color-success)" : "var(--color-muted-foreground)"}
                      strokeOpacity={edge.live ? 1 : 0.7}
                      strokeWidth={strokeWidth}
                      strokeDasharray={edge.live ? "6,4" : undefined}
                      className={edge.live ? "lb:motion-safe:animate-pulse" : ""}
                      markerEnd={edge.live ? "url(#arrow-live)" : "url(#arrow-default)"}
                    />
                    {/* Badge showing count */}
                    <rect
                      x={midX - 14}
                      y={midY - 10}
                      width="28"
                      height="20"
                      rx="4"
                      fill="var(--color-card)"
                      stroke={edge.live ? "var(--color-success)" : "var(--color-border)"}
                      strokeWidth="1"
                    />
                    <text
                      x={midX}
                      y={midY + 4}
                      textAnchor="middle"
                      fontSize="12"
                      fontWeight="bold"
                      fill={edge.live ? "var(--color-success)" : "var(--color-muted-foreground)"}
                    >
                      {edge.count}
                    </text>
                  </g>
                );
              })}

              {/* Bot Nodes */}
              {nodes.map((node) => {
                const coord = nodeCoordinates.get(node.bot) || { x: 350, y: 240 };
                const botColor = node.display?.color || "#38bdf8";
                const isWorking = node.status === "working";
                const isPaused = node.status === "paused";
                const isOffline = node.status === "offline";

                return (
                  <g
                    key={node.bot}
                    transform={`translate(${coord.x}, ${coord.y})`}
                    className="lb:cursor-pointer lb:group"
                    onClick={() => onSelectBot?.(node.bot)}
                  >
                    {/* Main Node Circle: initials sit on it; a mascot face is drawn whole, without a disc behind it */}
                    {!faceSrc(node.display?.avatar, node.status) && (
                      <circle
                        r="22"
                        fill="var(--color-card)"
                        stroke={botColor}
                        strokeWidth="2"
                      />
                    )}

                    {/* Bot face: a shipped mascot or initials, never a URL as image or text */}
                    {faceSrc(node.display?.avatar, node.status) ? (
                      <image
                        href={faceSrc(node.display?.avatar, node.status)!}
                        x="-24"
                        y="-24"
                        width="48"
                        height="48"
                        preserveAspectRatio="xMidYMid meet"
                      />
                    ) : (
                      <text
                        y="5"
                        textAnchor="middle"
                        fontSize="15"
                        fontWeight="bold"
                        fill="var(--color-foreground)"
                      >
                        {faceText(node)}
                      </text>
                    )}

                    {/* State as a small dot of color at the foot of the node (no ring around it): working, paused, offline */}
                    {(isWorking || isPaused || isOffline) && (
                      <circle
                        data-testid="map-state-dot"
                        cx="17"
                        cy="17"
                        r="5"
                        fill={isWorking ? "var(--color-success)" : isPaused ? "var(--color-warning)" : "var(--color-destructive)"}
                        stroke="var(--color-background)"
                        strokeWidth="2"
                      />
                    )}

                    {/* Bot Label Text */}
                    <text
                      y="38"
                      textAnchor="middle"
                      stroke="var(--color-background)"
                      strokeWidth="4"
                      strokeLinejoin="round"
                      paintOrder="stroke"
                      fontSize="12"
                      fontWeight="bold"
                      fill="var(--color-foreground)"
                    >
                      {node.display?.label || node.bot}
                    </text>

                    {/* Status description */}
                    <text
                      y="50"
                      textAnchor="middle"
                      stroke="var(--color-background)"
                      strokeWidth="4"
                      strokeLinejoin="round"
                      paintOrder="stroke"
                      fontSize="12"
                      fill="var(--color-muted-foreground)"
                    >
                      {botStatusLabel(node.status, t)}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        ) : (
          /* Accessible Keyboard Navigation List View */
          <div
            id="panel-map-accessible"
            role="tabpanel"
            aria-labelledby="tab-map-accessible"
            className="lb:p-4 lb:space-y-6 lb:max-w-4xl lb:mx-auto"
          >
            {/* Section 1: Team Members */}
            <div className="lb:space-y-3">
              <h2 className="lb:text-[13px] lb:font-bold lb:text-[var(--color-muted-foreground)]">
                {t("mapNodesSection")} ({nodes.length})
              </h2>

              <ul className="lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-3" aria-label={t("mapNodesSection")}>
                {nodes.map((node) => {
                  const botColor = node.display?.color || "#38bdf8";
                  const isWorking = node.status === "working";
                  const isPaused = node.status === "paused";
                  const isOffline = node.status === "offline";

                  return (
                    <li
                      key={node.bot}
                      className="lb:p-3.5 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:flex lb:flex-col lb:justify-between lb:gap-2.5"
                    >
                      <div className="lb:flex lb:items-start lb:justify-between lb:gap-2">
                        <div className="lb:flex lb:items-center lb:gap-2.5">
                          <span
                            className="lb:w-3.5 lb:h-3.5 lb:rounded-full lb:shrink-0"
                            style={{ backgroundColor: botColor }}
                          />
                          <div>
                            <span className="lb:text-[13px] lb:font-bold lb:text-[var(--color-card-foreground)] lb:block">
                              {node.display?.label || node.bot}
                            </span>
                            <span className="lb:text-xs lb:text-[var(--color-muted-foreground)] lb:block">
                              @{node.bot} · {node.display?.role || t("btnProfile")}
                            </span>
                          </div>
                        </div>

                        {/* Status Badge */}
                        <span
                          role="status"
                          className={`lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:flex lb:items-center lb:gap-1.5 ${
                            isWorking
                              ? "lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)]"
                              : isPaused
                              ? "lb:bg-[var(--color-warning)]/15 lb:text-[var(--color-warning)]"
                              : isOffline
                              ? "lb:bg-[var(--color-destructive)]/15 lb:text-[var(--color-destructive)]"
                              : "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]"
                          }`}
                        >
                          {isWorking && (
                            <span className="lb:w-1.5 lb:h-1.5 lb:rounded-full lb:bg-[var(--color-success)] lb:motion-safe:animate-pulse" />
                          )}
                          {botStatusLabel(node.status, t)}
                        </span>
                      </div>

                      {/* Current task or spend info */}
                      <div className="lb:text-xs lb:text-[var(--color-muted-foreground)] lb:space-y-1 lb:border-t lb:border-[var(--color-border)]/50 lb:pt-2">
                        <p className="lb:truncate">
                          {node.current_task?.title
                            ? t("mapCurrentTask", { task: node.current_task.title })
                            : t("mapNoTask")}
                        </p>
                        <div className="lb:flex lb:items-center lb:justify-between lb:gap-2">
                          <span>
                            {t("mapRoomsCount", { count: node.rooms?.length || 0 })}
                          </span>
                          <span className="lb:font-mono lb:font-medium lb:text-[var(--color-foreground)]">
                            {t("mapCostWeek", { cost: formatCost(node.week_cost_cents) })}
                          </span>
                        </div>
                      </div>

                      {onSelectBot && (
                        <button
                          type="button"
                          onClick={() => onSelectBot(node.bot)}
                          className="lb:w-full lb:mt-1 lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:hover:bg-[var(--lb-fill-2)] lb:text-[var(--color-card-foreground)] lb:motion-safe:transition-colors lb:min-h-11 lb:md:min-h-7 lb:flex lb:items-center lb:justify-center focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
                        >
                          {t("btnProfile")}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* Section 2: Handoff Connections */}
            <div className="lb:space-y-3">
              <h2 className="lb:text-[13px] lb:font-bold lb:text-[var(--color-muted-foreground)]">
                {t("mapEdgesSection")} ({edges.length})
              </h2>

              {edges.length === 0 ? (
                <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:italic">
                  {t("mapNoEdges")}
                </p>
              ) : (
                <ul className="lb:space-y-2" aria-label={t("mapEdgesSection")}>
                  {edges.map((edge) => (
                    <li
                      key={`${edge.from}->${edge.to}`}
                      data-testid="map-handoff-item"
                      className="lb:p-3 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:flex lb:flex-wrap lb:items-center lb:justify-between lb:gap-3"
                    >
                      <div className="lb:flex lb:items-center lb:gap-3">
                        <span className="lb:font-mono lb:font-bold lb:text-[13px] lb:text-[var(--color-primary)]">
                          @{edge.from}
                        </span>
                        <ArrowRightIcon size={13} className="lb:text-[var(--color-muted-foreground)]" />
                        <span className="lb:font-mono lb:font-bold lb:text-[13px] lb:text-[var(--color-primary)]">
                          @{edge.to}
                        </span>

                        {edge.live && (
                          <span className="lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)] lb:flex lb:items-center lb:gap-1">
                            <span className="lb:w-1.5 lb:h-1.5 lb:rounded-full lb:bg-[var(--color-success)] lb:motion-safe:animate-pulse" />
                            {t("mapLiveHandoffBadge")}
                          </span>
                        )}
                      </div>

                      <div className="lb:flex lb:items-center lb:gap-3">
                        <span className="lb:text-[13px] lb:font-semibold lb:text-[var(--color-foreground)]">
                          {t("mapHandoffsCount", { count: edge.count })}
                        </span>

                        <button
                          type="button"
                          data-testid="map-edge-detail-btn"
                          onClick={() => handleEdgeClick(edge)}
                          className="lb:px-2.5 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-card-foreground)] lb:hover:bg-[var(--lb-fill-2)] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
                        >
                          {t("mapHandoffDrawerTitle")}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Handoff Details Drawer / Modal */}
      <HandoffDetailDrawer
        isOpen={drawerOpen}
        edge={selectedEdge}
        onClose={() => setDrawerOpen(false)}
        onNavigateToKanban={onNavigateToKanban}
      />
    </div>
  );
}
