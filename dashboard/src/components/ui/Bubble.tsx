// dashboard/src/components/ui/Bubble.tsx
// A chat bubble (Dots/Cue): yours on the right in the Bot's accent, the Bot's on the left in a neutral tone.
// The bubble is only a frame: it never renders text itself. Agent content goes in as <Markdown> or plain text.

import React from "react";
import { botColor, readableOn } from "./color";

export interface BubbleProps {
  side: "me" | "bot";
  color?: string | null;   // the Bot's accent: fills "me" bubbles, names the author in groups
  author?: string;         // shown above a Bot bubble (rooms with several Bots)
  meta?: React.ReactNode;  // time, "read" receipt; shown under the bubble
  children: React.ReactNode;
}

export function Bubble({ side, color, author, meta, children }: BubbleProps) {
  const me = side === "me";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: me ? "flex-end" : "flex-start", margin: "6px 0" }}>
      {author && !me && <div style={{ fontSize: 12, fontWeight: 600, color: botColor(color), margin: "0 0 2px 12px" }}>{author}</div>}
      <div style={{
        maxWidth: "min(75%, 640px)", padding: "10px 14px", borderRadius: 20,
        [me ? "borderBottomRightRadius" : "borderBottomLeftRadius"]: 6,
        background: me ? botColor(color) : "var(--color-muted)",
        color: me ? readableOn(color) : "var(--color-foreground)",
        fontSize: 15, lineHeight: 1.45, whiteSpace: me ? "pre-wrap" : undefined, overflowWrap: "anywhere",
      }}>
        {children}
      </div>
      {meta && <div style={{ fontSize: 12, color: "var(--color-muted-foreground)", margin: "3px 8px 0" }}>{meta}</div>}
    </div>
  );
}
