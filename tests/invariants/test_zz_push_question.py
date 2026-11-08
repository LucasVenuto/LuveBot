"""N-5, the scenario of N-3 (contract v0.11 7.6): a Bot that stops for a person's answer wakes the devices that asked for `question`, ONCE, and an `api_server` approval stays an `approval`. On the REAL Hermes, with the harness
push service of tests/invariants/test_zz_push_delivery.py (the stack started with `HTTPS_PROXY`, `SSL_CERT_FILE`, `HARNESS_PUSH_FAKE` and `LUVEBOT_PUSH_SUBJECT=https://luve.app`).

Three devices: one that wants only `question`, one that wants only `approval`, one that sent no list of kinds (a new subscription with none gets all three). A run whose model calls Hermes's own `clarify` (the fake model's
G_CLARIFY_TEXT) blocks on a person: the hook writes one `waiting` row, and the watcher, on the lease owner, wakes ONCE per wait:
  * the service saw exactly TWO wakes with `Topic: question`, one for the `question` device and one for the open one, an empty body, a well-formed contact; none for the `approval`-only device, however long it waits
    (the same wait is never said twice: the key `wait:<bot>:<request_id>`);
  * the event carries the kind and the Bot, never the clarify's text, which is in no answer, no log of the service and no audit row; the audit holds `notifications.push` with the digest of `{kind: question}`;
  * then a command approval of the same Bot (`api_server`: the inbox's own, not a wait) wakes with `Topic: approval` for the devices that want approval and adds NO `question` wake.
Skipped without that environment."""
import hashlib
import json
import sqlite3
import time

import pytest

from support import DASHBOARD
from test_bots import DB, csrf, post
from test_hook import session, wait_for, wait_live
from test_runs import APPROVAL, get
from test_zz_push_delivery import FAKE, HOST, SUBJECT, devices, fake, forget_mine

pytestmark = pytest.mark.skipif(not FAKE or SUBJECT != 'https://luve.app', reason='needs the harness push service and LUVEBOT_PUSH_SUBJECT=https://luve.app (see test_zz_push_delivery.py)')
PROMPT = 'G_CLARIFY_TEXT: ask me'
QUESTION_TEXT = 'Em que pasta eu salvo o relat'          # the clarify's own words (the fake model's scene): they must reach no lock screen, no service, no audit


def subscribe(browser, fate, key, kinds=None):
    body = {'endpoint': f'https://{HOST}/{fate}', 'application_server_key': key, **({'kinds': kinds} if kinds is not None else {})}
    made = post(browser, '/notifications/subscriptions', body)
    assert made.status == 201, (fate, made.text()[:300])
    return made.json()


def wakes(topic):
    return sorted(e['path'] for e in fake('/_log') if e['topic'] == topic)


def stop(browser, run_id):
    return browser.request.post(f'{DASHBOARD}/api/plugins/luvebot/bots/vendas/runs/{run_id}/stop', data={}, headers={'X-LuveBot-CSRF': csrf(browser)})


def test_a_wait_wakes_the_question_devices_once_and_an_approval_stays_an_approval(human_browser):
    wait_live(human_browser, 'vendas')
    fake('/_reset', 'POST')
    key = get(human_browser, '/notifications/config').json()['public_key']
    asked = subscribe(human_browser, 'ok/1', key, ['question'])
    assert asked['kinds'] == ['question']
    subscribe(human_browser, 'ok/2', key, ['approval'])
    open_device = subscribe(human_browser, 'ok/3', key)                                                         # no list: all the kinds of today
    assert open_device['kinds'] == ['approval', 'budget', 'question'], open_device
    runs = []
    try:
        started = post(human_browser, '/bots/vendas/runs', {'input': PROMPT, 'session_id': session(human_browser, 'vendas')})
        assert started.status == 202, started.text()
        runs.append(started.json()['run']['id'])
        wait_for(lambda: len(wakes('question')) >= 2 or None, 90, 'the two question wakes')
        time.sleep(15)                                                                                          # several watcher ticks later: the same wait is never said twice
        assert wakes('question') == ['/ok/1', '/ok/3'], fake('/_log')                                          # one per device that wants it, none for the approval-only device
        seen = [e for e in fake('/_log') if e['topic'] == 'question']
        assert all(e['status'] == 201 and e['sub'] == 'https://luve.app' and e['body_len'] == 0 and e['ttl'] == '3600' for e in seen), seen
        latest = get(human_browser, '/notifications/latest')
        assert latest.status == 200 and 'question' in latest.text() and 'vendas' in latest.text(), latest.text()[:300]
        conn = sqlite3.connect(DB)
        try:
            rows = conn.execute("SELECT detail, outcome, digest FROM audit_log WHERE action='notifications.push' AND target='vendas' ORDER BY rowid DESC LIMIT 2").fetchall()
            audit_text = ' '.join(str(c) for r in conn.execute("SELECT * FROM audit_log WHERE action LIKE 'notifications.%'").fetchall() for c in r)
        finally:
            conn.close()
        expected = hashlib.sha256(json.dumps({'kind': 'question'}, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        assert rows[::-1] == [('intent', 'ok', expected), ('result', 'ok', expected)], rows                     # one announcement: `{kind: question}` and nothing else
        for where, text in (('the latest event', latest.text()), ('the push service log', json.dumps(fake('/_log'))), ('the audit', audit_text)):
            assert QUESTION_TEXT not in text, f'the clarify text reached {where}'                                # the agent's words never leave: the push is empty
        # the Bot's clarify ends; a command approval of the same Bot (the inbox's own wait) is an `approval`, never a `question`
        assert stop(human_browser, runs[0]).status in (200, 202)
        before = len(wakes('question'))
        approval = post(human_browser, '/bots/vendas/runs', {'input': APPROVAL, 'session_id': session(human_browser, 'vendas')})
        assert approval.status == 202, approval.text()
        runs.append(approval.json()['run']['id'])
        wait_for(lambda: wakes('approval') or None, 90, 'the approval wake')
        time.sleep(10)
        got = wakes('approval')
        assert got and set(got) <= {'/ok/2', '/ok/3'} and '/ok/1' not in got, got                              # only the devices that want approvals
        assert len(wakes('question')) == before, 'an approval of the api_server was announced as a question'
    finally:
        for run_id in runs:
            stop(human_browser, run_id)
        forget_mine(human_browser)
