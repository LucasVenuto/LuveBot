"""Red team (Lume, 30/10) of the reads that are SHARED or REMEMBERED in the server: Flight (/bots, capabilities), Memo (/activity 3 s, /waiting 15 s,
Skills matrix 30 s), canonical.authority() (60 s, failure 8 s), the ChainProof of the audit (tests/unit/backend/test_audit_chain_proof.py pins its own).

What this pins:
* NO shared value is made for a person: the computation of every Flight/Memo site never names the request, the actor, the credential, the mode or the
  CSRF token (a structural guard over plugin_api.py; a NEW site must be added here on purpose, after someone read what its value holds).
* The bounds of staleness that matter: a Memo serves a change made outside a request for at most its ttl; authority() is True for at most 60 s after
  Hermes stops saying so and False for at most 8 s after a failure (both only ever make LuveBot REFUSE: the old format is refused loudly by a main
  with an authority).
* FINDING (Baixa): SafeRoute bumps the epoch BEFORE it knows who is calling, so a non-GET request nobody authorized still empties every shared read.
FIXED: the epoch is bumped only past every refusal (the xfail marker is gone).
"""
import ast
import importlib
import importlib.util
import itertools
import sys
import types
from pathlib import Path

import pytest

from backend.flight import Flight, Memo

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()

API = Path(__file__).resolve().parents[3] / 'dashboard' / 'plugin_api.py'
PERSON = {'request', 'actor', 'credential', '_credential', '_mode', 'csrf', '_identity', '_human', '_require_csrf'}   # what a per-person value would be made from (a bare `mode` is the Bot's approval mode: not a person)
# What a key may be made of: the Bot's name, the Bot's own marker (`seen`: the hook's last row id for THAT Bot, a number the dashboard cannot see move
# because the hook is another process) and the clock (no marker: nothing is kept). Never a name that would make a per-person value (`PERSON`).
EXPECTED_SITES = {('_FLIGHT', 'run', "'bots'"), ('_FLIGHT', 'run', "('caps', name)"), ('_ACTIVITY', 'get', 'key'),
                  ('_WAITING', 'get', "('waiting', name, seen if seen is not None else ('clock', int(time.monotonic() // 3)))"), ('_SKILLS_MATRIX', 'get', "('matrix', tuple(names))"),
                  ('_CAN_ASK', 'get', "('can_ask', name)"), ('_FILE_TOOLS', 'get', "('file_tools', name)"),
                  ('_SUGGESTIONS', 'get', "('routine-suggestions', name)"), ('_MODEL_INFO', 'get', "('model', name)"), ('_MODEL_OPTIONS', 'get', "('model-options', name)")}


def _names(node):
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def _direct(fn):
    """The nodes of `fn` that are not inside a nested function (a call is read once, from the function that really contains it)."""
    stack = list(ast.iter_child_nodes(fn))
    while stack:
        node = stack.pop()
        yield node
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            stack.extend(ast.iter_child_nodes(node))


KINDS = {'Flight': 'run', 'Memo': 'get'}   # the TYPE says which call shares a read: any `<holder>.run(...)` of a Flight, `<holder>.get(...)` of a Memo, whatever the holder is called
ROOT = Path(__file__).resolve().parents[3]
# Every place that keeps or shares a read in the server, closed by hand: (file, holder, type). A NEW one is red until someone reads what its value
# holds (nothing per person; see `sites` and `key_leaks`) and adds it here; one that no longer exists is red too, so the list stays true.
EXPECTED_HOLDERS = {('dashboard/plugin_api.py', '_FLIGHT', 'Flight'), ('dashboard/plugin_api.py', '_WAITING', 'Memo'), ('dashboard/plugin_api.py', '_CAN_ASK', 'Memo'),
                    ('dashboard/plugin_api.py', '_FILE_TOOLS', 'Memo'),
                    ('dashboard/plugin_api.py', '_SUGGESTIONS', 'Memo'),
                    ('dashboard/plugin_api.py', '_MODEL_INFO', 'Memo'), ('dashboard/plugin_api.py', '_MODEL_OPTIONS', 'Memo'),   # one Bot's model and the options its picker offers (M-1): the same for every person   # one Bot's pending routine suggestions from Hermes (P2-1): the same records for every person, shaped after the read
                    ('dashboard/plugin_api.py', '_SKILLS_MATRIX', 'Memo'), ('dashboard/plugin_api.py', '_ACTIVITY', 'Memo')}
