// The Bot's question (clarify) inside the REAL Conversation, in a real Chrome: an open turn (run r1) whose GET lists one clarify control; a POST to /clarify takes `latency` ms and then the
// control is no longer pending (what the backend does once the request is resolved), so the card goes through the same lifecycle as in the app. The API is mocked to the contract.
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Conversation } from "@repo/dashboard/src/components/conversation";
import { initialTranscript } from "@repo/dashboard/src/lib/stream";
import { setCustomFetchJSON, setCachedCsrf, ApiError } from "@repo/dashboard/src/api/client";
import { setLuveLocale } from "@repo/dashboard/src/i18n";

const q = new URLSearchParams(location.search);
setLuveLocale(q.get("lang") === "en" ? "en" : "pt");
setCachedCsrf("csrf");
const kind = q.get("kind") ?? "text";                       // text | one | many
const latency = Number(q.get("latency") ?? 80);
const mode = q.get("auth") === "loopback" ? "loopback" : "gated";
const long = q.get("long") === "1";
const QUESTION = long
  ? "Qual endereço devo usar para o envio? https://exemplo.com.br/clientes/acme/pedidos/2026/10/30/0123456789abcdef0123456789abcdef0123456789abcdef — e se for outro, me diga qual e por quê."
  : "Qual cliente devo usar na proposta?";
const control = {
  kind: "clarify", request_id: "q1", question: QUESTION, timeout_s: 120,
  choices: kind === "text" ? [] : ["Acme Ltda", "Beta Comércio", "Gama Serviços"], multi_select: kind === "many",
};
const state = { pending: [control] as any[], failNext: q.get("fail") ?? "" };
const H = { calls: [] as string[], posts: [] as any[], focus: [] as string[], state };
(window as any).H = H;

const describe = (el: Element | null) => {
  if (!el) return "null";
  const e = el as HTMLElement;
  const label = e.getAttribute("aria-label") || (e.tagName === "TEXTAREA" || e.tagName === "BUTTON" ? (e.textContent || "").trim() : "") || (e.getAttribute("role") ?? "");
  return `${e.tagName.toLowerCase()}${e.getAttribute("role") ? `[role=${e.getAttribute("role")}]` : ""}${label ? `("${label.slice(0, 40)}")` : ""}`;
};
document.addEventListener("focusin", (e) => H.focus.push("in " + describe(e.target as Element)));
document.addEventListener("focusout", (e) => H.focus.push("out " + describe(e.target as Element) + " -> " + describe((e as FocusEvent).relatedTarget as Element | null)));

setCustomFetchJSON(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  H.calls.push(`${method} ${url}`);
  if (url.endsWith("/session")) return { csrf: "csrf", actor: "x", auth_mode: mode };
  if (method === "GET" && url.includes("/runs/r1")) return { run: { id: "r1", status: "started", execution_generation: 7, pending_controls: state.pending } };
  if (method === "POST" && url.includes("/runs/r1/clarify")) {
    const body = JSON.parse(String(init?.body));
    H.posts.push(body);
    await new Promise((r) => setTimeout(r, latency));
    if (state.failNext) { const code = state.failNext; state.failNext = ""; throw new ApiError({ code, message: "x", status: 409 }); }
    state.pending = [];
    return { clarify: { request_id: body.request_id, status: "resolved" }, run: { id: "r1", status: "started" } };
  }
  return {};
});

const bot = { name: "vendas", label: "Vendas", is_default: false, description: "", model: { provider: "x", name: "y" }, status: "running", color: "#3b82f6", display: { label: "Vendas", role: "", color: "#3b82f6", avatar: { kind: "mascot", value: "luvi" } } } as never;
const turns = [{ id: 1, user: "Monte a proposta do cliente e me mande o resumo.", state: { ...initialTranscript(), status: "running", runId: "r1" }, runId: "r1", stopping: false, errors: [] }] as never;
const scheme = q.get("scheme") === "dark" ? "dark" : "light";
createRoot(document.getElementById("root")!).render(
  <div className="lb-root" data-lb-scheme={scheme} style={{ height: "100vh", background: "var(--color-background)", color: "var(--color-foreground)", display: "flex" }}>
    <Conversation bot={bot} initialTurns={turns} pendingApprovals={[]} onOpenApprovals={() => {}} pollMs={50} />
  </div>,
);
