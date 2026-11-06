// dashboard/src/components/routines/RoutineSuggestions.tsx
// "Sugestão do Hermes" (contract v0.10 §2.2): automations Hermes itself proposes for a Bot, one calm card each, in Routines (per Bot) and in
// Today (the list). Nothing is created by listing them. "Criar pausada" (the default) and "Criar e iniciar" go through the backend's own
// create path, which makes the routine PAUSED and starts it only if the same gates as a hand-made routine allow it; accepting needs a person
// with a login (in loopback the buttons are replaced by one line, "Dispensar" stays). A suggestion LuveBot does not create (`supported:
// false`) says why in words and sends the person to Hermes. Every text here was written by a model or a skill: plain text, never HTML or
// Markdown (React escapes it; there is no other path to the screen).

import React from "react";
import type { Bot, RoutineSuggestion } from "../../api/types";
import { acceptRoutineSuggestion, dismissRoutineSuggestion, getRoutineSuggestions, getSession } from "../../api/client";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { describeSchedule } from "../../lib/schedule";
import { noLoginOf, type NoLogin } from "../../lib/authMode";
import { Avatar } from "../ui/Avatar";
import { ClockIcon } from "../Icons";
import { ErrorNote, GENERAL, humanError, type ErrorState, type HumanError } from "../ui/ErrorNote";

const SOURCE: Record<string, TranslationKey> = { catalog: "rsgSrcCatalog", blueprint: "rsgSrcBlueprint", usage: "rsgSrcUsage", integration: "rsgSrcIntegration" };
const WHY: Record<string, TranslationKey> = {
  delivery_outside: "rsgWhyDelivery", no_agent: "rsgWhyNoAgent", invalid_spec: "rsgWhyInvalid", too_large: "rsgWhyTooLarge",
};
// What the backend names when the gates of POST /routines/{id}/resume refuse the start (a Bot paused, held by the cap, Hermes out): the routine stays paused. A code with no
// sentence of its own says that it could not be started now (the routine is in the list, paused, where the exact reason shows).
const HELD: Record<string, TranslationKey> = { bot_paused: "errBotPaused", budget_held: "errBudgetExceeded", budget_exceeded: "errBudgetExceeded" };
const heldWords = (code: string): TranslationKey => HELD[code] ?? GENERAL[code] ?? "rsgHeldOther";

type Outcome =
  | { kind: "created"; item: RoutineSuggestion; started: boolean; held?: string; replayed: boolean }
  | { kind: "gone"; item: RoutineSuggestion };

export const suggestionKey = (s: Pick<RoutineSuggestion, "bot" | "id">) => `${s.bot}:${s.id}`;
const scheduleOf = (s: RoutineSuggestion): string => {
  const x = s.spec?.schedule;
  return typeof x === "string" ? x : x?.expr || x?.display || "";
};

export interface RoutineSuggestionsProps {
  bots?: Bot[];
  /** A Bot's own page lists only that Bot's suggestions. */
  botName?: string;
  /** "routines" says everything (an empty line, a named error, a missing capability: never an empty list that looks like "none"); "today" shows only what there is to decide and stays quiet when the read fails. */
  variant?: "routines" | "today";
  /** After a routine was created, so the list that shows routines can read again. */
  onAccepted?: () => void;
}

