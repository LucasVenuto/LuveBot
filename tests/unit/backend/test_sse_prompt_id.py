"""Hermes >= v0.22.3 sends `approval.request` with `prompt_id` + `execution_generation` and NO `request_id` (measured on the real v0.22.5 run
events, 2026-10-30): LuveBot's approvals watcher died on it with `ValueError('unusable approval request')` and recorded nothing.

Pinned: the real frame becomes a request the store accepts (`request_id` = `prompt_id`), the generation and the other fields stay, an old-format
frame (a `request_id`) is untouched and a given `request_id` is never replaced, only `approval.request` is touched, and a frame with neither id is
still refused by the store. A frame with BOTH ids that differ keeps its `request_id` (the test below says so on purpose: deciding only acts on the
run's own pending_controls, so a mismatch is a refusal, never the wrong approval). Mutations of sse_proxy.py are red."""
import importlib.util
from pathlib import Path

import pytest

import backend.sse_proxy as sse_module

SOURCE = Path(sse_module.__file__)
RUN = 'run_01c32de1228548208469cce4528a4a75'
REAL = {'event': 'approval.request', 'run_id': RUN, 'timestamp': 1793337963.049741, 'kind': 'approval',
        'prompt_id': 'd8efc10fd5be4a11aaf32bd369bc5207', 'execution_generation': 1, 'command': '<terminal> (plugin approval rule)',
        'description': 'luvebot:ask:builtin.sensitive_access.commands', 'choices': ['once', 'deny', 'session', 'always'], 'seq': 1}


def same(text):
    return text


def run_events(module=sse_module, data=REAL, event='approval.request', surface='run'):
    return module.transform(surface, event, dict(data), same)


def test_the_real_v0_22_5_frame_gets_the_request_id_the_store_needs(module=sse_module):
    event, out = run_events(module)
    assert event == 'approval.request' and out['request_id'] == REAL['prompt_id']
    assert out['prompt_id'] == REAL['prompt_id'] and out['execution_generation'] == 1                       # kept, not moved
    assert out['choices'] == REAL['choices'] and out['kind'] == 'approval' and out['run_id'] == RUN
    assert run_events(module, surface='chat')[1]['request_id'] == REAL['prompt_id']                         # the chat proxy too (the UI reads request_id)


def test_an_old_format_frame_is_untouched_and_a_given_request_id_is_never_replaced(module=sse_module):
    old = {'event': 'approval.request', 'run_id': RUN, 'request_id': 'a' * 32, 'command': 'ls', 'choices': ['once', 'deny']}
    assert run_events(module, old)[1] == old                                                                 # no prompt_id: nothing added
    both = {**REAL, 'request_id': 'b' * 32}
    assert run_events(module, both)[1]['request_id'] == 'b' * 32                                             # ours is never overwritten


def test_only_approval_request_is_touched_and_no_id_stays_no_id(module=sse_module):
    other = {'event': 'message.delta', 'run_id': RUN, 'prompt_id': 'c' * 32, 'delta': 'x'}
    assert 'request_id' not in run_events(module, other, event='message.delta')[1]
    bare = {'event': 'approval.request', 'run_id': RUN, 'command': 'ls'}
    assert 'request_id' not in run_events(module, bare)[1]                                                   # the store still refuses it
    assert 'request_id' not in run_events(module, {**bare, 'prompt_id': 12345})[1]                           # only a string id


# ---- mutations --------------------------------------------------------------------------------------------------------------------
def load(edits):
    source = SOURCE.read_text()
    for old, new in edits:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    spec = importlib.util.spec_from_loader("backend.sse_proxy_under_test", loader=None)
    module = importlib.util.module_from_spec(spec)
    exec(compile(source, str(SOURCE), "exec"), module.__dict__)
    return module


GUARD = "    if event == 'approval.request' and not out.get('request_id') and isinstance(out.get('prompt_id'), str):\n"
MUTATIONS = {
    "the id is never mapped": ([("        out['request_id'] = out['prompt_id']\n", "        pass\n")], test_the_real_v0_22_5_frame_gets_the_request_id_the_store_needs),
    "a given request_id is overwritten": ([(GUARD, "    if event == 'approval.request' and isinstance(out.get('prompt_id'), str):\n")],
                                          test_an_old_format_frame_is_untouched_and_a_given_request_id_is_never_replaced),
    "every event is mapped": ([(GUARD, "    if not out.get('request_id') and isinstance(out.get('prompt_id'), str):\n")],
                              test_only_approval_request_is_touched_and_no_id_stays_no_id),
    "any prompt_id is mapped": ([("isinstance(out.get('prompt_id'), str):\n", "'prompt_id' in out:\n")],
                                test_only_approval_request_is_touched_and_no_id_stays_no_id),
    "the generation is dropped": ([("        out['request_id'] = out['prompt_id']\n", "        out['request_id'] = out.pop('prompt_id')\n        out.pop('execution_generation', None)\n")],
                                  test_the_real_v0_22_5_frame_gets_the_request_id_the_store_needs),
}


@pytest.mark.parametrize("label", sorted(MUTATIONS))
def test_each_mutation_turns_its_test_red(label):
    edits, check = MUTATIONS[label]
    with pytest.raises((AssertionError, KeyError)):                                                          # a missing key is a red result too
        check(load(edits))
