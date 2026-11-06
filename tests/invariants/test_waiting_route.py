"""F6-B (`GET /waiting`, the Activity's `waiting` items, the Bot status) against the REAL harness Hermes. WRITTEN, NOT RUN (no disk for the harness).
The unit suite (tests/unit/backend/test_waiting.py) proves the derivation on stand-ins; this proves it through the real dashboard, with the hook's
rows written the way the hook writes them (`hook_store.record_event`, verdicts `waiting` / `resolved`) and real stored sessions (Hermes's own SessionDB).

Declared gap: the real producer (a run whose model calls `clarify`, the hook's observer firing) needs the `G_CLARIFY` scenario of tests/harness/
fake_openai.py, which does not exist yet; here the rows are inserted exactly as the observer would."""
import contextlib
import uuid

from support import plugin
from test_bots import DB, error_of, post
from test_plugin import no_secret
from test_runs import get

BOT = 'vendas'


def new_session(source, ended=False):
    """A stored session of the Bot with the given `source`, made through Hermes's own SessionDB inside the Bot's scope."""
    plugin()
    from hermes_cli.web_server_profiles import _config_profile_scope
    from hermes_cli.web_server_sessions import _open_session_db_for_profile
    sid = f'f6b-{source}-{uuid.uuid4().hex[:8]}'
    with _config_profile_scope(BOT):
        db = _open_session_db_for_profile(BOT, read_only=False)
        try:
            db.create_session(sid, source)
            if ended:
                db.end_session(sid, 'done')
        finally:
            db.close()
    return sid


def wait_row(kind, session, prompt='Posso apagar a pasta?'):
    """The row the hook writes on `on_human_input_request`; returns the request id."""
    plugin()
    import luvebot_backend.hook_store as store
    request_id = uuid.uuid4().hex
    store.record_event(DB, BOT, f'human_input:{kind}', None, 'waiting', prompt, None, session, request_id, None)
    return request_id


def resolve_row(kind, session, request_id):
    import luvebot_backend.hook_store as store
    store.record_event(DB, BOT, f'human_input:{kind}', None, 'resolved', 'submitted', None, session, request_id, None)


def waits(browser, bot=BOT):
    response = get(browser, f'/waiting?bot={bot}')
    assert response.status == 200, response.text()
    no_secret(response.body(), '/waiting')
    return response.json()


def test_the_route_answers_in_the_contract_shape_and_knows_its_bots(human_browser):
    body = get(human_browser, '/waiting').json()
    assert set(body) == {'waiting', 'partial'} and isinstance(body['waiting'], list) and isinstance(body['partial'], list)
    assert get(human_browser, '/waiting?bot=nobody-here').status == 404
    assert error_of(get(human_browser, '/waiting?bot=nobody-here'))['code'] == 'bot_not_found'


def test_a_wait_appears_with_its_platform_and_goes_when_it_is_resolved(human_browser):
    session = new_session('cli')
    request_id = wait_row('clarify', session)
    item = next(i for i in waits(human_browser)['waiting'] if i['request_id'] == request_id)
    assert item['bot'] == BOT and item['kind'] == 'clarify' and item['platform'] == 'cli' and item['session_id'] == session
    assert item['prompt'] == 'Posso apagar a pasta?' and isinstance(item['since'], float)
    bot = get(human_browser, f'/bots/{BOT}').json()                  # the Bot itself, not wrapped (like every other test of this route)
    assert bot['status'] == 'waiting_approval' and bot['status_reason'] in (None, 'question')       # an approval elsewhere (None) beats a question
    resolve_row('clarify', session, request_id)
    assert request_id not in {i['request_id'] for i in waits(human_browser)['waiting']}


def test_the_inbox_is_not_shown_twice_and_an_ended_session_is_dropped(human_browser):
    api_session, tg_session, over = new_session('api_server'), new_session('telegram'), new_session('cli', ended=True)
    mine = wait_row('approval', api_session)                 # a run's approval: LuveBot's inbox has it
    elsewhere = wait_row('approval', tg_session)             # one on Telegram: exactly what the inbox does not show
    question = wait_row('clarify', api_session)              # a clarify of an API run stays (the card comes from pending_controls)
    haunted = wait_row('clarify', over)                      # its session ended: nobody waits on it
    password = wait_row('sudo', tg_session, prompt='sudo rm -rf /')
    ids = {i['request_id']: i for i in waits(human_browser)['waiting']}
    assert mine not in ids and haunted not in ids
    assert elsewhere in ids and question in ids and password in ids
    assert ids[password]['prompt'] is None and ids[elsewhere]['prompt'] is None and ids[question]['prompt']   # only a question shows its text
    for request_id, session, kind in ((elsewhere, tg_session, 'approval'), (question, api_session, 'clarify'), (password, tg_session, 'sudo')):
        resolve_row(kind, session, request_id)


def test_the_activity_lists_a_wait_of_no_run_of_ours_as_its_own_item(human_browser):
    session = new_session('cli')
    request_id = wait_row('clarify', session)
    items = get(human_browser, '/activity?tab=running&limit=100').json()['items']
    item = next(i for i in items if i['id'] == f'waiting:{request_id}')
    assert item['kind'] == 'waiting' and item['status'] == 'waiting_approval' and item['bot'] == BOT and item['title'] is None
    assert item['links'] == {'session_id': session} and item['wait']['kind'] == 'clarify'
    refused = post(human_browser, f'/activity/waiting:{request_id}/stop', {})
    assert refused.status == 404 and error_of(refused)['code'] == 'activity_not_found'      # no id any action path accepts
    resolve_row('clarify', session, request_id)
