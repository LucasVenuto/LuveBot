// dashboard/src/components/conversation/StepsLine.tsx
// A turn's tool steps as ONE compact line in the chat (Dots/Cue): how many, which tools, the state, and "Ver na Atividade".
// The full detail lives in the work panel; the line can still open in place for whoever wants it.

import React from "react";
import type { Item } from "../../lib/stream";
import { ToolCard } from "../transcript";
import { useLuveI18n } from "../../i18n";

type Tool = Extract<Item, { kind: "tool" }>;
const ICON = { running: "⟳", done: "✓", error: "✕" } as const;

export function stepsSummary(tools: readonly Tool[]): { count: number; names: string; state: "running" | "done" | "error" } {
  const unique = Array.from(new Set(tools.map((x) => x.name)));
  const names = unique.slice(0, 2).join(", ") + (unique.length > 2 ? "…" : "");
  const state = tools.some((x) => x.status === "running") ? "running" : tools.some((x) => x.status === "error") ? "error" : "done";
  return { count: tools.length, names, state };
}

export function StepsLine({ tools, onOpenActivity }: { tools: readonly Tool[]; onOpenActivity: () => void }) {
  const { t } = useLuveI18n();
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const s = stepsSummary(tools);
  const count = t(s.count === 1 ? "stepsOne" : "stepsMany", { count: s.count });
  const state = t(s.state === "running" ? "stepsRunning" : s.state === "error" ? "stepsError" : "stepsDone");
  return (
    <div className="lb-steps" data-state={s.state}>
      <div className="lb-steps-line">
        <button type="button" className="lb-steps-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden="true">{ICON[s.state]}</span> <strong>{count}</strong> · {s.names} <span className="lb-caption">· {state}</span>
        </button>
        <button type="button" className="lb-btn lb-btn-plain" onClick={onOpenActivity}>{t("stepsSeeInActivity")}</button>
      </div>
      {open && (
        <div id={id} className="lb-steps-detail">
          {tools.map((x) => <ToolCard key={x.id} name={x.name} status={x.status} preview={x.preview} args={x.args} durationS={x.durationS} result={x.result} />)}
        </div>
      )}
    </div>
  );
}
