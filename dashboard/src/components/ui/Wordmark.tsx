// dashboard/src/components/ui/Wordmark.tsx
// The LuveBot wordmark (the Luvi mark + the name) at the top of the sidebar. Two files ship in the plugin's
// own icons folder: dark letters for a light surface, white letters for a dark one. The surface is LuveBot's own
// root palette, so the choice follows the root's scheme (hooks/useHost.ts), never a guess from a painted color.

import React from "react";
import { pluginIconUrl } from "../../pwa/register";
import type { Scheme } from "../../hooks/useHost";

export function Wordmark({ scheme, height = 36 }: { scheme: Scheme; height?: number }) {
  return (
    <img src={pluginIconUrl(scheme === "dark" ? "luvebot-wordmark-white.svg" : "luvebot-wordmark.svg")}
      alt="LuveBot" height={height} style={{ display: "block", height, width: "auto" }} />
  );
}
