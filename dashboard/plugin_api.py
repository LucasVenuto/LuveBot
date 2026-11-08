"""Minimal LuveBot router, mounted and authenticated by the Hermes dashboard."""
import asyncio
import atexit
import copy
from datetime import datetime, timezone
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
from luvebot_backend.hermes_boundary import guarded, run_in_threadpool   # the boundary's, the only one: a Hermes config outage raised in the worker thread becomes an ordinary error there (contract v0.10 section 1)
from luvebot_backend.audit import ActionDenied, AuditLog, AuditUnavailable, ChainProof
from luvebot_backend.bot_meta import BotMeta, validate_display, validate_order, validate_person
from luvebot_backend import approval_surface, approvals, approvals_native, free_pass, hermes_boundary, hermes_compat, hook, hook_store, live_state, rules, rules_service, rules_store, watcher_lease
from luvebot_backend.bots import (bot_object, capabilities_cached, create_in_hermes, detail_extras, initial_display, probe, profile_infos,
                                  validate_create)
from luvebot_backend.budget import Budget, BudgetUnavailable, MAX_CENTS
from luvebot_backend import avatars, identity, png_avatar
from luvebot_backend.identity import person_providers   # by name: `health` has a local called `identity` (the Hermes identity)
from luvebot_backend import activity, cost_watcher, costs, handoffs, hermes_cron, plan_quota, rooms, rooms_rpc, routine_suggestions, routines, search
from luvebot_backend.executor import Executor
from luvebot_backend.hermes_api import ApiClient, safe_id
from luvebot_backend.hermes_client import HermesClient, HermesError, feature_states, profile_names, validate_profile
from luvebot_backend.runs import (OPEN as OPEN_STATUSES, RunIndex, budget_gate, contract_status, has_limits, is_paused, upstream_error,
                                  validate_chat_body, validate_run_body, validate_session_body)
from luvebot_backend import bot_controls, bot_model, tool_masks, inactivity, memory, pages, push, room_files, skill_teach, skills, pages_review, reactions, session_start, sse_proxy, suggestions, threads, timeline, voice
from luvebot_backend import screen as bot_screen
from luvebot_backend import hermes_gate
from luvebot_backend import canonical
from luvebot_backend import redaction
from luvebot_backend.flight import Flight, Memo
from luvebot_backend import waiting
from luvebot_backend.runs import RunRefused
from luvebot_backend.templates import TEMPLATES, get_template

_HEADERS = {'X-LuveBot-API': '0', 'Cache-Control': 'no-store'}
_CSRF_KEY = secrets.token_bytes(32)


def _code_digest():
    """sha256 of the plugin's Python code as it is ON DISK now (plugin_entry.py, plugin_api.py and backend/*.py), or None if it cannot be read.
    Hermes mounts these routes once, when the dashboard starts (hermes_cli/web_server_dashboard.py: include_router at plugin
    discovery), while the UI bundle is read from disk on every load: after an update without a restart the new UI calls routes
    the running backend does not have (a bare 404, which the UI read as "Bot not found"). Comparing this with the digest taken at
    import says so (VPS 2026-10-02, the Screen tab of `default`)."""
    try:
        root = Path(__file__).resolve().parents[1]
        digest = hashlib.sha256()
        for source in [root / 'dashboard' / 'plugin_entry.py', root / 'dashboard' / 'plugin_api.py', *sorted((root / 'backend').glob('*.py'))]:
            digest.update(source.name.encode() + b'\0' + source.read_bytes() + b'\0')
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


_EPOCH = [0]   # bumped by every AUTHORIZED request that CHANGES something (before it runs and after it ends) and by the watcher when it changed something: a shared read never outlives a change
_FLIGHT = Flight()
_WAITING = Memo(15.0)   # one Bot's waits, kept 15 s (and until anything changes, or the hook wrote a wait: its marker is in the key; with no marker, a 3 s bucket of the clock). The marker sees only the hook's rows: a wait that goes away because its SESSION ended (no hook row) stays until the 15 s (screen only): the chip, Today and the push poll them from every open tab (F9)
_CAN_ASK = Memo(60.0)   # whether a Bot can ask a person (the profile's `can_ask`): one api_server call per Bot, kept 60 s (and until anything changes); "not told" is never remembered
_FILE_TOOLS = Memo(60.0)   # what a Bot can do with a file (the profile's `file_tools`, contract v0.9 section 14): from the same toolsets read as `can_ask`, kept 60 s per Bot and ONLY when all three keys were told (and until anything changes)
_SKILLS_MATRIX = Memo(30.0)   # the Bot x Skill matrix reads every Bot's catalog and config one after the other: kept 30 s (and until anything changes, a toggle included) (F6)
_MODEL_INFO = Memo(15.0)   # one Bot's model from Hermes's `get_model_info` (contract v0.11 section 1), kept 15 s (and until anything changes: a write bumps the epoch)
_MODEL_OPTIONS = Memo(60.0)   # one Bot's model options (providers and model ids LuveBot may change, normalized), kept 60 s per Bot, read only when the person opens the picker
_MODEL_LOCKS = {}   # one asyncio lock per Bot: two tabs changing the model take turns, and the second finds its `expected` stale. The lock lives in THIS process only: a write by the CLI or another process between the check and the write is not seen, and the last one wins
_SUGGESTIONS = Memo(15.0)   # one Bot's pending routine suggestions from Hermes (contract v0.10 section 2), kept 15 s (and until anything changes: accept and dismiss bump the epoch)
_ACTIVITY = Memo(3.0)   # one Bot's activity, kept 3 s (and until anything changes): the Today screen asks twice, running then done


_SERVED = [False]  # set by any request that reaches the router: a process that ANSWERED serves, whatever the lifespan check says (the tick then runs)


class SafeRoute(APIRoute):
    def get_route_handler(self):
        original = redaction.budgeted(super().get_route_handler())   # P-3: the child starts if there is none, and the request has 3 s of redactor time in all

        async def handle(request):
            _SERVED[0] = True
            started = time.perf_counter()
            changes = request.method not in ('GET', 'HEAD', 'OPTIONS')
            bumped = False
            try:
                foreign = _foreign_request(request)
                if foreign:
                    return _error(foreign, 'This request comes from an address the dashboard does not serve.', 403)
                # Invariant 2 before anything reads the request: FastAPI validates the query and path before the route's own
                # `_identity`, so in loopback a request without the session token got a 400 (red team gap G1.1), not a 401.
                _identity(request)
                # Runs before Hermes's injected profile dependency, whose error text may contain the raw profile name: keep all plugin
                # errors our own. ADR-006 D2b: the dashboard's `?profile=` selector is not ours to follow (the Bot comes from the path):
                # only none, `current` and the launch profile's own name are answered.
                if 'profile' in request.query_params:
                    value = request.query_params['profile']
                    if value not in ('', 'current') and not hermes_compat.profile_param_ok(
                            value, await run_in_threadpool(hermes_compat.launch_profile)):
                        return _error('profile_param_not_supported', 'LuveBot answers only for the dashboard profile it runs in; use '
                                      '?profile=current (or none), and name the Bot in the path.', 400)
                if changes:  # only now, past every refusal: a request nobody authorized changes nothing and must not empty the shared reads (red team R1)
                    _EPOCH[0] += 1
                    bumped = True
                response = await original(request)
                response.headers['X-LuveBot-API'] = _HEADERS['X-LuveBot-API']  # always ours
                response.headers.setdefault('Cache-Control', _HEADERS['Cache-Control'])  # no-store, unless the route says its own on purpose (only the avatar does: AV-3b)
                if 'Server-Timing' not in response.headers:  # every route says how long it took (phase names and milliseconds, never data)
                    response.headers['Server-Timing'] = f'total;dur={(time.perf_counter() - started) * 1000:.1f}'
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
                refusal = hermes_boundary.config_write_refusal(error)
                if refusal is not None:  # a write Hermes's config backend refused, through a Hermes ROUTE: its HTTPException (403, 400, 413) carries the refusal as its cause; say which, never a bare "unexpected response"
                    code, key = refusal
                    refused = HermesError(code)
                    return _error(code, refused.message, refused.status, {'details': {'key': key}} if key else None)
                return _error('hermes_error', 'Hermes returned an unexpected response.', 502)
            except SystemExit as error:
                # A Hermes call made inside the handler raised its config outage (a SystemExit on purpose): the request ends as 503, the dashboard keeps serving. Any OTHER exit is not ours: it goes on.
                if not hermes_boundary.is_config_unavailable(error):
                    raise
                unavailable = HermesError('config_backend_unavailable')
                return _error(unavailable.code, unavailable.message, unavailable.status)
            except sqlite3.DatabaseError as error:
                # LuveBot's own database (luvebot.db) could not be read or written: say so, never "Hermes is unavailable".
                _unexpected(request, self.path, error)
                # Never "nothing was changed": the database can fail on the result row, after the action ran.
                return _error('luvebot_db_unavailable', 'The LuveBot database (luvebot.db) is damaged or could not be read, so this action '
                              'may not have been recorded. Check Activity after it is recovered (scripts/backup_luvebot.py --check, with the '
                              'dashboard and the gateway stopped).', 503)
            except Exception as error:
                refusal = hermes_boundary.config_write_refusal(error)
                if refusal is not None:  # a write Hermes's config backend REFUSED (a key locked above, a value it cannot store, a failed write): our words, and the key for a lock, never "unavailable" and never its text
                    code, key = refusal
                    refused = HermesError(code)
                    return _error(code, refused.message, refused.status, {'details': {'key': key}} if key else None)
                # No exception text or traceback in browser responses or plugin logs: the CLASS and the route, for the operator.
                _unexpected(request, self.path, error)
                return _error('hermes_unreachable', 'Hermes is unavailable.', 503)
            finally:
                if bumped:
                    _EPOCH[0] += 1
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
        if session is None or not all(isinstance(value, str) and value for value in (session.user_id, session.provider, session.access_token)):   # a session whose fields are not text is nobody's
            raise HTTPException(status_code=401)
        actor = _REDACT(f'{session.provider}:{session.user_id}')
        credential = session.access_token
    else:
        # The native loopback gate has already verified this request.
        actor = 'dashboard'
        credential = request.headers.get('x-hermes-session-token', '')
        if not credential:
            raise HTTPException(status_code=401)
    mode = identity.mode_of(session.provider, session.user_id) if gated else 'loopback'   # `deployment`: everything that is not a person's login (Hermes main's deployment token, a provider not on the list), the machine (DT-1, DT-1b)
    identity.note_provider(_REDACT(session.provider) if mode == 'deployment' else None)   # so the refusal can name the provider (contract v0.11 5.1)
    return actor, credential, mode


async def _gate():
    """Invariant 9: None when the features may follow what the API Server reports, else why they are off ('isolation_host',
    'hermes_unsupported'). From the identity of the RUNNING Hermes and the isolation setting (hermes_compat), read in a worker
    thread and cached; never from a release date and never from a probe, so a slow /api/status cannot read as an old Hermes
    (blocker 2026-10-02) and an unreadable identity is `untested`, not a refusal."""
    return hermes_compat.gate(*await run_in_threadpool(hermes_compat.read))


def _scope_read():
    """ADR-006 D4, in a worker thread: every Bot's `luvebot` enablement, the launch profile and the sticky active one."""
    try:
        names = profile_names()
    except HermesError:
        names = []
    return hermes_compat.read_scope(names)


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
    try:  # v0.8 section 8: a person opened LuveBot (never resumes anything; never breaks the session read)
        from hermes_cli.web_server_profiles import get_process_hermes_home
        inactivity.seen(get_process_hermes_home() / 'luvebot/luvebot.db', actor)
    except Exception as error:
        logging.getLogger('luvebot.inactivity').warning('last seen not stored: %s', type(error).__name__)
    # Opaque per verified session, not a stored cookie or a reusable Hermes token.
    return {'csrf': _csrf_for(credential), 'actor': actor, 'auth_mode': mode}


_CHAINS = {}  # db path -> ChainProof: what the last pass proved, so /health checks only the rows added since


def _chain(path):
    return _CHAINS.setdefault(str(path), ChainProof())


async def _health_db():
    """(db view, path). The existing audited store owns its schema/writes; this router does not. The chain is checked from the last
    proof (the rows added since); the full pass from the first row is the background watcher's, every ChainProof.FULL_EVERY s."""
    try:
        from luvebot_backend.audit import AuditLog
        from hermes_cli.web_server_profiles import get_process_hermes_home
        db_path = get_process_hermes_home() / 'luvebot/luvebot.db'
        audit = await run_in_threadpool(AuditLog, db_path)
        proof = _chain(db_path)
        checked = await run_in_threadpool(proof.check, audit)
        try:  # ADR-008: 'wal', or 'delete' when WAL was refused (a network disk): the operator sees which one runs
            mode = await run_in_threadpool(audit.journal_mode)
        except Exception:
            mode = None
        return {'ok': checked['ok'] is True, 'schema_version': 1, 'chain': {'full_at': proof.full_at()}, 'journal_mode': mode}, db_path
    except Exception:
        return {'ok': False, 'schema_version': None}, None


async def _health_status():
    try:
        status = await asyncio.wait_for(guarded(get_status()), timeout=5)
        return status if isinstance(status, dict) else None
    except Exception:
        return None


async def _capabilities(name):
    """The capability probe of one profile, or the HermesError it raised (kept, handled in order by the caller). Remembered 15 s per Bot and shared
    by the calls that arrive together: it used to ask every API Server on every call, and one slow Bot held every /health up to 3 s."""
    try:
        return await _FLIGHT.run(('caps', name), _EPOCH[0], lambda: run_in_threadpool(capabilities_cached, name))
    except HermesError as error:
        return error


@router.get('/health')
async def health(request: Request, response: Response = None, bot: str = None):
    """`bot` probes one Bot's API Server only (what `profile` did before ADR-006 D2b took that name for the dashboard's selector)."""
    _identity(request)
    problems = []
    reachable = True
    t0 = time.perf_counter()
    if bot is not None:
        names = [validate_profile(bot)]     # an unknown Bot is 404 bot_not_found, as on every Bot route (SafeRoute only watches ?profile=)
    else:
        try:
            names = profile_names()
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
    identity, isolation = await run_in_threadpool(hermes_compat.read)
    refusal = hermes_compat.gate(identity, isolation)       # decided before the probes: it never depends on them
    profiles = {}
    if names is None:
        names = []
        reachable = False
    for name, capabilities in zip(names, probes):
        try:
            if isinstance(capabilities, HermesError):
                raise capabilities
            states = feature_states(capabilities, refusal is None)
            profiles[name] = {'reachable': True, 'features': states}
            for feature, state in states.items():
                if state != 'ok' and refusal is None:          # otherwise the Hermes problem below already says why
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
    scope_inputs = await run_in_threadpool(_scope_read)  # ADR-006 D4: plg3, launch profile, active profile, enablement per Bot
    hermes, hermes_problem = hermes_compat.describe(identity, isolation, hermes_compat.session_authority(
        [c for c in probes if not isinstance(c, HermesError)]), scope_inputs[0])
    if hermes_problem:
        problems.append(hermes_problem)
    scope = hermes_compat.plugin_scope(isolation, *scope_inputs)
    features = {feature: 'ok' if profiles and all(item['features'][feature] == 'ok' for item in profiles.values()) else 'unavailable'
                for feature in ('runs', 'session_chat_stream')}
    approvals = {item['features']['approvals'] for item in profiles.values()}
    features['approvals'] = 'ok' if approvals == {'ok'} else 'unavailable' if 'unavailable' in approvals or not approvals else 'unknown'
    # T10.3: approvals go through the LuveBot hook and Hermes's run approval, never the approval transport plugin hook.
    features['approval_transport'] = 'not_used'
    features['groups'] = await _groups_state()
    features['pages'] = pages.feature()  # v0.5 section 8
    features['skills'] = await run_in_threadpool(skills.feature)  # v0.6 Part A
    features.update(await run_in_threadpool(voice.features, voice.HermesAudio))  # v0.7 section 5 (invariant 9)
    features['reactions'] = 'ok' if await run_in_threadpool(reactions.capable) else 'unavailable'  # v0.8 section 4 (invariant 9)
    features['notifications'], push_status = await run_in_threadpool(_push_health, db_path)  # v0.8 section 6 (invariant 9); v0.11 section 7
    if push_status is not None and (push_problem := push.problem_of(push_status)) is not None:
        problems.append(push_problem)
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
    try:
        serving, serving_why = hermes_compat.serving(identity, request.app)
    except Exception:  # noqa: BLE001
        serving, serving_why = None, 'app_unreadable'
    if serving is False:  # this process ANSWERED, so it serves: a False here is the check being wrong, said out loud, and it is never reported as the truth
        problems.append({'code': 'watcher_misdetected', 'feature': 'watcher', 'message': 'LuveBot could not tell that this process serves it; the budget watcher runs here all the same.'})
        serving = None
    return {'ok': reachable and code_current is not False, 'plugin': {'version': '0.1.0', 'api': '0', 'db': db, 'code_current': code_current},
            'hermes': hermes, 'plugin_scope': scope,
            'watcher': {'serving': serving, 'reason': serving_why, 'lease': await run_in_threadpool(watcher_lease.view, db_path)},
            'sdk': {'version': '1.1.0', 'supported': refusal is None},
            'auth': {'required': bool(getattr(request.app.state, 'auth_required', False)), 'person_providers': person_providers()},   # names only (contract v0.11 5.1)
            'push': push_status, 'features': features, 'problems': problems}


