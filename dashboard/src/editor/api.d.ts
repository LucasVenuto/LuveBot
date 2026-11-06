// dashboard/src/editor/api.d.ts: what a visual editor file registers on the page (ADR-009 §6, the "costura"). NO library yet (D-029, option C):
// today nothing registers it and the page editor is the Markdown source with a toolbar. The day one is bundled, it goes in dist/editor.js, is
// loaded only when the editor opens (editor/load.ts) and plugs in here WITHOUT touching how a page is saved, reviewed or versioned: the
// contract with the page is TEXT, and the text is Markdown.
//
// R1, in code: the page editor keeps the text it loaded and asks the editor for `getMarkdown()` ONLY after `onChange` fired. An editor that
// normalizes on load (a `*` into a `-`, an escaped `|`, a dropped table) changes nothing until the person edits; one that cannot hold a
// page without changing its bytes must say so by refusing to mount (it throws) and the page editor stays in the source.

export interface PageEditorView {
  /** The page as Markdown, line breaks "\n" (the page editor writes the page's own line ending). Read only after onChange. */
  getMarkdown(): string;
  /** Takes the editor off the element and frees what it holds. */
  destroy(): void;
}

export interface PageEditorSeam {
  version: 1;
  /** Mounts into `element`. `text` is the page (line breaks "\n"); `onChange` fires after an edit by the person, never on mount. Throws when it cannot hold this page. */
  mount(element: HTMLElement, options: { text: string; onChange: () => void }): PageEditorView;
}

declare global {
  interface Window { __LUVEBOT_EDITOR__?: PageEditorSeam }
}
