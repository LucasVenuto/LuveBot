"""ADR-008 in the real harness: `luvebot.db` runs in WAL (it lives on the container's own tmpfs, never on a macOS bind mount: WAL needs shared
memory between the dashboard and the gateway), /health says which mode runs, and the dashboard and a gateway writing together never meet
"database is locked". No timing assertion (it varies with the load). Mutation (mutate_v04.py `wal_never_on`): never turn the WAL on -> red.
NOT RUN YET (no disk for the Hermes image): written against the helpers the other invariant files use."""
import sqlite3

from support import DASHBOARD
from test_approvals import settle
from test_bots import DB, csrf, post
from test_hook import BLOCK as BLOCK_PROMPT, session, wait_live
from test_plugin import PREFIX

PATH = '/bots/vendas/approval-surface'


def health(browser):
    response = browser.request.get(DASHBOARD + PREFIX + '/health')
    assert response.status == 200, response.text()
    return response.json()


def test_the_database_runs_in_wal_and_health_says_so(human_browser):
    conn = sqlite3.connect(DB)
    try:
        assert conn.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
    finally:
        conn.close()
    assert health(human_browser)['plugin']['db']['journal_mode'] == 'wal'


def test_the_dashboard_and_the_gateway_write_together_without_a_lock(human_browser):
    wait_live(human_browser, 'vendas')
    started = post(human_browser, '/bots/vendas/runs', {'input': BLOCK_PROMPT, 'session_id': session(human_browser, 'vendas')})
    assert started.status == 202, started.text()                                  # the gateway's hook writes events while this runs
    for _ in range(20):                                                           # and the dashboard writes an audited change each time
        response = human_browser.request.put(DASHBOARD + PREFIX + PATH, data={'mode': 'luvebot'}, headers={'X-LuveBot-CSRF': csrf(human_browser)})
        assert response.status == 200, response.text()
    assert settle(human_browser, started.json()['run']['id'])['status'] == 'completed'
    assert health(human_browser)['plugin']['db']['ok'] is True                    # the audit chain is intact after the shared writes
