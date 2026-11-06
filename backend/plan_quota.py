"""Plan quota per provider (contract F6.1): "17% left, renews 15:00", read from Hermes, shown in Costs, NEVER enforced.

Source: `hermes_cli.inventory.build_model_options_payload`, the function behind `GET /api/model/options`
(hermes_cli/web_routers/models.py#L138, v0.22.2), called IN the dashboard process inside the Bot's config scope: no HTTP, no dashboard
token. Never `refresh=True` (it busts the provider cache and probes every provider). `usage` comes from Hermes's cache only
(hermes_cli/inventory.py#L289); a snapshot older than 15 minutes is omitted there, so a missing `usage` means "not known", not "0%".

Information only: the Budget, its executor and the cost watcher never import this module (a test reads their source), so a quota can
neither pause a Bot nor refuse a run. The cap of invariant 7 stays on what LuveBot itself measures.

What leaves is a whitelist. The payload also carries base URLs, model lists, prices, and per-account `id`/`label` (a pooled credential's
label can be an e-mail or a key hint): none of it is copied (invariant 1).
"""
import math
import threading
import time
from datetime import datetime, timezone

from .hermes_boundary import convert

TTL = 60.0          # a fetch is reused this long, per Bot
EMPTY_TTL = 10.0    # ...unless it came back empty: Hermes warms `usage` in the background, so the next open must ask again soon
WAIT = 2.5          # the route waits this long for a fetch in flight, then answers with what it has
STALE_MAX = 900.0   # Hermes itself drops usage snapshots at 15 minutes; so does the older copy we may serve while it refreshes
MAX_PROVIDERS, MAX_WINDOWS, MAX_ACCOUNTS, MAX_MODELS = 64, 8, 20, 50
STATES = ('ready', 'limited', 'unknown', 'unavailable')

_lock = threading.Lock()
_cache = {}   # bot -> (fetched_at, providers)
_flight = {}  # bot -> Event of the fetch running for it
_failed = {}  # bot -> reason of the last fetch when it failed


