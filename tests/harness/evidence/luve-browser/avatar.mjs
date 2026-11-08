// "Enviar imagem" (contract v0.11 §2.3) em Chrome real: canvas, orientação EXIF, o PNG exportado conferido BYTE A BYTE com as regras do servidor (§2.1: assinatura, IHDR 256x256 8 bits
// RGB/RGBA sem entrelaçamento, CRC de todo bloco, IDAT que infla EXATAMENTE ao tamanho esperado), nenhum metadado do arquivo original, arrastar com o mouse e as setas, o celular.
//   REPO=<worktree com o estúdio> OUT=<pasta> node avatar.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildGlue, startStatic, launchChrome, PROXY_URL, sleep, OUT } from "./lib.mjs";

await buildGlue("glue-avatar.tsx", "glue-avatar.js");
fs.writeFileSync(path.join(OUT, "page.html"), `<!doctype html><html lang="pt-BR"><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>avatar</title>
<link rel="stylesheet" href="/dashboard-plugins/luvebot/dist/style.css"><body style="margin:0"><div id="root"></div><script src="/glue-avatar.js"></script>`);
const srv = startStatic();
const chrome = await launchChrome({});
const problems = [];
chrome.on((m) => { if (m.method === "Runtime.exceptionThrown") problems.push("EXC " + JSON.stringify(m.params.exceptionDetails).slice(0, 300)); if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !String(m.params.entry.url).endsWith("favicon.ico")) problems.push(m.params.entry.text.slice(0, 200)); });
const results = { chrome: chrome.version, date: new Date().toISOString(), runs: [] };

/** The server's rules (contract v0.11 §2.1), applied to what the browser exported. Returns {ok, why, facts}. */
function validate(buf) {
  const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return { ok: false, why: "signature" };
  let at = 8; const chunks = [];
  while (at < buf.length) {
    if (at + 12 > buf.length) return { ok: false, why: "truncated chunk" };
    const len = buf.readUInt32BE(at), type = buf.toString("latin1", at + 4, at + 8);
    if (at + 12 + len > buf.length) return { ok: false, why: "length past the end: " + type };
    const crc = buf.readUInt32BE(at + 8 + len);
    if (zlib.crc32(buf.subarray(at + 4, at + 8 + len)) !== crc) return { ok: false, why: "bad CRC: " + type };
    chunks.push({ type, data: buf.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
    if (type === "IEND") break;
  }
  if (at !== buf.length) return { ok: false, why: "bytes after IEND" };
  if (chunks[0]?.type !== "IHDR" || chunks[0].data.length !== 13) return { ok: false, why: "IHDR first" };
  const h = chunks[0].data, w = h.readUInt32BE(0), ht = h.readUInt32BE(4), depth = h[8], color = h[9], comp = h[10], filt = h[11], inter = h[12];
  if (w !== 256 || ht !== 256 || depth !== 8 || ![2, 6].includes(color) || comp !== 0 || filt !== 0 || inter !== 0) return { ok: false, why: `header ${w}x${ht} depth ${depth} color ${color} interlace ${inter}` };
  if (chunks.at(-1).type !== "IEND" || chunks.length > 64) return { ok: false, why: "IEND last / chunk count" };
  const idat = chunks.filter((c) => c.type === "IDAT");
  const firstIdat = chunks.findIndex((c) => c.type === "IDAT");
  if (!idat.length || chunks.slice(firstIdat, firstIdat + idat.length).some((c) => c.type !== "IDAT")) return { ok: false, why: "IDAT consecutive" };
  const expected = 256 * (1 + 256 * (color === 6 ? 4 : 3));
  let raw; try { raw = zlib.inflateSync(Buffer.concat(idat.map((c) => c.data)), { maxOutputLength: expected + 1 }); } catch (e) { return { ok: false, why: "inflate: " + e.code }; }
  if (raw.length !== expected) return { ok: false, why: `inflates to ${raw.length}, expected ${expected}` };
  const critical = chunks.filter((c) => c.type[0] === c.type[0].toUpperCase()).map((c) => c.type);
  return { ok: true, facts: { color: color === 6 ? "RGBA" : "RGB", chunks: chunks.map((c) => c.type), critical, bytes: buf.length } };
}

async function run(label, { w, h, mobile, dark }, body) {
  const run = { label, viewport: `${w}x${h}${mobile ? " mobile" : ""}${dark ? " dark" : ""}`, checks: [] };
  results.runs.push(run);
  const check = (name, pass, detail) => { run.checks.push({ name, pass: !!pass, detail }); console.log(pass ? "  ok  " : "  FAIL", label, name, detail === undefined ? "" : JSON.stringify(detail).slice(0, 200)); };
  const tab = await chrome.newTab(null); const s = tab.sessionId;
  await chrome.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile }, s);
  await chrome.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] }, s);
  await chrome.send("Page.navigate", { url: `${PROXY_URL}/?scheme=${dark ? "dark" : "light"}` }, s);
  const ev = (e, o) => chrome.ev(s, e, o);
  const until = async (e, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e)) return true; await sleep(150); } return false; };
  check("o botão Enviar imagem aparece (a rota respondeu com o envelope do LuveBot)", await until(`!!document.querySelector('[data-testid=btn-avatar-send]')`));
  await ev(`document.querySelector('[data-testid=btn-avatar-send]').click()`, { gesture: true });
  check("o diálogo abre no passo de escolher, com a frase de privacidade", await until(`!!document.querySelector('[data-testid=avatar-privacy]') && !!document.querySelector('[data-testid=avatar-file]')`));
  await body({ s, ev, until, check, shot: (n) => chrome.shot(s, `avatar-${label}-${n}.png`), chrome });
  await chrome.send("Target.closeTarget", { targetId: tab.targetId });
}
const lastSent = async (ev, i) => Buffer.from(await ev(`H.bytesOf(H.sent[${i}])`), "base64");

