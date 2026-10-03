"""Gate 2 browser acceptance (T2.10): REAL Chromium, REAL login, the REAL mounted plugin and Hermes; only the model is fake.

Runs inside the harness container like tests/invariants:
  docker compose -f tests/harness/compose.yaml exec -T hermes python -m pytest -c /dev/null -s \
    /root/.hermes/plugins/luvebot/tests/e2e/test_gate2.py -p no:cacheprovider
"""
import re
import shutil
import sqlite3
import sys
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

sys.path.insert(0, '/harness')
from support import DASHBOARD, STATE, credentials, ready  # noqa: E402

ROOT = Path('/root/.hermes/plugins/luvebot')
SHOTS = STATE / 'evidence' / 't210'
DESKTOP, LAPTOP, PHONE = (1440, 900), (900, 800), (390, 844)
DARK_THEME, LIGHT_THEME = 'luve', 'nous-blue'  # the Luve theme (theme/luve.yaml) and Hermes's built-in light theme


@pytest.fixture(scope='session', autouse=True)
def real_hermes_ready():
    ready()
    SHOTS.mkdir(parents=True, exist_ok=True)
    themes = Path('/root/.hermes/dashboard-themes')
    themes.mkdir(parents=True, exist_ok=True)
    shutil.copy(ROOT / 'theme/luve.yaml', themes / 'luve.yaml')  # what scripts/install.sh does for a real install


@pytest.fixture(scope='session')
def browser():
    with sync_playwright() as playwright:
        chromium = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
        yield chromium
        chromium.close()


@pytest.fixture(scope='session')
def session_state(browser):
    """ONE real password login per run: Hermes rate-limits /auth/password-login (429), so contexts reuse its cookie."""
    creds = credentials()
    context = browser.new_context(locale='pt-BR')
    login = context.request.post(DASHBOARD + '/auth/password-login', data={
        'provider': 'basic', 'username': creds['username'], 'password': creds['password'], 'next': '/'})
    assert login.status == 200 and login.json()['ok'] is True
    state = context.storage_state()
    context.close()
    return state


@pytest.fixture
def human(browser, session_state):
    """A logged-in human with a viewport, color scheme and Hermes dashboard theme of the test's choosing."""
    opened = []

    def make(size=LAPTOP, theme=DARK_THEME):
        context = browser.new_context(viewport={'width': size[0], 'height': size[1]}, storage_state=session_state,
                                      color_scheme='light' if theme == LIGHT_THEME else 'dark',
                                      locale='pt-BR')
        assert context.request.put(DASHBOARD + '/api/dashboard/theme', data={'name': theme}).status == 200
        opened.append(context)
        return context

    yield make
    for context in opened:
        context.close()


BASE = DASHBOARD + '/'


def open_luvebot(context):
    """The LuveBot home (tab.override '/'), loaded and past the Bots skeleton: a Bot is listed in the sidebar and no
    'Carregando bots' is left anywhere (counted, not a strict locator: the sidebar and the home each render one since a2c1f64)."""
    page = context.new_page()
    page.goto(BASE)
    page.locator('aside[aria-label="sidebar"] button[aria-pressed]').first.wait_for(timeout=30_000)
    page.wait_for_function('() => !document.querySelector(\'[aria-label="Carregando bots"]\')', timeout=30_000)
    return page


def tool_card(scope, name='terminal'):
    """The tool card of a turn. Since c510277 (T12.3) a turn's tool calls sit behind one collapsed 'N passos · <tools>' line:
    open it (once) and return the card's own toggle inside it."""
    steps = scope.locator('button.lb-steps-toggle').filter(has_text=name).first
    steps.wait_for(timeout=30_000)
    if steps.get_attribute('aria-expanded') == 'false':
        steps.click()
    return scope.locator('.lb-steps-detail button[aria-expanded]').filter(has_text=name).first


def sidebar_bot(page, pattern):
    return page.locator('aside[aria-label="sidebar"] button[aria-pressed]').filter(has_text=re.compile(pattern, re.I))


def open_conversation(page, pattern='vendas'):
    sidebar_bot(page, pattern).click(timeout=10_000)
    message = page.get_by_label('Mensagem', exact=True)
    message.wait_for(timeout=10_000)
    return message


def send(page, text):
    box = page.get_by_label('Mensagem', exact=True)
    box.fill(text)
    box.press('Enter')


def drop_bot(context, name):
    """Cleanup through Hermes's own route, then our display row (same as tests/invariants)."""
    context.request.delete(DASHBOARD + '/api/profiles/' + name)
    conn = sqlite3.connect('/root/.hermes/luvebot/luvebot.db')
    conn.execute('DELETE FROM bot_meta WHERE bot=?', (name,))
    conn.commit()
    conn.close()


def run_status(context, bot, run_id):
    response = context.request.get(f'{DASHBOARD}/api/plugins/luvebot/bots/{bot}/runs/{run_id}')
    assert response.status == 200, response.text()
    return response.json()['run']['status']


def capture(page, name):
    """One screenshot into evidence/t210 (state volume). Called by the capture test only."""
    path = SHOTS / f'{name}.png'
    page.screenshot(path=str(path))
    return path
