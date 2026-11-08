"""The Lume's question (DT-1b, contract v0.11 section 5.1): can the DEPLOYMENT credential widen who LuveBot treats as "a person with a login" by writing `LUVEBOT_PERSON_PROVIDERS` through Hermes's own
`PUT /api/env`, and what does that change once the processes restart?

The credential is the deployment session token of Hermes `main` (`HERMES_DASHBOARD_SESSION_TOKEN=<token>`, the `session_token` dashboard-auth plugin; v0.22.5 has no such provider, so the file skips there):
the stack is started with that variable, as for tests/invariants/test_zz_deployment_token_main.py. Measured on the real Hermes:

  * the gate holds: no credential and a wrong token are 401 on `PUT /api/env`;
  * what the token's `PUT /api/env {key: LUVEBOT_PERSON_PROVIDERS}` (and `LUVEBOT_ALLOW_LOOPBACK_APPROVALS`, DT-7 i) does (accepted or refused, `.env` written or not) is recorded in `logs/dt-env-timeline.txt` and pinned by the asserts;
  * LIVE, before any restart: the list `GET /health` shows (`auth.person_providers`) does not move (identity reads the variable ONCE, when the plugin loads);
  * AFTER restarting the dashboard AND the gateway (both host the plugin): a declared provider is on the list, a malformed one, a different spelling, `session-token` and `drain-secret` are not, and the deployment
    token is STILL not a person (a route that needs one answers `403 credential_not_human`), so the write widens who may log in by another provider and never makes the credential itself a person;
  * the harness is put back (`.env` byte for byte, a last restart)."""
import http.client
import json
import os
import time
from urllib.parse import urlsplit

import pytest

from support import DASHBOARD, STATE
from test_hook import ROOT_HOME, wait_for
from test_zz_deployment_token_main import with_the_token
from test_zz_watcher_lease import kill, pid_of

TOKEN = os.environ.get('HERMES_DASHBOARD_SESSION_TOKEN', '')
pytestmark = pytest.mark.skipif(not TOKEN or TOKEN.startswith('file:'), reason='needs a Hermes main stack started with HERMES_DASHBOARD_SESSION_TOKEN=<token> (the session_token auth plugin)')
ENV_FILE = ROOT_HOME / '.env'
KEY = 'LUVEBOT_PERSON_PROVIDERS'
VALUE = 'github,session-token,drain-secret,GitHub,bad name'      # one real name, the two never-people, a different spelling, a name with a space
DEFAULT = ['basic', 'nous', 'self-hosted']
UNKNOWN = 'a' * 32


def note(line):
    print(line)
    try:
        with open(STATE / 'logs' / 'dt-env-timeline.txt', 'a') as handle:
            handle.write(time.strftime('%H:%M:%S ') + line + '\n')
    except OSError:
        pass


def api(method, path, token=TOKEN, payload=None):
    parts = urlsplit(DASHBOARD)
    conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=30)
    headers = {'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})}
    conn.request(method, path, body=json.dumps(payload).encode() if payload is not None else None, headers=headers)
    response = conn.getresponse()
    text = response.read(20000).decode(errors='replace')
    conn.close()
    return response.status, text


def answers(path):
    """True once `path` answers 200 with the deployment token; a process that is still starting refuses the connection, which is not an error here."""
    try:
        return api('GET', path)[0] == 200
    except OSError:
        return False


def providers():
    status, text = api('GET', '/api/plugins/luvebot/health')
    assert status == 200, (status, text[:200])
    return json.loads(text)['auth']['person_providers']


def restart_both():
    """The same home and environment, a new process each (the entrypoint relaunches only what it was asked to: `kill` writes the flag first)."""
    old = {name: pid_of(name) for name in ('gateway', 'dashboard')}
    for name in old:
        kill(name)
    for name in old:
        wait_for(lambda name=name: pid_of(name) != old[name], 120, f'a new {name}')
    wait_for(lambda: answers('/api/status'), 180, 'the dashboard to answer')
    wait_for(lambda: answers('/api/plugins/luvebot/session'), 180, 'LuveBot to answer with the deployment token')


def test_the_deployment_token_can_declare_a_provider_but_never_makes_itself_a_person():
    saved = ENV_FILE.read_bytes() if ENV_FILE.exists() else None
    try:
        assert providers() == DEFAULT
        assert api('PUT', '/api/env', token=None, payload={'key': KEY, 'value': 'github'})[0] == 401          # the gate holds
        assert api('PUT', '/api/env', token='x' * 43, payload={'key': KEY, 'value': 'github'})[0] == 401
        assert (ENV_FILE.read_text() if ENV_FILE.exists() else '').count(KEY) == 0

        status, text = api('PUT', '/api/env', payload={'key': KEY, 'value': VALUE})
        written = ENV_FILE.exists() and KEY in ENV_FILE.read_text()
        note(f'PUT /api/env with the deployment token: {status} {text[:200]!r}; .env has the key: {written}')
        assert status == 200 and written, (status, text[:300])                                                  # the answer to the question: it can write it
        # DT-7 (i), the second name: the same writer takes `LUVEBOT_ALLOW_LOOPBACK_APPROVALS` (written as `0`: it records the fact and turns nothing on; the `.env` is put back at the end)
        status2, text2 = api('PUT', '/api/env', payload={'key': 'LUVEBOT_ALLOW_LOOPBACK_APPROVALS', 'value': '0'})
        note(f'PUT /api/env LUVEBOT_ALLOW_LOOPBACK_APPROVALS=0 with the deployment token: {status2} {text2[:160]!r}')
        assert status2 == 200 and 'LUVEBOT_ALLOW_LOOPBACK_APPROVALS=0' in ENV_FILE.read_text(), (status2, text2[:300])
        live = providers()
        note(f'LIVE after the write, before any restart: {live}')
        assert live == DEFAULT, 'the list moved without a restart: identity must read the variable once'

        restart_both()
        after = providers()
        note(f'AFTER restarting dashboard and gateway: {after}')
        assert after == sorted(DEFAULT + ['github']), after                                                    # only the well-formed, allowed name came in
        status, _data, text = with_the_token('POST', f'/approvals/{UNKNOWN}/resolve', {'digest': '0' * 64, 'choice': 'deny'})       # with the token's own CSRF: the first gate is the person
        note(f'deployment token on a route that needs a person, after the restart: {status} {text[:160]!r}')
        assert status == 403 and json.loads(text)['error']['code'] == 'credential_not_human', (status, text[:300])
        assert api('GET', '/api/plugins/luvebot/session')[0] == 200                                             # it still reads
    finally:
        if saved is None:
            ENV_FILE.unlink(missing_ok=True)
        else:
            ENV_FILE.write_bytes(saved)
        restart_both()
    assert providers() == DEFAULT, 'the harness was not put back'
