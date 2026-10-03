// dashboard/src/components/transcript/frames.ts
// Maps real Hermes SSE payloads (tests/contract/frames/{chat,run}) to card props.
// Chat stream names the tool `tool_name`; run stream names it `tool`. Only fields seen in real frames.

export type Frame = Record<string, any>;

/** Parses one `.sse` frame (`event:`/`id:`/`data:` lines) into its JSON data. */
export function parseSse(raw: string): Frame {
  const line = raw.split("\n").find((l) => l.startsWith("data:"));
  return line ? JSON.parse(line.slice(5).trim()) : {};
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export type ToolProps = {
  name: string;
  status: "running" | "done" | "error";
  preview?: string;
  args?: Record<string, unknown>;
  durationS?: number;
  result?: string;
};

export function toolFromFrame(event: string, f: Frame): ToolProps {
  const name = str(f.tool_name) ?? str(f.tool) ?? "?";
  if (event === "tool.started") return { name, status: "running", preview: str(f.preview), args: f.args ?? undefined };
  const failed = event === "tool.failed" || f.error === true;
  return {
    name, status: failed ? "error" : "done", preview: str(f.preview) ?? undefined,
    durationS: typeof f.duration === "number" ? f.duration : undefined,
    result: str(f.preview) ?? undefined,
  };
}

export function approvalFromFrame(f: Frame) {
  return {
    requestId: String(f.request_id ?? ""),
    command: str(f.command) ?? "",
    description: str(f.description) ?? "",
    patternKey: str(f.pattern_key) ?? (Array.isArray(f.pattern_keys) ? str(f.pattern_keys[0]) : undefined),
    choices: Array.isArray(f.choices) ? (f.choices as string[]) : [],
  };
}

export const commentaryFromFrame = (f: Frame) => str(f.text) ?? "";
export const messageFromFrame = (f: Frame) => str(f.content) ?? str(f.output) ?? "";
