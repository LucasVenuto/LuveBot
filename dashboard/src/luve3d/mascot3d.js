// dashboard/src/luve3d/mascot3d.js: o Luve em 3D a partir de uma RECEITA (D-022; proposta docs/propostas/v02-crie-seu-luve.md
// §5 e §8, fatia K2). Vem do mascot3d.js dos Reels (mesma pelúcia inflada, mesmos degradês), agora lendo o kit da K1:
// a forma e o rosto de assets/mascots/luve-kit.json, a cor por luvePalette, o material pelos parâmetros do kit, e cada peça de
// acessório no lugar que o build calculou para o 2D (a mesma transformação, levada ao espaço 3D). Nada vem de fora: os ids
// só escolhem peças constantes e o hex é conferido (isRecipe) antes de qualquer coisa.
// Unidade: 1 = 256 px do SVG. Origem: centro x do SVG, base do corpo no chão (y = 0).
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { INK, mix, sample, squircle } from "../../../assets/mascots/luve-art.mjs";
import { KIT, isRecipe, luvePalette } from "../../../assets/mascots/luve.mjs";

const U = 1 / 256;
const lin = (h) => new THREE.Color(h); // sRGB → espaço de trabalho linear

// Material macio: pelúcia de vinil (o "vinil" do kit); os outros materiais trocam só os números.
const soft = (color, o = {}) => new THREE.MeshPhysicalMaterial({
  color, roughness: 0.4, clearcoat: 0.4, clearcoatRoughness: 0.28, sheen: 0.25, sheenRoughness: 0.55, sheenColor: new THREE.Color("#ffffff"), ...o,
});
const gloss = (color, o = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08, ...o });

// ---------- Geometria inflada ----------
const prof = (s, p = 2.4, q = 0.42) => Math.pow(Math.max(0, 1 - Math.pow(s, p)), q);
const ccw = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length]; a += x0 * y1 - x1 * y0; }
  return a > 0 ? pts : pts.slice().reverse();
};

