// assets/mascots/build.mjs — gera a família de mascotes do LuveBot.
// Uso: node assets/mascots/build.mjs            → SVGs, manifest.json, gallery.html e luve-kit.json nesta pasta
//      (o desenho mora em luve-art.mjs, compartilhado com o "Crie seu Luve"; a receita e a montagem, em luve.mjs)
//      node assets/mascots/build.mjs --render D → também PNG 1024x1024 transparente de cada um em D
// Cada SVG é autônomo (sem dependência): gradientes, CSS e animações dentro do arquivo.
// Estados: classe no <svg> (.is-working / .needs-you) quando inline, ou fragmento (#lb-working / #lb-needs-you) em <img>.

import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { draw, f, INK, gear, sample, squircle, MATERIALS, LINE } from "./luve-art.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- Formas ----------
// Estrela macia: pontas alternadas, todas arredondadas pela curva.
const softStar = (cx, cy, ro, ri, tips = 5, rot = -90) =>
  Array.from({ length: tips * 2 }, (_, i) => {
    const a = ((rot + (i * 180) / tips) * Math.PI) / 180, r = i % 2 ? ri : ro;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

// Pétalas: lobos redondos com vale entre eles (trevo, flor).
const petals = (cx, cy, ro, ri, lobes = 4, rot = 0, n = 96) =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI, r = ri + (ro - ri) * Math.abs(Math.cos((lobes / 2) * (t - (rot * Math.PI) / 180))) ** 0.55;
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
  });

// Nuvem: elipse com calombos só na metade de cima.
function cloud(cx, cy, rx, ry, { bumps = 4, amp = 0.2, n = 72 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI, s = Math.sin(t);
    const m = s < 0 ? 1 + amp * Math.abs(Math.sin(bumps * (t - Math.PI))) ** 0.6 : 1;
    return [cx + rx * m * Math.cos(t), cy + ry * m * s * (s < 0 ? 1 : 0.8)];
  });
}

// ---------- Acessórios e expressões (cada um devolve {back, front, face}) ----------
const cheeks = (pl, ey, c = "#ff8fab") =>
  [-1, 1].map((s) => `<ellipse cx="${f(pl.cx + s * (ey.gap + ey.w * 0.9))}" cy="${f(pl.cy + ey.dy + ey.h * 0.55)}" rx="7" ry="4" fill="${c}" opacity=".55"/>`).join("");
const smile = (x, y, w = 9, sw = 3) => `<path d="M${f(x - w)},${f(y)}Q${f(x)},${f(y + w * 0.75)} ${f(x + w)},${f(y)}" fill="none" stroke="${INK}" stroke-width="${sw}" stroke-linecap="round"/>`;

const flat = (x, y, w = 6) => `<path d="M${f(x - w)},${f(y)}H${f(x + w)}" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`;
const oMouth = (x, y) => `<ellipse cx="${f(x)}" cy="${f(y)}" rx="3.6" ry="4.2" fill="${INK}"/>`;
const grin = (x, y, w = 9) => `<path d="M${f(x - w)},${f(y)}Q${f(x)},${f(y + w * 1.5)} ${f(x + w)},${f(y)}Z" fill="${INK}"/><ellipse cx="${f(x)}" cy="${f(y + w * 0.62)}" rx="${f(w * 0.42)}" ry="${f(w * 0.2)}" fill="#fb7185"/>`;
const brow = (x, y, a = 0, w = 14) => `<rect x="${f(x - w / 2)}" y="${f(y - 2.25)}" width="${w}" height="4.5" rx="2.25" fill="${INK}" transform="rotate(${a} ${f(x)} ${f(y)})"/>`;
const shine = (d, o = 0.85) => `<path d="${d}" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="${o}"/>`;

const ACC = {
  headset: (c, g = gear(c)) => ({
    back: `<path d="M40,150C38,30 218,30 216,150" fill="none" stroke="${g}" stroke-width="8" stroke-linecap="round"/>` +
      `<path d="M40,150C38,30 218,30 216,150" pathLength="100" stroke-dasharray="0 26 48 100" transform="translate(0 -2)" fill="none" stroke="${c.light}" stroke-width="2" stroke-linecap="round" opacity=".75"/>`,
    front: [27, 205].map((x) => `<rect x="${x}" y="126" width="24" height="42" rx="12" fill="${g}"/><rect x="${x + 8}" y="133" width="8" height="28" rx="4" fill="${c.light}"/>`).join("") +
      `<path d="M40,165C42,196 62,206 86,204" fill="none" stroke="${g}" stroke-width="5" stroke-linecap="round"/><circle cx="90" cy="203" r="7" fill="${g}"/><circle cx="88" cy="201" r="2.5" fill="${c.light}"/>`,
  }),
  magnifier: (c, g = gear(c)) => ({
    front: `<g class="m-wobble"><path d="M221,205L238,223" stroke="${g}" stroke-width="9" stroke-linecap="round"/>` +
      `<circle cx="207" cy="191" r="19" fill="#ffffff" fill-opacity=".45" stroke="${g}" stroke-width="6"/>` +
      `<circle cx="207" cy="191" r="22" fill="none" stroke="${c.light}" stroke-width="1.5" opacity=".8"/>` +
      `<path d="M197,184A11,11 0 0 1 206,178" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" opacity=".9"/></g>`,
  }),
  // Dev: gorro com hélice (gira rápido quando trabalha).
  propeller: (c, g = gear(c)) => ({
    front: `<path d="M98,80C100,36 180,32 184,76C160,66 122,66 98,80Z" fill="#fbbf24"/><path d="M106,62C126,50 160,48 178,58" fill="none" stroke="#fb7185" stroke-width="5" stroke-linecap="round"/>` +
      shine("M112,56C120,48 132,44 142,43", 0.7) +
      `<path d="M141,46V30" stroke="${g}" stroke-width="4" stroke-linecap="round"/>` +
      `<g class="m-prop"><ellipse cx="130" cy="28" rx="11" ry="3.8" fill="#fb7185"/><ellipse cx="152" cy="28" rx="11" ry="3.8" fill="#38bdf8"/></g><circle cx="141" cy="28" r="3.5" fill="${g}"/>`,
  }),
  // Ops: antena com luz de status piscando.
  antenna: (c, g = gear(c)) => ({
    back: `<path d="M128,80V40" stroke="${g}" stroke-width="4.5" stroke-linecap="round"/>`,
    front: `<circle cx="128" cy="36" r="10" fill="#4ade80" opacity=".3" class="m-blinker"/><circle cx="128" cy="36" r="6.5" fill="#4ade80"/><circle cx="126" cy="34" r="2" fill="#fff" opacity=".9"/>`,
  }),
  // Conteúdo: lápis atrás da cabeça.
  pencil: () => ({
    back: `<g transform="rotate(-38 204 92)"><rect x="170" y="85" width="58" height="14" rx="3" fill="#fde047"/><rect x="170" y="85" width="58" height="5" rx="2" fill="#fef9c3"/>` +
      `<rect x="222" y="85" width="12" height="14" rx="4" fill="#fb7185"/><rect x="218" y="85" width="5" height="14" fill="#cbd5e1"/>` +
      `<path d="M170,85L170,99L154,92Z" fill="#f5d0a9"/><path d="M159,89.6L159,94.4L154,92Z" fill="${INK}"/></g>`,
  }),
  // Revisor: selo de aprovado.
  check: (c) => ({
    front: `<circle cx="200" cy="196" r="18" fill="#fff" stroke="${c.deep}" stroke-width="2.5"/><path d="M191,196L198,203L210,189" fill="none" stroke="#16a34a" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  }),
  // Vendas: nó de balão e broche de seta para cima.
  balloon: (c, g = gear(c)) => ({
    back: `<path d="M128,236q-7,9 1,16" fill="none" stroke="${g}" stroke-width="2.5" stroke-linecap="round"/><path d="M119,237L137,237L128,224Z" fill="${c.deep}" stroke="${c.deep}" stroke-width="3" stroke-linejoin="round"/>`,
    front: `<circle cx="72" cy="194" r="15" fill="#fff" stroke="${c.deep}" stroke-width="2"/><path d="M72,202V186M65,192L72,185L79,192" fill="none" stroke="#16a34a" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  }),
  // Dados: plaquinha de gráfico de barras.
  bars: (c) => ({
    front: `<rect x="176" y="182" width="38" height="32" rx="9" fill="#fff" stroke="${c.deep}" stroke-width="2"/>` +
      [[184, 14], [193, 20], [202, 10]].map(([x, h], i) => `<rect x="${x}" y="${207 - h}" width="6" height="${h}" rx="3" fill="${["#60a5fa", c.deep, "#34d399"][i]}"/>`).join(""),
  }),
  // Design: boina.
  beret: (c, g = gear(c)) => ({
    front: `<g transform="rotate(-14 124 57)"><ellipse cx="124" cy="57" rx="40" ry="13" fill="${g}"/><path d="M92,53C104,45 134,43 150,47" fill="none" stroke="${c.light}" stroke-width="2.5" stroke-linecap="round" opacity=".6"/><circle cx="124" cy="43" r="4.5" fill="${g}"/></g>`,
  }),
  // Social: balãozinho com coração flutuando.
  heartBubble: (c) => ({
    front: `<g class="m-float"><path d="M24,10H58A12,12 0 0 1 70,22V34A12,12 0 0 1 58,46H48L38,56L39,46H24A12,12 0 0 1 12,34V22A12,12 0 0 1 24,10Z" fill="#fff" stroke="${c.deep}" stroke-width="2"/>` +
      `<path d="M41,38C29,30 33,18 41,24C49,18 53,30 41,38Z" fill="${c.base}"/></g>`,
  }),
  // Segurança: cadeado.
  padlock: (c, g = gear(c)) => ({
    front: `<path d="M118,202V194A10,10 0 0 1 138,194V202" fill="none" stroke="${g}" stroke-width="5"/><rect x="111" y="198" width="34" height="25" rx="8" fill="${g}"/>` +
      `<circle cx="128" cy="208" r="3.5" fill="${c.light}"/><rect x="126.5" y="209" width="3" height="7" rx="1.5" fill="${c.light}"/>`,
  }),
  // Agenda: sininhos de despertador.
  bells: (c, g = gear(c)) => ({
    back: [[90, -28], [166, 28]].map(([x, a]) => `<g transform="rotate(${a} ${x} 72)"><path d="M${x - 19},76A19,19 0 0 1 ${x + 19},76Z" fill="${g}"/><path d="M${x - 10},64A13,13 0 0 1 ${x + 2},59" fill="none" stroke="${c.light}" stroke-width="2.5" stroke-linecap="round"/><rect x="${x - 3}" y="51" width="6" height="6" rx="3" fill="${g}"/></g>`).join(""),
  }),
};

