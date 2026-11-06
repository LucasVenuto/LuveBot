"""Red team (Lume, 30/10) of P1-2 (contract v0.10 section 1.2 applied): the five direct awaits are guarded and the scan finds nothing, but `detail_extras` has a SIXTH way to reach Hermes's config on the
event loop: its last line `'approval_timeout': approval_timeout(name)` is a SYNCHRONOUS call (backend/bot_controls.py `approval_timeout`: `_get_approval_timeout()`, `read_raw_config()`, `load_config()` inside
`_config_profile_scope`). The AST scan of test_redteam_config_boundary.py looks for Hermes ROUTE coroutines, not for a plain function that reads the config, and Brasa's test of `detail_extras` stands in for
`approval_timeout` with `lambda n: 300`. `detail_extras` is a CHILD of `asyncio.gather` in `_one` (every GET /bots/{bot}): the SystemExit of a config outage raised there is set on the Task and re-raised by
asyncio into the event loop: the dashboard stops (the exact failure P-1 exists to close). This runs the REAL `detail_extras` and the REAL `approval_timeout` (their text, taken out of the sources) with a Hermes
whose `read_raw_config` raises the outage.
FINDING F11 (Media, only with HERMES_CONFIG_BACKEND=remote), FIXED (p1-2b): the read goes through the boundary's `run_in_threadpool`; a plain test now."""
import asyncio
import contextlib
import logging
import re
import sys
import types
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
BOTS, CONTROLS = (BACKEND / 'bots.py').read_text(), (BACKEND / 'bot_controls.py').read_text()
BOUNDARY = BACKEND / 'hermes_boundary.py'


class ConfigBackendUnavailable(SystemExit):
    pass


class HermesError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def hermes(monkeypatch, raising):
    """A Hermes whose config reader raises the outage (or not), and the route coroutines `detail_extras` awaits."""
    def put(name, **attrs):
        module = types.ModuleType(name)
        for key, value in attrs.items():
            setattr(module, key, value)
        monkeypatch.setitem(sys.modules, name, module)
    for name in ('hermes_cli', 'hermes_cli.web_routers', 'tools'):
        put(name)

    def read_raw_config():
        if raising:
            raise ConfigBackendUnavailable('https://user:SECRET@evil.invalid/x')
        return {}

    async def soul(name):
        return {'content': 'soul'}

    async def toolsets(profile=None):
        return [{'name': 'terminal', 'enabled': True}]

    async def servers(profile=None):
        return {'servers': []}

    @contextlib.contextmanager
    def scope(bot):
        yield
    put('hermes_cli.config', load_config=lambda: {}, read_raw_config=read_raw_config)
    put('hermes_cli.web_server_profiles', _config_profile_scope=scope)
    put('hermes_cli.web_routers.mcp', list_mcp_servers=servers)
    put('hermes_cli.web_routers.profiles', get_profile_soul=soul)
    put('hermes_cli.web_routers.tools', get_toolsets=toolsets)
    put('tools.approval_context', _get_approval_timeout=lambda: 300)

    async def stand_in_pool(func, *args, **kwargs):   # starlette is not in the unit venv (the r24 rule): a worker thread, and an exception raised in it reaches the awaiting task as a future's
        return await asyncio.get_running_loop().run_in_executor(None, lambda: func(*args, **kwargs))
    put('starlette')
    put('starlette.concurrency', run_in_threadpool=stand_in_pool)


def real_detail_extras(approval_timeout_of):
    """The `detail_extras` of backend/bots.py as written, with the boundary's `guarded`, and `approval_timeout` as `approval_timeout_of` gives it."""
    import importlib.util
    spec = importlib.util.spec_from_file_location('lume_boundary_sync', BOUNDARY)
    boundary = importlib.util.module_from_spec(spec)
    package = types.ModuleType('lume_boundary_sync_pkg')
    package.__path__ = []
    client = types.ModuleType('lume_boundary_sync_pkg.hermes_client')
    client.HermesError = HermesError
    sys.modules.update({'lume_boundary_sync_pkg': package, 'lume_boundary_sync_pkg.hermes_client': client})
    boundary.__package__ = 'lume_boundary_sync_pkg'
    spec.loader.exec_module(boundary)
    body = re.search(r'async def detail_extras\(name\):.*?(?=\n\ndef _plain)', BOTS, re.S).group(0).replace('    from .bot_controls import approval_timeout\n', '')
    ns = {'guarded': boundary.guarded, 'run_in_threadpool': boundary.run_in_threadpool, 'CONVERTED': boundary.CONVERTED, 'HermesError': HermesError, 'approval_timeout': approval_timeout_of}
    exec(body, ns)
    return ns['detail_extras'], boundary


