"""T2.6: Bot routes (contract section 4) and the CSRF gate, against the REAL mounted plugin and Hermes."""
import json
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
import uuid
from pathlib import Path

import pytest

from support import API, DASHBOARD, STATE, http, plugin
from support import credentials
from test_plugin import PREFIX, no_secret, routes

DB = Path('/root/.hermes/luvebot/luvebot.db')
MODEL = {'provider': 'openrouter', 'name': 'anthropic/claude-sonnet-4'}  # accepted by Hermes's own model route without credentials


def quiet(timeout=40):
    """Wait until the runs LuveBot started have released their budget holds. v0.4 B4: every run holds an estimate, a thread per
    run polls Hermes and commits (an audit row, a freed hold) a few seconds after the run ends: a test that counts audit rows or
    needs the full cap must start after that."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        conn = sqlite3.connect(DB)
        try:
            if conn.execute("SELECT count(*) FROM budget_reservations WHERE status='open'").fetchone()[0] == 0:
                return
        except sqlite3.OperationalError:
            return  # no budget tables yet
        finally:
            conn.close()
        time.sleep(1)


def audit_rows(action=None):
    conn = sqlite3.connect(DB)
    try:
        sql, args = 'SELECT action, outcome, detail, target FROM audit_log', ()
        if action:
            sql, args = sql + ' WHERE action=?', (action,)
        else:  # what the background watcher writes on its own (a heartbeat, a freed hold, a pause step, a handoff it found) is not what
            # these tests count: they count what a REQUEST wrote
            sql = sql + (" WHERE action NOT IN ('budget.heartbeat', 'budget.commit', 'budget.executor.step', 'budget.alert', 'handoff.state',"
                         " 'handoff.completed', 'handoff.cancelled', 'handoff.unrecorded') AND NOT (action = 'handoff.created' AND actor = 'system')")
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def meta_row(name):
    conn = sqlite3.connect(DB)
    try:
        return conn.execute('SELECT label, color, avatar_kind, avatar_value, hidden FROM bot_meta WHERE bot=?', (name,)).fetchone()
    finally:
        conn.close()


def hermes_profiles(browser):
    return {p['name']: p for p in browser.request.get(DASHBOARD + '/api/profiles').json()['profiles']}


def csrf(browser):
    return browser.request.get(DASHBOARD + PREFIX + '/session').json()['csrf']


def post(browser, path, body, token='valid'):
    headers = {} if token is None else {'X-LuveBot-CSRF': csrf(browser) if token == 'valid' else token}
    return browser.request.post(DASHBOARD + PREFIX + path, data=body, headers=headers)


def patch(browser, path, body, token='valid'):
    headers = {} if token is None else {'X-LuveBot-CSRF': csrf(browser) if token == 'valid' else token}
    return browser.request.patch(DASHBOARD + PREFIX + path, data=body, headers=headers)


def error_of(response):
    body = response.json()['error']
    assert set(body) >= {'code', 'message', 'request_id'}
    return body


@pytest.fixture(autouse=True)
def db_exists(human_browser):
    # A fresh container has no LuveBot DB until the plugin first serves a request.
    assert human_browser.request.get(DASHBOARD + PREFIX + '/bots').status == 200


@pytest.fixture
def new_name(human_browser):
    name = 't26-' + uuid.uuid4().hex[:8]
    yield name
    # Cleanup through Hermes's own route; then our display row.
    human_browser.request.delete(DASHBOARD + '/api/profiles/' + name)
    conn = sqlite3.connect(DB)
    conn.execute('DELETE FROM bot_meta WHERE bot=?', (name,))
    conn.commit()
    conn.close()


def test_bot_routes_are_in_the_discovered_router_so_the_401_sweep_covers_them():
    found = set(routes())
    for item in [('GET', '/bots'), ('GET', '/bots/{bot}'), ('PATCH', '/bots/{bot}/display'), ('GET', '/templates'), ('POST', '/bots')]:
        assert (item[0], PREFIX + item[1]) in found, item


def test_mutations_without_or_with_wrong_csrf_are_403_and_leave_nothing(human_browser, new_name):
    before_rows = len(audit_rows())
    before_profiles = set(hermes_profiles(human_browser))
    label_before = human_browser.request.get(DASHBOARD + PREFIX + '/bots').json()['bots'][0]['display']
    for token in (None, 'wrong', '0' * 64, ''):
        for response in (post(human_browser, '/bots', {'name': new_name, 'template': 'sales'}, token),
                         patch(human_browser, '/bots/vendas/display', {'label': 'HACK'}, token)):
            assert response.status == 403, token
            assert error_of(response)['code'] == 'csrf_required'
            no_secret(response.body(), 'csrf error')
    assert len(audit_rows()) == before_rows, 'a refused request must not be audited'
    assert set(hermes_profiles(human_browser)) == before_profiles
    assert human_browser.request.get(DASHBOARD + PREFIX + '/bots').json()['bots'][0]['display'] == label_before
    assert meta_row('vendas') is None or meta_row('vendas')[0] != 'HACK'


def test_templates_are_the_seven_static_ones_without_secrets_or_urls(human_browser):
    response = human_browser.request.get(DASHBOARD + PREFIX + '/templates')
    assert response.status == 200
    templates = response.json()['templates']
    assert [t['id'] for t in templates] == ['chief-of-staff', 'sales', 'support', 'ops-finance', 'dev', 'research', 'content']
    for template in templates:
        assert {'id', 'label', 'role', 'soul', 'toolsets', 'intro_prompt'} <= set(template)
    text = response.text()
    assert 'http://' not in text and 'https://' not in text and '/root/' not in text
    no_secret(response.body(), 'templates')


def test_bots_list_and_detail_are_real_and_expose_no_secret_or_path(human_browser):
    response = human_browser.request.get(DASHBOARD + PREFIX + '/bots')
    assert response.status == 200
    bots = {b['name']: b for b in response.json()['bots']}
    assert {'default', 'vendas'} <= set(bots)
    assert bots['default']['is_default'] is True and bots['vendas']['is_default'] is False
    for bot in bots.values():
        assert set(bot['display']) >= {'label', 'role', 'call_me', 'color', 'avatar', 'hidden'}
        assert bot['status'] in ('idle', 'offline')
        assert bot['capabilities']['approval_response'] is False
    # The two profiles with a real API key probe as capable (real /v1/capabilities).
    assert bots['vendas']['capabilities']['runs'] is True and bots['vendas']['status'] == 'idle'
    detail = human_browser.request.get(DASHBOARD + PREFIX + '/bots/vendas')
    assert detail.status == 200
    body = detail.json()
    assert body['name'] == 'vendas' and isinstance(body['soul'], str)
    assert all(set(t) == {'name', 'enabled'} for t in body['toolsets']) and body['toolsets']
    assert all(set(s) == {'name', 'enabled'} for s in body['mcp_servers'])
    for raw in (response.text(), detail.text()):
        assert '/root/' not in raw and 'API_SERVER' not in raw and '.env' not in raw
        no_secret(raw, 'bots')
    assert human_browser.request.get(DASHBOARD + PREFIX + '/bots/missing-bot').status == 404


def test_post_bots_creates_the_real_profile_and_it_shows_in_get_bots(human_browser, new_name):
    rows_before = len(audit_rows('bot.create'))
    response = post(human_browser, '/bots', {'name': new_name, 'template': 'sales', 'model': MODEL,
                                             'display': {'label': 'Vendas Teste', 'call_me': 'chefe'}})
    assert response.status == 201, response.text()
    created = response.json()
    assert created['bot']['name'] == new_name and created['intro'] == {'session_id': None}
    assert created['bot']['display']['label'] == 'Vendas Teste' and created['bot']['display']['call_me'] == 'chefe'
    assert created['bot']['display']['role'] == 'Prospecção e follow-up B2B'  # from the template
    # Hermes really has it: profile, description, soul and model written through its own routes.
    real = hermes_profiles(human_browser)[new_name]
    sales = next(t for t in human_browser.request.get(DASHBOARD + PREFIX + '/templates').json()['templates'] if t['id'] == 'sales')
    assert real['description'] == sales['description']
    soul = human_browser.request.get(DASHBOARD + f'/api/profiles/{new_name}/soul').json()
    assert soul['exists'] and soul['content'].startswith('# SOUL')
    assert real['model'] == 'anthropic/claude-sonnet-4' and real['provider'] == 'openrouter'
    listed = {b['name']: b for b in human_browser.request.get(DASHBOARD + PREFIX + '/bots').json()['bots']}
    assert new_name in listed and listed[new_name]['display']['label'] == 'Vendas Teste'
    detail = human_browser.request.get(DASHBOARD + PREFIX + f'/bots/{new_name}').json()
    assert detail['soul'] == soul['content']
    # Audited before and after the effect (intent + result).
    # only this Bot's rows: another client creating a Bot at the same moment (the e2e of another agent) must not matter
    rows = [r for r in audit_rows('bot.create')[rows_before:] if r[3] == new_name]
    assert [(r[0], r[1], r[2], r[3]) for r in rows] == [('bot.create', 'ok', 'intent', new_name), ('bot.create', 'ok', 'result', new_name)]
    for raw in (response.text(), json.dumps(detail)):
        assert '/root/' not in raw
        no_secret(raw, 'create')


def test_post_bots_validation_and_conflicts(human_browser, new_name):
    rows = len(audit_rows())
    for body in ({'name': 'Vendas2'}, {'name': '../x'}, {'name': 'a' * 65}, {'name': ''}, {'name': 5}):
        r = post(human_browser, '/bots', body)
        assert r.status == 422 and error_of(r)['code'] == 'invalid_name', body
    for existing in ('vendas', 'default'):
        r = post(human_browser, '/bots', {'name': existing})
        assert r.status == 409 and error_of(r)['code'] == 'bot_exists'
    for body in ({'name': new_name, 'template': 'nope'}, {'name': new_name, 'display': {'color': 'red'}},
                 {'name': new_name, 'display': {'evil': 1}}, {'name': new_name, 'model': {'provider': 'x'}}):
        r = post(human_browser, '/bots', body)
        assert r.status == 422 and error_of(r)['code'] == 'invalid_field', body
    assert post(human_browser, '/bots', {'name': new_name, 'surprise': 1}).status == 400
    assert new_name not in hermes_profiles(human_browser)
    assert len(audit_rows()) == rows, 'validation failures have no effect and are not audited as actions'


def test_failure_at_a_step_rolls_back_and_names_the_step(human_browser, new_name):
    rows_before = len(audit_rows('bot.create'))
    response = post(human_browser, '/bots', {'name': new_name, 'template': 'dev',
                                             'model': {'provider': 'no-such-provider', 'name': 'x'}})
    assert response.status in (422, 502)
    error = error_of(response)
    assert error['step'] == 'model' and error['rolled_back'] is True
    assert error['message'] and '/root/' not in response.text()
    assert new_name not in hermes_profiles(human_browser), 'the profile created in step 1 must be gone'
    assert new_name not in {b['name'] for b in human_browser.request.get(DASHBOARD + PREFIX + '/bots').json()['bots']}
    assert meta_row(new_name) is None
    rows = [r for r in audit_rows('bot.create')[rows_before:] if r[3] == new_name]
    assert [(r[1], r[2]) for r in rows] == [('ok', 'intent'), ('error', 'result')]
    no_secret(response.body(), 'rollback error')


def test_display_persists_in_the_luvebot_db_and_is_audited(human_browser, new_name):
    assert post(human_browser, '/bots', {'name': new_name, 'template': 'support'}).status == 201
    rows_before = len(audit_rows('bot.display.update'))
    r = patch(human_browser, f'/bots/{new_name}/display', {'label': 'Suporte N1', 'color': '#34D399',
                                                           'avatar': {'kind': 'emoji', 'value': '🎧'}, 'hidden': True})
    assert r.status == 200, r.text()
    assert r.json()['display'] == {'label': 'Suporte N1', 'role': r.json()['display']['role'], 'call_me': None,
                                   'color': '#34D399', 'avatar': {'kind': 'emoji', 'value': '🎧'}, 'hidden': True}
    assert meta_row(new_name) == ('Suporte N1', '#34D399', 'emoji', '🎧', 1)
    again = {b['name']: b for b in human_browser.request.get(DASHBOARD + PREFIX + '/bots').json()['bots']}[new_name]
    assert again['display']['label'] == 'Suporte N1' and again['display']['hidden'] is True  # hidden Bots stay in the list
    rows = audit_rows('bot.display.update')[rows_before:]
    assert [(x[1], x[2]) for x in rows] == [('ok', 'intent'), ('ok', 'result')]
    # Partial update keeps the rest; Hermes is untouched.
    r = patch(human_browser, f'/bots/{new_name}/display', {'call_me': 'time'})
    assert r.json()['display']['label'] == 'Suporte N1' and r.json()['display']['call_me'] == 'time'
    for bad in ({'color': 'blue'}, {'avatar': {'kind': 'image', 'value': '/etc/passwd'}}, {'hidden': 'yes'}, {'label': ''}, {'x': 1}):
        r = patch(human_browser, f'/bots/{new_name}/display', bad)
        assert r.status == 422, bad
    assert patch(human_browser, '/bots/nope-bot/display', {'label': 'x'}).status == 404


def new_bot_key(name):
    """The generated key, read from the new profile's own .env (the test is the only reader besides Hermes)."""
    for line in Path(f'/root/.hermes/profiles/{name}/.env').read_text().splitlines():
        if line.startswith('API_SERVER_KEY='):
            return line.split('=', 1)[1].strip()
    pytest.fail('API_SERVER_KEY was not written to the new profile')


