// dashboard/src/components/rules/RuleSuggestions.tsx
// Rule suggestions (contract v0.8 §5; spec 4.10 "Bots podem propor regras, mas só você aprova"). Built by the backend from OUR approvals:
// the same action of the same Bot allowed "uma vez" 3 or more times in 7 days, with no denial. This only lists them. "Criar regra" hands the
// DRAFT preview to the rule editor, prefilled (the same path as "Sempre permitir…"); nothing is saved or applied here, and what the
// editor saves is a draft that counts only after a person activates it (invariant 6). "Ignorar" hides the action for 30 days.
// The command is the backend's redacted text, shown only as text.

import React from "react";
import type { Bot, Rule, RuleSuggestion } from "../../api/types";
import { dismissSuggestion, getSuggestions } from "../../api/client";
import { useLuveI18n } from "../../i18n";
import { visibleTokens } from "../../lib/hiddenChars";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

export const suggestionKey = (s: Pick<RuleSuggestion, "bot" | "action_class">) => `${s.bot}:${s.action_class}`;

export interface RuleSuggestionsProps {
  bots?: Bot[];
  /** A Bot's own page lists only that Bot's suggestions. */
  botName?: string;
  /** Bumped when rules change, so a suggestion already turned into a rule is asked again. */
  refreshKey?: number;
  /** Suggestions already turned into a draft in this visit (`bot:action_class`). */
  handled?: ReadonlySet<string>;
  onCreate: (suggestion: RuleSuggestion & { draft_preview: Rule }) => void;
}

export function RuleSuggestions({ bots = [], botName, refreshKey = 0, handled, onCreate }: RuleSuggestionsProps) {
  const { t } = useLuveI18n();
  const [items, setItems] = React.useState<RuleSuggestion[]>([]);
  const [error, setError] = React.useState<ErrorState | null>(null);
  React.useEffect(() => {
    let alive = true;
    getSuggestions().then((r) => { if (alive) setItems(r.suggestions ?? []); }, () => { /* no suggestions: the rules list is not blocked by them */ });
    return () => { alive = false; };
  }, [refreshKey]);

  const botLabel = (name: string) => bots.find((b) => b.name === name)?.display?.label || name;
  const shown = items.filter((s) => (!botName || s.bot === botName) && !handled?.has(suggestionKey(s)));
  if (!shown.length && !error) return null;

  const ignore = async (s: RuleSuggestion) => {
    setError(null);
    try { await dismissSuggestion(s.bot, s.action_class); setItems((all) => all.filter((x) => suggestionKey(x) !== suggestionKey(s))); }
    catch (e) { setError(humanError(e, t, "sgError")); }
  };

  return (
    <section data-testid="rule-suggestions" aria-labelledby="rule-suggestions-title" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h2 id="rule-suggestions-title" className="lb-headline" style={{ margin: "0 4px" }}>{t("sgTitle")}</h2>
      {error && <p role="alert" className="lb-caption" style={{ margin: "0 4px", color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
      {shown.map((s) => (
        <div key={suggestionKey(s)} data-testid={`suggestion-${suggestionKey(s)}`} className="lb-group" style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <p className="lb-body" style={{ margin: 0 }}>{t("sgRuleText", { bot: botLabel(s.bot), count: s.count })}</p>
          <p className="lb-caption lb-mono" data-testid={`suggestion-action-${suggestionKey(s)}`} style={{ margin: 0, overflowWrap: "anywhere" }}>
            {visibleTokens(s.action.tool)}{s.action.command ? `: ${visibleTokens(s.action.command)}` : ""}
          </p>
          {s.whole_tool && s.draft_preview && <p data-testid={`suggestion-whole-${suggestionKey(s)}`} className="lb-caption" style={{ margin: 0, color: "var(--color-warning)", fontWeight: 600 }}>{t("sgWholeTool", { tool: s.action.tool })}</p>}
          <p className="lb-caption" style={{ margin: 0 }}>{s.draft_preview ? t("sgRuleHint") : t("sgRuleNoDraft")}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {s.draft_preview && (
              <button type="button" data-testid={`btn-suggestion-create-${suggestionKey(s)}`} className="lb-btn lb-btn-primary"
                onClick={() => onCreate({ ...s, draft_preview: s.draft_preview as Rule })}>{t("sgCreateRule")}</button>
            )}
            <button type="button" data-testid={`btn-suggestion-ignore-${suggestionKey(s)}`} className="lb-btn" title={t("sgIgnoreHint")} onClick={() => void ignore(s)}>{t("sgIgnore")}</button>
          </div>
        </div>
      ))}
    </section>
  );
}
