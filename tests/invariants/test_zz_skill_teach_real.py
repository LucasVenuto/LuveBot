"""SK-4, the two proofs the Lume's findings ask for (contract v0.11 section 3.2), on the REAL Hermes and its real skill store (a skill is written into the Bot's `skills/` folder by Hermes's own `create_skill`):

  * F-SK-A1: the dry run refuses a skill NAME that Hermes's YAML reads as something other than the same text (`y`, `n`, `1e3`, `yes`, `null`, ...: tests/invariants/test_zz_skill_name_yaml.py shows what Hermes does with them:
    a DISABLED skill of that name is still served), and the same name QUOTED in the header (`name: "y"`) is accepted, created born OFF, listed as `y` and disabled by that name;
  * F-SK-B2: a failure AFTER Hermes wrote the file (here Hermes's own `_clear_skills_prompt_cache`, which `create_skill` calls once the SKILL.md is on disk, is made to raise) must leave the skill OFF and
    answer as created: the undo reads the disk before it decides, so it never re-enables a name that now exists.
The first goes through the real routes with a person's session; the second runs the route function in process (the test process IS the Hermes environment, with the stack's home) so Hermes's function can be made to raise.
Everything it creates is taken away (the Bot's config byte for byte, the skill folders).
They first ran as strict xfails: `skill_teach` needed PyYAML, which the real Hermes does not ship (every route answered `409 capability_missing`); SK-2g (abf6435) reads with Hermes's own ruamel and imports no PyYAML,
so they run for real in the Hermes environment as it is (the harness's has no `yaml`)."""
import json
import shutil
import uuid

import hermes_yaml as yaml
import pytest

from support import DASHBOARD
from test_bots import csrf, error_of
from test_hook import ROOT_HOME, run_async
from test_plugin import PREFIX
from test_runs import get
from test_zz_avatars import second_login

BOT = ROOT_HOME / 'profiles' / 'vendas'
CONFIG = BOT / 'config.yaml'
REFUSED = ['y', 'n', '1e3', '12e3', '0e0', 'yes', 'no', 'on', 'off', 'true', 'false', 'null', '010']


def skill(name_yaml, description='Use ao testar a prova do SK-4.'):
    return f'---\nname: {name_yaml}\ndescription: {description}\n---\n\n# Prova\n\n1. Abra a planilha.\n2. Some o total.\n'


def create(browser, name, content, dry_run):
    return browser.request.post(DASHBOARD + PREFIX + '/bots/vendas/skills', data={'name': name, 'content': content, 'dry_run': dry_run}, headers={'X-LuveBot-CSRF': csrf(browser)})


def disabled():
    return set((yaml.safe_load(CONFIG.read_text()).get('skills') or {}).get('disabled') or [])


def folders(name):
    return [p for p in (BOT / 'skills').rglob(name) if p.is_dir()]


@pytest.fixture
def tidy():
    """The Bot's config as it was and the skill folders the test made removed (the harness restoring its own fixture state)."""
    saved = CONFIG.read_bytes()
    made = []
    yield made
    CONFIG.write_bytes(saved)
    for name in made:
        for folder in folders(name):
            shutil.rmtree(folder, ignore_errors=True)


def test_the_dry_run_refuses_the_names_hermes_reads_as_something_else_and_a_quoted_one_is_born_off(human_browser, tidy):
    answers = {}
    for name in REFUSED:
        refused = create(human_browser, name, skill(name), True)
        answers[name] = (refused.status, error_of(refused)['code'] if refused.status >= 400 else None)
    print('F-SK-A1 dry run:', answers)
    assert all(a == (422, 'skill_invalid') for a in answers.values()), answers
    assert not any(folders(name) for name in REFUSED)                                                           # a dry run writes nothing
    # the same name QUOTED reads as the text `y` for Hermes and for the dry run alike: accepted, created OFF
    tidy.append('y')
    preview = create(human_browser, 'y', skill('"y"'), True)
    assert preview.status == 200 and preview.json()['name'] == 'y', (preview.status, preview.text()[:300])
    created = create(human_browser, 'y', skill('"y"'), False)
    assert created.status == 201, (created.status, created.text()[:300])
    listed = [s for s in get(human_browser, '/bots/vendas/skills').json()['skills'] if s['name'] == 'y']
    assert len(listed) == 1 and listed[0]['state'] == 'off' and not any(listed[0]['enabled'].values()), listed        # listed as `y`, and OFF on every platform
    assert 'y' in disabled() and folders('y')                                                                   # disabled BY THAT NAME in the Bot's config, the file on disk


def test_a_failure_after_hermes_wrote_the_file_leaves_the_skill_off_and_answers_as_created(human_browser, tidy, monkeypatch):
    import hermes_cli.web_routers.skills as hermes_skills
    name = 'sk4-b2-' + uuid.uuid4().hex[:6]
    tidy.append(name)
    called = []

    def after_the_write():
        called.append(bool(folders(name)))                                                                      # the file is already on disk when Hermes calls this
        raise RuntimeError('the prompt cache could not be cleared')
    monkeypatch.setattr(hermes_skills, '_clear_skills_prompt_cache', after_the_write)
    module, request = second_login('POST', PREFIX + '/bots/vendas/skills', body=json.dumps({'name': name, 'content': skill(name), 'dry_run': False}).encode())
    answer = run_async(module.create_bot_skill('vendas', request))
    monkeypatch.undo()
    assert called == [True], called                                                                              # Hermes raised AFTER writing
    body = json.loads(answer.body)
    assert answer.status_code == 201 and body['skill']['name'] == name and body['skill']['state'] == 'off' and not any(body['skill']['enabled'].values()), (answer.status_code, str(body)[:300])
    assert folders(name) and name in disabled(), (folders(name), disabled())                                       # the file is there and the name is OFF
    assert 'prompt cache' not in json.dumps(body)                                                                # Hermes's text never leaves
    listed = [s for s in get(human_browser, '/bots/vendas/skills').json()['skills'] if s['name'] == name]
    assert len(listed) == 1 and listed[0]['state'] == 'off' and not any(listed[0]['enabled'].values()), listed
