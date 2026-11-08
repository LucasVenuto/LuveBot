// dashboard/src/components/ui/EmptyArt.tsx
// The art of an empty state (a family character and a few objects, made by assets/mascots/build.mjs). It takes the place of
// the 40 px icon circle in the three empty states that have art. The list is fixed and fails closed: a kind not here draws
// nothing, so a value can only ever point at a file shipped inside the plugin. Decorative: the title next to it says it all.

import React from "react";
import { pluginIconUrl } from "../../pwa/register";

export const EMPTY_ART_KINDS = ["memory", "timeline", "suggestions"] as const;
export type EmptyArtKind = (typeof EMPTY_ART_KINDS)[number];

export function EmptyArt({ kind }: { kind: EmptyArtKind }) {
  if (!(EMPTY_ART_KINDS as readonly string[]).includes(kind)) return null;
  return <img className="lb-empty-art" src={pluginIconUrl(`empty/${kind}.svg`)} alt="" aria-hidden="true" width={144} height={96} referrerPolicy="no-referrer" />;
}
