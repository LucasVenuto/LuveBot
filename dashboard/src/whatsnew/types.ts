// dashboard/src/whatsnew/types.ts
// "Novidades" (docs/contracts/whats-new-v0.md section 1): the shape of the static list that the bundle carries. Plain data, no behaviour.

export type NewsVersion = "v0.1" | "v0.2" | "v0.3";

/** Both languages, always: Portuguese is the source and English a faithful translation. */
export interface Pair { pt: string; en: string }

export interface NewsItem {
  /** stable, kebab-case, never reused, unique across the public and the private list together: it is the mark of the item ("v02-free-mode") */
  id: string;
  since: NewsVersion;
  /** plain words, at most 40 characters */
  title: Pair;
  /** ONE sentence of what it does, at most 140 characters */
  what: Pair;
  /** the screen and the path, in the words of the screen, at most 70 characters: "Perfil do Bot › Habilidades" */
  where: Pair;
  /** a requirement or a limit, at most 100 characters: "Precisa de uma chave da OpenAI" */
  note?: Pair;
  /** the id of a WHOLE tab of the shell ("regras", "custos", ...); never a deeper place */
  go?: string;
  /** a key of GET /health `features`: the item shows only while the host reports it */
  feature?: string;
}

export interface NewsVersionInfo { version: NewsVersion; status: "released" | "unreleased"; date?: string }

/** The caps of section 1; the list test holds them. */
export const NEWS_CAPS = { title: 40, what: 140, where: 70, note: 100 } as const;
