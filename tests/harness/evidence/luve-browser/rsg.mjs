// node rsg.mjs  (REPO=<worktree with the component>, OUT=<dir>): the cards in real Chrome, light/dark, desktop/phone, PT/EN.
import fs from "node:fs";
import path from "node:path";
import { buildGlue, startStatic, launchChrome, PROXY_URL, sleep, OUT } from "./lib.mjs";
await buildGlue("glue-rsg.tsx", "glue-rsg.js");
fs.writeFileSync(path.join(OUT, "page.html"), `<!doctype html><html lang="pt-BR"><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>rsg</title>
<link rel="stylesheet" href="/dashboard-plugins/luvebot/dist/style.css"><body style="margin:0"><div id="root"></div><script src="/glue-rsg.js"></script>`);
const srv = startStatic();
const chrome = await launchChrome({});
const problems = [];
chrome.on((m) => { if (m.method === "Runtime.exceptionThrown") problems.push("EXC " + JSON.stringify(m.params.exceptionDetails).slice(0, 300)); if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !String(m.params.entry.url).endsWith("favicon.ico")) problems.push(m.params.entry.text.slice(0, 200)); });
const results = [];
for (const [label, { w, h, mobile, dark, lang, auth, partial }] of Object.entries({
  "desktop-claro-pt": { w: 1000, h: 1100 }, "celular-escuro-pt": { w: 390, h: 1500, mobile: true, dark: true }, "desktop-claro-en": { w: 1000, h: 1100, lang: "en" }, "celular-loopback-pt": { w: 390, h: 1500, mobile: true, auth: "loopback", partial: true },
})) {
  const tab = await chrome.newTab(null); const s = tab.sessionId;
  await chrome.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile }, s);
  await chrome.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] }, s);
  await chrome.send("Page.navigate", { url: `${PROXY_URL}/?scheme=${dark ? "dark" : "light"}&lang=${lang ?? "pt"}${auth ? "&auth=" + auth : ""}${partial ? "&partial=1" : ""}` }, s);
  const until = async (e, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await chrome.ev(s, e)) return true; await sleep(150); } return false; };
  const ok = await until(`document.querySelectorAll('article').length === 4`);
  await sleep(600);
  const geo = await chrome.ev(s, `({ sw: document.documentElement.scrollWidth, iw: innerWidth, cards: document.querySelectorAll('article').length, buttons: [...document.querySelectorAll('article button')].map((b) => b.textContent.trim()).slice(0, 12), minBtn: Math.min(...[...document.querySelectorAll('article button')].map((b) => { const r = b.getBoundingClientRect(); return Math.round(Math.min(r.width, r.height)); })) })`);
  results.push({ label, ok, ...geo });
  console.log(ok && geo.sw <= geo.iw ? "  ok  " : "  FAIL", label, JSON.stringify(geo).slice(0, 260));
  await chrome.shot(s, `rsg-${label}.png`);
  if (label === "desktop-claro-pt") {
    await chrome.ev(s, `document.querySelector('[data-testid^="btn-rsg-paused-"]').click()`, { gesture: true }); await sleep(500);
    await chrome.ev(s, `document.querySelector('[data-testid^="btn-rsg-dismiss-"]').click()`, { gesture: true }); await sleep(500);
    await chrome.shot(s, "rsg-desktop-claro-pt-depois.png");
    console.log("   calls", JSON.stringify(await chrome.ev(s, `H.calls`)));
  }
  await chrome.send("Target.closeTarget", { targetId: tab.targetId });
}
fs.writeFileSync(path.join(OUT, "rsg-result.json"), JSON.stringify({ chrome: chrome.version, results, problems }, null, 1));
console.log("problems", problems.length, problems.slice(0, 3));
await chrome.stop(); srv.close();
process.exit(results.every((r) => r.ok && r.sw <= r.iw) && !problems.length ? 0 : 1);
