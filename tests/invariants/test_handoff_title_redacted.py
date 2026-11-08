"""Cross review F2 (invariant 1) against the real Hermes Kanban: the title of a handoff's task, which a Bot can write, never leaves
unredacted from any handoff route: create, list, detail, promote, cancel. Every one goes through handoffs.live_view, which redacts
it (unit side and its mutations: tests/unit/backend/test_room_handoff_views.py). Container mutation: mutate_v04.py f2_title_raw.
"""
from test_bots import post
from test_phase5 import MADE_HANDOFFS, make_room, tidy_phase5  # noqa: F401  (tidy_phase5 removes rooms and handoffs made here)
from test_runs import get

KEY = 'sk-' + '7e6d5c4b3a29' * 3


def test_handoff_title_is_redacted_on_every_route(human_browser):
    room = make_room(human_browser, name='t-f2 title')
    made = post(human_browser, '/handoffs', {'from': 'vendas', 'to': 'default', 'title': f'usar a chave {KEY}', 'room_id': room['id'],
                                             'requested': [{'tool': 'f2_review'}]})
    assert made.status == 201, made.status
    handoff_id = made.json()['handoff']['id']
    MADE_HANDOFFS.append(handoff_id)
    answers = [made, get(human_browser, '/handoffs'), get(human_browser, f"/handoffs?room={room['id']}"),
               get(human_browser, f'/handoffs/{handoff_id}')]
    assert made.json()['handoff']['title'] and 'sk-' in made.json()['handoff']['title']      # the title is shown, redacted
    if made.json()['handoff']['state'] == 'needs_review':
        answers.append(post(human_browser, f'/handoffs/{handoff_id}/promote', {}))
    answers.append(post(human_browser, f'/handoffs/{handoff_id}/cancel', {}))
    for answer in answers:
        assert KEY not in answer.text(), answer.url
