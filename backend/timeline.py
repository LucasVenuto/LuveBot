"""Contract v0.8 section 2: the Timeline in lanes and the Heatmap, two READ views over what LuveBot already holds (the /activity
items, our approvals and handoffs tables, run_index.started_at and the cron sessions /activity reads). No command text, no
description: a diamond or a block opens the existing card."""
from datetime import datetime
import sqlite3
from zoneinfo import ZoneInfo

from .api_errors import PluginError
from . import dbfile

DAY = 86400
MAX_WINDOW = 7 * DAY
HEATMAP_DAYS = (7, 28, 90)


def window(since, until, now):
    """(since, until): default the last 24 h; at most 7 days; since before until."""
    until = now if until is None else until
    since = until - DAY if since is None else since
    if not (0 <= since <= until) or until - since > MAX_WINDOW:
        raise PluginError('bad_request', 'The window must be at most 7 days.', 400)
    return since, until


def lanes(items, since, until):
    """One lane per Bot with a block per run or routine run that overlaps the window (same items, same titles as /activity)."""
    by_bot = {}
    for item in items:
        if item['kind'] not in ('run', 'routine_run') or item['started_at'] is None:
            continue
        start, end = item['started_at'], item['ended_at']
        if start > until or (end if end is not None else start) < since:
            continue
        by_bot.setdefault(item['bot'], []).append({'id': item['id'], 'kind': 'run' if item['kind'] == 'run' else 'routine',
                                                   'title': item['title'], 'start': start, 'end': end, 'status': item['status']})
    return [{'bot': bot, 'blocks': sorted(blocks, key=lambda b: (b['start'], b['id']))} for bot, blocks in sorted(by_bot.items())]


def _rows(path, sql, args):
    conn = dbfile.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, args)]
    except sqlite3.OperationalError as error:
        if 'no such table' in str(error):
            return []
        raise
    finally:
        conn.close()


def approvals(path, since, until, bots):
    """Diamonds: when a request came and when a person decided it. Never its command or description."""
    marks = ','.join('?' * len(bots)) or "''"
    return [{'id': r['request_id'], 'bot': r['bot'], 'at': r['created_at'], 'decided_at': r['decided_at'], 'status': r['status']}
            for r in _rows(path, f'SELECT request_id, bot, created_at, decided_at, status FROM approvals WHERE created_at BETWEEN ? AND ? '
                                 f'AND bot IN ({marks}) ORDER BY created_at', (since, until, *bots))]


def handoffs(path, since, until, bots):
    marks = ','.join('?' * len(bots)) or "''"
    return [{'id': r['id'], 'from': r['from_bot'], 'to': r['to_bot'], 'at': r['created_at'], 'status': r['state']}
            for r in _rows(path, f'SELECT id, from_bot, to_bot, created_at, state FROM handoffs WHERE created_at BETWEEN ? AND ? '
                                 f'AND (from_bot IN ({marks}) OR to_bot IN ({marks})) ORDER BY created_at',
                           (since, until, *bots, *bots))]


def heatmap_args(days, tz):
    if days not in HEATMAP_DAYS:
        raise PluginError('bad_request', 'days must be 7, 28 or 90.', 400)
    try:
        zone = ZoneInfo(tz) if isinstance(tz, str) and tz and '..' not in tz and not tz.startswith('/') else None
    except Exception:
        zone = None
    if zone is None:
        raise PluginError('invalid_field', 'Unknown time zone.', 422)
    return days, zone


def heatmap(starts, bots, days, zone, now):
    """`starts` = [(bot, epoch)]: run starts and routine run starts. Counted per Bot and hour of the day IN `zone`."""
    counts = {}
    for bot, at in starts:
        if at is None or at < now - days * DAY or at > now:
            continue
        hour = datetime.fromtimestamp(at, zone).hour
        counts[(bot, hour)] = counts.get((bot, hour), 0) + 1
    cells = [{'bot': bot, 'hour': hour, 'count': n} for (bot, hour), n in sorted(counts.items())]
    return {'bots': sorted(bots), 'cells': cells, 'max': max(counts.values(), default=0)}
