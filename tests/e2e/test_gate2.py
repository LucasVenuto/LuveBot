"""T2.10 / Gate 2: create a Bot -> talk -> watch tools live -> Stop, in a real browser against the real harness.

Only the model is fake (tests/harness/fake_openai.py). Sanitization is NOT covered here (T2.10s).
"""
import os
import re
import uuid

import pytest
from playwright.sync_api import expect

from conftest import (BASE, DARK_THEME, DESKTOP, LAPTOP, LIGHT_THEME, PHONE, capture, credentials, drop_bot, open_conversation,
                      open_luvebot, run_status, send, sidebar_bot, tool_card)

SLOW = 'T210_SLOW: run the slow scenario.'
APPROVAL = 'T08_TOOL_APPROVAL: request the dangerous tool.'
NEW_BOT = re.compile(r'Novo Bot|New Bot')
CREATE_THIS_BOT = re.compile(r'Create this Bot|Criar este Bot', re.I)
ZERO_BOTS = re.compile(r'\b0 (active Bots|Bots ativos)\b')


def test_create_a_bot_with_the_ui_wizard(human):
    context = human()
    name = 'e2e-' + uuid.uuid4().hex[:8]
    try:
        page = open_luvebot(context)
        page.locator('aside[aria-label="sidebar"]').get_by_label(NEW_BOT).click()
        dialog = page.get_by_role('dialog')
        expect(dialog).to_contain_text('Passo 1 de 4')
        dialog.get_by_role('button', name=re.compile('Criar do Zero')).click()
        dialog.get_by_placeholder('ex: vendas', exact=True).fill(name)
        dialog.get_by_placeholder('ex: Vendas B2B').fill('Bot E2E')
        for step in (2, 3):
            dialog.get_by_role('button', name='Avançar').click()
            expect(dialog).to_contain_text(f'Passo {step + 1} de 4')
        # the wizard's default model (openrouter + claude-sonnet-5-5) is refused by Hermes in the harness (finding for
        # the Maestro); the user types a model id the provider knows, same as tests/invariants/test_bots.py MODEL
        dialog.get_by_placeholder('claude-sonnet-5-5').fill('anthropic/claude-sonnet-4')
        with page.expect_response(lambda r: r.url.endswith('/api/plugins/luvebot/bots') and r.request.method == 'POST') as made:
            dialog.get_by_role('button', name='Criar Bot').click()
        assert made.value.status == 201, made.value.text()
        expect(dialog.get_by_test_id('bot-presentation')).to_contain_text('Bot criado com sucesso')
        dialog.get_by_role('button', name='Iniciar com este Bot').click()
        expect(dialog).to_have_count(0)
        # the new Bot is in the sidebar and opens straight into its conversation
        expect(sidebar_bot(page, 'Bot E2E')).to_have_attribute('aria-pressed', 'true')
        expect(page.get_by_label('Mensagem', exact=True)).to_be_visible()
        # and it is a real Hermes profile, listed by the backend
        listed = context.request.get(f'http://127.0.0.1:9119/api/plugins/luvebot/bots/{name}')
        assert listed.status == 200 and listed.json()['name'] == name
    finally:
        drop_bot(context, name)


def test_conversation_shows_the_tool_card_and_the_work_panel_while_the_run_is_live(human):
    context = human()
    page = open_luvebot(context)
    open_conversation(page)
    send(page, SLOW)
    status = page.locator('[role=status]').last
    # the model holds the final answer for 5 s: everything below must be on screen BEFORE it arrives
    tool = tool_card(page)
    expect(tool).to_be_visible(timeout=30_000)
    expect(tool).to_contain_text('luvebot-e2e-live')
    expect(status).to_have_text('Trabalhando…')
    panel = page.locator('[aria-label="Painel de trabalho"]')
    expect(panel.get_by_role('tabpanel')).to_contain_text('terminal')           # Atividade, the default tab
    panel.get_by_role('tab', name='Terminal').click()
    expect(panel.get_by_role('tabpanel')).to_contain_text('$ printf luvebot-e2e-live')
    expect(status).to_have_text('Trabalhando…')                                  # still live, not replayed after the end
    expect(page.get_by_text('Resposta lenta concluida').first).to_be_visible(timeout=30_000)
    expect(status).to_have_text('Concluído')
    expect(panel.get_by_role('tabpanel')).to_contain_text('luvebot-e2e-live')    # terminal output kept


