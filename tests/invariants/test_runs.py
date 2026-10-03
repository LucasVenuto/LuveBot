"""T2.8: sessions and runs (contract section 5, no SSE) against the REAL plugin, Hermes API Server and fake provider."""
import os
import signal
import sqlite3
import time
import uuid

import pytest

from support import DASHBOARD, STATE, plugin
from test_bots import quiet, DB, audit_rows, csrf, error_of, new_name, post  # noqa: F401  (new_name is a fixture)
from test_plugin import PREFIX, no_secret

NORMAL = 'T08_TOOL_NORMAL: use the local terminal tool.'
APPROVAL = 'T08_TOOL_APPROVAL: request the dangerous tool.'
TERMINAL = {'completed', 'failed', 'cancelled'}


def get(browser, path):
    return browser.request.get(DASHBOARD + PREFIX + path)


def run_count():
    conn = sqlite3.connect(DB)
    try:
        return conn.execute('SELECT count(*) FROM run_index').fetchone()[0]
    finally:
        conn.close()


def wait_run(browser, bot, run_id, want, timeout=45):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        response = get(browser, f'/bots/{bot}/runs/{run_id}')
        assert response.status == 200, response.text()
        last = response.json()['run']
        if last['status'] in want or last.get('status_raw') in want:
            return last
        time.sleep(0.5)
    pytest.fail(f'run did not reach {want}; last={last}')


def bot_status(browser, name):
    return {b['name']: b for b in get(browser, '/bots').json()['bots']}[name]


def new_run(browser, text, **extra):
    session = post(browser, '/bots/vendas/sessions', {})
    assert session.status == 201, session.text()
    sid = session.json()['session']['id']
    response = post(browser, '/bots/vendas/runs', {'input': text, 'session_id': sid, **extra})
    assert response.status == 202, response.text()
    return sid, response.json()['run']


@pytest.fixture(autouse=True)
def db_ready_and_clean_budget(human_browser):
    assert get(human_browser, '/bots').status == 200
    yield
    conn = sqlite3.connect(DB)
    for table in ('budget_limits', 'budget_pauses', 'budget_reservations', 'budget_alerts', 'budget_watcher', 'budget_spend'):
        try:
            conn.execute(f'DELETE FROM {table}')  # test cleanup of the Budget's own tables
        except sqlite3.OperationalError:
            pass  # created on the first budgeted run
    conn.commit()
    conn.close()


def real_budget():
    plugin()  # loads luvebot_backend as the dashboard does
    from luvebot_backend.audit import AuditLog
    from luvebot_backend.budget import Budget
    return Budget(DB, audit=AuditLog(DB))


def test_run_routes_are_in_the_router_so_the_401_sweep_covers_them():
    from test_plugin import routes
    found = set(routes())
    for method, path in (('POST', '/bots/{bot}/sessions'), ('POST', '/bots/{bot}/runs'), ('GET', '/bots/{bot}/runs/{run_id}'),
                         ('POST', '/bots/{bot}/runs/{run_id}/stop')):
        assert (method, PREFIX + path) in found


def test_mutations_without_csrf_are_403_and_leave_nothing(human_browser):
    quiet()
    rows, runs = len(audit_rows()), run_count()
    for path, body in (('/bots/vendas/sessions', {}), ('/bots/vendas/runs', {'input': NORMAL}), ('/bots/vendas/runs/run_x/stop', {})):
        for token in (None, 'wrong'):
            response = post(human_browser, path, body, token)
            assert response.status == 403 and error_of(response)['code'] == 'csrf_required'
    assert len(audit_rows()) == rows and run_count() == runs


