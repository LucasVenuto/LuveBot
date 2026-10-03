// dashboard/src/sound/cues.ts
// LuveBot's two sounds (CEO): a soft blip when a Bot has a new message, two rising tones when a Bot needs you (an approval
// or a question). Made in the browser with Web Audio (no file, no dependency), short (< 300 ms) and quiet. They play only
// when the person is not looking at that Bot (the tab out of focus, or another screen open), never for the person's own
// doing (a decision, a Bot just created), at most one every 2 s, and only after the first click or key on the page (the
// browser's autoplay rule). Preference per browser: all / only what needs you / off; default all.

import React from "react";
import type { Bot } from "../api/types";

export type Cue = "message" | "needs_you";
export type SoundPref = "all" | "needs_you" | "off";

const KEY = "luvebot.sounds";
export const MIN_GAP_MS = 2000;

export function readSoundPref(): SoundPref {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "needs_you" || v === "off" ? v : "all";
  } catch { return "all"; }
}

export function writeSoundPref(p: SoundPref): void {
  try { if (p === "all") window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, p); } catch { /* kept for this page only */ }
}

let ctx: AudioContext | null = null;
let last = -Infinity;

/** From a click or key on the page, the only moment a browser lets audio start. */
function unlock(): void {
  if (ctx) return;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  try { ctx = new AC(); void ctx.resume?.(); } catch { ctx = null; }
}

/** A short tone with a soft attack and an exponential fade (no click at either end). */
function tone(c: AudioContext, freq: number, at: number, dur: number, peak: number, type: OscillatorType, glideTo?: number) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur * 0.6);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g);
  g.connect(c.destination);
  o.start(at);
  o.stop(at + dur + 0.02);
}

function synth(c: AudioContext, cue: Cue) {
  const t = c.currentTime + 0.01;
  if (cue === "message") tone(c, 740, t, 0.16, 0.05, "sine", 988);           // one soft rising blip, 160 ms
  else { tone(c, 659, t, 0.12, 0.06, "triangle"); tone(c, 988, t + 0.13, 0.14, 0.06, "triangle"); }  // E5 → B5, 270 ms
}

/** The person is looking at this Bot: the tab is in front and in focus, and this Bot's conversation is open. */
export function looking(bot: string, openBot: string | null): boolean {
  return document.visibilityState !== "hidden" && document.hasFocus() && openBot === bot;
}

/** Plays `cue` for `bot` if the preference, the autoplay unlock, the 2 s gap and "not looking" all allow; true if it did. */
export function playCue(cue: Cue, bot: string, openBot: string | null): boolean {
  const pref = readSoundPref();
  if (pref === "off" || (pref === "needs_you" && cue === "message")) return false;
  if (!ctx || looking(bot, openBot)) return false;
  const now = Date.now();
  if (now - last < MIN_GAP_MS) return false;
  last = now;
  try { synth(ctx, cue); } catch { return false; }
  return true;
}

type Seen = { replies?: number; routines?: number; waiting: boolean };
const seenOf = (b: Bot): Seen => {
  const u = (b as { unread?: unknown }).unread as { replies?: unknown; routine_results?: unknown } | undefined;
  return {
    replies: typeof u?.replies === "number" ? u.replies : undefined,
    routines: typeof u?.routine_results === "number" ? u.routine_results : undefined,
    waiting: b.status === "waiting_approval",
  };
};
const grew = (now?: number, before?: number) => now !== undefined && before !== undefined && now > before;

/**
 * Listens to what the app already refreshes (the Bot list, the pending approvals) and plays a cue when something NEW
 * arrives from a Bot. The first answer of each is the baseline (nothing is new on load), a Bot not seen before is
 * skipped (just created: the person's own doing), and a count that goes down (a decision) never sounds.
 * `bots`/`pending` are null until they loaded.
 */
export function useCues(bots: Bot[] | null, pending: Record<string, number> | null, openBot: string | null): void {
  const seen = React.useRef<Map<string, Seen> | null>(null);
  const waiting = React.useRef<Record<string, number> | null>(null);
  const fresh = React.useRef<Set<string>>(new Set());  // Bots that appeared in the latest list: not counted yet
  const open = React.useRef(openBot);
  open.current = openBot;

  React.useEffect(() => {
    const on = () => { unlock(); off(); };
    const off = () => { document.removeEventListener("pointerdown", on, true); document.removeEventListener("keydown", on, true); };
    document.addEventListener("pointerdown", on, true);
    document.addEventListener("keydown", on, true);
    return off;
  }, []);

  React.useEffect(() => {
    if (!bots) return;
    const before = seen.current;
    seen.current = new Map(bots.map((b) => [b.name, seenOf(b)]));
    if (!before) return;
    fresh.current = new Set([...seen.current.keys()].filter((name) => !before.has(name)));
    const needs: string[] = [];
    const news: string[] = [];
    for (const [name, s] of seen.current) {
      const p = before.get(name);
      if (!p) continue;
      if (s.waiting && !p.waiting) needs.push(name);
      if (grew(s.replies, p.replies) || grew(s.routines, p.routines)) news.push(name);
    }
    void (needs.some((b) => playCue("needs_you", b, open.current)) || news.some((b) => playCue("message", b, open.current)));
  }, [bots]);

  React.useEffect(() => {
    if (!pending) return;
    const before = waiting.current;
    waiting.current = pending;
    if (!before) return;
    void Object.keys(pending).some((b) => !!seen.current?.has(b) && !fresh.current.has(b) && pending[b] > (before[b] ?? 0) && playCue("needs_you", b, open.current));
  }, [pending]);
}