def test_stop_on_a_run_waiting_for_approval_ends_only_when_hermes_confirms(human):
    context = human()
    page = open_luvebot(context)
    open_conversation(page)
    send(page, APPROVAL)
    status = page.locator('[role=status]').last
    expect(status).to_have_text('Aguardando aprovação', timeout=30_000)
    stop = page.get_by_role('button', name='Parar')
    expect(stop).to_be_enabled()
    with page.expect_response(lambda r: r.url.endswith('/stop')) as asked:
        stop.click()
    assert asked.value.status in (200, 202), asked.value.text()
    run_id = re.search(r'/runs/([^/]+)/stop', asked.value.url).group(1)
    # the turn ends as Interrompido, and the Hermes REST agrees: the end is Hermes's, not the browser's
    expect(status).to_have_text('Interrompido', timeout=30_000)
    assert run_status(context, 'vendas', run_id) == 'cancelled'
    expect(page.get_by_role('button', name='Enviar')).to_be_visible()            # input is free again



def test_g2_1_no_secret_reaches_the_browser(human):
    """Red team 2, gap G2.1: logged in, walk Conversa (a real run with a tool), Aprovações, Configurações > Custos and > Regras. No
    secret of the harness (API Server keys, the .env canary, the login password, the signing key) is in the page, a console line,
    localStorage/sessionStorage, any response the browser received, or the served bundle."""
    secrets = {k: v for k, v in credentials().items() if k in ('api_key', 'vendas_api_key', 'extra_canary', 'password', 'signing_key')}
    assert len(secrets) == 5 and all(len(v) >= 8 for v in secrets.values())
    context = human()
    seen = {'console': [], 'responses': [], 'bundle': b''}
    page = context.new_page()
    page.on('console', lambda message: seen['console'].append(message.text))

    def keep(response):
        try:
            seen['responses'].append((response.url, response.body()))
        except Exception:
            pass  # a redirect or a body Chromium already dropped: nothing to read
    page.on('response', keep)
    page.goto(BASE)
    page.locator('aside[aria-label="sidebar"] button[aria-pressed]').first.wait_for(timeout=30_000)
    pages = {}
    open_conversation(page)
    send(page, SLOW)
    expect(page.get_by_text('Resposta lenta concluida').first).to_be_visible(timeout=60_000)
    pages['conversa'] = page.content()
    page.get_by_role('button', name=re.compile('^Aprovações')).first.click()
    expect(page.get_by_text('Caixa de Aprovações').first).to_be_visible(timeout=15_000)
    pages['aprovacoes'] = page.content()
    page.get_by_role('button', name='Configurações').first.click()
    for tab in ('Custos', 'Regras'):
        page.get_by_role('tab', name=tab).click()
        page.wait_for_timeout(1500)
        pages[tab.lower()] = page.content()
    storage = page.evaluate('() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])')
    bundle = [url for url, _ in seen['responses'] if url.endswith('/dist/index.js')]
    assert bundle, 'the LuveBot bundle was served to this page'
    assert len([u for u, _ in seen['responses'] if '/api/plugins/luvebot/' in u]) >= 5, 'the walk reached the plugin API'
    ours = [(url, body) for url, body in seen['responses'] if '/api/plugins/luvebot/' in url or url.endswith('/dist/index.js')]
    channels = [*(('page:' + k, v.encode()) for k, v in pages.items()), ('console', '\n'.join(seen['console']).encode()),
                ('storage', storage.encode()), *(('response:' + url, body or b'') for url, body in ours)]
    found = sorted({(name, where) for where, content in channels for name, value in secrets.items() if value.encode() in content})
    assert not found, 'secret canaries found (values withheld): ' + ', '.join(f'{n} in {w}' for n, w in found)
    # Hermes's OWN dashboard responses on the same page are not LuveBot's; a canary there is a Hermes finding, reported, not ours
    native = sorted({(name, url.split('?')[0]) for url, body in seen['responses'] if (url, body) not in ours
                     for name, value in secrets.items() if value.encode() in (body or b'')})
    print('G2.1 Hermes native responses carrying a canary (values withheld): ' + (', '.join(f'{n} in {u}' for n, u in native) or 'none'))


