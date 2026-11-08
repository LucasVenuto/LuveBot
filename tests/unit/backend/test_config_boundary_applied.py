"""P1-2 (contract v0.10 section 1.2, items 1 to 4 and the amendment): the boundary APPLIED. What is checked, and by what:
* STATIC (AST of dashboard/plugin_api.py and backend/*.py): no `run_in_threadpool` comes from starlette anywhere but inside the boundary itself (plugin_api takes the boundary's); every
  `ensure_future` / `create_task` is handed a `guarded(...)` coroutine. (The Lume's scan of Hermes route coroutines awaited on the loop is test_redteam_config_boundary.py.)
* BEHAVIOUR, with a stand-in `ConfigBackendUnavailable(SystemExit)` and the REAL code of each place, taken out of its source and run with stand-ins:
  - `Flight.run` (a child task): the outage reaches every caller as an ordinary error, the loop keeps serving, and a real `sys.exit` still goes through;
  - `detail_extras` (the three Hermes route coroutines of GET /bots/{bot}): the outage is the 503 `config_backend_unavailable`, not "Hermes returned an unexpected response";
  - `SafeRoute`: a `SystemExit` that reaches the handler is the 503 for the outage and re-raised for anything else;
  - `_background_tick`: the outage is ONE failed pass (the lease is given up, no heartbeat, one log line per class per 10 minutes) and the loop goes on; a real exit propagates.
Mutations: one line of each place changed -> red."""
import ast
import asyncio
import functools
import importlib
import importlib.util
import itertools
import logging
from pathlib import Path
import re
import sys
import textwrap
import types

import pytest

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / 'backend'
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
_n = itertools.count()


class ConfigBackendUnavailable(SystemExit):
    pass


NotAnExit = type('ConfigBackendUnavailable', (Exception,), {})


def package():
    """The real backend package under its own name, `hermes_client` stubbed (it imports Hermes) with a HermesError that carries its code/status/message like the real one. -> (name, HermesError)."""
    name = f'ap_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[name] = pkg
    spec.loader.exec_module(pkg)
    client = types.ModuleType(f'{name}.hermes_client')

    class HermesError(Exception):
        def __init__(self, code):
            self.code, self.status, self.message = code, 503 if code == 'config_backend_unavailable' else 502, 'text of ' + code
            super().__init__(self.message)
    client.HermesError = HermesError
    sys.modules[client.__name__] = client
    return name, HermesError


def source_of(rel, edits=()):
    text = (ROOT / rel).read_text()
    for old, new in edits:
        assert text.count(old) == 1, old
        text = text.replace(old, new)
    return text


def with_pool_stand_in(fn):
    """`fn()` with a stand-in for `starlette.concurrency.run_in_threadpool` in sys.modules (the unit venv has no starlette: the r24 rule; the product imports it when it is called): a worker
    thread, and an exception raised in it reaches the awaiting task as a future's, like the real one's."""
    async def stand_in(func, *args, **kwargs):
        return await asyncio.get_running_loop().run_in_executor(None, lambda: func(*args, **kwargs))
    concurrency = types.ModuleType('starlette.concurrency')
    concurrency.run_in_threadpool = stand_in
    saved = {name: sys.modules.get(name) for name in ('starlette', 'starlette.concurrency')}
    sys.modules['starlette'], sys.modules['starlette.concurrency'] = types.ModuleType('starlette'), concurrency
    try:
        return fn()
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def outcome(fn):
    try:
        return 'returned', fn()
    except BaseException as error:  # noqa: BLE001
        return 'raised', error


# ---- static ------------------------------------------------------------------------------------------------------------------------------------
@functools.lru_cache(maxsize=128)
def parsed(text):
    """The AST of a source text, kept: a mutation test changes ONE file and the other 40 are parsed once for the whole module."""
    return ast.parse(text)


def trees(plugin_text=None, extra=None):
    out = {'dashboard/plugin_api.py': plugin_text if plugin_text is not None else API}
    for path in sorted(BACKEND.glob('*.py')):
        out[f'backend/{path.name}'] = path.read_text()
    out.update(extra or {})
    return out


