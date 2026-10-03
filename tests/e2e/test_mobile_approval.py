"""Gate 5: approve an action end to end ON A PHONE, with a login (the CEO cannot reach the VPS from a phone yet, so the REAL installed
app covers it here: real Chromium as an iPhone-sized touch screen, the dashboard's real password page, the real plugin and Hermes;
only the model is fake).

Per theme (light and dark) ONE session born from the login form, then two cases in it:
  approve: a run asks for a dangerous command (rm -rf of a canary folder). TWO independent gates ask a person, in turn: LuveBot's
           rule (hook_approve, builtin.delete_permanent.commands) and then Hermes's own command gate (command_gate, "delete in
           root path"). The person opens the Approvals tab and taps "Permitir uma vez" on each; Hermes ends the run as completed
           with the model's final answer on the turn, and the command really ran (the canary folder is gone).
  deny:    same request; "Negar…" with a reason; the run ends without the command (the canary stays), the reason is on the
           approval and is what the audit row's payload digest covers.
A screenshot per step and theme goes to <harness state>/evidence/mobile-approval/.
Mutation (tests/harness/mutate_v04.py mobile_approval_not_delivered): a decision that never reaches Hermes must turn this red.
Hermes rate-limits /auth/password-login (429 after ~10 a minute): two logins per run, one wait-and-retry on 429.
"""
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time

import pytest
from playwright.sync_api import expect

from conftest import DARK_THEME, LIGHT_THEME, STATE, run_status, sidebar_bot
from support import DASHBOARD, credentials

PREFIX = DASHBOARD + '/api/plugins/luvebot'
APPROVAL = 'T08_TOOL_APPROVAL: request the dangerous tool.'   # the fake model asks Hermes to run rm -rf on the canary
CANARY = Path('/tmp/luvebot-approval-canary')
AUDIT_DB = Path('/root/.hermes/luvebot/luvebot.db')
SHOTS = STATE / 'evidence' / 'mobile-approval'
PHONE = {'viewport': {'width': 390, 'height': 844}, 'device_scale_factor': 3, 'is_mobile': True, 'has_touch': True, 'locale': 'pt-BR'}
THEMES = [('claro', 'light', LIGHT_THEME), ('escuro', 'dark', DARK_THEME)]


def shot(page, theme, case, step):
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.wait_for_timeout(400)  # transitions settle
    page.screenshot(path=str(SHOTS / f'{case}-{step}-{theme}.png'))


def login(page):
    """The dashboard's own password page, filled and submitted by touch: the session is born here."""
    creds = credentials()
    for attempt in range(2):
        page.goto(DASHBOARD + '/')
        expect(page).to_have_url(re.compile(r'/login'))
        page.get_by_label('Username').fill(creds['username'])
        page.get_by_label('Password').fill(creds['password'])
        with page.expect_response(lambda r: '/auth/password-login' in r.url) as answer:
            page.get_by_role('button', name='Sign in').tap()
        if answer.value.status != 429 or attempt:
            assert answer.value.status == 200, answer.value.status
            return
        time.sleep(61)  # Hermes's login rate limit: wait the minute out once


@pytest.fixture(scope='module', params=THEMES, ids=[t[0] for t in THEMES])
def phone(browser, request):
    theme, scheme, dashboard_theme = request.param
    context = browser.new_context(color_scheme=scheme, **PHONE)
    page = context.new_page()
    page.goto(DASHBOARD + '/')
    shot(page, theme, '0', '1-tela-de-login')
    login(page)
    assert context.request.put(DASHBOARD + '/api/dashboard/theme', data={'name': dashboard_theme}).status == 200
    page.goto(DASHBOARD + '/')
    page.locator('aside[aria-label="sidebar"] button[aria-pressed]').first.wait_for(timeout=30_000)
    page.wait_for_function('() => !document.querySelector(\'[aria-label="Carregando bots"]\')', timeout=30_000)
    shot(page, theme, '0', '2-logado-lista')
    yield page, theme
    context.close()


def ask_for_approval(page, theme, case):
    """Open the Bot, send the message whose run asks for the dangerous command, wait for the request. -> (request id, digest, run id)"""
    CANARY.mkdir(exist_ok=True)
    started = time.time()
    if not page.locator('aside[aria-label="sidebar"]').is_visible():   # a conversation is open: the phone shows one screen
        page.get_by_role('button', name='Voltar para as conversas').tap()
    sidebar_bot(page, 'vendas').tap()
    box = page.get_by_label('Mensagem', exact=True)
    box.fill(APPROVAL)
    page.get_by_role('button', name='Enviar').tap()
    turn = page.locator('[data-turn]').filter(has_text=APPROVAL).last
    expect(turn.locator('[role=status]')).to_have_text('Aguardando aprovação', timeout=30_000)
    shot(page, theme, case, '1-conversa-aguardando')
    for _ in range(30):
        pending = [a for a in page.request.get(PREFIX + '/approvals?status=pending&bot=vendas&limit=100').json()['approvals']
                   if datetime.fromisoformat(a['created_at'].replace('Z', '+00:00')).timestamp() >= started - 2]
        if pending:
            return pending[0]['request_id'], pending[0]['digest'], pending[0]['run_id'], turn
        time.sleep(1)
    raise AssertionError('no approval request reached LuveBot')


TERMINAL = ('completed', 'failed', 'cancelled')


