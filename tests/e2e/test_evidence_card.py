"""E-4 (contract v0.10 section 3.5): the evidence card in the REAL screen: real Chrome, real login, the real plugin and Hermes; only the model is fake (tests/harness/fake_openai.py: `E4_ANSWER <name>` ends
its answer with an evidence block, `E4_PENDING` says the block on the turn of a tool call a person must approve).

  * a valid block draws the card: the five blocks in the spec's order, the top line, a source as text with a copy button; the fence is gone;
  * each violation of section 3.1 leaves the ordinary code block and draws no card;
  * the "awaiting" count is the pending approvals OF THIS CONVERSATION (2 cases: none, and one pending right now); a pending approval of the SAME Bot from another run (another conversation) changes
    nothing in the card and no sentence of the card reads as the whole Box (the Lume's F12);
  * nothing on the card decides anything: no link, no field, only the copy buttons and "Abrir Aprovações", and a click on it sends no decision.

Run (native lane): `TESTDIR=e2e one.sh e4 <worktree> test_evidence_card.py`. Screenshots go to <harness state>/evidence/e4/."""
import re
import time
import uuid

import pytest
from playwright.sync_api import expect

from conftest import DESKTOP, SHOTS, open_conversation, open_luvebot, run_status
from support import DASHBOARD

PREFIX = DASHBOARD + '/api/plugins/luvebot'
SECTIONS = ['facts', 'assumptions', 'done', 'awaiting', 'questions']
VIOLATIONS = ['unknown_header', 'repeated_header', 'thirteen_items', 'long_item', 'none_and_item', 'empty_header', 'two_blocks']
WHOLE_BOX = re.compile(r'a caixa|na caixa|nada aguarda|Aprovações agora|não há pedido', re.I)   # section 3.2: no sentence whose subject is the whole Box
EVIDENCE = SHOTS.parent / 'e4'


def pending_of_vendas(page):
    return page.request.get(PREFIX + '/approvals?status=pending&bot=vendas&limit=100').json()['approvals']


def write(page, path, data):
    csrf = page.request.get(PREFIX + '/session').json()['csrf']
    return page.request.post(PREFIX + path, data=data, headers={'X-LuveBot-CSRF': csrf})


def shot(page, name):
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    page.wait_for_timeout(300)
    page.screenshot(path=str(EVIDENCE / f'{name}.png'))


def ask(page, text):
    """Send `text` plus a token no other turn has; -> that turn (the user's message and the Bot's answer)."""
    token = 't-' + uuid.uuid4().hex[:8]
    box = page.get_by_label('Mensagem', exact=True)
    box.fill(f'{text} {token}')
    box.press('Enter')
    return page.locator('[data-turn]').filter(has_text=token).last


@pytest.fixture
def screen(human):
    page = open_luvebot(human(DESKTOP))      # at 900 px the work panel leaves the composer 0 px wide (a finding for the screen, not for this test)
    open_conversation(page, 'vendas')
    assert not pending_of_vendas(page), 'a request of the Bot is already pending (left by an earlier test): the count would not be this test\'s'
    return page


def test_a_valid_block_draws_the_card_and_nothing_on_it_decides(screen):
    page = screen
    decisions = []
    page.on('request', lambda r: decisions.append(r.url) if r.method != 'GET' and '/approvals' in r.url else None)
    turn = ask(page, 'E4_ANSWER valid')
    card = turn.get_by_test_id('evidence-card')
    expect(card).to_be_visible(timeout=30_000)
    expect(turn.locator('[role=status]').last).to_have_text('Concluído', timeout=30_000)
    expect(card.get_by_test_id('evidence-top')).to_have_text('Escrito pelo Bot. O LuveBot não conferiu.')
    assert card.locator('section[data-testid^="evidence-"]').evaluate_all('els => els.map(e => e.dataset.testid)') == [f'evidence-{s}' for s in SECTIONS]
    expect(card.get_by_test_id('evidence-facts').get_by_test_id('evidence-item')).to_have_text('A tabela tem 120 linhas')
    expect(card.get_by_test_id('evidence-source')).to_have_text('Fonte: crm/setembro.csv')
    expect(turn).not_to_contain_text('luve-evidence')           # the fence is not left behind
    assert turn.locator('pre').count() == 0
    # the count is THIS conversation's and every sentence about it says so: none pending here, the Bot listed one
    expect(card.get_by_test_id('evidence-in-box')).to_have_text('Pedidos pendentes desta conversa: 0')
    expect(card.get_by_test_id('evidence-mismatch')).to_have_text('Nenhum pedido pendente desta conversa em Aprovações.')
    assert not WHOLE_BOX.search(card.inner_text()), card.inner_text()
    # nothing on the card decides: no link, no field; the buttons are the copy button of a source and "Abrir Aprovações"
    assert card.locator('a, input, textarea, select').count() == 0
    names = [b.get_attribute('aria-label') or b.inner_text() for b in card.get_by_role('button').all()]
    assert sorted(names) == ['Abrir Aprovações', 'Copiar a fonte: crm/setembro.csv'], names
    shot(page, 'card-valida-sem-pedidos')
    card.get_by_test_id('evidence-open-approvals').click()      # it goes to the whole Box and sends no decision
    expect(page.get_by_role('navigation', name='Navegação Principal').get_by_role('button', name=re.compile(r'^Aprovações'))).to_be_visible()
    page.wait_for_timeout(500)
    assert decisions == [], decisions
    assert not pending_of_vendas(page)


