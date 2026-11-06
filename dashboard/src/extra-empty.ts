// dashboard/src/extra-empty.ts
// The neutral extension point for extra screens (`@luvebot/extra`, scripts/bundle-options.js). The public build resolves it here:
// no extra screen at all. Each entry will be drawn by the navigation like the other screens, and only while GET /health reports
// `features[feature]` (wired with the first screen). Nothing here names any particular screen.
import type React from "react";
import type { NewsItem } from "./whatsnew/types";

export interface ExtraScreen {
  id: string;
  /** the screen's own words, in the person's language (each screen keeps its own dictionary) */
  label: (locale: "pt" | "en") => string;
  icon: React.ComponentType<{ size?: number }>;
  /** the key of GET /health `features` that must be present for the screen to show */
  feature: string;
  Component: React.ComponentType;
}

export const extraScreens: readonly ExtraScreen[] = [];

/** The words of a tool result that a private mask replaced (`kind`: what the server says happened, `read` or `hidden`), in the person's language, with the way to say a size: none in the public build (no mask exists there). */
export const maskWords = (_kind: string, _locale: "pt" | "en"): { text: string; size: (n: number) => string } | null => null;

/** The items of "Novidades" that only a private build carries (each bound to its screen's `feature`): none in the public build. */
export const extraNews: readonly NewsItem[] = [];
