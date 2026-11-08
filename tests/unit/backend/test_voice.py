"""Contract v0.7 V1 (Radio, voice status): backend/voice.py against a stand-in for Hermes's audio handlers that reproduces what our
logic relies on (hermes_cli/web_routers/audio.py at f8489405: provider errors in HTTPException.detail, {transcript, provider},
{data_url, mime_type, provider}, the GPT-Live status with a human `reason`). The REAL Hermes runs in tests/invariants/test_voice.py.
Every invariant also runs against variants of voice.py with one defect each: each must go red."""
import base64
import importlib
import itertools
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import types

import pytest

import backend.voice as real

SRC = Path(real.__file__).parent
ROOT = SRC.parent
CANARY = 'sk-proj-CANARYvoice0123456789abcdefABCDEF'
_n = itertools.count()


def redact(text):
    return text.replace(CANARY, '***')


def without_timing(answer):
    """The answer of `transcribe` without `timing` (VL-1: how long Hermes took varies; its shape is proven in test_voice_language.py)."""
    return {key: value for key, value in answer.items() if key != 'timing'}


class FakeHermes:
    def __init__(self, tmp=None, *, routes=('transcribe', 'speak', 'live_status', 'live_session'), live=None, fail=None,
                 transcript='olá', provider='local', mime='audio/mpeg', audio=b'ID3fake'):
        self.tmp, self._routes, self.fail = tmp, set(routes), fail
        self.live = live if live is not None else {'ok': True, 'mode': 'chained', 'available': True, 'reason': None,
                                                   'model': 'gpt-live-1', 'voice': 'marin'}
        self.transcript, self.provider, self.mime, self.audio = transcript, provider, mime, audio
        self.calls, self.intents_seen = [], []

    def routes(self):
        return set(self._routes)

    def _seen(self, action):
        if self.tmp is not None:
            conn = sqlite3.connect(self.tmp / 'audit.db')
            self.intents_seen.append(conn.execute("SELECT COUNT(*) FROM audit_log WHERE action=? AND detail='intent'",
                                                  (action,)).fetchone()[0])
            conn.close()

    def transcribe(self, data, mime, bot):
        self.calls.append(('transcribe', bot, data, mime))
        self._seen('voice.transcribe')
        if self.fail:
            raise self.fail
        return {'ok': True, 'transcript': self.transcript, 'provider': self.provider}

    def speak(self, text, bot):
        self.calls.append(('speak', bot, text))
        self._seen('voice.speak')
        if self.fail:
            raise self.fail
        return {'ok': True, 'data_url': f'data:{self.mime};base64,' + base64.b64encode(self.audio).decode(),
                'mime_type': self.mime, 'provider': 'edge'}

    def live_status(self, bot):
        self.calls.append(('live_status', bot))
        if isinstance(self.live, Exception):
            raise self.live
        return self.live

    direct = True
    keeps = True

    def client_direct(self, bot):
        return self.direct

    def client_direct_off(self, bot):
        self.calls.append(('client_direct_off', bot))
        self._seen('voice.client_direct.set')
        if self.fail:
            raise self.fail
        if self.keeps:
            self.direct = False

    def live_session(self, sdp, bot):
        self.calls.append(('live_session', bot, sdp))
        self._seen('voice.call.start')
        if self.fail:
            raise self.fail
        return {'ok': True, 'session': {'id': 'sess_vendor_123'}, 'transport': {'type': 'webrtc', 'sdp': 'v=0 answer\r\n'}}

    @staticmethod
    def turn_note(context):
        return 'NOTE|' + context


class HTTPException(Exception):  # the shape of fastapi's: the provider's text in `detail`
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail
        super().__init__(detail)


def sibling(m, name):
    return importlib.import_module(m.__name__.rsplit('.', 1)[0] + '.' + name)


def audit_of(m, tmp):
    return sibling(m, 'audit').AuditLog(tmp / 'audit.db')


def plugin_error(m):
    return sibling(m, 'api_errors').PluginError


def refused(m, code, fn, *args):
    try:
        fn(*args)
    except plugin_error(m) as error:
        assert error.code == code, error.code
        return error
    raise AssertionError(f'{code} was not raised')


def ok(m, fn, *args):
    """A call the invariant expects to pass: a refusal is the invariant failing."""
    try:
        return fn(*args)
    except plugin_error(m) as error:
        raise AssertionError(f'unexpected refusal: {error.code}') from None


def open_gate():
    return None


def transcribe(m, tmp, hermes, data=b'\x1aE\xdf\xa3webm', gate=open_gate, audit=None):
    return m.transcribe(audit or audit_of(m, tmp), hermes, 'basic:ana', 'vendas', data, 'audio/webm', gate, redact, 'req_1')


def speak(m, tmp, hermes, text='Bom dia', gate=open_gate, audit=None):
    return m.speak(audit or audit_of(m, tmp), hermes, 'basic:ana', 'vendas', text, gate, redact, 'req_1')


def shown(error):
    return f'{error.code} {error.message} {error.extra}'


