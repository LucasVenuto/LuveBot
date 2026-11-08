"""Contract v0.7 V1 (Radio and the Bot's voice status) against the REAL Hermes: its audio handlers, its `type: command` STT/TTS
providers (tests/harness/fake_voice.py, one label per profile, wired in entrypoint.py) and its GPT-Live status. The unit suite
(tests/unit/backend/test_voice.py) holds the mutations of backend/voice.py; here the routes, the gate, the audit and the secrets
are checked end to end. 401 without a session: test_plugin.py walks every route of the real router."""
import http.client
import time
import io
import secrets
import sqlite3
import sys
from urllib.parse import urlparse
import wave

import pytest

from support import DASHBOARD, credentials, plugin
from test_bots import DB, csrf, error_of, post
from test_approvals import MARK, ask_run, clean_mark, list_approvals, resolve, settle, wait_pending  # noqa: F401  (clean_mark: autouse)
from test_hook import session, wait_for
from test_pages import off_loop
from test_plugin import PREFIX, routes

REDACTABLE = 'sk-proj-' + secrets.token_hex(20)        # a key shape Hermes's redactor knows (agent/redact.py)


def recording(text):
    """A real WAV whose samples carry the marker fake_voice.py reads."""
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        payload = text.encode() + b'\0'
        w.writeframes(payload + b'\0' * (len(payload) % 2) + b'\0' * 3200)
    return buffer.getvalue()


def upload(browser, bot, data, mime='audio/wav', token='valid'):
    headers = {'Content-Type': mime}
    if token is not None:
        headers['X-LuveBot-CSRF'] = csrf(browser) if token == 'valid' else token
    return browser.request.post(DASHBOARD + PREFIX + f'/bots/{bot}/voice/transcribe', data=data, headers=headers)


def speak(browser, bot, text, token='valid'):
    headers = {} if token is None else {'X-LuveBot-CSRF': csrf(browser) if token == 'valid' else token}
    return browser.request.post(DASHBOARD + PREFIX + f'/bots/{bot}/voice/speak', data={'text': text}, headers=headers)


def no_secret(raw):
    values = credentials()
    for value in (values['api_key'], values['vendas_api_key'], values['extra_canary'], REDACTABLE):
        assert value.encode() not in raw, 'secret canary in a voice answer (value withheld)'


def voice_rows():
    conn = sqlite3.connect(DB)
    try:
        return conn.execute("SELECT action, outcome, detail, target, bot FROM audit_log WHERE action LIKE 'voice.%' ORDER BY id").fetchall()
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def db_exists(human_browser):
    assert human_browser.request.get(DASHBOARD + PREFIX + '/bots').status == 200


@pytest.fixture
def paused():
    """Bot `vendas` paused by its budget for the test, then resumed by a person."""
    plugin()
    from luvebot_backend.audit import AuditLog
    from luvebot_backend.budget import Budget
    budget = Budget(DB, audit=AuditLog(DB))
    budget.on_breach('vendas')
    yield
    budget.resume('vendas', actor='basic:harness-human', human=True)


def test_the_nine_voice_routes_are_in_the_real_router():
    found = {(m, p) for m, p in routes() if '/voice' in p}
    assert found == {('GET', PREFIX + '/bots/{bot}/voice'), ('POST', PREFIX + '/bots/{bot}/voice/transcribe'),
                     ('POST', PREFIX + '/bots/{bot}/voice/speak'), ('POST', PREFIX + '/bots/{bot}/voice/calls'),
                     ('POST', PREFIX + '/bots/{bot}/voice/calls/{call_id}/heartbeat'),
                     ('POST', PREFIX + '/bots/{bot}/voice/calls/{call_id}/delegations'),
                     ('POST', PREFIX + '/bots/{bot}/voice/calls/{call_id}/end'), ('PUT', PREFIX + '/bots/{bot}/voice/client-direct'),
                     ('PUT', PREFIX + '/bots/{bot}/voice/language')}


def test_mutations_without_csrf_are_403_and_reach_nothing(human_browser):
    before = voice_rows()
    for token in (None, 'wrong'):
        for response in (upload(human_browser, 'vendas', recording('SAY:oi'), token=token), speak(human_browser, 'vendas', 'oi', token=token)):
            assert response.status == 403 and error_of(response)['code'] == 'csrf_required'
    assert voice_rows() == before


