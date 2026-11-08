// dashboard/src/voice/RadioButton.tsx
// The Radio button in the composer (paginas-ui §9): hold to talk, release to send, drag out to cancel; Space or Enter held
// does the same; a quick tap switches to "toque para começar e toque para parar" for whoever cannot hold. The microphone is asked
// only here, on the gesture.
import React from "react";
import { useLuveI18n } from "../i18n";
import { MicIcon } from "../components/Icons";
import { unlockAudio } from "./speak";

const TAP_MS = 400;   // a press shorter than this is a tap: recording goes on until the next tap

type Radio = { phase: string; begin: () => Promise<void> | void; send: () => void; cancel: () => void };

export function RadioButton({ radio, disabled, reason, onTapMode }: { radio: Radio; disabled: boolean; reason?: string; onTapMode: (on: boolean) => void }) {
  const { t } = useLuveI18n();
  const pressed = React.useRef<number | null>(null);
  const tapMode = React.useRef(false);
  const button = React.useRef<HTMLButtonElement>(null);
  const live = radio.phase === "starting" || radio.phase === "recording";

  const press = () => {
    if (disabled) return;
    if (tapMode.current && live) { tapMode.current = false; onTapMode(false); unlockAudio(); radio.send(); pressed.current = null; return; }  // the second tap
    pressed.current = Date.now();
    void radio.begin();
  };
  const release = (inside: boolean) => {
    if (pressed.current === null) return;
    const held = Date.now() - pressed.current;
    pressed.current = null;
    if (!inside) { tapMode.current = false; onTapMode(false); radio.cancel(); return; }   // dragged out: cancelled before any upload
    if (held < TAP_MS) { tapMode.current = true; onTapMode(true); return; }               // a tap: keep recording until the next one
    unlockAudio();   // the release is the gesture that lets the spoken reply play later
    radio.send();
  };
  const insideOf = (x: number, y: number) => {
    const r = button.current?.getBoundingClientRect();
    return !r || (r.width === 0 && r.height === 0) || (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  };

  return (
    <button ref={button} type="button" className="lb-icon-btn" disabled={disabled} aria-label={t("radioLabel")} title={reason ?? t("radioLabel")}
      aria-pressed={live} data-testid="radio-button"
      onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); press(); }}
      onPointerUp={(e) => release(insideOf(e.clientX, e.clientY))}
      onPointerCancel={() => { if (pressed.current !== null) { pressed.current = null; radio.cancel(); } }}
      onKeyDown={(e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); press(); } }}
      onKeyUp={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); release(true); } }}
      onClick={(e) => e.preventDefault()}
      style={{ width: 40, height: 40, flexShrink: 0, touchAction: "none", ...(live ? { color: "#fff", background: "var(--color-destructive)" } : {}) }}>
      <MicIcon size={18} />
    </button>
  );
}
