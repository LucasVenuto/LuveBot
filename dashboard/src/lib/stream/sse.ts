// dashboard/src/lib/stream/sse.ts
// SSE reader over fetch + ReadableStream (contract §6.0). NEVER EventSource; the token travels
// only in the header that authedFetch adds. Understands both Hermes framings:
//   run:  `id:` + JSON `event` field (no `event:` line), seq from 0
//   chat: `event:` line, no `id:`, seq from 1
// and our own luvebot.* events. Frame text is data, never instruction.

import { getSDK } from "../../sdk";

export type Frame = { event: string; id?: string; data: Record<string, any> };

const MAX_BUFFER = 1_000_000; // ponytail: one SSE event over ~1 MB is abnormal; raise if a real frame needs it

/** Incremental SSE parser. push() accepts bytes or text cut at any point, even inside a UTF-8 character. */
export class SseParser {
  private dec = new TextDecoder("utf-8");
  private buf = "";
  private ev = "";
  private id: string | undefined;
  private data: string[] = [];

  push(chunk: Uint8Array | string): Frame[] {
    this.buf += typeof chunk === "string" ? chunk : this.dec.decode(chunk, { stream: true });
    if (this.buf.length > MAX_BUFFER) throw new Error("sse: frame too large");
    // A trailing "\r" may be the first half of "\r\n": hold it until the next chunk.
    const hold = this.buf.endsWith("\r") ? "\r" : "";
    const text = (hold ? this.buf.slice(0, -1) : this.buf).replace(/\r\n|\r/g, "\n");
    const lines = text.split("\n");
    this.buf = lines.pop()! + hold;
    const out: Frame[] = [];
    for (const line of lines) {
      const f = this.line(line);
      if (f) out.push(f);
    }
    return out;
  }

  /** An event cut off before its blank line is discarded, as the SSE spec says. */
  end(): void {
    this.buf = ""; this.ev = ""; this.id = undefined; this.data = [];
  }

  private line(line: string): Frame | null {
    if (line === "") {
      const raw = this.data.join("\n"), ev = this.ev, id = this.id;
      const had = this.data.length > 0;
      this.ev = ""; this.id = undefined; this.data = [];
      if (!had) return null;
      let data: unknown;
      try { data = JSON.parse(raw); } catch { return null; } // not JSON: drop
      if (!data || typeof data !== "object" || Array.isArray(data)) return null;
      const d = data as Record<string, any>;
      const event = ev || (typeof d.event === "string" ? d.event : "");
      return event ? { event, id, data: d } : null;
    }
    if (line.startsWith(":")) return null; // comment (": open", ": ping", ": stream closed")
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") this.ev = value;
    else if (field === "id") this.id = value;
    else if (field === "data") this.data.push(value);
    return null;
  }
}

export class StreamHttpError extends Error {
  constructor(public status: number) { super(`stream http ${status}`); }
}

/** Drains a Response body into onFrame. Resolves when the stream ends or the signal aborts. */
export async function readFrames(res: Response, onFrame: (f: Frame) => void, signal?: AbortSignal): Promise<void> {
  if (!res.ok) throw new StreamHttpError(res.status); // callers key on the status, never the body
  if (!res.body) throw new Error("stream: response has no body");
  const reader = res.body.getReader();
  const parser = new SseParser();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", onAbort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const f of parser.push(value)) onFrame(f);
    }
  } catch (e) {
    if (!signal?.aborted) throw e; // abort is a normal exit
  } finally {
    signal?.removeEventListener("abort", onAbort);
    parser.end();
  }
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Opens a stream through authedFetch (or an injected fetcher). Closing it never stops the run: use Parar. */
export async function openStream(
  url: string,
  onFrame: (f: Frame) => void,
  opts: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal; fetcher?: Fetcher } = {},
): Promise<void> {
  if (/[?&](token|access_token|session_token)=/i.test(url)) throw new Error("stream: token must travel in a header, not the URL");
  const fetcher = opts.fetcher ?? getSDK()?.authedFetch;
  if (!fetcher) throw new Error("stream: Hermes Plugin SDK authedFetch is not available");
  const res = await fetcher(url, {
    method: opts.method ?? "GET",
    body: opts.body,
    headers: { Accept: "text/event-stream", ...opts.headers },
    signal: opts.signal,
  });
  await readFrames(res, onFrame, opts.signal);
}
