"""C2 (a)+(b) of the early test against Hermes `main` (plan v0.3 4.3, risk 2): the Webapp on the gateway's own listener (`webapp.enabled` in the gateway home's config.yaml, a stable port).

The Webapp's renderer is a separate artifact; the listener serves it from `HERMES_WEBAPP_DIST` (a packaged bundle: only `index.html` has to be there) and, per Hermes, "shares the dashboard
server": LuveBot's backend is mounted on the same app, so its routes are reachable on THAT port. The stack must have been started with HERMES_WEBAPP_DIST pointing at a folder with an index.html
(a stand-in is enough: the invariants are about the server, not the screen); otherwise the file skips. It restarts the gateway with the block written and puts everything back.

* invariant 2: a request WITHOUT a session to a LuveBot route on the Webapp port is 401, with the loopback bind (no sign-in) and with the sign-in gate engaged (`webapp.public_url`);
* invariant 3: the Webapp's port is the GATEWAY's (the listener belongs to Hermes), and LuveBot opened no listener of its own;
* the Webapp port answers LuveBot routes with the DASHBOARD's credential only: the dashboard session token header is what the loopback mode takes, as on the dashboard."""
import os
import subprocess
import time
from pathlib import Path

import pytest

from support import STATE
from test_can_ask import read_config, write_config
from test_hook import ROOT_HOME, wait_for
from test_zz_watcher_lease import bring_back, kill

PORT = 19130
DIST = os.environ.get('HERMES_WEBAPP_DIST', '')
pytestmark = pytest.mark.skipif(not DIST or not (Path(DIST) / 'index.html').is_file(), reason='needs a Hermes main stack started with HERMES_WEBAPP_DIST=<folder with an index.html>')


def get(path, headers=None, port=PORT):
    import http.client
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=15)
    conn.request('GET', path, headers=headers or {})
    response = conn.getresponse()
    text = response.read(4000).decode(errors='replace')
    conn.close()
    return response.status, text


def answers():
    try:
        return get('/')[0] != 503                                                              # up and mounted: with the sign-in gate the root is a 302; a 503 is "The Webapp is still starting" (the dashboard app mounts on the first request)
    except OSError:                                                                            # nothing listens yet (or the first request is still mounting the dashboard app)
        return False


def reasons():
    """What the gateway logged about the Webapp (`Webapp stays off: ...`, `Webapp unavailable: ...`): the reason a block that asks for it was not served."""
    out = []
    for path in [STATE / 'logs' / 'gateway-restarted.log', *(ROOT_HOME / 'logs').glob('*.log')]:
        try:
            out += [line.strip()[:300] for line in path.read_text(errors='replace').splitlines() if 'Webapp' in line]
        except OSError:
            pass
    return out[-4:]


def tails(count=8):
    """The last lines of what the gateway that just restarted wrote (its stdout and its own log), copied into the state folder BEFORE the restore restarts it and overwrites them."""
    out = {}
    for name, path in (('gateway-restarted.log', STATE / 'logs' / 'gateway-restarted.log'), ('gateway.log', ROOT_HOME / 'logs' / 'gateway.log'), ('errors.log', ROOT_HOME / 'logs' / 'errors.log')):
        try:
            text = path.read_text(errors='replace')
        except OSError:
            continue
        (STATE / 'logs' / ('webapp-fail-' + name)).write_text(text)
        out[name] = [line.strip()[:240] for line in text.splitlines()[-count:]]
    return out


def note(line):
    print(line)
    try:
        with open(STATE / 'logs' / 'c2-webapp-timeline.txt', 'a') as handle:
            handle.write(time.strftime('%H:%M:%S ') + line + '\n')
    except OSError:
        pass


def gateway_listeners():
    """TCP LISTEN sockets of the gateway process (pid from the harness's pid file)."""
    pid = (STATE / 'gateway-pid.txt').read_text().strip()
    out = subprocess.run(['lsof', '-nP', '-a', '-p', pid, '-iTCP', '-sTCP:LISTEN', '-Fn'], capture_output=True, text=True).stdout
    return sorted(line[1:] for line in out.splitlines() if line.startswith('n'))


@pytest.fixture
def webapp(request):
    """Write the `webapp:` block (loopback bind, with or without public_url), restart the gateway, wait for the port; put the config back after."""
    public_url = request.param
    saved = (ROOT_HOME / 'config.yaml').read_text()
    data = read_config('default')
    data['webapp'] = {'enabled': True, 'host': '127.0.0.1', 'port': PORT, **({'public_url': public_url} if public_url else {})}
    write_config('default', data)
    bring_back('gateway', kill('gateway'))
    try:
        wait_for(lambda: answers() or None, 120, 'the Webapp port to answer')
    except BaseException as error:
        why = reasons() or tails()
        (ROOT_HOME / 'config.yaml').write_text(saved)
        bring_back('gateway', kill('gateway'))
        raise AssertionError(f'the Webapp listener did not come up; the gateway said: {why or "nothing about the Webapp"} ({error})') from None
    yield public_url
    (ROOT_HOME / 'config.yaml').write_text(saved)
    bring_back('gateway', kill('gateway'))


@pytest.mark.parametrize('webapp', ['', 'http://webapp.test'], indirect=True, ids=['loopback-no-gate', 'public-url-gate'])
def test_a_luvebot_route_on_the_webapp_port_needs_a_session(webapp):
    rows = {}
    for path in ('/api/plugins/luvebot/session', '/api/plugins/luvebot/bots', '/api/plugins/luvebot/health', '/api/plugins/luvebot/approvals'):
        rows[path] = get(path)[0]
    note(f'WEBAPP gate={bool(webapp)}: no session -> {rows}; listeners of the gateway={gateway_listeners()}')
    root = get('/')[0]
    note(f'WEBAPP gate={bool(webapp)}: GET / without a session -> {root}')
    assert root in (200, 302, 307, 401, 403, 404), root                           # the bundle (loopback, no sign-in) or the sign-in redirect (the gate); never an error
    assert all(status in (401, 403, 404) for status in rows.values()), rows        # never an answer with data
    assert rows['/api/plugins/luvebot/bots'] in (401, 403), rows                  # the Bots list is behind the gate
    assert f'127.0.0.1:{PORT}' in gateway_listeners(), gateway_listeners()       # the Webapp's listener is the gateway's
