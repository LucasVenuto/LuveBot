"""Rules conditions in a REAL run (steps 22a path, 22b recipient; contract rules-conditions-v0): the Bot calls Hermes's own `write_file` in its workspace
(`terminal.cwd`) and the LuveBot hook stops it by what it names, not by the tool alone.

* a write under a path with a `block` rule is refused (the file never exists, the Bot goes on, the hook's row says `block` for that rule);
* under a path with an `ask` rule it waits for a person: the request shows the real tool and the path, nothing is written until it is approved, a denial
  writes nothing, an approval writes the file;
* a write outside every rule's path is not stopped (the condition is a condition: the rule does not stop the tool everywhere).
The engine and the hook's path facts are proven by unit tests (test_rules_paths.py, test_hook_0_6.py); here they meet a real Hermes."""
from pathlib import Path
import shutil
import tempfile

import pytest

from support import plugin
from test_approvals import resolve, settle, wait_pending
from test_bots import DB, post
from test_hook import run_to_end, session, start_run, wait_live
from test_pages import terminal
from test_rules_api import activate_rule, clean_rules, create  # noqa: F401  (clean_rules puts every Bot's table back)

pytestmark = pytest.mark.usefixtures('clean_rules')


@pytest.fixture
def workspace(human_browser):
    """The Bot's workspace: an absolute, existing directory in `terminal.cwd` (the root a `workspace:` tag is relative to)."""
    plugin()
    root = Path(tempfile.mkdtemp(prefix='luvebot-c22-')).resolve()
    saved = terminal('vendas', backend='local')
    saved.update(terminal('vendas', cwd=str(root)))
    yield root
    terminal('vendas', backend=saved['backend'] or 'local', cwd=saved['cwd'] or '.')
    shutil.rmtree(root, ignore_errors=True)


def path_rule(browser, level, under):
    rule = create(browser, label=f'c22 {level} {under}', level=level, scope={'kind': 'bot', 'ref': 'vendas'},
                  match={'tools': ['write_file', 'patch'], 'conditions': [{'fact': 'path', 'op': 'under', 'value': f'workspace:{under}'}]})
    rule = activate_rule(browser, rule)['rule']
    wait_live(browser, 'vendas')                                           # the new table is loaded by the gateway before the Bot works
    return rule


def last_event():
    import luvebot_backend.hook_store as store
    rows = store.events(DB, 'vendas', 1)
    return rows[0]['id'] if rows else 0


def rows_since(before, tool='write_file'):
    import luvebot_backend.hook_store as store
    return [e for e in reversed(store.events(DB, 'vendas', 100)) if e['id'] > before and e['tool'] == tool]


def test_a_write_under_a_blocked_path_is_refused_and_one_outside_is_not(human_browser, workspace):
    rule = path_rule(human_browser, 'block', 'blocked')
    before = last_event()
    _, _, done = run_to_end(human_browser, 'vendas', 'C22_PATH_BLOCK: grave o arquivo')
    assert done['status'] == 'completed'                                   # the Bot goes on after a refused tool
    assert not (workspace / 'blocked' / 'a.txt').exists(), 'the blocked write ran'
    rows = rows_since(before)
    assert [r['verdict'] for r in rows] == ['block'] and rows[0]['rule_id'] == rule['id'], rows
    before = last_event()
    _, _, done = run_to_end(human_browser, 'vendas', 'C22_PATH_FREE: grave o arquivo')
    assert done['status'] == 'completed' and (workspace / 'free' / 'a.txt').read_text() == 'livre\n'       # outside the rule's path: not stopped
    assert all(r['verdict'] != 'block' for r in rows_since(before))


def test_a_write_under_an_ask_path_waits_for_a_person_and_writes_only_when_approved(human_browser, workspace):
    rule = path_rule(human_browser, 'ask', 'review')
    target = workspace / 'review' / 'a.txt'
    sid, response = start_run(human_browser, 'vendas', 'C22_PATH_ASK: grave o arquivo')
    assert response.status == 202, response.text()
    run_id = response.json()['run']['id']
    approval = wait_pending(human_browser, run_id)
    assert approval['tool'] == 'write_file' and approval['mechanism'] == 'hook_approve' and approval['rule_id'] == rule['id'], approval
    assert 'review/a.txt' in str(approval), approval                         # the person sees WHAT path (the real tool and the file), not a placeholder
    assert not target.exists()                                               # nothing is written while it waits
    assert resolve(human_browser, approval, 'deny').status == 200
    assert settle(human_browser, run_id)['status'] == 'completed' and not target.exists(), 'a denial wrote the file'
    run2 = post(human_browser, '/bots/vendas/runs', {'input': 'C22_PATH_ASK: grave o arquivo', 'session_id': session(human_browser, 'vendas')}).json()['run']['id']
    second = wait_pending(human_browser, run2)
    assert resolve(human_browser, second, 'once').status == 200
    assert settle(human_browser, run2)['status'] == 'completed' and target.read_text() == 'para revisar\n'


