// dashboard/src/components/conversation/reactionSet.ts
// The closed set of 24 reactions (docs/contracts/voice-language-reactions-v0.md section 4, A-279) and the six quick ones. The server holds the same set in ONE place (backend/reactions.py EMOJIS) and accepts a reaction only by exact
// equality, so a test reads that list and holds this one against it. Written as code points so no invisible character (the variation selector of the heart) hides inside a string; a mark Hermes stored from its own app with an emoji
// outside this set still shows (the server reduces it to a dot) and is never announced.
const cp = (...points: number[]) => String.fromCodePoint(...points);

export const REACTION_SET = [
  cp(0x1f44d), cp(0x1f44e), cp(0x2764, 0xfe0f), cp(0x1f525), cp(0x1f389), cp(0x1f44f), cp(0x1f64f), cp(0x1f4aa),   // thumbs up, thumbs down, heart, fire, party, clap, folded hands, muscle
  cp(0x2705), cp(0x274c), cp(0x2b50), cp(0x1f4a1), cp(0x1f440), cp(0x1f914), cp(0x1f642), cp(0x1f604),             // check, cross, star, bulb, eyes, thinking, smile, grin
  cp(0x1f602), cp(0x1f60d), cp(0x1f62e), cp(0x1f622), cp(0x1f621), cp(0x1f680), cp(0x1f4af), cp(0x1f91d),         // laugh, heart eyes, surprised, sad, angry, rocket, hundred, handshake
] as const;

/** The six of the bar that shows next to a hovered or focused message: thumbs up, heart, grin, party, folded hands, eyes. */
export const QUICK_REACTIONS = [cp(0x1f44d), cp(0x2764, 0xfe0f), cp(0x1f604), cp(0x1f389), cp(0x1f64f), cp(0x1f440)] as const;
