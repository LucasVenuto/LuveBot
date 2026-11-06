"""Red team (Lume, DT-4, 30/10) of "who is a person: the deployment token of Hermes `main` never is one" (contract v0.11 section 5, A-166), written BEFORE DT-1 (the `deployment` mode and 403 `credential_not_human`).

The real code of `dashboard/plugin_api.py` is run, not described: every module-level function is taken from its source with `ast` and executed in a namespace where anything the file imports is a permissive
stand-in (an object that answers every call, attribute and `await` with itself), so a route handler can be CALLED with a stand-in request and answers what its gate answers before it touches anything else.
Nothing here is typed as a list of routes: the routes come from the `@router.<verb>(...)` decorators of the source, and the human ones from WALKING them: a mutating route that answers `loopback_not_human` to a
loopback request is a human route. The gates that live in `backend/` (not in plugin_api.py) are found by an `ast` census of every comparison of the identity mode, and each is driven here.

What holds today (plain tests, so a change of DT-1 cannot break them silently): the loopback walk; the machine may tighten (pause, stop, lower, dismiss...); an exact match is the only match (written for the denylist of one pair, where the lookalike names stayed persons; since DT-1b
they are not on the allowlist and are the machine, see `test_a_lookalike_is_not_a_person_either...`); the `x-hermes-session-token` header is read only in loopback; no session in gated mode is 401 whatever the header says.
What is open (xfail strict: red the day DT-1 lands, then flip to a plain test): the pair is `deployment`, not `gated`; a `provider` or `user_id` that is not a string is never a person; every human gate answers
403 `credential_not_human` to it, with and without LUVEBOT_ALLOW_LOOPBACK_APPROVALS=1, and the same for every human route the walk finds; and no `== 'loopback'` comparison of the mode is left anywhere (it
would let a third mode through): `backend/memory.py` `_human_only` is one (a write to a Bot's memory puts text into every future prompt) and is NOT in plugin_api.py, so a DT-1 that edits only plugin_api.py
leaves the deployment token writing the Bot's memory."""
import ast
import asyncio
import builtins
import hashlib
import inspect
import os
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
API_PATH = ROOT / 'dashboard' / 'plugin_api.py'
API_SOURCE = API_PATH.read_text()
TREE = ast.parse(API_SOURCE)
TOKEN = 'deployment-secret-token-value-0123456789'
PAIR = ('session-token', 'deployment-token')
ENV = 'LUVEBOT_ALLOW_LOOPBACK_APPROVALS'


# ---- the stand-ins -----------------------------------------------------------------------------------------------------------------------------------------
class Permissive:
    """Answers every call, attribute, index, iteration, `with` and `await` with another Permissive: a route that goes past its gate lands here, harmlessly."""
    def __init__(self, name='?'):
        self._n = name

    def __call__(self, *a, **k):
        return Permissive(self._n + '()')

    def __getattr__(self, key):
        if key.startswith('__'):
            raise AttributeError(key)
        return Permissive(self._n + '.' + key)

    def __getitem__(self, key):
        return Permissive(self._n + '[]')

    def __iter__(self):
        return iter(())

    def __bool__(self):
        return True

    def __await__(self):
        if False:
            yield
        return self

    def __eq__(self, other):
        return False

    def __hash__(self):
        return 1

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def __lt__(self, o):
        return False
    __gt__ = __le__ = __ge__ = __lt__

    def __int__(self):
        return 1
    __index__ = __int__

    def __add__(self, o):
        return self
    __radd__ = __add__

    def __str__(self):
        return self._n

    def __len__(self):
        return 0


class Namespace(dict):
    def __missing__(self, key):
        if hasattr(builtins, key):
            return getattr(builtins, key)
        return Permissive(key)


class HTTPException(Exception):
    def __init__(self, status_code=500, detail=None):
        super().__init__(detail)
        self.status_code, self.detail = status_code, detail


