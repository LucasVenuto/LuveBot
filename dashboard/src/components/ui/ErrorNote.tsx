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
  invalid_image: "aviErrInvalid", avatar_quota: "aviErrQuota", avatar_in_use: "aviInUse", avatar_unknown: "aviErrUnknown",
  suggestion_not_pending: "rsgGone", suggestion_not_supported: "rsgNotSupported",
  loopback_not_human: "errLoopback", credential_not_human: "errCredentialNotHuman", audit_unavailable: "errAuditUnavailable", sdk_unavailable: "errSdkUnavailable",
  plugin_route_missing: "errRouteMissing", luvebot_needs_in_process: "errNeedsInProcess",
  path_condition_needs_file_tools: "errPathNeedsFileTools", bad_path_condition: "errBadPathCondition", multiple_paths: "errMultiplePaths", unusable_path: "errUnusablePath", fold_divergence: "errFoldDivergence",   // R-13/R-15: a letter the engine and the network read differently
  condition_needs_adapter_tools: "errNeedsAdapterTools", bad_recipient_condition: "errBadRecipientCondition", multiple_recipients: "errMultipleRecipients", unusable_recipient: "errUnusableRecipient",
  hermes_draining: "runErrDraining", hermes_busy: "runErrBusy", request_not_pending: "runErrNotPending", run_conflict: "runErrConflict",
  call_in_progress: "callErrInProgress", voice_unavailable: "callErrUnavailable", delegation_limit: "callErrDelegations", session_required: "callErrConnection",
  config_backend_unavailable: "errConfigUnavailable", config_key_locked: "errConfigLocked", hermes_exited: "errHermesExited",   // contract v0.10 1: the config boundary; a refused write is never "Hermes unreachable"
  run_unknown: "runErrUnknown", run_not_unknown: "runErrNotUnknown", session_other_channel: "runErrOtherChannel", invalid_answer: "runErrInvalidAnswer", bot_exists: "errBotExists", duplicate: "errDuplicate", run_not_found: "errRunNotFound", session_not_found: "errSessionNotFound",
};

/** The sentence for `e`: a general code's own words, else `fallback` (what this screen was trying to do), and the code apart.
 *  The backend's own `message` is never shown: all of it is English for developers (169 of 169 at 32debae). Everything that
 *  goes through api/client arrives as an ApiError, so anything else is not a lost connection: it gets `fallback` too. */
export function humanError(e: unknown, t: (k: TranslationKey) => string, fallback: TranslationKey): HumanError {
  if (!(e instanceof ApiError)) return { text: t(fallback), code: null };
  return { text: t(GENERAL[e.code] ?? fallback), code: codeWithProvider(e) };
}

// `credential_not_human` names the sign-in provider it refused in its details (contract v0.11 5.1, DT-1b). It waits in the collapsed technical detail, where an operator looks, and only as a plain name:
// anything else the server sent (a long string, markup, a non-string) is left out, and the sentence never carries it.
const PROVIDER_NAME = /^[A-Za-z0-9._-]{1,64}$/;
function codeWithProvider(e: ApiError): string | null {
  const provider = e.code === "credential_not_human" ? e.details?.provider : undefined;
  return e.code ? (typeof provider === "string" && PROVIDER_NAME.test(provider) ? `${e.code} (${provider})` : e.code) : null;
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
