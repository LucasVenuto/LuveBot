"""Red team (Lume, 31/10) of the voice language, contract docs/contracts/voice-language-reactions-v0.md sections 2 and 5 (VL-1 built by Brasa, VL-4 the attack), tests only.

THE BUILT PART IS NOT THERE YET, so every test runs TWICE through the fixture `leg`:
  `reference`  a small MODEL of section 2 written here (never a patch): it proves that each test is satisfiable and, with the mutants in the delivery notes, that it is not vacuous;
  `VL-1`       the real code: the route `PUT /bots/{bot}/voice/language` and the route `GET /bots/{bot}/voice` as written in dashboard/plugin_api.py (their source is compiled here, as the other route tests do) with the
               REAL backend/voice.py and a stand-in for the Hermes modules the contract names: `hermes_cli.web_routers.config_env.update_config` (the official write: a strict read, a deep merge under a lock, the profile
               of the call decides which file) and `hermes_cli.config.load_config` read under `hermes_cli.web_server_profiles._config_profile_scope(bot)`. Today it is a strict `xfail(raises=AssertionError)`: the day
               VL-1 lands it passes, the suite goes red on XPASS(strict), and whoever lands it removes the mark in `LEGS` (one line) and reads what fails; a seam this file stands in for and the code reads another way
               (the name of the reader, say) raises AssertionError('seam: ...') and is fixed in `Stand`, one place.
WHAT IS ATTACKED: a language outside pt|en|auto, or free text, becomes a write; any key written beyond `stt.language` and `tts.edge.voice`; the deep merge clobbering other keys (and a change somebody else makes while
we write); a voice the person chose overwritten; a write to another provider's voice; the default profile written instead of the Bot's; login, CSRF (before the body and before any effect) and loopback; the status
carrying a secret or a key outside the list; the audit (Bot, before, after, never text; the audit row BEFORE the write; a failed write never audited as done); a Bot that fails not touching another; `transcribe`'s
`timing` and its audit row carrying no text.
READINGS OF THE CONTRACT that the tests fix (answered by the Architect, A-281): 'a signed-in person' = the `_human` rule (loopback is `403 loopback_not_human`, as for rules and approvals, unless the installation trusts the
loopback); `auto` writes `stt.language = ''` and no voice; a value the person set in Hermes outside pt/en is `other` in `settings.language` and in the audit (the raw value stays in `settings.stt.language`, redacted and cut
at 200), never the raw value in the audit; the screen's 'apply to all' is a loop over the same PUT, one Bot at a time, one audit row each."""
import asyncio
import contextlib
import copy
import json
import re
import sys
import threading
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
import backend.audit as audit_module  # noqa: E402
import backend.identity as identity  # noqa: E402
import backend.voice as voice  # noqa: E402
from backend.api_errors import PluginError  # noqa: E402

API = (ROOT / 'dashboard' / 'plugin_api.py').read_text(encoding='utf-8')
ARIA, FRANCISCA = 'en-US-AriaNeural', 'pt-BR-FranciscaNeural'
SECRETS = {name: 'sk-' + chunk * 6 + 'Zq' for name, chunk in (('stt', 'Aa1b'), ('tts', 'Bb2c'), ('eleven', 'Cc3d'), ('voice', 'Dd4e'), ('hermes', 'Ee5f'))}
ENUM = ('pt', 'en', 'auto')
STATUS_ENUM = ENUM + ('other',)                                                             # A-281: the PUT takes three words, the status can also say `other`
RICH = {'model': {'default': 'claude-haiku-5-5'}, 'display': {'message_reactions': True, 'theme': 'dark'}, 'skills': {'a': 1},
        'stt': {'provider': 'local', 'enabled': True, 'local': {'model': 'base'}, 'openai': {'api_key': SECRETS['stt'], 'model': 'whisper-1'}},
        'tts': {'provider': 'edge', 'edge': {'voice': ARIA, 'rate': '+10%'}, 'openai': {'voice': 'alloy', 'api_key': SECRETS['tts']}, 'elevenlabs': {'voice_id': 'EL-ABC', 'api_key': SECRETS['eleven']}},
        'voice': {'client_direct': False, 'beep': True, 'token': SECRETS['voice']}}


def redact(text):
    return re.sub(r'sk-[A-Za-z0-9]{20,}', '***', text)


def deep_merge(base, patch):
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            deep_merge(base[key], value)
        else:
            base[key] = copy.deepcopy(value)


def leaves(value, prefix=()):
    if isinstance(value, dict) and value:
        return {k: v for key, item in value.items() for k, v in leaves(item, prefix + (key,)).items()}
    return {prefix: value}


def norm(cfg):
    """The leaves of a configuration where an empty language or voice is the same as none (the contract: empty reads as not set)."""
    flat = leaves(cfg)
    return {k: v for k, v in flat.items() if not (k in (('stt', 'language'), ('tts', 'edge', 'voice')) and v in ('', None))}


