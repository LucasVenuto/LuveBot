"""Red team (Lume, 30/10), round 2, of the two static guards Brasa rebuilt after the first round (guarda-pontos-cegos-f15-threads): `sync_config_reads_in_coroutines` (a config read on the event loop, F11)
and `thread_sites`/`target_ok` (every function that leaves the loop). What held: B1-B3 and B5-B7 are fixed (88 tests of the five files pass), a read through `from . import x` or a bare import is followed,
a chain four functions deep is flagged, positional Thread/Timer targets and subclasses are seen, a target that is a call to `convert`/`thread_target` is accepted. What they still do not see:
  B8  a MODULE of the tree imported under an alias the guard cannot resolve: `from . import live_state as ls` and `import luvebot_backend.live_state as ls` (the tree's own style is `from . import x`);
  B9  `ThreadPoolExecutor.submit/map` (and `anyio.to_thread.run_sync`): a REAL site exists today, backend/live_state.py `_soul` (`pool.submit(asyncio.run, get_profile_soul(bot))`), invisible to the scan.
      It is safe (its caller runs in the boundary's pool, which converts the outage), but "the scan lists every way off the loop" is not true;
  B10 a reader five functions deep (LEVELS = 3 stops at four): resolution is by module and name now, so a fixpoint costs no false alarm;
  B11 ALLOWED_TARGETS is by (file, name): a SECOND function with the same name in the same file (`reader` is a closure inside `_relay`; plugin_api.py has many routes) passes unguarded.
Each is `xfail(strict=True)`: red the day the guard sees it. Controls first, so the scenarios are known to be valid."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_config_boundary_applied as config  # noqa: E402
import test_config_boundary_threads as threads  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
READ = "def read():\n    from hermes_cli.config import load_config\n    return load_config()\n"
CHAIN = "def l1():\n    return reader()\ndef l2():\n    return l1()\ndef l3():\n    return l2()\ndef l4():\n    return l3()\n"
READER = READ.replace('read', 'reader')


def flagged(files):
    return config.sync_config_reads_in_coroutines(files)


def test_control_a_reader_called_on_the_loop_and_one_through_a_plain_module_import_are_flagged():
    assert flagged({'backend/x.py': READER + "async def r():\n    return reader()\n"}) != []
    assert flagged({'backend/live_state.py': READ, 'backend/y.py': "from . import live_state\nasync def r():\n    return live_state.read()\n"}) != []


def test_control_a_chain_of_four_is_flagged_and_a_wrapped_call_is_not():
    assert flagged({'backend/x.py': READER + CHAIN + "async def r():\n    return l3()\n"}) != []
    assert flagged({'backend/x.py': READER + "async def r():\n    return await run_in_threadpool(reader)\n"}) == []


@pytest.mark.xfail(strict=True, reason='B8 `_imports` skips `from . import x` (node.module is None) and has no case for `import a.b as c`: a module of the tree under an alias is not resolved, so `ls.read()` is missed.')
@pytest.mark.parametrize('import_line', ['from . import live_state as ls', 'import luvebot_backend.live_state as ls'])
def test_blind_spot_a_module_of_the_tree_under_an_alias(import_line):
    assert flagged({'backend/live_state.py': READ, 'backend/y.py': f"{import_line}\nasync def r():\n    return ls.read()\n"}) != []


@pytest.mark.xfail(strict=True, reason='B10 LEVELS = 3: a reader hidden behind five functions is missed. The resolution is by (module, name) now, so a fixpoint (loop until nothing new) has no false-alarm cost.')
def test_blind_spot_a_reader_five_functions_deep():
    assert flagged({'backend/x.py': READER + CHAIN + "def l5():\n    return l4()\nasync def r():\n    return l5()\n"}) != []


@pytest.mark.xfail(strict=True, reason='B9 `thread_sites` knows Thread, Timer, to_thread and run_in_executor but not `ThreadPoolExecutor.submit/map` or `anyio.to_thread.run_sync`. A real submit() is in the tree today '
                                         '(backend/live_state.py `_soul`), safe only because its caller runs in the boundary pool.')
def test_blind_spot_an_executor_submit():
    text = (ROOT / 'backend' / 'live_state.py').read_text()
    assert '.submit(' in text                                                                                  # the site is real
    assert threads.thread_sites({'backend/live_state.py': text}) != []


def test_control_the_scan_sees_a_plain_thread_and_a_to_thread():
    risky = "def risky():\n    pass\n"
    assert threads.thread_sites({'backend/x.py': risky + "import threading\nthreading.Thread(target=risky).start()\n"}) != []
    assert threads.thread_sites({'backend/x.py': risky + "import asyncio\nasync def r():\n    await asyncio.to_thread(risky)\n"}) != []


@pytest.mark.xfail(strict=True, reason='B11 ALLOWED_TARGETS = (file, name): a second function called `reader` in plugin_api.py (a closure of another route) is accepted without any guard. Pin the ENCLOSING function '
                                         '(`_relay.reader`), or check the target\'s own body for the guard.')
def test_blind_spot_a_second_unguarded_function_with_an_allowed_name_in_the_same_file():
    text = ("import threading\ndef route_a():\n    def reader():\n        pass\n    threading.Thread(target=reader).start()\n"
            "def route_b():\n    def reader():\n        from hermes_cli.config import load_config\n        load_config()\n    threading.Thread(target=reader).start()\n")
    sites = threads.thread_sites({'dashboard/plugin_api.py': text})
    assert [line for _rel, line, site in sites if not threads.target_ok(site)] != []
