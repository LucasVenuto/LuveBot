"""Red team (Lume, M-4, 30/10) of M-1, "change a Bot's model from its Profile" (contract v0.11 section 1, `backend/bot_model.py` and the three routes of `dashboard/plugin_api.py`), at 3e89f27.

Attacked, and what holds (plain tests): a body with an extra key in any casing, spacing or nesting; `provider`/`model`/`expected`/`confirm_expensive` of the wrong type or shape; a model id that looks like a path, has
a control character, a newline, a fullwidth or Cyrillic twin (the list check stops each); `custom`, `local` and `nous` in any casing and a slug listed twice with an endpoint on one row; the client's copy of the
options never trusted (the list is fetched again at the POST, even when the cached GET still shows the old one); the profile of the path in every call whatever the body says; the second Bot and the default profile
untouched; two tabs on one Bot take turns and two Bots do not wait for each other; the lock is let go after a failure; a config outage or a plain exit inside the audited write (the `asyncio.run` in a worker
thread) comes out as 503 `config_backend_unavailable` / 502 `hermes_exited` with the intent and the error row both in the audit and nothing written; Hermes's text never forwarded.

What does not (xfail strict: red the day it is fixed; flip it to a plain test):
  F-M1 (Medium)  the price warning is redacted BEFORE its control characters are stripped (`_plain`), so a key that a NUL splits in two is not redacted, and the strip then JOINS it: the secret reaches the
                 browser in `details.warning`. Strip first, then redact (and `_error` does not run `_redact_deep` over `extra`);
  F-M2 (Low)     the warning keeps the format characters (Tags, bidi overrides, zero-width): `_plain` strips Cc and Cs only, the provider names strip Cc, Cs and Cf. Hermes's warning carries third-party catalog text;
  F-M3 (Low)     MODEL_ID is `[\\w.:/@+-]`: `\\w` is Unicode, so a catalog that lists a model with a Cyrillic or fullwidth letter has it offered, a twin of the real one that may cost more (use `re.ASCII`);
  F-M4 (Info)    a provider `name` keeps U+2028, U+2029, the Hangul filler and the blank braille cell: a blank or line-breaking label;
  F-M5 (Info)    `refusal_of` runs inside `except Exception` and can raise (a hostile `status_code` property) — the class of F-P14-3.
Recommended, not strict: a row with an endpoint under another key name (`api_base`, `endpoint`, `baseUrl`, `url`) is offered; the contract names only `base_url` and `is_user_defined`."""
import asyncio
import re
import sys
import time
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_bot_model as bm  # noqa: E402
import test_bot_model_routes as br  # noqa: E402
import test_config_boundary_applied as applied  # noqa: E402

ConfigBackendUnavailable = bm.ConfigBackendUnavailable
HTTPException = bm.HTTPException
KEY_REDACTOR = lambda text: re.sub(r'sk-[A-Za-z0-9_-]{12,}', '***', text)       # the shape of Hermes's: a run of key characters, contiguous


def pure():
    m, _name = bm.module()
    return m


def refusal(call, *args):
    try:
        return call(*args)
    except Exception as error:  # noqa: BLE001
        return error


def code(error):
    return getattr(error, 'code', None)


# ======================================================================== the body ==================================================================================
EXTRA_KEYS = ['api_key', 'API_KEY', 'Api_Key', 'apiKey', 'api-key', 'base_url', 'BASE_URL', 'baseUrl', 'base-url', 'scope', 'Scope', 'profile', 'PROFILE', 'task', 'reasoning_effort', 'confirm_expensive_model',
              'Provider', 'MODEL', 'Expected', ' provider', 'provider ', 'provider' + chr(0x200b), 'prov' + chr(0x131) + 'der', 'x', '', '__proto__', 'constructor', 'model.default', 'provider\n']
GOOD = {'provider': 'openrouter', 'model': 'anthropic/claude-sonnet-5', 'expected': {'provider': 'anthropic', 'model': 'claude-haiku-5-5'}}


@pytest.mark.parametrize('key', EXTRA_KEYS, ids=[repr(k)[:24] for k in EXTRA_KEYS])
def test_any_other_key_is_422_in_whatever_casing_and_spacing(key):
    m = pure()
    assert code(refusal(m.validate_body, {**GOOD, key: 'sk-LEAK'})) == 'invalid_field'
    assert code(refusal(m.validate_body, {**GOOD, key: {'nested': 'sk-LEAK'}})) == 'invalid_field'
    assert code(refusal(m.validate_body, {**GOOD, key: None})) == 'invalid_field'


