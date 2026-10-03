// dashboard/src/lib/botName.ts
// The name a person sees. A Bot without a label of its own (the backend default is the profile id) shows its id in
// Title Case: "juridico" → "Juridico", "trafego-pago" → "Trafego Pago". Accents cannot be guessed; the profile edits them.

export function displayName(name: string, label?: string | null): string {
  if (label && label !== name) return label;
  return name.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || name;
}

/** Applied where Bots enter the app (the list and the detail), so every screen reading `display.label` gets the same name. */
export function withDisplayName<T extends { name: string; display?: { label?: string } }>(bot: T): T {
  if (!bot.display) return bot;
  const label = displayName(bot.name, bot.display.label);
  return label === bot.display.label ? bot : { ...bot, display: { ...bot.display, label } };
}
