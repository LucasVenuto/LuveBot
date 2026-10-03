"""T1.1 invariants against the REAL, mounted LuveBot/Hermes plugin."""
import copy
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
from urllib.parse import quote

import pytest
from fastapi.routing import APIRoute

from support import API, DASHBOARD, ROOT, STATE, credentials, http, listeners, plugin, plugin_variant

PREFIX = '/api/plugins/luvebot'


def routes():
    discovered = [(method, PREFIX + route.path) for route in plugin().router.routes
                  if isinstance(route, APIRoute) for method in sorted(route.methods)]
    assert discovered, 'The real plugin must expose routes'
    return discovered


def no_secret(content, channel):
    if isinstance(content, str):
        content = content.encode()
    values = credentials()
    for name in ('api_key', 'vendas_api_key', 'extra_canary', 'password', 'signing_key'):
        if values[name].encode() in content:
            pytest.fail('Secret canary found in ' + channel + ' (value withheld)', pytrace=False)


def sys_client():
    plugin()
    import luvebot_backend.hermes_client as client
    return client


def test_all_discovered_routes_require_a_dashboard_session():
    for method, path in routes():
        # Native requests have no cookies, bearer or session header.
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError
        try:
            with urlopen(Request(DASHBOARD + path, method=method), timeout=10) as response:
                status = response.status
        except HTTPError as error:
            status = error.code
            no_secret(error.read(), 'unauthenticated error')
        assert status == 401, f'Unprotected route: {method} {path} -> {status}'
    print('Every route discovered through the real router -> HTTP 401 without a session')



def loopback_sweep(module, methods=None):
    """Red team 1, gap G1.1: every route of `module`'s router in a real FastAPI app at the dashboard's address, as a LOOPBACK dashboard
    serves it (no auth gate in front: the plugin's own `_identity` is the only check), called WITHOUT x-hermes-session-token.
    -> [(method, path, status)]. Path parameters get a placeholder; the check runs before any of them is read."""
    from fastapi import FastAPI
    from starlette.testclient import TestClient
    app = FastAPI()
    app.state.auth_required = False
    app.include_router(module.router, prefix=PREFIX)
    swept = []
    with TestClient(app, base_url='http://127.0.0.1:9119', raise_server_exceptions=False) as client:
        for route in module.router.routes:
            if not isinstance(route, APIRoute):
                continue
            for method in sorted(route.methods):
                if methods and method not in methods:
                    continue
                path = PREFIX + re.sub(r'\{[^}]+\}', 'g11x', route.path)
                body = {} if method in ('POST', 'PUT', 'PATCH') else None
                swept.append((method, path, client.request(method, path, json=body).status_code))
    return swept


def test_g1_1_a_loopback_dashboard_answers_401_on_every_route_without_the_session_token():
    swept = loopback_sweep(plugin())
    assert len(swept) == len(routes()), 'every discovered route was called'
    assert [s for s in swept if s[2] != 401] == []


@pytest.mark.parametrize('edit', [
    # `_identity` without its loopback check: routes answer without a token
    ("        if not credential:\n            raise HTTPException(status_code=401)", "        if False:\n            raise HTTPException(status_code=401)"),
    # SafeRoute no longer checks the session before the request is read: FastAPI's validation answers first (400), the G1.1 gap
    ("                _identity(request)\n                # Runs before Hermes's", "                # Runs before Hermes's"),
], ids=['identity_unchecked', 'saferoute_reads_first'])
def test_g1_1_each_mutation_is_caught(edit):
    """Only reads are called, so nothing changes."""
    variant = plugin_variant(edit)
    assert [s for s in loopback_sweep(variant, methods={'GET'}) if s[2] != 401]


def test_plugin_opens_no_listening_socket_or_port(human_browser):
    before = json.loads((STATE / 'ports-before.json').read_text())
    after = json.loads((STATE / 'ports-after.json').read_text())
    assert before == after, f'Listener change at plugin load: before={before}, after={after}'
    for method, path in routes():
        human_browser.request.fetch(DASHBOARD + path, method=method)
    assert listeners() == before, 'A route opened a listening socket'
    # Grep of product backend only. Importing socket for exception types is not a listener.
    forbidden = re.compile(r'\.(?:bind|listen|serve_forever)\s*\(|\b(?:uvicorn\.run|HTTPServer|ThreadingHTTPServer|TCPServer|start_server|create_server)\s*\(')
    files = [ROOT / 'dashboard/plugin_api.py', *(ROOT / 'backend').glob('*.py')]
    for file in files:
        assert not forbidden.search(file.read_text()), 'Server/listener code found: ' + file.name
    print('Product grep: no server/bind/listen. Container TCP listeners before=after=' + json.dumps(before))


