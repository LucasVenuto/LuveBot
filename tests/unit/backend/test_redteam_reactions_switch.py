"""Red team (Lume, 06/11) of the reactions switch, contract docs/contracts/voice-language-reactions-v0.md section 4 item 3 and A-282 (RX-1 builds, RX-3 the attack), tests only.

THE SHAPE (A-282): `PUT /bots/{bot}/reactions/bot-sees` with exactly `{enabled: true | false}` (anything else is 422), for a signed-in person with the CSRF header (the `_human` rule: no session is 401, loopback is
`403 loopback_not_human`), audited as `reactions.bot_sees` with `before` and `after` as booleans, writing ONLY `display.message_reactions` through `update_config` with the Bot's profile, answering
`{reactions: {bot_sees: boolean}}`. The state is read in `GET /bots/{bot}` as `reactions: {bot_sees: boolean}` (an unset key reads false); the object is ABSENT when it cannot be told (a Hermes without `take_unseen_reactions`
included), then the Profile shows the switch off and unavailable, never on. The Bot list does not carry it.
Every test runs TWICE through the fixture `leg`: `reference` (a small MODEL of that text written here, never a patch: it proves each test is satisfiable and, with `evidence/rx3/mutants_switch.py`, not vacuous) and `RX-1` (the real route
`PUT /bots/{bot}/reactions/bot-sees` and `GET /bots/{bot}`, their source compiled here as the voice route tests do, with the REAL audit log and a stand-in for the Hermes modules the contract names: `update_config` (a strict read, a deep merge,
the profile of the call decides the file) and `load_config` under `_config_profile_scope(bot)`). Today it is a strict `xfail(raises=AssertionError)`: the day RX-1 lands it passes, the suite goes red on XPASS(strict), and whoever lands it removes
the mark in `LEGS` (one line) and reads what fails; a seam this file stands in for and the code reads another way raises AssertionError('seam: ...') and is fixed in `Stand`, one place. The read of `GET /bots/{bot}` runs the real `get_bot`
over a stub `_one` here: when RX-1 puts `reactions` inside `_one`, its seams are wired in `Route.read`.
READINGS fixed (a question to the Architect where the text is silent): only the boolean True is ON (a string, a number, a list, an empty value is off: the switch never shows on when LuveBot's own gate would not announce); a body that is not an
object is 400 or 422, an object with another key or another type of value is 422 (`1`, `0` and `1.0` are not booleans); `before` is the state that was there (an unset key is False, never the raw value); the answer is what Hermes holds after the write."""
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
import backend.reactions as reactions  # noqa: E402
from backend.api_errors import PluginError  # noqa: E402

API = (ROOT / 'dashboard' / 'plugin_api.py').read_text(encoding='utf-8')
SECRETS = {name: 'sk-' + chunk * 6 + 'Zq' for name, chunk in (('stt', 'Aa1b'), ('tts', 'Bb2c'), ('hermes', 'Ee5f'), ('planted', 'Gg7h'))}
RICH = {'model': {'default': 'claude-haiku-5-5'}, 'display': {'theme': 'dark', 'compact_tool_progress': True, 'message_reactions': False}, 'skills': {'a': 1},
        'stt': {'provider': 'local', 'openai': {'api_key': SECRETS['stt']}}, 'tts': {'provider': 'edge', 'openai': {'api_key': SECRETS['tts']}}, 'voice': {'client_direct': False}}
PATH = ('display', 'message_reactions')


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


def changed(before, after):
    a, b = ({k: v for k, v in leaves(x).items() if v != {}} for x in (before, after))       # an empty mapping is no leaf: `display: {}` becoming `display: {message_reactions: true}` moves one key
    return {k for k in set(a) | set(b) if a.get(k, '<absent>') != b.get(k, '<absent>')}


class Answer:
    def __init__(self, status, body):
        self.status, self.body = status, body

    @property
    def code(self):
        return self.body.get('code') if isinstance(self.body, dict) else None