class PluginError(Exception):
    def __init__(self, code, message='', status=400, extra=None):
        super().__init__(message)
        self.code, self.status, self.extra = code, status, extra or {}


def real_identity():
    """backend/identity.py as the plugin imports it (`from luvebot_backend import identity`), raising THIS file's PluginError: the module `plugin_api.py` calls, not a stand-in."""
    import importlib.util
    import sys
    package = types.ModuleType('dt_pkg')
    package.__path__ = []
    errors = types.ModuleType('dt_pkg.api_errors')
    errors.PluginError = PluginError
    sys.modules.update({'dt_pkg': package, 'dt_pkg.api_errors': errors})
    spec = importlib.util.spec_from_file_location('dt_pkg.identity', ROOT / 'backend' / 'identity.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class Router:
    def _decorate(self, *a, **k):
        return lambda fn: fn
    get = post = put = patch = delete = websocket = _decorate


def csrf_for(credential):
    return 'csrf-' + hashlib.sha256(str(credential).encode()).hexdigest()[:16]


_BASE = []


def build(overrides=None):
    """The namespace the real functions run in (built once: executing ~600 definitions per call made the walk minutes long). `overrides` are applied by `run`, for one call."""
    if not _BASE:
        ns = Namespace({'os': os, 'asyncio': asyncio, 'HTTPException': HTTPException, 'PluginError': PluginError, 'router': Router(), 'Request': object, '__builtins__': builtins})
        import hmac
        ns['hmac'] = hmac
        ns['identity'] = real_identity()
        for node in TREE.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                exec(compile(ast.Module([node], []), 'plugin_api', 'exec'), ns)

        async def ident(value):
            return value

        async def pool(fn, *a, **k):
            result = fn(*a, **k)
            return await result if inspect.isawaitable(result) else result

        async def empty_body(request):
            return {}
        ns.update({'_csrf_for': csrf_for, '_REDACT': lambda text: text, '_existing_bot': ident, '_existing': ident, 'validate_profile': lambda bot: bot,
                   'run_in_threadpool': pool, '_json_body': empty_body, '_stores': lambda: (Permissive('audit'), Permissive('meta')),
                   'rules': types.SimpleNamespace(Actor=lambda kind, id: types.SimpleNamespace(kind=kind, id=id), ActorKind=types.SimpleNamespace(HUMAN='HUMAN'))})
        _BASE.append(ns)
        _BASE.append(dict(ns))                                                         # the pristine copy the overrides are undone from
    return _BASE[0]


def reset():
    ns = _BASE[0]
    for key in [k for k in ns if k not in _BASE[1]]:
        del ns[key]
    ns.update(_BASE[1])


def session(provider, user_id, token=TOKEN):
    return types.SimpleNamespace(provider=provider, user_id=user_id, access_token=token)


def request(mode, sess=None, headers=None):
    """`mode`: 'gated' (the dashboard has a login gate) or 'loopback'. CSRF header already valid for the token of the session (or of the header, in loopback)."""
    headers = dict(headers or {})
    credential = (sess.access_token if sess is not None else None) if mode == 'gated' else headers.get('x-hermes-session-token', '')
    headers.setdefault('x-luvebot-csrf', csrf_for(credential))

    async def body():
        return b'{}'
    return types.SimpleNamespace(app=types.SimpleNamespace(state=types.SimpleNamespace(auth_required=(mode == 'gated'))), state=types.SimpleNamespace(session=sess), headers=headers, body=body,
                                 query_params={}, method='POST', url=types.SimpleNamespace(path='/x'), client=types.SimpleNamespace(host='127.0.0.1'))


PERSON = lambda: session('basic', 'ana', 'person-token')   # `basic` is a provider of Hermes's dashboard and on LuveBot's list (DT-1b); `password` is not
DEPLOYMENT = lambda: session(*PAIR)
LOOPBACK = lambda: request('loopback', None, {'x-hermes-session-token': TOKEN})


def gated(sess):
    return request('gated', sess)


def run(ns, name, req, **kw):
    """Call `name` with a request and report what it ANSWERED: a PluginError code, 'http<status>', 'passed', or 'err:<type>' for a stand-in that could not go on."""
    reset()
    ns.update(DRIVERS.get(name, {}))
    fn = ns[name]
    kwargs = {}
    for p in inspect.signature(fn).parameters.values():
        if p.name == 'request':
            kwargs['request'] = req
        elif p.name in kw:
            kwargs[p.name] = kw[p.name]
        elif p.default is inspect._empty and p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY):
            kwargs[p.name] = 'x'
    try:
        out = fn(**kwargs)
        if inspect.isawaitable(out):
            async def wait():
                return await out
            asyncio.run(asyncio.wait_for(wait(), 5))
        return 'passed'
    except PluginError as error:
        return error.code
    except HTTPException as error:
        return f'http{error.status_code}'
    except Exception as error:  # noqa: BLE001
        return 'err:' + type(error).__name__


