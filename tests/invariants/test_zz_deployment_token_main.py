"""C2(c) of the early test against Hermes `main` (plan v0.3 4.3, risk 2c): who is "a person with a login" for LuveBot when the dashboard is gated and the deployment session token
(`HERMES_DASHBOARD_SESSION_TOKEN=<token>` or `file:<path>`, the `session_token` dashboard-auth plugin of Hermes main) authorizes a request.

The plugin's `verify_session` returns a Session for that token (`user_id='deployment-token'`, `provider='session-token'`, `access_token=<the token>`), and Hermes puts it in `request.state.session`:
LuveBot's `_identity` (gated mode) takes any session that has a user, a provider and a token. It runs ONLY when the stack was started with that variable (main; v0.22.5 has no such plugin);
otherwise it skips.

* no credential, a wrong token: 401 (invariant 2: the gate holds);
* the deployment token is accepted by LuveBot's session route and by reads;
* DT-2 (after DT-1, contract v0.11 section 5): the token READS (the session route, the Bots list) and does NOT decide: every route that needs a person answers `403 credential_not_human` with the
  words of the contract, whatever its first gate is (an approval, a clarify, a rule, a routine suggestion), and nothing reaches the domain; a PERSON's login (the harness's `basic`, with its
  cookie) still passes the same gates (the answer is the one for something that does not exist, 404, never 401/403)."""
import http.client
import json
import os
from urllib.parse import urlsplit

import pytest

from support import DASHBOARD

TOKEN = os.environ.get('HERMES_DASHBOARD_SESSION_TOKEN', '')
pytestmark = pytest.mark.skipif(not TOKEN or TOKEN.startswith('file:'), reason='needs a Hermes main stack started with HERMES_DASHBOARD_SESSION_TOKEN=<token> (the session_token auth plugin)')
PREFIX = '/api/plugins/luvebot'


def call(method, path, token, payload=None, extra=None):
    parts = urlsplit(DASHBOARD)
    conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=20)
    headers = {'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {}), **(extra or {})}
    conn.request(method, PREFIX + path, body=json.dumps(payload).encode() if payload is not None else None, headers=headers)
    response = conn.getresponse()
    text = response.read(20000).decode(errors='replace')
    conn.close()
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    return response.status, data, text


def test_no_credential_and_a_wrong_token_are_401():
    assert call('GET', '/session', None)[0] == 401
    assert call('GET', '/session', 'x' * 43)[0] == 401
    assert call('GET', '/session', TOKEN[:-1] + ('a' if TOKEN[-1] != 'a' else 'b'))[0] == 401


WORDS = ("This sign-in is not one LuveBot recognizes as a person's login (a deployment credential, or a provider it does not know). "
         "Sign in with a person's login, or ask the operator to declare the provider.")      # contract v0.11 section 5.1 (DT-1b)
UNKNOWN = 'a' * 32
# routes whose FIRST gate is "a person" (the ids do not exist: what answers is the gate; for a person it would be a 404/409/422 of the domain)
HUMAN_ROUTES = [('POST', f'/approvals/{UNKNOWN}/resolve', {'digest': '0' * 64, 'choice': 'deny'}),
                ('POST', f'/bots/vendas/runs/run_{UNKNOWN}/clarify', {'request_id': 'abcdef0123', 'execution_generation': 1, 'skip': True}),
                ('POST', f'/bots/vendas/runs/run_{UNKNOWN}/clarify', {'request_id': 'abcdef0123', 'execution_generation': 1, 'answer': 'x'}),
                ('POST', '/rules', {'label': 'Forja deployment token probe', 'level': 'ask', 'scope': {'kind': 'bot', 'ref': 'vendas'}, 'match': {'tools': ['send_email']}}),
                ('POST', '/bots/vendas/routine-suggestions/aaaaaaaaaaaa/accept', {}),
                ('POST', f'/bots/vendas/sessions/ses_{UNKNOWN}/fork', {})]


def with_the_token(method, path, payload):
    status, data, _text = call('GET', '/session', TOKEN)
    assert status == 200 and data and data.get('csrf'), (status, data)          # LuveBot's session route takes the token as a signed-in user: it READS
    return call(method, path, TOKEN, payload, {'X-LuveBot-CSRF': data['csrf']})


def test_the_deployment_token_reads():
    status, data, _text = call('GET', '/bots', TOKEN)
    assert status == 200 and any(b.get('name') == 'vendas' for b in (data or {}).get('bots', [])), (status, str(data)[:200])


def test_the_deployment_token_does_not_decide_anything_that_needs_a_person():
    for method, path, payload in HUMAN_ROUTES:
        status, data, text = with_the_token(method, path, payload)
        assert (status, (data or {}).get('error', {}).get('code')) == (403, 'credential_not_human'), (path, status, text[:200])
        assert (data['error'].get('message')) == WORDS, text[:200]
        assert TOKEN not in text                                                  # the credential itself is never echoed


def test_a_persons_login_still_passes_the_same_gates(human_browser):
    from test_bots import error_of, post
    resolve = post(human_browser, f'/approvals/{UNKNOWN}/resolve', {'digest': '0' * 64, 'choice': 'deny'})
    assert (resolve.status, error_of(resolve)['code']) == (404, 'approval_not_found'), resolve.text()[:200]          # the gate let a person through to the domain
    clarify = post(human_browser, f'/bots/vendas/runs/run_{UNKNOWN}/clarify', {'request_id': 'abcdef0123', 'execution_generation': 1, 'skip': True})
    assert clarify.status in (404, 409, 422) and error_of(clarify)['code'] not in ('credential_not_human', 'loopback_not_human'), clarify.text()[:200]
