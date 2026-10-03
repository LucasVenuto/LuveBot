// dashboard/src/components/ui/Avatar.tsx
// A Bot's face (Cue/Dots: a character with personality, on a soft tint of the Bot's accent).
// Decorative: the name is always written next to it, so the avatar is hidden from screen readers.
// A mascot is drawn only from the fixed list of faces shipped in the plugin (contract §14). Nothing is ever
// loaded from an external URL (A-54: that would be a tracking pixel); `image` and anything else fall back to initials.

import React from "react";
import type { BotAvatar } from "../../api/types";
import { botColor, tint } from "./color";
import { mascotUrl } from "./mascots";
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
  const src = avatar?.kind === "mascot" ? mascotUrl(avatar.value, attention, size) : null;
  // A mascot is the whole character, loose: no tinted square, no clipping, no square ring. Selection is a soft contour
  // in the accent around the drawing itself. Initials and emoji keep the tinted square.
  const box: React.CSSProperties = src ? {
    width: size, height: size, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", userSelect: "none",
  } : {
    width: size, height: size, flexShrink: 0, borderRadius: "36%", overflow: "hidden",
    display: "inline-flex", alignItems: "center", justifyContent: "center", userSelect: "none",
    background: tint(color, 18), color: accent,
    boxShadow: ring ? `0 0 0 2px var(--color-background, #fff), 0 0 0 4px ${accent}` : undefined,
  };
  let face: React.ReactNode;
  if (src) face = <img src={src} alt="" referrerPolicy="no-referrer" width={size} height={size} style={{ objectFit: "contain", width: "100%", height: "100%", ...(ring ? { filter: `drop-shadow(0 0 1px ${accent}) drop-shadow(0 0 1.5px ${accent})` } : {}) }} />;
  else if (avatar?.kind === "emoji" && avatar.value) face = <span style={{ fontSize: size * 0.58, lineHeight: 1 }}>{avatar.value}</span>;
  else face = <span style={{ fontSize: size * 0.38, fontWeight: 700, letterSpacing: "-0.02em" }}>{initialsOf(avatar?.kind === "initials" ? avatar.value : name)}</span>;
  return <span aria-hidden="true" style={box}>{face}</span>;
}