// ---------- Personagens ----------
// colors: light (topo), base (cor do Bot), deep (base/sombra, dá contraste no fundo claro), rim (brilho lateral)
export const CHARACTERS = [
  {
    id: "luvi", name: "Luvi", role: "Assistente geral", roleEn: "General assistant", shape: "blob",
    note: "O mascote oficial, em vetor. A matriarca da família.",
    colors: { light: "#c4b2ff", base: "#6a70f8", deep: "#2346f2", rim: "#22c3f7" },
    body: [[20, 163], [37, 131], [67, 117], [90, 72], [126, 49], [163, 59], [184, 96], [220, 122], [241, 163], [227, 207], [177, 230], [124, 217], [78, 198], [35, 193]],
    plate: { cx: 133, cy: 152, rx: 58, ry: 40, e: 2.3, lean: -0.12 },
    eyes: { gap: 24, w: 15, h: 28, dy: 2 },
    sat: { x: 214, y: 59, r: 21 },
    timing: { blink: "5.2s", breathe: "3.8s", look: "11s", orbit: "8s", delay: "0s" },
  },
  {
    id: "brisa", name: "Brisa", role: "Suporte", roleEn: "Support", shape: "mochi",
    note: "Mochi macio de fone: escuta primeiro, resolve depois.",
    colors: { light: "#c6f7e2", base: "#34d399", deep: "#0a9b72", rim: "#5ee6f0" },
    body: squircle(128, 152, 92, 78, { e: 2.7, taper: 0.14 }),
    plate: { cx: 128, cy: 154, rx: 56, ry: 39, e: 2.5 },
    eyes: { gap: 22, w: 13, h: 23, dy: -3 },
    sat: { x: 222, y: 46, r: 13 },
    acc: ["headset"],
    face: (pl, ey) => cheeks(pl, ey) + smile(pl.cx, pl.cy + 19, 7),
    timing: { blink: "4.6s", breathe: "3.4s", look: "9.5s", orbit: "6.5s", delay: "-1.7s" },
  },
  {
    id: "faro", name: "Faro", role: "Pesquisa", roleEn: "Research", shape: "estrela macia",
    note: "Estrela curiosa de lupa: acha a fonte antes de opinar.",
    colors: { light: "#fff0b3", base: "#fbbf24", deep: "#e57c06", rim: "#ff8a6b" },
    body: softStar(128, 141, 106, 72),
    plate: { cx: 128, cy: 146, rx: 46, ry: 33, e: 2.4 },
    eyes: { gap: 19, w: 13, h: 24, dy: -2, shine: true },
    sat: { x: 207, y: 50, r: 12 },
    acc: ["magnifier"],
    face: (pl) => oMouth(pl.cx, pl.cy + 20),
    timing: { blink: "6.1s", breathe: "4.2s", look: "8s", orbit: "7.5s", delay: "-3.1s" },
  },
  {
    id: "pipo", name: "Pipo", role: "Dev", roleEn: "Developer", shape: "feijão",
    note: "Feijão de gorro com hélice: quanto mais código, mais rápido gira.",
    colors: { light: "#e4dcff", base: "#a78bfa", deep: "#6d3df0", rim: "#f0abfc" },
    body: [[96, 70], [146, 56], [194, 76], [218, 124], [214, 180], [182, 220], [124, 230], [70, 218], [40, 186], [52, 150], [80, 126], [88, 98]],
    plate: { cx: 136, cy: 150, rx: 54, ry: 37, e: 2.4, lean: -0.05 },
    eyes: { gap: 21, w: 13, h: 19, dy: -1 },
    sat: { x: 218, y: 62, r: 13 },
    acc: ["propeller"], glint: [0.5, 0.3],
    face: (pl) => flat(pl.cx + 2, pl.cy + 19, 5),
  },
  {
    id: "nimbo", name: "Nimbo", role: "Ops", roleEn: "Ops", shape: "nuvem",
    note: "Nuvem de antena: vigia tudo e pisca verde quando está tudo bem.",
    colors: { light: "#ccf2ff", base: "#38bdf8", deep: "#0377c4", rim: "#a5b4fc" },
    body: cloud(128, 162, 98, 66, { bumps: 4, amp: 0.22 }),
    plate: { cx: 128, cy: 160, rx: 60, ry: 37, e: 2.5 },
    eyes: { gap: 23, w: 13, h: 22, dy: -2 },
    sat: { x: 218, y: 58, r: 12 },
    acc: ["antenna"],
    face: (pl, ey) => cheeks(pl, ey) + smile(pl.cx, pl.cy + 18, 6),
  },
  {
    id: "tinta", name: "Tinta", role: "Conteúdo", roleEn: "Content", shape: "gota",
    note: "Gota sonhadora de lápis atrás da cabeça: olha para cima procurando a frase.",
    colors: { light: "#ffd6de", base: "#fb7185", deep: "#e11d48", rim: "#fdba74" },
    body: [[146, 32, 0.15], [176, 88], [204, 148], [202, 194], [170, 226], [120, 232], [76, 218], [54, 180], [60, 134], [96, 84]],
    plate: { cx: 126, cy: 168, rx: 52, ry: 36, e: 2.4 },
    eyes: { gap: 20, w: 12, h: 22, dy: -4, shine: true },
    sat: { x: 62, y: 62, r: 12 },
    acc: ["pencil"],
    face: (pl, ey) => cheeks(pl, ey) + smile(pl.cx, pl.cy + 18, 6),
  },
  {
    id: "rumo", name: "Rumo", role: "Chefe de gabinete", roleEn: "Chief of staff", shape: "seixo",
    note: "Seixo firme com três satélites do time em volta: coordena quem faz o quê.",
    colors: { light: "#ffe2c4", base: "#fb923c", deep: "#e05206", rim: "#fde047" },
    body: squircle(128, 166, 104, 60, { e: 2.3, lean: -0.06 }),
    plate: { cx: 126, cy: 164, rx: 58, ry: 33, e: 2.5 },
    eyes: { gap: 22, w: 13, h: 21, dy: -2 },
    sat: { x: 210, y: 76, r: 13, extra: [[150, 66, 8, "#60a5fa", "5.2s"], [96, 70, 7, "#34d399", "6.4s"], [58, 92, 6, "#e879f9", "4.6s"]] },
    face: (pl) => smile(pl.cx, pl.cy + 17, 8),
  },
  {
    id: "vera", name: "Vera", role: "Revisor", roleEn: "Reviewer", shape: "marshmallow",
    note: "Marshmallow de sobrancelha erguida: só sai com o selo verde.",
    colors: { light: "#fbd6ff", base: "#e879f9", deep: "#b021c8", rim: "#a78bfa" },
    body: squircle(128, 148, 84, 80, { e: 3.6, rot: 3 }),
    plate: { cx: 128, cy: 146, rx: 54, ry: 36, e: 2.5 },
    eyes: { gap: 21, w: 13, h: 23, dy: 1 },
    sat: { x: 220, y: 50, r: 12 },
    acc: ["check"],
    face: (pl) => brow(pl.cx + 21, pl.cy - 21, -14) + flat(pl.cx + 3, pl.cy + 21, 5),
  },
  {
    id: "zuca", name: "Zuca", role: "Vendas", roleEn: "Sales", shape: "balão",
    note: "Balão de piscadinha e sorrisão: cada sim vira uma seta para cima.",
    colors: { light: "#d6e7ff", base: "#60a5fa", deep: "#2160e8", rim: "#67e8f9" },
    body: squircle(128, 136, 88, 90, { e: 2.05 }),
    plate: { cx: 128, cy: 134, rx: 54, ry: 37, e: 2.5 },
    eyes: { gap: 21, w: 13, h: 23, dy: -3, wink: -1 },
    sat: { x: 220, y: 50, r: 13 },
    acc: ["balloon"],
    face: (pl) => grin(pl.cx, pl.cy + 13, 9),
  },
  {
    id: "niquel", name: "Níquel", role: "Finanças", roleEn: "Finance", shape: "pudim",
    note: "Pudim tranquilo com satélite de moeda: conta cada centavo sem drama.",
    colors: { light: "#efffcf", base: "#a3e635", deep: "#5a9a0b", rim: "#fde047" },
    body: squircle(128, 152, 94, 76, { e: 3, taper: 0.3 }),
    plate: { cx: 128, cy: 158, rx: 54, ry: 35, e: 2.5 },
    eyes: { gap: 21, w: 13, h: 22, dy: -3, shine: true },
    sat: { x: 214, y: 58, r: 17, coin: true },
    face: (pl, ey) => cheeks(pl, ey) + smile(pl.cx, pl.cy + 17, 5),
  },
  {
    id: "quadra", name: "Quadra", role: "Dados", roleEn: "Data", shape: "trevo",
    note: "Trevo de quatro lobos e plaquinha de gráfico: encontra o padrão.",
    colors: { light: "#e2e7ff", base: "#818cf8", deep: "#4a3fe0", rim: "#5eead4" },
    body: petals(128, 142, 104, 74, 4, 45),
    plate: { cx: 128, cy: 142, rx: 48, ry: 33, e: 2.5 },
    eyes: { gap: 19, w: 14, h: 21, dy: -2 },
    sat: { x: 128, y: 34, r: 11 },
    acc: ["bars"],
    face: (pl) => smile(pl.cx, pl.cy + 16, 6),
  },
  {
    id: "flora", name: "Flora", role: "Design", roleEn: "Design", shape: "flor macia",
    note: "Flor de boina: põe cor e ritmo em tudo que toca.",
    colors: { light: "#ffe0f0", base: "#f472b6", deep: "#d6246f", rim: "#c4b5fd" },
    body: petals(128, 146, 102, 80, 6, -90),
    plate: { cx: 128, cy: 148, rx: 52, ry: 35, e: 2.5 },
    eyes: { gap: 20, w: 13, h: 23, dy: -2, shine: true },
    sat: { x: 216, y: 44, r: 11 },
    acc: ["beret"],
    face: (pl, ey) => cheeks(pl, ey, "#fb7185") + smile(pl.cx, pl.cy + 18, 6),
  },
  {
    id: "eco", name: "Eco", role: "Social", roleEn: "Social media", shape: "coração",
    note: "Coração falante: transforma conversa em comunidade.",
    colors: { light: "#ffd9d9", base: "#f87171", deep: "#d42020", rim: "#fda4af" },
    body: [[128, 88, 0.3], [156, 56], [200, 54], [230, 94], [222, 146], [184, 194], [128, 234, 0.4], [72, 194], [34, 146], [26, 94], [56, 54], [100, 56]],
    plate: { cx: 128, cy: 134, rx: 54, ry: 34, e: 2.5 },
    eyes: { gap: 21, w: 13, h: 22, dy: -3, shine: true },
    sat: { x: 226, y: 38, r: 11 },
    acc: ["heartBubble"],
    face: (pl, ey) => cheeks(pl, ey) + grin(pl.cx, pl.cy + 13, 7),
  },
  {
    id: "lacre", name: "Lacre", role: "Segurança", roleEn: "Security", shape: "escudo",
    note: "Escudo calmo de cadeado: ninguém passa sem permissão.",
    colors: { light: "#cffcf2", base: "#2dd4bf", deep: "#0b8a7e", rim: "#93c5fd" },
    body: [[40, 82], [84, 64], [128, 58], [172, 64], [216, 82], [214, 146], [184, 202], [128, 236, 0.45], [72, 202], [42, 146]],
    plate: { cx: 128, cy: 132, rx: 54, ry: 34, e: 2.6 },
    eyes: { gap: 21, w: 14, h: 22, dy: 0 },
    sat: { x: 222, y: 48, r: 12 },
    acc: ["padlock"],
    face: (pl) => brow(pl.cx - 21, pl.cy - 21, 8, 12) + brow(pl.cx + 21, pl.cy - 21, -8, 12) + smile(pl.cx, pl.cy + 17, 5),
  },
  {
    id: "tico", name: "Tico", role: "Agenda", roleEn: "Scheduling", shape: "ovo",
    note: "Ovo de sininhos: nunca deixa um compromisso passar.",
    colors: { light: "#f3efff", base: "#c4b5fd", deep: "#7655ee", rim: "#f9a8d4" },
    body: squircle(128, 148, 80, 88, { e: 2.15, taper: 0.2 }),
    plate: { cx: 128, cy: 156, rx: 50, ry: 34, e: 2.5 },
    eyes: { gap: 20, w: 14, h: 26, dy: -2, shine: true },
    sat: { x: 214, y: 56, r: 12 },
    acc: ["bells"],
    face: (pl, ey) => cheeks(pl, ey) + smile(pl.cx, pl.cy + 19, 6),
  },
];

