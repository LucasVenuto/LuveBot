// dashboard/src/components/ui/AvatarStack.tsx
// A few faces side by side (a room's members). Each face gets a ring in the surface color behind it, and they
// overlap by a sixth of their size, so initials stay readable in both themes.

import React from "react";
import type { BotAvatar } from "../../api/types";
import { Avatar } from "./Avatar";

export interface StackFace { key: string; name: string; avatar?: BotAvatar | null; color?: string | null }

export function AvatarStack({ faces, size = 28, max = 3, ring = "var(--color-background)" }: { faces: StackFace[]; size?: number; max?: number; ring?: string }) {
  const shown = faces.slice(0, max);
  return (
    <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
      {shown.map((f, i) => (
        <span key={f.key} style={{ display: "inline-flex", marginLeft: i ? -Math.round(size / 6) : 0, borderRadius: "38%", position: "relative", zIndex: shown.length - i,
          ...(f.avatar?.kind === "mascot" ? {} : { boxShadow: `0 0 0 2px ${ring}` }) }}>
          <Avatar name={f.name} avatar={f.avatar} color={f.color} size={size} />
        </span>
      ))}
    </span>
  );
}
