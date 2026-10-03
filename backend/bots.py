"""Bots = Hermes profiles + LuveBot display (contract section 4).

Hermes is written ONLY through the profile route functions the contract links (profiles.py POST /api/profiles,
PUT soul, PUT description, PUT model), never by editing files (invariant 4). Nothing returned here carries a key,
.env value, filesystem path or MCP header: every field is picked by name from what Hermes returns.
"""
import asyncio
import re
import secrets
import time

from .api_errors import PluginError
from . import hook
from .bot_meta import default_display, validate_display
from .hermes_client import PROFILE_NAME, HermesClient, HermesError, feature_states
from .templates import get_template

_CAPS_TTL = 60  # seconds, per contract
_caps_cache = {}
_FAILED = {'runs': False, 'session_chat_stream': False, 'approval_response': False}


def profile_infos():
    """[{name, is_default, model, provider, description}] straight from Hermes's profile list."""
    from hermes_cli.profiles import list_profiles
    try:
        infos = list_profiles(lazy_skill_count=True)
    except Exception:
        raise HermesError('hermes_unreachable') from None
    return [{'name': i.name, 'is_default': bool(i.is_default), 'model': i.model or '', 'provider': i.provider or '',
             'description': i.description or ''} for i in infos if PROFILE_NAME.fullmatch(i.name)]


def probe(name, baseline_ok, *, with_failure=False):
    """(capabilities, offline), or (capabilities, offline, failure) with `with_failure`: the static HermesError code of a probe
    that failed (None when it answered), so a refusal can say why. Cached 60 s. Failure never invents capabilities."""
    hit = _caps_cache.get(name)
    if hit and time.monotonic() - hit[0] < _CAPS_TTL and hit[2] == baseline_ok:
        result, failure = hit[1], hit[3]
    else:
        failure = None
        try:
            states = feature_states(HermesClient(name).capabilities(), baseline_ok)
            result = ({'runs': states['runs'] == 'ok', 'session_chat_stream': states['session_chat_stream'] == 'ok',
                       'approval_response': False}, False)  # approval resolution is Phase 3 (501)
        except HermesError as error:
            result, failure = (dict(_FAILED), error.code in ('hermes_unreachable', 'hermes_timeout')), error.code
        _caps_cache[name] = (time.monotonic(), result, baseline_ok, failure)
    return (*result, failure) if with_failure else result


def bot_object(info, display, probed, live=None):
    """Status precedence (contract section 4): offline > paused > waiting_approval > working > idle.
    paused: ESTOP (fleet or the Bot's own), a LuveBot pause, the Budget (v0.4 B3). working, with its basis (v0.4 B7): runs
    this plugin started (re-checked with Hermes), live Kanban workers, then sessions active in the last 300 s (recent, not
    proof of a model call). A source that could not be read is listed in status_partial, never read as idle."""
    capabilities, offline = probed
    live = live or {}
    runs = live.get('open_runs', [])
    workers = live.get('workers') or []
    sessions = [s for s in live.get('recent_sessions') or [] if s.get('is_active')]
    pause = live.get('pause_state') or {}
    reason, task, basis = None, None, None
    if offline:
        status = 'offline'
    elif pause.get('paused'):
        status, reason = 'paused', pause['reason_kind']
    elif live.get('paused'):
        status, reason = 'paused', 'budget'
    elif any(r['last_status'] == 'waiting_for_approval' for r in runs):
        status = 'waiting_approval'
    elif runs or ((workers or sessions) and False):  # B7 DISABLED until test_v04 proves it in the harness (T7.B1); enable by removing 'and False'
        status = 'working'
    else:
        status = 'idle'
    if runs and status in ('working', 'waiting_approval'):
        basis = 'run'
        task = {'kind': 'run', 'id': runs[0]['run_id'], 'title': 'Trabalho em andamento', 'since': runs[0]['started_at']}
    elif workers and status == 'working':
        basis = 'kanban'
        task = {'kind': 'kanban', 'id': workers[0].get('task_id'), 'title': workers[0].get('task_title'), 'since': workers[0].get('started_at')}
    elif sessions and status == 'working':
        basis, source = 'session_recent', sessions[0].get('source')
        kind = 'routine' if source == 'cron' else 'room' if source == 'bot_room' else 'other' if source in ('cli', 'api_server', 'web') else 'channel'
        task = {'kind': kind, 'id': sessions[0].get('id'), 'title': sessions[0].get('title'), 'since': sessions[0].get('last_active')}
    return {'name': info['name'], 'is_default': info['is_default'], 'display': display, 'description': info['description'],
            'model': {'provider': info['provider'], 'name': info['model']},
            'status': status, 'status_reason': reason, 'status_basis': basis, 'status_partial': live.get('status_partial') or [],
            'current_task': task, 'unread': live.get('unread'), 'pause_scope': pause.get('scope'),
            'cost_today_usd': None, 'channels': [], 'capabilities': capabilities, 'hook': live.get('hook')}


