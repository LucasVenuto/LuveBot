"""Contract v0.8 section 8 through the real plugin: the setting is audited; in loopback (the token names the machine) turning the
pause ON or shorter is allowed and turning it OFF or longer is refused (loopback_not_human), as is the resume; a person opening
LuveBot (GET /session) never resumes anything. The clock-driven pause and its mutations: tests/unit/backend/test_inactivity.py."""
import json

import pytest

from support import DASHBOARD, plugin
from test_bots import audit_rows, csrf, post
from test_hook import loopback_request, run_async
from test_plugin import PREFIX


def put(browser, body):
    return browser.request.put(DASHBOARD + PREFIX + '/settings/inactivity-pause', data=body, headers={'X-LuveBot-CSRF': csrf(browser)})


def test_inactivity_setting_loopback_and_resume(human_browser):
    module = plugin()
    rows = len(audit_rows('settings.inactivity_pause'))
    try:
        for days in (7.0, True, 5):
            assert put(human_browser, {'days': days}).status == 422, days
        on = run_async(module.put_inactivity_pause(loopback_request(module, 'PUT', '/settings/inactivity-pause', body=b'{"days": 14}')))
        assert on.status_code == 200 and json.loads(on.body) == {'days': 14}                     # ON in loopback: tightening
        shorter = run_async(module.put_inactivity_pause(loopback_request(module, 'PUT', '/settings/inactivity-pause', body=b'{"days": 7}')))
        assert shorter.status_code == 200
        for body in (b'{"days": null}', b'{"days": 30}'):                                         # OFF or longer: a person
            with pytest.raises(module.PluginError) as refused:
                run_async(module.put_inactivity_pause(loopback_request(module, 'PUT', '/settings/inactivity-pause', body=body)))
            assert refused.value.code == 'loopback_not_human', body
        with pytest.raises(module.PluginError) as refused:
            run_async(module.resume_after_inactivity(loopback_request(module, 'POST', '/routines/inactivity-resume')))
        assert refused.value.code == 'loopback_not_human'
        assert human_browser.request.get(DASHBOARD + PREFIX + '/settings/inactivity-pause').json()['days'] == 7
        assert human_browser.request.get(DASHBOARD + PREFIX + '/session').status == 200            # a visit resumes nothing
        resumed = post(human_browser, '/routines/inactivity-resume', {})
        assert resumed.status == 200 and resumed.json() == {'resumed': 0}
        assert len(audit_rows('settings.inactivity_pause')) - rows == 4                           # 2 changes x (intent, result)
    finally:
        assert put(human_browser, {'days': None}).status == 200                                   # back to off, by a person
