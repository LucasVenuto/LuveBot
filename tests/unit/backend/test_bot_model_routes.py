"""M-1, the three routes (contract v0.11 1.2), as written in dashboard/plugin_api.py and run against a stateful stand-in for Hermes's model handlers (the pure parts and the adapter are in test_bot_model.py):
* GET /bots/{bot}/model and /model/options: normalized, cached under the epoch, `capability_missing` before anything is asked of Hermes;
* POST /bots/{bot}/model: session and CSRF (no login, no budget gate: a loopback and a Bot the cap paused may change its model), the body checked before Hermes is called, the choice checked against the options LuveBot
  fetches itself NOW, then `expected`, then the audited write with the profile of the path; the price warning is a 409 and asking again with `confirm_expensive` writes; two tabs take turns (the second finds its
  `expected` stale). Mutations: one line changed -> red."""
import asyncio
import importlib
import re
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_bot_model as bm  # noqa: E402
import test_config_boundary_threads as threads  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()


class PluginError(Exception):
    def __init__(self, code, message, status, extra=None):
        self.code, self.status, self.extra = code, status, extra or {}
        super().__init__(message)


class State:
    """Hermes's model handlers with a memory: the current model per profile, what `set` wrote, which models ask to be confirmed."""
    def __init__(self, delay=0.0, expensive=('openai/gpt-5',), unavailable=False, set_error=None):
        self.set_error = set_error
        self.current = {'vendas': ('anthropic', 'claude-haiku-5-5'), 'compras': ('anthropic', 'claude-haiku-5-5'), 'default': ('anthropic', 'claude-haiku-5-5')}
        self.calls, self.delay, self.expensive, self.unavailable = [], delay, set(expensive), unavailable

    def install(self, monkeypatch):
        outer = self
        models = types.ModuleType('hermes_cli.web_routers.models')

        def get_model_info(profile=None):
            outer.calls.append(('info', profile))
            provider, model = outer.current[profile or 'default']
            return {'provider': provider, 'model': model, 'effective_context_length': 1000}

        async def get_model_options(profile=None, refresh=False, include_unconfigured=False, explicit_only=False):
            outer.calls.append(('options', profile, refresh))
            await asyncio.sleep(outer.delay)
            return {'providers': bm.rows({'slug': 'nous', 'models': ['hermes-4']}, {'slug': 'custom', 'models': ['llama']})}

        async def set_model_assignment(body, profile=None):
            outer.calls.append(('set', body.profile, profile, body.scope, getattr(body, 'confirm_expensive_model', None)))
            if outer.set_error is not None:
                raise outer.set_error
            if body.model in outer.expensive and not body.confirm_expensive_model:
                return {'ok': False, 'confirm_required': True, 'confirm_message': 'This model costs a lot s3cr3t'}
            outer.current[body.profile] = (body.provider, body.model)
            return {'ok': True, 'provider': body.provider, 'model': body.model, 'stale_aux': ['vision']}
        models.get_model_info, models.get_model_options, models.set_model_assignment = get_model_info, get_model_options, set_model_assignment
        web_models = types.ModuleType('hermes_cli.web_models')

        class ModelAssignment:
            def __init__(self, **kw):
                self.__dict__.update(kw)
        web_models.ModelAssignment = ModelAssignment
        if outer.unavailable:
            delattr(models, 'get_model_options')
        for name, mod in (('hermes_cli', types.ModuleType('hermes_cli')), ('hermes_cli.web_routers', types.ModuleType('hermes_cli.web_routers')), ('hermes_cli.web_routers.models', models), ('hermes_cli.web_models', web_models)):
            monkeypatch.setitem(sys.modules, name, mod)
        return self


def block(text, start, end):
    return re.search(start + r'.*?(?=' + end + ')', text, re.S).group(0)