def changed(before, after):
    a, b = norm(before), norm(after)
    return {k for k in set(a) | set(b) if a.get(k, '<absent>') != b.get(k, '<absent>')}


class Answer:
    def __init__(self, status, body):
        self.status, self.body = status, body

    @property
    def code(self):
        return self.body.get('code') if isinstance(self.body, dict) else None


class Env:
    """The Hermes the contract names, with a memory: one configuration per profile, every write recorded, an audit log that is the real one."""
    def __init__(self, tmp_path, monkeypatch, cfg=None):
        self.initial = copy.deepcopy(cfg if cfg is not None else RICH)
        self.cfg = {name: copy.deepcopy(self.initial) for name in ('default', 'vendas', 'compras')}
        self.calls, self.scope, self.keeps, self.broken, self.before_apply = [], None, True, set(), None
        self.session, self.csrf_ok, self.bots = 'gated', True, {'vendas', 'compras'}
        self.audit = audit_module.AuditLog(tmp_path / 'audit.db')
        self.payloads, self.intents_at_write = [], []
        original = self.audit.act

        def spy(actor, action, target, origin, fn, *, bot=None, payload=None):
            self.payloads.append((action, bot, copy.deepcopy(payload)))
            return original(actor, action, target, origin, fn, bot=bot, payload=payload)
        self.audit.act = spy
        self._install(monkeypatch)

    def rows(self, action=None):
        import sqlite3
        conn = sqlite3.connect(self.audit.path)
        try:
            sql = 'SELECT action, outcome, detail, target, bot, digest FROM audit_log' + (' WHERE action = ?' if action else '') + ' ORDER BY id'
            return conn.execute(sql, (action,) if action else ()).fetchall()
        finally:
            conn.close()

    def _install(self, monkeypatch):
        env = self

        def module(name, **attrs):
            mod = types.ModuleType(name)
            mod.__dict__.update(attrs)
            monkeypatch.setitem(sys.modules, name, mod)
            return mod

        class ConfigUpdate:
            def __init__(self, config=None, profile=None):
                self.config, self.profile = config, profile

        class Request:
            def __init__(self, **kw):
                self.__dict__.update(kw)

        async def update_config(body, profile=None):
            env.calls.append(('update_config', body.profile, profile, copy.deepcopy(body.config)))
            env.intents_at_write.append(len(env.rows('voice.language')))
            if (profile or body.profile) in env.broken:
                raise RuntimeError('yaml error ' + SECRETS['hermes'])
            if not isinstance(body.config, dict):
                raise ValueError('strict read')
            if env.before_apply:
                env.before_apply(env)
            if env.keeps:
                deep_merge(env.cfg[profile or 'default'], body.config)         # the profile of the CALL decides the file: a call without it writes the default profile
            return {'ok': True}

        async def live_status(profile=None):
            return {'available': False, 'reason': 'no key'}

        async def not_used(*args, **kw):
            raise AssertionError('not used here')

        @contextlib.contextmanager
        def scope(bot):
            before, env.scope = env.scope, bot
            try:
                yield
            finally:
                env.scope = before

        def load_config():
            return copy.deepcopy(env.cfg[env.scope or 'default'])
        module('hermes_cli')
        module('hermes_cli.web_models', ConfigUpdate=ConfigUpdate, AudioTranscriptionRequest=Request, TTSSpeakRequest=Request, VoiceLiveSessionRequest=Request)
        module('hermes_cli.web_routers')
        module('hermes_cli.web_routers.audio', transcribe_audio_upload=not_used, speak_text=not_used, get_voice_live_status=live_status, create_voice_live_session=not_used)
        module('hermes_cli.web_routers.config_env', update_config=update_config)
        module('hermes_cli.web_server_profiles', _config_profile_scope=scope)
        module('hermes_cli.config', load_config=load_config)
        module('tools')
        module('tools.voice_client_config', _client_direct_enabled=lambda: (load_config().get('voice') or {}).get('client_direct'))


# ---- the route source, compiled -------------------------------------------------------------------------------------------------------------
class Reply:
    def __init__(self, content, status_code=200, headers=None):
        self.content, self.status_code = content, status_code


class Req:
    def __init__(self, headers=None, body=b''):
        self.headers, self._body = headers or {}, body

    async def body(self):
        return self._body


def block(start):
    found = re.search(re.escape(start) + r'.*?(?=\n\n\n@router|\n\n\ndef |\n\n\nasync def |\Z)', API, re.S)
    if found is None:
        raise AssertionError('VL-1 is not built: dashboard/plugin_api.py has no ' + start)
    return found.group(0)


