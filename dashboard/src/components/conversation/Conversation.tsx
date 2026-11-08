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
import { ApiError, getSessionMessages, getVoice, reactToMessage, getThreads, runEventsUrl, type RunInfo } from "../../api/client";
import { openStream } from "../../lib/stream";
import { SkillAskDialog } from "../skills/SkillAskDialog";
import { SkillDraftCard, SkillNoAnswer } from "../skills/SkillDraftCard";
import { ReactionStrip, NO_MARKS, NO_THREADS, type Slot } from "./Reactions";
import { ThreadPanel, type ThreadTarget } from "./ThreadPanel";
import { EvidenceProvider, pendingInConversation } from "../transcript/EvidenceContext";
import { useOpenScreen } from "../messenger/phoneBar";
import { rowsOfLive } from "../chat/history";
import { useRadio } from "../../voice/useRadio";
import { RadioButton } from "../../voice/RadioButton";
import { RadioStrip, RadioNotes } from "../../voice/RadioStrip";
import { RadioLanguageLine } from "../../voice/RadioLanguageLine";
import { readVoiceSettings } from "../../voice/language";
import { useCall } from "../../voice/useCall";
import { CallButton } from "../../voice/CallButton";
import { CallScreen, CallPill } from "../../voice/CallScreen";
import { CallReceiptLine, callProblemText } from "../../voice/CallNotes";
import { micPossible } from "../../voice/mic";
import { speak, unlockAudio, stopSpeaking } from "../../voice/speak";
import { humanError, type ErrorState } from "../ui/ErrorNote";

const PANEL_KEY = "luvebot.workpanel";
/** The work panel is a column of this width (below); the conversation must keep at least MIN_COLUMN beside it, or the message field and the bubbles are squeezed to nothing (measured at 900x800: the field collapsed to
 *  width 0). When there is not that much room the panel is the sheet a phone has (the same button opens it), not a column. */
export const WORK_PANEL_WIDTH = 320;
export const MIN_COLUMN = 420;
import { useConversation, isActive, statusLabel, type Fetcher, type Turn, type PageUpdate } from "../chat/useConversation";
import { PageCard } from "../pages/PageCard";
import { NewPageDialog } from "../pages/NewPageDialog";
import { titleFrom } from "../pages/pages";
import type { Approval, Page, VoiceStatus, VoiceSettings, CallReceipt, ApprovalSurfaceMode, MessageReaction, MessageRow, ThreadInfo } from "../../api/types";
import { XIcon, PanelRightIcon, PaperclipIcon } from "../Icons";
import { useAttachments, AttachmentTray, ACCEPT, splitReferences, SentAttachments } from "./Attachments";
import { InlineApproval } from "../chat/InlineApproval";
import { RunControls } from "../chat/RunControls";
import { OtherChannelCard } from "../chat/OtherChannelCard";
import { FreeChip } from "../agent/FreeChip";
import { Avatar } from "../ui/Avatar";
import { AttentionBadge } from "../ui/AttentionBadge";
import { Bubble } from "../ui/Bubble";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useNarrow } from "../../hooks/useNarrow";
import { useWidth } from "../../hooks/useWidth";
import { usePhoneBar } from "../messenger/phoneBar";
import { humanCode, ErrorNote } from "../ui/ErrorNote";

export { isActive };