def build(tmp_path, monkeypatch, state, edits=(), epoch=None):
    text = API
    for old, new in edits:
        assert text.count(old) == 1, old
        text = text.replace(old, new)
    state.install(monkeypatch)
    name, _ = threads.package()
    shaping = threads.variant(name, 'bot_model')
    boundary = threads.variant(name, 'hermes_boundary')
    flight = threads.variant(name, 'flight')
    audit = importlib.import_module(f'{name}.audit').AuditLog(tmp_path / f'a{next(threads._n)}.db')
    seen = {'csrf': 0, 'human': 0}

    class Response:
        def __init__(self, content, headers=None, status_code=200):
            self.content, self.status_code = content, status_code

    async def in_thread(fn, *args, **kwargs):                      # a real worker thread, with the boundary's own conversion (what the real `run_in_threadpool` does): the audited write runs `asyncio.run` there
        return await asyncio.get_running_loop().run_in_executor(None, boundary.convert(lambda: fn(*args, **kwargs)))

    async def existing(bot):
        if bot not in ('vendas', 'compras'):
            raise PluginError('bot_not_found', 'Bot not found.', 404)
        return bot

    def require_csrf(request, credential):
        seen['csrf'] += 1

    def human(request):
        seen['human'] += 1
        return types.SimpleNamespace(id='basic:ana')
    ns = {'router': types.SimpleNamespace(get=lambda path: (lambda fn: fn), post=lambda path: (lambda fn: fn), put=lambda path: (lambda fn: fn)), 'Request': object, 'JSONResponse': Response,
          '_identity': lambda request: ('basic:ana', 'cred', 'session'), '_require_csrf': require_csrf, '_human': human, '_existing': existing, '_json_body': lambda request: request.body(),
          'bot_model': shaping, 'PluginError': PluginError, '_stores': lambda: (audit, None), 'run_in_threadpool': in_thread, '_MODEL_INFO': flight.Memo(15.0), '_MODEL_OPTIONS': flight.Memo(60.0),
          '_MODEL_LOCKS': {}, '_EPOCH': epoch if epoch is not None else [0], '_REDACT': lambda t: t.replace('s3cr3t', '***'), '_HEADERS': {}, 'asyncio': asyncio, 'uuid4': __import__('uuid').uuid4}
    exec(block(text, r"def _redact_deep\(value\):", r"\n\n\nasync def _room_call"), ns)
    exec(block(text, r"async def _need_model\(\):", r"\n\n\n@router\.get\('/bots/\{bot\}/model'\)"), ns)
    for route in ("@router.get('/bots/{bot}/model')\nasync def get_bot_model", "@router.get('/bots/{bot}/model/options')\nasync def get_bot_model_options", "@router.post('/bots/{bot}/model')\nasync def set_bot_model"):
        exec(block(text, re.escape(route), r"\n\n\n(?:@router|async def |def )"), ns)
    return ns, seen, audit


def call(ns, route, bot, body=None):
    request = types.SimpleNamespace(body=lambda: _await(body))
    try:
        answer = asyncio.run(ns[route](bot, request))
        return answer.content
    except PluginError as error:
        return (error.code, error.status, error.extra)
    except Exception as error:  # noqa: BLE001
        return (getattr(error, 'code', type(error).__name__), getattr(error, 'status', None), getattr(error, 'extra', {}))


async def _await(value):
    return value


OK = {'provider': 'openrouter', 'model': 'anthropic/claude-sonnet-5', 'expected': {'provider': 'anthropic', 'model': 'claude-haiku-5-5'}}