// Ritmo próprio para quem não declarou: a família nunca pisca em uníssono.
CHARACTERS.forEach((ch, i) => {
  ch.timing ??= {
    blink: `${f(4.3 + ((i * 0.71) % 2.2))}s`, breathe: `${f(3.2 + ((i * 0.37) % 1.2))}s`,
    look: `${f(8 + ((i * 1.3) % 4))}s`, orbit: `${f(6 + ((i * 0.9) % 3))}s`, delay: `${f(-((i * 0.83) % 4))}s`,
  };
});

// ---------- SVG de um personagem ----------
// face=true: variante "rosto" (viewBox recortado na placa) para avatar de 24 a 40 px.
// still=true: sem CSS nem sombra (logo).
export function svg(ch, { title = true, face = false, still = false } = {}) {
  const acc = (ch.acc ?? []).map((a) => ACC[a](ch.colors));
  const part = (k) => acc.map((a) => a[k] ?? "").join("");
  return draw({ ...ch, face: ch.face ? ch.face(ch.plate, ch.eyes) : "", back: part("back"), front: part("front") }, { title, face, still });
}

// ---------- Galeria ----------
function gallery(chars) {
  const card = (ch) => `<figure class="card" data-id="${ch.id}">
  <button class="stage" type="button" aria-label="Trocar o estado de ${ch.name}">${svg(ch, { title: false })}</button>
  <figcaption><b>${ch.name}</b><span>${ch.role}</span><small>${ch.shape}</small>
  <span class="chips">${Object.values(ch.colors).map((x) => `<i style="background:${x}" title="${x}"></i>`).join("")}</span></figcaption>
</figure>`;
  const tile = (ch, s) => `<span class="sz" style="width:${s}px;height:${s}px;background:color-mix(in srgb,${ch.colors.base} 18%,transparent)">${svg(ch, { title: false, face: true })}</span>`;
  const sizes = [24, 32, 40, 56].map((s) => tile(chars[0], s)).join("") + `<span class="sep"></span>` + chars.map((ch) => tile(ch, 40)).join("");
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mascotes LuveBot</title>
<style>
:root{--bg:#f5f6fa;--fg:#0b0f19;--sub:#5b6478;--fill:color-mix(in srgb,var(--fg) 6%,transparent);--sel:#0b0f19;--selfg:#fff}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0b0f19;--fg:#f8fafc;--sub:#94a3b8;--sel:#f8fafc;--selfg:#0b0f19}}
:root[data-theme=dark]{--bg:#0b0f19;--fg:#f8fafc;--sub:#94a3b8;--sel:#f8fafc;--selfg:#0b0f19}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/22px -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;letter-spacing:-.01em}
main{max-width:1180px;margin:0 auto;padding:32px 24px 48px}
h1{font-size:28px;line-height:34px;font-weight:700;letter-spacing:-.022em;margin:0 0 4px}
h2{font-size:20px;line-height:25px;font-weight:600;letter-spacing:-.017em;margin:32px 0 12px}
p{margin:0;color:var(--sub)}
.bar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:20px 0 8px}
.seg{display:inline-flex;background:var(--fill);border-radius:999px;padding:4px}
.seg button{border:0;background:none;color:var(--fg);font:inherit;font-size:13px;height:32px;padding:0 14px;border-radius:999px;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--sel);color:var(--selfg)}
.seg button:focus-visible,.stage:focus-visible{outline:2px solid #38bdf8;outline-offset:2px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
.card{margin:0;background:var(--fill);border-radius:16px;padding:12px 12px 16px}
.stage{display:block;width:100%;aspect-ratio:1;border:0;padding:8px;background:none;border-radius:12px;cursor:pointer}
.stage svg{width:100%;height:100%;display:block}
figcaption{display:grid;gap:2px;padding:0 4px}
figcaption b{font-size:15px;font-weight:600}
figcaption span,figcaption small{font-size:13px;line-height:18px;color:var(--sub)}
.chips{display:flex;gap:4px;margin-top:6px}.chips i{width:16px;height:16px;border-radius:8px}
.sizes{display:flex;align-items:flex-end;gap:16px;background:var(--fill);border-radius:16px;padding:16px}
.sz{border-radius:36%;overflow:hidden;flex-shrink:0}.sz svg{width:100%;height:100%;display:block}.sep{width:1px;align-self:stretch;background:var(--fill)}
.sizes{flex-wrap:wrap}
.legend{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin:0;padding:0;list-style:none}
.legend li{background:var(--fill);border-radius:16px;padding:12px 16px;font-size:13px;line-height:18px;color:var(--sub)}
.legend b{display:block;color:var(--fg);font-size:15px;margin-bottom:2px}
</style></head>
<body><main>
<h1>Família LuveBot</h1>
<p>${chars.length} mascotes originais. Assinatura de família: placa branca de rosto, olhos em pílula e a bolinha satélite. Clique num personagem para trocar o estado dele.</p>
<div class="bar">
  <div class="seg" role="group" aria-label="Estado" id="state">
    <button aria-pressed="true" data-s="">Parado</button><button aria-pressed="false" data-s="is-working">Trabalhando</button><button aria-pressed="false" data-s="needs-you">Precisa de você</button>
  </div>
  <div class="seg" role="group" aria-label="Tema" id="theme">
    <button aria-pressed="true" data-t="">Sistema</button><button aria-pressed="false" data-t="light">Claro</button><button aria-pressed="false" data-t="dark">Escuro</button>
  </div>
</div>
<div class="grid">${chars.map(card).join("\n")}</div>
<h2>Variante rosto (avatar de 24 a 40 px)</h2>
<div class="sizes">${sizes}</div>
<h2>Sistema</h2>
<ul class="legend">
<li><b>Parado</b>Pisca em intervalo irregular (piscada dupla às vezes), respira com squash leve, olha para os lados e o satélite orbita.</li>
<li><b>Trabalhando</b>Os olhos vão e voltam como quem lê, a respiração acelera e o satélite gira mais rápido.</li>
<li><b>Precisa de você</b>Pulinho com squash na aterrissagem, e o satélite fica âmbar com um anel pulsando. O âmbar fica mesmo sem movimento.</li>
<li><b>Rosto</b>Arquivo <code>&lt;id&gt;-rosto.svg</code>: recorte na placa, sem satélite; em “precisa de você” o pulinho é curto e aparece um ponto âmbar no canto.</li>
<li><b>Movimento reduzido</b>Com prefers-reduced-motion, tudo para no quadro de repouso.</li>
</ul>
</main>
<script>
const set=(g,b)=>document.querySelectorAll('#'+g+' button').forEach(x=>x.setAttribute('aria-pressed',x===b));
const STATES=['','is-working','needs-you'];
const apply=(svg,s)=>{svg.classList.remove('is-working','needs-you');if(s)svg.classList.add(s)};
document.getElementById('state').onclick=e=>{const b=e.target.closest('button');if(!b)return;set('state',b);document.querySelectorAll('svg.lb-mascot').forEach(s=>apply(s,b.dataset.s))};
document.getElementById('theme').onclick=e=>{const b=e.target.closest('button');if(!b)return;set('theme',b);b.dataset.t?document.documentElement.dataset.theme=b.dataset.t:delete document.documentElement.dataset.theme};
document.querySelectorAll('.sz').forEach(t=>t.onclick=()=>{const s=t.querySelector('svg');const cur=STATES.findIndex(c=>c&&s.classList.contains(c));apply(s,STATES[(Math.max(cur,0)+1)%3])});
document.querySelectorAll('.stage').forEach(st=>st.onclick=()=>{const s=st.querySelector('svg');const cur=STATES.findIndex(c=>c&&s.classList.contains(c));apply(s,STATES[(Math.max(cur,0)+1)%3])});
</script>
</body></html>`;
}

// ---------- Saída ----------
const manifest = CHARACTERS.map(({ id, name, role, roleEn, shape, note, colors }) => ({
  id, name, role, roleEn, shape, note, colors, file: `${id}.svg`, face: `${id}-rosto.svg`, accent: colors.base,
  states: { idle: "", working: "is-working | #lb-working", needsYou: "needs-you | #lb-needs-you" },
}));
for (const ch of CHARACTERS) {
  writeFileSync(join(HERE, `${ch.id}.svg`), svg(ch) + "\n");
  writeFileSync(join(HERE, `${ch.id}-rosto.svg`), svg(ch, { face: true }) + "\n");
}
writeFileSync(join(HERE, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(HERE, "gallery.html"), gallery(CHARACTERS));

// ---------- Kit do "Crie seu Luve" (D-022): peças constantes + encaixes pré-calculados ----------
// Cada acessório é desenhado uma vez, no personagem de origem, com tokens de cor ({light} {base} {deep} {rim} {gear}) que
// a UI troca por hex conferido. Cada peça se prende a um ENCAIXE (ponto do contorno do corpo); o build calcula, para cada
// forma × acessório, a transformação que leva o encaixe da origem ao da forma, e onde fica o satélite. A UI só consulta.
// Caixa de cada peça: [x0, y0, x1, y1] no desenho de origem (com folga para a animação e o traço), usada nas conferências.
// Peça oca (o arco do headset) leva também caixas de colisão que seguem a curva: a caixa única cobriria o vazio de dentro.
const ARC = [[35, 113, 49, 155], [39, 77, 72, 123], [62, 54, 133, 88], [123, 54, 194, 88], [184, 77, 217, 123], [207, 113, 221, 155]];
const LUVE_ACC = [
  { id: "headset", name: "Headset", nameEn: "Headset", home: "brisa", from: "headset", pieces: [["back", "ears", [35, 53, 221, 155], ARC], ["front", "ears", [27, 126, 229, 211], [[27, 126, 51, 168], [205, 126, 229, 168], [37, 162, 50, 196], [44, 188, 98, 211]]]] },
  { id: "lupa", name: "Lupa", nameEn: "Magnifier", home: "faro", from: "magnifier", pieces: [["front", "hand", [183, 167, 244, 229]]] },
  { id: "helice", name: "Gorro de hélice", nameEn: "Propeller cap", home: "pipo", from: "propeller", pieces: [["front", "top", [98, 23, 184, 80]]] },
  // A haste no kit desce até dentro do corpo (atrás dele): em qualquer forma ela nasce da cabeça, sem vão.
  { id: "antena", name: "Antena", nameEn: "Antenna", home: "nimbo", from: "antenna", stem: ["M128,80V40", "M128,128V40"], pieces: [["back", "top", [125, 37, 131, 130]], ["front", "top", [118, 26, 138, 46]]] },
  { id: "lapis", name: "Lápis", nameEn: "Pencil", home: "tinta", from: "pencil", pieces: [["back", "free", [160, 68, 232, 129]]] },
  { id: "check", name: "Selo de aprovado", nameEn: "Approval badge", home: "vera", from: "check", pieces: [["front", "hand", [180, 176, 220, 216]]] },
  { id: "balao", name: "Balão", nameEn: "Balloon", home: "zuca", from: "balloon", pieces: [["back", "bottom", [116, 222, 140, 253]], ["front", "handL", [56, 178, 88, 210]]] },
  { id: "barras", name: "Gráfico", nameEn: "Chart", home: "quadra", from: "bars", pieces: [["front", "hand", [175, 181, 215, 215]]] },
  { id: "boina", name: "Boina", nameEn: "Beret", home: "flora", from: "beret", pieces: [["front", "top", [79, 27, 168, 81]]] },
  { id: "coracao", name: "Coração", nameEn: "Heart", home: "eco", from: "heartBubble", pieces: [["front", "free", [11, 5, 71, 57]]] },
  { id: "cadeado", name: "Cadeado", nameEn: "Padlock", home: "lacre", from: "padlock", pieces: [["front", "chest", [108, 181, 148, 225]]] },
  { id: "sinos", name: "Sininhos", nameEn: "Bells", home: "tico", from: "bells", pieces: [["back", "shoulderL", [61, 43, 111, 86]], ["back", "shoulderR", [145, 43, 195, 86]]] },
];
const LUVE_MATERIALS = [["vinil", "Vinil", "Vinyl"], ["laca", "Laca", "Lacquer"], ["fosco", "Fosco", "Matte"], ["metal", "Metal", "Metal"]];

// Encaixes de uma forma, achados no contorno (a mesma curva do SVG).
function anchors(ch) {
  const pts = sample(ch.body, ch.body.length > 40 ? 3 : 16), pl = ch.plate;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const bx = Math.min(...xs), by = Math.min(...ys), bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by, C = [bx + bw / 2, by + bh / 2];
  const ray = (deg) => {
    const a = (deg * Math.PI) / 180, dist = (p) => Math.abs(Math.atan2(Math.sin(Math.atan2(p[1] - C[1], p[0] - C[0]) - a), Math.cos(Math.atan2(p[1] - C[1], p[0] - C[0]) - a)));
    return pts.reduce((b, p) => (dist(p) < dist(b) ? p : b));
  };
  // Topo: no eixo do rosto, na altura do ponto mais alto da faixa central (nem o calombo de lado, nem a reentrância do coração).
  const top = [pl.cx, Math.min(...pts.filter((p) => Math.abs(p[0] - pl.cx) <= pl.rx * 0.35).map((p) => p[1]))];
  const bottom = pts.filter((p) => Math.abs(p[0] - pl.cx) <= pl.rx * 0.4).reduce((b, p) => (p[1] > b[1] ? p : b));
  const cross = [];
  for (let i = 0; i < pts.length; i++) {
    const [p, q] = [pts[i], pts[(i + 1) % pts.length]];
    if ((p[1] - pl.cy) * (q[1] - pl.cy) <= 0 && p[1] !== q[1]) cross.push(p[0] + ((pl.cy - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
  }
  const [l, r] = [Math.min(...cross), Math.max(...cross)];
  return {
    w: bw, earsW: r - l, top, bottom, ears: [(l + r) / 2, pl.cy], chest: [pl.cx, (pl.cy + pl.ry + bottom[1]) / 2],
    hand: ray(40), handL: ray(140), shoulderL: ray(-125), shoulderR: ray(-55), freeR: ray(-40), freeL: ray(-140),
  };
}
const freeSide = (ch) => (ch.sat.x >= 128 ? "freeL" : "freeR"); // o "solto" vai do lado oposto ao satélite
const round2 = (n) => +n.toFixed(3);

// Onde cada peça de um acessório vai numa forma: transformação + caixa final (para as conferências).
export function fitPieces(target, acc) {
  const home = CHARACTERS.find((c) => c.id === acc.home), H = anchors(home), T = anchors(target);
  const placed = acc.pieces.map(([layer, kind, box, hit = [box]]) => {
    const flip = kind === "free" && freeSide(home) !== freeSide(target);
    const [hk, tk] = kind === "free" ? [freeSide(home), freeSide(target)] : [kind, kind];
    const s = Math.min(1.18, Math.max(0.78, kind === "ears" ? T.earsW / H.earsW : T.w / H.w));
    const [from, to] = [H[hk], [...T[tk]]], sx = flip ? -s : s;
    const map = ([x, y]) => [to[0] + sx * (x - from[0]), to[1] + s * (y - from[1])];
    const mapBox = (bx) => { const [a, b] = [map([bx[0], bx[1]]), map([bx[2], bx[3]])]; return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]; };
    return { layer, kind, from, to, sx, s, box: mapBox(box), hit: hit.map(mapBox) };
  });
  // Peças do mesmo encaixe (a haste e a luz da antena) andam juntas até caber no quadro [3, 253].
  for (const kind of new Set(placed.map((p) => p.kind))) {
    const g = placed.filter((p) => p.kind === kind);
    const [x0, y0, x1, y1] = [0, 1, 2, 3].map((i) => (i < 2 ? Math.min : Math.max)(...g.map((p) => p.box[i])));
    const dx = x0 < 3 ? 3 - x0 : x1 > 253 ? 253 - x1 : 0, dy = y0 < 3 ? 3 - y0 : y1 > 253 ? 253 - y1 : 0;
    const move = (b) => [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
    for (const p of g) { p.to[0] += dx; p.to[1] += dy; p.box = move(p.box); p.hit = p.hit.map(move); }
  }
  return placed.map((p) => ({
    layer: p.layer, box: p.box, hit: p.hit,
    t: target === home ? "" : `translate(${f(p.to[0])} ${f(p.to[1])}) scale(${round2(p.sx)} ${round2(p.s)}) translate(${f(-p.from[0])} ${f(-p.from[1])})`,
  }));
}

const hits = (box, [x, y, r], pad = 3) => {
  const cx = Math.max(box[0], Math.min(x, box[2])), cy = Math.max(box[1], Math.min(y, box[3]));
  return (cx - x) ** 2 + (cy - y) ** 2 < (r + pad) ** 2;
};
// Satélite que não bate em nenhuma peça: o da forma, senão espelhado, senão um dos cantos de cima (por fim, colado ao quadro).
export function fitSat(target, boxes) {
  const { x, y, r } = target.sat;
  const clear = ([cx, cy]) => !boxes.some((b) => hits(b, [cx, cy, r]));
  return [[x, y], [256 - x, y], [220, 48], [36, 48], [228, 84], [28, 84], [253 - r, 3 + r], [3 + r, 3 + r]].find(clear) ?? [x, y];
}

function luveKit() {
  const shapes = {}, fit = {};
  for (const ch of CHARACTERS) {
    shapes[ch.id] = {
      name: ch.name, shape: ch.shape, body: ch.body, plate: ch.plate, eyes: ch.eyes, timing: ch.timing, glint: ch.glint ?? null,
      sat: ch.sat, face: ch.face ? ch.face(ch.plate, ch.eyes) : "", colors: ch.colors,
    };
    fit[ch.id] = {};
    for (const acc of LUVE_ACC) {
      const pieces = fitPieces(ch, acc), boxes = pieces.flatMap((p) => p.hit), [sx, sy] = fitSat(ch, boxes);
      const extra = (ch.sat.extra ?? []).map((e, i) => (boxes.some((b) => hits(b, [e[0], e[1], e[2]])) ? -1 : i)).filter((i) => i >= 0);
      fit[ch.id][acc.id] = {
        t: pieces.map((p) => p.t),
        ...(sx !== ch.sat.x || sy !== ch.sat.y ? { sat: [sx, sy] } : {}),
        ...(ch.sat.extra && extra.length !== ch.sat.extra.length ? { extra } : {}),
      };
    }
  }
  const T = { light: "{light}", base: "{base}", deep: "{deep}", rim: "{rim}" };
  const accessories = { nenhum: { name: "Nenhum", nameEn: "None", pieces: [] } };
  for (const acc of LUVE_ACC) {
    const out = ACC[acc.from](T, "{gear}"), used = {};
    if (acc.stem) { if (!out.back.includes(acc.stem[0])) throw new Error(`${acc.id}: haste não achada`); out.back = out.back.replace(...acc.stem); }
    accessories[acc.id] = {
      name: acc.name, nameEn: acc.nameEn, home: acc.home,
      pieces: acc.pieces.map(([layer, anchor, box, hit]) => {
        const all = acc.pieces.filter((p) => p[0] === layer).length;
        const parts = all > 1 ? out[layer].split(/(?=<g transform="rotate)/) : [out[layer]];
        if (parts.length !== all) throw new Error(`${acc.id}: ${layer} tem ${parts.length} partes, esperava ${all}`);
        const i = (used[layer] = (used[layer] ?? -1) + 1);
        return { layer, anchor, box, ...(hit ? { hit } : {}), svg: parts[i] };
      }),
    };
  }
  const materials = Object.fromEntries(LUVE_MATERIALS.map(([id, name, nameEn]) => [id, { name, nameEn, three: MATERIALS[id].three }]));
  const swatches = CHARACTERS.map((c) => ({ from: c.id, ...c.colors }));
  return { version: 1, shapes, materials, accessories, fit, swatches };
}
writeFileSync(join(HERE, "luve-kit.json"), JSON.stringify(luveKit()) + "\n");

// ---------- Arte dos estados vazios (Memória, Timeline, Sugestões) ----------
// Uma cena por estado: um personagem da família (o mesmo draw(), com as animações dele) e objetos simples. Vão como <img>,
// então não leem o tema do app: o traço LINE (luve-art.mjs) tem contraste ≥ 3:1 no fundo claro E no escuro, e os objetos têm
// miolo branco. Toda animação fica dentro de prefers-reduced-motion: no-preference (a do personagem e a dos objetos).
const EMPTY_CSS = `.e-float,.e-twinkle,.e-pulse{transform-box:fill-box;transform-origin:50% 50%}` +
  `@media (prefers-reduced-motion:no-preference){.e-float{animation:e-float 3.2s ease-in-out infinite alternate}` +
  `.e-twinkle{animation:e-twinkle 2.4s ease-in-out infinite}.e-twinkle.e-late{animation-delay:-1.2s}` +
  `.e-pulse{animation:e-pulse 2.2s ease-in-out infinite}}` +
  `@keyframes e-float{from{transform:translateY(0)}to{transform:translateY(-4px)}}` +
  `@keyframes e-twinkle{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}` +
  `@keyframes e-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.25)}}`;
const sparkle = (x, y, r, cls = "") => `<path class="e-twinkle${cls}" d="M${x},${y - r}Q${x},${y} ${x + r},${y}Q${x},${y} ${x},${y + r}Q${x},${y} ${x - r},${y}Q${x},${y} ${x},${y - r}Z" fill="#fbbf24" stroke="#b45309" stroke-width="1"/>`;
const actor = (id, x, y, w) => svg(CHARACTERS.find((c) => c.id === id), { title: false })
  .replace(/^<svg /, `<svg x="${x}" y="${y}" width="${w}" height="${w}" `).replace(/ role="img" aria-labelledby="[^"]*"/, "");
const scene = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 160" aria-hidden="true"><style>${EMPTY_CSS}</style>${body}</svg>\n`;