class Env:
    """One configuration per profile (the default profile too), every write recorded, the REAL audit log with a spy on the payloads, the gates the plugin has (session, csrf, loopback, bots)."""
    def __init__(self, tmp_path, monkeypatch, cfg=None):
        self.initial = copy.deepcopy(RICH if cfg is None else cfg)
        self.cfg = {name: copy.deepcopy(self.initial) for name in ('default', 'vendas', 'compras')}
        self.calls, self.scope, self.keeps, self.broken, self.before_apply, self.unreadable, self.capable = [], None, True, set(), None, False, True
        self.session, self.csrf_ok, self.bots = 'gated', True, {'vendas', 'compras'}
        self.audit, self.payloads, self.intents_at_write = audit_module.AuditLog(tmp_path / 'audit.db'), [], []
        original = self.audit.act

        def spy(actor, action, target, origin, fn, *, bot=None, payload=None):
            self.payloads.append((action, bot, copy.deepcopy(payload)))
            return original(actor, action, target, origin, fn, bot=bot, payload=payload)
        self.audit.act = spy
        env = self

        def module(name, **attrs):
            mod = types.ModuleType(name)
            mod.__dict__.update(attrs)
            monkeypatch.setitem(sys.modules, name, mod)

        class ConfigUpdate:
            def __init__(self, config=None, profile=None):
                self.config, self.profile = config, profile

        async def update_config(body, profile=None):
            env.calls.append(('update_config', body.profile, profile, copy.deepcopy(body.config)))
            env.intents_at_write.append(len(env.rows('reactions.bot_sees')))
            if (profile or body.profile) in env.broken:
                raise RuntimeError('yaml error ' + SECRETS['hermes'])
            if not isinstance(body.config, dict):
                raise ValueError('strict read')
            if env.before_apply:
                env.before_apply(env)
            if env.keeps:
                deep_merge(env.cfg[profile or 'default'], body.config)         # the profile of the CALL decides the file: a call without it writes the default profile
            return {'ok': True}

        @contextlib.contextmanager
        def scope(bot):
            before, env.scope = env.scope, bot
            try:
                yield
            finally:
                env.scope = before

        def load_config():
            if env.unreadable:
                raise RuntimeError('config is broken ' + SECRETS['hermes'])
            return copy.deepcopy(env.cfg[env.scope or 'default'])
        module('hermes_cli')
        module('hermes_cli.web_models', ConfigUpdate=ConfigUpdate)
        module('hermes_cli.web_routers')
        module('hermes_cli.web_routers.config_env', update_config=update_config)
        module('hermes_cli.web_server_profiles', _config_profile_scope=scope)
        module('hermes_cli.config', load_config=load_config)

        class Capabilities(type):                                         # RX-1 (Brasa): whether this Hermes can announce is `env.capable`, read when the code asks, as the real SessionDB answers by the methods it has
            def __getattr__(cls, name):
                if name == 'take_unseen_reactions' and env.capable:
                    return lambda *a, **k: []
                raise AttributeError(name)
        module('hermes_state', SessionDB=Capabilities('SessionDB', (), {name: (lambda *a, **k: None) for name in ('set_message_reaction', 'get_message_reactions', 'get_message_role')}))

    def rows(self, action=None):
        import sqlite3
        with contextlib.closing(sqlite3.connect(self.audit.path)) as conn:
            sql = 'SELECT action, outcome, detail, target, bot, digest FROM audit_log' + (' WHERE action = ?' if action else '') + ' ORDER BY id'
            return conn.execute(sql, (action,) if action else ()).fetchall()


# ---- the route source, compiled -----------------------------------------------------------------------------------------------------------------
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
        raise AssertionError('RX-1 is not built: dashboard/plugin_api.py has no ' + start)
    return found.group(0)


