"""The rules the screen's AA-2 tests read (tests/unit/rules/always-allow-real.test.tsx) are the REAL API's: `rules.draft_from_always_allow` (the card's "Sempre permitir") through `rules_store.api_dict` (AA-1's `exact`, AA-1b's `covers`
and the API shape of `match`: toolsets, mcp_servers, conditions as objects): the draft of a command, the same draft edited with a `*`, the draft of a tool that carries no command, and the draft of a file.

If this fails the API changed what it answers (a field, a name, the value of `exact` or `covers`): read the difference, make the screen follow (dashboard/src/components/rules/RulesView.tsx) and regenerate the file with
`REGEN_RULES_FIXTURE=1 python -m pytest tests/unit/backend/test_rules_screen_fixture.py` (the `covers` of the file is written by `contract_covers` below until the engine sends it, A-286, then the engine's own is what is compared)."""
import dataclasses
import json
import os
from pathlib import Path

import backend.rules as rules
import backend.rules_store as store
from backend.rules_types import Action

DATA = Path(__file__).resolve().parents[1] / 'rules' / 'fixtures' / 'rules-always-allow-real.json'
ABOUT = 'Rules as the REAL API says them (rules.draft_from_always_allow -> rules_store.api_dict, AA-1 and AA-1b). Regenerate: REGEN_RULES_FIXTURE=1 python -m pytest tests/unit/backend/test_rules_screen_fixture.py'
NAMES = ('exact', 'wider', 'whole_tool', 'file')


def contract_covers(rule):
    """`covers` as plugin-api-v0.11.md section 11 (A-286) defines it, read off an API rule: the oracle the screen's fixture is checked against."""
    if rule['exact'] is not True:
        return 'wider'
    if rule['match']['commands']:
        return 'command'
    return 'facts' if rule['match']['conditions'] else 'tool'


def answers():
    exact = rules.draft_from_always_allow(Action(bot='vendas', tool='terminal', command='curl -X POST https://api.example.com/sync'), label='Permitir curl no Vendas', rule_id='aa-1')
    wider = dataclasses.replace(exact, id='aa-2', match=dataclasses.replace(exact.match, commands=('curl *',)))
    whole = rules.draft_from_always_allow(Action(bot='vendas', tool='web_search'), label='Permitir web_search no Vendas', rule_id='aa-3')
    file = rules.draft_from_always_allow(Action(bot='vendas', tool='write_file', facts=(('path', 'workspace:notas/a.md'),)), label='Permitir write_file no Vendas', rule_id='aa-4')
    return {name: store.api_dict(rule) for name, rule in zip(NAMES, (exact, wider, whole, file))}


def test_the_frozen_rules_are_what_the_api_says_now():
    now = answers()
    for rule in now.values():
        rule.setdefault('covers', contract_covers(rule))   # the engine's own, once AA-1b sends it; until then the contract's definition
    now = {'_about': ABOUT, **now}
    if os.environ.get('REGEN_RULES_FIXTURE'):
        DATA.parent.mkdir(exist_ok=True)
        DATA.write_text(json.dumps(now, indent=1, ensure_ascii=True) + chr(10))
    assert json.loads(DATA.read_text()) == json.loads(json.dumps(now)), 'the API answers something else than the file the screen is tested with: see the docstring'


def test_the_four_are_what_the_screen_expects_of_them():
    got = answers()
    assert got['exact']['exact'] is True and got['exact']['state'] == 'draft' and got['exact']['origin'] == 'always_allow'
    assert got['wider']['exact'] is False and got['wider']['match']['commands'] == ['curl *']
    assert got['whole_tool']['exact'] is True and got['whole_tool']['match']['commands'] == [] and got['whole_tool']['match']['conditions'] == []
    assert got['file']['exact'] is True and got['file']['match']['commands'] == [] and got['file']['match']['conditions']
    assert {name: contract_covers(rule) for name, rule in got.items()} == {'exact': 'command', 'wider': 'wider', 'whole_tool': 'tool', 'file': 'facts'}


def test_when_the_engine_sends_covers_it_is_the_contracts():
    for name, rule in answers().items():
        if 'covers' in rule:   # AA-1b: the field of the engine, beside `exact` (a boolean that never becomes a string)
            assert rule['covers'] == contract_covers(rule), name
            assert rule['exact'] is True or rule['exact'] is False, name
