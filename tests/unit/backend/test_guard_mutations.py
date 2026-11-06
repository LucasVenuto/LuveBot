"""Mutation tests of the two STATIC guards that keep the config boundary honest: `sync_config_reads_in_coroutines` (test_config_boundary_applied.py, F11) and `thread_sites` / `target_ok`
(test_config_boundary_threads.py, P1-3). A guard that is never proven to fail is a decoration: each mutant below breaks one rule of the guard's own source and must turn one of the scenarios red
(the scenarios are the blind spots B1-B7 of the red team and their controls). The anchor must occur once, so a refactor that moves it is red here and not silently green."""
import ast
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_config_boundary_applied as applied  # noqa: E402
import test_config_boundary_threads as threads  # noqa: E402
import test_redteam_config_threads as redteam  # noqa: E402

HERE = Path(__file__).resolve().parent
GUARD = (HERE / 'test_config_boundary_applied.py').read_text()
GUARD = 'PRIMITIVES = {' + GUARD.split('PRIMITIVES = {', 1)[1].split('def static_checks(files):', 1)[0]
SCAN = (HERE / 'test_config_boundary_threads.py').read_text()
SCAN = 'ALLOWED_TARGETS = {' + SCAN.split('ALLOWED_TARGETS = {', 1)[1].split('def files(edits=()):', 1)[0]

LOAD = "from hermes_cli.config import load_config\n"
READ = LOAD + "def reader():\n    return load_config()\n"


def build(source, anchor, new, **namespace):
    assert anchor is None or source.count(anchor) == 1, anchor
    ns = dict(namespace)
    exec(source if anchor is None else source.replace(anchor, new), ns)
    return ns


def guard(anchor=None, new=None):
    return build(GUARD, anchor, new, ast=ast, Path=Path, parsed=applied.parsed)


def scan(anchor=None, new=None):
    return build(SCAN, anchor, new, ast=ast)


def flagged(ns, **files):
    return ns['sync_config_reads_in_coroutines']({f'backend/{name}.py': text for name, text in files.items()})


def guard_checks(ns):
    assert [call for _r, _l, call in flagged(ns, a=READ + "async def route():\n    return reader()\n")] == ['reader']                                   # control
    assert flagged(ns, a=LOAD + "async def route():\n    return load_config()\n") != []                                                          # B1
    assert flagged(ns, a=READ + "def mid():\n    return reader()\nasync def route():\n    return mid()\n") != []                                  # B2, one level
    assert flagged(ns, a=READ + "def m1():\n    return reader()\ndef m2():\n    return m1()\ndef m3():\n    return m2()\nasync def route():\n    return m3()\n") != []   # three levels
    files = {'backend/live_state.py': "def read(path, bot):\n" + "    " + LOAD + "    return load_config()\n",
             'dashboard/plugin_api.py': "from luvebot_backend import live_state\nasync def route(path, bot):\n    return live_state.read(path, bot)\n"}
    assert ns['sync_config_reads_in_coroutines'](files) != []                                                                                  # B3
    files = {'backend/bot_controls.py': "def approval_timeout(bot):\n" + "    " + LOAD + "    return load_config()\n",
             'backend/b.py': "from .bot_controls import approval_timeout\nasync def route(bot):\n    return approval_timeout(bot)\n"}
    assert ns['sync_config_reads_in_coroutines'](files) != []                                                                                  # imported by name
    files = {'backend/live_state.py': files['backend/bot_controls.py'].replace('approval_timeout', 'read'),
             'backend/upload.py': "def read(path):\n    return open(path).read()\n",
             'dashboard/plugin_api.py': "from luvebot_backend import upload\nasync def route(path):\n    return upload.read(path)\n"}
    assert ns['sync_config_reads_in_coroutines'](files) == []                                                                                  # same name, another module: not a reader
    for call in ('await run_in_threadpool(reader)', 'await guarded(reader())', 'convert(reader)()', 'asyncio.run(reader())', '(lambda: reader())'):
        assert flagged(ns, a=READ + f"async def route():\n    return {call}\n") == [], call                                                    # wrapped
    assert flagged(ns, a=READ + "def sync():\n    return reader()\n") == []                                                                       # a sync function may read


def test_the_unmutated_guard_passes_its_own_scenarios():
    guard_checks(guard())


