// dashboard/src/lib/botSuggestion.ts
// The Bot's suggestion of another Bot (contract v0.8 §5; spec 4.6): ONE marker on its own line,
//   [luvebot:sugerir-bot nome="Cobrança" papel="Cobra faturas vencidas"]
// A WELL-FORMED marker becomes a card; anything else stays text. It is agent output, so it is data, never an instruction: exactly
// these two attributes in this order, plain text (no quote, backslash, angle bracket or control character, so no HTML), `nome` up to 40
// characters and `papel` up to 160, no link scheme, not inside a code fence, and not more than a few per message. Nothing is created by it.

export const NAME_MAX = 40, ROLE_MAX = 160, CARDS_MAX = 3;
// Plain text only: no quote, backslash or angle bracket, no C0/C1 control, no line or paragraph separator and no formatting character (\p{Cf}: the
// right-to-left override U+202E, the isolates U+2066-2069, zero-width U+200B-200F, the BOM) that could reverse or hide a name on the card (red team B2).
const PLAIN = '[^"\\\\<>\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\p{Cf}]+';
const MARKER = new RegExp(`^\\[luvebot:sugerir-bot nome="(${PLAIN})" papel="(${PLAIN})"\\]$`, "u");
const SCHEME = /\b(javascript|vbscript|data):/i;

export interface BotSuggestion { name: string; role: string }
export type Segment = { kind: "text"; text: string } | { kind: "bot"; suggestion: BotSuggestion };

/** The marker of one line, or null (malformed, too long, a link scheme, empty). */
export function parseMarker(line: string): BotSuggestion | null {
  const m = MARKER.exec(line.trim());
  if (!m) return null;
  const name = m[1].trim(), role = m[2].trim();
  if (!name || !role || name.length > NAME_MAX || role.length > ROLE_MAX || SCHEME.test(name) || SCHEME.test(role)) return null;
  return { name, role };
}

/** A message as text and cards. A message with no marker comes back whole (the usual case costs one `includes`). */
export function splitBotSuggestions(text: string, max = CARDS_MAX): Segment[] {
  if (!text.includes("[luvebot:sugerir-bot")) return [{ kind: "text", text }];
  const out: Segment[] = [];
  let buffer: string[] = [], fence: { ch: string; len: number } | null = null, cards = 0;
  const flush = () => { const chunk = buffer.join("\n"); if (chunk.trim()) out.push({ kind: "text", text: chunk }); buffer = []; };
  for (const line of text.split("\n")) {
    // a fence closes only with the same character, at least as long as the one that opened it, and nothing else on the line (as the renderer reads it):
    // a ``` line inside a ```` fence is code, and a marker in it stays code (red team B2)
    const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) { if (f && f[1][0] === fence.ch && f[1].length >= fence.len && !f[2].trim()) fence = null; }
    else if (f) fence = { ch: f[1][0], len: f[1].length };
    const found = !fence && cards < max ? parseMarker(line) : null;
    if (found) { flush(); out.push({ kind: "bot", suggestion: found }); cards++; } else buffer.push(line);
  }
  flush();
  return out;
}

/** A profile name for the new Bot from its display name ("Cobrança" → "cobranca"); "" when nothing usable is left. */
export function profileNameOf(display: string): string {
  const slug = display.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug) ? slug : "";
}
