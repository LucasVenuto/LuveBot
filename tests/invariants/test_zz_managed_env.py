"""DT-7 (iii) (contract v0.11 section 5.1, A-173): with a MANAGED `.env` (Hermes's managed scope, `HERMES_MANAGED_DIR`, an administrator's layer) that pins `LUVEBOT_PERSON_PROVIDERS` and
`LUVEBOT_ALLOW_LOOPBACK_APPROVALS`, Hermes's own `PUT /api/env` is REFUSED for both names (the dashboard cannot widen who is a person), the home's `.env` stays byte for byte as it was, and after a restart
of the dashboard AND the gateway the value LuveBot reads is the managed one (`GET /health` `auth.person_providers`). It holds on v0.22.5 (the managed scope exists there) with a person's login as the
writer, and on `main` with the deployment token too.

It runs ONLY on a stack started with `HERMES_MANAGED_DIR=<dir>` whose `.env` holds `LUVEBOT_PERSON_PROVIDERS=managed-idp` and `LUVEBOT_ALLOW_LOOPBACK_APPROVALS=0`:
    mkdir -p <dir> && printf 'LUVEBOT_PERSON_PROVIDERS=managed-idp\nLUVEBOT_ALLOW_LOOPBACK_APPROVALS=0\n' > <dir>/.env
    HERMES_MANAGED_DIR=<dir> one.sh dt7iii <worktree> "test_zz_managed_env.py"            (add HERMES_DASHBOARD_SESSION_TOKEN=<token> and HH=<main H> for the deployment token on main)"""
import json
import os
from pathlib import Path

import pytest

import time

from support import DASHBOARD, STATE
from test_hook import ROOT_HOME, wait_for
from test_zz_watcher_lease import dashboard_answers, kill, pid_of, sign_in

MANAGED = Path(os.environ.get('HERMES_MANAGED_DIR', ''))
PINNED = {'LUVEBOT_PERSON_PROVIDERS': 'managed-idp', 'LUVEBOT_ALLOW_LOOPBACK_APPROVALS': '0'}
pytestmark = pytest.mark.skipif(not os.environ.get('HERMES_MANAGED_DIR') or not (MANAGED / '.env').is_file()
                                or any(f'{k}={v}' not in (MANAGED / '.env').read_text() for k, v in PINNED.items()),
                                reason='needs a stack started with HERMES_MANAGED_DIR=<dir> whose .env pins the two LUVEBOT_ names (see the docstring)')
ENV_FILE = ROOT_HOME / '.env'
EXPECTED = ['basic', 'managed-idp', 'nous', 'self-hosted']
TOKEN = os.environ.get('HERMES_DASHBOARD_SESSION_TOKEN', '')


def note(line):
    print(line)
    try:
        with open(STATE / 'logs' / 'dt7-managed-timeline.txt', 'a') as handle:
            handle.write(time.strftime('%H:%M:%S ') + line + '\n')
    except OSError:
        pass


def providers(browser):
    answer = browser.request.get(DASHBOARD + '/api/plugins/luvebot/health')
    assert answer.status == 200, answer.text()[:200]
    return answer.json()['auth']['person_providers']


def restart_both(browser):
    old = {name: pid_of(name) for name in ('gateway', 'dashboard')}
    for name in old:
        kill(name)
    for name in old:
        wait_for(lambda name=name: pid_of(name) != old[name], 120, f'a new {name}')
    wait_for(lambda: dashboard_answers(browser) or None, 180, 'the dashboard to answer')
    sign_in(browser)                                                                          # a new process: its sessions are its own


def test_the_managed_env_refuses_the_write_and_wins_after_a_restart(human_browser):
    sign_in(human_browser)
    saved = ENV_FILE.read_bytes() if ENV_FILE.exists() else None
    start = providers(human_browser)
    note(f'managed .env pins {PINNED}; the list LuveBot reads from the start: {start}')
    assert start == EXPECTED                                                                  # the managed value, from the start
    writers = [('a person\'s login', lambda body: human_browser.request.put(DASHBOARD + '/api/env', data=body))]
    if TOKEN:
        import http.client
        from urllib.parse import urlsplit

        def with_token(body):
            parts = urlsplit(DASHBOARD)
            conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=30)
            conn.request('PUT', '/api/env', body=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN})
            answer = conn.getresponse()
            text = answer.read(5000).decode(errors='replace')
            conn.close()
            return type('Answer', (), {'status': answer.status, 'text': lambda self: text})()
        writers.append(('the deployment token', with_token))
    outcomes = {}
    for who, write in writers:
        for key in PINNED:
            answer = write({'key': key, 'value': 'github' if key == 'LUVEBOT_PERSON_PROVIDERS' else '1'})
            outcomes[(who, key)] = (answer.status, answer.text()[:160])
            assert answer.status >= 400, (who, key, answer.status, answer.text()[:200])        # refused, not 200
            assert 'administrator' in answer.text() or 'managed' in answer.text().lower(), (who, key, answer.text()[:200])
    for (who, key), (status, text) in outcomes.items():
        note(f'PUT /api/env {key} with {who}: {status} {text!r}')
    assert (ENV_FILE.read_bytes() if ENV_FILE.exists() else None) == saved, 'the home .env changed after a refused write'
    restart_both(human_browser)
    after = providers(human_browser)
    note(f'AFTER restarting dashboard and gateway: {after}; the home .env unchanged: {(ENV_FILE.read_bytes() if ENV_FILE.exists() else None) == saved}')
    assert after == EXPECTED, 'after the restart LuveBot did not read the managed value'
    assert (ENV_FILE.read_bytes() if ENV_FILE.exists() else None) == saved