# ---- invariant 1: no secret, no Hermes detail, no vendor text ----------------------------------------------------------------
def inv_no_secret_in_any_answer(m, tmp):
    leaks = [HTTPException(400, f'OpenAI said 401: invalid key {CANARY}'), RuntimeError(f'GPT-Live failed (401): {CANARY}'),
             ValueError(CANARY)]
    for error in leaks:
        for call in (transcribe, speak):
            got = refused(m, 'voice_unavailable', call, m, tmp, FakeHermes(fail=error))
            assert got.status == 502 and CANARY not in shown(got) and 'OpenAI' not in shown(got) and 'GPT-Live' not in shown(got)
    out = transcribe(m, tmp, FakeHermes(transcript=f'minha chave é {CANARY}'))
    assert CANARY not in str(out) and out['text'] == 'minha chave é ***'
    out = transcribe(m, tmp, FakeHermes(provider=f'openai {CANARY}'))
    assert out['provider'] is None
    view = m.status(FakeHermes(live={'available': False, 'reason': f'no OpenAI API key {CANARY}'}), 'vendas', open_gate)
    assert CANARY not in str(view) and 'OpenAI' not in str(view) and view['call']['reason'] == 'no_openai_key'


def inv_speak_redacts_before_the_provider(m, tmp):
    hermes = FakeHermes()
    speak(m, tmp, hermes, f'A chave é {CANARY}, guarde.')
    assert hermes.calls == [('speak', 'vendas', 'A chave é ***, guarde.')]


# ---- invariant 4: Hermes's own handlers, with profile=<bot> ------------------------------------------------------------------
def fake_hermes_modules(monkeypatch, record):
    audio, models = types.ModuleType('hermes_cli.web_routers.audio'), types.ModuleType('hermes_cli.web_models')

    class Req:
        def __init__(self, **kw):
            self.__dict__.update(kw)
    models.AudioTranscriptionRequest = models.TTSSpeakRequest = models.VoiceLiveSessionRequest = models.ConfigUpdate = Req

    async def transcribe_audio_upload(payload, profile=None):
        record.append(('transcribe', profile, payload.data_url, payload.mime_type))
        return {'ok': True, 'transcript': 'oi', 'provider': 'local'}

    async def speak_text(payload, profile=None):
        record.append(('speak', profile, payload.text))
        return {'ok': True, 'data_url': 'data:audio/mpeg;base64,SUQz', 'mime_type': 'audio/mpeg', 'provider': 'edge'}

    async def get_voice_live_status(profile=None):
        record.append(('live_status', profile))
        return {'ok': True, 'mode': 'chained', 'available': True, 'reason': None}

    async def update_config(payload, profile=None):
        record.append(('update_config', profile, payload.profile, payload.config))
        return {'ok': True}

    async def create_voice_live_session(payload, profile=None):
        record.append(('live_session', profile, payload.sdp, payload.history))
        return {'ok': True, 'session': {'id': 'sess_1'}, 'transport': {'type': 'webrtc', 'sdp': 'answer'}}
    for fn in (transcribe_audio_upload, speak_text, get_voice_live_status, create_voice_live_session):
        setattr(audio, fn.__name__, fn)
    config_env = types.ModuleType('hermes_cli.web_routers.config_env')
    config_env.update_config = update_config
    routers, cli = types.ModuleType('hermes_cli.web_routers'), types.ModuleType('hermes_cli')
    routers.audio, routers.config_env, cli.web_routers, cli.web_models = audio, config_env, routers, models
    for name, mod in (('hermes_cli', cli), ('hermes_cli.web_routers', routers), ('hermes_cli.web_routers.audio', audio),
                      ('hermes_cli.web_routers.config_env', config_env), ('hermes_cli.web_models', models)):
        monkeypatch.setitem(sys.modules, name, mod)


def inv_official_handlers_with_the_bots_profile(m, tmp):
    record = []
    with pytest.MonkeyPatch.context() as mp:
        fake_hermes_modules(mp, record)
        adapter = m.HermesAudio
        assert adapter.routes() == {'transcribe', 'speak', 'live_status', 'live_session'}
        assert without_timing(transcribe(m, tmp, adapter, data=b'RIFFwav')) == {'text': 'oi', 'provider': 'local'}
        assert speak(m, tmp, adapter, 'Olá') == (b'ID3', 'audio/mpeg')
        assert m.status(adapter, 'vendas', open_gate)['call']['available'] is True
        assert adapter.live_session('v=0\r\n', 'vendas')['transport']['sdp'] == 'answer'
        adapter.client_direct_off('vendas')
    assert record == [('transcribe', 'vendas', 'data:audio/webm;base64,' + base64.b64encode(b'RIFFwav').decode(), 'audio/webm'),
                      ('speak', 'vendas', 'Olá'), ('live_status', 'vendas'),
                      ('live_session', 'vendas', 'v=0\r\n', None),                     # byte-exact SDP, no LuveBot history (A-99)
                      ('update_config', 'vendas', 'vendas', {'voice': {'client_direct': False}})]   # V6: one key, the Bot's profile


