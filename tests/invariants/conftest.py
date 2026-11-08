import json
from pathlib import Path
import sys
import pytest
from playwright.sync_api import sync_playwright

sys.path.insert(0, '/harness')
from support import DASHBOARD, credentials, ready


@pytest.fixture(scope='session', autouse=True)
def real_hermes_ready():
    ready()


@pytest.fixture(scope='session')
def human_browser():
    creds = credentials()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
        context = browser.new_context()
        login = context.request.post(DASHBOARD + '/auth/password-login', data={
            'provider': 'basic', 'username': creds['username'], 'password': creds['password'], 'next': '/'})
        assert login.status == 200 and login.json()['ok'] is True
        yield context
        browser.close()
