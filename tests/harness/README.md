# Real Hermes / repository plugin harness (T1.1)

The active harness loads the **real LuveBot repository**, read-only, at
`/root/.hermes/plugins/luvebot` inside Docker. It does not install the disposable
T0 spike. Hermes remains the unmodified checkout at
`f8489405600c9a7d9d2f307dace086f18d7173ba`; only the local OpenAI-compatible model
provider is fake. No host packages or host Hermes plugins are installed.

## Run

Requirements: an existing Docker daemon/Compose, host Python 3 (stdlib only),
and the clean pinned Hermes checkout at `/tmp/hermes-agent` (`HERMES_SOURCE` can
select another clean checkout). `up.sh` rejects a dirty/wrong checkout. The
repository root is bind-mounted read-only as the plugin (`../..` from
`compose.yaml`). Ports 9119 and 8642 must be free. Build dependencies, pytest
and Playwright Chromium live in the image, not the host.

From the repository root:

```sh
./tests/harness/up.sh
docker compose -f tests/harness/compose.yaml ps
docker compose -f tests/harness/compose.yaml exec -T hermes \
  python -m pytest -c /dev/null -s -v \
  /root/.hermes/plugins/luvebot/tests/invariants/test_plugin.py \
  -p no:cacheprovider --basetemp=/tmp/t11-final \
  --junitxml=/fixtures/evidence/pytest-final.xml
```

The native dashboard binds 0.0.0.0:9119 **inside** Docker, engaging its real auth
gate; host publication is 127.0.0.1 only. The native API Server uses 8642, also
published only on host loopback. Profiles `default` and `vendas` have distinct
random keys and use the local fake model. Credentials and the extra `.env`
canary are generated once in `/tmp/luvebot-harness/credentials.json` (0600,
`HARNESS_STATE` can override the state directory). Their values are never printed.
The profile `.env` files exist only inside the isolated test container.

`entrypoint.py` first starts the native dashboard with LuveBot disabled, records
TCP LISTEN entries from `/proc/net/tcp{,6}`, restarts that dashboard with LuveBot
enabled, then records the entries again. The gateway remains running. Snapshots
are `/fixtures/ports-before.json` and `ports-after.json`. Besides 9119/8642,
Docker's internal DNS listener can appear; the test compares the entire set in
**the same container**, including that listener, before/after load and requests.
Native process stdout/stderr are in `/fixtures/logs/`, scanned for real canaries.

## Probes and mutations

The invariant suite checks:

- Every route discovered from the actual `router` returns 401 without a session.
  The authenticated requests use a real password login/session cookie.
- Actual profile keys, the extra `.env` canary, password and signing key appear
  in no discovered response/header, validation error or real process log. Tokens
  from the human session are also checked in `/session`. Failure output omits
  canary values, including during intentional secret-leak mutations.
- The plugin adds no listener. Source grep covers `plugin_api.py` and every
  backend Python module for bind/listen/server constructs; TCP listeners are
  compared before/after plugin load and after calling all discovered routes.
- `/session` uses the verified principal as `provider:user_id`; its opaque CSRF
  token is stable for that verified session and changes on a real new login.
- `/health` matches the native `/api/status` version/release and probes the real
  capabilities for both profiles. Each key works for its own profile and receives
  401 at the other. This source build reports version `unknown`; the dated
  baseline check uses the actual `release_date` and required capability flags/
  endpoint shapes, rather than claiming a commit attestation from that version.
- A pure detector disables missing flags/endpoints on an actual captured
  capabilities payload. This is a pure-input check, not a fake Hermes endpoint.
- Suspending/resuming the real gateway produces HTTP 200 health with `ok:false`,
  disabled API features and a safe timeout problem. An unusable **real** LuveBot
  audit path similarly produces HTTP 200 with `db.ok:false`, then is restored.
- The installer runs twice inside a fresh container-local Hermes home. Files and
  theme match; the native enabled list contains LuveBot once.

The health router consumes Brasa's audited `AuditLog` to initialize/check **own
LuveBot state** and report the existing schema. It never implements or edits that
module. Hermes settings/profiles/secrets are accessed through native helpers,
not direct file reads in the product client. `groups` remains unknown and
approval actions unavailable with explanatory problems; no mutation routes are
implemented by T1.1. `sdk.version` is the supported baseline SDK, not a browser
attestation. No database rows/tokens/API payloads are proxied through health.

