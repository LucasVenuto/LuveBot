"""Red team (Lume, 30/10) of r55 (the chat stream says `run.queued` in OUR words when Hermes queued the turn for its next owner): the FRAME holds (11 mutations of the mapping are red in
test_gateway_draining_and_queued_chat.py: the whole sentence only, the chat surface only, the `error` event only, our text and our status, the seq a real int, the run id a string of 1 to 128).
What the frame does not reach is the LIST of what happened. The relay indexes the chat turn's run as `started` (plugin_api.py `index.add(...)`, when the stream names it); at the restart Hermes
forgets that id (a chat run id is an in-memory handle: 404, r55's own test says so), the next live read of the Bot (`_live_runs` -> `_refresh_run`) answers 404 and writes `lost`, and Activity
has no word for `lost`: `run_item` turns an unknown status into `error`. So the person is told "queued, do not send it again" and then sees the same turn as a red error in Activity, which invites the
resend (the work runs twice) that the whole slice exists to prevent. The turn itself ran once on the next owner (the harness test's `ONCE`), under another id.
FINDING F10 (Baixa, display), FIXED (r56): a run Hermes forgot is `stopped` in Activity, calm, never a red error; a plain test now, with mutations below."""
import importlib.util
from pathlib import Path
import sys
import types

import pytest

import backend.activity as activity

API = (Path(__file__).resolve().parents[3] / 'dashboard' / 'plugin_api.py').read_text()


def row(status):
    return {'run_id': 'run_1', 'bot': 'vendas', 'last_status': status, 'started_at': '2026-10-30T10:00:00Z', 'ended_at': None, 'session_id': 'sess_1', 'prompt_sha': None}


def shown(status):
    return activity.run_item(row(status), lambda iso: 0.0)['status']


def test_control_activity_names_what_hermes_said():
    assert [shown(s) for s in ('started', 'queued', 'completed', 'failed', 'cancelled', 'unknown')] == ['running', 'running', 'done', 'error', 'stopped', 'waiting_approval']


def test_control_the_path_exists_in_the_code():
    """So the finding is not a hypothesis: the relay indexes a chat run as started, and a 404 on it writes `lost`."""
    assert "index.add, run_id, bot, ids.get('session_id'), actor, 'started', sha)" in API
    refresh = API.split('def _refresh_run(', 1)[1].split('\ndef ', 1)[0]
    assert "if status == 404:\n        index.set_status(run['run_id'], 'lost')" in refresh


def test_finding_a_run_hermes_forgot_is_not_an_error_in_activity():
    assert shown('lost') != 'error'
    assert shown('lost') == 'stopped'                                                           # calm and honest: it says nothing of the outcome, so not "done" and not "running"
    assert [shown(s) for s in ('started', 'queued', 'completed', 'failed', 'cancelled', 'unknown', 'interrupted')] == ['running', 'running', 'done', 'error', 'stopped', 'waiting_approval', 'stopped']
    assert shown('mystery') == 'error' and shown('') == 'running' and shown(None) == 'running'   # the fallbacks are as before: an unknown word is still an error, no word is still running


@pytest.mark.parametrize('old,new', [
    ('        "lost": "stopped"}', '        "lost": "error"}'),
    ('        "lost": "stopped"}', '        "lost": "done"}'),
    ('        "lost": "stopped"}', '        "lost": "running"}'),
    ('"unknown": "waiting_approval",  # unknown', '"unknown": "error",  # unknown'),
], ids=['lost is an error', 'lost is done', 'lost is running', 'unknown is an error'])
def test_each_mutation_of_the_status_map_is_caught(old, new):
    path = Path(activity.__file__)
    source = path.read_text()
    assert source.count(old) == 1, old
    package = types.ModuleType('activity_pkg')
    package.__path__ = [str(path.parent)]
    sys.modules['activity_pkg'] = package
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader('activity_pkg.activity_variant', loader=None))
    module.__package__ = 'activity_pkg'
    exec(compile(source.replace(old, new), str(path), 'exec'), module.__dict__)
    status = lambda s: module.run_item(row(s), lambda iso: 0.0)['status']  # noqa: E731
    with pytest.raises(AssertionError):
        assert status('lost') == 'stopped' and status('unknown') == 'waiting_approval'
