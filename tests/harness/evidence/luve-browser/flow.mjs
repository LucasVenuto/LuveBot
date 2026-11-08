// Crie seu Luve ponta a ponta no APP REAL: Chrome real (CDP) -> painel REAL do Hermes v0.22.5 (hd/dashboard-dist) -> o LuveBot carregado pelo próprio Hermes
// (dist/index.js do main) -> backend REAL do plugin. Entra com o login do painel, abre o Bot, abre o Perfil, cria o Luve no estúdio, baixa o PNG, usa no Bot,
// salva, confere a barra lateral, a conversa e o Mapa, recarrega a página (vem do backend), e confere a linha de auditoria no banco. Também o "Meu Luve".
//   H=<escopo do harness com fixtures/credentials.json> [BOT=vendas] [VIEW=desktop|celular] [SCHEME=light|dark] node flow.mjs   (a pilha tem de estar de pé: run.sh com HOLD=1)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildGlue, launchChrome, sleep, OUT } from "./lib.mjs";

const H = process.env.H, BOT = process.env.BOT ?? "vendas", VIEW = process.env.VIEW ?? "desktop", SCHEME = process.env.SCHEME ?? "light";
const DASH = "http://127.0.0.1:19119", mobile = VIEW === "celular", tag = `${VIEW}-${SCHEME}`;
await buildGlue("glue-expect.tsx", "glue-expect.js");
const expectSrc = fs.readFileSync(path.join(OUT, "glue-expect.js"), "utf8");
const creds = JSON.parse(fs.readFileSync(H + "/fixtures/credentials.json", "utf8"));
const downloads = path.join(OUT, "downloads-" + tag);
fs.rmSync(downloads, { recursive: true, force: true });
const chrome = await launchChrome({ width: mobile ? 390 : 1280, height: mobile ? 844 : 900, mobile, downloads, extraArgs: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] });
const results = { chrome: chrome.version, date: new Date().toISOString(), bot: BOT, view: tag, checks: [] };
const reqs = new Map(), problems = [], dl = [];
chrome.on((m) => {
  const p = m.params ?? {};
  if (m.method === "Network.requestWillBeSent") reqs.set(p.requestId, { method: p.request.method, url: p.request.url, body: (p.request.postData ?? "").slice(0, 300) });
  if (m.method === "Network.responseReceived" && reqs.has(p.requestId)) reqs.get(p.requestId).status = p.response.status;
  if (m.method === "Runtime.exceptionThrown") problems.push("EXC " + JSON.stringify(p.exceptionDetails).slice(0, 400));
  if (m.method === "Log.entryAdded" && p.entry.level === "error") problems.push("error " + p.entry.text.slice(0, 200) + " " + (p.entry.url ?? ""));
  if (m.method === "Browser.downloadWillBegin") dl.push({ name: p.suggestedFilename, state: "begin" });
  if (m.method === "Browser.downloadProgress" && p.state !== "inProgress") dl.push({ state: p.state });
});
const check = (name, pass, detail) => { results.checks.push({ name, pass: !!pass, detail }); console.log(pass ? "  ok  " : "  FAIL", name, detail === undefined ? "" : JSON.stringify(detail).slice(0, 240)); return !!pass; };