# ---- invariant 5: the intent row before the effect; audit down = no provider -------------------------------------------------
def inv_audited_first(m, tmp):
    hermes = FakeHermes(tmp)
    transcribe(m, tmp, hermes)
    speak(m, tmp, hermes)
    assert hermes.intents_seen == [1, 1]
    conn = sqlite3.connect(tmp / 'audit.db')
    rows = conn.execute("SELECT action, target, bot, outcome, detail FROM audit_log WHERE action LIKE 'voice.%' ORDER BY id").fetchall()
    conn.close()
    assert rows == [('voice.transcribe', 'vendas', 'vendas', 'ok', 'intent'), ('voice.transcribe', 'vendas', 'vendas', 'ok', 'result'),
                    ('voice.transcribe.timing', 'vendas', 'vendas', 'ok', 'intent'), ('voice.transcribe.timing', 'vendas', 'vendas', 'ok', 'result'),     # VL-1: after the effect, a row of its own
                    ('voice.speak', 'vendas', 'vendas', 'ok', 'intent'), ('voice.speak', 'vendas', 'vendas', 'ok', 'result')]
    audit_mod = sibling(m, 'audit')

    class Down:
        def act(self, *args, **kwargs):
            raise audit_mod.AuditUnavailable()
    hermes = FakeHermes()
    for call in (transcribe, speak):
        with pytest.raises(audit_mod.AuditUnavailable):
            call(m, tmp, hermes, audit=Down())
    assert hermes.calls == []


# ---- invariant 7: the start gate before any provider ------------------------------------------------------------------------
def inv_gate_before_any_provider(m, tmp):
    PluginError = plugin_error(m)

    def paused():
        raise PluginError('bot_paused', 'paused', 409)
    hermes = FakeHermes()
    refused(m, 'bot_paused', transcribe, m, tmp, hermes, b'webm', paused)
    refused(m, 'bot_paused', speak, m, tmp, hermes, 'oi', paused)
    assert hermes.calls == []
    view = m.status(FakeHermes(), 'vendas', lambda: 'budget')
    assert view['call'] == {**view['call'], 'available': False, 'reason': 'budget'}
    assert m.status(FakeHermes(), 'vendas', lambda: 'bot_paused')['call']['reason'] == 'bot_paused'


# ---- invariants 8/9: honest status -------------------------------------------------------------------------------------------
def inv_status_is_honest(m, tmp):
    ok = m.status(FakeHermes(), 'vendas', open_gate)
    assert ok == {'radio': {'available': True, 'reason': None},
                  'call': {'available': True, 'reason': None, 'cents_per_minute': 5, 'max_seconds': 900, 'max_delegations': 6},
                  'client_direct': True}
    nokey = m.status(FakeHermes(live={'ok': True, 'mode': 'gpt-live', 'available': False, 'reason': 'no OpenAI API key'}),
                     'vendas', open_gate)
    assert nokey['call']['available'] is False and nokey['call']['reason'] == 'no_openai_key' and nokey['radio']['available']
    for broken in (RuntimeError('boom'), 'not a dict'):
        view = m.status(FakeHermes(live=broken), 'vendas', open_gate)
        assert view['call']['available'] is False and view['call']['reason'] == 'hermes_audio_missing'
    old = FakeHermes(routes=())
    view = m.status(old, 'vendas', open_gate)
    assert view['radio'] == {'available': False, 'reason': 'hermes_audio_missing'}
    assert view['call']['available'] is False and view['call']['reason'] == 'hermes_audio_missing'
    assert m.features(old) == {'voice_radio': 'unavailable', 'voice_call': 'unavailable'}
    assert m.features(FakeHermes(routes=('transcribe', 'speak'))) == {'voice_radio': 'ok', 'voice_call': 'unavailable'}
    assert m.features(FakeHermes()) == {'voice_radio': 'ok', 'voice_call': 'ok'}
    view = m.status(FakeHermes(routes=('transcribe', 'speak', 'live_status')), 'vendas', open_gate)
    assert view['radio']['available'] and view['call']['reason'] == 'hermes_audio_missing'


# ---- limits and the shape of answers (A-102) ---------------------------------------------------------------------------------
def inv_limits_and_answers(m, tmp):
    for header in ('audio/webm', 'audio/webm;codecs=opus', 'AUDIO/OGG', 'audio/mp4', 'audio/mpeg', 'audio/wav'):
        assert m.upload_mime(header) == header.split(';')[0].lower()
    for header in (None, '', 'text/html', 'video/webm', 'audio/x-wav', 'image/svg+xml', 'application/octet-stream'):
        assert refused(m, 'unsupported_media', m.upload_mime, header).status == 415
    assert refused(m, 'length_required', m.upload_length, None).status == 411
    assert refused(m, 'length_required', m.upload_length, '12abc').status == 411
    assert refused(m, 'too_large', m.upload_length, str(5 * 1024 * 1024 + 1)).status == 413
    assert refused(m, 'bad_request', m.upload_length, '0').status == 400
    assert m.upload_length(str(5 * 1024 * 1024)) == 5 * 1024 * 1024
    hermes = FakeHermes()
    refused(m, 'too_large', transcribe, m, tmp, hermes, b'x' * (5 * 1024 * 1024 + 1))
    refused(m, 'bad_request', transcribe, m, tmp, hermes, b'')
    assert hermes.calls == []
    assert without_timing(transcribe(m, tmp, FakeHermes(transcript='  '))) == {'text': '', 'provider': 'local'}       # nothing heard: no turn
    assert len(transcribe(m, tmp, FakeHermes(transcript='a' * 20000))['text']) == 10000
    for body in ({}, {'text': ''}, {'text': '   '}, {'text': 5}, {'text': 'a' * 4001}, [], None):
        refused(m, 'bad_request', m.speak_text, body)
    assert m.speak_text({'text': 'a' * 4000}) == 'a' * 4000
    for mime in ('text/html', 'audio/flac', 'image/svg+xml'):
        refused(m, 'voice_unavailable', speak, m, tmp, FakeHermes(mime=mime))
    refused(m, 'voice_unavailable', speak, m, tmp, FakeHermes(audio=b''))
    assert speak(m, tmp, FakeHermes(mime='audio/ogg', audio=b'OggS')) == (b'OggS', 'audio/ogg')


