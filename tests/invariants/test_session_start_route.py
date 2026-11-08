"""Contract v0.9 section 10 through the real plugin and a real Hermes: a first message starts its own conversation in one request.
POST /runs with no session_id makes the session (run.session_id set, listed among the Bot's conversations, a repeat with the same
idempotency key returns the SAME session and the SAME run); POST /bots/{bot}/chat/stream makes it for a chat turn (first frame names
it, `session_id` in the body is 400, the second send with the same client_message_id is 409 and NO session is created, the 409 names the first
attempt's). WRITTEN, NOT RUN. The decisions and their mutations: tests/unit/backend/test_session_start.py (unit)."""
import json
import uuid

from test_bots import audit_rows, error_of, post
from test_hook import wait_live
from test_runs import get, wait_run


def sessions(browser):
    return {s['id'] for s in get(browser, '/bots/vendas/sessions?limit=100').json()['sessions']}


def opened_session(body):
    for line in body.splitlines():
        if line.startswith('data:'):
            try:
                data = json.loads(line[5:])
            except ValueError:
                continue
            if isinstance(data, dict) and data.get('surface') == 'chat' and data.get('session_id'):
                return data['session_id']
    return None


def test_a_run_without_a_session_makes_one_and_a_repeat_reuses_it(human_browser):
    wait_live(human_browser, 'vendas')
    key = 'luvebot-ss-' + uuid.uuid4().hex
    before = sessions(human_browser)
    rows = len(audit_rows('run.create'))
    first = post(human_browser, '/bots/vendas/runs', {'input': 'Responder 3 tickets', 'idempotency_key': key})
    assert first.status == 202, first.text()
    run = first.json()['run']
    assert run['session_id'] and run['session_id'] not in before
    assert run['session_id'] in sessions(human_browser)                                    # a conversation a person can reopen
    assert len(audit_rows('run.create')) == rows + 2
    wait_run(human_browser, 'vendas', run['id'], {'completed'})
    again = post(human_browser, '/bots/vendas/runs', {'input': 'Responder 3 tickets', 'idempotency_key': key})   # the answer was "lost"
    assert again.status == 202, again.text()
    assert again.json()['run']['session_id'] == run['session_id'] and again.json()['run']['id'] == run['id']
    assert len(sessions(human_browser) - before) == 1                                      # ONE new conversation
    own = post(human_browser, '/bots/vendas/runs', {'input': 'outra', 'session_id': run['session_id']})
    assert own.status == 202 and own.json()['run']['session_id'] == run['session_id']      # the sender's own is never replaced


def test_chat_without_a_session_makes_one_and_a_repeat_is_a_409_that_makes_none(human_browser):
    wait_live(human_browser, 'vendas')
    before = sessions(human_browser)
    cid = 'cid-' + uuid.uuid4().hex[:16]
    assert post(human_browser, '/bots/vendas/chat/stream', {'input': 'oi', 'session_id': 'x' * 10}).status == 400    # a session_id is an unknown key
    assert post(human_browser, '/bots/vendas/chat/stream', {'input': 'oi'}, None).status == 403                       # CSRF
    rows = len(audit_rows('session.create'))
    sent = post(human_browser, '/bots/vendas/chat/stream', {'input': 'Resumo da semana', 'client_message_id': cid})
    assert sent.status == 200, sent.text()
    session_id = opened_session(sent.text())
    assert session_id and session_id in sessions(human_browser) and len(audit_rows('session.create')) == rows + 2
    made = sessions(human_browser)
    repeat = post(human_browser, '/bots/vendas/chat/stream', {'input': 'Resumo da semana', 'client_message_id': cid})
    assert repeat.status == 409 and error_of(repeat)['code'] == 'duplicate'
    assert repeat.json()['error']['details']['session_id'] == session_id                   # the screen can reopen the first attempt's
    assert sessions(human_browser) == made and len(made - before) == 1                     # NO session was created for the second send