def route_checks(tmp_path, monkeypatch, edits=()):
    # the reads: normalized, cached under the epoch, one Hermes call per Bot
    epoch = [0]
    state = State()
    ns, seen, _audit = build(tmp_path, monkeypatch, state, edits, epoch)
    assert call(ns, 'get_bot_model', 'vendas') == {'provider': 'anthropic', 'model': 'claude-haiku-5-5', 'context_length': 1000}
    call(ns, 'get_bot_model', 'vendas')
    assert [c for c in state.calls if c[0] == 'info'] == [('info', 'vendas')], state.calls                                         # the second is the cache
    epoch[0] += 1
    call(ns, 'get_bot_model', 'vendas')
    call(ns, 'get_bot_model', 'compras')
    assert [c for c in state.calls if c[0] == 'info'] == [('info', 'vendas'), ('info', 'vendas'), ('info', 'compras')], state.calls   # a change moved the epoch: read again; another Bot, another key
    options = call(ns, 'get_bot_model_options', 'vendas')
    assert [p['slug'] for p in options['providers']] == ['openrouter', 'anthropic'] and 'nous' not in str(options) and 'custom' not in str(options), options
    call(ns, 'get_bot_model_options', 'vendas')
    assert [c for c in state.calls if c[0] == 'options'] == [('options', 'vendas', False)], state.calls                              # kept; never refreshed
    assert call(ns, 'get_bot_model', 'ghost')[:2] == ('bot_not_found', 404)

    # no helpers: capability_missing before anything is asked of Hermes
    state = State(unavailable=True)
    ns, seen, _audit = build(tmp_path, monkeypatch, state, edits)
    for route, body in (('get_bot_model', None), ('get_bot_model_options', None), ('set_bot_model', OK)):
        assert call(ns, route, 'vendas', body)[:2] == ('capability_missing', 409), route
    assert state.calls == []

    # the write: the body first, then the options LuveBot fetches itself, then `expected`, then the audited write with the profile of the path
    state = State()
    ns, seen, audit = build(tmp_path, monkeypatch, state, edits)
    for bad in ({**OK, 'api_key': 'sk-LEAK'}, {**OK, 'base_url': 'http://x'}, {**OK, 'profile': 'compras'}, {**OK, 'scope': 'auxiliary'}, {k: v for k, v in OK.items() if k != 'expected'}, [], None):
        assert call(ns, 'set_bot_model', 'vendas', bad)[:2] in (('invalid_field', 422), ('bad_request', 400)), bad
    assert state.calls == [], 'a body that is not the contract is refused before Hermes is asked anything'
    assert call(ns, 'set_bot_model', 'ghost', OK)[:2] == ('bot_not_found', 404) and state.calls == []
    assert call(ns, 'set_bot_model', 'vendas', {**OK, 'model': 'not-in-the-list'})[:2] == ('model_not_offered', 422)
    assert call(ns, 'set_bot_model', 'vendas', {**OK, 'provider': 'nous', 'model': 'hermes-4'})[:2] == ('provider_not_supported', 422)
    assert call(ns, 'set_bot_model', 'vendas', {**OK, 'provider': 'custom', 'model': 'llama'})[:2] == ('provider_not_supported', 422)
    assert call(ns, 'set_bot_model', 'vendas', {**OK, 'expected': {'provider': 'anthropic', 'model': 'other'}})[:2] == ('stale', 409)
    assert not [c for c in state.calls if c[0] == 'set'] and state.current['vendas'] == ('anthropic', 'claude-haiku-5-5'), 'nothing was written by a refusal'
    assert call(ns, 'set_bot_model', 'vendas', OK) == {'provider': 'openrouter', 'model': 'anthropic/claude-sonnet-5', 'applies': 'next_message', 'stale_aux': ['vision']}
    sets = [c for c in state.calls if c[0] == 'set']
    assert sets == [('set', 'vendas', 'vendas', 'main', False)], sets                                                              # the Bot of the path in both places, scope main
    assert state.current['vendas'] == ('openrouter', 'anthropic/claude-sonnet-5') and state.current['compras'] == ('anthropic', 'claude-haiku-5-5') and state.current['default'] == ('anthropic', 'claude-haiku-5-5')
    assert seen['csrf'] > 0 and seen['human'] == 0, seen                                                                            # CSRF on the write, no login required
    order = [c[0] for c in state.calls]
    assert order[-3:] == ['options', 'info', 'set'], order                                                                          # the list first, `expected` next, the write last
    assert [a for a, *_ in audit_actions(audit)] == ['bot.model.set', 'bot.model.set']

    # the price warning: 409 with Hermes's words as plain text, nothing written; asking again with confirm_expensive writes
    state = State()
    ns, seen, audit = build(tmp_path, monkeypatch, state, edits)
    pricey = {**OK, 'model': 'openai/gpt-5'}
    got = call(ns, 'set_bot_model', 'vendas', pricey)
    assert got[:2] == ('confirm_required', 409) and got[2] == {'details': {'warning': 'This model costs a lot ***'}} and state.current['vendas'] == ('anthropic', 'claude-haiku-5-5'), got
    got = call(ns, 'set_bot_model', 'vendas', {**pricey, 'confirm_expensive': True})
    assert got['model'] == 'openai/gpt-5' and state.current['vendas'] == ('openrouter', 'openai/gpt-5') and [c for c in state.calls if c[0] == 'set'][-1][4] is True

    # the composition: a SystemExit inside Hermes's handler, in the worker's private loop, is converted by the boundary (503 for the config outage, 502 `hermes_exited` for any other exit), the audit holds the
    # intent and the result `error`, the model is as it was, and the loop of the panel is alive afterwards (a second request is answered)
    for exit_, want in ((bm.ConfigBackendUnavailable('https://u:SECRET@cfg/x'), 'config_backend_unavailable'), (SystemExit(3), 'hermes_exited')):
        state = State(set_error=exit_)
        ns, seen, audit = build(tmp_path, monkeypatch, state, edits)

        async def scenario():
            request = types.SimpleNamespace(body=lambda: _await(OK))
            try:
                await ns['set_bot_model']('vendas', request)
                first = 'answered'
            except Exception as error:  # noqa: BLE001
                first = getattr(error, 'code', type(error).__name__)
            second = (await ns['get_bot_model']('vendas', types.SimpleNamespace(body=lambda: _await(None)))).content
            return first, second
        first, second = asyncio.run(scenario())
        assert first == want and second['provider'] == 'anthropic', (exit_, first, second)
        assert state.current['vendas'] == ('anthropic', 'claude-haiku-5-5') and [o for _a, o in audit_actions(audit)] == ['ok', 'error'], (state.current, audit_actions(audit))
        assert 'SECRET' not in repr((first, second, audit_actions(audit)))

    # two tabs: they take turns, and the second finds its `expected` stale
    state = State(delay=0.05)
    ns, seen, audit = build(tmp_path, monkeypatch, state, edits)

    async def both():
        async def one(model):
            request = types.SimpleNamespace(body=lambda: _await({**OK, 'model': model}))
            try:
                return (await ns['set_bot_model']('vendas', request)).content
            except Exception as error:  # noqa: BLE001  (the module's own PluginError: its code)
                return (error.code, error.status)
        return await asyncio.gather(one('anthropic/claude-sonnet-5'), one('anthropic/claude-sonnet-5'))
    first, second = asyncio.run(both())
    results = [first, second]
    assert sum(1 for r in results if isinstance(r, dict)) == 1 and ('stale', 409) in results, results
    assert len([c for c in state.calls if c[0] == 'set']) == 1, state.calls


