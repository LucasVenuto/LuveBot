"""Red team (Lume, 30/10) of `backend/hermes_boundary.py` (P1-1, contract v0.10 section 1), on its own, before anything uses it (P1-2..4).

What held (controls below): the worker-thread conversion through the real `run_in_threadpool` of starlette (an ordinary `HermesError`, no cause, no context, nothing of the hostile text),
a plain `sys.exit(3)` in a worker is `hermes_exited` since P1-8 (it propagated before), and 13 mutations of the module (prefix or substring names, no MRO, no `SystemExit` check, keeping the cause, logging the text, swallowing any
`SystemExit`, a key regex that lets a URL through, any write code, echoing the key of every refusal) are red in test_hermes_boundary.py.
FINDING (Baixa, a trap): `convert()` of an `async def` returns the coroutine UNAWAITED and so protects nothing: the `SystemExit` comes out when the caller awaits it. Nothing in the contract
asks for this, but "wrap this call" reads the same for a sync and an async function. Refuse it (TypeError) at wrap time. FIXED in P1-2: a plain test now."""
import asyncio
import importlib.util
import sys
import types
from pathlib import Path

import pytest

BOUNDARY = Path(__file__).resolve().parents[3] / 'backend' / 'hermes_boundary.py'
HOSTILE = 'https://user:SECRET@evil.invalid/x?token=abc'


class ConfigBackendUnavailable(SystemExit):
    pass


@pytest.fixture
def boundary(monkeypatch):
    package = types.ModuleType('lume_backend')
    package.__path__ = []
    client = types.ModuleType('lume_backend.hermes_client')

    class HermesError(Exception):
        def __init__(self, code):
            self.code = code
            super().__init__(code)
    client.HermesError = HermesError
    monkeypatch.setitem(sys.modules, 'lume_backend', package)
    monkeypatch.setitem(sys.modules, 'lume_backend.hermes_client', client)
    spec = importlib.util.spec_from_file_location('lume_backend.hermes_boundary', BOUNDARY)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, 'lume_backend.hermes_boundary', module)
    spec.loader.exec_module(module)
    return module


def test_control_the_worker_thread_conversion_leaves_nothing_of_the_original_and_a_plain_exit_is_hermes_exited(boundary):
    pytest.importorskip('starlette')

    def unavailable():
        raise ConfigBackendUnavailable(HOSTILE)

    def plain_exit():
        raise SystemExit(3)

    async def scenario():
        try:
            await boundary.run_in_threadpool(unavailable)
        except Exception as error:
            converted = (error.code, error.__cause__, error.__context__, HOSTILE in repr(error.args) or HOSTILE in str(error))
        try:
            await boundary.run_in_threadpool(plain_exit)
        except Exception as error:   # P1-8 (A-133 revised): a plain exit in a worker is an answer, not a mute dashboard; no code, no cause, no context
            return converted, (error.code, error.__cause__, error.__context__, '3' in repr(error.args))
    converted, plain = asyncio.run(scenario())
    assert converted == ('config_backend_unavailable', None, None, False) and plain == ('hermes_exited', None, None, False)


def test_control_convert_protects_a_sync_function(boundary):
    def unavailable():
        raise ConfigBackendUnavailable(HOSTILE)
    with pytest.raises(Exception) as got:
        boundary.convert(unavailable)()
    assert got.value.code == 'config_backend_unavailable'


def test_finding_convert_refuses_a_coroutine_function_instead_of_protecting_nothing(boundary):
    async def reads():
        raise ConfigBackendUnavailable(HOSTILE)
    with pytest.raises(TypeError):
        boundary.convert(reads)
