// scripts/build-css.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const srcCss = path.resolve(rootDir, "dashboard/src/style.css");
const outDir = path.resolve(rootDir, "dashboard/dist");
const outCss = path.resolve(outDir, "style.css");

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Enforce local tailwindcss binary (network fallback via npx is strictly prohibited)
const localBin = path.resolve(rootDir, "node_modules/.bin/tailwindcss");
if (!fs.existsSync(localBin)) {
  console.error(
    "Error: tailwindcss binary not found at " +
      localBin +
      ". Please run 'npm install' to install dependencies locally. Network fallback (npx) is prohibited."
  );
  process.exit(1);
}

try {
  execFileSync(localBin, ["--input", srcCss, "--output", outCss], { cwd: rootDir, stdio: "inherit" });
  if (!fs.existsSync(outCss) || fs.statSync(outCss).size === 0) {
    throw new Error("Compiled CSS is missing or empty");
  }
  const size = fs.statSync(outCss).size;
  console.log(`✓ Built dashboard/dist/style.css successfully (${size} bytes)`);
} catch (err) {
  console.error("Failed to build CSS with Tailwind:", err.message);
  process.exit(1);
}