# --- UI bugs found in the real browser (Maestro, 2026-10-01), fixed in T1.2b (e848be6): regression tests now.
def test_bug1_a_bot_can_be_picked_with_the_mouse_at_1440(human):
    page = open_luvebot(human(DESKTOP))
    sidebar_bot(page, 'vendas').click(timeout=4_000)  # real click, no force: a covered button times out
    expect(page.get_by_label('Mensagem', exact=True)).to_be_visible(timeout=4_000)


def test_bug1_with_the_hermes_nav_open_a_bot_can_still_be_picked_at_1440(human):
    page = open_luvebot(human(DESKTOP))
    page.get_by_label('Open navigation').dispatch_event('click')
    page.wait_for_timeout(600)  # the drawer's own transition
    sidebar_bot(page, 'vendas').click(timeout=4_000)
    expect(page.get_by_label('Mensagem', exact=True)).to_be_visible(timeout=4_000)


def test_hermes_mobile_navigation_button_stays_hidden_at_1440(human):
    page = open_luvebot(human(DESKTOP))
    expect(page.get_by_label('Open navigation')).to_be_hidden()


def test_bug2_hoje_create_this_bot_opens_the_wizard(human):
    # The onboarding (with "Create this Bot") only exists with zero Bots, and the harness always has default and vendas:
    # the ONE mock in this suite answers our own GET /bots with an empty list so the screen shows that state.
    page = human().new_page()
    page.route('**/api/plugins/luvebot/bots', lambda r: r.fulfill(json={'bots': []}) if r.request.method == 'GET' else r.fallback())
    page.goto(BASE)
    page.get_by_role('button', name=CREATE_THIS_BOT).first.click()
    expect(page.get_by_role('dialog')).to_be_visible(timeout=4_000)


def test_bug3_hoje_counts_the_existing_bots(human):
    page = open_luvebot(human())
    expect(sidebar_bot(page, 'vendas')).to_be_visible()  # a Bot exists in the same screen
    expect(page.get_by_text(ZERO_BOTS)).to_have_count(0, timeout=4_000)
    expect(page.locator('section[aria-label=onboarding]')).to_have_count(0, timeout=4_000)


# --- Screenshots: only on demand (E2E_SHOTS=1): 2 widths x 2 themes x 3 screens = 12 files.
@pytest.mark.skipif(not os.environ.get('E2E_SHOTS'), reason='captures only on demand (set E2E_SHOTS=1)')
@pytest.mark.parametrize('theme,tag', [(DARK_THEME, 'escuro'), (LIGHT_THEME, 'claro')])
@pytest.mark.parametrize('size,width', [(DESKTOP, 1440), (PHONE, 390)])
def test_captures(human, size, width, theme, tag):
    context = human(size, theme)
    page = open_luvebot(context)
    capture(page, f'bots-{width}-{tag}')
    # phone: the contacts are the first screen of the stack (T7.1 F2), so no menu needs opening
    page.locator('aside[aria-label="sidebar"]').get_by_label(NEW_BOT).click()
    capture(page, f'criar-bot-{width}-{tag}')
    page.get_by_label('Fechar').click()
    open_conversation(page)
    send(page, SLOW)
    expect(page.locator('button[aria-expanded]').filter(has_text='terminal').first).to_be_visible(timeout=30_000)
    if width == PHONE[0]:
        page.get_by_role('button', name='Painel de trabalho').click()
    page.get_by_role('tab', name='Terminal').click()
    capture(page, f'conversa-painel-{width}-{tag}')
    expect(page.get_by_text('Resposta lenta concluida').first).to_be_visible(timeout=30_000)
