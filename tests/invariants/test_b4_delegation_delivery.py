"""b4 (found by Vitral): Hermes f8489405 stores a subagent's result in an API session as a DELIVERY row with role user,
display_kind async_delegation_complete and display_metadata {delegation_id, task_count, completed_count, failed_count,
duration_seconds} (gateway/wake.py#L118-L183, hermes_state_messages.py#L414-L427). LuveBot's history passed only steer/failed_turn/
hidden through, so the agent's result showed as the PERSON's bubble. Now the kind and that minimum of metadata (the id and four
checked numbers, nothing else) go out with the redacted text; hidden stays hidden; no other user row changes.
Container mutation: tests/harness/mutate_v04.py b4_delivery_as_person.
"""
import json
import uuid

from support import plugin
from test_runs import get
from test_v04 import CANARY, VENDAS, seed, store

KIND = 'async_delegation_complete'
META = {'delegation_id': 'deleg_' + 'a' * 12, 'task_count': 2, 'completed_count': 1, 'failed_count': 1, 'duration_seconds': 3.5}


def view(row):
    plugin()
    from luvebot_backend.bot_controls import message_view
    from agent.redact import redact_sensitive_text
    return message_view(row, lambda text: redact_sensitive_text(text, force=True))


def test_the_delivery_row_keeps_its_kind_and_only_the_minimum_metadata():
    extra = {**META, 'presentation_suppressed': False, 'summary': 'the subagent said ' + CANARY, 'error': 'trace ' + CANARY}
    for raw in (extra, json.dumps(extra)):                                       # a dict, or the TEXT column as it is stored
        shown = view({'id': 7, 'role': 'user', 'content': 'Resultado do subagente: ' + CANARY, 'display_kind': KIND,
                      'display_metadata': raw, 'timestamp': 1.0})
        assert shown['display_kind'] == KIND and shown['display_metadata'] == META, shown
        assert CANARY not in json.dumps(shown)                                    # the text redacted as any other, extras dropped
    odd = view({'id': 8, 'role': 'user', 'content': 'x', 'display_kind': KIND,
                'display_metadata': {'delegation_id': 7, 'task_count': '2', 'completed_count': True, 'failed_count': -1,
                                     'duration_seconds': float('nan')}})
    assert odd['display_kind'] == KIND and odd['display_metadata'] == {}, odd   # wrong types are dropped, never passed on
    assert view({'role': 'user', 'content': 'x', 'display_kind': 'hidden'})['display_kind'] == 'hidden'
    assert view({'role': 'user', 'content': 'x', 'display_kind': 'steer'})['display_kind'] == 'steer'
    plain = view({'role': 'user', 'content': 'oi', 'display_metadata': META})
    assert 'display_kind' not in plain and 'display_metadata' not in plain      # a person's message is unchanged


def test_a_real_delivery_row_comes_out_as_a_delivery_not_as_the_person(human_browser):
    sid = seed('api_server', messages=[{'role': 'user', 'content': 'Pesquise os preços com dois subagentes'},
                                        {'role': 'assistant', 'content': 'Disparei dois subagentes.'}])
    db = store(VENDAS)
    try:
        db.append_delegation_delivery(sid, 'Subagentes concluídos: 1 de 2. Preços: R$ 49 e R$ 59.',
                                      {**META, 'delegation_id': 'deleg_' + uuid.uuid4().hex[:12]})
    finally:
        db.close()
    page = get(human_browser, f'/bots/vendas/sessions/{sid}/messages')
    assert page.status == 200, page.text()
    messages = page.json()['messages']
    person = [m for m in messages if m['role'] == 'user' and 'display_kind' not in m]
    delivery = [m for m in messages if m.get('display_kind') == KIND]
    assert [m['text'] for m in person] == ['Pesquise os preços com dois subagentes'], messages
    assert len(delivery) == 1 and 'Subagentes concluídos' in delivery[0]['text'], messages
    assert set(delivery[0]['display_metadata']) == set(META) and delivery[0]['display_metadata']['task_count'] == 2