def routes():
    out = []
    for node in TREE.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for d in node.decorator_list:
                if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and isinstance(d.func.value, ast.Name) and d.func.value.id == 'router':
                    out.append((d.func.attr.upper(), d.args[0].value if d.args and isinstance(d.args[0], ast.Constant) else '?', node.name))
    return out


MUTATING = [(m, p, n) for m, p, n in routes() if m != 'GET']

# Routes whose gate is conditional need a request that REACHES it: each driver makes the route's own helpers say what takes the gate (a cap raised, a surface loosened, a rule activated...).
def _async_value(value):
    async def get(*a, **k):
        return value
    return get


DRIVERS = {
    'put_budget_limit': {'_json_body': _async_value({'scope': 'global', 'period': 'day', 'cents': None}), '_budget_parts': lambda audit, meta: (types.SimpleNamespace(
        snapshot=lambda: {'limits': [{'scope': 'global', 'ref': None, 'period': 'day', 'cents': 100}]}, delete_limit=lambda *a, **k: None, set_limit=lambda *a, **k: None), Permissive('executor'))},
    'put_approval_surface': {'approval_surface': types.SimpleNamespace(parse=lambda body: ('channel', ['someone']), loosens=lambda *a: True), 'hook_store': types.SimpleNamespace(read_surface=lambda *a: {'mode': 'luvebot', 'approvers': []})},
    'patch_rule': {'rules_service': types.SimpleNamespace(validate_patch=lambda body: {'state': 'active', 'edits': None, 'id': 'r1', 'version': 1, 'accept_unapplied': False})},
    'put_inactivity_pause': {'inactivity': types.SimpleNamespace(validate=lambda body: 30, loosens=lambda *a: True, days_set=lambda *a: 7)},
}
HUMAN_SENTINELS = {'resolve_approval', 'resolve_approvals_batch', 'resolve_run_approval', 'resolve_unknown_run', 'answer_run_clarify', 'put_bot_skill', 'resume_bot_budget', 'resume_bot', 'resume_everything',
                   'return_bot_screen', 'remove_bot_hook', 'fork_session', 'create_handoff', 'promote_handoff', 'accept_routine_suggestion', 'resume_after_inactivity',
                   'put_budget_limit', 'put_approval_surface', 'patch_rule', 'put_inactivity_pause'}
MACHINE_MAY = {'pause_bot', 'pause_everything', 'start_bot_screen', 'stop_bot_screen', 'watch_bot_screen', 'take_bot_screen', 'stop_run', 'dismiss_suggestion'}           # tighten, stop, dismiss: what loopback may do


def walk_all(identity, env=None, monkeypatch=None):
    """-> {route name: what it answered} for every mutating route, with the identity ('loopback' | 'person' | 'deployment') and the opt-in variable set or not."""
    if monkeypatch is not None:
        (monkeypatch.setenv(ENV, env) if env is not None else monkeypatch.delenv(ENV, raising=False))
    out = {}
    for _method, _path, name in MUTATING:
        ns = build()
        req = {'loopback': LOOPBACK, 'person': lambda: gated(PERSON()), 'deployment': lambda: gated(DEPLOYMENT())}[identity]()
        out[name] = run(ns, name, req)
    return out