await run("desktop", { w: 1280, h: 900 }, async ({ s, ev, until, check, shot }) => {
  // 1) a JPEG with EXIF orientation 6 (rotate 90 CW) and a marker: stored 400x200, red left / blue right => displayed 200x400, red TOP / blue BOTTOM
  const MARK = "GPS-SECRET-LAT-48.8584-LON-2.2945";
  const carried = await ev(`(async () => { const f = await H.jpegWithExif(400, 200, H.leftRight(400, 200), 6, ${JSON.stringify(MARK)}); const u = new Uint8Array(await f.arrayBuffer()); const hay = new TextDecoder("latin1").decode(u); H.choose(f); return { size: f.size, hasExif: hay.includes("Exif"), hasMarker: hay.includes(${JSON.stringify(MARK)}) }; })()`);
  check("(controle) o arquivo de ORIGEM carregava de fato o EXIF e o marcador", carried.hasExif && carried.hasMarker, carried);
  check("o recorte aparece (canvas real)", await until(`!!document.querySelector('[data-testid=avatar-canvas]')`));
  await sleep(300);
  await shot("1-recorte");
  const view = await ev(`(() => { const c = document.querySelector('[data-testid=avatar-canvas]'); const x = c.getContext('2d'); const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data); return { w: c.width, h: c.height, top: px(128, 40), bottom: px(128, 216), left: px(40, 128), right: px(216, 128) }; })()`);
  const red = (p) => p[0] > 200 && p[1] < 60 && p[2] < 60, blue = (p) => p[2] > 200 && p[0] < 60 && p[1] < 60;
  check("a orientação do EXIF foi respeitada: a prévia mostra vermelho EM CIMA e azul EMBAIXO (não esquerda/direita)", red(view.top) && blue(view.bottom) && view.w === 256 && view.h === 256, view);
  check("o texto de privacidade segue visível no recorte", await ev(`document.querySelector('[data-testid=avatar-privacy]').textContent`) === "A imagem fica no seu servidor, entra no backup do LuveBot, e “Remover” a apaga (um backup mais antigo ainda a guarda).");
  const previews = await ev(`(() => { const r = document.querySelector('[data-testid=avatar-preview-round]'), q = document.querySelector('[data-testid=avatar-preview-square]'); const px = (c, a, b) => Array.from(c.getContext('2d').getImageData(a, b, 1, 1).data); return { round: px(r, 32, 8), square: px(q, 32, 56) }; })()`);
  check("as prévias redonda e quadrada desenham o mesmo recorte", red(previews.round) && blue(previews.square), previews);

  // 2) drag with the real mouse: the picture follows the finger; at zoom 1 the 200 px square of a 200x400 image can move vertically only
  await ev(`(() => { const s = document.querySelector('[data-testid=avatar-zoom]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(s, '2'); s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  const box = await ev(`(() => { const r = document.querySelector('[data-testid=avatar-canvas]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })()`);
  const before = await ev(`(() => { const x = document.querySelector('[data-testid=avatar-canvas]').getContext('2d'); return Array.from(x.getImageData(128, 20, 1, 1).data); })()`);   // zoom 2: the square is 100 px, centred on the red/blue boundary: the upper half is red
  await chrome.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, s);
  for (let i = 1; i <= 8; i++) await chrome.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y - i * box.w / 8 * 0.5, button: "left", buttons: 1 }, s);
  await chrome.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y - box.w * 0.5, button: "left", clickCount: 1 }, s);
  await sleep(300);
  const after = await ev(`(() => { const x = document.querySelector('[data-testid=avatar-canvas]').getContext('2d'); return { top: Array.from(x.getImageData(128, 20, 1, 1).data), bottom: Array.from(x.getImageData(128, 236, 1, 1).data) }; })()`);
  check("arrastar para cima com o mouse leva a imagem junto (agora o azul sobe e aparece na prévia)", red(before) && blue(after.bottom), { before, after });
  // 3) the arrow keys
  await ev(`document.querySelector('[role=group][aria-label="Área do rosto"]').focus()`);
  await ev(`(() => { for (let i = 0; i < 40; i++) document.querySelector('[role=group][aria-label="Área do rosto"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); })()`);
  await sleep(200);
  const down = await ev(`(() => { const x = document.querySelector('[data-testid=avatar-canvas]').getContext('2d'); return { top: Array.from(x.getImageData(128, 20, 1, 1).data), bottom: Array.from(x.getImageData(128, 236, 1, 1).data) }; })()`);
  check("as setas movem o quadrado até a borda e param nela (tudo azul embaixo, sem canto vazio)", blue(down.bottom) && down.top[3] === 255 && down.bottom[3] === 255, down);

  // 4) Usar: the PNG the browser exported
  await ev(`document.querySelector('[data-testid=avatar-use]').click()`, { gesture: true });
  check("Usar enviou um PNG e devolveu o id", await until(`H.sent.length === 1 && H.used.length === 1`));
  const png = await lastSent(ev, 0);
  const v = validate(png);
  check("o PNG exportado passa em TODAS as regras do servidor (§2.1): assinatura, IHDR 256x256 8 bits, CRC de cada bloco, IDAT consecutivos, infla exatamente, nada depois do IEND", v.ok, v.ok ? v.facts : v.why);
  check("e cabe no teto de 288 KiB", png.length <= 288 * 1024, png.length);
  // negative controls: the checker above must REJECT what the server would reject, or "ok" proves nothing
  const flip = (b, at) => { const c = Buffer.from(b); c[at] ^= 0xff; return c; };
  const firstIdat = png.indexOf(Buffer.from("IDAT")) + 4;
  const controls = {
    "um byte de dado de IDAT trocado (CRC)": flip(png, firstIdat + 3),
    "um byte depois do IEND": Buffer.concat([png, Buffer.from([0])]),
    "arquivo cortado": png.subarray(0, png.length - 5),
    "assinatura errada": flip(png, 1),
    "largura 255 no IHDR (com CRC refeito)": (() => { const c = Buffer.from(png); c.writeUInt32BE(255, 16); c.writeUInt32BE(zlib.crc32(c.subarray(12, 29)), 29); return c; })(),
    "bomba: IDAT que infla além do esperado": (() => { const big = zlib.deflateSync(Buffer.alloc(300000)); const idat = Buffer.alloc(12 + big.length); idat.writeUInt32BE(big.length, 0); idat.write("IDAT", 4, "latin1"); big.copy(idat, 8); idat.writeUInt32BE(zlib.crc32(idat.subarray(4, 8 + big.length)), 8 + big.length); const ihdrEnd = 8 + 25; const iend = png.subarray(png.length - 12); return Buffer.concat([png.subarray(0, ihdrEnd), idat, iend]); })(),
  };
  const refused = Object.fromEntries(Object.entries(controls).map(([k, b]) => [k, validate(b).ok === false]));
  check("(controle negativo) o conferidor RECUSA PNG adulterado: CRC, byte depois do IEND, cortado, assinatura, largura 255, bomba de inflação", Object.values(refused).every(Boolean), refused);
  check("nenhum metadado do arquivo original foi junto: o marcador do EXIF (GPS, câmera) NÃO está nos bytes, nem como texto", !png.includes(Buffer.from(MARK)) && !png.includes(Buffer.from("Exif")) && !png.includes(Buffer.from("GPS")), v.ok ? v.facts.chunks : null);
  check("só blocos IHDR, IDAT e IEND no que o navegador exportou (o servidor reescreve de qualquer jeito)", v.ok && v.facts.chunks.every((t) => ["IHDR", "IDAT", "IEND"].includes(t)), v.ok ? v.facts.chunks : null);
  const sentDims = await ev(`H.pixelsOf(H.sent[0], [[128, 20], [128, 236]])`);
  check("o PNG enviado é o que a pessoa viu: 256x256, azul embaixo", sentDims.w === 256 && sentDims.h === 256 && blue(sentDims.px[1]), sentDims);
  check("o diálogo fechou e o id enviado à tela é o que o servidor devolveu", await until(`!document.querySelector('[role=dialog]')`) && (await ev(`H.used[0]`)) === "img_" + "0".repeat(31) + "1");
});

