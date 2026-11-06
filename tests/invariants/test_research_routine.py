"""Contract v0.8 section 3 against the real Hermes cron: a "Pesquisa" routine made through POST /routines is a Hermes job with
exactly enabled_toolsets web + no_mcp (Hermes's scheduler allowlist, fail closed), delivered locally, its prompt ending with the
fixed line; its "Só leitura" seal is `real`, and the same job edited in Hermes to add `terminal` shows `broken` (the seal reads the
LIVE job, invariant 8). A client asking for more is refused. Unit side and mutations: tests/unit/backend/test_research_routine.py.
Not here yet: a run where the fake model tries `terminal` (needs a fake-model scenario; the allowlist is Hermes's)."""
from support import DASHBOARD, plugin
from test_bots import error_of, post
from test_plugin import PREFIX


def routine_of(browser, job_id):
    return next(r for r in browser.request.get(DASHBOARD + PREFIX + '/routines?bot=vendas&limit=100').json()['routines'] if r['id'] == job_id)


def test_research_routine_is_readonly(human_browser):
    plugin()
    import luvebot_backend.hermes_cron as cron
    body = {'bot': 'vendas', 'name': 't-res pesquisa', 'schedule': 'every 1h', 'prompt': 'Pesquise novidades de IA.', 'template': 'research'}
    refused = post(human_browser, '/routines', {**body, 'enabled_toolsets': ['web', 'no_mcp', 'terminal']})
    assert refused.status == 422 and error_of(refused)['code'] == 'invalid_field'
    made = post(human_browser, '/routines', body)
    assert made.status == 201, made.text()
    job_id = made.json()['routine']['id']
    try:
        job = cron.HermesCron().get('vendas', job_id)
        assert sorted(job['enabled_toolsets']) == ['no_mcp', 'web'] and job.get('deliver') == 'local'
        assert job['prompt'].endswith('Só pesquise e resuma; não execute ações.')
        assert made.json()['routine']['readonly_seal'] == 'real' and routine_of(human_browser, job_id)['readonly_seal'] == 'real'
        cron.HermesCron().update('vendas', job_id, {'enabled_toolsets': ['web', 'no_mcp', 'terminal']})   # edited in Hermes
        assert routine_of(human_browser, job_id)['readonly_seal'] == 'broken'
    finally:
        cron.HermesCron().remove('vendas', job_id)
