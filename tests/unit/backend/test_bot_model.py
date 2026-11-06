"""M-1 (contract v0.11 section 1): change a Bot's model from its Profile, through Hermes's own handlers (`get_model_info`, `get_model_options`, `set_model_assignment`) called in process.
This file: the pure parts (what is normalized, what is accepted, what is refused and in which words), the adapter against stand-ins for the Hermes handlers (the profile is ALWAYS the Bot, the scope is `main`, no key
and no address exist for LuveBot, `refresh` is never asked) and the audited write (names only). The routes are in test_bot_model_routes.py. Hermes's own text is never forwarded but its price warning, redacted and cut.
Mutations: one line of each changed -> red."""
import asyncio
import hashlib
import re
import importlib
import itertools
import json
import sqlite3
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_config_boundary_threads as threads  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
HOSTILE = 'https://admin:s3cr3t@x/v1 <script>alert(1)</script> [Approve](https://evil)'


class HTTPException(Exception):                       # the stand-in of fastapi's: what Hermes's handlers raise
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code, self.detail = status_code, detail


class ConfigBackendUnavailable(SystemExit):
    pass


class ConfigWriteError(Exception):
    def __init__(self, code, path=None):
        super().__init__(HOSTILE)
        self.code, self.path = code, path


def module(edits=()):
    name, _ = threads.package()
    return threads.variant(name, 'bot_model', edits), name


def rows(*extra):
    return [{'slug': 'openrouter', 'name': 'OpenRouter', 'is_current': True, 'models': ['openai/gpt-5', 'anthropic/claude-sonnet-5']},
            {'slug': 'anthropic', 'name': 'Anthropic', 'is_current': False, 'models': ['claude-haiku-5-5']}, *extra]