@pytest.mark.parametrize('expected', [{'provider': 'a', 'model': 'b', 'api_key': 'x'}, {'provider': 'a'}, {'model': 'b'}, {}, [], 'a/b', None, 5, {'Provider': 'a', 'Model': 'b'}, {'provider': {'x': 1}, 'model': 'b'},
                                      {'provider': 'a', 'model': ['b']}, {'provider': 'a\n', 'model': 'b'}, {'provider': 'a', 'model': 'b\x00'}, {'provider': 'a' * 65, 'model': 'b'}, {'provider': 'a', 'model': 'b' * 129}])
def test_expected_is_exactly_provider_and_model_each_a_clean_name_or_null(expected):
    assert code(refusal(pure().validate_body, {**GOOD, 'expected': expected})) in ('invalid_field',)


@pytest.mark.parametrize('field,value', [('provider', None), ('provider', ''), ('provider', 5), ('provider', ['a']), ('provider', {'slug': 'a'}), ('provider', 'a b'), ('provider', 'a/b'), ('provider', 'a\n'), ('provider', 'x' * 65),
                                         ('provider', chr(0x43e) + 'penrouter'), ('model', None), ('model', ''), ('model', 5), ('model', {'id': 'm'}), ('model', 'm\n'), ('model', 'm\x00x'), ('model', 'm' * 129), ('model', 'a b'),
                                         ('model', 'a\\b'), ('model', 'a;b'), ('model', 'a|b'), ('model', 'a$(id)'), ('confirm_expensive', 1), ('confirm_expensive', 'true'), ('confirm_expensive', None), ('confirm_expensive', [])])
def test_the_four_fields_are_checked_for_type_shape_and_charset(field, value):
    assert code(refusal(pure().validate_body, {**GOOD, field: value})) == 'invalid_field'


@pytest.mark.parametrize('model', ['../../etc/passwd', '/etc/passwd', 'a/../b', '..', '.', 'a//b', 'x:y@z+1', chr(0xff47) + 'pt-4', 'gpt-4' + chr(0x43e), 'gpt' + chr(0x2011) + '4'])
def test_a_path_or_a_twin_of_a_model_id_passes_the_charset_and_the_list_is_what_stops_it(model):
    m = pure()
    parsed = refusal(m.validate_body, {**GOOD, 'model': model})
    if isinstance(parsed, tuple):                                                         # accepted by the charset...
        assert code(refusal(m.check_choice, {'providers': bm.rows()}, 'openrouter', model)) == 'model_not_offered'   # ...and refused by the list
    else:
        assert code(parsed) == 'invalid_field'


def test_a_non_object_body_is_a_400_and_a_duplicate_key_is_the_last_one_json_gives():
    m = pure()
    for body in ([], 'x', 5, None, [GOOD]):
        assert code(refusal(m.validate_body, body)) == 'bad_request'
    import json
    parsed = json.loads('{"provider":"custom","provider":"anthropic","model":"claude-haiku-5-5","expected":{"provider":null,"model":null}}')
    assert m.validate_body(parsed)[0] == 'anthropic'                                       # what is validated is what is forwarded: LuveBot rebuilds the call from the validated values, never the raw body


# ======================================================================== the list ==================================================================================
@pytest.mark.parametrize('provider', ['nous', 'Nous', 'NOUS', 'nOuS', 'custom', 'Custom', 'CUSTOM', 'local', 'LOCAL', 'Local'])
def test_nous_custom_and_local_are_refused_in_any_casing(provider):
    m = pure()
    raw = {'providers': bm.rows({'slug': provider, 'models': ['hermes-4']})}
    assert code(refusal(m.check_choice, raw, provider, 'hermes-4')) == 'provider_not_supported'
    assert code(refusal(m.check_choice, raw, provider.lower(), 'hermes-4')) == 'provider_not_supported'
    assert provider.lower() not in [row['slug'].lower() for row in m.normalize_options(raw)['providers']]