@pytest.mark.parametrize('name', VIOLATIONS)
def test_each_violation_leaves_the_code_block_and_draws_no_card(screen, name):
    turn = ask(screen, f'E4_ANSWER {name}')
    expect(turn).to_contain_text(f'Resposta {name}.', timeout=30_000)
    expect(turn.locator('[role=status]').last).to_have_text('Concluído', timeout=30_000)
    expect(turn.locator('pre').first).to_contain_text('facts:')
    expect(turn.get_by_test_id('evidence-card')).to_have_count(0)
    if name == 'two_blocks':
        assert turn.locator('pre').count() == 2
        shot(screen, 'violacao-dois-blocos')


def start_other_conversation_with_a_pending_request(page):
    """A run of the SAME Bot in ANOTHER session whose tool call a person must decide (the T33 shape). -> run id, once its request is pending."""
    session = write(page, '/bots/vendas/sessions', {})
    assert session.status == 201, session.text()
    started = write(page, '/bots/vendas/runs', {'input': 'T33_ASK: another conversation of the same Bot', 'session_id': session.json()['session']['id']})
    assert started.status == 202, started.text()
    run_id = started.json()['run']['id']
    for _ in range(40):
        if any(a['run_id'] == run_id for a in pending_of_vendas(page)):
            return run_id
        time.sleep(0.5)
    raise AssertionError('the other run never asked for approval')


def test_a_request_of_the_same_bot_from_another_conversation_is_not_this_conversations(screen):
    page = screen
    run_id = start_other_conversation_with_a_pending_request(page)
    try:
        # the screen has to HOLD the other run's request (the shell refreshes every 15 s): the nav button of Approvals says there is one, and only then does the card say its count
        approvals_nav = page.get_by_role('navigation', name='Navegação Principal').get_by_role('button', name=re.compile(r'^Aprovações'))
        expect(approvals_nav).to_contain_text('1', timeout=40_000)
        turn = ask(page, 'E4_ANSWER valid')
        card = turn.get_by_test_id('evidence-card')
        expect(card).to_be_visible(timeout=30_000)
        # the Bot's Approvals holds 1 pending request (the other run's); this conversation's count is 0, said as THIS conversation's
        assert len(pending_of_vendas(page)) == 1
        expect(card.get_by_test_id('evidence-in-box')).to_have_text('Pedidos pendentes desta conversa: 0')
        expect(card.get_by_test_id('evidence-mismatch')).to_have_text('Nenhum pedido pendente desta conversa em Aprovações.')
        for sentence in card.get_by_test_id('evidence-awaiting').locator('[data-testid=evidence-in-box], [data-testid=evidence-mismatch]').all_inner_texts():
            assert 'desta conversa' in sentence, sentence
        assert not WHOLE_BOX.search(card.inner_text()), card.inner_text()
        shot(page, 'card-com-pedido-de-outra-conversa')
    finally:
        write(page, f'/bots/vendas/runs/{run_id}/stop', {})
        for _ in range(40):
            if run_status(page.context, 'vendas', run_id) in ('completed', 'failed', 'cancelled'):
                break
            time.sleep(1)


def test_a_request_pending_in_this_conversation_is_counted_while_it_is_pending(screen):
    page = screen
    turn = ask(page, 'E4_PENDING')
    card = turn.get_by_test_id('evidence-card')
    expect(card).to_be_visible(timeout=30_000)
    mine = None
    for _ in range(40):
        mine = pending_of_vendas(page)
        if mine:
            break
        time.sleep(0.5)
    assert len(mine) == 1, mine
    try:
        expect(card.get_by_test_id('evidence-in-box')).to_have_text('Pedidos pendentes desta conversa: 1', timeout=20_000)
        expect(card.get_by_test_id('evidence-mismatch')).to_have_count(0)           # the Bot listed one and one is pending: nothing to say
        assert not WHOLE_BOX.search(card.inner_text()), card.inner_text()
        shot(page, 'card-com-pedido-desta-conversa')
    finally:
        write(page, f'/bots/vendas/runs/{mine[0]["run_id"]}/stop', {})
        for _ in range(40):
            if run_status(page.context, 'vendas', mine[0]['run_id']) in ('completed', 'failed', 'cancelled'):
                break
            time.sleep(1)
