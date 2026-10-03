"""T3.5: real authenticated HTTP attacks; no mocked host guard or template handler.

Hermes pin f8489405:
https://github.com/NousResearch/hermes-agent/blob/f8489405/hermes_cli/web_server.py#L597
https://github.com/NousResearch/hermes-agent/blob/f8489405/hermes_cli/web_server.py#L625
HTTP Origin uses CORS (#L437), unlike the WS Host/Origin guard in web_server_chat.py#L167.
A wildcard bind accepts foreign Host (#L614): RT12 must report that failure, not hide it
by changing the harness to loopback. The invalid-authority control isolates the existing
native guard and gives the RT12 overlay a genuinely green baseline to break.
"""
import http.client
import json
from pathlib import Path
import re
from uuid import uuid4

import pytest
from fastapi.routing import APIRoute

from support import DASHBOARD, credentials, plugin, plugin_variant

PREFIX = '/api/plugins/luvebot'
LOCAL_HOST = '127.0.0.1:9119'
LOCAL_ORIGIN = DASHBOARD
FOREIGN_HOST = 'rebinding.invalid:9119'
FOREIGN_ORIGIN = 'http://rebinding.invalid:9119'
GUARD_DETAIL = ('Invalid Host header. Dashboard requests must use the '
                'bound hostname or the configured public hostname.')


def fail(message):
    # A failed secret mutation must never leak the inspected value via assertion introspection.
    pytest.fail(message, pytrace=False)


def discovered():
    found = sorted((method, route.path) for route in plugin().router.routes
                   if isinstance(route, APIRoute) for method in route.methods)
    if not found:
        fail('The real plugin router has no routes')
    return found


def wire(method, path, headers, body=None):
    """Connect only to real loopback; send Host literally, with no redirect or DNS lookup."""
    connection = http.client.HTTPConnection('127.0.0.1', 9119, timeout=15)
    try:
        connection.request(method, PREFIX + path, body=body, headers=headers)
        response = connection.getresponse()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read(1024 * 1024)
    finally:
        connection.close()


def authenticated_headers(browser):
    # Explicit cookies keep the verified session on requests with an attacker Host. An automatic
    # cookie jar could omit them and incorrectly pass a test by returning 401 instead of the guard.
    cookies = browser.cookies(DASHBOARD)
    header = '; '.join(c['name'] + '=' + c['value'] for c in cookies)
    if not header:
        fail('Real password login yielded no session cookies')
    headers = {'Host': LOCAL_HOST, 'Origin': LOCAL_ORIGIN, 'Cookie': header}
    status, _, body = wire('GET', '/session', headers)
    if status != 200:
        fail('Signed-session control failed: HTTP ' + str(status))
    session = json.loads(body)
    if session.get('auth_mode') != 'gated' or session.get('actor') != 'basic:' + credentials()['username']:
        fail('Control request did not reach the plugin as the actual logged-in principal')
    headers['X-LuveBot-CSRF'] = session['csrf']
    return headers


def guard_blocked(status, headers, body, host_case):
    # Either refusal counts, and nothing else: the dashboard's own guard, or the plugin router's (403 host_not_allowed /
    # origin_not_allowed, added because the wildcard bind makes Hermes accept any Host). Not CSRF/validation/404 errors.
    try:
        ours = json.loads(body).get('error', {}).get('code')
    except (ValueError, AttributeError):
        ours = None
    if status == 403 and ours == ('host_not_allowed' if host_case else 'origin_not_allowed'):
        return True
    if 'x-luvebot-api' in headers:
        return False
    if host_case:
        try:
            return status == 400 and json.loads(body).get('detail') == GUARD_DETAIL
        except (ValueError, AttributeError):
            return False
    return status in (400, 403) and b'origin' in body.lower()


@pytest.mark.parametrize('vector', ['host', 'origin', 'host_and_origin', 'null_origin'])
def test_rt12_foreign_host_origin_blocked_by_dashboard_guard(human_browser, vector):
    headers = authenticated_headers(human_browser)
    host_case = vector != 'origin'
    if host_case:
        headers['Host'] = FOREIGN_HOST
    if vector != 'host':
        headers['Origin'] = 'null' if vector == 'null_origin' else FOREIGN_ORIGIN   # G12.1: an opaque origin too
    results, failures = [], []
    for method, path in discovered():
        # Missing opaque ids + invalid JSON prevent effects if the guard is broken. Use every
        # real method; a missing CSRF proof must not stand in for a rebinding rejection.
        path = re.sub(r'\{[^}]+\}', 'rt12-nonexistent', path)
        body = b'{' if method not in ('GET', 'HEAD', 'OPTIONS') else None
        status, response_headers, response_body = wire(method, path, headers, body)
        blocked = guard_blocked(status, response_headers, response_body, host_case)
        results.append({'method': method, 'path': path, 'status': status, 'native_guard': blocked})
        if not blocked:
            failures.append(method + ' ' + path + ' -> HTTP ' + str(status))
    print('RT12 authenticated wire probe: ' + json.dumps({'vector': vector, 'routes': results}))
    if failures:
        fail('RT12: dashboard guard did not block ' + vector + ': ' + '; '.join(failures))



