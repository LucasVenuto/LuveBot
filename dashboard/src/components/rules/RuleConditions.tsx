// dashboard/src/components/rules/RuleConditions.tsx
// The conditions of a rule (docs/contracts/rules-conditions-v0.md): `path` (22a: "this rule is about a FILE", write_file and patch) and
// `recipient` (22b: where a message or task goes, kanban_create and cronjob_manage). The editor sends `match.conditions = [{fact, op,
// value}]` (path: under | glob | eq; recipient: eq); the backend validates and the screen only shows its refusal in words. The seal
// says what a condition does NOT see, and a hook too old to send the facts (the rule then asks about everything). Nothing decides here.

import React from "react";
import type { Bot, Rule, RuleLevel, SealResult } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { visibleTokens } from "../../lib/hiddenChars";

export const FILE_TOOLS = ["write_file", "patch"];
export const RECIPIENT_TOOLS = ["kanban_create", "cronjob_manage"];

/** What the person picks: no condition, a path operator, or a recipient. */
export type CondKind = "" | "under" | "glob" | "eq" | "recipient";
export const COND_KINDS: Exclude<CondKind, "">[] = ["under", "glob", "eq", "recipient"];

const LABEL: Record<Exclude<CondKind, "">, TranslationKey> = { under: "condPathUnder", glob: "condPathGlob", eq: "condPathEq", recipient: "condRecipient" };
const PLACEHOLDER: Record<Exclude<CondKind, "">, string> = { under: "workspace:pages", glob: "workspace:pages/**", eq: "workspace:pages/a.md", recipient: "bot:vendas" };

/** The tools a condition goes with: the only ones whose adapter reads its fact. */
export const toolsFor = (kind: CondKind): string[] => (kind === "recipient" ? RECIPIENT_TOOLS : kind ? FILE_TOOLS : []);

/** The condition the editor sends, or null when there is none (no kind, or no value yet). */
export function conditionFor(kind: CondKind, value: string): { fact: "path" | "recipient"; op: string; value: string } | null {
  const v = value.trim();
  if (!kind || !v) return null;
  return kind === "recipient" ? { fact: "recipient", op: "eq", value: v } : { fact: "path", op: kind, value: v };
}

export interface Condition { fact: string; op: string; value: string }

/** A rule's conditions as a list, whatever shape the backend sent: the API list, or the older {fact: value} object (an equality). */
export function conditionsOf(rule: Pick<Rule, "match">): Condition[] {
  const c = rule.match?.conditions;
  if (Array.isArray(c)) return c.map((x) => ({ fact: x.fact, op: x.op ?? "eq", value: x.value }));
  return c && typeof c === "object" ? Object.entries(c).map(([fact, value]) => ({ fact, op: "eq", value })) : [];
}

/** A rule's conditions as the editor holds them (it holds ONE): the first it can show, and how many it could not carry. A suggestion's draft must not lose
 *  a condition in silence (red team M2): the editor says when some stayed behind. */
export function editorCondition(rule: Pick<Rule, "match">): { kind: CondKind; value: string; left: number } {
  const all = conditionsOf(rule);
  const at = all.findIndex((c) => (c.fact === "recipient" && c.op === "eq") || (c.fact === "path" && (c.op === "under" || c.op === "glob" || c.op === "eq")));
  if (at < 0) return { kind: "", value: "", left: all.length };
  const c = all[at];
  return { kind: c.fact === "recipient" ? "recipient" : (c.op as CondKind), value: c.value, left: all.length - 1 };
}

export type RecipientScope = "bot" | "all" | "chat" | "other";

/** Where a recipient value reaches, or null when it stays in this chat or on this machine (`origin`, `local`). Anything the screen does not know is "other":
 *  it warns, never stays quiet (red team 29/10 M3: `all` and `chat:<platform>:<id>` reach people outside LuveBot, and used to carry no warning). */
export function recipientScope(value: string): RecipientScope | null {
  const v = value.trim();
  if (!v || v === "origin" || v === "local") return null;
  if (v.startsWith("bot:")) return "bot";
  if (v === "all") return "all";
  if (v.startsWith("chat:")) return "chat";
  return "other";
}
const WARNING: Record<RecipientScope, TranslationKey> = { bot: "condRecipientWarning", all: "condRecipientWarningAll", chat: "condRecipientWarningChat", other: "condRecipientWarningOther" };

/** An `allow` (or `explicit`) towards somewhere that is not this chat or this machine: a Bot receives what the first one writes (T13; the second Bot's own rules
 *  still hold), `all` reaches every channel that is on, a chat reaches whoever is in it. */
export function RecipientWarning({ level, value, bots = [] }: { level: RuleLevel; value: string; bots?: Bot[] }) {
  const { t } = useLuveI18n();
  const scope = recipientScope(value);
  if ((level !== "allow" && level !== "explicit") || !scope) return null;
  const name = value.trim().slice(4), label = bots.find((b) => b.name === name)?.display?.label || name;
  return <p data-testid="recipient-warning" data-scope={scope} className="lb:text-[13px] lb:m-0" style={{ color: "var(--color-warning)" }}>{t(WARNING[scope], { bot: label, to: value.trim() })}</p>;
}

