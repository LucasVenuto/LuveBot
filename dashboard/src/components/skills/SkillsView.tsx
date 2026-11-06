// dashboard/src/components/skills/SkillsView.tsx
// Skills per Bot (contract v0.6 Part A). One Bot: every skill Hermes has for its profile, its state in words ("Ligada, exceto no
// Telegram"), a switch that calls Hermes's own toggle (global state only: per channel only through `hermes skills`), essential
// skills locked, and the SKILL.md as plain text. All Bots: the Bot x Skill matrix. Only what the backend says; nothing guessed.
import React from "react";
import { ApiError, getBotSkills, getSkillsMatrix, setBotSkill, getSkillContent } from "../../api/client";
import type { Bot, BotSkill, BotSkillsResponse, SkillsMatrix, SkillContent } from "../../api/types";
import { SkillEditor } from "./SkillEditor";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

type T = (k: TranslationKey, p?: Record<string, string | number>) => string;

/** A platform as people say it: LuveBot's own surface is "LuveBot"; a gateway platform by its name. */
export function platformName(p: string, t: T): string {
  if (p === "api_server") return t("skillsPlatformLuvebot");
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/** "Ligada", "Desligada", or "Ligada, exceto no Telegram" (the platforms where Hermes keeps it off). */
export function skillStateText(s: BotSkill, t: T): string {
  if (s.state === "on") return t("skillsOn");
  if (s.state === "off") return t("skillsOff");
  const off = Object.entries(s.enabled).filter(([k, v]) => k !== "all" && v === false).map(([k]) => platformName(k, t));
  return s.enabled.all ? t("skillsOnExcept", { platforms: off.join(", ") }) : t("skillsOff");
}

const ERRORS: Record<string, TranslationKey> = {
  skill_essential: "skillsErrEssential", skill_not_found: "skillsErrNotFound", hermes_error: "skillsErrHermes", capability_missing: "skillsErrMissing",
};
const errorOf = (e: unknown, t: T): ErrorState => (e instanceof ApiError && ERRORS[e.code] ? t(ERRORS[e.code]) : humanError(e, t as (k: TranslationKey) => string, "skillsErrGeneric"));
const PROVENANCE: Record<string, TranslationKey> = { hub: "skillsFromHub", bundled: "skillsBundled", agent: "skillsByBot" };

export function SkillsView({ botName, botLabel }: { botName: string; botLabel?: string }) {
  const { t } = useLuveI18n();
  const [data, setData] = React.useState<BotSkillsResponse | null>(null);
  const [loadError, setLoadError] = React.useState<ErrorState | null>(null);
  const [filter, setFilter] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [said, setSaid] = React.useState<{ skill: string; lines: string[]; error?: ErrorState } | null>(null);
  const [reading, setReading] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    setData(null); setLoadError(null);
    getBotSkills(botName).then((d) => { if (alive) setData(d); }, (e) => { if (alive) setLoadError(errorOf(e, t)); });
    return () => { alive = false; };
  }, [botName, t]);

  async function toggle(s: BotSkill) {
    if (busy) return;
    setBusy(s.name); setSaid(null);
    try {
      const r = await setBotSkill(botName, s.name, !s.enabled.all);
      setData((d) => (d ? { ...d, skills: d.skills.map((x) => (x.name === s.name ? r.skill : x)) } : d));   // Hermes's re-read state
      const lines: string[] = [];
      if (r.still_off_on.includes("api_server")) lines.push(t("skillsStillOffLuvebot"));
      const others = r.still_off_on.filter((p) => p !== "api_server");
      if (others.length) lines.push(t("skillsStillOffOn", { platforms: others.map((p) => platformName(p, t)).join(", ") }));
      if (r.notice === "on_applies_to_new_conversations") lines.push(t("skillsNewConversations"));
      if (!r.skill.enabled.all) lines.push(t("skillsOffNow"));
      setSaid({ skill: s.name, lines });
    } catch (e) {
      setSaid({ skill: s.name, lines: [], error: errorOf(e, t) });
    } finally {
      setBusy(null);
    }
  }

  const q = filter.trim().toLowerCase();
  const shown = (data?.skills ?? []).filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  return (
    <section aria-labelledby="skills-title" style={{ maxWidth: 820, margin: "0 auto", padding: "20px 16px 40px" }}>
      <h1 id="skills-title" className="lb-title" style={{ margin: 0 }}>{t("skillsTitleBot", { bot: botLabel ?? botName })}</h1>
      <p className="lb-subhead" style={{ margin: "4px 0 12px" }}>{t("skillsIntro")}</p>
      {loadError && <p role="alert" className="lb-group lb-subhead" style={{ padding: "14px 16px" }}><ErrorNote error={loadError} /></p>}
      {!data && !loadError && <p role="status" className="lb-caption">{t("skillsLoading")}</p>}
      {data && (
        <>
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t("skillsSearch")} placeholder={t("skillsSearch")}
            className="lb-input" style={{ width: "100%", margin: "0 0 10px" }} />
          {shown.length === 0 && <p className="lb-group lb-subhead" style={{ padding: "14px 16px" }}>{t(data.skills.length ? "skillsNoMatch" : "skillsEmpty")}</p>}
          {shown.length > 0 && (
            <ul className="lb-group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {shown.map((s) => {
                const locked = s.essential || s.toggle === false;
                return (
                  <li key={s.name} className="lb-row lb-row-flat" data-testid={`skill-${s.name}`} style={{ flexDirection: "column", alignItems: "stretch", gap: 4, padding: "12px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span className="lb-headline lb-truncate" style={{ flex: 1, minWidth: 0 }}>{s.name}</span>
                      <span className="lb-caption" data-testid="skill-state">{skillStateText(s, t)}</span>
                      <button type="button" role="switch" aria-checked={s.enabled.all} aria-label={t("skillsSwitch", { name: s.name })}
                        disabled={locked || busy !== null} onClick={() => void toggle(s)} className="lb-switch"
                        title={s.essential ? t("skillsEssential") : s.toggle === false ? t("skillsReadOnly") : undefined}
                        style={{ width: 44, height: 26, borderRadius: 13, border: "none", flexShrink: 0, cursor: locked ? "not-allowed" : "pointer", position: "relative",
                          background: s.enabled.all ? "var(--color-success)" : "var(--lb-fill-2)", opacity: locked ? 0.55 : 1 }}>
                        <span aria-hidden="true" style={{ position: "absolute", top: 3, left: s.enabled.all ? 21 : 3, width: 20, height: 20, borderRadius: 10, background: "#fff", transition: "left 120ms" }} />
                      </button>
                    </div>
                    {s.description && <span className="lb-subhead lb-clamp-2">{s.description}</span>}
                    <span className="lb-caption">
                      {[PROVENANCE[s.provenance] ? t(PROVENANCE[s.provenance]) : null, typeof s.usage === "number" ? t(s.usage === 1 ? "skillsUsageOne" : "skillsUsage", { n: s.usage }) : null,
                        s.essential ? t("skillsEssential") : null].filter(Boolean).join(" · ")}
                    </span>
                    <span style={{ display: "flex", gap: 8 }}>
                      <button type="button" className="lb-btn lb-btn-plain" onClick={() => setReading(reading === s.name ? null : s.name)} aria-expanded={reading === s.name}>
                        {t(reading === s.name ? "skillsHide" : "skillsRead")}
                      </button>
                    </span>
                    {reading === s.name && <SkillText bot={botName} skill={s.name} on={s.enabled.all} onChanged={() => void getBotSkills(botName).then(setData, () => undefined)} />}
                    {said?.skill === s.name && (
                      <div role={said.error ? "alert" : "status"} className="lb-caption" style={said.error ? { color: "var(--color-destructive)" } : undefined}>
                        {said.error ? <ErrorNote error={said.error} /> : said.lines.map((line) => <p key={line} style={{ margin: "2px 0" }}>{line}</p>)}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="lb-caption" style={{ margin: "10px 4px 0" }}>{t("skillsPerChannel")}</p>
          {data.notes.catalog_may_omit && <p className="lb-caption" style={{ margin: "4px 4px 0" }}>{t("skillsCatalogMayOmit")}</p>}
          {data.notes.fail_open && <p className="lb-caption" style={{ margin: "4px 4px 0" }}>{t("skillsFailOpen")}</p>}
        </>
      )}
    </section>
  );
}

/** The SKILL.md as plain text (no Markdown, no link that navigates, no image), with "redacted" and "cut" said. */
function SkillText({ bot, skill, on, onChanged }: { bot: string; skill: string; on: boolean; onChanged: () => void }) {
  const { t } = useLuveI18n();
  const [doc, setDoc] = React.useState<SkillContent | null>(null);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [round, setRound] = React.useState(0);   // read again (after a 409: the skill changed meanwhile)
  React.useEffect(() => {
    let alive = true;
    getSkillContent(bot, skill).then((d) => { if (alive) setDoc(d); }, (e) => { if (alive) setError(errorOf(e, t)); });
    return () => { alive = false; };
  }, [bot, skill, t, round]);
  if (error) return <p role="alert" className="lb-caption" style={{ color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>;
  if (!doc) return <p role="status" className="lb-caption">{t("skillsLoading")}</p>;
  if (editing && doc.editable === true) {   // the editor only exists for what the server says is editable (contract v0.11 3.3): provenance agent, shown whole and unchanged
    return <SkillEditor bot={bot} skill={skill} doc={doc} on={on} onCancel={() => setEditing(false)}
      onSaved={(next) => { setDoc({ ...doc, content: next.content, digest: next.digest }); onChanged(); }}
      onReload={() => { setEditing(false); setDoc(null); setRound((n) => n + 1); }} />;
  }
  return (
    <div>
      {doc.redacted && <p className="lb-caption" style={{ margin: "4px 0" }}>{t("skillsRedacted")}</p>}
      <pre data-testid="skill-text" className="lb-caption" style={{ margin: 0, padding: "8px 10px", borderRadius: 10, background: "var(--color-background)", color: "var(--color-foreground)",
        whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 360, overflowY: "auto", fontFamily: "var(--lb-mono)" }}>{doc.content}</pre>
      {doc.truncated && <p className="lb-caption" style={{ margin: "4px 0" }}>{t("skillsTruncated")}</p>}
      {doc.editable === true && <div style={{ margin: "6px 0 0" }}><button type="button" className="lb-btn" onClick={() => setEditing(true)}>{t("skillEditBtn")}</button></div>}
      {doc.editable === false && <p data-testid="skill-not-editable" className="lb-caption" style={{ margin: "4px 0" }}>
        {t(doc.redacted ? "skillEditRedacted" : doc.truncated ? "skillEditTruncated" : "skillEditNotEditable")}</p>}
    </div>
  );
}

const CELL: Record<string, TranslationKey> = { on: "skillsOn", off: "skillsOff", partial: "skillsPartial", absent: "skillsAbsent" };

/** Every Bot x every skill (GET /skills/matrix), read-only: a Bot that cannot be read says so, never a guess. */
/** What GET /skills/matrix keeps (contract v0.8 A-81). */
export const MATRIX_LIMITS = { bots: 50, skills: 500 } as const;

export function SkillsMatrixView({ bots }: { bots: readonly Bot[] }) {
  const { t } = useLuveI18n();
  const [m, setM] = React.useState<SkillsMatrix | null>(null);
  const [error, setError] = React.useState<ErrorState | null>(null);
  React.useEffect(() => {
    let alive = true;
    getSkillsMatrix().then((d) => { if (alive) setM(d); }, (e) => { if (alive) setError(errorOf(e, t)); });
    return () => { alive = false; };
  }, [t]);
  const label = (name: string) => bots.find((b) => b.name === name)?.display?.label || name;
  if (error) return <p role="alert" className="lb-group lb-subhead" style={{ padding: "14px 16px", margin: "8px 24px" }}><ErrorNote error={error} /></p>;
  if (!m) return <p role="status" className="lb-caption" style={{ margin: "8px 24px" }}>{t("skillsLoading")}</p>;
  const names = m.bots.map((b) => (typeof b === "string" ? b : b.bot));
  const unreadable = new Set(m.bots.filter((b): b is { bot: string; error: string } => typeof b !== "string").map((b) => b.bot));
  const cell = (bot: string, skill: string) => m.cells.find((c) => c.bot === bot && c.skill === skill)?.state ?? "absent";
  // Said, never silent: the server's own flag when it sends one; an older backend sends none, so a list that sits exactly at the limit may have been cut
  const cut = {
    bots: m.truncated ? m.truncated.bots : names.length >= MATRIX_LIMITS.bots,
    skills: m.truncated ? m.truncated.skills : m.skills.length >= MATRIX_LIMITS.skills,
  };
  return (
    <div style={{ padding: "8px 24px 24px" }}>
      <h2 className="lb-headline" style={{ margin: "8px 4px 4px" }}>{t("skillsMatrixTitle")}</h2>
      <p className="lb-subhead" style={{ margin: "0 4px 10px" }}>{t("skillsMatrixIntro")}</p>
      {m.skills.length === 0 ? <p className="lb-group lb-subhead" style={{ padding: "14px 16px" }}>{t("skillsEmpty")}</p> : (
        <div style={{ overflowX: "auto" }} className="lb-group">
          <table aria-label={t("skillsMatrixTitle")} style={{ borderCollapse: "collapse", minWidth: "100%" }}>
            <thead>
              <tr>
                <th scope="col" className="lb-caption" style={{ textAlign: "left", padding: "8px 12px" }}>{t("skillsSkill")}</th>
                {names.map((b) => <th key={b} scope="col" className="lb-caption" style={{ textAlign: "left", padding: "8px 12px", whiteSpace: "nowrap" }}>{label(b)}</th>)}
              </tr>
            </thead>
            <tbody>
              {m.skills.map((s) => (
                <tr key={s.name} style={{ borderTop: "1px solid var(--lb-separator)" }}>
                  <th scope="row" className="lb-body" style={{ textAlign: "left", padding: "8px 12px", fontWeight: 500 }}>{s.name}</th>
                  {names.map((b) => (
                    <td key={b} className="lb-caption" data-testid={`cell-${b}-${s.name}`} style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                      {unreadable.has(b) ? t("skillsUnreadable") : t(CELL[cell(b, s.name)])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(cut.bots || cut.skills) && (
        <p role="status" data-testid="matrix-truncated" className="lb-caption" style={{ margin: "8px 4px 0" }}>
          {[cut.bots ? t("skillsMatrixCutBots", { n: MATRIX_LIMITS.bots }) : null, cut.skills ? t("skillsMatrixCutSkills", { n: MATRIX_LIMITS.skills }) : null].filter(Boolean).join(" ")}
        </p>
      )}
    </div>
  );
}
