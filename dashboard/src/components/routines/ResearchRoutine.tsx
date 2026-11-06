// dashboard/src/components/routines/ResearchRoutine.tsx
// Proactive research (contract v0.8 §3): a routine that only READS the web and hands in a summary. The form asks the topic, the
// sources and the shape of the summary; the backend forces what makes it read-only (toolsets web + no_mcp, delivered locally, the
// fixed last line), so this screen sends none of that. The seal "Só leitura" is drawn from `readonly_seal`, which the backend
// computes from the LIVE job (invariant 8): nothing here infers it from the template.

import React from "react";
import type { Bot, Routine } from "../../api/types";
import { createRoutine } from "../../api/client";
import { useLuveI18n } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";
import { CheckCircleIcon, ShieldAlertIcon, XIcon } from "../Icons";

export const TOPIC_MAX = 500, SOURCES_MAX = 2000, DELIVER_MAX = 1000, NAME_MAX = 60;

/** The routine's instruction. The backend adds the fixed last line ("Só pesquise e resuma; não execute ações."). */
export function researchPrompt(f: { topic: string; sources: string; deliver: string }): string {
  return [
    `Pesquise sobre: ${f.topic.trim()}`,
    f.sources.trim() && `Fontes: ${f.sources.trim()}`,
    f.deliver.trim() && `O que entregar: ${f.deliver.trim()}`,
  ].filter(Boolean).join("\n");
}

/** The seal in words, from the backend's `readonly_seal`: `real` is calm, `broken` says the routine can now do more than read. */
export function ReadonlySeal({ routine }: { routine: Pick<Routine, "id" | "readonly_seal"> }) {
  const { t } = useLuveI18n();
  if (routine.readonly_seal === "real") {
    return (
      <span data-testid={`seal-${routine.id}`} data-seal="real" title={t("rsSealRealHint")}
        className="lb:inline-flex lb:items-center lb:gap-1 lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)]">
        <CheckCircleIcon size={12} /> {t("rsSealReal")}
      </span>
    );
  }
  if (routine.readonly_seal === "broken") {
    return (
      <span data-testid={`seal-${routine.id}`} data-seal="broken" title={t("rsSealBrokenHint")}
        className="lb:inline-flex lb:items-center lb:gap-1 lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-destructive)]/15 lb:text-[var(--color-destructive)]">
        <ShieldAlertIcon size={12} /> {t("rsSealBroken")}
      </span>
    );
  }
  return null;
}

/** The sentence under a routine whose seal broke: visible, not only a tooltip. */
export function SealBrokenNote({ routine }: { routine: Pick<Routine, "id" | "readonly_seal"> }) {
  const { t } = useLuveI18n();
  if (routine.readonly_seal !== "broken") return null;
  return <p data-testid={`seal-note-${routine.id}`} className="lb-caption" style={{ margin: 0, color: "var(--color-destructive)" }}>{t("rsSealBrokenNote")}</p>;
}

export function ResearchRoutineModal({ bots, defaultBot, onClose, onCreated }: { bots: Bot[]; defaultBot?: string; onClose: () => void; onCreated: () => void }) {
  const { t } = useLuveI18n();
  const ref = useFocusTrap<HTMLDivElement>({ isOpen: true, onClose });
  const [bot, setBot] = React.useState(defaultBot || bots[0]?.name || "");
  const [topic, setTopic] = React.useState("");
  const [sources, setSources] = React.useState("");
  const [deliver, setDeliver] = React.useState("");
  const [schedule, setSchedule] = React.useState("0 8 * * 1-5");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const ready = !!bot && !!topic.trim() && !!schedule.trim() && !busy;

  const save = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      // Nothing about tools or delivery goes out: the backend forces them (v0.8 §3). Created paused: the person turns it on.
      await createRoutine({ bot, name: t("researchNamePrefix", { topic: topic.trim().slice(0, NAME_MAX) }), schedule: schedule.trim(), prompt: researchPrompt({ topic, sources, deliver }), template: "research" });
      onCreated();
    } catch (e) {
      setError(humanError(e, t, "errorSavingRoutine"));
      setBusy(false);
    }
  };

  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="modal-research-title" className="lb-dialog-overlay">
      <div data-testid="modal-research" className="lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto">
        <div className="lb:flex lb:items-center lb:justify-between">
          <h3 id="modal-research-title" className="lb-title">{t("researchTitle")}</h3>
          <button type="button" aria-label={t("close")} onClick={onClose} className="lb-icon-btn" style={{ background: "var(--lb-fill)" }}><XIcon size={16} /></button>
        </div>
        <p className="lb-caption" data-testid="research-readonly" style={{ margin: 0 }}>{t("researchReadsOnly")}</p>

        <div className="lb:space-y-1">
          <label htmlFor="research-bot" className="lb:text-[13px] lb:font-medium">{t("routineBotInput")}</label>
          <select id="research-bot" data-testid="input-research-bot" value={bot} onChange={(e) => setBot(e.target.value)} className="lb-input">
            {bots.map((b) => <option key={b.name} value={b.name}>{b.display?.label || b.name}</option>)}
          </select>
        </div>
        <div className="lb:space-y-1">
          <label htmlFor="research-topic" className="lb:text-[13px] lb:font-medium">{t("researchTopic")}</label>
          <textarea id="research-topic" rows={2} maxLength={TOPIC_MAX} data-testid="input-research-topic" placeholder={t("researchTopicPlaceholder")} value={topic} onChange={(e) => setTopic(e.target.value)} className="lb-input" />
        </div>
        <div className="lb:space-y-1">
          <label htmlFor="research-sources" className="lb:text-[13px] lb:font-medium">{t("researchSources")}</label>
          <textarea id="research-sources" rows={2} maxLength={SOURCES_MAX} data-testid="input-research-sources" placeholder={t("researchSourcesPlaceholder")} value={sources} onChange={(e) => setSources(e.target.value)} className="lb-input" />
        </div>
        <div className="lb:space-y-1">
          <label htmlFor="research-deliver" className="lb:text-[13px] lb:font-medium">{t("researchDeliver")}</label>
          <textarea id="research-deliver" rows={2} maxLength={DELIVER_MAX} data-testid="input-research-deliver" placeholder={t("researchDeliverPlaceholder")} value={deliver} onChange={(e) => setDeliver(e.target.value)} className="lb-input" />
        </div>
        <div className="lb:space-y-1">
          <label htmlFor="research-schedule" className="lb:text-[13px] lb:font-medium">{t("routineScheduleExprInput")}</label>
          <input id="research-schedule" type="text" data-testid="input-research-schedule" placeholder={t("routineScheduleExprPlaceholder")} value={schedule} onChange={(e) => setSchedule(e.target.value)} className="lb-input lb-mono" />
        </div>
        <p className="lb-caption" style={{ margin: 0 }}>{t("researchFixedLine")}</p>
        <p className="lb-caption" style={{ margin: 0 }}>{t("researchResultIn")}</p>

        {error && <p role="alert" className="lb-caption" style={{ margin: 0, color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}

        <div className="lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]">
          <button type="button" onClick={onClose} className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:rounded-full">{t("cancelBtn")}</button>
          <button type="button" data-testid="btn-save-research" disabled={!ready} onClick={save}
            className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 disabled:lb:opacity-50 lb:rounded-full">
            {busy ? t("loadingBots") : t("researchCreate")}
          </button>
        </div>
      </div>
    </div>
  );
}