def audit_actions(audit):
    import sqlite3
    conn = sqlite3.connect(audit.path)
    try:
        return conn.execute('SELECT action, outcome FROM audit_log ORDER BY id').fetchall()
    finally:
        conn.close()


def test_the_model_routes_read_check_and_write_as_the_contract_says(tmp_path, monkeypatch):
    route_checks(tmp_path, monkeypatch)


ROUTE_MUTATIONS = {
    'the options are not fetched by LuveBot': [("        bot_model.check_choice(await bot_model.read_options_raw(name), provider, model)\n", "        pass\n")],
    'expected is not checked': [("        bot_model.check_expected(before, expected_provider, expected_model)\n", "")],
    'the body is read after Hermes is asked': [("    provider, model, expected_provider, expected_model, confirm = bot_model.validate_body(await _json_body(request))\n    await _need_model()\n",
                                                "    await _need_model()\n    await bot_model.read_options_raw(name)\n    provider, model, expected_provider, expected_model, confirm = bot_model.validate_body(await _json_body(request))\n")],
    'two tabs do not take turns': [("    async with _MODEL_LOCKS.setdefault(name, asyncio.Lock()):\n", "    if True:\n")],
    'a login is required': [("    actor, credential, _mode = _identity(request)\n    _require_csrf(request, credential)\n    name = await _existing(bot)\n    provider, model,",
                             "    actor = _human(request).id\n    name = await _existing(bot)\n    provider, model,")],
    'the CSRF token is not checked': [("    actor, credential, _mode = _identity(request)\n    _require_csrf(request, credential)\n    name = await _existing(bot)\n    provider, model,", "    actor, credential, _mode = _identity(request)\n    name = await _existing(bot)\n    provider, model,")],
    'the capability is not needed': [("    await _need_model()\n    audit, _meta = await run_in_threadpool(_stores)", "    audit, _meta = await run_in_threadpool(_stores)")],
    'the confirmation is ignored': [("bot_model.change, audit, actor, name, provider, model, confirm, before", "bot_model.change, audit, actor, name, provider, model, False, before")],
    'the model read is not cached under the epoch': [("_MODEL_INFO.get(('model', name), _EPOCH[0], lambda:", "_MODEL_INFO.get(('model', name), 0, lambda:")],
    'the options are not cached': [("await _MODEL_OPTIONS.get(('model-options', name), _EPOCH[0], lambda: bot_model.read_options(name))", "await bot_model.read_options(name)")],
    'the Bot is not checked': [("    _identity(request)\n    name = await _existing(bot)\n    await _need_model()\n    info =", "    _identity(request)\n    name = bot\n    await _need_model()\n    info =")],
}


