// dashboard/src/components/conversation/derive.ts
// Pure derivations of the work panel (spec 4.3 "Painel de trabalho") from transcript items. No routes, no HTML:
// every string is data for text rendering. Tool names are the ones OBSERVED in tests/contract/frames and
// tests/harness/evidence/t08 (only `terminal`) and, for files, the names in the Hermes code (see FILE_TOOLS).

import type { Item } from "../../lib/stream";

type Items = { items: readonly Item[] };
type Tool = Extract<Item, { kind: "tool" }>;

export const TERMINAL_TOOL = "terminal"; // observed in run (`tool`) and chat (`tool_name`) frames

export type FileTools = Record<string, { op: "read" | "write"; pathArg: string }>;

/**
 * File tools, from the Hermes code at f8489405 (tools/file_tools.py), not from recorded frames:
 *  read_file  (read,  `path`): https://github.com/NousResearch/hermes-agent/blob/f8489405/tools/file_tools.py#L1147 and #L1390
 *  write_file (write, `path`): .../file_tools.py#L1169 and #L1391
 *  patch      (write, `path`, required at #L1227): .../file_tools.py#L1187 and #L1414
 * search_files is left out on purpose: its `path` is a directory. The path is read from `args.path` only
 * (chat surface). The run surface has no args, just a preview, and we never parse a path out of a preview.
 */
export const FILE_TOOLS: FileTools = {
  read_file: { op: "read", pathArg: "path" },
  write_file: { op: "write", pathArg: "path" },
  patch: { op: "write", pathArg: "path" },
};

const MAX = 20_000;
const cap = (s: string) => (s.length > MAX ? s.slice(0, MAX) + "\n…" : s);

export type ActivityEntry =
  | { kind: "tool"; id: string; name: string; status: Tool["status"]; preview?: string; durationS?: number; error?: string }
  | { kind: "commentary"; id: string; text: string };

export function deriveActivity(s: Items): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const i of s.items) {
    if (i.kind === "tool") {
      out.push({ kind: "tool", id: i.id, name: i.name, status: i.status, preview: i.preview, durationS: i.durationS, error: i.status === "error" ? i.result : undefined });
    } else if (i.kind === "commentary") out.push({ kind: "commentary", id: i.id, text: i.text });
  }
  return out;
}

export type TerminalEntry = {
  id: string; command: string; status: Tool["status"]; durationS?: number;
  output?: string; exitCode?: number; // run surface: result is JSON {output, exit_code, error}; chat surface has no result (A-11)
};

function parseResult(raw: string | undefined): { output?: string; exitCode?: number } {
  if (raw === undefined) return {};
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const o = j as Record<string, unknown>;
      const output = typeof o.output === "string" ? o.output : undefined;
      const err = typeof o.error === "string" && o.error ? o.error : undefined;
      return { output: cap([output, err].filter((x) => x !== undefined).join("\n")), exitCode: typeof o.exit_code === "number" ? o.exit_code : undefined };
    }
  } catch { /* not JSON: show it as plain text */ }
  return { output: cap(raw) };
}

export function deriveTerminal(s: Items): TerminalEntry[] {
  return s.items.filter((i): i is Tool => i.kind === "tool" && i.name === TERMINAL_TOOL).map((t) => {
    const cmd = t.args && typeof t.args.command === "string" ? t.args.command : t.preview ?? "";
    return { id: t.id, command: cmd, status: t.status, durationS: t.durationS, ...parseResult(t.result) };
  });
}

export type FileEntry = { id: string; path: string; op: "read" | "write"; preview?: string; status: Tool["status"] };

export function deriveFiles(s: Items, tools: FileTools = FILE_TOOLS): FileEntry[] {
  const out: FileEntry[] = [];
  for (const i of s.items) {
    if (i.kind !== "tool") continue;
    const spec = Object.prototype.hasOwnProperty.call(tools, i.name) ? tools[i.name] : undefined;
    const path = spec && i.args ? i.args[spec.pathArg] : undefined;
    if (spec && typeof path === "string" && path) out.push({ id: i.id, path, op: spec.op, preview: i.result ? cap(i.result) : undefined, status: i.status });
  }
  return out;
}
