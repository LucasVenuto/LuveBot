// dashboard/src/components/ui/LuveStudio.tsx
// "Crie seu Luve" (proposal docs/propostas/v02-crie-seu-luve.md §2): four steps (shape, color, material, accessory) with a live 2D
// preview, phone first. What comes out is only the canonical recipe, built by formatLuve from values taken from the kit's fixed
// lists (and a hex that must be 6 lowercase digits); choosing is a click, never automatic, and closing without "use" changes nothing.
// The preview is 3D when dist/luve3d.js loads and WebGL works (drag to turn, double tap for the front), and the 2D art otherwise, at
// any moment. The PNG comes from the 3D canvas, or from the 2D art in plan B.
// Esc and Tab are taken in the capture phase and stopped there: the studio opens over the Bot profile or the Create Bot dialog,
// whose own window listeners would otherwise close or re-trap the screen underneath.

import React from "react";
import { useLuveI18n } from "../../i18n";
import { Avatar } from "./Avatar";
import { Dialog } from "./Dialog";
import { FOCUSABLE_ELEMENTS_SELECTOR } from "../../hooks/useFocusTrap";
import { ACCESSORY_IDS, KIT, MATERIAL_IDS, SHAPES, formatLuve, parseLuve } from "./luve";
import type { LuveRecipe } from "./luve";
import { isMascot } from "./mascots";
import { loadLuve3d } from "../../luve3d/load";
import type { Luve3dView } from "../../luve3d/api";
import { luvePng, pngName, savePng } from "./luvePng";

const STEPS = ["shape", "color", "material", "accessory"] as const;
type Step = typeof STEPS[number];
const STEP_KEY = { shape: "luveStepShape", color: "luveStepColor", material: "luveStepMaterial", accessory: "luveStepAccessory" } as const;
const HEX = /^[0-9a-f]{6}$/;
const SWATCHES: string[] = (KIT.swatches as { base: string }[]).map((s) => s.base.slice(1).toLowerCase());

const swatchOf = (shape: string): string => ((KIT.swatches as { from: string; base: string }[]).find((s) => s.from === shape)?.base ?? `#${SWATCHES[0]}`).slice(1).toLowerCase();
const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];

/** Where the studio starts: the Luve already worn, else the seed mascot's shape in its own color (vinyl, no accessory). */
export function startRecipe(initial: string | null | undefined, seedShape?: string | null): LuveRecipe {
  const worn = parseLuve(initial);
  if (worn) return worn;
  const shape = isMascot(seedShape) && SHAPES.includes(seedShape as string) ? (seedShape as string) : SHAPES[0];
  return { shape, material: "vinil", accessory: "nenhum", hex: swatchOf(shape) };
}

/** A surprise: any valid recipe, the color from the family's swatches. */
export const surprise = (): LuveRecipe => ({ shape: pick(SHAPES), material: pick(MATERIAL_IDS), accessory: pick(ACCESSORY_IDS), hex: pick(SWATCHES) });

/** Arrow keys move among the [data-opt] buttons of a group (the group has one tab stop: the chosen one). */
function arrowNav(e: React.KeyboardEvent<HTMLElement>) {
  const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
  if (step === undefined && e.key !== "Home" && e.key !== "End") return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-opt]"));
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  items[e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + step + items.length) % items.length].focus();
}

/** The studio's preview: the 2D art at once, swapped for the 3D view when it is ready, and back to 2D if it fails or the WebGL context
 *  is lost. The 3D gets only the parsed recipe. `viewRef` hands the live view to whoever needs its PNG. */
