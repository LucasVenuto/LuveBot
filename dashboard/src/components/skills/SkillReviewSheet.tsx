// dashboard/src/components/skills/SkillReviewSheet.tsx
// The review of a skill draft and its creation (contract v0.11 §3.2 steps 3 to 5, §3.4). A skill is instructions the Bot follows LATER, so this is the one sheet in the product where text written from a conversation
// becomes persistent instructions: it shows ALL of the text in an editable plain-text area (never rendered, never hidden), says how long it is and where it ends, will not enable Create until the person has scrolled
// to the last line, warns about padding (more than 20 blank lines in a row, a line of more than 1,000 columns), names every invisible character and offers to remove them ON A TAP (nothing is removed by itself),
// asks the server to check it (a dry run that writes nothing) and creates it born OFF only for a person with a login. Turning it on is a second, separate decision, shown with Hermes's scan.

import React from "react";
import { createSkill, previewSkill, setBotSkill } from "../../api/client";
import type { SkillCreated, SkillPreview } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import type { SkillDraft } from "../../lib/skillDraft";
import { headerName, lineCount, removeMarked } from "../../lib/skillTeach";
import { visibleTokens } from "../../lib/hiddenChars";
import { useNoLoginKind } from "../chat/RunControls";
import { Dialog } from "../ui/Dialog";
import { ErrorNote, type ErrorState } from "../ui/ErrorNote";
import { findingsText, scanCats, skillError } from "./skillWords";
import { InvisiblePanel, PaddingNotes, localRefusal } from "./SkillTextNotes";

const CHECK_AFTER_MS = 500;

export interface SkillReviewSheetProps {
  open: boolean;
  bot: string;
  draft: SkillDraft;
  onClose: () => void;
}

