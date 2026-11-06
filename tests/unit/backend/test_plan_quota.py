"""F6.1 (plan quota per provider, backend/plan_quota.py): what leaves is a whitelist, the read never blocks, never raises, never gates.
The Hermes payload is a stand-in with the shape of `build_model_options_payload` (hermes_cli/inventory.py#L289, v0.22.2); the REAL
Hermes runs in the harness. Every invariant also runs against variants of plan_quota.py with one defect each: each must go red."""
import contextlib
import json
import re
import sys
import threading
import time
import types
from pathlib import Path

import pytest

import backend.plan_quota as real

SRC = Path(real.__file__).parent
ROOT = SRC.parent
CANARY = 'sk-CANARYquota0123456789abcdef'
EPOCH = 1_800_000_000


def iso(epoch):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def payload():
    return {'providers': [
        {'slug': 'anthropic', 'name': 'Anthropic', 'api_key': CANARY, 'base_url': f'https://u:{CANARY}@x.test', 'models': [CANARY],
         'usage': {'windows': [{'label': 'Session', 'used_percent': 83.0, 'resets_at': iso(EPOCH), 'scope': 'account', 'secret': CANARY},
                               {'label': 'Weekly', 'used_percent': 130.0, 'resets_at': iso(EPOCH)[:-6], 'scope': 'account'}]},
         'limit': {'scope': 'models', 'models': {'opus': iso(EPOCH + 60)}}},
        {'slug': 'pool', 'name': 'Pool',
         'usage': {'accounts': [{'id': CANARY, 'label': f'me@{CANARY}.test', 'state': 'limited', 'resets_at': iso(EPOCH),
                                 'windows': [{'label': 'Day', 'used_percent': 100.0, 'scope': 'account', 'resets_at': iso(EPOCH)}]},
                                {'id': 'b', 'label': 'second', 'state': 'weird', 'windows': []}]}},
        {'slug': 'openrouter', 'name': 'OpenRouter', 'models': ['a', 'b']},                      # no usage, no limit: not listed
        {'slug': 'odd', 'usage': {'windows': [{'label': 'x', 'used_percent': True}]}},           # nothing numeric: not listed
        {'slug': 'emptypool', 'usage': {'accounts': []}},                                         # A-2: a pool with no account: not listed
        {'slug': 'nowindow', 'usage': {'accounts': [{'state': 'ready', 'windows': []}, {'state': 'unknown', 'windows': [{'used_percent': None}]}]}},  # A-2: no valid window
    ]}


import os


@contextlib.contextmanager
def zone(name):
    old = os.environ.get('TZ')
    os.environ['TZ'] = name
    time.tzset()
    try:
        yield
    finally:
        os.environ.pop('TZ') if old is None else os.environ.__setitem__('TZ', old)
        time.tzset()


@contextlib.contextmanager
def waiting(mod, seconds):
    old, mod.WAIT = mod.WAIT, seconds
    try:
        yield
    finally:
        mod.WAIT = old


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def _begin():
    before = set(threading.enumerate())
    for mod in (real,):
        mod._cache.clear(), mod._flight.clear(), mod._failed.clear()
    return before


def _end(before, wait=10):
    """The names of the threads started since `before` that are still alive after `wait` seconds each (the others are joined)."""
    left = []
    for thread in set(threading.enumerate()) - before:
        thread.join(wait)
        if thread.is_alive():
            left.append(thread.name)
    return left


@pytest.fixture(autouse=True)
def _clean():
    """Every thread a test starts ends before the next test begins. `get` leaves its worker behind when the caller gives up after WAIT
    (inv_never_waits_longer_than_WAIT does it on purpose): a worker that lands after the next test's `fresh` writes a copy for the same Bot
    and the next test then sees no fetch at all (`assert 0 == 1`, seen only in the whole suite, where a thread can wait long to run)."""
    before = _begin()
    yield
    left = _end(before)
    assert not left, f'a worker outlived its test: {left}'