await run("transparencia-e-bomba", { w: 1280, h: 900 }, async ({ ev, until, check }) => {
  // a PNG with a transparent left half keeps its alpha (RGBA)
  await ev(`(async () => { H.choose(await H.png(300, 300, (c) => { c.fillStyle = "#00aa00"; c.fillRect(150, 0, 150, 300); })); })()`);
  check("PNG com metade transparente abre", await until(`!!document.querySelector('[data-testid=avatar-canvas]')`));
  await ev(`document.querySelector('[data-testid=avatar-use]').click()`, { gesture: true });
  await until(`H.sent.length === 1`);
  const png = await lastSent(ev, 0);
  const v = validate(png);
  check("o PNG exportado é RGBA válido e a metade transparente continua transparente", v.ok && v.facts.color === "RGBA" && (await ev(`H.pixelsOf(H.sent[0], [[20, 128], [236, 128]])`)).px.every((p, i) => (i === 0 ? p[3] === 0 : p[3] === 255)), v.ok ? v.facts : v.why);
  // a PNG that CLAIMS 30000x30000 (a header only) is refused before anything is decoded
  await ev(`document.querySelector('[data-testid=btn-avatar-send]').click()`, { gesture: true });
  await until(`!!document.querySelector('[data-testid=avatar-file]')`);
  await ev(`(() => { const b = new Uint8Array(100); b.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,0x49,0x48,0x44,0x52], 0); new DataView(b.buffer).setUint32(16, 30000); new DataView(b.buffer).setUint32(20, 30000); H.choose(new File([b], "bomba.png", { type: "image/png" })); })()`);
  check("uma PNG que declara 30000 x 30000 é recusada com a frase certa, sem travar a página", await until(`!!document.querySelector('[data-testid=avatar-error]')`) && (await ev(`document.querySelector('[data-testid=avatar-error]').textContent`)).includes("pixels demais"));
  await ev(`H.choose(new File([new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>")], "ataque.png", { type: "image/png" }))`);
  check("um SVG com nome .png é recusado pelos bytes", await until(`document.querySelector('[data-testid=avatar-error]')?.textContent.includes('não parece uma imagem')`));
});

