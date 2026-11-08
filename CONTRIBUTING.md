# Contributing to LuveBot

LuveBot is under development. Contributions should expose and improve the Hermes experience rather than recreate its runtime. Please follow our [Code of Conduct](CODE_OF_CONDUCT.md); report vulnerabilities through the process in [SECURITY.md](SECURITY.md).

## Small pull requests, with evidence

1. Check the existing work and agree on one objective. For behavior changes, read `CLAUDE.md`, `MAESTRO.md`, the product specification and current decisions. State a short plan and the files you intend to touch before starting.
2. Keep the PR focused. Integrate through Hermes's supported APIs; link to the upstream code or documentation that supports every new Hermes behavior assumption. Coordinate changes to contracts across modules before implementing them.
3. Add or update meaningful tests for the behavior you change. Backend checks use pytest, frontend checks use Vitest, and end-to-end flows use Playwright against a real Hermes test instance. Do not mock the boundary a security test is meant to prove.
4. Run the relevant checks and include the exact commands and actual output in the PR: passed, skipped and failed counts, a file summary, and any remaining limitations. Explain skipped checks; do not weaken an invariant to make a check pass. UI changes also need desktop/mobile and light/dark screenshots.
5. Update public documentation in English. Label unbuilt features as roadmap. Audit new dependencies and preserve third-party notices before including them.

Current frontend commands, from the repository root:

```sh
npm ci
npm run build
npm test
```

The real-Hermes harness has separate setup and execution instructions in [tests/harness/README.md](tests/harness/README.md). There is not yet a single command that verifies the complete v0.1 release.

## Security invariants are tests

The following are required behavior from `CLAUDE.md`, not a statement that all controls have shipped. Security changes need tests in `tests/invariants/` and evidence that a deliberate break makes the relevant test fail. Follow the red-team and review gates in `MAESTRO.md`.

| Invariant | Required evidence |
| --- | --- |
| No secrets reach the browser | Canary credentials absent from responses, errors, logs and streams; include dashboard session tokens. |
| Every plugin API route is authenticated | Requests without a dashboard session return 401. |
| No new server or listening port | The plugin runs inside the dashboard; verify loading it creates no listener. |
| Hermes writes use official paths | Effects go through Hermes APIs; an exception requires an explicit specification requirement and ADR. |
| Every effectful action is audited | Record who, what, when and origin; failure to record must prevent the action. |
| Approvals require a human | No automatic resolution; “Always allow” creates only a draft rule. |
| Spending caps actually pause work | On breach, pause the Bot's cron jobs and refuse new LuveBot runs; test with a deliberate loop and document in-flight and external-run limits. |
| Rule labels match enforcement | Distinguish actual blocking, active approval gates and advisory instructions; detect a misleading label. |
| Compatibility is declared | Check Hermes version and `/v1/capabilities`; disable unsupported features with an explanation. |

Treat session content, tool output, email, web pages and other agent content as untrusted data. Render safe text or sanitized Markdown without raw agent HTML. Hermes profiles are not isolation boundaries; do not present them as sandboxes.

## Proposed DCO sign-off — pending maintainer confirmation

**This is a proposal, not an adopted requirement or merge gate.** Maintainers still need to confirm whether LuveBot will require the [Developer Certificate of Origin 1.1](https://developercertificate.org/).

If adopted, contributors would certify their right to submit each contribution under the applicable license by adding a `Signed-off-by` line to each commit, typically with:

```sh
git commit -s
```

Example trailer:

```text
Signed-off-by: Your Name <your-email@example.com>
```

Read the DCO before signing. A sign-off becomes part of the public commit history and includes the identity and email address you supply. LuveBot's own code uses [MIT](LICENSE); third-party code retains its own terms. Do not edit the planned vendored noVNC files; follow [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for replacement and license checks.
