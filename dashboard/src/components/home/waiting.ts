// dashboard/src/components/home/waiting.ts
// "Bot esperando você" (contract v0.9 §7): what the Bots wait for a person to do, as the hook SAW it (it only observes; invariant 6: nothing
// here answers anything). Reading it makes the backend look at every Bot's rows, so: only with the tab visible, never more than once in 30 s,
// shared by every screen that shows it. The sentences are ours, chosen by `kind` and `platform`; only a clarify's own question is the Bot's
// text, and it is shown as plain text.

import React from "react";
import { getWaiting } from "../../api/client";
import type { WaitingItem, WaitingResponse } from "../../api/types";
import type { TranslationKey } from "../../i18n";
import { displayQuestion } from "../../lib/clarifyText";

export const WAIT_MIN_MS = 30_000;
const POLL_MS = 31_000;

// ponytail: one read per 30 s for the whole page; a per-Bot read only if a screen ever needs a Bot alone
let attemptAt = 0;
let last: WaitingResponse | null = null;
let flight: Promise<void> | null = null;
async function readWaiting(): Promise<WaitingResponse | null> {
  if (Date.now() - attemptAt >= WAIT_MIN_MS) {
    attemptAt = Date.now();  // a failed read counts too: no hammering
    flight ??= getWaiting().then(
      (r) => { if (Array.isArray(r?.waiting)) last = { waiting: r.waiting, partial: Array.isArray(r.partial) ? r.partial : [] }; },
      () => { /* what was known stays; a failed read is never "nobody waits" on its own */ },
    ).finally(() => { flight = null; });
  }
  await flight;
  return last;
}

/** The waits, newest first, refreshed while the page is visible. `null` until a read came back. */
export function useWaiting(enabled: boolean): WaitingResponse | null {
  const [data, setData] = React.useState<WaitingResponse | null>(enabled ? last : null);
  React.useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => { if (document.visibilityState !== "hidden") void readWaiting().then((r) => { if (alive && r) setData(r); }); };
    load();
    const id = window.setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => { alive = false; window.clearInterval(id); document.removeEventListener("visibilitychange", load); };
  }, [enabled]);
  return data;
}

const TITLE: Record<string, TranslationKey> = { clarify: "waitClarify", sudo: "waitSudo", approval: "waitApproval" };

/** What a wait is and where the person has to go. A wait in LuveBot's own conversation (platform api_server, or none known) is the
 *  card in that conversation: `inLuveBot` offers it. The Bot's question, when it has one, is the title as plain text. */
export function waitView(w: WaitingItem, t: (k: TranslationKey, p?: Record<string, string | number>) => string): { title: string; where: string; inLuveBot: boolean } {
  const cli = w.platform === "cli", telegram = w.platform === "telegram";
  const inLuveBot = w.kind === "clarify" && (w.platform === null || w.platform === "api_server");
  // the Bot's question, as plain text; where the answer is in LuveBot the skip sentence Hermes appends is not shown (it promises a skip this surface does not do, contract v0.11 §4.1)
  const question = w.kind === "clarify" && w.prompt ? (inLuveBot ? displayQuestion(w.prompt) : w.prompt).trim() : "";
  const title = question || t(TITLE[w.kind] ?? "waitOther");
  const where =
    w.kind === "sudo" ? t("waitWhereSudo")
    : w.kind === "clarify" ? t(inLuveBot ? "waitWhereLuveBot" : cli ? "waitWhereClarifyTerminal" : telegram ? "waitWhereClarifyTelegram" : "waitWhereClarifyChannel")
    : w.kind === "approval" ? t(cli ? "waitWhereApprovalTerminal" : telegram ? "waitWhereApprovalTelegram" : "waitWhereApprovalChannel")
    : t("waitWhereOther");
  return { title, where, inLuveBot };
}

/** "desde 14:05" today, "desde 20 de out., 14:05" another day (the contract keeps waits for 24 h). */
export function sinceText(epoch: number, locale: string, t: (k: TranslationKey, p?: Record<string, string | number>) => string): string {
  const d = new Date(epoch * 1000), loc = locale === "pt" ? "pt-BR" : "en-US";
  const time = d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
  return t("waitSince", { when: d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(loc, { day: "numeric", month: "short" })}, ${time}` });
}
