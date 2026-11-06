"""Pages review v0, step 21a, through the real plugin (docs/contracts/pages-review-v0.md). The switch (`GET /bots/{bot}/pages/review`) reads the ACTIVE
rule of the exact shape and goes off when a person archives it. An approval of a page write that carries the page's sha (seeded in LuveBot's own table,
as the hook 0.6.0 + the watcher will write it; here the page is gone, so its sha is not the one at the request): resolving it "once" is `409 page_changed`
and leaves it pending, a denial is not stopped by that check, a batch refuses it (`422 not_batchable`), and the list carries the plain diff. The rules
and their mutations: tests/unit/backend/test_pages_review.py. WRITTEN, NOT RUN."""
import json
import time
import uuid

from test_bots import DB, error_of, post
from test_rules_api import activate_rule, archive_rule, create
from test_runs import get

SHAPE = {'tools': ['write_file', 'patch'], 'conditions': [{'fact': 'path', 'op': 'under', 'value': 'workspace:pages'}]}


def switch(browser):
    response = get(browser, '/bots/vendas/pages/review')
    assert response.status == 200, response.text()
    return response.json()


def seed_page_approval(request_id):
    import luvebot_backend.approvals as approvals
    page = {'slug': 'plano-21a', 'base_sha': 'a' * 64}
    proposal = {'kind': 'whole', 'path_tag': 'workspace:pages/plano-21a.md', 'size': 11, 'truncated': False, 'content': 'novo texto\n'}
    now = time.time()
    digest = approvals.run_digest('vendas', 'run_21a', request_id, 'write_file', '', 'save', [], ['once', 'deny'])
    conn = approvals.connect(DB)
    with conn:
        conn.execute('INSERT INTO approvals (request_id, run_id, source, bot, surface, mechanism, tool, command_redacted, description, pattern_keys, '
                     'allowed_choices, digest, action_class_hash, created_at, expires_at, status, page_json, proposal_json, paths_json) '
                     "VALUES (?,?,'run','vendas','run','hook_approve','write_file','','save','[]',?,?,?,?,?,'pending',?,?,?)",
                     (request_id, 'run_21a', json.dumps(['once', 'deny']), digest, 'c' * 64, now, now + 600, json.dumps(page),
                      json.dumps(proposal), json.dumps(['workspace:pages/plano-21a.md'])))
    conn.close()
    return digest


def drop(request_id):
    import luvebot_backend.approvals as approvals
    conn = approvals.connect(DB)
    with conn:
        conn.execute('DELETE FROM approvals WHERE request_id = ?', (request_id,))
    conn.close()


def test_the_switch_follows_the_active_rule(human_browser):
    assert switch(human_browser) == {'enabled': False, 'rule_id': None, 'scope': None, 'seal': None}
    other = create(human_browser, label='Só write_file', level='ask', match={'tools': ['write_file'], 'conditions': SHAPE['conditions']})
    rule = create(human_browser, label='Revisar antes de salvar', level='ask', match=SHAPE)
    try:
        activate_rule(human_browser, other, accept_unapplied=True)
        assert switch(human_browser)['enabled'] is False                                   # another shape is not the switch
        assert switch(human_browser)['rule_id'] is None
        activate_rule(human_browser, rule, accept_unapplied=True)
        on = switch(human_browser)
        assert on['enabled'] is True and on['rule_id'] == rule['id'] and on['scope'] == 'bot'
        assert 'paths_file_tools_only' in on['seal']['qualifiers']
        assert on['seal']['seal'] in ('hand', 'broken')                                    # broken + hook_outdated while the hook is older than 0.6.0
        archive_rule(human_browser, rule['id'])
        assert switch(human_browser)['enabled'] is False
    finally:
        for r in (rule, other):
            try:
                archive_rule(human_browser, r['id'])
            except AssertionError:
                pass


def test_a_page_approval_is_not_decided_over_a_page_that_moved(human_browser):
    request_id = 'req_21a_' + uuid.uuid4().hex[:8]
    digest = seed_page_approval(request_id)
    try:
        listed = get(human_browser, '/approvals?status=pending&bot=vendas&limit=100').json()['approvals']
        mine = next(a for a in listed if a['request_id'] == request_id)
        assert mine['page'] == {'slug': 'plano-21a', 'base_sha': 'a' * 64} and mine['proposal']['kind'] == 'whole'
        assert mine['review'] == {'preview': True, 'label': 'approve_and_save'}
        assert '+novo texto' in mine['diff']['lines'] and mine['diff']['format'] == 'unified'    # the page is gone: every line is an addition
        refused = post(human_browser, f'/approvals/{request_id}/resolve', {'digest': digest, 'choice': 'once'})
        assert refused.status == 409 and error_of(refused)['code'] == 'page_changed'
        still = get(human_browser, f'/approvals?status=pending&bot=vendas&limit=100').json()['approvals']
        assert any(a['request_id'] == request_id for a in still)                              # nothing was resolved
        denied = post(human_browser, f'/approvals/{request_id}/resolve', {'digest': digest, 'choice': 'deny', 'reason': 'A página mudou.'})
        assert denied.status != 409 or error_of(denied)['code'] != 'page_changed'             # a denial is not stopped by the sha check
        batch = post(human_browser, '/approvals/batch', {'items': [{'request_id': request_id, 'digest': digest, 'choice': 'once'}]})
        assert batch.status in (409, 422)                                                     # not batchable (or already decided: stale)
    finally:
        drop(request_id)


def test_a_page_review_is_not_batchable(human_browser):
    request_id = 'req_21a_' + uuid.uuid4().hex[:8]
    digest = seed_page_approval(request_id)
    try:
        batch = post(human_browser, '/approvals/batch', {'items': [{'request_id': request_id, 'digest': digest, 'choice': 'once'}]})
        assert batch.status == 422 and error_of(batch)['code'] == 'not_batchable'
    finally:
        drop(request_id)
