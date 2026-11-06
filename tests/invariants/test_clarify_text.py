"""A question WITHOUT choices (Hermes's `clarify` with only a `question`), answered by TEXT in the conversation, on the real Hermes with the session authority.
WRITTEN, NOT RUN against the real stack (the Forja proves it). The sibling with choices is `test_canonical_main::test_a_clarify_is_answered_validated_and_only_by_a_person`
(proved on v0.22.5, 6/6): the same route, the same rules, but here the answer is free text, so there is no list to validate it against, only the text rules.

The Bot asks through the real `clarify` tool (scene `G_CLARIFY_TEXT`, a question with no choices; it needs `clarify` in the api_server toolset, which the harness config has).
On the canonical Hermes the question is a `pending_control` of the RUN (`kind: clarify`, `question`, no `choices`); the person answers it from the conversation:

* the question reaches the screen with no choices (nothing to pick from: the text is the answer);
* an answer that is not text, is empty or blank, or is longer than the limit is `422 invalid_answer`, NOTHING is sent and the Bot still waits (audited as refused);
* a loopback dashboard (a machine, not a person) is refused `loopback_not_human`: a free-text answer can stand for an approval, so it is never an agent's;
* the person's text is `200 resolved`, the run resumes and completes; answering again is `409 request_not_pending`;
* the text the person wrote is NEVER stored by LuveBot: not in any audit column (only a keyed digest and a length) and not anywhere in `luvebot.db`."""
import json
import re
import uuid
from pathlib import Path

import pytest

from test_approvals import settle
from test_bots import DB, audit_rows, error_of, post
from test_canonical_main import main  # noqa: F401  (module fixture: skips on a Hermes without the session authority)
from test_hook import loopback_request, run_async, session, wait_for
from test_runs import get
from support import plugin

ANSWER = 'Na pasta relatorios-2026, nunca na raiz do projeto'
TERM = 'relatorios-2026'                                                                # a piece of the answer found nowhere else: a copy cut from it is still found
LIMIT = 16384                                                                           # canonical.MAX_ANSWER


def test_a_question_without_choices_is_answered_by_text_and_only_by_a_person(human_browser, main):
    started = post(human_browser, '/bots/vendas/runs',
                   {'input': 'G_CLARIFY_TEXT: pergunte a pasta ' + uuid.uuid4().hex[:6], 'session_id': session(human_browser, 'vendas')})
    assert started.status == 202, started.text()
    run_id = started.json()['run']['id']

    def pending():
        run = get(human_browser, f'/bots/vendas/runs/{run_id}').json()['run']
        found = next((c for c in run.get('pending_controls') or [] if c['kind'] == 'clarify'), None)
        return (run, found) if found else None
    run, control = wait_for(pending, 60, 'a clarify among the run pending_controls')
    assert not control.get('choices'), ('a question with no options must carry none', control)
    assert 'pasta' in control['question'] and isinstance(run['execution_generation'], int), control
    path = f'/bots/vendas/runs/{run_id}/clarify'
    body = lambda answer: {'request_id': control['request_id'], 'execution_generation': run['execution_generation'], 'answer': answer}   # noqa: E731

    before = len(audit_rows('run.clarify'))
    for bad in ('', '   \n\t ', 5, None, ['a'], 'x' * (LIMIT + 1)):                    # not text, nothing, blank, too long: refused, nothing is sent
        refused = post(human_browser, path, body(bad))
        assert refused.status == 422 and error_of(refused)['code'] == 'invalid_answer', (str(bad)[:20], refused.status, refused.text()[:200])
    assert pending() is not None, 'the Bot still waits after every refused answer'
    rows = [(r[1], r[2]) for r in audit_rows('run.clarify')[before:]]
    assert rows and ('ok', 'result') not in rows and ('error', 'result') in rows, rows      # refused attempts are audited as refused, never as answered
    before = len(audit_rows('run.clarify'))

    module = plugin()                                                                     # a loopback dashboard has no person: the machine cannot stand for one
    with pytest.raises(module.PluginError) as refused_machine:
        run_async(module.answer_run_clarify('vendas', run_id, loopback_request(module, 'POST', path, body=json.dumps(body(ANSWER)).encode())))
    assert refused_machine.value.code == 'loopback_not_human'
    assert pending() is not None

    right = post(human_browser, path, body(ANSWER))
    assert right.status == 200 and right.json()['clarify']['status'] == 'resolved', right.text()
    assert settle(human_browser, run_id)['status'] == 'completed'                          # the run resumed with the person's text
    again = post(human_browser, path, body(ANSWER))
    assert again.status == 409 and error_of(again)['code'] == 'request_not_pending', again.text()
    rows = [(r[1], r[2]) for r in audit_rows('run.clarify')[before:]]
    assert rows[:2] == [('ok', 'intent'), ('ok', 'result')] and rows[2:] == [('ok', 'intent'), ('error', 'result')], rows

    import sqlite3
    conn = sqlite3.connect(DB)
    try:
        everything = conn.execute("SELECT * FROM audit_log WHERE action='run.clarify' AND target=?", (run_id,)).fetchall()
    finally:
        conn.close()
    text = ' '.join(str(cell) for row in everything for cell in row)
    assert everything and ANSWER not in text and 'relatorios-2026' not in text, 'the answer text must never be audited'
    assert any(isinstance(cell, str) and re.fullmatch(r'[0-9a-f]{64}', cell) for row in everything for cell in row), 'the payload is a keyed digest and a length'
    for suffix in ('', '-wal'):                                                            # nowhere in the database, not even in its write-ahead log, whole or cut
        file = Path(str(DB) + suffix)
        if file.exists():
            data = file.read_bytes()
            for needle in (ANSWER, TERM):                                                  # the whole text, and the term that only a cut copy would still carry
                assert needle.encode() not in data, f'the answer text ({needle!r}) reached luvebot.db{suffix}'
