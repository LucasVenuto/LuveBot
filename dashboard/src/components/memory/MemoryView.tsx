// dashboard/src/components/memory/MemoryView.tsx
// What a Bot remembers, item by item (contract v0.8 §1): the Bot's notes and the profile of the person, each a list of items that can be added,
// edited and removed one by one, or cleared. Hermes's own MemoryStore does every change in the Bot's profile (LuveBot never opens the files); an
// edit is pinned to the exact item the person saw, so one that moved meanwhile says so instead of being overwritten. An item that holds a
// secret is shown redacted and can only be removed. Adding and editing need a login (the text goes into every future prompt of the Bot);
// removing and clearing do not. Changes count in NEW conversations. The text of an item is the Bot's or the person's own: plain text, never markup.
import React from "react";
import { ApiError, getMemory, addMemory, replaceMemory, removeMemory, clearMemory, exportMemory, getSession } from "../../api/client";
import type { MemoryEntry, MemoryTarget, MemoryViewResponse } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { noLoginOf, type NoLogin } from "../../lib/authMode";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";
import { saveBlob } from "../conversation/FileCard";

const MAX_CHARS = 2000;                                         // the route's limit for one item
const TARGETS: Array<{ target: MemoryTarget; title: TranslationKey; help: TranslationKey }> = [
  { target: "memory", title: "memNotes", help: "memNotesHelp" },
  { target: "user", title: "memProfile", help: "memProfileHelp" },
];
const OWN: Record<string, TranslationKey> = {
  memory_entry_not_found: "memErrNotFound", memory_changed: "memErrChanged", memory_redacted: "memErrRedacted", memory_refused: "memErrRefused",
  memory_full: "memErrFull", memory_disabled: "memErrDisabled",
};
type T = (k: TranslationKey, p?: Record<string, string | number>) => string;

export function memoryError(e: unknown, t: T): ErrorState {
  return e instanceof ApiError && OWN[e.code] ? { text: t(OWN[e.code]), code: e.code } : humanError(e, t as (k: TranslationKey) => string, "memErrGeneric");
}

