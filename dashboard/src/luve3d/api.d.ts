// dashboard/src/luve3d/api.d.ts: o que dist/luve3d.js registra na página (fatia K2). Quem usa: o carregador único da
// interface (luve3d/load.ts, fatia U3), que põe o arquivo pela URL constante e lê só este objeto.

/** Receita já parseada por parseLuve (assets/mascots/luve.mjs); o 3D confere de novo antes de desenhar. */
export interface LuveRecipe { shape: string; material: string; accessory: string; hex: string }

export interface Luve3dView {
  /** Troca a receita (lança se não conferir). */
  set(recipe: LuveRecipe): void;
  /** PNG quadrado (padrão 1024 px), fundo transparente, o Luve de frente. */
  toPNG(size?: number): Promise<Blob>;
  /** Para o laço, solta os ouvintes e libera o contexto WebGL. */
  dispose(): void;
}

export interface Luve3d {
  version: 1;
  /** Lança se a receita não conferir ou se o WebGL faltar: quem chama mostra a prévia 2D. Arrastar gira; dois toques, de frente.
   *  Sem prefers-reduced-motion o Luve balança devagar sozinho; com ele, só se mexe arrastando. */
  mount(canvas: HTMLCanvasElement, recipe: LuveRecipe, opts?: { state?: "idle" | "working" | "needs_you"; reducedMotion?: boolean }): Luve3dView;
}

declare global {
  interface Window { __LUVEBOT_LUVE3D__?: Luve3d }
}
