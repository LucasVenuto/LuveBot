"""T2.9: the two SSE routes (contract section 6) against the REAL plugin, gateway and fake provider."""
import http.client
import json
import threading
import time
import uuid
from pathlib import Path

import pytest

from support import DASHBOARD, STATE, credentials, plugin
from test_bots import quiet, DB, audit_rows, error_of, post
from test_plugin import PREFIX, no_secret
from test_runs import APPROVAL, NORMAL, db_ready_and_clean_budget, get, new_run, run_count, wait_run  # noqa: F401

FRAMES = Path('/root/.hermes/plugins/luvebot/tests/contract/frames')
INDEX = json.loads((FRAMES / 'index.json').read_text())
CONTRACT_FIELDS = {(f['channel'], f['event']): f['fields'] for f in INDEX['frames']}
DROPPED = {('chat', 'run.started'): {'user_message'}, ('chat', 'run.completed'): {'messages'}, ('chat', 'run.cancelled'): {'messages'}}


def parse(text):
    frames = []
    for block in text.replace('\r\n', '\n').split('\n\n'):
        lines = [line for line in block.split('\n') if line and not line.startswith(':')]
        if not lines:
            continue
        got = {}
        for line in lines:
            field, _, value = line.partition(': ')
            got[field] = value
        assert set(got) == {'id', 'event', 'data'}, f'every frame needs id, event and data: {block!r}'
        frames.append((got['id'], got['event'], json.loads(got['data'])))
    return frames


def proxy():
    plugin()
    import luvebot_backend.sse_proxy as sse_proxy
    from agent.redact import redact_sensitive_text
    return sse_proxy, lambda text: redact_sensitive_text(text, force=True)


def read_contract(rel):
    sse_proxy, redact = proxy()
    reader, out = sse_proxy.SseReader(), None
    for line in (FRAMES / rel).read_text().split('\n'):
        out = reader.feed(line) or out
    return out


# ---------------------------------------------------------------- golden (6.3), pure
@pytest.mark.parametrize('rel', sorted(str(p.relative_to(FRAMES)) for p in FRAMES.glob('*/*.sse')))
def test_golden_every_recorded_frame_passes_6_3_exactly(rel):
    sse_proxy, redact = proxy()
    surface = rel.split('/')[0]
    event, data = read_contract(rel)
    out = sse_proxy.transform(surface, event, data, redact)
    assert out is not None, f'{rel} is on the allowlist'
    out_event, out_data = out
    dropped = DROPPED.get((surface, event), set())
    assert out_event == event
    assert out_data == {k: v for k, v in data.items() if k not in dropped}, 'only the 6.3 drops may change a real frame'
    assert dropped.isdisjoint(out_data)
    # Framing: id, event and data, and the JSON round-trips.
    raw = sse_proxy.encode(7, out_event, out_data).decode()
    assert raw.startswith('id: 7\nevent: ' + event + '\ndata: ') and raw.endswith('\n\n')
    assert dropped == set() or all(key in data for key in dropped), 'the recorded frame really had the field the golden drops'


def test_golden_planted_canary_is_masked_in_every_text_field_and_unknown_events_are_dropped():
    sse_proxy, redact = proxy()
    canary = 'sk-' + 'A1b2C3d4' * 5
    for surface, event, field in (('run', 'message.delta', 'delta'), ('run', 'reasoning.available', 'text'),
                                  ('run', 'tool.started', 'preview'), ('run', 'approval.request', 'command'),
                                  ('chat', 'assistant.completed', 'content'), ('chat', 'assistant.commentary', 'text'),
                                  ('chat', 'tool.started', 'preview')):
        out = sse_proxy.transform(surface, event, {field: f'x {canary} y', 'seq': 1}, redact)
        assert canary not in json.dumps(out), (surface, event, field)
    nested = sse_proxy.transform('chat', 'tool.started', {'args': {'command': f'echo {canary}', 'deep': [{'k': canary}]}}, redact)
    assert canary not in json.dumps(nested)
    assert sse_proxy.transform('run', 'something.new', {'seq': 1}, redact) is None
    assert sse_proxy.transform('run', 'assistant.delta', {'seq': 1}, redact) is None, 'chat names are not run names'
    assert sse_proxy.transform('chat', 'luvebot.error', {'seq': 1}, redact) is None, 'upstream cannot forge our events'
    assert sse_proxy.transform('run', 'subagent.start', {'seq': 1}, redact) is not None  # documented, unobserved