def test_a_slug_listed_twice_with_an_endpoint_on_one_row_is_never_changed_from_here():
    m = pure()
    raw = {'providers': bm.rows({'slug': 'acme', 'models': ['m1']}, {'slug': 'acme', 'base_url': 'http://evil.example/v1', 'models': ['m2']}, {'slug': 'ghost', 'is_user_defined': True, 'models': ['m3']},
                                {'slug': 'strdef', 'is_user_defined': 'false', 'models': ['m4']})}
    for provider, model in (('acme', 'm1'), ('acme', 'm2'), ('ghost', 'm3'), ('strdef', 'm4')):
        assert code(refusal(m.check_choice, raw, provider, model)) == 'provider_not_supported', (provider, model)
    offered = [p['slug'] for p in m.normalize_options(raw)['providers']]
    assert 'ghost' not in offered and 'strdef' not in offered and 'openrouter' in offered


def test_what_is_offered_is_never_what_the_post_always_refuses():
    m = pure()
    raw = {'providers': bm.rows({'slug': 'acme', 'models': ['m1']}, {'slug': 'acme', 'base_url': 'http://evil.example/v1', 'models': ['m2']})}
    assert 'acme' not in [p['slug'] for p in m.normalize_options(raw)['providers']]


def test_a_row_whose_endpoint_is_an_empty_value_is_an_ordinary_provider():
    m = pure()
    raw = {'providers': bm.rows({'slug': 'plain', 'base_url': '', 'models': ['m1']}, {'slug': 'plain2', 'base_url': None, 'models': ['m1']})}
    assert m.check_choice(raw, 'plain', 'm1') is None and m.check_choice(raw, 'plain2', 'm1') is None


@pytest.mark.parametrize('key', ['api_base', 'baseUrl', 'endpoint', 'url', 'api_key', 'key_env', 'host'])
def test_a_row_with_an_endpoint_or_a_key_under_another_name_is_not_offered(key):
    m = pure()
    raw = {'providers': bm.rows({'slug': 'acme', key: 'http://evil.example/v1', 'models': ['m1']})}
    assert 'acme' not in [p['slug'] for p in m.normalize_options(raw)['providers']]


def test_the_options_hold_only_the_four_fields_and_nothing_a_row_carries_besides():
    m = pure()
    raw = {'providers': bm.rows({'slug': 'acme', 'name': 'Acme <img src=x onerror=alert(1)>', 'is_current': 'yes', 'secret': 'sk-LEAK', 'env': {'K': 'v'}, 'models': ['m1', {'id': 'm2'}, 5, None, 'm3\n', 'ok']})}
    row = next(p for p in m.normalize_options(raw)['providers'] if p['slug'] == 'acme')
    assert set(row) == {'slug', 'current', 'models', 'name'} and row['models'] == ['m1', 'ok'] and row['current'] is False and 'sk-LEAK' not in str(row)
    assert row['name'] == 'Acme <img src=x onerror=alert(1)>'                              # markup stays TEXT (the card draws text): nothing to strip, nothing interpreted


def test_the_name_loses_its_controls_bidi_zero_width_and_tag_characters():
    m = pure()
    name = 'A' + chr(0) + chr(0x202e) + chr(0x200b) + chr(0xe0041) + chr(0x2066) + 'B'
    row = m.normalize_options({'providers': bm.rows({'slug': 'acme', 'name': name, 'models': ['m1']})})['providers'][-1]
    assert row['name'] == 'AB'


def test_a_provider_name_made_of_invisible_characters_is_dropped_or_empty():
    m = pure()
    for ch in (chr(0x2028), chr(0x2029), chr(0x3164), chr(0x2800), chr(0x115f), chr(0x34f)):
        row = m.normalize_options({'providers': bm.rows({'slug': 'acme', 'name': 'Acme' + ch * 5, 'models': ['m1']})})['providers'][-1]
        assert row.get('name', '') == 'Acme', hex(ord(ch))


def test_the_model_ids_that_are_offered_are_ascii():
    m = pure()
    twins = ['gpt-4' + chr(0x43e), chr(0xff47) + 'pt-4', 'claude' + chr(0x2160), 'm' + chr(0x661)]
    offered = m.normalize_options({'providers': bm.rows({'slug': 'acme', 'models': ['ok-1', *twins]})})['providers'][-1]['models']
    assert offered == ['ok-1']


def test_bounds_30_providers_200_models_80_characters_of_name():
    m = pure()
    rows = [{'slug': f'p{i}', 'name': 'N' * 500, 'models': [f'm{j}' for j in range(500)]} for i in range(100)]
    out = m.normalize_options({'providers': rows})['providers']
    assert len(out) == 30 and all(len(p['models']) == 200 and len(p['name']) == 80 for p in out)
    assert m.normalize_options({'providers': 'x'}) == {'providers': []} and m.normalize_options(None) == {'providers': []} and m.normalize_options({'providers': [None, 5, 'x', {}, {'slug': 5}]}) == {'providers': []}


