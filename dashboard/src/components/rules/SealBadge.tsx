// dashboard/src/components/rules/SealBadge.tsx
// INVARIANTE 8: the honest seal of a rule, derived ONLY from the backend's SealResult (never from rule.level). Shared by the
// rules screen and the Bot profile ("Onde aprovar").

import React from "react";
import type { SealResult } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { sealVariant } from "./seal";

export function SealBadge({ sealResult }: { sealResult?: SealResult }) {
  const { t } = useLuveI18n();
  switch (sealVariant(sealResult)) {
    case "unverified":
      return (
        <span
          data-testid="seal-unverified"
          className="lb:inline-flex lb:items-center lb:gap-1 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]"
        >
          {t("sealUnverified")}
        </span>
      );
    case "lock":
      return (
        <span
          data-testid="seal-lock"
          className="lb:inline-flex lb:items-center lb:gap-1.5 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-medium lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)] lb:border-[var(--color-success)]/30"
        >
          <span>🔒</span>
          <span>{t("sealLock")}</span>
        </span>
      );
    case "hand":
      return (
        <span
          data-testid="seal-hand"
          className="lb:inline-flex lb:items-center lb:gap-1.5 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-medium lb:bg-[var(--color-primary)]/15 lb:text-[var(--color-primary)] lb:border-[var(--color-primary)]/30"
        >
          <span>✋</span>
          <span>{t("sealHand")}</span>
        </span>
      );
    case "note":
      return (
        <span
          data-testid="seal-note"
          className="lb:inline-flex lb:items-center lb:gap-1.5 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-medium lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:border-[var(--lb-separator)]"
        >
          <span>💬</span>
          <span>{t("sealNote")}</span>
        </span>
      );
    case "broken":
      return (
        <span
          data-testid="seal-broken"
          className="lb:inline-flex lb:items-center lb:gap-1.5 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-semibold lb:bg-[var(--color-destructive)]/15 lb:text-[var(--color-destructive)] lb:border-[var(--color-destructive)]/40"
        >
          <span>⚠</span>
          <span>{t("sealBroken")}</span>
        </span>
      );
  }
}

/** The "pattern" qualifier (backend rules.py, rules-equivalent-forms): the seal holds for the command forms the pattern
 *  recognizes, not for every way of reaching the same effect. Said next to a real HAND or LOCK, from the SealResult only. */
export function SealCaveat({ sealResult }: { sealResult?: SealResult }) {
  const { t } = useLuveI18n();
  const variant = sealVariant(sealResult);
  if ((variant !== "hand" && variant !== "lock") || !sealResult?.qualifiers?.includes("pattern")) return null;
  return (
    <span data-testid="seal-caveat" className="lb-caption" style={{ display: "block", color: "var(--color-muted-foreground)" }}>
      <span style={{ display: "block", fontWeight: 600 }}>{t(variant === "lock" ? "sealCaveatLock" : "sealCaveatHand")}</span>
      <span style={{ display: "block" }}>{t("sealCaveatWhy")}</span>
    </span>
  );
}
