// Shared plumbing for the Chrome-by-CDP runs: esbuild of a test page, a static server for the plugin's own files (no backend), headless Chrome with a
// throwaway profile, and a tiny CDP client over Node's WebSocket. Nothing is installed: it drives the Chrome that is already on the machine.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

export const HERE = path.dirname(new URL(import.meta.url).pathname);
export const REPO = process.env.REPO ?? path.resolve(HERE, "../../../..");   // tests/harness/evidence/luve-browser -> the repository (or a worktree: REPO=<it>)
export const OUT = process.env.OUT ?? path.join(HERE, "out");
fs.mkdirSync(OUT, { recursive: true });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [PROXY, DBG] = (process.env.PORTS ?? "18811,19344").split(",").map(Number);
export const PROXY_URL = `http://127.0.0.1:${PROXY}`;

export async function buildGlue(entry = "glue.tsx", outName = "glue.js") {
  const esbuild = createRequire(REPO + "/package.json")("esbuild");
  await esbuild.build({ entryPoints: [path.join(HERE, entry)], bundle: true, format: "iife", outfile: path.join(OUT, outName),
    target: ["es2022"], jsx: "transform", nodePaths: [REPO + "/node_modules"],  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error", alias: { "@repo": REPO, "@luvebot/extra": REPO + "/dashboard/src/extra-empty.ts" } });
}

export async function launchChrome({ width = 1280, height = 900, mobile = false, downloads, extraArgs = [] } = {}) {
  if (await fetch(`http://127.0.0.1:${DBG}/json/version`).then(() => true, () => false)) throw new Error(`port ${DBG} already has a Chrome`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mochi-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-proxy-server", "--lang=pt-BR",
    `--window-size=${width},${height}`, "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", ...extraArgs, "about:blank"], { stdio: "ignore" });
  let wsUrl = "";
  for (let i = 0; i < 240 && !wsUrl; i++) { await sleep(250); try { wsUrl = (await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json()).webSocketDebuggerUrl; } catch { /* not up yet */ } }
  if (!wsUrl) throw new Error("chrome did not start");
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let nid = 0; const pend = new Map(); const listeners = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { ok, bad } = pend.get(m.id); pend.delete(m.id); m.error ? bad(new Error(JSON.stringify(m.error))) : ok(m.result); } else if (m.method) listeners.forEach((f) => f(m)); };
  const send = (method, params = {}, sessionId) => new Promise((ok, bad) => { const id = ++nid; pend.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const version = (await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json()).Browser;
  if (downloads) { fs.mkdirSync(downloads, { recursive: true }); await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true }); }
  async function newTab(url) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    for (const d of ["Page", "Runtime", "Log", "Network"]) await send(d + ".enable", {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile }, sessionId);
    await send("Emulation.setLocaleOverride", { locale: "pt-BR" }, sessionId).catch(() => {});
    if (url) { await send("Page.navigate", { url }, sessionId); await sleep(800); }
    return { targetId, sessionId };
  }
  const ev = async (s, expr, opts = {}) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: !!opts.gesture }, s);
    if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };
  const shot = async (s, file) => fs.writeFileSync(path.join(OUT, file), Buffer.from((await send("Page.captureScreenshot", { format: "png" }, s)).data, "base64"));
  const stop = async () => { try { ws.close(); } catch { /* closed */ } chrome.kill(); await sleep(1500); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Chrome still flushing: a throwaway profile in the OS temp dir */ } };
  return { send, newTab, ev, shot, stop, version, on: (f) => listeners.push(f) };
}

/** No backend: the page of a component test and the plugin's own static files (dist/*.js, style.css, icons) from the repository. */
export function startStatic(log) {
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split("?")[0]);
    log?.({ method: req.method, url: req.url });
    if (p === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(fs.readFileSync(path.join(OUT, "page.html"))); }
    if (p.endsWith(".js") && fs.existsSync(path.join(OUT, path.basename(p))) && !p.startsWith("/dashboard-plugins/")) { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(fs.readFileSync(path.join(OUT, path.basename(p)))); }
    const pre = "/dashboard-plugins/luvebot/";
    const file = p.startsWith(pre) ? path.join(REPO, "dashboard", p.slice(pre.length)) : null;
    if (file && file.startsWith(path.join(REPO, "dashboard")) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const type = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" }[path.extname(file)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type }); return res.end(fs.readFileSync(file));
    }
    res.writeHead(404); res.end("no");
  });
  srv.listen(PROXY, "127.0.0.1");
  return srv;
}
