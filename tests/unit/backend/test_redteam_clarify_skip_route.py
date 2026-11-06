"""Red team (Lume, K-1 and K-3b attacked, 30/10): the REAL route `answer_run_clarify` of dashboard/plugin_api.py run with the harness of test_redteam_deployment_token.py (every function taken from the source and
executed with stand-ins), and the REAL `validate_clarify_body` of backend/canonical.py. What is checked is the ROUTE, which the pure tests of test_redteam_clarify_skip.py cannot see:
  * a person's skip reaches `answer_clarify` as `skip=True` with no answer, and its audit payload is exactly `{request_id, execution_generation, skipped: true}`: no digest, no length, no text; an answer's payload
    has the digest and the length and no `skipped`;
  * every body that is not exactly an answer or exactly a skip (the 30 hostile ones of the pure tests, malformed JSON, a body over the limit, a repeated key) is refused BEFORE anything is audited or sent;
  * the gate is the first line: the deployment token, the loopback token and a request with no CSRF are refused without their body being read;
  * the intent row is written before Hermes is asked (the audit's own contract), and a refusal by Hermes leaves the intent and the error."""
import ast
import json
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_redteam_deployment_token as dt  # noqa: E402
import test_redteam_clarify_skip as pure  # noqa: E402

CANONICAL = dt.ROOT / 'backend' / 'canonical.py'
OK_SKIP = {'request_id': 'q1', 'execution_generation': 3, 'skip': True}
OK_ANSWER = {'request_id': 'q1', 'execution_generation': 3, 'answer': 'sim'}


def real_validate():
    sent = []
    ns = pure.load(sent)
    ns['PluginError'] = dt.PluginError                                                      # one error class for the route and the validator, so the route's refusals are seen as what they are
    return ns['validate_clarify_body']


class Audit:
    def __init__(self, fail=None):
        self.rows, self.order, self.fail = [], [], fail

    def act(self, actor, action, target, origin, fn, *, bot=None, payload=None):
        self.rows.append(('intent', actor, action, target, origin, bot, payload))
        self.order.append('intent')
        try:
            result = fn()
        except Exception:
            self.rows.append(('result', 'error'))
            raise
        self.rows.append(('result', 'ok'))
        return result


def route(identity_name, raw_body, audit, calls, monkeypatch, csrf=True):
    """-> what the real route answered (a PluginError code or 'passed'), the calls it made to answer_clarify, and whether the body was ever read."""
    monkeypatch.delenv(dt.ENV, raising=False)
    ns = dt.build()
    dt.reset()
    read = []

    def answer_clarify(bot, run_id, request_id, generation, answer, *, skip=False):
        calls.append({'request_id': request_id, 'generation': generation, 'answer': answer, 'skip': skip})
        audit.order.append('hermes')
        if audit.fail:
            raise dt.PluginError(audit.fail, 'x', 409)

    async def owned(bot, run_id, index):
        return bot

    async def noop(*a, **k):
        return None
    real_json_body(ns)
    ns.update({'canonical': types.SimpleNamespace(MAX_ANSWER=16384, validate_clarify_body=real_validate(), answer_clarify=answer_clarify),
               '_owned_run': owned, '_require_feature': noop, '_need_authority': noop, '_stores': lambda: (audit, Permissive_meta()),
               'RunIndex': lambda path: types.SimpleNamespace(keyed_digest=lambda raw: 'hmac-of-' + str(len(raw))), 'JSONResponse': lambda content, status_code=200, headers=None: content,
               '_HEADERS': {}})
    req = {'loopback': dt.LOOPBACK, 'person': lambda: dt.gated(dt.PERSON()), 'deployment': lambda: dt.gated(dt.DEPLOYMENT())}[identity_name]()
    if not csrf:
        req.headers['x-luvebot-csrf'] = 'wrong'

    async def body():
        read.append(True)
        return raw_body if isinstance(raw_body, bytes) else json.dumps(raw_body).encode()
    req.body = body
    out = []
    try:
        answer = dt.asyncio.run(ns['answer_run_clarify']('vendas', 'run1', req))
        out.append(answer)
        code = 'passed'
    except dt.PluginError as error:
        code = error.code
    return code, out, bool(read)


def real_json_body(ns):
    """The route's `_json_body` is the REAL one (the size limit and the parse), not the harness's empty stand-in."""
    tree = dt.TREE
    limit = next(eval(compile(ast.Expression(n.value), 'plugin_api', 'eval'), {}) for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'MAX_BODY' for t in n.targets))     # `64 * 1024`
    node = next(n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == '_json_body')
    ns['MAX_BODY'] = limit
    ns['json'] = json
    exec(compile(ast.Module([node], []), 'plugin_api', 'exec'), ns)


def Permissive_meta():
    return types.SimpleNamespace(path='db')


# ======================================================================== the two good bodies ============================================================================
def test_a_skip_reaches_answer_clarify_as_skip_with_no_answer_and_its_audit_has_no_text_digest_or_length(monkeypatch):
    audit, calls = Audit(), []
    code, out, _ = route('person', OK_SKIP, audit, calls, monkeypatch)
    assert code == 'passed' and out == [{'clarify': {'request_id': 'q1', 'status': 'resolved'}}]
    assert calls == [{'request_id': 'q1', 'generation': 3, 'answer': None, 'skip': True}]
    intent = audit.rows[0]
    assert intent[2] == 'run.clarify' and intent[6] == {'request_id': 'q1', 'execution_generation': 3, 'skipped': True}
    assert audit.order == ['intent', 'hermes']                                              # the intent is committed before Hermes is asked


