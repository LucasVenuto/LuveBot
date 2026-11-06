"""The state of a run is the GET's, never the POST's (contract v0.9 1.6; measured on the real v0.22.5: the POST /runs of a QUEUED turn answered `started` while GET /runs/{id}
said `queued`). The run index stores the POST's word as a placeholder at creation; the next read of an open run asks Hermes (`_refresh_run`) and keeps the GET's word, and
`queued` stays OPEN. Activity has no `queued` word of its own: queued, started and running are all "running" there (a queued run is open work, never done or an error).
`_refresh_run` is run from its source with stand-ins (plugin_api imports Hermes's own modules)."""
from pathlib import Path
import re

import pytest

import backend.activity as activity

ROOT = Path(__file__).resolve().parents[3]
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
RUNS = (ROOT / 'backend' / 'runs.py').read_text()
OPEN = eval(re.search(r"^OPEN = (\{.*?\})", RUNS, re.M).group(1))  # noqa: S307  (a literal set of our own file)


class Index:
    def __init__(self):
        self.statuses = {}

    def set_status(self, run_id, status):
        self.statuses[run_id] = status


def refresh_of(source):
    text = re.search(r"def _refresh_run\(.*?(?=\n\n\nasync def |\n\n\ndef )", source, re.S).group(0)
    answers = {}

    class Hermes(Exception):
        pass

    class Api:
        def __init__(self, name):
            pass

        def call(self, method, path, timeout):
            assert method == 'GET' and path.startswith('/v1/runs/')
            return answers['get']
    ns = {'ApiClient': Api, 'HermesError': Hermes, 'OPEN_STATUSES': OPEN}
    exec(text, ns)
    return ns['_refresh_run'], answers


def checks(source):
    refresh, answers = refresh_of(source)
    index = Index()
    stored = {'run_id': 'run_1', 'last_status': 'started'}                   # what the POST said when the run was indexed
    answers['get'] = (200, {'status': 'queued'})                             # what Hermes says now
    seen = refresh(index, 'vendas', stored)
    assert index.statuses == {'run_1': 'queued'}                             # the GET's word is the one kept
    assert seen == {'run_id': 'run_1', 'last_status': 'queued'}              # and the run is still OPEN: queued is open work
    row = {'run_id': 'run_1', 'bot': 'vendas', 'session_id': 's', 'started_at': '2026-10-30T10:00:00Z', 'last_status': index.statuses['run_1'], 'prompt_sha': None, 'ended_at': None}
    assert activity.run_item(row, lambda iso: 1.0)['status'] == 'running'    # Activity: open work, not done and not an error
    answers['get'] = (200, {'status': 'running'})
    assert refresh(index, 'vendas', stored)['last_status'] == 'running' and index.statuses['run_1'] == 'running'
    answers['get'] = (200, {'status': 'completed'})
    assert refresh(index, 'vendas', stored) is None and index.statuses['run_1'] == 'completed'   # an end is not open
    answers['get'] = (404, None)
    assert refresh(index, 'vendas', stored) is None and index.statuses['run_1'] == 'lost'
    answers['get'] = (200, {'status': 'queued'})
    index.statuses.clear()
    answers['get'] = (200, {})                                               # an answer with no status: nothing is claimed, and the stored word is not used as the state
    assert refresh(index, 'vendas', stored) is None and index.statuses == {}


def test_the_get_decides_and_queued_is_open():
    checks(API)
    assert 'queued' in OPEN and activity._RUN['queued'] == 'running' and activity._RUN['started'] == 'running'


@pytest.mark.parametrize('old,new', [
    ("    index.set_status(run['run_id'], raw[:64])\n    return {**run, 'last_status': raw} if raw in OPEN_STATUSES else None",
     "    return {**run, 'last_status': raw} if raw in OPEN_STATUSES else None"),
    ("    index.set_status(run['run_id'], raw[:64])\n    return {**run, 'last_status': raw} if raw in OPEN_STATUSES else None",
     "    index.set_status(run['run_id'], raw[:64])\n    return run if raw in OPEN_STATUSES else None"),
    ("    index.set_status(run['run_id'], raw[:64])\n    return {**run, 'last_status': raw} if raw in OPEN_STATUSES else None",
     "    index.set_status(run['run_id'], run['last_status'])\n    return {**run, 'last_status': run['last_status']} if raw in OPEN_STATUSES else None"),
    ("    return {**run, 'last_status': raw} if raw in OPEN_STATUSES else None", "    return {**run, 'last_status': raw} if raw == 'running' else None"),
], ids=['the_get_is_not_kept', 'the_post_word_is_returned', 'the_post_word_is_stored_again', 'queued_is_not_open'])
def test_each_mutation_is_caught(old, new):
    assert API.count(old) == 1, old
    with pytest.raises(Exception):  # noqa: B017
        checks(API.replace(old, new))