@pytest.mark.parametrize('label,anchor,new', [
    ('a primitive is not a read', "        if name in PRIMITIVES:\n            return ('hermes', name)\n", ''),
    ('no callers of readers', 'LEVELS = 3', 'LEVELS = 0'),
    ('one level only', 'LEVELS = 3', 'LEVELS = 1'),
    ('module calls are not resolved', 'return (owner.id, call.func.attr)', 'return None'),
    ('imports are not resolved', 'return imports.get(name) or (stem, name)', 'return (stem, name)'),
    ('by name only', 'or target in readers)', 'or target[1] in {n for _, n in readers})'),
    ('wrappers do not shield', "fn in wrappers or fn.endswith('run_in_threadpool')", 'False'),
    ('a lambda is walked', "if isinstance(child, ast.Lambda):\n                    continue", "if False:\n                    continue"),
    ('a sync function is a coroutine', "inside = True if isinstance(child, ast.AsyncFunctionDef) else False if isinstance(child, ast.FunctionDef) else in_async", 'inside = True'),
])
def test_each_guard_mutation_is_caught(label, anchor, new):
    ns = guard(anchor, new)
    with pytest.raises(AssertionError):
        guard_checks(ns)


RISKY = "def risky():\n" + "    " + LOAD + "    return load_config()\n"


def scan_checks(ns):
    def unguarded(**files):
        return [(rel, line) for rel, line, site in ns['thread_sites']({f'backend/{n}.py': t for n, t in files.items()}) if not ns['target_ok'](site)]
    assert unguarded(x=RISKY + "import threading\nthreading.Thread(target=risky).start()\n") != []                                                # control
    assert unguarded(x=RISKY + "from threading import Thread\nThread(target=risky).start()\n") != []                                               # B5
    assert unguarded(x=RISKY + "import threading as th\nth.Thread(target=risky).start()\n") != []                                                  # B5, module alias
    assert unguarded(x=RISKY + "from threading import Thread as T\nT(target=risky).start()\n") != []                                               # B5, class alias
    assert unguarded(x="def _run():\n    pass\nimport threading\nthreading.Thread(target=_run).start()\n") != []                                     # B6: a borrowed name
    assert unguarded(x=RISKY + "import asyncio\nasyncio.to_thread(risky)\n") != []                                                                 # B7
    assert unguarded(x=RISKY + "import asyncio\nasyncio.get_running_loop().run_in_executor(None, risky)\n") != []
    assert unguarded(x=RISKY + "import threading\nclass W(threading.Thread):\n    def run(self):\n        risky()\n") != []
    assert unguarded(x=RISKY + "import threading\nthreading.Timer(1.0, risky).start()\n") != []
    assert unguarded(x=RISKY + "import threading\nthreading.Thread(target=hermes_boundary.thread_target(risky)).start()\n") == []                   # the boundary's own wrapper
    sites = ns['thread_sites']({'backend/plan_quota.py': "import threading\nthreading.Thread(target=_run, args=(1,)).start()\n"})
    assert [ns['target_ok'](site) for _r, _l, site in sites] == [True]                                                                             # an allowed target, in ITS file


def test_the_unmutated_scan_passes_its_own_scenarios():
    scan_checks(scan())


@pytest.mark.parametrize('label,anchor,new', [
    ('module alias unseen', "modules |= {a.asname or a.name for a in node.names if a.name == 'threading'}", "modules |= {'threading'}"),
    ('from-import unseen', "classes.update({a.asname or a.name: a.name for a in node.names if a.name in OFF_LOOP})", 'pass'),
    ('class alias unseen', "classes.update({a.asname or a.name: a.name for a in node.names if a.name in OFF_LOOP})", "classes.update({a.name: a.name for a in node.names if a.name in OFF_LOOP})"),
    ('a name is allowed in any file', 'return (rel, target.id) in ALLOWED_TARGETS', "return target.id in {n for _, n in ALLOWED_TARGETS}"),
    ('subclass unseen', 'if isinstance(node, ast.ClassDef) and any(off_loop(base) for base in node.bases):', 'if False:'),
    ('to_thread unseen', "elif name == 'to_thread' and node.args:", 'elif False:'),
    ('run_in_executor unseen', "elif name == 'run_in_executor' and len(node.args) > 1:", 'elif False:'),
    ('Timer unseen', ", 'Timer': 'function'", ''),
])
def test_each_thread_scan_mutation_is_caught(label, anchor, new):
    ns = scan(anchor, new)
    with pytest.raises(AssertionError):
        scan_checks(ns)


def test_the_push_subject_mutation_without_the_conversion_is_caught(monkeypatch):
    """F15: `_push_subject` reads the config through `convert`, so the outage is the mailto default and never aborts the approval's push."""
    anchor = 'hermes_boundary.convert(load_config)()'
    assert redteam.API.count(anchor) == 1
    redteam.test_finding_the_push_subject_falls_back_during_the_outage_instead_of_aborting_the_approval(monkeypatch)
    monkeypatch.setattr(redteam, 'API', redteam.API.replace(anchor, 'load_config()'))
    with pytest.raises(BaseException):  # noqa: B017
        redteam.test_finding_the_push_subject_falls_back_during_the_outage_instead_of_aborting_the_approval(monkeypatch)
