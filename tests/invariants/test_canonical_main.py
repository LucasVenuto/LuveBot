"""F4 (contract v0.9 B) against the REAL main (v0.23: a Hermes whose `/v1/capabilities` says `features.run_unknown_resolution`).
WRITTEN, NOT RUN (no disk for the harness). Everything here skips on a Hermes without the flag (v0.22.2): its format is the old one and the
rest of the suite already proves it. The unit suite (tests/unit/backend/test_canonical.py) proves the logic on a scripted Hermes; this proves
the contract on the real one: the Architect's TO VERIFY items are marked.

Declared gaps (need harness work that is not in this slice):
* `queued` / `unknown` runs: an unknown run needs a gateway killed in the middle of a run (an owner Hermes loses); no test does that yet.
* `clarify`: answered in the conversation, run for real below (G_CLARIFY needs `clarify` in the api_server toolset of the harness config).
* `POST /v1/runs` 503 `admission_queued` vs the stream's `run.queued` (which surface answers which form): TO VERIFY with a draining gateway."""
import json
import urllib.error
import urllib.request

import pytest

from support import API, credentials, plugin
from test_approvals import ask_run, list_approvals, resolve, settle, wait_pending
from test_bots import error_of, post
from test_hook import loopback_request, run_async
from test_plugin import no_secret
from test_runs import get


@pytest.fixture(scope='module')
def main():
    plugin()
    import luvebot_backend.canonical as canonical
    if not canonical.authority('vendas'):
        pytest.skip('this Hermes has no session authority (features.run_unknown_resolution is not true)')
    return canonical