class Stand:
    """The names a route of plugin_api.py may call, standing in for the plugin's own gates (their real behaviour is tested elsewhere; this is the contract's: 401, 403 csrf_required, 403 loopback_not_human, 404 bot_not_found)."""
    def __init__(self, env):
        self.env = env

    def namespace(self, captured):
        env = self.env

        def deco(path):
            return lambda fn: captured.setdefault(path, fn) or fn
        router = types.SimpleNamespace(get=deco, put=deco, post=deco, delete=deco)

        def _identity(request):
            if env.session is None:
                raise PluginError('unauthenticated', 'Sign in.', 401)
            return 'basic:ana', 'cred', env.session

        def _require_csrf(request, credential):
            if not env.csrf_ok:
                raise PluginError('csrf_required', 'A valid X-LuveBot-CSRF header is required for this action.', 403)

        def _human(request):
            actor, credential, mode = _identity(request)
            _require_csrf(request, credential)
            identity.require_person(mode, 'Needs a dashboard with a login.', loopback_ok=False)
            return types.SimpleNamespace(id=actor, kind='human')

        async def _existing(bot):
            if bot not in env.bots:
                raise PluginError('bot_not_found', 'Bot not found.', 404)
            return bot

        async def _json_body(request, limit=65536):
            raw = await request.body()
            if len(raw) > limit:
                raise PluginError('too_large', 'Request body is too large.', 413)
            try:
                return json.loads(raw or b'{}')
            except ValueError:
                raise PluginError('bad_request', 'Malformed JSON body.', 400) from None

        async def run_in_threadpool(fn, *args, **kwargs):
            return await asyncio.get_running_loop().run_in_executor(None, lambda: fn(*args, **kwargs))
        return {'router': router, 'Request': object, 'JSONResponse': Reply, 'PluginError': PluginError, '_identity': _identity, '_require_csrf': _require_csrf, '_human': _human, '_existing': _existing,
                '_json_body': _json_body, 'run_in_threadpool': run_in_threadpool, '_stores': lambda: (env.audit, None), '_HEADERS': {}, '_REDACT': redact, 'voice': voice, 'identity': identity,
                'asyncio': asyncio, 'uuid4': __import__('uuid').uuid4, '_voice_gate_reason': lambda *a: None, '_loopback_trusted': lambda: False}


def call_route(env, method, path, bot, body=None):
    captured = {}
    namespace = Stand(env).namespace(captured)
    try:
        exec(block("@router.%s('%s')" % (method, path)), namespace)
    except NameError as error:
        raise AssertionError('seam: ' + str(error)) from None
    endpoint = captured[path]
    request = Req({'x-luvebot-csrf': 'x'}, body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else b'')
    try:
        reply = asyncio.run(endpoint(bot, request))
    except PluginError as error:
        return Answer(error.status, {'code': error.code, 'message': str(error)})
    except (NameError, ImportError, AttributeError) as error:
        raise AssertionError('seam: ' + str(error)) from None
    return Answer(reply.status_code, reply.content)


# ---- the model of the contract ---------------------------------------------------------------------------------------------------------------
def word(value):
    return value if value in ('pt', 'en') else 'auto' if value in ('', None) else 'other'


def settings_of(cfg):
    stt = cfg.get('stt') if isinstance(cfg.get('stt'), dict) else {}
    tts = cfg.get('tts') if isinstance(cfg.get('tts'), dict) else {}
    provider = tts.get('provider') if isinstance(tts.get('provider'), str) and tts.get('provider') else 'edge'
    section = tts.get(provider) if isinstance(tts.get(provider), dict) else {}

    def text(value):
        return redact(value)[:200] if isinstance(value, str) else None
    return {'stt': {'provider': text(stt.get('provider')), 'language': text(stt.get('language'))},
            'tts': {'provider': text(provider), 'voice': text(section.get('voice'))},
            'language': word(stt.get('language'))}                                          # A-281: a value the person set in Hermes outside pt/en is `other`, never `auto` ('the provider detects' would be false)