export interface ConversationProps {
  bot: { name: string; label?: string; color?: string; avatar?: BotAvatar; role?: string; approval_mode?: ApprovalSurfaceMode; approval_unknown?: boolean };
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
  /** Hoje's "Bot esperando você" points at a session that is not this conversation (a thread): open it beside, once, when the history is drawn. */
  focusSession?: string | null;
  onFocusDone?: () => void;
  /** The approvals the shell holds that are pending (what its sidebar counts) and the way to the Approvals box: the evidence card's "in the box now" is counted from them. */
  pendingApprovals?: readonly Approval[] | null;
  onOpenApprovals?: () => void;
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
// Per items array (a finished turn keeps its array across redraws; only the streaming turn gets a new one): what is derived from a turn's items is
// derived once, not again at every token of another turn (perf-tela.md item 1).
const filesCache = new WeakMap<readonly object[], string[]>();
const turnFiles = (turn: Turn): string[] => {
  const key = turn.state.items;
  let hit = filesCache.get(key);
  if (!hit) { hit = [...new Set(key.flatMap((i) => (i.kind === "message" ? citedFiles(i.text) : [])))]; filesCache.set(key, hit); }
  return hit;
};

const quiet: React.CSSProperties = { margin: "4px 0", color: "var(--color-muted-foreground)", fontSize: 12 };

const Thought = React.memo(function Thought({ text }: { text: string }) {
  const { t } = useLuveI18n();
  return (
    <details style={quiet}>
      <summary style={{ cursor: "pointer" }}>{t("thought")}</summary>
      <Markdown text={text} />
    </details>
  );
});

/** A quiet line in the middle of the thread (Grok Bot: "Created routine …"). */
function SystemLine({ children, live = false }: { children: React.ReactNode; live?: boolean }) {
  return (
    <div {...(live ? { role: "status", "aria-live": "polite" as const } : {})} className="lb-caption" style={{ textAlign: "center", margin: "6px 0 16px" }}>
      {children}
    </div>
  );
}

export function Conversation({ pendingApprovals, onOpenApprovals, bot, surface = "run", fetcher, pollMs = 2000, initialTurns, onActivityChange, onCloseSidePanel, onOpenProfile, panel: sidePanel, onOpenPage, onOpenPages, onPageUpdated, askAbout, onClearAsk, focusSession, onFocusDone }: ConversationProps) {
  const { t } = useLuveI18n();
  const openScreen = useOpenScreen();
  const { turns, active, loadingHistory, send: start, stop, markResuming, session, startNew, forkConversation, ensureSession, follow } = useConversation({ bot: bot.name, surface, fetcher, pollMs, initialTurns, onPageUpdated });
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
  const [skillAsk, setSkillAsk] = React.useState(false);              // "Save as a skill": the cost line and the note (contract v0.11 3.2 step 1)
  const files = useFileDownloads(bot.name);
  // The team's marks (contract v0.8 §4). A turn from the history knows its saved rows; a turn drawn live asks the history once, when a mark is made.
  const [marks, setMarks] = React.useState<Record<number, MessageReaction[]>>({});
  const [resolved, setResolved] = React.useState<Map<number, { userRow?: MessageRow; replyRow?: MessageRow }>>(() => new Map());
  const [reactOff, setReactOff] = React.useState(false);
  const rowOf = (turn: Turn, which: Slot) => turn[which] ?? resolved.get(turn.id)?.[which];
  const marksOf = (turn: Turn, which: Slot) => { const row = rowOf(turn, which); return row ? marks[row.id] ?? row.reactions : NO_MARKS; };
  const notSaved = () => new ApiError({ code: "message_not_saved", message: "Message not saved yet.", status: 409 });
  /** The saved row of one of a turn's two messages, and the conversation's session: from the history, or (a turn drawn live) from one more read of it. */
  const rowNow = React.useRef<(id: number, which: Slot) => Promise<{ turn: Turn; row: MessageRow; sid: string }>>(async () => { throw notSaved(); });
  rowNow.current = async (id, which) => {
    const turn = turns.find((x) => x.id === id), sid = session();
    if (!turn || !sid) throw notSaved();
    let row = rowOf(turn, which);
    if (!row) {
      const found = rowsOfLive(turns, (await getSessionMessages(bot.name, sid, { limit: 100 })).messages ?? []);
      setResolved((prev) => new Map([...prev, ...found]));
      row = found.get(turn.id)?.[which];
      if (!row) throw notSaved();
    }
    return { turn, row, sid };
  };
  const react = React.useCallback(async (id: number, which: Slot, emoji: string, clear: boolean) => {
    const { row, sid } = await rowNow.current(id, which);
    const after = await reactToMessage(bot.name, sid, row.id, emoji, clear);
    setMarks((prev) => ({ ...prev, [row.id]: after.reactions }));
  }, [bot.name]);
  // Threads (contract v0.8 §4): "N respostas" under the messages that have one; a thread opens beside the conversation (a screen of its own on a phone)
  const [threads, setThreads] = React.useState<ThreadInfo[]>([]);
  const [thread, setThread] = React.useState<ThreadTarget | null>(null);
  const loadThreads = React.useCallback(() => {
    const sid = session();
    if (sid) getThreads(bot.name, sid).then((r) => { if (alive.current) setThreads(r.threads ?? []); }, () => { /* no counts: the messages are as they were */ });
  }, [bot.name, session]);
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => { if (!loadingHistory) loadThreads(); }, [loadingHistory, loadThreads]);
  const byMessage = React.useMemo(() => { const m = new Map<number, ThreadInfo[]>(); for (const x of threads) m.set(x.message_id, [...(m.get(x.message_id) ?? []), x]); return m; }, [threads]);
  const threadsOf = (turn: Turn, which: Slot) => { const row = rowOf(turn, which); return (row && byMessage.get(row.id)) || NO_THREADS; };
  const excerptOf = (turn: Turn, which: Slot) => which === "userRow" ? splitReferences(turn.user).text
    : turn.state.items.flatMap((i) => (i.kind === "message" ? [i.text] : [])).join("\n\n");
  const startThread = React.useCallback(async (id: number, which: Slot, open?: string) => {
    const { turn, row, sid } = await rowNow.current(id, which);
    setThread({ key: open ?? `${sid}:${row.id}:${Date.now()}`, ...(open ? { open } : {}), session: sid, message: row.id, who: which === "userRow" ? "person" : "bot", excerpt: excerptOf(turn, which) });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onThread = React.useCallback((id: number, which: Slot) => startThread(id, which), [startThread]);
  const onOpenThread = React.useCallback((id: number, which: Slot, child: string) => { void startThread(id, which, child).catch(() => undefined); }, [startThread]);
  const closeThread = () => { setThread(null); loadThreads(); };
  // Hoje sent the person to the session a Bot waits in: the main conversation shows its own cards; any other session is opened as a thread panel
  React.useEffect(() => {
    if (!focusSession || loadingHistory) return;
    if (focusSession !== session()) setThread({ key: focusSession, open: focusSession, session: "", message: 0, who: "bot", excerpt: "" });
    onFocusDone?.();
  }, [focusSession, loadingHistory]); // eslint-disable-line react-hooks/exhaustive-deps
  const reactOffNow = React.useCallback(() => setReactOff(true), []);
  const name = bot.label ?? bot.name;
  const [needsYou, setNeedsYou] = React.useState(false);  // the open run asks the person a question or lost track of itself (v0.9 §1.2)
  const waiting = (!!active && !active.stopping && !active.resuming && active.state.status === "waiting_approval") || needsYou;

  const att = useAttachments(bot.name);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  // Radio (contract v0.7 section 2): the transcription is sent like typed text (A-97); the reply to it is then spoken
  const [voiceReady, setVoiceReady] = React.useState(false);
  const [voice, setVoice] = React.useState<VoiceStatus | null>(null);   // the Call too (contract v0.7 3.1)
  const [voiceSettings, setVoiceSettings] = React.useState<VoiceSettings | null>(null);   // the language and the providers (VL-1); null on a server without them
  const [radioUsed, setRadioUsed] = React.useState(false);   // the line about the language shows after the Radio was pressed once
  React.useEffect(() => {
    let alive = true;
    setRadioUsed(false); setVoiceSettings(null);
    getVoice(bot.name).then((v) => { if (alive) { setVoiceReady(v.radio?.available === true); setVoice(v?.call ? v : null); setVoiceSettings(readVoiceSettings(v)); } }, () => { if (alive) { setVoiceReady(false); setVoice(null); setVoiceSettings(null); } });
    return () => { alive = false; stopSpeaking(); };
  }, [bot.name]);
  const [provider, setProvider] = React.useState<string | null>(null);   // said once per conversation
  const [speakError, setSpeakError] = React.useState<ErrorState | null>(null);
  const [tapMode, setTapMode] = React.useState(false);
  const speakTurn = React.useRef<number | null>(null);
  const radio = useRadio({ bot: bot.name, onText: (text, from) => {
    if (from) setProvider((p) => p ?? from);
    speakTurn.current = turns.length;   // the turn about to start: its reply is spoken
    void start(text, {});
  } });
  React.useEffect(() => { if (radio.phase !== "idle") setRadioUsed(true); }, [radio.phase]);
  const listen = (text: string) => {
    unlockAudio();
    setSpeakError(null);
    speak(bot.name, text).catch((e) => setSpeakError(humanError(e, t, "voiceSpeakError")));
  };
  React.useEffect(() => {
    const at = speakTurn.current;
    if (at === null || active || turns.length <= at) return;
    speakTurn.current = null;
    const turn = turns[at];
    const reply = turn.state.items.filter((i) => i.kind === "message").map((i) => (i as { text: string }).text).join("\n\n").trim();
    if (turn.confirmed === "completed" && reply) listen(reply);
  }, [active, turns]); // eslint-disable-line react-hooks/exhaustive-deps
  // Call (v0.7 section 3): real time with the vendor's voice; each task it hands over is a turn of THIS conversation. The receipt stays in it.
  const [receipts, setReceipts] = React.useState<CallReceipt[]>([]);
  const call = useCall({ bot: bot.name, ensureSession, follow, fetcher, failureSpeech: t("callFailedSpeech"), onReceipt: (r) => setReceipts((x) => [...x, r]) });
  const callWhy = voice?.call?.reason;
  const callReason = !micPossible() ? t("radioNeedsHttps")
    : !voice || callWhy === "hermes_audio_missing" ? t("callUnavailableAudio")
    : callWhy === "no_openai_key" ? t("callUnavailableNoKey") : callWhy === "bot_paused" ? t("callUnavailablePaused") : callWhy === "budget" ? t("callUnavailableBudget")
    : voice.call.available ? undefined : t("callUnavailableAudio");
  const recordingNow = radio.phase !== "idle";
  const radioReason = !micPossible() ? t("radioNeedsHttps") : !voiceReady ? t("radioUnavailableHere") : undefined;

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
  const root = React.useRef<HTMLDivElement | null>(null);
  const width = useWidth(root);
  // not enough room for the conversation AND a 320 px column (no thread or profile column open: they have their own widths): the work panel is a sheet, as on a phone
  const cramped = !narrow && width !== null && width - WORK_PANEL_WIDTH < MIN_COLUMN;
  const sheet = narrow || cramped;
  const phone = usePhoneBar();  // on a phone, the shell's back and Hermes controls live in this header (one strip)
  const [drawer, setDrawer] = React.useState(false);
  // The work panel beside the conversation can be hidden (desktop); the choice is kept in this browser.
  const [panelOpen, setPanelOpenState] = React.useState<boolean>(() => { try { return window.localStorage.getItem(PANEL_KEY) !== "closed"; } catch { return true; } });
  const setPanelOpen = (open: boolean) => {
    setPanelOpenState(open);
    try { if (open) window.localStorage.removeItem(PANEL_KEY); else window.localStorage.setItem(PANEL_KEY, "closed"); } catch { /* kept for now only */ }
  };
  const [focus, setFocus] = React.useState<{ turnId: number; n: number } | null>(null);
  const drawerRef = useFocusTrap<HTMLElement>({ isOpen: sheet && drawer, onClose: () => setDrawer(false) });
  const threadRef = useFocusTrap<HTMLElement>({ isOpen: narrow && !!thread, onClose: closeThread });
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, needsYou]);   // `needsYou`: the Bot's question arrives after the turn it belongs to (its own poll), and a card the scroll did not follow sat under the fold, flush against the composer