const tabInfo = await chrome.newTab(DASH + "/");
const s = tabInfo.sessionId;
await chrome.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: SCHEME }] }, s);
if (mobile) await chrome.send("Emulation.setTouchEmulationEnabled", { enabled: true }, s);
const ev = (expr, o) => chrome.ev(s, expr, o);
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(expr)) return true; } catch { /* page navigating */ } await sleep(200); } return false; };
const textBtn = (text) => `(() => { const els = [...document.querySelectorAll('button,[role=tab],a,[role=button]')]; return els.find((b) => ((b.getAttribute('aria-label') || b.textContent || '').trim()) === ${JSON.stringify(text)}); })()`;
const click = (text) => ev(`(() => { const e = ${textBtn(text)}; if (!e) return false; e.click(); return true; })()`, { gesture: true });
const shot = (n) => chrome.shot(s, `flow-${tag}-${n}.png`);
const api = (p) => ev(`fetch(${JSON.stringify("/api/plugins/luvebot" + p + (p.includes("?") ? "&" : "?") + "profile=current")}).then((r) => r.json())`);
const inject = () => ev(expectSrc);
const IMGS = (root, recipe) => `(async () => {
  const out = [];
  for (const img of (${root}).querySelectorAll('img')) {
    if (!img.src.startsWith('blob:')) continue;
    const text = await (await fetch(img.src)).text();
    const matches = ['', 'working', 'needs_you'].flatMap((st) => [false, true].map((mini) => text === __luve.expectSvg(${JSON.stringify(recipe)}, st || undefined, mini) ? (st || 'idle') + (mini ? '/mini' : '/whole') : null)).filter(Boolean);
    out.push({ w: img.naturalWidth, matches });
  }
  return out;
})()`;
const rowOf = `[...document.querySelectorAll('aside button[aria-pressed]')].find((x) => x.textContent.toLowerCase().includes(${JSON.stringify(BOT)}))`;

// ---- 1. the real panel, signed in, with LuveBot loaded by Hermes
const login = await ev(`fetch('/auth/password-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'basic', username: ${JSON.stringify(creds.username)}, password: ${JSON.stringify(creds.password)}, next: '/' }) }).then((r) => r.status)`);
check("login no painel do Hermes", login === 200, login);
await chrome.send("Page.navigate", { url: DASH + "/" }, s);
check("o LuveBot abre dentro do painel e lista os Bots", await until(`!!document.querySelector('.lb-root') && document.querySelectorAll('aside button[aria-pressed]').length >= 2`, 40000));
await inject();
await sleep(800);
console.log("   bots:", JSON.stringify(await ev(`[...document.querySelectorAll('aside button[aria-pressed]')].map((b) => b.textContent.trim().slice(0, 24))`)));
await shot("1-hoje");
const before = await api(`/bots/${BOT}`);
console.log("   avatar antes:", JSON.stringify((before.bot ?? before).display?.avatar ?? null));

// ---- 2. Bot -> Perfil
check("abrir o Bot " + BOT, await ev(`(() => { const b = ${rowOf}; if (!b) return false; b.click(); return true; })()`, { gesture: true }));
check("botão Perfil", await until("!!" + textBtn("Perfil")) && await click("Perfil"));
check("Identidade e instruções", await until("!!" + textBtn("Identidade e instruções")) && await click("Identidade e instruções"));
check("a identidade mostra Criar seu Luve", await until("!!" + textBtn("Criar seu Luve")));
await shot("2-perfil");

