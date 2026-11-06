// Visual check of the routine-suggestion cards (P2-4) in a real Chrome: the REAL component, the API mocked to the contract.
import * as React from "react";
import { createRoot } from "react-dom/client";
import { RoutineSuggestions } from "@repo/dashboard/src/components/routines/RoutineSuggestions";
import { setCustomFetchJSON, setCachedCsrf, ApiError } from "@repo/dashboard/src/api/client";
import { setLuveLocale } from "@repo/dashboard/src/i18n";

const q = new URLSearchParams(location.search);
setLuveLocale(q.get("lang") === "en" ? "en" : "pt");
setCachedCsrf("csrf");
const ID = (n: number) => String(n).padStart(12, "0");
const bots = [
  { name: "vendas", is_default: false, description: "", model: { provider: "x", name: "y" }, status: "idle", display: { label: "Vendas", role: "", color: "#3b82f6", avatar: { kind: "mascot", value: "luvi" } } },
  { name: "suporte", is_default: false, description: "", model: { provider: "x", name: "y" }, status: "idle", display: { label: "Suporte", role: "", color: "#16a34a", avatar: { kind: "luve", value: "nimbo.fosco.lupa.38bdf8" } } },
] as never[];
const items = [
  { bot: "vendas", id: ID(1), title: "Resumo da manhã", description: "Todo dia útil, junta o que aconteceu nas conversas de ontem e deixa um resumo para você.", source: "catalog", supported: true,
    spec: { schedule: "0 8 * * 1-5", prompt: "Leia as conversas de ontem e resuma em 5 linhas, com o que ficou pendente.", skills: ["resumo", "agenda"] } },
  { bot: "suporte", id: ID(2), title: "Revisar tickets parados há mais de 3 dias com um título bem comprido para ver a quebra de linha no celular", description: "Pelo seu uso: você pediu isso 4 vezes.", source: "usage", supported: true,
    spec: { schedule: "every 6h", prompt: "x" }, truncated: { prompt: true } },
  { bot: "vendas", id: ID(3), title: "Avisar o time no Telegram", description: "Manda o resultado para um canal.", source: "integration", supported: false, why_not: "delivery_outside", spec: { schedule: "0 18 * * *" } },
  { bot: "suporte", id: ID(4), title: "Limpar a pasta de downloads", description: "Roda um script.", source: "blueprint", supported: false, why_not: "unsupported_fields", fields: ["script", "workdir"], spec: { schedule: "0 7 * * 0" } },
];
const mode = q.get("auth") === "loopback" ? "loopback" : "gated";
(window as any).H = { calls: [] as string[] };
setCustomFetchJSON(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  (window as any).H.calls.push(`${method} ${url}`);
  if (url.endsWith("/session")) return { csrf: "csrf", actor: "x", auth_mode: mode };
  if (url.endsWith("/routine-suggestions")) return { items, partial: q.get("partial") ? ["suporte"] : [] };
  if (url.endsWith("/accept")) return { routine: { id: "j" }, suggestion_id: "x", started: false, replayed: false };
  if (url.endsWith("/dismiss")) return { dismissed: true };
  return {};
});
const scheme = q.get("scheme") === "dark" ? "dark" : "light";
createRoot(document.getElementById("root")!).render(
  <div className="lb-root" data-lb-scheme={scheme} style={{ padding: 16, minHeight: "100vh", background: "var(--color-background)", color: "var(--color-foreground)" }}><div style={{ maxWidth: 760, margin: "0 auto" }}>
    <RoutineSuggestions bots={bots} />
  </div></div>,
);