# ======================================================================== _identity: who is the machine ===============================================================
def identity(sess=None, mode='gated', headers=None):
    ns = build()
    req = request(mode, sess, headers)
    try:
        return ns['_identity'](req)
    except HTTPException as error:
        return f'http{error.status_code}'


def test_the_pair_is_the_deployment_mode_and_the_token_value_never_leaves():
    actor, credential, mode = identity(DEPLOYMENT())
    assert actor == 'session-token:deployment-token' and TOKEN not in actor and mode in ('deployment', 'gated')


def test_the_exact_pair_is_mode_deployment():
    assert identity(DEPLOYMENT())[2] == 'deployment'


LOOKALIKES = [('Session-Token', 'deployment-token'), ('session-token', 'Deployment-Token'), ('SESSION-TOKEN', 'DEPLOYMENT-TOKEN'), ('session-token ', 'deployment-token'), (' session-token', 'deployment-token'),
              ('session-token', 'deployment-token '), ('session-token', 'deployment-token\n'), ('session-token\x00', 'deployment-token'), ('session' + chr(0x2011) + 'token', 'deployment-token'),
              ('session-token', 'deployment' + chr(0x2011) + 'token'), (chr(0x455) + 'ession-token', 'deployment-token'), ('session-token', 'd' + chr(0x435) + 'ployment-token'),
              (''.join(chr(ord(c) + 0xfee0) if c.isalpha() else c for c in 'session-token'), 'deployment-token'), ('session-token', 'deployment-token-2'), ('session-token', 'deployment'),
              ('session-tokens', 'deployment-token'), ('session_token', 'deployment_token'), ('session-token', 'alice'), ('google', 'deployment-token'), ('password', 'ana')]


@pytest.mark.parametrize('pair', LOOKALIKES, ids=[repr(p)[:34] for p in LOOKALIKES])
def test_a_lookalike_is_not_a_person_either_the_provider_must_be_on_the_list_exactly(pair):
    """DT-1b (contract v0.11 5.1): the comparison is exact (no folding, trimming or prefix) on an ALLOWLIST, so a lookalike of the machine's pair is not on it and is the machine too, never a person: the cost of the
    allowlist is a refusal, never a bypass. (Before DT-1b the denylist of one pair made every lookalike a person's login.) The exact pair is the machine for its own reason, and `basic` is a person."""
    out = identity(session(*pair, token='another-token'))
    assert isinstance(out, tuple) and out[2] == 'deployment', out
    assert identity(session('basic', 'ana', 'another-token'))[2] == 'gated'


@pytest.mark.parametrize('provider,user_id,token', [(123, 'deployment-token', 't'), (['session-token'], 'deployment-token', 't'), ('session-token', b'deployment-token', 't'), ('session-token', ('deployment-token',), 't'),
                                                    (object(), object(), 't'), (True, True, 't'), ('password', 'ana', 12345), ('password', 'ana', b'tok'), ('password', 'ana', ['tok']), (1.5, 2.5, 't'),
                                                    ({'a': 1}, 'ana', 't'), (Permissive('provider'), Permissive('user'), 't')],
                         ids=['int provider', 'list provider', 'bytes user', 'tuple user', 'objects', 'bools', 'int token', 'bytes token', 'list token', 'floats', 'dict provider', 'permissive'])
def test_a_session_with_something_that_is_not_a_string_is_never_a_person(provider, user_id, token):
    out = identity(session(provider, user_id, token))
    assert out == 'http401' or (isinstance(out, tuple) and out[2] != 'gated'), out