def stray_pool_imports(files):
    """Where `run_in_threadpool` is taken from starlette, other than inside the boundary (which imports it when called, by design)."""
    found = []
    for rel, text in files.items():
        if rel == 'backend/hermes_boundary.py':
            continue
        for node in ast.walk(parsed(text)):
            if isinstance(node, ast.ImportFrom) and (node.module or '').startswith('starlette') and any(a.name in ('run_in_threadpool', '*') for a in node.names):
                found.append((rel, node.lineno))
            if isinstance(node, ast.Import) and any(a.name.startswith('starlette.concurrency') for a in node.names):
                found.append((rel, node.lineno))
    return found


def plugin_pool_comes_from_the_boundary(text):
    return any(isinstance(n, ast.ImportFrom) and n.module == 'luvebot_backend.hermes_boundary' and any(a.name == 'run_in_threadpool' for a in n.names) for n in ast.walk(parsed(text)))


def unguarded_tasks(files):
    """asyncio's `ensure_future(x)` / `create_task(x)` (on `asyncio` or on a loop; not a Kanban `create_task`) whose argument is not a call to `guarded` (bare or through `hermes_boundary`)."""
    found = []
    for rel, text in files.items():
        for node in ast.walk(parsed(text)):
            if not isinstance(node, ast.Call):
                continue
            if isinstance(node.func, ast.Attribute):
                scheduled = node.func.attr in ('ensure_future', 'create_task') and (lambda owner: owner == 'asyncio' or owner.endswith('loop'))(ast.unparse(node.func.value))
            else:
                scheduled = isinstance(node.func, ast.Name) and node.func.id == 'ensure_future'
            if scheduled:
                arg = node.args[0] if node.args else None
                if not (isinstance(arg, ast.Call) and ast.unparse(arg.func) in ('guarded', 'hermes_boundary.guarded')):
                    found.append((rel, node.lineno))
    return found


PRIMITIVES = {'load_config', 'read_raw_config', '_config_profile_scope', 'set_config_value', 'unset_config_value', 'update_config', 'get_config', '_get_platform_tools', '_get_mcp_servers',
              '_get_approval_timeout', '_get_effective_configurable_toolsets', 'get_profile_dir'}   # Hermes's own config readers and writers: a CALL to one of these is itself a config read (B1)
GENERIC = {'run', 'read', 'write', 'feature', 'effect', 'provider'}   # names that also mean file or stream I/O: they are told apart by WHERE they are called from, not by name (B3): see `_resolve`
LEVELS = 3   # how many functions deep a reader may hide: a function that calls a reader is one (B2)
# THE CEILING (B4), on purpose. The guard follows calls it can RESOLVE to a module-level function of the tree: a bare call to a function of the same module or one imported from a module of the
# tree (`from .bot_controls import approval_timeout`, also inside a function), and a call through a module of the tree (`live_state.read(...)`), plus a direct call of a Hermes primitive. It does NOT
# follow a method of an instance (`self.x()`, `Thing(...).x()`), an alias or a partial (`f = reader; f()`), a callback passed along, or `getattr`: no scan of this kind can. It exists to keep the NEXT
# plain read from slipping onto the loop (F11), not to prove there is none.


def _stem(rel):
    return Path(rel).stem


def _imports(tree):
    """alias -> (module stem, name) for every `from <tree module> import name [as alias]` of the file, at any depth (a local import counts)."""
    found = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module is not None:
            module = node.module.rsplit('.', 1)[-1]
            for alias in node.names:
                found[alias.asname or alias.name] = (module, alias.name)
    return found


def _resolve(call, stem, imports, stems):
    """The (module stem, name) a call goes to, or a primitive's name; None when it cannot be told (a method of an instance, a call on a call...)."""
    if isinstance(call.func, ast.Name):
        name = call.func.id
        if name in PRIMITIVES:
            return ('hermes', name)
        return imports.get(name) or (stem, name)
    if isinstance(call.func, ast.Attribute):
        if call.func.attr in PRIMITIVES:
            return ('hermes', call.func.attr)
        owner = call.func.value
        if isinstance(owner, ast.Name) and owner.id in stems:
            return (owner.id, call.func.attr)                                       # `live_state.read(...)`
        if isinstance(owner, ast.Name) and owner.id in imports:                     # `from luvebot_backend import live_state` is an import of the module itself
            module, name = imports[owner.id]
            if name in stems:
                return (name, call.func.attr)
    return None


