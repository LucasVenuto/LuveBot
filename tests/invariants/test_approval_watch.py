"""A run's approval watcher lives as long as the run, on the REAL Hermes (the fixed 3600 s stopped it on any run longer than an
hour). One real run that asks for approval, watched by the real `_watch` in this process: its first event stream drops after the
first frame (as a proxy or a restart would), and the clock jumps 10 min at every read, so the old one-hour limit passes after six
reads. The watcher reopens the stream (Hermes replays the run's retained events), records the request once, and ends on the
run's real end, never on its safety ceiling. The run is started on Hermes's own route, so the dashboard does not watch it too.
Unit tests (tests/unit/backend/test_approval_watch.py) carry the mutations.
"""
import sqlite3
import threading
import time

from support import plugin
from test_approvals import ASK, MARK
from test_bots import DB
from test_hook import wait_for, wait_live


def test_the_watcher_follows_a_long_run_across_a_dropped_stream(human_browser, monkeypatch):
    plugin()
    import luvebot_backend.approvals_native as native
    from luvebot_backend.hermes_api import ApiClient
    MARK.unlink(missing_ok=True)
    wait_live(human_browser, 'vendas')
    status, payload = ApiClient('vendas').call('POST', '/v1/runs', {'input': ASK})
    assert status in (200, 202), status
    run_id = payload['run_id']
    opened, ended = [], []

    class Dropping:
        """The real client; only its FIRST event stream ends after one frame."""
        def __init__(self, bot):
            self.real = ApiClient(bot)

        def call(self, *args, **kwargs):
            return self.real.call(*args, **kwargs)

        def open_stream(self, *args, **kwargs):
            status, stream = self.real.open_stream(*args, **kwargs)
            opened.append(status)
            if len(opened) == 1 and stream is not None:
                lines = stream.lines

                def one_frame(limit):
                    for line in lines(limit):
                        yield line
                        if line == '':
                            return
                stream.lines = one_frame
            return status, stream
    monkeypatch.setattr(native, 'ApiClient', Dropping)
    real_ended = native._ended
    monkeypatch.setattr(native, '_ended', lambda *a: (ended.append(a[2]), real_ended(*a)))
    clock = [0.0]

    def fast():
        clock[0] += 600.0                                                          # every read is ten minutes later
        return clock[0]
    with native._lock:
        native._active.add(run_id)
    watcher = threading.Thread(target=native._watch, args=(DB, 'vendas', run_id, lambda text: text),
                               kwargs={'clock': fast, 'sleep': lambda _s: time.sleep(0.2)}, daemon=True)
    watcher.start()

    def requests():
        conn = sqlite3.connect(DB)
        try:
            return [r[0] for r in conn.execute('SELECT request_id FROM approvals WHERE run_id=?', (run_id,))]
        except sqlite3.OperationalError:
            return []                                                                # a fresh database: nothing recorded yet
        finally:
            conn.close()
    request_id = wait_for(lambda: (found := requests()) and found[0], 60, "the watcher's record of the request")
    status, _ = ApiClient('vendas').call('POST', f'/v1/runs/{run_id}/approval', {'choice': 'deny', 'request_id': request_id})
    assert status == 200, status
    watcher.join(60)
    assert not watcher.is_alive(), 'the watcher did not end with the run'
    assert len(opened) >= 2, opened                                                  # the dropped stream was reopened
    assert requests() == [request_id]                                                # replayed, never doubled
    assert ended == [run_id] and clock[0] > 3600                                     # the run's end, after the old limit
    conn = sqlite3.connect(DB)
    try:
        ceiling = conn.execute("SELECT count(*) FROM audit_log WHERE action='approval.watch.ceiling' AND target=?", (run_id,)).fetchone()[0]
    finally:
        conn.close()
    assert ceiling == 0 and not MARK.exists()
    assert run_id not in native._active
