// tests/unit/skills/skill-words.test.ts
// The words of the "teach a skill" flow (contract v0.11 3.4): ONE list of reasons for the extractor and the server, the class of a refused character named in words (never the character), the description's limit
// said as a NUMBER (SK-2d), and none of the server's English ever shown.
import { describe, it, expect } from "vitest";
import { ApiError } from "@/api/client";
import { translations } from "@/i18n";
import { skillError, whyText, type T } from "@/components/skills/skillWords";

const make = (locale: "pt" | "en"): T => (k, p) => {
  let s = (translations[locale] as Record<string, string>)[k] ?? `<<${String(k)}>>`;
  for (const [name, value] of Object.entries(p ?? {})) s = s.replace(`{${name}}`, String(value));
  return s;
};
const pt = make("pt"), en = make("en");
const refused = (code: string, extra: Partial<{ why: string; details: Record<string, unknown>; status: number }> = {}) =>
  new ApiError({ code, message: "English for developers, never shown", status: extra.status ?? 422, details: extra.details, why: extra.why });

describe("whyText: every reason of the closed list has its own words, in both languages", () => {
  const WHYS = ["none", "two_fences", "unclosed", "no_frontmatter", "header_too_long", "bad_yaml", "yaml_alias", "bad_name", "bad_category", "no_description", "empty_body", "too_large", "hermes_refused"];
  it("each reason says something specific, none is the generic sentence, none shows a placeholder or a code", () => {
    const seen = new Set<string>();
    for (const why of WHYS) for (const t of [pt, en]) {
      const text = t === pt ? whyText(why, undefined, pt) : whyText(why, undefined, en);
      expect(text, why).not.toContain("<<");
      expect(text, why).not.toContain("{");
      expect(text, why).not.toContain(why);
      if (why !== "hermes_refused") expect(text, why).not.toBe(whyText("something-new", undefined, t));
      if (t === pt) { expect(seen.has(text), why).toBe(false); seen.add(text); }
    }
  });
  it("a reason nobody knows (a newer server) is the plain 'not accepted' sentence, never the server's text", () => {
    expect(whyText("brand_new_reason", undefined, pt)).toBe(translations.pt.skillWhyOther);
    expect(whyText(undefined, undefined, en)).toBe(translations.en.skillWhyOther);
    expect(whyText(null, undefined, en)).toBe(translations.en.skillWhyOther);
  });
});

describe("the description's limit is a number, never 'too long' alone (SK-2d)", () => {
  it("60 for a new skill, 1024 for an edit, in both languages", () => {
    expect(whyText("description_too_long", { limit: 60 }, pt)).toBe("A descrição passa do limite: no máximo 60 caracteres.");
    expect(whyText("description_too_long", { limit: 1024 }, pt)).toContain("1024");
    expect(whyText("description_too_long", { limit: 60 }, en)).toBe("The description is over the limit: at most 60 characters.");
    expect(whyText("description_too_long", { limit: 1024 }, en)).toContain("1024");
  });
  it("a limit that is not a number says so without inventing one", () => {
    for (const limit of [undefined, null, "60", NaN, 1.5, Infinity, {}]) {
      const text = whyText("description_too_long", { limit } as never, pt);
      expect(text, String(limit)).toBe(translations.pt.skillWhyDescriptionTooLongNoLimit);
      expect(text).not.toMatch(/\d/);
    }
    expect(whyText("description_too_long", undefined, en)).toBe(translations.en.skillWhyDescriptionTooLongNoLimit);
  });
});

describe("a refused character: its CLASS in words, where it is, never the character", () => {
  const where = (code: string) => whyText("hidden_characters", { code, line: 4, column: 17 }, pt);
  it.each([
    ["U+E0041", "etiqueta Unicode"], ["U+E0100", "seletor de variação"], ["U+202E", "direção do texto"], ["U+2028", "separador de linha"],
    ["U+0000", "caractere de controle"], ["U+0085", "caractere de controle"], ["U+FFFF", "o Unicode não atribui"], ["U+D800", "caractere oculto"],
  ])("%s -> %s", (code, words) => {
    const text = where(code);
    expect(text).toContain(words);
    expect(text).toContain("linha 4, coluna 17");
    expect(text).not.toContain(code);
  });
  it("the place is a number or a question mark, never text from the server", () => {
    expect(whyText("hidden_characters", { code: "U+E0041", line: "3; drop", column: undefined }, pt)).toContain("linha ?, coluna ?");
  });
  it("too many invisible: the count, and the limit of 50", () => {
    expect(whyText("too_many_invisible", { count: 51 }, pt)).toBe("Este texto tem 51 caracteres invisíveis; o limite é 50.");
    expect(whyText("too_many_invisible", { count: 51 }, en)).toBe("This text holds 51 invisible characters; the limit is 50.");
  });
});