def reference_put(env, bot, body):
    if env.session is None:
        return Answer(401, {'code': 'unauthenticated'})
    if not env.csrf_ok:
        return Answer(403, {'code': 'csrf_required'})
    if env.session == 'loopback':
        return Answer(403, {'code': 'loopback_not_human'})
    if bot not in env.bots:
        return Answer(404, {'code': 'bot_not_found'})
    if not isinstance(body, dict) or set(body) != {'language'}:
        return Answer(400, {'code': 'bad_request'})
    language = body['language']
    if not isinstance(language, str) or language not in ENUM:
        return Answer(422, {'code': 'invalid_field'})
    cfg = copy.deepcopy(env.cfg[bot])
    stt = cfg.get('stt') if isinstance(cfg.get('stt'), dict) else {}
    tts = cfg.get('tts') if isinstance(cfg.get('tts'), dict) else {}
    edge = tts.get('edge') if isinstance(tts.get('edge'), dict) else {}
    patch = {'stt': {'language': '' if language == 'auto' else language}}
    if language != 'auto' and tts.get('provider') in (None, 'edge') and edge.get('voice') in (None, '', ARIA, FRANCISCA):
        patch['tts'] = {'edge': {'voice': FRANCISCA if language == 'pt' else ARIA}}
    before = word(stt.get('language'))

    def effect():
        try:
            asyncio.run(sys.modules['hermes_cli.web_routers.config_env'].update_config(
                sys.modules['hermes_cli.web_models'].ConfigUpdate(config=patch, profile=bot), profile=bot))
        except Exception:
            raise PluginError('hermes_error', 'Hermes could not change this setting.', 502) from None
    try:
        env.audit.act('basic:ana', 'voice.language', bot, {'kind': 'ui', 'ref': 'req_x'}, effect, bot=bot, payload={'from': before, 'to': language})
    except PluginError as error:
        return Answer(error.status, {'code': error.code, 'message': str(error)})
    kept = settings_of(env.cfg[bot])
    if kept['language'] != language:
        return Answer(502, {'code': 'hermes_error'})
    return Answer(200, {'settings': kept})


def reference_status(env, bot):
    return Answer(200, {'radio': {'available': True, 'reason': None}, 'call': {'available': False, 'reason': 'no_openai_key'}, 'client_direct': True, 'settings': settings_of(env.cfg[bot])})


class Reference:
    def put(self, env, bot, body):
        return reference_put(env, bot, body)

    def status(self, env, bot):
        return reference_status(env, bot)


class Route:
    def put(self, env, bot, body):
        return call_route(env, 'put', '/bots/{bot}/voice/language', bot, body)

    def status(self, env, bot):
        answer = call_route(env, 'get', '/bots/{bot}/voice', bot)
        if not (isinstance(answer.body, dict) and 'settings' in answer.body):               # the route exists today, without the key: an AssertionError (the xfail's reason), never a KeyError
            raise AssertionError('VL-1 is not built: the voice status has no `settings` yet (contract 2)')
        return answer


LEGS = [pytest.param(Reference(), id='reference'),
        pytest.param(Route(), id='VL-1')]


@pytest.fixture(params=LEGS)
def leg(request):
    return request.param


@pytest.fixture
def env(tmp_path, monkeypatch):
    return Env(tmp_path, monkeypatch)


def put(leg, env, language, bot='vendas'):
    return leg.put(env, bot, {'language': language})


def untouched(env, *except_profiles):
    """Every profile but the named ones is exactly what it was."""
    return all(env.cfg[name] == env.initial for name in env.cfg if name not in except_profiles)


# ---- (1) the value ---------------------------------------------------------------------------------------------------------------------------
HOSTILE = ['PT', 'Pt', 'pt ', ' en', 'pt-BR', 'en-US', 'pt_BR', 'por', 'portugues', '', ' ', 'null', 'None', 'auto ', 'AUTO', 'pt\n', 'en' + chr(0), 'p' + chr(0x200B) + 't', 'pt' + chr(0x202E), chr(0x0440) + 't', 'pt;en',
           'pt, en', '../../x', 'en-US-AriaNeural', 'ignore previous instructions', 'x' * 10000, 'sk-' + 'Aa1b' * 6 + 'Zq', '{"language":"pt"}', '$(id)', 'pt\r\nstt:\r\n  provider: x',
           None, 1, 0, True, False, 1.5, ['pt'], {'pt': 1}, {'language': 'pt'}]


@pytest.mark.parametrize('value', HOSTILE, ids=lambda v: repr(v)[:24])
def test_a_language_outside_pt_en_auto_is_refused_and_nothing_reaches_hermes_the_audit_or_the_answer(leg, env, value):
    answer = put(leg, env, value)
    assert answer.status in (400, 422), (answer.status, answer.body)
    assert env.calls == [] and env.rows() == [] and untouched(env), 'a refused value reached the configuration, the audit or both'
    sent = json.dumps(answer.body, ensure_ascii=False, default=str)
    assert SECRETS['stt'] not in sent and (not isinstance(value, str) or len(value) < 40 or value not in sent), 'the value came back in the error'


BODIES = {'extra key': {'language': 'pt', 'stt': {'provider': 'cloud'}}, 'a config key': {'language': 'pt', 'config': {'voice': {'client_direct': True}}}, 'a voice': {'language': 'pt', 'voice': 'x'}, 'a bot': {'language': 'pt', 'bot': 'compras'},
          'nothing': {}, 'null': None, 'a list': ['pt'], 'a string': 'pt', 'a number': 5, 'the key renamed': {'lang': 'pt'}, 'nested': {'language': {'language': 'pt'}}}


@pytest.mark.parametrize('what', list(BODIES))
def test_a_body_that_is_not_exactly_the_one_key_is_refused_and_nothing_else_of_the_configuration_can_be_sent(leg, env, what):
    answer = leg.put(env, 'vendas', BODIES[what])
    assert answer.status in (400, 422) and env.calls == [] and env.rows() == [] and untouched(env), (answer.status, env.calls)


