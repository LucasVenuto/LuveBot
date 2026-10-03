"""T12 (1): the Bot writes Markdown for LuveBot. Hermes tells API Server agents to write plain text (agent/prompt_builder.py
#L807-L814); LuveBot sets the documented per-profile override platform_hints.api_server.replace through Hermes's config writer,
never over a hint the owner wrote. Proven with the REAL system prompt: the fake model answers which rule it received.
Mutation: tests/harness/mutate_v04.py t12_hint_overwrites_user.
Pages (CEO, 2026-10-03: told "pages/", the Bot asked which project): the hint carries the ABSOLUTE path of the Bot's pages folder,
resolved by pages.workspace, and says nothing of Pages when they are not available; it follows the workspace before each turn.
Mutations: mutate_v04.py t12_pages_relative, t12_pages_no_refresh.
"""
import json
import os
import subprocess
import uuid

import pytest

from support import DASHBOARD, plugin
from test_bots import DB, audit_rows, post
from test_hook import wait_live
from test_pages import terminal, workspace_config  # noqa: F401  (workspace_config is a fixture)
from test_plugin import PREFIX
from test_runs import wait_run
from test_stream import parse


def config_hint(bot):
    plugin()
    from hermes_cli.config import load_config
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope(bot):
        hints = load_config().get('platform_hints')
    return hints.get('api_server') if isinstance(hints, dict) else None


def unset_hint(bot):
    plugin()
    from hermes_cli.config import unset_config_value
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope(bot):
        if config_hint(bot) is not None:
            unset_config_value('platform_hints.api_server')


def ensure(bot):
    plugin()
    from luvebot_backend.audit import AuditLog
    from luvebot_backend.bot_controls import ensure_markdown_hint
    return ensure_markdown_hint(bot, AuditLog(DB), 'test')


def probe(browser, question='T12_HINT_PROBE: which rule?'):
    """What the REAL system prompt of a run carries, as the fake model reports it."""
    wait_live(browser, 'vendas')
    sid = post(browser, '/bots/vendas/sessions', {}).json()['session']['id']
    run = post(browser, '/bots/vendas/runs', {'input': question, 'session_id': sid})
    assert run.status == 202, run.text()
    run_id = run.json()['run']['id']
    frames = parse(browser.request.get(DASHBOARD + PREFIX + f'/bots/vendas/runs/{run_id}/events').text())
    wait_run(browser, 'vendas', run_id, {'completed'})
    return next(f[2]['output'] for f in frames if f[1] == 'run.completed')


@pytest.fixture
def clean_hint():
    for bot in ('vendas', 'default'):  # the installer test upgrades every profile
        unset_hint(bot)
    yield
    for bot in ('vendas', 'default'):
        unset_hint(bot)


def test_the_bot_gets_markdown_in_its_real_prompt_once(human_browser, clean_hint, workspace_config):
    terminal('vendas', backend='local', cwd='.')                     # no Pages here: the hint is the Markdown one alone
    assert probe(human_browser) == 'HINT:plain'                      # the cause: Hermes's api_server rule, as shipped (a turn never creates it)
    before = len(audit_rows('bot.platform_hint.set'))
    assert ensure('vendas') == 'set'
    from luvebot_backend.bot_controls import MARKDOWN_HINT
    assert config_hint('vendas') == {'replace': MARKDOWN_HINT}
    assert probe(human_browser) == 'HINT:luvebot'                    # the fix, in the prompt the model really receives
    assert ensure('vendas') == 'present' and len(audit_rows('bot.platform_hint.set')) == before + 2   # idempotent: one act


def test_a_hint_the_owner_wrote_is_never_replaced(human_browser, clean_hint):
    plugin()
    from hermes_cli.config import set_config_value
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope('vendas'):
        set_config_value('platform_hints.api_server.append', 'Minha regra')
    kept = len(audit_rows('bot.platform_hint.kept'))
    assert ensure('vendas') == 'kept_user'
    assert config_hint('vendas') == {'append': 'Minha regra'}
    assert len(audit_rows('bot.platform_hint.kept')) == kept + 2     # recorded and left
    assert probe(human_browser) == 'HINT:plain'                      # Hermes's default plus the owner's line, untouched


def test_a_new_bot_is_created_with_it(human_browser):
    plugin()
    name = 't12-' + uuid.uuid4().hex[:8]
    try:
        created = post(human_browser, '/bots', {'name': name, 'display': {'label': 'Novo'}})
        assert created.status == 201, created.text()
        from luvebot_backend.bot_controls import MARKDOWN_HINT
        assert config_hint(name) == {'replace': MARKDOWN_HINT}
    finally:
        human_browser.request.delete(DASHBOARD + '/api/profiles/' + name)


def test_the_installer_upgrades_existing_bots_idempotently(clean_hint):
    script = '/root/.hermes/plugins/luvebot/scripts/plugin_state.py'
    run = lambda: subprocess.run(['python', script, 'upgrade'], capture_output=True, text=True, timeout=120,
                                 env={'HERMES_HOME': '/root/.hermes', 'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root'})
    first = run()
    assert first.returncode == 0, first.stderr[-500:]
    assert 'LuveBot: vendas: markdown hint set' in first.stdout, first.stdout
    second = run()
    assert second.returncode == 0 and 'LuveBot: vendas: markdown hint present' in second.stdout, second.stdout


def pages_probe(browser):
    return probe(browser, 'T12_PAGES_PROBE: where are your pages?')


def test_the_hint_names_the_absolute_pages_folder_and_follows_the_workspace(human_browser, clean_hint, workspace_config, tmp_path):
    from luvebot_backend.bot_controls import MARKDOWN_HINT
    terminal('vendas', backend='local', cwd='.')                            # Pages not available: the hint does not speak of them
    assert ensure('vendas') == 'set' and config_hint('vendas') == {'replace': MARKDOWN_HINT}
    assert pages_probe(human_browser) == 'PAGES:none'
    first, second = tmp_path / 'ws1', tmp_path / 'ws2'
    first.mkdir()
    second.mkdir()
    terminal('vendas', cwd=str(first))
    assert ensure('vendas') == 'updated'                                    # our older text is upgraded (never an owner's)
    folder = os.path.join(os.path.realpath(first), 'pages')
    assert config_hint('vendas')['replace'] == MARKDOWN_HINT + ' ' + f'Pages: documents for the person to read or edit go in {folder}/<slug>.md' \
        ' (create the folder if it is missing; slug: lowercase letters, digits and hyphens). LuveBot\'s Pages editor reads only that folder.'
    assert pages_probe(human_browser) == 'PAGES:' + folder                  # in the prompt the model really receives
    terminal('vendas', cwd=str(second))                                     # moved by hand: the next turn already knows
    assert pages_probe(human_browser) == 'PAGES:' + os.path.join(os.path.realpath(second), 'pages')
    assert ensure('vendas') == 'present'


def test_an_owner_hint_stays_even_with_pages(human_browser, clean_hint, workspace_config, tmp_path):
    plugin()
    from hermes_cli.config import set_config_value
    from hermes_cli.web_server_profiles import _config_profile_scope
    terminal('vendas', backend='local', cwd=str(tmp_path))
    with _config_profile_scope('vendas'):
        set_config_value('platform_hints.api_server.replace', 'Responda sempre em texto puro.')
    assert ensure('vendas') == 'kept_user' and config_hint('vendas') == {'replace': 'Responda sempre em texto puro.'}
    assert pages_probe(human_browser) == 'PAGES:none'