function Preview({ value, name, viewRef }: { value: string; name: string; viewRef: React.MutableRefObject<Luve3dView | null> }) {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const latest = React.useRef(value);
  latest.current = value;
  const [on3d, setOn3d] = React.useState(false);

  React.useEffect(() => {
    let alive = true, view: Luve3dView | null = null;
    const el = canvas.current;
    const lost = () => { if (view) { view.dispose(); view = null; viewRef.current = null; } setOn3d(false); };
    loadLuve3d().then((api) => {
      const recipe = parseLuve(latest.current);
      if (!alive || !el || !recipe) return;
      view = api.mount(el, recipe);
      viewRef.current = view;
      el.addEventListener("webglcontextlost", lost);
      setOn3d(true);
    }).catch(() => { /* no file or no WebGL: the 2D art stays */ });
    return () => { alive = false; el?.removeEventListener("webglcontextlost", lost); view?.dispose(); viewRef.current = null; };
  }, [viewRef]);

  React.useEffect(() => {
    const recipe = parseLuve(value);
    if (on3d && recipe) try { viewRef.current?.set(recipe); } catch { setOn3d(false); }
  }, [value, on3d, viewRef]);

  return (
    <div className="lb-luve-preview-art" aria-hidden="true" data-view={on3d ? "3d" : "2d"}>
      {!on3d && <Avatar name={name} avatar={{ kind: "luve", value }} size={160} />}
      <canvas ref={canvas} className="lb-luve-canvas" style={{ display: on3d ? "block" : "none" }} />
    </div>
  );
}

interface InnerProps { initial?: string | null; seedShape?: string | null; useLabel: string; onUse: (value: string) => void; onClose: () => void }

