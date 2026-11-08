"""Red team (Lume, 30/10) of the GUARD that p1-2b leaves behind: `sync_config_reads_in_coroutines` (test_config_boundary_applied.py), the static check that no coroutine reads Hermes's config on the
event loop (F11). Today's tree is clean: a name-based scan of mine, three levels of callers over the sync functions of the tree, finds nothing beyond `approval_timeout` (now in a thread). The guard is
what keeps it clean, and it had four blind spots, each a way for the NEXT such read to pass it (B1-B3 are closed and tested below; B4 is the written ceiling):
  B1 a Hermes config primitive CALLED directly in an `async def` (`load_config()` there): `readers` holds names of functions of the TREE that mention a primitive, and a primitive is not one;
  B2 a reader reached through ONE more function (a function that calls the reader, never naming a primitive itself): the guard has no second level (Brasa's one-off scan had three);
  B3 a reader whose name is in GENERIC (`read`, `run`, `write`, `feature`, `effect`, `provider`): `live_state.read` IS a config reader (live_state.py:200, `load_config()`), and a call to it on
     the loop is invisible, because the exclusion is by BARE NAME (it was meant for file and stream I/O);
  B4 the reader through an alias or a partial (`f = reader; f()`): by name only; no scan of this kind can follow it (a ceiling, not a defect: say it in the guard's docstring).
Controls: the guard flags a reader called straight on the loop, and does not flag the same call inside run_in_threadpool, guarded, convert, asyncio.run or a lambda."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_config_boundary_applied as guard  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]

READER = "from hermes_cli.config import load_config\ndef reader():\n    return load_config()\n"


def hits(**files):
    return guard.sync_config_reads_in_coroutines({f'backend/{name}.py': text for name, text in files.items()})


def test_control_a_reader_called_on_the_loop_is_flagged():
    assert [(rel, call) for rel, _line, call in hits(a=READER + "async def route():\n    return reader()\n")] == [('backend/a.py', 'reader')]


@pytest.mark.parametrize('call', ['await run_in_threadpool(reader)', 'await guarded(reader())', 'convert(reader)()', 'asyncio.run(reader())', '(lambda: reader())'])
def test_control_the_same_call_inside_a_wrapper_or_a_lambda_is_not_flagged(call):
    assert hits(a=READER + f"async def route():\n    return {call}\n") == []


def test_blind_spot_a_primitive_called_directly_in_a_coroutine():
    assert hits(a="from hermes_cli.config import load_config\nasync def route():\n    return load_config()\n") != []


def test_blind_spot_a_reader_reached_through_another_function():
    assert hits(a=READER + "def mid():\n    return reader()\nasync def route():\n    return mid()\n") != []


def test_blind_spot_a_generic_name_that_is_a_real_config_reader():
    files = {'backend/live_state.py': "def read(path, bot):\n    from hermes_cli.config import load_config\n    return load_config()\n",
             'dashboard/plugin_api.py': "from luvebot_backend import live_state\nasync def route(path, bot):\n    return live_state.read(path, bot)\n"}
    assert guard.sync_config_reads_in_coroutines(files) != []


def test_blind_spot_b3_is_real_today_in_the_tree_it_guards():
    """The reader B3 hides is not hypothetical: the real `live_state.read` names a primitive, and the real guard drops it by name."""
    text = (ROOT / 'backend' / 'live_state.py').read_text()
    assert 'load_config' in text.split('def read(', 1)[1].split('\ndef ', 1)[0]
    assert 'read' in guard.GENERIC and 'read' in guard.direct_config_readers({'backend/live_state.py': text})


def test_ceiling_a_reader_through_an_alias_is_not_followed_and_the_guard_says_so():
    """B4: no scan of this kind follows `f = reader; f()`. The ceiling is written in the guard (its comment and docstring), and this pins that it is a ceiling and not an accident."""
    assert hits(a=READER + "async def route():\n    f = reader\n    return f()\n") == []
    assert 'THE CEILING (B4)' in (ROOT / 'tests' / 'unit' / 'backend' / 'test_config_boundary_applied.py').read_text()
