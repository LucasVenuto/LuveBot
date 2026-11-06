// dashboard/src/components/activity/ActivityInsights.tsx
// The two views of Atividade that draw a stretch of time (spec 4.7 and section 7 items 2 and 6; contract v0.8 §2): the Timeline in
// lanes and the Heatmap Bots × hours. Each asks its own READ route, draws what comes back with the components of this folder, and
// says in words when it could not. A mark opens the screen that already holds the thing (the Bot's conversation, the approvals
// inbox, Routines, the team map); nothing is decided or changed from here.

import React from "react";
import type { Bot, HeatmapResponse, TimelineBlock, TimelineResponse } from "../../api/types";
import { getActivityHeatmap, getActivityTimeline } from "../../api/client";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";
import { Heatmap, type HeatmapDays } from "./Heatmap";
import { Timeline } from "./Timeline";

/** The windows of the Timeline (the route takes at most 7 days). */
export const TIMELINE_WINDOWS = [
  { hours: 24, label: "tlWindow24h" },
  { hours: 72, label: "tlWindow3d" },
  { hours: 168, label: "tlWindow7d" },
] as const satisfies readonly { hours: number; label: TranslationKey }[];
type WindowHours = (typeof TIMELINE_WINDOWS)[number]["hours"];

export type InsightsTab = "aprovacoes" | "rotinas" | "mapa";

interface Read<T> { data: T | null; error: ErrorState | null; loading: boolean }

/** One read per change of `key`; the previous answer stays on screen while the next one loads, and a late answer to an old ask is dropped. */
function useRead<T>(read: () => Promise<T>, key: string, failure: TranslationKey): Read<T> {
  const { t } = useLuveI18n();
  const [state, setState] = React.useState<Read<T>>({ data: null, error: null, loading: true });
  const latest = React.useRef(read);
  latest.current = read;
  React.useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, error: null, loading: true }));
    latest.current().then(
      (data) => { if (alive) setState({ data, error: null, loading: false }); },
      (e) => { if (alive) setState((s) => ({ ...s, error: humanError(e, t, failure), loading: false })); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

function Status<T>({ read, retry }: { read: Read<T>; retry: () => void }) {
  const { t } = useLuveI18n();
  return (
    <>
      {read.loading && !read.data && <p role="status" className="lb-caption" style={{ margin: "12px 4px" }}>{t("insightsLoading")}</p>}
      {read.error && (
        <p role="alert" className="lb-caption" style={{ margin: "12px 4px", color: "var(--color-destructive)" }}>
          <ErrorNote error={read.error} /> <button type="button" className="lb-btn-plain" onClick={retry}>{t("retry")}</button>
        </p>
      )}
    </>
  );
}

export interface TimelinePanelProps {
  bots?: Bot[];
  /** Bumped by the screen's "Atualizar". */
  refreshKey?: number;
  onOpenConversation?: (bot: string) => void;
  onNavigateTab?: (tab: InsightsTab) => void;
}

export function TimelinePanel({ bots = [], refreshKey = 0, onOpenConversation, onNavigateTab }: TimelinePanelProps) {
  const { t } = useLuveI18n();
  const [hours, setHours] = React.useState<WindowHours>(24);
  const [retries, setRetries] = React.useState(0);
  const read = useRead<TimelineResponse & { since: number; until: number }>(async () => {
    const until = Math.floor(Date.now() / 1000), since = until - hours * 3600;   // fixed when asked: the axis and the answer agree
    return { ...(await getActivityTimeline({ since, until })), since, until };
  }, `${hours}:${refreshKey}:${retries}`, "tlError");

  const openBlock = (block: TimelineBlock, bot: string) => (block.kind === "routine" ? onNavigateTab?.("rotinas") : onOpenConversation?.(bot));
  return (
    <section data-testid="activity-timeline" aria-busy={read.loading}>
      <div className="lb-segmented lb-segmented-fit" role="group" aria-label={t("tlWindowLabel")} style={{ marginBottom: 12, maxWidth: 360 }}>
        {TIMELINE_WINDOWS.map((w) => (
          <button key={w.hours} type="button" className="lb-segment" aria-pressed={w.hours === hours} onClick={() => setHours(w.hours)} data-testid={`tl-window-${w.hours}`}>
            {t(w.label)}
          </button>
        ))}
      </div>
      <Status read={read} retry={() => setRetries((n) => n + 1)} />
      {read.data && (
        <Timeline data={read.data} since={read.data.since} until={read.data.until} bots={bots}
          onOpenBlock={openBlock} onOpenApproval={() => onNavigateTab?.("aprovacoes")} onOpenHandoff={() => onNavigateTab?.("mapa")} />
      )}
    </section>
  );
}

/** The browser's own zone: the hours of the Heatmap are the person's hours. */
const zoneOfBrowser = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

export function HeatmapPanel({ bots = [], refreshKey = 0 }: { bots?: Bot[]; refreshKey?: number }) {
  const [days, setDays] = React.useState<HeatmapDays>(28);
  const [retries, setRetries] = React.useState(0);
  const tz = React.useMemo(zoneOfBrowser, []);
  const read = useRead<HeatmapResponse>(() => getActivityHeatmap(days, tz), `${days}:${refreshKey}:${retries}`, "hmError");
  return (
    <section data-testid="activity-heatmap" aria-busy={read.loading}>
      <Status read={read} retry={() => setRetries((n) => n + 1)} />
      {read.data && <Heatmap data={read.data} days={days} onDaysChange={setDays} bots={bots} tz={tz} />}
    </section>
  );
}
