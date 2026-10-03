"""b3 settling, without Hermes (a review stub showed a cancelled run counted as delivered): a deny reason sent as a steer is
DELIVERED only with proof that the model read it: the run COMPLETED, nothing came back pending, AND the session's transcript holds
that send's steer row with an answer of the model after it. "Completed with nothing pending" alone is not proof: a steer accepted
after the finalizer's drain is lost (the B3_QUICK race; see approvals_native.settle_reasons): unknown. A completed run with the
steer pending is not delivered. A failed, cancelled or interrupted run: unknown. A run that has not ended stays accepted (None).
Each proof is of ONE send: only a steer row inserted after that send's watermark (the session's last message id read just before
sending), and each occurrence of the text proves one send, in send order. Two denies with the same reason, only the first read:
the second is unknown.
Mutations: "nothing pending" taken as proof (the race); the steer row not told apart from a person's own message; no answer needed
after it; the watermark ignored; one occurrence proving several sends. (Settling on any end, the first version's mutation, is now
equivalent: a run that did not complete gets no proof, so it is unknown either way.)
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


def run_ends(approvals, native, tmp_path, status, pending=ABSENT, read=True):
    db = tmp_path / f'{status}-{next(_n)}.db'
    conn = approvals.connect(db)
    conn.execute("INSERT INTO approvals (request_id, run_id, source, bot, surface, mechanism, command_redacted, description, pattern_keys,"
                 " allowed_choices, digest, action_class_hash, created_at, expires_at, status, decided_choice, reason, reason_steer,"
                 " reason_steer_after)"
                 " VALUES ('req_x','run_1','run','vendas','run','hook_approve','chmod 600 x','d','[]','[]','g','h',1,2,'consumed','deny','r','accepted',"
                 " 4)")
    conn.commit()
    conn.close()

    class Client:
        def __init__(self, _bot):
            pass

        def call(self, method, path, body=None, **_kw):
            return 200, {'status': status, 'session_id': 'sess_1', **({} if pending is ABSENT else {'pending_steer': pending})}
    native.ApiClient = Client

    def steer_proofs(bot, session_id, sent):
        assert (bot, session_id) == ('vendas', 'sess_1') and sent == [('req_x', native.deny_steer_text('r'), 4)], (bot, session_id, sent)
        if read is None:
            raise OSError('transcript unreadable')
        return {'req_x'} if read else set()
    native.steer_proofs = steer_proofs
    native.settle_reasons(db, 'vendas', 'run_1')
    return approvals.view(approvals.get(db, 'req_x'))['reason_delivered']


def checks(approvals, native, tmp_path):
    assert run_ends(approvals, native, tmp_path, 'completed', None) is True                      # read: the transcript proves it
    assert run_ends(approvals, native, tmp_path, 'completed') is True
    assert run_ends(approvals, native, tmp_path, 'completed', read=False) is None                 # nothing pending, no proof: unknown
    assert run_ends(approvals, native, tmp_path, 'completed', None, read=None) is None           # transcript unreadable: unknown
    assert run_ends(approvals, native, tmp_path, 'completed', '[luvebot:deny] ...') is False     # handed back unread
    for ended in ('cancelled', 'failed', 'interrupted'):                                       # no finalizer, no field
        assert run_ends(approvals, native, tmp_path, ended) is None, ended
    assert run_ends(approvals, native, tmp_path, 'running') is None                              # not ended: still accepted


def test_delivered_only_for_a_completed_run_with_nothing_pending(tmp_path):
    checks(*load(), tmp_path)


def test_the_race_mutation_is_caught(tmp_path):
    """The version before this fix: completed with nothing pending was called delivered."""
    mutant = load(("            state = 'delivered' if request_id in proven else 'unknown'", "            state = 'delivered'"))
    with pytest.raises(AssertionError):
        checks(*mutant, tmp_path)


class Transcript:
    """Hermes's SessionDB as far as the proof reads it: rows in id order, `after_id` keyset paging (hermes_state_messages.py)."""
    def __init__(self, rows):
        self.rows = rows

    def get_messages(self, session_id, after_id=None, latest=False, limit=None):
        rows = [r for r in self.rows if after_id is None or r['id'] > after_id]
        return rows[-limit:] if latest and limit else list(rows)

    def close(self):
        pass


native_db = Transcript([])


def load_read(edit=None):
    approvals, native = load(edit)
    cron = types.ModuleType(native.__package__ + '.hermes_cron')
    cron._session_db = lambda bot: native_db
    sys.modules[cron.__name__] = cron
    return native


def proof_checks(native):
    text = native.deny_steer_text('não')
    ask = {'id': 1, 'role': 'user', 'content': 'B3_QUICK: run it'}

    def steer(i, content=None):
        return {'id': i, 'role': 'user', 'display_kind': 'steer', 'content': '[steer] ' + (content or text)}

    def answer(i):
        return {'id': i, 'role': 'assistant', 'content': 'ok'}

    def proofs(rows, sent):
        native_db.rows = rows
        return native.steer_proofs('vendas', 'sess_1', sent)
    one = [('req_1', text, 2)]
    assert proofs([ask, answer(2), steer(3), answer(4)], one) == {'req_1'}                      # read: its row, then an answer
    assert proofs([ask, answer(2), answer(3), steer(4)], one) == set()                          # after the last answer: not read
    assert proofs([ask, answer(2), answer(3)], one) == set()                                    # never reached the transcript
    assert proofs([ask, answer(2), steer(3, 'other words'), answer(4)], one) == set()           # another reason
    assert proofs([ask, answer(2), {'id': 3, 'role': 'user', 'content': text}, answer(4)], one) == set()   # a person's own words
    # the Maestro's case: two denies, the SAME reason; the 1st read (its row before the 2nd's watermark), the 2nd lost
    assert proofs([ask, answer(2), steer(3), answer(4), answer(5)], [('req_1', text, 2), ('req_2', text, 5)]) == {'req_1'}
    # a steer row with the same words from BEFORE this send (another send, or someone else's steer) never proves it
    assert proofs([ask, steer(3, text), answer(4), steer(6, 'B'), answer(7)], [('req_b', 'B', 2), ('req_1', text, 5)]) == {'req_b'}
    # two sends in one tool batch, joined in ONE row: proven only as many times as the text occurs
    joined = [ask, answer(2), steer(3, text + '\n' + text), answer(4)]
    assert proofs(joined, [('req_1', text, 2), ('req_2', text, 2)]) == {'req_1', 'req_2'}
    assert proofs([ask, answer(2), steer(3), answer(4)], [('req_1', text, 2), ('req_2', text, 2)]) == {'req_1'}


def test_a_proof_is_of_one_send_after_its_watermark():
    proof_checks(load_read())


@pytest.mark.parametrize('edit', [
    ("row.get('role') == 'user' and row.get('display_kind') == 'steer' and int(", "row.get('role') == 'user' and int("),
    ("            if free > 0 and any(later.get('role') == 'assistant' for later in rows[index + 1:]):", "            if free > 0:"),
    ("and int(row.get('id') or 0) > after):", "):"),
    ("                used[(index, wanted)] = used.get((index, wanted), 0) + 1\n", ""),
], ids=['any_user_row_counts', 'no_answer_needed', 'watermark_ignored', 'one_occurrence_many_sends'])
def test_each_proof_mutation_is_caught(edit):
    native = load_read(edit)
    with pytest.raises(AssertionError):
        proof_checks(native)
