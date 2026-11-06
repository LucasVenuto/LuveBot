// dashboard/src/components/skills/SkillDraftCard.tsx
// What the conversation draws in place of the Bot's answer to the skill-draft turn (contract v0.11 §3.2 step 2). The draft text is NEVER drawn in the bubble: the message renderer closes a fence at the first line that
// starts with three backticks, so a draft written in a four-backtick fence would show cut, with the rest drawn as Markdown, while the sheet has all of it, and the sheet is the authority. The card says "Draft ready,
// N lines" and opens the sheet; a text that is not a draft says why in words and offers to ask again, and the answer is drawn as an ordinary message (a refusal never hides it, A-185). The extraction is strict and all-or-nothing (lib/skillDraft.ts) and runs only on the final answer of the turn the request started.

import React from "react";
import { useLuveI18n } from "../../i18n";
import { extractSkillDraft } from "../../lib/skillDraft";
import { lineCount } from "../../lib/skillTeach";
import { SkillReviewSheet } from "./SkillReviewSheet";
import { whyText } from "./skillWords";

/** `reload`: the turn came back from the HISTORY (no run id), so the answer is found by structure (contract v0.11 3.2 step 2, A-183): the card only for exactly ONE Bot message in the span that holds exactly one
 *  valid fence; with more messages every one is drawn as an ordinary message (the merged text, none hidden) and the screen offers to ask again. */
export function SkillDraftCard({ text, bot, onAskAgain, plain, reload }: { text: string; bot: string; onAskAgain: () => void; plain: () => React.ReactNode; reload?: { messages: number } }) {
  const { t } = useLuveI18n();
  const [open, setOpen] = React.useState(false);
  const many = !!reload && reload.messages > 1;
  const found = React.useMemo(() => (many ? null : extractSkillDraft(text)), [text, many]);
  if (!found) {
    return (
      <>
        {plain()}
        <div data-testid="skill-draft-refused" role="note" className="lb-caption" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: "4px 0" }}>
          <span>{t("skillWhyMany")}</span>
          <button type="button" className="lb-btn" onClick={onAskAgain}>{t("skillCardAgain")}</button>
        </div>
      </>
    );
  }
  if (found.ok) {
    return (
      <div data-testid="skill-draft-card" role="group" aria-label={t("skillCardReady", { n: lineCount(found.draft.content) })} className="lb-card" style={{ padding: 12, display: "grid", gap: 8, margin: "8px 0" }}>
        <p className="lb-body" style={{ margin: 0, fontWeight: 600 }}>{t("skillCardReady", { n: lineCount(found.draft.content) })}</p>
        <div><button type="button" className="lb-btn lb-btn-primary" onClick={() => setOpen(true)}>{t("skillCardReview")}</button></div>
        <SkillReviewSheet open={open} bot={bot} draft={found.draft} onClose={() => setOpen(false)} />
      </div>
    );
  }
  // A refusal NEVER hides the Bot's message, live or after a reload (A-185): the draft that is refused (a hidden character, too many invisible ones, a bad name, the rest of the list in 3.4) is drawn as the ordinary
  // message it is, with the reason (the class and the place, never the character) and "Pedir de novo". What the sheet cannot show is no reason to keep the Bot's words from the person.
  return (
    <>
      {plain()}
      <div data-testid="skill-draft-refused" role="note" className="lb-caption" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: "4px 0" }}>
        <span>{whyText(found.why, found.details as Record<string, unknown> | undefined, t)}</span>
        <button type="button" className="lb-btn" onClick={onAskAgain}>{t("skillCardAgain")}</button>
      </div>
    </>
  );
}

/** A draft turn that ended with no Bot message at all (a run that only used tools, a helper's delivery that closed the span first, a run that failed): there is nothing to review, and the person can ask again. */
export function SkillNoAnswer({ onAskAgain }: { onAskAgain: () => void }) {
  const { t } = useLuveI18n();
  return (
    <div data-testid="skill-draft-noanswer" role="note" className="lb-caption" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: "4px 0" }}>
      <span>{t("skillWhyNoAnswer")}</span>
      <button type="button" className="lb-btn" onClick={onAskAgain}>{t("skillCardAgain")}</button>
    </div>
  );
}