@pytest.mark.parametrize('provider,user_id,token', [('', 'ana', 't'), ('password', '', 't'), ('password', 'ana', ''), (None, 'ana', 't'), ('password', None, 't'), ('password', 'ana', None), (0, 0, 0)])
def test_an_empty_or_missing_part_of_the_session_is_401_in_gated_mode(provider, user_id, token):
    assert identity(session(provider, user_id, token)) == 'http401'
    assert identity(None) == 'http401'


def test_the_session_header_is_read_in_loopback_only_and_is_never_a_person():
    assert identity(None, 'loopback', {'x-hermes-session-token': TOKEN})[2] == 'loopback'
    assert identity(None, 'loopback') == 'http401'
    assert identity(None, 'gated', {'x-hermes-session-token': TOKEN}) == 'http401'            # gated, no session: the header is NOT a credential (it is never read), whatever its value
    assert identity(DEPLOYMENT(), 'gated', {'x-hermes-session-token': 'other'})[0] == 'session-token:deployment-token'     # a session wins; the header is ignored
    assert identity(DEPLOYMENT(), 'loopback', {'x-hermes-session-token': TOKEN})[2] == 'loopback'      # a stray session on a loopback dashboard is not read at all: the machine


# ======================================================================== the gates ===================================================================================
def gate_answers(identity_name, env, monkeypatch):
    (monkeypatch.setenv(ENV, env) if env is not None else monkeypatch.delenv(ENV, raising=False))
    ns = build()
    req = {'loopback': LOOPBACK, 'person': lambda: gated(PERSON()), 'deployment': lambda: gated(DEPLOYMENT())}[identity_name]()
    results = {}
    for label, call in (('_human', lambda: ns['_human'](req)), ('_budget_actor(raises=True)', lambda: ns['_budget_actor'](req, raises=True))):
        try:
            call()
            results[label] = 'passed'
        except PluginError as error:
            results[label] = error.code
    results['_budget_actor(raises=False)'] = 'passed' if ns['_budget_actor'](request('gated', gated(DEPLOYMENT()).state.session) if identity_name == 'deployment' else req, raises=False) else 'none'
    return results


def test_a_person_passes_every_gate_and_loopback_is_refused_unless_the_opt_in(monkeypatch):
    assert gate_answers('person', None, monkeypatch) == {'_human': 'passed', '_budget_actor(raises=True)': 'passed', '_budget_actor(raises=False)': 'passed'}
    assert gate_answers('loopback', None, monkeypatch)['_human'] == 'loopback_not_human' and gate_answers('loopback', None, monkeypatch)['_budget_actor(raises=True)'] == 'loopback_not_human'
    assert gate_answers('loopback', None, monkeypatch)['_budget_actor(raises=False)'] == 'passed'                      # tightening is allowed in loopback
    assert gate_answers('loopback', '1', monkeypatch)['_human'] == 'passed'                                              # the owner's opt-in opens LOOPBACK


@pytest.mark.parametrize('env', [None, '1', '0', 'true', ''])
def test_the_deployment_token_is_refused_at_the_gates_with_or_without_the_opt_in(monkeypatch, env):
    got = gate_answers('deployment', env, monkeypatch)
    assert got['_human'] == 'credential_not_human' and got['_budget_actor(raises=True)'] == 'credential_not_human', got


def test_the_deployment_token_may_still_tighten(monkeypatch):
    """Pause, lower a cap, stop, dismiss: what loopback may do, the machine may do (the contract's list)."""
    assert gate_answers('deployment', None, monkeypatch)['_budget_actor(raises=False)'] == 'passed'


# ======================================================================== every human route, found by walking the router ===========================================
def test_the_router_is_read_from_its_decorators_and_is_big_enough_to_mean_something():
    assert len(routes()) > 100 and len(MUTATING) > 70 and ('POST', '/approvals/{request_id}/resolve', 'resolve_approval') in MUTATING


