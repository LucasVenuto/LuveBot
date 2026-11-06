// Exploration against the REAL Hermes panel (hd/dashboard-dist) with the plugin loaded by Hermes itself: log in, open "/", dump what is there.
//   H=<harness scratch root> node explore-real.mjs [button text to click...]
import fs from "node:fs";
import path from "node:path";
import { launchChrome, sleep, OUT } from "./lib.mjs";
const H = process.env.H, DASH = "http://127.0.0.1:19119";
const creds = JSON.parse(fs.readFileSync(H + "/fixtures/credentials.json", "utf8"));
const chrome = await launchChrome({ width: 1280, height: 900, extraArgs: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const logs = [], net = [];
chrome.on((m) => { if (m.method === "Runtime.exceptionThrown") logs.push("EXC " + JSON.stringify(m.params.exceptionDetails).slice(0, 300)); if (m.method === "Log.entryAdded") logs.push(m.params.entry.level + " " + m.params.entry.text.slice(0, 160)); if (m.method === "Network.requestWillBeSent") net.push(m.params.request.url); });
const tab = await chrome.newTab(DASH + "/");
const s = tab.sessionId, ev = (e, o) => chrome.ev(s, e, o);
await sleep(1500);
console.log("url:", await ev("location.href"), "title:", await ev("document.title"));
const login = await ev(`fetch('/auth/password-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'basic', username: ${JSON.stringify(creds.username)}, password: ${JSON.stringify(creds.password)}, next: '/' }) }).then(async (r) => ({ status: r.status, text: (await r.text()).slice(0, 200) }))`);
console.log("login:", JSON.stringify(login));
await chrome.send("Page.navigate", { url: DASH + "/" }, s);
await sleep(5000);
const dump = () => ev(`JSON.stringify({ url: location.href, title: document.title, root: !!document.querySelector('.lb-root'), webgl: !!document.createElement('canvas').getContext('webgl'), aside: [...document.querySelectorAll('aside button[aria-pressed]')].map((b) => b.textContent.trim().slice(0, 30)), buttons: [...document.querySelectorAll('.lb-root button,.lb-root [role=tab]')].map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 28)).filter(Boolean).slice(0, 90), text: '' })`);
console.log(await dump());
await chrome.shot(s, "real-1-home.png");
for (const label of process.argv.slice(2)) {
  const ok = await ev(`(() => { const els = [...document.querySelectorAll('button,[role=tab],a,[role=button]')]; const el = els.find((b) => ((b.getAttribute('aria-label') || b.textContent || '').trim()) === ${JSON.stringify(label)}); if (!el) return false; el.click(); return true; })()`, { gesture: true });
  console.log("click", label, ok); await sleep(1500); console.log(await dump());
}
await chrome.shot(s, "real-2-after.png");
const foreign = [...new Set(net.filter((u) => !u.startsWith(DASH) && !u.startsWith("blob:") && !u.startsWith("data:")))];
console.log(JSON.stringify({ logs: logs.slice(0, 8), foreign: foreign.slice(0, 8), requests: net.length }));
await chrome.stop();
