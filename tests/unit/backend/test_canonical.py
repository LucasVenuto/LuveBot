"""F4 (contract v0.9 B): the main's canonical run controls (backend/canonical.py), `call_coded` (backend/hermes_api.py) and the `run.queued`
frame (backend/sse_proxy.py). Hermes is scripted: a FakeApi for the logic, a REAL local HTTP server for the transport (what an error body may
and may not give back). The REAL main runs in the harness (tests/invariants/test_canonical_main.py, not run here: no disk).
Every invariant also runs against variants of canonical.py with one defect each: each must go red."""
import http.server
import importlib
import importlib.util
import itertools
import json
import re
import sys
import threading
import types
import urllib.request
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
ROOT = BACKEND.parent
CANARY = 'sk-CANARYcanon0123456789abcdef'
_n = itertools.count()


def redact(text):
    return text.replace(CANARY, '***')


class HermesError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def load(edit=None, *, port=None):
    """A fresh copy of the backend package with Hermes's two modules stubbed, the REAL hermes_api, canonical and sse_proxy."""
    name = f'canon_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    client = types.ModuleType(f'{name}.hermes_client')
    client.HermesError, client.MAX_RESPONSE_BYTES = HermesError, 1024 * 1024
    client._NoRedirect = type('_NoRedirect', (urllib.request.HTTPRedirectHandler,), {'redirect_request': lambda *a, **k: None})

    class HermesClient:
        def __init__(self, profile):
            self.profile = profile

        def _target(self):
            return port or 1, 'KEY'
    client.HermesClient = HermesClient
    sys.modules[client.__name__] = client
    api = importlib.import_module(f'{name}.hermes_api')
    sse = importlib.import_module(f'{name}.sse_proxy')
    if not edit:
        return importlib.import_module(f'{name}.canonical'), api, sse
    source = (BACKEND / 'canonical.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.canonical', loader=None))
    mod.__package__ = name
    sys.modules[mod.__name__] = mod
    exec(compile(source.replace(*edit), str(BACKEND / 'canonical.py'), 'exec'), mod.__dict__)
    return mod, api, sse


class FakeApi:
    """ApiClient stand-in. `script`: {(method, path): (status, payload, code)}; every POST is recorded in `posts`."""
    script, posts, gets = {}, [], []

    def __init__(self, bot):
        self.bot = bot

    def call_coded(self, method, path, body=None, **kw):
        (self.posts if method == 'POST' else self.gets).append((path, body))
        return self.script[(method, path)]


def arm(mod, run=None, *, post=None, run_id='run1', route='approval'):
    FakeApi.script, FakeApi.posts, FakeApi.gets = {}, [], []
    if run is not None:
        FakeApi.script[('GET', f'/v1/runs/{run_id}')] = run if isinstance(run, tuple) else (200, run, None)
    if post is not None:
        FakeApi.script[('POST', f'/v1/runs/{run_id}/{route}')] = post
    mod.ApiClient = FakeApi
    return FakeApi


def approval_run(**extra):
    return {'status': 'waiting_for_approval', 'execution_generation': 7,
            'pending_controls': [{'kind': 'approval', 'prompt_id': 'req1', 'edit': {'command': CANARY}, 'timeout_s': 30, 'command': CANARY}], **extra}


def clarify_run(choices=(), multi=False, **extra):
    return {'status': 'running', 'execution_generation': 4, 'pending_controls': [
        {'kind': 'clarify', 'prompt_id': 'q1', 'execution_generation': 4, 'question': f'Delete {CANARY}?', 'choices': list(choices),
         'multi_select': multi, 'timeout_s': 90}], **extra}


def fine(call, *args, **kw):
    """A call that must NOT refuse: a defect that makes it raise reads as a failed invariant."""
    try:
        return call(*args, **kw)
    except Exception as error:  # noqa: BLE001
        raise AssertionError(f'refused: {getattr(error, "code", type(error).__name__)}') from None


def refused(mod, call, *args, **kw):
    """-> the PluginError a call raises (code, status), or fails the invariant."""
    try:
        call(*args, **kw)
    except Exception as error:  # noqa: BLE001
        return (getattr(error, 'code', type(error).__name__), getattr(error, 'status', None))
    raise AssertionError('no refusal')


# ---- invariants ---------------------------------------------------------------------------------------------------------------

def inv_the_approval_body_is_three_keys_with_the_generation_read_now(mod, api, sse):
    fake = arm(mod, approval_run(), post=(200, {'status': 'resolved', 'prompt_id': 'req1'}, None))
    assert mod.decide_approval('vendas', 'run1', 'once', 'req1') is True
    assert fake.gets == [('/v1/runs/run1', None)]
    assert fake.posts == [('/v1/runs/run1/approval', {'request_id': 'req1', 'execution_generation': 7, 'choice': 'once'})]
    arm(mod, approval_run(execution_generation=8), post=(200, {'status': 'resolved'}, None))
    mod.decide_approval('vendas', 'run1', 'deny', 'req1')
    assert FakeApi.posts[0][1] == {'request_id': 'req1', 'execution_generation': 8, 'choice': 'deny'}


def inv_only_resolved_is_resolved(mod, api, sse):
    arm(mod, approval_run(), post=(200, {'status': 'already_resolved', 'prompt_id': 'req1'}, None))
    assert mod.decide_approval('vendas', 'run1', 'once', 'req1') is False
    for odd in ({'status': 'whatever'}, {}, {'resolved': 1}):
        arm(mod, approval_run(), post=(200, odd, None))
        assert refused(mod, mod.decide_approval, 'vendas', 'run1', 'once', 'req1')[0] == 'hermes_error'


def inv_it_never_decides_blind(mod, api, sse):
    for run in (approval_run(pending_controls=[]), approval_run(pending_controls=[{'kind': 'approval', 'prompt_id': 'other'}]),
                clarify_run(), {'status': 'running', 'pending_controls': [{'kind': 'approval', 'prompt_id': 'req1'}]}):
        fake = arm(mod, run, post=(200, {'status': 'resolved'}, None))
        assert mod.decide_approval('vendas', 'run1', 'once', 'req1') is False and fake.posts == []
    fake = arm(mod, approval_run(pending_controls=[{'kind': 'clarify', 'prompt_id': 'req1', 'question': 'q'}]), post=(200, {'status': 'resolved'}, None))
    assert mod.decide_approval('vendas', 'run1', 'once', 'req1') is False and fake.posts == []