def test_a_worker_left_behind_is_waited_for_and_one_that_never_ends_is_named():
    before = _begin()
    gate = threading.Event()
    quick = threading.Thread(target=time.sleep, args=(0.2,))
    stuck = threading.Thread(target=gate.wait, args=(5,), name='luvebot-quota-stuck')
    quick.start(), stuck.start()
    assert _end(before, wait=0.5) == ['luvebot-quota-stuck'] and not quick.is_alive()
    gate.set()
    stuck.join(5)


def fresh(mod):
    mod._cache.clear(), mod._flight.clear(), mod._failed.clear()
    return mod


# ---- invariants (each one is run on the real module and, with a defect, on its variants) --------------------------------------

def inv_no_secret_fields(mod):
    out = mod.shape(payload())
    text = json.dumps(out)
    assert CANARY not in text and 'base_url' not in text and 'api_key' not in text and 'me@' not in text
    assert [p['slug'] for p in out] == ['anthropic', 'pool']
    pool = out[1]['usage']['accounts']
    assert set(pool[0]) == {'state', 'windows', 'resets_at'} and pool[0]['state'] == 'limited' and pool[1]['state'] == 'unknown'


def inv_percent_is_clamped_and_complete(mod):
    with zone('Asia/Tokyo'):
        return _percent(mod)


def _percent(mod):
    windows = mod.shape(payload())[0]['usage']['windows']
    assert windows[0] == {'label': 'Session', 'scope': 'account', 'used_percent': 83.0, 'remaining_percent': 17.0, 'resets_at': float(EPOCH)}
    assert windows[1]['used_percent'] == 100.0 and windows[1]['remaining_percent'] == 0.0
    assert windows[1]['resets_at'] == float(EPOCH)  # no zone = UTC, whatever the host's zone is (run under another one)
    assert mod.shape(payload())[0]['limit'] == {'scope': 'models', 'models': {'opus': float(EPOCH + 60)}}


def inv_only_providers_with_a_quota(mod):
    assert {p['slug'] for p in mod.shape(payload())} == {'anthropic', 'pool'}  # not emptypool, not nowindow (A-2)
    assert mod.shape({}) == [] and mod.shape(None) == [] and mod.shape({'providers': ['x', 3, {'slug': 7}]}) == []


def inv_one_fetch_per_bot_at_a_time(mod):
    fresh(mod)
    gate, calls = threading.Event(), []

    def slow(bot):
        calls.append(bot)
        gate.wait(5)
        return []

    results, started = [], []

    def run():
        started.append(1)
        results.append(mod.get('a', fetch=slow))
    threads = [threading.Thread(target=run) for _ in range(3)]
    with waiting(mod, 2):  # a loaded machine starts a thread late: a short wait made a latecomer fetch for itself (seen 1 run in 4 under load)
        [t.start() for t in threads]
        deadline = time.monotonic() + 5
        while len(started) < 3 and time.monotonic() < deadline:   # all three are RUNNING before the gate opens: a thread that starts after it would fetch for itself, and that is the load, not the code
            time.sleep(0.01)
        time.sleep(0.2)
        gate.set()
        [t.join(5) for t in threads]
    assert len(calls) == 1 and len(results) == 3


def inv_a_fresh_copy_is_reused(mod):
    fresh(mod)
    calls, clock = [], Clock()
    mod.time = types.SimpleNamespace(time=clock, monotonic=time.monotonic)
    try:
        def fetch(bot):
            calls.append(bot)
            return [{'slug': 's'}]
        first = mod.get('a', fetch=fetch, now=clock)
        clock.t += mod.TTL - 1
        second = mod.get('a', fetch=fetch, now=clock)
        clock.t += 2
        third = mod.get('a', fetch=fetch, now=clock)
    finally:
        mod.time = time
    assert mod.TTL == 60.0 and mod.EMPTY_TTL < mod.TTL
    assert len(calls) == 2 and first['stale'] is False and second['providers'] == [{'slug': 's'}] and third['reason'] is None


