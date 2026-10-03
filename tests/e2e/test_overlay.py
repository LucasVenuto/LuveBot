"""T11.0 / D-023: LuveBot full screen through the Hermes `overlay` slot, in REAL Chromium against the REAL Hermes.

The frame is never restyled: it is covered, and inert while LuveBot is open. Runs like the other e2e files:
  docker compose -f tests/harness/compose.yaml exec -T hermes python -m pytest -c /dev/null -s \
    /root/.hermes/plugins/luvebot/tests/e2e/test_overlay.py -p no:cacheprovider
"""
import pytest
from playwright.sync_api import expect

from conftest import DARK_THEME, DASHBOARD, DESKTOP, PHONE, open_luvebot

THEMES = (DARK_THEME, 'default')  # Luve and Hermes Teal

OVERLAY = """() => {
  const o = document.querySelector('.lb-overlay'); const r = o.getBoundingClientRect();
  const shell = [...o.parentElement.children].filter((e) => e !== o);
  const nav = o.querySelector('nav'); const n = nav ? nav.getBoundingClientRect() : null;
  return { box: [r.x, r.y, r.width, r.height], viewport: [innerWidth, innerHeight],
           shellInert: shell.length > 0 && shell.every((e) => e.hasAttribute('inert') && e.getAttribute('aria-hidden') === 'true'),
           nav: n && [n.top, n.bottom], sidebarInert: document.getElementById('app-sidebar')?.closest('[inert]') !== null };
}"""


@pytest.fixture(autouse=True)
def restore_theme(human):
    yield
    context = human()
    context.request.put(DASHBOARD + '/api/dashboard/theme', data={'name': 'default'})


@pytest.mark.parametrize('theme', THEMES)
@pytest.mark.parametrize('size', [DESKTOP, PHONE], ids=['desktop', 'phone'])
def test_luvebot_covers_the_viewport_and_the_shell_is_inert(human, theme, size):
    page = open_luvebot(human(size=size, theme=theme))
    state = page.evaluate(OVERLAY)
    assert state['box'] == [0, 0, size[0], size[1]], state
    assert state['shellInert'] and state['sidebarInert'], state
    top, bottom = state['nav']
    if size == PHONE:  # the bottom tab bar sits on the bottom edge, never below it (the T11.0 capture bug)
        assert 0 <= top and abs(bottom - size[1]) <= 2, state


def test_tab_never_leaves_luvebot(human):
    page = open_luvebot(human(size=DESKTOP))
    for _ in range(25):
        page.keyboard.press('Tab')
        # past the last control focus goes to the browser's own UI (activeElement = body), never to the Hermes shell
        assert page.evaluate("() => { const a = document.activeElement;"
                             " return a === document.body || document.querySelector('.lb-overlay').contains(a); }")


def test_escape_inside_luvebot_keeps_it_open(human):
    page = open_luvebot(human(size=DESKTOP))
    page.keyboard.press('Escape')
    expect(page.locator('.lb-overlay')).to_be_visible()


def test_hermes_panel_closes_the_overlay_and_the_hermes_bar_reopens_it(human):
    page = open_luvebot(human(size=DESKTOP))
    page.get_by_role('link', name='Painel do Hermes').click()
    page.wait_for_url('**/sessions**')
    expect(page.locator('.lb-overlay')).to_have_count(0)
    assert page.evaluate("() => document.querySelectorAll('[inert]').length") == 0
    page.locator('#app-sidebar').get_by_role('link', name='Voltar ao LuveBot').click()
    expect(page.locator('.lb-overlay')).to_be_visible()
    assert page.evaluate("() => location.pathname") == '/'


def test_the_overlay_uses_the_same_authenticated_routes(human, browser):
    page = open_luvebot(human(size=DESKTOP))
    with page.expect_response(lambda r: '/api/plugins/luvebot/bots' in r.url) as made:
        page.reload()
    assert made.value.status == 200
    anonymous = browser.new_context()
    assert anonymous.request.get(DASHBOARD + '/api/plugins/luvebot/bots').status == 401
    anonymous.close()