@pytest.mark.parametrize('label', sorted(ROUTE_MUTATIONS))
def test_each_route_mutation_is_caught(label, tmp_path, monkeypatch):
    edits = ROUTE_MUTATIONS[label]
    assert all(API.count(old) == 1 for old, _ in edits), label                  # an anchor that moved fails HERE
    with pytest.raises(BaseException):  # noqa: B017
        route_checks(tmp_path, monkeypatch, edits)


def test_the_write_needs_no_login_and_no_budget_gate_and_the_reads_are_behind_the_session():
    post = block(API, re.escape("@router.post('/bots/{bot}/model')\nasync def set_bot_model"), r"\n\n\n@router")
    assert '_human(' not in post and '_start_gate' not in post and 'is_paused' not in post and 'budget_gate' not in post and 'work_gate' not in post          # loopback and a paused Bot may change the model
    assert post.index('_identity(request)') < post.index('_require_csrf(request, credential)') < post.index('_existing(bot)') < post.index('validate_body(') < post.index('_need_model()') < post.index('read_options_raw(name)')
    for route in ("@router.get('/bots/{bot}/model')\nasync def get_bot_model", "@router.get('/bots/{bot}/model/options')\nasync def get_bot_model_options"):
        body = block(API, re.escape(route), r"\n\n\n(?:@router|async def |def )")
        assert body.index('_identity(request)') < body.index('_existing(bot)') < body.index('_need_model()')
    code = post.split('"""')[0] + post.split('"""')[2]                                                                                 # the route without its docstring
    assert 'scope' not in code and 'api_key' not in code and 'base_url' not in code and 'profile' not in code     # nothing of the body but provider, model, expected and the confirmation reaches Hermes
    assert 'run_in_threadpool(bot_model.read_info, name)' in API and 'run_in_threadpool(bot_model.change,' in post                  # the sync handler and the audited write run in the pool
