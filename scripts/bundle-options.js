// scripts/bundle-options.js
// The esbuild options of the dashboard bundle, in one place: scripts/build.js builds with them. `@luvebot/extra` is the neutral
// extension point for extra screens: the default build resolves it to dashboard/src-private/index.ts (screens that stay out of
// the public repository); LUVEBOT_PUBLIC=1 resolves it to dashboard/src/extra-empty.ts (an empty list). A static alias: nothing
// is loaded at run time, and the public bundle holds none of the private code.
import fs from "node:fs";
import path from "node:path";

/** Public when asked (LUVEBOT_PUBLIC=1) or when the private folder is not there at all: a public clone has no
 *  dashboard/src-private, and `npm run build` there must still work. */
export function publicByDefault(rootDir) {
  return process.env.LUVEBOT_PUBLIC === "1" || !fs.existsSync(path.resolve(rootDir, "dashboard/src-private/index.ts"));
}

export function bundleOptions(rootDir, { publicBuild = publicByDefault(rootDir) } = {}) {
  return {
    entryPoints: [path.resolve(rootDir, "dashboard/src/index.tsx")],
    bundle: true,
    format: "iife",
    globalName: "LuveBotPluginBundle",
    target: ["es2022"],
    alias: {
      react: path.resolve(rootDir, "dashboard/src/shims/react.ts"),
      "react/jsx-runtime": path.resolve(rootDir, "dashboard/src/shims/react-jsx-runtime.ts"),
      "react/jsx-dev-runtime": path.resolve(rootDir, "dashboard/src/shims/react-jsx-runtime.ts"),
      "@luvebot/extra": path.resolve(rootDir, publicBuild ? "dashboard/src/extra-empty.ts" : "dashboard/src-private/index.ts"),
    },
    minify: false,
  };
}