def test_golden_args_are_capped_at_4kb_and_flagged():
    sse_proxy, redact = proxy()
    small = sse_proxy.transform('chat', 'tool.started', {'args': {'command': 'ls'}}, redact)[1]
    assert small == {'args': {'command': 'ls'}}
    big = sse_proxy.transform('chat', 'tool.started', {'args': {'content': 'x' * 5000}}, redact)[1]
    assert big['args'] == {} and big['args_truncated'] is True


def test_parser_swallows_comments_and_keeps_run_framing_without_an_event_line():
    sse_proxy, _ = proxy()
    reader, got = sse_proxy.SseReader(), []
    for line in [': open', '', 'id: 0', 'data: {"event": "message.delta", "delta": "a", "seq": 0}', '', ': stream closed', '']:
        item = reader.feed(line)
        if item:
            got.append(item)
    assert got == [('message.delta', {'event': 'message.delta', 'delta': 'a', 'seq': 0})]


# ---------------------------------------------------------------- live, through the dashboard
def check_live(frames, surface, original_events, ids):
    first, last = frames[0], frames[-1]
    assert first[1] == 'luvebot.stream.open'
    assert first[2] == {'bot': 'vendas', 'surface': surface, 'api': '0', **ids}
    assert last[1] == 'luvebot.stream.close' and last[2] == {'reason': 'completed'}
    body = frames[1:-1]
    assert [f[1] for f in body] == original_events
    seqs = [f[2]['seq'] for f in body]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs), 'seq strictly increases'
    for frame_id, event, data in body:
        assert frame_id == str(data['seq'])
        # Golden against the real recording: same field names, minus exactly what 6.3 drops.
        assert set(data) == set(CONTRACT_FIELDS[(surface, event)]) - DROPPED.get((surface, event), set()), (surface, event)
    return body


def test_run_stream_through_the_dashboard_matches_the_recorded_frames(human_browser):
    sid, run = new_run(human_browser, NORMAL)
    response = get(human_browser, f'/bots/vendas/runs/{run["id"]}/events')
    assert response.status == 200 and response.headers['content-type'].startswith('text/event-stream')
    assert response.headers['x-luvebot-api'] == '0'
    body = check_live(parse(response.text()), 'run', INDEX['run_events'], {'run_id': run['id']})
    assert [f[2]['delta'] for f in body if f[1] == 'message.delta'] == ['Testing the local tool.', '\n\nHarness model response']
    assert body[-1][2]['output'] == 'Harness model response' and body[-1][2]['completed'] is True
    tool = next(f[2] for f in body if f[1] == 'tool.completed')
    assert tool['tool'] == 'terminal' and tool['error'] is False
    no_secret(response.body(), 'run stream')
    assert wait_run(human_browser, 'vendas', run['id'], {'completed'})['status'] == 'completed'