def _push_health(db_path):
    """-> (the `features.notifications` word, the push status or None): `unavailable` without PyJWT or cryptography, `needs_subject` without a contact a push service takes, else `ok`. Best effort: /health
    never fails because of it."""
    if not push.capable():
        return 'unavailable', None
    subject, source = _push_subject()
    try:
        status = push.Push(db_path, subject=subject, source=source).status()
    except Exception:  # noqa: BLE001
        status = None
    return ('ok' if subject else 'needs_subject'), status


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
    checked, sources, pause, routine_results, paused, hook_view, waiting, surface = await asyncio.gather(
        _open_runs_checked(index, name),
        run_in_threadpool(bot_controls.recent_sources, name),
        run_in_threadpool(lambda: bot_controls.pause_state(path, name, consistent=False)),
        run_in_threadpool(_routine_results, path, name),
        run_in_threadpool(_paused_view, path, name),
        run_in_threadpool(_hook_view, path, name, True),
        run_in_threadpool(_waiting_view, path, name),
        run_in_threadpool(_approval_surface, path, name))
    surface_digest, hook_failed = hook_view.pop('surface_digest', None), hook_view.pop('read_failed', False)  # private to this pass: not part of `hook`
    approval_mode = surface['mode'] if surface else None
    try:  # absent, never a guess, when the surface or the hook could not be read
        approval_applied = None if (surface is None or hook_failed) else approval_surface.applied_from_view(surface, {**hook_view, 'surface_digest': surface_digest})
    except Exception:  # noqa: BLE001
        approval_applied = None
    if waiting is None:
        sources['status_partial'].append('waiting')
    if routine_results is None:
        sources['status_partial'].append('routine_results')
    if paused is None:
        sources['status_partial'].append('paused')
    return {**sources, 'pause_state': pause, 'unread': await run_in_threadpool(bot_controls.unread, path, name, routine_results),
            'paused': paused, 'open_runs': checked, 'hook': hook_view, 'waiting': waiting or [], 'approval_mode': approval_mode,
            'approval_applied': approval_applied}


def _approval_surface(path, name):
    """`{mode, digest}` of this Bot's approval surface (mode `luvebot` | `channel` | `free`: the chip "Livre"), from the same stored row GET .../approval-surface
    reads. None when it cannot be read: `approval_mode` and `approval_applied` are then absent from the Bot, never a guess (a row that does not verify already
    reads as `luvebot`, fail closed, in read_surface)."""
    try:
        surface = hook_store.read_surface(path, name)
        mode, digest = surface['mode'], surface['digest']
    except Exception:  # noqa: BLE001
        return None
    return {'mode': mode, 'digest': digest} if mode in hook_store.SURFACE_MODES else None


def _waiting_view(path, name):
    """The Bot's unresolved human-input waits (hook 0.5, F6-B), for the Bot status only. None when they cannot be read (listed in
    status_partial, never read as "nobody waits"); [] when the hook that writes them is not shipped yet (an older LuveBot)."""
    return waiting.read(path, name, _REDACT)


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


def _hook_view(path, name, private=False):
    """hook.status of ADR-003 section 5. Unreadable state is never presented as "live". With `private` (the Bot's own pass) it also carries two keys the
    caller removes: the surface digest the hook reports and whether the read failed (so `approval_applied` is absent, not "hook_not_live", when it could not
    be read). The hook route's answer never has them."""
    try:
        return hook.hook_state(path, name, with_surface=private)
    except Exception:
        absent = {'status': 'absent', 'version': None, 'heartbeat_age_s': None, 'table_digest': None}
        return {**absent, 'read_failed': True} if private else absent


async def _bot(name, info, display, baseline, index, path):
    probed, live = await asyncio.gather(run_in_threadpool(probe, name, baseline), _live(name, index, path))
    return bot_object(info, display, probed, live)


@router.get('/bots')
async def list_bots(request: Request, response: Response = None):
    _identity(request)
    # every open tab asks every 15 s: the ones that arrive while a read is running share it (a change in between starts a new one)
    return await _FLIGHT.run('bots', _EPOCH[0], lambda: _list_bots(response))


async def _list_bots(response):
    t0 = time.perf_counter()
    audit, meta = await run_in_threadpool(_stores)
    baseline = await _gate() is None
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
    baseline = await _gate() is None
    infos, display = await asyncio.gather(run_in_threadpool(profile_infos), run_in_threadpool(meta.get, name))
    info = next((i for i in infos if i['name'] == name), None)
    if info is None:
        raise HermesError('bot_not_found')
    index = await run_in_threadpool(RunIndex, meta.path)
    bot = await _bot(name, info, display, baseline, index, meta.path)
    if not extras:
        return _redact_deep(bot)

    shared = []  # the ONE read of the api_server's toolsets of this request: `can_ask` and `file_tools` both come from it, started by whichever of them misses its cache first

    async def toolsets():
        if not shared:
            shared.append(asyncio.ensure_future(guarded(run_in_threadpool(live_state.toolset_facts, name))))
        try:
            return await shared[0]
        except Exception:  # noqa: BLE001  (never raises today; if it did, both fields would be "not told", not a failed detail)
            return {'can_ask': None, 'file_tools': None}

    async def asking():  # ABSENT unless it can be told: a Bot with no `clarify` never asks a person, and the profile says so
        async def read():
            found = (await toolsets())['can_ask']
            if found is None:
                raise LookupError(name)  # not told: never remembered, the next read asks again
            return found
        try:
            return await _CAN_ASK.get(('can_ask', name), _EPOCH[0], read)
        except LookupError:
            return None

    async def files():  # contract v0.9 section 14: what the Bot can do with a file; a key ABSENT when it cannot be told, the whole object absent when no key can be
        async def read():
            found = (await toolsets())['file_tools']
            if found is not None and len(found) == len(live_state.FILE_TOOLS):
                return found
            error = LookupError(name)  # a partial or "not told" answer is shown but never remembered: the next read asks again
            error.value = found  # ...and it travels IN the exception: a request that joined this read (the Flight hands every joiner the same exception) shows what the first one shows
            raise error
        try:
            return await _FILE_TOOLS.get(('file_tools', name), _EPOCH[0], read)
        except LookupError as error:
            return getattr(error, 'value', None)
    details, answer, handled = await asyncio.gather(detail_extras(name), asking(), files())  # side by side: a hung api_server does not add its wait to the extras
    return _redact_deep({**bot, **details, **({'can_ask': answer} if isinstance(answer, bool) else {}), **({'file_tools': handled} if handled else {})})


@router.get('/bots/{bot}')
async def get_bot(bot: str, request: Request):
    _identity(request)
    name = validate_profile(bot)
    detail = await _one(name, extras=True)
    state = await run_in_threadpool(reactions.bot_sees, name)   # RX-1 (A-282): `reactions: {bot_sees}`, ABSENT when it cannot be told; the Bot list never carries it
    return {**detail, **({'reactions': state} if state is not None else {})}


