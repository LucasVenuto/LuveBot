"""Rules conditions v0 step 22a through the real plugin: a rule with a `path` condition is created, listed and simulated in the API form
`{fact, op, value}`; an invalid one is refused under its own code (422); the simulator takes path facts, labels them lexical and
the seal says the rule only covers the file tools. The seal is BROKEN with `hook_outdated` while the installed hook is older than 0.6.0 (the
Forja's bump flips it). The engine, the table and their mutations: tests/unit/backend/test_rules_paths.py. WRITTEN, NOT RUN."""
from test_bots import error_of, post
from test_rules_api import activate_rule, archive_rule, body, create, find, rules_of, simulate

PAGES = [{'fact': 'path', 'op': 'under', 'value': 'workspace:pages'}]


def test_a_path_rule_through_the_api(human_browser):
    star = post(human_browser, '/rules', body(label='Todas', level='ask', match={'tools': ['*'], 'conditions': PAGES}))
    assert star.status == 422 and error_of(star)['code'] == 'path_condition_needs_file_tools'
    up = post(human_browser, '/rules', body(label='Sobe', level='ask', match={'tools': ['write_file'], 'conditions': [
        {'fact': 'path', 'op': 'under', 'value': 'workspace:pages/../etc'}]}))
    assert up.status == 422 and error_of(up)['code'] == 'bad_path_condition'
    assert post(human_browser, '/rules', body(label='Regex', level='ask', match={'tools': ['write_file'], 'conditions': [
        {'fact': 'path', 'op': 'regex', 'value': 'pages'}]})).status == 422

    rule = create(human_browser, label='Revisar antes de salvar', level='ask', match={'tools': ['write_file', 'patch'], 'conditions': PAGES})
    try:
        assert rule['match']['conditions'] == PAGES
        assert find(rules_of(human_browser), rule['id'])['rule']['match']['conditions'] == PAGES        # what is read can be sent back
        activate_rule(human_browser, rule, accept_unapplied=True)

        inside = simulate(human_browser, tool='write_file', facts=[{'fact': 'path', 'value': 'workspace:pages/a.md'}])
        assert inside['decision']['winner'] == rule['id'] and inside['caveats'] == ['paths_lexical']
        outside = simulate(human_browser, tool='write_file', facts=[{'fact': 'path', 'value': 'workspace:docs/a.md'}])
        assert outside['decision']['winner'] != rule['id']
        unresolved = simulate(human_browser, tool='write_file', facts=[{'fact': 'path', 'value': 'unresolved'}])
        assert unresolved['decision']['winner'] == rule['id']                                              # what cannot be read is asked about
        seal = inside['seals'][rule['id']]
        assert 'paths_file_tools_only' in seal['qualifiers'] and 'condition_ignored' not in seal['qualifiers']
        assert seal['seal'] in ('hand', 'broken')
        assert simulate(human_browser, tool='terminal', command='ls')['caveats'] == []
        assert post(human_browser, '/rules/simulate', {'bot': 'vendas', 'tool': 'write_file', 'facts': [
            {'fact': 'path', 'op': 'under', 'value': 'workspace:pages'}]}).status == 422                     # a fact takes no operator
    finally:
        archive_rule(human_browser, rule['id'])
