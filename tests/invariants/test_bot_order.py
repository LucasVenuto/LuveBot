"""Contract v0.8 section 9 against the real plugin: pin, hide and the shared order. PUT /bots/order takes exactly a permutation of
the listed Bots (else 422, nothing written), with CSRF, audited `bot.order`; `pinned` goes through PATCH /bots/{bot}/display; a
HIDDEN Bot still runs and its approval request still reaches the inbox (hiding pauses nothing, spec 4.1). The unit side (5
mutations): tests/unit/backend/test_bot_order.py. Container mutation: mutate_v04.py p_hidden_skipped_in_inbox.
"""
from support import DASHBOARD
from test_approvals import ask_run, resolve, settle, wait_pending
from test_bots import audit_rows, csrf, error_of, patch
from test_plugin import PREFIX


def put(browser, path, body, token='valid'):
    headers = {} if token is None else {'X-LuveBot-CSRF': csrf(browser) if token == 'valid' else token}
    return browser.request.put(DASHBOARD + PREFIX + path, data=body, headers=headers)


def listed(browser):
    return {b['name']: b for b in browser.request.get(DASHBOARD + PREFIX + '/bots').json()['bots']}


def test_order_is_a_permutation_audited_and_pin_persists(human_browser):
    names = sorted(listed(human_browser))
    wanted = list(reversed(names))
    assert put(human_browser, '/bots/order', {'bots': wanted}, None).status == 403
    for bad in (wanted[:-1], wanted + ['nao-existe'], wanted + wanted[:1]):
        refused = put(human_browser, '/bots/order', {'bots': bad})
        assert refused.status == 422 and error_of(refused)['code'] == 'invalid_field', bad
    rows = len(audit_rows('bot.order'))
    done = put(human_browser, '/bots/order', {'bots': wanted})
    assert done.status == 200 and done.json() == {'bots': wanted}
    bots = listed(human_browser)
    assert [bots[n]['display']['position'] for n in wanted] == list(range(len(wanted)))
    assert [(r[1], r[2]) for r in audit_rows('bot.order')[rows:]] == [('ok', 'intent'), ('ok', 'result')]
    try:
        assert patch(human_browser, '/bots/vendas/display', {'pinned': True}).json()['display']['pinned'] is True
        assert listed(human_browser)['vendas']['display']['pinned'] is True
    finally:
        patch(human_browser, '/bots/vendas/display', {'pinned': False})


def test_a_hidden_bot_still_runs_and_its_approval_reaches_the_inbox(human_browser):
    assert patch(human_browser, '/bots/vendas/display', {'hidden': True}).status == 200
    try:
        row = wait_pending(human_browser, ask_run(human_browser))       # hiding pauses nothing: the run asks, the inbox shows it
        assert row['bot'] == 'vendas'
        assert resolve(human_browser, row, 'deny').status == 200
        settle(human_browser, row['run_id'])
    finally:
        patch(human_browser, '/bots/vendas/display', {'hidden': False})