export function RoutineSuggestions({ bots = [], botName, variant = "routines", onAccepted }: RoutineSuggestionsProps) {
  const { t, locale } = useLuveI18n();
  const [items, setItems] = React.useState<RoutineSuggestion[]>([]);
  const [partial, setPartial] = React.useState<string[]>([]);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = React.useState<HumanError | null>(null);
  const [noLogin, setNoLogin] = React.useState<NoLogin | null>(null);          // why the person cannot accept: no login (loopback) or the deployment token (a machine)
  const [outcome, setOutcome] = React.useState<Record<string, Outcome>>({});
  const [cardError, setCardError] = React.useState<Record<string, ErrorState>>({});
  const [noCreate, setNoCreate] = React.useState<ReadonlySet<string>>(new Set());   // accept answered capability_missing (this Hermes lacks the setter): list and dismiss still work
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    setStatus("loading");
    getRoutineSuggestions().then(
      (r) => { if (!alive) return; setItems(Array.isArray(r?.items) ? r.items : []); setPartial(Array.isArray(r?.partial) ? r.partial : []); setLoadError(null); setStatus("ready"); },
      (e) => { if (alive) { setLoadError(humanError(e, t, "rsgLoadError")); setStatus("error"); } },
    );
    return () => { alive = false; };
  }, [reload]);   // eslint-disable-line react-hooks/exhaustive-deps -- `t` only picks the words
  // Whether this is a person with a login is asked only when there is a card that could be accepted (Today opens with no extra request).
  const acceptable = status === "ready" && items.some((s) => s.supported);
  React.useEffect(() => {
    if (!acceptable) return;
    let alive = true;
    getSession().then((s) => { if (alive) setNoLogin(noLoginOf(s?.auth_mode)); }, () => { /* the server decides at the click */ });
    return () => { alive = false; };
  }, [acceptable]);

  const mine = (bot: string) => !botName || bot === botName;
  const shown = items.filter((s) => mine(s.bot));
  const kept = Object.values(outcome).map((o) => o.item).filter((s) => mine(s.bot) && !shown.some((x) => suggestionKey(x) === suggestionKey(s)));
  const cards = [...shown, ...kept];
  const unread = partial.filter(mine);
  const label = (name: string) => bots.find((b) => b.name === name)?.display?.label || name;

  const accept = async (s: RoutineSuggestion, start: boolean) => {
    const k = suggestionKey(s);
    setBusy(k); setNote(null); setCardError((c) => { const { [k]: _gone, ...rest } = c; return rest; });
    try {
      const r = await acceptRoutineSuggestion(s.bot, s.id, start);
      setOutcome((o) => ({ ...o, [k]: { kind: "created", item: s, started: !!r.started, held: r.held, replayed: !!r.replayed } }));
      onAccepted?.();
    } catch (e) {
      const h = humanError(e, t, "rsgError");
      if (h.code === "suggestion_not_pending") setOutcome((o) => ({ ...o, [k]: { kind: "gone", item: s } }));
      else {
        if (h.code === "loopback_not_human") setNoLogin("loopback");
        if (h.code === "credential_not_human") setNoLogin("deployment");
        if (h.code === "capability_missing") setNoCreate((all) => new Set(all).add(k));
        setCardError((c) => ({ ...c, [k]: h }));
      }
    } finally { setBusy(null); }
  };
  const dismiss = async (s: RoutineSuggestion) => {
    const k = suggestionKey(s);
    setBusy(k); setNote(null); setCardError((c) => { const { [k]: _gone, ...rest } = c; return rest; });
    try {
      await dismissRoutineSuggestion(s.bot, s.id);
      setItems((all) => all.filter((x) => suggestionKey(x) !== k));
      setNote(t("rsgDismissed"));
    } catch (e) {
      const h = humanError(e, t, "rsgDismissError");
      if (h.code === "suggestion_not_pending") setOutcome((o) => ({ ...o, [k]: { kind: "gone", item: s } }));
      else setCardError((c) => ({ ...c, [k]: h }));
    } finally { setBusy(null); }
  };

  if (status === "loading") return null;
  if (status === "error" && variant === "today") return null;   // a side list of Today: a failed read says nothing (it never claims "none")
  if (status === "ready" && !cards.length && !note && variant === "today") return null;

  const head = <h2 id={`rsg-title-${variant}`} className="lb-headline" style={{ margin: "0 4px" }}>{t(cards.length === 1 ? "rsgTitleOne" : "rsgTitleMany")}</h2>;
  return (
    <section data-testid={`routine-suggestions-${variant}`} aria-labelledby={`rsg-title-${variant}`} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {head}
      {status === "error" && loadError && (
        <p role="alert" data-testid="routine-suggestions-error" className="lb-caption" style={{ margin: "0 4px", color: "var(--color-destructive)" }}>
          <ErrorNote error={loadError} />{" "}
          <button type="button" className="lb-btn" onClick={() => setReload((n) => n + 1)}>{t("retry")}</button>
        </p>
      )}
      {note && <p role="status" data-testid="routine-suggestions-note" className="lb-caption" style={{ margin: "0 4px" }}>{note}</p>}
      {status === "ready" && !cards.length && !note && (
        <div data-testid="routine-suggestions-empty" className="lb-group lb-empty"><p className="lb-caption" style={{ margin: 0 }}>{t("rsgEmpty")}</p></div>
      )}
      {cards.map((s) => (
        <Card key={suggestionKey(s)} s={s} bot={bots.find((b) => b.name === s.bot)} botLabel={label(s.bot)} outcome={outcome[suggestionKey(s)]}
          error={cardError[suggestionKey(s)]} busy={busy !== null} noLogin={noLogin} noCreate={noCreate.has(suggestionKey(s))} locale={locale}
          onAccept={(start) => void accept(s, start)} onDismiss={() => void dismiss(s)} />
      ))}
      {unread.length > 0 && <p data-testid="routine-suggestions-partial" className="lb-caption" style={{ margin: "0 4px" }}>{t("rsgPartial", { bots: unread.map(label).join(", ") })}</p>}
    </section>
  );
}

