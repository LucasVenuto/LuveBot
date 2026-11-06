"""The hardening behind the red team of the proof that a Hermes "serves" and of the lease (docs/redteam/v02-vigia-prova-e-lease-2026-10-30.md, F1 to F3), with the mutations that bring each defect back.
The findings themselves are in test_redteam_watcher_proof.py (now plain tests); here are the edges the fix has to keep and one red mutation per line of the fix.

* F1: `pinned()` is EQUALITY with a full proven commit and `not dirty` (and `_identity()` reads `dirty`); an identity with no `dirty` key at all is still the proven build (the field is Hermes's: the
  real v0.22.5 always has it); a `dirty` that is anything truthy is not. The safe answer is "not pinned" (the watcher runs).
* F2: `describe()` calls a build `compatible` by its commit only when the commit is one LuveBot would SHOW (`_COMMIT`): an unreadable identity is `untested` (invariant 9).
* F3: a lease whose beat is in the FUTURE is not fresh (`0 <= age <= expires`), in `enter()` and in `/health`'s `view()`: the lease fails toward running."""
import importlib
import importlib.util
import itertools
from pathlib import Path
import sqlite3
import sys
import types

import pytest

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / 'backend'
FULL = 'bf0203a794a07aac3ff764972ab9087baa4e4f4e'
_n = itertools.count()


def load(*edits):
    """The backend package under a private name, with `edits` = (module, old, new) applied to a module's source (the anchor must occur exactly once). -> {name: module}."""
    name = f'ph_backend_{next(_n)}'
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
    return {m: importlib.import_module(f'{name}.{m}') for m in ('hermes_compat', 'watcher_lease')}


# ---- F1 ---------------------------------------------------------------------------------------------------------------------------------------------
def check_pinned(mods, monkeypatch):
    compat = mods['hermes_compat']
    monkeypatch.setattr(compat, 'SERVING_PROVEN', (FULL,))
    assert compat.pinned({'commit': FULL}) is True
    assert compat.pinned({'commit': FULL, 'dirty': False}) is True                       # a clean tree, as the real v0.22.5 reports it
    for commit in (FULL + ' x', FULL + '\n', FULL + '0', FULL[:-1], FULL[:8], 'bf0203a7' + '1' * 32, FULL.upper(), ' ' + FULL, None, 7):
        assert compat.pinned({'commit': commit}) is False, commit
    for dirty in (True, 1, 'yes'):
        assert compat.pinned({'commit': FULL, 'dirty': dirty}) is False, dirty
    assert compat.pinned(None) is False and compat.pinned({}) is False
    monkeypatch.setattr(compat, 'SERVING_PROVEN', ())
    assert compat.pinned({'commit': FULL}) is False                                      # nothing proven: nothing is pinned


def check_identity_reads_dirty(mods, monkeypatch):
    compat = mods['hermes_compat']
    for dirty, want in ((True, True), (False, False)):
        info = types.SimpleNamespace(base_version='0.22.5', display_version='0.22.5', commit=FULL, distance=0, dirty=dirty)
        module = types.ModuleType('hermes_cli.version_info')
        module.get_version_info = lambda info=info: info
        monkeypatch.setitem(sys.modules, 'hermes_cli', types.ModuleType('hermes_cli'))
        monkeypatch.setitem(sys.modules, 'hermes_cli.version_info', module)
        assert compat._identity().get('dirty') is want
    del info.dirty                                                                       # a Hermes that has no such field: the key is there, and False (never a crash)
    assert compat._identity().get('dirty') is False


def check_serving_follows_pinned(mods, monkeypatch):
    """The end of the chain: a dirty or look-alike build is never answered `False` (the watcher runs); the proven clean one with no lifespan is."""
    compat = mods['hermes_compat']
    monkeypatch.setattr(compat, 'SERVING_PROVEN', (FULL,))
    app = types.SimpleNamespace(state=types.SimpleNamespace(), routes=[])                # no `event_lock`: no lifespan ran
    assert compat.serving({'commit': FULL, 'dirty': False}, app) == (False, 'no_lifespan')
    assert compat.serving({'commit': FULL, 'dirty': True}, app) == (None, 'hermes_not_pinned')
    assert compat.serving({'commit': FULL + ' x'}, app) == (None, 'hermes_not_pinned')


# ---- F2 ---------------------------------------------------------------------------------------------------------------------------------------------
BASE = {'version': '0.22.2', 'display_version': '0.22.2', 'distance': 0}


