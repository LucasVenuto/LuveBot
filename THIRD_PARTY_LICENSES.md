# Third-party licenses

Audit for Gate 0 (T0.3), 2026-09-30, for the plugin architecture (ADR-001). Replaces the earlier standalone-stack audit (kept in `archive/`).
Versions are the latest published on that date (npm and PyPI registry metadata); real pins come with each lockfile. This is not legal advice and not a full SBOM.

## Summary

- Everything is MIT, BSD, ISC or Apache-2.0 **except one item that LuveBot ships itself: noVNC, MPL-2.0**, approved by decision **D-007** (live Screen tab in v0.1). It is vendored unmodified in its own folder, under the terms in "noVNC vendoring terms" below. Nothing else is flagged (no GPL, AGPL or SSPL).
- Apart from noVNC, LuveBot ships **no third-party runtime code**: the UI bundle uses React and components provided by the Hermes dashboard at runtime (`window.__HERMES_PLUGIN_SDK__`, never bundled), and the backend imports FastAPI and the standard library from the Hermes environment. The rest is **build and test tooling**.
- Dropped from the earlier standalone-stack audit because the architecture changed: Next.js, Uvicorn, PyYAML, libsodium, PyNaCl, age, iron-proxy. noVNC came back through D-007.

## Shipped by LuveBot (vendored, not provided by Hermes)

| Name | Version | License | Role | Link |
|---|---|---|---|---|
| noVNC (`@novnc/novnc`) | **1.7.0** (tag `v1.7.0`) | **MPL-2.0** (core); MIT for `vendor/pako/`; BSD-style for `core/crypto/des.js`. Only the `core/` and `vendor/pako/` trees are used | Live Screen tab (D-007): RFB client for `/api/display/ws`. **Shipped by LuveBot**, vendored unmodified (see terms below) | <https://github.com/novnc/noVNC> |

Terms and checks are in "noVNC vendoring terms (D-007)" below.

## What runs with LuveBot (provided by Hermes, not redistributed by us)

| Name | Version | License | Role | Link |
|---|---|---|---|---|
| Hermes Agent (Nous Research) | commit `f8489405` | MIT | Host: dashboard, API Server, Kanban, plugin system. Required, not bundled | <https://github.com/NousResearch/hermes-agent> |
| FastAPI | pinned by Hermes (`0.133.1` in its `web` extra) | MIT | `plugin_api.py` router | <https://github.com/fastapi/fastapi> |
| Starlette | pinned by Hermes (`1.3.1`) | BSD-3-Clause | Under FastAPI | <https://github.com/encode/starlette> |
| React | Hermes pins `19.2.7` | MIT | Provided to the bundle by the SDK, never bundled | <https://github.com/facebook/react> |
| `@nous-research/ui` | Hermes pins `0.18.2` | MIT (registry metadata for the package name; **confirm against the pinned version**) | Dashboard components exposed through the SDK | <https://www.npmjs.com/package/@nous-research/ui> |
| Python standard library, `sqlite3` | interpreter of Hermes (3.11 to 3.14) | PSF-2.0 | Our own state (`luvebot.db`) | <https://docs.python.org/3/license.html> |

Evidence for the Hermes pins: `pyproject.toml` lines 15 and 501 and `web/package.json` lines 19 and 35 in the Hermes repo at the commit above. The Hermes repository itself is MIT (`LICENSE`, `pyproject.toml:17`).

## noVNC vendoring terms (D-007)

Upstream: <https://github.com/novnc/noVNC>, tag `v1.7.0` (released 2026-04-28; commit `63107bd06d9e1f6136ff21aeda8cd62cbf0d433e`; npm `@novnc/novnc` 1.7.0, license field `MPL-2.0`, integrity `sha512-ucEJOx4T2avIRCleodk7YobZj5O2Ga2AeLfQ69A/yjG9HHba2+PDgwSkN3FttrmG+70ZGx21sElNFouK13RzyA==`, checked when vendored). **Vendored 2026-10-02** (59 files, 583 KB of code). Upstream license statement: [`LICENSE.txt` at v1.7.0](https://github.com/novnc/noVNC/blob/v1.7.0/LICENSE.txt).

