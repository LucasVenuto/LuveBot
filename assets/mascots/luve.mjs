// assets/mascots/luve.mjs: a receita do "Crie seu Luve" (D-022, proposta §4 e §8) e o único lugar que monta o SVG dela.
// Receita canônica: "<forma>.<material>.<acessorio>.<rrggbb>" (hex minúsculo, sem "#"). Os ids só ESCOLHEM peças das
// listas fixas do kit (constantes do build); nunca entram como texto. O hex é conferido de novo na hora de montar.
import kit from "./luve-kit.json" with { type: "json" };
import { contrast, draw, edgeOf, gear, paletteOf } from "./luve-art.mjs";

export const KIT = kit;
export const SHAPES = Object.freeze(Object.keys(kit.shapes));
export const MATERIAL_IDS = Object.freeze(Object.keys(kit.materials));
export const ACCESSORY_IDS = Object.freeze(Object.keys(kit.accessories));
const HEX = /^[0-9a-f]{6}$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** A receita guardada → {shape, material, accessory, hex}, ou null para qualquer coisa fora das listas (fail closed). */
export function parseLuve(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const m = /^([a-z]+)\.([a-z]+)\.([a-z]+)\.([0-9a-f]{6})$/.exec(value);
  if (!m || !own(kit.shapes, m[1]) || !own(kit.materials, m[2]) || !own(kit.accessories, m[3])) return null;
  return { shape: m[1], material: m[2], accessory: m[3], hex: m[4] };
}

export const formatLuve = (r) => `${r.shape}.${r.material}.${r.accessory}.${r.hex}`;

/** Paleta da cor (a da família quando a cor é uma das amostras) + contorno que lê nos dois temas + tom dos acessórios:
 *  o escuro da família (lê sobre o corpo; o filete claro da peça lê no fundo escuro), ou o do contorno quando o escuro não
 *  se separa do corpo (cor quase preta). */
export function luvePalette(hex) {
  const c = paletteOf(`#${hex}`, kit.swatches), edge = edgeOf(c.deep), dark = gear(c);
  return { ...c, edge, gear: contrast(dark, c.base) >= 2.5 ? dark : edge };
}

/** A receita já parseada ainda confere (o hex e cada id das listas)? Quem desenha (2D e 3D) confere de novo. */
export const isRecipe = (r) => !!r && typeof r === "object" && typeof r.hex === "string" && HEX.test(r.hex)
  && own(kit.shapes, r.shape) && own(kit.materials, r.material) && own(kit.accessories, r.accessory);

/** SVG de um Luve. recipe: saída de parseLuve. state: "working" | "needs_you" | outro. mini: sem órbita e sombra.
 *  null se a receita não confere (quem chama mostra o mascote padrão). */
export function buildLuveSvg(recipe, state, mini = false) {
  if (!isRecipe(recipe)) return null;
  const s = kit.shapes[recipe.shape], acc = kit.accessories[recipe.accessory];
  const c = luvePalette(recipe.hex), tokens = c;
  const paint = (svg) => svg.replace(/\{(light|base|deep|rim|gear)\}/g, (_, k) => tokens[k]);
  const fit = acc.pieces.length ? kit.fit[recipe.shape][recipe.accessory] : {};
  const layer = (name) => acc.pieces.map((p, i) => (p.layer !== name ? "" : fit.t[i] ? `<g transform="${fit.t[i]}">${paint(p.svg)}</g>` : paint(p.svg))).join("");
  const sat = fit.sat ? { ...s.sat, x: fit.sat[0], y: fit.sat[1] } : { ...s.sat };
  if (fit.extra && s.sat.extra) sat.extra = fit.extra.map((i) => s.sat.extra[i]);
  const cls = [mini ? "lb-face" : "", state === "working" ? "is-working" : state === "needs_you" ? "needs-you" : ""].filter(Boolean).join(" ");
  return draw({ ...s, id: "luve", colors: c, edge: c.edge, sat, back: layer("back"), front: layer("front") },
    { title: false, cls, material: recipe.material });
}
