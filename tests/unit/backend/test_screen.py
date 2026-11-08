"""D-007: backend/screen.py, the plugin's side of the live screen, against a stand-in for Hermes's display RPC that reproduces the
semantics our logic relies on (tui_gateway/methods_display.py: ids minted per connection, acquire refuses an id another connection
minted, release(viewer_id) touches only that holder, stop refuses while a person holds). The REAL Hermes is exercised by the screen
harness (tests/harness/display/). Every invariant also runs against variants of screen.py with one defect each: each must go red."""
import asyncio
import hashlib
import importlib
import itertools
import json
from pathlib import Path
import shutil
import sqlite3
import sys

import pytest

import backend.screen as real

SRC = Path(real.__file__).parent
_n = itertools.count()


class FakeHermes:
    def __init__(self, m, **status):
        self.m = m
        self.snapshot = {'supported': True, 'installed': True, 'missing': [], 'install_command': None, 'running': True,
                         'geometry': '1440x900', 'placement': 'gateway', 'memory_available_mb': 3000, 'memory_limit_mb': None,
                         'blocker': None, **status}
        self.lease = {'holder': 'agent', 'viewer_id': None, 'since': 1.0, 'reason': '', 'epoch': 0}
        self.calls, self.conn, self.on_acquire, self.on_release = [], 0, None, None

    def public(self):
        vid = self.lease['viewer_id']
        return {**{k: v for k, v in self.lease.items() if k != 'viewer_id'}, 'viewer_id': None,
                'viewer_hash': hashlib.sha256(vid.encode()).hexdigest()[:12] if vid else None}

    def runner(self, fn):
        self.conn += 1
        conn, minted = self.conn, set()

        async def call(method, params):
            self.calls.append((conn, method, dict(params)))
            if method == 'display.status':
                return {**self.snapshot, 'lease': self.public()}
            if method == 'display.start':
                self.snapshot['running'] = True
                return {**self.snapshot, 'lease': self.public()}
            if method == 'display.stop':
                if self.lease['holder'] == 'human' and not params.get('force'):
                    raise self.m.RpcError(5300, 'a human holds this screen', {'code': 'viewer_mismatch'})
                self.snapshot['running'] = False
                return {**self.snapshot, 'lease': self.public(), 'stopped': True}
            if method == 'display.observe':
                if not self.snapshot['running']:
                    raise self.m.RpcError(5300, 'not running')
                vid = f'vid-{next(_n)}-secret'
                minted.add(vid)
                return {'ticket': f'ticket-{next(_n)}', 'path': '/api/display/ws', 'viewer_id': vid, **self.snapshot, 'lease': self.public()}
            if method == 'display.lease.acquire':
                if self.on_acquire:
                    self.on_acquire(params)
                if params['viewer_id'] not in minted:
                    raise self.m.RpcError(5300, 'viewer_id was not minted for this connection', {'code': 'viewer_mismatch'})
                self.lease = {'holder': 'human', 'viewer_id': params['viewer_id'], 'since': 2.0, 'reason': params.get('reason', ''), 'epoch': 1}
                return {'lease': self.public()}
            if method == 'display.lease.release':
                if self.on_release:
                    self.on_release(params)
                if params.get('viewer_id') not in minted and not params.get('force'):
                    raise self.m.RpcError(5300, 'foreign', {'code': 'viewer_mismatch'})
                if self.lease['holder'] == 'human' and self.lease['viewer_id'] == params.get('viewer_id'):
                    self.lease = {'holder': 'agent', 'viewer_id': None, 'since': 3.0, 'reason': '', 'epoch': 2}
                return {'lease': self.public()}
            raise AssertionError(f'unexpected Hermes call {method}')
        return asyncio.run(fn(call))

    def methods(self):
        return [c[1] for c in self.calls]


def rig(m, tmp, **status):
    hermes = FakeHermes(m, **status)
    return hermes, m.Screen(tmp / 'fleet.db', runner=hermes.runner, needed_mb=lambda bot: 1536)


def no_viewer_id(value):
    text = json.dumps(value)
    return 'vid-' not in text and 'viewer_id' not in text