def inv_stale_and_gone_are_not_pending_and_the_rest_is_unknown(mod, api, sse):
    for status, code in ((409, 'stale_generation'), (409, 'approval_not_pending'), (409, 'not_found'), (404, None)):
        arm(mod, approval_run(), post=(status, None, code))
        assert mod.decide_approval('vendas', 'run1', 'once', 'req1') is False, (status, code)
    for status, code in ((409, 'permission_denied'), (409, 'admission_conflict'), (400, 'invalid_params'), (503, 'runtime_draining'),
                         (503, 'storage_unavailable'), (500, None), (409, None)):
        arm(mod, approval_run(), post=(status, None, code))
        assert refused(mod, mod.decide_approval, 'vendas', 'run1', 'once', 'req1')[0] == 'hermes_error', (status, code)
    for bad in (('maybe', 'run1', 'req1'), ('once', '../x', 'req1'), ('once', 'run1', 'a b')):
        assert refused(mod, mod.decide_approval, 'vendas', bad[1], bad[0], bad[2])[0] == 'ValueError'


def inv_controls_are_a_whitelist_redacted_and_bounded(mod, api, sse):
    items = mod.controls(approval_run())
    assert items == [{'kind': 'approval', 'request_id': 'req1'}]
    assert mod.view(items[0], redact) == {'kind': 'approval', 'request_id': 'req1'}
    long = clarify_run(choices=['a' * 300] + [f'c{i}' for i in range(30)])
    long['pending_controls'][0]['question'] = CANARY + 'q' * 5000
    long['pending_controls'].extend([{'kind': 'weird', 'prompt_id': 'x1'}, {'kind': 'approval', 'prompt_id': 'bad id'}, 'junk',
                                     {'kind': 'clarify', 'prompt_id': 'q2', 'question': 'ok', 'choices': ['y', 3, None], 'timeout_s': True}])
    found = mod.controls(long)
    assert [c['request_id'] for c in found] == ['q1', 'q2']
    first, second = found
    assert second['choices'] == ['y'] and 'timeout_s' not in second
    shown = mod.view(first, redact)
    assert CANARY not in json.dumps(shown) and len(shown['question']) == 2000 and len(shown['choices']) == 20 and len(shown['choices'][0]) == 200
    edge = dict(first, question='q' * 1990 + CANARY + 'tail')                    # a secret that straddles the cut
    assert 'sk-CANARY' not in mod.view(edge, redact)['question']
    assert set(shown) == {'kind', 'request_id', 'question', 'choices', 'multi_select', 'timeout_s'} and shown['timeout_s'] == 90
    extras = mod.run_extras(approval_run(), redact)
    assert extras == {'execution_generation': 7, 'pending_controls': [{'kind': 'approval', 'request_id': 'req1'}]}
    assert mod.run_extras({'status': 'running', 'output': 'x'}, redact) == {}           # a Hermes with no authority adds nothing
    lost = mod.run_extras({'status': 'unknown', 'execution_generation': 2, 'admission_id': 'adm1', 'pending_controls': []}, redact)
    assert lost['resolution'] == {'needed': True, 'admission_id': 'adm1', 'execution_generation': 2}
    assert 'resolution' not in mod.run_extras({'status': 'running', 'execution_generation': 2, 'admission_id': 'adm1'}, redact)


def inv_a_clarify_answer_is_validated_before_hermes(mod, api, sse):
    def answer(run, text):
        fake = arm(mod, run, post=(200, {'status': 'resolved', 'prompt_id': 'q1'}, None), route='clarify')
        mod.answer_clarify('vendas', 'run1', 'q1', 4, text)
        return fake.posts[0][1]
    free = clarify_run()
    assert answer(free, 'sim, pode apagar') == {'request_id': 'q1', 'execution_generation': 4, 'answer': 'sim, pode apagar'}
    one = clarify_run(choices=['Sim', 'Não'])
    assert answer(one, 'Sim')['answer'] == 'Sim'
    many = clarify_run(choices=['a', 'b', 'c'], multi=True)
    assert answer(many, '["a", "c"]')['answer'] == '["a", "c"]' and answer(many, '["a","c"]')['answer'] == '["a", "c"]'
    for run, text in ((free, ''), (free, '   '), (free, 'x' * 16385), (free, 7), (one, 'sim'), (one, 'Sim '), (one, '["Sim"]'),
                      (many, 'a'), (many, '["a","a"]'), (many, '[]'), (many, '["z"]'), (many, '{"a":1}'), (many, '[1]'), (many, 'not json')):
        fake = arm(mod, run, post=(200, {'status': 'resolved'}, None), route='clarify')
        assert refused(mod, mod.answer_clarify, 'vendas', 'run1', 'q1', 4, text) == ('invalid_answer', 422), (text,)
        assert fake.posts == [], text
    assert answer(free, 'x' * 16384)['answer'] == 'x' * 16384


def inv_a_clarify_for_another_moment_is_409_and_asks_nothing(mod, api, sse):
    for run, seen in ((clarify_run(), 3), (clarify_run(pending_controls=[]), 4), (approval_run(), 7), ({'status': 'running'}, 4)):
        fake = arm(mod, run, post=(200, {'status': 'resolved'}, None), route='clarify')
        assert refused(mod, mod.answer_clarify, 'vendas', 'run1', 'q1', seen, 'sim') == ('request_not_pending', 409)
        assert fake.posts == []
    arm(mod, clarify_run(), post=(200, {'status': 'already_resolved'}, None), route='clarify')
    assert refused(mod, mod.answer_clarify, 'vendas', 'run1', 'q1', 4, 'sim') == ('request_not_pending', 409)
    arm(mod, clarify_run(), post=(409, None, 'stale_generation'), route='clarify')
    assert refused(mod, mod.answer_clarify, 'vendas', 'run1', 'q1', 4, 'sim') == ('request_not_pending', 409)
    arm(mod, clarify_run(), post=(503, None, 'runtime_draining'), route='clarify')
    assert refused(mod, mod.answer_clarify, 'vendas', 'run1', 'q1', 4, 'sim') == ('hermes_draining', 503)
    arm(mod, clarify_run(), post=(500, None, None), route='clarify')
    assert refused(mod, mod.answer_clarify, 'vendas', 'run1', 'q1', 4, 'sim')[0] == 'hermes_error'


