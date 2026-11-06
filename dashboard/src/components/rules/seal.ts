// dashboard/src/components/rules/seal.ts
// Invariant 8: what a rule's seal says comes ONLY from the backend SealResult, never from rule.level.
// Anything the backend did not name as lock/hand/note is shown as broken, so a new seal can never look safer.

import type { RuleWithSeal, SealResult } from "../../api/types";

export type SealVariant = "unverified" | "lock" | "hand" | "note" | "broken";

export function sealVariant(r?: SealResult): SealVariant {
  if (!r || !r.seal) return "unverified";
  switch (r.seal) {
    case "lock": return "lock";
    case "hand": return "hand";
    case "note": case "none": return "note";
    default: return "broken";
  }
}

/** The backend's `free_mode` problem is the ONLY thing wrong with this seal: the Bot is in Free mode, so a rule that asks does not
 *  ask (a choice, not a break). Any other problem next to it (hook_stale…) is a real break and keeps the normal alarm. */
export function onlyFreeMode(r?: SealResult): boolean {
  const codes = (r?.problems ?? []).map((p) => p.code);
  return codes.length > 0 && codes.every((c) => c === "free_mode");
}

export type RuleFilter = { botName?: string; level: string; state: string; query: string }; // "all" = no filter

/** Scoped to a Bot: that Bot's rules plus every non-bot scope (global, room, routine). */
export function filterRules(rules: readonly RuleWithSeal[], f: RuleFilter): RuleWithSeal[] {
  const q = f.query.trim().toLowerCase();
  return rules.filter(({ rule }) => {
    if (f.botName && rule.scope.kind === "bot" && rule.scope.ref !== f.botName) return false;
    if (f.level !== "all" && rule.level !== f.level) return false;
    if (f.state !== "all" && rule.state !== f.state) return false;
    if (q && !rule.label.toLowerCase().includes(q)
      && !rule.match.tools?.some((x) => x.toLowerCase().includes(q))
      && !rule.match.commands?.some((x) => x.toLowerCase().includes(q))) return false;
    return true;
  });
}