def real_approval_timeout():
    text = re.search(r'def approval_timeout\(bot\):.*?(?=\n\ndef set_approval_timeout)', CONTROLS, re.S).group(0)
    ns = {}
    exec(text, ns)
    return ns['approval_timeout']


def under_gather(detail_extras):
    """The way `_one` runs it: as a CHILD of gather (a Task of its own), on a loop that must survive."""
    async def one():
        return await asyncio.gather(detail_extras('vendas'))
    loop = asyncio.new_event_loop()
    try:
        return 'returned', loop.run_until_complete(one())
    except SystemExit as error:
        return 'LOOP STOPPED by a SystemExit', type(error).__name__
    except Exception as error:   # noqa: BLE001
        return 'ordinary error', getattr(error, 'code', type(error).__name__)
    finally:
        loop.close()


def test_control_with_a_healthy_config_the_real_pair_returns_the_detail(monkeypatch):
    hermes(monkeypatch, raising=False)
    detail_extras, _ = real_detail_extras(real_approval_timeout())
    kind, got = under_gather(detail_extras)
    assert kind == 'returned' and got[0]['approval_timeout']['seconds'] == 300 and got[0]['soul'] == 'soul'


def test_control_the_outage_in_a_guarded_route_is_an_ordinary_error(monkeypatch):
    """What P1-2 did close: a route coroutine that raises it."""
    hermes(monkeypatch, raising=False)

    async def reads_config(profile=None):
        raise ConfigBackendUnavailable('x')
    sys.modules['hermes_cli.web_routers.tools'].get_toolsets = reads_config
    detail_extras, _ = real_detail_extras(real_approval_timeout())
    assert under_gather(detail_extras) == ('ordinary error', 'config_backend_unavailable')


def test_finding_the_sync_approval_timeout_read_does_not_stop_the_loop(monkeypatch):
    hermes(monkeypatch, raising=True)
    detail_extras, _ = real_detail_extras(real_approval_timeout())
    assert under_gather(detail_extras) == ('ordinary error', 'config_backend_unavailable')


# ---- the log rate: three mutations of it SURVIVED the tests of P1-2 (a limit with no test) ---------------------------------------------------------
API = (BACKEND.parent / 'dashboard' / 'plugin_api.py').read_text()


def test_the_boundary_writes_one_line_per_class_per_minute(caplog, monkeypatch):
    _, boundary = real_detail_extras(lambda name: None)
    now = [1000.0]
    monkeypatch.setattr(boundary, 'time', types.SimpleNamespace(monotonic=lambda: now[0]))

    class AnotherUnavailable(ConfigBackendUnavailable):
        pass

    def out(kind):
        def raise_it():
            raise kind('x')
        return boundary.convert(raise_it)
    caplog.set_level('WARNING', logger='luvebot.boundary')
    for _ in range(200):
        with pytest.raises(HermesError):
            out(ConfigBackendUnavailable)()
    assert len(caplog.records) == 1                                    # 200 failed requests, one line
    with pytest.raises(HermesError):
        out(AnotherUnavailable)()
    assert len(caplog.records) == 2                                    # another class has its own
    now[0] += boundary.LOG_EVERY_S + 1
    with pytest.raises(HermesError):
        out(ConfigBackendUnavailable)()
    assert len(caplog.records) == 3                                    # and a minute later the first speaks again
    assert all('SECRET' not in record.getMessage() and 'evil.invalid' not in record.getMessage() for record in caplog.records)


def test_the_watcher_writes_one_line_per_class_per_ten_minutes(caplog):
    text = re.search(r'def _note_outage\(error\):.*?(?=\n\n\ndef _background_tick)', API, re.S).group(0)
    every = float(re.search(r'_OUTAGE_EVERY_S = \{\}, ([0-9.]+)', API).group(1))
    now = [5000.0]
    ns = {'time': types.SimpleNamespace(monotonic=lambda: now[0]), 'logging': logging, '_OUTAGE_LOGGED': {}, '_OUTAGE_EVERY_S': every, 'hermes_boundary': real_detail_extras(lambda n: 300)[1]}
    exec(text, ns)
    caplog.set_level('WARNING', logger='luvebot.budget')
    for _ in range(100):
        ns['_note_outage'](ConfigBackendUnavailable('https://user:SECRET@evil.invalid/x'))
        now[0] += 30                                                   # a pass every 30 s for 50 minutes
    assert len(caplog.records) == 5 and all('SECRET' not in r.getMessage() for r in caplog.records)
