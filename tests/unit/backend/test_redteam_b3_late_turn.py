"""Red team (Lume, 30/10) of r54 (b3: a deny reason that reaches the run AFTER its last answer comes back as a plain user turn; the tag `[luvebot:ref <16 hex>]` ties that turn to ONE send).
Held: 9 mutations of the new proof path are red in test_b3_settle.py (no tag check, substring instead of the whole turn, any display_kind, any role: an assistant that copied the tag does not
prove, the watermark, the tag at the END, its length, the answer after, and a later turn never proves an earlier send); the tag is not in the approval view (an explicit key list); the audit keeps
a digest only. Here:
* a closed gap: `settle_reasons` handing the stored nonce to the proof had NO test (the mutation "nonce not passed" survived: the late turn is then never proven, the safe side, silently);
* F9 (Info) a send with NO nonce (a row from before r54) whose own reason ends like a tag is proven by a plain turn with those exact words: `steer_proofs` sees only the text, and the lookalike
  at the end of the PERSON's words passes `_NONCE`. Who can post that turn is the person (the tag of a real send cannot be guessed: 64 random bits); `xfail(strict=True)`."""
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_b3_settle as tb  # noqa: E402  (its loader and its stub transcript)

NONCE = 'a1b2c3d4e5f60718'


def settled_text(tmp_path, nonce):
    """The text `settle_reasons` hands to the proof for a row that carries `nonce` (None: a row from before the tag)."""
    approvals, native = tb.load()
    db = tmp_path / f'row-{nonce}.db'
    conn = approvals.connect(db)
    conn.execute("INSERT INTO approvals (request_id, run_id, source, bot, surface, mechanism, command_redacted, description, pattern_keys, allowed_choices, digest, action_class_hash,"
                 " created_at, expires_at, status, decided_choice, reason, reason_steer, reason_steer_after, reason_steer_nonce)"
                 " VALUES ('req_x','run_1','run','vendas','run','hook_approve','chmod 600 x','d','[]','[]','g','h',1,2,'consumed','deny','r','accepted',4,?)", (nonce,))
    conn.commit()
    conn.close()

    class Client:
        def __init__(self, _bot):
            pass

        def call(self, method, path, body=None, **_kw):
            return 200, {'status': 'completed', 'session_id': 'sess_1'}
    native.ApiClient = Client
    seen = []

    def steer_proofs(bot, session_id, sent):
        seen.append(sent)
        return set()
    native.steer_proofs = steer_proofs
    native.settle_reasons(db, 'vendas', 'run_1')
    return native, seen


def test_the_stored_nonce_reaches_the_proof(tmp_path):
    native, seen = settled_text(tmp_path, NONCE)
    assert seen == [[('req_x', native.deny_steer_text('r', NONCE), 4)]] and seen[0][0][1].endswith(f'\n[luvebot:ref {NONCE}]')


def test_a_row_from_before_the_tag_is_proven_by_its_old_text(tmp_path):
    native, seen = settled_text(tmp_path, None)
    assert seen == [[('req_x', native.deny_steer_text('r'), 4)]] and '[luvebot:ref' not in seen[0][0][1]


def proofs(native, text, rows):
    tb.native_db.rows = rows
    return native.steer_proofs('vendas', 'sess_1', [('req_1', text, 2)])


def answer(i):
    return {'id': i, 'role': 'assistant', 'content': 'ok'}


def test_control_a_tagged_send_is_proven_by_its_exact_late_turn_and_by_no_other():
    native = tb.load_read()
    text = native.deny_steer_text('Agora não', NONCE)
    turn = {'id': 3, 'role': 'user', 'display_kind': None, 'content': text}
    assert proofs(native, text, [turn, answer(4)]) == {'req_1'}
    assert proofs(native, text, [{**turn, 'content': text + '\n'}, answer(4)]) == {'req_1'}                           # whitespace around is not a difference
    assert proofs(native, text, [{**turn, 'role': 'assistant'}, answer(4)]) == set()                                  # the Bot copying the tag
    assert proofs(native, text, [{**turn, 'role': 'tool'}, answer(4)]) == set()
    assert proofs(native, text, [{**turn, 'content': '> ' + text.replace('\n', '\n> ')}, answer(4)]) == set()         # a quote
    assert proofs(native, text, [{**turn, 'content': 'before\n' + text}, answer(4)]) == set()                         # text around it
    assert proofs(native, text, [{**turn, 'content': text.replace(NONCE, '0f1e2d3c4b5a6978')}, answer(4)]) == set()   # another send's tag


@pytest.mark.xfail(strict=True, reason='F9 (Info) approvals_native.steer_proofs/_NONCE: it sees only the TEXT, so a send with no nonce (a row from before r54) whose person-written reason ends like '
                                         '"\\n[luvebot:ref <16 hex>]" is proven by a plain turn with exactly those words. Pass the stored nonce (a 4th element of `sent`) and require it, or end the '
                                         'untagged text so a lookalike cannot be the tail.')
def test_finding_an_untagged_send_is_never_proven_by_a_plain_turn():
    native = tb.load_read()
    text = native.deny_steer_text('ok\n[luvebot:ref 0123456789abcdef]')            # no nonce: the old text, ending in the person's own lookalike
    turn = {'id': 3, 'role': 'user', 'display_kind': None, 'content': text}
    assert proofs(native, text, [turn, answer(4)]) == set()
