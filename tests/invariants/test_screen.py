"""D-007 routes in the MAIN harness, whose image has no Xvnc/Xfce: what must hold on a server without the screen stack. The real
screen (watch, take, return, the agent acting) is in tests/harness/display/."""
import json
from pathlib import Path
import shutil

import pytest

from support import DASHBOARD, plugin
from test_bots import audit_rows, csrf, error_of
from test_hook import loopback_request, run_async
from test_plugin import PREFIX

BOT = 'vendas'


def _cmdline(proc):
    """(the image has no pgrep) a process's command line, or b'' if it ended meanwhile."""
    try:
        return (proc / 'cmdline').read_bytes()
    except OSError:
        return b''


def call(browser, method, action='', body=None, token='valid'):
    headers = {} if token is None else {'X-LuveBot-CSRF': csrf(browser) if token == 'valid' else token}
    path = DASHBOARD + PREFIX + f'/bots/{BOT}/screen' + (f'/{action}' if action else '')
    return browser.request.get(path) if method == 'GET' else browser.request.post(path, data=body, headers=headers)


def test_the_routes_are_in_the_router_so_the_401_sweep_covers_them():
    paths = {(r.path, m) for r in plugin().router.routes for m in getattr(r, 'methods', ())}
    for action in ('start', 'stop', 'watch', 'take', 'return'):
        assert (f'/bots/{{bot}}/screen/{action}', 'POST') in paths
    assert ('/bots/{bot}/screen', 'GET') in paths


def test_get_is_honest_about_the_missing_stack_and_names_no_viewer(human_browser):
    response = call(human_browser, 'GET')
    assert response.status == 200, response.text()
    screen = response.json()['screen']
    assert shutil.which('Xvnc') is None
    assert screen['supported'] is True and screen['installed'] is False and screen['running'] is False
    assert 'Xvnc' in screen['missing'] and screen['install_command']
    assert screen['lease'] == {'holder': 'agent', 'since': screen['lease']['since'], 'mine': False, 'by_luvebot': False}
    assert 'viewer' not in json.dumps(screen).replace('by_luvebot', '')
    missing = human_browser.request.get(DASHBOARD + PREFIX + '/bots/no-such-bot/screen')
    assert missing.status == 404 and error_of(missing)['code'] == 'bot_not_found'


def test_start_refuses_with_the_reason_runs_nothing_and_is_audited(human_browser):
    before = len(audit_rows('screen.start'))
    response = call(human_browser, 'POST', 'start')
    assert response.status == 409, response.text()
    error = error_of(response)
    assert error['code'] == 'screen_not_installed' and 'Xvnc' in error['details']['missing'] and error['details']['install_command']
    assert [(r[1], r[2]) for r in audit_rows('screen.start')[before:]] == [('ok', 'intent'), ('error', 'result')]
    assert not [p for p in Path('/proc').iterdir() if p.name.isdigit() and b'Xvnc' in _cmdline(p)]   # nothing was started or installed


def test_every_effect_needs_csrf(human_browser):
    for action in ('start', 'stop', 'watch', 'take', 'return'):
        for token in (None, 'wrong'):
            response = call(human_browser, 'POST', action, token=token)
            assert response.status == 403 and error_of(response)['code'] == 'csrf_required', (action, token)


def test_without_a_running_screen_there_is_nothing_to_watch_take_or_give_back(human_browser):
    for action, code in (('watch', 'screen_not_running'), ('take', 'screen_not_running'), ('return', 'screen_not_yours')):
        response = call(human_browser, 'POST', action)
        assert response.status == 409 and error_of(response)['code'] == code, (action, response.text())
    bad = call(human_browser, 'POST', 'take', body={'reason': 'x' * 121})
    assert bad.status == 422 and error_of(bad)['code'] == 'invalid_field'
    assert call(human_browser, 'POST', 'stop', body={'force': True}).status == 400     # no body: stop never takes force from the UI


def test_in_loopback_taking_passes_the_loopback_gate_and_giving_back_is_refused():
    module = plugin()
    take = loopback_request(module, 'POST', PREFIX + f'/bots/{BOT}/screen/take')
    with pytest.raises(module.PluginError) as stopped:
        run_async(module.take_bot_screen(BOT, take))
    # past the loopback gate: what stops it is the screen (not running here; in this test process, which is not the dashboard, the
    # dashboard's own /api/ws is not reachable either), never loopback_not_human
    assert stopped.value.code in ('screen_not_running', 'screen_unavailable') and stopped.value.code != 'loopback_not_human'
    give_back = loopback_request(module, 'POST', PREFIX + f'/bots/{BOT}/screen/return')
    with pytest.raises(module.PluginError) as refused:
        run_async(module.return_bot_screen(BOT, give_back))
    assert refused.value.code == 'loopback_not_human' and refused.value.status == 403   # D-007 decision 1: giving back loosens


def test_the_reason_of_a_take_reaches_the_audit_redacted(human_browser):
    """The intent row of screen.take carries the digest of {"reason": <redacted>}: the redacted reason, never the raw one."""
    from agent.redact import redact_sensitive_text
    import hashlib
    import sqlite3
    from test_bots import DB
    reason = 'login no banco com a chave sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    redacted = redact_sensitive_text(reason, force=True)
    assert redacted != reason
    digest = lambda r: hashlib.sha256(json.dumps({'reason': r}, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    conn = sqlite3.connect(DB)
    before = conn.execute("SELECT COALESCE(MAX(id), 0) FROM audit_log").fetchone()[0]
    conn.close()
    assert call(human_browser, 'POST', 'take', body={'reason': reason}).status == 409                    # no screen here: refused after the intent
    conn = sqlite3.connect(DB)
    rows = conn.execute("SELECT detail, digest FROM audit_log WHERE action='screen.take' AND id>?", (before,)).fetchall()
    conn.close()
    assert rows[0] == ('intent', digest(redacted)) and digest(reason) not in [r[1] for r in rows]