EXPECTED_IMPORTERS = {'dashboard/plugin_api.py'}   # the files that import the `flight` module (backend/flight.py itself is the definition)
# The same thing written by hand: a module-level dict named like a cache (not a Memo, so not guarded by `sites`: it is listed to be looked at).
EXPECTED_DICT_CACHES = {('backend/bots.py', '_caps_cache'), ('backend/plan_quota.py', '_cache')}


def constructions(tree):
    """-> [(name, type)] for every Flight/Memo a module builds (`import ... as` aliases, `flight.Memo(...)` and subclasses included). `name` is the
    module-level NAME it is assigned to; anything else (inside a function, an attribute, inline, a subclass) is '?': a holder this guard cannot follow."""
    alias = {a.asname or a.name: a.name for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) for a in n.names if a.name in KINDS}

    def kind(expr):
        name = expr.id if isinstance(expr, ast.Name) else expr.attr if isinstance(expr, ast.Attribute) else None
        name = alias.get(name, name)
        return name if name in KINDS else None
    named = {}
    for node in tree.body:
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        if len(targets) == 1 and isinstance(targets[0], ast.Name) and isinstance(getattr(node, 'value', None), ast.Call):
            named[id(node.value)] = targets[0].id
    out = [(named.get(id(n), '?'), kind(n.func)) for n in ast.walk(tree) if isinstance(n, ast.Call) and kind(n.func)]
    return out + [('?', kind(b)) for n in ast.walk(tree) if isinstance(n, ast.ClassDef) for b in n.bases if kind(b)]


def imports_flight(tree):
    return any((isinstance(n, ast.ImportFrom) and ((n.module or '').split('.')[-1] == 'flight' or any(a.name == 'flight' for a in n.names)))
               or (isinstance(n, ast.Import) and any(a.name.split('.')[-1] == 'flight' for a in n.names)) for n in ast.walk(tree))


def dict_caches(tree):
    """Module-level names with `cache` or `memo` in them holding a plain dict."""
    out = set()
    for node in tree.body:
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        value = getattr(node, 'value', None)
        plain = isinstance(value, ast.Dict) or (isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id in ('dict', 'OrderedDict', 'defaultdict'))
        out |= {t.id for t in targets if isinstance(t, ast.Name) and plain and ('cache' in t.id.lower() or 'memo' in t.id.lower())}
    return out


def inventory(sources):
    """{path relative to the repo: source} -> (holders, importers, dict caches) found in them, backend/flight.py (the definition) left out."""
    holders_, importers, dicts = set(), set(), set()
    for rel, source in sources.items():
        if rel == 'backend/flight.py':
            continue
        tree = ast.parse(source)
        holders_ |= {(rel, name, kind) for name, kind in constructions(tree)}
        importers |= {rel} if imports_flight(tree) else set()
        dicts |= {(rel, name) for name in dict_caches(tree)}
    return holders_, importers, dicts


def real_sources():
    paths = sorted((ROOT / 'backend').rglob('*.py')) + [API]
    return {p.relative_to(ROOT).as_posix(): p.read_text() for p in paths}


def holders(tree):
    """-> {name: method} for every module-level `NAME = Flight(...)` / `NAME = Memo(...)`. One built anywhere else (in a function, as an attribute, inline)
    would be a shared read this guard cannot see, so it fails here instead of passing unnoticed."""
    built = constructions(tree)
    out = {name: KINDS[kind] for name, kind in built if name != '?'}
    assert len(out) == len(built), f"a Flight/Memo is built other than as `NAME = Memo(...)` at module level ({len(built)} built, {len(out)} seen): the guard cannot follow it"
    return out


def sites(source):
    """-> [(holder, method, key source, the names the computation uses)] for every `.run(...)` of a Flight and `.get(...)` of a Memo of the module (found by
    TYPE: see `holders`). The names of the computation include those of the local functions and of the module-level functions it calls (one level), where a person would hide."""
    tree = ast.parse(source)
    kinds = holders(tree)
    top = {n.name: n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    out = []
    for fn in [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
        local = {n.name: n for n in ast.walk(fn) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n is not fn}
        for call in [c for c in _direct(fn) if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute) and isinstance(c.func.value, ast.Name)]:
            holder, method = call.func.value.id, call.func.attr
            if kinds.get(holder) != method:
                continue
            key, make = call.args[0], call.args[2]
            used, seen, todo = set(), set(), [make]
            while todo:
                node = todo.pop()
                used |= _names(node)
                # follow CALLS (and a bare local function passed along), never a variable that happens to be named like a route
                called = {c.func.id for c in ast.walk(node) if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)} | \
                         {n for n in _names(node) if n in local}
                for name in called:
                    for pool in (local, top):
                        if name in pool and name not in seen:
                            seen.add(name)
                            todo.append(pool[name])
            out.append((holder, method, ast.unparse(key), used))
    return out


