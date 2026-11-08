"""Contract v0.8 section 2 (Timeline in lanes and Heatmap): backend/timeline.py over items shaped like /activity's and real
approvals/handoffs tables. Every invariant also runs against variants of timeline.py with one defect each: each must go red."""
from datetime import datetime, timezone
import importlib
import itertools
from pathlib import Path
import shutil
import sqlite3
import sys

import pytest

import backend.timeline as real
from backend import activity

SRC = Path(real.__file__).parent
_n = itertools.count()
T0 = datetime(2026, 10, 3, 2, 30, tzinfo=timezone.utc).timestamp()     # 02:30 UTC = 23:30 of the 2nd in São Paulo


def refused(m, code, fn, *args):
    try:
        fn(*args)
    except importlib.import_module(m.__name__.rsplit('.', 1)[0] + '.api_errors').PluginError as error:
        assert error.code == code, error.code
        return error
    raise AssertionError(f'{code} was not raised')


def items():
    iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat().replace('+00:00', 'Z')
    run = activity.run_item({'run_id': 'run_a', 'bot': 'vendas', 'session_id': 's1', 'started_at': iso(T0), 'last_status': 'completed',
                             'prompt_sha': None, 'ended_at': iso(T0 + 60)}, lambda v: datetime.fromisoformat(v.replace('Z', '+00:00')).timestamp())
    old = activity.run_item({'run_id': 'run_old', 'bot': 'vendas', 'session_id': 's0', 'started_at': iso(T0 - 3 * 86400), 'last_status': 'completed',
                             'prompt_sha': None, 'ended_at': None}, lambda v: datetime.fromisoformat(v.replace('Z', '+00:00')).timestamp())
    long = activity.routine_run_item('default', {'id': 'cron_j1_20261002_220000', 'title': 'Resumo', 'started_at': T0 - 7200,
                                                 'ended_at': T0 + 30}, T0 + 100)
    task = activity.task_item({'id': 't1', 'title': 'x', 'assignee': 'vendas', 'created_by': 'default', 'status': 'running',
                               'started_at': T0, 'completed_at': None})
    due = activity.due_item('vendas', {'id': 'j9', 'name': 'Semanal', 'next_run_at': '2026-10-04T00:00:00+00:00'})
    return [run, old, long, task, due]


def db(tmp):
    path = tmp / 'luvebot.db'
    conn = sqlite3.connect(path)
    conn.executescript("""
CREATE TABLE approvals (request_id TEXT, bot TEXT, created_at REAL, decided_at REAL, status TEXT, command_redacted TEXT, description TEXT);
CREATE TABLE handoffs (id TEXT, from_bot TEXT, to_bot TEXT, created_at REAL, state TEXT, title_sha TEXT);""")
    conn.executemany('INSERT INTO approvals VALUES (?,?,?,?,?,?,?)', [
        ('req_1', 'vendas', T0 + 10, T0 + 20, 'decided', 'rm -rf /tmp/x', 'apagar'), ('req_2', 'outro', T0 + 10, None, 'pending', 'x', 'y'),
        ('req_3', 'vendas', T0 - 5 * 86400, None, 'expired', 'x', 'y')])
    conn.execute("INSERT INTO handoffs VALUES ('h1', 'default', 'vendas', ?, 'done', 'abc')", (T0 + 5,))
    conn.commit()
    conn.close()
    return path


def inv_timeline_shape(m, tmp):
    since, until = m.window(T0 - 3600, T0 + 3600, T0 + 3600)
    lanes = m.lanes(items(), since, until)
    assert [(l['bot'], [b['id'] for b in l['blocks']]) for l in lanes] == [('default', ['routine_run:cron_j1_20261002_220000']),
                                                                           ('vendas', ['run:run_a'])]
    block = lanes[1]['blocks'][0]
    assert block == {'id': 'run:run_a', 'kind': 'run', 'title': None, 'start': T0, 'end': T0 + 60, 'status': 'done'}
    assert lanes[0]['blocks'][0]['kind'] == 'routine'                                           # started before the window, ended inside
    path = db(tmp)
    found = m.approvals(path, since, until, ['vendas', 'default'])
    assert found == [{'id': 'req_1', 'bot': 'vendas', 'at': T0 + 10, 'decided_at': T0 + 20, 'status': 'decided'}]   # no command text
    assert m.handoffs(path, since, until, ['vendas']) == [{'id': 'h1', 'from': 'default', 'to': 'vendas', 'at': T0 + 5, 'status': 'done'}]
    assert m.handoffs(path, since, until, ['outro']) == [] and m.approvals(tmp / 'empty.db', since, until, ['vendas']) == []


