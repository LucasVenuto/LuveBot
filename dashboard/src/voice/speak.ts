// dashboard/src/voice/speak.ts
// A Bot's reply spoken with its own TTS provider (POST /bots/{bot}/voice/speak, contract v0.7 2.2): the bytes play from a blob:
// URL in one <audio> element, revoked when they end, fail, or the next reply starts. The element is created during the person's
// gesture (unlockAudio), so a phone lets it play when the reply arrives seconds later.
import { speakVoice } from "../api/client";

let player: HTMLAudioElement | null = null;
let current: string | null = null;

const release = () => { if (current) { URL.revokeObjectURL(current); current = null; } };

/** Called inside the gesture (the Radio release, the "Ouvir" click): makes the one player and lets it play later. */
export function unlockAudio(): void {
  if (typeof Audio === "undefined") return;
  player ??= new Audio();
  try { void player.play()?.catch?.(() => {}); } catch { /* no source yet: only the gesture mattered */ }
}

export function stopSpeaking(): void {
  if (player) { player.pause(); player.removeAttribute("src"); }
  release();
}

/** Speaks `text` (at most 4,000 characters: the route's limit) in the Bot's voice. Rejects with the route's ApiError. */
export async function speak(bot: string, text: string): Promise<void> {
  const audio = await speakVoice(bot, text.slice(0, 4000));
  stopSpeaking();
  player ??= new Audio();
  current = URL.createObjectURL(audio);
  player.src = current;
  player.onended = release;
  player.onerror = release;
  await player.play();
}
