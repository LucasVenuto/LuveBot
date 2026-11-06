// dashboard/src/hooks/useLiveRefresh.ts
// Keeps what the sidebar shows (Bot states, the "!" of a pending approval) current without a reload: `refresh` runs
// every `everyMs` while the tab is visible, and once as soon as the tab comes back. A hidden tab asks nothing, unless
// `whileHidden()` says so (the sounds are on): then once every HIDDEN_REFRESH_MS, so a Bot that needs you can still be heard.

import React from "react";

export const LIVE_REFRESH_MS = 15_000;
export const HIDDEN_REFRESH_MS = 60_000;  // browsers throttle hidden timers to about once a minute anyway

export function useLiveRefresh(refresh: () => void, everyMs = LIVE_REFRESH_MS, whileHidden?: () => boolean): void {
  const latest = React.useRef(refresh);
  latest.current = refresh;
  const hiddenOk = React.useRef(whileHidden);
  hiddenOk.current = whileHidden;
  React.useEffect(() => {
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const tick = () => { if (visible()) latest.current(); };
    const hiddenTick = () => { if (!visible() && hiddenOk.current?.()) latest.current(); };
    const id = window.setInterval(tick, everyMs);
    const hiddenId = window.setInterval(hiddenTick, HIDDEN_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(id); window.clearInterval(hiddenId); document.removeEventListener("visibilitychange", tick); };
  }, [everyMs]);
}
