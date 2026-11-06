"""Red team (Lume, 30/10) of P1-3 (contract v0.10 section 1.2 item 5: the THREADS that read Hermes). What held: `thread_target` ends one unit of work for the outage only (a real `sys.exit(3)` and a KeyError
propagate), the approvals watcher skips ONE poll and goes on, plan_quota's worker says `unreadable`, the stream reader tells the relay; the three test files that touch it pass (21 + 26 + 37).
Two things P1-3 leaves, both found by following what the converted outage SKIPS:
* F15 (Baixa): the BEST-EFFORT readers that sit INSIDE converted code. `_push_subject()` reads `load_config()` under `except Exception: pass` and falls back to a mailto: a SystemExit goes over that
  handler, up through `record_request`'s own `except Exception: pass` around `on_request` (approvals.py), out of `record_request` AFTER its INSERT committed, and is converted by the watcher's
  `convert(_follow)`. The approval is recorded and shown; its PUSH is not sent, and never will be (a replay finds the row: `inserted == [0]`, `on_request` is not called again). The person is not woken
  for exactly the approval that arrived during the outage. Convert at the SOURCE (`convert(load_config)()` inside the try, so the existing `except Exception` default works) and nothing else changes.
* the static scan of threads (`thread_sites`/`target_ok`) has blind spots for the NEXT thread: `from threading import Thread`, a target that only SHARES A NAME with one of the four allowed
  (`_run`, `reader`, `_watch`, `_background_loop` are bare names), and every other way off the loop (`asyncio.to_thread`, `run_in_executor`, a Thread subclass). Today's tree has none of them.
Closed in the same patch (F15 fixed at the source, the scan sees B5-B7); the tests below stay as the proof."""
import ast
import re
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_config_boundary_threads as scan  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
APPROVALS = (ROOT / 'backend' / 'approvals.py').read_text()


class ConfigBackendUnavailable(SystemExit):
    pass


def boundary():
    """The real backend/hermes_boundary.py, loaded alone (its HermesError comes from a stand-in module: the real one imports Hermes)."""
    import importlib.util
    package = types.ModuleType('lume_threads_pkg')
    package.__path__ = []
    client = types.ModuleType('lume_threads_pkg.hermes_client')

    class HermesError(Exception):
        def __init__(self, code):
            self.code = code
            super().__init__(code)
    client.HermesError = HermesError
    sys.modules.update({'lume_threads_pkg': package, 'lume_threads_pkg.hermes_client': client})
    spec = importlib.util.spec_from_file_location('lume_threads_pkg.hermes_boundary', ROOT / 'backend' / 'hermes_boundary.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def push_subject(monkeypatch, load_config):
    import backend.push as push
    text = re.search(r'def _push_subject\(\):.*?(?=\n\n\ndef _push\()', API, re.S).group(0)
    monkeypatch.setitem(sys.modules, 'hermes_cli', types.ModuleType('hermes_cli'))
    config = types.ModuleType('hermes_cli.config')
    config.load_config = load_config
    monkeypatch.setitem(sys.modules, 'hermes_cli.config', config)
    ns = {'hermes_boundary': boundary(), 'push': push, '_PUSH_SUBJECT_SETTING': ''}   # the real modules: `convert` is what a fix would use
    exec(text, ns)
    return ns['_push_subject']


def test_control_the_subject_is_the_public_url_or_none(monkeypatch):
    assert push_subject(monkeypatch, lambda: {'dashboard': {'public_url': 'https://luve.app'}})() == ('https://luve.app', 'public_url')
    assert push_subject(monkeypatch, lambda: {})() == (None, None)

    def broken():
        raise RuntimeError('config unreadable')
    assert push_subject(monkeypatch, broken)() == (None, None)                                      # an ordinary failure is no contact


def test_control_the_approval_is_recorded_and_audited_BEFORE_the_push_is_tried():
    """So the loss is only the push: the row is committed first, and `on_request` runs under a handler that only knows `Exception`."""
    tail = APPROVALS.split("AuditLog(path).act('system', 'approval.requested'", 1)[1].split('return dict(conn.execute', 1)[0]
    assert 'on_request(path, bot)' in tail and 'except Exception:\n                pass' in tail and 'inserted == [1]' in tail


def test_finding_the_push_subject_falls_back_during_the_outage_instead_of_aborting_the_approval(monkeypatch):
    def outage():
        raise ConfigBackendUnavailable('https://u:SECRET@cfg/x')
    assert push_subject(monkeypatch, outage)() == (None, None)                                       # no contact, and the approval's push is still tried


# ---- the static scan of threads: what it does not see ------------------------------------------------------------------------------------------
RISKY = "def risky():\n    from hermes_cli.config import load_config\n    return load_config()\n"


def unguarded(files):
    return [(rel, line) for rel, line, site in scan.thread_sites(files) if not scan.target_ok(site)]


def test_control_the_scan_flags_a_plain_thread_on_a_function_that_reads_the_config():
    assert [rel for rel, _line in unguarded({'backend/x.py': RISKY + "import threading\nthreading.Thread(target=risky).start()\n"})] == ['backend/x.py']


def test_blind_spot_a_thread_started_through_another_name():
    assert unguarded({'backend/x.py': RISKY + "from threading import Thread\nThread(target=risky).start()\n"}) != []


def test_blind_spot_an_unguarded_target_that_shares_a_name_with_an_allowed_one():
    assert unguarded({'backend/x.py': "def _run():\n    from hermes_cli.config import load_config\n    return load_config()\nimport threading\nthreading.Thread(target=_run).start()\n"}) != []


@pytest.mark.parametrize('line', ["asyncio.to_thread(risky)", "asyncio.get_running_loop().run_in_executor(None, risky)", "class W(threading.Thread):\n    def run(self):\n        risky()"])
def test_blind_spot_another_way_off_the_loop(line):
    assert scan.thread_sites({'backend/x.py': RISKY + "import asyncio, threading\n" + line + "\n"}) != []


def test_control_today_the_tree_has_no_other_way_off_the_loop():
    """So B7 is about the next change, not this one."""
    for rel in ['dashboard/plugin_api.py', *[f'backend/{p.name}' for p in sorted((ROOT / 'backend').glob('*.py'))]]:
        text = API if rel.startswith('dashboard') else (ROOT / rel).read_text()
        assert not re.search(r'\bto_thread\(|\brun_in_executor\(|class \w+\((?:threading\.)?Thread\)', text), rel