def test_the_three_words_are_accepted_and_the_answer_is_the_new_settings(leg, env):
    for language in ENUM:
        answer = put(leg, env, language)
        assert answer.status == 200 and answer.body['settings']['language'] == language, (language, answer.status, answer.body)
        assert set(answer.body['settings']) == {'stt', 'tts', 'language'}


# ---- (2) what is written, and what is not -----------------------------------------------------------------------------------------------------
def expected(cfg, language):
    """The contract, as the test's own oracle: the leaves that may change, for this configuration and this word."""
    stt, tts = cfg.get('stt') or {}, cfg.get('tts') or {}
    edge = tts.get('edge') or {}
    out = {}
    want = '' if language == 'auto' else language
    if (stt.get('language') or '') != want:
        out[('stt', 'language')] = want
    if language != 'auto' and tts.get('provider') in (None, 'edge') and edge.get('voice') in (None, '', ARIA, FRANCISCA):
        target = FRANCISCA if language == 'pt' else ARIA
        if edge.get('voice') != target:
            out[('tts', 'edge', 'voice')] = target
    return out


def with_tts(provider='edge', voice=ARIA, language=None):
    cfg = copy.deepcopy(RICH)
    if provider is None:
        del cfg['tts']['provider']
    else:
        cfg['tts']['provider'] = provider
    if voice is None:
        del cfg['tts']['edge']['voice']
    else:
        cfg['tts']['edge']['voice'] = voice
    if language is not None:
        cfg['stt']['language'] = language
    return cfg


CASES = [(provider, voice, language) for provider in (None, 'edge', 'openai', 'elevenlabs', 'xai') for voice in (None, '', ARIA, FRANCISCA, 'pt-BR-AntonioNeural', 'en-GB-RyanNeural', ' ' + ARIA, ARIA.lower(), 123, ['x'])
         for language in (None, 'pt', 'en', 'fr')]


@pytest.mark.parametrize('word_', ENUM)
def test_only_stt_language_and_the_edge_voice_change_and_the_voice_the_person_chose_is_never_overwritten(leg, tmp_path, monkeypatch, word_):
    """150 starting points x the word: the leaves that changed are exactly the contract's (an oracle of its own), the patch sent holds no other leaf, and a voice that is not one of the two defaults is still there."""
    for number, (provider, voice, language) in enumerate(CASES):
        sub = tmp_path / str(number)
        sub.mkdir()
        start = with_tts(provider, voice, language)
        env = Env(sub, monkeypatch, start)
        answer = put(leg, env, word_)
        assert answer.status == 200, (provider, voice, language, answer.status, answer.body)
        after = env.cfg['vendas']
        want = expected(start, word_)
        assert changed(start, after) == set(want), ((provider, voice, language, word_), changed(start, after), want)
        for path, value in want.items():
            assert norm(after).get(path, '') == value
        assert untouched(env, 'vendas'), 'another profile was written (the default profile when the call names none)'
        sent = [set(leaves(call[3])) for call in env.calls]
        assert all(keys <= {('stt', 'language'), ('tts', 'edge', 'voice')} for keys in sent), ('a leaf beyond the two was sent', sent)
        if voice not in (None, '', ARIA, FRANCISCA) and provider in (None, 'edge'):
            assert after['tts']['edge']['voice'] == voice, 'a voice the person chose was overwritten'
        if provider not in (None, 'edge'):
            assert after['tts'].get(provider) == start['tts'].get(provider) and after['tts']['edge'] == start['tts']['edge'], 'another provider (or the edge voice under it) was touched'


def test_a_round_trip_pt_en_pt_ends_on_francisca_and_leaves_a_chosen_voice_alone(leg, tmp_path, monkeypatch):
    env = Env(tmp_path, monkeypatch, with_tts('edge', ARIA))
    for language, voice_ in (('pt', FRANCISCA), ('en', ARIA), ('pt', FRANCISCA), ('auto', FRANCISCA)):
        assert put(leg, env, language).status == 200 and env.cfg['vendas']['tts']['edge']['voice'] == voice_, language
    chosen = 'pt-PT-RaquelNeural'
    env.cfg['vendas']['tts']['edge']['voice'] = chosen
    for language in ENUM:
        put(leg, env, language)
        assert env.cfg['vendas']['tts']['edge']['voice'] == chosen


def test_every_other_key_of_voice_stt_tts_and_the_rest_survives_the_write(leg, env):
    before = copy.deepcopy(RICH)
    assert put(leg, env, 'pt').status == 200
    after = env.cfg['vendas']
    for path, value in leaves(before).items():
        if path not in (('stt', 'language'), ('tts', 'edge', 'voice')):
            assert leaves(after).get(path, '<gone>') == value, ('a key was lost or changed', path)
    assert after['voice']['client_direct'] is False and after['display']['message_reactions'] is True and after['tts']['edge']['rate'] == '+10%'