export function MemoryView({ botName, botLabel }: { botName: string; botLabel?: string }) {
  const { t, locale } = useLuveI18n();
  const [view, setView] = React.useState<MemoryViewResponse | null>(null);
  const [loadError, setLoadError] = React.useState<ErrorState | null>(null);
  const [noLoginKind, setNoLoginKind] = React.useState<NoLogin | null>(null);
  const noLogin = noLoginKind !== null;
  const needLogin = noLoginKind === "deployment" ? t("errCredentialNotHuman") : t("memNeedLogin");
  const [adding, setAdding] = React.useState<{ target: MemoryTarget; text: string } | null>(null);
  const [editing, setEditing] = React.useState<{ target: MemoryTarget; id: string; uid: string; text: string } | null>(null);   // uid: the item on screen; id: what the server names (two equal items share it)
  const [confirm, setConfirm] = React.useState<string | null>(null);        // "remove:<target>:<id>" or "clear:<target>"
  const [busy, setBusy] = React.useState(false);
  const [said, setSaid] = React.useState<{ text?: string; error?: ErrorState } | null>(null);
  const alive = React.useRef(true);
  const num = (n: number) => n.toLocaleString(locale === "pt" ? "pt-BR" : "en-US");

  const load = React.useCallback(async () => {
    try { const v = await getMemory(botName); if (alive.current) { setView(v); setLoadError(null); } }
    catch (e) { if (alive.current) setLoadError(humanError(e, t as (k: TranslationKey) => string, "memErrGeneric")); }
  }, [botName]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    alive.current = true;
    setView(null); setLoadError(null); setAdding(null); setEditing(null); setConfirm(null); setSaid(null);
    void load();
    getSession().then((s) => { if (alive.current) setNoLoginKind(noLoginOf(s?.auth_mode)); }, () => { /* the server decides at the click */ });
    return () => { alive.current = false; };
  }, [load]);

  /** One change: runs it, says it in words, and reads the memory again (the server's list is the truth; a stale item reloads the list). */
  async function change(run: () => Promise<string | undefined>) {
    if (busy) return;
    setBusy(true); setSaid(null);
    try {
      const text = await run();
      if (alive.current) setSaid({ text });
      setAdding(null); setEditing(null); setConfirm(null);
      await load();
    } catch (e) {
      if (alive.current) setSaid({ error: memoryError(e, t) });
      if (e instanceof ApiError && (e.code === "memory_changed" || e.code === "memory_entry_not_found")) { setEditing(null); setConfirm(null); await load(); }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function exportAll() {
    try { saveBlob(`memoria-${botName}.md`, await exportMemory(botName)); } catch (e) { setSaid({ error: memoryError(e, t) }); }
  }

  const name = botLabel || botName;
  return (
    <section aria-labelledby="memory-title" data-testid="memory-view" style={{ padding: "20px 16px 40px", maxWidth: 760, margin: "0 auto" }}>
      <h2 id="memory-title" className="lb-title" style={{ margin: "0 4px 4px" }}>{t("memTitle", { name })}</h2>
      <p className="lb-subhead" style={{ margin: "0 4px 12px" }}>{t("memIntro")}</p>
      {view?.provider && <p data-testid="memory-provider" className="lb-caption" style={{ margin: "0 4px 12px" }}>{t("memProvider", { name: view.provider })}</p>}
      {noLogin && <p role="status" data-testid="memory-no-login" className="lb-caption" style={{ margin: "0 4px 12px" }}>{needLogin}</p>}
      {said?.text && <p role="status" className="lb-caption" style={{ margin: "0 4px 12px" }}>{said.text}</p>}
      {said?.error && <p role="alert" className="lb-caption" style={{ margin: "0 4px 12px", color: "var(--color-destructive)" }}><ErrorNote error={said.error} /></p>}
      {!view && !loadError && <p className="lb-subhead" style={{ margin: "0 4px" }}>{t("agentLoading")}</p>}
      {loadError && <p role="alert" className="lb-caption" style={{ margin: "0 4px 12px", color: "var(--color-destructive)" }}><ErrorNote error={loadError} /></p>}
      {view && TARGETS.map(({ target, title, help }) => {
        const part = view.targets[target];
        if (!part) return null;
        const open = adding?.target === target;
        return (
          <section key={target} aria-labelledby={`mem-${target}`} data-testid={`memory-${target}`} style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, padding: "0 4px 6px" }}>
              <h3 id={`mem-${target}`} className="lb-headline" style={{ margin: 0 }}>{t(title)}</h3>
              {part.enabled && <span className="lb-caption" data-testid={`memory-used-${target}`}>{t("memUsed", { used: num(part.used), limit: num(part.limit) })}</span>}
            </div>
            <p className="lb-subhead" style={{ margin: "0 4px 8px" }}>{t(help)}</p>
            {!part.enabled ? <p data-testid={`memory-off-${target}`} className="lb-caption" style={{ margin: "0 4px" }}>{t("memOff")}</p> : (
              <>
                {part.entries.length === 0 && !open && <p data-testid={`memory-empty-${target}`} className="lb-subhead" style={{ margin: "0 4px 8px" }}>{t("memEmpty")}</p>}
                {part.entries.length > 0 && (
                  <ul className="lb-group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {withUids(part.entries).map(({ e, uid }) => (
                      <Item key={uid} uid={uid} entry={e} target={target} t={t} busy={busy} noLogin={noLogin} needLogin={needLogin}
                        editing={editing?.target === target && editing.uid === uid ? editing : null}
                        confirming={confirm === `remove:${target}:${uid}`}
                        onEdit={() => { setConfirm(null); setAdding(null); setEditing({ target, id: e.id, uid, text: e.text }); }}
                        onText={(text) => setEditing((x) => (x ? { ...x, text } : x))}
                        onCancel={() => { setEditing(null); setConfirm(null); }}
                        onSave={() => editing && void change(async () => { await replaceMemory(botName, target, e.id, editing.text.trim()); return t("memSaved"); })}
                        onAskRemove={() => { setEditing(null); setConfirm(`remove:${target}:${uid}`); }}
                        onRemove={() => void change(async () => { await removeMemory(botName, target, e.id); return t("memRemoved"); })} />
                    ))}
                  </ul>
                )}
                {open && (
                  <div data-testid={`memory-add-${target}`} style={{ marginTop: 8 }}>
                    <label htmlFor={`mem-new-${target}`} className="lb-label">{t("memAddLabel")}</label>
                    <textarea id={`mem-new-${target}`} className="lb-input" rows={3} maxLength={MAX_CHARS} value={adding!.text} placeholder={t("memAddPlaceholder")} autoFocus disabled={busy}
                      onChange={(ev) => setAdding({ target, text: ev.target.value })} />
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                      <button type="button" className="lb-btn lb-btn-primary" disabled={busy || !adding!.text.trim()}
                        onClick={() => void change(async () => { await addMemory(botName, target, adding!.text.trim()); return t("memSaved"); })}>{t("memSave")}</button>
                      <button type="button" className="lb-btn" disabled={busy} onClick={() => setAdding(null)}>{t("memCancel")}</button>
                      <span className="lb-caption" style={{ marginLeft: "auto" }}>{t("memChars", { n: num(adding!.text.length), max: num(MAX_CHARS) })}</span>
                    </div>
                  </div>
                )}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                  {!open && <button type="button" className="lb-btn" disabled={busy || noLogin} title={noLogin ? needLogin : undefined}
                    onClick={() => { setEditing(null); setConfirm(null); setAdding({ target, text: "" }); }}>{t("memAdd")}</button>}
                  {part.entries.length > 0 && confirm !== `clear:${target}` && <button type="button" className="lb-btn" disabled={busy}
                    onClick={() => { setEditing(null); setAdding(null); setConfirm(`clear:${target}`); }}>{t("memClear")}</button>}
                </div>
                {confirm === `clear:${target}` && (
                  <div role="group" aria-label={t("memClear")} data-testid={`memory-clear-confirm-${target}`} className="lb-group" style={{ padding: 12, marginTop: 8 }}>
                    <p className="lb-body" style={{ margin: "0 0 8px" }}>{t("memClearConfirm", { n: part.entries.length })}</p>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" className="lb-btn lb-btn-destructive" disabled={busy}
                        onClick={() => void change(async () => { const r = await clearMemory(botName, target); return r.skipped ? t("memClearedSkipped", { removed: r.removed, skipped: r.skipped }) : t("memCleared", { removed: r.removed }); })}>{t("memClearGo")}</button>
                      <button type="button" className="lb-btn" disabled={busy} onClick={() => setConfirm(null)}>{t("memCancel")}</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        );
      })}
      {view && <button type="button" className="lb-btn lb-btn-plain" onClick={() => void exportAll()}>{t("memExport")}</button>}
    </section>
  );
}

