"""T4.6: the Activity item actions of contract v0.2 section 2 (context, redirect, stop) against the real Hermes Kanban and runs.

The browser never calls Hermes for these: the backend does, in process, audited before the effect, and a stop is reported as
confirmed only after Hermes itself says the work has ended.
"""
import json
import sqlite3
import time

import pytest

from support import DASHBOARD, plugin
from test_approvals import ask_run, wait_pending
from test_bots import DB, audit_rows, csrf, error_of, post
from test_hook import load_plugin, loopback_request, run_async, wait_live
from test_phase5 import block_rule
from test_rules_api import clean_rules  # noqa: F401  (removes the rule a test activated)
from test_phase4 import clean, clean_budget, new_routine  # noqa: F401  (`clean` is the fixture that removes the routines a test made)
from test_plugin import PREFIX
from test_runs import get


@pytest.fixture(autouse=True)
def tidy(human_browser):
    clean_budget()
    for name in ('vendas', 'default'):
        wait_live(human_browser, name)  # T10.4: a redirect needs the destination's hook live (and the creator's table)
    yield
    clean_budget()


def board():
    from hermes_cli import kanban_db
    from plugins.kanban.dashboard import plugin_api as kanban
    return kanban_db, kanban._board_conn(None)


def make_task(title, *, assignee='vendas', running=False):
    kanban_db, ctx = board()
    with ctx as (_b, conn):
        task_id = kanban_db.create_task(conn, title=title, assignee=assignee, created_by='default', triage=not running)
        if running:
            assert kanban_db.claim_task(conn, task_id) is not None, 'the dispatcher took the task first'
    return task_id


def task_row(task_id):
    plugin()
    import luvebot_backend.hermes_cron as cron
    return cron.kanban_task(task_id)


def comments(task_id):
    kanban_db, ctx = board()
    with ctx as (_b, conn):
        return [(c.author, c.body) for c in kanban_db.list_comments(conn, task_id)]


def act(browser, item, action, body):
    return post(browser, f'/activity/{item}/{action}', body)


def test_the_action_routes_are_in_the_router_so_the_401_sweep_covers_them():
    from test_plugin import routes
    found = set(routes())
    for action in ('context', 'redirect', 'stop'):
        assert ('POST', PREFIX + f'/activity/{{item_id}}/{action}') in found


def test_context_reaches_the_task_as_data_authored_by_a_person_and_the_audit_keeps_no_text(human_browser):
    task = make_task('t46 context')
    secret_text = 'please prefer the blue plan t46-unique-text'
    before = len(audit_rows('activity.context'))
    assert act(human_browser, f'task:{task}', 'context', {'text': secret_text, 'kind': 'context'}).status == 200
    assert act(human_browser, f'task:{task}', 'context', {'text': 'no, the red one', 'kind': 'correction'}).status == 200
    found = comments(task)
    assert found[0][0].startswith('luvebot:') and found[0][0] != 'luvebot:' and found[0][1] == secret_text
    assert found[1][1] == '[correction] no, the red one'
    rows = audit_rows('activity.context')[before:]
    assert [(r[1], r[2]) for r in rows] == [('ok', 'intent'), ('ok', 'result')] * 2 and all(r[3] == f'task:{task}' for r in rows)
    conn = sqlite3.connect(DB)
    dump = json.dumps(conn.execute('SELECT * FROM audit_log').fetchall())
    conn.close()
    assert 't46-unique-text' not in dump                                                     # a digest and a length, never the text
    for body in ({'text': '', 'kind': 'context'}, {'text': 'x', 'kind': 'order'}, {'text': 'x'}, {'text': 'x', 'kind': 'context', 'bot': 'default'}):
        assert act(human_browser, f'task:{task}', 'context', body).status in (400, 422), body
    assert act(human_browser, 'task:nope', 'context', {'text': 'x', 'kind': 'context'}).status == 404
    assert act(human_browser, 'weird-id', 'context', {'text': 'x', 'kind': 'context'}).status == 404


