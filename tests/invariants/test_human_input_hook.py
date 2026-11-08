"""Hook 0.5.0, F6-B, in a REAL run: the Bot calls Hermes's own `clarify` tool (the fake model's G_CLARIFY_TEXT), so Hermes blocks on a
person and fires on_human_input_request; the hook writes one `waiting` row (kind clarify, the redacted question, a 32-hex request id);
stopping the run ends the wait and Hermes fires on_human_input_resolved with the same id; the hook writes `resolved`. Nothing the person
could have typed exists here, and the row carries no session key. Skipped on a Hermes without the events (before v0.22: the base the
harness still runs until F1)."""
import importlib.util
import re
import sqlite3

import pytest

from test_bots import DB, post
from test_hook import session, wait_for, wait_live

PROMPT = 'G_CLARIFY_TEXT: ask me'
QUESTION = 'Em que pasta eu salvo o relatório?'


def have_events():
    try:
        return importlib.util.find_spec('tools.human_input_hooks') is not None
    except (ImportError, ValueError):
        return False


pytestmark = pytest.mark.skipif(not have_events(), reason='this Hermes has no on_human_input_* events (before v0.22)')


def rows(verdict, since):
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM hook_events WHERE profile='vendas' AND verdict=? AND id>? AND tool LIKE 'human_input:%' "
                                              "ORDER BY id", (verdict, since))]
    finally:
        conn.close()


def last_id():
    conn = sqlite3.connect(DB)
    try:
        return conn.execute("SELECT COALESCE(MAX(id), 0) FROM hook_events").fetchone()[0]
    finally:
        conn.close()


def test_a_clarify_is_a_waiting_row_and_stopping_the_run_is_its_resolved_row(human_browser):
    wait_live(human_browser, 'vendas')
    before = last_id()
    started = post(human_browser, '/bots/vendas/runs', {'input': PROMPT, 'session_id': session(human_browser, 'vendas')})
    assert started.status == 202, started.text()
    run_id = started.json()['run']['id']
    waiting = wait_for(lambda: rows('waiting', before), 60, 'the waiting row of the clarify')[0]
    assert waiting['tool'] == 'human_input:clarify' and re.fullmatch(r'[0-9a-f]{32}', waiting['tool_call_id'])
    assert QUESTION in (waiting['message'] or '') and waiting['command'] is None and waiting['rule_id'] is None
    assert 'telegram' not in repr(waiting) and ':dm:' not in repr(waiting)                  # no session key (chat and user)
    stopped = post(human_browser, f'/bots/vendas/runs/{run_id}/stop', {})
    assert stopped.status in (202, 200), stopped.text()
    resolved = wait_for(lambda: [r for r in rows('resolved', before) if r['tool_call_id'] == waiting['tool_call_id']], 60,
                        'the resolved row of the same request id')[0]
    assert resolved['tool'] == 'human_input:clarify' and re.fullmatch(r'[a-z_]{1,24}', resolved['message'])
    assert not [w for w in rows('waiting', before) if w['tool_call_id'] != waiting['tool_call_id']]   # one wait, one request id
