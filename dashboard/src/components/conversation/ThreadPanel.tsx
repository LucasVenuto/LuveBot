// dashboard/src/components/conversation/ThreadPanel.tsx
// A thread (contract v0.8 §4, spec 4.7): a NEW conversation of the same Bot about one message. It opens beside the conversation on a desktop and
// as a screen of its own on a phone, never in the Bot's conversation list. Its first message goes to POST /threads, where the server reads the
// quoted message from Hermes (the page never sends the quote). The quote shows at the top as text, never markup; the Bot's answer is the
// ordinary one (Markdown, approvals decided by a click, errors in words). Nothing here is a <form>: the conversation's composer is the only one.
// The landmark is the wrapper's, not this panel's (an <aside> with the name beside the conversation, a dialog with it on a phone): never two nested with one name.

import React from "react";
import { useConversation, statusLabel, isActive, type Fetcher } from "../chat/useConversation";
import { MessageCard, ErrorCard } from "../transcript";
import { InlineApproval } from "../chat/InlineApproval";
import { RunControls } from "../chat/RunControls";
import { OtherChannelCard } from "../chat/OtherChannelCard";
import { Bubble } from "../ui/Bubble";
import { humanCode } from "../ui/ErrorNote";
import { XIcon } from "../Icons";
import { splitReferences } from "./Attachments";
import { stepsSummary } from "./StepsLine";
import { splitQuote, type Quote } from "./thread";
import { useLuveI18n } from "../../i18n";
import { EvidenceProvider, pendingInConversation } from "../transcript/EvidenceContext";
import type { Approval } from "../../api/types";

export interface ThreadTarget {
  key: string;
  /** an existing thread's session (opened from its "N respostas" chip); absent for a thread about to be started */
  open?: string;
  /** the conversation and message the thread answers */
  session: string;
  message: number;
  who: "person" | "bot";
  /** what the clicked message said, for the quote shown before the thread has a first message of its own */
  excerpt: string;
}

const clip = (x: string, n: number) => (x.length > n ? x.slice(0, n).trimEnd() + "…" : x);

