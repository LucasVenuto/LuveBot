"""P2-3 / contract v0.10 section 2 on the REAL Hermes v0.22.5: the routine suggestions Hermes keeps per profile (`<home>/cron/suggestions.json`), seeded with Hermes's OWN
`cron.suggestions.add_suggestion` in a Bot's home (nothing here writes that file by hand), through LuveBot's three routes.

* the list: a supported suggestion shows its fields (the display subset of the spec only); one with `script` or `deliver: telegram:...` is `supported: false` with the reason in words and the
  NAMES of the offending fields, never their values;
* accept creates a PAUSED routine with the shown fields, once: a second accept answers 409 or the same routine, never a second job; the Bot's own `/suggestions` command no longer lists it
  (Hermes's record is `accepted`);
* an unsupported one is refused (409 `suggestion_not_supported`) and creates nothing;
* dismiss latches the `dedup_key` in Hermes (`add_suggestion` of the same key answers None) and a second dismiss is 409; dismiss is allowed in loopback, accept is 403 `loopback_not_human`;
* a Bot held by its cap never gets a RUNNING routine from here: `start: true` answers started false and the routine stays paused.
One Bot (vendas); the suggestions file and every routine made here are removed at the end."""
import os
import re
import sqlite3
from contextlib import contextmanager

import pytest

from support import plugin
from test_bots import post
from test_hook import loopback_request, run_async, wait_for
from test_phase4 import HOME, SEEDED, clean_budget, delete, made_names, put, seed_session
from test_runs import get
from test_zz_watcher_lease import job_state

BOT = 'vendas'
FILE = HOME / 'cron' / 'suggestions.json'
MADE = []


@contextmanager
def in_home(home):
    """`cron.suggestions` resolves its file at call time from HERMES_HOME: point it at the Bot's home for the call (as the dashboard does inside `_cron_store_scope`)."""
    saved = os.environ.get('HERMES_HOME')
    os.environ['HERMES_HOME'] = str(home)
    try:
        yield
    finally:
        if saved is None:
            os.environ.pop('HERMES_HOME', None)
        else:
            os.environ['HERMES_HOME'] = saved


def seed(title, key, spec, source='catalog', description='A seeded suggestion.'):
    """Hermes's own writer, in the Bot's home: the record as Hermes stores it."""
    from cron import suggestions
    with in_home(HOME):
        record = suggestions.add_suggestion(title=title, description=description, source=source, job_spec=spec, dedup_key=key)
    assert record and re.fullmatch(r'[0-9a-f]{12}', record['id']) and record['status'] == 'pending', record
    return record


def pending_ids():
    from cron import suggestions
    with in_home(HOME):
        return {s['id'] for s in suggestions.list_pending()}


def hermes_record(suggestion_id):
    from cron import suggestions
    with in_home(HOME):
        return suggestions.get_suggestion(suggestion_id)


def items(browser):
    response = get(browser, '/routine-suggestions')
    assert response.status == 200, response.text()
    body = response.json()
    return {i['id']: i for i in body['items'] if i['bot'] == BOT}, body


def accept(browser, suggestion_id, body=None):
    return post(browser, f'/bots/{BOT}/routine-suggestions/{suggestion_id}/accept', {} if body is None else body)


def dismiss(browser, suggestion_id):
    return post(browser, f'/bots/{BOT}/routine-suggestions/{suggestion_id}/dismiss', {})


def routines_named(browser, name):
    response = get(browser, '/routines?limit=100')
    assert response.status == 200, response.text()
    return [r for r in response.json()['routines'] if r['name'] == name]


def error_of(response):
    return (response.json().get('error') or {})


@pytest.fixture(scope='module', autouse=True)
def cleanup(human_browser):
    FILE.unlink(missing_ok=True)
    clean_budget()
    yield
    for job_id in MADE:
        delete(human_browser, f'/routines/{job_id}', {'confirm_name': made_names.get(job_id, '')})
    FILE.unlink(missing_ok=True)
    clean_budget()
    conn = sqlite3.connect(HOME / 'state.db')
    for session_id in SEEDED:
        conn.execute('DELETE FROM sessions WHERE id=?', (session_id,))
    conn.commit()
    conn.close()
    SEEDED.clear()