# ---- the recipient fact (22b): `kanban_create` names the Bot the task goes to ---------------------------------------------------------------------
import sqlite3  # noqa: E402

from test_hook import ROOT_HOME  # noqa: E402


def tasks(title):
    conn = sqlite3.connect(ROOT_HOME / 'kanban.db')
    try:
        return conn.execute('SELECT id, assignee, created_by FROM tasks WHERE title=? ORDER BY created_at', (title,)).fetchall()
    finally:
        conn.close()


def recipient_rule(browser, level, bot='default'):
    rule = create(browser, label=f'c22 {level} para {bot}', level=level, scope={'kind': 'bot', 'ref': 'vendas'},
                  match={'tools': ['kanban_create'], 'conditions': [{'fact': 'recipient', 'op': 'eq', 'value': f'bot:{bot}'}]})
    rule = activate_rule(browser, rule)['rule']
    wait_live(browser, 'vendas')
    return rule


def test_a_task_for_a_blocked_recipient_is_refused_and_one_for_another_bot_is_not(human_browser):
    rule = recipient_rule(human_browser, 'block')
    other_before, mine_before = len(tasks('C22 destinatario default')), len(tasks('C22 destinatario self'))
    before = last_event()
    _, _, done = run_to_end(human_browser, 'vendas', 'C22_RCPT_DEFAULT: passe a tarefa')
    assert done['status'] == 'completed'
    assert len(tasks('C22 destinatario default')) == other_before, 'the task for the blocked recipient was created'
    rows = rows_since(before, 'kanban_create')
    assert any(r['verdict'] == 'block' and r['rule_id'] == rule['id'] for r in rows), rows
    # observed on v0.22.5: the hook also leaves the `handoff` row it writes BEFORE the tool (the delegation's first half), so a refused kanban_create
    # leaves one handoff row with no task behind it (harmless to the block; named for whoever owns the handoff ingest)
    assert {r['verdict'] for r in rows} <= {'handoff', 'block'}, rows
    before = last_event()
    _, _, done = run_to_end(human_browser, 'vendas', 'C22_RCPT_SELF: passe a tarefa')
    assert done['status'] == 'completed' and len(tasks('C22 destinatario self')) == mine_before + 1        # another recipient: not stopped
    assert all(r['verdict'] != 'block' for r in rows_since(before, 'kanban_create'))


def test_a_task_for_an_ask_recipient_waits_for_a_person_and_exists_only_when_approved(human_browser):
    rule = recipient_rule(human_browser, 'ask')
    before_tasks = len(tasks('C22 destinatario default'))
    sid, response = start_run(human_browser, 'vendas', 'C22_RCPT_DEFAULT: passe a tarefa')
    assert response.status == 202, response.text()
    run_id = response.json()['run']['id']
    approval = wait_pending(human_browser, run_id)
    assert approval['tool'] == 'kanban_create' and approval['mechanism'] == 'hook_approve' and approval['rule_id'] == rule['id'], approval
    assert len(tasks('C22 destinatario default')) == before_tasks                                            # nothing is created while it waits
    assert resolve(human_browser, approval, 'deny').status == 200
    assert settle(human_browser, run_id)['status'] == 'completed' and len(tasks('C22 destinatario default')) == before_tasks, 'a denial created the task'
    run2 = post(human_browser, '/bots/vendas/runs', {'input': 'C22_RCPT_DEFAULT: passe a tarefa', 'session_id': session(human_browser, 'vendas')}).json()['run']['id']
    second = wait_pending(human_browser, run2)
    assert resolve(human_browser, second, 'once').status == 200
    assert settle(human_browser, run2)['status'] == 'completed'
    made = tasks('C22 destinatario default')
    assert len(made) == before_tasks + 1 and made[-1][1] == 'default' and made[-1][2] == 'vendas', made           # for the Bot it named, from the Bot that asked