# ======================================================================== Hermes's words ============================================================================
def warning_of(m, text, redact=KEY_REDACTOR):
    error = refusal(m.result_of, {'confirm_required': True, 'confirm_message': text}, 'openrouter', 'openai/gpt-5', redact)
    assert code(error) == 'confirm_required' and error.status == 409
    return error.extra['details']['warning']


def test_the_price_warning_is_plain_text_cut_at_400_and_markup_stays_markup():
    m = pure()
    html = '<img src=x onerror=alert(1)> [Approve](https://evil) <script>x</script> ' + 'lorem ' * 200
    shown = warning_of(m, html)
    assert len(shown) <= 400 and shown.startswith('<img src=x onerror=alert(1)> [Approve](https://evil)') and '\n' not in shown
    assert warning_of(m, 'a\n\n\tb\r\n c') == 'a b c'                                       # whitespace folded
    assert warning_of(m, 'x' + chr(0) + chr(7) + 'y' + chr(0x85)) == 'xy'                   # controls dropped
    assert warning_of(m, None) == '' and warning_of(m, {'a': 'sk-' + 'A' * 20}) != '' and 'A' * 20 not in warning_of(m, {'a': 'sk-' + 'A' * 20})      # a non-string is still redacted


@pytest.mark.parametrize('split', [chr(0), chr(1), chr(0x7f), chr(0x85), chr(0xd800)], ids=['NUL', 'SOH', 'DEL', 'NEL', 'surrogate'])
def test_a_key_split_by_a_control_character_is_not_reassembled_into_the_warning(split):
    m = pure()
    key = 'sk-' + 'A' * 10 + split + 'B' * 10
    shown = warning_of(m, f'This model costs a lot {key} per token')
    assert 'A' * 10 + 'B' * 10 not in shown, shown


def test_the_warning_carries_no_invisible_or_bidi_character():
    m = pure()
    shown = warning_of(m, 'cost ' + chr(0xe0041) + chr(0x202e) + chr(0x200b) + chr(0x2066) + chr(0x2028) + ' high')
    assert not any(ord(c) in (0xe0041, 0x202e, 0x200b, 0x2066, 0x2028) for c in shown), shown


def test_nothing_of_hermes_but_the_warning_and_the_names_of_the_stale_slots_comes_back():
    m = pure()
    answer = {'ok': True, 'provider': 'openrouter', 'model': 'x', 'base_url': 'http://evil/v1', 'api_key': 'sk-LEAK', 'gateway_tools': ['a'], 'notice': '<b>hi</b>', 'stale_aux': ['vision', 'a b', {'x': 1}, 'ok_2', 'x' * 41, 'v\n'] + ['s%d' % i for i in range(20)]}
    out = m.result_of(answer, 'openrouter', 'x', KEY_REDACTOR)
    assert set(out) == {'provider', 'model', 'applies', 'stale_aux'} and out['stale_aux'][:2] == ['vision', 'ok_2'] and len(out['stale_aux']) == 10
    assert 'sk-LEAK' not in str(out) and 'evil' not in str(out) and 'hi' not in str(out)
    for bad in (None, [], 'ok', {'ok': False}, {'ok': 'yes'}, {'confirm_required': 'true', 'ok': False}):
        assert code(refusal(m.result_of, bad, 'a', 'b', KEY_REDACTOR)) == 'hermes_error'


def test_hermes_text_is_never_forwarded_whatever_its_status():
    m = pure()
    hostile = 'https://admin:s3cr3t@x/v1 sk-' + 'A' * 24
    cases = [(400, hostile, 'invalid_field'), (503, 'Restart required: ' + hostile, 'hermes_restart_required'), (503, hostile, 'hermes_error'), (500, hostile, 'hermes_error'), (404, {'detail': hostile}, 'hermes_error'),
             (503, ['Restart required'], 'hermes_error'), (None, hostile, 'hermes_error')]
    for status, detail, expected in cases:
        error = m.refusal_of(HTTPException(status, detail) if status else RuntimeError(hostile))
        assert code(error) == expected and 'admin' not in str(error) and 'sk-' not in str(error.extra) and 'sk-' not in str(error), (status, expected)