def test_session_identity_and_csrf_are_bound_to_real_login(human_browser):
    first = human_browser.request.get(DASHBOARD + PREFIX + '/session')
    second = human_browser.request.get(DASHBOARD + PREFIX + '/session')
    assert first.status == second.status == 200
    session = first.json()
    assert session['actor'] == 'basic:' + credentials()['username']
    assert session['auth_mode'] == 'gated'
    assert re.fullmatch(r'[0-9a-f]{64}', session['csrf'])
    assert session['csrf'] == second.json()['csrf']
    assert first.headers['x-luvebot-api'] == '0'
    assert first.headers['cache-control'] == 'no-store'
    for cookie in human_browser.cookies():
        if cookie['name'] in {'hermes_session_at', 'hermes_session_rt'}:
            assert cookie['value'] not in first.text()
    # Another REAL signed session (next issued-at second), not a fabricated principal.
    time.sleep(1.1)
    login = human_browser.request.post(DASHBOARD + '/auth/password-login', data={
        'provider': 'basic', 'username': credentials()['username'], 'password': credentials()['password'], 'next': '/'})
    assert login.status == 200
    renewed = human_browser.request.get(DASHBOARD + PREFIX + '/session').json()
    assert renewed['csrf'] != session['csrf']
    no_secret(first.body(), 'session handshake')


def test_health_uses_real_status_and_capabilities_per_profile(human_browser):
    response = human_browser.request.get(DASHBOARD + PREFIX + '/health')
    assert response.status == 200 and response.headers['x-luvebot-api'] == '0'
    health = response.json()
    status = human_browser.request.get(DASHBOARD + '/api/status').json()
    assert health['hermes']['release_date'] == status['release_date']
    assert health['hermes']['version'] == status['version']
    assert health['hermes']['baseline_ok'] is True
    assert health['auth']['required'] is True and health['ok'] is True
    assert health['plugin']['db'] == {'ok': True, 'schema_version': 1}
    for profile, key_name, wrong in (('default', 'api_key', 'vendas_api_key'), ('vendas', 'vendas_api_key', 'api_key')):
        code, raw = http(API + f'/p/{profile}/v1/capabilities', credentials()[key_name])
        assert code == 200
        actual = json.loads(raw)
        assert actual['features']['run_submission'] is True
        assert actual['features']['session_chat_streaming'] is True
        scoped = human_browser.request.get(DASHBOARD + PREFIX + '/health?profile=' + profile).json()
        assert scoped['ok'] is True and scoped['features']['runs'] == 'ok' and scoped['features']['session_chat_stream'] == 'ok'
        assert http(API + f'/p/{profile}/v1/capabilities', credentials()[wrong])[0] == 401
    assert health['features']['approval_transport'] == 'not_used'                        # T10.3; groups and approvals: test_health.py
    no_secret(response.body(), 'health')
    print('Real health: version=' + health['hermes']['version'] + ', release=' + status['release_date'] + ', default/vendas capabilities OK')


def test_missing_capability_and_old_baseline_disable_features():
    # Mutate a REAL captured contract as input to the pure detector; no mocked Hermes server.
    code, raw = http(API + '/p/default/v1/capabilities', credentials()['api_key'])
    assert code == 200
    captured = json.loads(raw)
    client = sys_client()
    assert client.feature_states(captured, True)['runs'] == 'ok'
    missing = copy.deepcopy(captured)
    missing['features'].pop('run_submission')
    assert client.feature_states(missing, True)['runs'] == 'unavailable'
    missing = copy.deepcopy(captured)
    missing['endpoints'].pop('session_chat_stream')
    assert client.feature_states(missing, True)['session_chat_stream'] == 'unavailable'
    assert set(client.feature_states(captured, False).values()) == {'unavailable'}
    for release in ('2026.9.23', '2026.99.99', 'unexpected'):
        assert plugin()._version({'version': '0.0.0', 'release_date': release})['baseline_ok'] is False


