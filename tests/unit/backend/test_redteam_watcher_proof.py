"""Red team (Lume, 30/10) of what decides that a Hermes is PROVEN to serve (hermes_compat.pinned / SERVING_PROVEN) and of the lease that keeps ONE budget watcher per database.
The direction that hurts is the one where the watcher STOPS: `serving()` answers False only for a pinned build, and a False keeps the tick from opening the database (invariant 7).

F1, F2, F3 and F5 are FIXED (hermes_compat.pinned/describe/_identity, watcher_lease.enter/view): their tests are plain tests now, each with its control; the mutations that bring each defect
back are in test_proof_hardening.py. F4 (Info) is NOT fixed, by decision (hardening nobody has a source for): it stays `xfail(strict=True)`: it passes while the defect exists and turns red
the day it is fixed (then the mark is removed). Each has a plain control that proves the scenario is valid. Without the Hermes tree: pure functions, the real watcher_lease on a temporary SQLite file, and the tick/loop run from the source of plugin_api.py with stand-ins.

* F1 (Media) `pinned` trusts a PREFIX of whatever string the commit is, and `_identity()` throws the `dirty` flag away: a tree with local changes at the proven commit, or a stamp with
  junk after the hash, is "the proven build".
* F2 (Baixa) the same prefix test decides `compatible` in `describe()`: a commit string LuveBot itself refuses to show (`commit: null`) still reads `compatible` (invariant 9).
* F3 (Baixa) a lease row with a beat in the FUTURE (clock stepped back, database moved from a machine ahead) keeps every other process out until the clock catches up.
* F4 (Info) the watcher thread dies for good on anything that is not an `Exception`, and nothing starts it again.
"""
import importlib
import importlib.util
import re
import sqlite3
import sys
import threading
import time
import types
from pathlib import Path

import pytest

import backend.hermes_compat as compat
from backend import watcher_lease

ROOT = Path(__file__).resolve().parents[3]
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
FULL = 'bf0203a794a07aac3ff764972ab9087baa4e4f4e'   # Hermes v0.22.5, the build the harness proved (tests/harness/evidence/serving-bf0203a7.txt)
OTHER_FULL = 'bf0203a7' + '1' * 32                    # another build that shares the first 8 hex


@pytest.fixture
def proven(monkeypatch):
    monkeypatch.setattr(compat, 'SERVING_PROVEN', (FULL,))
    return compat.pinned


# ---- F1: what counts as the proven build ----------------------------------------------------------------------------------------------------------
def test_control_pinned_means_the_full_commit_of_a_proven_build(proven):
    assert proven({'commit': FULL}) is True
    for identity in ({'commit': OTHER_FULL}, {'commit': FULL.upper()}, {'commit': FULL[:8]}, {'commit': None}, {'commit': 7}, {}, None):
        assert proven(identity) is False, identity


@pytest.mark.parametrize('commit', [FULL + ' modified locally', FULL + '0', FULL + '\n', FULL + '-dirty'])
def test_finding_a_commit_that_only_starts_like_the_proven_one_is_not_proven(proven, commit):
    assert proven({'commit': commit}) is False


def test_finding_a_dirty_build_is_not_the_proven_one(proven):
    assert proven({'commit': FULL, 'dirty': True}) is False


def fake_version_info(monkeypatch, **fields):
    info = types.SimpleNamespace(base_version='0.22.5', display_version='0.22.5', commit=FULL, distance=0, dirty=False, source='git')
    for key, value in fields.items():
        setattr(info, key, value)
    module = types.ModuleType('hermes_cli.version_info')
    module.get_version_info = lambda: info
    monkeypatch.setitem(sys.modules, 'hermes_cli', types.ModuleType('hermes_cli'))
    monkeypatch.setitem(sys.modules, 'hermes_cli.version_info', module)


def test_control_identity_is_read_from_get_version_info(monkeypatch):
    fake_version_info(monkeypatch)
    identity = compat._identity()
    assert identity['commit'] == FULL and identity['version'] == '0.22.5' and identity['distance'] == 0


def test_finding_the_identity_keeps_whether_the_tree_is_dirty(monkeypatch):
    fake_version_info(monkeypatch, dirty=True)
    assert compat._identity().get('dirty') is True


def test_every_proven_build_is_a_full_sha():
    """GATE (plain, not a finding): vacuous while SERVING_PROVEN is empty, red the day an entry shorter than 40 hex goes in. A 8-hex entry makes `startswith` accept ANY commit that shares
    those 8 characters (32 bits: a fork, a hand-written stamp), and the evidence file the entry must have already holds the full hash."""
    bad = [entry for entry in compat.SERVING_PROVEN if not re.fullmatch(r'[0-9a-f]{40}', entry)]
    assert bad == [], f'SERVING_PROVEN entries that are not a full commit: {bad}'


# ---- F2: the banner uses the same prefix ----------------------------------------------------------------------------------------------------------
BASE = {'version': '0.22.2', 'display_version': '0.22.2', 'distance': 0}


def test_control_a_tested_commit_is_compatible_and_shown():
    got, problem = compat.describe({**BASE, 'commit': compat.TESTED_COMMITS[0]}, 'in_process', False)
    assert (got['compat'], got['commit'], problem) == ('compatible', compat.TESTED_COMMITS[0], None)


def test_finding_an_unreadable_commit_is_never_compatible():
    got, _ = compat.describe({**BASE, 'commit': compat.BASELINE + ' whatever it is'}, 'in_process', False)
    assert not (got['commit'] is None and got['compat'] == 'compatible')


