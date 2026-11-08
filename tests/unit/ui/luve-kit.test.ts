// tests/unit/ui/luve-kit.test.ts
// K1 do "Crie seu Luve" (D-022; proposta docs/propostas/v02-crie-seu-luve.md §3, §4 e §8): o kit de peças constantes.
// Confere: as listas fixas, que toda peça existe e encaixa em toda forma (dentro do quadro, sem cobrir os olhos nem o
// satélite), o contraste nos dois temas para qualquer cor, a varredura de segurança (§8 condição 2) nas peças e numa
// amostra de receitas montadas, e que a receita só vira SVG quando confere (fail closed).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { KIT, SHAPES, MATERIAL_IDS, ACCESSORY_IDS, parseLuve, formatLuve, luvePalette, buildLuveSvg } from "../../../assets/mascots/luve.mjs";
// @ts-expect-error idem
import { BACKDROPS, INK, contrast, mix } from "../../../assets/mascots/luve-art.mjs";

type Box = [number, number, number, number];
const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.resolve(root, "assets/mascots/manifest.json"), "utf8")) as Array<{ id: string }>;
const ACCS = ACCESSORY_IDS.filter((a: string) => a !== "nenhum");

// A transformação que o build gravou, aplicada à caixa da peça.
function placed(t: string, box: Box): Box {
  if (!t) return box;
  const m = /^translate\((-?[\d.]+) (-?[\d.]+)\) scale\((-?[\d.]+) (-?[\d.]+)\) translate\((-?[\d.]+) (-?[\d.]+)\)$/.exec(t);
  expect(m, t).not.toBeNull();
  const [tx, ty, sx, sy, fx, fy] = m!.slice(1).map(Number);
  const map = (x: number, y: number) => [tx + sx * (x + fx), ty + sy * (y + fy)];
  const [a, b] = [map(box[0], box[1]), map(box[2], box[3])];
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}
const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const hitsCircle = (b: Box, x: number, y: number, r: number) => {
  const cx = Math.max(b[0], Math.min(x, b[2])), cy = Math.max(b[1], Math.min(y, b[3]));
  return (cx - x) ** 2 + (cy - y) ** 2 < r * r;
};

