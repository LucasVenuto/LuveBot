"""VPS 2026-10-02: the Screen tab of `default` said "Este Bot não foi encontrado" while its chat worked. Hermes mounts a plugin's
routes ONCE, when the dashboard starts (hermes_cli/web_server_dashboard.py, include_router at plugin discovery); the UI bundle is
read from disk on every load. After an update without a restart the new UI called /bots/{bot}/screen on a backend that did not
have it: a bare 404 (no LuveBot error body), which the UI maps to bot_not_found. /health now compares the code it RUNS with the
code ON DISK and says `plugin_restart_required` when they differ."""
import json
from pathlib import Path
import shutil

from support import DASHBOARD, plugin
from test_hook import loopback_request, run_async
from test_plugin import PREFIX


def health_of(module):
    response = run_async(module.health(loopback_request(module, 'GET', '/health'), profile=None))
    return response if isinstance(response, dict) else json.loads(response.body)


def test_the_running_dashboard_runs_the_code_on_disk(human_browser):
    body = human_browser.request.get(DASHBOARD + PREFIX + '/health').json()
    assert body['plugin']['code_current'] is True
    assert 'plugin_restart_required' not in {p['code'] for p in body['problems']}


def test_code_updated_on_disk_without_a_restart_is_reported(monkeypatch):
    module = plugin()
    monkeypatch.setattr(module, '_CODE_LOADED', '0' * 64)                       # what an older load would have taken at import
    body = health_of(module)
    assert body['plugin']['code_current'] is False and body['ok'] is False
    problem = next(p for p in body['problems'] if p['code'] == 'plugin_restart_required')
    assert problem['feature'] == 'plugin' and 'restart the dashboard' in problem['message']


def test_the_digest_follows_the_files_on_disk(tmp_path, monkeypatch):
    module = plugin()
    root = Path(module.__file__).resolve().parents[1]
    copy = tmp_path / 'luvebot'
    shutil.copytree(root / 'dashboard', copy / 'dashboard', ignore=shutil.ignore_patterns('dist', 'vendor', 'src'))
    shutil.copytree(root / 'backend', copy / 'backend', ignore=shutil.ignore_patterns('__pycache__'))
    monkeypatch.setattr(module, '__file__', str(copy / 'dashboard' / 'plugin_api.py'))
    first = module._code_digest()
    assert first == module._code_digest() and len(first) == 64
    (copy / 'backend' / 'screen.py').write_text((copy / 'backend' / 'screen.py').read_text() + '\n# updated\n')
    assert module._code_digest() != first                                         # a backend file changed on disk