def inv_the_request_bodies_are_exact(mod, api, sse):
    good = {'request_id': 'q1', 'execution_generation': 4, 'answer': 'x'}
    assert mod.validate_clarify_body(dict(good)) == {**good, 'skip': False}
    for bad in (None, [], {}, {**good, 'extra': 1}, {'request_id': 'q1', 'answer': 'x'}, {**good, 'execution_generation': True},
                {**good, 'execution_generation': -1}, {**good, 'execution_generation': '4'}, {**good, 'request_id': 'a b'}, {**good, 'answer': 5}):
        assert refused(mod, mod.validate_clarify_body, bad)[0] in ('bad_request', 'invalid_field', 'invalid_answer'), bad
    assert mod.validate_unknown_body({'execution_generation': 3}) == {'execution_generation': 3}
    for bad in (None, {}, {'execution_generation': 3, 'admission_id': 'x'}, {'execution_generation': True}, {'execution_generation': -2}):
        assert refused(mod, mod.validate_unknown_body, bad)[0] in ('bad_request', 'invalid_field'), bad


def inv_resolve_unknown_acts_on_what_the_person_saw(mod, api, sse):
    lost = {'status': 'unknown', 'execution_generation': 3, 'admission_id': 'adm1'}
    fake = arm(mod, lost, post=(200, {'run_id': 'run1'}, None), route='resolve-unknown')
    mod.resolve_unknown('vendas', 'run1', 3)
    assert fake.posts == [('/v1/runs/run1/resolve-unknown', {'admission_id': 'adm1', 'execution_generation': 3})]
    for run, seen, want in ((lost, 2, 'stale'), ({**lost, 'status': 'running'}, 3, 'run_not_unknown'), ({'status': 'unknown', 'execution_generation': 3}, 3, 'run_not_unknown'),
                            ({'status': 'unknown', 'admission_id': 'adm1'}, 3, 'run_not_unknown')):
        fake = arm(mod, run, post=(200, {}, None), route='resolve-unknown')
        assert refused(mod, mod.resolve_unknown, 'vendas', 'run1', seen) == (want, 409) and fake.posts == []
    arm(mod, lost, post=(409, None, 'stale_generation'), route='resolve-unknown')
    assert refused(mod, mod.resolve_unknown, 'vendas', 'run1', 3) == ('request_not_pending', 409)
    arm(mod, lost, post=(503, None, 'storage_unavailable'), route='resolve-unknown')
    assert refused(mod, mod.resolve_unknown, 'vendas', 'run1', 3) == ('hermes_busy', 503)
    arm(mod, lost, post=(400, None, 'invalid_params'), route='resolve-unknown')
    assert refused(mod, mod.resolve_unknown, 'vendas', 'run1', 3)[0] == 'hermes_error'
    arm(mod, (404, None, None))
    assert refused(mod, mod.resolve_unknown, 'vendas', 'run1', 3) == ('run_not_found', 404)


def inv_each_refusal_has_its_own_words_by_code(mod, api, sse):
    rows = {(503, 'runtime_draining', 'run'): ('hermes_draining', 503), (503, 'storage_unavailable', 'run'): ('hermes_busy', 503),
            (503, 'chain_moved', 'chat'): ('hermes_busy', 503), (409, 'stale_generation', 'run'): ('request_not_pending', 409),
            (409, 'approval_not_pending', 'run'): ('request_not_pending', 409), (409, 'admission_conflict', 'create'): ('run_conflict', 409),
            (409, 'unknown_execution', 'run'): ('run_unknown', 409), (409, 'permission_denied', 'create'): ('session_other_channel', 409),
            (409, 'permission_denied', 'chat'): ('session_other_channel', 409)}
    for (status, code, surface), (want, http) in rows.items():
        error = mod.refusal(status, code, surface)
        assert (error.code, error.status) == (want, http), (status, code, surface)
        assert error.message and CANARY not in error.message
    assert mod.refusal(409, 'permission_denied', 'create').extra == {'details': {'can_fork': True}}
    for surface in ('create', 'chat', 'run'):                                   # a queue is not a refusal: no error, on any surface
        assert mod.refusal(503, 'admission_queued', surface) is None, surface
    assert mod.refusal(409, 'permission_denied', 'run') is None                # on a run control it means something else: not mapped
    for pair in ((409, None), (503, None), (409, 'runtime_draining'), (503, 'stale_generation'), (500, 'runtime_draining'), (409, 'not_found'),
                 (404, 'stale_generation'), (200, 'stale_generation')):
        assert mod.refusal(*pair, 'run') is None, pair                          # by code AND status: never the status alone


class Index:
    """What `open_turn` needs of RunIndex: the claim is released through here."""

    def __init__(self):
        self.released = []

    def release_message(self, cid):
        self.released.append(cid)


def inv_a_queue_is_a_success_and_keeps_the_claim(mod, api, sse):
    """F4 B-2 (second opinion of the Architect): a queue is never an error envelope and a queued turn is never resent: its client_message_id
    stays claimed (a resend is 409 duplicate), while a refusal or a failure releases it."""
    assert mod.is_queued(503, 'admission_queued') is True
    for pair in ((503, None), (503, 'runtime_draining'), (409, 'admission_queued'), (200, 'admission_queued'), (502, 'admission_queued')):
        assert mod.is_queued(*pair) is False, pair
    body = mod.queued_body()
    assert body == {'queued': True, 'code': 'run_queued', 'message': body['message'], 'run': None} and body['message'] and 'error' not in body
    assert CANARY not in json.dumps(body)

    def fail(status, code):
        return mod.refusal(status, code, 'chat') or RuntimeError('x')
    index = Index()
    assert fine(mod.open_turn, index, 'c1', lambda: (503, None, 'admission_queued'), fail) is None and index.released == []   # queued: kept
    assert fine(mod.open_turn, index, 'c1', lambda: (200, 'STREAM', None), fail) == 'STREAM' and index.released == []          # stream: kept
    assert refused(mod, mod.open_turn, index, 'c2', lambda: (409, None, 'permission_denied'), fail) == ('session_other_channel', 409)
    assert index.released == ['c2']                                                                                              # refused: released
    def broken():
        raise OSError(CANARY)
    assert refused(mod, mod.open_turn, index, 'c3', broken, fail)[0] == 'OSError' and index.released == ['c2', 'c3']             # failed: released
    assert refused(mod, mod.open_turn, index, None, lambda: (500, None, None), fail)[0] == 'RuntimeError' and index.released == ['c2', 'c3']  # no claim: nothing


