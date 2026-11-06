// dashboard/src/components/rooms/RoomFiles.tsx
// Files in a room (contract v0.6 Part C, 9.1 and 9.2, with section 15). A person's message shows its chips from LuveBot's RECORD
// of that send (`event.attachments`, decided on the server), never from its text: an "[Anexo: …]" line a person typed stays text,
// with no chip and no fetch. A member's message gets file cards that download from its AUTHOR Bot only (`event.author_bot`,
// Hermes's sender): no author, no card. A refused send is said in words, naming the Bots without a work folder.
import React from "react";
import { ApiError, setBotWorkspace } from "../../api/client";
import type { RoomAttachment, RoomEvent } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";
import { SentAttachments, formatName, formatSize, attachError } from "../conversation/Attachments";
import { FileCard, citedFiles, useFileDownloads } from "../conversation/FileCard";

type T = (k: TranslationKey, p?: Record<string, string | number>) => string;

/** The person's text without the lines of the RECORDED files (those become chips); any other line, typed or not, stays. */
export function personText(text: string, files: readonly RoomAttachment[] | undefined): string {
  if (!files?.length) return text;
  const lines = new Set(files.map((f) => f.path));
  return text.split("\n").filter((line) => {
    const m = line.trim().match(/^\[Anexo: (attachments\/[^,\]\n]+), [^\]\n]*\]$/);
    return !(m && lines.has(m[1]));
  }).join("\n").trim();
}

/** The chips of a person's send. The preview reads the copy of the FIRST recipient Bot the record names (each has the same file). */
export function PersonFiles({ files, spaced }: { files: RoomAttachment[]; spaced: boolean }) {
  const refs = files.map((f) => ({ name: f.name, type: formatName(f.kind), size: formatSize(f.size), path: f.path }));
  return <SentAttachments refs={refs} spaced={spaced} bot={files[0]?.bots[0]} />;
}

/** The cards of the files a member cites, from its author Bot's workspace; none when Hermes's sender is not a member. */
export function MemberFiles({ event, label }: { event: RoomEvent; label: string }) {
  const bot = event.author_bot;
  const files = useFileDownloads(bot ?? "");
  if (!bot) return null;
  const paths = citedFiles(event.payload.text || "");
  if (!paths.length) return null;
  return (
    <div style={{ marginLeft: 36 }}>
      {paths.map((p) => (
        <FileCard key={p} path={p} botLabel={label} bot={bot} state={files.state[`${event.event_id}|${p}`]} onDownload={() => void files.download(`${event.event_id}|${p}`, p)} />
      ))}
    </div>
  );
}

export type MissingFolder = { bot: string; reason: string };

/** A refused send with files, in words; `missing` when Bots have no work folder (409 workspace_unavailable, nothing was sent). */
export function roomSendError(e: unknown, withFiles: boolean, t: T): { error: ErrorState; missing: MissingFolder[] } {
  if (e instanceof ApiError) {
    if (e.code === "workspace_unavailable" && Array.isArray(e.details?.bots)) {
      const missing = (e.details!.bots as unknown[]).filter((x): x is MissingFolder => !!x && typeof (x as MissingFolder).bot === "string")
        .map((x) => ({ bot: x.bot, reason: typeof x.reason === "string" ? x.reason : "" }));
      return { error: { text: t("roomFilesNoFolder"), code: e.code }, missing };
    }
    if (e.code === "too_large") return { error: { text: t("roomFilesTooLarge"), code: e.code }, missing: [] };
    if (e.code === "attachment_refused") return { error: attachError(e, t).error, missing: [] };
    if (withFiles && e.code === "hermes_error") return { error: { text: t("roomFilesPartial"), code: e.code }, missing: [] };
  }
  return { error: humanError(e, t, "errorSendingRoomMessage"), missing: [] };
}

const FOLDER: Record<string, TranslationKey> = {
  no_workspace: "attachWsNone", not_local: "attachWsNotLocal", inside_hermes: "attachWsInside", unsafe: "attachWsUnsafe",
};

/** Each Bot without a work folder, why, and "Criar a pasta de trabalho de <Bot>" when that is the fix; then the person resends. */
export function MissingFolders({ missing, labelOf }: { missing: MissingFolder[]; labelOf: (bot: string) => string }) {
  const { t } = useLuveI18n();
  const [made, setMade] = React.useState<Record<string, ErrorState | "ok" | "busy">>({});
  async function create(bot: string) {
    setMade((m) => ({ ...m, [bot]: "busy" }));
    try {
      const { workspace } = await setBotWorkspace(bot);
      const ok = workspace.state === "ready" || workspace.state === "empty";
      setMade((m) => ({ ...m, [bot]: ok ? "ok" : { text: t(FOLDER[workspace.state] ?? "attachWsOther"), code: `workspace:${workspace.state}` } }));
    } catch (e) {
      setMade((m) => ({ ...m, [bot]: humanError(e, t, "attachWsCreateFailed") }));
    }
  }
  return (
    <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      {missing.map(({ bot, reason }) => {
        const state = made[bot];
        return (
          <li key={bot} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <span><strong>{labelOf(bot)}</strong>: {t(FOLDER[reason] ?? "attachWsOther")}</span>
            {state === "ok" ? <span role="status">{t("roomFilesFolderMade", { bot: labelOf(bot) })}</span>
              : reason === "no_workspace" && (
                <button type="button" className="lb-btn" disabled={state === "busy"} onClick={() => void create(bot)}>{t("roomFilesMakeFolder", { bot: labelOf(bot) })}</button>
              )}
            {state && state !== "ok" && state !== "busy" && <span><ErrorNote error={state} /></span>}
          </li>
        );
      })}
    </ul>
  );
}