async def detail_extras(name):
    """soul, toolsets, mcp_servers through the Hermes route functions. Any failure is a 502, never partial text."""
    from hermes_cli.web_routers.mcp import list_mcp_servers
    from hermes_cli.web_routers.profiles import get_profile_soul
    from hermes_cli.web_routers.tools import get_toolsets
    try:
        soul = (await get_profile_soul(name)).get('content', '')
        toolsets = await get_toolsets(profile=name)
        servers = (await list_mcp_servers(profile=name)).get('servers', [])
        return {'soul': soul if isinstance(soul, str) else '',
                'toolsets': [{'name': str(t['name']), 'enabled': bool(t.get('enabled'))} for t in toolsets],
                'mcp_servers': [{'name': str(s['name']), 'enabled': bool(s.get('enabled', True))} for s in servers]}
    except Exception:
        raise HermesError('hermes_error') from None


def _plain(value, field, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise PluginError('invalid_field', f'Invalid value for {field}.', 422)
    return value.strip()


def validate_create(body):
    """Pure input validation: returns (name, template|None, display_changes, model|None)."""
    if not isinstance(body, dict) or set(body) - {'name', 'template', 'display', 'model'}:
        raise PluginError('bad_request', 'Malformed request body.', 400)
    name = body.get('name')
    # Hermes lowercases profile ids; refusing uppercase keeps the Bot name equal to the profile id.
    if not isinstance(name, str) or not PROFILE_NAME.fullmatch(name) or name != name.lower():
        raise PluginError('invalid_name', 'Use 1 to 64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit.', 422)
    from hermes_cli.profiles import validate_profile_name
    try:
        validate_profile_name(name)
    except ValueError:
        raise PluginError('invalid_name', 'This name is reserved or not allowed.', 422) from None
    template = None
    if body.get('template') is not None:
        template = get_template(body['template'])
        if template is None:
            raise PluginError('invalid_field', 'Unknown template.', 422)
    display = validate_display(body.get('display', {}))
    model = None
    if body.get('model') is not None:
        raw = body['model']
        if not isinstance(raw, dict) or set(raw) != {'provider', 'name'}:
            raise PluginError('invalid_field', 'Invalid value for model.', 422)
        model = {'provider': _plain(raw['provider'], 'model.provider', 100), 'name': _plain(raw['name'], 'model.name', 200)}
    if name in [info['name'] for info in profile_infos()]:
        raise PluginError('bot_exists', 'A Bot with this name already exists.', 409)
    return name, template, display, model


def initial_display(name, template, changes):
    base = default_display(name)
    if template:
        base.update(label=template['label'], role=template['role'], color=template['color'], avatar=template['avatar'])
    base.update(changes)
    return base


def create_in_hermes(name, template, display, model, meta, soul=None):
    """Synchronous (runs inside AuditLog.act, in the threadpool). Rolls back on any failed step."""
    from hermes_cli.web_models import EnvVarUpdate, ProfileCreate, ProfileDescriptionUpdate, ProfileModelUpdate, ProfileSoulUpdate
    from hermes_cli.web_routers import config_env, profiles as routes

    description = (template or {}).get('description') or display.get('role') or ''
    steps = [('create', lambda: routes.create_profile_endpoint(ProfileCreate(name=name)))]
    if template or soul is not None:  # v0.4 B6: the person's edited text, when sent, is what is written
        steps.append(('soul', lambda: routes.update_profile_soul(name, ProfileSoulUpdate(content=template['soul'] if soul is None else soul))))
    if description:
        steps.append(('description', lambda: routes.update_profile_description_endpoint(name, ProfileDescriptionUpdate(description=description))))
    if model:
        steps.append(('model', lambda: routes.update_profile_model_endpoint(name, ProfileModelUpdate(provider=model['provider'], model=model['name']))))
    # The Bot's own API Server key (D-011): generated here, written through Hermes's credential lifecycle (the
    # route behind PUT /api/env, config_env.py#L328, scoped to the new profile). It lives only in this closure:
    # never returned, logged, audited or put in an error. Hermes errors are replaced by our static message below.
    steps.append(('api_key', lambda: config_env.set_env_var(
        EnvVarUpdate(key='API_SERVER_KEY', value=secrets.token_urlsafe(32), profile=name))))
    # ADR-003: the Bot's rules hook is part of creating it (the built-in rules are always active, and Hermes loads a
    # plugin per profile). Install + enable + load go through Hermes's own plugin installer in this profile's scope.
    steps.append(('hook_install', lambda: hook.install_hook(meta.path, name)))
    steps.append(('hook_verify', lambda: hook.verify_installed(name)))
    steps.append(('platform_hint', lambda: _markdown_hint(name)))  # T12: the Bot writes Markdown for LuveBot (Hermes's own override)
    steps.append(('display', lambda: meta.upsert(name, display)))
    steps.append(('template', lambda: meta.set_template(name, template and template['id'])))  # v0.4 B4 introduction base

    for step, run in steps:
        try:
            result = run()
            if asyncio.iscoroutine(result):
                asyncio.run(result)  # route functions are async; this thread has no running loop
        except Exception as error:
            # The profile may exist even if 'create' raised late (e.g. while seeding skills): always try to remove it.
            rolled_back = _rollback(name, meta)
            status, code, message = 502, 'hermes_error', f'Creating the Bot failed at step "{step}".'
            extra = {'step': step, 'rolled_back': rolled_back}
            if step == 'model' and getattr(error, 'status_code', None) == 400:
                status, code, message = 422, 'invalid_field', 'Hermes rejected this model for the Bot.'
            if step in ('hook_install', 'hook_verify'):
                # Our own static reason (never Hermes text): why the rules could not be installed in this Bot.
                status, code, message = 502, 'hook_install_failed', 'Installing the LuveBot rules in the Bot failed.'
                extra['reason'] = error.code if isinstance(error, hook.HookError) else 'hook_install_failed'
            message += ' Changes were rolled back.' if rolled_back else ' Some changes could not be rolled back; remove the profile in Hermes.'
            raise PluginError(code, message, status, extra) from None
    return True


def _markdown_hint(name):
    from .bot_controls import ensure_markdown_hint
    ensure_markdown_hint(name)  # audited by the bot.create row around the whole creation


def _rollback(name, meta):
    from hermes_cli.web_routers.profiles import delete_profile_endpoint
    ok = True
    try:
        meta.delete(name)
        hook.forget(meta.path, name)
    except Exception:
        ok = False
    try:
        asyncio.run(delete_profile_endpoint(name))
    except Exception as error:
        # 404 = the profile was never created: nothing to undo.
        ok = ok and getattr(error, 'status_code', None) == 404
    return ok
