"""D-007, end to end on the REAL plugin: the Screen routes of LuveBot, the vendored noVNC served from the plugin's own folder, Hermes
f8489405's Bot Desktop (Xvnc + Xfce) and its real RFB bridge, in a real browser. Ordered steps sharing one page (only the model is
fake). Run by tests/harness/display/run.sh; mutate_display.py turns these red one defect at a time."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time

import pytest

from conftest import logged_in
from support import DASHBOARD

BOT = 'default'
PREFIX = '/api/plugins/luvebot'
DB = Path('/root/.hermes/luvebot/luvebot.db')
SCREEN_W, SCREEN_H = 1440, 900
WINDOW_CENTER = (525, 330)                     # inside the agent's xfce4-terminal at +120+120 (fake_openai.py T09_OPEN_WINDOW)
RFB = '/dashboard-plugins/luvebot/vendor/novnc/core/rfb.js'
HELPERS = r'''() => { if (window.__D007__) return;
  const P = '/api/plugins/luvebot/bots/default/screen';
  let RFB = null, rfb = null; const frames = {}, log = [];
  async function csrf() { return (await (await fetch('/api/plugins/luvebot/session')).json()).csrf; }
  async function post(action, body) {
    const r = await fetch(P + '/' + action, {method: 'POST', headers: {'X-LuveBot-CSRF': await csrf(), 'Content-Type': 'application/json'},
                                             body: body ? JSON.stringify(body) : ''});
    const t = await r.text(); return {status: r.status, body: t ? JSON.parse(t) : null};
  }
  async function get() { const r = await fetch(P); return {status: r.status, body: await r.json()}; }
  function wsUrl(path, ticket) { const u = new URL(path, location.origin); u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
                                 u.searchParams.set('display_ticket', ticket); return u.toString(); }
  function el() { let e = document.getElementById('d007'); if (!e) { e = document.createElement('div'); e.id = 'd007';
    e.style.cssText = 'position:fixed;left:0;top:0;width:min(960px,100vw);height:min(600px,62.5vw);z-index:2147483647;background:#000';
    document.body.appendChild(e); } return e; }
  async function connect(info, viewOnly) {
    if (!RFB) RFB = (await import('__RFB__')).default;
    if (rfb) { rfb.disconnect(); rfb = null; }
    const target = el(); target.innerHTML = '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RFB connect timeout')), 20000);
      const r = new RFB(target, wsUrl(info.path, info.ticket)); r.viewOnly = viewOnly; r.scaleViewport = true;
      r.addEventListener('connect', () => { clearTimeout(timer); log.push('connect'); resolve({connected: true, viewOnly}); });
      r.addEventListener('disconnect', e => { clearTimeout(timer); log.push('disconnect clean=' + e.detail.clean); resolve({connected: false}); });
      rfb = r; });
  }
  function canvas() { return document.querySelector('#d007 canvas'); }
  function grab(name) { const c = canvas(); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; frames[name] = d;
    let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
    return {width: c.width, height: c.height, litPixels: lit}; }
  function diff(a, b) { const x = frames[a], y = frames[b]; let changed = 0;
    for (let i = 0; i < x.length; i += 4) if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 24) changed++;
    return {changedPixels: changed, fraction: changed / (x.length / 4)}; }
  function raw(info, waitMs) { return new Promise(resolve => { const ws = new WebSocket(wsUrl(info.path, info.ticket)); ws.binaryType = 'arraybuffer';
    let firstBinary = false; const timer = setTimeout(() => { window.__D007_RAW__ = ws; resolve({open: true, firstBinary, closed: false}); }, waitMs);
    ws.onmessage = e => { if (typeof e.data !== 'string') firstBinary = true; };
    ws.onclose = e => { ws.closeInfo = {code: e.code, reason: e.reason}; clearTimeout(timer); resolve({firstBinary, closed: true, code: e.code, reason: e.reason}); }; }); }
  function rawClosed() { const ws = window.__D007_RAW__; return new Promise(res => { const p = setInterval(() => { if (ws.closeInfo) { clearInterval(p); res(ws.closeInfo); } }, 50);
    setTimeout(() => { clearInterval(p); res({code: null}); }, 6000); }); }
  window.__D007__ = {post, get, connect, grab, diff, raw, rawClosed, log, closeRaw(code) { window.__D007_RAW__.close(code); },
    box() { const r = canvas().getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; },
    setViewOnly(v) { rfb.viewOnly = v; return rfb.viewOnly; }, disconnect() { if (rfb) rfb.disconnect(); rfb = null; }};
}'''.replace('__RFB__', RFB)


def js(pg, expr, arg=None):
    return pg.evaluate(expr, arg)


def audit(action):
    conn = sqlite3.connect(DB)
    try:
        return conn.execute("SELECT id, actor, outcome, detail, origin_kind FROM audit_log WHERE action=? ORDER BY id", (action,)).fetchall()
    finally:
        conn.close()


def viewers():
    conn = sqlite3.connect(DB)
    try:
        return conn.execute("SELECT bot, actor FROM screen_viewers").fetchall()
    except sqlite3.OperationalError:
        return []
    finally:
        conn.close()


def agent_window():
    out = subprocess.run(['sh', '-c', 'set -a; . /root/.hermes/bot-desktop/env; xwininfo -root -tree'], capture_output=True, text=True)
    return [line.strip() for line in out.stdout.splitlines() if 'luvebot-agent-window' in line]


def agent_may_act():
    out = subprocess.run(['python', '-c', 'from tools.bot_desktop import lease\ntry:\n lease.assert_agent_may_act()\n print("agent may act")\n'
                          'except lease.HumanHasControl as e:\n print("refused:", type(e).__name__)'],
                         capture_output=True, text=True, cwd='/opt/hermes', env={**os.environ, 'HERMES_HOME': '/root/.hermes'})
    return out.stdout.strip()


def settled(pg, name):
    for _ in range(15):
        js(pg, '() => window.__D007__.grab("probe")')
        time.sleep(2)
        frame = js(pg, f'() => window.__D007__.grab("{name}")')
        if js(pg, f'() => window.__D007__.diff("probe", "{name}")')['changedPixels'] == 0:
            return frame
    raise AssertionError('screen never settled')


def click_and_type(pg, text):
    box = js(pg, '() => window.__D007__.box()')
    pg.mouse.click(box['x'] + WINDOW_CENTER[0] * box['w'] / SCREEN_W, box['y'] + WINDOW_CENTER[1] * box['h'] / SCREEN_H)
    pg.keyboard.type(text)
    pg.keyboard.press('Enter')
    time.sleep(2)


def no_viewer_id(value):
    return 'viewer_id' not in json.dumps(value)


def route(ctx, method, path, body=None):
    """A LuveBot route as the logged-in person: the session cookie of `ctx` and, for an effect, its CSRF (test_approvals.py)."""
    headers = {} if method == 'GET' else {'X-LuveBot-CSRF': ctx.request.get(DASHBOARD + PREFIX + '/session').json()['csrf']}
    call = getattr(ctx.request, method.lower())
    return call(DASHBOARD + PREFIX + path, headers=headers, **({} if body is None else {'data': body}))


@pytest.fixture(scope='module')
def page(human_browser):
    pg = human_browser.new_page()
    pg.goto(DASHBOARD + '/')
    pg.wait_for_load_state('networkidle')
    js(pg, HELPERS)
    yield pg
    pg.close()


def test_01_status_and_start_are_honest_and_audited(page):
    status = js(page, '() => window.__D007__.get()')
    assert status['status'] == 200 and status['body']['screen']['installed'] is True and status['body']['screen']['missing'] == []
    before = len(audit('screen.start'))
    started = js(page, '() => window.__D007__.post("start")')
    assert started['status'] == 200 and started['body']['screen']['running'] is True, started
    assert [(r[2], r[3]) for r in audit('screen.start')[before:]] == [('ok', 'intent'), ('ok', 'result')]


def test_02_watch_from_the_plugin_page_with_the_vendored_novnc(page):
    watch = js(page, '() => window.__D007__.post("watch")')
    assert watch['status'] == 200 and set(watch['body']) == {'ticket', 'path', 'expires_in'} and watch['body']['expires_in'] == 30
    assert js(page, '(info) => window.__D007__.connect(info, true)', watch['body']) == {'connected': True, 'viewOnly': True}
    frame = settled(page, 'before')
    assert (frame['width'], frame['height']) == (SCREEN_W, SCREEN_H) and frame['litPixels'] > 0 and agent_window() == []
    assert js(page, '() => window.__D007__.get()')['body']['screen']['lease']['holder'] == 'agent'


def test_03_the_screen_changes_when_the_agent_acts(page, human_browser):
    """The agent's command (`set -a; . env; set +a; exec xfce4-terminal ...`) is not a plain command, so the LuveBot hook (0.3.0)
    asks a person (rule noncanonical): what the product requires. Nothing is loosened for the test. The run is started where a
    person works (LuveBot's run route) and that person approves it ONCE, through the human route (session + CSRF), exactly like
    tests/invariants/test_approvals.py."""
    sid = route(human_browser, 'POST', f'/bots/{BOT}/sessions', {}).json()['session']['id']
    started = route(human_browser, 'POST', f'/bots/{BOT}/runs', {'input': 'T09_OPEN_WINDOW: open a window on your screen.', 'session_id': sid})
    assert started.status == 202, started.text()
    run_id, approved, status = started.json()['run']['id'], [], None
    for _ in range(120):
        status = route(human_browser, 'GET', f'/bots/{BOT}/runs/{run_id}').json()['run']['status']
        if status in ('completed', 'failed', 'cancelled'):
            break
        pending = [a for a in route(human_browser, 'GET', f'/approvals?status=pending&bot={BOT}&limit=100').json()['approvals']
                   if a['run_id'] == run_id]
        for approval in pending:
            assert not approved, 'the run asked a second time'
            assert approval['tool'] == 'terminal' and status == 'waiting_for_approval', (approval['tool'], status)
            decided = route(human_browser, 'POST', f"/approvals/{approval['request_id']}/resolve", {'digest': approval['digest'], 'choice': 'once'})
            assert decided.status == 200 and decided.json()['approval']['decided_choice'] == 'once', decided.text()
            approved.append(approval['request_id'])
        time.sleep(1)
    assert status == 'completed' and len(approved) == 1, (status, approved)          # asked once, approved once by the person
    for _ in range(20):
        if agent_window():
            break
        time.sleep(1)
    assert agent_window(), 'the agent did not open its window'
    settled(page, 'after')
    change = js(page, '() => window.__D007__.diff("before", "after")')
    assert change['fraction'] > 0.05, change


def test_04_input_of_a_watcher_never_reaches_the_screen(page):
    assert js(page, '() => window.__D007__.setViewOnly(false)') is False
    click_and_type(page, 'echo watcher > /tmp/d007-watcher')
    assert not Path('/tmp/d007-watcher').exists()


def test_05_take_is_audited_first_and_the_person_drives(page):
    before = len(audit('screen.take'))
    took = js(page, '() => window.__D007__.post("take", {reason: "login no banco"})')
    assert took['status'] == 200 and set(took['body']) == {'ticket', 'path', 'expires_in', 'lease'} and no_viewer_id(took['body'])
    assert took['body']['lease'] == {'holder': 'human', 'since': took['body']['lease']['since'], 'mine': True, 'by_luvebot': True}
    rows = audit('screen.take')[before:]
    assert [(r[2], r[3]) for r in rows] == [('ok', 'intent'), ('ok', 'result')] and rows[0][1] not in ('dashboard', 'system')
    assert viewers() == [(BOT, rows[0][1])] and agent_may_act() == 'refused: HumanHasControl'
    assert js(page, '(info) => window.__D007__.connect(info, false)', took['body']) == {'connected': True, 'viewOnly': False}
    time.sleep(2)
    click_and_type(page, 'echo human-typed > /tmp/d007-human')
    assert Path('/tmp/d007-human').read_text().strip() == 'human-typed'


def test_06_stop_is_refused_while_a_person_holds_control(page):
    stopped = js(page, '() => window.__D007__.post("stop")')
    assert stopped['status'] == 409 and stopped['body']['error']['code'] == 'screen_in_use'
    assert js(page, '() => window.__D007__.get()')['body']['screen']['running'] is True


def test_07_taking_again_evicts_the_old_viewer_with_4000(page):
    second = js(page, '() => window.__D007__.post("take")')['body']
    raw = js(page, '(info) => window.__D007__.raw(info, 2000)', second)
    assert raw['firstBinary'] and not raw['closed'], raw
    third = js(page, '() => window.__D007__.post("take")')['body']
    assert js(page, '() => window.__D007__.rawClosed()') == {'code': 4000, 'reason': 'control-taken'}
    assert any(e.startswith('disconnect') for e in js(page, '() => window.__D007__.log'))
    assert js(page, '(info) => window.__D007__.connect(info, false)', third) == {'connected': True, 'viewOnly': False}


def test_08_return_gives_control_back_and_only_once(page):
    before = len(audit('screen.return'))
    back = js(page, '() => window.__D007__.post("return")')
    assert back['status'] == 200 and back['body']['lease']['holder'] == 'agent', back
    assert [(r[2], r[3]) for r in audit('screen.return')[before:]] == [('ok', 'intent'), ('ok', 'result')]
    assert agent_may_act() == 'agent may act' and viewers() == []
    time.sleep(1)
    click_and_type(page, 'echo after-return > /tmp/d007-after')
    assert not Path('/tmp/d007-after').exists()
    again = js(page, '() => window.__D007__.post("return")')
    assert again['status'] == 409 and again['body']['error']['code'] == 'screen_not_yours'


def test_09_a_hand_back_by_hermes_is_audited_by_the_watcher(page):
    """Hermes gives control back BY ITSELF only when the viewer closes the window: a clean close, 1000/1001
    (hermes_cli/web_routers/display.py:37 _CLEAN_CLOSE, :194 and :239). A dropped link keeps the person's control on purpose
    (they may be mid-login). noVNC's disconnect() closes with no status code (vendor/novnc/core/websock.js:302), which the
    server reads as 1005, a dropped link: the person keeps control and there is nothing to audit; giving back is the route."""
    took = js(page, '() => window.__D007__.post("take")')['body']
    assert js(page, '(info) => window.__D007__.connect(info, false)', took) == {'connected': True, 'viewOnly': False}
    before = len(audit('screen.return'))
    js(page, '() => window.__D007__.disconnect()')                    # 1005: for Hermes, a dropped link
    time.sleep(12)                                                    # four passes of the watcher (LUVEBOT_WATCH_EVERY=3)
    assert audit('screen.return')[before:] == [] and len(viewers()) == 1
    assert js(page, '() => window.__D007__.get()')['body']['screen']['lease']['mine'] is True and agent_may_act() == 'refused: HumanHasControl'
    assert js(page, '() => window.__D007__.post("return")')['status'] == 200   # what the UI's "give back" does
    # a viewer that CLOSES its window (1000): Hermes hands back, and the watcher leaves the row
    took = js(page, '() => window.__D007__.post("take")')['body']
    assert js(page, '(info) => window.__D007__.raw(info, 2000)', took)['firstBinary']
    before = len(audit('screen.return'))
    js(page, '() => window.__D007__.closeRaw(1000)')
    for _ in range(40):
        rows = audit('screen.return')[before:]
        if len(rows) >= 2:
            break
        time.sleep(1)
    assert [(r[1], r[2], r[3], r[4]) for r in rows] == [('system', 'ok', 'intent', 'system'), ('system', 'ok', 'result', 'system')], rows
    assert viewers() == [] and js(page, '() => window.__D007__.get()')['body']['screen']['lease']['holder'] == 'agent'
    assert agent_may_act() == 'agent may act'


def test_10_a_ticket_is_single_use(page):
    info = js(page, '() => window.__D007__.post("watch")')['body']
    first = js(page, '(info) => window.__D007__.raw(info, 1500)', info)
    reuse = js(page, '(info) => window.__D007__.raw(info, 3000)', info)
    assert first['firstBinary'] and reuse == {'firstBinary': False, 'closed': True, 'code': 4401, 'reason': 'display ticket missing, expired or used'}


@pytest.mark.parametrize('engine,device', [('chromium', 'Pixel 7'), ('webkit', 'iPhone 14')])
def test_11_phone_emulation_watches(playwright_instance, engine, device):
    browser, ctx = logged_in(playwright_instance, engine, **playwright_instance.devices[device])
    try:
        pg = ctx.new_page()
        pg.goto(DASHBOARD + '/')
        pg.wait_for_load_state('networkidle')
        js(pg, HELPERS)
        info = js(pg, '() => window.__D007__.post("watch")')['body']
        assert js(pg, '(info) => window.__D007__.connect(info, true)', info)['connected']
        for _ in range(30):                                           # WebKit draws the first frame later than Chromium
            if js(pg, '() => window.__D007__.grab("m")')['litPixels'] > 0:
                break
            time.sleep(1)
        assert js(pg, '() => window.__D007__.grab("m")')['litPixels'] > 0
    finally:
        browser.close()


def test_12_stop_after_the_person_is_done(page):
    """Only once control is back with the agent: a screen is never stopped under a person (D-007 decision 2)."""
    js(page, '() => window.__D007__.disconnect()')
    if js(page, '() => window.__D007__.get()')['body']['screen']['lease']['mine']:
        assert js(page, '() => window.__D007__.post("return")')['status'] == 200
    assert js(page, '() => window.__D007__.get()')['body']['screen']['lease']['holder'] == 'agent'
    stopped = js(page, '() => window.__D007__.post("stop")')
    assert stopped['status'] == 200 and stopped['body']['screen']['running'] is False, stopped
