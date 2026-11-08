// dashboard/src/components/settings/Notifications.tsx
// Notifications from the installed app (contract v0.8 §6, spec 4.16). The push carries nothing: the phone's worker asks LuveBot what happened and shows
// only "<Bot> precisa de você" and the kind. Here the person turns it on FOR THIS DEVICE (the permission is asked from the button's click and nowhere
// else), chooses the kinds (approval, budget), and sees and removes the devices. A notification approves nothing: it opens the Approvals box.

import React from "react";
import { ApiError, addPushDevice, getPushConfig, listPushDevices, removePushDevice, testPush } from "../../api/client";
import type { PushConfig, PushDevice } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";
import { currentEndpoint, currentKey, disable, enable, keyState, pushSupport, rememberDevice, thisDevice, type KeyState, type PushSupport } from "../../pwa/subscribe";

export const PUSH_KINDS: Array<{ kind: string; label: TranslationKey }> = [
  { kind: "approval", label: "notifKindApproval" }, { kind: "budget", label: "notifKindBudget" }, { kind: "question", label: "notifKindQuestion" },
];
const OWN: Record<string, TranslationKey> = {
  capability_missing: "notifErrMissing", too_many_devices: "notifErrLimit", invalid_field: "notifErrEndpoint", key_mismatch: "notifErrKey", needs_subject: "notifSubjectMissing",   // invalid_field: only the endpoint is free text (the kinds are our two)
};
const SUPPORT_TEXT: Record<Exclude<PushSupport, "ready">, TranslationKey> = {
  unsupported: "notifUnsupported", needs_install: "notifNeedsInstall", needs_https: "notifNeedsHttps", denied: "notifDenied",
};
// why the push service refused a send (the server's closed list, contract v0.11 7.2), in words; a reason nobody knows is the plain "refused", never the server's text
const REASON: Record<string, TranslationKey> = {
  bad_jwt: "notifWhy_bad_jwt", key_mismatch: "notifWhy_key_mismatch", expired: "notifWhy_expired", too_large: "notifWhy_too_large",
  rate_limited: "notifWhy_rate_limited", timeout: "notifWhy_timeout", other: "notifWhy_other",
};
const reasonKey = (reason: unknown): TranslationKey => (typeof reason === "string" && Object.prototype.hasOwnProperty.call(REASON, reason) ? REASON[reason] : "notifWhy_other");
const HOSTS: Array<[RegExp, TranslationKey]> = [
  [/(^|\.)apple\.com$/, "notifDeviceApple"], [/(^|\.)googleapis\.com$/, "notifDeviceChrome"], [/(^|\.)mozilla\.com$/, "notifDeviceFirefox"], [/(^|\.)windows\.com$/, "notifDeviceWindows"],
];

function notifError(e: unknown, t: (k: TranslationKey) => string): ErrorState {
  return e instanceof ApiError && OWN[e.code] ? { text: t(OWN[e.code]), code: e.code } : humanError(e, t, "notifErrGeneric");
}

