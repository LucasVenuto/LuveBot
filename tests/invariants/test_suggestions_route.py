"""Contract v0.8 section 5 through the real plugin: GET /suggestions lists a rule suggestion after 3 one-time approvals of the same
class (seeded in LuveBot's own approvals table, as the inbox writes them), with a DRAFT preview and nothing saved to the rules;
"Ignorar" (POST /suggestions/dismiss, CSRF, audited) hides it. The counting rules and their mutations: test_suggestions.py (unit)."""
import time
import uuid

from support import DASHBOARD, plugin
from test_bots import DB, audit_rows, post
from test_plugin import PREFIX


def test_rule_suggestion_route(human_browser):
    plugin()                                   # loads the plugin, which is what makes `luvebot_backend` importable (alone, this test ran first)
    import luvebot_backend.approvals as approvals
    key = 'luvebot-sg-' + uuid.uuid4().hex[:8]
    action_class = approvals.action_class_hash('vendas', 'pattern', key)
    conn = approvals.connect(DB)
    now = time.time()
    with conn:
        for i in range(3):
            conn.execute('INSERT INTO approvals (request_id, run_id, source, bot, surface, mechanism, tool, command_redacted, description, '
                         'pattern_keys, allowed_choices, digest, action_class_hash, created_at, expires_at, status, decided_by, '
                         "decided_choice, decided_at) VALUES (?,?,'run','vendas','run','pattern','terminal',?,'d','[]','[]','x',?,?,?,"
                         "'consumed','harness','once',?)", (f'req_sg{i}{uuid.uuid4().hex[:6]}', 'run_sg', key, action_class, now - i, now + 300, now - i))
    try:
        listed = human_browser.request.get(DASHBOARD + PREFIX + '/suggestions').json()['suggestions']
        mine = next(s for s in listed if s['action_class'] == action_class)
        assert mine['kind'] == 'rule' and mine['bot'] == 'vendas' and mine['count'] == 3 and mine['draft_preview']['state'] == 'draft'
        rules = human_browser.request.get(DASHBOARD + PREFIX + '/rules').json()
        assert key not in str(rules)                                                          # a preview saves nothing
        assert post(human_browser, '/suggestions/dismiss', {'bot': 'vendas', 'action_class': action_class}, None).status == 403
        rows = len(audit_rows('suggestion.dismiss'))
        assert post(human_browser, '/suggestions/dismiss', {'bot': 'vendas', 'action_class': action_class}).status == 200
        assert len(audit_rows('suggestion.dismiss')) == rows + 2
        listed = human_browser.request.get(DASHBOARD + PREFIX + '/suggestions').json()['suggestions']
        assert all(s['action_class'] != action_class for s in listed)
    finally:
        conn = approvals.connect(DB)
        with conn:
            conn.execute("DELETE FROM approvals WHERE run_id = 'run_sg'")
            conn.execute('DELETE FROM suggestion_dismissals WHERE action_class_hash = ?', (action_class,))
        conn.close()
