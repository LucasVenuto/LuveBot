// Component page (Lume's method): the REAL LuveStudio and Avatar of dashboard/src mounted in a real Chrome, no backend. React is bundled
// here only for the test. The page only records what the studio hands out (onUse/onClose) and draws one Avatar per size/state.
import * as React from "react";
import { createRoot } from "react-dom/client";
import { LuveStudio } from "@repo/dashboard/src/components/ui/LuveStudio";
import { Avatar } from "@repo/dashboard/src/components/ui/Avatar";
import { liveLuveUrls, parseLuve, formatLuve, KIT, SHAPES, MATERIAL_IDS, ACCESSORY_IDS } from "@repo/dashboard/src/components/ui/luve";
import { buildLuveSvg as build } from "@repo/assets/mascots/luve.mjs";

const H: any = { used: [] as string[], closed: 0 };
(window as any).H = H;
(window as any).__luve = { KIT, SHAPES, MATERIAL_IDS, ACCESSORY_IDS, formatLuve, parseLuve, expectSvg: (v: string, state?: string, mini?: boolean) => build(parseLuve(v), state, !!mini), liveLuveUrls };

function App() {
  const [open, setOpen] = React.useState(true);
  const [face, setFace] = React.useState<string | null>(null);
  H.reopen = () => setOpen(true);
  const scheme = new URLSearchParams(location.search).get("scheme") === "dark" ? "dark" : "light";   // the app's own wrapper (host/overlay.tsx)
  return (
    <div className="lb-root" data-lb-scheme={scheme} style={{ padding: 16, display: "grid", gap: 12, alignContent: "start" }}>
      <button id="reopen" className="lb-btn" onClick={() => setOpen(true)}>abrir o estúdio</button>
      {face && (
        <div id="faces" style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {[24, 40, 64, 96].map((s) => <Avatar key={s} name="vendas" size={s} avatar={{ kind: "luve", value: face }} />)}
          <Avatar name="vendas" size={40} attention="working" avatar={{ kind: "luve", value: face }} />
          <Avatar name="vendas" size={40} attention="needs_you" avatar={{ kind: "luve", value: face }} />
        </div>
      )}
      <LuveStudio open={open} onClose={() => { H.closed++; setOpen(false); }} onUse={(v) => { H.used.push(v); setFace(v); setOpen(false); }} useLabel="Usar em vendas" />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