@router.patch('/bots/{bot}/display')
async def patch_display(bot: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = validate_profile(bot)
    body = await _json_body(request)
    audit, meta = await run_in_threadpool(_stores)
    # an image is SET only when it exists and the writer owns it; the same one already stored is a no-op for anyone; a PATCH with no `avatar` never reads this (v0.11 2.2, A-163)
    changes = await run_in_threadpool(lambda: validate_display(body, owns=lambda value: avatars.Avatars(meta.path).owns(actor, value), current=meta.get(name)['avatar']))
    await run_in_threadpool(audit.act, actor, 'bot.display.update', name, {'kind': 'ui'}, lambda: meta.upsert(name, changes),
                            bot=name, payload=changes)
    return await _one(name)


@router.put('/bots/order')
async def put_bots_order(request: Request):
    """v0.8 section 9: the shared sidebar order, a permutation of every listed Bot (else 422), written in one transaction."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    order = validate_order(await _json_body(request), await _names())
    audit, meta = await run_in_threadpool(_stores)
    await run_in_threadpool(audit.act, actor, 'bot.order', None, {'kind': 'ui'}, lambda: meta.set_order(order), payload={'bots': order})
    return JSONResponse({'bots': order}, headers=_HEADERS)

@router.get('/me/display')
async def get_my_display(request: Request):
    """The face of the person viewing (Crie seu Luve B2): per actor of /session, so two logins have two faces."""
    actor, _credential, _mode = _identity(request)
    _audit, meta = await run_in_threadpool(_stores)
    return {'avatar': await run_in_threadpool(meta.person, actor)}


@router.patch('/me/display')
async def patch_my_display(request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    body = await _json_body(request)
    audit, meta = await run_in_threadpool(_stores)
    changes = await run_in_threadpool(lambda: validate_person(body, owns=lambda value: avatars.Avatars(meta.path).owns(actor, value), current=meta.person(actor)))
    avatar = await run_in_threadpool(audit.act, actor, 'me.display.set', None, {'kind': 'ui'},
                                     lambda: meta.set_person(actor, changes['avatar']), payload=changes)
    return {'avatar': avatar}


# ---- the images people wear as a face (contract v0.11 section 2.2; backend/avatars.py, backend/png_avatar.py) ----
@router.post('/avatars')
async def upload_avatar(request: Request):
    """The raw PNG as the body: `Content-Type: image/png`, the length checked before a byte is read and a chunked body stopped at 320 KiB, then re-encoded by LuveBot (a refusal is 422 `invalid_image`). Allowed in loopback:
    it loosens no control. The same owner sending the same pixels gets the existing id back (200, `replayed`)."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    if (request.headers.get('content-type') or '').split(';', 1)[0].strip().lower() != 'image/png':
        raise PluginError('unsupported_media', 'Send the image as image/png.', 415)
    declared = request.headers.get('content-length')
    if declared is not None:
        try:
            declared = int(declared)
        except ValueError:
            raise PluginError('bad_request', 'The Content-Length is not a number.', 400) from None
        if declared > png_avatar.READ_CAP:
            raise PluginError('too_large', 'An image is limited to 320 KiB.', 413)
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > png_avatar.READ_CAP:
            raise PluginError('too_large', 'An image is limited to 320 KiB.', 413)
    if declared is not None and len(data) != declared:
        raise PluginError('bad_request', 'The image arrived incomplete.', 400)
    audit, meta = await run_in_threadpool(_stores)
    replayed, answer = await run_in_threadpool(avatars.Avatars(meta.path).upload, audit, actor, bytes(data), 'req_' + uuid4().hex)
    return JSONResponse(answer, status_code=200 if replayed else 201, headers=_HEADERS)


@router.get('/avatars/{avatar_id}')
async def get_avatar(avatar_id: str, request: Request):
    """The stored bytes, behind the gate. The owner reads it always, anyone with a login only while a Bot wears it; anyone else gets 404 (never 403), and `If-None-Match` is looked at AFTER that rule."""
    actor, _credential, _mode = _identity(request)
    audit, meta = await run_in_threadpool(_stores)
    sha256, data = await run_in_threadpool(avatars.Avatars(meta.path).read, actor, avatar_id)
    headers = {'X-LuveBot-API': '0', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-cache', 'ETag': f'"{sha256}"'}
    if avatars.etag_matches(request.headers.get('if-none-match'), sha256):
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type='image/png', headers=headers)


@router.delete('/avatars/{avatar_id}')
async def delete_avatar(avatar_id: str, request: Request):
    """The owner only (404 for anyone else); 409 `avatar_in_use` while a Bot or a person wears it. Allowed in loopback: it loosens no control."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    audit, meta = await run_in_threadpool(_stores)
    return JSONResponse(await run_in_threadpool(avatars.Avatars(meta.path).delete, audit, actor, avatar_id, 'req_' + uuid4().hex), headers=_HEADERS)


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
    language = voice.language_value(body.pop('language')) if isinstance(body, dict) and 'language' in body else None  # VL-1: the screen's language, written as the Bot's voice language
    audit, meta = await run_in_threadpool(_stores)
    name, template, changes, model = await run_in_threadpool(lambda: validate_create(body, owns=lambda value: avatars.Avatars(meta.path).owns(actor, value)))   # a complete display SETS its face: it must be the writer's image
    display = initial_display(name, template, changes)
    await run_in_threadpool(audit.act, actor, 'bot.create', name, {'kind': 'ui'},
                            lambda: create_in_hermes(name, template, display, model, meta, soul, language), bot=name,
                            payload={**body, **({'soul_sha256': bot_controls.digest(soul)} if soul is not None else {}), **({'language': language} if language else {})})
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
    """By a person only: CSRF, audited before the effect. Loosening (turning `free` on: nothing is asked; turning `channel` on, or
    naming a new approver) is refused in loopback (D-012/D-014: the token names the machine, not a person); narrowing is allowed.
    `channel` is refused while the gateway lets every sender in (409 approval_surface_unsafe); `free` sends nothing to a chat."""
    actor, credential, mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing_bot(bot)
    new_mode, approvers = approval_surface.parse(await _json_body(request))
    audit, meta = await run_in_threadpool(_stores)
    current = await run_in_threadpool(hook_store.read_surface, meta.path, name)
    if approval_surface.loosens(current, new_mode, approvers):
        identity.require_person(mode, 'Loosening where approvals go needs a dashboard with a login; this one is in loopback mode.', loopback_ok=_loopback_trusted())

    def effect():
        if new_mode == 'channel':
            on, reason = approval_surface.allow_all(name)
            if on:
                raise PluginError('approval_surface_unsafe', 'The gateway lets every sender in, so approvals cannot go to a chat.', 409,
                                  {'details': {'reason': reason}})
        hook_store.put_surface(meta.path, name, new_mode, approvers, actor)
    # the audit log keeps only a digest of the payload: the mode goes in the reference too, so GET /bots/{bot}/free-passes can tell a
    # turn-on of `free` that was audited from a `free` row nobody audited (A2, `audited`)
    await run_in_threadpool(audit.act, actor, 'bot.approval_surface', name, {'kind': 'ui', 'ref': f'surface.{new_mode}.{uuid4().hex}'}, effect,
                            bot=name, payload={'from': current['mode'], 'mode': new_mode, 'approvers': approvers})
    # the hook reports a new setting within seconds: answer once it has (bounded), not "not applied" for one about to be
    return JSONResponse({'approval_surface': await run_in_threadpool(approval_surface.view_after_save, meta.path, name)}, headers=_HEADERS)


@router.get('/bots/{bot}/free-passes')
async def get_free_passes(bot: str, request: Request, limit: int = 50, before: float = None):
    """A2: what the Livre let through for this Bot, newest first (hermes-plugin 0.5.0). `audited` says whether a person's turn-on of the
    Livre is on the audit chain. Read only; the commands were redacted by the hook."""
    _identity(request)
    if not 1 <= limit <= 100 or (before is not None and not 0 < before < 1e12):
        raise PluginError('bad_request', 'Invalid paging parameters.', 400)
    name = await _existing_bot(bot)
    _audit, meta = await run_in_threadpool(_stores)
    page = await run_in_threadpool(lambda: free_pass.read(meta.path, name, limit=limit, before=before))
    return JSONResponse(_redact_deep(page), headers=_HEADERS)


# ---- D-007: the Bot's live screen (proposal docs/propostas/d007-aba-tela.md) -------------------------------------------
async def _screen_act(request, bot, action, effect, *, refuse_in_loopback=False, payload=None):
    """One audited screen effect by a person: CSRF, the intent before the effect, the result after (the ticket never enters the audit
    payload). Giving control back to the agent loosens, so in loopback it is refused (D-007 decision 1)."""
    actor, credential, mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing_bot(bot)
    if refuse_in_loopback:
        identity.require_person(mode, 'Giving control back needs a dashboard with a login; this one is in loopback mode.', loopback_ok=_loopback_trusted())
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
    reason = await run_in_threadpool(_REDACT, body.get('reason', '').strip())   # it reaches the audit and Hermes's public lease (off the loop: P-3b)
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
    identity.require_person(mode, 'Loosening the rules needs a dashboard with a login; this dashboard is in loopback mode.')
    raise PluginError('not_supported', 'LuveBot does not disable or remove the rules hook; do it in Hermes.', 405)


# ---------------------------------------------------------------------------
# Sessions and runs (contract section 5, no SSE). Proxy to /p/<bot>/... of the API Server; see backend/runs.py
# for the Hermes route behind each one.
# ---------------------------------------------------------------------------
MAX_RUN_BODY = 256 * 1024


def _clean(value, depth=0):
    """Text that came from Hermes passes the redactor; shapes are bounded (contract 6.3 spirit)."""
    if isinstance(value, str):
        return _REDACT(value[:100_000])
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
    run.update(canonical.run_extras(payload, _REDACT))  # F4: execution_generation, pending_controls, resolution (only a canonical Hermes sends them)
    return run


async def _require_feature(name, feature):
    """409 capability_missing (section 5) unless the profile's API Server reports the feature; offline is left to the call.
    Each cause says its own thing: a Hermes LuveBot must not run on (`plugins.isolation: host`, or proven older than the baseline)
    says why and, only for the old one, "update Hermes"; an identity that cannot be read is not a refusal (the probe decides); an
    API Server that answered wrongly (a wrong key: 401) is hermes_error."""
    refusal = await _gate()
    caps, offline, failure = await run_in_threadpool(lambda: probe(name, refusal is None, with_failure=True))
    if offline or caps.get(feature):
        return
    if refusal:
        raise PluginError('capability_missing', hermes_compat.MESSAGES[refusal], 409, {'feature': feature, 'reason': refusal})
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


def _new_session(name):
    """A conversation made for a first message sent in the same request: the same Hermes call as POST /sessions, no title (v0.9 section 10)."""
    status, payload = ApiClient(name).call('POST', '/api/sessions', {})
    if status != 201 or not payload or not isinstance(payload.get('session'), dict):
        raise upstream_error(status, on_404=_NO_404)
    session_id = safe_id(payload['session'].get('id'))
    if session_id is None:
        raise HermesError('hermes_error')
    return session_id


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

    new_session = fields['session_id'] is None  # v0.9 section 10: no session given = the server makes the conversation (never in place of a given one)

    def effect():
        def gates():
            hook.hook_gate(meta.path, name)  # D-015 B-3: no new work where the rules hook is not live
            budget_gate(budget, meta.path, name)  # invariant 7: no new run for a paused or capped Bot
        session_id = session_start.for_run(index, name, fields['idempotency_key'], fields['session_id'], gates, lambda: _new_session(name))
        headers = {'Idempotency-Key': fields['idempotency_key']} if fields['idempotency_key'] else {}

        def start(text):
            body = {**{k: fields[k] for k in ('input', 'instructions') if fields[k] is not None}, 'input': text, 'session_id': session_id}
            status, payload, code = ApiClient(name).call_coded('POST', '/v1/runs', body, headers=headers)
            if canonical.is_queued(status, code):
                return None, None, session_id  # Hermes accepted it and queued it for the next owner: no run to track, and it must never be sent again
            if status not in (200, 202) or not payload:
                raise canonical.refusal(status, code, 'create') or upstream_error(
                    status, on_404=_NO_404, on_409=('duplicate', 'This idempotency key was already used with a different request.', 409))
            run_id = safe_id(payload.get('run_id'))
            if run_id is None:
                raise HermesError('hermes_error')
            state = contract_status(payload.get('status'))[0]
            index.add(run_id, name, session_id, actor, state if state != 'unknown' else 'started', index.prompt_digest(fields['input']))   # the digest of what the person wrote, never of the notes
            return run_id, state, session_id
        return _announced(name, session_id, fields['input'], start, audit, actor, new_session)

    created = await run_in_threadpool(audit.act, actor, 'run.create', fields['session_id'], {'kind': 'ui'}, effect,
                                      bot=name, payload={**fields, 'session_created': True} if new_session else fields)
    run_id, state, session_id = created
    if run_id is None:  # queued by Hermes: a SUCCESS body (never an error envelope), audited ok; a session made here is named, or the person cannot find it
        return JSONResponse({**canonical.queued_body(), **({'session_id': session_id} if new_session else {})}, status_code=202, headers=_HEADERS)
    approvals_native.start_watcher(meta.path, name, run_id, _REDACT)  # captures approval requests with no browser attached (A-19)
    return JSONResponse({'run': {'id': run_id, 'status': state, 'bot': name, 'session_id': session_id}},
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
    status, payload, code = ApiClient(name).call_coded('POST', f'/v1/runs/{run_id}/stop', {})
    if status != 200 or not payload:
        raise canonical.refusal(status, code, 'run') or upstream_error(status, on_404=_RUN_404, on_409=('conflict', 'This run is no longer active.', 409))
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
_REDACT = lambda text: redaction.isolated_redact(text)   # P-3: Hermes's redactor, in a child with a deadline when the text is long; the only way the plugin reaches it


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
        except (Exception, SystemExit):  # Hermes's config outage is a SystemExit on purpose, and any exit in a thread is ignored in silence: the stream says so instead of waiting for nothing
            loop.call_soon_threadsafe(push, ('error', None))

    threading.Thread(target=reader, daemon=True).start()  # not the shared pool: a stream lives for minutes
    masks = tool_masks.stream()   # what a tool returned is for a mask to say: one state per stream (the ids it has seen)
    window = redaction.Window()   # P-3b: the frames of THIS stream share a budget of redactor time (renewed every WINDOW_S); a frame is not a request and nothing opened one for it
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
            with window.open():
                frame = await run_in_threadpool(sse_proxy.transform, surface, parsed[0], parsed[1], _REDACT)   # off the loop: a hostile frame costs its deadline, not the panel
            if frame is None:
                continue
            event, data = frame
            data = tool_masks.mask_frame(masks, event, data)
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
    return await _chat_turn(actor, name, session_id, fields, audit, meta)


@router.post('/bots/{bot}/chat/stream')
async def chat_stream_new(bot: str, request: Request):
    """v0.9 section 10 B: the first message of a conversation that does not exist yet. The per-session route's body WITHOUT `session_id` (an
    unknown key is 400), its CSRF, capability and gates; the session is made after the gates and audited on its own (`session.create`,
    `via: chat`, because `chat.send` is written only once a session exists); the first frame names it."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = validate_profile(bot)
    fields = validate_chat_body(await _json_body(request, MAX_RUN_BODY))
    await _require_feature(name, 'session_chat_stream')
    audit, meta = await run_in_threadpool(_stores)
    if fields['page']:
        fields['input'] = await run_in_threadpool(_page_note, request, actor, name, meta, fields['page']) + '\n\n' + fields['input']
    index = await run_in_threadpool(RunIndex, meta.path)
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)

    def effect():
        def gates():
            hook.hook_gate(meta.path, name)
            budget_gate(budget, meta.path, name)

        def owns(session_id):  # the first attempt's session is named in the 409 only while it is still this Bot's
            try:
                bot_controls.owned_session(name, session_id)
                return True
            except Exception:  # noqa: BLE001
                return False
        return session_start.for_chat(index, fields['client_message_id'], gates, lambda: _new_session(name), owns)

    session_id = await run_in_threadpool(audit.act, actor, 'session.create', None, {'kind': 'ui'}, effect, bot=name, payload={'via': 'chat'})
    return await _chat_turn(actor, name, session_id, fields, audit, meta, queued_extra={'session_id': session_id})


def _resume_tip(name, session_id):
    """The resume tip of a conversation (a mark made on a compressed one lives under it), or None: telling the Bot of a reaction never fails a send."""
    try:
        return bot_controls.owned_session(name, session_id)
    except Exception:  # noqa: BLE001
        return None


def _announced(name, session_id, text, send, audit, actor, new_session):
    """RX-1 (A-280, A-283): `send(text)` of a turn, with what the person reacted since the last one told to the Bot first (backend/reactions.py). At module level, in a thread: the redactor does not run on the loop."""
    return reactions.with_announcements(name, session_id, text, send, audit, actor, _REDACT, tip=None if new_session else (lambda: _resume_tip(name, session_id)))


async def _chat_turn(actor, name, session_id, fields, audit, meta, queued_extra=None):
    """One conversation turn: the send route's path, also taken by a call's delegation (v0.7 3.3), so both get the same gates."""
    index = await run_in_threadpool(RunIndex, meta.path)
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)
    await run_in_threadpool(_refresh_hint, name, audit, actor)
    cid = fields['client_message_id']
    await run_in_threadpool(canonical.check_session_channel, name, session_id)  # F4 B-8: with a session authority, another channel's session is refused in words

    def effect():
        hook.hook_gate(meta.path, name)  # D-015 B-3 (also for a chat turn)
        budget_gate(budget, meta.path, name)  # a chat turn starts a run: invariant 7 applies
        if cid and not index.claim_message(cid, name, session_id):
            raise PluginError('duplicate', 'This message was already sent.', 409)
        return _announced(name, session_id, fields['input'], lambda text: canonical.open_turn(
            index, cid,
            lambda: ApiClient(name).open_stream('POST', f'/api/sessions/{session_id}/chat/stream', {'message': text}, coded=True),
            lambda status, code: canonical.refusal(status, code, 'chat') or upstream_error(
                status, on_404=('session_not_found', 'Session not found.', 404), on_409=('conflict', 'This session is busy with another turn.', 409))),
            audit, actor, False)

    upstream = await run_in_threadpool(audit.act, actor, 'chat.send', session_id, {'kind': 'ui'}, effect, bot=name, payload=fields)
    if upstream is None:  # queued by Hermes: a success body, not a stream and not an error
        return JSONResponse({**canonical.queued_body(), **(queued_extra or {})}, status_code=202, headers=_HEADERS)
    return _sse(_relay(upstream, 'chat', name, index, actor, {'session_id': session_id}, sha=await run_in_threadpool(index.prompt_digest, fields['input'])))


@router.post('/bots/{bot}/threads')
async def create_thread(bot: str, request: Request):
    """v0.8 section 4: a NEW conversation of the same Bot linked to one message (never Hermes's fork, which ends the source). The
    quote comes from Hermes by (session, message id), not from the body; the answer is the send route's stream, whose first
    frame names the new session."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    parent, message_id, fields = threads.validate(await _json_body(request, MAX_RUN_BODY))
    await _require_feature(name, 'session_chat_stream')
    audit, meta = await run_in_threadpool(_stores)
    intro = (await run_in_threadpool(meta.introduction, name)).get('intro_session_id')
    fields['input'] = await run_in_threadpool(threads.quote, name, parent, message_id, _REDACT, intro_session=intro) + '\n\n' + fields['input']
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)

    def effect():
        hook.hook_gate(meta.path, name)  # the same gates as a send, BEFORE a session exists: a refusal leaves nothing behind
        budget_gate(budget, meta.path, name)
        status, payload = ApiClient(name).call('POST', '/api/sessions', {})
        if status != 201 or not payload or not isinstance(payload.get('session'), dict):
            raise upstream_error(status, on_404=_NO_404)
        child = safe_id(payload['session'].get('id'))
        if child is None:
            raise HermesError('hermes_error')
        threads.record(meta.path, name, child, parent, message_id, actor)  # linked before the turn: an orphan stays a hidden thread
        return child

    child = await run_in_threadpool(audit.act, actor, 'thread.create', parent, {'kind': 'ui'}, effect, bot=name,
                                    payload={'parent_session': parent, 'message_id': message_id, 'input_sha256': bot_controls.digest(fields['input'])})
    return await _chat_turn(actor, name, child, fields, audit, meta)


async def _react_route(request, bot, sid, mid, emoji, *, clear):
    """v0.8 section 4: a person's mark on a message, kept by Hermes (always author "user"; who reacted is in our audit). Checks first
    and in this order, none of which writes: CSRF, Bot, session id, the closed emoji list (404), the message id (409 not saved),
    Hermes's capability (409)."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    if safe_id(sid) is None:
        raise PluginError('session_not_found', 'Session not found.', 404)
    emoji = reactions.check_emoji(emoji)
    row = reactions.row_id(mid)
    await run_in_threadpool(reactions.need_capability)
    tip = await run_in_threadpool(bot_controls.owned_session, name, sid)
    audit, _meta = await run_in_threadpool(_stores)
    body = await run_in_threadpool(reactions.react, name, sid, row, emoji, clear, audit, actor, _REDACT, tip=tip)
    return JSONResponse(body, headers=_HEADERS)


@router.put('/bots/{bot}/sessions/{sid}/messages/{mid}/reactions/{emoji}')
async def put_reaction(bot: str, sid: str, mid: str, emoji: str, request: Request):
    return await _react_route(request, bot, sid, mid, emoji, clear=False)


@router.delete('/bots/{bot}/sessions/{sid}/messages/{mid}/reactions/{emoji}')
async def delete_reaction(bot: str, sid: str, mid: str, emoji: str, request: Request):
    return await _react_route(request, bot, sid, mid, emoji, clear=True)


@router.get('/bots/{bot}/sessions/{sid}/threads')
async def list_session_threads(bot: str, sid: str, request: Request):
    _identity(request)
    name = await _existing(bot)
    if safe_id(sid) is None:
        raise PluginError('session_not_found', 'Session not found.', 404)
    tip = await run_in_threadpool(bot_controls.owned_session, name, sid)
    audit, meta = await run_in_threadpool(_stores)
    found, truncated = await run_in_threadpool(threads.listing, meta.path, name, list(dict.fromkeys((sid, tip))), _REDACT)
    return JSONResponse({'threads': found, 'truncated': truncated}, headers=_HEADERS)


# ---------------------------------------------------------------------------
# Approvals (contract v0.1 sections 1, 2 and 6). The three resolvers below are the ONLY routes that answer Hermes (H1).
# ---------------------------------------------------------------------------
def _loopback_trusted():
    """The installation chose to trust a loopback dashboard with what needs a person (A-15). It never opens a deployment credential."""
    return os.environ.get('LUVEBOT_ALLOW_LOOPBACK_APPROVALS') == '1'


def _human(request):
    """The signed-in person behind this request, as the engine's typed Actor (RT 4: never taken from the request content).
    401 without a session, 403 csrf_required, and in loopback 403 loopback_not_human unless the installation opted in
    (D-012, A-15): the loopback token identifies the machine, not a person."""
    actor, credential, mode = _identity(request)
    _require_csrf(request, credential)
    identity.require_person(mode, 'Deciding an approval needs a dashboard with a login; this dashboard is in loopback mode.', loopback_ok=_loopback_trusted())
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
    nonce = secrets.token_hex(8)  # the tag that rides in the steer: a steer Hermes hands back as a NEW user turn is tied to THIS send by it (b3 r54)
    text = approvals_native.deny_steer_text(reason, nonce)  # a FIXED frame and the person's own (redacted) words (Lume, b3 B2)

    def effect():
        try:
            after = approvals_native.steer_watermark(row['bot'], row['run_id'])  # BEFORE sending: its proof must come after this
        except Exception:
            after = None  # no watermark, no proof: it can only ever settle as unknown
        try:
            accepted = approvals_native.steer_reason(row['bot'], row['run_id'], text)
        except HermesError:
            accepted = False
        approvals.set_reason_steer(path, row['request_id'], 'accepted' if accepted else 'refused', after=after, nonce=nonce)
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
    return {'approvals': await run_in_threadpool(_with_page_diffs, items), 'next_cursor': nxt}