function Studio({ initial, seedShape, useLabel, onUse, onClose }: InnerProps) {
  const { t, locale } = useLuveI18n();
  const [recipe, setRecipe] = React.useState<LuveRecipe>(() => startRecipe(initial, seedShape));
  const [step, setStep] = React.useState(0);
  const root = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<Luve3dView | null>(null);
  const [png, setPng] = React.useState<"idle" | "busy" | "failed">("idle");
  const set = (patch: Partial<LuveRecipe>) => setRecipe((r) => ({ ...r, ...patch }));
  const value = formatLuve(recipe);
  const name = (kind: "materials" | "accessories", id: string): string => KIT[kind][id][locale === "en" ? "nameEn" : "name"];

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Tab") return;
      e.stopImmediatePropagation();
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      const dialog = root.current?.closest<HTMLElement>('[role="dialog"]');
      const items = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_ELEMENTS_SELECTOR)).filter((el) => el.getAttribute("tabindex") !== "-1") : [];
      if (!items.length) { e.preventDefault(); return; }
      const edge = items[e.shiftKey ? 0 : items.length - 1];
      if (document.activeElement === edge || !dialog!.contains(document.activeElement)) { e.preventDefault(); items[e.shiftKey ? items.length - 1 : 0].focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const tile = (id: string, label: string, aria: string, patch: Partial<LuveRecipe>, chosen: boolean) => (
    <button key={id} type="button" data-opt className="lb-luve-opt" aria-pressed={chosen} aria-label={aria} title={label}
      tabIndex={chosen ? 0 : -1} onClick={() => set(patch)}>
      <Avatar name={label} avatar={{ kind: "luve", value: formatLuve({ ...recipe, ...patch }) }} size={44} />
      <span aria-hidden="true">{label}</span>
    </button>
  );

  const download = async () => {
    setPng("busy");
    try { savePng(await luvePng(value, view.current), pngName(value)); setPng("idle"); } catch { setPng("failed"); }
  };
  const current = STEPS[step];
  const accessory = recipe.accessory === "nenhum" ? t("luveNoAcc") : t("luveWithAcc", { name: name("accessories", recipe.accessory).toLowerCase() });
  const summary = t("luveSummary", { shape: KIT.shapes[recipe.shape].name, color: `#${recipe.hex}`, material: name("materials", recipe.material).toLowerCase(), accessory });
  const swatchHeld = SWATCHES.includes(recipe.hex);

  return (
    <div ref={root} className="lb-dialog-body">
      <div className="lb-luve-preview">
        <Preview value={value} name={KIT.shapes[recipe.shape].name} viewRef={view} />
        <p className="lb-luve-summary" aria-live="polite">{summary}</p>
      </div>

      <div role="tablist" aria-label={t("luveStepsLabel")} className="lb-luve-tabs" onKeyDown={arrowNav}>
        {STEPS.map((s, i) => (
          <button key={s} type="button" role="tab" data-opt id={`lb-luve-tab-${s}`} aria-selected={i === step} aria-controls="lb-luve-panel"
            tabIndex={i === step ? 0 : -1} className="lb-luve-tab" onClick={() => setStep(i)}>
            {t(STEP_KEY[s])}
          </button>
        ))}
      </div>
      <p className="lb-luve-step" aria-live="polite">{t("luveStepOf", { step: step + 1 })}</p>

      <div id="lb-luve-panel" role="tabpanel" aria-labelledby={`lb-luve-tab-${current}`}>
        <div role="group" aria-label={t(STEP_KEY[current])} className="lb-luve-grid" onKeyDown={arrowNav}>
          {current === "shape" && SHAPES.map((id) => tile(id, KIT.shapes[id].name, t("luveShapeAria", { name: KIT.shapes[id].name }), { shape: id }, recipe.shape === id))}
          {current === "material" && MATERIAL_IDS.map((id) => tile(id, name("materials", id), t("luveMaterialAria", { name: name("materials", id).toLowerCase() }), { material: id }, recipe.material === id))}
          {current === "accessory" && ACCESSORY_IDS.map((id) => tile(id, name("accessories", id), t("luveAccessoryAria", { name: name("accessories", id).toLowerCase() }), { accessory: id }, recipe.accessory === id))}
          {current === "color" && SWATCHES.map((hex, i) => (
            <button key={hex} type="button" data-opt className="lb-luve-swatch" aria-pressed={recipe.hex === hex} aria-label={t("luveColorAria", { hex: `#${hex}` })}
              title={`#${hex}`} tabIndex={recipe.hex === hex || (!swatchHeld && i === 0) ? 0 : -1} style={{ background: `#${hex}` }} onClick={() => set({ hex })} />
          ))}
        </div>
        {current === "color" && (
          <label className="lb-luve-other">
            <span className="lb-label">{t("luveOtherColor")}</span>
            <input type="color" value={`#${recipe.hex}`} aria-label={t("luveOtherColor")}
              onChange={(e) => { const hex = e.target.value.replace(/^#/, "").toLowerCase(); if (HEX.test(hex)) set({ hex }); }} />
          </label>
        )}
      </div>

      <div className="lb-luve-dock">
        <div className="lb-luve-actions">
          <button type="button" className="lb-btn" onClick={() => setRecipe(surprise())}>{t("luveSurprise")}</button>
          <button type="button" className="lb-btn" aria-busy={png === "busy"} disabled={png === "busy"} onClick={download}>{t("luvePng")}</button>
        </div>
        {png === "failed" && <p role="alert" className="lb-luve-step">{t("luvePngError")}</p>}
        <div className="lb-dialog-footer">
          <button type="button" className="lb-btn" disabled={step === 0} onClick={() => setStep(step - 1)}>{t("luveBack")}</button>
          {step < STEPS.length - 1
            ? <button type="button" className="lb-btn lb-btn-primary" onClick={() => setStep(step + 1)}>{t("luveNext")}</button>
            : <button type="button" className="lb-btn lb-btn-primary" onClick={() => onUse(value)}>{useLabel}</button>}
        </div>
      </div>
    </div>
  );
}

export interface LuveStudioProps { open: boolean; onClose: () => void; onUse: (value: string) => void; useLabel: string; initial?: string | null; seedShape?: string | null }

/** The studio as a dialog. It mounts its state only while open, so each opening starts from `initial` (or the seed). */
export function LuveStudio({ open, onClose, onUse, useLabel, initial, seedShape }: LuveStudioProps) {
  const { t } = useLuveI18n();
  return (
    <Dialog open={open} onClose={onClose} title={t("luveStudioTitle")} titleId="lb-luve-title" width={520} disableTrap>
      <Studio initial={initial} seedShape={seedShape} useLabel={useLabel} onUse={onUse} onClose={onClose} />
    </Dialog>
  );
}

/** The button that opens the studio from the Bot profile and the Create Bot step. Using the Luve closes it; the caller keeps the value. */
export function LuveEntry({ value, seedShape, useLabel, onUse }: { value?: string | null; seedShape?: string | null; useLabel: string; onUse: (value: string) => void }) {
  const { t } = useLuveI18n();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" className="lb-btn" onClick={() => setOpen(true)}>{t("luveCreate")}</button>
      <LuveStudio open={open} onClose={() => setOpen(false)} initial={value} seedShape={seedShape} useLabel={useLabel} onUse={(v) => { onUse(v); setOpen(false); }} />
    </>
  );
}
