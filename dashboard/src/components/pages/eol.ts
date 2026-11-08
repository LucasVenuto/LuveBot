// dashboard/src/components/pages/eol.ts
// The bytes of a page are the contract (ADR-009 R1): the Bot reads the file back, the 21a diff and `base_sha` are over its bytes. A <textarea>
// hands back line breaks as "\n" whatever the file had, so a page written with "\r\n" would change in every line at the first keystroke. The
// editor therefore shows the text with "\n" (toView) and writes it back with the line ending the page HAD (toDisk). A page with one kind of
// line ending (the usual case) goes there and back byte for byte; only a page that mixes them is made uniform, and only when edited.

export type Eol = "\n" | "\r\n";

/** The line ending of a page: "\r\n" when most of its breaks are "\r\n", else "\n" (also for a page with no break at all). */
export function eolOf(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/** The text as the editor shows it: every line break is "\n" (a lone "\r" is one too, as the textarea reads it). */
export const toView = (text: string): string => text.replace(/\r\n?/g, "\n");

/** The text as it is written: the editor's "\n" turned into the page's own line ending. */
export const toDisk = (view: string, eol: Eol): string => (eol === "\n" ? view : view.replace(/\n/g, "\r\n"));

/** Does the page go through the editor and back with the same bytes? False only for a page with a lone "\r" or mixed line endings. */
export const roundTrips = (text: string): boolean => toDisk(toView(text), eolOf(text)) === text;