export const EMPTY_ART = {
  // Memória: o Luvi e um caderno ainda em branco (o Bot ainda não guardou nada).
  memory: scene(actor("luvi", 6, 14, 136) +
    `<g class="e-float"><rect x="150" y="44" width="70" height="88" rx="10" fill="#ffffff" stroke="${LINE}" stroke-width="2.5"/>` +
    `<path d="M162,44V132" stroke="${LINE}" stroke-width="2" opacity=".5"/>` +
    [66, 80, 94, 108].map((y) => `<path d="M172,${y}H208" stroke="${LINE}" stroke-width="2" stroke-linecap="round" opacity=".35"/>`).join("") +
    `<g transform="rotate(-38 214 120)"><rect x="196" y="115" width="40" height="10" rx="2" fill="#fde047" stroke="#b45309" stroke-width="1.5"/>` +
    `<path d="M196,115L196,125L184,120Z" fill="#f5d0a9" stroke="#b45309" stroke-width="1.5" stroke-linejoin="round"/></g></g>` +
    sparkle(224, 36, 7) + sparkle(146, 30, 5, " e-late")),
  // Timeline: o Tico ao lado de três raias vazias, com a marca de "agora" batendo devagar.
  timeline: scene(actor("tico", 0, 18, 128) +
    [46, 80, 114].map((y) => `<circle cx="138" cy="${y}" r="4" fill="#ffffff" stroke="${LINE}" stroke-width="2"/>` +
      `<path d="M148,${y}H230" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="1 9"/>`).join("") +
    `<path d="M206,30V130" stroke="${LINE}" stroke-width="2" stroke-linecap="round"/>` +
    `<circle class="e-pulse" cx="206" cy="26" r="6" fill="#ffffff" stroke="${LINE}" stroke-width="2.5"/>`),
  // Sugestões: o Faro, de lupa, e uma lâmpada ainda apagada com brilhos em volta (a ideia ainda vem).
  suggestions: scene(actor("faro", 4, 18, 132) +
    `<g class="e-float"><circle cx="190" cy="66" r="26" fill="#ffffff" stroke="${LINE}" stroke-width="2.5"/>` +
    `<path d="M180,72Q185,60 190,72Q195,60 200,72" fill="none" stroke="${LINE}" stroke-width="2" stroke-linecap="round" opacity=".6"/>` +
    `<path d="M181,90H199V104A6,6 0 0 1 193,110H187A6,6 0 0 1 181,104Z" fill="#ffffff" stroke="${LINE}" stroke-width="2.5" stroke-linejoin="round"/>` +
    `<path d="M183,97H197M183,103H197" stroke="${LINE}" stroke-width="2" stroke-linecap="round"/></g>` +
    sparkle(226, 40, 7) + sparkle(152, 44, 5, " e-late") + sparkle(228, 104, 5)),
};
const EMPTY = join(HERE, "empty");
rmSync(EMPTY, { recursive: true, force: true }); mkdirSync(EMPTY, { recursive: true });
for (const [k, v] of Object.entries(EMPTY_ART)) writeFileSync(join(EMPTY, `${k}.svg`), v);
console.log(`${CHARACTERS.length} mascotes gerados em ${HERE}`);