def config_readers(files):
    """{(module stem, function)} of the SYNC module-level functions of the tree that reach the Hermes config: those whose body calls a primitive, and, up to LEVELS deep, those that call one of
    them (resolved, see the ceiling)."""
    stems = {_stem(rel) for rel in files}
    defs = []
    for rel, text in files.items():
        tree = parsed(text)
        imports = _imports(tree)
        for node in tree.body:
            if isinstance(node, ast.FunctionDef):
                defs.append((_stem(rel), node, imports))
    readers = {(stem, node.name) for stem, node, imports in defs
               if any(isinstance(c, ast.Call) and (_resolve(c, stem, imports, stems) or ('', ''))[0] == 'hermes' for c in ast.walk(node))}
    for _ in range(LEVELS):
        found = {(stem, node.name) for stem, node, imports in defs if (stem, node.name) not in readers
                 and any(isinstance(c, ast.Call) and _resolve(c, stem, imports, stems) in readers for c in ast.walk(node))}
        if not found:
            break
        readers |= found
    return readers


def direct_config_readers(files):
    """Level zero, as names: the functions of the tree whose body calls a Hermes config primitive."""
    stems = {_stem(rel) for rel in files}
    out = set()
    for rel, text in files.items():
        tree = parsed(text)
        imports = _imports(tree)
        out |= {node.name for node in tree.body if isinstance(node, ast.FunctionDef)
                and any(isinstance(c, ast.Call) and (_resolve(c, _stem(rel), imports, stems) or ('', ''))[0] == 'hermes' for c in ast.walk(node))}
    return out


def sync_config_reads_in_coroutines(files):
    """[(file, line, call)]: a call, inside an `async def` and outside run_in_threadpool / guarded / convert / asyncio.run / a lambda, to a Hermes config primitive (B1) or to a function that reaches
    one, up to LEVELS functions deep (B2), resolved by module and name so that `live_state.read` is not `upload.read` (B3). A sync read on the event loop: during a remote-config outage its
    SystemExit stops the loop (F11). Its reach ends where the ceiling above says (B4)."""
    stems, readers = {_stem(rel) for rel in files}, config_readers(files)
    wrappers, found = {'guarded', 'hermes_boundary.guarded', 'convert', 'hermes_boundary.convert', 'asyncio.run'}, []
    for rel, text in files.items():
        tree = parsed(text)
        imports, stem = _imports(tree), _stem(rel)

        def walk(node, in_async, wrapped):
            for child in ast.iter_child_nodes(node):
                if isinstance(child, ast.Lambda):
                    continue
                inside = True if isinstance(child, ast.AsyncFunctionDef) else False if isinstance(child, ast.FunctionDef) else in_async
                shield = wrapped
                if isinstance(child, ast.Call):
                    fn = ast.unparse(child.func)
                    target = _resolve(child, stem, imports, stems)
                    if fn in wrappers or fn.endswith('run_in_threadpool'):
                        shield = True
                    elif inside and not wrapped and target is not None and (target[0] == 'hermes' or target in readers):
                        found.append((rel, child.lineno, fn))
                walk(child, inside, shield)
        walk(tree, False, False)
    return found


def static_checks(files):
    assert stray_pool_imports(files) == [], stray_pool_imports(files)
    assert plugin_pool_comes_from_the_boundary(files['dashboard/plugin_api.py'])
    assert unguarded_tasks(files) == [], unguarded_tasks(files)
    assert sync_config_reads_in_coroutines(files) == [], sync_config_reads_in_coroutines(files)


def test_the_tree_takes_run_in_threadpool_from_the_boundary_and_guards_every_task():
    static_checks(trees())
    sites = [(rel, n) for rel, n in unguarded_tasks({rel: re.sub(r'guarded\(', '(', text) for rel, text in trees().items() if rel != 'backend/hermes_boundary.py'})]
    assert sorted(rel for rel, _ in sites) == ['backend/flight.py', 'dashboard/plugin_api.py']      # the scan is not blind: the sites of the contract (and, BA-5a, the Bots' tool-set state, one task per Bot) are what it finds without the guard


