"""In-container checks for tests/install/run.sh. Usage: checks.py before|after|gone"""
import json
import os
import re
import sys
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright

DASH = 'http://127.0.0.1:9119'
HOME = Path(os.environ['HERMES_HOME'])
phase = sys.argv[1]
failed = []


def check(label, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + label + (' | ' + str(detail) if detail and not ok else ''))
    if not ok:
        failed.append(label)


def session_token():
    html = urlopen(DASH + '/').read().decode()
    return re.search(r'__HERMES_SESSION_TOKEN__="([^"]+)"', html).group(1)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    anon = browser.new_context()
    anon_status = anon.request.get(DASH + '/api/plugins/luvebot/health').status
    check('no session -> 401 on /health', anon_status == 401, anon_status)
    # a loopback dashboard's "session" is the token Hermes embeds in its page; the SPA sends it as this header
    human = browser.new_context(viewport={'width': 1280, 'height': 800}, extra_http_headers={'X-Hermes-Session-Token': session_token()})
    health = human.request.get(DASH + '/api/plugins/luvebot/health')
    page = human.new_page()
    page.goto(DASH + '/')
    page.wait_for_timeout(4000)
    sidebar = page.locator('aside[aria-label="sidebar"]').count()
    if phase in ('before', 'gone'):
        check('/health with session is not served (plugin not loaded)', health.status in (401, 404), health.status)
        check('home is not LuveBot', sidebar == 0, sidebar)
    else:
        body = health.json() if health.status == 200 else {}
        check('/health with session -> 200', health.status == 200, health.status)
        check('/health ok=true, API 0, baseline ok', body.get('ok') is True and body.get('plugin', {}).get('api') == '0'
              and body.get('hermes', {}).get('baseline_ok') is True, json.dumps(body)[:300])
        readme = json.loads(Path('/tmp/t/verify2.out').read_text())
        check("README's verify block returned the same /health", readme.get('ok') is True and readme.get('plugin') == body.get('plugin'), readme)
        check('home is replaced by LuveBot (sidebar + Today)', sidebar == 1 and page.get_by_text(re.compile('Today|Hoje')).count() > 0, sidebar)
        check('Luve theme file installed', (HOME / 'dashboard-themes/luve.yaml').is_file())
        theme = human.request.get(DASH + '/api/dashboard/themes')
        check('Hermes lists the Luve theme', theme.status == 200 and 'luve' in theme.text(), theme.status)
    browser.close()
import hermes_yaml as yaml
plugins = (yaml.safe_load((HOME / 'config.yaml').read_text()) or {}).get('plugins', {})
if phase == 'after':
    check('config.yaml enables luvebot', 'luvebot' in (plugins.get('enabled') or []), plugins)
if phase == 'gone':
    check('plugin directory and theme removed', not (HOME / 'plugins/luvebot').exists() and not (HOME / 'dashboard-themes/luve.yaml').exists())
    check('luvebot no longer enabled', 'luvebot' not in (plugins.get('enabled') or []), plugins)
sys.exit(1 if failed else 0)