# ---- the pure parts -----------------------------------------------------------------------------------------------------------------------------------------
def pure_checks(m):
    # info: null for what is not set, nothing else of Hermes's answer
    assert m.normalize_info({'model': 'gpt-5', 'provider': 'openrouter', 'effective_context_length': 200000, 'auto_context_length': 1, 'base_url': 'http://x', 'capabilities': {'a': 1}}) == \
        {'provider': 'openrouter', 'model': 'gpt-5', 'context_length': 200000}
    assert m.normalize_info({'model': '', 'provider': '', 'effective_context_length': 0}) == {'provider': None, 'model': None, 'context_length': None}
    for bad in (None, 'x', [], 7, {'model': 7, 'provider': ['a'], 'effective_context_length': True}, {'model': 'a b', 'provider': 'p/q', 'effective_context_length': -5}, {'model': HOSTILE, 'provider': HOSTILE}):
        assert m.normalize_info(bad) == {'provider': None, 'model': None, 'context_length': None}, bad

    # options: only what LuveBot may change, only the fields it shows, bounded
    raw = {'providers': rows(), 'model': 'x', 'provider': 'y'}
    assert m.normalize_options(raw) == {'providers': [{'slug': 'openrouter', 'current': True, 'models': ['openai/gpt-5', 'anthropic/claude-sonnet-5'], 'name': 'OpenRouter'},
                                                      {'slug': 'anthropic', 'current': False, 'models': ['claude-haiku-5-5'], 'name': 'Anthropic'}]}
    dropped = [{'slug': s, 'models': ['m']} for s in ('custom', 'local', 'nous', 'CUSTOM', 'Nous', ' local ')] + [{'slug': 'mycorp', 'models': ['m'], 'is_user_defined': True},
              {'slug': 'selfhost', 'models': ['m'], 'base_url': 'http://10.0.0.1/v1'}, {'slug': 'x y', 'models': ['m']}, {'slug': '', 'models': ['m']}, {'slug': 7}, 'text', None, {'models': ['m']}]
    assert m.normalize_options({'providers': dropped}) == {'providers': []}
    odd = m.normalize_options({'providers': [{'slug': 'p', 'name': 'a\x00b\u202ec\nd', 'is_current': 'yes', 'models': ['ok', 'a b', '../x', 'x\ny', 'é\x00', '', 'z' * 129, 7, None, ['m'], 'good.id:1/2@3+4-5', 'ünï', 'gpt-4\u043e', 'gpt-\uff14'], 'base_url': '', 'limit': {'a': 1}}]})
    assert odd == {'providers': [{'slug': 'p', 'current': False, 'models': ['ok', '../x', 'good.id:1/2@3+4-5'], 'name': 'abc d'}]}, odd   # a path-looking id is Hermes's data and matches the contract's pattern: it is only ever usable if it is OFFERED
    # a row that names an address or a key under ANY name needs one, and is never offered; the same slug listed twice with an endpoint on one row is not offered at all (the picker and the POST agree)
    for key in ('base_url', 'api_base', 'baseUrl', 'endpoint', 'url', 'host', 'api_key', 'apiKey', 'key_env', 'api_key_env'):
        assert m.normalize_options({'providers': [{'slug': 'p', 'models': ['m'], key: 'x'}]}) == {'providers': []}, key
    twice = {'providers': [{'slug': 'dup', 'models': ['a']}, {'slug': 'dup', 'models': ['a'], 'api_base': 'http://x'}, {'slug': 'Dup', 'models': ['a']}, {'slug': 'fine', 'models': ['a']}]}
    assert [p['slug'] for p in m.normalize_options(twice)['providers']] == ['fine'] and 'dup' in m.unsupported_slugs(twice)
    # provider names: no line separator, no filler, no blank cell, no format character, no control; blank after that = no name
    names = [('a\u2028b', 'ab'), ('\u3164', None), ('\u2800\u2800', None), ('x\u200by', 'xy'), ('ok\u202eevil', 'okevil'), ('t\U000e0041ag', 'tag'), ('  a   b ', 'a b'), ('a\x00b', 'ab'), ('\u2029', None), ('Anthropic', 'Anthropic')]
    for raw_name, want in names:
        item = m.normalize_options({'providers': [{'slug': 'p', 'name': raw_name, 'models': ['m']}]})['providers'][0]
        assert item.get('name') == want, (raw_name, item)
    many = m.normalize_options({'providers': [{'slug': f'p{i}', 'models': [f'm{j}' for j in range(500)]} for i in range(50)]})
    assert len(many['providers']) == 30 and all(len(p['models']) == 200 for p in many['providers'])
    for none in (None, 'x', [], {}, {'providers': None}, {'providers': 'x'}, {'providers': {'a': 1}}):
        assert m.normalize_options(none) == {'providers': []}, none
    assert m.unsupported_slugs({'providers': dropped}) >= {'custom', 'local', 'nous', 'mycorp', 'selfhost'} and m.unsupported_slugs(None) == {'custom', 'local', 'nous'}

    # the body: exactly {provider, model, expected: {provider, model}, confirm_expensive?}
    ok = {'provider': 'openrouter', 'model': 'openai/gpt-5', 'expected': {'provider': 'anthropic', 'model': 'claude-haiku-5-5'}}
    assert m.validate_body(ok) == ('openrouter', 'openai/gpt-5', 'anthropic', 'claude-haiku-5-5', False)
    assert m.validate_body({**ok, 'expected': {'provider': None, 'model': None}, 'confirm_expensive': True}) == ('openrouter', 'openai/gpt-5', None, None, True)
    for key in ('api_key', 'base_url', 'scope', 'task', 'reasoning_effort', 'profile', 'API_KEY', 'Provider', 'confirm_expensive_model', 'extra', ''):
        got = refused(lambda: m.validate_body({**ok, key: 'x'}))
        assert (got.code, got.status) == ('invalid_field', 422), key
    assert refused(lambda: m.validate_body({**ok, 'expected': {**ok['expected'], 'api_key': 'x'}})).code == 'invalid_field'            # nested
    bad_bodies = [{k: v for k, v in ok.items() if k != 'expected'}, {**ok, 'expected': None}, {**ok, 'expected': {'provider': 'a'}}, {**ok, 'expected': []}, {**ok, 'expected': {'provider': 'a', 'model': 'a b'}},
                  {**ok, 'provider': 'custom provider'}, {**ok, 'provider': None}, {**ok, 'provider': 7}, {**ok, 'model': 'a\nb'}, {**ok, 'model': 'x' * 129},
                  {**ok, 'model': ''}, {**ok, 'model': None}, {**ok, 'confirm_expensive': 'true'}, {**ok, 'confirm_expensive': 1}, {k: v for k, v in ok.items() if k != 'model'}]
    for body in bad_bodies:
        assert refused(lambda: m.validate_body(body)).code == 'invalid_field', body
    for body in (None, 'x', [], 7):
        assert refused(lambda: m.validate_body(body)).code == 'bad_request'

    # the choice: in the options LuveBot fetched, a provider it does not change is another word
    raw = {'providers': rows({'slug': 'nous', 'models': ['hermes-4']}, {'slug': 'custom', 'models': ['llama']}, {'slug': 'mycorp', 'models': ['q'], 'is_user_defined': True}, {'slug': 'selfhost', 'models': ['q'], 'base_url': 'http://x'})}
    m.check_choice(raw, 'openrouter', 'openai/gpt-5')
    m.check_choice(raw, 'anthropic', 'claude-haiku-5-5')
    for provider, model in (('nous', 'hermes-4'), ('custom', 'llama'), ('local', 'x'), ('NOUS', 'hermes-4'), ('mycorp', 'q'), ('selfhost', 'q')):
        got = refused(lambda: m.check_choice(raw, provider, model))
        assert (got.code, got.status) == ('provider_not_supported', 422) and 'Change this one in Hermes' in str(got), (provider, got.code)
    for provider, model in (('openrouter', 'claude-haiku-5-5'), ('anthropic', 'openai/gpt-5'), ('openrouter', 'nope'), ('ghost', 'x'), ('openrouter', 'OPENAI/GPT-5'), ('openrout', 'openai/gpt-5')):
        got = refused(lambda: m.check_choice(raw, provider, model))
        assert (got.code, got.status) == ('model_not_offered', 422), (provider, model, got.code)
    assert refused(lambda: m.check_choice(None, 'openrouter', 'x')).code == 'model_not_offered'
    assert refused(lambda: m.check_choice(raw, 'openrouter', '../etc/passwd')).code == 'model_not_offered'      # a path is never a choice unless Hermes itself offers it

    # expected: what the person saw as current
    m.check_expected({'provider': 'a', 'model': 'b', 'context_length': 1}, 'a', 'b')
    m.check_expected({'provider': None, 'model': None, 'context_length': None}, None, None)
    for now, saw in (({'provider': 'a', 'model': 'b'}, ('a', 'c')), ({'provider': 'a', 'model': 'b'}, ('x', 'b')), ({'provider': 'a', 'model': 'b'}, (None, None)), ({'provider': None, 'model': None}, ('a', 'b'))):
        got = refused(lambda: m.check_expected({**now, 'context_length': None}, *saw))
        assert (got.code, got.status) == ('stale', 409) and 'reload' in str(got), (now, saw)

    # the answers: a price warning as plain redacted text; the names of the helper slots; nothing else of Hermes's
    redact = lambda text: text.replace('s3cr3t', '***')  # noqa: E731
    got = refused(lambda: m.result_of({'ok': False, 'confirm_required': True, 'confirm_message': HOSTILE + ' \x00\x1b[31m' + 'w' * 800, 'api_key': 'sk-LEAK'}, 'a', 'b', redact))
    warning = got.extra['details']['warning']
    assert (got.code, got.status) == ('confirm_required', 409) and 's3cr3t' not in warning and '\x00' not in warning and '\x1b' not in warning and len(warning) <= 400 and '<script>' in warning, (got.code, warning[:60])
    assert 'sk-LEAK' not in json.dumps(got.extra) and set(got.extra) == {'details'} and set(got.extra['details']) == {'warning'}
    assert m.result_of({'ok': True, 'provider': 'zzz', 'model': 'zzz', 'base_url': 'http://x', 'gateway_tools': {'a': 1}, 'notice': HOSTILE, 'stale_aux': ['vision', 'compression', 'a b', '../x', 7, None, 'ok_2'] + [f's{i}' for i in range(30)]},
                        'openrouter', 'openai/gpt-5', redact) == {'provider': 'openrouter', 'model': 'openai/gpt-5', 'applies': 'next_message',
                                                                  'stale_aux': ['vision', 'compression', 'ok_2'] + [f's{i}' for i in range(7)]}
    assert m.result_of({'ok': True, 'stale_aux': 'vision'}, 'a', 'b', redact)['stale_aux'] == [] and m.result_of({'ok': True}, 'a', 'b', redact)['stale_aux'] == []
    for odd in (None, 'x', [], {'ok': False}, {'ok': 'yes'}, {}, {'confirm_required': 'yes', 'ok': False}):
        assert refused(lambda: m.result_of(odd, 'a', 'b', redact)).code == 'hermes_error', odd

    # F-M1: a key a NUL splits is cleaned BEFORE the redactor looks (else the cleaning joins it back and it goes out whole); F-M2: no format character, line separator or filler in Hermes's third-party text
    mask = lambda text: re.sub(r'sk-[A-Za-z]{20}', '***', text)  # noqa: E731
    for hidden in ('\x00', '\u200b', '\u202e', '\U000e0041', '\ufeff', '\u3164', '\u2028'):
        split = 'before sk-' + 'A' * 10 + hidden + 'B' * 10 + ' after'
        got = refused(lambda: m.result_of({'ok': False, 'confirm_required': True, 'confirm_message': split}, 'a', 'b', mask))
        warning = got.extra['details']['warning']
        assert 'AAAAAAAAAA' not in warning and 'BBBBBBBBBB' not in warning and warning == 'before *** after', (hidden, warning)
    noisy = refused(lambda: m.result_of({'ok': False, 'confirm_required': True, 'confirm_message': 'a\u202eb\u200bc\U000e0041d\u2028e\u3164f\u2800g\x07h'}, 'a', 'b', lambda t: t)).extra['details']['warning']
    assert noisy == 'abcdefgh', noisy
    # a failure of a Hermes call, in our words
    for error in (HTTPException(503, 'Restart required: the dashboard runs older code ' + HOSTILE), ):
        got = m.refusal_of(error)
        assert (got.code, got.status) == ('hermes_restart_required', 503) and 's3cr3t' not in str(got), got
    got = m.refusal_of(HTTPException(400, 'scope must be main ' + HOSTILE))
    assert (got.code, got.status) == ('invalid_field', 422) and 's3cr3t' not in str(got) and '<script>' not in str(got)
    for error in (HTTPException(500, HOSTILE), HTTPException(404, 'Profile not found'), HTTPException(503, 'Something else'), HTTPException(422, 'x'), RuntimeError(HOSTILE), KeyError('k'), ValueError(HOSTILE)):
        got = m.refusal_of(error)
        assert (got.code, got.status) == ('hermes_error', 502) and 's3cr3t' not in str(got), error
    locked = ConfigWriteError('config_key_locked', 'model.default')
    assert m.refusal_of(locked) is locked                                                                    # a refused config write stays what it is: the route says which (409, the key)
    boundary_error = types.SimpleNamespace(code='config_backend_unavailable')
    assert m.refusal_of(boundary_error) is boundary_error                                                       # and the boundary's own answers
    ours = m.PluginError('stale', 'x', 409)
    assert m.refusal_of(ours) is ours

    class Hostile(Exception):
        @property
        def status_code(self):
            raise RuntimeError('SECRET')

        @property
        def code(self):
            raise RuntimeError('SECRET')
    got = m.refusal_of(Hostile('x'))
    assert (got.code, got.status) == ('hermes_error', 502) and 'SECRET' not in str(got)

    class Weird(Exception):
        detail = property(lambda self: 1 / 0)
        status_code = 503
    assert m.refusal_of(Weird()).code == 'hermes_error'


