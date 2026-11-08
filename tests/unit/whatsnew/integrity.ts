// tests/unit/whatsnew/integrity.ts
// The rules of the list of "Novidades" (docs/contracts/whats-new-v0.md sections 1, 4 and 5), as one function that returns what is wrong with a list. The tests run it on the real
// lists and, to prove it sees what it must, on lists made wrong on purpose.
import TABLE from "../../../backend/unicode_invisible.json";
import { TAB_IDS } from "@/components/messenger/MessengerShell";
import { NEWS_CAPS, type NewsItem, type NewsVersionInfo } from "@/whatsnew/types";

const HIDDEN = new RegExp("[" + [...TABLE.refuse, ...TABLE.mark].map(([a, b]: number[]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join("") + "]", "u");
/** No internal reference in what a person reads: a decision, requirement, task or issue number, or the name of an agent. */
export const INTERNAL = /\b(?:A|R|D|T|NV|BR|RD|EV|SK|P|F|K|M|N|ADR|COMPAT)-\d+[a-z]?\b|#\d+|\b(?:Prumo|Forja|Brasa|Lume|Mochi|Vitral|Prisma|Pena|Maestro)\b/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELDS = ["title", "what", "where", "note"] as const;

export function problemsOf(items: readonly NewsItem[], versions: readonly NewsVersionInfo[], extraTabs: readonly string[] = []): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  const tabs = new Set<string>([...TAB_IDS, ...extraTabs]);
  for (const item of items) {
    const at = item.id;
    if (!KEBAB.test(item.id)) out.push(`${at}: id is not kebab-case`);
    if (ids.has(item.id)) out.push(`${at}: duplicate id`);
    ids.add(item.id);
    if (!versions.some((v) => v.version === item.since)) out.push(`${at}: since ${item.since} has no version entry`);
    for (const field of FIELDS) {
      const pair = item[field];
      if (pair === undefined) { if (field !== "note") out.push(`${at}: ${field} missing`); continue; }
      for (const lang of ["pt", "en"] as const) {
        const text = pair[lang];
        if (typeof text !== "string" || text.trim() === "") { out.push(`${at}: ${field}.${lang} is empty`); continue; }
        if ([...text].length > NEWS_CAPS[field]) out.push(`${at}: ${field}.${lang} is over ${NEWS_CAPS[field]} characters`);
        if (HIDDEN.test(text)) out.push(`${at}: ${field}.${lang} holds a character of the hidden-characters table`);
        if (INTERNAL.test(text)) out.push(`${at}: ${field}.${lang} holds an internal reference`);
      }
    }
    if (item.go !== undefined && !tabs.has(item.go)) out.push(`${at}: go "${item.go}" is not a whole tab`);
  }
  for (const v of versions) {
    if (v.status === "released" && !/^\d{4}-\d{2}-\d{2}$/.test(v.date ?? "")) out.push(`${v.version}: released needs a date`);
    if (v.status === "unreleased" && v.date) out.push(`${v.version}: unreleased has a date`);
  }
  return out;
}
