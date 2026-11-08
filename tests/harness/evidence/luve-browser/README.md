# Real Chrome, driven by CDP: Crie seu Luve end to end, plus the cards of P2-4 and E-2

Nothing is installed: the scripts drive the Chrome already on the machine (headless, throwaway profile, software WebGL) over the DevTools protocol with
Node's own `WebSocket`. Node 22+, Chrome, and the repository's `node_modules` (esbuild). Each script exits non-zero if any check fails and writes
`out/*.json` and `out/*.png` next to it (git-ignored).

| Script | What it drives | Needs a backend? |
| --- | --- | --- |
| `flow.mjs` | **The whole app, for real**: the Hermes v0.22.5 panel (the built `web/` of the native harness) with LuveBot loaded by Hermes itself, signed in with the panel's password. Open the Bot, Profile, Identity, "Criar seu Luve", the four steps, "Baixar PNG" (the browser's own download, then the file's bytes), "Usar em", "Salvar", then the face in the sidebar, the Map graph node and the accessible list, a page reload (the face comes from the backend), and the audit rows in `luvebot.db`. | yes: the native harness stack with `HOLD=1` (`H=<scratch root> [VIEW=desktop\|celular] [SCHEME=light\|dark] node flow.mjs`) |
| `studio.mjs` | The real `LuveStudio` and `Avatar` (components, no backend): 3D preview, steps, PNG, blob lifecycle, the bottom edge on a phone and in a short window. | no |
| `avatar.mjs` | "Enviar imagem" (contract v0.11 §2.3), the REAL `ImageStudio` with the API mocked: a JPEG with an EXIF orientation and a marker (the preview shows it upright, the marker is in the source and NOT in what is sent), real-mouse drag and the arrow keys, and **the exported PNG checked byte for byte against the server's rules (§2.1)**: signature, `IHDR` 256 x 256 8-bit RGB/RGBA not interlaced, the CRC of every chunk, consecutive `IDAT`, inflating to exactly the expected size, nothing after `IEND`; with negative controls (a flipped byte, a trailing byte, a cut file, a bad signature, width 255, an inflation bomb must all be refused by the checker). A transparent PNG stays RGBA; a PNG that claims 30000 x 30000 and an SVG named `.png` are refused before anything is decoded; phone and dark. | no |
| `rsg.mjs` | The routine-suggestion cards (P2-4), API mocked to the contract: light/dark, phone, EN, loopback. | no |
| `evi.mjs` | The evidence card (E-2) fed by the real parser inside the real Bot bubble. | no |
| `clarify.mjs` | The Bot's question and its **Skip** button (K-3b) inside the REAL `Conversation` (an open turn, API mocked to the contract, the question stops being listed once it is resolved, as the backend does): geometry in six views (light/dark, desktop, 390 and 320 phones, PT/EN, long text, a card too narrow for one line), contrast, a **real keyboard** (`Input.dispatchKeyEvent`: Tab, Shift+Tab, Enter, Space), the Chrome **accessibility tree**, and where the **focus** is before, during and after a skip, an answer and a refused request. Not covered: a real screen reader's speech, Safari. | no |
| `approval.mjs` | The approval card (the one in the conversation and the row in Hoje) **in the REAL app**: the Hermes v0.22.5 panel with LuveBot loaded by Hermes, the real backend, a real run of a Bot whose fake model asks for a dangerous command (two independent gates ask a person in turn). A real mouse (a touch tap on the phone) and a real keyboard (`Input.dispatchKeyEvent`: Tab, Enter) decide it; checked: where the focus is before/during/after, the confirmation line (live region, `tabindex=-1`, not a Tab stop) and that Chrome's accessibility tree calls it focused, the form fields that take the focus when Sempre permitir… / Negar… open and give it back on Cancelar, the calm edge of a closed card, Hoje (the row decided HERE stays in its place and keeps the focus through the read that drops it, and through a live refresh; the count follows what is pending), no credential value in a URL or on screen, no request off 127.0.0.1, no console error. | yes: the native harness stack with `HOLD=1` (`H=<scratch root> [VIEW=desktop\|celular] [SCHEME=light\|dark] OUT=<dir> node approval.mjs`) |
| `explore-real.mjs` | Exploration only: signs in and dumps the buttons of the real panel. | yes |

