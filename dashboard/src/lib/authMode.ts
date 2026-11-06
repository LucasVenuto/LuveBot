// dashboard/src/lib/authMode.ts
// Who is at the other end of the dashboard (contract v0.11 5.1). `gated` is a person with a login. `loopback` has no login, and `deployment` is the deployment token of Hermes `main`: a MACHINE. Both may read and
// tighten (pause, lower a cap, stop, dismiss); neither may decide (approve, answer, turn on, raise, activate), and the server refuses them with different words (`loopback_not_human`, `credential_not_human`).
// The screen says the same before the click, and never gives one the other's sentence. The rule is the server's (`human_refusal`): ONLY `gated` is a person; anything else is closed, and a mode nobody knows (a
// newer server, a typo, "GATED", an empty string, a session that answered with no mode) counts as the machine, the way the server answers it (`credential_not_human`). The screen asks this of what a session
// ANSWERED; a session that could not be read at all leaves the decision to the server at the click, as before.

export type NoLogin = "loopback" | "deployment";

/** What the screen must treat as "cannot decide": null for a person (exactly `gated`), else why. */
export function noLoginOf(mode: unknown): NoLogin | null {
  if (mode === "gated") return null;
  return mode === "loopback" ? "loopback" : "deployment";
}
