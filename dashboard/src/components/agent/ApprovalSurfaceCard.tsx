// dashboard/src/components/agent/ApprovalSurfaceCard.tsx
// "Onde aprovar" in the Bot's profile (D-025 §d): only in LuveBot (the default) or where the conversation happens (Telegram,
// in a private chat, by the people named here). The server decides what is safe (403 loopback, 409 gateway open to everyone);
// this card only says it plainly. The rule seals come from the backend's SealResult only (invariant 8).

import React from "react";
import { ApiError, getApprovalSurface, putApprovalSurface, getRules, installBotHook } from "../../api/client";
import type { ApprovalSurface, ApprovalSurfaceMode, RuleWithSeal } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { SealBadge, SealCaveat } from "../rules/SealBadge";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

const ID = /^\d{1,20}$/;
// "pending" is normal for a few seconds after saving (the hook reports the new setting on its next heartbeat): ask again
// every 2 s, at most 15 times (30 s), then say it is taking long. Only the status is refreshed, never what the person typed.
export const PENDING_EVERY_MS = 2000;
export const PENDING_TRIES = 15;
// The hook version each mode needs (backend/approval_surface.py applied_reason: 0.3.0 for channel, 0.2.0 for luvebot).
const NEEDS: Record<ApprovalSurfaceMode, string> = { channel: "0.3.0", luvebot: "0.2.0" };
const REASON: Record<string, TranslationKey> = {
  GATEWAY_ALLOW_ALL_USERS: "surfaceReasonGatewayAll", TELEGRAM_ALLOW_ALL_USERS: "surfaceReasonTelegramAll",
  TELEGRAM_ALLOWED_USERS: "surfaceReasonTelegramStar", GATEWAY_ALLOWED_USERS: "surfaceReasonGatewayStar",
  allow_all_users: "surfaceReasonConfigAll", allow_from: "surfaceReasonConfigStar", unreadable: "surfaceReasonUnreadable",
};