// Fração s (0 no centro, 1 na borda) de um ponto, pelo raio que sai do centro.
function sOf(outline, c, X, Y) {
  const dx = X - c[0], dy = Y - c[1];
  if (Math.abs(dx) + Math.abs(dy) < 1e-9) return 0;
  let best = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const [ax, ay] = outline[i], [bx, by] = outline[(i + 1) % outline.length];
    const ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((ax - c[0]) * ey - (ay - c[1]) * ex) / den, u = ((ax - c[0]) * dy - (ay - c[1]) * dx) / den;
    if (t > 1e-9 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best === Infinity ? 1 : 1 / best;
}

// Superfície fechada: frente com profundidade dF, verso com dB, costura na borda (normais contínuas).
function pillow(outline, c, dF, dB, { rings = 22, uv = null, color = null } = {}) {
  outline = ccw(outline);
  const n = outline.length, R = rings, pos = [], idx = [], uvs = [], cols = [];
  const push = (x, y, z) => {
    pos.push(x, y, z);
    if (uv) uvs.push(...uv(x, y));
    if (color) cols.push(...color(x, y, z));
  };
  const ringPt = (k, i, d) => {
    const s = Math.sin(((k / R) * Math.PI) / 2), [ox, oy] = outline[i];
    return [c[0] + (ox - c[0]) * s, c[1] + (oy - c[1]) * s, d * prof(s)];
  };
  push(c[0], c[1], dF);
  for (let k = 1; k <= R; k++) for (let i = 0; i < n; i++) push(...ringPt(k, i, dF));
  const B0 = pos.length / 3;
  push(c[0], c[1], -dB);
  for (let k = 1; k < R; k++) for (let i = 0; i < n; i++) push(...ringPt(k, i, -dB));
  const F = (k, i) => 1 + (k - 1) * n + (i % n);
  const B = (k, i) => (k === R ? F(R, i) : B0 + 1 + (k - 1) * n + (i % n));
  for (let i = 0; i < n; i++) {
    idx.push(0, F(1, i), F(1, i + 1));
    idx.push(B0, B(1, i + 1), B(1, i));
    for (let k = 1; k < R; k++) {
      idx.push(F(k, i), F(k + 1, i), F(k + 1, i + 1), F(k, i), F(k + 1, i + 1), F(k, i + 1));
      idx.push(B(k, i), B(k + 1, i + 1), B(k + 1, i), B(k, i), B(k, i + 1), B(k + 1, i + 1));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  if (uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  if (color) g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function rod(a, b, r, mat) {
  const d = new THREE.Vector3().subVectors(b, a), m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 16), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  return m;
}
const ball = (r, mat) => new THREE.Mesh(new THREE.SphereGeometry(r, 32, 24), mat);
const disc = (r, h, mat) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 48), mat); m.rotation.x = Math.PI / 2; return m; };

// ---------- Moldura de uma forma: do SVG (x, y) para o 3D, e a profundidade da superfície ----------
// Mesma amostragem do `build.mjs --data` dos Reels, então o corpo é o mesmo.
export function frame(id) {
  const s = KIT.shapes[id], pl = s.plate;
  const body = sample(s.body, s.body.length > 40 ? 2 : 12);
  const xs = body.map((p) => p[0]), ys = body.map((p) => p[1]);
  const yb = Math.max(...ys), bx = Math.min(...xs), bw = Math.max(...xs) - bx, by = Math.min(...ys), bh = yb - by;
  const P = (x, y) => [(x - 128) * U, (yb - y) * U];
  const V3 = (x, y, z = 0) => new THREE.Vector3(...P(x, y), z);
  const body2 = body.map(([x, y]) => P(x, y)), cB = P(pl.cx, pl.cy);
  const dF = Math.min(bw, bh) * U * 0.3, dB = dF * 0.78;
  const zf = (x, y) => { const [X, Y] = P(x, y); return dF * prof(Math.min(1, sOf(body2, cB, X, Y))); };
  const outline = sample(squircle(pl.cx, pl.cy, pl.rx, pl.ry, { e: pl.e, n: 16, lean: pl.lean ?? 0 }), 6);
  return { s, pl, yb, bx, bw, by, bh, P, V3, body2, cB, dF, dB, zf, outline };
}

// A transformação 2D que o build gravou para a peça ("translate(tx ty) scale(sx sy) translate(fx fy)", ou "" na forma de
// origem), levada ao 3D: X' = sx·X + ox, Y' = sy·Y + oy, Z' = |sy|·Z. Mesma conta de x' = tx + sx·(x + fx) nos dois espaços.
export function pieceMatrix(t, homeYb, targetYb) {
  if (!t) return { sx: 1, sy: 1, ox: 0, oy: (targetYb - homeYb) * U };
  const m = /^translate\((-?[\d.]+) (-?[\d.]+)\) scale\((-?[\d.]+) (-?[\d.]+)\) translate\((-?[\d.]+) (-?[\d.]+)\)$/.exec(t);
  if (!m) throw new Error("luve3d: transformação fora do formato do kit");
  const [tx, ty, sx, sy, fx, fy] = m.slice(1).map(Number);
  return { sx, sy, ox: (tx + sx * (128 + fx) - 128) * U, oy: (targetYb - ty - sy * (homeYb + fy)) * U };
}

// ---------- Rosto (boca, bochechas, sobrancelhas, piscadinha) desenhado no canvas ----------
// O rosto do kit é SVG nosso, gerado no build, só com <ellipse>, <path> e <rect>. Ele é lido como DADO (tag e atributos
// conhecidos) e redesenhado com a API do canvas: nenhum SVG é carregado como imagem. Tag ou atributo fora da lista = erro.
const FACE_ATTRS = new Set(["cx", "cy", "rx", "ry", "fill", "opacity", "d", "stroke", "stroke-width", "stroke-linecap", "x", "y", "width", "height", "transform"]);
export function faceOps(svg) {
  const ops = [], re = /<(ellipse|path|rect)\s+((?:[a-z-]+="[^"<>]*"\s*)*)\/>/gy;
  let m, at = 0;
  while ((m = re.exec(svg))) {
    const attrs = {};
    for (const [, k, v] of m[2].matchAll(/([a-z-]+)="([^"<>]*)"/g)) {
      if (!FACE_ATTRS.has(k)) throw new Error(`luve3d: atributo ${k} fora do rosto`);
      attrs[k] = v;
    }
    ops.push({ tag: m[1], ...attrs });
    at = re.lastIndex;
  }
  if (at !== svg.length) throw new Error("luve3d: rosto com algo além de ellipse/path/rect");
  return ops;
}

function drawFace(ctx, ops, k, ox, oy) {
  for (const o of ops) {
    ctx.save();
    ctx.setTransform(k, 0, 0, k, -ox * k, -oy * k);
    const rot = o.transform && /^rotate\((-?[\d.]+) (-?[\d.]+) (-?[\d.]+)\)$/.exec(o.transform);
    if (rot) { const [a, x, y] = rot.slice(1).map(Number); ctx.translate(x, y); ctx.rotate((a * Math.PI) / 180); ctx.translate(-x, -y); }
    ctx.globalAlpha = o.opacity ? Number(o.opacity) : 1;
    const path = new Path2D();
    if (o.tag === "ellipse") path.ellipse(+o.cx, +o.cy, +o.rx, +o.ry, 0, 0, Math.PI * 2);
    else if (o.tag === "rect") path.roundRect(+o.x, +o.y, +o.width, +o.height, +(o.rx ?? 0));
    else path.addPath(new Path2D(o.d));
    if (o.fill && o.fill !== "none") { ctx.fillStyle = o.fill; ctx.fill(path); }
    if (o.stroke) { ctx.strokeStyle = o.stroke; ctx.lineWidth = +(o["stroke-width"] ?? 1); ctx.lineCap = o["stroke-linecap"] ?? "butt"; ctx.stroke(path); }
    ctx.restore();
  }
}

// Piscadinha: o olho fechado vira traço no decalque (o 2D desenha o mesmo traço no lugar do olho).
const winkPath = (pl, ey) => {
  const x = pl.cx + ey.wink * ey.gap - ey.w / 2, y = pl.cy + ey.dy - ey.h / 2, f = (n) => +n.toFixed(1);
  return `<path d="M${f(x - 2)},${f(y + ey.h * 0.6)}Q${f(x + ey.w / 2)},${f(y + ey.h * 0.15)} ${f(x + ey.w + 2)},${f(y + ey.h * 0.6)}" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`;
};

// ---------- Acessórios: cada peça do kit, construída na forma de ORIGEM dela (H) ----------
// Índice = posição da peça em luve-kit.json (accessories.<id>.pieces); o teste confere que as duas listas batem.
export const PIECES = {
  headset: [
    (H, M, acc) => { // arco
      const band = new THREE.CubicBezierCurve3(H.V3(40, 150), H.V3(38, 30), H.V3(218, 30), H.V3(216, 150));
      acc.add(new THREE.Mesh(new THREE.TubeGeometry(band, 80, 4.2 * U, 12), M.gear));
    },
    (H, M, acc) => { // conchas e microfone
      for (const x of [39, 217]) {
        const cup = new THREE.Mesh(new THREE.CapsuleGeometry(12 * U, 18 * U, 8, 20), M.gear);
        cup.position.copy(H.V3(x, 147, 0)); cup.scale.z = 1.5; acc.add(cup);
        const pad = new THREE.Mesh(new THREE.CapsuleGeometry(4 * U, 20 * U, 6, 12), M.light);
        pad.position.copy(H.V3(x, 147, 0)); pad.position.x += (x < 128 ? -1 : 1) * 11 * U; acc.add(pad);
      }
      const mic = new THREE.QuadraticBezierCurve3(H.V3(40, 165, 0), H.V3(44, 200, H.dF * 0.6), H.V3(86, 204, H.zf(86, 204) + 0.02));
      acc.add(new THREE.Mesh(new THREE.TubeGeometry(mic, 40, 2.6 * U, 8), M.gear));
      const mb = ball(7 * U, M.gear); mb.position.copy(H.V3(90, 203, H.zf(90, 203) + 0.03)); acc.add(mb);
    },
  ],
  lupa: [(H, M, acc) => {
    const z = H.zf(207, 191) + 0.05, ring = new THREE.Mesh(new THREE.TorusGeometry(19 * U, 3.4 * U, 16, 48), M.gear);
    ring.position.copy(H.V3(207, 191, z)); acc.add(ring);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(18 * U, 48), new THREE.MeshPhysicalMaterial({ color: "#ffffff", roughness: 0.05, transparent: true, opacity: 0.28, clearcoat: 1 }));
    glass.position.copy(H.V3(207, 191, z)); acc.add(glass);
    acc.add(rod(H.V3(221, 205, z), H.V3(238, 223, z), 4.8 * U, M.gear));
  }],
  helice: [(H, M, acc) => {
    const depth = (H.dF + H.dB) * 0.62, cz = (H.dF - H.dB) / 2;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), soft("#fbbf24"));
    cap.scale.set(43 * U, 34 * U, depth); cap.position.copy(H.V3(141, 80, cz)); acc.add(cap);
    const brim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 10, 64), soft("#fb7185"));
    brim.rotation.x = Math.PI / 2; brim.scale.set(44 * U, depth * 1.02, 0.12); brim.position.copy(H.V3(141, 74, cz)); acc.add(brim);
    acc.add(rod(H.V3(141, 48, cz), H.V3(141, 30, cz), 2.2 * U, M.gear));
    const prop = new THREE.Group(); prop.position.copy(H.V3(141, 28, cz)); prop.name = "prop";
    for (const [s, col] of [[-1, "#fb7185"], [1, "#38bdf8"]]) {
      const b = ball(1, gloss(col)); b.scale.set(11 * U, 3 * U, 6 * U); b.position.x = s * 11 * U; prop.add(b);
    }
    prop.add(ball(3.6 * U, M.gear)); prop.rotation.y = 0.5; acc.add(prop);
  }],
  antena: [
    (H, M, acc) => acc.add(rod(H.V3(128, 128, 0), H.V3(128, 42, 0), 2.4 * U, M.gear)), // haste até dentro do corpo, como no kit
    (H, M, acc) => {
      const bulb = ball(6.5 * U, new THREE.MeshStandardMaterial({ color: "#4ade80", emissive: "#4ade80", emissiveIntensity: 2.2 }));
      bulb.position.copy(H.V3(128, 36, 0)); bulb.name = "bulb"; acc.add(bulb);
    },
  ],
  lapis: [(H, M, acc) => {
    const p = new THREE.Group(); p.position.copy(H.V3(204, 92, -H.dB * 0.2)); p.rotation.z = (38 * Math.PI) / 180;
    const seg = (x0, x1, r0, r1, mat, sides = 6) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, (x1 - x0) * U, sides), mat);
      m.rotation.z = -Math.PI / 2; m.position.x = ((x0 + x1) / 2 - 204) * U; p.add(m);
    };
    seg(170, 220, 7 * U, 7 * U, soft("#fde047"));
    seg(219, 224, 7.2 * U, 7.2 * U, gloss("#cbd5e1", { metalness: 0.8 }), 20);
    seg(224, 234, 7 * U, 6.5 * U, soft("#fb7185"), 20);
    seg(156, 170, 0.6 * U, 7 * U, soft("#f5d0a9"));
    seg(151, 157, 0.1 * U, 2 * U, gloss(INK), 12);
    acc.add(p);
  }],
  check: [(H, M, acc) => {
    const z = H.zf(200, 196) + 0.02, b = disc(18 * U, 5 * U, M.white); b.position.copy(H.V3(200, 196, z)); acc.add(b);
    const r = new THREE.Mesh(new THREE.TorusGeometry(18 * U, 1.6 * U, 8, 48), M.deep); r.position.copy(H.V3(200, 196, z + 2.5 * U)); acc.add(r);
    const pts = [H.V3(191, 196, z + 3.5 * U), H.V3(198, 203, z + 3.5 * U), H.V3(210, 189, z + 3.5 * U)];
    acc.add(rod(pts[0], pts[1], 2.4 * U, M.green), rod(pts[1], pts[2], 2.4 * U, M.green));
    for (const q of pts) { const j = ball(2.4 * U, M.green); j.position.copy(q); acc.add(j); }
  }],
  balao: [
    (H, M, acc) => { // nó e cordão
      const knot = new THREE.Mesh(new THREE.ConeGeometry(9 * U, 13 * U, 20), M.deep); knot.position.copy(H.V3(128, 231, 0)); acc.add(knot);
      const str = new THREE.QuadraticBezierCurve3(H.V3(128, 237, 0), H.V3(118, 245, 0), H.V3(129, 254, 0));
      acc.add(new THREE.Mesh(new THREE.TubeGeometry(str, 20, 1.3 * U, 6), M.gear));
    },
    (H, M, acc) => { // broche de seta para cima
      const z = H.zf(72, 194) + 0.02, b = disc(15 * U, 5 * U, M.white); b.position.copy(H.V3(72, 194, z)); acc.add(b);
      const zz = z + 3.5 * U, a = [H.V3(72, 202, zz), H.V3(72, 186, zz), H.V3(65, 192, zz), H.V3(72, 185, zz), H.V3(79, 192, zz)];
      acc.add(rod(a[0], a[1], 2 * U, M.green), rod(a[2], a[3], 2 * U, M.green), rod(a[3], a[4], 2 * U, M.green));
    },
  ],
  barras: [(H, M, acc) => {
    const z = H.zf(195, 198) + 0.02, t = new THREE.Mesh(new RoundedBoxGeometry(38 * U, 32 * U, 8 * U, 4, 7 * U), M.white);
    t.position.copy(H.V3(195, 198, z)); acc.add(t);
    [[187, 14, "#60a5fa"], [196, 20, M.deepHex], [205, 10, "#34d399"]].forEach(([x, h, col]) => {
      const b = new THREE.Mesh(new RoundedBoxGeometry(6 * U, h * U, 4 * U, 2, 2.5 * U), gloss(col)); b.position.copy(H.V3(x, 207 - h / 2, z + 4 * U)); acc.add(b);
    });
  }],
  boina: [(H, M, acc) => {
    const b = new THREE.Group(); b.position.copy(H.V3(124, 56, (H.dF - H.dB) / 2)); b.rotation.z = (14 * Math.PI) / 180; b.rotation.x = -0.18;
    const top = ball(1, M.gear); top.scale.set(42 * U, 12 * U, (H.dF + H.dB) * 0.6); b.add(top);
    const nub = ball(4.5 * U, M.gear); nub.position.y = 13 * U; b.add(nub);
    acc.add(b);
  }],
  coracao: [(H, M, acc) => {
    const b = new THREE.Group(); b.position.copy(H.V3(41, 28, H.dF * 0.7)); b.name = "float";
    b.add(new THREE.Mesh(new RoundedBoxGeometry(58 * U, 36 * U, 10 * U, 4, 10 * U), M.white));
    const tail = new THREE.Mesh(new THREE.ConeGeometry(6 * U, 12 * U, 12), M.white); tail.position.set(-3 * U, -22 * U, 0); tail.rotation.z = -0.5; b.add(tail);
    const h = new THREE.Shape(), q = (x, y) => [(x - 41) * U, (28 - y) * U];
    h.moveTo(...q(41, 38)); h.bezierCurveTo(...q(29, 30), ...q(33, 18), ...q(41, 24)); h.bezierCurveTo(...q(49, 18), ...q(53, 30), ...q(41, 38));
    const hm = new THREE.Mesh(new THREE.ExtrudeGeometry(h, { depth: 3 * U, bevelEnabled: true, bevelThickness: 1.5 * U, bevelSize: 1.2 * U, bevelSegments: 3 }), M.base);
    hm.position.z = 5 * U; b.add(hm);
    acc.add(b);
  }],
  cadeado: [(H, M, acc) => {
    const z = H.zf(128, 210) + 0.02, body = new THREE.Mesh(new RoundedBoxGeometry(34 * U, 25 * U, 12 * U, 4, 6 * U), M.gear);
    body.position.copy(H.V3(128, 210.5, z)); acc.add(body);
    const metal = gloss("#cbd5e1", { metalness: 0.8 });
    const sh = new THREE.Mesh(new THREE.TorusGeometry(10 * U, 2.6 * U, 10, 24, Math.PI), metal);
    sh.position.copy(H.V3(128, 194, z)); acc.add(sh);
    for (const x of [118, 138]) acc.add(rod(H.V3(x, 194, z), H.V3(x, 201, z), 2.6 * U, metal));
    const kh = ball(3.5 * U, M.light); kh.position.copy(H.V3(128, 207, z + 6 * U)); acc.add(kh);
  }],
  sinos: [90, 166].map((x, i) => (H, M, acc) => {
    const a = i ? 28 : -28, b = new THREE.Group(); b.position.copy(H.V3(x, 72, -0.01)); b.rotation.z = (-a * Math.PI) / 180;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(19 * U, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), M.gear); dome.scale.z = 0.8; b.add(dome);
    const knob = ball(3.5 * U, M.gear); knob.position.y = 21 * U; b.add(knob);
    acc.add(b);
  }),
};