def test_chat_stream_through_the_dashboard_matches_the_recorded_frames(human_browser):
    session = post(human_browser, '/bots/vendas/sessions', {})
    sid = session.json()['session']['id']
    cid = 'cm-' + uuid.uuid4().hex
    before = len(audit_rows('chat.send'))
    response = post(human_browser, f'/bots/vendas/sessions/{sid}/chat/stream', {'input': NORMAL, 'client_message_id': cid})
    assert response.status == 200 and response.headers['content-type'].startswith('text/event-stream')
    frames = parse(response.text())
    body = check_live(frames, 'chat', INDEX['chat_events'], {'session_id': sid})
    started = next(f[2] for f in body if f[1] == 'run.started')
    completed = next(f[2] for f in body if f[1] == 'run.completed')
    assert 'user_message' not in started and 'messages' not in completed, '6.3: dropped before the browser'
    assert 'messages' in read_contract('chat/run.completed.sse')[1], 'the recording really carries what we drop'
    assert next(f[2] for f in body if f[1] == 'assistant.completed')['content'] == 'Harness model response'
    assert body[-1][1] == 'done'
    no_secret(response.body(), 'chat stream')
    assert NORMAL not in response.text(), 'the user message is not echoed back'
    assert [(r[1], r[2]) for r in audit_rows('chat.send')[before:]] == [('ok', 'intent'), ('ok', 'result')]
    assert NORMAL.encode() not in DB.read_bytes()
    # The chat surface only reveals its run in the frames: it is indexed so Parar and GET work.
    run_id = started['run_id']
    assert get(human_browser, f'/bots/vendas/runs/{run_id}').status == 200
    # A retry of the same message is refused on our side, no second turn.
    again = post(human_browser, f'/bots/vendas/sessions/{sid}/chat/stream', {'input': NORMAL, 'client_message_id': cid})
    assert again.status == 409 and error_of(again)['code'] == 'duplicate'


def test_another_bot_cannot_open_the_streams(human_browser):
    sid, run = new_run(human_browser, NORMAL)
    wait_run(human_browser, 'vendas', run['id'], {'completed'})
    other = get(human_browser, f'/bots/default/runs/{run["id"]}/events')
    assert other.status == 404 and error_of(other)['code'] == 'run_not_found'
    assert get(human_browser, '/bots/vendas/runs/run_never_started/events').status == 404
    chat = post(human_browser, f'/bots/default/sessions/{sid}/chat/stream', {'input': NORMAL})
    assert chat.status == 404 and error_of(chat)['code'] == 'session_not_found'
    for response in (other, chat):
        no_secret(response.body(), 'isolation error')


def test_chat_post_without_csrf_is_403_and_leaves_nothing(human_browser):
    sid = post(human_browser, '/bots/vendas/sessions', {}).json()['session']['id']
    quiet()
    rows, runs = len(audit_rows()), run_count()
    for token in (None, 'wrong'):
        response = post(human_browser, f'/bots/vendas/sessions/{sid}/chat/stream', {'input': NORMAL}, token)
        assert response.status == 403 and error_of(response)['code'] == 'csrf_required'
    assert len(audit_rows()) == rows and run_count() == runs


def test_chat_stream_validation_and_budget(human_browser):
    sid = post(human_browser, '/bots/vendas/sessions', {}).json()['session']['id']
    for body in ({}, {'input': ''}, {'input': NORMAL, 'client_message_id': 'short'}):
        assert post(human_browser, f'/bots/vendas/sessions/{sid}/chat/stream', body).status == 422, body
    assert post(human_browser, f'/bots/vendas/sessions/{sid}/chat/stream', {'input': 'x', 'extra': 1}).status == 400
    assert post(human_browser, '/bots/vendas/sessions/bad%20id/chat/stream', {'input': 'x'}).status == 404
    plugin()
    from luvebot_backend.audit import AuditLog
    from luvebot_backend.budget import Budget
    Budget(DB, audit=AuditLog(DB)).on_breach('vendas')
    refused = post(human_browser, f'/bots/vendas/sessions/{sid}/chat/stream', {'input': NORMAL})
    assert refused.status == 409 and error_of(refused)['code'] == 'bot_paused', 'invariant 7 also covers chat turns'


