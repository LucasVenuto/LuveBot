// dashboard/src/components/ui/ThemePicker.tsx
// LuveBot's own light/dark choice (Automático, Claro, Escuro), kept per browser (hooks/useHost.ts useScheme). It never
// touches the Hermes theme (D-023). A button opens a radio group: arrows move the choice, Esc closes and returns focus.

import React from "react";
import { useLuveI18n } from "../../i18n";
import type { SchemePref } from "../../hooks/useHost";
import { ContrastIcon } from "../Icons";

const OPTIONS: Array<[SchemePref, "themeAuto" | "themeLight" | "themeDark"]> = [["auto", "themeAuto"], ["light", "themeLight"], ["dark", "themeDark"]];

export function ThemePicker({ pref, onChange, className, placement = "right" }: { pref: SchemePref; onChange: (p: SchemePref) => void; className: string; placement?: "right" | "below" }) {
  const { t } = useLuveI18n();
  const [open, setOpen] = React.useState(false);
  const button = React.useRef<HTMLButtonElement>(null);
  const group = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  const current = OPTIONS.find(([p]) => p === pref)!;
  const label = `${t("themeLabel")}: ${t(current[1])}`;

  React.useEffect(() => {
    if (!open) return;
    group.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const away = (e: PointerEvent) => { if (!group.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const close = () => { setOpen(false); button.current?.focus(); };
  const onKey = (e: React.KeyboardEvent) => {
    const at = OPTIONS.findIndex(([p]) => p === pref);
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (!step) return;
    e.preventDefault();
    const next = OPTIONS[(at + step + OPTIONS.length) % OPTIONS.length][0];
    onChange(next);
    requestAnimationFrame(() => group.current?.querySelector<HTMLElement>(`[data-pref="${next}"]`)?.focus());
  };

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button ref={button} type="button" className={className} aria-label={label} title={label} aria-haspopup="true" aria-expanded={open}
        aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
        <ContrastIcon size={20} />
      </button>
      {open && (
        <div ref={group} id={id} role="radiogroup" aria-label={t("themeLabel")} className={`lb-theme-pop lb-theme-pop-${placement}`} onKeyDown={onKey}>
          {OPTIONS.map(([p, key]) => (
            <button key={p} type="button" role="radio" aria-checked={pref === p} data-pref={p} tabIndex={pref === p ? 0 : -1}
              className="lb-msg-menu-item" onClick={() => { onChange(p); close(); }}>
              <span className="lb-headline">{t(key)}</span>
              {p === "auto" && <span className="lb-caption">{t("themeAutoHint")}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
