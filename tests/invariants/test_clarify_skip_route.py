"""K-2c (contract v0.11 section 4.2): the Skip of a clarify question THROUGH LUVEBOT'S ROUTE against the real Hermes (v0.22.5 and `main`), on the three kinds of question (scene `G_CLARIFY_KINDS`).

* `{request_id, execution_generation, skip: true}` skips THAT question: the Bot receives status `skipped` with `user_response` None, the run goes on to the next question and completes;
* a typed answer of only blanks (or empty) is `422 invalid_answer` on all three kinds and NOTHING reaches Hermes: the control is still pending, the Bot has received no result yet;
* `skip` must be exactly `true` and the body carries no answer key (`"true"`, 1, null, false, an answer next to it: refused, nothing sent);
* a loopback dashboard (a machine, not a person) cannot skip: `403 loopback_not_human`, still pending;
* the audit holds `run.clarify` with `skipped` and no text of any kind."""
import hashlib
import json
import sqlite3
import uuid

import pytest

from test_approvals import settle
from test_bots import DB, audit_rows, error_of, post
from test_canonical_main import main  # noqa: F401  (module fixture: skips on a Hermes without the session authority)
from test_clarify_skip import kind_of, raw_run
from test_hook import loopback_request, run_async, session, wait_for
from test_phase4 import HOME
from test_runs import get
from support import plugin


def start(browser):
    started = post(browser, '/bots/vendas/runs', {'input': f'G_CLARIFY_KINDS: pergunte {uuid.uuid4().hex[:6]}', 'session_id': session(browser, 'vendas')})
    assert started.status == 202, started.text()
    return started.json()['run']['id']


def pending(run_id, after=()):
    """The next clarify control of the run Hermes holds (raw), not yet in `after`; (control, payload) or None."""
    payload = raw_run(run_id)
    fresh = [c for c in payload.get('pending_controls') or [] if c.get('kind') == 'clarify' and c.get('prompt_id') not in after]
    return (fresh[0], payload) if fresh else None


def body_for(control, payload, **fields):
    return {'request_id': control['prompt_id'], 'execution_generation': payload['execution_generation'], **fields}


def tool_results(run_id):
    session_id = raw_run(run_id).get('session_id')
    conn = sqlite3.connect(f'file:{HOME / "state.db"}?mode=ro', uri=True)
    try:
        return [json.loads(c) for (c,) in conn.execute("SELECT content FROM messages WHERE session_id=? AND role='tool' AND tool_name='clarify' ORDER BY id", (session_id,))]
    finally:
        conn.close()


