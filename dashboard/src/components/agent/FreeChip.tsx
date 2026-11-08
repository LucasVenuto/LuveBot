// dashboard/src/components/agent/FreeChip.tsx
// "Livre" next to a Bot that LuveBot asks nothing for (red team T1): in the contact list, in the conversation header and in Hoje, so the owner
// sees a Bot without its gate wherever the Bot is, not only inside its profile. Calm (a tint, no alarm): it is a choice, and revocable there.
import React from "react";
import { useLuveI18n } from "../../i18n";

export function FreeChip({ title, unknown }: { title?: string; unknown?: boolean }) {
  const { t } = useLuveI18n();
  if (unknown) {   // the last read of this Bot's mode is old: said calmly and neutrally, never as "Livre" or "not Livre" by a guess
    return (
      <span data-testid="free-chip-unknown" title={t("freeChipUnknownTitle")} className="lb-caption"
        style={{ flexShrink: 0, padding: "0 7px", borderRadius: 9, lineHeight: "18px", color: "var(--color-muted-foreground)", background: "var(--lb-fill-2)" }}>
        {t("freeChipUnknown")}<span className="lb:sr-only">{`: ${t("freeChipUnknownTitle")}`}</span>
      </span>
    );
  }
  return (
    <span data-testid="free-chip" title={title ?? t("freeChipTitle")} className="lb-caption"
      style={{ flexShrink: 0, padding: "0 7px", borderRadius: 9, fontWeight: 600, lineHeight: "18px", color: "var(--color-foreground)",
        background: "color-mix(in srgb, var(--color-warning) 22%, transparent)" }}>
      {t("freeChip")}<span className="lb:sr-only">{`: ${t("freeChipTitle")}`}</span>
    </span>
  );
}
