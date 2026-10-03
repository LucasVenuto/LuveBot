// dashboard/src/components/ui/color.ts
// The one place a Bot's accent color is read. A value that is not a plain hex falls back to the theme token,
// so nothing but a color ever reaches a style. Text on the accent is black or white, whichever reads better.

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export const FALLBACK_COLOR = "var(--color-primary)";

export const botColor = (c?: string | null): string => (c && HEX.test(c) ? c : FALLBACK_COLOR);

function luminance(hex: string): number {
  const h = hex.length === 4 ? hex.slice(1).split("").map((x) => x + x).join("") : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

export const INK = "#0b0f19";
export const PAPER = "#ffffff";

/** Text color for content sitting on the accent. A token fallback (not hex) keeps the theme's own pair. */
export function readableOn(c?: string | null): string {
  const bg = botColor(c);
  if (!HEX.test(bg)) return "var(--color-primary-foreground)";
  return contrast(bg, INK) >= contrast(bg, PAPER) ? INK : PAPER;
}

/** The accent mixed into transparency, for soft backgrounds and rings. */
export const tint = (c: string | null | undefined, pct: number) =>
  `color-mix(in srgb, ${botColor(c)} ${pct}%, transparent)`;
