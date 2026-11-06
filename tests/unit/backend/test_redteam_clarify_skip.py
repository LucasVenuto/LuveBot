"""Red team (Lume, K-4, 30/10): the answer path of a clarify (`backend/canonical.py`: `validate_clarify_body`, `validate_answer`, `answer_clarify`) against what contract v0.11 4.1 decides about Skip:
the word `skip` is never sent as a skip; a REAL skip may exist (K-1, after K-2b: Hermes reads an EMPTY or None answer as `skipped`), as the exclusive body `{request_id, execution_generation, skip: true}`, and
then the server sends Hermes exactly ONE SPACE (`CLARIFY_SKIP_ANSWER`: A-164 revised after K-2b, which measured it: a blank answer is `skipped` per question and the run goes on, `""` is `unanswered` for EVERY
question and ends the whole call, `null` is a 400). What makes this the dangerous part: **a blank IS the skip in Hermes, and an empty string ends the call**, so ANY path that lets LuveBot send a blank or "" (a blank
field, a list with an empty item, a label that is empty, a body that also carries a blank) would skip a question the person meant to answer, or end the whole call, with no `skip` anywhere in the request.

The real functions are taken from the source with `ast` and run with stand-ins for what they reach (the Hermes call, `safe_id`, the refusal table). Pinned now, so K-1 cannot loosen it (plain tests): every body that
is not exactly an answer or exactly a skip is refused (`skip: "true"`, 1, None, False, with an `answer` of any kind, in any casing, with an extra key); the typed word `skip` is an ordinary answer on a free-text
question and refused on a question with choices; a blank answer of any kind is refused; whatever is accepted, what is SENT is not blank (a property over thousands of generated answers, against questions of all three
kinds); a replay (the request_id of an earlier question, the generation of another, an answer after it was resolved) is `409 request_not_pending` and nothing is sent.
Open (xfail strict): a multi-select answer that names an EMPTY label (`[""]`) is accepted and sent.
When K-1 exists (`answer_clarify` takes `skip`), the tests of the second half run: the skip sends '' and only '' (never the word), is refused on a stale generation, an unknown request_id and a replay, and the
generation and the request id are the same checks as for an answer."""
import ast
import inspect
import json
import random
import re
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
CANONICAL = ROOT / 'backend' / 'canonical.py'
TREE = ast.parse(CANONICAL.read_text())


class PluginError(Exception):
    def __init__(self, code, message='', status=400, extra=None):
        super().__init__(message)
        self.code, self.status, self.extra = code, status, extra or {}


class HermesError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


SAFE_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}')
safe_id = lambda value: value if isinstance(value, str) and SAFE_ID.fullmatch(value) else None


def load(sent):
    """The real functions, with `read_run` and the Hermes client replaced: what the run looks like is set in `STATE`, what is POSTed to Hermes lands in `sent`."""
    ns = {'PluginError': PluginError, 'HermesError': HermesError, 'safe_id': safe_id, 'json': json, 're': re, 'KINDS': ('approval', 'clarify'), 'MAX_ANSWER': 16384, 'MAX_QUESTION': 2000,
          '_MESSAGES': {'request_not_pending': 'This request is no longer waiting.'}, 'refusal': lambda status, code, kind: None}

    class ApiClient:
        def __init__(self, bot):
            self.bot = bot

        def call_coded(self, method, path, payload=None):
            sent.append((method, path, payload))
            return STATE['answer_status'], STATE['answer_body'], None
    ns['ApiClient'] = ApiClient
    ns['read_run'] = lambda bot, run_id: STATE['run']
    for node in TREE.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'CLARIFY_SKIP_ANSWER' for t in node.targets):
            exec(compile(ast.Module([node], []), str(CANONICAL), 'exec'), ns)                    # the constant K-1 adds, when it exists
        if isinstance(node, ast.FunctionDef) and node.name in ('validate_clarify_body', 'validate_answer', '_invalid', 'answer_clarify', 'generation', 'controls', '_text'):
            exec(compile(ast.Module([node], []), str(CANONICAL), 'exec'), ns)
    return ns


