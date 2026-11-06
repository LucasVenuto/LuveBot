// tests/unit/pwa/home-screen-icon-check.test.ts: scripts/check_home_screen_icon.sh asks for the manifest and the icons the way an iPhone does (no cookie, no redirect followed) and says what is wrong.
// A fake server plays four hosts: a good one, one that puts the icons behind a login, one behind a path prefix whose manifest has absolute addresses, and one that lists an SVG.
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";

const SCRIPT = path.resolve(__dirname, "../../../scripts/check_home_screen_icon.sh");
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
let server: http.Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function host(opts: { prefix?: string; manifest: unknown; login?: boolean }): Promise<string> {
  const pre = opts.prefix ?? "";
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (opts.login && url.includes("/icons/")) { res.writeHead(302, { location: "/login?next=" + encodeURIComponent(url) }); return res.end(); }
    if (url === `${pre}/dashboard-plugins/luvebot/pwa.json`) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(opts.manifest)); }
    if (url.startsWith(`${pre}/dashboard-plugins/luvebot/icons/`) && url.endsWith(".png")) { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
    res.writeHead(404, { "content-type": "application/json" }); res.end("{}");
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${(server!.address() as { port: number }).port}${pre}`;
}
/** A child process, never a blocking call: the fake server answers on this same event loop. */
const run = (base: string) => new Promise<{ status: number | null; out: string }>((ok) => {
  const c = spawn("sh", [SCRIPT, base]); let out = "";
  c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  c.on("close", (status) => ok({ status, out }));
});
const icons = (src: string[]) => ({ icons: src.map((s) => ({ src: s, sizes: "192x192", type: s.endsWith(".svg") ? "image/svg+xml" : "image/png" })) });

describe("check_home_screen_icon.sh", () => {
  it("a host that serves the manifest and every icon with no login: exit 0, every line ok", async () => {
    const r = await run(await host({ manifest: icons(["icons/apple-touch-icon.png", "icons/icon-192.png"]) }));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("ALL GOOD");
    expect(r.out).not.toContain("FAIL");
  });
  it("icons behind a login (a redirect to /login, which is what the phone's no-cookie fetch gets): exit 1, and it says so", async () => {
    const r = await run(await host({ manifest: icons(["icons/icon-192.png"]), login: true }));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL .*apple-touch-icon\.png +302/);
  });
  it("behind a path prefix, an absolute address in the manifest is named as the fault (it asks the proxy's root)", async () => {
    const r = await run(await host({ prefix: "/hermes", manifest: icons(["/dashboard-plugins/luvebot/icons/icon-192.png"]) }));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL +\/dashboard-plugins\/luvebot\/icons\/icon-192\.png +<- an absolute address ignores the proxy prefix/);
  });
  it("the same prefix with relative addresses is fine", async () => {
    const r = await run(await host({ prefix: "/hermes", manifest: icons(["icons/apple-touch-icon.png", "icons/icon-192.png"]) }));
    expect(r.status, r.out).toBe(0);
  });
  it("an SVG in the manifest is named as a fault", async () => {
    const r = await run(await host({ manifest: icons(["icons/apple-touch-icon.png", "icons/icon.svg"]) }));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL +icons\/icon\.svg +<- an iPhone cannot draw an SVG icon/);
  });
  it("a host that does not serve the manifest at all: exit 1", async () => {
    server = http.createServer((_q, res) => { res.writeHead(302, { location: "/login" }); res.end(); });
    await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
    const r = await run(`http://127.0.0.1:${(server!.address() as { port: number }).port}`);
    expect(r.status).toBe(1);
    expect(r.out).toContain("the manifest is not served without a login");
  });
});