def inv_resolving_a_lost_run_passes_the_gate_of_a_new_run_first(mod, api, sse):
    """Resolving frees the turns queued behind the lost run: it starts work, so a paused or capped Bot refuses it (409, invariant 7), and
    nothing reaches Hermes before the gate has answered."""
    lost = {'status': 'unknown', 'execution_generation': 3, 'admission_id': 'adm1'}
    order = []
    fake = arm(mod, lost, post=(200, {'run_id': 'run1'}, None), route='resolve-unknown')
    FakeApi.script[('GET', '/v1/runs/run1')] = (200, lost, None)
    real_call = FakeApi.call_coded
    FakeApi.call_coded = lambda self, *a, **k: order.append('hermes') or real_call(self, *a, **k)
    try:
        fine(mod.resolve_unknown, 'vendas', 'run1', 3, gate=lambda: order.append('gate'))
        assert order[0] == 'gate' and order.count('gate') == 1 and fake.posts and order[1:] == ['hermes', 'hermes']
        order.clear()
        FakeApi.posts.clear()
        FakeApi.gets.clear()

        def paused():
            order.append('gate')
            raise mod.PluginError('bot_paused', 'This Bot is paused.', 409)
        assert refused(mod, mod.resolve_unknown, 'vendas', 'run1', 3, gate=paused) == ('bot_paused', 409)
        assert order == ['gate'] and FakeApi.posts == [] and FakeApi.gets == []        # not even the read of the run
        assert refused(mod, mod.resolve_unknown, 'vendas', 'run1', 3, gate=lambda: (_ for _ in ()).throw(mod.PluginError('budget_exceeded', 'cap', 409))) == ('budget_exceeded', 409)
        assert FakeApi.posts == []
    finally:
        FakeApi.call_coded = real_call


def inv_the_flag_is_strict_and_cached(mod, api, sse):
    calls, clock = [], [0.0]

    def reader(features):
        def read(bot):
            calls.append(bot)
            return {'features': features}
        return read
    now = lambda: clock[0]  # noqa: E731
    assert mod.authority('a', reader=reader({'run_unknown_resolution': True}), now=now) is True
    assert mod.authority('a', reader=reader({'run_unknown_resolution': False}), now=now) is True and calls == ['a']  # cached 60 s
    clock[0] += 61
    assert mod.authority('a', reader=reader({'run_unknown_resolution': False}), now=now) is False and calls == ['a', 'a']
    for value in ('true', 1, 'yes', None, [True]):
        assert mod.authority(f'b{value}', reader=reader({'run_unknown_resolution': value}), now=now) is False, value
    assert mod.authority('c', reader=lambda bot: {'features': 'x'}, now=now) is False
    assert mod.authority('d', reader=lambda bot: {}, now=now) is False

    def down(bot):
        raise HermesError('hermes_unreachable')
    asked = []

    def down_counted(bot):
        asked.append(bot)
        return down(bot)
    assert mod.authority('e', reader=down_counted, now=now) is False and asked == ['e']
    assert mod.authority('e', reader=down_counted, now=now) is False and asked == ['e']          # review 2 F8: a down Hermes is asked ONCE, not every turn
    assert mod.authority('e', reader=reader({'run_unknown_resolution': True}), now=now) is False  # the failure is remembered a few seconds
    clock[0] += mod.FAIL_TTL - 0.1
    assert mod.authority('e', reader=reader({'run_unknown_resolution': True}), now=now) is False
    clock[0] += 0.2
    assert mod.authority('e', reader=reader({'run_unknown_resolution': True}), now=now) is True    # and asked again when it is up
    assert 0 < mod.FAIL_TTL <= 10 and mod.FAIL_TTL < mod.FLAG_TTL


class Db:
    def __init__(self, source):
        self.source, self.closed = source, False

    def get_session(self, session_id):
        return None if self.source is None else {'id': session_id, 'source': self.source}

    def close(self):
        self.closed = True


def inv_another_channels_session_is_refused_in_words_only_with_the_flag(mod, api, sse):
    reads = []

    def db_of(source):
        def make(bot):
            reads.append(bot)
            return Db(source)
        return make
    fine(mod.check_session_channel, 'vendas', 's1', db_of=db_of('telegram'), flag=False)
    assert reads == []                                                          # no flag: not even read (v0.22.2 lets you continue it)
    fine(mod.check_session_channel, 'vendas', 's1', db_of=db_of('api_server'), flag=True)
    fine(mod.check_session_channel, 'vendas', 's1', db_of=db_of(None), flag=True)  # unknown: Hermes decides
    fine(mod.check_session_channel, 'vendas', 's1', db_of=lambda bot: (_ for _ in ()).throw(RuntimeError(CANARY)), flag=True)  # unreadable: Hermes decides
    for source in ('telegram', 'cli', 'bot_room', 'tui', 'cron'):               # a copy of Hermes's rule: no special case for a room
        assert refused(mod, mod.check_session_channel, 'vendas', 's1', db_of=db_of(source), flag=True) == ('session_other_channel', 409), source
        try:
            mod.check_session_channel('vendas', 's1', db_of=db_of(source), flag=True)
        except Exception as error:  # noqa: BLE001
            assert error.extra == {'details': {'source': source, 'can_fork': True}}
    try:
        mod.check_session_channel('vendas', 's1', db_of=db_of('Weird Source!'), flag=True)
    except Exception as error:  # noqa: BLE001
        assert error.extra['details']['source'] == 'other'


def inv_a_fork_is_a_whitelist_and_a_clear_refusal(mod, api, sse):
    session = {'session': {'id': 'new1', 'title': 'Copy', 'messages': [CANARY], 'source': 'api_server'}}
    fake = arm(mod, post=None)
    FakeApi.script[('POST', '/api/sessions/old1/fork')] = (201, session, None)
    assert mod.fork('vendas', 'old1', 'Copy') == {'id': 'new1', 'title': 'Copy'}
    assert fake.posts == [('/api/sessions/old1/fork', {'title': 'Copy'})]
    FakeApi.script[('POST', '/api/sessions/old1/fork')] = (200, {'id': 'new2'}, None)
    assert mod.fork('vendas', 'old1', None) == {'id': 'new2', 'title': None} and FakeApi.posts[-1][1] == {}
    for answer, want in (((404, None, None), 'session_not_found'), ((200, {'session': {}}, None), 'hermes_error'), ((500, None, None), 'hermes_error'),
                         ((200, {'session': {'id': 'bad id'}}, None), 'hermes_error'), ((409, None, 'permission_denied'), 'session_other_channel')):
        FakeApi.script[('POST', '/api/sessions/old1/fork')] = answer
        assert refused(mod, mod.fork, 'vendas', 'old1', None)[0] == want, answer
    assert mod.validate_fork_body({}) is None and mod.validate_fork_body({'title': 'Hi'}) == 'Hi'
    for bad in (None, {'title': ''}, {'title': 5}, {'title': 'x' * 201}, {'other': 1}):
        assert refused(mod, mod.validate_fork_body, bad)[0] in ('bad_request', 'invalid_field'), bad


