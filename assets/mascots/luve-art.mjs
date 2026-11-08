// assets/mascots/luve-art.mjs: o desenho da família Luve, sem efeito colateral (nada de fs).
// Usado pelo build.mjs (os 15 mascotes aprovados saem daqui, byte a byte) e pela UI do "Crie seu Luve" (D-022), que monta
// um Luve só com as peças constantes de luve-kit.json e um hex conferido. Nenhum texto de fora entra no SVG.

export const f = (n) => +n.toFixed(1);
const P = (p) => `${f(p[0])},${f(p[1])}`;
export const INK = "#141833"; // olhos e traços: escuro em qualquer corpo

// ---------- Formas ----------
// Curva fechada suave (Catmull-Rom → Bézier). Ponto [x, y, k]: k=1 suave, k=0 quina.
function bezier(pts, i) {
  const n = pts.length, k = (j) => pts[(j + n) % n][2] ?? 1, at = (j) => pts[(j + n) % n];
  const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
  const c1 = [p1[0] + ((p2[0] - p0[0]) * k(i)) / 6, p1[1] + ((p2[1] - p0[1]) * k(i)) / 6];
  const c2 = [p2[0] - ((p3[0] - p1[0]) * k(i + 1)) / 6, p2[1] - ((p3[1] - p1[1]) * k(i + 1)) / 6];
  return [p1, c1, c2, p2];
}

export function smooth(pts) {
  let d = `M${P(pts[0])}`;
  for (let i = 0; i < pts.length; i++) { const [, c1, c2, p2] = bezier(pts, i); d += `C${P(c1)} ${P(c2)} ${P(p2)}`; }
  return d + "Z";
}

// Pontos da mesma curva do smooth() (contorno para o 3D e para os encaixes).
export function sample(pts, steps = 10) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const [p1, c1, c2, p2] = bezier(pts, i);
    for (let s = 0; s < steps; s++) {
      const t = s / steps, u = 1 - t;
      out.push([0, 1].map((d) => f(u * u * u * p1[d] + 3 * u * u * t * c1[d] + 3 * u * t * t * c2[d] + t * t * t * p2[d])));
    }
  }
  return out;
}

// Superelipse (e=2 elipse, e>2 mais quadrada). lean inclina, taper afina o topo.
export function squircle(cx, cy, rx, ry, { e = 2.5, n = 20, lean = 0, taper = 0, rot = 0 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
    let x = rx * Math.sign(c) * Math.abs(c) ** (2 / e), y = ry * Math.sign(s) * Math.abs(s) ** (2 / e);
    x *= 1 - taper * Math.max(0, -y / ry);
    x += lean * y;
    const r = (rot * Math.PI) / 180;
    return [cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r)];
  });
}

// ---------- Cor ----------
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export const mix = (a, b, t) => "#" + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, "0")).join("");
// Acessório: tom escuro da própria cor (lê no fundo claro) + filete claro (lê no escuro).
export const gear = (c) => mix(c.deep, INK, 0.4);