// ---------- Logo e wordmark (docs/images/logo/) ----------
const luvi = CHARACTERS[0];
const logoInner = svg(luvi, { title: false, still: true }).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 30 238 208" role="img" aria-label="LuveBot">${logoInner}</svg>\n`;
// Wordmark: letras vetorizadas do PNG oficial (trace_wordmark.py → wordmark-letters.json), no mesmo sistema de
// coordenadas dele; o Luvi ocupa a mesma caixa do mascote do PNG, então peso, espaço e proporção são os do original.
const WM = JSON.parse(readFileSync(join(HERE, "wordmark-letters.json"), "utf8"));
const wordmark = (ink) => {
  const [mx, my, mw, mh] = WM.mascot, [lx, ly, lw, lh] = WM.letters, pad = 24;
  const x0 = Math.min(mx, lx) - pad, y0 = Math.min(my, ly) - pad;
  const vb = `${x0} ${y0} ${Math.max(mx + mw, lx + lw) + pad - x0} ${Math.max(my + mh, ly + lh) + pad - y0}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img" aria-label="LuveBot">` +
    `<svg x="${mx}" y="${my}" width="${mw}" height="${mh}" viewBox="20 38 221 192">${logoInner}</svg>` +
    `<path d="${WM.d}" fill="${ink}" fill-rule="evenodd"/></svg>\n`;
};
const LOGO = join(HERE, "../../docs/images/logo");
writeFileSync(join(LOGO, "luvebot-logo.svg"), logo);
writeFileSync(join(LOGO, "luvebot-wordmark.svg"), wordmark("#0b0f19"));
writeFileSync(join(LOGO, "luvebot-wordmark-white.svg"), wordmark("#ffffff"));

