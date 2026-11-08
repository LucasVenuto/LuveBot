"""K-2 (contract v0.11 section 4): MEASURED on the real Hermes (v0.22.5 and `main`), through the runs route, what a `clarify` control carries and what `skip` does.

One call with three kinds of question (scene `G_CLARIFY_KINDS`: free text, a choice, a multi-select). For each question, in the order Hermes asks them (one control after another):

* (a) the EXACT field names of the control as Hermes's run (`GET /v1/runs/{id}` `pending_controls`) carries it, and as LuveBot shows it (any question id, index or count would show here);
* (b) the answer "skip": what LuveBot's route says (it validates against the choices) and, when it refuses, what Hermes says to the same answer sent straight to its route; and what the BOT receives (the
  `clarify` tool's result in the session: its status field, or a response whose text is skip);
* (c) a skipped question lets the run go on to the next one and complete.
Everything goes to logs/k2-timeline.txt; the test asserts only (c)."""
import json
import sqlite3
import time
import uuid

from test_approvals import settle
from test_bots import post
from test_canonical_main import main  # noqa: F401  (module fixture: skips on a Hermes without the session authority)
from test_hook import session, wait_for
from test_phase4 import HOME
from test_runs import get
from support import STATE, plugin


def note(line):
    print(line)
    try:
        with open(STATE / 'logs' / 'k2-timeline.txt', 'a') as handle:
            handle.write(time.strftime('%H:%M:%S ') + line + '\n')
    except OSError:
        pass


def raw_run(run_id):
    plugin()
    from luvebot_backend.hermes_api import ApiClient
    code, payload = ApiClient('vendas').call('GET', f'/v1/runs/{run_id}', timeout=10)
    assert code == 200, (code, payload)
    return payload


def raw_resolve(run_id, prompt_id, generation, answer):
    from luvebot_backend.hermes_api import ApiClient
    code, body, error = ApiClient('vendas').call_coded('POST', f'/v1/runs/{run_id}/clarify', {'request_id': prompt_id, 'execution_generation': generation, 'answer': answer})
    return code, body, error


def kind_of(control):
    if not control.get('choices'):
        return 'free text'
    return 'multi-select' if control.get('multi_select') else 'choice'


def test_skip_on_each_kind_of_question_lets_the_run_go_on(human_browser, main):
    started = post(human_browser, '/bots/vendas/runs', {'input': f'G_CLARIFY_KINDS: pergunte {uuid.uuid4().hex[:6]}', 'session_id': session(human_browser, 'vendas')})
    assert started.status == 202, started.text()
    run_id = started.json()['run']['id']
    answered, deadline, final, session_id = set(), time.monotonic() + 120, None, None
    while time.monotonic() < deadline:
        payload = raw_run(run_id)
        session_id = payload.get('session_id') or session_id
        if payload.get('status') in ('completed', 'failed', 'cancelled'):
            final = payload['status']
            break
        fresh = [c for c in payload.get('pending_controls') or [] if c.get('kind') == 'clarify' and c.get('prompt_id') not in answered]
        if not fresh:
            time.sleep(0.4)
            continue
        control = fresh[0]
        kind = kind_of(control)
        note(f'K2 {kind}: raw control field names={sorted(control)} run field names around it={sorted(k for k in payload if k != "pending_controls")}')
        luvebot_run = get(human_browser, f'/bots/vendas/runs/{run_id}').json()['run']
        shown = next((c for c in luvebot_run.get('pending_controls') or [] if c.get('request_id') == control.get('prompt_id')), {})
        note(f'K2 {kind}: LuveBot control field names={sorted(shown)}')
        generation = payload.get('execution_generation')
        via = post(human_browser, f'/bots/vendas/runs/{run_id}/clarify', {'request_id': control['prompt_id'], 'execution_generation': generation, 'answer': 'skip'})
        code = (via.json().get('error') or {}).get('code') if via.status >= 400 else via.json().get('clarify', {}).get('status')
        note(f'K2 {kind}: answer "skip" through LuveBot -> {via.status} {code}')
        if via.status != 200:                                              # LuveBot validates against the choices: send the same answer straight to Hermes to see what the Bot would get
            status, body, error = raw_resolve(run_id, control['prompt_id'], generation, 'skip')
            note(f'K2 {kind}: the same answer straight to Hermes -> {status} body={json.dumps(body)[:200] if body is not None else None} error={error}')
        answered.add(control['prompt_id'])
    note(f'K2 the run ended {final} after {len(answered)} skipped question(s)')
    if final is None:
        post(human_browser, f'/bots/vendas/runs/{run_id}/stop', {})
    if session_id:
        conn = sqlite3.connect(f'file:{HOME / "state.db"}?mode=ro', uri=True)
        try:
            for role, tool, content in conn.execute("SELECT role, tool_name, content FROM messages WHERE session_id=? AND role='tool' ORDER BY id", (session_id,)):
                note(f'K2 the Bot received ({tool}): {str(content)[:400]}')
        finally:
            conn.close()
    assert final == 'completed' and len(answered) == 3, (final, len(answered))


