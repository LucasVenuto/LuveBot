// node evi.mjs (REPO=<worktree with the card and the parser>, OUT=<dir>): the evidence card in real Chrome, light/dark, desktop/phone, PT/EN.
import fs from "node:fs";
import path from "node:path";
import { buildGlue, startStatic, launchChrome, PROXY_URL, sleep, OUT } from "./lib.mjs";
await buildGlue("glue-evi.tsx", "glue-evi.js");
fs.writeFileSync(path.join(OUT, "page.html"), `<!doctype html><html lang="pt-BR"><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>evi</title>
<link rel="stylesheet" href="/dashboard-plugins/luvebot/dist/style.css"><body style="margin:0"><div id="root"></div><script src="/glue-evi.js"></script>`);
const srv = startStatic();
const chrome = await launchChrome({});
const problems = [];
chrome.on((m) => { if (m.method === "Runtime.exceptionThrown") problems.push("EXC " + JSON.stringify(m.params.exceptionDetails).slice(0, 300)); if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !String(m.params.entry.url).endsWith("favicon.ico")) problems.push(m.params.entry.text.slice(0, 200)); });
const results = [];
for (const [label, { w, h, mobile, dark, lang }] of Object.entries({
  "desktop-claro-pt": { w: 900, h: 1500 }, "celular-escuro-pt": { w: 390, h: 2300, mobile: true, dark: true }, "desktop-escuro-en": { w: 900, h: 1500, dark: true, lang: "en" },
})) {
  const tab = await chrome.newTab(null); const s = tab.sessionId;
  await chrome.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile }, s);
  await chrome.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] }, s);
  await chrome.send("Page.navigate", { url: `${PROXY_URL}/?scheme=${dark ? "dark" : "light"}&lang=${lang ?? "pt"}` }, s);
  const until = async (e, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await chrome.ev(s, e)) return true; await sleep(150); } return false; };
  const ok = await until(`document.querySelectorAll('[data-testid=evidence-card]').length === 4`);
  await sleep(500);
  const geo = await chrome.ev(s, `({ sw: document.documentElement.scrollWidth, iw: innerWidth, cards: document.querySelectorAll('[data-testid=evidence-card]').length, links: document.querySelectorAll('[data-testid=evidence-card] a').length, overflow: [...document.querySelectorAll('[data-testid=evidence-card] *')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible').length, mismatches: [...document.querySelectorAll('[data-testid=evidence-mismatch]')].map((e) => e.textContent) })`);
  results.push({ label, ok, ...geo });
  console.log(ok && geo.sw <= geo.iw && geo.links === 0 ? "  ok  " : "  FAIL", label, JSON.stringify(geo).slice(0, 300));
  await chrome.shot(s, `evi-${label}.png`);
  if (label === "desktop-claro-pt") { await chrome.ev(s, `document.querySelector('[data-testid=evidence-open-approvals]').click()`, { gesture: true }); console.log("   opened:", await chrome.ev(s, `H.opened`)); }
  await chrome.send("Target.closeTarget", { targetId: tab.targetId });
}
fs.writeFileSync(path.join(OUT, "evi-result.json"), JSON.stringify({ chrome: chrome.version, results, problems }, null, 1));
console.log("problems", problems.length, problems.slice(0, 3));
await chrome.stop(); srv.close();
process.exit(results.every((r) => r.ok && r.sw <= r.iw && r.links === 0) && !problems.length ? 0 : 1);
