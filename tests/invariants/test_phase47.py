"""T4.7: the nine findings of the second security review of phases 4 and 5 (S01 to S09), each with a test against the real
Hermes and a mutation (tests/harness/mutate_phase4.py).
"""
import json
import sqlite3
import time

import pytest

from support import DASHBOARD, plugin
from test_approvals import ask_run, wait_pending
from test_bots import DB, audit_rows, csrf, error_of, post
from test_hook import load_plugin, loopback_request, run_async, wait_for, wait_live
from test_phase4 import SEEDED, clean, clean_budget, new_routine, put, routine_state, seed_session  # noqa: F401  (`clean` removes the routines made)
from test_phase5 import (MADE_HANDOFFS, MADE_ROOMS, block_rule, handoff, make_room, send, tidy_phase5)  # noqa: F401  (autouse: hooks live, rooms removed)
from test_plugin import PREFIX, no_secret
from test_rules_api import clean_rules  # noqa: F401
from test_runs import get


def pause_bot(bot):
    plugin()
    from luvebot_backend.audit import AuditLog
    from luvebot_backend.budget import Budget
    Budget(DB, audit=AuditLog(DB)).on_breach(bot)


def kanban():
    plugin()
    import luvebot_backend.hermes_cron as cron
    return cron


def test_s01_a_bot_with_a_routine_cap_still_reached_stays_paused(human_browser, clean):
    mine = new_routine(human_browser, clean, 't47-s01')
    assert put(human_browser, '/budget/limits', {'scope': 'routine', 'ref': mine['id'], 'period': 'day', 'cents': 100}).status == 200
    seed_session(f"cron_{mine['id']}_20260101_000000", 0.95)                                      # 95 of 100: past the stop line
    assert wait_for(lambda: routine_state(human_browser, mine['id'])['state'] == 'paused', 60, 'the routine cap to pause the routine')
    refused = post(human_browser, '/bots/vendas/budget/resume', {})
    assert refused.status == 409 and error_of(refused)['code'] == 'budget_exceeded' and error_of(refused)['details']['routines'] == [mine['id']]
    assert routine_state(human_browser, mine['id'])['state'] == 'paused'


def test_s02_every_path_that_starts_work_is_gated(human_browser, clean):
    block_rule(human_browser, 'vendas', 't47_ask', level='ask')
    wait_live(human_browser, 'vendas')                                                            # the new table is loaded before work is handed over
    asked = handoff(human_browser, 'default', 'vendas', 't47_ask')                                # lands in triage, waiting for a person
    assert asked.status == 201 and asked.json()['handoff']['needs_review'] is True, asked.text()
    MADE_HANDOFFS.append(asked.json()['handoff']['id'])
    room = make_room(human_browser)
    pause_bot('vendas')
    # an active routine, a promoted handoff and a retried room task are work starting: all refused for a paused Bot
    created = post(human_browser, '/routines', {'bot': 'vendas', 'name': 't47-active', 'schedule': 'every 1h', 'prompt': 'hi', 'start': True})
    assert created.status == 409 and error_of(created)['code'] == 'bot_paused'
    promoted = post(human_browser, f"/handoffs/{asked.json()['handoff']['id']}/promote", {})
    assert promoted.status == 409 and error_of(promoted)['code'] == 'bot_paused'
    retried = post(human_browser, f"/rooms/{room['id']}/tasks/task-1/retry", {'confirm': True})
    assert retried.status == 409 and error_of(retried)['code'] == 'bot_paused'
    assert [r['name'] for r in get(human_browser, '/routines?limit=100').json()['routines'] if r['name'] == 't47-active'] == []
    clean_budget()
    # resuming a routine when the budget cannot be verified is refused (a cap exists and the watcher has not reported)
    paused = new_routine(human_browser, clean, 't47-stale', start=False)
    assert put(human_browser, '/budget/limits', {'scope': 'bot', 'ref': 'vendas', 'period': 'day', 'cents': 100000}).status == 200
    hold = DB.parent / 'watcher.hold'
    hold.write_text('')
    try:
        conn = sqlite3.connect(DB)
        conn.execute('DELETE FROM budget_watcher')
        conn.commit()
        conn.close()
        stale = post(human_browser, f"/routines/{paused['id']}/resume", {})
        assert stale.status == 409 and error_of(stale)['code'] == 'watcher_stale', stale.text()
    finally:
        hold.unlink(missing_ok=True)