import pytest  # noqa: E402


@pytest.mark.parametrize('variant', ['', None, ' ', '   ', '\n', '\t \n'], ids=['empty-string', 'null', 'one-space', 'blank-spaces', 'newline', 'tab-space-newline'])
def test_k2b_an_empty_answer_straight_to_hermes(human_browser, main, variant):
    """K-2b: the three kinds of question, each answered STRAIGHT to Hermes's route with an empty string, null or blank spaces (LuveBot's own route refuses all three): the HTTP answer, the status
    and `user_response` the Bot receives, and whether the run goes on to the next question and completes. A refused answer is followed by a normal one so the run can be observed to the end."""
    started = post(human_browser, '/bots/vendas/runs', {'input': f'G_CLARIFY_KINDS: pergunte {uuid.uuid4().hex[:6]}', 'session_id': session(human_browser, 'vendas')})
    assert started.status == 202, started.text()
    run_id = started.json()['run']['id']
    answered, deadline, final, session_id, label = set(), time.monotonic() + 120, None, None, repr(variant)
    while time.monotonic() < deadline:
        payload = raw_run(run_id)
        session_id = payload.get('session_id') or session_id
        if payload.get('status') in ('completed', 'failed', 'cancelled'):
            final = payload['status']
            break
        fresh = [c for c in payload.get('pending_controls') or [] if c.get('kind') == 'clarify' and c.get('prompt_id') not in answered]
        if not fresh:
            time.sleep(0.4)
            continue
        control = fresh[0]
        kind = kind_of(control)
        status, body, error = raw_resolve(run_id, control['prompt_id'], payload.get('execution_generation'), variant)
        note(f'K2b {label} on a {kind} question, straight to Hermes -> HTTP {status} body={json.dumps(body)[:160] if body is not None else None} error={error}')
        if status != 200:                                                  # refused: still pending; answer normally to see what comes after
            normal = control['choices'][0] if control.get('choices') and not control.get('multi_select') else (json.dumps([control['choices'][0]]) if control.get('choices') else 'ok')
            status2, body2, _ = raw_resolve(run_id, control['prompt_id'], payload.get('execution_generation'), normal)
            note(f'K2b {label} on a {kind} question: a normal answer afterwards -> HTTP {status2}')
        answered.add(control['prompt_id'])
    note(f'K2b {label}: the run ended {final} after {len(answered)} question(s)')
    if final is None:
        post(human_browser, f'/bots/vendas/runs/{run_id}/stop', {})
    if session_id:
        conn = sqlite3.connect(f'file:{HOME / "state.db"}?mode=ro', uri=True)
        try:
            for role, tool, content in conn.execute("SELECT role, tool_name, content FROM messages WHERE session_id=? AND role='tool' ORDER BY id", (session_id,)):
                try:
                    shown = [(r.get('question', '')[:24], r.get('status'), r.get('user_response')) for r in json.loads(content).get('responses', [])]
                except ValueError:
                    shown = str(content)[:200]
                note(f'K2b {label}: the Bot received {shown}')
        finally:
            conn.close()