def test_the_human_routes_are_the_ones_that_refuse_loopback_and_the_walk_reaches_the_gate_of_each(monkeypatch):
    got = walk_all('loopback', None, monkeypatch)
    human = {name for name, answer in got.items() if answer == 'loopback_not_human'}
    assert HUMAN_SENTINELS <= human, sorted(HUMAN_SENTINELS - human)
    assert len(human) >= 20
    for name in MACHINE_MAY:
        assert got[name] != 'loopback_not_human', name                                 # what the machine may do answers no gate at all


def test_with_the_opt_in_loopback_passes_the_gates_it_can_pass_and_the_walk_shows_which(monkeypatch):
    refused = {n for n, a in walk_all('loopback', '1', monkeypatch).items() if a == 'loopback_not_human'}
    assert 'remove_bot_hook' in refused and 'resolve_approval' not in refused           # the opt-in opens approvals; removing the hook has no opt-in


def test_a_person_is_refused_by_no_human_gate_on_any_route(monkeypatch):
    got = walk_all('person', None, monkeypatch)
    assert {n for n, a in got.items() if a in ('loopback_not_human', 'credential_not_human')} == set(), got


@pytest.mark.parametrize('env', [None, '1'], ids=['no opt-in', 'opt-in 1'])
def test_every_human_route_refuses_the_deployment_token(monkeypatch, env):
    human = {n for n, a in walk_all('loopback', None, monkeypatch).items() if a == 'loopback_not_human'}
    got = walk_all('deployment', env, monkeypatch)
    wrong = {n: got[n] for n in sorted(human) if got[n] != 'credential_not_human'}
    assert not wrong, wrong


@pytest.mark.parametrize('name', sorted(MACHINE_MAY))
def test_the_machine_level_writes_do_not_answer_credential_not_human(monkeypatch, name):
    """The other half of the contract: it is refused what needs a person, not everything. Pause, stop, dismiss and the screen's watch/take/start/stop are loopback's too."""
    monkeypatch.delenv(ENV, raising=False)
    assert run(build(), name, gated(DEPLOYMENT())) != 'credential_not_human'