PUBLIC = 'luve.example.com'


def public_status(module, monkeypatch, host, origin=None):
    """G12.1: the plugin router in a real FastAPI app whose trusted public hosts come from Hermes's OWN reading of
    dashboard.public_url (`_dashboard_public_hosts`, web_server.py#L501, set on app.state at startup #L1150), called with `host`.
    -> (status, error code or None)."""
    from fastapi import FastAPI
    from starlette.testclient import TestClient
    from hermes_cli.web_server import _dashboard_public_hosts
    monkeypatch.setenv('HERMES_DASHBOARD_PUBLIC_URL', 'https://' + PUBLIC)
    app = FastAPI()
    app.state.auth_required = False
    app.state.trusted_public_hosts = _dashboard_public_hosts()
    assert app.state.trusted_public_hosts == frozenset({PUBLIC})
    app.include_router(module.router, prefix=PREFIX)
    token = 'loopback-session-token'
    headers = {'x-hermes-session-token': token, **({'Origin': origin} if origin is not None else {})}
    with TestClient(app, base_url='https://' + host) as client:
        response = client.get(PREFIX + '/session', headers=headers)
    return response.status_code, None if response.status_code == 200 else response.json()['error']['code']


def public_url_checks(module, monkeypatch):
    assert public_status(module, monkeypatch, PUBLIC) == (200, None)                         # the declared public host passes
    assert public_status(module, monkeypatch, PUBLIC, 'https://' + PUBLIC) == (200, None)
    assert public_status(module, monkeypatch, 'evil.example.com') == (403, 'host_not_allowed')  # any other Host does not
    assert public_status(module, monkeypatch, PUBLIC, 'https://evil.example.com') == (403, 'origin_not_allowed')
    assert public_status(module, monkeypatch, PUBLIC, 'null') == (403, 'origin_not_allowed')    # an opaque origin is not "no origin"


def test_g12_1_with_a_public_url_that_host_passes_and_any_other_is_refused(monkeypatch):
    public_url_checks(plugin(), monkeypatch)


@pytest.mark.parametrize('edit', [
    ("    allowed = _LOOPBACK_HOSTS | {h.lower() for h in trusted}", "    allowed = set(_LOOPBACK_HOSTS)"),
    ("    if origin is not None and _authority_host(origin) not in allowed:",
     "    if origin is not None and origin != 'null' and _authority_host(origin) not in allowed:"),
    ("    if _authority_host(request.headers.get('host')) not in allowed:", "    if not trusted and _authority_host(request.headers.get('host')) not in allowed:"),
], ids=['public_host_ignored', 'null_origin_passes', 'any_host_once_public'])
def test_g12_1_each_mutation_is_caught(monkeypatch, edit):
    variant = plugin_variant(edit)                                                              # outside pytest.raises: it must apply
    with pytest.raises(AssertionError):
        public_url_checks(variant, monkeypatch)


def test_rt12_native_guard_rejects_invalid_authority(human_browser):
    """Positive native-guard control; removing that guard must turn this test red."""
    headers = authenticated_headers(human_browser)
    headers['Host'] = 'rebinding.invalid:badport'
    failures = []
    for method, path in discovered():
        path = re.sub(r'\{[^}]+\}', 'rt12-nonexistent', path)
        status, returned, body = wire(method, path, headers, b'{' if method not in ('GET', 'HEAD') else None)
        if not guard_blocked(status, returned, body, True):
            failures.append(method + ' ' + path + ' -> HTTP ' + str(status))
    if failures:
        fail('RT12 native guard bypass: ' + '; '.join(failures))
    print('RT12 invalid authority: all discovered methods refused by native HTTP 400 Host guard')


