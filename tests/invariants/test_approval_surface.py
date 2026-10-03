"""D-025: GET/PUT /bots/{bot}/approval-surface against the REAL mounted plugin, dashboard and Hermes (harness)."""
import json
from pathlib import Path
import sqlite3

import pytest

from support import DASHBOARD, plugin
from test_bots import DB, audit_rows, csrf, error_of
from test_hook import loopback_request, run_async, wait_for
from test_plugin import PREFIX

PATH = '/bots/vendas/approval-surface'
ENV = Path('/root/.hermes/profiles/vendas/.env')
FIELDS = {'bot', 'mode', 'approvers', 'platforms', 'allow_all', 'allow_all_reason', 'applied', 'applied_reason', 'hook_version', 'hook_latest_version', 'updated_at',
          'updated_by'}


def put(browser, body, token='valid'):
    headers = {} if token is None else {'X-LuveBot-CSRF': csrf(browser) if token == 'valid' else token}
    return browser.request.put(DASHBOARD + PREFIX + PATH, data=body, headers=headers)


def get(browser, path=PATH):
    return browser.request.get(DASHBOARD + PREFIX + path)


def stored():
    conn = sqlite3.connect(DB)
    try:
        return conn.execute("SELECT mode, approvers_json FROM approval_surface WHERE profile='vendas'").fetchone()
    except sqlite3.OperationalError:
        return None
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def clean_surface():
    yield
    conn = sqlite3.connect(DB)
    try:
        conn.execute("DELETE FROM approval_surface WHERE profile='vendas'")
        conn.commit()
    except sqlite3.OperationalError:
        pass
    finally:
        conn.close()


def test_get_shows_the_default_and_the_contract_fields(human_browser):
    response = get(human_browser)
    assert response.status == 200, response.text()
    view = response.json()['approval_surface']
    assert set(view) == FIELDS
    assert (view['bot'], view['mode'], view['approvers'], view['platforms'], view['allow_all']) == ('vendas', 'luvebot', [], ['telegram'], False)
    assert view['hook_version'] == '0.3.5' and view['applied'] is True
    assert view['hook_latest_version'] == '0.3.5'                     # t161: what this LuveBot ships (read from the hook file)
    missing = get(human_browser, '/bots/no-such-bot/approval-surface')
    assert missing.status == 404 and error_of(missing)['code'] == 'bot_not_found'


def test_put_needs_csrf_and_a_valid_body_and_leaves_nothing_otherwise(human_browser):
    before = len(audit_rows('bot.approval_surface'))
    for token in (None, 'wrong'):
        response = put(human_browser, {'mode': 'channel', 'approvers': ['telegram:42']}, token)
        assert response.status == 403 and error_of(response)['code'] == 'csrf_required'
    for body in ({}, {'mode': 'both'}, {'mode': 'channel'}, {'mode': 'channel', 'approvers': ['discord:1']},
                 {'mode': 'channel', 'approvers': ['telegram:42'], 'extra': True}):
        response = put(human_browser, body)
        assert response.status == 422 and error_of(response)['code'] == 'invalid_field', body
    assert stored() is None and len(audit_rows('bot.approval_surface')) == before


def test_channel_is_set_by_a_person_audited_before_the_effect_and_applied_by_the_live_hook(human_browser):
    before = len(audit_rows('bot.approval_surface'))
    response = put(human_browser, {'mode': 'channel', 'approvers': ['telegram:9', 'telegram:42']})
    assert response.status == 200, response.text()
    view = response.json()['approval_surface']
    assert view['mode'] == 'channel' and view['approvers'] == ['telegram:42', 'telegram:9'] and view['updated_by']
    rows = audit_rows('bot.approval_surface')[before:]
    assert [(r[1], r[2]) for r in rows] == [('ok', 'intent'), ('ok', 'result')] and rows[0][3] == 'vendas'
    assert stored()[0] == 'channel'
    # the live hook reports a new setting within seconds and the PUT waits for it (bounded): the answer is already "applied"
    assert (view['applied'], view['applied_reason']) == (True, 'applied'), view
    assert get(human_browser).json()['approval_surface']['applied_reason'] == 'applied'
    back = put(human_browser, {'mode': 'luvebot'})
    assert back.status == 200 and back.json()['approval_surface']['mode'] == 'luvebot'


def test_channel_is_refused_while_the_gateway_lets_every_sender_in(human_browser):
    original = ENV.read_text()
    before = len(audit_rows('bot.approval_surface'))
    try:
        ENV.write_text(original + 'TELEGRAM_ALLOW_ALL_USERS=true\n')
        response = put(human_browser, {'mode': 'channel', 'approvers': ['telegram:42']})
        assert response.status == 409, response.text()
        error = error_of(response)
        assert error['code'] == 'approval_surface_unsafe' and error['details']['reason'] == 'TELEGRAM_ALLOW_ALL_USERS'
        assert get(human_browser).json()['approval_surface']['mode'] == 'luvebot' and stored() is None
        rows = audit_rows('bot.approval_surface')[before:]
        assert [(r[1], r[2]) for r in rows] == [('ok', 'intent'), ('error', 'result')]                # the refusal is audited too
    finally:
        ENV.write_text(original)


def test_channel_is_refused_while_the_allowlist_holds_the_wildcard(human_browser):
    original = ENV.read_text()
    try:
        ENV.write_text(original + 'TELEGRAM_ALLOWED_USERS=123,*\n')
        response = put(human_browser, {'mode': 'channel', 'approvers': ['telegram:42']})
        assert response.status == 409 and error_of(response)['details']['reason'] == 'TELEGRAM_ALLOWED_USERS', response.text()
        assert stored() is None
    finally:
        ENV.write_text(original)


def test_in_loopback_letting_approvals_reach_a_chat_is_refused_and_narrowing_is_allowed():
    module = plugin()
    loosen = loopback_request(module, 'PUT', PREFIX + PATH, body=json.dumps({'mode': 'channel', 'approvers': ['telegram:42']}).encode())
    with pytest.raises(module.PluginError) as refused:
        run_async(module.put_approval_surface('vendas', loosen))
    assert refused.value.code == 'loopback_not_human' and refused.value.status == 403 and stored() is None
    narrow = loopback_request(module, 'PUT', PREFIX + PATH, body=json.dumps({'mode': 'luvebot'}).encode())
    response = run_async(module.put_approval_surface('vendas', narrow))
    assert response.status_code == 200 and json.loads(response.body)['approval_surface']['mode'] == 'luvebot'


def test_the_routes_are_in_the_router_so_the_401_sweep_covers_them():
    paths = {(route.path, method) for route in plugin().router.routes for method in getattr(route, 'methods', ())}
    assert ('/bots/{bot}/approval-surface', 'GET') in paths and ('/bots/{bot}/approval-surface', 'PUT') in paths