def test_context_for_a_run_or_a_routine_says_what_is_missing_instead_of_pretending(human_browser, clean):
    run_id = ask_run(human_browser)
    wait_pending(human_browser, run_id)
    refused = act(human_browser, f'run:{run_id}', 'context', {'text': 'hello', 'kind': 'context'})
    assert refused.status == 409 and error_of(refused)['code'] == 'capability_missing'
    routine = new_routine(human_browser, clean, 't46-routine')
    other = act(human_browser, f"routine_due:{routine['id']}", 'context', {'text': 'hello', 'kind': 'context'})
    assert other.status == 409 and error_of(other)['code'] == 'not_supported'
    assert act(human_browser, f"routine_due:{routine['id']}", 'stop', {}).status == 409
    assert act(human_browser, f'run:{run_id}', 'redirect', {'bot': 'default'}).status == 409
    stop = act(human_browser, f'run:{run_id}', 'stop', {})
    assert stop.status == 202 and stop.json()['confirmed'] is True and stop.json()['status'] == 'cancelled', stop.text()
    assert [(r[1], r[2]) for r in audit_rows('activity.stop')[-2:]] == [('ok', 'intent'), ('ok', 'result')]


def test_redirect_hands_the_task_over_but_never_to_a_paused_bot_or_a_running_claim(human_browser):
    task = make_task('t46 redirect')
    assert act(human_browser, f'task:{task}', 'redirect', {'bot': 'nope-nope'}).status == 404
    assert act(human_browser, f'task:{task}', 'redirect', {'bot': 'default', 'extra': 1}).status == 400
    plugin()
    from luvebot_backend.audit import AuditLog
    from luvebot_backend.budget import Budget
    Budget(DB, audit=AuditLog(DB)).on_breach('default')
    refused = act(human_browser, f'task:{task}', 'redirect', {'bot': 'default'})
    assert refused.status == 409 and error_of(refused)['code'] == 'bot_paused' and task_row(task)['assignee'] == 'vendas'
    clean_budget()
    assert act(human_browser, f'task:{task}', 'redirect', {'bot': 'default', 'reason': 'wrong specialist'}).status == 200
    assert task_row(task)['assignee'] == 'default'
    running = make_task('t46 running', running=True)
    busy = act(human_browser, f'task:{running}', 'redirect', {'bot': 'default'})
    assert busy.status == 409 and error_of(busy)['code'] == 'conflict' and task_row(running)['assignee'] == 'vendas'
    assert act(human_browser, f'task:{running}', 'redirect', {'bot': 'default', 'reclaim_first': True}).status == 200
    assert task_row(running)['assignee'] == 'default' and task_row(running)['status'] != 'running'


def test_stop_is_confirmed_by_what_hermes_says_afterwards(human_browser):
    running = make_task('t46 stop', running=True)
    assert task_row(running)['status'] == 'running'
    stopped = act(human_browser, f'task:{running}', 'stop', {'reason': 'wrong direction'})
    assert stopped.status == 202, stopped.text()
    body = stopped.json()
    now = task_row(running)['status']
    assert now != 'running' and body['confirmed'] is True and body['status'] == now          # Hermes's own state, not our word
    again = act(human_browser, f'task:{running}', 'stop', {})
    assert again.status == 409 and error_of(again)['code'] == 'conflict'                      # nothing running to stop
    assert [(r[1], r[2]) for r in audit_rows('activity.stop')[-4:-2]] == [('ok', 'intent'), ('ok', 'result')]


def test_the_actions_need_a_csrf_token(human_browser):
    for action, body in (('context', {'text': 'x', 'kind': 'context'}), ('redirect', {'bot': 'default'}), ('stop', {})):
        response = human_browser.request.fetch(DASHBOARD + PREFIX + f'/activity/task:abc/{action}', method='POST', data=body)
        assert response.status == 403 and error_of(response)['code'] == 'csrf_required', action


def made_by(creator, assignee, title):
    plugin()
    import luvebot_backend.hermes_cron as cron
    return cron.kanban_create(title=title, body=None, assignee=assignee, created_by=creator, triage=True, idempotency_key='t104-' + str(time.time_ns()))


def redirect(browser, task, bot):
    return act(browser, f'task:{task}', 'redirect', {'bot': bot})