@pytest.fixture
def template_canaries(human_browser):
    """Plant in real profile .env through native PUT /api/env; delete through native DELETE.

    Test-only local read proves persistence without depending on a masked HTTP preview. Existing
    per-profile API keys stay active; we never rotate them or edit any production source file.
    """
    creds = credentials()
    values = [creds[k] for k in ('api_key', 'vendas_api_key', 'extra_canary', 'password', 'signing_key')]
    homes = {'default': Path('/root/.hermes'), 'vendas': Path('/root/.hermes/profiles/vendas')}
    nonce = uuid4().hex
    planted = []
    try:
        for profile, home in homes.items():
            text = (home / '.env').read_text()
            key = creds['api_key' if profile == 'default' else 'vendas_api_key']
            if 'API_SERVER_KEY=' + key not in text:
                fail('Harness API_SERVER_KEY canary not planted for ' + profile)
            canaries = {
                'LUVEBOT_RT13_SECRET_' + nonce.upper(): 'sk-rt13-' + uuid4().hex,
                'LUVEBOT_RT13_URL_' + nonce.upper(): 'http://10.88.0.42:8642/private/' + profile + '/' + nonce,
                'LUVEBOT_RT13_PATH_' + nonce.upper(): '/tmp/hermes-private/' + profile + '/' + nonce + '/auth.json',
            }
            for name, value in canaries.items():
                # Unique names cannot overwrite operator/harness state.
                if name + '=' in text:
                    fail('Canary name already exists; refusing overwrite')
                response = human_browser.request.put(DASHBOARD + '/api/env', data={
                    'profile': profile, 'key': name, 'value': value})
                if response.status != 200:
                    fail('Native canary planting failed: HTTP ' + str(response.status))
                planted.append((profile, name))
                if value not in (home / '.env').read_text():
                    fail('Native canary planting did not persist in the actual profile')
                values.append(value)
        print('RT13: distinct API keys + six secret/URL/path canaries verified in two real profiles (values withheld)')
        yield values
    finally:
        errors = []
        for profile, name in reversed(planted):
            response = human_browser.request.delete(DASHBOARD + '/api/env', data={'profile': profile, 'key': name})
            if response.status != 200 or name + '=' in (homes[profile] / '.env').read_text():
                errors.append(profile)
        if errors:
            fail('Native canary cleanup failed for: ' + ', '.join(errors))


URL = re.compile(r'(?:https?|wss?|file|ssh|ftp)://|(?<!:)//(?:localhost|\d{1,3}\.)', re.I)
PATH = re.compile(r'''(?:^|[\s"'=:(])(?:/[^\s/]|~[/\\]|[a-z]:[/\\]|\\\\|\.\.?[/\\])''', re.I)
SENSITIVE_FIELD = re.compile(r'key|secret|token|password|credential|authorization|headers|base_url|endpoint|path|env', re.I)


def clean_export(response, canaries, label):
    if response.status != 200:
        fail('RT13 export failed: ' + label + ' HTTP ' + str(response.status))
    # Inspect body AND headers, raw and decoded; escaping must not evade a canary check.
    raw = response.body().decode('utf-8')
    data = response.json()
    inspected = raw + json.dumps(data, ensure_ascii=False) + json.dumps(response.headers)
    for value in canaries:
        if value in inspected:
            fail('RT13 planted canary leaked in ' + label + ' (value withheld)')

    def walk(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if SENSITIVE_FIELD.search(key):
                    fail('RT13 credential/internal field in ' + label + ' (value withheld)')
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)
        elif isinstance(value, str) and (URL.search(value) or PATH.search(value)):
            fail('RT13 URL or filesystem path in ' + label + ' (value withheld)')
    walk(data)
    # Response headers also must not attach internal locations or secret values. Slash MIME
    # syntax isn't a path; inspect only location/download filename-bearing headers for paths.
    for key in ('location', 'content-location', 'content-disposition'):
        value = response.headers.get(key, '')
        if URL.search(value) or PATH.search(value):
            fail('RT13 internal location/path in export header (value withheld)')
    return data


def test_rt13_template_exports_contain_no_secret_url_or_path(human_browser, template_canaries):
    required = {'id', 'label', 'role', 'soul', 'toolsets', 'intro_prompt'}
    allowed = required | {'model_hint', 'description', 'color', 'avatar'}
    responses = 0
    # v0 section 4 exposes GET /templates only. Discover any additional GET template or Bot
    # export route if added; /audit/export is audit data, and native /api/profiles/*/export is
    # explicitly outside the plugin contract's browser allowlist (v0 section 2.1).
    exports = [(method, path) for method, path in discovered() if method == 'GET' and
               ('template' in path or (path.startswith('/bots/') and 'export' in path))]
    if ('GET', '/templates') not in exports:
        fail('Contract GET /templates is absent from the real router')
    for profile in ('default', 'vendas'):
        response = human_browser.request.get(DASHBOARD + PREFIX + '/templates', params={'profile': profile})
        data = clean_export(response, template_canaries, 'GET /templates profile=' + profile)
        catalog = data.get('templates')
        if not isinstance(catalog, list) or not catalog:
            fail('RT13 catalog is empty or malformed; absence of data is not a clean export')
        for item in catalog:
            if not isinstance(item, dict) or not required <= item.keys() <= allowed:
                fail('RT13 template violates the frozen export shape')
            if not isinstance(item['soul'], str) or not item['soul'] or not isinstance(item['toolsets'], list):
                fail('RT13 missing actual template content')
        responses += 1
        for method, path in exports:
            if path == '/templates':
                continue
            for item in catalog:
                target = re.sub(r'\{(?:template|template_id|id)\}', item['id'], path)
                target = target.replace('{bot}', profile)
                if '{' in target:
                    fail('New export route needs explicit contract path-parameter coverage')
                exported = human_browser.request.get(DASHBOARD + PREFIX + target, params={'profile': profile})
                clean_export(exported, template_canaries, method + ' ' + target)
                responses += 1
    print('RT13: ' + str(responses) + ' real authenticated export responses clean; routes=' +
          json.dumps(exports) + '; six planted canaries removed through native API at teardown')