@pytest.mark.parametrize('label,rel,old,new', [
    ('a stray starlette import in plugin_api', 'dashboard/plugin_api.py', 'from luvebot_backend.api_errors import PluginError\n', 'from luvebot_backend.api_errors import PluginError\nfrom starlette.concurrency import run_in_threadpool\n'),
    ('plugin_api no longer takes the boundary\'s pool', 'dashboard/plugin_api.py', 'from luvebot_backend.hermes_boundary import guarded, run_in_threadpool', 'from luvebot_backend.hermes_boundary import guarded'),
    ('the shared toolsets task is not guarded', 'dashboard/plugin_api.py', 'asyncio.ensure_future(guarded(run_in_threadpool(live_state.toolset_facts, name)))', 'asyncio.ensure_future(run_in_threadpool(live_state.toolset_facts, name))'),
    ('the approval wait is read on the loop', 'backend/bots.py', 'await run_in_threadpool(approval_timeout, name)', 'approval_timeout(name)'),
    ('the Flight task is not guarded', 'backend/flight.py', 'asyncio.ensure_future(guarded(make()))', 'asyncio.ensure_future(make())'),
    ('a stray starlette import in a backend module', 'backend/flight.py', 'import asyncio\n', 'import asyncio\nfrom starlette.concurrency import run_in_threadpool\n'),
])
def test_each_static_mutation_is_caught(label, rel, old, new):
    files = trees()
    assert files[rel].count(old) == 1, old
    files[rel] = files[rel].replace(old, new)
    with pytest.raises(AssertionError):
        static_checks(files)


# ---- Flight ------------------------------------------------------------------------------------------------------------------------------------
def flight_checks(Flight, HermesError):
    async def scenario():
        flight = Flight()

        async def outage():
            raise ConfigBackendUnavailable('https://u:SECRET@cfg/x')

        async def plain_exit():
            raise SystemExit(3)

        async def fine():
            return 'served'
        got = []
        for make in (outage, outage):                                                     # the second call is its own flight (the first one is delivered and gone)
            try:
                await flight.run('k', 0, make)
            except BaseException as error:  # noqa: BLE001
                got.append(error)
        alive = await flight.run('k2', 0, fine)                                           # the loop is still serving
        return got, alive
    loop = asyncio.new_event_loop()
    try:
        kind, value = outcome(lambda: loop.run_until_complete(scenario()))
    finally:
        loop.close()
    assert kind == 'returned', (kind, value)
    got, alive = value
    assert alive == 'served' and [type(e) for e in got] == [HermesError, HermesError] and all(e.code == 'config_backend_unavailable' for e in got), got
    assert all(e.__cause__ is None and e.__context__ is None for e in got)


def load_flight(edits=()):
    name, HermesError = package()
    text = source_of('backend/flight.py', edits)
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.flight_under_test', loader=None))
    module.__package__ = name
    exec(compile(text, 'flight.py', 'exec'), module.__dict__)
    return module.Flight, HermesError


def test_a_flight_turns_the_outage_into_an_ordinary_error_for_every_caller():
    flight_checks(*load_flight())


def test_a_flight_mutation_without_the_guard_is_caught():
    Flight, HermesError = load_flight([('asyncio.ensure_future(guarded(make()))', 'asyncio.ensure_future(make())')])
    with pytest.raises(BaseException):  # noqa: B017 - the outage comes out as a SystemExit
        flight_checks(Flight, HermesError)