  const renderPlain = (item: Item, turn: Turn): React.ReactNode => {
    switch (item.kind) {
      case "message": return (
        turn.confirmed === "completed" ? (
          <MessageMenu key={item.id} items={[{ label: t("pageSaveAsMenu"), hint: t("pageSaveAsHint"), onSelect: () => setSaveAs(item.text) },
            ...(turn.skillDraft ? [] : [{ label: t("skillSaveAsMenu"), hint: t("skillSaveAsHint"), onSelect: () => setSkillAsk(true) }]),
            ...citedFiles(item.text).map((p) => ({ label: t("fileDownloadNamed", { file: p.split("/").pop() ?? p }), hint: t("fileDownloadHint"), onSelect: () => void files.download(`${turn.id}|${p}`, p) })),
            ...(voiceReady ? [{ label: t("voiceListen"), hint: t("voiceListenHint"), onSelect: () => listen(item.text) }] : [])]}>
            <MessageCard text={item.text} color={bot.color} />
          </MessageMenu>
        ) : <MessageCard key={item.id} text={item.text} color={bot.color} />
      );
      case "reasoning": return <Thought key={item.id} text={item.text} />;
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
      case "approval": return <InlineApproval key={item.id} frame={item.frame} bot={bot.name} runId={turn.runId} pending={!turn.confirmed && turn.state.status === "waiting_approval"} onDecided={() => { markResuming(turn.id); onActivityChange?.(); }} />;   // the sidebar's "!" and the Bot's state are read again now
      case "error": return <ErrorCard key={item.id} message={humanCode(item.code, t, "streamErrorGeneric")} />;  // our frame: code + English text
      default: return null;
    }
  };
  // The turn that asks for a skill draft (contract v0.11 3.2 step 2): its FINAL answer is a card ("Draft ready, N lines") or the reason it is not a draft, never the text in a bubble (the draft text would show cut); while
  // it is written, one calm line; a turn that ended any other way draws nothing of it. Every other item, and every other turn, is drawn as always.
  const renderItem = (item: Item, turn: Turn): React.ReactNode => {
    if (turn.skillDraft && item.kind === "message" && turn.state.items.filter((i) => i.kind === "message").pop() === item) {
      if (turn.botMessages !== undefined) {   // read back from the history (no run id): by structure, and no message is ever hidden (A-183)
        return <SkillDraftCard key={item.id} text={item.text} bot={bot.name} onAskAgain={() => setSkillAsk(true)} plain={() => renderPlain(item, turn)} reload={{ messages: turn.botMessages }} />;
      }
      if (!turn.confirmed) return <SystemLine key={item.id} live>{t("skillDraftWriting")}</SystemLine>;
      if (turn.confirmed !== "completed") return null;
      return <SkillDraftCard key={item.id} text={item.text} bot={bot.name} onAskAgain={() => setSkillAsk(true)} plain={() => renderPlain(item, turn)} />;
    }
    return renderPlain(item, turn);
  };