export function SkillReviewSheet({ open, bot, draft, onClose }: SkillReviewSheetProps) {
  const { t } = useLuveI18n();
  const noLogin = useNoLoginKind();
  const [text, setText] = React.useState(draft.content);
  const [category, setCategory] = React.useState("");
  const [preview, setPreview] = React.useState<{ text: string; value: SkillPreview } | null>(null);
  const [problem, setProblem] = React.useState<ErrorState | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [atEnd, setAtEnd] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [created, setCreated] = React.useState<SkillCreated | null>(null);
  const area = React.useRef<HTMLTextAreaElement | null>(null);
  const seq = React.useRef(0);
  React.useEffect(() => { if (open) { setText(draft.content); setCategory(""); setPreview(null); setProblem(null); setCreated(null); } }, [open, draft]);

  const name = headerName(text);
  // what the sheet can already say about this text, before the server is asked (the same table, the same words; the server never trusts this and checks again)
  const local: string | null = localRefusal(text, t) ?? (!name ? t("skillWhyNoName") : null);

  // the dry run: after the text (or the category) stops changing, and only for a text the sheet can already accept
  React.useEffect(() => {
    if (!open || created) return;
    if (local || !name) { seq.current++; setPreview(null); setProblem(null); setChecking(false); return; }
    const mine = ++seq.current;
    setChecking(true);
    const timer = window.setTimeout(() => {
      previewSkill(bot, { name, ...(category.trim() ? { category: category.trim() } : {}), content: text })
        .then((value) => { if (mine === seq.current) { setPreview({ text, value }); setProblem(null); } })
        .catch((e) => { if (mine === seq.current) { setPreview(null); setProblem(skillError(e, t, "skillWhyOther")); } })
        .finally(() => { if (mine === seq.current) setChecking(false); });
    }, CHECK_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [open, bot, text, name, category, local, created]); // eslint-disable-line react-hooks/exhaustive-deps

  // "scrolled to the last line": measured after every change of the text and on every scroll; a text that fits has no more to scroll to
  const measure = React.useCallback(() => {
    const el = area.current;
    if (el) setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight <= 2);
  }, []);
  React.useLayoutEffect(measure, [measure, text, open, created]);

  async function create() {
    if (!name || busy) return;
    setBusy(true);
    setProblem(null);
    try { setCreated(await createSkill(bot, { name, ...(category.trim() ? { category: category.trim() } : {}), content: text })); }
    catch (e) { setProblem(skillError(e, t, "skillWhyOther")); }
    finally { setBusy(false); }
  }

  const lines = lineCount(text);
  const canCreate = !!preview && preview.text === text && !checking && !problem && !local && atEnd && !busy && noLogin === null;

  return (
    <Dialog open={open} onClose={onClose} title={t("skillSheetTitle")} titleId="skill-sheet-title" width={760}>
      <div className="lb-dialog-body" data-testid="skill-sheet">
        <p className="lb-body" style={{ margin: 0, fontWeight: 600 }}>{t("skillSheetWarn")}</p>
        {created ? <CreatedCard bot={bot} created={created} onClose={onClose} /> : (
          <>
            <p className="lb-body" style={{ margin: 0, overflowWrap: "anywhere" }}><strong>{t("skillSheetName")}:</strong> <span>{name ? visibleTokens(name) : "-"}</span></p>
            {preview && preview.text === text && <p className="lb-body" style={{ margin: 0, overflowWrap: "anywhere" }}><strong>{t("skillSheetDescription")}:</strong> <span>{visibleTokens(preview.value.description)}</span></p>}
            <label className="lb-field">
              <span className="lb-label">{t("skillSheetCategory")}</span>
              <input className="lb-input" value={category} maxLength={64} onChange={(e) => setCategory(e.target.value)} />
            </label>
            <InvisiblePanel text={text} onRemove={() => setText(removeMarked(text))} />
            <label className="lb-field">
              <span className="lb-label">{t("skillSheetText")}</span>
              <textarea ref={area} className="lb-input" rows={16} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} onScroll={measure}
                style={{ fontFamily: "var(--lb-mono)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", resize: "vertical" }} />
            </label>
            <p className="lb-caption" style={{ margin: 0 }}>{t("skillSheetLines", { n: lines })}</p>
            <PaddingNotes text={text} />
            {!atEnd && <p role="note" className="lb-caption" style={{ margin: 0 }}>{t("skillSheetScrollFirst")}</p>}
            {checking && <p role="status" className="lb-caption" style={{ margin: 0 }}>{t("skillSheetChecking")}</p>}
            {preview && preview.text === text && !checking && !problem && <p role="status" className="lb-caption" style={{ margin: 0 }}>{t("skillSheetChecked", { bytes: preview.value.bytes })}</p>}
            {local && <p role="alert" className="lb-alert" style={{ margin: 0 }}>{local}</p>}
            {problem && <p role="alert" className="lb-alert" style={{ margin: 0 }}><ErrorNote error={problem} /></p>}
            {noLogin !== null && <p role="status" className="lb-caption" style={{ margin: 0 }}>{noLogin === "deployment" ? t("errCredentialNotHuman") : t("skillNeedLogin")}</p>}
            <div className="lb-dialog-footer">
              <button type="button" onClick={onClose} className="lb-btn">{t("cancelBtn")}</button>
              <button type="button" onClick={() => void create()} disabled={!canCreate} className="lb-btn lb-btn-primary">{busy ? t("skillCreating") : t("skillCreate")}</button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** The skill exists and is OFF. Turning it on is its own decision (a person with a login), shown with Hermes's scan: `block` cannot be turned on from here, `ask` is turned on only after the findings are on screen
 *  and the person says "anyway". It exists only after a creation, which needs a login: a session that ended since is refused by the server in its own words. */
function CreatedCard({ bot, created, onClose }: { bot: string; created: SkillCreated; onClose: () => void }) {
  const { t } = useLuveI18n();
  const [busy, setBusy] = React.useState(false);
  const [on, setOn] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const scan = created.scan;
  const policy = scan?.policy ?? null;
  const cats = scanCats(scan?.categories ?? [], t);
  async function turnOn() {
    if (busy || policy === "block") return;
    setBusy(true);
    setError(null);
    try { await setBotSkill(bot, created.skill.name, true); setOn(true); }
    catch (e) { setError(skillError(e, t, "skillWhyOther")); }
    finally { setBusy(false); }
  }
  return (
    <div data-testid="skill-created" role="group" aria-label={t("skillCreatedTitle")} style={{ display: "grid", gap: 8 }}>
      <p className="lb-body" style={{ margin: 0, fontWeight: 600 }}>{t("skillCreatedTitle")}</p>
      <p className="lb-body" style={{ margin: 0, overflowWrap: "anywhere" }}>{t("skillCreatedBody", { name: visibleTokens(created.skill.name) })}</p>
      <p data-testid="skill-scan" className="lb-caption" style={{ margin: 0 }}>
        {policy === "allow" ? t("skillScanAllow") : policy === "ask" ? t("skillScanAsk", { what: findingsText(scan?.findings ?? 0, t), cats: cats || "-" }) : policy === "block" ? t("skillScanBlock") : t("skillScanNone")}
      </p>
      {on && <p role="status" className="lb-caption" style={{ margin: 0 }}>{t("skillTurnedOn")}</p>}
      {error && <p role="alert" className="lb-alert" style={{ margin: 0 }}><ErrorNote error={error} /></p>}
      <div className="lb-dialog-footer">
        <button type="button" onClick={onClose} className="lb-btn">{t("close")}</button>
        {!on && <button type="button" onClick={() => void turnOn()} disabled={busy || policy === "block"} className="lb-btn lb-btn-primary">
          {busy ? t("skillTurningOn") : t(policy === "ask" ? "skillTurnOnAnyway" : "skillTurnOn")}</button>}
      </div>
    </div>
  );
}
