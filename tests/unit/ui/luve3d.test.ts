// tests/unit/ui/luve3d.test.ts
// K2 do "Crie seu Luve" (proposta §5 e §8 Q2): o 3D lê o mesmo kit da K1. Confere: toda peça do kit tem a sua versão 3D, a
// transformação 2D vira a mesma no 3D, o rosto é lido como dado (só ellipse/path/rect) e nada de SVG vira imagem, a receita
// é conferida antes de desenhar, three.js tem versão fixa e fica SÓ no arquivo à parte (o bundle principal não o importa).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error módulo JS do 3D, sem tipos
import { PIECES, faceOps, pieceMatrix, frame, buildLuve3d } from "@/luve3d/mascot3d.js";
import { KIT, SHAPES, ACCESSORY_IDS } from "../../../assets/mascots/luve.mjs";

const root = process.cwd();
const U = 1 / 256;
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

describe("Crie seu Luve: 3D (K2)", () => {
  it("toda peça de acessório do kit tem a sua construção 3D, na mesma ordem", () => {
    const accs = ACCESSORY_IDS.filter((a: string) => a !== "nenhum");
    expect(Object.keys(PIECES).sort()).toEqual([...accs].sort());
    for (const a of accs) expect(PIECES[a].length, a).toBe(KIT.accessories[a].pieces.length);
  });

  it("a transformação que o build gravou para o 2D leva cada ponto ao MESMO lugar no 3D, em toda forma × acessório", () => {
    for (const s of SHAPES) for (const a of ACCESSORY_IDS.filter((x: string) => x !== "nenhum")) {
      const acc = KIT.accessories[a], H = frame(acc.home), T = frame(s);
      acc.pieces.forEach((p: { box: number[] }, i: number) => {
        const t = KIT.fit[s][a].t[i], m = pieceMatrix(t, H.yb, T.yb);
        for (const [x, y] of [[p.box[0], p.box[1]], [p.box[2], p.box[3]]]) {
          const [X, Y] = H.P(x, y);
          // no 2D: x' = tx + sx·(x + fx); no 3D: o mesmo ponto pela moldura da forma de destino
          const n = t ? t.match(/-?[\d.]+/g)!.map(Number) : [0, 0, 1, 1, 0, 0];
          const [x2, y2] = t ? [n[0] + n[2] * (x + n[4]), n[1] + n[3] * (y + n[5])] : [x, y];
          const [X2, Y2] = T.P(x2, y2);
          expect(X * m.sx + m.ox, `${s}/${a}#${i}`).toBeCloseTo(X2, 6);
          expect(Y * m.sy + m.oy, `${s}/${a}#${i}`).toBeCloseTo(Y2, 6);
        }
      });
      if (s === acc.home) expect(KIT.fit[s][a].t.every((t: string) => !t)).toBe(true);
    }
    expect(() => pieceMatrix("matrix(1 0 0 1 0 0)", 200, 200)).toThrow();
    expect(U).toBeGreaterThan(0);
  });

  it("o rosto do kit é lido como dado: só <ellipse>, <path> e <rect> com atributos conhecidos; qualquer outra coisa é erro", () => {
    for (const s of SHAPES) {
      const face = KIT.shapes[s].face;
      expect(faceOps(face).length, s).toBe((face.match(/</g) ?? []).length);
    }
    for (const bad of ['<script>alert(1)</script>', '<image href="https://x/y.png"/>', '<ellipse cx="1" onload="x()"/>',
      '<path d="M0,0" style="fill:url(https://x)"/>', '<ellipse cx="1"/><foreignObject/>', '<rect x="1"/>trailing'])
      expect(() => faceOps(bad), bad).toThrow();
  });

  it("buildLuve3d confere a receita antes de desenhar (fail closed)", () => {
    const ok = { shape: "nimbo", material: "fosco", accessory: "lupa", hex: "38bdf8" };
    for (const bad of [null, { ...ok, hex: "38BDF8" }, { ...ok, hex: '"/><script>' }, { ...ok, shape: "constructor" }, { ...ok, accessory: "__proto__" }])
      expect(buildLuve3d(bad), JSON.stringify(bad)).toBeNull();
  });

  it("three.js com versão FIXA e só no arquivo à parte: nada fora de luve3d/ importa three; o bundle principal não o contém", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(root, "package.json"), "utf8"));
    expect(pkg.devDependencies.three).toBe("0.170.0");
    const src = path.resolve(root, "dashboard/src");
    for (const f of walk(src).filter((f) => /\.(t|j)sx?$/.test(f) && !f.includes(`${path.sep}luve3d${path.sep}`)))
      expect(fs.readFileSync(f, "utf8"), path.relative(root, f)).not.toMatch(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']three(?:\/|["'])|luve3d\/(?:index|mascot3d)/);
    const main = fs.readFileSync(path.resolve(root, "dashboard/dist/index.js"), "utf8");
    expect(main).not.toMatch(/WebGLRenderer|three\.js authors/i);
    const lazy = fs.readFileSync(path.resolve(root, "dashboard/dist/luve3d.js"), "utf8");
    expect(lazy).toContain("__LUVEBOT_LUVE3D__");
    expect(lazy).toMatch(/three\.js authors/i); // a licença MIT do three vai junto (legalComments)
  });

  it("o código do 3D não busca nada de fora nem monta HTML: sem fetch, import(), XMLHttpRequest, eval, innerHTML, Image()", () => {
    for (const f of walk(path.resolve(root, "dashboard/src/luve3d")).filter((f) => f.endsWith(".js")))
      expect(fs.readFileSync(f, "utf8"), path.relative(root, f)).not.toMatch(/\bfetch\(|\bimport\(|XMLHttpRequest|\beval\(|new Function|innerHTML|new Image\(|createObjectURL|image\/svg/);
  });
});