export function NotificationsCard() {
  const { t, locale } = useLuveI18n();
  const [config, setConfig] = React.useState<PushConfig | null>(null);
  const [devices, setDevices] = React.useState<PushDevice[] | null>(null);
  const [off, setOff] = React.useState<ErrorState | null>(null);          // this LuveBot cannot do notifications (an older backend) or the read failed
  const [kinds, setKinds] = React.useState<string[]>(PUSH_KINDS.map((k) => k.kind));
  const [busy, setBusy] = React.useState(false);
  const [said, setSaid] = React.useState<{ text?: string; error?: ErrorState } | null>(null);
  const [mine, setMine] = React.useState<string | null>(thisDevice);
  const [browserKey, setBrowserKey] = React.useState<KeyState | null>(null);   // does THIS browser's subscription hold the server's current key? (compared when Settings opens; nothing renews itself)
  const [testing, setTesting] = React.useState(false);
  const [test, setTest] = React.useState<Array<{ id: number; ok: boolean; reason: string | null }> | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);

  const load = React.useCallback(async () => {
    try {
      const [c, d] = await Promise.all([getPushConfig(), listPushDevices()]);
      if (!alive.current) return;
      // an answer that is not the contract's ({public_key, enabled_kinds}) is "this server does not do notifications", said calmly: it must never throw inside Settings
      if (!c || typeof c.public_key !== "string" || !Array.isArray(c.enabled_kinds)) { setOff(t("notifErrOld")); return; }
      setConfig(c); setDevices(d.subscriptions ?? []); setOff(null);
      setKinds((k) => k.filter((x) => (c.enabled_kinds ?? []).includes(x)));   // only what this server can send
      const here = (d.subscriptions ?? []).find((x) => String(x.id) === thisDevice());
      if (here) setKinds(PUSH_KINDS.map((k) => k.kind).filter((k) => here.kinds.includes(k)));
      if (!here && thisDevice()) { rememberDevice(null); setMine(null); }   // removed elsewhere: this browser is no longer one of the devices
      // A subscription belongs to the key it was made with: after the server's key changes the push service refuses every send for ever and nothing looks wrong. Only COMPARE here; renewing is a gesture (iOS refuses
      // subscribe without one) and a button, never silent.
      const state = here ? await keyState(c.public_key) : null;
      if (alive.current) setBrowserKey(state);
    } catch (e) {
      if (alive.current) setOff(e instanceof ApiError && e.status === 404 ? { text: t("notifErrOld"), code: e.code } : notifError(e, t));
    }
  }, [t]);
  React.useEffect(() => { void load(); }, [load]);

  // The key goes with a subscription only to a server that already says it takes it: `subject` in the config is the sign of the repair (contract v0.11 7.1), and a server before it refuses any body key outside
  // {endpoint, kinds, keys, expirationTime} (`invalid_field`), which would break turning notifications on at all.
  const keyFor = (key: string | null | undefined) => (config?.subject && key ? key : undefined);
  const support = pushSupport();
  const say = (s: { text?: string; error?: ErrorState }) => { if (alive.current) setSaid(s); };

  /** The Ativar button's click: ask the permission, subscribe, hand the server the endpoint with the kinds chosen. */
  async function turnOn() {
    if (!config || busy) return;
    setBusy(true); setSaid(null);
    try {
      const got = await enable(config.public_key);
      if (got === "denied") { say({ error: t("notifDenied") }); return; }
      try {
        const added = await addPushDevice(got.endpoint, kinds, keyFor(got.key));
        rememberDevice(String(added.id)); setMine(String(added.id));
      } catch (e) { await disable(); throw e; }      // the server did not take it: this browser does not stay subscribed to nothing
      say({ text: t("notifEnabled") });
      await load();
    } catch (e) { say({ error: notifError(e, t) }); }
    finally { if (alive.current) setBusy(false); }
  }

  /** The Renovar button's click (a gesture): unsubscribe and subscribe again with the server's CURRENT key, hand the server the new endpoint with this device's kinds and the key it holds, take the old row away. */
  async function renew() {
    const here = devices?.find((x) => String(x.id) === mine);
    if (!config || !here || busy) return;
    setBusy(true); setSaid(null);
    try {
      const got = await enable(config.public_key);
      if (got === "denied") { say({ error: t("notifDenied") }); return; }
      // The old endpoint is dead the moment `enable()` dropped it, so its row goes FIRST: the server counts the person's OTHER devices when it sees a new endpoint, and at ten the new one would be the eleventh (F-N6-6).
      let removed = false;
      try { await removePushDevice(here.id); removed = true; } catch { /* already gone, or the call failed: the add below says which */ }
      let added: Awaited<ReturnType<typeof addPushDevice>>;
      try { added = await addPushDevice(got.endpoint, here.kinds.length ? here.kinds : kinds, keyFor(got.key)); }
      catch (e) {   // the browser holds a subscription the server does not know: it does not stay subscribed to nothing, and the person is told what is left
        await disable(); setMine(null);
        const why = notifError(e, t), said = typeof why === "string" ? { text: why, code: null } : why;
        say({ error: removed ? { text: `${t("notifRenewHalf")} ${said.text}`, code: said.code } : why });
        await load();
        return;
      }
      rememberDevice(String(added.id)); setMine(String(added.id));
      setTest(null);
      say({ text: t("notifRenewed") });
      await load();
    } catch (e) { say({ error: notifError(e, t) }); }
    finally { if (alive.current) setBusy(false); }
  }

  async function sendTest() {
    if (testing) return;
    setTesting(true); setSaid(null); setTest(null);
    try {
      const r = await testPush();
      if (alive.current) setTest((r.devices ?? []).map((x) => ({ id: x.id, ok: x.ok === true, reason: typeof x.reason === "string" ? x.reason : null })));
    } catch (e) { say({ error: e instanceof ApiError && e.code === "rate_limited" ? t("notifTestRate") : e instanceof ApiError && e.code === "needs_subject" && config?.subject?.source === "setting" ? t("notifSubjectBad") : notifError(e, t) }); }
    finally { if (alive.current) setTesting(false); }
  }

  async function toggle(kind: string) {
    const next = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];
    if (mine && !next.length) return;                  // the server wants a non-empty list: to stop everything the device is removed
    const before = kinds;
    setKinds(next); setSaid(null);
    if (!mine) return;                                // not on yet: the choice is what "Ativar" will send
    setBusy(true);
    try {
      const endpoint = await currentEndpoint();       // the upsert key: the same device again changes its kinds
      if (!endpoint) { setKinds(before); say({ error: t("notifLostSubscription") }); return; }
      await addPushDevice(endpoint, next, keyFor(await currentKey()));   // the key too when the browser says it: changing the kinds is not a renewal
      await load();
    } catch (e) { setKinds(before); say({ error: notifError(e, t) }); }
    finally { if (alive.current) setBusy(false); }
  }

  async function remove(id: number) {
    setBusy(true); setSaid(null);
    try {
      try { await removePushDevice(id); }
      catch (e) { if (!(e instanceof ApiError && e.code === "subscription_not_found")) throw e; }   // already gone (the push service dropped it): same result
      if (String(id) === mine) { await disable(); setMine(null); }
      say({ text: t("notifRemoved") });
      await load();
    } catch (e) { say({ error: notifError(e, t) }); }
    finally { if (alive.current) setBusy(false); }
  }

  const nameOf = (d: PushDevice) => { const hit = d.host ? HOSTS.find(([re]) => re.test(d.host!)) : null; return t(hit ? hit[1] : "notifDeviceOther"); };
  const when = (d: PushDevice) => d.created_at ? new Date(d.created_at * 1000).toLocaleDateString(locale === "pt" ? "pt-BR" : "en-US", { day: "numeric", month: "long" }) : null;

  return (
    <section aria-labelledby="settings-notifications" data-testid="notifications-card">
      <h2 id="settings-notifications" className="lb-headline" style={{ margin: "24px 4px 8px" }}>{t("notifTitle")}</h2>
      <p className="lb-caption" style={{ color: "var(--color-muted-foreground)", margin: "0 16px 8px" }}>{t("notifIntro")}</p>
      {off ? (
        <p data-testid="notifications-off" className="lb-caption" style={{ margin: "0 16px" }}><ErrorNote error={off} /></p>
      ) : !config || !devices ? (
        <p className="lb-caption" style={{ margin: "0 16px" }}>{t("notifLoading")}</p>
      ) : (
        <>
          {config.subject && config.subject.ok === false && <p role="status" data-testid="notifications-subject" className="lb-caption" style={{ color: "var(--color-destructive)", margin: "0 16px 8px" }}>{t(config.subject.source === "setting" ? "notifSubjectBad" : "notifSubjectMissing")}</p>}
          <div role="group" aria-label={t("notifKindsTitle")} className="lb-group">
            {PUSH_KINDS.filter((k) => config.enabled_kinds.includes(k.kind)).map(({ kind, label }) => (
              <label key={kind} className="lb-row lb-row-flat" style={{ minHeight: 44, gap: 12, cursor: "pointer" }}>
                <input type="checkbox" checked={kinds.includes(kind)} disabled={busy || (!!mine && kinds.length === 1 && kinds.includes(kind))} onChange={() => void toggle(kind)} />
                <span className="lb-body">{t(label)}</span>
              </label>
            ))}
          </div>
          {mine && kinds.length === 1 && <p data-testid="notifications-last-kind" className="lb-caption" style={{ margin: "8px 16px 0" }}>{t("notifLastKind")}</p>}
          {!mine && (
            <div style={{ margin: "12px 16px 0" }}>
              <button type="button" data-testid="notifications-enable" className="lb-btn lb-btn-primary" disabled={busy || support !== "ready" || !kinds.length} onClick={() => void turnOn()}>
                {busy ? t("notifEnabling") : t("notifEnable")}
              </button>
              {support !== "ready" && <p data-testid="notifications-support" className="lb-caption" style={{ margin: "8px 0 0" }}>{t(SUPPORT_TEXT[support])}</p>}
            </div>
          )}
          <p className="lb-caption" style={{ color: "var(--color-muted-foreground)", margin: "8px 16px" }}>{t("notifIos")}</p>
          {mine && (browserKey === "mismatch" || browserKey === "none" || devices.some((x) => String(x.id) === mine && x.stale === true) || test?.some((r) => String(r.id) === mine && !r.ok && r.reason === "key_mismatch")) && (
            <div role="alert" data-testid="notifications-renew" style={{ margin: "8px 16px" }}>
              <p className="lb-caption" style={{ margin: "0 0 6px", color: "var(--color-destructive)" }}>{t("notifStale")}</p>
              <button type="button" className="lb-btn lb-btn-primary" disabled={busy} onClick={() => void renew()}>{busy ? t("notifRenewing") : t("notifRenew")}</button>
            </div>
          )}
          <h3 className="lb-headline" style={{ margin: "16px 4px 8px", fontSize: 15 }}>{t("notifDevices")}</h3>
          {devices.length === 0 ? (
            <p data-testid="notifications-none" className="lb-caption" style={{ margin: "0 16px" }}>{t("notifNone")}</p>
          ) : (
            <ul className="lb-group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {devices.map((d) => {
                const name = nameOf(d), date = when(d);
                return (
                  <li key={d.id} data-testid="notifications-device" className="lb-row lb-row-flat" style={{ minHeight: 48, gap: 12, justifyContent: "space-between" }}>
                    <div style={{ minWidth: 0 }}>
                      <span className="lb-body">{name}</span>
                      {String(d.id) === mine && <span data-testid="notifications-this" className="lb-pill" style={{ marginLeft: 8 }}>{t("notifThisDevice")}</span>}
                      <div className="lb-caption">{[date ? t("notifAddedOn", { date }) : null, PUSH_KINDS.filter((k) => d.kinds.includes(k.kind)).map((k) => t(k.label)).join(", ") || null].filter(Boolean).join(" · ")}</div>
                      {d.last && !d.last.ok && <div data-testid="notifications-last-refused" className="lb-caption" style={{ color: "var(--color-destructive)" }}>{t("notifLastRefused", { what: t(reasonKey(d.last.reason)) })}</div>}
                      {d.last?.ok === true && <div data-testid="notifications-last-ok" className="lb-caption">{t("notifLastOk", { date: d.last.at ? new Date(d.last.at * 1000).toLocaleDateString(locale === "pt" ? "pt-BR" : "en-US", { day: "numeric", month: "long" }) : "-" })}</div>}
                      {d.stale === true && String(d.id) !== mine && <div data-testid="notifications-stale-other" className="lb-caption">{t("notifStaleOther")}</div>}
                    </div>
                    <button type="button" className="lb-btn" disabled={busy} aria-label={t("notifRemoveNamed", { name })} onClick={() => void remove(d.id)}>{t("notifRemove")}</button>
                  </li>
                );
              })}
            </ul>
          )}
          {devices.length > 0 && (
            <div style={{ margin: "12px 16px 0" }}>
              <button type="button" data-testid="notifications-test" className="lb-btn" disabled={testing || busy} onClick={() => void sendTest()}>{testing ? t("notifTesting") : t("notifTest")}</button>
              <p data-testid="notifications-test-note" className="lb-caption" style={{ margin: "6px 0 0", color: "var(--color-muted-foreground)" }}>{t("notifTestNote")}</p>
              {test && (test.length === 0 ? <p data-testid="notifications-test-none" className="lb-caption" style={{ margin: "8px 0 0" }}>{t("notifTestNone")}</p> : (
                <ul aria-label={t("notifTestTitle")} data-testid="notifications-test-results" style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
                  {test.map((r) => {
                    const d = devices.find((x) => x.id === r.id);
                    const name = d ? nameOf(d) + (String(d.id) === mine ? ` (${t("notifThisDevice")})` : "") : String(r.id);
                    return <li key={r.id} data-testid="notifications-test-row" data-ok={r.ok ? "true" : "false"} className="lb-caption" style={{ margin: "2px 0" }}>{t("notifTestRow", { name, what: r.ok ? t("notifTestOk") : t(reasonKey(r.reason)) })}</li>;
                  })}
                </ul>
              ))}
            </div>
          )}
        </>
      )}
      {said?.text && <p role="status" className="lb-caption" style={{ margin: "8px 16px 0" }}>{said.text}</p>}
      {said?.error && <p role="alert" className="lb-caption" style={{ color: "var(--color-destructive)", margin: "8px 16px 0" }}><ErrorNote error={said.error} /></p>}
    </section>
  );
}