def test_real_api_server_timeout_degrades_health_without_leak(human_browser):
    pid = int((STATE / 'gateway-pid.txt').read_text())
    os.kill(pid, signal.SIGSTOP)
    try:
        response = human_browser.request.get(DASHBOARD + PREFIX + '/health?profile=vendas', timeout=20000)
        assert response.status == 200
        health = response.json()
        assert health['ok'] is False
        assert health['features']['runs'] == 'unavailable'
        assert any(problem['code'] == 'hermes_timeout' and problem['message'] for problem in health['problems'])
        no_secret(response.body(), 'REAL API timeout response')
    finally:
        os.kill(pid, signal.SIGCONT)
    print('REAL API Server suspended/resumed: health HTTP 200, disabled features and safe timeout message')


def test_unusable_audit_database_degrades_health(human_browser):
    # Real container-local LuveBot state; the AuditLog and HTTP route are not mocked.
    database = Path('/root/.hermes/luvebot/luvebot.db')
    backup = database.with_suffix('.t11-backup')
    assert database.is_file() and not backup.exists()
    # The budget watcher writes to this database every few seconds; renaming a database under an open writer is how SQLite files
    # get corrupted (the journal is found by name). The maintenance file stops the watcher before the file is moved.
    hold = database.parent / 'watcher.hold'
    hold.write_text('')
    time.sleep(8)
    database.rename(backup)
    database.mkdir()
    try:
        response = human_browser.request.get(DASHBOARD + PREFIX + '/health')
        assert response.status == 200
        health = response.json()
        assert health['ok'] is False and health['plugin']['db']['ok'] is False
        assert any(problem['code'] == 'audit_unavailable' and problem['message'] for problem in health['problems'])
        no_secret(response.body(), 'unusable database health')
    finally:
        database.rmdir()
        backup.rename(database)
        hold.unlink(missing_ok=True)
    assert human_browser.request.get(DASHBOARD + PREFIX + '/health').json()['plugin']['db']['ok'] is True
    print('REAL unusable audit path: health HTTP 200, db.ok=false; original database restored')


def test_installer_is_idempotent_inside_container(tmp_path):
    env = {**os.environ, 'HERMES_HOME': str(tmp_path / 'hermes-install'), 'HERMES_PYTHON': sys_executable()}
    command = ['sh', str(ROOT / 'scripts/install.sh')]
    for _ in range(2):
        result = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
        no_secret(result.stdout, 'installer output')
        assert result.returncode == 0, result.stdout.decode()
    target = Path(env['HERMES_HOME'])
    for directory in ('dashboard', 'backend'):
        for source in (ROOT / directory).glob('*.py'):
            assert (target / 'plugins/luvebot' / directory / source.name).read_bytes() == source.read_bytes()
    assert (target / 'dashboard-themes/luve.yaml').read_bytes() == (ROOT / 'theme/luve.yaml').read_bytes()
    import hermes_yaml
    config = hermes_yaml.safe_load((target / 'config.yaml').read_text())
    assert config['plugins']['enabled'].count('luvebot') == 1
    assert 'luvebot' not in config['plugins'].get('disabled', [])
    print('Installer ran twice in an isolated container home: identical files/theme; luvebot enabled once')


def sys_executable():
    import sys
    return sys.executable


def test_no_secret_in_responses_errors_or_logs(human_browser):
    for method, path in routes():
        response = human_browser.request.fetch(DASHBOARD + path, method=method)
        no_secret(response.body(), 'authenticated plugin response')
        no_secret(json.dumps(response.headers), 'response headers')
    for profile in ('default', 'vendas'):
        response = human_browser.request.get(DASHBOARD + PREFIX + '/health?profile=' + profile)
        assert response.status == 200
        health = response.json()
        assert health['ok'] is True and health['features']['runs'] == 'ok'
        no_secret(response.body(), 'profile health')
    for name in ('../escape', 'ｖendas', ' vendas', 'vendas\n', 'a' * 65, 'missing-bot'):
        response = human_browser.request.get(DASHBOARD + PREFIX + '/health?profile=' + quote(name, safe=''))
        assert response.status == 404
        assert response.json()['error']['code'] == 'bot_not_found'
        no_secret(response.body(), 'validation error')
    for file in (STATE / 'logs').glob('*.log'):
        no_secret(file.read_bytes(), 'Hermes/plugin log: ' + file.name)
    print('Canaries absent: all discovered responses, profile health, validation errors and real process logs')

