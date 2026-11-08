"""C1 of the early test against Hermes `main` (plan v0.3 4.3; contract v0.10 section 1): what LuveBot does when the config backend Hermes selected cannot serve config, and when it refuses a
write, with Hermes's OWN classes (`ConfigBackendUnavailable`, `ConfigLockedError`, `ConfigValueError`, `ConfigWriteError`) raised from the places Hermes itself calls its backend.

The backend is `tests/harness/config_backend_forja.py` (selected with HERMES_CONFIG_BACKEND=forja; the lane copies it into the Hermes tree): the file backend plus an outage and locks that flag
files in the stack's state folder turn on. The same situation `HERMES_CONFIG_BACKEND=remote` creates with a config service that is down or a key an administrator locked, without a server.
It runs ONLY when that backend is the one selected (main has the seam, v0.22.5 does not); anywhere else the file is skipped.

* an outage: routes of ours answer `503 config_backend_unavailable` (when they read the config) and never take the dashboard down: the same pid before, during and after; the hostile URL,
  password and token of the exception text appear in no response and in no line LuveBot logged (Hermes logs its own exception text, with them, when ITS task dies);
  NOT measured here, by Hermes's own design: how long the budget watcher survives an outage. On `main` an outage is fatal to Hermes itself (`ConfigBackendUnavailable` is a SystemExit on
  purpose: the gateway's supervised tasks die with it within a second, and with an outage of about 5 s the harness stack went down), so only an outage of a second or two can be observed;
* a refused write (`PUT /bots/vendas/voice/client-direct`, which goes through Hermes's own `update_config` route: `http_failure` wraps the refusal in an HTTPException, 403 / 400 / 500, `raise ... from`
  the ConfigWriteError, and LuveBot reads the CAUSE, 6687999): `409 config_key_locked` with `details.key` and nothing else, `422 config_value_invalid`; a refusal Hermes has no mapping for
  (`ConfigWriteError` itself) is a generic `502 hermes_error`, see EXPECTED; never `hermes_unreachable` and never the text of the exception."""
import os
import time

import pytest

from support import STATE
from test_hook import ROOT_HOME, wait_for
from test_phase4 import put
from test_runs import get
from test_zz_watcher_lease import beats, dashboard_answers, pid_of, sign_in

pytestmark = pytest.mark.skipif(os.environ.get('HERMES_CONFIG_BACKEND') != 'forja', reason='needs a Hermes with the ConfigBackend seam and the forja test backend selected (main)')

OUTAGE = STATE / 'config-outage'
WRITE = STATE / 'config-write'
HOSTILE = ('hostile-pass', 'hostile-token', 'config.example.test')
ROUTES = ('/bots/vendas', '/bots', '/routines', '/health', '/budget')


def note(line):
    print(line)
    try:
        with open(STATE / 'logs' / 'c1-main-timeline.txt', 'a') as handle:
            handle.write(time.strftime('%H:%M:%S ') + line + '\n')
    except OSError:
        pass


def code_of(response):
    try:
        return (response.json().get('error') or {}).get('code')
    except Exception:  # noqa: BLE001
        return None


@pytest.fixture(autouse=True)
def flags_off(human_browser):
    """HERMES's own gateway dies on an outage (its `hosted_room_worker` task raises the SystemExit and the gateway goes: by Hermes's design, `ConfigBackendUnavailable` is a SystemExit on purpose):
    the entrypoint relaunches it only when asked to, so the flag is written BEFORE every test; each test then starts on a stack with both processes up and a valid session."""
    OUTAGE.unlink(missing_ok=True)
    WRITE.unlink(missing_ok=True)
    (STATE / 'restart-gateway').write_text('1')
    wait_for(lambda: dashboard_answers(human_browser) or None, 120, 'the dashboard to answer')
    sign_in(human_browser)
    yield
    OUTAGE.unlink(missing_ok=True)
    WRITE.unlink(missing_ok=True)
    wait_for(lambda: dashboard_answers(human_browser) or None, 120, 'the dashboard to answer after the test')