def refused(call):
    try:
        call()
    except Exception as error:  # noqa: BLE001
        return error
    raise AssertionError('not refused')


def test_the_pure_parts_of_the_model_change():
    pure_checks(module()[0])


PURE_MUTATIONS = {
    'custom, local and nous are offered': ("UNSUPPORTED = frozenset({'custom', 'local', 'nous'})", 'UNSUPPORTED = frozenset()'),
    'user-defined rows are offered': ("    return bool(row.get('is_user_defined')) or any(row.get(key) for key in ENDPOINT_KEYS) or", "    return any(row.get(key) for key in ENDPOINT_KEYS) or"),
    'rows with an endpoint are offered': ("    return bool(row.get('is_user_defined')) or any(row.get(key) for key in ENDPOINT_KEYS) or", "    return bool(row.get('is_user_defined')) or"),
    'only base_url names an endpoint': ("ENDPOINT_KEYS = ('base_url', 'api_base', 'baseUrl', 'endpoint', 'url', 'host', 'api_key', 'apiKey', 'key_env', 'api_key_env')", "ENDPOINT_KEYS = ('base_url',)"),
    'a slug with an endpoint on another row is offered': ("or row['slug'].strip().lower() in blocked:", ":"),
    'the name keeps its separators': ("shown = ' '.join(_clean(name[:4096]).split())[:80] if isinstance(name, str) else ''", "shown = ' '.join(name.split())[:80] if isinstance(name, str) else ''"),
    'the warning is redacted before it is cleaned': ("    return ' '.join(redact(_clean(str(text)[:4096])).split())[:limit]", "    return ' '.join(_clean(redact(str(text)[:4096])).split())[:limit]"),
    'the warning is not cleaned at all': ("    return ''.join(c for c in text if c in '\\n\\t' or (unicodedata.category(c) not in ('Cc', 'Cs', 'Cf', 'Zl', 'Zp') and unicode_invisible.kind_of(ord(c)) is None))", '    return text'),
    'the warning keeps the invisible table': ("unicodedata.category(c) not in ('Cc', 'Cs', 'Cf', 'Zl', 'Zp') and unicode_invisible.kind_of(ord(c)) is None", "unicodedata.category(c) not in ('Cc', 'Cs', 'Cf', 'Zl', 'Zp')"),
    'refusal_of can raise': ("    try:\n        return _refusal_of(error)\n    except Exception:  # noqa: BLE001\n        return PluginError('hermes_error', 'Hermes returned an unexpected response.', 502)", "    return _refusal_of(error)"),
    'a model id is anything': ("MODEL_ID = re.compile(r'[\\w.:/@+-]{1,128}', re.ASCII)", "MODEL_ID = re.compile(r'.{1,128}')"),
    'a model id may be Unicode': ("[\\w.:/@+-]{1,128}', re.ASCII)", "[\\w.:/@+-]{1,128}')"),
    'a slug is anything': ("SLUG = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}')", "SLUG = re.compile(r'.{1,64}')"),
    'no ceiling on providers': ('PROVIDERS_MAX, MODELS_MAX, STALE_MAX, WARNING_MAX = 30, 200, 10, 400', 'PROVIDERS_MAX, MODELS_MAX, STALE_MAX, WARNING_MAX = 3000, 200, 10, 400'),
    'no ceiling on models': ('PROVIDERS_MAX, MODELS_MAX, STALE_MAX, WARNING_MAX = 30, 200, 10, 400', 'PROVIDERS_MAX, MODELS_MAX, STALE_MAX, WARNING_MAX = 30, 20000, 10, 400'),
    'the warning is not cut': ('PROVIDERS_MAX, MODELS_MAX, STALE_MAX, WARNING_MAX = 30, 200, 10, 400', 'PROVIDERS_MAX, MODELS_MAX, STALE_MAX, WARNING_MAX = 30, 200, 10, 40000'),
    'no ceiling on the helper slots': ('PROVIDERS_MAX, MODELS_MAX, STALE_MAX, WARNING_MAX = 30, 200, 10, 400', 'PROVIDERS_MAX, MODELS_MAX, STALE_MAX, WARNING_MAX = 30, 200, 1000, 400'),
    'any key is accepted in the body': ('    extra = set(body) - BODY_KEYS\n', '    extra = set()\n'),
    'an api_key is allowed': ("BODY_KEYS = {'provider', 'model', 'expected', 'confirm_expensive'}", "BODY_KEYS = {'provider', 'model', 'expected', 'confirm_expensive', 'api_key', 'base_url'}"),
    'expected is optional': ("    if not isinstance(expected, dict) or set(expected) != {'provider', 'model'}:\n        raise _bad('expected')\n", "    expected = expected if isinstance(expected, dict) else {'provider': None, 'model': None}\n"),
    'expected may carry more': ("set(expected) != {'provider', 'model'}", "not {'provider', 'model'} <= set(expected)"),
    'confirm is any value': ("    if not isinstance(confirm, bool):\n        raise _bad('confirm_expensive')\n", ''),
    'the model of another provider is offered': ("        if row['slug'] == provider and model in row['models']:", "        if model in row['models']:"),
    'any model of the provider is offered': ("        if row['slug'] == provider and model in row['models']:", "        if row['slug'] == provider:"),
    'an unsupported provider is only not offered': ("    if provider.lower() in unsupported_slugs(raw):\n        raise PluginError('provider_not_supported'", "    if False:\n        raise PluginError('provider_not_supported'"),
    'the provider check is case sensitive': ('    if provider.lower() in unsupported_slugs(raw):', '    if provider in unsupported_slugs(raw):'),
    'a stale model is accepted': ("    if (info['provider'], info['model']) != (provider, model):\n        raise PluginError('stale'", "    if False:\n        raise PluginError('stale'"),
    'a stale model is a 422': ("raise PluginError('stale', 'The model changed since you opened this; reload it.', 409)", "raise PluginError('stale', 'The model changed since you opened this; reload it.', 422)"),
    'the price warning is not redacted': ("    return ' '.join(redact(_clean(str(text)[:4096])).split())[:limit]", "    return ' '.join(_clean(str(text)[:4096]).split())[:limit]"),
    'confirm_required is not told': ("    if answer.get('confirm_required') is True:\n        raise", "    if False:\n        raise"),
    'confirm_required is a 200': ("raise ConfirmRequired('confirm_required', 'Hermes says this model is expensive; confirm to use it.', 409,", "raise ConfirmRequired('confirm_required', 'Hermes says this model is expensive; confirm to use it.', 200,"),
    'a refusal of Hermes is a success': ("    if answer.get('ok') is not True:\n        raise", "    if False:\n        raise"),
    'base_url is in the answer': ("'applies': APPLIES, 'stale_aux': names}", "'applies': APPLIES, 'stale_aux': names, 'base_url': answer.get('base_url'), 'gateway_tools': answer.get('gateway_tools')}"),
    'applies promises new conversations only': ("APPLIES = 'next_message'", "APPLIES = 'new_conversations'"),
    'applies says nothing': ("APPLIES = 'next_message'", "APPLIES = ''"),
    'the answer says what Hermes says': ("return {'provider': provider, 'model': model, 'applies'", "return {'provider': answer.get('provider'), 'model': answer.get('model'), 'applies'"),
    'a helper slot is any text': ("if _name(s, re.compile(r'[A-Za-z0-9_.-]{1,40}'))", 'if isinstance(s, str)'),
    'Hermes text is forwarded for a 400': ("return PluginError('invalid_field', 'Hermes refused this choice.', 422)", "return PluginError('invalid_field', str(detail), 422)"),
    'Hermes text is forwarded for the rest': ("    return PluginError('hermes_error', 'Hermes returned an unexpected response.', 502)\n\n\ndef result_of", "    return PluginError('hermes_error', str(error), 502)\n\n\ndef result_of"),
    'the restart is any 503': ("if status == 503 and isinstance(detail, str) and detail.startswith('Restart required'):", "if status == 503:"),
    'the restart is not told': ("if status == 503 and isinstance(detail, str) and detail.startswith('Restart required'):", "if False:"),
    'a refused config write is a plain error': ("or config_write_refusal(error) is not None:\n        return error", ":\n        return error"),
    'the boundary answers are masked': ("or getattr(error, 'code', None) in CONVERTED or config_write_refusal", "or config_write_refusal"),
    'a null model is the string': ("    return {'provider': _name(raw.get('provider'), SLUG), 'model': _name(raw.get('model'), MODEL_ID),", "    return {'provider': raw.get('provider') or None, 'model': raw.get('model') or None,"),
    'the context length is any number': ("length if isinstance(length, int) and not isinstance(length, bool) and 0 < length < 10 ** 9 else None}", "length if length else None}"),
    'the current mark is any truthy': ("'current': row.get('is_current') is True", "'current': bool(row.get('is_current'))"),
}