class Stand:
    """The names a route of plugin_api.py may call, standing in for the plugin's own gates (their real behaviour is tested elsewhere; this is the contract's: 401, 403 csrf_required, 403 loopback_not_human, 404 bot_not_found)."""
    def __init__(self, env):
        self.env = env

    def namespace(self, captured):
        env = self.env

        def deco(path):
            return lambda fn: captured.setdefault(path, fn) or fn
        router = types.SimpleNamespace(get=deco, put=deco, post=deco, delete=deco, patch=deco)

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

        async def _one(bot, extras=False):
            if bot not in env.bots:
                raise PluginError('bot_not_found', 'Bot not found.', 404)
            return {'name': bot}
        return {'router': router, 'Request': object, 'JSONResponse': Reply, 'PluginError': PluginError, '_identity': _identity, '_require_csrf': _require_csrf, '_human': _human, '_existing': _existing,
                '_json_body': _json_body, 'run_in_threadpool': run_in_threadpool, '_stores': lambda: (env.audit, None), '_HEADERS': {}, '_REDACT': redact, 'identity': identity, 'asyncio': asyncio,
                'uuid4': __import__('uuid').uuid4, '_loopback_trusted': lambda: False, '_one': _one, 'validate_profile': lambda bot: bot, 'reactions': reactions}


def call_route(env, method, path, bot, body=None):
    captured = {}
    namespace = Stand(env).namespace(captured)
    try:
        exec(block("@router.%s('%s')" % (method, path)), namespace)
    except NameError as error:
        raise AssertionError('seam: ' + str(error)) from None
    request = Req({'x-luvebot-csrf': 'x'}, body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else b'')
    try:
        reply = asyncio.run(captured[path](bot, request))
    except PluginError as error:
        return Answer(error.status, {'code': error.code, 'message': str(error)})
    except (NameError, ImportError, AttributeError) as error:
        raise AssertionError('seam: ' + str(error)) from None
    if isinstance(reply, dict):
        return Answer(200, reply)
    return Answer(reply.status_code, reply.content)


# ---- the model of A-282 -----------------------------------------------------------------------------------------------------------------------
def is_on(cfg):
    display = cfg.get('display') if isinstance(cfg, dict) else None
    return isinstance(display, dict) and display.get('message_reactions') is True


def model_put(env, bot, body):
    if env.session is None:
        return Answer(401, {'code': 'unauthenticated'})
    if not env.csrf_ok:
        return Answer(403, {'code': 'csrf_required'})
    if env.session == 'loopback':
        return Answer(403, {'code': 'loopback_not_human'})
    if bot not in env.bots:
        return Answer(404, {'code': 'bot_not_found'})
    if not isinstance(body, dict):
        return Answer(400, {'code': 'bad_request'})
    if set(body) != {'enabled'} or type(body['enabled']) is not bool:
        return Answer(422, {'code': 'invalid_field'})
    value, before = body['enabled'], is_on(env.cfg[bot])
    patch = {'display': {'message_reactions': value}}

    def effect():
        try:
            asyncio.run(sys.modules['hermes_cli.web_routers.config_env'].update_config(sys.modules['hermes_cli.web_models'].ConfigUpdate(config=patch, profile=bot), profile=bot))
        except Exception:
            raise PluginError('hermes_error', 'Hermes could not change this setting.', 502) from None
    try:
        env.audit.act('basic:ana', 'reactions.bot_sees', bot, {'kind': 'ui', 'ref': 'req_x'}, effect, bot=bot, payload={'before': before, 'after': value})
    except PluginError as error:
        return Answer(error.status, {'code': error.code, 'message': str(error)})
    if is_on(env.cfg[bot]) != value:
        return Answer(502, {'code': 'hermes_error'})
    return Answer(200, {'reactions': {'bot_sees': value}})


def model_read(env, bot):
    body = {'name': bot}
    if env.capable and not env.unreadable:
        body['reactions'] = {'bot_sees': is_on(env.cfg[bot])}
    return Answer(200, body)


class Reference:
    def put(self, env, bot, body):
        return model_put(env, bot, body)

    def read(self, env, bot):
        return model_read(env, bot)