def test_session_and_run_to_completion_on_the_real_gateway(human_browser):
    before = len(audit_rows())
    sid, run = new_run(human_browser, NORMAL, idempotency_key='k-' + uuid.uuid4().hex)
    assert run['status'] == 'started' and run['bot'] == 'vendas' and run['session_id'] == sid and run['id'].startswith('run_')
    done = wait_run(human_browser, 'vendas', run['id'], {'completed'})
    assert done['output'] == 'Harness model response' and done['error'] is None and done['session_id'] == sid
    assert done['usage']['total_tokens'] > 0
    assert set(done) >= {'id', 'status', 'session_id', 'output', 'error', 'usage', 'pending_steer'}
    # Audited with intent and result; the user's text never reaches the database (digest only).
    actions = [(r[0], r[1], r[2]) for r in audit_rows()[before:] if r[0] in ('session.create', 'run.create')]
    assert ('session.create', 'ok', 'intent') in actions and ('session.create', 'ok', 'result') in actions
    assert ('run.create', 'ok', 'intent') in actions and ('run.create', 'ok', 'result') in actions
    assert NORMAL.encode() not in DB.read_bytes()
    assert bot_status(human_browser, 'vendas')['status'] == 'idle'
    # A run is reachable only through its own Bot, and unknown ids are 404 with our error.
    other = get(human_browser, f'/bots/default/runs/{run["id"]}')
    assert other.status == 404 and error_of(other)['code'] == 'run_not_found'
    assert get(human_browser, '/bots/vendas/runs/run_nope').status == 404
    assert get(human_browser, '/bots/vendas/runs/..%2Fx').status == 404
    for response in (other,):
        no_secret(response.body(), 'run error')


def test_idempotency_key_replays_and_conflicts(human_browser):
    key = 'k-' + uuid.uuid4().hex
    sid, first = new_run(human_browser, NORMAL, idempotency_key=key)
    again = post(human_browser, '/bots/vendas/runs', {'input': NORMAL, 'session_id': sid, 'idempotency_key': key})
    assert again.status == 202 and again.json()['run']['id'] == first['id']
    conflict = post(human_browser, '/bots/vendas/runs', {'input': NORMAL + ' different', 'session_id': sid, 'idempotency_key': key})
    assert conflict.status == 409 and error_of(conflict)['code'] == 'duplicate'
    assert post(human_browser, '/bots/vendas/runs', {'input': NORMAL, 'idempotency_key': 'has space'}).status == 422
    wait_run(human_browser, 'vendas', first['id'], {'completed'})


def test_validation(human_browser):
    for body in ({}, {'input': ''}, {'input': 5}, {'input': 'x' * 50_001}, {'input': 'x', 'session_id': '../etc'},
                 {'input': 'x', 'instructions': 5}):
        assert post(human_browser, '/bots/vendas/runs', body).status == 422, body
    assert post(human_browser, '/bots/vendas/runs', {'input': 'x', 'surprise': 1}).status == 400
    assert post(human_browser, '/bots/missing-bot/runs', {'input': 'x'}).status == 404
    assert post(human_browser, '/bots/vendas/sessions', {'bad': 1}).status == 400


def test_stop_changes_the_status_of_a_run_in_progress_and_bot_status_follows(human_browser):
    sid, run = new_run(human_browser, APPROVAL)
    waiting = wait_run(human_browser, 'vendas', run['id'], {'waiting_for_approval'})
    bot = bot_status(human_browser, 'vendas')
    assert bot['status'] == 'waiting_approval' and bot['current_task']['id'] == run['id'] and bot['current_task']['kind'] == 'run'
    before = len(audit_rows('run.stop'))
    stopped = post(human_browser, f'/bots/vendas/runs/{run["id"]}/stop', {})
    assert stopped.status == 202 and stopped.json()['run'] == {'id': run['id'], 'status': 'stopping'}
    final = wait_run(human_browser, 'vendas', run['id'], {'cancelled'})
    assert final['status'] == 'cancelled'
    assert [(r[1], r[2]) for r in audit_rows('run.stop')[before:]] == [('ok', 'intent'), ('ok', 'result')]
    assert bot_status(human_browser, 'vendas')['status'] == 'idle' and bot_status(human_browser, 'vendas')['current_task'] is None
    # Stopping again answers with the terminal state instead of failing.
    again = post(human_browser, f'/bots/vendas/runs/{run["id"]}/stop', {})
    assert again.status == 202 and again.json()['run']['status'] == 'cancelled'
    assert post(human_browser, '/bots/vendas/runs/run_nope/stop', {}).status == 404


def test_a_paused_bot_gets_no_new_run(human_browser):
    budget = real_budget()
    budget.on_breach('vendas')  # the Budget's own pause
    runs, before = run_count(), len(audit_rows('run.create'))
    refused = post(human_browser, '/bots/vendas/runs', {'input': NORMAL})
    assert refused.status == 409 and error_of(refused)['code'] == 'bot_paused'
    assert run_count() == runs, 'a refused run must not reach Hermes or the index'
    assert [(r[1], r[2]) for r in audit_rows('run.create')[before:]] == [('ok', 'intent'), ('denied', 'result')]
    bot = bot_status(human_browser, 'vendas')
    assert bot['status'] == 'paused' and bot['status_reason'] == 'budget'
    no_secret(refused.body(), 'budget refusal')