@pytest.mark.parametrize('label', sorted(PURE_MUTATIONS))
def test_each_pure_mutation_is_caught(label):
    old, new = PURE_MUTATIONS[label]
    m, _ = module([(old, new)])                                       # an anchor that moved fails HERE
    with pytest.raises(BaseException):  # noqa: B017
        pure_checks(m)


# ---- the adapter, against stand-ins for Hermes's handlers --------------------------------------------------------------------------------------------------
class Hermes:
    def __init__(self, info=None, options=None, answer=None, delay=0.0, info_error=None, options_error=None, set_error=None):
        self.calls, self.info, self.options, self.answer, self.delay = [], info, options, answer, delay
        self.info_error, self.options_error, self.set_error = info_error, options_error, set_error

    def install(self, monkeypatch):
        outer = self
        models = types.ModuleType('hermes_cli.web_routers.models')

        def get_model_info(profile=None):
            outer.calls.append(('info', {'profile': profile}))
            if outer.info_error:
                raise outer.info_error
            return outer.info

        async def get_model_options(profile=None, refresh=False, include_unconfigured=False, explicit_only=False):
            outer.calls.append(('options', {'profile': profile, 'refresh': refresh, 'include_unconfigured': include_unconfigured, 'explicit_only': explicit_only}))
            await asyncio.sleep(outer.delay)
            if outer.options_error:
                raise outer.options_error
            return outer.options

        async def set_model_assignment(body, profile=None):
            outer.calls.append(('set', {'body': dict(vars(body)), 'profile': profile}))
            if outer.set_error:
                raise outer.set_error
            return outer.answer
        models.get_model_info, models.get_model_options, models.set_model_assignment = get_model_info, get_model_options, set_model_assignment
        web_models = types.ModuleType('hermes_cli.web_models')

        class ModelAssignment:                          # only the fields of the real one: an unknown keyword is a TypeError, as in pydantic's `extra` rules LuveBot never relies on
            FIELDS = {'scope', 'provider', 'model', 'task', 'reasoning_effort', 'base_url', 'api_key', 'confirm_expensive_model', 'profile'}

            def __init__(self, **kw):
                assert set(kw) <= self.FIELDS, set(kw) - self.FIELDS
                self.__dict__.update(kw)
        web_models.ModelAssignment = ModelAssignment
        for name, mod in (('hermes_cli', types.ModuleType('hermes_cli')), ('hermes_cli.web_routers', types.ModuleType('hermes_cli.web_routers')), ('hermes_cli.web_routers.models', models), ('hermes_cli.web_models', web_models)):
            monkeypatch.setitem(sys.modules, name, mod)
        return self


