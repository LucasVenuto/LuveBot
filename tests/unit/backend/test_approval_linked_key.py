"""[Forja, stacked on Brasa's r32 test_linked_approval.py: this file pins what the request STORES from the linked description, and the shapes around it.]
Hermes >= 0.22.3 (session authority) sends an approval request with NO pattern_keys: the key our hook put there (`plugin_rule:luvebot:<rule>#<event>.<nonce>`)
is gone, and so was the tie between the request and the hook's own row (the real command and tool). Measured on the real v0.22.5: the request frame and the
run's `pending_controls` carry only `description` = the hook's message, and Hermes copies it whole. Hook 0.8.0 makes that message
`luvebot:ask:<rule>#<event id>.<nonce>` and `approvals._description_key` reads it (contract v0.9 1.9).

Pinned: the real frame links to the hook's row (command, tool, rule) and the key Hermes would have copied is rebuilt, so the out-of-band lookup still finds the
request; the description is stored as the table's text, without the per-call suffix; an old hook (`luvebot:ask:<rule>`) names the rule and no row (details
unavailable, never decided blind); every other shape names no row (text added, cut, bad nonce, a non-ASCII digit, a description that is not ours); the match is
still exact (another rule's row, another Bot's row, a row already tied to another request); and pattern_keys, when Hermes sends them, still win.
Mutations of backend/approvals.py are red."""
import importlib
import importlib.util
import itertools
import json
from pathlib import Path
import sqlite3
import sys

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()
RULE = 'builtin.sensitive_access.commands'
NONCE = '0123456789abcdef'
COMMAND = 'chmod 600 ~/.ssh/id_rsa'


def load(edit=None):
    name = f'linked_backend_{next(_n)}'
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


A = load()


def seed(approvals, db, *, rule=RULE, bot='vendas', verdict='approve', command=COMMAND):
    store = importlib.import_module(approvals.__package__ + '.hook_store')
    return store.record_event(db, bot, 'terminal', rule, verdict, f'luvebot:ask:{rule}', 't', 's', 'c', command)


def frame(description, request_id=None, **extra):
    """The approval.request of the real v0.22.5 after sse_proxy.transform (request_id := prompt_id)."""
    request_id = request_id or f'p{next(_n):031x}'
    return {'event': 'approval.request', 'run_id': 'run_1', 'kind': 'approval', 'request_id': request_id, 'prompt_id': request_id, 'execution_generation': 1,
            'command': '<terminal> (plugin approval rule)', 'description': description, 'choices': ['once', 'deny', 'session', 'always'], **extra}


def record(approvals, db, description, **extra):
    return approvals.record_request(db, 'vendas', 'run_1', 'run', frame(description, **extra), now=1000.0)


def good(event_id):
    return f'luvebot:ask:{RULE}#{event_id}.{NONCE}'


# ---- the real frame --------------------------------------------------------------------------------------------------------------------
def check_the_real_frame_links_to_the_hooks_row(approvals=A, tmp_path=None):
    db = tmp_path / f'a{next(_n)}.db'
    event = seed(approvals, db)
    row = record(approvals, db, good(event))
    assert row['mechanism'] == 'hook_approve' and row['rule_id'] == RULE and row['hook_event_id'] == event and row['details_unavailable'] == 0
    assert row['command_redacted'] == COMMAND and row['tool'] == 'terminal'                              # the real command, not Hermes's placeholder
    assert row['description'] == f'luvebot:ask:{RULE}'                                                    # the table's text: no per-call suffix
    assert json.loads(row['pattern_keys']) == [f'plugin_rule:luvebot:{RULE}#{event}.{NONCE}']            # the key Hermes would have copied


def test_the_real_frame_links_to_the_hooks_row(tmp_path):
    check_the_real_frame_links_to_the_hooks_row(A, tmp_path)


def test_the_rebuilt_key_is_the_one_the_out_of_band_lookup_finds(tmp_path):
    db = tmp_path / 'oob.db'
    event = seed(A, db)
    row = record(A, db, good(event))
    key = json.loads(row['pattern_keys'])[0]
    conn = sqlite3.connect(db)
    try:
        assert conn.execute('SELECT count(*) FROM approvals WHERE bot=? AND instr(pattern_keys, ?) > 0', ('vendas', json.dumps(key))).fetchone()[0] == 1
    finally:
        conn.close()


def test_pattern_keys_when_hermes_sends_them_still_link_and_win_over_the_description(tmp_path):
    db = tmp_path / 'old.db'
    event = seed(A, db)
    other = seed(A, db)
    row = record(A, db, good(other), pattern_keys=[f'plugin_rule:luvebot:{RULE}#{event}.{NONCE}'])
    assert row['hook_event_id'] == event and row['mechanism'] == 'hook_approve'