  // the evidence card's "in the box now": the shell's pending approvals raised by a run of THIS conversation (none known = the card says no number)
  const pendingHere = pendingInConversation(pendingApprovals, bot.name, turns.map((x) => x.runId));
  const openApprovals = React.useMemo(() => (onOpenApprovals ? () => { onOpenApprovals(); openScreen?.(); } : undefined), [onOpenApprovals, openScreen]);
  const workTurns = turns.map((x) => ({ id: x.id, label: x.user ? t("activityTurnLabel", { text: x.user }) : t("activityTurnIntro"), items: x.state.items }));
  // the files the chat shows as cards are in the Arquivos tab too, with the same download (key turn|path)
  const delivered = turns.filter((x) => x.confirmed === "completed").flatMap((x) => turnFiles(x).map((p) => {
    const key = `${x.id}|${p}`;
    return { key, path: p, state: files.state[key], onDownload: () => void files.download(key, p) };
  }));
  const panel = <WorkPanel items={turns.flatMap((item) => item.state.items)} turns={workTurns} focus={focus} bot={{ name: bot.name, label: name }} delivered={delivered} onOpenPage={onOpenPage} />;
  // A discreet dot on the panel button when something new happened with the panel closed.
  const activityTotal = workTurns.reduce((n, x) => n + deriveActivity({ items: x.items }).length, 0);
  const seen = React.useRef(activityTotal);
  if (panelOpen && !sheet) seen.current = activityTotal;
  const newActivity = !sheet && !panelOpen && activityTotal > seen.current;
  const openActivity = (turnId: number) => {
    if (sheet) setDrawer(true);
    else { setPanelOpen(true); if (sidePanel) onCloseSidePanel?.(); }
    setFocus((f) => ({ turnId, n: (f?.n ?? 0) + 1 }));
  };

