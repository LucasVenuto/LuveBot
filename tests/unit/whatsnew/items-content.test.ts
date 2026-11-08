// tests/unit/whatsnew/items-content.test.ts (contract whats-new-v0.md section 5: the content; slice NV-2)
// What the integrity test (the caps, the unique ids, the hidden characters) cannot see: that every "where" is a path of labels the screen REALLY has, in both languages and the same label in each; that a link
// (`go`) leads to a tab that fits the path; and that the text is written for people (no competitor, no jargon, no internal reference, one sentence). The photos of the live screen stay the last word.
import { describe, it, expect } from "vitest";
import { NEWS_ITEMS, NEWS_VERSIONS } from "@/whatsnew/items";
import { translations } from "@/i18n";

const SEP = " › ";
const PLACEHOLDERS = [["(um Bot)", "(a Bot)"], ["(uma sala)", "(a room)"], ["(uma skill)", "(a skill)"]];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A dictionary value as a matcher: `{name}` stands for any "(...)" the path writes. */
const matcher = (v: string) => new RegExp("^" + escapeRe(v).replace(/\\\{\w+\\\}/g, "\\(.+?\\)") + "$");
const labels = Object.keys(translations.pt).filter((k) => typeof (translations.pt as Record<string, unknown>)[k] === "string" && typeof (translations.en as Record<string, unknown>)[k] === "string")
  .map((k) => ({ k, pt: matcher((translations.pt as Record<string, string>)[k]), en: matcher((translations.en as Record<string, string>)[k]) }));
const sharedLabel = (pt: string, en: string) => labels.some((l) => l.pt.test(pt) && l.en.test(en));
const isPlaceholderPair = (pt: string, en: string) => PLACEHOLDERS.some(([p, e]) => pt === p && en === e);

describe("each `where` is a path of labels the screen has, in both languages", () => {
  for (const it_ of NEWS_ITEMS) {
    it(`${it_.id}: ${it_.where.pt}`, () => {
      const pt = it_.where.pt.split(SEP), en = it_.where.en.split(SEP);
      expect(en.length).toBe(pt.length);                                       // the same path in the other language
      pt.forEach((seg, i) => expect(isPlaceholderPair(seg, en[i]) || sharedLabel(seg, en[i]), `"${seg}" / "${en[i]}" is not one label of the dictionary in both languages`).toBe(true));
    });
  }
});

describe("a link leads to a tab that fits the path", () => {
  const FIRST: Record<string, string[]> = { hoje: ["Hoje"], aprovacoes: ["Aprovações"], atividade: ["Atividade"], mapa: ["Mapa"], config: ["Configurações"], regras: ["Configurações"], custos: ["Configurações"], rotinas: ["Rotinas e Agendamentos", "Perfil"] };
  it("`go` is one of the whole tabs this list uses, and the path starts where that tab is", () => {
    for (const x of NEWS_ITEMS.filter((n) => n.go)) {
      expect(Object.keys(FIRST), x.id).toContain(x.go);
      expect(FIRST[x.go!], x.id).toContain(x.where.pt.split(SEP)[0]);
    }
  });
  it("an item with no whole tab to open has no link (never a link to a deeper place)", () => {
    for (const x of NEWS_ITEMS.filter((n) => !n.go)) expect(["Hoje", "Aprovações", "Atividade", "Mapa"], x.id).not.toContain(x.where.pt);   // a whole tab by itself would link
  });
});

describe("the text is written for people", () => {
  const texts = (n: (typeof NEWS_ITEMS)[number]) => [n.title, n.what, n.where, ...(n.note ? [n.note] : [])].flatMap((p) => [p.pt, p.en]);
  const all = NEWS_ITEMS.flatMap(texts);
  it("names no other product, and no word of the private screens", () => {
    for (const s of all) { expect(s).not.toMatch(/\b(grok|dots|manus|builderz|cue)\b/i); expect(s).not.toMatch(/c[eé]rebro|\bbrain\b|vault|obsidian/i); }
  });
  it("uses no internal reference and none of the engineers' words (hook, digest, seal, token...)", () => {
    for (const s of all) { expect(s).not.toMatch(/\b(?:A|R|D|T|ADR|NV|SK|AV|BR|M|E|K|P)-?\d+[a-z]?\b/); expect(s).not.toMatch(/\b(hook|digest|seal|selo|token|csrf|endpoint|payload|webhook|nonce)\b/i); }
  });
  it("every field fits the contract's caps in BOTH languages, counted in characters (title 40, what 140, where 70, note 100): the English runs longer, so it is the one that breaks", () => {
    const CAPS = { title: 40, what: 140, where: 70, note: 100 } as const;
    for (const n of NEWS_ITEMS) for (const f of Object.keys(CAPS) as Array<keyof typeof CAPS>) {
      const p = n[f]; if (!p) continue;
      for (const l of ["pt", "en"] as const) expect([...p[l]].length, `${n.id} ${f}.${l}: ${p[l]}`).toBeLessThanOrEqual(CAPS[f]);
    }
  });
  it("`what` is ONE sentence that ends with a full stop", () => {
    for (const n of NEWS_ITEMS) for (const s of [n.what.pt, n.what.en]) { expect(s, n.id).toMatch(/[.]$/); expect(s, n.id).not.toMatch(/[.!?]\s+[A-ZÀ-Ú]/); }
  });
  it("the two languages are not the same text (a translation, not a copy)", () => {
    for (const n of NEWS_ITEMS) { expect(n.title.pt, n.id).not.toBe(n.title.en); expect(n.what.pt, n.id).not.toBe(n.what.en); }
  });
  it("an item written for a version carries that version in its id (v01-, v02-, v03-), and every version has items", () => {
    for (const n of NEWS_ITEMS) expect(n.id.startsWith(n.since.replace(".", "")), n.id).toBe(true);
    for (const v of NEWS_VERSIONS) expect(NEWS_ITEMS.some((n) => n.since === v.version), v.version).toBe(true);
  });
  it("a requirement or a limit is in the `note`: the Call needs a key, the screen tab only works on Linux, what no real Hermes proved yet says so", () => {
    const by = (id: string) => NEWS_ITEMS.find((n) => n.id === id)!;
    expect(by("v02-voice").note?.pt).toMatch(/OpenAI/);
    expect(by("v01-screen").note?.pt).toMatch(/Linux/);
    for (const id of ["v03-instructions", "v03-evidence", "v03-teach-skill", "v03-edit-skill", "v03-own-image"]) expect(by(id).note?.pt, id).toMatch(/Hermes de verdade/);
  });
});

