// Types of luve.mjs for the TypeScript of dashboard/src (the module itself is plain JS shared with build.mjs and the 3D).
export interface LuveRecipe { shape: string; material: string; accessory: string; hex: string }
export interface LuvePalette { light: string; base: string; deep: string; rim: string; edge: string; gear: string }
export const KIT: any;  // the generated luve-kit.json (shapes, materials, accessories, fit, swatches)
export const SHAPES: readonly string[];
export const MATERIAL_IDS: readonly string[];
export const ACCESSORY_IDS: readonly string[];
export function parseLuve(value: unknown): LuveRecipe | null;
export function formatLuve(recipe: LuveRecipe): string;
export function isRecipe(recipe: unknown): recipe is LuveRecipe;
export function luvePalette(hex: string): LuvePalette;
export function buildLuveSvg(recipe: LuveRecipe | null, state?: string, mini?: boolean): string | null;