def next_request(page, run_id, decided, timeout=45):
    """After a decision: the run's next pending request (another gate), or None once Hermes ended the run."""
    for _ in range(timeout):
        pending = [a for a in page.request.get(PREFIX + '/approvals?status=pending&bot=vendas&limit=100').json()['approvals']
                   if a['run_id'] == run_id and a['request_id'] not in decided]
        if pending:
            return pending[0]
        if run_status(page.context, 'vendas', run_id) in TERMINAL:
            return None
        time.sleep(1)
    raise AssertionError(f'run {run_id} neither ended nor asked again: {run_status(page.context, "vendas", run_id)}')


def open_inbox_card(page, theme, case, request_id):
    page.get_by_role('button', name='Voltar para as conversas').tap()
    page.get_by_role('navigation', name='Navegação Principal').get_by_role('button', name=re.compile(r'^Aprovações')).tap()
    card = page.get_by_test_id(f'approval-card-{request_id}')
    expect(card).to_be_visible(timeout=15_000)
    card.scroll_into_view_if_needed()
    shot(page, theme, case, '2-caixa-de-aprovacoes')
    return card


def back_to_turn(page, theme, case):
    """From the Approvals tab back to the Bot's conversation, where the run's turn is."""
    nav = page.get_by_role('navigation', name='Navegação Principal')
    if not page.locator('aside[aria-label="sidebar"]').is_visible():
        page.get_by_role('button', name='Voltar para as conversas').tap()
    expect(nav).to_be_visible()
    sidebar_bot(page, 'vendas').tap()
    return page.locator('[data-turn]').filter(has_text=APPROVAL).last


def test_approve_on_the_phone_and_the_run_goes_on(phone):
    page, theme = phone
    request_id, _digest, run_id, _turn = ask_for_approval(page, theme, 'aprovar')
    card = open_inbox_card(page, theme, 'aprovar', request_id)
    decided = []
    for gate in (1, 2, 3):
        with page.expect_response(lambda r: f'/approvals/{request_id}/resolve' in r.url) as answer:
            card.get_by_role('button', name='Permitir uma vez').tap()
        assert answer.value.status == 200, answer.value.text()
        assert answer.value.json()['approval']['status'] == 'consumed'      # Hermes took it (delivered), not only LuveBot's row
        decided.append(request_id)
        expect(page.get_by_text(re.compile('permitida uma vez'))).to_be_visible(timeout=10_000)
        shot(page, theme, 'aprovar', f'3-permitida-{gate}')
        following = next_request(page, run_id, decided)                     # the decision reached Hermes: the run moved on
        if following is None:
            break
        request_id = following['request_id']
        page.get_by_role('button', name='Atualizar aprovações').tap()
        card = page.get_by_test_id(f'approval-card-{request_id}')
        expect(card).to_be_visible(timeout=15_000)
        card.scroll_into_view_if_needed()
        shot(page, theme, 'aprovar', f'2-caixa-de-aprovacoes-{gate + 1}')
    assert run_status(page.context, 'vendas', run_id) == 'completed' and len(decided) == 2, decided  # LuveBot's rule + Hermes's gate
    assert not CANARY.exists(), 'the approved command did not run'
    turn = back_to_turn(page, theme, 'aprovar')
    expect(turn).to_contain_text('Harness model response', timeout=30_000)   # the model's answer after the tool: the run went on
    expect(turn.locator('[role=status]')).to_have_text('Concluído')
    shot(page, theme, 'aprovar', '4-concluido')


def test_deny_with_a_reason_on_the_phone_and_the_run_stops_without_the_action(phone):
    page, theme = phone
    reason = f'Não apague essa pasta ({theme}); confira o backup antes.'
    request_id, digest, run_id, _turn = ask_for_approval(page, theme, 'negar')
    card = open_inbox_card(page, theme, 'negar', request_id)
    card.get_by_role('button', name='Negar…').tap()
    dialog = page.get_by_role('dialog')
    dialog.get_by_label(re.compile('Motivo da negação')).fill(reason)
    shot(page, theme, 'negar', '3-motivo')
    with page.expect_response(lambda r: f'/approvals/{request_id}/resolve' in r.url) as answer:
        dialog.get_by_role('button', name='Confirmar negação').tap()
    assert answer.value.status == 200, answer.value.text()
    assert answer.value.json()['approval']['decided_choice'] == 'deny'
    expect(page.get_by_text(re.compile('negada'))).to_be_visible(timeout=10_000)
    shot(page, theme, 'negar', '4-negada')
    assert next_request(page, run_id, [request_id]) is None                 # Hermes ended the run; no other gate was asked
    assert CANARY.exists(), 'the denied command ran'
    turn = back_to_turn(page, theme, 'negar')
    expect(turn).to_contain_text('Harness model response', timeout=30_000)   # the model answered without the command
    expect(turn.locator('[role=status]')).to_have_text(re.compile('Concluído|Interrompido'))
    shot(page, theme, 'negar', '5-run-parou')
    decided = [a for a in page.request.get(PREFIX + '/approvals?bot=vendas&limit=100').json()['approvals']
               if a['request_id'] == request_id]
    assert decided and decided[0]['decided_choice'] == 'deny' and decided[0]['reason'] == reason
    # the audit row of the decision covers that reason: its digest is the sha256 of the payload the route recorded
    payload = {'digest': digest, 'choice': 'deny', 'reason': reason, 'draft': None}
    expected = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    conn = sqlite3.connect(AUDIT_DB)
    try:
        rows = conn.execute("SELECT detail, outcome, digest FROM audit_log WHERE action='approval.resolve' AND target=? ORDER BY rowid",
                            (request_id,)).fetchall()
    finally:
        conn.close()
    assert rows == [('intent', 'ok', expected), ('result', 'ok', expected)], rows
