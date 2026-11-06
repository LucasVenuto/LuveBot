"""Contract v0.6 Part A against the REAL Hermes (backend/skills.py through dashboard/plugin_api.py): a skill made with Hermes's own
route, holding a canary key, never shows the key (2.1, 2.2, 2.4); the per-platform state is Hermes's own `get_disabled_skills`
(a skill off only in Telegram is `partial`); an essential skill cannot be turned off; a toggle goes through Hermes's toggle_skill
in the Bot's profile only, audited first, and the answer is the re-read state; in loopback turning ON is refused and turning OFF
is allowed. The unit side (stand-in Hermes, 8 mutations): tests/unit/backend/test_skills.py. Container mutations: mutate_v04.py a_*.
"""
import json
import shutil
import uuid

import pytest

from support import DASHBOARD, plugin
from test_bots import audit_rows, csrf, error_of
from test_hook import loopback_request, run_async
from test_plugin import PREFIX

KEY = 'sk-' + 'f0e1d2c3b4a5' * 3


def put(browser, path, body, token='valid'):
    headers = {} if token is None else {'X-LuveBot-CSRF': csrf(browser) if token == 'valid' else token}
    return browser.request.put(DASHBOARD + PREFIX + path, data=body, headers=headers)


def get(browser, path):
    return browser.request.get(DASHBOARD + PREFIX + path)


def raw_skills(bot):
    from hermes_cli.config import read_raw_config
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope(bot):
        return (read_raw_config() or {}).get('skills') or {}


def set_platform_off(bot, platform, names):
    from hermes_cli.config import set_config_value
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope(bot):
        set_config_value(f'skills.platform_disabled.{platform}', json.dumps(names))   # Hermes's setter takes text


@pytest.fixture
def canary_skill(human_browser):
    """A skill of `vendas` made through Hermes's own POST /api/skills, with the canary in its description and body."""
    name = 'luvebot-' + uuid.uuid4().hex[:8]
    content = f'---\nname: {name}\ndescription: Chave {KEY}.\n---\n# {name}\nchave: {KEY}\n'   # Hermes: <= 60 chars, ends with '.'
    made = human_browser.request.post(DASHBOARD + '/api/skills', data={'name': name, 'content': content, 'profile': 'vendas'})
    assert made.ok, made.status
    yield name
    from hermes_cli.web_server_profiles import _profile_scope
    from tools.skill_manager_tool import _find_skill
    with _profile_scope('vendas'):
        found = _find_skill(name)
    if found:
        shutil.rmtree(found['path'], ignore_errors=True)
    set_platform_off('vendas', 'telegram', [])
    from hermes_cli.config import set_config_value
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope('vendas'):
        set_config_value('skills.disabled', json.dumps(sorted(set(raw_skills('vendas').get('disabled') or []) - {name})))


def test_skills_state_is_real_toggled_through_hermes_and_never_leaks(human_browser, canary_skill):
    from agent.skill_utils import ESSENTIAL_SKILLS
    name = canary_skill
    set_platform_off('vendas', 'telegram', [name])
    listed = get(human_browser, '/bots/vendas/skills')
    assert listed.status == 200, listed.text()
    body = listed.json()
    assert 'telegram' in body['platforms'] and body['platforms'][0] == 'api_server' and KEY not in listed.text()
    mine = next(s for s in body['skills'] if s['name'] == name)
    assert mine['enabled']['all'] is True and mine['enabled']['api_server'] is True and mine['enabled']['telegram'] is False
    assert mine['state'] == 'partial' and mine['provenance'] == 'agent' and mine['toggle'] is True
    defaults = get(human_browser, '/bots/default/skills').json()['skills']          # the harness's vendas has no bundled skills
    essential = next(s for s in defaults if s['name'] in ESSENTIAL_SKILLS)
    assert essential['essential'] is True and essential['toggle'] is False and essential['provenance'] == 'bundled'

    default_before = raw_skills('default')
    assert put(human_browser, f'/bots/vendas/skills/{name}', {'enabled': False}, None).status == 403          # CSRF first
    assert put(human_browser, f'/bots/vendas/skills/{name}', {'enabled': False, 'x': 1}).status == 400
    rows = len(audit_rows('skill.disable'))
    off = put(human_browser, f'/bots/vendas/skills/{name}', {'enabled': False})
    assert off.status == 200, off.text()
    assert off.json()['skill']['state'] == 'off' and off.json()['notice'] is None and KEY not in off.text()
    assert name in raw_skills('vendas')['disabled'] and raw_skills('default') == default_before              # only that profile
    assert [r[1:3] for r in audit_rows('skill.disable')[rows:]] == [('ok', 'intent'), ('ok', 'result')]
    on = put(human_browser, f'/bots/vendas/skills/{name}', {'enabled': True})
    assert on.status == 200 and on.json()['still_off_on'] == ['telegram'] and on.json()['notice'] == 'on_applies_to_new_conversations'
    assert name not in (raw_skills('vendas').get('disabled') or [])

    refused = put(human_browser, f'/bots/default/skills/{essential["name"]}', {'enabled': False})
    assert refused.status == 409 and error_of(refused)['code'] == 'skill_essential'
    for missing in ('nao-existe-' + uuid.uuid4().hex[:6], '-x', 'a%20b'):
        gone = put(human_browser, f'/bots/vendas/skills/{missing}', {'enabled': True})
        assert gone.status == 404 and error_of(gone)['code'] == 'skill_not_found', missing

    content = get(human_browser, f'/bots/vendas/skills/{name}/content')
    assert content.status == 200 and content.json()['redacted'] is True and KEY not in content.text()
    assert '/root/' not in content.text()
    grid = get(human_browser, '/skills/matrix')
    assert grid.status == 200 and KEY not in grid.text()
    cells = {(c['bot'], c['skill']): c['state'] for c in grid.json()['cells']}
    assert cells[('vendas', name)] == 'partial' and cells[('default', name)] == 'absent'
    assert get(human_browser, '/health').json()['features']['skills'] == 'ok'


def test_skills_enable_needs_a_person(canary_skill):
    """Loopback (the token names the machine): turning a skill ON is refused, turning it OFF is allowed (A-78)."""
    module, name = plugin(), canary_skill
    path = f'/bots/vendas/skills/{name}'
    response = run_async(module.put_bot_skill('vendas', name, loopback_request(module, 'PUT', path, body=b'{"enabled": false}')))
    assert response.status_code == 200 and json.loads(response.body)['skill']['state'] == 'off'
    with pytest.raises(module.PluginError) as refused:
        run_async(module.put_bot_skill('vendas', name, loopback_request(module, 'PUT', path, body=b'{"enabled": true}')))
    assert refused.value.code == 'loopback_not_human' and refused.value.status == 403
    assert name in raw_skills('vendas')['disabled']                                                         # still off