def refused(m, code, fn, *args):
    from backend.api_errors import PluginError as RealError
    try:
        fn(*args)
    except Exception as error:   # the variant package has its own PluginError class
        assert 'PluginError' in [c.__name__ for c in type(error).__mro__] and error.code == code, (code, getattr(error, 'code', error))
        return error
    raise AssertionError(f'expected {code}')


# ---------------------------------------------------------------------------------------------------------------------
def inv_honest_refusals_and_never_install(m, tmp):
    hermes, screen = rig(m, tmp, supported=False, running=False)
    refused(m, 'screen_unsupported', screen.start, 'vendas', 'basic:ana')
    hermes, screen = rig(m, tmp, installed=False, running=False, missing=['Xvnc', 'xfwm4'], install_command='sudo apt-get install -y tigervnc')
    error = refused(m, 'screen_not_installed', screen.start, 'vendas', 'basic:ana')
    assert error.extra['details'] == {'missing': ['Xvnc', 'xfwm4'], 'install_command': 'sudo apt-get install -y tigervnc'}
    view = screen.view('vendas', 'basic:ana')
    assert view['installed'] is False and view['missing'] == ['Xvnc', 'xfwm4'] and view['running'] is False
    hermes, screen = rig(m, tmp, running=False, blocker='Not enough free memory', memory_available_mb=900)
    error = refused(m, 'screen_no_memory', screen.start, 'vendas', 'basic:ana')
    assert error.extra['details'] == {'available_mb': 900, 'needed_mb': 1536}
    hermes, screen = rig(m, tmp, running=False)
    assert screen.start('vendas', 'basic:ana')['running'] is True
    assert 'display.install' not in hermes.methods() and hermes.methods()[-1] == 'display.start'


def inv_watch_never_takes_control(m, tmp):
    hermes, screen = rig(m, tmp, running=False)
    refused(m, 'screen_not_running', screen.watch, 'vendas')
    hermes.snapshot['running'] = True
    out = screen.watch('vendas')
    assert set(out) == {'ticket', 'path', 'expires_in'} and out['path'] == '/api/display/ws' and out['expires_in'] == 30
    assert 'display.lease.acquire' not in hermes.methods() and hermes.lease['holder'] == 'agent' and screen.viewers() == []


def inv_take_is_one_connection_and_stored_first(m, tmp):
    hermes, screen = rig(m, tmp)
    seen = []
    hermes.on_acquire = lambda params: seen.append(screen.viewer('vendas', 'basic:ana'))   # what is stored at the moment of acquire
    out = screen.take('vendas', 'basic:ana', 'logar no banco')
    observe = [c for c in hermes.calls if c[1] == 'display.observe'][-1]
    acquire = [c for c in hermes.calls if c[1] == 'display.lease.acquire'][-1]
    assert observe[0] == acquire[0]                                                     # the id belongs to the connection that minted it
    assert seen == [acquire[2]['viewer_id']]                                            # stored BEFORE the lease was taken
    assert acquire[2]['reason'] == 'LuveBot (basic:ana): logar no banco'
    assert set(out) == {'ticket', 'path', 'expires_in', 'lease'} and no_viewer_id(out)
    assert out['lease'] == {'holder': 'human', 'since': 2.0, 'mine': True, 'by_luvebot': True}
    view = screen.view('vendas', 'basic:bia')                                             # someone else looking: not theirs
    assert view['lease']['mine'] is False and view['lease']['by_luvebot'] is True and no_viewer_id(view)
    hermes2, screen2 = rig(m, tmp / 'b')                                                  # an acquire that fails leaves nothing behind
    (tmp / 'b').mkdir()
    hermes2.on_acquire = lambda params: (_ for _ in ()).throw(m.RpcError(5300, 'refused'))
    refused(m, 'screen_take_failed', screen2.take, 'vendas', 'basic:ana', '')
    assert screen2.viewers() == []
    assert len(screen.take('vendas', 'basic:ana', 'x\n\x00' * 100)['lease']) == 4 and len([c for c in hermes.calls if c[1] == 'display.lease.acquire'][-1][2]['reason']) <= 160


