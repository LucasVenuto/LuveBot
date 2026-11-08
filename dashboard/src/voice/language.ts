// dashboard/src/voice/language.ts
// The voice language of a Bot (docs/contracts/voice-language-reactions-v0.md section 2, VL-2). Three small things the Voice card, the line under the Radio and the Settings action share:
// reading what the server says (only what it said, never a guess), the ONE test of "this Bot's transcription has no language set" (the RAW `stt.language` is empty: never `language === "auto"`, never `other`: a value the person set
// in Hermes is not ours to propose over, A-281), and the loop that applies the screen's language to every Bot (the screen's own loop of the same PUT, one Bot at a time; no bulk route exists).
import { getVoice, putVoiceLanguage } from "../api/client";
import type { Bot, VoiceLanguage, VoiceSettings } from "../api/types";

const WORDS = new Set(["auto", "pt", "en", "other"]);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The settings of a voice status (or of the PUT's answer), or null when the answer does not have the shape: a server older than VL-1, or something this screen would be guessing at. */
export function readVoiceSettings(raw: unknown): VoiceSettings | null {
  const r = (raw && typeof raw === "object" && "settings" in raw ? (raw as { settings: unknown }).settings : raw) as Partial<VoiceSettings> | null;
  if (!r || typeof r !== "object" || !r.stt || typeof r.stt !== "object" || !r.tts || typeof r.tts !== "object") return null;
  if (typeof r.language !== "string" || !WORDS.has(r.language)) return null;
  const stt = r.stt as Partial<VoiceSettings["stt"]>, tts = r.tts as Partial<VoiceSettings["tts"]>;
  if (stt.language !== null && stt.language !== undefined && typeof stt.language !== "string") return null;
  return { stt: { provider: text(stt.provider), language: stt.language ?? null }, tts: { provider: text(tts.provider), voice: text(tts.voice) }, language: r.language as VoiceSettings["language"] };
}

/** True only when the server said the raw `stt.language` is empty (A-281): the one case where the Radio's line proposes the screen's language. `auto` and `other` alone never do. */
export const sttLanguageEmpty = (s: VoiceSettings | null | undefined): boolean => !!s && (s.stt.language === null || s.stt.language.trim() === "");

export interface ApplyAllResult { applied: string[]; already: string[]; kept: string[]; failed: string[]; total: number }
export interface ApplyAllHooks {
  onRead?: (done: number, total: number) => void;       // while the Bots' status is read, one at a time
  onPlan?: (plan: { change: number; stay: number }) => void;   // ONCE, after every status was read and BEFORE the first write
  onStep?: (done: number, total: number) => void;       // while the writes run, one at a time
}

/** The screen's language on every Bot (A-281, A-282): the screen's own loop of the same PUT, one Bot at a time, no bulk route. First every Bot's status is READ; then `onPlan` says how many will change and how many stay (the click may turn
 *  `en` into `pt` on a Bot someone set on purpose: it is said before the first write). A Bot already in the language is not written (no empty audit row) and is named; a Bot whose language the person set in Hermes outside pt/en (`other`)
 *  is left as it is and named; a Bot whose status cannot be read is a failure and is NEVER written blind. A write that fails stops nobody and nothing already written is undone. The window between the read and the PUT is accepted:
 *  the audit row's `before` says what was there. */
export async function applyLanguageToAll(bots: readonly Pick<Bot, "name">[], language: VoiceLanguage, hooks: ApplyAllHooks = {}): Promise<ApplyAllResult> {
  const out: ApplyAllResult = { applied: [], already: [], kept: [], failed: [], total: bots.length };
  const change: string[] = [];
  let read = 0;
  for (const { name } of bots) {
    try {
      const now = readVoiceSettings(await getVoice(name));
      if (!now) out.failed.push(name);
      else if (now.language === "other") out.kept.push(name);
      else if (now.language === language) out.already.push(name);
      else change.push(name);
    } catch {
      out.failed.push(name);
    }
    hooks.onRead?.(++read, bots.length);
  }
  hooks.onPlan?.({ change: change.length, stay: out.kept.length + out.already.length });
  let done = 0;
  for (const name of change) {
    try { await putVoiceLanguage(name, language); out.applied.push(name); } catch { out.failed.push(name); }
    hooks.onStep?.(++done, change.length);
  }
  return out;
}
