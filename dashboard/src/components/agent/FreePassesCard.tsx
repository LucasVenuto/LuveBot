// dashboard/src/components/agent/FreePassesCard.tsx
// "Executado sem pedir" in the Bot's profile (contract v0.9 §5, red team T1): what the Livre let through, newest first, as the hook saw it
// (commands already redacted; nothing here can be run, approved or undone). A row no recorded turn-on of the Livre explains (`audited: false`)
// is marked, and says so above the list: the owner finds out the Livre ran without a record that someone turned it on (threat T64).
import React from "react";
import { getFreePasses } from "../../api/client";
import type { FreePass } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { visibleTokens } from "../../lib/hiddenChars";
import { useRuleLabels } from "../approvals/humanize";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

const PAGE = 20;

/** A command the 96 px box may hide the end of. */
export const longCommand = (command: string) => command.length > 120 || command.split("\n").length > 4;

export function FreePassesCard({ bot }: { bot: string }) {
  const { t, locale } = useLuveI18n();
  const ruleLabel = useRuleLabels();
  const [rows, setRows] = React.useState<FreePass[] | null>(null);
  const [next, setNext] = React.useState<number | null>(null);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [wide, setWide] = React.useState<ReadonlySet<number>>(new Set());   // rows whose whole command is shown (an audit list must not hide the end of a command)
  const alive = React.useRef(true);
  const load = React.useCallback(async (before?: number) => {
    setBusy(true); setError(null);
    try {
      const page = await getFreePasses(bot, { limit: PAGE, ...(before ? { before } : {}) });
      if (!alive.current) return;
      setRows((old) => (before && old ? [...old, ...(page.free_passes ?? [])] : page.free_passes ?? []));
      setNext(page.next_before ?? null);
    } catch (e) {
      if (alive.current) setError(humanError(e, t, "freePassesError"));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [bot]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { alive.current = true; setRows(null); void load(); return () => { alive.current = false; }; }, [load]);

  const when = (epoch: number) => new Date(epoch * 1000).toLocaleString(locale === "pt" ? "pt-BR" : "en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const unaudited = (rows ?? []).some((r) => !r.audited);
  return (
    <section aria-labelledby={`free-passes-title-${bot}`} data-testid="free-passes">
      <h3 id={`free-passes-title-${bot}`} className="lb-headline" style={{ margin: "24px 4px 4px" }}>{t("freePassesTitle")}</h3>
      <p className="lb-subhead" style={{ margin: "0 4px 8px" }}>{t("freePassesIntro")}</p>
      {unaudited && <p role="alert" data-testid="free-passes-unaudited" className="lb-caption" style={{ margin: "0 4px 8px", color: "var(--color-warning)" }}>{t("freePassesUnaudited")}</p>}
      {rows === null && !error && <p className="lb-subhead" style={{ margin: "0 4px" }}>{t("agentLoading")}</p>}
      {error && <p role="alert" className="lb-caption" style={{ margin: "0 4px 8px", color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
      {rows !== null && rows.length === 0 && !error && <p data-testid="free-passes-empty" className="lb-subhead" style={{ margin: "0 4px" }}>{t("freePassesEmpty")}</p>}
      {rows !== null && rows.length > 0 && (
        <ul className="lb-group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((r, i) => (
            <li key={`${r.at}-${i}`} data-testid="free-pass" className="lb-row lb-row-flat" style={{ alignItems: "flex-start", gap: 8 }}>
              <span className="lb-row-stack" style={{ minWidth: 0 }}>
                <span className="lb-body" style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{visibleTokens(r.tool)}</span>
                {r.command && (
                  <>
                    <code data-testid="free-pass-command" className="lb-caption" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", ...(wide.has(i) ? {} : { maxHeight: 96, overflow: "hidden" }) }}>{visibleTokens(r.command)}</code>
                    {longCommand(r.command) && (
                      <button type="button" data-testid="free-pass-more" className="lb-caption" aria-expanded={wide.has(i)}
                        style={{ alignSelf: "flex-start", background: "none", border: "none", padding: 0, color: "var(--color-primary)", cursor: "pointer" }}
                        onClick={() => setWide((w) => { const n = new Set(w); if (n.has(i)) n.delete(i); else n.add(i); return n; })}>
                        {wide.has(i) ? t("freePassLess") : t("freePassFull")}
                      </button>
                    )}
                  </>
                )}
                <span className="lb-caption">
                  {when(r.at)}{r.rule_id ? ` · ${t("freePassRule", { rule: ruleLabel(r.rule_id) ?? r.rule_id })}` : ""}
                </span>
              </span>
              {!r.audited && <span data-testid="free-pass-unaudited" className="lb-caption" style={{ flexShrink: 0, color: "var(--color-warning)", fontWeight: 600 }}>{t("freePassUnaudited")}</span>}
            </li>
          ))}
        </ul>
      )}
      {next !== null && <button type="button" className="lb-btn" style={{ marginTop: 8 }} disabled={busy} onClick={() => void load(next)}>{t("freePassesMore")}</button>}
    </section>
  );
}