def inv_return_only_your_own(m, tmp):
    hermes, screen = rig(m, tmp)
    refused(m, 'screen_not_yours', screen.give_back, 'vendas', 'basic:ana')               # nothing stored
    screen.take('vendas', 'basic:ana', '')
    refused(m, 'screen_not_yours', screen.give_back, 'vendas', 'basic:bia')               # another person
    hermes.lease = {'holder': 'human', 'viewer_id': 'someone-else', 'since': 5.0, 'reason': '', 'epoch': 3}   # taken over since
    before = len(hermes.calls)
    refused(m, 'screen_not_yours', screen.give_back, 'vendas', 'basic:ana')
    assert 'display.lease.release' not in [c[1] for c in hermes.calls[before:]] and screen.viewers() == []
    assert hermes.lease['viewer_id'] == 'someone-else'                                    # their control is untouched
    screen.take('vendas', 'basic:ana', '')
    out = screen.give_back('vendas', 'basic:ana')
    release = [c for c in hermes.calls if c[1] == 'display.lease.release'][-1][2]
    assert release['force'] is True and release['viewer_id'].startswith('vid-')
    assert out == {'lease': {'holder': 'agent', 'since': 3.0, 'mine': False, 'by_luvebot': False}} and screen.viewers() == []


def inv_stop_never_forces_and_never_under_a_person(m, tmp):
    hermes, screen = rig(m, tmp)
    screen.take('vendas', 'basic:ana', '')
    before = len(hermes.calls)
    refused(m, 'screen_in_use', screen.stop, 'vendas', 'basic:bia')
    assert 'display.stop' not in [c[1] for c in hermes.calls[before:]] and hermes.snapshot['running'] is True
    screen.give_back('vendas', 'basic:ana')
    assert screen.stop('vendas', 'basic:ana')['running'] is False
    assert all(not c[2].get('force') for c in hermes.calls if c[1] == 'display.stop')


def inv_a_return_lost_to_a_takeover_is_refused_and_denied(m, tmp):
    """Someone takes over between our check and the release: Hermes ignores the release and keeps THEIR lease. That is no return:
    409 screen_not_yours, audited as denied (never `screen.return ok`), our viewer forgotten, their control untouched."""
    hermes, screen = rig(m, tmp)
    screen.take('vendas', 'basic:ana', '')
    hermes.on_release = lambda params: hermes.lease.update(holder='human', viewer_id='bia-took-over', since=4.0, epoch=5)
    audit = sys.modules[m.__name__.rsplit('.', 1)[0] + '.audit'].AuditLog(tmp / 'audit.db')
    error = refused(m, 'screen_not_yours', audit.act, 'basic:ana', 'screen.return', 'vendas', {'kind': 'ui'},
                    lambda: screen.give_back('vendas', 'basic:ana'))
    assert error.status == 409 and hermes.lease['viewer_id'] == 'bia-took-over' and screen.viewers() == []
    conn = sqlite3.connect(tmp / 'audit.db')
    assert conn.execute("SELECT outcome, detail FROM audit_log WHERE action='screen.return' ORDER BY id").fetchall() == [
        ('ok', 'intent'), ('denied', 'result')]
    conn.close()
    hermes.on_release = None                                                              # the plain return still works
    screen.take('vendas', 'basic:ana', '')
    assert screen.give_back('vendas', 'basic:ana')['lease']['holder'] == 'agent'


class Audit:
    def __init__(self):
        self.rows = []

    def act(self, actor, action, target, origin, fn, *, bot=None, payload=None):
        self.rows.append((actor, action, target, origin['kind'], payload))
        return fn()


def inv_a_hand_back_by_hermes_is_audited(m, tmp):
    hermes, screen = rig(m, tmp)
    screen.take('vendas', 'basic:ana', '')
    audit = Audit()
    assert screen.reconcile(audit) == [] and audit.rows == []                             # still ours: nothing to say
    hermes.lease = {'holder': 'agent', 'viewer_id': None, 'since': 9.0, 'reason': '', 'epoch': 4}   # the window closed: Hermes released
    assert screen.reconcile(audit) == [('vendas', 'basic:ana')] and screen.viewers() == []
    assert audit.rows == [('system', 'screen.return', 'vendas', 'system', {'actor': 'basic:ana', 'reason': 'closed_by_hermes'})]


