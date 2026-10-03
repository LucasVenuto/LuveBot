"""b3 settling, without Hermes (a review stub showed a cancelled run counted as delivered): a deny
reason sent as a steer is DELIVERED only when the run COMPLETED (Hermes's turn finalizer ran) with nothing pending. A completed run
with the steer pending is not delivered. A failed, cancelled or interrupted run ends without the finalizer and without the field
(api_server_runs.py#L987-L996): unknown (None), never True. A run that has not ended stays accepted (None).
Mutation: settling on any end (the first version) -> a cancelled run reads as delivered: red.
"""
import importlib
import importlib.util
import itertools
from pathlib import Path
import sys
import types

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
ABSENT = object()
_n = itertools.count()


def load(edit=None):
    """The real backend under its own package name, with the two Hermes-facing modules stubbed (they import Hermes)."""
    name = f'b3_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    api = types.ModuleType(f'{name}.hermes_api')
    api.ApiClient, api.safe_id = None, lambda value: value
    client = types.ModuleType(f'{name}.hermes_client')
    client.HermesError = type('HermesError', (Exception,), {})
    sys.modules[api.__name__], sys.modules[client.__name__] = api, client
    approvals = importlib.import_module(f'{name}.approvals')
    if edit:
        source = (BACKEND / 'approvals_native.py').read_text()
        assert source.count(edit[0]) == 1, edit[0]
        native_spec = importlib.util.spec_from_loader(f'{name}.approvals_native', loader=None)
        native = importlib.util.module_from_spec(native_spec)
        native.__package__ = name
        exec(compile(source.replace(*edit), str(BACKEND / 'approvals_native.py'), 'exec'), native.__dict__)
    else:
        native = importlib.import_module(f'{name}.approvals_native')
    return approvals, native


def run_ends(approvals, native, tmp_path, status, pending=ABSENT):
    db = tmp_path / f'{status}-{next(_n)}.db'
    conn = approvals.connect(db)
    conn.execute("INSERT INTO approvals (request_id, run_id, source, bot, surface, mechanism, command_redacted, description, pattern_keys,"
                 " allowed_choices, digest, action_class_hash, created_at, expires_at, status, decided_choice, reason, reason_steer)"
                 " VALUES ('req_x','run_1','run','vendas','run','hook_approve','chmod 600 x','d','[]','[]','g','h',1,2,'consumed','deny','r','accepted')")
    conn.commit()
    conn.close()

    class Client:
        def __init__(self, _bot):
            pass

        def call(self, method, path, body=None, **_kw):
            return 200, {'status': status, **({} if pending is ABSENT else {'pending_steer': pending})}
    native.ApiClient = Client
    native.settle_reasons(db, 'vendas', 'run_1')
    return approvals.view(approvals.get(db, 'req_x'))['reason_delivered']


def checks(approvals, native, tmp_path):
    assert run_ends(approvals, native, tmp_path, 'completed', None) is True                      # read by the model
    assert run_ends(approvals, native, tmp_path, 'completed') is True                            # finalizer ran, nothing left
    assert run_ends(approvals, native, tmp_path, 'completed', '[luvebot:deny] ...') is False     # handed back unread
    for ended in ('cancelled', 'failed', 'interrupted'):                                       # no finalizer, no field
        assert run_ends(approvals, native, tmp_path, ended) is None, ended
    assert run_ends(approvals, native, tmp_path, 'running') is None                              # not ended: still accepted


def test_delivered_only_for_a_completed_run_with_nothing_pending(tmp_path):
    checks(*load(), tmp_path)


def test_the_mutation_is_caught(tmp_path):
    mutant = load(("    if payload.get('status') != 'completed':\n        state = 'unknown'", "    if False:\n        state = 'unknown'"))
    with pytest.raises(AssertionError):
        checks(*mutant, tmp_path)
