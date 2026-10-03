"""Red team gap G4.2 (ADR-002 R-9, contract v0.1 A-20): `approvals.out_of_band` tells a decision LuveBot made from one made outside it.
LuveBot claims its row ('decided' + the choice) and commits that BEFORE calling Hermes, so its own answer is always found; anything
else Hermes reports as a decision on our hook's key is out of band. Timeouts and withdrawals are not decisions.
Mutations: the claim not compared with the choice; a timeout counted as a decision; every report out of band.
"""
import importlib
import importlib.util
import itertools
import json
from pathlib import Path
import sys

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
KEY = 'plugin_rule:luvebot:builtin.sensitive_access.commands#7.0a1b2c3d4e5f6a7b'
_n = itertools.count()


def load(edit=None):
    name = f'oob_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    if not edit:
        return importlib.import_module(f'{name}.approvals')
    source = (BACKEND / 'approvals.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.approvals', loader=None))
    module.__package__ = name
    sys.modules[module.__name__] = module
    exec(compile(source.replace(*edit), str(BACKEND / 'approvals.py'), 'exec'), module.__dict__)
    return module


def row(approvals, db, request_id, status, choice, keys=(KEY,), bot='vendas'):
    conn = approvals.connect(db)
    conn.execute("INSERT INTO approvals (request_id, run_id, source, bot, surface, mechanism, command_redacted, description, pattern_keys,"
                 " allowed_choices, digest, action_class_hash, created_at, expires_at, status, decided_choice)"
                 " VALUES (?,'run_1','run',?,'run','hook_approve','chmod 600 x','d',?,'[]','g','h',1,2,?,?)",
                 (request_id, bot, json.dumps(list(keys)), status, choice))
    conn.commit()
    conn.close()


def checks(approvals, tmp_path):
    db = tmp_path / f'oob{next(_n)}.db'
    oob = lambda choice, key=KEY, bot='vendas': approvals.out_of_band(db, bot, key, choice)   # noqa: E731
    assert oob('once') is True                                     # no row of ours at all: decided outside LuveBot
    row(approvals, db, 'req_p', 'pending', None)
    assert oob('once') is True and oob('deny') is True             # ours, but still pending: LuveBot did not answer it
    row(approvals, db, 'req_d', 'decided', 'deny', keys=(KEY + 'x',))
    assert oob('deny') is True                                     # a claim on ANOTHER key (a prefix match) is not this one
    row(approvals, db, 'req_c', 'consumed', 'once')
    assert oob('once') is False                                    # LuveBot claimed exactly this answer
    assert oob('always') is True and oob('session') is True        # Hermes reports a choice LuveBot never sends
    assert oob('deny') is True                                     # LuveBot said once; someone said deny
    assert oob('smart_approve') is True                            # Hermes's smart approver is not a person in LuveBot
    assert oob('once', bot='default') is True                      # the same key on another Bot is not that Bot's claim
    for nobody in ('timeout', 'cancelled', 'notify_failed', '', None):
        assert oob(nobody) is False, nobody                        # nobody decided: nothing to report
    assert oob('once', key='terminal:rm') is False                 # not a request of our hook


def test_a_decision_luvebot_did_not_make_is_out_of_band(tmp_path):
    checks(load(), tmp_path)


@pytest.mark.parametrize('edit', [
    ("r['decided_choice'] == choice and ", ''),
    ("not (choice in DECISIONS or choice.startswith('smart_'))", 'not choice'),
    ("    return not any(r['status'] in _CLAIMED", "    return True or not any(r['status'] in _CLAIMED"),
], ids=['choice_not_compared', 'timeout_is_a_decision', 'everything_out_of_band'])
def test_each_mutation_is_caught(tmp_path, edit):
    mutant = load(edit)
    with pytest.raises(AssertionError):
        checks(mutant, tmp_path)
