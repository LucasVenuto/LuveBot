"""Contract v0.8 section 2 (Timeline in lanes and Heatmap) against the real plugin and Hermes: a real run, an approval recorded by
the real insert and a handoff row, in the right lane, once, without command text. The unit suite holds the mutations."""
from datetime import datetime
import json
import sqlite3
import time
import uuid
from zoneinfo import ZoneInfo

import pytest

from support import DASHBOARD, plugin
from test_bots import DB, error_of
from test_hook import run_to_end
from test_plugin import PREFIX, routes


def get(browser, path):
    return browser.request.get(DASHBOARD + PREFIX + path)


def test_both_routes_are_in_the_real_router():
    found = {(m, p) for m, p in routes() if p.endswith(('/activity/timeline', '/activity/heatmap'))}
    assert found == {('GET', PREFIX + '/activity/timeline'), ('GET', PREFIX + '/activity/heatmap')}


def test_timeline_shape(human_browser):
    started = time.time() - 1
    _sid, run, _final = run_to_end(human_browser, 'vendas', 'Timeline harness turn')
    plugin()
    from luvebot_backend import approvals
    request_id, handoff_id = 'req_tl_' + uuid.uuid4().hex[:10], 'hof_tl_' + uuid.uuid4().hex[:10]
    approvals.record_request(DB, 'vendas', 'run_tl_' + uuid.uuid4().hex[:8], 'run',
                             {'request_id': request_id, 'command': 'chmod 600 /tmp/timeline-secret', 'description': 'timeline-desc',
                              'choices': ['once', 'deny']})
    conn = sqlite3.connect(DB)
    conn.execute("INSERT INTO handoffs (id, from_bot, to_bot, task_id, title_sha, source, effect, state, created_at) "
                 "VALUES (?, 'default', 'vendas', ?, 'x', 'test', 'none', 'done', ?)", (handoff_id, 'task_' + handoff_id, time.time()))
    conn.commit()
    conn.close()
    try:
        response = get(human_browser, f'/activity/timeline?since={started - 60}&until={time.time() + 60}')
        assert response.status == 200, response.text()
        view = response.json()
        lane = next(l for l in view['lanes'] if l['bot'] == 'vendas')
        blocks = [b for b in lane['blocks'] if b['id'] == f"run:{run['id']}"]
        assert len(blocks) == 1 and blocks[0]['kind'] == 'run' and blocks[0]['end'] is not None and blocks[0]['end'] >= blocks[0]['start']
        assert all(b['id'] != f"run:{run['id']}" for l in view['lanes'] if l['bot'] != 'vendas' for b in l['blocks'])
        diamonds = [a for a in view['approvals'] if a['id'] == request_id]
        assert len(diamonds) == 1 and diamonds[0]['bot'] == 'vendas' and set(diamonds[0]) == {'id', 'bot', 'at', 'decided_at', 'status'}
        assert 'timeline-secret' not in response.text() and 'timeline-desc' not in response.text()
        line, = [h for h in view['handoffs'] if h['id'] == handoff_id]       # its state is the watcher's to change; the line is ours
        assert (line['from'], line['to']) == ('default', 'vendas') and set(line) == {'id', 'from', 'to', 'at', 'status'}
        only = get(human_browser, f'/activity/timeline?bot=default&since={started - 60}&until={time.time() + 60}').json()
        assert all(l['bot'] == 'default' for l in only['lanes']) and all(a['bot'] == 'default' for a in only['approvals'])
        capped = get(human_browser, f'/activity/timeline?since={time.time() - 8 * 86400}&until={time.time()}')
        assert capped.status == 400 and error_of(capped)['code'] == 'bad_request'
        listed = get(human_browser, '/activity?tab=done&bot=vendas&limit=100').json()['items']
        assert next(i for i in listed if i['id'] == f"run:{run['id']}")['ended_at'] is not None      # /activity shows the end too
    finally:
        conn = sqlite3.connect(DB)
        conn.execute('DELETE FROM approvals WHERE request_id=?', (request_id,))
        conn.execute('DELETE FROM handoffs WHERE id=?', (handoff_id,))
        conn.commit()
        conn.close()


def test_heatmap_tz(human_browser):
    _sid, run, _final = run_to_end(human_browser, 'vendas', 'Heatmap harness turn')
    hour = datetime.now(ZoneInfo('America/Sao_Paulo')).hour
    view = get(human_browser, '/activity/heatmap?days=7&tz=America/Sao_Paulo').json()
    assert {'bots', 'cells', 'max'} <= set(view) and 'vendas' in view['bots']
    cell = next(c for c in view['cells'] if c['bot'] == 'vendas' and c['hour'] in (hour, (hour - 1) % 24))
    assert cell['count'] >= 1 and view['max'] >= cell['count']
    utc = get(human_browser, '/activity/heatmap?days=7&tz=UTC').json()
    assert sum(c['count'] for c in utc['cells']) == sum(c['count'] for c in view['cells'])           # same starts, other hours
    for bad, status in (('days=30&tz=UTC', 400), ('days=7&tz=Mars/Olympus', 422), ('days=7&tz=../../etc/passwd', 422)):
        assert get(human_browser, '/activity/heatmap?' + bad).status == status, bad
    assert 'Heatmap harness turn' not in json.dumps(view)