// Ícone do app: normal (quadrado de cantos) e maskable (sangrado, mascote dentro do círculo seguro de 40%).
const TILE = {
  light: { top: "#ffffff", bottom: "#eceffe", rim: "#b9a8ff", glow: "#8f98ff" },
  dark: { top: "#161c33", bottom: "#0b0f19", rim: "#6a70f8", glow: "#3d5bff" },
};
const mascotAt = (x, y, w) => `<svg x="${x}" y="${y}" width="${w}" height="${f((w * 208) / 238)}" viewBox="12 30 238 208">${logoInner}</svg>`;
function appIcon(theme, maskable) {
  const t = TILE[theme], w = maskable ? 300 : 330, h = (w * 208) / 238;
  const bg = maskable ? `<rect width="512" height="512" fill="url(#lb-tile)"/>`
    : `<rect x="32" y="32" width="448" height="448" rx="104" fill="url(#lb-tile)" stroke="${t.rim}" stroke-opacity=".55" stroke-width="3"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="LuveBot">` +
    `<defs><linearGradient id="lb-tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.top}"/><stop offset="1" stop-color="${t.bottom}"/></linearGradient>` +
    `<radialGradient id="lb-glow"><stop offset="0" stop-color="${t.glow}" stop-opacity=".35"/><stop offset="1" stop-color="${t.glow}" stop-opacity="0"/></radialGradient></defs>` +
    bg + `<circle cx="256" cy="270" r="${f(w * 0.62)}" fill="url(#lb-glow)"/>` + mascotAt(f(256 - w / 2), f(262 - h / 2), w) + `</svg>\n`;
}
for (const theme of ["light", "dark"]) for (const m of [false, true])
  writeFileSync(join(LOGO, `luvebot-app-icon${m ? "-maskable" : ""}${theme === "dark" ? "-dark" : ""}.svg`), appIcon(theme, m));