# ---- an older hook, and every other shape -----------------------------------------------------------------------------------------------
def test_an_older_hook_names_the_rule_and_no_row_so_details_are_unavailable(tmp_path):
    db = tmp_path / 'older.db'
    seed(A, db)
    row = record(A, db, f'luvebot:ask:{RULE}')
    assert row['mechanism'] == 'hook_approve' and row['rule_id'] == RULE and row['hook_event_id'] is None and row['details_unavailable'] == 1
    assert row['command_redacted'] == ''                                                                  # never the placeholder, never a guess


def bad_descriptions(event):
    return {
        'text added': good(event) + ' extra',
        'cut by Hermes': f'luvebot:ask:{RULE}#{event}',
        'cut in the nonce': f'luvebot:ask:{RULE}#{event}.0123',
        'bad nonce': f'luvebot:ask:{RULE}#{event}.zzzzzzzz',
        'two tails': good(event) + f'#{event}.{NONCE}',
        'no event id': f'luvebot:ask:{RULE}#.{NONCE}',
        'a non-ASCII digit': f'luvebot:ask:{RULE}#٣.{NONCE}',
        'a long id': f'luvebot:ask:{RULE}#{"9" * 18}.{NONCE}',
    }


@pytest.mark.parametrize('label', sorted(bad_descriptions(1)))
def test_every_other_shape_names_no_row(label, tmp_path):
    db = tmp_path / f'bad{next(_n)}.db'
    for _ in range(3):
        seed(A, db)                                  # row 3 exists: the Arabic-Indic digit three must not reach it
    row = record(A, db, bad_descriptions(3)[label])
    assert row['hook_event_id'] is None and row['details_unavailable'] == 1 and row['command_redacted'] == '', label


def test_a_description_that_is_not_ours_names_nothing(tmp_path):
    db = tmp_path / 'notours.db'
    event = seed(A, db)
    row = record(A, db, f'xxxxxxx:ask:{RULE}#{event}.{NONCE}')                                           # the same length as our prefix
    assert row['mechanism'] == 'command_gate' and row['hook_event_id'] is None and row['rule_id'] is None
    row = record(A, db, 'x' + good(event))                                                                # text before it: not ours either
    assert row['mechanism'] == 'command_gate' and row['hook_event_id'] is None and row['rule_id'] is None
    row = record(A, db, 'dangerous command')
    assert row['mechanism'] == 'command_gate' and row['rule_id'] is None


# ---- the match stays exact (C1) ----------------------------------------------------------------------------------------------------------
def test_another_rules_row_another_bots_row_and_a_row_already_tied_are_not_linked(tmp_path):
    db = tmp_path / 'c1.db'
    other_rule = seed(A, db, rule='builtin.other')
    other_bot = seed(A, db, bot='suporte')
    mine = seed(A, db)
    assert record(A, db, good(other_rule))['hook_event_id'] is None                                       # the row is another rule's
    assert record(A, db, good(other_bot))['hook_event_id'] is None                                        # the row is another Bot's
    assert record(A, db, good(mine))['hook_event_id'] == mine
    assert record(A, db, good(mine))['hook_event_id'] is None                                             # a second request cannot take the same row
    assert record(A, db, good(10 ** 9))['hook_event_id'] is None                                          # a row that does not exist


# ---- mutations (the two lines this file adds to record_request; the parse itself is mutated in test_linked_approval.py) -----------------------------------
LINK = "        link = _link_of(description) if not keys else None\n"
KEEP = "            rule_key, event_no, nonce, description = link  # the message as the table has it; the key as the old Hermes copied it\n            keys = [f'{HOOK_PREFIX}{rule_key}#{event_no}.{nonce}']\n"
MUTATIONS = {
    'the link is not read': (LINK, "        link = None\n"),
    'the suffix is shown': (KEEP, "            rule_key, event_no, nonce, _shown = link\n            keys = [f'{HOOK_PREFIX}{rule_key}#{event_no}.{nonce}']\n"),
    'the key is not rebuilt': (KEEP, "            rule_key, event_no, nonce, description = link\n"),
    'the key is rebuilt wrong': (KEEP, "            rule_key, event_no, nonce, description = link\n            keys = [f'{HOOK_PREFIX}{rule_key}#{event_no}']\n"),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_mutation_turns_its_test_red(label, tmp_path):
    module = load(MUTATIONS[label])
    with pytest.raises(AssertionError):
        check_the_real_frame_links_to_the_hooks_row(module, tmp_path)
