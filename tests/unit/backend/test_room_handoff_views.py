"""A room is "working" only while a member's turn is live, and a handoff shows the title of its Kanban task.
Hermes's room status (tui_gateway/hosted_room_service.py status, f8489405): `running` is the driver thread being alive, true for as
long as the room exists; `working` is any task queued, running or stopping. The handoff row keeps only the title's sha256; the title
is read from the task, as the board and Activity already show it."""
import inspect

import pytest

from backend import handoffs, rooms

KEY = 'sk-' + 'c0ffee12ab34' * 3


def same(text):
    return text


def redact(text):
    return text.replace(KEY, 'sk-***')


ROW = {'id': 'ho-1', 'from_bot': 'dev', 'to_bot': 'vendas', 'task_id': 't_1', 'room_id': 'room-1', 'source': 'ui', 'effect': 'allow',
       'state': 'open', 'needs_review': 0, 'created_at': 1.0}


def test_idle_room_is_running_but_not_working():
    idle = rooms.driver_view({'running': True, 'working': False, 'pending_actions': []})
    assert idle == {'running': True, 'working': False, 'pending_actions_count': 0}
    assert rooms.driver_view({'running': True, 'working': True, 'pending_actions': [{'kind': 'retry'}]})['working'] is True
    assert rooms.driver_view(None) == {'running': False, 'working': False, 'pending_actions_count': 0}


def test_handoff_view_reads_title_and_state_from_task():
    done = handoffs.live_view(ROW, {'title': 'Avisar o cliente X', 'status': 'done', 'assignee': 'vendas'}, same)
    assert done['title'] == 'Avisar o cliente X'
    assert done['state'] == 'completed'
    assert done['task'] == {'status': 'done', 'assignee': 'vendas'}


def test_handoff_view_without_task_has_no_title():
    gone = handoffs.live_view(ROW, None, same)
    assert gone['title'] is None and gone['state'] == 'open' and gone['task'] is None
    assert handoffs.live_view({**ROW, 'state': 'needs_review'}, {'title': 7, 'status': 'triage', 'assignee': 'vendas'}, same) \
        | {'created_at': 1.0} == {**handoffs.view({**ROW, 'state': 'needs_review'}), 'title': None,
                                   'task': {'status': 'triage', 'assignee': 'vendas'}}


def title_checks(live_view):
    shown = live_view(ROW, {'title': f'enviar a chave {KEY}', 'status': 'running', 'assignee': f'x{KEY}'}, redact)
    assert KEY not in str(shown) and shown['title'] == 'enviar a chave sk-***'


def test_handoff_title_written_by_a_bot_is_redacted():
    """F2 (invariant 1): a Bot can write the Kanban task's title; every handoff route shows it through live_view, redacted."""
    title_checks(handoffs.live_view)


@pytest.mark.parametrize('edit', [('title = redact(task["title"])', 'title = (task["title"])'),
                                  ('"assignee": redact(assignee) if', '"assignee": (assignee) if')], ids=['title', 'assignee'])
def test_each_mutation_is_caught(edit):
    source = inspect.getsource(handoffs.live_view)
    assert source.count(edit[0]) == 1
    scope = dict(vars(handoffs))
    exec(source.replace(*edit), scope)
    with pytest.raises(AssertionError):
        title_checks(scope['live_view'])