def _with_page_diffs(items):
    """21a: a PENDING approval that would overwrite a whole page (`proposal.kind` whole) carries `diff`: the page now (redacted) against the
    proposal, plain unified text. Computed at read time from the file on disk, so the person sees their own newer lines being removed. Never fails the list."""
    for item in items:
        proposal = item.get('proposal')
        if item.get('status') != 'pending' or not item.get('page') or not proposal or proposal['kind'] != 'whole' or proposal['truncated']:
            continue  # a proposal cut at 64 KiB would show its missing tail as deleted lines: no diff, the card says "sem prévia completa"
        try:
            now = pages.current_text(item['bot'], item['page']['slug'])
            item['diff'] = pages_review.diff(None if now is None else _REDACT(now), proposal['content'])
        except Exception as error:  # noqa: BLE001
            logging.getLogger('luvebot.pages').warning('page diff not made: %s', type(error).__name__)  # the class only
    return items


@router.get('/suggestions')
async def list_suggestions(request: Request):
    """v0.8 section 5: rule suggestions from LuveBot's own approvals, each with a DRAFT preview; nothing is saved or applied."""
    _identity(request)
    _audit, meta = await run_in_threadpool(_stores)
    names = set(await _names())
    items = [s for s in await run_in_threadpool(suggestions.rule_suggestions, meta.path) if s['bot'] in names]
    return JSONResponse(_redact_deep({'suggestions': items}), headers=_HEADERS)


@router.post('/suggestions/dismiss')
async def dismiss_suggestion(request: Request):
    """"Ignorar": hides that action class of that Bot for 30 days. Showing fewer suggestions loosens nothing."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    bot, action_class = suggestions.validate_dismiss(await _json_body(request))
    name = await _existing(bot)
    audit, meta = await run_in_threadpool(_stores)
    return JSONResponse(await run_in_threadpool(suggestions.dismiss, audit, actor, meta.path, name, action_class), headers=_HEADERS)


@router.post('/approvals/batch')
async def resolve_approvals_batch(request: Request):
    human = _human(request)
    items = approvals.validate_batch(await _json_body(request))
    audit, meta = await run_in_threadpool(_stores)

    def prevalidate():  # every item, before anything is sent: one stale item stops the whole batch (contract section 2)
        rows = [approvals.check_pending(meta.path, i['request_id'], i['digest'], choice=i.get('choice')) for i in items]
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


async def _need_authority(name):
    """The canonical controls exist only where Hermes runs a session authority (`features.run_unknown_resolution`)."""
    if not await run_in_threadpool(canonical.authority, name):
        raise PluginError('capability_missing', 'This Hermes does not run the session controls this action needs; update Hermes.', 409,
                          {'feature': canonical.FLAG})


async def _settle_run(index, name, run_id):
    """Re-read the run after a human action and keep the index in step. -> the run's public status."""
    payload = await run_in_threadpool(canonical.read_run, name, run_id)
    raw = payload.get('status')
    if isinstance(raw, str):
        await run_in_threadpool(index.set_status, run_id, raw[:64])
    return contract_status(raw)[0]


@router.post('/bots/{bot}/runs/{run_id}/resolve-unknown')
async def resolve_unknown_run(bot: str, run_id: str, request: Request):
    """F4 B3: the person confirms the run Hermes lost track of is over. Human only (403 in loopback), audited, the generation they saw."""
    human = _human(request)
    audit, meta = await run_in_threadpool(_stores)
    index = await run_in_threadpool(RunIndex, meta.path)
    name = await _owned_run(bot, run_id, index)
    await _require_feature(name, 'runs')
    await _need_authority(name)
    fields = canonical.validate_unknown_body(await _json_body(request))
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)
    await run_in_threadpool(audit.act, human.id, 'run.resolve_unknown', run_id, {'kind': 'ui'},
                            lambda: canonical.resolve_unknown(name, run_id, fields['execution_generation'],
                                                              gate=lambda: budget_gate(budget, meta.path, name)),  # frees queued turns: new work (invariant 7)
                            bot=name, payload={'execution_generation': fields['execution_generation']})
    return JSONResponse({'run': {'id': run_id, 'status': await _settle_run(index, name, run_id)}}, status_code=200, headers=_HEADERS)


@router.post('/bots/{bot}/runs/{run_id}/clarify')
async def answer_run_clarify(bot: str, run_id: str, request: Request):
    """F4 B-5/B-6: the person answers a question the Bot asked. Human only (the Bot uses clarify as a soft confirmation, so the answer can
    stand for an approval), validated against the question's own choices, audited as a keyed digest and a length, never the text."""
    human = _human(request)
    audit, meta = await run_in_threadpool(_stores)
    index = await run_in_threadpool(RunIndex, meta.path)
    name = await _owned_run(bot, run_id, index)
    await _require_feature(name, 'runs')
    await _need_authority(name)
    fields = canonical.validate_clarify_body(await _json_body(request, canonical.MAX_ANSWER * 6 + 4096))
    if fields['skip']:   # a skip is a click: the audit says so, with no text, no digest and no length (there is none)
        payload = {'request_id': fields['request_id'], 'execution_generation': fields['execution_generation'], 'skipped': True}
    else:
        digest = await run_in_threadpool(index.keyed_digest, fields['answer'].encode('utf-8'))
        payload = {'request_id': fields['request_id'], 'execution_generation': fields['execution_generation'], 'answer_hmac': digest, 'answer_len': len(fields['answer'])}
    await run_in_threadpool(audit.act, human.id, 'run.clarify', run_id, {'kind': 'ui'},
                            lambda: canonical.answer_clarify(name, run_id, fields['request_id'], fields['execution_generation'], fields['answer'], skip=fields['skip']),
                            bot=name, payload=payload)
    return JSONResponse({'clarify': {'request_id': fields['request_id'], 'status': 'resolved'}}, status_code=200, headers=_HEADERS)


@router.post('/bots/{bot}/sessions/{session_id}/fork')
async def fork_session(bot: str, session_id: str, request: Request):
    """F4 B-7: continue a conversation of another channel in a COPY. Hermes ends the original as `branched` (a side effect on a conversation
    that is not ours), so this exists only behind a person with a login (`_human`: 403 loopback_not_human in loopback, as the other
    actions that loosen), is audited with the origin's kind, and is never called by anything else."""
    human = _human(request)
    name = validate_profile(bot)
    if safe_id(session_id) is None:
        raise PluginError('session_not_found', 'Session not found.', 404)
    title = canonical.validate_fork_body(await _json_body(request))
    source = await run_in_threadpool(canonical.session_source, name, session_id)
    if source is None:
        raise PluginError('session_not_found', 'Session not found.', 404)
    audit, meta = await run_in_threadpool(_stores)
    session = await run_in_threadpool(audit.act, human.id, 'session.fork', session_id, {'kind': 'ui'}, lambda: canonical.fork(name, session_id, title),
                                      bot=name, payload={'origin_source': source if re.fullmatch(r'[a-z0-9_-]{1,32}', source) else 'other'})
    return JSONResponse({'session': session}, status_code=201, headers=_HEADERS)


# ---------------------------------------------------------------------------
# Rules (contract v0.1 section 3, ADR-002 sections 4, 7, 8). Seals are computed here from the LIVE state at every read.
# ---------------------------------------------------------------------------
_BROKEN_STATE = rules.SealResult(rules.Seal.BROKEN, (), (rules.Problem('no_mechanism', 'the live state of this Bot could not be read'),), ())


async def _bot_names():
    return [i['name'] for i in await run_in_threadpool(profile_infos)]


