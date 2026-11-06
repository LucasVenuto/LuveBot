// dashboard/src/hooks/useWidth.ts
// The width of an element, kept up to date (ResizeObserver), or null while it cannot be known: no layout (tests, an old browser) or a box that is not drawn (width 0). "Unknown" is never read as "narrow".

import React from "react";

export function useWidth(ref: React.RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const take = (w: number) => setWidth(w > 0 ? w : null);
    take(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver((entries) => take(entries[0]?.contentRect.width ?? 0));
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref]);
  return width;
}