`lib.mjs` has the CDP client and a static server; `glue-*.tsx` are the test pages (React is bundled there only for the test; the shipped bundle never bundles React).

## What each check proves that jsdom cannot

* **The face is what the kit says.** Every `<img src=blob:>` (sidebar, header) and the Map's `<image href=blob:>` is fetched in the page and compared **byte for byte**
  with the SVG the shipped kit builds for the chosen recipe, with a negative control (the same recipe in another color must match nothing).
* **The PNG is a real 1024 x 1024 PNG** saved by the browser, with a transparent corner and a drawn character (not blank), from the real 3D canvas.
* **Blob URLs are released**: opening the studio makes tile URLs, closing it (Esc) returns the count to what it was.
* **The audit** has the `intent` and `result` rows of `bot.display.update` (by the signed-in person, origin `ui`), and the recipe is **not** stored in clear.
* **No request leaves 127.0.0.1** (the resolver is closed to everything else) and the console has no error.

## Results (Chrome 156, macOS, main at the time of each run)

| Run | Checks | Result |
| --- | --- | --- |
| `fluxo-app-real-desktop-light` (1280 x 900) | 29 | all green |
| `fluxo-app-real-celular-light` (390 x 844, touch) | 31 | all green |
| `fluxo-app-real-desktop-dark` | 29 | all green |
| `studio-ANTES-main-sem-dock` (3 viewports) | 66 | **2 red**: the actions and "Voltar / Próximo / Usar" fell below the sheet's edge (phone and an 800 px window) |
| `studio-DEPOIS-com-dock` | 66 | all green (`shots/studio-celular-ANTES-...` vs `...-DEPOIS-...`) |
| `p2-4-sugestao-de-rotina`, `e2-cartao-de-evidencia` | 4 + 3 views | no horizontal scroll, 0 links in the evidence card, 0 console errors |

| `k3b-pular-ANTES-do-ajuste` (main a62fc4d, K-3b committed) | 88 | **15 red**: the focus fell to the page body at the click (the button turns disabled, Chrome drops its focus) and never came back, after a skip, an answer and a refused request; the confirmation ("Pulada." / "Resposta enviada.") lived 1-2 ms (the next reading no longer lists the question, so the card vanished) so nobody read it and no live region could say it; "Skip" was 40 px wide on a phone |
| `k3b-pular-DEPOIS-do-ajuste` (main ddb3e64 + the adjustment) | 88 | all green: the closed card stays as its confirmation, holds the focus (a refusal returns it to the button used), says "Pergunta do Bot" and no longer "esperando", the warning edge goes calm, the Skip is at least 44 px wide |

| `approval-ANTES-do-ajuste-desktop-claro` (main 2fb1c57 with `InlineApproval.tsx` and `Hoje.tsx` of before 8473a80, same backend) | 50 | **24 red**: after a decision the focus fell to the page body and stayed there; the confirmation line had no `tabindex`; Chrome's tree did not call it focused; the closed card kept its warning edge; Negar… / Sempre permitir… left the focus on the body, and Cancelar did not give it back |
| `approval-DEPOIS-desktop-claro` (main 2fb1c57, 8473a80 in) | 50 | all green |
| `approval-DEPOIS-celular-escuro` (390 x 844, touch) | 50 | all green |

Two honest notes. (1) The studio bug above was found only in a real layout (jsdom measures nothing); it is fixed by the sticky dock in `style.css` and has a unit test
for the structure. (2) My own first version of the Map check passed for the wrong reason (it found the sidebar's `<img>`, while the graph draws an SVG `<image>`): it is scoped
to the Bot's node now and the sidebar and reload checks no longer fall back to the whole document.

## Not covered

Safari and iOS (this is Chrome with phone emulation), a real GPU (the 3D runs on SwiftShader), "Meu Luve" in Settings in the real panel, and a Bot's reply bubble showing the person's face.
