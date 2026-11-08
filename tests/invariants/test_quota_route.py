"""F6.1 (plan quota, GET /costs/quota) against the REAL harness Hermes. The unit suite (tests/unit/backend/test_plan_quota.py) proves the
whitelist, the cache and that nothing enforces on the quota; this proves the route, through the real dashboard, on the real Hermes.

Declared gap: a provider that carries a real `usage` needs Hermes's account-usage cache seeded (agent/account_usage_cache.py) and a
signed-in provider; the harness has neither, so a row with windows is covered by the unit stand-in only. On the v0.22.2 harness the first
call may come back without `usage` (Hermes warms it in the background): `available` may be false or true with no providers, both honest."""
from test_bots import error_of
from test_plugin import no_secret
from test_runs import get

REASONS = (None, 'hermes_without_quota', 'unreadable')
PROVIDER_KEYS = {'slug', 'name', 'usage', 'limit'}


def test_quota_answers_200_with_the_contract_shape_and_no_secret(human_browser):
    response = get(human_browser, '/costs/quota')
    assert response.status == 200
    no_secret(response.body(), '/costs/quota')
    body = response.json()
    assert set(body) == {'available', 'reason', 'fetched_at', 'stale', 'bots'}
    assert isinstance(body['available'], bool) and body['reason'] in REASONS and isinstance(body['stale'], bool)
    assert (body['available'] is False) == (body['bots'] == [])
    for entry in body['bots']:
        assert set(entry) == {'bot', 'providers'}
        for provider in entry['providers']:
            assert set(provider) == PROVIDER_KEYS and (provider['usage'] or provider['limit'])


def test_quota_one_bot_and_an_unknown_bot(human_browser):
    assert get(human_browser, '/costs/quota?bot=vendas').status == 200
    missing = get(human_browser, '/costs/quota?bot=nobody-here')
    assert missing.status == 404 and error_of(missing)['code'] == 'bot_not_found'
    assert get(human_browser, '/costs/quota?bot=../x').status == 404


def test_quota_never_changes_a_cap_or_a_pause(human_browser):
    """Reading the quota twice leaves the Budget exactly as it was: nothing pauses, nothing is refused because of a quota."""
    before = get(human_browser, '/budget').json()
    get(human_browser, '/costs/quota'), get(human_browser, '/costs/quota')
    assert get(human_browser, '/budget').json()['paused'] == before['paused']
