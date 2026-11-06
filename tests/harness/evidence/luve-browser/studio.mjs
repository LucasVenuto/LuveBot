// Crie seu Luve, componentes REAIS em Chrome real (CDP), sem backend: abre o estúdio, escolhe nos 4 passos, baixa o PNG, usa, e confere
// o que o navegador de fato desenhou. Desktop (WebGL por software), celular (emulação) e escuro. Escreve out/studio-result.json e out/studio-*.png.
//   node studio.mjs        (REPO=<worktree do main com dist/>, OUT=<pasta>, PORTS=proxy,cdp)
import fs from "node:fs";
import path from "node:path";
import { buildGlue, startStatic, launchChrome, PROXY_URL, sleep, OUT } from "./lib.mjs";

await buildGlue("glue-studio.tsx", "glue-studio.js");
fs.writeFileSync(path.join(OUT, "page.html"), `<!doctype html><html lang="pt-BR"><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>studio</title>
<link rel="stylesheet" href="/dashboard-plugins/luvebot/dist/style.css"><body style="margin:0"><div id="root"></div><script src="/glue-studio.js"></script>`);
const srv = startStatic();
const downloads = path.join(OUT, "downloads");
fs.rmSync(downloads, { recursive: true, force: true });
const chrome = await launchChrome({ downloads, extraArgs: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] });
const results = { chrome: chrome.version, date: new Date().toISOString(), runs: [] };
const net = [], problems = [], dl = [];
chrome.on((m) => {
  if (m.method === "Network.requestWillBeSent") net.push(m.params.request.url);
  if (m.method === "Runtime.exceptionThrown") problems.push("EXC " + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  if (m.method === "Log.entryAdded" && ["error", "warning"].includes(m.params.entry.level)) problems.push(m.params.entry.level + " " + m.params.entry.text.slice(0, 200) + " " + (m.params.entry.url ?? ""));
  if (m.method === "Browser.downloadWillBegin") dl.push({ name: m.params.suggestedFilename, state: "begin" });
  if (m.method === "Browser.downloadProgress" && m.params.state !== "inProgress") dl.push({ state: m.params.state, guid: m.params.guid });
});

const ANALYZE = `async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext("2d"); x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let n = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1, corner = d[3];
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 16) { n++; const p = i / 4, px = p % c.width, py = (p / c.width) | 0; if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py; }
  return { w: bmp.width, h: bmp.height, opaqueFraction: +(n / (c.width * c.height)).toFixed(3), bbox: [minx, miny, maxx, maxy], cornerAlpha: corner };
}`;

async function runStudio(label, { width, height, mobile, dark, picks }) {
  const run = { label, viewport: `${width}x${height}${mobile ? " mobile" : ""}${dark ? " dark" : ""}`, checks: [] };
  const check = (name, pass, detail) => { run.checks.push({ name, pass: !!pass, detail }); console.log(pass ? "  ok  " : "  FAIL", label, name, detail === undefined ? "" : JSON.stringify(detail).slice(0, 160)); };
  results.runs.push(run);
  const tab = await chrome.newTab(null);
  const s = tab.sessionId;
  await chrome.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile: !!mobile }, s);
  await chrome.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] }, s);
  if (mobile) await chrome.send("Emulation.setTouchEmulationEnabled", { enabled: true }, s);
  await chrome.send("Page.navigate", { url: PROXY_URL + "/?scheme=" + (dark ? "dark" : "light") }, s);
  const ev = (expr, o) => chrome.ev(s, expr, o);
  const until = async (expr, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(150); } return false; };
  const clickAll = (sel, i) => ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!e) return false; e.click(); return true; })()`, { gesture: true });

  check("o estúdio abre como diálogo", await until(`!!document.querySelector('[role=dialog] .lb-luve-preview-art')`));
  const webgl = await ev(`(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); })()`);
  const is3d = await until(`document.querySelector('.lb-luve-preview-art')?.dataset.view === '3d'`, 12000);
  const view = await ev(`document.querySelector('.lb-luve-preview-art')?.dataset.view`);
  run.preview = { webgl, view };
  check("prévia: 3D quando há WebGL, 2D (plano B) quando não", webgl ? view === "3d" : view === "2d", { webgl, view });
  await chrome.shot(s, `studio-${label}-1-aberto.png`);

  const L = await ev(`({ shapes: __luve.SHAPES, materials: __luve.MATERIAL_IDS, accessories: __luve.ACCESSORY_IDS, swatches: __luve.KIT.swatches.map(x => x.base.slice(1).toLowerCase()) })`);
  const [pShape, pColor, pMat, pAcc] = picks;
  const want = { shape: L.shapes[pShape], hex: L.swatches[pColor], material: L.materials[pMat], accessory: L.accessories[pAcc] };
  const expected = `${want.shape}.${want.material}.${want.accessory}.${want.hex}`;
  run.expected = expected;
  // the primary action must be on screen without scrolling the sheet (on a phone the sheet's body scrolls, its footer must not leave)
  const footer = () => ev(`(() => { const sheet = document.querySelector('.lb-dialog').getBoundingClientRect(); const f = [...document.querySelectorAll('.lb-luve-actions .lb-btn, .lb-dialog-footer .lb-btn')].map((b) => b.getBoundingClientRect()); const body = document.querySelector('.lb-dialog-body'); return { ih: innerHeight, sheet: [Math.round(sheet.top), Math.round(sheet.bottom)], footer: f.map((r) => [Math.round(r.top), Math.round(r.bottom)]), bodyScrolls: body.scrollHeight > body.clientHeight + 1, scrollTop: body.scrollTop }; })()`);
  const inView = (g) => g.footer.length > 0 && g.footer.every(([top, bottom]) => top >= g.sheet[0] && bottom <= Math.min(g.sheet[1], g.ih) + 1);
  const next = () => ev(`(() => { const b = document.querySelector('.lb-dialog-footer .lb-btn-primary'); b.click(); return b.textContent; })()`, { gesture: true });
  const feet = [];
  check("passo 1 (forma)", await clickAll(".lb-luve-opt", pShape)); feet.push(await footer()); await next();
  check("passo 2 (cor)", await clickAll(".lb-luve-swatch", pColor)); feet.push(await footer()); await next();
  check("passo 3 (material)", await clickAll(".lb-luve-opt", pMat)); feet.push(await footer()); await next();
  check("passo 4 (acessório)", await clickAll(".lb-luve-opt", pAcc)); feet.push(await footer());
  run.footers = feet;
  check("Surpreenda-me, Baixar PNG e Voltar / Próximo / Usar aparecem inteiros na tela, sem rolar a janela, nos 4 passos", feet.every(inView), feet.map((g) => `${g.footer.map((r) => r.join("-")).join(",")} sheet ${g.sheet.join("-")} ih ${g.ih}`));
  await sleep(500);
  const summary = await ev(`document.querySelector('.lb-luve-summary').textContent`);
  check("o resumo diz a cor escolhida", summary.includes("#" + want.hex), summary);
  const last = await ev(`document.querySelector('.lb-dialog-footer .lb-btn-primary').textContent`);
  check("no último passo o botão é 'Usar em vendas'", last.trim() === "Usar em vendas", last);
  await chrome.shot(s, `studio-${label}-2-ultimo-passo.png`);

  // geometry: nothing overflows the phone, and the dialog is inside the viewport
  const geo = await ev(`(() => { const d = document.querySelector('[role=dialog]').getBoundingClientRect(); const b = [...document.querySelectorAll('[role=dialog] button')].map(x => x.getBoundingClientRect()); return { sw: document.documentElement.scrollWidth, iw: innerWidth, ih: innerHeight, dialog: [Math.round(d.left), Math.round(d.top), Math.round(d.right), Math.round(d.bottom)], minBtn: Math.round(Math.min(...b.map(r => Math.min(r.width, r.height)))) }; })()`);
  run.geometry = geo;
  check("sem rolagem horizontal da página", geo.sw <= geo.iw, geo);
  check("o diálogo cabe na largura da tela", geo.dialog[0] >= 0 && geo.dialog[2] <= geo.iw, geo.dialog);

  // PNG download: the browser's own save, then the file's bytes
  const before = dl.length;
  check("Baixar PNG", await ev(`(() => { const b = [...document.querySelectorAll('.lb-luve-actions .lb-btn')].find(x => x.textContent.trim() === 'Baixar PNG'); if (!b) return false; b.click(); return true; })()`, { gesture: true }));
  const done = await (async () => { const t = Date.now(); while (Date.now() - t < 20000) { if (dl.slice(before).some((d) => d.state === "completed")) return true; await sleep(200); } return false; })();
  const file = path.join(downloads, `luve-${want.shape}.png`);
  check("o navegador salvou luve-<forma>.png", done && fs.existsSync(file), { file: path.basename(file), downloads: dl.slice(before) });
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    const sig = buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    check("arquivo é PNG 1024 x 1024", sig && w === 1024 && h === 1024, { sig, w, h, bytes: buf.length });
    const stats = await ev(`(${ANALYZE})(${JSON.stringify(buf.toString("base64"))})`);
    run.png = stats;
    check("PNG: fundo transparente e o personagem desenhado (não em branco)", stats.cornerAlpha === 0 && stats.opaqueFraction > 0.1 && stats.opaqueFraction < 0.9, stats);
    fs.copyFileSync(file, path.join(OUT, `studio-${label}-luve.png`));
  }

  // use it: what the studio hands out is the canonical recipe, and the face is drawn from it
  await next();
  await sleep(600);
  const used = await ev(`H.used.slice()`);
  check("onUse recebeu a receita escolhida, e só uma vez", used.length === 1 && used[0] === expected, { used, expected });
  check("o estúdio fechou ao usar", !(await ev(`!!document.querySelector('[role=dialog]')`)));
  const faces = await ev(`(async () => {
    const out = [];
    for (const img of document.querySelectorAll('#faces img')) {
      const text = await (await fetch(img.src)).text();
      const other = ${JSON.stringify(expected)}.replace(/[0-9a-f]{6}$/, (h) => h === 'ff00ff' ? '00ff00' : 'ff00ff');
      out.push({ negative: ['', 'working', 'needs_you'].some((st) => [false, true].some((mini) => text === __luve.expectSvg(other, st || undefined, mini))), blob: img.src.startsWith('blob:'), w: img.naturalWidth, complete: img.complete, svg: text.slice(0, 40), matches: ['', 'working', 'needs_you'].flatMap((st) => [false, true].map((mini) => text === __luve.expectSvg(${JSON.stringify(expected)}, st || undefined, mini) ? (st || 'idle') + (mini ? '/mini' : '/whole') : null)).filter(Boolean) });
    }
    return out;
  })()`);
  run.faces = faces;
  check("6 rostos desenhados (24/40/64/96 + trabalhando + precisa de você)", faces.length === 6, faces.length);
  check("cada rosto é <img blob:> carregada, e o SVG é byte a byte o que o kit manda para a receita", faces.every((f) => f.blob && f.w > 0 && f.complete && f.matches.length > 0), faces.map((f) => f.matches.join("|")));
  check("controle negativo: o SVG de outra cor (mesma receita) NÃO bate com nenhum rosto", faces.every((f) => !f.negative));
  await chrome.shot(s, `studio-${label}-3-rostos.png`);

  // blob lifecycle: opening the studio makes tile URLs, closing it (Esc) releases them
  const n1 = await ev(`__luve.liveLuveUrls()`);
  await ev(`H.reopen()`); await until(`!!document.querySelector('[role=dialog] .lb-luve-opt')`);
  const n2 = await ev(`__luve.liveLuveUrls()`);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`); await sleep(500);
  const n3 = await ev(`__luve.liveLuveUrls()`);
  const closed = await ev(`H.closed`), usedAfter = await ev(`H.used.length`);
  check("abrir o estúdio cria URLs de prévia e fechar (Esc) devolve todas", n2 > n1 && n3 === n1, { faces: n1, open: n2, afterEsc: n3 });
  check("Esc fecha sem usar nada (nada muda)", closed >= 1 && usedAfter === 1, { closed, usedAfter });
  await chrome.send("Target.closeTarget", { targetId: tab.targetId });
}

await runStudio("desktop", { width: 1280, height: 900, picks: [3, 2, 1, 2] });
await runStudio("celular", { width: 390, height: 844, mobile: true, picks: [5, 0, 2, 1] });
await runStudio("escuro", { width: 1000, height: 800, dark: true, picks: [1, 4, 0, 3] });

const foreign = net.filter((u) => !u.startsWith(PROXY_URL) && !u.startsWith("blob:") && !u.startsWith("data:") && u !== "about:blank");
results.network = { requests: net.length, foreign };
results.problems = problems;
const all = results.runs.flatMap((r) => r.checks);
results.summary = { checks: all.length, failed: all.filter((c) => !c.pass).map((c) => `${c.name}`), foreignRequests: foreign.length, consoleProblems: problems.length };
fs.writeFileSync(path.join(OUT, "studio-result.json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results.summary));
await chrome.stop(); srv.close();
process.exit(all.every((c) => c.pass) && foreign.length === 0 ? 0 : 1);
