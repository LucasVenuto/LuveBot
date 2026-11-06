// dashboard/src/components/rooms/FileTools.tsx
// What each recipient can do with the files attached to a room message (contract v0.9 14, A-89): one calm line per recipient, from the tools its
// api_server toolsets give it NOW (`GET /bots/{bot}` -> `file_tools`, read when a file is attached). It says what the Bot can TRY, never what it
// did; `terminal: true` is not a permission (every command still goes through the approval rules); it never blocks the send. A key the line needs
// that the server could not tell says nothing for that kind of file: the tray keeps what it said before (the provider notice).
import React from "react";
import { getBot } from "../../api/client";
import type { BotFileTools } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { IMAGE_NAME } from "../conversation/Attachments";

/** The row of the contract's table that holds for text, documents, tables and code, or null (a needed key is absent: nothing is said). */
export function docLine(tools: BotFileTools | null | undefined): TranslationKey | null {
  if (!tools) return null;
  if (tools.read_file === true) return "fileToolsReadDoc";
  if (tools.terminal === true) return "fileToolsTermDoc";
  return tools.read_file === false && tools.terminal === false ? "fileToolsNoDoc" : null;
}

/** The same for images. "Only through the terminal, not look at it" needs `vision_analyze` KNOWN false: an absent key is not a "cannot". */
export function imageLine(tools: BotFileTools | null | undefined): TranslationKey | null {
  if (!tools) return null;
  if (tools.vision_analyze === true) return "fileToolsLookImg";
  if (tools.vision_analyze !== false) return null;
  if (tools.terminal === true) return "fileToolsTermImg";
  return tools.terminal === false ? "fileToolsNoImg" : null;
}

type Read = BotFileTools | null;   // null: could not be read, so nothing is said

/** Each Bot's `file_tools`, asked once while files are attached (the server remembers 60 s); forgotten when the files go, so the next attach asks again. */
function useFileTools(bots: readonly string[], enabled: boolean): Record<string, Read | undefined> {
  const [seen, setSeen] = React.useState<Record<string, Read>>({});
  const asked = React.useRef(new Set<string>());
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);
  const key = bots.join("|");
  React.useEffect(() => {
    if (!enabled) { if (asked.current.size) { asked.current.clear(); setSeen({}); } return; }
    for (const bot of bots) {
      if (asked.current.has(bot)) continue;
      asked.current.add(bot);
      getBot(bot).then((d) => (d?.file_tools && typeof d.file_tools === "object" ? d.file_tools : null), () => null)
        .then((tools) => { if (alive.current) setSeen((s) => ({ ...s, [bot]: tools })); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
  return seen;
}

/** The lines are written to follow "Name:" (lower case); the one that comes AFTER another line follows its full stop, so it starts a sentence. */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function FileTools({ files, recipients }: { files: readonly File[]; recipients: ReadonlyArray<{ bot: string; label: string }> }) {
  const { t } = useLuveI18n();
  const tools = useFileTools(recipients.map((r) => r.bot), files.length > 0);
  const hasImage = files.some((f) => IMAGE_NAME.test(f.name));
  const hasDoc = files.some((f) => !IMAGE_NAME.test(f.name));
  const rows = recipients.map((r) => ({ ...r, says: [hasDoc ? docLine(tools[r.bot]) : null, hasImage ? imageLine(tools[r.bot]) : null].filter((k): k is TranslationKey => !!k) }))
    .filter((r) => r.says.length > 0);
  if (!files.length || !rows.length) return null;
  return (
    <ul aria-label={t("fileToolsLabel")} className="lb-caption" style={{ listStyle: "none", margin: "0 16px 6px", padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
      {rows.map((r) => <li key={r.bot}><strong>{r.label}</strong>: {r.says.map((k, i) => (i ? sentence(t(k)) : t(k))).join(" ")}</li>)}
    </ul>
  );
}
