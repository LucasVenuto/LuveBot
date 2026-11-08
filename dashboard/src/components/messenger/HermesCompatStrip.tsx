// dashboard/src/components/messenger/HermesCompatStrip.tsx
// Invariant 9: the plugin says, in plain words, when the Hermes under it is not one it was tested with. Reads ONLY /health's `hermes`
// (backend F2): `compat` decides, `limits` lists what does not work, `isolation: host` has its own sentence. No `compat` (older
// backend) or "compatible": no strip. "Not tested" can be dismissed (per version, in this browser); "unsupported" cannot.
// A TESTED build that still has a known limit (ADR-007 section 7, A-193) is "compatible": no strip anywhere, and ONE calm line in Settings (`HermesTestedLine`).

import React from "react";
import type { HealthHermesInfo } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";

const LIMIT: Record<string, TranslationKey> = {
  approval_resolve: "compatLimit_approval_resolve", session_other_channel: "compatLimit_session_other_channel",
  run_unknown: "compatLimit_run_unknown", profile_selector: "compatLimit_profile_selector",
};
const KEY = "luvebot:compat-dismissed";

// The calm line's words for a limit: a clause that says what the person sees and what to do, where the strip's `LIMIT` words are the name of a thing that does not work yet. A code with no clause uses the strip's words.
const KNOWN: Record<string, TranslationKey> = { profile_selector: "compatKnown_profile_selector" };

/** In Settings, for a tested Hermes (`compat: "compatible"`) that has known limits: "Tested on this Hermes. One known limit: ...". Nothing otherwise (untested and unsupported have the strip; no limit, no line). */
export function HermesTestedLine({ hermes }: { hermes?: HealthHermesInfo | null }) {
  const { t } = useLuveI18n();
  if (hermes?.compat !== "compatible") return null;
  const words = (hermes.limits ?? []).filter((c) => LIMIT[c]).map((c) => t(KNOWN[c] ?? LIMIT[c]));
  if (!words.length) return null;
  return (
    <p data-testid="hermes-tested-line" className="lb-caption" style={{ color: "var(--color-muted-foreground)", margin: "8px 16px" }}>
      {t(words.length === 1 ? "compatTestedOne" : "compatTestedMany", { list: words.join(" · ") })}
    </p>
  );
}

export function HermesCompatStrip({ hermes }: { hermes?: HealthHermesInfo | null }) {
  const { t } = useLuveI18n();
  const version = hermes?.display_version ?? hermes?.version ?? null;
  const what = `${hermes?.compat}|${version}|${(hermes?.limits ?? []).join(",")}|${(hermes?.unproven ?? []).join(",")}`;
  const [gone, setGone] = React.useState(() => { try { return localStorage.getItem(KEY) === what; } catch { return false; } });
  React.useEffect(() => { try { setGone(localStorage.getItem(KEY) === what); } catch { setGone(false); } }, [what]);
  const compat = hermes?.compat;
  if (compat !== "untested" && compat !== "unsupported") return null;
  if (compat === "untested" && gone) return null;
  const limits = (hermes?.limits ?? []).filter((c) => LIMIT[c]).map((c) => t(LIMIT[c]));
  const unproven = (hermes?.unproven ?? []).filter((c) => LIMIT[c]).map((c) => t(LIMIT[c]));   // implemented, no harness proof here: said calmly, apart from "does not work"
  const bad = compat === "unsupported";
  return (
    <div role="status" data-testid="hermes-compat" data-compat={compat} className="lb-caption"
      style={{ padding: "8px 16px", display: "flex", gap: 8, alignItems: "flex-start", color: "var(--color-foreground)", borderBottom: "1px solid var(--lb-separator)",
        background: `color-mix(in srgb, var(${bad ? "--color-warning" : "--color-primary"}) 12%, transparent)` }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <strong>{version ? t("compatHermesV", { version }) : t("compatHermes")}</strong>{": "}
        {t(bad ? (hermes?.isolation === "host" ? "compatIsolationHost" : "compatUnsupported") : "compatUntested")}
        {limits.length > 0 && <span data-testid="hermes-compat-limits" style={{ display: "block" }}>{t("compatLimits", { list: limits.join(", ") })}</span>}
        {unproven.length > 0 && <span data-testid="hermes-compat-unproven" style={{ display: "block", color: "var(--color-muted-foreground)" }}>{t("compatUnproven", { list: unproven.join(", ") })}</span>}
      </span>
      {!bad && (
        <button type="button" className="lb-btn" style={{ flexShrink: 0 }}
          onClick={() => { setGone(true); try { localStorage.setItem(KEY, what); } catch { /* the strip comes back on reload: fine */ } }}>
          {t("compatDismiss")}
        </button>
      )}
    </div>
  );
}
