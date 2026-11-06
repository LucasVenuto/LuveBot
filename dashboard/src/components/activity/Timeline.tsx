// dashboard/src/components/activity/Timeline.tsx
// Timeline in lanes (spec 4.7 and section 7 item 2; contract v0.8 §2): a lane per Bot, a block per task, a diamond per
// approval, a line per handoff. Draws what GET /activity/timeline returns, nothing more: every mark is a button that opens the
// existing card (the parent decides which), and the title of a task is the agent's text, so it is only ever text.
// One coordinate system: x is the share of the window, y is pixels down the lanes (heights are computed here, so the
// handoff lines know where each lane is).

import React, { useMemo } from "react";
import type { Bot, TimelineBlock, TimelineResponse } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { displayName } from "../../lib/botName";
import { Avatar } from "../ui/Avatar";
import { botColor, tint } from "../ui/color";
import { displayFace } from "../ui/mascots";
import { EmptyArt } from "../ui/EmptyArt";
import { activityStatusLabel, activityTitle, approvalStateLabel, handoffStateLabel } from "../labels";

export interface TimelineProps {
  data: TimelineResponse;
  /** The window asked for, epoch seconds. */
  since: number;
  until: number;
  /** Epoch seconds; a running task ends here. Defaults to the clock. */
  now?: number;
  bots?: Bot[];
  onOpenBlock?: (block: TimelineBlock, bot: string) => void;
  onOpenApproval?: (id: string) => void;
  onOpenHandoff?: (id: string) => void;
}

const TOP = 20, ROW = 24, BOTTOM = 8, MIN_LANE = 56;   // px: the approvals row, then one row per overlap level
const OPEN = new Set(["running", "waiting_approval"]);

/** Overlapping tasks of one Bot go on rows below each other (first row that is free at the start). */
function pack(blocks: TimelineBlock[], now: number, span: number) {
  const rows: number[] = [];
  return [...blocks].sort((a, b) => a.start - b.start).map((b) => {
    const end = b.end ?? (OPEN.has(b.status) ? now : null);
    const last = Math.max(end ?? b.start, b.start + span * 0.01);   // a point still takes a little room
    let row = rows.findIndex((r) => r <= b.start);
    if (row < 0) { row = rows.length; rows.push(0); }
    rows[row] = last;
    return { block: b, end, row };
  });
}

/** Tick marks on whole local hours (or midnights) that fit about eight across the window. */
function ticks(since: number, until: number): { at: number; day: boolean }[] {
  const span = until - since, hours = [1, 3, 6, 12].find((h) => span / (h * 3600) <= 9);
  const d = new Date(since * 1000);
  d.setMinutes(0, 0, 0);
  const out: { at: number; day: boolean }[] = [];
  if (!hours) {   // days
    d.setHours(0);
    for (d.setDate(d.getDate() + 1); d.getTime() / 1000 < until; d.setDate(d.getDate() + 1)) out.push({ at: d.getTime() / 1000, day: true });
    return out;
  }
  for (d.setHours(d.getHours() + 1); d.getTime() / 1000 < until; d.setHours(d.getHours() + 1))
    if (d.getHours() % hours === 0) out.push({ at: d.getTime() / 1000, day: false });
  return out;
}

