"""VO-2 (contract v0.10 section 4.2): the V6 card in the Bot's profile, THROUGH THE SCREEN, in REAL Chromium against the REAL Hermes (v0.22.5 on the native lane).

While a profile's `voice.client_direct` is true (Hermes's default) the card is there; the one button writes `false` into THAT Bot's config.yaml and into no other file; the card goes away
(the server re-read it with Hermes's own reader); a second Bot is untouched (its config byte for byte, its card still there); a reload keeps the card gone. There is no "turn it on".
Runs like the other e2e files:
  docker compose -f tests/harness/compose.yaml exec -T hermes python -m pytest -c /dev/null -s \
    /root/.hermes/plugins/luvebot/tests/e2e/test_voice_client_direct.py -p no:cacheprovider
"""
import re
from pathlib import Path

import pytest
from playwright.sync_api import expect

import hermes_yaml as yaml
from conftest import DASHBOARD, STATE, open_luvebot

HOME = Path('/root/.hermes')
CONFIG = {'default': HOME / 'config.yaml', 'vendas': HOME / 'profiles' / 'vendas' / 'config.yaml'}
SHOTS = STATE / 'logs'


def client_direct(bot):
    """What the profile's config.yaml says: `voice.client_direct` (None when the key is absent: Hermes then treats it as true)."""
    data = yaml.safe_load(CONFIG[bot].read_text()) or {}
    return (data.get('voice') or {}).get('client_direct')


@pytest.fixture
def configs_back():
    """Both profiles' config.yaml are put back exactly, and the premise is checked: neither says `false` yet."""
    saved = {bot: path.read_text() for bot, path in CONFIG.items()}
    assert all(client_direct(bot) is not False for bot in CONFIG), 'the premise: client_direct is on (or unset) in both profiles'
    yield saved
    for bot, text in saved.items():
        CONFIG[bot].write_text(text)


def open_profile(context, bot):
    """The Bot's profile ("Perfil"): select the Bot in the sidebar, then the Perfil button of its header."""
    page = open_luvebot(context)
    page.locator('aside[aria-label="sidebar"] button[aria-pressed]').filter(has_text=re.compile(bot, re.I)).first.click()
    page.get_by_role('button', name=re.compile('^Perfil')).first.click()
    return page


def card(page, bot):
    return page.locator(f'section[aria-labelledby="voice-direct-{bot}"]')


def test_the_card_turns_it_off_in_that_bots_config_and_nowhere_else(human, configs_back):
    context = human()
    page = open_profile(context, 'vendas')
    vendas = card(page, 'vendas')
    expect(vendas).to_be_visible(timeout=30_000)
    expect(vendas).to_contain_text('Chaves de voz no navegador')
    expect(vendas.get_by_role('button')).to_have_count(1)                                   # one button, and it only turns it OFF
    expect(vendas.get_by_role('button')).to_have_text('Desligar')
    assert not vendas.get_by_role('button', name=re.compile('ligar|turn on', re.I)).filter(has_not_text='Desligar').count()
    vendas.scroll_into_view_if_needed()
    page.screenshot(path=str(SHOTS / 'vo2-before.png'))                                      # the card in view, as a person sees it
    vendas.screenshot(path=str(SHOTS / 'vo2-card.png'))
    default_before = CONFIG['default'].read_text()                                           # taken now: the `human` context itself wrote the dashboard theme into this file

    vendas.get_by_role('button', name='Desligar').click()
    expect(vendas).to_be_hidden(timeout=15_000)                                              # the re-read said false: the card goes away
    page.screenshot(path=str(SHOTS / 'vo2-after.png'))                                       # the same place: no card

    assert client_direct('vendas') is False                                                  # written into THAT Bot's config.yaml
    assert CONFIG['default'].read_text() == default_before                                   # and the other profile's file is byte for byte what it was
    page.reload()
    page.locator('aside[aria-label="sidebar"] button[aria-pressed]').first.wait_for(timeout=30_000)
    page.locator('aside[aria-label="sidebar"] button[aria-pressed]').filter(has_text=re.compile('vendas', re.I)).first.click()
    page.get_by_role('button', name=re.compile('^Perfil')).first.click()
    expect(page.get_by_role('heading', name=re.compile('Perfil|vendas', re.I)).first).to_be_visible(timeout=30_000)
    expect(card(page, 'vendas')).to_have_count(0)                                            # a reload keeps it gone: it is the config's answer, not the page's memory

    other = open_profile(context, 'default')                                                 # a second Bot: untouched, its card is still there
    expect(card(other, 'default')).to_be_visible(timeout=30_000)
    assert client_direct('default') is not False
