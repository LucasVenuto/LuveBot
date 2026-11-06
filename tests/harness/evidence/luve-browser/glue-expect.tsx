// Only what the checks need in the page of the REAL panel: the shipped kit, to know what SVG a recipe must draw. Injected by CDP after each load.
import { buildLuveSvg, parseLuve, formatLuve, KIT, SHAPES, MATERIAL_IDS, ACCESSORY_IDS } from "@repo/assets/mascots/luve.mjs";
(window as any).__luve = { KIT, SHAPES, MATERIAL_IDS, ACCESSORY_IDS, formatLuve, parseLuve, expectSvg: (v: string, state?: string, mini?: boolean) => buildLuveSvg(parseLuve(v), state, !!mini) };