def test_transcribe_refuses_before_reading_a_5_mib_body(human_browser):
    """CSRF and the length are checked on the headers: the answer comes while the body has not been sent at all."""
    cookies = {c['name']: c['value'] for c in human_browser.cookies()}
    url = urlparse(DASHBOARD)
    for headers, status in (({}, 403), ({'X-LuveBot-CSRF': csrf(human_browser)}, None)):
        conn = http.client.HTTPConnection(url.hostname, url.port, timeout=10)
        conn.putrequest('POST', PREFIX + '/bots/vendas/voice/transcribe')
        for name, value in {'Content-Type': 'audio/webm', 'Content-Length': str(5 * 1024 * 1024 + 1),
                            'Cookie': '; '.join(f'{k}={v}' for k, v in cookies.items()), **headers}.items():
            conn.putheader(name, value)
        conn.endheaders()                                                  # no body follows
        answer = conn.getresponse()
        assert answer.status == (status or 413), answer.status
        conn.close()


def test_radio_goes_through_the_bots_own_providers_and_is_audited(human_browser):
    before = len(voice_rows())
    for bot in ('vendas', 'default'):
        got = upload(human_browser, bot, recording('SAY:bom dia'))
        assert got.status == 200, got.text()
        answer = got.json()
        timing = answer.pop('timing')                                      # VL-1: how long the STT took and the size sent, never text
        assert answer == {'text': f'{bot}:bom dia', 'provider': 'fakestt'}
        assert set(timing) == {'server_ms', 'bytes'} and type(timing['server_ms']) is int and timing['server_ms'] >= 0
        assert timing['bytes'] == len(recording('SAY:bom dia'))
        audio = speak(human_browser, bot, 'Olá, tudo certo.')
        assert audio.status == 200 and audio.body() == f'ID3{bot}:Olá, tudo certo.'.encode()
        assert audio.headers['content-type'] == 'audio/mpeg' and audio.headers['x-content-type-options'] == 'nosniff'
        assert audio.headers['content-disposition'].startswith('attachment') and 'no-store' in audio.headers['cache-control']
    rows = voice_rows()[before:]
    assert [(a, o, d, t, b) for a, o, d, t, b in rows] == [
        (action, 'ok', detail, bot, bot) for bot in ('vendas', 'default')
        for action in ('voice.transcribe', 'voice.transcribe.timing', 'voice.speak') for detail in ('intent', 'result')]


def test_voice_no_secret(human_browser):
    """Invariant 1: a provider error carrying a key, a transcript and a text to speak carrying one, and the status: no canary."""
    key = credentials()['vendas_api_key']                                 # vendas's OPENAI_API_KEY in the harness
    failed = upload(human_browser, 'vendas', recording('FAIL:invalid key ' + key))
    assert failed.status == 502 and error_of(failed)['code'] == 'voice_unavailable'
    assert error_of(failed).get('details') == {'step': 'transcribe'} and 'invalid key' not in failed.text()
    no_secret(failed.body())
    heard = upload(human_browser, 'vendas', recording('SAY:a chave ' + REDACTABLE))
    assert heard.status == 200
    no_secret(heard.body())
    spoken = speak(human_browser, 'vendas', 'Sua chave é ' + REDACTABLE)
    assert spoken.status == 200 and spoken.body().startswith('ID3vendas:Sua chave é'.encode())
    no_secret(spoken.body())                                               # what reached the TTS provider was already redacted
    for path in ('/bots/vendas/voice', '/bots/default/voice', '/health'):
        no_secret(human_browser.request.get(DASHBOARD + PREFIX + path).body())


def test_bad_uploads_are_refused_without_a_provider(human_browser):
    before = voice_rows()
    assert upload(human_browser, 'vendas', b'<html>', mime='text/html').status == 415
    assert upload(human_browser, 'vendas', recording('SAY:x'), mime='video/webm').status == 415
    too_big = upload(human_browser, 'vendas', b'\0' * (5 * 1024 * 1024 + 1), mime='audio/webm')
    assert too_big.status == 413 and error_of(too_big)['code'] == 'too_large'
    assert speak(human_browser, 'vendas', 'a' * 4001).status == 400
    assert speak(human_browser, 'vendas', '   ').status == 400
    assert upload(human_browser, 'nope-nope', recording('SAY:x')).status == 404
    assert voice_rows() == before


def test_voice_cap_refuses_both_radio_routes(human_browser, paused):
    """Invariant 7: a paused Bot gets neither a transcription nor speech, and nothing reaches a provider (no voice row)."""
    before = voice_rows()
    for response in (upload(human_browser, 'vendas', recording('SAY:aprova')), speak(human_browser, 'vendas', 'oi')):
        assert response.status == 409 and error_of(response)['code'] == 'bot_paused'
    assert voice_rows() == before
    view = human_browser.request.get(DASHBOARD + PREFIX + '/bots/vendas/voice').json()
    assert view['call']['available'] is False and view['call']['reason'] == 'bot_paused'