INVARIANTS = {n[4:]: f for n, f in sorted(globals().items()) if n.startswith('inv_')}

MUTATIONS = [
    ('the_approval_body_is_three_keys_with_the_generation_read_now', 'no generation', "{'request_id': request_id, 'execution_generation': gen, 'choice': choice})\n    if status == 200", "{'request_id': request_id, 'choice': choice})\n    if status == 200"),
    ('the_approval_body_is_three_keys_with_the_generation_read_now', 'the old two-key body', "{'request_id': request_id, 'execution_generation': gen, 'choice': choice})\n    if status == 200", "{'choice': choice, 'request_id': request_id})\n    if status == 200"),
    ('the_approval_body_is_three_keys_with_the_generation_read_now', 'a generation that is not the current one', "                                                   {'request_id': request_id, 'execution_generation': gen, 'choice': choice})\n    if status == 200", "                                                   {'request_id': request_id, 'execution_generation': 0, 'choice': choice})\n    if status == 200"),
    ('only_resolved_is_resolved', 'a 200 is a resolution', "        return body['status'] == 'resolved'\n    if status == 404", "        return True\n    if status == 404"),
    ('only_resolved_is_resolved', 'an odd 200 body counts', "body.get('status') in ('resolved', 'already_resolved')", "body is not None"),
    ('it_never_decides_blind', 'the control is not matched', "    if gen is None or not any(c['kind'] == 'approval' and c['request_id'] == request_id for c in controls(payload)):\n        return False\n    status, body, code",
     "    if gen is None:\n        return False\n    status, body, code"),
    ('it_never_decides_blind', 'a clarify counts as the approval', "c['kind'] == 'approval' and c['request_id'] == request_id for c in controls(payload)", "c['request_id'] == request_id for c in controls(payload)"),
    ('stale_and_gone_are_not_pending_and_the_rest_is_unknown', 'a permission_denied is read as gone', "code in ('stale_generation', 'approval_not_pending', 'not_found')", "code in ('stale_generation', 'approval_not_pending', 'not_found', 'permission_denied')"),
    ('stale_and_gone_are_not_pending_and_the_rest_is_unknown', 'any 409 is gone', "(status == 409 and code in ('stale_generation', 'approval_not_pending', 'not_found'))", "status == 409"),
    ('stale_and_gone_are_not_pending_and_the_rest_is_unknown', 'a 503 is gone', "if status == 404 or (status == 409 and code in ('stale_generation', 'approval_not_pending', 'not_found')):\n        return False\n    raise HermesError", "if status in (404, 503) or (status == 409 and code in ('stale_generation', 'approval_not_pending', 'not_found')):\n        return False\n    raise HermesError"),
    ('stale_and_gone_are_not_pending_and_the_rest_is_unknown', 'a choice outside once/deny is sent', "if choice not in ('once', 'deny') or", "if False or"),
    ('controls_are_a_whitelist_redacted_and_bounded', 'an approval item keeps its extras', "        control = {'kind': item['kind'], 'request_id': item['prompt_id']}\n", "        control = {**item, 'kind': item['kind'], 'request_id': item['prompt_id']}\n"),
    ('controls_are_a_whitelist_redacted_and_bounded', 'an unknown kind is kept', "item.get('kind') not in KINDS or", "False or"),
    ('controls_are_a_whitelist_redacted_and_bounded', 'the question is not redacted', "'question': redact(control['question'])[:MAX_QUESTION]", "'question': control['question'][:MAX_QUESTION]"),
    ('controls_are_a_whitelist_redacted_and_bounded', 'it cuts before redacting', "redact(control['question'])[:MAX_QUESTION]", "redact(control['question'][:MAX_QUESTION])"),
    ('controls_are_a_whitelist_redacted_and_bounded', 'the question is not cut', "redact(control['question'])[:MAX_QUESTION]", "redact(control['question'])"),
    ('controls_are_a_whitelist_redacted_and_bounded', 'the choices are not capped', "for c in control['choices'][:MAX_CHOICES]]", "for c in control['choices']]"),
    ('controls_are_a_whitelist_redacted_and_bounded', 'a choice is not cut', "redact(c)[:MAX_CHOICE]", "redact(c)"),
    ('controls_are_a_whitelist_redacted_and_bounded', 'a bool is a timeout', "isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and", "isinstance(timeout, (int, float)) and"),
    ('controls_are_a_whitelist_redacted_and_bounded', 'a run that is not unknown asks to be resolved', "if payload.get('status') == 'unknown' and safe_id(admission) is not None:", "if safe_id(admission) is not None:"),
    ('controls_are_a_whitelist_redacted_and_bounded', 'a Hermes with no generation adds fields', "    if gen is None:\n        return {}\n", ""),
    ('a_clarify_answer_is_validated_before_hermes', 'any answer is accepted', "    if not choices:\n        return answer\n    if control['multi_select']:", "    return answer\n    if control['multi_select']:"),
    ('a_clarify_answer_is_validated_before_hermes', 'a label need not be exact', "    if answer not in choices:\n        raise _invalid()\n    return answer", "    return answer"),
    ('a_clarify_answer_is_validated_before_hermes', 'duplicates in a multi-select', "len(set(map(str, picked))) != len(picked)", "False"),
    ('a_clarify_answer_is_validated_before_hermes', 'no ceiling', "or len(answer) > MAX_ANSWER:", ":"),
    ('a_clarify_answer_is_validated_before_hermes', 'a blank answer', "not answer.strip() or", ""),
    ('a_clarify_answer_is_validated_before_hermes', 'the multi-select is sent as it came', "        return json.dumps(picked, ensure_ascii=False)", "        return answer"),
    ('a_clarify_for_another_moment_is_409_and_asks_nothing', 'a stale generation is answered', "if gen is None or gen != seen_generation or control is None:", "if gen is None or control is None:"),
    ('a_clarify_for_another_moment_is_409_and_asks_nothing', 'no pending clarify needed', "if gen is None or gen != seen_generation or control is None:", "if gen is None or gen != seen_generation:"),
    ('a_clarify_for_another_moment_is_409_and_asks_nothing', 'already resolved counts as sent', "    if status == 200 and isinstance(body, dict) and body.get('status') == 'already_resolved':\n        raise PluginError('request_not_pending', _MESSAGES['request_not_pending'], 409)\n", ""),
    ('the_request_bodies_are_exact', 'extra keys are fine', "{'answer'} == set(body) - {'request_id', 'execution_generation'} or 'skip' in body", "'answer' in set(body) or 'skip' in body"),
    ('the_request_bodies_are_exact', 'a bool is a generation', "type(body['execution_generation']) is not int or body['execution_generation'] < 0:\n        raise PluginError('invalid_field', 'Invalid request_id", "not isinstance(body['execution_generation'], int) or body['execution_generation'] < 0:\n        raise PluginError('invalid_field', 'Invalid request_id"),
    ('the_request_bodies_are_exact', 'the unknown body takes an admission id', "set(body) != {'execution_generation'}", "not set(body) >= {'execution_generation'}"),
    ('resolve_unknown_acts_on_what_the_person_saw', 'a changed generation is accepted', "    if gen != seen_generation:\n        raise PluginError('stale'", "    if False:\n        raise PluginError('stale'"),
    ('resolve_unknown_acts_on_what_the_person_saw', 'a run that is not unknown is resolved', "if payload.get('status') != 'unknown' or gen is None", "if gen is None"),
    ('resolve_unknown_acts_on_what_the_person_saw', 'the admission id comes from the browser', "{'admission_id': admission,", "{'admission_id': str(seen_generation),"),
    ('each_refusal_has_its_own_words_by_code', 'permission_denied everywhere', "    if surface in ('create', 'chat'):\n        table[(409, 'permission_denied')]", "    if True:\n        table[(409, 'permission_denied')]"),
    ('each_refusal_has_its_own_words_by_code', 'by status only', "    found = table.get((status, code))", "    found = table.get((status, code)) or next((v for (s, _c), v in table.items() if s == status), None)"),
    ('each_refusal_has_its_own_words_by_code', 'a queue is an error again', "(409, 'unknown_execution'): ('run_unknown', 409)}", "(409, 'unknown_execution'): ('run_unknown', 409), (503, 'admission_queued'): ('run_queued', 202)}"),
    ('a_queue_is_a_success_and_keeps_the_claim', 'any 503 is a queue', "return status == 503 and code == 'admission_queued'", "return status == 503"),
    ('a_queue_is_a_success_and_keeps_the_claim', 'the body says it was not queued', "{'queued': True, 'code': 'run_queued'", "{'queued': False, 'code': 'run_queued'"),
    ('a_queue_is_a_success_and_keeps_the_claim', 'the body carries a run', "_MESSAGES['run_queued'], 'run': None}", "_MESSAGES['run_queued'], 'run': {}}"),
    ('a_queue_is_a_success_and_keeps_the_claim', 'the body is an error envelope', "{'queued': True, 'code': 'run_queued'", "{'error': {'code': 'run_queued'}, 'queued': True, 'code': 'run_queued'"),
    ('a_queue_is_a_success_and_keeps_the_claim', 'a queue releases the claim', "        if stream is None and is_queued(status, code):\n            return None\n", ""),
    ('a_queue_is_a_success_and_keeps_the_claim', 'a refusal keeps the claim', "        if cid:\n            index.release_message(cid)\n        raise", "        raise"),
    ('a_queue_is_a_success_and_keeps_the_claim', 'a release without a claim', "        if cid:\n            index.release_message(cid)", "        if True:\n            index.release_message(cid)"),
    ('each_refusal_has_its_own_words_by_code', 'no way out offered', "extra = {'details': {'can_fork': True}} if found[0] == 'session_other_channel' else None", "extra = None"),
    ('resolving_a_lost_run_passes_the_gate_of_a_new_run_first', 'the gate is never called', "    if gate is not None:\n        gate()\n    payload = read_run(bot, run_id)", "    payload = read_run(bot, run_id)"),
    ('resolving_a_lost_run_passes_the_gate_of_a_new_run_first', 'the gate comes after Hermes was read', "    if gate is not None:\n        gate()\n    payload = read_run(bot, run_id)", "    payload = read_run(bot, run_id)\n    if gate is not None:\n        gate()"),
    ('resolving_a_lost_run_passes_the_gate_of_a_new_run_first', 'a refusal of the gate is swallowed', "    if gate is not None:\n        gate()\n    payload = read_run(bot, run_id)", "    if gate is not None:\n        try:\n            gate()\n        except Exception:\n            pass\n    payload = read_run(bot, run_id)"),
    ('the_flag_is_strict_and_cached', 'any truthy value turns it on', "value = isinstance(features, dict) and features.get(FLAG) is True", "value = bool(isinstance(features, dict) and features.get(FLAG))"),
    ('the_flag_is_strict_and_cached', 'never cached', "        _flag[bot] = (now(), value, FLAG_TTL)\n", "        pass\n"),
    ('the_flag_is_strict_and_cached', 'a failure is not remembered', "            _flag[bot] = (now(), False, FAIL_TTL)   # the failure too, for a few seconds: a down Hermes is asked once, not on every turn\n", "            pass\n"),
    ('the_flag_is_strict_and_cached', 'a failure is remembered as long as a success', "(now(), False, FAIL_TTL)", "(now(), False, FLAG_TTL)"),
    ('the_flag_is_strict_and_cached', 'a failure counts as the flag', "        return False\n    with _lock:\n        _flag[bot] = (now(), value, FLAG_TTL)", "        return True\n    with _lock:\n        _flag[bot] = (now(), value, FLAG_TTL)"),
    ('another_channels_session_is_refused_in_words_only_with_the_flag', 'refused without the flag', "    if not (flag if flag is not None else authority(bot)):\n        return\n", ""),
    ('another_channels_session_is_refused_in_words_only_with_the_flag', 'rooms are let through', "if source is not None and source != 'api_server':", "if source is not None and source not in ('api_server', 'bot_room'):"),
    ('another_channels_session_is_refused_in_words_only_with_the_flag', 'no way out offered', "'can_fork': True}})\n\n\ndef validate_fork_body", "'can_fork': False}})\n\n\ndef validate_fork_body"),
    ('a_fork_is_a_whitelist_and_a_clear_refusal', 'the whole session comes back', "    return {'id': new_id, 'title': _text(session.get('title'), 200)}", "    return {**session, 'id': new_id}"),
    ('a_fork_is_a_whitelist_and_a_clear_refusal', 'an invalid id is accepted', "    new_id = safe_id(session.get('id') or session.get('session_id'))\n    if new_id is None:\n        raise HermesError('hermes_error')", "    new_id = session.get('id') or session.get('session_id') or 'x'"),
    ('a_fork_is_a_whitelist_and_a_clear_refusal', 'a missing session is a generic error', "    if status == 404:\n        raise PluginError('session_not_found', 'Session not found.', 404)\n    if status not in (200, 201)", "    if status not in (200, 201)"),
]


