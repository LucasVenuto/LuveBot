"""The same logged-in browser the invariants use (tests/invariants/conftest.py), for the screen harness."""
import sys

import pytest
from playwright.sync_api import sync_playwright

sys.path.insert(0, '/harness')
from support import DASHBOARD, credentials, ready  # noqa: E402


@pytest.fixture(scope='session', autouse=True)
def real_hermes_ready():
    ready()


@pytest.fixture(scope='session')
def playwright_instance():
    with sync_playwright() as playwright:
        yield playwright


def logged_in(playwright, engine='chromium', **context):
    creds = credentials()
    browser = getattr(playwright, engine).launch(headless=True, **({'args': ['--no-sandbox']} if engine == 'chromium' else {}))
    ctx = browser.new_context(**context)
    login = ctx.request.post(DASHBOARD + '/auth/password-login', data={
        'provider': 'basic', 'username': creds['username'], 'password': creds['password'], 'next': '/'})
    assert login.status == 200 and login.json()['ok'] is True
    return browser, ctx


@pytest.fixture(scope='session')
def human_browser(playwright_instance):
    browser, ctx = logged_in(playwright_instance, viewport={'width': 1100, 'height': 800})
    yield ctx
    browser.close()