/** Each entry with a key that is its own on screen. The server names an item by the sha of its text, so two equal items share an id; the second one is
 *  `<id>~1` here (React key, edit and confirm state, DOM ids), while every call to the server still uses the real id (red team, Info of 2026-10-29). */
export function withUids(entries: MemoryEntry[]): { e: MemoryEntry; uid: string }[] {
  const seen = new Map<string, number>();
  return entries.map((e) => { const n = seen.get(e.id) ?? 0; seen.set(e.id, n + 1); return { e, uid: n ? `${e.id}~${n}` : e.id }; });
}

function Item({ uid, entry, target, t, busy, noLogin, needLogin, editing, confirming, onEdit, onText, onCancel, onSave, onAskRemove, onRemove }: {
  uid: string; entry: MemoryEntry; target: MemoryTarget; t: T; busy: boolean; noLogin: boolean; needLogin: string; editing: { text: string } | null; confirming: boolean;
  onEdit: () => void; onText: (text: string) => void; onCancel: () => void; onSave: () => void; onAskRemove: () => void; onRemove: () => void;
}) {
  return (
    <li data-testid="memory-item" data-id={entry.id} className="lb-row lb-row-flat" style={{ alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
      <span className="lb-row-stack" style={{ minWidth: 0, flex: "1 1 240px" }}>
        {editing ? (
          <>
            <label htmlFor={`mem-edit-${uid}`} className="lb-label">{t("memEdit")}</label>
            <textarea id={`mem-edit-${uid}`} className="lb-input" rows={4} maxLength={MAX_CHARS} value={editing.text} autoFocus disabled={busy} onChange={(ev) => onText(ev.target.value)} />
            <span className="lb-caption">{t("memChars", { n: editing.text.length, max: MAX_CHARS })}</span>
          </>
        ) : (
          <>
            <span className="lb-body" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{entry.text}</span>
            {entry.redacted && <span data-testid="memory-hidden" className="lb-caption">{t("memHidden")}</span>}
          </>
        )}
      </span>
      <span style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
        {editing ? (
          <>
            <button type="button" className="lb-btn lb-btn-primary" disabled={busy || !editing.text.trim() || editing.text.trim() === entry.text} onClick={onSave}>{t("memSave")}</button>
            <button type="button" className="lb-btn" disabled={busy} onClick={onCancel}>{t("memCancel")}</button>
          </>
        ) : confirming ? (
          <>
            <button type="button" className="lb-btn lb-btn-destructive" disabled={busy} onClick={onRemove}>{t("memRemoveConfirm")}</button>
            <button type="button" className="lb-btn" disabled={busy} onClick={onCancel}>{t("memCancel")}</button>
          </>
        ) : (
          <>
            <button type="button" className="lb-btn" disabled={busy || entry.redacted || noLogin} title={entry.redacted ? t("memHidden") : noLogin ? needLogin : undefined}
              aria-label={`${t("memEdit")}: ${entry.redacted ? "" : entry.text.slice(0, 40)}`.trim()} onClick={onEdit}>{t("memEdit")}</button>
            <button type="button" className="lb-btn" disabled={busy} aria-label={`${t("memRemove")}: ${entry.redacted ? "" : entry.text.slice(0, 40)}`.trim()} onClick={onAskRemove}>{t("memRemove")}</button>
          </>
        )}
      </span>
    </li>
  );
}