  return (
    <EvidenceProvider pending={pendingHere} onOpenApprovals={openApprovals}>
    <div ref={root} style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <section aria-label={`${t("conversationWith")} ${name}`} style={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}
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
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span className="lb-headline lb-truncate">{name}</span>
              {bot.approval_mode === "free" ? <FreeChip /> : bot.approval_unknown ? <FreeChip unknown /> : null}
            </div>
            {/* the Bot's attention, like a messenger's "typing…"; the exact turn status is the system line below */}
            <div aria-hidden="true" className="lb-caption" style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", whiteSpace: "nowrap" }}>
              {waiting ? <><AttentionBadge state="needs_you" />{t("statusNeedsYouLabel")}</>
                : active ? <><AttentionBadge state="working" />{t("statusTyping")}</>
                : bot.role}
            </div>
          </div>
          {sheet && (
            // short visible label so the Bot's status fits on a phone; the accessible name still starts with it
            <button type="button" aria-expanded={drawer} aria-label={drawer ? t("closePanelBtn") : t("workPanelBtn")} onClick={() => setDrawer(!drawer)} className="lb-btn">
              {drawer ? t("closePanelBtn") : t("workPanelShort")}
            </button>
          )}
          {!sheet && (
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

        {call.phase !== "idle" && call.minimized && <CallPill name={name} seconds={call.seconds} phase={call.phase} onOpen={() => call.setMinimized(false)} onEnd={call.hangUp} />}
        {call.phase !== "idle" && !call.minimized && (
          <CallScreen name={name} avatar={bot.avatar} color={bot.color} phase={call.phase} seconds={call.seconds} muted={call.muted} speaking={call.speaking}
            captions={call.captions} problem={call.problem} onMute={call.toggleMute} onMinimize={() => call.setMinimized(true)} onEnd={call.hangUp} />
        )}

        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {turns.length === 0 && loadingHistory && <p data-testid="conversation-loading" role="status" className="lb-subhead" style={{ textAlign: "center", margin: "24px 0" }}>{t("conversationLoading")}</p>}
          {turns.length === 0 && !loadingHistory && (
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
            <div key={turn.id} data-turn={turn.id} className="lb-turn">
              {turn.skillDraft && <SystemLine>{t("skillDraftAsked")}</SystemLine>}
              {turn.user && (() => {
                // the raw reference lines stay in the message for the Bot; the bubble shows them as chips (t142)
                const sent = splitReferences(turn.user);
                return (
                  <>
                    <Bubble side="me" color={bot.color} meta={turn.aboutPage ? t("pageAboutSent", { slug: turn.aboutPage }) : undefined}>
                      {sent.text}
                      {sent.refs.length > 0 && <SentAttachments refs={sent.refs} spaced={!!sent.text} bot={bot.name} />}
                    </Bubble>
                    {turn.confirmed === "completed" && !turn.checking && <ReactionStrip side="me" marks={marksOf(turn, "userRow")} turn={turn.id} slot="userRow" off={reactOff} onOff={reactOffNow} onReact={react} threads={threadsOf(turn, "userRow")} onThread={onThread} onOpenThread={onOpenThread} />}
                  </>
                );
              })()}
              {turn.steers?.map((text, i) => (
                <div key={`steer${i}`} role="note" data-testid="steer-note" className="lb-caption" style={{ margin: "6px 4px", color: "var(--color-muted-foreground)", overflowWrap: "anywhere" }}>
                  <strong>{t("steerNote")}</strong>
                  <Markdown text={text} />
                </div>
              ))}
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
              {turn.confirmed === "completed" && !turn.checking && !turn.skillDraft && turn.state.items.some((i) => i.kind === "message") && (
                <ReactionStrip side="bot" marks={marksOf(turn, "replyRow")} turn={turn.id} slot="replyRow" off={reactOff} onOff={reactOffNow} onReact={react} threads={threadsOf(turn, "replyRow")} onThread={onThread} onOpenThread={onOpenThread} />
              )}
              {turn.confirmed === "completed" && turnFiles(turn).map((p) => (
                <FileCard key={`f${p}`} path={p} botLabel={name} state={files.state[`${turn.id}|${p}`]} onDownload={() => void files.download(`${turn.id}|${p}`, p)}
                  bot={bot.name} onOpenPage={onOpenPage} />
              ))}
              {(turn.pages ?? []).map((p) => <PageCard key={p.slug} title={p.title} botLabel={name} onOpen={onOpenPage ? () => onOpenPage(p.slug) : undefined} />)}
              {!turn.confirmed && turn.runId && <RunControls bot={bot.name} runId={turn.runId} active onNeedsYou={setNeedsYou} />}
              {turn.otherChannel && (
                <OtherChannelCard source={turn.otherChannel.source} onNew={() => setDraft(startNew(turn))}
                  onFork={async () => { const again = await forkConversation(turn); if (again !== null) setDraft(again); }} />
              )}
              {turn.skillDraft && turn.confirmed && !turn.state.items.some((i) => i.kind === "message") && <SkillNoAnswer onAskAgain={() => setSkillAsk(true)} />}
              {turn.errors.map((m, i) => <ErrorCard key={`e${i}`} message={m} />)}
              <SystemLine live>{needsYou && !turn.confirmed ? t("statusAskingYou") : statusLabel(turn, t)}</SystemLine>
            </div>
          ))}
          {receipts.map((r, i) => <CallReceiptLine key={`call${i}`} receipt={r} />)}
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
        <RadioNotes problem={radio.problem} provider={provider} speakError={speakError} />
        {voiceReady && <RadioLanguageLine bot={bot.name} settings={voiceSettings} pressed={radioUsed} onSettings={setVoiceSettings} />}
        {call.phase === "idle" && call.problem && <p role="alert" data-testid="call-problem" className="lb-caption" style={{ margin: "0 16px 6px", color: "var(--color-destructive)" }}><ErrorNote error={callProblemText(call.problem, t)} /></p>}
        <form onSubmit={(e) => { e.preventDefault(); void send(); }}
          style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8, margin: "0 16px 16px", padding: "6px 6px 6px 6px", borderRadius: 24, background: "var(--lb-fill)",
            ...(dragging ? { outline: "2px dashed var(--color-primary)", outlineOffset: 2 } : {}) }}>
          <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden tabIndex={-1}
            onChange={(e) => { att.add(e.currentTarget.files); e.currentTarget.value = ""; }} />
          <button type="button" className="lb-icon-btn" aria-label={t("attachBtn")} title={t("attachBtn")} disabled={att.busy}
            onClick={() => fileInput.current?.click()} style={{ width: 40, height: 40, flexShrink: 0 }}>
            <PaperclipIcon size={18} />
          </button>
          <RadioButton radio={radio} disabled={!!radioReason || !!active || att.busy || radio.phase === "sending"} reason={radioReason} onTapMode={setTapMode} />
          <CallButton call={call} status={voice?.call ?? null} disabled={!!callReason || att.busy || recordingNow} reason={callReason} />
          {recordingNow ? <RadioStrip phase={radio.phase} seconds={radio.seconds} tapMode={tapMode} provider={voiceSettings?.stt.provider ?? null} onCancel={() => { setTapMode(false); radio.cancel(); }} /> : <textarea aria-label={t("messageLabel")} placeholder={dragging ? t("attachDrop") : t("composerPlaceholder", { name })} value={draft} rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              // a pasted image (or file) becomes a chip; a pasted text stays text
              const files = e.clipboardData?.files;
              if (!files?.length) return;
              if (!e.clipboardData.getData("text/plain")) e.preventDefault();
              att.add(files);
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            className="lb-body" style={{ flex: "1 1 140px", minWidth: 120, minHeight: 40, maxHeight: 160, padding: "10px 0", border: "none", outline: "none", resize: "none", background: "transparent", fieldSizing: "content" } as React.CSSProperties} />}
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
      <SkillAskDialog open={skillAsk} bot={bot.name} session={session()} busyTurn={!!active} onClose={() => setSkillAsk(false)}
        onAsked={(run: RunInfo) => { setSkillAsk(false); void follow("", (onFrame, signal) => openStream(runEventsUrl(bot.name, run.id), onFrame, { fetcher, signal }), { skillDraft: true, runId: run.id }); }} />
      <NewPageDialog open={saveAs !== null} bot={bot.name} botLabel={name} initialTitle={saveAs ? titleFrom(saveAs) : ""} content={saveAs ?? undefined}
        onClose={() => setSaveAs(null)} onCreated={(page: Page) => { setSaveAs(null); onOpenPage?.(page.slug); }} />
      {thread && !narrow && <aside aria-label={t("threadTitle")} style={{ width: 360, flexShrink: 0, borderLeft: "1px solid var(--lb-separator)", minHeight: 0 }}>
        <ThreadPanel key={thread.key} bot={bot} target={thread} fetcher={fetcher} pollMs={pollMs} phone={false} onClose={closeThread} pendingApprovals={pendingApprovals} onOpenApprovals={openApprovals} /></aside>}
      {thread && narrow && (
        <aside ref={threadRef} role="dialog" aria-modal="true" aria-label={t("threadTitle")} style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", flexDirection: "column", background: "var(--color-card)" }}>
          <ThreadPanel key={thread.key} bot={bot} target={thread} fetcher={fetcher} pollMs={pollMs} phone onClose={closeThread} pendingApprovals={pendingApprovals} onOpenApprovals={openApprovals} /></aside>
      )}
      {!thread && sidePanel}
      {!thread && !sidePanel && !sheet && panelOpen && <aside id="lb-work-panel" style={{ width: 320, flexShrink: 0, borderLeft: "1px solid var(--lb-separator)", minHeight: 0 }}>{panel}</aside>}
      {sheet && drawer && (
        // a phone (or a window with no room for a column beside the conversation) has no side panel: the work panel is a screen of its own, with its own way out
        <aside ref={drawerRef} role="dialog" aria-modal="true" aria-label={t("workPanelBtn")} style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", flexDirection: "column", background: "var(--color-card)" }}>
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 8px 0" }}>
            <button type="button" className="lb-btn" onClick={() => setDrawer(false)}>‹ {t("backToConversation")}</button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>{panel}</div>
        </aside>
      )}
    </div>
    </EvidenceProvider>
  );
}
