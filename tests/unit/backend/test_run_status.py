"""`contract_status` (GET /bots/{bot}/runs/{id}): Hermes v0.22.5 says `running` for a run that is working, also while it waits for the answer to a question. It read
as `unknown` + status_raw `running`, which looks like a LOST run (contract v0.9: `unknown` WITHOUT status_raw is a lost execution). A live name now keeps the contract's name
(`started`); an end that is not in the contract (`interrupted`) stays `unknown` with its raw name (the chat reads it); a real `unknown` stays `unknown`. The function is run from
its source (backend/runs.py imports Hermes's own modules, which a unit run has not)."""
from pathlib import Path
import re

import pytest

SOURCE = (Path(__file__).resolve().parents[3] / 'backend' / 'runs.py').read_text()


def load(old=None, new=None):
    text = '\n'.join(re.search(pattern, SOURCE, re.S).group(0) for pattern in (r"KNOWN = \(.*?\)\n", r"LIVE = \{.*?\}", r"def contract_status\(.*?(?=\n\n\ndef )"))
    if old is not None:
        assert text.count(old) == 1, old
        text = text.replace(old, new)
    ns = {}
    exec(text, ns)
    return ns['contract_status']


def checks(fn):
    assert fn('running') == ('started', None)                                  # a live run is a live run, not a lost one
    for known in ('started', 'queued', 'waiting_for_approval', 'stopping', 'completed', 'failed', 'cancelled'):
        assert fn(known) == (known, None), known
    assert fn('unknown') == ('unknown', None)                                  # Hermes lost the run's owner: the one case that stays `unknown` with no raw name
    assert fn('interrupted') == ('unknown', 'interrupted')                     # an END outside the contract list: unknown + the raw name (the chat reads it)
    assert fn('lost') == ('unknown', 'lost') and fn('claimed') == ('unknown', 'claimed')
    assert fn('x' * 65) == ('unknown', None) and fn('bad\nname') == ('unknown', None)
    for odd in (None, 5, ['running'], {'running': 1}, True):                   # never crashes on what a changed Hermes might send
        assert fn(odd) == ('unknown', None), odd


def test_a_running_run_is_started_and_the_rest_is_as_before():
    checks(load())


@pytest.mark.parametrize('old,new', [
    ("LIVE = {'running': 'started'}", "LIVE = {}"),
    ("LIVE = {'running': 'started'}", "LIVE = {'running': 'started', 'interrupted': 'cancelled'}"),
    ("LIVE = {'running': 'started'}", "LIVE = {'running': 'unknown'}"),
    ("    if isinstance(raw, str) and raw in LIVE:\n        return LIVE[raw], None\n", "    if raw in LIVE:\n        return LIVE[raw], 'running'\n"),
], ids=['running_is_unknown_again', 'an_end_is_called_cancelled', 'running_is_unknown', 'raw_name_kept_for_a_live_run'])
def test_each_mutation_is_caught(old, new):
    with pytest.raises(Exception):  # noqa: B017
        checks(load(old, new))