class Route:
    def put(self, env, bot, body):
        return call_route(env, 'put', '/bots/{bot}/reactions/bot-sees', bot, body)

    def read(self, env, bot):
        answer = call_route(env, 'get', '/bots/{bot}', bot)
        if 'reactions' not in answer.body and env.capable and not env.unreadable:       # RX-1: ABSENT is the answer when it cannot be told (a Hermes that cannot announce, a configuration that cannot be read); any other absence is a route that does not tell
            raise AssertionError('GET /bots/{bot} has no `reactions` although it can be told')
        return answer


LEGS = [pytest.param(Reference(), id='reference'),
        pytest.param(Route(), id='RX-1')]


@pytest.fixture(params=LEGS)
def leg(request):
    return request.param


@pytest.fixture
def env(tmp_path, monkeypatch):
    return Env(tmp_path, monkeypatch)


def put(leg, env, enabled, bot='vendas'):
    return leg.put(env, bot, {'enabled': enabled})


def untouched(env, *except_profiles):
    return all(env.cfg[name] == env.initial for name in env.cfg if name not in except_profiles)


# ---- (1) the body ------------------------------------------------------------------------------------------------------------------------------
BAD_VALUES = [1, 0, 1.0, 0.0, 2, -1, 'true', 'false', 'True', 'False', 'on', 'off', 'yes', '1', '', ' ', None, [], [True], {}, {'enabled': True}, 'x' * 10000, SECRETS['planted']]


@pytest.mark.parametrize('value', BAD_VALUES, ids=['v%d' % i for i in range(len(BAD_VALUES))])
def test_a_value_that_is_not_the_boolean_is_422_and_nothing_reaches_hermes_the_audit_or_the_answer(leg, env, value):
    answer = put(leg, env, value)
    assert answer.status == 422, (answer.status, answer.body)
    assert env.calls == [] and env.rows() == [] and untouched(env), 'a refused value reached the configuration or the audit'
    assert SECRETS['planted'] not in json.dumps(answer.body, default=str) and len(json.dumps(answer.body, default=str)) < 600


BAD_BODIES = {'extra key': {'enabled': True, 'display': {'theme': 'x'}}, 'a config key': {'enabled': True, 'config': {'voice': {'client_direct': True}}}, 'a bot': {'enabled': True, 'bot': 'compras'}, 'the key renamed': {'enable': True},
              'another case': {'Enabled': True}, 'bot sees': {'bot_sees': True}, 'empty': {}, 'nested': {'enabled': {'enabled': True}}, 'two values': {'enabled': True, 'other': False}}


@pytest.mark.parametrize('what', list(BAD_BODIES))
def test_an_object_that_is_not_exactly_the_one_key_is_422_and_nothing_else_of_the_configuration_can_be_sent(leg, env, what):
    answer = leg.put(env, 'vendas', BAD_BODIES[what])
    assert answer.status == 422 and env.calls == [] and env.rows() == [] and untouched(env), (answer.status, env.calls)


@pytest.mark.parametrize('body', [None, [True], 'true', 5, True, b'{not json'], ids=['null', 'list', 'string', 'number', 'bool', 'malformed'])
def test_a_body_that_is_not_an_object_is_a_400_or_a_422_and_nothing_is_written(leg, env, body):
    answer = leg.put(env, 'vendas', body)
    assert answer.status in (400, 422) and env.calls == [] and env.rows() == [] and untouched(env), (answer.status, answer.body)


def test_both_booleans_are_accepted_and_the_answer_is_exactly_the_new_state(leg, env):
    for value in (True, False, True):
        answer = put(leg, env, value)
        assert answer.status == 200 and answer.body == {'reactions': {'bot_sees': value}}, (value, answer.status, answer.body)
        assert env.cfg['vendas']['display']['message_reactions'] is value