def inv_an_empty_answer_is_asked_again_sooner(mod):
    fresh(mod)
    calls, clock = [], Clock()
    mod.time = types.SimpleNamespace(time=clock, monotonic=time.monotonic)
    try:
        def empty(bot):
            calls.append('empty')
            return []

        def full(bot):
            calls.append('full')
            return [{'slug': 's'}]
        mod.get('a', fetch=empty, now=clock)
        clock.t += mod.EMPTY_TTL + 1                 # still inside TTL: a full answer would be reused, an empty one is asked again
        mod.get('a', fetch=full, now=clock)
        clock.t += mod.EMPTY_TTL + 1
        mod.get('a', fetch=full, now=clock)
    finally:
        mod.time = time
    assert calls == ['empty', 'full']


@contextlib.contextmanager
def hermes_modules(*, usage_cache):
    """A stand-in Hermes: the picker function that answers an empty payload, the config scope, and (or not) agent.account_usage_cache."""
    scoped, asked = [], []

    @contextlib.contextmanager
    def scope(bot):
        scoped.append(bot)
        yield

    def build(*args, **kwargs):
        asked.append((args, kwargs))
        return {'providers': payload()['providers']}
    fakes = {'hermes_cli': types.ModuleType('hermes_cli'), 'agent': types.ModuleType('agent'),
             'hermes_cli.inventory': types.SimpleNamespace(build_model_options_payload=build, load_picker_context=lambda: 'ctx'),
             'hermes_cli.web_server_profiles': types.SimpleNamespace(_config_profile_scope=scope),
             'agent.account_usage_cache': types.ModuleType('agent.account_usage_cache') if usage_cache else None}
    fakes['hermes_cli'].__path__ = fakes['agent'].__path__ = []
    saved = {k: sys.modules.get(k) for k in fakes}
    sys.modules.update(fakes)
    try:
        yield scoped, asked
    finally:
        for k, v in saved.items():
            sys.modules.pop(k, None) if v is None else sys.modules.__setitem__(k, v)


def inv_an_old_hermes_without_usage_says_so(mod):
    """A-1: the picker function exists on older Hermes too, but without agent.account_usage_cache it carries no `usage`: that is
    `hermes_without_quota`, never an `available` answer with an empty list."""
    fresh(mod)
    with hermes_modules(usage_cache=False):
        view = mod.get('a', fetch=mod._fetch)
    assert view['providers'] is None and view['reason'] == 'hermes_without_quota'
    fresh(mod)
    with hermes_modules(usage_cache=True) as (scoped, asked):
        view = mod.get('a', fetch=mod._fetch)
    assert view['reason'] is None and [p['slug'] for p in view['providers']] == ['anthropic', 'pool']
    assert scoped == ['a'] and asked == [(('ctx',), {})]  # in the Bot's scope, and never a `refresh`


def inv_never_waits_longer_than_WAIT(mod):
    fresh(mod)
    gate = threading.Event()
    box = []
    worker = threading.Thread(target=lambda: box.append(mod.get('a', fetch=lambda bot: gate.wait(5) or [])))
    with waiting(mod, 0.2):
        worker.start()
        worker.join(2)
        finished = not worker.is_alive()
        gate.set()
        worker.join(5)
    assert finished and box[0]['providers'] is None and box[0]['reason'] == 'unreadable'


def inv_a_failed_refresh_serves_the_older_copy_as_stale(mod):
    fresh(mod)
    clock = Clock()
    mod.time = types.SimpleNamespace(time=clock, monotonic=time.monotonic)
    try:
        assert mod.get('a', fetch=lambda bot: [{'slug': 's'}], now=clock)['stale'] is False
        clock.t += mod.TTL + 1

        def boom(bot):
            raise RuntimeError(CANARY)
        view = mod.get('a', fetch=boom, now=clock)
        assert view['stale'] is True and view['providers'] == [{'slug': 's'}]
        clock.t += mod.STALE_MAX
        view = mod.get('a', fetch=boom, now=clock)
    finally:
        mod.time = time
    assert view['providers'] is None and view['reason'] == 'unreadable' and CANARY not in json.dumps(view)


