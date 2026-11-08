"""b3, the convergence of a deny reason: a TRANSIENT failure of a read of Hermes's state database must not settle it for good.
Two reads decide whether the reason ever reads `delivered`: the WATERMARK (the session's last message id, read just before the steer is sent) and the PROOF (the transcript read once the
run ended). If the first raises, the reason has no watermark and can only ever be `unknown`; if the second raises, `unknown` is written and never looked at again (a settled reason is
not revisited). Both used to be one-shot: one bad moment of the database (a lock or an I/O error while the gateway writes or checkpoints it) turned a reason the model really read
into `unknown`: the intermittent red of `test_delivered_is_claimed_exactly_when_the_model_read_the_reason` (harness, about 1 run in 3, run `STEER:seen` but state `unknown`).
Now each read is tried READ_TRIES times when it RAISES (never when it answers, even with nothing: an empty answer is final, so a steer that was really lost costs no wait), and
what still fails after that is `unknown` / no watermark as before (never `delivered` without proof).
Mutations: no retry on the watermark; no retry on the proof; a single try; an empty answer tried again."""
import importlib
import importlib.util
import itertools
from pathlib import Path
import sys
import types

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()


def load(*edits):
    """The real backend under its own package name, `hermes_api`, `hermes_client` and `hermes_cron` stubbed (they import Hermes); `edits` are (old, new) on approvals_native."""
    name = f'tr_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    api = types.ModuleType(f'{name}.hermes_api')
    api.ApiClient, api.safe_id = None, lambda value: value
    client = types.ModuleType(f'{name}.hermes_client')
    client.HermesError = type('HermesError', (Exception,), {})
    cron = types.ModuleType(f'{name}.hermes_cron')
    for module in (api, client, cron):
        sys.modules[module.__name__] = module
    approvals = importlib.import_module(f'{name}.approvals')
    if edits:
        source = (BACKEND / 'approvals_native.py').read_text()
        for old, new in edits:
            assert source.count(old) == 1, old
            source = source.replace(old, new)
        native = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.approvals_native', loader=None))
        native.__package__ = name
        sys.modules[native.__name__] = native
        exec(compile(source, str(BACKEND / 'approvals_native.py'), 'exec'), native.__dict__)
    else:
        native = importlib.import_module(f'{name}.approvals_native')
    native.time = types.SimpleNamespace(sleep=lambda _s: None, monotonic=native.time.monotonic)   # no real wait between tries
    return approvals, native, cron


class Flaky:
    """Fails `failures` times with `error`, then answers `answer`; counts the calls."""

    def __init__(self, failures, answer, error=OSError('database is locked')):
        self.failures, self.answer, self.error, self.calls = failures, answer, error, 0

    def __call__(self, *_args, **_kw):
        self.calls += 1
        if self.calls <= self.failures:
            raise self.error
        return self.answer


class Rows:
    def __init__(self, rows):
        self.rows = rows

    def get_messages(self, session_id, after_id=None, latest=False, limit=None):
        return self.rows[-limit:] if latest and limit else list(self.rows)

    def close(self):
        pass


def watermark_case(edits, failures, *, session_ok=True):
    """-> (result, how many times the session database was opened)."""
    approvals, native, cron = load(*edits)
    opened = Flaky(failures, Rows([{'id': 7}]))
    cron._session_db = opened

    class Client:
        def __init__(self, _bot):
            pass

        def call(self, method, path, body=None, **_kw):
            return (200, {'session_id': 'sess_1'}) if session_ok else (502, None)
    native.ApiClient = Client
    try:
        return native.steer_watermark('vendas', 'run_1'), opened.calls
    except OSError:
        return 'raised', opened.calls