// §8 condição 2: nada que execute, navegue ou busque fora.
const FORBIDDEN = /<script|\son[a-z]+\s*=|\bhref\s*=|xlink:|<foreignObject|<!ENTITY|<!DOCTYPE|@import|url\(\s*["']?(?!#)/i;

describe("Crie seu Luve: kit (K1)", () => {
  it("as listas fixas: 15 formas = a família, 4 materiais, 13 acessórios; ids só [a-z]", () => {
    expect([...SHAPES].sort()).toEqual(manifest.map((m) => m.id).sort());
    expect(MATERIAL_IDS).toEqual(["vinil", "laca", "fosco", "metal"]);
    expect(ACCESSORY_IDS).toEqual(["nenhum", "headset", "lupa", "helice", "antena", "lapis", "check", "balao", "barras", "boina", "coracao", "cadeado", "sinos"]);
    for (const id of [...SHAPES, ...MATERIAL_IDS, ...ACCESSORY_IDS]) expect(id).toMatch(/^[a-z]+$/);
    for (const id of MATERIAL_IDS) expect(KIT.materials[id].three).toBeTruthy(); // parâmetros do 3D (K2)
    expect(KIT.swatches.map((s: { from: string }) => s.from)).toEqual(manifest.map((m) => m.id));
  });

  it("toda peça existe, tem camada, encaixe e caixa; toda forma tem o encaixe de todo acessório", () => {
    for (const a of ACCS) {
      const acc = KIT.accessories[a];
      expect(acc.pieces.length, a).toBeGreaterThan(0);
      for (const p of acc.pieces) {
        expect(["back", "front"]).toContain(p.layer);
        expect(p.svg, a).toMatch(/^<[a-z]/);
        expect(p.box).toHaveLength(4);
      }
      for (const s of SHAPES) expect(KIT.fit[s][a].t, `${s}/${a}`).toHaveLength(acc.pieces.length);
    }
  });

  it("na forma de origem o acessório fica onde a arte aprovada pôs (transformação vazia, satélite no lugar)", () => {
    for (const a of ACCS) {
      const home = KIT.accessories[a].home, fit = KIT.fit[home][a];
      expect(fit.t.every((t: string) => t === ""), `${home}/${a}`).toBe(true);
      expect(fit.sat, `${home}/${a}`).toBeUndefined();
    }
  });

  it("em toda forma × acessório: as peças cabem no quadro, nenhuma peça da frente cobre os olhos, nenhuma bate no satélite", () => {
    for (const s of SHAPES) {
      const sh = KIT.shapes[s], pl = sh.plate, ey = sh.eyes;
      const eyes: Box[] = [-1, 1].map((k) => {
        const x = pl.cx + k * ey.gap - ey.w / 2, y = pl.cy + ey.dy - ey.h / 2;
        return [x, y, x + ey.w, y + ey.h];
      });
      for (const a of ACCS) {
        const fit = KIT.fit[s][a], [sx, sy] = fit.sat ?? [sh.sat.x, sh.sat.y];
        KIT.accessories[a].pieces.forEach((p: { layer: string; box: Box; hit?: Box[] }, i: number) => {
          const b = placed(fit.t[i], p.box), where = `${s}/${a}#${i} ${b.map(Math.round)}`;
          expect(b[0] >= 0 && b[1] >= 0 && b[2] <= 256 && b[3] <= 256, where).toBe(true);
          for (const h of (p.hit ?? [p.box]).map((x) => placed(fit.t[i], x))) {  // peça oca: as caixas que seguem a curva
            if (p.layer === "front") for (const e of eyes) expect(overlaps(h, e), `${where} cobre um olho`).toBe(false);
            expect(hitsCircle(h, sx, sy, sh.sat.r), `${where} bate no satélite`).toBe(false);
          }
        });
      }
    }
  });

  it("contraste nos dois temas para QUALQUER cor: contorno ≥ 3:1 contra todos os fundos, olhos ≥ 4,5:1 na placa", () => {
    const steps = [0, 0x33, 0x66, 0x99, 0xcc, 0xff].map((v) => v.toString(16).padStart(2, "0"));
    const colors = steps.flatMap((r) => steps.flatMap((g) => steps.map((b) => r + g + b)))
      .concat(KIT.swatches.map((s: { base: string }) => s.base.slice(1)), ["0b0f19", "f5f6fa", "808080", "7f7f7f"]);
    for (const hex of colors) {
      const c = luvePalette(hex);
      for (const bg of [...BACKDROPS.light, ...BACKDROPS.dark]) expect(contrast(c.edge, bg), `${hex} contorno em ${bg}`).toBeGreaterThanOrEqual(3);
      // o contorno pinta a silhueta, o satélite e o tom dos acessórios ({gear})
      const svg = buildLuveSvg({ shape: "nimbo", material: "vinil", accessory: "antena", hex });
      expect(svg, hex).toContain(`fill="url(#luve-g)" stroke="${c.edge}"`);
      expect(svg, hex).toContain(`class="m-sat-fill" stroke="${c.edge}"`);
      expect(svg, hex).toContain(`<path d="M128,128V40" stroke="${c.gear}"`);
      // o tom dos acessórios se separa do corpo, ou é o próprio contorno (que lê nos dois temas)
      expect(contrast(c.gear, c.base) >= 2.5 || c.gear === c.edge, `${hex} acessório`).toBe(true);
      expect(contrast(INK, mix("#ffffff", c.base, 0.14)), `${hex} olhos`).toBeGreaterThanOrEqual(4.5);
      for (const k of ["light", "base", "deep", "rim", "edge", "gear"] as const) expect(c[k], `${hex} ${k}`).toMatch(/^#[0-9a-f]{6}$/);
    }
    // uma cor da família devolve a paleta aprovada dela
    expect(luvePalette("6a70f8")).toMatchObject({ light: "#c4b2ff", base: "#6a70f8", deep: "#2346f2", rim: "#22c3f7" });
  });

  it("varredura (§8): peças, rostos e uma amostra de receitas montadas sem script, on*=, href, foreignObject, ENTITY/DOCTYPE, url() de fora, @import", () => {
    for (const a of ACCS) for (const p of KIT.accessories[a].pieces) expect(p.svg, a).not.toMatch(FORBIDDEN);
    for (const s of SHAPES) expect(KIT.shapes[s].face, s).not.toMatch(FORBIDDEN);
    const hexes = ["000000", "ffffff", "ff0000", "00ff00", "0000ff", "fde047", "6a70f8"];
    let n = 0;
    for (const s of SHAPES) for (const m of MATERIAL_IDS) for (const a of ACCESSORY_IDS) {
      const hex = hexes[n++ % hexes.length], svg = buildLuveSvg({ shape: s, material: m, accessory: a, hex });
      expect(svg, `${s}.${m}.${a}.${hex}`).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(svg, `${s}.${m}.${a}.${hex}`).not.toMatch(FORBIDDEN);
      expect(svg, `${s}.${m}.${a}.${hex}`).not.toMatch(/\{(light|base|deep|rim|gear)\}/); // nenhum token sobrou
    }
    expect(n).toBe(15 * 4 * 13);
  });

  it("receita canônica: só <forma>.<material>.<acessorio>.<rrggbb> com ids das listas (fail closed)", () => {
    expect(parseLuve("nimbo.fosco.lupa.38bdf8")).toEqual({ shape: "nimbo", material: "fosco", accessory: "lupa", hex: "38bdf8" });
    expect(formatLuve(parseLuve("luvi.vinil.nenhum.6a70f8")!)).toBe("luvi.vinil.nenhum.6a70f8");
    for (const bad of ["nimbo.fosco.lupa.38BDF8", "nimbo.fosco.lupa.#38bdf8", "Nimbo.fosco.lupa.38bdf8", "nimbo.fosco.lupa.38bdf8.x",
      "nimbo.fosco.lupa", "nimbo.ouro.lupa.38bdf8", "nimbo.fosco.espada.38bdf8", "gato.fosco.lupa.38bdf8", " nimbo.fosco.lupa.38bdf8",
      "nimbo.fosco.lupa.38bdf8\n", "constructor.fosco.lupa.38bdf8", "nimbo.fosco.__proto__.38bdf8", "https://x/y.svg", "", 7, null, ["nimbo"]])
      expect(parseLuve(bad), String(bad)).toBeNull();
  });

  it("buildLuveSvg confere de novo: hex ou id fora da lista → null; estado e mini vão na CLASSE da raiz (§8 condição 3)", () => {
    const ok = { shape: "nimbo", material: "fosco", accessory: "lupa", hex: "38bdf8" };
    expect(buildLuveSvg(null)).toBeNull();
    for (const bad of [{ hex: "38BDF8" }, { hex: '"/><script>' }, { hex: "38bdf8 " }, { shape: "constructor" }, { material: "__proto__" }, { accessory: "toString" }])
      expect(buildLuveSvg({ ...ok, ...bad }), JSON.stringify(bad)).toBeNull();
    const root = (svg: string | null) => /^<svg [^>]*class="([^"]*)"/.exec(svg!)![1];
    expect(root(buildLuveSvg(ok))).toBe("lb-mascot lb-luve");
    expect(root(buildLuveSvg(ok, "working"))).toBe("is-working lb-mascot lb-luve");
    expect(root(buildLuveSvg(ok, "needs_you", true))).toBe("lb-face needs-you lb-mascot lb-luve");
    expect(buildLuveSvg(ok)).toContain("prefers-reduced-motion:no-preference"); // animação só sem movimento reduzido
  });
});
