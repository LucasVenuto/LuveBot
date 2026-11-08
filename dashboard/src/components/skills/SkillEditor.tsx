// dashboard/src/components/skills/SkillEditor.tsx
// Editing a skill that already exists (contract v0.11 §3.3): the whole text in an editable plain-text area, then the CHANGE as a line diff against the text the person loaded, and only then Save, for a person with a login,
// with the digest of the text that was loaded (a skill that changed meanwhile is a 409 `stale`, never overwritten). The same rules as the review of a draft hold: invisible characters named and removed only on a tap,
// padding warned, and the change read to its last line before Save turns on (an edit that adds hundreds of blank lines must not hide what follows them). If the skill is ON the screen says the Bot uses the change at once.
// The text is written back with the line ending the skill HAD (pages/eol.ts), so opening and saving without a change is not a change.

import React from "react";
import { editSkill } from "../../api/client";
import type { SkillContent, SkillEdited } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { lineCount, removeMarked } from "../../lib/skillTeach";
import { useNoLoginKind } from "../chat/RunControls";
import { eolOf, toDisk, toView } from "../pages/eol";
import { DiffView } from "../pages/DiffView";
import { lineDiff } from "../pages/pages";
import { ErrorNote, type ErrorState } from "../ui/ErrorNote";
import { InvisiblePanel, PaddingNotes, localRefusal } from "./SkillTextNotes";
import { findingsText, scanCats, skillError } from "./skillWords";

export interface SkillEditorProps {
  bot: string;
  skill: string;
  /** The text as loaded (with its digest); `digest` is required to save. */
  doc: SkillContent;
  /** The skill is ON: the Bot uses a change at once. */
  on: boolean;
  onCancel: () => void;
  onSaved: (next: { content: string; digest: string }) => void;
  /** After a 409: the skill changed, read it again. */
  onReload: () => void;
}

export function SkillEditor({ bot, skill, doc, on, onCancel, onSaved, onReload }: SkillEditorProps) {
  const { t } = useLuveI18n();
  const noLogin = useNoLoginKind();
  const eol = React.useRef(eolOf(doc.content));
  const original = React.useMemo(() => toView(doc.content), [doc.content]);
  const [text, setText] = React.useState(original);
  const [step, setStep] = React.useState<"edit" | "review">("edit");
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<ErrorState | null>(null);
  const [stale, setStale] = React.useState(false);
  const [saved, setSaved] = React.useState<SkillEdited | null>(null);
  const box = React.useRef<HTMLDivElement | null>(null);
  const [atEnd, setAtEnd] = React.useState(false);
  const local = localRefusal(text, t);
  const changed = text !== original;
  const diff = React.useMemo(() => (step === "review" ? lineDiff(original, text) : undefined), [step, original, text]);   // null: too big to compare here

  const measure = React.useCallback(() => {
    const el = box.current;
    if (el) setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight <= 2);
  }, []);
  React.useLayoutEffect(measure, [measure, step, text, diff]);

  async function save() {
    if (busy || !changed || !doc.digest || diff == null) return;
    setBusy(true);
    setProblem(null);
    const content = toDisk(text, eol.current);
    try {
      const done = await editSkill(bot, skill, { content, expected_digest: doc.digest });
      setSaved(done);
      onSaved({ content, digest: done.digest });
    } catch (e) {
      setStale(!!e && typeof e === "object" && (e as { code?: string }).code === "stale");
      setProblem(skillError(e, t, "skillWhyOther"));
    } finally { setBusy(false); }
  }

  if (saved) {
    const scan = saved.scan;
    return (
      <div data-testid="skill-editor-saved" role="status" style={{ display: "grid", gap: 6 }}>
        <p className="lb-body" style={{ margin: 0, fontWeight: 600 }}>{t("skillEditSaved")}</p>
        <p data-testid="skill-edit-scan" className="lb-caption" style={{ margin: 0 }}>
          {saved.turned_off ? t("skillEditTurnedOff")                       // A-177: the edit made an ON skill blocked, and LuveBot turned it OFF: say why
            : scan?.policy === "block" ? t(saved.on ? "skillEditBlockedOn" : "skillScanBlock")
            : scan?.policy === "ask" ? t("skillEditScanAsk", { what: findingsText(scan.findings, t), cats: scanCats(scan.categories, t) || "-" })
            : scan?.policy === "allow" ? t("skillScanAllow") : t("skillScanNone")}
        </p>
        <div><button type="button" className="lb-btn" onClick={onCancel}>{t("close")}</button></div>
      </div>
    );
  }
  return (
    <div data-testid="skill-editor" style={{ display: "grid", gap: 8 }}>
      <p className="lb-body" style={{ margin: 0, fontWeight: 600 }}>{t("skillEditWarn")}</p>
      {step === "edit" ? (
        <>
          <InvisiblePanel text={text} onRemove={() => setText(removeMarked(text))} />
          <label className="lb-field">
            <span className="lb-label">{t("skillSheetText")}</span>
            <textarea className="lb-input" rows={14} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)}
              style={{ fontFamily: "var(--lb-mono)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", resize: "vertical" }} />
          </label>
          <p className="lb-caption" style={{ margin: 0 }}>{t("skillSheetLines", { n: lineCount(text) })}</p>
          <PaddingNotes text={text} />
          {local && <p role="alert" className="lb-alert" style={{ margin: 0 }}>{local}</p>}
          {!changed && <p role="status" className="lb-caption" style={{ margin: 0 }}>{t("skillEditNothing")}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="lb-btn" onClick={onCancel}>{t("cancelBtn")}</button>
            <button type="button" className="lb-btn lb-btn-primary" disabled={!changed || !!local} onClick={() => { setProblem(null); setStale(false); setStep("review"); }}>{t("skillEditReview")}</button>
          </div>
        </>
      ) : (
        <>
          <p role="status" className="lb-caption" style={{ margin: 0 }}>{t(on ? "skillEditOn" : "skillEditOff")}</p>
          {diff === null ? <p role="alert" className="lb-alert" style={{ margin: 0 }}>{t("skillEditTooBig")}</p> : (
            <div ref={box} onScroll={measure} data-testid="skill-diff-box" style={{ maxHeight: 320, overflow: "auto" }}>
              <DiffView lines={diff ?? null} beforeLabel={t("skillEditBefore")} afterLabel={t("skillEditAfter")} />
            </div>
          )}
          {diff !== null && !atEnd && <p role="note" className="lb-caption" style={{ margin: 0 }}>{t("skillEditScrollFirst")}</p>}
          {noLogin !== null && <p role="status" className="lb-caption" style={{ margin: 0 }}>{noLogin === "deployment" ? t("errCredentialNotHuman") : t("skillNeedLogin")}</p>}
          {problem && <p role="alert" className="lb-alert" style={{ margin: 0 }}><ErrorNote error={problem} /></p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="lb-btn" onClick={() => setStep("edit")}>{t("skillEditBack")}</button>
            {stale && <button type="button" className="lb-btn" onClick={onReload}>{t("skillEditReload")}</button>}
            <button type="button" className="lb-btn lb-btn-primary" disabled={busy || !changed || diff == null || !atEnd || noLogin !== null || !doc.digest} onClick={() => void save()}>
              {busy ? t("skillEditSaving") : t("skillEditSave")}</button>
          </div>
        </>
      )}
    </div>
  );
}
