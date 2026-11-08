// Visual check of the evidence card (E-2) in a real Chrome: the REAL EvidenceCard inside the REAL bot Bubble, fed by the REAL parser (E-1).
import * as React from "react";
import { createRoot } from "react-dom/client";
import { EvidenceCard } from "@repo/dashboard/src/components/evidence/EvidenceCard";
import { Bubble } from "@repo/dashboard/src/components/ui/Bubble";
import { Markdown } from "@repo/dashboard/src/lib/render/markdown";
import { splitEvidence } from "@repo/dashboard/src/lib/evidence";
import { setLuveLocale } from "@repo/dashboard/src/i18n";

const q = new URLSearchParams(location.search);
setLuveLocale(q.get("lang") === "en" ? "en" : "pt");
const scheme = q.get("scheme") === "dark" ? "dark" : "light";
const MSG = (awaiting: string[]) => [
  "Terminei o resumo de setembro. Segue o que conferi:", "", "```luve-evidence", "facts:",
  "- Vendas fechou 12 propostas em setembro | source: crm/setembro.csv",
  "- A taxa de conversão foi de 18%, acima dos 15% de agosto, segundo o painel de vendas que o time usa toda segunda-feira | source: https://exemplo.com/relatorios/vendas/setembro/2026?utm_source=email&utm_medium=resumo&utm_campaign=semanal",
  "assumptions:", "- O CSV está completo", "done:", "- Gerei o resumo em pages/vendas.md", "awaiting:", ...awaiting, "```",
].join("\n");
const render = (text: string, pending: number | null, onOpen?: () => void) => {
  const seg = splitEvidence(text);
  return <Bubble side="bot" author="Vendas" color="#3b82f6">{seg.map((s, i) => s.kind === "text" ? <Markdown key={i} text={s.text} /> : <EvidenceCard key={i} evidence={s.evidence} pending={pending} onOpenApprovals={onOpen} />)}</Bubble>;
};
(window as any).H = { opened: 0 };
createRoot(document.getElementById("root")!).render(
  <div className="lb-root" data-lb-scheme={scheme} style={{ padding: 16, minHeight: "100vh", background: "var(--color-background)", color: "var(--color-foreground)", display: "flex", flexDirection: "column", gap: 16 }}>
    <div style={{ maxWidth: 720 }}>{render(MSG(["- Enviar o resumo ao cliente X"]), 1, () => { (window as any).H.opened++; })}</div>
    <div style={{ maxWidth: 720 }}>{render(MSG(["- Enviar o resumo ao cliente X"]), 0, () => {})}</div>
    <div style={{ maxWidth: 720 }}>{render(MSG(["- none"]), 3, () => {})}</div>
    <div style={{ maxWidth: 720 }}>{render(MSG(["- Enviar o resumo ao cliente X"]), null)}</div>
  </div>,
);