def run(coro):
    return asyncio.run(coro)


def adapter_checks(m, monkeypatch, name):
    hermes = Hermes(info={'model': 'gpt-5', 'provider': 'openrouter', 'effective_context_length': 1000}, options={'providers': rows()}, answer={'ok': True}).install(monkeypatch)
    assert m.available() == (True, [])
    assert m.read_info('vendas') == {'provider': 'openrouter', 'model': 'gpt-5', 'context_length': 1000} and hermes.calls[-1] == ('info', {'profile': 'vendas'})
    assert run(m.read_options('vendas'))['providers'][0]['slug'] == 'openrouter'
    assert hermes.calls[-1] == ('options', {'profile': 'vendas', 'refresh': False, 'include_unconfigured': False, 'explicit_only': False}), hermes.calls[-1]      # refresh is never asked
    m.assign('vendas', 'openrouter', 'openai/gpt-5', False)
    call = hermes.calls[-1]
    assert call[0] == 'set' and call[1]['profile'] == 'vendas', call                                                                   # the Bot of the path, in both places
    assert call[1]['body'] == {'scope': 'main', 'provider': 'openrouter', 'model': 'openai/gpt-5', 'confirm_expensive_model': False, 'profile': 'vendas'}, call[1]['body']   # no key, no address, scope main
    m.assign('compras', 'anthropic', 'claude-haiku-5-5', True)
    assert hermes.calls[-1][1]['body']['confirm_expensive_model'] is True and hermes.calls[-1][1]['body']['profile'] == 'compras'
    # called on the thread of an event loop (a bug of a caller, never the pool): asyncio.run refuses with a RuntimeError instead of hanging or nesting a loop
    async def on_the_loop():
        return m.assign('vendas', 'openrouter', 'openai/gpt-5', False)
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        got = refused(lambda: run(on_the_loop()))
    assert isinstance(got, RuntimeError), got
    # the probes
    for missing, attr in (('get_model_info', 'models'), ('get_model_options', 'models'), ('set_model_assignment', 'models'), ('ModelAssignment', 'web_models')):
        hermes_ = Hermes().install(monkeypatch)
        target = sys.modules['hermes_cli.web_routers.models'] if attr == 'models' else sys.modules['hermes_cli.web_models']
        delattr(target, missing)
        assert m.available() == (False, [missing]), missing
    for gone in ('hermes_cli', 'hermes_cli.web_routers', 'hermes_cli.web_routers.models', 'hermes_cli.web_models'):                  # no Hermes at all: every probe is missing, nothing raises
        monkeypatch.setitem(sys.modules, gone, None)
    ok, names = m.available()
    assert ok is False and set(names) == {'get_model_info', 'get_model_options', 'set_model_assignment', 'ModelAssignment'}
    # failures, in our words
    Hermes(info_error=HTTPException(404, HOSTILE)).install(monkeypatch)
    got = refused(lambda: m.read_info('vendas'))
    assert (got.code, got.status) == ('hermes_error', 502) and 's3cr3t' not in str(got)
    Hermes(options_error=HTTPException(503, 'Restart required: skew ' + HOSTILE)).install(monkeypatch)
    got = refused(lambda: run(m.read_options('vendas')))
    assert (got.code, got.status) == ('hermes_restart_required', 503) and 's3cr3t' not in str(got)
    Hermes(options_error=ConfigWriteError('config_key_locked', 'model.default')).install(monkeypatch)
    assert refused(lambda: run(m.read_options('vendas'))).code == 'config_key_locked'
    # the outage of the config backend, a SystemExit on purpose, comes out as an ordinary error through the boundary's `guarded`
    Hermes(options_error=ConfigBackendUnavailable('https://u:SECRET@cfg')).install(monkeypatch)
    got = refused(lambda: run(m.read_options('vendas')))
    assert got.code == 'config_backend_unavailable' and 'SECRET' not in str(got), got
    # a catalog that does not come in time: 503 hermes_unreachable (the bound is tested short; the real one is 20 s)
    m.OPTIONS_TIMEOUT_S = 0.05
    Hermes(options={'providers': rows()}, delay=0.5).install(monkeypatch)
    got = refused(lambda: run(m.read_options('vendas')))
    assert (got.code, got.status) == ('hermes_unreachable', 503), got


