// dashboard/src/components/transcript/BotSuggestion.tsx
// The card of a Bot's suggestion of another Bot (contract v0.8 §5): "Sugestão: criar o Bot “Cobrança”" with Criar and Ignorar.
// Criar hands the two fields to the shell, which opens the create assistant PREFILLED: the person still picks the template, the model
// and the rules, and confirms; the card itself never creates anything. Ignorar hides it, only for this message on this screen.
// Name and role are plain text (lib/botSuggestion.ts checked them). Without a handler from the shell (the shell is the only one that
// can open the assistant) the marker stays text.

import React from "react";
import { Markdown } from "../../lib/render/markdown";
import { splitBotSuggestions, type BotSuggestion } from "../../lib/botSuggestion";
import { useLuveI18n } from "../../i18n";
import { splitEvidence } from "../../lib/evidence";
import { EvidenceBlock } from "./EvidenceContext";

const Ctx = React.createContext<((s: BotSuggestion) => void) | null>(null);

/** The shell provides how a suggestion opens the create assistant. */
export function BotSuggestionProvider({ onCreate, children }: { onCreate: (s: BotSuggestion) => void; children: React.ReactNode }) {
  return <Ctx.Provider value={onCreate}>{children}</Ctx.Provider>;
}

function Card({ suggestion, onCreate }: { suggestion: BotSuggestion; onCreate: (s: BotSuggestion) => void }) {
  const { t } = useLuveI18n();
  const [hidden, setHidden] = React.useState(false);
  if (hidden) return null;
  return (
    <div data-testid="bot-suggestion" role="group" aria-label={t("sgBotTitle", { name: suggestion.name })}
      style={{ border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-card-foreground)", borderRadius: 12, padding: "10px 12px", margin: "8px 0", display: "flex", flexDirection: "column", gap: 6 }}>
      <strong style={{ fontSize: 14 }}>{t("sgBotTitle", { name: suggestion.name })}</strong>
      <span data-testid="bot-suggestion-role" style={{ fontSize: 13, overflowWrap: "anywhere" }}>{suggestion.role}</span>
      <span style={{ fontSize: 12, color: "var(--color-muted-foreground)" }}>{t("sgBotHint")}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="button" data-testid="btn-bot-suggestion-create" className="lb-btn lb-btn-primary" onClick={() => onCreate(suggestion)}>{t("sgBotCreate")}</button>
        <button type="button" data-testid="btn-bot-suggestion-ignore" className="lb-btn" onClick={() => setHidden(true)}>{t("sgBotIgnore")}</button>
      </div>
    </div>
  );
}

/** A piece of text: Markdown, with a well-formed suggestion marker turned into its card. */
function TextBody({ text }: { text: string }) {
  const onCreate = React.useContext(Ctx);
  const segments = React.useMemo(() => (onCreate ? splitBotSuggestions(text) : null), [onCreate, text]);
  if (!segments || (segments.length === 1 && segments[0].kind === "text")) return <Markdown text={text} />;
  return <>{segments.map((s, i) => (s.kind === "text" ? <Markdown key={i} text={s.text} /> : <Card key={i} suggestion={s.suggestion} onCreate={onCreate!} />))}</>;
}

/** What a Bot said, in every place a Bot message is drawn (conversation, thread, room): Markdown, a well-formed suggestion marker as its card, and a closed, valid `luve-evidence`
 *  block as the evidence card (lib/evidence.ts decides, all or nothing: anything else stays the code block it is). */
export function BotMessageBody({ text }: { text: string }) {
  const parts = React.useMemo(() => splitEvidence(text), [text]);
  if (parts.length === 1 && parts[0].kind === "text") return <TextBody text={text} />;
  return <>{parts.map((p, i) => (p.kind === "text" ? <TextBody key={i} text={p.text} /> : <EvidenceBlock key={i} evidence={p.evidence} />))}</>;
}