def logs_text():
    """What LuveBot logged: the lines of its own loggers (`luvebot.*`). Hermes logs the exception it raised ITSELF with its text (a gateway task that dies on the outage): that is Hermes's."""
    out = ''
    for path in (ROOT_HOME / 'logs').glob('*.log'):
        out += ''.join(line for line in path.read_text(errors='replace').splitlines(True) if ' luvebot.' in line)
    return out


def test_an_outage_is_a_503_on_the_route_and_the_dashboard_keeps_serving(human_browser):
    before = pid_of('dashboard')
    assert get(human_browser, '/bots/vendas').status == 200
    OUTAGE.write_text('1')
    try:
        rows = {}
        for route in ROUTES:
            answer = get(human_browser, route)
            rows[route] = (answer.status, code_of(answer))
            assert not any(h in answer.text() for h in HOSTILE), (route, 'the exception text reached a response')
        note(f'OUTAGE routes: {rows}')
        assert rows['/bots/vendas'] == (503, 'config_backend_unavailable'), rows           # the route that reads the config says so, in words
        assert all(status in (200, 503) for status, _ in rows.values()), rows               # nothing else breaks in another way (no 500, no 502)
        assert all(code in (None, 'config_backend_unavailable') for _, code in rows.values()), rows
    finally:
        OUTAGE.unlink(missing_ok=True)
    after = get(human_browser, '/bots/vendas')
    assert after.status == 200, (after.status, after.text()[:200])
    assert pid_of('dashboard') == before, 'the dashboard process was replaced'
    assert dashboard_answers(human_browser)
    assert not any(h in logs_text() for h in HOSTILE), 'the exception text reached a log'


# `failed` is MEASURED, not wished for (Hermes main 6bb377a5): `http_failure` raises a lock and a bad value `from exc` (a `__cause__`, which `config_write_refusal` reads) but a refusal it has no mapping for
# as a bare `raise HTTPException(500, f"{prefix}: {exc}")` inside the `except` (a `__context__` only), so LuveBot cannot tell it from any other 500: 502 `hermes_error`, in its own words, nothing of the text.
EXPECTED = {'locked': (409, 'config_key_locked'), 'invalid': (422, 'config_value_invalid'), 'failed': (502, 'hermes_error')}


def refused_write(human_browser, mode):
    """The V6 write goes through Hermes's OWN route (`update_config`), and on main its `http_failure` turns a refused write into an HTTPException of its own (a lock 403, a value 400/413, anything
    else 500) before LuveBot sees it. LuveBot reads the refusal from the exception's cause (`config_write_refusal`, 6687999): each mode says its own code, in words of its own, and leaks nothing
    (the hostile text of the exception is in no response and in no LuveBot log)."""
    WRITE.write_text(mode)
    answer = put(human_browser, '/bots/vendas/voice/client-direct', {'enabled': False})
    note(f'WRITE {mode}: {answer.status} {answer.text()[:200]}')
    assert (answer.status, code_of(answer)) == EXPECTED[mode], (answer.status, answer.text()[:300])
    assert not any(h in answer.text() for h in HOSTILE), 'the exception text reached the response'
    WRITE.unlink(missing_ok=True)
    assert not any(h in logs_text() for h in HOSTILE), 'the exception text reached a LuveBot log'
    return answer


@pytest.mark.parametrize('mode', ['invalid', 'failed'])
def test_a_refused_write_says_which_refusal_and_never_shows_the_exception_text(human_browser, mode):
    refused_write(human_browser, mode)


def test_a_locked_key_through_a_hermes_route_says_config_key_locked(human_browser):
    """Was the xfail of the finding (Hermes main 6bb377a5: the lock reached us as `502 hermes_error`); fixed by 6687999, `details.key` and nothing else."""
    answer = refused_write(human_browser, 'locked')
    assert set((answer.json().get('error') or {}).get('details') or {}) == {'key'}, answer.text()[:200]