def test_the_adapter_calls_hermes_with_the_bot_scope_main_and_no_key(monkeypatch):
    m, name = module()
    adapter_checks(m, monkeypatch, name)


ADAPTER_MUTATIONS = {
    'an api_key is sent': ("confirm_expensive_model=bool(confirm), profile=bot)", "confirm_expensive_model=bool(confirm), profile=bot, api_key='sk-x')"),
    'a base_url is sent': ("confirm_expensive_model=bool(confirm), profile=bot)", "confirm_expensive_model=bool(confirm), profile=bot, base_url='http://x')"),
    'the scope is auxiliary': ("ModelAssignment(scope='main',", "ModelAssignment(scope='auxiliary',"),
    'the default profile is written': ("confirm_expensive_model=bool(confirm), profile=bot)\n    return asyncio.run(set_model_assignment(body, profile=bot))", "confirm_expensive_model=bool(confirm))\n    return asyncio.run(set_model_assignment(body))"),
    'the profile is only in the body': ("return asyncio.run(set_model_assignment(body, profile=bot))", "return asyncio.run(set_model_assignment(body))"),
    'the profile is only in the call': ("confirm_expensive_model=bool(confirm), profile=bot)", "confirm_expensive_model=bool(confirm))"),
    'the confirmation is always given': ('confirm_expensive_model=bool(confirm)', 'confirm_expensive_model=True'),
    'the confirmation is never given': ('confirm_expensive_model=bool(confirm)', 'confirm_expensive_model=False'),
    'the catalog is refreshed': ('refresh=False, include_unconfigured=False', 'refresh=True, include_unconfigured=False'),
    'unconfigured providers are listed': ('include_unconfigured=False, explicit_only=False', 'include_unconfigured=True, explicit_only=False'),
    'the info is of the default profile': ('normalize_info(get_model_info(profile=bot))', 'normalize_info(get_model_info())'),
    'the options are of the default profile': ('get_model_options(profile=bot, refresh=False', 'get_model_options(profile=None, refresh=False'),
    'the catalog has no bound': ('await asyncio.wait_for(guarded(get_model_options(profile=bot, refresh=False, include_unconfigured=False, explicit_only=False)), OPTIONS_TIMEOUT_S)',
                                 'await guarded(get_model_options(profile=bot, refresh=False, include_unconfigured=False, explicit_only=False))'),
    'the outage is not converted': ('await asyncio.wait_for(guarded(get_model_options(', 'await asyncio.wait_for((get_model_options('),
    'a timeout is a 502': ("raise PluginError('hermes_unreachable', 'Hermes is unavailable.', 503) from None", "raise PluginError('hermes_error', 'Hermes is unavailable.', 502) from None"),
    'a failure of the options is forwarded': ("    except Exception as error:  # noqa: BLE001\n        raise refusal_of(error) from None\n\n\nasync def read_options(bot):", "    except KeyError as error:  # noqa: BLE001\n        raise refusal_of(error) from None\n\n\nasync def read_options(bot):"),
    'a probe is missing from the list': ("PROBES = ('get_model_info', 'get_model_options', 'set_model_assignment')", "PROBES = ('get_model_info', 'get_model_options')"),
    'the model assignment class is not probed': ("        if not hasattr(web_models, 'ModelAssignment'):\n            missing.append('ModelAssignment')", "        pass"),
}