# ---- Call (3.2-3.4) ---------------------------------------------------------------------------------------------------------
def sub(tmp, name):
    (tmp / name).mkdir()
    return tmp / name


class Rig:
    """A real Budget, AuditLog and Calls on one database; the call clock is ours, the Budget's is real (its heartbeat is fresh)."""

    def __init__(self, m, tmp, *, cap=None, hermes=None):
        self.m, self.t = m, [1000.0]
        pkg = m.__name__.rsplit('.', 1)[0]
        self.audit = sibling(m, 'audit').AuditLog(tmp / 'audit.db')
        self.budget = sibling(m, 'budget').Budget(tmp / 'audit.db', audit=self.audit)
        self.budget.heartbeat()
        if cap is not None:
            self.budget.set_limit('bot', 'vendas', 'month', cap, actor='basic:ana')
        self.calls = m.Calls(tmp / 'audit.db', clock=lambda: self.t[0])
        self.hermes = hermes or FakeHermes(tmp)
        self.db = tmp / 'audit.db'

    def refusal(self, decision):
        return plugin_error(self.m)(decision['reason'], 'refused', 409)

    def start(self, bot='vendas', gate=open_gate, refusal=None, session='sess-1'):
        return self.m.start_call(self.audit, self.budget, self.calls, self.hermes, 'basic:ana', bot, {'sdp': 'v=0 offer\r\n', 'session_id': session},
                                 gate, refusal or self.refusal, 'req_c')

    def beat(self, call_id, reason=None, bot='vendas'):
        return self.m.heartbeat(self.calls, bot, call_id, lambda: reason)

    def delegate(self, call_id, did='d1', context='marque reunião', gate=open_gate):
        return self.m.delegate(self.audit, self.calls, self.hermes, 'basic:ana', 'vendas', call_id, {'delegation_id': did, 'context': context},
                               gate, redact, 'req_d')

    def end(self, call_id, vendor=None, reason='hangup'):
        return self.m.end_call(self.audit, self.budget, self.calls, 'basic:ana', 'vendas', call_id, {'vendor_seconds': vendor, 'reason': reason}, 'req_e')

    def spend(self):
        conn = sqlite3.connect(self.db)
        try:
            return conn.execute('SELECT id, bot, cents FROM budget_spend ORDER BY rowid').fetchall()
        finally:
            conn.close()

    def rows(self, like='voice.call.%'):
        conn = sqlite3.connect(self.db)
        try:
            return conn.execute('SELECT action, actor, outcome, detail FROM audit_log WHERE action LIKE ? ORDER BY id', (like,)).fetchall()
        finally:
            conn.close()

    def call(self, call_id):
        return self.calls.get_any(call_id)


def inv_call_cap(m, tmp):
    """Invariant 7: the reservation of the call's maximum refuses a call that could cross the cap, before Hermes; minutes are billed
    5 cents per started minute on max(server, vendor); the heartbeat hangs up on a breach and at 900 s; a lost call is billed."""
    rig = Rig(m, tmp, cap=80)                                            # 75 reserved would cross 90% of 80
    refused(m, 'budget_exceeded', rig.start)
    assert rig.hermes.calls == [] and rig.calls.claim('vendas', None)    # refused before Hermes, and the slot was given back
    rig = Rig(m, sub(tmp, 'b'))
    PluginError = plugin_error(m)

    def paused():
        raise PluginError('bot_paused', 'paused', 409)
    refused(m, 'bot_paused', rig.start, 'vendas', paused)
    assert rig.hermes.calls == []
    one = rig.start()['call_id']
    rig.t[0] += 61
    assert rig.end(one, vendor=30) == {'seconds': 61, 'delegations': 0, 'cents': 10}       # 2 started minutes, the server's count
    two = rig.start()['call_id']
    rig.t[0] += 50
    assert rig.end(two, vendor=200)['cents'] == 20                                          # the vendor's count when it says more
    assert [c for _i, _b, c in rig.spend()] == [10, 20]
    three = rig.start()['call_id']
    assert rig.beat(three) == {'stop': False, 'reason': None, 'remaining_seconds': 900}
    assert rig.beat(three, 'budget')['stop'] is True and rig.beat(three, 'budget')['reason'] == 'budget'
    refused(m, 'bot_paused', rig.delegate, three, 'd1', 'x', paused)
    rig.t[0] += 900
    assert rig.beat(three) == {'stop': True, 'reason': 'max_time', 'remaining_seconds': 0}
    four_bot = rig.end(three)['cents']
    assert four_bot == 75
    lost = rig.start()['call_id']
    rig.t[0] += 100
    rig.beat(lost)
    rig.t[0] += m.LOST_AFTER + 1
    assert m.sweep(rig.audit, rig.budget, rig.calls) == [lost]
    assert rig.call(lost)['status'] == 'lost' and rig.call(lost)['billed_cents'] == 15            # 100 s + 60 s of grace = 3 minutes
    assert rig.spend()[-1][2] == 15 and rig.rows()[-2:] == [('voice.call.end', 'system', 'ok', 'intent'), ('voice.call.end', 'system', 'ok', 'result')]
    assert m.sweep(rig.audit, rig.budget, rig.calls) == []