Run the three required mutations:

```sh
python3 tests/harness/mutate_plugin.py
```

The host-stdlib runner creates **only `/tmp` file overlays**: an added route that
returns the real key, an added route intentionally exempted from the native auth
gate, and an extra listener on 127.0.0.1:9127. It recreates the test Hermes service,
runs only the matching invariant, requires a test failure (not a setup error),
and restores the read-only repository mount in `finally`. It never edits product
files or the upstream clone. Raw mutation output is retained under
`/tmp/luvebot-harness/evidence/`; `evidence/t11/` holds the reviewed delivery.

The previous T0.4/T0.8 test sources and `evidence/t08/` are historical Gate 0
artifacts. Their generated spike tests are not the active T1.1 suite. To reproduce
that old setup, use a separate checkout of `6f50cbf`; do not rewrite the current
repository into a spike or skip failed historical tests in this harness.

## Install into an existing Hermes

Build the frontend using Prisma's build instructions first. Use the Python
interpreter where Hermes is already installed (no dependencies are installed):

```sh
HERMES_PYTHON=/path/to/hermes/python ./scripts/install.sh
```

The script copies `dashboard/` and `backend/` into
`${HERMES_HOME:-$HOME/.hermes}/plugins/luvebot`, copies `theme/luve.yaml` into
`dashboard-themes/`, and enables LuveBot through Hermes's native activation
transaction. It is idempotent and handles running from the installed directory.
Restart the dashboard after installation. The harness tests this **inside the
container only**; it does not install into the host's real Hermes home.

```sh
docker compose -f tests/harness/compose.yaml down
```

This stops only these test services/network. Isolated evidence remains in `/tmp`.
No Docker socket or host Hermes home is mounted. This lightweight image lacks
Xvnc/Xfce; T0.9 is a separate task and has not been started here.

## Pinned upstream implementation

- [Plugin mounting and scope dependency](https://github.com/NousResearch/hermes-agent/blob/f8489405600c9a7d9d2f307dace086f18d7173ba/hermes_cli/web_server_dashboard.py#L794)
  and [mount/enable gate](https://github.com/NousResearch/hermes-agent/blob/f8489405600c9a7d9d2f307dace086f18d7173ba/hermes_cli/web_server_dashboard.py#L805).
- [Native status handler](https://github.com/NousResearch/hermes-agent/blob/f8489405600c9a7d9d2f307dace086f18d7173ba/hermes_cli/web_routers/status.py#L460)
  and [version/release fields](https://github.com/NousResearch/hermes-agent/blob/f8489405600c9a7d9d2f307dace086f18d7173ba/hermes_cli/web_routers/status.py#L503).
- [Verified Session](https://github.com/NousResearch/hermes-agent/blob/f8489405600c9a7d9d2f307dace086f18d7173ba/hermes_cli/dashboard_auth/middleware.py#L204)
  and [real password login](https://github.com/NousResearch/hermes-agent/blob/f8489405600c9a7d9d2f307dace086f18d7173ba/hermes_cli/dashboard_auth/routes.py#L372).
- [Native profile list](https://github.com/NousResearch/hermes-agent/blob/f8489405600c9a7d9d2f307dace086f18d7173ba/hermes_cli/profiles.py#L994),
  [await-safe profile scope](https://github.com/NousResearch/hermes-agent/blob/f8489405600c9a7d9d2f307dace086f18d7173ba/hermes_cli/web_server_profiles.py#L277),
  [secret reader](https://github.com/NousResearch/hermes-agent/blob/f8489405600c9a7d9d2f307dace086f18d7173ba/agent/secret_scope.py#L219),
  [per-profile key validation](https://github.com/NousResearch/hermes-agent/blob/f8489405600c9a7d9d2f307dace086f18d7173ba/gateway/platforms/api_server.py#L1562)
  and [capabilities](https://github.com/NousResearch/hermes-agent/blob/f8489405600c9a7d9d2f307dace086f18d7173ba/gateway/platforms/api_server.py#L2537).
- [Native activation transaction](https://github.com/NousResearch/hermes-agent/blob/f8489405600c9a7d9d2f307dace086f18d7173ba/hermes_cli/plugins_cmd.py#L588).
- [Forced redactor](https://github.com/NousResearch/hermes-agent/blob/f8489405600c9a7d9d2f307dace086f18d7173ba/agent/redact.py#L881).
