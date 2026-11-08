"""Contract v0.6 Part D against the REAL Hermes: PUT /bots/{bot}/approval-timeout writes through Hermes's update_config in the Bot's
profile only (the default profile's config.yaml byte-identical, the Bot's other keys equal), Hermes's own reader then says the
same value and the next request of that Bot waits that long; a Bot made by the assistant waits 1 h, one made by Hermes's own route
is untouched. The unit side (stand-in Hermes, mutations): tests/unit/backend/test_approval_timeout.py.
"""
from datetime import datetime
from pathlib import Path
import uuid

from support import DASHBOARD, plugin
from test_approvals import ask_run, resolve, settle, wait_pending
from test_bots import DB, audit_rows, csrf, error_of, new_name, post  # noqa: F401  (new_name is a fixture)
from test_pages import off_loop
from test_plugin import PREFIX

HOME = Path('/root/.hermes')


def put(browser, path, body, token='valid'):
    headers = {} if token is None else {'X-LuveBot-CSRF': csrf(browser) if token == 'valid' else token}
    return browser.request.put(DASHBOARD + PREFIX + path, data=body, headers=headers)


def config_of(bot):
    """The profile's own file as Hermes reads it (no defaults merged)."""
    from hermes_cli.config import read_raw_config
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope(bot):
        return read_raw_config() or {}


def hermes_waits(bot):
    from hermes_cli.web_server_profiles import _config_profile_scope
    from tools.approval_context import _get_approval_timeout
    with _config_profile_scope(bot):
        return _get_approval_timeout()


def test_approval_timeout_real(human_browser, monkeypatch):
    default_bytes, before = (HOME / 'config.yaml').read_bytes(), config_of('vendas')
    rows_before = len(audit_rows('approval.timeout.set'))
    for token in (None, 'wrong'):
        assert put(human_browser, '/bots/vendas/approval-timeout', {'seconds': 3600}, token).status == 403
    for bad in (3600.0, True, '3600', 7, 31536001, -1):
        response = put(human_browser, '/bots/vendas/approval-timeout', {'seconds': bad})
        assert response.status == 422 and error_of(response)['code'] == 'invalid_field', bad
    assert config_of('vendas') == before and len(audit_rows('approval.timeout.set')) == rows_before
    try:
        response = put(human_browser, '/bots/vendas/approval-timeout', {'seconds': 3600})
        assert response.status == 200 and response.json() == {'seconds': 3600, 'effective': 3600}, response.text()
        assert hermes_waits('vendas') == 3600
        after = config_of('vendas')
        assert after.get('approvals', {}).pop('timeout') == 3600
        before.get('approvals', {}).pop('timeout', None)
        assert after == before                                             # approvals.mode and every other key unchanged
        assert (HOME / 'config.yaml').read_bytes() == default_bytes        # the default profile untouched
        assert [r[:3] for r in audit_rows('approval.timeout.set')[rows_before:]] == [
            ('approval.timeout.set', 'ok', 'intent'), ('approval.timeout.set', 'ok', 'result')]
        detail = human_browser.request.get(DASHBOARD + PREFIX + '/bots/vendas').json()
        assert detail['approval_timeout'] == {'seconds': 3600, 'source': 'profile', 'run_budget_seconds': None}
        from hermes_cli.config import set_config_value, unset_config_value
        from hermes_cli.web_server_profiles import _config_profile_scope
        with _config_profile_scope('vendas'):
            set_config_value('agent.run_budget_seconds', '5400')               # F8 (A-94): a wall clock that can end a turn first
        try:
            shown = human_browser.request.get(DASHBOARD + PREFIX + '/bots/vendas').json()['approval_timeout']
            assert shown['run_budget_seconds'] == 5400
        finally:
            with _config_profile_scope('vendas'):
                unset_config_value('agent.run_budget_seconds')
        row = wait_pending(human_browser, ask_run(human_browser))          # the next request waits that long (+ the slack)
        waited = (datetime.fromisoformat(row['expires_at'].replace('Z', '+00:00'))
                  - datetime.fromisoformat(row['created_at'].replace('Z', '+00:00'))).total_seconds()
        assert abs(waited - 3630) < 1, waited
        assert resolve(human_browser, row, 'deny').status == 200
        settle(human_browser, row['run_id'])
        # Hermes keeps a different value (a clamp): 502, never a claimed success
        import tools.approval_context as context
        controls = plugin().bot_controls
        monkeypatch.setattr(context, '_get_approval_timeout', lambda: 1800)
        from luvebot_backend.audit import AuditLog
        try:
            off_loop(controls.set_approval_timeout, AuditLog(DB), 'harness', 'vendas', 14400, 'req_' + uuid.uuid4().hex)
            raise AssertionError('a clamped value was reported as set')
        except controls.PluginError as error:
            assert (error.code, error.status) == ('hermes_error', 502)
    finally:
        from hermes_cli.config import set_config_value
        from hermes_cli.web_server_profiles import _config_profile_scope
        with _config_profile_scope('vendas'):
            set_config_value('approvals.timeout', '60')                    # the harness profile's own 60 s


def test_new_bot_waits_an_hour(human_browser, new_name):
    ours, theirs = new_name, 't96-' + uuid.uuid4().hex[:8]
    try:
        assert post(human_browser, '/bots', {'name': ours}).status == 201
        assert config_of(ours)['approvals']['timeout'] == 3600
        assert hermes_waits(ours) == 3600
        detail = human_browser.request.get(DASHBOARD + PREFIX + f'/bots/{ours}').json()
        assert detail['approval_timeout'] == {'seconds': 3600, 'source': 'profile', 'run_budget_seconds': None}
        made = human_browser.request.post(DASHBOARD + '/api/profiles', data={'name': theirs})
        assert made.ok, made.text()
        assert (config_of(theirs).get('approvals') or {}).get('timeout') != 3600   # a Bot made by Hermes's own route: untouched
        assert hermes_waits(theirs) != 3600
    finally:
        human_browser.request.delete(DASHBOARD + '/api/profiles/' + theirs)