def inv_call_limits(m, tmp):
    """A-102: one open call per Bot, three in all; six delegations per CALL; none after 900 s."""
    rig = Rig(m, tmp)
    first = rig.start()['call_id']
    refused(m, 'call_in_progress', rig.start)
    rig.start('default')
    rig.start('suporte')
    refused(m, 'call_in_progress', rig.start, 'outro')
    for n in range(6):
        rig.delegate(first, f'd{n}')
    refused(m, 'delegation_limit', rig.delegate, first, 'd6')
    assert rig.call(first)['delegations'] == 6
    rig.end(first)
    second = rig.start()['call_id']
    ok(m, rig.delegate, second, 'e1')                                                       # counted per call, not per Bot
    rig.t[0] += 900
    refused(m, 'call_time_over', rig.delegate, second, 'e2')
    rig.end(second)
    refused(m, 'call_not_open', rig.delegate, second, 'e3')
    refused(m, 'call_not_found', rig.beat, second, None, 'default')                         # another Bot's call is not found


def inv_call_audited_first(m, tmp):
    """Invariant 5: start, delegation and end leave their intent row before the effect; audit down = no vendor, no count, no bill."""
    rig = Rig(m, tmp)
    call_id = rig.start()['call_id']
    assert rig.hermes.intents_seen == [1]
    rig.delegate(call_id)
    rig.t[0] += 10
    rig.end(call_id)
    assert rig.rows() == [(a, 'basic:ana', 'ok', d) for a in ('voice.call.start', 'voice.call.delegation', 'voice.call.end')
                          for d in ('intent', 'result')]
    audit_mod = sibling(m, 'audit')

    class Down:
        def act(self, *args, **kwargs):
            raise audit_mod.AuditUnavailable()
    rig2 = Rig(m, sub(tmp, 'down'))
    live = rig2.start()['call_id']
    rig2.audit = Down()
    with pytest.raises(audit_mod.AuditUnavailable):
        rig2.start('default')
    assert [c[0] for c in rig2.hermes.calls] == ['live_session']                              # only the first call reached Hermes
    with pytest.raises(audit_mod.AuditUnavailable):
        rig2.delegate(live)
    assert rig2.call(live)['delegations'] == 0
    with pytest.raises(audit_mod.AuditUnavailable):
        rig2.end(live)
    assert rig2.call(live)['status'] == 'open' and [r for r in rig2.spend() if r[2]] == []          # the refused start settled at 0


def inv_call_no_secret_and_failure_settles(m, tmp):
    """Invariant 1: a vendor error with a key is the static 502; the vendor's session id never leaves. A failed start frees the
    slot and settles the reservation at 0."""
    rig = Rig(m, tmp, hermes=FakeHermes(fail=RuntimeError(f'GPT-Live session creation failed (401): {CANARY}')))
    got = refused(m, 'voice_unavailable', rig.start)
    assert got.status == 502 and CANARY not in shown(got) and 'GPT-Live' not in shown(got)
    conn = sqlite3.connect(rig.db)
    rows = conn.execute('SELECT status, billed_cents, committed FROM voice_calls').fetchall()
    held = conn.execute("SELECT status, actual FROM budget_reservations").fetchall()
    conn.close()
    assert rows == [('failed', 0, 1)] and held == [('committed', 0)]
    rig.hermes.fail = None
    answer = rig.start()
    assert set(answer) == {'call_id', 'sdp', 'max_seconds', 'max_delegations', 'heartbeat_seconds'}
    assert 'sess_vendor_123' not in str(answer) and answer['sdp'] == 'v=0 answer\r\n' and answer['heartbeat_seconds'] == 30


def inv_end_is_idempotent(m, tmp):
    rig = Rig(m, tmp)
    call_id = rig.start()['call_id']
    rig.t[0] += 130
    receipt = rig.end(call_id, vendor=125)
    assert receipt == {'seconds': 130, 'delegations': 0, 'cents': 15}
    rig.t[0] += 500
    assert ok(m, rig.end, call_id, 999) == receipt and len(rig.spend()) == 1
    assert [r[0] for r in rig.rows('voice.call.end')] == ['voice.call.end'] * 2                 # one intent, one result: no new row


