// dashboard/src/components/ui/ErrorNote.tsx
// An error in words a person reads (the CEO saw "Não foi possível salvar (hermes_unreachable)."): the backend's code becomes a
// sentence that says what happened and what to do; the code itself is kept only behind "Detalhe técnico", collapsed.
// A screen's own map of its specific codes comes first; this covers the general ones (contract v0 §7 and the backend).

import React from "react";
import { ApiError } from "../../api/client";
import { useLuveI18n, type TranslationKey } from "../../i18n";

export type HumanError = { text: string; code: string | null };
/** What an error state holds: a sentence already written for the person, or one with its code for the detail. */
export type ErrorState = string | HumanError;

export const GENERAL: Record<string, TranslationKey> = {
  hermes_unreachable: "errHermesUnreachable", hermes_error: "errHermesError", hermes_timeout: "errHermesTimeout",
  hermes_status_unverified: "errHermesUnverified", csrf_required: "errCsrf", unauthenticated: "errUnauthenticated",
  unauthorized: "errUnauthenticated", rate_limited: "errRateLimited", bad_request: "errInvalid", invalid_field: "errInvalid",
  invalid_name: "errInvalid", capability_missing: "errCapabilityMissing", not_supported: "errCapabilityMissing",
  not_implemented: "errNotImplemented", bot_not_found: "errBotNotFound", bot_paused: "errBotPaused", bot_offline: "errBotOffline",
  budget_exceeded: "errBudgetExceeded", too_large: "errTooLarge", conflict: "errConflict", stale: "errConflict",
  loopback_not_human: "errLoopback", audit_unavailable: "errAuditUnavailable", sdk_unavailable: "errSdkUnavailable",
  plugin_route_missing: "errRouteMissing", bot_exists: "errBotExists", duplicate: "errDuplicate", run_not_found: "errRunNotFound", session_not_found: "errSessionNotFound",
};

/** The sentence for `e`: a general code's own words, else `fallback` (what this screen was trying to do), and the code apart.
 *  The backend's own `message` is never shown: all of it is English for developers (169 of 169 at 32debae). Everything that
 *  goes through api/client arrives as an ApiError, so anything else is not a lost connection: it gets `fallback` too. */
export function humanError(e: unknown, t: (k: TranslationKey) => string, fallback: TranslationKey): HumanError {
  if (!(e instanceof ApiError)) return { text: t(fallback), code: null };
  return { text: t(GENERAL[e.code] ?? fallback), code: e.code || null };
}

/** An error that arrives as a code inside our own stream frame (luvebot.error): the same sentences, by code. */
export function humanCode(code: string | undefined, t: (k: TranslationKey) => string, fallback: TranslationKey): HumanError {
  return { text: t((code && GENERAL[code]) || fallback), code: code || null };
}

/** The sentence, and the code behind a collapsed "Detalhe técnico" (phrasing content: it sits inside a <p> or <span>). */
export function ErrorNote({ error }: { error: ErrorState | null | undefined }) {
  const { t } = useLuveI18n();
  const [open, setOpen] = React.useState(false);
  if (!error) return null;
  if (typeof error === "string") return <>{error}</>;
  return (
    <>
      {error.text}
      {error.code && (
        <>
          {" "}
          <button type="button" className="lb-error-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{t("errTechnical")}</button>
          {open && <code className="lb-error-code">{error.code}</code>}
        </>
      )}
    </>
  );
}