// Luminância relativa e contraste (WCAG 2).
export function luminance(h) {
  const [r, g, b] = hex(h).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

function toHsl(h) {
  const [r, g, b] = hex(h).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const H = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(H * 60 + 360) % 360, s, l];
}
function fromHsl(H, s, l) {
  H = ((H % 360) + 360) % 360; s = Math.min(1, Math.max(0, s)); l = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((H / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = H < 60 ? [c, x, 0] : H < 120 ? [x, c, 0] : H < 180 ? [0, c, x] : H < 240 ? [0, x, c] : H < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}

// Traço da arte dos estados vazios (build.mjs): contraste ≥ 3:1 contra os fundos claros E os escuros abaixo, sem ler o tema.
export const LINE = "#666c96";  // = edgeOf("#5b6186"): the slate of the family, moved into the band

// Fundos do app em que o Luve aparece (tema claro e escuro, incluindo a barra lateral escura).
export const BACKDROPS = { light: ["#ffffff", "#f5f6fa"], dark: ["#0b0f19", "#080c14", "#111827"] };
// Faixa de luminância do contorno com contraste ≥ 3:1 (WCAG 1.4.11) contra TODOS os fundos acima.
const EDGE_MIN = (Math.max(...BACKDROPS.dark.map(luminance)) + 0.05) * 3 - 0.05;
const EDGE_MAX = (Math.min(...BACKDROPS.light.map(luminance)) + 0.05) / 3 - 0.05;

// Contorno: o tom fundo da cor, com a luz ajustada até cair na faixa (mesmo matiz, então continua sendo "da cor").
export function edgeOf(deep) {
  const [H, s, l0] = toHsl(deep), L = luminance(deep);
  if (L >= EDGE_MIN + 0.01 && L <= EDGE_MAX - 0.01) return deep;
  const want = L < EDGE_MIN ? EDGE_MIN + 0.03 : EDGE_MAX - 0.03;
  let lo = 0, hi = 1, best = deep;
  for (let i = 0; i < 30; i++) { const l = (lo + hi) / 2; best = fromHsl(H, s, l); if (luminance(best) < want) lo = l; else hi = l; }
  return luminance(best) < EDGE_MIN || luminance(best) > EDGE_MAX ? fromHsl(H, s, l0 < 0.5 ? hi : lo) : best;
}

// Paleta de 4 tons a partir de uma cor só. Uma cor da família devolve a paleta aprovada dela.
export function paletteOf(base, swatches = []) {
  const own = swatches.find((s) => s.base === base);
  if (own) return { light: own.light, base, deep: own.deep, rim: own.rim };
  const [H, s, l] = toHsl(base);
  return {
    light: fromHsl(H + 8, Math.max(s, 0.35) * (s ? 1 : 0), 0.86 + l * 0.06),
    base,
    deep: fromHsl(H - 6, Math.min(1, s * 1.05), l * 0.62),
    rim: fromHsl(H - 35, s ? 0.85 : 0, 0.7),
  };
}

// ---------- Materiais (2D: realce, borda de luz e brilho; 3D: parâmetros do MeshPhysicalMaterial) ----------
// vinil = o desenho aprovado da família; os números dele não mudam.
export const MATERIALS = {
  vinil: { hl: ".75", rim: ".95", glint: ".5", stops: null,
    three: { roughness: 0.4, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.28, sheen: 0.25, sheenRoughness: 0.55 } },
  laca: { hl: ".95", rim: ".7", glint: ".95", spec: true, stops: null,
    three: { roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, sheen: 0, sheenRoughness: 0.5 } },
  fosco: { hl: ".22", rim: ".35", glint: null, stops: null,
    three: { roughness: 0.88, metalness: 0, clearcoat: 0, clearcoatRoughness: 1, sheen: 0.5, sheenRoughness: 0.85 } },
  metal: { hl: ".55", rim: ".6", glint: ".85", spec: true, stops: (c) => [[0, c.light], [0.3, c.base], [0.52, c.deep], [0.68, c.light], [1, c.deep]],
    three: { roughness: 0.3, metalness: 0.85, clearcoat: 0.35, clearcoatRoughness: 0.2, sheen: 0, sheenRoughness: 0.5 } },
};

// ---------- CSS compartilhado (mesmo texto em todo SVG: inline várias vezes não conflita) ----------
export const CSS = `
.m-eye,.m-body,.m-sat,.m-ping{transform-box:fill-box}
.m-eye{transform-origin:50% 50%}
.m-body{transform-origin:50% 100%}
.m-sat{transform-origin:50% 50%}
.m-orbit,.m-shadow{transform-box:view-box}
.m-ping{opacity:0;transform-origin:50% 50%}
.needs-you .m-sat-fill,#lb-needs-you:target .m-sat-fill{fill:#fbbf24}
.m-alert{opacity:0}.needs-you .m-alert,#lb-needs-you:target .m-alert{opacity:1}
.lb-face .m-orbit,.lb-face .m-shadow{display:none}
.m-prop,.m-float{transform-box:fill-box;transform-origin:50% 50%}
@media (prefers-reduced-motion:no-preference){
.m-eye{animation:lb-blink var(--blink,5s) var(--delay,0s) infinite}
.m-body{animation:lb-breathe var(--breathe,3.6s) var(--delay,0s) ease-in-out infinite alternate}
.m-gaze{animation:lb-look var(--look,11s) var(--delay,0s) ease-in-out infinite}
.m-face{animation:lb-look-soft var(--look,11s) var(--delay,0s) ease-in-out infinite}
.m-orbit{animation:lb-orbit var(--orbit,7s) linear infinite}
.m-sat{animation:lb-depth var(--orbit,7s) ease-in-out infinite}
.is-working .m-gaze,#lb-working:target .m-gaze{animation:none}
.is-working .m-pair,#lb-working:target .m-pair{animation:lb-scan 1.5s ease-in-out infinite}
.is-working .m-orbit,.is-working .m-sat,#lb-working:target .m-orbit,#lb-working:target .m-sat{animation-duration:1.8s}
.is-working .m-body,#lb-working:target .m-body{animation-duration:1.1s}
.needs-you .m-hop,#lb-needs-you:target .m-hop{animation:lb-hop 1.9s cubic-bezier(.3,.7,.4,1) infinite}
.needs-you .m-body,#lb-needs-you:target .m-body{animation:lb-squash 1.9s ease-in-out infinite}
.needs-you .m-shadow,#lb-needs-you:target .m-shadow{animation:lb-shadow 1.9s cubic-bezier(.3,.7,.4,1) infinite}
.needs-you .m-ping,#lb-needs-you:target .m-ping{animation:lb-ping 1.9s ease-out infinite}
.m-prop{animation:lb-prop .9s linear infinite}
.is-working .m-prop,#lb-working:target .m-prop{animation-duration:.22s}
.m-blinker{animation:lb-blinker 2.2s steps(1) infinite}
.is-working .m-blinker,#lb-working:target .m-blinker{animation-duration:.5s}
.m-float{animation:lb-float 3s ease-in-out infinite alternate}
.m-wobble{transform-box:fill-box;transform-origin:20% 80%;animation:lb-wobble 4s ease-in-out infinite}
.is-working .m-wobble,#lb-working:target .m-wobble{animation:lb-sweep 1.5s ease-in-out infinite}
}
@keyframes lb-blink{0%,16%,20%,59%,63%,64.5%,68.5%,100%{transform:scaleY(1)}18%,61%,66.5%{transform:scaleY(.08)}}
@keyframes lb-breathe{from{transform:scale(1,1)}to{transform:scale(1.025,.972)}}
@keyframes lb-look{0%,36%{transform:translate(0,0)}41%,54%{transform:translate(-4.5px,0)}59%,63%{transform:translate(0,0)}68%,80%{transform:translate(4px,-1.5px)}86%,100%{transform:translate(0,0)}}
@keyframes lb-look-soft{0%,36%{transform:translate(0,0)}41%,54%{transform:translate(-2px,0)}59%,63%{transform:translate(0,0)}68%,80%{transform:translate(2px,-.5px)}86%,100%{transform:translate(0,0)}}
@keyframes lb-scan{0%,100%{transform:translate(-5px,0)}50%{transform:translate(5px,0)}}
@keyframes lb-orbit{to{transform:rotate(360deg)}}
@keyframes lb-depth{0%,100%{transform:scale(1)}25%{transform:scale(1.12)}75%{transform:scale(.86)}}
@keyframes lb-hop{0%,46%,100%{transform:translateY(0)}20%{transform:translateY(var(--hop,-18px))}36%{transform:translateY(0)}41%{transform:translateY(calc(var(--hop,-18px)*.28))}}
@keyframes lb-squash{0%,46%,100%{transform:scale(1,1)}6%{transform:scale(1.07,.9)}14%{transform:scale(.95,1.06)}34%{transform:scale(1,1)}37%{transform:scale(1.06,.92)}43%{transform:scale(.99,1.01)}}
@keyframes lb-shadow{0%,36%,46%,100%{transform:scale(1);opacity:.16}20%{transform:scale(.72);opacity:.08}41%{transform:scale(.92)}}
@keyframes lb-ping{0%,30%{transform:scale(1);opacity:0}34%{opacity:.7}70%,100%{transform:scale(1.8);opacity:0}}
@keyframes lb-prop{0%,100%{transform:scaleX(1)}50%{transform:scaleX(-1)}}
@keyframes lb-float{from{transform:translateY(0)}to{transform:translateY(-4px)}}
@keyframes lb-blinker{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes lb-wobble{0%,100%{transform:rotate(0)}50%{transform:rotate(-6deg)}}
@keyframes lb-sweep{0%,100%{transform:translate(-4px,0) rotate(-4deg)}50%{transform:translate(6px,-3px) rotate(6deg)}}
`.trim().replace(/\n/g, "");

// ---------- Um personagem ----------
// d: { id, name?, role?, colors, body (pontos), plate, eyes, sat, timing, glint?, face (SVG do rosto), back, front, edge? }
// face=true: variante "rosto" (viewBox recortado na placa). still=true: sem CSS nem sombra (logo).
// cls: classes a mais na raiz (lb-face para o mini, is-working / needs-you para o estado). material: chave de MATERIALS.
export function draw(d, { title = true, face = false, still = false, cls = "", material = "vinil" } = {}) {
  const { id, colors: c, plate: pl, eyes: ey, sat, timing: t } = d;
  const m = MATERIALS[material];
  const body = smooth(d.body);
  const plate = smooth(squircle(pl.cx, pl.cy, pl.rx, pl.ry, { e: pl.e, n: 16, lean: pl.lean ?? 0 }));
  const xs = d.body.map((p) => p[0]), ys = d.body.map((p) => p[1]);
  const bx = Math.min(...xs), bw = Math.max(...xs) - bx, by = Math.min(...ys), bh = Math.max(...ys) - by;
  const ground = Math.max(...ys) + 8;
  const [gx, gy] = [bx + bw * (d.glint?.[0] ?? 0.33), by + bh * (d.glint?.[1] ?? 0.2)];
  const eye = (s) => {
    const x = pl.cx + s * ey.gap - ey.w / 2, y = pl.cy + ey.dy - ey.h / 2;
    if (ey.wink === s) return `<path d="M${f(x - 2)},${f(y + ey.h * 0.6)}Q${f(x + ey.w / 2)},${f(y + ey.h * 0.15)} ${f(x + ey.w + 2)},${f(y + ey.h * 0.6)}" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`;
    const shine = ey.shine ? `<circle cx="${f(x + ey.w * 0.34)}" cy="${f(y + ey.w * 0.42)}" r="${f(ey.w * 0.17)}" fill="#fff" opacity=".9"/>` : "";
    return `<g class="m-eye"><rect x="${f(x)}" y="${f(y)}" width="${ey.w}" height="${ey.h}" rx="${ey.w / 2}" fill="url(#${id}-eye)"/>${shine}</g>`;
  };
  const side = f(Math.max(pl.rx * 2 * 1.32, pl.ry * 2 * 1.9)), vx = f(pl.cx - side / 2), vy = f(pl.cy - 4 - side / 2);
  const vars = Object.entries(t).map(([k, v]) => `--${k}:${v}`).join(";") + (face ? ";--hop:-5px" : "");
  const satBall = (x, y, r, fill, extra = "") => `<circle${extra} cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>` +
    `<ellipse cx="${f(x - r * 0.3)}" cy="${f(y - r * 0.38)}" rx="${f(r * 0.38)}" ry="${f(r * 0.22)}" fill="#fff" opacity=".55" transform="rotate(-30 ${f(x - r * 0.3)} ${f(y - r * 0.38)})"/>`;
  const coin = sat.coin ? `<circle cx="${sat.x}" cy="${sat.y}" r="${f(sat.r * 0.68)}" fill="none" stroke="#a16207" stroke-opacity=".45" stroke-width="2"/><rect x="${f(sat.x - sat.r * 0.11)}" y="${f(sat.y - sat.r * 0.4)}" width="${f(sat.r * 0.22)}" height="${f(sat.r * 0.8)}" rx="${f(sat.r * 0.11)}" fill="#a16207" opacity=".55"/>` : "";
  const extra = (sat.extra ?? []).map(([x, y, r, col, o]) =>
    `<g class="m-orbit" style="transform-origin:${f(x - r * 0.5)}px ${f(y + r * 0.2)}px;--orbit:${o}"><g class="m-sat">${satBall(x, y, r, col)}</g></g>`).join("");
  const stops = m.stops ? m.stops(c).map(([o, col]) => `<stop offset="${o}" stop-color="${col}"/>`).join("")
    : `<stop offset="0" stop-color="${c.light}"/><stop offset=".48" stop-color="${c.base}"/><stop offset="1" stop-color="${c.deep}"/>`;
  const edge = d.edge ? `stroke="${d.edge}" stroke-width="2.2"` : `stroke="${c.deep}" stroke-opacity=".35" stroke-width="1.2"`;
  const glint = m.glint ? `<ellipse cx="${f(gx)}" cy="${f(gy)}" rx="${f(bw * 0.09)}" ry="${f(bh * 0.05)}" fill="#fff" opacity="${m.glint}" filter="url(#${id}-soft)" transform="rotate(-35 ${f(gx)} ${f(gy)})"/>` : "";
  const spec = m.spec ? `<ellipse cx="${f(gx)}" cy="${f(gy)}" rx="${f(bw * 0.045)}" ry="${f(bh * 0.018)}" fill="#fff" opacity=".9" transform="rotate(-35 ${f(gx)} ${f(gy)})"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${face ? `${vx} ${vy} ${side} ${side}` : "0 0 256 256"}" class="${cls ? cls + " " : ""}lb-mascot lb-${id}${face ? " lb-face" : ""}" style="${vars}" role="img" aria-labelledby="${id}-title">
${title ? `<title id="${id}-title">${d.name}, ${d.role.toLowerCase()} do LuveBot</title>` : ""}
<defs>
<linearGradient id="${id}-g" x1=".25" y1="0" x2=".8" y2="1">${stops}</linearGradient>
<radialGradient id="${id}-hl" cx=".4" cy=".08" r=".55"><stop offset="0" stop-color="#fff" stop-opacity="${m.hl}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<radialGradient id="${id}-rim" cx=".04" cy=".78" r=".5"><stop offset="0" stop-color="${c.rim}" stop-opacity="${m.rim}"/><stop offset="1" stop-color="${c.rim}" stop-opacity="0"/></radialGradient>
<linearGradient id="${id}-plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${mix("#ffffff", c.base, 0.14)}"/></linearGradient>
<linearGradient id="${id}-eye" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b3060"/><stop offset="1" stop-color="${INK}"/></linearGradient>
<radialGradient id="${id}-sat" cx=".32" cy=".28" r=".8">${sat.coin ? `<stop offset="0" stop-color="#fef9c3"/><stop offset=".5" stop-color="#facc15"/><stop offset="1" stop-color="#ca8a04"/>` : `<stop offset="0" stop-color="${mix(c.light, "#ffffff", 0.5)}"/><stop offset=".55" stop-color="${c.base}"/><stop offset="1" stop-color="${c.deep}"/>`}</radialGradient>
<clipPath id="${id}-clip"><path d="${body}"/></clipPath>
<filter id="${id}-blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7"/></filter>
<filter id="${id}-soft" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="4"/></filter>
</defs>
${still ? "" : `<style>${CSS}</style>`}
<g id="lb-working"><g id="lb-needs-you">
${still ? "" : `<ellipse class="m-shadow" cx="128" cy="${f(ground)}" rx="${f(bw * 0.34)}" ry="6" fill="#0b0f19" opacity=".16" filter="url(#${id}-soft)" style="transform-origin:128px ${f(ground)}px"/>`}
<g class="m-hop">
<g class="m-orbit" style="transform-origin:${sat.x - sat.r * 0.45}px ${sat.y + sat.r * 0.2}px"><g class="m-sat">
${still ? "" : `<circle class="m-ping" cx="${sat.x}" cy="${sat.y}" r="${sat.r}" fill="none" stroke="#fbbf24" stroke-width="3"/>`}
${satBall(sat.x, sat.y, sat.r, `url(#${id}-sat)`, ` class="m-sat-fill"${d.edge ? ` stroke="${d.edge}" stroke-width="1.5"` : ""}`)}${coin}
</g></g>${extra}
<g class="m-body">
${d.back ?? ""}
<path d="${body}" fill="url(#${id}-g)" ${edge}/>
<g clip-path="url(#${id}-clip)">
<rect x="${f(bx)}" y="${f(by)}" width="${f(bw)}" height="${f(bh)}" fill="url(#${id}-rim)"/>
<rect x="${f(bx)}" y="${f(by)}" width="${f(bw)}" height="${f(bh)}" fill="url(#${id}-hl)"/>
${glint}${spec}
</g>
<g class="m-face">
<path d="${plate}" fill="#fff" opacity=".55" filter="url(#${id}-blur)"/>
<path d="${plate}" fill="url(#${id}-plate)"/>
<g class="m-gaze"><g class="m-pair">${eye(-1)}${eye(1)}</g></g>
${d.face ?? ""}
</g>
${d.front ?? ""}
</g>
</g>
${face ? `<circle class="m-alert" cx="${f(vx + side * 0.86)}" cy="${f(vy + side * 0.14)}" r="${f(side * 0.075)}" fill="#fbbf24" stroke="#fff" stroke-width="${f(side * 0.025)}"/>` : ""}
</g></g>
</svg>`;
}