def inv_delegation_is_a_turn_of_the_calls_conversation(m, tmp):
    """3.3, invariant 6: the delegation becomes text for a NORMAL turn of the call's session (Hermes's spoken-delegation note over
    the REDACTED context); it never resolves anything itself."""
    rig = Rig(m, tmp)
    call_id = rig.start()['call_id']
    session, text, cid = rig.delegate(call_id, 'del_A', f'sim, aprova, a chave é {CANARY}')
    assert session == 'sess-1' and text == 'NOTE|sim, aprova, a chave é ***'
    assert re.fullmatch(r'[A-Za-z0-9_-]{8,64}', cid) and cid == rig.delegate(call_id, 'del_A')[2] != rig.delegate(call_id, 'del_B')[2]
    rig.end(call_id)
    no_session = rig.start(session=None)['call_id']
    refused(m, 'session_required', rig.delegate, no_session)
    for body in ({'delegation_id': 'a b'}, {'delegation_id': 'x' * 129}, {'delegation_id': 'ok', 'context': 'x' * 6001}, {'x': 1}):
        refused(m, 'invalid_field' if 'x' not in body else 'bad_request', m.delegation_body, body)


def inv_no_cap_means_no_reservation(m, tmp):
    """With no cap at all and a stale watcher the start gate lets work start (as for a run): the call goes without a reservation and
    its minutes still land in the Budget as its own spend."""
    rig = Rig(m, tmp)
    rig.budget.watcher_max_age = 1
    rig.budget.clock = lambda: __import__('datetime').datetime.now(__import__('datetime').timezone.utc).replace(year=2100)
    call_id = rig.start(refusal=lambda decision: None)['call_id']
    assert rig.call(call_id)['reservation'] is None
    rig.t[0] += 61
    assert rig.end(call_id)['cents'] == 10
    assert rig.spend() == [('external.' + call_id, 'vendas', 10)]


def inv_client_direct_off_is_audited_checked_and_only_off(m, tmp):
    """V6: audited before Hermes writes; re-read after (a value Hermes did not keep is a 502); only "off"; Hermes's text never leaves."""
    hermes = FakeHermes(tmp)
    assert m.client_direct_off(audit_of(m, tmp), hermes, 'basic:ana', 'vendas', 'req_v6') == {'client_direct': False}
    assert hermes.intents_seen == [1] and hermes.direct is False
    stubborn = FakeHermes()
    stubborn.keeps = False
    refused(m, 'hermes_error', m.client_direct_off, audit_of(m, tmp), stubborn, 'basic:ana', 'vendas', 'req_v6')
    got = refused(m, 'hermes_error', m.client_direct_off, audit_of(m, tmp), FakeHermes(fail=RuntimeError(f'yaml {CANARY}')),
                  'basic:ana', 'vendas', 'req_v6')
    assert CANARY not in shown(got)
    assert m.client_direct_body({'enabled': False}) is False
    for body in ({'enabled': True}, {'enabled': 0}, {'enabled': 'false'}, {}, {'enabled': False, 'x': 1}, None):
        refused(m, 'invalid_field' if isinstance(body, dict) and set(body) == {'enabled'} else 'bad_request', m.client_direct_body, body)