def _number(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _epoch(value):
    """Hermes sends ISO-8601; a time without a zone is UTC. Anything else is None."""
    if not isinstance(value, str):
        return None
    try:
        when = datetime.fromisoformat(value)
    except ValueError:
        return None
    return (when if when.tzinfo else when.replace(tzinfo=timezone.utc)).timestamp()


def _windows(rows):
    out = []
    for row in rows[:MAX_WINDOWS] if isinstance(rows, list) else ():
        used = _number(row.get('used_percent')) if isinstance(row, dict) else None
        if used is None:
            continue
        used = min(100.0, max(0.0, used))
        out.append({'label': str(row.get('label') or '')[:60], 'scope': str(row.get('scope') or '')[:16],
                    'used_percent': round(used, 1), 'remaining_percent': round(100.0 - used, 1), 'resets_at': _epoch(row.get('resets_at'))})
    return out


def _usage(usage):
    if not isinstance(usage, dict):
        return None
    if isinstance(usage.get('accounts'), list):  # a pool of 2+ credentials: one row each, unnamed (no id, no label)
        accounts = [{'state': a['state'] if a.get('state') in STATES else 'unknown', 'windows': _windows(a.get('windows')),
                     'resets_at': _epoch(a.get('resets_at'))}
                    for a in usage['accounts'][:MAX_ACCOUNTS] if isinstance(a, dict)]
        return {'accounts': accounts} if any(a['windows'] for a in accounts) else None  # no account with a valid window says nothing
    windows = _windows(usage.get('windows'))
    return {'windows': windows} if windows else None


def _limit(limit):
    if not isinstance(limit, dict):
        return None
    if limit.get('scope') == 'account' and _epoch(limit.get('resets_at')) is not None:
        return {'scope': 'account', 'resets_at': _epoch(limit['resets_at'])}
    if limit.get('scope') == 'models' and isinstance(limit.get('models'), dict):
        models = {str(m)[:128]: _epoch(at) for m, at in list(limit['models'].items())[:MAX_MODELS] if _epoch(at) is not None}
        return {'scope': 'models', 'models': models} if models else None
    return None


def shape(payload):
    """The `providers` of a model-options payload -> only those that carry a usage or a limit, as the whitelisted contract rows."""
    out = []
    for row in (payload.get('providers') if isinstance(payload, dict) else None) or ():
        if not isinstance(row, dict) or not isinstance(row.get('slug'), str) or not 0 < len(row['slug']) <= 64:
            continue
        usage, limit = _usage(row.get('usage')), _limit(row.get('limit'))
        if usage is not None or limit is not None:
            out.append({'slug': row['slug'], 'name': str(row.get('name') or row['slug'])[:80], 'usage': usage, 'limit': limit})
    return out[:MAX_PROVIDERS]


def _fetch(bot):
    from agent import account_usage_cache  # noqa: F401  (the windows come from it: a Hermes without it has no quota and must say so, not answer an empty list)
    from hermes_cli.inventory import build_model_options_payload, load_picker_context  # absent before v0.22: ImportError
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope(bot):
        return shape(build_model_options_payload(load_picker_context()))


def _run(bot, fetch, done):
    try:
        providers = convert(fetch)(bot)  # Hermes's config outage becomes an ordinary error: 'unreadable', never a thread that ends in silence
        with _lock:
            _cache[bot] = (time.time(), providers)
            _failed.pop(bot, None)
    except (ImportError, AttributeError):
        with _lock:
            _failed[bot] = 'hermes_without_quota'
    except Exception:  # noqa: BLE001  (a quota that cannot be read is simply not shown; the class is not even logged: it may name a path)
        with _lock:
            _failed[bot] = 'unreadable'
    finally:
        with _lock:
            _flight.pop(bot, None)
        done.set()


def _fresh(hit, now):
    return hit is not None and now() - hit[0] < (TTL if hit[1] else EMPTY_TTL)


def get(bot, *, fetch=_fetch, now=time.time):
    """-> {bot, providers|None, fetched_at|None, stale, reason|None}. Never raises and never waits more than WAIT: a fetch is started in
    a worker thread (one per Bot at a time), a fresh copy is reused for TTL, an older one (up to STALE_MAX) is served as `stale` when the
    refresh fails or is slow."""
    with _lock:
        hit = _cache.get(bot)
        if _fresh(hit, now):
            return {'bot': bot, 'providers': hit[1], 'fetched_at': hit[0], 'stale': False, 'reason': None}
        done = _flight.get(bot)
        if done is None:
            done = _flight[bot] = threading.Event()
            threading.Thread(target=_run, args=(bot, fetch, done), daemon=True, name=f'luvebot-quota-{bot[:24]}').start()
    done.wait(WAIT)
    with _lock:
        hit, failed = _cache.get(bot), _failed.get(bot)
    if _fresh(hit, now):
        return {'bot': bot, 'providers': hit[1], 'fetched_at': hit[0], 'stale': False, 'reason': None}
    if hit is not None and now() - hit[0] < STALE_MAX and failed != 'hermes_without_quota':
        return {'bot': bot, 'providers': hit[1], 'fetched_at': hit[0], 'stale': True, 'reason': None}
    return {'bot': bot, 'providers': None, 'fetched_at': None, 'stale': False, 'reason': failed or 'unreadable'}


def combine(results):
    """The route's body from the per-Bot `get` results. `available` means "we could read Hermes", NOT "there is a quota to show": a Bot's
    `providers` may be an empty list (nothing reports a quota, or Hermes has not warmed `usage` yet)."""
    have = [r for r in results if r['providers'] is not None]
    reason = None if have else (next((r['reason'] for r in results if r['reason'] == 'hermes_without_quota'), None)
                                or (results[0]['reason'] if results else None))
    return {'available': bool(have), 'reason': reason, 'fetched_at': min((r['fetched_at'] for r in have), default=None),
            'stale': any(r['stale'] for r in have), 'bots': [{'bot': r['bot'], 'providers': r['providers']} for r in have]}