await run("celular", { w: 390, h: 844, mobile: true }, async ({ ev, until, check, shot }) => {
  await ev(`(async () => { H.choose(await H.png(900, 600, H.leftRight(900, 600))); })()`);
  check("o recorte abre no celular", await until(`!!document.querySelector('[data-testid=avatar-canvas]')`));
  await sleep(300);
  const geo = await ev(`(() => { const sheet = document.querySelector('.lb-dialog').getBoundingClientRect(); const bs = [...document.querySelectorAll('.lb-dialog-footer .lb-btn')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom)]; }); return { sw: document.documentElement.scrollWidth, iw: innerWidth, ih: innerHeight, sheet: [Math.round(sheet.top), Math.round(sheet.bottom)], bs, minBtn: Math.min(...[...document.querySelectorAll('[role=dialog] button')].map((b) => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))), slider: document.querySelector('[data-testid=avatar-zoom]').getBoundingClientRect().height }; })()`);
  check("sem rolagem horizontal; 'Escolher outra', 'Fechar' e 'Usar' aparecem inteiros na tela sem rolar (dock)", geo.sw <= geo.iw && geo.bs.length === 3 && geo.bs.every(([t, b]) => t >= geo.sheet[0] && b <= Math.min(geo.sheet[1], geo.ih) + 1), geo);
  check("alvos de toque de 44 px ou mais (o controle de zoom inclusive)", geo.minBtn >= 44 && geo.slider >= 44, { minBtn: geo.minBtn, slider: geo.slider });
  await shot("celular-recorte");
});

await run("escuro", { w: 1000, h: 800, dark: true }, async ({ ev, until, check, shot }) => {
  await ev(`(async () => { H.choose(await H.png(900, 600, H.leftRight(900, 600))); })()`);
  check("o recorte abre no tema escuro", await until(`!!document.querySelector('[data-testid=avatar-canvas]')`));
  await sleep(300);
  await shot("escuro-recorte");
});

results.problems = problems;
const all = results.runs.flatMap((r) => r.checks);
results.summary = { checks: all.length, failed: all.filter((c) => !c.pass).map((c) => c.name), consoleProblems: problems.length };
fs.writeFileSync(path.join(OUT, "avatar-result.json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results.summary));
await chrome.stop(); srv.close();
process.exit(all.every((c) => c.pass) && !problems.length ? 0 : 1);