def check_describe(mods, monkeypatch):
    compat = mods['hermes_compat']
    tested = compat.TESTED_COMMITS[0]
    got, problem = compat.describe({**BASE, 'commit': tested}, 'in_process', False)                        # the FULL tested commit, by equality (A-194)
    assert (got['compat'], got['commit'], problem) == ('compatible', tested, None), tested
    for commit in (compat.BASELINE + '0' * 32, tested[:8], tested[:-1] + ('0' if tested[-1] != '0' else '1')):   # one that only STARTS alike, a short one, one that differs in the last digit
        assert compat.describe({**BASE, 'commit': commit}, 'in_process', False)[0]['compat'] == 'untested', commit
    for commit in (tested + ' whatever it is', tested + '\n', tested.upper(), tested + 'zz', 'x' + tested):   # LuveBot would not show these: an unreadable identity
        got, problem = compat.describe({**BASE, 'commit': commit}, 'in_process', False)
        assert got['commit'] is None and got['compat'] == 'untested', (commit, got['compat'], got['commit'])
    got, _ = compat.describe({**BASE, 'commit': tested, 'dirty': False}, 'in_process', False)
    assert got['compat'] == 'compatible', 'a clean tested build stays compatible'
    for dirty in (True, 1, 'yes'):                                                       # local changes at the tested commit: the code the suite did not run (F5)
        got, _ = compat.describe({**BASE, 'commit': tested, 'dirty': dirty}, 'in_process', False)
        assert got['compat'] == 'untested' and got['commit'] == tested, (dirty, got['compat'])
    # the MAIN channel (distance > 0, every break handled): the same two conditions (F5)
    monkeypatch.setattr(compat, 'HANDLED', frozenset(compat.AUTHORITY_BREAKS + compat.PLG3_BREAKS))
    main = {'version': '0.22.4', 'display_version': '0.22.4+7', 'distance': 7}
    got, _ = compat.describe({**main, 'commit': 'a' * 40}, 'in_process', True, False)
    assert got['compat'] == 'compatible' and got['commit'] == 'a' * 40, 'a readable, clean main build is compatible once its breaks are proved'
    got, _ = compat.describe({**main, 'commit': 'a' * 40, 'dirty': False}, 'in_process', True, False)
    assert got['compat'] == 'compatible'
    for commit in ('not a commit', None, 'A' * 40, 'a' * 65, 7):                           # LuveBot would not show these: untested, never compatible
        got, _ = compat.describe({**main, 'commit': commit}, 'in_process', True, False)
        assert got['commit'] is None and got['compat'] == 'untested', (commit, got['compat'])
    for dirty in (True, 1):
        got, _ = compat.describe({**main, 'commit': 'a' * 40, 'dirty': dirty}, 'in_process', True, False)
        assert got['compat'] == 'untested', ('a dirty main build is not certified', dirty, got['compat'])


# ---- F3 ---------------------------------------------------------------------------------------------------------------------------------------------
def put_row(path, beat_offset):
    conn = sqlite3.connect(path)
    conn.execute("UPDATE watcher_lease SET owner='someone-else', kind='dashboard', beat=CAST(strftime('%s','now') AS INTEGER) + ?", (beat_offset,))
    conn.commit()
    conn.close()


def database(tmp_path, mods):
    path = tmp_path / 'luvebot.db'
    sqlite3.connect(path).close()
    path.chmod(0o600)
    mods['watcher_lease'].Lease(path, owner='setup').enter()                             # the table and a row
    return path


def check_lease_enter(mods, tmp_path):
    lease = mods['watcher_lease']
    for offset, runs in ((0, False), (-10, False), (-lease.EXPIRES_S + 3, False), (-lease.EXPIRES_S - 5, True), (1, True), (30, True), (600, True), (86400, True)):
        path = database(tmp_path / f'o{offset}', mods) if (tmp_path / f'o{offset}').mkdir() is None else None
        put_row(path, offset)
        assert lease.Lease(path, kind='dashboard', owner='me').enter() is runs, offset
        conn = sqlite3.connect(path)
        owner = conn.execute('SELECT owner FROM watcher_lease').fetchone()[0]
        conn.close()
        assert owner == ('me' if runs else 'someone-else'), (offset, owner)           # a future beat is TAKEN over, a fresh one is respected


def check_lease_view(mods, tmp_path):
    lease = mods['watcher_lease']
    for offset, held in ((-10, False), (0, False), (-lease.EXPIRES_S - 5, None), (1, None), (600, None)):
        folder = tmp_path / f'v{offset}'
        folder.mkdir()
        path = database(folder, mods)
        put_row(path, offset)
        got = lease.view(path, owner='me')
        assert got['held'] is held, (offset, got)
        assert (got['owner_kind'] == 'dashboard') is (held is not None), (offset, got)
    folder = tmp_path / 'mine'
    folder.mkdir()
    path = database(folder, mods)
    put_row(path, 0)
    conn = sqlite3.connect(path)
    conn.execute("UPDATE watcher_lease SET owner='me'")
    conn.commit()
    conn.close()
    assert lease.view(path, owner='me')['held'] is True