# ---- (2) what is written, and what is not -----------------------------------------------------------------------------------------------------
def starts():
    out = []
    for display in (None, {}, {'message_reactions': True}, {'message_reactions': False}, {'message_reactions': None}, {'message_reactions': 'sk-planted'}, {'message_reactions': 1}, {'message_reactions': 'false'},
                    {'theme': 'dark', 'compact_tool_progress': True}, {'theme': 'dark', 'message_reactions': True, 'deep': {'a': {'b': 1}}}):
        cfg = copy.deepcopy(RICH)
        if display is None:
            cfg.pop('display')
        else:
            cfg['display'] = display
        out.append(cfg)
    return out


@pytest.mark.parametrize('value', [True, False])
def test_only_the_one_leaf_changes_for_ten_starting_points_and_the_patch_sent_holds_nothing_else(leg, tmp_path, monkeypatch, value):
    for number, start in enumerate(starts()):
        sub = tmp_path / str(number)
        sub.mkdir()
        env = Env(sub, monkeypatch, start)
        answer = put(leg, env, value)
        assert answer.status == 200 and answer.body == {'reactions': {'bot_sees': value}}, (number, answer.status, answer.body)
        after = env.cfg['vendas']
        assert changed(start, after) <= {PATH}, ('a leaf other than display.message_reactions changed', number, changed(start, after))
        assert after['display']['message_reactions'] is value
        for path, kept in leaves(start).items():
            if path != PATH and kept != {}:
                assert leaves(after).get(path, '<gone>') == kept, ('a key was lost or changed', number, path)
        assert untouched(env, 'vendas'), 'another profile was written (the default profile when the call names none)'
        assert all(set(leaves(call[3])) == {PATH} for call in env.calls) and env.calls, ('a leaf beyond the one was sent', env.calls)


def test_every_other_key_survives_the_write_and_nothing_secret_is_in_the_answer(leg, env):
    answer = put(leg, env, True)
    assert answer.status == 200
    after = env.cfg['vendas']
    assert after['display']['theme'] == 'dark' and after['display']['compact_tool_progress'] is True and after['stt'] == RICH['stt'] and after['tts'] == RICH['tts'] and after['voice'] == RICH['voice']
    sent = json.dumps(answer.body, default=str)
    assert not any(secret in sent for secret in SECRETS.values()) and 'api_key' not in sent


def test_a_change_somebody_else_makes_while_we_write_survives_the_write(leg, env):
    """Hermes's own app writes the same file: a patch that resends the whole `display` subtree read a moment ago would put the old values back."""
    def meanwhile(e):
        e.cfg['vendas']['display']['theme'] = 'light'
        e.cfg['vendas']['display']['compact_tool_progress'] = False
        e.cfg['vendas']['stt']['provider'] = 'groq'
        e.before_apply = None
    env.before_apply = meanwhile
    assert put(leg, env, True).status == 200
    after = env.cfg['vendas']
    assert (after['display']['theme'], after['display']['compact_tool_progress'], after['stt']['provider']) == ('light', False, 'groq'), 'the write resent what it had read'


@pytest.mark.parametrize('broken', [{'display': 'dark'}, {'display': ['x']}, {'display': 5}, {'display': {'message_reactions': ['x']}}])
def test_a_configuration_with_the_wrong_shape_never_makes_a_500_and_nothing_outside_display_moves(leg, tmp_path, monkeypatch, broken):
    start = {**copy.deepcopy(RICH), **broken}
    env = Env(tmp_path, monkeypatch, start)
    answer = put(leg, env, True)
    assert answer.status in (200, 409, 422, 502), (answer.status, answer.body)
    assert all(leaves(env.cfg['vendas']).get(k, '<gone>') == v for k, v in leaves(start).items() if k[0] != 'display'), 'a key outside display moved'
    assert untouched(env, 'vendas')


# ---- (3) who may ask ----------------------------------------------------------------------------------------------------------------------------
def test_without_a_session_nothing_happens_and_the_answer_is_401(leg, env):
    env.session = None
    answer = put(leg, env, True)
    assert answer.status == 401 and env.calls == [] and env.rows() == [] and untouched(env)