def test_a_change_somebody_else_makes_while_we_write_survives_the_write(leg, env):
    """Hermes's own app writes the same file: a patch that resends a subtree read a moment ago would put the old values back."""
    def meanwhile(e):
        e.cfg['vendas']['stt']['provider'] = 'groq'
        e.cfg['vendas']['tts']['edge']['rate'] = '+50%'
        e.cfg['vendas']['voice']['beep'] = False
        e.before_apply = None
    env.before_apply = meanwhile
    assert put(leg, env, 'en').status == 200
    after = env.cfg['vendas']
    assert (after['stt']['provider'], after['tts']['edge']['rate'], after['voice']['beep']) == ('groq', '+50%', False), 'the write resent what it had read'


@pytest.mark.parametrize('broken', [{'stt': None}, {'tts': []}, {'stt': 'cloud', 'tts': 'edge'}, {'tts': {'edge': 'Aria'}}, {'stt': {'language': ['pt']}}])
def test_a_configuration_with_the_wrong_shapes_never_makes_a_500_and_nothing_outside_the_two_keys_moves(leg, tmp_path, monkeypatch, broken):
    start = {**copy.deepcopy(RICH), **broken}
    env = Env(tmp_path, monkeypatch, start)
    answer = put(leg, env, 'pt')
    assert answer.status in (200, 409, 422, 502), (answer.status, answer.body)
    others = {k: v for k, v in leaves(start).items() if k[:1] not in (('stt',), ('tts',)) or k in leaves(RICH)}
    assert all(leaves(env.cfg['vendas']).get(k, '<gone>') == v for k, v in leaves(start).items() if k[0] not in ('stt', 'tts')), 'a key outside stt and tts moved'
    assert untouched(env, 'vendas') and others is not None


# ---- (3) who may ask -------------------------------------------------------------------------------------------------------------------------
def test_without_a_session_nothing_happens_and_the_answer_is_401(leg, env):
    env.session = None
    answer = put(leg, env, 'pt')
    assert answer.status == 401 and env.calls == [] and env.rows() == [] and untouched(env)


def test_without_the_csrf_header_the_answer_is_403_before_the_body_the_bot_and_any_effect(leg, env):
    env.csrf_ok = False
    for bot, body in (('vendas', {'language': 'pt'}), ('vendas', {'language': 'rubbish'}), ('vendas', None), ('no-such-bot', {'language': 'pt'})):
        answer = leg.put(env, bot, body)
        assert (answer.status, answer.code) == (403, 'csrf_required'), (bot, body, answer.status, answer.code)
    assert env.calls == [] and env.rows() == [] and untouched(env)


def test_the_loopback_credential_is_no_person_and_is_refused(leg, env):
    env.session = 'loopback'
    answer = put(leg, env, 'pt')
    assert answer.status == 403 and answer.code == 'loopback_not_human' and env.calls == [] and env.rows() == [] and untouched(env)


def test_a_bot_that_does_not_exist_is_a_404_and_writes_nothing(leg, env):
    answer = leg.put(env, 'no-such-bot', {'language': 'pt'})
    assert answer.status == 404 and env.calls == [] and env.rows() == [] and untouched(env)


def test_the_write_names_the_bots_profile_and_never_the_default_one(leg, env):
    assert put(leg, env, 'pt', bot='compras').status == 200
    assert env.calls and all(call[1] == 'compras' and call[2] == 'compras' for call in env.calls), env.calls
    assert env.cfg['compras']['stt']['language'] == 'pt' and untouched(env, 'compras')


# ---- (4) the answer and the audit -----------------------------------------------------------------------------------------------------------
def test_the_audit_row_is_written_before_hermes_is_asked_and_holds_words_and_never_text(leg, tmp_path, monkeypatch):
    planted = copy.deepcopy(RICH)
    planted['stt']['language'] = 'sk-' + 'Gg7h' * 6 + 'Zq'                                        # a key a person pasted in the wrong field: the 'before' of this write
    env = Env(tmp_path, monkeypatch, planted)
    assert put(leg, env, 'pt').status == 200
    rows = env.rows('voice.language')
    assert rows and {row[4] for row in rows} == {'vendas'} and {row[3] for row in rows} == {'vendas'}, rows
    assert env.intents_at_write and min(env.intents_at_write) >= 1, 'Hermes was asked before the audit had the intent'
    action, bot, payload = next(p for p in env.payloads if p[0] == 'voice.language')
    assert bot == 'vendas' and isinstance(payload, dict) and 1 <= len(payload) <= 3, payload
    values = [v for v in payload.values()]
    assert all(v in ('pt', 'en', 'auto', 'other') for v in values) and 'pt' in values, ('the payload holds a word the enum does not have', payload)
    dumped = json.dumps([rows, env.payloads], default=str)
    assert 'Gg7h' not in dumped and SECRETS['hermes'] not in dumped


