// dashboard/src/hooks/useHost.ts
// How LuveBot sits in the Hermes dashboard (docs/propostas/shell-real-hermes.md). Full screen is the `overlay` slot
// (host/overlay.tsx), which covers the Hermes frame, so the scheme is LuveBot's own: the person picks Automático, Claro or
// Escuro (ThemePicker), kept per browser; Automático follows the system (prefers-color-scheme). The Hermes theme is
// never read or changed (D-023).

import React from "react";

export type Scheme = "light" | "dark";
export type SchemePref = "auto" | Scheme;
export const SCHEME_KEY = "luvebot.scheme";

function readPref(): SchemePref {
  try {
    const v = window.localStorage.getItem(SCHEME_KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";  // storage blocked (private window, policy): the default, never an error
  }
}

const systemDark = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;

export function useScheme(): { scheme: Scheme; pref: SchemePref; setPref: (p: SchemePref) => void } {
  const [pref, setPrefState] = React.useState<SchemePref>(() => (typeof window === "undefined" ? "auto" : readPref()));
  const [dark, setDark] = React.useState<boolean>(systemDark);
  React.useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const on = () => setDark(!!mq?.matches);
    mq?.addEventListener?.("change", on);
    return () => mq?.removeEventListener?.("change", on);
  }, []);
  const setPref = React.useCallback((p: SchemePref) => {
    setPrefState(p);
    try {
      if (p === "auto") window.localStorage.removeItem(SCHEME_KEY); else window.localStorage.setItem(SCHEME_KEY, p);
    } catch { /* not kept in this browser; the choice still applies now */ }
  }, []);
  const scheme: Scheme = pref === "auto" ? (dark ? "dark" : "light") : pref;
  return { scheme, pref, setPref };
}

/** In-app navigation inside the Hermes router (react-router listens to popstate); the profile query is kept. */
export function navigateHost(path: string): void {
  window.history.pushState(null, "", path + window.location.search);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
