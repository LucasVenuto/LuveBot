"""Contract v0.8 section 7 through the real route: GET /costs carries the month's projection, globally and per listed Bot, with the
contract's fields. The arithmetic and its mutations: tests/unit/backend/test_projection.py."""
from support import DASHBOARD
from test_plugin import PREFIX

FIELDS = {'month', 'spent_cents', 'projected_cents', 'cap_cents', 'crosses_cap_on', 'basis_days'}


def test_costs_carry_the_projection(human_browser):
    body = human_browser.request.get(DASHBOARD + PREFIX + '/costs').json()
    names = {b['name'] for b in human_browser.request.get(DASHBOARD + PREFIX + '/bots').json()['bots']}
    assert set(body['projection']) == FIELDS
    assert set(body['projection_by_bot']) == names and all(set(p) == FIELDS for p in body['projection_by_bot'].values())