# ---- detail_extras -----------------------------------------------------------------------------------------------------------------------------
def detail_checks(name, HermesError, edits=()):
    text = source_of('backend/bots.py', edits)
    body = re.search(r'async def detail_extras\(name\):.*?(?=\n\ndef _plain)', text, re.S).group(0)
    body = body.replace('    from .bot_controls import approval_timeout\n', '')
    boundary = importlib.import_module(f'{name}.hermes_boundary')

    def stub(modname, **names):
        module = types.ModuleType(modname)
        module.__dict__.update(names)
        sys.modules[modname] = module
    saved = {m: sys.modules.get(m) for m in ('hermes_cli', 'hermes_cli.web_routers', 'hermes_cli.web_routers.mcp', 'hermes_cli.web_routers.profiles', 'hermes_cli.web_routers.tools')}

    def run(soul, toolsets, mcp, timeout=lambda n: 300):
        async def get_profile_soul(n):
            return await soul()

        async def get_toolsets(profile):
            return await toolsets()

        async def list_mcp_servers(profile):
            return await mcp()
        stub('hermes_cli', __path__=[])
        stub('hermes_cli.web_routers', __path__=[])
        stub('hermes_cli.web_routers.mcp', list_mcp_servers=list_mcp_servers)
        stub('hermes_cli.web_routers.profiles', get_profile_soul=get_profile_soul)
        stub('hermes_cli.web_routers.tools', get_toolsets=get_toolsets)
        ns = {'guarded': boundary.guarded, 'run_in_threadpool': boundary.run_in_threadpool, 'CONVERTED': boundary.CONVERTED, 'HermesError': HermesError, 'approval_timeout': timeout}
        exec(textwrap.dedent(body), ns)
        loop = asyncio.new_event_loop()
        try:
            return with_pool_stand_in(lambda: outcome(lambda: loop.run_until_complete(ns['detail_extras'](name))))
        finally:
            loop.close()

    async def fine_soul():
        return {'content': 'soul'}

    async def fine_sets():
        return [{'name': 'terminal', 'enabled': True}]

    async def fine_mcp():
        return {'servers': []}

    async def outage():
        raise ConfigBackendUnavailable('https://u:SECRET@cfg/x')

    async def plain_exit():
        raise SystemExit(3)

    async def broken():
        raise KeyError('x')
    try:
        kind, got = run(fine_soul, fine_sets, fine_mcp)
        assert kind == 'returned' and got['soul'] == 'soul' and got['toolsets'] == [{'name': 'terminal', 'enabled': True}] and got['approval_timeout'] == 300, (kind, got)
        for position in range(3):                                                         # the outage in any of the three: the 503, not "unexpected response"
            args = [fine_soul, fine_sets, fine_mcp]
            args[position] = outage
            kind, got = run(*args)
            assert kind == 'raised' and type(got) is HermesError and got.code == 'config_backend_unavailable' and got.status == 503, (position, kind, got)
        def timeout_outage(n):                                                           # F11: the Bot's wait is a SYNC read of the config; it runs in a thread, and the outage is the 503 too
            raise ConfigBackendUnavailable('https://u:SECRET@cfg/x')
        kind, got = run(fine_soul, fine_sets, fine_mcp, timeout_outage)
        assert kind == 'raised' and type(got) is HermesError and got.code == 'config_backend_unavailable' and got.status == 503, (kind, got)
        kind, got = run(fine_soul, fine_sets, fine_mcp, lambda n: (_ for _ in ()).throw(SystemExit(3)))
        assert kind == 'raised' and type(got) is HermesError and got.code == 'hermes_exited' and got.status == 502, (kind, got)   # P1-8: a plain exit in that worker is the 502, not a mute dashboard
        kind, got = run(broken, fine_sets, fine_mcp)                                      # any other failure is still "Hermes returned an unexpected response"
        assert kind == 'raised' and type(got) is HermesError and got.code == 'hermes_error', (kind, got)
        kind, got = run(fine_soul, plain_exit, fine_mcp)                                  # a real exit still propagates
        assert kind == 'raised' and type(got) is SystemExit and got.code == 3, (kind, got)
    finally:
        for module, previous in saved.items():
            if previous is None:
                sys.modules.pop(module, None)
            else:
                sys.modules[module] = previous


def test_detail_extras_tells_the_outage_as_a_503_and_never_swallows_a_real_exit():
    name, HermesError = package()
    detail_checks(name, HermesError)