def test_without_the_csrf_header_the_answer_is_403_before_the_body_the_bot_and_any_effect(leg, env):
    env.csrf_ok = False
    for bot, body in (('vendas', {'enabled': True}), ('vendas', {'enabled': 'rubbish'}), ('vendas', None), ('no-such-bot', {'enabled': True})):
        answer = leg.put(env, bot, body)
        assert (answer.status, answer.code) == (403, 'csrf_required'), (bot, body, answer.status, answer.code)
    assert env.calls == [] and env.rows() == [] and untouched(env)


def test_the_loopback_credential_is_no_person_and_is_refused(leg, env):
    env.session = 'loopback'
    answer = put(leg, env, True)
    assert answer.status == 403 and answer.code == 'loopback_not_human' and env.calls == [] and env.rows() == [] and untouched(env)


def test_a_bot_that_does_not_exist_is_a_404_and_writes_nothing(leg, env):
    answer = leg.put(env, 'no-such-bot', {'enabled': True})
    assert answer.status == 404 and env.calls == [] and env.rows() == [] and untouched(env)


def test_the_write_names_the_bots_profile_and_never_the_default_one(leg, env):
    assert put(leg, env, True, bot='compras').status == 200
    assert env.calls and all(call[1] == 'compras' and call[2] == 'compras' for call in env.calls), env.calls
    assert env.cfg['compras']['display']['message_reactions'] is True and untouched(env, 'compras')


# ---- (4) the audit and the failures --------------------------------------------------------------------------------------------------------------
def test_the_audit_row_is_written_before_hermes_is_asked_and_holds_the_two_booleans_and_never_the_raw_value(leg, tmp_path, monkeypatch):
    planted = copy.deepcopy(RICH)
    planted['display']['message_reactions'] = SECRETS['planted']                                 # a key a person pasted in the wrong field: the 'before' of this write
    env = Env(tmp_path, monkeypatch, planted)
    assert put(leg, env, True).status == 200
    rows = env.rows('reactions.bot_sees')
    assert rows and {row[4] for row in rows} == {'vendas'} and {row[3] for row in rows} == {'vendas'}, rows
    assert env.intents_at_write and min(env.intents_at_write) >= 1, 'Hermes was asked before the audit had the intent'
    action, bot, payload = next(p for p in env.payloads if p[0] == 'reactions.bot_sees')
    assert bot == 'vendas' and payload == {'before': False, 'after': True}, payload
    assert all(type(v) is bool for v in payload.values())
    assert 'Gg7h' not in json.dumps([rows, env.payloads], default=str) and SECRETS['hermes'] not in json.dumps(rows, default=str)


def test_the_audit_says_what_was_there_before_for_true_and_for_an_unset_key(leg, tmp_path, monkeypatch):
    start = copy.deepcopy(RICH)
    start['display'].pop('message_reactions')
    env = Env(tmp_path, monkeypatch, start)
    assert put(leg, env, True).status == 200 and put(leg, env, False).status == 200
    payloads = [p[2] for p in env.payloads if p[0] == 'reactions.bot_sees']
    assert payloads == [{'before': False, 'after': True}, {'before': True, 'after': False}], payloads


def test_a_write_hermes_refuses_is_a_502_with_none_of_its_text_the_config_unchanged_and_never_audited_as_done(leg, env):
    env.broken = {'vendas'}
    answer = put(leg, env, True)
    assert answer.status == 502 and env.cfg['vendas'] == env.initial and untouched(env)
    dumped = json.dumps(answer.body, default=str)
    assert SECRETS['hermes'] not in dumped and 'yaml' not in dumped
    outcomes = {row[1] for row in env.rows('reactions.bot_sees') if row[2] != 'intent'}          # the intent row is 'ok' by design; the RESULT row is the claim
    assert outcomes and 'ok' not in outcomes, outcomes


