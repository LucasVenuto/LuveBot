// tests/unit/style-type.test.ts
// Style guide §1: no text under 12 px and no tracked all-caps labels in the screens already moved to the guide.
// Add a folder here when its slice lands. Tab-bar labels (11 px, HIG) live in style.css, not here.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MIGRATED = ["messenger", "chat", "conversation", "ui", "agent", "transcript", "Hoje.tsx", "home", "rooms", "approvals", "activity", "map", "settings", "costs", "rules", "routines", "bots", "search", "pages"];
const root = path.resolve(process.cwd(), "dashboard/src/components");
const SMALL = /fontSize:\s*(?:[0-9]|1[01])\b|fontSize="(?:[0-9]|1[01])"|text-\[(?:[0-9]|1[01])px\]|font:\s*"[0-9]+ (?:[0-9]|1[01])px|letterSpacing:\s*"0\.0[5-9]em"/;

function files(p: string): string[] {
  const full = path.join(root, p);
  if (fs.statSync(full).isFile()) return [full];
  return fs.readdirSync(full).flatMap((f) => files(path.join(p, f)));
}

export function smallText(src: string): string[] {
  return src.split("\n").map((l, i) => [l, i + 1] as const).filter(([l]) => SMALL.test(l)).map(([l, i]) => `${i}: ${l.trim().slice(0, 90)}`);
}

describe("type scale in migrated screens", () => {
  it("has no text under 12 px and no tracked caps", () => {
    const hits = MIGRATED.flatMap(files).filter((f) => /\.tsx?$/.test(f)).flatMap((f) => smallText(fs.readFileSync(f, "utf8")).map((h) => `${path.relative(root, f)}:${h}`));
    expect(hits).toEqual([]);
  });

  it("the check catches 11 px and tracked caps (mutation)", () => {
    expect(smallText('<span style={{ fontSize: 11 }}>x</span>')).toHaveLength(1);
    expect(smallText('<b style={{ letterSpacing: "0.06em" }}>APROVAÇÃO</b>')).toHaveLength(1);
    expect(smallText('<span style={{ fontSize: 12 }}>x</span>')).toHaveLength(0);
    expect(smallText('<text fontSize="9">x</text>')).toHaveLength(1);
  });
});