@pytest.fixture(scope='module')
def real():
    return load()


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(real, name):
    INVARIANTS[name](*real)


def test_every_invariant_has_a_mutation():
    assert {inv for inv, *_ in MUTATIONS} == set(INVARIANTS)


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(invariant, label, old, new):
    mod, api, sse = load((old, new))               # outside pytest.raises: a mutation that does not apply is an error
    with pytest.raises(AssertionError):
        INVARIANTS[invariant](mod, api, sse)


# ---- the transport: what an error body may give back (B-9), over a REAL local HTTP server -----------------------------------------------

class Hermes:
    """A local server standing in for `/p/<profile>/...`: `answers` {(method, path): (status, body bytes, content type)}; every request is kept."""

    def __init__(self, answers):
        self.answers, self.seen = answers, []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def _serve(self):
                size = int(self.headers.get('Content-Length') or 0)
                owner.seen.append((self.command, self.path, json.loads(self.rfile.read(size) or b'null'), self.headers.get('Authorization')))
                status, body, kind = owner.answers[(self.command, self.path)]
                self.send_response(status)
                self.send_header('Content-Type', kind)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            do_GET = do_POST = _serve

            def log_message(self, *args):
                pass
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def error_body(code, message=f'secret text {CANARY}'):
    return json.dumps({'error': {'message': message, 'type': 'x', 'code': code}}).encode(), 'application/json'


