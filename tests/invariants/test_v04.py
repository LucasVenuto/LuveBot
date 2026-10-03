"""T7.B1: contract v0.4 (B1 history, B2 unread, B3 pause, B4 introduction, B6 SOUL, B7 working) against the REAL harness:
real Hermes, real gateway, real dashboard with the mounted plugin; only the model is fake. Hermes-side state (sessions of a
channel, a SOUL with the managed block, a foreign ESTOP) is written with Hermes's own classes and functions, the way Hermes
would. Each acceptance test has a mutation in tests/harness/mutate_v04.py that turns it red.
"""
import json
from pathlib import Path
import sqlite3
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from support import DASHBOARD, plugin
from test_bots import DB, audit_rows, csrf, error_of, post
from test_hook import loopback_request, run_async, run_to_end, wait_for, wait_live
from test_phase4 import clean, made_names, new_routine  # noqa: F401  (`clean` removes the routines made and the budget)
from test_phase5 import MADE_ROOMS, make_room, send, tidy_phase5  # noqa: F401  (autouse: hooks live, rooms removed)
from test_plugin import PREFIX, no_secret, routes
from test_runs import get, wait_run

ROOT = Path('/root/.hermes')
VENDAS = ROOT / 'profiles/vendas'
CANARY = 'sk-' + 'a1b2c3d4e5f6' * 3          # a key shape Hermes's redactor masks
NEW_ROUTES = [('GET', '/bots/{bot}/sessions'), ('GET', '/bots/{bot}/sessions/{sid}/messages'), ('POST', '/bots/{bot}/read'),
              ('POST', '/bots/{bot}/pause'), ('POST', '/bots/{bot}/resume'), ('POST', '/pause-all'), ('POST', '/resume-all'),
              ('GET', '/bots/{bot}/introduction'), ('POST', '/bots/{bot}/introduction'), ('GET', '/bots/{bot}/soul'),
              ('PUT', '/bots/{bot}/soul'), ('PUT', '/bots/{bot}/description')]
SEEDED = []


def put(browser, path, body, token='valid'):
    headers = {'X-LuveBot-CSRF': csrf(browser) if token == 'valid' else token}
    return browser.request.put(DASHBOARD + PREFIX + path, data=body, headers=headers)


def sql(query, args=()):
    conn = sqlite3.connect(DB)
    try:
        rows = conn.execute(query, args).fetchall()
        conn.commit()
        return rows
    finally:
        conn.close()


def store(home=VENDAS):
    from hermes_state import SessionDB
    return SessionDB(home / 'state.db')


def seed(source, *, messages=(), title=None, ended=False, system_prompt=None, home=VENDAS):
    """A session written through Hermes's SessionDB, as a gateway, cron or room would write it."""
    sid = f't7b1_{source}_{uuid.uuid4().hex[:10]}'
    SEEDED.append((home, sid))
    db = store(home)
    try:
        db.create_session(sid, source, system_prompt=system_prompt)
        for message in messages:
            db.append_message(sid, **message)
        if ended:
            db.end_session(sid, 'test')
    finally:
        db.close()
    if title is not None:
        conn = sqlite3.connect(home / 'state.db')
        conn.execute('UPDATE sessions SET title=? WHERE id=?', (title, sid))
        conn.commit()
        conn.close()
    return sid


def bot(browser, name):
    response = get(browser, '/bots')
    assert response.status == 200, response.text()
    return {b['name']: b for b in response.json()['bots']}[name]


def estop(profile):
    return (ROOT if profile == 'default' else ROOT / 'profiles' / profile) / 'ESTOP'


def with_template(bot='vendas', template='sales'):
    """A Bot made by the harness entrypoint has no bot_meta row yet: create it (defaults) and record its template."""
    plugin()
    from luvebot_backend.bot_meta import BotMeta
    meta = BotMeta(DB)
    meta.upsert(bot, {})
    meta.set_template(bot, template)


def intro_session(bot='vendas'):
    rows = sql('SELECT intro_session_id FROM bot_meta WHERE bot=?', (bot,))
    return rows[0][0] if rows else None


def iso(moment):
    return moment.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