def test_t104_a_redirect_is_dispatch_so_it_needs_the_destination_hook_and_the_creators_table(human_browser, monkeypatch):
    """T10.4 (second review of t47, high): a redirect used to hand a task to another Bot with no hook gate and no look at who made it."""
    module = plugin()
    task = made_by('vendas', 'vendas', 't104 hook gate')
    # (a) the destination's hook is not live: refused, the task stays where it was
    real = module.hook.hook_gate

    def gate(path, bot):
        if bot == 'default':
            raise module.PluginError('hook_not_live', 'The rules are not loaded for this Bot.', 409)
        return real(path, bot)
    monkeypatch.setattr(module.hook, 'hook_gate', gate)
    request = loopback_request(module, 'POST', f'/activity/task:{task}/redirect', body=json.dumps({'bot': 'default'}).encode())
    with pytest.raises(module.PluginError) as refused:
        run_async(module.activity_redirect(f'task:{task}', request))
    assert refused.value.code == 'hook_not_live' and task_row(task)['assignee'] == 'vendas'
    mine = made_by('dashboard', 'vendas', 't104 hook gate, by a person')                   # no creator Bot: the destination's hook still counts
    request = loopback_request(module, 'POST', f'/activity/task:{mine}/redirect', body=json.dumps({'bot': 'default'}).encode())
    with pytest.raises(module.PluginError) as refused:
        run_async(module.activity_redirect(f'task:{mine}', request))
    assert refused.value.code == 'hook_not_live' and task_row(mine)['assignee'] == 'vendas'
    monkeypatch.undo()
    # (b) the task was made by a Bot whose rules were never compiled: its restrictions could not follow the work
    conn = sqlite3.connect(DB)
    saved = conn.execute("SELECT * FROM hook_tables WHERE profile='vendas'").fetchall()
    cols = [c[1] for c in conn.execute('PRAGMA table_info(hook_tables)')]
    conn.execute("DELETE FROM hook_tables WHERE profile='vendas'")
    conn.commit()
    conn.close()
    try:
        refused = redirect(human_browser, task, 'default')
        assert refused.status == 409 and error_of(refused)['code'] == 'hook_not_live' and error_of(refused)['details'] == {'bot': 'vendas'}, refused.text()
        assert task_row(task)['assignee'] == 'vendas'
        by_person = made_by('dashboard', 'vendas', 't104 by a person')                       # nobody's restrictions to carry
        assert redirect(human_browser, by_person, 'default').status == 200 and task_row(by_person)['assignee'] == 'default'
    finally:
        conn = sqlite3.connect(DB)
        conn.executemany(f"INSERT OR REPLACE INTO hook_tables ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})", saved)
        conn.commit()
        conn.close()
    wait_live(human_browser, 'vendas')
    assert redirect(human_browser, task, 'default').status == 200 and task_row(task)['assignee'] == 'default'   # all in place: it goes


def test_t104_red_team_a_redirect_to_a_more_permissive_bot_does_not_shed_the_restriction(human_browser, tmp_path, monkeypatch):
    """RT: the origin Bot is forbidden a tool; the task is redirected to a Bot that is not. The creator stays on the task, and the
    destination's own hook still applies the creator's rule to the worker (H-R3), so the redirect does not launder the action."""
    block_rule(human_browser, 'vendas', 't104_forbidden_tool')
    task = made_by('vendas', 'vendas', 't104 laundering')
    hook = load_plugin(tmp_path, DB)._make_hook('default')
    assert hook('t104_forbidden_tool', {}) is None                                           # default alone is permissive: that is the point
    assert redirect(human_browser, task, 'default').status == 200
    after = task_row(task)
    assert after['assignee'] == 'default' and after['created_by'] == 'vendas'                 # provenance is not rewritten by a redirect
    monkeypatch.setenv('HERMES_KANBAN_TASK', task)
    verdict = hook('t104_forbidden_tool', {})
    assert verdict['action'] == 'block' and 'origin:vendas' in verdict['message']              # the worker of the new Bot is still bound
    assert hook('web_search', {'query': 'x'}) is None