INVARIANTS = {n[4:]: f for n, f in globals().items() if n.startswith('inv_')}
MUTATIONS = [
    ('no_secret_in_any_answer', 'the provider error is forwarded',
     "        except Exception:\n            raise unavailable('transcribe') from None",
     "        except Exception as error:\n            raise PluginError('voice_unavailable', str(getattr(error, 'detail', error)), 502) from None"),
    ('no_secret_in_any_answer', 'the transcript is not redacted', "    text = redact((result.get('transcript') or '').strip())[:MAX_TEXT]",
     "    text = (result.get('transcript') or '').strip()[:MAX_TEXT]"),
    ('no_secret_in_any_answer', 'any provider name passes', "    return value if _PROVIDER.fullmatch(value) else None", "    return value or None"),
    ('speak_redacts_before_the_provider', 'the raw text is spoken', '    spoken = redact(text).strip()', '    spoken = text.strip()'),
    ('official_handlers_with_the_bots_profile', 'the profile is omitted',
     "return asyncio.run(transcribe_audio_upload(AudioTranscriptionRequest(data_url=url, mime_type=mime), profile=bot))",
     "return asyncio.run(transcribe_audio_upload(AudioTranscriptionRequest(data_url=url, mime_type=mime)))"),
    ('official_handlers_with_the_bots_profile', 'speak without the profile',
     "return asyncio.run(speak_text(TTSSpeakRequest(text=text), profile=bot))", "return asyncio.run(speak_text(TTSSpeakRequest(text=text)))"),
    ('audited_first', 'transcribe is not audited',
     "    result = audit.act(actor, 'voice.transcribe', bot, {'kind': 'ui', 'ref': ref}, effect, bot=bot,\n"
     "                       payload={'bytes': len(data), 'mime': mime})", '    result = effect()'),
    ('audited_first', 'speak calls Hermes before the audit',
     "    return audit.act(actor, 'voice.speak', bot, {'kind': 'ui', 'ref': ref}, effect, bot=bot, payload={'chars': len(spoken)})",
     "    done = effect()\n    return audit.act(actor, 'voice.speak', bot, {'kind': 'ui', 'ref': ref}, lambda: done, bot=bot, payload={'chars': len(spoken)})"),
    ('gate_before_any_provider', 'transcribe skips the start gate',
     "    gate()\n    took = []\n\n    def effect():\n        started = time.perf_counter()\n        try:\n            result = hermes.transcribe", "    took = []\n\n    def effect():\n        started = time.perf_counter()\n        try:\n            result = hermes.transcribe"),
    ('gate_before_any_provider', 'the gate is not in the call status', '        else:\n            reason = gate_reason()', '        else:\n            reason = None'),
    ('status_is_honest', 'available from config alone', "        elif live.get('available') is not True:", '        elif False:'),
    ('status_is_honest', 'radio without checking Hermes', "    radio_ok = {'transcribe', 'speak'} <= routes", '    radio_ok = True'),
    ('status_is_honest', 'a status error says available', "        except Exception:\n            live = None",
     "        except Exception:\n            live = {'available': True}"),
    ('limits_and_answers', 'any audio type is accepted', '    if mime not in UPLOAD_MIMES:', "    if not mime.startswith('audio/'):"),
    ('limits_and_answers', 'speak passes any type back', '        if mime not in SPEAK_MIMES or not isinstance(url, str)',
     '        if not isinstance(url, str)'),
    ('limits_and_answers', 'no cap on spoken text', '    if not isinstance(text, str) or not text.strip() or len(text) > MAX_SPEAK:',
     '    if not isinstance(text, str) or not text.strip():'),
    ('call_cap', 'the reservation is skipped', '            reservation = budget.reserve(bot, CALL_RESERVE)', '            reservation = None'),
    ('call_cap', 'vendor seconds only', '                seconds = max(now - row[\'started_at\'], vendor_seconds or 0)', '                seconds = vendor_seconds or 0'),
    ('call_cap', 'the sweeper bills 0', "                seconds = min(row['last_beat'] + LOST_GRACE, row['started_at'] + MAX_SECONDS) - row['started_at']",
     '                seconds = 0'),
    ('call_cap', 'the heartbeat ignores a breach', "    reason = 'max_time' if elapsed >= MAX_SECONDS else stop_reason()", "    reason = 'max_time' if elapsed >= MAX_SECONDS else None"),
    ('call_cap', 'whole minutes instead of started ones', '    return -(-max(0, int(math.ceil(seconds))) // 60) * CENTS_PER_MINUTE',
     '    return max(0, int(seconds)) // 60 * CENTS_PER_MINUTE'),
    ('call_cap', 'delegations skip the gate', "        raise PluginError('session_required', 'This call has no conversation to send tasks to.', 409)\n    gate()",
     "        raise PluginError('session_required', 'This call has no conversation to send tasks to.', 409)"),
    ('call_limits', 'delegations counted per Bot', "            if row['delegations'] >= MAX_DELEGATIONS:",
     "            if conn.execute('SELECT SUM(delegations) FROM voice_calls WHERE bot=?', (bot,)).fetchone()[0] >= MAX_DELEGATIONS:"),
    ('call_limits', 'no time limit on delegations', '            if now - row[\'started_at\'] >= MAX_SECONDS:', '            if False:'),
    ('call_limits', 'several calls per Bot', '            if mine or total >= MAX_OPEN_TOTAL:', '            if total >= MAX_OPEN_TOTAL:'),
    ('call_audited_first', 'Hermes before the start audit',
     "        answer, vendor = audit.act(actor, 'voice.call.start', bot, {'kind': 'ui', 'ref': ref}, effect, bot=bot,\n"
     "                                   payload={'call_id': call_id, 'session_id': session_id})",
     "        answer, vendor = effect()"),
    ('call_audited_first', 'the delegation is counted before the audit',
     "    audit.act(actor, 'voice.call.delegation', bot, {'kind': 'ui', 'ref': ref}, lambda: calls.take_delegation(bot, call_id), bot=bot,",
     "    calls.take_delegation(bot, call_id)\n    audit.act(actor, 'voice.call.delegation', bot, {'kind': 'ui', 'ref': ref}, lambda: None, bot=bot,"),
    ('call_no_secret_and_failure_settles', 'the vendor error is forwarded',
     "            except Exception:\n                raise unavailable('call') from None",
     "            except Exception as error:\n                raise PluginError('voice_unavailable', str(error), 502) from None"),
    ('call_no_secret_and_failure_settles', 'a failed start keeps the reservation', '            _quietly(budget.commit, reservation, 0)', '            pass'),
    ('call_no_secret_and_failure_settles', 'the vendor session id is returned',
     "    return {'call_id': call_id, 'sdp': answer,", "    return {'call_id': call_id, 'sdp': answer, 'session': vendor,"),
    ('end_is_idempotent', 'a second end bills again', "    if row['status'] in ('ended', 'lost'):\n        return _receipt(row)", '    if False:\n        pass'),
    ('delegation_is_a_turn_of_the_calls_conversation', 'the context is not redacted',
     "    return row['session_id'], hermes.turn_note(redact(context)),", "    return row['session_id'], hermes.turn_note(context),"),
    ('official_handlers_with_the_bots_profile', 'client_direct written without the profile',
     "return asyncio.run(update_config(ConfigUpdate(config={'voice': {'client_direct': False}}, profile=bot), profile=bot))",
     "return asyncio.run(update_config(ConfigUpdate(config={'voice': {'client_direct': False}}, profile=bot)))"),
    ('client_direct_off_is_audited_checked_and_only_off', 'Hermes writes before the audit',
     "    audit.act(actor, 'voice.client_direct.set', bot, {'kind': 'ui', 'ref': ref}, effect, bot=bot, payload={'from': before, 'to': False})",
     "    effect()\n    audit.act(actor, 'voice.client_direct.set', bot, {'kind': 'ui', 'ref': ref}, lambda: None, bot=bot, payload={'from': before, 'to': False})"),
    ('client_direct_off_is_audited_checked_and_only_off', 'success claimed without the re-read',
     "    if hermes.client_direct(bot) is not False:\n        raise PluginError('hermes_error', 'Hermes did not keep this setting.', 502)", '    pass'),
    ('client_direct_off_is_audited_checked_and_only_off', 'turning it on is accepted', "    if body['enabled'] is not False:", '    if False:'),
    ('client_direct_off_is_audited_checked_and_only_off', 'Hermes\'s error text is forwarded',
     "            raise PluginError('hermes_error', 'Hermes could not change this setting.', 502) from None",
     "            raise PluginError('hermes_error', str(error), 502) from None"),
    ('no_cap_means_no_reservation', 'spend without a reservation is lost', "    elif row['billed_cents']:\n        budget.record_spend(row['id'], row['bot'], row['billed_cents'])",
     "    elif False:\n        pass"),
]