export function Timeline({ data, since, until, now = Date.now() / 1000, bots = [], onOpenBlock, onOpenApproval, onOpenHandoff }: TimelineProps) {
  const { locale, t } = useLuveI18n();
  const span = Math.max(1, until - since);
  const x = (at: number) => Math.min(100, Math.max(0, ((at - since) / span) * 100));
  const lang = locale === "pt" ? "pt-BR" : "en-US";
  const clock = (at: number) => new Date(at * 1000).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  const dayName = (at: number) => new Date(at * 1000).toLocaleDateString(lang, { weekday: "short", day: "numeric" });
  const when = (at: number) => (span > 86400 ? `${dayName(at)} ${clock(at)}` : clock(at));

  const byName = useMemo(() => new Map(bots.map((b) => [b.name, b])), [bots]);
  const who = (name: string) => {
    const b = byName.get(name);
    return { label: displayName(name, b?.display?.label), color: b?.display?.color ?? null, avatar: displayFace(name, b?.display?.avatar) };
  };

  // Lanes: the Bots with tasks, then any Bot that only appears in an approval or a handoff.
  const lanes = useMemo(() => {
    const names = [...data.lanes.map((l) => l.bot)];
    for (const n of [...data.approvals.map((a) => a.bot), ...data.handoffs.flatMap((h) => [h.from, h.to])]) if (!names.includes(n)) names.push(n);
    let top = 0;
    return names.map((bot) => {
      const placed = pack(data.lanes.find((l) => l.bot === bot)?.blocks ?? [], now, span);
      const rows = Math.max(1, ...placed.map((p) => p.row + 1));
      const height = Math.max(MIN_LANE, TOP + rows * ROW + BOTTOM);
      const lane = { bot, placed, top, height };
      top += height;
      return lane;
    });
  }, [data, now, span]);
  const laneOf = new Map(lanes.map((l) => [l.bot, l]));
  const total = lanes.reduce((h, l) => h + l.height, 0);
  const empty = !lanes.length || (!data.approvals.length && !data.handoffs.length && lanes.every((l) => !l.placed.length));

  if (empty) {
    return (
      <div className="lb-group lb-empty" data-testid="timeline-empty">
        <EmptyArt kind="timeline" />
        <p className="lb-headline">{t("tlEmptyTitle")}</p>
        <p className="lb-subhead">{t("tlEmptyHint")}</p>
      </div>
    );
  }

  const marks = ticks(since, until);
  const nowIn = now > since && now < until, nearNow = (at: number) => nowIn && Math.abs(x(at) - x(now)) < 5;   // the "agora" label wins
  return (
    <div className="lb-group lb-tl" role="group" aria-label={t("tlLabel")} data-testid="timeline">
      {data.partial?.length ? <p className="lb-caption lb-tl-note">{t("activityPartialWarning", { sources: data.partial.join(", ") })}</p> : null}
      <div className="lb-tl-scroll">
        <div className="lb-tl-body">
          <div className="lb-tl-axis" aria-hidden="true">
            <span />
            <div className="lb-tl-track">
              {marks.filter((m) => !nearNow(m.at)).map((m) => <span key={m.at} className="lb-caption lb-tl-tick" style={{ left: `${x(m.at)}%` }}>{m.day ? dayName(m.at) : clock(m.at)}</span>)}
              {nowIn && <span className="lb-caption lb-tl-tick lb-tl-now-label" style={{ left: `${x(now)}%` }}>{t("tlNow")}</span>}
            </div>
          </div>
          <div className="lb-tl-lanes" style={{ height: total }}>
            {lanes.map((l) => {
              const w = who(l.bot);
              return (
                <div key={l.bot} className="lb-tl-lane" style={{ top: l.top, height: l.height }}>
                  <div className="lb-tl-who">
                    <Avatar name={w.label} avatar={w.avatar} color={w.color} size={28} />
                    <span className="lb-tl-name">{w.label}</span>
                  </div>
                </div>
              );
            })}
            <div className="lb-tl-marks">
              {marks.map((m) => <span key={m.at} className="lb-tl-grid" style={{ left: `${x(m.at)}%` }} aria-hidden="true" />)}
              {nowIn && <span className="lb-tl-grid lb-tl-now" style={{ left: `${x(now)}%` }} aria-hidden="true" />}
              {lanes.flatMap((l) => {
                const w = who(l.bot), color = botColor(w.color);
                return l.placed.map(({ block, end, row }) => {
                  const title = activityTitle({ kind: block.kind === "routine" ? "routine_run" : "run", title: block.title }, t);
                  const status = activityStatusLabel(block.status, t);
                  const label = end === null
                    ? t("tlBlockPointAria", { bot: w.label, title, status, at: when(block.start) })
                    : t("tlBlockAria", { bot: w.label, title, status, from: when(block.start), to: when(end) });
                  const style: React.CSSProperties = { left: `${x(block.start)}%`, top: l.top + TOP + row * ROW };
                  if (end !== null) Object.assign(style, { width: `${x(end) - x(block.start)}%`, background: tint(w.color, 24), borderLeftColor: color });
                  else style.background = color;
                  return (
                    <button key={`${l.bot}-${block.id}`} type="button" aria-label={label} title={label} style={style}
                      className={`lb-tl-block${end === null ? " is-point" : ""} is-${block.status}`} data-testid={`tl-block-${block.id}`}
                      onClick={() => onOpenBlock?.(block, l.bot)}>
                      {end !== null && x(end) - x(block.start) >= 6 && <span className="lb-tl-title">{title}</span>}
                    </button>
                  );
                });
              })}
              {data.approvals.map((a) => {
                const l = laneOf.get(a.bot)!, label = t("tlApprovalAria", { bot: who(a.bot).label, state: approvalStateLabel(a.status, t), at: when(a.at) });
                return (
                  <button key={`ap-${a.id}`} type="button" aria-label={label} title={label} data-testid={`tl-approval-${a.id}`}
                    className={`lb-tl-diamond${a.status === "pending" ? " is-pending" : ""}`} style={{ left: `${x(a.at)}%`, top: l.top + TOP / 2 }}
                    onClick={() => onOpenApproval?.(a.id)} />
                );
              })}
              {data.handoffs.map((h) => {
                const [from, to] = [laneOf.get(h.from)!, laneOf.get(h.to)!], [y1, y2] = [from.top + from.height / 2, to.top + to.height / 2];
                const w = who(h.from), label = t("tlHandoffAria", { from: w.label, to: who(h.to).label, state: handoffStateLabel(h.status, t), at: when(h.at) });
                return (
                  <React.Fragment key={`ho-${h.id}`}>
                    <span className="lb-tl-link" aria-hidden="true"
                      style={{ left: `${x(h.at)}%`, top: Math.min(y1, y2), height: Math.abs(y2 - y1), borderLeftColor: botColor(w.color) }} />
                    <button type="button" aria-label={label} title={label} data-testid={`tl-handoff-${h.id}`} className="lb-tl-handoff"
                      style={{ left: `${x(h.at)}%`, top: y2, background: botColor(w.color) }} onClick={() => onOpenHandoff?.(h.id)} />
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