/** The editor's field for a condition: the kind (or none), its value, and what it goes with. */
export function ConditionFields({ kind, value, level, bots = [], onKind, onValue }: {
  kind: CondKind; value: string; level: RuleLevel; bots?: Bot[]; onKind: (kind: CondKind) => void; onValue: (value: string) => void;
}) {
  const { t } = useLuveI18n();
  return (
    <div data-testid="condition-fields">
      <label htmlFor="new-rule-condition-kind" className="lb-label lb:block lb:mb-1">{t("condLabel")}</label>
      <select id="new-rule-condition-kind" value={kind} onChange={(e) => onKind(e.target.value as CondKind)} className="lb-input">
        <option value="">{t("condNone")}</option>
        {COND_KINDS.map((k) => <option key={k} value={k}>{t(LABEL[k])}</option>)}
      </select>
      {kind && (
        <div className="lb:mt-2 lb:space-y-1">
          <input id="new-rule-condition-value" type="text" aria-label={t("condValue")} value={value} onChange={(e) => onValue(e.target.value)}
            placeholder={PLACEHOLDER[kind]} list={kind === "recipient" ? "new-rule-recipients" : undefined} className="lb-input lb-mono" />
          {kind === "recipient" && (
            <datalist id="new-rule-recipients">
              {["origin", "local", "all", ...bots.map((b) => `bot:${b.name}`)].map((v) => <option key={v} value={v} />)}
            </datalist>
          )}
          <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:m-0">{t(kind === "recipient" ? "condRecipientHelp" : "condPathHelp")}</p>
          <p data-testid="condition-scope" className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:m-0">
            {t(kind === "recipient" ? "condRecipientToolsOnly" : "condPathFileToolsOnly")}
          </p>
          {kind === "recipient" && <RecipientWarning level={level} value={value} bots={bots} />}
        </div>
      )}
    </div>
  );
}

/** The conditions of a rule, in words, one line each. */
export function ConditionLines({ rule }: { rule: Pick<Rule, "id" | "match"> }) {
  const { t } = useLuveI18n();
  const items = conditionsOf(rule);
  if (!items.length) return null;
  return (
    <>
      {items.map((c, i) => {
        const kind: CondKind | null = c.fact === "recipient" ? "recipient" : c.fact === "path" && (c.op === "under" || c.op === "glob" || c.op === "eq") ? c.op : null;
        return (
          <div key={i} data-testid={`rule-condition-${rule.id}-${i}`} className="lb:flex lb:items-center lb:gap-1.5 lb:flex-wrap">
            <span className="lb:font-medium">{kind ? t(LABEL[kind]) : c.fact}</span>
            <span className="lb:font-mono lb:text-xs lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:bg-[var(--background)] lb:border-[var(--lb-separator)]" style={{ overflowWrap: "anywhere" }}>{visibleTokens(c.value)}</span>
          </div>
        );
      })}
    </>
  );
}

/** The warning of an `allow` towards a Bot, a chat or every channel, on the rule's card. */
export function RuleRecipientWarning({ rule, bots }: { rule: Pick<Rule, "level" | "match">; bots?: Bot[] }) {
  const to = conditionsOf(rule).find((c) => c.fact === "recipient" && recipientScope(c.value));
  return to ? <RecipientWarning level={rule.level} value={to.value} bots={bots} /> : null;
}

/** Next to the seal of a rule that has a condition: what the seal does not see (the qualifiers come from the SealResult only). */
export function ConditionCaveats({ sealResult }: { sealResult?: SealResult }) {
  const { t } = useLuveI18n();
  const q = sealResult?.qualifiers ?? [];
  const items: Array<[string, TranslationKey, TranslationKey]> = [];
  if (q.includes("paths_file_tools_only")) items.push(["seal-paths-caveat", "condPathSealTitle", "condPathSealWhy"]);
  if (q.includes("conditions_adapter_tools_only")) items.push(["seal-adapters-caveat", "condAdapterSealTitle", "condAdapterSealWhy"]);
  return (
    <>
      {items.map(([id, title, why]) => (
        <span key={id} data-testid={id} className="lb-caption" style={{ display: "block", color: "var(--color-muted-foreground)" }}>
          <span style={{ display: "block", fontWeight: 600 }}>{t(title)}</span>
          <span style={{ display: "block" }}>{t(why)}</span>
        </span>
      ))}
    </>
  );
}

/** Problems of a seal we can say in words; anything else keeps the backend's own code and detail. */
const PROBLEM_WORDS: Record<string, TranslationKey> = {
  hook_outdated: "problemHookOutdated",
  bad_path_condition: "errBadPathCondition",
  fold_divergence: "errFoldDivergence",
  path_condition_needs_file_tools: "errPathNeedsFileTools",
  bad_recipient_condition: "errBadRecipientCondition",
  condition_needs_adapter_tools: "errNeedsAdapterTools",
};
export const problemWords = (code: string): TranslationKey | null => PROBLEM_WORDS[code] ?? null;