def test_voice_status_honest(human_browser, monkeypatch):
    """Invariants 8/9: the real status, then the same code with no OpenAI key and with a Hermes without audio handlers."""
    view = human_browser.request.get(DASHBOARD + PREFIX + '/bots/vendas/voice').json()
    settings = view.pop('settings')                                        # VL-1: the Bot's STT/TTS settings as Hermes reads them, only the listed keys
    assert view == {'radio': {'available': True, 'reason': None},
                    'call': {'available': True, 'reason': None, 'cents_per_minute': 5, 'max_seconds': 900, 'max_delegations': 6},
                    'client_direct': True}
    assert set(settings) == {'stt', 'tts', 'language'} and set(settings['stt']) == {'provider', 'language'}
    assert set(settings['tts']) == {'provider', 'voice'} and settings['language'] in ('pt', 'en', 'auto', 'other')
    features = human_browser.request.get(DASHBOARD + PREFIX + '/health').json()['features']
    assert features['voice_radio'] == 'ok' and features['voice_call'] == 'ok'
    plugin()
    from luvebot_backend import voice
    import tools.tool_backend_helpers as helpers
    monkeypatch.setattr(helpers, 'resolve_openai_audio_api_key', lambda: '')
    nokey = off_loop(voice.status, voice.HermesAudio, 'vendas', lambda: None)
    assert nokey['call']['available'] is False and nokey['call']['reason'] == 'no_openai_key' and nokey['radio']['available']
    monkeypatch.setitem(sys.modules, 'hermes_cli.web_routers.audio', None)   # an older Hermes: the import fails
    old = off_loop(voice.status, voice.HermesAudio, 'vendas', lambda: None)
    assert old['radio'] == {'available': False, 'reason': 'hermes_audio_missing'} and old['call']['reason'] == 'hermes_audio_missing'
    assert voice.features(voice.HermesAudio) == {'voice_radio': 'unavailable', 'voice_call': 'unavailable'}



# ---- Call (3.2-3.4) against the fake GPT-Live of fake_openai.py (voice.gpt_live.base_url in the harness config) -----------------
OFFER = 'v=0 offer\r\n'


def call_post(browser, bot, tail, body, token='valid'):
    return post(browser, f'/bots/{bot}/voice/calls{tail}', body, token)


def start_call(browser, bot='vendas', sdp=OFFER, sid=None):
    return call_post(browser, bot, '', {'sdp': sdp, 'session_id': sid})


def end(browser, call_id, bot='vendas', vendor=None, reason='hangup'):
    return call_post(browser, bot, f'/{call_id}/end', {'vendor_seconds': vendor, 'reason': reason})


def call_row(call_id):
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    try:
        return dict(conn.execute('SELECT * FROM voice_calls WHERE id=?', (call_id,)).fetchone())
    finally:
        conn.close()


@pytest.fixture
def no_open_calls():
    """Each call test starts and ends with no open call (one per Bot, three in all)."""
    def close_all():
        conn = sqlite3.connect(DB)
        try:
            ids = [r[0] for r in conn.execute("SELECT id FROM voice_calls WHERE status IN ('starting','open')")]
        except sqlite3.OperationalError:  # no call yet: the table is made by the first one
            ids = []
        finally:
            conn.close()
        return ids
    assert close_all() == []
    yield
    assert close_all() == [], 'a test left a call open'


def test_call_mutations_without_csrf_are_403(human_browser):
    for tail, body in (('', {'sdp': OFFER, 'session_id': None}), ('/call_x/heartbeat', {}),
                       ('/call_x/delegations', {'delegation_id': 'd1', 'context': 'x'}), ('/call_x/end', {'reason': 'hangup'})):
        for token in (None, 'wrong'):
            response = call_post(human_browser, 'vendas', tail, body, token)
            assert response.status == 403 and error_of(response)['code'] == 'csrf_required', (tail, response.status)