SIMPLE = {'name': 'Weekly summary', 'schedule': '0 9 * * 1', 'prompt': 'Summarise the week in three lines.'}
STATE = {}


def test_the_list_shows_what_can_be_created_and_why_not_for_the_rest(human_browser):
    STATE['ok'] = seed('Weekly summary', 'forja-ok', dict(SIMPLE))
    STATE['script'] = seed('Runs a script', 'forja-script', {**SIMPLE, 'name': 'With script', 'script': 'secret-value-script.py'}, source='usage')
    STATE['telegram'] = seed('Sends to Telegram', 'forja-telegram', {**SIMPLE, 'name': 'To telegram', 'deliver': 'telegram:123456'}, source='blueprint')
    shown, body = items(human_browser)
    assert set(STATE[k]['id'] for k in ('ok', 'script', 'telegram')) <= set(shown), (sorted(shown), body)
    assert BOT not in body.get('partial', [])
    ok = shown[STATE['ok']['id']]
    assert ok['supported'] is True and ok['title'] == 'Weekly summary' and ok['source'] == 'catalog', ok
    assert {k: ok['spec'][k] for k in ('name', 'schedule', 'prompt')} == SIMPLE, ok['spec']
    assert 'job_spec' not in ok and 'script' not in ok['spec'] and 'deliver' not in ok['spec']
    script = shown[STATE['script']['id']]
    assert script['supported'] is False and script['why_not'] == 'unsupported_fields' and script['fields'] == ['script'], script
    assert 'secret-value-script' not in str(body)                          # the NAME of the field, never its value
    telegram = shown[STATE['telegram']['id']]
    assert telegram['supported'] is False and telegram['why_not'] == 'delivery_outside', telegram
    assert telegram['spec'].get('deliver') == 'telegram:123456'            # where the result would go is SHOWN (the person accepts that one in Hermes, where the target is shown)


def test_accept_creates_one_paused_routine_with_the_shown_fields(human_browser):
    suggestion = STATE['ok']
    response = accept(human_browser, suggestion['id'])
    assert response.status == 201, response.text()
    body = response.json()
    routine = body['routine']
    MADE.append(routine['id'])
    made_names[routine['id']] = SIMPLE['name']
    assert body['suggestion_id'] == suggestion['id'] and body['started'] is False and 'held' not in body, body
    job = job_state(routine['id'])                                         # what Hermes itself holds
    assert routine['name'] == SIMPLE['name'] and job['name'] == SIMPLE['name'] and job['prompt'] == SIMPLE['prompt'], (routine, job)
    assert SIMPLE['schedule'] in str(job['schedule']), job
    assert job.get('state') == 'paused' and job.get('enabled') is False   # Hermes itself says paused: created, never running
    assert hermes_record(suggestion['id'])['status'] == 'accepted'
    assert suggestion['id'] not in pending_ids()                           # the Bot's own /suggestions command no longer lists it
    assert suggestion['id'] not in items(human_browser)[0]
    again = accept(human_browser, suggestion['id'])
    if again.status == 201:                                                # idempotent: the SAME routine
        assert again.json()['routine']['id'] == routine['id'] and again.json().get('replayed') is True, again.text()
    else:
        assert again.status == 409 and error_of(again).get('code') == 'suggestion_not_pending', again.text()
    assert [r['id'] for r in routines_named(human_browser, SIMPLE['name'])] == [routine['id']]      # never a second job


def test_an_unsupported_suggestion_is_refused_and_creates_nothing(human_browser):
    before = {r['id'] for r in get(human_browser, '/routines?limit=100').json()['routines']}
    for key, why in (('script', 'unsupported_fields'), ('telegram', 'delivery_outside')):
        response = accept(human_browser, STATE[key]['id'])
        assert response.status == 409 and error_of(response).get('code') == 'suggestion_not_supported', (key, response.status, response.text())
        assert (error_of(response).get('details') or {}).get('why_not') == why, response.text()
    assert {r['id'] for r in get(human_browser, '/routines?limit=100').json()['routines']} == before
    assert STATE['script']['id'] in pending_ids() and STATE['telegram']['id'] in pending_ids()     # still pending in Hermes


