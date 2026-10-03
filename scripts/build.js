// scripts/build.js
import * as esbuild from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outDir = path.resolve(rootDir, "dashboard/dist");

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

await esbuild.build({
  entryPoints: [path.resolve(rootDir, "dashboard/src/index.tsx")],
  bundle: true,
  format: "iife",
  globalName: "LuveBotPluginBundle",
  outfile: path.resolve(outDir, "index.js"),
  target: ["es2022"],
  alias: {
    react: path.resolve(rootDir, "dashboard/src/shims/react.ts"),
    "react/jsx-runtime": path.resolve(
      rootDir,
      "dashboard/src/shims/react-jsx-runtime.ts"
    ),
    "react/jsx-dev-runtime": path.resolve(
      rootDir,
      "dashboard/src/shims/react-jsx-runtime.ts"
    ),
  },
  minify: false,
});

console.log("✓ Built dashboard/dist/index.js successfully (IIFE with React shim)");

// 2. Build Service Worker (dashboard/sw.js and dashboard/dist/sw.js)
const swEntry = path.resolve(rootDir, "dashboard/src/pwa/service-worker.ts");
const swOutDashboard = path.resolve(rootDir, "dashboard/sw.js");
const swOutDist = path.resolve(outDir, "sw.js");

await esbuild.build({
  entryPoints: [swEntry],
  bundle: true,
  format: "iife",
  outfile: swOutDashboard,
  target: ["es2022"],
  minify: false,
});

fs.copyFileSync(swOutDashboard, swOutDist);
console.log("✓ Built dashboard/sw.js successfully (Service Worker)");

// 3. Ensure PWA static assets are synchronized to dist/
const pwaJsonSrc = path.resolve(rootDir, "dashboard/pwa.json");
const pwaJsonDist = path.resolve(outDir, "pwa.json");
if (fs.existsSync(pwaJsonSrc)) {
  fs.copyFileSync(pwaJsonSrc, pwaJsonDist);
}

const iconsSrc = path.resolve(rootDir, "dashboard/icons");

// Mascots (T8.3, contract §14.2): single source in assets/mascots, the art never edited. Hermes serves /dashboard-plugins/luvebot/
// from dashboard/, so the 15 whole characters (<id>.svg, viewBox 0 0 256 256, no crop) are copied to dashboard/icons/mascots
// (and, with the icons below, to dist/icons/mascots), plus <id>-mini.svg for small avatars: the same file with the art's own
// lb-face class on the root, which its style uses to hide the orbit and the ground shadow. Faces (*-rosto.svg) and
// gallery.html stay out; the folder is rebuilt so nothing stale is served.
const mascotsSrc = path.resolve(rootDir, "assets/mascots");
const mascotsOut = path.resolve(iconsSrc, "mascots");
fs.rmSync(mascotsOut, { recursive: true, force: true });
fs.mkdirSync(mascotsOut, { recursive: true });
for (const f of fs.readdirSync(mascotsSrc).filter((f) => /^[a-z]+\.svg$/.test(f))) {
  const svg = fs.readFileSync(path.resolve(mascotsSrc, f), "utf8");
  const mini = svg.replace(/^(<svg [^>]*?class=")lb-mascot /, "$1lb-face lb-mascot ");
  if (mini === svg) throw new Error(`assets/mascots/${f}: the root <svg> has no class="lb-mascot …"`);
  fs.writeFileSync(path.resolve(mascotsOut, f), svg);
  fs.writeFileSync(path.resolve(mascotsOut, f.replace(/\.svg$/, "-mini.svg")), mini);
}
const iconsDist = path.resolve(outDir, "icons");
if (fs.existsSync(iconsSrc)) {
  fs.rmSync(path.resolve(iconsDist, "mascots"), { recursive: true, force: true });
  fs.cpSync(iconsSrc, iconsDist, { recursive: true });
}
console.log("✓ PWA assets synchronized to dashboard/dist");