describe("what the walk through the code found (the conference of every path): the list says what the screens do", () => {
  const by = (id: string) => NEWS_ITEMS.find((n) => n.id === id)!;
  const T = translations;
  it("`v03-steer-note` does not promise that writing to a working Bot becomes a note (the box sends nothing while a turn runs): it says the reason of a denial, and that it shows when the conversation is reopened", () => {
    const n = by("v03-steer-note");
    for (const lang of ["pt", "en"] as const) expect(n.what[lang], lang).not.toMatch(/escreve para um Bot|write to a Bot|still working|ainda está trabalhando/i);
    expect(n.what.pt).toMatch(/nega/); expect(n.what.pt).toMatch(/motivo/); expect(n.what.pt).toMatch(/reabrir/);
    expect(n.what.en).toMatch(/deny/); expect(n.what.en).toMatch(/reason/); expect(n.what.en).toMatch(/reopen/);
    expect(n.title.pt).not.toMatch(/trabalhando/); expect(n.title.en).not.toMatch(/working/);
    expect(n.where).toEqual({ pt: `(um Bot) › ${T.pt.steerNote}`, en: `(a Bot) › ${T.en.steerNote}` });   // the line the screen draws, in both languages
    expect(n.note?.pt).toMatch(/reabrir/);
  });
  it("the editor of a skill is behind the skill's own `Ver`: Perfil › Skills deste Bot › (uma skill) › Ver › Editar", () => {
    const parts = by("v03-edit-skill").where.pt.split(SEP);
    expect(parts).toEqual(["Perfil", T.pt.agentSkills, "(uma skill)", T.pt.skillsRead, T.pt.skillEditBtn]);
  });
  it("the routines screen is called what it is called, the suggestions of Hermes and a new research are in IT, and the link opens exactly that screen (it has no button of its own in the menu: the note says how to reach it)", () => {
    for (const id of ["v03-routine-suggestions", "v02-research", "v01-routines"]) {
      const n = by(id);
      expect(n.where.pt.split(SEP)[0], id).toBe(T.pt.routinesTitle); expect(n.where.en.split(SEP)[0], id).toBe(T.en.routinesTitle);
      expect(n.go, id).toBe("rotinas");
    }
    expect(by("v03-routine-suggestions").where.pt).toBe(`${T.pt.routinesTitle} › ${T.pt.rsgTitleOne}`);
    expect(by("v02-research").where.pt).toBe(`${T.pt.routinesTitle} › ${T.pt.newResearchBtn}`);
    expect(by("v03-routine-suggestions").note?.pt).toMatch(/Abrir/); expect(by("v03-routine-suggestions").note?.pt).toMatch(/Ver Rotinas/);
  });
  it("a label only a screen reader hears is never written as something to look for: 'Avisar quando', 'Crie seu Luve' (it is the title of the window, the button is 'Criar seu Luve')", () => {
    for (const n of NEWS_ITEMS) for (const lang of ["pt", "en"] as const) expect(n.where[lang], n.id).not.toMatch(/Avisar quando|Alert me when|Crie seu Luve/);
    expect(by("v03-notify-question").where.pt).toBe("Configurações › Geral › Notificações");
    expect(by("v03-notify-question").note?.pt).toMatch(/um Bot esperar uma resposta sua/);   // the box the person looks for, as the screen writes it
    expect(by("v03-notify-question").note?.en).toMatch(/a Bot waits for an answer from you/);
    expect(by("v02-luve-studio").where.pt.split(SEP).pop()).toBe(T.pt.luveCreate);
    expect(by("v02-luve-studio").where.en.split(SEP).pop()).toBe(T.en.luveCreate);
  });
});
