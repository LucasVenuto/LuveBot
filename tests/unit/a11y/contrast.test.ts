// tests/unit/a11y/contrast.test.ts
// WCAG 2.1 Contrast Ratio Verification for Luve Theme Tokens (Light and Dark)
// Asserts all functional and bot identity token pairs achieve CR >= 4.5:1 (WCAG AA).

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Calculates WCAG 2.1 relative luminance for a given hex color string.
 * L = 0.2126 * R + 0.7152 * G + 0.0722 * B
 * where each channel is linearized.
 */
export function getRelativeLuminance(hex: string): number {
  const cleanHex = hex.replace("#", "").trim();
  let r = 0;
  let g = 0;
  let b = 0;

  if (cleanHex.length === 3) {
    r = parseInt(cleanHex[0] + cleanHex[0], 16) / 255;
    g = parseInt(cleanHex[1] + cleanHex[1], 16) / 255;
    b = parseInt(cleanHex[2] + cleanHex[2], 16) / 255;
  } else if (cleanHex.length === 6) {
    r = parseInt(cleanHex.substring(0, 2), 16) / 255;
    g = parseInt(cleanHex.substring(2, 4), 16) / 255;
    b = parseInt(cleanHex.substring(4, 6), 16) / 255;
  } else {
    throw new Error(`Invalid hex color: ${hex}`);
  }

  const linearize = (c: number): number => {
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };

  const rLin = linearize(r);
  const gLin = linearize(g);
  const bLin = linearize(b);

  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/**
 * Calculates WCAG 2.1 contrast ratio between two hex colors.
 * CR = (L1 + 0.05) / (L2 + 0.05) where L1 is the lighter luminance.
 */
export function getContrastRatio(hex1: string, hex2: string): number {
  const lum1 = getRelativeLuminance(hex1);
  const lum2 = getRelativeLuminance(hex2);
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  const ratio = (lighter + 0.05) / (darker + 0.05);
  return Math.round(ratio * 100) / 100;
}

// Extracted from theme/luve.yaml
export const LUVE_DARK_TOKENS = {
  background: "#0b0f19",
  card: "#111827",
  cardForeground: "#f8fafc",
  popover: "#1e293b",
  popoverForeground: "#f8fafc",
  primary: "#38bdf8",
  primaryForeground: "#0b0f19",
  secondary: "#1e293b",
  secondaryForeground: "#e2e8f0",
  muted: "#1e293b",
  mutedForeground: "#94a3b8",
  accent: "#1e293b",
  accentForeground: "#f8fafc",
  destructive: "#f87171",
  destructiveForeground: "#ffffff",
  destructiveFill: "#dc2626",
  success: "#4ade80",
  warning: "#fbbf24",
  border: "#334155",
};

// Extracted from docs/propostas/design-luve.md
export const LUVE_LIGHT_TOKENS = {
  background: "#f8fafc",
  card: "#ffffff",
  cardForeground: "#0f172a",
  popover: "#ffffff",
  popoverForeground: "#0f172a",
  primary: "#0369a1",
  primaryForeground: "#ffffff",
  secondary: "#e2e8f0",
  secondaryForeground: "#0f172a",
  muted: "#f1f5f9",
  mutedForeground: "#475569",
  accent: "#e2e8f0",
  accentForeground: "#0f172a",
  destructive: "#b91c1c",
  destructiveForeground: "#ffffff",
  destructiveFill: "#b91c1c",
  success: "#15803d",
  warning: "#b45309",
  border: "#cbd5e1",
};

// 8 Bot Archetype Palette
export const BOT_COLORS = {
  vendas: { dark: "#60a5fa", light: "#1d4ed8" },
  suporte: { dark: "#34d399", light: "#047857" },
  dev: { dark: "#a78bfa", light: "#6d28d9" },
  pesquisa: { dark: "#fbbf24", light: "#b45309" },
  conteudo: { dark: "#fb7185", light: "#be123c" },
  ops: { dark: "#38bdf8", light: "#0369a1" },
  gabinete: { dark: "#fb923c", light: "#c2410c" },
  revisor: { dark: "#e879f9", light: "#a21caf" },
};

describe("Luve Theme WCAG 2.1 Contrast Calculations (T6.3)", () => {
  it("theme/luve.yaml file matches expected token values in dark mode", () => {
    const yamlPath = path.resolve(__dirname, "../../../theme/luve.yaml");
    const yamlContent = fs.readFileSync(yamlPath, "utf-8");

    expect(yamlContent).toContain('card: "#111827"');
    expect(yamlContent).toContain('cardForeground: "#f8fafc"');
    expect(yamlContent).toContain('primary: "#38bdf8"');
    expect(yamlContent).toContain('primaryForeground: "#0b0f19"');
    expect(yamlContent).toContain('mutedForeground: "#94a3b8"');
    expect(yamlContent).toContain('destructive: "#f87171"');
    expect(yamlContent).toContain('success: "#4ade80"');
    expect(yamlContent).toContain('warning: "#fbbf24"');
  });

  describe("Dark Mode Token Contrast (CR >= 4.5:1)", () => {
    it("foreground on canvas background achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_DARK_TOKENS.cardForeground, LUVE_DARK_TOKENS.background);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(18.3, 1);
    });

    it("foreground on card surface achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_DARK_TOKENS.cardForeground, LUVE_DARK_TOKENS.card);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(16.96, 1);
    });

    it("foreground on popover surface achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_DARK_TOKENS.popoverForeground, LUVE_DARK_TOKENS.popover);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(13.98, 1);
    });

    it("mutedForeground on background achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_DARK_TOKENS.mutedForeground, LUVE_DARK_TOKENS.background);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(7.47, 1);
    });

    it("mutedForeground on card achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_DARK_TOKENS.mutedForeground, LUVE_DARK_TOKENS.card);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(6.92, 1);
    });

    it("primary accent text on canvas background achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_DARK_TOKENS.primary, LUVE_DARK_TOKENS.background);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(8.94, 1);
    });

    it("primaryForeground on primary fill button achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_DARK_TOKENS.primaryForeground, LUVE_DARK_TOKENS.primary);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(8.94, 1);
    });

    it("secondaryForeground on secondary fill achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_DARK_TOKENS.secondaryForeground, LUVE_DARK_TOKENS.secondary);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(11.87, 1);
    });

    it("destructive text on canvas background achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_DARK_TOKENS.destructive, LUVE_DARK_TOKENS.background);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(6.92, 1);
    });

    it("destructiveForeground on destructive fill achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_DARK_TOKENS.destructiveForeground, LUVE_DARK_TOKENS.destructiveFill);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(4.83, 1);
    });

    it("success status text on background achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_DARK_TOKENS.success, LUVE_DARK_TOKENS.background);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(10.99, 1);
    });

    it("warning status text on background achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_DARK_TOKENS.warning, LUVE_DARK_TOKENS.background);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(11.47, 1);
    });
  });

  describe("Light Mode Token Contrast (CR >= 4.5:1)", () => {
    it("foreground on canvas background achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_LIGHT_TOKENS.cardForeground, LUVE_LIGHT_TOKENS.background);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(17.06, 1);
    });

    it("foreground on card surface achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_LIGHT_TOKENS.cardForeground, LUVE_LIGHT_TOKENS.card);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(17.85, 1);
    });

    it("mutedForeground on background achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_LIGHT_TOKENS.mutedForeground, LUVE_LIGHT_TOKENS.background);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(7.24, 1);
    });

    it("mutedForeground on card achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_LIGHT_TOKENS.mutedForeground, LUVE_LIGHT_TOKENS.card);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(7.58, 1);
    });

    it("primary on card background achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_LIGHT_TOKENS.primary, LUVE_LIGHT_TOKENS.card);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(5.93, 1);
    });

    it("primaryForeground on primary fill button achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_LIGHT_TOKENS.primaryForeground, LUVE_LIGHT_TOKENS.primary);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(5.93, 1);
    });

    it("secondaryForeground on secondary fill achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_LIGHT_TOKENS.secondaryForeground, LUVE_LIGHT_TOKENS.secondary);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(14.48, 1);
    });

    it("destructive on card achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_LIGHT_TOKENS.destructive, LUVE_LIGHT_TOKENS.card);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(6.47, 1);
    });

    it("success on card achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_LIGHT_TOKENS.success, LUVE_LIGHT_TOKENS.card);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(5.02, 1);
    });

    it("warning on card achieves >= 4.5:1", () => {
      const cr = getContrastRatio(LUVE_LIGHT_TOKENS.warning, LUVE_LIGHT_TOKENS.card);
      expect(cr).toBeGreaterThanOrEqual(4.5);
      expect(cr).toBeCloseTo(5.02, 1);
    });
  });

  describe("8 Bot Archetypes Contrast in Dark and Light Modes (CR >= 4.5:1)", () => {
    Object.entries(BOT_COLORS).forEach(([botName, colors]) => {
      it(`bot "${botName}" satisfies WCAG AA (>= 4.5:1) in both modes`, () => {
        const darkCr = getContrastRatio(colors.dark, LUVE_DARK_TOKENS.background);
        const lightCr = getContrastRatio(colors.light, LUVE_LIGHT_TOKENS.background);

        expect(darkCr).toBeGreaterThanOrEqual(4.5);
        expect(lightCr).toBeGreaterThanOrEqual(4.5);
      });
    });
  });
});