def no_key(key, content, channel):
    if isinstance(content, str):
        content = content.encode()
    if key.encode() in content:
        pytest.fail('Generated API_SERVER_KEY found in ' + channel + ' (value withheld)', pytrace=False)


def test_new_bot_key_is_written_served_by_the_gateway_and_never_leaks(human_browser, new_name):
    """Key sweeper for the key step: the new key reaches Hermes' .env and nothing else."""
    created = post(human_browser, '/bots', {'name': new_name, 'template': 'dev', 'model': MODEL})
    assert created.status == 201, created.text()
    key = new_bot_key(new_name)
    assert len(key) >= 32 and key not in (credentials()['api_key'], credentials()['vendas_api_key'])
    # The running gateway serves the new profile with the new key and no restart (multiplexed /p/<profile>/).
    code, _ = http(API + f'/p/{new_name}/v1/capabilities', key)
    assert code == 200
    assert http(API + f'/p/{new_name}/v1/capabilities', credentials()['vendas_api_key'])[0] == 401
    health = human_browser.request.get(DASHBOARD + PREFIX + f'/health?profile={new_name}').json()
    assert health['ok'] is True and health['features']['runs'] == 'ok' and health['features']['session_chat_stream'] == 'ok'
    bot = created.json()['bot']
    assert bot['status'] == 'idle' and bot['capabilities']['runs'] is True and bot['capabilities']['session_chat_stream'] is True
    # Sweep every channel for the key.
    no_key(key, created.body(), 'POST /bots response')
    for path in ('/bots', f'/bots/{new_name}', f'/health?profile={new_name}', '/session'):
        response = human_browser.request.get(DASHBOARD + PREFIX + path)
        no_key(key, response.body(), 'GET ' + path)
        no_key(key, json.dumps(response.headers), 'headers of GET ' + path)
    no_key(key, patch(human_browser, f'/bots/{new_name}/display', {'label': 'X'}).body(), 'PATCH display')
    no_key(key, DB.read_bytes(), 'LuveBot database (audit and bot_meta)')
    for directory in (STATE / 'logs', Path('/root/.hermes/logs')):
        for file in directory.glob('*.log') if directory.is_dir() else ():
            no_key(key, file.read_bytes(), 'log ' + file.name)