@pytest.fixture(autouse=True)
def tidy_v04():
    yield
    for path in (estop('default'), estop('vendas')):
        path.unlink(missing_ok=True)
    for table in ('bot_user_pause', 'bot_user_jobs', 'bot_read_state'):
        try:
            sql(f'DELETE FROM {table}')
        except sqlite3.OperationalError:
            pass
    try:
        sql("UPDATE bot_meta SET template_id=NULL, intro_session_id=NULL, intro_run_id=NULL WHERE bot='vendas'")
    except sqlite3.OperationalError:
        pass
    for home, sid in SEEDED:
        conn = sqlite3.connect(home / 'state.db')
        conn.execute('DELETE FROM messages WHERE session_id=?', (sid,))
        conn.execute('DELETE FROM sessions WHERE id=?', (sid,))
        conn.commit()
        conn.close()
    SEEDED.clear()


def test_new_routes_are_in_the_router_so_the_401_sweep_covers_them_and_mutations_need_csrf(human_browser):
    found = set(routes())
    for method, path in NEW_ROUTES:
        assert (method, PREFIX + path) in found, (method, path)
    for method, path in [r for r in NEW_ROUTES if r[0] != 'GET']:
        url = DASHBOARD + PREFIX + path.replace('{bot}', 'vendas')
        response = human_browser.request.fetch(url, method=method, data={}, headers={'X-LuveBot-CSRF': 'wrong'})
        assert response.status == 403 and error_of(response)['code'] == 'csrf_required', (path, response.text())
    assert not estop('vendas').exists() and not estop('default').exists()


def test_audit_first_a_failed_intent_row_leaves_every_effect_undone(human_browser):
    """Invariant 5: the intent row is written before the effect; when it cannot be written nothing happens."""
    with_template()
    soul = get(human_browser, '/bots/vendas/soul').json()
    description = bot(human_browser, 'vendas')['description']
    sql("CREATE TRIGGER t7b1_audit_fault BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'test'); END")
    try:
        for response in (post(human_browser, '/bots/vendas/pause', {}), post(human_browser, '/pause-all', {}),
                         post(human_browser, '/bots/vendas/read', {'through': iso(datetime.now(timezone.utc))}),
                         post(human_browser, '/bots/vendas/introduction', {'confirm_cost': True}),
                         put(human_browser, '/bots/vendas/soul', {'content': 'MUST_NOT_WRITE', 'expected_digest': soul['expected_digest']}),
                         put(human_browser, '/bots/vendas/description', {'description': 'MUST_NOT_WRITE'})):
            assert response.status == 503 and error_of(response)['code'] == 'audit_unavailable', response.text()
    finally:
        sql('DROP TRIGGER t7b1_audit_fault')
    assert not estop('vendas').exists() and not estop('default').exists() and not sql('SELECT * FROM bot_user_pause')
    assert not sql('SELECT * FROM bot_read_state') and get(human_browser, '/bots/vendas/soul').json() == soul
    assert intro_session() is None
    assert bot(human_browser, 'vendas')['description'] == description


# ---- B1 ----------------------------------------------------------------------------------------------------------------
def test_history_redacted(human_browser):
    call = [{'id': 'call_1', 'type': 'function', 'function': {'name': 'terminal', 'arguments': json.dumps({'command': 'echo ' + CANARY})}}]
    sid = seed('api_server', title='about ' + CANARY, system_prompt='SYSTEM ' + CANARY, messages=[
        {'role': 'user', 'content': 'my key is ' + CANARY},
        {'role': 'assistant', 'content': 'checking', 'tool_calls': call},
        {'role': 'tool', 'content': 'printed ' + CANARY, 'tool_name': 'terminal', 'tool_call_id': 'call_1'},
        {'role': 'assistant', 'content': 'done'}])
    room = seed('bot_room', messages=[{'role': 'user', 'content': 'room text'}])
    other = seed('api_server', home=ROOT, messages=[{'role': 'user', 'content': 'default profile text'}])

    listed = get(human_browser, '/bots/vendas/sessions?limit=100')
    assert listed.status == 200, listed.text()
    ids = [s['id'] for s in listed.json()['sessions']]
    assert sid in ids and room not in ids and other not in ids
    row = next(s for s in listed.json()['sessions'] if s['id'] == sid)
    assert row['kind'] == 'conversation' and row['message_count'] == 4 and CANARY not in listed.text()

    page = get(human_browser, f'/bots/vendas/sessions/{sid}/messages')
    assert page.status == 200, page.text()
    messages = page.json()['messages']
    assert [m['role'] for m in messages] == ['user', 'assistant', 'tool', 'assistant']
    assert messages[1]['tool_calls'] == [{'name': 'terminal', 'args_summary': None}]
    assert messages[2]['tool_name'] == 'terminal' and 'printed' in messages[2]['text']
    assert CANARY not in page.text() and 'SYSTEM' not in page.text() and 'system_prompt' not in page.text()
    no_secret(page.text(), 'history')
    for missing in (room, other, 'nope_' + uuid.uuid4().hex):
        refused = get(human_browser, f'/bots/vendas/sessions/{missing}/messages')
        assert refused.status == 404 and error_of(refused)['code'] == 'session_not_found', missing