async def _read_state(path, name):
    """-> (LiveState, toolset_tools, mcp_server_tools) or None when Hermes cannot be read for this Bot."""
    try:
        status = await guarded(get_status(profile=name))
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
    return {'rule': rules_store.api_dict(rule), 'seal_result': rules_service.seal_to_dict(_seal_of(path, rule, trusted, states, targets))}


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
    """The signed-in person, for rule steps that keep the v0 loopback convention (create, review, edit, archive). A deployment credential is never a person, in any step (DT-1)."""
    actor, credential, mode = _identity(request)
    _require_csrf(request, credential)
    identity.require_person(mode, '', loopback_ok=True)   # loopback keeps its v0 convention here; the deployment credential never gets a human Actor
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
    return JSONResponse({'rule': rules_store.api_dict(rule), 'seal_result': rules_service.seal_to_dict(rules.SealResult(rules.Seal.NONE, (), (), ()))},
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
        given = {'path': [v for k, v in action.facts if rules.path_op(k) == 'eq'],  # the facts the screen gave: lexical, not the turn's own
                 'recipient': [v for k, v in action.facts if rules.fact_name(k) == 'recipient']}
        verdict = (rules.hook_verdict(table, tool=action.tool, command=action.command, facts={k: v for k, v in given.items() if v} or None)
                   if table is not None else None)
        # F6.3: what Hermes's own gate would do with this shell command (the rules above only prove LuveBot's half)
        gate = hermes_gate.dry_run(action.bot, action.command, state.terminal_backend, redact=_REDACT, approvals_mode=state.approvals.mode) if hermes_gate.applies(action.tool, action.command) else None
        return sim, verdict, gate

    sim, verdict, gate = await run_in_threadpool(work)
    expected = {rules.Level.ASK: 'approve', rules.Level.HANDBACK: 'block', rules.Level.BLOCK: 'block'}.get(sim.decision.effect, 'none')
    hook_info = None if verdict is None else {'action': verdict.action, 'rule_id': verdict.rule_id, 'message': verdict.message, 'strict': verdict.strict}
    return {'decision': rules_service.decision_to_dict(sim.decision), 'seals': {rid: rules_service.seal_to_dict(r) for rid, r in sim.seals},
            'effective_mechanisms': [m.value for m in sim.effective_mechanisms], 'hook': hook_info,
            'hook_agrees': None if verdict is None else verdict.action == expected, 'hermes_gate': gate,
            'action': {'bot': action.bot, 'tool': action.tool, 'toolset': action.toolset, 'mcp_server': action.mcp_server},
            'caveats': [c for c, on in (('paths_lexical', any(rules.path_op(k) for k, _ in action.facts)),  # "simulado sem a pasta do turno"
                                        ('recipients_lexical', any(rules.fact_name(k) == 'recipient' for k, _ in action.facts))) if on]}


def hook_store_read(path, bot):
    from luvebot_backend import hook_store
    return hook_store.read_table(path, bot)


# ---------------------------------------------------------------------------
# Phase 4 (contract v0.2): costs and caps, the budget executor and the cost watcher, routines, activity.
# ---------------------------------------------------------------------------
_WATCH_EVERY = float(os.environ.get('LUVEBOT_WATCH_EVERY', '30'))
_OUTAGE_LOGGED, _OUTAGE_EVERY_S = {}, 600.0   # a Hermes config outage in a pass: class name -> when it was last logged (monotonic); one line per class per 10 minutes
_LEASES = {}  # one watcher lease per database file, this process's view of it (ADR-010)
_cron = hermes_cron.HermesCron()


class _BotRuns:
    """The executor's view of a Bot's runs: which are open, and a stop that counts only when Hermes says the run ended (S08)."""

    def __init__(self, path):
        self.index = RunIndex(path)

    def open(self, bot):
        return [r['run_id'] for r in self.index.open_runs(bot, stoppable=True)]  # a run Hermes lost cannot be stopped: it waits for a person

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
            executor.handle(decision)


def _lease_for(path):
    key = str(path)
    if key not in _LEASES:
        _LEASES[key] = watcher_lease.Lease(path)  # its kind is set on every tick, with the proof of the moment
        atexit.register(_LEASES[key].release)     # a clean exit gives it up at once (a crash is the 90 s expiry)
    return _LEASES[key]


def _watch_pass():
    """The work of one pass (what only the owner of the lease does). A failure of a step that has no try of its own ends the pass: the caller gives the lease up."""
    audit, meta = _stores()
    budget, executor = _budget_parts(audit, meta)
    names = [i['name'] for i in profile_infos()]
    start = costs.period_start('month', budget._now()) - 86400
    result = cost_watcher.run_pass(budget, names, lambda bot: hermes_cron.sessions_for_cost(bot, start))
    for decision in result['decisions']:
        executor.handle(decision)
    if result['decisions']:
        _EPOCH[0] += 1  # the watcher changed something (a pause): the shared reads must not outlive it
    _evaluate_budget(budget, executor, names)
    _notify_new_pauses(audit, meta.path, budget)  # v0.8 6: a Bot paused by its cap wakes the person's devices
    _notify_new_waits(audit, meta.path, names)  # v0.11 7.6: a Bot that waits for a person outside the browser wakes the devices that asked for `question`
    try:  # v0.7 3.4: lost calls are billed with the watcher; on its own, so a failure here skips no other step
        voice.sweep(audit, budget, voice.Calls(meta.path))
    except Exception as error:
        logging.getLogger('luvebot.voice').warning('voice sweep failed: %s', type(error).__name__)  # the class only
    try:  # v0.8 section 8: routines paused after X days with nobody opening LuveBot; on its own, so no other step skips
        if inactivity.check(meta.path, audit, names, _cron):
            _EPOCH[0] += 1  # routines were paused: the shared reads must not outlive it
    except Exception as error:
        logging.getLogger('luvebot.inactivity').warning('inactivity check failed: %s', type(error).__name__)  # the class only
    handoffs.ingest(meta.path, audit, names, hermes_cron.kanban_handoff_tasks)  # S09: not on a GET
    handoffs.sync(meta.path, audit, hermes_cron.kanban_task)
    try:  # the audit chain's full pass (from the first row), when due: GET /health checks only what was added since its last proof
        _chain(meta.path).watch(audit)
    except Exception as error:
        logging.getLogger('luvebot.audit').warning('audit chain pass failed: %s', type(error).__name__)  # the class only
    try:  # D-007: a lease Hermes gave back on its own is audited too; on its own, so no other step of the pass can skip it
        if bot_screen.Screen(meta.path).viewers():
            bot_screen.Screen(meta.path).reconcile(audit)
    except Exception as error:
        logging.getLogger('luvebot.screen').warning('screen reconcile failed: %s', type(error).__name__)  # the class only
    return result['heartbeat']  # False when a session read failed: no heartbeat, and the tick then gives the lease up


def _note_outage(error):
    """One line per class per 10 minutes, never one per pass: the class only, never the text or the exit code."""
    name, now = type(error).__name__, time.monotonic()
    if now - _OUTAGE_LOGGED.get(name, -_OUTAGE_EVERY_S) >= _OUTAGE_EVERY_S:
        _OUTAGE_LOGGED[name] = now
        why = 'the Hermes configuration service did not answer' if hermes_boundary.is_config_unavailable(error) else 'Hermes stopped the pass'
        logging.getLogger('luvebot.budget').warning('budget pass skipped: %s (%s)', why, name)


def _background_tick():
    """One tick of the watcher: `watcher.hold`, then the check "does this process serve" (r44), then the lease (ADR-010), then the pass. Never raises. A paused Bot is re-applied by
    `_evaluate_budget` (its plan comes back while it stays paused)."""
    try:
        from hermes_cli.web_server_profiles import get_process_hermes_home
        home = get_process_hermes_home()
        if (home / 'luvebot/watcher.hold').exists():  # maintenance (and a test seam): no pass, so no heartbeat, and the
            return                                    # database is not even opened; the Budget fails closed
        try:
            serving = hermes_compat.serving(hermes_compat.read()[0], hermes_compat.read_app())[0]
        except Exception:  # noqa: BLE001  (a check that cannot be made is "unknown": the watcher runs, it never takes the pass down)
            serving = None
        if serving is False and not _SERVED[0]:  # POSITIVELY not a process that serves LuveBot (it only imported the dashboard, and no request reached it): no pass, no heartbeat, the database is not opened
            return
        try:
            lease = _lease_for(home / 'luvebot/luvebot.db')
            lease.set_kind(watcher_lease.kind_of(hermes_compat.read_app(), serving is True or _SERVED[0]))  # read NOW, 'dashboard' only with proof that this process serves
        except Exception:  # noqa: BLE001
            lease = None
        if lease is not None and not lease.enter():  # another process holds a fresh lease (an unreadable one lets this one run: it fails toward the cap)
            return
        passed = False
        try:
            passed = _watch_pass() is not False  # a pass with no heartbeat (a session read failed) did not finish well: it gives the lease up, so a healthy process can take over
        finally:
            if lease is not None:
                if passed:
                    lease.renew()    # a pass that FINISHED keeps the lease
                else:
                    lease.release()  # one that threw gives it up: a broken owner must not keep the other out
    except Exception as error:  # a failed pass sends no heartbeat, so the Budget fails closed on its own after watcher_max_age
        logging.getLogger('luvebot.budget').warning('budget tick failed: %s', type(error).__name__)  # the class only: never the text
    except SystemExit as error:  # Hermes's config outage is a SystemExit on purpose, and a plain exit in this thread would end it for good: ONE failed pass either way (no heartbeat, the lease already given up by the `finally` above), the loop goes on. Any other BaseException is not ours to swallow
        _note_outage(error)


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
    if raises:
        identity.require_person(mode, 'Raising a cap or resuming a Bot needs a dashboard with a login; this one is in loopback mode.', loopback_ok=_loopback_trusted())
    return actor


async def _names():
    return [i['name'] for i in await run_in_threadpool(profile_infos)]


async def _need_cron():
    ok, _missing = hermes_cron.available()
    if not ok:
        raise PluginError('capability_missing', 'This Hermes does not provide the cron helpers this feature needs; update Hermes.', 409)


async def _need_suggestions(route='list'):
    ok, _missing = hermes_cron.suggestions_available(route)
    if not ok:
        raise PluginError('capability_missing', 'This Hermes does not provide the suggestion helpers this feature needs; update Hermes.', 409)


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
    voice_rows = [r for r in await run_in_threadpool(lambda: voice.Calls(meta.path).spend_since(start)) if r[0] in names]
    totals, groups = costs.add_voice(totals, groups, voice_rows, group=group, tz=budget.tz)  # v0.7 4.4: the "voz" line
    age = snapshot['watcher']['age_s']
    projection = await run_in_threadpool(budget.projection)  # v0.8 section 7: the month to its end; a number, never an action
    by_bot = {name: await run_in_threadpool(budget.projection, name) for name in names}
    return JSONResponse({'period': period, 'currency': 'USD', 'totals': totals, 'groups': groups,
                         'projection': projection, 'projection_by_bot': by_bot,
                         'ledger': {'lag_s': age if age is not None else None, 'watcher_stale': snapshot['watcher']['stale']}},
                        headers=_HEADERS)


@router.get('/costs/quota')
async def get_costs_quota(request: Request, bot: str = None):
    """F6.1: the plan quota Hermes reports per provider. Information only: it never gates a run and never fails the Costs screen (200 always)."""
    _identity(request)
    names = [validate_profile(bot)] if bot else await _names()  # an unknown Bot is 404 bot_not_found
    results = await asyncio.gather(*(run_in_threadpool(plan_quota.get, name) for name in names))  # in parallel: each may wait
    return JSONResponse(plan_quota.combine(results), headers=_HEADERS)


def _snapshot_view(snapshot, executor):
    watcher = snapshot['watcher']
    last = datetime.fromisoformat(watcher['last_at']).timestamp() if watcher['last_at'] else None
    return {'limits': [{**item, 'percent': item['percent'] if item['percent'] is not None else 100.0} for item in snapshot['limits']],
            'paused': [{'bot': bot, 'since': executor.since(bot), 'plan_status': executor.plan_status(bot)} for bot in snapshot['paused']],
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
    template = (await run_in_threadpool(routines.templates, meta.path)).get(job.get('id'))
    return routines.view(bot, job, cap=cap, spend_cents=spend.get(job.get('id'), 0), redact=_REDACT, template=template)


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
    marks = await run_in_threadpool(routines.templates, meta.path)
    items, partial = [], []
    for name in names:
        try:
            for job in await _jobs_of(name):
                items.append(routines.view(name, job, cap=_cap_of(snapshot['limits'], job.get('id')), spend_cents=spend.get(job.get('id'), 0), redact=_REDACT,
                                           template=marks.get(job.get('id'))))
        except Exception:
            partial.append(name)
    if state:
        items = [i for i in items if i['state'] == state]
    items.sort(key=lambda i: (i['bot'], i['name'] or '', i['id']))
    chunk, nxt = routines.page(items, limit, cursor)
    return JSONResponse(_redact_deep({'routines': chunk, 'next_cursor': nxt, **({'partial': partial} if partial else {})}), headers=_HEADERS)


def _pending_suggestions(name):
    """One Bot's pending records, read in a worker: a record LuveBot already made a routine from (its `suggestion_accepts` row) is marked accepted in Hermes now and left out (the setter failed at accept)."""
    records = hermes_cron.list_suggestions(name)
    if not hermes_cron.suggestions_available('accept')[0]:
        return records
    audit, meta = _stores()
    return routine_suggestions.repaired(audit, meta.path, name, records, hermes_cron)


@router.get('/routine-suggestions')
async def list_routine_suggestions(request: Request):
    """Contract v0.10 2.1: what Hermes proposes, per Bot (at most 5 each, oldest first), shaped and bounded as plain text, with the verdict `supported` computed by LuveBot's own rules. LuveBot never
    creates a suggestion. `partial` names the Bots whose file could not be read, never a guess."""
    _identity(request)
    await _need_suggestions()
    items, partial = [], []
    for name in await _names():
        try:
            records = await _SUGGESTIONS.get(('routine-suggestions', name), _EPOCH[0], lambda name=name: run_in_threadpool(_pending_suggestions, name))
        except Exception:
            partial.append(name)
            continue
        items.extend(await run_in_threadpool(routine_suggestions.items_of, name, records, _REDACT))
    return JSONResponse(_redact_deep({'items': items, 'partial': partial}), headers=_HEADERS)


@router.post('/bots/{bot}/routine-suggestions/{suggestion_id}/accept')
async def accept_routine_suggestion(bot: str, suggestion_id: str, request: Request):
    """Contract v0.10 2.1: a routine made from a suggestion Hermes proposed, by LuveBot's own create path, PAUSED unless the person asks to start it and the gates of resuming a routine allow it.
    A person with a login (a schedule written by a model is not a request that cannot tell a person from the machine)."""
    actor = _human(request).id
    start = routine_suggestions.start_of(await _json_body(request))
    name = validate_profile(bot)
    if name not in await _names():
        raise HermesError('bot_not_found')
    await _need_suggestions('accept')
    audit, meta = await run_in_threadpool(_stores)
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)

    def start_job(job_id):
        if is_paused(meta.path, name):  # invariant 7: starting a routine must not undo the pause
            raise PluginError('bot_paused', 'This Bot is paused by its budget; only a person can resume it.', 409)
        _start_gate(budget, meta.path, name, job_id)
        return _cron.resume(name, job_id)
    result = await run_in_threadpool(routine_suggestions.accept, audit, meta.path, actor, name, suggestion_id, start, hermes_cron, _cron, start_job)
    job = result['job']
    fresh = await run_in_threadpool(_cron.get, name, job['id'])
    body = {'routine': await _routine_view(name, fresh or job), 'suggestion_id': suggestion_id, 'started': result['started'],
            **({'held': result['held']} if result['held'] else {}), **({'replayed': True} if result['replayed'] else {})}
    return JSONResponse(_redact_deep(body), status_code=201, headers=_HEADERS)


@router.post('/bots/{bot}/routine-suggestions/{suggestion_id}/dismiss')
async def dismiss_routine_suggestion(bot: str, suggestion_id: str, request: Request):
    """A tightening (it creates nothing and latches the `dedup_key` in Hermes): session and CSRF, no login needed."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = validate_profile(bot)
    if name not in await _names():
        raise HermesError('bot_not_found')
    await _need_suggestions('dismiss')
    audit, _meta = await run_in_threadpool(_stores)
    await run_in_threadpool(routine_suggestions.dismiss, audit, actor, name, suggestion_id, hermes_cron)
    return JSONResponse({'dismissed': True}, headers=_HEADERS)


@router.get('/routines/{job_id}')
async def get_routine(job_id: str, request: Request):
    _identity(request)
    await _need_cron()
    bot, job = await _locate(job_id)
    detail = await run_in_threadpool(routines.detail, job, _REDACT)
    return JSONResponse(_redact_deep({'routine': await _routine_view(bot, job), 'detail': detail}), headers=_HEADERS)


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
        threading.Thread(target=lambda: _quiet(hermes_boundary.convert(hermes_cron.fire), bot, job['id']), name='luvebot-routine-test', daemon=True).start()
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


@router.get('/settings/inactivity-pause')
async def get_inactivity_pause(request: Request):
    _identity(request)
    _audit, meta = await run_in_threadpool(_stores)
    return JSONResponse(await run_in_threadpool(inactivity.status, meta.path), headers=_HEADERS)


@router.put('/settings/inactivity-pause')
async def put_inactivity_pause(request: Request):
    """v0.8 section 8. ON or shorter tightens (allowed in loopback); OFF or longer lets routines run unattended for longer: a
    person with a login (403 loopback_not_human)."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    days = inactivity.validate(await _json_body(request))
    audit, meta = await run_in_threadpool(_stores)
    if inactivity.loosens(await run_in_threadpool(inactivity.days_set, meta.path), days):
        _human(request)
    return JSONResponse(await run_in_threadpool(inactivity.set_days, audit, actor, meta.path, days), headers=_HEADERS)


@router.post('/routines/inactivity-resume')
async def resume_after_inactivity(request: Request):
    """The banner's "Retomar": a person resumes only the routines the inactivity pause paused. Never automatic."""
    actor = _human(request).id
    await _need_cron()
    audit, meta = await run_in_threadpool(_stores)
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)
    done = await run_in_threadpool(inactivity.resume, audit, actor, meta.path, await _names(), _cron,
                                   lambda bot: _start_gate(budget, meta.path, bot))  # invariant 7: the single resume's gate, per Bot
    return JSONResponse({'resumed': done['resumed'], **({'held': done['held']} if done['held'] else {})}, headers=_HEADERS)