def test_refusal_of_never_raises():
    class Hostile(Exception):
        @property
        def status_code(self):
            raise RuntimeError('SECRET-TEXT')
    assert code(pure().refusal_of(Hostile())) == 'hermes_error'


# ======================================================================== the routes ================================================================================
def route(tmp_path, monkeypatch, state=None, boundary_pool=False):
    state = state or br.State()
    ns, seen, audit = br.build(tmp_path, monkeypatch, state)
    if boundary_pool:                                                                      # the product's pool is the boundary's: the conversion happens IN the worker, as it does there
        name, _ = applied.package()
        import importlib
        boundary = importlib.import_module(f'{name}.hermes_boundary')

        async def pool(fn, *args, **kwargs):
            return await asyncio.get_running_loop().run_in_executor(None, boundary.convert(lambda: fn(*args, **kwargs)))
        ns['run_in_threadpool'] = pool
        ns['HermesErrorCode'] = lambda error: getattr(error, 'code', None)
    return ns, state, audit


def audit_of(audit):
    import sqlite3
    with sqlite3.connect(audit.path if hasattr(audit, 'path') else audit._path) as conn:
        return [tuple(r) for r in conn.execute("select action, outcome, phase from audit_log order by id")] if _has(conn, 'phase') else [tuple(r) for r in conn.execute("select action, outcome from audit_log order by id")]


def _has(conn, column):
    return any(r[1] == column for r in conn.execute('pragma table_info(audit_log)'))


def test_the_profile_is_the_path_everywhere_and_the_other_bot_and_the_default_are_never_touched(tmp_path, monkeypatch):
    ns, state, _ = route(tmp_path, monkeypatch)
    state.current['compras'] = ('openrouter', 'anthropic/claude-sonnet-5')                  # the OTHER Bot already has the model we are about to ask for
    before = dict(state.current)
    assert isinstance(br.call(ns, 'set_bot_model', 'vendas', br.OK), dict)
    assert state.current['compras'] == before['compras'] and state.current['default'] == before['default'] and state.current['vendas'] == ('openrouter', 'anthropic/claude-sonnet-5')
    assert [c for c in state.calls if c[0] == 'set'] == [('set', 'vendas', 'vendas', 'main', False)]
    assert all(c[1] == 'vendas' for c in state.calls), state.calls                           # every call, the reads included, named the Bot of the path
    state.calls.clear()
    for body in ({**br.OK, 'profile': 'compras'}, {**br.OK, 'profile': 'default'}, {**br.OK, 'PROFILE': 'compras'}):
        assert br.call(ns, 'set_bot_model', 'vendas', body)[:2] == ('invalid_field', 422)
    assert state.calls == []


def test_the_client_never_gets_to_say_what_is_offered(tmp_path, monkeypatch):
    ns, state, _ = route(tmp_path, monkeypatch)
    assert 'anthropic/claude-sonnet-5' in str(br.call(ns, 'get_bot_model_options', 'vendas'))        # the cached GET shows it...
    real = state.install

    async def shrunk(profile=None, refresh=False, include_unconfigured=False, explicit_only=False):
        state.calls.append(('options', profile, refresh))
        return {'providers': bm.rows()[1:]}                                                  # ...and Hermes has just dropped OpenRouter
    sys.modules['hermes_cli.web_routers.models'].get_model_options = shrunk
    assert br.call(ns, 'set_bot_model', 'vendas', br.OK)[:2] == ('model_not_offered', 422)    # the POST asked again: the cached copy is for the eye, not for the decision
    assert state.current['vendas'] == ('anthropic', 'claude-haiku-5-5') and real


def test_two_tabs_on_one_bot_take_turns_and_two_bots_do_not_wait_for_each_other(tmp_path, monkeypatch):
    ns, state, _ = route(tmp_path, monkeypatch, br.State(delay=0.25))
    other = {**br.OK, 'expected': {'provider': 'anthropic', 'model': 'claude-haiku-5-5'}}

    async def both(bot_a, bot_b):
        request = lambda body: types.SimpleNamespace(body=lambda: br._await(body))
        started = time.time()
        results = await asyncio.gather(*[ns['set_bot_model'](b, request(other)) for b in (bot_a, bot_b)], return_exceptions=True)
        return results, time.time() - started
    same, took_same = asyncio.run(both('vendas', 'vendas'))
    kinds = sorted('ok' if hasattr(r, 'content') else code(r) for r in same)
    assert kinds == ['ok', 'stale'], kinds                                                   # the second finds its `expected` stale
    assert len([c for c in state.calls if c[0] == 'set']) == 1
    state.current.update({'vendas': ('anthropic', 'claude-haiku-5-5'), 'compras': ('anthropic', 'claude-haiku-5-5')})
    state.calls.clear()
    results, took = asyncio.run(both('vendas', 'compras'))
    assert all(hasattr(r, 'content') for r in results) and took < 0.45, (results, took)       # one lock per Bot, not one for the whole dashboard (two 0.25 s option reads in parallel)


