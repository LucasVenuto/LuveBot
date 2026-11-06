"""GET /bots performance (Lume's analysis, Maestro 15:29): a Bot's independent reads run together and 7 Bots do not add up
their reads in series; the display read of the pause state does not queue behind the global lock (the work gate still does);
profile_names() lists exactly the profiles list_profiles lists, without reading their configs; Server-Timing carries phase
names and milliseconds only. Timeouts, the 60 s capability cache and fail-closed are untouched.
Mutations: tests/harness/mutate_v04.py perf_live_serial, perf_pause_locked.
"""
import re
import threading
import time

from support import DASHBOARD, plugin
from test_hook import run_async
from test_plugin import PREFIX

SLOW = 0.2
PHASE = re.compile(r'^[a-z]+;dur=\d+(\.\d+)?$')


def test_seven_bots_do_not_add_up_their_reads(monkeypatch):
    module = plugin()
    controls = module.bot_controls

    def slow(value):
        def read(*args, **kwargs):
            time.sleep(SLOW)
            return value() if callable(value) else value
        return read
    monkeypatch.setattr(controls, 'recent_sources', slow(lambda: {'recent_sessions': [], 'workers': [], 'status_partial': []}))
    monkeypatch.setattr(controls, 'pause_state', slow({'paused': False, 'reason_kind': None, 'scope': None}))
    monkeypatch.setattr(controls, 'unread', slow({'count': 0, 'replies': 0, 'routine_results': 0, 'since': 0.0}))
    monkeypatch.setattr(module, '_routine_results', slow(0))
    monkeypatch.setattr(module, 'is_paused', slow(False))
    monkeypatch.setattr(module, '_hook_view', slow({'status': 'live'}))

    class Index:
        def open_runs(self, name):
            time.sleep(SLOW)
            return []

    async def seven():
        import asyncio
        return await asyncio.gather(*[module._live(f'bot{i}', Index(), '/nonexistent.db') for i in range(7)])

    started = time.monotonic()
    lives = run_async(seven())
    elapsed = time.monotonic() - started
    assert len(lives) == 7 and all(live['hook'] == {'status': 'live'} and live['open_runs'] == [] for live in lives)
    one_bot_in_series = 7 * SLOW                          # six independent reads + unread, one after the other
    assert elapsed < one_bot_in_series * 0.7, f'7 Bots took {elapsed:.2f}s; one Bot read in series alone takes {one_bot_in_series:.2f}s'


def test_the_display_read_of_the_pause_does_not_wait_for_the_lock_and_the_gate_does():
    plugin()
    from luvebot_backend import bot_controls
    db = '/root/.hermes/luvebot/luvebot.db'
    held, release = threading.Event(), threading.Event()

    def hold():
        with bot_controls.LOCK:
            held.set()
            release.wait(5)
    holder = threading.Thread(target=hold)
    holder.start()
    held.wait(5)
    try:
        started = time.monotonic()
        view = bot_controls.pause_state(db, 'vendas', consistent=False)
        assert time.monotonic() - started < 1.0 and set(view) == {'paused', 'reason_kind', 'scope'}
        gate = threading.Thread(target=lambda: bot_controls.pause_state(db, 'vendas'))
        gate.start()
        gate.join(0.5)
        assert gate.is_alive(), 'the work gate must read under the lock'
    finally:
        release.set()
        holder.join(5)
    gate.join(5)


def test_profile_names_are_the_profiles_hermes_lists():
    plugin()
    from hermes_cli.profiles import list_profiles
    from luvebot_backend.hermes_client import PROFILE_NAME, profile_names
    assert profile_names() == [p.name for p in list_profiles(lazy_skill_count=True) if PROFILE_NAME.fullmatch(p.name)]


def test_server_timing_has_phase_names_and_milliseconds_only(human_browser):
    for path, phases in (('/bots', {'stores', 'profiles', 'bots', 'fleet', 'total'}), ('/health', {'reads', 'features', 'total'})):
        response = human_browser.request.get(DASHBOARD + PREFIX + path)
        assert response.status == 200, response.text()
        parts = [p.strip() for p in response.headers['server-timing'].split(',')]
        assert all(PHASE.match(p) for p in parts), parts
        assert {p.split(';')[0] for p in parts} == phases