/** "0.2.9" older than "0.3.2" (numeric parts); anything unreadable is not called older (no update offered on a guess). */
export function olderVersion(have: string | null | undefined, latest: string | null | undefined): boolean {
  const parts = (v: string) => v.split(".").map((x) => Number(x));
  if (!have || !latest) return false;
  const [a, b] = [parts(have), parts(latest)];
  if ([...a, ...b].some((n) => !Number.isInteger(n) || n < 0)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

export function parseApprovers(text: string): { ids: string[]; error: "format" | "many" | "repeat" | null } {
  const ids = text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  if (ids.some((x) => !ID.test(x))) return { ids, error: "format" };
  if (ids.length > 20) return { ids, error: "many" };
  if (new Set(ids).size !== ids.length) return { ids, error: "repeat" };
  return { ids, error: null };
}

export function ApprovalSurfaceCard({ bot }: { bot: string }) {
  const { t } = useLuveI18n();
  const [surface, setSurface] = React.useState<ApprovalSurface | null>(null);
  const [mode, setMode] = React.useState<ApprovalSurfaceMode>("luvebot");
  const [ids, setIds] = React.useState("");
  const [rules, setRules] = React.useState<RuleWithSeal[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [saved, setSaved] = React.useState(false);
  const errRef = React.useRef<HTMLParagraphElement>(null);
  const tries = React.useRef(0);
  const [retry, setRetry] = React.useState(0);
  // "Atualizar o hook deste Bot": the only way, from the screen, to bring the new hook to a Bot that already exists
  const [hookBusy, setHookBusy] = React.useState(false);
  const [hookResult, setHookResult] = React.useState<TranslationKey | null>(null);
  const [hookError, setHookError] = React.useState<ErrorState | null>(null);

  const reasonText = (r: string | null | undefined) => (r && REASON[r] ? t(REASON[r]) : t("surfaceReasonUnreadable"));
  const errorText = (e: unknown): ErrorState => {
    if (!(e instanceof ApiError)) return t("surfaceErrNetwork");
    if (e.code === "approval_surface_unsafe") return t("surfaceErrUnsafe", { reason: reasonText(e.details?.reason) });
    if (e.code === "loopback_not_human") return t("surfaceErrLoopback");
    if (e.code === "invalid_field") return t("surfaceErrInvalid");
    if (e.code === "csrf_required") return t("surfaceErrCsrf");
    return humanError(e, t, "surfaceErrGeneric");
  };

  const load = React.useCallback(async () => {
    try {
      const { approval_surface: s } = await getApprovalSurface(bot);
      setSurface(s);
      setMode(s.mode);
      setIds(s.approvers.map((a) => a.replace(/^telegram:/, "")).join(", "));
    } catch (e) {
      setError(errorText(e));
    }
    try {
      // this Bot's own seals (?bot=): without it a global rule carries the aggregate over every Bot (VPS: "Quebrado")
      const r = await getRules(undefined, bot);
      setRules((r?.rules ?? []).filter(({ rule }) => rule.level === "ask" && rule.state === "active"));
    } catch { setRules([]); }
  }, [bot]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { if (error) errRef.current?.focus(); }, [error]);
  React.useEffect(() => {
    if (surface?.applied_reason !== "pending" || tries.current >= PENDING_TRIES) return;
    const id = window.setTimeout(async () => {
      tries.current += 1;
      try { setSurface((await getApprovalSurface(bot)).approval_surface); } catch { /* the next try asks again */ }
      setRetry((n) => n + 1);  // the next try is scheduled by the count, not by getting a new object back
    }, PENDING_EVERY_MS);
    return () => window.clearTimeout(id);
  }, [surface?.applied_reason, bot, retry]);

  const parsed = parseApprovers(ids);
  const localError = mode === "channel" ? (parsed.error ?? (parsed.ids.length === 0 ? "empty" : null)) : null;
  const current = surface ? `${surface.mode}|${surface.approvers.join(",")}` : "";
  const next = `${mode}|${parsed.error ? ids : parsed.ids.map((x) => `telegram:${x}`).join(",")}`;
  const changed = !!surface && current !== next;

  async function updateHook() {
    setHookBusy(true); setHookError(null); setHookResult(null);
    try {
      const r = await installBotHook(bot);
      setHookResult(r.restart_required ? "hookUpdateRestart" : r.changed ? "hookUpdated" : "hookAlreadyCurrent");
      void load();  // the card says what the hook does now
    } catch (e) {
      setHookError(e instanceof ApiError && e.code === "hook_install_failed" ? t("hookUpdateFailed") : humanError(e, t, "hookUpdateFailed"));
    } finally {
      setHookBusy(false);
    }
  }

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    tries.current = 0;
    setRetry((n) => n + 1);  // a save that answers "pending" asks again even after an earlier wait ran out
    try {
      const approvers = parsed.error ? undefined : parsed.ids.map((x) => `telegram:${x}`);
      const { approval_surface: s } = await putApprovalSurface(bot, { mode, ...(approvers && (mode === "channel" || approvers.length) ? { approvers } : {}) });
      setSurface(s); setMode(s.mode);
      setSaved(true);
      void load();  // the rule seals change with the surface
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const option = (value: ApprovalSurfaceMode, title: TranslationKey, desc: string) => (
    <label className="lb-row lb-row-flat" style={{ alignItems: "flex-start", gap: 12, cursor: "pointer" }}>
      <input type="radio" name={`surface-${bot}`} value={value} checked={mode === value} onChange={() => { setMode(value); setSaved(false); }} style={{ marginTop: 4 }} />
      <span className="lb-row-stack">
        <span className="lb-body" style={{ fontWeight: 600 }}>{t(title)}</span>
        <span className="lb-subhead">{desc}</span>
      </span>
    </label>
  );

  return (
    <section aria-labelledby={`surface-title-${bot}`}>
      <h3 id={`surface-title-${bot}`} className="lb-headline" style={{ margin: "24px 4px 4px" }}>{t("surfaceTitle")}</h3>
      <p className="lb-subhead" style={{ margin: "0 4px 8px" }}>{t("surfaceIntro")}</p>
      {!surface && !error && <p className="lb-subhead" style={{ margin: "0 4px" }}>{t("agentLoading")}</p>}
      {surface && (
        <div className="lb-group">
          <div role="radiogroup" aria-labelledby={`surface-title-${bot}`}>
            {option("luvebot", "surfaceLuvebot", t("surfaceLuvebotDesc"))}
            {option("channel", "surfaceChannel", t("surfaceChannelDesc", { platforms: (surface.platforms.length ? surface.platforms : ["telegram"]).map((p) => p[0].toUpperCase() + p.slice(1)).join(", ") }))}
          </div>
          {mode === "channel" && (
            <div style={{ padding: "4px 16px 14px" }}>
              <label htmlFor={`surface-ids-${bot}`} className="lb-label">{t("surfaceApproversLabel")}</label>
              <input id={`surface-ids-${bot}`} className="lb-input" inputMode="numeric" value={ids} placeholder={t("surfaceIdsPlaceholder")}
                aria-describedby={`surface-ids-help-${bot}`} aria-invalid={!!localError || undefined}
                onChange={(e) => { setIds(e.target.value); setSaved(false); }} />
              <p id={`surface-ids-help-${bot}`} className="lb-caption" style={{ margin: "6px 0 0" }}>
                {/* the CEO put the Bot's own ID here and the approval button never came: say whose ID it is */}
                {t("surfaceApproversHelp")} <a href="https://t.me/userinfobot" target="_blank" rel="noopener noreferrer">{t("surfaceUserInfoBot")}</a> {t("surfaceApproversHelpAfter")}
              </p>
              {localError && <p className="lb-caption" style={{ margin: "6px 0 0", color: "var(--color-destructive)" }}>
                {t(localError === "empty" ? "surfaceIdsEmpty" : localError === "many" ? "surfaceIdsMany" : localError === "repeat" ? "surfaceIdsRepeat" : "surfaceIdsFormat")}
              </p>}
            </div>
          )}
          {surface.mode === "channel" && surface.allow_all && (
            <p role="status" className="lb-caption" style={{ margin: 0, padding: "0 16px 12px", color: "var(--color-warning)" }}>{t("surfaceAllowAll", { reason: reasonText(surface.allow_all_reason) })}</p>
          )}
          {(surface.applied_reason === "hook_outdated" || olderVersion(surface.hook_version, surface.hook_latest_version)) && (
            <div style={{ padding: "0 16px 12px" }}>
              <button type="button" className="lb-btn" disabled={hookBusy} onClick={() => void updateHook()}>
                {hookBusy ? t("hookUpdating") : t("hookUpdateBtn")}
              </button>
            </div>
          )}
          {hookResult && <p role="status" className="lb-caption" style={{ margin: 0, padding: "0 16px 12px", color: hookResult === "hookUpdateRestart" ? "var(--color-warning)" : undefined }}>{t(hookResult)}</p>}
          {hookError && <p role="alert" className="lb-caption" style={{ margin: 0, padding: "0 16px 12px", color: "var(--color-destructive)" }}><ErrorNote error={hookError} /></p>}
          {!surface.applied && (() => {
            const why = surface.applied_reason;
            const pending = why === "pending";
            const text = pending ? t(tries.current >= PENDING_TRIES ? "surfacePendingSlow" : "surfacePending")
              : why === "hook_outdated" ? t("surfaceHookOutdated", { version: surface.hook_version ?? t("surfaceNoHook"), needed: NEEDS[surface.mode] ?? NEEDS.channel })
              : why === "hook_not_live" ? t("surfaceHookNotLive")
              : t("surfaceNotAppliedUnknown");
            return (
              <p role="status" className="lb-caption" style={{ margin: 0, padding: "0 16px 12px", color: pending ? "var(--color-muted-foreground)" : "var(--color-warning)" }}>{text}</p>
            );
          })()}
        </div>
      )}
      {surface && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
          <button type="button" className="lb-btn lb-btn-primary" disabled={busy || !changed || !!localError} onClick={() => void save()}>
            {busy ? t("saving") : t("saveChanges")}
          </button>
          {saved && <span role="status" className="lb-caption">{t("surfaceSaved")}</span>}
        </div>
      )}
      {error && <p ref={errRef} tabIndex={-1} role="alert" className="lb-caption" style={{ margin: "8px 4px 0", color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
      {rules && rules.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p className="lb-caption" style={{ margin: "0 4px 6px" }}>{t("surfaceSealsLabel")}</p>
          <ul className="lb-group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {rules.slice(0, 4).map(({ rule, seal_result }) => (
              <li key={rule.id} className="lb-row lb-row-flat" style={{ justifyContent: "space-between", gap: 8 }}>
                <span className="lb-row-stack" style={{ minWidth: 0 }}>
                  <span className="lb-body lb-truncate">{rule.label}</span>
                  <SealCaveat sealResult={seal_result} />
                </span>
                <SealBadge sealResult={seal_result} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
