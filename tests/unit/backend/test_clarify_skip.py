"""K-1 (contract v0.11 section 4): the Skip of a clarify. Hermes reads a BLANK answer as `skipped` for that question (K-2b), the EMPTY string ends the whole call and `null` is a 400: so a skip is the exclusive body
{request_id, execution_generation, skip: true} and the server sends exactly ONE SPACE from one constant, `CLARIFY_SKIP_ANSWER`, defined once and used once, never `""`, never `None`, never the word `skip`, never what the
browser supplied; the ordinary answer route still refuses a blank or empty answer on the three kinds (a blank reaches Hermes only through the button), a multi-select label that is blank is refused (F-K3); a skip is
refused exactly where an answer is (stale generation, request not pending); the audit of a skip is `skipped: true` and nothing else.
THE PROPERTY that locks `""`: over every path to Hermes's clarify answer (option, text, multi-select, skip) and a fuzz of blanks, lists and quotes, an accepted request never sends `answer == ""` or `None`, and a string
of only blanks leaves only for `skip: true` and then it is exactly `" "`. Mutations: one line changed -> red."""
import ast
import itertools
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_canonical as tc  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / 'backend'
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
CANONICAL = (BACKEND / 'canonical.py').read_text()
KINDS = {'free text': dict(), 'choices': dict(choices=['Sim', 'Não']), 'multi-select': dict(choices=['a', 'b', ''], multi=True)}


def post_of(mod, kind, answer, *, skip=False, seen=4, request='q1'):
    """What reaches Hermes (the body of the POST) for one call of answer_clarify, or the refusal code."""
    fake = tc.arm(mod, tc.clarify_run(**KINDS[kind]), post=(200, {'status': 'resolved', 'prompt_id': 'q1'}, None), route='clarify')
    try:
        mod.answer_clarify('vendas', 'run1', request, seen, answer, skip=skip)
    except Exception as error:  # noqa: BLE001
        return getattr(error, 'code', type(error).__name__), fake.posts
    return 'sent', fake.posts


