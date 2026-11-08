"""C3 (plan v0.3 4.3, risk 6): what LuveBot shows and does when the Bot asks MORE THAN ONE question in a single `clarify` call (`questions[]`, up to 5 per call since v0.22.5), on the real
Hermes (v0.22.5 and `main`, which adds the single form `clarify_batch`). Until now only one question at a time was proven.

The Bot asks through the real tool (scenes `G_CLARIFY_2` and `G_CLARIFY_5`); the test records WHAT the run's `pending_controls` carry (how many, which fields) and what answering through
LuveBot's route does, in logs/c3-timeline.txt, and asserts only what must hold on any Hermes: the person is shown at least one question's text (the Bot never waits invisibly), and the run does
not stay waiting forever (answered or stopped, it ends)."""
import json
import time
import uuid

import pytest

from test_approvals import settle
from test_bots import post
from test_canonical_main import main  # noqa: F401  (module fixture: skips on a Hermes without the session authority)
from test_hook import session, wait_for
from test_runs import get
from support import STATE

ANSWER = 'Pode seguir com o que for mais simples'


def note(line):
    print(line)
    try:
        with open(STATE / 'logs' / 'c3-timeline.txt', 'a') as handle:
            handle.write(time.strftime('%H:%M:%S ') + line + '\n')
    except OSError:
        pass


def controls_of(browser, run_id):
    run = get(browser, f'/bots/vendas/runs/{run_id}').json()['run']
    return run, [c for c in run.get('pending_controls') or [] if str(c.get('kind', '')).startswith('clarify')]


QUESTIONS = {2: ('apagar os rascunhos', 'pasta eu salvo'),
             5: ('nome do relatório', 'apagar os rascunhos', 'pasta eu salvo', 'Qual formato', 'Quando eu envio')}


@pytest.mark.parametrize('count', [2, 5])
def test_every_question_of_a_clarify_with_several_is_shown_and_the_run_ends_when_they_are_answered(human_browser, main, count):
    """Measured on both Hermes builds, asserted portably: the person is shown EVERY question's text (one control after another, or all at once: both are fine), each answered through LuveBot's route
    (a listed choice when there are choices, the text otherwise), and the run ends. A question that never reaches the screen, or a run left waiting, is the failure."""
    started = post(human_browser, '/bots/vendas/runs', {'input': f'G_CLARIFY_{count}: pergunte {uuid.uuid4().hex[:6]}', 'session_id': session(human_browser, 'vendas')})
    assert started.status == 202, started.text()
    run_id = started.json()['run']['id']
    answered, seen_texts, rounds, deadline = set(), [], [], time.monotonic() + 120
    final = None
    while time.monotonic() < deadline:
        run, controls = controls_of(human_browser, run_id)
        if run.get('status') in ('completed', 'failed', 'cancelled'):
            final = run['status']
            break
        fresh = [c for c in controls if c.get('request_id') not in answered]
        if not fresh:
            time.sleep(0.5)
            continue
        for control in fresh:
            seen_texts.append(json.dumps(control, ensure_ascii=False))
            choices = control.get('choices') or []
            body = {'request_id': control.get('request_id'), 'execution_generation': run.get('execution_generation'), 'answer': choices[0] if choices else ANSWER}
            answer = post(human_browser, f'/bots/vendas/runs/{run_id}/clarify', body)
            answered.add(control.get('request_id'))
            rounds.append({'kind': control.get('kind'), 'question': str(control.get('question'))[:70], 'choices': len(choices), 'multi_select': control.get('multi_select'),
                           'extra_keys': sorted(set(control) - {'kind', 'request_id', 'question', 'choices', 'multi_select'}), 'status': answer.status})
    for row in rounds:
        note(f'C3 {count}: control {row}')
    shown = [q for q in QUESTIONS[count] if any(q in text for text in seen_texts)]
    note(f'C3 {count}: controls shown={len(rounds)}, questions whose text reached the screen={len(shown)} of {count}, run ended {final}')
    if final is None:
        post(human_browser, f'/bots/vendas/runs/{run_id}/stop', {})
    assert len(shown) == count, (f'only {len(shown)} of the {count} questions reached the person', rounds)
    assert final in ('completed', 'failed', 'cancelled'), f'the run was still waiting 120 s after the answers ({len(rounds)} controls answered)'