def load_variant(tmp_path_factory, old, new):
    pkg = tmp_path_factory.mktemp('voicevariant') / f'vcv{next(_n)}'
    pkg.mkdir()
    for name in ('__init__.py', 'api_errors.py', 'audit.py', 'budget.py', 'dbfile.py', 'hermes_boundary.py', 'voice.py'):
        shutil.copy(SRC / name, pkg / name)
    text = (pkg / 'voice.py').read_text()
    assert text.count(old) == 1, old
    (pkg / 'voice.py').write_text(text.replace(old, new))
    sys.path.insert(0, str(pkg.parent))
    try:
        return importlib.import_module(f'{pkg.name}.voice')
    finally:
        sys.path.remove(str(pkg.parent))


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(tmp_path, name):
    INVARIANTS[name](real, tmp_path)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, tmp_path, invariant, label, old, new):
    variant = load_variant(tmp_path_factory, old, new)       # outside pytest.raises: a mutation that does not apply is an error
    with pytest.raises(AssertionError):
        INVARIANTS[invariant](variant, tmp_path)


def _code_files():
    for folder, pattern in (('backend', '*.py'), ('dashboard', 'plugin_api.py'), ('dashboard/src', '**/*.ts*')):
        yield from (ROOT / folder).glob(pattern)


def test_never_voice_config():
    """Invariant 1 (3.1, 4.3): Hermes's /api/audio/voice-config hands provider keys to the client; LuveBot never calls it."""
    found = [str(p.relative_to(ROOT)) for p in _code_files() if re.search(r'voice-config|resolve_client_voice_config', p.read_text())]
    assert found == []


def test_voice_code_never_touches_an_approval():
    """Invariant 6 (4.5): the voice module imports nothing that resolves approvals and names no approval route."""
    text = (SRC / 'voice.py').read_text()
    assert not re.search(r'approv|resolve_|/approval', text, re.I)


def test_costs_add_voice():
    """4.4: the "voz" line is inside the totals and each slot says how much of it is voice."""
    from backend import costs
    totals, groups = costs.add_voice({'spend_cents': 100, 'unpriced_sessions': 0},
                                     [{'key': 'vendas', 'spend_cents': 100, 'tokens': 5, 'sessions': 2}],
                                     [('vendas', 86400.0, 15), ('default', 86400.0, 5)], group='bot')
    assert totals == {'spend_cents': 120, 'unpriced_sessions': 0, 'voice_cents': 20}
    assert groups == [{'key': 'vendas', 'spend_cents': 115, 'tokens': 5, 'sessions': 2, 'voice_cents': 15},
                      {'key': 'default', 'spend_cents': 5, 'tokens': 0, 'sessions': 0, 'voice_cents': 5}]
    assert costs.add_voice({'spend_cents': 0, 'unpriced_sessions': 0}, [], [('vendas', 0.0, 5)], group='model')[1][0]['key'] == 'voz'
    assert costs.add_voice({'spend_cents': 0, 'unpriced_sessions': 0}, [], [], group='day') == ({'spend_cents': 0, 'unpriced_sessions': 0, 'voice_cents': 0}, [])