def inv_an_old_hermes_says_so(mod):
    fresh(mod)

    def missing(bot):
        raise ImportError('hermes_cli.inventory')
    view = mod.get('a', fetch=missing)
    assert view['providers'] is None and view['reason'] == 'hermes_without_quota'
    body = mod.combine([view])
    assert body['available'] is False and body['reason'] == 'hermes_without_quota' and body['bots'] == []


def inv_combine(mod):
    one = {'bot': 'a', 'providers': [{'slug': 's'}], 'fetched_at': 5.0, 'stale': False, 'reason': None}
    two = {'bot': 'b', 'providers': [], 'fetched_at': 3.0, 'stale': True, 'reason': None}
    bad = {'bot': 'c', 'providers': None, 'fetched_at': None, 'stale': False, 'reason': 'unreadable'}
    body = mod.combine([one, two, bad])
    assert body == {'available': True, 'reason': None, 'fetched_at': 3.0, 'stale': True,
                    'bots': [{'bot': 'a', 'providers': [{'slug': 's'}]}, {'bot': 'b', 'providers': []}]}
    assert mod.combine([bad]) == {'available': False, 'reason': 'unreadable', 'fetched_at': None, 'stale': False, 'bots': []}
    assert mod.combine([]) == {'available': False, 'reason': None, 'fetched_at': None, 'stale': False, 'bots': []}


INVARIANTS = {n[4:]: f for n, f in sorted(globals().items()) if n.startswith('inv_')}

MUTATIONS = [
    ('no_secret_fields', 'an account label goes out', "'windows': _windows(a.get('windows')),", "'windows': _windows(a.get('windows')), 'label': a.get('label'),"),
    ('no_secret_fields', 'the base url goes out', "'usage': usage, 'limit': limit}", "'usage': usage, 'limit': limit, 'base_url': row.get('base_url')}"),
    ('no_secret_fields', 'an unknown account state is kept', "a['state'] if a.get('state') in STATES else 'unknown'", "a.get('state')"),
    ('percent_is_clamped_and_complete', 'no clamp', '        used = min(100.0, max(0.0, used))\n', ''),
    ('percent_is_clamped_and_complete', 'remaining is the used', "round(100.0 - used, 1)", "round(used, 1)"),
    ('percent_is_clamped_and_complete', 'a time without zone is local', "when.replace(tzinfo=timezone.utc)", "when"),
    ('only_providers_with_a_quota', 'every provider is listed', 'if usage is not None or limit is not None:', 'if True:'),
    ('only_providers_with_a_quota', 'a bool counts as a number', "isinstance(value, (int, float)) and not isinstance(value, bool)", "isinstance(value, (int, float))"),
    ('one_fetch_per_bot_at_a_time', 'a fetch per caller', '        if done is None:\n', '        if True:\n'),
    ('a_fresh_copy_is_reused', 'no reuse', "return hit is not None and now() - hit[0] < (TTL if hit[1] else EMPTY_TTL)", 'return False'),
    ('a_fresh_copy_is_reused', 'the TTL is back to 20 s', 'TTL = 60.0 ', 'TTL = 20.0 '),
    ('an_empty_answer_is_asked_again_sooner', 'an empty answer sticks for the whole TTL', '(TTL if hit[1] else EMPTY_TTL)', 'TTL'),
    ('an_old_hermes_without_usage_says_so', 'the usage cache is not required', "    from agent import account_usage_cache  # noqa: F401  (the windows come from it: a Hermes without it has no quota and must say so, not answer an empty list)\n", ''),
    ('an_old_hermes_without_usage_says_so', 'a refresh is asked for', 'build_model_options_payload(load_picker_context())', 'build_model_options_payload(load_picker_context(), refresh=True)'),
    ('only_providers_with_a_quota', 'an empty pool is listed', "return {'accounts': accounts} if any(a['windows'] for a in accounts) else None", "return {'accounts': accounts}"),
    ('never_waits_longer_than_WAIT', 'waits for the fetch', '    done.wait(WAIT)', '    done.wait()'),
    ('a_failed_refresh_serves_the_older_copy_as_stale', 'no stale copy', "now() - hit[0] < STALE_MAX and failed != 'hermes_without_quota':", 'False:'),
    ('a_failed_refresh_serves_the_older_copy_as_stale', 'a stale copy never expires', 'now() - hit[0] < STALE_MAX and', 'True and'),
    ('a_failed_refresh_serves_the_older_copy_as_stale', 'the error text is returned',
     "    except Exception:  # noqa: BLE001  (a quota that cannot be read is simply not shown; the class is not even logged: it may name a path)\n        with _lock:\n            _failed[bot] = 'unreadable'",
     "    except Exception as error:\n        with _lock:\n            _failed[bot] = str(error)"),
    ('an_old_hermes_says_so', 'it is called unreadable', "_failed[bot] = 'hermes_without_quota'", "_failed[bot] = 'unreadable'"),
    ('combine', 'a Bot without data is listed', "'providers': r['providers']} for r in have]}", "'providers': r['providers']} for r in results]}"),
    ('combine', 'the newest fetch is reported', "min((r['fetched_at'] for r in have), default=None)", "max((r['fetched_at'] for r in have), default=None)"),
]


