// dashboard/src/components/conversation/Conversation.tsx
// Conversation with a Bot (spec 4.3/5, brief §2.2/2.3): a messenger thread. Header with the Bot's face and a live
// status line, your messages as bubbles in the Bot's color, the Bot's as neutral bubbles, its work as a list of
// steps, approvals decided inline, and quiet system lines. Turn logic lives in chat/useConversation.ts.
// Agent text only goes through <Markdown> or text, never HTML. "Parar" stays until HERMES confirms an end.

import { MessageMenu } from "./MessageMenu";
import React from "react";
import { Markdown } from "../../lib/render/markdown";
import { MessageCard, CommentaryCard, ErrorCard, SubagentCard } from "../transcript";
import type { Item } from "../../lib/stream";
import type { BotAvatar } from "../../api/types";
import { WorkPanel } from "./WorkPanel";
import { StepsLine } from "./StepsLine";
import { deriveActivity } from "./derive";
import { FileCard, citedFiles, useFileDownloads } from "./FileCard";
import { DELEGATE_TOOL, DELIVERY_MS, DELIVERY_TRIES, delegateView, fillFromDelegate, backgroundIds, deliveriesOf, type Delivery } from "./delegate";
import { getSessionMessages } from "../../api/client";

const PANEL_KEY = "luvebot.workpanel";
import { useConversation, isActive, statusLabel, type Fetcher, type Turn, type PageUpdate } from "../chat/useConversation";
import { PageCard } from "../pages/PageCard";
import { NewPageDialog } from "../pages/NewPageDialog";
import { titleFrom } from "../pages/pages";
import type { Page } from "../../api/types";
import { XIcon, PanelRightIcon, PaperclipIcon } from "../Icons";
import { useAttachments, AttachmentTray, ACCEPT, splitReferences, SentAttachments } from "./Attachments";
import { InlineApproval } from "../chat/InlineApproval";
import { Avatar } from "../ui/Avatar";
import { AttentionBadge } from "../ui/AttentionBadge";
import { Bubble } from "../ui/Bubble";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useNarrow } from "../../hooks/useNarrow";
import { usePhoneBar } from "../messenger/phoneBar";
import { humanCode } from "../ui/ErrorNote";

export { isActive };

export interface ConversationProps {
  bot: { name: string; label?: string; color?: string; avatar?: BotAvatar; role?: string };
  surface?: "run" | "chat";
  fetcher?: Fetcher;   // stream fetcher; default is the SDK authedFetch
  pollMs?: number;     // how often GET run is asked after the stream ends without a terminal frame
  initialTurns?: Turn[];
  onActivityChange?: () => void;
  onCloseSidePanel?: () => void;  // "Ver na Atividade" while the profile or a page sits where the work panel goes  // a run started (it has an id) or a turn ended: the sidebar refreshes the Bot's state
  onOpenProfile?: () => void;
  panel?: React.ReactNode;  // shown beside the conversation instead of the work panel (the Bot's profile, a page)
  /** Pages (contract v0.5): open one beside the conversation, and hear when the Bot wrote one. */
  onOpenPage?: (slug: string) => void;
  /** The Bot's Pages library, reachable from the conversation (the CEO did not find it only under Perfil). */
  onOpenPages?: () => void;
  onPageUpdated?: (u: PageUpdate) => void;
  /** "Perguntar ao Bot sobre esta página": a chip above the composer; the message is never sent on its own. */
  askAbout?: { slug: string; title: string } | null;
  onClearAsk?: () => void;
}

type Tool = Extract<Item, { kind: "tool" }>;
type Block = { kind: "steps"; id: string; tools: Tool[] } | { kind: "item"; item: Item };

/** Consecutive tool calls read as one list of steps, like Grok Bot's "✓ … → …" bubble. `card`: a tool shown on its own instead. */
function blocks(items: readonly Item[], card: (t: Tool) => boolean = () => false): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.kind === "tool" && card(item)) out.push({ kind: "item", item });
    else if (item.kind === "tool" && last?.kind === "steps") last.tools.push(item);
    else out.push(item.kind === "tool" ? { kind: "steps", id: item.id, tools: [item] } : { kind: "item", item });
  }
  return out;
}

/** Files the Bot cited in its answers of this turn (a card each, below them). */
const turnFiles = (turn: Turn) => [...new Set(turn.state.items.flatMap((i) => (i.kind === "message" ? citedFiles(i.text) : [])))];