describe("skillError: what each refusal of the routes says", () => {
  it("skill_invalid goes by its why and details; the server's English is never shown", () => {
    const e = skillError(refused("skill_invalid", { why: "description_too_long", details: { limit: 60 } }), pt, "skillWhyOther");
    expect(e).toEqual({ text: "A descrição passa do limite: no máximo 60 caracteres.", code: "skill_invalid" });
    expect(JSON.stringify(e)).not.toContain("English for developers");
  });
  it("the secret, the existing name and the unverified state each have their own words", () => {
    expect(skillError(refused("skill_has_secret"), pt, "skillWhyOther")).toEqual({ text: translations.pt.skillHasSecret, code: "skill_has_secret" });
    expect(skillError(refused("skill_exists", { status: 409 }), en, "skillWhyOther")).toEqual({ text: translations.en.skillExists, code: "skill_exists" });
    expect(skillError(refused("skill_exists", { status: 409, details: { appeared_meanwhile: true } }), pt, "skillWhyOther")).toEqual({ text: translations.pt.skillExistsMeanwhile, code: "skill_exists" });   // A-187
    expect(skillError(refused("skill_exists", { status: 409, details: { appeared_meanwhile: true } }), en, "skillWhyOther")).toEqual({ text: translations.en.skillExistsMeanwhile, code: "skill_exists" });
    // what the person must learn from it (the Lume's info): it is NOT the text they reviewed, and LuveBot turned it off, in both languages
    expect(translations.pt.skillExistsMeanwhile).toMatch(/Não é a que você revisou/);
    expect(translations.pt.skillExistsMeanwhile).toMatch(/O LuveBot a desligou/);
    expect(translations.en.skillExistsMeanwhile).toMatch(/not the one you reviewed/);
    expect(translations.en.skillExistsMeanwhile).toMatch(/LuveBot turned it off/);
    for (const details of [{ appeared_meanwhile: false }, { appeared_meanwhile: "true" }, {}]) {                  // only the boolean true says it
      expect(skillError(refused("skill_exists", { status: 409, details }), pt, "skillWhyOther")).toEqual({ text: translations.pt.skillExists, code: "skill_exists" });
    }
    expect(skillError(refused("skill_state_unverified", { status: 502 }), pt, "skillWhyOther")).toEqual({ text: translations.pt.skillUnverified, code: "skill_state_unverified" });
  });
  it("a scan that blocks the turn-on names the categories, only plain ones and at most twelve", () => {
    const e = skillError(refused("skill_scan_blocked", { status: 409, details: { verdict: "dangerous", categories: ["exfiltration", "<b>x</b>", 7, "persistence"] } }), pt, "skillWhyOther") as { text: string };
    expect(e.text).toBe(`${translations.pt.skillScanBlocked} (envio de dados para fora, deixa algo que roda de novo)`);       // Hermes's categories in words, not as codes
    const many = skillError(refused("skill_scan_blocked", { details: { categories: Array.from({ length: 20 }, (_, i) => `c${i}`) } }), pt, "skillWhyOther") as { text: string };
    expect(many.text.match(/c\d+/g)).toHaveLength(12);
    expect((skillError(refused("skill_scan_blocked"), pt, "skillWhyOther") as { text: string }).text).toBe(translations.pt.skillScanBlocked);
  });
  it("anything else falls to the general words (a login, a paused Bot...) with the code behind 'Detalhe técnico'", () => {
    expect(skillError(refused("credential_not_human", { status: 403 }), pt, "skillWhyOther")).toMatchObject({ code: "credential_not_human" });
    expect(skillError(new Error("boom"), pt, "skillWhyOther")).toEqual({ text: translations.pt.skillWhyOther, code: null });
  });
});
