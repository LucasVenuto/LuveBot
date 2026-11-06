"""Free mode, in a REAL run against the real Hermes (harness): a Bot its owner set to `free` is not asked, and what must stop still stops.

The fake model's T33_ASK runs `printf ran > MARK; chmod 600 MARK`, which the built-in sensitive-access rule asks a person about (with
the surface on `luvebot` the run waits for an approval; with `approvals.mode: off` it is blocked: test_strict_ask). Here the Bot is
`free` (hook 0.4.0, applied by the live hook before the run starts):
* manual approvals: the command runs, and the hook issued no `approve` for it (nobody was asked);
* `approvals.mode: off` (what a session /yolo does to Hermes's gate; the /yolo path itself is pinned in-process by
  tests/unit/backend/test_hook_free_mode.py): the command runs too, instead of the block it got before the Bot was free;
* a Handback rule (chpasswd, T30E_BLOCK) still stops the run's command, recorded as a block;
* hook 0.5.0 (A2): the pass is written as a `free_pass` row and GET /bots/vendas/free-passes lists it, `audited: true` because the Livre was
  turned on by a person through the route (an audited intent and result), and the page carries nothing of the hook's own ids.
The deterministic cases (every command class, the origin of a handoff, a row that does not verify) are in that unit test.
"""
import sqlite3

import pytest

from support import DASHBOARD, plugin
from test_approvals import ASK as ASK_PROMPT, MARK, settle
from test_bots import DB, csrf, post
from test_hook import BLOCK as BLOCK_PROMPT, MARK as HOOK_MARK, session, wait_live
from test_plugin import PREFIX

PATH = '/bots/vendas/approval-surface'


def set_surface(browser, mode):
    response = browser.request.put(DASHBOARD + PREFIX + PATH, data={'mode': mode}, headers={'X-LuveBot-CSRF': csrf(browser)})
    assert response.status == 200, response.text()
    return response.json()['approval_surface']


def events_since(last_id, verdict):
    conn = sqlite3.connect(DB)
    try:
        return conn.execute("SELECT COUNT(*) FROM hook_events WHERE profile='vendas' AND verdict=? AND id>?", (verdict, last_id)).fetchone()[0]
    finally:
        conn.close()


def free_passes(browser):
    response = browser.request.get(DASHBOARD + PREFIX + '/bots/vendas/free-passes?limit=100')
    assert response.status == 200, response.text()
    return response.json()


def last_event_id():
    conn = sqlite3.connect(DB)
    try:
        return conn.execute("SELECT COALESCE(MAX(id), 0) FROM hook_events").fetchone()[0]
    finally:
        conn.close()


@pytest.fixture
def free_bot(human_browser):
    """`vendas` set to free by a person (CSRF, audited) and applied by the live hook; back to `luvebot` and clean afterwards."""
    MARK.unlink(missing_ok=True)
    HOOK_MARK['block'].unlink(missing_ok=True)
    wait_live(human_browser, 'vendas')
    view = set_surface(human_browser, 'free')
    assert (view['mode'], view['applied'], view['applied_reason']) == ('free', True, 'applied'), view
    yield human_browser
    set_surface(human_browser, 'luvebot')
    conn = sqlite3.connect(DB)
    try:
        conn.execute("DELETE FROM approval_surface WHERE profile='vendas'")
        conn.commit()
    finally:
        conn.close()
    MARK.unlink(missing_ok=True)
    HOOK_MARK['block'].unlink(missing_ok=True)


def run(browser, prompt):
    started = post(browser, '/bots/vendas/runs', {'input': prompt, 'session_id': session(browser, 'vendas')})
    assert started.status == 202, started.text()
    return settle(browser, started.json()['run']['id'])


def test_a_free_bot_runs_the_command_a_person_would_have_been_asked_about(free_bot):
    before = last_event_id()
    assert run(free_bot, ASK_PROMPT)['status'] == 'completed'
    assert MARK.exists(), 'free: the chmod command did not run'
    assert events_since(before, 'approve') == 0, 'free: the hook asked anyway'
    assert events_since(before, 'block') == 0
    assert events_since(before, 'free_pass') == 1, 'free: the pass was not written (hook 0.5.0)'
    page = free_passes(free_bot)
    item = page['free_passes'][0]
    assert set(item) == {'at', 'tool', 'rule_id', 'command', 'audited'}                    # contract v0.9 section 5: no hook ids, no rule key
    assert item['tool'] == 'terminal' and 'chmod' in (item['command'] or '') and item['audited'] is True, item


def test_the_free_passes_route_is_for_people_and_validates_its_paging(free_bot):
    for query in ('limit=0', 'limit=101', 'before=0', 'before=-3', 'before=abc', 'before=1e30'):
        response = free_bot.request.get(DASHBOARD + PREFIX + '/bots/vendas/free-passes?' + query)
        assert response.status == 400, (query, response.text())
    assert free_bot.request.get(DASHBOARD + PREFIX + '/bots/no-such-bot/free-passes').status == 404

def test_a_free_bot_is_not_blocked_by_approvals_off_either(free_bot):
    plugin()
    from hermes_cli.config import set_config_value
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope('vendas'):
        set_config_value('approvals.mode', 'off')
    try:
        wait_live(free_bot, 'vendas')
        before = last_event_id()
        assert run(free_bot, ASK_PROMPT)['status'] == 'completed'
        assert MARK.exists(), 'free + approvals off: the command was blocked (the case that left the owner stuck)'
        assert events_since(before, 'block') == 0 and events_since(before, 'approve') == 0
    finally:
        with _config_profile_scope('vendas'):
            set_config_value('approvals.mode', 'manual')


def test_a_free_bot_is_still_stopped_by_a_handback_rule(free_bot):
    before = last_event_id()
    assert run(free_bot, BLOCK_PROMPT)['status'] == 'completed'
    assert not HOOK_MARK['block'].exists(), 'free: a Handback rule did not stop its command'
    assert events_since(before, 'block') >= 1