def key_leaks(key):
    """A key that holds a name from `PERSON` would share one person's answer with the next (or split a shared one per person)."""
    return bool(_names(ast.parse(key, mode='eval')) & PERSON)


def test_no_shared_read_is_made_for_a_person():
    found = sites(API.read_text())
    assert {(h, m, k) for h, m, k, _ in found} == EXPECTED_SITES, "a new Flight/Memo site: read what its value holds, then add it here"
    for holder, method, key, used in found:
        assert not (used & PERSON), f"{holder}.{method}({key}) computes with {sorted(used & PERSON)}"
        assert not key_leaks(key), f"{holder}.{method}({key}) keys on {sorted(_names(ast.parse(key, mode='eval')) & PERSON)}"


@pytest.mark.parametrize('key,leaks', [("('waiting', actor)", True), ("('matrix', _identity(request))", True), ("('waiting', name, seen)", False),
                                       ("('waiting', name, seen if seen is not None else ('clock', int(time.monotonic() // 3)))", False), ("('caps', name)", False)])
def test_the_guard_sees_a_person_in_a_key(key, leaks):
    assert key_leaks(key) is leaks


@pytest.mark.parametrize('source,leaks', [
    ("_A = Memo(3.0)\nasync def h(request):\n    actor = _identity(request)\n    return await _A.get(key, E, lambda: build(actor))\n", True),
    ("_W = Memo(15.0)\nasync def h(request):\n    async def read():\n        return mine(request)\n    return await _W.get(('waiting', n), E, read)\n", True),
    ("_M = Memo(30.0)\ndef build(credential):\n    return credential\nasync def h():\n    return await _M.get(('matrix', n), E, lambda: build(1))\n", True),
    ("_F = Flight()\nasync def h(request):\n    _identity(request)\n    return await _F.run('bots', E, lambda: _list_bots(response))\n", False),
    # a holder nobody listed, under any name, is found by what it IS (a Memo): the guard does not depend on `_ACTIVITY`-style names
    ("_BRAND_NEW = Memo(5.0)\nasync def h(request):\n    return await _BRAND_NEW.get(('x', n), E, lambda: build(request))\n", True),
    ("cache: Memo = Memo(5.0)\nasync def h(request):\n    return await cache.get(('x', n), E, lambda: build(request))\n", True),
])
def test_the_guard_sees_a_person_in_a_shared_computation(source, leaks):
    """The guard itself, with a defect each (a leaking site must be found; the real shape must not be)."""
    found = sites(source)
    assert len(found) == 1
    assert bool(found[0][3] & PERSON) is leaks


@pytest.mark.parametrize('source', [
    "async def h(request):\n    memo = Memo(5.0)\n    return await memo.get('k', E, lambda: build(request))\n",     # built inside a function
    "class X:\n    cache = Memo(5.0)\n",                                                                              # as an attribute
    "async def h(request):\n    return await Memo(5.0).get('k', E, lambda: build(request))\n",                       # inline
    "from luvebot_backend.flight import Memo\nclass Mine(Memo):\n    pass\n",                                            # a subclass
])
def test_a_holder_built_where_the_guard_cannot_follow_it_fails_loudly(source):
    with pytest.raises(AssertionError, match='cannot follow'):
        sites(source)


@pytest.mark.parametrize('head', ["import luvebot_backend.flight as f\n_A = f.Memo(5.0)\n", "from luvebot_backend.flight import Memo as M\n_A = M(5.0)\n"])
def test_a_holder_reached_through_the_module_or_an_alias_is_still_followed(head):
    found = sites(head + "async def h(request):\n    return await _A.get(('x', n), E, lambda: build(request))\n")
    assert len(found) == 1 and found[0][3] & PERSON


def test_only_the_method_of_the_type_counts():
    """`Flight.run` and `Memo.get` share a read; a `.get` on a Flight or a `.run` on a Memo is not a site (it is not even a method of that type)."""
    assert sites("_F = Flight()\n_M = Memo(1.0)\nasync def h():\n    return await _F.get('k', E, lambda: 1), await _M.run('k', E, lambda: 1)\n") == []