// ---- 3. the studio, in the real app
check("abrir o estúdio", await click("Criar seu Luve"));
check("estúdio aberto", await until(`!!document.querySelector('[role=dialog] .lb-luve-preview-art')`));
check("prévia 3D (WebGL por software)", await until(`document.querySelector('.lb-luve-preview-art')?.dataset.view === '3d'`, 20000));
const L = await ev(`({ shapes: __luve.SHAPES, materials: __luve.MATERIAL_IDS, accessories: __luve.ACCESSORY_IDS, swatches: __luve.KIT.swatches.map((x) => x.base.slice(1).toLowerCase()) })`);
const picks = mobile ? [6, 4, 1, 5] : [4, 3, 2, 3];
const want = `${L.shapes[picks[0]]}.${L.materials[picks[2]]}.${L.accessories[picks[3]]}.${L.swatches[picks[1]]}`;
const pick = (sel, i) => ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!e) return false; e.click(); return true; })()`, { gesture: true });
const nextBtn = () => ev(`(() => { const b = document.querySelector('.lb-dialog-footer .lb-btn-primary'); b.click(); return b.textContent; })()`, { gesture: true });
check("passo forma", await pick(".lb-luve-opt", picks[0])); await nextBtn();
check("passo cor", await pick(".lb-luve-swatch", picks[1])); await nextBtn();
check("passo material", await pick(".lb-luve-opt", picks[2])); await nextBtn();
check("passo acessório", await pick(".lb-luve-opt", picks[3]));
await sleep(600);
const inView = await ev(`(() => { const sheet = document.querySelector('.lb-dialog').getBoundingClientRect(); return [...document.querySelectorAll('.lb-luve-actions .lb-btn, .lb-dialog-footer .lb-btn')].every((b) => { const r = b.getBoundingClientRect(); return r.top >= sheet.top - 1 && r.bottom <= Math.min(sheet.bottom, innerHeight) + 1; }); })()`);
check("as ações e Usar aparecem inteiras na tela sem rolar (dock do estúdio)", inView);
await shot("3-estudio");

// ---- 4. PNG
const dl0 = dl.length;
check("Baixar PNG", await click("Baixar PNG"));
const got = await (async () => { const t = Date.now(); while (Date.now() - t < 30000) { if (dl.slice(dl0).some((d) => d.state === "completed")) return true; await sleep(200); } return false; })();
const png = path.join(downloads, `luve-${L.shapes[picks[0]]}.png`);
check("PNG salvo pelo navegador", got && fs.existsSync(png), { name: path.basename(png) });
if (fs.existsSync(png)) {
  const b = fs.readFileSync(png);
  check("PNG 1024 x 1024 válido", b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.readUInt32BE(16) === 1024 && b.readUInt32BE(20) === 1024, { bytes: b.length });
  const stats = await ev(`(async (b64) => { const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' })); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const x = c.getContext('2d'); x.drawImage(bmp, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 16) n++; return { opaque: +(n / (c.width * c.height)).toFixed(3), corner: d[3] }; })(${JSON.stringify(b.toString("base64"))})`);
  check("PNG: fundo transparente e o personagem desenhado", stats.corner === 0 && stats.opaque > 0.1 && stats.opaque < 0.9, stats);
  fs.copyFileSync(png, path.join(OUT, `flow-${tag}-luve.png`));
}

// ---- 5. use in the Bot, then Salvar
check("Usar em " + BOT + " (fecha o estúdio)", await click(`Usar em ${(await ev(`document.querySelector('.lb-dialog-footer .lb-btn-primary').textContent`)).replace(/^Usar em /, "")}`) && await until(`!document.querySelector('[role=dialog]')`));
check("Salvar alterações", await click("Salvar alterações"));
const patched = await (async () => { const t = Date.now(); while (Date.now() - t < 20000) { const p = [...reqs.values()].filter((c) => c.method === "PATCH" && c.url.includes(`/bots/${BOT}/display`) && c.status); if (p.length) return p.at(-1); await sleep(200); } return null; })();
check("o backend respondeu 200 ao PATCH do rosto", patched?.status === 200, patched);
await sleep(800);
const after = await api(`/bots/${BOT}`);
const avatarAfter = (after.bot ?? after).display?.avatar;
check("o backend guardou {kind:luve, value:<receita escolhida>}", avatarAfter?.kind === "luve" && avatarAfter?.value === want, { avatarAfter, want });

// ---- 6. the face where it is shown: sidebar (or the list on a phone), conversation, then the Map
if (mobile) {   // a phone: Perfil -> the conversation -> the list of conversations (where the faces and the tab bar are)
  check("celular: voltar do Perfil para a conversa", await click("‹ Voltar para a conversa")); await sleep(600);
  check("celular: voltar para a lista de conversas", await click("Voltar para as conversas")); await sleep(800);
}
await sleep(500);
const sidebar = await ev(IMGS(`(${rowOf}) ?? document.createElement('div')`, want));
check("barra lateral: o rosto do Bot é <img blob:> e é o SVG da receita (byte a byte)", sidebar.length > 0 && sidebar.every((i) => i.w > 0 && i.matches.length > 0), sidebar);
await shot("4-lateral");
check("ir ao Mapa", await click("Mapa") && await until(`!!document.querySelector('[role=tabpanel]')`));
await sleep(1500);
await click("Grafo"); await sleep(800);
const mapNode = await ev(`(async () => {
  const p = document.querySelector('[aria-labelledby="tab-map-visual"]');
  if (!p) return { panel: false };
  const g = [...p.querySelectorAll('g')].find((x) => x.querySelector(':scope > image') && x.textContent.toLowerCase().includes(${JSON.stringify(BOT)}));
  if (!g) return { panel: true, node: false };
  const href = g.querySelector(':scope > image').getAttribute('href') || '';
  const text = await (await fetch(href)).text();
  const matches = ['', 'working', 'needs_you'].flatMap((st) => [false, true].map((mini) => text === __luve.expectSvg(${JSON.stringify(want)}, st || undefined, mini) ? (st || 'idle') + (mini ? '/mini' : '/whole') : null)).filter(Boolean);
  return { panel: true, node: true, blob: href.startsWith('blob:'), matches };
})()`);
check("Mapa (grafo): o NÓ do Bot desenha a receita (<image blob:> do nó, byte a byte)", mapNode.panel && mapNode.node && mapNode.blob && mapNode.matches.length > 0, mapNode);
await shot("5-mapa");
if (await click("Lista Acessível")) {
  await sleep(800);
  const list = await ev(`(() => { const p = document.querySelector('[aria-labelledby="tab-map-accessible"]'); return { text: p ? p.innerText.toLowerCase().includes(${JSON.stringify(BOT)}) : false, faces: p ? p.querySelectorAll('img').length : -1 }; })()`);
  check("Mapa (lista acessível): o Bot está na lista, em texto (esta visão não desenha rostos, é para leitor de tela)", list.text === true && list.faces === 0, list);
  await shot("6-mapa-lista");
}

// ---- 7. reload: it comes from the backend, not from memory
await chrome.send("Page.navigate", { url: DASH + "/" }, s);
await until(`document.querySelectorAll('aside button[aria-pressed]').length >= 2`, 40000);
await inject(); await sleep(1500);
const reloaded = await ev(IMGS(`(${rowOf}) ?? document.createElement('div')`, want));
check("depois de recarregar a página, a barra lateral ainda desenha a receita", reloaded.length > 0 && reloaded.every((i) => i.matches.length > 0), reloaded);
await shot("7-recarregado");

// ---- 8. audit rows (backend side): what the human did is recorded before and after (intent, result), by the signed-in person, from the UI; the recipe itself is
// never stored in clear (only a digest of the change)
try {
  const db = path.join(H, "home/luvebot/luvebot.db");
  const rows = execFileSync("/usr/bin/sqlite3", ["-separator", "|", db, `select action, actor, origin_kind, bot, target, outcome, detail, length(digest) from audit_log where action = 'bot.display.update' and bot = '${BOT}' order by id desc limit 2;`], { encoding: "utf8" }).trim().split("\n").map((r) => r.split("|"));
  const [result, intent] = rows;
  check("auditoria: bot.display.update gravada antes (intent) e depois (result), ok, pela pessoa logada, origem ui", rows.length === 2 && intent?.[6] === "intent" && result?.[6] === "result" && rows.every((r) => r[5] === "ok" && r[2] === "ui" && r[1].startsWith("basic:") && r[4] === BOT && Number(r[7]) >= 16), rows);
  const all = execFileSync("/usr/bin/sqlite3", [db, "select group_concat(coalesce(detail,'') || coalesce(target,'') || coalesce(digest,'')) from audit_log where action = 'bot.display.update';"], { encoding: "utf8" });
  check("auditoria: a receita não é gravada em claro (só o resumo da mudança)", !all.includes(want.split(".").at(-1)));
} catch (e) { check("auditoria (sqlite)", false, String(e).slice(0, 200)); }

const foreign = [...new Set([...reqs.values()].map((r) => r.url).filter((u) => !u.startsWith(DASH) && !u.startsWith("blob:") && !u.startsWith("data:") && u !== "about:blank"))];
results.network = { requests: reqs.size, foreign };
results.problems = problems;
results.summary = { checks: results.checks.length, failed: results.checks.filter((c) => !c.pass).map((c) => c.name), foreign: foreign.length, consoleErrors: problems.length };
fs.writeFileSync(path.join(OUT, `flow-${tag}-result.json`), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results.summary));
await chrome.stop();
process.exit(results.checks.every((c) => c.pass) && foreign.length === 0 ? 0 : 1);