// ---------- O Luve ----------
/** O Luve da receita, como THREE.Group. state: "working" | "needs_you" | outro. null se a receita não confere. */
export function buildLuve3d(recipe, { state = "idle" } = {}) {
  if (!isRecipe(recipe)) return null;
  const T = frame(recipe.shape), { s, pl, P, V3, body2, cB, dF, dB, zf, bx, bw, by, bh, yb } = T, ey = s.eyes;
  const c = luvePalette(recipe.hex), mat = KIT.materials[recipe.material].three;

  // Cor por vértice: os mesmos degradês do SVG (linear topo→base, brilho lateral, reflexo do topo).
  const [L, Mid, D, Rm, W] = [c.light, c.base, c.deep, c.rim, "#ffffff"].map(lin);
  const tmp = new THREE.Color();
  const color = (X, Y, Z) => {
    const u = (X / U + 128 - bx) / bw, v = (yb - Y / U - by) / bh;
    const t = Math.min(1, Math.max(0, ((u - 0.25) * 0.55 + v) / (0.55 * 0.55 + 1)));
    tmp.copy(t < 0.48 ? L : Mid).lerp(t < 0.48 ? Mid : D, t < 0.48 ? t / 0.48 : (t - 0.48) / 0.52);
    const rim = Math.max(0, 1 - Math.hypot(u - 0.04, v - 0.78) / 0.5) * 0.95;
    tmp.lerp(Rm, rim * rim);
    const hl = Math.max(0, 1 - Math.hypot(u - 0.4, v - 0.08) / 0.55) * 0.55;
    tmp.lerp(W, hl * hl);
    if (Z < 0) tmp.multiplyScalar(0.82);
    return [tmp.r, tmp.g, tmp.b];
  };

  const g = new THREE.Group();
  const bodyMesh = new THREE.Mesh(pillow(body2, cB, dF, dB, { rings: 26, color }), soft("#ffffff", { vertexColors: true, sheenColor: lin(c.light), ...mat }));
  g.add(bodyMesh);

  // Placa do rosto: almofada fina que segue a curva do corpo; decalque com boca e bochechas.
  const plate2 = T.outline.map(([x, y]) => P(x, y));
  const pxs = plate2.map((p) => p[0]), pys = plate2.map((p) => p[1]);
  const [pminX, pmaxX, pminY, pmaxY] = [Math.min(...pxs), Math.max(...pxs), Math.min(...pys), Math.max(...pys)];
  const dP = 0.028;
  const plateGeo = pillow(plate2, cB, dP, 0.002, { rings: 14, uv: (X, Y) => [(X - pminX) / (pmaxX - pminX), (Y - pminY) / (pmaxY - pminY)] });
  const pp = plateGeo.attributes.position;
  for (let i = 0; i < pp.count; i++) pp.setZ(i, pp.getZ(i) + dF * prof(Math.min(1, sOf(body2, cB, pp.getX(i), pp.getY(i)))) - 0.006);
  plateGeo.computeVertexNormals();
  const canvas = document.createElement("canvas");
  canvas.width = 512; canvas.height = Math.round((512 * pl.ry) / pl.rx);
  const ctx = canvas.getContext("2d"), grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, "#ffffff"); grad.addColorStop(1, mix("#ffffff", c.base, 0.14));
  ctx.fillStyle = grad; ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawFace(ctx, faceOps(s.face + (ey.wink ? winkPath(pl, ey) : "")), 512 / (pl.rx * 2), pl.cx - pl.rx, pl.cy - pl.ry);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const plateMesh = new THREE.Mesh(plateGeo, soft("#ffffff", { map: tex, roughness: 0.5, clearcoat: 0.2, sheen: 0.3, emissive: "#ffffff", emissiveIntensity: 0.1, emissiveMap: tex }));
  g.add(plateMesh);
  const plateZ = (x, y) => { const [X, Y] = P(x, y); return zf(x, y) - 0.006 + dP * prof(Math.min(1, sOf(plate2, cB, X, Y))); };

  // Olhos: cápsulas laqueadas sobre a placa (a piscadinha fica no decalque).
  const eyes = new THREE.Group(), eyeMat = gloss(INK);
  for (const k of [-1, 1]) {
    if (ey.wink === k) continue;
    const ex = pl.cx + k * ey.gap, eyy = pl.cy + ey.dy, r = (ey.w / 2) * U;
    const e = new THREE.Mesh(new THREE.CapsuleGeometry(r, (ey.h - ey.w) * U, 8, 20), eyeMat);
    e.scale.z = 0.42;
    e.position.copy(V3(ex, eyy, plateZ(ex, eyy) + r * 0.12));
    if (ey.shine) { const sh = ball(r * 0.34, new THREE.MeshBasicMaterial({ color: "#ffffff" })); sh.position.set(-r * 0.3, (ey.h * U) / 2 - r * 1.15, r * 0.42); e.add(sh); }
    eyes.add(e);
  }
  if (state === "working") eyes.position.x = 4 * U;
  g.add(eyes);

  // Acessório: cada peça construída na forma de origem e levada ao lugar que o build calculou para esta forma.
  const accKit = KIT.accessories[recipe.accessory], fit = accKit.pieces.length ? KIT.fit[recipe.shape][recipe.accessory] : { t: [] };
  const M = {
    gear: soft(c.gear, { roughness: 0.5 }), light: soft(c.light), white: soft("#ffffff", { roughness: 0.35 }), deep: soft(c.deep),
    base: gloss(c.base), green: gloss("#16a34a"), deepHex: c.deep,
  };
  const acc = new THREE.Group();
  if (accKit.pieces.length) {
    const H = frame(accKit.home);
    PIECES[recipe.accessory].forEach((build, i) => {
      const piece = new THREE.Group(), m = pieceMatrix(fit.t[i], H.yb, yb);
      build(H, M, piece);
      piece.scale.set(m.sx, m.sy, Math.abs(m.sy));
      piece.position.set(m.ox, m.oy, 0);
      // peça da frente: assenta na superfície DESTA forma (a profundidade muda de forma para forma), pelo ponto mais alto
      // sob a caixa dela (centro e cantos): o centro pode cair num vão do contorno, como entre os lobos da Quadra.
      if (accKit.pieces[i].layer === "front") {
        const [x0, y0, x1, y1] = accKit.pieces[i].box, pts = [[(x0 + x1) / 2, (y0 + y1) / 2], [x0, y0], [x1, y0], [x0, y1], [x1, y1]];
        const onT = ([hx, hy]) => { const [X, Y] = H.P(hx, hy); return zf((X * m.sx + m.ox) / U + 128, yb - (Y * m.sy + m.oy) / U); };
        piece.position.z = Math.max(...pts.map(onT)) - Math.abs(m.sy) * Math.max(...pts.map(([hx, hy]) => H.zf(hx, hy)));
      }
      acc.add(piece);
    });
  }
  g.add(acc);

  // Satélite (no lugar que o kit escolheu quando o acessório ocupa o dele; os extras do Rumo que sobram).
  const at = fit.sat ?? [s.sat.x, s.sat.y], extra = fit.extra ? fit.extra.map((i) => s.sat.extra[i]) : s.sat.extra ?? [];
  const satC = state === "needs_you" ? "#fbbf24" : s.sat.coin ? "#facc15" : mix(c.light, c.base, 0.55);
  const sat = new THREE.Group();
  const s0 = s.sat.coin
    ? (() => { const m = disc(s.sat.r * U, s.sat.r * U * 0.3, gloss(satC, { metalness: 0.85, roughness: 0.28 })); const ring = new THREE.Mesh(new THREE.TorusGeometry(s.sat.r * U * 0.68, 1.2 * U, 8, 40), gloss("#a16207", { metalness: 0.8 })); ring.position.z = s.sat.r * U * 0.15; m.add(ring); return m; })()
    : ball(s.sat.r * U, gloss(satC));
  s0.position.copy(V3(at[0], at[1], dF * 0.3));
  sat.add(s0);
  if (state === "needs_you") {
    const ping = new THREE.Mesh(new THREE.TorusGeometry(s.sat.r * U * 1.6, 1.4 * U, 8, 48), new THREE.MeshBasicMaterial({ color: "#fbbf24", transparent: true, opacity: 0.55 }));
    ping.position.copy(s0.position);
    sat.add(ping);
  }
  for (const [x, y, r, col] of extra) { const m = ball(r * U, gloss(col)); m.position.copy(V3(x, y, dF * 0.3)); sat.add(m); }
  g.add(sat);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData = { height: bh * U, width: bw * U, depth: dF + dB };
  return g;
}