def test_a_write_hermes_refuses_is_a_502_with_none_of_its_text_the_config_unchanged_and_never_audited_as_done(leg, env):
    env.broken = {'vendas'}
    answer = put(leg, env, 'pt')
    assert answer.status == 502 and untouched(env) and env.cfg['vendas'] == env.initial
    assert SECRETS['hermes'] not in json.dumps(answer.body, default=str) and 'yaml' not in json.dumps(answer.body, default=str)
    outcomes = {row[1] for row in env.rows('voice.language') if row[2] != 'intent'}                 # the intent row is 'ok' by design (act commits it before the effect); the RESULT row is the claim
    assert outcomes and 'ok' not in outcomes and 'success' not in outcomes, outcomes


def test_a_value_hermes_did_not_keep_is_a_502_and_never_a_claimed_success(leg, env):
    env.keeps = False
    answer = put(leg, env, 'pt')
    assert answer.status == 502 and env.cfg['vendas'] == env.initial


def test_a_bot_that_fails_does_not_stop_the_others_and_each_write_has_its_own_row(leg, env):
    """The screen's 'apply to every Bot' is one write per Bot: one failing leaves the other written and its own row."""
    env.broken = {'vendas'}
    results = {bot: put(leg, env, 'pt', bot=bot).status for bot in ('vendas', 'compras')}
    assert results == {'vendas': 502, 'compras': 200}, results
    assert env.cfg['compras']['stt']['language'] == 'pt' and env.cfg['vendas'] == env.initial and env.cfg['default'] == env.initial
    assert {row[4] for row in env.rows('voice.language')} == {'vendas', 'compras'}