@pytest.mark.parametrize('label', sorted(ADAPTER_MUTATIONS))
def test_each_adapter_mutation_is_caught(label, monkeypatch):
    old, new = ADAPTER_MUTATIONS[label]
    m, name = module([(old, new)])
    with pytest.raises(BaseException):  # noqa: B017
        adapter_checks(m, monkeypatch, name)


# ---- the audited write -------------------------------------------------------------------------------------------------------------------------------------
def audit_rows(path):
    conn = sqlite3.connect(path)
    try:
        return conn.execute('SELECT action, target, outcome, digest, bot FROM audit_log ORDER BY id').fetchall(), json.dumps(conn.execute('SELECT * FROM audit_log').fetchall())
    finally:
        conn.close()


def change_checks(m, name, monkeypatch, tmp_path):
    audit = importlib.import_module(f'{name}.audit').AuditLog(tmp_path / f'a{next(threads._n)}.db')
    before = {'provider': 'anthropic', 'model': 'claude-haiku-5-5', 'context_length': 1}
    redact = lambda text: text.replace('s3cr3t', '***')  # noqa: E731

    def go(hermes, confirm=False, bot='vendas'):
        hermes.install(monkeypatch)
        return m.change(audit, 'basic:ana', bot, 'openrouter', 'openai/gpt-5', confirm, before, redact, 'req_1')
    # a write: the intent before Hermes, the result after, NAMES only (the digest is of {from, to})
    hermes = Hermes(answer={'ok': True, 'stale_aux': ['vision'], 'base_url': 'http://leak', 'notice': HOSTILE})
    assert go(hermes) == {'provider': 'openrouter', 'model': 'openai/gpt-5', 'applies': 'next_message', 'stale_aux': ['vision']}
    audited, everything = audit_rows(audit.path)
    assert [(a, t, o, b) for a, t, o, _d, b in audited] == [('bot.model.set', 'vendas', 'ok', 'vendas')] * 2, audited
    payload = {'from': {'provider': 'anthropic', 'model': 'claude-haiku-5-5'}, 'to': {'provider': 'openrouter', 'model': 'openai/gpt-5'}}
    assert audited[0][3] == hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest(), audited[0]
    assert 'leak' not in everything and 's3cr3t' not in everything and 'sk-' not in everything
    assert [c[0] for c in hermes.calls] == ['set']
    # the price warning: 409 with Hermes's text as plain redacted words; the audit says intent ok + result error
    got = refused(lambda: go(Hermes(answer={'ok': False, 'confirm_required': True, 'confirm_message': 'Pricey s3cr3t <b>x</b>'})))
    assert (got.code, got.status) == ('confirm_required', 409) and got.extra == {'details': {'warning': 'Pricey *** <b>x</b>'}}, got
    assert [(a, o) for a, _t, o, _d, _b in audit_rows(audit.path)[0]][-2:] == [('bot.model.set', 'ok'), ('bot.model.set', 'denied')]      # a price warning is neither an error nor an effect
    hermes = Hermes(answer={'ok': True})
    go(hermes, confirm=True)
    assert hermes.calls[-1][1]['body']['confirm_expensive_model'] is True
    # every refusal after the intent leaves intent + result error, and says it in our words
    for error, want in ((HTTPException(503, 'Restart required: x s3cr3t'), ('hermes_restart_required', 503)), (HTTPException(400, 'bad s3cr3t'), ('invalid_field', 422)),
                        (HTTPException(500, 's3cr3t'), ('hermes_error', 502)), (RuntimeError('s3cr3t'), ('hermes_error', 502))):
        got = refused(lambda: go(Hermes(set_error=error)))
        assert (got.code, got.status) == want and 's3cr3t' not in str(got), (error, got.code)
        assert audit_rows(audit.path)[0][-1][2] == 'error' and 's3cr3t' not in audit_rows(audit.path)[1]
    locked = ConfigWriteError('config_key_locked', 'model.default')
    assert refused(lambda: go(Hermes(set_error=locked))) is locked                                  # a lock above: the refusal itself, the route says 409 and the key
    assert audit_rows(audit.path)[0][-1][2] == 'error'
    # the outage in the worker is a SystemExit: it is NOT swallowed (the boundary converts it in the pool), and the audit still says error
    with pytest.raises(ConfigBackendUnavailable):
        go(Hermes(set_error=ConfigBackendUnavailable('https://u:SECRET@cfg')))
    assert audit_rows(audit.path)[0][-1][2] == 'error'
    # a malformed answer is not a success
    assert refused(lambda: go(Hermes(answer={'ok': False}))).code == 'hermes_error'
    assert audit_rows(audit.path)[0][-1][2] == 'error'