const quiet: React.CSSProperties = { margin: "4px 0", color: "var(--color-muted-foreground)", fontSize: 12 };

function Thought({ text, t }: { text: string; t: (k: TranslationKey) => string }) {
  return (
    <details style={quiet}>
      <summary style={{ cursor: "pointer" }}>{t("thought")}</summary>
      <Markdown text={text} />
    </details>
  );
}

/** A quiet line in the middle of the thread (Grok Bot: "Created routine …"). */
function SystemLine({ children, live = false }: { children: React.ReactNode; live?: boolean }) {
  return (
    <div {...(live ? { role: "status", "aria-live": "polite" as const } : {})} className="lb-caption" style={{ textAlign: "center", margin: "6px 0 16px" }}>
      {children}
    </div>
  );
}

export function Conversation({ bot, surface = "run", fetcher, pollMs = 2000, initialTurns, onActivityChange, onCloseSidePanel, onOpenProfile, panel: sidePanel, onOpenPage, onOpenPages, onPageUpdated, askAbout, onClearAsk }: ConversationProps) {
  const { t } = useLuveI18n();
  const { turns, active, send: start, stop, markResuming, session } = useConversation({ bot: bot.name, surface, fetcher, pollMs, initialTurns, onPageUpdated });
  // A helper the Bot sent to the background reports back as a delivery row of the session (not on the run's stream, which has
  // ended): while one is pending, the session's history is read again until its row arrives (t165).
  const [deliveries, setDeliveries] = React.useState<Map<string, Delivery>>(() => new Map());
  const [late, setLate] = React.useState<Set<string>>(() => new Set());  // followed for the whole time, no result here
  const pendingHelpers = turns.flatMap((x) => backgroundIds(x.state.items, deliveries)).filter((id) => !late.has(id));
  const waitKey = pendingHelpers.join(",");
  React.useEffect(() => {
    if (!waitKey) return;
    let alive = true, tries = 0;
    const id = window.setInterval(async () => {
      if (++tries > DELIVERY_TRIES) { window.clearInterval(id); if (alive) setLate((prev) => new Set([...prev, ...waitKey.split(",")])); return; }
      const sid = session();
      if (!sid) return;
      try {
        const found = deliveriesOf((await getSessionMessages(bot.name, sid, { limit: 50 })).messages ?? []);
        if (alive && found.size) setDeliveries((prev) => new Map([...prev, ...found]));
      } catch { /* asked again on the next tick */ }
    }, DELIVERY_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [waitKey, bot.name, session]);
  const [draft, setDraft] = React.useState("");
  const [saveAs, setSaveAs] = React.useState<string | null>(null);  // a Bot message to save as a page
  const files = useFileDownloads(bot.name);
  const name = bot.label ?? bot.name;
  const waiting = !!active && !active.stopping && !active.resuming && active.state.status === "waiting_approval";

  const att = useAttachments(bot.name);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  async function send() {
    if ((!draft.trim() && !att.items.length) || active || att.busy) return;
    let input = draft;
    if (att.items.length) {
      // the files go first; the message carries their references (the agent reads them in the workspace)
      const refs = await att.upload();
      if (!refs) return;  // refused: the draft and the chips stay, the reason is said above the composer
      input = [draft.trim(), ...refs].filter(Boolean).join("\n");
      att.clear();
    }
    setDraft("");
    void start(input, askAbout ? { page: { slug: askAbout.slug } } : {});
    onClearAsk?.();
  }

  // The sidebar learns the Bot is working once Hermes has the run, and that it stopped when the turn ends.
  // ...and when the turn stops to wait for a human, so the "!" (and its sound) does not wait for the next 15 s refresh.
  const activity = active ? (active.runId ? active.runId + (waiting ? ":waiting" : "") : null) : "idle";
  const seenActivity = React.useRef(activity);
  React.useEffect(() => {
    if (activity === seenActivity.current) return;
    seenActivity.current = activity;
    if (activity !== null) onActivityChange?.();
  }, [activity]); // eslint-disable-line react-hooks/exhaustive-deps
  const narrow = useNarrow();
  const phone = usePhoneBar();  // on a phone, the shell's back and Hermes controls live in this header (one strip)
  const [drawer, setDrawer] = React.useState(false);
  // The work panel beside the conversation can be hidden (desktop); the choice is kept in this browser.
  const [panelOpen, setPanelOpenState] = React.useState<boolean>(() => { try { return window.localStorage.getItem(PANEL_KEY) !== "closed"; } catch { return true; } });
  const setPanelOpen = (open: boolean) => {
    setPanelOpenState(open);
    try { if (open) window.localStorage.removeItem(PANEL_KEY); else window.localStorage.setItem(PANEL_KEY, "closed"); } catch { /* kept for now only */ }
  };
  const [focus, setFocus] = React.useState<{ turnId: number; n: number } | null>(null);
  const drawerRef = useFocusTrap<HTMLElement>({ isOpen: narrow && drawer, onClose: () => setDrawer(false) });
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const renderItem = (item: Item, turn: Turn) => {
    switch (item.kind) {
      case "message": return (
        turn.confirmed === "completed" ? (
          <MessageMenu key={item.id} items={[{ label: t("pageSaveAsMenu"), hint: t("pageSaveAsHint"), onSelect: () => setSaveAs(item.text) },
            ...citedFiles(item.text).map((p) => ({ label: t("fileDownloadNamed", { file: p.split("/").pop() ?? p }), hint: t("fileDownloadHint"), onSelect: () => void files.download(`${turn.id}|${p}`, p) }))]}>
            <MessageCard text={item.text} color={bot.color} />
          </MessageMenu>
        ) : <MessageCard key={item.id} text={item.text} color={bot.color} />
      );
      case "reasoning": return <Thought key={item.id} text={item.text} t={t} />;
      case "commentary": return <div key={item.id} style={quiet}><CommentaryCard text={item.text} /></div>;
      // a helper the Bot delegated to (subagent.start/complete): its goal, state and summary as Hermes reported them
      case "subagent": {  // Hermes's card; with no subagent.complete, its state comes from the turn's delegate_task (t165)
        const fill = fillFromDelegate(item, turn.state.items, deliveries, late);
        return <SubagentCard key={item.id} goal={item.goal} status={fill?.status ?? item.status} summary={fill?.summary ?? item.summary} costUsd={item.costUsd} />;
      }
      case "tool": {  // only delegate_task reaches here (blocks' card): the helper, from the Bot's own call (t163)
        const d = delegateView(item, deliveries, late);
        return <SubagentCard key={item.id} goal={d.goal} status={d.status} summary={d.summary} />;
      }
      case "approval": return <InlineApproval key={item.id} frame={item.frame} bot={bot.name} runId={turn.runId} pending={!turn.confirmed && turn.state.status === "waiting_approval"} onDecided={() => markResuming(turn.id)} />;
      case "error": return <ErrorCard key={item.id} message={humanCode(item.code, t, "streamErrorGeneric")} />;  // our frame: code + English text
      default: return null;
    }
  };

  const workTurns = turns.map((x) => ({ id: x.id, label: x.user ? t("activityTurnLabel", { text: x.user }) : t("activityTurnIntro"), items: x.state.items }));
  // the files the chat shows as cards are in the Arquivos tab too, with the same download (key turn|path)
  const delivered = turns.filter((x) => x.confirmed === "completed").flatMap((x) => turnFiles(x).map((p) => {
    const key = `${x.id}|${p}`;
    return { key, path: p, state: files.state[key], onDownload: () => void files.download(key, p) };
  }));
  const panel = <WorkPanel items={turns.flatMap((item) => item.state.items)} turns={workTurns} focus={focus} bot={{ name: bot.name, label: name }} delivered={delivered} onOpenPage={onOpenPage} />;
  // A discreet dot on the panel button when something new happened with the panel closed.
  const activityCount = workTurns.reduce((n, x) => n + deriveActivity({ items: x.items }).length, 0);
  const seen = React.useRef(activityCount);
  if (panelOpen && !narrow) seen.current = activityCount;
  const newActivity = !narrow && !panelOpen && activityCount > seen.current;
  const openActivity = (turnId: number) => {
    if (narrow) setDrawer(true);
    else { setPanelOpen(true); if (sidePanel) onCloseSidePanel?.(); }
    setFocus((f) => ({ turnId, n: (f?.n ?? 0) + 1 }));
  };

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <section aria-label={`${t("conversationWith")} ${name}`} style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}
        onDragOver={(e) => { if (!hasFiles(e)) return; e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(e) => { if (!hasFiles(e)) return; e.preventDefault(); setDragging(false); att.add(e.dataTransfer.files); }}>
        <div role="status" aria-live="polite" className="lb:sr-only">
          {active ? `${name}: ${statusLabel(active, t)}` : name}
        </div>

        <header style={{ display: "flex", alignItems: "center", gap: phone ? 8 : 12, padding: phone ? "10px 8px" : "10px 16px", minHeight: 64, borderBottom: "1px solid var(--lb-separator)" }}>
          {phone?.back}
          <Avatar name={name} avatar={bot.avatar} color={bot.color} size={40} attention={waiting ? "needs_you" : active ? "working" : undefined} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="lb-headline lb-truncate">{name}</div>
            {/* the Bot's attention, like a messenger's "typing…"; the exact turn status is the system line below */}
            <div aria-hidden="true" className="lb-caption" style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", whiteSpace: "nowrap" }}>
              {waiting ? <><AttentionBadge state="needs_you" />{t("statusNeedsYouLabel")}</>
                : active ? <><AttentionBadge state="working" />{t("statusTyping")}</>
                : bot.role}
            </div>
          </div>
          {narrow && (
            // short visible label so the Bot's status fits on a phone; the accessible name still starts with it
            <button type="button" aria-expanded={drawer} aria-label={drawer ? t("closePanelBtn") : t("workPanelBtn")} onClick={() => setDrawer(!drawer)} className="lb-btn">
              {drawer ? t("closePanelBtn") : t("workPanelShort")}
            </button>
          )}
          {!narrow && (
            <button type="button" className="lb-icon-btn lb-panel-toggle" aria-expanded={panelOpen} aria-controls="lb-work-panel"
              aria-label={(panelOpen ? t("workPanelHide") : t("workPanelShow")) + (newActivity ? ` (${t("workPanelNew")})` : "")}
              title={panelOpen ? t("workPanelHide") : t("workPanelShow")} onClick={() => setPanelOpen(!panelOpen)}>
              <PanelRightIcon size={18} />
              {newActivity && <span className="lb-panel-dot" aria-hidden="true" />}
            </button>
          )}
          {/* on a phone the header already holds Painel and Perfil: there, Pages stays under Perfil > Páginas */}
          {onOpenPages && !narrow && <button type="button" onClick={onOpenPages} className="lb-btn">{t("pagesTitle")}</button>}
          {onOpenProfile && <button type="button" onClick={onOpenProfile} className="lb-btn">{t("btnProfile")}</button>}
          {phone?.hermes}
        </header>

        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {turns.length === 0 && (
            <div data-testid="conversation-empty-state" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100%", textAlign: "center", gap: 6 }}>
              <Avatar name={name} avatar={bot.avatar} color={bot.color} size={72} />
              <h3 className="lb-title" style={{ marginTop: 10 }}>{t("conversationEmptyTitle", { name })}</h3>
              <p className="lb-subhead" style={{ maxWidth: 380 }}>{t("conversationEmptyDesc")}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 10, maxWidth: 460 }}>
                {(["conversationPromptSuggestion1", "conversationPromptSuggestion2"] as const).map((k) => (
                  <button key={k} type="button" onClick={() => setDraft(t(k))} className="lb-btn">
                    {t(k)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn) => (
            <div key={turn.id} data-turn={turn.id}>
              {turn.user && (() => {
                // the raw reference lines stay in the message for the Bot; the bubble shows them as chips (t142)
                const sent = splitReferences(turn.user);
                return (
                  <Bubble side="me" color={bot.color} meta={turn.aboutPage ? t("pageAboutSent", { slug: turn.aboutPage }) : undefined}>
                    {sent.text}
                    {sent.refs.length > 0 && <SentAttachments refs={sent.refs} spaced={!!sent.text} />}
                  </Bubble>
                );
              })()}
              {(() => {
                // ONE compact line for all of the turn's steps, where the first one was; the detail is in the work panel
                // Hermes's own subagent.* frames win; without them, the Bot's delegate_task call is the helper's card (t163)
                const viaHermes = turn.state.items.some((i) => i.kind === "subagent");
                const card = (x: Tool) => !viaHermes && x.name === DELEGATE_TOOL;
                const all = turn.state.items.filter((i): i is Tool => i.kind === "tool" && !card(i));
                let shown = false;
                return blocks(turn.state.items, card).map((b) => {
                  if (b.kind !== "steps") return renderItem(b.item, turn);
                  if (shown) return null;
                  shown = true;
                  return <StepsLine key={b.id} tools={all} onOpenActivity={() => openActivity(turn.id)} />;
                });
              })()}
              {turn.confirmed === "completed" && turnFiles(turn).map((p) => (
                <FileCard key={`f${p}`} path={p} botLabel={name} state={files.state[`${turn.id}|${p}`]} onDownload={() => void files.download(`${turn.id}|${p}`, p)}
                  bot={bot.name} onOpenPage={onOpenPage} />
              ))}
              {(turn.pages ?? []).map((p) => <PageCard key={p.slug} title={p.title} botLabel={name} onOpen={onOpenPage ? () => onOpenPage(p.slug) : undefined} />)}
              {turn.errors.map((m, i) => <ErrorCard key={`e${i}`} message={m} />)}
              <SystemLine live>{statusLabel(turn, t)}</SystemLine>
            </div>
          ))}
        </div>

        {askAbout && (
          <div style={{ margin: "0 16px 6px" }}>
            <span className="lb-pill" style={{ fontSize: 13, padding: "4px 6px 4px 12px" }}>
              {t("pageAboutChip", { title: askAbout.title })}
              <button type="button" onClick={onClearAsk} aria-label={t("pageAboutRemove")} className="lb-icon-btn" style={{ width: 24, height: 24 }}><XIcon size={14} /></button>
            </span>
          </div>
        )}
        <AttachmentTray a={att} />
        <form onSubmit={(e) => { e.preventDefault(); void send(); }}
          style={{ display: "flex", alignItems: "flex-end", gap: 8, margin: "0 16px 16px", padding: "6px 6px 6px 6px", borderRadius: 24, background: "var(--lb-fill)",
            ...(dragging ? { outline: "2px dashed var(--color-primary)", outlineOffset: 2 } : {}) }}>
          <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden tabIndex={-1}
            onChange={(e) => { att.add(e.currentTarget.files); e.currentTarget.value = ""; }} />
          <button type="button" className="lb-icon-btn" aria-label={t("attachBtn")} title={t("attachBtn")} disabled={att.busy}
            onClick={() => fileInput.current?.click()} style={{ width: 40, height: 40, flexShrink: 0 }}>
            <PaperclipIcon size={18} />
          </button>
          <textarea aria-label={t("messageLabel")} placeholder={dragging ? t("attachDrop") : t("composerPlaceholder", { name })} value={draft} rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              // a pasted image (or file) becomes a chip; a pasted text stays text
              const files = e.clipboardData?.files;
              if (!files?.length) return;
              if (!e.clipboardData.getData("text/plain")) e.preventDefault();
              att.add(files);
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            className="lb-body" style={{ flex: 1, minHeight: 40, maxHeight: 160, padding: "10px 0", border: "none", outline: "none", resize: "none", background: "transparent", fieldSizing: "content" } as React.CSSProperties} />
          {active ? (
            <button type="button" onClick={() => void stop(active)} disabled={!active.runId} className="lb-btn lb-btn-destructive" style={{ minHeight: 40 }}>
              {t("stopBtn")}
            </button>
          ) : (
            <button type="submit" disabled={(!draft.trim() && !att.items.length) || att.busy} className="lb-btn lb-btn-primary" style={{ minHeight: 40 }}>
              {att.busy ? t("attachUploading") : t("sendBtn")}
            </button>
          )}
        </form>
      </section>
      <NewPageDialog open={saveAs !== null} bot={bot.name} botLabel={name} initialTitle={saveAs ? titleFrom(saveAs) : ""} content={saveAs ?? undefined}
        onClose={() => setSaveAs(null)} onCreated={(page: Page) => { setSaveAs(null); onOpenPage?.(page.slug); }} />
      {sidePanel}
      {!sidePanel && !narrow && panelOpen && <aside id="lb-work-panel" style={{ width: 320, flexShrink: 0, borderLeft: "1px solid var(--lb-separator)", minHeight: 0 }}>{panel}</aside>}
      {narrow && drawer && (
        // a phone has no side panel: the work panel is a screen of its own, with its own way out
        <aside ref={drawerRef} role="dialog" aria-modal="true" aria-label={t("workPanelBtn")} style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", flexDirection: "column", background: "var(--color-card)" }}>
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 8px 0" }}>
            <button type="button" className="lb-btn" onClick={() => setDrawer(false)}>‹ {t("backToConversation")}</button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>{panel}</div>
        </aside>
      )}
    </div>
  );
}
