"""'Revisar antes de salvar' (pages review v0, step 21a) as ONE flow in a REAL run: the owner turns the rule on (an `ask` rule on `write_file`/`patch` under
`workspace:pages`, the exact shape the switch reads), the Bot rewrites a page of its workspace, and what reaches the person is the request with its preview.

* the request shows the real tool, the page (slug and the sha of the file AT the request), the proposed whole text and the plain diff against the page as it is;
* nothing is written while it waits; approving writes exactly the proposed text, once;
* a page that moved between the request and the decision (a person edited it meanwhile) is not decided over: approving is `409 page_changed`, the request stays
  pending and the person's text is untouched; a denial is not stopped by that check and writes nothing.
The rule, the sha check and the diff are unit-tested (test_pages_review.py) and seeded in test_pages_review_route.py; here the hook (0.6.0 detail), the watcher
that records the request and Hermes's real write_file meet."""
import hashlib

import pytest

from test_approvals import resolve, settle, wait_pending
from test_bots import error_of, post
from test_conditions_run import workspace  # noqa: F401  (the Bot's workspace: terminal.cwd in a temp directory, put back afterwards)
from test_hook import session, start_run, wait_live
from test_rules_api import activate_rule, clean_rules, create  # noqa: F401
from test_runs import get

pytestmark = pytest.mark.usefixtures('clean_rules')
SHAPE = {'tools': ['write_file', 'patch'], 'conditions': [{'fact': 'path', 'op': 'under', 'value': 'workspace:pages'}]}
ORIGINAL, PROPOSED, PERSON = 'versão original\n', 'versão revisada pelo Bot\n', 'edição da pessoa enquanto o pedido esperava\n'


@pytest.fixture
def page(workspace):
    (workspace / 'pages').mkdir()
    path = workspace / 'pages' / 'plano-rev.md'
    path.write_text(ORIGINAL)
    return path


def review_on(browser):
    rule = create(browser, label='Revisar antes de salvar', level='ask', match=SHAPE)
    activate_rule(browser, rule)
    wait_live(browser, 'vendas')
    switch = get(browser, '/bots/vendas/pages/review').json()
    assert switch['enabled'] is True and switch['rule_id'] == rule['id'], switch
    return rule


def request_a_save(browser):
    sid, response = start_run(browser, 'vendas', 'C22_PAGE_SAVE: reescreva o plano')
    assert response.status == 202, response.text()
    run_id = response.json()['run']['id']
    return run_id, wait_pending(browser, run_id)


def sha_of(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_the_request_shows_the_page_and_the_diff_and_approving_saves_exactly_the_proposal(human_browser, page):
    rule = review_on(human_browser)
    run_id, approval = request_a_save(human_browser)
    assert approval['tool'] == 'write_file' and approval['mechanism'] == 'hook_approve' and approval['rule_id'] == rule['id'], approval
    assert approval['page']['slug'] == 'plano-rev' and approval['page']['base_sha'] == sha_of(page), approval['page']     # the sha of the file AT the request
    assert approval['proposal']['kind'] == 'whole' and approval['proposal']['content'] == PROPOSED, approval['proposal']
    assert approval['review'] == {'preview': True, 'label': 'approve_and_save'}, approval.get('review')
    lines = approval['diff']['lines']
    assert approval['diff']['format'] == 'unified' and '-versão original' in lines and '+versão revisada pelo Bot' in lines, approval['diff']
    assert page.read_text() == ORIGINAL                                                    # nothing is written while it waits
    assert resolve(human_browser, approval, 'once').status == 200
    assert settle(human_browser, run_id)['status'] == 'completed'
    assert page.read_text() == PROPOSED                                                   # exactly what was shown, nothing else


def test_a_page_that_moved_while_the_request_waited_is_not_decided_over(human_browser, page):
    review_on(human_browser)
    run_id, approval = request_a_save(human_browser)
    page.write_text(PERSON)                                                               # a person edits the page meanwhile
    refused = resolve(human_browser, approval, 'once')
    assert refused.status == 409 and error_of(refused)['code'] == 'page_changed', refused.text()
    assert page.read_text() == PERSON                                                     # the Bot's text was not saved over the person's
    still = get(human_browser, '/approvals?status=pending&bot=vendas&limit=100').json()['approvals']
    assert any(a['request_id'] == approval['request_id'] for a in still)                  # nothing was resolved: the person can still deny
    batch = post(human_browser, '/approvals/batch', {'items': [{'request_id': approval['request_id'], 'digest': approval['digest'], 'choice': 'once'}]})
    assert batch.status in (409, 422) and page.read_text() == PERSON                      # a page review is not batchable
    assert resolve(human_browser, approval, 'deny', reason='A página mudou.').status == 200   # a denial is not stopped by the sha check
    assert settle(human_browser, run_id)['status'] == 'completed' and page.read_text() == PERSON