def test_a_call_starts_delegates_a_turn_ends_and_is_billed_on_the_voz_line(human_browser, no_open_calls):
    sid = session(human_browser, 'vendas')
    started = start_call(human_browser, sid=sid)
    assert started.status == 201, started.text()
    answer = started.json()
    assert set(answer) == {'call_id', 'sdp', 'max_seconds', 'max_delegations', 'heartbeat_seconds'}
    assert answer['sdp'] == 'v=0 fake answer history=False\r\n'          # byte-exact through Hermes, no LuveBot history (A-99)
    assert 'sess_fake_live' not in started.text()                          # the vendor's session id stays on the server
    call_id = answer['call_id']
    again = start_call(human_browser, sid=sid)
    assert again.status == 409 and error_of(again)['code'] == 'call_in_progress'
    beat = call_post(human_browser, 'vendas', f'/{call_id}/heartbeat', {})
    assert beat.status == 200 and beat.json()['stop'] is False and 0 < beat.json()['remaining_seconds'] <= 900
    before = len(audit_rows_of('chat.send'))
    turn = call_post(human_browser, 'vendas', f'/{call_id}/delegations', {'delegation_id': 'd1', 'context': 'qual a agenda de amanhã?'})
    assert turn.status == 200, turn.text()
    assert len(audit_rows_of('chat.send')) == before + 2                     # the delegation went as a NORMAL turn of the conversation
    receipt = end(human_browser, call_id, vendor=12)
    assert receipt.status == 200 and receipt.json() == {'seconds': receipt.json()['seconds'], 'delegations': 1, 'cents': 5}
    assert end(human_browser, call_id, vendor=999).json() == receipt.json()   # idempotent
    row = call_row(call_id)
    assert row['status'] == 'ended' and row['committed'] == 1 and row['vendor_session'] == 'sess_fake_live'
    assert set(row) == {'id', 'bot', 'session_id', 'vendor_session', 'reservation', 'started_at', 'last_beat', 'ended_at', 'end_reason',
                        'delegations', 'vendor_seconds', 'billed_cents', 'committed', 'status'}   # times, counts, cents: no transcript (A-98)
    costs = human_browser.request.get(DASHBOARD + PREFIX + '/costs?period=month&group=bot').json()
    assert costs['totals']['voice_cents'] >= 5 and next(g for g in costs['groups'] if g['key'] == 'vendas')['voice_cents'] >= 5
    actions = [(a, d) for a, _o, d, _t, b in voice_rows() if a.startswith('voice.call') and b == 'vendas'][-6:]
    assert actions == [(a, d) for a in ('voice.call.start', 'voice.call.delegation', 'voice.call.end') for d in ('intent', 'result')]


def audit_rows_of(action):
    conn = sqlite3.connect(DB)
    try:
        return conn.execute('SELECT id FROM audit_log WHERE action=?', (action,)).fetchall()
    finally:
        conn.close()


def test_call_no_secret_and_a_failed_start_frees_the_slot(human_browser, no_open_calls):
    """Invariant 1: the fake vendor answers 401 with the key it got, masked as OpenAI does; nothing of that answer leaves."""
    failed = start_call(human_browser, sdp='v=0 FAIL\r\n')
    assert failed.status == 502 and error_of(failed)['code'] == 'voice_unavailable' and error_of(failed)['details'] == {'step': 'call'}
    no_secret(failed.body())
    key = credentials()['vendas_api_key']
    assert 'Incorrect API key' not in failed.text() and key[:8] not in failed.text() and key[-4:] + '.' not in failed.text()
    ok = start_call(human_browser)
    assert ok.status == 201
    assert end(human_browser, ok.json()['call_id']).status == 200


def test_voice_cap_on_calls(human_browser, no_open_calls):
    """Invariant 7: a reservation that would cross the cap refuses the call; a breach mid-call makes the heartbeat hang up and
    refuses delegations; the call still ends and is billed."""
    plugin()
    from luvebot_backend.audit import AuditLog
    from luvebot_backend.budget import Budget
    budget = Budget(DB, audit=AuditLog(DB))
    budget.set_limit('bot', 'vendas', 'month', 80, actor='basic:harness-human')
    try:
        refused = start_call(human_browser)
        assert refused.status == 409 and error_of(refused)['code'] == 'budget_exceeded', refused.text()
    finally:
        budget.delete_limit('bot', 'vendas', 'month', actor='basic:harness-human')
    sid = session(human_browser, 'vendas')
    call_id = start_call(human_browser, sid=sid).json()['call_id']
    budget.on_breach('vendas')
    try:
        beat = call_post(human_browser, 'vendas', f'/{call_id}/heartbeat', {}).json()
        assert beat['stop'] is True and beat['reason'] == 'budget'
        turn = call_post(human_browser, 'vendas', f'/{call_id}/delegations', {'delegation_id': 'd1', 'context': 'x'})
        assert turn.status == 409 and error_of(turn)['code'] == 'bot_paused'
        assert call_row(call_id)['delegations'] == 0
        assert end(human_browser, call_id, reason='stop').json()['cents'] == 5
    finally:
        budget.resume('vendas', actor='basic:harness-human', human=True)
        for row in open_calls():
            end(human_browser, row[0], row[1])