def test_the_lock_is_let_go_when_the_write_fails(tmp_path, monkeypatch):
    ns, state, _ = route(tmp_path, monkeypatch)
    real = sys.modules['hermes_cli.web_routers.models'].set_model_assignment

    async def failing(body, profile=None):
        raise HTTPException(500, 'disk full /secret/path sk-' + 'A' * 24)
    sys.modules['hermes_cli.web_routers.models'].set_model_assignment = failing
    first = br.call(ns, 'set_bot_model', 'vendas', br.OK)
    assert first[:2] == ('hermes_error', 502) and 'secret' not in str(first) and 'sk-' not in str(first)
    sys.modules['hermes_cli.web_routers.models'].set_model_assignment = real
    assert isinstance(br.call(ns, 'set_bot_model', 'vendas', br.OK), dict)                   # the next one is not stuck behind a dead lock


@pytest.mark.parametrize('make,expected_code', [(lambda: ConfigBackendUnavailable(1), 'config_backend_unavailable'), (lambda: SystemExit(3), 'hermes_exited'), (lambda: SystemExit('SECRET-TEXT sk-' + 'A' * 24), 'hermes_exited')],
                         ids=['outage', 'plain exit', 'exit with a secret'])
def test_an_outage_or_an_exit_inside_the_audited_write_is_answered_and_audited_and_changes_nothing(tmp_path, monkeypatch, make, expected_code):
    ns, state, audit = route(tmp_path, monkeypatch, boundary_pool=True)

    async def exits(body, profile=None):                                                     # `assign` runs this in `asyncio.run`, in the pool's worker thread
        raise make()
    sys.modules['hermes_cli.web_routers.models'].set_model_assignment = exits
    answer = br.call(ns, 'set_bot_model', 'vendas', br.OK)
    assert answer[0] == expected_code, answer
    assert 'SECRET' not in str(answer) and 'sk-' not in str(answer)
    assert state.current['vendas'] == ('anthropic', 'claude-haiku-5-5')
    rows = audit_of(audit)
    assert [r[0] for r in rows] == ['bot.model.set', 'bot.model.set'] and 'error' in str(rows[-1]), rows     # the intent AND the error: an exit does not leave an intent with no result
    sys.modules['hermes_cli.web_routers.models'].set_model_assignment = types.SimpleNamespace(__call__=None)
    async def fine(body, profile=None):
        return {'ok': True, 'stale_aux': []}
    sys.modules['hermes_cli.web_routers.models'].set_model_assignment = fine
    assert isinstance(br.call(ns, 'set_bot_model', 'vendas', br.OK), dict), 'the lock and the dashboard are fine after it'


def test_the_outage_in_the_options_read_on_the_loop_is_a_503_and_a_plain_exit_there_is_the_loops_own():
    m = pure()
    name_module, _ = bm.module()

    async def outage(profile=None, refresh=False, include_unconfigured=False, explicit_only=False):
        raise ConfigBackendUnavailable(1)

    async def plain(profile=None, refresh=False, include_unconfigured=False, explicit_only=False):
        raise SystemExit(2)
    models = types.ModuleType('hermes_cli.web_routers.models')
    for fn, outcome in ((outage, 'config_backend_unavailable'), (plain, 'SystemExit')):
        models.get_model_options = fn
        sys.modules.setdefault('hermes_cli', types.ModuleType('hermes_cli'))
        sys.modules.setdefault('hermes_cli.web_routers', types.ModuleType('hermes_cli.web_routers'))
        sys.modules['hermes_cli.web_routers.models'] = models
        try:
            asyncio.run(name_module.read_options_raw('vendas'))
        except SystemExit:
            assert outcome == 'SystemExit'                                                    # by design (A-133): on the loop a real exit is the host's
        except Exception as error:  # noqa: BLE001
            assert code(error) == outcome, error
        else:
            raise AssertionError('no error')
    assert m