def test_direct_sessions_not_used():
    src = Path(plugin().__file__).parents[1] / 'dashboard/src'
    used = [str(p) for p in src.rglob('*.ts*') if '/api/sessions' in p.read_text()]
    assert used == [], used  # the browser reads history only through /api/plugins/luvebot (A-45)


# ---- B2 ----------------------------------------------------------------------------------------------------------------
def mark(browser, through):
    return post(browser, '/bots/vendas/read', {'through': through})


def test_unread_moves_forward_only(human_browser):
    first = mark(human_browser, iso(datetime.now(timezone.utc)))
    assert first.status == 200, first.text()
    assert first.json()['unread']['replies'] == 0 and first.json()['unread']['routine_results'] == 0
    since = first.json()['unread']['since']

    reads = len(audit_rows('bot.read'))
    stale = mark(human_browser, iso(datetime.now(timezone.utc) - timedelta(days=1)))
    assert stale.status == 200 and stale.json()['unread']['since'] == since
    assert len(audit_rows('bot.read')) == reads                                                     # a no-op writes no audit row
    assert mark(human_browser, 'yesterday').status == 422
    assert mark(human_browser, '2026-10-01T10:00:00+03:00').status == 422                            # UTC only

    run_to_end(human_browser, 'vendas', 'hello')
    seed('cron', messages=[{'role': 'assistant', 'content': 'routine result'}], ended=True)
    unread = wait_for(lambda: (u := bot(human_browser, 'vendas')['unread'])['count'] >= 2 and u, 20, 'the reply and the routine result')
    assert unread['replies'] == 1 and unread['routine_results'] == 1 and unread['since'] == since

    time.sleep(1.1)
    future = mark(human_browser, iso(datetime.now(timezone.utc) + timedelta(hours=1)))
    assert future.status == 200 and future.json()['unread']['since'] <= time.time() + 61       # clamped to now + 60 s
    assert future.json()['unread']['count'] == 0
    assert mark(human_browser, iso(datetime.now(timezone.utc) + timedelta(hours=2))).status == 429   # one move per second
    assert len(audit_rows('bot.read')) == reads + 2                                # one move: intent + result rows


# ---- B3 ----------------------------------------------------------------------------------------------------------------
def foreign_pause(profile):
    """What `hermes pause` run inside that profile does."""
    plugin()
    from agent import estop as hermes_estop
    from hermes_cli.web_routers._common import _config_profile_scope
    with _config_profile_scope(profile):
        hermes_estop.engage(reason='operator maintenance')


