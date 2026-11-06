"""DT-7 (ii) (contract v0.11 section 5.1, A-173): the operator declares `LUVEBOT_PERSON_PROVIDERS=session-token,drain-secret,basic` in the environment the stack STARTS with, and Hermes `main`'s deployment token is still
not a person.

`session-token` and `drain-secret` are named in the list and are never people (a name is refused, counted and logged, never added), `basic` is a person's login already (no change): so `GET /health`
`auth.person_providers` is exactly `[basic, nous, self-hosted]`, the deployment token answers `403 credential_not_human` on a route that needs a person, with the words of the contract, and a person's `basic`
login still decides (it passes the same gates). LuveBot says how many entries it ignored, never their text.

It runs ONLY on a stack started with that value and the deployment token (main):
    LUVEBOT_PERSON_PROVIDERS=session-token,drain-secret,basic HERMES_DASHBOARD_SESSION_TOKEN=<token> HH=<main H> one.sh dt7ii <worktree> "test_zz_person_providers_declared.py test_zz_deployment_token_main.py\""""
import json
import os

import pytest

from support import DASHBOARD
from test_hook import ROOT_HOME
from test_zz_deployment_token_main import TOKEN, UNKNOWN, WORDS, call, with_the_token

DECLARED = 'session-token,drain-secret,basic'
pytestmark = pytest.mark.skipif(os.environ.get('LUVEBOT_PERSON_PROVIDERS') != DECLARED or not TOKEN or TOKEN.startswith('file:'),
                                reason='needs a Hermes main stack started with LUVEBOT_PERSON_PROVIDERS=' + DECLARED + ' and HERMES_DASHBOARD_SESSION_TOKEN=<token>')


def health():
    status, data, text = call('GET', '/health', TOKEN)
    assert status == 200, (status, text[:200])
    return data


def test_the_two_never_people_in_the_list_change_nothing(human_browser):
    assert health()['auth']['person_providers'] == ['basic', 'nous', 'self-hosted']
    # the deployment token still READS and does not decide: the words of the contract, and nothing echoes the credential
    assert call('GET', '/session', TOKEN)[0] == 200
    status, data, text = with_the_token('POST', f'/approvals/{UNKNOWN}/resolve', {'digest': '0' * 64, 'choice': 'deny'})
    assert (status, data['error']['code'], data['error']['message']) == (403, 'credential_not_human', WORDS), text[:300]
    assert TOKEN not in text
    # a person's `basic` login still passes the same gate: what answers is the domain (404 for an id that does not exist), never 401 or 403
    from test_bots import csrf
    resolve = human_browser.request.post(DASHBOARD + f'/api/plugins/luvebot/approvals/{UNKNOWN}/resolve', data={'digest': '0' * 64, 'choice': 'deny'}, headers={'X-LuveBot-CSRF': csrf(human_browser)})
    assert resolve.status not in (401, 403), (resolve.status, resolve.text()[:200])


def test_luvebot_says_how_many_entries_it_ignored_and_never_their_text():
    text = ''.join(line for path in (ROOT_HOME / 'logs').glob('*.log') for line in path.read_text(errors='replace').splitlines(True) if ' luvebot.identity' in line)
    assert 'LUVEBOT_PERSON_PROVIDERS: 2 entries ignored' in text, text[-400:]               # `session-token` and `drain-secret`
    assert 'session-token,' not in text and 'drain-secret,' not in text and DECLARED not in text
    assert json.dumps(health()).count('session-token') == 0                                   # nor does /health list them