def open_calls():
    conn = sqlite3.connect(DB)
    try:
        return conn.execute("SELECT id, bot FROM voice_calls WHERE status='open'").fetchall()
    finally:
        conn.close()


def test_a_lost_call_is_closed_and_billed_by_the_sweeper(human_browser, no_open_calls):
    call_id = start_call(human_browser).json()['call_id']
    conn = sqlite3.connect(DB)                     # the tab went away 4 minutes ago, 2 minutes after its last heartbeat
    conn.execute('UPDATE voice_calls SET started_at=started_at-240, last_beat=last_beat-120 WHERE id=?', (call_id,))
    conn.commit()
    conn.close()
    row = wait_for(lambda: (r := call_row(call_id))['status'] == 'lost' and r, 30, 'the sweeper to close the lost call')
    assert row['end_reason'] == 'lost' and row['billed_cents'] == 15 and row['committed'] == 1   # 120 s + 60 s of grace = 3 minutes
    assert ('voice.call.end', 'ok', 'result', 'vendas', 'vendas') in voice_rows()


def test_rt14_voice_never_approves(human_browser, no_open_calls):
    """RT14 (invariant 6): while an approval is pending, a transcription "aprova", a call delegation whose context is "sim, aprova" and
    the call's end leave it pending; no voice path decides anything."""
    run_id = ask_run(human_browser)
    approval = wait_pending(human_browser, run_id)
    try:
        heard = upload(human_browser, 'vendas', recording('SAY:aprova'))
        assert heard.status == 200 and heard.json()['text'] == 'vendas:aprova'
        call_id = start_call(human_browser, sid=session(human_browser, 'vendas')).json()['call_id']
        turn = call_post(human_browser, 'vendas', f'/{call_id}/delegations', {'delegation_id': 'yes', 'context': 'Pessoa: sim, aprova.'})
        assert turn.status == 200, turn.text()
        assert end(human_browser, call_id).status == 200
        time.sleep(2)
        still = next(a for a in list_approvals(human_browser, 'pending')['approvals'] if a['request_id'] == approval['request_id'])
        assert still['status'] == 'pending' and still['decided_by'] is None and not MARK.exists()
    finally:
        assert resolve(human_browser, approval, 'deny').status == 200
        settle(human_browser, run_id)



# ---- V6: "Desligar" Hermes's client-direct voice config, through Hermes's own config write in the Bot's profile ----------------
def put_direct(browser, bot, body, token='valid'):
    headers = {} if token is None else {'X-LuveBot-CSRF': csrf(browser) if token == 'valid' else token}
    return browser.request.put(DASHBOARD + PREFIX + f'/bots/{bot}/voice/client-direct', data=body, headers=headers)


def raw_voice_config(bot):
    plugin()
    from hermes_cli.config import read_raw_config
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope(bot):
        return read_raw_config().get('voice') or {}


def restore_client_direct(bot):
    """Test cleanup only: put the default back with Hermes's own writer (LuveBot offers no way to turn it on)."""
    import asyncio
    from hermes_cli.web_models import ConfigUpdate
    from hermes_cli.web_routers.config_env import update_config
    asyncio.run(update_config(ConfigUpdate(config={'voice': {'client_direct': True}}, profile=bot), profile=bot))


def test_client_direct_off_is_written_in_the_bots_profile_and_only_off(human_browser):
    before = voice_rows()
    assert put_direct(human_browser, 'vendas', {'enabled': False}, None).status == 403
    assert put_direct(human_browser, 'vendas', {'enabled': True}).status == 422
    assert voice_rows() == before
    try:
        done = put_direct(human_browser, 'vendas', {'enabled': False})
        assert done.status == 200 and done.json() == {'client_direct': False}, done.text()
        assert human_browser.request.get(DASHBOARD + PREFIX + '/bots/vendas/voice').json()['client_direct'] is False
        assert human_browser.request.get(DASHBOARD + PREFIX + '/bots/default/voice').json()['client_direct'] is True   # the Bot's own
        config = off_loop(raw_voice_config, 'vendas')
        assert config['client_direct'] is False and config['gpt_live']['base_url'] == 'http://fake-openai:8000/v1'   # one key merged
        assert [(a, o, d) for a, o, d, _t, _b in voice_rows()[len(before):]] == [
            ('voice.client_direct.set', 'ok', 'intent'), ('voice.client_direct.set', 'ok', 'result')]
    finally:
        off_loop(restore_client_direct, 'vendas')
    assert human_browser.request.get(DASHBOARD + PREFIX + '/bots/vendas/voice').json()['client_direct'] is True