export function ThreadPanel({ bot, target, fetcher, pollMs, phone, onClose, pendingApprovals, onOpenApprovals }: {
  bot: { name: string; label?: string; color?: string }; target: ThreadTarget; fetcher?: Fetcher; pollMs?: number; phone: boolean; onClose: () => void;
  pendingApprovals?: readonly Approval[] | null; onOpenApprovals?: () => void;   // the evidence card counts the approvals of THIS thread's runs
}) {
  const { t } = useLuveI18n();
  const name = bot.label ?? bot.name;
  // `thread` also for a reopened one whose parent is known: a "new conversation" after another channel's refusal then starts a thread again, never a main conversation
  const { turns, active, loadingHistory, send, stop, startNew, forkConversation } = useConversation({ bot: bot.name, surface: "chat", fetcher, pollMs, open: target.open,
    thread: target.message > 0 ? { session: target.session, message: target.message } : undefined });
  const [draft, setDraft] = React.useState("");
  const [needsYou, setNeedsYou] = React.useState(false);   // the open run asks the person a question or lost track of itself (v0.9 §1.2): the same cards as the main conversation
  const scroll = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { const el = scroll.current; if (el) el.scrollTop = el.scrollHeight; }, [turns]);
  // a reopened thread's quote is the line the server wrote in its first message; a new one shows what was clicked
  const first = turns.length ? splitQuote(turns[0].user).quote : null;
  const quote: Quote = first ?? { who: target.who, name: target.who === "bot" ? name : null, hour: null, excerpt: target.excerpt };
  const go = () => { const text = draft.trim(); if (!text || active) return; setDraft(""); void send(text, {}); };

  const pendingHere = pendingInConversation(pendingApprovals, bot.name, turns.map((x) => x.runId));
  return (
    <EvidenceProvider pending={pendingHere} onOpenApprovals={onOpenApprovals}>
    <div data-testid="thread-panel" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--lb-separator)" }}>
        {phone && <button type="button" className="lb-btn" onClick={onClose}>‹ {t("backToConversation")}</button>}
        <span className="lb-headline" style={{ flex: 1, minWidth: 0 }}>{t("threadTitle")}</span>
        {!phone && <button type="button" className="lb-icon-btn" aria-label={t("threadClose")} title={t("threadClose")} onClick={onClose}><XIcon size={16} /></button>}
      </div>
      <div ref={scroll} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px" }}>
        {quote.excerpt && (
          <div role="note" data-testid="thread-quote" className="lb-thread-quote">
            <div className="lb-caption">{quote.who === "bot" ? t("threadQuoteBot", { name: quote.name ?? name }) : t("threadQuotePerson")}{quote.hour ? ` · ${quote.hour}` : ""}</div>
            <div className="lb-thread-excerpt">{clip(quote.excerpt, 400)}</div>
          </div>
        )}
        {turns.length === 0 && loadingHistory && <p role="status" className="lb-subhead" style={{ textAlign: "center", margin: "16px 0" }}>{t("conversationLoading")}</p>}
        {turns.length === 0 && !loadingHistory && <p data-testid="thread-empty" className="lb-subhead" style={{ margin: "12px 4px" }}>{t("threadEmpty")}</p>}
        {turns.map((turn, i) => {
          const said = splitReferences(i === 0 ? splitQuote(turn.user).text : turn.user).text;
          const tools = turn.state.items.filter((x) => x.kind === "tool");
          const steps = tools.length ? stepsSummary(tools as Parameters<typeof stepsSummary>[0]) : null;
          return (
            <div key={turn.id} data-testid="thread-turn">
              {said && <Bubble side="me" color={bot.color}>{said}</Bubble>}
              {turn.state.items.map((item) => item.kind === "message" ? <MessageCard key={item.id} text={item.text} color={bot.color} />
                : item.kind === "approval" ? <InlineApproval key={item.id} frame={item.frame} bot={bot.name} runId={turn.runId} pending={!turn.confirmed && turn.state.status === "waiting_approval"} />
                : item.kind === "error" ? <ErrorCard key={item.id} message={humanCode(item.code, t, "streamErrorGeneric")} />
                : null)}
              {steps && <div className="lb-caption" style={{ margin: "2px 4px 6px" }}>{t(steps.count === 1 ? "stepsOne" : "stepsMany", { count: steps.count })}</div>}
              {!turn.confirmed && turn.runId && <RunControls bot={bot.name} runId={turn.runId} active onNeedsYou={setNeedsYou} />}
              {turn.otherChannel && (
                <OtherChannelCard source={turn.otherChannel.source} onNew={() => setDraft(startNew(turn))}
                  onFork={async () => { const again = await forkConversation(turn); if (again !== null) setDraft(again); }} />
              )}
              {turn.errors.map((m, k) => <ErrorCard key={`e${k}`} message={m} />)}
              <div role="status" aria-live="polite" className="lb-caption" style={{ textAlign: "center", margin: "4px 0 12px" }}>{needsYou && !turn.confirmed ? t("statusAskingYou") : statusLabel(turn, t)}</div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, margin: "0 12px 12px", padding: 6, borderRadius: 20, background: "var(--lb-fill)" }}>
        <textarea aria-label={t("threadComposer")} placeholder={t("threadPlaceholder")} value={draft} rows={1} autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } }}
          className="lb-body" style={{ flex: 1, minHeight: 36, maxHeight: 140, padding: "8px 8px", border: "none", outline: "none", resize: "none", background: "transparent", fieldSizing: "content" } as React.CSSProperties} />
        {active && turns.some(isActive) ? (
          <button type="button" className="lb-btn lb-btn-destructive" disabled={!active.runId} onClick={() => void stop(active)}>{t("stopBtn")}</button>
        ) : (
          <button type="button" className="lb-btn lb-btn-primary" disabled={!draft.trim()} onClick={go}>{t("sendBtn")}</button>
        )}
      </div>
    </div>
    </EvidenceProvider>
  );
}