DETAIL_MUTATIONS = {
    'the soul read is not guarded': [('(await guarded(get_profile_soul(name)))', '(await get_profile_soul(name))')],
    'the toolsets read is not guarded': [('await guarded(get_toolsets(profile=name))', 'await get_toolsets(profile=name)')],
    'the mcp read is not guarded': [('(await guarded(list_mcp_servers(profile=name)))', '(await list_mcp_servers(profile=name))')],
    'the approval wait is read on the loop': [("await run_in_threadpool(approval_timeout, name)", "approval_timeout(name)")],
    'the outage is told as an unexpected response': [("        if error.code in CONVERTED:\n            raise  # Hermes's configuration service is out (503) or Hermes stopped the operation (502): say so, not \"Hermes returned an unexpected response\"\n", '')],
    'a stopped operation is told as an unexpected response': [("        if error.code in CONVERTED:\n", "        if error.code == 'config_backend_unavailable':\n")],
}


@pytest.mark.parametrize('label', sorted(DETAIL_MUTATIONS))
def test_each_detail_extras_mutation_is_caught(label):
    name, HermesError = package()
    source_of('backend/bots.py', DETAIL_MUTATIONS[label])                                  # the anchor must exist
    with pytest.raises(BaseException):  # noqa: B017
        detail_checks(name, HermesError, DETAIL_MUTATIONS[label])


# ---- SafeRoute ---------------------------------------------------------------------------------------------------------------------------------
class _Response:
    def __init__(self):
        self.headers = {}


def saferoute_checks(name, HermesError, edits=()):
    text = source_of('dashboard/plugin_api.py', edits)
    body = re.search(r'class SafeRoute\(APIRoute\):.*?(?=\n\ndef _unexpected)', text, re.S).group(0)
    boundary = importlib.import_module(f'{name}.hermes_boundary')

    class APIRoute:
        original = None
        path = '/bots/{bot}'

        def get_route_handler(self):
            return type(self).original

    class _Plain(Exception):
        pass
    ns = {'APIRoute': APIRoute, '_SERVED': [False], 'time': __import__('time'), '_foreign_request': lambda r: None, '_identity': lambda r: None,
          '_error': lambda code, message, status, extra=None: (code, message, status), 'hermes_compat': types.SimpleNamespace(), 'run_in_threadpool': None,
          '_EPOCH': [0], '_HEADERS': {}, 'HermesError': HermesError, 'PluginError': type('PluginError', (Exception,), {}), 'BudgetUnavailable': type('BudgetUnavailable', (Exception,), {}),
          'AuditUnavailable': type('AuditUnavailable', (Exception,), {}), 'RequestValidationError': type('RequestValidationError', (Exception,), {}),
          'HTTPException': type('HTTPException', (Exception,), {}), 'sqlite3': importlib.import_module('sqlite3'), '_unexpected': lambda *a: None, 'hermes_boundary': boundary,
          'redaction': types.SimpleNamespace(budgeted=lambda handler: handler)}
    exec(compile(textwrap.dedent(body), 'saferoute', 'exec'), ns)
    request = types.SimpleNamespace(method='POST', query_params={}, url=None)

    def handle(raises):
        async def original(req):
            if isinstance(raises, BaseException):
                raise raises
            return _Response()
        APIRoute.original = staticmethod(original)
        handler = ns['SafeRoute']().get_route_handler()
        loop = asyncio.new_event_loop()
        try:
            return outcome(lambda: loop.run_until_complete(handler(request)))
        finally:
            loop.close()
    kind, got = handle(ConfigBackendUnavailable('https://u:SECRET@cfg/x'))
    assert kind == 'returned' and got == ('config_backend_unavailable', 'text of config_backend_unavailable', 503), (kind, got)
    assert ns['_EPOCH'][0] == 2                                                           # the change counter still moved before and after (the `finally` ran)
    kind, got = handle(HermesError('config_backend_unavailable'))                         # the converted form (from the boundary's pool): the same answer through the existing clause
    assert kind == 'returned' and got[0] == 'config_backend_unavailable' and got[2] == 503, (kind, got)
    kind, got = handle(HermesError('hermes_exited'))                                      # P1-8: what the boundary makes of a plain exit in a worker: its own answer through the same clause
    assert kind == 'returned' and got[0] == 'hermes_exited', (kind, got)
    for exit_ in (SystemExit(3), KeyboardInterrupt(), GeneratorExit()):                   # in the loop's own thread a plain exit is NOT ours to answer, nor anything else
        kind, got = handle(exit_)
        assert kind == 'raised' and got is exit_, (exit_, kind, got)
    kind, got = handle(NotAnExit('x'))                                                    # a name without a SystemExit is an ordinary error: the old answer
    assert kind == 'returned' and got[0] == 'hermes_unreachable', (kind, got)


