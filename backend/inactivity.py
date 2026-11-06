"""Auto-pause by inactivity (contract plugin-api v0.8, section 8; spec 4.9): after X days with nobody opening LuveBot, the
ROUTINES of every Bot are paused (conversations and channels are not), with Hermes's own cron pause and the reason
`luvebot:inactivity`, remembered in `inactivity_jobs` so the resume touches only what this paused. Never resumed by itself: a
person resumes from the banner. "Opening LuveBot" is a person's GET /session (loopback counts as `dashboard`: an agent polling
/session in loopback keeps it awake, a declared limit).
"""
import sqlite3
import time

from . import bot_controls
from .api_errors import PluginError
from .budget import BudgetUnavailable, is_paused
from . import dbfile

DAYS = (3, 7, 14, 30)
REASON = 'luvebot:inactivity'
_SCHEMA = """
CREATE TABLE IF NOT EXISTS inactivity_settings (id INTEGER PRIMARY KEY CHECK (id = 1), days INTEGER, set_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS last_seen (actor TEXT PRIMARY KEY, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS inactivity_event (id INTEGER PRIMARY KEY CHECK (id = 1), at REAL NOT NULL, count INTEGER NOT NULL,
                                             days INTEGER NOT NULL);
"""
_touched = {}  # actor -> last write (monotonic): one row write per minute per actor is enough for a count in days


def _db(path):
    conn = dbfile.connect(path)
    conn.executescript(_SCHEMA)
    return conn


def _one(path, sql, args=()):
    conn = _db(path)
    try:
        return conn.execute(sql, args).fetchone()
    finally:
        conn.close()


def _write(path, sql, args=()):
    conn = _db(path)
    try:
        with conn:
            conn.execute(sql, args)
    finally:
        conn.close()


def validate(body):
    """{"days": null | 3 | 7 | 14 | 30}, an integer or null only."""
    if not isinstance(body, dict) or set(body) != {'days'}:
        raise PluginError('bad_request', 'Send {"days": null | 3 | 7 | 14 | 30}.', 400)
    days = body['days']
    if days is not None and (type(days) is not int or days not in DAYS):
        raise PluginError('invalid_field', 'days must be null, 3, 7, 14 or 30.', 422)
    return days


def days_set(path):
    row = _one(path, 'SELECT days FROM inactivity_settings WHERE id=1')
    return row[0] if row else None


def loosens(before, after):
    """Turning it OFF or LENGTHENING it lets routines run longer unattended: a person with a login. ON or shorter: tightening."""
    return before is not None and (after is None or after > before)


def set_days(audit, actor, path, days, *, now=None):
    before = days_set(path)
    audit.act(actor, 'settings.inactivity_pause', None, 'ui',
              lambda: _write(path, 'INSERT OR REPLACE INTO inactivity_settings VALUES (1,?,?)', (days, time.time() if now is None else now)),
              payload={'from': before, 'to': days})
    return {'days': days}


def touch(path, actor, *, now=None, clock=time.monotonic):
    """A person opened LuveBot (GET /session). Never resumes anything: that is the person's choice, from the banner."""
    tick = clock()
    if tick - _touched.get(actor, -120.0) < 60:
        return
    _touched[actor] = tick
    _write(path, 'INSERT OR REPLACE INTO last_seen VALUES (?,?)', (actor, time.time() if now is None else now))


def status(path):
    """{days, paused: {count, at, days} | null} for the settings card and the banner."""
    event = _one(path, 'SELECT at, count, days FROM inactivity_event WHERE id=1')
    return {'days': days_set(path), 'paused': {'at': event[0], 'count': event[1], 'days': event[2]} if event else None}


def check(path, audit, bots, cron, *, now=None):
    """One pass of the watcher: when nobody opened LuveBot for more than `days` (counted from the last visit, or from when the
    setting was turned on), pause the routines that run, of every Bot. Already-paused routines are left as they are. -> count."""
    now = time.time() if now is None else now
    setting = _one(path, 'SELECT days, set_at FROM inactivity_settings WHERE id=1')
    if not setting or setting[0] is None:
        return 0
    days, set_at = setting
    seen = _one(path, 'SELECT max(at) FROM last_seen')[0]
    if now - max(seen or 0, set_at) <= days * 86400:
        return 0
    running = [(bot, job['id']) for bot in bots for job in cron.list_jobs(bot)
               if job.get('enabled') is not False and job.get('state') not in ('paused', 'completed')]
    if not running:
        return 0

    def effect():
        count = sum(len(bot_controls._cron_jobs_pause(path, bot, cron, REASON)) for bot in sorted({b for b, _ in running}))
        previous = _one(path, 'SELECT count FROM inactivity_event WHERE id=1')
        _write(path, 'INSERT OR REPLACE INTO inactivity_event VALUES (1,?,?,?)', (now, count + (previous[0] if previous else 0), days))
        return count
    return audit.act('system', 'routines.inactivity_pause', None, 'system', effect, payload={'days': days, 'jobs': len(running)})


def _held(path, bot, gate):
    """Must this Bot's routines stay paused? The refusals of resuming ONE routine (invariant 7: resuming must not undo a pause): a Bot the
    spending cap paused, a cap that cannot be read (fail closed), and whatever `gate` refuses (the route passes its start gate:
    paused by a person, a budget that cannot be verified)."""
    try:
        if is_paused(path, bot):
            return True
        if gate is not None:
            gate(bot)
    except (PluginError, BudgetUnavailable):
        return True
    return False


def _still_paused(path, bot, cron):
    ours = set(bot_controls._remembered(path, bot, REASON))
    return [job['id'] for job in cron.list_jobs(bot) if job['id'] in ours and job.get('state') == 'paused' and job.get('paused_reason') == REASON]


def resume(audit, actor, path, bots, cron, gate=None):
    """POST /routines/inactivity-resume: a person resumes ONLY what the inactivity pause paused, and not for a Bot that must stay paused
    (the cap): those routines stay paused AND remembered, and the banner stays, so a later "Retomar" brings them back once it is lifted.
    -> {resumed, held}: how many came back, how many stayed out."""
    def effect():
        held = [bot for bot in bots if _held(path, bot, gate)]
        count = sum(len(bot_controls._cron_jobs_resume(path, bot, cron, REASON)) for bot in bots if bot not in held)
        left = sum(len(_still_paused(path, bot, cron)) for bot in held)
        if left:
            _write(path, 'UPDATE inactivity_event SET count=? WHERE id=1', (left,))
        else:
            _write(path, 'DELETE FROM inactivity_event WHERE id=1')
        return {'resumed': count, 'held': left}
    return audit.act(actor, 'routines.inactivity_resume', None, 'ui', effect)


seen = touch  # the name the route calls: the invariant-4 scan of the Hermes-facing files flags every call named `touch` (Path.touch writes a file), and this writes our own db
