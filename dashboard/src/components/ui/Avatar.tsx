// dashboard/src/components/ui/Avatar.tsx
// A Bot's face (Cue/Dots: a character with personality, on a soft tint of the Bot's accent).
// Decorative: the name is always written next to it, so the avatar is hidden from screen readers.
// A mascot is drawn only from the fixed list of faces shipped in the plugin (contract §14), a Luve only from its checked recipe
// (ui/luve.ts; a recipe that does not check shows the default mascot), a person's own image only through ui/avatarImage.ts (the id of a PNG LuveBot
// stored, fetched with the session and checked; until it is there, and if it cannot be read, the initials). Nothing is ever loaded from an external URL
// (A-54: that would be a tracking pixel); a legacy `image` row (any value that is not such an id) and anything else fall back to initials.

import React from "react";
import type { BotAvatar } from "../../api/types";
import { botColor, tint } from "./color";
import { defaultMascot, mascotUrl, MINI_BELOW } from "./mascots";
import { isLuve, useLuveSrc } from "./luve";
import { isImageId, useImageSrc } from "./avatarImage";
import type { Attention } from "../messenger/attention";

export interface AvatarProps {
  name: string;
  avatar?: BotAvatar | null;
  color?: string | null;
  size?: number;      // px, default 40
  ring?: boolean;     // accent ring, for the selected contact or the conversation header
  attention?: Attention; // a mascot face animates "working" and "needs you"
}

const initialsOf = (s: string) => Array.from(s.trim()).slice(0, 2).join("").toUpperCase() || "?";

export function Avatar({ name, avatar, color, size = 40, ring = false, attention }: AvatarProps) {
  const accent = botColor(color);
  const state = attention === "working" ? "working" : attention === "needs_you" ? "needs_you" : undefined;
  const luve = avatar?.kind === "luve" ? (isLuve(avatar.value) ? avatar.value : null) : undefined;  // null: a recipe that does not check
  const luveSrc = useLuveSrc(luve, state, size < MINI_BELOW);
  const imageSrc = useImageSrc(avatar?.kind === "image" && isImageId(avatar.value) ? avatar.value : null);
  const mascot = avatar?.kind === "mascot" ? mascotUrl(avatar.value, attention, size) : null;   // null: not on the list, so initials
  const drawn = mascot !== null || luve !== undefined;   // a whole character, even before the Luve's URL is ready
  const src = mascot ?? (luve === null ? mascotUrl(defaultMascot(name), attention, size) : luveSrc);
  // A mascot is the whole character, loose: no tinted square, no clipping, no square ring. Selection is a soft contour
  // in the accent around the drawing itself. Initials and emoji keep the tinted square.
  const box: React.CSSProperties = drawn ? {
    width: size, height: size, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", userSelect: "none",
  } : {
    width: size, height: size, flexShrink: 0, borderRadius: "36%", overflow: "hidden",
    display: "inline-flex", alignItems: "center", justifyContent: "center", userSelect: "none",
    background: tint(color, 18), color: accent,
    boxShadow: ring ? `0 0 0 2px var(--color-background, #fff), 0 0 0 4px ${accent}` : undefined,
  };
  let face: React.ReactNode;
  if (drawn) face = src && <img src={src} alt="" referrerPolicy="no-referrer" width={size} height={size} style={{ objectFit: "contain", width: "100%", height: "100%", ...(ring ? { filter: `drop-shadow(0 0 1px ${accent}) drop-shadow(0 0 1.5px ${accent})` } : {}) }} />;
  else if (imageSrc) face = <img src={imageSrc} alt="" referrerPolicy="no-referrer" width={size} height={size} draggable={false} style={{ objectFit: "cover", width: "100%", height: "100%" }} />;
  else if (avatar?.kind === "emoji" && avatar.value) face = <span style={{ fontSize: size * 0.58, lineHeight: 1 }}>{avatar.value}</span>;
  else face = <span style={{ fontSize: size * 0.38, fontWeight: 700, letterSpacing: "-0.02em" }}>{initialsOf(avatar?.kind === "initials" ? avatar.value : name)}</span>;
  return <span aria-hidden="true" style={box}>{face}</span>;
}