# ---- F5: the MAIN branch of describe() does not look at the commit -----------------------------------------------------------------------------------
@pytest.fixture
def every_break_handled(monkeypatch):
    monkeypatch.setattr(compat, 'HANDLED', frozenset(compat.AUTHORITY_BREAKS + compat.PLG3_BREAKS))   # the day the harness proof of every break is in


MAIN = {'version': '0.22.4', 'display_version': '0.22.4+7', 'distance': 7}                    # an unreleased main build that has the session authority and not PLG-3


def test_control_a_readable_main_build_is_compatible_once_every_break_is_handled(every_break_handled):
    got, problem = compat.describe({**MAIN, 'commit': 'a' * 40}, 'in_process', True, False)
    assert (got['compat'], got['commit'], problem) == ('compatible', 'a' * 40, None)


@pytest.mark.parametrize('commit', ['not a commit', None, 'A' * 40, 'a' * 65])
def test_finding_a_main_build_with_an_unreadable_commit_is_never_compatible(every_break_handled, commit):
    got, _ = compat.describe({**MAIN, 'commit': commit}, 'in_process', True, False)
    assert not (got['commit'] is None and got['compat'] == 'compatible')


def test_finding_a_dirty_build_is_not_certified_by_the_banner():
    got, _ = compat.describe({**BASE, 'commit': compat.TESTED_COMMITS[0], 'dirty': True}, 'in_process', False)
    assert got['compat'] != 'compatible'


# ---- F3: the lease and a beat from the future -----------------------------------------------------------------------------------------------------
def make_db(tmp_path):
    path = tmp_path / 'luvebot.db'
    sqlite3.connect(path).close()
    path.chmod(0o600)
    return path


def put_row(path, *, owner='someone-else', kind='dashboard', beat_offset=0):
    watcher_lease.Lease(path, owner='setup').enter()          # creates the table and a row
    conn = sqlite3.connect(path)
    conn.execute(f"UPDATE watcher_lease SET owner=?, kind=?, beat=CAST(strftime('%s','now') AS INTEGER) + ?", (owner, kind, beat_offset))
    conn.commit()
    conn.close()


@pytest.mark.parametrize('offset,runs', [(-10, False), (-watcher_lease.EXPIRES_S - 5, True)])
def test_control_a_fresh_beat_keeps_the_other_out_and_a_stale_one_does_not(tmp_path, offset, runs):
    path = make_db(tmp_path)
    put_row(path, beat_offset=offset)
    assert watcher_lease.Lease(path, kind='dashboard', owner='me').enter() is runs


@pytest.mark.parametrize('ahead', [600, 3600, 86400])
def test_finding_a_beat_from_the_future_does_not_lock_the_other_process_out(tmp_path, ahead):
    path = make_db(tmp_path)
    put_row(path, beat_offset=ahead)
    assert watcher_lease.Lease(path, kind='dashboard', owner='me').enter() is True


# ---- F4: the watcher thread -----------------------------------------------------------------------------------------------------------------------
def loop_of(source, monkeypatch, outcomes):
    """`_background_loop` (and the tick it calls) from the source of plugin_api.py, with a `_watch_pass` that does what `outcomes` says, in order; -> (thread, passes)."""
    text = re.search(r'def _background_tick\(\):.*?(?=\n\n\ndef _start_background)', source, re.S).group(0)
    fake = types.ModuleType('hermes_cli.web_server_profiles')
    fake.get_process_hermes_home = lambda: Path('/nonexistent-luvebot-home')
    monkeypatch.setitem(sys.modules, 'hermes_cli', types.ModuleType('hermes_cli'))
    monkeypatch.setitem(sys.modules, 'hermes_cli.web_server_profiles', fake)
    passes, queue = [], list(outcomes)

    def watch_pass():
        passes.append(1)
        what = queue.pop(0) if queue else None
        if what is not None:
            raise what

    ns = {'hermes_compat': types.SimpleNamespace(read=lambda: (None, 'in_process'), read_app=lambda: None, serving=lambda *_: (None, 'hermes_not_pinned')),
          '_watch_pass': watch_pass, '_lease_for': lambda path: None, 'logging': __import__('logging'), '_SERVED': [False], '_WATCH_EVERY': 0.01, 'time': time,
          'watcher_lease': types.SimpleNamespace(kind_of=lambda *a, **k: None), 'hermes_boundary': types.SimpleNamespace(is_config_unavailable=lambda e: False), '_note_outage': lambda e: None}
    exec(text, ns)
    thread = threading.Thread(target=ns['_background_loop'], daemon=True)
    thread.start()
    thread.join(0.5)
    return thread, passes


def test_control_an_ordinary_failure_of_a_pass_never_stops_the_watcher(monkeypatch):
    thread, passes = loop_of(API, monkeypatch, [RuntimeError('boom'), ValueError('again')])
    assert thread.is_alive() and len(passes) > 3      # it kept passing after both


@pytest.mark.filterwarnings('ignore::pytest.PytestUnhandledThreadExceptionWarning')   # the dying thread is the point
@pytest.mark.parametrize('what', [SystemExit(1), pytest.param(__import__('asyncio').CancelledError(), marks=pytest.mark.xfail(
    strict=True, reason='F4 (Info), now only for a CancelledError: P1-8 (contract v0.10 1.2 item 4) makes ANY SystemExit a failed pass, and leaves every other BaseException raised on purpose (it ends '
                        '`_background_loop` for good, and `_start_background` runs once, at import: no watcher until the process restarts, the Budget then fails closed on its own after watcher_max_age). '
                        'No Hermes helper the pass calls raises one today: hardening.'))])
def test_finding_the_watcher_thread_survives_anything_a_pass_throws(monkeypatch, what):
    thread, passes = loop_of(API, monkeypatch, [what])
    assert thread.is_alive() and len(passes) > 3