def test_s03_a_cap_below_what_was_already_spent_pauses_at_once(human_browser, clean):
    mine = new_routine(human_browser, clean, 't47-s03')
    assert routine_state(human_browser, mine['id'])['state'] == 'scheduled'
    response = put(human_browser, '/budget/limits', {'scope': 'bot', 'ref': 'vendas', 'period': 'day', 'cents': 0})   # no spend, no new spend
    assert response.status == 200, response.text()
    assert routine_state(human_browser, mine['id'])['state'] == 'paused'                           # by the time the answer returned
    assert routine_state(human_browser, mine['id'])['paused_reason'] == 'budget'
    assert [p['bot'] for p in get(human_browser, '/budget').json()['paused']] == ['vendas']


def test_s04_a_handoff_is_not_dispatched_without_the_origins_table_and_an_unverifiable_origin_asks(human_browser, tmp_path, monkeypatch):
    plugin()
    import luvebot_backend.hook_store as store
    conn = sqlite3.connect(DB)
    saved = conn.execute("SELECT * FROM hook_tables WHERE profile='vendas'").fetchall()
    cols = [c[1] for c in conn.execute('PRAGMA table_info(hook_tables)')]
    conn.execute("DELETE FROM hook_tables WHERE profile='vendas'")
    conn.commit()
    conn.close()
    try:
        refused = post(human_browser, '/handoffs', {'from': 'vendas', 'to': 'default', 'title': 't47 no table'})
        assert refused.status == 409 and error_of(refused)['code'] == 'hook_not_live' and error_of(refused)['details'] == {'bot': 'vendas'}, refused.text()
        import luvebot_backend.hermes_cron as cron
        task = cron.kanban_create(title='t47 s04', body=None, assignee='default', created_by='vendas', triage=True, idempotency_key='t47-' + str(time.time_ns()))
        hook = load_plugin(tmp_path, DB)._make_hook('default')
        monkeypatch.setenv('HERMES_KANBAN_TASK', task)
        verdict = hook('web_search', {'query': 'x'})
        assert verdict['action'] == 'approve' and 'origin_unverifiable' in verdict['message']       # a Bot without a table is not a person
        plain = cron.kanban_create(title='t47 s04b', body=None, assignee='default', created_by='dashboard', triage=True, idempotency_key='t47b-' + str(time.time_ns()))
        monkeypatch.setenv('HERMES_KANBAN_TASK', plain)
        assert hook('web_search', {'query': 'x'}) is None                                             # a person's task: only the destination applies
    finally:
        conn = sqlite3.connect(DB)
        conn.executemany(f"INSERT OR REPLACE INTO hook_tables ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})", saved)
        conn.commit()
        conn.close()


def test_s05_creating_and_promoting_a_handoff_need_a_person_not_the_loopback_token():
    module = plugin()
    for call in (module.create_handoff(loopback_request(module, 'POST', '/handoffs', body=json.dumps({'from': 'vendas', 'to': 'default', 'title': 'x'}).encode())),
                 module.promote_handoff('ho-nope', loopback_request(module, 'POST', '/handoffs/ho-nope/promote', body=b'{}'))):
        with pytest.raises(module.PluginError) as refused:
            run_async(call)
        assert refused.value.code == 'loopback_not_human' and refused.value.status == 403