def proof_case(edits, failures, proof):
    """-> (the reason as the API shows it, how many times the proof was read). The run completed, nothing pending, one steer sent."""
    approvals, native, _cron = load(*edits)
    import tempfile
    db = Path(tempfile.mkdtemp()) / 'luvebot.db'
    conn = approvals.connect(db)
    conn.execute("INSERT INTO approvals (request_id, run_id, source, bot, surface, mechanism, command_redacted, description, pattern_keys,"
                 " allowed_choices, digest, action_class_hash, created_at, expires_at, status, decided_choice, reason, reason_steer, reason_steer_after)"
                 " VALUES ('req_x','run_1','run','vendas','run','hook_approve','chmod 600 x','d','[]','[]','g','h',1,2,'consumed','deny','r','accepted', 4)")
    conn.commit()
    conn.close()

    class Client:
        def __init__(self, _bot):
            pass

        def call(self, method, path, body=None, **_kw):
            return 200, {'status': 'completed', 'session_id': 'sess_1'}
    native.ApiClient = Client
    native.steer_proofs = reads = Flaky(failures, proof)
    native.settle_reasons(db, 'vendas', 'run_1')
    return approvals.view(approvals.get(db, 'req_x'))['reason_delivered'], reads.calls


# ---- the watermark -----------------------------------------------------------------------------------------------------------------------------
def check_watermark(edits=()):
    assert watermark_case(edits, 0) == (7, 1)                                            # a clean read: once
    assert watermark_case(edits, 1) == (7, 2) and watermark_case(edits, 3) == (7, 4)     # a moment of trouble: read again, the real id
    got, calls = watermark_case(edits, 99)
    assert got == 'raised' and calls == 4                                                # the database stays down: the error stands after 4 tries (the route turns it into "no proof")
    assert watermark_case(edits, 0, session_ok=False) == (None, 0) and True              # no session id: None (the run is unreadable), and no database was opened


def test_the_watermark_is_read_again_after_a_transient_failure():
    check_watermark()


# ---- the proof ---------------------------------------------------------------------------------------------------------------------------------
def check_proof(edits=()):
    assert proof_case(edits, 0, {'req_x'}) == (True, 1)                                  # a clean read: once
    assert proof_case(edits, 2, {'req_x'}) == (True, 3)                                  # the transcript failed twice, then it was there: delivered, not unknown for good
    assert proof_case(edits, 0, set()) == (None, 1)                                      # NO proof is final at once: a lost steer costs no wait, and it is unknown
    assert proof_case(edits, 99, {'req_x'}) == (None, 4)                                 # the database stays down: unknown after 4 tries, never delivered


def test_the_proof_is_read_again_after_a_transient_failure_and_an_empty_answer_is_final():
    check_proof()


# ---- mutations ---------------------------------------------------------------------------------------------------------------------------------
MUTATIONS = {
    'no retry on the watermark': ([('        return _retrying(once)\n', '        return once()\n')], check_watermark),
    'no retry on the proof': ([('proven = _retrying(lambda: steer_proofs(bot, session_id, sent))', 'proven = steer_proofs(bot, session_id, sent)')], check_proof),
    'a single try': ([('READ_TRIES, READ_PAUSE = 4, 0.2', 'READ_TRIES, READ_PAUSE = 1, 0.2')], check_proof),
    'a single try (watermark)': ([('READ_TRIES, READ_PAUSE = 4, 0.2', 'READ_TRIES, READ_PAUSE = 1, 0.2')], check_watermark),
    'an empty proof is tried again': ([('proven = _retrying(lambda: steer_proofs(bot, session_id, sent))',
                                        'proven = _retrying(lambda: steer_proofs(bot, session_id, sent) or (_ for _ in ()).throw(OSError("empty")))')], check_proof),
    'the error is swallowed after the tries': ([('            if attempt == READ_TRIES - 1:\n                raise\n', '            if attempt == READ_TRIES - 1:\n                return None\n')], check_watermark),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_mutation_turns_its_check_red(label):
    edits, check = MUTATIONS[label]
    with pytest.raises(Exception):  # noqa: B017 (AssertionError, or the TypeError of a mutant that returns None where a number is read)
        check(edits)


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_mutation_applies_to_the_source(label):
    """A mutation whose anchor moved would raise inside the check above and look red: this one loads it alone."""
    load(*MUTATIONS[label][0])
