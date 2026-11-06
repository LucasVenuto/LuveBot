// dashboard/src/components/ui/mascots.ts
// The 15 Luve mascots a Bot can wear as its face (T8.3). The list is fixed and fails closed: an id that is not
// here is never turned into a URL, so a stored value can only point at a face shipped inside the plugin.
// Source of the art: assets/mascots/<id>.svg, the whole character (no crop), copied to icons/mascots by the build, which
// also makes <id>-mini.svg (the same art without its orbit and ground shadow) for small avatars.

import type { Attention } from "../messenger/attention";
import type { BotAvatar } from "../../api/types";
import { pluginIconUrl } from "../../pwa/register";

export const MASCOTS = [
  { id: "luvi", name: "Luvi" }, { id: "brisa", name: "Brisa" }, { id: "faro", name: "Faro" },
  { id: "pipo", name: "Pipo" }, { id: "nimbo", name: "Nimbo" }, { id: "tinta", name: "Tinta" },
  { id: "rumo", name: "Rumo" }, { id: "vera", name: "Vera" }, { id: "zuca", name: "Zuca" },
  { id: "niquel", name: "Níquel" }, { id: "quadra", name: "Quadra" }, { id: "flora", name: "Flora" },
  { id: "eco", name: "Eco" }, { id: "lacre", name: "Lacre" }, { id: "tico", name: "Tico" },
] as const;

const IDS: ReadonlySet<string> = new Set(MASCOTS.map((m) => m.id));

export const isMascot = (id: string | null | undefined): boolean => !!id && IDS.has(id);

/** Below this size (px) the orbit and the ground shadow are clutter: the mini file leaves them out. */
export const MINI_BELOW = 56;

/** The mascot's URL at a size, with the state the art animates (working, needs you); null for anything off the list. */
export function mascotUrl(id: string | null | undefined, state?: Attention, size = 40): string | null {
  if (!isMascot(id)) return null;
  const frag = state === "working" ? "#lb-working" : state === "needs_you" ? "#lb-needs-you" : "";
  return pluginIconUrl(`mascots/${id}${size < MINI_BELOW ? "-mini" : ""}.svg`) + frag;
}

/** A Bot with no face of its own wears a default mascot picked by a stable hash (FNV-1a) of its profile id: the same Bot
 *  always gets the same face, it never changes on its own, and nothing is stored. "No face of its own" = no avatar, or the
 *  backend's default initials of the id (backend/bot_meta.py default_display). A chosen mascot, emoji or other initials win.
 *  ponytail: the hash indexes this fixed list; adding a mascot to MASCOTS changes default faces, append-only keeps most. */
export function defaultMascot(bot: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bot.length; i++) h = Math.imul(h ^ bot.charCodeAt(i), 0x01000193) >>> 0;
  return MASCOTS[h % MASCOTS.length].id;
}

export function displayFace(bot: string, avatar?: BotAvatar | null): BotAvatar {
  const unset = !avatar || !avatar.value || (avatar.kind === "initials" && avatar.value === bot.slice(0, 2).toUpperCase());
  return unset ? { kind: "mascot", value: defaultMascot(bot) } : avatar;
}

/** Applied where Bots enter the app for display (the list, the map), never to the profile form, so saving writes nothing new. */
export function withDefaultFace<T extends { name: string; display?: { avatar?: BotAvatar | null } }>(b: T): T {
  if (!b.display) return b;
  const avatar = displayFace(b.name, b.display.avatar);
  return avatar === b.display.avatar ? b : { ...b, display: { ...b.display, avatar } };
}