**What is vendored, and only this**

| Path in our repo | Upstream path | License (per upstream `LICENSE.txt`) |
|---|---|---|
| `dashboard/vendor/novnc/core/**` | `core/**` (`rfb.js`, `websock.js`, `display.js`, `decoders/`, `input/`, `util/`, `crypto/`, ...) | MPL-2.0; `core/base64.js` MPL-2.0; `core/crypto/des.js` "various BSD style licenses": its header (read at v1.7.0) carries permissive notices from AT&T Laboratories Cambridge, Widget Workshop and Jef Poskanzer (use, copy, modify and distribute without fee **provided the notice is kept**). Unmodified files keep the notices, which is one more reason for rule 1 |
| `dashboard/vendor/novnc/vendor/pako/**` | `vendor/pako/**` | MIT (Copyright 2014-2016 Vitaly Puzrin), license file `vendor/pako/LICENSE` |
| `dashboard/vendor/novnc/LICENSE.txt` | `LICENSE.txt` | Upstream statement |
| `dashboard/vendor/novnc/docs/LICENSE.MPL-2.0` | `docs/LICENSE.MPL-2.0` | Full MPL-2.0 text |
| `dashboard/vendor/novnc/docs/LICENSE.BSD-3-Clause` | `docs/LICENSE.BSD-3-Clause` | For the BSD-style `des.js` |
| `dashboard/vendor/novnc/SOURCE` | (ours) | Upstream URL, tag, commit SHA and the date vendored |
| `dashboard/vendor/novnc/CHECKSUMS.sha256` | (ours) | SHA-256 of every vendored file as it came from the tag |

**Not vendored, on purpose:** `app/` and everything under it. Its HTML and CSS are 2-Clause BSD, `app/styles/Orbitron*` is SIL OFL 1.1, and **`app/images/` is Creative Commons Attribution-ShareAlike 3.0**, whose share-alike terms would reach anything we mix it into. We build our own Screen UI (toolbar, take-over banner, mobile controls) in our own files.

**Rules (each one has a check)**