@router.post('/routines')
async def create_routine(request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    bot, fields, start, template = routines.validate_create(await _json_body(request))
    name = validate_profile(bot)
    if name not in await _names():
        raise HermesError('bot_not_found')
    await _need_cron()
    audit, meta = await run_in_threadpool(_stores)

    fields.setdefault('prompt', '')

    def effect():
        if start:
            _start_gate(Budget(meta.path, audit=audit), meta.path, name)  # S02: an active routine is work that will start
        job = _cron.create(name, **fields, paused=not start, **({} if start else {'paused_reason': 'Created paused; awaiting operator approval.'}))
        if template:  # v0.8 section 3: only which seal to compute; what is enforced is the job's own enabled_toolsets
            routines.mark_template(meta.path, job.get('id'), template)
        return job
    job = await run_in_threadpool(audit.act, actor, 'routine.create', None, {'kind': 'ui'}, effect, bot=name,
                                  payload={'keys': sorted(fields), 'start': start, **({'template': template} if template else {})})
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


async def _activity_of(name, path, routines_since, tasks, due):
    """-> (items, partial) of ONE Bot: runs from our index, routine runs and due routines from Hermes, Kanban tasks, and what it waits on a person for."""
    items, partial, now = [], set(), time.time()
    try:
        index = await run_in_threadpool(RunIndex, path)  # opens SQLite: never on the event loop
        rows = await run_in_threadpool(index._exec, 'SELECT run_id, bot, session_id, started_at, last_status, prompt_sha, ended_at FROM run_index '
                                       'WHERE bot=? ORDER BY started_at DESC LIMIT 200', (name,), fetch=True)
        try:  # v0.2 section 2: titled by what the person typed, read from Hermes's own session store, never stored by us
            prompts = await run_in_threadpool(hermes_cron.user_prompts, name, sorted({r['session_id'] for r in rows if r['session_id']}),
                                              index.prompt_digest)
        except Exception:
            prompts = {}
            partial.add('run_titles')
        run_items = [activity.run_item(dict(r), _iso_epoch, prompts) for r in rows]
        items += run_items
    except Exception:
        run_items = []
        partial.add('runs')
    try:
        for session in await run_in_threadpool(hermes_cron.cron_sessions, name, routines_since):
            items.append(activity.routine_run_item(name, session, now))
        if due:
            for job in await _jobs_of(name):
                if job.get('enabled') and job.get('state') == 'scheduled' and job.get('next_run_at'):
                    items.append(activity.due_item(name, job))
    except Exception:
        partial.add('routines')
    if tasks:
        try:
            items += [activity.task_item(t) for t in await run_in_threadpool(hermes_cron.kanban_tasks, name)]
        except Exception:
            partial.add('tasks')
    waits = await run_in_threadpool(waiting.read, path, name, _REDACT)  # F6-B: what the Bot waits on a person for
    if waits is None:
        partial.add('waiting')
    else:
        items += activity.decorate(run_items, name, waits)  # a wait of an open run of ours decorates it; the rest are their own items
    return items, partial


async def _activity_items(names, meta, routines_since, *, tasks=True, due=True):
    """The /activity items of these Bots and the sources that could not be read. Shared by /activity and the Timeline (v0.8 section 2), so both show
    the same items. The Bots are read TOGETHER (four at a time; they were read one after the other, seven round trips to the thread pool each), and
    one Bot's answer is kept 3 s, until something changes, so the Today screen's second call (the done tab) is free."""
    slots = asyncio.Semaphore(4)

    async def one(name):
        key = ('activity', name, int(routines_since // 60), tasks, due)  # the window start moves with the clock: a minute is the same window
        async with slots:
            return await _ACTIVITY.get(key, _EPOCH[0], lambda: _activity_of(name, meta.path, routines_since, tasks, due))
    items, partial = [], set()
    for bot_items, bot_partial in await asyncio.gather(*(one(n) for n in names)):
        items += [dict(item) for item in bot_items]  # the memory is shared: a caller gets its own items (the readers only filter and sort them; the decoration is done before they are kept)
        partial |= bot_partial
    return items, partial


@router.get('/activity')
async def get_activity(request: Request, tab: str, bot: str = None, origin: str = None, status: str = None, since: float = None,
                       until: float = None, min_cost_cents: int = None, limit: int = 50, cursor: str = None):
    _identity(request)
    if not 1 <= limit <= 100:
        raise PluginError('bad_request', 'Invalid paging parameters.', 400)
    names = [validate_profile(bot)] if bot else await _names()
    audit, meta = await run_in_threadpool(_stores)
    items, partial = await _activity_items(names, meta, time.time() - 7 * 86400)
    page, nxt = activity.build(items, tab=tab, bot=None if bot is None else validate_profile(bot), origin=origin, status=status,
                               since=since, until=until, min_cost_cents=min_cost_cents, limit=limit, cursor=cursor)
    return JSONResponse(_redact_deep({'items': page, 'next_cursor': nxt, **({'partial': sorted(partial)} if partial else {})}), headers=_HEADERS)


@router.get('/waiting')
async def get_waiting(request: Request, bot: str = None):
    """F6-B: what each Bot waits on a PERSON for (a question, a sudo password, an approval outside the inbox), newest first. Read-only; the
    chip, Today and the push poll it. A Bot whose rows cannot be read is listed in `partial`, never as "nobody waits"."""
    _identity(request)
    names = [validate_profile(bot)] if bot else await _names()
    audit, meta = await run_in_threadpool(_stores)
    slots = asyncio.Semaphore(4)  # each read opens the Bot's SessionDB: four at a time

    async def one(name):
        async def read():
            found = await run_in_threadpool(waiting.read, meta.path, name, _REDACT)
            if found is None:
                raise LookupError(name)  # unreadable: never remembered (the next poll tries again)
            return found
        async with slots:
            seen = await run_in_threadpool(waiting.marker, meta.path, name)  # the hook is another process: a wait it wrote moves this number, not the epoch
            try:
                return [dict(item) for item in await _WAITING.get(('waiting', name, seen if seen is not None else ('clock', int(time.monotonic() // 3))), _EPOCH[0], read)]  # shared: a caller gets its own items
            except LookupError:
                return None
    results = await asyncio.gather(*(one(name) for name in names))
    items = [{'bot': name, **item} for name, found in zip(names, results) for item in found or ()]
    items.sort(key=lambda i: (-i['since'], i['bot'], i['request_id']))
    return JSONResponse(_redact_deep({'waiting': items, 'partial': [name for name, found in zip(names, results) if found is None]}), headers=_HEADERS)


@router.get('/activity/timeline')
async def get_timeline(request: Request, since: float = None, until: float = None, bot: str = None):
    """v0.8 section 2: lanes of runs and routine runs per Bot, approval diamonds and handoff lines in a window of at most 7 days."""
    _identity(request)
    since, until = timeline.window(since, until, time.time())
    names = [validate_profile(bot)] if bot else await _names()
    audit, meta = await run_in_threadpool(_stores)
    items, partial = await _activity_items(names, meta, min(since, time.time() - 7 * 86400), tasks=False, due=False)
    view = {'lanes': timeline.lanes(items, since, until),
            'approvals': await run_in_threadpool(timeline.approvals, meta.path, since, until, names),
            'handoffs': await run_in_threadpool(timeline.handoffs, meta.path, since, until, names), 'partial': sorted(partial)}
    return JSONResponse(_redact_deep(view), headers=_HEADERS)


@router.get('/activity/heatmap')
async def get_heatmap(request: Request, days: int = 28, tz: str = 'UTC'):
    """v0.8 section 2: run starts and routine run starts per Bot and hour of the day, in the person's time zone."""
    _identity(request)
    days, zone = timeline.heatmap_args(days, tz)
    names = await _names()
    audit, meta = await run_in_threadpool(_stores)
    now = time.time()
    index = await run_in_threadpool(RunIndex, meta.path)  # opens SQLite: never on the event loop
    rows = await run_in_threadpool(index._exec, 'SELECT bot, started_at FROM run_index WHERE started_at >= ?',
                                   (datetime.fromtimestamp(now - days * 86400, timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),), fetch=True)
    starts = [(r['bot'], _iso_epoch(r['started_at'])) for r in rows if r['bot'] in names]
    partial = []
    for name in names:
        try:
            starts += [(name, s['started_at']) for s in await run_in_threadpool(hermes_cron.cron_sessions, name, now - days * 86400)]
        except Exception:
            partial.append(name)
    view = timeline.heatmap(starts, names, days, zone, now)
    return JSONResponse({**view, **({'partial': partial} if partial else {})}, headers=_HEADERS)


# ---- activity item actions (contract v0.2 section 2): audited, CSRF, and a stop is confirmed by what Hermes says afterwards ----
async def _activity_target(item_id, meta):
    """-> (kind, native, bot). A run item belongs to the Bot in our index; a task to its assignee."""
    kind, native = activity.parse_id(item_id)
    if kind == 'run':
        index = await run_in_threadpool(RunIndex, meta.path)
        rows = await run_in_threadpool(index._exec, 'SELECT bot FROM run_index WHERE run_id=?', (native,), fetch=True)
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
        index = await run_in_threadpool(RunIndex, meta.path)
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


def _search_fetch(limit):
    return max(limit, 100) if tool_masks.drops_rows() else limit   # Hermes cuts at `limit` BEFORE a mask drops its rows: ask for its ceiling (100) and cut after, so a row that is dropped does not count and the number of hits says nothing about it


def _search_hits(name, rows, limit=None):
    shown = [r for r in rows if not tool_masks.drop_row(r)]   # a row a mask refuses is dropped BEFORE it is redacted: Hermes indexes the results of the tools, and even a hit would be an oracle on a text the panel hides
    return [search.hit(name, r, _REDACT) for r in shown[:limit]]


def _session_views(rows, intro):
    return [bot_controls.session_view(r, _REDACT, intro) for r in rows]


def _soul_writer(name, content, digest):
    return lambda: bot_controls.update_soul(name, content, digest, _REDACT)


def _file_reader(name, path):
    return lambda: pages.read_workspace_file(name, path, _REDACT)


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


_ROOM_PAGES = 30   # pages of 100 groups looked at when a refusal has to be told from a missing room: 3,000 rooms, far beyond what one install makes


async def _room_listed(room_id):
    """Whether Hermes lists this room (disbanded ones too): the groups.list read that tells a room that is not there from a refusal that is real. Only ever called on the error path."""
    offset = 0
    for _ in range(_ROOM_PAGES):
        try:
            page = await _room_call('groups.list', {'include_disbanded': True, 'limit': 100, 'offset': offset})
        except PluginError as error:
            if error.code in ('invalid_field', 'room_not_found'):  # the second read is refused too: nothing is known, and the request is never blamed
                raise HermesError('hermes_error') from None
            raise
        if any(isinstance(item, dict) and item.get('room_id') == room_id for item in page.get('rooms') or []):
            return True
        offset = page.get('next_offset')
        if not isinstance(offset, int) or isinstance(offset, bool):
            return False
    return False


async def _room_state(room_id):
    """The state of ONE room. When Hermes REFUSES the read (v0.22.5 answers an unknown room with a 404, `main` with a 422 `invalid_field`, which blames a request that is right: the id passed `rooms.valid_id`),
    the error path asks Hermes's own list of groups: an id that is not in it is a room that is not there (404 `room_not_found`), an id that is in it is a refusal that is real (502 `hermes_error`): never
    the 422 and never a guess. The happy path makes no second call."""
    if not rooms.valid_id(room_id):
        raise PluginError('room_not_found', 'Room not found.', 404)
    try:
        return await _room_call('groups.state', {'room_id': room_id})
    except PluginError as error:
        if error.code not in ('invalid_field', 'room_not_found'):
            raise
    if await _room_listed(room_id):
        raise HermesError('hermes_error')
    raise PluginError('room_not_found', 'Room not found.', 404)


def _room_view(room, meta_row, driver=None, open_tasks=0):
    return {'id': room.get('room_id'), 'name': room.get('name'), 'members': rooms.members_view(room), 'created_at': room.get('created_at'),
            'disbanded_at': room.get('disbanded_at'), 'next_seq': room.get('next_seq'), **meta_row,
            'driver': rooms.driver_view(driver),
            'open_tasks': open_tasks}


def _open_handoffs(path, room_id):
    return handoffs.open_counts(path, [room_id]).get(room_id, 0)


@router.get('/rooms')
async def list_rooms(request: Request, include_disbanded: bool = False, limit: int = 50, cursor: str = None):
    _identity(request)
    if not 1 <= limit <= 100 or (cursor is not None and not re.fullmatch(r'[0-9]{1,9}', cursor)):
        raise PluginError('bad_request', 'Invalid paging parameters.', 400)
    await _need_rooms()
    result = await _room_call('groups.list', {'include_disbanded': include_disbanded, 'limit': limit, 'offset': int(cursor or 0)})
    audit, meta = await run_in_threadpool(_stores)
    ids = [r.get('room_id') for r in result.get('rooms') or []]
    metas, counts = await asyncio.gather(run_in_threadpool(rooms.metas, meta.path, ids), run_in_threadpool(handoffs.open_counts, meta.path, ids))  # one query each
    empty = {'goal': None, 'owner': None, 'coordinator': None}
    items = [_room_view(r, metas.get(r.get('room_id'), empty), None, counts.get(r.get('room_id'), 0)) for r in result.get('rooms') or []]
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
    state = await _room_state(room_id)
    result = await _room_call('groups.log', {'room_id': room_id, 'since_seq': since_seq, 'limit': limit})
    events = [e for e in result.get('events') or [] if isinstance(e, dict)]
    _audit, meta = await run_in_threadpool(_stores)
    sends = await run_in_threadpool(room_files.recorded, meta.path, room_id, [e.get('event_id') for e in events if e.get('kind') == 'message.user'])
    events = room_files.annotate(events, rooms.members_view(state['room']), sends)  # v0.6 9.1 step 6 and 9.2: chips and card author
    return JSONResponse(_redact_deep({'events': events, 'cursor': result.get('cursor'), 'latest_seq': result.get('latest_seq'),
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


async def _checked_send(audit, meta, actor, room_id, state, text, event_id, thread_id, confirm, *, kickoff=False, files=()):
    """One checked send. With files (contract v0.6, 9.1), everything is refused BEFORE any copy: the files (once each), the caps,
    the recipients (from the person's text alone), their gates, the cost confirmation and every recipient's workspace."""
    room = state['room']
    members = rooms.members_view(room)
    row = await run_in_threadpool(rooms.get_meta, meta.path, room_id)
    digest = {'text_len': len(text or ''), 'event_id': event_id, **({'files': len(files)} if files else {})}
    items, roots = [], {}
    try:
        targets, stored = rooms.check_send(text, members, row.get('coordinator'))
        if files:
            items = await run_in_threadpool(room_files.checked, list(files))
            room_files.check_fanout(items, targets)
        await _gate_targets(audit, meta, targets)  # a Bot that may not start work never receives a file either
        if rooms.needs_confirmation(targets) and not confirm:
            details = rooms.cost_details(targets)
            if items:
                details['disk_bytes'] = room_files.disk_bytes(items, targets)
            raise PluginError('cost_confirmation_required', 'This message wakes several Bots and costs a round for each; confirm to send.', 409,
                              {'details': details})
        final = stored
        if items:
            roots = await run_in_threadpool(room_files.workspaces, targets)
            final = room_files.final_text(stored, items)
            again, _ = rooms.check_send(final, members, row.get('coordinator'))   # belt and braces: the file lines wake no one
            if [t['handle'] for t in again] != [t['handle'] for t in targets]:
                raise PluginError('internal_error', 'The file lines changed who would receive this message; nothing was sent.', 500)
    except PluginError as error:
        await _refused(audit, actor, room_id, error, **digest)
    digests = []
    if items:
        index = await run_in_threadpool(RunIndex, meta.path)
        digests = [index.keyed_digest(item['data']) for item in items]
    ref = 'req_' + uuid4().hex

    def effect():
        if items:  # a copy that fails stops here: the copies already written stay (each audited) and no text is sent (A-91)
            room_files.copy_all(audit, actor, items, roots, digests, ref)
        params = {'room_id': room_id, 'event_id': event_id, 'payload': {'text': final, 'thread_id': thread_id or 'luvebot-main'}}  # Hermes requires a thread id
        sent = rooms_rpc.call('groups.send', params)
        if items:  # keyed by Hermes's own id of the event (gateway/hosted_rooms.py user_event_id: 'user:' + sha256 of ours)
            stored_id = ((sent or {}).get('event') or {}).get('event_id') or 'user:' + hashlib.sha256(event_id.encode()).hexdigest()
            room_files.record(meta.path, room_id, stored_id, room_files.view(items, roots))
        return sent
    payload = {'room': room_id, 'event_id': event_id, 'targets': [t['handle'] for t in targets], 'text_len': len(final), 'kickoff': kickoff,
               'text_sha256': hashlib.sha256(final.encode()).hexdigest(),
               **({'attachments': {'count': len(items), 'hmac': digests}} if items else {})}
    result = await run_in_threadpool(audit.act, actor, 'room.send', room_id, {'kind': 'ui', 'ref': ref}, effect, payload=payload)
    return {'event': _redact_deep(result.get('event')), 'targets': [t['handle'] for t in targets], 'accepted': bool(result.get('accepted', True)),
            'text': final, **({'attachments': room_files.view(items, roots)} if items else {})}


async def _room_multipart(request):
    """9.1 step 1: the fields of a JSON send plus up to 5 `file` parts. The body is capped before it is parsed (CSRF was checked
    before this is called, so the parser never runs without it)."""
    try:
        length = int(request.headers.get('content-length', ''))
    except ValueError:
        raise PluginError('length_required', 'Send the files with a Content-Length.', 411) from None
    if length > room_files.BODY_MAX:
        raise PluginError('too_large', 'The files of one message are limited to 25 MiB together.', 413)
    try:
        form = await request.form(max_files=room_files.FILES_MAX + 1, max_fields=4)
    except AssertionError:  # python-multipart missing: Hermes's own uploads would fail the same way
        raise PluginError('capability_missing', 'This Hermes cannot receive files.', 409, {'feature': 'attachments'}) from None
    except Exception:
        raise PluginError('bad_request', 'Send the message fields and up to 5 files as multipart.', 400) from None
    fields, files = {}, []
    try:
        for key, value in form.multi_items():
            if key == 'file' and hasattr(value, 'read'):
                files.append((value.filename, await value.read(pages.DOC_MAX + 1)))
            elif key in ('text', 'event_id', 'thread_id', 'confirm_cost') and isinstance(value, str) and key not in fields:
                fields[key] = value
            else:
                raise PluginError('bad_request', 'Send the message fields and up to 5 files as multipart.', 400)
    finally:
        await form.close()  # the spooled temp files go now, not at garbage collection
    if 'confirm_cost' in fields:
        if fields['confirm_cost'] not in ('true', 'false'):
            raise PluginError('invalid_field', 'Invalid value for confirm_cost.', 422)
        fields['confirm_cost'] = fields['confirm_cost'] == 'true'
    return fields, files


@router.post('/rooms/{room_id}/messages')
async def send_room_message(room_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)  # before the body: a multipart body is never parsed without it
    files = []
    if request.headers.get('content-type', '').lower().startswith('multipart/form-data'):
        body, files = await _room_multipart(request)
    else:
        body = await _json_body(request, 80 * 1024)
    text, event_id, thread_id, confirm = rooms.validate_message(body)
    await _need_rooms()
    state = await _room_state(room_id)
    audit, meta = await run_in_threadpool(_stores)
    out = await _checked_send(audit, meta, actor, room_id, state, text, event_id, thread_id, confirm, files=files)
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
def _handoff_live(row, task):
    return handoffs.live_view(row, task, _REDACT)


async def _handoff_view(path, row):
    """What the handoff is NOW: the stored row plus the Kanban task's state. A GET shows it; only the audited watcher
    (`handoffs.sync`) persists a transition (S09)."""
    task = await run_in_threadpool(_quiet_none, hermes_cron.kanban_task, row['task_id'])
    return await run_in_threadpool(_handoff_live, row, task)


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
                rows = await asyncio.wait_for(run_in_threadpool(hermes_cron.sessions_search, name, query, _search_fetch(limit), 'rooms' in chosen), timeout=2)
                return await run_in_threadpool(_search_hits, name, rows, limit)
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
    side = await run_in_threadpool(threads.hidden, meta.path, name)  # v0.8 section 4: a thread opens from its message, not from the list
    rows, next_cursor = await run_in_threadpool(lambda: threads.sessions_page(name, side, limit=limit, offset=offset, source=source, q=q))
    sessions = await run_in_threadpool(_session_views, rows, intro)
    return JSONResponse({'sessions': sessions, 'next_cursor': next_cursor}, headers=_HEADERS)


@router.get('/bots/{bot}/sessions/{sid}/messages')
async def list_session_messages(bot: str, sid: str, request: Request, limit: int = 100, before: str = None):
    actor, _credential, _mode = _identity(request)
    name = await _existing(bot)
    if safe_id(sid) is None:
        raise PluginError('session_not_found', 'Session not found.', 404)
    if not 1 <= limit <= 100:
        raise PluginError('bad_request', 'Invalid history limit.', 400)
    audit, meta = await run_in_threadpool(_stores)
    intro = (await run_in_threadpool(meta.introduction, name)).get('intro_session_id')
    return JSONResponse(await run_in_threadpool(bot_controls.messages, name, sid, limit, before, _REDACT, intro, meta.path, actor), headers=_HEADERS)


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
        for run in index.open_runs(name, stoppable=True):
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
                            _soul_writer(name, content, body['expected_digest']), bot=name,
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


@router.get('/bots/{bot}/pages/review')
async def pages_review_state(bot: str, request: Request):
    """21a: the "Revisar antes de salvar" switch, derived from the ACTIVE rule of the exact shape the screen makes (ask, write_file + patch, path under
    workspace:pages). Read only; turning it off is archiving that rule, a human-only change like any other. The seal says what it covers (file tools only,
    and `hook_outdated` while the hook is older than 0.6.0). Registered before the page-by-slug routes: `review` is not a page."""
    _identity(request)
    name = await _existing(bot)
    _audit, meta = await run_in_threadpool(_stores)
    rule = pages_review.find_review_rule(await run_in_threadpool(rules_service.effective_rules, meta.path, name), name)
    if rule is None:
        return JSONResponse({'enabled': False, 'rule_id': None, 'scope': None, 'seal': None}, headers=_HEADERS)
    states = await _states(meta.path, [name])
    seal = rules_service.seal_to_dict(_seal_of(meta.path, rule, True, states, [name]))
    return JSONResponse({'enabled': True, 'rule_id': rule.id, 'scope': pages_review.scope_of(rule), 'seal': seal}, headers=_HEADERS)


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
async def file_download(bot: str, path: str, request: Request, purpose: str | None = None):
    """T12: a file of the Bot's workspace as an attachment, never rendered (backend/pages.py read_workspace_file has the rules).
    A read, but audited (file.download, target = sha256 of the path, never the path) because it hands a file to the browser.
    v0.6 A-82: `purpose=view` (the in-app viewer) is the same response, audited as file.view."""
    actor, _credential, _mode = _identity(request)
    action = pages.file_action(purpose)
    name = await _existing(bot)
    audit, _meta = await run_in_threadpool(_stores)
    filename, data = await run_in_threadpool(audit.act, actor, action, hashlib.sha256(path.encode('utf-8', 'replace')).hexdigest(),
                                             {'kind': 'ui'}, _file_reader(name, path), bot=name)
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
        raise PluginError('capability_missing', 'This Hermes cannot receive files.', 409, {'feature': 'attachments'}) from None
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


async def _need_model():
    ok, _missing = bot_model.available()
    if not ok:
        raise PluginError('capability_missing', 'This Hermes does not provide the model helpers this feature needs; update Hermes.', 409)


@router.get('/bots/{bot}/model')
async def get_bot_model(bot: str, request: Request):
    """Contract v0.11 1.2: the Bot's model as Hermes says it ({provider, model, context_length}, null for what is not set)."""
    _identity(request)
    name = await _existing(bot)
    await _need_model()
    info = await _MODEL_INFO.get(('model', name), _EPOCH[0], lambda: run_in_threadpool(bot_model.read_info, name))
    return JSONResponse(_redact_deep(info), headers=_HEADERS)


@router.get('/bots/{bot}/model/options')
async def get_bot_model_options(bot: str, request: Request):
    """What the person may pick from: Hermes's providers and models, normalized, without `custom`, `local`, `nous` and any provider that needs an endpoint or a key. Read when the picker opens."""
    _identity(request)
    name = await _existing(bot)
    await _need_model()
    options = await _MODEL_OPTIONS.get(('model-options', name), _EPOCH[0], lambda: bot_model.read_options(name))
    return JSONResponse(_redact_deep(options), headers=_HEADERS)


@router.post('/bots/{bot}/model')
async def set_bot_model(bot: str, request: Request):
    """Contract v0.11 1.2: change the Bot's model through Hermes's own handler, scope `main`, the profile always this Bot. The body is exactly {provider, model, expected, confirm_expensive?}; the choice must be in the
    options LuveBot fetches itself now; audited first; allowed in loopback (it loosens nothing: the spend stays under the cap) and for a Bot the cap paused (a cheaper model is the remedy)."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    provider, model, expected_provider, expected_model, confirm = bot_model.validate_body(await _json_body(request))
    await _need_model()
    audit, _meta = await run_in_threadpool(_stores)
    async with _MODEL_LOCKS.setdefault(name, asyncio.Lock()):
        bot_model.check_choice(await bot_model.read_options_raw(name), provider, model)
        before = await run_in_threadpool(bot_model.read_info, name)
        bot_model.check_expected(before, expected_provider, expected_model)
        result = await run_in_threadpool(bot_model.change, audit, actor, name, provider, model, confirm, before, _REDACT, 'req_' + uuid4().hex)
    return JSONResponse(_redact_deep(result), headers=_HEADERS)


@router.put('/bots/{bot}/approval-timeout')
async def put_approval_timeout(bot: str, request: Request):
    """Contract v0.6 10.1: how long this Bot waits for a person (backend/bot_controls.py set_approval_timeout). Longer is not
    loosening (silence still denies): allowed in loopback too (A-92)."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    seconds = bot_controls.validate_approval_timeout(await _json_body(request))
    audit, _meta = await run_in_threadpool(_stores)
    result = await run_in_threadpool(bot_controls.set_approval_timeout, audit, actor, name, seconds, 'req_' + uuid4().hex)
    return JSONResponse(result, headers=_HEADERS)


@router.put('/approval-timeout')
async def put_approval_timeout_all(request: Request):
    """10.2: the same for every Bot, one audited write each; a failure is reported per Bot and undoes nothing (A-95)."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    seconds = bot_controls.validate_approval_timeout(await _json_body(request))
    audit, _meta = await run_in_threadpool(_stores)
    result = await run_in_threadpool(bot_controls.set_approval_timeout_all, audit, actor, await _names(), seconds, 'req_' + uuid4().hex)
    return JSONResponse(result, headers=_HEADERS)


# ---------------------------------------------------------------------------
# Contract v0.7: Voice. Logic in backend/voice.py; every Hermes call goes through its own audio handlers with profile=<bot>.
# ---------------------------------------------------------------------------
def _voice_gate(path, audit, bot):
    """The start gate (S02, invariant 7) for a voice route: built and run in the worker thread, just before the effect."""
    return lambda: _start_gate(Budget(path, audit=audit), path, bot)


def _voice_gate_reason(path, audit, bot):
    try:
        _voice_gate(path, audit, bot)()
    except PluginError as error:
        return 'bot_paused' if error.code == 'bot_paused' else 'budget'
    except BudgetUnavailable:
        return 'budget'
    return None


@router.get('/bots/{bot}/voice')
async def voice_status(bot: str, request: Request):
    _identity(request)
    name = await _existing(bot)
    audit, meta = await run_in_threadpool(_stores)
    view = await run_in_threadpool(voice.status, voice.HermesAudio, name, lambda: _voice_gate_reason(meta.path, audit, name), _REDACT)
    return JSONResponse(view, headers=_HEADERS)


@router.post('/bots/{bot}/voice/transcribe')
async def voice_transcribe(bot: str, request: Request):
    """2.1: the raw recording; type, length and CSRF are checked before a byte of the body is read."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    mime = voice.upload_mime(request.headers.get('content-type'))
    length = voice.upload_length(request.headers.get('content-length'))
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > length:
            raise PluginError('too_large', 'A recording is limited to 5 MB.', 413)
    if len(data) != length:
        raise PluginError('bad_request', 'The recording arrived incomplete.', 400)
    audit, meta = await run_in_threadpool(_stores)
    answer = await run_in_threadpool(voice.transcribe, audit, voice.HermesAudio, actor, name, bytes(data), mime,
                                     _voice_gate(meta.path, audit, name), _REDACT, 'req_' + uuid4().hex)
    return JSONResponse(answer, headers=_HEADERS)


@router.post('/bots/{bot}/voice/speak')
async def voice_speak(bot: str, request: Request):
    """2.2: the audio bytes, never rendered; the UI plays them from a blob: URL."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    text = voice.speak_text(await _json_body(request))
    audit, meta = await run_in_threadpool(_stores)
    audio, mime = await run_in_threadpool(voice.speak, audit, voice.HermesAudio, actor, name, text,
                                          _voice_gate(meta.path, audit, name), _REDACT, 'req_' + uuid4().hex)
    return Response(audio, media_type=mime, headers={**_HEADERS, 'X-Content-Type-Options': 'nosniff',
                                                     'Content-Disposition': 'attachment; filename="voz"'})


# ---- Skills per Bot (contract v0.6 Part A; backend/skills.py) ----
@router.get('/bots/{bot}/skills')
async def get_bot_skills(bot: str, request: Request):
    _identity(request)
    name = await _existing(bot)
    return await run_in_threadpool(skills.bot_skills, name, _REDACT)


@router.get('/skills/matrix')
async def get_skills_matrix(request: Request):
    _identity(request)
    names = await _names()
    grid = await _SKILLS_MATRIX.get(('matrix', tuple(names)), _EPOCH[0], lambda: run_in_threadpool(skills.matrix, names, _REDACT))
    return copy.deepcopy(grid)  # the memory is shared: a caller gets its own copy


@router.put('/bots/{bot}/skills/{skill}')
async def put_bot_skill(bot: str, skill: str, request: Request):
    """2.3: turning a skill ON loosens (the Bot gains a capability): a person with a login, never the loopback token (A-78).
    Turning it OFF tightens: allowed in loopback, like lowering a cap."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    enabled = skills.validate_toggle(await _json_body(request))
    if enabled:
        _human(request)  # 403 loopback_not_human
    name = await _existing(bot)
    audit, meta = await run_in_threadpool(_stores)
    result = await run_in_threadpool(skill_teach.toggle, audit, meta.path, actor, name, skill, enabled, 'req_' + uuid4().hex, _REDACT)   # the same (bot, name) lock as a creation or an edit; v0.11 3.2 step 5
    return JSONResponse(result, headers=_HEADERS)


@router.get('/bots/{bot}/skills/{skill}/content')
async def get_bot_skill_content(bot: str, skill: str, request: Request):
    _identity(request)
    name = await _existing(bot)
    return await run_in_threadpool(skills.content, name, skill, _REDACT)


# ---- Teach by demonstration (contract v0.11 section 3; backend/skill_teach.py) ----
@router.post('/bots/{bot}/skills/draft')
async def draft_bot_skill(bot: str, request: Request):
    """3.2 step 1: ask the Bot for a skill draft with ONE ordinary turn in that conversation, through the same gates as a typed message (the hook, the cap, the rules and approvals). The instruction is fixed in code
    and carries a nonce recorded BEFORE the send; the note is the only text from the person, after the table of 3.4. Allowed in loopback (it is a typed-turn equivalent). Audited `skill.draft.request`: the session and
    the length of the note, never the note."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    session_id, note = skill_teach.validate_draft_body(await _json_body(request))
    if safe_id(session_id) is None:
        raise PluginError('session_not_found', 'Session not found.', 404)
    nonce = skill_teach.new_nonce()
    text = skill_teach.draft_instruction(note, nonce)    # a note with a refused character is 422 here, before anything is recorded or sent
    await _require_feature(name, 'runs')
    audit, meta = await run_in_threadpool(_stores)
    index = await run_in_threadpool(RunIndex, meta.path)
    budget = await run_in_threadpool(Budget, meta.path, audit=audit)
    await run_in_threadpool(_refresh_hint, name, audit, actor)

    def gates():
        hook.hook_gate(meta.path, name)  # D-015 B-3: no new work where the rules hook is not live
        budget_gate(budget, meta.path, name)  # invariant 7

    def send(instruction):
        status, payload, code = ApiClient(name).call_coded('POST', '/v1/runs', {'input': instruction, 'session_id': session_id})
        if canonical.is_queued(status, code):
            return None
        if status not in (200, 202) or not payload:
            raise canonical.refusal(status, code, 'create') or upstream_error(status, on_404=_NO_404)
        run_id = safe_id(payload.get('run_id'))
        if run_id is None:
            raise HermesError('hermes_error')
        state = contract_status(payload.get('status'))[0]
        state = state if state != 'unknown' else 'started'
        index.add(run_id, name, session_id, actor, state, index.prompt_digest(instruction))
        return run_id, state

    sent = await run_in_threadpool(audit.act, actor, 'skill.draft.request', session_id, {'kind': 'ui'},
                                   lambda: skill_teach.start_draft(meta.path, session_id, actor, nonce, text, gates, send), bot=name,
                                   payload={'session_id': session_id, 'note_length': len(note or '')})
    if sent is None:
        return JSONResponse(canonical.queued_body(), status_code=202, headers=_HEADERS)
    run_id, state = sent
    approvals_native.start_watcher(meta.path, name, run_id, _REDACT)
    return JSONResponse({'run': {'id': run_id, 'status': state, 'bot': name, 'session_id': session_id}}, status_code=202, headers=_HEADERS)


@router.post('/bots/{bot}/skills')
async def create_bot_skill(bot: str, request: Request):
    """3.2 steps 3 and 4. `dry_run: true` is the review: the normalized preview or the refusal, nothing written and no config touched (allowed in loopback). `dry_run: false` creates the skill born OFF, a
    person with a login only (it writes persistent instructions); the server never trusts the panel, so the same validation runs again."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    skill_name, category, content, dry = skill_teach.validate_create_body(await _json_body(request, skill_teach.MAX_BODY))
    if dry:
        return JSONResponse(_redact_deep(await run_in_threadpool(skill_teach.dry_run, skill_name, content, category, True, _REDACT)), headers=_HEADERS)
    _human(request)  # 403 loopback_not_human
    await run_in_threadpool(skill_teach.need)
    audit, meta = await run_in_threadpool(_stores)
    result = await run_in_threadpool(skill_teach.create, audit, meta.path, actor, name, skill_name, category, content, _REDACT, 'req_' + uuid4().hex)
    return JSONResponse(_redact_deep(result), status_code=201, headers=_HEADERS)


@router.put('/bots/{bot}/skills/{skill}/content')
async def put_bot_skill_content(bot: str, skill: str, request: Request):
    """3.3: a full rewrite of a skill of `provenance: agent`, a person with a login only. 409 stale, 422 skill_not_editable, skill_redacted, skill_truncated, then the same validation as a creation."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    _human(request)  # 403 loopback_not_human
    name = await _existing(bot)
    content, expected = skill_teach.validate_edit_body(await _json_body(request, skill_teach.MAX_BODY))
    if not skills.SKILL_NAME.fullmatch(skill):
        raise skills.not_found()
    await run_in_threadpool(skill_teach.need)
    audit, meta = await run_in_threadpool(_stores)
    result = await run_in_threadpool(skill_teach.edit, audit, meta.path, actor, name, skill, content, expected, _REDACT, 'req_' + uuid4().hex)
    return JSONResponse(_redact_deep(result), headers=_HEADERS)


def _voice_stop_reason(path, audit, bot):
    """3.3 heartbeat: hang up after a pause by a person or a budget BREACH (spend at the stop line), not because the call's own
    reservation is held. No audit rows: `evaluate` is the watcher's read."""
    if bot_controls.pause_state(path, bot)['paused']:
        return 'bot_paused'
    decision = Budget(path, audit=audit).evaluate(bot)
    return 'budget' if decision['reason'] == 'bot_paused' or decision['breaches'] else None


def _voice_refusal(path, decision):
    """A refused reservation: the budget refusal, except a stale watcher with no cap at all (as runs.budget_gate): nothing to hold."""
    if decision['reason'] == 'watcher_stale' and not has_limits(path):
        return None
    return _budget_refusal(decision)


@router.put('/bots/{bot}/voice/client-direct')
async def voice_client_direct(bot: str, request: Request):
    """v0.7 V6: "Desligar" Hermes's voice.client_direct for this Bot (backend/voice.py client_direct_off)."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    voice.client_direct_body(await _json_body(request))
    audit, _meta = await run_in_threadpool(_stores)
    result = await run_in_threadpool(voice.client_direct_off, audit, voice.HermesAudio, actor, name, 'req_' + uuid4().hex)
    return JSONResponse(result, headers=_HEADERS)


@router.put('/bots/{bot}/reactions/bot-sees')
async def put_reactions_bot_sees(bot: str, request: Request):
    """RX-1 (A-282): the per-Bot switch "O Bot vê as minhas reações" = Hermes's `display.message_reactions` of THAT Bot, by Hermes's own write (backend/reactions.py set_bot_sees). A person with a login, like a rule."""
    human = _human(request)
    name = await _existing(bot)
    enabled = reactions.switch_body(await _json_body(request))
    audit, _meta = await run_in_threadpool(_stores)
    result = await run_in_threadpool(reactions.set_bot_sees, audit, human.id, name, enabled, 'req_' + uuid4().hex)
    return JSONResponse(result, headers=_HEADERS)


@router.put('/bots/{bot}/voice/language')
async def voice_language(bot: str, request: Request):
    """VL-1 (the voice language contract, section 2, A-281): the language of this Bot's Radio, written in ITS Hermes configuration by Hermes's own write (backend/voice.py set_language). A person with a login, like a rule."""
    human = _human(request)
    name = await _existing(bot)
    language = voice.language_body(await _json_body(request))
    audit, _meta = await run_in_threadpool(_stores)
    result = await run_in_threadpool(voice.set_language, audit, voice.HermesAudio, human.id, name, language, _REDACT, 'req_' + uuid4().hex)
    return JSONResponse(result, headers=_HEADERS)


@router.post('/bots/{bot}/voice/calls')
async def voice_call_start(bot: str, request: Request):
    """3.2: reserve the call's maximum, exchange the browser's SDP through Hermes; only the answer and the call id come back."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    body = await _json_body(request, voice.MAX_SDP + 4096)
    audit, meta = await run_in_threadpool(_stores)
    answer = await run_in_threadpool(lambda: voice.start_call(
        audit, Budget(meta.path, audit=audit), voice.Calls(meta.path), voice.HermesAudio, actor, name, body,
        _voice_gate(meta.path, audit, name), lambda d: _voice_refusal(meta.path, d), 'req_' + uuid4().hex))
    return JSONResponse(answer, status_code=201, headers=_HEADERS)


@router.post('/bots/{bot}/voice/calls/{call_id}/heartbeat')
async def voice_call_heartbeat(bot: str, call_id: str, request: Request):
    _actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    audit, meta = await run_in_threadpool(_stores)
    view = await run_in_threadpool(voice.heartbeat, voice.Calls(meta.path), name, call_id,
                                   lambda: _voice_stop_reason(meta.path, audit, name))
    return JSONResponse(view, headers=_HEADERS)


@router.post('/bots/{bot}/voice/calls/{call_id}/delegations')
async def voice_call_delegation(bot: str, call_id: str, request: Request):
    """3.3: a delegation of the voice model becomes a NORMAL turn of the call's conversation (same path as the send route)."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    body = await _json_body(request)
    await _require_feature(name, 'session_chat_stream')
    audit, meta = await run_in_threadpool(_stores)
    session_id, text, cid = await run_in_threadpool(voice.delegate, audit, voice.Calls(meta.path), voice.HermesAudio, actor, name,
                                                    call_id, body, _voice_gate(meta.path, audit, name), _REDACT, 'req_' + uuid4().hex)
    return await _chat_turn(actor, name, session_id, {'input': text, 'page': None, 'client_message_id': cid}, audit, meta)


@router.post('/bots/{bot}/voice/calls/{call_id}/end')
async def voice_call_end(bot: str, call_id: str, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    body = await _json_body(request)
    audit, meta = await run_in_threadpool(_stores)
    receipt = await run_in_threadpool(lambda: voice.end_call(audit, Budget(meta.path, audit=audit), voice.Calls(meta.path), actor, name,
                                                             call_id, body, 'req_' + uuid4().hex))
    return JSONResponse(receipt, headers=_HEADERS)


# ---------------------------------------------------------------------------
# Contract v0.8 section 1: memory item by item. Logic in backend/memory.py; Hermes's own MemoryStore in the Bot's profile.
# ---------------------------------------------------------------------------
@router.get('/bots/{bot}/memory')
async def memory_view(bot: str, request: Request):
    _identity(request)
    name = await _existing(bot)
    return JSONResponse(await run_in_threadpool(memory.view, memory.HermesMemory, name, _REDACT), headers=_HEADERS)


@router.get('/bots/{bot}/memory/export')
async def memory_export(bot: str, request: Request):
    _identity(request)
    name = await _existing(bot)
    text = await run_in_threadpool(memory.export, memory.HermesMemory, name, _REDACT)
    return Response(text.encode('utf-8'), media_type='text/markdown; charset=utf-8', headers={
        **_HEADERS, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': f'attachment; filename="memoria-{name}.md"'})


async def _memory_write(request, bot, target):
    actor, credential, mode = _identity(request)
    _require_csrf(request, credential)
    name = await _existing(bot)
    audit, meta = await run_in_threadpool(_stores)
    return actor, mode, name, memory.target_of(target), audit, meta


@router.post('/bots/{bot}/memory/{target}')
async def memory_add(bot: str, target: str, request: Request):
    actor, mode, name, target, audit, meta = await _memory_write(request, bot, target)
    text = memory.text_of(await _json_body(request))
    index = await run_in_threadpool(RunIndex, meta.path)
    result = await run_in_threadpool(memory.add, audit, memory.HermesMemory, index.keyed_digest, actor, mode, name, target, text,
                                     'req_' + uuid4().hex)
    return JSONResponse(result, status_code=201, headers=_HEADERS)


@router.patch('/bots/{bot}/memory/{target}/{entry_id}')
async def memory_replace(bot: str, target: str, entry_id: str, request: Request):
    actor, mode, name, target, audit, meta = await _memory_write(request, bot, target)
    text = memory.text_of(await _json_body(request))
    index = await run_in_threadpool(RunIndex, meta.path)
    result = await run_in_threadpool(memory.replace, audit, memory.HermesMemory, index.keyed_digest, _REDACT, actor, mode, name, target,
                                     entry_id, text, 'req_' + uuid4().hex)
    return JSONResponse(result, headers=_HEADERS)


@router.delete('/bots/{bot}/memory/{target}/{entry_id}')
async def memory_remove(bot: str, target: str, entry_id: str, request: Request):
    actor, _mode, name, target, audit, _meta = await _memory_write(request, bot, target)
    result = await run_in_threadpool(memory.remove, audit, memory.HermesMemory, actor, name, target, entry_id, 'req_' + uuid4().hex)
    return JSONResponse(result, headers=_HEADERS)


@router.delete('/bots/{bot}/memory/{target}')
async def memory_clear(bot: str, target: str, request: Request, confirm: str = None):
    actor, _mode, name, target, audit, _meta = await _memory_write(request, bot, target)
    result = await run_in_threadpool(memory.clear, audit, memory.HermesMemory, actor, name, target, confirm, 'req_' + uuid4().hex)
    return JSONResponse(result, headers=_HEADERS)


# Contract v0.8 section 6: Web Push without payload (backend/push.py).
# ---------------------------------------------------------------------------
_PUSH_SUBJECT_SETTING = os.environ.get('LUVEBOT_PUSH_SUBJECT', '').strip()   # read once, from the environment only (contract v0.11 7.1)
if _PUSH_SUBJECT_SETTING and not push.valid_subject(_PUSH_SUBJECT_SETTING):
    logging.getLogger('luvebot.push').warning('LUVEBOT_PUSH_SUBJECT is set but is not a contact a push service takes: no push is sent until it is fixed')   # the value is not in the line (it may be an address)


def _push_subject():
    """The VAPID `sub` (contract v0.11 7.1): -> (subject, source). The operator's `LUVEBOT_PUSH_SUBJECT` (source `setting`), then the dashboard's public https URL (`public_url`), each only when it is a
    contact a push service takes (`push.valid_subject`: https or mailto on a real domain, never localhost, `.local`, an IP or a bare name: Apple answers 403 BadJwtToken for what it cannot use).
    Otherwise (None, None): LuveBot does not send with a contact it made up, and says so (`needs_subject`)."""
    if _PUSH_SUBJECT_SETTING:
        return (_PUSH_SUBJECT_SETTING, 'setting') if push.valid_subject(_PUSH_SUBJECT_SETTING) else (None, 'setting')   # an explicit setting that is malformed is NOT replaced by the public URL (7.1, A-189)
    try:
        from hermes_cli.config import load_config
        url = ((hermes_boundary.convert(load_config)() or {}).get('dashboard') or {}).get('public_url')   # the outage is a SystemExit: converted, the `except Exception` below is "none"
        if isinstance(url, str) and url.startswith('https://') and push.valid_subject(url):
            return url, 'public_url'
    except Exception:
        pass
    return None, None


def _push(path):
    subject, source = _push_subject()
    return push.Push(path, subject=subject, source=source)


def _on_approval_request(path, bot):
    push_box = _push(path)
    push_box.notify(AuditLog(path), 'approval', bot)


approvals.on_request = _on_approval_request
_PAUSE_WINDOW_S = 600.0  # a pause older than this is not announced (ADR-010 7): no burst of notices for old pauses with no key after an update, and a gap between two owners is covered


def _notify_new_pauses(audit, path, budget):
    """Stateless: "did I tell them about this pause?" is the key `pause:<bot>:<since>` of push_events.dedupe (r43), in the database, so every process and every lease owner says it once."""
    try:
        for bot in sorted(budget.snapshot()['paused']):
            key = _pause_key(path, bot)
            try:
                since = float(key.rpartition(':')[2]) if key else None
            except ValueError:
                since = None
            if since is None or time.time() - since > _PAUSE_WINDOW_S:
                continue
            _push(path).notify(audit, 'budget', bot, key)
    except Exception as error:
        logging.getLogger('luvebot.push').warning('pause notification failed: %s', type(error).__name__)


_WAIT_WINDOW_S = 600.0  # a wait older than this the FIRST time it is seen is not announced (an update or a restart must not announce old waits)
_WAIT_MARKERS = {}  # (path, bot) -> the `waiting.marker` of the tick that last read this Bot's waits: a tick with the same marker reads nothing


def _notify_new_waits(audit, path, names):
    """Contract v0.11 7.6: the waits `waiting.read` derives (the ones the Bot status and the Activity show: an `api_server` approval is the inbox's own and is not here, a wait whose session ended is gone) wake the devices
    that asked for `question`, ONCE each: key `wait:<bot>:<request_id>` in push_events.dedupe, the same stateless "did I say it?" as the pause key, so every process and every lease owner says it once. It reads a Bot's waits only
    when `waiting.marker` for that Bot moved since the previous tick (the hook is another process: its rows move that number), never in a request path. The push is empty and the event carries the kind and the Bot only:
    the clarify's text, written by the agent, never reaches `notify`, the audit or the lock screen."""
    for bot in names:
        try:
            marker = waiting.marker(path, bot)
            if marker is None or _WAIT_MARKERS.get((str(path), bot)) == marker:
                continue                                           # nothing new from the hook (or it cannot be told): nothing is read
            items = waiting.read(path, bot, _REDACT)
            if items is None:
                continue                                           # unreadable: the marker is not kept, the next tick tries again
            settled = True
            for item in items:
                if time.time() - item['since'] > _WAIT_WINDOW_S:
                    continue
                key = f"wait:{bot}:{item['request_id']}"
                try:
                    box = _push(path)
                    box.notify(audit, 'question', bot, key)
                    said = box._notified(key)                      # `notify` swallows its own failures and returns None: the memory of the key is the only answer
                except Exception as error:
                    logging.getLogger('luvebot.push').warning('wait notification failed: %s', type(error).__name__)
                    said = False
                settled = settled and said
            if settled:                                            # only when EVERY wait read is told (or too old): a transient failure (a locked luvebot.db, an audit row that does not write) leaves the marker as it was, and the next tick reads again;
                _WAIT_MARKERS[(str(path), bot)] = marker           # the key makes that safe, until the wait is ten minutes old (F-N6-7)
        except Exception as error:
            logging.getLogger('luvebot.push').warning('wait notification failed: %s', type(error).__name__)


def _pause_key(path, bot):
    """`pause:<bot>:<since>`: `since` is when the executor first applied THIS pause (budget_exec_state; the row goes at the resume, so the next pause has its own), the same for
    every process that shares luvebot.db: two watchers tell the person once. None when the executor has not noted the pause yet (then nothing is deduplicated)."""
    try:
        conn = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=5)
        try:
            row = conn.execute('SELECT since FROM budget_exec_state WHERE bot=?', (bot,)).fetchone()
        finally:
            conn.close()
    except sqlite3.Error:
        return None
    return f'pause:{bot}:{row[0]}' if row else None


@router.get('/notifications/config')
async def notifications_config(request: Request):
    _identity(request)
    if not await run_in_threadpool(push.capable):
        raise PluginError('capability_missing', 'This Hermes has no PyJWT or cryptography, so notifications are off.', 409, {'feature': 'notifications'})
    audit, meta = await run_in_threadpool(_stores)
    return JSONResponse(await run_in_threadpool(lambda: _push(meta.path).config()), headers=_HEADERS)


@router.get('/notifications/subscriptions')
async def notifications_mine(request: Request):
    actor, _credential, _mode = _identity(request)
    audit, meta = await run_in_threadpool(_stores)
    return JSONResponse({'subscriptions': await run_in_threadpool(lambda: _push(meta.path).mine(actor))}, headers=_HEADERS)


@router.post('/notifications/subscriptions')
async def notifications_subscribe(request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    endpoint, kinds, key_id = push.subscribe_body(await _json_body(request))
    audit, meta = await run_in_threadpool(_stores)
    result = await run_in_threadpool(lambda: _push(meta.path).subscribe(audit, actor, endpoint, kinds, 'req_' + uuid4().hex, key_id))
    return JSONResponse(result, status_code=201, headers=_HEADERS)


@router.post('/notifications/test')
async def notifications_test(request: Request):
    """A test wake to the devices of the person who asks, and only theirs (contract v0.11 7.3): any session, CSRF, body exactly {}, at most one every 10 seconds per person (429 rate_limited), no
    contact set is 409 needs_subject, audited (`notifications.test`, and one `notifications.deliver` per device). -> {devices: [{id, host, ok, status, reason}]}, one per device in the order of GET
    /notifications/subscriptions; `reason` is null or from the closed list of `push.REASONS`. Never an endpoint, never the push service's own text."""
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    if await _json_body(request) != {}:
        raise PluginError('bad_request', 'Send an empty body {}.', 400)
    if not await run_in_threadpool(push.capable):
        raise PluginError('capability_missing', 'This Hermes has no PyJWT or cryptography, so notifications are off.', 409, {'feature': 'notifications'})
    audit, meta = await run_in_threadpool(_stores)
    result = await run_in_threadpool(lambda: _push(meta.path).test(audit, actor, 'req_' + uuid4().hex))
    return JSONResponse(result, headers=_HEADERS)


@router.delete('/notifications/subscriptions/{subscription_id}')
async def notifications_unsubscribe(subscription_id: int, request: Request):
    actor, credential, _mode = _identity(request)
    _require_csrf(request, credential)
    audit, meta = await run_in_threadpool(_stores)
    result = await run_in_threadpool(lambda: _push(meta.path).unsubscribe(audit, actor, subscription_id, 'req_' + uuid4().hex))
    return JSONResponse(result, headers=_HEADERS)


@router.get('/notifications/latest')
async def notifications_latest(request: Request, sub: str = None):
    """What the service worker shows on the lock screen: kind and Bot only (A-107), of the kinds this person subscribed to.
    `sub` (optional, never an error) narrows it to one of their devices."""
    actor, _credential, _mode = _identity(request)
    audit, meta = await run_in_threadpool(_stores)
    device = int(sub) if sub is not None and sub.isascii() and sub.isdigit() and len(sub) < 10 else None
    return JSONResponse({'events': await run_in_threadpool(lambda: _push(meta.path).latest(actor, device))}, headers=_HEADERS)


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
