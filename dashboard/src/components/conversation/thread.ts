// dashboard/src/components/conversation/thread.ts
// A thread's first message as Hermes stored it (contract v0.8 §4): the server writes the quote line in front of what the person typed, so a reopened
// thread shows "[Respondendo à mensagem …: «…»]" at the top of its first message. The panel takes that line off the bubble and shows it as the quote it
// is. The excerpt cannot contain « or » (the server turns them into ‹ ›), so the first »] closes it. Anything that does not match stays as it was said.

export interface Quote { who: "person" | "bot"; name: string | null; hour: string | null; excerpt: string }

const QUOTE = /^\[Respondendo à mensagem (da pessoa|de ([^\s():]+))(?: \(([^)]*)\))?: «([\s\S]*?)»\]\n\n([\s\S]*)$/;

export function splitQuote(text: string): { quote: Quote | null; text: string } {
  const m = QUOTE.exec(text);
  if (!m) return { quote: null, text };
  return { quote: { who: m[1] === "da pessoa" ? "person" : "bot", name: m[2] ?? null, hour: m[3] || null, excerpt: m[4] }, text: m[5] };
}