def test_s06_every_text_of_a_routine_and_of_the_activity_is_redacted(human_browser, clean):
    secret = 'sk-' + 'a1b2c3d4e5f6' * 3
    made = post(human_browser, '/routines', {'bot': 'vendas', 'name': f't47 {secret}', 'schedule': 'every 1h', 'prompt': 'hi', 'model': secret,
                                             'deliver': 'local', 'skills': []})
    assert made.status == 201, made.text()
    clean.append(made.json()['routine']['id'])
    from test_phase4 import made_names
    made_names[made.json()['routine']['id']] = f't47 {secret}'
    assert secret not in made.text()
    for path in ('/routines?limit=100', f"/routines/{made.json()['routine']['id']}", '/activity?tab=scheduled&limit=100'):
        assert secret not in get(human_browser, path).text(), path
    task = kanban().kanban_create(title=f'handoff {secret}', body=None, assignee='vendas', created_by='default', triage=True, idempotency_key='t47c-' + str(time.time_ns()))
    shown = get(human_browser, '/activity?tab=scheduled&limit=100').text()
    assert task in shown and secret not in shown
    no_secret(shown, 'activity')


def test_s07_a_search_limited_to_a_bot_only_returns_rooms_that_bot_is_in(monkeypatch):
    module = plugin()
    rooms = {'rooms': [{'room_id': 'r1', 'name': 'alpha only default', 'members': [{'profile': 'default', 'handle': 'default'}]},
                       {'room_id': 'r2', 'name': 'alpha with vendas', 'members': [{'profile': 'vendas', 'handle': 'vendas'}, {'profile': 'default', 'handle': 'default'}]}]}

    async def fake(method, params):
        return rooms if method == 'groups.list' else {}
    monkeypatch.setattr(module, '_room_call', fake)
    scoped = json.loads(run_async(module.get_search(loopback_request(module, 'GET', '/search'), q='alpha', types='rooms', bots='vendas', limit=8)).body)
    assert [r['id'] for r in scoped['rooms']] == ['r2']
    everyone = json.loads(run_async(module.get_search(loopback_request(module, 'GET', '/search'), q='alpha', types='rooms', bots=None, limit=8)).body)
    assert [r['id'] for r in everyone['rooms']] == ['r1', 'r2']


def test_s08_the_executor_audits_each_stop_before_the_call_and_confirms_the_end(human_browser):
    run_id = ask_run(human_browser)
    wait_pending(human_browser, run_id)
    before = len(audit_rows('budget.executor.step'))
    pause_bot('vendas')
    assert wait_for(lambda: get(human_browser, f'/bots/vendas/runs/{run_id}').json()['run']['status'] in ('cancelled', 'failed'), 60, 'the executor to stop the run')
    wait_for(lambda: ('budget.executor.step', 'ok', 'result', 'vendas') in audit_rows('budget.executor.step')[before:], 30, 'the stop to be recorded')
    rows = audit_rows('budget.executor.step')[before:]
    assert ('budget.executor.step', 'ok', 'intent', 'vendas') in rows and ('budget.executor.step', 'ok', 'result', 'vendas') in rows
    conn = sqlite3.connect(DB)
    steps = [r[0] for r in conn.execute("SELECT digest FROM audit_log WHERE action='budget.executor.step' AND detail='intent' AND target='vendas'")]
    conn.close()
    assert steps, 'the stop attempt has its own intent row'
    assert wait_for(lambda: [p['plan_status'] for p in get(human_browser, '/budget').json()['paused']] == ['applied'], 30, 'the plan to be confirmed')


def test_s09_a_bot_made_handoff_is_ingested_and_audited_without_anyone_opening_the_map(human_browser):
    cron = kanban()
    task = cron.kanban_create(title='t47 bot made', body=None, assignee='default', created_by='vendas', triage=True, idempotency_key='t47d-' + str(time.time_ns()))
    assert wait_for(lambda: any(r[3] for r in audit_rows('handoff.unrecorded') if r[3] == task), 60, 'the watcher to ingest the handoff and raise the alert')
    conn = sqlite3.connect(DB)
    found = conn.execute("SELECT id, state FROM handoffs WHERE task_id=?", (task,)).fetchone()
    conn.close()
    assert found is not None                                                                      # a row, with nobody calling GET /map
    MADE_HANDOFFS.append(found[0])
    assert cron.kanban_archive(task)
    assert wait_for(lambda: any(r[3] == found[0] for r in audit_rows('handoff.cancelled')), 60, 'the watcher to audit the transition')
    assert get(human_browser, f'/handoffs/{found[0]}').json()['handoff']['state'] == 'cancelled'