def test_saferoute_answers_the_outage_with_a_503_and_lets_any_other_exit_through():
    saferoute_checks(*package())


SAFEROUTE_MUTATIONS = {
    'every SystemExit is swallowed': [("                if not hermes_boundary.is_config_unavailable(error):\n                    raise\n                unavailable", "                unavailable")],
    'the outage is never recognized': [("                if not hermes_boundary.is_config_unavailable(error):\n                    raise\n", "                raise\n")],
    'the clause is gone': [("            except SystemExit as error:\n                # A Hermes call made inside the handler", "            except KeyError as error:\n                # A Hermes call made inside the handler")],
    'the answer is the old one': [("                return _error(unavailable.code, unavailable.message, unavailable.status)", "                return _error('hermes_unreachable', 'Hermes is unavailable.', 503)")],
}


@pytest.mark.parametrize('label', sorted(SAFEROUTE_MUTATIONS))
def test_each_saferoute_mutation_is_caught(label):
    name, HermesError = package()
    source_of('dashboard/plugin_api.py', SAFEROUTE_MUTATIONS[label])
    with pytest.raises(BaseException):  # noqa: B017
        saferoute_checks(name, HermesError, SAFEROUTE_MUTATIONS[label])


# ---- the watcher tick --------------------------------------------------------------------------------------------------------------------------
def tick_checks(name, edits=(), caplog=None):
    text = source_of('dashboard/plugin_api.py', edits)
    body = re.search(r'def _note_outage\(error\):.*?(?=\n\n\ndef _start_background)', text, re.S).group(0)
    boundary = importlib.import_module(f'{name}.hermes_boundary')
    clock = [1000.0]
    calls = {'renew': 0, 'release': 0}

    class Lease:
        def set_kind(self, kind):
            pass

        def enter(self):
            return True

        def renew(self):
            calls['renew'] += 1

        def release(self):
            calls['release'] += 1
    action = {'what': None}

    def watch_pass():
        what = action['what']
        if isinstance(what, BaseException):
            raise what
        return True
    fake = types.ModuleType('hermes_cli.web_server_profiles')
    fake.get_process_hermes_home = lambda: Path('/nonexistent-luvebot-home')
    saved = {m: sys.modules.get(m) for m in ('hermes_cli', 'hermes_cli.web_server_profiles')}
    sys.modules['hermes_cli'], sys.modules['hermes_cli.web_server_profiles'] = types.ModuleType('hermes_cli'), fake
    ns = {'hermes_compat': types.SimpleNamespace(read=lambda: (None, 'in_process'), read_app=lambda: None, serving=lambda *_: (None, 'hermes_not_pinned')), '_watch_pass': watch_pass,
          '_lease_for': lambda path: Lease(), 'logging': logging, '_SERVED': [False], '_WATCH_EVERY': 0.01, 'time': types.SimpleNamespace(monotonic=lambda: clock[0], sleep=lambda s: None),
          'watcher_lease': types.SimpleNamespace(kind_of=lambda *a, **k: None), 'hermes_boundary': boundary, '_OUTAGE_LOGGED': {}, '_OUTAGE_EVERY_S': 600.0}
    try:
        exec(compile(textwrap.dedent(body), 'tick', 'exec'), ns)
        caplog.clear()
        action['what'] = ConfigBackendUnavailable('https://u:SECRET@cfg/x')
        assert outcome(ns['_background_tick']) == ('returned', None)                      # one failed pass, the tick returns: the loop goes on
        assert calls == {'renew': 0, 'release': 1}, calls                                 # no heartbeat, and the lease given up so a healthy process takes over
        lines = [r.getMessage() for r in caplog.records if 'did not answer' in r.getMessage()]
        assert len(lines) == 1 and 'ConfigBackendUnavailable' in lines[0] and 'SECRET' not in ' '.join(r.getMessage() for r in caplog.records), lines   # the class only
        for _ in range(5):
            clock[0] += 30
            assert outcome(ns['_background_tick']) == ('returned', None)
        assert len([r for r in caplog.records if 'did not answer' in r.getMessage()]) == 1     # no new line inside 10 minutes
        clock[0] += 600
        assert outcome(ns['_background_tick']) == ('returned', None)
        assert len([r for r in caplog.records if 'did not answer' in r.getMessage()]) == 2     # and one more after them
        action['what'] = None                                                             # healthy again: the pass finishes, the lease is renewed
        assert outcome(ns['_background_tick']) == ('returned', None) and calls['renew'] == 1
        caplog.clear()
        action['what'], before = SystemExit('https://u:SECRET@cfg/x'), calls['release']   # P1-8: a plain exit in this thread would end it for good (the cap with it): ONE failed pass too
        assert outcome(ns['_background_tick']) == ('returned', None) and calls['release'] == before + 1, calls
        lines = [r.getMessage() for r in caplog.records if 'Hermes stopped the pass' in r.getMessage()]
        assert len(lines) == 1 and 'SystemExit' in lines[0] and 'SECRET' not in ' '.join(r.getMessage() for r in caplog.records), lines   # the class only
        action['what'], before = None, calls['renew']
        assert outcome(ns['_background_tick']) == ('returned', None) and calls['renew'] == before + 1      # and the next pass runs
        for exit_ in (KeyboardInterrupt(), GeneratorExit()):                              # nothing else that is not an Exception is swallowed: it propagates, and the lease was still given up
            action['what'], before = exit_, calls['release']
            kind, got = outcome(ns['_background_tick'])
            assert kind == 'raised' and got is exit_ and calls['release'] == before + 1, (exit_, kind, got)
        action['what'] = RuntimeError('boom')                                             # an ordinary failure: as before, logged, the tick returns
        assert outcome(ns['_background_tick']) == ('returned', None)
    finally:
        for module, previous in saved.items():
            if previous is None:
                sys.modules.pop(module, None)
            else:
                sys.modules[module] = previous


