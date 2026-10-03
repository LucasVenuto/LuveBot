// dashboard/src/components/conversation/MessageMenu.tsx
// Actions of one Bot reply, out of the way until wanted (the CEO found a link under every answer noisy): a "…" button
// that shows on hover or keyboard focus on a desktop and stays visible on touch screens, plus a long press on the reply.
// Keyboard: Tab reaches "…", Enter/Space/ArrowDown open the menu, arrows move, Esc closes and returns focus.

import React from "react";
import { useLuveI18n } from "../../i18n";

export interface MessageMenuItem { label: string; hint: string; onSelect: () => void }

export function MessageMenu({ items, children }: { items: MessageMenuItem[]; children: React.ReactNode }) {
  const { t } = useLuveI18n();
  const [open, setOpen] = React.useState(false);
  const button = React.useRef<HTMLButtonElement>(null);
  const menu = React.useRef<HTMLDivElement>(null);
  const press = React.useRef<number | null>(null);
  const id = React.useId();

  const close = (refocus = true) => { setOpen(false); if (refocus) button.current?.focus(); };
  React.useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node) && e.target !== button.current) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const all = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); all[(at + 1) % all.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); all[(at - 1 + all.length) % all.length]?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };

  // Long press on the reply (touch only): the phone's way to the same menu.
  const cancelPress = () => { if (press.current !== null) { window.clearTimeout(press.current); press.current = null; } };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch") return;
    cancelPress();
    press.current = window.setTimeout(() => { press.current = null; setOpen(true); }, 500);
  };

  return (
    <div className="lb-msg" onPointerDown={onPointerDown} onPointerUp={cancelPress} onPointerMove={cancelPress} onPointerCancel={cancelPress}>
      {children}
      <div className="lb-msg-actions">
        <button ref={button} type="button" className="lb-icon-btn lb-msg-more" aria-label={t("messageMoreActions")} title={t("messageMoreActions")}
          aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); } }}>
          <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1, letterSpacing: 1 }}>…</span>
        </button>
        {open && (
          <div ref={menu} id={id} role="menu" aria-label={t("messageMoreActions")} className="lb-msg-menu" onKeyDown={onMenuKey}>
            {items.map((it, i) => (
              <button key={i} type="button" role="menuitem" tabIndex={-1} className="lb-msg-menu-item" aria-label={it.label} aria-describedby={`${id}-hint-${i}`}
                onClick={() => { close(false); it.onSelect(); }}>
                <span className="lb-headline">{it.label}</span>
                <span id={`${id}-hint-${i}`} className="lb-caption">{it.hint}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
