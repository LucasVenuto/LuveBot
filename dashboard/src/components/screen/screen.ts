// dashboard/src/components/screen/screen.ts
// Pure decisions of the Screen tab (D-007 §2 and §4): what Hermes's own status means for the person, and what to do when the
// display socket closes. Hermes's words (missing packages, install command, blocker) are shown as text, never run.

import type { BotScreen } from "../../api/types";

export type ScreenState =
  | { kind: "unsupported" }
  | { kind: "not_installed"; missing: string[]; installCommand: string | null }
  | { kind: "no_memory"; availableMb: number | null; neededMb: number | null; blocker: string | null }
  | { kind: "sandbox"; placement: string }
  | { kind: "stopped" }
  | { kind: "running" };

export function screenState(s: BotScreen): ScreenState {
  if (!s.supported) return { kind: "unsupported" };
  if (!s.installed) return { kind: "not_installed", missing: s.missing ?? [], installCommand: s.install_command ?? null };
  if (s.placement && s.placement.startsWith("terminal:")) return { kind: "sandbox", placement: s.placement };
  if (s.running) return { kind: "running" };
  if (s.blocker) return { kind: "no_memory", availableMb: s.memory?.available_mb ?? null, neededMb: s.memory?.needed_mb ?? null, blocker: s.blocker };
  return { kind: "stopped" };
}

/** Hermes's close codes (display.py _CLOSE_*): 4000 someone took control, 4401 ticket used or expired, 4001 the screen
 *  stopped, 4403 origin refused. Anything else is a dropped link. */
export type CloseOutcome = "taken" | "ticket" | "stopped" | "refused" | "lost";
export function closeOutcome(code: number): CloseOutcome {
  return code === 4000 ? "taken" : code === 4401 ? "ticket" : code === 4001 ? "stopped" : code === 4403 ? "refused" : "lost";
}

/** "Sem imagem há N s" (approved after the WebKit analysis): with the link open, no picture yet N s after connecting, or
 *  data came in and no new picture followed for N s. That is how noVNC 1.7.0 looks when its render queue stalls on an image
 *  it cannot decode (vendored display.js:516-522, left untouched). A still screen sends nothing, so it never warns.
 *  `since`: connected; `painted`: last change seen on the canvas; `pending`: first message after that change. */
export const NO_IMAGE_S = 10;
export function noImageFor(now: number, w: { since: number; painted: number | null; pending: number | null }, n = NO_IMAGE_S): number | null {
  const from = w.painted === null ? w.since : w.pending;
  if (from === null) return null;
  const s = Math.floor((now - from) / 1000);
  return s >= n ? s : null;
}