def test_pause_scope(human_browser):
    paused = post(human_browser, '/bots/vendas/pause', {'reason': 'lunch'})
    assert paused.status == 200 and paused.json() == {'paused': True, 'scope': 'profile'}, paused.text()
    assert json.loads(estop('vendas').read_text())['reason'].startswith('luvebot:user:') and not estop('default').exists()
    seen = bot(human_browser, 'vendas')
    assert (seen['status'], seen['status_reason']) == ('paused', 'user')                             # H-B3 (c): the reason round-trips
    assert bot(human_browser, 'default')['status'] != 'paused'
    assert post(human_browser, '/bots/vendas/pause', {}).status == 200                             # idempotent

    assert post(human_browser, '/pause-all', {}).status == 200 and estop('default').exists()
    assert get(human_browser, '/bots').json()['fleet'] == {'paused': True, 'reason_kind': 'all'}
    refused = post(human_browser, '/bots/vendas/resume', {})
    assert refused.status == 409 and error_of(refused)['code'] == 'paused_all'
    assert estop('default').exists() and estop('vendas').exists()                                   # disengage() was not called
    assert post(human_browser, '/resume-all', {}).status == 200 and not estop('default').exists()
    assert estop('vendas').exists() and bot(human_browser, 'vendas')['status'] == 'paused'           # the Bot's own pause stays

    from luvebot_backend.audit import AuditLog
    from luvebot_backend.budget import Budget
    Budget(DB, audit=AuditLog(DB)).on_breach('vendas')
    held = post(human_browser, '/bots/vendas/resume', {})
    assert held.status == 409 and error_of(held)['code'] == 'budget_held'
    sql('DELETE FROM budget_pauses')
    resumed = post(human_browser, '/bots/vendas/resume', {})                                         # H-B3 (b): only the Bot's sentinel
    assert resumed.status == 200 and not estop('vendas').exists() and not estop('default').exists()

    foreign_pause('vendas')
    assert bot(human_browser, 'vendas')['status_reason'] == 'estop'
    refused = post(human_browser, '/bots/vendas/resume', {})
    assert refused.status == 409 and error_of(refused)['code'] == 'not_ours' and estop('vendas').exists()
    assert post(human_browser, '/bots/vendas/pause', {}).status == 200                             # a pause on a pause keeps its owner
    assert json.loads(estop('vendas').read_text())['reason'] == 'operator maintenance'
    estop('vendas').unlink()
    sql('DELETE FROM bot_user_pause')
    foreign_pause('default')
    assert get(human_browser, '/bots').json()['fleet'] == {'paused': True, 'reason_kind': 'estop'}
    refused = post(human_browser, '/resume-all', {})
    assert refused.status == 409 and error_of(refused)['code'] == 'not_ours' and estop('default').exists()
    estop('default').unlink()

    default = post(human_browser, '/bots/default/pause', {})                                         # A-47: never ESTOP for default
    assert default.status == 200 and default.json()['scope'] == 'luvebot_only' and not estop('default').exists()
    seen = bot(human_browser, 'default')
    assert (seen['status'], seen['status_reason'], seen['pause_scope']) == ('paused', 'user', 'luvebot_only')
    assert bot(human_browser, 'vendas')['status'] != 'paused'
    assert post(human_browser, '/bots/default/resume', {}).status == 200 and bot(human_browser, 'default')['status'] != 'paused'
    actions = {r[0] for r in audit_rows()}
    assert {'bot.pause', 'bot.resume', 'fleet.pause', 'fleet.resume'} <= actions


def test_pause_blocks_luvebot_work(human_browser, clean):
    routine = new_routine(human_browser, clean, 't7b1-paused')
    sid = post(human_browser, '/bots/vendas/sessions', {}).json()['session']['id']
    room = make_room(human_browser)
    with_template()
    assert post(human_browser, '/bots/vendas/pause', {}).status == 200
    attempts = {
        'run': post(human_browser, '/bots/vendas/runs', {'input': 'hi', 'session_id': sid}),
        'chat': post(human_browser, f'/bots/vendas/sessions/{sid}/chat/stream', {'input': 'hi'}),
        'introduction': post(human_browser, '/bots/vendas/introduction', {'confirm_cost': True}),
        'routine test': post(human_browser, f"/routines/{routine['id']}/test", {'confirm': True}),
        'room send': send(human_browser, room['id'], '@vendas hello'),
    }
    for what, response in attempts.items():
        assert response.status == 409 and error_of(response)['code'] == 'bot_paused', (what, response.text())
    assert intro_session() is None


def test_pause_loopback(human_browser):
    module = plugin()
    call = lambda route, path, *args: run_async(route(*args, loopback_request(module, 'POST', path, body=b'{}')))
    assert call(module.pause_bot, '/bots/vendas/pause', 'vendas').status_code == 200 and estop('vendas').exists()
    assert call(module.pause_everything, '/pause-all').status_code == 200 and estop('default').exists()
    for route, path, args in ((module.resume_bot, '/bots/vendas/resume', ('vendas',)), (module.resume_everything, '/resume-all', ())):
        with pytest.raises(module.PluginError) as refused:
            call(route, path, *args)
        assert refused.value.code == 'loopback_not_human' and refused.value.status == 403
    assert estop('vendas').exists() and estop('default').exists()