def variant(old, new):
    text = (SRC / 'plan_quota.py').read_text()
    assert text.count(old) == 1, old
    mod = types.ModuleType('plan_quota_variant')
    mod.__package__ = 'backend'  # the module imports the boundary relatively
    exec(compile(text.replace(old, new), 'plan_quota_variant', 'exec'), mod.__dict__)
    return mod


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name):
    INVARIANTS[name](real)


def test_every_invariant_has_a_mutation():
    assert {inv for inv, *_ in MUTATIONS} == set(INVARIANTS)


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(invariant, label, old, new):
    mod = variant(old, new)                       # outside pytest.raises: a mutation that does not apply is an error
    with pytest.raises(AssertionError):
        INVARIANTS[invariant](mod)


# ---- it enforces nothing (invariant 7 stays on what LuveBot measures) -----------------------------------------------------------

def quota_users(texts):
    return sorted(name for name, text in texts.items() if re.search(r'plan_quota|/costs/quota|model/options', text))


def test_nothing_enforces_on_the_quota():
    """The Budget, its executor, the watcher, the run gate and every other backend module neither import nor name the quota; the dashboard
    names it only in its own read-only route."""
    texts = {p.name: p.read_text() for p in SRC.glob('*.py') if p.name != 'plan_quota.py'}
    assert quota_users(texts) == []
    api = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    import ast
    tree = ast.parse(api)
    route = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == 'get_costs_quota')
    inside = {i for i in range(route.lineno, route.end_lineno + 1)}
    lines = [n for n, line in enumerate(api.splitlines(), 1) if 'plan_quota' in line and not line.startswith('from luvebot_backend import')]
    assert lines and set(lines) <= inside


def test_the_gate_is_caught_if_the_budget_reads_the_quota():
    texts = {p.name: p.read_text() for p in SRC.glob('*.py') if p.name != 'plan_quota.py'}
    texts['budget.py'] += '\nfrom . import plan_quota\n'
    assert quota_users(texts) == ['budget.py']


def test_the_source_is_the_picker_function_never_a_refresh():
    text = (SRC / 'plan_quota.py').read_text()
    code = text.split('"""', 2)[2]
    assert 'build_model_options_payload(load_picker_context())' in code and not re.search(r'refresh\s*=', code)
