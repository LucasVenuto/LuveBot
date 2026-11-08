"""ADR-010: one budget watcher per luvebot.db. The lease row decides in ONE BEGIN IMMEDIATE, in the database's clock, and everything fails toward RUNNING (invariant 7): only a lease that was
READ, held by another process with a fresh beat, keeps a process out. A pass that finished renews it, one that threw gives it up. A dashboard takes it from a gateway (only while the gateway's
beat is fresh). The plan's state lives in budget_exec_state, the pause notice is stateless with a 10-minute window, /health says who holds the lease (never a pid, host or id).
Mutations of watcher_lease.py, executor.py and plugin_api.py are red."""
from contextlib import contextmanager
import importlib
import importlib.util
import itertools
import json
import logging
from pathlib import Path
import re
import sqlite3
import sys
import threading
import time
import types

import pytest

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / 'backend'
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
_n = itertools.count()


def load(*edits):
    name = f'wl_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[name] = pkg
    spec.loader.exec_module(pkg)
    for which, old, new in edits:
        source = (BACKEND / f'{which}.py').read_text()
        assert source.count(old) == 1, old
        module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.{which}', loader=None))
        module.__package__ = name
        sys.modules[f'{name}.{which}'] = module
        exec(compile(source.replace(old, new), str(BACKEND / f'{which}.py'), 'exec'), module.__dict__)
    return {m: importlib.import_module(f'{name}.{m}') for m in ('watcher_lease', 'executor')}


def row(path):
    conn = sqlite3.connect(path)
    try:
        return conn.execute('SELECT owner, kind, beat, CAST(strftime(\'%s\',\'now\') AS INTEGER) FROM watcher_lease').fetchone()
    except sqlite3.OperationalError:
        return None
    finally:
        conn.close()