def upstream_connections():
    """Established TCP connections whose REMOTE end is the API Server port (the dashboard's side of each relay)."""
    count = 0
    for name in ('tcp', 'tcp6'):
        for line in Path('/proc/net/' + name).read_text().splitlines()[1:]:
            fields = line.split()
            if fields[3] == '01' and fields[2].endswith(':21C2'):
                count += 1
    return count


# ---------------------------------------------------------------- streaming behavior (not buffered, no starvation)
class RawStream(threading.Thread):
    """A real incremental reader with the human's cookies; playwright buffers whole bodies."""

    def __init__(self, browser, path):
        super().__init__(daemon=True)
        self.cookie = '; '.join(f"{c['name']}={c['value']}" for c in browser.cookies())
        self.path, self.frames, self.error = path, [], None
        self.first = threading.Event()
        self.conn = None

    def run(self):
        try:
            self.conn = http.client.HTTPConnection('127.0.0.1', 9119, timeout=60)
            self.conn.request('GET', PREFIX + self.path, headers={'Cookie': self.cookie})
            response = self.conn.getresponse()
            assert response.status == 200, response.status
            block = b''
            while True:
                line = response.readline()
                if not line:
                    return
                block += line
                if line.strip() == b'' and block.strip():
                    if not block.startswith(b':'):
                        self.frames.extend(parse(block.decode()))
                        self.first.set()
                    block = b''
        except Exception as error:  # noqa: BLE001 - surfaced through .error for the test
            self.error = error


def test_stream_is_incremental_does_not_starve_the_dashboard_and_a_dropped_client_does_not_stop_the_run(human_browser):
    sid, run = new_run(human_browser, APPROVAL)
    wait_run(human_browser, 'vendas', run['id'], {'waiting_for_approval'})
    baseline = upstream_connections()
    reader = RawStream(human_browser, f'/bots/vendas/runs/{run["id"]}/events')
    reader.start()
    assert reader.first.wait(15), 'first frame must arrive while the run is still open'
    assert upstream_connections() == baseline + 1, 'one upstream connection per open stream'
    assert reader.frames[0][1] == 'luvebot.stream.open'
    assert [f[1] for f in reader.frames if f[1] == 'run.cancelled'] == [], 'run is still open: nothing terminal yet'
    started = time.monotonic()
    assert human_browser.request.get(DASHBOARD + PREFIX + '/health').status == 200
    assert get(human_browser, '/bots').status == 200
    assert time.monotonic() - started < 10, 'other routes keep answering while a stream is open'
    # The client drops: the upstream is closed, the run is NOT stopped.
    reader.conn.sock.shutdown(2)
    reader.conn.close()
    deadline = time.monotonic() + 10
    while upstream_connections() != baseline and time.monotonic() < deadline:
        time.sleep(0.2)
    assert upstream_connections() == baseline, 'a dropped client must close the upstream connection'
    assert get(human_browser, f'/bots/vendas/runs/{run["id"]}').json()['run']['status'] == 'waiting_for_approval'
    # A second reader sees the run end when its own Bot stops it.
    second = RawStream(human_browser, f'/bots/vendas/runs/{run["id"]}/events')
    second.start()
    assert second.first.wait(15)
    assert post(human_browser, f'/bots/vendas/runs/{run["id"]}/stop', {}).status == 202
    second.join(30)
    assert not second.is_alive() and second.error is None
    events = [f[1] for f in second.frames]
    assert 'run.cancelled' in events and events[0] == 'luvebot.stream.open' and events[-1] == 'luvebot.stream.close'
    assert second.frames[-1][2] == {'reason': 'cancelled'}


def test_no_credential_canary_in_any_log_after_the_streams():
    values = credentials()
    for directory in (STATE / 'logs', Path('/root/.hermes/logs')):
        for file in directory.glob('*.log') if directory.is_dir() else ():
            content = file.read_bytes()
            for name in ('api_key', 'vendas_api_key', 'extra_canary', 'password', 'signing_key'):
                assert values[name].encode() not in content, f'{name} found in {file.name} (value withheld)'