def hermes_post(path, body, profile='vendas'):
    """A direct call to the Bot's API Server with its own key, the way the old LuveBot did: -> (status, parsed body or None)."""
    request = urllib.request.Request(API + f'/p/{profile}{path}', data=json.dumps(body).encode(), method='POST',
                                     headers={'Authorization': 'Bearer ' + credentials()[f'{profile}_api_key'], 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read() or b'null')
    except urllib.error.HTTPError as error:
        return error.code, None


def test_the_flag_follows_the_capabilities_of_the_harness_hermes():
    plugin()
    import luvebot_backend.canonical as canonical
    from luvebot_backend.hermes_client import HermesClient
    declared = HermesClient('vendas').capabilities().get('features', {}).get('run_unknown_resolution') is True
    assert canonical.authority('vendas') is declared


def test_the_old_approval_body_fails_and_the_canonical_one_resolves(human_browser, main):
    """The test that proves the flag turns the new format on: the old two-key body is refused by the main, ours resolves it, and a second
    answer finds nothing pending."""
    run_id = ask_run(human_browser)
    approval = wait_pending(human_browser, run_id)
    old = hermes_post(f'/v1/runs/{run_id}/approval', {'choice': 'once', 'request_id': approval['request_id']})
    assert old[0] in (400, 409), old                                              # invalid_params: the main wants the three keys
    assert any(a['request_id'] == approval['request_id'] for a in list_approvals(human_browser, 'pending')['approvals'])  # still waiting
    assert resolve(human_browser, approval, 'once').status == 200
    again = resolve(human_browser, approval, 'once')
    assert again.status == 409 and error_of(again)['code'] in ('approval_stale', 'stale', 'conflict', 'approval_not_found')
    assert settle(human_browser, run_id)['status'] == 'completed'


def test_a_waiting_run_shows_its_generation_and_the_pending_approval_without_extras(human_browser, main):
    run_id = ask_run(human_browser)
    approval = wait_pending(human_browser, run_id)
    run = get(human_browser, f'/bots/vendas/runs/{run_id}').json()['run']
    assert run['status'] == 'waiting_for_approval' and isinstance(run['execution_generation'], int)
    assert {'kind': 'approval', 'request_id': approval['request_id']} in run['pending_controls']       # request_id IS the prompt_id
    assert all(set(c) <= {'kind', 'request_id', 'question', 'choices', 'multi_select', 'timeout_s'} for c in run['pending_controls'])
    no_secret(json.dumps(run), 'GET run')
    assert resolve(human_browser, approval, 'deny').status == 200
    settle(human_browser, run_id)


def test_a_clarify_is_answered_validated_and_only_by_a_person(human_browser, main):
    """The Bot asks through Hermes's own `clarify` (G_CLARIFY: a question with the choices Sim / Não; it needs `clarify` in the api_server toolset). On a canonical Hermes the
    question is a `pending_control` of the RUN, not an event of the stream: the person answers it from the conversation, validated against the question's own choices."""
    import uuid
    from test_bots import audit_rows
    from test_hook import session, wait_for
    from test_runs import get
    started = post(human_browser, '/bots/vendas/runs', {'input': 'G_CLARIFY: pergunte antes de apagar ' + uuid.uuid4().hex[:6], 'session_id': session(human_browser, 'vendas')})
    assert started.status == 202, started.text()
    run_id = started.json()['run']['id']

    def pending():
        run = get(human_browser, f'/bots/vendas/runs/{run_id}').json()['run']
        found = next((c for c in run.get('pending_controls') or [] if c['kind'] == 'clarify'), None)
        return (run, found) if found else None
    run, control = wait_for(pending, 60, 'a clarify among the run pending_controls')
    offered = control['choices']                                                                  # Hermes decorates them ('Sim (Recommended)'): the label is what it offers, as shown
    assert run['execution_generation'] >= 0 and len(offered) == 2 and offered[0].startswith('Sim') and offered[1] == 'Não' and 'apagar' in control['question'], control
    path = f'/bots/vendas/runs/{run_id}/clarify'
    body = lambda answer: {'request_id': control['request_id'], 'execution_generation': run['execution_generation'], 'answer': answer}   # noqa: E731
    before = len(audit_rows('run.clarify'))

    wrong = post(human_browser, path, body('Talvez'))                                             # a label the question does not offer: nothing is sent
    assert wrong.status == 422 and error_of(wrong)['code'] == 'invalid_answer', wrong.text()
    assert pending() is not None                                                                  # the Bot still waits
    assert [(r[1], r[2]) for r in audit_rows('run.clarify')[before:]] == [('ok', 'intent'), ('error', 'result')]   # the attempt is audited, as refused
    before = len(audit_rows('run.clarify'))

    module = plugin()                                                                             # a loopback dashboard has no person: the machine cannot stand for one
    with pytest.raises(module.PluginError) as refused:
        run_async(module.answer_run_clarify('vendas', run_id, loopback_request(module, 'POST', path, body=json.dumps(body(offered[0])).encode())))
    assert refused.value.code == 'loopback_not_human'
    assert pending() is not None

    right = post(human_browser, path, body(offered[0]))
    assert right.status == 200 and right.json()['clarify']['status'] == 'resolved', right.text()
    assert settle(human_browser, run_id)['status'] == 'completed'                                 # the run resumed with the person's answer
    again = post(human_browser, path, body(offered[0]))
    assert again.status == 409 and error_of(again)['code'] == 'request_not_pending', again.text()
    rows = audit_rows('run.clarify')[before:]
    assert [(r[1], r[2]) for r in rows][:2] == [('ok', 'intent'), ('ok', 'result')] and rows[-2:] and [(r[1], r[2]) for r in rows][2:] == [('ok', 'intent'), ('error', 'result')], rows
    import re
    import sqlite3
    from test_bots import DB
    conn = sqlite3.connect(DB)
    try:
        everything = conn.execute("SELECT * FROM audit_log WHERE action='run.clarify' AND target=?", (run_id,)).fetchall()     # every column of every row of this run
    finally:
        conn.close()
    text = ' '.join(str(cell) for row in everything for cell in row)
    assert everything and offered[0] not in text and 'Recommended' not in text, 'the answer text must never be audited'
    digests = [cell for row in everything for cell in row if isinstance(cell, str) and re.fullmatch(r'[0-9a-f]{64}', cell)]
    assert digests, 'the payload (request id, generation, keyed digest of the answer, its length) is kept as a digest'


def other_channel_session():
    """A stored session of the Bot whose source is `cli`, made through Hermes's own SessionDB inside the Bot's scope."""
    plugin()
    from hermes_cli.web_server_profiles import _config_profile_scope
    from hermes_cli.web_server_sessions import _open_session_db_for_profile
    sid = 'f4-cli-' + __import__('uuid').uuid4().hex[:8]
    with _config_profile_scope('vendas'):
        db = _open_session_db_for_profile('vendas', read_only=False)
        try:
            db.create_session(sid, 'cli')
        finally:
            db.close()
    return sid


def test_a_session_of_another_channel_is_refused_in_words_and_can_be_forked(human_browser, main):
    sid = other_channel_session()
    refused = post(human_browser, f'/bots/vendas/sessions/{sid}/chat/stream', {'input': 'oi'})
    body = error_of(refused)
    assert refused.status == 409 and body['code'] == 'session_other_channel'
    assert body.get('details', {}).get('can_fork') is True and body['details']['source'] == 'cli'
    assert post(human_browser, '/bots/vendas/sessions/nope-123/fork', {}).status == 404
    module = plugin()                                                                          # F1: the fork ENDS that conversation, so a person
    with pytest.raises(module.PluginError) as refused:                                          # with a login: loopback names the machine
        run_async(module.fork_session('vendas', sid, loopback_request(module, 'POST', f'/bots/vendas/sessions/{sid}/fork', body=b'{}')))
    assert refused.value.code == 'loopback_not_human'
    forked = post(human_browser, f'/bots/vendas/sessions/{sid}/fork', {'title': 'copy'})   # TO VERIFY: fork of a session of another channel
    assert forked.status == 201 and forked.json()['session']['id'] != sid


def test_resolve_unknown_refuses_a_run_that_is_not_unknown(human_browser, main):
    run_id = ask_run(human_browser)
    approval = wait_pending(human_browser, run_id)
    refused = post(human_browser, f'/bots/vendas/runs/{run_id}/resolve-unknown', {'execution_generation': 0})
    assert refused.status == 409 and error_of(refused)['code'] in ('run_not_unknown', 'stale')
    assert resolve(human_browser, approval, 'deny').status == 200
    settle(human_browser, run_id)
