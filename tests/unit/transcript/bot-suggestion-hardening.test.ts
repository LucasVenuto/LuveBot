// tests/unit/transcript/bot-suggestion-hardening.test.ts
// Red team 29/10 B2: the Bot's suggestion marker (agent text) let formatting characters through (the right-to-left override, isolates, zero-width,
// line separator, C1 controls), so a name could show reversed or broken on the card; and it toggled the code fence on ANY line of three backticks, so a
// marker inside a four-backtick fence (which the Markdown shows as code) became a card. Now: plain text only, and a fence closes the way the renderer reads it.
import { describe, it, expect } from "vitest";
import { parseMarker, splitBotSuggestions } from "@/lib/botSuggestion";

const marker = (name: string, role = "Cobra faturas") => `[luvebot:sugerir-bot nome="${name}" papel="${role}"]`;
const kinds = (text: string) => splitBotSuggestions(text).map((s) => s.kind);

describe("the name and the role are plain text", () => {
  it("a formatting or separator character in either is not a card (reversal, isolates, zero-width, BOM, line separator, C1)", () => {
    for (const bad of ["\u202e", "\u2066", "\u2069", "\u200b", "\u200f", "\ufeff", "\u2028", "\u2029", "\u0085", "\u009f"]) {
      expect([JSON.stringify(bad), parseMarker(marker(`Cob${bad}rança`))]).toEqual([JSON.stringify(bad), null]);
      expect([JSON.stringify(bad), parseMarker(marker("Cobrança", `Cobra${bad}faturas`))]).toEqual([JSON.stringify(bad), null]);
    }
  });

  it("an ordinary name, with accents, an emoji or a hyphen, is still a card", () => {
    expect(parseMarker(marker("Cobrança"))).toEqual({ name: "Cobrança", role: "Cobra faturas" });
    expect(parseMarker(marker("Suporte 🚀", "Atende o suporte-nível-1"))).toEqual({ name: "Suporte 🚀", role: "Atende o suporte-nível-1" });
  });
});

describe("the code fence is read by its size", () => {
  const inside = (open: string, close: string) => `texto\n${open}\n${marker("Cobrança")}\n${close}\ndepois`;

  it("a marker inside a four-backtick fence stays text even with a three-backtick line inside it; after the real closing it is a card again", () => {
    expect(kinds(`${"````"}\n\`\`\`\n${marker("Cobrança")}\n${"````"}`)).toEqual(["text"]);                     // the ``` line did not close the fence
    expect(kinds(`${"````"}\n\`\`\`\nx\n${"````"}\n${marker("Cobrança")}`)).toEqual(["text", "bot"]);
  });

  it("the ordinary three-backtick and tilde fences still hide a marker, and the marker after them is a card", () => {
    expect(kinds(inside("```", "```"))).toEqual(["text"]);
    expect(kinds(inside("~~~", "~~~"))).toEqual(["text"]);
    expect(kinds(`\`\`\`\nx\n\`\`\`\n${marker("Cobrança")}`)).toEqual(["text", "bot"]);
  });

  it("a shorter line, another character, or a closer with words after it does not close the fence", () => {
    expect(kinds(inside("````", "```"))).toEqual(["text"]);                    // shorter
    expect(kinds(inside("```", "~~~"))).toEqual(["text"]);                     // another character
    expect(kinds(inside("```", "``` ainda dentro"))).toEqual(["text"]);        // words after it: not a closing line
    expect(kinds(inside("```", "``````"))).toEqual(["text"]);                  // a longer closer does close it...
  });
});
