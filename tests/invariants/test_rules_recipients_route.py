"""Rules conditions v0 step 22b through the real plugin: a rule with a `recipient` condition is created and read in the API form `{fact, op: "eq", value}`,
refused under its own code when the tool has no adapter for the fact (422 condition_needs_adapter_tools) or the value is not a tag (422
bad_recipient_condition); the simulator takes recipient facts, labels them lexical and runs the same hook_verdict; the seal says only the adapter tools are
read and is BROKEN with `hook_outdated` while the installed hook is older than 0.7.0. The engine and its mutations: tests/unit/backend/test_rules_recipients.py.
WRITTEN, NOT RUN."""
from test_bots import error_of, post
from test_rules_api import activate_rule, archive_rule, body, create, find, rules_of, simulate

A, B = 'chat:telegram:111', 'chat:telegram:222'
COND = [{'fact': 'recipient', 'op': 'eq', 'value': A}]


def test_a_recipient_rule_through_the_api(human_browser):
    wrong_tool = post(human_browser, '/rules', body(label='Arquivo', level='ask', match={'tools': ['write_file'], 'conditions': COND}))
    assert wrong_tool.status == 422 and error_of(wrong_tool)['code'] == 'condition_needs_adapter_tools'
    bad_value = post(human_browser, '/rules', body(label='Nome', level='ask', match={'tools': ['cronjob_manage'], 'conditions': [
        {'fact': 'recipient', 'op': 'eq', 'value': '#geral'}]}))
    assert bad_value.status == 422 and error_of(bad_value)['code'] == 'bad_recipient_condition'
    assert post(human_browser, '/rules', body(label='Domínio', level='ask', match={'tools': ['cronjob_manage'], 'conditions': [
        {'fact': 'recipient', 'op': 'domain', 'value': 'example.org'}]})).status == 422                                  # reserved: no operator but eq

    rule = create(human_browser, label='Perguntar para este chat', level='ask', match={'tools': ['cronjob_manage'], 'conditions': COND})
    try:
        assert rule['match']['conditions'] == COND
        assert find(rules_of(human_browser), rule['id'])['rule']['match']['conditions'] == COND
        activate_rule(human_browser, rule, accept_unapplied=True)
        inside = simulate(human_browser, tool='cronjob_manage', facts=[{'fact': 'recipient', 'value': A}])
        assert inside['decision']['winner'] == rule['id'] and inside['caveats'] == ['recipients_lexical']
        assert simulate(human_browser, tool='cronjob_manage', facts=[{'fact': 'recipient', 'value': B}])['decision']['winner'] != rule['id']
        assert simulate(human_browser, tool='cronjob_manage', facts=[{'fact': 'recipient', 'value': 'unresolved'}])['decision']['winner'] == rule['id']
        seal = inside['seals'][rule['id']]
        assert 'conditions_adapter_tools_only' in seal['qualifiers'] and 'condition_ignored' not in seal['qualifiers']
        assert seal['seal'] in ('hand', 'broken')                                                                         # broken + hook_outdated until hook 0.7.0
    finally:
        archive_rule(human_browser, rule['id'])