# ======================================================================== gates that are not in plugin_api.py ==========================================================
def mode_comparisons():
    """Every comparison of an identity mode in plugin_api.py AND backend/*.py: [(file, function, op, constant)]. A gate in a backend module is as much a gate as one in the route file."""
    found = []
    for path in [API_PATH, *sorted((ROOT / 'backend').glob('*.py'))]:
        tree = ast.parse(path.read_text())
        for fn in [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
            for node in ast.walk(fn):
                if isinstance(node, ast.Compare) and any(isinstance(x, ast.Name) and x.id == 'mode' for x in [node.left, *node.comparators]):
                    consts = [x.value for x in [node.left, *node.comparators] if isinstance(x, ast.Constant) and isinstance(x.value, str)]
                    ops = [type(o).__name__ for o in node.ops]
                    for c in consts:
                        if c in ('loopback', 'gated', 'deployment'):
                            found.append((path.name, fn.name, ops[0], c))
    return sorted(set(found))


KNOWN_SITES = {('plugin_api.py', 'put_approval_surface'), ('plugin_api.py', '_screen_act'), ('plugin_api.py', 'remove_bot_hook'), ('plugin_api.py', '_human'), ('plugin_api.py', '_budget_actor'),
               ('memory.py', '_human_only')}
AFTER_DT1C = {('identity.py', 'human_refusal'), ('plugin_api.py', '_identity')}   # the modes live in backend/identity.py (memory.py cannot import plugin_api.py)


def test_the_census_knows_every_place_that_decides_by_the_identity_mode():
    """A new gate anywhere fails here until this test knows it (and drives it): the list is built from the source. A site that goes away (DT-1c folds them into one) is not a failure."""
    sites = {(f, fn) for f, fn, _op, _c in mode_comparisons()}
    assert sites <= KNOWN_SITES | AFTER_DT1C, sorted(sites - KNOWN_SITES - AFTER_DT1C)


def test_only_human_refusal_and_identity_compare_a_mode_string_anywhere_in_the_backend():
    sites = {(f, fn) for f, fn, _op, _c in mode_comparisons()}
    assert sites <= AFTER_DT1C, sorted(sites - AFTER_DT1C)


def test_no_gate_decides_by_equality_with_loopback():
    left = [(f, fn, op, c) for f, fn, op, c in mode_comparisons() if c == 'loopback' and op in ('Eq', 'NotEq')]
    assert not left, left


def _source_of(path, name):
    tree = ast.parse(path.read_text())
    return next(n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)


def _function(path, name, **names):
    ns = Namespace({'PluginError': PluginError, **names})
    exec(compile(ast.Module([_source_of(path, name)], []), str(path), 'exec'), ns)
    return ns[name]


@pytest.mark.parametrize('mode', ['deployment'])
def test_the_memory_gate_refuses_the_deployment_mode(mode):
    gate = _function(ROOT / 'backend' / 'memory.py', '_human_only', identity=real_identity())
    with pytest.raises(PluginError) as got:
        gate(mode)
    assert got.value.code == 'credential_not_human'


def test_the_memory_gate_refuses_loopback_and_lets_a_person_through():
    gate = _function(ROOT / 'backend' / 'memory.py', '_human_only', identity=real_identity())
    with pytest.raises(PluginError) as got:
        gate('loopback')
    assert got.value.code == 'loopback_not_human'
    assert gate('gated') is None


# ======================================================================== never an Actor HUMAN for the machine ========================================================
def actor_callers():
    """Every function of plugin_api.py and backend/*.py that builds an Actor of kind HUMAN: [(file, function)]. The engine demands a HUMAN Actor at every step; labelling the machine HUMAN is the defect itself."""
    found = set()
    for path in [API_PATH, *sorted((ROOT / 'backend').glob('*.py'))]:
        tree = ast.parse(path.read_text())
        for fn in [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
            for node in ast.walk(fn):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'Actor' and node.args:
                    first = node.args[0]
                    if isinstance(first, ast.Attribute) and first.attr == 'HUMAN':
                        found.add((path.name, fn.name))
    return found


def test_a_human_actor_is_built_in_two_places_only_and_the_census_says_which():
    """A new place that builds `Actor(HUMAN, ...)` from a request fails here until it is read and given its gate: the list is built from the source."""
    assert {fn for f, fn in actor_callers() if f == 'plugin_api.py'} <= {'_human', '_human_actor', 'human_refusal'}, sorted(actor_callers())


def actor_calls(identity_name, monkeypatch, which):
    monkeypatch.delenv(ENV, raising=False)
    ns = build()
    made = []
    ns['rules'] = types.SimpleNamespace(Actor=lambda kind, id: made.append((kind, id)) or types.SimpleNamespace(kind=kind, id=id), ActorKind=types.SimpleNamespace(HUMAN='HUMAN'))
    req = {'loopback': LOOPBACK, 'person': lambda: gated(PERSON()), 'deployment': lambda: gated(DEPLOYMENT())}[identity_name]()
    try:
        ns[which](req)
        outcome = 'passed'
    except PluginError as error:
        outcome = error.code
    return outcome, made


@pytest.mark.parametrize('which', ['_human', '_human_actor'])
def test_a_person_gets_a_human_actor_and_loopback_keeps_the_v0_convention_where_it_had_it(which, monkeypatch):
    outcome, made = actor_calls('person', monkeypatch, which)
    assert outcome == 'passed' and made == [('HUMAN', 'basic:ana')]
    outcome, made = actor_calls('loopback', monkeypatch, which)
    assert (outcome, made) == (('loopback_not_human', []) if which == '_human' else ('passed', [('HUMAN', 'dashboard')]))          # `_human_actor` has no loopback gate: the v0 convention, kept


@pytest.mark.parametrize('which', ['_human', '_human_actor'])
def test_the_deployment_token_never_gets_a_human_actor(which, monkeypatch):
    outcome, made = actor_calls('deployment', monkeypatch, which)
    assert outcome == 'credential_not_human' and made == [], (outcome, made)
