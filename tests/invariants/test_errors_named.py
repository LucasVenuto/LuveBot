"""VPS 2026-10-02 (only `default`: "Hermes is unavailable" on a turn, hermes_unreachable on PUT approval-surface, health approvals
unknown): SafeRoute turned ANY unexpected exception into 503 hermes_unreachable "Hermes is unavailable." (plugin_api.py, the last
`except Exception`), so a luvebot.db that could not be read for that Bot's rows looked like Hermes being down, and nothing was
logged. Now: a database error of ours is 503 `luvebot_db_unavailable` (says what it is), and every unexpected exception leaves
ONE log line with its class, the method, the route template and our file:line; never the message, the arguments or the values.
Through the real SafeRoute of the real router, on the harness's real Hermes; only the failing call is swapped."""
import json
import logging
import sqlite3

from support import plugin
from test_hook import loopback_request, run_async
from test_plugin import PREFIX

BOT = 'default'


def through_safe_route(module, method, path, body=None):
    """The plugin router in a real FastAPI app (SafeRoute and all), at the dashboard's address, as a loopback dashboard calls it."""
    from fastapi import FastAPI
    from starlette.testclient import TestClient
    app = FastAPI()
    app.state.auth_required = False                                                  # loopback: the session token is the identity
    app.include_router(module.router, prefix=PREFIX)
    token = 'loopback-session-token'
    headers = {'x-hermes-session-token': token, 'x-luvebot-csrf': module._csrf_for(token)}
    with TestClient(app, base_url='http://127.0.0.1:9119') as client:
        response = client.request(method, PREFIX + path, headers=headers, json=body)
    return response.status_code, response.json()['error']


def a_turn(module):
    return through_safe_route(module, 'POST', f'/bots/{BOT}/runs', {'input': 'ok', 'session_id': 'sess_x'})


def lines(caplog, logger):
    return [r.getMessage() for r in caplog.records if r.name == logger]


def test_a_database_error_of_ours_says_so_and_names_its_class_and_route(monkeypatch, caplog):
    module = plugin()
    from luvebot_backend import hook

    def unreadable(*args, **kwargs):
        raise sqlite3.OperationalError('disk I/O error')            # what the VPS logs said since 15:44
    monkeypatch.setattr(hook, 'hook_state', unreadable)
    caplog.set_level(logging.WARNING, logger='luvebot.route')
    status, error = a_turn(module)
    assert (status, error['code']) == (503, 'luvebot_db_unavailable') and 'Hermes is unavailable' not in error['message'], error
    assert 'nothing was changed' not in error['message'] and 'may not have been recorded' in error['message'], error   # never a false claim
    logged = lines(caplog, 'luvebot.route')
    # the class, the method, the route TEMPLATE (with the router's prefix) and where it was raised (here: the stub in this file)
    assert len(logged) == 1 and logged[0].startswith(f'unexpected OperationalError in POST {PREFIX}/bots/{{bot}}/runs '
                                                     '(at tests/invariants/test_errors_named.py:'), logged
    assert 'disk I/O error' not in logged[0] and BOT not in logged[0]                  # never the message, never the values


def test_any_other_unexpected_exception_is_logged_by_class_only(monkeypatch, caplog):
    module = plugin()
    from luvebot_backend import hook

    def broken(*args, **kwargs):
        raise ValueError('sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')
    monkeypatch.setattr(hook, 'hook_state', broken)
    caplog.set_level(logging.WARNING, logger='luvebot.route')
    status, error = a_turn(module)
    assert (status, error['code']) == (503, 'hermes_unreachable')
    logged = lines(caplog, 'luvebot.route')
    assert len(logged) == 1 and logged[0].startswith(f'unexpected ValueError in POST {PREFIX}/bots/{{bot}}/runs (at '), logged
    assert 'sk-proj' not in logged[0] and 'sk-proj' not in json.dumps(error)


def test_health_logs_why_the_hook_state_is_unknown(monkeypatch, caplog):
    module = plugin()
    from luvebot_backend import hook

    def unreadable(*args, **kwargs):
        raise sqlite3.OperationalError('disk I/O error')
    monkeypatch.setattr(hook, 'hook_state', unreadable)
    caplog.set_level(logging.WARNING, logger='luvebot.hook')
    response = run_async(module.health(loopback_request(module, 'GET', '/health?profile=' + BOT), profile=BOT))
    body = response if isinstance(response, dict) else json.loads(response.body)
    assert body['features']['approvals'] == 'unknown'
    assert lines(caplog, 'luvebot.hook') == [f'hook state unreadable for {BOT}: OperationalError']