def test_the_write_is_audited_first_with_names_only_and_every_refusal_is_ours(monkeypatch, tmp_path):
    m, name = module()
    change_checks(m, name, monkeypatch, tmp_path)


CHANGE_MUTATIONS = {
    'confirm_required is an error of the audit': ("class ConfirmRequired(PluginError, ActionDenied):", "class ConfirmRequired(PluginError):"),
    'the write is not audited': ("    return audit.act(actor, 'bot.model.set', bot, {'kind': 'ui', 'ref': origin_ref}, effect, bot=bot,\n                     payload={'from': {'provider': before['provider'], 'model': before['model']}, 'to': {'provider': provider, 'model': model}})",
                                 '    return effect()'),
    'the audit holds an address': ("'to': {'provider': provider, 'model': model}})", "'to': {'provider': provider, 'model': model, 'base_url': 'http://x'}})"),
    'the audit holds the answer': ("'to': {'provider': provider, 'model': model}})", "'to': {'provider': provider, 'model': model}, 'answer': str(before)})"),
    'the audit has no from': ("payload={'from': {'provider': before['provider'], 'model': before['model']}, 'to'", "payload={'to'"),
    'a refusal is not ours': ("        except Exception as error:  # noqa: BLE001\n            raise refusal_of(error) from None\n    return audit.act", "        except KeyError as error:  # noqa: BLE001\n            raise refusal_of(error) from None\n    return audit.act"),
    'the audit target is not the Bot': ("audit.act(actor, 'bot.model.set', bot,", "audit.act(actor, 'bot.model.set', 'x',"),
}


@pytest.mark.parametrize('label', sorted(CHANGE_MUTATIONS))
def test_each_write_mutation_is_caught(label, monkeypatch, tmp_path):
    old, new = CHANGE_MUTATIONS[label]
    m, name = module([(old, new)])
    with pytest.raises(BaseException):  # noqa: B017
        change_checks(m, name, monkeypatch, tmp_path)
