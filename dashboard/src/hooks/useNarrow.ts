// dashboard/src/hooks/useNarrow.ts
// Phone width (spec 4.16): panels become sheets instead of columns. No matchMedia (tests, old browsers) = wide.

import React from "react";

export const NARROW = "(max-width: 767px)";

export function useNarrow(): boolean {
  const mq = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(NARROW) : null);
  const [narrow, setNarrow] = React.useState(() => mq()?.matches ?? false);
  React.useEffect(() => {
    const m = mq();
    if (!m) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return narrow;
}