def test_every_shared_memory_of_the_server_is_on_the_list():
    """Found by walking backend/ and dashboard/plugin_api.py, not by names written here: a new Memo/Flight (or a hand-made dict cache) is red until it is listed."""
    holders_, importers, dicts = inventory(real_sources())
    assert holders_ == EXPECTED_HOLDERS, f"new: {sorted(holders_ - EXPECTED_HOLDERS)}; gone: {sorted(EXPECTED_HOLDERS - holders_)}"
    assert importers == EXPECTED_IMPORTERS, f"new: {sorted(importers - EXPECTED_IMPORTERS)}; gone: {sorted(EXPECTED_IMPORTERS - importers)}"
    assert dicts == EXPECTED_DICT_CACHES, f"new: {sorted(dicts - EXPECTED_DICT_CACHES)}; gone: {sorted(EXPECTED_DICT_CACHES - dicts)}"


API_REL = 'dashboard/plugin_api.py'


def _mutants():
    base = real_sources()
    plus = lambda rel, text: {**base, rel: base.get(rel, '') + text}
    return {
        'a new Memo in plugin_api.py': plus(API_REL, "\n_BRAND_NEW = Memo(5.0)\n"),
        'a new Flight in plugin_api.py': plus(API_REL, "\n_ANOTHER = Flight()\n"),
        'a new Memo in a backend module': plus('backend/zzz.py', "from luvebot_backend.flight import Memo\n_C = Memo(2.0)\n"),
        'a Memo under an import alias': plus('backend/zzz.py', "from luvebot_backend.flight import Memo as M\n_C = M(2.0)\n"),
        'a Flight through the module': plus('backend/zzz.py', "import luvebot_backend.flight as f\n_C = f.Flight()\n"),
        'a Memo built inside a function': plus('backend/zzz.py', "from luvebot_backend.flight import Memo\ndef h():\n    return Memo(1.0)\n"),
        'a subclass of Memo': plus('backend/zzz.py', "from luvebot_backend.flight import Memo\nclass Mine(Memo):\n    pass\n"),
        'a hand-made dict cache': plus('backend/zzz.py', "_answers_cache = {}\n"),
        'a listed holder that is gone': {**base, API_REL: base[API_REL].replace("_CAN_ASK = Memo(60.0)", "_CAN_ASK_GONE = 1  # Memo(60.0)", 1)},
    }


@pytest.mark.parametrize('name', list(_mutants()))
def test_the_inventory_turns_red_for(name):
    holders_, importers, dicts = inventory(_mutants()[name])
    assert (holders_, importers, dicts) != (EXPECTED_HOLDERS, EXPECTED_IMPORTERS, EXPECTED_DICT_CACHES)


def test_the_inventory_is_not_moved_by_a_mention():
    """Control: the words Memo/Flight in a check, a comment or a string are not a holder (else the guard would cry wolf and be ignored)."""
    base = real_sources()
    mention = {**base, 'backend/zzz.py': "# Memo(1.0) and Flight() are in flight.py\ndef f(x):\n    return isinstance(x, Memo) or 'Flight()' in str(x)\n"}
    assert inventory(mention) == inventory(base)


def test_a_memo_serves_a_change_made_outside_a_request_for_its_ttl_and_no_longer():
    """The staleness bound of /activity (3 s), /waiting (15 s) and the matrix (30 s): the epoch only counts requests of THIS dashboard, so what
    Hermes, the CLI or our own watcher changes shows up after at most `ttl`."""
    import asyncio
    now, state, calls = [0.0], {'v': 'before'}, []

    async def read():
        calls.append(1)
        return state['v']

    async def run():
        memo = Memo(15.0, clock=lambda: now[0])
        assert await memo.get('k', 0, read) == 'before'
        state['v'] = 'changed outside'            # Telegram, the CLI, the watcher: no request, the epoch stays 0
        now[0] = 14.9
        assert await memo.get('k', 0, read) == 'before' and len(calls) == 1     # still the old answer (the bound)
        now[0] = 15.0
        assert await memo.get('k', 0, read) == 'changed outside' and len(calls) == 2
        state['v'] = 'changed by a request'
        assert await memo.get('k', 1, read) == 'changed by a request'          # a request that changed something (epoch moved): at once
    asyncio.run(run())


