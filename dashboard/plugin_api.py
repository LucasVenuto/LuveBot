"""Minimal LuveBot router, mounted and authenticated by the Hermes dashboard."""
import asyncio
from datetime import date, datetime, timezone
import hashlib
import hmac
import importlib.util
import json
import logging
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import traceback
import urllib.parse
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.routing import APIRoute
from starlette.concurrency import run_in_threadpool
from agent.redact import redact_sensitive_text
from hermes_cli.web_routers.status import get_status

# Hermes loads plugin_api by file path, without placing the plugin root on sys.path.
# Use a plugin-specific package name; do not shadow another plugin's "backend".
if 'luvebot_backend' not in sys.modules:
    backend_dir = Path(__file__).resolve().parents[1] / 'backend'
    spec = importlib.util.spec_from_file_location('luvebot_backend', backend_dir / '__init__.py',
                                               submodule_search_locations=[str(backend_dir)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = package
    spec.loader.exec_module(package)
from luvebot_backend.api_errors import PluginError
from luvebot_backend.audit import ActionDenied, AuditLog, AuditUnavailable
from luvebot_backend.bot_meta import BotMeta, validate_display
from luvebot_backend import approval_surface, approvals, approvals_native, hook, hook_store, live_state, rules, rules_service, rules_store
from luvebot_backend.bots import (bot_object, create_in_hermes, detail_extras, initial_display, probe, profile_infos,
                                  validate_create)
from luvebot_backend.budget import Budget, BudgetUnavailable, MAX_CENTS
from luvebot_backend import activity, cost_watcher, costs, handoffs, hermes_cron, rooms, rooms_rpc, routines, search
from luvebot_backend.executor import Executor
from luvebot_backend.hermes_api import ApiClient, safe_id
from luvebot_backend.hermes_client import HermesClient, HermesError, feature_states, profile_names, validate_profile
from luvebot_backend.runs import (OPEN as OPEN_STATUSES, RunIndex, budget_gate, contract_status, has_limits, is_paused, upstream_error,
                                  validate_chat_body, validate_run_body, validate_session_body)
from luvebot_backend import bot_controls, pages, sse_proxy
from luvebot_backend import screen as bot_screen
from luvebot_backend.runs import RunRefused
from luvebot_backend.templates import TEMPLATES, get_template

_HEADERS = {'X-LuveBot-API': '0', 'Cache-Control': 'no-store'}
_CSRF_KEY = secrets.token_bytes(32)
_BASELINE_DATE = (2026, 9, 24)


def _code_digest():
    """sha256 of the plugin's Python code as it is ON DISK now (plugin_api.py and backend/*.py), or None if it cannot be read.
    Hermes mounts these routes once, when the dashboard starts (hermes_cli/web_server_dashboard.py: include_router at plugin
    discovery), while the UI bundle is read from disk on every load: after an update without a restart the new UI calls routes
    the running backend does not have (a bare 404, which the UI read as "Bot not found"). Comparing this with the digest taken at
    import says so (VPS 2026-10-02, the Screen tab of `default`)."""
    try:
        root = Path(__file__).resolve().parents[1]
        digest = hashlib.sha256()
        for path in [root / 'dashboard' / 'plugin_api.py', *sorted((root / 'backend').glob('*.py'))]:
            digest.update(path.name.encode() + b'\0' + path.read_bytes() + b'\0')
        return digest.hexdigest()
    except OSError:
        return None


_CODE_LOADED = _code_digest()  # what this process runs


def _error(code, message, status, extra=None):
    return JSONResponse({'error': {'code': code, 'message': message, 'request_id': 'req_' + uuid4().hex, **(extra or {})}},
                        status_code=status, headers=_HEADERS)


_LOOPBACK_HOSTS = frozenset({'127.0.0.1', 'localhost', '::1'})


def _authority_host(value):
    """Hostname of a Host header or of an Origin URL, lower-cased; '' when it cannot be read. Same reading as Hermes
    `_host_header_hostname` (hermes_cli/web_server.py#L582): "[::1]:9119" -> "::1", "a.b:9119" -> "a.b"."""
    value = (value or '').strip().lower()
    if '://' in value:
        value = value.split('://', 1)[1].split('/', 1)[0]
    if value.startswith('['):
        return value[1:value.index(']')] if ']' in value else ''
    if value.count(':') == 1:
        host, port = value.rsplit(':', 1)
        return host if host and port.isdigit() else ''
    return value if ':' not in value else ''


def _foreign_request(request):
    """Defence in depth for DNS rebinding and cross-site calls (red team 12). At the all-interfaces bind Hermes accepts ANY Host
    (`_is_accepted_host`, hermes_cli/web_server.py#L614), so this router checks for itself: the Host must be loopback or one the
    dashboard already trusts (`app.state.trusted_public_hosts`, from dashboard.public_url, `_dashboard_public_hosts` in hermes_cli/web_server.py), and an
    Origin that is present must be one of those too. -> an error code, or None."""
    trusted = getattr(request.app.state, 'trusted_public_hosts', frozenset()) or frozenset()
    allowed = _LOOPBACK_HOSTS | {h.lower() for h in trusted}
    if _authority_host(request.headers.get('host')) not in allowed:
        return 'host_not_allowed'
    origin = request.headers.get('origin')
    if origin is not None and _authority_host(origin) not in allowed:
        return 'origin_not_allowed'
    return None


class SafeRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def handle(request):
            try:
                foreign = _foreign_request(request)
                if foreign:
                    return _error(foreign, 'This request comes from an address the dashboard does not serve.', 403)
                # Invariant 2 before anything reads the request: FastAPI validates the query and path before the route's own
                # `_identity`, so in loopback a request without the session token got a 400 (red team gap G1.1), not a 401.
                _identity(request)
                # Runs before Hermes's injected profile dependency, whose error text
                # may contain the raw profile name. Keep all plugin errors our own.
                if 'profile' in request.query_params:
                    validate_profile(request.query_params['profile'])
                response = await original(request)
                response.headers.update(_HEADERS)
                return response
            except HermesError as error:
                return _error(error.code, error.message, error.status)
            except PluginError as error:
                return _error(error.code, error.message, error.status, error.extra)
            except BudgetUnavailable:
                return _error('budget_unavailable', 'The budget could not be verified, so nothing was changed.', 503)
            except AuditUnavailable:
                # Fail closed: no audit row, no effect (invariant 5).
                # Never "nothing was changed": the audit can fail on the RESULT row, after the action ran.
                return _error('audit_unavailable', 'The LuveBot audit log could not be written, so this action may not have been '
                              'recorded. Check Activity once the database is reachable again.', 503)
            except RequestValidationError:
                return _error('bad_request', 'Invalid request parameters.', 400)
            except HTTPException as error:
                if error.status_code == 401:
                    return _error('unauthorized', 'A dashboard session is required.', 401)
                return _error('hermes_error', 'Hermes returned an unexpected response.', 502)
            except sqlite3.DatabaseError as error:
                # LuveBot's own database (luvebot.db) could not be read or written: say so, never "Hermes is unavailable".
                _unexpected(request, self.path, error)
                # Never "nothing was changed": the database can fail on the result row, after the action ran.
                return _error('luvebot_db_unavailable', 'The LuveBot database (luvebot.db) is damaged or could not be read, so this action '
                              'may not have been recorded. Check Activity after it is recovered (scripts/backup_luvebot.py --check, with the '
                              'dashboard and the gateway stopped).', 503)
            except Exception as error:
                # No exception text or traceback in browser responses or plugin logs: the CLASS and the route, for the operator.
                _unexpected(request, self.path, error)
                return _error('hermes_unreachable', 'Hermes is unavailable.', 503)
        return handle


def _unexpected(request, route, error):
    """One log line an operator can act on without a secret: the exception class, the method and the route TEMPLATE
    (`/bots/{bot}/runs`, never the values), and where it was raised (our file and line). Never the message or the arguments."""
    frame = next((f for f in reversed(traceback.extract_tb(error.__traceback__)) if '/luvebot/' in f.filename), None)
    where = f"{frame.filename.rsplit('/luvebot/', 1)[-1]}:{frame.lineno}" if frame else '?'
    logging.getLogger('luvebot.route').warning('unexpected %s in %s %s (at %s)', type(error).__name__, request.method, route, where)


router = APIRouter(route_class=SafeRoute)


def _identity(request):
    gated = bool(getattr(request.app.state, 'auth_required', False))
    session = getattr(request.state, 'session', None)
    if gated:
        if session is None or not session.user_id or not session.provider or not session.access_token:
            raise HTTPException(status_code=401)
        actor = redact_sensitive_text(f'{session.provider}:{session.user_id}', force=True)
        credential = session.access_token
    else:
        # The native loopback gate has already verified this request.
        actor = 'dashboard'
        credential = request.headers.get('x-hermes-session-token', '')
        if not credential:
            raise HTTPException(status_code=401)
    return actor, credential, 'gated' if gated else 'loopback'


def _baseline_state(raw_date):
    """'ok' | 'unsupported' (a readable release older than the baseline: proof) | 'unverified' (no readable release: no proof
    either way, so it fails closed with its own recoverable error and never says "update Hermes")."""
    if not isinstance(raw_date, str) or not re.fullmatch(r'[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}', raw_date):
        return 'unverified'
    try:
        return 'ok' if date(*map(int, raw_date.split('.'))) >= date(*_BASELINE_DATE) else 'unsupported'
    except ValueError:
        return 'unverified'


def _release_date():
    """The release date of the RUNNING Hermes: the constant /api/status reports (hermes_cli/web_routers/status.py#L503), read in
    this process. Deciding the baseline from it needs no probe, so a slow /api/status (gateway health, topology, sessions, memory)
    can never read as an old Hermes (blocker 2026-10-02). None when it cannot be read."""
    try:
        import hermes_cli
        return hermes_cli.__release_date__
    except Exception:
        return None


def _baseline():
    """The one baseline check every feature gate uses: see _baseline_state."""
    return _baseline_state(_release_date())


def _version(status):
    raw_version, raw_date = status.get('version'), status.get('release_date')
    version = raw_version if isinstance(raw_version, str) and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?', raw_version) else 'unknown'
    state = _baseline_state(raw_date)
    release = raw_date if state != 'unverified' else None
    return {'version': redact_sensitive_text(version, force=True), 'release_date': redact_sensitive_text(release, force=True) if release else None,
            'baseline': 'f8489405', 'baseline_ok': state == 'ok'}


_UNVERIFIED = ('hermes_status_unverified', "Could not confirm this Hermes's version right now; try again.")


def _approvals_state(db_path, name):
    """T10.3: an `ask` rule reaches a person only through this Bot's LuveBot hook, so approvals are as available as that hook
    (the same states hook_gate accepts for new work); a state that cannot be read is unknown, never ok."""
    try:
        return 'ok' if hook.hook_state(db_path, name)['status'] in ('live', 'disabled_pending_restart') else 'unavailable'
    except Exception as error:  # the class only (a profile name is not a secret): e.g. luvebot.db unreadable for this Bot's rows
        logging.getLogger('luvebot.hook').warning('hook state unreadable for %s: %s', name, type(error).__name__)
        return 'unknown'


async def _groups_state():
    """T10.3: Group Chat as the real groups.capabilities reports it (the same call the room routes gate on)."""
    try:
        result = await asyncio.wait_for(_room_call('groups.capabilities', {}), timeout=5)
    except PluginError as error:
        return 'unavailable' if error.code == 'capability_missing' else 'unknown'
    except Exception:
        return 'unknown'
    return 'ok' if isinstance(result, dict) and result.get('driver') is True else 'unavailable'


@router.get('/session')
def session(request: Request):
    actor, credential, mode = _identity(request)
    # Opaque per verified session, not a stored cookie or a reusable Hermes token.
    return {'csrf': _csrf_for(credential), 'actor': actor, 'auth_mode': mode}


async def _health_db():
    """(db view, path). The existing audited store owns its schema/writes; this router does not."""
    try:
        from luvebot_backend.audit import AuditLog
        from hermes_cli.web_server_profiles import get_process_hermes_home
        db_path = get_process_hermes_home() / 'luvebot/luvebot.db'
        audit = await run_in_threadpool(AuditLog, db_path)
        checked = await run_in_threadpool(audit.verify)
        return {'ok': checked['ok'] is True, 'schema_version': 1}, db_path
    except Exception:
        return {'ok': False, 'schema_version': None}, None


async def _health_status():
    try:
        status = await asyncio.wait_for(get_status(), timeout=5)
        return status if isinstance(status, dict) else None
    except Exception:
        return None


async def _capabilities(name):
    """The capability probe of one profile, or the HermesError it raised (kept, handled in order by the caller)."""
    try:
        return await run_in_threadpool(HermesClient(name).capabilities)
    except HermesError as error:
        return error


@router.get('/health')
async def health(request: Request, response: Response = None, profile: str = None):
    _identity(request)
    problems = []
    reachable = True
    t0 = time.perf_counter()
    try:
        names = [validate_profile(profile)] if profile is not None else profile_names()
    except HermesError:
        names = None
    # independent reads together (same timeouts, same failures): the audit db, Hermes's status, each profile's probe
    (db, db_path), status, probes = await asyncio.gather(_health_db(), _health_status(),
                                                         asyncio.gather(*[_capabilities(name) for name in names or []]))
    t1 = time.perf_counter()
    if not db['ok']:
        reachable = False
        problems.append({'code': 'audit_unavailable', 'feature': 'db', 'message': 'The LuveBot audit database is unavailable.'})
    if status is None:
        status = {}
        reachable = False
        problems.append({'code': 'hermes_unreachable', 'feature': 'hermes', 'message': 'Hermes status is unavailable.'})
    baseline = _baseline()
    hermes = _version({'version': status.get('version'), 'release_date': _release_date()})
    if baseline == 'unsupported':
        problems.append({'code': 'baseline_unsupported', 'feature': 'hermes',
                         'message': 'Hermes release 2026.9.24 or later is required; update Hermes.'})
    elif baseline == 'unverified':
        problems.append({'code': _UNVERIFIED[0], 'feature': 'hermes', 'message': _UNVERIFIED[1]})
    profiles = {}
    if names is None:
        names = []
        reachable = False
    for name, capabilities in zip(names, probes):
        try:
            if isinstance(capabilities, HermesError):
                raise capabilities
            states = feature_states(capabilities, hermes['baseline_ok'])
            profiles[name] = {'reachable': True, 'features': states}
            for feature, state in states.items():
                if state != 'ok' and baseline == 'ok':          # otherwise the baseline problem above already says why
                    problems.append({'code': 'capability_missing', 'feature': feature,
                                     'message': 'This feature is unavailable for this Bot; update Hermes or enable its API Server.'})
            states['approvals'] = 'unavailable' if states['runs'] != 'ok' else await run_in_threadpool(_approvals_state, db_path, name)
        except HermesError as error:
            reachable = False
            profiles[name] = {'reachable': False, 'features': {'runs': 'unavailable', 'session_chat_stream': 'unavailable', 'approvals': 'unavailable'}}
            problems.append({'code': error.code, 'feature': 'api_server', 'message': error.message})
        got = profiles[name]['features']
        if got['approvals'] != 'ok':
            code = 'capability_unverified' if got['approvals'] == 'unknown' else 'hook_not_live' if got['runs'] == 'ok' else 'capability_missing'
            problems.append({'code': code, 'feature': 'approvals', 'bot': name,
                             'message': 'Approvals for this Bot need its API Server and the LuveBot rules loaded; install them from the Bot.'})
    if not names:
        reachable = False
        problems.append({'code': 'hermes_unreachable', 'feature': 'profiles', 'message': 'No Hermes profiles are available.'})
    features = {feature: 'ok' if profiles and all(item['features'][feature] == 'ok' for item in profiles.values()) else 'unavailable'
                for feature in ('runs', 'session_chat_stream')}
    approvals = {item['features']['approvals'] for item in profiles.values()}
    features['approvals'] = 'ok' if approvals == {'ok'} else 'unavailable' if 'unavailable' in approvals or not approvals else 'unknown'
    # T10.3: approvals go through the LuveBot hook and Hermes's run approval, never the approval transport plugin hook.
    features['approval_transport'] = 'not_used'
    features['groups'] = await _groups_state()
    features['pages'] = pages.feature()  # v0.5 section 8
    if features['groups'] == 'unavailable':
        problems.append({'code': 'capability_missing', 'feature': 'groups', 'message': 'Group Chat is not running in this Hermes.'})
    elif features['groups'] == 'unknown':
        problems.append({'code': 'capability_unverified', 'feature': 'groups', 'message': 'Group Chat could not be checked right now.'})
    t2 = time.perf_counter()
    if response is not None:  # FastAPI injects it; a direct in-process call has none
        response.headers['Server-Timing'] = _server_timing([('reads', t0, t1), ('features', t1, t2), ('total', t0, t2)])
    on_disk = await run_in_threadpool(_code_digest)
    code_current = None if on_disk is None or _CODE_LOADED is None else on_disk == _CODE_LOADED
    if code_current is False:
        problems.append({'code': 'plugin_restart_required', 'feature': 'plugin',
                         'message': 'LuveBot was updated on disk, but the dashboard still runs the previous version; restart the dashboard.'})
    return {'ok': reachable and code_current is not False, 'plugin': {'version': '0.1.0', 'api': '0', 'db': db, 'code_current': code_current},
            'hermes': hermes,
            'sdk': {'version': '1.1.0', 'supported': hermes['baseline_ok']},
            'auth': {'required': bool(getattr(request.app.state, 'auth_required', False))},
            'features': features, 'problems': problems}


# ---------------------------------------------------------------------------
# Bots (contract section 4) and the CSRF gate for every mutation (section 1, T6)
# ---------------------------------------------------------------------------
MAX_BODY = 64 * 1024


def _csrf_for(credential):
    return hmac.new(_CSRF_KEY, credential.encode(), hashlib.sha256).hexdigest()


def _require_csrf(request, credential):
    """403 csrf_required unless X-LuveBot-CSRF matches this verified session. Runs before any audit row or effect."""
    sent = request.headers.get('x-luvebot-csrf', '')
    if not hmac.compare_digest(sent.encode(), _csrf_for(credential).encode()):
        raise PluginError('csrf_required', 'A valid X-LuveBot-CSRF header is required for this action.', 403)


async def _json_body(request, limit=MAX_BODY):
    raw = await request.body()
    if len(raw) > limit:
        raise PluginError('too_large', 'Request body is too large.', 413)
    try:
        return json.loads(raw or b'{}')
    except ValueError:
        raise PluginError('bad_request', 'Malformed JSON body.', 400) from None


def _stores():
    from hermes_cli.web_server_profiles import get_process_hermes_home
    path = get_process_hermes_home() / 'luvebot/luvebot.db'
    audit = AuditLog(path)  # creates the 0600 file and the append-only schema
    return audit, BotMeta(path)


def _refresh_run(index, name, run):
    """Ask Hermes whether a tracked run is still open. Unverifiable means "not claimed", never "working"."""
    try:
        status, payload = ApiClient(name).call('GET', '/v1/runs/' + run['run_id'], timeout=3)
    except HermesError:
        return None
    if status == 404:
        index.set_status(run['run_id'], 'lost')  # Hermes no longer knows it (restart, expiry)
        return None
    raw = payload.get('status') if status == 200 and payload else None
    if not isinstance(raw, str):
        return None
    index.set_status(run['run_id'], raw[:64])
    return {**run, 'last_status': raw} if raw in OPEN_STATUSES else None


async def _open_runs_checked(index, name):
    open_runs = await run_in_threadpool(index.open_runs, name)
    return [run for run in await asyncio.gather(*[run_in_threadpool(_refresh_run, index, name, run) for run in open_runs]) if run]


async def _live(name, index, path):
    """One Bot's live state: the independent reads run together (each keeps its own failure: _refresh_run never claims
    "working" unverified, recent_sources reports a failed source in status_partial, _routine_results gives None, _hook_view
    never says "live" when unreadable); unread then needs the routine count."""
    checked, sources, pause, routine_results, paused, hook_view = await asyncio.gather(
        _open_runs_checked(index, name),
        run_in_threadpool(bot_controls.recent_sources, name),
        run_in_threadpool(lambda: bot_controls.pause_state(path, name, consistent=False)),
        run_in_threadpool(_routine_results, path, name),
        run_in_threadpool(_paused_view, path, name),
        run_in_threadpool(_hook_view, path, name))
    if routine_results is None:
        sources['status_partial'].append('routine_results')
    if paused is None:
        sources['status_partial'].append('paused')
    return {**sources, 'pause_state': pause, 'unread': await run_in_threadpool(bot_controls.unread, path, name, routine_results),
            'paused': paused, 'open_runs': checked, 'hook': hook_view}


def _paused_view(path, name):
    """For display only: an unreadable budget pause is unknown (None, listed in status_partial), never "not paused". The gates
    (runs.budget_gate, _start_gate, resume) call is_paused/has_limits themselves and refuse."""
    try:
        return is_paused(path, name)
    except BudgetUnavailable:
        return None


def _server_timing(marks):
    """Server-Timing value from [(phase, start, end)] (perf_counter seconds): phase names and milliseconds only, no data."""
    return ', '.join(f'{phase};dur={(end - start) * 1000:.1f}' for phase, start, end in marks)


def _hook_view(path, name):
    """hook.status of ADR-003 section 5. Unreadable state is never presented as "live"."""
    try:
        return hook.hook_state(path, name)
    except Exception:
        return {'status': 'absent', 'version': None, 'heartbeat_age_s': None, 'table_digest': None}


async def _bot(name, info, display, baseline, index, path):
    probed, live = await asyncio.gather(run_in_threadpool(probe, name, baseline), _live(name, index, path))
    return bot_object(info, display, probed, live)


@router.get('/bots')
async def list_bots(request: Request, response: Response = None):
    _identity(request)
    t0 = time.perf_counter()
    audit, meta = await run_in_threadpool(_stores)
    baseline = _baseline() == 'ok'
    t1 = time.perf_counter()
    infos, rows = await asyncio.gather(run_in_threadpool(profile_infos), run_in_threadpool(meta.all))
    index = await run_in_threadpool(RunIndex, meta.path)
    t2 = time.perf_counter()
    bots = await asyncio.gather(*[_bot(i['name'], i, meta.display_for(i['name'], rows), baseline, index, meta.path) for i in infos])
    t3 = time.perf_counter()
    fleet = await run_in_threadpool(bot_controls.fleet_view)
    t4 = time.perf_counter()
    if response is not None:
        response.headers['Server-Timing'] = _server_timing([('stores', t0, t1), ('profiles', t1, t2), ('bots', t2, t3), ('fleet', t3, t4),
                                                        ('total', t0, t4)])
    # session titles reach current_task (v0.4 B7): every string is redacted
    return _redact_deep({'bots': list(bots), 'fleet': fleet})


async def _one(name, extras=False):
    name = validate_profile(name)
    audit, meta = await run_in_threadpool(_stores)
    baseline = _baseline() == 'ok'
    infos, display = await asyncio.gather(run_in_threadpool(profile_infos), run_in_threadpool(meta.get, name))
    info = next((i for i in infos if i['name'] == name), None)
    if info is None:
        raise HermesError('bot_not_found')
    index = await run_in_threadpool(RunIndex, meta.path)
    bot = await _bot(name, info, display, baseline, index, meta.path)
    return _redact_deep({**bot, **(await detail_extras(name))} if extras else bot)


@router.get('/bots/{bot}')
async def get_bot(bot: str, request: Request):
    _identity(request)
    return await _one(bot, extras=True)


@router.patch('/bots/{bot}/display')
async def patch_display(bot: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = validate_profile(bot)
    changes = validate_display(await _json_body(request))
    audit, meta = await run_in_threadpool(_stores)
    await run_in_threadpool(audit.act, actor, 'bot.display.update', name, {'kind': 'ui'}, lambda: meta.upsert(name, changes),
                            bot=name, payload=changes)
    return await _one(name)


@router.get('/templates')
def list_templates(request: Request):
    _identity(request)
    return {'templates': TEMPLATES}


@router.post('/bots')
async def create_bot(request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    body = await _json_body(request, bot_controls.SOUL_MAX * 6 + MAX_BODY)
    soul = bot_controls.validate_soul(body.pop('soul')) if isinstance(body, dict) and 'soul' in body else None  # v0.4 B6
    name, template, changes, model = await run_in_threadpool(validate_create, body)
    audit, meta = await run_in_threadpool(_stores)
    display = initial_display(name, template, changes)
    await run_in_threadpool(audit.act, actor, 'bot.create', name, {'kind': 'ui'},
                            lambda: create_in_hermes(name, template, display, model, meta, soul), bot=name,
                            payload={**body, **({'soul_sha256': bot_controls.digest(soul)} if soul is not None else {})})
    bot = await _one(name)
    # The intro session needs the new profile's API Server key, which Hermes does not provision at create time.
    return JSONResponse({'bot': bot, 'intro': {'session_id': None}}, status_code=201, headers=_HEADERS)


# ---- D-025: where this Bot's approvals are answered ---------------------------------------------------------------------
async def _existing_bot(bot):
    name = validate_profile(bot)
    if name not in await run_in_threadpool(lambda: [i['name'] for i in profile_infos()]):
        raise HermesError('bot_not_found')
    return name


@router.get('/bots/{bot}/approval-surface')
async def get_approval_surface(bot: str, request: Request):
    _identity(request)
    name = await _existing_bot(bot)
    _audit, meta = await run_in_threadpool(_stores)
    return JSONResponse({'approval_surface': await run_in_threadpool(approval_surface.view, meta.path, name)}, headers=_HEADERS)


@router.put('/bots/{bot}/approval-surface')
async def put_approval_surface(bot: str, request: Request):
    """By a person only: CSRF, audited before the effect. Letting more approvals reach a chat (turning `channel` on, or naming a
    new approver) is refused in loopback (D-012/D-014: the token names the machine, not a person); narrowing is allowed. `channel`
    is refused while the gateway lets every sender in (409 approval_surface_unsafe)."""
    actor, credential, mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing_bot(bot)
    new_mode, approvers = approval_surface.parse(await _json_body(request))
    audit, meta = await run_in_threadpool(_stores)
    current = await run_in_threadpool(hook_store.read_surface, meta.path, name)
    if (approval_surface.loosens(current, new_mode, approvers) and mode == 'loopback'
            and os.environ.get('LUVEBOT_ALLOW_LOOPBACK_APPROVALS') != '1'):
        raise PluginError('loopback_not_human', 'Letting approvals reach a chat needs a dashboard with a login; this one is in loopback mode.', 403)

    def effect():
        if new_mode == 'channel':
            on, reason = approval_surface.allow_all(name)
            if on:
                raise PluginError('approval_surface_unsafe', 'The gateway lets every sender in, so approvals cannot go to a chat.', 409,
                                  {'details': {'reason': reason}})
        hook_store.put_surface(meta.path, name, new_mode, approvers, actor)
    await run_in_threadpool(audit.act, actor, 'bot.approval_surface', name, {'kind': 'ui'}, effect, bot=name,
                            payload={'from': current['mode'], 'mode': new_mode, 'approvers': approvers})
    # the hook reports a new setting within seconds: answer once it has (bounded), not "not applied" for one about to be
    return JSONResponse({'approval_surface': await run_in_threadpool(approval_surface.view_after_save, meta.path, name)}, headers=_HEADERS)


# ---- D-007: the Bot's live screen (proposal docs/propostas/d007-aba-tela.md) -------------------------------------------
async def _screen_act(request, bot, action, effect, *, refuse_in_loopback=False, payload=None):
    """One audited screen effect by a person: CSRF, the intent before the effect, the result after (the ticket never enters the audit
    payload). Giving control back to the agent loosens, so in loopback it is refused (D-007 decision 1)."""
    actor, credential, mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing_bot(bot)
    if refuse_in_loopback and mode == 'loopback' and os.environ.get('LUVEBOT_ALLOW_LOOPBACK_APPROVALS') != '1':
        raise PluginError('loopback_not_human', 'Giving control back needs a dashboard with a login; this one is in loopback mode.', 403)
    audit, meta = await run_in_threadpool(_stores)
    screen = bot_screen.Screen(meta.path)
    result = await run_in_threadpool(audit.act, actor, action, name, {'kind': 'ui'}, lambda: effect(screen, name, actor), bot=name,
                                     payload=payload)
    return JSONResponse(result, headers=_HEADERS)


@router.get('/bots/{bot}/screen')
async def get_bot_screen(bot: str, request: Request):
    actor, _credential, _mode = _identity(request)
    name = await _existing_bot(bot)
    _audit, meta = await run_in_threadpool(_stores)
    return JSONResponse({'screen': await run_in_threadpool(bot_screen.Screen(meta.path).view, name, actor)}, headers=_HEADERS)


async def _no_body(request):
    if (await request.body()).strip() not in (b'', b'{}'):
        raise PluginError('bad_request', 'This action takes no body.', 400)


@router.post('/bots/{bot}/screen/start')
async def start_bot_screen(bot: str, request: Request):
    await _no_body(request)
    return await _screen_act(request, bot, 'screen.start', lambda s, b, a: {'screen': s.start(b, a)})


@router.post('/bots/{bot}/screen/stop')
async def stop_bot_screen(bot: str, request: Request):
    await _no_body(request)
    return await _screen_act(request, bot, 'screen.stop', lambda s, b, a: {'screen': s.stop(b, a)})


@router.post('/bots/{bot}/screen/watch')
async def watch_bot_screen(bot: str, request: Request):
    await _no_body(request)
    return await _screen_act(request, bot, 'screen.watch', lambda s, b, a: s.watch(b))


@router.post('/bots/{bot}/screen/take')
async def take_bot_screen(bot: str, request: Request):
    raw = (await request.body()).strip()
    body = {} if raw in (b'', b'{}') else await _json_body(request)
    if not isinstance(body, dict) or set(body) - {'reason'} or not isinstance(body.get('reason', ''), str) or len(body.get('reason', '')) > 120:
        raise PluginError('invalid_field', 'Send nothing, or {"reason": "<up to 120 characters>"}.', 422)
    reason = redact_sensitive_text(body.get('reason', '').strip(), force=True)   # it reaches the audit and Hermes's public lease
    return await _screen_act(request, bot, 'screen.take', lambda s, b, a: s.take(b, a, reason), payload={'reason': reason})


@router.post('/bots/{bot}/screen/return')
async def return_bot_screen(bot: str, request: Request):
    await _no_body(request)
    return await _screen_act(request, bot, 'screen.return', lambda s, b, a: s.give_back(b, a), refuse_in_loopback=True)


@router.post('/bots/{bot}/hook/install')
async def install_bot_hook(bot: str, request: Request):
    """ADR-003 3.3: install (or update) the rules hook in an existing Bot. By human click only: CSRF, audited before the
    effect, idempotent, no body (the plugin source and revision are fixed on the server, never taken from the client).
    In loopback it is allowed: it only tightens (D-015 B-4)."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = validate_profile(bot)
    if (await request.body()).strip() not in (b'', b'{}'):
        raise PluginError('bad_request', 'This action takes no body.', 400)
    if name not in await run_in_threadpool(lambda: [i['name'] for i in profile_infos()]):
        raise HermesError('bot_not_found')
    audit, meta = await run_in_threadpool(_stores)

    def effect():
        try:
            return hook.install_hook(meta.path, name)
        except hook.HookError as error:
            raise PluginError('hook_install_failed', 'Installing the LuveBot rules in the Bot failed.', 502,
                              {'step': 'hook_install', 'reason': error.code}) from None

    result = await run_in_threadpool(audit.act, actor, 'bot.hook.install', name, {'kind': 'ui'}, effect, bot=name,
                                     payload={'bot': name})
    return JSONResponse({'hook': await run_in_threadpool(_hook_view, meta.path, name), **result}, status_code=200, headers=_HEADERS)


@router.delete('/bots/{bot}/hook')
async def remove_bot_hook(bot: str, request: Request):
    """Disabling or removing the hook loosens the rules, so in loopback it is refused (D-015 B-4, same logic as D-012).
    LuveBot has no such action in this version: with a login the answer is 405 and nothing is touched."""
    _actor, credential, mode = _identity(request)
    _require_csrf(request, credential)
    validate_profile(bot)
    if mode == 'loopback':
        raise PluginError('loopback_not_human', 'Loosening the rules needs a dashboard with a login; this dashboard is in loopback mode.', 403)
    raise PluginError('not_supported', 'LuveBot does not disable or remove the rules hook; do it in Hermes.', 405)


# ---------------------------------------------------------------------------
# Sessions and runs (contract section 5, no SSE). Proxy to /p/<bot>/... of the API Server; see backend/runs.py
# for the Hermes route behind each one.
# ---------------------------------------------------------------------------
MAX_RUN_BODY = 256 * 1024


def _clean(value, depth=0):
    """Text that came from Hermes passes the redactor; shapes are bounded (contract 6.3 spirit)."""
    if isinstance(value, str):
        return redact_sensitive_text(value[:100_000], force=True)
    if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
        return value
    if depth < 3 and isinstance(value, dict):
        return {str(k)[:64]: _clean(v, depth + 1) for k, v in list(value.items())[:50]}
    if depth < 3 and isinstance(value, list):
        return [_clean(v, depth + 1) for v in value[:50]]
    return None


def _run_view(payload, run_id):
    status, raw = contract_status(payload.get('status'))
    usage = payload.get('usage')
    run = {'id': run_id, 'status': status,
           'session_id': payload['session_id'] if isinstance(payload.get('session_id'), str) else None,
           'output': _clean(payload['output']) if isinstance(payload.get('output'), str) else None,
           'error': _clean(payload['error']) if isinstance(payload.get('error'), str) else None,
           'usage': {str(k)[:64]: v for k, v in usage.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
           if isinstance(usage, dict) else None,
           'pending_steer': _clean(payload.get('pending_steer'))}
    if raw:
        run['status_raw'] = raw
    return run


async def _require_feature(name, feature):
    """409 capability_missing (section 5) unless the profile's API Server reports the feature; offline is left to the call.
    Each cause says its own thing: an unverifiable baseline is 503 hermes_status_unverified (and the Bot is not even asked), a
    proven old Hermes says "update Hermes", an API Server that answered wrongly (a wrong key: 401) is hermes_error."""
    baseline = _baseline()
    if baseline == 'unverified':
        raise PluginError(*_UNVERIFIED, 503)
    caps, offline, failure = await run_in_threadpool(lambda: probe(name, baseline == 'ok', with_failure=True))
    if offline or caps.get(feature):
        return
    if baseline == 'unsupported':
        raise PluginError('capability_missing', 'This Hermes is older than release 2026.9.24; update Hermes.', 409,
                          {'feature': feature, 'reason': 'baseline_unsupported'})
    if failure is not None:
        raise HermesError(failure)
    raise PluginError('capability_missing', 'This feature is unavailable for this Bot; update Hermes or enable its API Server.',
                      409, {'feature': feature})


_NO_404 = ('hermes_error', 'Hermes returned an unexpected response.', 502)
_RUN_404 = ('run_not_found', 'Run not found.', 404)


async def _owned_run(bot, run_id, index):
    """Run ids from the browser are checked against our index: a run is only reachable through its own Bot (T3)."""
    name = validate_profile(bot)
    if safe_id(run_id) is None or not await run_in_threadpool(index.owns, name, run_id):
        raise PluginError(*_RUN_404[:2], _RUN_404[2])
    return name


@router.post('/bots/{bot}/sessions')
async def create_session(bot: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = validate_profile(bot)
    fields = validate_session_body(await _json_body(request))
    await _require_feature(name, 'session_chat_stream')
    audit, meta = await run_in_threadpool(_stores)

    def effect():
        status, payload = ApiClient(name).call('POST', '/api/sessions', fields)
        if status != 201 or not payload or not isinstance(payload.get('session'), dict):
            raise upstream_error(status, on_404=_NO_404)
        return payload['session']

    session = await run_in_threadpool(audit.act, actor, 'session.create', None, {'kind': 'ui'}, effect, bot=name, payload=fields)
    session_id = safe_id(session.get('id'))
    if session_id is None:
        raise HermesError('hermes_error')
    started = session.get('started_at')
    created = datetime.fromtimestamp(started, timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z') \
        if isinstance(started, (int, float)) and not isinstance(started, bool) else None
    title = session.get('title')
    return JSONResponse({'session': {'id': session_id, 'title': _clean(title) if isinstance(title, str) else None,
                                     'created_at': created}}, status_code=201, headers=_HEADERS)


def _refresh_hint(name, audit, actor):
    """Before a turn: the Bot's LuveBot hint follows its workspace (the absolute Pages path), rewritten only when it differs, and
    audited then. It never blocks the turn: on any failure the previous hint stays."""
    try:
        bot_controls.ensure_markdown_hint(name, audit, actor, {'kind': 'ui'}, refresh_only=True)
    except Exception:  # noqa: BLE001
        pass


@router.post('/bots/{bot}/runs')
async def create_run(bot: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = validate_profile(bot)
    fields = validate_run_body(await _json_body(request, MAX_RUN_BODY))
    await _require_feature(name, 'runs')
    audit, meta = await run_in_threadpool(_stores)
    if fields['page']:  # v0.5 7.2: the note is built here, never taken from the client; the audit digest covers the forwarded text
        fields['input'] = await run_in_threadpool(_page_note, request, actor, name, meta, fields['page']) + '\n\n' + fields['input']
    index = await run_in_threadpool(RunIndex, meta.path)
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)
    await run_in_threadpool(_refresh_hint, name, audit, actor)

    def effect():
        hook.hook_gate(meta.path, name)  # D-015 B-3: no new work where the rules hook is not live
        budget_gate(budget, meta.path, name)  # invariant 7: no new run for a paused or capped Bot
        body = {k: fields[k] for k in ('input', 'session_id', 'instructions') if fields[k] is not None}
        headers = {'Idempotency-Key': fields['idempotency_key']} if fields['idempotency_key'] else {}
        status, payload = ApiClient(name).call('POST', '/v1/runs', body, headers=headers)
        if status not in (200, 202) or not payload:
            raise upstream_error(status, on_404=_NO_404, on_409=('duplicate', 'This idempotency key was already used with a different request.', 409))
        run_id = safe_id(payload.get('run_id'))
        if run_id is None:
            raise HermesError('hermes_error')
        state = contract_status(payload.get('status'))[0]
        index.add(run_id, name, fields['session_id'], actor, state if state != 'unknown' else 'started', index.prompt_digest(fields['input']))
        return run_id, state

    run_id, state = await run_in_threadpool(audit.act, actor, 'run.create', fields['session_id'], {'kind': 'ui'}, effect,
                                            bot=name, payload=fields)
    approvals_native.start_watcher(meta.path, name, run_id, _REDACT)  # captures approval requests with no browser attached (A-19)
    return JSONResponse({'run': {'id': run_id, 'status': state, 'bot': name, 'session_id': fields['session_id']}},
                        status_code=202, headers=_HEADERS)


@router.get('/bots/{bot}/runs/{run_id}')
async def get_run(bot: str, run_id: str, request: Request):
    _identity(request)
    audit, meta = await run_in_threadpool(_stores)
    index = await run_in_threadpool(RunIndex, meta.path)
    name = await _owned_run(bot, run_id, index)
    await _require_feature(name, 'runs')
    status, payload = await run_in_threadpool(ApiClient(name).call, 'GET', '/v1/runs/' + run_id)
    if status != 200 or not payload:
        raise upstream_error(status, on_404=_RUN_404)
    view = _run_view(payload, run_id)
    raw = payload.get('status')
    if isinstance(raw, str):
        await run_in_threadpool(index.set_status, run_id, raw[:64])
    return {'run': view}


def _stop_native(name, run_id):
    """The one place that stops a run in Hermes (the Bot's own stop route and the Activity stop both come here)."""
    status, payload = ApiClient(name).call('POST', f'/v1/runs/{run_id}/stop', {})
    if status != 200 or not payload:
        raise upstream_error(status, on_404=_RUN_404, on_409=('conflict', 'This run is no longer active.', 409))
    return payload.get('status')


@router.post('/bots/{bot}/runs/{run_id}/stop')
async def stop_run(bot: str, run_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    audit, meta = await run_in_threadpool(_stores)
    index = await run_in_threadpool(RunIndex, meta.path)
    name = await _owned_run(bot, run_id, index)
    await _require_feature(name, 'runs')

    raw = await run_in_threadpool(audit.act, actor, 'run.stop', run_id, {'kind': 'ui'}, lambda: _stop_native(name, run_id), bot=name)
    if isinstance(raw, str):
        await run_in_threadpool(index.set_status, run_id, raw[:64])
    return JSONResponse({'run': {'id': run_id, 'status': contract_status(raw)[0]}}, status_code=202, headers=_HEADERS)


# ---------------------------------------------------------------------------
# SSE (contract section 6). StreamingResponse inside the dashboard process: no port, no second server.
# Hermes routes: GET /v1/runs/{id}/events (api_server_runs.py#L1064) and POST /api/sessions/{sid}/chat/stream
# (api_server.py, _handle_chat_stream), both reached through /p/<profile>/ with the profile's key.
# ---------------------------------------------------------------------------
FIRST_BYTE_SECONDS, PING_SECONDS, IDLE_SECONDS, QUEUE_LINES = 30, 15, 300, 1024
_TERMINAL_STATUS = {'run.completed': 'completed', 'run.cancelled': 'cancelled', 'run.failed': 'failed'}
_REDACT = lambda text: redact_sensitive_text(text, force=True)


async def _with_digest(path, bot, run_id, surface, data):
    """Store the request and add LuveBot's own `luvebot_digest` (A-14) to the frame the browser gets. If the request cannot be
    stored the frame goes through WITHOUT a digest, so nobody can resolve it from here (fail closed)."""
    try:
        row = await run_in_threadpool(approvals.record_request, path, bot, run_id, surface, data)
        return {**data, 'luvebot_digest': row['digest']}
    except Exception:
        return data


def _expire_run(path, run_id):
    try:
        approvals.expire_run(path, run_id)
    except Exception:
        pass


async def _relay(upstream, surface, bot, index, actor, ids, sha=None):
    """Frames of ours around the upstream's. Closing this generator (client gone) closes the upstream, never the run."""
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue(maxsize=QUEUE_LINES)
    overflow = []

    def push(item):
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:  # a slow client is disconnected, never allowed to grow memory
            overflow.append(True)
            upstream.abort()

    def reader():
        try:
            for line in upstream.lines(sse_proxy.MAX_LINE):
                loop.call_soon_threadsafe(push, ('line', line))
            loop.call_soon_threadsafe(push, ('end', None))
        except Exception:
            loop.call_soon_threadsafe(push, ('error', None))

    threading.Thread(target=reader, daemon=True).start()  # not the shared pool: a stream lives for minutes
    parser, seq, waited, first, terminal, run_id = sse_proxy.SseReader(), 0, 0, True, None, ids.get('run_id')
    page_pending = False  # v0.5 7.1: a debounced rescan still owed to this run

    def close(reason, **fields):
        return sse_proxy.ours(seq, 'luvebot.stream.close', reason=reason)

    try:
        yield sse_proxy.ours(seq, 'luvebot.stream.open', bot=bot, surface=surface, api='0', **ids)
        while True:
            try:
                kind, line = await asyncio.wait_for(queue.get(), FIRST_BYTE_SECONDS if first else PING_SECONDS)
            except asyncio.TimeoutError:
                if first:
                    yield sse_proxy.ours(seq, 'luvebot.error', code='hermes_timeout', message='The local Hermes API Server did not respond in time.')
                    yield close('timeout')
                    return
                waited += PING_SECONDS
                if waited >= IDLE_SECONDS:  # idle ends OUR stream, never the run
                    yield close('upstream_closed')
                    return
                yield b': ping\n\n'
                continue
            if overflow:
                return
            first, waited = False, 0
            if kind == 'error':
                yield sse_proxy.ours(seq, 'luvebot.error', code='hermes_error', message='Hermes returned an unexpected response.')
                yield close('upstream_closed')
                return
            if kind == 'end':
                yield close(terminal or 'upstream_closed')
                return
            parsed = parser.feed(line)
            if not parsed:
                continue
            frame = sse_proxy.transform(surface, parsed[0], parsed[1], _REDACT)
            if frame is None:
                continue
            event, data = frame
            if isinstance(data.get('seq'), int) and not isinstance(data['seq'], bool):
                seq = data['seq']
            if run_id is None and surface == 'chat' and safe_id(data.get('run_id')):
                run_id = data['run_id']  # the chat surface only reveals its run in the frames: index it so Parar works
                await run_in_threadpool(index.add, run_id, bot, ids.get('session_id'), actor, 'started', sha)
            if event == 'approval.request':
                data = await _with_digest(index.path, bot, safe_id(data.get('run_id')) or run_id, surface, data)
            yield sse_proxy.encode(seq, event, data)
            wrote = event == 'tool.completed' and not data.get('error') and (data.get('tool') or data.get('tool_name')) in pages.WRITERS
            if run_id and (wrote or (event in _TERMINAL_STATUS and page_pending)):  # v0.5 7.1: "Bot atualizou X", from a rescan only
                found = await _page_updates(index.path, bot, run_id, index, final=not wrote)
                page_pending = found is None
                for page in found or ():
                    yield sse_proxy.ours(seq, 'luvebot.page.updated', **page)
            if event in _TERMINAL_STATUS:
                terminal = sse_proxy.TERMINAL[event]
                if run_id:
                    await run_in_threadpool(index.set_status, run_id, _TERMINAL_STATUS[event])
                    await run_in_threadpool(_expire_run, index.path, run_id)
                if surface == 'run':
                    yield close(terminal)
                    return
            if event == 'done':
                yield close(terminal or 'upstream_closed')
                return
    finally:
        upstream.abort()


def _sse(generator):
    return StreamingResponse(generator, media_type='text/event-stream', headers={'X-Accel-Buffering': 'no'})


@router.get('/bots/{bot}/runs/{run_id}/events')
async def run_events(bot: str, run_id: str, request: Request):
    actor, _credential, _mode = _identity(request)
    audit, meta = await run_in_threadpool(_stores)
    index = await run_in_threadpool(RunIndex, meta.path)
    name = await _owned_run(bot, run_id, index)
    await _require_feature(name, 'runs')
    status, upstream = await run_in_threadpool(ApiClient(name).open_stream, 'GET', f'/v1/runs/{run_id}/events')
    if upstream is None:
        raise upstream_error(status, on_404=_RUN_404)
    return _sse(_relay(upstream, 'run', name, index, actor, {'run_id': run_id}))


@router.post('/bots/{bot}/sessions/{session_id}/chat/stream')
async def chat_stream(bot: str, session_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = validate_profile(bot)
    if safe_id(session_id) is None:
        raise PluginError('session_not_found', 'Session not found.', 404)
    fields = validate_chat_body(await _json_body(request, MAX_RUN_BODY))
    await _require_feature(name, 'session_chat_stream')
    audit, meta = await run_in_threadpool(_stores)
    if fields['page']:  # v0.5 7.2 (chat surface, T9.3b): same server-built note
        fields['input'] = await run_in_threadpool(_page_note, request, actor, name, meta, fields['page']) + '\n\n' + fields['input']
    index = await run_in_threadpool(RunIndex, meta.path)
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)
    await run_in_threadpool(_refresh_hint, name, audit, actor)
    cid = fields['client_message_id']

    def effect():
        hook.hook_gate(meta.path, name)  # D-015 B-3 (also for a chat turn)
        budget_gate(budget, meta.path, name)  # a chat turn starts a run: invariant 7 applies
        if cid and not index.claim_message(cid, name, session_id):
            raise PluginError('duplicate', 'This message was already sent.', 409)
        try:
            status, upstream = ApiClient(name).open_stream('POST', f'/api/sessions/{session_id}/chat/stream', {'message': fields['input']})
            if upstream is None:
                raise upstream_error(status, on_404=('session_not_found', 'Session not found.', 404),
                                     on_409=('conflict', 'This session is busy with another turn.', 409))
            return upstream
        except BaseException:
            if cid:
                index.release_message(cid)
            raise

    upstream = await run_in_threadpool(audit.act, actor, 'chat.send', session_id, {'kind': 'ui'}, effect, bot=name, payload=fields)
    return _sse(_relay(upstream, 'chat', name, index, actor, {'session_id': session_id}, sha=await run_in_threadpool(index.prompt_digest, fields['input'])))


# ---------------------------------------------------------------------------
# Approvals (contract v0.1 sections 1, 2 and 6). The three resolvers below are the ONLY routes that answer Hermes (H1).
# ---------------------------------------------------------------------------
def _human(request):
    """The signed-in person behind this request, as the engine's typed Actor (RT 4: never taken from the request content).
    401 without a session, 403 csrf_required, and in loopback 403 loopback_not_human unless the installation opted in
    (D-012, A-15): the loopback token identifies the machine, not a person."""
    actor, credential, mode = _identity(request)
    _require_csrf(request, credential)
    if mode == 'loopback' and os.environ.get('LUVEBOT_ALLOW_LOOPBACK_APPROVALS') != '1':
        raise PluginError('loopback_not_human', 'Deciding an approval needs a dashboard with a login; this dashboard is in loopback mode.', 403)
    return rules.Actor(rules.ActorKind.HUMAN, actor)


def _audit_payload(fields):
    return {k: fields[k] for k in ('digest', 'choice', 'reason', 'draft') if k in fields}


async def _decide(audit, meta, human, request_id, fields, run=None):
    row = await run_in_threadpool(approvals.get, meta.path, request_id)
    if row is None or (run is not None and (row['bot'], row['run_id']) != run):
        raise PluginError('approval_not_found', 'Approval request not found.', 404)

    def effect():
        return approvals.resolve(meta.path, approvals_native.decide, human, request_id, digest=fields['digest'], choice=fields['choice'],
                                 reason=fields['reason'], draft=fields['draft'], run=run, redact=_REDACT)

    view, draft_rule, extras = await run_in_threadpool(audit.act, human.id, 'approval.resolve', request_id, {'kind': 'ui'}, effect,
                                                       bot=row['bot'], payload=_audit_payload(fields))
    if fields['choice'] == 'deny' and view.get('reason') and view['status'] == 'consumed' and row['source'] == 'run':
        extras['reason_delivered'] = await run_in_threadpool(_send_reason, audit, human.id, meta.path, row, view['reason'])
        view = await run_in_threadpool(lambda: approvals.view(approvals.get(meta.path, request_id)))
    return {'approval': view, **({'draft_rule': draft_rule} if draft_rule else {}), **extras}


def _send_reason(audit, actor, path, row, reason):
    """b3: after the deny reached Hermes, its reason goes to the run as a steer (Hermes's approval route drops it), audited before.
    -> None while accepted and the run goes on (settled when it ends), False when it could not be sent. Never undoes the deny."""
    text = approvals_native.deny_steer_text(reason)  # a FIXED frame and the person's own (redacted) words (Lume, b3 B2)

    def effect():
        try:
            after = approvals_native.steer_watermark(row['bot'], row['run_id'])  # BEFORE sending: its proof must come after this
        except Exception:
            after = None  # no watermark, no proof: it can only ever settle as unknown
        try:
            accepted = approvals_native.steer_reason(row['bot'], row['run_id'], text)
        except HermesError:
            accepted = False
        approvals.set_reason_steer(path, row['request_id'], 'accepted' if accepted else 'refused', after=after)
        return accepted
    try:
        accepted = audit.act(actor, 'approval.reason.steer', row['request_id'], {'kind': 'ui'}, effect, bot=row['bot'],
                             payload={'sha256': hashlib.sha256(text.encode()).hexdigest()})
    except AuditUnavailable:
        return False  # not sent: no audit row, no effect (invariant 5); the deny itself stands
    if accepted:
        approvals_native.settle_reasons(path, row['bot'], row['run_id'])  # the run may already have ended
    return approvals.view(approvals.get(path, row['request_id']))['reason_delivered']  # True / None (not ended yet) / False


@router.get('/approvals')
async def list_approvals(request: Request, status: str = None, bot: str = None, limit: int = 50, cursor: str = None):
    _identity(request)  # reads stay available in loopback
    if status is not None and status not in approvals.STATUSES:
        raise PluginError('bad_request', 'Unknown status.', 400)
    if bot is not None:
        bot = validate_profile(bot)
    if not 1 <= limit <= 100 or (cursor is not None and not re.fullmatch(r'[0-9.]{1,32}:[A-Za-z0-9_.:-]{1,128}', cursor)):
        raise PluginError('bad_request', 'Invalid paging parameters.', 400)
    audit, meta = await run_in_threadpool(_stores)
    items, nxt = await run_in_threadpool(lambda: approvals.list_approvals(meta.path, status=status, bot=bot, limit=limit, cursor=cursor))
    return {'approvals': items, 'next_cursor': nxt}


@router.post('/approvals/batch')
async def resolve_approvals_batch(request: Request):
    human = _human(request)
    items = approvals.validate_batch(await _json_body(request))
    audit, meta = await run_in_threadpool(_stores)

    def prevalidate():  # every item, before anything is sent: one stale item stops the whole batch (contract section 2)
        rows = [approvals.check_pending(meta.path, i['request_id'], i['digest']) for i in items]
        if len({r['action_class_hash'] for r in rows}) != 1:
            raise PluginError('invalid_field', 'A batch may only hold requests for the same kind of action in the same Bot.', 422)

    await run_in_threadpool(prevalidate)
    done, failed = [], []
    for item in items:
        fields = {**item, 'draft': None}
        try:
            done.append((await _decide(audit, meta, human, item['request_id'], fields))['approval'])
        except (PluginError, HermesError) as error:  # native dispatch is not transactional: report what happened per item
            failed.append({'request_id': item['request_id'], 'code': getattr(error, 'code', 'hermes_error')})
    return JSONResponse({'approvals': done, 'failed': failed}, status_code=200, headers=_HEADERS)


@router.post('/approvals/{request_id}/resolve')
async def resolve_approval(request_id: str, request: Request):
    human = _human(request)
    if safe_id(request_id) is None:
        raise PluginError('approval_not_found', 'Approval request not found.', 404)
    fields = approvals.validate_resolution(await _json_body(request))
    audit, meta = await run_in_threadpool(_stores)
    return JSONResponse(await _decide(audit, meta, human, request_id, fields), status_code=200, headers=_HEADERS)


@router.post('/bots/{bot}/runs/{run_id}/approval')
async def resolve_run_approval(bot: str, run_id: str, request: Request):
    """Supersedes the v0 501. Same checked resolver; a run of another Bot is not addressable (run_not_found)."""
    human = _human(request)
    audit, meta = await run_in_threadpool(_stores)
    index = await run_in_threadpool(RunIndex, meta.path)
    name = await _owned_run(bot, run_id, index)
    fields = approvals.validate_resolution(await _json_body(request), with_request_id=True)
    return JSONResponse(await _decide(audit, meta, human, fields['request_id'], fields, run=(name, run_id)), status_code=200, headers=_HEADERS)


# ---------------------------------------------------------------------------
# Rules (contract v0.1 section 3, ADR-002 sections 4, 7, 8). Seals are computed here from the LIVE state at every read.
# ---------------------------------------------------------------------------
_BROKEN_STATE = rules.SealResult(rules.Seal.BROKEN, (), (rules.Problem('no_mechanism', 'the live state of this Bot could not be read'),), ())


async def _bot_names():
    return [i['name'] for i in await run_in_threadpool(profile_infos)]


async def _read_state(path, name):
    """-> (LiveState, toolset_tools, mcp_server_tools) or None when Hermes cannot be read for this Bot."""
    try:
        status = await get_status(profile=name)
    except Exception:
        status = None
    try:
        return await run_in_threadpool(lambda: live_state.read(path, name, status=status))
    except Exception:
        return None


async def _states(path, names):
    return dict(zip(names, await asyncio.gather(*[_read_state(path, n) for n in names])))


def _seal_of(path, rule, trusted, states, targets):
    """The aggregated live seal of one rule over the Bots it applies to."""
    if rule.state is not rules.RuleState.ACTIVE:
        return rules.SealResult(rules.Seal.NONE, (), (), ())
    if not trusted:
        return rules_service.untrusted_seal()
    per_bot = {}
    for bot in targets:
        if not rules_service.applies_to(rule, bot):
            continue
        read = states.get(bot)
        per_bot[bot] = _BROKEN_STATE if read is None else rules_service.seal_for(path, rule, bot, read[0])
    return rules_service.aggregate(per_bot)


def _rule_item(path, rule, trusted, states, targets):
    return {'rule': rules_store.rule_to_dict(rule), 'seal_result': rules_service.seal_to_dict(_seal_of(path, rule, trusted, states, targets))}


@router.get('/rules')
async def list_rules(request: Request, bot: str = None, limit: int = 50, cursor: str = None):
    _identity(request)
    names = await _bot_names()
    if bot is not None and validate_profile(bot) not in names:
        raise HermesError('bot_not_found')
    if not 1 <= limit <= 100 or (cursor is not None and not re.fullmatch(r'[0-9]{1,6}', cursor)):
        raise PluginError('bad_request', 'Invalid paging parameters.', 400)
    audit, meta = await run_in_threadpool(_stores)
    stored = await run_in_threadpool(rules_service.stored_rules, meta.path)
    items = [(r, True) for r in rules.builtin_rules()] + stored
    targets = [bot] if bot else names
    items = [(r, t) for r, t in items if bot is None or rules_service.applies_to(r, bot)]
    offset = int(cursor or 0)
    page = items[offset:offset + limit]
    states = await _states(meta.path, targets) if any(r.state is rules.RuleState.ACTIVE for r, _ in page) else {}
    out = [_rule_item(meta.path, r, t, states, targets) for r, t in page]
    return {'rules': out, 'next_cursor': str(offset + limit) if offset + limit < len(items) else None}


def _human_actor(request):
    """The signed-in person, for rule steps that keep the v0 loopback convention (create, review, edit, archive)."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    return rules.Actor(rules.ActorKind.HUMAN, actor)


@router.post('/rules')
async def create_rule(request: Request):
    human = _human_actor(request)
    body = await _json_body(request)
    fields = rules_service.validate_create(body)
    names = await _bot_names()
    suggested = fields['suggested_by_bot']
    if suggested is not None and suggested not in names:
        raise HermesError('bot_not_found')
    audit, meta = await run_in_threadpool(_stores)
    rule_id = rules_service.new_rule_id()
    rule = await run_in_threadpool(audit.act, human.id, 'rule.create', rule_id, {'kind': 'ui'},
                                   lambda: rules_service.create(meta.path, human, fields, rule_id), bot=suggested, payload=body)
    return JSONResponse({'rule': rules_store.rule_to_dict(rule), 'seal_result': rules_service.seal_to_dict(rules.SealResult(rules.Seal.NONE, (), (), ()))},
                        status_code=201, headers=_HEADERS)


async def _apply_tables(path, bots):
    """Compile and store the hook table of each Bot (builtins + human-activated rules); the gateway's hook reads it on its next call."""
    def one(name):
        tools, mcp = live_state.expansion_maps(name)
        return rules_service.apply_table(path, name, tools, mcp)
    await asyncio.gather(*[run_in_threadpool(one, n) for n in bots])


@router.patch('/rules')
async def patch_rule(request: Request):
    _identity(request)  # 401 before anything else, whatever the body
    body = await _json_body(request)
    fields = rules_service.validate_patch(body)
    # activating authorizes future actions with the weight of an approval: loopback 403 (D-012), the same gate as approvals
    human = _human(request) if fields['state'] == 'active' else _human_actor(request)
    audit, meta = await run_in_threadpool(_stores)
    path, rule_id, version = meta.path, fields['id'], fields['version']
    names = await _bot_names()
    current = await run_in_threadpool(rules_service.get_rule, path, rule_id)
    if fields['state'] == 'archived' and current.state is rules.RuleState.ACTIVE:
        human = _human(request)  # archiving an ACTIVE rule loosens a control: loopback 403 as activating (D-012, red team F2)
    scope_bot = current.scope.ref if current.scope.kind is rules.ScopeKind.BOT and current.scope.ref in names else None

    if fields['edits']:
        rule = await run_in_threadpool(audit.act, human.id, 'rule.update', rule_id, {'kind': 'ui'},
                                       lambda: rules_service.edit(path, human, rule_id, version, fields['edits']), bot=scope_bot, payload=body)
        applied_to = []
    elif fields['state'] == 'draft':
        rule = await run_in_threadpool(audit.act, human.id, 'rule.review', rule_id, {'kind': 'ui'},
                                       lambda: rules_service.review(path, human, rule_id, version), bot=scope_bot, payload=body)
        applied_to = []
    elif fields['state'] == 'archived':
        rule, was_active = await run_in_threadpool(audit.act, human.id, 'rule.archive', rule_id, {'kind': 'ui'},
                                                   lambda: rules_service.archive(path, human, rule_id, version), bot=scope_bot, payload=body)
        applied_to = [n for n in names if rules_service.applies_to(rule, n)] if was_active else []
        await _apply_tables(path, applied_to)  # the rule no longer counts: recompile the Bots it applied to
    else:
        active, draft = await run_in_threadpool(rules_service.plan_activation, path, human, rule_id, version)
        targets = [n for n in names if rules_service.applies_to(active, n)]
        if not fields['accept_unapplied']:
            states = await asyncio.gather(*[run_in_threadpool(_hook_view, path, n) for n in targets])
            missing = [n for n, st in zip(targets, states) if st['status'] == 'absent']
            if missing:
                raise PluginError('not_applied', 'The LuveBot rules are not installed in: ' + ', '.join(missing) + '. Install them or confirm "activate without applying".', 409,
                                  {'bots': missing})

        def effect():
            rules_service.commit_activation(path, active)
            return active

        # the audit row carries the digest of the rule exactly as it becomes active: that row is what makes the activation trusted (E)
        rule = await run_in_threadpool(audit.act, human.id, 'rule.activate', rule_id, {'kind': 'ui'}, effect, bot=scope_bot,
                                       payload=rules_service.activation_payload(active))
        try:
            await _apply_tables(path, targets)
        except Exception:
            # not applied: say so honestly (the seal will be broken) rather than undo a human decision silently
            raise PluginError('hermes_error', 'The rule is active but its hook table could not be applied; check the Bot hooks.', 502) from None
        applied_to = targets
    states = await _states(path, applied_to) if applied_to and rule.state is rules.RuleState.ACTIVE else {}
    return JSONResponse(_rule_item(path, rule, True, states, applied_to), status_code=200, headers=_HEADERS)


@router.post('/rules/simulate')
async def simulate_rules(request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    action = rules_service.parse_action(await _json_body(request))
    names = await _bot_names()
    if action.bot not in names:
        raise HermesError('bot_not_found')
    audit, meta = await run_in_threadpool(_stores)
    read = await _read_state(meta.path, action.bot)
    if read is None:
        raise HermesError('hermes_unreachable')
    state, toolset_tools, mcp_tools = read
    # the Action carries the toolset / server of its tool when the caller did not say (D): rules by toolset or server need it
    toolset = action.toolset or next((t for t, tools in sorted(toolset_tools.items()) if action.tool in tools), None)
    server = action.mcp_server or next((s for s in sorted(mcp_tools) if action.tool.startswith(f'mcp__{rules._hermes_sanitize(s)}__')), None)
    action = rules.replace(action, toolset=toolset, mcp_server=server)

    def work():
        effective = rules_service.effective_rules(meta.path, action.bot)
        table = rules_service.loaded_table(meta.path, action.bot, state)
        stored = hook_store_read(meta.path, action.bot)
        sim = rules.simulate(effective, state, action, expected_hook_digest=stored[0] if stored else None, now=time.time(), hook_table=table)
        verdict = rules.hook_verdict(table, tool=action.tool, command=action.command) if table is not None else None
        return sim, verdict

    sim, verdict = await run_in_threadpool(work)
    expected = {rules.Level.ASK: 'approve', rules.Level.HANDBACK: 'block', rules.Level.BLOCK: 'block'}.get(sim.decision.effect, 'none')
    hook_info = None if verdict is None else {'action': verdict.action, 'rule_id': verdict.rule_id, 'message': verdict.message, 'strict': verdict.strict}
    return {'decision': rules_service.decision_to_dict(sim.decision), 'seals': {rid: rules_service.seal_to_dict(r) for rid, r in sim.seals},
            'effective_mechanisms': [m.value for m in sim.effective_mechanisms], 'hook': hook_info,
            'hook_agrees': None if verdict is None else verdict.action == expected,
            'action': {'bot': action.bot, 'tool': action.tool, 'toolset': action.toolset, 'mcp_server': action.mcp_server}}


def hook_store_read(path, bot):
    from luvebot_backend import hook_store
    return hook_store.read_table(path, bot)


# ---------------------------------------------------------------------------
# Phase 4 (contract v0.2): costs and caps, the budget executor and the cost watcher, routines, activity.
# ---------------------------------------------------------------------------
_WATCH_EVERY = float(os.environ.get('LUVEBOT_WATCH_EVERY', '30'))
_PLAN_STATUS = {}
_cron = hermes_cron.HermesCron()


class _BotRuns:
    """The executor's view of a Bot's runs: which are open, and a stop that counts only when Hermes says the run ended (S08)."""

    def __init__(self, path):
        self.index = RunIndex(path)

    def open(self, bot):
        return [r['run_id'] for r in self.index.open_runs(bot)]

    def stop(self, bot, run_id):
        status, payload = ApiClient(bot).call('POST', f'/v1/runs/{run_id}/stop', {})
        if status != 200 or not payload:
            return False
        for _ in range(6):  # the request being accepted is not the run having ended: ask Hermes again
            state, body = ApiClient(bot).call('GET', '/v1/runs/' + run_id)
            raw = body.get('status') if state == 200 and body else None
            if isinstance(raw, str):
                self.index.set_status(run_id, raw[:64])
            if raw in ('cancelled', 'completed', 'failed'):
                return True
            time.sleep(0.5)
        return False


def _budget_parts(audit, meta):
    budget = Budget(meta.path, audit=audit)
    return budget, Executor(meta.path, budget, audit, _cron, _BotRuns(meta.path))


def _job_owners(names):
    owners = {}
    for name in names:
        try:
            for job in _cron.list_jobs(name):
                owners[job.get('id')] = name
        except Exception:
            continue
    return owners


def _evaluate_budget(budget, executor, names):
    """S03: look at EVERY Bot and every routine cap now, whether or not new spend arrived, and apply what is found. Called by the
    periodic pass and right after a cap changes."""
    decisions = [budget.evaluate(name) for name in names]
    caps = [item for item in budget.snapshot()['limits'] if item['scope'] == 'routine']
    if caps:
        owners = _job_owners(names)
        decisions += [budget.evaluate(owners[item['ref']], routine=item['ref']) for item in caps if item['ref'] in owners]
    for decision in decisions:
        if decision.get('plan') or decision.get('plans') or decision.get('alerts'):
            _run_executor(executor, executor.handle(decision))


def _run_executor(executor, outcome):
    for bot, result in outcome.items():
        _PLAN_STATUS[bot] = 'applied' if not result['failed'] else 'pending'


def _background_tick():
    """One pass of the watcher. A paused Bot is re-applied by `_evaluate_budget` (its plan comes back while it stays paused). Never raises."""
    try:
        from hermes_cli.web_server_profiles import get_process_hermes_home
        if (get_process_hermes_home() / 'luvebot/watcher.hold').exists():  # maintenance (and a test seam): no pass, so no heartbeat, and the
            return                                                         # database is not even opened; the Budget fails closed
        audit, meta = _stores()
        budget, executor = _budget_parts(audit, meta)
        names = [i['name'] for i in profile_infos()]
        start = costs.period_start('month', budget._now()) - 86400
        result = cost_watcher.run_pass(budget, names, lambda bot: hermes_cron.sessions_for_cost(bot, start))
        for decision in result['decisions']:
            _run_executor(executor, executor.handle(decision))
        _evaluate_budget(budget, executor, names)
        handoffs.ingest(meta.path, audit, names, hermes_cron.kanban_handoff_tasks)  # S09: not on a GET
        handoffs.sync(meta.path, audit, hermes_cron.kanban_task)
        try:  # D-007: a lease Hermes gave back on its own is audited too; on its own, so no other step of the pass can skip it
            if bot_screen.Screen(meta.path).viewers():
                bot_screen.Screen(meta.path).reconcile(audit)
        except Exception as error:
            logging.getLogger('luvebot.screen').warning('screen reconcile failed: %s', type(error).__name__)  # the class only
    except Exception as error:  # a failed pass sends no heartbeat, so the Budget fails closed on its own after watcher_max_age
        logging.getLogger('luvebot.budget').warning('budget tick failed: %s', type(error).__name__)  # the class only: never the text


def _background_loop():
    while True:
        _background_tick()
        time.sleep(_WATCH_EVERY)


def _start_background():
    """Started when the dashboard mounts this plugin. A process that merely imports the file (tests) sets LUVEBOT_BACKGROUND=0."""
    if os.environ.get('LUVEBOT_BACKGROUND') == '0':
        return
    if any(t.name == 'luvebot-budget' for t in threading.enumerate()):
        return
    threading.Thread(target=_background_loop, name='luvebot-budget', daemon=True).start()
    logging.getLogger('luvebot.budget').warning('budget watcher started')


_start_background()


def _budget_actor(request, *, raises):
    """The signed-in person for a budget change. Raising or removing a cap, and resuming a Bot, let the agent spend more, so in
    loopback (the token names the machine) they are refused unless the installation opted in (A-29, extends D-012)."""
    actor, credential, mode = _identity(request)
    _require_csrf(request, credential)
    if raises and mode == 'loopback' and os.environ.get('LUVEBOT_ALLOW_LOOPBACK_APPROVALS') != '1':
        raise PluginError('loopback_not_human', 'Raising a cap or resuming a Bot needs a dashboard with a login; this one is in loopback mode.', 403)
    return actor


async def _names():
    return [i['name'] for i in await run_in_threadpool(profile_infos)]


async def _need_cron():
    ok, _missing = hermes_cron.available()
    if not ok:
        raise PluginError('capability_missing', 'This Hermes does not provide the cron helpers this feature needs; update Hermes.', 409)


def _cap_of(limits, routine_id):
    for item in limits:
        if item['scope'] == 'routine' and item['ref'] == routine_id:
            return {'period': item['period'], 'cents': item['cents']}
    return None


@router.get('/costs')
async def get_costs(request: Request, period: str = 'month', group: str = 'bot', bot: str = None):
    _identity(request)
    costs.validate(period, group)
    names = [validate_profile(bot)] if bot else await _names()
    audit, meta = await run_in_threadpool(_stores)
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)
    start = costs.period_start(period, budget._now())
    snapshot = await run_in_threadpool(budget.snapshot)
    rows = {}
    for name in names:
        try:
            rows[name] = await run_in_threadpool(hermes_cron.sessions_for_cost, name, start)
        except Exception:
            raise HermesError('hermes_unreachable') from None
    totals, groups = costs.aggregate(rows, start=start, group=group, tz=budget.tz)
    age = snapshot['watcher']['age_s']
    return JSONResponse({'period': period, 'currency': 'USD', 'totals': totals, 'groups': groups,
                         'ledger': {'lag_s': age if age is not None else None, 'watcher_stale': snapshot['watcher']['stale']}},
                        headers=_HEADERS)


def _snapshot_view(snapshot, executor):
    watcher = snapshot['watcher']
    last = datetime.fromisoformat(watcher['last_at']).timestamp() if watcher['last_at'] else None
    return {'limits': [{**item, 'percent': item['percent'] if item['percent'] is not None else 100.0} for item in snapshot['limits']],
            'paused': [{'bot': bot, 'since': executor.since(bot), 'plan_status': _PLAN_STATUS.get(bot, 'pending')} for bot in snapshot['paused']],
            'watcher': {'last_at': last, 'stale': watcher['stale']},
            'alerts': [{'scope': a['scope'], 'ref': a['ref'] or None, 'percent': a['threshold'],
                        'message': f"{a['scope']} {a['period']} cap reached {a['threshold']}%"} for a in snapshot['alerts']]}


@router.get('/budget')
async def get_budget(request: Request):
    _identity(request)
    audit, meta = await run_in_threadpool(_stores)
    budget, executor = await run_in_threadpool(_budget_parts, audit, meta)
    snapshot = await run_in_threadpool(budget.snapshot)
    return JSONResponse(_snapshot_view(snapshot, executor), headers=_HEADERS)


@router.put('/budget/limits')
async def put_budget_limit(request: Request):
    _identity(request)
    body = await _json_body(request)
    if not isinstance(body, dict) or set(body) - {'scope', 'ref', 'period', 'cents'} or not {'scope', 'period', 'cents'} <= set(body):
        raise PluginError('bad_request', 'Invalid request body.', 400)
    scope, ref, period, cents = body['scope'], body.get('ref'), body['period'], body['cents']
    if scope not in ('global', 'bot', 'routine') or period not in ('day', 'month') or (scope == 'global') != (ref is None):
        raise PluginError('invalid_field', 'Invalid scope, ref or period.', 422)
    if scope != 'global' and (not isinstance(ref, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', ref)):
        raise PluginError('invalid_field', 'Invalid ref.', 422)
    if cents is not None and (type(cents) is not int or not 0 <= cents <= MAX_CENTS):
        raise PluginError('invalid_field', 'cents must be a whole number of cents, or null to remove the cap.', 422)
    audit, meta = await run_in_threadpool(_stores)
    budget, executor = await run_in_threadpool(_budget_parts, audit, meta)
    before = next((i['cents'] for i in (await run_in_threadpool(budget.snapshot))['limits']
                   if (i['scope'], i['ref'], i['period']) == (scope, ref, period)), None)
    raises = cents is None or (before is not None and cents > before)  # a NEW cap restricts what had none: not a raise
    actor = _budget_actor(request, raises=raises)
    if cents is None:
        await run_in_threadpool(lambda: budget.delete_limit(scope, ref, period, actor=actor, origin='ui', human=True))
    else:
        await run_in_threadpool(lambda: budget.set_limit(scope, ref, period, cents, actor=actor, origin='ui', human=True))
    await run_in_threadpool(_evaluate_budget, budget, executor, await _names())  # a cap below what was already spent pauses now
    snapshot = await run_in_threadpool(budget.snapshot)
    view = _snapshot_view(snapshot, executor)
    limit = next((i for i in view['limits'] if (i['scope'], i['ref'], i['period']) == (scope, ref, period)), None)
    return JSONResponse({'ok': True, 'limit': limit}, headers=_HEADERS)


@router.post('/bots/{bot}/budget/resume')
async def resume_bot_budget(bot: str, request: Request):
    actor = _budget_actor(request, raises=True)
    name = validate_profile(bot)
    if name not in await _names():
        raise HermesError('bot_not_found')
    audit, meta = await run_in_threadpool(_stores)
    budget, executor = await run_in_threadpool(_budget_parts, audit, meta)
    capped = await run_in_threadpool(lambda: budget.routines_over_cap() & {j.get('id') for j in _cron.list_jobs(name)})
    if capped:  # S01: the pause stays while the cause stays, also when the cause is a routine cap
        raise PluginError('budget_exceeded', 'A routine of this Bot has reached its own cap; the Bot stays paused.', 409, {'details': {'routines': sorted(capped)}})
    decision = await run_in_threadpool(lambda: budget.resume(name, actor=actor, origin='ui', human=True))
    if decision['breaches'] or decision['watcher_stale'] or decision['reason'] == 'bot_paused':
        code = 'watcher_stale' if decision['watcher_stale'] and not decision['breaches'] else 'budget_exceeded'
        raise PluginError(code, 'The Bot stays paused: its cap is still reached or the cost watcher has not reported.', 409)
    outcome = await run_in_threadpool(executor.resume, name)
    _PLAN_STATUS.pop(name, None)
    return JSONResponse({'ok': True, 'bot': name, 'resumed': True, 'jobs_resumed': outcome['resumed'], 'jobs_kept': outcome['kept']}, headers=_HEADERS)


# ---- routines -----------------------------------------------------------------------------------------------------
async def _jobs_of(bot):
    return await run_in_threadpool(_cron.list_jobs, bot)


async def _locate(job_id):
    """-> (bot, job) of the profile that holds this job; 404 routine_not_found."""
    if not routines.valid_id(job_id):
        raise PluginError('routine_not_found', 'Routine not found.', 404)
    for name in await _names():
        try:
            for job in await _jobs_of(name):
                if job.get('id') == job_id:
                    return name, job
        except Exception:
            continue
    raise PluginError('routine_not_found', 'Routine not found.', 404)


async def _routine_view(bot, job, snapshot=None, spend=None):
    audit, meta = await run_in_threadpool(_stores)
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)
    snapshot = snapshot or await run_in_threadpool(budget.snapshot)
    cap = _cap_of(snapshot['limits'], job.get('id'))
    spend = spend if spend is not None else await run_in_threadpool(budget.routine_spend, (cap or {}).get('period', 'month'))
    return routines.view(bot, job, cap=cap, spend_cents=spend.get(job.get('id'), 0), redact=_REDACT)


@router.get('/routines')
async def list_routines(request: Request, bot: str = None, state: str = None, limit: int = 50, cursor: str = None):
    _identity(request)
    if not 1 <= limit <= 100 or (state is not None and state not in ('scheduled', 'paused', 'completed')):
        raise PluginError('bad_request', 'Invalid paging parameters.', 400)
    await _need_cron()
    names = [validate_profile(bot)] if bot else await _names()
    audit, meta = await run_in_threadpool(_stores)
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)
    snapshot = await run_in_threadpool(budget.snapshot)
    spend = await run_in_threadpool(budget.routine_spend, 'month')
    items, partial = [], []
    for name in names:
        try:
            for job in await _jobs_of(name):
                items.append(routines.view(name, job, cap=_cap_of(snapshot['limits'], job.get('id')), spend_cents=spend.get(job.get('id'), 0), redact=_REDACT))
        except Exception:
            partial.append(name)
    if state:
        items = [i for i in items if i['state'] == state]
    items.sort(key=lambda i: (i['bot'], i['name'] or '', i['id']))
    chunk, nxt = routines.page(items, limit, cursor)
    return JSONResponse(_redact_deep({'routines': chunk, 'next_cursor': nxt, **({'partial': partial} if partial else {})}), headers=_HEADERS)


@router.get('/routines/{job_id}')
async def get_routine(job_id: str, request: Request):
    _identity(request)
    await _need_cron()
    bot, job = await _locate(job_id)
    return JSONResponse(_redact_deep({'routine': await _routine_view(bot, job), 'detail': routines.detail(job, _REDACT)}), headers=_HEADERS)


@router.get('/routines/{job_id}/runs')
async def get_routine_runs(job_id: str, request: Request, limit: int = 50, cursor: str = None):
    _identity(request)
    if not 1 <= limit <= 200:
        raise PluginError('bad_request', 'Invalid paging parameters.', 400)
    await _need_cron()
    bot, job = await _locate(job_id)
    if cursor is not None and not re.fullmatch(r'[0-9]{1,9}', cursor):
        raise PluginError('bad_request', 'Invalid paging parameters.', 400)
    offset = int(cursor or 0)
    rows = await run_in_threadpool(hermes_cron.job_runs, bot, job_id, limit + 1, offset)  # SessionDB takes an offset; the route does not
    now = time.time()
    return JSONResponse(_redact_deep({'runs': [routines.run_view(r, now) for r in rows[:limit]],
                                      'next_cursor': str(offset + limit) if len(rows) > limit else None,
                                      'truncated': bool(job.get('no_agent'))}),  # script-only jobs keep their history as output documents, not sessions
                        headers=_HEADERS)


async def _routine_act(request, job_id, action, effect_for, *, status=200, payload=None):
    """Audited mutation of one routine: locate it, run `effect_for(bot, job)` inside audit.act, answer the fresh routine."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    await _need_cron()
    bot, job = await _locate(job_id)
    audit, meta = await run_in_threadpool(_stores)
    await run_in_threadpool(audit.act, actor, action, job_id, {'kind': 'ui'}, lambda: effect_for(bot, job), bot=bot, payload=payload)
    fresh = await run_in_threadpool(_cron.get, bot, job_id)
    return JSONResponse(_redact_deep({'routine': await _routine_view(bot, fresh or job)}), status_code=status, headers=_HEADERS)


@router.post('/routines/{job_id}/pause')
async def pause_routine(job_id: str, request: Request):
    return await _routine_act(request, job_id, 'routine.pause', lambda bot, job: _cron.pause(bot, job['id'], 'luvebot:user'))


def _budget_refusal(decision):
    reason = decision['reason']
    if reason == 'bot_paused':
        return PluginError('bot_paused', 'This Bot is paused by its budget; only a person can resume it.', 409)
    if reason == 'budget_exceeded':
        return PluginError('budget_exceeded', 'The spending cap was reached.', 409)
    return PluginError('watcher_stale', 'The cost watcher has not reported; new work is refused until it does.', 409)


def _start_gate(budget, path, bot, routine=None):
    """S02: the gate in front of EVERY path that starts or restarts work. A paused or capped Bot is refused; so is a budget that
    cannot be verified (stale watcher), unless no cap exists at all (nothing to enforce, as in runs.budget_gate)."""
    bot_controls.work_gate(path, bot)  # v0.4 B3: paused by a person, or everything paused
    decision = budget.check_new_run(bot, routine=routine)
    if decision['allowed']:
        return
    if decision['reason'] == 'watcher_stale' and not has_limits(path):
        return
    raise _budget_refusal(decision)


@router.post('/routines/{job_id}/resume')
async def resume_routine(job_id: str, request: Request):
    _identity(request)
    audit, meta = await run_in_threadpool(_stores)
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)

    def effect(bot, job):
        if is_paused(meta.path, bot):  # invariant 7: resuming a job must not undo the pause
            raise PluginError('bot_paused', 'This Bot is paused by its budget; only a person can resume it.', 409)
        _start_gate(budget, meta.path, bot, job['id'])  # also refuses when the budget cannot be verified (S02)
        return _cron.resume(bot, job['id'])
    return await _routine_act(request, job_id, 'routine.resume', effect)


@router.post('/routines/{job_id}/test')
async def test_routine(job_id: str, request: Request):
    _identity(request)
    body = await _json_body(request)
    if not isinstance(body, dict) or body.get('confirm') is not True:
        raise PluginError('invalid_field', 'Running a test executes real work; send {"confirm": true}.', 422)
    audit, meta = await run_in_threadpool(_stores)
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)

    def effect(bot, job):
        if job.get('state') == 'paused' or job.get('enabled') is False:  # Hermes trigger would resume it: a silent way around invariant 7
            raise PluginError('routine_paused', 'This routine is paused; resume it first.', 409)
        bot_controls.work_gate(meta.path, bot)  # v0.4 B3
        decision = budget.check_new_run(bot, routine=job['id'])
        if not decision['allowed']:
            raise _budget_refusal(decision)
        threading.Thread(target=lambda: _quiet(hermes_cron.fire, bot, job['id']), name='luvebot-routine-test', daemon=True).start()
        return True
    return await _routine_act(request, job_id, 'routine.test', effect, status=202)


def _quiet(fn, *args):
    try:
        fn(*args)
    except Exception:
        pass


@router.delete('/routines/{job_id}')
async def delete_routine(job_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    body = await _json_body(request)
    await _need_cron()
    bot, job = await _locate(job_id)
    if not isinstance(body, dict) or set(body) != {'confirm_name'} or body['confirm_name'] != job.get('name'):
        raise PluginError('invalid_field', 'Type the routine name to delete it.', 422)
    audit, meta = await run_in_threadpool(_stores)
    await run_in_threadpool(audit.act, actor, 'routine.delete', job_id, {'kind': 'ui'}, lambda: _cron.remove(bot, job['id']), bot=bot)
    return JSONResponse({'ok': True}, headers=_HEADERS)


@router.patch('/routines/{job_id}')
async def patch_routine(job_id: str, request: Request):
    _identity(request)
    updates = routines.validate_patch(await _json_body(request))  # an allowlist, key by key: never a client dict into update_job
    return await _routine_act(request, job_id, 'routine.update', lambda bot, job: _cron.update(bot, job['id'], updates),
                              payload={'keys': sorted(updates)})


@router.post('/routines')
async def create_routine(request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    bot, fields, start = routines.validate_create(await _json_body(request))
    name = validate_profile(bot)
    if name not in await _names():
        raise HermesError('bot_not_found')
    await _need_cron()
    audit, meta = await run_in_threadpool(_stores)

    fields.setdefault('prompt', '')

    def effect():
        if start:
            _start_gate(Budget(meta.path, audit=audit), meta.path, name)  # S02: an active routine is work that will start
        return _cron.create(name, **fields, paused=not start, **({} if start else {'paused_reason': 'Created paused; awaiting operator approval.'}))
    job = await run_in_threadpool(audit.act, actor, 'routine.create', None, {'kind': 'ui'}, effect, bot=name, payload={'keys': sorted(fields), 'start': start})
    return JSONResponse(_redact_deep({'routine': await _routine_view(name, job)}), status_code=201, headers=_HEADERS)


@router.post('/routines/{job_id}/duplicate')
async def duplicate_routine(job_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    await _need_cron()
    bot, job = await _locate(job_id)
    audit, meta = await run_in_threadpool(_stores)
    fields = routines.duplicate_fields(job)
    made = await run_in_threadpool(audit.act, actor, 'routine.duplicate', job_id, {'kind': 'ui'},
                                   lambda: _cron.create(bot, **fields, paused=True, paused_reason='Created paused; awaiting operator approval.'), bot=bot)
    return JSONResponse(_redact_deep({'routine': await _routine_view(bot, made)}), status_code=201, headers=_HEADERS)


# ---- activity -----------------------------------------------------------------------------------------------------
def _iso_epoch(value):
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None


@router.get('/activity')
async def get_activity(request: Request, tab: str, bot: str = None, origin: str = None, status: str = None, since: float = None,
                       until: float = None, min_cost_cents: int = None, limit: int = 50, cursor: str = None):
    _identity(request)
    if not 1 <= limit <= 100:
        raise PluginError('bad_request', 'Invalid paging parameters.', 400)
    names = [validate_profile(bot)] if bot else await _names()
    audit, meta = await run_in_threadpool(_stores)
    items, partial, now = [], set(), time.time()
    for name in names:
        try:
            rows = await run_in_threadpool(RunIndex(meta.path)._exec, 'SELECT run_id, bot, session_id, started_at, last_status, prompt_sha FROM run_index '
                                           'WHERE bot=? ORDER BY started_at DESC LIMIT 200', (name,), fetch=True)
            try:  # v0.2 section 2: titled by what the person typed, read from Hermes's own session store, never stored by us
                prompts = await run_in_threadpool(hermes_cron.user_prompts, name, sorted({r['session_id'] for r in rows if r['session_id']}),
                                                  RunIndex(meta.path).prompt_digest)
            except Exception:
                prompts = {}
                partial.add('run_titles')
            items += [activity.run_item(dict(r), _iso_epoch, prompts) for r in rows]
        except Exception:
            partial.add('runs')
        try:
            for session in await run_in_threadpool(hermes_cron.cron_sessions, name, now - 7 * 86400):
                items.append(activity.routine_run_item(name, session, now))
            for job in await _jobs_of(name):
                if job.get('enabled') and job.get('state') == 'scheduled' and job.get('next_run_at'):
                    items.append(activity.due_item(name, job))
        except Exception:
            partial.add('routines')
        try:
            items += [activity.task_item(t) for t in await run_in_threadpool(hermes_cron.kanban_tasks, name)]
        except Exception:
            partial.add('tasks')
    page, nxt = activity.build(items, tab=tab, bot=None if bot is None else validate_profile(bot), origin=origin, status=status,
                               since=since, until=until, min_cost_cents=min_cost_cents, limit=limit, cursor=cursor)
    return JSONResponse(_redact_deep({'items': page, 'next_cursor': nxt, **({'partial': sorted(partial)} if partial else {})}), headers=_HEADERS)


# ---- activity item actions (contract v0.2 section 2): audited, CSRF, and a stop is confirmed by what Hermes says afterwards ----
async def _activity_target(item_id, meta):
    """-> (kind, native, bot). A run item belongs to the Bot in our index; a task to its assignee."""
    kind, native = activity.parse_id(item_id)
    if kind == 'run':
        rows = await run_in_threadpool(RunIndex(meta.path)._exec, 'SELECT bot FROM run_index WHERE run_id=?', (native,), fetch=True)
        if not rows:
            raise PluginError('activity_not_found', 'Activity item not found.', 404)
        return kind, native, rows[0]['bot']
    if kind == 'task':
        task = await run_in_threadpool(_quiet_value, hermes_cron.kanban_task, native)
        if task is None:
            raise PluginError('activity_not_found', 'Activity item not found.', 404)
        return kind, native, task['assignee']
    return kind, native, None


def _quiet_value(fn, *args):
    try:
        return fn(*args)
    except Exception:
        raise HermesError('hermes_unreachable') from None


def _not_supported():
    return PluginError('not_supported', 'This action does not exist for this kind of item.', 409)


@router.post('/activity/{item_id}/context')
async def activity_context(item_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    text, kind = activity.validate_context(await _json_body(request))
    audit, meta = await run_in_threadpool(_stores)
    item_kind, native, bot = await _activity_target(item_id, meta)
    if item_kind == 'run':
        raise PluginError('capability_missing', 'Sending context to a running conversation needs the steer body of Hermes, which is not recorded yet.', 409)
    if item_kind != 'task':
        raise _not_supported()
    body = text if kind == 'context' else '[correction] ' + text  # data for the Bot, never an instruction to LuveBot
    await run_in_threadpool(audit.act, actor, 'activity.context', item_id, {'kind': 'ui'},
                            lambda: _quiet_value(hermes_cron.kanban_comment, native, 'luvebot:' + actor, body), bot=bot,
                            payload=activity.audit_payload(item_id, kind, text=text))
    return JSONResponse({'ok': True}, headers=_HEADERS)


@router.post('/activity/{item_id}/redirect')
async def activity_redirect(item_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    target, reclaim, reason = activity.validate_redirect(await _json_body(request))
    audit, meta = await run_in_threadpool(_stores)
    item_kind, native, bot = await _activity_target(item_id, meta)
    if item_kind != 'task':
        raise _not_supported()
    target = validate_profile(target)
    known_bots = set(await _names())  # only a Bot has restrictions to carry (a person or the dashboard has none)
    if target not in known_bots:
        raise HermesError('bot_not_found')
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)

    def effect():
        bot_controls.work_gate(meta.path, target)  # v0.4 B3
        decision = budget.check_new_run(target)  # invariant 7: work is not handed to a paused or capped Bot
        if not decision['allowed']:
            raise _budget_refusal(decision)
        # T10.4: a redirect is a dispatch, like a handoff. The task keeps its creator, and the creator's restrictions follow the
        # work only through the destination's hook (H-R3), so it is not sent where that hook is not live; and a task made by a
        # Bot is not sent on when that Bot has no compiled rules the worker could read (D-015 B-3, same class as S04).
        task = _quiet_value(hermes_cron.kanban_task, native)
        if task is None:
            raise PluginError('activity_not_found', 'Activity item not found.', 404)
        origin = task.get('created_by')
        if origin in known_bots:
            _verify_handoff_enforcement(meta.path, origin, target)
        else:
            hook.hook_gate(meta.path, target)
        if not _quiet_value(hermes_cron.kanban_reassign, native, target, reclaim, reason):
            raise PluginError('conflict', 'This task cannot be reassigned now; it may still be running (ask to reclaim it first).', 409)
        return True
    await run_in_threadpool(audit.act, actor, 'activity.redirect', item_id, {'kind': 'ui'}, effect, bot=target,
                            payload=activity.audit_payload(item_id, 'redirect', to=target, reclaim_first=reclaim))
    return JSONResponse({'ok': True}, headers=_HEADERS)


@router.post('/activity/{item_id}/stop')
async def activity_stop(item_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    reason = activity.validate_stop(await _json_body(request))
    audit, meta = await run_in_threadpool(_stores)
    item_kind, native, bot = await _activity_target(item_id, meta)
    if item_kind == 'run':
        raw = await run_in_threadpool(audit.act, actor, 'activity.stop', item_id, {'kind': 'ui'}, lambda: _stop_native(bot, native), bot=bot,
                                      payload=activity.audit_payload(item_id, 'run'))
        index = RunIndex(meta.path)
        status = await _confirm(lambda: _run_status(bot, native), lambda s: s in ('cancelled', 'completed', 'failed'))
        await run_in_threadpool(index.set_status, native, (status or raw or 'stopping')[:64])
        return JSONResponse({'ok': True, 'confirmed': status in ('cancelled', 'completed', 'failed'), 'status': contract_status(status or raw)[0]},
                            status_code=202, headers=_HEADERS)
    if item_kind != 'task':
        raise _not_supported()  # cron has no stop: use pause

    def effect():
        task = _quiet_value(hermes_cron.kanban_task, native)
        if task is None or task['status'] != 'running':
            raise PluginError('conflict', 'This task is not running.', 409)
        if not _quiet_value(hermes_cron.kanban_reclaim, native, reason or 'luvebot:stop'):
            raise PluginError('conflict', 'Hermes could not release this task.', 409)
        return True
    await run_in_threadpool(audit.act, actor, 'activity.stop', item_id, {'kind': 'ui'}, effect, bot=bot,
                            payload=activity.audit_payload(item_id, 'task'))
    after = await _confirm(lambda: (_quiet_value(hermes_cron.kanban_task, native) or {}).get('status'), lambda s: s != 'running')
    return JSONResponse({'ok': True, 'confirmed': after is not None and after != 'running', 'status': after}, status_code=202, headers=_HEADERS)


def _run_status(bot, run_id):
    status, payload = ApiClient(bot).call('GET', '/v1/runs/' + run_id)
    return payload.get('status') if status == 200 and payload and isinstance(payload.get('status'), str) else None


async def _confirm(read, done, *, attempts=10, pause=0.5):
    """Ask Hermes again until it reports the end state (a stop is not 'done' because we sent it). -> the last status read."""
    last = None
    for _ in range(attempts):
        last = await run_in_threadpool(read)
        if last is not None and done(last):
            return last
        await asyncio.sleep(pause)
    return last


# ---------------------------------------------------------------------------
# Phase 5 (contract v0.3): rooms over the native Group Chat, handoffs, map, search.
# ---------------------------------------------------------------------------
class RoomRefused(PluginError, ActionDenied):
    """A send refused by one of our checks: audited as denied (`room.send.refused`), answered with the contract error."""


def _redact_deep(value):
    if isinstance(value, str):
        return _REDACT(value)
    if isinstance(value, list):
        return [_redact_deep(v) for v in value]
    if isinstance(value, dict):
        return {k: _redact_deep(v) for k, v in value.items()}
    return value


async def _room_call(method, params):
    return await run_in_threadpool(rooms_rpc.call, method, params)


async def _need_rooms():
    result = await _room_call('groups.capabilities', {})
    if not result.get('driver'):
        raise PluginError('capability_missing', 'Group Chat is not running in this Hermes.', 409)


async def _room_state(room_id):
    if not rooms.valid_id(room_id):
        raise PluginError('room_not_found', 'Room not found.', 404)
    return await _room_call('groups.state', {'room_id': room_id})


def _room_view(room, meta_row, driver=None, open_tasks=0):
    return {'id': room.get('room_id'), 'name': room.get('name'), 'members': rooms.members_view(room), 'created_at': room.get('created_at'),
            'disbanded_at': room.get('disbanded_at'), 'next_seq': room.get('next_seq'), **meta_row,
            'driver': rooms.driver_view(driver),
            'open_tasks': open_tasks}


def _open_handoffs(path, room_id):
    return len([r for r in handoffs.listing(path, room=room_id, limit=100) if r['state'] in ('open', 'running', 'needs_review')])


@router.get('/rooms')
async def list_rooms(request: Request, include_disbanded: bool = False, limit: int = 50, cursor: str = None):
    _identity(request)
    if not 1 <= limit <= 100 or (cursor is not None and not re.fullmatch(r'[0-9]{1,9}', cursor)):
        raise PluginError('bad_request', 'Invalid paging parameters.', 400)
    await _need_rooms()
    result = await _room_call('groups.list', {'include_disbanded': include_disbanded, 'limit': limit, 'offset': int(cursor or 0)})
    audit, meta = await run_in_threadpool(_stores)
    items = [_room_view(r, await run_in_threadpool(rooms.get_meta, meta.path, r.get('room_id')), None,
                        await run_in_threadpool(_open_handoffs, meta.path, r.get('room_id'))) for r in result.get('rooms') or []]
    nxt = result.get('next_offset')
    return JSONResponse(_redact_deep({'rooms': items, 'next_cursor': None if nxt is None else str(nxt)}), headers=_HEADERS)


@router.get('/rooms/{room_id}')
async def get_room(room_id: str, request: Request):
    _identity(request)
    await _need_rooms()
    state = await _room_state(room_id)
    audit, meta = await run_in_threadpool(_stores)
    view = _room_view(state['room'], await run_in_threadpool(rooms.get_meta, meta.path, room_id), state.get('driver_status'),
                      await run_in_threadpool(_open_handoffs, meta.path, room_id))
    return JSONResponse(_redact_deep({'room': view}), headers=_HEADERS)


@router.get('/rooms/{room_id}/log')
async def get_room_log(room_id: str, request: Request, since_seq: int = 0, limit: int = 100):
    _identity(request)
    if since_seq < 0 or not 1 <= limit <= 200:
        raise PluginError('bad_request', 'Invalid paging parameters.', 400)
    await _need_rooms()
    await _room_state(room_id)
    result = await _room_call('groups.log', {'room_id': room_id, 'since_seq': since_seq, 'limit': limit})
    return JSONResponse(_redact_deep({'events': result.get('events') or [], 'cursor': result.get('cursor'), 'latest_seq': result.get('latest_seq'),
                                       'has_more': bool(result.get('has_more'))}), headers=_HEADERS)


async def _gate_targets(audit, meta, targets):
    """Invariant 7 and ADR-003 in rooms: every target must be allowed to start work and have a live hook."""
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)
    for target in targets:
        def check(bot=target['bot']):
            hook.hook_gate(meta.path, bot)
            try:
                _start_gate(budget, meta.path, bot)
            except PluginError as error:
                raise PluginError(error.code, f"{error.message} ({bot})", error.status, {'details': {'bot': bot}}) from None
        await run_in_threadpool(check)


async def _refused(audit, actor, room_id, error, **payload):
    """Audit a refusal as denied, then raise it: nothing was sent."""
    def deny():
        raise RoomRefused(error.code, error.message, error.status, getattr(error, 'extra', None))
    try:
        await run_in_threadpool(audit.act, actor, 'room.send.refused', room_id, {'kind': 'ui'}, deny, payload={'code': error.code, **payload})
    except RoomRefused:
        pass
    raise error


async def _checked_send(audit, meta, actor, room_id, state, text, event_id, thread_id, confirm, *, kickoff=False):
    room = state['room']
    members = rooms.members_view(room)
    row = await run_in_threadpool(rooms.get_meta, meta.path, room_id)
    digest = {'text_len': len(text or ''), 'event_id': event_id}
    try:
        targets, stored = rooms.check_send(text, members, row.get('coordinator'))
        await _gate_targets(audit, meta, targets)
        if rooms.needs_confirmation(targets) and not confirm:
            raise PluginError('cost_confirmation_required', 'This message wakes several Bots and costs a round for each; confirm to send.', 409,
                              {'details': rooms.cost_details(targets)})
    except PluginError as error:
        await _refused(audit, actor, room_id, error, **digest)

    def effect():
        params = {'room_id': room_id, 'event_id': event_id, 'payload': {'text': stored, 'thread_id': thread_id or 'luvebot-main'}}  # Hermes requires a thread id
        return rooms_rpc.call('groups.send', params)
    payload = {'room': room_id, 'event_id': event_id, 'targets': [t['handle'] for t in targets], 'text_len': len(stored), 'kickoff': kickoff,
               'text_sha256': hashlib.sha256(stored.encode()).hexdigest()}
    result = await run_in_threadpool(audit.act, actor, 'room.send', room_id, {'kind': 'ui'}, effect, payload=payload)
    return {'event': _redact_deep(result.get('event')), 'targets': [t['handle'] for t in targets], 'accepted': bool(result.get('accepted', True)),
            'text': stored}


@router.post('/rooms/{room_id}/messages')
async def send_room_message(room_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    text, event_id, thread_id, confirm = rooms.validate_message(await _json_body(request, 80 * 1024))
    await _need_rooms()
    state = await _room_state(room_id)
    audit, meta = await run_in_threadpool(_stores)
    out = await _checked_send(audit, meta, actor, room_id, state, text, event_id, thread_id, confirm)
    out.pop('text')
    return JSONResponse(out, status_code=202, headers=_HEADERS)


@router.post('/rooms')
async def create_room(request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    fields = rooms.validate_create(await _json_body(request))
    names = await _names()
    for member in fields['members']:
        validate_profile(member['bot'])
        if member['bot'] not in names:
            raise HermesError('bot_not_found')
    await _need_rooms()
    audit, meta = await run_in_threadpool(_stores)
    room_id = rooms.new_room_id()
    hermes_members = [{'member_id': 'mem-' + uuid4().hex[:12], 'profile': m['bot'], 'handle': m['handle'],
                       **({'display_name': m['display_name']} if m['display_name'] else {})} for m in fields['members']]

    def effect():
        for m in fields['members']:
            hook.hook_gate(meta.path, m['bot'])  # a member whose hook is not live would run without LuveBot's rules
        created = rooms_rpc.call('groups.create', {'room_id': room_id, 'name': fields['name'], 'members': hermes_members})
        rooms.put_meta(meta.path, room_id, goal=fields['goal'], owner=fields['owner'], coordinator=fields['coordinator'], actor=actor, now=time.time())
        return created
    created = await run_in_threadpool(audit.act, actor, 'room.create', room_id, {'kind': 'ui'}, effect,
                                      payload={'name_len': len(fields['name']), 'members': [m['bot'] for m in fields['members']]})
    state = await _room_state(room_id)
    started = None
    if fields['kickoff'] and fields['goal']:
        started = await _checked_send(audit, meta, actor, room_id, state, fields['goal'], 'kickoff-' + uuid4().hex[:16], None, True, kickoff=True)
    view = _room_view(state['room'], await run_in_threadpool(rooms.get_meta, meta.path, room_id), state.get('driver_status'))
    return JSONResponse(_redact_deep({'room': view, **({'kickoff': {'targets': started['targets']}} if started else {})}), status_code=201, headers=_HEADERS)


@router.patch('/rooms/{room_id}')
async def patch_room(room_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    await _need_rooms()
    state = await _room_state(room_id)
    changes = rooms.validate_patch(await _json_body(request), rooms.members_view(state['room']))
    audit, meta = await run_in_threadpool(_stores)

    def effect():
        if 'name' in changes:
            rooms_rpc.call('groups.rename', {'room_id': room_id, 'event_id': 'rename-' + uuid4().hex[:16], 'name': changes['name']})
        current = rooms.get_meta(meta.path, room_id)
        merged = {**current, **{k: v for k, v in changes.items() if k != 'name'}}
        rooms.put_meta(meta.path, room_id, goal=merged['goal'], owner=merged['owner'], coordinator=merged['coordinator'], actor=actor, now=time.time())
    await run_in_threadpool(audit.act, actor, 'room.rename' if 'name' in changes else 'room.update', room_id, {'kind': 'ui'}, effect,
                            payload={'keys': sorted(changes)})
    fresh = await _room_state(room_id)
    return JSONResponse(_redact_deep({'room': _room_view(fresh['room'], await run_in_threadpool(rooms.get_meta, meta.path, room_id), fresh.get('driver_status'))}),
                        headers=_HEADERS)


@router.post('/rooms/{room_id}/stop')
async def stop_room(room_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    body = await _json_body(request)
    if body != {}:
        raise PluginError('bad_request', 'Invalid request body.', 400)
    await _need_rooms()
    await _room_state(room_id)
    audit, meta = await run_in_threadpool(_stores)
    cancel_id = 'luvebot-' + uuid4().hex[:16]
    result = await run_in_threadpool(audit.act, actor, 'room.stop', room_id, {'kind': 'ui'},
                                     lambda: rooms_rpc.call('groups.stop', {'room_id': room_id, 'cancel_id': cancel_id}), payload={'cancel_id': cancel_id})
    return JSONResponse({'ok': True, 'cancelled': result.get('cancelled', 0)}, status_code=202, headers=_HEADERS)


@router.post('/rooms/{room_id}/tasks/{task_id}/retry')
async def retry_room_task(room_id: str, task_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    body = await _json_body(request)
    if not isinstance(body, dict) or body.get('confirm') is not True or set(body) != {'confirm'} or not rooms.valid_id(task_id):
        raise PluginError('invalid_field', 'Retrying uncertain work needs {"confirm": true}.', 422)
    await _need_rooms()
    state = await _room_state(room_id)
    audit, meta = await run_in_threadpool(_stores)
    await _gate_targets(audit, meta, rooms.members_view(state['room']))  # S02: a retry runs the task again, for whoever it belongs to
    result = await run_in_threadpool(audit.act, actor, 'room.retry', room_id, {'kind': 'ui'},
                                     lambda: rooms_rpc.call('groups.retry', {'room_id': room_id, 'task_id': task_id}), payload={'task_id': task_id})
    return JSONResponse(_redact_deep({'ok': True, 'task': result.get('task')}), status_code=202, headers=_HEADERS)


@router.delete('/rooms/{room_id}')
async def disband_room(room_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    body = await _json_body(request)
    await _need_rooms()
    state = await _room_state(room_id)
    if not isinstance(body, dict) or set(body) != {'confirm_name'} or body['confirm_name'] != state['room'].get('name'):
        raise PluginError('invalid_field', 'Type the room name to disband it.', 422)
    audit, meta = await run_in_threadpool(_stores)
    await run_in_threadpool(audit.act, actor, 'room.disband', room_id, {'kind': 'ui'},
                            lambda: rooms_rpc.call('groups.disband', {'room_id': room_id, 'cancel_id': 'luvebot-disband-' + uuid4().hex[:12]}))
    return JSONResponse({'ok': True}, headers=_HEADERS)


# ---- handoffs ------------------------------------------------------------------------------------------------------
async def _handoff_view(path, row):
    """What the handoff is NOW: the stored row plus the Kanban task's state. A GET shows it; only the audited watcher
    (`handoffs.sync`) persists a transition (S09)."""
    task = await run_in_threadpool(_quiet_none, hermes_cron.kanban_task, row['task_id'])
    return handoffs.live_view(row, task)


def _quiet_none(fn, *args):
    try:
        return fn(*args)
    except Exception:
        return None


@router.post('/handoffs')
async def create_handoff(request: Request):
    actor = _human(request).id  # S05: handing work to a Bot is a person's decision (403 loopback_not_human in loopback)
    fields = handoffs.validate_create(await _json_body(request))
    names = await _names()
    for bot in (fields['from'], fields['to']):
        validate_profile(bot)
        if bot not in names:
            raise HermesError('bot_not_found')
    await _need_cron()
    audit, meta = await run_in_threadpool(_stores)
    if fields['room_id']:
        await _need_rooms()
        state = await _room_state(fields['room_id'])
        try:
            handoffs.check_room(rooms.members_view(state['room']), fields['from'], fields['to'], fields['room_id'])
        except PluginError as error:
            await _handoff_refused(audit, actor, fields, error, 'not_a_member')
    verdict = await run_in_threadpool(lambda: handoffs.evaluate(lambda bot: rules_service.effective_rules(meta.path, bot), fields['from'], fields['to'], fields['requested']))
    column = handoffs.column_for(verdict['effect'])
    if column == 'refuse':
        await _handoff_refused(audit, actor, fields, PluginError('handoff_blocked', 'A rule of the origin or of the destination blocks this handoff; nothing was created.', 422,
                                                                   {'details': {'rules': verdict['blocking']}}), verdict['effect'].value)
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)
    handoff_id = handoffs.new_id()

    def effect():
        _start_gate(budget, meta.path, fields['to'])  # invariant 7: work is not handed to a paused or capped Bot
        _verify_handoff_enforcement(meta.path, fields['from'], fields['to'])
        task_id = hermes_cron.kanban_create(title=fields['title'], body=fields['body'], assignee=fields['to'], created_by=fields['from'],
                                            triage=column == 'triage', idempotency_key=handoff_id, priority=fields['priority'], skills=fields['skills'])
        handoffs.insert(meta.path, handoff_id=handoff_id, origin=fields['from'], destination=fields['to'], task_id=task_id, title=fields['title'],
                        room_id=fields['room_id'], source='ui', effect=verdict['effect'].value, state='needs_review' if column == 'triage' else 'open',
                        needs_review=column == 'triage', actor=actor)
        return task_id
    task_id = await run_in_threadpool(audit.act, actor, 'handoff.created', handoff_id, {'kind': 'ui'}, effect, bot=fields['to'],
                                      payload={'from': fields['from'], 'to': fields['to'], 'room': fields['room_id'], 'effect': verdict['effect'].value,
                                               'title_sha256': handoffs.title_sha(fields['title'])})
    row = await run_in_threadpool(handoffs.get, meta.path, handoff_id)
    return JSONResponse({'handoff': await _handoff_view(meta.path, row), 'task_id': task_id}, status_code=201, headers=_HEADERS)


def _verify_handoff_enforcement(path, origin, destination):
    """S04: the origin's restrictions follow the work only through the destination's hook, so the work is not dispatched without
    it: the destination's hook must be live, and the origin must have a compiled table the worker can read."""
    hook.hook_gate(path, destination)
    if hook_store_read(path, origin) is None:
        raise PluginError('hook_not_live', 'The origin Bot has no compiled rules, so its restrictions cannot follow this handoff; install its hook first.', 409,
                          {'details': {'bot': origin}})


async def _handoff_refused(audit, actor, fields, error, effect):
    def deny():
        raise RoomRefused(error.code, error.message, error.status, getattr(error, 'extra', None))
    try:
        await run_in_threadpool(audit.act, actor, 'handoff.refused', None, {'kind': 'ui'}, deny, payload={'from': fields['from'], 'to': fields['to'], 'room': fields['room_id'], 'effect': effect})
    except RoomRefused:
        pass
    raise error


@router.get('/handoffs')
async def list_handoffs(request: Request, room: str = None, bot: str = None, state: str = None, limit: int = 50, cursor: str = None):
    _identity(request)
    if not 1 <= limit <= 100 or (cursor is not None and not re.fullmatch(r'[0-9]{1,9}', cursor)) or (room is not None and not rooms.valid_id(room)):
        raise PluginError('bad_request', 'Invalid paging parameters.', 400)
    audit, meta = await run_in_threadpool(_stores)
    offset = int(cursor or 0)
    rows = await run_in_threadpool(lambda: handoffs.listing(meta.path, room=room, bot=None if bot is None else validate_profile(bot), state=state, limit=limit, offset=offset))
    items = [await _handoff_view(meta.path, r) for r in rows[:limit]]
    return JSONResponse({'handoffs': items, 'next_cursor': str(offset + limit) if len(rows) > limit else None}, headers=_HEADERS)


async def _handoff(path, handoff_id):
    row = await run_in_threadpool(handoffs.get, path, handoff_id) if rooms.valid_id(handoff_id) else None
    if row is None:
        raise PluginError('handoff_not_found', 'Handoff not found.', 404)
    return row


@router.get('/handoffs/{handoff_id}')
async def get_handoff(handoff_id: str, request: Request):
    _identity(request)
    audit, meta = await run_in_threadpool(_stores)
    return JSONResponse({'handoff': await _handoff_view(meta.path, await _handoff(meta.path, handoff_id))}, headers=_HEADERS)


@router.post('/handoffs/{handoff_id}/promote')
async def promote_handoff(handoff_id: str, request: Request):
    actor = _human(request).id  # S05: only a person lifts a handoff that waits for review (not the loopback token)
    audit, meta = await run_in_threadpool(_stores)
    row = await _handoff(meta.path, handoff_id)
    if row['effect'] == 'block':
        raise PluginError('handoff_blocked', 'A blocked handoff cannot be promoted.', 409)
    if row['state'] != 'needs_review':
        raise PluginError('conflict', 'This handoff does not wait for review.', 409)

    budget = await run_in_threadpool(Budget, meta.path, audit=audit)

    def effect():
        _start_gate(budget, meta.path, row['to_bot'])  # S02: promoting is the moment the task becomes dispatchable
        _verify_handoff_enforcement(meta.path, row['from_bot'], row['to_bot'])
        if not hermes_cron.kanban_promote(row['task_id']):
            raise PluginError('conflict', 'Hermes could not promote this task.', 409)
        handoffs.set_state(meta.path, handoff_id, 'open', False)
    await run_in_threadpool(audit.act, actor, 'handoff.promoted', handoff_id, {'kind': 'ui'}, effect, bot=row['to_bot'],
                            payload={'task_id': row['task_id'], 'from': row['from_bot'], 'to': row['to_bot']})
    return JSONResponse({'handoff': await _handoff_view(meta.path, await _handoff(meta.path, handoff_id))}, headers=_HEADERS)


@router.post('/handoffs/{handoff_id}/cancel')
async def cancel_handoff(handoff_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    audit, meta = await run_in_threadpool(_stores)
    row = await _handoff(meta.path, handoff_id)

    def effect():
        if not hermes_cron.kanban_archive(row['task_id']):
            raise PluginError('conflict', 'Hermes could not archive this task.', 409)
        handoffs.set_state(meta.path, handoff_id, 'cancelled')
    await run_in_threadpool(audit.act, actor, 'handoff.cancelled', handoff_id, {'kind': 'ui'}, effect, bot=row['to_bot'],
                            payload={'task_id': row['task_id']})
    return JSONResponse({'handoff': await _handoff_view(meta.path, await _handoff(meta.path, handoff_id))}, headers=_HEADERS)


# ---- map -----------------------------------------------------------------------------------------------------------
@router.get('/map')
async def get_map(request: Request, window: str = '7d'):
    _identity(request)
    if window not in ('7d', '30d'):
        raise PluginError('bad_request', 'Unknown window.', 400)
    audit, meta = await run_in_threadpool(_stores)
    names = await _names()
    nodes, partial = [], []
    for name in names:
        try:
            bot = await _one(name)
            nodes.append({'bot': name, 'display': bot['display'], 'status': bot['status'], 'status_reason': bot['status_reason'],
                          'current_task': bot['current_task'], 'rooms': [], 'week_cost_cents': None})
        except Exception:
            partial.append(name)
    try:
        if await _room_call('groups.capabilities', {}) and rooms_rpc.available():
            listed = (await _room_call('groups.list', {'limit': 100, 'offset': 0})).get('rooms') or []
            for room in listed:
                for member in rooms.members_view(room):
                    node = next((n for n in nodes if n['bot'] == member['bot']), None)
                    if node is not None:
                        node['rooms'].append(room.get('room_id'))
    except Exception:
        partial.append('rooms')
    since = time.time() - (7 if window == '7d' else 30) * 86400
    rows = await run_in_threadpool(lambda: handoffs.listing(meta.path, limit=100))
    for row in rows[:100]:  # `live` follows the task now; nothing is written by a GET
        row['state'] = (await _handoff_view(meta.path, row))['state']
    return JSONResponse({'nodes': nodes, 'edges': handoffs.edges(rows[:100], since=since), 'generated_at': time.time(),
                         **({'partial': partial} if partial else {})}, headers=_HEADERS)


# ---- search --------------------------------------------------------------------------------------------------------
@router.get('/search')
async def get_search(request: Request, q: str = '', types: str = None, bots: str = None, limit: int = 8):
    _identity(request)
    query, chosen = search.validate(q, types, limit)
    names = await _names()
    if bots:
        wanted = [b for b in bots.split(',') if b]
        names = [validate_profile(b) for b in wanted if b in names]
    out, partial = {t: [] for t in ('messages', 'bots', 'rooms', 'routines', 'files', 'actions')}, []
    audit, meta = await run_in_threadpool(_stores)
    if 'messages' in chosen:
        async def one(name):
            try:
                rows = await asyncio.wait_for(run_in_threadpool(hermes_cron.sessions_search, name, query, limit, 'rooms' in chosen), timeout=2)
                return [search.hit(name, r, _REDACT) for r in rows]
            except Exception:
                partial.append(name)
                return []
        found = await asyncio.gather(*[one(n) for n in names])
        out['messages'] = search.interleave([h for hits in found for h in hits], limit)
    if 'bots' in chosen:
        infos = [i for i in await run_in_threadpool(profile_infos) if i['name'] in names]
        out['bots'] = [{'name': i['name'], 'description': i.get('description')} for i in search.substring(infos, query, ('name', 'description'), limit)]
    if 'rooms' in chosen:
        try:
            listed = (await _room_call('groups.list', {'limit': 100, 'offset': 0})).get('rooms') or []
            if bots:  # S07: the same scope as the other sources: a room counts only if one of the asked Bots is a member
                listed = [r for r in listed if {m['bot'] for m in rooms.members_view(r)} & set(names)]
            out['rooms'] = [{'id': r.get('room_id'), 'name': r.get('name')} for r in search.substring(listed, query, ('name',), limit)]
        except Exception:
            partial.append('rooms')
    if 'routines' in chosen:
        try:
            found_jobs = []
            for name in names:
                found_jobs += [{'id': j.get('id'), 'bot': name, 'name': j.get('name')} for j in await _jobs_of(name)]
            out['routines'] = search.substring(found_jobs, query, ('name',), limit)
        except Exception:
            partial.append('routines')
    if 'actions' in chosen:
        out['actions'] = [{'id': a, 'label': label} for a, label in search.ACTIONS if query.casefold() in label.casefold() or query.casefold() in a]
    # the query is data: only its length and hash are recorded, never the text
    return JSONResponse(_redact_deep({**out, **({'partial': sorted(set(partial))} if partial else {})}), headers=_HEADERS)


# ---------------------------------------------------------------------------
# Contract v0.4 (B1, B2, B3, B4, B6, B7): history, unread, pause, introduction, SOUL. Logic in backend/bot_controls.py.
# ---------------------------------------------------------------------------
async def _existing(bot):
    name = validate_profile(bot)
    if name not in await _names():
        raise HermesError('bot_not_found')
    return name


def _routine_results(path, name):
    """Counted for B2 from Hermes's session rows; None (shown as unknown, never 0) when that read fails."""
    try:
        return bot_controls.routine_results_since(name, bot_controls.read_mark(path, name))
    except Exception:
        return None


@router.get('/bots/{bot}/sessions')
async def list_bot_sessions(bot: str, request: Request, limit: int = 50, cursor: str = None, q: str = None, source: str = None):
    _identity(request)
    name = await _existing(bot)
    if not 1 <= limit <= 100 or (q is not None and len(q) > 200) or source not in (None, 'cron'):
        raise PluginError('bad_request', 'Invalid history parameters.', 400)
    offset = bot_controls.offset_of(cursor)
    audit, meta = await run_in_threadpool(_stores)
    intro = (await run_in_threadpool(meta.introduction, name)).get('intro_session_id')
    rows = await run_in_threadpool(lambda: bot_controls.session_rows(name, limit=limit + 1, offset=offset, source=source, q=q))
    return JSONResponse({'sessions': [bot_controls.session_view(r, _REDACT, intro) for r in rows[:limit] if r.get('source') != 'bot_room'],
                         'next_cursor': str(offset + limit) if len(rows) > limit else None}, headers=_HEADERS)


@router.get('/bots/{bot}/sessions/{sid}/messages')
async def list_session_messages(bot: str, sid: str, request: Request, limit: int = 100, before: str = None):
    _identity(request)
    name = await _existing(bot)
    if safe_id(sid) is None:
        raise PluginError('session_not_found', 'Session not found.', 404)
    if not 1 <= limit <= 100:
        raise PluginError('bad_request', 'Invalid history limit.', 400)
    return JSONResponse(await run_in_threadpool(bot_controls.messages, name, sid, limit, before, _REDACT), headers=_HEADERS)


@router.post('/bots/{bot}/read')
async def mark_bot_read(bot: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    body = await _json_body(request)
    if not isinstance(body, dict) or set(body) != {'through'}:
        raise PluginError('bad_request', 'Send only "through".', 400)
    audit, meta = await run_in_threadpool(_stores)
    await run_in_threadpool(RunIndex, meta.path)  # the run index (and its ended_at) exists before it is read
    await run_in_threadpool(bot_controls.mark_read, meta.path, audit, name, body['through'], actor)
    count = await run_in_threadpool(_routine_results, meta.path, name)
    return JSONResponse({'unread': await run_in_threadpool(bot_controls.unread, meta.path, name, count)}, headers=_HEADERS)


def _pause_body(body, *, resume):
    allowed = set() if resume else {'reason', 'stop_active'}
    if not isinstance(body, dict) or set(body) - allowed:
        raise PluginError('bad_request', 'Invalid pause request.', 400)
    if 'reason' in body and (not isinstance(body['reason'], str) or len(body['reason']) > 500):
        raise PluginError('invalid_field', 'Invalid value for reason.', 422)
    if 'stop_active' in body and not isinstance(body['stop_active'], bool):
        raise PluginError('invalid_field', 'Invalid value for stop_active.', 422)
    return body


def _stop_open_runs(audit, index, actor, names):
    """`stop_active`: the runs LuveBot tracks for these Bots, each stop audited before it is sent (v0 stop service)."""
    stopped = []
    for name in names:
        for run in index.open_runs(name):
            try:
                raw = audit.act(actor, 'run.stop', run['run_id'], 'ui', lambda n=name, r=run['run_id']: _stop_native(n, r), bot=name)
            except PluginError:
                continue  # already ended
            if isinstance(raw, str):
                index.set_status(run['run_id'], raw[:64])
            stopped.append(run['run_id'])
    return stopped


async def _pause_route(request, bot, *, resume):
    # D-012/A-2: pausing tightens and stays allowed in loopback; lifting a pause needs a person (403 loopback_not_human)
    actor = _budget_actor(request, raises=resume)
    name = await _existing(bot) if bot else None
    body = _pause_body(await _json_body(request), resume=resume)
    audit, meta = await run_in_threadpool(_stores)
    if name is None:
        effect = bot_controls.resume_all if resume else (lambda: bot_controls.pause_all(actor))
    else:
        effect = (lambda: bot_controls.resume(meta.path, name)) if resume else (lambda: bot_controls.pause(meta.path, name, actor))
    reason = body.get('reason', '')
    outcome = await run_in_threadpool(audit.act, actor, ('bot.' if name else 'fleet.') + ('resume' if resume else 'pause'), name or 'fleet',
                                      {'kind': 'ui'}, effect, bot=name,
                                      payload={'reason_sha256': bot_controls.digest(reason), 'reason_length': len(reason),
                                               'stop_active': body.get('stop_active', False)})
    if body.get('stop_active'):
        index = await run_in_threadpool(RunIndex, meta.path)
        outcome['stopped_runs'] = await run_in_threadpool(_stop_open_runs, audit, index, actor, [name] if name else await _names())
    return JSONResponse(outcome, headers=_HEADERS)


@router.post('/bots/{bot}/pause')
async def pause_bot(bot: str, request: Request):
    return await _pause_route(request, bot, resume=False)


@router.post('/bots/{bot}/resume')
async def resume_bot(bot: str, request: Request):
    return await _pause_route(request, bot, resume=True)


@router.post('/pause-all')
async def pause_everything(request: Request):
    return await _pause_route(request, None, resume=False)


@router.post('/resume-all')
async def resume_everything(request: Request):
    return await _pause_route(request, None, resume=True)


_INTRO_LOCK = threading.Lock()  # once per Bot: two clicks cannot start two introductions


def _intro_view(meta, index, name, estimate):
    stored = meta.introduction(name)
    run_id = stored.get('intro_run_id')
    status = index.status(run_id) if run_id else None
    return {'state': 'running' if status in OPEN_STATUSES else 'done' if run_id else 'none', 'session_id': stored.get('intro_session_id'),
            'run_id': run_id, 'estimate_cents': estimate, 'requires_confirm': True}


async def _intro_refusal(name, meta):
    """The first reason, in the order of the contract, that keeps an introduction from starting; None when it can start.
    A GET writes nothing: the POST asks the Budget itself."""
    bot = await _one(name)
    if bot['status'] == 'offline':
        return 'bot_offline'
    if bot['hook']['status'] != 'live':
        return 'hook_not_live'
    if bot['status'] == 'paused':  # a reached cap pauses the Bot (invariant 7)
        return 'budget_exceeded' if bot['status_reason'] == 'budget' else 'bot_paused'
    if get_template((await run_in_threadpool(meta.introduction, name)).get('template_id')) is None:
        return 'no_template'
    return None


@router.get('/bots/{bot}/introduction')
async def get_introduction(bot: str, request: Request):
    _identity(request)
    name = await _existing(bot)
    audit, meta = await run_in_threadpool(_stores)
    index = await run_in_threadpool(RunIndex, meta.path)
    estimate = await run_in_threadpool(bot_controls.run_estimate, name)
    view = await run_in_threadpool(_intro_view, meta, index, name, estimate)
    if view['state'] == 'none' and (reason := await _intro_refusal(name, meta)):
        view.update(state='unavailable', reason=reason)
    return JSONResponse(view, headers=_HEADERS)


@router.post('/bots/{bot}/introduction')
async def introduce_bot(bot: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    body = await _json_body(request)
    if not isinstance(body, dict) or set(body) - {'confirm_cost', 'force'} or not isinstance(body.get('force', False), bool):
        raise PluginError('bad_request', 'Send only "confirm_cost" and "force".', 400)  # no client text reaches the instruction
    audit, meta = await run_in_threadpool(_stores)
    index = await run_in_threadpool(RunIndex, meta.path)
    estimate = await run_in_threadpool(bot_controls.run_estimate, name)
    if body.get('confirm_cost') is not True:
        raise PluginError('cost_confirmation_required', 'An introduction is a real model run; confirm its cost first.', 409,
                          {'details': {'estimate_cents': estimate}})
    view = await run_in_threadpool(_intro_view, meta, index, name, estimate)
    if view['state'] != 'none' and not body.get('force'):
        return JSONResponse(view, headers=_HEADERS)  # once per Bot: the stored ids
    if (await _one(name))['status'] == 'offline':
        raise PluginError('bot_offline', 'This Bot is offline; its introduction can start once Hermes serves it.', 409)
    await _require_feature(name, 'runs')
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)

    def effect():
        with _INTRO_LOCK:
            hook.hook_gate(meta.path, name)  # hook_not_live, before any session exists
            budget_gate(budget, meta.path, name)  # bot_paused (ours, ESTOP or budget), budget_exceeded, budget_unavailable
            stored = meta.introduction(name)
            if stored.get('intro_run_id') and not body.get('force'):
                return None
            template = get_template(stored.get('template_id'))
            if template is None:
                raise RunRefused('no_template', 'This Bot was not made from a template; there is nothing to introduce it with.', 409)
            # no title: Hermes titles are unique per profile (api_server.py#L3184), so a second introduction would be refused
            status, payload = ApiClient(name).call('POST', '/api/sessions', {})
            session_id = safe_id(((payload or {}).get('session') or {}).get('id'))
            if status != 201 or session_id is None:
                raise upstream_error(status, on_404=_NO_404)
            meta.set_intro(name, session_id, None)
            status, payload = ApiClient(name).call('POST', '/v1/runs', {'input': bot_controls.intro_instruction(template, meta.get(name)),
                                                                        'session_id': session_id})
            run_id = safe_id((payload or {}).get('run_id'))
            if status not in (200, 202) or run_id is None:
                raise upstream_error(status, on_404=_NO_404)
            state = contract_status(payload.get('status'))[0]
            index.add(run_id, name, session_id, actor, state if state != 'unknown' else 'started')
            meta.set_intro(name, session_id, run_id)
            return run_id

    run_id = await run_in_threadpool(audit.act, actor, 'bot.introduce', name, {'kind': 'ui'}, effect, bot=name,
                                     payload={'estimate_cents': estimate, 'force': body.get('force', False)})
    if run_id:
        approvals_native.start_watcher(meta.path, name, run_id, _REDACT)
    return JSONResponse(await run_in_threadpool(_intro_view, meta, index, name, estimate), status_code=202 if run_id else 200, headers=_HEADERS)


@router.get('/bots/{bot}/soul')
async def get_soul(bot: str, request: Request):
    _identity(request)
    name = await _existing(bot)
    return JSONResponse(await run_in_threadpool(bot_controls.soul_view, name, _REDACT), headers=_HEADERS)


@router.put('/bots/{bot}/soul')
async def put_soul(bot: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    body = await _json_body(request, bot_controls.SOUL_MAX * 6 + 1024)  # JSON escapes can grow the text up to 6x
    if not isinstance(body, dict) or set(body) != {'content', 'expected_digest'} or not isinstance(body['expected_digest'], str):
        raise PluginError('bad_request', 'Send "content" and "expected_digest".', 400)
    content = bot_controls.validate_soul(body['content'])
    audit, meta = await run_in_threadpool(_stores)
    await run_in_threadpool(audit.act, actor, 'bot.soul.update', name, {'kind': 'ui'},
                            lambda: bot_controls.update_soul(name, content, body['expected_digest']), bot=name,
                            payload={'sha256': bot_controls.digest(content), 'length': len(content)})  # never the text
    return JSONResponse(await run_in_threadpool(bot_controls.soul_view, name, _REDACT), headers=_HEADERS)


@router.put('/bots/{bot}/description')
async def put_description(bot: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    body = await _json_body(request)
    text = body.get('description') if isinstance(body, dict) and set(body) == {'description'} else None
    if not isinstance(text, str) or len(text) > 500 or any(ord(c) < 32 and c not in '\n\t' for c in text):
        raise PluginError('invalid_field', 'The description is plain text of at most 500 characters.', 422)
    audit, meta = await run_in_threadpool(_stores)
    await run_in_threadpool(audit.act, actor, 'bot.description.update', name, {'kind': 'ui'},
                            lambda: bot_controls.update_description(name, text), bot=name,
                            payload={'sha256': bot_controls.digest(text), 'length': len(text)})
    return JSONResponse(_redact_deep(await _one(name)), headers=_HEADERS)


# ---------------------------------------------------------------------------
# Contract v0.5 (P1, P2): Pages. Logic in backend/pages.py (ADR-004 for the one direct mkdir).
# ---------------------------------------------------------------------------
def _page_who(request, actor, name, meta):
    """Who asks or writes: the raw actor stays server side; display names only (A-63)."""
    session = getattr(request.state, 'session', None)
    return {'actor': actor, 'label': pages.actor_label(getattr(session, 'display_name', None), _REDACT),
            'bot_label': _REDACT(meta.get(name)['label'])}


async def _page_context(bot, request, *, write=False):
    actor, credential, _mode = _identity(request)
    if write:
        _require_csrf(request, credential)  # page writes are allowed in loopback (A-2): they neither tighten nor loosen a control
    name = await _existing(bot)
    audit, meta = await run_in_threadpool(_stores)
    db = await run_in_threadpool(pages.Revisions, meta.path)
    who = await run_in_threadpool(_page_who, request, actor, name, meta)
    return name, audit, db, who


def _page_note(request, actor, name, meta, slug):
    who = _page_who(request, actor, name, meta)
    return pages.note(pages.Revisions(meta.path), name, slug, (who['actor'], who['bot_label']))


@router.get('/bots/{bot}/pages')
async def pages_list(bot: str, request: Request, q: str = None):
    if q is not None and len(q) > 200:
        raise PluginError('bad_request', 'Invalid search.', 400)
    name, _audit, db, who = await _page_context(bot, request)
    return JSONResponse(await run_in_threadpool(pages.list_pages, db, name, q, (who['actor'], who['bot_label']), _REDACT), headers=_HEADERS)


@router.get('/bots/{bot}/pages/{slug}')
async def page_get(bot: str, slug: str, request: Request):
    name, _audit, db, who = await _page_context(bot, request)
    return JSONResponse(await run_in_threadpool(pages.get_page, db, name, slug, (who['actor'], who['bot_label']), _REDACT), headers=_HEADERS)


@router.get('/bots/{bot}/pages/{slug}/revisions')
async def page_revisions(bot: str, slug: str, request: Request, limit: int = 50, cursor: str = None):
    if not 1 <= limit <= 100:
        raise PluginError('bad_request', 'Invalid limit.', 400)
    name, _audit, db, who = await _page_context(bot, request)
    return JSONResponse(await run_in_threadpool(pages.revisions, db, name, slug, limit, cursor, (who['actor'], who['bot_label'])),
                        headers=_HEADERS)


@router.get('/bots/{bot}/pages/{slug}/revisions/{rev}')
async def page_revision(bot: str, slug: str, rev: int, request: Request):
    name, _audit, db, who = await _page_context(bot, request)
    return JSONResponse(await run_in_threadpool(pages.revision, db, name, slug, rev, (who['actor'], who['bot_label']), _REDACT),
                        headers=_HEADERS)


@router.post('/bots/{bot}/pages')
async def page_create(bot: str, request: Request):
    name, audit, db, who = await _page_context(bot, request, write=True)
    body = await _json_body(request, pages.MAX_BYTES * 6 + 4096)  # JSON escapes can grow the text up to 6x
    if not isinstance(body, dict) or set(body) - {'title', 'content'} or 'title' not in body:
        raise PluginError('bad_request', 'Send "title" and optionally "content".', 400)
    page = await run_in_threadpool(pages.create, db, audit, name, body['title'], body.get('content'), who, 'req_' + uuid4().hex, _REDACT)
    return JSONResponse({'page': page}, status_code=201, headers=_HEADERS)


@router.put('/bots/{bot}/pages/{slug}')
async def page_save(bot: str, slug: str, request: Request):
    name, audit, db, who = await _page_context(bot, request, write=True)
    body = await _json_body(request, pages.MAX_BYTES * 6 + 4096)
    if not isinstance(body, dict) or set(body) != {'content', 'base_sha'}:
        raise PluginError('bad_request', 'Send "content" and "base_sha".', 400)
    return JSONResponse(await run_in_threadpool(pages.update, db, audit, name, slug, body['content'], body['base_sha'], who,
                                                'req_' + uuid4().hex, _REDACT), headers=_HEADERS)


@router.post('/bots/{bot}/pages/{slug}/revisions/{rev}/restore')
async def page_restore(bot: str, slug: str, rev: int, request: Request):
    name, audit, db, who = await _page_context(bot, request, write=True)
    body = await _json_body(request)
    if not isinstance(body, dict) or set(body) != {'base_sha'}:
        raise PluginError('bad_request', 'Send "base_sha".', 400)  # the content of the revision is read server side
    return JSONResponse(await run_in_threadpool(pages.restore, db, audit, name, slug, rev, body['base_sha'], who,
                                                'req_' + uuid4().hex, _REDACT), headers=_HEADERS)


@router.get('/bots/{bot}/files/download')
async def file_download(bot: str, path: str, request: Request):
    """T12: a file of the Bot's workspace as an attachment, never rendered (backend/pages.py read_workspace_file has the rules).
    A read, but audited (file.download, target = sha256 of the path, never the path) because it hands a file to the browser."""
    actor, _credential, _mode = _identity(request)
    name = await _existing(bot)
    audit, _meta = await run_in_threadpool(_stores)
    filename, data = await run_in_threadpool(audit.act, actor, 'file.download', hashlib.sha256(path.encode('utf-8', 'replace')).hexdigest(),
                                             {'kind': 'ui'}, lambda: pages.read_workspace_file(name, path, _REDACT), bot=name)
    return Response(data, media_type='application/octet-stream', headers={
        **_HEADERS, 'Content-Disposition': "attachment; filename*=UTF-8''" + urllib.parse.quote(filename, safe=''),
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox"})


@router.post('/bots/{bot}/attachments')
async def attachment_upload(bot: str, request: Request):
    """T14 (ADR-005): one file as multipart field `file`, kept in <workspace>/attachments under a name the server chose
    (backend/pages.py save_attachment has the rules). The body is capped before it is parsed."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    try:
        length = int(request.headers.get('content-length', ''))
    except ValueError:
        raise PluginError('length_required', 'Send the file with a Content-Length.', 411) from None
    if length > pages.DOC_MAX + 64 * 1024:
        raise PluginError('too_large', 'Attachments are limited to 10 MB (images) and 20 MB (documents).', 413)
    try:
        form = await request.form(max_files=1, max_fields=1)
    except AssertionError:  # python-multipart missing: Hermes's own uploads would fail the same way
        raise PluginError('capability_missing', 'This Hermes cannot receive files.', 409, {'details': {'feature': 'attachments'}}) from None
    except Exception:
        raise PluginError('bad_request', 'Send one file as multipart field "file".', 400) from None
    try:
        upload = form.get('file')
        if set(form.keys()) != {'file'} or not hasattr(upload, 'read'):
            raise PluginError('bad_request', 'Send one file as multipart field "file".', 400)
        data, filename = await upload.read(pages.DOC_MAX + 1), upload.filename
    finally:
        await form.close()  # the spooled temp file goes now, not at garbage collection
    audit, meta = await run_in_threadpool(_stores)
    index = await run_in_threadpool(RunIndex, meta.path)
    attachment = await run_in_threadpool(pages.save_attachment, audit, index.keyed_digest, actor, name, filename, data, 'req_' + uuid4().hex)
    return JSONResponse({'attachment': attachment}, status_code=201, headers=_HEADERS)


@router.post('/bots/{bot}/workspace')
async def workspace_set(bot: str, request: Request):
    """ADR-005 §3: a Bot without terminal.cwd gets its own <profile home>/workspace (backend/pages.py set_own_workspace)."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    audit, _meta = await run_in_threadpool(_stores)
    state = await run_in_threadpool(pages.set_own_workspace, audit, actor, name, 'req_' + uuid4().hex)
    await run_in_threadpool(_refresh_hint, name, audit, actor)  # the Bot learns where its Pages folder now is
    return JSONResponse({'workspace': {'state': state}}, headers=_HEADERS)


_PAGE_SCAN = {}  # bot -> monotonic time of the last rescan (7.1: at most one per second per Bot)


async def _page_updates(path, bot, run_id, index, *, final=False):
    """7.1: after a writing tool completed (or when the run ends), pages that changed become `bot` revisions of this run."""
    now = time.monotonic()
    if not final and now - _PAGE_SCAN.get(bot, -10) < 1:
        return None  # debounced: the final pass of the run catches it
    _PAGE_SCAN[bot] = now
    started = await run_in_threadpool(index.started_at, run_id)
    since = datetime.fromisoformat(started.replace('Z', '+00:00')).timestamp() if started else time.time() - 3600
    try:
        return await run_in_threadpool(pages.rescan, pages.Revisions(path), bot, run_id, since, _REDACT)
    except Exception:
        return []  # history is best effort; the stream never breaks over it


# ---------------------------------------------------------------------------