STATE = {}


def pending(*controls, gen=3):
    return {'execution_generation': gen, 'pending_controls': list(controls)}


def clarify(prompt_id, question='Quer continuar?', choices=(), multi=False):
    return {'kind': 'clarify', 'prompt_id': prompt_id, 'question': question, 'choices': list(choices), 'multi_select': multi}


@pytest.fixture
def sent():
    STATE.clear()
    STATE.update({'run': pending(clarify('q1')), 'answer_status': 200, 'answer_body': {'status': 'resolved'}})
    return []


def code_of(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except PluginError as error:
        return error.code
    except Exception as error:  # noqa: BLE001
        return 'err:' + type(error).__name__


RID, GEN = 'q1', 3
ANSWER = {'request_id': RID, 'execution_generation': GEN, 'answer': 'sim'}


# ======================================================================== the body: exactly an answer, or exactly a skip ================================================
HOSTILE_SKIP_BODIES = {
    'skip as a string': {'request_id': RID, 'execution_generation': GEN, 'skip': 'true'}, 'skip as True-cased text': {'request_id': RID, 'execution_generation': GEN, 'skip': 'True'},
    'skip as 1': {'request_id': RID, 'execution_generation': GEN, 'skip': 1}, 'skip as 1.0': {'request_id': RID, 'execution_generation': GEN, 'skip': 1.0},
    'skip as a list': {'request_id': RID, 'execution_generation': GEN, 'skip': [True]}, 'skip as an object': {'request_id': RID, 'execution_generation': GEN, 'skip': {'a': 1}},
    'skip None': {'request_id': RID, 'execution_generation': GEN, 'skip': None}, 'skip False': {'request_id': RID, 'execution_generation': GEN, 'skip': False},
    'skip 0': {'request_id': RID, 'execution_generation': GEN, 'skip': 0}, 'skip yes': {'request_id': RID, 'execution_generation': GEN, 'skip': 'yes'},
    'skip with an answer': {**ANSWER, 'skip': True}, 'skip with an empty answer': {**ANSWER, 'answer': '', 'skip': True}, 'skip with a blank answer': {**ANSWER, 'answer': '   ', 'skip': True},
    'skip with a None answer': {**ANSWER, 'answer': None, 'skip': True}, 'skip False with an answer': {**ANSWER, 'skip': False}, 'skip with the word as the answer': {**ANSWER, 'answer': 'skip', 'skip': True},
    'Skip capitalised': {'request_id': RID, 'execution_generation': GEN, 'Skip': True}, 'SKIP upper': {'request_id': RID, 'execution_generation': GEN, 'SKIP': True},
    'skip with a space in the key': {'request_id': RID, 'execution_generation': GEN, 'skip ': True}, 'skipped': {'request_id': RID, 'execution_generation': GEN, 'skipped': True},
    'skip_question': {'request_id': RID, 'execution_generation': GEN, 'skip_question': True}, 'skip and an extra key': {'request_id': RID, 'execution_generation': GEN, 'skip': True, 'profile': 'x'},
    'skip and a scope': {'request_id': RID, 'execution_generation': GEN, 'skip': True, 'scope': 'main'}, 'skip with no request_id': {'execution_generation': GEN, 'skip': True},
    'skip with no generation': {'request_id': RID, 'skip': True}, 'skip with a bad generation': {'request_id': RID, 'execution_generation': True, 'skip': True},
    'skip with a negative generation': {'request_id': RID, 'execution_generation': -1, 'skip': True}, 'skip with a float generation': {'request_id': RID, 'execution_generation': 3.0, 'skip': True},
    'skip with a bad id': {'request_id': '../x', 'execution_generation': GEN, 'skip': True}, 'an empty body': {}, 'only a request_id': {'request_id': RID},
}


@pytest.mark.parametrize('label', sorted(HOSTILE_SKIP_BODIES))
def test_a_body_that_is_not_exactly_an_answer_is_refused_and_none_is_a_skip(label, sent):
    """Today the body is exactly {request_id, execution_generation, answer}; K-1 adds exactly {request_id, execution_generation, skip: true} and nothing in between. None of these is either."""
    ns = load(sent)
    assert code_of(ns['validate_clarify_body'], HOSTILE_SKIP_BODIES[label]) in ('bad_request', 'invalid_field', 'invalid_answer'), label


@pytest.mark.parametrize('body', [[], 'skip', 5, None, True, [ANSWER]])
def test_a_body_that_is_not_an_object_is_a_400(body, sent):
    assert code_of(load(sent)['validate_clarify_body'], body) == 'bad_request'


def test_a_json_body_with_a_repeated_key_is_the_last_one_and_that_is_what_is_checked(sent):
    parsed = json.loads('{"request_id":"q1","execution_generation":3,"answer":"sim","answer":""}')
    assert parsed['answer'] == '' and code_of(load(sent)['validate_answer'], clarify('q1') | {'request_id': 'q1'}, parsed['answer']) == 'invalid_answer'


# ======================================================================== the word and the blank ====================================================================
def control(**kw):
    c = {'kind': 'clarify', 'request_id': RID, 'question': 'Q?', 'choices': [], 'multi_select': False}
    c.update(kw)
    return c


def test_the_typed_word_skip_is_an_ordinary_answer_on_free_text_and_refused_on_choices(sent):
    ns = load(sent)
    for word in ('skip', 'SKIP', 'Skip', ' skip ', 'skip.'):
        assert ns['validate_answer'](control(), word) == word                                  # free text: it is the person's word, sent as it is, an ANSWER (status `answered`, not `skipped`)
        assert code_of(ns['validate_answer'], control(choices=['a', 'b']), word) == 'invalid_answer'
        assert code_of(ns['validate_answer'], control(choices=['a', 'b'], multi=True) | {'multi_select': True}, json.dumps([word])) == 'invalid_answer'


BLANKS = ['', ' ', '  ', '\t', '\n', '\r\n', ' \t\n ', chr(0xa0), chr(0x3000), chr(0x2003), chr(0x2028), chr(0x2029), chr(0x85), chr(0x1c), chr(0x1f), chr(0x0b), chr(0x0c), chr(0xfeff)]


@pytest.mark.parametrize('blank', BLANKS, ids=[repr(b) for b in BLANKS])
def test_a_blank_answer_of_any_kind_is_refused_on_every_kind_of_question(blank, sent):
    """Hermes reads an empty answer, and a blank one, as `skipped`: a blank must never leave LuveBot as an answer."""
    ns = load(sent)
    for ctl in (control(), control(choices=['a', 'b']), control(choices=['a', 'b'], multi_select=True), control(choices=['', ' ', 'a'])):
        if blank == chr(0xfeff):                                                              # a BOM is not whitespace for `str.strip()`: it is a character, an answer made of one (the table of 3.4 marks it)
            continue
        assert code_of(ns['validate_answer'], ctl, blank) == 'invalid_answer', (ctl, blank)


@pytest.mark.parametrize('bad', [None, 0, False, [], {}, b'', ['a'], 5.5])
def test_an_answer_that_is_not_a_string_is_refused(bad, sent):
    assert code_of(load(sent)['validate_answer'], control(), bad) == 'invalid_answer'


def test_a_question_with_an_empty_or_blank_label_can_never_be_answered_by_that_label(sent):
    ns = load(sent)
    ctl = control(choices=['', ' ', 'a'])
    assert code_of(ns['validate_answer'], ctl, '') == 'invalid_answer' and code_of(ns['validate_answer'], ctl, ' ') == 'invalid_answer'
    assert ns['validate_answer'](ctl, 'a') == 'a'


@pytest.mark.parametrize('answer', ['[""]', '["", "a"]', '[" "]', '["a", ""]', '["\\t"]'])
def test_a_multi_select_answer_with_an_empty_label_is_refused(answer, sent):
    ns = load(sent)
    assert code_of(ns['validate_answer'], control(choices=['', ' ', '\t', 'a', 'b'], multi_select=True), answer) == 'invalid_answer'


@pytest.mark.parametrize('answer', ['[]', '[ ]', 'null', '""', 'a', '["a", "a"]', '["c"]', '{"a": 1}', '["a", 5]', '[["a"]]', '1', 'true', '["a"] ', ' ["a"]'])
def test_a_multi_select_answer_that_is_not_a_list_of_distinct_labels_is_refused_or_normalized(answer, sent):
    ns = load(sent)
    ctl = control(choices=['a', 'b'], multi_select=True)
    out = code_of(ns['validate_answer'], ctl, answer)
    assert out == 'invalid_answer' or (isinstance(out, str) and json.loads(out) == ['a'] and answer.strip() == '["a"]'), (answer, out)


def test_whatever_is_accepted_what_is_sent_is_never_blank(sent):
    """A property over generated answers (blanks of every kind, zero-width characters, labels, JSON): for questions of the three kinds, an accepted answer's validated value is non-blank."""
    ns = load(sent)
    rng = random.Random(20261030)
    alphabet = ['a', 'b', ' ', '\t', '\n', chr(0xa0), chr(0x3000), chr(0x200b), chr(0xfeff), chr(0x85), chr(0x1f), '"', '[', ']', ',', '1', 'skip']
    kinds = [control(), control(choices=['a', 'b']), control(choices=['a', 'b'], multi_select=True), control(choices=['', ' ', 'a', 'b']), control(choices=['', ' ', 'a'], multi_select=True)]
    accepted = 0
    for _ in range(6000):
        answer = ''.join(rng.choice(alphabet) for _ in range(rng.randint(0, 7)))
        for ctl in kinds:
            try:
                value = ns['validate_answer'](ctl, answer)
            except PluginError:
                continue
            accepted += 1
            assert isinstance(value, str) and value.strip() != '', (ctl, answer, value)
            if ctl['multi_select'] and ctl['choices']:
                assert json.loads(value) != [] and all(isinstance(x, str) for x in json.loads(value))
    assert accepted > 1000


# ======================================================================== the request: pending, generation, replay ======================================================
def test_an_answer_is_forwarded_once_with_the_generation_the_person_saw(sent):
    ns = load(sent)
    ns['answer_clarify']('vendas', 'run1', RID, GEN, 'sim')
    assert sent == [('POST', '/v1/runs/run1/clarify', {'request_id': RID, 'execution_generation': GEN, 'answer': 'sim'})]


@pytest.mark.parametrize('label,request_id,generation', [('the id of an earlier question', 'q0', GEN), ('the id of the NEXT question', 'q2', GEN), ('the right id, the generation of another time', RID, GEN - 1),
                                                         ('the right id, a generation from the future', RID, GEN + 1), ('an id that is not there', 'zz', GEN)])
def test_a_replay_or_a_stale_request_is_409_not_pending_and_nothing_is_sent(label, request_id, generation, sent):
    STATE['run'] = pending(clarify('q1'), gen=GEN)                                              # q1 is the one pending; q2 will be, after it; q0 was
    ns = load(sent)
    assert code_of(ns['answer_clarify'], 'vendas', 'run1', request_id, generation, 'sim') == 'request_not_pending', label
    assert sent == [], 'nothing reached Hermes'


def test_an_answer_for_the_question_after_this_one_is_refused_until_it_is_pending_and_then_goes_with_its_own_id(sent):
    ns = load(sent)
    ns['answer_clarify']('vendas', 'run1', 'q1', GEN, 'sim')
    sent.clear()
    assert code_of(ns['answer_clarify'], 'vendas', 'run1', 'q2', GEN, 'sim') == 'request_not_pending'      # q2 is not on the run yet: an answer typed ahead is not queued
    STATE['run'] = pending(clarify('q2'), gen=GEN)                                              # Hermes moved on: q1 is gone, q2 is pending
    assert code_of(ns['answer_clarify'], 'vendas', 'run1', 'q1', GEN, 'sim') == 'request_not_pending'      # the replay of the answer of q1 does NOT answer q2
    assert sent == []
    ns['answer_clarify']('vendas', 'run1', 'q2', GEN, 'sim')
    assert sent == [('POST', '/v1/runs/run1/clarify', {'request_id': 'q2', 'execution_generation': GEN, 'answer': 'sim'})]


def test_an_answer_hermes_says_was_already_resolved_is_409_and_not_success(sent):
    STATE['answer_body'] = {'status': 'already_resolved'}
    assert code_of(load(sent)['answer_clarify'], 'vendas', 'run1', RID, GEN, 'sim') == 'request_not_pending'


def test_an_answer_to_an_approval_control_or_to_a_control_of_another_kind_is_not_a_clarify_answer(sent):
    STATE['run'] = pending({'kind': 'approval', 'prompt_id': 'q1'})
    assert code_of(load(sent)['answer_clarify'], 'vendas', 'run1', RID, GEN, 'sim') == 'request_not_pending' and sent == []


# ======================================================================== when K-1 exists ==============================================================================
def k1(ns):
    if 'skip' not in inspect.signature(ns['answer_clarify']).parameters:
        pytest.skip('K-1 (the `skip: true` body) is not written yet: these run the day `answer_clarify` takes `skip`')
    return ns['answer_clarify']


def test_a_skip_sends_exactly_one_space_never_the_empty_string_never_null_never_the_word(sent):
    """K-2b measured it: a blank answer is `skipped` per question and the run goes on; `""` ends the whole call (unanswered for every question); `null` is a 400. So the skip is ONE SPACE, a constant of the backend."""
    answer = k1(load(sent))
    answer('vendas', 'run1', RID, GEN, None, skip=True)
    assert len(sent) == 1 and sent[0][2]['answer'] == ' ' and sent[0][2]['answer'] not in ('', None, 'skip') and set(sent[0][2]) == {'request_id', 'execution_generation', 'answer'}


def test_the_skip_constant_is_one_space_defined_once_and_used_once():
    """`CLARIFY_SKIP_ANSWER`: defined once in backend/canonical.py and used once (the skip), so no other path can send a blank by writing its own."""
    assigned = [n for n in ast.walk(TREE) if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'CLARIFY_SKIP_ANSWER' for t in n.targets)]
    if not assigned:
        pytest.skip('K-1 is not written yet')
    assert len(assigned) == 1 and ast.literal_eval(assigned[0].value) == ' '
    uses = [n for n in ast.walk(TREE) if isinstance(n, ast.Name) and n.id == 'CLARIFY_SKIP_ANSWER' and isinstance(n.ctx, ast.Load)]
    assert len(uses) == 1, 'used once: the skip'