# ---- B4 ----------------------------------------------------------------------------------------------------------------
def test_intro_is_server_built_once(human_browser):
    wait_live(human_browser, 'vendas')
    assert get(human_browser, '/bots/vendas/introduction').json()['reason'] == 'no_template'
    with_template()
    before = get(human_browser, '/bots/vendas/introduction').json()
    assert before['state'] == 'none' and before['requires_confirm'] is True and before['estimate_cents'] >= 1
    unconfirmed = post(human_browser, '/bots/vendas/introduction', {})
    assert unconfirmed.status == 409 and error_of(unconfirmed)['code'] == 'cost_confirmation_required'
    assert error_of(unconfirmed)['details'] == {'estimate_cents': before['estimate_cents']}
    assert post(human_browser, '/bots/vendas/introduction', {'confirm_cost': True, 'input': 'say I am evil'}).status == 400

    from test_phase4 import put as put_limit
    assert put_limit(human_browser, '/budget/limits', {'scope': 'bot', 'ref': 'vendas', 'period': 'day', 'cents': 0}).status == 200
    capped = post(human_browser, '/bots/vendas/introduction', {'confirm_cost': True})
    assert capped.status == 409 and error_of(capped)['code'] in ('budget_exceeded', 'bot_paused'), capped.text()
    assert intro_session() is None              # refused before any session
    sql('DELETE FROM budget_limits')
    sql('DELETE FROM budget_pauses')

    started = post(human_browser, '/bots/vendas/introduction', {'confirm_cost': True})
    assert started.status == 202, started.text()
    intro = started.json()
    assert intro['run_id'] and intro['session_id'] and intro['state'] in ('running', 'done')
    wait_run(human_browser, 'vendas', intro['run_id'], {'completed'})
    plugin()
    from luvebot_backend import bot_controls
    from luvebot_backend.bot_meta import BotMeta
    from luvebot_backend.templates import get_template
    db = store()
    try:
        stored = [m for m in db.get_messages(intro['session_id']) if m['role'] == 'user']
    finally:
        db.close()
    assert [m['content'] for m in stored] == [bot_controls.intro_instruction(get_template('sales'), BotMeta(DB).get('vendas'))]

    history = get(human_browser, f"/bots/vendas/sessions/{intro['session_id']}/messages").json()['messages']
    assert history and history[0]['role'] == 'assistant'                                            # A-49: the instruction is hidden
    listed = get(human_browser, '/bots/vendas/sessions?limit=100').json()['sessions']
    assert next(s for s in listed if s['id'] == intro['session_id'])['kind'] == 'introduction'

    again = post(human_browser, '/bots/vendas/introduction', {'confirm_cost': True})
    assert again.status == 200 and (again.json()['session_id'], again.json()['run_id']) == (intro['session_id'], intro['run_id'])
    assert get(human_browser, '/bots/vendas/introduction').json()['state'] == 'done'
    forced = post(human_browser, '/bots/vendas/introduction', {'confirm_cost': True, 'force': True})   # a new one, on request
    assert forced.status == 202 and forced.json()['session_id'] not in (None, intro['session_id']), forced.text()
    wait_run(human_browser, 'vendas', forced.json()['run_id'], {'completed'})


# ---- B6 ----------------------------------------------------------------------------------------------------------------
BLOCK = '<!-- luvebot:rules:begin -->\nNunca envie e-mail sem aprovação.\n<!-- luvebot:rules:end -->'


def hermes_soul(content=None):
    plugin()
    from hermes_cli.web_models import ProfileSoulUpdate
    from hermes_cli.web_routers.profiles import get_profile_soul, update_profile_soul
    if content is not None:
        run_async(update_profile_soul('vendas', ProfileSoulUpdate(content=content)))
    return run_async(get_profile_soul('vendas'))['content']


@pytest.fixture
def soul():
    original = hermes_soul()
    yield
    hermes_soul(original)