def test_dismiss_latches_the_dedup_key_in_hermes(human_browser):
    from cron import suggestions
    suggestion = STATE['telegram']
    response = dismiss(human_browser, suggestion['id'])
    assert response.status == 200 and response.json() == {'dismissed': True}, response.text()
    assert hermes_record(suggestion['id'])['status'] == 'dismissed' and suggestion['id'] not in pending_ids()
    with in_home(HOME):
        offered_again = suggestions.add_suggestion(title='Sends to Telegram', description='x', source='blueprint', job_spec={**SIMPLE, 'name': 'To telegram'}, dedup_key='forja-telegram')
    assert offered_again is None                                           # never offered again
    second = dismiss(human_browser, suggestion['id'])
    assert second.status == 409 and error_of(second).get('code') == 'suggestion_not_pending', second.text()


def test_loopback_cannot_accept_but_can_dismiss():
    module = plugin()
    spare = seed('Spare one', 'forja-loop', {**SIMPLE, 'name': 'Loop routine'})
    path = f'/api/plugins/luvebot/bots/{BOT}/routine-suggestions/{spare["id"]}'
    with pytest.raises(module.PluginError) as refused:
        run_async(module.accept_routine_suggestion(BOT, spare['id'], loopback_request(module, 'POST', path + '/accept', body=b'{}')))
    assert (refused.value.code, refused.value.status) == ('loopback_not_human', 403)
    assert spare['id'] in pending_ids() and hermes_record(spare['id'])['status'] == 'pending'     # refused before anything: still pending in Hermes
    answer = run_async(module.dismiss_routine_suggestion(BOT, spare['id'], loopback_request(module, 'POST', path + '/dismiss', body=b'{}')))
    assert answer.status_code == 200 and spare['id'] not in pending_ids()  # a tightening: allowed without a login


def test_start_true_starts_it_when_the_gates_allow(human_browser):
    """The positive control of the test below: no cap, `start: true` -> started, and Hermes says the job is not paused."""
    suggestion = seed('Start me', 'forja-start', {**SIMPLE, 'name': 'Started routine'})
    response = accept(human_browser, suggestion['id'], {'start': True})
    assert response.status == 201, response.text()
    body = response.json()
    MADE.append(body['routine']['id'])
    made_names[body['routine']['id']] = 'Started routine'
    assert body['started'] is True and 'held' not in body, body
    job = job_state(body['routine']['id'])
    assert job.get('state') != 'paused' and job.get('enabled') is True, job


def test_a_bot_held_by_its_cap_never_gets_a_running_routine_from_here(human_browser):
    canary = post(human_browser, '/routines', {'bot': BOT, 'name': 't-sug-canary', 'schedule': 'every 1h', 'prompt': 'say hello', 'start': True})
    assert canary.status == 201, canary.text()
    held_job = canary.json()['routine']
    MADE.append(held_job['id'])
    made_names[held_job['id']] = 't-sug-canary'
    suggestion = seed('Held one', 'forja-held', {**SIMPLE, 'name': 'Held routine'})
    assert put(human_browser, '/budget/limits', {'scope': 'bot', 'ref': BOT, 'period': 'day', 'cents': 500}).status == 200
    for n in range(3):
        seed_session(f"cron_{held_job['id']}_20260101_00000{n}", 1.7)
    wait_for(lambda: job_state(held_job['id']).get('state') == 'paused', 90, 'the cap to pause the Bot (its canary routine)')
    response = accept(human_browser, suggestion['id'], {'start': True})
    assert response.status == 201, response.text()
    body = response.json()
    MADE.append(body['routine']['id'])
    made_names[body['routine']['id']] = 'Held routine'
    assert body['started'] is False and body.get('held') in ('bot_paused', 'budget_held'), body
    assert job_state(body['routine']['id']).get('state') == 'paused'      # created, never running
