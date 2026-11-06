"""Red team F9 (cross review 2): GET /waiting read EVERY Bot's SessionDB on every poll of every open tab. Now one Bot's waits are kept 15 s (and
until anything changes), an unreadable Bot is never remembered, and the Bots are read four at a time. The route's own function is run with stand-ins."""
import asyncio
import json
from pathlib import Path
import re
import time
import types

import pytest

from backend.flight import Memo

API = (Path(__file__).resolve().parents[3] / 'dashboard' / 'plugin_api.py').read_text()


def function(source, name):
    return re.search(rf'(?:async )?def {name}\(.*?(?=\n(?:@router|def |async def |class )|\Z)', source, re.S).group(0)


class JSONResponse:
    """A stand-in for starlette's (the unit venv has no starlette): the route only builds it from a dict and headers."""
    def __init__(self, content, headers=None):
        self.body = json.dumps(content).encode()


async def _pool(fn, *args):
    return fn(*args)


def rig(source):
    now, reads, epoch, marks = [0.0], [], [0], {}

    def read(path, bot, redact):
        reads.append(bot)
        return None if bot == 'quebrado' else [{'kind': 'clarify', 'request_id': f'r-{bot}', 'since': 1.0}]

    def marker(path, bot):
        return marks.get(bot, 0)          # None = it cannot be told

    async def names():
        return ['vendas', 'suporte', 'quebrado']
    ns = {'asyncio': asyncio, 'time': types.SimpleNamespace(monotonic=lambda: now[0]), 'JSONResponse': JSONResponse, '_HEADERS': {}, 'Request': object, '_identity': lambda request: None,
          'validate_profile': lambda bot: bot, '_names': names, '_stores': lambda: (None, types.SimpleNamespace(path='x')), 'run_in_threadpool': _pool,
          'waiting': types.SimpleNamespace(read=read, marker=marker), '_REDACT': lambda text: text, '_redact_deep': lambda value: value,
          '_WAITING': Memo(15.0, clock=lambda: now[0]), '_EPOCH': epoch}
    exec(function(source, 'get_waiting'), ns)
    return lambda: json.loads(asyncio.run(ns['get_waiting'](None)).body), now, reads, epoch, marks


def checks(source):
    poll, now, reads, epoch, marks = rig(source)
    first = poll()
    assert [i['bot'] for i in first['waiting']] == ['suporte', 'vendas'] and first['partial'] == ['quebrado'] and len(reads) == 3
    now[0] += 5
    assert poll() == first and len(reads) == 4                       # 5 s later: the two readable Bots cost nothing; the unreadable one is tried again
    now[0] += 11
    poll()
    assert len(reads) == 7                                             # past 15 s: read again
    epoch[0] += 1
    poll()
    assert len(reads) == 10                                            # anything changed: never older than the change
    marks['vendas'] = 7                                                # the hook (another process) wrote a wait for vendas
    poll()
    assert reads.count('vendas') == 4 and reads.count('suporte') == 3  # vendas at once, in the same second; suporte, nothing moved, is still kept
    marks['vendas'] = None                                             # a marker that cannot be told: the key is a 3 s bucket of the clock
    now[0] = 100.0
    before = reads.count('vendas')
    poll()
    now[0] += 1
    poll()
    assert reads.count('vendas') == before + 1                         # the same bucket: one read for both (simultaneous polls are joined too)
    now[0] += 3
    poll()
    assert reads.count('vendas') == before + 2                         # the next bucket: read again (a sick database is never trusted for long)
    assert 'asyncio.Semaphore(4)' in function(source, 'get_waiting')   # and the Bots are read four at a time


def test_waits_are_kept_and_failures_are_not():
    checks(API)


@pytest.mark.parametrize('old,new', [
    ("await _WAITING.get(('waiting', name, seen if seen is not None else ('clock', int(time.monotonic() // 3))), _EPOCH[0], read)", "await read()"),
    ("// 3))), _EPOCH[0], read)", "// 3))), 0, read)"),
    ("waiting.read, meta.path, name, _REDACT)\n            if found is None:\n                raise LookupError(name)", "waiting.read, meta.path, name, _REDACT)\n            if False:\n                raise LookupError(name)"),
    ("('waiting', name, seen if seen is not None else ('clock', int(time.monotonic() // 3)))", "('waiting', name)"),
    ("('waiting', name, seen if seen is not None else ('clock', int(time.monotonic() // 3)))", "('waiting', name, 0 if seen is None else seen)"),
    ("seen if seen is not None else ('clock', int(time.monotonic() // 3))", "seen if seen is not None else ('clock', time.monotonic())"),
    ("    slots = asyncio.Semaphore(4)  # each read", "    slots = asyncio.Semaphore(400)  # each read"),
], ids=['no_cache', 'epoch_ignored', 'failure_remembered', 'marker_not_in_the_key', 'unknown_marker_kept', 'raw_clock_key', 'no_concurrency_cap'])
def test_each_mutation_is_caught(old, new):
    assert API.count(old) == 1, old
    with pytest.raises(Exception):   # noqa: B017  (a variant may break with another error than the assertion: red all the same)
        checks(API.replace(old, new))


# ---- the marker: a wait the hook wrote (another process) moves the key of the memory ----------------------------------------------
import backend.hook_store as store  # noqa: E402
import backend.waiting as waiting_module  # noqa: E402

STORE = Path(store.__file__)


def marker_checks(marker_of, tmp_path):
    db = tmp_path / 'm.db'
    record = lambda profile, verdict, call: store.record_event(db, profile, 'waiting:clarify', None, verdict, 'p', None, 's1', call, None)  # noqa: E731
    assert marker_of(db, 'vendas') == 0                                   # nothing written yet
    record('vendas', 'waiting', 'c1')
    first = marker_of(db, 'vendas')
    assert first > 0 and marker_of(db, 'vendas') == first                 # the same until something is written
    record('suporte', 'waiting', 'c2')
    assert marker_of(db, 'vendas') == first                               # another Bot's wait does not move it
    record('vendas', 'resolved', 'c1')
    assert marker_of(db, 'vendas') > first                                # a resolution changes what /waiting lists: it moves it too
    after = marker_of(db, 'vendas')
    record('vendas', 'approve', 'c3')
    assert marker_of(db, 'vendas') == after                               # a row that is not a wait or a resolution is none of its business


def test_the_marker_follows_the_hook_rows_of_that_bot(tmp_path):
    marker_checks(store.waiting_marker, tmp_path)
    assert waiting_module.marker(tmp_path / 'm.db', 'vendas') > 0
    assert waiting_module.marker(tmp_path, 'vendas') is None                              # a directory is no database: it cannot be told, None and never an exception


@pytest.mark.parametrize('old,new', [
    (" AND verdict IN ('waiting', 'resolved')", " AND verdict IN ('waiting')"),
    (" WHERE profile=? AND verdict", " WHERE ?=? AND verdict"),
    (" AND verdict IN ('waiting', 'resolved')", ""),
], ids=['resolution_ignored', 'any_bot', 'any_row'])
def test_each_marker_mutation_is_caught(tmp_path, old, new):
    source = STORE.read_text()
    text = re.search(r'def waiting_marker\(.*?(?=\n\n\ndef )', source, re.S).group(0)
    assert text.count(old) == 1, old
    mutated = text.replace(old, new)
    if '?=?' in mutated:
        mutated = mutated.replace("(profile,)", "(profile, profile)")
    ns = {'connect': store.connect}
    exec(mutated, ns)
    with pytest.raises(Exception):  # noqa: B017
        marker_checks(ns['waiting_marker'], tmp_path)