def test_two_writes_at_once_both_land_and_neither_loses_the_other(leg, env):
    results, errors = {}, []

    def run(bot, language):
        try:
            results[bot] = put(leg, env, language, bot=bot).status
        except BaseException as error:                                                      # an error in a thread is the test's, in the main thread (not a warning nobody reads)
            errors.append(error)
    threads = [threading.Thread(target=run, args=(bot, language)) for bot, language in (('vendas', 'pt'), ('compras', 'en'))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(20)
    if errors:
        raise errors[0]
    assert results == {'vendas': 200, 'compras': 200} and env.cfg['vendas']['stt']['language'] == 'pt' and env.cfg['compras']['stt']['language'] == 'en'


# ---- (5) the status --------------------------------------------------------------------------------------------------------------------------
def test_the_status_carries_the_listed_settings_and_no_secret_and_no_other_key(leg, env):
    answer = leg.status(env, 'vendas')
    assert answer.status == 200 and set(answer.body['settings']) == {'stt', 'tts', 'language'}, answer.body
    assert set(answer.body['settings']['stt']) == {'provider', 'language'} and set(answer.body['settings']['tts']) == {'provider', 'voice'}
    sent = json.dumps(answer.body)
    assert not any(secret in sent for secret in SECRETS.values()) and not any(k in sent for k in ('api_key', 'token', 'voice_id', 'EL-ABC', 'client_direct_secret')), 'a secret or a key outside the list'
    assert answer.body['settings']['stt'] == {'provider': 'local', 'language': None} or answer.body['settings']['stt']['provider'] == 'local'
    assert answer.body['settings']['tts']['voice'] == ARIA and answer.body['settings']['language'] == 'auto'


def test_a_value_that_is_not_a_short_text_or_that_holds_a_key_is_redacted_or_dropped_in_the_status(leg, tmp_path, monkeypatch):
    start = copy.deepcopy(RICH)
    start['stt'].update({'provider': ['x'], 'language': 'sk-' + 'Hh8i' * 6 + 'Zq'})
    start['tts'].update({'provider': 'edge', 'edge': {'voice': 'v' * 20000}})
    env = Env(tmp_path, monkeypatch, start)
    answer = leg.status(env, 'vendas')
    sent = json.dumps(answer.body)
    assert answer.status == 200 and 'Hh8i' not in sent and len(sent) < 6000, len(sent)
    assert answer.body['settings']['stt']['provider'] is None and answer.body['settings']['language'] == 'other'


def test_the_status_of_a_bot_with_no_voice_configuration_is_not_an_error(leg, tmp_path, monkeypatch):
    env = Env(tmp_path, monkeypatch, {})
    answer = leg.status(env, 'vendas')
    assert answer.status == 200 and answer.body['settings']['language'] == 'auto' and answer.body['settings']['stt']['language'] in (None, '')


def test_the_status_reads_the_profile_of_the_bot_asked(leg, tmp_path, monkeypatch):
    env = Env(tmp_path, monkeypatch)
    env.cfg['compras']['stt']['language'] = 'pt'
    assert leg.status(env, 'compras').body['settings']['language'] == 'pt' and leg.status(env, 'vendas').body['settings']['language'] == 'auto'
    env.cfg['default']['stt']['language'] = 'en'
    assert leg.status(env, 'vendas').body['settings']['language'] == 'auto', 'the default profile answered for a Bot'


def test_a_language_the_person_set_in_hermes_outside_pt_en_is_other_in_the_status_and_stays_raw_in_stt(leg, tmp_path, monkeypatch):
    for number, (raw, word_) in enumerate((('fr', 'other'), ('PT', 'other'), ('pt-BR', 'other'), ('', 'auto'), (None, 'auto'), ('pt', 'pt'), ('en', 'en'))):
        start = copy.deepcopy(RICH)
        start['stt']['language'] = raw
        (tmp_path / str(number)).mkdir()                                                    # numbered, never named by the value: 'PT' and 'pt' are one folder on a Mac
        env = Env(tmp_path / str(number), monkeypatch, start)
        answer = leg.status(env, 'vendas')
        assert answer.body['settings']['language'] == word_ and answer.body['settings']['language'] in STATUS_ENUM, (raw, answer.body['settings'])
        assert answer.body['settings']['stt']['language'] == raw or (raw in ('', None) and answer.body['settings']['stt']['language'] in ('', None)), (raw, answer.body['settings']['stt'])


def test_the_audit_names_other_for_what_was_there_before_and_never_the_raw_value(leg, tmp_path, monkeypatch):
    start = copy.deepcopy(RICH)
    start['stt']['language'] = 'fr'
    env = Env(tmp_path, monkeypatch, start)
    assert put(leg, env, 'pt').status == 200
    payload = next(p for p in env.payloads if p[0] == 'voice.language')[2]
    assert 'other' in payload.values() and 'pt' in payload.values() and 'fr' not in payload.values(), payload


# ---- (6) transcribe: timing, and no text in the audit --------------------------------------------------------------------------------------
class Hermes:
    def __init__(self, transcript='ola mundo ' + SECRETS['voice'], fail=None):
        self.transcript, self.fail, self.calls = transcript, fail, 0

    def transcribe(self, data, mime, bot):
        self.calls += 1
        if self.fail:
            raise self.fail
        return {'ok': True, 'transcript': self.transcript, 'provider': 'local'}


def transcribe(tmp_path, data=b'RIFFfakeaudio' * 40, **kw):
    log = audit_module.AuditLog(tmp_path / 'audit-t.db')
    seen = []
    original = log.act
    log.act = lambda *a, **k: (seen.append(k.get('payload')), original(*a, **k))[1]
    hermes = Hermes(**kw)
    return voice.transcribe(log, hermes, 'basic:ana', 'vendas', data, 'audio/wav', lambda: None, redact, 'req_t'), seen, log


def test_transcribe_answers_timing_with_server_ms_and_bytes_and_nothing_else(tmp_path):
    data = b'RIFFfakeaudio' * 40
    answer, _seen, _log = transcribe(tmp_path, data)
    timing = answer.get('timing')
    assert isinstance(timing, dict) and set(timing) == {'server_ms', 'bytes'}, answer
    assert type(timing['bytes']) is int and timing['bytes'] == len(data) and type(timing['server_ms']) in (int, float) and not isinstance(timing['server_ms'], bool) and 0 <= timing['server_ms'] < 60000


def test_the_audit_payload_of_transcribe_holds_the_timing_and_no_text(tmp_path):
    _answer, seen, log = transcribe(tmp_path)
    payload = seen[-1]
    assert isinstance(payload, dict) and {'server_ms', 'bytes'} <= set(payload), payload
    assert all(type(v) in (int, float, str) for v in payload.values()) and 'ola' not in json.dumps(payload) and SECRETS['voice'] not in json.dumps(payload)


def test_today_the_audit_payload_of_transcribe_holds_no_text_and_a_failure_carries_no_timing_or_text(tmp_path):
    _answer, seen, log = transcribe(tmp_path)
    assert 'ola' not in json.dumps(seen[-1]) and SECRETS['voice'] not in json.dumps(seen[-1]), seen[-1]
    import sqlite3
    with contextlib.closing(sqlite3.connect(log.path)) as conn:
        dumped = json.dumps(conn.execute('SELECT * FROM audit_log').fetchall(), default=str)
    assert 'ola' not in dumped and SECRETS['voice'] not in dumped
    with pytest.raises(PluginError) as error:
        transcribe(tmp_path / 'x' if (tmp_path / 'x').mkdir() is None else tmp_path, fail=RuntimeError('boom ' + SECRETS['hermes']))
    assert SECRETS['hermes'] not in str(error.value) and 'timing' not in json.dumps(getattr(error.value, 'extra', {}) or {})