def test_soul_block_preserved(human_browser, soul):
    hermes_soul('Você é o agente de Vendas.\n\n' + BLOCK + '\n\nTom: direto.\n')
    view = get(human_browser, '/bots/vendas/soul').json()
    assert view['content'] == 'Você é o agente de Vendas.\n\n\n\nTom: direto.\n' and 'Nunca envie' not in json.dumps(view)
    assert view['rules_block']['present'] is True

    saved = put(human_browser, '/bots/vendas/soul', {'content': 'Você é o agente de Vendas.\n\n\n\nTom: caloroso.\n',
                                                     'expected_digest': view['expected_digest']})
    assert saved.status == 200, saved.text()
    assert hermes_soul() == 'Você é o agente de Vendas.\n\n' + BLOCK + '\n\nTom: caloroso.\n'           # the block, byte for byte, in place
    assert saved.json()['rules_block'] == view['rules_block']

    forged = put(human_browser, '/bots/vendas/soul', {'content': BLOCK, 'expected_digest': saved.json()['expected_digest']})
    assert forged.status == 422 and error_of(forged)['code'] == 'invalid_field'
    big = put(human_browser, '/bots/vendas/soul', {'content': 'x' * (64 * 1024 + 1), 'expected_digest': saved.json()['expected_digest']})
    assert big.status == 413

    hermes_soul(hermes_soul().replace('caloroso', 'editado pelo Bot'))                               # someone else wrote meanwhile
    stale = put(human_browser, '/bots/vendas/soul', {'content': 'mine', 'expected_digest': saved.json()['expected_digest']})
    assert stale.status == 409 and error_of(stale)['code'] == 'stale' and 'editado pelo Bot' in hermes_soul()


def test_description_goes_through_hermes(human_browser):
    original = bot(human_browser, 'vendas')['description']
    text = 'Vendas B2B ' + uuid.uuid4().hex[:6]
    try:
        changed = put(human_browser, '/bots/vendas/description', {'description': text})
        assert changed.status == 200 and changed.json()['description'] == text, changed.text()
        profiles = {p['name']: p for p in human_browser.request.get(DASHBOARD + '/api/profiles').json()['profiles']}
        assert profiles['vendas']['description'] == text and audit_rows('bot.description.update')
        assert put(human_browser, '/bots/vendas/description', {'description': 'x' * 501}).status == 422
    finally:
        put(human_browser, '/bots/vendas/description', {'description': original})


# ---- B7 ----------------------------------------------------------------------------------------------------------------
@pytest.mark.xfail(strict=True, reason='B7 desligado até provado; D-016: recurso escondido, nunca simulado')
def test_status_sources(human_browser):
    sid = seed('telegram', title='chat ' + CANARY, messages=[{'role': 'user', 'content': 'oi'}])
    # earlier tests leave api_server sessions active too; the newest active session (ours) becomes the task once the 5 s cache turns
    seen = wait_for(lambda: (b := bot(human_browser, 'vendas'))['status'] == 'working' and (b['current_task'] or {}).get('id') == sid and b,
                    20, 'the channel session to be the current task')
    assert seen['status_basis'] == 'session_recent' and seen['current_task']['kind'] == 'channel' and seen['current_task']['id'] == sid
    assert CANARY not in get(human_browser, '/bots').text()

    plugin()
    from luvebot_backend import bot_controls
    from luvebot_backend.bots import bot_object
    original = bot_controls.session_rows
    bot_controls.session_rows = lambda *a, **k: 1 / 0
    bot_controls._CACHE.clear()
    try:
        live = bot_controls.recent_sources('vendas')
    finally:
        bot_controls.session_rows = original
        bot_controls._CACHE.clear()
    assert 'sessions' in live['status_partial']
    shown = bot_object({'name': 'vendas', 'is_default': False, 'description': '', 'provider': '', 'model': ''}, {}, ({}, False), live)
    assert shown['status_partial'] == live['status_partial']                                       # reported, never read as idle silently
    source = Path(bot_controls.__file__).read_text() + Path(bot_controls.__file__).with_name('bots.py').read_text()
    assert 'active_agents' not in source and 'active_sessions' not in source                         # global counts are never attributed