def test_skip_on_each_kind_tells_the_bot_skipped_and_the_run_goes_on(human_browser, main):
    run_id = start(human_browser)
    done, kinds, expected = [], [], []
    for _ in range(3):
        control, payload = wait_for(lambda: pending(run_id, done), 60, 'the next clarify control')
        kinds.append(kind_of(control))
        answer = post(human_browser, f'/bots/vendas/runs/{run_id}/clarify', body_for(control, payload, skip=True))
        assert answer.status == 200 and answer.json()['clarify']['status'] == 'resolved', (kinds[-1], answer.status, answer.text()[:200])
        done.append(control['prompt_id'])
        expected.append(hashlib.sha256(json.dumps({'request_id': control['prompt_id'], 'execution_generation': payload['execution_generation'], 'skipped': True},
                                                  sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest())
    assert kinds == ['free text', 'choice', 'multi-select']
    assert settle(human_browser, run_id)['status'] == 'completed'
    responses = tool_results(run_id)[-1]['responses']
    assert [(r['status'], r['user_response']) for r in responses] == [('skipped', None)] * 3, responses     # told skipped, never answered, never the word
    conn = sqlite3.connect(DB)
    try:
        rows = conn.execute("SELECT outcome, detail, digest FROM audit_log WHERE action='run.clarify' AND target=? ORDER BY id", (run_id,)).fetchall()
    finally:
        conn.close()
    assert [(r[0]) for r in rows] == ['ok', 'ok'] * 3, rows                                                    # intent and result of each of the three skips
    assert [r[2] for r in rows[0::2]] == expected, 'the audit payload of each skip is exactly {request_id, execution_generation, skipped: true}: no text, digest or length of one'


def test_a_blank_typed_answer_is_refused_on_every_kind_and_nothing_reaches_hermes(human_browser, main):
    run_id = start(human_browser)
    done = []
    for _ in range(3):
        control, payload = wait_for(lambda: pending(run_id, done), 60, 'the next clarify control')
        for blank in ('', ' ', '\n', '   \t '):
            refused = post(human_browser, f'/bots/vendas/runs/{run_id}/clarify', body_for(control, payload, answer=blank))
            assert refused.status == 422 and error_of(refused)['code'] == 'invalid_answer', (kind_of(control), repr(blank), refused.status, refused.text()[:160])
        still = pending(run_id, done)
        assert still and still[0]['prompt_id'] == control['prompt_id'], 'the question is still pending: nothing was sent to Hermes'
        assert not tool_results(run_id), 'the Bot has received no result: nothing reached Hermes'
        skipped = post(human_browser, f'/bots/vendas/runs/{run_id}/clarify', body_for(control, payload, skip=True))
        assert skipped.status == 200, skipped.text()
        done.append(control['prompt_id'])
    assert settle(human_browser, run_id)['status'] == 'completed'


def test_skip_is_exactly_true_and_exclusive(human_browser, main):
    run_id = start(human_browser)
    control, payload = wait_for(lambda: pending(run_id), 60, 'a clarify control')
    for label, extra in (('"true"', {'skip': 'true'}), ('1', {'skip': 1}), ('null', {'skip': None}), ('false', {'skip': False}),
                         ('an answer next to it', {'skip': True, 'answer': 'x'}), ('choices next to it', {'skip': True, 'choices': []}), ('nothing', {})):
        refused = post(human_browser, f'/bots/vendas/runs/{run_id}/clarify', body_for(control, payload, **extra))
        assert refused.status in (400, 422), (label, refused.status, refused.text()[:200])
    still = pending(run_id)
    assert still and still[0]['prompt_id'] == control['prompt_id'] and not tool_results(run_id), 'none of them reached Hermes'
    assert post(human_browser, f'/bots/vendas/runs/{run_id}/stop', {}).status in (200, 202, 409)


def test_a_loopback_dashboard_cannot_skip(human_browser, main):
    run_id = start(human_browser)
    control, payload = wait_for(lambda: pending(run_id), 60, 'a clarify control')
    module = plugin()
    path = f'/api/plugins/luvebot/bots/vendas/runs/{run_id}/clarify'
    with pytest.raises(module.PluginError) as refused:
        run_async(module.answer_run_clarify('vendas', run_id, loopback_request(module, 'POST', path, body=json.dumps(body_for(control, payload, skip=True)).encode())))
    assert (refused.value.code, refused.value.status) == ('loopback_not_human', 403)
    still = pending(run_id)
    assert still and still[0]['prompt_id'] == control['prompt_id'] and not tool_results(run_id)
    assert post(human_browser, f'/bots/vendas/runs/{run_id}/stop', {}).status in (200, 202, 409)


def test_the_route_sends_exactly_one_space_to_hermes(human_browser, main):
    """The route's skip, followed all the way to the wire of the real API Server: the body Hermes receives is {request_id, execution_generation, answer: ' '} (one space: not "", not null, not the
    word), captured at the client LuveBot uses and passed on unchanged; Hermes answers resolved and the Bot is told `skipped`."""
    module = plugin()
    from luvebot_backend import canonical
    from luvebot_backend.hermes_api import ApiClient
    run_id = start(human_browser)
    control, payload = wait_for(lambda: pending(run_id), 60, 'a clarify control')
    sent, original = [], ApiClient.call_coded

    def spy(self, method, path, body=None, **kwargs):
        sent.append((method, path, body))
        return original(self, method, path, body, **kwargs)
    ApiClient.call_coded = spy
    try:
        canonical.answer_clarify('vendas', run_id, control['prompt_id'], payload['execution_generation'], None, skip=True)
    finally:
        ApiClient.call_coded = original
    writes = [call for call in sent if call[0] == 'POST']                                          # (the run is read first: a GET)
    assert writes == [('POST', f'/v1/runs/{run_id}/clarify', {'request_id': control['prompt_id'], 'execution_generation': payload['execution_generation'], 'answer': ' '})], sent
    assert writes[0][2]['answer'] == ' ' and len(writes[0][2]['answer']) == 1 and canonical.CLARIFY_SKIP_ANSWER == ' '
    second = wait_for(lambda: pending(run_id, [control['prompt_id']]), 60, 'the next question (the run went on)')
    assert second[0]['prompt_id'] != control['prompt_id']
    post(human_browser, f'/bots/vendas/runs/{run_id}/stop', {})
    del module


def test_the_request_id_of_a_question_is_never_reused(human_browser, main):
    """The Lume's question: the card is keyed by `request_id` (Hermes's `prompt_id`): if one repeated, a new question would inherit a finished card's `Skipped`. Hermes mints it per QUESTION
    (`uuid.uuid4().hex[:10]` in the clarify callback, gateway/run_turn_runner.py: ten random hex digits each time the callback asks), not per call. Measured: three clarify calls one after the
    other in the SAME session (5, 3 and 2 questions: ten questions) and the ids are ten different values of that shape; each question's id is also its own control (one pending at a time)."""
    import re
    sid = session(human_browser, 'vendas')
    seen = []
    for scene, count in (('G_CLARIFY_5', 5), ('G_CLARIFY_KINDS', 3), ('G_CLARIFY_2', 2)):
        started = post(human_browser, '/bots/vendas/runs', {'input': f'{scene}: pergunte {uuid.uuid4().hex[:6]}', 'session_id': sid})
        assert started.status == 202, started.text()
        run_id = started.json()['run']['id']
        done = []
        for _ in range(count):
            control, payload = wait_for(lambda: pending(run_id, done), 60, f'the next question of {scene}')
            done.append(control['prompt_id'])
            seen.append(control['prompt_id'])
            assert post(human_browser, f'/bots/vendas/runs/{run_id}/clarify', body_for(control, payload, skip=True)).status == 200
        assert settle(human_browser, run_id)['status'] == 'completed'
    assert len(seen) == 10 and len(set(seen)) == 10, seen
    assert all(re.fullmatch(r'[0-9a-f]{10}', value) for value in seen), seen