def test_an_answer_keeps_its_digest_and_length_and_never_says_skipped(monkeypatch):
    audit, calls = Audit(), []
    code, _out, _ = route('person', OK_ANSWER, audit, calls, monkeypatch)
    assert code == 'passed' and calls == [{'request_id': 'q1', 'generation': 3, 'answer': 'sim', 'skip': False}]
    assert audit.rows[0][6] == {'request_id': 'q1', 'execution_generation': 3, 'answer_hmac': 'hmac-of-3', 'answer_len': 3}


def test_a_refusal_by_hermes_leaves_the_intent_and_the_error_and_nothing_claims_success(monkeypatch):
    audit, calls = Audit(fail='request_not_pending'), []
    code, out, _ = route('person', OK_SKIP, audit, calls, monkeypatch)
    assert code == 'request_not_pending' and out == []
    assert [r[0] for r in audit.rows] == ['intent', 'result'] and audit.rows[-1] == ('result', 'error')


# ======================================================================== hostile bodies: refused before anything happens =============================================
@pytest.mark.parametrize('label', sorted(pure.HOSTILE_SKIP_BODIES))
def test_a_hostile_body_is_refused_before_the_audit_and_before_hermes(label, monkeypatch):
    audit, calls = Audit(), []
    code, _out, _ = route('person', pure.HOSTILE_SKIP_BODIES[label], audit, calls, monkeypatch)
    assert code in ('bad_request', 'invalid_field', 'invalid_answer'), (label, code)
    assert audit.rows == [] and calls == [], 'nothing audited and nothing sent'


@pytest.mark.parametrize('raw', [b'', b'{', b'not json', b'[]', b'null', b'"skip"', b'true', b'{"request_id":"q1","execution_generation":3,"skip":true,"skip":false}',
                                 b'{"request_id":"q1","execution_generation":3,"skip":true,"answer":"x","answer":""}', b'{"request_id":"q1","execution_generation":3,"skip":"true"}',
                                 b'{"request_id":"q1","execution_generation":3,"skip":1}', b'{"request_id":"q1","execution_generation":3,"skip":true,"profile":"x"}'])
def test_malformed_json_or_a_repeated_key_is_refused_without_an_audit_row(raw, monkeypatch):
    audit, calls = Audit(), []
    code, _out, _ = route('person', raw, audit, calls, monkeypatch)
    assert code in ('bad_request', 'invalid_field', 'invalid_answer'), (raw, code)
    assert audit.rows == [] and calls == []


def test_a_body_over_the_limit_is_413_before_it_is_parsed(monkeypatch):
    audit, calls = Audit(), []
    huge = b'{"request_id":"q1","execution_generation":3,"answer":"' + b'x' * (16384 * 6 + 5000) + b'"}'
    code, _out, _ = route('person', huge, audit, calls, monkeypatch)
    assert code == 'too_large' and audit.rows == [] and calls == []


def test_a_json_true_in_other_spellings_is_not_the_boolean_true_unless_it_is_exactly_that(monkeypatch):
    for text, accepted in ((b'true', True), (b'1', False), (b'1.0', False), (b'"true"', False), (b'[true]', False), (b'null', False), (b'false', False), (b'0', False)):
        audit, calls = Audit(), []
        raw = b'{"request_id":"q1","execution_generation":3,"skip":' + text + b'}'
        code, _out, _ = route('person', raw, audit, calls, monkeypatch)
        assert (code == 'passed') is accepted, (text, code)
        assert bool(calls) is accepted


# ======================================================================== the gate comes first ===========================================================================
@pytest.mark.parametrize('identity_name,expected', [('deployment', 'credential_not_human'), ('loopback', 'loopback_not_human')])
def test_the_machine_is_refused_at_the_first_line_and_its_body_is_never_read(identity_name, expected, monkeypatch):
    for body in (OK_SKIP, OK_ANSWER, pure.HOSTILE_SKIP_BODIES['skip with an answer']):
        audit, calls = Audit(), []
        code, _out, read = route(identity_name, body, audit, calls, monkeypatch)
        assert code == expected and not read and audit.rows == [] and calls == []


def test_a_wrong_csrf_is_refused_without_reading_the_body(monkeypatch):
    audit, calls = Audit(), []
    code, _out, read = route('person', OK_SKIP, audit, calls, monkeypatch, csrf=False)
    assert code == 'csrf_required' and not read and audit.rows == [] and calls == []


def test_the_opt_in_opens_loopback_for_a_skip_as_for_an_answer_and_never_the_deployment_token(monkeypatch):
    audit, calls = Audit(), []
    route('loopback', OK_SKIP, audit, calls, monkeypatch)
    assert calls == []                                                                      # no opt-in: refused
    monkeypatch.setenv(dt.ENV, '1')
    ns = dt.build()
    dt.reset()
    # the same route with the opt-in: loopback passes the gate; the deployment credential still does not
    audit2, calls2 = Audit(), []
    for who, expected in (('loopback', 'passed'), ('deployment', 'credential_not_human')):
        monkeypatch.setenv(dt.ENV, '1')
        code = route_with_env(who, OK_SKIP, Audit(), [], monkeypatch)
        assert code == expected, (who, code)
    assert ns and audit2 and calls2 == []


def route_with_env(identity_name, raw_body, audit, calls, monkeypatch):
    """`route` without clearing the opt-in variable."""
    real = monkeypatch.delenv
    monkeypatch.delenv = lambda *a, **k: None
    try:
        return route(identity_name, raw_body, audit, calls, monkeypatch)[0]
    finally:
        monkeypatch.delenv = real