def checks(mod):
    # a skip: exactly one space, on the three kinds, whatever the person typed alongside (nothing of it is looked at)
    for kind in KINDS:
        for typed in (None, 'sim', 'skip', ' ', '', '\n', '["a"]', 7):
            code, posts = post_of(mod, kind, typed, skip=True)
            assert code == 'sent' and posts == [('/v1/runs/run1/clarify', {'request_id': 'q1', 'execution_generation': 4, 'answer': ' '})], (kind, typed, code, posts)
    # a skip is refused exactly where an answer is: a stale generation, a request that is not pending, a replay
    for kind in KINDS:
        assert post_of(mod, kind, None, skip=True, seen=3) == ('request_not_pending', []), kind
        assert post_of(mod, kind, None, skip=True, request='q9') == ('request_not_pending', []), kind
    fake = tc.arm(mod, tc.clarify_run(), post=(200, {'status': 'already_resolved', 'prompt_id': 'q1'}, None), route='clarify')
    with pytest.raises(Exception) as got:
        mod.answer_clarify('vendas', 'run1', 'q1', 4, None, skip=True)
    assert got.value.code == 'request_not_pending' and got.value.status == 409
    # the ordinary route still refuses a blank or empty typed answer, on the three kinds, and nothing reaches Hermes
    for kind in KINDS:
        for blank in ('', ' ', '   ', '\n', '\t', ' ', '　', None, 7):
            code, posts = post_of(mod, kind, blank)
            assert code == 'invalid_answer' and posts == [], (kind, blank, code)
    # F-K3: a multi-select that names an empty or blank label is refused (the label is among the choices, and still not an answer)
    for answer in ('[""]', '["", "a"]', '["a", ""]', '[" "]', '["\\t"]'):
        assert post_of(mod, 'multi-select', answer) == ('invalid_answer', []), answer
    assert post_of(mod, 'multi-select', '["a", "b"]')[0] == 'sent' and post_of(mod, 'choices', 'Sim')[0] == 'sent' and post_of(mod, 'free text', 'sim, pode')[0] == 'sent'
    # the word `skip` typed by a person stays an ordinary answer on free text and is refused on a question with choices; it is never a skip
    assert post_of(mod, 'free text', 'skip')[1][0][1]['answer'] == 'skip' and post_of(mod, 'choices', 'skip') == ('invalid_answer', [])
    # the body
    ok = {'request_id': 'q1', 'execution_generation': 4}
    assert mod.validate_clarify_body({**ok, 'skip': True}) == {**ok, 'answer': None, 'skip': True}
    assert mod.validate_clarify_body({**ok, 'answer': 'sim'}) == {**ok, 'answer': 'sim', 'skip': False}
    for skip in ('true', 'True', 1, 1.0, 0, None, False, [True], {'a': 1}, 'yes', ''):
        assert refusal(lambda: mod.validate_clarify_body({**ok, 'skip': skip})) == 'invalid_answer', skip
    for extra in ({'answer': 'sim'}, {'answer': ''}, {'answer': None}, {'choices': ['a']}, {'answer': 'skip'}, {'profile': 'x'}, {'scope': 'main'}, {'Skip': True}):
        assert refusal(lambda: mod.validate_clarify_body({**ok, 'skip': True, **extra})) in ('invalid_answer', 'bad_request'), extra
    for body in ({**ok}, {'request_id': 'q1', 'skip': True}, {'execution_generation': 4, 'skip': True}, {**ok, 'skip_question': True}, {**ok, 'answer': 'a', 'x': 1}, {}, [], None, 'skip'):
        assert refusal(lambda: mod.validate_clarify_body(body)) in ('bad_request', 'invalid_field'), body
    assert refusal(lambda: mod.validate_clarify_body({'request_id': '../x', 'execution_generation': 4, 'skip': True})) == 'invalid_field'
    assert refusal(lambda: mod.validate_clarify_body({**ok, 'execution_generation': True, 'skip': True})) == 'invalid_field'


def refusal(call):
    try:
        call()
    except Exception as error:  # noqa: BLE001
        return getattr(error, 'code', type(error).__name__)
    return None


def test_the_skip_body_the_one_space_and_the_gates_of_an_answer():
    checks(tc.load()[0])


# ---- the property that locks "" ---------------------------------------------------------------------------------------------------------------------------
ALPHABET = ['', ' ', '\n', '\t', ' ', '　', '\u200b', '\ufeff', 'a', '"', '[', ']', ',', '""', '" "', 'skip', 'null']


def property_checks(mod):
    sent, seen = 0, 0
    for kind in KINDS:
        for parts in itertools.product(ALPHABET, repeat=3):
            text = ''.join(parts)
            for skip in (False, True):
                code, posts = post_of(mod, kind, text, skip=skip)
                seen += 1
                if code != 'sent':
                    assert posts == [], (kind, text, skip, code)                                      # a refusal sends nothing
                    continue
                sent += 1
                answer = posts[0][1]['answer']
                assert answer is not None and answer != '', (kind, text, skip, answer)               # never `""`, never null
                if not answer.strip():
                    assert skip and answer == ' ', (kind, text, skip, answer)                         # a blank leaves only for a skip, and then it is the one space
                if skip:
                    assert answer == ' ', (kind, text, answer)                                        # a skip sends nothing else, whatever was typed with it
    assert seen == len(KINDS) * len(ALPHABET) ** 3 * 2 and sent > 1000, (seen, sent)


def test_no_path_to_hermes_ever_sends_an_empty_answer_and_a_blank_leaves_only_for_a_skip():
    property_checks(tc.load()[0])