def test_flight_shares_only_a_read_started_under_the_same_epoch():
    import asyncio

    async def run():
        flight, gate, starts = Flight(), asyncio.Event(), []

        async def make():
            starts.append(1)
            await gate.wait()
            return len(starts)
        a = asyncio.ensure_future(flight.run('k', 0, make))
        b = asyncio.ensure_future(flight.run('k', 0, make))      # same epoch: joins
        c = asyncio.ensure_future(flight.run('k', 1, make))      # a change happened: its own read
        await asyncio.sleep(0)
        gate.set()
        assert await a == await b == 1 and await c == 2 and len(starts) == 2
    asyncio.run(run())


@pytest.fixture
def canonical(monkeypatch):
    """A fresh copy of the backend package (its own name: nothing leaks into the session) with the modules only Hermes has stubbed, the REAL canonical."""
    for name, attrs in {'agent': {}, 'agent.secret_scope': {'current_secret_scope': lambda: None, 'get_secret': lambda *a: None},
                        'hermes_cli': {}, 'hermes_cli.profiles': {'list_profile_names': lambda: []},
                        'hermes_cli.web_server_profiles': {'_config_profile_scope': None}}.items():
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, module)
    name = f'rt_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    module = importlib.import_module(f'{name}.canonical')
    module._flag.clear()
    return module


def test_authority_is_true_for_at_most_60_s_and_false_for_at_most_8_s_after_a_failure(canonical):
    """Both directions only make LuveBot refuse: a main with an authority refuses the old format loudly; an old Hermes refuses the new one."""
    clock, answers = [0.0], []

    def reader(_bot):
        value = answers.pop(0)
        if isinstance(value, Exception):
            raise value
        return {'features': {canonical.FLAG: value}}
    now = lambda: clock[0]
    canonical._flag.clear()
    answers[:] = [True]
    assert canonical.authority('vendas', reader=reader, now=now) is True
    answers[:] = [False]                                                # Hermes restarts without the feature...
    clock[0] = 59.9
    assert canonical.authority('vendas', reader=reader, now=now) is True    # ...still True for up to 60 s
    clock[0] = 60.0
    assert canonical.authority('vendas', reader=reader, now=now) is False
    canonical._flag.clear()
    answers[:] = [canonical.HermesError('hermes_unreachable'), True]
    assert canonical.authority('vendas', reader=reader, now=now) is False   # a failure reads as False...
    clock[0] = 67.9
    assert canonical.authority('vendas', reader=reader, now=now) is False   # ...for 8 s, even if Hermes is back
    clock[0] = 68.0
    assert canonical.authority('vendas', reader=reader, now=now) is True
    canonical._flag.clear()


def test_the_epoch_is_bumped_only_for_a_request_that_was_authorized():
    tree = ast.parse(API.read_text())
    handle = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == 'handle'
                  and any(isinstance(x, ast.AugAssign) and 'EPOCH' in ast.unparse(x.target) for x in ast.walk(n)))
    bump = min(x.lineno for x in ast.walk(handle) if isinstance(x, ast.AugAssign) and 'EPOCH' in ast.unparse(x.target) and x.lineno < handle.end_lineno - 4)
    identity = min(x.lineno for x in ast.walk(handle) if isinstance(x, ast.Call) and ast.unparse(x.func) == '_identity')
    assert identity < bump, f"the epoch is bumped at line {bump}, before _identity at line {identity}"


def _guard_ok(text):
    """The rest of the R1 fix: the second bump is only for a request that got the first one, and the watcher bumps when it changed something."""
    handle = text.split('async def handle(request):', 1)[1].split('        return handle', 1)[0]
    tick = text.split('def _watch_pass():', 1)[1].split('\ndef ', 1)[0]   # the work of a pass (the tick only decides who does it: ADR-010)
    return ('bumped = False' in handle and handle.count('bumped = True') == 1 and 'finally:\n                if bumped:\n                    _EPOCH[0] += 1' in handle
            and "if result['decisions']:\n        _EPOCH[0] += 1" in tick and 'if inactivity.check(' in tick and '_EPOCH[0] += 1' in tick.split('if inactivity.check(', 1)[1])


def test_the_second_bump_follows_the_first_and_the_watcher_bumps():
    source = API.read_text()
    assert _guard_ok(source)
    for old, new in (("                if bumped:\n                    _EPOCH[0] += 1", "                if changes:\n                    _EPOCH[0] += 1"),
                     ("    if result['decisions']:\n        _EPOCH[0] += 1", "    if result['decisions']:\n        pass"),
                     ("        if inactivity.check(meta.path, audit, names, _cron):\n            _EPOCH[0] += 1", "        inactivity.check(meta.path, audit, names, _cron)\n        pass")):
        assert source.count(old) == 1, old
        assert not _guard_ok(source.replace(old, new)), old
