"""Contract v0.8 section 4 (threads) through the real plugin and a real Hermes: POST /bots/{bot}/threads starts a NEW conversation
(the stream's first frame names it) whose first message quotes what HERMES holds for the parent message, never a text the browser
sent; the parent session is NOT ended (Hermes's fork would end it); the thread is hidden from the conversation list and counted
by GET /sessions/{sid}/threads; audited `thread.create`. The quote/redaction/cap rules and their mutations: test_threads.py (unit)."""
import json

from test_bots import audit_rows, post
from test_hook import wait_live
from test_runs import get


def opened_session(body):
    """The session named by the stream's `luvebot.stream.open` frame."""
    for line in body.splitlines():
        if line.startswith('data:'):
            try:
                data = json.loads(line[5:])
            except ValueError:
                continue
            if isinstance(data, dict) and data.get('surface') == 'chat' and data.get('session_id'):
                return data['session_id']
    return None


def test_thread_route(human_browser):
    wait_live(human_browser, 'vendas')
    sid = post(human_browser, '/bots/vendas/sessions', {}).json()['session']['id']
    assert post(human_browser, f'/bots/vendas/sessions/{sid}/chat/stream', {'input': 'Resumo da semana'}).status == 200
    messages = get(human_browser, f'/bots/vendas/sessions/{sid}/messages').json()['messages']
    parent = next(m for m in messages if m['role'] == 'assistant' and m['text'].strip())
    body = {'session_id': sid, 'message_id': parent['id'], 'input': 'e a de março?'}

    assert post(human_browser, '/bots/vendas/threads', body, None).status == 403                      # CSRF first
    assert post(human_browser, '/bots/vendas/threads', {**body, 'quote': 'texto falso'}).status == 400  # no quote from the browser
    assert post(human_browser, '/bots/vendas/threads', {**body, 'message_id': 10 ** 9}).status == 404  # a message Hermes does not hold
    rows = len(audit_rows('thread.create'))
    started = post(human_browser, '/bots/vendas/threads', body)
    assert started.status == 200, started.text()
    child = opened_session(started.text())
    assert child and child != sid
    assert len(audit_rows('thread.create')) == rows + 2

    first = next(m for m in get(human_browser, f'/bots/vendas/sessions/{child}/messages').json()['messages'] if m['role'] == 'user')
    assert first['text'].startswith('[Respondendo à mensagem de vendas') and first['text'].count('«') == 1 and first['text'].count('»') == 1
    assert 'e a de março?' in first['text'] and 'texto falso' not in first['text']

    listed = {s['id']: s for s in get(human_browser, '/bots/vendas/sessions?limit=100').json()['sessions']}
    assert sid in listed and listed[sid]['ended_at'] is None        # the parent is untouched (a fork would have ended it)
    assert child not in listed                                      # a thread opens from its message
    body = get(human_browser, f'/bots/vendas/sessions/{sid}/threads').json()
    assert body['truncated'] is False
    found = body['threads']
    mine = next(t for t in found if t['child_session'] == child)
    assert mine['message_id'] == parent['id'] and mine['replies'] >= 2 and mine['last_at']
