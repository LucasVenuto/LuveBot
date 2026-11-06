// dashboard/src/components/search/HighlightedSnippet.tsx
// Safe search snippet renderer that highlights query terms WITHOUT raw HTML.

import React from "react";

export interface HighlightedSnippetProps {
  text: string;
  query?: string;
  className?: string;
}

export function HighlightedSnippet({
  text,
  query,
  className = "",
}: HighlightedSnippetProps) {
  if (!text) return null;
  if (!query || !query.trim()) {
    return <span className={className}>{text}</span>;
  }

  const trimmed = query.trim();
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);

  return (
    <span className={className}>
      {parts.map((part, idx) => {
        if (part.toLowerCase() === trimmed.toLowerCase()) {
          return (
            <mark
              key={idx}
              className="lb:bg-[var(--color-warning)]/30 lb:text-[var(--color-card-foreground)] lb:font-medium lb:px-0.5 lb:rounded-xs"
            >
              {part}
            </mark>
          );
        }
        return <React.Fragment key={idx}>{part}</React.Fragment>;
      })}
    </span>
  );
}