@pytest.fixture
def hermes():
    started = []

    def start(answers):
        server = Hermes(answers)
        started.append(server)
        return server
    yield start
    for server in started:
        server.close()


def test_call_coded_returns_only_a_code_from_the_closed_list(hermes):
    answers = {('POST', '/p/vendas/v1/runs/r/approval'): (409, *error_body('stale_generation')),
               ('POST', '/p/vendas/v1/runs/r/clarify'): (409, *error_body('something_new')),
               ('POST', '/p/vendas/v1/runs/r/resolve-unknown'): (503, b'x' * 9000 + error_body('runtime_draining')[0], 'application/json'),
               ('POST', '/p/vendas/v1/runs/r/stop'): (500, b'<html>nope</html>', 'text/html'),
               ('POST', '/p/vendas/v1/runs/r/steer'): (409, json.dumps({'error': {'code': ['stale_generation']}}).encode(), 'application/json'),
               ('GET', '/p/vendas/v1/runs/r'): (200, json.dumps({'status': 'running', 'execution_generation': 1}).encode(), 'application/json')}
    server = hermes(answers)
    mod, api, sse = load(port=server.port)
    client = api.ApiClient('vendas')
    status, payload, code = client.call_coded('POST', '/v1/runs/r/approval', {'a': 1})
    assert (status, payload, code) == (409, None, 'stale_generation')
    assert client.call_coded('POST', '/v1/runs/r/clarify', {}) == (409, None, None)
    assert client.call_coded('POST', '/v1/runs/r/resolve-unknown', {}) == (503, None, None)          # the code sits past the first 4 KB: not read
    assert client.call_coded('POST', '/v1/runs/r/stop', {}) == (500, None, None)
    assert client.call_coded('POST', '/v1/runs/r/steer', {}) == (409, None, None)
    assert client.call_coded('GET', '/v1/runs/r') == (200, {'status': 'running', 'execution_generation': 1}, None)
    assert all(auth == 'Bearer KEY' for *_x, auth in server.seen)
    assert server.seen[0][2] == {'a': 1}


def test_the_old_signatures_are_unchanged_and_never_read_a_body(hermes):
    server = hermes({('POST', '/p/vendas/v1/runs/r/approval'): (409, *error_body('stale_generation')),
                     ('GET', '/p/vendas/v1/runs/r'): (200, b'{"status": "running"}', 'application/json'),
                     ('POST', '/p/vendas/api/sessions/s/chat/stream'): (409, *error_body('permission_denied'))})
    mod, api, sse = load(port=server.port)
    client = api.ApiClient('vendas')
    assert client.call('POST', '/v1/runs/r/approval', {}) == (409, None)
    assert client.call('GET', '/v1/runs/r') == (200, {'status': 'running'})
    assert client.open_stream('POST', '/api/sessions/s/chat/stream', {}) == (409, None)
    assert client.open_stream('POST', '/api/sessions/s/chat/stream', {}, coded=True) == (409, None, 'permission_denied')


def test_an_error_text_never_reaches_a_caller(hermes):
    server = hermes({('GET', '/p/vendas/v1/runs/run1'): (500, *error_body('storage_unavailable', f'Bearer {CANARY}'))})
    mod, api, sse = load(port=server.port)
    mod.ApiClient = api.ApiClient
    with pytest.raises(Exception) as error:
        mod.read_run('vendas', 'run1')
    assert CANARY not in repr(error.value) and CANARY not in str(error.value.args)


# ---- the run.queued frame (B-2): the text is ours ------------------------------------------------------------------------------------------

def test_run_queued_is_our_frame_never_hermes_text():
    mod, api, sse = load()
    event, data = sse.transform('run', 'run.queued', {'run_id': 'r1', 'status': 'queued', 'message': f'Hermes says {CANARY}: resubmit later', 'x': 1}, redact)
    assert event == 'run.queued' and data == {'status': 'queued', 'code': 'run_queued', 'message': sse.RUN_QUEUED, 'run_id': 'r1'}
    assert sse.transform('run', 'run.queued', {'run_id': 'x' * 200}, redact)[1] == {'status': 'queued', 'code': 'run_queued', 'message': sse.RUN_QUEUED}
    assert sse.transform('chat', 'run.queued', {'run_id': 'r1'}, redact) is None and 'run.queued' not in sse.TERMINAL