def test_failure_at_the_key_step_removes_the_profile_and_hides_the_key(monkeypatch, new_name):
    """Real Hermes writes and rollback; only the key step is made to fail (its error text carries the key)."""
    plugin()  # loads luvebot_backend exactly as the dashboard does
    import luvebot_backend.bot_meta as bot_meta
    import luvebot_backend.bots as bots
    from hermes_cli.profiles import profile_exists
    from hermes_cli.web_routers import config_env
    seen = []

    async def failing(body, profile=None):
        seen.append(body.value)
        raise RuntimeError('credential store refused ' + body.value)

    monkeypatch.setattr(config_env, 'set_env_var', failing)
    meta = bot_meta.BotMeta(DB)
    # Production runs this inside AuditLog.act in a worker thread; the playwright fixture keeps a loop on this one.
    with pytest.raises(bots.PluginError) as caught, ThreadPoolExecutor(1) as pool:
        pool.submit(bots.create_in_hermes, new_name, None, bot_meta.default_display(new_name), None, meta).result()
    error = caught.value
    assert len(seen) == 1 and len(seen[0]) >= 32
    assert error.extra == {'step': 'api_key', 'rolled_back': True} and error.status == 502
    assert seen[0] not in error.message and seen[0] not in json.dumps(error.extra) and error.__cause__ is None
    assert not profile_exists(new_name), 'the profile created before the key step must be removed'
    assert meta_row(new_name) is None