def test_the_tick_treats_the_outage_as_one_failed_pass_and_never_swallows_a_real_exit(caplog):
    caplog.set_level(logging.WARNING)
    name, _ = package()
    tick_checks(name, caplog=caplog)


TICK_MUTATIONS = {
    'every BaseException is swallowed': [("    except SystemExit as error:  # Hermes's config outage is a SystemExit on purpose", "    except BaseException as error:  # Hermes's config outage is a SystemExit on purpose")],
    'a plain exit is not a failed pass': [("Any other BaseException is not ours to swallow\n        _note_outage(error)\n", "Any other BaseException is not ours to swallow\n        if not hermes_boundary.is_config_unavailable(error):\n            raise\n        _note_outage(error)\n")],
    'the clause is gone': [("    except SystemExit as error:  # Hermes's config outage is a SystemExit on purpose", "    except KeyError as error:  # Hermes's config outage is a SystemExit on purpose")],
    'the exit text is logged': [("logging.getLogger('luvebot.budget').warning('budget pass skipped: %s (%s)', why, name)", "logging.getLogger('luvebot.budget').warning('budget pass skipped: %s (%s)', why, error)")],
    'one line per pass': [("    if now - _OUTAGE_LOGGED.get(name, -_OUTAGE_EVERY_S) >= _OUTAGE_EVERY_S:", "    if True:")],
    'the outage is logged forever once': [("    if now - _OUTAGE_LOGGED.get(name, -_OUTAGE_EVERY_S) >= _OUTAGE_EVERY_S:", "    if name not in _OUTAGE_LOGGED:")],
}


@pytest.mark.parametrize('label', sorted(TICK_MUTATIONS))
def test_each_tick_mutation_is_caught(label, caplog):
    caplog.set_level(logging.WARNING)
    name, _ = package()
    source_of('dashboard/plugin_api.py', TICK_MUTATIONS[label])
    with pytest.raises(BaseException):  # noqa: B017
        tick_checks(name, TICK_MUTATIONS[label], caplog)