def test_run_queued_mutations():
    source = (BACKEND / 'sse_proxy.py').read_text()
    for old, new in (("'message': RUN_QUEUED,", "'message': data.get('message'),"), ("'run.cancelled', 'run.queued'}", "'run.cancelled'}"),
                     ("    if event == 'run.queued':\n", "    if False:\n")):
        assert source.count(old) == 1, old
        variant = types.ModuleType('sse_variant')
        exec(compile(source.replace(old, new), 'sse_variant', 'exec'), variant.__dict__)
        with pytest.raises(Exception):
            event, data = variant.transform('run', 'run.queued', {'run_id': 'r1', 'message': CANARY}, redact)
            assert data == {'status': 'queued', 'code': 'run_queued', 'message': variant.RUN_QUEUED, 'run_id': 'r1'}


# ---- the old format is untouched without the flag, and nothing answers on its own (invariants 6 and 9) ---------------------------------------------

def test_approvals_native_decide_keeps_the_old_format_without_the_flag_and_goes_canonical_with_it():
    name = f'canon_native_{next(_n)}'
    mod, api, sse = load()
    package = sys.modules[mod.__name__.rsplit('.', 1)[0]]
    native = importlib.import_module(package.__name__ + '.approvals_native')
    seen = []

    class Old:
        def __init__(self, bot):
            pass

        def call(self, method, path, body=None, **kw):
            seen.append((method, path, body))
            return 200, {'resolved': 1},
    Old.call = lambda self, method, path, body=None, **kw: (seen.append((method, path, body)) or (200, {'resolved': 1}))
    native.ApiClient = Old
    native.canonical.authority = lambda bot: False
    assert native.decide('vendas', 'run1', 'once', 'req1') is True
    assert seen == [('POST', '/v1/runs/run1/approval', {'choice': 'once', 'request_id': 'req1'})]       # the old two-key body, byte for byte
    flag = []
    native.canonical.authority = lambda bot: True
    native.canonical.decide_approval = lambda *args: flag.append(args) or False
    assert native.decide('vendas', 'run1', 'deny', 'req1') is False and flag == [('vendas', 'run1', 'deny', 'req1')] and len(seen) == 1
    assert name


def FORK_HUMAN_WIRING(fork):
    """F1: the fork ENDS another channel's conversation, so it is a person's action: `_human` (login, CSRF, 403 in loopback), the person's
    id in the audit, and no `_identity` path that would let the loopback machine token through."""
    return ('human = _human(request)' in fork and 'audit.act, human.id' in fork and "'session.fork'" in fork
            and '_identity(' not in fork and '_require_csrf(' not in fork)


def test_only_a_person_reaches_the_controls_that_answer_the_bot():
    """Invariant 6: resolve-unknown and clarify are human routes (`_human`: login, CSRF, 403 in loopback); the canonical approval is reached
    only through approvals.resolve (via approvals_native.decide); fork needs a click (CSRF) and nothing in the backend calls it."""
    api = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    for route in ('resolve_unknown_run', 'answer_run_clarify'):
        body = api.split(f'async def {route}(', 1)[1].split('\n@router.', 1)[0]
        assert 'human = _human(request)' in body and 'audit.act, human.id' in body, route
    fork = api.split('async def fork_session(', 1)[1].split('\n@router.', 1)[0]
    assert FORK_HUMAN_WIRING(fork)
    users = {p.name for p in BACKEND.glob('*.py') if re.search(r'canonical\.(answer_clarify|resolve_unknown|fork)\(', p.read_text())}
    assert users == set(), users
    assert len(re.findall(r'canonical\.decide_approval\(', (BACKEND / 'approvals_native.py').read_text())) == 1
    assert len(re.findall(r'canonical\.answer_clarify\(', api)) == 1 and len(re.findall(r'canonical\.resolve_unknown\(', api)) == 1
    assert len(re.findall(r'canonical\.fork\(', api)) == 1 and 'canonical.decide_approval' not in api


def test_the_answer_to_a_clarify_is_audited_as_a_digest_and_a_length_only():
    api = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    body = api.split('async def answer_run_clarify(', 1)[1].split('\n@router.', 1)[0]
    typed = body.split('    else:\n', 1)[1].split('await run_in_threadpool(audit.act', 1)[0]
    assert "'answer_hmac': digest" in typed and "'answer_len': len(fields['answer'])" in typed
    assert not re.search(r"\{[^}]*fields\['answer'\][^}]*\}", typed.replace("len(fields['answer'])", ''))
    skipped = body.split("if fields['skip']:", 1)[1].split('    else:\n', 1)[0]
    assert "'skipped': True" in skipped and 'answer' not in skipped.replace('# a skip is a click: the audit says so, with no text, no digest and no length (there is none)', '')   # a skip has no text, no digest and no length
    assert 'keyed_digest' in body


def test_the_refusal_mappings_are_wired_where_the_contract_says():
    api = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    assert "canonical.refusal(status, code, 'create')" in api and "canonical.refusal(status, code, 'chat')" in api
    assert api.count("canonical.refusal(status, code, 'run')") == 1                       # the stop route
    assert 'canonical.check_session_channel, name, session_id' in api and 'coded=True' in api
    assert api.count('canonical.is_queued(status, code)') == 2 and api.count('canonical.queued_body()') == 3     # create run and the skill-draft turn (v0.11 3.2, the same send); the chat turn (via open_turn)
    route = api.split('async def resolve_unknown_run(', 1)[1].split('\n@router.', 1)[0]
    assert "gate=lambda: budget_gate(budget, meta.path, name)" in route and 'Budget, meta.path, audit=audit' in route.replace('(Budget, ', '(Budget, ') or 'run_in_threadpool(Budget, meta.path, audit=audit)' in route
    assert 'canonical.open_turn(' in api and 'raise canonical.refusal(status, code, \'create\')' in api
    assert 'index.release_message' not in api.split('async def _chat_turn(', 1)[1].split('\n@router.', 1)[0]      # only open_turn releases the claim
    assert 'run.update(canonical.run_extras(payload, _REDACT))' in api


def test_fork_without_a_person_is_caught_by_the_wiring_check():
    """Mutation of F1: the pre-fix body (an `_identity` with CSRF, no `_human`) must fail the check; so must dropping the person from the audit."""
    api = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    fork = api.split('async def fork_session(', 1)[1].split('\n@router.', 1)[0]
    assert FORK_HUMAN_WIRING(fork)
    old = fork.replace('    human = _human(request)', '    actor, credential, _mode = _identity(request)\n    _require_csrf(request, credential)').replace('audit.act, human.id', 'audit.act, actor')
    assert not FORK_HUMAN_WIRING(old)
    assert not FORK_HUMAN_WIRING(fork.replace('audit.act, human.id', 'audit.act, "dashboard"'))
