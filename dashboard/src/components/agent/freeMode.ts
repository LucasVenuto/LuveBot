// dashboard/src/components/agent/freeMode.ts
// Which Bots are in the Livre mode (red team T1): the owner must SEE a Bot that asks nothing, not only inside its profile. /bots carries each
// Bot's `approval_mode` (absent when the server could not read it) and the app already re-reads /bots every 15 s while visible, so the chip
// needs no read of its own. The Perfil, which just read or saved the mode, announces it at once (announceMode); that answer is the newest
// one the page has, so it is held for HOLD_MS against a /bots read that was already on its way. The mode is only ever shown, never decided.
import React from "react";
import type { ApprovalSurfaceMode, Bot } from "../../api/types";

export const HOLD_MS = 30_000;
export const SILENT_POLLS = 3;   // /bots reads in a row that did not say a Bot's mode (it said it before) before the chip says "não confirmado"
const announced = new Map<string, { mode: ApprovalSurfaceMode; at: number }>();
const known = new Map<string, ApprovalSurfaceMode>();   // the last mode the server (or the Perfil) said, kept when a later /bots cannot say it
const listeners = new Set<() => void>();
const silent = new Map<string, { n: number; seen: Bot[] | null }>();   // per Bot: consecutive /bots reads without its mode, each read (array) counted once

/** The Perfil just read or changed a Bot's mode: every chip follows now, without waiting for the next /bots. */
export function announceMode(bot: string, mode: ApprovalSurfaceMode): void {
  if (announced.get(bot)?.mode === mode) return;
  announced.set(bot, { mode, at: Date.now() });
  known.set(bot, mode);
  listeners.forEach((f) => f());
}

function settle(bot: Bot): ApprovalSurfaceMode | undefined {
  const held = announced.get(bot.name);
  const mode = held && Date.now() - held.at < HOLD_MS ? held.mode : bot.approval_mode ?? known.get(bot.name);
  if (mode) known.set(bot.name, mode);   // a Bot whose mode cannot be read keeps its last known one: never "free" or "not free" by a guess
  return mode;
}

/** The last known mode is no longer confirmed: /bots said this Bot's mode before and has not for SILENT_POLLS reads in a row. A Bot whose mode was never said
 *  (an older backend has no field at all) is not "unknown", it is as it always was. A Bot last known as Livre keeps its Livre chip instead (the risky state is shown). */
function unconfirmed(bot: Bot, loaded: Bot[], mode: ApprovalSurfaceMode | undefined): boolean {
  const held = announced.get(bot.name);
  if (bot.approval_mode || (held && Date.now() - held.at < HOLD_MS)) { silent.delete(bot.name); return false; }
  if (!known.has(bot.name) || mode === "free") return false;
  const entry = silent.get(bot.name) ?? { n: 0, seen: null };
  if (entry.seen !== loaded) { entry.n++; entry.seen = loaded; }
  silent.set(bot.name, entry);
  return entry.n >= SILENT_POLLS;
}

/** `loaded` with each Bot's `approval_mode` settled (the Perfil's fresh word, else /bots, else the last known). A Bot stays the same object when nothing changes. */
export function useApprovalModes(loaded: Bot[]): Bot[] {
  const [rev, bump] = React.useState(0);
  React.useEffect(() => {
    const on = () => bump((n) => n + 1);
    listeners.add(on);
    return () => { listeners.delete(on); };
  }, []);
  return React.useMemo(() => loaded.map((b) => { const mode = settle(b), unknown = unconfirmed(b, loaded, mode); return mode === b.approval_mode && !unknown ? b : { ...b, approval_mode: mode, ...(unknown ? { approval_unknown: true } : {}) }; }), [loaded, rev]); // eslint-disable-line react-hooks/exhaustive-deps
}