def test_a_value_hermes_did_not_keep_is_a_502_and_never_a_claimed_success(leg, env):
    env.keeps = False
    answer = put(leg, env, True)
    assert answer.status == 502 and env.cfg['vendas'] == env.initial


def test_a_bot_that_fails_does_not_stop_the_others_and_each_write_has_its_own_row(leg, env):
    env.broken = {'vendas'}
    results = {bot: put(leg, env, True, bot=bot).status for bot in ('vendas', 'compras')}
    assert results == {'vendas': 502, 'compras': 200}, results
    assert env.cfg['compras']['display']['message_reactions'] is True and env.cfg['vendas'] == env.initial and env.cfg['default'] == env.initial
    assert {row[4] for row in env.rows('reactions.bot_sees')} == {'vendas', 'compras'}


def test_two_writes_at_once_both_land_and_neither_loses_the_other(leg, env):
    results, errors = {}, []

    def run(bot, value):
        try:
            results[bot] = put(leg, env, value, bot=bot).status
        except BaseException as error:                                                          # an error in a thread is the test's, in the main thread
            errors.append(error)
    threads = [threading.Thread(target=run, args=(bot, value)) for bot, value in (('vendas', True), ('compras', False))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(20)
    if errors:
        raise errors[0]
    assert results == {'vendas': 200, 'compras': 200} and env.cfg['vendas']['display']['message_reactions'] is True and env.cfg['compras']['display']['message_reactions'] is False


# ---- (5) the read in GET /bots/{bot} --------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize('display, expected', [(None, False), ({}, False), ({'message_reactions': True}, True), ({'message_reactions': False}, False), ({'message_reactions': None}, False),
                                                ({'message_reactions': 'false'}, False), ({'message_reactions': 'no'}, False), ({'message_reactions': 0}, False), ({'message_reactions': ''}, False),
                                                ({'message_reactions': []}, False), ({'message_reactions': {}}, False), ('dark', False), (['x'], False)],
                         ids=['absent', 'empty', 'true', 'false', 'none', 'str-false', 'str-no', 'zero', 'empty-str', 'list', 'map', 'display-str', 'display-list'])
def test_the_state_is_the_boolean_only_an_unset_or_odd_key_reads_off_never_on(leg, tmp_path, monkeypatch, display, expected):
    start = copy.deepcopy(RICH)
    if display is None:
        start.pop('display')
    else:
        start['display'] = display
    env = Env(tmp_path, monkeypatch, start)
    answer = leg.read(env, 'vendas')
    assert answer.status == 200 and answer.body['reactions'] == {'bot_sees': expected}, answer.body


def test_the_object_is_absent_and_never_on_when_the_state_cannot_be_told(leg, env):
    env.unreadable = True
    assert 'reactions' not in leg.read(env, 'vendas').body
    env.unreadable, env.capable = False, False                                                  # a Hermes without `take_unseen_reactions`
    answer = leg.read(env, 'vendas')
    assert 'reactions' not in answer.body, 'the switch shows a state for a Hermes that cannot announce'


def test_the_read_is_the_bots_own_and_carries_nothing_else_of_the_configuration(leg, env):
    env.cfg['compras']['display']['message_reactions'] = True
    env.cfg['default']['display']['message_reactions'] = True
    first, second = leg.read(env, 'compras'), leg.read(env, 'vendas')
    assert first.body['reactions'] == {'bot_sees': True} and second.body['reactions'] == {'bot_sees': False}, 'the default profile or another Bot answered'
    assert set(first.body['reactions']) == {'bot_sees'}
    assert not any(secret in json.dumps(first.body) for secret in SECRETS.values()) and 'theme' not in json.dumps(first.body)


def test_the_state_read_after_a_write_is_the_state_written(leg, env):
    for value in (True, False, True):
        assert put(leg, env, value).status == 200
        assert leg.read(env, 'vendas').body['reactions'] == {'bot_sees': value}
