// dashboard/src/components/skills/skillWords.ts
// The words of the "teach a skill" flow (contract v0.11 §3): why a text is not a draft or is refused, in ONE list for the screen's extractor and the server's `why` (3.4: when the extractor names a reason, the
// server names the same one), and what each refusal of the routes says. A refusal names the CLASS of the offending character and where it is, never the character (3.4), and a number the person must obey
// (the description's limit) is said as a number, never as "too long" alone (SK-2d).

import { ApiError } from "../../api/client";
import type { TranslationKey } from "../../i18n";
import { hiddenClass, type HiddenClass } from "../../lib/skillTeach";
import { humanError, type ErrorState } from "../ui/ErrorNote";

export type T = (k: TranslationKey, p?: Record<string, string | number>) => string;

const HIDDEN: Record<HiddenClass, TranslationKey> = {
  tags: "skillHidTags", variation: "skillHidVariation", bidi: "skillHidBidi", separator: "skillHidSeparator",
  control: "skillHidControl", noncharacter: "skillHidNoncharacter", other: "skillHidOther",
};
const WHY: Record<string, TranslationKey> = {
  none: "skillWhyNone", two_fences: "skillWhyTwoFences", unclosed: "skillWhyUnclosed", no_frontmatter: "skillWhyNoFrontmatter", header_too_long: "skillWhyHeaderTooLong",
  bad_yaml: "skillWhyBadYaml", yaml_alias: "skillWhyYamlAlias", bad_name: "skillWhyBadName", bad_category: "skillWhyBadCategory", no_description: "skillWhyNoDescription",
  empty_body: "skillWhyEmptyBody", too_large: "skillWhyTooLarge", hermes_refused: "skillWhyHermes",
};
/** Hermes's scanner categories (tools/skills_guard.py) in words. One it does not list yet is drawn as its own name when that is a plain slug, and left out otherwise. */
const SCAN_CATEGORY: Record<string, TranslationKey> = {
  exfiltration: "scanCatExfiltration", persistence: "scanCatPersistence", injection: "scanCatInjection", obfuscation: "scanCatObfuscation", supply_chain: "scanCatSupplyChain",
  network: "scanCatNetwork", destructive: "scanCatDestructive", traversal: "scanCatTraversal", execution: "scanCatExecution", credential_exposure: "scanCatCredentialExposure",
  privilege_escalation: "scanCatPrivilegeEscalation", structural: "scanCatStructural", mining: "scanCatMining",
};
export function scanCats(cats: readonly unknown[], t: T): string {
  return cats.filter((c): c is string => typeof c === "string" && /^[a-z0-9_-]{1,40}$/.test(c)).slice(0, 12).map((c) => (SCAN_CATEGORY[c] ? t(SCAN_CATEGORY[c]) : c)).join(", ");
}
/** "1 achado" / "3 achados". */
export const findingsText = (n: number, t: T): string => (n === 1 ? t("skillFindingsOne") : t("skillFindings", { n }));
const num = (x: unknown): number | string => (typeof x === "number" && Number.isSafeInteger(x) ? x : "?");

/** The sentence for a reason (`why`) and its `details`: the extractor's refusal and the server's `skill_invalid` share it. A reason nobody knows (a newer server) is `skillWhyOther`, never the server's English. */
export function whyText(why: string | null | undefined, details: Record<string, unknown> | null | undefined, t: T): string {
  const d = details ?? {};
  if (why === "hidden_characters") return t("skillWhyHidden", { what: t(HIDDEN[hiddenClass(String(d.code))]), line: num(d.line), column: num(d.column) });
  if (why === "too_many_invisible") return t("skillWhyTooMany", { count: num(d.count) });
  if (why === "description_too_long") return typeof d.limit === "number" && Number.isSafeInteger(d.limit) ? t("skillWhyDescriptionTooLong", { limit: d.limit }) : t("skillWhyDescriptionTooLongNoLimit");
  const key = why ? WHY[why] : undefined;
  return key ? t(key) : t("skillWhyOther");
}

/** What a refused call of the flow says, as an error the screen shows (the code waits behind "Detalhe técnico"). The server's own English is never forwarded: only our words, from the closed lists. */
export function skillError(e: unknown, t: T, fallback: TranslationKey): ErrorState {
  if (e instanceof ApiError) {
    if (e.code === "skill_invalid") return { text: whyText(e.why, e.details, t), code: e.code };
    if (e.code === "skill_has_secret") return { text: t("skillHasSecret"), code: e.code };
    if (e.code === "skill_exists") return { text: t(e.details?.appeared_meanwhile === true ? "skillExistsMeanwhile" : "skillExists"), code: e.code };   // A-187: someone else's skill took the name while ours was being created
    if (e.code === "stale") return { text: t("skillEditStale"), code: e.code };
    if (e.code === "skill_not_editable") return { text: t("skillEditNotEditable"), code: e.code };
    if (e.code === "skill_redacted") return { text: t("skillEditRedacted"), code: e.code };
    if (e.code === "skill_truncated") return { text: t("skillEditTruncated"), code: e.code };
    if (e.code === "skill_state_unverified") return { text: t("skillUnverified"), code: e.code };
    if (e.code === "skill_scan_blocked") {
      const cats = Array.isArray(e.details?.categories) ? scanCats(e.details!.categories as unknown[], t) : "";
      return { text: t("skillScanBlocked") + (cats ? ` (${cats})` : ""), code: e.code };
    }
  }
  return humanError(e, t as (k: TranslationKey) => string, fallback);
}
