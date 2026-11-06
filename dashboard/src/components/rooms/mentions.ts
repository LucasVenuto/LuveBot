// dashboard/src/components/rooms/mentions.ts
// Pure @-mention helpers for rooms (spec 4.4, red team 10). Suggestions come ONLY from the room's members:
// a Bot outside the room is never offered. The backend still refuses a non-member @ on its own.

import type { RoomMember } from "../../api/types";

const ALL = ["todos", "all", "everyone"];

/** The @-token being typed right before the cursor, or null. */
export function mentionAt(text: string, cursor: number): { query: string; start: number } | null {
  const m = text.slice(0, cursor).match(/@([a-zA-Z0-9._:-]*)$/);
  return m && m.index !== undefined ? { query: m[1].toLowerCase(), start: m.index } : null;
}

export const offersAll = (query: string) => ALL.some((w) => w.includes(query));

export const matchingMembers = (members: readonly RoomMember[], query: string) =>
  members.filter((m) => m.handle.toLowerCase().includes(query) || !!m.display_name?.toLowerCase().includes(query));

/** @todos/@all/@everyone or more than one @: the message wakes several Bots and needs a cost confirmation. */
export function isMultiTarget(text: string): boolean {
  const handles = Array.from(text.matchAll(/@([A-Za-z0-9._:-]+)/g)).map((m) => m[1].toLowerCase());
  return handles.some((h) => ALL.includes(h)) || handles.length > 1;
}

/** Replaces the @-token that starts at `start` (up to `cursor`) with `@handle `. */
export function insertMention(text: string, start: number, cursor: number, handle: string): { text: string; caret: number } {
  const before = text.slice(0, start) + `@${handle} `;
  return { text: before + text.slice(cursor), caret: before.length };
}

/** Who a draft goes to, the way the server decides it (`rooms.check_send`): the members named by @handle (a non-member is refused there, so it names no one here),
 *  everyone for @todos/@all/@everyone, and with no @ at all the room's coordinator, or everyone when it has none. */
export function recipientsOf<M extends Pick<RoomMember, "handle">>(text: string, members: readonly M[], coordinator?: string | null): M[] {
  const named = [...new Set(Array.from(text.matchAll(/@([A-Za-z0-9][A-Za-z0-9._:-]*)/g), (m) => m[1].toLowerCase()))];
  const byHandle = new Map(members.map((m) => [m.handle.toLowerCase(), m]));
  const everyone = (h: string) => ALL.includes(h) && !byHandle.has(h);   // a member literally called "todos" (an older room: Hermes allows it) is that member, not everyone
  if (named.some(everyone) || (!named.length && !coordinator)) return [...members];
  if (!named.length) { const lead = byHandle.get(coordinator!.toLowerCase()); return lead ? [lead] : [...members]; }
  return named.flatMap((h) => byHandle.get(h) ?? []);
}