def inv_window_is_capped(m, tmp):
    assert m.window(None, None, T0) == (T0 - 86400, T0)
    assert m.window(T0 - 7 * 86400, T0, T0) == (T0 - 7 * 86400, T0)
    refused(m, 'bad_request', m.window, T0 - 7 * 86400 - 1, T0, T0)
    refused(m, 'bad_request', m.window, T0, T0 - 1, T0)


def inv_heatmap_tz(m, tmp):
    days, zone = m.heatmap_args(28, 'America/Sao_Paulo')
    view = m.heatmap([('vendas', T0), ('vendas', T0 + 600), ('default', T0 + 3600), ('vendas', T0 - 40 * 86400)], ['vendas', 'default'],
                     days, zone, T0 + 7200)
    assert view == {'bots': ['default', 'vendas'], 'cells': [{'bot': 'default', 'hour': 0, 'count': 1}, {'bot': 'vendas', 'hour': 23, 'count': 2}],
                    'max': 2}
    for bad in ('Mars/Olympus', '../../etc/passwd', '', '/etc/localtime', None):
        refused(m, 'invalid_field', m.heatmap_args, 28, bad)
    for bad in (0, 1, 30, 365):
        refused(m, 'bad_request', m.heatmap_args, bad, 'UTC')


INVARIANTS = {n[4:]: f for n, f in globals().items() if n.startswith('inv_')}
MUTATIONS = [
    ('timeline_shape', 'approvals return their raw row', "    return [{'id': r['request_id'], 'bot': r['bot'], 'at': r['created_at'], 'decided_at': r['decided_at'], 'status': r['status']}",
     "    return [{**r, 'id': r['request_id'], 'bot': r['bot'], 'at': r['created_at'], 'decided_at': r['decided_at'], 'status': r['status']}"),
    ('timeline_shape', 'tasks become blocks', "        if item['kind'] not in ('run', 'routine_run') or item['started_at'] is None:",
     "        if item['started_at'] is None:"),
    ('timeline_shape', 'a block that started before the window is dropped', "        if start > until or (end if end is not None else start) < since:",
     "        if start > until or start < since:"),
    ('window_is_capped', 'no cap on the window', "    if not (0 <= since <= until) or until - since > MAX_WINDOW:", "    if not (0 <= since <= until):"),
    ('heatmap_tz', 'bucketed in UTC', "        hour = datetime.fromtimestamp(at, zone).hour", "        hour = datetime.utcfromtimestamp(at).hour"),
    ('heatmap_tz', 'old starts counted', "        if at is None or at < now - days * DAY or at > now:", "        if at is None:"),
]


def load_variant(tmp_path_factory, old, new):
    pkg = tmp_path_factory.mktemp('tlvariant') / f'tlv{next(_n)}'
    pkg.mkdir()
    for name in ('__init__.py', 'api_errors.py', 'dbfile.py', 'timeline.py'):
        shutil.copy(SRC / name, pkg / name)
    text = (pkg / 'timeline.py').read_text()
    assert text.count(old) == 1, old
    (pkg / 'timeline.py').write_text(text.replace(old, new))
    sys.path.insert(0, str(pkg.parent))
    try:
        return importlib.import_module(f'{pkg.name}.timeline')
    finally:
        sys.path.remove(str(pkg.parent))


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(tmp_path, name):
    INVARIANTS[name](real, tmp_path)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, tmp_path, invariant, label, old, new):
    variant = load_variant(tmp_path_factory, old, new)
    with pytest.raises(AssertionError):
        INVARIANTS[invariant](variant, tmp_path)
