// dashboard/src/components/rules/HermesGate.tsx
// Simulator, side by side (F6.3, C-4): what LuveBot would do with the command and what HERMES's own approval gate would do. It is the answer
// to "I turned Free on and it still asks": in Free LuveBot does not ask, Hermes still can. Every sentence is ours, chosen by the backend's
// `verdict`, `caveats` and `reason` codes (Hermes's own text never reaches here); a code the UI does not know says nothing rather than a
// guess (invariant 8). "Free" for the LuveBot side comes from the winning rule's SealResult (problem `free_mode`), never from the level.

import React from "react";
import type { HermesGate, RuleLevel, SealResult } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";

const LUVE: Record<RuleLevel, TranslationKey> = {
  allow: "gateLuveAllow", explicit: "gateLuveAllow", ask: "gateLuveAsk", handback: "gateLuveHandback", block: "gateLuveBlock",
};
const HERMES: Record<string, TranslationKey> = {
  allow: "gateHermesAllow", ask: "gateHermesAsk", hardline_deny: "gateHermesHardline", user_deny: "gateHermesUserDeny",
};
const CAVEAT: Record<string, TranslationKey> = {
  approvals_off: "gateCaveat_approvals_off", session_yolo_not_seen: "gateCaveat_session_yolo_not_seen", docker_host_access_not_seen: "gateCaveat_docker_host_access_not_seen",
};
const UNAVAILABLE: Record<string, TranslationKey> = {
  hermes_without_dry_run: "gateUnavailable_hermes_without_dry_run", unreadable: "gateUnavailable_unreadable", command_too_long: "gateUnavailable_command_too_long",
};

/** The Bot's LuveBot does not ask because the winning ask rule's own seal says so (the backend's `free_mode` problem). */
export const isFreeSeal = (seal?: SealResult) => !!seal?.problems?.some((p) => p.code === "free_mode");

export function HermesGateRow({ gate, effect, winnerSeal }: { gate?: HermesGate | null; effect: RuleLevel; winnerSeal?: SealResult }) {
  const { t } = useLuveI18n();
  if (!gate) return null;  // an older backend, or not a terminal command: nothing to compare
  const free = effect === "ask" && isFreeSeal(winnerSeal);
  const luve = free ? t("gateLuveFree") : LUVE[effect] ? t(LUVE[effect]) : null;
  const known = gate.available && HERMES[gate.verdict];
  const side = (who: TranslationKey, what: string | null) => (
    <div style={{ flex: "1 1 200px", padding: "8px 12px", borderRadius: 12, background: "var(--color-card)", border: "1px solid var(--lb-separator)" }}>
      <div className="lb-caption" style={{ color: "var(--color-muted-foreground)" }}>{t(who)}</div>
      <div data-testid={who === "gateLuveBot" ? "gate-luvebot" : "gate-hermes"} className="lb-body" style={{ fontWeight: 600 }}>{what}</div>
    </div>
  );
  const note = !gate.available ? t(UNAVAILABLE[gate.reason] ?? "gateUnavailable_unreadable")
    : !known ? t("gateUnavailable_unreadable") : null;
  const notes = [
    free && gate.available && gate.verdict === "ask" ? t("gateFreeStillAsks") : null,
    free && gate.available && (gate.verdict === "hardline_deny" || gate.verdict === "user_deny") ? t("gateFreeStillBlocks") : null,
    ...(gate.available ? (gate.caveats ?? []).filter((c) => CAVEAT[c]).map((c) => t(CAVEAT[c])) : []),
  ].filter((x): x is string => !!x);
  return (
    <section data-testid="hermes-gate" aria-label={t("gateTitle")} style={{ display: "grid", gap: 8 }}>
      <div className="lb-caption" style={{ color: "var(--color-muted-foreground)" }}>{t("gateTitle")}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {luve && side("gateLuveBot", luve)}
        {gate.available && known ? side("gateHermes", t(HERMES[gate.verdict])) : null}
      </div>
      {note && <p data-testid="hermes-gate-note" className="lb-caption" style={{ margin: 0, color: "var(--color-muted-foreground)" }}>{note}</p>}
      {notes.map((n, i) => <p key={i} className="lb-caption" style={{ margin: 0, color: "var(--color-muted-foreground)" }}>{n}</p>)}
    </section>
  );
}