INVARIANTS = {n[4:]: f for n, f in globals().items() if n.startswith('inv_')}
MUTATIONS = [
    ('honest_refusals_and_never_install', 'start installs', "return await call('display.start', {'profile': bot})", "return await call('display.install', {'profile': bot})"),
    ('honest_refusals_and_never_install', 'missing packages are not reported', "        if not st.get('installed'):", '        if False:'),
    ('watch_never_takes_control', 'watch takes the lease', "        async def run(call):\n            return await call('display.observe', {'profile': bot})",
     "        async def run(call):\n            o = await call('display.observe', {'profile': bot})\n            await call('display.lease.acquire', {'profile': bot, 'viewer_id': o['viewer_id']})\n            return o"),
    ('take_is_one_connection_and_stored_first', 'the lease is taken before the viewer is stored', "            self._store(bot, actor, observed['viewer_id'])\n            try:\n                acquired = await call('display.lease.acquire', {'profile': bot, 'viewer_id': observed['viewer_id'], 'reason': note})",
     "            try:\n                acquired = await call('display.lease.acquire', {'profile': bot, 'viewer_id': observed['viewer_id'], 'reason': note})\n                self._store(bot, actor, observed['viewer_id'])"),
    ('take_is_one_connection_and_stored_first', 'a failed take keeps the viewer', "            except BaseException:\n                self._forget(bot, actor)\n                raise", "            except BaseException:\n                raise"),
    ('take_is_one_connection_and_stored_first', 'the viewer id reaches the browser', "        return {'ticket': observed['ticket'], 'path': '/api/display/ws', 'expires_in': TICKET_TTL,\n                'lease'",
     "        return {'ticket': observed['ticket'], 'path': '/api/display/ws', 'expires_in': TICKET_TTL, 'viewer_id': observed['viewer_id'],\n                'lease'"),
    ('return_only_your_own', 'return releases without checking who holds', "        if lease.get('holder') != 'human' or lease.get('viewer_hash') != viewer_hash(viewer_id):", '        if False:'),
    ('a_return_lost_to_a_takeover_is_refused_and_denied', 'the owner is not checked after the release',
     "        if after.get('holder') != 'agent':", '        if False:'),
    ('a_return_lost_to_a_takeover_is_refused_and_denied', 'a lost return is audited as an error, not denied',
     'class Refused(PluginError, ActionDenied):', 'class Refused(PluginError):'),
    ('stop_never_forces_and_never_under_a_person', 'stop forces', "return await call('display.stop', {'profile': bot})", "return await call('display.stop', {'profile': bot, 'force': True})"),
    ('stop_never_forces_and_never_under_a_person', 'stop does not look at the lease first', "        if (st.get('lease') or {}).get('holder') == 'human':", '        if False:'),
    ('a_hand_back_by_hermes_is_audited', 'Hermes\'s hand-back is forgotten without a row',
     "                audit.act('system', 'screen.return', row['bot'], {'kind': 'system'}, lambda r=row: self._forget(r['bot'], r['actor']),\n                          bot=row['bot'], payload={'actor': row['actor'], 'reason': 'closed_by_hermes'})",
     "                self._forget(row['bot'], row['actor'])"),
]


def load_variant(tmp_path_factory, old, new):
    pkg = tmp_path_factory.mktemp('screenvariant') / f'scv{next(_n)}'
    pkg.mkdir()
    for name in ('__init__.py', 'api_errors.py', 'audit.py', 'dbfile.py', 'hook_store.py', 'screen.py'):
        shutil.copy(SRC / name, pkg / name)
    text = (pkg / 'screen.py').read_text()
    assert text.count(old) == 1, old
    (pkg / 'screen.py').write_text(text.replace(old, new))
    sys.path.insert(0, str(pkg.parent))
    try:
        return importlib.import_module(f'{pkg.name}.screen')
    finally:
        sys.path.remove(str(pkg.parent))


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(tmp_path, name):
    INVARIANTS[name](real, tmp_path)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, tmp_path, invariant, label, old, new):
    variant = load_variant(tmp_path_factory, old, new)       # outside pytest.raises: a mutation that does not apply is an error
    with pytest.raises(AssertionError):
        INVARIANTS[invariant](variant, tmp_path)