def test_pinned_is_equality_with_a_full_proven_commit_and_a_clean_tree(monkeypatch):
    check_pinned(load(), monkeypatch)


def test_the_identity_reads_dirty(monkeypatch):
    check_identity_reads_dirty(load(), monkeypatch)


def test_a_dirty_or_look_alike_build_is_never_told_it_does_not_serve(monkeypatch):
    check_serving_follows_pinned(load(), monkeypatch)


def test_a_commit_luvebot_would_not_show_or_a_dirty_tree_is_never_compatible(monkeypatch):
    check_describe(load(), monkeypatch)


def test_a_beat_from_the_future_is_taken_over_and_a_fresh_one_is_respected(tmp_path):
    check_lease_enter(load(), tmp_path)


def test_health_does_not_report_a_future_beat_as_held(tmp_path):
    check_lease_view(load(), tmp_path)


# ---- mutations: one line of the fix changed -> red -------------------------------------------------------------------------------------------------
COMPAT_PIN = 'identity["commit"] in SERVING_PROVEN and not identity.get("dirty"))'
MUTATIONS = {
    'pinned compares a prefix': ([('hermes_compat', COMPAT_PIN, 'identity["commit"].startswith(SERVING_PROVEN) and not identity.get("dirty"))')], check_pinned),
    'pinned ignores dirty': ([('hermes_compat', COMPAT_PIN, 'identity["commit"] in SERVING_PROVEN)')], check_pinned),
    'pinned ignores dirty (serving)': ([('hermes_compat', COMPAT_PIN, 'identity["commit"] in SERVING_PROVEN)')], check_serving_follows_pinned),
    'pinned prefix (serving)': ([('hermes_compat', COMPAT_PIN, 'identity["commit"].startswith(SERVING_PROVEN) and not identity.get("dirty"))')], check_serving_follows_pinned),
    'the identity drops dirty': ([('hermes_compat', ', "dirty": bool(getattr(info, "dirty", False))}', '}')], check_identity_reads_dirty),
    'the identity makes dirty always False': ([('hermes_compat', '"dirty": bool(getattr(info, "dirty", False))', '"dirty": False')], check_identity_reads_dirty),
    'compatible without the legibility test': ([('hermes_compat', 'and bool(_COMMIT.fullmatch(identity["commit"])) and not identity.get("dirty")', 'and not identity.get("dirty")')],
                                               check_describe),
    'compatible although the tree is dirty': ([('hermes_compat', 'and bool(_COMMIT.fullmatch(identity["commit"])) and not identity.get("dirty")', 'and bool(_COMMIT.fullmatch(identity["commit"]))')],
                                               check_describe),
    'a main build is compatible with no readable commit': ([('hermes_compat', '    elif (authority or plg3) and main and clean_commit:', '    elif (authority or plg3) and main:')], check_describe),
    'a tag is compatible with no clean commit': ([('hermes_compat', '    tested = clean_commit and identity["commit"] in TESTED_COMMITS', '    tested = bool(identity) and isinstance(identity.get("commit"), str) and identity["commit"] in TESTED_COMMITS')],
                                                  check_describe),
    'enter counts a future beat as fresh': ([('watcher_lease', 'if 0 <= age <= self.expires and not', 'if age <= self.expires and not')], check_lease_enter),
    'enter counts a stale beat as fresh': ([('watcher_lease', 'if 0 <= age <= self.expires and not', 'if 0 <= age and not')], check_lease_enter),
    'enter lets a beat of exactly now through': ([('watcher_lease', 'if 0 <= age <= self.expires and not', 'if 0 < age <= self.expires and not')], check_lease_enter),
    'view reports a future beat as held': ([('watcher_lease', 'not 0 <= row[2] <= expires', 'row[2] > expires')], check_lease_view),
    'view reports a stale beat as held': ([('watcher_lease', 'not 0 <= row[2] <= expires', 'row[2] < 0')], check_lease_view),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_mutation_turns_its_check_red(label, tmp_path, monkeypatch):
    edits, check = MUTATIONS[label]
    mods = load(*edits)
    arguments = {check_pinned: (monkeypatch,), check_identity_reads_dirty: (monkeypatch,), check_serving_follows_pinned: (monkeypatch,), check_describe: (monkeypatch,),
                 check_lease_enter: (tmp_path,), check_lease_view: (tmp_path,)}[check]
    with pytest.raises(AssertionError):
        check(mods, *arguments)
