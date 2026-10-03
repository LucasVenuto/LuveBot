// dashboard/src/lib/render/markdown.tsx
// Tiny markdown -> React elements. Never interprets HTML: every character the agent sends
// ends up as a React text child (escaped by React). Threat model T9/T14.

import React from "react";
import { useLuveI18n } from "../../i18n";

const MAX_CHARS = 100_000; // ponytail: hard cap keeps worst-case regex work bounded; add "show more" if needed
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Returns a normalized href only for http/https/mailto; otherwise null (caller renders text). */
export function safeHref(raw: string): string | null {
  // Any whitespace/control char or entity-looking prefix means an obfuscation attempt: reject.
  if (/[\u0000-\u0020\u007f-\u009f\u00a0\u2028\u2029\ufeff]/.test(raw)) return null;
  if (!/^(https?:\/\/|mailto:)/i.test(raw)) return null;
  try {
    const u = new URL(raw);
    return SAFE_PROTOCOLS.has(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

// Bounded quantifiers: no quadratic backtracking on "[[[[[…" or "*****…".
const INLINE = /`([^`\n]{1,2000})`|\*\*([^\n]{1,2000}?)\*\*|\*([^*\n]{1,2000}?)\*|\[([^\]\n]{1,500})\]\(([^)\n]{0,2000})\)/;

function inline(src: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = src;
  let i = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.push(rest); break; }
    if (m.index) out.push(rest.slice(0, m.index));
    const k = `${key}.${i++}`;
    if (m[1] !== undefined) out.push(<code key={k} className="luve-md-code" style={codeStyle}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{inline(m[2], k)}</strong>);
    else if (m[3] !== undefined) out.push(<em key={k}>{inline(m[3], k)}</em>);
    else {
      const href = safeHref(m[5]);
      out.push(href
        ? <a key={k} href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-primary)", textDecoration: "underline" }}>{m[4]}</a>
        : m[0]); // unsafe URL: the whole source stays visible as text
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const codeStyle: React.CSSProperties = {
  background: "var(--color-muted)", color: "var(--color-foreground)",
  borderRadius: 4, padding: "0 4px", fontFamily: "monospace", fontSize: "0.9em",
};
const blockStyle: React.CSSProperties = {
  ...codeStyle, display: "block", padding: 8, overflowX: "auto", whiteSpace: "pre",
};

const LIST = /^\s*(?:[-*+]|\d{1,9}\.)\s+(.*)$/;
// ATX heading, levels 1 to 3 only: "#" + space + text. "#x", "# " alone and "####" stay text.
const HEADING = /^ {0,3}(#{1,3})[ \t]+(\S.*)$/; // linear: no lazy part, no optional tail to backtrack over
const HEADING_TAG = ["h2", "h3", "h4"] as const;
const headingStyle: React.CSSProperties = { margin: "12px 0 4px", fontWeight: 600, lineHeight: 1.3 };
const HEADING_SIZE = ["1.25em", "1.1em", "1em"];

/** Drops a closing run of "#" ("## Título ##") with a plain loop instead of a backtracking regex. */
function headingText(body: string): string {
  let end = body.length;
  while (end > 0 && (body[end - 1] === " " || body[end - 1] === "\t")) end--;
  let h = end;
  while (h > 0 && body[h - 1] === "#") h--;
  if (h < end && h > 0 && (body[h - 1] === " " || body[h - 1] === "\t")) {
    end = h;
    while (end > 0 && (body[end - 1] === " " || body[end - 1] === "\t")) end--;
  }
  return body.slice(0, end);
}
const ORDERED = /^\s*\d{1,9}\.\s/;

export function Markdown({ text }: { text: string }) {
  const { t } = useLuveI18n();
  const truncated = text.length > MAX_CHARS;
  const lines = (truncated ? text.slice(0, MAX_CHARS) : text).split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const k = `b${blocks.length}`;
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or end of input)
      blocks.push(<pre key={k} style={{ margin: "4px 0" }}><code style={blockStyle}>{code.join("\n")}</code></pre>);
    } else if (!line.trim()) {
      i++;
    } else if (HEADING.test(line)) {
      const [, hashes, body] = HEADING.exec(line)!;
      const Tag = HEADING_TAG[hashes.length - 1];
      // The title text goes through the same safe inline as a paragraph (links only via safeHref).
      blocks.push(<Tag key={k} style={{ ...headingStyle, fontSize: HEADING_SIZE[hashes.length - 1] }}>{inline(headingText(body), k)}</Tag>);
      i++;
    } else if (LIST.test(line)) {
      const ordered = ORDERED.test(line);
      const items: React.ReactNode[] = [];
      while (i < lines.length && LIST.test(lines[i])) {
        items.push(<li key={items.length}>{inline(LIST.exec(lines[i])![1], `${k}.${items.length}`)}</li>);
        i++;
      }
      blocks.push(ordered
        ? <ol key={k} style={{ paddingLeft: 20, listStyle: "decimal" }}>{items}</ol>
        : <ul key={k} style={{ paddingLeft: 20, listStyle: "disc" }}>{items}</ul>);
    } else if (/^\s*>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push(
        <blockquote key={k} style={{ borderLeft: "3px solid var(--color-border)", paddingLeft: 8, color: "var(--color-muted-foreground)", whiteSpace: "pre-wrap" }}>
          {inline(q.join("\n"), k)}
        </blockquote>);
    } else {
      const p: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|>)/.test(lines[i]) && !LIST.test(lines[i]) && !HEADING.test(lines[i])) p.push(lines[i++]);
      blocks.push(<p key={k} style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{inline(p.join("\n"), k)}</p>);
    }
  }
  if (truncated) blocks.push(<p key="trunc" style={{ color: "var(--color-muted-foreground)" }}>{t("textTruncated")}</p>);
  return <div className="luve-md" style={{ overflowWrap: "anywhere" }}>{blocks}</div>;
}