1. **No file inside `dashboard/vendor/novnc/` is ever edited.** Byte-identical to the tag. CI recomputes SHA-256 against `CHECKSUMS.sha256`; a changed byte fails the build (`tests/invariants/test_vendor_novnc.py`). Mutation: edit one character in `rfb.js`, the test must go red.
2. **Our code that uses noVNC lives outside that folder**, in our own MIT files, and talks to it only through its public API (`new RFB(target, url, options)`, events).
3. **Not bundled into our IIFE.** esbuild marks it `external`; the browser loads it by URL with a dynamic `import()` from `/dashboard-plugins/luvebot/vendor/novnc/core/rfb.js`. That keeps the MPL files as separate files, not merged into ours. The Hermes asset route serves `.js` as `application/javascript` ([dashboard_ui.py:376-382](https://github.com/NousResearch/hermes-agent/blob/f8489405/hermes_cli/web_routers/dashboard_ui.py#L376)), so module loading works: the T0.9 spike loaded `core/rfb.js` this way from a plugin page under the real dashboard ([hermes-integration.md §9c](docs/hermes-integration.md)).
4. **License texts travel with the code.** The folder contains the files above, the repo root has `LICENSE` (MIT, Luve AIgency, D-005) and a `NOTICE` that lists noVNC, its tag, its license and the folder, and says where to get the source (the upstream tag and this repository). MPL-2.0 section 3.2 is met because the Source Code Form is the files themselves, distributed in the repo.
5. **Upgrades replace the whole folder** from a new upstream tag, then update `SOURCE`, `CHECKSUMS.sha256` and this table in the same PR.
6. **Removal path:** because of rule 2 and 3, deleting the folder and the Screen component removes noVNC completely; the fallback (status, reason and thumbnails) does not depend on it.

**What the files being public means:** the Hermes route serves plugin assets without authentication on purpose ([dashboard_ui.py:386-395](https://github.com/NousResearch/hermes-agent/blob/f8489405/hermes_cli/web_routers/dashboard_ui.py#L386)). noVNC is public code, so that is fine; no secret or private file may ever be placed under `dashboard/` for the same reason. SRI applies only to the manifest's `entry` script ([types.ts:30](https://github.com/NousResearch/hermes-agent/blob/f8489405/web/src/plugins/types.ts#L30)), not to modules loaded afterward, so the checksum test in rule 1 is our integrity control.

## Build and test tooling (dev dependencies, not shipped in the plugin)

| Name | Version | License | Role | Link |
|---|---|---|---|---|
| esbuild | 0.28.2 | MIT | Bundle TS/JSX to one IIFE with React as external | <https://github.com/evanw/esbuild> |
| TypeScript | 7.0.2 | Apache-2.0 | Type checking (esbuild does not type-check) | <https://github.com/microsoft/TypeScript> |
| Tailwind CSS (`tailwindcss`, `@tailwindcss/cli`) | 4.3.3 | MIT | Styles, mapped to the dashboard's `--color-*` tokens | <https://github.com/tailwindlabs/tailwindcss> |
| `@types/react` | 19.3.0 | MIT | Types only | <https://github.com/DefinitelyTyped/DefinitelyTyped> |
| Vitest | 5.0.3 | MIT | Frontend unit tests | <https://github.com/vitest-dev/vitest> |
| Playwright (`@playwright/test`) | 1.63.0 | Apache-2.0 | Flow tests against a real Hermes | <https://github.com/microsoft/playwright> |
| pytest | 9.1.1 | MIT | Backend and invariant tests | <https://github.com/pytest-dev/pytest> |
| pytest-asyncio | 1.4.0 | Apache-2.0 | Async handler tests | <https://github.com/pytest-dev/pytest-asyncio> |
| httpx | 0.28.1 | BSD-3-Clause | Test client; also our backend's client to the API Server **only if the Hermes environment already provides it** | <https://github.com/encode/httpx> |
| lucide-react | 1.49.0 | ISC | Icons. **Only if** the SDK does not already expose icons; prefer the SDK's | <https://github.com/lucide-icons/lucide> |

## Flags and open points

1. **One copyleft item: noVNC (MPL-2.0), approved by D-007.** MPL-2.0 is file-level copyleft: changes to MPL-covered files must be published under MPL-2.0, but it does not reach our own files, which stay MIT (a "Larger Work", MPL-2.0 section 3.3). It stays a **separate, unmodified component** under the rules in the next section. Nothing else to escalate under MAESTRO.md section 7.
2. **New dependencies need an audit first.** Hard rule from ADR-001: no new Python runtime dependency in the plugin (it runs inside the Hermes interpreter). Any new npm dev dependency is added to this file in the same PR.
3. **`@nous-research/ui` license** was read from registry metadata for the latest package version, while Hermes pins `0.18.2`. Confirm the pinned version's `LICENSE` when the harness (T0.4) has the package installed. It is not bundled by us.
4. **Transitive dependencies are not audited yet.** Generate the full list from our lockfiles in CI (`license-checker` for npm, `pip-licenses` in the Hermes test image) and fail the build on GPL, AGPL, SSPL or unreviewed MPL.
5. **Hermes's own dependency tree** is in the Hermes image or venv, not in our repository. We do not redistribute it. Scan it once on the pinned test image for awareness.
6. **LuveBot's own license** is MIT per CLAUDE.md, with the copyright holder pending the CEO (proposal: Luve). All dependencies above are compatible with MIT.
7. **Fonts and images:** the Luve theme must use fonts and assets with a recorded license. None are chosen yet.