// Favicon: só o rosto num ladrilho da cor da marca (lê em 16 px); no tema escuro o ladrilho clareia.
writeFileSync(join(LOGO, "luvebot-favicon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
  `<defs><linearGradient id="fl" x1=".2" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="#9a8cff"/><stop offset=".5" stop-color="#6a70f8"/><stop offset="1" stop-color="#2346f2"/></linearGradient>` +
  `<linearGradient id="fd" x1=".2" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="#b9adff"/><stop offset=".5" stop-color="#7f86ff"/><stop offset="1" stop-color="#3d5bff"/></linearGradient></defs>` +
  `<style>@media (prefers-color-scheme:dark){.t{fill:url(#fd)}}</style>` +
  `<rect class="t" x="1" y="1" width="30" height="30" rx="9" fill="url(#fl)"/><circle cx="25.5" cy="6.5" r="2.6" fill="#e4dcff"/>` +
  `<rect x="4.5" y="10.5" width="23" height="15.5" rx="7.75" fill="#fff"/>` +
  `<rect x="10" y="14" width="4" height="8.5" rx="2" fill="${INK}"/><rect x="18" y="14" width="4" height="8.5" rx="2" fill="${INK}"/></svg>\n`);

// --data ARQ: geometria dos mascotes em JSON (contornos amostrados da mesma curva dos SVGs), para a versão 3D.
const dataAt = process.argv.indexOf("--data");
if (dataAt > 0) {
  const data = CHARACTERS.map((ch) => {
    const pl = ch.plate, ey = ch.eyes;
    const box = `${pl.cx - pl.rx} ${pl.cy - pl.ry} ${pl.rx * 2} ${pl.ry * 2}`;
    const wink = ey.wink ? (() => {
      const x = pl.cx + ey.wink * ey.gap - ey.w / 2, y = pl.cy + ey.dy - ey.h / 2;
      return `<path d="M${f(x - 2)},${f(y + ey.h * 0.6)}Q${f(x + ey.w / 2)},${f(y + ey.h * 0.15)} ${f(x + ey.w + 2)},${f(y + ey.h * 0.6)}" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`;
    })() : "";
    return {
      id: ch.id, name: ch.name, role: ch.role, colors: ch.colors, acc: ch.acc ?? [], sat: ch.sat, eyes: ey,
      body: sample(ch.body, ch.body.length > 40 ? 2 : 12),
      plate: { ...pl, outline: sample(squircle(pl.cx, pl.cy, pl.rx, pl.ry, { e: pl.e, n: 16, lean: pl.lean ?? 0 }), 6) },
      // Boca, bochechas, sobrancelhas e piscadinha: decalque na placa (os olhos viram 3D).
      decal: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" width="512" height="${Math.round((512 * pl.ry) / pl.rx)}">${ch.face ? ch.face(pl, ey) : ""}${wink}</svg>`,
    };
  });
  writeFileSync(process.argv[dataAt + 1], JSON.stringify(data));
  console.log(`Dados 3D em ${process.argv[dataAt + 1]}`);
}

// --icons: PNGs do PWA e do favicon em docs/images/logo/png/ (sips do macOS reduz os pequenos).
if (process.argv.includes("--icons")) {
  const shell = process.env.CHROME ?? join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
  const out = join(LOGO, "png"); mkdirSync(out, { recursive: true });
  const shot = (svgFile, png, size) => {
    execFileSync(shell, ["--hide-scrollbars", "--default-background-color=00000000", "--window-size=512,512",
      `--screenshot=${join(out, png)}`, `file://${join(LOGO, svgFile)}`], { stdio: "ignore" });
    if (size !== 512) execFileSync("sips", ["-z", `${size}`, `${size}`, join(out, png)], { stdio: "ignore" });
  };
  for (const [svgFile, png, size] of [
    ["luvebot-app-icon-dark.svg", "icon-192.png", 192], ["luvebot-app-icon-dark.svg", "icon-512.png", 512],
    ["luvebot-app-icon.svg", "icon-light-192.png", 192], ["luvebot-app-icon.svg", "icon-light-512.png", 512],
    ["luvebot-app-icon-maskable-dark.svg", "icon-maskable-192.png", 192], ["luvebot-app-icon-maskable-dark.svg", "icon-maskable-512.png", 512],
    ["luvebot-app-icon-maskable.svg", "icon-maskable-light-512.png", 512],
    ["luvebot-app-icon-maskable-dark.svg", "apple-touch-icon.png", 180],
    ["luvebot-favicon.svg", "favicon-16.png", 16], ["luvebot-favicon.svg", "favicon-32.png", 32], ["luvebot-favicon.svg", "favicon-48.png", 48],
  ]) shot(svgFile, png, size);
  console.log(`Ícones em ${out}`);
}

const ri = process.argv.indexOf("--render");
if (ri > 0) {
  const out = process.argv[ri + 1] ?? join(homedir(), "Documents/Claude/luvebot-avatares");
  mkdirSync(out, { recursive: true });
  const shell = process.env.CHROME ?? join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
  const shot = (url, file, w, h) => execFileSync(shell, ["--hide-scrollbars", "--force-prefers-reduced-motion", "--default-background-color=00000000",
    `--window-size=${w},${h}`, `--screenshot=${join(out, file)}`, url], { stdio: "ignore" });
  for (const ch of CHARACTERS) shot(`file://${join(HERE, `${ch.id}.svg`)}`, `${ch.id}.png`, 1024, 1024);
  // Folha com a família: 5 colunas, transparente.
  const cols = 5, cell = 600, rows = Math.ceil(CHARACTERS.length / cols), sheet = join(out, "_folha.html");
  writeFileSync(sheet, `<html><body style="margin:0;display:grid;grid-template-columns:repeat(${cols},${cell}px)">` +
    CHARACTERS.map((ch) => `<img src="file://${join(HERE, `${ch.id}.svg`)}" width="${cell}" height="${cell}">`).join("") + "</body></html>");
  shot(`file://${sheet}`, "familia-luvebot.png", cols * cell, rows * cell);
  rmSync(sheet);
  console.log(`PNGs em ${out}`);
}