def test_the_constant_is_one_space_defined_once_and_used_once_by_the_skip_alone():
    tree = ast.parse(CANONICAL)
    assigned = [n for n in ast.walk(tree) if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'CLARIFY_SKIP_ANSWER' for t in n.targets)]
    assert len(assigned) == 1 and isinstance(assigned[0].value, ast.Constant) and assigned[0].value.value == ' '
    uses = [n for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id == 'CLARIFY_SKIP_ANSWER' and isinstance(n.ctx, ast.Load)]
    assert len(uses) == 1
    function = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'answer_clarify')
    assert any(isinstance(n, ast.Name) and n.id == 'CLARIFY_SKIP_ANSWER' for n in ast.walk(function)), 'used by the skip path'
    for rel in sorted(BACKEND.glob('*.py')):
        if rel.name != 'canonical.py':
            assert 'CLARIFY_SKIP_ANSWER' not in rel.read_text(), rel.name
    assert 'CLARIFY_SKIP_ANSWER' not in API


def route_checks(api):
    route = api.split('async def answer_run_clarify(', 1)[1].split('\n@router.', 1)[0]
    assert route.index('human = _human(request)') < route.index('canonical.validate_clarify_body(') < route.index('canonical.answer_clarify(')       # a person first (loopback_not_human, credential_not_human), then the body
    assert "skip=fields['skip']" in route and "fields['answer'], skip=fields['skip']" in route
    skipped = route.split("if fields['skip']:", 1)[1].split('    else:\n', 1)[0]
    assert "'skipped': True" in skipped and "'request_id': fields['request_id']" in skipped and 'answer' not in skipped.replace('# a skip is a click: the audit says so, with no text, no digest and no length (there is none)', ''), skipped
    typed = route.split('    else:\n', 1)[1].split('await run_in_threadpool(audit.act', 1)[0]
    assert "'answer_hmac': digest" in typed and "'answer_len': len(fields['answer'])" in typed and "'skipped'" not in typed
    assert "'run.clarify'" in route and 'bot=name, payload=payload' in route


def test_the_route_asks_for_a_person_first_and_audits_a_skip_without_a_word_of_text():
    route_checks(API)


# ---- mutations ----------------------------------------------------------------------------------------------------------------------------------------------
CODE_MUTATIONS = {
    'the constant is the empty string': ("CLARIFY_SKIP_ANSWER = ' '", "CLARIFY_SKIP_ANSWER = ''"),
    'the constant is the word': ("CLARIFY_SKIP_ANSWER = ' '", "CLARIFY_SKIP_ANSWER = 'skip'"),
    'the constant is null': ("CLARIFY_SKIP_ANSWER = ' '", "CLARIFY_SKIP_ANSWER = None"),
    'the constant is two spaces': ("CLARIFY_SKIP_ANSWER = ' '", "CLARIFY_SKIP_ANSWER = '  '"),
    'the browser text is the skip': ('value = CLARIFY_SKIP_ANSWER if skip else validate_answer(control, answer)', 'value = answer if skip else validate_answer(control, answer)'),
    'a skip is validated like an answer': ('value = CLARIFY_SKIP_ANSWER if skip else validate_answer(control, answer)', 'value = validate_answer(control, answer)'),
    'a skip is the answer when there is one': ('value = CLARIFY_SKIP_ANSWER if skip else validate_answer(control, answer)', 'value = CLARIFY_SKIP_ANSWER if skip and not answer else validate_answer(control, answer or CLARIFY_SKIP_ANSWER)'),
    'a blank typed answer is accepted': ("    if not isinstance(answer, str) or not answer.strip() or len(answer) > MAX_ANSWER:", "    if not isinstance(answer, str) or len(answer) > MAX_ANSWER:"),
    'an empty typed answer is accepted': ("    if not isinstance(answer, str) or not answer.strip() or len(answer) > MAX_ANSWER:", "    if not isinstance(answer, str) or len(answer) > MAX_ANSWER:\n        raise _invalid()\n    if not answer:\n        return ' '\n    if False:"),
    'a blank multi-select label is accepted': ("p.strip() and p in choices", "p in choices"),
    'skip may be the string true': ("body['skip'] is not True", "not body['skip']"),
    'skip may be 1': ("body['skip'] is not True", "body['skip'] != True"),
    'skip may carry an answer': ("set(body) != {'request_id', 'execution_generation', 'skip'} or body['skip'] is not True", "body['skip'] is not True"),
    'a skip is stale-tolerant': ("    if gen is None or gen != seen_generation or control is None:", "    if gen is None or (gen != seen_generation and not skip) or control is None:"),
    'a skip needs no pending request': ("    if gen is None or gen != seen_generation or control is None:", "    if gen is None or gen != seen_generation or (control is None and not skip):"),
    'the body check is gone': ("    if not isinstance(body, dict) or not {'request_id', 'execution_generation'} <= set(body) or not ({'answer'} == set(body) - {'request_id', 'execution_generation'} or 'skip' in body):\n        raise PluginError('bad_request', 'Malformed request body.', 400)",
                               "    if not isinstance(body, dict):\n        raise PluginError('bad_request', 'Malformed request body.', 400)"),
}


