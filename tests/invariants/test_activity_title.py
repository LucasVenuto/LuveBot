"""Activity titles (contract v0.2 section 2, T11.0): a run is titled by the first line the person typed for THAT run (never the
server's page note), read from Hermes's own session store on each request; LuveBot's database keeps no message text (the rule
test_runs and test_stream already check). An item with no title of its own goes out as null, never an English placeholder, and
the UI names it by kind in the person's language (dashboard/src/components/labels.ts). Mutations: mutate_v04.py (title_*).
"""
from support import DASHBOARD, plugin
from test_bots import DB, post
from test_hook import wait_live
from test_pages import fresh_history, terminal, workspace_config  # noqa: F401  (fixtures)
from test_plugin import PREFIX
from test_runs import get, wait_run

KEY = 'sk-' + 'a1b2c3d4e5f6' * 3


def activity_item(browser, item_id):
    for tab in ('done', 'running'):
        found = [i for i in get(browser, f'/activity?tab={tab}&bot=vendas&limit=100').json()['items'] if i['id'] == item_id]
        if found:
            return found[0]
    return None


def test_fallbacks_are_null_never_english_placeholders():
    plugin()
    from luvebot_backend import activity
    run = activity.run_item({'run_id': 'r1', 'bot': 'vendas', 'session_id': 's', 'started_at': None, 'last_status': 'completed'},
                            lambda value: None)
    routine = activity.routine_run_item('vendas', {'id': 'cron_abc_20260101_000000', 'started_at': 1, 'ended_at': 2}, 10)
    due = activity.due_item('vendas', {'id': 'abc', 'next_run_at': None})
    task = activity.task_item({'id': 't1', 'assignee': 'vendas', 'status': 'ready'})
    assert [i['title'] for i in (run, routine, due, task)] == [None, None, None, None]
    title = activity.prompt_title
    assert title('\n  Responder 14 tickets  \nmais detalhes') == 'Responder 14 tickets'
    assert title('x' * 300) == 'x' * 120 and title('   \n ') is None and title(None) is None
    assert title('[luvebot:page] A pessoa está vendo pages/p.md (...). Releia o arquivo antes de alterar.\n\nRevise') == 'Revise'
    assert title('[luvebot:intro] Apresente-se ao seu novo usuário') is None
    from luvebot_backend.runs import RunIndex
    digest = RunIndex(DB).prompt_digest
    prompts = {digest(t): t for t in ('primeira', 'segunda\nmais')}                              # one session, two runs
    row = lambda sha: {'run_id': 'r', 'bot': 'vendas', 'session_id': 's', 'started_at': None, 'last_status': 'completed', 'prompt_sha': sha}
    assert [activity.run_item(row(digest(t)), lambda v: None, prompts)['title'] for t in ('primeira', 'segunda\nmais')] == ['primeira', 'segunda']
    assert activity.run_item(row(None), lambda v: None, prompts)['title'] is None                  # a run from before the digest


def test_the_digest_is_keyed_per_database(tmp_path):
    """A plain sha256 of 'Olá' is a dictionary lookup; the run's digest is an HMAC with a random key of THIS database."""
    import hashlib
    plugin()
    from luvebot_backend.runs import RunIndex
    ours, other = RunIndex(DB), RunIndex(tmp_path / 'other.db')
    assert ours.prompt_digest('Olá') == ours.prompt_digest('Olá')                                 # stable for one database
    assert ours.prompt_digest('Olá') not in (hashlib.sha256('Olá'.encode()).hexdigest(), other.prompt_digest('Olá'))
    key = ours._exec('SELECT key FROM run_digest_key', fetch=True)
    assert len(key) == 1 and len(key[0]['key']) == 32
    assert oct(DB.stat().st_mode & 0o777) == '0o600'                                             # the key lives in the 0600 database


def test_a_run_and_a_chat_turn_are_titled_by_what_the_person_typed(human_browser):
    wait_live(human_browser, 'vendas')  # an earlier file can leave the hook reloading (hook_not_live 409)
    sid = post(human_browser, '/bots/vendas/sessions', {}).json()['session']['id']
    started = post(human_browser, '/bots/vendas/runs', {'input': f'Responder 14 tickets {KEY}\nmais detalhes', 'session_id': sid})
    assert started.status == 202, started.text()
    run_id = started.json()['run']['id']
    wait_run(human_browser, 'vendas', run_id, {'completed'})
    item = activity_item(human_browser, 'run:' + run_id)
    assert item['title'].startswith('Responder 14 tickets ') and KEY not in item['title'], item   # redacted on the way out
    chat = post(human_browser, f'/bots/vendas/sessions/{sid}/chat/stream', {'input': 'Resumo da semana'})
    assert chat.status == 200, chat.text()
    titles = [i['title'] for i in get(human_browser, '/activity?tab=done&bot=vendas&limit=100').json()['items'] if i['kind'] == 'run']
    assert 'Resumo da semana' in titles and activity_item(human_browser, 'run:' + run_id)['title'].startswith('Responder'), titles
    assert b'Responder 14 tickets' not in DB.read_bytes() and b'Resumo da semana' not in DB.read_bytes()   # nothing stored by us


def test_a_run_about_a_page_is_titled_by_the_person_not_by_the_note(human_browser, workspace_config, fresh_history, tmp_path):
    ws = tmp_path / 'ws'
    ws.mkdir()
    terminal('vendas', backend='local', cwd=str(ws))
    wait_live(human_browser, 'vendas')
    assert post(human_browser, '/bots/vendas/pages', {'title': 'Plano'}).status == 201
    sid = post(human_browser, '/bots/vendas/sessions', {}).json()['session']['id']
    started = post(human_browser, '/bots/vendas/runs', {'input': 'Revise o plano', 'session_id': sid, 'page': {'slug': 'plano'}})
    assert started.status == 202, started.text()
    run_id = started.json()['run']['id']
    wait_run(human_browser, 'vendas', run_id, {'completed'})
    assert activity_item(human_browser, 'run:' + run_id)['title'] == 'Revise o plano'
