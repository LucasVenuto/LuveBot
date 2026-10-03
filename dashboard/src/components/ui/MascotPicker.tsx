// dashboard/src/components/ui/MascotPicker.tsx
// Pick a Bot's face from the 15 mascots (Cue: a character with personality). Choosing is a click, never automatic.

import React from "react";
import { useLuveI18n } from "../../i18n";
import { Avatar } from "./Avatar";
import { MASCOTS } from "./mascots";

export function MascotPicker({ value, onPick, color }: { value?: string | null; onPick: (id: string) => void; color?: string | null }) {
  const { t } = useLuveI18n();
  return (
    <div role="group" aria-label={t("mascotPickerLabel")} className="lb-mascot-grid">
      {MASCOTS.map((m) => (
        <button key={m.id} type="button" aria-pressed={value === m.id} aria-label={m.name} title={m.name}
          onClick={() => onPick(m.id)} className="lb-mascot-pick">
          <Avatar name={m.name} avatar={{ kind: "mascot", value: m.id }} color={color} size={40} />
        </button>
      ))}
    </div>
  );
}
