import { defineConfig } from "vitest/config";
import fs from "node:fs";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: {
      // the same `@luvebot/extra` as scripts/bundle-options.js (publicByDefault): the empty list with LUVEBOT_PUBLIC=1 or in a public
      // clone, where dashboard/src-private does not exist (the release's `npm test`)
      "@luvebot/extra": path.resolve(__dirname, process.env.LUVEBOT_PUBLIC === "1" || !fs.existsSync(path.resolve(__dirname, "dashboard/src-private/index.ts"))
        ? "dashboard/src/extra-empty.ts" : "dashboard/src-private/index.ts"),
      "@": path.resolve(__dirname, "dashboard/src"),
    },
  },
});
