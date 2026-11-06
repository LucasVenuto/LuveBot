"""Red team (Lume, 30/10) of the P-1 boundary (contract v0.10 section 1: `ConfigBackendUnavailable` is a `SystemExit`), BEFORE its code lands (P1-2 .. P1-4).

The premise the design leans on (1.2 item 2): "the `gather` and `wait_for` sites need nothing else if their children reach Hermes only through `run_in_threadpool`". It is false for a
Hermes ROUTE FUNCTION awaited directly: a coroutine that reads the config on the event loop, run as a child of `gather` (a Task), raises its `SystemExit` into `Task.__step`, which sets it
on the task AND re-raises it into the loop: the dashboard stops. The scan below finds every Hermes route coroutine (`from hermes_cli.web_routers... import X`) that LuveBot calls inside an
`async def`, outside `asyncio.run(...)` (its own loop in a worker thread), `run_in_threadpool(...)` and `guarded(...)` (the boundary's wrapper).

FINDING (Media, only with `HERMES_CONFIG_BACKEND=remote`), FIXED in P1-2 (the mark is off): five such calls were there: `dashboard/plugin_api.py:307` and `:1576` (`get_status`, which reads the config version), and
`backend/bots.py` `detail_extras` (`get_profile_soul`, `get_toolsets`, `list_mcp_servers`: the last two read the config), the child of `asyncio.gather(detail_extras(name), asking(), files())`
that builds EVERY `GET /bots/{bot}`. `xfail(strict=True)`: red the day the boundary guards them (then the mark goes). The scan has controls: it must find them today, and it must not flag a
wrapped call, a call in a thread, or a call that is not a Hermes route."""
import ast
import asyncio
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
TREES = [ROOT / 'dashboard' / 'plugin_api.py', *(p for p in sorted((ROOT / 'backend').glob('*.py')) if p.name != 'hermes_boundary.py')]   # the module that DEFINES `guarded` calls no Hermes route
WRAPPERS = {'asyncio.run', 'run_in_threadpool', 'guarded', 'hermes_boundary.guarded', 'boundary.guarded', 'convert', 'hermes_boundary.convert'}   # a call inside one of these is not ON the loop, or is guarded


def hermes_names(tree):
    return {a.asname or a.name for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and (n.module or '').startswith('hermes_cli.web_routers') for a in n.names}


def exposed(source):
    """-> [(line, name)] of Hermes route coroutines called inside an `async def`, not under one of WRAPPERS and not in a lambda (a lambda is handed to a thread)."""
    tree = ast.parse(source)
    names, found = hermes_names(tree), []

    def walk(node, in_async, wrapped):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.Lambda):
                continue
            inside = True if isinstance(child, ast.AsyncFunctionDef) else False if isinstance(child, ast.FunctionDef) else in_async
            shield = wrapped
            if isinstance(child, ast.Call):
                if ast.unparse(child.func) in WRAPPERS:
                    shield = True
                elif inside and not wrapped and isinstance(child.func, ast.Name) and child.func.id in names:
                    found.append((child.lineno, child.func.id))
            walk(child, inside, shield)
    walk(tree, False, False)
    return found


def whole_tree():
    return {path.relative_to(ROOT).as_posix(): hit for path in TREES if (hit := exposed(path.read_text()))}


# ---- the premise, in asyncio itself (a stand-in with the real shape: a SystemExit subclass) ----------------------------------------------------
class ConfigBackendUnavailable(SystemExit):
    pass


async def reads_config():
    raise ConfigBackendUnavailable(3)


def test_control_a_systemexit_in_a_gather_child_stops_the_loop_and_except_exception_does_not_see_it():
    async def route():
        try:
            return await asyncio.gather(reads_config())
        except Exception:                       # what every LuveBot reader says: it is not an Exception
            return 'degraded'
    loop = asyncio.new_event_loop()
    try:
        with pytest.raises(SystemExit):
            loop.run_until_complete(route())    # it comes OUT of the loop: this is the dashboard stopping
    finally:
        loop.close()


def test_control_a_guarded_child_turns_it_into_an_ordinary_error():
    class Unavailable(Exception):
        pass

    async def guarded(awaitable):
        try:
            return await awaitable
        except SystemExit as error:
            if any(c.__name__ == 'ConfigBackendUnavailable' for c in type(error).__mro__):
                raise Unavailable() from None
            raise

    async def route():
        return await asyncio.gather(guarded(reads_config()), asyncio.sleep(0), return_exceptions=True)
    got = asyncio.run(route())
    assert isinstance(got[0], Unavailable)      # an Exception that gather hands back: the loop keeps running


# ---- the scan ----------------------------------------------------------------------------------------------------------------------------------
SNIPPET = '''
from hermes_cli.web_routers.tools import get_toolsets
from hermes_cli.web_routers.status import get_status
async def child(name):
    return await get_toolsets(profile=name)
async def wrapped(name):
    a = await guarded(get_status(profile=name))
    b = await run_in_threadpool(lambda: get_toolsets(profile=name))
    return a, b
def in_a_thread(name):
    import asyncio
    return asyncio.run(get_toolsets(profile=name))
async def not_hermes(name):
    return await other(name)
'''


def test_control_the_scan_flags_the_bare_call_and_nothing_else():
    assert exposed(SNIPPET) == [(5, 'get_toolsets')]


def test_control_the_scan_sees_the_exposure_when_the_guards_are_taken_out_so_it_is_not_blind():
    """Today's text, and the text of the day after the fix with every `guarded(` removed: the same six sites, so this control stays green when the finding is fixed."""
    found = {}
    for path in TREES:
        hit = exposed(path.read_text().replace('guarded(', '('))
        if hit:
            found[path.relative_to(ROOT).as_posix()] = sorted(name for _, name in hit)
    assert found == {'dashboard/plugin_api.py': ['get_status', 'get_status'], 'backend/bots.py': ['get_profile_soul', 'get_toolsets', 'list_mcp_servers'], 'backend/bot_model.py': ['get_model_options']}   # M-1: the model picker's catalog is awaited on the loop, under `guarded`


def test_finding_no_hermes_route_coroutine_runs_on_the_loop_unguarded():
    assert whole_tree() == {}