def test_a_reached_cap_refuses_and_an_unverifiable_budget_fails_closed(human_browser):
    budget = real_budget()
    budget.set_limit('bot', 'vendas', 'day', 1000, actor='test-human')
    runs = run_count()
    # A cap is configured but nothing has refreshed spend: fail closed, nothing started. The real watcher is held (maintenance
    # file) and its last heartbeat aged, so the test, not the clock, decides when a snapshot is current.
    hold = DB.parent / 'watcher.hold'
    hold.write_text('')
    try:
        conn = sqlite3.connect(DB)
        conn.execute('DELETE FROM budget_watcher')
        conn.commit()
        conn.close()
        unverifiable = post(human_browser, '/bots/vendas/runs', {'input': NORMAL})
        assert unverifiable.status == 503 and error_of(unverifiable)['code'] == 'budget_unavailable'
        budget.heartbeat()  # the test plays the watcher that just consumed a current cost snapshot
        sid, run = new_run(human_browser, NORMAL)  # under the cap: allowed
        wait_run(human_browser, 'vendas', run['id'], {'completed'})
        quiet()                                                                   # the earlier run's hold is released
        token = budget.reserve('vendas', 900)  # reserved spend reaches the stop threshold
        assert token
        runs = run_count()
        capped = post(human_browser, '/bots/vendas/runs', {'input': NORMAL})
        assert capped.status == 409 and error_of(capped)['code'] == 'budget_exceeded'
        assert run_count() == runs
    finally:
        hold.unlink(missing_ok=True)


def test_no_cap_configured_means_nothing_to_enforce(human_browser):
    sid, run = new_run(human_browser, NORMAL)  # fresh Budget, no limits, no watcher: still allowed
    wait_run(human_browser, 'vendas', run['id'], {'completed'})


def test_run_index_only_admits_the_bot_that_started_the_run(human_browser):
    sid, run = new_run(human_browser, NORMAL)
    wait_run(human_browser, 'vendas', run['id'], {'completed'})
    plugin()
    from luvebot_backend.runs import RunIndex
    index = RunIndex(DB)
    assert index.owns('vendas', run['id']) is True
    assert index.owns('default', run['id']) is False
    assert index.owns('vendas', 'run_never_started') is False


def test_a_run_is_unreachable_through_another_bot_without_touching_hermes(human_browser, new_name):
    """404 must come from OUR index: with the gateway suspended, a call that reached Hermes would time out instead."""
    assert post(human_browser, '/bots', {'name': new_name, 'template': 'dev'}).status == 201
    sid, run = new_run(human_browser, APPROVAL)
    wait_run(human_browser, 'vendas', run['id'], {'waiting_for_approval'})
    stops_before, runs_before = len(audit_rows('run.stop')), run_count()
    pid = int((STATE / 'gateway-pid.txt').read_text())
    os.kill(pid, signal.SIGSTOP)
    try:
        for other in ('default', new_name):
            for run_id in (run['id'], 'run_never_started'):
                for label, call in (('GET', lambda b, r: get(human_browser, f'/bots/{b}/runs/{r}')),
                                    ('stop', lambda b, r: post(human_browser, f'/bots/{b}/runs/{r}/stop', {}))):
                    started = time.monotonic()
                    response = call(other, run_id)
                    assert response.status == 404, (label, other, run_id, response.status, response.text())
                    assert error_of(response)['code'] == 'run_not_found'
                    assert time.monotonic() - started < 5, 'a call that reached the suspended gateway would take 10 s'
                    no_secret(response.body(), 'isolation error')
        # The owner's own Bot also answers 404 for an id it never started, still without calling Hermes.
        assert get(human_browser, '/bots/vendas/runs/run_never_started').status == 404
    finally:
        os.kill(pid, signal.SIGCONT)
    assert len(audit_rows('run.stop')) == stops_before, 'a refused stop must not be audited as an action'
    assert run_count() == runs_before
    # No effect on the run: still waiting; only its own Bot can stop it.
    assert get(human_browser, f'/bots/vendas/runs/{run["id"]}').json()['run']['status'] == 'waiting_for_approval'
    assert post(human_browser, f'/bots/vendas/runs/{run["id"]}/stop', {}).status == 202
    wait_run(human_browser, 'vendas', run['id'], {'cancelled'})