def db(path):
    """An existing, empty database file: the lease never creates one."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    sqlite3.connect(path).close()
    return path


def age(path, seconds):
    """Make the stored beat `seconds` older (the owner is dead, or slow)."""
    conn = sqlite3.connect(path)
    conn.execute('UPDATE watcher_lease SET beat = beat - ?', (seconds,))
    conn.commit()
    conn.close()


# ---- the lease ----------------------------------------------------------------------------------------------------------------------------------
def lease_checks(m, tmp_path):
    wl, path = m['watcher_lease'], db(tmp_path / 'luvebot.db')
    a, b = wl.Lease(path, kind='dashboard', owner='A'), wl.Lease(path, kind='dashboard', owner='B')
    assert a.enter() is True and b.enter() is False and a.enter() is True       # the first owns it; a fresh lease keeps the other out; the owner goes on
    assert row(path)[0] == 'A'
    age(path, wl.EXPIRES_S + 5)                                                  # A died without giving it up
    assert b.enter() is True and row(path)[0] == 'B'                             # the other takes over on its next tick
    assert a.enter() is False                                                    # and the old owner, back, finds it taken
    # a failed pass gives it up; a finished one renews it
    b.release()
    assert row(path) is None and a.enter() is True                               # the other process runs on its next tick
    a.release(); b.release()                                                     # releasing what is not yours changes nothing
    assert a.enter() is True
    b.release()
    assert row(path)[0] == 'A'
    age(path, 50)
    before = row(path)[2]
    a.renew()
    assert row(path)[2] > before                                                 # a finished pass keeps it
    b.renew()
    assert row(path)[0] == 'A'                                                   # renewing is only for the owner
    # a dashboard takes it from a gateway while the gateway's beat is fresh; a gateway never takes it from a dashboard
    path2 = db(tmp_path / 'two.db')
    gateway, dashboard = wl.Lease(path2, kind='gateway', owner='G'), wl.Lease(path2, kind='dashboard', owner='D')
    assert gateway.enter() is True and dashboard.enter() is True and row(path2)[:2] == ('D', 'dashboard')
    assert gateway.enter() is False
    path3 = db(tmp_path / 'three.db')
    dashboard3, gateway3 = wl.Lease(path3, kind='dashboard', owner='D'), wl.Lease(path3, kind='gateway', owner='G')
    assert dashboard3.enter() is True and gateway3.enter() is False
    age(path3, wl.EXPIRES_S + 5)
    assert gateway3.enter() is True                                              # with no dashboard alive the gateway keeps it
    # no kind that can be read: a plain lease, no preference
    path4 = db(tmp_path / 'four.db')
    plain, other = wl.Lease(path4, kind=None, owner='P'), wl.Lease(path4, kind='dashboard', owner='D')
    assert plain.enter() is True and other.enter() is False and wl.Lease(path4, kind='nonsense', owner='X').kind is None
    assert wl.kind_of(types.SimpleNamespace(state=types.SimpleNamespace(gateway_runner=object()))) == 'gateway'
    assert wl.kind_of(types.SimpleNamespace(state=types.SimpleNamespace())) == 'dashboard'
    assert wl.kind_of(None) is None and wl.kind_of(types.SimpleNamespace()) is None
    assert wl.kind_of(types.SimpleNamespace(state=types.SimpleNamespace()), proven=False) is None                           # an importer that proves nothing is no dashboard
    assert wl.kind_of(types.SimpleNamespace(state=types.SimpleNamespace(gateway_runner=object())), proven=False) == 'gateway'   # the gateway label has no power to steal
    # the database's clock, not the process's: a process whose clock is far ahead still sees a fresh lease as fresh
    path5 = db(tmp_path / 'five.db')
    first, second = wl.Lease(path5, kind='dashboard', owner='F'), wl.Lease(path5, kind='dashboard', owner='S')
    assert first.enter() is True
    real = time.time
    time.time = lambda: real() + 10_000
    try:
        assert second.enter() is False
    finally:
        time.time = real
    assert first.enter() is True


def file_checks(m, tmp_path):
    wl = m['watcher_lease']
    home = tmp_path / 'luvebot'
    home.mkdir()
    path = home / 'luvebot.db'
    lease = wl.Lease(path, kind='dashboard', owner='F')
    assert lease.enter() is True and not path.exists()                           # the folder is there, the file is not: the lease does not create it (the pass does); it runs
    lease.renew(); lease.release()
    assert not path.exists()
    sqlite3.connect(path).close()
    path.chmod(0o644)                                                             # a database that exists with a loose mode
    assert lease.enter() is True and (path.stat().st_mode & 0o777) == 0o600       # it is put back to 0600 before anything opens it
    other = wl.Lease(path, kind='dashboard', owner='O')
    assert other.enter() is False and (path.stat().st_mode & 0o777) == 0o600      # and stays so


def failure_checks(m, tmp_path):
    wl = m['watcher_lease']
    unreadable = wl.Lease(tmp_path, kind='dashboard', owner='U')                 # a directory is no database
    assert unreadable.enter() is True                                            # a lease that cannot be read: the watcher RUNS
    unreadable.renew(); unreadable.release()                                     # and these never raise
    broken = tmp_path / 'broken.db'
    conn = sqlite3.connect(broken)
    conn.execute('CREATE TABLE watcher_lease (other_column TEXT)')                    # a table of the wrong shape
    conn.commit()
    conn.close()
    assert wl.Lease(broken, kind='dashboard', owner='U').enter() is True


def race_checks(m, tmp_path):
    wl = m['watcher_lease']
    statements = []
    real = wl.dbfile.connect

    def traced(*args, **kwargs):
        conn = real(*args, **kwargs)
        conn.set_trace_callback(statements.append)
        return conn
    wl.dbfile.connect = traced
    try:
        assert wl.Lease(db(tmp_path / 'trace.db'), kind='dashboard', owner='T').enter() is True
    finally:
        wl.dbfile.connect = real
    begin = next(i for i, s in enumerate(statements) if s.startswith('BEGIN'))
    assert statements[begin] == 'BEGIN IMMEDIATE'                                           # the decision and the write are ONE write transaction
    assert all('FROM watcher_lease' not in s for s in statements[:begin]) and any('FROM watcher_lease' in s for s in statements[begin:])   # the lease is read INSIDE it
    for round_ in range(12):                                                     # several fresh databases: whoever wins, exactly one runs
        path = db(tmp_path / f'race{round_}.db')
        results, start = [], threading.Barrier(6)

        def go(n):
            start.wait()
            results.append(wl.Lease(path, kind='dashboard', owner=f'T{n}').enter())
        threads = [threading.Thread(target=go, args=(n,)) for n in range(6)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        assert results.count(True) == 1, results


def view_checks(m, tmp_path):
    wl, path = m['watcher_lease'], db(tmp_path / 'luvebot.db')
    assert wl.view(path, 'A') == {'held': None, 'owner_kind': None}              # no lease yet (and no table)
    a = wl.Lease(path, kind='gateway', owner='A')
    a.enter()
    assert wl.view(path, 'A') == {'held': True, 'owner_kind': 'gateway'} and wl.view(path, 'B') == {'held': False, 'owner_kind': 'gateway'}
    age(path, wl.EXPIRES_S + 5)
    assert wl.view(path, 'A') == {'held': None, 'owner_kind': None}              # an expired lease is nobody's
    assert wl.view(tmp_path, 'A') == {'held': None, 'owner_kind': None}          # unreadable: not told
    a.renew()
    assert set(wl.view(path, 'A')) == {'held', 'owner_kind'} and 'A' not in json.dumps(wl.view(path, 'A'))   # never a pid, a host or an id


CHECKS = {'lease': lease_checks, 'file': file_checks, 'failure': failure_checks, 'race': race_checks, 'view': view_checks}
MUTATIONS = [
    ('lease', 'no expiry', "age <= self.expires and not", "True and not"),
    ('lease', 'no preference for the dashboard', "not (row[1] == 'gateway' and self.kind == 'dashboard')", "True"),
    ('lease', 'the gateway takes it from the dashboard too', "not (row[1] == 'gateway' and self.kind == 'dashboard')", "False"),
    ('lease', 'the process clock instead of the database\'s', "now = conn.execute(f'SELECT {_NOW}').fetchone()[0]", "now = int(__import__('time').time())"),
    ('lease', 'a renewal by anyone', "UPDATE watcher_lease SET beat={_NOW} WHERE id=1 AND owner=?", "UPDATE watcher_lease SET beat={_NOW} WHERE id=1 AND ?=?"),
    ('lease', 'a release of anyone\'s lease', "DELETE FROM watcher_lease WHERE id=1 AND owner=?', (self.owner,))", "DELETE FROM watcher_lease WHERE id=1 AND ?=?', (self.owner, self.owner))"),
    ('lease', 'an importer passes for a dashboard', "        return 'dashboard' if proven else None", "        return 'dashboard'"),
    ('file', 'the lease creates the database', "        if not os.path.exists(self.path):\n            raise OSError('no database yet')", "        if False:\n            raise OSError('no database yet')"),
    ('file', 'the mode of an existing file is not looked at', "        dbfile.prepare(self.path)  # an existing file only", "        pass  # an existing file only"),
    ('failure', 'an unreadable lease stops the watcher', "        except Exception:  # noqa: BLE001  (unreadable, locked, a write that failed: the watcher runs)\n            return True", "        except Exception:  # noqa: BLE001  (unreadable, locked, a write that failed: the watcher runs)\n            return False"),
    ('race', 'a deferred transaction (two owners)', "conn.execute('BEGIN IMMEDIATE')", "conn.execute('BEGIN')"),
    ('view', 'the owner id leaks', "return {'held': row[0] == owner, 'owner_kind': row[1] if row[1] in KINDS else None}", "return {'held': row[0] == owner, 'owner_kind': row[1] if row[1] in KINDS else None, 'owner': row[0]}"),
    ('view', 'an expired lease is shown as held', "if row is None or row[2] > expires:", "if row is None:"),
]


@pytest.mark.parametrize('name', sorted(CHECKS))
def test_the_lease_holds(name, tmp_path):
    CHECKS[name](load(), tmp_path)


def test_every_lease_check_has_a_mutation():
    assert set(CHECKS) == {name for name, *_ in MUTATIONS}


@pytest.mark.parametrize('name,label,old,new', MUTATIONS, ids=[f'{n}|{l}' for n, l, *_ in MUTATIONS])
def test_each_lease_mutation_is_caught(name, label, old, new, tmp_path):
    with pytest.raises(Exception):  # noqa: B017
        CHECKS[name](load(('watcher_lease', old, new)), tmp_path)


# ---- the tick: the hold, the check of r44, the lease, the pass ----------------------------------------------------------------------------------
def tick_of(source, monkeypatch, tmp_path, *, lease, wl=None, served=False, serving=None, hold=False, passes='ok'):
    """The REAL `_background_tick`, with stand-ins for the rest. -> (how many passes began, the lease it used)."""
    text = re.search(r'def _background_tick\(\):.*?(?=\n\n\ndef _background_loop)', source, re.S).group(0)
    home = tmp_path / 'home'
    (home / 'luvebot').mkdir(parents=True, exist_ok=True)
    (home / 'luvebot' / 'watcher.hold').unlink(missing_ok=True)
    if hold:
        (home / 'luvebot' / 'watcher.hold').write_text('')
    fake = types.ModuleType('hermes_cli.web_server_profiles')
    fake.get_process_hermes_home = lambda: home
    monkeypatch.setitem(sys.modules, 'hermes_cli', types.ModuleType('hermes_cli'))
    monkeypatch.setitem(sys.modules, 'hermes_cli.web_server_profiles', fake)
    began = []

    def watch_pass():
        began.append(1)
        if passes == 'long':
            age(home / 'luvebot' / 'luvebot.db', 60)       # a pass that takes a minute: the beat from the start of the tick is old by its end
        if passes == 'throws':
            raise RuntimeError('the pass failed')
        return False if passes == 'no_heartbeat' else True      # run_pass says False when a session read failed
    ns = {'hermes_compat': types.SimpleNamespace(read=lambda: (None, 'in_process'), read_app=lambda: None, serving=lambda *_a: (serving, 'stub')),
          '_watch_pass': watch_pass, '_lease_for': lambda path: lease(path), 'logging': logging, '_SERVED': [served], 'watcher_lease': wl}
    exec(text, ns)
    ns['_background_tick']()
    return len(began), home / 'luvebot' / 'luvebot.db'


def tick_checks(source, monkeypatch, tmp_path, wl):
    path = tmp_path / 'home' / 'luvebot' / 'luvebot.db'
    path.parent.mkdir(parents=True, exist_ok=True)
    sqlite3.connect(path).close()                                                  # the database exists (the lease never creates it)
    run = lambda *a, **k: tick_of(*a, wl=wl, **k)  # noqa: E731
    mine = lambda p: wl.Lease(p, kind='dashboard', owner='ME')  # noqa: E731
    other = lambda: wl.Lease(path, kind='dashboard', owner='OTHER')  # noqa: E731
    # the hold wins over everything: no lease is even touched
    assert run(source, monkeypatch, tmp_path, lease=mine, hold=True)[0] == 0 and row(path) is None
    # the check of r44 says "does not serve": out, with the database untouched
    assert run(source, monkeypatch, tmp_path, lease=mine, serving=False)[0] == 0 and row(path) is None
    # a request that was answered makes it take part in the lease, it does not excuse it from losing it
    assert other().enter() is True
    assert run(source, monkeypatch, tmp_path, lease=mine, serving=False, served=True)[0] == 0 and row(path)[0] == 'OTHER'
    assert run(source, monkeypatch, tmp_path, lease=mine)[0] == 0                       # someone else holds a fresh lease: no pass
    age(path, 100)                                                                           # it died: this one takes over and runs
    assert run(source, monkeypatch, tmp_path, lease=mine)[0] == 1 and row(path)[0] == 'ME'
    # a pass that FINISHED renews the lease at its END too (a long pass would otherwise end with an old beat)
    assert run(source, monkeypatch, tmp_path, lease=mine, passes='long')[0] == 1
    assert row(path)[3] - row(path)[2] <= 3
    # a pass that THREW gives it up, so the other takes over on its next tick (a broken owner never keeps it)
    assert run(source, monkeypatch, tmp_path, lease=mine, passes='throws')[0] == 1 and row(path) is None
    assert other().enter() is True
    # a pass WITHOUT a heartbeat (a session read failed) did not finish well either: it gives the lease up, a healthy process takes over
    age(path, 100)
    assert run(source, monkeypatch, tmp_path, lease=mine, passes='no_heartbeat')[0] == 1 and row(path) is None
    assert other().enter() is True
    # a lease that cannot be read: the pass runs all the same
    assert run(source, monkeypatch, tmp_path, lease=lambda p: wl.Lease(tmp_path / 'nowhere.db', kind='dashboard', owner='ME'))[0] == 1
    assert run(source, monkeypatch, tmp_path, lease=lambda p: (_ for _ in ()).throw(RuntimeError('no lease')))[0] == 1   # even building it failed


def test_the_tick_follows_the_order_of_the_adr(monkeypatch, tmp_path):
    tick_checks(API, monkeypatch, tmp_path, load()['watcher_lease'])


def kind_tick(source, wl, tmp_path, app, *, serving, served=False, owner='ME', cache=None, registered=None):
    """The REAL `_lease_for` and `_background_tick` together, the lease objects cached the way the process caches them. -> passes that began."""
    home = tmp_path / 'home'
    (home / 'luvebot').mkdir(parents=True, exist_ok=True)
    (home / 'luvebot' / 'watcher.hold').unlink(missing_ok=True)
    sqlite3.connect(home / 'luvebot' / 'luvebot.db').close()
    fake = types.ModuleType('hermes_cli.web_server_profiles')
    fake.get_process_hermes_home = lambda: home
    sys.modules['hermes_cli'] = types.ModuleType('hermes_cli')
    sys.modules['hermes_cli.web_server_profiles'] = fake
    began = []
    proxy = types.SimpleNamespace(Lease=lambda path: wl.Lease(path, owner=owner), kind_of=wl.kind_of)
    ns = {'hermes_compat': types.SimpleNamespace(read=lambda: (None, 'in_process'), read_app=lambda: app, serving=lambda *_a: (serving, 'stub')), 'logging': logging,
          '_watch_pass': lambda: began.append(1) or True, '_SERVED': [served], 'watcher_lease': proxy, '_LEASES': {} if cache is None else cache,
          'atexit': types.SimpleNamespace(register=(registered.append if registered is not None else (lambda f: None)))}
    for name in ('_lease_for', '_background_tick'):
        exec(re.search(rf'def {name}\(.*?(?=\n\n\ndef )', source, re.S).group(0), ns)
    ns['_background_tick']()
    return len(began)


def kind_checks(source, wl, tmp_path):
    path = tmp_path / 'home' / 'luvebot' / 'luvebot.db'
    path.parent.mkdir(parents=True, exist_ok=True)
    sqlite3.connect(path).close()
    gateway_app = types.SimpleNamespace(state=types.SimpleNamespace())
    cache = {}
    # the gateway sets `gateway_runner` AFTER the import in which its first pass runs: the first pass sees a dashboard, a later one must see the gateway
    assert kind_tick(source, wl, tmp_path, gateway_app, serving=True, owner='GW', cache=cache) == 1 and row(path)[:2] == ('GW', 'dashboard')
    gateway_app.state.gateway_runner = object()
    assert kind_tick(source, wl, tmp_path, gateway_app, serving=True, owner='GW', cache=cache) == 1 and row(path)[:2] == ('GW', 'gateway')   # the kind follows
    # a dashboard (proven) takes the lease from the fresh gateway; one that proves nothing does not
    importer = types.SimpleNamespace(state=types.SimpleNamespace())
    assert kind_tick(source, wl, tmp_path, importer, serving=None, owner='IMP') == 0 and row(path)[0] == 'GW'                       # an importer of a build nobody pinned: no proof, no theft
    assert kind_tick(source, wl, tmp_path, importer, serving=False, owner='IMP2') == 0 and row(path)[0] == 'GW'
    assert kind_tick(source, wl, tmp_path, importer, serving=None, served=True, owner='DASH') == 1 and row(path)[:2] == ('DASH', 'dashboard')   # a request reached it: it serves
    # and the lease is given up on a clean exit
    path2 = tmp_path / 'home' / 'luvebot' / 'luvebot.db'
    registered = []
    age(path2, 100)                                                                # the dashboard before it died: this one takes over
    kind_tick(source, wl, tmp_path, importer, serving=True, owner='EXIT', registered=registered)
    assert len(registered) == 1
    registered[0]()
    assert row(path2) is None


def test_the_kind_is_read_every_pass_and_a_dashboard_needs_proof(tmp_path):
    kind_checks(API, load()['watcher_lease'], tmp_path)


KIND_MUTATIONS = [
    ("            lease.set_kind(watcher_lease.kind_of(hermes_compat.read_app(), serving is True or _SERVED[0]))  # read NOW", "            pass  # read NOW"),
    ("kind_of(hermes_compat.read_app(), serving is True or _SERVED[0])", "kind_of(hermes_compat.read_app(), True)"),
    ("kind_of(hermes_compat.read_app(), serving is True or _SERVED[0])", "kind_of(hermes_compat.read_app(), serving is True)"),
    ("        atexit.register(_LEASES[key].release)", "        pass"),
]


@pytest.mark.parametrize('old,new', KIND_MUTATIONS, ids=['kind_kept_from_the_first_pass', 'an_importer_passes_for_a_dashboard', 'a_request_is_no_proof', 'no_release_on_exit'])
def test_each_kind_mutation_is_caught(tmp_path, old, new):
    assert API.count(old) == 1, old
    with pytest.raises(Exception):  # noqa: B017
        kind_checks(API.replace(old, new), load()['watcher_lease'], tmp_path)


def test_the_pass_hands_back_its_heartbeat():
    block = API.split('def _watch_pass():', 1)[1].split('\ndef ', 1)[0]
    assert block.rstrip().endswith("return result['heartbeat']  # False when a session read failed: no heartbeat, and the tick then gives the lease up")
    assert "passed = _watch_pass() is not False" in API


TICK_MUTATIONS = [
    ("            passed = _watch_pass() is not False", "            _watch_pass()\n            passed = True"),
    ("        if lease is not None and not lease.enter():", "        if False:"),
    ("                if passed:\n                    lease.renew()", "                if True:\n                    lease.renew()"),
    ("                    lease.release()  # one that threw", "                    pass  # one that threw"),
    ("                    lease.renew()    # a pass that FINISHED keeps the lease", "                    pass    # a pass that FINISHED keeps the lease"),
    ("        if serving is False and not _SERVED[0]:", "        if serving is False and not _SERVED[0] and False:"),
    ("        except Exception:  # noqa: BLE001\n            lease = None\n", "        except ZeroDivisionError:\n            lease = None\n"),
    ("        if (home / 'luvebot/watcher.hold').exists():", "        if False:"),
]


@pytest.mark.parametrize('old,new', TICK_MUTATIONS, ids=['renewed_without_a_heartbeat', 'lease_ignored', 'renewed_on_failure', 'never_released', 'never_renewed', 'predicate_skipped', 'lease_error_kills_the_tick', 'hold_ignored'])
def test_each_tick_mutation_is_caught(monkeypatch, tmp_path, old, new):
    assert API.count(old) == 1, old
    with pytest.raises(Exception):  # noqa: B017
        tick_checks(API.replace(old, new), monkeypatch, tmp_path, load()['watcher_lease'])


def test_the_lease_is_wired_to_the_database_the_app_uses_and_to_health():
    assert "watcher_lease.Lease(path)  # its kind is set on every tick, with the proof of the moment" in API
    assert "lease.set_kind(watcher_lease.kind_of(hermes_compat.read_app(), serving is True or _SERVED[0]))" in API
    assert "lease = _lease_for(home / 'luvebot/luvebot.db')" in API                          # the file `_stores` opens
    assert "'lease': await run_in_threadpool(watcher_lease.view, db_path)" in API


# ---- the plan's state in the database ---------------------------------------------------------------------------------------------------------------
class Audit:
    def act(self, actor, action, target, origin, fn, *, bot=None, payload=None):
        return fn()


class Cron:
    def __init__(self, fail=()):
        self.fail, self.jobs = set(fail), [{'id': 'j1', 'enabled': True, 'state': 'scheduled'}, {'id': 'j2', 'enabled': True, 'state': 'scheduled'}]

    def list_jobs(self, bot):
        return [dict(j) for j in self.jobs]

    def pause(self, bot, job_id, reason):
        if job_id in self.fail:
            raise RuntimeError('hermes refused')
        for j in self.jobs:
            if j['id'] == job_id:
                j.update(state='paused', paused_reason=reason)


class Runs:
    def open(self, bot):
        return []

    def stop(self, bot, run_id):
        return True


def plan_checks(m, tmp_path):
    ex = m['executor']
    path = tmp_path / 'luvebot.db'
    first = ex.Executor(path, None, Audit(), Cron(fail=('j2',)), Runs())
    assert first.plan_status('vendas') == 'pending'                                        # before the first apply
    out = first.apply('vendas')
    assert out['failed'] == ['pause_cron_job:j2'] and first.plan_status('vendas') == 'pending'
    conn = sqlite3.connect(path)
    assert conn.execute('SELECT plan_status, plan_failed FROM budget_exec_state WHERE bot=?', ('vendas',)).fetchone() == ('pending', '["pause_cron_job:j2"]')
    conn.close()
    second = ex.Executor(path, None, Audit(), Cron(), Runs())                              # ANOTHER process: its own memory, the same database
    assert second.plan_status('vendas') == 'pending'
    assert second.apply('vendas')['failed'] == [] and second.plan_status('vendas') == 'applied' and first.plan_status('vendas') == 'applied'
    conn = sqlite3.connect(path)
    assert conn.execute('SELECT plan_status, plan_failed FROM budget_exec_state WHERE bot=?', ('vendas',)).fetchone() == ('applied', '[]')
    conn.close()
    assert second.resume('vendas')['resumed'] == [] and second.plan_status('vendas') == 'pending'   # the resume removes the row: back to the default
    # a table from before the columns: migrated once, the row kept
    old = tmp_path / 'old.db'
    conn = sqlite3.connect(old)
    conn.execute('CREATE TABLE budget_exec_state (bot TEXT PRIMARY KEY, since REAL NOT NULL, estop_noted INTEGER NOT NULL DEFAULT 0)')
    conn.execute("INSERT INTO budget_exec_state (bot, since) VALUES ('suporte', 1800000000.5)")
    conn.commit()
    conn.close()
    migrated = ex.Executor(old, None, Audit(), Cron(), Runs())
    assert migrated.since('suporte') == 1800000000.5 and migrated.plan_status('suporte') == 'pending'
    migrated.apply('suporte')
    assert migrated.plan_status('suporte') == 'applied'


def test_the_plan_status_lives_in_the_database(tmp_path):
    plan_checks(load(), tmp_path)


PLAN_MUTATIONS = [
    ('executor', '("pending" if out["failed"] else "applied", json.dumps(out["failed"]), bot)', '("applied", json.dumps(out["failed"]), bot)'),
    ('executor', '("pending" if out["failed"] else "applied", json.dumps(out["failed"]), bot)', '("pending", json.dumps(out["failed"]), bot)'),
    ('executor', 'conn.execute("UPDATE budget_exec_state SET plan_status=?, plan_failed=? WHERE bot=?",', 'conn.execute("UPDATE budget_exec_state SET plan_failed=?, plan_failed=? WHERE bot=?" if False else "UPDATE budget_exec_state SET estop_noted=estop_noted WHERE bot=? AND ?=? AND ?=?",'),
    ('executor', '            conn.execute(f"ALTER TABLE budget_exec_state ADD COLUMN {column} TEXT")\n', '            pass\n'),
    ('executor', 'return row[0] if row and row[0] in ("applied", "pending") else "pending"', 'return row[0] if row else "applied"'),
]


@pytest.mark.parametrize('old_new', PLAN_MUTATIONS, ids=['always_applied', 'always_pending', 'never_written', 'no_migration', 'default_is_applied'])
def test_each_plan_mutation_is_caught(old_new, tmp_path):
    which, old, new = old_new
    with pytest.raises(Exception):  # noqa: B017
        plan_checks(load((which, old, new)), tmp_path)


def test_budget_reads_the_plan_from_the_database():
    assert "'plan_status': executor.plan_status(bot)" in API and '_PLAN_STATUS' not in API and '_run_executor' not in API


# ---- the pause notice: no memory, a window -------------------------------------------------------------------------------------------------------
def notify_of(source, paused, keys, now):
    text = '\n'.join(re.search(pattern, source, re.S).group(0) for pattern in (r"_PAUSE_WINDOW_S = .*?\n", r"def _notify_new_pauses\(.*?(?=\n\n\ndef _pause_key)"))
    sent = []
    ns = {'budget': None, 'time': types.SimpleNamespace(time=lambda: now), 'logging': logging,
          '_pause_key': lambda path, bot: keys.get(bot), '_push': lambda path: types.SimpleNamespace(notify=lambda audit, kind, bot, key: sent.append((kind, bot, key)))}
    exec(text, ns)
    ns['_notify_new_pauses']('audit', 'path', types.SimpleNamespace(snapshot=lambda: {'paused': paused}))
    return sent


def notice_checks(source):
    now = 1_800_000_000.0
    keys = {'vendas': f'pause:vendas:{now - 300}', 'suporte': f'pause:suporte:{now - 1200}', 'caixa': None, 'odd': 'pause:odd:not-a-number'}
    sent = notify_of(source, ['vendas', 'suporte', 'caixa', 'odd'], keys, now)
    assert sent == [('budget', 'vendas', keys['vendas'])]                                    # only a pause of the last 10 minutes, with its key; an old one, one with no key or an odd one are not
    assert notify_of(source, ['vendas'], keys, now) == sent                                  # no memory: the same call says the same (the database's key makes it once)
    assert notify_of(source, ['vendas'], keys, now + 400) == []                              # 700 s after the pause: the window closed
    assert notify_of(source, [], keys, now) == []


def test_the_pause_notice_has_no_memory_and_a_window():
    notice_checks(API)
    assert '_PAUSED_SEEN' not in API


@pytest.mark.parametrize('old,new', [
    ("            if since is None or time.time() - since > _PAUSE_WINDOW_S:\n                continue", "            if since is None:\n                continue"),
    ("            if since is None or time.time() - since > _PAUSE_WINDOW_S:\n                continue", "            if False:\n                continue"),
    ("_PAUSE_WINDOW_S = 600.0", "_PAUSE_WINDOW_S = 6000000.0"),
    ("            _push(path).notify(audit, 'budget', bot, key)", "            _push(path).notify(audit, 'budget', bot)"),
], ids=['no_window', 'no_window_no_none_check', 'a_wide_window', 'the_key_is_not_passed'])
def test_each_notice_mutation_is_caught(old, new):
    assert API.count(old) == 1, old
    with pytest.raises(Exception):  # noqa: B017
        notice_checks(API.replace(old, new))
