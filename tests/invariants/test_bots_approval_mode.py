"""`/bots` carries `approval_mode` per Bot, the same value GET /bots/{bot}/approval-surface answers (the screen's "Livre" chip needs no read per Bot).
The field is additive (contract v0.9). WRITTEN, NOT RUN. The rules and mutations: tests/unit/backend/test_approval_mode.py."""
from test_runs import get


def test_every_bot_carries_the_mode_of_its_approval_surface(human_browser):
    bots = get(human_browser, '/bots').json()['bots']
    assert bots
    for bot in bots:
        assert bot['approval_mode'] in ('luvebot', 'channel', 'free'), bot['name']
        surface = get(human_browser, f"/bots/{bot['name']}/approval-surface").json()['approval_surface']
        assert bot['approval_mode'] == surface['mode'], bot['name']