def test_a_skip_is_refused_exactly_where_an_answer_is(sent):
    answer = k1(load(sent))
    for request_id, generation in (('q0', GEN), ('q2', GEN), (RID, GEN - 1), (RID, GEN + 1), ('zz', GEN)):
        assert code_of(answer, 'vendas', 'run1', request_id, generation, None, skip=True) == 'request_not_pending'
    assert sent == []


def test_a_skip_that_also_carries_text_sends_at_most_the_one_space_never_the_text_and_a_typed_blank_never_passes_as_an_answer(sent):
    answer = k1(load(sent))
    for text in ('sim', 'skip', ' ', '\n'):
        before = len(sent)
        try:
            answer('vendas', 'run1', RID, GEN, text, skip=True)
        except PluginError:
            pass
        assert all(payload['answer'] == ' ' for _m, _p, payload in sent[before:]), text
    sent.clear()
    for blank in BLANKS[:12]:
        if blank != chr(0xfeff):
            assert code_of(answer, 'vendas', 'run1', RID, GEN, blank, skip=False) == 'invalid_answer'
    assert sent == []


def test_the_skip_of_a_replay_after_the_question_was_resolved_is_409(sent):
    STATE['answer_body'] = {'status': 'already_resolved'}
    answer = k1(load(sent))
    assert code_of(answer, 'vendas', 'run1', RID, GEN, None, skip=True) == 'request_not_pending'