interface CardProps {
  s: RoutineSuggestion; bot?: Bot; botLabel: string; outcome?: Outcome; error?: ErrorState; busy: boolean; noLogin: NoLogin | null; noCreate: boolean; locale: "pt" | "en";
  onAccept: (start: boolean) => void; onDismiss: () => void;
}

function Card({ s, bot, botLabel, outcome, error, busy, noLogin, noCreate, locale, onAccept, onDismiss }: CardProps) {
  const { t } = useLuveI18n();
  const id = React.useId();
  const k = suggestionKey(s);
  const expr = scheduleOf(s);
  const when = expr ? describeSchedule(expr, t, locale) ?? t("scheduleLabel", { expr }) : null;
  const cut = Object.values(s.truncated ?? {}).some(Boolean);
  const skills = Array.isArray(s.spec?.skills) ? s.spec.skills.filter((x) => typeof x === "string") : [];
  const why = s.why_not === "unsupported_fields"
    ? ((s.fields?.length ?? 0) > 0 ? t("rsgWhyUnsupportedFields", { fields: (s.fields ?? []).join(", ") }) : t("rsgWhyUnsupportedNoNames"))
    : t(WHY[s.why_not ?? ""] ?? "rsgWhyOther");
  const dismissBtn = (
    <button type="button" data-testid={`btn-rsg-dismiss-${k}`} className="lb-btn" disabled={busy} title={t("rsgDismissHint")} aria-describedby={`${id}-title`} onClick={onDismiss}>{t("rsgDismiss")}</button>
  );
  return (
    <article data-testid={`routine-suggestion-${k}`} aria-busy={busy} className="lb-group" style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <Avatar name={botLabel} avatar={bot?.display?.avatar} color={bot?.display?.color} size={24} />
        <span className="lb-caption" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
          <strong style={{ fontWeight: 600 }}>{t("rsgTitleOne")}</strong> · {t(SOURCE[s.source] ?? "rsgSrcOther")} · {t("rsgFor", { bot: botLabel })}
        </span>
      </div>
      <h3 id={`${id}-title`} className="lb-body" data-testid={`rsg-title-${k}`} style={{ margin: 0, fontWeight: 600, overflowWrap: "anywhere" }}>{s.title}</h3>
      {s.description && <p className="lb-caption" data-testid={`rsg-description-${k}`} style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{s.description}</p>}
      {when && (
        <div><span className="lb-pill" data-testid={`rsg-when-${k}`} style={{ background: "var(--lb-fill-2)", maxWidth: "100%" }}><ClockIcon size={13} /><span style={{ overflowWrap: "anywhere" }}>{when}</span></span></div>
      )}
      {s.supported && <p className="lb-caption" style={{ margin: 0 }}>{t("rsgWhereLocal")}</p>}
      {(s.spec?.prompt || skills.length > 0 || s.spec?.model) && (
        <details>
          <summary className="lb-caption" style={{ cursor: "pointer" }}>{t("rsgPromptSummary")}</summary>
          {(skills.length > 0 || s.spec?.model) && (
            <p className="lb-caption" style={{ margin: "6px 0 0", overflowWrap: "anywhere" }}>
              {[skills.length ? t("rsgSkills", { list: skills.join(", ") }) : "", s.spec?.model ? t("rsgModel", { model: s.spec.model }) : ""].filter(Boolean).join(" · ")}
            </p>
          )}
          {s.spec?.prompt && <pre data-testid={`rsg-prompt-${k}`} className="lb-mono" style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 220, overflowY: "auto", fontSize: 12 }}>{s.spec.prompt}</pre>}
        </details>
      )}
      {cut && <p className="lb-caption" style={{ margin: 0 }}>{t("rsgTruncated")}</p>}

      {outcome?.kind === "created" ? (
        <div role="status" data-testid={`rsg-created-${k}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <p className="lb-body" style={{ margin: 0, color: "var(--color-success)", fontWeight: 600 }}>
            {outcome.held ? t("rsgCreatedHeld", { why: t(heldWords(outcome.held)) }) : outcome.started ? t("rsgCreatedStarted") : t("rsgCreated")}
          </p>
          {outcome.replayed && <p className="lb-caption" style={{ margin: 0 }}>{t("rsgReplayed")}</p>}
        </div>
      ) : outcome?.kind === "gone" ? (
        <p role="status" data-testid={`rsg-gone-${k}`} className="lb-caption" style={{ margin: 0, fontWeight: 600 }}>{t("rsgGone")}</p>
      ) : s.supported && noCreate ? (
        <>
          <p className="lb-caption" style={{ margin: 0 }}>{t("rsgAcceptInHermes")}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{dismissBtn}</div>
        </>
      ) : s.supported ? (
        noLogin ? (
          <>
            <p role="note" data-testid={`rsg-needlogin-${k}`} className="lb-caption" style={{ margin: 0 }}>{noLogin === "deployment" ? t("errCredentialNotHuman") : t("rsgNeedLogin")}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{dismissBtn}</div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button type="button" data-testid={`btn-rsg-paused-${k}`} className="lb-btn lb-btn-primary" disabled={busy} aria-describedby={`${id}-title`} onClick={() => onAccept(false)}>{t("rsgCreatePaused")}</button>
              <button type="button" data-testid={`btn-rsg-start-${k}`} className="lb-btn" disabled={busy} aria-describedby={`${id}-title`} onClick={() => onAccept(true)}>{t("rsgCreateStart")}</button>
              {dismissBtn}
            </div>
            <p className="lb-caption" style={{ margin: 0 }}>{t("rsgCreateHint")}</p>
          </>
        )
      ) : (
        <>
          <p data-testid={`rsg-why-${k}`} className="lb-caption" style={{ margin: 0, color: "var(--color-warning)", fontWeight: 600 }}>{why}</p>
          <p className="lb-caption" style={{ margin: 0 }}>{t("rsgAcceptInHermes")}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{dismissBtn}</div>
        </>
      )}
      {error && <p role="alert" data-testid={`rsg-error-${k}`} className="lb-caption" style={{ margin: 0, color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
    </article>
  );
}
