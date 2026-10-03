"""A room is "working" only while a member's turn is live, and a handoff shows the title of its Kanban task.
Hermes's room status (tui_gateway/hosted_room_service.py status, f8489405): `running` is the driver thread being alive, true for as
long as the room exists; `working` is any task queued, running or stopping. The handoff row keeps only the title's sha256; the title
is read from the task, as the board and Activity already show it."""
from backend import handoffs, rooms

ROW = {'id': 'ho-1', 'from_bot': 'dev', 'to_bot': 'vendas', 'task_id': 't_1', 'room_id': 'room-1', 'source': 'ui', 'effect': 'allow',
       'state': 'open', 'needs_review': 0, 'created_at': 1.0}


def test_idle_room_is_running_but_not_working():
    idle = rooms.driver_view({'running': True, 'working': False, 'pending_actions': []})
    assert idle == {'running': True, 'working': False, 'pending_actions_count': 0}
    assert rooms.driver_view({'running': True, 'working': True, 'pending_actions': [{'kind': 'retry'}]})['working'] is True
    assert rooms.driver_view(None) == {'running': False, 'working': False, 'pending_actions_count': 0}


def test_handoff_view_reads_title_and_state_from_task():
    done = handoffs.live_view(ROW, {'title': 'Avisar o cliente X', 'status': 'done', 'assignee': 'vendas'})
    assert done['title'] == 'Avisar o cliente X'
    assert done['state'] == 'completed'
    assert done['task'] == {'status': 'done', 'assignee': 'vendas'}


def test_handoff_view_without_task_has_no_title():
    gone = handoffs.live_view(ROW, None)
    assert gone['title'] is None and gone['state'] == 'open' and gone['task'] is None
    assert handoffs.live_view({**ROW, 'state': 'needs_review'}, {'title': 7, 'status': 'triage', 'assignee': 'vendas'}) \
        | {'created_at': 1.0} == {**handoffs.view({**ROW, 'state': 'needs_review'}), 'title': None,
                                   'task': {'status': 'triage', 'assignee': 'vendas'}}