@pytest.mark.parametrize('label', sorted(CODE_MUTATIONS))
def test_each_canonical_mutation_is_caught(label):
    mod = tc.load(CODE_MUTATIONS[label])[0]                                       # an anchor that moved fails HERE
    with pytest.raises(BaseException):  # noqa: B017
        checks(mod)
        property_checks(mod)


ROUTE_MUTATIONS = {
    'the audit of a skip holds the answer': ("payload = {'request_id': fields['request_id'], 'execution_generation': fields['execution_generation'], 'skipped': True}",
                                             "payload = {'request_id': fields['request_id'], 'execution_generation': fields['execution_generation'], 'skipped': True, 'answer_len': len(fields['answer'] or '')}"),
    'the audit of a skip is not told': ("'execution_generation': fields['execution_generation'], 'skipped': True}", "'execution_generation': fields['execution_generation']}"),
    'the skip flag is not passed': ("fields['answer'], skip=fields['skip']),", "fields['answer']),"),
    'a person is asked after the body': ("    human = _human(request)\n    audit, meta = await run_in_threadpool(_stores)\n    index = await run_in_threadpool(RunIndex, meta.path)\n    name = await _owned_run(bot, run_id, index)\n    await _require_feature(name, 'runs')\n    await _need_authority(name)\n    fields = canonical.validate_clarify_body(",
                                         "    audit, meta = await run_in_threadpool(_stores)\n    index = await run_in_threadpool(RunIndex, meta.path)\n    name = await _owned_run(bot, run_id, index)\n    await _require_feature(name, 'runs')\n    await _need_authority(name)\n    fields = canonical.validate_clarify_body("),
    'the route says loopback is enough': ("    human = _human(request)\n    audit, meta = await run_in_threadpool(_stores)\n    index = await run_in_threadpool(RunIndex, meta.path)\n    name = await _owned_run(bot, run_id, index)\n    await _require_feature(name, 'runs')\n    await _need_authority(name)\n    fields = canonical.validate_clarify_body(",
                                          "    human = _human_actor(request)\n    audit, meta = await run_in_threadpool(_stores)\n    index = await run_in_threadpool(RunIndex, meta.path)\n    name = await _owned_run(bot, run_id, index)\n    await _require_feature(name, 'runs')\n    await _need_authority(name)\n    fields = canonical.validate_clarify_body("),
}


@pytest.mark.parametrize('label', sorted(ROUTE_MUTATIONS))
def test_each_route_mutation_is_caught(label):
    old, new = ROUTE_MUTATIONS[label]
    assert API.count(old) == 1, label                                            # an anchor that moved fails HERE
    with pytest.raises((AssertionError, ValueError)):                         # a gate that is gone is a text the check cannot find
        route_checks(API.replace(old, new))
